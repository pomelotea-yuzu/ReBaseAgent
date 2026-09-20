import { useEffect, useState } from "react";
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
import { useAppStore } from "../store";

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
  const [form, setForm] = useState(initialCreateRunForm);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userMessage, setUserMessage] = useState("");
  /** 原生目录选择器是否正在打开（阻塞期间同样不允许重复点击/关闭） */
  const [pickingSource, setPickingSource] = useState(false);

  const creatingRun = useAppStore((s) => s.creatingRun);
  const createRunError = useAppStore((s) => s.createRunError);
  const createRun = useAppStore((s) => s.createRun);
  const resetCreateRun = useAppStore((s) => s.resetCreateRun);
  const chooseSource = useAppStore((s) => s.chooseSource);
  const settings = useAppStore((s) => s.settings);

  const busy = creatingRun === "in_progress";
  const isolated = form.mode === "isolated_files";
  // 禁用判据与将要发出的请求同源（同一个函数），不存在两处口径漂移
  const submission = resolveCreateRunSubmission(form, { systemPrompt, userMessage, busy });
  const canCreate = submission.ok;
  const blockedReason = submission.ok ? null : submission.reason;
  const modalLocked = busy || pickingSource;

  // Esc 关闭对话框；创建中/选目录中不响应（真实调用已在飞，关掉只会丢状态）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !modalLocked) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, modalLocked]);

  // 卸载时复位（下次打开不残留上次的报错与进行中状态）
  useEffect(() => {
    return () => resetCreateRun();
  }, [resetCreateRun]);

  const submit = async (): Promise<void> => {
    // 判据不通过时 submitCreateRun 直接返回 false：一次 IPC 都不会发
    const created = await submitCreateRun(form, { systemPrompt, userMessage, busy }, { createRun });
    if (created) onClose();
  };

  const pickSource = async (): Promise<void> => {
    if (modalLocked) return;
    setPickingSource(true);
    try {
      const result = await chooseSource();
      // null = 通道失败（已置全局 error）；{canceled:true} = 用户取消（状态原样不动）
      if (result !== null) setForm((prev) => applyChosenSource(prev, result));
    } finally {
      setPickingSource(false);
    }
  };

  const switchMode = (mode: (typeof CREATE_RUN_MODES)[number]): void => {
    // 点击当前模式不清空已选目录；切换模式 = 新的一次隔离操作，目录与授权作废
    if (mode === form.mode) return;
    setForm(switchCreateRunMode(mode));
  };

  const settingsLine =
    settings === null
      ? "运行配置尚未读取"
      : settings.configured && settings.model !== null
        ? `当前模型 ${settings.model}（${settings.baseURL ?? ""}）`
        : "尚未配置运行参数：提交会被拒绝（SETTINGS_NOT_CONFIGURED），请先点右上角“运行配置”";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
      <dialog
        open
        aria-label="新建运行"
        onCancel={(e) => e.preventDefault()}
        className="relative m-0 flex max-h-[85vh] w-120 max-w-full flex-col rounded-lg border border-gray-200 bg-white p-4 shadow-xl"
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
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="例如：你是一个简洁的问答助手，用两三句话回答。"
              spellCheck={false}
              rows={3}
              className="w-full resize-y rounded border border-gray-300 px-2 py-1 font-code text-xs outline-none focus:border-blue-400"
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
              onChange={(e) => setUserMessage(e.target.value)}
              placeholder="要交给模型的任务。它会同时成为该 run 在列表中的标题。"
              spellCheck={false}
              rows={5}
              className="w-full resize-y rounded border border-gray-300 px-2 py-1 font-code text-xs outline-none focus:border-blue-400"
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

          {busy ? (
            <div className="rounded border-l-2 border-blue-400 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800">
              执行中…（真实调用，请勿关闭应用）
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex shrink-0 items-center justify-end gap-2">
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
      </dialog>
    </div>
  );
}
