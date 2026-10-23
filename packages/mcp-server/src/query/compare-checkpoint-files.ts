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
import {
  TOOL_ERROR_MESSAGES,
  ToolErrorCodeSchema,
  boundedMessage,
  retryableOf,
} from "../error-projection.js";
import { LOGICAL_PATH_MAX, MESSAGE_MAX, PAGE_LIMIT_DEFAULT } from "../limits.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import { type CompareCheckpointFilesArgs, requireContract } from "../tool-contracts.js";
import { ToolFailure, defineTool } from "../tool-definition.js";
import { sliceBody } from "./body-range.js";
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
      text: z.string(),
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

function toSideCell(side: SideName, result: CompareSideResult) {
  if (result.status === "unavailable") {
    return unavailableSideOfCode(
      side,
      result.requestedRunId,
      toolCodeOfLocateFailure(result.failure.code),
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
 */
function projectComparedFile(
  side: ComparedFileSide,
  maxChars: number | undefined,
): z.infer<typeof ComparedSideFileSchema> {
  switch (side.status) {
    case "text": {
      const sliced = sliceBody(side.text, maxChars);
      return {
        status: "text",
        fullFile: { bytes: side.file.bytes, sha256: side.file.sha256 },
        encoding: "utf8-text",
        text: sliced.text,
        range: sliced.range,
        truncated: sliced.truncated,
        remaining: sliced.remaining,
      };
    }
    case "binary":
      return {
        status: "binary",
        fullFile: { bytes: side.file.bytes, sha256: side.file.sha256 },
      };
    case "not_found":
      return { status: "not_found", reason: boundedMessage(side.reason) };
    case "missing":
    case "corrupt":
    case "too_large":
      return {
        status: side.status,
        fullFile: { bytes: side.file.bytes, sha256: side.file.sha256 },
        reason: boundedMessage(side.reason),
      };
    case "selection_changed":
      return {
        status: "selection_changed",
        expectedSnapshotId: side.expectedSnapshotId,
        actualSnapshotId: side.actualSnapshotId,
        reason: boundedMessage(side.reason),
      };
    case "io":
      // reason 是 Node errno 文本（可能含物理路径）⇒ 只留稳定码与码表文案
      return {
        status: "unavailable",
        code: "STORAGE_IO",
        message: boundedMessage(TOOL_ERROR_MESSAGES.STORAGE_IO),
        retryable: true,
      };
    case "unavailable": {
      const code = toolCodeOfLocateFailure(side.failure.code);
      return {
        status: "unavailable",
        code,
        message: boundedMessage(TOOL_ERROR_MESSAGES[code]),
        retryable: retryableOf(code),
      };
    }
  }
}

export const compareCheckpointFilesTool: ToolDefinition = defineTool(
  requireContract("compare_checkpoint_files"),
  async (args: CompareCheckpointFilesArgs, root: DataRoot) => {
    if (args.cursor !== undefined) {
      // 两侧游标（分别存左右 offset）归 5.2：本批两侧都只能给首段
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }
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
    const readVersion = computeReadVersion("compare_checkpoint_files", args, repository);
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

    const sides = [toSideCell("left", manifest.left), toSideCell("right", manifest.right)] as const;
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
          message: "该侧没有终止事件：只到已落盘的记录为止，不能据此判断该运行仍在进行",
        });
      }
    }

    const refs: ProvenanceRefInput[] = readySides.map((side) => ({
      runId: side.runId,
      ...(side.stepSpanId === null ? {} : { stepSpanId: side.stepSpanId }),
      snapshotId: side.snapshotId,
    }));

    // ---------------- 内容模式 ----------------
    if (args.path !== undefined) {
      if (readySides.length !== 2) {
        // 缺任一侧就没有「两侧比对」这个对象 ⇒ 按那一侧的稳定码失败，不发半份结论
        const broken = sides.find((side) => side.status === "unavailable");
        if (broken === undefined || broken.status !== "unavailable") {
          throw new ToolFailure("RUN_INVALID", `path:${boundedMessage(args.path)}`);
        }
        throw new ToolFailure(broken.code, locateRefOf({ runId: broken.runId, path: args.path }));
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
        throw new ToolFailure(
          classifyReadFailure(e),
          locateRefOf({ runId: leftSide.runId, path: args.path }),
        );
      }
      const left = projectComparedFile(compared.left, args.maxChars);
      const right = projectComparedFile(compared.right, args.maxChars);

      const data = CompareCheckpointFilesDataSchema.parse({
        mode: "content",
        sides: [leftSide, rightSide],
        path: compared.path,
        conclusion: compared.conclusion,
        textDiffEligible: compared.textDiffEligible,
        files: { left, right },
      });

      return {
        readVersion,
        data,
        truncated:
          (left.status === "text" && left.truncated) ||
          (right.status === "text" && right.truncated),
        runs,
        refs,
        limitations,
        headline: [
          `compare_checkpoint_files：${compared.conclusion}`,
          `可生成文本 diff ${compared.textDiffEligible ? "是" : "否"}`,
          `左 ${left.status} / 右 ${right.status}`,
        ].join(" / "),
      };
    }

    // ---------------- 清单模式 ----------------
    const window = takeWindow(manifest.entries, args.limit);
    const entries = window.items.map((entry) => ({
      path: entry.path,
      presence: entry.presence,
      left: entry.left === null ? null : { sha256: entry.left.sha256, bytes: entry.left.bytes },
      right: entry.right === null ? null : { sha256: entry.right.sha256, bytes: entry.right.bytes },
      reference: entry.reference,
    }));
    if (entries.some((entry) => entry.reference === "same")) {
      limitations.push({
        code: "BODY_NOT_EXPOSED",
        ref: `compare:${readySides[0]?.snapshotId ?? "unavailable"}/${
          readySides[1]?.snapshotId ?? "unavailable"
        }`,
        message:
          "清单 reference=same 只表示哈希与字节数相同；内容结论需在请求里带上 path 取逐侧核验",
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
        limit: args.limit ?? PAGE_LIMIT_DEFAULT,
      },
    });

    return {
      readVersion,
      data,
      truncated: window.truncated,
      runs,
      refs,
      limitations,
      headline: [
        "compare_checkpoint_files：清单模式",
        manifest.unionComplete
          ? `并集 ${manifest.entries.length} 条路径`
          : "某侧检查点不可读：并集不完整，空清单不代表文件不存在",
        window.truncated ? `本页 ${entries.length} 条，尚有 ${window.remaining} 条` : "已列全",
      ].join(" / "),
    };
  },
);
