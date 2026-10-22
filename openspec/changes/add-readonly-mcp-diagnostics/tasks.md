# MCP0 / MCP1 实施任务

状态（2026-10-22）：**阶段 1、2（2.1–2.9）、3（3.1–3.2）与 4.1–4.5 已完成；4.6 起未实施**。
每项预计不超过 2h；发现超过时先拆分任务。验收对应见 [evidence-index.md](evidence-index.md)；测试、客户端实机、人工接入和发行分别记录，不以文档校验替代功能通过。

## 1. MCP0：先验证支持路径

- [x] 1.1（1.5h）选定 Windows WorkBuddy 实际版本，以最小 stdio 服务验证初始化/工具发现；记录客户端、Node、SDK 精确版本与 zod 兼容。验收 S01；失败先修支持路径，不先扩大客户端。
  - 2026-10-22：WorkBuddy 5.9.0（内置 CodeBuddy CLI 2.165.0）项目级 `.mcp.json` → `Status: ✓ Connected`；服务端账本记录 `initialized` + `tools/list`。协议级补充：Node 24.19.0 / SDK 1.32.1 / zod 3.25.76，空 traces `runs: []`、坏数据根退出码 2。证据 [mcp0-client-verification.md](mcp0-client-verification.md) 与 `.workbuddy/mcp0-11/workbuddy-mcp-get.txt`。WorkBuddy GUI 的实际工具调用与代表任务归 6.2；S01 的完整场景由 4.1/5.3/6.2 收口。
- [x] 1.2（1h）审计 SDK/传递依赖许可证、体积、Node/zod 约束，确定两个包构建与本地启动命令。验收 S01/S16 的接入前提；若需全仓升级先修 proposal。
  - 2026-10-22：SDK 1.32.1（MIT，Node >=18，peer zod ^3.25||^4.0）；生产 95 包/14,811,228 B，全部为 MIT/ISC/BSD；工作区 zod 3.25.76 已满足，无需全仓升级。构建 `tsc -p tsconfig.json`（NodeNext）与启动 `node dist/cli.js --data-dir <已有绝对路径>` 已在隔离目录验证。详见 [sdk-and-build-audit.md](sdk-and-build-audit.md)。
- [x] 1.3（1h）审计 run-query 最小依赖闭包，列明迁移文件/schema/纯派生和旧出口，清单落为 change 制品；超范围按 design D2 四条硬触发先修订拆分。验收 Q01、D02。
  - 2026-10-22：16 个目标源文件（main 6 + shared 10）与 schema 子集已逐项列明；零禁止导入；D2 四条硬触发均未触发。清单 [dependency-closure.md](dependency-closure.md)，机器审计 `.workbuddy/mcp0-13/audit-closure.cjs`。清单本身不构成 Q01/D02 通过证据。

## 2. 共享读取与校验

- [x] 2.1（1.5h）建立 run-query 包与领域 schema，保留 desktop 兼容类型出口，不反向依赖 apps。验收 Q01、D02。
  - 2026-10-22：新建 `packages/run-query`（NodeNext/ESM，`. / ./schema` 两个出口；依赖 trace-sdk/replay/zod），领域 schema 与 `run-detail-integrity` 逐字迁入；desktop `shared/ipc.ts` 改为薄 re-export，旧 IPC 名/形状/校验消息不变。包级 schema 测试 9/9；desktop 同源测试 3/3（对象同一性 + 比较守卫）；desktop tsc 双配置 0 错；desktop 全量 **215 文件/3275 用例** 全绿；全包 build 通过。Q01/D02 的完整证据仍由 2.2/2.3 + 3.2 收口。
- [x] 2.2（1.5h）迁移 repository/摘要派生，保留坏文件独立项、终止/usage 未知语义。验收 Q03/Q04。
  - 2026-10-22：`read/repository.ts` 迁入 run-query（`RunRepository.listRuns/getRun/loadRunRecord`），desktop 旧路径改薄 re-export；摘要事实已在 2.3 随 read-context 依赖下沉。包级 repository 测试 **9/9**（列表倒序、坏文件独立失败、未来版本失败项、根/分支详情、缺父严格失败、无 llm 时 cacheHit/duration 未知、crashed 残留 reason 不采信、cache_hit=0 与字段缺失区分、实验组标签）；包级合计 **23/23**；受影响 desktop 54/54；desktop 全量 **215/3275**；tsc 双 0；biome 0。Q03 的 MCP 筛选面与 Q04 的未封存端到端仍待 4.3/5.x。
- [x] 2.3（2h）迁移 lineage/read-context/project 与单请求缓存；回归 v1/v2/v3 和独立执行/混合链。验收 Q02/Q07/Q08。
  - 2026-10-22（先于 2.2 按依赖顺序执行）：`read/lineage.ts`、`read/detail-project.ts`、`read/read-context.ts` 迁入 run-query，desktop 旧路径改薄 re-export；`deriveRunSummary`/`deriveTerminalReason`/`deriveCacheHitTotal`/`RunLike` 一并下沉 `facts/summary.ts`（read-context 的依赖，归 2.2 记账）。包级读取测试 5/5（单请求缓存/新请求重读、缺父 ownOnly、坏父结构化失败、非法 ID 读取前拒绝、混合链独立边界重置）；受影响 desktop 用例 204/204；desktop 全量 **215 文件/3275 用例**；tsc 双 0；biome 0。Q02/Q07/Q08 的包级证据已补，完整 Q08 v1/v2/v3 混链对照仍由 3.2 收口。
- [x] 2.4（1.5h）统一 ID/路径/身份安全校验和结构化错误分类。验收 Q05、S06；不按错误文字猜码。
  - 2026-10-22：新增 `read/validation.ts`（runId 路径形状 + 外部 200 上限、spanId 128、逻辑路径 4096/NUL + trace-sdk 语义、文件名/meta.id 身份）与 `read/errors.ts`（启动/工具/limitation 三类稳定码、lineage 诊断映射、按结构分类读取异常）。`RunDetailReadError` 增 `code`；`listRunsDetailed` 逐项给 `IDENTITY_MISMATCH`/`RUN_INVALID` 等码。**D2 冲突两处已按“旧行为不变”处理**：401 字符 run id 仍由 desktop 比较端点按旧语义处理（200 上限只用于 MCP 外部输入）；`listRuns` 仍允许文件名任意（身份错配只在 `listRunsDetailed` 成为失败项）。包级测试 **33/33**（validation 6 / read-context 7 / repository 11 / schema 9）；desktop 全量 **215/3275**；tsc 双 0；biome 0。Q05 包级证据已补；S06 的 MCP 错误投影仍待 4.2/4.8。
- [x] 2.5（1.5h）共享读取边界拒绝链接越界/目录替身，保留 I/O 原因分类。验收 Q06。
  - 2026-10-22：新增 `@rebaseagent/trace-sdk/fs-boundary`（`checkRegularFileWithinRoot`/`assertRegularFileWithinRoot`），run-query 的 trace 读取、replay 的 `readWorkspaceRun` 与 blob store 共用：拒绝符号链接/junction、目录替身、realpath 越根；原因不含物理路径。缺失语义保持（边界 `not_found` 仍映射 run_not_found/ownOnly）。trace-sdk **231/1 skip**（fs-boundary 7；junction 实机通过、文件 symlink 因无特权跳过），run-query **35/1 skip**（目录替身+junction 实机通过），replay **597/6 skip**，desktop **215/3275**，tsc 双 0，biome 0。Q06 的 Windows 真实文件系统证据为目录替身+junction；真实文件 symlink 受本机权限限制，与既有 replay symlink 用例口径一致。
- [x] 2.6（2h）建立投影 span→owner 索引，支持重名消歧与被截断祖先拒绝。验收 Q09/Q10。
  - 2026-10-22：`detail-project` 新增 owner 跟踪投影 `projectMixedChainWithOwners`（原 `projectMixedChainSpans` 改为薄包装，行为逐字不变）；新增 `read/owner-index.ts`（`buildSpanOwnerIndex`/`resolveSpanOwner`）与 `RunReadContext.readWithOwners`（`readOf` 返回形状不变）。无 owner 重名 → `ambiguous`；显式 owner 被截断 → `truncated`；owner 不匹配 → `not_found`；索引与详情不一致 → `unreliable`。包级 owner 测试 3/3（result 链真实 owner+截断祖先、prompt 重置后的重名消歧、readOf 形状）；包级合计 **38/1 skip**；desktop 全量 **215/3275**（首跑 controlled-service 瞬时 fetch failed，单跑与复跑全绿）；tsc 双 0；biome 0。**Q09/Q10 的 MCP 协议面仍待 4.4**；v2 owner 映射复用 `resolveWholeRound`，4.4 的 v2 用例待补。
- [x] 2.7（1.5h）迁移运行比较纯派生，逐侧失败、来源未知/独立边界保留。验收 Q11/Q12。
  - 2026-10-22：compare-derive/output/edit-evidence/source-map 与必要传递依赖（chain/outcome 分类/overview/terminal-facts）迁入 `run-query/facts`；desktop 旧路径逐项薄 re-export。`outcome.ts` 仅保留 Tailwind 视图类名，分类判据不再复制。包级 compare facts 测试 **6/6**（完整/缺父、共同祖先/相对增量、单侧截断、输出门禁、v1 来源映射、双侧不可读 notApplicable），包级合计 **44/1 skip**；desktop 旧比较/概览/结局/终端用例 **186/186**；全量 **215/3275**；tsc 双 0；biome 0。Q11/Q12 的 MCP 协议面仍待 4.5。
- [x] 2.8（1.5h）共享检查点查看与附件读取包装，保留自有/初始规则和全部文件状态。验收 Q13/Q14/Q16。
  - 2026-10-22：`read/workspace-view.ts` 迁入 run-query，repository 依赖收成 `RunRecordLoader` 最小接口；desktop 旧路径薄 re-export，replay 定位/哈希/附件读取不复制。初始/显式自有 step 不互换、六态文件结果与零源目录回读由既有 **workspace 用例 75/75**（含 `workspace-view` 20、`u2-file-fixtures` 39、ownOnly 6、隔离 prompt IPC 10）通过新实现继续钉住；包级冒烟 **2/2**（缺 run 清单与文件读取可辨认拒绝，元数据 loader 不越界调用）；desktop 全量 **215/3275**，tsc 双 0，biome 0。**Q13/Q14/Q16 的 MCP 工具面仍待 4.6/5.4**。
- [x] 2.9（1.5h）接入 replay 跨运行清单/内容比较，清单引用与字节结论分开。验收 Q14。
  - 2026-10-22：新增 `read/workspace-compare.ts` 作为共享访问面，仅 re-export replay `compareWorkspaceSnapshots` / `readComparedWorkspaceFile` 与比较类型；同源测试证明不是复制实现。清单 `same` 只表示引用相同、内容结论仍须 readComparedWorkspaceFile 核验的既有语义由 replay/desktop 回归保持。包级合计 **48/1 skip**（新增同源 1/1），run-query build、desktop tsc 双 0、biome 0。**Q14 的 MCP 工具面仍待 4.6/4.7。**

## 3. 桌面接线回归

- [x] 3.1（1.5h）旧 IPC/类型出口接共享实现，保留执行和 renderer 职责边界。桌面默认检查点解析为显式 selector 再调共享层（共享层缺省=初始），接口注释各写明本层默认。验收 D01/D02。
  - 2026-10-22：旧出口清点确认全部为薄 re-export，无第二份判据——15 个 desktop 文件引用 `@rebaseagent/run-query`：main 5（`run-repository`/`run-read-context`/`run-lineage-read`/`run-detail-project`/`workspace-view`）+ shared 10（`ipc` 领域 schema、`run-detail-integrity`、`derive`、`outcome`、`overview`、`terminal-facts`、`compare-derive`/`compare-output`/`compare-edit-evidence`/`compare-source-map`）；`outcome.ts` 只留 Tailwind 视图类名映射；`compare-endpoints.ts` 经旧出口（`run-lineage-read`/`run-read-context`）消费同一实现，不另写判据。职责边界：`main/ipc.ts` 的两个 workspaces 端点补注释写明**本层不解析桌面默认**，缺省 `stepSpanId` 只有共享层语义（本 run 初始快照），“最近自有完成步骤”由 renderer（`renderer/src/lib/workspace-files.ts`、`CompareFileWorkspace.tsx`）先解析成显式 selector 再调用；共享层不含执行与授权逻辑。定向测试 **52/52**（`workspace-view` 20 / `workspace-file-view` 26 / `compare-file-wiring` 6）；desktop tsc 双配置 0 错。**D01 仍未通过**：同 fixture 的 desktop/shared 数值对照归 3.2；D02 的实机回归归 6.1/6.2。
- [x] 3.2（1.5h）同 fixture 的 desktop/shared 对照：版本/缺父/坏父/usage/比较/检查点。验收 D01/D02、Q01。
  - 2026-10-22：新增 `apps/desktop/test/run-query-desktop-parity.test.ts` **26 用例**，一个临时数据目录内同时备齐 v1 根/v1 result 分叉子/缺父子/坏父（父文件次行非法）/完全损坏文件/身份错配文件/无 llm.call/轮内中断未封存，加真跑的 **v2 隔离根 + 合规 v2 result 分叉子 + v3 隔离 prompt 实验**。两入口＝desktop 旧出口（`src/main/*`、`src/shared/*`）与包出口（`@rebaseagent/run-query`）：先断言导出符号**对象全等**（同一实现，不是两份实现互相校对），再断言同 fixture 产出**深度全等**并钉死取值——三版本 `format_version` 1/2/3、缺父 `ownOnly`+`ANCESTOR_NOT_FOUND`、坏父 `ANCESTOR_INVALID`（不降级 ownOnly）、损坏文件在 `listRuns`/`listRunsDetailed` 以失败项在场且稳定码 `RUN_INVALID`、身份错配 `IDENTITY_MISMATCH` 而旧 `listRuns` 行为不变、无 llm 时 `cacheHit=null` 不补 0、未封存判「运行中断」、比较共同祖先与沿链求和（v2 子累计 348 tokens/相对祖先 188）、检查点清单与附件哈希逐项一致（含分支 run 的“相对初始=本 run 初始快照”、祖先 step `STEP_NOT_FOUND`、非隔离 run `WORKSPACE_NO_WORKSPACE`、穿越路径只是 `not_found` 且原因不含数据目录）、读取前后 traces 目录字节不变。分层默认（D02）：省略 `stepSpanId` 两入口都给初始快照，renderer 解析出的“最近自有完成步骤”作为显式 selector 另得一份清单，两者互不改写。门禁：desktop 全量 **216 文件/3301 用例**、tsc 双 0、biome 0、run-query **47 passed/1 skip**。
  - 记录一处 fixture 事实：replay 的 `buildIsolatedPromptBaselineCase` 手工兄弟把 `at_span` 与 `resume_after_step` 写成同一个 step，读取层按 v2 契约如实拒绝（`fork.at_span 不能等于 resume_after_step`），因此对照夹具改用 `withSibling: false` 并自建合规 v2 分叉子——不改既有 fixture，也不放宽读取判据。
  - **D01/Q01 未整场景通过**：本项只闭合“桌面↔共享包”这一半，MCP 工具入口的另一半待 4.x；WorkBuddy 实机对照待 6.2。**D02 的实机回归**待 6.1。

## 4. stdio 服务与外部投影

- [x] 4.1（1.5h）建立 MCP 包、CLI 显式数据根检查、stdout/stderr 纪律及 SDK 生命周期。验收 S01/S02。
  - 2026-10-22：新建 `packages/mcp-server`（NodeNext/ESM，`bin.rebaseagent-mcp → dist/cli.js`，`engines.node>=20`；依赖 `@modelcontextprotocol/sdk` **1.32.1** + `@rebaseagent/run-query` workspace 链 + zod **3.25.76**，新增 62 个传递依赖已入锁）。四模块：`startup.ts` 按 D3 只接受一个显式已有的绝对目录并核验 `traces/`（缺参/缺值/相对/不存在/不是目录/无 traces/traces 不是目录一律 `DATA_DIR_INVALID` + 退出码 2，**不 mkdir、不换根、不回显路径**；空 `traces/` 合法）；`diagnostics.ts` 只写 stderr、`detail` 仅收标量（对象/数组压成 `type:<名称>`）、单值 120 码点与整行 600 码点截断、写失败不影响协议，src 内无 `console.*`；`server.ts` 用官方 SDK `Server`+`StdioServerTransport` 承担 initialize/协商/tools/list/tools/call，本层只做声明发布与分发（未知工具名拒并回受控文案，S04 前半段；工具内部异常只回一句受控文案 + stderr 事件名，不透传堆栈与原始参数），生命周期含 `oninitialized`/`onerror`/`onclose` 与 EOF 三路径落定（SDK onclose、stdin `close`、connect 后 `stdin.closed` 补判）；`tools.ts` 是七工具注册缝，**首版为空清单**——不注册占位工具也不假称可用（4.2–4.7 逐项登记）。测试 **16 用例**：`startup.test.ts` 9 项核验矩阵含"拒绝不留副作用"与"原因不含用户路径"；`lifecycle.test.ts` 7 项起**真实子进程**（`node dist/cli.js`）——坏根 exit=2 且 **stdout 零字节**、SDK 客户端完成初始化+`listTools`（空）+未知工具拒、写一帧 initialize 后 EOF ⇒ stdout 逐行都是 `jsonrpc:"2.0"` 帧、stderr 每行匹配 `<ts> <event> {json}` 且不含帧、EOF 后 exit=0 不挂住。门禁：7 个包 build 全通过、desktop tsc 双 0、desktop 单进程口径 **216/3301**、本 change 路径 biome 0、spec check 13/0、`openspec validate --strict` valid。
  - **S01 未通过**：工具清单为空，"恰七工具 + 按需读正文"待 4.2–4.7，完整协商/取消/重连待 5.3，真实客户端待 6.2。**S02 的场景判据已由 CLI 实跑覆盖**（含"不建目录/不进 stdout"），但"traces 不可读"子情形只有 `accessSync` 判据、未构造真实无权限目录（本机权限限制，与 2.5 的文件 symlink 同口径），留人工判据。
- [x] 4.2（1.5h）定义七工具 strict schema/annotations、版本结果/错误 schema，禁止执行/资源旁路。验收 S03/S04/S05/S06。
  - 2026-10-22：新增 `limits.ts`（runId 200 / spanId 128 / 逻辑路径 4096 / 游标 512 / 分页默认 20 上限 100 / 正文默认 4096 上限 8192 / 64 KiB 预算常量）、`tool-contracts.ts`（七工具契约，顺序同 D5；每字段独立 zod 实例，发布形状由 `input-schema.ts` 从 zod **派生**，不存在可漂移的第二份声明；annotations 统一只读四元组）、`envelope.ts`（成功/失败判别式 schema + 构造期自检：`apiVersion/observedAt/readVersion/data/provenance{runs,refs}/limitations/page?/truncation`；snapshotId 必须 64 位十六进制；limitation 码封闭四项）、`error-projection.ts`（16 个稳定码各有受控文案，`retryable` 只给 STORAGE_IO/STALE_CURSOR；`projectThrowable` 按结构分类、**文案取自码表不取自异常**；`projectArgumentError` 只回`字段:规则名`）、`tool-definition.ts`（校验→实现→信封；实现只以 `ToolFailure(码, ref)` 宣告业务失败，其余非受控异常继续上抛由服务层兜一句受控文案，不把程序缺陷伪装成业务码）。
  - 测试 **50 用例**（新增 34）：`contracts.test.ts` 12（恰七且顺序、逐工具参数集与必填、所有对象节点 `additionalProperties:false`、禁用字段递归扫描不含 dataDir/root/cwd/url/handler/command/model/config/force 等、上限逐字段钉住、枚举封闭、声明自包含无 `$ref`、未知键与越界/错型逐条拒、比较不给数组入口）；`envelope.test.ts` 13（成功信封与 nextCursor⇒page+truncation 同步、自检挡住多余键与空 readVersion、limitation 造码被拒、码表覆盖 16 码且无路径形态、异常文本/堆栈/`C:\Users` 不外发、ENOENT⇒RUN_NOT_FOUND、`RunDetailReadError` 中文原因被替换、文案 512 码点有界、简述按码点截断）；`protocol.test.ts` 9（官方 SDK Client 与真 Server 对跑：唯一能力 `tools`、`listResources/listPrompts` 协议拒绝、tools/list 发布即契约、未知字段 INVALID_ARGUMENT 且不回显被拒取值、未知工具名有界回显、业务失败信封带 ref、缺陷只回一句受控文案且 stderr 不含秘密）。
  - 门禁：`pnpm test` 内建 tsc 后 **50/50**；`biome check packages/mcp-server` 0；7 包 build 通过；desktop tsc 双 0。
  - **S04/S06 的形状与投影半边已钉**（真实参数注入与逐工具故障注入仍随 4.3–4.8）；**S03/S05 未通过**：`READONLY_TOOLS` 仍为空清单，"恰七工具 + 按需正文 + 来源引用"要等 4.3–4.7 逐项登记实现。
- [x] 4.3（1.5h）实现 list_runs/get_run 的摘要、筛选、tagged item 索引/失败项。验收 S03、Q03/Q04。
  - 2026-10-22：`READONLY_TOOLS` 从空清单变成 `[list_runs, get_run]`（`tools.ts` 逐批登记，未实现的仍**不登记**——
    空位是"能力不存在"，注册会抛错的占位工具是谎报可用）。新增 `src/query/`：
    `read-version.ts`（readVersion = 工具名 + 已通过校验的入参 + `traces/` 逐文件「名称/字节/mtime」台账的 sha256；
    只 stat 不重读字节，且不按参与链收窄——宁可多判一次过期；**同字节数且保留 mtime 的原地改写判不出**，
    与 D3「不承诺抵御有权限并发替换」同口径）、`projection.ts`（安全文件标识、结局筛选映射、query 匹配、
    白名单摘要条目、分页窗口、`created_at` 倒序 + runId **UTF-16 代码单元**升序）、
    `list-runs.ts`、`get-run.ts`。`tool-contracts.ts` 加 `requireContract` 与 `ListRunsArgs`/`GetRunArgs`
    类型导出（入参形状仍只有 zod 那一份）；`error-projection.ts` 加 `ToolErrorCodeSchema`（码表键派生的运行时枚举）。
  - list_runs：一条线性序列 = 命中摘要段 + 不可读文件段，**筛选与搜索只作用成功摘要**，失败段恒在场并占页额度（Q03）；
    失败项文案取自码表，共享层的中文异常文本与物理路径不过这一层；身份超出外部上限（>200）的记录在筛选**之前**
    改判失败项（不冒充可请求摘要，也不随筛选蒸发）。
  - get_run：`run` 段与列表共用同一份 `RunSummaryItemSchema`（两处「自有」不会漂）；`chain`/`provenance.runs`
    逐物理 run 给身份与封存，轨迹范围与来源完整性只对被读叶子给出；`consumption.own` = `deriveOwnConsumption`、
    `alongChain` = `deriveChainTotals`（缺父 ⇒ null，不补零）；索引 = span 投影序（继承项 owner 取
    `projectedOwners` 的**逐位置归属**，重名标 `ambiguousOwner`）+ 检查点段（初始快照优先，再按自有记录序）；
    未封存 ⇒ `TERMINATION_NOT_RECORDED`、缺父 ⇒ `ANCESTOR_NOT_FOUND`、有分叉/实验 ⇒ `BODY_NOT_EXPOSED` 指路。
  - v3 实验只给**身份**（基线三 id + model/迭代/预算/指纹 + `paramsRecorded`），`original_value`、`hypothesis`、
    `acceptance_criterion`、`fork.edit.value`、`provider_endpoint`、参数表全部不出门（D5/D7）。
  - run-query 侧三处 additive 改动：`listRunsWithIdentity()`（同一次扫描多带 `format_version` 与 `file`，
    `listRunsDetailed` 改为它的投影，排序与判据逐字不变）、`traceFileLedger()`、`SpanOwnerIndex.projectedOwners`。
    旧 `listRuns`/`listRunsDetailed`/`getRun`/`readOf`/`readWithOwners` 行为不变 ⇒ desktop **216 文件/3301** 与
    3.2 的 26 条双入口对照继续绿。
  - **4.2 断言改判（两边留痕）**：`ProvenanceRunSchema` 的 `lineage`/`spanScope` 由必填改**可选**，语义是
    「省略 = 本次未判定」。4.2 写成必填会迫使 `list_runs` 二选一：补一个没查过的 `complete`（把未知写成可信事实，
    违反 D4）或整批失败。`envelope.test.ts` 补一条用例钉住「缺省合法且不被自动补全、错值仍拒」；
    4.2 注记里「provenance{runs,refs}」的形状描述按此读。
  - **4.1 断言改判（两边留痕）**：`lifecycle.test.ts` 原钉 `tools/list` 为空清单、`callTool("list_runs")` 回
    「未知工具」。登记实现后该判据必然过时，改为**跟随注册表**（`tools/list` 名称序列 === `READONLY_TOOLS`，
    并显式钉当前 `["list_runs","get_run"]`）；未知工具出口改用永远不会注册的 `rerun_and_write`
    （拿 4.4 待实现的名字测，登记完判据就悄悄失效）。注册表读 src、工具来自 dist ⇒ 这条同时咬住
    「忘记重建 dist」。4.1 的 S01 缺口口径不变（恰七工具仍待 4.4–4.7）。
  - 分页口径：页宽默认 20 生效并如实 `truncated:true`，但**不发假游标**（`page`/`truncation.nextCursor` 缺席）；
    带 `cursor` 的请求显式拒 `INVALID_ARGUMENT` + `ref:"cursor"`，不当首页重放。游标签发与续读核验仍归 5.2。
  - 顺带修 4.2 的测试类型缺陷（本包测试原先不在任何 tsc 覆盖内，新建
    `.rebaseagent/tsconfig.mcp-server-test.json` 才看得见）：`contracts.test.ts` 两处给 `expect` 传了第二个
    「消息」参数（vitest 签名不接受，参数被无声丢弃）⇒ 改名为比较值的一部分。
  - 测试：新增 `list-runs.test.ts` **22**、`get-run.test.ts` **21**、`query-fixtures.ts`（`JsonlTracer` 真写 +
    `createWorkspaceSnapshot` 真算快照 id 的夹具：五种结局 + 无 llm + result 分叉 + 缺父 prompt 分叉 +
    重名 span + 同刻对 + v2 隔离根 + v3 实验 + 损坏/身份错配/超长标识 + 抬过页宽的批量）、
    `whitelist-assertions.ts`（按**对象键**递归判禁用字段——`editField:"result"` 的值含 "result"，子串搜会误判）；
    mcp-server 合计 **94 passed**，run-query **47 passed/1 skip**，desktop **216/3301**（singleFork），
    7 包 build、desktop tsc 双 0、本 change 路径 biome 0、`check-spec` 13/0、`openspec validate --strict` valid、
    `git diff --check` 0。账本回查 `.workbuddy/mcp0-43/verify-43.cjs` 45 项全对（数字从 json 报告重算，
    `--self-test` 三道反证咬住）。变异验证 3 组全部咬住后当场还原：编辑字段携带 `edit.value` ⇒ v3 白名单用例红；
    同刻排序改 `localeCompare` ⇒ UTF-16 排序用例红；筛选时丢弃失败段 ⇒ Q03 用例红。
  - **S03 未通过**：恰七工具要等 4.4–4.7 登记完，「先摘要后正文」的正文半边（section）还没有对象可查。
    **Q03/Q04 未整场景通过**：本项闭合协议筛选面与「未知不补造」的投影面，跨页无重不漏与来源变化拒绝归 5.1/5.2，
    端到端零写入字节复核归 5.4，真实客户端对照归 6.2。

- [x] 4.4（1.5h）实现 get_step section/owner 读取和结构正文规范 JSON 投影。验收 S03、Q09/Q10。
  - 2026-10-22：新增 `src/query/get-step.ts`、`canonical-json.ts`（对象键按 UTF-16 升序、数组保持原序、
    不缩进；值来自 `JSON.parse` ⇒ 不写循环/NaN 分支，只保留「整段是 undefined 就报错」这一条拒绝）、
    `body-range.ts`（`Array.from` 按**码点**切片：`range{start,end,total,unit:"unicode-code-point"}` +
    `truncated`/`remaining`，默认 4096、上限 8192）。`READONLY_TOOLS` 登记第三条 ⇒ `tools/list` 现 3 条。
  - 归属只认当前投影（Q09/Q10）：`resolveSpanOwner` 的五分类逐条落地——重名不取首项，`SPAN_AMBIGUOUS`
    把候选写进 `ref`（`owners:<a>,<b>`，数量与总长有界）；被投影截断的祖先 span **给了显式 owner 也拒**
    （`STEP_NOT_FOUND` + `ref:span:<id>@owner:<runId>`）；投影里根本没有的 id 同码但 `ref` 不带 owner；
    索引不可靠 ⇒ `RUN_INVALID`（不猜归属）。继承项可读并标 `ownerRunId`/`own:false`。
    标识形状（runId/spanId/ownerRunId）在**任何读取之前**判 `INVALID_ARGUMENT` 并指出字段。
  - 正文边界：不给 `section` ⇒ `body:null` + `BODY_NOT_EXPOSED`，只回元数据与三段 `recorded` 索引；
    `agent.step` 是容器，三段全 false（不假装有正文）；`tool.invoke.error=null` 与 `llm.call.error` 缺省
    都是**未记录**，录成空串照 `""` 发出去，`result:null` 与 `result` 字段缺失可分辨（三态各有用例）。
  - 形状同源：span 元数据、`provenance.runs` 与 4.3 的索引共用 `projection.ts` 里的
    `SpanItemSchema`/`projectSpanItem`/`provenanceRunsOf`（get-run.ts 的本地副本删除，改判为导入），
    并用一条用例钉住「get_step 的 `span` 与 get_run 索引里同一条逐项相同」。
  - **4.2 文案改判（两边留痕）**：`STEP_NOT_FOUND` 的受控文案由「指定步骤不是本 run 的自有完成步骤」
    扩为「指定步骤或 span 在当前可读投影里不可定位」——同一码承载 4.6 的 selector 越界与 4.4 的
    截断祖先，两者对外结论相同，具体哪一种由 `ref` 区分；**不新增码**（D4 码表封闭）。
  - **4.1 注册表判据随之更新**：`lifecycle.test.ts` 显式钉的名称清单由两条变三条（该判据 4.3 就改成
    了「跟随注册表」，这一行按设计变红提醒更新账本）。
  - 测试：`test/query-fixtures.ts` 扩夹具（截断祖先父子对、`toolError`/`toolResultNull`/`omitResult`、
    llm 失败详情带 503、5041 码点长正文且代理对起始位置导出为常量、工具 args 键序倒写）；
    新增 `test/get-step.test.ts` **21 用例**；mcp-server 合计 **115 passed**（8 文件），
    run-query **47 passed/1 skip**、desktop **216 文件/3301 用例**（singleFork）、7 包 build、
    desktop tsc 双 0、`biome check packages/mcp-server packages/run-query` 0（63 文件）、
    `check-spec` 13/0、`openspec validate --changes --strict` valid、`git diff --check` 0。
  - 账本回查 `.workbuddy/mcp0-44/verify-44.cjs` **43 项全对**（`--self-test` 三道反证咬住）。
    4.3 的 `verify-43.cjs` 重跑仍全对，但随批次放宽两处并留痕：注册表检查由「两条全等」改「以
    `listRunsTool, getRunTool` 开头」，「未动前沿」由 4.4 改钉尾项 6.6（逐批前沿由该批脚本钉）。
  - 变异验证 4 组（施加→定向跑→Edit 反向还原→核对无残留）：切片改回 UTF-16 `text.slice` ⇒ 11 条正文/代理对
    用例红；`canonicalJson` 换成 `JSON.stringify` ⇒ 键序规范用例红；重名时默认取首个 owner ⇒
    `SPAN_AMBIGUOUS` 用例红；不给 section 也发正文 ⇒ 「只有索引」与归属用例红。全部当场还原后 115/115 绿。
  - **S03 未通过**：七工具登记了 3 条，比较/检查点两条链路（4.5–4.7）还没有对象可查；
    真实客户端「先查运行再查指定 span」的整链归 6.2。**Q09/Q10 未整场景通过**：本项闭合协议面与
    三态语义，正文**分段续读**（游标绑定、来源变化 ⇒ STALE_CURSOR）归 5.2，64 KiB 序列化预算归 5.1，
    结构凭据过滤（`REDACTED`）按任务序归 4.8——当前 `section=input/output/error` 发的是记录的原文。

- [x] 4.5（1h）实现 compare_runs 双侧投影/引用/BODY_NOT_EXPOSED，按 D5 两侧对象 schema（与 compare_checkpoint_files 同形）。验收 Q11/Q12、S05。
  - 2026-10-22：新增 `src/query/compare-runs.ts`，`READONLY_TOOLS` 现四条。左侧在前、恰两格同序；
    「恰两个不同运行」是语义约束（两条 zod 形状都合法），由实现层以 `INVALID_ARGUMENT` + `ref:"left/right"` 拒。
  - 三条不猜：① **坏侧不冒充空运行**（Q11）——该侧 `unavailable` 带真实 runId、稳定码与码表文案
    （只捕 `RunDetailReadError`，其余异常继续上抛，程序缺陷不伪装成业务码），另一侧事实照常；
    ② **只有一侧读到时不判定关系**——`relation.kind = "not-determinable"`：拿单条链去求共同祖先
    会得出它自己的根，那是把不知道说成结论，同时 `deltaFromAncestor` 只能为 null；
    ③ **incomplete 不升格成 unrelated**（Q12）——关系三态直接复用共享层 `deriveVerifiedComparison`，
    ownOnly 那一侧带 `ANCESTOR_NOT_FOUND` limitation，另一侧沿链累计照常。
    结果里没有「谁更好 / 修复成功 / 第 N 步对第 N 步」任何字段（用例按键名集合反查）。
  - 复用而非重抄：沿链累计用 `deriveChainTotals(indexRunsById(本次已校验链并集))`、关系与祖先差用
    `deriveVerifiedComparison`、输出与错误定位用 `deriveSideOutputFacts`（内含 `deriveOwnOutput`
    四条件与 `classifyOutcome`）、自有消耗用 `deriveOwnConsumption`；共享祖先在本次请求内只解析一次
    （两侧同一个 `RunReadContext`，Q02 口径）。
  - 正文边界（S05）：最终输出与错误定位只给 **span 引用 + 码点长度**（`provenance.refs` 里的引用可直接
    交给 `get_step(section=...)`），并带一条 `BODY_NOT_EXPOSED`；错误目标给 `messageRecorded` 与 HTTP
    状态，错误正文本身不在比较结果里。未记录最终输出的那一侧按共享层分型如实给
    `missingReason`（`no-llm-call`/`has-error`…），不拿中间正文或空串冒充。
  - 来源段合并两侧参与读取的物理 run：共享祖先只出现一次，且**带来源标签的那份胜出**
    （左是右的祖先时，左边的叶子身份不能被祖先身份覆盖掉）。
  - **共用件上收（4.3/4.4 的本地副本消除）**：干预段（`InterventionSchema` + `projectIntervention`）、
    消耗段（`OwnConsumptionSchema`/`ChainTotalsSchema`/`AncestorDeltaSchema`）移进 `projection.ts`，
    `get-run.ts` 改导入；`projectRunSummary` 加了带版本的重载，让「读过记录」的一侧类型上就不可能
    把版本写成 `undefined`。
  - **4.3 判据随夹具改判（两边留痕）**：`mcp0-bodies` 为 4.4/4.5 的错误定位补成以 error 终止 ⇒
    4.3 `list-runs.test.ts` 里「errored 恰等于 [gamma]」的全等断言过时，改为该批判据本来的两件事
    （本类代表在场 + 其他类别代表不在场），并保留失败段条数断言不变。
  - 测试：`test/compare-runs.test.ts` **14 用例**（左坏右好两格同序、两侧都坏、父子关系与祖先差 14
    tokens、两个不同根判 `unrelated`、ownOnly 判 `incomplete` 且不污染好侧、无结论字段反查、
    输出只引用+码点且 canary 不外发、未记录输出分型、error 终止侧定位带 503 而无错误正文、
    来源段合并、自比/穿越/数组形状读取前拒、四次比较目录指纹不变、同对结果逐字相同、
    未封存侧给 `TERMINATION_NOT_RECORDED` 且不说「仍在运行」）。
  - 门禁：mcp-server **129 passed**（9 文件）、run-query **47 passed/1 skip**、desktop **216/3301**
    （singleFork；本批未改 run-query/desktop，仍复跑确认）、desktop tsc 双 0、7 包 build、
    `biome check packages/mcp-server packages/run-query` 0（65 文件）、`check-spec` 13/0、
    `openspec validate --changes --strict` valid、`git diff --check` 0；
    回查 `.workbuddy/mcp0-45/verify-45.cjs` **41 项全对**（`--self-test` 三道反证）。
    历史脚本随批次放宽（同一坑第二次出现，已归一空白再比形状）：`verify-43` 的注册表判据改前缀匹配、
    `verify-44` 的注册表判据改前缀匹配且「未动前沿」改钉尾项 6.6 ⇒ 三者重跑分别 45/43/41 项全对。
    ⚠️ 教训：**逐批"当前前沿"与"注册表全等"只能由该批自己的脚本钉**，历史脚本钉该批事实且
    不依赖排版（biome 会把数组折行）。
  - 变异验证 3 组（施加→定向跑→还原并核对无残留）：单侧也去求关系 ⇒ Q11 两条用例红；
    `incomplete` 写死成 `unrelated` ⇒ Q12 用例红；把输出正文塞进 `model` 字段 ⇒ S05 两条用例红。
  - **S03/S05 未整批通过**：七工具登记 4 条，检查点两条链路待 4.6/4.7；S05 的「指定历史文件」半边
    与真实客户端对照待 4.6/6.2。**Q11/Q12 未整场景通过**：协议面与未知语义已闭合，
    两侧正文的有界预览与 64 KiB 预算归 5.1、游标与来源变化归 5.2、端到端零写入字节复核归 5.4。

- [ ] 4.6（1.5h）实现 inspect_checkpoint/read_checkpoint_file，二进制仅元信息、文本原换行；工具缺省 stepSpanId=初始与桌面默认分层注释，不提供"最近一步"缺省语义。验收 Q13/Q14、S03。
- [ ] 4.7（1.5h）实现 compare_checkpoint_files 的清单和 path 两种模式。验收 Q14、S03/S10。
- [ ] 4.8（1.5h）字段白名单/结构凭据过滤/安全错误/信任说明。验收 S06/S11/S12；不承诺自由文本去密。

## 5. 有界结果与故障协议

- [ ] 5.1（2h）实现条目分页、正文码点范围与实际序列化 64 KiB 预算。验收 S07/S09/S10。
- [ ] 5.2（2h）实现认证游标、参数/读取版本绑定和源变化拒绝，覆盖列表新增/失败项与附件变化。验收 S08、Q02。
- [ ] 5.3（1.5h）真实 stdio 子进程协议测试：协商/tools/schema/错误、取消、EOF、重连。验收 S01/S04/S13/S14。
- [ ] 5.4（1.5h）完整 fixture 查询前后文件集合/字节指纹与零执行计数，覆盖源目录变化及故障。验收 Q15/Q16、S14。

## 6. 实机、指南与收口

- [ ] 6.1（1.5h）真实 Electron 只读链与窄窗/200%/键盘抽查，记录尺寸/版本/阅读位置。验收 D03；源码接线测试不代替实机。
- [ ] 6.2（2h）在选定真实 WorkBuddy 5.9.0 完成代表任务并对照桌面，记录实际配置、版本、来源及数据不变性。验收 S15、D01；自制协议客户端不算通过。
- [ ] 6.3（1.5h）写构建/启动/数据范围/正文外发/费用/错误/游标/限制指南，明确现有发行包不含 MCP。验收 S12/S16；配置示例来自已通过路径。
- [ ] 6.4（1.5h）另一位使用者按指南接入，回填实际结果；未完成保留待验收。验收 S16，不用维护者自验顶替。
- [ ] 6.5（1.5h）记录较大 fixture 的读取耗时/内存/输出预算，运行定向回归和全仓 build/typecheck/test/lint/spec、change strict。验收全部场景；超出本项时拆任务，故障先修再收口。
- [ ] 6.6（1h）逐场景回填 evidence-index，核对源码/主 spec 差集，同步项目状态/MCP 路线/文档入口后归档。验收全部；归档不等于发行，不预填测试/实机通过。
