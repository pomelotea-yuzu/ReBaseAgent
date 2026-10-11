# 英文化工作决策记录

日期：2026-10-09。状态：**探讨中，未开始执行**（等明确"开始工作"指令后再动手）。

背景：比赛材料已全部提交，本会话负责英文化相关工作的探讨与审阅；另一 agent 负责功能开发，双方不互相干涉。本文档只记录英文化的决策与待办，不放执行产物。**国内社区宣发与海外 PR 宣发暂缓，其决策不记录在本文件**（2026-10-11 定）。

## 一、已定决策

### 1. 英文化范围（明确收窄）

**只做开源面向用户的门面文件，`docs/` 下 124 个 md 全部保持中文，不做全量翻译。**

| 文件 | 决策 |
|---|---|
| `README.md` | **方案 B**：保留中文为默认页，新增 `README.en.md`，顶部互链切换。**英文版 = 中文版直译即可**，不按海外读者重排重点（2026-10-11 定）；中文版近期还会更新一次，**翻译不急，待中文版定稿后再翻** |
| `CONTRIBUTING.md` | 中文为主文件，新增英文版 |
| `SECURITY.md` | 中文为主文件，新增英文版 |
| `CODE_OF_CONDUCT.md` | 中文为主文件，新增英文版（现为 Contributor Covenant 中文版） |
| `LICENSE` | 不动（MIT 英文原文） |
| `CHANGELOG.md` | 后置，暂不英文化 |

**`docs/` 分层（2026-10-09 修订，取代最初"docs 全部不翻"的收窄）**

判断标准：**`README.en.md` 会链接到哪里，就翻到哪里；链接不到的一律不翻。**

| 范围 | 决策 |
|---|---|
| `guide/getting-started.md`（2.5 KB） | 翻，README.en 的上手入口 |
| `architecture/replay-state-consistency.md`（6.5 KB） | 翻，机制说明，海外技术读者核心读物 |
| `architecture/overview.md`（2.4 KB） | 翻，顺带 |
| `research/2026-09-27-agent-debugging-landscape.md`（8 KB） | 翻，诚实对比稿，海外 PR 与宣发最有说服力的一页 |
| `development/governance-and-maintenance.md`、`maintenance-policy.md`、`third-party-notices.md`（~21 KB） | 翻，开源治理三件套，awesome list / 海外维护者评估必看 |
| `development/project-status.md` | 后置，更新频繁、跟国内发布节奏走，翻了易过期 |
| `reviews/`、`reports/`、`competition/`、`engineering/`、`development/audits`、`collab/`、`readme-shots/` | 不翻，内部过程资产与历史记录，且落后原文即成负资产 |

合计待翻约 **40 KB**，一次性可控。

- **存放与命名 = 同目录 `*.en.md`**（如 `docs/guide/getting-started.en.md`），2026-10-11 定：链接改动最小，与原文同目录便于后续同步校对；不用集中 `docs/en/`（需复制目录结构，同步成本高）。**链接互指规则**：英文版顶部回链中文原文，中文原文顶部加「English」入口。
- 应用 UI 英文化（L3）：**单独立项，不急**（2026-10-11 定），openspec 提案后续再写，排期放在本轮英文化之后。现状是无 i18n 基础设施、`apps/desktop/src` 约 9700 行含中文且与逻辑交织、大量测试断言中文文案，与开发 agent 冲突风险极高。
- CONTRIBUTING 英文版**补一段项目现状与文档导航**（指向 `docs/guide/`、`docs/development/project-status.md` 等），弥补 `HANDOFF.md` 不入库（仅供 agent 交接用）造成的公开信息缺口。内容只提炼，不搬运。

### 2. 模板与配套文件

- **范围**：`.github/ISSUE_TEMPLATE/` issue 模板 + `.github/pull_request_template.md` PR 模板。
- **语言策略 = 混排**：每个模板中文为主、关键字段标签并列英文（如「复现步骤 / Steps to reproduce」），不搞中英两套模板列表。与"README 中文默认"的定位一致，海外早期用户量级下够用。
- **内容要求**：
  - bug 模板必填版本信息，且**以实际发布记录为准**（继承 `SECURITY.md` 口径，`package.json` 版本不算数）、运行环境、复现步骤、预期/实际；
  - bug 模板引导附上 **run 记录/trace 附件**（项目自有录制能力，极大降低排查成本）;
  - feature 模板先问三件事：**真实使用场景、当前做法、预期结果**（对齐 CONTRIBUTING 已有约定，防拍脑袋需求）；
  - PR 模板带质量门禁提示（build / typecheck / test / lint + OpenSpec 校验），与工程侧约定对齐。

## 二、待办清单（全部待"开始工作"指令）

1. `README.md` 顶部加语言切换互链（中文内容不动）
2. 新增 `README.en.md`（**中文版直译**，不做重点重排；**待中文版近期一次更新定稿后再做，不急**）
3. 新增 `CONTRIBUTING` / `SECURITY` / `CODE_OF_CONDUCT` 英文版（含文档导航段）
4. 上表 7 篇核心 docs 的英文版（约 40 KB，同目录 `*.en.md` 命名，见 `docs/` 分层）
5. 新增 `.github/ISSUE_TEMPLATE/`（bug / feature，混排）
6. 新增 `.github/pull_request_template.md`（混排 + 门禁提示）

## 三、文档入库分流规则（2026-10-09 定）

**总则：过程可以入库，草稿不行；被引用的必须入库，没读者的不必。判断不了的默认入库**——"引用悬空"是硬错误，"多一篇过程文档"只是轻微噪音，两害相权取轻。

- **已入库的历史过程文档：不动。** 重写 git 历史成本高、无收益；且 `docs/` 成体系的 review / 调研 / 方案正是"开源治理 + 长期发展"评审维度的迭代记录证据。
- **新文档分流**：

| 类型 | 例子 | 入库？ |
|---|---|---|
| 引用链上的 | tasks.md / README 引用的 review、截图、机制说明 | **必须**（悬空引用是硬错误，先例 `181e11a`、`94725cd`） |
| 决策记录 / specs 设计 | `docs/product/` 本文件、未来设计稿 | 入库，供未来 agent 与协作者查阅 |
| 调研成果 | landscape、方案对比 | 入库，可被引用、可对外展示 |
| 内部交接 / 草稿 | `HANDOFF.md`、一次性试跑记录、中间态笔记 | 不入库（沿用 `.workbuddy/` 等既有惯例） |
| 宣发文章草稿 | 未发布的掘金/知乎稿 | **定稿发布后再入库**，草稿期不入库 |

- **草稿目录 = `docs/drafts/`**：个人工作过程文件与一切草稿一律放这里，已通过 `.gitignore` 规则 `docs/drafts/` 整目录排除（2026-10-09 已配置并验证）。
- 体量不构成问题：1.5 MB 纯文本摊进数百个 commit 增量可忽略；真正的成本是认知负担，因此**无读者的草稿一律进 `docs/drafts/`，不混入正式 `docs/` 分类**。

## 四、暂缓事项（不在本文件范围，2026-10-11 定）

- **国内社区文章**（篇目、顺序、首发时间、发布链接核实）：暂缓，决策另行记录，不放本文件。
- **海外 PR 宣发**（目标仓库清单调研）：暂缓。
- **L3 UI i18n 立项**：不急，openspec 提案后续再写。
