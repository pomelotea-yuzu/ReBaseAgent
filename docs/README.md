# docs/ · 文档地图与索引

> 本目录分两层：**面向使用者的文档**（guide / architecture / development）与**工程过程资产**
> （product / competition / engineering / collab / reviews）——后者是探讨、审阅、规划、会话
> 记录与对外通信，不是代码。权威性排序：**源码 / `openspec/changes/archive/` > 本目录**；
> 判断项目状态以源码与归档 change 为准。

整理：2026-09-24 重构为开源惯例分层（guide / architecture / development / product /
engineering / collab / competition / reviews），原 9 个并列目录归组；文档纳入 git 管理，
**过程截图默认留本地**（`.gitignore` 忽略 `docs/reviews/**/*.png`，验收证据目录需要
对外展示时用 `git add -f` 显式加入）。
历次整理：2026-09-10 首次分类、09-17 建立 8 类框架、09-23 补宣发与比赛规划。

---

## 面向使用者

| 目录 | 内容 |
|---|---|
| [`guide/`](guide/getting-started.md) | **快速开始**：下载/源码运行、三条上手路径、核心概念 1 分钟 |
| [`architecture/`](architecture/overview.md) | **架构总览**：monorepo 包结构、数据流、设计原则 |
| [`development/`](development/workflow.md) | **开发工作流**：质量门禁 `check:ci`、OpenSpec 流程、文档约定 |

## 研发调研与维护

| 入口 | 内容 |
|---|---|
| [`research/`](research/README.md) | Agent 调试方案对照、来源记录、重跑一致性实验设计 |
| [`replay-state-consistency.md`](architecture/replay-state-consistency.md) | 工具观察编辑、整轮文件快照与分支隔离的机制和边界 |
| [`governance-and-maintenance.md`](development/governance-and-maintenance.md) | 贡献闭环、维护职责、发布要求与持续维护安排 |
| [`audits/`](development/audits/README.md) | 依赖许可证核查报告、机器清单与只读生成器 |

## 工程过程资产

### product/ — 方向与产品定稿（长期有效，改动少）

| 文件 | 说明 |
|---|---|
| [`product.md`](product/product.md) | 产品方向定稿：定位 / JTBD / 护城河 / 产品化缺口 / V3 形态 / 商业模式。**注意其路线图停在 09-05，已落后于 archive** |
| [`direction-2026H2.md`](product/direction-2026H2.md) | AniPedia × ReBaseAgent 2026H2 方向规划（一审稿 v2.1，含一审/二审回执） |
| [`2026-09-09-roadmap-gaps.md`](product/2026-09-09-roadmap-gaps.md) | 路线图与缺口清单（09-09） |

### competition/ — 参赛规划与材料

| 文件 | 说明 |
|---|---|
| [2026-shanghai-os-contest-plan.md](competition/2026-shanghai-os-contest-plan.md) | **2026 上海开源软件应用创新大赛方案**：U1–U8 验收后录制，目标 10/02 开发收口、10/03 实包验收、10/04–10/05 录制、10/06 复核，争取 **10/07 全部材料实际提交**；含 Gitee 交付、视频主线及材料清单 |

### engineering/ — 执行方案、报告与交接单

**plans/**（执行方案，会演进，逐版修订）：

| 文件 | 说明 |
|---|---|
| [`2026-09-10-dogfood-plan.md`](engineering/plans/2026-09-10-dogfood-plan.md) | **AniPedia × ReBaseAgent dogfood 执行方案（v0.7）**：P0–P4、契约清单、验收判据、7 条 checklist、逐轮修订史（31 条）。跨项目进行中 |
| [`2026-09-10-next-phase-plan.md`](engineering/plans/2026-09-10-next-phase-plan.md) | **下一阶段规划（已批准）**：三条结构性判断 + 决策点 D-A/B/C + 推荐排序 |
| [`2026-09-10-b1-handoff.md`](engineering/plans/2026-09-10-b1-handoff.md) | **B1 交接单**（`add-github-actions-ci`，归档名 `add-ci-gates`） |
| `2026-09-13-target-app-concept.md` | 第三个项目（代号待定）· 概念提案 v0.1 |
| [`2026-09-15-usability-improvement-plan.md`](engineering/plans/2026-09-15-usability-improvement-plan.md) | **可用性完善规划**：独立推进定位、修改与双运行对比 |
| [`2026-09-19-ui-layout-discussion.md`](engineering/plans/2026-09-19-ui-layout-discussion.md) | **UI 布局与交互设计 V0.1**：完整工作台及状态规范 |
| [`2026-09-15-open-source-growth-plan.md`](engineering/plans/2026-09-15-open-source-growth-plan.md) | **开源传播与 Gitee 首轮推广规划（09-23 更新）** |
| [`2026-09-16-isolated-rerun-roadmap.md`](engineering/plans/2026-09-16-isolated-rerun-roadmap.md) | **隔离重跑演进路线（09-23 同步）**：§9.1 打包节点、§10 竞品对照及 Gitee 宣发 |
| `2026-09-16-a3-split-plan.md` | **A3 拆分方案**：A/B/C 三段任务迁移表与边界判据 |

**reports/**（交付与执行报告）：

| 文件 | 说明 |
|---|---|
| `2026-09-07-v0.2.0-release-notes.md` | v0.2.0 发布文案 |
| [`2026-09-10-fix-llm-ttft-timing-apply.md`](engineering/reports/2026-09-10-fix-llm-ttft-timing-apply.md) | ttft 修复 apply 报告 |
| [`2026-09-17-k0-experience-build.md`](engineering/reports/2026-09-17-k0-experience-build.md) | **K0 体验包构建记录**：`0.3.0-k0` 产物与哈希、实机验收。**K0 验收通过的权威记录** |
| `2026-09-17-v0.3.0-k0-release-notes.md` | `v0.3.0-k0` 预览版发布说明 |
| [`2026-09-21-a3-experience-build.md`](engineering/reports/2026-09-21-a3-experience-build.md) | A3 阶段预览包 `0.3.0-k0-a3.1` 构建记录 |
| [`2026-09-25-k1-gitee-template.md`](engineering/reports/2026-09-25-k1-gitee-template.md) | 🔧 **发 release 就抄这份**：`v0.3.0-k1` 线上定稿（4839 字符，已过审），正文逐字取自 Gitee API，改版本号/附件名/大小/SHA-256/链接即可。文件头带 7 条写法约定（禁演进宣告段、禁评价式措辞、必须条目体、禁内部发布流程自述、禁图片等）。（同目录另两篇 `…-k0-a3.1-…-`、`…-k1-release-notes.md` 未建索引行）

**briefs/**（交接单）：`2026-09-10-ttft-fix-review-brief.md`、`2026-09-10-ttft-fix-apply-brief.md`

**notes/**（功能说明与工作流约定）：`2026-09-08-v3a-trace-as-test-notes.md`、[`model-collaboration-workflow.md`](engineering/notes/model-collaboration-workflow.md)、[`2026-09-25-gitee-release-blocked.md`](engineering/notes/2026-09-25-gitee-release-blocked.md)（Gitee `v0.3.0-k1` release 被自动审核拦截的完整取证与结案：触发源锁定为发布稿第 5–8 行「演进宣告段」，删除即通过；含排除项、时间线与人工复核申诉文案）、[`2026-09-26-u4-snapshot-cost.md`](engineering/notes/2026-09-26-u4-snapshot-cost.md)（U4 任务 4.5 的操作快照成本实测：100/1000 条的 main 构造、payload 字节数、renderer 校验三段口径与中位数 ⇒ 校准 1 秒轮询初值、确认不裁剪终态与封禁、并写明真机 IPC 往返与满载诊断两项**未测**）

### collab/ — 跨项目通信与过程叙事

**anipedia/**（与 AniPedia 侧双侧通信，按时间序往来；**对方**的信在 `D:\AniPedia\.workbuddy\reply-N-to-rebaseagent.md`）：
`2026-09-10-anipedia-dogfood-precheck.md`（对方前置实测）+ `reply-to-anipedia.md` 与 `reply-2..7-to-anipedia.md`（我方七次回信：方案改判、D4 核实、冷启动坑、异步化建议等）。

**sessions/**（会话日志与复盘，时间序）：
`discussion-summary.md`（09-03）、`dev-retrospective.md` 与 `workbuddy-sessions.md`（09-04）、`2026-09-05-devlog.md`、`conversation-summary-2026-09-07.md`、`2026-09-09-daily-summary.md`。

### reviews/ — 实机验收与审阅证据

按被审对象一对多。**入库口径**：验收证据目录与审阅文档入库，过程截图留本地。

- **已入库**：U2 全系列证据目录 `2026-09-23-u2-51…54/`、`2026-09-24-u2-55/56/`、
  `2026-09-24-u2-acceptance/`（59 张，被归档 evidence-index 引用）+ 约 20 份单文件审阅记录；
  各原型目录的 `README.md` / `index.html` / `measurements.json` 入库，其 `screenshots/*.png` 留本地。
- **留本地**（约 42 MB 截图）：`2026-09-15-usability-assets/`、`2026-09-21-u1-prototype/screenshots/`、
  `2026-09-21-ui-walkthrough-assets/`、`2026-09-22-u1-71…74/`、`2026-09-23-u2-file-prototype/screenshots/`。

---

## 命名约定

- **日期前缀** `YYYY-MM-DD-`：会话产物（日志、审阅、报告、回信）一律带，便于时间序检索
- **无日期前缀**：长期有效文档（`product.md`、`direction-2026H2.md`、`model-collaboration-workflow.md`）
- 新增文档按上表选目录；**跨目录引用用 `docs/<类目>/<文件>.md` 全路径**

## 路径变更记录

- **2026-09-24 分层归组**：`direction/` → `product/`；`plans|reports|briefs|notes/` → `engineering/<原名>/`；`anipedia|sessions/` → `collab/<原名>/`；`competition/`、`reviews/` 原位。全仓引用已同步修正。
- 2026-09-17 归位：仓库根 `AniPedia_ReBaseAgent_方案审阅.md` → `reviews/2026-09-10-anipedia-rebaseagent-plan-review.md`。
- 2026-09-10 归类：原 docs 根平铺的 dogfood 方案 / anipedia 通信归入对应子目录。
