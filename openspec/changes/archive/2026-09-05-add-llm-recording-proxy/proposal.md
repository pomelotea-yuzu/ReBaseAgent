# Proposal: add-llm-recording-proxy

## Why

MVP 已闭环并发了 v0.1.0 portable exe，但产品化缺口的排序里「零摩擦接入」是活下来的第一件事（`docs/product.md` §6）：工具类产品最常见的死法是「功能很全、没人装」。当前接入路径要求用户在自己应用里埋 trace-sdk / 换 agent-loop，改造有成本；而目标用户（自研 Agent 的开发者）的最低成本动作是**只改一行 `base_url`**——把请求指到 ReBaseAgent 起的本地代理，key 一字不动，录制/查看零手工录入。这是把「看 span」入口的摩擦降到零的唯一方式。

同时评审（2026-09-05）确认了一个断层：既有 fork 语义（Spec #4）依赖 `tool.invoke` 叶子 span / 工具表 / config\_hash，代理录下的原始 `chat.completions` 请求天然不具备。已定稿**方案 a：代理侧做「单请求级最小分叉」**——编辑 messages 任意一条后经代理用暂存 key 重发。它让 JTBD ②（改脏上下文重发）在代理路径上也成立，是本变更的核心交付而非附带。

## What Changes

- **新包 `packages/llm-proxy`（纯 TS，零 Electron 依赖）**：本地 HTTP 代理服务核心。监听 `127.0.0.1:<port>` 的 `/v1/chat/completions`（OpenAI-compatible，stream SSE + 非 stream 两种），透明转发到可配置 upstream（默认 `https://api.deepseek.com`），同时提取请求/响应数据供录制。转发逻辑可注入 `fetch`（可测），SSE 聚合容错与 agent-loop llm-client 同标准（`usage: null` 中间块）
- **trace-format（向后兼容）**：`run.meta` 新增**可选** `source` 字段（`{ kind: "proxy", base_url: string }`，base\_url 为代理自身监听地址即用户应用填的那个，非 upstream）；**`config_hash` 放宽为可选**（代理 run 无源配置可哈希，诚实缺省不占位；无 config\_hash 的 run 拒绝作 replay 父本、可作 proxy fork 父本）；`task` 保持必填、代理 run 以常量 `"(llm-proxy)"` 填充。不改 `format_version`
- **desktop main**：代理服务生命周期管理（启停/端口占用处理）、settings 增 `proxy` 配置（enabled/port/upstreamBaseUrl）、**捕获 key 仅内存暂存**（供分叉重发，不持久化、不落盘、不回传渲染层）、代理 run 经 RunRepository 落 JSONL、新增 IPC 通道 `proxy:status` / `proxy:toggle` / `proxy:fork`
- **desktop-ui**：设置对话框增代理区（开关/端口/upstream）；header 代理运行状态点；run 列表 `source` 徽标 + 过滤；代理 run 的 llm.call 详情提供「编辑 messages 重发」入口（Monaco，复用 ForkEditor 模式），走 `proxy:fork` 记为 fork run（`parent` / `fork.at_span` / `fork.edit.field="messages"`）
- **分叉不依赖 key 的部分**：录制 / 看时间线 / 编辑 messages 纯本地；仅「重发」需要 key——用代理收到的 Authorization（内存暂存），key 始终不进 ReBaseAgent 持久存储

## Capabilities

### New Capabilities

- `llm-proxy`：本地 LLM 录制代理（透明转发、零 key 录制、单请求级最小分叉、仅 127.0.0.1、key 不落盘）

### Modified Capabilities

- `trace-format`：`run.meta` 新增可选 `source` 元数据（向后兼容、不改版本号）
- `desktop-ui`：代理状态入口与开关、run 列表来源徽标与过滤、代理 run 的 messages 编辑重发入口

## Non-goals

- **不做 Anthropic 协议**（`/v1/messages`）：MVP 仅 OpenAI-compatible `/v1/chat/completions`；Anthropic 消息体转换是后置项
- **不做其他端点**：`/embeddings`、`/models`、`/completions`（legacy）等一律不支持，匹配路径外返回明确 404/501 错误（诚实拒绝，不静默透传）
- **不做会话聚合/多请求 run**：每个请求一个 run；「同一 Agent 会话聚合成一 run」需要启发式且易错，明确不做（结构上 `meta.source` 已为将来聚合留了识别口）
- **不做 key 持久化**：暂存 key 仅存在于 main 进程内存，进程退出即失效；不写 safeStorage、不写磁盘（与 SettingsDialog 兜底 key 的持久化路径区分开）
- **不做白名单/按模型过滤录制**：本变更只做「暂停/恢复代理」这一档降噪；列表过滤属于查看侧
- **不做 HTTPS / 多用户 / 局域网监听**：只绑 `127.0.0.1`，明文 HTTP（本机回环无威胁模型）
- **不改既有 replay 路径**：SDK / agent-loop 接入的 fork 语义（Spec #4）不动；`runs:fork` 通道不变，分叉走新通道 `proxy:fork`
- **不做 trace 格式的 span 类型扩展**：代理 run 复用既有三种 span（`agent.step`(n=1) + `llm.call`），零新 span kind
- **不新增 config.yaml 技术栈外的依赖**：HTTP 服务用 Node 内建 `node:http`，转发用全局 `fetch`，SSE 解析复用 agent-loop 已有的 `eventsource-parser`

## 边界声明（保真度）

- 代理只**观察**请求/响应字节流，**不修改**任何转发内容（请求头、body 原样透传；仅读取以供录制）——转发保真度：逐字节
- 录制产物是 trace 内自洽的数据（request/response 快照），不涉及任何工具执行，不扩大时间旅行保真度承诺；`sideEffect` 概念不适用于代理 run（无工具）
- upstream 非 2xx 时：不写 `llm.call` span，run 以 `error` 终止（LLM 失败详情不进 trace 是既有已知记录缺口，本变更不扩大也不修复它，仅保证 run 状态诚实）
- 客户端中途断连：run 以 `crashed` 终止（文件无终止事件的自然结果），已转发字节不作补偿
- 编辑 messages 重发**会真实调用 upstream 并产生 API 费用**：UI 在重发确认处明示；重发行为等价于用户在自家应用里改了消息再跑一次

## Impact

- 新增包：`packages/llm-proxy`（纯 TS + vitest，零 Electron 依赖）
- 修改包：`packages/trace-sdk`（`RunMetaSchema` 增可选 `source`、`config_hash` 放宽可选，README 字段表同步）、`packages/replay`（分叉校验拒绝无 `config_hash` 的父本，明确报错文案）、`apps/desktop`（main：代理生命周期/settings/IPC/repository/校验；renderer：设置区/状态点/列表过滤/重发编辑器/父链列表视图）
- 新增依赖：无（`node:http` + 既有 `eventsource-parser`；Monaco 已在 desktop）
- 测试：trace-sdk schema 用例（source 可选/缺省）、llm-proxy 单测（转发/录制/SSE 聚合/错误路径/分叉请求构造）、desktop 通道与状态机用例；GUI 冒烟脚本（curl + stub upstream 全程零真实 API）
- 主 spec 同步：`openspec/specs/trace-format`、`openspec/specs/desktop-ui` 各加 delta，新增 `openspec/specs/llm-proxy`
- 无破坏性变更：既有 run 文件、既有 fork 路径、既有测试全部不受影响
