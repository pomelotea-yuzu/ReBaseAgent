# @rebaseagent/trace-sdk

ReBaseAgent trace 格式 v1 的采集与读取 SDK：zod schema、Tracer 事件流、JSONL 读写器与分支解析。纯 TypeScript，零原生依赖、零 Electron 依赖。

## 格式总览

trace 文件是 JSONL，一 run 一文件，append-only：

- 首行 `run.meta`（且只能是首行）

- 若干 `span` 行（三种 kind，构成树）

- 0 或多个 `run.event` 行；正常结束以终止事件收尾，之后文件封存、不可再修改

```
run.meta  →  span(agent.step)  →  span(llm.call)  →  span(tool.invoke)  →  ...  →  run.event
```

崩溃的 run（进程中断、无终止事件）是合法状态：读取器判定为 `crashed`，已写入的行保持完整。

## 字段表

### run.meta（首行）

| 字段               | 类型             | 说明                         |
| ---------------- | -------------- | -------------------------- |
| `type`           | `"run.meta"`   | 行类型判别                      |
| `id`             | string         | run id（文件内唯一标识）            |
| `format_version` | `1`            | 格式版本；更高版本读取器显式报错           |
| `task`           | string         | 任务描述                       |
| `model`          | string         | 模型名（如 `deepseek-chat`）     |
| `created_at`     | string         | ISO 8601 创建时间              |
| `parent`         | string \| null | 父 run id；根 run 为 null      |
| `fork`           | object \| null | 分支信息，见下                    |
| `config_hash`    | string         | 源配置指纹（system prompt + 工具表） |

`fork`：

| 字段           | 类型      | 说明                                |
| ------------ | ------- | --------------------------------- |
| `at_span`    | string  | 分叉点 span id（该 span 保留在共享前缀中，含于前缀） |
| `edit.field` | string  | 被编辑的字段名（如 `"result"`）             |
| `edit.value` | unknown | 新值。编辑语义由 replay 层应用               |

### span（三种 kind，共同字段：`type: "span"`、`id`、`parent`（父 span id，根为 null）、`timing`（可选））

`timing`：span 的墙上时钟区间，由 Tracer 在 start/endSpan 时自动记录

| 字段                    | 类型     | 说明                                                     |
| --------------------- | ------ | ------------------------------------------------------ |
| `timing.started_at`   | string | 起始时刻，ISO 8601（毫秒精度）                                   |
| `timing.ended_at`     | string | 终止时刻，ISO 8601；与 started\_at 成对出现                       |
| `timing`（整体缺省）        | —      | 老文件与手工构造数据合法缺失；读取器不报错，**耗时视为未知**，不得用其他字段推断 |

`timing` 与 `tool.invoke.dur_ms` 不冲突：后者是"工具执行耗时"的权威值，前者提供跨 span 的统一时间坐标（时间轴、step 聚合）。

**agent.step** — 一轮 loop 迭代

| 字段     | 类型             | 说明     |
| ------ | -------------- | ------ |
| `kind` | `"agent.step"` | <br /> |
| `n`    | int ≥ 1        | 迭代序号   |

**llm.call** — 一次 LLM 调用

| 字段                           | 类型             | 说明                                                                                 |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `kind`                       | `"llm.call"`   | <br />                                                                             |
| `request`                    | object         | 原样录制完整请求：`model` / `messages` / `tools`? / `params`?。`messages` 可直接作为重放输入（查表，无需重建） |
| `response.content`           | string \| null | 正文                                                                                 |
| `response.reasoning_content` | string \| null | 思维链（推理模型）；非推理模型为 null                                                              |
| `response.tool_calls`        | array          | 工具调用列表，默认 `[]`                                                                     |
| `response.usage`             | `{ in, out }`  | token 用量                                                                           |
| `response.ttft_ms`           | number         | 首 token 时延（毫秒）                                                                     |

**tool.invoke** — 一次工具执行

| 字段       | 类型              | 说明                                                  |
| -------- | --------------- | --------------------------------------------------- |
| `kind`   | `"tool.invoke"` | <br />                                              |
| `tool`   | string          | 工具名                                                 |
| `args`   | object          | 入参                                                  |
| `result` | unknown         | 结果（可为 null）                                         |
| `dur_ms` | number          | 耗时（毫秒）                                              |
| `error`  | string \| null  | 错误信息——**错误是数据不是异常**：工具失败记录于此，trace 不中断，loop 决定继续或停止 |

### run.event（终止事件）

| 字段       | 类型                                                                             | 说明       |
| -------- | ------------------------------------------------------------------------------ | -------- |
| `type`   | `"run.event"`                                                                  | 行类型判别    |
| `event`  | `"stopped" \| "aborted" \| "errored"`                                          | 事件类型     |
| `reason` | `"completed" \| "max_iterations" \| "budget_exceeded" \| "aborted" \| "error"` | 具体原因     |
| `at`     | int?                                                                           | 停止时所在迭代号 |

## 存储不变量

1. JSONL 是唯一事实源；派生索引可删可重建
2. 一 run 一文件，append-only；终止事件写入后封存，任何路径不得修改
3. 只从已封存（`status === "completed"`）的 run 创建分支（`assertForkable`）
4. 存在子分支的 run 不可直接删除（`assertDeletable`）
5. 分支文件只记录新增 span，前缀经 parent 链共享（copy-on-write，`resolveBranch`）

## 用法

### 采集（Agent loop 侧）

```ts
import { JsonlTracer } from "@rebaseagent/trace-sdk";

const tracer = new JsonlTracer("traces/r_01.jsonl");
tracer.subscribe((e) => {
  /* 事件流：run.meta / span.start / span.end / run.event，UI 实时消费 */
});

tracer.startRun({
  id: "r_01", format_version: 1, task: "读 README 写摘要",
  model: "deepseek-chat", created_at: new Date().toISOString(),
  parent: null, fork: null, config_hash: "sha256:...",
});

const step = tracer.startSpan({ kind: "agent.step", n: 1 });
const llm = tracer.startSpan({ kind: "llm.call", parent: step, request });
tracer.endSpan(llm, { response });
const tool = tracer.startSpan({ kind: "tool.invoke", parent: step, tool: "read_file", args: { path: "README.md" } });
tracer.endSpan(tool, { result: "# ...", dur_ms: 12, error: null });
tracer.endSpan(step);

tracer.endRun({ event: "stopped", reason: "completed", at: 1 }); // fsync 并封存
```

测试 / headless 场景用 `NullTracer`：不产生文件，事件流照常可订阅断言。

### 读取与分支解析

```ts
import { readRun, resolveBranch } from "@rebaseagent/trace-sdk";

const record = readRun("traces/r_02.jsonl");
// record: { meta, spans, events, status: "completed" | "crashed" }
// 逐行 zod 校验；非法行抛 TraceReadError（message 含"第 N 行：原因"）
// format_version > 1 时抛"不支持的格式版本"

const resolved = resolveBranch("r_02", (id) => readRun(`traces/${id}.jsonl`));
// resolved.spans = 祖先共享前缀（截至各 fork 点，含 fork 点）+ 本 run 新增 span
// resolved.chain = 祖先链，暴露 fork 元数据供 replay 层应用编辑
```

## Fixtures

`fixtures/*.jsonl` 是手工构造的标准数据（进 git，测试与文档双用途）：

| 文件                    | 内容                                                   |
| --------------------- | ---------------------------------------------------- |
| `normal.jsonl`        | 3 步正常任务（read\_file → write\_file），`completed`        |
| `tool-error.jsonl`    | 工具报错但 loop 继续，任务仍 `completed`（错误是数据不是异常）             |
| `infinite-loop.jsonl` | 死循环被 `max_iterations` 停止；推理模型 `reasoning_content` 示范 |
| `branch.jsonl`        | 从 `normal.jsonl` 的 `s_03` 分叉的分支 run（fork 元数据示范）      |

## 开发

```bash
pnpm --filter @rebaseagent/trace-sdk test    # vitest
pnpm --filter @rebaseagent/trace-sdk build   # tsc → dist/
```

