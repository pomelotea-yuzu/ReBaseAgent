import type { SpanLine } from "@rebaseagent/trace-sdk";
import type {
  ForkCapabilityRequest,
  ForkCapabilityResult,
  ForkRunRequest,
  RunDetail,
} from "@shared/ipc";
import { formatBytes } from "./format";

/**
 * 隔离续跑（result 分叉）在渲染层的纯逻辑（B 任务 2.2）。
 *
 * 三条纪律：
 *
 * 1. **确认区的数字全部来自 main 的只读预检**（`workspaces:forkCapability` → A 的
 *    `preflightIsolatedReplay`）。渲染层不自己数文件、不自己推轮号、不自己比对哈希——
 *    它只把预检结论排版出来。**没有预检结果就不让提交**（`capability === null` 即拦）。
 * 2. **判据与请求同源**：`resolveIsolatedForkSubmission` 一次给出"能否提交 + 提交什么"，
 *    与「确认重跑」按钮的禁用判据是同一个函数（沿用 2.1 的 `create-run.ts` 做法）。
 * 3. **本次授权必须显式**：`execution` 只在本次勾选后出现在请求里；不勾选时请求**连
 *    `execution` 键都没有**（main 会按普通 result 分叉处理并被隔离父本门禁拒——
 *    宁可让用户看到拒绝，也不从历史 `workspace.write_authorized` 补授权）。
 *
 * ⚠️ 本层是**早拦层，不是权威判据**：父链、封存、工具表、附件哈希、配额等只在
 * A 包与 main 里判。渲染层放行只表示"本层没有理由拦你"。
 */

/** 隔离运行的判据：v2 且带 `meta.workspace`（v1 老 trace 一律没有，也不得冒充） */
export function isIsolatedRun(run: RunDetail | null): boolean {
  return run !== null && run.meta.workspace !== undefined;
}

/**
 * 隔离父本本期不支持的执行入口（prompt fork / 模型 A/B）的可展示原因。
 * 返回 null = 不是隔离父本（按既有可用性判据走）。
 *
 * 内核同样拒绝这类请求（`loadForkParent` 的隔离门禁，见 `isolated-parent-rejection.test.ts`），
 * 所以这是"把界面与内核对齐"，不是新增一条只有界面认的规则。
 */
export function isolatedParentExecutionNotice(run: RunDetail | null): string | null {
  if (!isIsolatedRun(run)) return null;
  return "该运行是隔离文件运行：它的续跑只能从工具结果的轮末检查点出发（下方「在此重跑」），prompt fork 与模型 A/B 本期不支持隔离父本——即使绕过界面发 IPC，main 与内核也会拒绝。";
}

/** 隔离运行的详情标注（明确标注"文件隔离"，并说明世界从哪来；v1 老 trace 返回 null） */
export function isolatedRunNotice(run: RunDetail | null): string | null {
  const workspace = run?.meta.workspace;
  if (workspace === undefined) return null;
  const origin =
    workspace.origin.kind === "import"
      ? `独立文件世界（world_id ${workspace.world_id}），由选定源目录采集而来`
      : `从运行 ${workspace.origin.run_id} 的检查点续跑而来`;
  return `隔离文件运行 · profile ${workspace.profile} · ${origin}。文件读写只发生在独立世界里：源目录、父分支与兄弟分支都不会被修改；页面不会把本 run 显示成"已恢复历史磁盘状态"。`;
}

/** 只读预检请求（与 `ForkCapabilityRequestSchema` 同形） */
export function forkCapabilityRequest(
  parentRunId: string,
  atSpanId: string,
  value: string,
): ForkCapabilityRequest {
  return { parentRunId, atSpanId, edit: { field: "result", value } };
}

/** 「从运行 X 的第 N 轮结束后继续」——轮号取所属 run 自己的 `agent.step.n`，不沿链累加 */
export function isolatedContinueLabel(capability: ForkCapabilityResult): string {
  return `从运行 ${capability.parentId} 的第 ${capability.localIteration} 轮结束后继续`;
}

/** 轮末检查点一行：裸 64 位 hex 指纹只露前 12 位（完整值在轨迹里，界面不铺长串） */
export function isolatedCheckpointLabel(capability: ForkCapabilityResult): string {
  return `轮末检查点 ${capability.snapshotId.slice(0, 12)}… · ${capability.fileCount} 个文件 / ${formatBytes(
    capability.totalBytes,
  )}`;
}

/**
 * 续跑边界的本地轮号：从**子运行详情的拼接轨迹**里按 id 找到边界 step，读它的 `n`。
 *
 * 为什么能这么读：`resume_after_step` 必须指向**直接父 run 自有记录**里的一个 `agent.step`
 * （`trace-sdk/src/branch.ts` 明文校验），而子运行的合并轨迹包含父 run 的前缀段，
 * 因此这个 step 一定在 `spans` 里；它的 `n` 就是父 run 的**本地**轮号。
 * 解析不到时返回 null（不猜数字，界面降级为只报 step span）。
 */
export function resumeBoundaryIteration(
  spans: readonly SpanLine[],
  resumeAfterStep: string,
): number | null {
  const step = spans.find((span) => span.id === resumeAfterStep);
  if (step === undefined || step.kind !== "agent.step") return null;
  return step.n;
}

/**
 * 隔离**分支**的来源说明（子运行详情页顶部）：边界是父 run 该轮的轮末，轮号取该 step
 * 自己的 `agent.step.n`；解析不到时只报 step，绝不猜一个"看起来对"的轮号。
 */
export function isolatedBranchBoundaryLabel(
  parentRunId: string,
  iteration: number | null,
  resumeAfterStep: string,
): string {
  return iteration === null
    ? `从运行 ${parentRunId} 的那一轮结束后继续（本地轮号未能在轨迹中解析，此处只报 step ${resumeAfterStep}）`
    : `从运行 ${parentRunId} 的第 ${iteration} 轮结束后继续（整轮续跑：该轮工具不重做）`;
}

export interface CapabilityCheckInput {
  parentRunId: string;
  atSpanId: string;
  /** 当前编辑值（预检要判"编辑可派生"，空 fork 在预检阶段就会被拒） */
  value: string;
  /** 编辑值是否与父 run 录制的 result 相同（空 fork） */
  unchanged: boolean;
  settingsConfigured: boolean;
  /** 预检请求在飞 */
  capabilityInFlight: boolean;
  /** runs:fork 在飞 */
  forking: boolean;
}

export type CapabilityCheck =
  | { ok: true; request: ForkCapabilityRequest }
  | { ok: false; reason: string };

/** 「校验续跑条件」按钮的判据 + 请求（同源） */
export function resolveCapabilityCheck(input: CapabilityCheckInput): CapabilityCheck {
  if (input.forking) return { ok: false, reason: "重跑进行中：不能再发起校验" };
  if (input.capabilityInFlight) return { ok: false, reason: "正在校验续跑条件…" };
  if (!input.settingsConfigured) {
    return {
      ok: false,
      reason: "尚未配置运行参数（baseURL / apiKey / model），请先点击右上角“运行配置”",
    };
  }
  if (input.unchanged) {
    return { ok: false, reason: "编辑值与原始结果相同（空 fork 会被拒绝），请修改后再校验" };
  }
  return {
    ok: true,
    request: forkCapabilityRequest(input.parentRunId, input.atSpanId, input.value),
  };
}

export interface IsolatedForkSubmissionInput extends CapabilityCheckInput {
  /** 已通过只读预检的结论；null = 尚未校验（或编辑后又作废了） */
  capability: ForkCapabilityResult | null;
  /** 本次是否勾选了副本写入授权 */
  writesAuthorized: boolean;
}

export type IsolatedForkSubmission =
  | { ok: true; request: ForkRunRequest }
  | { ok: false; reason: string };

/**
 * 「确认重跑」的判据 + 请求（同源）：任何一条不满足都不产出请求 ⇒ 不可能发出半截请求。
 * 未授权时**不产出 `execution` 键**的那条分支刻意不存在——未授权直接拒绝，不给"降级成
 * 普通分叉"的机会（隔离父本降级会被内核拒，用户只会看到一个更难懂的错误）。
 */
export function resolveIsolatedForkSubmission(
  input: IsolatedForkSubmissionInput,
): IsolatedForkSubmission {
  if (input.forking) return { ok: false, reason: "重跑进行中：不能重复提交" };
  if (input.capabilityInFlight) return { ok: false, reason: "正在校验续跑条件…" };
  if (!input.settingsConfigured) {
    return {
      ok: false,
      reason: "尚未配置运行参数（baseURL / apiKey / model），请先点击右上角“运行配置”",
    };
  }
  if (input.unchanged) {
    return { ok: false, reason: "编辑值与原始结果相同（空 fork 会被拒绝），请修改后再重跑" };
  }
  if (input.capability === null) {
    return { ok: false, reason: "请先点击「校验续跑条件」完成只读预检（确定检查点与轮末边界）" };
  }
  // 预检结论必须与当前分叉点同源：换了 span / 换了父 = 旧结论作废
  if (
    input.capability.atSpanId !== input.atSpanId ||
    input.capability.parentId !== input.parentRunId
  ) {
    return { ok: false, reason: "预检结论与当前分叉点不一致，请重新校验续跑条件" };
  }
  if (!input.writesAuthorized) {
    return {
      ok: false,
      reason:
        "请勾选「允许本次副本写入」——授权只对这一次提交有效，不会从父 run 的 write_authorized 标注补授权",
    };
  }
  return {
    ok: true,
    request: {
      parentRunId: input.parentRunId,
      atSpanId: input.atSpanId,
      edit: { field: "result", value: input.value },
      execution: { mode: "isolated_files", allowFileWrites: true },
    },
  };
}
