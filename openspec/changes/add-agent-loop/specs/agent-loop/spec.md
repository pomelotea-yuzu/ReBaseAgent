# Spec Delta: agent-loop

## Purpose

定义 Agent 执行循环的行为契约：如何配置一次运行、如何流式调用 OpenAI 兼容协议的 LLM、如何执行工具、何时终止，以及如何经 Tracer 输出全部观测。它是 trace 格式（Spec #1）的生产者，也是后续时间旅行/重放（Spec #4）的被观测对象。

## ADDED Requirements

### Requirement: RunConfig 定义一次运行的全部输入

`RunConfig` SHALL 包含：模型接入（`baseURL`、`apiKey`、`model`）、`systemPrompt`、工具表、采样 `params`、`exec = { cwd, signal }`（cwd 为工具执行落点，signal 为 AbortSignal）、`maxIterations`、预算上限（`maxTotalTokens` 或 `maxCost`，至少其一）。配置 SHALL 经 zod 校验，非法配置在运行开始前报错。

#### Scenario: 缺少必填配置
- **WHEN** 构造 RunConfig 时缺失 `model` 或 `exec.cwd`
- **THEN** 配置校验失败并指明缺失字段，不发起任何 LLM 调用

#### Scenario: 合法配置
- **WHEN** 提供完整字段（signal 可为 null 表示不支持中止）
- **THEN** 校验通过，run 可启动

### Requirement: Loop 为纯函数式执行循环

`runLoop` 的输入 SHALL 只有 config + messages + tracer；运行中可变状态 SHALL 仅限 messages（只追加，不修改不删除）；迭代计数与累计成本 SHALL 从 messages（含 llm.call 的 usage）派生，禁止模块级可变状态与自增累积计数器。

#### Scenario: 同输入同轨迹
- **WHEN** 相同 config 与初始 messages 在 mock LLM 下运行两次
- **THEN** 产生的 messages 演化与 Tracer 事件流一致（确定性）

#### Scenario: 历史不可变
- **WHEN** 任一迭代发生
- **THEN** 已存在于 messages 中的消息不被修改或删除，新消息只追加

### Requirement: LLM 调用走 OpenAI 兼容协议流式直连

LLM 客户端 SHALL 通过 fetch 直连 OpenAI 兼容 chat completions 端点（SSE 流式），用 eventsource-parser 解析增量；SHALL 支持 `reasoning_content`（推理模型思维链）与 `tool_calls` 的增量聚合；SHALL 请求并记录 usage（`stream_options.include_usage`）。请求失败（网络/HTTP 错误）SHALL 记为一次失败的 llm.call 并由 loop 按 `error` 终止处理，不得静默重试超过配置上限。

#### Scenario: 流式响应完整聚合
- **WHEN** 模型经多块 SSE 返回正文与 tool_calls
- **THEN** 聚合后的 response（content/reasoning_content/tool_calls/usage/ttft_ms）作为完整 llm.call span 经 Tracer 流出

#### Scenario: 请求失败
- **WHEN** 端点返回 401 或网络中断
- **THEN** loop 以 `run.event: errored`（reason: error）终止，错误信息经事件流出，messages 中已完成的轮次保持完整

### Requirement: 工具在执行上下文中运行且错误是数据

工具 SHALL 在 `exec.cwd` 落点执行；工具定义 SHALL 携带 `sideEffect` 标注（默认 true，供后续 replay 分级）；工具失败 SHALL 记录为带 `error` 的 tool_result 追加进 messages，loop 决定继续或停止——文件与循环本身不因工具错误中断。

#### Scenario: 工具报错但 loop 继续
- **WHEN** read_file 抛出 ENOENT
- **THEN** 失败以 tool_result（含 error 文本）追加进 messages，下一轮迭代照常发起

#### Scenario: 副作用标注
- **WHEN** 工具定义了 `sideEffect: false`
- **THEN** 该标注随工具表进入 trace 请求记录，replay 层可据此分级

### Requirement: 五种终止条件

loop SHALL 且仅 SHALL 在以下情况终止并写入对应 `run.event`：模型不再请求工具 → `completed`；迭代达 `maxIterations` → `max_iterations`；累计成本超预算 → `budget_exceeded`；`exec.signal` 触发中止 → `aborted`（优雅收尾：完成当前步的记录后封存，非硬杀）；loop 自身 bug → `error`（抛出异常属于实现错误的信号）。

#### Scenario: 任务完成
- **WHEN** 模型返回不含 tool_calls 的响应
- **THEN** 写入 `{ event: "stopped", reason: "completed", at: n }`，run 封存

#### Scenario: 死循环停止
- **WHEN** 迭代数达到 maxIterations
- **THEN** 写入 reason 为 max_iterations 的终止事件

#### Scenario: 用户中止
- **WHEN** 运行中 signal 被 abort
- **THEN** loop 在当前步记录完整后写入 reason 为 aborted 的终止事件，不产生半记录的 span

#### Scenario: 预算超限
- **WHEN** 派生的累计 token 超过 maxTotalTokens
- **THEN** 写入 reason 为 budget_exceeded 的终止事件

### Requirement: 观测全部经 Tracer 流出

loop 的所有观测 SHALL 经 Spec #1 的 Tracer 接口输出（agent.step / llm.call / tool.invoke / run.event），loop 不直接写文件；Tracer 由调用方注入（JsonlTracer 落盘或 NullTracer 无文件）。

#### Scenario: 无文件运行
- **WHEN** 注入 NullTracer
- **THEN** loop 正常运行至终止，事件流可被订阅断言，无文件产生

#### Scenario: 文件运行
- **WHEN** 注入 JsonlTracer
- **THEN** 产出的 trace 文件通过 trace-sdk readRun 校验，span 结构符合 trace-format spec

### Requirement: config 指纹写入 run.meta

run 启动时 SHALL 对 system prompt + 工具表定义计算 sha256 指纹作为 `config_hash` 写入 run.meta；采样参数与模型名不参与指纹（同一源代码换模型/温度属于合法对比实验）。

#### Scenario: 同源代码同指纹
- **WHEN** 两次运行使用相同 system prompt 与工具表（仅 model 或 temperature 不同）
- **THEN** 两者 config_hash 相同

#### Scenario: 源代码变化
- **WHEN** 工具表增删任一工具
- **THEN** config_hash 变化

### Requirement: 请求前缀稳定性

对相同 messages 前缀，loop 构造的 LLM 请求体 SHALL 逐字节一致（消息顺序、字段序列化稳定），使分支运行的前缀天然命中 provider 的 prompt caching。

#### Scenario: 分支前缀复现
- **WHEN** 以相同 config 与截断到第 N 步的 messages 重新构造请求
- **THEN** 请求体的 messages 序列化与前次运行第 N 步完全一致

### Requirement: 可注入的 LLM 传输层

LLM 客户端 SHALL 支持在测试中注入 mock fetch（返回编排好的 SSE 序列），使全部测试零真实 API 调用。

#### Scenario: 零 API 测试
- **WHEN** 测试注入 mock fetch 模拟多轮对话（含工具调用与错误路径）
- **THEN** runLoop 全流程可验证，无任何网络请求发出
