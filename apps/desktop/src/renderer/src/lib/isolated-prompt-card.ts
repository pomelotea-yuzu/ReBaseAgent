import type {
  IsolatedPromptCapabilityRequest,
  IsolatedPromptCapabilityResult,
  IsolatedPromptEdit,
  IsolatedPromptForkRequest,
} from "@shared/ipc";
import { formatBytes } from "./format";

/**
 * R2.2 6.2：隔离 prompt 实验的**只读核对卡**与**提交判据**（纯函数）。
 *
 * 三条纪律与普通 prompt fork 同源，但多两处硬约束：
 * 1. 卡上的根/初始文件/模型/参数/端点/上限/未知项全部来自 main 的
 *    `workspaces:isolatedPromptCapability`；渲染层不自己数文件、不自己推模型；
 * 2. 费用确认与副本写入授权**默认都未选**，且绑定当前草稿修订 + 设置快照 +
 *    计划指纹；任何一项变化都让旧核对/旧许可失效（判据见 `isolatedPromptSubmitBlock`）；
 * 3. 历史未录制条件与真实计费分开表达：未知就是未知，不补零、不把设置模型
 *    冒充成基线模型，也不自动判定实验成功。
 */

export type IsolatedPromptCapabilitySuccess = Extract<
  IsolatedPromptCapabilityResult,
  { status: "ok" }
>;

export interface IsolatedPromptCardRow {
  readonly label: string;
  readonly value: string;
}

export interface IsolatedPromptCardView {
  /** 收起态仍可见的一句话（费用 / 初始文件 / 写入范围） */
  readonly summary: string;
  readonly rows: readonly IsolatedPromptCardRow[];
  /** 历史未录制条件的可读文案（空数组 = 没有未知项） */
  readonly unknowns: readonly string[];
  /** 真实计费边界（执行前未知；不得用 0 冒充） */
  readonly billing: string;
}

const UNKNOWN_LABELS = {
  provider_backend: "服务端实际后端/版本未录制（不能声称严格因果对照）",
  max_iterations: "历史迭代上限未录制（本次使用当前上限）",
  token_budget: "历史 token 预算未录制（本次使用当前预算）",
} as const;

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

function paramsLabel(params: IsolatedPromptCapabilitySuccess["execution"]["params"]): string {
  if (params === undefined) return "缺省（根首次请求未录制 params）";
  return Object.keys(params).length === 0 ? "显式空对象 {}" : JSON.stringify(params);
}

function budgetLabel(execution: IsolatedPromptCapabilitySuccess["execution"]): string {
  const cost =
    execution.budget.maxCost === undefined ? "" : ` / 成本上限 ${execution.budget.maxCost}`;
  const source = execution.tokenBudgetSource === "recorded" ? "根录制值" : "当前配置";
  return `${execution.budget.maxTotalTokens} tokens（${source}）${cost}`;
}

/** 把 capability 结论排版成核对卡（组件只渲染，不再写第二套判据） */
export function presentIsolatedPromptCard(
  capability: IsolatedPromptCapabilitySuccess,
  tools: readonly string[],
): IsolatedPromptCardView {
  const unknowns = capability.execution.historicalUnknowns.map((key) => UNKNOWN_LABELS[key]);
  const toolLabel =
    tools.length === 0
      ? "（根首次请求未录制工具表）"
      : `${tools.join("、")}（profile 由 main 固定）`;
  return {
    summary: `从根 ${capability.rootId} 的初始文件（${capability.fileCount} 个 / ${formatBytes(
      capability.totalBytes,
    )}）与启动指令重跑；真实模型调用并计费，usage/价格/缓存执行前未知；副本只写独立世界。`,
    rows: [
      { label: "根运行", value: capability.rootId },
      { label: "启动调用", value: capability.baselineLlmSpanId },
      {
        label: "初始文件",
        value: `${capability.fileCount} 个 / ${formatBytes(capability.totalBytes)} · 快照 ${shortId(
          capability.initialSnapshotId,
        )}`,
      },
      {
        label: "有效启动消息",
        value: `${capability.messages.length} 条（${capability.messages
          .map((message) => message.role)
          .join(" / ")}）`,
      },
      { label: "固定工具", value: toolLabel },
      { label: "基线模型（根首次请求）", value: capability.execution.model },
      { label: "根参数", value: paramsLabel(capability.execution.params) },
      { label: "本次端点", value: capability.execution.providerEndpoint },
      { label: "执行上限", value: `${capability.execution.maxIterations} 轮` },
      { label: "token 预算", value: budgetLabel(capability.execution) },
      {
        label: "编辑",
        value: `${capability.originalValue.length} 字 → ${capability.editedValue.length} 字（逐字差异见上方核对网格）`,
      },
      { label: "历史未知条件", value: unknowns.length === 0 ? "无" : unknowns.join("；") },
      {
        label: "真实计费",
        value: "执行前 usage/单价/缓存未知；执行后按实际记录呈现，未知不补零",
      },
      { label: "计划指纹", value: shortId(capability.planFingerprint) },
      { label: "副本写入", value: "仅写入本次新副本的独立文件世界；父/兄弟/源目录不修改" },
    ],
    unknowns,
    billing: "真实模型调用并计费；usage、单价与缓存命中在执行前未知，执行后按实际记录呈现。",
  };
}

function noteFields(
  hypothesis: string,
  acceptanceCriterion: string,
): { hypothesis?: string; acceptanceCriterion?: string } {
  return {
    ...(hypothesis === "" ? {} : { hypothesis }),
    ...(acceptanceCriterion === "" ? {} : { acceptanceCriterion }),
  };
}

/** 只读预检请求：不含模型/端点/key/授权，main 从根事实与当前配置重建 */
export function isolatedPromptCapabilityRequestOf(input: {
  readonly rootRunId: string;
  readonly edit: IsolatedPromptEdit;
  readonly hypothesis: string;
  readonly acceptanceCriterion: string;
}): IsolatedPromptCapabilityRequest {
  return {
    rootRunId: input.rootRunId,
    edit: input.edit,
    ...noteFields(input.hypothesis, input.acceptanceCriterion),
  };
}

export interface IsolatedPromptSubmissionInput {
  readonly rootRunId: string;
  readonly edit: IsolatedPromptEdit;
  /** 根首次请求里的原值（来自已校验详情） */
  readonly originalValue: string;
  readonly hypothesis: string;
  readonly acceptanceCriterion: string;
  /** 当前有效的只读核对结论；null = 尚未核对 / 已失效 */
  readonly capability: IsolatedPromptCapabilitySuccess | null;
  /** 核对结论是否仍与当前草稿修订 + 设置快照 + 计划指纹同源 */
  readonly capabilityFresh: boolean;
  /** 费用确认（默认未选，绑当前现场） */
  readonly feeConfirmed: boolean;
  /** 本次副本写入授权（默认未选，绑当前现场） */
  readonly writesAuthorized: boolean;
  readonly checking: boolean;
  readonly inProgress: boolean;
  /** 统一操作槽/本地提交的阻止原因（来自 deriveEntryGate） */
  readonly gateBlockedReason: string | null;
  /** 本地字段判据（isolatedPromptGuard） */
  readonly guardCanSubmit: boolean;
  readonly guardReason: string | null;
}

export type IsolatedPromptSubmission =
  | { readonly ok: true; readonly request: IsolatedPromptForkRequest }
  | { readonly ok: false; readonly reason: string };

/**
 * 「确认开始实验」的判据 + 请求（同源）：任何一条不满足都不产出请求，
 * 不可能发出半截请求（漏配置修订 / 漏计划指纹 / 漏本次授权）。
 */
export function resolveIsolatedPromptSubmission(
  input: IsolatedPromptSubmissionInput,
): IsolatedPromptSubmission {
  if (input.inProgress) return { ok: false, reason: "提交进行中：不能重复提交" };
  if (input.checking) return { ok: false, reason: "正在核对本次运行…" };
  if (!input.guardCanSubmit) {
    return { ok: false, reason: input.guardReason ?? "本次编辑尚不满足隔离实验条件" };
  }
  if (input.capability === null || !input.capabilityFresh) {
    return {
      ok: false,
      reason: "请先点击「核对本次运行」完成只读预检；输入或配置变化后必须重新核对",
    };
  }
  if (
    input.capability.rootId !== input.rootRunId ||
    input.capability.originalValue !== input.originalValue ||
    input.capability.editedValue !== input.edit.value
  ) {
    return { ok: false, reason: "核对结论与当前根/原值/新值不一致，请重新核对" };
  }
  if (!input.feeConfirmed) {
    return {
      ok: false,
      reason: "请先确认本次从头执行会真实调用模型并计费（费用确认不随草稿恢复）",
    };
  }
  if (!input.writesAuthorized) {
    return {
      ok: false,
      reason: "请勾选「允许本次副本写入」——授权只对这一次提交有效，不从父 trace 补授权",
    };
  }
  if (input.gateBlockedReason !== null) {
    return { ok: false, reason: input.gateBlockedReason };
  }
  return {
    ok: true,
    request: {
      executionMode: "isolated",
      parentRunId: input.rootRunId,
      edit: input.edit,
      allowFileWrites: true,
      expectedConfigRevision: input.capability.configRevision,
      expectedPlanFingerprint: input.capability.planFingerprint,
      ...noteFields(input.hypothesis, input.acceptanceCriterion),
    },
  };
}
