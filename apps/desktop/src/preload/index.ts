import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "../shared/channels";
import type { WindowApi } from "../shared/ipc";

/**
 * 预加载脚本：渲染层与 main 之间唯一的桥。
 *
 * 只暴露受限方法，不暴露 ipcRenderer：
 * - 取数：listRuns / getRun
 * - 写通道：forkRun / promptFork / modelAb / createRun（都只新建 run 文件）
 * - 只读辅助：chooseSource（目录选择签发会话 token）/ forkCapability（隔离分叉预检）
 * - 运行配置三件套：getSettings 只读状态（不含 apiKey）；saveSettings 单向写入；
 *   clearSettings 删除配置
 * 本文件在 sandbox 下运行，因此不引入任何第三方依赖（连通道常量都来自零依赖模块）。
 */
const api: WindowApi = {
  listRuns: () => ipcRenderer.invoke(CHANNELS.listRuns),
  getRun: (id) => ipcRenderer.invoke(CHANNELS.getRun, id),
  forkRun: (request) => ipcRenderer.invoke(CHANNELS.forkRun, request),
  promptFork: (request) => ipcRenderer.invoke(CHANNELS.promptFork, request),
  modelAb: (request) => ipcRenderer.invoke(CHANNELS.modelAb, request),
  createRun: (request) => ipcRenderer.invoke(CHANNELS.createRun, request),
  // workspaces:*（B 1.3/1.5）：目录选择签发 token、隔离分叉只读预检——都不产生 run 文件
  chooseSource: () => ipcRenderer.invoke(CHANNELS.chooseSource),
  forkCapability: (request) => ipcRenderer.invoke(CHANNELS.forkCapability, request),
  getSettings: () => ipcRenderer.invoke(CHANNELS.settingsGet),
  saveSettings: (input) => ipcRenderer.invoke(CHANNELS.settingsSave, input),
  clearSettings: () => ipcRenderer.invoke(CHANNELS.settingsClear),
  proxyStatus: () => ipcRenderer.invoke(CHANNELS.proxyStatus),
  proxyToggle: (input) => ipcRenderer.invoke(CHANNELS.proxyToggle, input),
  proxyFork: (request) => ipcRenderer.invoke(CHANNELS.proxyFork, request),
};

contextBridge.exposeInMainWorld("api", api);
