# R2.2 实施任务

状态：提案完成，尚未实施。以下每项预计 0.5–2 小时，超过即拆分；所有复选框保持未完成。scenario 精确映射见 [evidence-index.md](evidence-index.md)，旧场景保留的行为也须回归，不以 strict 通过代替功能证据。

## 1. 基线与交互冻结

- [x] 1.1（1h）建立 config.json 受控案例及 fixture：初始 A/父最终 B/源目录 C、未知键保留判据、消息/profile/模型配置和兄弟分支指纹；记录原指令/新单项指令。验收：workspace「根初始状态与父最终及源目录分离」、prompt「单项改动与首次实际请求一致」。mock 与真实模型证据分列，fixture 不算 I/R3。
  （2026-10-20 ✅：`packages/replay/test/isolated-prompt-baseline-fixture.ts` + 验收测试 7/7 绿（`isolated-prompt-baseline-fixture.test.ts`，单包复跑 7/7、tsc 0 错、biome 0 错）；记录 = change 目录 `baseline-fixture.md`。三态分离/单项编辑一致/兄弟指纹可复现/空初始世界变体均断言。真实模型证据按口径留给 7.1。）
- [x] 1.2（1.5h）P0/P1 复核 prototype.md 的入口、非根返回、状态/许可、文件双 selector 与导出方向，记录现有 UI 对照和交互原型验证结果，修订后再接 UI。验收：desktop「根定位和核对有明确目标」「单份确认表达实际条件与未知」「真键盘完成实验比较导出闭环」的设计覆盖；实机完成仍待 7.1/7.2。
  （2026-10-20 ✅：对照记录 = change 目录 `prototype-review.md`（逐路径载体对照 / 状态表逐行 / 双 selector 与导出方向 / 三条验收 scenario 设计覆盖判定）；prototype.md 已按结论修订 3 处（路径 1 载体注记、路径 5 selector 不同构注记、状态表补「比较冻结期间新完成检查点」行）。文档层覆盖判定完成，实机归 7.1/7.2。）
- [x] 1.3（1h）盘点 FORMAT_VERSION/workspace 判据、reader/branch/IPC/preload/trace-test/删除保护消费方及 v1/v2/v3 fixture 矩阵，记录兼容修改归属。验收：trace「三版本读取与写入职责分离」、replay「新版本不扩大普通执行和卡带权限」。
  （2026-10-20 ✅：盘点 = change 目录 `compat-inventory.md`（trace-sdk/replay/trace-test/agent-loop/desktop 全清单 + 修改归属表 + v1/v2/v3 fixture 矩阵）。关键发现：① 隔离判据=workspace 存在性 ⇒ v3 自动命中；② 6 处 `=== FORMAT_VERSION` 等值二分（reader.ts:117、branch.ts:83、compare-edit-evidence.ts:377、compare-source-map.ts、run-lineage-read.ts、run-detail-project.ts）升版时必须改 `>=2`，否则存量 v2 静默降级 v1 语义；③ checkpoint-tracer.ts:95 写死 FORMAT_VERSION 是 v3 写入第一归属点；④ baddata-regression 等三处「未来版本」fixture 构造值 3 需翻转为 4+。）

## 2. 格式与独立执行边界

- [x] 2.1（1.5h）新增 v3 schema、initial origin、prompt_experiment 和明确 writer 版本常量，校验重复 ID、空串/可选 params、假设长度和禁用字段。验收：trace「初始来源与干预记录往返」「矛盾的实验来源拒绝」。
  （2026-10-21 ✅：`FORMAT_VERSION=3`（= `PROMPT_EXPERIMENT_FORMAT_VERSION`），新增 `ISOLATED_FORMAT_VERSION=2` 写入常量；`WorkspaceOriginSchema` 增 `initial{run_id,snapshot_id}`；新增 `PromptExperimentSchema`（execution.model/可选 params/去凭据 endpoint/max_iterations/budget/config_fingerprint，original_value 允许空串，hypothesis/acceptance ≤4000）。`RunMetaSchema` v3 自洽：parent/fork 必填、禁 resume_after_step、edit 仅两个 prompt 字段且 value 为字符串、baseline/origin/snapshot/span ID 一致；v1/v2 直带 prompt_experiment 与 v2 initial origin 也拒绝。测试 `packages/trace-sdk/test/experiment.test.ts` 34 项全绿（含 params 缺省 vs 显式 `{}`、嵌套/数组/null 拒绝）。）
- [x] 2.2（1.5h）更新 strip 前版本守卫、reader/BaseTracer/MemoryTracer 与跨行快照校验，增加旧版本禁字段和未来版本 fixture。验收：trace「未来版本文件」「版本与隔离字段不匹配」「v1 禁字段与其他扩展区分」「新实验字段不能藏在旧版本中」。
  （2026-10-21 ✅：version-guard 增 v3 分支（必带 workspace+prompt_experiment+initial origin、禁 resume_after_step），v2 禁 prompt_experiment/initial origin，v1 禁 prompt_experiment；reader 跨行 step 快照判据改 `version >= ISOLATED_FORMAT_VERSION`（防存量 v2 掉 v1 语义），未来版本改为 4。BaseTracer/MemoryTracer 经同一守卫与 schema 自动往返（v3 meta 事件流覆盖）。trace-sdk 13 文件/225 用例全绿。）
- [x] 2.3（1.5h）更新 branch/来源读取的独立边界及完整父根对应校验，保留 ownOnly 自有读取和缺附件阅读。验收：replay「v3 详情只呈现自有完整步骤」、trace「缺父或附件不阻止自有轨迹阅读」「矛盾的实验来源拒绝」。
  （2026-10-21 ✅：新增导出 `findExperimentSourceViolation(child,parent)`——父必须为 import 隔离根、at_span 必须为父自有首次 llm.call 且位于第 1 步、original_value 与父请求对应 role 的首条字符串一致、父初始快照/origin.snapshot_id/experiment.initial_snapshot_id 三者一致；`resolveBranch` 对 v3 只取自有 spans（父链仅溯源），v2 result 子挂 v3 父仍走 `resolveWholeRound` 且前缀截止 v3 自身整轮。`readRun` 自有读取不依赖父文件。测试覆盖 v3 自身、v3→v2 result 子、at_span/原值/非根父矛盾与缺父自有读取。）
- [x] 2.4（1.5h）更新其余版本消费方/包导出，验证 v3 父 result 子仍写 v2，卡带/模型实验/删除保护门禁保持。验收：trace「双版本与旧读取器」「三版本读取与写入职责分离」、replay「v3 后的 result 分支保留正确前缀」「新版本不扩大普通执行和卡带权限」。
  （2026-10-21 ✅：replay `WorkspaceCheckpointTracer` 写 `ISOLATED_FORMAT_VERSION=2`（升最高读取版本不升既有 writer）；trace-sdk 主出口导出新常量/schema/类型与来源校验；desktop 6 处 `=== FORMAT_VERSION` 二分改 `>= v2`（compare-edit-evidence 增 `isolated-v3` 分型、compare-source-map、run-lineage-read v3 完整来源校验、run-detail-project ≥2）；`WorkspaceInspectResultSchema`/`workspace-view`/文件页/隔离说明/RunWorkspace 增 initial origin 文案与投影。trace-test 增 v3 卡带基线用例（父文件不存在仍可读可跑、新轨迹写 v1）。未来版本 fixture 3→4（baddata/run-repository/gen-u1/gen-u7/u1b_future/u7c_b_future）。门禁：trace-sdk 225、agent-loop 104、replay 508(+5 skip)、trace-test 78、llm-proxy 45、desktop 203 文件/3182 全绿；desktop node+web tsc 0 错；biome 143 文件 0 错。）

## 3. 隔离 prompt 包层

- [x] 3.1（1.5h）实现根/封存/来源和首次启动消息严格预检，非根返回经核实导航建议，不复用普通 workspace 拒绝函数放行。验收：prompt「中途分支只能显式返回根」「缺失或不可还原的启动条件拒绝」「父 run 未封存」。
  （2026-10-21 ✅：新增 `preflightIsolatedPromptReplay`（`workspace/isolated-prompt-preflight.ts`），独立于 result 预检/普通 handler。顺序：请求形状与安全 run ID → 父链（ENOENT/结构非法/成环=`parent_chain_invalid`，真实 I/O=`storage_io`）→ 已封存 → workspace/profile → 根（parent/fork null、origin import）→ 启动消息/编辑/params → 固定 profile+父根 config_hash → 当前预算/端点 → 初始配额 → 全附件。中途 result/v3 分支返回 `parent_not_root` + 经完整父链验证的 `rootId` 导航建议（失败对象不携带计划/指纹，非授权）；缺祖先不猜根。测试 26 项覆盖非根/缺根/缺祖先/未封存/v1 根/缺 user/首调用非第 1 步。）
- [x] 3.2（1.5h）实现单项内容派生、固定 profile/config_hash 和无损模型/params 恢复，禁止组合/空编辑与静默过滤。验收：prompt「同时修改两个字段」「隔离编辑保留空串和空白的真实变化」「单项改动与首次实际请求一致」「不支持参数或配置漂移不能静默放行」。
  （2026-10-21 ✅：新增纯内核 `isolated-prompt-state.ts`：编辑严格两键（额外键=组合修改拒绝），只替换首条对应 role 的字符串 content，非目标消息逐字段保留；空串/空白是真实变化，逐字相同=`empty_edit`；启动消息只接受 system/user+字符串 content+可选字符串 name、各至少一条，assistant/tool/tool_calls/多模态/未知字段=`startup_unavailable`。模型固定根首次请求；params 用 `restorePromptParams` 无损恢复（缺省 vs `{}` 区分，嵌套/数组/null/NaN/Infinity/保留键拒绝，不调 `scalarParams`）。新 config_hash 只吃有效 system+固定工具表。测试 34 项。）
- [x] 3.3（1.5h）实现非密钥有效配置规范化/指纹及当前配置绑定、初始清单配额/全附件核验和稳定失败码。验收：prompt「合法根预检只读且提交重验」「缺失或不可还原的启动条件拒绝」「历史未知条件与真实计费分别表达」。
  （2026-10-21 ✅：计划指纹=递归 UTF-16 键序规范 JSON 的 SHA-256，覆盖基线/首次 span/初始快照 ID/原值/编辑/有效消息/model/params（缺省省略、显式 `{}` 保留）/去凭据端点/max_iterations/budget/tool profile 与定义/config_hash。端点只留 origin+pathname（userinfo/query/fragment 丢弃）。预算优先根 meta 录制值；录制值大于当前上限时明确拒绝（不静默截小）；根未录制且当前无 token 预算也拒绝。capability 分列 `historicalUnknowns`（provider_backend/max_iterations/token_budget）与 `billing`（usage/价格/缓存执行前未知）。初始清单先判 2000/8MiB/64MiB 配额再逐附件 verify（missing/corrupt/storage_io 可分辨）。测试含目录指纹前后一致、重复预检同指纹、删附件后重验失败。）
- [x] 3.4（1.5h）实现独立世界/固定文件工具/v3 tracer/从第 1 步执行并通知真实身份，提交前重验及当前授权。验收：workspace「根初始状态与父最终及源目录分离」「空初始世界与后续超限遵守原配额」、prompt「当前写入授权和失败事实不可替代」。
  （2026-10-21 ✅：新增 `promptReplayIsolatedRun`（`workspace/isolated-prompt-run.ts`）：授权 → 提交时重跑预检 → 从 capability.initial_snapshot 建新世界（allowFileWrites=true）→ 固定 `createFileToolsV1` → v3 临时 trace → runLoop 从第 1 步 → 归位。`WorkspaceCheckpointTracer` 参数化 `formatVersion`/`promptExperiment`（v2 缺省、v3 必带 initial origin；构造期拒绝错配）。有效配置用根 model/params/messages，端点/key/exec 用当前；fork 无 resume_after_step。身份观察挂 delegate。测试：system 编辑首次请求读 A（非 B/C）、父/兄弟/源/既有 blob 字节与目录指纹不变、v3 meta/实验记录/指纹往返、空初始世界写入成功、8MiB+1 写入成为工具错误且映射不变。）
- [x] 3.5（1.5h）补模型/存储故障、观察者抛错和资源释放集成测试，核对零子记录与真实失败记录边界。验收：prompt 三条「prompt 身份在后续失败时仍可关联」「prompt 前置拒绝不报告假身份」「prompt 观察者兼容且释放」及「当前写入授权和失败事实不可替代」。
  （2026-10-21 ✅：模型失败（剧本耗尽）→ v3 errored 正常落盘、身份恰一次且与 meta.id 一致、实验记录保留、零工具；观察者抛错→执行/请求数/终止语义不变；未授权/非根/提交前附件缺失→零 LLM、零子记录、零身份。存储故障用 `vi.mock node:fs` 注入：meta 行失败→零模型/零身份/临时文件不归位/句柄配对释放；首轮 step 失败→身份已通知、落盘 crashed 无虚假终止、v3 记录保留、共享附件不删、句柄释放。）
- [x] 3.6（1h）回归普通 prompt、连续 fork、proxy 支持与普通隔离降级拒绝；普通父本缺 user 但有 system 时仍允许 system 编辑、仅拒绝 user 编辑，不套用隔离“至少各一条”规则；核对父/兄弟/源/既有 blob 指纹。验收：prompt「连续 prompt fork」「proxy run 拒绝」「含 config_hash 的 proxy run 放行」「隔离父本不能转普通 prompt fork」，普通输入兼容检查作为保留行为回归。
  （2026-10-21 ✅：新增 v3 父本 → `promptReplayRun` 拒绝且零 outDir/零调用（隔离门禁对 v3 workspace 自动生效）；v3 父的 result 续跑端到端仍写 v2（checkpoint origin/resume_after_step/子格式），`resolveBranch` 前缀只含 v3 首轮整轮、按消息内容证明未拼入实验根。普通缺 user 的 system 编辑/仅拒 user 编辑、连续 prompt fork、proxy 拒绝与含 hash 放行由既有 `prompt-fork.test.ts`/`prompt-replay-run.test.ts`/`isolated-entry-guard.test.ts` 回归；replay 全量 45 文件/581 通过(+5 skip)。父/兄弟/源/既有 blob 指纹在 3.4 用例中逐字节断言。）

## 4. 跨运行文件比较包层

- [x] 4.1（1.5h）实现双 selector 清单读取/冻结、同 run 同时点、路径并集与逐侧失败，接口仅接受逻辑身份；包 API/IPC 注释明确缺省 stepSpanId=初始，不承担桌面“最近一步”解析。验收：workspace「两个自有检查点独立选择与路径并集」「二进制和读取错误保留逐侧状态」。
  （2026-10-21 ✅：新增 `workspace/compare-api.ts` 的 `compareWorkspaceSnapshots`：两侧独立 selector（缺省=初始）、每侧请求 id 必须等于 meta.id（否则 `identity_mismatch`）、同 run 按 id 缓存只读一次记录。双方可用时路径按 UTF-16 并集，逐路径给 presence 与清单引用 same/different（不读字节）；任一侧不可用时 `unionComplete=false`、entries 为空，保留该侧 run/step/snapshot/initial 身份与失败码。`readWorkspaceRun` 增可选读取器以复用同一时点。测试：不同根并集/仅左仅右/同 run 初始 vs 完成步骤单读/共同祖先不同 initialSnapshotId/身份不符/祖先步骤/v1 无 workspace。）
- [x] 4.2（1.5h）实现按 path 延迟字节核验、引用/内容状态区分及 expectedSnapshotIds 守卫。验收：workspace「未核验引用不冒充字节相同」「选择快照变化不能拼出混合差异」。
  （2026-10-21 ✅：新增 `readComparedWorkspaceFile`：按 path 逐侧延迟 `readVerified`（长度+SHA-256），区分 text/binary/not_found/missing/corrupt/too_large/io/selection_changed/unavailable。`expectedSnapshotIds` 必填（非空两 id）；任一侧实际 snapshot id 不符→该侧 `selection_changed` 且不读正文，另一侧仍可读，整体结论 unavailable。清单引用 same 不产生内容结论；测试中删除共享 blob 后读取逐侧 missing。`not_found` 只由合法清单证明，附件缺失/损坏不伪装成不存在。）
- [x] 4.3（1.5h）实现文本/不存在差异、二进制/超限/真实 I/O 行为及只读不变量测试。验收：workspace「文本新增删除与原换行可核对」「二进制和读取错误保留逐侧状态」，所有 compare API 零网络/工具/写入。
  （2026-10-21 ✅：文本返回原始 text（CRLF/LF、空串、尾随换行不规范化），结论 same/different/left_only/right_only/not_found；`textDiffEligible` 仅 text/text 或 text+清单证明 not_found。二进制返回原始 bytes，只给 same/different，不进文本 diff。超限（>8 MiB）不读附件即 `too_large`；I/O 故障逐侧 `io`，另一侧仍可读。只读不变量：清单+正文读取前后 dataDir 文件/大小/mtime 指纹不变。测试 15 项；replay 全量 46 文件/596 通过(+5 skip)。）

## 5. main / shared / preload

- [x] 5.1（1.5h）增加 v3 RunRecord/RunDetail 往返、严格只读 capability 和比较 schema/端点/preload，拒绝额外配置/物理字段。验收：trace「初始来源与干预记录往返」、desktop「预检无副作用且非法模式拒绝」、workspace「选择快照变化不能拼出混合差异」。
  （2026-10-21 ✅：新增 channels `workspaces:isolatedPromptCapability` / `compareSnapshots` / `compareFile`；shared IPC 增 capability/比较的 strict schema（编辑/请求/结果/逐侧状态），capability 领域拒绝用 ok 信封 status=unavailable（携带 rootId 导航建议）；新增 main `isolated-prompt-endpoints.ts`、`workspace-compare-endpoint.ts` 与 preload 三方法。`RunRecordSchema`/`RunDetailSchema` 直接复用 trace-sdk schema，v3 往返测试 3 项（含缺 prompt_experiment 的 strip 前拒绝）；比较端点测试 4 项（额外字段拒绝、二进制不跨进程、selection_changed 透传）。）
- [x] 5.2（2h）扩展 runs:promptFork 显式隔离分流，main 从基线重建模型/params，绑定计划指纹和单个 ExecutionConfigState 的配置修订；保存/清除成功及预检/提交读取均接同一刷新入口，覆盖端点隐藏部分、换 key、清除后重配、相同有效值不轮换及独立代理设置不误轮换，重验完整来源/授权。验收：desktop「预检无副作用且非法模式拒绝」「修改或配置变化撤销旧许可」、prompt「不支持参数或配置漂移不能静默放行」。
  （2026-10-21 ✅：新增 `main/execution-config-state.ts`（单一 owner，随机 opaque revision；比较 baseURL/model/apiKey/执行限制；相同值不轮换、清除/重配/换 key/隐藏端点轮换；不哈希密钥）；settings save/clear 与 proxy toggle 成功后同步 refresh；capability 返回 configRevision。`runs:promptFork` 改为 strict union：普通载荷兼容；隔离必须 `executionMode:"isolated"` + `allowFileWrites:true` + expectedConfigRevision + expectedPlanFingerprint，缺 mode/额外 config 不会落普通分支。提交时先核对修订→来源门禁→重新预检→核对计划指纹→授权→包层执行；`promptReplayIsolatedRun` 增可选 expectedPlanFingerprint。测试：配置修订 5 项、capability 6 项、配置写刷新 1 项。）
- [x] 5.3（1.5h）接 U4 操作适配器/真实 run ID 与拒绝/失败回执，覆盖同 ID/异参/单槽/旧 epoch/未知响应。验收：desktop「去重和单槽覆盖新隔离入口」「响应未知和模型失败只核对可信身份」。
  （2026-10-21 ✅：隔离分支复用 `submitActive`：epoch/信封/一次 parse/判重/单槽/回执全部沿用 U4；真实身份由 `promptReplayIsolatedRun.onRunIdentified` 经 ctx.attachRunId 登记。测试 10 项：合法提交身份=meta.id 且 operation 不含 prompt 正文；同 ID 同参只执行一次（duplicate）、异参冲突；旧 epoch 零登记；配置修订/计划漂移/非根 settled/rejected+runIds=[]；缺 mode/allowFileWrites=false/额外配置 shape 拒绝；单槽 busy；reconcile tombstone 后提交永久拒绝；模型失败 v3 errored 落盘但身份可信。）
- [x] 5.4（1.5h）回归普通 create/result/prompt/proxy/A-B、ownOnly 门禁、v3 自有文件/导出来源、卡带与删除子保护。验收：desktop 保留的历史场景、replay「新版本不扩大普通执行和卡带权限」、trace「三版本读取与写入职责分离」。
  （2026-10-21 ✅：desktop 全量 208 文件/3211 通过（含普通 create/result/prompt/proxy/A-B、ownOnly/来源门禁、设置/代理/操作历史场景）；replay 46 文件/596(+5 skip)。新增 v3 集成断言：`inspectWorkspace` 返回 origin=initial/初始快照 A、文件页读到 A；`exportWorkspaceSnapshot` 固定 v3 自有初始检查点；`assertDeletable` 正确阻止删除有 v3 子分支的根。卡带 v3 用例沿用阶段 2 `trace-test`。desktop node/web tsc 0 错；biome 206 文件 0 错。）

## 6. 桌面现有工作区接入

- [x] 6.1（1.5h）接根/非根入口及预检身份，扩展 prompt 草稿目标但保持单 store/分片职责，保存原文/假设/判据。验收：desktop「根定位和核对有明确目标」「往返恢复正文不恢复执行许可」「system prompt 不可还原」。
  （2026-10-21 ✅：新增 `lib/isolated-prompt.ts`（根/分支/不可用三态 + 隔离 guard + 根导航折算）与 `detail/IsolatedPromptEntry.tsx`（概览/首次 llm.call 入口；分支只经 capability 核实 rootId 后导航）；`PromptForkEditor` 增 `mode="isolated"`，复用同一编辑器与 Monaco 对照；草稿键加 `mode`（`calls[runId][spanId]["isolated:<field>"]`），假设/判据随条目保存并参与 dirty/修订 CAS；列表/定位/放弃/提交键全链带模式。system+user 缺任一条时两种编辑均禁用且不给补造。测试：`isolated-prompt.test.ts` 10、`isolated-prompt-entry.test.ts` 6、`debugging-drafts` 模式用例 3、`draft-list`/`draft-submission` 各 1。限制：无 jsdom，入口/编辑器为纯逻辑 + 源码接线；真机 7.2。）
- [x] 6.2（1.5h）接单份核对卡/编辑 diff/有效模型与未知项/当前费用与副本确认，输入/设置变更撤销旧许可。验收：desktop「单份确认表达实际条件与未知」「修改或配置变化撤销旧许可」「编辑前确认真实计费」。
  （2026-10-21 ✅：新增 `lib/isolated-prompt-card.ts`（capability 卡排版 + 请求/提交同源判据）；`PromptForkEditor` 调 `loadIsolatedPromptCapability` 只读核对，卡上列根/初始文件/固定工具/基线模型参数/端点/上限/预算/历史未知/计费未知；费用确认用既有 `ConfirmationBlock` 凭据（channel=prompt_experiment），副本授权绑定修订/设置快照/检查代次/计划指纹；设置变化推进检查代次并清空，切字段/收起/卸载释放确认。测试：`isolated-prompt-card.test.ts` 9、`execution-confirmation-store` 计数改判留痕、`isolated-prompt-entry` 接线断言。限制：卡上真实 usage 归 7.1；窄窗/键盘 7.2。）
- [x] 6.3（1.5h）接提交、全局活动、结果核对/失败定位和 revision/token CAS 清理，保护未知/迟到/跨页阅读。验收：desktop「失败和旧结果不清除新草稿」「响应未知和模型失败只核对可信身份」，并回归已有草稿/操作/确认场景。
  （2026-10-21 ✅：新增 `operations.promptExperiment`，复用 `submitActive(api.promptFork)`/U4 身份/去重/单槽与 `finishDraftSubmission`；组件按 `resolveIsolatedPromptSubmission` 提交 executionMode=isolated + 计划指纹 + 配置修订 + allowFileWrites + 假设/判据；`beginDraftSubmission` 用 prompt_experiment 通道与带模式目标；U5 收尾按模式 CAS 清理，失败/拒绝保留草稿与关联。测试：`fork-entry-closure` 新增 2（请求原样透传、成功只清隔离草稿、失败保留）、`draft-closure-decision` 1（模式清理）、`isolated-prompt-card` 提交判据 3。限制：全局活动沿用既有 promptFork 行（不新增 main target 字段）；真实重载/跨页在 7.3。）
- [x] 6.4（1.5h）在双运行比较接文件视图、独立检查点与路径列表，保留原输出/修改/指标；桌面默认先解析为显式自有完成步骤 ID，无则选择初始，验证 IPC payload 不把“最近一步”误传为缺省，失效 selector 不自动改点。验收：desktop「两侧检查点独立且迟到结果不串页」「分别打开文件并返回比较」「非法文件目标与普通运行不造历史」。
  （2026-10-21 ✅：新增 `lib/compare-file-view.ts`（显式默认解析、selector 只对 null 省略、stale 不改点、expectedSnapshotIds）与 `CompareFileWorkspace.tsx`；`CompareWorkspace` 增「文件」视图，`compareFileView` 状态跨打开单侧文件保留；独立 selector + UTF-16 并集路径列表 + 清单引用状态；`openCompareSideFilesAt` 固定比较检查点/路径。测试：`compare-file-view.test.ts` 11、`compare-file-wiring.test.ts` 6、`compare-store` 新增 3。限制：真实双运行实机 7.2；bin 目录/IPC 结构断言不替代实机。）
- [x] 6.5（1.5h）接正文 diff/逐侧错误/只读工具及双 selector/snapshot/path/请求代次守卫。验收：desktop「文件差异诚实呈现未验证和不可用」、workspace「文本新增删除与原换行可核对」「选择快照变化不能拼出混合差异」。
  （2026-10-21 ✅：`CompareFileWorkspace` 按 path 延迟 `readComparedWorkspaceFile`，请求带冻结 selectors + `expectedSnapshotIds`；manifest/file 双代次序号；文本原样进只读 Monaco diff，二进制/超限/缺失/selection_changed 逐侧状态且不造伪 diff；清单引用 same/different 与正文核验分列。测试：`compare-file-view` 文本/二进制/逐侧标签、`compare-file-wiring` 守卫断言。限制：200%/滚动/CRLF 视觉与真实路径归 7.2。）
- [x] 6.6（1.5h）接干预/假设/结果入口及明确单侧文件/导出/返回路径，保留 R2.1 补丁与来源语义。验收：desktop「比较到导出固定选中侧」「正常结束和输出变化不冒充修复证据」。
  （2026-10-21 ✅：新增 `lib/prompt-experiment-view.ts` 与概览「本次干预」区：基线/调用/初始快照/模型参数/端点/上限预算/原值新值/假设/人工判据；结局说明只复述事实，明确不自动判修复、不评分判据；「与基线运行比较」复用父左子右，文件/导出走本运行文件页 R2.1；比较文件视图增「导出该侧检查点」，仅该侧清单 ok 时可用。测试：`prompt-experiment-view.test.ts` 8、`compare-file-wiring` 导出断言。限制：真实导出字节/目录选择/单侧固定归 7.1/7.2。）

**阶段 6 门禁（2026-10-21）**：desktop 全量 **214 文件/3272 用例通过**；tsc web/node 0；biome 变更文件 0；spec 13 项 ✓。6.1–6.6 只交付代码/单测/源码接线，真实模型、真实窗口/缩放/键盘与失败注入仍归 7.1–7.3。

## 7. 实机、证据与收口

- [x] 7.1（2h）独立测试 dataDir 下完成受控真实模型的根→单项编辑→实际子运行→输出/文件比较→单侧导出闭环，记录模型/配置、所有尝试、实际人工判据结果及源/父/兄弟/既有 blob 指纹；导出字节/清单独立复核。验收：desktop「比较到导出固定选中侧」「正常结束和输出变化不冒充修复证据」，workspace 首次读取不变量；不能把 mock/探针注入写为真实模型修复证据。
  （2026-10-21 ✅：独立 dataDir `.workbuddy/r22-71/run-20261021-030856/data`；provider `https://api.deepseek.com` / `deepseek-flash`（key 仅内存解密，未打印/落盘）。真实模型 3 个运行全成功：根 `run_mvhj9cq8_1y8519`（5 LLM/4 tools，初始 A→最终 B+summary，usage 3819/326）、兄弟 `run_mvhj9h3y_72b7`（只读 keep-A，usage 1028/75）、主实验 `run_mvhj9i9c_c22r`（单次 read_file→A，最终 config A、无 summary，usage 1260/226）。19/19 机器检查 PASS：初始快照同 A、根 B vs 子 A different、summary 仅根、源/父/兄弟 trace/既有 blob 指纹不变、单侧导出 3 文件/33B 且 sha256/manifest/source 复核一致、导出 config=A。人工判据已由用户确认通过（2026-10-21 03:29 UTC）。证据 = `.workbuddy/r22-71/run-20261021-030856/{report.md,report.json,export-child/}`。诚实边界：这是 package-layer 真实模型闭环，不是 Electron GUI；desktop「比较到导出固定选中侧」的界面实机仍归 7.2，且不把正常结束表述为“修复成功”。）
- [x] 7.2（2h）真实 1440/1360/1024/800px 与 200% 缩放、真键盘全链、长文本/错误/焦点和返回阅读；核对 overflow-hidden/min-h-0 高度链、详情独立滚动与底部同色，逐项检查 CRLF/LF、空串、末尾换行及新增/删除方向可辨；记录实测视口/缩放和原生目录选择方式。验收：desktop「真键盘完成实验比较导出闭环」及修改/草稿/比较恢复场景、workspace「文本新增删除与原换行可核对」；不能实机诱发的故障明确引用单元证据。
  （2026-10-21 ✅：三批实机共 **133 条机器判据全绿**；人工判据由用户确认通过（同日），口径如实记录：认可依据是三批判据全绿与抽查结论，**未逐项复核截图/实机** ⇒ 视觉可读性、字号是否偏小一类主观项仍属未细看，发行前实机验收另补。证据 `.workbuddy/r22-72/`；探针
  `apps/desktop/scripts/r22-72-geometry-cdp.cjs` + `r22-72-keyboard-cdp.cjs`，驱动 `run-all-720.cjs`，
  夹具 `r22-72-seed.cjs` + `seed.json`，读数 `*-measurements.json`，截图 `shots/` 16 张，
  gates `gates-<tag>.txt`）。
  ① **widths 59/59**：实测 CSS 视口 1442/1362/1024/801（外框 2033/1920/1034/810，DPR 2.1）逐档核对
  无横向溢出、`overflow-hidden`+`min-h-0` 高度链从锚点贯通到 `<main>`、详情列**独立滚动**（容器 scrollTop 变
  而窗口 scrollY/main/左列位置不变）、滚动区底部不露页面灰底、核对卡+副本授权+提交按钮逐档可滚可达、
  核对卡自身无横溢；比较文件视图两侧默认各取最近自有完成步骤、diff 面板→main 高度链达标、
  config.txt 原文逐字进 Monaco（CRLF 不被规范化）；全程 dev 数据目录逐文件指纹零变化。
  ② **zoom200 19/19**：DPR 4.2 真 zoom，MoveWindow 2600×1700 拉满后实测 CSS 923×582
  （zoom2 外框→CSS ≈÷2.82，故本档不打 ±2px 落点、只记相对几何）；窄档运行列表按显示决策收起且
  「打开运行列表」恢复入口在场；同款高度链/底部/独立滚动/diff 判据全绿。
  ③ **keyboard 55/55（真键盘全链）**：系统级 `keybd_event` + 真 OS 剪贴板走完
  根入口 ENTER → 长文本 Ctrl+A/Ctrl+V（324 字；剪贴板按 Windows 以 CRLF 落地，编辑器与草稿原样保留）→
  假设/人工判据逐字段粘贴 → 页签往返（正文与假设/判据逐字恢复，**费用确认与副本授权不恢复**）→
  真键盘只读核对（卡列根/初始文件/固定工具/基线模型参数/端点/上限/预算/历史未知/计费未知，副本授权默认未选）→
  **两种撤销形态分别实证**（改配置＝核对卡连同许可整体撤销；改输入＝stale 条 + 确认/授权复位，之后须重新核对）→
  SPACE 勾选授权 → ENTER 提交 → U4 登记只带身份与目标（不含 prompt 正文）→ 受控模型恰 6 次调用 →
  v3 实验记录的原值/新值/假设/判据逐字来自键盘输入 → 成功按模式 CAS 清草稿 + 导航意图落到子 run
  （`run_mvhsr8j6_ab0y`）→ 概览「本次干预」与结局说明只复述事实（不宣称修复成功、不评分）→
  与基线比较 → 文件视图 → **六条路径逐项核对**（config CRLF+新增行且插入/删除着色层与真实行变更在场、
  notes 仅差末尾换行判 different、summary 右侧空串按「文本=空」呈现、only-child 左 not_found 诚实标注、
  keep same、含 NUL 正文按真实字节呈现）→ 真键盘打开右侧文件后返回比较（pair/检查点/路径保留）→
  从比较视图**导出固定右侧 s_16**（原生目录框由 `REBASEAGENT_PICK_DIRECTORY_FILE` 控制文件接管恰 1 次，
  `dialog[open]` 数 0 自证未开框）→ 6 文件/76 B + `changes.patch` 逐文件 sha256/字节与清单复核 →
  真 Esc 收起确认卡且焦点回收到导出入口 → 再次返回比较仍在 → 数据不变式（仅新增本次子 run 与其 blob）。
  另在 GUI 实证 7.1 package-layer 根的**诚实拒绝**：录制预算 300000 > 桌面上限 100000 ⇒
  `config_unreconstructable` 且不给确认/授权/提交（因此桌面实验链夹具改按 `MAIN_EXECUTION_LIMITS` 造根）。
  限制与诚实边界：① 本批模型为本地受控服务（真实模型闭环见 7.1，本批不产生真实计费，
  「编辑前确认真实计费」的用量侧仍由 7.1 承载）；② 二进制/超限的逐侧状态桌面路径不可诱发
  （`write_file` 只接受字符串 ⇒ 必为合法 UTF-8），由 4.3 单元证据承载；③ 失败/缺附件/缺父/旧响应/
  未知操作注入归 7.3；④ 真键盘通道存在偶发不落地，harness 已改为「按到生效为止并记账按键次数」
  （本轮 55 条判据各激活键均一次生效）。）

- [x] 7.3（1.5h）实测失败/缺附件/缺父/未知操作/旧响应/配置变更路径，回填各层证据和限制；测试注入与真实故障分列。验收：prompt 前置拒绝场景、desktop「响应未知和模型失败只核对可信身份」「失败和旧结果不清除新草稿」「两侧检查点独立且迟到结果不串页」。
  （2026-10-21 ✅：Electron 实机 **8 个 tag 共 137 条机器判据全绿**（证据 `.workbuddy/r22-73/`：
   `gates-<组>.txt` + `<tag>-measurements.json` + `<tag>-probe.log` + `shots/`）。夹具
   `apps/desktop/scripts/r22-73-seed.cjs` + `seed.json`＝与 `MAIN_EXECUTION_LIMITS` 逐字段一致的隔离根
   `run_mvi2ckn3_xfxw46`（final `s_10`、首次 `llm.call` `s_02`、初始快照 5 个文件含 1 352 000 B 的 big.txt
   与唯一内容 fault.txt）+ v3 子 `run_mvi2ckpz_f5fy`（final `s_07`，同初始快照）。探针
   `r22-73-reject-cdp.cjs`（entry/attachment/parent/ipcguard）与 `r22-73-exec-cdp.cjs`
   （modelfail/reload/staledraft/latecompare），机制层 `lib/r22-73-harness.cjs`，驱动
   `.workbuddy/r22-73/run-all-730.cjs`。**零新增主进程注入钩子**：真实故障＝磁盘（同卷 rename / 追加字节，
   收尾逐字节还原并核 sha256）＋真实 HTTP（受控服务真返回 503、`delayMs` 造真在飞）；测试注入＝真 IPC 直调
   伪造形状/旧修订/旧指纹（不经 store，读未加工信封）。
   ① **entry 15**：隔离根入口与普通 prompt/A-B 分流；隔离父本的 A-B 显示"本期不支持"且真 IPC 在 main 侧同样被拒；
   隔离父本不能转普通 prompt fork；v3 分支入口只有「前往根运行」（无根编辑按钮）且经只读预检核实后落到根、
   零调用零子记录、不自动搬草稿；全局栏新建运行/设置旧入口仍可达；全程零写入。
   ② **attachment 16**（真实磁盘故障）：藏起初始快照内 fault.txt 的 blob ⇒ 核对如实给
   `attachment_missing`（"附件不存在：dc2d2e…"）并明说不能从当前源目录读取，费用确认/副本授权/提交整体不在场；
   带着健康时的计划真 IPC 提交给 `ISOLATED_PROMPT_ATTACHMENT_MISSING`，登记 settled 且 runIds 为空；
   逐字节还原后同一通道重新核对成功（对照，证明不是恒拒）；追加一字节的损坏给可区分的 `attachment_corrupt`
   （"清单记录 39 字节，实际 56 字节"），还原后应用未覆盖共享内容；全程零模型调用零子记录、指纹零漂移。
   ③ **parent 13**：隐藏父 trace ⇒ 子自有 8 个 spans 仍可读且 main 未加工读数给 `completeness=ownOnly` +
   `lineage=incomplete` + `missingRunId=根`；点「前往根运行」如实报"父链 run … 的 trace 文件不存在
   （不从当前目录或父最终状态补造）"、不换目标、不猜根；capability 对分支返回 unavailable 且**不给 rootId**；
   还原后同一入口恢复显式导航（对照）。
   ④ **ipcguard 30**（prompt 前置拒绝与旧许可）：合法根预检给 planFingerprint+configRevision 且零副作用；
   缺 `allowFileWrites`／`false`／伪造 model/dataDir/sourcePath／一次改两个字段／旧 epoch ⇒
   `INVALID_ARGUMENT`/`OPERATION_STALE_EPOCH` 且**受理前无登记**（operation 为 null）；
   空编辑（与原值逐字相同）⇒ `ISOLATED_PROMPT_EMPTY_EDIT`、非根作根 ⇒ `PARENT_NOT_ROOT`、
   旧配置修订 ⇒ `CONFIG_CHANGED`、旧计划指纹 ⇒ `PLAN_CHANGED`，四案都是**受理后拒绝**：有登记、runIds 为空、
   零调用零子记录；同 operationId 同参重发 ⇒ `OPERATION_DUPLICATED` 不重复执行（只新增一次执行的子 run
   `run_mvi6okvc_na5a`）；未知 operationId 的 reconcile 只读、不补身份；**迟到核对**实测在飞 16 ms 内推进修订 ⇒
   旧结论只以"需重新核对"的失效提示存在，卡/确认/授权/提交都不在场，重新核对后恢复。
   ⑤ **modelfail 16**（真实上游 503）：子 run `run_mvi67s4h_wwle` 如实落盘（meta → llm.call error
   status 503 → run.event errored/reason error），模型调用**恰一次**（不重试不自动重发）且只产一条子记录；
   登记 runIds = 落盘 meta.id = 信封 id 三方一致；草稿正文/假设/判据与修订原样保留（失败不清草稿）、
   提交关联仍按身份收口；界面按可信 ID 打开该失败 run 并读到自有轨迹，结局文字只复述"出错终止"类事实、不含"已修复"。
   ⑥ **reload 13**（响应未知）：提交后在飞（受控服务 9 s 延迟）做 `Page.reload` 并以哨兵自证换了文档 ⇒
   重载后按原身份读 main 登记：state=running、身份是真实 run ID 形状（不补占位/假 ID、不报取消），
   如实登记「身份已登记但 trace 尚未出现在盘」（span 在 endSpan 整行落盘的既有形态）；
   落定后登记 runIds 与盘上 meta.id 一致（`run_mvi683he_6508`）；只读 reconcile 不复活不重复执行（调用数不变）。
   ⑦ **staledraft 13**：在飞期间改正文被 store 按提交关联**拒绝写入**（修订不推进）、换编辑字段按钮 disabled、
   提交按钮转"提交处理中…"不可重复点 ⇒「提交后产生新修订而旧成功结果迟到」这一支在 GUI **没有前提**，
   按层引用 `fork-entry-closure` / `draft-closure-decision`；可实证的另一半全绿：实验记录用提交时冻结快照
   （不是迟到改动后的值）、正常收尾按匹配修订清理、迟到的正常结果**不抢**用户当前阅读目标
   （`run_mvi6kryt_civk` 落定后阅读仍在 `run_mvi2ckpz_f5fy`）。
   ⑧ **latecompare 21**：两侧默认各取最近自有完成步骤、路径并集 7 条；先量出 big.txt 正文读取真实在飞时长
   68 ms（loading 于 48 ms 采到），再切走→切回后打交错：切换发生在 55 ms < 68 ms ⇒ 旧响应必然迟到；
   落定后呈现的是新选择 notes.md（different，原文逐侧 8 B/28 B），大文件标记在新侧模型里**不出现**且无 loading 悬挂；
   只改左侧检查点右侧不被带动；藏起仅左侧存在的 summary.md 附件 ⇒ 左侧如实 `missing`、右侧仍由清单证明
   `not_found`（不当空侧）、结论 unavailable 且不生成伪 diff，还原后同一读点回到 `left_only`（对照）；
   交换两侧（store 动作，界面无入口已如实登记）后标题方向随 pair 对调；全程零调用零写入、指纹零漂移。
   限制与诚实边界：① 本批模型为本地受控服务（真实模型闭环与真实计费见 7.1）；② 二进制/超限逐侧状态仍不可诱发
   （`write_file` 只接受字符串、配额 8 MiB 与读取上限同值）⇒ 由 4.3 单元证据承载；③「篡改/丢弃 IPC 响应」类
   在 dev 无注入面（`window.api` 属性 non-writable/non-configurable，U4 已记）⇒ 由 §4/6.4 store 用例承载；
   ④ 7.2/7.3 的键盘与故障批共用 dev 数据目录：本批**最终绿跑**新增 4 条真实子 run（判重案 `run_mvi6okvc_na5a`、
   失败案 `run_mvi67s4h_wwle`、重载案 `run_mvi683he_6508`、迟到案 `run_mvi6kryt_civk`），
   迭代排障过程中另留有 4 条早期尝试的子 run（`run_mvi52ffh_xqjp`/`run_mvi5oas6_ae9o`/`run_mvi5ojmy_1cq2`/
   `run_mvi68jmn_q53w`）——全部只被各自 tag 的不变式按 id 放行，**没有任何既有 trace/blob 被改动**；
   ⑤ 机器 PASS ≠ 人工通过：人工判据已由用户确认通过（2026-10-21）。口径如实记录：认可依据＝**用户亲手做实机复现的「缺附件拒绝」一条**（现场翻转 blob → 界面给 attachment_missing 拒绝、费用确认/副本授权/提交整块不渲染、forking 仍 idle；留证 `.workbuddy/r22-73/live-repro-attachment.md` + `shots/r2273-live-attachment-missing.png`，还原后 sha256 逐字节一致）+ 其余各 tag 按 137 条判据全绿与核对表抽查认可；**未逐条走 12 项静态核对，也未亲手复现失败案/重载案**；视觉可读性/字号一类主观项仍未细看⇒ 发行前实机验收（路线图 §9.1 第 5 项）另补，本轮不以此代替。）
- [x] 7.4（1.5h）按 evidence-index 逐项审计全部新增与保留场景，运行定向回归及全仓 check:build/typecheck/test/lint/spec、change strict，记录命令/exit code/最终源码身份；失败先修再收口。验收：全部 delta 场景都有实际证据或诚实未通过标注，文档通过不计功能通过。
  （2026-10-22 ✅：evidence-index **76/76 场景与 5 份 delta spec 一一对应**（无多/少/改名），回填行 10–19、纠偏 41/42/52–54/56/58/71 的空口「实机 7.3」，行 25/27/36/40 补限制或改判；机器审计 `.workbuddy/r22-74/audit-evidence.cjs` 全绿（42 处引用文件存在、行 10–19 标题逐字命中、5 条「部分」均有限制、7.3 声明均有具体 tag/读数）。
  定向回归：replay 9 文件/122、trace-sdk 3/64、desktop 13/180 全过。新增执行证据 `isolated-prompt-run.test.ts`「空串/尾随空白编辑：正式请求逐字携带，不 trim、不合并其他字段」（replay 由 596→**597** 通过 +5 skip）。
  全仓门禁（详见 evidence-index「7.4 门禁与审计证据」）：build 5 包 ✓、desktop 双 tsc 0 ✓、trace-sdk 13/225、agent-loop 8/104、trace-test 10/78、llm-proxy 2/45、replay 46/597(+5 skip)、desktop **214 文件/3272 用例**（singleFork）全过、biome **713 文件 0 错**（临时移出仓库外 video symlink 与两个未跟踪 README 脚本；未改其内容）、spec **13 passed/0 failed**、change strict valid、`git diff --check` 0。
  🔴 本批修了 7.3 遗留的探针格式门禁：`r22-73-exec/reject/seed` 与 `lib/r22-73-harness` 经 biome 格式化，`exec` 两处无插值模板字面量改字符串；`node --check` 4/4、`verify-73.cjs` 回查全过（格式化不改行为）。
  限制：`pnpm check:build/typecheck/test` 的脚本壳会调用 PATH 上的 pnpm 11 并被版本检查拦住，故用同一 pnpm 9 直调等价的 filter 命令；完整命令与 exit code 见 evidence-index 7.4 节。人工判据仍以 7.1/7.2/7.3 的用户确认为准，7.4 不代替发行前人工验收。收口提交 `0ccdf3d`。）
- [ ] 7.5（1h）实施通过后同步用户文档/路线/项目状态的实际能力与版本边界，复核 scenario 合并无遗漏后再归档；发行另行核对。验收：方案、主 spec 与源码无漂移，未验证项目不称已交付，不把归档当发布。
