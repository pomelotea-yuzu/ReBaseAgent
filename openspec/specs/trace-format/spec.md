# trace-format Specification

## Purpose

定义 ReBaseAgent trace 数据格式 v1（JSONL，一 run 一文件）：Agent 运行的可回放记录标准，是查看、预算地图、时间旅行与 Trace-as-Test 的共同地基。

## Requirements

### Requirement: trace 文件为 JSONL 且一 run 一文件

系统 SHALL 将一次 Agent 运行（run）的全部记录写入单个 JSONL 文件，文件内每行为一个 JSON 对象，行类型为 `run.meta`（首行）、`span`（若干）、`run.event`（0 或多个，含终止事件）。

#### Scenario: 正常完成的 run

- **WHEN** 一次 run 正常结束

- **THEN** 文件首行为 `run.meta`，末尾存在 `run.event`（`event: "stopped"`）行

- **AND** 全部行按发生顺序追加，无插入、无修改

#### Scenario: 崩溃的 run

- **WHEN** 进程在 run 中途崩溃

- **THEN** 已写入的行保持完整（无半行 JSON），文件缺失终止事件——读取器 SHALL 将其识别为 `crashed` 状态而非报错

### Requirement: 格式带版本号

`run.meta` 行 SHALL 包含 `format_version` 整数字段。读取器 SHALL 支持 1 和 2：普通运行继续写 1，隔离文件运行写 2。v2 SHALL 携带 workspace 元数据，v1 SHALL NOT 携带 workspace、step 快照或整轮续跑字段。读取器遇到更高版本 SHALL 明确报“不支持的格式版本”，不得静默降级解析。旧版读取器 SHALL 明确拒绝 v2 隔离文件，不得剔除字段后执行为普通运行。

#### Scenario: 未来版本文件
- **WHEN** 读取 `format_version: 3` 的文件
- **THEN** 报错提示版本不支持，不产生部分解析结果

#### Scenario: 双版本与旧读取器
- **WHEN** 新读取器读取普通 v1 和合法隔离 v2 fixture，或旧 v1 读取器读取该 v2 fixture
- **THEN** 新读取器完整保留各自字段，普通 writer 仍产出 v1；旧读取器明确拒绝 v2

#### Scenario: 版本与隔离字段不匹配
- **WHEN** v1 带 workspace 或整轮续跑字段，或 v2 缺 workspace、已完成 step 缺快照
- **THEN** 校验拒绝并指出字段问题，不把隔离状态按未知字段静默删除

#### Scenario: v1 禁字段与其他扩展区分
- **WHEN** v1 原始 meta 自有 workspace 或 fork.resume_after_step，或 span 自有 workspace_snapshot，字段值为 null/false/空对象；另有只包含不相关扩展字段或消息正文内同名业务字段的对照记录
- **THEN** 前者均在字段转换或剔除之前被拒绝，后者沿用既有兼容行为；不得用全对象 strict 或递归同名搜索误伤普通 v1 数据

### Requirement: 三种 span kind 与结构

span SHALL 为以下三种 kind 之一，构成树（`parent` 指向父 span id，根 span 的 parent 为 null）：

- `agent.step`：一轮 loop 迭代，含序号 `n`

- `llm.call`：一次 LLM 调用，`request` 原样录制完整请求（messages、tools、params、model），`response` 含 `content`、`reasoning_content`（推理模型，可为 null）、`tool_calls`、`usage`、`ttft_ms`

- `tool.invoke`：一次工具执行，含 `tool`、`args`、`result`、`dur_ms`、`error`（null 或错误信息）

#### Scenario: 推理模型的响应

- **WHEN** 模型返回 `reasoning_content`（思维链）

- **THEN** `llm.call` 的 `response.reasoning_content` 完整保存，UI 侧可区别于正文展示

#### Scenario: llm.call 的完整请求录制

- **WHEN** 重放引擎需要回到第 N 步

- **THEN** 第 N 个 `llm.call` span 的 `request.messages` 可直接作为 loop 输入使用（查表，无需重建）

### Requirement: 错误是数据不是异常

工具执行失败 SHALL 记录为 `tool.invoke` span 的 `error` 字段（非 null），loop 决定继续或停止；文件本身不因工具错误而中断。

#### Scenario: 工具报错但任务完成

- **WHEN** 第 2 步 read\_file 失败（error 非空）而 Agent 换用其他工具后完成

- **THEN** trace 完整记录失败 span 与后续步骤，读取器不视为 run 失败

### Requirement: run 级终止事件

run 的结束 SHALL 由 `run.event` 行表达，`reason` 枚举至少包含：`completed`、`max_iterations`、`budget_exceeded`、`aborted`（用户取消）、`error`（不可恢复错误）。

#### Scenario: 死循环被停止

- **WHEN** loop 达到最大迭代数

- **THEN** 写入 `{ "type": "run.event", "event": "stopped", "reason": "max_iterations", "at": 25 }`，文件封存

### Requirement: 分支用 fork 元数据表达

分支 run 的 `run.meta` SHALL 含 `parent`（父 run id）与 `fork` 对象（`at_span`：编辑点 span id；`edit`：字段及新值）。分支文件 SHALL 只记录新增 span，前缀经 parent 链共享。v1 保持截至 at_span 的既有规则；v2 隔离 result 分叉 SHALL 另带 `resume_after_step`，保留该轮完整步骤及所有工具子节点后再接子 run。at_span SHALL 属于指定 step，该 step SHALL 来自直接父 run 自有记录。

#### Scenario: 编辑工具结果后分叉
- **WHEN** 用户编辑普通 v1 r_01 中 s_04 的 tool_result 并重跑
- **THEN** 新文件 r_02 的 meta 含 `fork: { at_span: "s_04", edit: { field: "result", value: ... } }`，文件内只有新增 span，旧前缀拼接规则不变

#### Scenario: 隔离分叉保留同轮兄弟工具
- **WHEN** v2 某轮包含依次执行的 T1/T2，分叉编辑 T1 的 result
- **THEN** fork 同时记录 T1 和所属 step 的两个边界，展开前缀保留该轮 LLM、T1、T2 各一次，随后接入子运行；不遗漏 T2、不执行编辑或附件读取

#### Scenario: 隔离续跑边界矛盾
- **WHEN** resume_after_step 缺失、指向非步骤、与 at_span 所属步骤不符或只存在于祖先
- **THEN** 隔离父子关系校验拒绝，不猜测边界，不静默套用 v1 截断

### Requirement: 文件不可变与分支/删除保护

系统 SHALL 保证：run 终止事件写入后文件不再被任何路径修改；只能从已封存（有终止事件）的 run 创建分支；存在子分支的 run 被请求删除时 SHALL 拒绝并提示子分支数量。

#### Scenario: 对已封存文件追加

- **WHEN** 任何代码路径尝试向已含终止事件的文件追加行

- **THEN** API 抛出明确错误，文件保持不变

#### Scenario: 删除有子分支的 run

- **WHEN** 用户删除 r\_01，而 r\_02 的 parent 指向 r\_01

- **THEN** 删除被拒绝，提示"有 1 个分支引用此 run"

### Requirement: Tracer 为事件流且是唯一观测出口

SDK SHALL 提供 `Tracer` 接口（startRun / startSpan / endSpan / endRun），实现为可订阅的事件流；文件写入只是其中一种实现（`JsonlTracer`）。Agent loop 的所有观测 SHALL 经 Tracer 流出，不直接写文件。

#### Scenario: 无文件运行

- **WHEN** CI 中使用 `NullTracer`（或内存订阅者）

- **THEN** loop 正常运行，无文件产生，事件可被断言捕获

### Requirement: 读取器逐行校验

`readRun` SHALL 对每行执行 zod 校验，遇到不合法行 SHALL 报错并指明行号与原因，不得静默跳过。

#### Scenario: 手工篡改的文件

- **WHEN** 某行缺少 `type` 字段

- **THEN** 读取报错"第 N 行：type 为必填"，不返回部分结果

### Requirement: span 可记录墙上时钟区间

span 行 SHALL 支持可选 `timing` 对象，含 `started_at` 与 `ended_at`（ISO 8601 字符串，成对出现、不可只写其一）：Tracer 在 `startSpan` 时记录起始时刻，`endSpan` 落盘该行时一并写入终止时刻。读取器 SHALL 接受缺失 `timing` 的 span（老文件与手工构造数据合法），不得报错或以其他字段推断。

#### Scenario: 新产出的 span 带时间区间

- **WHEN** 一次运行中开启 span 并在 120ms 后结束

- **THEN** 落盘的 span 行含 `timing.started_at` 与 `timing.ended_at`，两者之差约为 120ms

#### Scenario: 缺失时间区间的老文件

- **WHEN** 读取一份 span 无 `timing` 字段的 trace 文件

- **THEN** 校验通过，读取结果中这些 span 无 `timing`，调用方须按"时间未知"处理

### Requirement: run.meta 可记录预算上限

`run.meta` SHALL 支持可选 `budget` 对象，结构为 `{ "max_total_tokens": number }`。当录制端的源配置声明了总 token 预算（`config.budget.maxTotalTokens`）时，`startRun` SHALL 将其实值写入该字段；未声明时 SHALL 省略 `budget`（缺省字段，仅 meta 层增量）。读取器 SHALL 接受缺失 `budget` 的 meta（老文件与手工构造数据合法），不得报错。该字段 SHALL NOT 影响 `format_version`（保持不变）。

#### Scenario: 声明预算的运行

- **WHEN** 一次 run 的源配置设置 `config.budget.maxTotalTokens = 60000`

- **THEN** 落盘的 `run.meta` 含 `budget: { "max_total_tokens": 60000 }`

#### Scenario: 未声明预算的运行

- **WHEN** 源配置未设置 `maxTotalTokens`

- **THEN** 落盘的 `run.meta` 不包含 `budget` 字段，其余字段与解析行为不变

#### Scenario: 无预算信息的老文件

- **WHEN** 读取一份 `run.meta` 无 `budget` 字段的既有 trace 文件

- **THEN** 校验通过，读取结果中该 run 无预算信息，调用方按"预算未知"处理

### Requirement: 无 config_hash 的 run（代理录制形态）

`run.meta` 的 `config_hash` SHALL 放宽为可选字段（存在时仍须非空字符串）：由 SDK / agent-loop 直接录制时照常写入；由代理录制时 SHALL 省略（代理观察到的是无 loop 语境的独立请求，无源配置可哈希，诚实缺省而非占位值）。读取器 SHALL 接受缺失 `config_hash` 的 meta（老文件不受影响，它们均含该字段），不得报错。无 `config_hash` 的 run SHALL NOT 能作为 replay 分叉（`runs:fork` 路径）的父本——校验层 SHALL 明确拒绝并提示；但 SHALL 能作为代理分叉（`proxy:fork` 路径）的父本。`task` 字段保持必填：代理录制的 run SHALL 以常量 `"(llm-proxy)"` 填充（确定性纯函数，不做首条消息截断等启发式）。

#### Scenario: 代理 run 缺省 config_hash

- **WHEN** 一次请求经本地代理录制为 run

- **THEN** 落盘的 `run.meta` 含 `source` 与 `task: "(llm-proxy)"`，不含 `config_hash`；读取器校验通过

#### Scenario: 代理 run 拒绝 replay 分叉

- **WHEN** 对一个无 `config_hash` 的 run 走既有 `runs:fork` 路径（编辑 tool.result 重跑）

- **THEN** 校验层明确拒绝（该 run 无工具表与源配置，replay 语义不成立），提示而非报错崩溃

#### Scenario: 老 run 不受影响

- **WHEN** 读取既有含 `config_hash` 的 trace 文件并对其做 replay 分叉

- **THEN** 行为与此前完全一致（config_hash 校验照常）

### Requirement: run.meta 可记录录制来源

`run.meta` SHALL 支持可选 `source` 对象，结构为 `{ "kind": string, "base_url": string }`；`kind` 当前枚举仅 `"proxy"`（本地 LLM 录制代理录制）。当 run 由代理录制时，`source.kind` SHALL 为 `"proxy"`，且 `source.base_url` SHALL 为**代理自身监听地址**（即用户在自己应用里填的那个 base\_url，如 `http://127.0.0.1:18787/v1`）——SHALL NOT 混用为 upstream 转发目标地址（upstream 属代理配置，不进 trace）。由 SDK / agent-loop 直接录制时 SHALL 省略 `source`（缺省字段，仅 meta 层增量）。读取器 SHALL 接受缺失 `source` 的 meta（老文件与手工构造数据合法），不得报错。该字段 SHALL NOT 影响 `format_version`（保持不变）。

#### Scenario: 代理录制的 run

- **WHEN** 一次请求经本地代理（端口 18787）录制为 run

- **THEN** 落盘的 `run.meta` 含 `source: { "kind": "proxy", "base_url": "http://127.0.0.1:18787/v1" }`

#### Scenario: SDK 直接录制的 run

- **WHEN** 一次 run 由 trace-sdk / agent-loop 直接录制（非代理）

- **THEN** 落盘的 `run.meta` 不包含 `source` 字段，其余字段与解析行为不变

#### Scenario: 无来源信息的老文件

- **WHEN** 读取一份 `run.meta` 无 `source` 字段的既有 trace 文件

- **THEN** 校验通过，读取结果中该 run 无来源信息，调用方按"来源未知（视同 SDK 直录）"处理

### Requirement: llm.call usage 记录缓存命中与未命中

`llm.call` span 的 `response.usage` SHALL 支持可选字段 `cache_hit` 与 `cache_miss`（非负整数，tokens 数）：provider 返回缓存命中信息时，记录端 SHALL 将其实值写入——**包括返回 `0` 的情形（`0` = 实测零命中，是有值，SHALL 如实记录为 `0`）**；仅在 provider **未返回**这两个字段时才 SHALL 整体省略（不得以 `0` 冒充"未知"）。读取器 SHALL 接受缺失这两个字段的 span（老文件与不支持缓存的 provider 合法），SHALL NOT 报错或从其他字段推断。字段"有值"的判据 SHALL 为存在性判断（`!== undefined`），SHALL NOT 使用 truthiness——否则 `0` 会被误判为缺失。该字段 SHALL NOT 影响 `format_version`（保持不变）；`in` 的口径 SHALL 不变（仍为 provider 返回的输入总量原值，缓存命中是其组成部分而非额外叠加）。

#### Scenario: 缓存命中写入落盘

- **WHEN** 一次 LLM 调用的 provider usage 返回命中 800 / 未命中 200
- **THEN** 落盘的 llm.call 行 `response.usage` 含 `cache_hit: 800` 与 `cache_miss: 200`，`format_version` 不变

#### Scenario: 零命中如实记录（不得省略）

- **WHEN** provider 返回 `prompt_cache_hit_tokens: 0`（本次全量计费）
- **THEN** 落盘的 `response.usage` 含 `cache_hit: 0`，SHALL NOT 省略该字段（`0` 与"字段缺失"语义不同）

#### Scenario: 老文件缺失缓存字段合法

- **WHEN** 读取一份 `response.usage` 只含 `{in, out}` 的既有 trace 文件
- **THEN** 校验通过，读取结果中 usage 无 `cache_hit` / `cache_miss`，调用方按"缓存命中未知"处理，不报错

#### Scenario: 非法值被拒绝

- **WHEN** 校验一份 `response.usage.cache_hit` 为负数或非整数（如 `-1` / `1.5`）的 trace 行
- **THEN** 校验失败并报错，SHALL NOT 静默接受或就地修正（与"老文件缺失合法"对称：**缺失合法，越界非法**）

### Requirement: llm.call 可记录调用失败详情

`llm.call` span SHALL 支持可选的顶层 `error` 对象（与 `request` / `response` 平级），含 `message`（脱敏并限长后的**非空**诊断文本）与可选的 `status`（HTTP 错误状态码，SHALL 仅在实际取得该状态码时写入，SHALL NOT 从消息文本猜测）。成功调用 SHALL 省略 `error`；既有 trace 缺省该字段 SHALL 仍合法可读——**字段缺失只表示未记录错误详情，SHALL NOT 被解读为调用成功**，读取器与消费端 SHALL NOT 由空正文、零 token 或缺省字段反推失败原因。

`error` SHALL NOT 接受 `null`（与 `tool.invoke.error` 的 `string | null` 语义相反方向：后者 `null` 表示成功，前者 `undefined` 才表示未记录失败）。`error` 对象 SHALL NOT 承载 headers、完整响应体、stack 或任意异常对象。`format_version` SHALL 保持 `1`，历史文件 SHALL NOT 被改写；Tracer 的 `span.end` 事件与 JSONL 落盘/读取 SHALL 保留该字段（读取器逐行校验与分支解析 SHALL NOT 丢字段）。

#### Scenario: 失败调用记录错误详情并保留状态码

- **WHEN** 一次 LLM 调用因端点返回 HTTP 401 失败，loop 随该 span 流出 `error: { message: "LLM 端点返回 HTTP 401：…", status: 401 }`
- **THEN** 该 `llm.call` span 的 JSONL 行含顶层 `error` 对象，`status` 为 `401`；经 `span.end` 事件与读取器往返后字段逐字节一致

#### Scenario: 失败无状态码时不写 status

- **WHEN** 失败来自网络异常或流中断（无 HTTP 状态码）
- **THEN** `error` 只含 `message`，SHALL NOT 出现 `status` 字段（不写 0、不写占位）

#### Scenario: 缺省 error 的旧文件仍可读

- **WHEN** 读取一个不含任何 `error` 字段的历史 trace（成功或失败调用皆然）
- **THEN** 逐行校验通过，字段缺省；读取器 SHALL NOT 报错、SHALL NOT 以空正文或零 token 推断该调用失败

#### Scenario: error 为 null 被拒绝

- **WHEN** 解析一个 `llm.call` 上携带 `error: null` 的 span
- **THEN** 校验失败（LLM 错误的缺省态是 `undefined`，`null` 非法）

#### Scenario: 错误详情不混入响应与上下文

- **WHEN** 一次调用失败落盘
- **THEN** `response.content` 仍为空占位、`request.messages` SHALL NOT 含任何错误文本，失败轮 SHALL NOT 追加 assistant 消息

### Requirement: 隔离元数据及检查点可独立解析

v2 `run.meta.workspace` SHALL 记录 `profile:"file-tools-v1"`、等于本 run id 的 `world_id`、`write_authorized:true`、`initial_snapshot` 和 `origin`。根 origin SHALL 为 `{kind:"import"}`，分支 origin SHALL 为 `{kind:"checkpoint",run_id,step_span}` 并与 parent/resume_after_step 一致。每个完整 `agent.step` SHALL 携带 `workspace_snapshot`，它代表整轮全部工具完成后的状态。

`write_authorized:true` SHALL 仅作为创建方记录该次运行已获确认的审计标注，SHALL NOT 作为当前执行权限或不可伪造的授权证明；新一次创建/分叉必须独立校验当前请求的副本写入授权，不得从父 trace 的该字段推导。

快照 SHALL 是 `{id,files:[{path,sha256,bytes}]}`，files 为排序后的合法唯一相对文件路径清单，id 为规范清单哈希。SHA-256 SHALL 是 64 位小写十六进制，bytes SHALL 为非负整数，路径 SHALL 满足文件世界约束；快照 SHALL 不携带绝对磁盘路径、凭据或内联文件字节。事件流、JSONL、MemoryTracer 和读取器往返 SHALL 保留这些字段。

#### Scenario: 根与分支快照往返
- **WHEN** 初始快照和两轮结束快照经 Tracer 写入，再通过读取器加载
- **THEN** 所有路径、哈希、来源及边界字段完整保留，span 语义顺序仍正确；空清单也可往返

#### Scenario: 非法清单拒绝
- **WHEN** 清单存在非法路径、重复或冲突路径、负 bytes、非法哈希、哈希与规范清单不符或矛盾的 origin
- **THEN** 返回明确校验错误，不生成部分可信快照

#### Scenario: 无附件仍能看轨迹
- **WHEN** 合法 v2 JSONL 存在但附件目录不可用
- **THEN** 普通 trace 解析不加载附件，仍返回完整消息与步骤；包附件读取和真实续跑分别报告不可用，不能改写 trace 补数据
