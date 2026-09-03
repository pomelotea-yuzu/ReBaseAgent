# Tasks: add-agent-loop

## 1. 包脚手架与配置层

- [x] 1.1 `packages/agent-loop` 脚手架：package.json（依赖 @rebaseagent/trace-sdk、eventsource-parser、zod）/ tsconfig / 接入根 biome
- [x] 1.2 `RunConfig` zod schema：模型接入 / systemPrompt / 工具表 / params / `exec = { cwd, signal }` / maxIterations / 预算上限；单测覆盖缺字段拒绝与 signal 可空（对应 Requirement 1 两个 Scenario）

## 2. LLM 客户端（OpenAI 兼容流式直连）

- [x] 2.1 `OpenAiCompatClient`：fetch 注入 + chat completions 请求体构造（stream / include_usage / tools / params）
- [x] 2.2 SSE 聚合器：content / reasoning_content / tool_calls（按 index 聚合 arguments 分片）/ usage / ttft_ms；单测用编排的 SSE 序列断言聚合结果（对应"流式响应完整聚合"Scenario）
- [x] 2.3 错误处理：网络 / HTTP 非 2xx / 流中断统一抛 `LlmRequestError`；单测 401 与中断路径（对应"请求失败"Scenario）

## 3. 工具执行层

- [x] 3.1 工具定义与注册：`{ name, description, parameters, sideEffect? }`（默认 true）；sideEffect 随工具表进入 trace 请求记录（对应"副作用标注"Scenario）
- [x] 3.2 工具执行器：JSON.parse args（失败→error tool_result）、handler 接收 `{ cwd, signal }`、异常捕获为 error 文本；单测 ENOENT 后 loop 继续（对应"工具报错但 loop 继续"Scenario）

## 4. 核心循环

- [x] 4.1 `runLoop` 骨架：纯函数四不变量（messages 唯一可变、只追加；计数/成本从 messages 派生；无模块级状态）；单测同输入两次运行轨迹一致（对应"同输入同轨迹"、"历史不可变"Scenario）
- [x] 4.2 终止条件：completed / max_iterations / budget_exceeded 判定与 run.event 写入；单测各覆盖一个（对应"任务完成"、"死循环停止"、"预算超限"Scenario）
- [x] 4.3 abort 优雅收尾：signal 检查点（轮间 / LLM 流中 / 工具执行中），当前 span 完整记录后写 aborted；单测中途 abort 无半 span（对应"用户中止"Scenario）
- [x] 4.4 Tracer 集成：startRun（含 config_hash）→ agent.step / llm.call / tool.invoke / endRun；NullTracer 下事件流断言 + JsonlTracer 下产物过 readRun 校验（对应"无文件运行"、"文件运行"Scenario）

## 5. 指纹与前缀稳定

- [x] 5.1 `configHash`：规范化 JSON（键排序、工具按 name 排序）sha256；单测同源同指纹 / 增删工具变指纹（对应 Requirement 8 两个 Scenario）
- [x] 5.2 请求前缀稳定：`buildRequestBody` 纯函数 + 固定 error 渲染模板；单测相同 messages 两次序列化逐字节一致（对应"分支前缀复现"Scenario）

## 6. 收尾

- [x] 6.1 端到端 mock 测试：多轮对话（含工具调用、工具失败、终止各路径）零网络请求（对应"零 API 测试"Scenario）
- [x] 6.2 包内 README（API 概览 + config_hash/前缀稳定性说明）；`pnpm test` 全绿 + biome + tsc 通过后按 openspec 流程归档
