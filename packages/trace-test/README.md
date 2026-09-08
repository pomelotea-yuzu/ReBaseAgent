# @rebaseagent/trace-test

> Trace-as-Test（V3a）：把已封存的 trace 当**卡带**，用你**当前**的 agent-loop 与**当前**工具声明在本地重跑一遍——零网络、零 API 消耗、零落盘的 Agent 运行时回归测试。

## 定位（先读这个）

卡带模式**冻结了模型回答**。它测的是 **Agent 运行时（harness）回归**：工具分发、参数校验、终止条件、预算、错误路径——也就是"我没改 prompt，但改了 loop / 工具代码，Agent 还会跑出同样的轨迹吗"。

它**测不了**"改了 prompt / 换了模型会不会跑歪"（那需要真实调用，属 V3b 分支实验的范畴）。改了 prompt 时测试仍会执行（卡带按调用序消费，请求差异只记 `request_drift` 不阻断），但报告会带配置漂移警告并**建议重录基线**——改 prompt 后卡带测试大概率仍然全绿，那是假阴性，不是安全。

## 快速开始

### 1. 录制基线

正常跑一次 Agent（SDK 直录或本地录制代理），得到已封存的 trace JSONL（有终止事件）。

### 2. 写测试定义

```json
{
  "format_version": 1,
  "name": "readme-agent",
  "trace": "./fixtures/readme.jsonl",
  "assertions": [
    { "type": "run.outcome", "equals": "completed" },
    { "type": "span.exists", "selector": { "kind": "tool.invoke", "tool": "read_file" } },
    { "type": "span.count", "selector": { "kind": "tool.invoke" }, "max": 5 },
    { "type": "span.field", "selector": { "tool": "read_file", "n": 1 }, "field": "args.path", "equals": "README.md", "quantifier": "first" }
  ],
  "redact": ["path", "content"]
}
```

要点：

- `trace` 相对**定义文件**解析（CI 换工作目录不崩）
- 结构对齐**默认开启**，无需声明；`{ "type": "trace.shape", "enabled": false }` 可按定义关掉
- 量词：`exists` 恒 `any`（零匹配即失败）；`field` 默认 `all`，`first` / `nth`（配独立 `nth` 序号，1 起）；`count` 走数量阈值。缺失匹配一律失败

### 3a. 在 Vitest/Jest 里跑（推荐）

```ts
import { runTraceTest } from "@rebaseagent/trace-test";
import { config, tools } from "./my-agent-config"; // 你当前的配置与工具（含 handler）

it("readme-agent 运行时无回归", async () => {
  const result = await runTraceTest("tests/trace-test/readme.case.json", { config, tools });
  expect(result.status).toBe("passed");
});
```

config / tools 来自你的代码——工具协议变了，`config_hash` 漂移会直接暴露在报告里。

### 3b. CLI（CI-only 入口）

```bash
rebaseagent-trace-test tests/trace-test/ --config ./trace-test.config.mjs [--report json] [--update-baseline]
```

- 配置模块 `default` 导出 `{ config: RunConfig, tools: Tool[] }`
- 退出码：`0`=全部通过 / `1`=有断言失败 / `2`=有配置错误
- `--update-baseline`：把卡带重跑产生的新轨迹显式写回 trace 路径。合法的结构变化（如新增日志 span）会让默认对齐永久红——重录一次 run，或用此旗标更新基线。**测试失败时绝不静默覆盖**

## 语义速查

| 项 | 行为 |
|---|---|
| 初始 messages | 首个 `llm.call` 的录制 `request.messages`（含录制 system）——VCR 语义：旧输入 + 新 harness |
| 卡带消费 | 按调用序号（第 n 次调用 → 第 n 条录制响应）；请求差异只记 `request_drift` |
| 配置错误（exit 2） | 卡带耗尽 / 有剩余、工具表不兼容（缺工具名 / 调用超录制）、trace 未封存、定义非法 |
| 桩工具 | 按 `(tool 名, 调用序号)` 返回录制 result / 抛录制 error，绝不执行真实工具 |
| 结构对齐 | kind、父子关系、工具名、args 形状、tool-call 结构、顺序、outcome；忽略 timing / usage / ttft / 自由文本 |
| drift（config/request/args） | **不改变通过与否**，只进报告；存在即建议重录基线 |
| 代理录制的 run | 拒绝卡带重跑（单次响应回放不构成回归测试），自动降级为显式静态断言模式 |

## 隐私警告

**trace 包含完整的 prompt、模型响应与工具参数。** 把 trace 提交进仓库 = 把这些内容提交进仓库。提交前先脱敏或重录；定义里的 `redact` 只影响测试报告摘要，不会改动 trace 文件本身。

## 路线

- **V3a（本包）**：运行时回归测试——确定性执行内核，进 CI
- **V3b（未开始）**：分支实验 / 模型 A-B 对比（复用 V3a 的执行内核）
