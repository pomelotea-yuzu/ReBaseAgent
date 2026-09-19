# replay Specification

## Purpose

定义时间旅行最小切片的行为契约：从一条已完成（封存）的 run 出发，把用户对某个 `tool.invoke` 的 `result` 的编辑应用到录制上下文上，派生"如果当时工具返回了 X，模型下一步会看到什么"的完整 messages 前缀，并以此为起点经 agent-loop 重跑，产出带 `parent` / `fork` 元数据的 fork run 文件。全程分叉点之前零 LLM 调用（截断拼接而非重放），前缀状态只读引用父 run 文件。

## Requirements

### Requirement: 从已完成 run 派生分叉状态且前缀零 API

`deriveReplayState` SHALL 接收父 run 的展开轨迹与分叉点（`at_span` + 编辑字段与值），返回重跑起点：分叉点之前最后一个 `llm.call` 的录制 `request.messages`（深拷贝）中，把被编辑的 `tool.invoke` 对应的 tool 结果消息替换为新值。实现 SHALL 是纯数据变换，SHALL NOT 发起任何 LLM 调用或网络请求。

#### Scenario: 编辑 tool_result 得到新前缀

- **WHEN** 父 run 第 2 步的 `tool.invoke`（read_file）的 result 被编辑为新内容
- **THEN** 返回的 messages 与父 run 中分叉点后首次 llm.call 的 request.messages 除该 tool 消息的 content 外逐字段一致，且该 content 为新值

#### Scenario: 前缀即录制请求

- **WHEN** 分叉点位于第 N 个 `llm.call` 之后
- **THEN** 起点 messages 逐条等于父 run 第 N 个 llm.call 的录制 request.messages（含被编辑消息的新值），未发生任何 LLM/网络调用

### Requirement: 可重放性校验

普通 `replayRun` SHALL 在启动前校验：父 run 已封存；本次 config 指纹与父 run 的 config_hash 一致；at_span 指向父 run 或其祖先中存在的 tool.invoke；编辑字段为 result。普通入口 SHALL 拒绝带 workspace 的隔离父本并引导使用隔离续跑。隔离入口 SHALL 额外要求直接父 run 自有编辑点、匹配的完整 step 检查点、固定工具 profile、显式副本写入授权及完整可验证附件。任何预检失败 SHALL 不创建运行文件、不调用模型，不退回普通工具执行。

#### Scenario: 崩溃的 run 拒绝分叉
- **WHEN** 父 run 缺终止事件（crashed）
- **THEN** 报错“只能从已完成的 run 分支”，不写运行文件

#### Scenario: 源代码变化拒绝分叉
- **WHEN** 本次 system prompt 或工具表与父 run 不同（config_hash 不一致）
- **THEN** 报错指明指纹不一致，提示换源码属新实验而非时间旅行

#### Scenario: 分叉点必须是被编辑的 tool.invoke
- **WHEN** at_span 指向非 tool.invoke 或不存在
- **THEN** 报错指明分叉点非法，不产生运行文件

#### Scenario: 普通入口不可降级隔离父本
- **WHEN** 带 workspace 的父本被传给普通 replayRun
- **THEN** 在任何工具/模型调用及子 trace 创建前拒绝；禁止只更换 cwd 或删除 workspace 后执行

### Requirement: 重跑经 agent-loop 执行并落盘 fork run

校验通过后，重跑 SHALL 以派生 messages 为初始输入，经 agent-loop 和新建 Tracer 执行；meta SHALL 写 parent/fork。普通重跑的后续工具在原配置 cwd 中执行；隔离重跑 SHALL 从匹配的轮末快照建立新文件世界，只使用受控工具。新文件仅记录后续 spans，父文件不可变；完成后返回新 id，可由 readRun/resolveBranch 正常解析。

#### Scenario: 生成分支 run 文件
- **WHEN** 对 normal fixture 编辑第 2 步 read_file 的 result 并重跑（mock LLM）
- **THEN** 新文件有正确 parent/fork，spans 从分叉点后开始，readRun 通过，普通 run 的前缀拼接不变

#### Scenario: 分支 run 再分叉
- **WHEN** 从 fork run 自身的一个合法工具点再次分叉
- **THEN** 新 parent 指向直接父，span id 沿链不冲突；隔离 run 取直接父该轮检查点，展开三层轨迹正确

#### Scenario: 父文件不可变
- **WHEN** 分叉重跑正常、LLM 失败或工具失败后结束
- **THEN** 父 run 文件逐字节不变；隔离父快照和源目录也不因子运行改变

### Requirement: 分叉点后的工具真实执行且错误是数据

新产生的工具调用 SHALL 真实执行，工具失败 SHALL 以带 error 的 tool_result 流入 messages 与 trace，loop 按既有规则继续。普通重跑使用 exec.cwd，不承诺外部文件/API 状态可回退；隔离重跑 SHALL 只在副本文件映射中执行，保真范围为受控普通文件内容，不承诺权限、时间戳、网络、数据库或任意 handler 的回退。

#### Scenario: 重跑遇工具报错
- **WHEN** 新步骤读取不存在文件或尝试非法路径
- **THEN** 工具错误入 trace，loop 可继续；隔离模式不访问源目录补救

#### Scenario: 新结果改变后续轨迹
- **WHEN** 编辑 result 且 mock LLM 按新 messages 作出不同决策
- **THEN** 子 run 的新增调用产生真实新结果；隔离写入被后续读取观察到，父及兄弟文件状态不变

### Requirement: prompt fork 与同源 tool_result replay 分流

replay 编排层 SHALL 保留既有 tool_result replay 的 config_hash 一致性校验、父前缀派生与 resolveBranch 语义；prompt fork SHALL 使用独立入口，从直接父 run 的首次 llm.call 派生启动上下文并从头运行。系统 SHALL NOT 通过放宽 replayRun 的字段类型或 config_hash 校验把两种语义合并。

#### Scenario: tool_result replay 行为不变

- **WHEN** 用户按既有流程编辑 tool.invoke.result
- **THEN** 系统仍要求 config_hash 与父 run 一致，并只记录分叉点后的新增 spans

#### Scenario: prompt fork 使用独立编排

- **WHEN** 用户编辑 system_prompt 或 user_message
- **THEN** 系统允许新 config_hash 与父 run 不同，从头记录完整 spans，且不改变 deriveReplayState 的 result-only 契约

### Requirement: 隔离根运行提供可恢复父本

系统 SHALL 支持从显式选定目录创建隔离根 run，起始 messages 沿用 system+user，固定工具组与配置指纹一致。初始文件采集完成后才 SHALL 调用 LLM；所有工具操作 SHALL 绑定新世界，轮末快照经 Tracer 流出。根 meta SHALL 为 parent/fork null、v2 workspace，不伪装为代理来源。SHALL NOT 接受任意工具 handler 或把真实源路径交给模型工具。

#### Scenario: 创建受控父本
- **WHEN** 合法源目录、模型配置和副本写入授权齐备
- **THEN** 产出含初始和轮末快照的根 run，工具表与 config_hash 对应固定 profile，源目录不变，可作隔离 result 分叉父本

### Requirement: 上下文与轮末文件状态对齐且前缀零调用

隔离 result 分叉 SHALL 复用录制 messages 并只替换指定工具结果；文件状态 SHALL 来自该工具所属整轮结束后的检查点，不取父运行最终状态。该轮原本的全部工具结果及文件效果 SHALL 保留，选中工具本身和同轮兄弟 SHALL NOT 重执行。新的首次 LLM 与工具调用 SHALL 发生在轮末之后；前缀 LLM/工具调用数均为零。

#### Scenario: 恢复历史中间文件而非最终文件
- **WHEN** 父某轮写 a=middle，后续轮写 a=after，从前一轮编辑结果并续跑
- **THEN** 子首次读 a 得到 middle，不是 after 或源目录现值；前缀没有真实 LLM 或工具调用

#### Scenario: 同轮多工具及最终轮回退路径
- **WHEN** 同轮 T1/T2 先后修改文件，编辑 T1，且该轮之后没有录制 LLM 调用
- **THEN** 消息包含该轮全部工具结果且仅 T1 被替换，文件包含 T1/T2 原效果，续跑从下一轮开始；不重做 T1/T2、不重复写入

#### Scenario: 缺检查点与祖先编辑点拒绝
- **WHEN** 请求隔离恢复旧 v1、缺快照/附件的父 run，或选择祖先共享前缀工具
- **THEN** 明确拒绝且零模型调用，不创建子 trace，不使用当前磁盘或父最终快照代替

#### Scenario: 卡带路径保持录制结果语义
- **WHEN** Trace-as-Test 对合法隔离 trace 使用匹配工具声明做卡带重跑，附件不可用
- **THEN** 仅消费录制 LLM/tool 结果，不访问文件世界或真实 handler，结构对齐不因快照元数据变化失败，报告不称其为隔离真实执行
