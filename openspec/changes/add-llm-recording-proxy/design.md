# Design: add-llm-recording-proxy

> 决策日期：2026-09-05。上游依据：`docs/product.md` §4（零摩擦接入）与同日评审（方案 a 定稿）。

## D1 · 分叉用「单请求级最小分叉」（方案 a），不走 replay 包

评审确认的断层：Spec #4 fork 语义依赖 `tool.invoke` 叶子 span、工具表侧录、config\_hash；代理只看到独立 `chat.completions`，三者皆无。候选方案：

- **a) 单请求级最小分叉（采纳）**：编辑 messages → 代理用暂存 key 重发单请求 → 新 run 记 fork meta。实现上比 runLoop fork 简单（无工具编排、无截断拼接），且让 JTBD ② 在代理路径成立
- b) 代理只看不能改重跑 → 对 LangSmith 差异只剩「本地」，否决
- c) 启发式聚合同会话成 run 再走 replay → 易错、误判不可控，否决

fork meta 复用既有结构（`parent` / `at_span` / `edit{field,value}`），`edit.field="messages"` 是新枚举值（既有仅 `"result"`；trace 层 field 本就是自由 string，硬编码 literal 只在 `runs:fork` 的 IPC schema——proxy fork 走新通道不碰它）。**分支视图写死为降级（勿悬置）**：`resolveBranch` 保持原样不加 proxy 形态——proxy fork 的 `at_span` 指向 llm.call、编辑的是 messages，没有任何 replay 层去应用编辑，直接拼接会出现「旧 messages 的 llm.call + 新 messages 的 llm.call」混排假时间线、编辑生效点不可见。故 desktop 分支区对 `fork.edit.field="messages"` 的 run 一律呈现**父链列表**（逐代 run + 编辑摘要，点击切换详情），诚实且实现最省。

## D2 · 每请求一 run：agent.step(n=1) + llm.call 子 span

不发明新 span kind。理由：desktop-ui 的 SpanTree / DetailPanel / 派生函数都按既有三 kind 设计；包一层 `agent.step` 与既有 UI 结构（步骤含调用）一致，成本最低。字段口径（评审后写死，勿悬置）：

- **meta**：`source = { kind: "proxy", base_url: <代理自身监听地址> }`（即用户应用填的那个 base\_url，非 upstream）；`task = "(llm-proxy)"` 常量（确定性，不做首条消息截断启发式）；**无 `config_hash`**——`RunMetaSchema.config_hash` 由必填放宽为可选（存在时仍 min(1)），老文件均含该字段不受影响；无 config\_hash 的 run 由校验层拒绝作 replay 父本
- **request**：`messages` / `model` / `tools`（无则空）；请求体顶层除 `model`/`messages`/`tools`/`stream` 外的字段（temperature、max\_tokens 等）平铺进 `params`；请求头一律不录
- **response**：流式聚合照抄 llm-client 的 `usage: null` 容错；流式结束仍无 usage 兜底 `{0,0}`；**非流式 `ttft_ms` 记 `0`**（无 TTFT 概念，诚实为零，不拿总耗时冒充）

## D3 · 新包 packages/llm-proxy：核心为可注入的纯逻辑 + 极薄服务壳

- `createProxyHandler({ upstreamBaseUrl, fetchImpl?, recorder, keyStore })`：纯逻辑，`fetchImpl` 可注入 → 单测全程 stub，零真实 API
- `startProxyServer({ port, handler })`：`node:http` 薄壳，仅绑 `127.0.0.1`
- SSE 解析复用 `eventsource-parser`（已在 agent-loop 用过，非新依赖）
- 录制数据不直接写文件：`recorder` 接口由 desktop 注入（main 侧接 RunRepository + JsonlTracer），包本身零 fs —— 与 trace-sdk「Tracer 是唯一观测出口」同构

## D4 · upstream 配置与转发保真

settings 增 `proxy: { enabled, port (默认 8787), upstreamBaseUrl (默认 https://api.deepseek.com) }`，复用既有 SettingsStore。转发**原样字节**：`node:http` 读出 raw body（Buffer），注入 `fetch` 转发，响应流直接 `pipe` 回客户端——代理在字节层是哑管道，只在旁边旁路聚合录制数据。不做请求改写（不做「改 model 映射」「注入系统 prompt」等花活，Non-goal 防线）。

## D5 · key 仅内存暂存

main 进程模块级单例 `keyStore = { lastKey?: string, capturedAt?: Date }`：每次代理请求从 `Authorization` 头捕获更新。**语义是「最近捕获」**：用户应用中途换 key 后，分叉重发用的是最新值而非源 run 录制当时的值——可接受（key 属于用户应用，ReBaseAgent 只借用不保管），UI 提示语点明。不进 safeStorage、不进 settings、不进 IPC 回传（`proxy:status` 只回 `hasKey: boolean`）。进程重启即失效——这是与 SettingsDialog 兜底 key（持久化）刻意区分的安全等级。

## D6 · IPC 三通道 + 渲染层状态机

- `proxy:status`（读）→ `{ enabled, running, port, upstreamBaseUrl, hasKey }`
- `proxy:toggle`（写）→ 启停，端口占用等错误走信封 error
- `proxy:fork`（写）→ `{ parentRunId, atSpanId, messages }` → main 校验源 run 为已封存代理 run、messages 与原值不同（空 fork 防线在 main 复核一次，渲染层禁用只是 UX）→ 经 llm-proxy 分叉路径发 upstream（用暂存 key）→ 录新 run → 返回新 run id
- 请求体走 `src/shared/ipc.ts` 的 zod schema（既有约定）；渲染层 forking 状态机复用 Spec #4 的三态（in\_progress / success / error）

## D7 · 渲染层改动收敛

- SettingsDialog 加代理区（三个字段，复用既有保存流程）
- header 加状态点（绿=running，含端口；灰=stopped；「未捕获 key」小标）
- RunList：徽标 + 过滤下拉（全部/仅代理/仅本地），`source` 从 meta 判断
- DetailPanel：`llm.call` 且 run 为代理来源时显示「编辑重发」；编辑器复用 Monaco 懒加载模式（预填 = JSON.stringify(request.messages)，提交 = 解析回结构体；解析失败可见报错）
- 既有 ForkEditor（tool.result）对代理 run 隐藏（代理 run 无 tool.invoke span，天然不出现）

## D8 · 测试与冒烟策略

- llm-proxy：stub `fetchImpl` 覆盖 非流式/流式/upstream 4xx/客户端断连/路径 501/key 捕获/fork 请求构造，目标 ~15 例
- trace-sdk：source 可选 schema 3 例
- desktop：settings proxy 字段、IPC schema、store 过滤状态、fork 请求体校验
- GUI 冒烟：`gen-smoke-proxy-run.cjs`（stub upstream 返回固定 SSE）+ curl 走一遍：改 base\_url → 录 run → 看时间线 → 编辑 messages 重发 → 分叉链展示，全程零真实 API

## D9 · 已知记录缺口（不扩大）

upstream 非 2xx 的错误响应体不进 trace（格式无此字段）——与 HANDOFF 已记录的「LLM 失败详情不进 trace」同源，属 trace 格式层缺口，本变更不修；run 以 `stopped/error` 终止保证状态诚实。
