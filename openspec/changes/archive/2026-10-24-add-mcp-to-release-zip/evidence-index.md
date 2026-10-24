# Evidence: 发行 zip 附带 MCP 只读诊断目录

- 1 组装脚本 `scripts/assemble-release-zip.mjs`：占位 exe（0.5.0-rc.1 副本、输出临时目录）
  全流程 **ASSEMBLE_PASS**（stdio 探针 {tools:{}}/7 工具/list_runs + 顶层恰 4 项 + SUMS 3,758 行
  对齐 + exe 逐字节一致）。工程坑四条全部实测钉住（hoisted/仓库内相对目标/EOF 时序/.NET UTF8），
  写在脚本头注释与构建记录。
- 2 spec delta `specs/desktop-distribution/spec.md`（ADDED 1 requirement / 3 scenario）；
  指南置顶改版本条件式（0.6.0-rc.1 起附带 mcp/）；check-spec 15/0、strict valid。
- 3 正式打包轮（2026-10-24，详见 `docs/engineering/reports/2026-10-24-v0.6.0-rc.1-build-record.md`）：
  门禁（7 包 build/desktop tsc 双 0/desktop 216 文件 3301 用例/mcp-server 307 引用 6.5/biome 0/
  check-spec 15/0）→ exe 打包（stable + electronDist 离线；火绒拦缓存工具，7za/NSIS 分别以
  `ELECTRON_BUILDER_7ZIP_PATH` 与 `ELECTRON_BUILDER_NSIS_DIR` 指向放行实例绕过，证据在构建记录）
  → release:verify 通过（95,004,894 B < 100 MB、renderer 零违规）→ **正式 zip ASSEMBLE_PASS**
  （100,291,623 B）→ **zip 解压往返 MCP 自跑 ZIP_MCP_PASS**（Expand-Archive 中文名完好 +
  initialize/tools-list 全通）→ 离线冒烟 12 检查 + PACKAGED_OFFLINE_PASS → 旧产物哈希逐字不变。
  人工实机验收未执行（如实，归 §9.1）；release notes 与 README 同步。
