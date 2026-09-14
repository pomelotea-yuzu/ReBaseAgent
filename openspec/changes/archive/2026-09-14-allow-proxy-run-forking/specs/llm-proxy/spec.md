# llm-proxy Delta: 代理录制 run 的配置指纹

## MODIFIED Requirements

### Requirement: 每个请求录制为一个 run

每个被代理的 `/v1/chat/completions` 请求 SHALL 录制为独立的 trace run（一 run 一 JSONL 文件）：`run.meta`（含 `source: { kind: "proxy", base_url }`、`task: "(llm-proxy)"`，`config_hash` 按「代理 run 写入与引擎一致的配置指纹」要求条件写入，指纹缺省时同时写 `config_hash_reason`）、一个 `agent.step`（n=1）内含一个 `llm.call` span、终止 `run.event`。`llm.call.request` SHALL 记录：`messages`、`tools`（无则空）、`model`；请求体顶层除 `model` / `messages` / `tools` / `stream` 外的字段（temperature、max\_tokens 等）SHALL 平铺收进 `params`（映射语义与 agent-loop 录制一致）。请求头一律不录制。响应 SHALL 按 agent-loop llm-client 同标准聚合出 `content` / `reasoning_content` / `tool_calls` / `usage`（对 `usage: null` 中间块容错；流式结束时仍无 usage 则兜底 `{0,0}`，诚实为零不臆造）。非流式响应无 TTFT 概念，`ttft_ms` SHALL 记 `0`（语义为「一次到货」，SHALL NOT 记总耗时冒充 TTFT）。

#### Scenario: 非流式请求录制

- **WHEN** 客户端发起非 stream 请求且 upstream 返回 200

- **THEN** 落盘 run 含 meta（source.kind="proxy"、task="(llm-proxy)"、config\_hash 按指纹规则条件写入，缺省时带 config\_hash\_reason）、agent.step + llm.call（完整 request 含平铺 params，response 聚合完整、ttft\_ms=0）、`stopped/completed` 终止事件

#### Scenario: 流式请求录制

- **WHEN** 客户端发起 `stream: true` 请求

- **THEN** 客户端边收边得（代理逐 chunk 转发，不缓冲整响应），结束后 run 内 llm.call 的 response 为聚合出的完整内容，与客户端实际收到的最终内容一致

#### Scenario: upstream 失败

- **WHEN** upstream 返回 4xx/5xx

- **THEN** 错误响应原样回传客户端；run 只落 meta 与 `stopped/error` 终止事件，不写 llm.call span

#### Scenario: 客户端中途断连

- **WHEN** 客户端在流式转发过程中断开连接

- **THEN** 已转发字节不作补偿；run 无终止事件（crashed），已落盘行保持完整

## ADDED Requirements

### Requirement: 代理 run 写入与引擎一致的配置指纹

代理录制器 SHALL 在落盘时从请求快照派生 `meta.config_hash`：首次请求含字符串形式的 system 消息、且工具表（若有）每一项都能无损解包为 `ToolDef`（OpenAI `function` 包装或扁平形状，经 agent-loop 既有 schema 校验）时，SHALL 以与 agent-loop `configHash` **同一实现**计算并写入；任一条件不满足 SHALL 缺省不写，SHALL NOT 以部分解析、空串替代或任何伪造值放行。不写时必须同时写入 `meta.config_hash_reason` 记录缺因（`"no_system"`：无字符串 system 消息；`"invalid_tool"`：工具表存在无法解包的项），供 fork 门禁与桌面端给出可诊断的拒绝文案——两种缺因的修复路径不同（前者需源应用发送带字符串 system 的请求，后者需修正工具定义格式），SHALL NOT 以单一笼统文案掩盖差异。hash 派生与 outcome 无关（error run 的请求快照同样适用），但不含 `llm.call` span 的 run 仍会被 fork 门禁的既有条件拒绝。工具表缺省视为空表。

**保真度边界（sideEffect）**：wire 格式（OpenAI 工具定义）不携带 `sideEffect`，解包结果天然无该字段，而 `configHash` 仅在字段有值时计入——因此代理指纹是"线上事实"的指纹。若源应用恰好也是 ReBaseAgent 引擎、且其工具带 `sideEffect` 标记，代理侧 hash 与其进程内 hash **SHALL NOT 被假定相等**（标记不上线）。本要求只承诺：由同一代理录制派生的 hash 与从该录制重建的子 run（引擎 run）hash 一致；SHALL NOT 承诺跨进程指纹互通。

#### Scenario: 含 system 的无工具请求

- **WHEN** 请求 messages 含字符串 system 消息且不携带 tools

- **THEN** 落盘 meta 的 `config_hash` 与 `configHash(system, [])` 逐字节相等

#### Scenario: 含工具的请求

- **WHEN** 请求携带多工具（OpenAI function 包装、name 乱序）

- **THEN** `config_hash` 按解包后工具表计算（工具按 name 排序、键规范化），与对同一输入直接调用 `configHash` 的输出逐字节相等

#### Scenario: 无字符串 system 消息

- **WHEN** 请求 messages 不含 role=system 且 content 为字符串的消息

- **THEN** meta 不写 `config_hash`（诚实缺省）且写入 `config_hash_reason: "no_system"`，该 run 不进入配置型分叉

#### Scenario: 工具表无法解析

- **WHEN** 请求 tools 含无法解包为 `ToolDef` 的项（缺 name/description/parameters）

- **THEN** meta 不写 `config_hash` 且写入 `config_hash_reason: "invalid_tool"`，不产生部分哈希，转发与响应字节保真不受影响

#### Scenario: 可派生时不留缺因

- **WHEN** 请求含字符串 system 消息且工具表（或无工具）可派生

- **THEN** meta 写 `config_hash` 且不写 `config_hash_reason`（两者互斥，缺因仅表达"为何没有指纹"）
