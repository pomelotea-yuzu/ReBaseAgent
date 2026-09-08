# Trace-as-Test Specification

## Purpose

定义如何把已封存 trace 作为运行时回归测试资产，在当前 agent-loop 和当前工具声明下进行确定性卡带重跑。

## ADDED Requirements

### Requirement: 测试定义独立于 trace

系统 SHALL 支持独立 JSON 测试定义，定义版本、名称、相对 trace 路径和断言列表；路径 SHALL 相对定义文件解析；系统 SHALL NOT 修改被引用的 trace。

#### Scenario: 加载合法定义

- **WHEN** 用户执行引用已封存 v1 trace 的合法定义
- **THEN** 系统加载定义并开始卡带测试，原 trace 内容保持不变

#### Scenario: 拒绝未知版本

- **WHEN** 定义包含不支持的 `format_version`
- **THEN** 返回配置错误，不执行重跑或断言

### Requirement: 卡带重跑当前 agent-loop

系统 SHALL 将首个 `llm.call` 的 `request.messages` 作为初始 messages，将记录的 `llm.call` 响应作为卡带客户端、将记录的 `tool.invoke` 结果作为桩工具返回值，并使用当前 agent-loop 和当前用户工具声明执行一次 headless run。系统 SHALL NOT 仅对原 trace 做静态断言。

#### Scenario: 当前代码保持兼容

- **WHEN** 当前工具声明与记录协议匹配且 agent-loop 行为未改变
- **THEN** 卡带 run 完成，结构性轨迹对齐断言通过

#### Scenario: LLM 请求漂移

- **WHEN** 当前 run 发出的 LLM 请求与卡带记录不匹配
- **THEN** 系统按调用顺序消费对应卡带响应并记录 `request_drift`；卡带耗尽或存在未消费响应时才返回配置错误

### Requirement: 结构性轨迹对齐

测试 SHALL 默认比较新旧 span 的 kind、父子关系、工具名、工具参数形状、LLM tool-call 结构、顺序和终止 reason；工具桩 SHALL 按工具名和调用序号匹配记录结果；SHALL 忽略 timing、usage、ttft 和自由文本响应。该比较可作为 `trace.shape` 断言显式配置。

#### Scenario: 轨迹结构改变

- **WHEN** 当前代码少产生、增加或重排 span
- **THEN** 测试失败并定位首个不匹配的 span

### Requirement: 配置漂移可见且不复用 replay 门禁

测试路径 SHALL NOT 调用既有 `replayRun` 的 `config_hash` 同源校验；当当前配置 hash 与记录不同，测试 SHALL 继续执行但在结果中标记 `config_drift`，并展示 recorded/current 值。工具声明 SHALL 来自当前用户代码。配置漂移与请求漂移 SHALL NOT 改变测试通过与退出码；报告 SHALL 在漂移存在时建议重录基线。

#### Scenario: 修改 prompt 后测试

- **WHEN** 当前配置 hash 与记录 hash 不同
- **THEN** 卡带测试仍执行，报告包含配置漂移警告，不将结果表述为模型行为回归结论

### Requirement: 断言选择器和 run outcome 明确定义

系统 SHALL 支持 `first`、`nth`、`all` 选择器语义；缺失匹配 SHALL 失败。运行结果 SHALL 使用 `run.outcome` 并对齐 `completed`、`max_iterations`、`budget_exceeded`、`aborted`、`error` 五个 reason。

#### Scenario: 多个同名工具调用

- **WHEN** trace 含多个相同工具调用
- **THEN** 断言按显式 selector 和 quantifier 选择目标，不依赖隐含匹配顺序

### Requirement: 代理 run 的处置明确

缺少 loop 配置或 `meta.source.kind=proxy` 的 run SHALL 拒绝卡带重跑，并仅允许显式静态断言；系统 SHALL 返回清晰错误，不把单次代理响应伪装成运行时回归测试。

#### Scenario: 代理录制 run

- **WHEN** 测试定义引用 `meta.source.kind=proxy` 的 trace 并请求卡带重跑
- **THEN** 系统拒绝重跑并返回清晰配置错误；只有显式静态断言路径可以继续

### Requirement: CI 集成和隐私边界

核心 API SHALL 可由 Vitest/Jest 直接调用；CLI SHALL 支持单定义或定义目录，并返回 `0=passed`、`1=assertion failed`、`2=configuration/error`。报告 SHALL 包含失败定位和 config drift；敏感字段 SHALL 默认脱敏/截断，文档 SHALL 警告 trace 可能包含完整 prompt、响应和工具参数。

#### Scenario: CI 运行通过

- **WHEN** 定义目录中的所有卡带测试均通过
- **THEN** CLI 返回退出码 `0` 并输出包含每个定义状态的稳定 JSON 报告

### Requirement: 结构对齐基线可控

结构性轨迹对齐 SHALL 默认开启；系统 SHALL 支持通过重新录制 trace 或显式 `--update-baseline` 更新基线，SHALL NOT 在测试失败时静默覆盖原测试资产。

#### Scenario: 新增合法 span

- **WHEN** 当前实现新增一个合法但未记录的 span
- **THEN** 默认测试失败并报告结构差异；仅显式更新基线后才接受新轨迹

### Requirement: 既有能力兼容

实现 SHALL 保持 trace v1、既有 replay、桌面 IPC 和 replay 的 `config_hash` 门禁不变，并复用既有 trace 读取器而不新增第二套 JSONL 解析器。

#### Scenario: 既有 replay 回归

- **WHEN** 新增测试能力后执行现有 replay 测试
- **THEN** replay 的 config_hash、父链和真实工具执行语义保持不变
