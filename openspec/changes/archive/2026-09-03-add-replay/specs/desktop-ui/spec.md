## ADDED Requirements

### Requirement: 分叉重跑是唯一的显式写路径

系统 SHALL 提供 `runs:fork` 写通道：请求体 = `{ parentRunId, atSpanId, edit: { field, value } }`，main 侧加载父 run、校验可重放性、执行重跑，返回新 run id。该通道 SHALL 是 renderer 侧唯一能触发文件写入的方法，且每个请求 SHALL 携带用户明确选择的 `atSpanId` 与编辑值（不允许无编辑的"空 fork"）。浏览、列表、详情等既有路径保持零写能力。

#### Scenario: 编辑 tool_result 并重跑

- **WHEN** 用户在详情面板选中一个 `tool.invoke` span，编辑其 result 并确认重跑
- **THEN** 界面出现进行中状态；完成后列表刷新并自动选中新 run（分支 run 经 resolveBranch 展示合并轨迹，分叉点被标注）

#### Scenario: 非法请求被拒绝

- **WHEN** atSpanId 不存在、父 run 未封存、或编辑字段非 result
- **THEN** 界面显示错误原因（来自信封 error），不产生新 run

#### Scenario: 空 fork 被拒绝

- **WHEN** 用户未修改编辑值即提交
- **THEN** 请求被拒绝（编辑前后值相同视为无操作），不产生新 run

### Requirement: 运行配置（LLM 接入）经 safeStorage 持久化

系统 SHALL 提供运行配置入口：baseURL / apiKey / model。apiKey SHALL 优先经 Electron safeStorage 加密后写入数据目录（不落 AppData/注册表）；safeStorage 不可用（如 Linux 无 keyring）时 SHALL 降级明文存储并向用户明示风险。未配置时点击"重跑"SHALL 提示先配置，不发起调用。

#### Scenario: 配置后重跑可用

- **WHEN** 用户填写 baseURL/apiKey/model 并保存
- **THEN** apiKey 以加密形式存在于数据目录，重跑使用该配置发起真实调用

#### Scenario: 未配置时提示

- **WHEN** 尚未配置运行参数即点击重跑
- **THEN** 界面提示先完成运行配置，不发任何网络请求

### Requirement: fork 的 config 与父 run 同源

发起分叉时，系统 SHALL 使用与父 run 相同的 system prompt 与工具表（config_hash 一致）执行重跑；若用户修改了运行配置中的系统提示或工具而 config_hash 不再匹配，SHALL 拒绝并提示"源码变化不属于时间旅行"。

#### Scenario: 同源重放

- **WHEN** 运行配置与父 run 同源（未改 system prompt/工具）
- **THEN** 重跑正常执行，fork run 的 config_hash 与父一致

#### Scenario: 异源拒绝

- **WHEN** 运行配置的 system prompt 与父 run 不同
- **THEN** runs:fork 返回 config_hash 不一致错误，不产生新 run

## MODIFIED Requirements

### Requirement: 全程只读且只呈现原样数据

系统 SHALL NOT 提供任何写入、修改或删除 trace 文件的通道；界面呈现的 span 与 messages SHALL 为文件原样内容，不做采样或截断（长内容用折叠而非丢弃）。`runs:fork` 是本系统唯一的例外写通道：它 SHALL 只**新建** fork run 文件，SHALL NOT 修改或删除任何既有文件，且 SHALL 仅在用户显式编辑并确认后触发。

#### Scenario: 浏览过程无写入

- **WHEN** 用户浏览任意 run 的全部 span 与详情
- **THEN** 除用户显式提交分叉重跑外，接口集合不含任何写类方法，trace 文件不被创建、修改或删除

#### Scenario: 超长消息

- **WHEN** 某条消息内容超过一屏
- **THEN** 内容默认折叠并可展开，展开后为完整原文，无截断省略

#### Scenario: 分叉不触碰既有文件

- **WHEN** 用户对某 run 发起分叉重跑并完成
- **THEN** 仅新增一个 fork run 文件；父 run 与其余文件内容逐字节不变
