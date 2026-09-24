# 架构总览（Architecture）

> 权威的包清单与职责描述以仓库根 [`README.md`](../../README.md)「架构」节为准；本页是展开说明。

## Monorepo 结构

```text
packages/
  agent-loop   Agent 执行引擎（纯 TS，零 Electron 依赖，headless 可用）
  trace-sdk    span 埋点 API + trace 格式 v1 定义
  replay       回放编排器 + 沙箱管理器（CI 可用）
  llm-proxy    本地 LLM 录制代理（改 base_url 即录制）
  trace-test   Trace-as-Test：卡带重跑运行时回归测试（零网络 / 零落盘，CI 可用）
apps/
  desktop      Electron 桌面调试台（唯一依赖 Electron 的包，可替换）
```

workspace 定义在 `pnpm-workspace.yaml`（`packages/*` + `apps/*`）。

## 数据流

```text
模型调用 ──► llm-proxy（录制）─┐
Agent 执行 ──► trace-sdk 埋点 ─┼──► trace（JSONL，一 run 一文件）
桌面端「＋ 新建运行」──────────┘         │
                                        ▼
                    replay（回放/重跑/隔离沙箱编排）──► 新 trace
                                        │
                    trace-test（卡带断言） · model-ab CLI（多臂实验）
                                        ▼
                    apps/desktop（时间线 · 分支树 · 文件视图 · 实验分组）
```

## 设计原则

- **JSONL 是唯一事实源**：一 run 一文件、append-only；终止事件写入后封存，任何路径不得修改。
- **模型接入**：OpenAI 兼容协议直连，零厂商 SDK。
- **数据策略**：便携优先——所有数据在应用目录旁的 `data/`，永不写 AppData / 注册表。
- **Electron 可替换**：核心能力全部在 `packages/`，桌面端只是其中一个消费方。
- **隔离重跑不是权限系统**：文件检查点 + 副本世界只保证「父 run / 源目录 / 兄弟分支逐字节不变」，不隔离网络、shell 与外部状态源。

## 演进决策记录

能力的演进路线（A 段隔离内核 → B 段桌面入口 → C 段文件视图 → U 段可用性）以
`openspec/changes/archive/` 的归档 change 为权威：每个 change 含 proposal / design /
spec delta / tasks / evidence-index（实机验收证据索引）。产品方向定稿见
[`product/product.md`](../product/product.md)。
