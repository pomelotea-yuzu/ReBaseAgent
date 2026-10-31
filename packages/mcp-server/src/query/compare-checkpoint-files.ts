import type { Translator } from "@rebaseagent/i18n";
import {
  RunRepository,
  classifyReadFailure,
  compareWorkspaceSnapshots,
  deriveRunSummary,
  findIllegalExternalRunIdViolation,
  findIllegalLogicalPathViolation,
  findIllegalSpanIdViolation,
  readComparedWorkspaceFile,
} from "@rebaseagent/run-query";
import type { CompareSideResult, ComparedFileSide } from "@rebaseagent/run-query";
import { z } from "zod";
import type { LimitationInput, ProvenanceRefInput, ProvenanceRunInput } from "../envelope.js";
import { ToolErrorCodeSchema, boundedMessage, retryableOf } from "../error-projection.js";
import {
  BODY_CHARS_DEFAULT,
  LOGICAL_PATH_MAX,
  MESSAGE_MAX,
  PAGE_LIMIT_DEFAULT,
} from "../limits.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import { type CompareCheckpointFilesArgs, requireContract } from "../tool-contracts.js";
import {
  ToolFailure,
  type ToolPayload,
  defineTool,
  toolErrorMessageOf,
} from "../tool-definition.js";
import { attachmentLedger } from "./attachment-ledger.js";
import { sliceBody } from "./body-range.js";
import { issueCursor, requireCursorPosition, withoutCursor } from "./cursor-io.js";
import {
  ContentHashSchema,
  type SideName,
  SideNameSchema,
  UnavailableSideSchema,
  locateRefOf,
  takeWindow,
  toolCodeOfLocateFailure,
  unavailableSideOfCode,
} from "./projection.js";
import { computeReadVersion } from "./read-version.js";

/**
 * `compare_checkpoint_files`（design D5 第七行 + D6 的比较游标口径；Q14 的两侧半边、S10）。
 *
 * 两种模式共用一次**清单冻结**（`compareWorkspaceSnapshots`），差别只在要不要接着读字节：
 * - **无 `path` = 清单模式**：路径并集分页 + 逐侧清单引用。`reference:"same"`
 *   **只表示哈希与字节数相同**，内容结论仍需带 `path` 再请求一次（D6）。
 *   任一侧定位不到 ⇒ `unionComplete:false`、`entries` 为空，但**两格都在**
 *   （坏侧保留真实身份 + 稳定码，好侧照常——Q11 同一条纪律）；
 *   客户端不能把空并集读成"这些文件不存在"。
 * - **有 `path` = 内容模式**：把刚才冻结的两侧快照 id 作为 `expectedSnapshotIds` 交给
 *   `readComparedWorkspaceFile`，逐侧核验长度/哈希后才给正文与结论——这就是桌面文件页的
 *   「清单/正文双代次守卫」，在同一次请求内完成。本批**没有游标**（签发归 5.2），
 *   两侧各自从 0 起按码点切，**一侧结束不拿另一侧补**（S10）。
 *
 * 三条不猜：
 * - **结论不来自片段**：`conclusion` 由共享层按完整附件核验给出；两侧首段一样、差异落在
 *   4096 码点之后的文件，结论必须是 `different`（有用例专门钉）。
 * - **故障不当文件状态，也不透传原始 reason**：逐侧 `io` 的 reason 是 Node 的 errno 文本，
 *   里面可能带附件的物理路径 ⇒ 该侧改判 `unavailable` + `STORAGE_IO`（可重试），
 *   另一侧事实照发。`not_found`/`missing`/`corrupt`/`too_large` 是数据状态，保留并绑 selector。
 * - **缺任一侧就不发半份结论**：内容模式请求的对象是"这一条路径的两侧比对"，
 *   一侧检查点定位不到 ⇒ 整条请求按该侧稳定码失败（与 `read_checkpoint_file` 同口径）；
 *   清单模式因为两侧身份各自成立，才用两格 + `unionComplete:false`。
 *
 * 两侧 selector 允许指向**同一个 run 的两份检查点**，禁止两侧是同一份检查点（自比没有信息，
 * 读取前按 `left/right` 拒）。**绝不按迭代序号猜对应**：结果里没有任何步骤对齐字段。
 */

const ReadySideSchema = z
  .object({
    side: SideNameSchema,
    status: z.literal("ready"),
    runId: z.string().min(1),
    /** null = 该侧读的是本 run 初始快照（缺省 selector 的那一份） */
    stepSpanId: z.string().min(1).nullable(),
    snapshotId: ContentHashSchema,
    /** 该侧所属 run 自己的初始快照：分支 run 的「相对初始」不借父的 */
    initialSnapshotId: ContentHashSchema,
  })
  .strict();
type ReadySide = z.infer<typeof ReadySideSchema>;

/** 公开逐侧格：可读的那格给身份，不可读的那格给稳定码——一格都不会因对面坏了而被省掉 */
const ComparedSideSchema = z.discriminatedUnion("status", [ReadySideSchema, UnavailableSideSchema]);

const FileReferenceSchema = z
  .object({
    sha256: ContentHashSchema,
    bytes: z.number().int().nonnegative(),
  })
  .strict();

const ManifestEntrySchema = z
  .object({
    path: z.string().min(1).max(LOGICAL_PATH_MAX),
    presence: z.enum(["both", "left_only", "right_only"]),
    /** 缺失的一侧是 null，不是"空文件"——不把「该侧清单没有」写成零字节 */
    left: FileReferenceSchema.nullable(),
    right: FileReferenceSchema.nullable(),
    /** same 只表示引用（哈希 + 字节数）相同；内容结论要带 path 再查 */
    reference: z.enum(["same", "different"]).nullable(),
  })
  .strict();

const FullFileSchema = z
  .object({ bytes: z.number().int().nonnegative(), sha256: ContentHashSchema })
  .strict();

const RangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    unit: z.literal("unicode-code-point"),
  })
  .strict();

const StateReasonSchema = z.string().min(1).max(MESSAGE_MAX);

/**
 * 逐侧内容状态。`io` 一支**不出现**在这里（被改判成 `unavailable` + `STORAGE_IO`），
 * `unavailable` 一支带稳定码与码表文案，不带共享层的原始 reason。
 */
const ComparedSideFileSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("text"),
      fullFile: FullFileSchema,
      encoding: z.literal("utf8-text"),
      /**
       * 6.2 修订（正文只承载一次）：正文本体只进 content 文本，此处是指针；
       * `fullFile/range/truncated/remaining` 小事实保留。
       */
      bodyIn: z.literal("content"),
      range: RangeSchema,
      truncated: z.boolean(),
      remaining: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ status: z.literal("binary"), fullFile: FullFileSchema }).strict(),
  z.object({ status: z.literal("not_found"), reason: StateReasonSchema }).strict(),
  z
    .object({
      status: z.literal("missing"),
      fullFile: FullFileSchema,
      reason: StateReasonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("corrupt"),
      fullFile: FullFileSchema,
      reason: StateReasonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("too_large"),
      fullFile: FullFileSchema,
      reason: StateReasonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("selection_changed"),
      expectedSnapshotId: ContentHashSchema,
      actualSnapshotId: ContentHashSchema,
      reason: StateReasonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      code: ToolErrorCodeSchema,
      message: z.string().min(1).max(MESSAGE_MAX),
      retryable: z.boolean(),
    })
    .strict(),
]);

const CompareCheckpointFilesDataSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("manifest"),
      sides: z.array(ComparedSideSchema).length(2),
      /** false 时 entries 为空是「并集不完整」，不是「两侧都没有这些文件」 */
      unionComplete: z.boolean(),
      entries: z.array(ManifestEntrySchema),
      totals: z
        .object({
          paths: z.number().int().nonnegative(),
          listed: z.number().int().nonnegative(),
          remaining: z.number().int().nonnegative(),
          limit: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("content"),
      sides: z.array(ReadySideSchema).length(2),
      path: z.string().min(1).max(LOGICAL_PATH_MAX),
      /** 由共享层按完整附件核验给出；片段相似不构成 same */
      conclusion: z.enum([
        "same",
        "different",
        "left_only",
        "right_only",
        "not_found",
        "unavailable",
      ]),
      textDiffEligible: z.boolean(),
      files: z.object({ left: ComparedSideFileSchema, right: ComparedSideFileSchema }).strict(),
    })
    .strict(),
]);
export type CompareCheckpointFilesData = z.infer<typeof CompareCheckpointFilesDataSchema>;

function toSideCell(side: SideName, result: CompareSideResult, translator: Translator) {
  if (result.status === "unavailable") {
    return unavailableSideOfCode(
      side,
      result.requestedRunId,
      toolCodeOfLocateFailure(result.failure.code),
      translator,
    );
  }
  const ready: ReadySide = {
    side,
    status: "ready",
    runId: result.selected.runId,
    stepSpanId: result.selected.stepSpanId,
    snapshotId: result.selected.snapshotId,
    initialSnapshotId: result.selected.initialSnapshotId,
  };
  return ready;
}

/**
 * 逐侧正文状态：正文按**该侧自己的** `maxChars` 切（一侧结束不拿另一侧补，D6/S10）。
 * 返回值两件套：`shape` 是 data 内的外发形状（text 分支带 `bodyIn:"content"` 指针），
 * `bodyText` 是该侧正文本体（null = 无正文），只随 content 文本走（正文只承载一次）。
 */
function projectComparedFile(
  side: ComparedFileSide,
  maxChars: number | undefined,
  translator: Translator,
  start = 0,
): {
  shape: z.infer<typeof ComparedSideFileSchema>;
  bodyText: string | null;
} {
  switch (side.status) {
    case "text": {
      const sliced = sliceBody(side.text, maxChars, start);
      return {
        shape: {
          status: "text",
          fullFile: { bytes: side.file.bytes, sha256: side.file.sha256 },
          encoding: "utf8-text",
          bodyIn: "content",
          range: sliced.range,
          truncated: sliced.truncated,
          remaining: sliced.remaining,
        },
        bodyText: sliced.text,
      };
    }
    case "binary":
      return {
        shape: { status: "binary", fullFile: { bytes: side.file.bytes, sha256: side.file.sha256 } },
        bodyText: null,
      };
    case "not_found":
      return {
        shape: { status: "not_found", reason: boundedMessage(side.reason) },
        bodyText: null,
      };
    case "missing":
    case "corrupt":
    case "too_large":
      return {
        shape: {
          status: side.status,
          fullFile: { bytes: side.file.bytes, sha256: side.file.sha256 },
          reason: boundedMessage(side.reason),
        },
        bodyText: null,
      };
    case "selection_changed":
      return {
        shape: {
          status: "selection_changed",
          expectedSnapshotId: side.expectedSnapshotId,
          actualSnapshotId: side.actualSnapshotId,
          reason: boundedMessage(side.reason),
        },
        bodyText: null,
      };
    case "io":
      // reason 是 Node errno 文本（可能含物理路径）⇒ 只留稳定码与码表文案
      return {
        shape: {
          status: "unavailable",
          code: "STORAGE_IO",
          message: boundedMessage(toolErrorMessageOf("STORAGE_IO", translator)),
          retryable: true,
        },
        bodyText: null,
      };
    case "unavailable": {
      const code = toolCodeOfLocateFailure(side.failure.code);
      return {
        shape: {
          status: "unavailable",
          code,
          message: boundedMessage(toolErrorMessageOf(code, translator)),
          retryable: retryableOf(code),
        },
        bodyText: null,
      };
    }
  }
}

export const compareCheckpointFilesTool: ToolDefinition = defineTool(
  requireContract("compare_checkpoint_files"),
  async (args: CompareCheckpointFilesArgs, root: DataRoot, translator: Translator) => {
    for (const [name, selector] of [
      ["left", args.left],
      ["right", args.right],
    ] as const) {
      if (findIllegalExternalRunIdViolation(selector.runId) !== null) {
        throw new ToolFailure("INVALID_ARGUMENT", `${name}.runId`);
      }
      if (
        selector.stepSpanId !== undefined &&
        findIllegalSpanIdViolation(selector.stepSpanId) !== null
      ) {
        throw new ToolFailure("INVALID_ARGUMENT", `${name}.stepSpanId`);
      }
    }
    if (args.path !== undefined && findIllegalLogicalPathViolation(args.path) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "path");
    }
    /**
     * 同一 run 的两份检查点可以比（同 run 两点可比），同一份检查点不能自己跟自己比——
     * 那是把一次读取伪装成一次结论。
     */
    if (
      args.left.runId === args.right.runId &&
      (args.left.stepSpanId ?? null) === (args.right.stepSpanId ?? null)
    ) {
      throw new ToolFailure("INVALID_ARGUMENT", "left/right");
    }

    const repository = new RunRepository(root.tracesDir);
    const selectors = {
      left: {
        runId: args.left.runId,
        ...(args.left.stepSpanId === undefined ? {} : { stepSpanId: args.left.stepSpanId }),
      },
      right: {
        runId: args.right.runId,
        ...(args.right.stepSpanId === undefined ? {} : { stepSpanId: args.right.stepSpanId }),
      },
    };

    /**
     * 清单冻结一律先做：它既是清单模式要发出去的东西，也是内容模式 `expectedSnapshotIds`
     * 的唯一来源（正文必须对着**本次**冻结的那两份清单读，不把旧清单与新正文拼接）。
     */
    let manifest: ReturnType<typeof compareWorkspaceSnapshots>;
    try {
      manifest = compareWorkspaceSnapshots({ dataDir: root.dataDir, ...selectors });
    } catch (e) {
      throw new ToolFailure(
        classifyReadFailure(e),
        locateRefOf({
          runId: args.left.runId,
          stepSpanId: args.left.stepSpanId,
          ...(args.path === undefined ? {} : { path: args.path }),
        }),
      );
    }

    const sides = [
      toSideCell("left", manifest.left, translator),
      toSideCell("right", manifest.right, translator),
    ] as const;
    const readySides = sides.filter((side) => side.status === "ready") as ReadySide[];

    /**
     * 来源段：只给本次真读到的物理 run（同 run 两 selector 只给一条）。
     * 本工具不读父链 ⇒ `lineage`/`spanScope` 缺席 = 本次未判定（与 list_runs 同一口径，
     * 补一个没查过的 `complete` 就是把未知写成可信事实）。
     */
    const runs: ProvenanceRunInput[] = [];
    const limitations: LimitationInput[] = [];
    for (const side of readySides) {
      if (runs.some((item) => item.runId === side.runId)) continue;
      const record = repository.loadRunRecord(side.runId);
      const summary = deriveRunSummary(record);
      runs.push({
        runId: side.runId,
        formatVersion: record.meta.format_version,
        sealed: summary.status === "completed",
      });
      if (summary.status !== "completed") {
        limitations.push({
          code: "TERMINATION_NOT_RECORDED",
          ref: `run:${side.runId}`,
          message: translator.t("mcp.limitTerminationSide"),
        });
      }
    }

    const refs: ProvenanceRefInput[] = readySides.map((side) => ({
      runId: side.runId,
      ...(side.stepSpanId === null ? {} : { stepSpanId: side.stepSpanId }),
      snapshotId: side.snapshotId,
    }));

    const requestArgs = withoutCursor(args);
    const extra = {
      sides: sides.map((side) =>
        side.status === "ready"
          ? { side: side.side, status: "ready", runId: side.runId, snapshotId: side.snapshotId }
          : { side: side.side, status: "unavailable", runId: side.runId, code: side.code },
      ),
      attachments: attachmentLedger(
        root.dataDir,
        manifest.entries.flatMap((entry) =>
          [entry.left?.sha256, entry.right?.sha256].filter(
            (hash): hash is string => typeof hash === "string",
          ),
        ),
      ),
    };
    const readVersion = computeReadVersion(
      "compare_checkpoint_files",
      requestArgs,
      repository,
      extra,
    );
    const cursorKind = args.path === undefined ? "items" : "chars";
    const position = requireCursorPosition({
      cursor: args.cursor,
      tool: "compare_checkpoint_files",
      params: requestArgs,
      readVersion,
      kind: cursorKind,
      slots: args.path === undefined ? 1 : 2,
    });

    // ---------------- 内容模式 ----------------
    if (args.path !== undefined) {
      const path = args.path;
      if (readySides.length !== 2) {
        // 缺任一侧就没有「两侧比对」这个对象 ⇒ 按那一侧的稳定码失败，不发半份结论
        const broken = sides.find((side) => side.status === "unavailable");
        if (broken === undefined || broken.status !== "unavailable") {
          throw new ToolFailure("RUN_INVALID", `path:${boundedMessage(path)}`);
        }
        throw new ToolFailure(broken.code, locateRefOf({ runId: broken.runId, path }));
      }
      const [leftSide, rightSide] = readySides as [ReadySide, ReadySide];
      let compared: Awaited<ReturnType<typeof readComparedWorkspaceFile>>;
      try {
        compared = await readComparedWorkspaceFile({
          dataDir: root.dataDir,
          ...selectors,
          path: args.path,
          /**
           * 正文必须对着**本次**冻结的两份清单读：id 由上一步的清单判定给出，
           * 文件在两次读取之间被改动时由共享层判 `selection_changed`，不拼旧清单与新正文。
           */
          expectedSnapshotIds: { left: leftSide.snapshotId, right: rightSide.snapshotId },
        });
      } catch (e) {
        // 共享层把可预期的数据状态都放在返回值里，抛出来的只剩意外故障 ⇒ 按结构分类成稳定码
        throw new ToolFailure(classifyReadFailure(e), locateRefOf({ runId: leftSide.runId, path }));
      }

      const [leftStart, rightStart] = position;
      const leftTotal = compared.left.status === "text" ? [...compared.left.text].length : 0;
      const rightTotal = compared.right.status === "text" ? [...compared.right.text].length : 0;
      if (args.cursor !== undefined) {
        // 游标只来自 text/text 的两侧正文续读；任一侧变成非文本就没有可续的正文
        if (compared.left.status !== "text" || compared.right.status !== "text") {
          throw new ToolFailure("INVALID_ARGUMENT", "cursor");
        }
        if (leftStart >= leftTotal && rightStart >= rightTotal) {
          throw new ToolFailure("INVALID_ARGUMENT", "cursor");
        }
      }
      if (leftStart > leftTotal || rightStart > rightTotal) {
        throw new ToolFailure("INVALID_ARGUMENT", "cursor");
      }

      /** 两侧各按同一个码点上限切；一侧较短自然结束，不拿另一侧补（S10） */
      const buildPayload = (chars: number): ToolPayload => {
        const left = projectComparedFile(compared.left, chars, translator, leftStart);
        const right = projectComparedFile(compared.right, chars, translator, rightStart);
        const bothText = left.shape.status === "text" && right.shape.status === "text";
        const leftEnd = left.shape.status === "text" ? left.shape.range.end : leftStart;
        const rightEnd = right.shape.status === "text" ? right.shape.range.end : rightStart;
        const progress = bothText && (leftEnd > leftStart || rightEnd > rightStart);
        const remaining = bothText && (leftEnd < leftTotal || rightEnd < rightTotal);
        const nextCursor =
          progress && remaining
            ? issueCursor({
                tool: "compare_checkpoint_files",
                params: requestArgs,
                readVersion,
                kind: "chars",
                position: [leftEnd, rightEnd],
              })
            : undefined;
        const data = CompareCheckpointFilesDataSchema.parse({
          mode: "content",
          sides: [leftSide, rightSide],
          path: compared.path,
          conclusion: compared.conclusion,
          textDiffEligible: compared.textDiffEligible,
          files: { left: left.shape, right: right.shape },
        });
        /** 正文本体只随 content 走（data 内对应位是 bodyIn:"content" 指针） */
        const contentBodies = [
          ...(left.bodyText === null ? [] : [{ at: "files.left", text: left.bodyText }]),
          ...(right.bodyText === null ? [] : [{ at: "files.right", text: right.bodyText }]),
        ];
        return {
          readVersion,
          data,
          ...(contentBodies.length === 0 ? {} : { contentBodies }),
          truncated:
            (left.shape.status === "text" && left.shape.truncated) ||
            (right.shape.status === "text" && right.shape.truncated),
          ...(nextCursor === undefined ? {} : { nextCursor }),
          runs,
          refs,
          limitations: [...limitations],
          headline: [
            translator.t("mcp.headlineCompareFilesConclusion", {
              conclusion: compared.conclusion,
            }),
            translator.t("mcp.compareFilesTextDiff", {
              value: compared.textDiffEligible
                ? translator.t("mcp.summaryYes")
                : translator.t("mcp.summaryNo"),
            }),
            translator.t("mcp.compareFilesSides", {
              left: left.shape.status,
              right: right.shape.status,
            }),
          ].join(" / "),
        };
      };

      const initialCap = args.maxChars ?? BODY_CHARS_DEFAULT;
      return {
        ...buildPayload(initialCap),
        budget: {
          kind: "chars",
          value: initialCap,
          minimum: 0,
          fit: (chars) => buildPayload(Math.min(chars, initialCap)),
          limitRef: `run:${leftSide.runId}`,
        },
      };
    }

    // ---------------- 清单模式 ----------------
    const requestedLimit = args.limit ?? PAGE_LIMIT_DEFAULT;
    const pairRef = `compare:${readySides[0]?.snapshotId ?? "unavailable"}/${
      readySides[1]?.snapshotId ?? "unavailable"
    }`;
    const [start] = position;
    if (
      start > manifest.entries.length ||
      (args.cursor !== undefined && start >= manifest.entries.length)
    ) {
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }

    const buildPayload = (pageSize: number): ToolPayload => {
      const window = takeWindow(manifest.entries.slice(start), Math.min(pageSize, requestedLimit));
      const end = start + window.items.length;
      const nextCursor =
        end < manifest.entries.length
          ? issueCursor({
              tool: "compare_checkpoint_files",
              params: requestArgs,
              readVersion,
              kind: "items",
              position: [end],
            })
          : undefined;
      const entries = window.items.map((entry) => ({
        path: entry.path,
        presence: entry.presence,
        left: entry.left === null ? null : { sha256: entry.left.sha256, bytes: entry.left.bytes },
        right:
          entry.right === null ? null : { sha256: entry.right.sha256, bytes: entry.right.bytes },
        reference: entry.reference,
      }));
      const pageLimitations = [...limitations];
      if (entries.some((entry) => entry.reference === "same")) {
        pageLimitations.push({
          code: "BODY_NOT_EXPOSED",
          ref: pairRef,
          message: translator.t("mcp.limitCheckpointReferenceSame"),
        });
      }
      const data = CompareCheckpointFilesDataSchema.parse({
        mode: "manifest",
        sides,
        unionComplete: manifest.unionComplete,
        entries,
        totals: {
          paths: manifest.entries.length,
          listed: entries.length,
          remaining: window.remaining,
          limit: requestedLimit,
        },
      });
      return {
        readVersion,
        data,
        truncated: window.truncated,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        runs,
        refs,
        limitations: pageLimitations,
        headline: [
          translator.t("mcp.compareFilesManifestMode"),
          manifest.unionComplete
            ? translator.t("mcp.compareFilesUnion", { count: manifest.entries.length })
            : translator.t("mcp.compareFilesUnionIncomplete"),
          window.truncated
            ? translator.t("mcp.summaryPagePartial", {
                listed: entries.length,
                remaining: window.remaining,
              })
            : translator.t("mcp.summaryManifestComplete"),
        ].join(" / "),
      };
    };

    const initial = buildPayload(requestedLimit);
    const initialCount = Math.min(manifest.entries.length - start, requestedLimit);
    if (initialCount === 0) return initial;
    return {
      ...initial,
      budget: {
        kind: "items",
        value: initialCount,
        minimum: 1,
        fit: (items) => buildPayload(Math.min(items, requestedLimit)),
        limitRef: pairRef,
      },
    };
  },
);
