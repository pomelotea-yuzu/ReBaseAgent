/**
 * `@rebaseagent/project-verification` 主入口（Node/main 侧）。
 *
 * 2.1 当前仅重导出纯 schema 层；按 design D3，后续任务在此挂载：
 * - 记录 I/O（`verifications/*.jsonl` 读写器、附件发布、恢复日志）——2.2/2.3；
 * - 只读记录模块**永不导入执行器**（Docker 适配器/准备/执行在 3.x 接入，便于 MCP2 复用只读面）。
 * 渲染层/shared 一律依赖 `./schema` 子路径，不依赖本入口。
 */
export * from "./schema.js";
