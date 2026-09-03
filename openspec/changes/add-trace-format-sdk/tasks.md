# Tasks: add-trace-format-sdk

## 1. 格式 schema

- [ ] 1.1 定义 zod schema：`RunMetaLine`（含 `format_version`、`parent`、`fork`、`config_hash`）
- [ ] 1.2 定义 zod schema：`SpanLine`（三种 kind：`agent.step` / `llm.call` / `tool.invoke`）
- [ ] 1.3 定义 zod schema：`RunEventLine`（stopped/aborted/errored + reason）
- [ ] 1.4 schema 单测：合法样例通过、缺字段/错类型被拒绝（vitest）

## 2. Tracer API

- [ ] 2.1 `Tracer` 接口：`startRun(meta)` / `startSpan(kind, attr)` / `endSpan(id, patch)` / `endRun(event)`；实现为事件流（可订阅）
- [ ] 2.2 `JsonlTracer`：Tracer 的文件写入实现（append-only，fsync on endRun）
- [ ] 2.3 `NullTracer`：静默实现（测试与 headless 免配置用）
- [ ] 2.4 单测：Tracer 事件流顺序、文件不可变（endRun 后再写抛错）、崩溃时不产生半行 JSON

## 3. 读取器

- [ ] 3.1 `readRun(file)`：解析 JSONL → `{ meta, spans, events }`，逐行 zod 校验
- [ ] 3.2 `resolveBranch(runId)`：沿 `parent` 链拼接完整轨迹（含 fork 点编辑的应用说明——编辑语义本身在 replay spec 实现，此处仅暴露 fork 元数据）
- [ ] 3.3 单测：分支链拼接、环检测、缺失父文件报错

## 4. Fixtures（手工构造，进 git）

- [ ] 4.1 `fixtures/normal.jsonl`：3 步正常任务（read_file → llm → write_file）
- [ ] 4.2 `fixtures/tool-error.jsonl`：第 2 步工具报错但 loop 继续（error 是数据不是异常的示范）
- [ ] 4.3 `fixtures/infinite-loop.jsonl`：死循环被 max_iterations 停止（run.event 示范）
- [ ] 4.4 `fixtures/branch.jsonl`：从 normal 分叉的分支 run（fork 元数据示范）
- [ ] 4.5 fixtures 全部通过 `readRun` 的校验测试

## 5. 收尾

- [ ] 5.1 `packages/trace-sdk` 的 package.json / tsconfig / biome 接入 monorepo
- [ ] 5.2 README（包内）：格式文档 + 字段表
- [ ] 5.3 `pnpm test` 全绿后按 openspec 流程归档
