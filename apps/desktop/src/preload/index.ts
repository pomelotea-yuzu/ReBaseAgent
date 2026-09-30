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
 *   / inspectWorkspace / readWorkspaceFile（文件清单与内容，C 1.1）
 * - 运行配置三件套：getSettings 只读状态（不含 apiKey）；saveSettings 单向写入；
 *   clearSettings 删除配置
 * 本文件在 sandbox 下运行，因此不引入任何第三方依赖（连通道常量都来自零依赖模块）。
 */
const api: WindowApi = {
  listRuns: () => ipcRenderer.invoke(CHANNELS.listRuns),
  getRun: (id) => ipcRenderer.invoke(CHANNELS.getRun, id),
  // runs:compare（U7 只读比较）：载荷原样透传——请求/响应 schema 校验在 main 侧，
  // renderer 侧另有身份/顺序/完整性核对（design D3 双端验证）
  compareRuns: (request) => ipcRenderer.invoke(CHANNELS.compareRuns, request),
  forkRun: (request) => ipcRenderer.invoke(CHANNELS.forkRun, request),
  promptFork: (request) => ipcRenderer.invoke(CHANNELS.promptFork, request),
  modelAb: (request) => ipcRenderer.invoke(CHANNELS.modelAb, request),
  // A/B 预览是只读通道：不带执行身份、不占主动槽（载荷原样透传，校验在 main 侧）
  modelAbPlan: (request) => ipcRenderer.invoke(CHANNELS.modelAbPlan, request),
  createRun: (request) => ipcRenderer.invoke(CHANNELS.createRun, request),
  // workspaces:*（B 1.3/1.5）：目录选择签发 token、隔离分叉只读预检——都不产生 run 文件
  chooseSource: () => ipcRenderer.invoke(CHANNELS.chooseSource),
  forkCapability: (request) => ipcRenderer.invoke(CHANNELS.forkCapability, request),
  // workspaces:*（C 1.1）：文件清单与内容只读通道——不写 trace/blob、不调 LLM/工具
  inspectWorkspace: (request) => ipcRenderer.invoke(CHANNELS.inspect, request),
  readWorkspaceFile: (request) => ipcRenderer.invoke(CHANNELS.readFile, request),
  getSettings: () => ipcRenderer.invoke(CHANNELS.settingsGet),
  saveSettings: (input) => ipcRenderer.invoke(CHANNELS.settingsSave, input),
  clearSettings: () => ipcRenderer.invoke(CHANNELS.settingsClear),
  proxyStatus: () => ipcRenderer.invoke(CHANNELS.proxyStatus),
  proxyToggle: (input) => ipcRenderer.invoke(CHANNELS.proxyToggle, input),
  proxyFork: (request) => ipcRenderer.invoke(CHANNELS.proxyFork, request),
  // draft-close:*（U3 关闭协商，design D6）：只暴露受限报告与订阅/解绑接口。
  // 载荷原样透传——schema 严格校验在 main 侧（sandbox preload 不引入 zod）
  draftCloseHandshake: () => ipcRenderer.invoke(CHANNELS.draftCloseHandshake),
  draftCloseReport: (report) => ipcRenderer.send(CHANNELS.draftCloseReport, report),
  draftCloseAnswer: (answer) => ipcRenderer.send(CHANNELS.draftCloseAnswer, answer),
  onDraftCloseSession: (listener) => onMainEvent(CHANNELS.draftCloseSession, listener),
  onDraftCloseQuery: (listener) => onMainEvent(CHANNELS.draftCloseQuery, listener),
  onDraftCloseRelease: (listener) => onMainEvent(CHANNELS.draftCloseRelease, listener),
  // operations:*（U4 操作登记）：只有身份进出，不接受任何业务载荷；
  // status 无参、reconcile 只带 {epoch, operationId}，schema 校验在 main 侧
  operationsStatus: () => ipcRenderer.invoke(CHANNELS.operationsStatus),
  operationsReconcile: (request) => ipcRenderer.invoke(CHANNELS.operationsReconcile, request),
};

/** 订阅 main → renderer 的单向事件；返回解绑函数（不把 event 对象暴露给渲染层） */
function onMainEvent<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("api", api);
