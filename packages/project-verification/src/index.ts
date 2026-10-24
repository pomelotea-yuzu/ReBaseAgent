/**
 * `@rebaseagent/project-verification` 主入口（Node/main 侧）。
 *
 * - `./schema` 子路径：纯数据 schema 层（渲染层/shared 安全共享，零 Node 依赖）；
 * - 本入口：记录层（layout/writer/assets）——**只读面与写入面在此同层暴露，但执行器
 *   （Docker 适配器/准备/执行）在 3.x 接入时另置子模块**，只读记录模块永不导入执行器
 *   （design D3，便于 MCP2 复用只读面）。
 */
export * from "./schema.js";
export * from "./records/layout.js";
export * from "./records/writer.js";
export * from "./records/assets.js";
export * from "./records/reader.js";
export * from "./source/precheck.js";
