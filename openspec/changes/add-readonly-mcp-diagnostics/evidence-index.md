# 场景与验收计划

2026-10-22：仅设计；35 个场景均为**待实施/待验证**。以下是计划映射，不是测试或实机证据。实施后逐行补实际文件/测试标题、命令 exit code、客户端/服务版本、实机记录和限制。

Q 属于 run-query，S 属于 mcp-service，D 属于 desktop-ui；标题须与 delta 逐字对应。

| ID | Scenario | 任务 | 计划证据层 |
|---|---|---|---|
| Q01 | 三个 trace 版本使用同一事实实现 | 2.1/3.2 | 包层与桌面对照 |
| Q02 | 请求内复用读取且新请求重新读盘 | 2.3/5.2 | 读取计数/变化注入 |
| Q03 | 失败文件不因筛选消失 | 2.2/4.3 | 摘要/协议 |
| Q04 | 未封存与未知消耗不补造 | 2.2/4.3 | 完整前缀/坏尾行/未知 fixture |
| Q05 | 非法路径与身份错配拒绝 | 2.4 | 读取前拒绝/身份 fixture |
| Q06 | 链接越界与目录替身拒绝 | 2.5 | Windows 真实文件系统 fixture |
| Q07 | 缺父与坏父分开处理 | 2.3 | lineage 回归 |
| Q08 | 混合链不跨独立边界拼接 | 2.3 | v1/v2/v3 混合链 |
| Q09 | 重名 span 要求消歧 | 2.6/4.4 | owner 索引/协议 |
| Q10 | 截断祖先步骤与缺失错误不补造 | 2.6/4.4 | 投影/section fixture |
| Q11 | 单侧失败不替换另一侧 | 2.7/4.5 | 比较逐侧故障 |
| Q12 | 缺来源不宣称不同根或修复成功 | 2.7/4.5 | 比较语义/协议 |
| Q13 | 初始与显式步骤不自动互换 | 2.8/4.6 | selector fixture |
| Q14 | 两侧状态与原始文本可核对 | 2.8/2.9/4.6/4.7 | replay 字节/hash/协议 |
| Q15 | 查询全链保持零执行零写入 | 5.4 | 集合/SHA-256/调用计数 |
| Q16 | 源目录变化不能补历史附件 | 2.8/5.4 | 独立源/附件缺失 fixture |
| S01 | 无桌面也能初始化 | 1.1/1.2/4.1/5.3 | stdio 子进程/真实客户端 |
| S02 | 无效数据根启动即失败 | 4.1 | CLI exit/stdout/stderr |
| S03 | 发现工具与按需读取正文 | 4.2–4.7 | tools/list/call/section |
| S04 | 未知字段和执行请求拒绝 | 4.2/5.3 | 协议拒绝/零执行 |
| S05 | 成功结果和未知来源有引用 | 4.2/4.5 | 输出 schema/来源 |
| S06 | 业务错误不泄露内部载荷 | 2.4/4.2/4.8 | 故障/错误投影 |
| S07 | 稳定数据完整分页与正文续读 | 5.1 | 全页/正文重建 |
| S08 | 来源变化与游标篡改拒绝 | 5.2 | 版本变化/认证/重启 |
| S09 | 长转义文本和 Unicode 不突破预算 | 5.1 | 完整 JSON UTF-8 字节计数 |
| S10 | 单项超限与两侧不同长度诚实返回 | 4.7/5.1 | 超限/双 offset/结束状态 |
| S11 | 已知结构凭据过滤并标明 | 4.8 | 结构秘密 canary/过滤标记 |
| S12 | 历史指令不扩展服务权限 | 4.8/6.3 | 不可信正文/指南 |
| S13 | 断连重连只重新查询 | 5.3 | 真实子进程 EOF/重启 |
| S14 | 取消查询无运行副作用 | 5.3/5.4 | 取消/指纹/计数 |
| S15 | 真实客户端完成带来源代表任务 | 6.2 | 真实 WorkBuddy 5.9.0 版本/记录 |
| S16 | 另一位使用者按说明接入 | 1.2/6.3/6.4 | 另一位使用者实际记录 |
| D01 | 相同对象在桌面和 MCP 事实一致 | 3.1/3.2/6.2 | 同 fixture 双入口对照 |
| D02 | 桌面默认检查点和旧 IPC 保持 | 1.3/2.1/3.1/3.2 | IPC/selector 回归 |
| D03 | 只读流程交互回归 | 6.1 | 真实 Electron/窄窗/缩放/键盘 |

## 1.x 前置证据（不构成场景通过）

- 1.1 支持路径：WorkBuddy 5.9.0（内置 CodeBuddy CLI 2.165.0）以项目级 `.mcp.json` 启动 spike，
  `mcp get` 返回 `Status: ✓ Connected`，服务端账本记录 `initialized` 与 `tools/list`；空 traces
  的 `list_runs` 返回由官方 SDK 客户端验证。证据 `.workbuddy/mcp0-11/workbuddy-mcp-get.txt`+
  `.workbuddy/mcp0-spike/spike-result.json`。**S01 仍未通过**：4.1/5.3 的真实 CLI、错误/取消/重连
  与 6.2 的 WorkBuddy GUI 代表任务未实施。
- 1.2：SDK/依赖/构建审计 → `sdk-and-build-audit.md`；1.3：闭包清单 → `dependency-closure.md`。
  两者都是实施前提，不替代 Q01/Q02/D02 的功能证据。

## 2.x 进展（不构成场景通过）

- 2.1：`packages/run-query` 建立，运行/详情/比较/检查点领域 schema 与完整性判据逐字迁入；
  desktop `shared/ipc.ts` 旧出口改为薄 re-export。包级 schema 测试 **9/9**（`packages/run-query/test/schema.test.ts`）、
  desktop 同源测试 **3/3**（`apps/desktop/test/run-query-schema-parity.test.ts`）、desktop 全量 **215 文件/3275 用例**、
  tsc 双配置 0 错、全包 build 通过。**Q01/D02 仍未通过**：需 2.2/2.3 的读取迁移与 3.2 的桌面同 fixture 对照。
- 2.3：lineage/detail-project/read-context 与摘要事实迁入 run-query，旧路径薄 re-export。
  包级读取测试 **5/5**（`packages/run-query/test/read-context.test.ts`：单请求缓存/新请求重读、缺父 ownOnly、
  坏父 `ANCESTOR_INVALID`、非法 ID 读取前拒绝、混合链在 prompt 边界重置）；受影响 desktop 用例 **204/204**；
  desktop 全量 **215/3275**；tsc 双 0。**Q02/Q07/Q08 仍未整场景通过**：3.2 的桌面/包层同 fixture 对照未做。
- 2.2：`RunRepository` 与列表摘要入口迁入 run-query，desktop 旧路径薄 re-export。
  包级 repository 测试 **9/9**（`packages/run-query/test/repository.test.ts`）；包级合计 **23/23**；
  受影响 desktop 用例 **54/54**；desktop 全量 **215/3275**；tsc 双 0。**Q03/Q04 仍未整场景通过**：
  4.3 的 MCP 筛选/失败项分页与 5.x 的未封存端到端未实施。
- 2.4：新增输入安全校验与稳定错误码分类；`listRunsDetailed` 提供 `IDENTITY_MISMATCH`/`RUN_INVALID` 等
  结构化失败项，`RunDetailReadError.code` 由 lineage 诊断映射。包级测试 **33/33**、desktop 全量 **215/3275**、
  tsc 双 0。**Q05 包级证据已补；S06 的 MCP 错误投影仍待 4.2/4.8**。
  旧 IPC 行为保持：超长 run id 仍走 desktop 比较端点旧语义；`listRuns` 仍允许文件名任意。
- 2.5：trace-sdk 新增共享读取边界；run-query trace 读取与 replay read-api/blob store 共用。
  拒绝目录替身、junction/symlink、realpath 越根，错误不含物理路径。trace-sdk **231/1 skip**、
  run-query **35/1 skip**、replay **597/6 skip**、desktop **215/3275**、tsc 双 0。
  **Q06 的 Windows 真实文件系统证据为目录替身+junction**；文件 symlink 因本机无特权跳过（与既有口径一致）。
- 2.6：owner 跟踪投影 + `SpanOwnerIndex` + `readWithOwners` 落地；重名返回 owner 候选，
  截断祖先拒绝，显式 owner 必须可见。包级 owner 测试 **3/3**（`packages/run-query/test/owner-index.test.ts`）、
  包级合计 **38/1 skip**、desktop 全量 **215/3275**、tsc 双 0。
  **Q09/Q10 的 MCP 协议面仍待 4.4**；v2 owner 用例待补。
- 2.7：compare-derive/output/edit-evidence/source-map + chain/overview/outcome 分类/terminal-facts
  迁入 run-query facts；desktop 旧出口薄 re-export。包级 compare facts 测试 **6/6**、合计 **44/1 skip**；
  desktop 受影响比较/概览/结局用例 **186/186**、全量 **215/3275**、tsc 双 0。
  **Q11/Q12 的 MCP 协议面仍待 4.5**。
- 2.8：`workspace-view` 迁入 run-query（repository 改 `RunRecordLoader` 最小接口），desktop 旧路径薄 re-export；
  replay 仍负责定位/哈希/附件，不复制。desktop workspace 回归 **75/75**、全量 **215/3275**、
  包级冒烟 **2/2**、tsc 双 0。**Q13/Q14/Q16 的 MCP 工具面仍待 4.6/5.4**。
- 2.9：`workspace-compare.ts` 以 re-export 接入 replay 跨运行清单/内容比较；包级同源测试 **1/1**
  （与 replay 函数对象全等），合计 **48/1 skip**，build/tsc/biome 全绿。
  **Q14 的 MCP 工具面仍待 4.6/4.7**。

## 3.x 进展（不构成场景通过）

- 3.1：旧出口清点 **15 个** desktop 文件引用 `@rebaseagent/run-query`（main 5 + shared 10），
  全部为薄 re-export；`shared/outcome.ts` 仅保留 Tailwind 类名映射，`compare-endpoints.ts` 经旧出口
  消费同一实现。`main/ipc.ts` 两个 workspaces 端点补注释写明本层默认：缺省 `stepSpanId` = 共享层的
  **初始快照**，桌面“最近自有完成步骤”由 renderer 先解析成显式 selector（`renderer/src/lib/workspace-files.ts`）
  后再调用；共享层不含执行/授权。定向测试 **52/52**（`workspace-view` 20 / `workspace-file-view` 26 /
  `compare-file-wiring` 6），desktop tsc 双配置 0 错。
  **D01 未通过**（同 fixture 数值对照归 3.2）；**D02 未通过**（IPC/selector 的实机回归归 6.1/6.2）。
- 3.2：新增 `apps/desktop/test/run-query-desktop-parity.test.ts`（**26 用例**）做同 fixture 双入口对照。
  fixture 覆盖 v1 根/分叉子/缺父子/坏父/损坏文件/身份错配文件/无 llm.call/轮内中断未封存，以及
  真跑的 v2 根 + 合规 v2 result 分叉子 + v3 隔离 prompt 实验。判据分三层：导出符号**对象全等**
  （`RunRepository`/`RunReadContext`/`inspectWorkspace`/`deriveRunSummary`/`classifyOutcome`/
  `deriveVerifiedComparison`/`findRunDetailIntegrityViolation` 与包出口同一对象）→ 同 fixture 产出
  **深度全等** → 逐类**钉值**（三版本 `format_version`、缺父 `ownOnly`+`ANCESTOR_NOT_FOUND`、坏父
  `ANCESTOR_INVALID`、损坏 `RUN_INVALID` 失败项在场、身份错配 `IDENTITY_MISMATCH` 且旧 `listRuns` 不变、
  无 llm ⇒ `cacheHit=null`、未封存 ⇒「运行中断」、共同祖先与沿链求和 348/188 tokens、检查点清单与
  附件 sha256 逐项一致、穿越路径只是 `not_found` 且原因不含数据目录、读取后 traces 字节不变）。
  分层默认（D02 代码侧）：省略 `stepSpanId` 两入口同为初始快照，renderer 解析的最近自有完成步骤作显式
  selector 另得一份清单，互不改写。门禁：desktop 全量 **216 文件/3301 用例**、tsc 双 0、biome 0、
  run-query **47 passed/1 skip**。
  fixture 事实记录：replay 基线夹具的手工兄弟 `at_span == resume_after_step`，按 v2 契约被读取层拒绝，
  对照夹具改用 `withSibling:false` 并自建合规 v2 分叉子（不放宽判据）。
  **D01/Q01 仍未整场景通过**：只闭合「桌面↔共享包」半边，MCP 工具入口待 4.x，WorkBuddy 实机对照待 6.2；
  **D02** 的实机回归待 6.1。

## 4.x 进展（不构成场景通过）

- 4.1：新建 `packages/mcp-server`（NodeNext/ESM，`bin.rebaseagent-mcp → dist/cli.js`，
  `engines.node>=20`，依赖 SDK **1.32.1** + run-query workspace 链 + zod **3.25.76**；
  `pnpm install --filter` 新增 62 个传递依赖并写入 `pnpm-lock.yaml`）。
  - `src/startup.ts`（D3 启动域）：`packages/mcp-server/test/startup.test.ts` **9/9** —
    缺参/缺值/空值/相对/不存在/不是目录/无 `traces/`/`traces` 是文件/多余参数与第二个数据根
    全部 `DATA_DIR_INVALID`；空 `traces/` 判合法；拒绝时不建目录（`readdirCount===0`）；
    原因文本不回显调用方路径。
  - `test/lifecycle.test.ts` **7/7**（真子进程 `node dist/cli.js`）：坏根 `exit=2` 且
    **stdout 为 0 字节**、stderr 含固定码且无 `jsonrpc`；SDK 客户端连上后
    `getServerVersion()={rebaseagent-mcp,0.1.0}`、`getServerCapabilities()={tools:{}}`、
    `listTools()` 如实为空、`callTool("list_runs")` ⇒ `isError` + 「未知工具」；
    写一帧 `initialize` 后 EOF ⇒ stdout **逐行**是 `jsonrpc:"2.0"` 响应帧、stderr 逐行匹配
    `^\S+ [a-z_]+ \{.*\}$` 且不含帧；只断 stdin 不发帧 ⇒ `exit=0` 且 stderr 有 `server_ready`。
  - `src/diagnostics.ts`：只写 stderr，`detail` 只接受标量（对象/数组压成 `type:<名称>`），
    单值 120 码点、整行 600 码点截断，写失败吞掉不影响协议；`src/**` 无 `console.*`。
  - `src/server.ts`/`src/tools.ts`：协议由官方 SDK 承担，本层只发布声明与分发调用；
    七工具注册表**首版为空**（不注册占位工具），4.2–4.7 逐项登记。
  - 门禁：`pnpm --filter "./packages/*" build` 7 包通过；desktop tsc 双 0；
    desktop 全量 **216 文件/3301 用例**（`--pool=forks --poolOptions.forks.singleFork=true`）；
    `biome check packages/mcp-server packages/run-query apps/desktop/test apps/desktop/src` 0 报错
    （全仓 13 项报错都在本 change 之外的未跟踪 README 脚本与仓外 `ReBaseAgentVideo` 目录）；
    `node scripts/check-spec.mjs` 13/0；`openspec validate --strict` valid。
  - 并发口径记录：`pnpm -r test`（不带 singleFork）时 `proxy-failure-diagnostics` 出现过一次
    `fetch failed / bad port`，单跑 15/15 与单进程全量均绿；与 2.6 的瞬时同类，属并发端口竞争，
    本次未改相关代码。
  - **S02 的场景判据由本项 CLI 实跑承载**（"不可读"子情形只有 `accessSync` 判据，未构造真实
    无权限目录，与 2.5 的文件 symlink 同口径，留人工判据）。**S01 未通过**：恰七工具与按需正文
    待 4.2–4.7，完整协商/取消/重连待 5.3，真实客户端待 6.2。

- 4.2：定契约与信封，不实现工具（`READONLY_TOOLS` 仍为空清单）。
  - 新增 `src/limits.ts`、`src/tool-contracts.ts`、`src/input-schema.ts`、`src/envelope.ts`、
    `src/error-projection.ts`、`src/tool-definition.ts`。发布给客户端的 JSON Schema **由 zod
    strict schema 派生**（`toJsonSchemaCompat`），故不存在可漂移的第二份声明；每字段用独立实例
    以免转换器压成 `$ref`（测试钉住"声明自包含"）。
  - `packages/mcp-server/test/contracts.test.ts` **12/12**：恰七工具与 D5 顺序、逐工具参数集与
    必填项、所有对象节点 `additionalProperties:false`、递归扫描禁用字段（dataDir/tracesDir/root/
    cwd/url/handler/command/shell/apiKey/token/model/params/config/force…）、上限逐字段钉住
    （200/128/512/4096/limit≤100/maxChars≤8192）、筛选与 section 枚举封闭、未知键与超长/错型逐条拒、
    比较工具不接受数组形状。
  - `test/envelope.test.ts` **13/13**：成功信封（apiVersion/observedAt/readVersion/provenance/
    limitations/truncation）、`nextCursor` 同步驱动 page 与 truncation、构造期自检拒多余键与空
    readVersion、snapshotId 必须 64 位十六进制、limitation 造码被拒、16 个稳定码码表齐全且文案
    不含路径形态、`retryable` 只给 STORAGE_IO/STALE_CURSOR、含物理路径/`C:\Users`/EPERM/堆栈的
    异常投影后不外发、ENOENT ⇒ RUN_NOT_FOUND、`RunDetailReadError` 的中文原因被码表文案替换、
    512 码点有界与按码点截断。
  - `test/protocol.test.ts` **9/9**（官方 SDK `Client` + `InMemoryTransport` 与真 Server 对跑）：
    `getServerCapabilities()` 恒为 `{tools:{}}`、`listResources()`/`listPrompts()` 协议层拒绝
    （无 resources/prompts 旁路）、`tools/list` 发布即契约、未知字段 ⇒ `INVALID_ARGUMENT` 且被拒
    取值（`D:/secret-root`、`dataDir`）不出现在结果里、未知工具名回显有界、`ToolFailure` 走稳定码
    信封带 ref、实现内部缺陷只回一句受控文案且 stderr 不带秘密。
  - 门禁：`packages/mcp-server` `pnpm test`（tsc + vitest）**50/50**；`biome check packages/mcp-server` 0；
    7 包 build 通过；desktop tsc 双 0。
  - **S04/S06 只闭合形状与投影半边**（真实参数注入、逐工具故障与凭据过滤随 4.3–4.8）；
    **S03/S05 未通过**——恰七工具与"先摘要后正文 + 来源引用"要等 4.3–4.7 登记实现后才有对象可查。

- 4.3：登记 `list_runs`/`get_run` 两个实现（`READONLY_TOOLS` 由空清单变两条；其余四个仍不登记）。
  - 新增 `packages/mcp-server/src/query/{read-version,projection,list-runs,get-run}.ts`，
    `tool-contracts.ts` 加 `requireContract` + `ListRunsArgs`/`GetRunArgs` 类型，`error-projection.ts`
    加 `ToolErrorCodeSchema`（码表键派生，不再手抄第二份码清单）。run-query 三处 additive：
    `listRunsWithIdentity()`（`listRunsDetailed` 改为其投影，排序/判据逐字不变）、`traceFileLedger()`、
    `SpanOwnerIndex.projectedOwners`（投影序逐位置归属，重名 span 不靠 id 猜）。
  - `packages/mcp-server/test/list-runs.test.ts` **22 用例**：摘要段+失败段的一条线性序列（失败段整体在尾、
    与成功段共用页额度）；`created_at` 倒序 + **UTF-16 代码单元**升序（反证 `localeCompare` 给相反顺序）；
    五类结局筛选互斥（Q03/Q04）；`termination_not_recorded` ⇒ `sealed=false` 且不带「仍在运行」暗示；
    缺 `cache_hit` ⇒ `cacheHit:null` 不补 0；损坏/身份错配/超长标识三种失败各带稳定码且**筛选与搜索后仍在场**；
    身份错配记录里的另一个 id 不被冒充成摘要；白名单按**对象键**递归判（`messages/role/content/args/value/result/`
    `tool_calls/request/response/hypothesis/original_value/provider_endpoint/base_url/params/path/dataDir…`）
    + `SENTINEL-*` 正文 canary 全扫 + 物理路径不外发；默认页宽 20 与 `limit` 生效、截断页 `truncated:true`
    但 `page`/`nextCursor` 缺席、带游标请求拒 `INVALID_ARGUMENT`+`ref:"cursor"` 且不回显取值；
    空 traces 合法空列表；查询前后 traces 逐文件指纹不变；readVersion 同参稳定、换参即变、新增 run 后变。
  - `test/get-run.test.ts` **21 用例**：`run` 段与列表同一字段集且 `run.tokens == consumption.own`；
    result 分叉子 chain 两跳、继承项 owner=父、自有项 owner=子、`alongChain.tokens=134`/`steps=2`
    而 `own` 只有子那一步 10/4；缺父 prompt 分叉 ⇒ `ownOnly`+`lineage.incomplete`+`ANCESTOR_NOT_FOUND`
    +`alongChain=null`（不补零）+链只剩一跳；未封存 ⇒ `TERMINATION_NOT_RECORDED` 且已落盘 step 仍可读；
    实测 `cache_hit=0` 与未记录可分辨（`own.cache` 两种形态）；重名 span ⇒ `ambiguousOwner:true` 且归属取本 run；
    v2 隔离根检查点段 = 初始快照（`worldOrigin:import`、2 文件/22 B）+ 自有完成步骤（2 文件/33 B），
    `provenance.refs` 逐项给出 run/step/snapshotId；祖先检查点不充作自有（v1 分叉子 `checkpoints:0`）；
    `limit` 只作用于索引、totals 仍报全量、不发明游标；v3 实验只给身份（基线三 id + model/8/100000/指纹 +
    `paramsRecorded:true`），`provider_endpoint` 与正文 canary 全部不外发并带 `BODY_NOT_EXPOSED`；
    错误面 RUN_NOT_FOUND / `../outside` 与超长 id ⇒ INVALID_ARGUMENT 且不回显、身份错配 ⇒ RUN_INVALID
    不借另一记录替换、损坏文件 ⇒ 码表文案有界；五次详情读取后目录指纹不变、同 run 两次读取 `data` 逐字相同。
  - **两处 4.x 断言改判（已两边留痕）**：4.2 的 `ProvenanceRunSchema.lineage/spanScope` 由必填改可选
    （省略 = 本次未判定；`list_runs` 没读父链，补齐就是把未知写成可信事实），`envelope.test.ts` 补
    「缺省合法、不自动补全、错值仍拒」一条；4.1 的 `lifecycle.test.ts` 由「tools/list 为空」改为
    「跟随注册表 + 显式钉当前两条」，未知工具名改用永不注册的 `rerun_and_write`。
  - 顺带：新建 `.rebaseagent/tsconfig.mcp-server-test.json` 后本包测试首次进入类型检查，发现并修掉
    4.2 `contracts.test.ts` 两处 `expect(actual, message)`（vitest 不接受第二个消息参数，判据曾无声降级）。
  - 变异验证 3 组（施加→定向跑→当场还原并核对内容 clean）：`editField` 改带 `fork.edit.value` ⇒
    v3 白名单用例红；同刻排序改 `localeCompare` ⇒ UTF-16 排序用例红；筛选时丢弃失败段 ⇒ Q03 用例红。
  - 门禁：mcp-server **94 passed**（`tsc` + 测试 tsconfig 双 0）、run-query **47 passed/1 skip**、
    desktop **216 文件/3301 用例**（singleFork）、desktop tsc node/web 0、7 包 build、
    `biome check packages/mcp-server packages/run-query` 0（59 文件）、`check-spec` 13/0、
    `openspec validate --changes --strict` valid、`git diff --check` 0。新依赖：本包 devDependencies 增
    `@rebaseagent/trace-sdk`（仅测试夹具用；workspace 链，锁文件随之更新，无外部新包）。
  - 账本机器回查：`.workbuddy/mcp0-43/verify-43.cjs` **45 项全对**，数字全部从 vitest json 报告重算
    （`.workbuddy/mcp0-43/{mcp-server,run-query,desktop}.json`），并逐条核对「判据原文在测试源码里在场」
    （同刻排序的区域排序反证、默认页宽 20、身份错配稳定码、沿链 134 tokens、缺父 ⇒ null、
    `ambiguousOwner:true`、缺父链只剩一跳）。`--self-test` 三道反证都咬住：用例数漂一个、
    区域排序反证被抹走、注册表退回空清单。禁用型检查先剥注释再扫（`provider_endpoint` 只出现在文档注释里）。
  - **S03 仍未通过**（恰七工具与 section 正文半边待 4.4–4.7）；**Q03/Q04 未整场景通过**
    （跨页无重不漏与游标绑定归 5.1/5.2，端到端字节指纹与零执行计数归 5.4，真实客户端对照归 6.2）。

- 4.4：登记 `get_step`（`READONLY_TOOLS` 现 `[list_runs, get_run, get_step]`）。
  - 新增 `src/query/get-step.ts`、`src/query/canonical-json.ts`、`src/query/body-range.ts`；
    把 4.3 落在 `get-run.ts` 里的 `SpanItemSchema`/span 元数据投影/`provenance.runs` 构造
    **上收到 `projection.ts`**（`projectSpanItem`/`provenanceRunsOf`），get_run 改导入 —— 两个工具对同一条
    span 说的话由一处实现产出，并用用例钉住逐字相同。
  - `test/get-step.test.ts` **21 用例**：不给 section ⇒ `body:null` + 三段 `recorded` 索引 +
    `BODY_NOT_EXPOSED` + `assertNoSentinels`（正文一个字段都不出门）；`agent.step` 三段全 false；
    `section=input` 才把请求正文发出去（canary 此时**应当**在场，证明"按需读正文"这一跳真的通）；
    规范 JSON 键序（夹具 args 倒着写 `zeta/note/alpha` ⇒ 外发必须 `"alpha"…,"note"…,"zeta"`）；
    正文三态可分辨（`result:null` ⇒ `recorded:true,text:"null"`；字段缺失 ⇒ `recorded:false`；
    工具 `error:null` 与 llm 无 `error` ⇒ 未记录；`error:""` ⇒ `recorded:true,text:'""'`）；
    llm 失败详情带 `status:503` 如实给出；5041 码点长正文默认切 4096 且 `remaining`/`truncated` 正确，
    把上限取在代理对起始处 ⇒ 码点数与 UTF-16 单元数**不相等**且无孤立代理项（切半个字符直接判红）；
    `maxChars>8192` 与 `cursor` 都在读取前拒（且不回显取值）；重名 ⇒ `SPAN_AMBIGUOUS` +
    `ref:"owners:mcp0-amb-parent,mcp0-amb-child"`、显式合法 owner ⇒ 归属与事实同取、owner 指向被投影
    重置掉的祖先 ⇒ `STEP_NOT_FOUND`；截断祖先 `s_03` 给不给 owner 都 `STEP_NOT_FOUND`；
    继承项 `own:false` 且正文可读；`../outside`/超长/非法 ownerRunId ⇒ `INVALID_ARGUMENT` 且 `ref` 指字段、
    缺失 run ⇒ `RUN_NOT_FOUND`；四种正文读取后 traces 目录逐文件指纹不变；结果里无宿主物理路径、
    递归键名集合不含 `dataDir/tracesDir/path/sha256/file`。
  - **两处改判（两边留痕）**：① 4.2 的 `STEP_NOT_FOUND` 受控文案扩为「指定步骤或 span 在当前可读投影里
    不可定位」（同码承载 4.4 截断祖先与 4.6 selector 越界两种情形，靠 `ref` 区分，不新增码）；
    ② 4.1 的 `lifecycle.test.ts` 名称清单由两条变三条（该判据本就设计为"登记新工具时变红提醒"）。
  - 门禁：mcp-server **115 passed**（8 文件；src tsc 0 + 测试 tsconfig 0）、run-query **47 passed/1 skip**、
    desktop **216 文件/3301 用例**（singleFork，0 failed 0 pending）、desktop tsc 双 0、7 包 build、
    `biome check packages/mcp-server packages/run-query` 0（63 文件）、`check-spec` 13/0、
    `openspec validate --changes --strict` valid、`git diff --check` 0。
    回查脚本 `.workbuddy/mcp0-44/verify-44.cjs` **43 项全对**（数字从 `.workbuddy/mcp0-44/*.json` 重算 +
    判据原文在场 + `--self-test` 三道反证：用例数漂一个、代理对判据两条全抹走、注册表退回两条）。
    4.3 的 `.workbuddy/mcp0-43/verify-43.cjs` 重跑同样全对（45 项），但**两处判据随批次放宽并留痕**：
    注册表检查由「两条全等」改「以 `listRunsTool, getRunTool` 开头」（4.4 登记第三条后全等必误报），
    「未动前沿」由 4.4 改钉尾项 6.6；逐批前沿由该批自己的 verify 脚本钉。
  - 变异验证 4 组全部咬住后当场还原并核对无残留：UTF-16 切片 ⇒ 11 条红；`JSON.stringify` 代规范 JSON ⇒
    键序用例红；重名默认取首项 ⇒ `SPAN_AMBIGUOUS` 用例红；不给 section 也发正文 ⇒ 索引与归属用例红。
  - **S03 仍未通过**（3/7 登记，比较与检查点链路待 4.5–4.7；真实客户端整链待 6.2）；
    **Q09/Q10 未整场景通过**（协议面与三态语义已闭合；正文分段续读与来源变化归 5.2、
    64 KiB 预算归 5.1、结构凭据过滤 `REDACTED` 按任务序归 4.8）。

- 4.5：登记 `compare_runs`（`READONLY_TOOLS` 现四条，顺序同 D5）。
  - `src/query/compare-runs.ts`：左侧在前、恰两格同序；只捕 `RunDetailReadError` 投影成该侧
    `unavailable`（真实 runId + 稳定码 + 码表文案），其余异常继续上抛。
  - Q11：坏侧在场、好侧照常——`alongChain.tokens=120` 与 `unavailable` 同屏；两侧都坏也是两格
    （不合并、不冒充空运行）。
  - Q12：关系三态复用共享层 `deriveVerifiedComparison`；**只有一侧读到时不判定关系**
    （`not-determinable` + `deltaFromAncestor:null`），ownOnly 一侧判 `incomplete` 而非 `unrelated`
    并带 `ANCESTOR_NOT_FOUND`，好侧累计不受污染；父子对的祖先差 = 子的自有增量 14 tokens、
    祖先那一侧为 0；两个不同根判 `unrelated` 且两侧差都为 null。结果按键名集合反查无
    `winner/better/fixed/passed/alignedSteps/stepPairs/diff` 等结论字段。
  - S05 的比较半边：输出与错误定位只给 **span 引用 + 码点长度**（`provenance.refs` 可直接喂
    `get_step(section=...)`），`BODY_NOT_EXPOSED` 在场；错误目标给 `llmCallSpanId/stepSpanId/
    messageRecorded/status:503/missingDetail`，错误正文不出现在比较结果里；未记录最终输出按
    `no-llm-call`/`has-error` 分型，不拿 `intermediate` 或空串冒充；
    `assertNoSentinels` + 递归键名扫描（`content/leftText/rightText` 等一律不在场）。
    来源段合并两侧物理 run，共享祖先一次、带来源标签那份胜出。
  - 共用件上收：干预段与消耗段（`InterventionSchema`/`projectIntervention`/
    `OwnConsumptionSchema`/`ChainTotalsSchema`/`AncestorDeltaSchema`）进 `projection.ts`，
    `get-run.ts` 改导入（消除 4.3/4.4 的本地副本）；`projectRunSummary` 增加带 `formatVersion`
    的重载，让读过记录的一侧在类型上不可能把版本写成 undefined。
  - **4.3 断言随夹具改判（两边留痕）**：`mcp0-bodies` 为错误定位补成 error 终止 ⇒ 4.3
    「errored 恰等于 [gamma]」的全等断言改为「本类代表在场 + 他类代表不在场」，
    失败段条数断言不变。
  - 门禁：mcp-server **129 passed / 9 文件**（新增 `compare-runs.test.ts` **14 用例**）、
    run-query **47/1 skip**、desktop **216 文件/3301 用例**（singleFork）、desktop tsc 双 0、
    7 包 build、`biome check packages/mcp-server packages/run-query` 0（65 文件）、`check-spec` 13/0、
    `openspec validate --changes --strict` valid、`git diff --check` 0；回查
    `.workbuddy/mcp0-45/verify-45.cjs` **41 项全对** + `--self-test` 三道反证
    （数字漂 / 单侧不判定关系的判据被抹走 / 注册表退回三条）。
    历史脚本随批次放宽（同一坑第二次：注册表判据依赖字面量与排版 ⇒ 一律先归一空白再比前缀）：
    `verify-43` 改前缀匹配、`verify-44` 改前缀匹配且「未动前沿」改钉尾项 6.6；
    重跑分别 **45 / 43 / 41 项全对**。逐批前沿与注册表全等只由该批自己的脚本钉。
  - 变异验证 3 组全部咬住后还原：单侧也去求关系 ⇒ Q11 两条红；`incomplete` 写死 `unrelated` ⇒
    Q12 红；输出正文塞进 `model` ⇒ S05 两条红。
  - **S03 仍未通过**（4/7 登记）；**S05 未整场景通过**（「指定历史文件」那一半要 4.6/4.7，
    真实客户端对照要 6.2）；**Q11/Q12 未整场景通过**（协议面已闭合；有界预览与预算归 5.1、
    游标/来源变化归 5.2、端到端字节指纹归 5.4）。

## 门禁与归档约束

- 6.5 补实际命令、exit code、源码身份、包构建顺序和新依赖核验；不引用 R2.2 历史通过代替本次通过。
- 6.6 合并 delta 前后核对既有 requirement/scenario 零遗漏，回填实际支持客户端/运行时/分发边界。
- 客户端/另一位使用者未通过时不勾对应任务、不宣称全部验收；人工项与自动项分列。
- 本次 change 文档 strict 校验结果另行记录，不作为上表功能证据。
