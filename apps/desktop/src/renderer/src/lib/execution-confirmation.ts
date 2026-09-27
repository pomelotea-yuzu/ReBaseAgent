import type { ProxyState, SettingsState } from "@shared/ipc";
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
    return { kind: "stale", reason: "运行配置已变化：模型、地址或代理凭据与确认时不同" };
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
 * 设置快照指纹：确认信息里出现过的**运行配置**变了，确认就作废。
 *
 * 只取会影响"这次会打到哪儿、花谁的钱"的字段：模型、baseURL、是否已配置、
 * 代理是否在跑与是否已捕获 key。**刻意不含** apiKey 与加密状态——指纹会进日志风险面，
 * 而且"key 换了"在渲染层不可观察（单向存储，读不回明文）。
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
    proxy?.hasKey === true ? "key" : "nokey",
  ].join("|");
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
          "没有目录采集预览接口：文件数量、体积与是否被拒绝**要到提交后**才可知，这里不预告。",
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
      "世界不隔离：这是普通 replay 续跑——默认不复执行工具（把录下的结果喂回模型），但**后续**由模型新发起的工具调用会真的执行，可能有外部副作用。",
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
      "整轮续跑：这一轮的其余工具**不重做**（它们在子运行的前缀里各出现一次），编辑点之后的步骤由模型重新生成。",
      "不撤销已经发生的写入：源目录与父 trace 都不会被改动，写入只落在本副本映射里；父 trace 上的历史授权标注不构成本次授权。",
      "副本写入需要本次显式勾选；重新打开编辑或换目录都要重新勾选，不从历史记录补授权。",
    ],
  };
}

/** 披露里"检查"与"边界"合成可读列表（视图只渲染，不再自己拼句子） */
export function disclosureLines(disclosure: ConfirmationDisclosure): ConfirmationRow[] {
  return [
    ...disclosure.facts,
    ...disclosure.checks.map((one): ConfirmationRow => ({ label: "已做的检查", value: one })),
    ...disclosure.limits.map((one): ConfirmationRow => ({ label: "本次边界", value: one })),
  ];
}
