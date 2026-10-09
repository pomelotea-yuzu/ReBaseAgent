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
function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…（共 ${flat.length} 字）`;
}

/** 本地字段检查的措辞：只说做了的事 */
const LOCAL_FIELD_CHECK = "本地字段检查：必填项、模式与授权条件（不联网、不调用模型）";

/**
 * A/B 的本地批次检查（`modelAbGuard` 的真实判据，逐臂粒度）——dry-run 之外唯一
 * 在渲染层确实做过的事，所以计划缺失时它也要显示。
 */
const AB_LOCAL_CHECK =
  "本地批次检查：运行配置已填、至少两臂、每臂 model 非空、参数 JSON 可解析、逐臂与父 run 不同（与父完全相同的臂会让整批被拒）";

export interface CreateDisclosureInput {
  readonly mode: "chat" | "isolated_files";
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly modelSummary: string;
  readonly sourcePath: string | null;
  readonly writesAuthorized: boolean;
}

/** 创建入口（普通与隔离同一函数：差异全部由入参表达，不在组件里分叉两套话术） */
export function createDisclosure(input: CreateDisclosureInput): ConfirmationDisclosure {
  const isolated = input.mode === "isolated_files";
  return {
    summary: isolated
      ? "隔离采集只读源目录 · 副本写入须本次勾选 · 真实调用按用量计费"
      : "一次真实模型调用 · 按实际用量计费 · 纯对话不调用工具",
    facts: [
      { label: "任务（User Message）", value: preview(input.userMessage) },
      {
        label: "System Prompt",
        value:
          input.systemPrompt.trim().length === 0
            ? "留空（config_hash 按空 system 计）"
            : preview(input.systemPrompt),
      },
      { label: "接入", value: input.modelSummary },
      ...(isolated
        ? [
            { label: "源目录", value: input.sourcePath ?? "未选择" },
            { label: "本次副本写入", value: input.writesAuthorized ? "已勾选" : "未勾选" },
          ]
        : [{ label: "工具表", value: "空（纯对话不调用工具）" }]),
    ],
    checks: [LOCAL_FIELD_CHECK],
    limits: isolated
      ? [
          "没有目录采集预览接口：文件数量、体积与是否被拒绝，要到提交后才可知，这里不预告。",
          "隔离运行按固定工具组执行，采集到的文本会进入模型请求；副本写入只落到数据目录的不可变附件。",
        ]
      : [
          "没有目录或工作区参与：这次只发一条纯对话请求。",
          "没有独立的模型连通性预检：能否真的跑通由提交时 main 校验（未配置会拒绝，不消耗模型调用）。",
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
export function resultPlainDisclosure(input: ResultDisclosureInput): ConfirmationDisclosure {
  const hint = forkCacheHint({
    kind: "tool-result",
    parentModel: input.parentModel,
    configModel: input.configModel,
  });
  return {
    summary: "普通续跑 · 后续新发起的工具调用会真实执行 · 父 run 不会被修改",
    facts: [
      { label: "父运行", value: input.parentRunId },
      {
        label: "被改的调用",
        value: input.toolName === null ? input.atSpanId : `${input.toolName} · ${input.atSpanId}`,
      },
      { label: "原值", value: preview(input.oldValue) },
      { label: "新值", value: preview(input.newValue) },
      {
        label: "模型与前缀",
        value:
          hint === null
            ? input.parentModel !== null && input.parentModel === input.configModel
              ? `与父 run 该步录制的模型相同（${input.parentModel}）`
              : "父模型或当前配置未知：不据此推断一致性"
            : hint.text,
      },
    ],
    checks: [LOCAL_FIELD_CHECK],
    limits: [
      "世界不隔离：这是普通 replay 续跑——默认不复执行工具（把录下的结果喂回模型），但后续由模型新发起的工具调用会真的执行，可能有外部副作用。",
      "没有独立的续跑条件预检接口（隔离路径才有）：这里的条件由提交时 main 复核。",
      "父运行与其后的步骤不会被修改；重跑产出的是一条新 run。",
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
): ConfirmationDisclosure {
  const pre = input.precheck;
  return {
    summary: "整轮续跑 · 本轮其余工具不重做 · 副本写入须本次勾选",
    facts: [
      {
        label: "被改的调用",
        value:
          input.toolName === null
            ? (pre?.atSpanId ?? "-")
            : `${input.toolName} · ${pre?.atSpanId ?? "-"}`,
      },
      { label: "原值", value: preview(input.oldValue) },
      { label: "新值", value: preview(input.newValue) },
      ...(pre === null
        ? [{ label: "续跑条件", value: "尚未取得只读预检结论（下面这几项要预检后才知道）" }]
        : [
            { label: "直接父", value: pre.parentId },
            { label: "本地轮号", value: pre.stepSpanId },
            { label: "整轮结束检查点", value: pre.checkpointLabel },
            { label: "续跑方式", value: pre.continueLabel },
            { label: "config_hash", value: pre.configHash },
            { label: "真实调用", value: input.modelSummary },
          ]),
      {
        label: "本次副本写入",
        value: input.writesAuthorized ? "已勾选（只对这次提交有效）" : "未勾选（隔离提交会被拒绝）",
      },
    ],
    checks:
      pre === null
        ? [LOCAL_FIELD_CHECK]
        : [LOCAL_FIELD_CHECK, "只读预检 `runs:forkCapability`：不创建运行、不写文件、不请求模型"],
    limits: [
      "整轮续跑：这一轮的其余工具不重做（它们在子运行的前缀里各出现一次），编辑点之后的步骤由模型重新生成。",
      "不撤销已经发生的写入：源目录与父 trace 都不会被改动，写入只落在本副本映射里；父 trace 上的历史授权标注不构成本次授权。",
      "副本写入需要本次显式勾选；重新打开编辑或换目录都要重新勾选，不从历史记录补授权。",
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
export function promptDisclosure(input: PromptDisclosureInput): ConfirmationDisclosure {
  return {
    summary: "从头执行新轨迹 · 真实调用模型并计费 · 父 run 只作对照",
    facts: [
      { label: "父运行（只作对照）", value: input.parentRunId },
      { label: "改动的启动字段", value: input.fieldLabel },
      { label: "原值", value: preview(input.oldValue) },
      { label: "新值", value: preview(input.newValue) },
      { label: "真实调用", value: input.modelSummary },
    ],
    checks: [LOCAL_FIELD_CHECK],
    limits: [
      "从头执行一条新轨迹：不复用父 run 的执行前缀，不回放任何工具结果，父 run 不会被修改。",
      "一次只改一个启动字段（system 或首个 user），其余上下文与后续步骤都由模型重新生成。",
      input.rebuildable
        ? "启动上下文取自该次调用录制的首个 llm.call（system + 首个 user），config_hash 随改动变化。"
        : "启动上下文无法从首次调用重建：该入口不可用，原因已就近标在入口上。",
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
export function messagesDisclosure(input: MessagesDisclosureInput): ConfirmationDisclosure {
  return {
    summary: "只重发这一个请求 · 不执行外部工具 · 凭据用代理会话最近捕获的 key",
    facts: [
      { label: "目标 run · 调用", value: `${input.parentRunId} · ${input.atSpanId}` },
      { label: "本次请求的 messages", value: `${input.messageCount} 条（完整替换发送，不截断）` },
      { label: "upstream", value: input.upstream ?? "（代理未运行，无 upstream）" },
      {
        label: "凭据",
        value: input.keyCaptured ? "使用代理会话最近捕获的 key" : "未捕获 key：本次无法重发",
      },
      { label: "模型", value: input.modelSummary },
    ],
    checks: [
      "本地结构检查：messages 必须是非空 JSON 数组（不合法就就近报错、不发请求，不调用模型）",
    ],
    limits: [
      "只重发这一个请求：不执行任何外部 Agent 的工具，也不恢复它的工作区或后续步骤。",
      "凭据是代理会话最近捕获的那一个，可能与该 run 录制当时不同（也可能没有 ⇒ 会被拒）。",
      "被动录制的 run 没有自有 config_hash：它仍是可对照的轨迹，但这条路径不产生父子续跑。",
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
export function abDisclosure(input: AbDisclosureInput): ConfirmationDisclosure {
  const plan = input.plan;
  return {
    summary:
      plan === null
        ? `尚未取得当前批次的计划（${input.armCount} 臂）：先校验并预览`
        : `${plan.plan.length} 次真实模型调用 · 按臂数计费${
            plan.sideEffectsAllowed ? " · 副作用工具将真实执行" : ""
          }`,
    facts:
      plan === null
        ? [
            { label: "目标 run · 调用", value: `${input.parentRunId} · ${input.atSpanId}` },
            { label: "接入", value: input.provider },
            {
              label: "执行计划",
              value: `尚未取得当前批次的计划（${input.armCount} 臂）：先“校验并预览计划”，确认要核对的是计划里各臂实际生效的参数`,
            },
          ]
        : [
            { label: "目标 run · 调用", value: `${input.parentRunId} · ${input.atSpanId}` },
            { label: "接入", value: input.provider },
            { label: "实验组", value: plan.experimentId },
            {
              label: "真实调用",
              value: `${plan.plan.length} 次（每臂一次，各自落盘为独立新 run）`,
            },
            ...plan.plan.map(
              (arm): ConfirmationRow => ({
                label: `臂 ${arm.index + 1} 实际生效`,
                value: armPlanLine(arm),
              }),
            ),
            {
              label: "副作用工具",
              value: plan.sideEffectsAllowed
                ? "已放行：含副作用的工具会真实执行"
                : "未放行：该调用没有需要放行的副作用工具",
            },
          ],
    checks:
      plan === null
        ? [AB_LOCAL_CHECK]
        : [
            AB_LOCAL_CHECK,
            "只读校验 `runs:modelAbPlan`（dry-run）：不联网、不写文件、不占主动执行槽",
          ],
    limits: [
      `一次执行按臂数发起真实模型调用并产生费用（当前 ${input.armCount} 臂）；各臂顺序执行，单臂失败不影响其它臂。`,
      "父 run 只作对照，不会被修改；各臂各自落盘为独立新轨迹，同批共享一个实验组 ID。",
      ...(plan?.sideEffectsAllowed === true
        ? ["⚠ 前一臂的外部副作用会改变后一臂的起点：比较结果不一定可信（该声明随实验留痕）。"]
        : []),
      "计划与批次修订同源：改臂、改参数、改动副作用许可或修改运行配置都会作废旧计划与旧确认，须重新预览再重新确认。",
    ],
  };
}

/** 一臂在计划里实际会用的东西：生效参数 + 被丢弃的父录值 + 静默忽略告警（全部来自 dry-run 响应） */
function armPlanLine(arm: ModelArmPlan): string {
  const params =
    Object.keys(arm.params).length > 0 ? JSON.stringify(arm.params) : "（沿用父 run 的采样参数）";
  const discarded =
    Object.keys(arm.discarded).length > 0 ? ` · 丢弃父录值 ${JSON.stringify(arm.discarded)}` : "";
  const warnings =
    arm.warnings.length > 0 ? ` · ⚠ ${arm.warnings.map((w) => w.key).join("、")} 可能未生效` : "";
  return `${arm.model} ${params}${discarded}${warnings}`;
}

/** 披露里"检查"与"边界"合成可读列表（视图只渲染，不再自己拼句子） */
export function disclosureLines(disclosure: ConfirmationDisclosure): ConfirmationRow[] {
  return [
    ...disclosure.facts,
    ...disclosure.checks.map((one): ConfirmationRow => ({ label: "已做的检查", value: one })),
    ...disclosure.limits.map((one): ConfirmationRow => ({ label: "本次边界", value: one })),
  ];
}
