/**
 * `@rebaseagent/project-verification/facts` 子入口（MCP2 design D1）：
 * 纯数据事实层——**零导入**（连 Node 内置都不碰，renderer bundle 可直接吃）。
 * 当前导出共享比较纯事实（design D7）；规范化序列化/摘要（canonical.ts）仍在
 * 主入口导出，不进本子入口以保持 renderer 可打包。
 */
export * from "./compare-facts.js";
