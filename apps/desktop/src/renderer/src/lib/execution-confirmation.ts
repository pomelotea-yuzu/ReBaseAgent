import type { Translator } from "@rebaseagent/i18n";
import type { ModelAbResult, ModelArmPlan, ProxyState, SettingsState } from "@shared/ipc";
import type { DraftSubmitChannel, DraftSubmitTarget } from "./draft-submission";
import { submissionIdOf } from "./draft-submission";
import { forkCacheHint } from "./fork-cache-hint";

/**
 * U5（unify-run-execution-workflow）任务 4.4–4.7：**执行前检查与确认**的纯判据（design D2 +
 * delta「执行前检查和确认保持各入口真实语义」）。
 *
 * 一句话概括要解决的问题：旧实现里"确认"就是提交按钮旁的一句话或一次 `window.confirm`，
 * 它不绑任何东西——用户改完输入、换过设置、重跑过一次之后，那句确认还"有效"。
 * 本模块把它变成一份**有绑定的凭据**：
 *
 * - 确认记录绑 **目标 + 草稿修订 + 设置快照 + 检查代次**，四者任一变化即失效；
 * - 失效不靠"记得去清"，靠**现算比对**（`decideConfirmation`）：只要当前现场与记录不一致就是
 *   `stale`，所以任何一条改动路径漏了清理也不会留下假确认；
 * - 确认态展示的"检查"只能是**确实做过的事**：本地字段判据、真实发出的只读请求；
 *   没有独立预检接口的入口必须直说"正式校验发生在提交时（由 main 判定）"——
 *   不显示采集预览、不显示"目录检查通过"、不显示上游连通（这些接口仓库里根本没有）。
 *
 * ⚠️ 这份凭据**不授予执行资格**：门禁（U4 的统一操作槽）与 main 的重复校验照旧各自生效，
 * 确认只是"用户已核对本次目标与边界"的会话内事实。它也**不进**草稿、IPC、日志或持久化。
 */

/** 一次确认所绑定的现场（四个分量任一变化 ⇒ 旧确认不可复用） */
export interface ConfirmationBinding {
  readonly channel: DraftSubmitChannel;
  /** 提交目标；键编码复用 `draft-submission` 的唯一入口，不存在第二份 */
  readonly target: DraftSubmitTarget;
  /** 确认那一刻的草稿修订（A/B 是整批修订） */
  readonly revision: number;
  /** 设置快照指纹（见 `settingsStampOf`） */
  readonly settingsStamp: string;
  /** 检查代次：只读检查每重新启动一次就推进，旧响应不得安装新确认 */
  readonly generation: number;
}

/** 会话内已给出的确认 */
export interface ExecutionConfirmation extends ConfirmationBinding {
  readonly targetKey: string;
}

export interface ConfirmationStore {
  readonly byTargetKey: Readonly<Record<string, ExecutionConfirmation>>;
}

export function emptyConfirmationStore(): ConfirmationStore {
  return { byTargetKey: {} };
}

export function confirmationTargetKey(target: DraftSubmitTarget): string {
  return submissionIdOf(target);
}

/**
 * 记录/覆盖一次确认（同一目标只留最新一份）。
 *
 * 幂等：现场完全一致时返回原对象，避免无谓的重渲染。
 */
export function armConfirmation(
  store: ConfirmationStore,
  binding: ConfirmationBinding,
): ConfirmationStore {
  const key = confirmationTargetKey(binding.target);
  const current = store.byTargetKey[key];
  if (current !== undefined && sameBinding(current, binding)) return store;
  return { byTargetKey: { ...store.byTargetKey, [key]: { ...binding, targetKey: key } } };
}

/** 撤销一份确认（返回编辑、切换对象、重新执行、设置往返都走这里） */
export function releaseConfirmation(
  store: ConfirmationStore,
  target: DraftSubmitTarget,
): ConfirmationStore {
  const key = confirmationTargetKey(target);
  if (store.byTargetKey[key] === undefined) return store;
  const next = { ...store.byTargetKey };
  delete next[key];
  return { byTargetKey: next };
}

/** 确认判定：只有"现场逐分量相同"才算已确认 */
export type ConfirmationDecision =
  | { readonly kind: "confirmed" }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "stale"; readonly reason: string };

export function decideConfirmation(
  store: ConfirmationStore,
  binding: ConfirmationBinding,
): ConfirmationDecision {
  const stored = store.byTargetKey[confirmationTargetKey(binding.target)];
  if (stored === undefined) {
    return { kind: "missing", reason: "本次目标还没有确认过：先核对下面的目标与执行边界" };
  }
  if (stored.channel !== binding.channel) {
    return { kind: "stale", reason: "提交通道已变化：旧确认作废" };
  }
  if (stored.generation !== binding.generation) {
    return { kind: "stale", reason: "检查已重新进行：那份响应属于上一次检查，不能沿用" };
  }
  if (stored.settingsStamp !== binding.settingsStamp) {
    return {
      kind: "stale",
      reason: "运行配置或凭据已变化：模型、地址、代理目标或捕获的凭据与确认时不同",
    };
  }
  if (stored.revision !== binding.revision) {
    return { kind: "stale", reason: "输入已修改：确认绑的是当时那份修订" };
  }
  return { kind: "confirmed" };
}

function sameBinding(a: ConfirmationBinding, b: ConfirmationBinding): boolean {
  return (
    a.channel === b.channel &&
    a.revision === b.revision &&
    a.settingsStamp === b.settingsStamp &&
    a.generation === b.generation &&
    confirmationTargetKey(a.target) === confirmationTargetKey(b.target)
  );
}

/**
 * 运行配置快照指纹：确认信息里出现过的**运行配置**变了，确认就作废。
 *
 * 只取会影响"这次会打到哪儿、花谁的钱"的字段：模型、baseURL、是否已配置、
 * 代理是否在跑、代理打到哪里（upstream/端口）、以及**凭据捕获版本**。
 *
 * ⚠️ 刻意不含 apiKey 与加密状态——指纹会进日志风险面。tasks 2.2a 之后
 * "key 换了"**在渲染层可观察**了，但观察到的也只是**捕获次数**：
 * `keyCaptureRevision` 是 main 内存里的计数（design D2），不含 key material。
 *
 * 🔴 为什么必须绑 `keyCaptureRevision`（2.2a 的实质修复）：`hasKey` 是布尔，
 * `true → true` 的**凭据更换**在指纹上完全不可见——于是"用旧 key 核对过"这条
 * 确认会一直有效，而这次重发实际花的是新 key 的钱。只绑 `hasKey` 等于
 * 没绑"花谁的钱"。
 *
 * ⚠️ 为什么**不能**用 `revision` 代替它：`revision` 也在监听启停/恢复完成时推进，
 * 拿它当凭据判据会让"开关一次代理"作废所有执行确认（凭据压根没变）。
 *
 * ⚠️ 为什么也不能用 epoch/revision 判断"重复读取"：`proxy:status` 每读一次
 * 都返回同一组语义值，纯函数算出的指纹因此逐字相同 ⇒ **重复只读核对不会撤销
 * 确认**（delta「重复只读核对不撤销未变化的确认」）。
 */
export function settingsStampOf(input: {
  settings: SettingsState | null;
  proxy: ProxyState | null;
}): string {
  const { settings, proxy } = input;
  return [
    settings === null ? "unread" : settings.configured ? "configured" : "unconfigured",
    settings?.model ?? "-",
    settings?.baseURL ?? "-",
    proxy === null ? "proxy-unread" : proxy.running ? "proxy-on" : "proxy-off",
    // 代理目标（2.2a）：running 相同但 upstream/端口换了，重发就打去别处 ⇒ 必须作废。
    // 未运行时这两项无意义（没有可打的upstream），但照样纳入：读到的就是读到的。
    proxy === null ? "-" : `${proxy.upstreamBaseUrl}#${proxy.port}`,
    proxy?.hasKey === true ? "key" : "nokey",
    // 凭据捕获版本（2.2a）：`hasKey` 之外的第二维，同样 true 的 key 更换靠它。
    proxy === null ? "cap-unread" : `cap${proxy.keyCaptureRevision}`,
  ].join("|");
}

/**
 * 模型配置指纹（U5 任务 5.3）：`settingsStampOf` 的**去代理**投影——
 * 设置往返要作废的是"dry-run 计划绑的模型配置"，代理启停/凭据波动**不该**把 A/B
 * 计划连带打掉（delta「代理凭据仍按自身会话规则判断，不由桌面模型密钥替代」）。
 * 同样刻意不含 apiKey 明文与加密方式（单向存储读不回，渲染层观察不到）。
 */
export function modelConfigStampOf(settings: SettingsState | null): string {
  return [
    settings === null ? "unread" : settings.configured ? "configured" : "unconfigured",
    settings?.model ?? "-",
    settings?.baseURL ?? "-",
  ].join("|");
}

/** 计划新鲜度（U5 任务 5.3）：修订推进与配置往返是**两种要分开的失效原因** */
export type PlanFreshness = "fresh" | "revision-stale" | "config-stale";

export function decidePlanFreshness(input: {
  /** 预览成功时记录的批次修订；null = 还没预览 */
  readonly planRevision: number | null;
  readonly draftRevision: number | null;
  /** 预览成功时记录的模型配置指纹；null = 还没预览 */
  readonly planConfigStamp: string | null;
  readonly currentConfigStamp: string;
  /**
   * U8 3.7：预览成功时记录的**已核实配置变化代次**；null/缺省 = 未接入（旧调用方不变）。
   * 已核实保存（含仅轮换 key——model/baseURL 相同、指纹不变的那次保存）与已核实清除
   * 都推进代次 ⇒ 计划作废；普通 `proxy:status` 刷新不推进。回读失败（已保存但状态未知）
   * 同样推进——不能拿"可能还是那台上游"的猜测保住旧计划。
   */
  readonly planSettingsGeneration?: number | null;
  readonly currentSettingsGeneration?: number;
}): PlanFreshness {
  if (input.planConfigStamp === null || input.planRevision === null) return "revision-stale";
  // 配置先判：它是"这次计划要打到哪儿"的前提，比修订更值得先说
  if (input.planConfigStamp !== input.currentConfigStamp) return "config-stale";
  if (
    input.planSettingsGeneration != null &&
    input.planSettingsGeneration !== input.currentSettingsGeneration
  ) {
    return "config-stale";
  }
  if (input.planRevision !== input.draftRevision) return "revision-stale";
  return "fresh";
}

// ---------------------------------------------------------------------------
// 确认态的展示内容（每个入口一份，全部由事实拼出）
// ---------------------------------------------------------------------------

/** 一行可核对的事实 */
export interface ConfirmationRow {
  readonly label: string;
  readonly value: string;
}

/**
 * 一个入口的确认披露：`facts` 是本次目标与输入，`checks` 是**确实做过**的检查，
 * `limits` 是这次执行边界的诚实说明（含"本入口没有独立预检接口"这一类）。
 */
export interface ConfirmationDisclosure {
  /**
   * 收起态仍可见的关键摘要（UI 密度 3.1/3.2 · design D4）：一句话说清本次的
   * 费用与工具/文件副作用——详细边界收进可展开区域后，摘要不能跟着消失。
   */
  readonly summary: string;
  readonly facts: readonly ConfirmationRow[];
  readonly checks: readonly string[];
  readonly limits: readonly string[];
}

/** 截断长文本用于确认行（确认要的是"是哪一条"，不是全文复读） */
function preview(text: string, translator: Translator, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return translator.t("common.truncatedPreview", { text: flat.slice(0, max), count: flat.length });
}

export interface CreateDisclosureInput {
  readonly mode: "chat" | "isolated_files";
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly modelSummary: string;
  readonly sourcePath: string | null;
  readonly writesAuthorized: boolean;
}

/** 创建入口（普通与隔离同一函数：差异全部由入参表达，不在组件里分叉两套话术） */
export function createDisclosure(
  input: CreateDisclosureInput,
  translator: Translator,
): ConfirmationDisclosure {
  const isolated = input.mode === "isolated_files";
  return {
    summary: translator.t(isolated ? "run.createSummaryIsolated" : "run.createSummaryChat"),
    facts: [
      { label: translator.t("run.fieldTask"), value: preview(input.userMessage, translator) },
      {
        label: "System Prompt",
        value:
          input.systemPrompt.trim().length === 0
            ? translator.t("run.systemPromptEmpty")
            : preview(input.systemPrompt, translator),
      },
      { label: translator.t("run.fieldEndpoint"), value: input.modelSummary },
      ...(isolated
        ? [
            {
              label: translator.t("run.fieldSourceDir"),
              value: input.sourcePath ?? translator.t("common.notSelected"),
            },
            {
              label: translator.t("common.fieldWrites"),
              value: translator.t(input.writesAuthorized ? "common.checked" : "common.unchecked"),
            },
          ]
        : [
            {
              label: translator.t("run.fieldToolTable"),
              value: translator.t("run.emptyToolTable"),
            },
          ]),
    ],
    checks: [translator.t("common.localFieldCheck")],
    limits: isolated
      ? [
          translator.t("run.createLimitIsolatedNoPreview"),
          translator.t("run.createLimitIsolatedWrites"),
        ]
      : [
          translator.t("run.createLimitChatNoWorkspace"),
          translator.t("run.createLimitChatNoPrecheck"),
        ],
  };
}

export interface ResultDisclosureInput {
  readonly parentRunId: string;
  readonly atSpanId: string;
  readonly toolName: string | null;
  readonly oldValue: string;
  readonly newValue: string;
  /** 父 run 该步录制的模型（缺记录 ⇒ null） */
  readonly parentModel: string | null;
  /** 当前运行配置的模型（未配置 ⇒ null） */
  readonly configModel: string | null;
}

/**
 * 普通 result 重跑（**非隔离**）：确认要说清"改的是模型看到的工具结果"和
 * "后续工具调用可能有真实副作用"，并且**不得**把它说成隔离续跑。
 *
 * 模型那一行复用 `lib/fork-cache-hint.ts` 的既有判据（未知 ≠ 不一致），
 * 不在这里另算一套"一致性"结论。
 */
export function resultPlainDisclosure(
  input: ResultDisclosureInput,
  translator: Translator,
): ConfirmationDisclosure {
  const hint = forkCacheHint(
    {
      kind: "tool-result",
      parentModel: input.parentModel,
      configModel: input.configModel,
    },
    translator,
  );
  return {
    summary: translator.t("fork.plainSummary"),
    facts: [
      { label: translator.t("fork.fieldParentRun"), value: input.parentRunId },
      {
        label: translator.t("fork.fieldEditedCall"),
        value: input.toolName === null ? input.atSpanId : `${input.toolName} · ${input.atSpanId}`,
      },
      { label: translator.t("common.fieldOldValue"), value: preview(input.oldValue, translator) },
      { label: translator.t("common.fieldNewValue"), value: preview(input.newValue, translator) },
      {
        label: translator.t("fork.fieldModelPrefix"),
        value:
          hint === null
            ? input.parentModel !== null && input.parentModel === input.configModel
              ? translator.t("fork.modelSameAsParent", { model: input.parentModel })
              : translator.t("fork.modelUnknown")
            : hint.text,
      },
    ],
    checks: [translator.t("common.localFieldCheck")],
    limits: [
      translator.t("fork.plainLimitNoWorld"),
      translator.t("fork.plainLimitNoPrecheck"),
      translator.t("fork.plainLimitParentUnchanged"),
    ],
  };
}

/** 只读预检结论的展示形态（由调用方从 `forkCapability` 结果与既有标签函数拼好） */
export interface IsolatedPrecheckFacts {
  readonly parentId: string;
  readonly stepSpanId: string;
  readonly atSpanId: string;
  /** 整轮结束检查点的既有标签（`isolatedCheckpointLabel`），不在这里另算一份 */
  readonly checkpointLabel: string;
  /** 续跑语义的既有标签（`isolatedContinueLabel`） */
  readonly continueLabel: string;
  readonly configHash: string;
}

export interface IsolatedResultDisclosureInput {
  readonly toolName: string | null;
  readonly oldValue: string;
  readonly newValue: string;
  readonly modelSummary: string;
  readonly writesAuthorized: boolean;
  /** null = 还没做过只读预检（或预检失败）：确认不可用，措辞要说明缺的是什么 */
  readonly precheck: IsolatedPrecheckFacts | null;
}

/**
 * 隔离 result 续跑的确认（U5 任务 4.5）：与普通路径**边界不同**，措辞必须各说各的。
 *
 * 隔离侧的真实事实：直接父、本地轮号、整轮结束检查点、不重做本轮其余工具、
 * **不撤销已经发生过的原写入**、副本写入要本次重新授权；预检是真实存在的只读请求
 * （`runs:forkCapability`），所以它可以出现在"已做的检查"里——普通路径没有这个接口，
 * 也就不能借用这句话。
 */
export function resultIsolatedDisclosure(
  input: IsolatedResultDisclosureInput,
  translator: Translator,
): ConfirmationDisclosure {
  const pre = input.precheck;
  return {
    summary: translator.t("fork.isolatedSummary"),
    facts: [
      {
        label: translator.t("fork.fieldEditedCall"),
        value:
          input.toolName === null
            ? (pre?.atSpanId ?? "-")
            : `${input.toolName} · ${pre?.atSpanId ?? "-"}`,
      },
      { label: translator.t("common.fieldOldValue"), value: preview(input.oldValue, translator) },
      { label: translator.t("common.fieldNewValue"), value: preview(input.newValue, translator) },
      ...(pre === null
        ? [
            {
              label: translator.t("fork.fieldContinueCondition"),
              value: translator.t("fork.precheckMissing"),
            },
          ]
        : [
            { label: translator.t("fork.fieldDirectParent"), value: pre.parentId },
            { label: translator.t("fork.fieldLocalTurn"), value: pre.stepSpanId },
            { label: translator.t("fork.fieldTurnEndCheckpoint"), value: pre.checkpointLabel },
            { label: translator.t("fork.fieldContinueMode"), value: pre.continueLabel },
            { label: "config_hash", value: pre.configHash },
            { label: translator.t("fork.fieldRealCall"), value: input.modelSummary },
          ]),
      {
        label: translator.t("common.fieldWrites"),
        value: translator.t(
          input.writesAuthorized ? "fork.writesCheckedOneShot" : "fork.writesUncheckedRejected",
        ),
      },
    ],
    checks:
      pre === null
        ? [translator.t("common.localFieldCheck")]
        : [translator.t("common.localFieldCheck"), translator.t("fork.precheckCheck")],
    limits: [
      translator.t("fork.isolatedLimitNoRedo"),
      translator.t("fork.isolatedLimitWrites"),
      translator.t("fork.isolatedLimitRights"),
    ],
  };
}

export interface PromptDisclosureInput {
  readonly parentRunId: string;
  /** 本次要改的启动字段（一次只能一项） */
  readonly fieldLabel: string;
  readonly oldValue: string;
  readonly newValue: string;
  readonly modelSummary: string;
  /** 启动上下文能否从首个 `llm.call` 重建（false ⇒ 入口本就不可用） */
  readonly rebuildable: boolean;
}

/**
 * prompt fork 的确认（U5 任务 4.6）：**从头执行**是它全部语义，措辞不得让人以为
 * 在续跑父 run 的世界（delta 场景「prompt 与 messages 不冒充续跑完整世界」）。
 */
export function promptDisclosure(
  input: PromptDisclosureInput,
  translator: Translator,
): ConfirmationDisclosure {
  return {
    summary: translator.t("fork.promptSummary"),
    facts: [
      { label: translator.t("fork.fieldParentRunCompare"), value: input.parentRunId },
      { label: translator.t("fork.fieldStartField"), value: input.fieldLabel },
      { label: translator.t("common.fieldOldValue"), value: preview(input.oldValue, translator) },
      { label: translator.t("common.fieldNewValue"), value: preview(input.newValue, translator) },
      { label: translator.t("fork.fieldRealCall"), value: input.modelSummary },
    ],
    checks: [translator.t("common.localFieldCheck")],
    limits: [
      translator.t("fork.promptLimitNewTrace"),
      translator.t("fork.promptLimitOneField"),
      translator.t(
        input.rebuildable
          ? "fork.promptLimitContextRecorded"
          : "fork.promptLimitContextUnavailable",
      ),
    ],
  };
}

export interface MessagesDisclosureInput {
  readonly parentRunId: string;
  readonly atSpanId: string;
  readonly messageCount: number;
  readonly modelSummary: string;
  /** 代理会话是否已捕获 key（决定"这次能不能发"） */
  readonly keyCaptured: boolean;
  readonly upstream: string | null;
  /** 缺资格的原因（就近显示；null = 资格齐备） */
  readonly ineligible: string | null;
}

/**
 * 代理 messages 单请求重发的确认（U5 任务 4.6）：说的是"**这一个请求**重发一次"，
 * 不得读成"把那个外部 Agent 接着跑完"——它不执行外部工具，也不恢复其工作区。
 */
export function messagesDisclosure(
  input: MessagesDisclosureInput,
  translator: Translator,
): ConfirmationDisclosure {
  return {
    summary: translator.t("fork.messagesSummary"),
    facts: [
      {
        label: translator.t("fork.fieldTargetCall"),
        value: `${input.parentRunId} · ${input.atSpanId}`,
      },
      {
        label: translator.t("fork.fieldMessages"),
        value: translator.t("fork.messagesCount", { count: input.messageCount }),
      },
      { label: "upstream", value: input.upstream ?? translator.t("fork.upstreamMissing") },
      {
        label: translator.t("fork.fieldCredentials"),
        value: translator.t(input.keyCaptured ? "fork.credsCaptured" : "fork.credsMissing"),
      },
      { label: translator.t("fork.fieldModel"), value: input.modelSummary },
    ],
    checks: [translator.t("fork.messagesCheck")],
    limits: [
      translator.t("fork.messagesLimitSingle"),
      translator.t("fork.messagesLimitCreds"),
      translator.t("fork.messagesLimitNoConfigHash"),
    ],
  };
}

export interface AbDisclosureInput {
  readonly parentRunId: string;
  readonly atSpanId: string;
  /** 接入摘要（baseURL；未配置 ⇒ 说明未配置） */
  readonly provider: string;
  /** 当前批次臂数（真实调用次数的口径来源，未预览时也用它说明规模） */
  readonly armCount: number;
  /** 当前生效的 dry-run 计划：null = 还没预览，或预览所绑的批次修订已推进 */
  readonly plan: ModelAbResult | null;
}

/**
 * A/B 实验的确认（U5 任务 4.7）：**确认的对象是"当前这份预览计划"**，不是屏幕上的草稿。
 *
 * 所以 `plan` 为 null（还没预览，或预览所绑的批次修订已经推进）时，这里不给臂级事实——
 * 只说缺的是什么。把未校验的草稿文本摊开当"已核对的计划"看，正是这条路径最容易骗人的地方：
 * 草稿里的 params 还要经过解析、与父 params 合并、丢弃无效项，最终生效的是 `plan.params`。
 */
export function abDisclosure(
  input: AbDisclosureInput,
  translator: Translator,
): ConfirmationDisclosure {
  const plan = input.plan;
  return {
    summary:
      plan === null
        ? translator.t("experiment.abSummaryNoPlan", { count: input.armCount })
        : plan.sideEffectsAllowed
          ? translator.t("experiment.abSummarySideEffects", { count: plan.plan.length })
          : translator.t("experiment.abSummaryPlan", { count: plan.plan.length }),
    facts:
      plan === null
        ? [
            {
              label: translator.t("fork.fieldTargetCall"),
              value: `${input.parentRunId} · ${input.atSpanId}`,
            },
            { label: translator.t("run.fieldEndpoint"), value: input.provider },
            {
              label: translator.t("experiment.fieldExecutionPlan"),
              value: translator.t("experiment.abPlanMissing", { count: input.armCount }),
            },
          ]
        : [
            {
              label: translator.t("fork.fieldTargetCall"),
              value: `${input.parentRunId} · ${input.atSpanId}`,
            },
            { label: translator.t("run.fieldEndpoint"), value: input.provider },
            { label: translator.t("experiment.fieldExperimentGroup"), value: plan.experimentId },
            {
              label: translator.t("fork.fieldRealCall"),
              value: translator.t("experiment.abRealCalls", { count: plan.plan.length }),
            },
            ...plan.plan.map(
              (arm): ConfirmationRow => ({
                label: translator.t("experiment.fieldArmEffective", { index: arm.index + 1 }),
                value: armPlanLine(arm, translator),
              }),
            ),
            {
              label: translator.t("experiment.fieldSideEffectTools"),
              value: translator.t(
                plan.sideEffectsAllowed
                  ? "experiment.abSideEffectsAllowed"
                  : "experiment.abSideEffectsNotAllowed",
              ),
            },
          ],
    checks:
      plan === null
        ? [translator.t("experiment.localBatchCheck")]
        : [translator.t("experiment.localBatchCheck"), translator.t("experiment.abCheckDryRun")],
    limits: [
      translator.t("experiment.abLimitPerArm", { count: input.armCount }),
      translator.t("experiment.abLimitParent"),
      ...(plan?.sideEffectsAllowed === true
        ? [translator.t("experiment.abLimitSideEffectWarning")]
        : []),
      translator.t("experiment.abLimitPlanBinding"),
    ],
  };
}

/** 一臂在计划里实际会用的东西：生效参数 + 被丢弃的父录值 + 静默忽略告警（全部来自 dry-run 响应） */
function armPlanLine(arm: ModelArmPlan, translator: Translator): string {
  const params =
    Object.keys(arm.params).length > 0
      ? JSON.stringify(arm.params)
      : translator.t("experiment.armLineNoParams");
  const discarded =
    Object.keys(arm.discarded).length > 0
      ? translator.t("experiment.armLineDiscarded", { values: JSON.stringify(arm.discarded) })
      : "";
  const warnings =
    arm.warnings.length > 0
      ? translator.t("experiment.armLineWarnings", {
          keys: arm.warnings.map((w) => w.key).join(", "),
        })
      : "";
  return `${arm.model} ${params}${discarded}${warnings}`;
}

/** 披露里"检查"与"边界"合成可读列表（视图只渲染，不再自己拼句子） */
export function disclosureLines(
  disclosure: ConfirmationDisclosure,
  translator: Translator,
): ConfirmationRow[] {
  return [
    ...disclosure.facts,
    ...disclosure.checks.map(
      (one): ConfirmationRow => ({ label: translator.t("common.checksDone"), value: one }),
    ),
    ...disclosure.limits.map(
      (one): ConfirmationRow => ({ label: translator.t("common.boundaryThisRun"), value: one }),
    ),
  ];
}
