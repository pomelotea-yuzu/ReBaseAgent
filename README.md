# ReBaseAgent

> Agent 的时间旅行调试器——不止回放它做了什么，而是让你**改变**它做了什么。
> 本地运行，数据不出你的机器。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/Release-v0.3.0--k0-green.svg)](https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.3.0-k0)

## 下载

**Windows x64 便携版（约 94 MB，<100 MB，免安装）** → [Releases](https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.3.0-k0)

当前版本线 **0.3.0-k0**（预览体验包）：实测单文件体积 `94,351,087` bytes，低于 Gitee 单附件 100 MB 上限。双击即用，不需要安装。所有数据写在 exe 旁的 `data/` 目录——**不写 AppData、不碰注册表、不留临时文件**。整个文件夹拷进 U 盘就能带走。

> 0.3.0-k0 是**预发布体验包**（提前试用新能力）。想要稳定版请取 [v0.2.0](https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.2.0)。

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

## 它现在能做什么（0.3.0-k0 · 含 V3a / V3b）

- **span 时间线** — 逐步查看每一次迭代、每一次 LLM 调用、每一次工具执行，以及模型当时实际看到的完整上下文
- **上下文预算地图** — token 花在哪了，按消息与工具分布可视化
- **Monaco 内联编辑** — 离线自托管，直接查看和编辑任意一步的 `tool_result`
- **时间旅行（最小切片）** — 改掉某一步脏掉的 `tool_result`，从那一步重跑：分叉点之前的上下文**本地拼接复用**（零 API 调用，不是"重放一遍"），只有分支点之后才真调 API；重发的前缀由 provider 的**前缀缓存**命中。实测（3 次调用的 run 改最后一步）：只发 **1 次**请求、484 输入 tokens **命中 256**，全价口径消耗为父 run 的 **21%~40%**
- **缓存命中记账与可视化（A2）** — `llm.call` 的 usage 记录 `cache_hit` / `cache_miss`（DeepSeek 扁平字段与 OpenAI 嵌套字段都认），llm.call 详情与 run 列表直接显示"这次调用的前缀省没省"；tool_result 分叉编辑器在「父 run 模型 ≠ 当前配置模型」时提示缓存可能不命中
- **分支轨迹** — 从已完成的 run 分叉，只记录新增 span，前缀按 parent 链共享
- **prompt fork（完整时间旅行）** — 改启动上下文（system prompt 或首条 user message）后**从头重跑**：独立记录完整新轨迹，父 run 只作溯源对照；分支树标注「从头重跑」，多分支对照可并排比较新旧行为
- **隔离文件重跑（A 段 · 包层）** — 从一个目录创建**带文件检查点**的隔离 run，编辑某步 `tool_result` 后从**那一轮的副本文件世界**续跑：父 run / 源目录 / 兄弟分支逐字节不变，同轮兄弟工具的原效果保留且不重放。附件按内容寻址、跨 run 共享，整体搬走数据目录后照样可读可分叉；源目录里的链接与 junction、超配额的输入在导入期就被拒绝。**一句话：带写工具的 run 也能安全地"退回去重跑"**（**包层已在 `main` 落地；桌面入口尚未进入发行包**，见 [`packages/replay`](packages/replay)）
- **本地 LLM 录制代理** — 在你的应用里把 `base_url` 改成本地代理地址即可录制与"编辑 messages 重发"，key 一字不动
- **Trace-as-Test（V3a）** — 已封存 trace 当卡带，用你当前的 agent-loop 与工具声明本地重跑：零 API 消耗的 Agent 运行时回归测试，可进 CI（见 [`packages/trace-test`](packages/trace-test)）
- **原生 run 创建（A1）** — 桌面端点「＋ 新建运行」直接跑一个 run（空工具表、纯对话），不依赖代理与脚本；产出的根 run 可直接作为 prompt fork / 模型 A/B / trace-test 的父本
- **模型 A/B 实验（V3b）** — 同一父 run 起点批量换 model / 采样参数（如 temperature 0.2 vs 1.5），多臂顺序执行、独立录制，结果按 experimentId 在分支树与对比面板分组。桌面端提供编辑器（dry-run 计划预览 → 费用确认），命令行提供 `rebaseagent-model-ab`
- **LLM 失败原因可诊断** — LLM 调用失败时，`llm.call` 记录脱敏并限长的 `error`（message + 已知时的 HTTP 状态码）：轨迹树标红该节点，详情直接给出原因与状态码，并声明 tokens/延迟是占位零值；老 trace 缺该字段时界面显示「错误详情未记录」而不猜造原因；Trace-as-Test 卡带消费到带 `error` 的录制会重现同样的失败

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
重跑        = 从第 N 步继续执行（前缀本地拼接复用，零调用；分支点后才真调 API）
             重发的前缀命中 provider 前缀缓存（实测：3 次调用 → 1 次，484 输入命中 256）

prompt fork = 编辑首次 llm.call 的启动上下文（system prompt / 首条 user message）
重跑        = 从第 1 步完整执行（启动上下文变了，前缀不复用——这是新实验，不是同源回放）
```

### 三种"重跑"的区别

|                | 普通重跑 / prompt fork | **隔离文件重跑**（A 段）    | Trace-as-Test 卡带   |
| -------------- | ----------------- | ------------------ | ----------------- |
| 文件从哪来          | 宿主磁盘（`exec.cwd`）  | 快照的**副本世界**        | 不涉及文件             |
| 工具怎么执行         | 调用方传入的 handler     | 固定 `file-tools-v1` | 不执行，逐条消费录制结果      |
| 文件状态能回退吗       | ❌ 不承诺             | ✅ 回到分叉那一轮的轮末状态     | —                 |
| 会真调 LLM        | 是（分支点之后）          | 是（分支点之后）           | 否（零网络、零费用）        |
| 适合             | 纯对话 / 只读工具        | **带写工具的 run**      | 已封存 trace 当回归用例   |

> 隔离重跑只保真**受控普通文件的内容**（逻辑路径 + 原始字节）；文件权限、时间戳、符号链接身份、网络与数据库**不在**保真范围内。

## 快速开始

### 什么都不写：在桌面应用里直接跑一个 run

便携版打开后，点左侧「运行记录」标题栏的 **＋ 新建运行**，填 system prompt 与 user message 即可跑一个原生 run（空工具表、纯对话）：

- 不需要配代理、不需要写代码、不需要外部应用配合
- 产出的 run 是根 run（`parent` / `fork` 为 `null`）且带 `config_hash`，可直接在其上做 **prompt fork / 模型 A/B / trace-test**
- 未在「设置」里配好 baseURL / apiKey / model 时会被拦下，不发起任何请求
- 模型调用失败时同样会落盘一个可查看的 run（列表徽标显示「出错终止」），不静默失败

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
- 代理录制的 run 现在会从请求体现算 `config_hash`（有 system + 可解析工具表时），因而**可以作为 prompt fork / 模型 A/B 的父本**；不含字符串 system 消息的录制（无法派生指纹）仍不能，只能走"编辑 messages 重发"
- **普通重跑**不真重跑带副作用的工具（world-free 重放：把录下的结果喂回模型，trace 内自洽）。需要"文件也跟着回退"的场景用**隔离文件重跑**（包层已落地）——它只保真**受控普通文件的内容**，外部状态源（RAG / 记忆 / 数据库 / 任意 API）仍然不承诺回退
- 命令行模型 A/B 首期只接受**空工具表**的父 run（纯对话任务）；带工具的实验请用桌面端
- **失败原因只覆盖端上模型的调用**：代理录制的 run 在其上游返回非 2xx 时不写 `llm.call`，这类失败没有调用级详情（界面会显示「错误详情未记录」）；脱敏是**尽力而为**——只覆盖本次配置的 apiKey / baseURL 凭据与 Authorization、Bearer、URL 凭据形态，不承诺识别任意业务文本里的所有秘密

## 路线图

- ✅ **v0.1.0（MVP）** — span 时间线 · 上下文预算地图 · 时间旅行最小切片 · trace 格式 v1 · Agent 执行引擎
- ✅ **v0.2.0（v2 完成）** — 本地 LLM 录制代理 · 分支树 UI · 改 prompt 重跑（prompt fork）· 多分支对照 · 体积瘦身与发行收口（<100 MB 便携版 + 品牌图标）
- ✅ **V3a（Trace-as-Test）** — 卡带重跑运行时回归测试 · 断言 DSL · runner API + CLI · 退出码 0/1/2
- ✅ **V3b（模型 A/B 实验）** — model_params fork 内核 · 多臂编排（副作用门禁 + dry-run/费用确认）· `rebaseagent-model-ab` CLI · 桌面端实验分组 UI
- ✅ **原生 run 创建入口（A1）** — 桌面端「＋ 新建运行」直接跑一个 run，无需代理/脚本；产出的 run 可立刻作为 prompt fork / 模型 A/B / trace-test 的父本
- ✅ **共享前缀重跑·缓存记账与成本兑现（A2）** — 先勘误：截断复用**早已实现**（分叉点前零 LLM 调用），原条目「当前所有重跑都是从头执行」是错的；本条目补的是**计费侧**——`cache_hit`/`cache_miss` 落 trace + 桌面端展示 + 真机实测，并把「成本约 1/4」改写成**区间 + 条件**（实测 3 次调用改最后一步 ⇒ 只发 1 次请求、全价口径 21%~40%，见上）
- ✅ **LLM 失败详情落盘与展示（`add-llm-error-detail`）** — 失败原因随 `llm.call.error` 落 trace（脱敏 + 限长 1024）、桌面端标红并展示原因与状态码、老/代理失败 run 诚实显示「错误详情未记录」、Trace-as-Test 卡带重现录制失败
- ✅ **v0.3.0-k0（预览体验包 · 已发布）** — 把上面五个能力（V3a 卡带回归 / V3b 模型 A/B / A1 原生建运行 / A2 缓存记账 / LLM 失败详情）打包成 Windows x64 便携版，已上传 GitHub 与 Gitee Releases。**本版不含隔离文件重跑**（见下条）
- ✅ **隔离文件真重跑（A 段 · 包层）** — 从一个目录创建**带文件检查点**的隔离 run；编辑某步 `tool_result` 后从**那一轮的副本文件世界**续跑，父 run / 源目录 / 兄弟分支逐字节不变，同轮兄弟工具的原效果保留且不重放；受控 `file-tools-v1`、内容寻址附件（跨 run 共享）、数据目录可整体迁移；源目录里的链接/junction 与超配额输入在导入期拒绝。详见 [`packages/replay`](packages/replay)
- 📋 **隔离执行的桌面入口（B/C 段）** — 目录选择 → 新建隔离 run → 改 result 分叉 → 重启与迁移后查看文件差异
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
