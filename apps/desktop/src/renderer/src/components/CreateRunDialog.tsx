import { useEffect, useState } from "react";
import { useAppStore } from "../store";

/**
 * 新建运行对话框：桌面端原生 run 的唯一入口（runs:create）。
 *
 * 只有两个字段——systemPrompt（可空）与 userMessage（必填）：
 * `run.meta.task` 由 main 侧 runLoop 从首条 user 消息派生（packages/agent-loop
 * /src/run-loop.ts:69），runLoop 无 task 入参，故不提供独立 task 字段。
 *
 * 一次提交 = 一次真实模型调用（按实际用量计费），因此创建中禁用一切关闭路径。
 */
export function CreateRunDialog({ onClose }: { onClose: () => void }) {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userMessage, setUserMessage] = useState("");

  const creatingRun = useAppStore((s) => s.creatingRun);
  const createRunError = useAppStore((s) => s.createRunError);
  const createRun = useAppStore((s) => s.createRun);
  const resetCreateRun = useAppStore((s) => s.resetCreateRun);

  const busy = creatingRun === "in_progress";
  const canCreate = userMessage.trim().length > 0 && !busy;

  // Esc 关闭对话框；创建中不响应（真实调用已在飞，关掉只会丢状态）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // 卸载时复位（下次打开不残留上次的报错与进行中状态）
  useEffect(() => {
    return () => resetCreateRun();
  }, [resetCreateRun]);

  const submit = async (): Promise<void> => {
    if (!canCreate) return;
    const created = await createRun(systemPrompt, userMessage);
    if (created) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
      <dialog
        open
        aria-label="新建运行"
        onCancel={(e) => e.preventDefault()}
        className="relative m-0 w-120 max-w-full rounded-lg border border-gray-200 bg-white p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-gray-800">新建运行</div>
            <div className="text-[11px] text-gray-500">
              从头执行一个 run（空工具表）· 将发起一次真实模型调用
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-1.5 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2.5">
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
                留空也可以：此时 config_hash 按空 system 计算，仍可作为分叉与 A/B 的父本。
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
        </div>

        {createRunError !== null ? (
          <div className="mt-3 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-700">
            {createRunError}
          </div>
        ) : null}

        {busy ? (
          <div className="mt-3 rounded border-l-2 border-blue-400 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800">
            执行中…（真实调用，请勿关闭应用）
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
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
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
