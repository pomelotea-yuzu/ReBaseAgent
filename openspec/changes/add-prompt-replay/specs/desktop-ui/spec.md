## ADDED Requirements

### Requirement: 调试台提供启动 prompt 的单变量编辑入口

SDK / agent-loop run 的详情 SHALL 从首次 llm.call 请求中展示可编辑的 system prompt 与首条 user message。一次操作 SHALL 只允许编辑其中一项；无字符串 system 消息时整个 prompt fork SHALL 禁用，因为无法重建 RunConfig.systemPrompt。proxy run SHALL 继续显示既有 messages 重发入口，不显示 prompt replay 入口。

#### Scenario: 编辑前确认真实计费

- **WHEN** 用户修改一项启动 prompt 并准备提交
- **THEN** 界面明确提示“从头重跑，将真实调用模型并计费”“父 run 不会修改”，并在用户确认后才发起写通道

#### Scenario: system prompt 不可还原

- **WHEN** 首次 llm.call 没有字符串 system 消息
- **THEN** system prompt 与 user message 编辑入口均不可用并说明原因，界面不以 config_hash、桌面设置或空字符串填充伪值

### Requirement: prompt fork 详情呈现独立新轨迹与父级溯源

prompt fork 的详情 SHALL 呈现当前 run 自身的完整 spans，并单独列出父级 chain 与编辑字段。界面 SHALL 使用“从头重跑”描述该关系，SHALL NOT 显示“共享前缀”或把 fork.at_span 当作普通中间分叉点展示。

#### Scenario: 不混排父子轨迹

- **WHEN** prompt fork 的父 run 与子 run 都从 agent.step 1 开始
- **THEN** 子详情只出现子 run 自身的 step 1 及后续 spans，父 run 的旧路径不进入时间线
