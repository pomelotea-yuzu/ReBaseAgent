import type { Translator } from "@rebaseagent/i18n";
import { RunRepository } from "@rebaseagent/run-query";
import type { RunQueryToolErrorCode } from "@rebaseagent/run-query";
import { z } from "zod";
import type { ProvenanceRunInput } from "../envelope.js";
import { ToolErrorCodeSchema } from "../error-projection.js";
import { MESSAGE_MAX, PAGE_LIMIT_DEFAULT, RUN_ID_MAX } from "../limits.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import { RUN_STATUS_FILTERS, requireContract } from "../tool-contracts.js";
import type { ListRunsArgs } from "../tool-contracts.js";
import {
  ToolFailure,
  type ToolPayload,
  defineTool,
  toolErrorMessageOf,
} from "../tool-definition.js";
import { issueCursor, requireCursorPosition, withoutCursor } from "./cursor-io.js";
import {
  RunSummaryItemSchema,
  compareFileOrder,
  compareSummaryOrder,
  matchesOutcome,
  matchesQuery,
  outcomeTagOf,
  projectRunSummary,
  safeFileIdentifier,
  takeWindow,
} from "./projection.js";
import { computeReadVersion } from "./read-version.js";

/**
 * `list_runs`（design D5 第一行；Q03/Q04 的外部面）。
 *
 * 一条线性序列 = **命中的摘要段** + **不可读文件段**：
 * - 筛选只作用于成功摘要，失败项**不因筛选消失**（Q03 咬住的就是这一条）；
 * - 摘要段按 `created_at` 倒序、同刻按 run 标识 UTF-16 代码单元升序；失败段按安全
 *   文件标识升序；
 * - 两段共用同一个位置序列，5.2 的游标才能在一个坐标系里续读，失败项也不会每页重传。
 *
 * 正文不在列表里：共享层的 `deriveRunSummary` 本就只透传分叉点/字段名/实验组标签
 * （不带 `fork.edit.value`），本层不为了"看起来更全"再回头读文件。
 */

const RunListItemSchema = z.discriminatedUnion("kind", [
  RunSummaryItemSchema.extend({ kind: z.literal("run") }).strict(),
  z
    .object({
      kind: z.literal("unreadable_file"),
      /** 只给文件名（已剥控制字符/分隔符并按上限截断）；物理路径永不进这里 */
      file: z.string().min(1).max(RUN_ID_MAX),
      code: ToolErrorCodeSchema,
      /** 受控文案取自码表——不取共享层的中文异常文本，也不取异常的 message */
      message: z.string().min(1).max(MESSAGE_MAX),
    })
    .strict(),
]);
export type ListRunItem = z.infer<typeof RunListItemSchema>;

const ListRunsDataSchema = z
  .object({
    filter: z
      .object({
        status: z.enum(RUN_STATUS_FILTERS),
        query: z.string().nullable(),
      })
      .strict(),
    items: z.array(RunListItemSchema),
    totals: z
      .object({
        /** 命中筛选的摘要条数（本页之外还剩下多少由 `remaining` 说明） */
        matchedRuns: z.number().int().nonnegative(),
        unreadableFiles: z.number().int().nonnegative(),
        listed: z.number().int().nonnegative(),
        remaining: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type ListRunsData = z.infer<typeof ListRunsDataSchema>;

/** 序列里的一格：条目本体 + 它能不能作为来源被引用（失败项没有可信 run 身份） */
interface SequenceEntry {
  readonly item: ListRunItem;
  readonly provenance: ProvenanceRunInput | null;
}

function failureEntry(
  file: string,
  code: RunQueryToolErrorCode,
  translator: Translator,
): SequenceEntry {
  return {
    item: {
      kind: "unreadable_file",
      file: safeFileIdentifier(file),
      code,
      message: toolErrorMessageOf(code, translator),
    },
    provenance: null,
  };
}

function byFileAscending(a: SequenceEntry, b: SequenceEntry): number {
  const left = a.item.kind === "unreadable_file" ? a.item.file : "";
  const right = b.item.kind === "unreadable_file" ? b.item.file : "";
  return compareFileOrder({ file: left }, { file: right });
}

export const listRunsTool: ToolDefinition = defineTool(
  requireContract("list_runs"),
  async (args: ListRunsArgs, root: DataRoot, translator: Translator) => {
    const repository = new RunRepository(root.tracesDir);
    const requestArgs = withoutCursor(args);
    const readVersion = computeReadVersion("list_runs", requestArgs, repository);
    /** 首页 = 0；续读位置由认证游标给出（参数/来源在 decode 内先核验） */
    const [start] = requireCursorPosition({
      cursor: args.cursor,
      tool: "list_runs",
      params: requestArgs,
      readVersion,
      kind: "items",
      slots: 1,
    });
    const { runs, failed } = repository.listRunsWithIdentity();
    const status = args.status ?? "all";

    const rows: { createdAt: string; runId: string; entry: SequenceEntry }[] = [];
    const unrequestable: SequenceEntry[] = [];
    for (const record of runs) {
      const summary = record.summary;
      /**
       * 身份超出外部标识上限（design D3 的 runId ≤ 200）= 客户端拿到也没法按 ID 回查。
       * 这类记录**在筛选之前就**改判为失败项：不冒充可请求的摘要，也不因为某次筛选
       * 就连同它的文件一起从列表里蒸发。
       */
      if (summary.id.length > RUN_ID_MAX) {
        unrequestable.push(failureEntry(record.file, "RUN_INVALID", translator));
        continue;
      }
      if (!matchesOutcome(summary, status)) continue;
      if (args.query !== undefined && !matchesQuery(summary, args.query)) continue;
      rows.push({
        createdAt: summary.created_at,
        runId: summary.id,
        entry: {
          item: { kind: "run", ...projectRunSummary(summary, record.formatVersion) },
          provenance: {
            runId: summary.id,
            formatVersion: record.formatVersion,
            sealed: outcomeTagOf(summary).sealed,
            // 列表只扫各自文件，不读父链也不做轨迹投影 ⇒ lineage/spanScope 如实留空
            // （4.2 起这两项在信封里是可选的），要来源完整性请走 get_run。
          },
        },
      });
    }
    rows.sort(compareSummaryOrder);

    const failures: SequenceEntry[] = [
      ...failed.map((entry) => failureEntry(entry.file, entry.code, translator)),
      ...unrequestable,
    ].sort(byFileAscending);

    const sequence: SequenceEntry[] = [...rows.map((row) => row.entry), ...failures];
    const requestedLimit = args.limit ?? PAGE_LIMIT_DEFAULT;
    if (start > sequence.length || (args.cursor !== undefined && start >= sequence.length)) {
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }

    const buildPayload = (pageSize: number): ToolPayload => {
      const window = takeWindow(sequence.slice(start), Math.min(pageSize, requestedLimit));
      const end = start + window.items.length;
      const nextCursor =
        end < sequence.length
          ? issueCursor({
              tool: "list_runs",
              params: requestArgs,
              readVersion,
              kind: "items",
              position: [end],
            })
          : undefined;
      const data = ListRunsDataSchema.parse({
        filter: { status, query: args.query ?? null },
        items: window.items.map((entry) => entry.item),
        totals: {
          matchedRuns: rows.length,
          unreadableFiles: failures.length,
          listed: window.items.length,
          remaining: window.remaining,
          limit: requestedLimit,
        },
      });
      return {
        readVersion,
        data,
        truncated: window.truncated,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        runs: window.items
          .map((entry) => entry.provenance)
          .filter((run): run is ProvenanceRunInput => run !== null),
        headline: [
          translator.t("mcp.headlineListRuns", { matched: rows.length }),
          translator.t("mcp.summaryUnreadableFiles", { count: failures.length }),
          window.truncated
            ? translator.t("mcp.summaryPagePartial", {
                listed: window.items.length,
                remaining: window.remaining,
              })
            : translator.t("mcp.summaryPageAll"),
        ].join(" / "),
      };
    };

    const initial = buildPayload(requestedLimit);
    const initialCount = Math.min(sequence.length - start, requestedLimit);
    if (initialCount === 0) return initial;
    return {
      ...initial,
      budget: {
        kind: "items",
        value: initialCount,
        minimum: 1,
        fit: (items) => buildPayload(Math.min(items, requestedLimit)),
        limitRef: limitRefOf(sequence[start]),
      },
    };
  },
);

/** 最小页仍装不下时只指认首项（身份不进正文；失败项用安全文件标识） */
function limitRefOf(entry: SequenceEntry | undefined): string {
  if (entry === undefined) return "tool:list_runs";
  return entry.item.kind === "run" ? `run:${entry.item.runId}` : `file:${entry.item.file}`;
}
