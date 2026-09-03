# @rebaseagent/agent-loop

ReBaseAgent 的 Agent 执行循环：OpenAI 兼容协议流式直连 + 工具执行 + Tracer 观测。纯 TypeScript，零 Electron 依赖。消费 [`@rebaseagent/trace-sdk`](../trace-sdk) 的事件流接口。

## API 概览

```ts
import { runLoop, parseRunConfig, OpenAiCompatClient, configHash } from "@rebaseagent/agent-loop";
import { JsonlTracer, NullTracer } from "@rebaseagent/trace-sdk";

const config = parseRunConfig({
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-...",
  model: "deepseek-chat",
  systemPrompt: "你是文件助手。",
  tools: [{ name: "read_file", description: "读取文件", parameters: { type: "object", properties: {} }, sideEffect: false }],
  params: { temperature: 0.7 },
  exec: { cwd: "D:/sandbox", signal: null },   // signal 可为 null（不支持中止）
  maxIterations: 25,
  budget: { maxTotalTokens: 100000 },          // maxTotalTokens 或 maxCost 至少其一
});

const result = await runLoop(
  config,
  [{ role: "system", content: config.systemPrompt }, { role: "user", content: "读 README" }],
  new JsonlTracer("traces/r_01.jsonl"),          // 或 NullTracer（无文件运行）
  tools,                                          // 含 handler 的工具（定义须与 config.tools 一致）
  new OpenAiCompatClient(config),                 // 可注入自定义 fetch（测试）
);
// result: { messages（完整演化）, event: { event, reason, at } }
```

## 核心不变量

- **纯函数四不变量**：`runLoop` 输入只有 config + messages + tracer + tools；运行中可变状态仅 messages（只追加）；迭代计数/累计成本从 usage 派生（`deriveTotalTokens`），禁止自增累积；无模块级可变状态

- **错误是数据不是异常**：工具失败 → `renderToolError` 渲染为 tool\_result 文本追加进 messages，loop 继续；loop 只抛自身 bug（配置校验失败等）

- **五种终止**：`completed` / `max_iterations` / `budget_exceeded` / `aborted`（signal 优雅收尾）/ `error`（LLM 请求失败，不重试）

## config\_hash（源代码指纹）

`configHash(systemPrompt, tools)` = sha256 of 规范化 JSON（键排序、工具按 name 排序）。

- **只覆盖"源代码"**：system prompt + 工具表（含 sideEffect 标注）。model / params 不参与——同源代码换模型/温度属于合法对比实验，指纹不变

- 用途：反事实重放（Spec #4）前判断两次运行的源代码是否相同

## 前缀逐字节稳定

`buildRequestBody(config, messages)` 为纯函数：同输入 → 同请求体（消息原样传递、工具 error 用固定模板渲染、不混入时间戳/随机 id）。这是分支运行命中 provider prompt caching（Anthropic/OpenAI 前缀缓存只收 10%-25%，分支实验成本约为从头跑的 1/4 以下）的前提。**任何修改本包消息构造的 PR 都不得破坏此性质**（有对应测试守护）。

## LLM 客户端

`OpenAiCompatClient`：fetch 直连 `/chat/completions`（SSE 流式，`stream_options.include_usage`），聚合 `content` / `reasoning_content`（DeepSeek reasoner / GLM 扩展）/ `tool_calls`（按 index 聚合 arguments 分片）/ `usage` / `ttft_ms`。失败统一抛 `LlmRequestError`。

工具协议为 OpenAI function calling 子集：`{ name, description, parameters, sideEffect? }` + `handler(args, ctx)`，ctx = `{ cwd, signal }`。`sideEffect`（默认 true）随工具表进入 trace 请求记录，供 replay spec 做保真度分级。

## 测试（零 API 消耗）

所有测试注入 mock（`MockLlmClient` / `fetchReturningSse`），无任何网络请求：

```bash
pnpm --filter @rebaseagent/agent-loop test
```

