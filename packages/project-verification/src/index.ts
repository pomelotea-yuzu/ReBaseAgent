/**
 * `@rebaseagent/project-verification` 主入口（Node/main 侧）。
 *
 * - `./schema` 子路径：纯数据 schema 层（渲染层/shared 安全共享，零 Node 依赖）；
 * - 本入口：记录层（layout/writer/assets/reader）、来源预检、受信环境资产与**受限准备
 *   编排**（3.1）。Docker 适配器（真实后端）在 3.2 接入——只读记录模块永不导入执行器
 *   （design D3，便于 MCP2 复用只读面）。
 */
export * from "./schema.js";
export * from "./canonical.js";
export * from "./records/layout.js";
export * from "./records/writer.js";
export * from "./records/assets.js";
export * from "./records/reader.js";
export * from "./source/precheck.js";
export * from "./trusted-env/node-ts-v1.js";
export * from "./prepare/plan.js";
export * from "./prepare/backend.js";
export * from "./prepare/prepare.js";
