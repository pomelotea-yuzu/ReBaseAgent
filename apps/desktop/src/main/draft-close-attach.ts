import {
  type BrowserWindow,
  type Event,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  dialog,
  ipcMain,
} from "electron";
import { CHANNELS } from "../shared/channels";
import type { Envelope } from "../shared/ipc";
import { DraftCloseFlow } from "./draft-close-flow";
import { DraftCloseGuard } from "./draft-close-guard";

/**
 * U3 关闭协商（design D6）的 electron 装配层：把 ipcMain / BrowserWindow 事件
 * 适配成 `DraftCloseGuard`（受限数据：webContentsId + frame routingId）与
 * `DraftCloseFlow`（关闭决策流），并负责「窗口创建时装配、销毁时解除监听」。
 *
 * 本文件不被任何测试 import（electron 无法在 vitest 下加载）；
 * 校验逻辑在纯核心 `draft-close-guard.ts`、决策逻辑在纯核心 `draft-close-flow.ts`
 * 中单测；实机行为由 §6 承载。
 */

export interface DraftCloseGuardHandle {
  readonly guard: DraftCloseGuard;
  readonly flow: DraftCloseFlow;
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

/** 原生确认文案（design D6 第 3/4 步：默认/取消 = 返回；不诊断存活状态） */
function confirmOptions(
  kind: "dirty" | "unknown",
  pendingLoss: boolean,
): { title: string; message: string; detail: string } {
  const lossNote = pendingLoss
    ? " 此外，先前会话的调试草稿可能已经丢失（该会话在退出或重载前未能完成核对）。"
    : "";
  if (kind === "dirty") {
    return {
      title: "退出 ReBaseAgent",
      message: "有未放弃的调试草稿",
      detail: `本轮会话中已输入的调试草稿在退出后将丢失，且无法恢复。要继续编辑请选择「返回」。${lossNote}`,
    };
  }
  return {
    title: "退出 ReBaseAgent",
    message: "暂时无法确认草稿状态",
    detail: `暂时无法确认草稿状态，不能确定是否有未放弃的编辑。选择「返回」可继续使用应用，稍后再次退出时会重新核对。${lossNote}`,
  };
}

export function attachDraftCloseGuard(win: BrowserWindow): DraftCloseGuardHandle {
  let flow: DraftCloseFlow | null = null;
  const guard = new DraftCloseGuard({
    // did-finish-load 后把新文档会话 id 推给 renderer；推送可能早于渲染层订阅，
    // 握手 invoke（draftCloseHandshake）是可靠的兜底交付通道
    onSessionRotated: (_target, sessionId) => {
      try {
        win.webContents.send(CHANNELS.draftCloseSession, { sessionId });
      } catch {
        // 窗口可能正在销毁——推送失败不影响会话登记；renderer 重载后握手兜底
      }
    },
    onQueryReleased: (_target, sessionId, requestId) => {
      try {
        win.webContents.send(CHANNELS.draftCloseRelease, { sessionId, requestId });
      } catch {
        // 窗口可能正在销毁——释放通知发不出去时 renderer 即将随窗口消失，无需锁释放
      }
    },
    onAnswerAccepted: (webContentsId, answer) => {
      // 只有通过全部校验的应答才会到达决策流（伪造/迟到应答已在 guard 被拒）
      flow?.notifyAnswer(answer);
      void webContentsId;
    },
  });
  const webContentsId = win.webContents.id;

  flow = new DraftCloseFlow(
    webContentsId,
    guard,
    {
      sendQuery: (query) => {
        try {
          win.webContents.send(CHANNELS.draftCloseQuery, query);
        } catch {
          // 窗口可能正在销毁——查询发不出，决策流将走 unknown 降级（4.5 超时兜底）
        }
      },
      showConfirm: async (kind) => {
        const opts = confirmOptions(kind, guard.hasPendingLoss());
        const { response } = await dialog.showMessageBox(win, {
          type: "warning",
          buttons: ["返回", "退出并丢弃草稿"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          ...opts,
        });
        return response === 1 ? "quit" : "return";
      },
      closeWindow: () => {
        win.close();
      },
      sendRelease: (sessionId, requestId) => {
        try {
          win.webContents.send(CHANNELS.draftCloseRelease, { sessionId, requestId });
        } catch {
          // 同 onQueryReleased：窗口销毁中，无需释放通知
        }
      },
    },
    // 会话丢失遗留标志参与 clean 判定（4.7）；用户返回时由 flow 确认清除
    { hasPendingLoss: () => guard.hasPendingLoss() },
  );

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
  const onRenderProcessGone = (): void => {
    // 任务 4.7：renderer 崩溃 ⇒ 旧会话状态永久不明，直接置遗留标志
    // （崩溃后不一定重载，不能只依赖 did-finish-load 轮换评估）
    guard.markPendingLoss();
  };
  const onClose = (event: Event): void => {
    // U3 4.4：标题栏关闭 / Alt+F4 都走这里。bypass 在手 → 放行（一次性）；
    // 否则阻止默认关闭并启动协商（连续触发时决策流复用当前流程）
    if (flow.interceptClose()) return;
    event.preventDefault();
  };
  const onClosed = (): void => {
    guard.detach(webContentsId);
    disposeIpc();
  };

  ipcMain.handle(CHANNELS.draftCloseHandshake, onHandshake);
  ipcMain.on(CHANNELS.draftCloseReport, onReport);
  ipcMain.on(CHANNELS.draftCloseAnswer, onAnswer);
  win.webContents.on("did-finish-load", onDidFinishLoad);
  win.webContents.on("render-process-gone", onRenderProcessGone);
  win.on("close", onClose);
  win.on("closed", onClosed);

  function disposeIpc(): void {
    ipcMain.removeHandler(CHANNELS.draftCloseHandshake);
    ipcMain.removeListener(CHANNELS.draftCloseReport, onReport);
    ipcMain.removeListener(CHANNELS.draftCloseAnswer, onAnswer);
    // 窗口销毁后 `win.webContents` 上的任何调用都会抛 "Object has been destroyed"
    // （U3 6.4 实测：closed → disposeIpc 的主进程未捕获异常弹出错误框，把一次干净退出
    //   变成了"确认框"）。webContents 的监听器与其同生命周期，销毁后已无处可解绑。
    if (!win.isDestroyed()) {
      win.webContents.removeListener("did-finish-load", onDidFinishLoad);
      win.webContents.removeListener("render-process-gone", onRenderProcessGone);
    }
    win.removeListener("close", onClose);
    win.removeListener("closed", onClosed);
  }

  return {
    guard,
    flow,
    webContentsId,
    dispose: disposeIpc,
  };
}
