# V3b 模型 A/B 与分支实验

## Why

V3a 的卡带测试冻结了模型回答，能够验证 Agent harness 的回归，却不能回答“换模型或采样参数后任务行为是否变化”。仓库已有 prompt fork：它从父 run 首次 `llm.call.request.messages` 派生启动上下文，完成前置校验后从头真实重跑并产生 fork run。V3b 只需把可编辑配置扩展到 `model` 与数值采样参数，就能把 A/B 结果放入同一条已有分支树和 ComparePanel，避免第二套实验持久化与比较语义。

## Goals

- 在一个已封存的非 proxy 父 run 上创建两个或以上模型配置分支。
- 一次实验允许同时修改 `model` 和 `params`，每个分支从同一父 run 的首次请求 messages 从头真实执行。
- 复用 `packages/replay` 的 prompt fork 编排、`runLoop`、`JsonlTracer`、父链、封存门禁和现有分支树/ComparePanel。
- 复用现有 `config_hash` 语义：system prompt 与工具表不变时，换 model/params 仍是同源合法实验；比较口径统一使用现有共同祖先与链路派生指标。
- 提供 CLI/API 与桌面显式入口，支持 dry-run、真实调用确认、每臂独立失败和可追溯的 `fork.edit` 元数据。
- 允许一次实验内的多个 arm 通过可选 `experimentId` 标记为同一批实验，供 UI 分组与默认配对。

## Non-goals

- 不新建 `ExperimentRecord`、实验目录、第二套 JSONL 解析器或第二套比较面板。
- 不支持跨 provider、每个 arm 独立 apiKey 或多 provider 并行；首期使用当前 settings 的单一 `baseURL`/apiKey，跨 provider 需要独立凭据管理 change。
- 不改变 trace v1、`ForkSchema`、`runs:fork`、`proxy:fork` 或 `config_hash` 的既有语义。
- 不支持非数值采样参数（如 `response_format`、`stop` 对象）；首期 `params` 限定为 `Record<string, number>`。
- 不默认运行带真实副作用的工具实验。工具表中存在 `sideEffect !== false` 的工具时，实验在网络调用前拒绝；仅在调用方显式声明 `allowSideEffects` 时放行，并把该声明记入 `fork.edit.value` 供审计，UI 标注"顺序执行、外部状态可能已被前一臂改变"。隔离文件系统或可逆副作用留给后续 change。
- CLI 首期只支持空工具表（纯对话任务）：replay 包不提供工具 handler，`StubToolTable` 不得冒充真实结果，桌面端的内置 handler 也不跨进程复用。
- 不做自动评分、显著性检验、价格表或“最佳模型”推荐；缺少调用方提供的价格估算器时成本保持 unknown。比较只展示各臂相对父 run 的累计增量，不产出臂间差值或最佳模型结论。

## 保真度边界

实验是真实模型调用。模型响应、延迟、工具选择和 provider 计费具有外部依赖性。复用的 `runLoop` 与 `JsonlTracer` 是真实执行内核；V3a 的 `CassetteLlmClient`/`StubToolTable` 只属于卡带回归测试，不用于本 change。模型 A/B 只在共享父 run、共享启动 messages、共享 system prompt/工具表时声明可比；带副作用的工具在显式确认下可以执行，但比较结果只陈述事实、不承担"臂间公平"的承诺。

## Acceptance gates

- `openspec validate --all --strict` 通过，spec 使用 `## Purpose`、`## ADDED Requirements` 和四级 Scenario 标题。
- 每个 arm 的 `RunConfig` 补齐现有必填 `exec.cwd`、`maxIterations`、`budget`、apiKey 来源和含 handler 的工具表；实验输入不伪造缺省配置。
- 首次请求 messages 是唯一启动上下文来源；父 run 首次 `llm.call` 必须含字符串 system 消息，且当前 `RunConfig.systemPrompt` 必须与之逐字节相同——**先校验后覆写**，不一致时前置失败且零文件、零模型调用（沿用覆写会让该校验永不触发）。
- 同一父 run 下的多个 model/params 分支能被现有分支树和 ComparePanel 识别为共同祖先；同一次实验的 arm 通过 `experimentId` 分组，缺省时退化为用户在 UI 手选。单臂失败不覆盖其他分支。
- 任何副作用工具（未显式 `allowSideEffects`）、跨 provider 配置、父 run 未封存、proxy run、缺少 system 消息、空编辑或配置漂移均在调用前明确拒绝。
- apiKey 不进入 fork 元数据、trace、CLI 输出或错误文本；报告不截断原始 trace，UI 继续使用折叠展示。

## 当前未实现

本 change 只完成规划修订，尚未修改 packages、apps、trace 文件或用户配置。
