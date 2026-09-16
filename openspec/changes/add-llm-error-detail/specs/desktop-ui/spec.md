# desktop-ui Delta

## ADDED Requirements

### Requirement: 失败 LLM 调用的标记与错误详情

轨迹树中 SHALL 对记录到失败的 `llm.call` 节点给出错误标记（与工具错误同等醒目），判据 SHALL 为 `error !== undefined`（`null` 非法）；工具节点的判据仍是 `error !== null`——两者 SHALL 先按 `kind` 缩窄类型再判定，SHALL NOT 套用统一的"非 null 即错误"。字段缺省的 LLM 节点 SHALL NOT 被标注为失败（未记录详情不等于成功，但界面 SHALL NOT 因此猜造失败）。

选中失败调用时，详情面板 SHALL 在概要区之后展示错误原因（`error.message`，长文本可换行或滚动，窄窗口下 SHALL NOT 遮挡请求与操作区），并在 `error.status` 存在时展示该 HTTP 状态码。错误详情区 SHALL 显式声明该次调用的 tokens / 首 token 延迟为**占位零值**，不代表实际零消耗或零延迟。失败调用 SHALL 仍可查看完整原始请求。

响应正文为空时的文案 SHALL 按情形区分，SHALL NOT 一律显示"仅有工具调用"：调用失败时 SHALL 说明调用失败、无响应正文；确有 `tool_calls` 时说明仅有工具调用；仅思维链成功响应 SHALL 说明仅有思维链；其余空正文 SHALL 说明响应为空正文。

#### Scenario: 失败节点被标记且可读原因

- **WHEN** 打开一个含失败 `llm.call`（`error.message` 非空、`status` 为 401）的 run 并选中该节点
- **THEN** 轨迹树该节点带错误标记；详情展示错误原因与 `HTTP 401`，并提示 tokens / 首 token 延迟为占位零值

#### Scenario: 工具错误与 LLM 错误判据不混用

- **WHEN** 同一轨迹内存在四种节点：LLM 带 `error`、LLM 无 `error`、工具 `error` 为字符串、工具 `error` 为 `null`
- **THEN** 仅 LLM 带 `error` 与工具 `error` 为字符串的两个节点被标为错误，另外两个不标

#### Scenario: 无状态码的失败不展示状态码

- **WHEN** 选中一个 `error` 只含 `message`（无 `status`）的失败调用
- **THEN** 只展示错误原因，SHALL NOT 展示任何状态码、SHALL NOT 以 0 冒充

#### Scenario: 空响应文案按情形区分

- **WHEN** 依次打开四类空正文调用：失败调用、成功且含 `tool_calls`、成功且仅有 `reasoning_content`、成功且三者皆空
- **THEN** 依次显示"调用失败，无响应正文"、"无正文，仅有工具调用"、"无正文，仅有思维链"、"响应为空正文"

#### Scenario: 失败调用仍可查看原始请求

- **WHEN** 选中一个失败调用
- **THEN** 请求消息、工具表与采样参数照旧完整可读，错误详情不与请求区重叠遮挡

### Requirement: 错误详情缺失的诚实提示

当运行的终止原因为 `error` 但**本 run 自身**的 spans 中不存在任何带 `error` 的 `llm.call` 时，界面 SHALL 在运行上下文处显示"错误详情未记录"的提示，并说明这是未记录（而非无错误）。

该判定 SHALL 由共享派生层的纯函数完成，只检查以 `RunDetail.leafSpanIds` 过滤后的 spans；SHALL NOT 直接扫描祖先合并后的整条轨迹——祖先的失败记录 SHALL NOT 冒充本次失败原因，也 SHALL NOT 因此隐藏本 run 的缺失提示。自身没有任何 `llm.call` 的代理失败 run（`meta.source.kind === "proxy"`）同样 SHALL 显示该提示。非错误终止的运行 SHALL NOT 显示该提示，且界面 SHALL NOT 根据空正文、零 token 或末尾 `llm.call` 猜造失败原因或标错历史调用。

#### Scenario: 错误终止且本 run 无详情

- **WHEN** 打开一个 `reason` 为 `error`、其自身 spans 内所有 `llm.call` 都无 `error` 字段的 run
- **THEN** 运行上下文显示"错误详情未记录"，成功 run 上不出现该提示

#### Scenario: 本 run 有详情时不显示缺失提示

- **WHEN** 打开一个错误终止且自身某次 `llm.call` 带 `error` 的 run
- **THEN** 不显示"错误详情未记录"（详情由失败节点自身展示）

#### Scenario: 祖先有错误不冒充本次原因

- **WHEN** 打开一个分支 run：其合并轨迹中祖先段落存在带 `error` 的 `llm.call`，而该 run 自身 `leafSpanIds` 覆盖的 spans 无 `error`，且终止原因为 `error`
- **THEN** 仍显示"错误详情未记录"（祖先的失败不计入本次判定）；同时轨迹树中祖先的失败节点照旧按自身 `error` 标记，不被隐藏

#### Scenario: 代理失败 run 同样提示缺失

- **WHEN** 打开一个代理录制的失败 run（无任何 `llm.call` span，终止原因为 `error`）
- **THEN** 显示"错误详情未记录"，SHALL NOT 报错、SHALL NOT 编造原因

## MODIFIED Requirements

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
- **THEN** 该 run 的文件仍按 `meta.id` 归位，且 run 列表 SHALL 被重新拉取使该 run 可见/可选中（列表徽标显示终止原因为"出错终止"；`status` 仍为 `completed`——该字段只表示"是否含终止事件"）；IPC SHALL 返回 `CREATE_RUN_FAILED` 与中文提示，提示 SHALL 引导用户点开该 run 查看错误详情（trace 已记录调用级错误原因），SHALL NOT 再把"看应用主进程日志"作为唯一出路；SHALL NOT 留下任何非 `.jsonl` 的临时文件被列表读到
