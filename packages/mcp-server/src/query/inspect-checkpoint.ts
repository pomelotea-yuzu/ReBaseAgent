import {
  RunReadContext,
  RunRepository,
  classifyReadFailure,
  findIllegalExternalRunIdViolation,
  findIllegalSpanIdViolation,
  inspectWorkspace,
} from "@rebaseagent/run-query";
import { z } from "zod";
import type { LimitationInput, ProvenanceRefInput } from "../envelope.js";
import { PAGE_LIMIT_DEFAULT } from "../limits.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import { type InspectCheckpointArgs, requireContract } from "../tool-contracts.js";
import { ToolFailure, defineTool } from "../tool-definition.js";
import {
  CheckpointFileItemSchema,
  CheckpointHeadSchema,
  locateRefOf,
  outcomeTagOf,
  ownCheckpointItems,
  ownCheckpointOf,
  projectCheckpointFile,
  projectCheckpointHead,
  provenanceRunsOf,
  takeWindow,
  toolCodeOfLocateFailure,
} from "./projection.js";
import { computeReadVersion } from "./read-version.js";

/**
 * `inspect_checkpoint`（design D5 第五行；Q13 的协议面）。
 *
 * 分层默认（**本工具的核心口径，勿与桌面混起来**）：
 * - 省略 `stepSpanId` = **本 run 的初始快照**，这是共享层 `inspectWorkspace` 的缺省语义；
 * - 桌面文件页那个「最近自有完成步骤」的默认**不在这里解析**，也不在任何共享层——
 *   它由 renderer（`renderer/src/lib/workspace-files.ts`）先算成显式 selector 再调 IPC
 *   （`main/ipc.ts` 的两个 workspaces 端点同样不代填）。MCP 若在这里补一个「最近一步」，
 *   客户端与桌面读到的就会是两份不同的清单（D8）。
 * - 显式 `stepSpanId` 只认**本 run 自有**的完成 `agent.step`：祖先步骤、非 step 的 span
 *   一律 `STEP_NOT_FOUND`（同码不同景，靠 `ref` 与 `get_step` 区分），**不换最近步骤、
 *   不把祖先快照充作自有**（Q13）。
 *
 * 清单与附件可用性一律由共享层给（`inspectWorkspace` 定位清单 + 逐项 verify），本层不重算
 * 哈希、不判可用性、也不读任何文件字节——要看内容必须显式 `read_checkpoint_file` 给 `path`，
 * 因此清单只给引用与状态并带 `BODY_NOT_EXPOSED`。
 */

const InspectCheckpointDataSchema = z
  .object({
    checkpoint: CheckpointHeadSchema,
    files: z.array(CheckpointFileItemSchema),
    totals: z
      .object({
        files: z.number().int().nonnegative(),
        listed: z.number().int().nonnegative(),
        remaining: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type InspectCheckpointData = z.infer<typeof InspectCheckpointDataSchema>;

export const inspectCheckpointTool: ToolDefinition = defineTool(
  requireContract("inspect_checkpoint"),
  async (args: InspectCheckpointArgs, root: DataRoot) => {
    /**
     * 形状校验在任何读取之前（design D3 + Q05）；游标签发与续读核验归 5.2，
     * 现在带游标就明确拒绝，不当首页重放。
     */
    if (args.cursor !== undefined) {
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }
    if (findIllegalExternalRunIdViolation(args.runId) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "runId");
    }
    if (args.stepSpanId !== undefined && findIllegalSpanIdViolation(args.stepSpanId) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "stepSpanId");
    }

    const repository = new RunRepository(root.tracesDir);
    const readVersion = computeReadVersion("inspect_checkpoint", args, repository);
    /** 每请求一个新上下文：同一物理 run 本次最多解析一次，事实不跨请求缓存（Q02） */
    const context = new RunReadContext(root.tracesDir);
    /** 检查点段不涉及 span 归属（只认本 run 自有记录），因此不必建 owner 索引 */
    const { detail, chainSummaries } = context.readOf(args.runId);
    const leafRunId = detail.meta.id;

    /**
     * 逐项 verify 附件时可能抛**真实 I/O 故障**（如附件位置被目录顶替）：共享层刻意把
     * 「故障」与「文件的一种状态」分开，这里按结构分类升成稳定码，不让它伪装成
     * missing/corrupt，也不让它越到服务层变成一句没有码的兜底文案。
     */
    let located: Awaited<ReturnType<typeof inspectWorkspace>>;
    try {
      located = await inspectWorkspace(
        { dataDir: root.dataDir, repository },
        {
          runId: leafRunId,
          ...(args.stepSpanId === undefined ? {} : { stepSpanId: args.stepSpanId }),
        },
      );
    } catch (e) {
      throw new ToolFailure(
        classifyReadFailure(e),
        locateRefOf({ runId: leafRunId, stepSpanId: args.stepSpanId }),
      );
    }
    if (!located.ok) {
      throw new ToolFailure(
        toolCodeOfLocateFailure(located.code),
        locateRefOf({ runId: leafRunId, stepSpanId: args.stepSpanId }),
      );
    }

    /**
     * 一致性守卫：本次清单必须能在**当前可读投影的自有检查点段**里指认到同一条。
     * 定位成功却对不上（记录在两次读取之间被改动、或投影异常）⇒ 拒绝，
     * 不把 A 包的清单和本次投影的身份拼成一份混合来源的结果（design D3/D6）。
     */
    const ownItems = ownCheckpointItems(detail, new Set(detail.leafSpanIds));
    const matched = ownCheckpointOf(ownItems, located.result.stepSpanId);
    if (matched === undefined || matched.snapshotId !== located.result.snapshotId) {
      throw new ToolFailure(
        "RUN_INVALID",
        locateRefOf({
          runId: leafRunId,
          stepSpanId: located.result.stepSpanId ?? undefined,
        }),
      );
    }

    const checkpoint = projectCheckpointHead(located.result);
    const window = takeWindow(located.result.files, args.limit);
    const items = window.items.map(projectCheckpointFile);
    const summary = chainSummaries[chainSummaries.length - 1];
    if (summary === undefined) {
      throw new ToolFailure("RUN_INVALID", `run:${leafRunId}`);
    }
    const sealed = outcomeTagOf(summary).sealed;

    const data = InspectCheckpointDataSchema.parse({
      checkpoint,
      files: items,
      totals: {
        files: checkpoint.fileCount,
        listed: items.length,
        remaining: window.remaining,
        limit: args.limit ?? PAGE_LIMIT_DEFAULT,
      },
    });

    const runs = provenanceRunsOf(detail, chainSummaries);
    if (runs === null) {
      throw new ToolFailure("RUN_INVALID", `run:${leafRunId}`);
    }

    const limitations: LimitationInput[] = [];
    if (items.length > 0) {
      limitations.push({
        code: "BODY_NOT_EXPOSED",
        ref: `snapshot:${checkpoint.snapshotId}`,
        message:
          "清单只给路径、字节、哈希与附件可用性：正文需用 read_checkpoint_file 显式指定 path",
      });
    }
    if (!sealed) {
      limitations.push({
        code: "TERMINATION_NOT_RECORDED",
        ref: `run:${leafRunId}`,
        message: "没有终止事件：清单只到已落盘的记录为止，不能据此判断该运行仍在进行",
      });
    }

    const refs: ProvenanceRefInput[] = [
      {
        runId: leafRunId,
        ...(checkpoint.stepSpanId === null ? {} : { stepSpanId: checkpoint.stepSpanId }),
        snapshotId: checkpoint.snapshotId,
      },
    ];

    return {
      readVersion,
      data,
      truncated: window.truncated,
      runs,
      refs,
      limitations,
      headline: [
        `inspect_checkpoint：${checkpoint.stepSpanId === null ? "初始快照" : `步骤 ${checkpoint.stepSpanId}`}`,
        `${checkpoint.fileCount} 个文件 / ${checkpoint.totalBytes} 字节`,
        checkpoint.unavailableCount > 0
          ? `${checkpoint.unavailableCount} 个附件不可用`
          : "附件全部可用",
        window.truncated ? `本页 ${items.length} 条，尚有 ${window.remaining} 条` : "清单已列全",
      ].join(" / "),
    };
  },
);
