## MODIFIED Requirements

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
- **WHEN** 带 workspace 的 run 经桌面或包 API 发起 prompt fork
- **THEN** 明确拒绝隔离执行降级，不加载普通文件 handler、不创建子 run、不发 LLM 请求
