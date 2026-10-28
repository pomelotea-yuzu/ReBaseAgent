import type { Translator } from "@rebaseagent/i18n";
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
 * 隔离父本本期的模型 A/B 门禁说明。
 *
 * R2.2 6.1 起 prompt 启动指令实验**已支持隔离根**（独立初始快照入口），
 * 因此本说明只表达 A/B 仍不支持；prompt 的根/分支入口由
 * `lib/isolated-prompt.ts` 单独裁决，不能再用一段“prompt 与 A/B 都不支持”的
 * 合并文案把新能力一起禁掉。
 *
 * 内核同样拒绝这类请求（`loadForkParent` 的隔离门禁），所以这是"把界面与内核
 * 对齐"，不是新增一条只有界面认的规则。
 */
export function isolatedParentExecutionNotice(
  run: RunDetail | null,
  translator: Translator,
): string | null {
  if (!isIsolatedRun(run)) return null;
  return translator.t("run.isoParentExecutionNotice");
}

/** 隔离运行的详情标注（明确标注"文件隔离"，并说明世界从哪来；v1 老 trace 返回 null） */
export function isolatedRunNotice(run: RunDetail | null, translator: Translator): string | null {
  const workspace = run?.meta.workspace;
  if (workspace === undefined) return null;
  const origin =
    workspace.origin.kind === "import"
      ? translator.t("run.isoOriginImport", { worldId: workspace.world_id })
      : workspace.origin.kind === "initial"
        ? translator.t("run.isoOriginInitial", { runId: workspace.origin.run_id })
        : translator.t("run.isoOriginCheckpoint", { runId: workspace.origin.run_id });
  return translator.t("run.isoNotice", { profile: workspace.profile, origin });
}

/**
 * 隔离说明的**分层视图**（UI 密度 change 任务 1.3 · design D2）。
 *
 * 为什么拆：`isolatedRunNotice` 的整段文字此前同时出现在运行页头（RunHeaderView）
 * 与详情提示区（DetailNotices）⇒ 同屏重复同一长段落（2026-10-06 实机评审抓到的
 * 「文件页重复显示隔离说明」）。分层后：
 * - `compact`：页头/提示区**常驻一行**的紧凑摘要——身份 + 来源可辨（delta
 *   「当前来源身份…SHALL 保持可见」的落点）；
 * - `detail`：完整保真边界（只在「来源与技术详情」展开时渲染，同屏最多一份）；
 * - `tech`：profile / world_id / 来源 run 等技术值（可完整阅读/复制，不铺在正文）。
 *
 * v1 老 trace（无 `meta.workspace`）返回 null——不得把老记录显示成隔离（既有纪律）。
 */
export interface IsolatedRunNoticeView {
  /** 常驻紧凑摘要（一行）：身份 + 来源 */
  readonly compact: string;
  /** 完整保真边界（展开区内容；含 compact 未重复的只读承诺） */
  readonly detail: string;
  /** 技术值（展开区里逐项呈现，可复制原值） */
  readonly tech: readonly { readonly label: string; readonly value: string }[];
}

export function isolatedRunNoticeView(
  run: RunDetail | null,
  translator: Translator,
): IsolatedRunNoticeView | null {
  const workspace = run?.meta.workspace;
  if (workspace === undefined) return null;
  const originCompact =
    workspace.origin.kind === "import"
      ? translator.t("run.isoOriginImportCompact")
      : workspace.origin.kind === "initial"
        ? translator.t("run.isoOriginInitialCompact", { runId: workspace.origin.run_id })
        : translator.t("run.isoOriginCheckpointCompact", { runId: workspace.origin.run_id });
  const originFull =
    workspace.origin.kind === "import"
      ? translator.t("run.isoOriginImport", { worldId: workspace.world_id })
      : workspace.origin.kind === "initial"
        ? translator.t("run.isoOriginInitialFull", { runId: workspace.origin.run_id })
        : translator.t("run.isoOriginCheckpoint", { runId: workspace.origin.run_id });
  return {
    compact: translator.t("run.isoCompact", { origin: originCompact }),
    detail: translator.t("run.isoDetail"),
    tech: [
      { label: "profile", value: workspace.profile },
      { label: "world_id", value: workspace.world_id },
      {
        label: "origin",
        value:
          workspace.origin.kind === "import"
            ? translator.t("run.isoOriginImportTech")
            : workspace.origin.kind === "initial"
              ? translator.t("run.isoOriginInitialTech", {
                  runId: workspace.origin.run_id,
                  snapshotId: workspace.origin.snapshot_id,
                })
              : translator.t("run.isoOriginCheckpointTech", {
                  runId: workspace.origin.run_id,
                  span: workspace.origin.step_span,
                }),
      },
      { label: translator.t("run.isoOriginLabel"), value: originFull },
    ],
  };
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
export function isolatedContinueLabel(
  capability: ForkCapabilityResult,
  translator: Translator,
): string {
  return translator.t("run.isoContinueLabel", {
    runId: capability.parentId,
    iteration: capability.localIteration,
  });
}

/** 轮末检查点一行：裸 64 位 hex 指纹只露前 12 位（完整值在轨迹里，界面不铺长串） */
export function isolatedCheckpointLabel(
  capability: ForkCapabilityResult,
  translator: Translator,
): string {
  return translator.t("run.isoCheckpointLabel", {
    snapshot: capability.snapshotId.slice(0, 12),
    count: capability.fileCount,
    bytes: formatBytes(capability.totalBytes),
  });
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
  translator: Translator,
): string {
  return iteration === null
    ? translator.t("run.isoBranchBoundaryNoIteration", {
        runId: parentRunId,
        span: resumeAfterStep,
      })
    : translator.t("run.isoBranchBoundaryIteration", {
        runId: parentRunId,
        iteration,
      });
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
export function resolveCapabilityCheck(
  input: CapabilityCheckInput,
  translator: Translator,
): CapabilityCheck {
  if (input.forking) return { ok: false, reason: translator.t("run.checkBusy") };
  if (input.capabilityInFlight)
    return { ok: false, reason: translator.t("run.checkingConditions") };
  if (!input.settingsConfigured) {
    return {
      ok: false,
      reason: translator.t("run.settingsRequiredForFork"),
    };
  }
  if (input.unchanged) {
    return {
      ok: false,
      reason: translator.t("run.checkUnchanged"),
    };
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
  translator: Translator,
): IsolatedForkSubmission {
  if (input.forking) return { ok: false, reason: translator.t("run.submitBusyFork") };
  if (input.capabilityInFlight)
    return { ok: false, reason: translator.t("run.checkingConditions") };
  if (!input.settingsConfigured) {
    return {
      ok: false,
      reason: translator.t("run.settingsRequiredForFork"),
    };
  }
  if (input.unchanged) {
    return {
      ok: false,
      reason: translator.t("run.submitUnchanged"),
    };
  }
  if (input.capability === null) {
    return { ok: false, reason: translator.t("run.checkRequired") };
  }
  // 预检结论必须与当前分叉点同源：换了 span / 换了父 = 旧结论作废
  if (
    input.capability.atSpanId !== input.atSpanId ||
    input.capability.parentId !== input.parentRunId
  ) {
    return { ok: false, reason: translator.t("run.checkMismatch") };
  }
  if (!input.writesAuthorized) {
    return {
      ok: false,
      reason: translator.t("run.writesRequiredFork"),
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
