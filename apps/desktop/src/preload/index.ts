import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "../shared/channels";
import type { WindowApi } from "../shared/ipc";

/**
 * 预加载脚本：渲染层与 main 之间唯一的桥。
 *
 * 只暴露两个取数方法，不暴露 ipcRenderer、不暴露任何写通道。
 * 本文件在 sandbox 下运行，因此不引入任何第三方依赖（连通道常量都来自零依赖模块）。
 */
const api: WindowApi = {
  listRuns: () => ipcRenderer.invoke(CHANNELS.listRuns),
  getRun: (id) => ipcRenderer.invoke(CHANNELS.getRun, id),
};

contextBridge.exposeInMainWorld("api", api);
