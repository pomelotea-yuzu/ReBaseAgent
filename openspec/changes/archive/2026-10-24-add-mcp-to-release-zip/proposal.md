# Proposal: 发行 zip 附带 MCP 只读诊断目录

## Why

`v0.6.0-rc.1`（含 R2.2 隔离 prompt 实验）决定同时交付 MCP 只读诊断（owner 2026-10-24 定）。
自 `v0.5.0-rc.1` 起发行口径为 **zip-only**（zip 内 exe + SHA256SUMS.txt + 使用说明.txt）；
`mcp-server` 是独立 Node CLI（`dist/cli.js`，依赖 `@modelcontextprotocol/sdk` 等约 96 个
生产包），不依赖 Electron。**zip 附带自包含 `mcp/` 目录**是工程量最小、验收面最清楚的
暴露方式：用户解压后路径稳定，桌面 exe 独立可用不受影响。

## What Changes

- 新增 `scripts/assemble-release-zip.mjs`（入库）：
  - `pnpm --filter @rebaseagent/mcp-server --prod deploy` 产出自包含目录
    （dist + node_modules 闭包，实测约 24 MB；顺带清理 pnpm 在包目录下误建的残片）；
  - 组装 zip：`ReBaseAgent-<version>-win-x64-portable.exe` + `mcp/`（deploy 产物）+
    `SHA256SUMS.txt`（zip 内全部文件逐条 sha256）+ `使用说明.txt`（模板含 MCP 一节）；
  - **内置自验**：对 deploy 目录跑 stdio 探针（initialize → tools/list → tools/call
    list_runs，空 traces 临时数据根）+ SUMS 复核，全绿才输出 `ASSEMBLE_PASS`。
- 使用说明模板：桌面用法沿 0.5.0-rc.1 口径 + MCP 一节（node ≥20、`mcp/dist/cli.js
  --data-dir <便携数据目录>`、指向完整接入指南）。
- 指南 `docs/guide/mcp-readonly-diagnostics.md` 的「发行包不含 MCP」表述改为版本条件式
  （`0.6.0-rc.1` 起发行 zip 附带 `mcp/`；此前版本仍需源码构建）。

## Non-goals

- **不改 electron-builder 配置**：exe 内不含 MCP（extraResources/内嵌不做）；exe 单独
  流传时桌面功能完整。
- **zip 不携带 Node 运行时**：MCP 由客户端侧 node 启动（WorkBuddy 自带 node；指南已写
  Node ≥20）。
- **不做自动配置/服务注册**：客户端接入仍按指南手工登记。
- 不覆盖既有 `release:verify`（exe 半边判据原样）；不动 0.5.0-rc.1 既有产物。

## 影响面与验收

- 新 spec delta：`desktop-distribution`（发行物形状）ADDED requirement；实现与判据集中在
  一个脚本 + 一次实包组装验收。
- 验收 = 组装脚本对真实产物自验通过（结构 + SUMS + stdio 探针）+ exe 半边照旧
  （release:verify + 离线冒烟 `-k1.mjs`）。
