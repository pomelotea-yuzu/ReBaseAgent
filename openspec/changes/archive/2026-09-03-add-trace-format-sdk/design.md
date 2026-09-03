# Design: add-trace-format-sdk

## Context

首版变更，无存量代码与数据。动机与范围见 proposal.md；具体行为要求见 specs/trace-format/spec.md。约束：纯 TS 包，零原生依赖、零 Electron 依赖（技术栈见 openspec/config.yaml）。

## Goals / Non-Goals

**Goals:**

- 定义自洽的 trace 格式 v1（JSONL，一 run 一文件）
- 采集侧（Tracer）与读取侧（readRun/resolveBranch）API 稳定，供 agent-loop / replay / UI 三个后续 spec 并行消费
- 崩溃安全：任何时刻文件中只有完整 JSON 行

**Non-Goals:**

- 不做编辑语义（fork.edit 如何应用到前缀）——replay spec 的职责
- 不做流式读取/写入（大文件优化留给桌面端 store spec）
- 不做并发写同一文件的锁（一 run 一 Tracer 实例，单写者约定）

## Decisions

### D1：span 在 endSpan 时整行落盘，startSpan 不落盘

append-only 文件无法回填字段，因此 span 只有完成态才值得占一行。行原子性由"一次 writeSync 写一行（含 `\n`）"保证，崩溃最多丢"未完成的 span"，不会产生半行 JSON。

备选：startSpan 时写半行、endSpan 时补齐——违反 JSONL 行完整性，弃。

### D2：TraceLineSchema 用 z.union，缺 type 由读取器显式兜底

三种 span 的 `type` 同为 `"span"`，判别值重复，无法用 discriminatedUnion（zod v3 限制：判别值不能重复，且 union 不能嵌套作判别选项）。代价是 union 的报错不如判别联合精确——由读取器的错误格式化器弥补：缺失字段输出「xxx 为必填」，并带行号（`第 N 行：...`）。缺 `type` 的场景在读取器做显式检查（`type 为必填`），保证 spec 场景的报错文案。

### D3：Tracer 采用模板方法（BaseTracer + on* 钩子）

事件流订阅、span id 生成、活跃 span 表、生命周期防护（未 startRun / 已 endRun 再写抛错）都收敛在 BaseTracer；子类只实现 onMeta/onSpan/onEvent 三个落盘钩子。NullTracer 即"零落盘"实现（事件流照常，供 CI 断言）；JsonlTracer 即文件实现。Agent loop 只依赖 Tracer 接口——观测出口唯一，文件写入只是订阅端之一。

### D4：JsonlTracer 构造时校验既有文件

- 目标文件已存在且末行是 run.event → 抛「已封存」，拒绝追加（不变量：任何路径不得修改封存文件，即使绕过原 Tracer 实例）
- 已存在且非空但未封存 → 抛「拒绝覆盖」（崩溃恢复策略 = 新开文件，不在本 SDK 范围）
- endRun 时 fsync + close，之后所有写入抛错

### D5：resolveBranch 通过 RunLoader 注入加载来源

SDK 不强制 run id ↔ 文件名映射（桌面端未来由 SQLite 索引或目录扫描决定）。环检测用 visited 集；链上每个非根 run 的父必须已封存（assertForkable）。fork 语义定为「at_span 及之前为共享前缀」（对应 proposal 的"从该 span 之后分叉"），编辑由 replay 层对暴露的 chain 应用。

### D6：读取侧宽松字段 + 原样录制

`request.messages`/`tools`/`params` 用 passthrough/record 原样保留（spec 要求 messages 可直接作为重放输入，查表无需重建）；`tool.invoke.result` 为 `z.unknown()`。SDK 不消费这些字段的内部结构，只做存储与搬运，避免格式跟随模型供应商协议演进。

### D7：RunRecord.status 二值：completed / crashed

有终止事件即 completed（含 aborted/errored 结局——封存与否才是本 SDK 关心的维度）；缺失即 crashed（进程中途崩溃，是合法状态而非错误）。

## Risks / Trade-offs

- [writeSync 中途断电仍可能产生半行] → 缓解：单次 writeSync 一行 + endRun fsync；残余半行会被读取器在 JSON.parse 处报出带行号的错误，不会静默
- [z.union 报错不如判别联合精确] → 读取器格式化器 + type 显式检查兜底；升级 zod v4 可再评估
- [活跃 span（startSpan 后未 endSpan）在崩溃时丢失] → 接受：append-only 的固有权衡，与"崩溃时已写入行保持完整"不冲突
- [readRun 同步 IO，大文件阻塞] → 当前规模（单 run 数百行）无碍；流式读取留给桌面端 store spec
- [删除保护/分支保护只提供纯函数（assertDeletable/assertForkable）] → 执行层（扫描目录、维护索引）由 store spec 落地；本层保证语义正确性
