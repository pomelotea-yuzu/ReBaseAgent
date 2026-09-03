# Proposal: add-trace-format-sdk

## Why

ReBaseAgent 的一切能力（查看、预算地图、时间旅行、Trace-as-Test）都建立在同一块地基上：**trace 数据格式**。它是"上下文程序"的序列化格式——产品的核心资产。本变更定义格式 v1 和配套的采集 SDK，并附手工 fixtures，使后续 spec（agent-loop、UI、replay）可以并行开发而互不阻塞。

## What Changes

- 新增 `packages/trace-sdk`：span 埋点 API（Tracer 接口）+ 格式 v1 的 zod schema + JSONL 读写器
- 定义 trace 文件格式（JSONL，一 run 一文件）：`run.meta` / `span` / `run.event` 三类行
- 提供三份手工 fixtures：正常任务、工具报错、死循环（各自成为后续 spec 的测试数据）
- 格式命名借鉴 OTel GenAI 语义约定（如 `gen_ai.*` 风格字段），但为自有 schema，带 `format_version` 字段

## Format v1 概要

```jsonc
// traces/r_01.jsonl 首行
{ "type": "run.meta", "id": "r_01", "format_version": 1,
  "task": "...", "model": "deepseek-chat", "created_at": "...",
  "parent": null, "fork": null, "config_hash": "sha256:..." }

// 每个 span 一行；三种 kind
{ "type": "span", "id": "s_02", "kind": "agent.step", "parent": null, "n": 1 }
{ "type": "span", "id": "s_03", "kind": "llm.call", "parent": "s_02",
  "request": { "model": "...", "messages": [...], "tools": [...], "params": {...} },
  "response": { "content": "...", "reasoning_content": "...", "tool_calls": [...],
                "usage": { "in": 1830, "out": 210 }, "ttft_ms": 850 } }
{ "type": "span", "id": "s_04", "kind": "tool.invoke", "parent": "s_02",
  "tool": "read_file", "args": {...}, "result": "...",
  "dur_ms": 12, "error": null }

// run 级事件（loop 为什么停）
{ "type": "run.event", "event": "stopped", "reason": "max_iterations", "at": 25 }

// 分支 run 的首行（fork：从父 run 的哪个 span 之后分叉、编辑了什么）
{ "type": "run.meta", "id": "r_02", "parent": "r_01",
  "fork": { "at_span": "s_04", "edit": { "field": "result", "value": "..." } } }
```

## 存储不变量（本 spec 确立，后续所有 spec 继承）

1. **JSONL 是唯一事实源**：写入路径只写 JSONL（headless CLI 与 Electron 桌面端共用同一套代码）；SQLite 索引是桌面端专属的派生缓存，删除后可从 JSONL 重建
2. **一 run 一文件，append-only**：run 结束（写入终止事件）后文件封存，任何路径不得修改
3. **只从已完成的 run 分支**：分支点必须是已封存文件里的 span
4. **删除保护**：存在子分支（有 run 的 `parent` 指向它）的 run 不可直接删除

## Non-goals

- 不做 SQLite 索引（桌面端另一份变更处理）
- 不做 UI / 预算地图 / 时间旅行重放（后续 spec）
- 不做任何外部工具 trace 格式的导入/转换
- 不做默认脱敏（脱敏会破坏可重放性；分享导出时的可选模糊化留给后续 spec）
- 不录制原始 SSE chunk 流（默认关闭，格式预留 `chunks` 可选字段）
- token 逐消息精确计量（预算地图在渲染时用通用 tokenizer 估算并标注）

## Impact

- 新增包：`packages/trace-sdk`（纯 TS，零原生依赖，零 Electron 依赖）
- fixtures 存放：`packages/trace-sdk/fixtures/*.jsonl`（进 git，作为测试数据和文档双用途）
- 风险低：纯数据契约，无外部依赖；后续所有 spec 都消费它
