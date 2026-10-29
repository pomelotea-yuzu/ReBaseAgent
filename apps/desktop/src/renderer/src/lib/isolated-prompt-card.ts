import type { Translator } from "@rebaseagent/i18n";
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

function unknownLabel(key: string, translator: Translator): string {
  switch (key) {
    case "provider_backend":
      return translator.t("fork.cardUnknownProvider");
    case "max_iterations":
      return translator.t("fork.cardUnknownIterations");
    case "token_budget":
      return translator.t("fork.cardUnknownBudget");
    default:
      // 未知类别是记录事实本身：保留原键名，不编造解释
      return key;
  }
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

function paramsLabel(
  params: IsolatedPromptCapabilitySuccess["execution"]["params"],
  translator: Translator,
): string {
  if (params === undefined) return translator.t("fork.cardParamsMissing");
  return Object.keys(params).length === 0
    ? translator.t("fork.cardParamsEmpty")
    : JSON.stringify(params);
}

function budgetLabel(
  execution: IsolatedPromptCapabilitySuccess["execution"],
  translator: Translator,
): string {
  const cost =
    execution.budget.maxCost === undefined
      ? ""
      : translator.t("fork.cardCostCap", { value: execution.budget.maxCost });
  const source = translator.t(
    execution.tokenBudgetSource === "recorded"
      ? "fork.cardBudgetRecorded"
      : "fork.cardBudgetCurrent",
  );
  return translator.t("fork.cardBudgetValue", {
    tokens: execution.budget.maxTotalTokens,
    source,
    cost,
  });
}

/** 把 capability 结论排版成核对卡（组件只渲染，不再写第二套判据） */
export function presentIsolatedPromptCard(
  capability: IsolatedPromptCapabilitySuccess,
  tools: readonly string[],
  translator: Translator,
): IsolatedPromptCardView {
  const unknowns = capability.execution.historicalUnknowns.map((key) =>
    unknownLabel(key, translator),
  );
  const toolLabel =
    tools.length === 0
      ? translator.t("fork.cardToolMissing")
      : translator.t("fork.cardToolList", {
          tools: tools.join(translator.t("fork.listSeparator")),
        });
  return {
    summary: translator.t("fork.cardSummary", {
      rootId: capability.rootId,
      files: translator.t("fork.cardFileCount", { count: capability.fileCount }),
      bytes: formatBytes(capability.totalBytes),
    }),
    rows: [
      { label: translator.t("fork.cardRoot"), value: capability.rootId },
      { label: translator.t("fork.cardStartCall"), value: capability.baselineLlmSpanId },
      {
        label: translator.t("fork.cardInitialFiles"),
        value: translator.t("fork.cardFilesValue", {
          count: capability.fileCount,
          bytes: formatBytes(capability.totalBytes),
          snapshot: shortId(capability.initialSnapshotId),
        }),
      },
      {
        label: translator.t("fork.cardMessages"),
        value: translator.t("fork.cardMessagesValue", {
          count: capability.messages.length,
          roles: capability.messages.map((message) => message.role).join(" / "),
        }),
      },
      { label: translator.t("fork.cardTools"), value: toolLabel },
      { label: translator.t("fork.cardBaselineModel"), value: capability.execution.model },
      {
        label: translator.t("fork.cardParams"),
        value: paramsLabel(capability.execution.params, translator),
      },
      { label: translator.t("fork.cardEndpoint"), value: capability.execution.providerEndpoint },
      {
        label: translator.t("fork.cardMaxIterations"),
        value: translator.t("fork.cardMaxIterationsValue", {
          count: capability.execution.maxIterations,
        }),
      },
      {
        label: translator.t("fork.cardTokenBudget"),
        value: budgetLabel(capability.execution, translator),
      },
      {
        label: translator.t("fork.cardEdit"),
        value: translator.t("fork.cardEditValue", {
          old: capability.originalValue.length,
          new: capability.editedValue.length,
        }),
      },
      {
        label: translator.t("fork.cardUnknowns"),
        value:
          unknowns.length === 0
            ? translator.t("fork.cardUnknownNone")
            : unknowns.join(translator.t("fork.unknownSeparator")),
      },
      {
        label: translator.t("fork.cardBillingLabel"),
        value: translator.t("fork.cardBillingValue"),
      },
      {
        label: translator.t("fork.cardPlanFingerprint"),
        value: shortId(capability.planFingerprint),
      },
      { label: translator.t("fork.cardWrites"), value: translator.t("fork.cardWritesValue") },
    ],
    unknowns,
    billing: translator.t("fork.cardBilling"),
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
  translator: Translator,
): IsolatedPromptSubmission {
  if (input.inProgress) return { ok: false, reason: translator.t("fork.submitInProgress") };
  if (input.checking) return { ok: false, reason: translator.t("fork.isoChecking") };
  if (!input.guardCanSubmit) {
    return {
      ok: false,
      reason: input.guardReason ?? translator.t("fork.submitGuardMissing"),
    };
  }
  if (input.capability === null || !input.capabilityFresh) {
    return { ok: false, reason: translator.t("fork.submitNeedsCheck") };
  }
  if (
    input.capability.rootId !== input.rootRunId ||
    input.capability.originalValue !== input.originalValue ||
    input.capability.editedValue !== input.edit.value
  ) {
    return { ok: false, reason: translator.t("fork.submitCheckMismatch") };
  }
  if (!input.feeConfirmed) {
    return { ok: false, reason: translator.t("fork.submitNeedsFee") };
  }
  if (!input.writesAuthorized) {
    return { ok: false, reason: translator.t("fork.submitNeedsWrites") };
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
