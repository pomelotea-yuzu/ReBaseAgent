# 项目状态与版本依据

校准日期：2026-10-02。依据 U8 归档提交 `87a73b3`、本地标签、归档 change 和既有发布记录；本轮只修订文档，没有联网核验下载或重跑功能验收。后续源码与发布变化应更新本页；历史记录保留其当时结论。

## 研发与文档

| 项目 | 当前可确认状态 | 依据与边界 |
|---|---|---|
| 隔离 A/B/C | 已归档 | [A](../../openspec/changes/archive/2026-09-19-add-sandboxed-rerun/tasks.md)、[B](../../openspec/changes/archive/2026-09-20-add-sandboxed-rerun-desktop/tasks.md)、[C](../../openspec/changes/archive/2026-09-20-add-sandboxed-rerun-file-view/tasks.md) |
| U1–U4 | 已归档 | [U1](../../openspec/changes/archive/2026-09-23-refactor-run-workspace/evidence-index.md)、[U2](../../openspec/changes/archive/2026-09-24-improve-workspace-file-reading/evidence-index.md)、[U3](../../openspec/changes/archive/2026-09-26-preserve-debugging-drafts/evidence-index.md)、[U4](../../openspec/changes/archive/2026-09-27-add-desktop-operation-tracking/evidence-index.md)；归档不等于已进入所有发行包 |
| U5 | 已归档：创建与重跑的执行/结果闭环 | [场景证据](../../openspec/changes/archive/2026-09-29-unify-run-execution-workflow/evidence-index.md)；可信结果关联、失败定位、按修订清理与导航规则 |
| U6 | 已归档：父链缺失时安全只读 | [场景证据](../../openspec/changes/archive/2026-09-30-add-partial-run-reading/evidence-index.md)；只对已确认的祖先文件缺失降级，来源不完整的父本不能执行 |
| U7 | 已归档：分支定位与运行比较 | [场景证据](../../openspec/changes/archive/2026-10-01-improve-branch-comparison/evidence-index.md)；双运行工作区与两到四条指标表，未提供跨运行文件 diff |
| U8 | 已归档：录制、messages 与实验工作区 | [场景证据](../../openspec/changes/archive/2026-10-02-unify-recording-and-experiment-workspaces/evidence-index.md)、[任务与门禁记录](../../openspec/changes/archive/2026-10-02-unify-recording-and-experiment-workspaces/tasks.md)；67 条场景为已交付 66 / 待验证 0 / 实机不成立 1，后一条按单元层承载，不称全部实机通过 |
| 后续能力 | 尚未由 U1–U8 交付 | trace 包导出（R2.1）、Shell/真实测试（R3）、隔离 prompt/模型实验等见[拆分计划](../engineering/plans/2026-09-21-ui-change-split-plan.md)；目前无活动 change |
| 开源治理文档 | 已补齐当前单维护者阶段规则 | [治理入口](governance-and-maintenance.md)、[维护政策](maintenance-policy.md)、[发布交接](release-and-handoff.md)、[第三方声明](third-party-notices.md)；远程配置、私密接收与最终发行物许可仍未在本轮核验 |
| GitHub | 维护者确认账号已解封 | 不再以待解封作为开发或文档阻塞；具体链接和功能可用性独立核验 |
| CI | Gitee Go 已有历史运行记录，GitHub Actions 本地配置已补 | 本轮未触发或确认线上流水线；不能把配置存在写成最新提交已通过 |

## 发行记录

| 版本 | 本地可核查的依据 | 使用口径 |
|---|---|---|
| v0.2.0 | 标签与[发行说明](../engineering/reports/2026-09-07-v0.2.0-release-notes.md) | 历史正式版；安全维护范围另见根安全策略 |
| v0.3.0-k0 | 标签与[构建验收记录](../engineering/reports/2026-09-17-k0-experience-build.md) | 已有发布记录的较早预览版，不含隔离文件能力 |
| v0.3.0-k0-a3.1 | 本地标签、[构建记录](../engineering/reports/2026-09-21-a3-experience-build.md) | A/B/C 首次进入便携构建；原记录写明当时未上传和部分人工验收未完成。标签存在不单独证明下载或后续验收完成 |
| v0.3.0-k1 | 标签指向 `047d1c7`；[09/25 发布正文存档](../engineering/reports/2026-09-25-k1-gitee-template.md)及[发布处理记录](../engineering/notes/2026-09-25-gitee-release-blocked.md) | 最近有发布记录的预览版，含隔离 A/B/C 与 U1/U2，不含 U3–U8；U1–U8 源码归档不等于完整工作区版本已发行 |

K1 本地标签与发布正文存档一致的产物信息：

- 文件名：`ReBaseAgent-0.3.0-k1-win-x64-portable.exe`
- 大小：`95,439,340` bytes
- SHA-256：`d34687851fbb7263877d4fbc7cd2fcf01fbb2c1413dd604b6690e9bfd4f280a8`
- 已记录入口：[GitHub](https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.3.0-k1)、[Gitee](https://gitee.com/yuzu-tea-duck/re-base-agent/releases/tag/v0.3.0-k1)。本轮未重新下载核对，不把历史发布记录当成实时可用性证明。

09/24 K1 内部发布草稿和归档提交说明中的“未打 tag、未上传”描述的是当时状态，后续已有标签和发布记录；不能据此继续把 K0 写成最新预览版。反过来，发布记录也不能补齐旧构建记录中未完成的人工验收，不据此宣布后续完整发行包验收通过。

## 文档使用顺序

能力语义先查源码与 OpenSpec；当前进度查活动任务及归档记录；特定发行物查其提交、哈希和发布记录。本页、README 与路线图负责汇总，不能覆盖这些依据。

带日期的构建报告、审阅和讨论保留历史状态。后续校准用附注或本页链接说明，不改写旧测试结论，也不把未来方案当作已经交付。所有治理文档“已补齐”仅指内容存在，提交到公开仓库和实际执行均须另行核对。
