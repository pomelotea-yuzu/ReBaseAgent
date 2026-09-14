# 设计

## 1. 路线选择：录制侧补指纹，fork 侧放门禁，不建第二套通道

不新建"代理专属 fork 编排"。代理 run 的 prompt fork / 模型 A/B 复用既有 `loadForkParent` → `derivePromptForkState` → `promptReplayRun` / `modelReplayRunMany` 全链路，改动收敛为两点：

1. **录制侧**：代理 run 落盘时补写 `meta.config_hash`（可派生才写）；
2. **门禁侧**：`loadForkParent` 移除对 `source.kind = "proxy"` 的无条件拒绝，改为与引擎 run 同一条 `config_hash` 存在性判据。

理由：prompt fork 与模型 A/B 对父本的全部实质要求（已封存、有指纹、首次 `llm.call` 含字符串 system 消息）代理 run 都能满足——代理 handler 已捕获完整 `messages` 与可选 `tools`（`packages/llm-proxy/src/handler.ts` 的 `snapshotRequest`），缺的只是指纹与放行。复制第二套编排必然在某个分支上悄悄少一条门禁（`fork-parent.ts` 抽取时的原话）。

## 2. hash 派生：单一实现放在 replay，录制器只调用

**位置**：共享纯函数 `deriveProxyConfigHash` 放 `@rebaseagent/replay`（新模块，紧邻 `fork-parent.ts`），桌面 `ProxyRunRecorder` 在落盘时调用。

- replay 已依赖 `@rebaseagent/agent-loop`（可直接 import `configHash`、`ToolDefSchema`），桌面 main 已 import replay（`fork-runner.ts`）——零新依赖。
- `packages/llm-proxy` 保持零 workspace 依赖（纯转发 + 快照，职责不膨胀）。`ProxyRecording` 里的请求快照原样跨包传给录制器，hash 在落盘点计算。
- 不在 `llm-proxy` 包内复制 `configHash`：跨路径静默不等正是本变更要消灭的。

**输入规则**（对应 proposal 的"不得伪造 hash 放行"）：

```ts
/** 缺 hash 的结构化缺因：录制侧写入 meta，门禁/UI 据此给精准文案 */
type ConfigHashMissReason = "no_system" | "invalid_tool";

type ConfigHashDerivation =
  | { hash: string; reason: null }
  | { hash: null; reason: ConfigHashMissReason };

deriveProxyConfigHash(request: {
  messages: ReadonlyArray<{ role: unknown; content?: unknown }>;
  tools?: ReadonlyArray<Record<string, unknown>>;
}): ConfigHashDerivation
```

- system：复用 `locateStartupContext`——首条 `role=system` 且 content 为字符串的消息；缺失 → `{ hash: null, reason: "no_system" }`（诚实缺省，不假定空串）。
- tools：缺省 → 空表（`configHash(system, [])`）；存在 → 每项经解包为 `ToolDef` 并通过 `ToolDefSchema` 校验，**任一项失败 → `{ hash: null, reason: "invalid_tool" }`**，不做部分哈希。
- 满足时返回 `{ hash: configHash(system, tools), reason: null }`——与引擎同一个实现、同一套规范化（键排序、工具按 name 排序、无空白），逐字节相等由 fixture 测试锁定（proposal 的 5 分钟可证伪假设）。
- **返回结构化结果而非裸 `string | null`**：缺因是门禁文案与用户修复路径的唯一依据（P1-2）。录制侧把 `reason` 写进 `meta.config_hash_reason`，`loadForkParent` 与渲染层据此分流文案。

**工具解包复用与错误类型归属**（P1-1）：桌面 `fork-runner.ts` 现有的 `toToolDefs` / `unwrapToolDef`（同时支持扁平 ToolDef 与 OpenAI `function` 包装两种形状）移入 replay 包导出，桌面改为引用。录制时算 hash 与分叉时重建工具表共用同一解包实现——这是"子 run 重建 config 的 hash 与父本 meta.config_hash 相等"的结构性保证，而不是靠两边各写一份碰巧一致。

错误类型的归属必须明确，否则 replay 包会反向依赖桌面：

- **现状**：`toToolDefs` 现在抛桌面私有的 `ForkError`（`fork-runner.ts:40-48`），replay 包不依赖它；直接把函数搬进 replay 会让 replay 需要认识一个桌面类型（或产生循环依赖）。
- **决策**：replay 侧定义**自有**的结构化错误 `ToolUnwrapError extends Error`（携带 `kind` 与 `toolName` 等诊断字段），`toToolDefs` / `unwrapToolDef` 一律抛它；**不把 `ForkError` 移入 replay**（`ForkError` 是 IPC 错误码载体，桌面专属语义，跨包复用会牵动 `ipc.ts` 的错误映射与 `instanceof` 判断）。
- **桌面转译**：`fork-runner.ts` 在调用点 catch `ToolUnwrapError`，转成既有 `ForkError("FORK_NO_CONTEXT", ...)`（保留原中文文案），**IPC 错误码零变化**——渲染层对 `FORK_NO_CONTEXT` 的既有处理不变。
- **测试口径**：replay 侧单测断言 `ToolUnwrapError`；桌面侧既有 `runFork` / `runPromptFork` 的"工具表无法解析"用例断言仍为 `FORK_NO_CONTEXT`（回归保护）。

**sideEffect 保真度边界**：OpenAI wire 格式不携带 `sideEffect`，解包结果天然无该字段，`configHash` 仅在字段有值时计入——代理指纹是"线上事实"的指纹。若源应用恰好也是 ReBaseAgent 引擎且工具带 `sideEffect` 标记，代理侧 hash 与其进程内 hash **不保证相等**（标记不上线）。本变更只承诺：同一代理录制派生的 hash 与从该录制重建的子 run hash 一致；不承诺跨进程指纹互通。

## 3. 门禁放宽：`loadForkParent` 的拒绝顺序

现行顺序（`fork-parent.ts`）：父链缺失/成环 → 未封存 → **proxy 来源** → 缺 config_hash → 无首次 llm.call → 无字符串 system 消息。

新顺序：父链缺失/成环 → 未封存 → **缺 config_hash（统一拦截，proxy 与非 proxy 同判据）** → 无首次 llm.call → 无字符串 system 消息。

- proxy 且缺 hash：专属文案，**依 `meta.config_hash_reason` 分流**（P1-2）：
  - `no_system` → 「该代理 run 的首次请求不含字符串 system 消息，无法派生配置指纹；请让源应用发送带 system 消息的请求后重新经代理录制」；
  - `invalid_tool` → 「该代理 run 的工具表无法解析（部分工具项缺少 name/description/parameters）；请修正源应用的工具定义格式后重发，或在其 llm.call 详情使用"编辑 messages 重发"」；
  - 字段缺失（历史文件）→ 保持旧文案，指向"编辑 messages 重发"入口。
  三种分支都不做无差别兜底——修复路径不同，文案必须可诊断。
- 非 proxy 且缺 hash：保持既有文案不变（回归要求）。
- 双真相源校验（`config.systemPrompt` 与父录制 system 先比后覆写）不动：代理父本的 system 同样来自首次 `llm.call.request.messages`，天然通过。

**tool-result replay 独立保持拒绝**：代理 run 只录一个 `llm.call`、无 `tool.invoke` span，`runFork` 的 at_span 校验（必须是叶子自身轨迹中的 `tool.invoke`）结构性拒绝；trace-test 的 `staticOnly` 判据（`run-test.ts` 把 proxy 一律视为静态）不动。以测试锁住，不改代码语义。

**注意**：代理 run 经 prompt fork 产出的子 run 是引擎 run（`runLoop` 录制、有完整 `tool.invoke` 轨迹、无 proxy source），它作为父本时可正常 tool-result replay——这是正确行为，不是漏洞。该"正确行为"SHALL 以集成测试锁定（代理 run → prompt fork → 子 run → 子 run 作父本做 tool-result replay），防止未来有人误加"祖先链含 proxy 即拒绝"的门禁（P2-2）。

## 4. 桌面编排与 UI

**`buildForkConfig`（fork-runner.ts）**：`recordedTools === undefined` 从抛 `FORK_NO_CONTEXT` 改为空表 `[]`。两个效果：

- 代理无工具 run（零改造接入的主路径：纯 chat 应用）可组装完整 `RunConfig`；`attachHandlers([])` 返回 `[]`，`runLoop` 单步执行。
- 兼容性外溢（P2-1，**已核实**）：`run-loop.ts:105` 对空 `config.tools` 不写 `request.tools` 字段（`...(config.tools.length > 0 ? { tools: config.tools } : {})`），因此引擎录制的空工具表 run 其 `request.tools === undefined`，此前同样被拒，现在一并放行。`configHash(system, [])` 合法（空数组参与规范化），引擎侧 `config_hash` 对空表成立，故放行后 `configHash` 一致性校验天然通过——这是自然扩展，不是行为破坏。**该外溢 SHALL 在 proposal 的 What Changes 显式列出（不再只提代理 run），并有专属测试用例**（引擎空工具表 run 的 prompt fork + 模型 A/B）。

带工具的代理父本：仍走 `toToolDefs` + `attachHandlers` 的 registry 覆盖检查，未知工具名照旧 `UNKNOWN_TOOL` 拒绝（诚实边界：ReBaseAgent 拿不到用户应用的工具 handler）。模型 A/B 的副作用门禁对代理工具表天然从严——wire 不带 `sideEffect` 标记，按既有"缺标记视为有副作用"规则需 `allowSideEffects` 放行；空工具表则平凡通过，主路径不受影响。

**录制侧写缺因**：`ProxyRunRecorder.write` 调 `deriveProxyConfigHash`，`hash !== null` 时写 `meta.config_hash`；`hash === null` 时不写 hash、写 `meta.config_hash_reason`（`"no_system"` / `"invalid_tool"`）。二者互斥——`config_hash_reason` 只表达"为何没有指纹"。该字段是 schema 可选字段，旧文件读取不受影响。

**hash 一致性如何天然成立**：`model_params` 编辑要求子 run `config_hash` 与父一致。子 config 的 `systemPrompt` 取自父录制 system、`tools` 取自父录制工具表经同一解包实现重建 → `runLoop` 现算的 hash 与录制侧 `deriveProxyConfigHash` 输入完全相同 → 相等。fixture 测试断言逐字节相等（含无 tools / 单工具 / 乱序多工具 / sideEffect 缺省四类）。

**renderer（DetailPanel.tsx）**：`promptForkable` 移除 `!isProxy` 条件，保留 `status === "completed" && meta.config_hash !== undefined && leafOwned`。有 hash 的代理 run 显示 prompt fork / A/B 编辑器；无 hash 的代理 run 不显示编辑器（其 `canResend` 编辑重发入口保持不变）——无 hash 的代理 run 在 UI 上不暴露入口，服务端 `loadForkParent` 的 `config_hash_reason` 分流文案是防御性兜底（防手工伪造 meta 或未来放开 UI 判据）。`promptForkGuard` / `modelAbGuard` 纯函数无 proxy 判据，不动。

**error / crashed run**：hash 派生只看请求快照、与 outcome 无关（error run 请求含 system 也会带 hash）。这不构成绕过：error run 无 `llm.call` span，门禁第 5 步拒绝；crashed run 未封存，第 2 步拒绝。

**旧文件**：不迁移不重算。历史 `.rebaseagent/traces/` 里的代理 run 无 `config_hash`、也无 `config_hash_reason`，按新门禁的"proxy 且缺 hash（缺因未知）"分支拒绝，文案指向"编辑 messages 重发"入口，并说明重新经代理跑一次即可获得可分叉 run。

## 5. 拒绝路径的原子性

所有新拒绝（无 system、工具表非法、proxy 缺 hash）都发生在 `loadForkParent` / `buildForkConfig` 阶段——早于 tracer 创建与模型请求，延续"零文件、零调用"纪律。录制侧"不写 hash 只写 `config_hash_reason`"仍是原子写盘（一条 meta 行内完成），不产生半成品 run。
