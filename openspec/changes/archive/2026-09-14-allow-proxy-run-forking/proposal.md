# 允许代理录制 run 作为配置型分叉父本

## Why

当前本地 LLM 录制代理已经捕获了请求中的 `system` 消息和工具表，但落盘的 `run.meta` 不写 `config_hash`，同时 `packages/replay` 的共用父本门禁无条件拒绝 `source.kind = "proxy"`。因此，用户经代理得到的真实 run 不能直接用于 prompt fork 或模型 A/B；只能走单请求级 messages 重发，或另写 trace 生成器。这个断点与“零摩擦接入”及“从已有 run 做实验”的产品链路不一致。

`packages/agent-loop/src/config-hash.ts` 的输入只有 `{ systemPrompt, tools }`。代理请求快照已经包含 `messages` 与可选 `tools`，因此可从首次请求提取字符串 system 消息、按既有 `configHash()` 规则计算指纹。该判断的源码依据是 `config-hash.ts`、`packages/llm-proxy/src/handler.ts` 的请求快照和 `apps/desktop/src/main/proxy-recorder.ts` 的落盘路径；实现前须以 fixture 实测代理产物的 hash 与 `configHash()` 输出逐字节相等。

## What Changes

- 代理录制器从首次请求提取字符串形式的 system 消息和工具定义，写入与 agent-loop 相同规范化算法产生的 `meta.config_hash`；派生失败时写入结构化缺因 `meta.config_hash_reason`（`no_system` / `invalid_tool`），供门禁与桌面端给出可诊断的拒绝文案，而非笼统的单一提示。
- 代理录制的 run 在已具备 `config_hash`、已封存且首次请求含字符串 system 消息时，允许进入共用的 prompt fork 与 model A/B 父本校验。
- 保留双真相源校验：分叉运行配置仍须由录制的首次请求重建，并与父本配置指纹一致；不得从 hash 反推 system prompt 或工具表。
- 空工具表父本一并放行（`buildForkConfig` 的 `recordedTools === undefined` 由抛错改为空表）：既覆盖代理无工具 run（纯 chat 应用主路径），也覆盖引擎录制的空工具表 run（`run-loop.ts` 对空表不写 `tools` 字段）——后者此前同样被拒，属自然扩展，本次变更有意一并放开并补测。
- 保留代理专属的单请求级 messages 分叉通道及“最近捕获 key”语义；两种分叉产物都继续写入 parent/fork 元数据。
- 明确代理 run 仍不进入 world-free tool-result replay：代理只记录一次 `llm.call`，没有可供工具重放的 `tool.invoke` 前缀；该限制通过独立门禁和测试保持。同时以测试锁定其正确行为——代理 run 经 prompt fork 产出的子 run 是引擎 run，作父本时可正常 tool-result replay。

## Capabilities

### Modified Capabilities

- `llm-proxy`：成功录制的代理 run 增加可用于配置型分叉的 `config_hash` 元数据。
- `prompt-replay`：允许满足新父本条件的代理 run 作为 prompt fork 父本。
- `model-experiments`：允许满足新父本条件的代理 run 作为模型 A/B 父本。

## Goals

- 用户把应用接入代理后，无需写代码或手工生成 trace，即可在桌面端对该 run 发起 prompt fork 或模型 A/B。
- hash 计算与 agent-loop 共用同一实现和规范化语义，避免跨路径静默不等。
- 对缺少 system 消息、工具格式无效、旧代理 trace 等情况给出可诊断的拒绝，不生成半成品 run。

## Non-goals

- 不允许代理 run 进行 tool-result 时间旅行或真实副作用工具重跑；这属于后续 A2/A3。
- 不改变代理原始转发的字节保真、Authorization 只在内存暂存、端口或 upstream 行为。
- 不重算或迁移历史 `.rebaseagent/traces/` 文件；旧文件仍按缺少 `config_hash` 的既有边界处理。
- 不新增依赖，不引入 provider 专属参数白名单或生效性自检（属于后续 D3）。
- 不改变代理 messages 重发的 API key 来源、请求参数覆盖规则或 UI 文案之外的交互模型。

## 保真度边界

配置型分叉只复用代理录制的消息、工具表和模型请求事实；后续 LLM 调用是真实网络调用，结果不保证与原代理 run 相同。代理 run 的工具表仅用于配置指纹和 A/B/prompt fork 的一致性校验，不代表工具执行已被录制或可重放。无 system 消息、非字符串 system 内容或无法通过既有 schema 校验的工具表，均不得伪造 hash 放行。

## 证据与验证口径

- 源码依据：`packages/agent-loop/src/config-hash.ts` 定义 hash 输入与排序规则；`packages/llm-proxy/src/handler.ts` 已捕获请求字段；`apps/desktop/src/main/proxy-recorder.ts` 当前构造 `run.meta`。
- 未验证假设：所有 OpenAI 兼容客户端发来的工具定义都能无损转换为 `ToolDef`。用代理 handler 的最小 HTTP fixture 覆盖无 tools、单工具、多工具排序、`sideEffect` 缺省/显式两种情况，在 5 分钟内可证伪。
- 缺因可诊断：`deriveProxyConfigHash` 返回结构化结果（`{ hash, reason }`），录制侧把 `reason` 落进 `meta.config_hash_reason`；验收须覆盖 `no_system` 与 `invalid_tool` 两条拒绝路径给出不同文案，且历史无该字段文件走"缺因未知"分支。
- 兼容性外溢已核实：`run-loop.ts` 对空 `config.tools` 不写 `request.tools`，`configHash(system, [])` 合法——空工具表父本放行是自然扩展，须有专属测试（引擎空工具表 run 的 prompt fork 与模型 A/B）。
- 验收必须覆盖：新代理 run 的 hash 与 `configHash()` 相等；有 hash 的代理 run 可 prompt fork/A-B；代理 run 仍被 tool-result replay 拒绝；**代理 run 的 prompt fork 子 run 可作父本做 tool-result replay**；旧无 hash 文件行为不变；拒绝路径不写文件且不发起模型调用。

