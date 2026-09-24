# 审阅：桌面端原生 run 创建入口（add-native-run-creation）

**审阅日期**：2026-09-15  
**提案路径**：`openspec/changes/add-native-run-creation/`  
**审阅范围**：proposal.md、design.md、tasks.md、specs/desktop-ui/spec.md

---

## 总体评价

**方向正确，设计质量较高。** 提案解决了一个真实的用户痛点——便携版用户无法从零体验完整链路，必须依赖代理录制或外部脚本。通过新增 `runs:create` IPC 通道与 `runCreate` 编排函数，复用既有 `runLoop` 执行路径，以最小改动实现目标。架构选择（直接调用 runLoop 而非 replay 包）语义清晰，与既有 fork / proxy fork 解耦。

**可 apply 条件**：修复 2 项 P1 问题并确认 2 项 P2 边界后可落地。

---

## P1 问题（需修复才能 apply）

### P1-1：`runCreate` 代码示例中 `runLoop` 调用参数不完整

**位置**：design.md 第 86–92 行

**问题**：代码示例中 `runLoop` 的调用为：

```typescript
const result = await runLoop(
  config,
  messages,
  tracer,
  [],  // 空工具表
  llm ?? new OpenAiCompatClient(config),
);
```

但根据 `packages/agent-loop/src/run-loop.ts` L40–L56 的实际签名，`runLoop` 还接受 `forkRun` 参数（用于 fork 场景传递父 run 元数据）。虽然原生创建场景下 `forkRun` 应为 `null`，但示例代码未显式传递，存在歧义。

**建议**：
- 在代码示例中显式传递 `forkRun: null`（或按位置传递 `null`）
- 确认 `CreateRunnerOptions` 是否包含 `llm` 字段；若不包含，需说明 `llm` 的来源（是从 `options` 解构，还是始终新建）

---

### P1-2：`FileTracer` 构造函数参数未与实际代码对齐

**位置**：design.md 第 75–83 行

**问题**：代码示例假设 `FileTracer` 接受以下参数：

```typescript
const tracer = new FileTracer({
  outDir: repository.tracesDir,
  id: runId,
  task: request.task ?? request.userMessage.slice(0, 50),
  model: config.model,
  parent: null,
  fork: null,
  config_hash: configHash(config.systemPrompt, config.tools),
});
```

但 Explore agent 未能确认 `FileTracer` 的实际构造函数签名。需要核实：
- `FileTracer` 是否接受对象参数（而非位置参数）
- 字段名是否完全匹配（特别是 `parent` / `fork` / `config_hash`）
- `config_hash` 是否由 tracer 内部计算，还是由调用方传入

**建议**：
- 查阅 `packages/agent-loop/src/tracer.ts`（或类似路径）确认 `FileTracer` 构造函数
- 若 `config_hash` 由 `runLoop` 内部计算（参见 run-loop.ts L66–L80），则 `runCreate` 中无需手动传入，避免重复计算
- 更新代码示例以匹配实际签名

---

## P2 问题（边界情况需确认）

### P2-1：`maxIterations` 与 `budget` 硬编码

**位置**：design.md 第 63–64 行

**问题**：`RunConfig` 中硬编码了：

```typescript
maxIterations: 10,
budget: { maxTotalTokens: 100_000 },
```

这些值是否应从 `settings` 读取？若硬编码，用户无法在 UI 中调整，可能与"零摩擦接入"的定位矛盾（高级用户可能需要更大 budget）。

**建议**：
- 首期 MVP 可接受硬编码，但需在 proposal "后续扩展" 中明确提及
- 或在 settings 中新增可选字段 `maxIterations` / `maxTotalTokens`，缺省使用硬编码值

---

### P2-2：来源标注（`source` 字段）的实现细节缺失

**位置**：specs/desktop-ui/spec.md 第 54–62 行

**问题**：spec 要求新建 run 标注"本地直录"来源，与代理 run 的"代理"来源区分。但 proposal 和 design 中未说明：
- `source` 字段在何处写入（`runCreate` 函数？`FileTracer`？）
- `source` 字段的枚举值（"local" / "proxy" / 其他？）
- 既有 run 文件无 `source` 字段时，列表渲染逻辑如何归入"本地直录"

**建议**：
- 在 design.md 中补充 `source` 字段的写入位置与枚举值
- 在 spec.md 中明确"无 `source` 字段的老文件归入本地直录"的渲染规则（当前已在 Scenario 中提及，但需确认实现侧是否清晰）

---

## P3 建议（非阻塞，可后续改进）

### P3-1：`task` 缺省逻辑的边界

**位置**：design.md 第 78 行

```typescript
task: request.task ?? request.userMessage.slice(0, 50),
```

若 `userMessage` 长度不足 50，`slice(0, 50)` 不会报错，但语义上可能截断中文字符串的不完整位置。建议：
- 按词/句截断（取前 50 字符后，若后续字符非空白/标点，继续到下一个空白/标点）
- 或首期接受简单 `slice`，后续优化

---

### P3-2：UI 交互细节

**位置**：design.md 第 103–145 行

- System Prompt 为空时，提示文案"建议填写以获得更好效果"未在 spec 中定义
- Task 字段缺省逻辑（取 userMessage 前 50 字符）对用户不可见，建议在 UI 中显示 placeholder 提示

---

## 技术细节验证结果

以下为 Explore agent 对代码库的验证结果：

| 验证项 | 结果 | 备注 |
|--------|------|------|
| `runLoop` 签名 | ✅ 一致 | 接受 `RunConfig` / `initialMessages` / `Tracer` / `tools` / `llm` / `forkRun` |
| `configHash` 函数 | ✅ 一致 | 接受 `systemPrompt` 与 `tools`，生成 `sha256:...` |
| `OpenAiCompatClient` 存在 | ✅ 一致 | 构造函数 `(config: RunConfig, fetchImpl?: FetchLike)` |
| D5 `buildForkConfig` 空工具表 | ✅ 一致 | `recordedTools = firstLlm.request.tools ?? []` |
| `runLoop` 自动处理 error/stop | ✅ 一致 | 异常路径调用 `tracer.endRun({ event: "errored" })` |
| `FileTracer` 构造函数 | ⚠️ 未确认 | 需查阅实际代码核对参数 |
| `CreateRunnerOptions` 类型 | ⚠️ 未确认 | 需确认是否复用既有类型 |
| settings 字段名 | ⚠️ 未确认 | 需核对 `baseURL` / `apiKey` / `model` 是否完全匹配 |

---

## 结论

**可 apply**，条件：
1. 修复 P1-1（`runLoop` 调用参数完整性）
2. 修复 P1-2（`FileTracer` 构造函数参数对齐）
3. 确认 P2-1（硬编码 `maxIterations` / `budget` 是否可接受）
4. 确认 P2-2（`source` 字段实现细节）

整体设计思路清晰，复用既有执行路径，避免引入新依赖。UI 设计简洁，交互逻辑合理。测试策略覆盖核心场景与边界情况。文档更新计划完整。
