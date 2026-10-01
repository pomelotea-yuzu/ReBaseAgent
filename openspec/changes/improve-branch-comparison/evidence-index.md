# U7 evidence-index：场景 → 证据逐行索引

> **范围**：三份 delta（`specs/branch-tree/spec.md` 23 条、`specs/desktop-ui/spec.md` 42 条、
> `specs/model-experiments/spec.md` 7 条）全量 **72 条场景（ADDED 41 / MODIFIED 31）**，
> 覆盖 16 条 requirement（branch-tree 2 MODIFIED + 3 ADDED；desktop-ui 3 MODIFIED + 8 ADDED；
> model-experiments 1 MODIFIED + 1 ADDED）。逐行列出：既有单元/契约证据引用、实机入口（批次）、当前状态。
>
> **状态口径**：`待验证`（6.1 建立索引时的诚实起点——单元证据在场但对应实机批次尚未执行）→
> `已交付`（对应批次的判据真的跑过且绿）→ `实机不成立`（真机无注入面，按单元/集成层承载并注明）。
> 状态翻转发生在 6.3–6.9 各批；本索引随 change 归档。**未知不得填已完成。**
>
> **引用格式**：`` `文件 › 用例名` `` —— 用例名逐字取自 `it(...)` 第一参数（无斜杠前缀 =
> `apps/desktop/test/` 下文件；含 `/` = 仓库相对路径）。由 `.workbuddy/u7/u7-61/verify-scenario-checklist.cjs`
> 逐条核对（文件存在 + 用例名在场），含 `--selftest` 反例。

汇总口径：**72 条场景（ADDED 41 / MODIFIED 31）**，已交付 **64** 条、待验证 **8** 条、实机不成立 **0** 条（6.4 实机 20 条 + 6.5 实机 20 条 + 6.6 实机 11 条 + 6.7 实机 7 条 + 6.8 实机 5 条 + 6.3 反证 1 条）

---

## 一、branch-tree delta（23 条）

### B1. 分支树以节点-边图呈现运行与分叉（MODIFIED，7 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 1 | 多分支家庭呈现 | `branch-tree.test.ts › 一个根节点 + 两个平级子节点，三条节点都在图里` + `u7-tree-view.test.ts › 入边标注带分叉摘要与分叉点 span id（不推断编辑内容）` | 6.4 实机（普通父子树标本） | 已交付（6.4 实机） |
| 2 | 代理分叉的边标注 | `branch-tree.test.ts › messages 分叉标「改 messages」，与 tool_result 分叉在图上可区分` | 6.4 实机（proxy 分叉标本） | 已交付（6.4 实机） |
| 3 | 选中高亮共享前缀 | `branch-tree.test.ts › 选中 C（A → B → C）⇒ A/B/C 三个节点在链上，兄弟分支不在` + `u7-tree-view.test.ts › 树根判定：沿 parent 上溯；父缺失/成环 ⇒ 自身即根（与森林提根同口径）` | 6.4 实机（深层链标本） | 已交付（6.4 实机） |
| 4 | 无分支时退化呈现 | `branch-tree.test.ts › 只有一条根 run ⇒ 单节点、无分叉边、不提示「无分支可用」` + `branch-tree.test.ts › 完全没有 run ⇒ 给出可操作的说明，不画空图` | 6.4 实机（单 run 数据目录） | 已交付（6.4 实机） |
| 5 | 节点按封存运行的终止原因区分结局 | `branch-tree.test.ts › 五种 reason 分别给出正确文字与语义色（completed 不是「已完成」）` + `branch-tree.test.ts › error 是红的、限制是琥珀的——同一屏里可区分，不只靠文字` | 6.4 实机（五种 reason 标本） | 已交付（6.4 实机） |
| 6 | 节点对中断和未知原因诚实降级 | `branch-tree.test.ts › crashed ⇒ 「运行中断」+ 中性色，不伪造活跃执行` + `branch-tree.test.ts › 已封存但 reason 未知 ⇒ 「结束原因未知」，且原值可在 title 里查看` + `branch-tree.test.ts › completed 却完全没有 reason（数据异常）⇒ 同样归未知，不冒充已完成` | 6.4 实机（crashed 真机 ✓；reason 未知/completed 无 reason 被 trace schema 的 reason 枚举拒 ⇒ 真机不可达，单元承载） | 已交付（6.4 实机） |
| 7 | 节点不把已恢复的工具错误当作终止失败 | `branch-tree.test.ts › toolErrors > 0 但 reason=completed ⇒ 仍显示「已结束」+ 正常色` + `branch-tree.test.ts › 也不得声称测试通过（封存 ≠ 质量已验证）` | 6.4 实机（工具错误+正常结束标本） | 已交付（6.4 实机） |

### B2. 多分支对照到 run 级指标与共同祖先（MODIFIED，6 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 8 | 两条兄弟分支对照 | `compare-derive.test.ts › 两条兄弟分支：共同祖先 = 父，祖先差 = 各侧累计 − 祖先累计` + `compare-metrics.test.ts › 两条兄弟 ⇒ 共同祖先 = 父` | 6.4 实机 | 已交付（6.4 实机） |
| 9 | 对照中含祖先关系 | `compare-derive.test.ts › 直接父子：共同祖先取父 run，父侧相对自身增量为零` | 6.4 实机 | 已交付（6.4 实机） |
| 10 | 超出对照上限 | `store.test.ts › 对照上限 4：第 5 条被拒绝并给出提示，已选集合不变` + `compare-metrics-table.test.tsx › 上限提示如实呈现（store 写下的 compareNotice）` | 6.4 实机 | 已交付（6.4 实机） |
| 11 | 对照不足两条 | `compare-metrics.test.ts › 单条 ⇒ 表 + 「再选一条即可对照」，不判定共同祖先` + `compare-metrics.test.ts › 无结论 ⇒ empty + 空集引导` | 6.4 实机 | 已交付（6.4 实机） |
| 12 | 分属不同根 | `compare-derive.test.ts › 分属不同根：两侧链完整且无公共 id ⇒ unrelated；两侧累计各自可读、增量差不计算` + `compare-metrics.test.ts › 链完整但无公共祖先 ⇒ 无（分属不同根），不冒充共同祖先` | 6.5 实机（不同根标本） | 已交付（6.5 实机） |
| 13 | 父缺失导致判定不完整 | `compare-derive.test.ts › ownOnly 侧：链截断 ⇒ 判定不完整 + 该侧累计未知；完整另一侧累计照常可读` + `compare-metrics.test.ts › 父缺失 ⇒ 判定不完整（说明不是本来就不同源），不呈现为不同根` | 6.6 实机（ancestorMissing 注入） | 已交付（6.6 实机） |

### B3. 分支视口可定位当前运行并恢复阅读（ADDED，3 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 14 | 首次进入聚焦当前分支 | `u7-tree-view.test.ts › 有选中运行 ⇒ 当前树 + 焦点该节点；无选中 ⇒ 全部、无焦点` + `u7-tree-view.test.ts › 首次 arm：按选中运行决定初始范围；再次 arm 沿用且不再给焦点（不重复居中）` | 6.4 实机（R9 复现） | 已交付（6.4 实机） |
| 15 | 搜索完整字段定位范围外运行 | `u7-tree-view.test.ts › 匹配完整原值：查询落在被展示截断的中段也能命中` + `u7-tree-view.test.ts › 完整 ID 片段命中；每个命中携带其所属已知树的根（范围外定位依据）` + `u7-tree-view.test.ts › 空结果明确提示且保持原渲染（不丢节点）` | 6.4 实机 | 已交付（6.4 实机） |
| 16 | 视口操作与返回保持逻辑布局 | `u7-tree-view.test.ts › 首次 arm：按选中运行决定初始范围；再次 arm 沿用且不再给焦点（不重复居中）`（视口持久化判据；布局确定性另有 `derive.test.ts › 布局可复现：同输入两次输出逐字段一致`） | 6.4 实机（R9 复现 + 返回恢复视口） | 已交付（6.4 实机） |

### B4. 分支节点与关系列表提供明确可访问动作（ADDED，4 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 17 | 长节点字段完整可读 | `u7-tree-view.test.ts › 节点字段：短 ID、模型缺失标「未记录」；完整 ID 在 title 里可读可复制` + `u7-tree-view.test.ts › 完整 ID + 复制按钮；完整任务展开/复制（LongText 契约）；模型缺失标未记录` | 6.4 实机（长任务/长模型/长 ID 标本） | 已交付（6.4 实机） |
| 18 | 选中打开与加入对比分离 | `u7-tree-view.test.ts › 列表渲染同一数据：行带选中/打开/加入对照三动作（均为可 Tab 聚焦的 button）` + `u7-tree-view.test.ts › 对照状态同步：inCompare ⇒ aria-pressed 且文案为「移出对照」` | 6.4 实机 | 已交付（6.4 实机） |
| 19 | 键盘关系列表与图同步 | `u7-tree-view.test.ts › 列表渲染同一数据：行带选中/打开/加入对照三动作（均为可 Tab 聚焦的 button）` + `u7-tree-view.test.ts › 选中与对比状态在列表可见（aria-pressed 同步）` | 6.9 实机（纯键盘闭环） | 待验证 |
| 20 | 父缺失与实验分组不造记录 | `u7-tree-view.test.ts › 缺父占位只显示真实引用与不可用原因，无任何动作按钮；原 run 保留` + `u7-tree-view.test.ts › 实验分组只按记录 experimentId：组头在首臂前出现一次，无标签 run 不进组` + `derive.test.ts › parent 链成环：环上的 run 提为根并标 cycle，不死循环` | 6.4 实机（缺父/成环/实验组标本） | 已交付（6.4 实机） |

### B5. 对照身份与四列指标保持可辨（ADDED，3 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 21 | 碰撞短 ID 不随筛选交换改变身份 | `nav.test.ts › 碰撞后延长，删除碰撞项后不缩短` + `nav.test.ts › 筛选不重编号：子集计算后已记录长度保持（用 update 全量后取子集）` | 6.8 实机（R8 碰撞标本） | 已交付（6.8 实机） |
| 22 | 四条指标名称始终可见 | `compare-metrics-table.test.tsx › 名称列 sticky（th sticky left-0）；横滚容器只包表格；运行列有最小宽度` + `compare-metrics.test.ts › 三条 ⇒ 提示显式选两条；四条同口径（列数与集合一致）` | 6.8 实机（四条 + 窄窗） | 已交付（6.8 实机） |
| 23 | 三四条显式选两条阅读 | `compare-metrics.test.ts › 三条 ⇒ 提示显式选两条；四条同口径（列数与集合一致）` + `compare-workspace-store.test.ts › 集合内互异两条 ⇒ 打开 pair 并按该序读取；全局集合纹丝不动` + `compare-metrics-table.test.tsx › 挑选条：两侧齐备才可打开详细比较（否则 disabled），未选侧显示（未选）` | 6.8 实机 | 已交付（6.8 实机） |

---

## 二、desktop-ui delta（42 条）

### DU1. 界面提供分支树与轨迹两种视图（MODIFIED，4 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 24 | 切到分支树 | `store.test.ts › 视图切换只改 view，不触发列表重新加载` | 6.4 实机 | 已交付（6.4 实机） |
| 25 | 选中状态跨视图保持 | `store.test.ts › 切换视图后选中的 run 保持不变（两视图共享选中状态）` | 6.4 实机 | 已交付（6.4 实机） |
| 26 | 切换不重载 | `store.test.ts › 切换不重载：setView 与 selectRun 都不触发列表请求` | 6.4 实机 | 已交付（6.4 实机） |
| 27 | 既有四条指标对照仍可使用 | `compare-metrics.test.ts › 状态/终止原因/创建时间/分叉点/实验组/步数/工具出错 各行与列对齐` + `compare-derive.test.ts › 两条兄弟分支：共同祖先 = 父，祖先差 = 各侧累计 − 祖先累计` | 6.4 实机（两条/四条进入指标表） | 已交付（6.4 实机） |

### DU2. 运行概览呈现自有结果与消耗（MODIFIED，9 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 28 | 正常结束直接看到最终输出 | `overview-result.test.ts › u1-ok：四条件齐备 ⇒ 结果区给最终输出与可定位调用` + `overview.test.ts › 正常终止 + 非空正文 + 无 error + 无待执行 tool_calls ⇒ 最终输出` | 6.5 实机（回归既有概览） | 已交付（6.5 实机） |
| 29 | 失败概览定位真实自有调用 | `overview-error.test.ts › u1-error-detail：有带 error 的自有 llm.call ⇒ 给可定位目标与错误正文` + `overview.test.ts › u1-error-detail：直读解析出的失败调用与派生目标一致` | 6.5 实机 | 已交付（6.5 实机） |
| 30 | 旧失败记录没有错误详情 | `overview-error.test.ts › u1-error-legacy：error 终止但自有 LLM 无错误详情 ⇒ missing，绝不虚构入口` + `overview.test.ts › 祖先带 error、自有成功 ⇒ 不把祖先错误当本次原因（missingDetail 为 true）` | 6.5 实机 | 已交付（6.5 实机） |
| 31 | 限制中止与中断如实展示 | `overview-error.test.ts › u1-crashed：无终止事件 ⇒ 运行中断，不标为正常成功或仍在执行` + `overview-error.test.ts › max_iterations / budget_exceeded：各自的限制说明互不冒充` + `overview-error.test.ts › u1-aborted：中止 ⇒ 明说「不是正常结束」，且已记录内容保留` | 6.5 实机 | 已交付（6.5 实机） |
| 32 | 无最终正文不借用祖先补全 | `overview-result.test.ts › u1-fork-child：子 run 零自有 llm.call ⇒ 不借用祖先正文（祖先的输出一个字都不出现）` + `overview.test.ts › 祖先有正文、自有段无正文 ⇒ 不借用祖先当最终输出或中间输出` | 6.5 实机 | 已交付（6.5 实机） |
| 33 | 本次指标不累计共享前缀 | `overview-consumption-source.test.ts › 自有 span 无 timing ⇒ durationMs 为 null 保留为未知（不当成 0）` + `overview-consumption-source.test.ts › 自有 token 全为 0 ⇒ 给占位零说明，不声称实际零消费` + `overview-consumption-source.test.ts › 祖先共享前缀的 token 不进本次消耗（展示层继承 2.3 的自有过滤）` | 6.5 实机 | 已交付（6.5 实机） |
| 34 | 来源和隔离边界保持真实 | `overview-consumption-source.test.ts › prompt fork ⇒ relation=independent，**禁止**说「共享前缀」（判据有牙）` + `overview-consumption-source.test.ts › 隔离续跑 ⇒ isolationNote 指向真实 origin.run_id 与轮末检查点，不声称改了文件` | 6.5 实机（四类分叉标本） | 已交付（6.5 实机） |
| 35 | 非法详情不被概览绕过 | `u7-overview-ancestor-cases.test.ts › 损坏 JSON：严格失败（非 ownOnly），不产出任何可渲染载荷` + `u7-overview-ancestor-cases.test.ts › 未来版本：读取层拒绝，不降级 ownOnly` + `u7-overview-ancestor-cases.test.ts › 成环：LINEAGE_CYCLE 诊断，绝无部分概览载荷` | 6.6 实机（ancestorCorrupt/未来版本注入） | 已交付（6.6 实机） |
| 36 | 缺祖先概览沿用已校验自有事实 | `u7-overview-ancestor-cases.test.ts › 固定提示 + 缺失 ID：措辞唯一来源不改写，缺失祖先可点认` + `u7-overview-ancestor-cases.test.ts › 自有结局可读：stopped/completed 正常结束（不因祖先缺失变 unknown）` + `u7-overview-ancestor-cases.test.ts › 自有消耗可读且口径说明在场：沿链祖先指标未知，不补零、不推算` | 6.6 实机（ancestorMissing 注入） | 已交付（6.6 实机） |

### DU3. 执行流程在窄窗口与键盘下连续可用（MODIFIED，3 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 37 | 长任务路径模型与结果不遮挡操作 | `focus-escape-responsive.test.ts › 操作面板 max-h 按视口比例钳制 + 横向不超 90vw` + `focus-escape-responsive.test.ts › 设置模态受 85vh 钳制并内部滚动（长表单/200% 缩放在框内滚，不撑破屏幕）` | 6.8 实机（五档宽度 + 200% 缩放） | 已交付（6.8 实机） |
| 38 | 创建页面键盘可离开而模态约束焦点 | `focus-escape-responsive.test.ts › 面板走共享 useEscapeClose(open, closePanel)；✕ 与 Esc 同一关闭动作`（模态约束键盘归 U5/U3 已交付实机批次；本轮 6.9 回归） | 6.9 实机（回归） | 待验证 |
| 39 | 只读反馈和读取重试保持数据边界 | `compare-readonly.test.ts › 选中→比较→重试→指标阅读→交换→返回：只产生 runs:compare，执行/写通道零调用` + `compare-readonly.test.ts › 不清草稿、不恢复授权：比较动作零新增确认、零改动草稿与来源撤销（许可状态面）` | 6.6 实机（只读计数/哈希核对） | 已交付（6.6 实机） |

### DU4. 双运行工作区保留比较对象和返回位置（ADDED，5 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 40 | 父子入口默认父左子右 | `compare-workspace-store.test.ts › 打开即父左子右：视图切比较、选中项与全局集合不动、读取按新序发起` + `compare-navigation.test.ts › 有真实直接父 ⇒ 打开，左=父、右=当前运行` + `compare-navigation.test.ts › model_params 臂 ⇒ 被实验门禁挡住，不提供普通比较旁路` | 6.9 实机 | 待验证 |
| 41 | 更换交换不改变侧栏选择 | `compare-workspace-store.test.ts › 更换一侧：pair 更新并按新序重读；侧栏选择不动；同 ID 拒绝、同值幂等` + `compare-workspace-store.test.ts › 交换左右：pair 反转并按新序重读；侧栏选择不动` | 6.5 实机 | 已交付（6.5 实机） |
| 42 | 手动两条比较按加入顺序确定左右 | `compare-workspace-store.test.ts › 恰好两条（先子后父）⇒ 加入顺序定左右：子左父右，并按该序读取（2.5）` + `compare-navigation.test.ts › 恰好两条 ⇒ 按加入顺序定左右：先子后父也是子左父右（不自动重排）` | 6.9 实机 | 待验证 |
| 43 | 返回恢复来源与单侧阅读 | `compare-workspace-store.test.ts › 返回来源：恢复视图与阅读位置，凭据一次性用掉` + `compare-workspace-store.test.ts › 打开单侧不清凭据：selectRun 离开比较 → 返回比较 → 来源引用仍在` | 6.5 实机 | 已交付（6.5 实机） |
| 44 | 后台结束不抢比较页且草稿保留 | `compare-readonly.test.ts › 不清草稿、不恢复授权：比较动作零新增确认、零改动草稿与来源撤销（许可状态面）` + `u6-partial-result-closure.test.ts › 不可读 → ownOnly 正常：重试后按原关联清理；全程零执行通道、不换选中项` | 6.9 实机（后台操作收尾 + 比较页在场） | 待验证 |

### DU5. 比较读取验证身份完整性并隔离迟到响应（ADDED，5 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 45 | 比较拒绝非法身份和错配载荷 | `compare-endpoint.test.ts › 非法 run 标识（目录穿越）整体拒绝，合法侧也一并拒绝且不建读取上下文` + `compare-endpoint.test.ts › schema 形状非法（超上限/重复/空 id/多余字段）走 INVALID_ARGUMENT 且受控文案` + `compare-read-contract.test.ts › 顺序不符拒绝：不把另一对象内容放到当前标题下` + `compare-state.test.ts › 响应与请求错配（缺一项）⇒ rejected 结论点明错配，不半截采信` | 6.3 反证（错配/越界变异）+ 6.6 实机 | 已交付（6.6 实机） |
| 46 | 列表完整但比较读取缺祖先 | `compare-endpoint.test.ts › 祖先缺失（ownOnly 语义）在比较中也是 ready 项：detail 自带 ownOnly 标签` + `compare-read-context.test.ts › 祖先 ENOENT 走结构化 ownOnly，detailOf 不抛；getRun 与上下文逐字同源` | 6.6 实机（ancestorMissing 注入） | 已交付（6.6 实机） |
| 47 | 一侧不可读保留另一侧 | `compare-endpoint.test.ts › 单侧失败不拖垮合法侧：损坏祖先与成环都逐项 unavailable，合法侧完整返回` + `compare-metrics.test.ts › 不可读列：标题只给身份与受控原因，行值显示 —（不借列表补齐、不补 0）` | 6.6 实机（ancestorCorrupt 注入） | 已交付（6.6 实机） |
| 48 | 快速更换交换移出不串内容 | `compare-state.test.ts › 无在飞请求时响应整份丢弃（离场/替换后的迟到响应无处落地）` + `compare-store.test.ts › 快速更换：旧响应在飞期间换对象 ⇒ 旧响应整份丢弃，不覆盖新选择集` + `compare-state.test.ts › 销毁清空全部在场事实但代次仍单调（迟到响应永不复活）` | 6.6 实机（延时注入竞速） | 已交付（6.6 实机） |
| 49 | 比较重试恢复必须全量重验 | `compare-store.test.ts › 重试先撤销旧结论再读取：成功后旧成功不被当成本次成功（代次单调）` + `compare-store.test.ts › 重试读到成功（祖先文件恢复）：整组重验后恢复 verified` | 6.6 实机（ancestorMissing → 恢复 → 重试） | 已交付（6.6 实机） |

### DU6. 修改比较只展示可核实编辑证据（ADDED，4 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 50 | 直接父子展示真实编辑前后值 | `compare-edit-evidence.test.ts › verified：原值 = 父 tool.invoke.result，新值 = 子 fork.edit.value，工具名保留` + `compare-edit-evidence.test.ts › v2 verified：variant/边界字段就位，resume_after_step 在父轨迹定位到 agent.step` + `compare-workspace-view.test.tsx › verified：方向标注（左列 → 右列）、语义标签、前后值、工具结果措辞` | 6.5 实机 | 已交付（6.5 实机） |
| 51 | 多跳兄弟展示逐跳修改链 | `compare-edit-evidence.test.ts › 兄弟两臂：各侧从共同祖先逐跳列出，跳数 = 链长（不压缩成一次编辑）` + `compare-edit-evidence.test.ts › 多跳链：C 侧两跳身份连续（A→B→C），每跳直接父核对通过，值从该侧投影视图取` + `compare-workspace-view.test.tsx › 逐跳链：每跳 source→target 独立成行（不压缩）` | 6.5 实机（多跳/兄弟标本） | 已交付（6.5 实机） |
| 52 | 不同根只核对实际输入配置 | `compare-edit-evidence.test.ts › unrelated ⇒ 两侧事实并排：模型/启动输入/参数取各自实际请求` + `compare-workspace-view.test.tsx › 不同根：两列事实并排，未记录如实标注` | 6.5 实机 | 已交付（6.5 实机） |
| 53 | 原值缺失未知字段不补空 | `compare-edit-evidence.test.ts › 来源侧不可读 ⇒ PARENT_UNREADABLE，子新值仍可见（祖先不可得不补空）` + `compare-edit-evidence.test.ts › fork.edit.value 字面缺失（undefined）⇒ EDIT_VALUE_UNRECORDED，与真实空串分开` + `compare-edit-evidence.test.ts › 真实空串新值是 value 不是未记录（不生成伪空 diff 的前提）` | 6.5 实机 | 已交付（6.5 实机） |

### DU7. 双运行输出沿用自有结局且完整可读（ADDED，2 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 54 | 最终输出不借中间正文或祖先 | `compare-output.test.ts › 最终输出 = 最后自有调用正文，结局 completed，无错误目标` + `compare-output.test.ts › 一侧 error 终止 ⇒ unavailable（错误不作为空文本参与 diff）` + `compare-workspace-view.test.tsx › 失败侧：未记录最终输出说明 + 中间正文（不冒充最终结果）+ 打开失败调用按钮` | 6.5 实机 | 已交付（6.5 实机） |
| 55 | 长输出独立阅读与合法文本差异 | `compare-output.test.ts › 双方最终文本就绪 ⇒ available，携带左右正文与产出 span` + `compare-output.test.ts › 一侧仅思维链 ⇒ unavailable（reasoning-only 不参与伪空比较）` + `compare-workspace-view.test.tsx › diff 模式（门禁可用）⇒ 只读 DiffEditor 面板就位` | 6.5 实机（长文本标本 + 复制/查找） | 已交付（6.5 实机） |

### DU8. 比较步骤按真实来源识别共享前缀（ADDED，3 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 56 | result 共享前缀保留真实边界 | `compare-source-map.test.ts › 双跳链 A→B：两段——A 段止于 B.at_span（带编辑标注），B 段为自有` + `compare-source-map.test.ts › v2 双段：父段止于 resume_after_step 子树末尾（同轮兄弟工具保留在前缀段），boundaryEdit 标注` + `compare-steps.test.ts › 折叠摘要：前缀行数、来源 run 去重、编辑清单（差异保留不隐藏）` | 6.5 实机 | 已交付（6.5 实机） |
| 57 | 重复 span ID 与独立分支不强行对齐 | `compare-steps.test.ts › 两侧重复的 s_01 / 相同轮号：各自目录独立成行，不对齐不合并（身份 = run + span）` + `compare-store.test.ts › selectCompareStep 只动本侧——两侧重复的 span id 各归各列` | 6.5 实机（重复 ID 标本） | 已交付（6.5 实机） |
| 58 | 缺父链仅显示自有步骤 | `compare-steps.test.ts › ownOnly 侧：prefixUnknown 如实标注，目录只含自有步骤；不推断根、不折叠未知祖先` + `compare-steps.test.ts › ownOnly 侧与完整另一侧互不影响：完整侧照常带前缀目录` | 6.6 实机（ancestorMissing 注入） | 已交付（6.6 实机） |

### DU9. 比较消耗区分自有累计和未知（ADDED，2 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 59 | 自有指标不重复计算继承前缀 | `compare-metrics.test.ts › 自有 tokens 只统计 leaf spans：继承前缀的调用不重复计入` + `compare-metrics.test.ts › 沿链累计 = 各代自有值沿链求和（含 prompt/messages/model_params 独立执行段）` + `compare-metrics.test.ts › 未知耗时保持未知：自有无 timing ⇒ 自有耗时 null；链上任一段未知 ⇒ 累计与祖先耗时增量 null` | 6.5 实机（继承前缀 + prompt 独立执行标本） | 已交付（6.5 实机） |
| 60 | 缓存未知零部分和失败占位分开 | `compare-metrics.test.ts › 未记录 / 零命中 / 部分记录三种缓存解释可辨` + `compare-metrics.test.ts › 失败占位零 token 与「未记录缓存」分开：占位说明挂在 tokens 行，不称实际零消费` | 6.5 实机（四种缓存/占位标本） | 已交付（6.5 实机） |

### DU10. 比较文件入口保持单运行合法检查点（ADDED，2 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 61 | 分别打开文件并返回比较 | `compare-workspace-store.test.ts › 隔离运行 + 自有完成步骤选中 ⇒ 打开文件页：检查点落在该自有步骤上，pair 与来源引用保留` + `compare-readonly.test.ts › 单侧文件打开（隔离 run）→ 返回比较：只走 runs:get + 文件清单只读，不碰执行通道` | 6.9 实机（两侧隔离 run 各保存不同检查点/path） | 待验证 |
| 62 | 非法文件目标与普通运行不造历史 | `compare-workspace-store.test.ts › 普通运行 ⇒ unsupported：不发起 runs:get、不进文件页（不造文件历史）` + `compare-workspace-store.test.ts › 选中步骤是祖先/非自有 ⇒ 打开文件页但不写该检查点（走 U2 已保存/默认）` + `compare-workspace-view.test.tsx › not-isolated：普通运行入口禁用并给原因（不造文件历史）` | 6.9 实机 | 待验证 |

### DU11. 比较工作区在窄窗口与只读操作下连续可用（ADDED，3 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 63 | 窄窗和缩放仍能完整阅读 | `compare-workspace-view.test.tsx › 宽容器 ⇒ 并排两列（grid-cols-2）` + `compare-workspace-view.test.tsx › 窄容器 ⇒ 上下排列（grid-cols-1）且对象标题重复（每列自带标题区）` + `compare-navigation.test.ts › 正文容器 ≥ 960 ⇒ 并排；< 960 ⇒ 上下排列（阈值按容器宽度，不是整窗）` | 6.8 实机（1440/1360/1024/800 + 200% 缩放） | 已交付（6.8 实机） |
| 64 | 键盘完成比较闭环 | `compare-workspace-view.test.tsx › 动作按钮全部带 focus-visible 焦点环（键盘焦点可见）` + `compare-workspace-view.test.tsx › 在飞读取不卸载动作按钮（交换/加载/重试不把焦点甩回页顶的静态前提）` + `u7-tree-view.test.ts › 列表渲染同一数据：行带选中/打开/加入对照三动作（均为可 Tab 聚焦的 button）` | 6.9 实机（纯键盘闭环） | 待验证 |
| 65 | 比较全程只读且不恢复许可 | `compare-readonly.test.ts › 选中→比较→重试→指标阅读→交换→返回：只产生 runs:compare，执行/写通道零调用` + `compare-readonly.test.ts › 指标表选两条（openComparePair）与更换/交换：同样零执行通道` + `compare-readonly.test.ts › 不清草稿、不恢复授权：比较动作零新增确认、零改动草稿与来源撤销（许可状态面）` | 6.3 反证（变异：任一执行通道被调用即红）+ 6.6 实机（计数/哈希） | 已交付（6.6 实机） |

---

## 三、model-experiments delta（7 条）

### ME1. 比较沿用共同祖先和现有派生口径（MODIFIED，2 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 66 | 共同祖先可比 | `experiment-records.test.ts › 合法臂：同源 hash + 首请求模型/参数自洽 ⇒ eligible` + `experiment-records.test.ts › 同父合法两臂 ⇒ eligible，批次身份保留各臂已记录 experimentId` + `compare-workspace-view.test.tsx › eligible：批次身份 + 相对父累计增量 + 无臂间结论恒定说明 + 副作用放行说明` | 6.7 实机 | 已交付（6.7 实机） |
| 67 | 父链缺失或结果未封存 | `experiment-records.test.ts › 任一臂 ownOnly（父链不完整）⇒ ineligible CHAIN_INCOMPLETE` + `experiment-records.test.ts › 存在不可读侧 ⇒ unverifiable RUN_UNREADABLE` + `compare-workspace-view.test.tsx › ineligible：受控原因 + 各记录单独打开入口（不恢复资格措辞）` | 6.7 实机 | 已交付（6.7 实机） |

### ME2. 共用工作区不能绕过实验比较资格（ADDED，5 场景）

| n | 场景 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|
| 68 | 合法同父实验臂展示事实 | `experiment-records.test.ts › 风险工具（标记缺失按有副作用）+ 显式 allowSideEffects: true ⇒ eligible（留痕）` + `compare-workspace-view.test.tsx › eligible：批次身份 + 相对父累计增量 + 无臂间结论恒定说明 + 副作用放行说明` | 6.7 实机（合法臂含 error/上限结局） | 已交付（6.7 实机） |
| 69 | 异父混选与相同实验标签不能绕过 | `experiment-records.test.ts › 异父臂 ⇒ ineligible PARENT_DIFFERS；相同 experimentId 不能绕过` + `experiment-records.test.ts › 混入普通 run ⇒ ineligible MIXED_SELECTION（experimentId 相同也不能豁免）` | 6.7 实机（异父/混选标本） | 已交付（6.7 实机） |
| 70 | 不完整未封存与前置缺证明确拒绝 | `experiment-records.test.ts › 臂缺 config_hash（老文件）⇒ unverifiable（不冒充通过、不反推）` + `experiment-records.test.ts › hash 不同源（工具表/system 被改过）⇒ ineligible（明确拒绝）` + `experiment-records.test.ts › 首请求模型与编辑值不一致 ⇒ ineligible` | 6.7 实机 | 已交付（6.7 实机） |
| 71 | 历史比较不依赖当前密钥和预览 | `experiment-records.test.ts › 合法臂：同源 hash + 首请求模型/参数自洽 ⇒ eligible`（deriveExperimentGate 为纯函数只吃已校验记录：全部判据用例均不读 settings/不联网/不预览——实机核对重启与清密钥后资格不变） | 6.7 实机（清除配置后历史读取） | 已交付（6.7 实机） |
| 72 | 交换和四列均不产出实验臂间结论 | `compare-metrics.test.ts › scopeNote 恒定在场：只呈现事实与相对祖先增量，无互差/胜出/最佳结论` + `compare-metrics.test.ts › 不输出金额、质量评分或模型胜负` | 6.7 实机（交换/改选/四臂） | 已交付（6.7 实机） |
