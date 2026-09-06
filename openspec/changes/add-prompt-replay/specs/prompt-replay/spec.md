## Purpose

定义 v2 的 prompt 分叉行为：从已完成的 SDK / agent-loop run 读取首次 LLM 请求中的启动上下文，一次修改 system prompt 或首条 user message，从头真实执行一个带父级溯源的新 run。prompt fork 是显式的新实验，不是共享父前缀的同源 replay。

## ADDED Requirements

### Requirement: 启动上下文从首次 LLM 请求确定性派生

系统 SHALL 只从直接父 run 自身的首次 llm.call.request.messages 读取可编辑启动上下文。system prompt 为其中第一条 role=system 且 content 为字符串的消息；初始用户指令为其中第一条 role=user 且 content 为字符串的消息。系统 SHALL 深拷贝 messages 后替换目标，SHALL NOT 修改父记录。

#### Scenario: 编辑 system prompt

- **WHEN** 父 run 首次 llm.call 含字符串 system 消息，用户提交不同的新内容
- **THEN** 派生 messages 仅该消息的 content 变化，其余消息逐字段一致，父 run 内容不变

#### Scenario: 编辑首条 user message

- **WHEN** 父 run 首次 llm.call 含多条 user 消息
- **THEN** 只允许编辑第一条 role=user 且 content 为字符串的消息，不需要消息索引元数据

#### Scenario: 缺少 system 消息

- **WHEN** 父 run 首次 llm.call 不含字符串形式的 system 消息
- **THEN** system prompt 与 user message 两种 prompt fork 均被明确拒绝；系统不从 config_hash 反推、不从桌面设置猜测、也不凭空假定空字符串

### Requirement: 一次分叉只修改一个变量

prompt fork 的 edit.field SHALL 且仅 SHALL 为 system_prompt 或 user_message，单次请求 SHALL 只携带其中一个字段与一个字符串新值。编辑前后相同 SHALL 作为空 fork 拒绝。组合实验 SHALL 通过连续 fork 表达。

#### Scenario: 同时修改两个字段

- **WHEN** 请求试图同时修改 system prompt 与 user message
- **THEN** 系统在创建文件和调用模型前拒绝，并提示一次分叉只允许修改一个变量

#### Scenario: 连续 prompt fork

- **WHEN** 先从 A 修改 system prompt 得到 B，再从 B 修改首条 user message 得到 C
- **THEN** C 的 parent 为 B，启动上下文取自 B 自身首次 llm.call，B 与 A 文件均不改变

### Requirement: prompt fork 从头真实执行并独立记录完整轨迹

校验通过后，系统 SHALL 从 agent.step 1 开始真实调用模型并执行新 run，所有新 spans SHALL 完整写入新文件。新 run 的 parent SHALL 指向直接父 run；fork.at_span SHALL 为直接父 run 的首次 llm.call id；fork.edit SHALL 记录单项编辑。父 run 只作溯源，不作为新 run 的共享轨迹前缀。

#### Scenario: 从头重跑

- **WHEN** 用户确认一项合法 prompt 编辑
- **THEN** 系统提示“将真实调用模型并计费”，新 run 从第 1 步执行并记录完整 spans，不承诺命中父 run 的 prompt cache

#### Scenario: prompt fork 不拼接父轨迹

- **WHEN** 打开一个 prompt fork 的详情
- **THEN** 详情只呈现新 run 自身的完整 spans，同时单独展示父级 chain；不得经 resolveBranch 拼入父 run 的旧 spans

### Requirement: system prompt 的配置指纹与实际请求一致

system prompt fork SHALL 使用同一个编辑值同时更新本次 RunConfig.systemPrompt 与启动 messages 中的 system content。新 run 的 config_hash SHALL 由该值与原工具表计算，首次 llm.call.request.messages 中 SHALL 出现完全相同的 system content。

#### Scenario: 双真相源保持一致

- **WHEN** system prompt 从 A 修改为 B 后运行
- **THEN** 新 run 的 config_hash 按 B 计算，首次真实 LLM 请求中的 system content 也为 B，不得出现指纹输入与实际请求不一致

### Requirement: prompt fork 的可用父本与失败原子性

直接父 run SHALL 已封存、含 config_hash、首次 LLM 请求含字符串 system 消息、且非 proxy 来源。字符串 system 消息是重建 RunConfig.systemPrompt 的唯一来源；仅有 config_hash 不足以还原原值。所有校验 SHALL 在创建新文件与发起模型请求前完成；任一校验失败 SHALL 不产生半文件、不发起调用。

#### Scenario: proxy run 拒绝

- **WHEN** 用户对 source.kind=proxy 的 run 发起 prompt fork
- **THEN** 系统拒绝并指向既有“编辑 messages 重发”入口

#### Scenario: 父 run 未封存

- **WHEN** 父 run 缺少终止事件
- **THEN** 系统拒绝分叉，不创建文件、不调用模型

## 边界声明（保真度）

- prompt fork 只保证新启动上下文被实际发送并产生完整新 trace；外部文件、数据库、RAG、记忆与 API 状态不回退。
- 分叉点后的工具按现有 agent-loop 权限真实执行，失败继续作为 tool_result 数据进入轨迹。
- prompt fork 从头计费，不承诺复用父 run 的 provider prompt cache。
