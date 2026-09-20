## Context

A 已定义文件世界、trace v2、整轮续跑、只读预检和包门禁。本段将现有桌面 create/fork、详情 IPC 和列表接入这些能力。历史普通行为保留；本段验收不要求 C 的文件视图。

## Goals / Non-Goals

目标是桌面隔离创建与 result 分叉可操作、授权与来源清楚、IPC 不丢数据或降级执行。文件查看由 C 交付，不扩展 profile、配额、预算或 trace 契约，不新增依赖。

## Dependencies and Boundaries

按 A → B → C 交付；B 实施前 A 必须归档，C 实施前 B 必须归档。A 后续不新增 desktop 改动，本段负责桌面集成；A 已完成的兼容修正保留。trace-format/workspace-isolation/profile/配额/迭代与用量预算由 A 收口；遇到契约缺口先修订相关计划和 spec，已归档能力用明确的新变更调整。B 不依赖 C 的文件 IPC。所有本段专项验收位于 desktop-ui；全仓回归及桌面构建各段独立运行。

## Decisions

### 1. IPC 请求与数据目录

| 接口 | 契约 |
|---|---|
| workspaces:chooseSource | 原生目录选择，返回 sourceToken/显示名称及路径或取消；不导入、不写 trace/blob |
| runs:create | 原有 systemPrompt/userMessage；可选 workspace:{mode:"isolated_files",sourceToken,allowFileWrites:true} |
| runs:fork | 原有 parentRunId/atSpanId/{field:"result",value}；隔离父本必须 execution:{mode:"isolated_files",allowFileWrites:true} |

sourceToken 在 main 按会话绑定所选真实路径，15 分钟有效，成功提交时消费；取消不生成 token。renderer 不得传 handler、物理 blob 路径或配额覆盖。main 从现有便携目录策略注入 dataDir，提交时重新校验源目录与 dataDir 的关系，并由 A 包再次校验。settings 缺失在导入写入和 LLM 前报 SETTINGS_NOT_CONFIGURED。无 workspace 的创建继续为空工具表和 v1。

通道沿用统一 zod 和信封，renderer 零 fs。隔离模式与父本严格匹配，不允许漏传后落到普通 handler。未变更的 result 拒绝空 fork；父未封存、非法工具点、字段/授权/token 错误在新 trace/模型调用前拒绝。LLM 失败沿用 CREATE_RUN_FAILED，已封存记录按 meta.id 归位并刷新可见，临时记录不进列表；信封不泄露密钥或任意附件物理路径。

### 2. 详情 IPC 的原始版本守卫

在 RunRecord/RunDetail 原始输入被 zod 剔除/转换之前复用 A 的 helper。按所属 run 验证 meta、fork 和 span，也覆盖 chain 中的祖先 meta。v1 对 workspace、fork.resume_after_step、span.workspace_snapshot 用自有属性存在性检查；null/false/空对象及内存 undefined 也拒绝。只检查准确结构位置，不泛化 strict，不递归命中消息/args/result 同名业务字段。

v2 的 workspace、初始/完成步骤快照、origin 和边界原样保留，沿用 A 的必填及跨行约束。详情展示使用原始所属 run 与 leafSpanIds 区分自有步骤，不将合并索引当本地轮号。纯轨迹加载不读 blob；附件不可用不阻止合法 JSONL 加载。任务 1.1 负责往返和禁字段测试，不能把包 helper 完成当作 IPC 已完成。

### 3. 执行能力与授权

隔离创建和每次分叉都要求本次 allowFileWrites:true，复选框每次新操作默认未选，不从 workspace.write_authorized 继承。历史恒真字段仅审计；main 请求校验及 A 包执行预检分别拒绝缺授权。

确认前由 main 调用 A 的只读能力预检，拿到 profile/检查点/附件不可用原因。该预检不创建运行、不写文件、不请求模型；正式提交再预检，防止确认后附件变化。无需 C 的 inspect/readFile。旧 run 说明未录制文件检查点，不能用当前目录兜底。prompt fork/A-B 对隔离父本禁用，绕过 UI 的 IPC 仍经 A 门禁拒绝，dry-run 和 allowSideEffects 不越权。

### 4. 创建、确认与来源

创建模式用分段控件，默认纯对话；隔离模式提供目录与副本授权，未选目录或未确认时禁用提交。说明选定范围内全部受支持普通文件会采集（含隐藏文件），工具读出的文本将进入用户配置的模型请求。

确认展示父 run、工具编辑点、轮末快照、step span、真实调用模型及副本授权。数据模型为 {ownerRunId,stepSpanId,localIteration}，localIteration 取所属原始 agent.step.n；文案为“从运行 {parentRunId} 的第 N 轮结束后继续”。子运行来源标明父 run；A 已 3 轮而 B 本地第 1 轮再分叉时，显示 B 第 1 轮，不显示第 4 轮或子 C 第 1 轮。文件选择器文案归 C。

编辑 result 只改变模型观察，恢复该轮全部工具完成后的文件状态，不重做工具。确认和轨迹同时反映编辑点及整轮边界；同轮工具在前缀各出现一次。执行中禁重复提交，错误不只靠颜色，不虚构进度百分比。窄窗口中路径/确认区可换行或滚动，不遮挡授权、提交和导航。

### 5. 真实列表读取与性能

复用 A 的合法 1/10/50 run fixture、每 run 11 份完整快照、短路径及上限附近 ASCII/中文路径，附 v1 对照。A 的序列化估算：2000 文件的 11 份清单约 13.51 MB（ASCII）或 35.55 MB（中文），不含其他 trace 内容；这不是磁盘/zod 性能结果。

listRuns 保持逐文件完整解析和校验，不读 blob；步数、用量和终止原因由 spans/events 派生，不能用 meta-only 冒充等价结果。本期不引入惰性校验或持久化汇总缓存。接受少量本地调试运行的同步 main 等待，不承诺数十个满配额运行即时刷新；文件内容配额和 blob 去重不减少清单重复量。

任务 3.4 调用真实 RunRepository/listRuns，核对结果与完整读取派生一致，记录环境、总字节、首次进程/重复耗时及峰值内存；零修改 trace/附件，不把首次进程扫描称 OS 冷缓存。A reader 基准不能代替本段验证。若等待不可接受，先修订读取优化设计和测试，不修改 fixture 掩盖成本或提前宣称达标。

## Risks / Trade-offs

- 桌面 v2 详情可能在 schema 转换时丢字段：先接 IPC 原始守卫和往返，再开放创建。
- 确认与执行存在时间差：确认前和提交时都调用 A 预检，失败不降级。
- 同轮边界容易被误解：确认和来源明确父 run、本地轮号及 step。
- 列表同步扫描可能等待较久：保留完整正确性，单独记录实测与限制。
- 不承诺通用 OS 沙箱，不向用户暗示旧记录自动恢复历史磁盘。

## Migration Plan

A 归档后核对导出接口，完成 IPC 守卫、main 路由和门禁，再开放隔离创建。以受控模型服务跑 CDP 创建→分叉→重启轨迹，并按哈希核对真实文件。保持普通纯对话、prompt/A-B/卡带行为。完成列表基准、全仓检查、桌面构建及场景证据索引后归档；C 随后接文件视图。

## Review Resolution

| 原审阅项 | 本段落点 |
|---|---|
| P2-1 | §5、任务 3.4 实际 listRuns 扫描；A 的解析数据只作前置 |
| P2-2 | §2、任务 1.1 详情 IPC 原始守卫与快照往返 |
| P2-3 | §4、任务 1.5/2.2 确认与来源；文件选择器归 C |
| P2-4 | §3、任务 2.1 当前操作授权与 main 校验；包授权归 A |
