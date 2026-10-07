import { BrowserWindow } from "electron";
import { CHANNELS } from "../shared/channels";
import { ProxyChangeEventSchema } from "../shared/ipc";
import type { ProxyChangeNotice } from "./proxy-manager";

/**
 * 代理事实变化的**装配层**：把 `ProxyManager` 的只读通知接到所有窗口的
 * `webContents.send`（design D1）。
 *
 * 为什么不放在 `ipc.ts` 里直接 send：
 * - `ipc.ts` 是 `ipcMain.handle` 的注册处，职责是**请求-应答**；本通道是
 *   main 主动推送，不在任何一次 invoke 的生命周期内。
 * - 通知要发给**全部**窗口（多窗口场景下每个 renderer 都得知道），
 *   而 `draft-close-attach.ts` 那套是绑定单个窗口的装配，语义不同。
 *
 * 三条纪律（llm-proxy delta「通知只包含受控元信息」）：
 * 1. **载荷经 schema 严格校验后才发**——manager 是内部代码，但推送面一旦有
 *    bug 就会把不受控字段送进 renderer，校验是最后一道闸；
 * 2. **逐窗口隔离**：某个窗口正在销毁导致 send 抛错，不影响其它窗口，
 *    也不回抛给代理（通知失败绝不能影响转发）；
 * 3. **零主动登记**：这里不碰 `OperationRegistry`、不占执行槽、不调模型。
 *
 * 本文件不被任何测试 import（electron 无法在 vitest 下加载）；
 * 载荷形状由 `ProxyChangeEventSchema` 的单测与 manager 侧的通知用例覆盖。
 */
export function attachProxyChangeBroadcast(proxy: {
  onChange(listener: (notice: ProxyChangeNotice) => void): () => void;
}): () => void {
  return proxy.onChange((notice) => {
    const parsed = ProxyChangeEventSchema.safeParse(notice);
    // 内部通知不合法属于装配 bug：宁可不发，也不用不受控载荷敲 renderer 的门
    if (!parsed.success) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(CHANNELS.proxyChanged, parsed.data);
      } catch {
        // 窗口正在销毁：这次通知发不出去没关系，renderer 重新激活时
        // 会用 `proxy:status` 的 revision 快照补齐（design D1 的补读路径）
      }
    }
  });
}
