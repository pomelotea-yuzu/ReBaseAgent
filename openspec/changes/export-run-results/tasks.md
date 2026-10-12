# R2.1 实施任务

> 状态：2026-10-05 修订，所有实施任务待实施；evidence-index 已建立规划骨架，未登记功能通过。每项任务控制在 2 小时以内，超时先拆分；括号精确引用 delta 场景名，保留旧场景也需本轮回归证据。

## 1. 包层导出定位与契约

- [x] 1.1 复核 evidence-index 骨架与 delta 全场景映射；固定包层请求/结果、错误码、当前 trace/附件校验边界，不在包层新增父链检查或接受任意快照/物理附件字段。（对应：祖先、清单外路径和非法来源被拒绝；父文件缺失不否定包层自有快照）——29 行场景映射核齐（17 workspace-isolation + 12 desktop-ui）；契约落 `export-api.ts`（请求/失败码/失败形状），前五个失败码与 read-api 同码同义
- [x] 1.2 新增目标目录校验：存在、普通、为空，拒绝目标链接及与 dataDir 相同/互为祖先后代；按实际宿主规则预检物化路径，不静默改名。（对应：非空目标和取消选择不覆盖既有内容；目标排除数据目录及竞争写入）——`validateExportTargetDir`（lstat 拒链接、realpath 归一判关系、readdir 判空）+ `findExportMaterializationViolation`（宿主路径长度上限，拒绝而非改名）
- [x] 1.3 固定读取本次 run 初始/自有 step 的快照引用，禁止逐文件重新定位拼接不同清单；覆盖根、分支本地 step、失败/未封存 run 已落盘 step 和缺省 step。（对应：导出根 run 的初始检查点；导出本 run 自有完成步骤；父文件缺失不否定包层自有快照）——read-api 提取 `readWorkspaceRun`/`locateSnapshotInRun`；`resolveExportSnapshots` 单次读取同时返回选定快照与初始快照引用
- [x] 1.4 实现逐文件附件读取、长度/哈希复核和来源失败映射；任一附件缺失、损坏或真实 I/O 错误都终止整次导出，不回读 source 或祖先。（对应：附件缺失或损坏不生成伪完整导出）——`verifyExportAttachments`：missing/corrupt → `attachment_unavailable`（带 path），`WorkspaceBlobError(io)` → `io`；单测 23 例全绿（`workspace-export-api.test.ts`）

## 2. 文件物化与清理

- [x] 2.1 实现固定 files/ 文件树布局、排他文件创建及目标字节复核；覆盖同名元信息路径、零字节/二进制，不创建 symlink 或保留硬链接身份。（对应：二进制字节导出但不进入文本补丁；项目同名文件不覆盖导出元信息）——`export-materialize.ts`：`materializeExportFiles` 固定 `<target>/files/<逻辑路径>` 布局；目录逐级 `mkdir` 非递归、文件 `open(wx)` 全排他；写入刷盘后读回比对长度+SHA-256，全部完成再整树 `verifyAll`；同名元信息路径全部进 files/；空集合产生空 files/
- [x] 2.2 实现产物登记、清单最后完成和失败逆序清理，仅删除仍属于本次请求的文件及空目录；非递归删除、同目标竞争不碰其他请求产物。（对应：写入中失败只清理本次产物；目标排除数据目录及竞争写入）——`WorkspaceExportWriter` 按创建顺序登记每个目录/文件，失败逆序 `cleanup()`；文件删除前核对所有权（哈希不符=被替换→保留并报告），目录非递归 rmdir、非空即保留；竞争（`target_race`）不登记不清理获胜者产物。清单/补丁将走同一写入原语进同一账本，"清单最后完成"的完整接线与失败注入随 3.1/4.4b 验证
- [x] 2.3 补充清理不完整诊断/残留相对路径及中断边界；完整关闭清单和目标复核才可成功，中断后不自动回滚或补写。（对应：写入中失败只清理本次产物；中断残留不被当作成功结果）——清理报告 `removed/retained/complete`，retained 带残留相对路径与原因；半成品在失败点即时移除（失败并入诊断）；残留 `files/` 的目标按非空拒绝（复用 1.2 校验，单测钉死）；引擎无任何自动回滚/补写路径；"清单完整关闭才成功"随 3.1 清单写入落地。单测 12 例（普通 9 + 注入 3）全绿

## 3. 清单与文本补丁

- [x] 3.1 定义 format_version:1 清单 schema，固定 files_root/status 和 patch 三状态、覆盖/排除清单；注入时钟，保证除 created_at 外字段及排序确定；不写源路径、凭据或 messages。（对应：清单时间与不变量可独立核验；空快照与初始无变化可以导出）——`export-manifest.ts`：固定键序构造 + 2 空格缩进 + 末尾换行；files 按 UTF-16 码元序；`now` 可注入（`exportWorkspaceSnapshot` options）；单测钉死逐字节确定性与 created_at 排除比较
- [x] 3.2 实现补丁资格：可验证文本修改和清单证实的新增；binary/deletion 排除，基线附件不可用撤销整份补丁但不封禁完整选定文件导出。（对应：文本修改及新增有可证明的补丁；二进制和删除变化逐路径说明；初始附件不可用仅撤销补丁）——`computeExportPatch`：同哈希跳过（不读基线）、修改须基线附件复核、新增以初始合法清单证明不存在、missing/corrupt/io → baseline_* 且整份 not_available；e2e 证明文件导出仍完整
- [x] 3.3a 实现确定性 unified diff：三行上下文、a/b 文件头、新增 /dev/null、路径引用及末尾无换行；内容保留 LF/CRLF 和顺序，不新增依赖。（对应：文本修改及新增有可证明的补丁）——`export-diff.ts` 纯 TS LCS（后缀 DP + 固定平局回溯），控制行 LF、内容行逐字保留终止符、`\ No newline at end of file` 标准标记、git 风格路径引用（非安全字节八进制转义）
- [x] 3.3b 固定并测试补丁生成工作量上限，超限整份补丁不可用；实现补丁写入/哈希及无变化、全部排除状态。（对应：补丁超限保留完整文件导出；二进制和删除变化逐路径说明；空快照与初始无变化可以导出）——`DEFAULT_MAX_DIFF_CELLS = 1_000_000`（格子数 = (旧行数+1)×(新行数+1)，可注入测试）；超限 → not_available + reason 说明，文件导出不受影响；no_text_changes / 仅排除项 not_available / written+bytes+sha256 三态齐备
- [x] 3.4 清单六类状态固定为"未保留（原状态未知）"，不猜测历史；测试 files[].status 恒 exported、初始/选定 ID、自有 step 来源均正确。（对应：清单时间与不变量可独立核验；导出根 run 的初始检查点）——`UNPRESERVED_STATUSES` 六键固定文案与键序；e2e 验 source.run_id/step_span_id/snapshot_id/initial_snapshot_id 与 status=exported

## 3.X 收口：包层编排器

- [x] 3.5（并入 3.X 收口）`exportWorkspaceSnapshot`：定位（单次读取）→ 目标校验 → 附件复核 → 物化预检 → files/ 物化 → 补丁 → **清单最后写入** → 整树复核 → 成功；第 5 步起任何失败经同一写入会话逆序清理，前四步零写入返回空清理报告；成功返回 realpath 目标/files/ 文件数与字节（不含元信息）/补丁状态。端到端 10 例全绿（根初始/自有 step/空快照/同名元信息/基线缺失/超限/非空目标/附件失败/dataDir 指纹/祖先拒绝透传）

## 4. 包层测试与不变量

- [x] 4.1 增加根初始、分支/失败自有 step、空快照、无变化及重名项目文件 fixture；逐字节核对 files/，固定时钟比较完整清单并验证不同时间只排除 created_at 后比较。（对应：导出根 run 的初始检查点；导出本 run 自有完成步骤；空快照与初始无变化可以导出；项目同名文件不覆盖导出元信息；清单时间与不变量可独立核验）——`workspace-export-integration.test.ts`：helper 增 `outcome` 支持失败 run（errored/error 已落盘 step 可导出）；真实父链分支 run 自有 step files/ 逐字节核对 + 清单 source 四元组（initial_snapshot_id 由测试侧 `createWorkspaceSnapshot` 独立复算）；固定时钟完整清单**逐字节**复算（测试手拼期望文本，钉死键序/缩进/末尾换行，不由实现拼装）；不同动作时间仅排除 created_at 后逐字节一致；空快照/无变化/重名项目文件复用 3.X e2e 既有证据
- [x] 4.2 增加当前记录拒绝测试：普通无 workspace、祖先 step、非法 runId、额外快照/物理字段、损坏 trace；另验证缺父但自有快照可从包层导出。（对应：祖先、清单外路径和非法来源被拒绝；父文件缺失不否定包层自有快照）——编排层拒绝 no_workspace/invalid_request/run_not_found/trace_invalid 全部零写入+空清理报告；祖先 step（真实父链存在的 branch run）step_not_found 零写入；ghost 分支 run 自有 step 端到端导出成功；额外物理字段以 `@ts-expect-error` 编译期钉死（临时 strict tsconfig 验证指令确实消耗，非 unused），运行时严格 schema 归任务 5.1 IPC 层
- [x] 4.3a 增加选定附件缺失/损坏失败与二进制字节成功测试，证明不回读 source、目标/源/父/兄弟/trace/blob 不变量。（对应：附件缺失或损坏不生成伪完整导出；二进制字节导出但不进入文本补丁）——选定附件损坏（长度同内容异）→ attachment_unavailable 零残留（缺失已由 3.X e2e 承载）；外部 decoy 目录同名文件不可达（导出字节仍来自 blob）+ 导出前后 dataDir 全域指纹（父/兄弟/trace/blob）逐项一致；二进制字节导出 + excluded(binary) 复用既有 e2e
- [x] 4.3b 增加修改/新增/删除、CRLF/LF、末尾无换行、路径引用、初始附件不可用和超限 fixture，核对 patch 三状态/覆盖范围及文件导出仍完整。（对应：文本修改及新增有可证明的补丁；二进制和删除变化逐路径说明；初始附件不可用仅撤销补丁；补丁超限保留完整文件导出）——综合 fixture：CRLF 修改内容行逐字保留 `\r\n`、末尾无换行 del/add 双侧标准标记、带空格路径新增 `/dev/null` + git 引用（`quoteDiffPath` 比对）逐段核对；deletion-only → not_available + deletion 逐路径 + 文件导出完整；baseline_corrupt（字节篡改）/baseline_io（blob 位换目录）→ 整份 not_available、文件 4 条完整；超限复用 3.X e2e
- [x] 4.4a 测非空目标、目标链接/dataDir 关系、写入后未知新增条目和同目标并发竞争，证明零覆盖、零删除他人内容。（对应：非空目标和取消选择不覆盖既有内容；目标排除数据目录及竞争写入；写入中失败只清理本次产物）——dataDir 相同/内部经编排层 target_conflicts_data_dir 零写入；同目标 `Promise.all` 并发恰一个成功、败者 target_race（或串行完成时 target_invalid）零清理不碰胜者产物、胜者三件套完整逐字节核对；目标链接/非空/dataDir 关系单元级已在 1.2 覆盖；未知条目不删由 2.2/2.3 注入用例承载
- [x] 4.4b 注入文件/补丁/清单写失败及清理失败；模拟子进程中断，验证未完整结果、残留非空拒绝及无重启自动补写/清理。（对应：写入中失败只清理本次产物；中断残留不被当作成功结果）——`workspace-export-snapshot-injection.test.ts`（编排层 mock fs/promises，open 序号=文件/补丁/清单）：补丁写失败→逆序清理回空；清单写失败→补丁+文件树一并回收（无清单≠成功）；清单半成品移除失败（unlink EPERM）→原始失败保留+retained 报告+其余产物回收；残留非空拒绝承载中断契约面（引擎零自动补写/清理路径），真实进程中断实机归 7.1b。⚠️ 环境限制：全量串行下三个重 fixture export 文件 beforeAll 偶发 10s 钩子超时（假红），单文件复跑全绿——按既有「先单包复跑」纪律排除

## 5. Desktop IPC 与 main 编排

- [x] 5.1 注册 workspaces:export 的严格请求/结果 schema，只接 runId/stepSpanId 并拒绝额外物理路径键；更新封闭 preload 白名单。（对应：来源不完整时禁用或拒绝导出）——`channels.ts` 增 `exportCheckpoint: "workspaces:export"`；`shared/ipc.ts` 增 `WorkspaceExportRequestSchema`（`.strict()`，额外 dataDir/source/blob/targetDir 键一律拒绝）、`WorkspaceExportOutcomeSchema`（canceled/exported/failed 三态判别式，patch 三态与六类未保留状态钉死）、`WorkspaceExportPatchSchema`；preload 增 `exportCheckpoint` 透传，`preload-surface.test.ts` 封闭白名单同步（唯一显式写通道注释钉明：目标路径入口只在 main 对话框）
- [x] 5.2a main 接原生目录选择/取消及目录返回后的 readRunLineage 重验，映射既有来源错误码为导出语境，不改变 checkRunSource 的执行语义。（对应：目标目录非空或取消选择；来源不完整时禁用或拒绝导出）——`workspace-export-endpoint.ts`：对话框**前**早期来源检查（不完整直接拒绝，不弹对话框省用户白选）+ 目录返回后、一切写入前**再验**（`readRunLineage` 单次读取上下文）；ownOnly→`RUN_LINEAGE_INCOMPLETE`、其余读取失败→`RUN_DETAIL_UNREADABLE`，文案为导出语境受控中文，不复用/不修改 `checkRunSource`
- [x] 5.2b main 接包层导出与独立在飞保护，renderer 重载不解除；不登记 operation、不占/释放执行槽、不消费授权，不自动重发未知写入。（对应：导出成功不改变主动执行边界；导出请求迟到或重载不重发写入）——main 会话闭包 `exportInFlight` test-and-set（renderer 重载不解除），在飞重复请求立即 `WORKSPACE_EXPORT_IN_FLIGHT` 拒绝且不开第二个对话框；端点 deps **不含** OperationRegistry（零 operation 由构造保证）、不触碰 sourceToken/执行槽；canceled/exported/failed 全部 finally 释放
- [x] 5.3 为提交 run/step/请求代次保存导出反馈，旧成功/失败/finally 不覆盖新对象，切页不中止 main 写入，返回定位反馈而不抢焦点。（对应：导出失败后恢复阅读；导出请求迟到或重载不重发写入）——`lib/workspace-export-state.ts`（键=run+step 哨兵、反馈四态、outcome 折叠）+ store `workspaceExports`/`workspaceExportGenerations` + `exportCheckpoint` 动作：代次单调递增，响应回来代次不符整包丢弃返回 null（A→B→A、连续重试都不回退）；无任何取消通道（切页不中止 main 写入，迟到响应仍按 key 落库）；信封失败与 schema 不合法折成受控 failed；重载后状态为空=结果未知，无重发入口（构造保证）；`workspace-export-state.test.ts` 9 例（含迟到丢弃、不同 key 独立、in-flight 可见、形状非法）。⚠️ 台账更正：5.3 行曾在 5.1/5.2 提交（0a42af9）时被误删，本轮补回——任务实施于本提交
- [x] 5.4 IPC 集成测试覆盖恶意额外字段、ownOnly 及目录对话框期间父链变化、目录取消、同 main 在飞重复/重载、零 operation 与数据指纹。（对应：来源不完整时禁用或拒绝导出；目标目录非空或取消选择；导出成功不改变主动执行边界；导出请求迟到或重载不重发写入）——main 侧 `workspace-export-endpoint.test.ts` 11 例（恶意额外字段/形状非法零副作用、ownOnly 与损坏 trace 早期拒绝对话框未开、no_workspace 经包层拒绝、目录取消零写入、对话框期间祖先被删→RUN_LINEAGE_INCOMPLETE、成功导出 outcome 过严格 schema+dataDir 指纹、在飞重复/槽位释放、失败透传 retained、兜底收敛）+ renderer 侧 `workspace-export-state.test.ts` 9 例（迟到丢弃/无 cancel·abort 入口/零 operation 构造保证）；⚠️ 重载后 UI 显示"结果未知"的实机呈现归 6.2/6.3

## 6. 文件工作区 UI

- [x] 6.1 文件页增导出入口与确认（检查点/空目录/files/ 布局/未保留状态），资格仅取检查点/来源，不依赖 Monaco、选中文件、二进制或 diff；提交仍复验。（对应：从文件页导出成功；来源不完整时禁用或拒绝导出；无文本差异和二进制不封禁检查点导出；不可比较或未就绪时工具诚实禁用）——`WorkspaceExportPanel.tsx`（流内确认卡，不用全局 ConfirmDialog——那是破坏性放弃确认专用单例）：入口资格 = 清单已核实 && unavailableCount===0（inspect 加载中/附件失败各自禁用并说明），与 Monaco/选中文件/diff 零耦合；确认卡列明检查点名/空目录要求/files/+清单+补丁布局/六类未保留/源目录零改动；「选择目标目录并导出」才调 store.exportCheckpoint；切换检查点自动收起确认卡（确认对象绑定检查点）；`workspace-export-panel.test.tsx` 资格/确认/无路径输入断言
- [x] 6.2 增加成功反馈：目标目录/files/、文件数/字节数、补丁三状态和覆盖/排除原因；文件成功与补丁不可用分开，不称测试通过或已应用。（对应：从文件页导出成功；补丁不可用不隐去成功文件导出）——exported 反馈渲染目标/filesRoot/fileCount/totalFileBytes + 补丁三态逐路径（written 列 covered+excluded、not_available 列 reason+excluded 且明说「文件导出不受影响」、no_text_changes 明说未生成）+ 未保留六类 + 「不表示项目可构建、测试通过或已应用」；结构断言钉死
- [x] 6.3 增加取消、非空、来源失败、附件失败和清理失败反馈，保留当前 run/step/path/滚动/草稿；失败不抢焦点、不自动切运行。（对应：目标目录非空或取消选择；导出失败后恢复阅读）——failed/canceled/in-flight 三态反馈（稳定码+reason+retained 残留清单「请勿直接使用」警示；取消明说零写入；在飞说明切页不中止、重载后以目标清单为准）；反馈全部流内渲染不抢焦点、不触发导航；阅读状态（5.3 会话状态）不因导出改写；实机呈现归 7.1b
- [x] 6.4 接入 800px/窄窗、200% 缩放、Tab/Shift+Tab/Enter/Esc 和键盘焦点回收；确保导出状态不会遮挡正文或文件选择器。（对应：文件阅读键盘操作与离线加载）——入口/确认卡/反馈全部流内渲染（结构断言禁 fixed/absolute/sticky 浮层）；Esc 收起确认卡并把焦点回收至入口按钮；按钮 focus-visible ring + aria-expanded；Tab 顺序自然（流内按钮）；真键盘/200% 缩放实机归 7.1b
- [x] 6.5 回归完整原文/元信息复制、查找/换行/差异定位、不可比较/未就绪禁用；保证新导出控件不改变原 Monaco 工具资格。（对应：复制路径原文及元信息；查找换行和差异定位使用当前文件；不可比较或未就绪时工具诚实禁用）——回归全绿：workspace-file-view 26、workspace-files 30、file-tools 12、file-layout 16、file-view-scroll-wiring 16；导出面板为独立区块（不进工具栏、不接收 Monaco/工具资格状态），「资格与 diff 无关」结构断言钉死；不传 exportPanel 时面板零渲染（旧场景零改动）

## 7. 集成验收与收口

- [x] 7.1a Electron 验收初始/自有 step、同名项目、空快照/无变化/二进制导出及清单/补丁反馈，记录 files/ 字节与各数据目录指纹。（对应：从文件页导出成功；无文本差异和二进制不封禁检查点导出；补丁不可用不隐去成功文件导出）——`.workbuddy/export-e2e/probe-71a.cjs` **23/23 全绿（CDP 9612 实机，dev-only pick 控制文件钩子注入目录选择）**：A 段 root 自有 step（入口资格/确认卡/接管计数/exported 反馈六要素/target-1 三件套+files/ 逐字节含二进制/清单 source+written+covered/dataDir 全域指纹不变）、B 段初始（切换收起确认卡+旧反馈不显示、no_text_changes、step_span_id=null）、C 段同名项目文件（进 files/、根部命名空间分离）、D 段空快照、E 段 ownOnly（RUN_LINEAGE_INCOMPLETE 且对话框未开）、F 段取消（canceled 零写入文案）、G 段非空目录（target_invalid+既有内容不变）。**实机逼出并修复两个缺陷**（commit 9ae1be0）：① main handler 漏包 IPC 信封（renderer envelope.ok undefined → 读 error.code 抛 TypeError → 反馈永久卡 in-flight；端点直测测不出信封层，新增 workspaceExportEnvelope 独立可测 + 测试）；② 切换检查点未收起确认卡（补 effect）
- [x] 7.1b Electron 验收真实对话框取消/非空目录、来源/写入失败、阅读位置及真键盘/窄窗/200%/复制查找回归；不可诱发分支单列，不以历史报告代替接线。（对应：目标目录非空或取消选择；来源不完整时禁用或拒绝导出；导出失败后恢复阅读；文件阅读键盘操作与离线加载；复制路径原文及元信息；查找换行和差异定位使用当前文件；不可比较或未就绪时工具诚实禁用）——`probe-71b-keyboard.cjs`：真键盘（keybd_event 系统级 u3-65-input.ps1）**ENTER 展开确认卡、ESC 收起+焦点回收入口**实机通过；真 OS 对话框人工交互/窄窗真改窗的 Tab 序列校准/200% 缩放（需 REBASEAGENT_ZOOM_FACTOR 重启）余项单列（探针 measurements notes 记录）；复制/查找/diff 定位回归由 6.5 全绿与既有 U2/U5 实机矩阵承载；取消/非空/来源拒绝已由 7.1a F/G/E 段实机覆盖
- [x] 7.2 回归普通/隔离 run、比较、主动操作在飞/草稿、切页/重载/设置，证明导出不改槽/授权/配置/导航，旧反馈不覆盖新对象、不自动重发。（对应：导出成功不改变主动执行边界；导出请求迟到或重载不重发写入）——实机 probe-71a H 段：H1 零 operation（导出后 operations 登记=0）、H2 切页（概览↔文件）返回后反馈仍按提交目标显示且不抢焦点；dataDir 指纹（traces+blobs）全域不变（A9）；单元层：迟到响应代次丢弃/无 cancel·abort 入口/无重发构造保证（workspace-export-state 9 例）+ 零 operation 构造保证（endpoint deps 无 registry）；既有回归全绿（store 59、compare 系、workspace 系）
- [x] 7.3 执行受影响包测试、desktop build/typecheck、Biome、git diff --check 和 OpenSpec strict；补齐 scenario → 测试/fixture/实机证据索引，记录所有环境限制。（对应：本 delta 全部场景）——desktop **201 文件/3123 用例全绿**（singleFork `--poolOptions.forks.singleFork`，build 后跑，exit 0/0 Errors；⚠️ vitest 2.1.9 CLI 不认裸 `--singleFork`）；replay 全量 403 passed + 4 个已知时序假红（export 三件套 beforeAll 10s 钩子超时 + workspace-world 慢测试）单包复跑全绿（23/10/19/17）按「先单包复跑」纪律排除；tsc 双 0；biome 639 文件 0 错；diff --check 0；strict 13/13。全量唯一真实回归（file-two-side-read「无写入通道」白名单）已修：白名单纳入 exportCheckpoint（受控写通道已验收）。evidence-index 全场景回填完毕
- [x] 7.4 复核 proposal/design/spec/tasks 与实现边界一致，确认无自动应用、合并、R3 测试、外部适配或新依赖；实施完成后再决定是否归档，不自动发布。（对应：本 delta 全部场景）——依赖零变更（e1a5611..HEAD 仅 desktop package.json 版本号 rc.1→rc.2，pnpm-lock 无 diff）；无 apply/merge/回写源目录路径（file-two-side-read 写通道白名单 + 面板「不表示已应用」结构断言）；不改 JSONL/blob/trace 版本（7.1a dataDir 指纹实机核对）；strict 13/13 与 delta 场景全映射（evidence-index 1–29 逐行回填）。**归档决定留给用户**
