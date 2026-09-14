# prompt-replay Delta: 代理 run 作为 prompt fork 父本

## MODIFIED Requirements

### Requirement: prompt fork 的可用父本与失败原子性

直接父 run SHALL 已封存、含 config\_hash、首次 LLM 请求含字符串 system 消息。proxy 来源的 run 在具备 `config_hash` 时 SHALL 与引擎 run 同等允许作为父本；缺少 `config_hash` 的 proxy run SHALL 被拒绝，错误信息 SHALL 依 `meta.config_hash_reason` 区分缺因：`no_system` → 说明首次请求无字符串 system 消息并指向重新经代理录制带 system 的请求；`invalid_tool` → 说明工具表无法解析并指向修正工具定义后重发；缺因未知（历史文件无该字段）→ 说明无法派生指纹并指向既有「编辑 messages 重发」入口。字符串 system 消息是重建 RunConfig.systemPrompt 的唯一来源；仅有 config\_hash 不足以还原原值。所有校验 SHALL 在创建新文件与发起模型请求前完成；任一校验失败 SHALL 不产生半文件、不发起调用。

#### Scenario: proxy run 拒绝

- **WHEN** 用户对 source.kind=proxy 但 meta 缺少 `config_hash` 的 run（含历史代理 trace）发起 prompt fork

- **THEN** 系统在创建文件与调用模型前拒绝；错误信息 SHALL 依 `meta.config_hash_reason` 区分缺因——`"no_system"` 时说明首次请求无字符串 system 消息并指向重新经代理录制带 system 的请求，`"invalid_tool"` 时说明工具表无法解析并指向修正工具定义后重发，缺该字段（历史文件）时指向既有「编辑 messages 重发」入口

#### Scenario: 含 config_hash 的 proxy run 放行

- **WHEN** 用户对 source.kind=proxy、已封存、meta 含 `config_hash` 且首次 llm.call 含字符串 system 消息的 run 发起 system prompt fork

- **THEN** fork 正常从头真实执行，子 run 的 parent 指向该代理 run，fork 元数据与引擎父本产物的形状一致；代理父本同时保留「编辑 messages 重发」入口，两条通道互不影响

#### Scenario: 父 run 未封存

- **WHEN** 父 run 缺少终止事件

- **THEN** 系统拒绝分叉，不创建文件、不调用模型
