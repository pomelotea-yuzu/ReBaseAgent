# ReBaseAgent · 探讨过程简述

> 2026-09-03 · 一场从零到 openspec 落地的产品定义讨论

## 起点

目标是"做一个市面上没有或不成熟的 Agent 应用"，技术偏好已定：TS + 自研 loop + Electron 桌面形态（复用既有全栈经验）。

## 第一阶段：方向筛选

四个候选方向对比后锁定：

| 方向 | 结论 |
|---|---|
| **A. Agent Ops 调试台** | ✅ 选中——Agent 只是"标本"（loop 可最简、用便宜模型），产品是显微镜；"没做过 Agent"的短板不打在产品本体上 |
| B. 本地个人 Agent | spec 难收敛，容易大而全 |
| C. 主动式守护 Agent | 价值依赖数据源，易沦为定时消息机器人 |
| D. Computer Use | 被多模态模型能力卡死，大厂正面赛道 |

## 第二阶段：竞品调研（网络实查）

- 平台级赛道（LangSmith/Langfuse/Opik/Braintrust…）：红海，市场规模 ~$27 亿，不进入
- 本地桌面细分（claude-tap/LangObs/agent-trace…）：2026 年新生项目群，早期混战无占位者，但全是"只读"
- **结论修正了原始判断**："市面上没有"是假的（平台红海），但"不成熟"是真的（本地 + 可干预的调试器没人做）

## 第三阶段：创新主轴推敲（多轮压力测试）

从"SDK 埋点能改、MITM 只能看"的结构性优势推出旗舰创新——**时间旅行调试**（拖回第 N 步 → 编辑 → 从该步重跑）。

压测过的疑虑与结论：
- MVP 赌注太大？→ 双钩子方案：预算地图保底 + 时间旅行最小切片（experimental）
- 沙箱保真度渐变 → 分级声明：pure 工具保证 / 副作用工具 best-effort / 外部状态不承诺
- 非确定性 → 反转为特性：严格重放（确定性，CI 可用）/ 实验分支（重新采样）双模式
- 竞品跟进速度 → 窗口 1-2 年，护城河在沙箱可信重跑的工程质量

**概念升维**："上下文即程序"（Context is the program）——system prompt 是源代码，消息历史是运行时状态，整个产品是给这门"语言"的完整调试器（预算地图=profiler，时间旅行=edit-and-resend，Trace-as-Test=回归测试，分叉定位=diff）。

## 第四阶段：逐项核对定稿（A/B/C/D 四层）

**A 产品层**
- 定位句：Agent 的时间旅行调试器——不止回放它做了什么，而是让你**改变**它做了什么。本地运行，数据不出你的机器
- 本地优先 = 架构约束而非功能承诺（云端留 TraceStore 接口 + 相对路径两个口子）
- 用户：自研 Agent loop 的开发者；**产品完全建立在自有技术上，零外部适配**（曾考虑 TRAE/WorkBuddy 数据导入，因逆向法律/合规/厂商关系风险及"独立开发者"诉求而砍掉）
- 增长：国产模型生态优先（OpenAI 兼容协议 + 中文一等公民）+ 教程式 build in public；国际兼容中后期=改 base URL 的事
- 命名迭代链：Retrace → 发现 retrace-sdk 撞名（云端同类产品，概念被验证）→ ReBaseLab → ReBase+X 多轮 → **ReBaseAgent**（git rebase=改写历史的双关）

**B 技术层**（多轮审计修订）
- 架构：四层 + 三修正——loop 是执行引擎（首跑与分支重放同一代码路径）；Agent 运行时独立子进程；agent-loop 为零 Electron 依赖的独立包
- Electron 靠实力成立：agent 运行时必须 TS → 三运行时协调的 Tauri 是为薄壳引入新语言；分层保证换壳是局部手术
- Trace 格式：三种 span + reasoning_content（国产推理模型）+ run 级终止事件 + format_version
- 存储：**JSONL 唯一事实源，SQLite 仅可弃索引**（写入路径统一，headless/CI 复用）；run 起点快照 + 前向重放解决"分支需要第 N 步的现场"；fork 用元数据表达而非伪造 span
- Loop 四不变量：状态完全=messages；计数从 messages 派生禁止自增；tracer 唯一观测出口（事件流）；无模块级可变状态

**C 工程层**
- Spec 顺序重排：**#1 trace 格式+SDK（附 fixtures）→ #2 agent loop → #3 UI → #4 时间旅行切片**（格式已被讨论设计完，UI 从第一天就有 fixtures 可用）

**D 执行层**
- 默认模型 DeepSeek（tool calling 成熟），备用 GLM-Flash；MIT；仓库 day 1 公开

## 落地

`D:\ReBaseAgent` 初始化完成：openspec（config.yaml 沉淀全部决策）+ Spec #1 add-trace-format-sdk（proposal/tasks/spec，校验通过）+ monorepo 脚手架 + git 首提交。远程：github.com/pomelotea-yuzu/ReBaseAgent + gitee.com/yuzu-tea-duck/re-base-agent。

## 关键经验沉淀

1. 决策要逐项核对而非批量确认——本轮六成以上的修订（三运行时问题、快照缺口、写入路径统一）都产生于"拿具体场景压既有结论"的过程
2. 名字是可逆的，不值得阻塞进度；但撞名检查要在定名前做
3. 用户的隐性目标（stars/简历）会实质性改变策略优先级，应尽早摆上桌面
4. 概念框架（如"上下文即程序"）是透镜不是范围——统一叙事，但不扩大工程
