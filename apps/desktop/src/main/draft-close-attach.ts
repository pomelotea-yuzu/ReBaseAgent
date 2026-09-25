import { type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain } from "electron";
import { CHANNELS } from "../shared/channels";
import type { Envelope } from "../shared/ipc";
import { DraftCloseGuard } from "./draft-close-guard";

/**
 * U3 关闭协商（design D6）的 electron 装配层：把 ipcMain / BrowserWindow 事件
 * 适配成 `DraftCloseGuard` 的受限数据（webContentsId + frame routingId），
 * 并负责「窗口创建时装配、销毁时解除监听」的生命周期。
 *
 * 本文件不被任何测试 import（electron 无法在 vitest 下加载）；
 * guard 的全部校验逻辑在纯核心 `draft-close-guard.ts` 中单测。
 */

export interface DraftCloseGuardHandle {
  readonly guard: DraftCloseGuard;
  readonly webContentsId: number;
  /** 解除本窗口的全部监听与登记（closed 时自动调用；重复调用安全） */
  dispose: () => void;
}

/** 从事件中提取受限发送者描述；senderFrame 取不到时给 -1（必然不等于主 frame，走拒绝） */
function senderOf(event: IpcMainEvent | IpcMainInvokeEvent): {
  webContentsId: number;
  frameRoutingId: number;
} {
  return {
    webContentsId: event.sender.id,
    frameRoutingId: event.senderFrame?.routingId ?? -1,
  };
}

export function attachDraftCloseGuard(win: BrowserWindow): DraftCloseGuardHandle {
  const guard = new DraftCloseGuard({
    // did-finish-load 后把新文档会话 id 推给 renderer；推送可能早于渲染层订阅，
    // 握手 invoke（draftCloseHandshake）是可靠的兜底交付通道
    onSessionRotated: (target, sessionId) => {
      try {
        win.webContents.send(CHANNELS.draftCloseSession, { sessionId });
      } catch {
        // 窗口可能正在销毁——推送失败不影响会话登记；renderer 重载后握手兜底
      }
    },
    onQueryReleased: (target, sessionId, requestId) => {
      try {
        win.webContents.send(CHANNELS.draftCloseRelease, { sessionId, requestId });
      } catch {
        // 窗口可能正在销毁——释放通知发不出去时 renderer 即将随窗口消失，无需锁释放
      }
    },
  });
  const webContentsId = win.webContents.id;

  const onHandshake = (event: IpcMainInvokeEvent): Envelope<{ sessionId: string }> => {
    const result = guard.handshake(senderOf(event));
    return result.ok
      ? { ok: true, data: { sessionId: result.sessionId } }
      : { ok: false, error: { code: result.reason, message: "关闭协商握手被拒绝" } };
  };
  const onReport = (event: IpcMainEvent, payload: unknown): void => {
    guard.handleReport(senderOf(event), payload);
  };
  const onAnswer = (event: IpcMainEvent, payload: unknown): void => {
    guard.handleAnswer(senderOf(event), payload);
  };
  const onDidFinishLoad = (): void => {
    // 每个文档（含重载）= 新协议会话：旧 sessionId / 序号 / 握手状态全部作废
    guard.rotateSession({
      webContentsId,
      getMainFrameRoutingId: () => win.webContents.mainFrame.routingId,
    });
  };
  const onClosed = (): void => {
    guard.detach(webContentsId);
    disposeIpc();
  };

  ipcMain.handle(CHANNELS.draftCloseHandshake, onHandshake);
  ipcMain.on(CHANNELS.draftCloseReport, onReport);
  ipcMain.on(CHANNELS.draftCloseAnswer, onAnswer);
  win.webContents.on("did-finish-load", onDidFinishLoad);
  win.on("closed", onClosed);

  function disposeIpc(): void {
    ipcMain.removeHandler(CHANNELS.draftCloseHandshake);
    ipcMain.removeListener(CHANNELS.draftCloseReport, onReport);
    ipcMain.removeListener(CHANNELS.draftCloseAnswer, onAnswer);
    win.webContents.removeListener("did-finish-load", onDidFinishLoad);
    win.removeListener("closed", onClosed);
  }

  return {
    guard,
    webContentsId,
    dispose: disposeIpc,
  };
}
