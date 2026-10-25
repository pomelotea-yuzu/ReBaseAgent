/**
 * `@rebaseagent/project-verification/read` 子入口（MCP2 design D1）：
 * 只读记录面——布局、记录/准备记录读取、内容寻址日志读取与受控错误。
 *
 * 闭包纪律：本入口不得直接或间接导入 writer/append/asset 发布、prepare、
 * materialize、execute、orchestrate、runtime、docker、trusted-env 或来源写入模块；
 * 由 test/read-closure.test.ts 以静态导入图钉死（V01）。
 */
export * from "./records/layout.js";
export * from "./records/reader.js";
export * from "./records/scan.js";
