# U8 起草自检

日期：2026-10-01。本文件记录本轮文档自检，不代表独立评审、实施或实机验收通过。

## 基线与范围

- HEAD `d53b7d0` 已完成 U7 归档，起草前 OpenSpec list 为零活动 change；本次无需重复归档 U7。
- 实测主 spec：desktop-ui 70 requirements / 351 scenarios，model-experiments 13 / 43，llm-proxy 6 / 19。
- 对照拆分计划 U8、UI 方案 §11/§15.4/§16、U3/U4/U5/U6/U7 已归档契约及实际代码；同步拆分计划的 U7 归档状态和 U8 待实施链接。
- 仅修改本 change 与拆分计划；未改产品代码、主 spec、包能力或 HANDOFF.md，未执行 push。

## 代码事实与设计约束

1. `ProxyManager.toggle` 先保存配置再替换服务，端口占用可能已保存 enabled=true；状态分层和失败回读明确承认这一事实，修正旧“开关自动回停用”的界面承诺。
2. ProxyState 只含 enabled/running/port/upstreamBaseUrl/hasKey，没有监听地址、连接测试或最近请求契约；地址从已核实 port 构造，应用在飞/未知时不可复制，不新增仪表。
3. `proxy:toggle` 经过 main 配置锁而不登记主动操作；被动录制不占主动槽，messages 重发仍走已登记的 proxy:fork。停用时 key 可能仍在，但 handler 不在，hasKey 单独不能放行。
4. 现有 ModelAbEditor/MessagesForkEditor 位于 DetailPanel 内，草稿和操作事实已存在；迁移需补全局草稿返回、导航意图与复位表，不能另建一套编排。
5. 桌面 modelAbPlan 仍要求已配置 settings；CLI 无 apiKey 预览能力不变。dry-run 需读取父本，旧场景“不读写 trace”修正为只读校验且不改写/创建运行，保留零模型调用。
6. ModelAbResult.ids 只含成功臂，完整身份来自 operations.arms/target.armCount；dry-run experimentId 不作为真实批次标签。U7 标签仅分组且不豁免实验比较资格。
7. 计划失效绑定配置变更代次，涵盖只轮换 key 及保存后回读失败，不读取 key 值；修改再改回、乱序预览、放弃重建与离开恢复都有明确场景。

## Delta 差集

| Capability | MODIFIED | ADDED | Delta 场景 | 保留旧场景 | 新场景 |
|---|---:|---:|---:|---:|---:|
| desktop-ui | 3 | 6 | 51 | 14 | 37 |
| model-experiments | 2 | 1 | 16 | 6 | 10 |
| 合计 | 5 | 7 | 67 | 20 | 47 |

5 个 MODIFIED 名称与当前主 spec 精确匹配，携带完整最终 requirement，20 个旧场景名全部保留；7 个 ADDED 名称不与主 spec 重名。47 个新场景均有精确任务引用，包括 MODIFIED 中新增的场景，不只统计 ADDED 区块。

有意修改的原行为：

- 代理设置 requirement 从设置分区改独立录制工作区，启用场景通过设置跳转；占用错误从伪回滚改保留输入及已保存/监听事实分层。
- messages requirement 改为通过自有调用入口进入主工作区，原重发、空 fork、凭据及非代理拒绝保持。
- 设置 requirement 不再维护代理未应用字段和重复表单，模型未保存保护及单向密钥保持；原录制入口场景改为真实工作区跳转。
- 实验分组 requirement 去掉 ComparePanel 组件绑定；三臂先进入指标表再选两条，experimentId 仍仅分组，不参与资格或 config_hash。
- 成本 requirement 明确针对当前有效计划确认；无密钥 dry-run 场景允许必要的父本只读校验，继续零 provider 调用、零写入。其他参数、工具、执行和 CLI 规则保持。

## 检查结果

- `openspec validate --all --strict --no-interactive`：13 passed / 0 failed；既有长 requirement 提示为 INFO。
- `openspec status --change unify-recording-and-experiment-workspaces --json`：proposal/specs/design/tasks 均 done，仅表示规划材料齐全。
- 结构核对：MODIFIED 基线/旧场景保留、ADDED 重名、新场景任务映射、所有显式任务场景名、文档相对链接、空白和冲突标记通过。辅助回查脚本 `.rebaseagent/u8-verify-docs.cjs` 为本地过程文件，不作为产品测试。
- 共 52 条任务，全部未勾选；fixtures 和行为反证分拆，单条实现不超过 2h，实际超出时继续拆分。
- `git diff --check` 通过；未跟踪文档额外检查空白和冲突标记，提交前再检查 staged diff。

本轮未运行产品测试、构建或 Electron，未产生功能交付证据。evidence-index 在任务 1.1 建立，所有实现与实机场景仍待验证；历史 U4/U5/U7 环境限制及欠账不在本次文档阶段自动清零。归档与发布另按实施后的真实证据决定。

## 独立复审（2026-10-01，对话侧）

独立复读四件套、主 spec 与现状源码，结论：**U8 起草稿可作为实施基线**，发现 1 项 P2（任务映射纪律）与 2 项不阻塞观察项。

### 已核实事实

- 数量复核（脚本独立解析）：主 spec 基线 desktop-ui **70 / 351**、model-experiments **13 / 43**、llm-proxy **6 / 19**，与 proposal/review 记载一致；基线 HEAD `d53b7d0` 为 U7 归档提交，U8 起草提交 `371c0be`。
- Delta 差集：**5 MODIFIED + 7 ADDED、67 scenarios（MODIFIED 内 31 + ADDED 36）**；5 个 MODIFIED 名称与主 spec 精确匹配、20 个旧场景名零丢失、ADDED 与主 spec 零重名、delta 内零重复场景名。desktop-ui 51 = 14 保留 + 37 新、model-experiments 16 = 6 + 10，与自检表格逐格一致。
- 任务映射：52 条任务全部未勾选；**47 个新场景均有精确任务引用、零悬空引用**（见下方 P2-1 的例外说明）。
- `openspec validate --all --strict --no-interactive` 复跑：**13 passed / 0 failed**，仅既有超长 requirement INFO。

### 源码锚点抽查（全部属实）

1. `proxy-manager.ts` `toggle`（L98–106）：先 `saveProxy` 再停旧服务/启新服务；`startServer` 抛错时已保存 enabled=true、running=false——与 D2「不伪造回滚、失败后回读真实状态」及场景「端口占用可见」的分层表述一致。
2. `shared/ipc.ts` `ProxyStateSchema`（L474–483）：仅 enabled/running/port/upstreamBaseUrl/hasKey，无地址/连通/最近请求契约；接入地址 `http://127.0.0.1:${port}/v1` 由 main 构造（proxy-manager.ts L124）。
3. `proxy-manager.ts` `fork`（L169–176）：`lastKey === undefined || handler === null` 双条件拒绝——停止后 hasKey=true 仍不可重发，支撑场景「停用代理仍有凭据不能重发」。
4. `config-endpoints.ts` `toggleProxy`（L116–137）：判锁与 `beginConfigurationChange` 之间无 await，配置互斥 + 执行槽门禁、不登记主动 operation，与 D2「防重复提交」和场景「代理应用沿用配置互斥」一致。
5. `exec-endpoints.ts` `execModelAbPlan`（L526–580）：只读通道、强制 dryRun:true、SETTINGS_NOT_CONFIGURED 前置、`checkRunSource` 拒绝 ownOnly/不可读父本、不占主动槽——支撑场景「桌面预览沿用配置前置且零执行」；dry-run 需读父本导出 plan，故将旧场景「不读写 trace」修正为「不改写 trace、不创建运行」是**事实修正**而非放松。
6. `fork-runner.ts`（L58–71）：`ModelAbResult.ids` 只含成功臂，失败/未开始臂身份在 `armFacts`（index/id 可为 null/outcome）——支撑「成功臂集合不隐去失败臂」与「预览标签不充当真实批次身份」（dry-run 的 experimentId 与后续真实执行各自生成，不可复用）。
7. U7 现状：ComparePanel 已被 CompareSelectionBar + 指标表取代；主 spec「既有四条指标对照仍可使用」明载两条进详细比较、三四条先入指标表再选两条、第五条拒绝——delta「实验结果选两至四条进入共用比较」与 model-experiments MODIFIED 去掉 ComparePanel 组件绑定均与 U7 归档现实对齐。

### 发现与处置建议

| 级别 | 问题 | 建议 |
|---|---|---|
| P2 | MODIFIED「设置往返保留编辑并真实反馈配置结果」下 5 个逐字保留的旧场景（两模式配置后返回任务 / 重跑编辑配置往返保持阅读 / 单向密钥与保存反馈不冒充连通 / 保存失败和保存后回读失败区分 / 清除确认包含凭据且受槽约束）**无精确任务引用**，仅由 6.12「两份 delta 全部场景」与 7.2 兜底。其中「重跑编辑配置往返保持阅读」的 WHEN 明确以「从 result、prompt、**messages 或 A/B 编辑**进入设置再返回」为入口——这两个编辑器恰是 U8 迁移对象，往返起终点实际改变，比其余四个更需要显式锚点。U6 收口纪律为「未被任务引用的场景 0」 | 为「重跑编辑配置往返保持阅读」补精确引用（最自然落点：1.3 设置往返不覆盖原来源，或 6.12 跨入口回归显式列出）；其余四个纯设置侧行为未受 U8 触及，可接受 6.12 兜底，但若维持 U6 纪律应一并补齐 |

不阻塞观察项：

1. 「录制端口校验不接受部分整数」的 renderer 字段级拒绝严于 main schema（zod 对 number 类型本就拒绝 18787abc/小数，且 int().min(1).max(65535) 拒 0/65536/空）——属纵深防御，无冲突；实施时单测应以「零配置写调用」为断言核心而非仅校 UI 提示。
2. design D4「计划 binding 含运行配置变化代次，涵盖仅轮换 key 的成功保存」与场景「配置轮换与来源撤销作废计划」措辞已一致（U6 曾出现「撤销/失效」混用，本轮未复现）；实施时注意该代次由**已核实保存/清除**推进，不要让普通 `proxy:status` 刷新误触发计划失效。

### 复审边界

本轮为文档与源码核对，未实施、未跑产品测试/Electron；不改变 52 条任务全部未勾选的状态，不构成归档放行。P2-1 落实后即可进入实施。

## 复审修订闭环（2026-10-01）

按复审意见修改 tasks 与 design，保留上方复审原文作为历史记录；本节为修订自检，不宣称再次独立复审或功能验收通过。

| 复审项 | 修订落点 | 验证要求 |
|---|---|---|
| P2-1：5 个设置旧场景缺精确任务引用 | 1.3 明确引用“重跑编辑配置往返保持阅读”，锁定 messages/A-B 新工作区与设置往返；6.12 显式引用全部 5 个旧场景并逐项验证；7.2 要求全部 delta 场景都有精确任务引用 | 全部 67 个场景均能定位到任务复选项，未引用场景 0、悬空引用 0 |
| 观察项 1：端口拒绝不能只看提示 | design D2 与任务 2.4 明确验证原始输入保留、可见字段错误及零配置写调用 | 非法端口不调用配置写通道，不能只用提示文本证明拒绝 |
| 观察项 2：配置代次不能被代理刷新误推进 | design D4 与任务 3.7 明确覆盖已核实保存/清除的失效路径及普通 proxy:status 刷新的保持路径 | 仅轮换 key 的成功保存或保存后回读失败撤销旧计划；普通状态刷新不推进配置代次、不误使有效计划失效 |

修订后检查：

- Delta 数量保持 5 MODIFIED + 7 ADDED、67 场景（20 保留 + 47 新）；52 条任务均未勾选，proposal 和 spec delta 无内容变更。
- 场景映射核对从“只检查新增场景”加强为“检查全部场景，且引用必须出现在任务复选项内”，67/67 精确引用通过；基线匹配、旧场景保留、重名、链接、空白及冲突标记通过。
- OpenSpec 全量 strict 13 passed / 0 failed；git diff --check 通过。

P2-1 的文档修订已落实，两项观察已进入明确实施判据。本轮仍未实施产品代码或运行产品测试/Electron，所有功能验收留在未勾选任务中。
