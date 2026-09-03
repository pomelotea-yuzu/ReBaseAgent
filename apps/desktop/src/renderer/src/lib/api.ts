import type { WindowApi } from "@shared/ipc";

declare global {
  interface Window {
    api: WindowApi;
  }
}

/** 渲染层取数的唯一入口（由 preload 经 contextBridge 注入） */
export const api: WindowApi = window.api;
