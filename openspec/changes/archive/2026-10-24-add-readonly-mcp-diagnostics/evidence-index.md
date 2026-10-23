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

## 0. 逐场景最终状态（6.6 归档前回填；通过层级如实分列，不因归档升格）

| 场景/约束 | 最终状态 | 依据（层级） |
|---|---|---|
| Q01–Q16 | 全部通过 | 各批次证据（1.x–5.x 分节；Q15/Q16 零写入端到端在 5.4） |
| S01 无桌面初始化 | **通过** | 线务/包层（4.1/5.3 真子进程）+ 真实客户端（1.1 spike、6.2 两轮） |
| S02 无效数据根启动即失败 | **通过** | CLI 实跑（4.1） |
| S03 发现工具与按需读正文 | **通过** | 协议/包层（4.2–4.7）+ 真实客户端整链（6.2 第二轮 tools 发现 + section 正文逐字引用） |
| S04 未知字段与执行请求拒绝 | **通过** | 协议/包层（4.2/5.3） |
| S05 成功结果与未知来源有引用 | **通过** | 协议/包层（4.2/4.5）+ 引用可回查真实客户端实证（6.2 第二轮） |
| S06 业务错误不泄露内部载荷 | **通过** | 协议/包层（2.4/4.2/4.8） |
| S07 分页与正文续读 | **通过** | 包层/协议（5.1/5.2 全页与正文重建） |
| S08 来源变化与游标篡改拒绝 | **通过** | 包层/协议（5.2） |
| S09 长文本与 Unicode 不超预算 | **通过** | 包层/协议（5.1） |
| S10 超限与两侧不同长度诚实返回 | **通过** | 包层/协议（4.7/5.1） |
| S11 已知结构凭据过滤并标明 | **通过** | 包层（4.8 canary） |
| S12 历史指令不扩展服务权限 | **通过（整场景）** | 协议/行为（4.8）+ 指南口径（6.3） |
| S13 断连重连只重新查询 | **通过** | 真实 stdio（5.3） |
| S14 取消查询无运行副作用 | **通过（整场景）** | 真实 stdio 取消（5.3）+ 指纹/计数（5.4） |
| S15 真实客户端带来源代表任务 | **通过** | WorkBuddy 5.9.0 两轮（第一轮判未通过→投影修订→第二轮锚点 8/8 + 引用可回查，6.2） |
| S16 另一位使用者按说明接入 | **未验收（挂账）** | 指南面已交付（6.3）+ 维护者自验两客户端样本（WorkBuddy/Trae，不顶替）；欠非维护者实测 |
| D01 桌面与 MCP 事实一致 | **通过** | 同 fixture 双入口对照（3.1/3.2）+ 真实客户端摘要层 8 项锚点（6.2 两轮） |
| D02 桌面默认与旧 IPC 保持 | **通过** | 代码/包层（1.3/2.1/3.1/3.2）+ 实机回归（6.1） |
| D03 只读流程交互回归 | **通过** | 真实 Electron 五批 154 检查 0 失败（6.1） |

> S16 为本 change 唯一挂账场景：指南（docs/guide/mcp-readonly-diagnostics.md）已交付并经
> 维护者自验（WorkBuddy 5.9.0 / Trae 3.4.4 双客户端），但按任务口径「另一位使用者实际记录」
> 未取得 ⇒ 不宣称 S16 通过；后续有人按指南接入时可回填本表并在项目状态记录。

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
    readVersion、snapshotId 必须 64 位十六进制、limitation 造码被拒、**当时 16 个**稳定码码表齐全且文案
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

- 4.6：登记 `inspect_checkpoint` / `read_checkpoint_file`（`READONLY_TOOLS` 现六条，顺序同 D5）。
  - 新增 `src/query/{inspect-checkpoint,read-checkpoint-file}.ts`；检查点段上收到 `projection.ts`
    （`WorldOriginSchema`/`CheckpointItemSchema`/`ownCheckpointItems`/`CheckpointFileItemSchema`/
    `CheckpointHeadSchema`/`toolCodeOfLocateFailure`/`locateRefOf`），`get-run.ts` 改导入（本地副本删除）
    ⇒ get_run 索引、inspect 清单、read 的 selector 三处同源；`boundedMessage` 移进
    `error-projection.ts`（投影层不反向依赖定义缝）。run-query 一处 additive：
    `read/workspace-view.ts` 增 type-only 出口 `WorkspaceLocateFailure(Code)`，外部按封闭集合穷尽映射。
  - Q13 协议面：省略 `stepSpanId` = 本 run 初始快照（共享层缺省），**正面**断言它不等于轮末那份；
    桌面「最近自有完成步骤」的默认留在 renderer（本层与 `tool-contracts.ts` 注释都写明，不代填）；
    祖先 step / 非 step 的 span / 未知 id ⇒ `STEP_NOT_FOUND` 且不退回初始；
    分支 run 的「相对初始」= 它自己的初始（= 父轮末那份清单）且 `worldOrigin` 带父身份。
  - 六态不合并：`rejected` 升稳定码（`no_workspace`⇒`NO_WORKSPACE`、`step_not_found`⇒`STEP_NOT_FOUND`、
    `run_not_found`⇒`RUN_NOT_FOUND`、`trace_invalid`⇒`RUN_INVALID`、`invalid_request`⇒`INVALID_ARGUMENT`），
    `not_found`/`missing`/`corrupt` 原样保留并绑 selector；定位码两种载体（`WORKSPACE_*` 与裸码）
    **先归一再查同一张表**，表外码落 `RUN_INVALID` 不造新码。附件位置被目录顶替 ⇒ `STORAGE_IO` +
    `retryable:true`，不伪装成文件状态（inspect 这一路也捕，逐项 verify 会抛）。
  - Q14 单侧半边：正文只在显式 `path` 下出门（`encoding=utf8-text`，复用 4.4 的码点 `sliceBody`）；
    CRLF/尾随换行/无尾换行/空串逐字保真；完整历史文件的 `bytes`/`sha256` 收在 `fullFile` 段，
    与 `range.total` 分开放；二进制只给大小与哈希（无 `text`/`encoding`/`base64`/`data` 键、无 U+FFFD）；
    `not_found` 无 `fullFile`；长度不符与哈希不符两句原因可分辨且不含物理路径；
    当前目录里的同名新文件不参与补齐。清单侧零正文（键集合 + `SENTINEL-` 全扫 + `BODY_NOT_EXPOSED`）。
  - 外部输入比桌面严：非法逻辑路径在任何读取前 `INVALID_ARGUMENT` + `ref:"path"`；
    桌面对同样请求仍得 `not_found`（3.2 已钉）⇒ 不改共享层、不收紧旧 IPC（D2）。
  - 夹具 `test/checkpoint-fixtures.ts` 独立数据目录（不动 4.3–4.5 夹具，避免历史批次钉的条目数随批次漂）：
    真发布附件 ⇒ ok/missing/corrupt/I-O 故障都是磁盘事实；30 条初始清单（CRLF/空串/无尾换行/长文本/
    二进制/缺失/长度不符/哈希不符 + 20 filler）、轮末清单（added/modified/unchanged）、v2 结果分叉子、
    v2 未封存、v1 非隔离、目录顶替、身份错配、损坏、`current-source/gone.txt`。
  - `test/inspect-checkpoint.test.ts` **24 用例**、`test/read-checkpoint-file.test.ts` **19 用例**；
    mcp-server 合计 **172 passed / 11 文件**（+43）。4.1 的 `lifecycle.test.ts` 名称清单随批次由四条
    变六条（该判据本就跟随注册表，变红即提醒更新账本）。
  - 门禁：src tsc 0 + `.rebaseagent/tsconfig.mcp-server-test.json` 0（它抓到 3 处真问题：
    `data.file.fullFile` 在 `not_found` 分支不存在、get_run 索引项本地类型缺 `fileCount`/`totalBytes`、
    `not.toContain("")` 因非 ASCII 字面量被吞成空串——只跑 vitest 时是一条永远红的判据）、
    run-query **47/1 skip**、desktop **216 文件/3301 用例**（singleFork）、7 包 build、desktop tsc 双 0、
    biome **70 文件 0 错**、`check-spec` 13/0、`openspec validate --changes --strict` valid、
    `git diff --check` 0；回查 `.workbuddy/mcp0-46/verify-46.cjs`（数字从 json 报告重算 +
    `--self-test` 三道反证）。历史脚本随批次放宽并两边留痕：`verify-45` 的注册表判据改前缀匹配、
    「未动前沿」改钉尾项 6.6 ⇒ 43/44/45 重跑分别 45/43/41 项全对。
  - 变异验证 4 组全部咬住后当场还原并核对无残留：缺省 selector 改解析「最近自有完成步骤」⇒ 8 条红；
    去掉 `WORKSPACE_` 归一 ⇒ 4 条红；附件不可用伪装 `ok` ⇒ 2 条红；正文 CRLF 规范化 ⇒ 3 条红。
  - ✅ **两条定夺（2026-10-22 用户裁决，已落 code + design）**：① `CHECKPOINT_NOT_FOUND` 本批无可达承载
    （读取器先拒「v2/v3 已落盘 `agent.step` 缺 `workspace_snapshot`」，半途中断的 step 没有行）
    ⇒ **不造分支凑用它，而是按 D4 修订删码**：工具错误域 16→15（`design.md` D4 附修订说明 +
    `run-query/read/errors.ts` 联合 + `mcp-server/error-projection.ts` 码表 + `envelope.test.ts`
    的封闭集合断言）；4.7 唯一可能挂靠的 `selection_changed` 按 D6 归 `STALE_CURSOR`，不挪用本码。
    ② 分叉子自有 span 与父重名时共享层详情自检抛裸 Error（`spans 存在重复 id`）⇒ MCP 落到服务层
    无稳定码兜底。**维持「内部缺陷」定性**：真实写入器一律以 `spanSeqStart = maxSpanSeq(父)` 起号
    （`replay-run.ts:109`、`isolated-replay.ts:167`）产不出该数据；按异常文案猜码撞 §五 红线，
    单独分类又与桌面 `GET_RUN_FAILED` 的粗分类分叉。曾据此把「自有」判据改成逐位置 owner，
    验证该形态不可达后**改回 `leafSpanIds`**（提取为纯搬家，与 4.3 判据逐字相同）。
    限制本身写进 6.3 指南的错误一节，不当已验收能力引用。
  - **S03 仍未通过**（6/7 登记，`compare_checkpoint_files` 待 4.7）；**Q13/Q14 未整场景通过**
    （游标与来源变化归 5.2、64 KiB 预算归 5.1、两侧比较归 4.7、端到端零写入与 Q15/Q16 归 5.4、
    实机对照归 6.1/6.2）；**S05 的「指定历史文件」半边本轮闭合**（refs 带
    `{runId, stepSpanId?, snapshotId, path}` 且与 inspect/get_run 逐项相同），真实客户端对照仍待 6.2。
  - ⚠️ readVersion 材料仍只含 `traces/*.jsonl` 台账 ⇒ **附件 blob 变化不进摘要**，
    续读的附件变化核验按 tasks 5.2 落地，本批不擅自扩材料口径。

- 4.7：登记 `compare_checkpoint_files`（`READONLY_TOOLS` **七条齐**，顺序同 D5）。
  - 新增 `src/query/compare-checkpoint-files.ts`；逐侧 `unavailable` 格上收到 `projection.ts`
    （`SideNameSchema`/`UnavailableSideSchema`/`unavailableSideOf`/`unavailableSideOfCode`），
    `compare-runs.ts` 改导入 ⇒ 两种比较工具对「这一侧不可读」说同一句话；
    `ContentHashSchema` 导出（快照 id 与附件哈希共用同一条 64 位 hex 正则）。
    run-query 一处 additive：`read/workspace-compare.ts` 增 type-only 出口 `CompareSideFailureCode`
    （= 定位码 + `identity_mismatch`），映射表按它穷尽。
  - 一次清单冻结、两种模式：清单模式发并集分页 + 逐侧引用；内容模式把**本次**冻结的两侧快照 id
    作为 `expectedSnapshotIds` 交给 `readComparedWorkspaceFile`（桌面「清单/正文双代次守卫」的
    同请求版本，不把旧清单与新正文拼接）。
  - S10 核心：**引用 ≠ 内容**。清单 `reference:"same"` 只是哈希 + 字节数，带 `BODY_NOT_EXPOSED`；
    结论一律取共享层完整附件核验。夹具专门造了**前 4096 码点完全相同、只差尾部**的一对文件 ⇒
    两段外发正文一样而结论必须 `different`（变异 M1「按片段判相同」被这一条咬住）。
  - 坏侧不吞好侧（清单模式两格恒在同序 + `unionComplete:false` + 空 entries 不代表文件不存在）；
    缺任一侧不发半份结论（内容模式按该侧稳定码整条失败，与 `read_checkpoint_file` 同口径）；
    同 run 两份检查点可比、同一份自比读前拒 `left/right`。
  - 逐侧状态不合并：`text/binary/not_found/missing/corrupt/too_large/selection_changed` 原样保留
    （`not_found` 无 `fullFile`）；`io` 改判 `unavailable{STORAGE_IO, retryable:true}` 且不透传
    共享层 errno reason（可能含附件物理路径）。
  - 🔴 自正一处 design 表述并两边留痕：D4 修订初稿写「`selection_changed` 按 D6 归 `STALE_CURSOR`」，
    实现核对后改判为**逐侧数据状态**（不是游标过期），`design.md` 已就地自正。
  - 夹具 `test/compare-file-fixtures.ts`（第三个独立数据目录）：`same`/`different`/`left_only`/
    `right_only`/二进制/missing/corrupt/`too_large`（清单声明 8 MiB+1，不真占磁盘）/目录顶替/
    正文 canary + 20 filler；另备 v1 非隔离、身份错配、缺失 run、未封存与跨运行分叉子。
  - `test/compare-checkpoint-files.test.ts` **26 用例**；mcp-server 合计 **198 passed / 12 文件**（+26）。
    4.1 的 `lifecycle.test.ts` 名称清单随批次由六条变七条。
  - 门禁：src tsc 0 + 测试 tsconfig 0（抓到 4 处：模块级常量读 `beforeAll` 的夹具、union 上直取
    分支字段 ×2、`not.toContain("")`——U+FFFD 字面量第三次被吞）、run-query **47/1 skip**、
    desktop **216 文件/3301 用例**（singleFork）、7 包 build、desktop tsc 双 0、biome **73 文件 0**、
    `check-spec` 13/0、strict valid、`git diff --check` 0；回查
    `.workbuddy/mcp0-47/verify-47.cjs`（数字从 json 报告重算 + 三道反证）；
    历史脚本放宽后复跑 45/43/41/63 项全对（`verify-46` 的注册表判据改前缀、「第七条未登记」
    改判「七条已齐」、反证三换新形状 —— 同一坑第四次，两边留痕于 tasks 4.7 注记）。
  - 变异验证 5 组全部咬住后当场还原并 grep 核对无残留：结论凭片段 ⇒ 1 红；忘发 `BODY_NOT_EXPOSED`
    ⇒ 1 红；逐侧 `io` 透传 errno ⇒ 1 红；`identity_mismatch` 映射指错 ⇒ 1 红；左右两格写反 ⇒ 16 红。
  - ⚠️ 两条如实保留：① `selection_changed` 在 MCP 侧无可达诱发路径（需同请求内被并发替换，
    D3 明言不承诺）⇒ 形状由本批 schema + 类型穷尽承载，行为判据按层引用 R2.2 replay
    `workspace-compare-api.test.ts`，不写假诱发用例；② 内容模式一次请求会重复解析两侧 trace
    （清单冻结 + 正文读取 + 摘要各一次）：共享层只在单次调用内缓存，跨调用无公开复用句柄，
    注入 `readRecord` 需在 MCP 重写 boundary+readRun 管道（= 复制判据）⇒ 不注入，成本如实记录。
  - **S03 形状达成但未整批通过**（七工具已全登记；真实客户端往返归 6.2、预算归 5.1、游标归 5.2、
    凭据过滤归 4.8）；**Q14/S10 未整场景通过**（两侧状态与原文保真、不凭片段判已闭合；
    端到端字节指纹与 Q15/Q16 归 5.4、`RESPONSE_LIMIT` 归 5.1、两侧独立游标归 5.2、
    真实客户端对照归 6.2）。

- 4.8：结构正文凭据过滤、安全错误与信任说明（`REDACTED` 首次有承载点）。
  - 新增 `src/query/redaction.ts`：`REDACTED_MARKER="[REDACTED]"`、归一字段封闭清单
    （小写去 `-` `_` 空白）、递归整值替换、绝对 URL 只换 userinfo、`Object.fromEntries` 落键防原型污染。
    `get-step.ts` 在**规范 JSON 之前**过滤并给 `REDACTED` limitation
    （`span:<owner>:<spanId>/section:<name>`，文案含替换处数）⇒ `range`/`total` 描述过滤后的外发文本。
    **刻意不解析**自由文本、`function.arguments`（JSON 编码在字符串里）与历史文件原文；文件仍由
    4.6 的 `fullFile.bytes/sha256`（完整历史文件）与 `range`（外发片段）两分。
  - `server.ts` 新增 `TRUST_INSTRUCTIONS` 并随 initialize 下发：只读/数据根固定/历史正文不可信/
    已知凭据过滤有限/客户端外发与计费边界；6.3 复用。
  - `test/exposure-fixtures.ts`（第四个独立数据目录）：真实 `JsonlTracer` 写入的凭据 canary
    （Authorization / X-Api-Key / api_key / access_token / password / 端点 userinfo）分布在
    消息附加字段、params、工具 args/result；同时放入**不应被改写**的自由文本凭据样式、
    `function.arguments` JSON 字符串与注入 prompt。
  - `test/redaction.test.ts` **14**：归一命中的十三种写法 / 非凭据键不误伤 / 嵌套数组 / 不改入参 /
    URL userinfo / `__proto__` / 自由文本与 JSON 字符串边界；`get_step` 请求正文与工具 args/result
    的逐项替换、limitation ref 与文案、过滤后范围。判据钉住 `"api_key":"[REDACTED]"` 与三个替换处数。
  - `test/trust.test.ts` **6**：`getInstructions() === TRUST_INSTRUCTIONS` 且十条边界短语在场；
    能力仍只有 `tools`；注入 prompt 作为数据返回且凭据仍被过滤；`write_file` 拒绝且数据目录
    **递归逐字节不变**；`../outside` 在读前拒且不回显；`list_runs` 前后 `data` 深度相等。
  - `test/safe-errors.test.ts` **7**：六工具非法标识 + `list_runs` 游标 ⇒ `INVALID_ARGUMENT`/字段 ref/
    不回显取值；未知字段不回显 `dataDir`；v9 ⇒ `RUN_INVALID` 且不透传读取器原文；
    缺 run ⇒ `RUN_NOT_FOUND`（比较工具逐侧 unavailable，内容模式整条失败）；
    附件目录替身 ⇒ `STORAGE_IO` + `retryable:true` 且无 errno/物理路径。
  - 门禁：mcp-server **225 passed / 15 文件**（+27）、src tsc 0、测试 tsconfig 0、
    run-query **47 passed/1 skip**、desktop **216 文件/3301 用例**、7 包 build、desktop tsc 双 0、
    biome scoped **0**、`check-spec` 13/0、strict valid、`git diff --check` 0；
    命令与 exit code ⇒ `.workbuddy/mcp0-48/gates/gates-48.txt`；回查 `.workbuddy/mcp0-48/verify-48.cjs`
    **48 项全对 + `--self-test` 三道反证咬住**（只钉本批事实 + 尾项 6.6）。
  - 变异验证（施加 → 定向跑 → 反向还原 → grep 无残留）：字段归一失效 ⇒ 8 红、只发标记不发
    limitation ⇒ 5 红、JSON 字符串被解析 ⇒ 2 红、URL userinfo 不替换 ⇒ 2 红；还原后 225/225 绿。
  - **S11 通过（包层/协议）**：已知结构凭据不外发、过滤标记在场、`fullFile`/`range` 两分沿用 4.6。
    **S06 通过（包层/协议）**：非法标识 / 不支持版本 / 真实存储故障三类都得到稳定码、定位与重试属性，
    无原始参数/物理路径/堆栈。**S12 仅协议与行为半边通过**：`instructions` 与「历史指令不扩权」已钉，
    接入指南文本与真实客户端代表任务分别归 6.3/6.2，不提前宣称整场景验收。
  - ⚠️ 如实保留：① `UNSUPPORTED_TRACE_VERSION` 仍在封闭码表中但本批**可达不到**——读取器对
    「版本 > 支持上限」只抛文本型 `TraceReadError`，D4 明言无法可靠细分时落 `RUN_INVALID`、
    不按错误文字猜码；要让该码可达须改读取器/桌面分类，另批定夺。② URL 的 query/fragment 中
    凭据不做参数级解析（属于字符串内容的通用解析）；自由文本/JSON 字符串/文件原文不在过滤承诺内。

- 5.1：完整 tool result 的 64 KiB 实测预算（`RESPONSE_LIMIT` 首次有承载点）。
  - 新增 `src/budget.ts`：`toolResultBytes`（`content`+`structuredContent`+`isError` 的 UTF-8 JSON）、
    `ToolBudget`（单旋钮 items/chars、fit 重建、limitRef）与 `fitWithinBudget`（超预算才二分，
    最小规模仍超 ⇒ `{ok:false,ref}`）。`defineTool` 固定 `observedAt` 后统一收口；实现只提供
    “怎么缩”，测量与搜索只有一处。
  - 接线：`list_runs`/`get_run`/`inspect_checkpoint`/`compare_checkpoint_files(manifest)` 缩条目；
    `get_step`/`read_checkpoint_file`/`compare_checkpoint_files(content)` 缩码点；
    `compare_runs` 无旋钮 ⇒ 超预算只回 `RESPONSE_LIMIT`（`tool:compare_runs`）。
    `truncated`/`remaining`/`range`/`totals.listed` 按实际外发量重算，页 `limit` 仍报请求上限。
  - 夹具 `test/budget-fixtures.ts`（第五、六、七个独立目录）：
    - 页：12×6,000 字 task（单条约 18 KB）+ 80,000 字单项超限靶子 + 60×4,000 字工具名 span；
    - 工作区：102 文件（100 条 512 字长路径，单条清单项约 700 B）+ 3,000/12,000/12,001 码点 NUL 文本；
    - 长链：160 层 prompt fork（run id 约 185 字）+ 8,192 emoji 叶子正文 ⇒ 来源段本身约 36 KB。
  - `test/budget.test.ts` **17**：测试侧**独立**量完整结果（不复用 `toolResultBytes`）；覆盖
    未超预算原样返回/最大可行规模（独立二分对照）/最小不可行 ⇒ `RESPONSE_LIMIT`；list_runs 页收窄、
    get_run 60 span index 收窄、单项超限、compare_runs 无旋钮、inspect/compare 清单收窄；
    read_checkpoint_file 码点范围；compare 两侧大正文同时收窄且结论仍取完整附件；两侧不同长度
    短侧自然结束；长链挤占预算时 get_step 正文收窄（前缀/range/remaining/无孤立代理对）。
  - 门禁：mcp-server **242 passed / 16 文件**（+17）、src tsc 0、测试 tsconfig 0、
    run-query **47 passed/1 skip**、desktop **216 文件/3301 用例**、7 包 build、desktop tsc 双 0、
    biome scoped **0**（81 文件）、`check-spec` 13/0、strict valid、`git diff --check` 0；
    命令与 exit code ⇒ `.workbuddy/mcp0-51/gates/gates-51.txt`；回查
    `.workbuddy/mcp0-51/verify-51.cjs` **38 项全对 + `--self-test` 三道反证咬住**
    （只钉本批事实 + 尾项 6.6，不钉当前前沿）。
  - 变异验证（施加 → 定向跑 → 反向还原 → grep 无残留）：完整结果只量 data ⇒ 7 红；
    不缩直接发 ⇒ 13 红；只取最小规模 ⇒ 4 红；get_step 忽略 chars ⇒ 1 红；还原后 242/242 绿。
  - **S09 预算半边通过**：完整结果 ≤64 KiB、长转义/Unicode/代理对字符完整、range/remaining 准确。
    **S07/S10 部分通过**：页/正文边界、固定顺序、`RESPONSE_LIMIT`、两侧独立首段已钉；
    **`nextCursor` 签发/认证与正文续读归 5.2**（本批仍拒 `cursor`，截断页 `truncated:true` 且
    `nextCursor` 缺席）⇒ 完整分页/续读/两侧独立游标与整场景未通过。

- 5.2：认证游标、参数/读取版本绑定与来源变化拒绝（`nextCursor`/正文 `start` 续读落地）。
  - 新增 `src/query/cursor.ts`：`mcpc1.<keyId>.<payloadB64url>.<macB64url>`；keyId 由进程随机密钥
    派生，MAC 为 HMAC-SHA256；payload 只含 v/tool/参数指纹/readVersion 指纹/kind/位置，不含路径/正文。
    `cursor-io.ts` 统一「解出位置或抛稳定码」与签发；`attachment-ledger.ts` 对附件做 `lstat`
    （kind/bytes/mtime，不读字节）。
  - **绑定/分类**：参数指纹 = 去 cursor/undefined 的规范 JSON SHA-256；readVersion 指纹 = 当前
    readVersion（trace 台账 + 可选附件台账）SHA-256。先参数后版本：参数/工具/模式/同 keyId 篡改 ⇒
    `INVALID_ARGUMENT`；readVersion 变化 ⇒ `STALE_CURSOR`；keyId 不同（重启/另一进程）⇒ `STALE_CURSOR`。
    `readVersion` 标签升 `rv2`；inspect/read/compare 把所读快照/文件/并集的附件 stat 台账并入。
  - **位置**：条目页 1 offset；get_step/read 正文 1 码点 offset；compare 内容 `[left,right]` 双 offset
    （一侧结束不补另一侧）。只有有进展且仍有剩余才签发；0 进展不签（避免原地打转）。预算收窄后的
    `nextCursor` 指向实际外发末端（5.1 的“`nextCursor` 缺席/正文只给首段”由本批取代）。
  - `test/cursor.test.ts` **9**：往返/长度 ≤512/载荷不含路径正文/参数/工具/模式/槽数/readVersion/
    JSON 级篡改（MAC 不符）/畸形游标 + **另一个 Node 进程签发 → 本进程 STALE**（`cursor-child-encode.mjs`
    走 `dist/query/cursor.js`，真跨进程）。
  - `test/cursor-continuation.test.ts` **17**：列表/get_run/inspect/compare 清单逐页无重漏；
    get_step/read_checkpoint_file/compare 内容逐段续读并拼回完整文本（两侧独立、短侧先结束）；
    篡改/参数/换工具 INVALID；列表新增 run、trace 改写、附件改写（inspect/read/清单/内容四路）
    STALE；Q02 新请求重读（新增 run 可见、改写 task 生效）。
  - `test/budget.test.ts` 增 **1**（预算收窄的 8,192 emoji 正文用游标续读到完整规范 JSON，**18**）。
  - **合法改判留痕**：4.3/4.4/4.6/4.7/5.1 的「截断页不发游标/带 cursor 必拒」断言随 5.2 改为
    「有效 cursor 续读；无法验证/参数不符的 cursor 拒绝」；测试标题/注释同步，`rv1` 正则改 `rv2`。
  - 门禁：mcp-server **269 passed / 18 文件**（+27）、src tsc 0、测试 tsconfig 0、
    run-query **47 passed/1 skip**、desktop **216 文件/3301 用例**、7 包 build、desktop tsc 双 0、
    biome scoped **0**（88 文件）、`check-spec` 13/0、strict valid、`git diff --check` 0；
    命令与 exit code ⇒ `.workbuddy/mcp0-52/gates/gates-52.txt`；回查
    `.workbuddy/mcp0-52/verify-52.cjs` **55 项全对 + `--self-test` 三道反证咬住**。
  - 变异验证（施加 → 定向跑 → 反向还原 → grep 无残留）：跳过 MAC 校验 ⇒ 2 红；跳过 keyId ⇒
    2 红；跳过 readVersion ⇒ 8 红；忽略附件台账 ⇒ 4 红；还原后 269/269 绿。
  - **S07/S08/S09/S10 包层/协议通过**：稳定数据逐页/逐段可重建、失败项只出现一次；来源/附件变化
    与跨进程重启 STALE；篡改/异参 INVALID；两侧不同长度独立续读。真实客户端/Electron/真实 stdio
    重启分别归 6.2/6.1/5.3，不提前宣称发行或实机。
  - ⚠️ 如实保留：① keyId 被改的游标与「另一个进程的游标」不可区分，统一 STALE（密码学边界）；
    ② 附件台账只 stat，不读字节——同字节数且保留 mtime 的原地改写不可见（与 D3 并发替换同口径）；
    ③ 0 字符进展不签发游标（宁可本页无游标，也不发原地打转的假指针）。

- 5.3：真实 stdio 全量协议（协商/tools/schema/错误、取消、EOF、重连）。
  - **探针先行**，SDK 行为不靠猜：`.workbuddy/mcp0-53/probe-frames.cjs`（版本回显、旁路方法
    `-32601`、`ping` 应答、非 JSON 行与缺 `method` 帧 ⇒ 无响应帧 + 两条 `protocol_error`、
    缺 `params.name` ⇒ SDK 兜 `-32603`）与 `probe-cancel2.cjs`（三场景 ×6 轮全稳定：同批取消 ⇒
    该 id 零字节外发且 `tool_call` 少一次；迟到取消 ⇒ 不追加帧；大结果后 EOF ⇒ 退出码 0、帧完整）。
    测试里把 SDK 行为常量写成字面量并注明 `@modelcontextprotocol/sdk@1.32.1` ⇒ 升级即翻红复审。
  - **源码只动一处**：`src/server.ts` 接上 `extra.signal`——起跑前已 abort 就记 `tool_cancelled`
    并跳过读取，占位结果由 SDK 丢弃。SDK 把 cancelled 通知排在请求 handler **之前**一个微任务
    （请求侧多一层 `.then`）⇒ 这条分支可达；本包读取全同步 ⇒ **无"读到一半被中断"第三态**。
  - 新增 `test/stdio-harness.ts`（裸 JSON-RPC 线务器：一批帧同一次 write、帧/诊断分流、残段记账、
    等待有上限）与第 7 个独立夹具 `test/stdio-fixtures.ts`（24 条列表 run > 默认页宽、9,002 码点
    大正文、v2 工作区与附件 blob、未封存 run、第二个对照数据根、重启后新增的 run）。
  - `test/stdio-protocol.test.ts` **11**：`2024-11-05`/`2025-03-26`/`2025-06-18` 原样回显、
    不支持版本落 `2025-11-25`、能力恰 `{tools:{}}`、`instructions` 逐字 = `TRUST_INSTRUCTIONS`、
    官方 SDK Client 在无桌面下握手、`tools/list` 与契约逐字相同、发布形状带
    `additionalProperties:false` 与全部上限且无 `$ref`、七个工具在无桌面子进程全部调通且来源只指
    本根（stdout 不含第二根 id、不含数据根物理路径）、空 traces 出空列表、`dataDir`/`handler`
    未知字段与超限参数在读取前拒且不回显取值、重跑/写入类名一律未知工具拒绝、
    `prompts/list`/`resources/list`/`completion/complete`/`logging/setLevel` 得 `-32601`、
    畸形帧不污染 stdout 且会话继续。
  - `test/stdio-lifecycle.test.ts` **9**：同批取消不起跑也不外发（重复/未知 `requestId` 同样容忍、
    不追加帧）、迟到取消不重发、大正文写出后 EOF ⇒ 退出码 0 且每帧完整（约 30 KB）、
    半帧后 EOF ⇒ 不落帧不报错、**真实重启**后列表游标与正文游标都 `STALE_CURSOR`
    （`ref:"cursor"`、`retryable:true`）、新会话逐页翻完与单页 `limit:100` 集合逐项相同、
    同会话内新增 run ⇒ 旧游标 STALE 且随后首页头名换成新 run（Q02 线务面）。
  - 门禁：mcp-server **289 passed / 20 文件**（+20）、src tsc 0、测试 tsconfig 0、run-query
    **47 passed/1 skip**、desktop **216 文件/3301 用例**、7 包 build、desktop tsc 双 0、
    biome scoped **0**（92 文件）、`check-spec` 13/0、strict valid、`git diff --check` 0 ⇒
    `.workbuddy/mcp0-53/gates/gates-53.txt`；回查 `.workbuddy/mcp0-53/verify-53.cjs` **59 项全对** +
    `--self-test` 三道反证咬住（起跑前分支被删 / lifecycle 用例数被抹一条 / 5.3 勾选被抹）。稳定性：`stdio-lifecycle` 连跑 **5 轮 9/9**。
  - 变异验证（每组**配套重建 dist**，否则真子进程读旧 dist 就是假绿）：删取消起跑前分支 ⇒ 2 红；
    未知工具出口改"已受理" ⇒ 1 红；发布形状去掉 strict ⇒ 2 红（含 4.x contracts）；
    诊断写进 stdout ⇒ 15 红（含 4.1 lifecycle）。全部还原并 grep 无残留。
  - **S01/S04/S13 线务面通过**（真实子进程 + 真实客户端 + 只访问该根 + 拒绝不改边界 +
    EOF 释放 + 重启旧游标不复用与新会话重读盘）；**S14 只闭合取消半边**——完整前后 SHA-256
    字节指纹与零执行计数归 5.4，整场景不提前宣称通过。
  - ⚠️ 如实保留：① Windows 无法向 Node 子进程投递 POSIX 信号 ⇒ `signal_shutdown` 出口未做实机
    复验（代码路径在、判据无）；② 低层 `Server` 不禁止重复 `initialize`（实测第二条仍被应答），
    本 change 不承诺它；③ 缺 `params.name` 的 `-32603` 文案由 SDK 生成（zod issue JSON），
    属协议域而非我们的信封，没有伪装成业务码；④ 取消不能中断已起跑的同步读取（该中间态不存在）。

- 5.4：零写入 / 零执行端到端复核（Q15/Q16 + S14 整场景）。
  - 新增第 8 个独立数据根 `test/zero-write-fixtures.ts`：v2 工作区 run 里 `notes/binary/long` 发布
    附件、`gone.txt` **只登记不发布**（哈希按内容算出，字节永不进附件目录），同一根内
    `current-source/gone.txt` 放"当前源目录同名新文件"（内容带 `SENTINEL-` canary），另备一条
    坏尾行 run 作故障面。配套 `test/zero-write.test.ts` **8** 全部走真实 stdio 子进程。
  - **端到端零写入判据（Q15）**：整根递归指纹（相对路径 + 内容 SHA-256 + 目录标记，复用 4.6 的
    `dirFingerprintRecursive`）在五类查询之后逐字不变 —— 六工具全链、逐页翻到底 + 正文续读到
    `truncated:false`、三类故障各触发、取消在途查询、三次重启会话各跑一遍全链；
    且三次会话的**结果事实**（去掉时点/版本字段）逐字一致。
  - **"零写入"钉成封闭白名单**：数据根只允许 `traces/*.jsonl`、`workspace-blobs/sha256/<64hex>`、
    `current-source/gone.txt` 三类条目 ⇒ 任何 index/lock/session/log/journal 新产物都判红；
    另一条用例钉 `traces/` 文件名集合恒为夹具那四个 ⇒ **无新运行落盘**。
  - **故障面不伪装**：坏尾行 ⇒ `RUN_INVALID`（无 `ref`，与 4.x 既有口径一致）、缺 run ⇒
    `RUN_NOT_FOUND`、附件目录替身 ⇒ `STORAGE_IO` + `retryable:true`、v1 run 查检查点 ⇒
    `NO_WORKSPACE`；基线指纹在注入**之后**取，替身目录算夹具一部分而非查询产物。
  - **Q16 源目录不兜底**：`read_checkpoint_file(gone.txt)` ⇒ `status:"missing"` 带
    `fullFile.sha256/bytes`（描述完整历史文件）与 `reason`，无正文；`compare_checkpoint_files`
    内容模式逐侧 `missing`；`inspect_checkpoint` 清单仍在场；stdout 经 `assertNoSentinels` 与
    显式 `not.toContain(ZW_SENTINEL_TEXT)` 双重判 ⇒ 没读当前源、没外发那份新版本，
    `current-source/gone.txt` 字节与旧快照都不动（含在整根指纹里）。
  - **计数为零的结构半边**：`test/closure.test.ts` **4** + `packages/run-query/test/
    dependency-closure.test.ts` **4** 扫已构建工件 —— dist 外部说明符恰等于实测封闭集
    （mcp-server 九个 / run-query 七个），13 个写盘 API、12 个执行/出网符号、8 个写能力导出名
    在 src+dist 出现次数全为 **0**，run-query 不反向依赖 desktop/Electron/MCP。
    数字取自 `.workbuddy/mcp0-54/probe-closure.cjs`；边界如实：不递归进 SDK/replay/trace-sdk 内部。
  - 门禁：mcp-server **301 passed / 22 文件**（+12）、run-query **51 passed / 9 文件 / 1 skip**
    （+4）、desktop **216 文件/3301 用例**、7 包 build、desktop tsc 双 0、
    mcp-server 与 run-query 测试 tsconfig 均 0（**本批新增** `.rebaseagent/tsconfig.run-query-test.json`，
    补掉 run-query 测试无类型门禁的真空）、biome scoped **0**（96 文件）、`check-spec` 13/0、
    strict valid、`git diff --check` 0 ⇒ `.workbuddy/mcp0-54/gates/gates-54.txt`；回查
    `.workbuddy/mcp0-54/verify-54.cjs` **54 项全对** + `--self-test` 三道反证咬住
    （指纹断言被换成恒真 / 报告塞一条失败 / 5.4 勾选被抹）。
  - 变异 4 组（每组配套重建 dist）：启动写 `mcp.lock` ⇒ 7 红（行为 + 结构两层各自守住）；
    当前源版本混进 `missing.reason` ⇒ 1 红；引入 `fetch()` 调用面 ⇒ 1 红；缺 `traces/` 时
    `mkdirSync` 兜底 ⇒ 1 红（4.1 S02）。还原后 grep 无残留、301/301 绿。
  - **Q15/Q16 通过；S14 整场景通过**（5.3 取消行为 + 本批哈希不变与零新运行/operation）。
    ⚠️ 口径边界：S 系列的"零执行"是**只读服务不存在执行调用面**这一结构性事实 + 端到端指纹，
    不是在 MCP 侧插桩计数；真实客户端（6.2）与 Electron 面（6.1）另计，不提前宣称。

## 6.x 进展（不构成场景通过）

- 6.1：真实 Electron 只读链实机批（D03 验收，D02 的实机回归半边）。dev + CDP 9612 跑
  **列表→详情→比较→文件视图→返回**，五批全绿且失败数均为 0：`chain` **41**（宽档 CSS1208）、
  `narrow` **41**（CSS801，目标 800 的 ±2px 内）、`zoom200` **41**（DPR 4.2 真 zoom、CSS605）、
  `keys` **18**（CDP 受信键 Tab 步进 + Enter 激活三次导航）、`manual` **13**（人手真键盘：
  焦点轨迹 8 个落点、三次 `detail=0` 受信激活、view 迁移恰两次）。判据落点：
  阅读位置 = `DetailPanel.tsx:182` 的 `div.flex-1.overflow-y-auto.pb-8`（store 键名 `overviewScrollTop`）
  与 `#steps-navigation` 目录滚动（`stepsScrollTop`），复原口径按 `scroll-restore.ts:34-45` 裁剪；
  无新导航 = store `subscribe` 记账的 `view` 序列；无执行登记 = `confirmations/draftSubmissions/
  operations/currentConfirmationBinding` 的 JSON 摘要全等 + `forking/creatingRun` 恒 `idle`；
  原数据不变 = `traces/ + workspace-blobs/ + settings.json` 逐文件 SHA-256 与基线逐字相同，
  白名单（`traces/*.jsonl`、`traces/tmp-create-*.tmp`、`workspace-blobs/sha256/<hex>`、
  `current-source/gone.txt`）外条目零增减（已知残留 `traces/tmp-measure-*.tmp` 来自
  `measure-fork-cache.cjs`，逐字对齐基线而非放过）。
  D02 实机面：未选步骤时两侧默认=最近自有完成步骤（父 `s_13`/子 `s_16`，期望值双独立来源一致：
  本批解析 trace 的 `agent.step` span 与 `.workbuddy/r22-72/seed.json` 的 `finalStepId`）；
  显式改初始后不被默认回落覆盖；旧 IPC 省略 `stepSpanId` 仍给初始快照（`origin.kind:"initial"`）、
  显式给另一份快照 ⇒ MCP「省略=初始」未改写桌面默认；清单逐侧 `ok` + `unionComplete` + `reference`
  口径未收紧；并集外路径按逐侧 `not_found` 出门且不含物理路径/堆栈。
  证据：`.workbuddy/mcp0-61/d03-<tag>-measurements.json` + 回查 `verify-61.cjs`（含 `--self-test`
  三道反证）；脚本 `apps/desktop/scripts/d03-61-cdp.cjs` / `d03-61-keys.cjs` / `d03-61-keys-manual.cjs`。
  通道边界（不作已验收能力引用）：`keybd_event` 在本机页面零收键（`RESULT=sent` + `same=True` 亦无效），
  真键盘证据走人工按键 + 脚本只观察；CDP 键需焦点模拟才产生默认动作。
  **D03 通过**；**D02 的实机回归闭合**（代码/包层半边在 3.1/3.2）。S15/S16/D01 与指南、另一位使用者、
  全仓门禁、归档仍归 6.2–6.6，本批不代勾也不代宣称。

- 6.2 第一轮真实客户端实跑（2026-10-23，投影修订**前**）：WorkBuddy 5.9.0（内置
  @genie/agent-cli 2.165.0）/ 模型 Step-5-Preview / 12 次工具调用。**S15 未通过**——
  所有调用只回一行 headline，条目/白名单字段/错误消息/正文一次都没到模型；根因是该客户端
  不把 structuredContent 交给模型（initialize.instructions 同样不呈现），而原判据从没钉过
  「真实客户端能从 content 读到事实」。摘要层 8 项数字与桌面基线逐字吻合（693/errored 66/
  不可读 0、2 span、5 文件、1,352,072 B、config.txt 18 码点、big.txt 1,352,000、两侧
  config.txt different、祖先=父）⇒ 可作回归锚点。记录：`.workbuddy/mcp0-62/client-run.txt`、
  夹具 `run_mvi67s4h_wwle`（errored，s_02=HTTP 503）与父 `run_mvi2ckn3_xfxw46`、
  桌面基线 `.workbuddy/mcp0-62/desktop-baseline.json`。
- 6.2 投影修订落地（2026-10-23，owner 定稿方案「content 自足 + 正文只承载一次」，详记于
  design.md D4 修订注）：新增 `src/content-text.ts`（只渲染 data、小事实全额、超长自由文本
  叶子截断并标注总量、正文位渲染本体不截、同输入同输出）+ `tool-definition.ts` 组装 +
  ToolPayload.contentBodies；三个 `*DataSchema` 正文位（get_step body / read file /
  compare files.left,right）由 `text` 改为 `bodyIn:"content"` 指针（range/truncated/
  remaining/sha256/status 小事实保留）。**判据改判留痕**：4.3（get-step.test：bodyText 换
  content 源、keys.has("text") 改判为 false）、4.6（read/compare 测试 text 断言换 content
  提取）、5.1（budget 测试正文长度断言换 content 提取；compare_runs 预算用例在叶子截断下
  保持绿=容量边界未收紧）、5.2（cursor-continuation 拼接换 content 源）、protocol
  「content 只一句状态」改判为「headline + data 投影」并精确钉投影格式；4.8（redaction）、
  5.3（stdio-lifecycle）、5.4（zero-write）的正文判据同步平移到 content 源，REDACTED/零写入
  红线原样保留。新增判据 `content-projection.test.ts` 6 条（正文只承载一次：canary 在
  structuredContent 逐字缺席；content 自足：标识/哈希/结论/range 数字可从 content 读回；
  渲染器纪律：截断标注/确定性/缺本体防御），变异验证 V1（content 退回只 headline）与
  V2（bodyIn 位不展开正文）各红 5 条 ⇒ 判据有牙口。门禁：mcp-server **23 文件/307 用例全绿**
  （基线 22/301 ⇒ +1 文件/+6 用例）、包 tsc 与 `.rebaseagent/tsconfig.mcp-server-test.json`
  双 0、biome scoped 0、dist 已按修订后源码重建（真子进程批次不读旧 dist）。
  **S15 通过（2026-10-24 第二轮实跑，同客户端同模型、修订后 dist `4ca495e`）**：
  8 项回归锚点与第一轮逐字吻合（693/errored 66/不可读 0、2 span、5 文件、1,352,072 B、
  config.txt 18、big.txt 1,352,000、different、祖先=父）；第一轮全部「未呈现」的内容本轮被
  模型逐字引用——列表条目白名单字段全量、configHash、span 索引（spanKind/errorRecorded/
  ambiguousOwner）、错误消息正文 92 码点全引（HTTP 503「R2273 受控 503：上游拒绝」）、
  逐文件清单 5 条（path/bytes/sha256/change/availability）、文件正文（子 `"A: initial-config
"` /
  父 `"B: parent-final
"`）、big.txt 前 4096 码点 + range/truncated/remaining、compare_runs
  口径明细（alongChain/deltaFromAncestor/逐侧 steps 与 tokens/failure 定位）。错误码仅 1 次
  `SPAN_AMBIGUOUS`（按文档补 ownerRunId 消歧，与第一轮同路径）；无 RESPONSE_LIMIT/stale。
  **数据不变性**：指纹 `pre-client-run.json`（10-23T14:02Z）→ `post-client-run2.json`
  （10-24T16:18Z）830 文件零新增/零删除/零改动、白名单外零条目。**D01 通过**（摘要层 8 项 +
  compare 明细与桌面基线一致）。记录：`.workbuddy/mcp0-62/client-run2.txt`（含锚点对照表）。
  诚实边界（不阻塞 S15，6.3 指南必须如实写、是否把游标投影进 content 归 owner 后续决策）：
  `nextCursor` 与 `limitations` 在信封层（page/truncation/limitations 段）、不在 data ⇒
  content 投影不含它们，真实客户端模型两轮都报告「无 cursor 字段」⇒ 真实客户端无法自主续读
  大文件（只能首段 + maxChars 重发仍是同一段）；REDACTED 命中时正文内 `[REDACTED]` 标记
  本身可见。**6.2 勾选**。

- 6.3 指南（2026-10-24）：`docs/guide/mcp-readonly-diagnostics.md` + `docs/README.md` 使用者入口。
  九节 = 任务列的全部要素（构建/启动/数据范围/正文外发/费用/错误/游标/限制 + 发行包不含 MCP
  置顶）；配置示例取 6.2 已通过路径（WorkBuddy 5.9.0 用户级 `mcp add-json -s user` + 通用
  stdio 形状，实测两轮）；信任口径逐字复用服务端 `TRUST_INSTRUCTIONS` 四条（任务 4.8 的
  「复用同一口径，不另写一套」）；6.2 实机边界如实写入（游标/limitations 不进 content 投影）。
  错误码表、码点/分页/预算数字与 `limits.ts`/`error-projection.ts` 实现逐项对齐。
  **S12 整场景通过**（协议与行为半边 4.8 + 指南半边本项）。**S16 指南面交付**——实际接入
  记录归 6.4（另一位使用者，不用维护者自验顶替），S16 整场景仍欠。

- 6.4 前置·维护者自验（2026-10-24，**不代 6.4/S16**）：指南 §3 同形状配置在 **Trae 3.4.4**
  （Agent 会话，工具经 ToolSearch 延迟加载；模型 DeepSeek-V4.1-Flash；无批准弹窗、无报错）
  上验证。**引用可回查成立**：runId `run_mvi67s4h_wwle`/父/fork(s_02·system_prompt)/错误消息
  canonical-json 原文与解码版/HTTP 503/检查点五条清单（合计 1,352,072 自核）全部逐字引用；
  模型从 `index.items[].ambiguousOwner: true` 主动补 ownerRunId（未撞 SPAN_AMBIGUOUS——
  投影内消歧提示有效性的首个客户端实证）。**游标不可见（第二样本）**：big.txt maxChars=8192
  拿满 0–8192（remaining 1,343,808），无 nextCursor；模型原话"Since the output is text-only,
  no cursor"——Trae 与 WorkBuddy 同为「只把 content 文本交给模型、丢弃 structuredContent」类。
  **预算收窄在真实客户端可见**：errored 过滤 limit=100 列 57/66 条，模型因无游标无法翻页，
  用 limit=1 复核规避 ⇒ 边界影响从大文件正文扩展到清单翻页，指南 §8 已按两样本更新。
  维护者自验按任务口径不顶替 6.4。

- 6.5 全仓门禁与性能读数（2026-10-24）：四连 tsc 0（mcp-server 包 + 两份测试 tsconfig +
  desktop 双配置）、7 包 build 0、mcp-server **23 文件/307 用例 0 失败**（6.2 新基线回归确认）、
  run-query 9/51+1 pending、desktop 216/3301、biome scoped **99 文件 0**（+3 = 投影三新文件）、
  check-spec 13/0、openspec strict 1/0、git diff --check 0。json 报告/命令/读数 ⇒
  `.workbuddy/mcp0-65/gates-65.txt`，回查 `verify-65.cjs`（--self-test 反证 3/3）。
  性能读数（`perf-probe.mjs` → `perf.json`，数据根 = 真实 `.rebaseagent` 693 runs；口径：同进程
  直调 dist、单轮、RSS 未强制 GC）：单对象查询 10.9–37.8 ms；`big.txt` maxChars=8192 外发
  10,985 B 且 RSS +33 MB；`list_runs` errored 单页 537.7 ms/65,176 B（预算收窄 57 条）、
  全量 693 翻页 8 页 6,465.4 ms/累计 749,172 B——每页 ~0.5–0.8 s 主因是每请求重扫 traces/
  全目录（Q02 每请求重读盘的既定取舍，零写入/来源新鲜度的另一面），记录为设计行为非缺陷。
  诚实边界：性能数字为量级参考（单轮、未强制 GC、无并发混跑压测）；6.4（S16）仍挂账。

## 门禁与归档约束

- 6.5 补实际命令、exit code、源码身份、包构建顺序和新依赖核验；不引用 R2.2 历史通过代替本次通过。
- 6.6 合并 delta 前后核对既有 requirement/scenario 零遗漏，回填实际支持客户端/运行时/分发边界。
- 客户端/另一位使用者未通过时不勾对应任务、不宣称全部验收；人工项与自动项分列。
- 本次 change 文档 strict 校验结果另行记录，不作为上表功能证据。
