import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "../shared/channels";
import type { WindowApi } from "../shared/ipc";

/**
 * 预加载脚本：渲染层与 main 之间唯一的桥。
 *
 * 只暴露受限方法，不暴露 ipcRenderer：
 * - 取数：listRuns / getRun
 * - 唯一写通道：forkRun（只新建 fork run 文件）
 * - 运行配置三件套：getSettings 只读状态（不含 apiKey）；saveSettings 单向写入；
 *   clearSettings 删除配置
 * 本文件在 sandbox 下运行，因此不引入任何第三方依赖（连通道常量都来自零依赖模块）。
 */
const api: WindowApi = {
  listRuns: () => ipcRenderer.invoke(CHANNELS.listRuns),
  getRun: (id) => ipcRenderer.invoke(CHANNELS.getRun, id),
  forkRun: (request) => ipcRenderer.invoke(CHANNELS.forkRun, request),
  promptFork: (request) => ipcRenderer.invoke(CHANNELS.promptFork, request),
  getSettings: () => ipcRenderer.invoke(CHANNELS.settingsGet),
  saveSettings: (input) => ipcRenderer.invoke(CHANNELS.settingsSave, input),
  clearSettings: () => ipcRenderer.invoke(CHANNELS.settingsClear),
  proxyStatus: () => ipcRenderer.invoke(CHANNELS.proxyStatus),
  proxyToggle: (input) => ipcRenderer.invoke(CHANNELS.proxyToggle, input),
  proxyFork: (request) => ipcRenderer.invoke(CHANNELS.proxyFork, request),
};

contextBridge.exposeInMainWorld("api", api);
