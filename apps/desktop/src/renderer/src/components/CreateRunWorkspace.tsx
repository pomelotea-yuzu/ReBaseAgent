import { useEffect, useRef, useState } from "react";
import {
  CREATE_RUN_MODES,
  CREATE_RUN_MODE_LABELS,
  ISOLATED_TOOL_NAMES,
  ISOLATED_TOOL_PROFILE_LABEL,
  applyChosenSource,
  initialCreateRunForm,
  resolveCreateRunSubmission,
  setWritesAuthorized,
  submitCreateRun,
  switchCreateRunMode,
} from "../lib/create-run";
import type { CreateRunFormState } from "../lib/create-run";
import { isCreateRunDraftDirty } from "../lib/debugging-drafts";
import { CREATE_SUBMIT_TARGET } from "../lib/draft-submission";
import { deriveEntryGate } from "../lib/entry-gate";
import { useAppStore } from "../store";
import { requestConfirm } from "./ConfirmDialog";
import { FOCUS_RING } from "./IconButton";

/**
 * 新建运行**工作区页面**（U5 任务 4.1：由覆盖模态迁为主工作区的一个视图）。
 *
 * 桌面端原生 run 的唯一创建通道仍是 `runs:create`；两个字段（systemPrompt 可空 /
 * userMessage 必填）与两种模式（默认纯对话 / 隔离文件运行）都不变：
 * - 纯对话：空工具表，请求里**不带** workspace ⇒ main 走 runCreate（v1）
 * - 隔离文件运行：选源目录 + 本次显式副本写入授权 ⇒ main 走 runCreateIsolated（v2）
 * 判据与请求构造都在 `lib/create-run.ts`，组件不手拼请求。
 *
 * 与旧对话框的三点差别（都写在 delta 里，不是顺手改的）：
 * 1. **不锁整窗**：提交后允许切运行、阅读文件、去设置——执行事实与草稿冻结由 store 判，
 *    页面只做"这一份草稿此刻不可改"的就近呈现（旧模态的 `closeDisabled` 全窗锁作废）。
 * 2. **有来源可回**：页头「返回来源」走 `returnToCreateSource`，位置引用只在 renderer
 *    会话里（`lib/create-workspace.ts`），与草稿互不决定。
 * 3. **响应不宣布成功**：提交返回只代表这次请求明确回了话，运行结局、列表刷新、
 *    草稿清理与是否进入概览全部归 store 的终态消费与导航意图（任务 3.1–3.4）。
 *
 * 授权纪律不变：目录与授权都是**本次会话**的引用（`createSourceRef` 由 store 持有、
 * 关闭/设置往返可恢复，切模式与明确放弃即作废），组件不读也不写任何历史授权记录。
 */
export function CreateRunWorkspace() {
  /**
   * U3 任务 2.3：模式 / System Prompt / User Message 由**会话创建草稿**驱动
   * （design D1/D3：离开再回来恢复；切模式保留文本；显式放弃才重置整份表单）。
   * 本地 state 只保留**表单的会话形态**（源目录引用镜像 + 副本授权）——
   * 那属于 D4 的 sourceToken 引用接线，不进草稿。
   */
  const draftEntry = useAppStore((s) => s.createRunDraftOf());
  const ensureCreateRunDraft = useAppStore((s) => s.ensureCreateRunDraft);
  const writeCreateRunDraft = useAppStore((s) => s.writeCreateRunDraft);
  const discardCreateRunDraft = useAppStore((s) => s.discardCreateRunDraft);
  const setCreateSourceRef = useAppStore((s) => s.setCreateSourceRef);
  const createRunErrorCode = useAppStore((s) => s.createRunErrorCode);
  const returnToCreateSource = useAppStore((s) => s.returnToCreateSource);
  const [form, setForm] = useState<CreateRunFormState>(() => ({
    // 首次进入时草稿可能尚未 ensure（挂载 effect 里补）⇒ 退回默认纯对话；
    // 再次进入时草稿已在，模式随之恢复。
    ...initialCreateRunForm(),
    mode: useAppStore.getState().createRunDraftOf()?.mode ?? "chat",
    source: ((): CreateRunFormState["source"] => {
      const ref = useAppStore.getState().createSourceRef;
      return ref === null ? null : { token: ref.token, name: ref.name, path: ref.path };
    })(),
  }));
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

  // 页头标题是进入本页时的初始焦点（D8：创建是页面，不做焦点禁闭，但要把"你在哪儿"给到）
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // 挂载即登记创建草稿（已存在则原样保留——重开不覆盖已有输入）
  useEffect(() => {
    ensureCreateRunDraft();
    headingRef.current?.focus();
  }, [ensureCreateRunDraft]);

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
  // 禁用判据与将要发出的请求同源（同一个函数），不存在两处口径漂移
  const submission = resolveCreateRunSubmission(form, { systemPrompt, userMessage, busy });
  // U4 任务 4.3：入口可用性从**统一操作槽**派生（不再只看本地 in_progress）。
  // 只禁"提交"——门禁拦下属于"这次发不出去"，不该顺手把输入也锁住（那是自己那次
  // 提交在飞时草稿冻结要做的事）。
  const gate = deriveEntryGate(useAppStore((s) => s.operations));
  const canCreate = submission.ok && !draftFrozen && gate.canSubmit;
  const blockedReason = submission.ok ? gate.notice : submission.reason;
  const formLocked = busy || pickingSource || draftFrozen;

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

  const submit = async (): Promise<void> => {
    // 判据不通过（含待定提交冻结）⇒ 一次 IPC 都不发、也不登记关联
    if (!canCreate) return;
    // U3 任务 3.5：先原子登记提交关联（整份表单的修订 + 快照）⇒ 冻结整份；
    // 已有待定提交时拒绝重复提交。提交值仍由 `lib/create-run.ts` 单一来源构造，
    // 关联经闭包随请求交给 store，收尾由 store 的 createRun 负责（卸载不解冻）。
    const assoc = beginDraftSubmission({ channel: "create", target: CREATE_SUBMIT_TARGET });
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

  const switchMode = (mode: (typeof CREATE_RUN_MODES)[number]): void => {
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

  /** 两模式共用的模型/接入摘要（delta：「两模式 SHALL 显示当前已保存的模型/接入摘要」） */
  const settingsSummary =
    settings === null
      ? "运行配置尚未读取"
      : settings.configured && settings.model !== null
        ? `当前模型 ${settings.model}（${settings.baseURL ?? ""}）`
        : "尚未配置运行参数：提交会被拒绝（SETTINGS_NOT_CONFIGURED），请先在右上角「运行配置」填好";

  return (
    <section
      aria-label="新建运行"
      className="flex min-w-0 flex-1 flex-col bg-white"
      data-create-workspace
    >
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-gray-200 px-4 py-2">
        <div className="min-w-0">
          <h1 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-gray-800">
            新建运行
          </h1>
          <div className="text-[11px] text-gray-500">
            {isolated
              ? `从头执行一个隔离文件 run（固定 ${ISOLATED_TOOL_PROFILE_LABEL} 工具组、无父 run）· 将发起一次真实模型调用`
              : "从头执行一个 run（空工具表、无父 run）· 将发起一次真实模型调用"}
          </div>
        </div>
        <button
          type="button"
          // 返回来源不挑时机：草稿与它的冻结一起留在会话里，回来仍是原样
          onClick={() => {
            void returnToCreateSource();
          }}
          data-return-to-source
          className={`shrink-0 rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          返回来源
        </button>
      </div>

      {/* 正文单列、上限 800px（design D1）：窄窗口下长源路径与确认区不遮挡提交按钮 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-200 space-y-2.5 px-4 py-3">
          <div>
            <span className="mb-1 block text-[11px] font-medium text-gray-600">运行模式</span>
            {/* 与运行列表的来源过滤同形：一组 aria-pressed 按钮，不额外声明 role */}
            <div className="flex items-center gap-1">
              {CREATE_RUN_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={form.mode === mode}
                  onClick={() => switchMode(mode)}
                  disabled={formLocked}
                  className={`flex-1 rounded border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
                    form.mode === mode
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {CREATE_RUN_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
          </div>

          {/* 任务优先：User Message 是这份表单的主字段，也是新 run 的列表标题 */}
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-medium text-gray-600">
              User Message（必填）
            </span>
            <textarea
              value={userMessage}
              onChange={(e) => writeCreateRunDraft({ userMessage: e.target.value })}
              placeholder="要交给模型的任务。它会同时成为该 run 在列表中的标题。"
              spellCheck={false}
              rows={5}
              disabled={draftFrozen}
              className="w-full resize-y rounded border border-gray-300 px-2 py-1 font-code text-xs outline-none focus:border-blue-400 disabled:bg-gray-50"
            />
            <span className="mt-0.5 block text-[11px] text-gray-500">
              该 run 在列表中的标题（task）即这段文字。
            </span>
          </label>

          {isolated ? (
            <div className="space-y-2 rounded border border-gray-200 bg-gray-50 p-2">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void pickSource();
                  }}
                  disabled={formLocked}
                  className="shrink-0 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {pickingSource ? "选择中…" : form.source === null ? "选择目录…" : "重新选择…"}
                </button>
                <div className="min-w-0 flex-1">
                  {form.source === null ? (
                    <div className="text-[11px] text-gray-500">尚未选择源目录</div>
                  ) : (
                    <>
                      <div className="truncate text-[11px] font-medium text-gray-700">
                        {form.source.name}
                      </div>
                      {/* 长路径换行而非截断：用户需要核对到底选了哪个目录 */}
                      <div className="break-all font-code text-[11px] leading-4 text-gray-500">
                        {form.source.path}
                      </div>
                    </>
                  )}
                </div>
              </div>

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
                  checked={form.writesAuthorized}
                  // 未选目录时无可授权的对象；本次提交待定期间不允许改授权
                  disabled={formLocked || form.source === null}
                  onChange={(e) => setForm((prev) => setWritesAuthorized(prev, e.target.checked))}
                  className="mt-0.5 shrink-0"
                />
                <span className="text-[11px] leading-4 text-amber-900">
                  允许本次执行的副本写入
                  <span className="text-amber-700">
                    （默认未选；只对这一次提交有效，重新打开或切换模式后都要重新勾选）
                  </span>
                </span>
              </label>
            </div>
          ) : null}

          {/* 两模式共用的模型/接入摘要：执行要花多少钱取决于接的是哪个模型，就近可读 */}
          <div className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-[11px] leading-4 text-gray-600">
            <span className="font-medium text-gray-700">当前接入：</span>
            {settingsSummary}
            <span className="text-gray-500">
              （{isolated ? "隔离运行的工具读取文本同样进入该模型请求" : "纯对话不带工具表"}）
            </span>
          </div>

          <div className="rounded border border-gray-200">
            <button
              type="button"
              aria-expanded={advancedOpen ? "true" : "false"}
              onClick={() => setAdvancedOpen((prev) => !prev)}
              className={`w-full rounded px-2 py-1.5 text-left text-[11px] font-medium text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
              data-advanced-toggle
            >
              高级：System Prompt（可选）
            </button>
            {advancedOpen ? (
              <div className="border-t border-gray-200 px-2 pb-2 pt-1.5">
                <textarea
                  value={systemPrompt}
                  onChange={(e) => writeCreateRunDraft({ systemPrompt: e.target.value })}
                  placeholder="例如：你是一个简洁的问答助手，用两三句话回答。"
                  spellCheck={false}
                  rows={3}
                  disabled={draftFrozen}
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

          {/* 提交被挡的原因：文字表达，不靠颜色 */}
          {blockedReason !== null && !busy ? (
            <div className="rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-800">
              {blockedReason}
            </div>
          ) : null}

          {createRunError !== null ? (
            <div className="rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-700">
              {createRunError}
            </div>
          ) : null}

          {draftFrozen ? (
            <div className="rounded border-l-2 border-violet-400 bg-violet-50 px-2 py-1.5 text-[11px] leading-4 text-violet-800">
              本次提交待处理：已按提交时的修订冻结这份表单，请求返回前不可修改、切换模式或放弃。
              期间切运行、阅读文件、打开设置都不受影响；无论成功、业务拒绝还是失败，表单内容都保留，
              只有核实到自有正常终止才按提交时的修订清理。
            </div>
          ) : null}

          {busy ? (
            <div className="rounded border-l-2 border-blue-400 bg-blue-50 px-2 py-1.5 text-[11px] leading-4 text-blue-800">
              创建请求已明确返回，运行仍在进行：结局与结果由右上角「操作」面板核对，
              留在本页不会挡住它。
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 border-t border-gray-200 pt-3">
            <button
              type="button"
              onClick={discardDraft}
              disabled={formLocked || !draftDirty}
              title={draftDirty ? undefined : "尚无修改可放弃"}
              className="mr-auto rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              放弃填写内容
            </button>
            <button
              type="button"
              onClick={() => {
                void submit();
              }}
              disabled={!canCreate}
              className={`rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
            >
              {busy ? "创建中…" : isolated ? "创建隔离运行" : "创建"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
