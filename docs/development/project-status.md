# 项目状态与版本依据

校准日期：2026-10-16。依据 R2.1 归档提交 `ac8729e`、refine-ui 归档提交 `00ecab6`、v0.5.0-rc.1 打包提交 `18ebb6f` 与既有构建／发布记录；本轮只同步文档，没有联网核验下载或重跑功能验收。历史记录保留其当时结论。

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
| 当前活动 change | 渲染层模块拆分，仅提案，尚未实施 | [提案](../../openspec/changes/refactor-desktop-renderer-modules/proposal.md)、[设计](../../openspec/changes/refactor-desktop-renderer-modules/design.md)、[任务](../../openspec/changes/refactor-desktop-renderer-modules/tasks.md)；聚焦详情、文件视图和单一 store，保持既有行为；不追溯为 R2.1 发行前置条件 |
| 后续能力 | R2.2 仍为下一项新增能力，本轮内部重构不改变产品排序 | 隔离 prompt 首版 → R3 首个受支持环境 → R2.3 完整扩展 → R4 → 按需 R5，见[正式路线](../product/evolution-roadmap.md)；R3 技术验证可并行，R2.3 最小双臂按案例需要，不构成 R3 门槛；跨运行文件 diff 与隔离实验仍待实现 |
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
