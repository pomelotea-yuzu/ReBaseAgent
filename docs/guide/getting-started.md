# 快速开始（Guide）

> **语言 / Language:** [English](getting-started.en.md) | 简体中文

> 面向新用户：从零到第一次看到时间旅行调试界面。功能全貌与能力边界见仓库根 [`README.md`](../../README.md)。

## 1. 获取应用

两条路（Windows x64）：

- **便携版（推荐）**：从 [GitHub](https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.7.0-rc.2) 或 [Gitee](https://gitee.com/yuzu-tea-duck/re-base-agent/releases/tag/v0.7.0-rc.2) 获取 `v0.7.0-rc.2` 的 `ReBaseAgent-0.7.0-rc.2-win-x64.zip`（`100,711,965` bytes，SHA-256 前缀 `46bf35061f7338b0`），用 7-Zip / WinRAR 解压后双击 exe 运行。该候选包含 R3 隔离项目验证、MCP 十三工具与全部已归档桌面能力；已上传 GitHub / Gitee Releases（2026-10-28 维护者确认），哈希与验收边界见[项目状态](../development/project-status.md)。应用数据在 exe 旁的 `data/`，启动时会临时解包。
- **从源码运行**：

```bash
pnpm install
pnpm check:build    # 先构建共享库，供桌面开发使用
pnpm dev            # 启动 Electron 桌面应用
```

## 2. 四条上手路径

按你手头的东西选（详细步骤见根 README「快速开始」节）：

| 你的情况 | 路径 |
|---|---|
| 什么都没有，想先看看 | 桌面应用「＋ 新建运行」直接跑一个 run，无需代理与脚本 |
| 想调试受控的文件任务 | 桌面隔离文件运行：导入目录，用固定读写工具执行，改某步 `tool_result` 后从副本世界续跑；不自动接管已有 Agent 的任意工具 |
| 已在用某家模型 API | 本地录制代理：只改 `base_url` 即可录制现有调用为 trace |
| 只想调试现成 Agent / 连执行引擎一起用 | SDK 接入：`packages/agent-loop`（引擎）或 `packages/trace-sdk`（埋点） |

## 3. 核心概念 1 分钟

- **run / trace**：一次 Agent 执行的完整记录，JSONL 一 run 一文件、append-only、终止后封存。
- **工具结果续跑**：编辑历史 `tool_result`，复用前缀消息并继续执行；隔离文件模式从该轮末尾检查点继续，不撤销该轮写入、不重执行被编辑工具。缓存收益取决于服务商和具体请求。
- **prompt fork**：改 system prompt 或首条 user message 后从头执行，父 run 用于溯源；隔离父本当前不支持。
- **Trace-as-Test**：把封存的 trace 变成卡带回归测试，零网络、零费用、可进 CI。
- **模型 A/B**：同一父 run 派生多臂实验，先 dry-run 看计划再真实执行。

## 4. 下一步

- 架构与包职责：[`architecture/overview.md`](../architecture/overview.md)
- 参与开发：[`development/workflow.md`](../development/workflow.md)
- 路线图与当前限制：根 [`README.md`](../../README.md) 对应章节
