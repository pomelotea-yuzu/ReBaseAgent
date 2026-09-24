# ReBaseAgent 路线图与缺口清单（2026-09-09）

> 基于 V3b 归档 + 真实 A/B 冒烟通过后的现状盘点。README 路线图只保留条目，本文记录背景与验收口径。
> 原则（沿用）：不为变现破坏「本地不出机器」；明确不是 agent 构建器（平台化已否决）。

## 现状基线

- **已发布**：v0.2.0 portable exe（94,316,503 bytes，GitHub/Gitee 双平台附件），GitHub 优先发布。
- **V3 三大件落地**：① 零摩擦录制（本地 LLM 代理）② 时间旅行调试（tool_result 重跑 / prompt fork）③ Trace-as-Test（V3a）+ 模型 A/B 实验（V3b）。
- **工程底盘**：主 spec 10 个（openspec strict 10/10）；测试全绿（trace-sdk 75 / agent-loop 52 / replay 66 / llm-proxy 16 / trace-test 65 / desktop 156，零 API）；biome 0 errors；electron-vite build 通过。
- **V3b 闭环**：proposal → 三审 → apply（fd3ab71）→ archive（42005a5）→ 真实 provider A/B 冒烟通过（exp_mttvdcko_6h5c 两臂成功）→ push 双远程（含 c912359 冒烟脚本）。

## A. 产品核心缺口（下一版本主线，按优先级）

### A1. 原生 run 创建入口（小，高杠杆）

- **缺口**：桌面端 run 只有两个来源——本地录制代理（proxy）与 fork。没有"直接在桌面跑一个 run"的入口。
- **后果**：model-ab / CLI 没有合法父 run（proxy 父 run 被 fork 门禁拒绝），只能靠 SDK 埋点或 `scripts/create-ab-parent.mjs` 造。陌生用户拿到便携版后无法从头体验完整链路。
- **方案**：新增"新建运行"面板（baseURL / apiKey / model / systemPrompt / task，默认空工具表），复用 fork-runner 的 RunConfig 组装与 runLoop。
- **验收**：便携版双击 → 新建运行 → 得到原生父 run → 直接在其上跑 A/B / prompt fork / trace-test，全程无需写代码。

### A2. 共享前缀重跑（中）

- **缺口**：当前所有重跑都是从头执行。产品化清单策划的"改第 N 步脏 tool_result → 只重跑后半段，成本约 1/4"未做。
- **价值**：这是"省钱"卖点最直观的演示素材（hook demo），也是与 LangSmith/Langfuse 拉开差距的功能；抢在它们补齐 rerun 前占位。
- **方案**：从第 N 步的 llm.call 录制请求重建启动上下文（已具备，fork-parent 已抽取共用校验），前缀消息直接复用录制值。
- **验收**：3 步 run 改第 2 步 tool_result 重跑，只有第 2 步之后的 llm.call 真实发生，成本约为从头重跑的 1/3~1/4。

### A3. 隔离世界真重跑（中）

- **缺口**：sideEffect 分级只是预埋；带真实写文件的工具重跑仍是空档（world-free 重放只喂录制结果）。
- **方案**：显式"真重跑"时在 COW/快照沙箱中执行带副作用工具，按分级授权。
- **依赖**：可与 A2 合并为一个 change（执行内核改动同源）。

## B. 分发与信任

- **B1. CI（小）**：GitHub Actions——测试矩阵（6 包 vitest）+ biome + `openspec validate --all --strict`。当前全绿靠本地跑，无第三方背书。
- **B2. 用户文档（小）**：README quickstart 已起步；缺面向陌生用户的截图/GIF 演示与"5 分钟上手"页。
- **B3. 跨平台打包（评估）**：macOS/Linux 出包；顺带评估代码签名（当前 SmartScreen 提示已在 README 声明）。

## C. 远期（商业模式未定，勿提前投入）

- 协作分享：trace 包导出/链接（产品化清单第 4 项）。
- Pro/团队版：共享 trace 库、CI 深度集成、多人标注。原则：本地免费 MIT 不动摇。

## 建议节奏

1. **下一轮**：A1（原生 run 入口）+ B1（CI）——都是小工作量高杠杆，一个 PR 周期内可完成。
2. **再下一轮**：A2 + A3（openspec change：`add-prefix-rerun` / `add-sandboxed-rerun`）。
3. **发布节奏**：A1 落地后出 v0.2.1（功能补口），A2/A3 落地后出 v0.3.0（重跑语义升级）。

## 附：V3b 冒烟记录（2026-09-09）

- 父 run：`run_mttvbmww`（scripts/create-ab-parent.mjs 现造，原生+纯对话+已封存）。
- 实验：`exp_mttvdcko_6h5c`，两臂 deepseek-chat temperature=0.2 / 1.5 → `run_mttvdcko_0p8q` / `run_mttvddwj_mg81`，均成功；请求 params 与臂声明一致，回答确有差异。
- 教训：runLoop 正常终止事件是 `stopped`（reason=completed）；PowerShell 不支持 `\` 续行与 `set X=`。
