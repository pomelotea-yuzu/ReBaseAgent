# 快速开始（Guide）

> 面向新用户：从零到第一次看到时间旅行调试界面。功能全貌与能力边界见仓库根 [`README.md`](../../README.md)。

## 1. 获取应用

两条路（Windows x64）：

- **便携版（推荐）**：从 GitHub 或 Gitee 的 Releases 页下载单文件 portable exe（当前体验包 `v0.3.0-k0`），双击即用，不写注册表、不写 AppData。
- **从源码运行**：

```bash
pnpm install
pnpm dev            # 启动 Electron 桌面应用
```

## 2. 三条上手路径

按你手头的东西选（详细步骤见根 README「快速开始」节）：

| 你的情况 | 路径 |
|---|---|
| 什么都没有，想先看看 | 桌面应用「＋ 新建运行」直接跑一个 run，无需代理与脚本 |
| 已有一个会调工具的 Agent | 用带写工具的 run：隔离文件运行，改某步 `tool_result` 后从副本世界续跑 |
| 已在用某家模型 API | 本地录制代理：只改 `base_url` 即可录制现有调用为 trace |
| 只想调试现成 Agent / 连执行引擎一起用 | SDK 接入：`packages/agent-loop`（引擎）或 `packages/trace-sdk`（埋点） |

## 3. 核心概念 1 分钟

- **run / trace**：一次 Agent 执行的完整记录，JSONL 一 run 一文件、append-only、终止后封存。
- **时间旅行**：改历史某步的 `tool_result` 或启动上下文，从那一步重跑——前缀共享，缓存命中时成本大幅降低。
- **Trace-as-Test**：把封存的 trace 变成卡带回归测试，零网络、零费用、可进 CI。
- **模型 A/B**：同一父 run 派生多臂实验，先 dry-run 看计划再真实执行。

## 4. 下一步

- 架构与包职责：[`architecture/overview.md`](../architecture/overview.md)
- 参与开发：[`development/workflow.md`](../development/workflow.md)
- 路线图与当前限制：根 [`README.md`](../../README.md) 对应章节
