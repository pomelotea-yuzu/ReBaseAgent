/**
 * `@rebaseagent/project-verification/facts` 子入口（MCP2 design D1）：
 * 纯数据事实层——规范化序列化/摘要与共享比较判据，不触文件系统、
 * 不导入任何记录读取或执行/写入模块（闭包由 test/read-closure.test.ts 钉死）。
 */
export * from "./canonical.js";
