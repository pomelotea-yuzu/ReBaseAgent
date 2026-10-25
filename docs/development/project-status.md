# 项目状态与版本依据

校准日期：2026-10-25。本次补充 R3 单环境项目验证归档（源码已实现，未打包未发行，使用/限制指南见 [docs/guide/isolated-project-verification.md](../guide/isolated-project-verification.md)）；本次补充 MCP 只读诊断（MCP0+MCP1）归档（源码已实现，未打包未发行，接入指南见 [docs/guide/mcp-readonly-diagnostics.md](../guide/mcp-readonly-diagnostics.md)）；此前在渲染层模块拆分收口状态基础上补充 R2.2 归档（源码已实现，未打包未发行）；发行与既有能力仍依据 R2.1 归档提交 `ac8729e`、refine-ui 归档提交 `00ecab6`、v0.5.0-rc.1 打包提交 `18ebb6f` 与既有构建／发布记录，没有联网核验下载或重跑功能验收。同日晚间回填：S16 经非维护者按指南实测通过（WorkBuddy 5.8.3 + `v0.6.0-rc.1` 发行包 `mcp/` 目录，引用可回查经随包数据独立复核），MCP 行发行状态同步更新为已随 `v0.6.0-rc.1` 打包上传。历史记录保留其当时结论。

## 研发与文档

| 项目 | 当前可确认状态 | 依据与边界 |
|---|---|---|
| 隔离 A/B/C | 已归档 | [A](../../openspec/changes/archive/2026-09-19-add-sandboxed-rerun/tasks.md)、[B](../../openspec/changes/archive/2026-09-20-add-sandboxed-rerun-desktop/tasks.md)、[C](../../openspec/changes/archive/2026-09-20-add-sandboxed-rerun-file-view/tasks.md) |
| U1–U4 | 已归档 | [U1](../../openspec/changes/archive/2026-09-23-refactor-run-workspace/evidence-index.md)、[U2](../../openspec/changes/archive/2026-09-24-improve-workspace-file-reading/evidence-index.md)、[U3](../../openspec/changes/archive/2026-09-26-preserve-debugging-drafts/evidence-index.md)、[U4](../../openspec/changes/archive/2026-09-27-add-desktop-operation-tracking/evidence-index.md)；归档不等于已进入所有发行包 |
| U5 | 已归档：创建与重跑的执行/结果闭环 | [场景证据](../../openspec/changes/archive/2026-09-29-unify-run-execution-workflow/evidence-index.md)；可信结果关联、失败定位、按修订清理与导航规则 |
| U6 | 已归档：父链缺失时安全只读 | [场景证据](../../openspec/changes/archive/2026-09-30-add-partial-run-reading/evidence-index.md)；只对已确认的祖先文件缺失降级，来源不完整的父本不能执行 |
| U7 | 已归档：分支定位与运行比较 | [场景证据](../../openspec/changes/archive/2026-10-01-improve-branch-comparison/evidence-index.md)；双运行工作区与两到四条指标表，未提供跨运行文件 diff |
| U8 | 已归档：录制、messages 与实验工作区 | [场景证据](../../openspec/changes/archive/2026-10-02-unify-recording-and-experiment-workspaces/evidence-index.md)、[任务与门禁记录](../../openspec/changes/archive/2026-10-02-unify-recording-and-experiment-workspaces/tasks.md)；67 条场景为已交付 66 / 待验证 0 / 实机不成立 1，后一条按单元层承载，不称全部实机通过 |
| R2.1 结果导出与 UI 整理 | 已归档，已进入 `0.5.0-rc.1` 构建；维护者 10/16 确认已打包上传 | [R2.1 验收](../../openspec/changes/archive/2026-10-12-export-run-results/tasks.md)、[UI 验收](../../openspec/changes/archive/2026-10-16-refine-ui-for-community-release/evidence-index.md)；导出不含 trace 分享包、自动应用或合并；上传采用维护者确认，本轮未独立下载核验 |
| 渲染层模块拆分 | **已归档**（`2026-10-19-refactor-desktop-renderer-modules`）：实施、实机与门禁全部收口后归档；未进入任何发行包 | [归档](../../openspec/changes/archive/2026-10-19-refactor-desktop-renderer-modules/tasks.md)（38/39 任务 + 归档注记）、[设计](../../openspec/changes/archive/2026-10-19-refactor-desktop-renderer-modules/design.md)、[前后对比报告](../engineering/reports/2026-10-19-rrm-renderer-split-scale-report.md)；三大文件收敛为组合/连接层（store.ts 3769→135），行为面由 6.1–6.5 实机批（rrm-14 9/9、补探针 21/21、6.2 三批 36 tag、6.3.1–6.3.3、6.4/6.5）与全量门禁（desktop 203/3180 exit=0）背书；主 spec 合入差集 = 既有缺失 0、新增恰 5 requirement/19 scenario |
| R2.2 隔离 prompt 实验 | **已归档（源码，2026-10-22）**：根初始快照上的单项启动指令实验、v3 记录、跨运行检查点／文件比较与单侧导出闭环；**未打包、未发行，不在 `0.5.0-rc.1` 包内** | [归档](../../openspec/changes/archive/2026-10-22-add-isolated-prompt-experiments/tasks.md)、[场景证据](../../openspec/changes/archive/2026-10-22-add-isolated-prompt-experiments/evidence-index.md)；7.1 package-layer 真实模型、7.2 Electron 几何／缩放／真键盘、7.3 失败与未知路径实机、7.4 全仓门禁；二进制／超限逐侧状态与部分乱序注入按单元层承载，视觉可读性待发行前人工验收 |
| 后续能力 | R3 已归档（2026-10-25）；下一候选为发行轮（R3 进包重打包/实包验收/zip 发行，owner 拍板）与 MCP2 | [正式路线](../product/evolution-roadmap.md)；隔离父本／分支上的 prompt fork 与模型 A/B 仍禁用，R2.2 只开放隔离根初始快照上的 prompt 实验 |
| MCP 服务体系 | **MCP0+MCP1 已归档（源码，2026-10-24），已随 `v0.6.0-rc.1` 进包上传 Release（2026-10-23）**：七只读工具（list_runs/get_run/get_step/compare_runs/inspect_checkpoint/read_checkpoint_file/compare_checkpoint_files）、content 自足投影（正文只承载一次）、64 KiB 预算与认证游标、真实 stdio 全量协议、零写入/零执行复核、WorkBuddy 5.9.0 真实客户端两轮验收（S15）与接入指南；**S16 已验收（2026-10-24 非维护者实测：WorkBuddy 5.8.3 + 发行包 mcp/，四工具代表任务，引用可回查经随包数据独立复核）**；外部反馈两项已处置（使用说明示例运行假承诺修正、指南补客户端手动信任提示）。**MCP2 已实施并验收（源码，2026-10-26，未打包）**：六个验证记录查询只读工具（十三工具发现）、桌面/MCP 共享比较判据与只读子入口、WorkBuddy 5.9.2 真实客户端回查与真实数据根零写入指纹；发行 zip 仍为 MCP1 能力，打包另行安排 | [归档](../../openspec/changes/archive/2026-10-24-add-readonly-mcp-diagnostics/tasks.md)、[MCP2 change](../../openspec/changes/archive/2026-10-26-add-mcp-verification-evidence/evidence-index.md)、[服务规划](../product/mcp-service-roadmap.md)、[接入指南](../guide/mcp-readonly-diagnostics.md)；MCP3 按需独立设计受控执行，参数重做仍依赖 R4；不含内置 Agent 调用外部 MCP 工具 |
| R3 单环境项目验证 | **已归档（源码，2026-10-25）**：Docker Desktop Linux containers 受限后端 + node-ts-v1 冻结模板的受限准备/受控物化/固定命令执行/停止语义/静止采集/启动核查，桌面验证面板（分开确认/操作登记/有界日志/双验证比较/精确输入导出）；仅声明模板范围（仅 Windows x64 + Docker Desktop Linux containers + node-ts-v1），真实项目接入（I 组 7.1/7.2）挂账未排期；**未打包、未发行，不在任何发行包内** | [归档](../../openspec/changes/archive/2026-10-25-add-isolated-project-verification/tasks.md)（1–6 组全勾 + 7 组挂账）、[场景证据](../../openspec/changes/archive/2026-10-25-add-isolated-project-verification/evidence-index.md)（逐场景最终状态表 + 机器回查 `.workbuddy/r3-66/verify-66.cjs` 120/120）、[使用/限制指南](../guide/isolated-project-verification.md)；主 spec 合入差集：desktop-ui 107→113 req/492→506 scen、新建 project-verification 12/26、workspace-isolation 10→12/43→47（既有零丢失，`.workbuddy/r3-66/spec-diff-*.json`）；实机共修复四处真实缺陷（v4 runner/supervisor/截断、收尾 rm -f、在飞停止接线、断连收尾销账） |
| UI 与能力调研 | 10/12 调研和走查已存档，有限 UI 整理已落地 | [能力细化讨论稿](../product/2026-10-12-capability-roadmap-from-r2-2.md)、[UI 实机走查](../reviews/2026-10-12-ui-live-walkthrough-and-refinement.md)、[本轮 UI 验收](../../openspec/changes/archive/2026-10-16-refine-ui-for-community-release/evidence-index.md)；后续能力技术方案及独创性候选仍待设计验证 |
| 开源治理文档 | 已补齐当前单维护者阶段规则 | [治理入口](governance-and-maintenance.md)、[维护政策](maintenance-policy.md)、[发布交接](release-and-handoff.md)、[第三方声明](third-party-notices.md)；远程配置、私密接收与最终发行物许可仍未在本轮核验 |
| GitHub | 维护者确认账号已解封 | 不再以待解封作为开发或文档阻塞；具体链接和功能可用性独立核验 |
| CI | Gitee Go 已有历史运行记录，GitHub Actions 本地配置已补 | 本轮未触发或确认线上流水线；不能把配置存在写成最新提交已通过 |

## 发行记录

| 版本 | 本地可核查的依据 | 使用口径 |
|---|---|---|
| v0.2.0 | 标签与[发行说明](../engineering/reports/2026-09-07-v0.2.0-release-notes.md) | 历史正式版；安全维护范围另见根安全策略 |
| v0.3.0-k0 | 标签与[构建验收记录](../engineering/reports/2026-09-17-k0-experience-build.md) | 已有发布记录的较早预览版，不含隔离文件能力 |
| v0.3.0-k0-a3.1 | 本地标签、[构建记录](../engineering/reports/2026-09-21-a3-experience-build.md) | A/B/C 首次进入便携构建；原记录写明当时未上传和部分人工验收未完成。标签存在不单独证明下载或后续验收完成 |
| v0.3.0-k1 | 标签指向 `047d1c7`；[09/25 发布正文存档](../engineering/reports/2026-09-25-k1-gitee-template.md)及[发布处理记录](../engineering/notes/2026-09-25-gitee-release-blocked.md) | 已有发布记录的历史预览版，含隔离 A/B/C 与 U1/U2，不含 U3–U8；后续源码归档不等于进入该包 |
| v0.4.0-rc.1 | [构建记录](../engineering/reports/2026-10-02-v0.4.0-rc.1-build-record.md)、[人工验收清单](../engineering/reports/2026-10-02-v0.4.0-rc.1-manual-acceptance-checklist.md) | 已有构建与验收记录，含 U1–U8，不含 10/12 归档的 R2.1；不作为本轮线上下载核验 |
| v0.4.0-rc.2 | [10/11 构建记录](../engineering/reports/2026-10-11-v0.4.0-rc.2-build-record.md) | 记录基线为 `e1a5611`，不含 R2.1；打包、验收与上传状态按该记录分别核对，本轮未重验或查询线上发行 |
| v0.5.0-rc.1 | [10/16 构建记录](../engineering/reports/2026-10-16-v0.5.0-rc.1-build-record.md)、[发行文案](../engineering/reports/2026-10-16-v0.5.0-rc.1-release-notes.md) | 基线 `00ecab6`，含 R2.1 结果导出与 refine-ui 界面重组；**首个只发 zip 口径的包**（zip 内 exe + SHA256SUMS.txt + 使用说明.txt）；本地 tag `v0.5.0-rc.1`，维护者 10/16 确认已打包上传；本轮未独立核验远端下载，人工实包验收仍按构建记录分别核对 |

K1 本地标签与发布正文存档一致的产物信息：

- 文件名：`ReBaseAgent-0.3.0-k1-win-x64-portable.exe`
- 大小：`95,439,340` bytes
- SHA-256：`d34687851fbb7263877d4fbc7cd2fcf01fbb2c1413dd604b6690e9bfd4f280a8`
- 已记录入口：[GitHub](https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.3.0-k1)、[Gitee](https://gitee.com/yuzu-tea-duck/re-base-agent/releases/tag/v0.3.0-k1)。本轮未重新下载核对，不把历史发布记录当成实时可用性证明。

09/24 K1 内部发布草稿和归档提交说明中的“未打 tag、未上传”描述的是当时状态，后续已有标签和发布记录；不能据此继续把 K0 写成最新预览版。反过来，发布记录也不能补齐旧构建记录中未完成的人工验收，不据此宣布后续完整发行包验收通过。

## 文档使用顺序

能力语义先查源码与 OpenSpec；当前进度查活动任务及归档记录；特定发行物查其提交、哈希和发布记录。本页、README 与路线图负责汇总，不能覆盖这些依据。

带日期的构建报告、审阅和讨论保留历史状态。后续校准用附注或本页链接说明，不改写旧测试结论，也不把未来方案当作已经交付。所有治理文档“已补齐”仅指内容存在，提交到公开仓库和实际执行均须另行核对。
