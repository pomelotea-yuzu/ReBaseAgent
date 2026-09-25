import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { BrowserWindow } from "electron";

/**
 * U3 任务 6.6 的实机注入钩子（dev-only，与 `REBASEAGENT_SMOKE_QUIT_FILE` 同族）。
 *
 * 用途：崩溃与「系统会话结束」无法从外部真触发——
 * - renderer 崩溃：Windows 上没有外部路径调 `forcefullyCrashRenderer()`；
 * - 注销/关机产生的 `query-session-end` / `session-end`：**绝不真触发宿主机注销**，
 *   用哨兵文件让 main 在测试窗口上**合成**这两个事件（Electron 内部即按该事件名派发）。
 *
 * 语义边界（design D6，勿破坏）：
 * - 本文件**只发起/合成事件，不注册任何监听**——产品对系统会话结束事件零接入的契约
 *   （`draft-close-flow.test.ts` 的源码契约）在此不因验收而失守；合成的事件因无人监听
 *   而无任何效果，这本身就是「系统会话结束不沿用普通退出承诺」要核对的边界。
 * - 动作白名单外的内容一律不执行；未设置环境变量时 index.ts 不调用本模块入口。
 */

/** 钩子所需的最小窗口面（真实传入 BrowserWindow；单测注入假对象） */
export type SmokeEventWindow = Pick<BrowserWindow, "isDestroyed"> & {
  readonly webContents: Pick<BrowserWindow["webContents"], "forcefullyCrashRenderer">;
  emit(eventName: string, ...args: unknown[]): boolean;
};

/** 允许的动作：renderer 真崩溃 / 合成两种系统会话结束事件 */
export type SmokeEventAction = "crash-renderer" | "query-session-end" | "session-end";

/** 执行一个动作；白名单外返回 false 且零副作用（不抛错，验收脚本按返回值核对） */
export function applySmokeEventAction(action: string, win: SmokeEventWindow): boolean {
  switch (action) {
    case "crash-renderer":
      win.webContents.forcefullyCrashRenderer();
      return true;
    case "query-session-end":
    case "session-end":
      // 合成事件因产品侧零监听而必然无效果——「不沿用普通退出承诺」正是拿这个边界核对。
      // 载荷带 preventDefault 面（真实监听者会用它延迟结束）
      win.emit(action, { preventDefault: () => {}, defaultPrevented: false, reasons: [] });
      return true;
    default:
      return false;
  }
}

/**
 * 安装哨兵文件轮询（250ms，与 quit 钩子同节奏）：文件出现 ⇒ 读取动作、删除文件。
 * 窗口在场才执行动作；窗口不在（null）时同样消费哨兵（避免下次误触发）。
 * 返回解绑函数。
 */
export function installSmokeEventHook(
  sentinelPath: string,
  getWindow: () => SmokeEventWindow | null,
  intervalMs = 250,
): () => void {
  const timer = setInterval(() => {
    if (!existsSync(sentinelPath)) return;
    let action = "";
    try {
      action = readFileSync(sentinelPath, "utf8").trim();
      unlinkSync(sentinelPath);
    } catch {
      // 并发触发（已被上一轮读走）：本次不动作
      return;
    }
    const win = getWindow();
    if (win === null || win.isDestroyed()) return;
    applySmokeEventAction(action, win);
  }, intervalMs);
  return () => clearInterval(timer);
}
