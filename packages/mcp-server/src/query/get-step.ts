import {
  RunReadContext,
  RunRepository,
  findIllegalExternalRunIdViolation,
  findIllegalSpanIdViolation,
  resolveSpanOwner,
} from "@rebaseagent/run-query";
import { z } from "zod";
import type { LimitationInput, ProvenanceRefInput } from "../envelope.js";
import { MESSAGE_MAX } from "../limits.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import { type GetStepArgs, STEP_SECTIONS, requireContract } from "../tool-contracts.js";
import { ToolFailure, type ToolPayload, defineTool } from "../tool-definition.js";
import { sliceBody } from "./body-range.js";
import { canonicalJson } from "./canonical-json.js";
import { issueCursor, requireCursorPosition, withoutCursor } from "./cursor-io.js";
import {
  type ProjectedSpanInput,
  SpanItemSchema,
  projectSpanItem,
  provenanceRunsOf,
} from "./projection.js";
import { computeReadVersion } from "./read-version.js";
import { REDACTED_MARKER, redactStructuredValue } from "./redaction.js";

/**
 * `get_step`（design D5 第三行；S03「先摘要后正文」的正文那一跳，Q09/Q10）。
 *
 * 两条边界：
 * - **不给 section 就没有正文**：只回该 span 的结构性元数据 + 三段「录没录到」索引，
 *   并带 `BODY_NOT_EXPOSED` 说明怎么取；摘要/索引里绝不夹带正文（与 list_runs/get_run 同一口径）。
 * - **归属只认当前投影**：重名 span 不取首项，`SPAN_AMBIGUOUS` 给出 owner 候选；
 *   被投影截断的祖先 span **给了显式 owner 也不读**（`STEP_NOT_FOUND`）——
 *   owner 是「哪一个 run」的定位，不是绕过投影的通行证（Q10）。
 *
 * 正文一律先规范 JSON（键序稳定，分段续读才拼得回原文），再按 **Unicode 码点**切片：
 * 代理对不会被切成半个字符。「空串 / null / 未记录」三者可分辨：`tool.invoke.error=null`
 * 与 `llm.call.error` 缺省都是**未记录**，录成空串就照空串发出去。
 *
 * 规范 JSON **之前**先过滤已知结构凭据（D7/S11）：命中字段替换为 `[REDACTED]` 并发
 * `REDACTED` limitation；范围/总码点因此描述的是过滤后的外发文本。自由文本、
 * JSON 字符串与检查点文件原文不在这里解析或重写。
 */

const SectionNameSchema = z.enum(STEP_SECTIONS);

const SectionAvailabilitySchema = z
  .object({
    name: SectionNameSchema,
    /** false = 这一段没录到可外发的内容（不是"内容是假"，也不是读取失败） */
    recorded: z.boolean(),
  })
  .strict();

const RangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    unit: z.literal("unicode-code-point"),
  })
  .strict();

const StepBodySchema = z.discriminatedUnion("recorded", [
  z.object({ recorded: z.literal(false) }).strict(),
  z
    .object({
      recorded: z.literal(true),
      /** 结构正文的编码：规范 JSON（design D6）；文件那一路才是 utf8-text */
      encoding: z.literal("canonical-json"),
      /**
       * 6.2 修订（正文只承载一次）：正文本体只进 content 文本，此处是指针；
       * `range/truncated/remaining` 仍描述那段正文（范围按外发文本计）。
       */
      bodyIn: z.literal("content"),
      range: RangeSchema,
      truncated: z.boolean(),
      remaining: z.number().int().nonnegative(),
    })
    .strict(),
]);

const GetStepDataSchema = z
  .object({
    /** 与 get_run 索引同一份形状：两处说的不会漂 */
    span: SpanItemSchema,
    requestedSection: SectionNameSchema.nullable(),
    sections: z.array(SectionAvailabilitySchema).length(3),
    body: StepBodySchema.nullable(),
  })
  .strict();
export type GetStepData = z.infer<typeof GetStepDataSchema>;

/**
 * 该 section 的正文源值；`undefined` = **没录到**（不外发也不补造）。
 *
 * `tool.invoke.result` 与 `fork.edit.value` 一样是 `unknown`：字段缺省与录了 `null`
 * 是两件事 ⇒ 用 `!== undefined` 判存在，不做真值判断。
 */
function bodyValueOf(span: ProjectedSpanInput, section: string): unknown {
  switch (span.kind) {
    case "agent.step":
      // step 是容器：它自己没有正文段（内容在它下属的 llm.call / tool.invoke 里）
      return undefined;
    case "llm.call":
      if (section === "input") return span.request;
      if (section === "output") return span.response;
      return span.error;
    case "tool.invoke":
      if (section === "input") return span.args;
      if (section === "output") return span.result;
      return span.error === null ? undefined : span.error;
  }
}

function sectionsIndexOf(span: ProjectedSpanInput): z.infer<typeof SectionAvailabilitySchema>[] {
  return STEP_SECTIONS.map((name) => ({
    name,
    recorded: bodyValueOf(span, name) !== undefined,
  }));
}

/** owner 候选进 `ref`：数量与总长都有界（ref 是定位信息，不是正文通道） */
function ownersRef(candidates: readonly string[]): string {
  const parts: string[] = [];
  let length = "owners:".length;
  for (const candidate of candidates) {
    const addition = parts.length === 0 ? candidate : `,${candidate}`;
    if (length + addition.length > MESSAGE_MAX - 8) {
      parts.push("…");
      break;
    }
    parts.push(candidate);
    length += addition.length;
  }
  return `owners:${parts.join(",")}`;
}

export const getStepTool: ToolDefinition = defineTool(
  requireContract("get_step"),
  async (args: GetStepArgs, root: DataRoot) => {
    /**
     * 形状校验一律在任何读取之前（design D3 + Q05）：这一层能给 `INVALID_ARGUMENT`
     * 并指出是哪个字段，共享层只能给「记录校验不通过」——让客户端去猜没意义。
     */
    if (args.cursor !== undefined && args.section === undefined) {
      // 游标只来自正文续读；没有 section 的请求不可能有可续的正文
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }
    if (findIllegalExternalRunIdViolation(args.runId) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "runId");
    }
    if (findIllegalSpanIdViolation(args.spanId) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "spanId");
    }
    if (
      args.ownerRunId !== undefined &&
      findIllegalExternalRunIdViolation(args.ownerRunId) !== null
    ) {
      throw new ToolFailure("INVALID_ARGUMENT", "ownerRunId");
    }

    const repository = new RunRepository(root.tracesDir);
    const requestArgs = withoutCursor(args);
    const readVersion = computeReadVersion("get_step", requestArgs, repository);
    const [start] = requireCursorPosition({
      cursor: args.cursor,
      tool: "get_step",
      params: requestArgs,
      readVersion,
      kind: "chars",
      slots: 1,
    });
    const { detail, chainSummaries, ownerIndex } = new RunReadContext(
      root.tracesDir,
    ).readWithOwners(args.runId);

    const lookup = resolveSpanOwner(ownerIndex, args.spanId, args.ownerRunId);
    if (lookup.status === "ambiguous") {
      throw new ToolFailure("SPAN_AMBIGUOUS", ownersRef(lookup.owners));
    }
    if (lookup.status === "truncated") {
      // 显式 owner 也不能把被投影截断的祖先读回来（Q10）
      throw new ToolFailure("STEP_NOT_FOUND", `span:${args.spanId}@owner:${lookup.ownerRunId}`);
    }
    if (lookup.status === "not_found") {
      throw new ToolFailure("STEP_NOT_FOUND", `span:${args.spanId}`);
    }
    if (lookup.status === "unreliable") {
      // 归属本身说不清：不按 id 猜一个 owner 发出去
      throw new ToolFailure("RUN_INVALID", `run:${detail.meta.id}`);
    }

    /**
     * 位置定位：同一个 id 可能属于链上多个 run，`resolveSpanOwner` 给出的是**该投影里
     * 可见的那一个归属**，所以要 (位置, id, owner) 三者同时匹配才认。
     */
    const position = detail.spans.findIndex(
      (span, index) =>
        span.id === args.spanId &&
        ownerIndex.projectedOwners[index]?.ownerRunId === lookup.ownerRunId,
    );
    const span = detail.spans[position];
    if (position < 0 || span === undefined) {
      throw new ToolFailure("STEP_NOT_FOUND", `span:${args.spanId}`);
    }

    const item = projectSpanItem(
      span,
      lookup.ownerRunId,
      new Set(detail.leafSpanIds).has(span.id),
      (ownerIndex.ownersBySpanId.get(span.id) ?? []).length > 1,
    );
    const sections = sectionsIndexOf(span);

    const limitations: LimitationInput[] = [];
    /** `null` = 本次没有正文源（未给 section，或该段未记录） */
    let filteredText: string | null = null;
    if (args.section === undefined) {
      limitations.push({
        code: "BODY_NOT_EXPOSED",
        ref: `span:${lookup.ownerRunId}:${args.spanId}`,
        message: "未指定 section：本次只给结构性索引，正文需显式请求 input/output/error 之一",
      });
    } else {
      const value = bodyValueOf(span, args.section);
      if (value !== undefined) {
        const redacted = redactStructuredValue(value);
        filteredText = canonicalJson(redacted.value);
        if (redacted.redactedFields > 0) {
          limitations.push({
            code: "REDACTED",
            ref: `span:${lookup.ownerRunId}:${args.spanId}/section:${args.section}`,
            message: `已把 ${redacted.redactedFields} 处已知凭据（字段或端点 userinfo）替换为 ${REDACTED_MARKER}；自由文本与检查点文件原文仍可能含秘密`,
          });
        }
      }
    }

    if (filteredText === null) {
      if (args.cursor !== undefined) throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    } else {
      const total = [...filteredText].length;
      if (start > total || (args.cursor !== undefined && start >= total)) {
        throw new ToolFailure("INVALID_ARGUMENT", "cursor");
      }
    }

    const runs = provenanceRunsOf(detail, chainSummaries);
    if (runs === null) {
      throw new ToolFailure("RUN_INVALID", `run:${detail.meta.id}`);
    }
    const refs: ProvenanceRefInput[] = [{ runId: lookup.ownerRunId, spanId: args.spanId }];

    /**
     * 正文页按码点收窄；预算搜索只调这个上限，范围/剩余/简述随之重算。
     * `filteredText = null` 时没有可缩旋钮，固定段装不下就由框架发 RESPONSE_LIMIT。
     */
    const buildPayload = (chars: number | undefined): ToolPayload => {
      const sliced =
        args.section === undefined || filteredText === null
          ? null
          : sliceBody(filteredText, chars, start);
      const body: z.infer<typeof StepBodySchema> | null =
        args.section === undefined
          ? null
          : sliced === null
            ? { recorded: false }
            : {
                recorded: true as const,
                encoding: "canonical-json" as const,
                bodyIn: "content" as const,
                range: sliced.range,
                truncated: sliced.truncated,
                remaining: sliced.remaining,
              };
      const data = GetStepDataSchema.parse({
        span: item,
        requestedSection: args.section ?? null,
        sections,
        body,
      });
      const nextCursor =
        body !== null &&
        body.recorded === true &&
        body.range.end > start &&
        body.range.end < body.range.total
          ? issueCursor({
              tool: "get_step",
              params: requestArgs,
              readVersion,
              kind: "chars",
              position: [body.range.end],
            })
          : undefined;
      return {
        readVersion,
        data,
        /** 正文本体只随 content 走（data 内对应位是 bodyIn:"content" 指针） */
        ...(sliced === null ? {} : { contentBodies: [{ at: "body", text: sliced.text }] }),
        truncated: body !== null && body.recorded === true ? body.truncated : false,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        runs,
        refs,
        limitations: [...limitations],
        headline: [
          `get_step：${span.kind} 属于 ${lookup.ownerRunId}`,
          item.own ? "本 run 自有" : "继承自来源链",
          body === null
            ? "未取正文"
            : body.recorded
              ? `${body.range.start}–${body.range.end} 码点（共 ${body.range.total}）`
              : "该段未记录",
        ].join(" / "),
      };
    };

    const initial = buildPayload(args.maxChars);
    if (filteredText === null) return initial;
    const initialEnd = sliceBody(filteredText, args.maxChars, start).range.end;
    const initialEmitted = initialEnd - start;
    if (initialEmitted <= 0) return initial;
    return {
      ...initial,
      budget: {
        kind: "chars",
        value: initialEmitted,
        minimum: 0,
        fit: (chars) => buildPayload(Math.min(chars, initialEmitted)),
        limitRef: `span:${lookup.ownerRunId}:${args.spanId}`,
      },
    };
  },
);
