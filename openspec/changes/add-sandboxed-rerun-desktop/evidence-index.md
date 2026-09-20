# B 段（`add-sandboxed-rerun-desktop`）场景 → 证据索引

> 任务 4.3 的产出。范围：本 change **唯一一份 spec delta**（`specs/desktop-ui/spec.md`）的**全部 25 个 scenario**。
> **本索引不自动提交、不归档、不发版** —— 它只把"每个场景的验收证据"变成可查的表（与 A 段归档时的
> `../archive/2026-09-19-add-sandboxed-rerun/evidence-index.md` 同形）。C 段（`-file-view`）另建自己的索引。

## 怎么读这份表

- **A / M**：`A` = 本次**新增**的场景（出现在 `## ADDED` 段，或新增进被修改的 requirement）；`M` = 修改既有能力时**既有**的场景 —— 后者必须由回归用例证明"没被改坏"。
- **证据**优先是**可执行的用例**（`文件 › 分组/用例名`）；纯静态约束（schema、实现点）会显式写成"静态"。
  行号不写（会漂移），**定位以用例名为准**；测试路径相对 `apps/desktop/`，跨包时写全路径。
- **未做项不勾选**：见文末「已知限制」——只有一条场景是 ⚠️ 部分覆盖，其余 24 条均有可执行证据。
- **`--phase=...`** 指 `apps/desktop/scripts/isolated-flow-cdp-smoke.cjs` 的 CDP 冒烟阶段（受控模型服务见同目录 `mock-llm-server.cjs`）；截图与 `*-checks.json` 落在 gitignored 的 `.workbuddy/isolated-flow-smoke/`。

## 汇总

| requirement（desktop-ui） | 场景数 | A | M | 已覆盖 |
| --- | --- | --- | --- | --- |
| 全程只读且只呈现原样数据（MODIFIED） | 4 | 0 | 4 | 4 |
| 分叉重跑是唯一的显式写路径（MODIFIED） | 3 | 0 | 3 | 3 |
| 桌面端提供原生 run 创建入口（MODIFIED） | 9 | 1 | 8 | 9 |
| 隔离执行边界在操作前可辨认（ADDED） | 6 | 6 | 0 | 6 |
| 隔离详情 IPC 保留数据并校验版本（ADDED） | 3 | 3 | 0 | 3 |
| **合计** | **25** | **10** | **15** | **24 + 1 部分** |

### 三个 MODIFIED requirement 的"既有场景保留"核对（本次实测）

用脚本把主 spec `openspec/specs/desktop-ui/spec.md` 与 delta 按 requirement 名 + scenario 名做了差集：

| requirement | 主 spec 既有场景 | delta 里 | 丢失 | 新增 |
| --- | --- | --- | --- | --- |
| 全程只读且只呈现原样数据 | 4 | 4 | **0** | 0 |
| 分叉重跑是唯一的显式写路径 | 3 | 3 | **0** | 0 |
| 桌面端提供原生 run 创建入口 | 8 | 9 | **0** | `直接创建隔离文件父本` |

⇒ `## MODIFIED` 是整体替换语义，本次替换**没有丢掉任何既有场景**，只在一处追加了 1 个新场景。

覆盖面口径：desktop **21 文件 / 305 passed**（`--testTimeout=30000`）、biome 217 文件 0 errors、
`openspec validate --all --strict` 14 passed（详见 tasks.md 4.1 的逐段摘要）。

## 1. 全程只读且只呈现原样数据（4，全 M）

| # | scenario | A/M | 证据 |
| --- | --- | --- | --- |
| 1 | 浏览过程无写入 | M | `test/isolated-desktop-flows.test.ts` ›「runForkCapability（B 1.5）› 预检只读：前后 dataDir 全树指纹逐字节一致」；`test/list-runs-perf.test.ts` ›「3.4 只读、零 blob、校验没有被省略 › 连续扫描不写任何文件：四条语料目录指纹逐字节不变，也不生成附件目录」；`test/create-run-dialog.test.ts` ›「取消目录选择不改变任何状态（main 不签发 token ⇒ 零写入零请求）」；CDP `--phase=flow`：浏览既有 run + 展开 span + 打开选择器后取消 ⇒ trace 数不变（42→42）且源目录与既有 trace 指纹逐字节不变 |
| 2 | 超长消息 | M | `test/plain-chat-regression.test.ts` ›「3.1 超长消息」3 条：折叠判据 600 不折叠 / 601 折叠 + 摘要带真实字符数；`react-dom/server` 的 `renderToStaticMarkup` 断言"折叠成 `<details>`，但完整原文就在 DOM 里（首尾片段与 900 个字符全程在场）"；数据层用超长 user message 真跑一个 run，`meta.task` 与首条 user 消息逐字符相同（录制不截断）。组件 `renderer/src/components/LongText.tsx`（折叠而非丢弃）。**变异验证**：把展开处改成 `text.slice(0,100)` 该用例立即红 |
| 3 | 分叉不触碰既有文件 | M | `test/fork-runner.test.ts` ›「runFork：正常编辑 read_file result 重跑（tasks 4.2 happy path）› 产出 fork run：…父文件不变」；`test/isolated-fork.test.ts` ›「2.2 编辑 tool_result 并重跑（判据 → 真编排）› …父目录不变」；CDP `--phase=flow`「分叉不触碰既有文件」：只新增 1 份 trace，源目录与其余 trace 逐字节不变 |
| 4 | 新建运行不触碰既有文件 | M | `test/run-create.test.ts` ›「runCreate：成功路径」2 条（文件名 = `meta.id`、根 run、`config_hash`）；`test/isolated-desktop-flows.test.ts` ›「runCreateIsolated（B 1.4）› happy path」；`test/create-run-dialog.test.ts` ›「2.1 直接创建隔离文件父本…源目录逐字节不变」；失败侧：`test/run-create.test.ts` ›「失败路径 › 模型调用失败 → 抛 CREATE_RUN_FAILED，且 error run 仍按 meta.id 归位」＋`test/isolated-desktop-flows.test.ts` ›「模型调用失败 → CREATE_RUN_FAILED 且 error run 已按 meta.id 归位（隔离模式同语义）」；CDP `--phase=flow`「新建运行不触碰既有文件」（只 +1 份 trace） |

## 2. 分叉重跑是唯一的显式写路径（3，全 M）

| # | scenario | A/M | 证据 |
| --- | --- | --- | --- |
| 5 | 编辑 tool_result 并重跑 | M | `test/fork-runner.test.ts` ›「runFork：正常编辑 read_file result 重跑」（meta.parent/fork、span 序号延续、`config_hash` 与父一致）；`test/isolated-fork.test.ts` ›「2.2 编辑 tool_result 并重跑（判据 → 真编排）› 确认区判据放行的请求直接喂 runForkIsolated：子 run 边界 = 预检的 step」；`test/store.test.ts` ›「store：runs:fork 流转」3 条（in_progress → success/error、reset）；CDP `--phase=flow`：子 run 记录的 `fork.edit.value` 与编辑器最终内容**逐字符相同**，受控服务日志证明 3 次真实调用（创建 2 + 续跑 1）**均为 `stream:true`** |
| 6 | 非法请求被拒绝 | M | `test/fork-runner.test.ts` ›「拒绝路径（tasks 4.2 / 5.3）」4 条（at_span 非 tool.invoke / 注册表外工具 / crashed 父本 / 空 fork，均零文件）；`test/isolated-desktop-flows.test.ts` ›「schema 层的授权形状（zod literal(true)）」2 条（`allowFileWrites` 非 `true`、多余字段、缺字段一律拒）＋「SourceTokenStore」4 条（未签发 / 形状不对 / TTL 过期且焚毁 / 一次性）＋「runForkIsolated › 非隔离父本带 execution → parent_not_isolated」；`test/isolated-parent-rejection.test.ts` 5 条（隔离父本走普通路径 → `PARENT_NOT_FORKABLE`，零落盘零 LLM 调用） |
| 7 | 空 fork 被拒绝 | M | `test/fork-runner.test.ts` ›「空 fork（编辑前后相同）→ derive 拒绝，不产生文件」；`test/isolated-desktop-flows.test.ts` ›「runForkIsolated › 空 fork（编辑值与原 result 相同）→ ISOLATED_FORK_FAILED」；`test/isolated-fork.test.ts` ›「未校验 / 空 fork / 未授权 / 执行中：四种情况都不产出请求（附对照放行）」 |

## 3. 桌面端提供原生 run 创建入口（9 = 8 M + 1 A）

| # | scenario | A/M | 证据 |
| --- | --- | --- | --- |
| 8 | 新建 run 成功 | M | `test/run-create.test.ts` ›「runCreate：成功路径 ›  落盘为 `${meta.id}.jsonl`，且是根 run（parent/fork 为 null、无 source）」；`test/create-run-dialog.test.ts` ›「2.1 默认纯对话… › 真跑：对话框构造的请求 → zod → runCreate，落 v1 根 run 且指纹按空工具表算」；`test/store.test.ts` ›「runs:create 流转（A1 / B 2.1 请求透传）› 成功：in_progress → success，列表刷新并自动选中新 run」；CDP `--phase=flow`：创建后新 run 被列表选中、详情可读 |
| 9 | 新建 run 作为父本进行 prompt fork | M | `test/plain-chat-regression.test.ts` ›「3.1 新建 run 作为父本（prompt fork / 模型 A/B）› prompt fork：子 parent 指向新建 run，父文件逐字节不变」；`test/run-create.test.ts` ›「A1 验收：新建 run 可作为父本 › prompt fork」 |
| 10 | 新建 run 作为父本进行模型 A/B | M | `test/plain-chat-regression.test.ts` ›「…› 模型 A/B：两臂各自落盘，parent 与 config_hash 均指向新建 run」；`test/run-create.test.ts` ›「A1 验收… › 模型 A/B」 |
| 11 | 新建 run 作为父本进行 trace-test | M | `test/plain-chat-regression.test.ts` ›「3.1 新建 run 作为父本做 trace-test（跨包卡带回归）› 桌面产出的 trace 直接当卡带：passed / cassette / 配置无漂移，且零落盘」＋对照「工具声明与基线不匹配时报配置漂移」（证明不是"永远通过"）；隔离 run 作卡带的形态（不访问真实文件世界）由 `packages/trace-test/test/isolated-cassette.test.ts` 覆盖 |
| 12 | settings 未配置时拒绝 | M | ⚠️ **部分覆盖**（见「已知限制」第 1 条）。静态：`src/main/ipc.ts` 的 `runs:create` 在参数解析后、**任何导入与网络之前**返回 `SETTINGS_NOT_CONFIGURED`；渲染层 `components/CreateRunDialog.tsx` 在未配置时显示同名提示（`提交会被拒绝（SETTINGS_NOT_CONFIGURED），请先点右上角"运行配置"`）。可执行（同一条门禁的相邻入口）：`test/prompt-fork.test.ts` ›「未配置运行参数 → 拦截并提示先完成运行配置」、`test/model-ab.test.ts` ›「未配置运行参数 → 拦截」、`test/isolated-fork.test.ts` ›「「校验续跑条件」判据：未配置 / 空 fork / 执行中都不发请求」、`test/store.test.ts` ›「未配置运行参数的错误码原样透传（SETTINGS_NOT_CONFIGURED）」 |
| 13 | userMessage 为空时禁用提交 | M | `test/create-run-dialog.test.ts` ›「2.1 userMessage 为空时禁用提交（拒绝 + 对照成对）」3 条：空串与纯空白都拒绝且**一次 IPC 都不发**；对照放行（证明不是全都拒）；busy 时零请求 |
| 14 | 空 systemPrompt 允许 | M | `test/create-run-dialog.test.ts` ›「… › 空 systemPrompt 允许：两种模式都放行，且请求里 systemPrompt 为空串」＋「2.1 直接创建隔离文件父本… › 空 systemPrompt 的隔离根：指纹按空串 + 固定工具组计算」；`test/run-create.test.ts` ›「成功路径 › 空 systemPrompt 允许」 |
| 15 | 执行失败不产生半成品 | M | `test/run-create.test.ts` ›「失败路径」；`test/isolated-desktop-flows.test.ts` ›「模型调用失败 → CREATE_RUN_FAILED 且 error run 已按 meta.id 归位」；`test/store.test.ts` ›「runs:create 流转 › 失败：置 error 并保留错误码，且仍刷新列表（error run 已落盘，必须可见）」；CDP `--phase=flow` 的实跑里恰好留下一份"受控服务未起"造成的失败 run，反证失败 run 照常落盘可读 |
| 16 | **直接创建隔离文件父本** | **A** | `test/create-run-dialog.test.ts` ›「2.1 直接创建隔离文件父本（对话框请求 → zod → 隔离编排）› 落 v2 根 run、指纹按固定工具组算、源目录逐字节不变」；`test/isolated-desktop-flows.test.ts` ›「runCreateIsolated（B 1.4）› happy path」；`test/create-run-dialog.test.ts` ›「2.1 展示文案不漂移 › 隔离模式的 tool 名与 profile 名等于 replay 的固定契约」；CDP `--phase=flow`：v2 根 run（`world_id` = 自身、`profile=file-tools-v1`、`origin.kind=import`、2 个检查点、1 个工具 span）、详情显示"隔离文件运行 · profile file-tools-v1"、源目录指纹逐字节不变、未勾选时创建按钮禁用。⚠️ **按 fixture 哈希逐份核对真实文件的 diff 冒烟迁 C**（本段只核到"源目录 + 既有 trace"这一层） |

## 4. 隔离执行边界在操作前可辨认（6，全 A）

| # | scenario | 证据 |
| --- | --- | --- |
| 17 | 多工具轮次确认 | `test/isolated-fork.test.ts` ›「2.2 确认区数字来自真预检（多工具轮次）› 同轮多工具：编辑点是该轮的工具，轮末边界是该轮 step，轮号取本地 n」；`test/isolated-desktop-flows.test.ts` ›「runForkCapability（B 1.5）› 多工具轮次：定位三元组指向该轮，轮末快照是初始清单」；CDP `--phase=flow`：确认区显示「从运行 X 的第 1 轮结束后继续」＋轮末检查点（指纹前 12 位 + 文件数/字节），未校验时「确认重跑」禁用 |
| 18 | 二次分叉轮号不沿链累加 | `test/isolated-fork.test.ts` ›「2.2 二次分叉轮号不沿链累加（来源说明）› 根 A 3 轮 → B 第 1 轮再分叉出 C：来源说明指 B 的第 1 轮，不是第 4 轮 / C 的第 1 轮」（真轨迹造 A→B→C，合并轮号序列实测 `[1,2,3,1,1]`、沿链累计到边界恰为 4 = 错答案的来源；边界 step 不在 `leafSpanIds`）；`test/isolated-desktop-flows.test.ts` ›「runForkCapability › 二次分叉轮号不沿链累加」。**变异验证**：把 `resumeBoundaryIteration` 改成"沿链累计索引" → 该用例立即红 |
| 19 | 历史运行和缺附件降级 | `test/isolated-fork.test.ts` ›「2.2 声明与判据（纯逻辑）› 隔离运行判据：v2 带 workspace 为真；v1 老 trace 为假，且不显示任何文件标注」（v1 不出现"已恢复文件"措辞）＋「缺附件降级：预检给出不可用原因（界面照原样展示，不用当前目录兜底）」；`test/isolated-desktop-flows.test.ts` ›「runForkCapability › 历史 v1 run（无检查点）→ FORK_CAPABILITY_UNAVAILABLE，不提供目录兜底」＋「缺附件 → attachment_missing（真实 v2 父本上单点破坏）」；`test/detail-version-guard.test.ts` ›「详情 IPC 快照往返 › 缺附件仍可读轨迹：删除 workspace-blobs 后守卫与 schema 均通过」 |
| 20 | 隔离父本的其他真执行入口 | `test/isolated-parent-rejection.test.ts` 5 条（runFork / runPromptFork / runModelAb dry-run / runModelAb confirmCost+allowSideEffects 全部 `PARENT_NOT_FORKABLE`，零落盘零调用）；`test/isolated-fork.test.ts` ›「2.2 声明与判据 › 隔离父本：prompt fork / 模型 A/B 给出禁用原因（普通父本对照不受影响）」＋「单向蕴含：界面说「不支持」时内核确实拒绝」；CDP `--phase=flow`：隔离父本首次 `llm.call` 处显示"prompt fork / 模型 A/B 本期不支持" |
| 21 | 每次桌面操作独立确认写入 | `test/create-run-dialog.test.ts` ›「2.1 隔离模式：目录、副本授权与「每次操作独立确认」」5 条（切模式即无目录未授权；**选目录 ≠ 授权**；取消不改状态；本次显式勾选后放行且 workspace 是 strict 三键；重新打开/切模式后授权与目录都作废）；`test/isolated-fork.test.ts` ›「未校验 / 空 fork / 未授权 / 执行中：四种情况都不产出请求（附对照放行）」；`test/isolated-desktop-flows.test.ts` ›「schema 层的授权形状（zod literal(true)）」2 条＋「SourceTokenStore：签发与一次性消费」4 条；`test/store.test.ts` ›「隔离续跑的 execution 声明与能力预检 › 隔离父本：execution 原样透传」＋「普通父本：请求里不出现 execution 键」；CDP `--phase=flow`：未授权时「确认重跑」/「创建隔离运行」均禁用 |
| 22 | 创建与确认在窄窗口可操作 | CDP `--phase=narrow`（**10/10 通过**）：真改 OS 窗口尺寸（`window.resizeTo` + 回读 `innerWidth` 自证），夹具为约 200 字符长源路径。截图 `09-narrow-create.png`（460px：长路径 `break-all` 换行、横向零溢出、授权框与提交按钮在视口内、未授权时禁用且有**文字**原因、主体可滚动、勾选后转可用）/ `10-narrow-create-ready.png` / `11-narrow-fork-confirm.png`（1030px：父 run / step / 编辑点 / 轮末检查点 / 续跑行均可读、无横向溢出、未授权禁用、勾选后可用且**未提交、零模型调用**）/ `12-wide-fork-confirm.png`（1210px 对照） |

## 5. 隔离详情 IPC 保留数据并校验版本（3，全 A）

| # | scenario | 证据 |
| --- | --- | --- |
| 23 | 详情 IPC 快照往返 | `test/detail-version-guard.test.ts` ›「详情 IPC 快照往返（真实 createIsolatedRun / replayIsolatedRun 产物）」3 条：根 run（workspace + 初始与各轮检查点完整往返）、分支 run（`fork.resume_after_step` 与 checkpoint origin；空清单快照也保留）、缺附件仍可读轨迹；＋「守卫实现口径 › 真实 v2 trace 文件的首行确为带 workspace 的 meta（往返数据不是手搭桩）」。CDP `--phase=flow` / `--phase=restart`：经真实 preload/IPC 取回 v2 载荷（format_version/profile/world_id/origin/初始快照文件数/子 run 的 `resume_after_step`），**真重启**后按 id 回读父子 run 且无结构校验失败横幅 |
| 24 | 详情 IPC 拒绝 v1 隔离字段 | `test/detail-version-guard.test.ts` 23 条：拒绝侧（v1 携带隔离字段、祖先链的 v1 meta 带隔离字段并指明跳数、v2 meta 缺 workspace、`format_version` 改回 1 的"守卫有牙"用例）、不误伤侧（不相关扩展字段、业务正文同名字段、祖先前缀 span 不可归属、缺 `leafSpanIds` 时宁可全量误报不漏放）、同一性（trace-sdk 纯子路径导出与主出口是同一实现）；接线侧 `test/store.test.ts` ›「详情 IPC 的版本守卫接线（B 1.1）」2 条（拒绝 + 放行）。**变异验证**：禁用 store 里的守卫调用 → 接线用例立即红 |
| 25 | 真实列表扫描完整且只读 | `test/list-runs-perf.test.ts` 7 条：真实 `RunRepository.listRuns` 扫 1/10/50 run 语料（每 run 11 份清单、512 单元 ASCII/中文路径、深 32 段、v1 对照）；**汇总一致性**用深比较（`listRuns().runs[i]` ≡ `deriveRunSummary(readRun(file))`）且 `failed` 为空；**只读**用四条语料目录指纹跑前跑后逐字节相同 + 根目录无新增条目；**零 blob**（语料里根本没有附件，引用哈希在磁盘上不存在也照样列全）；**校验未省略**（篡改件必须进 `failed` 含文件名与错误文本，合法那份照常列出）。读数与环境已在 tasks.md 3.4 记录（不称"已清空 OS 缓存"） |

## 迁 C 的显示义务核对（`add-sandboxed-rerun-file-view`）

权威出处：proposal `## Non-goals`（"不交付文件 tab、检查点选择器、文本 diff 或 inspect/readFile 通道；这些由 C 提供"）
＋ delta 里的"本阶段不要求文件视图 / 不要求文件页"＋ tasks 3.2 的"文件 diff 冒烟迁 C"。

| 迁出项 | 状态 | C 必须做到 |
| --- | --- | --- |
| 文件 tab / 文件视图 | **未做**（本段明确不交付） | 从详情进入，按检查点查看隔离世界的文件清单与内容 |
| 检查点选择器 | **未做** | 可选任意轮末快照；本段只给出"轮末检查点 指纹前 12 位 + 文件数/字节"这一行的定位信息 |
| 逐文件文本 diff | **未做** | 被改文件的新旧对比；本段只能看到轨迹里的 `tool_result` |
| inspect / readFile 通道 | **未做** | 读附件内容的 IPC/preload 面；本段**不新增**任何读取附件的通道 |
| 按 fixture 哈希逐份核对真实文件的 diff 冒烟 | **未做**（3.2 明确迁 C） | 本段冒烟只核到"源目录 + 既有 trace 逐字节不变"；逐 fixture 的文件级 diff 归 C 的冒烟 |

C **应当复用**本段交付的：详情 IPC 的版本守卫与 v2 全量往返、`meta.workspace` / `fork.resume_after_step` / 检查点来源模型、`workspaces:forkCapability` 的只读预检面（含附件不可用原因），以及冒烟基建（`isolated-flow-cdp-smoke.cjs` 的三阶段 + `mock-llm-server.cjs`）。

C **不得回退**（B 已实现且有用例钉住的显示义务）：隔离运行标注、隔离父本 prompt fork/A-B 的禁用与原因、v1 老 trace 不得显示为"已恢复文件"、错误不能只靠颜色、确认区数字一律来自 main 只读预检（轮号取本地 `agent.step.n`）。

## 实现期发现（细节见 `tasks.md` 同名条目）

- **1.x**：v1 禁字段判定要用**属性存在性**（`null` / `false` / 空对象都算携带）；守卫要在 `safeParse` **之前**跑；祖先元数据也要查，`leafSpanIds` 不可归属时宁可全量误报。
- **1.3/1.5**：目录选择必须"取消不签发 token"（否则取消=写入）；能力预检是**只读**面，快照完整清单不跨进程（只带定位三元组/规模/指纹）。
- **2.x**：判据与请求必须同源（`resolveCreateRunSubmission`）；纯对话用"键不存在"表达非隔离（`workspace: undefined` 经结构化克隆仍是自有属性）；**选目录 ≠ 授权**；预检结论必须能被"编辑内容"作废。
- **3.2/3.3**：span 行按钮可访问名是拼接串（`工具read_file1ms`）；Monaco 0.56 隐藏输入框是 `ime-text-area` 且逐键 `type()` 会被补全打散（要 `insertText`）；真改窗口只能用 `window.resizeTo`（Electron 页面级 CDP 没有 `Browser.getWindowForTarget`）；截图用 CDP `Page.captureScreenshot`（`page.screenshot()` 会等 `document.fonts.ready`，偶发挂死）。
- **3.4**：桌面列表层比纯解析只贵约 2.5% ⇒ 成本由解析主导；语料清单部分的字节量 40 537 / 405 370 / 2 026 850。
- **4.1**：`pnpm check:ci` 在本沙箱**跑不通**（`pnpm -r test` 触发 `wmic.exe` 被程序黑名单硬拦、`check:spec` 的 `npx` 同理）⇒ 逐段替换执行并在 tasks 里如实标注；**并行跑出来的失败默认不可信**（同一次 `pnpm -r test` 里 replay 22 条失败 → 单跑只剩 12 条）。

## 已知限制（如实记录，不标作通过）

1. ⚠️ **`settings 未配置时拒绝`（场景 12）在 `runs:create` 这条入口上没有可执行用例**：门禁实现于 main 的 IPC 处理器（`src/main/ipc.ts`，句柄内联在 `ipcMain.handle` 里），而本包没有 IPC handler 级测试夹具；现有可执行证据来自**同一条门禁的相邻入口**（prompt fork / 模型 A-B / 隔离续跑预检 / store 错误码透传）与渲染层的提示文案。**这是既有缺口，不是本段引入**（该场景是 MODIFIED 段的既有场景）。补法待定：给 `registerIpc` 做 mock `ipcMain` 的夹具，或把句柄体抽成可测函数——两者都超出本段范围，未做。
2. **组件 JSX 接线本身没有 DOM 级测试**（本包没有 jsdom）：可见行为靠 CDP 冒烟（`--phase=flow/restart/narrow`）取证，纯逻辑靠 `test/isolated-fork.test.ts` / `test/create-run-dialog.test.ts` 取证。
3. **窄窗口只测到 1030px（确认区）/ 460px（模态创建框）**：三栏外壳固定列 = 320 + 384 px，窗口窄于约 1000px 时详情列不可用（770px 实测详情列 51px、Monaco 宽 5px 且在视口外）。要真支持更窄窗口需另开"响应式外壳"change，**本段不覆盖**。
4. **真实文件级 diff 冒烟迁 C**（见上表）：本段只证明"源目录 + 既有 trace 逐字节不变"。
5. **12 条 replay 用例在本沙箱恒红且与 B 无关**：9 条 `model-ab-cli.test.ts`（沙箱禁子进程 ⇒ `proc.status` 为 `null`；产物自身 `node dist/model-ab-cli.js --help` 退出 0 已直验）、3 条 `workspace-import-source.test.ts` 链接用例（沙箱"伪造 symlink"）。加固（把能力探针由 `existsSync` 改判 `lstatSync(link).isSymbolicLink()`）**未改，待归属**。
6. **`REBASEAGENT_SMOKE_PICK_DIR`** 是本段为可测性加进生产代码的唯一一处（main 的目录选择钩子）：原生目录框无法被 CDP 驱动；未设置时行为与以前一致，且它不是授权开关。
