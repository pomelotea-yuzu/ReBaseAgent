# U1 `refactor-run-workspace` 场景 → 证据索引

> 任务 7.7 的产出。范围：本 change **两份 spec delta** 的逐场景覆盖——
> [`specs/desktop-ui/spec.md`](specs/desktop-ui/spec.md)（6 MODIFIED + 4 ADDED = 10 requirements /
> 55 scenarios）与 [`specs/branch-tree/spec.md`](specs/branch-tree/spec.md)（1 MODIFIED /
> 7 scenarios），合计 **11 requirements / 62 scenarios**。
>
> **本索引不自动归档、不发版；证据不足的场景标「⚠️ 未勾完」，不以"已通过"冒充。**
> 全套 7.1–7.6 已产证据真实存在；7.5 全仓 `1802 passed` 为基线，列内只嵌与本 change 直接相关者。
> 布局测量 JSON 位于 gitignored `.workbuddy/`，CDP 一次性探针脚本已提交 `apps/desktop/scripts/`。

## 怎么读这份表

- **证据**优先是**可执行的用例**（`测试文件 › 用例名`，行号不写、定位以用例名为准）；
  纯静态约束显式写"静态"。
- **测试**默认指 `apps/desktop/test/*.test.ts`（renderer/store/derive）；`packages/*/test` 见「由既有义务迁入的核对」。
- **CDP** 指 `apps/desktop/scripts/u1-7{1,1b,2,2b,3,4}-*.cjs`，各脚本头注释写明其验证意图；截图/测量落在
  gitignored `.workbuddy/u1-7*/`，归档用截图落在已跟踪草图目录 `docs/reviews/2026-09-22-u1-7*/`。
- **§布局证据**单列：每条按 design D7 记录原生窗口边界（含单位）、应用 CSS 视口、工作区/详情实测宽、
  Electron zoomFactor、devicePixelRatio 与 D2 断点映射；右下角不把「仅某局部正文为 640px」当作极窄场景通过。
- **fixture** 指 `.rebaseagent/u1-fixtures/`、`.rebaseagent/u1-lineage/`、`.rebaseagent/traces/*.jsonl`（真实 run）
  与 `.rebaseagent/workspace-blobs/sha256/*`（隔离文件世界），校验器见 `u1-outcome-fixtures.test.ts` / `u1-lineage-fixtures.test.ts`。

## 汇总

| requirement | 变化 | 场景数 | 已覆盖 | 未勾完 |
| --- | --- | --- | --- | --- |
| run 列表从 traces 目录扫描派生（MODIFIED） | M | 8 | 8 | 0 |
| run 列表标注录制来源并可过滤（MODIFIED） | M | 3 | 3 | 0 |
| 轨迹以 span 树呈现（MODIFIED） | M | 5 | 5 | 0 |
| 详情面板完整展示一步的原始请求与响应（MODIFIED） | M | 5 | 4 | 1（⚠️ 思维链分区未做事件级核验，契约级） |
| 界面提供分支树与轨迹两种视图（MODIFIED） | M | 4 | 4 | 0 |
| 缓存命中可视化（MODIFIED） | M | 9 | 9 | 0 |
| 运行工作区按阅读任务组织（ADDED） | A | 4 | 4 | 0 |
| 运行概览呈现自有结果与消耗（ADDED） | A | 8 | 8 | 0 |
| 会话内按运行恢复阅读位置（ADDED） | A | 6 | 6 | 0 |
| 工作区在窄窗口和键盘操作下可读（ADDED） | A | 3 | 3 | 0 |
| **desktop-ui 小计** | 6M+4A | **55** | **54** | **1** |
| 分支树以节点-边图呈现运行与分叉（branch-tree，MODIFIED） | M | 7 | 7 | 0 |
| **合计** | 11 | **62** | **61** | **1** |

> 补充说明：§布局证据 所有宽/窄/200% 尺寸均有**真实 Electron CDP 测量**（`u1-71` 的 Emulation
> 与真实窗口的差异、`u1-71b` 补出的 1440 档、`u1-72` 的 1024/800/640 与 200%）——即便个别场景细节
> 标了「⚠️ 契约级」，外层外壳承载与几何均有实测，不在"已覆盖"上虚标。

---

## desktop-ui

### 1. 运行列表从 traces 目录扫描派生（8）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 多份 trace 文件 | `run-list-nav.test.ts` ›「三条记录全部进列表，各自可辨」；`run-repository.test.ts` ›「四份 run 全部列出，按创建时间倒序」「单个文件损坏只隔离该文件，其余照常展示」；CDP `u1-74-snapshot`（`.workbuddy/u1-74/base.json`：58 份 trace 逐文件列出、哈希可信）；截图 `docs/reviews/2026-09-22-u1-71/01-*-runs.png` |
| 2 | 崩溃的 run | `outcome.test.ts` ›「crashed（无终止事件）⇒ 运行中断，不当作执行中或读取错误」「crashed 即便残留 reason 也判中断」；`run-repository.test.ts` › 崩溃读取识别；fixture `.rebaseagent/u1-fixtures/u1-crashed.jsonl`（无终止事件）；CDP 列表截图「出错终止 / 运行中断」徽章 |
| 3 | 封存状态不冒充正常结束 | `outcome.test.ts` ›「error ⇒ 出错终止，语义色为红（不是正常绿）」「max_iterations / budget_exceeded ⇒ 琥珀色限制」「aborted ⇒ 已中止」「completed 却无 reason ⇒ 结束原因未知」「工具曾出错后正常结束 ⇒ 仍判正常结束（错误是数据不是异常）」「未知 reason 保留原值」；`run-list-nav.test.ts` ›「步骤/工具错误数全在」；`compare-panel.test.ts` ›「五种 reason 结局与统一判据一致」「toolErrors>0 仍已结束」 |
| 4 | 完整任务和 ID 搜索 | `nav.test.ts` ›「匹配任务片段（大小写不敏感）」「匹配完整 ID 片段」「来源过滤 + 搜索求交集」「不修改原 task」；`run-list-nav.test.ts` ›「长任务的截断之外片段仍可命中（搜索用原值，不用两行摘要）」「按完整 ID 搜索命中」 |
| 5 | 同名运行的短 ID 稳定可辨 | `nav.test.ts` ›「无碰撞取末尾 8」「同尾片段逐字符延长」「后缀包含时较短者继续延长」「结果与输入顺序无关」「碰撞后延长、删除碰撞项不缩短」「新碰撞只在下次延长」「筛选不重编号」；`run-list-nav.test.ts` ›「store 的 shortIdState 是类实例，不新造本地 state」「短 ID 只用于展示：完整 ID 仍在 title/复制口径内」；fixture `.rebaseagent/u1-lineage/`（`zzzz0000a1b2c3d4` / `yyyy0000a1b2c3d4` / `0000a1b2c3d4`，三者同 8 位后缀） |
| 6 | 长模型和空任务的导航摘要 | `run-list-nav.test.ts` ›「空任务回退为『来源 · 时间 · 短 ID』并标 isFallback」「缺失模型显示『未记录』（不借用 settings.model）」「长模型原值保留」；`nav.test.ts` ›「空任务回退」「缺失模型」「超长模型原值保留（换行由 CSS）」「折叠空白最多两行」；`layout.test.ts` 长 ID/模型不遮挡（§布局）；u1-71b 实测 `emptytask` / `longtask` 块（空任务有回退灰字、长任务 title 携带 1730 字符原值）；截图 `docs/reviews/2026-09-22-u1-71/07-*-emptytask-nav.png`、`08-*-longtask-nav.png` |
| 7 | 刷新合并且保留阅读 | `store.test.ts` ›「刷新合并：请求在途时执行收尾触发的刷新被合并并尾随补发一次」「补发自身也在途时继续合并，不并发发射」；`run-list-refresh.test.ts` ›「刷新进行中且已有数据 ⇒ 不显示加载中（不盖掉旧记录）」；`reading-resolve.test.ts` › 阅读位置在跨 run 返回时恢复 |
| 8 | 列表刷新失败可重试 | `run-list-refresh.test.ts` ›「刷新失败 ⇒ 标记『未更新』且可重试」「首次失败不算『未更新』」「首次失败的独立重试」「空态成因用 resolveEmptyCause 分流」「有旧列表就保留」；`store.test.ts` ›「源记录不可用后重新出现即恢复」 |

### 2. 运行列表标注录制来源并可过滤（3）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 徽标与过滤 | `run-list-nav.test.ts` ›「全部：4 条」「代理录制：只剩 2 条代理」「本地记录：只剩 2 条本地」「来源徽标只在 proxy 上出现」「过滤按钮三档文案与 shared/nav 的枚举同口径」；CDP `u1-71b-cdp` 列表文案含「全部 / 代理录制 / 本地记录」（monaco 文本快照） |
| 2 | 老文件无来源 | `run-list-nav.test.ts` ›「source 为 null 的老文件归入本地记录过滤」「老文件照常显示一条摘要（不因缺 source 被吞）」「老文件不显示代理徽标」；`nav.test.ts` ›「matchesSource：无 source 老文件归本地记录」；fixture 目录含无 `meta.source` 的老 trace |
| 3 | 筛选隐藏当前运行 | `run-list-refresh.test.ts` ›「筛选隐藏当前运行的提示仍在（3.5 能力未回退，提供清除条件）」「有筛选条件且无数据 ⇒ filtered（给清除条件）」；`run-workspace.test.ts` ›「主工作区继续显示当前 run 的摘要/详情，不以空态顶替」；静态：来源过滤/搜索逻辑只作用于导航列表，不写 `selectedRunId` |

### 3. 轨迹以 span 树呈现（5）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 三步运行的树结构 | `span-tree-view.test.ts` ›「u1-ok：3 个 agent.step 各自展开后为其下 llm.call / tool.invoke 子节点」「缩进层级逐层递增」「只把 agent.step 视为可展开节点」；`call-detail-view.test.ts` ›「列出直接子调用，顺序与轨迹一致」；fixture `.rebaseagent/u1-fixtures/u1-ok.jsonl` |
| 2 | 工具报错 | `span-tree-view.test.ts` ›「tool.invoke.error 非 null ⇒ tool；error 为 null（成功）⇒ 无错」「u1-error-legacy 的失败工具被树判为 tool 错误」「工具错误行标『工具错误』；LLM 错误行标『LLM 错误』」；`overview.test.ts` ›「工具错误真实存在且可定位，与 LLM 错误缺失互不影响」 |
| 3 | 展开与调用选择互不干扰 | `span-tree-view.test.ts` ›「可展开行同时渲染展开按钮与选择按钮（两个独立 button）」「展开态只改 aria-expanded 与箭头，不改变选中态标记（两条通道互不驱动）」「选中态由 selected 独立驱动」「折叠某 step 只影响其子节点下钻，不影响选中通道」 |
| 4 | 首次步骤选择与空轨迹 | `reading-resolve.test.ts` ›「含祖先前缀时默认选首个自有调用（不停在祖先上）」「没有自有调用时回退首个可读 span」「空轨迹 ⇒ 空态，不伪造步骤」「当前详情为空轨迹 ⇒ 历史 saved span 不被恢复进来」；`span-tree-view.test.ts` ›「spanCount 为 0 ⇒ no-spans」「有 span 但无自有调用 ⇒ no-own-calls」「空轨迹判定优先于『无自有调用』」 |
| 5 | 继承轨迹与独立执行来源 | `span-tree-view.test.ts` ›「不在 leafSpanIds 里的 span 标 own=false（继承）」「u1-fork-child 的自有段（s_09/s_10）与父前缀可辨」「stepLabel 用记录原值，不沿链累加」「继承行渲染『继承』文字标记（不只靠颜色）」「自有行不渲染继承标记」；fixture `.rebaseagent/u1-lineage/`（result/prompt/model_params/代理 messages 谱系，见 tasks 1.2） |

### 4. 详情面板完整展示一步的原始请求与响应（5）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 推理模型的思维链 | ⚠️ **未勾完（契约级）**。`call-detail-view.test.ts` ›「LLM_CALL_FIELDS 逐条覆盖 spec 点名的字段」「输入/输出两半合起来不漏任何原始字段」——`reasoning_content` 的**字段可达**受契约覆盖；fixture `.rebaseagent/u1-fixtures/u1-reasoning-only.jsonl`；`overview-result.test.ts` ›「仅思维链 ⇒ 明说内容类型是思维链」。**但“与正文以区别样式单独分区”的渲染细节未做 jsdom/CDP 事件级核验**（jsdom 打不到真实开合样式），主语料来自字段契约与静态，不以“已通过”标注。 |
| 2 | 工具调用详情 | `call-detail-view.test.ts` ›「TOOL_INVOKE_FIELDS 逐条覆盖 spec 点名的字段」「tool.error 判定」「子树无 timing ⇒ durationMs 为 null（不伪装成 0）」；`span-tree-view.test.ts` › tool 行用工具名；fixture `u1-fixtures/u1-error-detail.jsonl`（tool 调用带 args/result/error）；截图 `docs/reviews/2026-09-22-u1-73/a1-tools-steps.png` |
| 3 | 长请求和原始字段完整可读 | `call-detail-view.test.ts` ›「ioCoversAllFields 为空 ⇒ 输入输出两半合起来不漏任何原始字段」「OPTIONAL_LLM_FIELDS 恰为两个可选字段」「stepFind 下一个/上一个」「命中切片拼回来等于原文（不丢字不多字）」；`overview-result.test.ts` ›「长正文（>600 字符）折叠为摘要、展开后为完整原文；开合由受控状态驱动」；静态：LongText 复制口径对应原始文本（`output`/复制入口） |
| 4 | 预算和错误能力迁移后可达 | `budget-reachability.test.ts` ›「地图点击用同一调用定位动作（selectSpan），不自造第二套选中逻辑」「预算地图随 run 身份重建」「失败 LLM 的错误区渲染 HTTP 状态/错误详情/占位零值解释」「摘要明说『无预算信息/未记录预算上限』」「main.tsx 不再静态装配 Monaco（懒加载）」；CDP `u1-71b-cdp`：隔离 run 步骤页 ECharts canvas 展开后懒加载在场、离线 Monaco 只读 diff 运行时挂载；截图 `05-*-isolated-steps.png`、`06-*-monaco-readonly-diff.png` |
| 5 | 模型输出不产生外部副作用 | `overview-result.test.ts` ›「渲染方式契约：概览与 LongText 都不解析标记、不加载远程图片、不执行脚本」；静态（`OverviewPanel.tsx` / `lib/overview-view.ts` 头注释）：正文用 React 文本 `{text}` 渲染，**从不** `dangerouslySetInnerHTML`，也不渲染 `<img>`/`<iframe>`；`overview-view.ts` 静态断言会拒绝含 `dangerouslySetInnerHTML`/`<script|iframe|img|object|embed>` 的写法 |

### 5. 界面提供分支树与轨迹两种视图（4）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 切到分支树 | `store.test.ts` ›「视图切换只改 view，不触发列表重新加载」；`nav.test.ts`/`reading-state.test.ts` 视图身份随 store；CDP 头部入口（`u1-71b` monaco 文本含「主视图切换 轨迹 分支树」）；分支树宽幅承载证据见 branch-tree 节 |
| 2 | 选中状态跨视图保持 | `store.test.ts` ›「切换不重载：setView 与 selectRun 都不触发列表请求」；`reading-state.test.ts` › 按 run ID 保存阅读状态；CDP `u1-73-cdp` `cross-run-restore`（B-在 r_01 选 write_file 并折叠第 3 轮 → 切到 A → 切回 r_01 **恢复页签=步骤、选中 write_file、第 3 轮保持折叠**）→ 证明同一选中身份下页签/展开/选中跨切换保持；截图 `b1-restore-r01-return.png` |
| 3 | 切换不重载 | `store.test.ts` ›「视图切换只改 view，不触发列表重新加载」「切换不重载：setView 与 selectRun 都不触发列表请求」 |
| 4 | 既有四条指标对照仍可使用 | `compare-panel.test.ts` ›「四条指标（状态/工具/tokens/耗时）并排在场，带分叉点与创建时间」「本 run / 沿链累计 / 相对祖先增量三口径并列且各自带口径名」「共同祖先显示为父 run，并给出各自相对它的增量」「上限提示在场、maxCompare 由入参决定」「超出上限如实提示」「不出现胜出/最佳/推荐结论」「不出现跨臂聚合差值」「没有未实现的输出比较入口」；CDP 分支树四指标对照（compare-panel capability） |

### 6. 缓存命中可视化（9）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | llm.call 详情展示缓存命中 | `cache-display.test.ts` ›「场景① 命中为主：800/1000 ⇒ 80%，tone=effective、措辞『前缀缓存生效』」「LlmCallDetailView 内出现 CacheHitRow，传 response.usage」「缓存命中行只由纯判据 presentCacheHit 驱动」 |
| 2 | 零命中仍展示为全量计费 | `cache-display.test.ts` ›「场景② cache_hit:0 ⇒ 照常展示、tone=full、措辞『全量计费』（不得因假值省略）」 |
| 3 | 少量命中不得被称为全量计费 | `cache-display.test.ts` ›「场景③ 128/323 ⇒ 40%，tone=partial、措辞『部分命中』且**不得**出现『全量计费』」「门槛为 50%」 |
| 4 | 无缓存字段的调用降级 | `cache-display.test.ts` ›「场景④ 无 cache_hit 字段 ⇒ null（降级省略，不报错、不显示 0）」「整行不渲染」 |
| 5 | run 级累计现算 | `own-consumption.test.ts` ›「3 次自有调用中 2 次带 cache_hit ⇒ recorded=2,total=3,合计为两者之和」「每份 fixture 的 (recorded,total) 与预期表一致」；fixture `u1-cache-partial.jsonl`；`run-list-nav.test.ts` ›「cacheHit 的 null 与 0 区别对待」「cacheHit/…在摘要同行」 |
| 6 | fork run 的累计不含祖先前缀 | `own-consumption.test.ts` ›「祖先带 cache_hit、自有段无字段 ⇒ 不计入覆盖（判据有牙）」「嵌套 cache 覆盖同源于自有段」；fixture `.rebaseagent/u1-lineage/u1r_parent/u1r_child`（共享前缀） |
| 7 | tool_result 分叉的模型不一致提示 | `cache-display.test.ts` ›「场景⑤ tool_result 分叉 + 模型不一致 ⇒ 给出信息性提示、点名两侧模型」「tool_result 分叉但模型一致 ⇒ 不提示」「ForkEditor 调用 forkCacheHint 且 kind 固定为 tool-result」 |
| 8 | 其它分叉形态不加缓存提示 | `cache-display.test.ts` ›「场景⑥ prompt fork ⇒ 不加缓存提示（无论模型是否一致）」「场景⑥ 代理 messages 分叉 ⇒ 不加缓存提示」「未知 ≠ 不一致：任一模型为 null ⇒ 不提示」 |
| 9 | 输入为零与全未知缓存 | `cache-display.test.ts` ›「场景⑦ in=0 且有记录 ⇒ percent 为 null（不做除法），但命中仍算已记录」「只给绝对 tokens，不出现任何百分比」「异常口径 cache_hit > in ⇒ 按输入总量截断并标注」；`own-consumption.test.ts` ›「输入为零且 cache_hit=0 ⇒ 只给绝对命中」「全部无字段 ⇒ recorded=0 且 hitTotal=null（不显示虚构零）」「只有 cache_hit:0 ⇒ recorded=1 且 hitTotal=0（不是 null）」 |

### 7. 运行工作区按阅读任务组织（4，ADDED）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 首次打开与无运行入口 | `run-workspace.test.ts` ›「首次（无历史）进入概览」「尚未选择运行时如实说『尚未选择运行』」「空态渲染新建与录制两个按钮且都可点击，正好两个」「空态文案解释两条真实路径、不写营销话术」；`reading-resolve.test.ts` ›「默认页签为概览（D1）」；CDP 空/首访态 |
| 2 | 文件承载区不附带步骤目录 | `run-workspace.test.ts` ›「正文槽承载 children（文件页里只有传入内容，不额外挂步骤目录）」「普通 run 没有文件页（不渲染出被选中的文件页）」；`span-tree-view.test.ts` ›「App 用 tab=steps 门控 SpanTree 挂载（概览/文件页不挂目录）」；`workspace-view.test.ts`/`workspace-file-view.test.ts`（A 段文件能力复核）；CDP `u1-71`/`u1-71b`：`files.shows步骤目录=false` + `files.hasWriteEntry=false`；截图 `04-*-files.png`、`06-*-isolated-steps.png` |
| 3 | 旧创建设置及执行入口保持可达 | `run-workspace.test.ts` ›「App 层只挂一个 CreateRunDialog 单例（两处入口共用）」「GlobalBar 的新建运行写 store.createDialogOpen」「GlobalBar 的录制接入定位到代理分区」「SettingsDialog 消费 settingsSection 定位到代理分区并一次性清账」；`controlled-entrances.test.ts` ›「连到配置的 baseURL：恰一次 SSE 提交（空工具表）」「编辑 read_file result 重跑：恰一次提交、父文件逐字节不变」「编辑 system_prompt 从头重跑：恰一次提交」——**三条真实受控提交已落盘**；CDP `u1-73-keyboard-tools`：新建/录制/设置/代理按钮 title 与工具名称均在 | 
| 4 | 阅读过程不修改已有数据 | CDP `u1-74-snapshot`（`.workbuddy/u1-74/base.json` → `read.json`）：阅读 5 个 run（概览+步骤）+ 隔离 v2/v1 文件世界后，**traces 58/58、workspace-blobs 6/6 逐文件哈希一致、文件数与字节数零变化、proxy 状态仍 stopped、执行入口仅新建/续跑**；`list-runs-perf.test.ts` ›「连续扫描不写任何文件：四份语料目录指纹逐字节不变，也不生成附件目录」；`workspace-view.test.ts` ›「完整浏览后数据目录指纹逐字节不变」（A 段复核） |

### 8. 运行概览呈现自有结果与消耗（8，ADDED）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 正常结束直接看到最终输出 | `overview.test.ts` ›「u1-ok：四条件齐备 ⇒ 最终输出即最后自有调用正文，无中间输出」「正常终止+非空正文+无 error+无待执行 tool_calls ⇒ 最终输出」；`overview-result.test.ts` ›「u1-ok：标题即『最终输出』，正文原文出现在结果区」；fixture `u1-ok.jsonl` |
| 2 | 失败概览定位真实自有调用 | `overview.test.ts` ›「u1-error-detail：error 终止且自有调用带 error ⇒ 给出可定位目标与真实正文」；`overview-result.test.ts` ›「u1-error-detail：失败前正文只作为中间输出，标题不叫结果」；CDP `u1-73-cdp` `error-location-priority`（点工具错误定位 → 切到步骤页、选中 read_file s_06、之父 s_04 展开）；截图 `c1-error-located.png` |
| 3 | 旧失败记录没有错误详情 | `overview.test.ts` ›「u1-error-legacy：error 终止但自有 LLM 无 error ⇒ 判缺失且不虚构入口」「祖先带 error、自有成功 ⇒ 不把祖先错误当本次原因」「工具错误真实存在且可定位，与 LLM 错误缺失互不影响」；`overview-result.test.ts` ›「u1-error-legacy：仍有可展示的中间输出，不虚构」；fixture `u1-error-legacy.jsonl` |
| 4 | 限制中止与中断如实展示 | `overview.test.ts` ›「非 error 终止（completed/aborted/crashed）⇒ 不产生错误目标也不报缺失」；`overview-result.test.ts` ›「u1-aborted：中止（有正文但非正常终止）不标为正常结束」「u1-crashed：无终止事件不冒充正常结束」；`budget-reachability.test.ts` ›「摘要标『已超预算终止』仅 exceeded 时出现」「running 不算终止于超限」；fixture `u1-aborted.jsonl` / `u1-crashed.jsonl` / 上限用 trace-sdk `infinite-loop.jsonl` |
| 5 | 无最终正文不借用祖先补全 | `overview.test.ts` ›「u1-reasoning-only：末次仅思维链 ⇒ 不当作最终输出，如实分型」「u1-tool-only：末次仅工具调用 ⇒ 不当作最终输出」「祖先有正文、自有段无正文 ⇒ 不借用祖先当最终输出或中间输出」「自有段有正文、祖先也有错误 ⇒ 正常结束仍取自有正文」；`overview-result.test.ts` ›「u1-fork-child：子 run 零自有 llm.call ⇒ 不借用祖先正文（祖先输出一个字都不出现）」；fixture `u1-fork-parent`/`u1-fork-child` |
| 6 | 本次指标不累计共享前缀 | `own-consumption.test.ts` ›「祖先共享前缀的 token 不计入本次消耗（判据有牙）」「自有 span 无 timing ⇒ durationMs 为 null（未知不补零）」「工具错误单独计数不影响 token」；fixture `.rebaseagent/u1-lineage/u1r_*`（共享前缀） |
| 7 | 来源和隔离边界保持真实 | `overview-consumption-source.test.ts` ›「presentSource：真实父本与执行语义分流」整组：根 run 无父/无返回入口、**result ⇒ relation=shared-prefix 且父 ID=真实 `u1r_parent`、canOpenParent=true**、prompt fork ⇒ relation=independent **且绝不含「共享前缀」字样**、model_params 臂 ⇒ independent 不冒充共享前缀、代理分叉 ⇒ proxy 不套共享前缀语义、隔离续跑 ⇒ isolationNote 指真实 `origin.run_id` + 「轮末检查点/独立世界」**且不出现「修改了源文件」/「已恢复历史磁盘状态」**、二次隔离父是直接父非链首、隔离根不套共享前缀；`SourceSectionView：静态结构` 组：有父渲染「返回父记录」入口、prompt fork 不渲染「共享前缀」、根 run 不渲染点不动的入口、隔离说明不含「修改了源文件」；接线契约组：`onOpenParent` 接 `selectRun(runId)`（不自己拼部分状态）。fixture `.rebaseagent/u1-lineage/{traces,isolated-traces}/`（`u1r_parent/u1r_child`、`u1p_child`、`u1m_arm_a`、`run_zz02`、`run_mub3nk*`） |
| 8 | 非法详情不被概览绕过 | `detail-request.test.ts` ›「版本非法（v1 载荷私带隔离字段）⇒ 拒绝加载，不落进 detail」「结构非法（schema 不符）⇒ 拒绝加载」「异常（getRun 抛错）⇒ 不落地，错误以文本呈现」；`detail-version-guard.test.ts` › 版本守卫先于 zod；`baddata-regression.test.ts` › 坏版本/未来版本/v1 非法隔离字段（6.7 回归）；fixture `.rebaseagent/u1-lineage/broken/`（`u1b_future`/`u1b_schema`/`u1b_v1ws`） |

### 9. 会话内按运行恢复阅读位置（6，ADDED）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 跨运行返回恢复阅读 | `reading-state.test.ts` ›「A/B 两个 run 记录同名 span 的不同阅读状态，互不影响」「同名 span 的调用分区状态也按 run 隔离」；`reading-resolve.test.ts` ›「历史有效 ⇒ 恢复到历史页签与 span」；CDP `u1-73-cdp` `cross-run-restore`（r_01 页签/选中/折叠恢复，见 §5-2） |
| 2 | 显式错误定位优先于恢复 | `reading-resolve.test.ts` ›「历史停在文件页 + 目标指向错误调用 ⇒ 进步骤页、选中目标、展开所属 step」「显式目标未指定页签 ⇒ 默认落在步骤页」；CDP `u1-73-cdp` `error-location-priority`（先形成历史位置，再点错误定位 → 覆盖历史、跳到 read_file s_06） |
| 3 | 失效阅读对象安全回退 | `reading-state.test.ts` ›「span 失效 ⇒ 清空选中并标记失效（不选另一个 run 的同 ID span）」「展开项/调用分区中的失效 id 被清理」「文件页签对非隔离 run 不再适用 ⇒ 回退概览」「对隔离 run 仍适用（不误回退）」「空 span 集合不崩」；`reading-resolve.test.ts` ›「显式目标指向的 span 失效 ⇒ 降级到默认位置」「历史 span 失效 ⇒ 回默认位置并标记失效」「历史页签为文件但 run 无文件 ⇒ 回退概览」 |
| 4 | 快速切换及同运行重试不串响应 | `detail-request.test.ts` ›「A 的慢响应后到 ⇒ 不覆盖已选中的 B」「A 的迟到成功不把 B 的 loadingDetail 清掉」「A 的失败在切 B 后到达 ⇒ 不写 error」「同 run 重试：再重读不被打断」「同 run 连续两次，先发旧响应后到 ⇒ 被丢弃」「非法详情切走后到达 ⇒ 既不落地也不报错」；CDP `u1-73-cdp` `rapid-switch`（快速 A→B→A 后无错误残留、loading 收尾、最终选中与详情一致）；截图 `d1-rapid-switch-final.png` |
| 5 | 已选源记录不可用 | `store.test.ts` ›「已选源记录不可用（记录消失）：旧内容保留但执行入口禁用，重新出现即恢复」「已选源记录不可用（读取失败）：报不可读而非消失，同样禁用执行」「列表尚未成功加载时源状态为 unknown：不误报不可用也不放行执行」 |
| 6 | 阅读恢复不保存授权或草稿 | `reading-state.test.ts` ›「阅读状态字段集固定，不含授权/草稿类键」「patch 透传的任意键也限于上述字段（类型层面无授权键可写）」；静态（Non-goal）：阅读位置只存会话、不落盘 → 重启无跨进程阅读恢复承诺，属非承诺项，无"应测试但缺"的回退（D6） |

### 10. 工作区在窄窗口和键盘操作下可读（3，ADDED）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 多尺寸与放大下关键阅读可达 | `layout.test.ts` › 四档断点常驻/折叠/单工作区 + 480px 二次约束；CDP 实测矩阵见 **§布局证据**（1440x900 / 1360x860 / 1024x768 / 800x600 / 640px + 200%）；截图 `docs/reviews/2026-09-22-u1-71/*-runs.png`、`u1-72/a1-*.png`、`u1-72/c1-zoom200-680px.png` |
| 2 | 自动折叠后恢复用户布局 | `layout.test.ts` ›「自动折叠不写回偏好：同一次调用不改动 prefs（宽度恢复后即还原）」「用户显式收起后即使 ≥1280 也不显示（只有临时打开能盖过去）」；CDP `u1-72-cdp` `autoCollapseRestore`：wide 键盘调到 **344px** → narrow 自动折叠（未挂载）→ 回 wide `aria-valuenow` **还原为 344px**（D2 preservePrefs 在真实 Electron 复现）；截图 `u1-72/b1-narrow-800-collapsed.png`、`b2-wide-restored.png` |
| 3 | 键盘导航及工具名称 | `icon-button.test.ts` ›「纯图标按钮渲染 aria-label 与 title，图标装饰对读屏隐藏」「带 hint 时 title 拼原因」「焦点样式类存在（focus-visible 环）」「激活态走 aria-pressed，不只靠颜色」「禁用态是 DOM 级 disabled」「空名称/颜色-only 状态都被判错」；`run-workspace.test.ts` ›「页签按钮都有可访问名称（title 与可见文字同在）」「当前页签用 aria-selected 表达」；CDP `u1-73-cdp` `keyboard-tools`（Tab 20 次聚焦记录、每按钮有名称/文字、工具行 title=工具名可见、复制 ID aria 语义）；`layout.test.ts` › 键盘 ±16px/Home/End 夹到合法范围 |

---

## branch-tree

### 11. 分支树以节点-边图呈现运行与分叉（7，branch-tree 1 MODIFIED）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 多分支家庭呈现 | `branch-tree.test.ts` ›「一个根节点 + 两个平级子节点，三条节点都在图里」「两条边各标注『改 tool_result』（result 映射），不推断编辑内容」「节点展示任务名、创建时间与本 run 增量（步数 · tokens）」；fixture `.rebaseagent/u1-lineage/u1r_parent`（A→B1/B2 子链） |
| 2 | 代理分叉的边标注 | `branch-tree.test.ts` ›「messages 分叉标『改 messages』，与 tool_result 分叉在图上可区分」；fixture `u1-lineage/run_zz01→run_zz02`（代理改 messages、source.kind=proxy、无 config_hash） |
| 3 | 选中高亮共享前缀 | `branch-tree.test.ts` ›「选中 C（A→B→C）⇒ A/B/C 三个节点在链上，兄弟分支不在」「未选中任何 run ⇒ 没有任何节点被判在链上」 |
| 4 | 无分支时退化呈现 | `branch-tree.test.ts` ›「只有一条根 run ⇒ 单节点、无分叉边、不提示『无分支可用』」「完全没有 run ⇒ 给可操作的说明，不画空图」 |
| 5 | 节点按封存运行的终止原因区分结局 | `branch-tree.test.ts` ›「五种 reason 分别给出正确文字与语义色（completed 不是『已完成』）」「底层 status 不变：五种 reason 的节点 status 都是 completed」「error 是红的、限制是琥珀的——同一屏里可区分」「也不得声称测试通过」；fixture `u1-fixtures``u1-ok/error-detail/…` + trace-sdk `infinite-loop` |
| 6 | 节点对中断和未知原因诚实降级 | `branch-tree.test.ts` ›「crashed ⇒ 『运行中断』+ 中性色，不伪造活跃执行」「crashed 且残留 reason 仍按中断」「已封存但 reason 未知 ⇒ 『结束原因未知』，原值可在 title 里查看」「completed 却完全没 reason ⇒ 同样归未知」「不为显示状态新增详情读取」；fixture `u1-crashed.jsonl` |
| 7 | 节点不把已恢复的工具错误当作终止失败 | `branch-tree.test.ts` ›「toolErrors>0 但 reason=completed ⇒ 仍显示『已结束』+ 正常色」；`compare-panel.test.ts` ›「工具错误不当作终止失败」；`span-tree-view.test.ts` ›「工具曾出错后正常结束仍判正常结束」；fixture `u1-ok`（工具曾出错后正常结束） |

---

## §布局证据（design D7 逐层记录）

> 下表每条同时给出**原生窗口边界（含单位）/ 应用 CSS 视口 / 工作区与详情实测宽 / Electron zoomFactor /
> devicePixelRatio / D2 断点映射**。数据源为 gitignored `.workbuddy/u1-7*/measurements.json`（真实 Electron CDP），
> 非原型。**CSS 视口用 `documentElement.clientWidth`，不用含边框的原生窗口宽度；640px 视口映射 <720px 档
> （single）；200% 缩放为独立用例，按缩放后实测视口判断点，不按原生标称尺寸推断。**

| 条目 | 原生窗口边界 | 应用 CSS 视口 | 工作区 / 详情实测宽 | zoomFactor | devicePixelRatio | D2 断点 |
| --- | --- | --- | --- | --- | --- | --- |
| u1-71（宽档·Emulation 偏差） | 真实 Electron 1360×860（含单位 px；`u1-71` 的 1440 Emulation 未生效，页面实测仍落在 1360 视口，`u1-71b` 补出真实 1440 档） | body clientW = **1360**，bodyScrollW 1360，无横向溢出（bodyOk=true，1360/1360） | 1440 档未单独测出（被 1360 覆盖）；1360 档：ASIDE 导航 264 / 步骤目录 SECTION 232 / 详情 SECTION 864；files: hasEntry=true, shows步骤目录=false | 100%（1.0） | 2.000000040304087 | ≥1280 → **wide**（导航+目录常驻；详情 864≥480） |
| u1-71b（宽档·补出真实 1440） | 1360×860 | body clientW = **1440**（1440 档）与 **1360**（1360 档），均无横向溢出（1440/1440、1360/1360） | 1440 档：导航 264 / 步骤目录 232 / 详情 **944**；1360 档：导航 264 / 步骤目录 232 / 详情 **864**；longtask title=1730 字符、emptytask 有回退灰字 | 100%（1.0） | 2.000000040304087 | ≥1280 → **wide** |
| u1-72（中窄档） | —— | body clientW = **1024**（×768）、**800**（×600）、**640**（×480），均无横向溢出 | 1024 档：导航 **264**（navPresent=true）、步骤目录折叠（stepDirPresent=false）、详情 **760**、breakpoint=medium；800 档：导航**自动折叠**（navPresent=false）、详情 800、breakpoint=narrow；640 档：导航折叠、详情 640、breakpoint=**single** | 100%（1.0） | 2.000000040304087 | 1024→**medium**（960–1279）、800→**narrow**（720–959）、640→**single**（<720） |
| u1-72 `autoCollapseRestore` | —— | wide 自定义 **344px** → narrow（800）自动折叠 → 回 wide | wide 恢复后 `aria-valuenow=344`（还原用户偏好，非默认 264） | 100%（1.0） | 2 | D2 `preservePrefs`：自动折叠不改写偏好 |
| u1-72 `zoom200` | —— | 200% 缩放后**实测有效视口 680×425**（`u1-72-zoom200.cjs` 稳定复现：跨档后等 1.2s 读 DOM，消中途半读） | **680 / 680 无横向溢出**、导航不挂载（single 单工作区）、详情全宽 680、breakpoint=**single**、正文可读 | **2.0（200%）** | **4.000000080608174** | 680 <720 → **single**（按缩放后实测视口判定） |
| u1-73（键盘/恢复/定位） | 1360×860 | 宽档 | 键盘 20 聚焦点、cross-run-restore 页签/选中恢复、error-location-priority、rapid-switch 无残留 | 100% | 2 | ≥1280 → wide（几何同 u1-71b） |
| u1-74（只读回归） | 1360×860 | 宽档 | 阅读 5 run + 隔离 v1/v2 文件世界：traces 58/blob 6 逐文件哈希零变化、文件数字节数不变、proxy 仍 stopped | 100% | 2 | ≥1280 → wide |

**系统 DPI / Emulation 边界（如实记录，未当产品门禁）**：
- `u1-71` 的 Emulation 覆盖（请求 1440×900）在真实 Electron 中未生效，页面停在 1360 视口——此差异由 `u1-71b` 补出**真实 1440 档**闭合，两档正文详情 944/864 均 ≥480（D2 二次约束），全部无横向溢出。
- 200% 缩放 `devicePixelRatio=4.00`（非 100% 档的 2.00），视口实测 680px 判为 single——已按"实际 CSS 视口"而非"原生标称 1360"判定断点。
- **未覆盖**：系统级原生 DPI（非 zoomFactor）未另设独立用例实测（`u1-72` 仅测应用内 200%）；原生目录/新建对话框的打开器差异未纳入外壳布局证据。这两条归 tasks 7.1/7.2 诚实边界，不在此放大为“桌面布局全尺寸已通过”。

---

## 由既有义务迁入的核对（desktop 主 spec 回归项）

以下为**已归档主 spec（A3 基线）**中既有契约在本次改动后的回归确认，非本 change 新增义务，均已链接到本索引对应场景：

| 主 spec 义务 | 回归证据（见上表） |
| --- | --- |
| 崩溃的 run 不再当"文件读取错误"（列表） | Req1-2（outcome/run-repository） |
| 徽标与过滤 / 老文件无来源（来源筛选） | Req2-1/2-2 |
| 三步运行 / 工具报错（span 树） | Req3-1/3-2 |
| 思维链 / 工具调用详情（详情面板） | Req4-1（⚠️ 契约级）/4-2 |
| 切到分支树 / 跨视图保持 / 切换不重载（视图切换） | Req5-1/5-2/5-3 |
| 缓存命中展示全场景（缓存可视化既有 8 场景） | Req6-1…6-9 |
| 文件只读/hash / 文件选择器轮号不沿链累加 / 二进制与不可用附件（A 段 WorkspaceFileView） | Req7-2/7-4（workspace-view/workspace-file-view/workspace-files）+ u1-74 哈希零变化 |
| 全额预算地图、超限终止、无预算老文件、编辑态懒加载（预算 capability） | Req4-4（budget-reachability）+ u1-71b CDP |
| 四条指标对照与本 run/沿链口径（compare-panel） | Req5-4（compare-panel）+ Req8-6（own-consumption） |
| 版本守卫先于 zod、v1 非法隔离字段、未来版本、单个文件读取失败不阻塞列表 | Req8-8 + 6.7（baddata-regression / run-repository / detail-version-guard） |

---

## 未交付执行能力（U1 边界核对）

以下为 **review.md 四节的过渡/边界（R1/U2、R2/U3、R3–R5/U4–U5、R8–R9/U7）中"仍由后续 change 承担、U1 不交付"**的清单；
本索引逐条核对：U1 **没有**在实现中把这些能力偷偷带上，也没有在验收时以旧图/旧行为冒充。凡未交付即如实列"未交付"。

### 未交付、仍由后续 change 承担

| 归属（拆分计划） | 未交付事项 | U1 现状（证据） |
| --- | --- | --- |
| **R1 → U2** `improve-workspace-file-reading` | 文件**内部**布局/diff/检查点/文件滚动、窄窗口文件正文宽度完善 | U1 只提升文件页承载到主工作区并卸下无关步骤目录；**文件内部目录/diff/自选检查点/滚动仍为既有实现**（`workspace-file-view` / `workspace-files` 为 A 段能力，未做 U2 改进）。§7-2 证明"文件页不再常驻步骤目录"，但**不**据此宣称 U2 的正文宽度验收通过（design D2/D7）。 |
| **R7 → U2** | 文件往返保检查点/环境 | 同 U2 项，未交付。 |
| **R2 → U3** `preserve-debugging-drafts` | 编辑草稿保留、离开/退出保护、修订号、elsewhere | U1 阅读位置**不**保存输入/草稿/授权（Req9-6，字段集固定）；`run-workspace` 仅迁阅读承载。U1 未新增草稿仓库或关闭确认（Non-goals：不实现草稿生命周期/离开保护）。 |
| **R3/R4/R5 → U4** `add-desktop-operation-tracking` | 操作登记/去重/执行槽/可信 ID/终止核对 | U1 仅保留既有受控提交（§7-3 三次真实提交）+ 预算/失败原样可达；**未**加 main 端执行登记/去重/执行槽（design D3/D4：不新增 main 执行保证，main 原有严格校验保留）。 |
| **R3/R4/R5/R10/R11 → U5** `unify-run-execution-workflow` | 创建工作区、跨页执行状态、失败草稿收尾、不抢焦点、统一执行结果收尾 | U1 的 `CreateRunDialog`/result/prompt/messages 编辑维持**既有**入口与门禁（§7-3），新选择在 U1 有概览可读，但**跨页执行状态/失败草稿收尾/不抢焦点由 U4/U5 完成**（过渡行为）。U1 不把既有执行行为算 U5 验收。 |
| **R8/R9 → U7** `improve-branch-comparison` | 树节点布局/聚焦、双运行输出比较、定位并打开分支 | U1 分支树仍为宽幅视图、保留四条指标对照（Req5-4/branch-tree）；**节点布局聚焦、尺寸、双运行输出比较归 U7，不显示未实现的对比按钮**（compare-panel 断言"没有未实现输出比较入口"即据此）。branch-tree delta 仅收窄节点状态文字枚举（review P1-a），构图/焦点/比较不改。 |
| **U6** `add-partial-run-reading` | 缺父链部分读取 | **缺父链详情仍显式报错误，不提供假降级**（Req8-8 + 6.7），U1 不交付部分读取。 |

### 用户可见行为删除（需知悉，已按证据决策）

- branch-tree 主 spec 的「状态与终止原因」原实现把两者挤于一格（`reasonLabel`）；本次拆成**状态列（结论）+ 终止原因列（记录原值）**，
  未知 reason 时结论说「结束原因未知」、原值原样可看。属用户可见的展示拆分，理由为四条证据（tasks 6.2）；非静默，已记录待主 agent 知悉——
  **若用户认为该改动需 spec 授权，应走 branch-tree spec 修订，而非在 U1 内静默保留实现与 spec 矛盾的旧布局。**

---

## 证据不足 / 需主 agent 复核的点（总结）

1. **Req4-1「推理模型的思维链」⚠️ 未勾完**：字段可达有契约级测试（`call-detail-view`），但"思维链以区别于正文的样式单独分区展示"的**真实渲染**未见 jsdom/CDP 事件级核验 —— 未冒充已通过。可选项：后续以真实带 `reasoning_content` 的 run 补一张步骤详情 CDP 截图即闭合。
2. **Req8-7「来源和隔离边界保持真实」**：已由主 agent 复核，证据改为真实文件 `overview-consumption-source.test.ts`（presentSource 分型整组 + SourceSectionView 静态组 + 接线契约 `onOpenParent→selectRun`），**直接断言**父 ID、返回父入口、independent 不冒充共享前缀与隔离边界措辞——此格证据充分，已闭合。
3. **系统原生 DPI（非 zoomFactor）未单独实测**、原生目录/新建对话框差异未纳入外壳布局证据（§布局证据末行）——已在 tasks 7.1/7.2 诚实边界标注，不放大为通过。
4. 其余全部 61 场景均有测试/静态断言/CDP 截图即可链接证据，无发现编造的行为；所有"未交付"项与 review.md/proposal 过渡行为逐条对上。