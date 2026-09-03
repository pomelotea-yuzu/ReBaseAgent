# Proposal: add-debugger-ui

## Why

trace-sdk 能落盘、agent-loop 能跑，但产物只有一堆 JSONL 文件——**没有任何地方能"看见"一次 Agent 运行**。产品定位"不止回放，而是让你改变它"的第一步是查看：看不清轨迹，就无从谈在哪一步下刀。此为路线图第三块，也是 dogfood 的起点（作者本人要先用它看自己的 Agent）。

## What Changes

- 新增 `apps/desktop`：electron-vite 工程（main / preload / renderer 三段），Electron 壳 + React + Tailwind + zustand；**唯一碰 Electron 的包**，其余包保持零 Electron 依赖

- 数据目录与扫描：main 进程解析数据目录（便携策略：exe 旁 `portable.marker` 或用户指定；开发期指向仓库内目录），扫描 `<数据目录>/traces/*.jsonl`，经 trace-sdk `readRun` 读取

- IPC 契约：main 暴露有限通道（`runs:list` / `runs:get`），返回结构经 zod 校验；preload 用 `contextBridge` 暴露受限 API，renderer 零 `fs` 权限（`nodeIntegration: false` + `contextIsolation: true`）

- run 列表：任务名、模型、创建时间、状态徽章（`completed` / `crashed`，crashed 明确标注"进程中断"）、步数、工具调用数、错误数、token 合计、总耗时

- trace 查看器：左侧 **span 树**（`agent.step` 为节点，其下 `llm.call` / `tool.invoke` 为子节点；出错 span 标红）；右侧 **详情面板**
  - `llm.call`：request.messages 与 response（正文 / 思维链 `reasoning_content` 区别于正文展示 / tool_calls / usage / ttft_ms / 耗时）
  - `tool.invoke`：tool / args / result / error / dur_ms / 耗时

- 分支视图：分支 run 经 `resolveBranch` 展示解析后的完整轨迹（父 run 前缀 + 本 run 新增 span），并标注 fork 点（`at_span`）与编辑描述

- 派生统计：步数 / token 合计 / 耗时 / 错误数一律**从 spans 现算**，不落任何派生缓存（延续"计数从数据派生"不变量）

- **为查看补时间维度**：span 增加可选 `timing: { started_at, ended_at }`（ISO 8601），由 Tracer 在 `startSpan` / `endSpan` 时记录——见下方 Capabilities 的 Modified 项

### 从讨论定稿、本次必须落实的细节

1. **只读**：本次 UI 全程只读，不写任何 trace 文件、不修改任何 run——编辑与重跑是 Spec #4 的职责
2. **零 API 消耗**：开发期与测试期只加载 trace-sdk 的 fixtures（4 份：normal / tool-error / infinite-loop / branch），UI 不发起任何 LLM 调用
3. **预算地图与 Monaco 后置**：ECharts 上下文预算地图、Monaco 编辑器本次不做（先让"查看"可用），但查看器的组件分层需为二者预留挂载位，不写死结构
4. **SQLite 索引后置**：当前规模（数十 run、单 run 数百行）用目录扫描 + `readRun` 足够；索引属可弃派生数据，数据量上来再引入
5. **预算地图的漏斗**（来自讨论）：地图的"手术预览"（裁剪几条工具结果后 input 变多少）是通往时间旅行的自然漏斗——本次虽不做地图，但详情面板需把 `llm.call` 的 messages 完整可查（已天然满足）

## Capabilities

### New Capabilities

- `desktop-ui`：桌面调试台的查看能力——数据目录与 traces 扫描、IPC 契约、run 列表、span 树与详情视图、分支轨迹解析展示、派生统计

### Modified Capabilities

- `trace-format`：span 增加可选 `timing: { started_at, ended_at }` 字段（Tracer 在 start/endSpan 时记录，读取器宽松接受缺省）。这是为了让查看器能回答"哪一步慢"——调试器缺了耗时维度不可用。向后兼容：字段可选，老文件照常通过校验，旧读取器 strip 未知字段

## Non-goals

- 不做时间旅行 / 编辑 / fork 创建（Spec #4 replay 的职责）；分支 run 本次**只展示不创建**
- 不做 ECharts 上下文预算地图（后置，组件位预留）
- 不做 Monaco 编辑器与消息编辑（后置）
- 不做 SQLite 索引（目录扫描足够；索引为可弃派生数据）
- 不做密钥管理（safeStorage 属 Spec #4+，本次 UI 不持有任何 apiKey）
- 不在 UI 中跑 Agent：不接 agent-loop、不发 LLM 请求（零 API 消耗）
- 不做 electron-builder 打包配置（开发期 `pnpm dev` 可跑即可，打包后置）
- 不做 Playwright e2e（本次用 vitest 覆盖派生逻辑 + 手工冒烟；e2e 随打包一起补）
- 不做外部工具 / 第三方 trace 格式的导入适配（产品边界，非技术限制）
- 不改 trace 格式 v1 的版本号（`format_version` 仍为 1——新增的是可选字段，非破坏性变更）

## 边界声明（保真度）

本变更不实现重放，但查看器对数据的呈现必须守住语义，不得误导后续的时间旅行判断：

- UI 呈现的 span 树与 request.messages **即 trace 文件的原样内容**，不做采样、不截断（长文本用折叠而非丢弃）
- 分支视图是 `resolveBranch` 的解析结果：前缀来自父 run 文件（只读引用），UI 需明示"前缀来自父 run X"，不得让用户误以为分支文件自带完整轨迹
- 工具定义携带的 `sideEffect` 标注（Spec #2 为 replay 分级预埋）本次**仅原样展示**，不参与任何执行或分级判断
- `tool.invoke.error` 非空时用错误样式标注，但不改变 run 状态判定——"错误是数据不是异常"，工具失败而任务完成是合法状态
- 时间维度的边界：`timing` 缺省时（老文件 / 手工构造的 fixtures）不臆造耗时，显示为"—"

## Impact

- 新增应用：`apps/desktop`（electron-vite + React + Tailwind + zustand，均在已定稿技术栈内；依赖 `@rebaseagent/trace-sdk`）
- 修改包：`packages/trace-sdk`（schema 加可选 timing、Tracer 记录、4 份 fixtures 补齐）
- 主 spec 同步：`openspec/specs/trace-format/spec.md` 走一次小 delta（新增 Requirement），归档后与 `desktop-ui` 主 spec 并存
- 无破坏性变更：trace 格式版本号不变，老文件照常读取；新增应用不触碰既有包的行为
- 测试：派生统计与 span 树构建为纯函数，vitest 覆盖；全程零真实 API 调用
