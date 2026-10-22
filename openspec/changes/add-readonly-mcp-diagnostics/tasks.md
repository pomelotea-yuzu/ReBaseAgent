# MCP0 / MCP1 实施任务

状态（2026-10-22）：**1.1/1.2/1.3、2.1–2.5 已完成；2.6 起未实施**。
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
- [ ] 2.6（2h）建立投影 span→owner 索引，支持重名消歧与被截断祖先拒绝。验收 Q09/Q10。
- [ ] 2.7（1.5h）迁移运行比较纯派生，逐侧失败、来源未知/独立边界保留。验收 Q11/Q12。
- [ ] 2.8（1.5h）共享检查点查看与附件读取包装，保留自有/初始规则和全部文件状态。验收 Q13/Q14/Q16。
- [ ] 2.9（1.5h）接入 replay 跨运行清单/内容比较，清单引用与字节结论分开。验收 Q14。

## 3. 桌面接线回归

- [ ] 3.1（1.5h）旧 IPC/类型出口接共享实现，保留执行和 renderer 职责边界。桌面默认检查点解析为显式 selector 再调共享层（共享层缺省=初始），接口注释各写明本层默认。验收 D01/D02。
- [ ] 3.2（1.5h）同 fixture 的 desktop/shared 对照：版本/缺父/坏父/usage/比较/检查点。验收 D01/D02、Q01。

## 4. stdio 服务与外部投影

- [ ] 4.1（1.5h）建立 MCP 包、CLI 显式数据根检查、stdout/stderr 纪律及 SDK 生命周期。验收 S01/S02。
- [ ] 4.2（1.5h）定义七工具 strict schema/annotations、版本结果/错误 schema，禁止执行/资源旁路。验收 S03/S04/S05/S06。
- [ ] 4.3（1.5h）实现 list_runs/get_run 的摘要、筛选、tagged item 索引/失败项。验收 S03、Q03/Q04。
- [ ] 4.4（1.5h）实现 get_step section/owner 读取和结构正文规范 JSON 投影。验收 S03、Q09/Q10。
- [ ] 4.5（1h）实现 compare_runs 双侧投影/引用/BODY_NOT_EXPOSED，按 D5 两侧对象 schema（与 compare_checkpoint_files 同形）。验收 Q11/Q12、S05。
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
