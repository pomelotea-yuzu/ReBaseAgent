# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
各版本的完整发布文案见 `docs/engineering/reports/`。

## [Unreleased]

- 文档体系开源化：guide / architecture / development 三层 + 工程过程资产归档（`docs/`）

## [0.3.0-k1] — 预览（已构建，待实机验收后发布）2026-09-24

运行工作区重构：把调试台从"一栏滚到底"变成"用得住"的工具。

- 三栏可调工作台 + 独立概览页 + 独立文件页（U1）
- 文件阅读：按宽度自适应布局、会话内记忆阅读位置、两侧状态真实（U2）
- desktop 66 文件 / 1302 用例全绿，26 个实机 tag / 210 项检查通过

## [0.3.0-k0-a3.1] — 预览 2026-09-21

隔离文件真重跑（A 段包层）：

- 从目录创建带文件检查点的隔离 run；改某步 `tool_result` 后从那一轮的副本文件世界续跑
- 父 run / 源目录 / 兄弟分支逐字节不变；受控 `file-tools-v1`、内容寻址附件、数据目录整体迁移

## [0.3.0-k0] — 预览（已发布）2026-09-17

- 模型 A/B 实验：`model_params` fork 内核 · 多臂编排（副作用门禁 + dry-run/费用确认）· 桌面端实验分组 UI · `rebaseagent-model-ab` CLI（V3b）
- Trace-as-Test：卡带重跑运行时回归测试 · 断言 DSL · runner API + CLI（V3a）
- 原生 run 创建入口：桌面端「＋ 新建运行」直接跑，无需代理/脚本（A1）
- 共享前缀重跑的缓存记账与成本兑现：`cache_hit`/`cache_miss` 落 trace + 展示（A2）
- LLM 失败详情落盘与展示：脱敏 + 限长，失败不再只有一句报错（A4）

## [0.2.0] — 2026-09-07

- 本地 LLM 录制代理：只改一行 `base_url` 即录制，API key 仅内存暂存、不落盘
- 分支树视图（SVG 家谱）与多分支对照（最多 4 个并排比较）
- 时间旅行完整切片：改 `tool_result` 从该步重跑 / prompt fork / 代理 messages 重发
- 预算地图：token 按消息 / 工具分布可视化
- 便携化收口：单文件 portable exe（≈94 MB，首次低于 Gitee 附件 100 MB 上限）

## [0.1.0] — MVP

- span 时间线 · 上下文预算地图 · 时间旅行最小切片
- trace 格式 v1（JSONL 事实源，一 run 一文件、append-only）
- 纯 TypeScript Agent 执行引擎（OpenAI 兼容协议直连，零厂商 SDK）

[Unreleased]: https://github.com/pomelotea-yuzu/ReBaseAgent/compare/v0.3.0-k0...HEAD
[0.3.0-k1]: https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.3.0-k1
[0.3.0-k0-a3.1]: https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.3.0-k0-a3.1
[0.3.0-k0]: https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.3.0-k0
[0.2.0]: https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.2.0
