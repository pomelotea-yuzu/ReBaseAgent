# prompt-replay Specification

## Purpose
定义 v2 的 prompt 分叉行为：从已完成的 SDK / agent-loop run 读取首次 LLM 请求中的启动上下文，一次修改 system prompt 或首条 user message，从头真实执行一个带父级溯源的新 run。prompt fork 是显式的新实验，不是共享父前缀的同源 replay。

## Requirements

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

直接父 run SHALL 已封存、含 config_hash、首次 LLM 请求含字符串 system 消息。首期 prompt fork SHALL 拒绝带 workspace 的隔离父本并提示改用受支持的隔离 result 分叉，不得丢弃隔离元数据后执行普通 handler。

非隔离 proxy run 在具备 config_hash 时 SHALL 与普通引擎 run 同等允许；缺少 config_hash 的 proxy run SHALL 被拒绝，依 config_hash_reason 区分：no_system 指向重新录制带 system 的请求；invalid_tool 指向修正定义重发；缺因未知指向既有“编辑 messages 重发”。字符串 system 消息是重建配置的唯一来源，不能从 hash 推测原值。所有校验 SHALL 在创建文件和请求模型前完成，失败不产生半文件或调用。

#### Scenario: proxy run 拒绝
- **WHEN** 用户对 source.kind=proxy 但缺 config_hash 的 run 发起 prompt fork
- **THEN** 在文件和模型调用前拒绝，并按 no_system/invalid_tool/未知三类给出原有可操作提示

#### Scenario: 含 config_hash 的 proxy run 放行
- **WHEN** 非隔离 proxy run 已封存、含 config_hash 且首次请求有字符串 system
- **THEN** prompt fork 正常从头执行，parent 指向代理 run，同时保留独立代理重发入口

#### Scenario: 父 run 未封存
- **WHEN** 父 run 缺终止事件
- **THEN** 拒绝分叉，不创建文件、不调用模型

#### Scenario: 隔离父本不能转普通 prompt fork
- **WHEN** 带 workspace 的 run 经包 API 发起 prompt fork
- **THEN** 明确拒绝隔离执行降级，不加载普通文件 handler、不创建子 run、不发 LLM 请求

### Requirement: 启动上下文编排可观察真实运行身份

`promptReplayRun` SHALL 提供可选 `onRunIdentified`，在本次最终 run.meta 写出后、首次 LLM 调用前通知一次 ID，覆盖已支持的 system_prompt、user_message 和 model_params 调用。SHALL 保持既有父链/封存/配置与空编辑门禁、从头执行及独立轨迹语义，不新增隔离执行能力。省略或抛错的观察者 SHALL 不改变原执行结局或阻止收尾，真实 trace 写入错误 SHALL 继续传播。

#### Scenario: prompt 身份在后续失败时仍可关联

- **WHEN** 合法 system_prompt、user_message 或 model_params 调用写出 meta 后模型失败或编排抛错
- **THEN** 调用方已取得与实际新记录一致的 ID，回调恰一次，不通过解析异常取得身份，不修改父轨迹

#### Scenario: prompt 前置拒绝不报告假身份

- **WHEN** 隔离父本、缺父链、不可还原 system、空编辑或配置双真相源检查拒绝
- **THEN** 不调用身份回调，零模型调用且不创建子记录；既有隔离 prompt/model_params 拒绝不变

#### Scenario: prompt 观察者兼容且释放

- **WHEN** 省略回调或回调抛错后执行结束
- **THEN** 原执行、请求次数和文件语义保持，订阅随收尾释放，观察者不成为新增失败原因
