# U6 change 复审与修订记录

> 日期：2026-09-29。对象：proposal / design / tasks / desktop-ui delta。范围：文档审阅与修订，未实施产品代码、未运行功能或 Electron 验收。

## 结论

已按 U4/U5 归档契约与现状源码完成修订。原稿的操作登记冲突、只读预检歧义、U5 收尾缺口、v2/混合链语义和任务引用问题已落实到四件套。当前为 **3 ADDED + 1 MODIFIED requirements、47 scenarios、55 个待办任务**；文档可作为实施基线，不能视为功能完成或归档放行。

前次评审所列根 run=complete/own、保留被编辑字段、隔代缺失、六类诊断和截断链首项等建议，在本次读取的稿件中已修订。本记录替换已滞后的评审结论，不把那些已修项重新列为本次发现。

## 对照依据

- [U4 design D2–D4](../archive/2026-09-27-add-desktop-operation-tracking/design.md)：先去重/接受/占槽，再业务门禁；已接受的拒绝必须有可核对终态。
- [U4 evidence-index](../archive/2026-09-27-add-desktop-operation-tracking/evidence-index.md)：MODIFIED 整段替换、逐场景证据回查、真实消费点缺支与反证纪律。
- [U5 design D3–D6](../archive/2026-09-29-unify-run-execution-workflow/design.md)：可信 ID 核实、自有终止事实、修订清理、读取与导航分离。
- [U5 evidence-index](../archive/2026-09-29-unify-run-execution-workflow/evidence-index.md)：区分单元/契约/实机可达性与历史限制，不把源码扫描或截图存在当行为证据。
- 源码核对：`apps/desktop/src/main/{run-repository,exec-endpoints,proxy-manager,workspace-view}.ts`、`apps/desktop/src/shared/{ipc,terminal-facts}.ts`、`apps/desktop/src/renderer/src/lib/result-verification.ts`、`packages/trace-sdk/src/{reader,branch}.ts`、`packages/replay/src/{prompt-fork,model-replay-run}.ts`。

## 本次发现与处置

| 级别 | 原稿问题及影响 | 已修订契约与落点 |
| --- | --- | --- |
| P1 | spec 声称详情加载失败“零 operation 副作用”，design 却要求登记后拒绝；破坏 U4 终态与去重顺序 | design D5 / 执行 requirement：接受后 settled/rejected、匹配回执、空 runIds、只释放自身槽；零副作用限定业务执行，不抹掉登记 |
| P1 | U5 后台结果读取、草稿清理与 ownOnly 的关系未定义，只提详情组件 | design D4/D6 / 新增结果衔接 requirement：两条读取入口均迁移；自有正常事件沿用原修订/token 判据，错误保留，来源警告与结局并存 |
| P1 | 统一写“截至 fork 点”会丢 v2 同轮后续工具；只按叶子区分独立轨迹会错拼混合链 | design D3 / MODIFIED：v1 span、v2 整轮、独立执行边界逐 hop 处理，未知 field 不默认为 result；不改公共执行解析 |
| P1 | “只遇 ENOENT 就降级”未说明更近的已知非法关系优先；reader 不证明全部文件身份与关系 | design D1/D2 / 新场景：校验路径与 meta.id、chain 连续性、自有 ID；可证明错误拒绝，依赖缺失记录的定位明确未核实；空自有 spans 合法 |
| P2 | A/B dry-run 只要求零调用，仍可能生成看似可执行计划；隔离 capability 未覆盖 | design D5 / 两个预检场景：同源拒绝，不生成有效计划或许可，不登记/占槽；恢复不复活旧确认 |
| P2 | 隔离 result 被写成带 sourceToken 的请求，真实 schema 仅创建路径有该字段，可能测到非法请求而非来源门禁 | 修正真实请求形状，要求合法负例和完整父本正对照；移除门禁应使对应反例变红 |
| P2 | 任务引用不存在的“部分详情不扩大文件读取范围”，或拿 requirement/章节名冒充 scenario；大量场景无明确任务 | 重排 55 个 <=2h 切片，逐任务引用精确 scenario 标题，47 场景全部至少有一项任务承接 |
| P2 | 单个“实机+全量门禁”任务过大，未区分注入可达性与真实行为证据 | §6 拆成五批实机及 fixture/反证，§7 单列工程门禁/差集/证据回查；历史未验证项继续留账 |
| P2 | 缺祖先和附件错误边界不充分，容易顺手封禁自有文件 | 保留 C 独立读取路径、清单与 blob 校验；自有文件可读，缺 blob 沿原附件错误展示 |

## 本轮实际验证

1. `node D:/npm-global/node_modules/@fission-ai/openspec/bin/openspec.js validate --all --strict --no-interactive`：**13 passed / 0 failed**（U6 + 12 个主 spec；既有超长 requirement 仅 INFO）。
2. Node 解析 delta、tasks 与主 spec：基线 **59 / 278**；delta **4 / 47**（ADDED 37、MODIFIED 10），**55** 项待办；不存在的任务场景引用 **0**，未被任务引用的场景 **0**，重复场景名 **0**。
3. MODIFIED 对比：主 spec 原“分支 run 的轨迹”标题保留；分叉点、被编辑字段、父来源三项义务保留；新增 v2、独立轨迹、截断链与文件边界。若按当前 delta 归档，预期主 spec 为 **62 requirements / 324 scenarios**（净增 3 / 46），本轮未合并主 spec。
4. `git diff --check` 通过；另对 U6 尚未跟踪文件逐行检查尾随空白与冲突标记。功能任务全部未勾选，不用这些文档检查冒充行为测试。

## 实施时继续遵守的边界

- U4/U5 的满载 IPC、configurationBusy 关闭文案、跨 epoch 在飞实机前提、ProxyManager 被动交错反证与空 diagnostics 等历史限制，不因本次修订被宣称已解决。
- 文件恢复由受控 fixture 执行，产品只读；指纹比较区分注入动作与产品动作。
- 不可稳定诱发的权限/缺臂/乱序故障如实分层，用真实 IPC/store 接线承载；不得加产品后门来制造实机证据。
- 实施中的契约变更先回四件套修订；完成全部任务和逐场景证据核对后另行处理归档、打包与发布。

## 二次复读核对（2026-09-29，对话侧）

独立复读四件套并抽查源码锚点与数量，结论：**修订稿可作为实施基线**。

- 数量复核：ADDED scenarios 22+10+5=37、MODIFIED 10，合计 47；任务 6+5+9+11+12+9+3=55；归档后主 spec 预计 62/324（278−1+10+37）。与上文记录一致。
- 源码锚点抽查全部属实：`exec-endpoints.ts` 的 `submitActive` 顺序（sender→信封→epoch→业务解析→`registry.submitExecution` 判重/占槽→`spec.run` 领域门禁）、`settled/rejected` 登记、`execModelAbPlan` dry-run 独立只读通道、隔离请求 `allowFileWrites: z.literal(true)` 且无 sourceToken、`resolveWholeRound`（trace-sdk/branch.ts）、`prompt-fork.ts`/`model-replay-run.ts`、`verifyResultPayload`（store.ts:985）。
- `openspec validate add-partial-run-reading --strict` 复跑通过。
- 前次评审五项（根 run 定死、被编辑字段、隔代缺失、六类诊断、截断链首项）确认全部落实。

两个轻微观察项（不阻塞实施，可在实施时顺手处理）：

1. **隔离 result 完整链无专属完整性 scenario**：ADDED requirement 下只有"普通 result 的完整父链仍合并"锁定 `complete/resolved`；隔离 result 的完整性组合仅在 MODIFIED"完整隔离 result 保留整轮前缀"中间接覆盖。建议补一条 WHEN/THEN 显式断言隔离 result 完整链返回 `complete/resolved`。
2. **"撤销"与"失效"措辞不一致**：design D4 写"父链变化**撤销**旧 capability、A/B 计划、确认和副本授权"，spec scenario 写"**失效**"。两者机制不同——主动吊销需要 main 维护已签发许可的状态，提交时重读则天然失效、无需新状态。按 D5 的服务端重读设计，实际语义应是"失效"；建议统一为"失效"或在 design 中明确不引入主动吊销机制。

### 两项观察的处置（2026-09-29）

1. 已在现有“完整隔离 result 保留整轮前缀”场景显式补齐 `complete/resolved`、完整 lineage/chain 与自有 leafSpanIds，并同步 task 3.7；不另增重复场景，数量仍为 47 scenarios / 55 tasks。
2. 已将 design D4、task 4.10 与对应 scenario 统一为“失效”，明确 main 每次新提交重读、不新增许可吊销登记或文件监听。补充区分：服务端重读只能保证执行拒绝，不能自动清除 renderer 的旧状态；renderer 从读取、预检或拒绝响应得知来源变化后，仍须复用 U5 检查代次使旧计划/确认/副本授权失效。未被读取发现的外部变化不承诺即时 UI 更新，恢复后也不复活旧确认。
