# Proposal: add-context-budget-map-monaco

## Why

MVP 路线图三块「查看 / 上下文预算地图 / 时间旅行最小切片」，前两块（查看、replay 切片）已落地，唯独**上下文预算地图**因 Spec #3 明确"ECharts 后置"而仍是空挂载位。与此同时，时间旅行（Spec #4）的 core 编辑器目前是原生 `<textarea>`，编辑体验是"裸文本"，与产品以"上下文即程序"为透镜的定位不匹配。两者合起来是 MVP 最后一块欠账：**让调试者既看得见 token 预算怎么烧掉的，也能在舒适的编辑器里改它**。

## What Changes

- **trace-format（向后兼容）**：`run.meta` 新增**可选** `budget` 字段，记录源配置的 `config.budget.maxTotalTokens`。
  - 老文件（无该字段）照常解析、照常显示，读取器一律 Optional，不改 `format_version`
  - 目的：让"预算"成为 run 文件自包含的事实源——参考线不靠 UI 记忆，换机器/对比分支都能看到该 run 自己的预算
- **agent-loop（录制端）**：`startRun` 写入 meta 时把 `config.budget` 一并落盘（缺省时 budget 字段省略，保持可选语义）
- **desktop-ui（上下文预算地图，ECharts）**：派生层新增纯函数把 run 的 span 序列化为"累计 token 趋势"数据 + 预算参考线；DetailPanel 挂 ECharts 曲线（懒加载），选中曲线数据点 ↔ 联动 `selectedSpanId`；`budget_exceeded` 终止标记超限点
- **desktop-ui（Monaco 编辑器）**：把 ForkEditor 内编辑 `tool.invoke.result` 的 `<textarea>` 替换为 Monaco（懒加载），保持既有 fork 语义与 `runs:fork` 通道不变，仅替换文本编辑控件

## Capabilities

### New Capabilities

（无。本变更不引入新能力领域，均在既有能力上做 delta）

### Modified Capabilities

- `trace-format`：`run.meta` 新增可选 `budget` 元数据（`max_total_tokens`），向后兼容、不改版本号
- `desktop-ui`：DetailPanel 新增上下文预算地图（ECharts，累计 token 趋势 + 预算参考线 + 数据点联动选择）；ForkEditor 的 result 编辑器由 textarea 换成 Monaco，fork 交互语义不变

## Non-goals

- **不做"手术预览"漏斗交互**（点某条工具结果、实时预览"裁剪后 input 少多少 token、是否仍超预算"）：裁剪本质是编辑历史的一种，属 v2 完整时间旅行；本次预算地图只做**查看型**趋势 + 参考线 + 选择联动
- **不做分支/多 run 的预算对比视图**（diff 谁烧得多）：v2
- **不做模型上下文窗口自动映射**：参考线严格取 trace 内 `budget.max_total_tokens`；UI 不提供"改预算线"入口（预算属于 run 事实源，不被查看器篡改）
- **不新增依赖之外的技术**：ECharts / Monaco 均已在 config.yaml 技术栈定稿（懒加载），不引入新库
- **不改 format_version、不做任何破坏性格式变更**：budget 仅新增可选字段；`deriveStepStats` / `deriveRunSummary` 等既有派生不变
- **Monaco 只替换 `tool.invoke.result` 编辑控件**：不做完整 prompt / llm.call 请求编辑器（v2）
- **不改 replay 的执行语义**：Monaco 替换不影响 fork 重跑流程，后者行为与 Spec #4 完全一致

## 边界声明（保真度）

本变更**不新增任何工具执行**，故不扩大时间旅行的保真度承诺；只对只读可视化与文本编辑控件做增强：

- 预算地图与参考线全部来自 trace 内已封存数据（spans + 可选 budget），纯派生、不发起任何 LLM 调用、不写任何文件；选中的数据点仅联动 UI 选择态
- Monaco 仅替换按钮的文本输入控件，不改变 `runs:fork` 的请求体、`deriveReplayState` 的截断拼接、分叉点校验等任何既有 fork 逻辑；`sideEffect` 标注仍随请求体原样透传、不参与执行判定（与 Spec #4 一致）
- 老 trace 无 `budget` 字段时，预算地图照常绘制累计趋势，仅参考线不显示（诚实：该 run 的事实源里没有预算，就不编造一条线）——不静默回退到 UI 猜测值
- 只读阶段的桌面包行为不变（浏览/派生统计/选择联动均是既有能力之上的增量）

## Impact

- 修改包：`packages/trace-sdk`（`RunMetaSchema` 增可选 `budget`，导出类型；README 字段表同步）、`packages/agent-loop`（`startRun` 录制 budget）、`apps/desktop`（IPC 元数据透传、派生层预算序列、ECharts 组件、ForkEditor 换 Monaco、渲染层挂载位填充）
- 新增依赖（desktop 运行时）：`echarts`、`monaco-editor` 均按 config.yaml 定稿（懒加载）；另增 `@monaco-editor/react` 作为 Monaco 的 React/Loader 编排 wrapper——显式理由：electron-vite 下手写 Monaco worker/Loader/路径集成极易踩坑且难维护，该 wrapper 统一接管并使离线自托管可控（详见 design.md D4）。均只在 desktop 包，不改技术栈
- 测试：trace-sdk 增 schema 用例（budget 可选、缺省解析、`format_version` 不变）；desktop 增预算序列化纯函数用例、ForkEditor/Monaco 渲染不回归；agent-loop 录制端 meta 含/缺 budget 两态
- 主 spec 同步：`openspec/specs/trace-format`、`openspec/specs/desktop-ui` 各加 delta
- 无破坏性变更：既有 run 文件、既有读路径、既有测试全部不受影响