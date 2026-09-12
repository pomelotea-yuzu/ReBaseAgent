# ReBaseAgent

> Agent 的时间旅行调试器——不止回放它做了什么，而是让你**改变**它做了什么。
> 本地运行，数据不出你的机器。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/Release-v0.2.0-green.svg)](https://github.com/pomelotea-yuzu/ReBaseAgent/releases)

## 下载

**Windows x64 便携版（约 94 MB，<100 MB，免安装）** → [Releases](https://github.com/pomelotea-yuzu/ReBaseAgent/releases)

实测单文件体积 `94,316,503` bytes，低于 Gitee 单附件 100 MB 上限（v0.1.0 仍保留可回滚）。双击即用，不需要安装。所有数据写在 exe 旁的 `data/` 目录——**不写 AppData、不碰注册表、不留临时文件**。整个文件夹拷进 U 盘就能带走。

> 首次运行会有 Windows SmartScreen 的"未知发布者"提示（本项目尚未购买代码签名证书），点「更多信息 → 仍要运行」即可。

## 为什么

对 Agent 而言，**上下文就是程序**（Context is the program）：system prompt 是源代码，消息历史是运行时状态，工具结果是输入数据。Agent 跑歪时，bug 不在你的 loop 代码里，而在某一步的上下文里——但现有工具只能"看"：云端平台（LangSmith/Langfuse）重且数据出境，本地工具（MITM 抓包类）只读不可改。

ReBaseAgent 是给"上下文"这门语言的调试器：

| 传统调试 | ReBaseAgent |
|---|---|
| Profiler | 上下文预算地图（token 花在哪了） |
| 改一行代码重跑 | 编辑某步 tool_result，从该步重跑 |
| 回归测试 | Trace-as-Test 轨迹回放 |
| git diff | 两次运行的分叉点定位 |

## 它现在能做什么（v0.2.0 · 含 V3a / V3b）

- **span 时间线** — 逐步查看每一次迭代、每一次 LLM 调用、每一次工具执行，以及模型当时实际看到的完整上下文
- **上下文预算地图** — token 花在哪了，按消息与工具分布可视化
- **Monaco 内联编辑** — 离线自托管，直接查看和编辑任意一步的 `tool_result`
- **时间旅行（最小切片）** — 改掉某一步脏掉的 `tool_result`，从那一步重跑。前缀全部本地命中，只有分支点之后才真正调 API
- **分支轨迹** — 从已完成的 run 分叉，只记录新增 span，前缀按 parent 链共享
- **prompt fork（完整时间旅行）** — 改启动上下文（system prompt 或首条 user message）后**从头重跑**：独立记录完整新轨迹，父 run 只作溯源对照；分支树标注「从头重跑」，多分支对照可并排比较新旧行为
- **本地 LLM 录制代理** — 在你的应用里把 `base_url` 改成本地代理地址即可录制与"编辑 messages 重发"，key 一字不动
- **Trace-as-Test（V3a）** — 已封存 trace 当卡带，用你当前的 agent-loop 与工具声明本地重跑：零 API 消耗的 Agent 运行时回归测试，可进 CI（见 [`packages/trace-test`](packages/trace-test)）
- **模型 A/B 实验（V3b）** — 同一父 run 起点批量换 model / 采样参数（如 temperature 0.2 vs 1.5），多臂顺序执行、独立录制，结果按 experimentId 在分支树与对比面板分组。桌面端提供编辑器（dry-run 计划预览 → 费用确认），命令行提供 `rebaseagent-model-ab`

CLI（均含 `--help`，退出码 0=成功 / 1=执行失败 / 2=配置错误）：

```bash
# Trace-as-Test：卡带重跑回归（零网络、零费用，可进 CI）
rebaseagent-trace-test tests/agent.trace.test.jsonl --config agent.config.mjs

# 模型 A/B：先 dry-run 看计划（免密钥、不联网），再真实执行（按臂数计费，需 REBASEAGENT_API_KEY）
rebaseagent-model-ab --parent <runId> --dir <tracesDir> \
  --arm "deepseek-chat;temperature=0.2" --arm "deepseek-chat;temperature=1.5" \
  [--dry-run | --confirm-cost]
```

时间旅行的实现方式：

```text
回到第 N 步 = 查表（读取第 N 个 llm.call 的录制请求，零 API 调用）
编辑        = 修改该步的 tool_result
重跑        = 从第 N 步继续执行（前缀全部本地命中，分支点后才真调 API）

prompt fork = 编辑首次 llm.call 的启动上下文（system prompt / 首条 user message）
重跑        = 从第 1 步完整执行（启动上下文变了，前缀不复用——这是新实验，不是同源回放）
```

## 快速开始

### 只想调试现成的 Agent

用 SDK 在你的 loop 里埋点，把 trace 写进桌面应用的数据目录（便携版默认在 exe 旁的 `data/traces/`）：

```ts
import { JsonlTracer } from "@rebaseagent/trace-sdk";

const tracer = new JsonlTracer("traces/r_01.jsonl");
tracer.startRun({
  id: "r_01", format_version: 1, task: "读 README 写摘要",
  model: "deepseek-chat", created_at: new Date().toISOString(),
  parent: null, fork: null, config_hash: "sha256:...",
});

const step = tracer.startSpan({ kind: "agent.step", n: 1 });
const llm = tracer.startSpan({ kind: "llm.call", parent: step, request });
tracer.endSpan(llm, { response });
tracer.endSpan(step);

tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
```

格式细节见 [`packages/trace-sdk`](packages/trace-sdk)。

### 想连执行引擎一起用

`@rebaseagent/agent-loop` 是纯 TypeScript 的 Agent 执行引擎，OpenAI 兼容协议直连，**零厂商 SDK**：

```ts
import { runLoop, parseRunConfig, OpenAiCompatClient } from "@rebaseagent/agent-loop";
import { JsonlTracer } from "@rebaseagent/trace-sdk";

const config = parseRunConfig({
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-...",
  model: "deepseek-chat",
  systemPrompt: "你是文件助手。",
  tools: [/* OpenAI function calling 子集 */],
  maxIterations: 25,
  budget: { maxTotalTokens: 100_000 },
});

const result = await runLoop(
  config,
  [{ role: "system", content: config.systemPrompt }, { role: "user", content: "读 README" }],
  new JsonlTracer("traces/r_01.jsonl"),
  tools,
  new OpenAiCompatClient(config),
);
```

DeepSeek / GLM / Qwen / Kimi 等 OpenAI 兼容端点开箱即用。

## 当前限制（诚实声明）

- 只构建了 **Windows x64**，macOS / Linux 尚未出包
- **接入仍需手工**：要么在代码里接 SDK，要么在设置里填 API key。本地录制代理已落地（只改 `base_url` 即可录制），进一步零摩擦（自动发现、一键引导）在迭代
- 时间旅行现在支持**改 `tool_result`（从该步重跑，前缀共享）与改启动上下文（system prompt / 首条 user message，从头重跑）**；中间历史消息编辑尚不支持
- prompt fork **从头计费**：启动上下文变了前缀天然不复用，不承诺命中父 run 的 prompt cache（是否命中由 provider 自行决定）
- 代理录制的 run 没有 `config_hash`，不能作为 prompt fork / tool_result 重跑 / 模型 A/B 的父本，只能走"编辑 messages 重发"
- 桌面端还没有"直接新建一个 run"的入口：原生（非代理）父 run 目前只能通过 SDK 埋点产生
- 带副作用的工具默认**不真重跑**：replay 是 world-free 重放，把录下的结果喂回模型，trace 内自洽。外部状态源（RAG / 记忆 / 数据库）不承诺回退
- 命令行模型 A/B 首期只接受**空工具表**的父 run（纯对话任务）；带工具的实验请用桌面端

## 路线图

- ✅ **v0.1.0（MVP）** — span 时间线 · 上下文预算地图 · 时间旅行最小切片 · trace 格式 v1 · Agent 执行引擎
- ✅ **v0.2.0（v2 完成）** — 本地 LLM 录制代理 · 分支树 UI · 改 prompt 重跑（prompt fork）· 多分支对照 · 体积瘦身与发行收口（<100 MB 便携版 + 品牌图标）
- ✅ **V3a（Trace-as-Test）** — 卡带重跑运行时回归测试 · 断言 DSL · runner API + CLI · 退出码 0/1/2
- ✅ **V3b（模型 A/B 实验）** — model_params fork 内核 · 多臂编排（副作用门禁 + dry-run/费用确认）· `rebaseagent-model-ab` CLI · 桌面端实验分组 UI
- 📋 **原生 run 创建入口** — 桌面端直接新建运行（当前 run 只来自录制代理与 fork，A/B 实验的父 run 需 SDK/脚本产生）
- 📋 **共享前缀重跑** — 改中间某步后只重跑该步之后（前缀本地命中，成本约 1/4），替代全量从头重跑
- 📋 **隔离世界真重跑** — 带副作用工具在 COW/快照沙箱中真实执行（sideEffect 分级已预埋）
- 📋 **工程与分发** — 面向新用户的 quickstart 文档 · macOS/Linux 打包评估 · 协作分享（trace 包导出）

## 架构

```text
packages/
  agent-loop   Agent 执行引擎（纯 TS，零 Electron 依赖，headless 可用）
  trace-sdk    span 埋点 API + trace 格式 v1 定义
  replay       回放编排器 + 沙箱管理器（CI 可用）
  trace-test   Trace-as-Test：卡带重跑运行时回归测试（零网络 / 零落盘，CI 可用）
apps/
  desktop      Electron 桌面调试台（唯一依赖 Electron 的包，可替换）
```

- **存储**：JSONL 是唯一事实源，一 run 一文件、append-only；终止事件写入后封存，任何路径不得修改
- **模型接入**：OpenAI 兼容协议直连，零厂商 SDK
- **数据策略**：便携优先——所有数据在应用目录旁的 `data/`，永不写 AppData / 注册表

## 开发

```bash
pnpm install
pnpm dev            # 启动桌面应用
pnpm test           # vitest（零 API 消耗，全部 mock 注入）
pnpm build          # 构建所有包（含 desktop 前端资源）

# CI 质量门禁：与云端 CI（Gitee Go 流水线 .workflow/ci.yml）跑同一条命令链
pnpm check:ci       # = check:build → check:typecheck → check:test → check:lint → check:spec

pnpm --filter @rebaseagent/desktop dist   # 打包 Windows portable exe
```

两条构建命令的分工：`pnpm check:build`（`check:ci` 的第一步）只构建 `packages/*` 的库产物，供测试与跨包消费使用；`pnpm build` 是完整构建，额外包含 desktop 的 `electron-vite` 前端打包，供开发者本地使用。二者不可互相替代。

CI 载体：首期为 **Gitee Go**（`.workflow/ci.yml`，push 到 main 与 PR 触发，零密钥）；GitHub 账号解封后将补配 GitHub Actions 调用同一条 `pnpm check:ci`。

本项目使用 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 做 Spec-Driven Development——每个能力先写 spec（proposal → 评审 → 实现 → 归档），见 `openspec/` 目录。

## License

MIT
