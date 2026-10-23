import {
  RunReadContext,
  RunRepository,
  classifyReadFailure,
  findIllegalExternalRunIdViolation,
  findIllegalLogicalPathViolation,
  findIllegalSpanIdViolation,
  readWorkspaceFileForView,
} from "@rebaseagent/run-query";
import type { WorkspaceReadFileResult } from "@rebaseagent/run-query";
import { z } from "zod";
import type { LimitationInput, ProvenanceRefInput } from "../envelope.js";
import { LOGICAL_PATH_MAX, MESSAGE_MAX } from "../limits.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import { type ReadCheckpointFileArgs, requireContract } from "../tool-contracts.js";
import { ToolFailure, type ToolPayload, defineTool } from "../tool-definition.js";
import { sliceBody } from "./body-range.js";
import {
  locateRefOf,
  outcomeTagOf,
  ownCheckpointItems,
  ownCheckpointOf,
  provenanceRunsOf,
  toolCodeOfLocateFailure,
} from "./projection.js";
import { computeReadVersion } from "./read-version.js";

/**
 * `read_checkpoint_file`（design D5 第六行 + D6 的 `encoding=utf8-text`；Q14 的协议面）。
 *
 * 四条边界：
 * - **只有显式 `path` 才出正文**：路径必须在所选清单内；逻辑路径的非法形状（穿越、
 *   盘符/UNC、NUL、超 4096）在进入共享层**之前**按参数问题拒（design D3/Q05）。
 *   这一层比桌面严是刻意的：桌面对同一请求仍按既有语义得到 `not_found`（D2 不收紧旧行为），
 *   而外部客户端拿到「你给的路径不合规」比拿到「清单里没有」更准确。
 * - **缺省 selector = 本 run 初始快照**，与 `inspect_checkpoint` 同一条口径；不给
 *   「最近一步」缺省语义，祖先步骤一律 `STEP_NOT_FOUND`（Q13）。
 * - **原文保真**：换行不规范化（CRLF 原样、尾随换行原样、无尾换行原样、空文件就是空串），
 *   正文按 **Unicode 码点**范围切（代理对不被切成半个字符）。`fullFile.bytes`/`sha256`
 *   描述的是**完整历史文件**，不充当片段的校验值（design D6/D7）。
 * - **二进制不冒充文本**：`binary` 只给字节数与哈希，不发 base64、不做替换字符解码。
 *
 * 六态不合并：共享层的 `rejected`（请求本身不成立）在这一层升成**稳定码 + 失败信封**，
 * 而不是塞回数据里当一个模糊状态；`not_found`/`missing`/`corrupt` 三种「数据状态」各自
 * 保留并绑定 selector，客户端据此能分辨「路径不在清单」「附件缺失」「附件与哈希不符」。
 * 真实 I/O 故障走 `STORAGE_IO`（唯一 `retryable` 的数据类码）。
 */

const SnapshotIdSchema = z.string().regex(/^[0-9a-f]{64}$/, "快照标识必须是 64 位小写十六进制");

/** 完整历史文件的身份：字节数 + 内容哈希（与片段范围分开放，避免被读成"片段的校验值"） */
const FullFileSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    sha256: SnapshotIdSchema,
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

const StateReasonSchema = z.string().min(1).max(MESSAGE_MAX);

/**
 * 逐状态形状。`binary` 一支**没有** `text` 字段（不是"文本为空"），
 * `not_found` 一支没有 `fullFile`（清单里根本没有这份文件，无从给哈希）。
 */
const CheckpointFileBodySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("text"),
      fullFile: FullFileSchema,
      /** 文件那一路是原文本；结构正文那一路才是 canonical-json（design D6） */
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
]);

const ReadCheckpointFileDataSchema = z
  .object({
    /** 结果里的每个状态都绑这一组定位：run +（初始或自有 step）+ 快照 + 逻辑路径 */
    selector: z
      .object({
        runId: z.string().min(1),
        /** null = 本 run 初始快照 */
        stepSpanId: z.string().min(1).nullable(),
        snapshotId: SnapshotIdSchema,
        path: z.string().min(1).max(LOGICAL_PATH_MAX),
      })
      .strict(),
    /** 该检查点相对本 run 初始快照的清单汇总（避免客户端为一条文件再翻一次清单） */
    checkpointTotals: z
      .object({
        fileCount: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
      })
      .strict(),
    file: CheckpointFileBodySchema,
  })
  .strict();
export type ReadCheckpointFileData = z.infer<typeof ReadCheckpointFileDataSchema>;

export const readCheckpointFileTool: ToolDefinition = defineTool(
  requireContract("read_checkpoint_file"),
  async (args: ReadCheckpointFileArgs, root: DataRoot) => {
    if (args.cursor !== undefined) {
      // 正文分段续读的游标签发与来源核验归 5.2：本次只能给首段范围
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }
    if (findIllegalExternalRunIdViolation(args.runId) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "runId");
    }
    if (args.stepSpanId !== undefined && findIllegalSpanIdViolation(args.stepSpanId) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "stepSpanId");
    }
    /**
     * 逻辑路径在**任何读取之前**判形状（design D3）：物理位置从不出现在请求里，
     * 而非法形状的逻辑路径也不配让服务去打开任何清单。
     */
    if (findIllegalLogicalPathViolation(args.path) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "path");
    }

    const repository = new RunRepository(root.tracesDir);
    const readVersion = computeReadVersion("read_checkpoint_file", args, repository);
    const context = new RunReadContext(root.tracesDir);
    /** 检查点不涉及 span 归属（只认本 run 自有记录），因此不必建 owner 索引 */
    const { detail, chainSummaries } = context.readOf(args.runId);
    const leafRunId = detail.meta.id;

    let read: WorkspaceReadFileResult;
    try {
      read = await readWorkspaceFileForView(
        { dataDir: root.dataDir, repository },
        {
          runId: leafRunId,
          path: args.path,
          ...(args.stepSpanId === undefined ? {} : { stepSpanId: args.stepSpanId }),
        },
      );
    } catch (e) {
      /**
       * 共享层把「真实 I/O 故障」与「文件的一种状态」分得很清：前者抛错、后者返回状态。
       * 这里按结构分类（不解析异常文本），故障升成 `STORAGE_IO`，
       * 绝不伪装成 `missing`/`corrupt`（那会让客户端以为读到了数据）。
       */
      throw new ToolFailure(
        classifyReadFailure(e),
        locateRefOf({ runId: leafRunId, stepSpanId: args.stepSpanId, path: args.path }),
      );
    }

    if (read.status === "rejected") {
      throw new ToolFailure(
        toolCodeOfLocateFailure(read.code),
        locateRefOf({ runId: leafRunId, stepSpanId: args.stepSpanId, path: args.path }),
      );
    }

    /** 与 `inspect_checkpoint` 同一份自有检查点索引：三处（get_run/inspect/read）说法一致 */
    const selectorStep = args.stepSpanId ?? null;
    const matched = ownCheckpointOf(
      ownCheckpointItems(detail, new Set(detail.leafSpanIds)),
      selectorStep,
    );
    if (matched === undefined) {
      // 共享层定位成功而本次投影指认不到 ⇒ 来源已变，不拼混合结果
      throw new ToolFailure(
        "RUN_INVALID",
        locateRefOf({
          runId: leafRunId,
          ...(selectorStep === null ? {} : { stepSpanId: selectorStep }),
          path: args.path,
        }),
      );
    }

    const runs = provenanceRunsOf(detail, chainSummaries);
    if (runs === null) {
      throw new ToolFailure("RUN_INVALID", `run:${leafRunId}`);
    }
    const summary = chainSummaries[chainSummaries.length - 1];
    if (summary === undefined) {
      throw new ToolFailure("RUN_INVALID", `run:${leafRunId}`);
    }

    const limitations: LimitationInput[] = [];
    if (!outcomeTagOf(summary).sealed) {
      limitations.push({
        code: "TERMINATION_NOT_RECORDED",
        ref: `run:${leafRunId}`,
        message: "没有终止事件：正文只到已落盘的记录为止，不能据此判断该运行仍在进行",
      });
    }

    const refs: ProvenanceRefInput[] = [
      {
        runId: leafRunId,
        ...(selectorStep === null ? {} : { stepSpanId: selectorStep }),
        snapshotId: matched.snapshotId,
        path: read.path,
      },
    ];

    const buildPayload = (chars: number | undefined): ToolPayload => {
      const file = projectFileBody(read, chars);
      const data = ReadCheckpointFileDataSchema.parse({
        selector: {
          runId: leafRunId,
          stepSpanId: selectorStep,
          snapshotId: matched.snapshotId,
          path: read.path,
        },
        checkpointTotals: { fileCount: matched.fileCount, totalBytes: matched.totalBytes },
        file,
      });
      return {
        readVersion,
        data,
        truncated: file.status === "text" ? file.truncated : false,
        runs,
        refs,
        limitations,
        headline: [
          `read_checkpoint_file：${file.status}`,
          `检查点 ${matched.stepSpanId === null ? "初始快照" : `步骤 ${matched.stepSpanId}`}`,
          file.status === "text"
            ? `${file.range.start}–${file.range.end} 码点（共 ${file.range.total}）`
            : "未外发正文",
        ].join(" / "),
      };
    };

    const initial = buildPayload(args.maxChars);
    if (read.status !== "text") return initial;
    const initialEnd = sliceBody(read.text, args.maxChars).range.end;
    return {
      ...initial,
      budget: {
        kind: "chars",
        value: initialEnd,
        minimum: 0,
        fit: (chars) => buildPayload(Math.min(chars, initialEnd)),
        limitRef: `run:${leafRunId}`,
      },
    };
  },
);

/** 共享层状态 → 外发状态段：`rejected` 已由调用方升成稳定码，这里只落地五种数据状态 */
type LocatedFileRead = Exclude<WorkspaceReadFileResult, { status: "rejected" }>;

function projectFileBody(
  read: LocatedFileRead,
  maxChars: number | undefined,
): z.infer<typeof CheckpointFileBodySchema> {
  switch (read.status) {
    case "text": {
      const sliced = sliceBody(read.text, maxChars);
      return {
        status: "text",
        fullFile: { bytes: read.bytes, sha256: read.sha256 },
        encoding: "utf8-text",
        text: sliced.text,
        range: sliced.range,
        truncated: sliced.truncated,
        remaining: sliced.remaining,
      };
    }
    case "binary":
      return { status: "binary", fullFile: { bytes: read.bytes, sha256: read.sha256 } };
    case "not_found":
      return { status: "not_found", reason: read.reason };
    case "missing":
      return {
        status: "missing",
        fullFile: { bytes: read.bytes, sha256: read.sha256 },
        reason: read.reason,
      };
    case "corrupt":
      return {
        status: "corrupt",
        fullFile: { bytes: read.bytes, sha256: read.sha256 },
        reason: read.reason,
      };
  }
}
