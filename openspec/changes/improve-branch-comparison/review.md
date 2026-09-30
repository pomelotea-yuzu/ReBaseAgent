# U7 起草自检

日期：2026-09-30。此文件记录文档自检，不代表实现验收或独立审查通过。

下方“基线与范围”“Delta 差集”“检查结果”及“独立评审”为首版记录，保留评审时的计数与原问题。当前修订内容、计数和复核结果见末尾“评审修订闭环”。

## 基线与范围

- 基线 HEAD：`40e5dcc`，U6 已归档；起草前 `openspec list --json` 返回零活动 change。
- 对照 U 拆分计划 U7、UI 方案 §14/§15.1–15.3、走查 R8/R9，以及 U1/U2/U6 和现行模型实验契约。
- 实际代码核对：BranchTree 仍以局部缩放及全森林布局呈现，ComparePanel 固定 256px 且 ID 截前 7 位；已有 shared/nav 稳定短 ID、overview/outcome 派生、U6 完整性和 U2 阅读状态可复用。
- 活动 change 为 `improve-branch-comparison`，仅编写文档；同步拆分计划状态为已起草、待实施。既有 HANDOFF.md 未修改。

## Delta 差集

| Capability | MODIFIED | ADDED | Delta 场景 | 保留旧场景 | 新场景 |
|---|---:|---:|---:|---:|---:|
| branch-tree | 2 | 3 | 23 | 13 | 10 |
| desktop-ui | 3 | 8 | 40 | 15 | 25 |
| model-experiments | 1 | 1 | 7 | 2 | 5 |
| 合计 | 6 | 12 | 70 | 30 | 40 |

6 个 MODIFIED requirement 名均与主 spec 精确匹配，30 个旧场景名全部保留；12 个 ADDED 均不与主 spec 重名。有意修改如下：

1. 分支节点条款：来源链高亮不一律表示共享执行前缀，明确单击与打开；保留旧“选中高亮共享前缀”场景名用于连续追踪，场景结论按真实来源语义修正。
2. 多运行指标条款：增加宽幅表、经校验读取及模型实验优先门禁，原六个场景保留。
3. 视图切换条款：指标和输出进入完整工作区，解除尚未实现输出入口的阶段限制。
4. 概览条款：增加普通运行真实父子比较入口，模型实验不能借此绕过条件，输出/消耗原判据保留。
5. 执行流程条款：只读回归允许已实现比较入口，未实现取消仍无空入口。
6. 模型实验条款：保持原可比条件及禁止臂间结论，明确历史证据校验、混选拒绝、跨批身份和缺证处理。

本轮不合并主 spec。表格为 delta 计数，不是已交付覆盖率。

## 检查结果

- `openspec validate --all --strict --no-interactive`：13 passed / 0 failed；既有超长 requirement 提示为 INFO。
- `openspec status --change improve-branch-comparison --json`：proposal/specs/design/tasks 均 done，表示规划材料齐全。
- 结构自检：MODIFIED 基线与旧场景保留、ADDED 名称、40 个新场景到任务的引用、所有显式任务场景名、文档相对链接、尾随空格及冲突标记均通过。
- 任务共 60 条，全部未勾选。较大的读取、字段证据、v1/v2 来源映射与纯校验提取已拆开并说明依赖顺序；实施超出 2h 时继续拆分。
- `git diff --check` 通过；新增未跟踪文档另由结构自检覆盖空白和冲突标记。

未运行产品测试、Electron 或构建。本轮不存在新的实机证据；实施阶段须按 tasks 建立 evidence-index，并保留历史 U4/U5 未验证限制，不能把文档校验当功能交付。

## 独立评审（2026-09-30，对话侧）

独立复读 proposal / design / tasks / 三份 delta，并对基线、MODIFIED 匹配、代码锚点逐项核对。结论：**规划质量高，可作为实施基线；1 个 P2 场景级遗留需在实施前修订，3 个 P3 观察项可顺手处理。**

### 核实通过项

- 基线：`40e5dcc` 确为 U6 归档提交；主 spec 实测 desktop-ui 62/324、branch-tree 8/24、model-experiments 12/38。
- 6 个 MODIFIED requirement 名与主 spec 精确匹配；30 个旧场景（7+6+4+8+3+2）全部保留，逐名比对无遗漏。
- Delta 场景计数复核：branch-tree 23（13 旧 + 10 新）、desktop-ui 40（15+25）、model-experiments 7（2+5），合计 70；任务 60 条（7+4+7+14+16+9+3）。抽查任务引用的场景名全部真实存在。
- 代码锚点全部属实：[BranchTree.tsx:106](file:///d:/ReBaseAgent/apps/desktop/src/renderer/src/components/BranchTree.tsx#L106) `layoutRunTree(buildRunForest(runs))`、zoom 局部 `useState`；[ComparePanel.tsx](file:///d:/ReBaseAgent/apps/desktop/src/renderer/src/components/ComparePanel.tsx) `w-64`/`w-14`/`slice(0, 7)`；`deriveComparison`/`deriveChainTotals`/`deriveOwnOutput`；U6 交付的 `readRunLineage` 单次读取上下文与 `run-source-gate`；[nav.ts](file:///d:/ReBaseAgent/apps/desktop/src/shared/nav.ts) 后缀唯一短 ID + `ShortIdState` 会话只增不减。
- `openspec validate improve-branch-comparison --strict` 复跑通过。
- 与拆分计划 U7 边界、V0.2 §14/§15.1–15.3、A/B 特例（不产臂间差值/胜出臂）及 Non-goals 逐条对应；review 自检声明的 6 项有意修改与实际 delta 差异吻合（抽查"选中高亮共享前缀"结论修正、"父缺失导致判定不完整"原文未动）。
- D3 比较快照正确建立在 U6 交付物上（单次读取上下文、逐对象 ready/unavailable、ownOnly 撤销沿链结论），与 U6 的 `readRunLineage` 语义无冲突。

### P2（建议实施前修订）

**"非法详情不被概览绕过"场景与 U6 交付语义冲突（陈旧场景）。** desktop-ui MODIFIED"运行概览呈现自有结果与消耗"原样保留了该场景："…或现行解析拒绝的缺祖先 THEN …不宣称已支持缺父链降级"。U6 已交付 ownOnly 结构化降级：缺祖先现在返回 ownOnly 部分概览（U6 spec 明确概览显示"仅显示本运行记录，父链不完整"），不再是"原位详情错误"。这段文本是 U6 归档时未触及此 requirement 的遗留，U7 正在修改这条 requirement 却继续保留过时结论，归档后矛盾将固化进主 spec。建议改写：缺祖先 → ownOnly 概览可读但链结论受限；损坏/版本/非法字段保持详情错误与重试；删去"不宣称已支持缺父链降级"。

### P3（观察项）

1. **ComparePanel 组件名绑定**：model-experiments MODIFIED 正文与"共同祖先可比"场景仍写"复用…ComparePanel 的状态展示"/"ComparePanel 判定存在共同祖先"，而 U7 恰好要把 256px 的 ComparePanel 替换为宽幅指标表。capability spec 绑定将被替换的组件名，归档即过时。建议改为"共用比较工作区/宽幅指标表"。
2. **"规定摘要行"悬空**：branch-tree ADDED"分支节点与关系列表提供明确可访问动作"正文"节点 SHALL 使用稳定尺寸容纳规定摘要行"——摘要行清单只在 design D2 枚举（任务摘要、短 ID、模型、状态、时间、自有步数/tokens），spec 内无定义；且 MODIFIED req 1 的节点字段清单（状态、任务名、创建时间、本 run 增量）不含模型/短 ID，而"长节点字段完整可读"场景却测试两者。建议在 spec 正文列全节点字段。
3. **选择顺序决定默认左右是隐式契约**：D1"恰好两条时默认使用选择顺序"（先加子后加父则子左父右）与"父子入口默认父左子右"并存，行为可接受，但 spec 无任何场景锁定前者。建议在"三四条显式选两条阅读"或"更换交换不改变侧栏选择"场景补一句。

## 评审修订闭环（2026-09-30）

已按独立评审修订 proposal、design、tasks 与三份 delta，四项问题均已处理：

| 评审项 | 修订内容 | 验收关联 |
|---|---|---|
| P2：概览缺祖先旧场景 | 保留“非法详情不被概览绕过”场景名，仅对当前记录缺失、损坏、版本、权限、成环或非法定位等严格错误报错；新增“缺祖先概览沿用已校验自有事实”，明确 ownOnly 的自有事实可读、链结论未知且执行资格不恢复 | tasks 1.8、6.6 |
| P3-1：ComparePanel 名称绑定 | model-experiments delta 正文与两个旧场景均改为共用比较工作区/宽幅指标表；既有共同祖先和链路派生、门禁及禁止臂间结论保持 | 原“共同祖先可比”“父链缺失或结果未封存”场景继续回归 |
| P3-2：节点摘要清单悬空 | 在 MODIFIED 节点条款和 ADDED 可访问动作条款中列全任务摘要、稳定唯一短 ID、记录模型、状态、创建时间、自有步数/tokens；长字段场景明确逐项可读，模型缺失标为未记录 | tasks 3.4、6.4 |
| P3-3：默认左右顺序未锁定 | 新增“手动两条比较按加入顺序确定左右”，包括先子后父时子左父右；显式父子入口仍父左子右，并同步 proposal 与 D1 | tasks 2.5、6.9 |

修订后 delta 计数：

| Capability | MODIFIED | ADDED | Delta 场景 | 保留旧场景 | 新场景 |
|---|---:|---:|---:|---:|---:|
| branch-tree | 2 | 3 | 23 | 13 | 10 |
| desktop-ui | 3 | 8 | 42 | 15 | 27 |
| model-experiments | 1 | 1 | 7 | 2 | 5 |
| 合计 | 6 | 12 | 72 | 30 | 42 |

本次新增两条场景，其中一条位于 MODIFIED 概览 requirement 内；净新增场景包含该条，不能只统计 ADDED 区块。任务新增 1.8 与 2.5，共 62 条，全部未勾选。

修订复核：OpenSpec 全量 strict **13 passed / 0 failed**；6 个 MODIFIED requirement 名及全部 30 个旧场景名保留；42 个新场景（含 MODIFIED 中新增场景）的任务引用、全部显式任务场景名、相对链接、空白与冲突标记通过；`git diff --check` 通过。model-experiments delta 已无 ComparePanel 名称，branch-tree delta 已无未定义的“规定摘要行”，概览 delta 已删除“不宣称已支持缺父链降级”的旧结论。

以上为文档修订闭环。产品代码与主 spec 尚未修改，未运行产品测试或 Electron 验收。
