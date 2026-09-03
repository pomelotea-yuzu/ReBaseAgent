# desktop-ui Specification

## Purpose
让用户在本地桌面上看见一次 Agent 运行的完整轨迹：从 run 列表进入，以 span 树浏览每轮迭代的 LLM 调用与工具执行，并查看任意一步的原始请求与响应。全部本地读取、只读呈现，是编辑与重跑（时间旅行）的前置。

## Requirements

### Requirement: 数据目录遵循便携策略

系统 SHALL 将所有数据置于单一数据目录内：若可执行文件旁存在 `portable.marker`，数据目录为可执行文件所在目录下的 `data/`；否则使用用户显式指定的目录。开发模式下数据目录 SHALL 指向仓库内的指定目录。系统 SHALL NOT 写入 AppData、用户主目录或注册表。trace 文件位于 `<数据目录>/traces/*.jsonl`，一文件一 run。

#### Scenario: 便携模式

- **WHEN** 可执行文件旁存在 `portable.marker`
- **THEN** 数据目录解析为 `<exe 目录>/data`，全部读写发生在该目录内，无任何其他位置被写入

#### Scenario: 未指定且非便携

- **WHEN** 无 `portable.marker` 且用户未指定目录
- **THEN** 应用提示用户选择数据目录，在选定前不创建任何文件

#### Scenario: 目录为空

- **WHEN** 数据目录存在但 `traces/` 为空
- **THEN** 列表显示空状态引导文案，不报错

### Requirement: run 列表从 traces 目录扫描派生

系统 SHALL 扫描 `<数据目录>/traces/*.jsonl`，对每个文件执行 `readRun`，并按 run 展示：任务名、模型、创建时间、状态（`completed` / `crashed`，`crashed` 需标注"运行中断"）、迭代步数、工具调用数、出错工具数、token 合计、总耗时。列表 SHALL 按创建时间倒序排列。

#### Scenario: 多份 trace 文件

- **WHEN** 目录含 normal / tool-error / infinite-loop / branch 四份 run
- **THEN** 列表呈现四行，各自显示正确的步数、token 合计与状态徽章，按创建时间倒序

#### Scenario: 崩溃的 run

- **WHEN** 某文件无终止事件（进程中断）
- **THEN** 该行状态显示为"运行中断"，其余派生字段照常展示，不视为错误

### Requirement: 单个文件读取失败不阻塞列表

系统 SHALL 隔离单个文件的读取失败：读取报错的文件 SHALL 在列表中呈现为失败条目，展示文件名与错误原因（含行号/版本信息），其余文件照常展示。

#### Scenario: 目录混入损坏文件

- **WHEN** 目录中某文件第 12 行缺少 `type` 字段
- **THEN** 列表其余行正常展示，该文件显示为失败条目并提示"第 12 行：type 为必填"

#### Scenario: 版本过高的文件

- **WHEN** 目录中某文件 `format_version` 为 2
- **THEN** 该文件显示为失败条目并提示"不支持的格式版本"，列表其余行不受影响

### Requirement: 渲染进程无文件权限且跨进程数据经校验

渲染进程 SHALL NOT 持有任何文件系统访问能力（`nodeIntegration` 关闭、`contextIsolation` 开启），只经预加载脚本暴露的受限接口获取数据；主进程返回的跨进程数据 SHALL 经 zod 校验后方可进入渲染层。

#### Scenario: 预加载接口不含文件能力

- **WHEN** 渲染层尝试访问文件系统 API
- **THEN** 该 API 不可用（未暴露），只能通过受限接口取数

#### Scenario: 主进程返回非法结构

- **WHEN** 主进程返回的数据未通过结构校验
- **THEN** 界面显示错误提示，不渲染部分数据

### Requirement: 全程只读且只呈现原样数据

系统 SHALL NOT 提供任何写入、修改或删除 trace 文件的通道；界面呈现的 span 与 messages SHALL 为文件原样内容，不做采样或截断（长内容用折叠而非丢弃）。

#### Scenario: 浏览过程无写入

- **WHEN** 用户浏览任意 run 的全部 span 与详情
- **THEN** 接口集合不含任何写类方法，trace 文件不被创建、修改或删除

#### Scenario: 超长消息

- **WHEN** 某条消息内容超过一屏
- **THEN** 内容默认折叠并可展开，展开后为完整原文，无截断省略

### Requirement: 轨迹以 span 树呈现

系统 SHALL 依据 span 的 `parent` 构建树：`agent.step` 为层级节点（标注迭代序号 `n`），其下的 `llm.call` 与 `tool.invoke` 为子节点；`tool.invoke` 的 `error` 非空时 SHALL 被显著标注为出错；用户可选中任意 span 查看详情。

#### Scenario: 三步运行的树结构

- **WHEN** 打开一个含 3 轮迭代、每轮 1 次 LLM 调用与若干工具调用的 run
- **THEN** 树呈现 3 个 `agent.step` 节点，各自展开后为其下的 llm.call 与 tool.invoke 子节点，顺序与文件一致

#### Scenario: 工具报错

- **WHEN** 某 `tool.invoke` 的 `error` 非空而 run 最终 `completed`
- **THEN** 该节点以错误样式标注，run 状态仍为已完成（错误是数据不是异常）

### Requirement: 详情面板完整展示一步的原始请求与响应

选中 `llm.call` 时系统 SHALL 展示：完整 `request.messages`、`request.tools`（若有）、`request.params`（若有），以及 `response` 的正文 `content`、思维链 `reasoning_content`（与正文区别展示）、`tool_calls`、`usage`（in/out）、`ttft_ms` 与耗时。选中 `tool.invoke` 时 SHALL 展示 `tool`、`args`、`result`、`error`、`dur_ms` 与耗时。

#### Scenario: 推理模型的思维链

- **WHEN** 选中一次带 `reasoning_content` 的 llm.call
- **THEN** 思维链以区别于正文的样式单独分区展示，两者内容均完整

#### Scenario: 工具调用详情

- **WHEN** 选中一次 tool.invoke
- **THEN** 面板展示工具名、入参、结果与耗时；`error` 非空时错误信息显式呈现

### Requirement: 分支 run 展示解析后的完整轨迹

`parent` 非空的 run SHALL 经 `resolveBranch` 解析后展示：父 run 的共享前缀（截至 fork 点，含 fork 点）与本 run 新增 span 拼接为一条连续轨迹；界面 SHALL 标注分叉点 span 与被编辑字段，并明示前缀来自哪个父 run。

#### Scenario: 分支 run 的轨迹

- **WHEN** 打开一个从父 run `s_03` 分叉的分支 run
- **THEN** 树呈现父 run 截至 `s_03` 的前缀加上本 run 新增 span，分叉点被标注，界面提示前缀所属父 run

### Requirement: 聚合数字从 spans 现算且缺失时间则降级

所有聚合数字（步数、工具调用数、出错数、token 合计、耗时）SHALL 在读取时从 spans 派生，SHALL NOT 持久化任何派生缓存。span 缺失时间区间时，耗时 SHALL 显示为"—"，不得用其他字段臆造。

#### Scenario: token 合计

- **WHEN** 打开含 3 次 llm.call 的 run
- **THEN** 列表与详情的 token 合计等于三次 usage 的 in/out 之和，且随数据变化即时反映，无缓存参与

#### Scenario: 老文件缺失时间区间

- **WHEN** 打开的 run 中 span 未记录时间区间
- **THEN** 耗时显示为"—"，其余聚合数字照常展示，不报错
