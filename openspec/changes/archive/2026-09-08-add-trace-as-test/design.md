# 设计

## 测试定义

测试定义独立于 trace，路径相对定义文件解析：

```json
{
  "format_version": 1,
  "name": "readme-agent",
  "trace": "fixtures/readme.jsonl",
  "assertions": [
    { "type": "run.outcome", "equals": "completed" },
    { "type": "trace.shape", "equals": "recorded" },
    { "type": "span.exists", "selector": { "kind": "tool.invoke", "tool": "read_file" }, "quantifier": "all" }
  ]
}
```

v1 不设置 `mode` 字段，唯一执行语义就是卡带 world-free。代理 run（`meta.source.kind=proxy` 或缺少可用 loop 配置）拒绝卡带重跑并只允许显式静态断言。

## 卡带重跑

1. 校验定义、路径和 trace；要求 trace 已封存。
2. 初始 messages 取首个 `llm.call` 的 `request.messages`，包含录制的 system/user 输入。随后从 trace 的 `llm.call` span 按调用顺序构造 `LlmClient`；请求结构差异记录为 `request_drift`，不阻断消费卡带响应。卡带耗尽或仍有未消费响应才返回配置错误。
3. 从当前用户代码提供的工具声明构造工具表；每个 handler 按 `(tool name, invocation sequence)` 取对应记录的 `result/error`，args 差异交给轨迹对齐和字段断言报告，不执行真实工具。
4. 使用 `trace-sdk` 基于 `BaseTracer` 的新增 `MemoryTracer` 调用当前 `runLoop(config, messages, tracer, tools, cassetteClient)`，不调用网络、不写 trace 文件。
5. 对新产生的 span 与记录轨迹做结构性对齐，默认比较 span kind、父子关系、工具名、工具 args 形状、LLM tool-call 结构、顺序和最终 outcome；忽略 timing、usage、ttft 与自由文本响应。
6. 执行用户声明的断言并汇总结果。

测试路径不调用 `replayRun`，因此不受其同源 replay 的 `config_hash` 拒绝门禁影响。runner 计算当前配置 hash，与记录值不同则返回 `config_drift` 警告；工具声明始终来自当前代码，配置漂移仍可暴露工具协议变化。

## 断言选择器

span 选择器至少支持 `kind`、`tool`、`n` 和 `id`；匹配结果明确使用 `first`、`nth` 或 `all`，缺失匹配即失败。默认量词：`span.exists` 默认 `any`、`span.field` 默认 `all`、`span.count` 走数量阈值。`run.outcome` 对齐 trace 的终止 reason 枚举：`completed`、`max_iterations`、`budget_exceeded`、`aborted`、`error`。字段比较使用结构化 JSON 比较。录制中出现的工具名不在当前工具声明中，或某工具调用次数超出录制，均按配置错误处理（提示重录基线），不算断言失败。

## 集成与报告

核心 API 先作为 Vitest/Jest 可调用函数提供，测试 runner 负责配置、工具和报告上下文；CLI 作为 CI-only 入口，支持单定义和定义目录。退出码固定为 `0=passed`、`1=assertion failed`、`2=configuration/error`。JSON 报告包含定义名、状态、run id、span id、config drift、request drift、失败断言和错误类别。结构对齐基线默认开启；更新基线通过重新录制 trace 覆盖测试资产，或显式使用 `--update-baseline`，不得静默更新。

trace 可能包含完整 prompt、响应和工具参数。文档必须警告不要未经脱敏提交敏感 trace；失败摘要默认截断并脱敏敏感字段，定义可声明 redact 规则。
