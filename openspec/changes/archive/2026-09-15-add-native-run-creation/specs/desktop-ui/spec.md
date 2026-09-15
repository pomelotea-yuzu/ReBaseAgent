# desktop-ui Delta: 桌面端原生 run 创建入口

> 说明：MODIFIED 块的 requirement **名保留未改**（openspec delta 按 requirement 名匹配，改名需 REMOVED+ADDED
> 组合，本期不做）；正文已按"两条写通道（`runs:fork` / `runs:create`）"修订，故两处名称中的"唯一"字样
> 已与正文不符，属已知措辞债。共 MODIFIED 两条：「全程只读且只呈现原样数据」与「分叉重跑是唯一的显式
> 写路径」——后者列出的原 scenario 全部保留（MODIFIED 为整体替换，漏写旧 scenario 会被拒）。
> 原 ADDED 的「新建 run 的来源标注」已删除：既有 requirement「run 列表标注录制来源并可过滤」已覆盖
> "无 `source` 字段归入本地直录"，新建 run 正落在该条内。

## MODIFIED Requirements

### Requirement: 全程只读且只呈现原样数据

系统 SHALL NOT 提供任何写入、修改或删除既有 trace 文件的通道；界面呈现的 span 与 messages SHALL 为文件原样内容，不做采样或截断（长内容用折叠而非丢弃）。`runs:fork` 与 `runs:create` 是本系统仅有的两个例外写通道：两者 SHALL 只**新建** run 文件，SHALL NOT 修改或删除任何既有文件；`runs:fork` SHALL 仅在用户显式编辑并确认后触发，`runs:create` SHALL 仅在用户显式提交表单后触发。

#### Scenario: 浏览过程无写入

- **WHEN** 用户浏览任意 run 的全部 span 与详情
- **THEN** 除用户显式提交分叉重跑或新建运行外，接口集合不含任何写类方法，trace 文件不被创建、修改或删除

#### Scenario: 超长消息

- **WHEN** 某条消息内容超过一屏
- **THEN** 内容默认折叠并可展开，展开后为完整原文，无截断省略

#### Scenario: 分叉不触碰既有文件

- **WHEN** 用户对某 run 发起分叉重跑并完成
- **THEN** 仅新增一个 fork run 文件；父 run 与其余文件内容逐字节不变

#### Scenario: 新建运行不触碰既有文件

- **WHEN** 用户提交"新建运行"并执行完成（成功或失败）
- **THEN** 仅新增一个 run 文件（文件名等于其 `meta.id`）；其余 run 文件内容逐字节不变，且数据目录不留任何临时文件

### Requirement: 分叉重跑是唯一的显式写路径

renderer 侧 SHALL 仅有两条可触发文件写入的通道：`runs:fork`（分叉重跑）与 `runs:create`（新建运行）。除此之外的浏览、列表、详情等既有路径 SHALL 保持零写能力。

- `runs:fork`：请求体 = `{ parentRunId, atSpanId, edit: { field, value } }`，main 侧加载父 run、校验可重放性、执行重跑，返回新 run id；每个请求 SHALL 携带用户明确选择的 `atSpanId` 与编辑值（不允许无编辑的"空 fork"）。
- `runs:create`：请求体 = `{ systemPrompt, userMessage }`，main 侧取运行配置组装空工具表的 `RunConfig` 并执行一次从头开始的 agent loop，返回新 run id；每个请求 SHALL 携带非空 `userMessage`（不允许空消息）。

#### Scenario: 编辑 tool_result 并重跑

- **WHEN** 用户在详情面板选中一个 `tool.invoke` span，编辑其 result 并确认重跑
- **THEN** 界面出现进行中状态；完成后列表刷新并自动选中新 run（分支 run 经 resolveBranch 展示合并轨迹，分叉点被标注）

#### Scenario: 非法请求被拒绝

- **WHEN** `runs:fork` 的 atSpanId 不存在、父 run 未封存、或编辑字段非 result；或 `runs:create` 的请求体缺少非空 userMessage
- **THEN** 界面显示错误原因（来自信封 error），不产生新 run

#### Scenario: 空 fork 被拒绝

- **WHEN** 用户未修改编辑值即提交
- **THEN** 请求被拒绝（编辑前后值相同视为无操作），不产生新 run

## ADDED Requirements

### Requirement: 桌面端提供原生 run 创建入口

系统 SHALL 提供"新建运行"入口，允许用户直接在桌面端创建并执行一个 run，无需依赖代理录制或外部脚本。入口 SHALL 位于 run 列表标题区，点击后弹出对话框。对话框 SHALL 包含：

- **System Prompt**（多行文本框，可选，缺省为空字符串）
- **User Message**（多行文本框，必填）

提交后系统 SHALL 通过 `runs:create` 通道执行：main 侧读取运行配置（baseURL / apiKey / model），组装空工具表的 `RunConfig`，以"system（内容可为空串）+ user"两条初始消息调用 `runLoop`。产出的 run SHALL 为根 run（`meta.parent` 为 `null`、`meta.fork` 为 `null`）、SHALL 不含 `source` 字段（与 SDK 直录 run 同形，归入列表的「本地直录」类别）、`meta.task` SHALL 等于 userMessage、`meta.config_hash` SHALL 与 `configHash(systemPrompt, [])` 逐字节相等。run 文件的文件名 SHALL 等于 `meta.id`。系统 SHALL 仅在运行结束后把该文件按 `meta.id` 归位，SHALL NOT 让执行中的半成品以任何形式出现在 run 列表中。成功后 SHALL 刷新 run 列表并自动选中新 run。

#### Scenario: 新建 run 成功

- **WHEN** 用户填写 systemPrompt 和 userMessage 并点击"创建"
- **THEN** 系统创建新 run，run 出现在列表中并被自动选中；run 的 `meta.parent` 为 `null`、`meta.fork` 为 `null`、`meta.task` 等于 userMessage、`meta.config_hash` 与 `configHash(systemPrompt, [])` 逐字节相等，且其文件名等于 `meta.id`

#### Scenario: 新建 run 作为父本进行 prompt fork

- **WHEN** 用户对新建的 run 发起 prompt fork（编辑 system prompt 或 user message）
- **THEN** fork 正常执行，子 run 的 `meta.parent` 指向该新建 run，fork 元数据与既有引擎父本产物的形状一致

#### Scenario: 新建 run 作为父本进行模型 A/B

- **WHEN** 用户对新建的 run 发起模型 A/B 实验（两个不同 model/params 的 arm）
- **THEN** 每个 arm 独立执行，各臂 run 的 `meta.parent` 指向该新建 run，各臂 `config_hash` 与父 run 一致

#### Scenario: 新建 run 作为父本进行 trace-test

- **WHEN** 用户对新建的 run 发起 trace-test
- **THEN** trace-test 正常执行，测试该 run 的可重放性

#### Scenario: settings 未配置时拒绝

- **WHEN** 用户未配置 baseURL / apiKey / model 即点击"创建"
- **THEN** 系统在发起任何网络请求前拒绝，返回 `SETTINGS_NOT_CONFIGURED` 错误，界面提示"请先在设置中配置运行参数"

#### Scenario: userMessage 为空时禁用提交

- **WHEN** 对话框中 userMessage 为空
- **THEN** "创建"按钮禁用，无网络请求

#### Scenario: 空 systemPrompt 允许

- **WHEN** 用户未填写 systemPrompt（留空）
- **THEN** 系统允许创建，run 的 `config_hash` 按 `configHash("", [])` 计算

#### Scenario: 执行失败不产生半成品

- **WHEN** 模型调用失败（`runLoop` 以 `errored` 终止事件收尾）
- **THEN** 该 run 的文件仍按 `meta.id` 归位，且 run 列表 SHALL 被重新拉取使该 run 可见/可选中（列表徽标显示终止原因为"出错终止"；`status` 仍为 `completed`——该字段只表示"是否含终止事件"）；IPC SHALL 返回 `CREATE_RUN_FAILED` 与中文提示，提示 SHALL NOT 承诺 trace 内有错误原因（当前不记录）；SHALL NOT 留下任何非 `.jsonl` 的临时文件被列表读到
