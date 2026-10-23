## ADDED Requirements

### Requirement: 发行 zip 附带 MCP 只读诊断目录

系统 SHALL 在正式发行 zip 中附带自包含的 `mcp/` 目录（`dist/cli.js` 入口 + 扁平
`node_modules` 依赖闭包），使外部 MCP 客户端无需源码构建即可接入只读诊断。zip 内
SHALL 同时提供逐文件 SHA-256 清单（`SHA256SUMS.txt`，不含自身）与含 MCP 一节的
使用说明。桌面便携 exe SHALL 保持不内嵌 MCP（单独流传时桌面功能完整）。

`mcp/` 闭包 SHALL 以 `node-linker=hoisted` 的扁平布局交付（`.pnpm`+symlink 布局
SHALL NOT 进入发行物：Windows 解压 symlink 需特权）；组装脚本 SHALL 对 deploy
产物自跑 stdio 探针（initialize 能力恰 `{tools:{}}`、tools/list 恰七工具、
tools/call 可完成）并核对 zip 结构与 exe 逐字节一致，全部通过才允许产物出厂。

#### Scenario: 解压即可接入

- **WHEN** 用户解压发行 zip 并按使用说明以 `node <解压目录>/mcp/dist/cli.js --data-dir <数据根>` 启动
- **THEN** MCP 服务完成 initialize（能力恰 `{tools:{}}`）、tools/list 返回七只读工具，工具调用返回统一信封，无需仓库源码或额外构建

#### Scenario: 组装自验挡住坏产物

- **WHEN** 组装过程中 deploy 闭包缺运行时依赖、或 zip 结构/清单/产物哈希任一不符
- **THEN** 组装以非零退出失败，不产出 `ASSEMBLE_PASS`，既有发行物不被覆盖

#### Scenario: 桌面 exe 不受影响

- **WHEN** 仅取 zip 内便携 exe（不带 `mcp/` 目录）运行
- **THEN** 桌面全部功能可用，MCP 缺席不产生错误
