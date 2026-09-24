# ReBaseAgent 开发复盘：TRAE 两次对话（MVP 1–5 交付）

> 工程复盘总结。记录项目在 TRAE 中两次对话的工作内容——第一次对话交付时间旅行 MVP（Spec #1–#4），第二次对话补齐预算地图与代码编辑器（Spec #5）并完成交接收尾。面向后续接力者与回顾用，客观记录变更、决策、质量与坑。

- 项目：ReBaseAgent — Agent 的时间旅行调试器（本地优先 Electron 桌面应用）
- 定位：不止回放 Agent 做了什么，而是让你改变它做了什么；数据不出本机。
- 概念内核：上下文是 Agent 行为的程序（Context is the program）。
- 工作流：openspec spec-driven（propose → apply → archive），全部产出中文。

---

## 一、总体演进

```text
init → #1 trace-sdk → #2 agent-loop → #3 desktop-ui 查看 → #4 replay 时间旅行切片 → #5 预算地图 + Monaco
       └────────────── 第一次对话（MVP 核心）────────────────┘  └──── 第二次对话（MVP 补齐 + 收尾）────┘
```

| 对话 | 交付 Spec | 主题 | 结束点 |
|---|---|---|---|
| 一 | #1–#4 | 轨迹格式 / Agent 循环 / 调试台查看 / 时间旅行最小切片 | commit `f2e6c39` |
| 二 | #5 + 收尾 | 上下文预算地图（ECharts）+ Monaco 编辑器 + 交接文档更新 | commit `7614321`，双远程 push |

---

## 二、第一次对话：时间旅行 MVP（Spec #1–#4）

### 2.1 目标

前三块解决"录制与查看"：trace-sdk 定义格式、agent-loop 产生 trace、desktop-ui 让人**看见**一次运行。第四块兑现产品核心承诺——"不止回放，而是让你改变它"。MVP 三要素（查看 + 上下文预算地图 + 时间旅行切片）中，时间旅行切片为灵魂。

### 2.2 交付内容

- **Spec #1 add-trace-format-sdk**：JSONL 格式 v1（一 run 一文件、append-only）。span 三种 kind（agent.step / llm.call / tool.invoke）构成树；`run.meta` / `run.event` 终止事件；`readRun` 逐行 zod 校验、文件不可变、`resolveBranch` 分支解析。支持可选 `timing` 时间区间。
- **Spec #2 add-agent-loop**：`runLoop` 纯函数四不变量（输入只有 config+messages、可变状态仅 messages 追加、计数从数据派生、无模块级状态）；LLM 失败不重试；OpenAI 兼容直连（fetch + SSE）；工具错误渲染进 `tool_result`（错误是数据）。
- **Spec #3 add-debugger-ui**：Electron 三段（main/preload/renderer）；三栏 UI（RunList / SpanTree / DetailPanel）；IPC 统一信封 + 共享 zod schema；`resolveBranch` 合并轨迹 + 分支标注；safeStorage 密钥加密；CJS 输出与 dev launcher 防 `ELECTRON_RUN_AS_NODE` 继承。
- **Spec #4 add-replay**：`packages/replay` 时间旅行最小切片。`deriveReplayState`（叶优先定位）+ `replayRun`；核心洞察——**前缀零 API = 截断拼接，不需重放**（取分叉点前最后一个 llm.call 的录制 `request.messages`，替换被编辑的 tool_result 即得完整上下文）；`runLoop` 增第 6 参 `forkRun`；desktop 只增 `runs:fork` 一个写通道；ForkEditor "在此重跑"。真实工具重跑错误是数据。

### 2.3 关键设计决策（勿重新讨论）

- 前缀零 API = 截断拼接（不是字节级重放）：前缀与父 run 请求逐字节一致，天然命中 provider prompt caching。
- `config_hash` 校验在编排层：只覆盖 system prompt + 工具表，不一致拒绝 fork（换源码 ≠ 时间旅行）。
- 编辑目标 `tool.invoke.result` 字段（MVP 边界，prompt 编辑归 v2）。
- 只从已封存（completed）run 分叉；父 run 可以是分支 run（链式三层分叉）。
- safeStorage + 明文降级（Linux 无 keyring）。
- trace-format 无格式变更（fork 字段本就有）。

### 2.4 质量门（交付时）

- trace-sdk 60/60 · agent-loop 48/48 · replay 15/15 · desktop 37/37（均值增长见第五节）。
- 全仓自动化测试零真实 API（fetch 全 mock）；真调只在用户手工冒烟。
- 踩坑：Electron 系宿主继承 `ELECTRON_RUN_AS_NODE=1` 致 `require("electron")` 返回路径字符串——用 dev launcher 清除该变量修复（根因：该模式下 electron 按纯 Node 跑，内建模块未注册）。

---

## 三、第二次对话：预算地图 + Monaco（Spec #5）与收尾

### 3.1 目标

MVP 三块缺最后一块——**上下文预算地图**（Spec #3 明确"ECharts 后置"，仅留挂载位）；同时时间旅行的编辑器仍是 `<textarea>`，与"上下文即程序"的定位不符。二者合为 MVP 最后欠账，也是"更可视化"方向的第一批落地。

### 3.2 交付内容

- **trace-format（向后兼容）**：`run.meta` 增**可选** `budget: { max_total_tokens }`，不改 format_version；agent-loop `startRun` 依 `config.budget.maxTotalTokens` 转录（未声明则省略）。让"预算"成为 run 文件自包含的事实源。
- **上下文预算地图（ECharts）**：`shared/derive.ts` 增纯函数 `deriveBudgetSeries`（沿 llm.call 累计 in+out，口径与 loop 的 `deriveTotalTokens` 一致）；`BudgetMap.tsx` 挂 DetailPanel 顶部（run 级折叠区块，展开才懒加载 echarts，按需注册折线所需模块）；累计曲线 + `markLine` 参考线 + `budget_exceeded` 超限标红 + 点击数据点联动 `selectedSpanId`。
- **Monaco 编辑器**：ForkEditor 的 `<textarea>` → `@monaco-editor/react` `<Editor>`，仅编辑态挂载（懒加载）；`main.tsx` 顶层 `loader.config({ monaco })` 离线自托管（不拉 CDN，保"数据不出机器"）；JSON/plaintext 语言嗅探；`unchanged` 空 fork 防线、`inProgress` 禁用、`runs:fork` 请求体全不变。
- **收尾继承**：交接文档更新（新增"更可视化"接力提醒，多智能体接力项目）；中文 commit `7614321`；push github + gitee。

### 3.3 关键设计决策

- 预算参考线来自 **trace 内 budget**（而非 UI 局部参数）——参考线与 run 绑定，换机器/对比分支都可见，且为未来"手术预览"鋪路。
- 预算曲线是纯函数、从数据现算、无缓存（延续"计数从数据派生"不变量，编辑后不需按缓存）。
- 大数据依赖全量懒加载：echarts 按需注册、Monaco 编辑态才挂载；budget option 装配抽为 `lib/budget.ts` 纯函数便于单测。
- IPC 零改动：`RunDetail.meta` 复用 `RunMetaSchema`，budget 自动透传。
- 老 run 无 budget → 地图只曲线、无参考线（诚实不编造）。

### 3.4 质量门

- trace-sdk 62/62 · agent-loop 52/52 · desktop 46/46（含 deriveBudgetSeries 3 例、buildBudgetMapOption 6 例）· biome 0 errors · 双端 typecheck · electron-vite 三段构建通过。
- 新增依赖：`echarts`、`monaco-editor`、`@monaco-editor/react`（均为 config.yaml 已定稿技术栈，懒加载）。

---

## 四、演进中的一以贯之

跨两次对话反复遵守的工程纪律：

1. **JSONL 是唯一事实源**：一切聚合（步数/token/耗时/预算）从数据现算、不落缓存；run 完成后封存、只从已封存 run 分支。
2. **错误是数据不是异常**：工具失败进 `tool_result`，loop 只抛自身 bug。
3. **诚实呈现**：缺数据（无 budget / 无 timing）就显式标注"未知"，不臆造。
4. **大依赖懒加载**，本地优先、数据不出机器。
5. **openspec 全程**：proposal 必含 Non-goals 与保真度边界；实现发现设计有误先回 proposal 修订。

## 五、质量门汇总（最终值）

| 组件 | 测试 | 说明 |
|---|---|---|
| trace-sdk | 62 | schema / reader / branch / fixtures / timing / tracer |
| agent-loop | 52 | run-loop / config / fork-run / e2e |
| replay | 15 | deriveReplayState / replayRun |
| desktop | 46 | derive / data-dir / run-repository / settings / fork-runner / store / budget-map |
| 静态 | biome 0 errors · 双端 typecheck · electron-vite build ✓ | |

---

## 六、下一步（未启动）

**v2 完整时间旅行**，并把「更可视化」作为默认设计原则：编辑 prompt、多分支对照实验、预算地图"手术预览"漏斗（裁剪工具结果 → 实时预览 token 省多少 / 是否还超线）。