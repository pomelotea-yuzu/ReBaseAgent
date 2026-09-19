# @rebaseagent/trace-sdk

ReBaseAgent trace 格式的采集与读取 SDK：zod schema、Tracer 事件流、JSONL 读写器与分支解析。纯 TypeScript，零原生依赖、零 Electron 依赖。普通运行写 v1，隔离文件运行写 v2（读取器双读，见「导出面与子路径」）。

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
| `format_version` | `1 \| 2`       | 格式版本：`1` = 普通运行，`2` = 隔离文件运行（见「v2 隔离运行与文件附件」）。读取器**双读**；更高版本显式报错，不静默降级 |
| `task`           | string         | 任务描述                       |
| `model`          | string         | 模型名（如 `deepseek-chat`）     |
| `created_at`     | string         | ISO 8601 创建时间              |
| `parent`         | string \| null | 父 run id；根 run 为 null      |
| `fork`           | object \| null | 分支信息，见下                    |
| `budget`         | object?        | 预算上限（可选），见下                |
| `config_hash`    | string?        | 源配置指纹（system prompt + 工具表）；**可选**——代理录制的 run 无源配置可哈希，诚实缺省 |
| `source`         | object?        | 录制来源（可选），见下                |
| `workspace`      | object?        | **仅 v2 隔离运行**的文件世界元数据，见下        |

`fork`：

| 字段                     | 类型      | 说明                                                                                                                    |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `at_span`              | string  | 分叉点 span id（该 span 保留在共享前缀中，含于前缀）                                                                                       |
| `resume_after_step`    | string? | **v2 隔离分支必带**：整轮续跑边界（= `at_span` 所属的 `agent.step`）。恢复点是"该轮**全部**工具完成后"，因此同轮兄弟工具的结果必须留在前缀里、不得重放；v1 保持"按 `at_span` 单 span 截断"的旧语义不变 |
| `edit.field`           | string  | 被编辑的字段名（如 `"result"`；代理分叉为 `"messages"`）                                                                               |
| `edit.value`           | unknown | 新值。编辑语义由 replay 层应用                                                                                                    |

`budget`（可选）：源配置声明的累计 token 预算，run 自包含该事实源；老文件与未声明预算的运行合法缺失，读取器不报错

| 字段                        | 类型    | 说明                                                                                         |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------ |
| `budget.max_total_tokens` | int>0 | 累计 token 上限——口径为所有 `llm.call` 的 `usage.in + usage.out` 之和（与 loop 侧 `deriveTotalTokens` 一致） |

`source`（可选）：录制来源。SDK / agent-loop 直录省略；本地录制代理写入。无 `config_hash` 的 run 不可作 replay 分叉父本（校验层拒绝），但可作代理分叉父本

| 字段          | 类型               | 说明                                              |
| ----------- | ---------------- | ----------------------------------------------- |
| `kind`      | `"proxy"`        | 录制通道（当前仅本地录制代理）                                 |
| `base_url`  | string           | 代理自身监听地址（即用户在自己应用里填的那个 base\_url），非 upstream 转发目标 |

`workspace`（**仅 v2 隔离运行**；普通 v1 run 不得携带，读取器按版本判字段存在性并拒绝不匹配的文件）。
完整语义与编排入口见 [`@rebaseagent/replay`](../replay) 的「隔离文件执行」。

| 字段                             | 类型                                  | 说明                                                                       |
| ------------------------------ | --------------------------------- | ------------------------------------------------------------------------ |
| `workspace.profile`            | `"file-tools-v1"`                 | 受控工具组；本期只有这一个值                                                           |
| `workspace.world_id`           | string                            | 本 run 的**文件世界 id**，等于该 run 自己的 id（跨字段约束，不符即解析失败）                          |
| `workspace.write_authorized`   | `true`                            | **审计标注**：创建方声称该次运行经「允许副本内写入」确认。**不是权限判据**——真正的授权是调用方在**当前请求**里携带的 `allowFileWrites`，不得由它推导或默认勾选本次授权 |
| `workspace.initial_snapshot`   | `{ id, files[] }`                 | 首次 LLM 调用**之前**的完整文件清单（见下）                                               |
| `workspace.origin`             | `{kind:"import"}` \| `{kind:"checkpoint",run_id,step_span}` | 世界来源：根运行来自源目录导入；分支来自**直接父** run 的某个检查点                                    |

清单（`initial_snapshot` 与 `agent.step.workspace_snapshot` 同形）：

| 字段             | 类型             | 说明                                                                   |
| -------------- | -------------- | -------------------------------------------------------------------- |
| `id`           | 64 位小写十六进制      | **清单内容的规范哈希**，读取器会重算比对；不符即解析失败（清单与 id 之间没有别的结构性约束）                   |
| `files[].path`   | string         | 世界内**逻辑路径**：相对、`/` 分隔、长度 ≤ 512 UTF-16 单元、深度 ≤ 32 段、无 NFC/大小写碰撞、无 Windows 保留设备名与 ADS |
| `files[].sha256` | 64 位小写十六进制      | 文件内容哈希（对应附件文件名）                                                      |
| `files[].bytes`  | int ≥ 0        | 字节数；读取附件时与实际大小核对                                                     |

清单本身**不含**绝对磁盘路径、凭据或内联字节——文件内容按哈希存在附件存储里，见「v2 隔离运行与文件附件」。

### span（三种 kind，共同字段：`type: "span"`、`id`、`parent`（父 span id，根为 null）、`timing`（可选））

`timing`：span 的墙上时钟区间，由 Tracer 在 start/endSpan 时自动记录

| 字段                  | 类型     | 说明                                         |
| ------------------- | ------ | ------------------------------------------ |
| `timing.started_at` | string | 起始时刻，ISO 8601（毫秒精度）                        |
| `timing.ended_at`   | string | 终止时刻，ISO 8601；与 started\_at 成对出现           |
| `timing`（整体缺省）      | —      | 老文件与手工构造数据合法缺失；读取器不报错，**耗时视为未知**，不得用其他字段推断 |

`timing` 与 `tool.invoke.dur_ms` 不冲突：后者是"工具执行耗时"的权威值，前者提供跨 span 的统一时间坐标（时间轴、step 聚合）。

**agent.step** — 一轮 loop 迭代

| 字段     | 类型             | 说明     |
| ------ | -------------- | ------ |
| `kind` | `"agent.step"` | <br /> |
| `n`    | int ≥ 1        | 迭代序号   |
| `workspace_snapshot` | `{ id, files[] }?` | **仅 v2 隔离运行**：该轮**全部工具执行完之后**的完整文件清单（"轮末检查点"）。v2 里已落盘的 `agent.step` **必须**带它（缺了说明写入端漏注入，读取器拒绝）；其余 kind 不得携带 |

**llm.call** — 一次 LLM 调用

| 字段                           | 类型             | 说明                                                                                 |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `kind`                       | `"llm.call"`   | <br />                                                                             |
| `request`                    | object         | 原样录制完整请求：`model` / `messages` / `tools`? / `params`?。`messages` 可直接作为重放输入（查表，无需重建） |
| `response.content`           | string \| null | 正文                                                                                 |
| `response.reasoning_content` | string \| null | 思维链（推理模型）；非推理模型为 null                                                              |
| `response.tool_calls`        | array          | 工具调用列表，默认 `[]`                                                                     |
| `response.usage`             | `{ in, out }`  | token 用量                                                                           |
| `response.ttft_ms`           | number         | **首个含内容 delta 的 chunk** 与**请求发出时刻**之差（毫秒）；流内无任何内容 delta 时记 `0`。经 agent-loop 录制者起点在 `fetch` 调用之前（含等待响应头）；`llm-proxy` 录制的 run 起点为「聚合开始」（不含等待响应头）——判据同源、起点略窄。注意：若 provider 以 `reasoning`（而非 `reasoning_content`）下发思维链，则该段不计入内容 delta |

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

## v2 隔离运行与文件附件

`format_version: 2` 表示这次运行**绑定了自己的文件世界**（隔离文件执行的产物）。它与 v1 的差别只有三处，都在同一个契约里：

| 位置                            | v1 普通运行 | v2 隔离运行                        |
| ----------------------------- | ------- | ------------------------------ |
| `run.meta.workspace`          | **不得出现** | 必填（世界 id / 初始快照 / 来源）            |
| `agent.step.workspace_snapshot` | 不得出现    | 每个已落盘的 `agent.step` **必带**（轮末检查点） |
| `fork.resume_after_step`      | 不得出现（按 `at_span` 截断） | 分支 run 必带（整轮续跑边界）                |

**版本与字段必须匹配**：v1 文件私带 `workspace`、或 v2 文件缺少它，都会被读取器拒绝（这是按**原始自有属性**判定的，不依赖 zod 的字段剥离）。普通写入端永远写 v1（`PLAIN_FORMAT_VERSION`），隔离写入端写 v2（`FORMAT_VERSION`）。

**附件存储**：文件内容不存在 trace 里，而是按内容寻址放在同级的附件目录：

```text
<dataDir>/traces/<runId>.jsonl          trace（只有逻辑路径 + 哈希 + 字节数）
<dataDir>/workspace-blobs/sha256/<hash>  附件（内容寻址，跨 run 共享同一份）
```

由此得到两条对使用者重要的性质：

1. **附件不是"每 run 一份备份"**：相同内容只存一份；整体搬走 `dataDir` 后按新路径重建即可——trace 里没有绝对路径，所以迁移后照样解析、读取与分叉。
2. **读取 trace 不加载附件**：附件目录不可用（被删、被裁掉）时，`readRun` 仍返回完整的消息与步骤；附件**字节**的校验是 replay 层只读接口的活（缺失 / 长度不符 / 内容不符分别可辨），缺失或损坏会**阻止分叉**，但不会阻止你看轨迹。反过来，任何一方都不会"从源目录重新读一份补上"——那会把历史事实换成当前磁盘。

**能不能拿它当分叉父本**：必须**已封存**（有终止事件；`crashed` 的 run 前缀不稳定，禁止分叉），且复跑时起始清单的附件逐项可用。

## 存储不变量

1. JSONL 是唯一事实源；派生索引可删可重建
2. 一 run 一文件，append-only；终止事件写入后封存，任何路径不得修改
3. 只从已封存（`status === "completed"`）的 run 创建分支（`assertForkable`）
4. 存在子分支的 run 不可直接删除（`assertDeletable`）
5. 分支文件只记录新增 span，前缀经 parent 链共享（copy-on-write，`resolveBranch`）
6. v2 的文件内容按内容寻址放在 `<dataDir>/workspace-blobs/sha256/`，**同一内容跨 run 共享一份**；附件缺失或损坏**不阻止读 trace**，但阻止基于它的分叉（不得从源目录重读补齐）
7. 清单的 `id` 必须等于该清单的规范哈希（读取器**重算**比对）；清单内路径必须满足逻辑路径契约（相对、`/` 分隔、≤ 512 UTF-16 单元、≤ 32 段、无 NFC / 大小写碰撞）

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
// 支持 format_version 1 / 2；更高版本抛"不支持的格式版本"（不静默降级解析）

const resolved = resolveBranch("r_02", (id) => readRun(`traces/${id}.jsonl`));
// resolved.spans = 祖先共享前缀（截至各 fork 点，含 fork 点）+ 本 run 新增 span
// resolved.chain = 祖先链，暴露 fork 元数据供 replay 层应用编辑
```

## 导出面与子路径

包按"能不能进 renderer"分三个入口，别混用：

| 入口 | 内容 | 谁可以用 |
| --- | --- | --- |
| `@rebaseagent/trace-sdk` | Tracer / reader / 分支解析 / 纯校验函数 | **Node 侧**（main、replay、CLI） |
| `@rebaseagent/trace-sdk/schema` | 纯 zod schema 与常量（`FORMAT_VERSION`、`PLAIN_FORMAT_VERSION` 等） | **renderer 也可用**（零 Node 依赖） |
| `@rebaseagent/trace-sdk/workspace-hash` | 快照清单的规范排序与 SHA-256 | **仅 Node**（依赖 `node:crypto`） |

主入口会连带引入 `node:fs`，`workspace-hash` 会引入 `node:crypto`，两者都不可进渲染层——
renderer 里只允许 `import type`，或改走 `/schema`。

**快照哈希的规范形式**（跨机器必须逐字节一致）：对**排序后**的清单取
`sha256(utf8(JSON.stringify(files.map(f => [f.path, f.sha256, f.bytes]))))`，
排序键是路径的 UTF-16 代码单元序（**不是** `localeCompare`——它跟 locale 走，会让同一份清单在不同机器算出不同 id）。
要复刻这个 id 的实现必须逐条对齐排序键、字段顺序与编码；写完请用 `test/workspace-snapshot.test.ts` 里的
金标准值自检。

> v2 隔离字段的完整字段表见上文「v2 隔离运行与文件附件」与 `src/schema.ts`；
> 其编排入口（创建隔离根 run、预检、分叉）在 [`@rebaseagent/replay`](../replay)。

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

