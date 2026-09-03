# ReBaseAgent

> Agent 的时间旅行调试器——不止回放它做了什么，而是让你**改变**它做了什么。
> 本地运行，数据不出你的机器。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 为什么

对 Agent 而言，**上下文就是程序**（Context is the program）：system prompt 是源代码，消息历史是运行时状态，工具结果是输入数据。Agent 跑歪时，bug 不在你的 loop 代码里，而在某一步的上下文里——但现有工具只能"看"：云端平台（LangSmith/Langfuse）重且数据出境，本地工具（MITM 抓包类）只读不可改。

ReBaseAgent 是给"上下文"这门语言的调试器：

| 传统调试 | ReBaseAgent |
|---|---|
| Profiler | 上下文预算地图（token 花在哪了） |
| 改一行代码重跑 | 编辑某步 tool_result / prompt，从该步重跑 |
| 回归测试 | Trace-as-Test 轨迹回放 |
| git diff | 两次运行的分叉点定位 |

## 核心特性（路线图）

- **MVP**：span 时间线查看 · 上下文预算地图 · 时间旅行最小切片（编辑已录制 span 的 tool_result，沙箱中从该步重跑）
- **v2**：完整时间旅行（分支树 UI、改 prompt、多分支对照实验）
- **v3**：Trace-as-Test（严格重放进 CI）· 模型 A/B（同前缀分支换模型）

## 时间旅行怎么做到的

```text
回到第 N 步 = 查表（读取第 N 个 llm.call 的录制请求，零 API 调用）
编辑        = 修改该步的 tool_result 或 prompt
重跑        = 沙箱副本中从第 N 步继续执行（前缀全部本地命中，分支点后才真调 API）
```

边界（诚实声明）：时间旅行覆盖 loop 内状态；带副作用的工具按保真度分级标注；外部状态源（RAG/记忆/数据库）不承诺回退。

## 架构

```text
packages/
  agent-loop   纯 TS 的 Agent 执行引擎（零 Electron 依赖，headless 可用）
  trace-sdk    span 埋点 API + 格式定义
  replay       回放编排器 + 沙箱管理器（CI 可用）
  store        TraceStore：JSONL 事实源 + SQLite 可弃索引
apps/
  desktop      Electron 壳（唯一依赖 Electron 的包，可替换）
  examples     标本 agent（也是教程素材）
```

- 存储：JSONL 是唯一事实源，一 run 一文件，append-only；SQLite 只是桌面端缓存，删了可重建
- 模型接入：OpenAI 兼容协议直连（DeepSeek / GLM / Qwen / Kimi 开箱即用），零厂商 SDK
- 数据策略：便携优先——所有数据在应用目录旁的 `data/`，永不写 AppData/注册表

## 开发

```bash
pnpm install
pnpm dev        # 启动桌面应用
pnpm test       # vitest + Playwright
```

## 开发范式

本项目使用 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 做 Spec-Driven Development——每个能力先写 spec（proposal → 评审 → 实现 → 归档），见 `openspec/` 目录。

## License

MIT
