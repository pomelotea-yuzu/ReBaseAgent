## Purpose

定义时间旅行最小切片的行为契约：从一条已完成（封存）的 run 出发，把用户对某个 `tool.invoke` 的 `result` 的编辑应用到录制上下文上，派生"如果当时工具返回了 X，模型下一步会看到什么"的完整 messages 前缀，并以此为起点经 agent-loop 重跑，产出带 `parent` / `fork` 元数据的 fork run 文件。全程分叉点之前零 LLM 调用（截断拼接而非重放），前缀状态只读引用父 run 文件。

## ADDED Requirements

### Requirement: 从已完成 run 派生分叉状态且前缀零 API

`deriveReplayState` SHALL 接收父 run 的展开轨迹与分叉点（`at_span` + 编辑字段与值），返回重跑起点：分叉点之前最后一个 `llm.call` 的录制 `request.messages`（深拷贝）中，把被编辑的 `tool.invoke` 对应的 tool 结果消息替换为新值。实现 SHALL 是纯数据变换，SHALL NOT 发起任何 LLM 调用或网络请求。

#### Scenario: 编辑 tool_result 得到新前缀

- **WHEN** 父 run 第 2 步的 `tool.invoke`（read_file）的 result 被编辑为新内容
- **THEN** 返回的 messages 与父 run 中分叉点后首次 llm.call 的 request.messages 除该 tool 消息的 content 外逐字段一致，且该 content 为新值

#### Scenario: 前缀即录制请求

- **WHEN** 分叉点位于第 N 个 `llm.call` 之后
- **THEN** 起点 messages 逐条等于父 run 第 N 个 llm.call 的录制 request.messages（含被编辑消息的新值），未发生任何 LLM/网络调用

### Requirement: 可重放性校验

`replayRun` SHALL 在启动前校验：父 run 已封存（有终止事件，复用 `assertForkable`）；本次 config 指纹与父 run 的 `config_hash` 一致；`at_span` 指向父 run（或其祖先，沿 parent 链）中存在的 `tool.invoke` span；编辑字段为 `result`。任一不满足 SHALL 以明确错误拒绝，不产生任何文件与调用。

#### Scenario: 崩溃的 run 拒绝分叉

- **WHEN** 父 run 缺终止事件（crashed）
- **THEN** replayRun 报错"只能从已完成的 run 分支"，不写文件

#### Scenario: 源代码变化拒绝分叉

- **WHEN** 本次 config 的 system prompt 或工具表与父 run 不同（config_hash 不一致）
- **THEN** replayRun 报错指明指纹不一致，提示换源码属新实验而非时间旅行

#### Scenario: 分叉点必须是被编辑的 tool.invoke

- **WHEN** `at_span` 指向的 span 不是 `tool.invoke`（如指向 llm.call）或不存在
- **THEN** replayRun 报错指明分叉点非法，不产生文件

### Requirement: 重跑经 agent-loop 执行并落盘 fork run

校验通过后，`replayRun` SHALL 以派生 messages 为初始输入、以新建 JsonlTracer（fork run 文件）跑 `runLoop`；`run.meta` SHALL 写入 `parent`（父 run id）与 `fork`（`at_span` + `edit`）。后续步骤的工具调用 SHALL 真实执行（同权限同 cwd）。run 完成后 SHALL 返回新 run id，文件可被 `readRun` / `resolveBranch` 正常解析。

#### Scenario: 生成分支 run 文件

- **WHEN** 对 normal fixture 编辑第 2 步 read_file 的 result 并重跑（mock LLM 确定性返回）
- **THEN** 新文件首行 meta 含正确 parent 与 fork 元数据，spans 从分叉点后开始，readRun 校验通过，resolveBranch 展开后前缀与父 run 一致

#### Scenario: 分支 run 再分叉

- **WHEN** 以一条 fork run（parent 非空）为父再次分叉
- **THEN** 新 run 的 parent 指向该 fork run，resolveBranch 沿链展开三层完整轨迹

#### Scenario: 父文件不可变

- **WHEN** 分叉重跑完成
- **THEN** 父 run 文件内容与重跑前逐字节一致（只读引用，新状态全部在 fork run 文件内）

### Requirement: 分叉点后的工具真实执行且错误是数据

重跑期间新产生的工具调用 SHALL 与首次运行一样在 `exec.cwd` 真实执行；工具失败 SHALL 按既有语义（带 error 的 tool_result）流入 messages 与 trace，不中断 loop。replay SHALL NOT 承诺外部状态源（副作用写入的文件、外部 API 状态）可回退。

#### Scenario: 重跑遇工具报错

- **WHEN** 分叉点后某工具抛错（如文件已被删除）
- **THEN** 错误以 tool_result 记录，loop 照常继续至终止，trace 完整可读

#### Scenario: 新结果改变后续轨迹

- **WHEN** 编辑的 result 与原始值不同且 mock LLM 按 messages 内容做出不同决策
- **THEN** fork run 的 spans 与父 run 在分叉点后出现分歧，且分歧始于被编辑影响的那次调用
