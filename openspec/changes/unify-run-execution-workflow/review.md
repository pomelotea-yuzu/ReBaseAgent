# U5 change 评审：unify-run-execution-workflow

- 评审时间：2026-09-27
- 评审对象：`openspec/changes/unify-run-execution-workflow/`（proposal / design / specs/desktop-ui delta / tasks）
- 评审方式：文档审阅 + 当前源码逐条核对（未执行 GUI 走查；change 处于纯起草阶段，proposal 已明示"未重跑历史 GUI 走查"）
- 门禁：`openspec validate unify-run-execution-workflow --strict` 通过

## 结论

**通过，可进入实施。** 现状断言与源码一致（全部核实，见第一节）、7 条 MODIFIED 均为主 spec 完整超集且场景名零丢失、74 个 delta 场景与 tasks 验收双向闭合、拆分计划 U5 契约与走查编号逐条对应、终止事件判据与 trace-sdk schema 精确一致。以下问题均为建议级，不阻塞开工。

## 一、现状断言核对（proposal Why / design Context）

| # | 断言 | 结论 | 证据 |
|---|---|---|---|
| 1 | 基线为 U4 归档提交 `9e82c91` 后的 desktop-ui 52 requirements / 236 scenarios | 属实 | `git show 9e82c91` 为 U4 归档提交（12 requirement / 63 scenario 合入四份主 spec）；实测主 spec 计数 52 / 236 |
| 2 | 引用的 U4 基础设施存在：`shared/operations.ts`、`operation-session.ts`、`operation-polling.ts`、`draft-submission.ts`、`OperationsEntry` | 属实 | 全部存在于 `apps/desktop/src/renderer/src/lib/`、`src/shared/`、`components/` |
| 3 | "多个单运行路径收到 ok 后直接 selectRun；A/B 只刷新" | 属实 | `store.ts` L1376/L1454/L1493/L1651 四处 `selectRun(envelope.data.id)`；`modelAb` 真实执行分支仅 `loadRuns()`（L1523），注释明言"多臂不自动聚焦" |
| 4 | "解冻删除待定关联"（无独立收尾关联保留） | 属实 | `draft-submission.ts` L155-160：`settleSubmission` 解冻即 `delete nextById[submission.id]`——U5 D3 所需的"解冻前转存最小元数据"确实缺失 |
| 5 | `trace-sdk/branch.ts` 返回 `leaf.events`（分支记录事件归属） | 属实 | `packages/trace-sdk/src/branch.ts` L100 `events: leaf.events` |
| 6 | A/B 臂完整性有数据基础（`target.armCount/arms`） | 属实 | `shared/operations.ts` L152 `armCount`（2–max）、L247 `arms` 列表、L259 臂 index 唯一性校验（U4 登记侧） |
| 7 | "U4 注释中个别'取消归 U5'表述与拆分计划不一致" | 属实 | `OperationsEntry.tsx` L12 注释"取消归 U5"；而 U5 Non-goals 明确真实取消继续后置——change 以"实现时清理触及代码的过渡注释"处理，方案自洽 |
| 8 | 普通创建缺少与隔离模式一致的模型摘要 | 属实 | `CreateRunDialog.tsx` L196-201 `settingsLine` 仅在隔离模式工具描述（L296）内出现，纯对话模式无摘要与就近配置入口 |
| 9 | 引用文档存在：拆分计划 U5、走查 R3/R4/R5/R10/R11、U4 evidence-index | 属实 | `2026-09-21-ui-usability-walkthrough.md` L47/L57/L65/L104/L112 五条编号齐全；archive evidence-index.md 在 `9e82c91` 中 |

**未发现任何与源码不符的假设。**

## 二、结构与覆盖核对

1. **MODIFIED 均为完整超集**（脚本对比主 spec 与 delta 的场景集）：
   - 代理 messages 重发 4→4、运行工作区 4→4、创建草稿/实验臂 4→4、提交绑定 4→4、模态焦点 3→3、统一操作事实 4→4：场景名零丢失；
   - 原生创建入口 9→10（新增「创建工作区任务优先且可返回来源」）。
   - design「Delta 策略与兼容性」的**有意替换表**逐条列出 requirement 正文的过渡行为变更（对话框→工作区、无条件选中→导航意图等），预先消除归档评审时"正文漂移"的误判——这是相对 U3/U4 新增的好实践。
2. **delta 场景 ↔ tasks 验收双向闭合**：74 场景（ADDED 7 requirement / 41 场景 + MODIFIED 7 requirement / 33 场景）全部被 tasks 引用；tasks 引用的其余 3 条（sourceToken 失效不清空任务 / sourceToken 在有效期内恢复但授权复位 / 取消目录选择保留原引用）均为主 spec 既有场景的**回归引用**，合法。
3. **与拆分计划 U5 对齐**：创建工作区/任务优先/两模式摘要/目录与授权、统一编辑→检查→确认→提交、全局入口等待时间、结果分层与修订清理、失败定位与只读重试、设置往返与密钥单向、A/B 全臂正常才清理、Non-goals（不取消/不隔离 prompt-A/B/不双运行比较）逐条落地；"现有 prompt/messages/A/B 暂用旧编辑区但必须统一收尾"也已写入 D2。
4. **终止事件判据与 schema 精确一致**：design D4"自有事件为 `event=stopped` 且 `reason=completed`"与 `trace-sdk/src/schema.ts` L378-379（`event∈{stopped,aborted,errored}`、`reason∈{completed,max_iterations,budget_exceeded,aborted,error}`）完全吻合；场景「封存限制中止和未知不等于正常结束」的枚举也一一对应。
5. 场景名在 delta 内无重复；`openspec validate --strict` 通过。

## 三、优点

1. **结果核实的判据链是最强部分**：文件封存 ≠ 正常结束、IPC ok ≠ 成功、`requestOutcome=rejected` ≠ 一律零调用、成功 ids 子集 ≠ 全臂正常——把 U4 遗留的"哪些事实能证明什么"逐层钉死，且与 schema 实况对齐（见上）。
2. **解冻与清理分离 + compare-and-delete**（D3/D5）：解冻保留最小核对关联、清理须"可信 settled + 自有正常终止 + 目标/修订匹配 + 无更晚 token 待定"四条件，正面覆盖了"内容相同也不能代替修订相同""同修订再提交不被旧操作清理"两条最容易做错的竞争。
3. **导航意图规则可判定**：来源位置 + 导航代次 + "异步导航前重验"，把 R4（完成抢焦点）的修复方案写成可断言的资格撤销规则，而非模糊的"尽量不打扰"。
4. **诚实边界延续**：不显示假进度、等待计时不冒充模型耗时、无时间戳不造数、正常结束不称测试通过、"不借用邻近记录推断结果"。
5. **对 U4 遗留问题处理得当**：U4 review B1（status 全量快照成本）在 design Risks 中正面记录为历史限制并给出本次缓解（仅处理新增终态、串行读取队列、按身份去重）；「取消归 U5」注释矛盾以 Non-goals + 过渡注释清理收口，不悄悄扩权。
6. **tasks 质量延续**：每项 ≤2h、引用具名场景、回归与新增证据分开（7.3 "U4 旧证据与 U5 新证据分开"）、不可自然诱发场景单列为 fixture（6.5 缺臂/null ID）不冒充实机。

## 四、问题与建议

### B1（建议修文）：同一场景拆两半验收，收口时须合并核对

tasks 4.4/4.5 把场景「普通结果与隔离结果确认边界不同」拆为"的普通部分 / 隔离部分"分别验收。该场景在 evidence-index（7.3）中是一条场景，若 4.4 通过而 4.5 未做，逐场景核对会出现"半覆盖"状态。建议：7.3 收口时明确该场景须两半都完成才计覆盖，或在 4.4/4.5 验收行标注互斥说明。属操作性提示。

### B2（建议实施时注意）：读取核实与自动导航应拆为两个动作

D4 禁止"为了后台核实调用会修改当前选择的 `selectRun/reopenRun`"，D6 又允许资格有效时自动进入概览（必然改变选中）。规范自洽，但两条规则作用于同一个选中状态，实现时若共用一个函数（读取即选中）会同时违反前者；若完全分离又容易漏掉 D6 的资格重验。建议实施 1.2/3.4 时把"按 ID 只读核实"与"带资格校验的导航"拆为独立 store 动作，并对"核实动作零导航副作用"加断言。

### B3（实施确认点）：创建来源引用的生命周期未写明

D1 的来源引用（运行/页签/调用/文件阅读定位）未说明是否随创建草稿保留、重载后如何。按主 spec 创建草稿 requirement 的纪律（草稿仅模式/任务/系统指令，不保存授权与目录外的状态），来源引用不应入草稿——建议实施 4.1 时明确其为 renderer 会话内存，重载后按 D1"失效时回退已有可用工作区"处理，避免实施时把定位信息塞进草稿结构。

### B4（记录）：通知可达性缺显式断言

「恢复核对重试与批次结果只通知」的"通知可感知"依赖 aria-live，但 6.8 的验收清单只覆盖宽度/缩放/Tab/Shift+Tab/Esc。建议 6.8 实施时补一条 aria-live 存在性与礼貌级（assertive/polite）断言，否则该场景的"通知"不可验证。

### B5（记录）：任务量与串行依赖

39 项任务中 1（结果核实）→2（收尾）→3（入口迁移）为硬串行链；4（创建工作区）是 UI 面最大单块且与 U3 模态纪律交叉多；6（实机八项）依赖 3/4/5 全部完成。规模陈述，非缺陷，按"一任务组一 commit"执行即可。

## 五、评审方法与限制

- 逐条核对了 proposal Why 与 design Context 的全部源码断言（第一节），并脚本对比了 7 条 MODIFIED 的场景差集与 74 场景的双向覆盖。
- 运行了 `openspec validate unify-run-execution-workflow --strict`：通过。
- 本评审不构成功能验收证据；实施与实机验收以 tasks 6.x/7.x 及 evidence-index 为准。

## 六、建议处理记录（2026-09-27）

本节记录评审后的文档修订；第四节保留原评审意见，B5 的任务数量已更正。以下“已纳入”仅表示设计与验收要求补齐，不表示功能已经实现或验收通过。

| 建议 | 处理 | 落点 |
|---|---|---|
| B1 | 已纳入：普通/隔离证据齐全才计整场景覆盖，缺一侧明确标记部分覆盖 | [tasks](tasks.md) 4.4/4.5/7.3；[design](design.md) Validation Strategy |
| B2 | 已纳入：核实与导航分为独立动作，核实零选择/滚动/焦点副作用，导航在实际切换前重验资格 | [design](design.md) D4/D6；[spec](specs/desktop-ui/spec.md)「列表失败不阻断已知结果」「读取途中离页仍不抢焦点」；[tasks](tasks.md) 1.2/3.4 |
| B3 | 已纳入：来源仅存 renderer 会话导航状态，进入创建时建立，设置往返沿用，重载失效且不入草稿 | [design](design.md) D1；[spec](specs/desktop-ui/spec.md)「创建工作区任务优先且可返回来源」；[tasks](tasks.md) 4.1 |
| B4 | 已纳入：全局 polite live 区域、实际结果文本更新、重复状态/计时去重及焦点不变均列入验收，明确 DOM 检查与实际播报的证据边界 | [design](design.md) D6/Validation Strategy；[spec](specs/desktop-ui/spec.md)「恢复核对重试与批次结果只通知」；[tasks](tasks.md) 5.2/6.8 |
| B5 | 已更正：35 项改为实际 39 项，依赖说明保留 | 本文第四节 B5 |

本次未新增或删除 requirement/scenario/任务，仍为 7 ADDED + 7 MODIFIED、74 个场景、39 项待办。
