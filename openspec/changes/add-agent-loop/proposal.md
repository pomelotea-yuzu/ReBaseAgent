# Proposal: add-agent-loop

## Why

trace-sdk（Spec #1）定义了"上下文程序"的序列化格式，但还没有东西能**产生** trace：产品需要一个真正运行 Agent 的执行内核，既是 dogfood 的第一个用户，也是后续时间旅行/重放的被观测对象。地基已就绪，此为路线图第二块。

## What Changes

- 新增 `packages/agent-loop`：纯 TS 库，**零 Electron 依赖**，实现 OpenAI 兼容协议的 Agent 执行循环

- `RunConfig`：模型接入（baseURL/apiKey/model）、system prompt、工具表、采样参数、`exec = { cwd, signal }`、`max_iterations`、预算上限

- LLM 客户端：OpenAI 兼容 chat completions **流式直连**（fetch + SSE，eventsource-parser），支持 `reasoning_content`（DeepSeek reasoner）与 `tool_calls` 增量解析

- 核心循环：纯函数式 `runLoop(config, messages, tracer)`——运行中可变状态仅 messages（追加）；计数/成本从 messages 派生，禁止自增累积

- 工具执行：在 `exec.cwd` 落点执行；工具失败 → 带 error 的 tool\_result（错误是数据不是异常），loop 决定继续或停止

- 终止条件：`completed`（模型不再调工具）/ `max_iterations` / `budget_exceeded` / `aborted`（signal 优雅收尾，非硬杀）/ `error`（仅 loop 自身 bug 抛出）

- 观测：全部经 Spec #1 的 Tracer 流出（agent.step / llm.call / tool.invoke / run.event），loop 自身不写文件

- config 指纹：run 开始时对 system prompt + 工具表计算 `config_hash` 写入 run.meta，供反事实重放前判断两次运行源代码是否相同

### 从讨论定稿、本次必须落实的细节

1. **执行上下文**：`RunConfig.exec = { cwd, signal }`——cwd 指向沙箱/工作目录（工具执行的落点）；signal 为 AbortSignal，用户点停止 → loop 优雅收尾 → 写入 `run.event: aborted`
2. **config 指纹**：`config_hash`（sha256）覆盖 system prompt + 工具表定义——反事实重放前判断"两次运行的源代码是否相同"
3. **成本约束**：全程开发预算 < ¥10（标本用便宜国产模型 + 测试用 mock LLM 零 API 消耗）
4. **为时间旅行预留的连通性**：分支请求前缀与原运行完全一致，天然命中 provider 的 prompt caching（Anthropic/OpenAI 前缀缓存只收 10%-25%），分支实验成本约为从头跑的 1/4 以下——loop 的消息构造不得破坏前缀稳定性（同输入 → 同请求体）

## Capabilities

### New Capabilities

- `agent-loop`: Agent 执行循环——RunConfig 定义、LLM 流式调用、工具执行、终止条件与 Tracer 观测输出的行为契约

### Modified Capabilities

（无——trace-format 的既有 Requirement 不变；agent-loop 只是消费 Tracer 接口）

## Non-goals

- 不做时间旅行/replay（fork/编辑/查表回退是 Spec #4 replay 的职责）

- 不做任何沙箱实现本身（`exec.cwd` 指向外部提供的目录；沙箱副本创建属桌面端）

- 不做多 provider SDK 适配——只实现 OpenAI 兼容协议直连（DeepSeek/GLM-Flash 均兼容此协议）；不做 Anthropic 原生协议

- 不做密钥存储（safeStorage 是 Electron 层的事；本包只接受明文 apiKey 入参）

- 不做 UI / 进度推送（事件流已可订阅，渲染属 Spec #3）

- 不做工具库内置（read\_file/write\_file 等具体工具在 apps/examples 标本里定义）

- 不录制原始 SSE chunk 流（trace 格式已预留 `chunks` 可选字段，默认关闭，本变更不启用）

## 保真度边界（为后续 replay spec 立契约）

本变更不实现重放，但循环设计必须维持可重放性：

- loop 内状态（messages）完整可序列化，从任意 llm.call 的 `request.messages` 可查表恢复

- 工具定义 SHALL 携带副作用标注（`sideEffect: boolean`，默认 true），供 replay spec 区分 pure（可零成本重放）与 best-effort（需真实重执行）工具

- 外部状态源（RAG/记忆/DB）不在承诺范围——工具只能通过 args/result 与 loop 交换数据

## Impact

- 新增包：`packages/agent-loop`（依赖 `@rebaseagent/trace-sdk`、`eventsource-parser`、`zod`——均在已定稿技术栈内）

- 无破坏性变更：纯新增包，不触碰已有代码

- 测试用 mock LLM（fetch 层注入），零 API 消耗；真实模型联调用标本 agent（apps/examples，另一变更）

