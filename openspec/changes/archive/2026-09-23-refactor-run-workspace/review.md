# U1 refactor-run-workspace 审阅

> 日期：2026-09-21
> 审阅对象：proposal.md / design.md / tasks.md / specs/desktop-ui/spec.md（提案完成、实现未开始状态）
> 结论：整体质量高，可进入实施。发现 1 个中等问题建议在实施前决策（P1），其余为低风险备注。
> 后续处理：用户已选择 P1 的 a 方案，修订落点见文末第四节；上方结论及以下审阅意见保留为修订前记录，不代表新实现已验收。

## 一、核对项

### 1. OpenSpec 校验

`openspec validate refactor-run-workspace --strict --no-interactive` 通过（输出 valid）。

### 2. MODIFIED requirement 完整性

六个被修改 requirement 均携带完整最终文本，且保留主 spec 全部既有场景：

| Requirement | 主 spec 场景 | delta 场景 | 既有场景保留 |
|---|---|---|---|
| run 列表从 traces 目录扫描派生 | 2 | 8 | 保留（崩溃的 run 措辞升级为"不当作执行中或文件读取错误"，兼容） |
| run 列表标注录制来源并可过滤 | 2 | 3 | 保留（徽标与过滤 / 老文件无来源） |
| 轨迹以 span 树呈现 | 2 | 5 | 保留（三步运行 / 工具报错） |
| 详情面板完整展示一步的原始请求与响应 | 2 | 5 | 保留（思维链 / 工具调用详情） |
| 界面提供分支树与轨迹两种视图 | 3 | 4 | 保留（切到分支树 / 跨视图保持 / 切换不重载） |
| 缓存命中可视化 | 8 | 9 | 全部保留，新增"输入为零与全未知缓存" |

### 3. 事实性声明抽查（均属实）

- `shared/derive.ts` 确有 buildSpanTree / deriveRunSummary / deriveCacheHitTotal / deriveMissingLlmErrorDetail，且同被 main/run-repository 消费。
- store.ts 为单份 `selectedSpanId` / `expandedSteps`；`selectRun` 同 ID 直接短路（store.ts:237），且详情请求无归属序号——D6 的改造前提与现状描述准确。
- lucide-react 不在 desktop package.json 中，proposal"当前没有图标库"属实。
- reason 枚举含 `aborted`（trace-sdk/src/schema.ts:379），delta 的中止终止态有 schema 基础，不会出现"合法详情永不触发"的死条款。
- 走查报告、V0.2 讨论文档及 proposal 引用的四张截图均存在，相对链接可解析。
- 与拆分计划一致：U1 边界（§4）、spec 修改归属（§6）逐条对上；四条 ADDED 均为新义务，未塞进无关 requirement。

## 二、问题与建议

### P1（中）：跨 capability 状态语义断言缺少 branch-tree delta

desktop-ui delta 在"run 列表"requirement 中断言"列表、概览及**既有分支树节点** SHALL 使用一致的状态文字与语义色（失败红、限制琥珀）"，但 branch-tree 主 spec（"分支树以节点-边图呈现运行与分叉"）仍只枚举 `completed` / `crashed` 两态，本 change 又声明"无独立 spec delta"。归档后 branch-tree 主 spec 与实际行为会出现未记录的漂移。三个选项：

- a) U1 增补最小 branch-tree delta，仅改节点状态文字枚举；
- b) 将 desktop-ui delta 断言收窄为"树节点复用同一状态派生与样式来源"，分支树节点状态文字的 spec 化明确留给 U7（拆分计划 §6 本就将该 requirement 列归 U7 顺序续改）；
- c) 维持现状，在 proposal 过渡行为中记录该漂移为已知事项。

**推荐 b**：改动最小，且与拆分计划的冲突控制表自洽。

### P2（低）：来源筛选术语变更需同步测试断言

标签由"仅代理 / 仅本地直录"改为"代理录制 / 本地记录"。主 spec 仅此一处引用，无连带；实施时注意组件文案与既有 e2e/组件测试断言同步，避免旧术语残留。

### P3（低）：两套宽度刻度需在验收口径中映射

design D2 使用 CSS 内容宽度断点（≥1280 / 960–1279 / 720–959 / <720），spec 场景与 tasks 7.1–7.2 使用窗口尺寸矩阵（1440/1360/1024/800）加"640px 内容宽度"及 200% 缩放。两套刻度各自自洽，但"640px 内容宽度"与"<720px CSS 分档"的对应关系建议写入 7.7 的 evidence-index，避免验收时混淆"窗口宽度"与"内容宽度"。

### P4（低）：受控模型服务为 tasks 6.4–6.6 的隐式前置

6.4–6.6 依赖"受控模型服务"，proposal 未显式确认 A3 基线的基础设施可复用范围。预期存在；实施第 6 组前确认即可，不阻塞先行的 1–5 组。

### P5（微）：requirement 标题与承载位置不一致

MODIFIED"详情面板完整展示一步的原始请求与响应"标题仍称"详情面板"，正文第一句已改为"在步骤工作区展示"。保留标题可减少 spec 噪音，仅提示存在轻微措辞不一致，不要求修改。

## 三、亮点

- 证据与验收分离的纪律贯彻：明确"改造前截图不构成验收"，tasks 7.7 要求逐场景 evidence-index 且"证据不足不勾完"。
- 忠实性原则覆盖完整：未知不补零、祖先输出/错误不冒充本次、失败占位零用量附解释、缓存部分覆盖不称全量命中率、正常结束不声称测试通过。
- D6 的 requestId 归属设计精准命中现状缺陷：现有 `selectRun` 的同 ID 短路（store.ts:237）使"同 run 显式重试"在当前实现中不会真正重读，delta 的"快速切换及同运行重试不串响应"场景直接约束了这一点。
- 任务粒度全部 ≤2h 且逐条映射 scenario；过渡行为一节把 U2–U8 的未交付边界写死，防止验收时越界宣称。

## 四、审阅后修订记录（2026-09-21）

本节记录提案修订，不改写原审阅结论，也不作为实施验收证据。

| 意见 | 处理与落点 |
|---|---|
| P1 | 按用户选择采用 a：新增 [branch-tree delta](specs/branch-tree/spec.md)，完整保留原 requirement 的四个场景，补三个节点结局场景。底层 completed/crashed 两态不变，细分仅用于文字/颜色；proposal、design D4、tasks 2.1/6.2/7.7 及拆分计划归属同步，U7 基于 U1 归档后版本继续。 |
| P2 | tasks 4.4 明确同步组件、测试断言/描述及相关注释，检索当前源码/测试中的旧来源术语，历史归档保持原样。 |
| P3 | design D2/D7 及布局场景、tasks 1.4/7.1/7.2/7.7 明确应用 CSS 视口和局部正文的区别；640px 视口映射 <720px，200% 缩放独立实测，证据记录窗口/视口/工作区/缩放各层。 |
| P4 | proposal/design 记录 mock 服务已核实的 SSE/工具剧本/请求日志能力与非流式/失败/延迟缺口；新增 tasks 6.0 为 6.4–6.6 的明确前置，尚未实际运行回归。 |
| P5 | 保留现有 requirement 标题，正文继续明确步骤工作区承载位置，不增加重命名 delta。 |
