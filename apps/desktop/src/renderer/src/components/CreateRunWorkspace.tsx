import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  CREATE_RUN_MODES,
  CREATE_RUN_MODE_LABELS,
  ISOLATED_TOOL_NAMES,
  ISOLATED_TOOL_PROFILE_LABEL,
  applyChosenSource,
  fieldErrorsOf,
  initialCreateRunForm,
  resolveCreateRunSubmission,
  restoreCreateForm,
  setWritesAuthorized,
  submitCreateRun,
  switchCreateRunMode,
} from "../lib/create-run";
import type { ChosenSource, CreateRunFieldErrors, CreateRunMode } from "../lib/create-run";
import type { CreateRunFormState } from "../lib/create-run";
import { isCreateRunDraftDirty } from "../lib/debugging-drafts";
import { CREATE_SUBMIT_TARGET } from "../lib/draft-submission";
import { deriveEntryGate } from "../lib/entry-gate";
import {
  createDisclosure,
  disclosureLines,
  modelConfigStampOf,
} from "../lib/execution-confirmation";
import type { ConfirmationRow } from "../lib/execution-confirmation";
import { useRevokeOnConfigChange } from "../lib/use-revoke-on-config-change";
import { useAppStore } from "../store";
import { requestConfirm } from "./ConfirmDialog";
import { ConfirmationBlock } from "./ConfirmationBlock";
import { FOCUS_RING } from "./IconButton";

/**
 * 新建运行**工作区页面**（U5 任务 4.1 迁入主工作区；4.2 布置正文与就近字段错误）。
 *
 * 桌面端原生 run 的唯一创建通道仍是 `runs:create`；两个字段（systemPrompt 可空 /
 * userMessage 必填）与两种模式（默认纯对话 / 隔离文件运行）都不变：
 * - 纯对话：空工具表，请求里**不带** workspace ⇒ main 走 runCreate（v1）
 * - 隔离文件运行：选源目录 + 本次显式副本写入授权 ⇒ main 走 runCreateIsolated（v2）
 * 判据与请求构造都在 `lib/create-run.ts`，组件既不手拼请求，也不另算一份"哪条错属于哪个框"
 * （就近归属同样由那份判据给出：`fieldErrorsOf`）。
 *
 * 正文顺序按 design D1：模式 → 任务 → 隔离目录 → 当前模型/接入摘要 → 高级系统指令 →
 * 执行范围 → 操作区；单列、上限 800px。
 *
 * 三条不再回退的形态结论：
 * 1. **不锁整窗**：提交后允许切运行、阅读文件、去设置——执行事实与草稿冻结由 store 判，
 *    页面只呈现"这份草稿此刻不可改"（旧模态的全窗 `closeDisabled` 作废）。
 * 2. **有来源可回**：页头「返回来源」走 `returnToCreateSource`，位置引用只在 renderer 会话里
 *    （`lib/create-workspace.ts`），与草稿互不决定。
 * 3. **响应不宣布成功**：响应返回只代表这次请求明确回了话；运行结局、列表刷新、草稿清理
 *    与是否进入概览全部归 store 的终态消费与导航意图（任务 3.1–3.4）。
 *
 * ⚠️ 拆成"容器 + 视图"两个导出：本包无 jsdom，`renderToStaticMarkup` 喂不进 store 状态
 *    （zustand v5 在静态渲染下走 `getServerSnapshot`），所以可见结构全部收敛到只吃 props 的
 *    `CreateRunWorkspaceView`（能力断言打在它上面，见 `test/create-form-view.test.ts`），
 *    容器只做 store 订阅与动作转发。
 */

/** 视图的锁位：几种"不能动"各有各的含义，不合并成一个忙碌旗标 */
export interface CreateRunLock {
  /** 表单不可编辑（执行中 / 原生目录选择中 / 待定提交冻结） */
  readonly fields: boolean;
  /** 仅"这份草稿被待定提交冻结"：两段文本与放弃入口不可用 */
  readonly draftFrozen: boolean;
  readonly busy: boolean;
  readonly pickingSource: boolean;
  /** 提交按钮是否可用（提交判据 + 门禁，见容器 `canCreate`） */
  readonly canSubmit: boolean;
  /** 「放弃填写内容」是否有可放弃的东西 */
  readonly canDiscard: boolean;
}

export interface CreateRunFormViewProps {
  readonly mode: CreateRunMode;
  readonly userMessage: string;
  readonly systemPrompt: string;
  readonly source: ChosenSource | null;
  readonly writesAuthorized: boolean;
  readonly advancedOpen: boolean;
  readonly errors: CreateRunFieldErrors;
  /** 两模式共用的当前模型 / 接入摘要（delta：「两模式 SHALL 显示…摘要及就近配置入口」） */
  readonly settingsSummary: string;
  /** 摘要是否指向"还没配置"（决定配置入口摆成告警态还是普通态） */
  readonly settingsMissing: boolean;
  /** 执行范围与计费事实（D8：必须就近可读，不靠悬停与跳转） */
  readonly scopeFacts: { readonly execution: string; readonly cost: string };
  /**
   * 本次提交的核对与确认（U5 任务 4.4，design D2）：确认态只列**确实做过**的本地检查
   * 与本次边界，未确认时提交按钮不可用；改输入 / 换设置 / 离开现场即作废（判据在 store）。
   */
  readonly confirmation: {
    readonly ready: boolean;
    /** 收起态仍可见的关键摘要（费用 / 模式 / 文件副作用一句话，3.1 design D4） */
    readonly summary: string;
    readonly rows: readonly ConfirmationRow[];
    /** 还不能确认的原因（输入判据没过 / 门禁挡住）；null = 现在就能确认 */
    readonly blocked: string | null;
  };
  readonly lock: CreateRunLock;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onMode: (mode: CreateRunMode) => void;
  readonly onUserMessage: (text: string) => void;
  readonly onSystemPrompt: (text: string) => void;
  readonly onPickSource: () => void;
  readonly onWrites: (authorized: boolean) => void;
  readonly onToggleAdvanced: () => void;
  readonly onOpenSettings: () => void;
  readonly onConfirm: () => void;
  readonly onDiscard: () => void;
  readonly onSubmit: () => void;
  readonly onReturn: () => void;
}

/** 就近错误条：文字表达（不只靠颜色），并由调用方用 aria-describedby 接到控件上 */
function FieldError({ id, message }: { id: string; message: string | null }) {
  if (message === null) return null;
  return (
    <p id={id} className="mt-0.5 text-[11px] leading-4 text-red-700">
      {message}
    </p>
  );
}

/**
 * 创建工作区的纯视图（不读 store、不判禁用条件：一切由 props 决定）。
 *
 * 导出供测试直接喂 props 做能力断言（给了错误必须同时出现文本与 `aria-describedby` 锚点；
 * 没给必须什么都不渲染）。
 */
export function CreateRunWorkspaceView(props: CreateRunFormViewProps) {
  const {
    mode,
    userMessage,
    systemPrompt,
    source,
    writesAuthorized,
    advancedOpen,
    errors,
    settingsSummary,
    settingsMissing,
    scopeFacts,
    lock,
    headingRef,
  } = props;
  const isolated = mode === "isolated_files";

  return (
    <section aria-label="新建运行" className="flex min-w-0 flex-1 flex-col bg-white">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-gray-200 px-4 py-2">
        <div className="min-w-0">
          <h1 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-gray-800">
            新建运行
          </h1>
          <div className="text-[11px] text-gray-500">
            从头执行一个 run（无父 run、不续跑既有轨迹）
          </div>
        </div>
        <button
          type="button"
          // 返回来源不挑时机：草稿与它的冻结一起留在会话里，回来仍是原样
          onClick={props.onReturn}
          data-return-to-source
          className={`shrink-0 rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          返回来源
        </button>
      </div>

      {/* 正文单列、上限 800px（design D1）：窄窗口下长源路径与说明区不遮挡提交按钮 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-200 space-y-3 px-4 py-3">
          <div>
            <span className="mb-1 block text-[11px] font-medium text-gray-600">运行模式</span>
            {/* 与运行列表的来源过滤同形：一组 aria-pressed 按钮，不额外声明 role */}
            <div className="flex items-center gap-1">
              {CREATE_RUN_MODES.map((one) => (
                <button
                  key={one}
                  type="button"
                  aria-pressed={mode === one}
                  onClick={() => props.onMode(one)}
                  disabled={lock.fields}
                  className={`flex-1 rounded border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
                    mode === one
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {CREATE_RUN_MODE_LABELS[one]}
                </button>
              ))}
            </div>
          </div>

          {/* 任务优先：User Message 是这份表单的主字段，也是新 run 的列表标题 */}
          <div>
            <label className="block">
              <span className="mb-0.5 block text-[11px] font-medium text-gray-600">
                User Message（必填）
              </span>
              <textarea
                id="create-user-message"
                aria-invalid={errors.userMessage === null ? undefined : "true"}
                aria-describedby={
                  errors.userMessage === null ? undefined : "create-user-message-error"
                }
                value={userMessage}
                onChange={(event) => props.onUserMessage(event.target.value)}
                placeholder="要交给模型的任务。它会同时成为该 run 在列表中的标题。"
                spellCheck={false}
                rows={5}
                disabled={lock.draftFrozen}
                className="w-full resize-y rounded border border-gray-300 px-2 py-1 font-code text-xs outline-none focus:border-blue-400 disabled:bg-gray-50"
              />
              <span className="mt-0.5 block text-[11px] text-gray-500">
                该 run 在列表中的标题（task）即这段文字。
              </span>
            </label>
            <FieldError id="create-user-message-error" message={errors.userMessage} />
          </div>

          {isolated ? (
            <div className="space-y-2 rounded border border-gray-200 bg-gray-50 p-2">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={props.onPickSource}
                  disabled={lock.fields}
                  className="shrink-0 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {lock.pickingSource ? "选择中…" : source === null ? "选择目录…" : "重新选择…"}
                </button>
                <div className="min-w-0 flex-1">
                  {source === null ? (
                    <div className="text-[11px] text-gray-500">尚未选择源目录</div>
                  ) : (
                    <>
                      <div className="truncate text-[11px] font-medium text-gray-700">
                        {source.name}
                      </div>
                      {/* 长路径换行而非截断：用户需要核对到底选了哪个目录 */}
                      <div className="break-all font-code text-[11px] leading-4 text-gray-500">
                        {source.path}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <FieldError id="create-source-error" message={errors.source} />

              <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-4 text-gray-600">
                <li>
                  采集选定目录下全部受支持的普通文件（含隐藏文件）；链接、非普通文件、磁盘根与数据目录内的路径会被拒绝。
                </li>
                <li>
                  文件内容只落入数据目录里的不可变附件，源目录不会被修改；后续分叉的写入也只落在各自的副本映射里。
                </li>
                <li>{ISOLATED_TOOL_NAMES.join(" / ")} 工具读出的文本会进入你配置的模型请求。</li>
              </ul>

              <label className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
                <input
                  type="checkbox"
                  aria-describedby={
                    errors.writesAuthorized === null ? undefined : "create-writes-error"
                  }
                  checked={writesAuthorized}
                  // 未选目录时无可授权的对象；本次提交待定期间不允许改授权
                  disabled={lock.fields || source === null}
                  onChange={(event) => props.onWrites(event.target.checked)}
                  className="mt-0.5 shrink-0"
                />
                <span className="text-[11px] leading-4 text-amber-900">
                  允许本次执行的副本写入
                  <span className="text-amber-700">
                    （默认未选；只对这一次提交有效，重新打开或切换模式后都要重新勾选）
                  </span>
                </span>
              </label>
              <FieldError id="create-writes-error" message={errors.writesAuthorized} />
            </div>
          ) : null}

          {/* 两模式共用的模型/接入摘要 + 就近配置入口（不要求用户去全局栏里找） */}
          <div
            className={`rounded border px-2 py-1.5 text-[11px] leading-4 ${
              settingsMissing
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-gray-200 bg-gray-50 text-gray-600"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words">
                <span className="font-medium text-gray-700">当前接入：</span>
                {settingsSummary}
              </span>
              <button
                type="button"
                onClick={props.onOpenSettings}
                data-open-settings
                className={`shrink-0 rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
              >
                运行配置…
              </button>
            </div>
            <div className="mt-0.5 text-gray-500">
              {isolated ? "隔离运行的工具读取文本同样进入该模型请求。" : "纯对话请求不带工具表。"}
            </div>
          </div>

          <div className="rounded border border-gray-200">
            <button
              type="button"
              aria-expanded={advancedOpen ? "true" : "false"}
              aria-controls="create-system-prompt"
              onClick={props.onToggleAdvanced}
              data-advanced-toggle
              className={`w-full rounded px-2 py-1.5 text-left text-[11px] font-medium text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
            >
              高级：System Prompt（可选）
            </button>
            {advancedOpen ? (
              <div className="border-t border-gray-200 px-2 pb-2 pt-1.5">
                <textarea
                  id="create-system-prompt"
                  value={systemPrompt}
                  onChange={(event) => props.onSystemPrompt(event.target.value)}
                  placeholder="例如：你是一个简洁的问答助手，用两三句话回答。"
                  spellCheck={false}
                  rows={3}
                  disabled={lock.draftFrozen}
                  className="w-full resize-y rounded border border-gray-300 px-2 py-1 font-code text-xs outline-none focus:border-blue-400 disabled:bg-gray-50"
                />
                {systemPrompt.trim().length === 0 ? (
                  <span className="mt-0.5 block text-[11px] text-gray-500">
                    留空也可以：此时 config_hash 按空 system 计算
                    {isolated ? "（按空 system + 固定工具组）" : ""}，仍可作为分叉与 A/B 的父本。
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* 执行范围与计费事实：提交前就地可读 */}
          <div className="rounded border-l-2 border-gray-300 bg-white px-2 py-1.5 text-[11px] leading-4 text-gray-600">
            <div>
              <span className="font-medium text-gray-700">执行范围：</span>
              {scopeFacts.execution}
            </div>
            <div className="mt-0.5 text-gray-500">{scopeFacts.cost}</div>
          </div>

          {/* 核对本次提交（U5 4.4）：就地展开，不再新增阻断阅读的大模态；确认后才放行提交。
              UI 密度 3.1/3.2（design D4）：换共享确认块——关键摘要收起仍可见、
              详细边界默认收起；确认行为提醒保留在块内。 */}
          <ConfirmationBlock
            title="核对本次提交"
            tone="gray"
            summary={props.confirmation.summary}
            rows={props.confirmation.rows}
            confirmed={props.confirmation.ready}
            confirmDisabled={props.confirmation.blocked !== null}
            onConfirm={props.onConfirm}
            confirmLabel="已核对，确认本次提交"
            confirmedLabel="已确认本次提交"
            blocked={props.confirmation.blocked}
            controlsId="create-confirm-details"
          >
            <div className="border-t border-gray-100 px-2 py-1.5 text-[11px] leading-4 text-gray-500">
              确认后才会放行创建；改任何输入、换配置或去别的页面看一眼，都要重新确认。
            </div>
          </ConfirmationBlock>

          {/* 表单级说明：不属于某个字段的拒绝（门禁 / 执行中） */}
          {errors.form !== null && !lock.busy ? (
            <div className="rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-800">
              {errors.form}
            </div>
          ) : null}
        </div>
      </div>

      {/* 操作区固定在正文下方：长任务/长路径滚动时仍然可达 */}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-200 bg-white px-4 py-2">
        <div className="mr-auto min-w-0 space-y-0.5">
          {lock.draftFrozen ? (
            <div className="rounded border-l-2 border-violet-400 bg-violet-50 px-2 py-1 text-[11px] leading-4 text-violet-800">
              本次提交待处理：已按提交时的修订冻结这份表单，请求返回前不可修改、切换模式或放弃。
              期间切运行、阅读文件、打开设置都不受影响。
            </div>
          ) : null}
          {lock.busy ? (
            <div className="rounded border-l-2 border-blue-400 bg-blue-50 px-2 py-1 text-[11px] leading-4 text-blue-800">
              本次创建仍在进行中：结局与结果由上方「操作」面板核对，留在本页不会挡住它。
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={props.onDiscard}
          disabled={!lock.canDiscard}
          title={lock.canDiscard ? undefined : "尚无修改可放弃"}
          className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          放弃填写内容
        </button>
        <button
          type="button"
          onClick={props.onSubmit}
          disabled={!lock.canSubmit}
          className={`rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
        >
          {lock.busy ? "创建中…" : isolated ? "创建隔离运行" : "创建"}
        </button>
      </div>
    </section>
  );
}

/**
 * 容器：订阅 store、持有本次创建操作的会话形态（目录引用镜像 + 授权 + 高级区展开态），
 * 判断全部委托给 `lib/create-run.ts`，渲染全部委托给 `CreateRunWorkspaceView`。
 *
 * `onOpenSettings` 由 App 传入：设置模态的开合是 App 的状态（与全局栏同一通道），
 * 组件不自建第二份设置状态。
 */
export function CreateRunWorkspace({ onOpenSettings }: { onOpenSettings: () => void }) {
  /**
   * U3 任务 2.3：模式 / System Prompt / User Message 由**会话创建草稿**驱动
   * （design D1/D3：离开再回来恢复；切模式保留文本；显式放弃才重置整份表单）。
   * 本地 state 只保留**本次创建操作**的会话形态（源目录引用镜像 + 副本授权）——
   * 那属于 D4 的 sourceToken 引用接线，不进草稿。
   */
  const draftEntry = useAppStore((s) => s.createRunDraftOf());
  const ensureCreateRunDraft = useAppStore((s) => s.ensureCreateRunDraft);
  const writeCreateRunDraft = useAppStore((s) => s.writeCreateRunDraft);
  const discardCreateRunDraft = useAppStore((s) => s.discardCreateRunDraft);
  const setCreateSourceRef = useAppStore((s) => s.setCreateSourceRef);
  const createRunErrorCode = useAppStore((s) => s.createRunErrorCode);
  const returnToCreateSource = useAppStore((s) => s.returnToCreateSource);
  const [form, setForm] = useState<CreateRunFormState>(() =>
    restoreCreateForm({
      draftMode: useAppStore.getState().createRunDraftOf()?.mode,
      // 源目录引用从 store 恢复（离开/设置往返后仍在），但**授权不随引用恢复**——
      // 判据在 `lib/create-run.ts` 的 `restoreCreateForm`，这里只是取现场
      sourceRef: useAppStore.getState().createSourceRef,
    }),
  );
  /** 原生目录选择器是否正在打开（系统对话框阻塞期间不接收重复点击） */
  const [pickingSource, setPickingSource] = useState(false);
  /**
   * 高级区（System Prompt）的展开态：初次进入按草稿是否有内容决定，
   * 之后归本组件的展示态——它**不进草稿**（草稿只存模式与两段文本，D1）。
   */
  const [advancedOpen, setAdvancedOpen] = useState(
    () => (useAppStore.getState().createRunDraftOf()?.systemPrompt ?? "") !== "",
  );

  const creatingRun = useAppStore((s) => s.creatingRun);
  const createRunError = useAppStore((s) => s.createRunError);
  const createRun = useAppStore((s) => s.createRun);
  const resetCreateRun = useAppStore((s) => s.resetCreateRun);
  const chooseSource = useAppStore((s) => s.chooseSource);
  const settings = useAppStore((s) => s.settings);

  // U5 任务 5.3：设置往返保存成功（模型配置指纹变了）⇒ 本次副本写入授权作废。
  // **模式与目录引用照旧保留**（delta「两模式配置后返回任务」的"保留"半边——token 有效性
  // 仍由 main 使用时判定）；确认凭据的撤销走 setSettingsSection 进出（4.4），两路互补。
  useRevokeOnConfigChange(modelConfigStampOf(settings), () => {
    setForm((prev) => (prev.writesAuthorized ? setWritesAuthorized(prev, false) : prev));
  });

  // 页头标题是进入本页时的初始焦点（D8：创建是页面，不做焦点禁闭，但要把"你在哪儿"给到）
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // 挂载即登记创建草稿（已存在则原样保留——重开不覆盖已有输入）
  useEffect(() => {
    ensureCreateRunDraft();
    headingRef.current?.focus();
  }, [ensureCreateRunDraft]);

  // 卸载时复位（下次打开不残留上次的报错与进行中状态）
  useEffect(() => {
    return () => resetCreateRun();
  }, [resetCreateRun]);

  // U3 任务 3.2：失效/已消费 token 的提交错误 ⇒ 要求重新选目录（清引用），但
  // 任务、系统指令与模式在**草稿**里原样保留——不能清空任务。
  useEffect(() => {
    if (createRunErrorCode !== "INVALID_SOURCE_TOKEN") return;
    setCreateSourceRef(null);
    setForm((prev) => ({ ...prev, source: null }));
  }, [createRunErrorCode, setCreateSourceRef]);

  // 文本字段直接读草稿（未 ensure 前退回默认值，与 ensure 的初始值一致）
  const systemPrompt = draftEntry?.systemPrompt ?? "";
  const userMessage = draftEntry?.userMessage ?? "";
  const draftDirty = draftEntry !== null && isCreateRunDraftDirty(draftEntry);

  const busy = creatingRun === "in_progress";
  const isolated = form.mode === "isolated_files";
  // U3 任务 3.5：待定提交冻结整份表单（store 侧同时拒绝写入与放弃）。
  // ⚠️ U5 4.1 起它**只冻结这份表单**，不再锁整窗：切运行/去设置/返回来源都照常可用，
  // 离开时这份草稿连同冻结一起留在会话里（判据在 draft-submission，不在组件）。
  const draftFrozen = useAppStore((s) => s.isDraftFrozen(CREATE_SUBMIT_TARGET));
  const beginDraftSubmission = useAppStore((s) => s.beginDraftSubmission);
  const currentConfirmationBinding = useAppStore((s) => s.currentConfirmationBinding);
  const armExecutionConfirmation = useAppStore((s) => s.armExecutionConfirmation);
  // 禁用判据与将要发出的请求同源（同一个函数），不存在两处口径漂移
  const submission = resolveCreateRunSubmission(form, { systemPrompt, userMessage, busy });
  // U4 任务 4.3：入口可用性从**统一操作槽**派生（不再只看本地 in_progress）。
  // 只禁"提交"——门禁拦下属于"这次发不出去"，不该顺手把输入也锁住（那是自己那次
  // 提交在飞时草稿冻结要做的事）。
  const gate = deriveEntryGate(useAppStore((s) => s.operations));
  /**
   * U5 任务 4.4：确认门禁。**现场绑定由 store 现取**（修订与设置快照组件传不进旧值），
   * 判据在 `lib/execution-confirmation.ts`；store 的登记口在确认不成立时直接拒绝登记，
   * 所以这里即使被绕过也不会发出请求。
   */
  const confirmation = currentConfirmationBinding("create", CREATE_SUBMIT_TARGET);
  // U5 §6.2 实机修正（6.2 首跑坐实的接线缺口）：confirmed 必须经 store **订阅现算**——
  // 此前只订阅了函数引用，`armExecutionConfirmation` 落库后容器不重渲染，
  // 确认按钮永远停在未确认态（DetailPanel 五处确认同样修正，见本提交）。
  // 判定本身仍是 store 的 ready 动作（判据只有一份，组件不自比）。
  const confirmed = useAppStore((s) => s.executionConfirmationReady(confirmation));
  const canCreate = submission.ok && !draftFrozen && gate.canSubmit && confirmed;
  const formLocked = busy || pickingSource || draftFrozen;
  // 就近归属来自同一份判据；表单级说明位只在提交判据本身通过时补门禁文案
  const blockedReason = submission.ok ? gate.notice : null;
  const submissionErrors = fieldErrorsOf(submission);
  const errors: CreateRunFieldErrors =
    blockedReason === null ? submissionErrors : { ...submissionErrors, form: blockedReason };

  /** 两模式共用的模型/接入摘要（delta：「两模式 SHALL 显示当前已保存的模型/接入摘要」） */
  const settingsMissing = settings === null || !settings.configured || settings.model === null;
  const settingsSummary =
    settings === null
      ? "运行配置尚未读取"
      : settings.configured && settings.model !== null
        ? `当前模型 ${settings.model}（${settings.baseURL ?? ""}）`
        : "尚未配置运行参数：提交会被拒绝（SETTINGS_NOT_CONFIGURED）";

  const scopeFacts = isolated
    ? {
        execution: `隔离文件运行：只读采集所选目录，按固定 ${ISOLATED_TOOL_PROFILE_LABEL} 工具组（${ISOLATED_TOOL_NAMES.join(" / ")}）执行，副本写入需本次显式勾选；产出带检查点的 v2 根 run。`,
        cost: "一次提交 = 一次真实模型调用（按实际用量计费），采集到的文本会进入你配置的模型请求。",
      }
    : {
        execution:
          "纯对话：空工具表，模型只产出文本；config_hash 按 system + 空工具表计算，产出 v1 根 run。",
        cost: "一次提交 = 一次真实模型调用（按实际用量计费）。",
      };

  /** 确认区展示的内容：全部由事实拼出（`lib/execution-confirmation.ts`），组件不写第二套话术 */
  const confirmationDisclosure = createDisclosure({
    mode: form.mode,
    systemPrompt,
    userMessage,
    modelSummary: settingsSummary,
    sourcePath: form.source?.path ?? null,
    writesAuthorized: form.writesAuthorized,
  });
  const confirmationRows = disclosureLines(confirmationDisclosure);
  const confirmBlocked = confirmed
    ? null
    : !submission.ok
      ? "先补齐必填输入，再核对本次提交"
      : gate.canSubmit
        ? null
        : gate.notice;

  const submit = async (): Promise<void> => {
    // 判据不通过（含待定提交冻结）⇒ 一次 IPC 都不发、也不登记关联
    if (!canCreate) return;
    // U3 任务 3.5：先原子登记提交关联（整份表单的修订 + 快照）⇒ 冻结整份；
    // 已有待定提交时拒绝重复提交。提交值仍由 `lib/create-run.ts` 单一来源构造，
    // 关联经闭包随请求交给 store，收尾由 store 的 createRun 负责（卸载不解冻）。
    const assoc = beginDraftSubmission({
      channel: "create",
      target: CREATE_SUBMIT_TARGET,
      confirmation,
    });
    if (assoc === null) return;
    // canCreate 已通过 ⇒ submitCreateRun 的判据必然同样通过，必定发出请求并由 store 收尾
    await submitCreateRun(
      form,
      { systemPrompt, userMessage, busy },
      {
        createRun: (request) => createRun(request, assoc),
      },
    );
    // U5 任务 3.1 / 4.1：这里交出的只是**输入面**。响应返回不代表运行成功，页面也不
    // 因此收起：结局、列表与草稿清理走 store 的终态消费，是否进入新 run 的概览走导航意图。
  };

  /** 目录选择的请求代次（U3 任务 3.2）：卸载/重开使在飞代次失效，迟到响应不落地 */
  const pickGeneration = useRef(0);

  const pickSource = async (): Promise<void> => {
    if (formLocked) return;
    const generation = ++pickGeneration.current;
    setPickingSource(true);
    try {
      const result = await chooseSource();
      // 迟到守卫：代次已推进（页面重开/卸载）⇒ 不给当前表单安装旧选择
      if (generation !== pickGeneration.current) return;
      // null = 通道失败（已置全局 error）；{canceled:true} = 用户取消
      // （design D4：取消目录选择**保留原引用**，首次取消仍未选）
      if (result !== null && !result.canceled) {
        setForm((prev) => applyChosenSource(prev, result));
        // 镜像到会话级引用：离开/设置往返后再回来可恢复（授权仍复位——applyChosenSource）
        setCreateSourceRef({ token: result.sourceToken, name: result.name, path: result.path });
      }
    } finally {
      if (generation === pickGeneration.current) setPickingSource(false);
    }
  };

  const switchMode = (mode: CreateRunMode): void => {
    // 点击当前模式不清空已选目录；切换模式 = 新的一次隔离操作，目录与授权作废
    if (mode === form.mode) return;
    // 草稿只推进模式：systemPrompt / userMessage 文本保留（任务 1.3 语义）
    writeCreateRunDraft({ mode });
    // U3 任务 3.2（design D4）：切模式清除源目录引用（重新进入隔离模式须重选+重授权）
    setCreateSourceRef(null);
    setForm(switchCreateRunMode(mode));
  };

  /**
   * U3 任务 2.3：显式放弃整份创建草稿（design D3：确认明确目标，取消逐字保留；
   * 放弃 = 模式 / 文本全部重置）。目录与授权属会话引用，一并复位。
   */
  const discardDraft = (): void => {
    if (formLocked) return;
    const current = useAppStore.getState().createRunDraftOf();
    if (current === null || !isCreateRunDraftDirty(current)) return;
    // U3 5.2：放弃确认走真模态（异步）；CAS 按请求时的快照修订校验
    void requestConfirm({
      title: "放弃创建草稿",
      message:
        "放弃本次填写的创建内容？\n\n运行模式、System Prompt 与 User Message 将全部重置（源目录选择与写入授权也一并作废）。",
    }).then((confirmed) => {
      if (!confirmed) return;
      // CAS 按确认请求时的修订校验：等待期间修订推进 ⇒ 放弃不执行
      const discarded = discardCreateRunDraft(current.revision);
      if (!discarded) return;
      setCreateSourceRef(null);
      setForm(initialCreateRunForm());
      // 立即重新登记空表单草稿（新修订），用户可继续输入
      ensureCreateRunDraft();
    });
  };

  return (
    <>
      <CreateRunWorkspaceView
        mode={form.mode}
        userMessage={userMessage}
        systemPrompt={systemPrompt}
        source={form.source}
        writesAuthorized={form.writesAuthorized}
        advancedOpen={advancedOpen}
        errors={errors}
        settingsSummary={settingsSummary}
        settingsMissing={settingsMissing}
        scopeFacts={scopeFacts}
        confirmation={{
          ready: confirmed,
          summary: confirmationDisclosure.summary,
          rows: confirmationRows,
          blocked: confirmBlocked,
        }}
        lock={{
          fields: formLocked,
          draftFrozen,
          busy,
          pickingSource,
          canSubmit: canCreate,
          canDiscard: draftDirty && !formLocked,
        }}
        headingRef={headingRef}
        onMode={switchMode}
        onUserMessage={(text) => writeCreateRunDraft({ userMessage: text })}
        onSystemPrompt={(text) => writeCreateRunDraft({ systemPrompt: text })}
        onPickSource={() => {
          void pickSource();
        }}
        onWrites={(authorized) => setForm((prev) => setWritesAuthorized(prev, authorized))}
        onToggleAdvanced={() => setAdvancedOpen((prev) => !prev)}
        onOpenSettings={onOpenSettings}
        onConfirm={() =>
          armExecutionConfirmation(currentConfirmationBinding("create", CREATE_SUBMIT_TARGET))
        }
        onDiscard={discardDraft}
        onSubmit={() => {
          void submit();
        }}
        onReturn={() => {
          void returnToCreateSource();
        }}
      />
      {/* 请求事实单独一行，与上面的"执行范围/结局说明"分开：错误信封只说明这次提交
          被怎样对待（D4：请求诊断与持久运行结局各自一行，互不覆盖） */}
      {createRunError !== null ? (
        <div className="shrink-0 border-t border-red-200 bg-red-50 px-4 py-1.5 text-[11px] leading-4 text-red-700">
          {createRunError}
        </div>
      ) : null}
    </>
  );
}
