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
import { useAppStore } from "../store";
import { requestConfirm } from "./ConfirmDialog";
import { ModalDialog } from "./ModalDialog";

/**
 * 新建运行对话框：桌面端原生 run 的唯一入口（runs:create）。
 *
 * 两个字段——systemPrompt（可空）与 userMessage（必填）：
 * `run.meta.task` 由 main 侧 runLoop 从首条 user 消息派生（packages/agent-loop
 * /src/run-loop.ts:69），runLoop 无 task 入参，故不提供独立 task 字段。
 *
 * 两种运行模式（分段控件，默认纯对话）：
 * - 纯对话：空工具表，请求里**不带** workspace ⇒ main 走 runCreate（v1）
 * - 隔离文件运行：选源目录 + 本次显式副本写入授权 ⇒ main 走 runCreateIsolated（v2）
 *
 * 授权纪律（B 2.1）：目录与授权都是**本次对话框会话**的状态（`useState`），
 * 每次打开重新开始、切换模式即作废；组件不读也不写任何历史授权记录。
 * 判据与请求构造都在 `lib/create-run.ts`，组件不手拼请求。
 *
 * 一次提交 = 一次真实模型调用（按实际用量计费），因此创建中禁用一切关闭路径。
 */
export function CreateRunDialog({ onClose }: { onClose: () => void }) {
  /**
   * U3 任务 2.3：模式 / System Prompt / User Message 改由**会话创建草稿**驱动
   * （design D1/D3：关闭/设置往返保留；切模式保留文本；显式放弃才重置整份表单）。
   * 本地 state 只保留**本次对话框会话**的授权状态（源目录 + 副本授权）——
   * 那属于 D4 的 sourceToken 引用接线（任务 3.2），不进草稿。
   */
  const draftEntry = useAppStore((s) => s.createRunDraftOf());
  const ensureCreateRunDraft = useAppStore((s) => s.ensureCreateRunDraft);
  const writeCreateRunDraft = useAppStore((s) => s.writeCreateRunDraft);
  const discardCreateRunDraft = useAppStore((s) => s.discardCreateRunDraft);
  const setCreateSourceRef = useAppStore((s) => s.setCreateSourceRef);
  const createRunErrorCode = useAppStore((s) => s.createRunErrorCode);
  const [form, setForm] = useState<CreateRunFormState>(() => ({
    // 首次打开时草稿可能尚未 ensure（挂载 effect 里补）⇒ 退回默认纯对话；
    // 再次打开时草稿已在，模式随之恢复。
    // U3 任务 3.2：源目录引用从**会话级 store 引用**恢复（design D4：同一次未提交
    // 创建可在关闭/设置往返后保留引用）；授权**不**随引用恢复（复位为未选）。
    ...initialCreateRunForm(),
    mode: useAppStore.getState().createRunDraftOf()?.mode ?? "chat",
    source: ((): CreateRunFormState["source"] => {
      const ref = useAppStore.getState().createSourceRef;
      return ref === null ? null : { token: ref.token, name: ref.name, path: ref.path };
    })(),
  }));
  /** 原生目录选择器是否正在打开（阻塞期间同样不允许重复点击/关闭） */
  const [pickingSource, setPickingSource] = useState(false);

  const creatingRun = useAppStore((s) => s.creatingRun);
  const createRunError = useAppStore((s) => s.createRunError);
  const createRun = useAppStore((s) => s.createRun);
  const resetCreateRun = useAppStore((s) => s.resetCreateRun);
  const chooseSource = useAppStore((s) => s.chooseSource);
  const settings = useAppStore((s) => s.settings);

  // 挂载即登记创建草稿（已存在则原样保留——重开不覆盖已有输入）
  useEffect(() => {
    ensureCreateRunDraft();
  }, [ensureCreateRunDraft]);

  // 文本字段直接读草稿（未 ensure 前退回默认值，与 ensure 的初始值一致）
  const systemPrompt = draftEntry?.systemPrompt ?? "";
  const userMessage = draftEntry?.userMessage ?? "";
  const draftDirty = draftEntry !== null && isCreateRunDraftDirty(draftEntry);

  const busy = creatingRun === "in_progress";
  const isolated = form.mode === "isolated_files";
  // U3 任务 3.5：待定提交冻结整份表单（store 侧同时拒绝写入与放弃）——视同忙碌：
  // 输入与全部关闭路径一并禁用，展示状态复位（unmount 的 resetCreateRun）不解冻
  const draftFrozen = useAppStore((s) => s.isDraftFrozen(CREATE_SUBMIT_TARGET));
  const beginDraftSubmission = useAppStore((s) => s.beginDraftSubmission);
  // 禁用判据与将要发出的请求同源（同一个函数），不存在两处口径漂移
  const submission = resolveCreateRunSubmission(form, { systemPrompt, userMessage, busy });
  const canCreate = submission.ok && !draftFrozen;
  const blockedReason = submission.ok ? null : submission.reason;
  const modalLocked = busy || pickingSource || draftFrozen;

  // U3 任务 6.10（design D7）：Esc 关闭只走 ModalDialog 的原生 cancel（单一通道）——
  // 原 window keydown 监听与 cancel 双通道并存，嵌套放弃确认在场时一次按键会
  // **同时**关掉确认与创建对话框（实机 6.10 抓出，同 5.1 设置对话框已删的旧形态）。
  // 忙碌/锁定时由 closeDisabled 吞掉，语义不变。

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
    const created = await submitCreateRun(
      form,
      { systemPrompt, userMessage, busy },
      {
        createRun: (request) => createRun(request, assoc),
      },
    );
    if (created) onClose();
  };

  /** 目录选择的请求代次（U3 任务 3.2）：卸载/重开使在飞代次失效，迟到响应不落地 */
  const pickGeneration = useRef(0);

  const pickSource = async (): Promise<void> => {
    if (modalLocked) return;
    const generation = ++pickGeneration.current;
    setPickingSource(true);
    try {
      const result = await chooseSource();
      // 迟到守卫：代次已推进（对话框重开/卸载）⇒ 不给当前表单安装旧选择
      if (generation !== pickGeneration.current) return;
      // null = 通道失败（已置全局 error）；{canceled:true} = 用户取消
      // （design D4：取消目录选择**保留原引用**，首次取消仍未选）
      if (result !== null && !result.canceled) {
        setForm((prev) => applyChosenSource(prev, result));
        // 镜像到会话级引用：关闭/设置往返后重开可恢复（授权仍复位——applyChosenSource）
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
   * 放弃 = 模式 / 文本全部重置）。目录与授权属本地会话状态，一并复位；
   * 目录引用（design D4：明确放弃创建清除引用）同步清除。
   */
  const discardDraft = (): void => {
    if (modalLocked) return;
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

  const settingsLine =
    settings === null
      ? "运行配置尚未读取"
      : settings.configured && settings.model !== null
        ? `当前模型 ${settings.model}（${settings.baseURL ?? ""}）`
        : "尚未配置运行参数：提交会被拒绝（SETTINGS_NOT_CONFIGURED），请先点右上角“运行配置”";

  return (
    <ModalDialog
      open
      onClose={onClose}
      ariaLabel="新建运行"
      // 创建执行中 / 目录选择中的既有关闭锁：Esc/取消被吞掉（5.1）
      closeDisabled={modalLocked}
      className="flex max-h-[85vh] w-120 flex-col p-4"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-800">新建运行</div>
          <div className="text-[11px] text-gray-500">
            {isolated
              ? `从头执行一个隔离文件 run（固定 ${ISOLATED_TOOL_PROFILE_LABEL} 工具组、无父 run）· 将发起一次真实模型调用`
              : "从头执行一个 run（空工具表、无父 run）· 将发起一次真实模型调用"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={modalLocked}
          className="shrink-0 rounded px-1.5 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="关闭"
        >
          ✕
        </button>
      </div>

      {/* 主体可滚动：窄窗口下长源路径与确认区不遮挡提交按钮（spec 场景「创建与确认在窄窗口可操作」） */}
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-0.5">
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
                disabled={modalLocked}
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

        {isolated ? (
          <div className="space-y-2 rounded border border-gray-200 bg-gray-50 p-2">
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => {
                  void pickSource();
                }}
                disabled={modalLocked}
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
              <li>
                {ISOLATED_TOOL_NAMES.join(" / ")} 工具读出的文本会进入你配置的模型请求。
                <span className="text-gray-500">（{settingsLine}）</span>
              </li>
            </ul>

            <label className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
              <input
                type="checkbox"
                checked={form.writesAuthorized}
                // 未选目录时无可授权的对象；执行中不允许改授权
                disabled={modalLocked || form.source === null}
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

        <label className="block">
          <span className="mb-0.5 block text-[11px] font-medium text-gray-600">
            System Prompt（可选）
          </span>
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
        </label>

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
            本次提交待处理：已按提交时的修订冻结整份表单，请求返回前不可修改、切换模式或放弃。
            无论成功、业务拒绝还是失败，表单内容都保留（待 U5 接入可信操作身份后才自动清理）。
          </div>
        ) : null}

        {busy ? (
          <div className="rounded border-l-2 border-blue-400 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800">
            执行中…（真实调用，请勿关闭应用）
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex shrink-0 items-center justify-end gap-2">
        <button
          type="button"
          onClick={discardDraft}
          disabled={modalLocked || !draftDirty}
          title={draftDirty ? undefined : "尚无修改可放弃"}
          className="mr-auto rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          放弃填写内容
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={modalLocked}
          className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => {
            void submit();
          }}
          disabled={!canCreate}
          className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "创建中…" : isolated ? "创建隔离运行" : "创建"}
        </button>
      </div>
    </ModalDialog>
  );
}
