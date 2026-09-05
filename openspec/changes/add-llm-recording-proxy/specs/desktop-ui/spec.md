# desktop-ui Delta: 代理状态、来源过滤与 messages 重发

## ADDED Requirements

### Requirement: 代理设置与运行状态可观测可控

设置对话框 SHALL 增加代理区：启用开关、监听端口（默认 18787）、upstream base\_url（默认 `https://api.deepseek.com`）。应用界面 SHALL 有代理运行状态指示（运行中含端口）。启用/停用 SHALL 即时生效并反馈结果（端口占用等错误可见）。状态指示 SHALL 包含「本会话是否已捕获 key」（不含 key 值本身）。

#### Scenario: 启用代理

- **WHEN** 用户在设置中打开代理开关并保存

- **THEN** 状态指示变为运行中（显示端口 18787），用户可立即把应用的 base\_url 指过来

#### Scenario: 端口占用可见

- **WHEN** 保存启用但端口被占用

- **THEN** 设置界面呈现明确错误，开关回到停用态

#### Scenario: key 捕获状态

- **WHEN** 代理运行中但本会话尚无任何请求经过

- **THEN** 状态指示标明「未捕获 key」，重发功能预期不可用的状态与之一致

### Requirement: run 列表标注录制来源并可过滤

run 列表 SHALL 为代理录制的 run（meta 含 `source.kind="proxy"`）显示来源徽标，SHALL 提供来源过滤（全部 / 仅代理 / 仅本地直录）。无 `source` 字段的老文件 SHALL 归入「本地直录」，不报错。

#### Scenario: 徽标与过滤

- **WHEN** 列表同时含 3 个代理 run 与 2 个 SDK 直录 run，用户选择「仅代理」

- **THEN** 列表仅显示 3 个带代理徽标的 run；选择「全部」恢复 5 个

#### Scenario: 老文件无来源

- **WHEN** 列表含无 `source` 字段的老 run

- **THEN** 归入「本地直录」且无徽标，不报错

### Requirement: proxy fork 的分支视图降级为父链列表

`resolveBranch` SHALL 保持原样（纯拼接、不应用编辑、不加 proxy 形态分支）。对经 `proxy:fork` 产生的 run（`fork.edit.field="messages"`），分支/时间线视图 SHALL 降级呈现为「父链列表」：按 parent 链从根到当前列出各代 run（每项含 task 来源、fork.edit 摘要——被编辑的第几条消息），点击可切换查看对应 run 详情。SHALL NOT 把编辑前后的两个 llm.call 拼进同一条时间线假装成一次连续运行（编辑生效点不可见即诚实缺省）。既有 replay 分叉（`fork.edit.field="result"`）的分支呈现 SHALL 完全不变。

#### Scenario: proxy fork 用父链列表查看

- **WHEN** 用户选中 r\_proxy02（parent 指向 r\_proxy01，fork.edit.field="messages"）

- **THEN** 分支区显示 r\_proxy01 → r\_proxy02 的父链列表（r\_proxy02 项标注「已编辑 messages」），点击 r\_proxy01 可查看其详情；不存在把两个 llm.call 混排的合并时间线

#### Scenario: replay 分叉呈现不变

- **WHEN** 用户选中既有 `fork.edit.field="result"` 的 run

- **THEN** 分支呈现与 Spec #4 行为完全一致（共享前缀 + 新增 span 的时间线）

### Requirement: 代理 run 的 llm.call 可编辑 messages 重发

代理 run 的 `llm.call` 详情 SHALL 提供「编辑重发」入口：编辑器（Monaco，懒加载，复用既有编辑器加载机制）呈现 `request.messages` 全文（JSON），提交时走新通道 `proxy:fork`（含源 run id、源 llm.call span id、编辑后 messages）。未修改 SHALL 禁用提交（空 fork 防线）；本会话未捕获 key SHALL 呈现明确指引（先把应用经代理跑一次）而非灰按钮无解释。重发确认处 SHALL 明示「将真实调用 upstream 并产生 API 费用」。成功后 SHALL 重载 run 列表并自动选中新 fork run；失败（upstream 报错等）SHALL 呈现错误详情且源 run 不受影响。

#### Scenario: 编辑并重发成功

- **WHEN** 用户在编辑器中修改 messages 的一条内容并确认重发

- **THEN** 经 `proxy:fork` 产生新 run（parent/ fork.edit 如 llm-proxy spec），列表出现新 run 且被自动选中，详情可见新响应

#### Scenario: 未修改禁用

- **WHEN** 编辑器内容与原始 messages 逐字节一致

- **THEN** 提交按钮禁用，无任何网络请求

#### Scenario: 未捕获 key

- **WHEN** 本会话代理未捕获任何 key 时用户点击重发

- **THEN** 呈现明确提示「本会话未捕获到 key，请先把你的应用经代理跑一次」，不发起请求

#### Scenario: SDK run 无此入口

- **WHEN** 选中一个非代理 run 的 `tool.invoke` 或 `llm.call`

- **THEN** 既有 ForkEditor（tool.result 编辑重跑）行为不变；messages 编辑重发入口不出现（分叉语义属 replay 路径，本变更不越界）
