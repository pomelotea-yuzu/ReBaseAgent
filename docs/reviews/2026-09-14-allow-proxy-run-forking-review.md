# 审阅：`allow-proxy-run-forking` proposal

- 日期：2026-09-14
- 审阅对象：`openspec/changes/allow-proxy-run-forking/`（proposal.md / design.md / tasks.md / specs/*/spec.md）
- 审阅方式：逐条比对仓库实际结构（config-hash.ts、fork-parent.ts、proxy-recorder.ts、fork-runner.ts、handler.ts、prompt-fork.ts、DetailPanel.tsx）
- 结论：**方向正确，设计质量高，有 2 个 P1 和 2 个 P2 需要澄清或调整**。修完可以 apply。

---

## 总评

这个 proposal 解决的是一个真实的产品断点：代理录制的 run 无法用于 prompt fork / 模型 A/B，与"零摩擦接入"的产品链路不一致。设计思路清晰——**录制侧补指纹，fork 侧放门禁，不建第二套通道**——这是正确的选择。复制第二套编排必然在某个分支上悄悄少一条门禁（fork-parent.ts 注释原话），design.md 把这个洞察写进去了，很好。

保真度边界（sideEffect 字段、跨进程指纹不互通）和拒绝路径原子性（零文件、零调用）都考虑到了，这是成熟的设计。

问题集中在**实现细节的完整性和边界情况的测试覆盖**上。

---

## P1：实现细节不完整，可能导致返工

### P1-1 工具解包复用的依赖关系未说明

design.md 第 2 节：

> 桌面 `fork-runner.ts` 现有的 `toToolDefs` / `unwrapToolDef`（同时支持扁平 ToolDef 与 OpenAI `function` 包装两种形状）移入 replay 包导出，桌面改为引用。

任务 1.1：

> 把桌面 `fork-runner.ts` 的 `toToolDefs` / `unwrapToolDef` 抽到 `@rebaseagent/replay` 导出（解包后经 `ToolDefSchema` 校验），桌面改为引用

**问题**：
- `toToolDefs` 在桌面端会抛 `ForkError`（fork-runner.ts:357-362），错误码是 `FORK_NO_CONTEXT`
- 如果直接移到 replay 包，replay 包需要知道 `ForkError` 类型
- 但 `ForkError` 定义在桌面 `fork-runner.ts`（fork-runner.ts:40-48），不是 replay 的依赖

**风险**：
- 实现时可能需要在 replay 包重新定义错误类型，或者把 `ForkError` 也移到 replay
- 这会影响桌面的错误处理逻辑（IPC 错误码映射）

**建议**：
- 在 design.md 或 tasks.md 明确说明错误类型的归属
- 两种选择：
  1. replay 包定义通用的 `ToolUnwrapError`，桌面捕获后转成 `ForkError`（保持 IPC 错误码稳定）
  2. 把 `ForkError` 移到 replay 包，桌面直接 import（需要检查循环依赖）

### P1-2 proxy 缺 hash 的专属文案需要区分缺因

design.md 第 3 节：

> proxy 且缺 hash：专属文案，说明缺因（首次请求无字符串 system 消息或工具表无法解析），并指向既有"编辑 messages 重发"入口或重新经代理录制带 system 的请求

**问题**：
- proxy 缺 hash 有两种原因：
  1. 无字符串 system 消息
  2. 工具表无法解析（任一工具项无法通过 `ToolDefSchema` 校验）
- 这两种情况的修复路径不同：
  1. 需要源应用发送带 system 消息的请求
  2. 需要源应用修正工具定义格式（或 ReBaseAgent 扩展解包逻辑）

**风险**：
- 如果文案只说"缺 config_hash"，用户不知道如何修复
- 如果文案笼统说"无字符串 system 消息或工具表无法解析"，用户仍然不知道是哪种情况

**建议**：
- 在 `deriveProxyConfigHash` 返回 `null` 时，附带失败原因（枚举：`NO_SYSTEM` / `INVALID_TOOL`）
- 或者在 `ProxyRunRecorder.write` 中，如果 hash 派生失败，记录失败原因到 meta（例如 `meta.config_hash_reason: "no_system"`）
- 门禁拒绝时根据这个字段给出精准文案

---

## P2：边界情况需要确认或补充测试

### P2-1 `buildForkConfig` 改动可能改变现有行为

design.md 第 4 节：

> `buildForkConfig`（fork-runner.ts）：`recordedTools === undefined` 从抛 `FORK_NO_CONTEXT` 改为空表 `[]`。
> 
> 兼容性外溢：引擎空工具表 run（`run-loop.ts` 对空表不写 `tools` 字段）此前同样被拒，现在一并放行——hash 对空表成立，属自然扩展而非行为破坏。

**问题**：
- 当前 `buildForkConfig` 在 `recordedTools === undefined` 时抛错（fork-runner.ts:172-174）
- 改成空表后，引擎录制的空工具 run（之前被拒绝）现在可以被 fork
- 这是一个**行为变更**，虽然 design 说是"自然扩展"

**需要确认**：
- 引擎是否真的会录制 `tools: undefined` 的 run？
  - 检查 `run-loop.ts`：如果 `config.tools` 是空数组，`request.tools` 是 undefined 还是不写？
  - 检查 `config-hash.ts`：`configHash(system, [])` 是否合法？（看起来是合法的）
- 如果有引擎空工具 run 的测试用例，需要更新预期

**建议**：
- 在任务 1.2 或 2.2 中明确添加一个测试用例：引擎空工具表 run 的 prompt fork
- 如果确认这是期望行为，在 proposal 的"What Changes"中明确列出（当前只提到代理 run）

### P2-2 代理子 run 的 tool-result replay 测试缺失

design.md 第 3 节末尾：

> **注意**：代理 run 经 prompt fork 产出的子 run 是引擎 run（`runLoop` 录制、有完整 `tool.invoke` 轨迹、无 proxy source），它作为父本时可正常 tool-result replay——这是正确行为，不是漏洞。

**问题**：
- 任务 1.4 说"以测试锁定代理 run 仍不可 tool-result replay"
- 但没有提到测试"代理 run 的子 run 可正常 tool-result replay"

**风险**：
- 这个"正确行为"没有被测试锁定
- 未来如果有人误加门禁（例如检查祖先链中是否有 proxy），可能破坏这个行为

**建议**：
- 在任务 4.1 或 4.2 中补充：代理 run → prompt fork → 子 run → tool-result replay 的集成测试
- 或者在任务 1.4 中明确说明"同时测试子 run 的 tool-result replay 正常"

---

## P3：文档化改进（可选）

### P3-1 sideEffect 保真度边界应在 spec 中明确

design.md 第 2 节末尾：

> **sideEffect 保真度边界**：OpenAI wire 格式不携带 `sideEffect`，解包结果天然无该字段，`configHash` 仅在字段有值时计入——代理指纹是"线上事实"的指纹。若源应用恰好也是 ReBaseAgent 引擎且工具带 `sideEffect` 标记，代理侧 hash 与其进程内 hash **不保证相等**（标记不上线）。本变更只承诺：同一代理录制派生的 hash 与从该录制重建的子 run hash 一致；不承诺跨进程指纹互通。

**问题**：
- 这段讨论很重要，但只在 design.md 中
- spec 的"代理 run 写入与引擎一致的配置指纹"要求没有提到 sideEffect 的处理

**建议**：
- 在 `specs/llm-proxy/spec.md` 的"代理 run 写入与引擎一致的配置指纹"要求中补充一句：
  > wire 格式不携带 `sideEffect`，指纹按「字段缺失」语义计入；不承诺与源应用进程内指纹互通。

---

## 其他观察

### 任务分解质量

tasks.md 的任务分解很细致，每个任务都有明确的验收标准。特别是：
- 任务 1.2 明确要求"单测断言与 `configHash()` 逐字节相等（无 tools、单工具、name 乱序多工具、sideEffect 缺省四种 fixture）"
- 任务 2.1 明确要求"单测覆盖含 system+tools、无 system、非法 tools、error outcome"

这是好的实践，建议保持。

### 未验证假设的显式列出

proposal.md 的"证据与验证口径"部分：

> 未验证假设：所有 OpenAI 兼容客户端发来的工具定义都能无损转换为 `ToolDef`。用代理 handler 的最小 HTTP fixture 覆盖无 tools、单工具、多工具排序、`sideEffect` 缺省/显式两种情况，在 5 分钟内可证伪。

这是成熟的做法——显式列出未验证假设，并给出验证方法。

---

## 总结

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P1-1 | 工具解包复用的依赖关系未说明 | 明确错误类型的归属（replay 定义通用错误 vs 移动 ForkError） |
| P1-2 | proxy 缺 hash 的专属文案需要区分缺因 | `deriveProxyConfigHash` 返回失败原因，或 meta 记录 `config_hash_reason` |
| P2-1 | `buildForkConfig` 改动可能改变现有行为 | 确认引擎空工具 run 的预期行为，补充测试用例 |
| P2-2 | 代理子 run 的 tool-result replay 测试缺失 | 补充集成测试：代理 run → prompt fork → 子 run → tool-result replay |
| P3-1 | sideEffect 保真度边界应在 spec 中明确 | 在 llm-proxy spec 中补充 sideEffect 处理说明 |

修完 P1 和 P2 可以 apply。P3 是文档化改进，可以在实现过程中顺手做。
