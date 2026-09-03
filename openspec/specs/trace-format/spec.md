# trace-format Specification

## Purpose

定义 ReBaseAgent trace 数据格式 v1（JSONL，一 run 一文件）：Agent 运行的可回放记录标准，是查看、预算地图、时间旅行与 Trace-as-Test 的共同地基。

## Requirements

### Requirement: trace 文件为 JSONL 且一 run 一文件

系统 SHALL 将一次 Agent 运行（run）的全部记录写入单个 JSONL 文件，文件内每行为一个 JSON 对象，行类型为 `run.meta`（首行）、`span`（若干）、`run.event`（0 或多个，含终止事件）。

#### Scenario: 正常完成的 run
- **WHEN** 一次 run 正常结束
- **THEN** 文件首行为 `run.meta`，末尾存在 `run.event`（`event: "stopped"`）行
- **AND** 全部行按发生顺序追加，无插入、无修改

#### Scenario: 崩溃的 run
- **WHEN** 进程在 run 中途崩溃
- **THEN** 已写入的行保持完整（无半行 JSON），文件缺失终止事件——读取器 SHALL 将其识别为 `crashed` 状态而非报错

### Requirement: 格式带版本号

`run.meta` 行 SHALL 包含 `format_version` 整数字段；当前版本为 `1`。读取器遇到更高版本 SHALL 明确报"不支持的格式版本"，不得静默降级解析。

#### Scenario: 未来版本文件
- **WHEN** 读取 `format_version: 2` 的文件
- **THEN** 报错提示版本不支持，不产生部分解析结果

### Requirement: 三种 span kind 与结构

span SHALL 为以下三种 kind 之一，构成树（`parent` 指向父 span id，根 span 的 parent 为 null）：

- `agent.step`：一轮 loop 迭代，含序号 `n`
- `llm.call`：一次 LLM 调用，`request` 原样录制完整请求（messages、tools、params、model），`response` 含 `content`、`reasoning_content`（推理模型，可为 null）、`tool_calls`、`usage`、`ttft_ms`
- `tool.invoke`：一次工具执行，含 `tool`、`args`、`result`、`dur_ms`、`error`（null 或错误信息）

#### Scenario: 推理模型的响应
- **WHEN** 模型返回 `reasoning_content`（思维链）
- **THEN** `llm.call` 的 `response.reasoning_content` 完整保存，UI 侧可区别于正文展示

#### Scenario: llm.call 的完整请求录制
- **WHEN** 重放引擎需要回到第 N 步
- **THEN** 第 N 个 `llm.call` span 的 `request.messages` 可直接作为 loop 输入使用（查表，无需重建）

### Requirement: 错误是数据不是异常

工具执行失败 SHALL 记录为 `tool.invoke` span 的 `error` 字段（非 null），loop 决定继续或停止；文件本身不因工具错误而中断。

#### Scenario: 工具报错但任务完成
- **WHEN** 第 2 步 read_file 失败（error 非空）而 Agent 换用其他工具后完成
- **THEN** trace 完整记录失败 span 与后续步骤，读取器不视为 run 失败

### Requirement: run 级终止事件

run 的结束 SHALL 由 `run.event` 行表达，`reason` 枚举至少包含：`completed`、`max_iterations`、`budget_exceeded`、`aborted`（用户取消）、`error`（不可恢复错误）。

#### Scenario: 死循环被停止
- **WHEN** loop 达到最大迭代数
- **THEN** 写入 `{ "type": "run.event", "event": "stopped", "reason": "max_iterations", "at": 25 }`，文件封存

### Requirement: 分支用 fork 元数据表达

分支 run 的 `run.meta` SHALL 含 `parent`（父 run id）与 `fork` 对象（`at_span`：分叉点 span id；`edit`：编辑描述，含被修改字段与新值）。分支文件 SHALL 只记录新增 span，前缀经 `parent` 链共享（copy-on-write）。

#### Scenario: 编辑工具结果后分叉
- **WHEN** 用户编辑 r_01 中 s_04 的 tool_result 并从该步重跑
- **THEN** 新文件 r_02 的 meta 含 `fork: { at_span: "s_04", edit: { field: "result", value: ... } }`，文件内只有新增 span

### Requirement: 文件不可变与分支/删除保护

系统 SHALL 保证：run 终止事件写入后文件不再被任何路径修改；只能从已封存（有终止事件）的 run 创建分支；存在子分支的 run 被请求删除时 SHALL 拒绝并提示子分支数量。

#### Scenario: 对已封存文件追加
- **WHEN** 任何代码路径尝试向已含终止事件的文件追加行
- **THEN** API 抛出明确错误，文件保持不变

#### Scenario: 删除有子分支的 run
- **WHEN** 用户删除 r_01，而 r_02 的 parent 指向 r_01
- **THEN** 删除被拒绝，提示"有 1 个分支引用此 run"

### Requirement: Tracer 为事件流且是唯一观测出口

SDK SHALL 提供 `Tracer` 接口（startRun / startSpan / endSpan / endRun），实现为可订阅的事件流；文件写入只是其中一种实现（`JsonlTracer`）。Agent loop 的所有观测 SHALL 经 Tracer 流出，不直接写文件。

#### Scenario: 无文件运行
- **WHEN** CI 中使用 `NullTracer`（或内存订阅者）
- **THEN** loop 正常运行，无文件产生，事件可被断言捕获

### Requirement: 读取器逐行校验

`readRun` SHALL 对每行执行 zod 校验，遇到不合法行 SHALL 报错并指明行号与原因，不得静默跳过。

#### Scenario: 手工篡改的文件
- **WHEN** 某行缺少 `type` 字段
- **THEN** 读取报错"第 N 行：type 为必填"，不返回部分结果

### Requirement: span 可记录墙上时钟区间

span 行 SHALL 支持可选 `timing` 对象，含 `started_at` 与 `ended_at`（ISO 8601 字符串，成对出现、不可只写其一）：Tracer 在 `startSpan` 时记录起始时刻，`endSpan` 落盘该行时一并写入终止时刻。读取器 SHALL 接受缺失 `timing` 的 span（老文件与手工构造数据合法），不得报错或以其他字段推断。

#### Scenario: 新产出的 span 带时间区间

- **WHEN** 一次运行中开启 span 并在 120ms 后结束
- **THEN** 落盘的 span 行含 `timing.started_at` 与 `timing.ended_at`，两者之差约为 120ms

#### Scenario: 缺失时间区间的老文件

- **WHEN** 读取一份 span 无 `timing` 字段的 trace 文件
- **THEN** 校验通过，读取结果中这些 span 无 `timing`，调用方须按"时间未知"处理
