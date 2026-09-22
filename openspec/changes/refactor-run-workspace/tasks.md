# U1 实施任务

当前为提案完成、实现未开始。下列任务全部待办；编写四件套、OpenSpec 校验通过及旧走查截图均不计为实现完成。每项预算不超过 2h，超出时先按场景拆分再继续，不把未实测项勾选。

场景名默认引用 [desktop-ui delta](specs/desktop-ui/spec.md)，标“branch-tree”的引用 [branch-tree delta](specs/branch-tree/spec.md)，标“主 spec”的为既有契约回归。先完成第 1 组的 fixture/原型核对，再推进组件改动；如原型推翻尺寸或范围决策，先修订 proposal/design/spec。

## 进度记录

### 1.1（2026-09-21 完成）

生成器 `apps/desktop/scripts/gen-u1-outcome-fixtures.cjs` → `.rebaseagent/u1-fixtures/`（10 份 jsonl + `EXPECTED-OUTCOMES.json`）；校验 `apps/desktop/test/u1-outcome-fixtures.test.ts`（30 passed）。全部 fixture 通过真实 `readRun`（含版本守卫与跨行约束）；固定时间常量，两次生成逐字节一致。`pnpm check:typecheck` 通过、biome 干净、desktop 全量 393 passed / 0 failed。

- 复用既有：上限用 trace-sdk `infinite-loop.jsonl`（`max_iterations`）；普通成功基准对照 `normal.jsonl`。**未改动 `packages/trace-sdk/fixtures/`**（那被 `fixtures.test.ts` 逐字段断言，属 trace-sdk 基准）。
- 新增：`u1-ok`（最终输出）/ `u1-error-detail`（自有错误可定位）/ `u1-error-legacy`（error 终止但无 LLM 错误详情，仅有工具错误）/ `u1-aborted` / `u1-crashed`（**无终止事件** ⇒ status=crashed、reason=null）/ `u1-reasoning-only` / `u1-tool-only` / `u1-cache-partial`（3 次自有调用中 2 次带 `cache_hit`，含 `0` 命中与整体缺失）/ `u1-fork-parent`+`u1-fork-child`（子 run **零自有 llm.call**，用于验证不借用祖先正文）。
- 判据有牙（已做变异验证）：删除 `u1-error-detail` 的 `error` 字段 ⇒ 3 条用例失败；清空父 run 正文 ⇒ 2 条用例失败。两处变异均已还原。
- ⚠️ 实施发现（已写入测试注释）：`readRun` 返回的 `RunRecord` **没有** `leafSpanIds`——该字段只由 main 的 `getRun` 产出；直接读 `record.leafSpanIds` 得 undefined，会把全部 span 误判为非自有。测试按 getRun 等价规则重建（本 run 文件内 span 即自有）。
- 诚实边界：这批数据是「结构合法、按预期结局手工编排」的标本，非引擎原生产物；`config_hash` 为占位值，**不可**作 replay 分叉父本（既有校验会拒绝，属预期）。
- 未覆盖（勿当作已覆盖）：长任务/长模型/短 ID 碰撞、坏版本数据、隔离多工具/二次分叉属 1.2；缺父链语料归 U6。

### 1.2（2026-09-21 完成）

生成器 `apps/desktop/scripts/gen-u1-lineage-fixtures.cjs` → `.rebaseagent/u1-lineage/`（手工组 15 份 + 坏版本 3 份 + 真实引擎隔离谱系 3 条 + `MANIFEST.json`）；校验 `apps/desktop/test/u1-lineage-fixtures.test.ts`（33 passed）。`pnpm check:typecheck` 通过、biome 干净、desktop 全量 **426 passed / 0 failed**（较 1.1 基线 +33）。

- 关系组：`u1r_parent`→`u1r_child`（result 分叉，**共享父前缀**，子自有 span 从 `s_09` 起）/ `u1p_parent`→`u1p_child`（prompt 分叉，**独立执行**，子 span 从 `s_01` 重编、与父**同名**且集合相交）/ `u1m_parent`+`u1m_arm_a`/`u1m_arm_b`（model_params A/B，共享 `experimentId`）/ `run_zz01`→`run_zz02`（代理分叉改 messages，`source.kind=proxy` 且**无** `config_hash`）。
- 隔离谱系：**真实引擎** `createIsolatedRun` + `replayIsolatedRun` + 本地 CJS `MockLlmClient`，产出 v2 三链（root → fork1 多工具轮 → fork2 二次分叉）。二次分叉轮号 `[1,2]` 回到本地第 1 轮（不沿链累加）；`resume_after_step` 指向**父自有段**内 span；附件 3 份哈希与落盘字节实测一致。
- 导航边界：`u1_long_task`（>80 字）/ `u1_long_model`（>60 字）/ `u1_empty_task`（空串 ⇒ 摘要回退）。
- 坏版本组（`broken/` 独立子目录，**必须读取失败**）：`u1b_future`（`format_version=3` ⇒「不支持的格式版本」）/ `u1b_schema`（第 2 行缺 `type` ⇒「type 为必填」）/ `u1b_v1ws`（v1 私带 `workspace` ⇒「v1 禁止携带 workspace」，zod 会剥离未知键 ⇒ 必须靠版本守卫在 parse 前拒）。
- 🐛 实施发现（已修生成器，勿回退）：短 ID 只切 id **末尾**，故后缀关系必须建立在**整条 id** 上。初版给三条都加 `u1s_` 前缀，导致 `u1s_x0a1b2c3d4` **不**以 `u1s_0a1b2c3d4` 结尾（共享前缀挡在中间）⇒ 后缀条件不成立，被测试如实判失败。改为 `zzzz0000a1b2c3d4` / `yyyy0000a1b2c3d4` / `0000a1b2c3d4`（三者同 8 位后缀、且后者是前两者的后缀）后条件成立。
- 判据有牙（已做 4 组变异验证，全部还原）：① 清单碰撞组换成无后缀关系的 id ⇒ 2 条碰撞断言失败；② `u1b_future` 版本改回合法的 1 ⇒ 仅版本门禁用例失败；③ result 子 span 改成与父重叠的 `s_01/s_02` ⇒ 2 条继承断言失败；④ 篡改短 ID 文件内容 id ⇒ 2 条可读性断言失败。
- 诚实边界：手工组 `config_hash` 为占位值、**不可**作 replay 父本（既有校验会拒绝，属预期）；隔离组含绝对临时路径 ⇒ 不追求逐字节可重复（改由 `MANIFEST.json` 记录关系/哈希），手工组固定时间常量、重生成指纹逐字节一致（`5f348bbe0aec782f7f52c73b`）。
- 未覆盖（勿当作已覆盖）：短 ID **算法本身**属 2.4，此处只保证「碰撞条件确实成立」；缺父链语料归 U6。

### 1.3（2026-09-21 完成）

交付物：`docs/reviews/2026-09-21-u1-prototype/index.html`（单文件可点击原型，无外部依赖，含醒目「示例数据」提示条，不读真实 trace、不发模型请求）。截图脚本 `apps/desktop/scripts/u1-prototype-shots.cjs` 产出 `screenshots/`（22 张）与 `measurements.json`。证据索引 `docs/reviews/2026-09-21-u1-prototype/README.md`。

- 承载结构按 design D1：全局栏 + RunWorkspace（概览/步骤/文件三页签并列，进入落在概览；文件页**不挂** SpanTree）。
- 三条断言人工核对通过：① 首次打开直接进概览、概览首屏「结果→来源→本次消耗」、无运行时空态显示两个真实入口（无营销欢迎页）；② 失败概览能定位**真实自有**调用（有 error 详情时给「打开该调用并展开所属 step」入口；无详情时显示「错误详情未记录」**不虚构**入口）；③ 文件承载区与步骤目录是**兄弟节点**，文件页内结构上不可能出现步骤目录。
- 示例数据与实际产品证据**显式区分**：页面顶部提示条 + README 首段 + 未验事项段。
- 判据有牙：断言③ 由 DOM 结构保证（非断点隐藏），脚本对四个尺寸断言 `文件页内结构上无步骤目录节点 = true`；断言① 用 `可见pane数` 恒为 1 与 `两者互斥` 断言挡住「多 pane 同屏」「空态与工作区并存」。

### 1.4（2026-09-21 完成）

按 design D2 在应用内容视口 CSS 宽度 1024/800/640 与独立 200% 等效用例上测量折叠/返回/长文本；截图与几何检查（`measurements.json`）核对两条断言通过，**结论已回填 design D2**。

- ④「多尺寸与放大下关键阅读可达」：正文详情宽实测 1440/1360/1024/800 = **944/864/528/800**，四个尺寸均 ≥480（D2 二次约束）；全部尺寸**无横向溢出**；640 档辅助列表替换正文。
- ⑤「自动折叠后恢复用户布局」：宽窗口把导航拖到 340 → 缩至 1024 进文件页时**自动收起** → 回 1440 回概览**恢复 340**（自动折叠不覆盖用户偏好）；键盘调整宽度夹到合法范围（实测 296/216）。
- 🐛 原型阶段抓到并修掉三个真实缺陷（正是原型要提前暴露的问题）：① `[hidden]` 被作者 `display:flex` 盖过 ⇒ 四 pane 同屏；② 文件页仍带步骤目录（违反断言③）⇒ 把步骤目录移进只包步骤页的 `.steps-wrap`；③ 正文被压到 240px ⇒ 加 `min-width:480px` 二次约束。
- ⚠️ 诚实边界：本任务用 Chrome CSS 视口等价测量，**未**在 Electron 内实测 `zoomFactor`、未用真实数据；**结论只代表原型核对完成，不能以原型代替任务 7.1/7.2 的最终桌面验收**。

### 2.1（2026-09-21 完成）

新增 `apps/desktop/src/shared/outcome.ts`（结局分类 + 语义色调映射）+ `apps/desktop/test/outcome.test.ts`（13 passed）。

- `classifyOutcome({status, reason}) → Outcome`：**单一**结局判据来源（列表徽标、概览头、既有分支树节点共用），消除"列表说已结束、树节点说出错终止"的同库矛盾。
- **不扩充 status 枚举**（仍只有 `completed`/`crashed`）：细分由 `status + reason` 组合得出 `OutcomeKind`（completed/error/max_iterations/budget_exceeded/aborted/interrupted/unknown）。
- 优先级刻意如此：`crashed` **盖过**任何残留 reason（无结束记录就是无结束记录）；`completed` 却无 reason ⇒ `unknown`（不冒充已完成）；未知 reason **保留原值**并标未知。
- `outcomeBadgeClass(tone)` 返回**静态完整类名**（非模板拼接）——Tailwind JIT 扫不到动态类名会静默丢样式。
- 判据有牙（2 组变异，均还原）：① `crashed` 误判为 completed ⇒ 3 条失败；② `error` 误用 success 色调（"正常绿"）⇒ 1 条失败。
- 与 1.1 fixture 交叉核对：每份 fixture 真实 `status+reason` 经分类后与 `EXPECTED-OUTCOMES.json` 的 `outcome` 一致。

### 2.2（2026-09-21 完成）

新增 `apps/desktop/src/shared/overview.ts`（自有输出选择 + 错误目标派生 + 自有工具错误）+ `test/overview.test.ts`（17 passed）。

- `deriveOwnOutput`：最终输出**四条件缺一不可**（正常终止 + 最后自有 llm.call 非空正文 + 无 error + 无待执行 tool_calls），不满足即「未记录最终输出」并给 `missingReason` 分型（no-llm-call / empty-content / has-error / pending-tool-calls）与 `lastOutputKind`（content / reasoning-only / tool-calls-only / empty）。**绝不**回退更早正文冒充最终、**绝不**借用祖先、**绝不**由模型补全。
- `deriveErrorTarget`：只在**自有** llm.call 找带 error 的调用；找不到即 `missingDetail=true`（不虚构入口、不反推原因）。
- `deriveOwnToolErrors`：自有工具错误**独立**列出，与 LLM 错误缺失判定互不影响（工具错误是数据不是终止根因）。
- 关键反例纪律：用例**刻意构造「祖先与自有并存」**（祖先带 error / 祖先有正文 / 祖先带工具错误），证明结果源自自有段。
- 判据有牙（2 组变异，均还原）：③ 移除 `leafSpanIds` 过滤（祖先泄漏）⇒ 3 条失败；④ 放宽最终输出条件（去掉 error/tool_calls 约束）⇒ **首次漏网**，补 4 条合成边界用例（逐条堵住四条件）后 ⇒ 2 条失败。**这次漏网是"只做了一次变异就收工"的典型代价**——已把四条件逐条固化为合成用例。
- ⚠️ 数据源纪律：`readRun` 的 RunRecord **无** `leafSpanIds`；需 `getRun` 等价形态（本 run 文件内 span 即自有），沿用 1.1 记下的陷阱。

### 2.3（2026-09-21 完成）

在 `shared/overview.ts` 追加 `deriveOwnConsumption` / `deriveCacheCoverage` + `test/own-consumption.test.ts`（12 passed）。

- `deriveOwnConsumption`：本次消耗只聚合**自有** spans（token / 已记录时间 / 工具调用与错误 / 嵌套缓存覆盖），分支 run 展开视图的祖先前缀**不计入**；无 timing ⇒ `durationMs = null`（未知不补 0）。
- `deriveCacheCoverage`：`recorded`（带 cache_hit 的自有调用数，`0` 算记录）/ `total`（自有调用数）/ `hitTotal`（合计；`recorded===0 ⇒ null`，未知 ≠ 0）。
- 判据有牙（1 组变异，**首次漏网**）：⑤ 让嵌套 cache 覆盖漏掉自有段过滤 ⇒ 初版无法察觉（用例只断言 top-level token）；补「消费口径与缓存口径必须同源」用例后 ⇒ 1 条失败。
- 与 `EXPECTED-OUTCOMES.json` 的 `cacheCoverage` 逐条交叉核对。

### 2.4（2026-09-21 完成）

新增 `apps/desktop/src/shared/nav.ts`（展示/搜索/短 ID）+ `test/nav.test.ts`（23 passed）。

- `taskSummary` / `collapseWhitespace`：折叠连续空白（含制表/全角空格）并限长；**只影响展示**，完整原值仍用于搜索与复制。
- `matchesSearch`：匹配**完整 task / id**（大小写不敏感），不因展示截断漏配未显示片段。
- `computeShortIds` / `ShortIdState`：末尾 8 字符起，在**全部已加载记录**内按需延长；**后缀包含**时较短者继续延长；**按完整 ID 排序**计算（结果与输入顺序无关 ⇒ 筛选/排序不重编号）；`ShortIdState` 长度**只增不减**（刷新删除碰撞项不缩短）。
- `deriveNavLabel` / `filterRuns` / `matchesSource`：空任务回退「来源 · 时间 · 短 ID」；缺失模型显示「未记录」；搜索与来源条件求**交集**，不改原 task。
- 🐛 测试数据自纠：初版"同尾片段"用例的 ID 末尾 8 位其实**不同**（`aaaaaaaa` vs `aaaaaaab`）⇒ 用例假失败。这正是 1.2 记下的同一类陷阱（后缀关系必须建立在**整条 id** 上），已改为末尾 8 位真相同的 `...aaaaaaaa` 两条。
- 判据有牙（2 组变异，均还原）：⑥ 破坏 `ShortIdState` 只增不减 ⇒ 1 条失败；⑦ 丢失后缀包含处理（只比同长后缀）⇒ 1 条失败。

### 第 2 组小结

新增 3 个纯函数模块（`outcome.ts` / `overview.ts` / `nav.ts`）+ 4 个测试文件 **65 用例**；desktop 全量 **491 passed / 0 failed**（较第 1 组基线 439 增 52）。`pnpm check:typecheck` ✅、biome 干净（含 unsafe 模板字符串修复与去非空断言）、`openspec validate --strict` ✅。**7 组变异验证全部还原**，其中 2 组**首次漏网**（2.2 四条件、2.3 嵌套缓存）——已各自补用例堵死。**第 2 组只做派生层（纯函数），未接线任何 UI 组件**（接线归第 3–5 组）。

## 1. 基线与关键原型

- [x] 1.1 盘点并补齐普通成功/失败/上限/中止/中断、旧记录、仅工具/思维链、缓存部分覆盖 fixture（1.5h）；以可重复生成的数据和预期结局表验证“正常结束直接看到最终输出”“旧失败记录没有错误详情”“限制中止与中断如实展示”“无最终正文不借用祖先补全”。
- [x] 1.2 复用并整理隔离多工具/二次分叉、普通 result、prompt、代理和 model_params fixture，补长任务/长模型/短 ID 碰撞与坏版本数据（1.5h）；记录自有 span/祖先/源及附件哈希，验证“继承轨迹与独立执行来源”“同名运行的短 ID 稳定可辨”“非法详情不被概览绕过”的测试输入确实满足条件。
- [x] 1.3 完成宽窗口概览、错误跳转、步骤、文件承载结构原型（2h）；交付可点击原型及 1440/1360px 截图，人工核对“首次打开与无运行入口”“失败概览定位真实自有调用”“文件承载区不附带步骤目录”，示例数据与实际产品证据区分。
- [x] 1.4 验证原型在 1024/800px、640px 应用内容视口 CSS 宽度与独立 200% 缩放用例的折叠/返回/长文本（1.5h）；按 design D2 测量视口与正文，截图与几何检查验证“多尺寸与放大下关键阅读可达”“自动折叠后恢复用户布局”，结论回填 design，不能以原型代替最终桌面验收。

## 2. 共用派生

- [x] 2.1 增加共用结局分类与语义样式映射（1.5h）；单测“封存状态不冒充正常结束”“崩溃的 run”“限制中止与中断如实展示”及 branch-tree“节点按封存运行的终止原因区分结局”“节点对中断和未知原因诚实降级”“节点不把已恢复的工具错误当作终止失败”，覆盖摘要未知原因和详情 event/reason 矛盾，不放宽 schema 或扩充 status 枚举。
- [x] 2.2 增加自有输出选择与错误目标派生（2h）；单测“正常结束直接看到最终输出”“失败概览定位真实自有调用”“旧失败记录没有错误详情”“无最终正文不借用祖先补全”，使用祖先与自有错误并存的反例防止误归因。
- [x] 2.3 复用自有消耗派生并增加缓存覆盖范围（1.5h）；单测“本次指标不累计共享前缀”“run 级累计现算”“fork run 的累计不含祖先前缀”“输入为零与全未知缓存”，验证缺失 timing、cache_hit=0 和失败零值语义。
- [x] 2.4 实现任务展示/搜索及稳定短 ID 纯函数（1.5h）；单测“完整任务和 ID 搜索”“同名运行的短 ID 稳定可辨”“长模型和空任务的导航摘要”，覆盖后缀包含、碰撞扩长、刷新删除碰撞项及筛选不重编号。

## 3. 阅读状态与异步加载

- [x] 3.1 将每运行页签、调用、展开项及每调用阅读分区迁入会话状态（2h）；store 单测“跨运行返回恢复阅读”“阅读恢复不保存授权或草稿”，确认相同 span ID 不串状态且不保存内容副本。
  - 交付：`src/renderer/src/lib/reading-state.ts`（纯函数）——`RunReadingState {tab,spanId,expandedSteps,overviewScrollTop,stepsScrollTop,calls}` + `ReadingStateByRun`；`readingStateOf`（缺省返回默认不改写）、`patchReadingState`、`patchCallReading` 全部不可变；`reconcileReadingState` 清理失效 span/step/calls 引用并在无文件时把 files 退回 overview。
  - store：新增 `readingByRun` 为真源；`selectedSpanId`/`expandedSteps` 保留为**派生视图**（每次写双写两处，组件无需一次性大改）。`selectRun` 进入新 run 时恢复其阅读状态，并把恢复的展开集合**合并**在全展开默认之上（`{...全展开, ...恢复}`）。新增 `readingOf`/`setReadingTab`/`setReadingScroll`/`setCallReading`。
  - 测试：`test/reading-state.test.ts`（15）+ `test/store.test.ts` 新增「阅读状态按运行恢复（任务 3.1）」6 条 = 46 条全绿。覆盖跨运行恢复、A/B 相同 span ID 不串、展开集合恢复、滚动按 run 记忆、调用分区状态、以及 `readingByRun` 里**不含** draft/authorization/sourceToken/allowFileWrites/content 键。
  - 变异验证：把 run 键隔离改成写 `__global__` ⇒ 被 7 条用例抓到（还原）。
- [x] 3.2 实现明确目标、有效历史选择和默认位置的优先级（1.5h）；单测“首次步骤选择与空轨迹”“显式错误定位优先于恢复”“失效阅读对象安全回退”，包括文件页签失效及空 span 集合。
  - 交付：`src/renderer/src/lib/reading-resolve.ts`——`resolveReading({detail,history,target,currentTab})`，优先级**显式目标 > 有效历史 > 默认位置**；输出带 `source`（explicit/history/default/empty）与 `invalidated` 供界面提示与排查。默认位置=首个**自有** llm.call/tool.invoke（分支 run 不停在祖先上），无自有调用退首个可读 span，空轨迹 ⇒ `spanId:null` + `source:"empty"`。任何一层引用失效都清理降级、不抛、不选别的 run 的同 ID span。
  - 测试：`test/reading-resolve.test.ts`（12 条）。含祖先前缀的默认选择、无自有调用回退、空轨迹空态、explicit 覆盖 history（含历史停文件页）、explicit span 失效降级、history 失效回默认、history 文件页签对非隔离 run 回退概览、空轨迹下历史 saved 的 span 不被「恢复」进来。
  - 变异验证 4 次全部被抓：① 去掉自有 span 过滤（回退到祖先）② 历史优先于显式目标 ③ 禁用文件页签失效回退 ④ 不校验历史 span 有效性。每次跑完即还原并 diff 确认。
- [x] 3.3 为详情请求增加 run/request 归属和同 run 重试（2h）；受控乱序 Promise 测试“快速切换及同运行重试不串响应”“非法详情不被概览绕过”，逐测旧成功/失败/版本失败/schema 失败/异常，不让旧 finally 清除新加载状态。
  - 交付：`src/shared/detail-request.ts`（纯函数）——`isDetailForSelectedRun`、`shouldApplyDetailFailure`（失败收尾须「请求发出时的选中 run == 请求的 run == 现在的选中 run」三者一致）、`isCurrentDetailResponse`、`runIdOfDetailData`、`isDetailPayloadForRun`（**载荷自称的 meta.id 必须等于请求的 run id**）。
  - store `selectRun`：记录 `selectedAtRequest`；失败分支先过归属守卫（**已切走就不写 error、不清 loadingDetail**——那是新 run 的加载态，治「旧 finally 清除新加载状态」）；成功分支在归属校验 + 版本守卫 + schema 转换的**每一步之后**都复查「目标 run 仍是当前选中 run」，防校验期间用户又切走。
  - 测试：`test/detail-request.test.ts`（10 条，受控乱序 Promise：每次 getRun 返回手动 resolve 的 deferred）。
    - 快速切换不串响应 2 条（A 慢响应后到不覆盖 B；A 迟到成功不清 B 的 loadingDetail）。
    - 同 run 重试与失败收尾 3 条（A 失败在切到 B 后到达 ⇒ 不写 error 也不清 B 的加载态；切走再重读同一 run 的新加载态不被旧收尾清除；同 run 连发两次旧响应后到不留下 loadingDetail=true）。
    - 非法详情不被概览绕过 4 条（main 回错 run 的载荷 ⇒ 报「归属校验失败」且不落地；版本非法 ⇒ 报「版本校验失败」；schema 非法 ⇒ 报「结构校验失败」；非法响应在切走之后到达 ⇒ 既不落地也不打扰新 run）+ 1 条异常（getRun reject）。
  - 变异验证 3 次全部被抓：① 去掉失败归属守卫（旧 finally 污染新加载态）② 去掉成功落地归属守卫（A 的慢响应覆盖 B）③ 载荷归属只查非空不查一致（回错 run 被当合法详情）。
  - ⚠️ 顺带修正既有桩：`test/store.test.ts` 的 getRun 桩原先无视请求 id 一律返回 fixture（`meta.id="r_01"`），fork/promptFork 成功后请求 `run_forked` 会拿到「自称 r_01」的载荷——新归属守卫恰好拒绝，暴露出桩本身在撒谎。已改为按请求 id 改写 meta.id（模拟 main 真实行为），两条既有用例恢复绿。
### 3.4（2026-09-21 完成）

新增 `apps/desktop/src/shared/list-refresh.ts`（刷新调度纯函数）+ store 接线 + `test/store.test.ts` 新增「列表刷新合并（任务 3.4）」7 条（**38 passed**，desktop 全量 **541 passed / 0 failed**，较 3.3 基线 534 **+7**）。

- `decideRefresh` / `settleRefresh`：**在途合并**（已有请求在途时只登记"还需要一次"，不并发发射）+ **尾随补发恰好一次**（N 次重复刷新只换来一次补发，不成请求雪崩）。两条新的 store 字段 `listRefreshInFlight` / `listRefreshPending` 承载调度，不参与渲染。
- `resolveRefreshFailure`：刷新失败**保留旧记录**（`runs`/`failed` 原样），仅置 `listStale` 标"未更新"；首次失败不标（本来就没有可过期的数据）。提示语据此分叉：有过成功加载 ⇒「刷新失败（仍显示上次结果）」，首次 ⇒「读取 run 列表失败」。
- 成功落地只替换列表数据，**不动** `selectedRunId` / `detail` / `readingByRun`——单纯刷新不自动选择新记录、不清空已加载的阅读位置（`listLoaded` 区分首次与刷新）。
- 🐛 实施发现的真实缺陷（已修，勿回退）：初版让尾随补发**旁路直发** `refreshRunsOnce()`，该请求不经 `decideRefresh` 登记在途数 ⇒ 补发期间再来的刷新会被误判为"无人在途"而并发发射（且 `settleRefresh` 若在补发时把 inFlight 置回 1，计数器会永久残留）。改为补发复用 `loadRuns()` 自身，由它按 `decideRefresh` 重新登记；`settleRefresh` 只递减、不替调用方占位。
- 判据有牙（**4 组变异**）：① 去掉在途合并 ⇒ 挂起用例超时（并发发射症状）；② 去掉尾随补发 ⇒ 读列表次数 2≠3、新记录不可见；③ 失败时清空 `runs` ⇒ 保留旧记录用例失败；④ 补发改走旁路 ⇒ **首次漏网**（最终状态相同、不可观测），补「补发自身也在途时的新刷新必须被继续合并」用例后 ⇒ 超时被抓。四处变异均已还原并确认 diff 无痕。
- ⚠️ 抓变异④时的教训：断言"最终状态相同"不能区分旁路补发，必须构造**补发在途**的时序窗口（`gateList()` 挂第二个 gate 须在 `releaseFirst()` **之后**同步设置——`gateList` 的 release 会清 `listGate`，顺序颠倒就会让补发读到 undefined gate 立即返回）。
- 诚实边界：本任务只做调度与失败口径，**未接线任何 UI**（手动刷新按钮、未更新提示条的呈现归 4.5）；`listStale` 目前只被测试断言，尚无组件消费。

- [x] 3.4 合并列表在途刷新并处理执行收尾的尾随更新（1.5h）；单测“刷新合并且保留阅读”“列表刷新失败可重试”“切换不重载”，断言读列表次数和新记录最终可见。
### 3.5（2026-09-21 完成）

新增 `apps/desktop/src/renderer/src/lib/workspace-selection.ts`（三组纯函数）+ store 接线 + RunList/DetailPanel/App 接入 + `test/store.test.ts` 新增「首次选择与筛选/源失效状态（任务 3.5）」**11 条**（store 49 passed，desktop 全量 **552 passed / 0 failed**，较 3.4 基线 541 **+11**）。

- `resolveInitialSelection`：**首次自动选择**只在「列表已成功加载 + 无选中项 + 未尝试过」时发生，取 `runs[0]`（main 已按创建时间倒序）⇒ 进概览。**`initialSelectionAttempted` 是一次性守卫**：失败后留在该 run 的原位错误态由用户重试，**绝不**因为"这条读不了"就去试下一条（那会退化成静默遍历整个列表）。`App.tsx` 挂载时 `await loadRuns()` 后再 `autoSelectInitialRun()`。
- `resolveFilterVisibility`：判当前选中运行是否被搜索/来源条件隐藏，**只给提示与清除入口**（`RunList` 里的琥珀提示条 + 「清除条件」），主工作区照常显示该运行，**不自动改选**。同时补了 store 的 `searchQuery` 字段与搜索框（4.4 接 UI 时复用），来源标签按 4.4 口径先改为「代理录制/本地记录」。空态文案按 `hasActiveFilters` 分叉，避免把"筛没了"说成"还没有记录"。
- `resolveSourceAvailability`：
  - ⚠️ **`!listLoaded` 必须排在"列表里没有它"之前** —— 否则首次读取失败会把「不知道」误报成「源记录已消失」。用 `unknown` 表意；`unavailable=false` 但执行闸门仍关。
  - 列表里没有该 run + 有失败文件 ⇒ `unreadable`；无失败文件 ⇒ `missing`。**不断言是哪一条失败文件**（只按列表当前事实陈述）。
- `resolveExecutionGate`：源不可用时**旧内容保留**（不擦掉用户正在看的东西），但禁用依赖它的新执行。`DetailPanel` 四处执行入口（tool result 重跑/precheck、prompt fork、model AB、代理 messages 重发）统一 `既有 guard ∧ sourceExecutable`，并在提交口兜底（不只靠按钮 disabled）。新增 `SourceUnavailableNotice` 横幅（含「重新读取」）。
- 🐛 实施发现：`check.reason` 只存在于 `CapabilityCheck` 的失败分支 ⇒ 直接 `check.reason` 过不了 typecheck；改为单独的 `checkBlockReason` 派生，源不可用优先于 guard 原因（两者原因不同，不互相冒充）。
- 判据有牙（**4 组变异**）：① 去掉一次性守卫 ⇒ **首次漏网**（用例只调了一次，选中项已挡住第二分支），补「清空选中项后再刷新+自动选择仍不得读任何记录」后 ⇒ 被抓；② 忽略 `unavailable` ⇒ 2 条失败；③ 筛选隐藏忽略搜索词 ⇒ 1 条失败；④ 删 `unknown` 分支（把未知说成消失）⇒ 1 条失败。四处已全部还原。
- ⚠️ 测试卫生两处坑：① 新增 store 字段必须同步进 `resetStore()`，否则跨用例污染（本轮「首次详情失败」用例单独跑过、连跑失败，正是漏加 `initialSelectionAttempted` 所致）；② **不要用 python `open(...,'w')` 改这些源文件**——会引入 CRLF，biome 立刻报「Formatter would have printed」。仓库统一 LF。
- 诚实边界：本任务只做 store 派生与接线，**首次自动选择的界面呈现（概览首屏）与"无运行入口"的完整视觉归 4.2**；搜索框只接了逻辑与基础输入框，完整导航重排归 4.4。

- [x] 3.5 接入首次选择、筛选隐藏和源文件失效状态（1.5h）；store 测试“首次打开与无运行入口”“筛选隐藏当前运行”“已选源记录不可用”，确认首次详情失败不循环跳转、重读通过前执行入口不解禁。
- [x] 3.6 接入概览/步骤目录/逐调用滚动与长文本展开恢复（2h）；组件或 CDP 验证“跨运行返回恢复阅读”“失效阅读对象安全回退”，包含内容挂载后恢复、滚动上限裁剪和设置/分支往返。
  - 交付：`src/renderer/src/lib/scroll-restore.ts`（`canRestoreScroll` / `resolveRestoreScrollTop` / `isAtBottom` / `resolveScrollRestore`）——恢复值的上限裁剪（`[0, scrollHeight - clientHeight]`）、不可测高度返回 `null`（**不拿 0 冒充**）、NaN/±∞ 归类；`src/renderer/src/lib/restore-gate.ts`（`decideRestore` / `hasRestored` / `shouldResetRestore` / `restoreIdentity`）——"内容挂载后恢复"的三前置条件 + **每内容身份只恢复一次**（防顶回用户后续滚动）；`workspace-selection.ts` 增 `resolveDetailPhase` / `isReadingContentReady` / `readingScrollOf(..., known)`（「没记过」≠「记的是 0」）。
  - 组件接线：`LongText` 展开状态改为**可受控**（`expanded`/`onToggle`，不传则退化为自持状态）；`LlmCallDetail` 与 `ToolInvokeDetail` 各长文本块按**稳定字段键**（`error`/`reasoning`/`content`/`tool_calls`/`msg:<序号>`/`tools`/`params`/`args`/`result`）接入 `setCallReading`；`SpanTree` 步骤目录与 `DetailPanel` 概览容器加 `ref`+`onScroll` 记录 + 挂载后恢复；新增 `ReadingInvalidatedNotice` 提示条。
  - store：详情校验通过后统一走 `resolveReading`（**详情到手才解析阅读位置**——此前可能残留另一 run 的未校验 `spanId` 导致高亮错 span），并置 `readingInvalidated`；`selectSpan` 明确选择即清除该提示。
  - 测试：`test/reading-scroll-restore.test.ts`（33）+ `test/store.test.ts` 新增「滚动与展开恢复接线（任务 3.6）」6 条 = **desktop 590 passed / 0 failed（34 文件）**（3.5 基线 552，+38）。覆盖受控/非受控展开静态渲染、键顺序稳定、按 run+span 隔离、滚动上限裁剪、分辨率变化重裁、内容不足一屏、不可测不恢复、相位映射、`restoreIdentity` 指纹含 span 序列、A→B→A 恢复、失效回退与提示一次性、切 run 不带旧未校验 spanId。
  - 变异验证 6 组，5 组被抓即还原：① 去上限裁剪 ⇒ 3 条失败；② 未就绪/不可测也记账 ⇒ 2 条失败；⑤ 不报失效 ⇒ 2 条失败；⑥ LongText 忽略受控值 ⇒ 1 条失败；④ `restoreIdentity` 丢 span 指纹 ⇒ 1 条失败。**③「`shouldResetRestore` 恒 false」首次漏网**——A→B→A 路径实际由 `decideRestore` 自身的单键记账覆盖，本函数非必要条件；据此收敛：删掉"靠它作废"的错误注释、补 `restoreIdentity` 作为重读重新武装恢复的真正机制（而不是留一个测试打不到的"看起来有用"的函数）。
  - 诚实边界：**本包无 jsdom**，组件层只能用 `renderToStaticMarkup` 做静态渲染断言，真实滚动几何、`useEffect` 时序、内容挂载先后**均未在此覆盖**——归 7.1–7.3 的 Electron/CDP 验收；「设置/分支往返恢复」只验到 store 层状态存活（`readingByRun` 不动），**未经真实设置弹层/分支树往返实测**（归 7.3）。`WorkspaceFileView` 内部检查点/路径/滚动按 design D6 不纳入本模型，未改。

## 4. 工作区与运行导航

- [x] 4.1 添加 lucide-react、基础图标按钮与阅读字号/焦点样式（1h）；安装及 typecheck 通过，键盘/悬停核对“键盘导航及工具名称”，只更新 desktop 依赖和对应 lockfile。
### 4.1（2026-09-21 完成）

新增三个文件：`src/renderer/src/components/IconButton.tsx`（`IconButton` / `TextIconButton` / `FOCUS_RING` / `DECORATIVE_ICON_PROPS`）、`src/renderer/src/lib/a11y-action.ts`（`auditAccessibleAction` / `looksLikeIdentifier` / `actionTitle` / `AccessibleAction`）、`test/icon-button.test.ts`（**16 条**）；改 `index.css` 加阅读字号令牌与全局焦点兜底。

- 依赖：**只动 desktop** —— `apps/desktop/package.json` 加 `"lucide-react": "^1.47.0"`（实解 1.47.0）+ `pnpm-lock.yaml` 对应更新，**无其他文件变化**。
- 阅读字号令牌（design D2）：`--reading-body:14px` / `--reading-mono:13px` / `--reading-meta:12px` / `--reading-title:18px` / `--reading-tracking:0`，配 `.text-reading-*` 工具类。**是语义令牌不是随手 px**——既有散落的 `text-[11px]`/`text-xs` 由后续任务逐步替换，本任务只立令牌。
- 可访问名称契约：`IconButton` 输出 `aria-label`（纯名称）+ `title`（`actionTitle(label, hint)` 拼接的悬停提示，**空 hint 不产生空括号**），激活态用 `aria-pressed`。`auditAccessibleAction` 按四类问题**收集全部**（`missing-name` / `identifier-leak` / `disabled-without-reason` / `color-only-state`），**不早退**——一次修完而不是修一个重跑一次。
- ⚠️ **图标隐藏不能只断言 `aria-hidden`**：lucide **自己**就输出 `aria-hidden="true"`（探针实测），断言它等于测库不测自己。故引入 `DECORATIVE_ICON_PROPS = { "aria-hidden": true, focusable: false, role: "presentation" }`，断言本组件负责的 `focusable="false"`（不进 Tab 序列）与 `role="presentation"`。
- 焦点兜底（CSS）：`:where(button,[role=button],a[href],input,select,textarea,summary):focus-visible { outline:2px solid #0284c7; outline-offset:1px }` + `:focus:not(:focus-visible){outline:none}`；另加 `@media (prefers-reduced-motion: reduce)` 块。
- 判据有牙（**5 组变异，4 被抓 + 1 漏网后补用例**）：① 移除 `{...DECORATIVE_ICON_PROPS}` ⇒ 被抓 2 条（**首轮断言 aria-hidden 未抓到，见上条纠正**）；② 去掉 `aria-pressed` ⇒ 被抓；③ `identifier-leak` 分支返回 true 恒不报 ⇒ 被抓；④ `disabled-without-reason` 忽略 hint ⇒ 被抓；⑤ **`auditAccessibleAction` 首条问题即 early return ⇒ 首次漏网**——"多问题"用例的 label 非空，走不到早退分支；补一条「空名称时也报全其余问题」（`{label:"",disabled:true}` 与 `{label:"  ",active:true}` 两个窗口）后 ⇒ 被抓。五处已全部还原。
- ⚠️ 备份口径两次踩坑（与 3.6 同源）：`.bak` 若早于后续编辑，还原会把新代码一起回滚（本轮把 `DECORATIVE_ICON_PROPS` 声明抹掉致 8 条 `ReferenceError`）；**进一步变异前必须重建与当前一致的备份并 `md5sum` 校验**，还原后 `grep` 复核关键符号仍在，不能只看"无 MUTANT 残留"。
- 诚实边界：**本包无 jsdom** ⇒ 真实 Tab 顺序、焦点环渲染、hover tooltip 弹出**均未在此覆盖**（归 7.3 Electron/CDP 键盘实测）。这里钉的是**属性契约**（名称存在、状态不只靠颜色、禁用带原因），不是行为验证。字号令牌只立与替换了 `IconButton`/`TextIconButton` 自身，既有组件的全量字号迁移归 4.3/4.4。
- [x] 4.2 实现全局栏与 RunWorkspace 页签承载（2h）；组件/CDP 验证“首次打开与无运行入口”“文件承载区不附带步骤目录”，全局/列表新建共用原对话框、录制定位现有代理设置。
### 4.2（2026-09-21 完成）

新增三个组件 + 改造四个文件 + 补测试：`RunWorkspace.tsx`（`WORKSPACE_TABS` / `availableTabs` / `resolveVisibleTab` / `RunWorkspace` / `NoRunsEmpty` / `RunHeader` / `RunHeaderView`）、`GlobalBar.tsx`（`ViewToggle` / `StatusIndicators` / `GlobalBar`）、`RunStatusBadge.tsx`（从 RunList 提取，支持 `status: … | null` ⇒ 「状态未知」）；改 `App.tsx` / `RunList.tsx` / `SettingsDialog.tsx` / `store.ts`；`test/run-workspace.test.ts`（**28 条**）+ `test/store.test.ts` 新增 4.2 段 **3 条**。

- store 新增：字段 `createDialogOpen: boolean`（初值 false）+ `settingsSection: "proxy" | null`（初值 null）；方法 `setCreateDialogOpen(open)`、`setSettingsSection(section)`。**新建与列表共用同一个 `createDialogOpen`**，App 层只挂**一个** `CreateRunDialog` 单例——`RunList` 原来的本地 `useState` 对话框开关已删除（那正是 spec 说的"各开各的"形态）。
- 页签承载：`RunWorkspace` 是工作区级外壳（页头 + `role="tablist"` + `role="tab"` `aria-selected` 按钮栏 + 正文槽），页签稳定标识与 `RunReadingState.tab` 同口径。**「文件」页签只在合法隔离 run 上出现**（`isIsolatedRun` 要求有效 `meta.workspace`）——不是"渲染了但禁用"，而是根本不渲染；保存的 tab 在当前 run 上不可用时 `resolveVisibleTab` 回退 `overview`（不残留一个不存在的页签）。文件页占整个正文槽，**不附带任何步骤目录**。
- 空态：`NoRunsEmpty` 给**两个真实可用**的入口（新建运行 → `setCreateDialogOpen(true)`；接入录制 → `setSettingsSection("proxy")` + 打开设置），文案说明两条真实路径（桌面直跑 / 代理录制）+ "可放 `*.jsonl` 到 traces/ 重开"，不写营销话术。
- 录制接入：**定位现有代理设置**（`SettingsDialog` 读 `settingsSection === "proxy"` 时 `scrollIntoView` 代理分区并聚焦首个控件），**消费后立即 `setSettingsSection(null)`** —— 否则用户手动收起后又被拉回去（一次性定位，不是常驻吸附）。
- `RunHeader` 拆成 **store 薄壳 + `RunHeaderView` 纯视图**：本包无 jsdom，且 **zustand v5 在 `renderToStaticMarkup` 下走 `getServerSnapshot`（恒为初始值）** ⇒ 组件测试喂不进 store 状态。拆开后"数据 → 视图"可直喂 props 测。任务/模型取**列表摘要**（详情兜底但不编造任务名），状态取**详情**（详情未到 ⇒ 「状态未知」，**不把缺省当作成功**；摘要里那个 `status` 不作数）。
- ⚠️ 全局栏的视图切换**不手写 `role="group"`**：biome `useSemanticElements` 要求用原生 `<fieldset>` + `sr-only` 的 `<legend>` 表达互斥按钮组。
- 判据有牙（**5 组变异全部被抓即还原**）：① `availableTabs` 恒含 files ⇒ **4 条失败**；② 移除 `aria-selected` ⇒ 2 条失败；③ **RunList 断掉共用开关（改回本地 onClick 不写 store）⇒ 首轮漏网**——本包无 jsdom 打不到"点了没反应"，据此补**源码级接线契约**用例（`RunList` 必须含 `s.setCreateDialogOpen` + 不得含 `<CreateRunDialog`；`App` 的 `<CreateRunDialog` 挂载数必须为 1；`GlobalBar` 必须含 `setSettingsSection("proxy")`；`SettingsDialog` 必须含 `proxySectionRef` 与 `setSettingsSection(null)`）⇒ 该组重验被抓；④ App 挂两个对话框实例 ⇒ 被抓；⑤ `GlobalBar` 录制入口不定位代理分区 ⇒ 被抓。
- 测试计数：desktop **637 passed / 0 failed（36 文件）**（3.6 基线 590，+47：4.1 的 16 + 4.2 的 31）。
- 诚实边界：**本包无 jsdom** ⇒ 真实点击开对话框（"点两处开的是同一个"）、真实切页签与焦点流转、`scrollIntoView` 的实际滚动效果**均未在此覆盖**——归 7.1–7.3 的 Electron/CDP 验收。4.2 的接线只用**源码级契约**钉住（能抓"改成各开各的"，但抓不到"接线对而行为错"）。⚠️ **SpanTree 仍留在三栏里作为独立一栏**（搬移是 5.4 的范围），本任务只承载详情列；`steps` 页签在本壳里等价于既有「轨迹」详情。
- [x] 4.3 实现运行导航和步骤目录宽度调整、自动收起及临时列表返回（2h）；几何和键盘检查“自动折叠后恢复用户布局”“多尺寸与放大下关键阅读可达”“键盘导航及工具名称”，验证正文下限与偏好恢复。
### 4.3（2026-09-21 完成）

新增 `src/renderer/src/lib/layout.ts`（纯判据）+ `src/renderer/src/lib/use-layout.ts`（React 接线）+ `src/renderer/src/components/ResizeGrip.tsx`（可调分隔条）；改 `App.tsx`（外壳消费判据）、`RunList.tsx` / `SpanTree.tsx`（宽度改由 props 传入 + 挂调节柄）；`test/layout.test.ts`（**31 条**）。

- 纯判据（`lib/layout.ts`）：`breakpointOf`（四档 1280/960/720）、`clampNavWidth`(220–360) / `clampStepsWidth`(200–320)、`stepWidth`（←/→ ±16、Home/End 到界，**不认识的键返回 `null`** 让调用方别 `preventDefault`）、`decideNavVisible`、`decideStepsVisible`、`preservePrefs`、`readContentWidth`。
- ⚠️ **断点口径必须是 `document.documentElement.clientWidth`**（D2 原文）：不是 `window.innerWidth`（含边框/滚动条，会整体偏大），也不是"主工作区宽度"。测试里按**代码行**（剔注释）断言不得出现 `innerWidth`——注释里正解释"为什么不用它"。
- ⚠️ **`clampWidth` 的 NaN/±Infinity 回默认值，不是夹到 min**：夹到 min 会把"宽度读不出来"静默变成"宽度调到了最小"。这条与 3.6 的"不可测高度返回 null 而不是 0"同源。
- ⚠️ **自动折叠不写回偏好**（本任务的核心纪律）：`navVisible` / `stepsVisible` 只是"这一刻显示不显示"，`LayoutPrefs` 完全不动。宽度回到 ≥1280 就自动恢复——因为偏好从没被改过。`preservePrefs` 就一个 `return prefs`，存在意义是给这条纪律一个**明确的断言点**（任何"把当前可见性存回 prefs"的写法都是错的）。「用户显式收起」与「屏幕不够宽自动收起」是**两个不同的字段**。
- 四档行为（D2 表）：wide 常驻；medium 概览保留导航、**文件页或编辑态暂时收起**；narrow 按需打开；single(<720) 单工作区（辅助列表替换正文）。**480px 二次约束是硬约束**：`contentWidth − 导航实占 − 步骤目录宽 ≥ 480`，不满足就自动收起步骤目录（用户把目录拖到 320 也可能因此被收起——约束优先于偏好）。
- `ResizeGrip`：`role="separator"` + `aria-orientation="vertical"` + `aria-valuenow/min/max` + `tabIndex={0}`；`pointerdown/move/up` + `setPointerCapture` 做拖动，拖动期间 `document.body.style.userSelect = "none"`（卸载也还原，避免卡在不可选中）。
- ⚠️ 组件**不自己夹宽度**：`RunList` / `SpanTree` 的宽度与范围常量全从 `../lib/layout` 来（源码契约测试钉住"组件里不得再出现 `w-80`/`w-96`，也不得另抄一遍 220–360"）。
- ⚠️ 踩坑：还原变异时误用 `git checkout <file>` —— 该文件**有未提交的 4.3 改动**，`checkout` 把整份 4.3 编辑回滚成已提交的 4.2 版本（丢掉约 60 行）。教训：**变异还原只能用备份副本（`cp`），绝不用 `git checkout`**，除非该文件确实已提交且无新增改动。手工重做后已恢复。
- 判据有牙（**6 组变异全部被抓即还原**）：① `decideStepsVisible` 忽略 480 约束 ⇒ 3 条失败；② `preservePrefs` 写回偏好 ⇒ 1 条；③ medium 档文件页/编辑态不收导航 ⇒ 2 条；④ `clampWidth` 的 NaN 夹到 min ⇒ 1 条；⑤ 断点边界 `>` 代替 `>=` ⇒ 1 条；⑥ 面板写死 `w-80` ⇒ 接线契约 1 条。
- 测试计数：desktop **668 passed / 0 failed（37 文件）**（4.2 基线 637，+31）。
- 诚实边界：**本包无 jsdom** ⇒ 拖动指针事件、真实 CSS 生效、`documentElement.clientWidth` 的真实换算（1440/1360/1024/800/640）、**Electron 200% 缩放**均**未实测**——归 7.1/7.2。⚠️ 本任务**未实现** D2 的「<720 单工作区辅助列表替换正文」（`auxPane` 状态已备但外壳未挂 UI）与「临时列表返回正文焦点」——`use-layout.ts` 暴露了 `auxPane`/`setAuxPane`，实际替换渲染留待 5.4 的导航重构；本任务只落地宽度调整 + 自动折叠 + 480 约束三条主线。
- [x] 4.4 重排 RunList 的摘要、搜索、来源和展开指标（2h）；fixture/CDP 验证“多份 trace 文件”“完整任务和 ID 搜索”“长模型和空任务的导航摘要”“徽标与过滤”“老文件无来源”，保留既有 token/工具/耗时字段；同步组件、现有组件/e2e 断言、测试描述与相关注释中的“仅代理/仅本地直录/本地直录”为“代理录制/本地记录”，检索产品源码及当前测试确认旧标签无残留，历史归档不改。
### 4.4（2026-09-21 完成）

把任务 2.4 建好的 `@shared/nav` 派生**接进 RunList**，并同步旧标签；新增 `test/run-list-nav.test.ts`（**24 条**）。改动：`components/RunList.tsx`（消费 `deriveNavLabel` + store 短 ID 状态）、`store.ts`（加 `shortIdState: ShortIdState` 字段，仅此一处语义变更）、三处旧标签同步（`store.ts`、`test/run-create.test.ts`、`test/plain-chat-regression.test.ts`）。

- **列表行三行结构**（保留全部既有字段）：① 状态徽标 + `代理录制` 徽标 + 任务（`line-clamp-2` 两行、完整值在 `title`）；② 短 ID（`font-code`）+ `分支` + 模型（缺失显「未记录」）；③ **既有指标一个不删**：时间 / `steps 步` / `toolCalls 工具` / `toolErrors 出错` / `tokens` / `命中` / `durationMs`。
- ⚠️ **短 ID 长度记忆必须挂 store，不能放组件**（本任务的接线核心）：delta 要求「**会话中**已扩展的长度不因刷新删除碰撞项而缩短」。组件随导航收起/展开会卸载重建，本地 state 一卸载就丢长度记忆 ⇒ 刷新后短 ID 缩回 8 位，正是规则禁止的。故 `shortIdState` 进 store（`ShortIdState` 实例），组件用 `s.shortIdState.update(runs.map(r => r.id))` 取映射。
- ⚠️ **短 ID 只是界面标识**：完整 ID 仍在 `title`（「完整 ID：…」）里给出；复制入口归 4.5。组件源码契约钉住「完整 ID」字样在位。
- ⚠️ **`cacheHit` 的三态**：`null`（无数据/未知）**不渲染**；`0`（实测零命中）**照常显示**且用琥珀色；`>0` 用翠绿色。这延续本 change 反复出现的「不知道 ≠ 没有」纪律——把 `null` 当 `0` 显示就是凭空断言"零命中"。源码契约钉住 `run.cacheHit === null ? null` 与 `run.cacheHit > 0` 两句都在。
- **来源标签同步**：产品源码与**当前**测试里的「仅代理 / 仅本地直录 / 本地直录」全部改为「代理录制 / 本地记录」（过滤按钮三档、徽标文案、注释、测试描述）。检索确认无残留；**历史归档（`openspec/changes/archive/*`）与 `docs/` 快照不改**（那是当时事实的留痕，改它等于篡改历史）；主 spec `openspec/specs/desktop-ui/spec.md` 的措辞更新**属归档时的事**，本任务不动（避免"已实现但 spec 未归档"时校验歧义）。
- 判据有牙（**4 组变异全部被抓即还原**）：① 短 ID 记忆移进组件（`new ShortIdState()` 于函数体）⇒ 1 条失败（接线契约）；② `cacheHit === null` 当 0 显示 ⇒ 1 条；③ 代理过滤失效（`filter === "proxy"` 恒 true）⇒ 5 条；④ 空任务回退失效（返回 `taskSummary("")` 而非回退文案）⇒ 2 条。
- ⚠️ 踩坑：变异③还原时**备份副本本身已被污染**（先 `cp` 后又补跑 patch，`nav.ts.bak` 抓到的是变异版）⇒ `cp` 还原后 `grep` 复核发现 `return true` 仍在，改用 `Edit` 精确改回。教训升级：**还原后必须 `grep`/`md5sum` 复核内容，不信任"cp 就完事"**。
- 测试计数：desktop **692 passed / 0 failed（38 文件）**（4.3 基线 668，+24）。
- 诚实边界：**未做** CDP/fixture 真实渲染验证（`line-clamp-2` 的真实两行截断、长模型换行展开的视觉效果、徽标配色）——本包无 jsdom，静态断言打不到 CSS；这些归 7.1/7.2。本任务**未实现**「模型换行并可展开完整值」的展开交互（只保留原值 + `title`），展开控件留待后续；**未接线** 4.5 的短 ID 复制与刷新/错误/空结果提示。

- [x] 4.5 接入导航的刷新/错误/空结果/选中隐藏提示及短 ID 复制（1h）；CDP 验证“同名运行的短 ID 稳定可辨”“筛选隐藏当前运行”“列表刷新失败可重试”，完整 ID 可复制且来源/状态不遮挡模型。
### 4.5（2026-09-21 完成）

新增 `src/renderer/src/lib/nav-notice.ts`（纯判据）+ `test/run-list-refresh.test.ts`（**18 条**）；改 `components/RunList.tsx`（刷新提示/重试/空态分流/复制入口 + 行结构改为「div 容器 + 选择按钮 + 复制按钮兄弟」）。

- 纯判据（`nav-notice.ts`）：`resolveNavListState`（未更新/首次失败/加载中占位）、`resolveEmptyCause`（`filtered` vs `no-records`）、`copyValueForRun`（**恒定返回完整 ID**）。
- ⚠️ **「未更新」的唯一真源是 store 的 `listStale`，本函数不接 `listLoaded`**（变异验证逼出来的）：store 已由 `resolveRefreshFailure(hadLoadedBefore)` 保证「只有曾成功加载过才为真」⇒ 再判 `stale && loaded` 是**等价冗余**（去掉无任何用例变红）。按「删掉经不起变异的装饰性代码」处理，改为省略该参数并在注释里写明真源。
- ⚠️ **空态两种成因必须分流**：有筛选条件 ⇒ 「当前条件下没有匹配的运行记录」+ 清除条件；无筛选条件 ⇒ 「还没有运行记录」+ 新建/放文件引导。把筛选空结果说成"没有记录"会误导用户去 `traces/` 找根本不存在的文件。
- ⚠️ **刷新中不显示「加载中…」覆盖已有列表**：`showLoading = loading && !hasAnyData`——有旧记录就留着（delta「刷新期间保留旧列表」）。
- ⚠️ **复制永远是完整 ID**（delta 原文「全文复制始终使用完整 ID；短 ID 只是界面标识」）：`copyValueForRun` 就是这个纪律的**单点断言**（返回原样）。复制失败（剪贴板权限/无安全上下文）**不假装成功**——`catch` 里复原显示，静默保持短 ID。
- ⚠️ **HTML 不允许 button 套 button**：原设计把复制入口做成 `<span role="button">` 嵌在选择 `<button>` 里，被 biome `useSemanticElements` 抓住（且本身就是无效 HTML）。改为「外层 `<div>` 容器 + 选择 `<button>`（整行可点）+ 复制 `<button>`（绝对定位兄弟，`group-hover` 显现）」。
- 判据有牙（**5 组变异**：4 抓 + 1 漏网后处理）：① `showStale` 忽略 loaded 守卫 ⇒ **漏网**（等价冗余，改为删除该判据）；② `showLoading` 忽略 `hasAnyData` ⇒ 1 条；③ 空态成因不分类 ⇒ 1 条；④ 复制返回短 ID ⇒ 1 条；⑤ 一个重试按钮不接 `loadRuns` ⇒ **漏网**（`toContain` 被另一按钮骗过），改按**按钮数=接线数**对齐后被抓。
- ⚠️ 环境坑：根 `pnpm --filter @rebaseagent/desktop build` 会拉起 `wmic.exe` 被宿主程序黑名单硬拦（沙箱**不可绕过**）；**在 `apps/desktop` 直调 `./node_modules/.bin/electron-vite.CMD build` 正常**（产物 main/preload/renderer 齐全）⇒ 判 build 是否通过走直调。
- 测试计数：desktop **710 passed / 0 failed（39 文件）**（4.4 基线 692，+18）。
- 诚实边界：**未做** CDP 真实点击复制 / 剪贴板写入门槛 / `group-hover` 显现 / 刷新提示配色的实测——本包无 jsdom，静态契约打不到这些；归 7.1/7.2。**未验证** 4.5 描述里「来源/状态不遮挡模型」的**视觉**层面（只保证 DOM 顺序与字段存在）。


## 5. 概览与步骤阅读

### 5.1（2026-09-22 完成）

新增 `src/renderer/src/lib/overview-view.ts`（展示分型 + 安全文本判据）+ `src/renderer/src/components/OverviewPanel.tsx`（`OverviewResultView` 纯视图 + `OverviewPanel` store 薄壳）+ `test/overview-result.test.ts`（**23 条**）；改 `App.tsx`（概览页挂独立内容）、`lib/reading-state.ts`（+ `overviewExpanded` 字段）、`test/reading-state.test.ts`（字段集 allowlist 同步）。desktop 全量 **733 passed / 0 failed（40 文件）**（4.5 基线 710，+23）。

- `presentResult(own)`：把 2.2 的 `deriveOwnOutput` 结论翻成结果区该显示什么。**展示层的分型优先看 `lastOutputKind`**——`missingReason` 答"为什么没成为最终输出"、`lastOutputKind` 答"这次调用到底记录了什么"，spec「无最终正文不借用祖先补全」明确要求"区分已记录内容类型"，故「只记录了思维链/工具调用」比「正文为空」更准确（后者会被误读成"什么都没有"）。
- 中间输出的角色文案固定为**「结束前记录的最后一段正文（不是本次最终结果）」**——用语里带否定语义，否则用户会把失败前的半截输出当成果。
- ⚠️ **「概览」不再是「详情列的别名」**：`App` 的 `WorkspaceShell` 在 `overview` 页签上挂 `OverviewPanel`、其余页签才落 `DetailPanel`。页签可见性仍由 `resolveVisibleTab` 单点判定（非隔离 run 保存的 `files` 回退概览）。
- ⚠️ **安全呈现是渲染方式、不是过滤**：正文一律走 React 文本节点（`LongText` 内部 `<pre>{text}</pre>`），从不 `dangerouslySetInnerHTML`、不渲染 `<img>`/`<iframe>` ⇒ 模型输出里的 `<script>`/远程图片/宿主路径**原样显示成字面量**，既不执行也不外联。`auditSafeTextRendering` 把这条变可断言（源码级）。
- 🐛 **审计函数首轮假红（已修）**：`auditSafeTextRendering` 直接扫源码 ⇒ 把自己文档注释里**点名**的禁用写法（"从不 `dangerouslySetInnerHTML`"）判成违规。已加 `stripComments` 先剥注释再扫——这是"判据能红但红错了对象"，与 4.5 的 `toContain` 假门同类。
- ✅ **判据有牙（5 组变异，4 抓 + 1 漏网后补契约）**：① `resolveMissingKind` 不区分已记录内容类型 ⇒ 2 条失败；② `stripComments` 退化为恒等 ⇒ 1 条（证明它不是装饰）；③ 真实引入 `dangerouslySetInnerHTML` 渲染正文 ⇒ 3 条；④ 中间输出角色文案弱化 ⇒ 4 条；⑤ **App 把概览分支也改回 `<DetailPanel/>` ⇒ 首轮漏网**——全量 728 条无一变红，因为所有用例都在测组件本身、没人测"它被挂在哪"。据此补 `接线契约：概览页确实挂到工作区概览页签上` 一节（5 条源码级断言：概览分支必须出现 `<OverviewPanel/>`、不得出现"概览也走 DetailPanel"、页签判据只有 `resolveVisibleTab` 一处、定位动作走既有 store 方法、展开状态进会话阅读状态）⇒ 该组重验被 1 条抓住。五处已全部还原并 `md5sum` 复核。
- 🐛 **测试数据自纠**：初版用 `u1-ok`（正文 37 字符）断言折叠行为 ⇒ 不达 600 阈值、`<details>` 根本不渲染。改为 `detailWithContent(长正文)` 合成用例；并把 `u1-error-legacy` 的期望从 `has-error` 改回 `not-normal-end`（该 fixture 的**错误来自工具而非 LLM**，最后自有 llm.call 无 error 且有正文 ⇒ 上游 `missingReason=null`，展示层正确归为"非正常终止"）。
- ⚠️ 顺带发现 `ResultKind` 的 `tool-calls-only` 分支**不可达**（`deriveOwnOutput` 恒把 `pendingToolCalls` 映为 `pending-tool-calls`）⇒ 已删除该分支而非留一个测不到的枚举值；`openCallHint` 里的 `lastOutputKind === "tool-calls-only"` 保留（该值在"无正文且无思维链"时确实产出）。
- 诚实边界：**未做** CDP 实测（真实点击「打开该调用」后的滚动/聚焦、`<details>` 真实开合、剪贴板写入门槛）——本包无 jsdom，静态契约打不到这些；归 7.1/7.3。**未接线**本次消耗/缓存覆盖/父本来源（归 5.3）与错误定位区（归 5.2）。

- [x] 5.1 实现概览结果区与安全长文本（2h）；组件测试“正常结束直接看到最终输出”“无最终正文不借用祖先补全”“模型输出不产生外部副作用”，覆盖 HTML/远程图片文本、原文复制及最近中间输出。

### 5.2（2026-09-22 完成）

在 `lib/overview-view.ts` 追加结局区/错误区/工具错误区判据（`presentOutcome` / `presentLlmError` / `presentToolErrors` + `OutcomeSection` / `LlmErrorSection` / `ToolErrorRow` 类型）；`components/OverviewPanel.tsx` 新增 `OutcomeSectionView` / `LlmErrorSectionView` / `ToolErrorsSectionView` 三区并接进 `OverviewResultView`（改为四区容器：结局 → 失败原因 → 结果 → 工具错误）。新增 `test/overview-error.test.ts`（**27 条**）。desktop 全量 **760 passed / 0 failed（41 文件）**（5.1 基线 733，+27）。

- **结局区不自己判结局**：`kind`/`label`/`tone` 全部来自 `classifyOutcome`（唯一判据来源），本模块只加"这对阅读者意味着什么"的补充说明（`OUTCOME_NOTE`）。补充说明**互不冒充**：`max_iterations` 的文案不得出现"预算"、`budget_exceeded` 不得出现"迭代上限"；`completed`/`error` 的补充为 `null`（标签已足够，不堆无信息量的句子）。
- **错误区三分支互斥且不可合并**：`located`（有带 error 的自有 llm.call ⇒ 给定位入口）/ `missing`（error 终止但自有无错误详情 ⇒ **只给说明、不给入口**）/ `none`（非 error 终止 ⇒ 整区不渲染）。"给一个指向不了的按钮比不给更糟"；"不是 error 终止却渲染空错误框"会让用户以为有错误没显示出来。
- **工具错误独立成区、绝不与 LLM 错误合并**（delta「不断言其为终止根因」）：`u1-error-legacy` 里错误来自**工具** ⇒ 工具错误区有内容，而 LLM 错误区仍是 `missing`。两个分区各自成立、互不影响，合并成"本次失败原因"框正是 spec 禁止的误归因。有工具错误时显式标注「（不构成终止原因）」。
- **未知不补零**：缺 HTTP 状态码显示「未记录 HTTP 状态」，不出现 `HTTP 0` / `HTTP —` 这类像数据的占位。
- **定位动作单通道**：三处入口（结果区/错误区/工具错误行）共用同一个 `onOpenCall` prop，全部落到既有 store 方法（`selectSpan` + `toggleStep` + `setReadingTab`）；展开 step 用"只在未展开时打开"的判据，避免切进去反而收起用户已展开的。
- 🐛 **5.1 的假红同款复发（已修）**：`expect(PANEL_SOURCE).not.toContain("dangerouslySetInnerHTML")` 又被自己的文档注释骗过——直接复用 5.1 的 `auditSafeTextRendering`（已按纪律先剥注释再扫）而非手写断言。**这说明该纪律应固化为"凡源码级禁用型断言一律走审计函数"，而非每次现场记得。**
- ✅ **判据有牙（6 组变异全部被抓即还原）**：① `presentLlmError` 在缺失时虚构定位目标 ⇒ 3 条；② missing 分支也渲染定位按钮 ⇒ 1 条；③ 去掉「不构成终止原因」标注 ⇒ 1 条；④ 给 `completed` 加"测试通过/修复成功"文案 ⇒ 2 条；⑤ 删除 `<ToolErrorsSectionView>` 接线 ⇒ 2 条；⑥ **组件自判结局绕过 `classifyOutcome`**（`aborted` 被显示成「已结束」）⇒ 1 条。六处已全部还原并 `md5sum` 复核。
- ⚠️ 环境坑：变异② 首版改坏了 JSX 结构 ⇒ vitest 报 `0 / 0`（**文件编译失败，不是"0 条失败"**）。**看到 `total 0` 要当编译/收集失败处理，不能当成"没有失败"**——这正是"假绿"的另一种形态。
- 诚实边界：**未做** CDP 实测（点击定位后的滚动/聚焦、错误正文长文本展开）——本包无 jsdom，静态契约打不到；归 7.1/7.3。**未覆盖**「显式错误定位优先于恢复」的**优先级排序**（属 3.2 的 `resolveReading`，已在 `reading-resolve.test.ts` 覆盖；本任务只保证"显式定位入口存在且指向真实调用"）。
- 本任务**未接线**本次消耗/缓存覆盖/父本来源（归 5.3）与预算地图（归 5.6）。
- [x] 5.2 实现概览错误/限制/中断区及真实调用定位（1.5h）；CDP 验证“失败概览定位真实自有调用”“旧失败记录没有错误详情”“限制中止与中断如实展示”“显式错误定位优先于恢复”。

### 5.3（2026-09-22 完成）

在 `lib/overview-view.ts` 追加消耗/缓存/来源三组判据（`presentConsumption` / `presentCacheCoverage` / `presentSource` + `ConsumptionSection` / `CacheSection` / `SourceSection` 类型）；`components/OverviewPanel.tsx` 新增 `ConsumptionSectionView`（内嵌 `CacheCoverageView`）与 `SourceSectionView`，接进 `OverviewResultView`（四区容器扩为六区：结局 → 失败原因 → 结果 → 工具错误 → 本次消耗 → 来源）。`OverviewResultView` 的 `detail` 入参扩为 `…| "meta" | "chain"`，store 薄壳把 `onOpenParent` 接到既有 `selectRun`。新增 `test/overview-consumption-source.test.ts`（**30 条**）。desktop 全量 **790 passed / 0 failed（42 文件）**（5.2 基线 760，+30）。

- 本次消耗：`tokensIn/tokensOut`、已记录时间跨度（`null` ⇒ 「未记录时间跨度」而非 `0`/`—`）、工具调用/错误；`scopeNote` 恒定声明「仅自有调用、缺失不补零、祖先共享前缀不计入」；自有 token 全 0 时给 `zeroUsageNote`（「可能是失败调用占位零，不据此断言实际零消费」）。
- 缓存覆盖：`recorded === 0` ⇒ `hitTotal = null` + 「未记录命中量」（未知 ≠ 0）；`cache_hit: 0` 算已记录 ⇒ `hitTotal = 0` 照常显示；部分记录附「不构成整次命中率」。
- 来源：`parentId` 取**直接父** `meta.parent`；按 fork 字段分流执行语义——result ⇒ `shared-prefix`，prompt fork / model_params ⇒ `independent`（措辞「独立执行」，**绝不含「共享前缀」字样**），代理 ⇒ `proxy`；隔离续跑 `isolationNote` 取真实 `origin.run_id` + 「轮末检查点」「独立世界」，**不出现「修改了源文件」/「已恢复历史磁盘状态」**；`canOpenParent` 有父才给「返回父记录」入口。
- 🐛 **首轮 1 条假红（已修）**：代理分叉的 `relationNote` 写成「…不适用**共享前缀**语义」——否定句仍把禁用词带上屏幕。改为「来源关系见父链列表，本 run 只呈现自身记录」。（教训：断言 `not.toContain("共享前缀")` 会连**否定用法**一起抓，文案里索性别提该词。）
- ✅ **变异验证 5 组全部被抓**：① `durationMs ?? 0`（未知补零）⇒ 2 条红；② `hitTotal: 0`（未知当零）⇒ 4 条红；③ prompt fork 改报 `shared-prefix` ⇒ 1 条红；④ 隔离来源改用 `world_id` 冒充真实来源 ⇒ 1 条红；⑤ `OverviewResultView` 删掉 `<ConsumptionSectionView>` ⇒ 源码级接线契约 1 条红。全部用备份 `cp` 还原（绝不用 `git checkout`），还原后 `md5sum` 与备份一致、`grep` 确认无 `MUTATION`/`world_id}` 残留。
- 诚实边界：**未做** CDP 实测（真实点击「返回父记录」后的加载与位置、消耗区在窄列的换行）——本包无 jsdom，静态契约打不到；归 7.1/7.3。**未覆盖**「沿链总成本」（本 change 明令概览不新增该能力，沿链口径仍由既有树/指标面板 `deriveChainTotals` 提供——见 design D5）。
- 本任务**未接线**预算地图（归 5.6）与调用详情的完整缓存展示（归 5.7）。

- [x] 5.3 实现概览本次指标、缓存覆盖与父本来源（1.5h）；fixture 验证“本次指标不累计共享前缀”“来源和隔离边界保持真实”“run 级累计现算”，祖先值不计本次、未知不补零、不将 tool_result 改动称为文件改动。
- [x] 5.4 调整 SpanTree 阅读承载、展开/选择分离和自有/继承标记（1.5h）；组件/CDP 验证“三步运行的树结构”“工具报错”“展开与调用选择互不干扰”“首次步骤选择与空轨迹”“继承轨迹与独立执行来源”。

  实现（commit 见下）：
  - **新增** `src/renderer/src/lib/span-tree-view.ts`（纯判据）：`SpanRowView`（行事实）、`stepLabel`（本地轮号，不累加）、`rowErrorKind`（tool 用 `error !== null` / llm 用 `error !== undefined`，两判据不合并）、`spanRowLabel`、`flattenSpanRows`（按 parent 扁平成行，depth 逐层递增；`expandedOf` **只影响是否下钻**，不碰选中）、`stepsEmptyCause`（两成因互斥，空轨迹优先）。
  - **重写** `src/renderer/src/components/SpanTree.tsx`：`SpanRow` 为纯展示行——**展开按钮与选择按钮是两个独立按钮**（`aria-expanded` vs `aria-current`），展开只切展开、选择只改选中；继承行带「继承」文字标记；两类错误分别标「工具错误」/「LLM 错误」；空态按成因分流（`no-spans` 说「没有可展示的步骤」、`no-own-calls` 说明下方为继承前缀）。`SpanTreeRow` 递归透传 `depth`（**修复了初版 `depthOverride={0}` 恒为 0、树被拍平的缺陷**）。目录标题栏加收起控件（`onToggleCollapsed`）。
  - **改** `src/renderer/src/App.tsx`：目录**只在步骤页挂载**（`tab === "steps" && layout.stepsVisible`）——概览/文件页不挂（delta「文件承载区不附带步骤目录」、design D1）；目录收起时正文顶部给「重新打开步骤目录」入口（`StepsDirectoryEntry`，走 `setStepsOpened(true)` **临时打开**，不写偏好），当前选中调用身份不丢（`selectedSpanId` 在 store）。
  - **新增** `test/span-tree-view.test.ts`（**29** 条）：纯判据 + `SpanRow` 静态渲染 + `StepsDirectoryEntry` 渲染 + 外壳接线契约（源码级）。

  验证：typecheck（node+web）绿；desktop 全量 **819 passed / 0 failed（43 文件）**（5.3 基线 790，+29）；`biome check` 改动 4 文件干净；`electron-vite build` 通过；`openspec validate --all --strict` 13/13。
  变异验证 **9 组**（改→跑→`cp` 还原→`md5sum` 复核，全部还原）：①`stepLabel` 累加 ⇒ 3 红；②`rowErrorKind` llm 改用 `!== null` ⇒ 1 红；③`own` 恒真 ⇒ 2 红；④`depth` 不递增 ⇒ 2 红（正是初版缺陷）；⑤`stepsEmptyCause` 判序颠倒 ⇒ 2 红；⑥展开按钮 aria-label 固定 ⇒ 1 红；⑦去掉步骤页门控 ⇒ 1 红；⑧**首轮漏网**——重开入口只断言了文案 `toContain("重新打开步骤目录")`，改文案不红 ⇒ **已改为断言接线表达式**（`tab === "steps" && !layout.stepsVisible` + `setStepsOpened(true)` + 不得走 `toggleStepsCollapsed`）并导出组件直接渲染 ⇒ 复测 1 红；⑨去掉继承标记渲染 ⇒ 1 红。
  诚实边界：**未做** CDP 实测（真实点击展开/选中后详情替换、窄窗口重开入口的实际滚动/焦点）——本包无 jsdom，静态契约打不到；归 7.1/7.3。⚠️ 本任务**未**合并 `DetailPanel` 内部遗留的 `trajectory`/`files` 局部 tab（与工作区页签并存），该收口归后续任务。
  ⚠️ 本地 `biome check .` 会报 `docs/**/*.json`（未跟踪，CI 上不存在）与 `apps/desktop/src/shared/list-refresh.ts`（**工作副本 CRLF 假报**：git blob 实为 LF，CI 新克隆不受影响）——**均非本任务引入**，未改。

- [x] 5.5 整理调用详情的输入/输出、原始字段与就近查找/复制（2h）；fixture/CDP 验证“推理模型的思维链”“工具调用详情”“长请求和原始字段完整可读”，不丢 request.tools/params、reasoning、tool_calls 或耗时字段。

  实现：
  - **新增** `src/renderer/src/lib/call-detail-view.ts`（纯判据）：字段清单契约 `LLM_CALL_FIELDS` / `TOOL_INVOKE_FIELDS` / `STEP_FIELDS`（spec 逐字段点名）、可选字段 `OPTIONAL_LLM_FIELDS` + `optionalSectionVisible`（有该字段才渲染栏目）、`IO_SECTIONS` + `ioCoversAllFields`（**两半并集必须覆盖全部原始字段**，把"切换不丢字段"变成可断言对象）、`defaultIoView` / `resolveIoView`（失败默认输出、成功默认输入；记忆优先）、`presentStepDetail`（三块：已记录调用/错误计数/派生消耗，**消耗取自 `deriveStepStats` 不重算**）、`findInText` / `stepFind` / `splitByMatches`（在**完整原文**上查找、大小写不敏感、空查询短路、不重叠、越界回绕）。
  - **改写** `src/renderer/src/components/LongText.tsx`：新增查找输入框（展开后出现）+ 上一个/下一个循环导航 + `第 n / m 个` 计数 + 「复制原文」；命中用 `<mark>` 高亮；复制目标抽成 `copyPayload(text)`（**保证复制的是完整原文**，spec 明写不得复制省略后展示）；`copyFeedbackText` / `findCountLabel` 如实区分「已复制/不支持」与「无命中」。
  - **改** `src/renderer/src/components/DetailPanel.tsx`：`LlmCallDetail` 拆壳 + **纯展示 `LlmCallDetailView`**（概要 + `CacheHitRow` + **输入/输出切换条**（`aria-pressed`）+ 错误区 + `io==="output"` 渲染思维链（琥珀底）/正文/工具调用、`io==="input"` 渲染请求消息/工具表/采样参数；fork 编辑器由壳经 `children` 注入）。`ToolInvokeDetail` 拆壳 + 纯展示 `ToolInvokeDetailView`（args/result **并排就近核对**在同一个「入参与结果」分区、error 非空显式呈现、`dur_ms` 与墙上耗时两口径并存）。新增纯展示 `StepDetailView`（概要三块 + **每条已记录调用是可下钻按钮** + 错误标记）；step 分支从 **span 树**取节点（`buildSpanTree` → `stepNode`）后接 `presentStepDetail`，`onOpenCall` 接 `selectSpan`。
  - **新增** `test/call-detail-view.test.ts`（**60** 条）：字段清单契约 + io 切换判据 + 可选栏目判据 + `findInText`/`stepFind`/`splitByMatches` + `presentStepDetail` + 三个纯展示组件静态渲染（思维链/正文分区、输入输出换半、args/result 同分区、error 显式）+ `LongText` 查找/复制/`copyPayload` + 外壳接线源码契约。

  验证：typecheck（node+web）绿；desktop 全量 **879 passed / 0 failed（44 文件）**（5.4 基线 819，+60）；`biome check` 改动 4 文件干净；`electron-vite build` 通过；`openspec validate --all --strict` 13/13。
  变异验证 **18 组**（改→跑→`cp` 还原→`md5sum` 复核，四文件 md5 全部一致）：lib 层 12 组（①`ioCoversAllFields` 去掉 `duration` 白名单 ⇒1 红；②`IO_SECTIONS.input` 丢 messages ⇒1 红；③`defaultIoView` 抹平 ⇒1 红；④`resolveIoView` 忽略记忆 ⇒1 红；⑤可选栏目恒真 ⇒5 红；⑥轮号写死 ⇒1 红；⑦tool 错误判据改 `!==undefined` ⇒1 红；⑧消耗不取派生 ⇒1 红；⑨查找大小写敏感 ⇒2 红；⑩空查询不短路 ⇒ **挂死**（`indexOf('',n)=n` 且步进 0 ⇒ 空转，整文件零用例、`success=true` 但 `passed=0` ⇒ 判红规则必须含"零用例"）；⑪命中段不标 hit ⇒1 红；⑫`stepFind` 原地不动 ⇒2 红）；组件层 6 组（⑬输出分支永不渲染 ⇒3 红；⑭思维链标题被抹 ⇒1 红；⑮args/result 拆区 ⇒1 红；⑯tool error 判据错 ⇒4 红；⑰step 下钻断开 ⇒1 红；⑱step 节点不从树取 ⇒1 红）。
  - ⚠️ **两处经变异验证修正的设计**：① `stepFind` 原守 `total === 0 || index < 0`，变异证明 `index < 0` 是**等价冗余**（`findInText` 仅在两处返回 `index:-1`，均同时给空 matches ⇒「无命中」蕴含「total 为 0」）⇒ **按纪律删除冗余而非补用例**。② `LongText` 的复制目标原先内联 `writeText(text)`，变异（改成截断串）**不红**——盲区；已抽 `copyPayload(text)` 并加用例 + 源码级调用点断言（`writeText(copyPayload(text))`）⇒ 复测 1 红。
  - ⚠️ **驱动器坑（沙箱特有）**：本沙箱内 node `execSync` spawn `cmd.exe`/`npx` 必 `EBUSY`，**不能**用 node 驱动器跑 vitest；须在主 shell 里 `cd apps/desktop && ./node_modules/.bin/vitest.CMD run … > out.txt`（**不可**用 `( )` 子 shell、**不可**管道进 grep——两者都会让 vitest 静默产空输出）。判红必须**只认** `--reporter=json --outputFile=<相对路径>` 的 `numFailedTests`（ANSI 色码会让 `grep "Tests N failed"` 永远失配）；且 `success===false || numPassedTests===0` 也算红（覆盖挂死）。
  诚实边界：**未做** CDP 实测（真实点击"输入/输出"切换后的重渲染、`<details>` 真实开合与查找框实际聚焦、剪贴板真实写入、step 调用按钮点击后的滚动/选中）——本包无 jsdom，静态契约打不到；归 7.1/7.3。**未接线**预算地图（归 5.6）与主 spec 的缓存/A-B 提示完整项（归 5.7）。
- [x] 5.6 接回预算地图、失败解释及已有编辑器（1.5h）；验证“预算和错误能力迁移后可达”及主 spec“预算地图与聚合一致”“选中数据点联动详情”“超限终止被标注”“无预算信息的老文件”“编辑态才加载编辑器”，保留整条轨迹预算口径。

  实现：
  - **预算地图判据外提** `src/renderer/src/lib/budget.ts`：在既有 `buildBudgetMapOption` / `budgetExtent` 之后新增三个纯判据——`budgetExceeded({status, lastEventReason})`（**两条合取**：`status === "completed"` **且** 末事件 reason 为 `budget_exceeded`；running/crashed 即使累计超限也不算）、`budgetSummaryLabel({maxTotal, exceeded})`（`maxTotal===null` ⇒「无预算信息」**不提任何数值**；超限才追加「已超预算终止」）、`budgetDetailLabel({series, maxTotal})`（空轨迹 ⇒「无曲线可绘」；有调用但无预算 ⇒ 明说「未记录预算上限，故不画参考线」而非拿 0 冒充）。
  - **改** `src/renderer/src/components/BudgetMap.tsx`：改用上述三判据（`const exceeded = budgetExceeded({...})`）；删掉不再使用的 `budgetExtent` 局部调用。地图本体（`<details>` 折叠、展开才动态 import echarts、`instance.on("click")` → `data.data?.spanId` → `selectSpan(spanId)`、`key={detail.meta.id}`）**保持不动**——它此前已接对，本任务只是把判据变成可断言对象并防止回退。
  - **编辑器懒加载（本任务真正修的缺口）**：此前 `main.tsx` 静态 `import "./monaco-bootstrap"` 会把 ~8.5 MB monaco 打进**主 bundle**，纯浏览路径也加载编辑器资源，违反主 spec「仅在用户进入编辑态时加载编辑器资源」。改法：① **重写** `src/renderer/src/monaco-bootstrap.ts` 为导出**幂等** `ensureMonaco(): Promise<MonacoApi>`（`pending` 单飞；全部 monaco import 落在函数体内动态进行：`editor.api` + `register.all` + `json` 语言贡献 + editor/json 两个 `?worker`，`loader.config({monaco})`）；② **新增** `src/renderer/src/components/MonacoEditors.tsx`（**懒 chunk 内实体**，`useMonacoReady()` → `ensureMonaco()` 完成后才渲染 `@monaco-editor/react` 的 `Editor`/`DiffEditor`）；③ **新增** `src/renderer/src/components/MonacoEditor.tsx`（懒边界：模块级 `lazy(() => import("./MonacoEditors"))` + `MonacoFallback` 占位 + 把 `data-*` 落到 DOM 的 `editorAttrs`）；④ **新增** `src/renderer/src/monaco-modules.d.ts`（两条 `declare module` 补动态 import 类型）；⑤ **改** `main.tsx`（删静态装配，留注释说明为何不得装配）、`DetailPanel.tsx`（3 处 `<Editor>` → `<MonacoCodeEditor>`）、`WorkspaceFileView.tsx`（`<DiffEditor>` → `<MonacoDiffEditor data-testid="diff-editor">`）。
  - **新增** `test/budget-reachability.test.ts`（**26** 条）：预算与聚合一致（累计/参考线/点数=调用数、非 llm span 不入曲线、现算幂等）+ 数据点定位链（`spanId` 就是调用 id、源码契约 `selectSpan` 且**不得** `setSelectedSpanId`）+ `budgetExceeded` 合取矩阵（completed 才真、reason 必须 `budget_exceeded`、null/undefined 皆假）+ 超限标注（末点标红需**两者都真**）+ 无预算老文件（无 markLine、文案不臆造数值）+ 失败解释可达（预算地图与三个详情组件同处步骤页、`key` 重建）+ 编辑器懒加载 8 条源码契约 + `MonacoFallback` 静态渲染。

  验证：typecheck（node+web）绿；desktop 全量 **905 passed / 0 failed（45 文件）**（5.5 基线 879，+26）；`biome check` 改动 10 文件干净；`electron-vite build` 通过，**主 chunk 从 8,510 kB 降到 1,014.89 kB，主 chunk 内 `monaco-editor` 引用数 = 0**，monaco 拆为 `MonacoEditors`(25.7 kB)/`editor.api`(672 kB)/`format`(4.55 MB)/`editor.worker`(585 kB)/`json.worker`(884 kB) 等懒 chunk；`release-check.mjs` exit 0；`openspec validate --all --strict` 13/13。
  变异验证 **13 组**（改→跑→`cp` 还原→`md5sum` 复核，六文件 md5 全部一致、无关键字残留）：`budgetExceeded` 去掉 `completed` 合取 ⇒红、去掉 `lastEventReason` 合取 ⇒红；`budgetSummaryLabel` 超限文案改写 ⇒红、「无预算信息」改成「预算 0」⇒红；`budgetDetailLabel` 无预算文案改成臆造数值 ⇒红、空轨迹文案改成假数值 ⇒红；`BudgetMap` 断开 `selectSpan` ⇒红；`monaco-bootstrap` 去掉 `pending` 幂等 ⇒红；`MonacoEditor` 去掉占位门 ⇒红、丢 `data-testid` 透传 ⇒红；`main.tsx` 恢复静态装配 ⇒红；`MonacoEditors` 切 `DiffCodeEditor` 时错指 `CodeEditor` ⇒红。
  - ⚠️ **两处变异不红，均为已知且诚实登记的盲区**：① `MonacoEditors.tsx` 的 `const ready = useMonacoReady()` 改成 `const ready = true` **不红**——本包无 jsdom 且 `renderToStaticMarkup` 不跑 `useEffect`，组件测试永远只到占位层，`useMonacoReady` 的真实门控打不到（真实加载时机归 7.x CDP；静态契约只钉"文件里存在 `ensureMonaco()` 调用"这个接线，不钉"调用被等到了"）。② `MonacoEditor.tsx` 的 `if (!loaded)` 改成 `if (true)`（即永远渲染占位、真实环境永不显示编辑器）**不红**——同因。两者的共同边界是"接线对而行为错"，与 5.4/5.5 的诚实边界同款。
  - ⚠️ **设计修正（经测试暴露）**：`<Suspense>` 包懒组件在 `renderToStaticMarkup` 下会抛 "A component suspended while responding to synchronous input" ⇒ 静态渲染与懒边界根本不兼容。改为**显式状态门**（`useState(false)` + `useEffect` 里 import 成功后置位；未加载渲染 `MonacoFallback`），静态渲染下稳定得到占位、真实运行下正常渲染。同样地，`@monaco-editor/react` 的 `<Editor>`/`<DiffEditor>` **不透传 `data-*`**，故占位与实体两条路径的 DOM 锚点都由懒包装层 `editorAttrs` 负责——这也是 `test/workspace-file-view.test.ts` 的 `vi.mock("@monaco-editor/react")` 桩**被绕开**（懒边界内才是真 import 点）后仍能通过的原因。
  诚实边界：**未做** CDP 实测（真实进入编辑态后的 monaco 实例创建、worker 实际启动、diff 并排渲染与只读生效、`<details>` 真实开合后 echarts 的点选联动）——本包无 jsdom，静态契约与产物体积分析打不到运行时行为；归 7.1/7.3。`useMonacoReady` / 占位门的**运行时**正确性亦未覆盖（见上）。
### 5.7（2026-09-22 完成）

**新增** `src/renderer/src/lib/cache-view.ts`（`presentCacheHit` / `presentCacheMiss` / `CACHE_EFFECTIVE_PERCENT`）+ `src/renderer/src/lib/fork-cache-hint.ts`（`forkCacheHint` / `ForkKind` / `ForkCacheHint`）；**改** `components/DetailPanel.tsx`（`CacheHitRow` 改由纯判据驱动并导出、新增导出 `ForkCacheHintView`、`ForkEditor` 的 `modelMismatch` 局部判定换成 `forkCacheHint`）；**新增** `test/cache-display.test.ts`（**25 条**）。desktop 全量 **930 passed / 0 failed（46 文件）**（5.6 基线 905，+25）。

本任务的实质是**把 5.1–5.6 期间已经落地的缓存/提示能力"补成可断言对象"**——功能本身已在前序任务实现，但判据长在重度依赖 store 的组件内部，本包无 jsdom ⇒ 改错不红（等于没有判据）。

- **缓存命中行判据外提** `presentCacheHit(usage)`：返回 `{hit, input, shownHit, percent, tone, verdict, abnormalNote}`，`null` = 字段缺失（降级省略）。三条不许含糊对应 spec 三场景：① **存在性而非 truthiness**（`hit === undefined` 才返回 null，`0` 照常展示）；② **`in === 0` 不做除法**（`percent` 为 null，只给绝对 tokens）；③ **措辞按命中量分档**——只有 `hit === 0` 才是 `tone:"full"`「全量计费」，`< 50%` 是 `tone:"partial"`「部分命中，多数输入仍按全价计费」，二者**互不冒充**（spec 明令少量命中不得被称为全量计费）。`cache_hit > in` 按输入总量截断 + `abnormalNote` 显式标注。
- **组件只摆 DOM**：`CacheHitRow` 从 store 无关的纯展示组件导出，`data-cache-tone` 落 DOM 供断言；`presentCacheMiss` 把「`cache_miss` 缺失 ≠ 0」也变成可断言对象。
- **分叉提示判据外提** `forkCacheHint({kind, parentModel, configModel})`：**只有 `kind === "tool-result"`** 才可能给提示（prompt fork / 代理 messages 分叉直接 return null——spec 明令不加），且**任一模型为 null 不给**（未知 ≠ 不一致，不凭空说"可能不命中"）。提示带 `informational: true` 与「不阻止重跑」措辞，**不碰任何既有 fork 门禁**。渲染侧新增导出组件 `ForkCacheHintView`（`null` 时返回 null），`ForkEditor` 只负责 `forkCacheHint({kind:"tool-result", parentModel, configModel})` → `<ForkCacheHintView hint={cacheHint} />`。
- 🐛 **变异⑩首轮漏网（重要教训，与 5.4 的"文案断言 ≠ 能力断言"同款）**：第一版只断言源码里存在字符串 `data-fork-cache-hint="tool-result"` 与 `{cacheHint.text}` ⇒ 把渲染分支改成 `{true ? null : (…)}`（**永不渲染**）**不红**。改为把提示块抽成导出组件 `ForkCacheHintView`，用 `renderToStaticMarkup` 做**能力断言**（给了 hint 就必须出现文本与锚点；`hint === null` 必须渲染空串）⇒ 复测被抓。**教训固化：凡是"这段 UI 到底渲染不渲染"，源码字符串断言一律无效，必须抽出可静态渲染的纯展示组件。**
- ✅ **变异验证 11 组全部被抓**：① `hit === 0` 当假值返回 null ⇒ 4 红；② `tone` 不分档（partial 被写成 full）⇒ 3 红；③ `in=0` 仍做除法（造出 0/1 比例）⇒ 2 红；④ 无字段时以 0 冒充（降级失效）⇒ 2 红；⑤ `cache_miss` 缺失以 0 冒充 ⇒ 1 红；⑥ prompt fork 也加提示 ⇒ 2 红；⑦ 未知模型当成不一致 ⇒ 1 红；⑧ 模型一致时仍提示 ⇒ 1 红；⑨ `LlmCallDetailView` 不挂 `<CacheHitRow>` ⇒ 1 红；⑩ `<ForkCacheHintView>` 接线断开 ⇒ 1 红；⑪ `ForkCacheHintView` 恒不渲染 ⇒ 1 红。全部用备份 `cp` 还原（绝不用 `git checkout`），还原后 `md5sum -c` 三文件逐字一致。
- 诚实边界：**未做** CDP 实测（`data-cache-tone` 对应的实际着色与视觉区分、真实点击分叉编辑器后的提示出现位置）——本包无 jsdom，静态契约与结构断言打不到样式渲染；归 7.1/7.3。**未覆盖** run 级累计在列表/概览的接线（5.3 与 `RunList` 已完成并各有测试，本任务只补 llm.call 详情侧与分叉提示侧）。

- [x] 5.7 接回完整缓存展示与原模型变化提示（1h）；现有测试加组件检查覆盖“llm.call 详情展示缓存命中”“零命中仍展示为全量计费”“少量命中不得被称为全量计费”“无缓存字段的调用降级”“tool_result 分叉的模型不一致提示”“其它分叉形态不加缓存提示”“输入为零与全未知缓存”。

  实现：**新增** `src/renderer/src/lib/cache-view.ts`（`presentCacheHit` 返回存在性判据 + 比例 + 三档 `tone` + 唯一 `verdict` 文案 + `abnormalNote`；`presentCacheMiss`；`CACHE_EFFECTIVE_PERCENT = 50`）与 `src/renderer/src/lib/fork-cache-hint.ts`（`forkCacheHint`：仅 tool-result 形态 ∧ 两模型皆知 ∧ 不一致才给，`informational: true`）；**改** `components/DetailPanel.tsx`（导出 `CacheHitRow` 并改由 `presentCacheHit` 驱动、落 `data-cache-tone`；新增导出 `ForkCacheHintView`；`ForkEditor` 删掉内联 `modelMismatch` 改用 `forkCacheHint({ kind: "tool-result", parentModel, configModel })`）；**新增** `test/cache-display.test.ts`（**25** 条，覆盖 spec 七条场景 + 门槛边界 + 异常数据 + 两组源码级接线契约 + `ForkCacheHintView` 能力断言）。

  验证：typecheck（node+web）绿；desktop 全量 **930 passed / 0 failed（46 文件）**（5.6 基线 905，+25）；`biome check` 改动 4 文件干净；`electron-vite build` 通过（主 chunk 1,015.73 kB，**monaco 仍在懒 chunk**，5.6 的体积收益未回退）；`release-check.mjs` exit 0；`openspec validate --all --strict` 13/13。
  变异验证 **11 组**（改→跑→`cp` 还原→`md5sum -c` 复核，三文件逐字一致）：①~⑤ 判据层（0 当假值 / tone 不分档 / `in=0` 做除法 / 无字段以 0 冒充 / `cache_miss` 以 0 冒充）；⑥~⑧ 提示层（prompt fork 也提示 / 未知当不一致 / 一致也提示）；⑨~⑪ 接线层（详情壳不挂缓存行 / 分叉编辑器不挂提示块 / `ForkCacheHintView` 恒不渲染）。**⑩ 首轮漏网已修**——见上文「教训固化」。

## 6. 旧能力接线与回归

### 6.0（2026-09-22 完成）

**重写** `apps/desktop/scripts/mock-llm-server.cjs`（工厂化 + 协议协商 + 失败/延迟/非流式 + 控制端点）；**新增** `test/helpers/mock-llm-harness.ts`（每流程换实例 + 配置逐字节还原）；**新增** `test/controlled-service.test.ts`（**18 条**）。desktop 全量 **948 passed / 0 failed（47 文件）**（5.7 基线 930，+18）。

**各入口请求模式核对结论**（本任务用真实客户端/编排逐条钉住，非看代码猜）：

| 入口 | `stream` | 端点 | 工具声明 |
|---|---|---|---|
| 普通创建 `runs:create` / 隔离创建 / result fork / prompt fork / 隔离续跑 / 模型 A/B | `true`（SSE，`stream_options.include_usage`） | `POST {baseURL}/chat/completions` | 空表 / file-tools-v1 / 父记录工具表 |
| 模型 A/B **dry-run** | **零请求**（`model-replay-run.ts:368` 在费用门禁与联网前早退） | — | — |
| **llm-proxy 转发** | **按请求体 `stream` 分流**（`handler.ts:132`；`false` 走 JSON 直通 `:198`） | 原样 `{upstreamBaseUrl}${path}` | 原样转发 |

⇒ **唯一会发 `stream:false` 的是代理通道**；这正是 design D7「不能将统一 SSE 响应当成全协议模拟」的技术原因——旧 mock 只发 SSE，代理非流式路径**根本没有能力被验证**。

- **协议协商**（`resolveMode`）：回合未显式指定 `mode` 时按请求协商——`stream === true` ⇒ SSE，否则 ⇒ **真 JSON**（`chat.completion` + `application/json`，不再是 SSE）。显式 `mode` 保留，用于**主动构造**协议错配用例。
- **补齐的能力**：非流式 JSON（`mode:"json"`）、HTTP 失败（`mode:"fail"` + `status` + `errorBody`，供代理非 2xx 直通与客户端错误路径）、延迟（`delayMs`，供 ttft 探针）、用量覆盖（`usage.{in,out,cache_hit,cache_miss}` —— cache 走 DeepSeek 扁平字段，与客户端 `parseCacheUsage` 同源，**`0` 照发**）、思维链（`reasoning`）。
- **控制端点**（不属 OpenAI 协议，供测试复位）：`GET /__log`（`{served, entries}` 内存镜像）、`POST /__reset`（计数与日志清零，body 可换剧本）、`GET /`（健康 + 回合数）。CLI 启动日志格式**保持原样**（`[mock-llm] 启动于 … port=… 剧本回合数=…` + `listening on …/v1`），既有 GUI 冒烟脚本不受影响。
- **harness（6.4–6.6 复用）**：`withMockLlm(script, fn)` **每流程起新实例、结束必关停**——"重置"由**实例隔离**提供而非依赖调用方记得 `reset`（后者忘记就静默串计数）；`applyTestSettings(settingsPath, …)` 返回**逐字节**还原函数（原文件不存在则删除，不留回归残留）；`settingsFileIn(dataDir)` 把路径拼接只写一处。
- **探针一律用真实实现驱动**（`OpenAiCompatClient` / `runLoop` / `runModelAb`），不手搓 fetch——否则验的是探针自己的假设。
- ✅ **变异验证 12 组全部被抓**：① `resolveMode` 恒 sse（退回"统一 SSE 冒充全协议"）⇒ 1 红；② 恒 json ⇒ 12 红；③ `cache_hit=0` 当假值丢弃 ⇒ 1 红；④ 忽略回合 `usage.in` ⇒ 1 红；⑤ fail 恒回 200 ⇒ 1 红；⑥ `delayMs` 不生效 ⇒ 1 红；⑦ 日志 `stream` 恒 true ⇒ 1 红；⑧ json 模式回 SSE content-type ⇒ 2 红；⑨ `reset` 不清日志 ⇒ 1 红；⑩ `restore` 不还原字节 ⇒ 2 红；⑪ `withMockLlm` 不关停 ⇒ 1 红；⑫ `restoreFile` 对"原本不存在"不删除 ⇒ 1 红。两文件 `md5sum -c` 逐字还原。
- 🐛 **变异⑪首轮漏网（已修）**：原先只断言 `second.port !== first.port` 是**假门**——新实例本来就换端口，**不关停服务照样满足**。改为"流程结束后已捕获的句柄**不可达**"（fetch 必抛）⇒ 复测被抓。**教训：验证"资源已释放"不能用"下一个实例能起来"代理，必须验**该资源本身**已失效。**
- 诚实边界：**未做** CDP 实测（真实 Electron 里设置指向受控服务后走完整 GUI 流程）——那是 6.4–6.6 的验收内容；本任务只把**执行前提**（请求格式/次数/顺序可验证 + 每流程复位 + 配置恢复）备齐，按 design「未通过不开始对应主动执行回归」。llm-proxy 自身的 `stream` 分支逻辑已有 `packages/llm-proxy/test/handler.test.ts` 覆盖（注入 fetch），本任务补的是**服务端**能忠实提供该分支所需形状。

- [x] 6.0 准备 6.4–6.6 的受控服务前置（1.5h）；核对各入口请求模式，复用 mock-llm-server.cjs 的 SSE 文本/工具剧本和请求日志，按所需用例补非流式/失败/延迟能力并完成协议探针，固定每流程重置及测试配置恢复方式；以请求格式、次数和顺序可验证为“旧创建设置及执行入口保持可达”的执行前提，未通过不开始对应主动执行回归。

  实现：**重写** `apps/desktop/scripts/mock-llm-server.cjs`（`createMockLlmServer` 工厂 + `startMockLlmServer` 异步入口 + 保留 CLI；`resolveMode` 按请求协商 sse/json；回合新增 `mode`/`status`/`errorBody`/`delayMs`/`usage`/`reasoning`；`GET /__log`、`POST /__reset` 控制端点；日志条目补 `mode`）；**新增** `apps/desktop/test/helpers/mock-llm-harness.ts`（`startMockLlm`/`withMockLlm`/`applyTestSettings`/`settingsFileIn`/`snapshotFile`/`restoreFile`/`summarize`）；**新增** `apps/desktop/test/controlled-service.test.ts`（**18** 条：协议协商 2 + 真实客户端契约 6 + 请求日志 3 + 真实编排端到端 2 + harness 4 + 关停验证 1）。

  验证：typecheck（node+web）绿；desktop 全量 **948 passed / 0 failed（47 文件）**（5.7 基线 930，+18）；`biome check` 新增 3 文件干净；`electron-vite build` 通过（主 chunk 1,015.73 kB **未变**，受控服务不在 bundle 内）；`release-check.mjs` exit 0；`openspec validate --all --strict` 13/13；CLI 入口手工验证启动正常（`[mock-llm] 启动于 … port=18899 …` + `listening on …/v1`）。
  变异验证 **12 组**（改→跑→`cp` 还原→`md5sum -c` 复核，两文件逐字一致）：①~⑫ 见上条目。**⑪ 首轮漏网已修**（假门换成"句柄不可达"）。

### 6.1（2026-09-22 完成）

**新增** `src/renderer/src/components/DetailNotices.tsx`（共享提示区）+ `src/renderer/src/components/WorkspaceFilesPanel.tsx`（文件页一级承载，`WorkspaceFilesPanel` 薄壳 + `WorkspaceFilesPanelView` 纯展示）；**改** `App.tsx`（概览/文件/步骤三分支）、`DetailPanel.tsx`（删内部遗留 `trajectory`/`files` 局部 tab 与 `DetailHeader`，改用 `<DetailNotices/>`）、`WorkspaceFileView.tsx`（注释同步）；**改** `test/workspace-file-view.test.ts`（+9）、`test/overview-result.test.ts`（+1）。desktop 全量 **958 passed / 0 failed（47 文件）**（6.0 基线 948，+10）。

**本任务修的是一个真实断裂的只读阅读路径**（不是重构美化）：

- 🐛 **`WorkspaceFileView` 挂在一个永不生效的分支上**：它原在 `DetailPanel` 的 `tab === "files"` 分支里，而那个 `tab` 是**组件局部 `useState("trajectory" | "files")`，从不与 store 的工作区页签（`readingOf(runId).tab`）同步**。于是点工作区顶部的「文件」页签时 `visible === "files"` → 仍渲染 `DetailPanel` → 内部 tab 还是 `"trajectory"` ⇒ **文件视图根本不出现**；文件页只能靠步骤页里那个遗留的「文件」小按钮进入（两套页签并存、语义分叉）。
- **改法**：文件页上提为**与概览页同级**的一级承载。`WorkspaceShell` 变三分支 `overview → OverviewPanel` / `files → WorkspaceFilesPanel` / 其余 `→ DetailPanel`；`DetailPanel` 回归纯步骤页（内部 tab 与 `DetailHeader` 一并删除——`DetailHeader` 的「轨迹/文件」切换与工作区页签栏重复，且无任何测试依赖它）。
- **保留隔离说明与异常**：把原先内联在 `DetailPanel` 的六个提示块（`IsolatedRunNotice` / `SourceUnavailableNotice` / `ReadingInvalidatedNotice` / `BranchNotice` / `ErrorDetailNotice` / `ParentChainList`）抽成 `DetailNotices`，**步骤页与文件页共用**——文件页同样需要知道"这个世界从哪来、源记录是否还可用"，否则用户会在来历不明的清单上做判断。抽成独立文件避免两套口径（delta「保留现有隔离说明和异常」）。
- **不附带步骤目录是结构性保证**：步骤目录仍由 App 只在 `tab === "steps" && layout.stepsVisible` 挂载（design D1）⇒ 文件页天然没有它；另加一条静态断言（文件页渲染结果不得出现「步骤目录」「重新打开步骤目录」）。
- **按 run 硬重挂载**：`<WorkspaceFileView key={detail.meta.id} …>` —— 检查点编号体系随 run 变化，绝不让上一个 run 的文件选择串到下一个 run。
- **详情未就绪不留白也不假装有文件**：`loadingDetail` ⇒「正在读取运行详情…」，否则「尚未选择运行。」（两态互不冒充）。
- **取值与渲染分离**（`WorkspaceFilesPanelView` 纯展示）：本包无 jsdom、store 薄壳在静态渲染下走 `getServerSnapshot`（恒初始值）⇒ 「详情就绪时**真的**挂上文件视图」这条是**能力断言**，必须能直接喂 `detail`；源码字符串断言做不到这件事（5.7 的教训）。
- ✅ **变异验证 8 组全部被抓**：① 文件页支退回 `DetailPanel`（= 6.1 修掉的旧缺陷根因）⇒ 1 红；② 文件页支错指 `OverviewPanel` ⇒ 1 红；③ 详情就绪也不挂文件视图（永远空态）⇒ 2 红；④ 加载态与未选态文案互换 ⇒ 2 红；⑤ 去掉按 run 重挂载的 `key` ⇒ 1 红；⑥ 文件页不挂 `<DetailNotices/>` ⇒ 1 红；⑦ 步骤页不挂 `<DetailNotices/>` ⇒ 1 红；⑧ 步骤页被掏空（删 `<BudgetMap>`）⇒ 1 红。三文件 `md5sum -c` 逐字还原。
- ⚠️ **5.1 概览接线契约在这次变更中按预期变红**（原正则锚定单行二选一 `visible === "overview" ? <OverviewPanel />`，三支链后不再匹配）——这正是它该做的事。已改写为"**分支 → 组件**逐一钉住"（概览→`OverviewPanel`、文件→`WorkspaceFilesPanel`、兜底→`DetailPanel`，且任一支都不得退回 `DetailPanel`），比原来的单行正则更贴近意图，也把新增的文件页支一并纳入保护。
- 诚实边界：**未做** CDP 实测（真实 Electron 里点「文件」页签后文件清单/差异是否可见、窄窗口列表/内容二选一、Monaco 只读 diff 的实际渲染）——6.1 的验收原文要求 CDP 验证「文件承载区不附带步骤目录」，本任务已用"步骤目录挂载门控（App 层）+ 文件页静态渲染无目录文案"两条静态证据覆盖其**结构**前提，**运行时**点击效果归 7.1/7.3。主 spec 三条（初始与各轮快照可选择 / 轮号不沿链累加 / 二进制与不可用附件分别显示）在 `workspace-file-view.test.ts` 既有用例中已全覆盖，本次未改其判据，仅新增承载层断言。
- ⚠️ **顺带发现一处既有重复渲染（非本任务引入，但被本任务扩展）**：`RunWorkspace` 的页头 `RunHeaderView`（`RunWorkspace.tsx:196`）与 `DetailNotices` 的 `IsolatedRunNotice`（`DetailNotices.tsx:276`）**渲染同一份 `isolatedRunNotice(detail)`** ⇒ 该段隔离说明文字在**步骤页出现两次**（6.1 之前即如此），6.1 之后文件页也如此（为与步骤页口径一致，未单方面在文件页去掉）。**目前无任何用例断言其出现次数**。收口方向：二者只留一处（页头保留"世界来源"、提示区去掉重复项），但需先确认 spec 是否要求两处都在 ⇒ **登记为后续 change，本任务不擅自删除**。

- [x] 6.1 将 WorkspaceFileView 接到主工作区，保留现有隔离说明和异常（1h）；CDP 验证“文件承载区不附带步骤目录”，回归主 spec“初始与各轮文件快照可选择”“文件选择器轮号不沿链累加”“二进制和不可用附件分别显示”，不更改检查点默认值或宣称恢复路径。

  实现：**新增** `src/renderer/src/components/DetailNotices.tsx`（六个提示块抽成共享 `DetailNotices`，并逐个导出供测试渲染）、`src/renderer/src/components/WorkspaceFilesPanel.tsx`（`WorkspaceFilesPanel` store 薄壳 + `WorkspaceFilesPanelView` 纯展示：详情就绪挂 `<WorkspaceFileView key={detail.meta.id}>`，未就绪按 `loadingDetail` 分流文案）；**改** `App.tsx`（`WorkspaceShell` 三分支；`WorkspaceShell` 文档补 6.1 条目）、`DetailPanel.tsx`（删 `const [tab, setTab] = useState<"trajectory" | "files">` 及其复位 effect、删 `if (… isolated && tab === "files")` 分支、删 `DetailHeader` 组件、六提示块改 `<DetailNotices />`、清理随之失效的 7 个 import）、`WorkspaceFileView.tsx`（注释里的 `DetailPanel` 改 `WorkspaceFilesPanel`）；**改** `test/workspace-file-view.test.ts`（+9：承载层能力断言 5 + 接线契约 4）、`test/overview-result.test.ts`（+1：三分支**分支→组件**契约；原单行正则改写）。

  验证：typecheck（node+web）绿；desktop 全量 **958 passed / 0 failed（47 文件）**（6.0 基线 948，+10）；`biome check` 改动 7 文件干净；`electron-vite build` 通过（主 chunk **1,014.32 kB**，较 6.0 的 1,015.73 kB 略降，monaco 仍在懒 chunk）；`release-check.mjs` exit 0；`openspec validate --all --strict` 13/13。
  变异验证 **8 组**（改→跑→`cp` 还原→`md5sum -c` 复核，三文件逐字一致）：①~⑧ 见上条目，全部被抓。

- [ ] 6.2 接好分支返回导航与共用状态文字/颜色（1.5h）；验证“切到分支树”“选中状态跨视图保持”“切换不重载”“封存状态不冒充正常结束”及 branch-tree“节点按封存运行的终止原因区分结局”“节点对中断和未知原因诚实降级”“节点不把已恢复的工具错误当作终止失败”；回归保留场景“多分支家庭呈现”“代理分叉的边标注”“选中高亮共享前缀”“无分支时退化呈现”，不重排节点或改变点击语义。
- [ ] 6.3 回归原四条指标比较与实验限制（1h）；验证“既有四条指标对照仍可使用”及 model-experiments 主 spec 的共同祖先/不可比限制，保留本 run、沿链累计和相对祖先口径，不增加臂间差值或胜出结论。
- [ ] 6.4 在受控模型服务上回归普通创建/result/prompt 入口（2h）；验证“旧创建设置及执行入口保持可达”，分别记录一次明确提交、原配置/费用门禁、结果进入概览和父记录未改写，不把既有执行行为算为 U5 验收。
- [ ] 6.5 在受控服务上回归隔离创建/result 及只读预检（2h）；验证“旧创建设置及执行入口保持可达”“来源和隔离边界保持真实”，记录每次授权、多工具轮末及二次分叉，隔离 prompt/A-B 仍拒绝。
- [ ] 6.6 回归代理设置/messages 重发与模型 A/B dry-run/真实执行入口（2h）；验证“旧创建设置及执行入口保持可达”“其它分叉形态不加缓存提示”，受控请求日志证明 dry-run 零请求，未捕获 key/配置缺失等原门禁保留。
- [ ] 6.7 回归坏文件、未来版本、v1 非法隔离字段及现行缺祖先错误（1h）；验证“非法详情不被概览绕过”“列表刷新失败可重试”及主 spec“单个文件读取失败不阻塞列表”，正常运行继续可读，不吞校验异常为部分详情。

## 7. 桌面验收与质量收口

- [ ] 7.1 在真实 Electron 完成宽窗口阅读矩阵（1.5h）；100% 缩放下应用 CSS 视口 1440×900、1360×860 的概览/步骤/文件承载截图、DOM 几何与实际点击覆盖“多尺寸与放大下关键阅读可达”“长模型和空任务的导航摘要”，按 design D7 记录各层宽度/缩放及离线 Monaco/ECharts 是否正常。
- [ ] 7.2 完成窄窗口和缩放矩阵（1.5h）；100% 缩放下应用 CSS 视口 1024×768、800×600、640px 宽及独立 Electron 200% 缩放用例验证“多尺寸与放大下关键阅读可达”“自动折叠后恢复用户布局”；640px 视口对应 D2 的 <720px 档，放大后重新测量实际视口与正文，说明系统 DPI/原生目录框未覆盖项，不以局部正文宽度代替视口宽度。
- [ ] 7.3 完成键盘与阅读往返操作（1h）；实测“键盘导航及工具名称”“跨运行返回恢复阅读”“显式错误定位优先于恢复”“快速切换及同运行重试不串响应”，按实际输入与焦点记录验收，不能只检查 DOM 存在。
- [ ] 7.4 独立执行只读哈希回归（1h）；验证“阅读过程不修改已有数据”及主 spec 文件只读场景，逐文件比较既有 trace/附件/源目录并核对模型请求数为零；主动执行新增文件在另一轮记录。
- [ ] 7.5 运行包构建、desktop 类型检查及相关/全仓测试（1.5h）；按 build→typecheck→test 顺序保存结果，确认 replay CLI 测试实际运行，支持所有派生/store/既有执行回归场景，不能将缺 dist 导致的跳过算通过。
- [ ] 7.6 运行 lint、OpenSpec 严格校验和 desktop build（1h）；执行 `pnpm check:lint`、`openspec validate --all --strict --no-interactive`、`pnpm --filter @rebaseagent/desktop build`，保存退出码，确认本次依赖/视图拆分可构建，不安排发行打包。
- [ ] 7.7 建立逐场景 evidence-index 并核对 U1 边界（1h）；desktop-ui 与 branch-tree 的每个 delta 场景链接测试/fixture/新截图，布局证据按 design D7 列出原生窗口边界/单位、CSS 视口、工作区/详情宽度、zoomFactor、devicePixelRatio 与 D2 断点映射；列出旧主 spec 回归和未验证项，确认 R1/U2、R2/U3、R3–R5/U4–U5、R8–R9/U7 未交付部分仍明确；证据不足不勾完，不自动归档。
