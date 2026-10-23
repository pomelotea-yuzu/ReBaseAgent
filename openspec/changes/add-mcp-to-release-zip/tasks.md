# Tasks: 发行 zip 附带 MCP 只读诊断目录

- [x] 1.（1h）`scripts/assemble-release-zip.mjs`：deploy + 组装 + SUMS + 使用说明 + 内置 stdio 自验；判据 = 对占位 exe（现有 0.5.0-rc.1 产物副本，输出到临时目录不碰 stable）组装自验通过。
- [x] 2.（0.5h）spec delta（desktop-distribution ADDED）+ 指南版本条件表述更新；check-spec/strict。
- [x] 3.（随打包轮）版本提升 0.6.0-rc.1 → 门禁 → exe 打包（stable + electronDist 离线）→ release:verify + 旧产物哈希复核 → 正式组装 zip + 自验 → exe 离线冒烟 → 构建记录/release notes → commit+tag（push/上传归 owner）。
