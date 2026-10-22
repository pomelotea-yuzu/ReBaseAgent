# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
各版本的完整发布文案见 `docs/engineering/reports/`。

## [Unreleased]

- 文档体系开源化：guide / architecture / development 三层 + 工程过程资产归档（`docs/`）
- U1–U8 已在源码主线归档，并**自 0.4.0-rc.1 起随 rc 包分发**（原"尚未发布"表述指 K1 时代的旧状态，已失效）。逐项归档证据与发行范围见[项目状态](docs/development/project-status.md)。
- U3/U5：按编辑目标保护会话内草稿；失败保留输入，核实正常结束后按提交修订清理，实验须全部预期臂均正常结束。
- U4/U5：统一主动操作登记、去重、执行槽与未知状态核对；创建、重跑可跨页追踪并按可信 ID 核实结果，后台完成不抢导航。
- U6：仅在确认祖先文件缺失时只读展示当前运行事实；父链不完整的父本拒绝执行，损坏或非法版本不降级放行。
- U7：分支搜索与定位、双运行完整比较工作区、两到四条运行的指标表；文件仍按运行分别阅读，不提供跨运行文件 diff。
- U8：独立录制、messages 与实验工作区；监听地址依据实际状态，messages 只重发单请求；实验预览绑定当前编辑与配置，结果保留全批逐臂事实并连接共用比较。
- **R2.2 隔离 prompt 实验（源码归档 2026-10-22，未打包）**：从隔离根初始快照修改一项 system／user 启动指令并独立从头执行；v3 实验记录（初始来源、原值／新值、假设、人工判据）、只读预检、配置修订与计划指纹、本次副本授权；跨运行检查点／文件比较与固定单侧导出。失败、缺附件、缺父链、未知操作与迟到响应按真实故障／真 IPC 实机验证。**不在 `0.5.0-rc.1` 包内**；视觉可读性与部分乱序注入仍待发行前验收。
- 开源治理、维护政策、发布交接和第三方声明文档补齐；远程配置与发行物许可核验另行记录。

## [0.5.0-rc.1] — 候选（10/16 构建，未上传）2026-10-16

首个**只发 zip** 口径的候选包（zip 内 portable exe + `SHA256SUMS.txt` + `使用说明.txt`；7-Zip/WinRAR 解压可绕开 SmartScreen 首弹）。相对 0.4.0-rc.2 新增：

- **R2.1 结果导出**：文件页导出入口与确认卡（目标空目录、写入内容、不保留项三核对，不接手输物理路径）；自包含清单（`source` / `patch.status`，附件哈希逐字节复核）；失败逆序清理不留半成品；成功/取消/失败四态反馈如实，切换检查点旧反馈收起；隔离 fork 不从阅读状态继承执行授权；纯阅读阶段 trace/附件/源目录指纹逐字节不变。
- **refine-ui 界面重组（社区发行打磨）**：对象身份归位、完整运行 ID 一键可查可复制（含键盘路径）；「运行记录 / 分支关系」术语统一、切换不重载；运行列表任务优先、同名长任务靠短 ID 可辨；返回目的地可读文案、来源失效就近呈现且仍保护输入；底部「会话活动」条统一草稿/操作/结果三组事实并跨页定位；clean/dirty 诚实分组、清空保护；表单初始引导与尝试核对分层、上游异常即时呈现；坏附件显式可辨（损坏标注/不可用汇总/导出禁用）；实机验收逼出并修复创建页白屏缺陷（状态引用不稳定致整树卸载）。
- 修复：replay 测试在无特权 Windows 上模块顶层崩溃（`isLinkAt` 容忍 ENOENT）。
- 门禁基线：desktop 203 文件 / 3180 用例全绿 Errors=0；打包后离线冒烟 14 判据全过；人工实机验收未执行。

## [0.3.0-k1] — 预览（09/24 构建，09/25 有发布记录）2026-09-25

2026-09-27 校准：本地标签及 [09/25 发布存档](docs/engineering/reports/2026-09-25-k1-gitee-template.md)已记录发布，早期草稿中的“待发布”不再代表当前状态。该记录不补齐旧报告中未完成的人工验收，本轮未在线复核下载。

运行工作区重构：把调试台从"一栏滚到底"变成"用得住"的工具。

- 三栏可调工作台 + 独立概览页 + 独立文件页（U1）
- 文件阅读：按宽度自适应布局、会话内记忆阅读位置、两侧状态真实（U2）
- desktop 66 文件 / 1302 用例全绿，26 个实机 tag / 210 项检查通过

## [0.3.0-k0-a3.1] — 预览构建 2026-09-21

隔离文件真重跑（A/B/C：包层、桌面入口及文件视图）。此处记录构建；当时未上传及人工验收待完成的边界见[构建报告](docs/engineering/reports/2026-09-21-a3-experience-build.md)。

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

[Unreleased]: https://github.com/pomelotea-yuzu/ReBaseAgent/compare/v0.3.0-k1...HEAD
[0.3.0-k1]: https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.3.0-k1
[0.3.0-k0-a3.1]: https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.3.0-k0-a3.1
[0.3.0-k0]: https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.3.0-k0
[0.2.0]: https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.2.0
