# 任务

## 1. 共享解包与 hash 派生（replay 包）

- [ ] 1.1 把桌面 `fork-runner.ts` 的 `toToolDefs` / `unwrapToolDef` 抽到 `@rebaseagent/replay` 导出（新模块，紧邻 `fork-parent.ts`），解包后经 agent-loop `ToolDefSchema` 校验。
  - 错误类型归属：replay 侧定义自有 `ToolUnwrapError extends Error`（携带 `kind` / `toolName` 等诊断字段），解包失败抛它；**不把桌面的 `ForkError` 移入 replay**。
  - 桌面 `fork-runner.ts` 在调用点 catch `ToolUnwrapError` 并转成既有 `ForkError("FORK_NO_CONTEXT", ...)`，保留原中文文案——IPC 错误码与渲染层处理零变化。
  - 验收：replay 侧新单测断言 `ToolUnwrapError`；桌面既有 `runFork` / `runPromptFork` 的"工具表无法解析"用例仍断言 `FORK_NO_CONTEXT`（回归保护）。
- [ ] 1.2 在 replay 新增纯函数 `deriveProxyConfigHash(request)`：返回**结构化结果** `{ hash: string; reason: null } | { hash: null; reason: "no_system" | "invalid_tool" }`（不是裸 `string | null`）。
  - system 复用 `locateStartupContext`；无字符串 system → `no_system`；tools 缺省视为空表；任一工具解包/schema 校验失败 → `invalid_tool`，不做部分哈希。
  - 单测断言与 `configHash()` 逐字节相等（无 tools、单工具、name 乱序多工具、sideEffect 缺省四种 fixture），并覆盖两条缺因分支的 `reason` 取值。
- [ ] 1.3 放宽 `loadForkParent`：移除 proxy 无条件拒绝，缺 `config_hash` 统一拦截。
  - proxy 且缺 hash 时**按 `meta.config_hash_reason` 分流文案**（`no_system` → 指向重新经代理录制带 system 的请求；`invalid_tool` → 指向修正工具定义后重发；字段缺失 → 指向「编辑 messages 重发」入口）。
  - 非 proxy 且缺 hash 保持旧文案（回归）。
  - 更新拒绝顺序注释与测试：proxy+hash 放行、proxy 缺 hash 的三条缺因分支各自文案、旧文案回归。

## 2. 录制侧与桌面编排

- [ ] 2.1 `ProxyRunRecorder.write` 调 `deriveProxyConfigHash`：`hash !== null` 时写 `meta.config_hash`；`hash === null` 时写 `meta.config_hash_reason`（二者互斥）。
  - 单测覆盖含 system+tools、无 system（→ `no_system`）、非法 tools（→ `invalid_tool`）、error outcome（请求快照可派生即写、无 llm.call 不影响落盘形状）。
  - 确认 `config_hash_reason` 为可选字段，旧文件读取不受影响。
- [ ] 2.2 `buildForkConfig`：`recordedTools === undefined` 改为空表 `[]`（代理无工具主路径 + 引擎空工具表兼容）；带未知工具的代理父本仍被 `UNKNOWN_TOOL` 拒绝。
  - 补测试：**引擎空工具表 run 的 prompt fork**（父 run 由真实 `runLoop` 以空 `config.tools` 现造，验证 `request.tools` 缺省仍可 fork、子 run `config_hash` 与父逐字节一致）。
- [ ] 2.3 更新 fork IPC 错误映射/文案：proxy 缺 hash 的拒绝在渲染层可读（沿用既有 `FORK_NO_CONTEXT` / `PROMPT_FORK_*` 错误码即可，文案由 `loadForkParent` 给出）；既有错误码语义不变。
- [ ] 2.4 renderer `DetailPanel` 的 `promptForkable` 移除 `!isProxy`（保留 completed + config_hash + leafOwned）；有 hash 的代理 run 显示 prompt fork / A/B 编辑器，无 hash 代理 run 不显示编辑器、`canResend` 保持。

## 3. 集成测试：代理 run 作为父本

- [ ] 3.1 replay 集成测试（mock client）：含 hash 的代理 fixture 父本（含 system、无 tools）可 prompt fork（system_prompt / user_message）与模型 A/B；各臂子 run `config_hash` 与父逐字节一致；parent/fork 元数据正确；缺 hash 拒绝路径零文件零调用。
- [ ] 3.2 以测试锁定代理 run 仍不可 tool-result replay：`runFork` 的 at_span=tool.invoke 校验对无 tool.invoke 的代理 run 结构性拒绝；trace-test 的 staticOnly 判据不变。
- [ ] 3.3 **（P2-2）** 以集成测试锁定正确行为：代理 run → prompt fork → 子 run（引擎 run，含 tool.invoke）→ **以子 run 作父本做 tool-result replay 正常**（防止未来误加"祖先链含 proxy 即拒绝"的门禁）。
- [ ] 3.4 桌面测试：代理产物（system、无 tools）→ prompt fork → 子 run 出现在分支树且可查看；旧无 hash 代理文件行为不变（缺因未知文案正确）。

## 4. 全量验证

- [ ] 4.1 各包 vitest（`pnpm -r test`）、Biome（0 errors）、双端 TypeScript、`electron-vite build`。
- [ ] 4.2 `pnpm check:ci`（build 仅 `packages/*` → typecheck desktop → test → lint → spec）全绿；`openspec validate` 通过。
- [ ] 4.3 真实 provider smoke 仅需用户凭据、不进 CI（手工验证一次代理录制 → prompt fork → A/B 全链路）。
