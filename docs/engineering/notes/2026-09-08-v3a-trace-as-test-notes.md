# ReBaseAgent V3a — Trace-as-Test：把已封存 trace 变成 Agent 的回归测试

日期：2026-09-08　状态：实现完成并归档（`archive/2026-09-08-add-trace-as-test`）　主 spec：`openspec/specs/trace-as-test/spec.md`

## 一句话

把一次已经跑完、已经封存的 Agent trace 当**卡带**：用你**当前**的 agent-loop 代码和**当前**的工具声明，在本地把它原样重跑一遍，对新产生的轨迹做结构对齐和断言——零网络、零 API 消耗、零文件落盘，可以直接进 CI。

## 为什么

V2 之后，trace 已经是很好的人工调试资产：能看时间线、能改 tool_result 重跑、能分叉对照。但这一切都发生在"你盯着屏幕的时候"。真正的缺口是：

- 改了 loop / 工具代码，怎么知道 Agent 的执行轨迹没有悄悄变歪？——重跑一遍太贵，盯 diff 太累。
- 云端平台（LangSmith/Langfuse）能做 CI 回归，但数据出境、配置重。
- 最自然的资产其实已经在手里：每次调试都产出的 trace 本身。

于是 V3a 的答案：**trace 即测试**。录制一次的成本，换来一份可以永久跑的回归测试。

## 它测什么、不测什么（保真度边界，先说清楚）

卡带模式冻结了模型回答。所以：

| 能测 | 不能测 |
|---|---|
| 工具分发与参数校验 | 改了 prompt 模型会不会跑歪 |
| 消息构造、终止条件、预算、错误路径 | 真实模型行为变化 |
| loop / harness 层面的任何回归 | 换模型后的表现对比 |

定位就是一句话：**Agent 运行时（harness）回归测试**，不是模型行为测试。改 prompt 时测试仍会执行（卡带按调用序消费，请求差异只记 `request_drift` 不阻断），但报告会带配置漂移警告并**建议重录基线**——改 prompt 后卡带测试大概率仍然全绿，那是假阴性，不是安全。V3b（模型 A/B / 分支实验）会复用这套执行内核去补模型行为那一半。

## 它怎么工作

```text
已封存 trace（基线）
  │
  ├─ 首个 llm.call 的 request.messages ──→ 初始 messages（VCR 语义：旧输入 + 新 harness）
  ├─ 全部 llm.call 的 response ──→ 卡带 LlmClient（按调用序号吐响应）
  └─ 全部 tool.invoke 的 result/error ──→ 桩工具表（按 tool 名 + 调用序号回放，绝不执行真实工具）
  │
  ▼
当前 runLoop（headless：无 Electron、无网络、无落盘，MemoryTracer 收集新 span）
  │
  ▼
① 结构对齐（默认开启）：kind / 父子关系 / 工具名 / args 形状 / tool-call 结构 / 顺序 / outcome
   忽略 timing、usage、ttft、一切自由文本
② 用户断言：run.outcome · span.exists / span.field / span.count
③ 漂移报告：config drift · request drift · args drift（只标记，不改变通过与否）
```

几个关键语义（详见 spec 与 design）：

- **卡带按调用序消费**（三审方案 A）：第 n 次 LLM 调用取第 n 条录制响应。请求差异不硬失败——否则"改 prompt 后测试"这个最重要的场景会直接死在第一次请求上，drift 警告永远没机会出现。只有**卡带耗尽 / 有剩余**才是配置错误。
- **桩工具按 `(tool 名, 调用序号)` 匹配**，录制 error 原样抛出（错误即数据，轨迹与录制一致）。录制中出现的工具名不在当前工具表里、或某工具调用次数超出录制，都算配置错误并提示重录基线。
- **工具声明永远来自用户当前代码**，不从 trace 抄——工具协议变了，`config_hash` 漂移会直接暴露在报告里。
- **测试路径不碰 replay 的 `config_hash` 门禁**：改源码是测试常态，不是"伪装成分支"。drift（config / request / args）一律只进报告、不改变退出码。
- **代理录制的 run 自动降级**：没有 loop 配置、没有多轮轨迹，卡带重跑退化成单次回放=重言式，因此拒绝重跑，只允许显式静态断言。

## 快速上手

### 1. 录制基线

正常跑一次 Agent（SDK 直录或本地录制代理），拿到已封存 trace。

### 2. 写测试定义（独立 JSON，trace 路径相对定义文件解析）

```json
{
  "format_version": 1,
  "name": "readme-agent",
  "trace": "./fixtures/readme.jsonl",
  "assertions": [
    { "type": "run.outcome", "equals": "completed" },
    { "type": "span.exists", "selector": { "kind": "tool.invoke", "tool": "read_file" } },
    { "type": "span.count", "selector": { "kind": "tool.invoke" }, "max": 5 },
    { "type": "span.field", "selector": { "tool": "read_file" }, "field": "args.path",
      "equals": "README.md", "quantifier": "first" }
  ],
  "redact": ["path", "content"]
}
```

量词语义：`exists` 恒 `any`（零匹配即失败）；`field` 默认 `all`，可选 `first` / `nth`（配独立 `nth` 序号，1 起）；`count` 走 `min/max/equals` 阈值。缺失匹配一律失败。

### 3a. 在 Vitest/Jest 里跑（推荐，config/tools 天然来自你的代码）

```ts
import { runTraceTest } from "@rebaseagent/trace-test";
import { config, tools } from "./my-agent-config";

it("readme-agent 运行时无回归", async () => {
  const result = await runTraceTest("tests/trace-test/readme.case.json", { config, tools });
  expect(result.status).toBe("passed");
});
```

### 3b. CLI（CI-only 入口）

```bash
rebaseagent-trace-test tests/trace-test/ --config ./trace-test.config.mjs [--report json] [--update-baseline]
```

退出码：`0`=全过 / `1`=有断言失败 / `2`=有配置错误。配置模块 `default` 导出 `{ config, tools }`。

### 基线更新

合法的结构变化（比如 loop 新增了一个日志 span）会让默认对齐永久红——这是特性不是缺陷（说明它真的在测）。出路有两条，都不会静默覆盖：**重录一次 run** 覆盖 trace，或显式 `--update-baseline` 把重跑产生的新轨迹写回。

## 新包：`@rebaseagent/trace-test`

```text
packages/trace-test/
  src/cassette-llm-client.ts   卡带 LlmClient：按序消费 + request_drift + 耗尽/剩余=配置错误
  src/stub-tools.ts            桩工具表：按 (tool, 序号) 回放 result/error；args 形状漂移只报告
  src/rerun.ts                 rerunWithCassette：headless 重跑编排 + config drift 计算
  src/shape-align.ts           结构对齐：定位首个不匹配 span
  src/definition.ts            测试定义 v1 schema（zod）
  src/loader.ts                定义加载 / 相对路径解析 / 目录发现
  src/assertions.ts            断言求值（selector 匹配 + 量词语义）
  src/run-test.ts              runTraceTest runner API + 退出码映射 + 基线写回
  src/cli.ts                   CLI（bin: rebaseagent-trace-test）
```

trace-sdk 侧顺带新增 `MemoryTracer`（内存收集 + `snapshot()` 直接产出 RunRecord），reader 私有的语义序重排抽成 `toSemanticOrder` 共用——没有引入第二套 JSONL 解析器。

## 质量与验证

- **测试 65 个全绿**（本包新增），覆盖：端到端"录制→重跑→对齐"、工具错误轨迹复现、改 prompt / 改工具描述 → drift 不阻断、max_iterations 基线对齐、代理 run / 未封存 / 缺 config_hash / 卡带有剩余等全部拒绝路径、结构漂移定位、脱敏、基线更新自洽
- **CLI 真实冒烟 4/4**：drift 场景 exit 0 且报告带"建议重录基线"、`--report json` 结构稳定、缺参数 exit 2、`--update-baseline` 落盘成功
- 全仓回归：trace-sdk 75 / agent-loop 52 / replay 38 / llm-proxy 16 / desktop 115，biome 0 error
- `openspec validate --all --strict` 9/9 通过

## 提交链

| commit | 内容 |
|---|---|
| `89e3767` | 执行内核（2.1a–2.1e） |
| `adde442` | 定义 / 断言 / runner API / CLI / 基线更新（1.1–3.3, 4.1–4.2） |
| `10f06be` | README / HANDOFF 文档（4.3） |
| `51b3f36` | openspec 归档（主 spec 新增 trace-as-test，9 requirements） |

过程记录见 `docs/reviews/2026-09-08-v3-trace-as-test-review.md`（三审放行：卡带按序消费方案 A、初始 messages 来源、桩工具匹配键、基线更新出口、MemoryTracer 落点）。

## 已知限制（诚实声明）

- 测不了 prompt / 模型漂移（V3b 的活）；改 prompt 后的"全绿"是假阴性，报告会提醒但不会替你重录
- 结构对齐只看形状：args 的**值**变了不报警（那是 `span.field` 断言的职责），写了字段断言才管得住
- 包未发 npm：CI 里要装 `@rebaseagent/trace-test`，目前只能在 monorepo 内或走 GitHub Actions + workspace 构建
- 目前只有本包测试与 CLI 冒烟，还没有挂进真实 CI 矩阵
- trace 含完整 prompt / 响应 / 工具参数——提交进仓库前先脱敏或重录；`redact` 只管报告摘要，不改 trace 文件

## 下一步候选

1. **V3b 立项**——模型 A/B / 分支实验（复用卡带执行内核，补上"模型行为"那一半）
2. **钩子 demo**——改第 N 步脏 tool_result → 只重跑后半段（产品化缺口 ②）
3. **trace-test 进真实 CI**——GitHub Actions 最小矩阵，让"进 CI"真正落地
4. **1/4 成本真实链路实测**——拿真数字进 README
