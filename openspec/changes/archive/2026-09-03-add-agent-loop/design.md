# Design: add-agent-loop

## Context

trace-sdk（Spec #1）已提供 Tracer 事件流与 trace 格式 v1。本变更是其第一个消费者：产出标准 trace 的 Agent 执行内核。动机见 proposal.md，行为要求见 specs/agent-loop/spec.md。约束：纯 TS、零 Electron 依赖、不引入已定稿技术栈外的新依赖。

## Goals / Non-Goals

**Goals:**

- 确定性可测的执行循环（mock fetch 下全流程可断言）
- 消息演化与 trace 产出严格对应（后续 replay 的查表地基）
- 请求体前缀逐字节稳定（prompt caching 命中的前提）

**Non-Goals:**

- 不做重放/分支（Spec #4）、不做 UI（Spec #3）、不做沙箱与密钥（Electron 层）
- 不做请求重试的指数退避策略——固定 1 次（预算敏感，失败即终止）

## Decisions

### D1：runLoop 为 async 函数而非生成器

循环骨架：`runLoop(config, messages, tracer): Promise<RunResult>`，内部 while 迭代。备选：async generator 逐轮 yield（UI 可更早消费）——但事件流已经由 Tracer 承担实时观测职责，生成器只会引入双通道，弃。终止后返回 `{ messages, event }` 供调用方直接使用。

### D2：纯函数四不变量的落法

- 模块顶层只有常量与纯函数，无 let/单例缓存
- messages 是唯一可变量，且只经 `messages.push(...)` 追加（assistant 消息、每轮若干 tool 消息）
- 迭代数 = agent.step span 计数（局部变量仅作循环控制，不落盘）；累计成本 = 各 llm.call usage 求和，每轮从 messages 派生重算，不维护累加器
- 确定性：请求体构造为纯函数 `buildRequestBody(config, messages)`，同输入同输出

### D3：LLM 客户端 = fetch 注入 + SSE 解析为纯函数

`LlmClient` 接口只有一个方法 `complete(request): Promise<LlmResponse>`。默认实现 `OpenAiCompatClient`：

- 构造时注入 `fetchImpl`（默认 globalThis.fetch；测试注入 mock）
- 请求体：`{ model, messages, tools?, params, stream: true, stream_options: { include_usage: true } }`
- SSE 解析：eventsource-parser 逐 event，聚合 `content`（delta.content 拼接）、`reasoning_content`（delta.reasoning_content，DeepSeek/GLM 兼容）、`tool_calls`（按 index 聚合 arguments 分片）、usage（最后一个 chunk）
- ttft_ms：首个含内容 delta 的 chunk 与请求发出时刻之差
- 错误分类：网络/HTTP 非 2xx / SSE 中断 / 响应缺 usage——统一抛 `LlmRequestError`，由 loop 决定终止（reason: error）

### D4：工具协议 = OpenAI function calling 子集

工具定义：`{ name, description, parameters, sideEffect? }`，注册为 `Map<string, ToolDef>`。执行：JSON.parse args（解析失败 → error tool_result，模型下轮自纠）；handler 签名 `(args, ctx) => Promise<string>`，ctx = `{ cwd, signal }`。工具抛出的任何异常都捕获为 error 文本——**loop 只抛自身 bug**（配置校验失败、Tracer 误用、不变量破坏）。

### D5：终止检查顺序

每轮 agent.step 完成后依序检查：signal.aborted → max_iterations → budget_exceeded → 模型无 tool_calls（completed）。signal 检查同时发生在 LLM 流式读取与工具执行中（fetch 原生支持 AbortSignal；工具收到 ctx.signal 自行判断）——两处中止都走同一条优雅收尾路径：保证当前 span 完整记录后写 `aborted` 事件再封存，绝不留下开启的 span。

### D6：config_hash 覆盖"源代码"而非"全部配置"

指纹 = sha256(规范化 JSON of { systemPrompt, tools: [{name, description, parameters, sideEffect}] })，按 name 排序。model/params 不参与——同类实验常换模型对温度，源代码没变。规范化序列化（键排序、无空白）保证跨平台稳定。

### D7：前缀逐字节稳定的实现纪律

messages 追加进请求体时原样传递（不重排、不增删字段）；tool 消息的 content 用固定模板渲染 error；请求体序列化不混入时间戳/随机 id。这条纪律是 Spec #4 分支实验命中 provider 缓存（成本 1/4 以下）的前提，design 层面立为不变量。

### D8：Tracer 集成点

startRun（meta 含 config_hash）→ 每轮 startSpan(agent.step) → llm.call（request 原样 = buildRequestBody 的 messages+tools+params）→ 各 tool.invoke → endSpan(step) → endRun(终止事件)。llm.call 的 response 即 D3 聚合产物——trace 记录与内存 messages 同构，replay 可查表。

## Risks / Trade-offs

- [SSE 增量格式在各家（DeepSeek/GLM/开源网关）有细微差异] → 聚合器只依赖 OpenAI 规范字段 + reasoning_content 扩展，未知 delta 字段忽略；联调阶段用标本 agent 补真实样本
- [usage 缺失（部分网关不回）] → 缺失时记 0 并在 response 标注，预算判断退化为保守可用
- [长对话每轮全量重算成本，O(n²) 总开销] → 单 run 轮次规模（几十轮）下可忽略；换来派生正确性
- [abort 发生在流式响应中途] → 收尾路径统一：已聚合部分丢弃（不产生半 span），messages 停在上一个完整轮次，aborted 事件照写——与"崩溃不产生半行"同一精神
- [工具执行慢阻塞 signal 响应] → ctx.signal 透传给工具（文件操作类可用 AbortSignal 检查点），loop 不强杀
