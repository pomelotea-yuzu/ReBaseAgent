import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";

/**
 * U3 任务 5.2（design D7）：放弃确认的**真模态**包装。
 *
 * - `requestConfirm(req)` 返回 Promise<boolean>：确认=true、取消/Esc=false；
 *   放弃确认从 `window.confirm`（同步、阻塞主线程、无 top layer 语义）迁到
 *   `showModal` 模态——Esc 只关最上层、背景 inert、焦点禁闭与恢复由 ModalDialog 承担；
 * - 全应用单实例 `ConfirmDialogHost`（App 挂载）：同一时刻至多一个确认；
 *   确认等待期间再来请求直接拒绝（false）——放弃确认从不排队叠加；
 * - 初始焦点在「取消」按钮（破坏性动作的安全缺省：回车/失焦误触不删除）；
 * - ⚠️ 确认是**异步**的：确认等待期间草稿修订可能推进。各放弃执行点必须沿用
 *   修订 CAS（按确认请求时的快照 revision 校验）——「确认等待期间如目标修订
 *   已变，旧确认不能删除新修订」由此保证（design D3）。
 */

export interface ConfirmRequest {
  /** 模态标题（短） */
  title: string;
  /** 正文（保留换行：草稿内容摘要在此展示） */
  message: string;
  /** 确认按钮文字（缺省「确认放弃」） */
  confirmLabel?: string;
}

interface PendingConfirm {
  req: ConfirmRequest;
  resolve: (ok: boolean) => void;
}

let pendingConfirm: PendingConfirm | null = null;
const confirmListeners = new Set<() => void>();

export function requestConfirm(req: ConfirmRequest): Promise<boolean> {
  // 单实例纪律：已有确认挂起时直接拒绝新请求（调用方拿 false = 取消语义）
  if (pendingConfirm !== null) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    pendingConfirm = { req, resolve };
    for (const listener of confirmListeners) listener();
  });
}

/**
 * 确认宿主（App 层单例挂载）。无挂起确认时不渲染任何内容。
 */
export function ConfirmDialogHost() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listener = (): void => {
      force();
    };
    confirmListeners.add(listener);
    return () => {
      confirmListeners.delete(listener);
    };
  }, []);

  const pending = pendingConfirm;
  const settle = useCallback((ok: boolean): void => {
    const current = pendingConfirm;
    pendingConfirm = null;
    current?.resolve(ok);
    force();
  }, []);

  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    // pending 出现 → 打开模态；消失 → 关闭（settle 已清 pending）
    setDialogOpen(pending !== null);
  }, [pending]);

  if (pending === null) return null;
  return (
    <ModalDialog
      open={dialogOpen}
      onClose={() => {
        settle(false);
      }}
      ariaLabel={pending.req.title}
      initialFocusRef={cancelRef}
      className="w-100 p-4"
    >
      <div className="text-sm font-semibold text-gray-800">{pending.req.title}</div>
      <div className="mt-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-gray-600">
        {pending.req.message}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={() => {
            settle(false);
          }}
          className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => {
            settle(true);
          }}
          className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs text-red-700 hover:bg-red-100"
        >
          {pending.req.confirmLabel ?? "确认放弃"}
        </button>
      </div>
    </ModalDialog>
  );
}
