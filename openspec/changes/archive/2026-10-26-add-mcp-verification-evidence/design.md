# MCP2：只读验证证据设计

## Context

R3 已保存 `verifications/<id>.jsonl`、`verification-assets/sha256/<hash>`、`verification-environments/<id>.jsonl`。reader 提供 list/get/readLog，桌面按验证/命令/流定位日志，比较在 renderer 的 `lib/verification-compare.ts`。

现有缺口：包主入口同时导出执行器；列表异常会静默跳过；readLog 字节切片后解码可能切断 UTF-8；MCP1 readVersion 主要覆盖 traces；桌面比较的命令/环境行以展示字符串判等（argv join、toolchain/limits/security 格式化拼接），桌面 readLog 以首条 command_end 定位附件，重复命令或参数边界相同时会掩盖差异。必须处理这些缺口才能复用。

## Decisions

### D1. 共享与依赖闭包

新增 `@rebaseagent/project-verification/read` 和 `/facts`。read 只导出记录/准备记录/附件读取、受控错误和必要类型；facts 只依赖纯数据。不得直接或经 barrel 导入 writer、assets 发布、prepare、materialize、execute、orchestrate、runtime、docker 或受信环境生成资产。mcp-server 依赖 read/facts 和既有 run-query；desktop 也接同一事实实现。

共享记录枚举/投影、附件定位/校验、UTF-8 视图、比较条件，不搬 IPC 信封/CHANNELS/operation/store/SDK。保留旧主入口、readLog 字节接口和桌面 IPC schema；新增读取接口复用同一哈希/IO 实现。闭包测试须证明导入不触达执行/写入模块。需要改记录格式、执行授权或后端时先修订 proposal 拆分。

### D2. 六个工具

对象 strict。验证 ID 沿 R3 `^[a-z0-9][a-z0-9_-]{0,63}$`；run/span/path 沿 MCP1。条目默认 20/最大 100，正文默认 4096/最大 8192 Unicode 码点，实际信封预算可进一步缩小。

| 工具 | 输入 | 返回范围 |
|---|---|---|
| `list_verifications` | `{runId?,status?,outcome?,cursor?,limit?}` | 精确 run 筛选的摘要与独立读取失败项；status 为 R3 四状态，outcome 为 R3 十一值；不含正文 |
| `get_verification` | `{verificationId,cursor?,limit?}` | 目标/状态/历史环境/实际命令/终止事实及分页事件索引；不默认返回日志、产物正文或完整原始事件 |
| `read_verification_log` | `{verificationId,commandId,stream,cursor?,maxChars?}` | commandId=typecheck/test，stream=stdout/stderr；从该记录唯一 command_end 定位附件，不接 hash/裸 offset |
| `inspect_verification_artifacts` | `{verificationId,cursor?,limit?}` | 产物清单/排除规则/字节数和逐项附件可用性，未采集与合法空清单分开 |
| `read_verification_artifact` | `{verificationId,path,cursor?,maxChars?}` | path 必须在该验证产物清单中；核验整体后读 UTF-8，二进制只给元数据 |
| `compare_verifications` | `{left:{verificationId},right:{verificationId}}` | 两个不同验证，固定同序；逐侧事实、比较条件、受限结论及回查引用，无默认正文 |

MCP1 七工具不变，完整 tools/list 共十三个。未完成工具不登记；无 resources/prompts 旁路和准备/执行/停止/导出接口。

列表 createdAt 倒序，verificationId UTF-16 升序解同刻；无可信时间置后，失败项末尾按安全文件标识排序。筛选只作用可判定摘要，坏/未知版本/不可读项仍保留，每项占分页额度且只出现一次。新增 scan 返回完整失败信息，旧 list 包装保持兼容。验证目录不存在是空列表，存在但不可读或对象异常不能当空。

### D3. 状态、来源与错误

沿用 `rebaseagent.query.v1` 信封、observedAt/readVersion。provenance 增加可选 verifications 引用：verificationId、recordVersion/status、runId/checkpoint/snapshotId、commandId、stream/path/hash、preparationId。运行可读时保留原 runs/refs；验证独立存在时 runs 可空，不合成 Agent run/span 或模型消耗。MCP1 原响应不变。

get 白名单包含记录头目标/profile/manifest/command/planBindingDigest/createdAt/environment；实际 executable、有序 argv、容器 cwd、UTC 起止、durationMs、exit/signal、流元数据；阶段/停止/中断的索引与安全计数；封存终止事实。长 detail/reason 给有界预览、原长度与截断标记。epoch、operationId、容器名称/ID、运行时登记不外发，verificationId 定位实际执行。

只有 status=sealed 暴露可信 terminated/outcome；unterminated 不证明仍运行；corrupt/unsupported_version 返回诊断和可验证记录头，terminated/outcome=null。坏尾/重复终止/终止后事件不得裁尾出成功。附件正文仅允许完整合法记录或未封存记录内已验证完整事件；坏记录不可读正文。

R3 outcome 原样保留：check_failed/passed/environment_failed/start_failed/process_failed/timed_out/output_limit/cancelled/artifact_invalid/evidence_incomplete/unknown。无记录、未封存、interrupted 不是新 outcome。exit=null、未记录、0、非零分开；缺证据不升级 passed。

| 域 | 契约 |
|---|---|
| 工具失败，isError=true | 新增 VERIFICATION_NOT_FOUND、VERIFICATION_UNREADABLE、VERIFICATION_RECORD_INVALID（带 recordStatus）、VERIFICATION_LOG_NOT_RECORDED、VERIFICATION_ARTIFACT_NOT_FOUND、VERIFICATION_ARTIFACTS_NOT_RECORDED、VERIFICATION_ASSET_MISSING、VERIFICATION_ASSET_CORRUPT、VERIFICATION_PATH_REJECTED；复用 INVALID_ARGUMENT/STORAGE_IO/STALE_CURSOR/RESPONSE_LIMIT |
| 成功 limitation | VERIFICATION_UNTERMINATED、VERIFICATION_SOURCE_MISSING、VERIFICATION_SOURCE_INVALID、VERIFICATION_SNAPSHOT_MISMATCH、VERIFICATION_ENVIRONMENT_UNKNOWN、VERIFICATION_CAPTURE_TRUNCATED、VERIFICATION_PREPARATION_UNAVAILABLE，及原 REDACTED |
| 数据状态 | 记录四状态；产物附件 available/missing/corrupt/rejected；正文 text/binary；比较侧 ready/unavailable |

get 的坏记录是成功诊断，读其正文则 RECORD_INVALID；list 逐项读取失败不吞异常，整个目录枚举失败给 STORAGE_IO。权限错误不等于缺失：单条记录文件级不可读（含权限）给 VERIFICATION_UNREADABLE，目录级枚举或其他 IO 失败给 STORAGE_IO，两域不得互串。原 reader.error.reason/Error.message/堆栈不能外发。

### D4. 数据根与附件

沿用显式已有 dataDir/traces 启动规则，不建目录。验证目录/记录/准备记录/附件均检查真实路径和普通文件，拒绝 symlink/junction/reparse point、目录替身、穿越、ADS/盘符/UNC/设备路径。记录内 runId/stepSpanId/preparationId/path/hash 校验后才构造读取目标，非空 string 不代表合法路径。请求不能传 dataDir/物理路径/URL/hash/环境/handler。

附件只能由该验证 command_end/artifacts 解析，重复或错配 commandId、重复 path/冲突清单拒绝，不取第一项掩盖歧义。先核验完整大小/SHA-256，再返回内容。清单按 path UTF-16 升序；产物不转作输入快照。准备信息只沿历史 preparationId 关联，不选“最新准备记录”，缺失不抹除记录已有 environment。

sourceStatus=present 仅证明 trace 在场，另经 run-query/replay 核对来源和自有检查点，区分 recordedTarget/sourceStatus/sourceIntegrity。snapshot 与记录不符标漂移，原验证/独立附件仍可查。回查引用提供原工具 selector 和 expectedSnapshotId，调用后核对；不修改原工具入参，不切点或用当前源目录补齐。

不读 SettingsStore/key/verification-runtime，不连接 Docker、不 health probe/reconcile，不清理或修复数据。数据根整体迁移仍用相对内容引用。

### D5. 日志与正文

三层事实分开：capture.retainedBytes/observedBytes/truncated 来自 command_end 的 byteLength/totalBytes/truncated；fullAsset.bytes/sha256 描述保留的完整核验附件；range/truncated/nextCursor 描述本响应片段。读完 retained 不消除执行时丢弃，零字节已记录日志与缺 command_end/流不同。

共享读取面严格解码完整 UTF-8 后按码点切片，保留 CRLF/空串/尾随换行，不按字节段分别解码。非法 UTF-8/二进制仅返回 binary/bytes/hash，不输出替换字符/base64。旧桌面 offset/maxLength 字节接口保持默认 32 KiB/最大 64 KiB，MCP maxChars 为码点，不能混用。

正文只在 content 承载一次，structuredContent 为 bodyIn 指针和小事实；content 自足，可引用目标、命令、状态、哈希和片段。日志/文件原文不做通用秘密替换，完整资产 hash 不冒充片段哈希。元数据白名单/已知结构凭据过滤沿 MCP1；argv/detail 和自由文本仍可能含秘密。容器 executable/cwd 是执行事实，宿主路径/endpoint/堆栈不外发。指南明确客户端外发、费用和历史内容不可信。

### D6. 预算、版本和生命周期

完整工具结果 UTF-8 JSON（content/structuredContent/isError）最多 64 KiB。页/正文按预算缩小并准确更新范围；最小单项仍超限给 RESPONSE_LIMIT，不删身份假称完整。比较元数据超限受控失败。

验证 readVersion 加入候选集合/记录、参与准备记录、来源 trace/检查点附件和验证附件的存在/类型/size/mtime 台账，不能只用 traces 台账。每请求重新核对；读中来源变化给 STALE_CURSOR，不发布混合事实。不承诺目录事务或识别保留 size/mtime 的恶意本机改写。

复用 HMAC 游标，绑定工具、除 cursor 外规范参数、版本/模式/位置；日志额外绑定验证/命令/流/hash，产物绑定验证/path/hash。异参/篡改给 INVALID_ARGUMENT；来源变化、附件删除/替换、进程重启给 STALE_CURSOR。仅有进展且有剩余才发新游标。

EOF/取消只结束查询，不停止验证、清理资源或建立执行 registry。重连新上下文，旧游标失效。执行中只读固定时点已落盘完整事件，无实时订阅。

### D7. 比较判据

提取现有纯事实条件：profileId、manifestVersion、planBindingDigest、commandId、executable、有序 argv、cwd、platform、imageDigest、toolchain、limits、security，逐项 same/different/unknown。argv 比数组，对象比规范值，不比较 join/本地化展示字符串。当前 renderer 的 command 行用 argv join、toolchain/limits/security 行用格式化展示串判等（见 Context 缺口），提取共享判据时一并修正；V02 的「交互不变」指 UI 交互，判据升级属于预期内变化，桌面展示随共享判据收紧。preparationId/verificationId/runId/snapshotId/耗时是身份或结果，不要求相等。

当前 writer 的 planBindingDigest 来自准备计划 token，锚定计划×策略×配方；仅返回原值及语义，不用当前 manifest 展开未保存的测试/runner/锁文件明细。缺 environment 就是 unknown。

结论顺序：非封存/不可读→outcome-unknown；任侧证据不完整→evidence-incomplete；条件不同→conditions-differ；缺项→conditions-unknown；全部 same 且左 check_failed/右 passed→failed-to-passed；其余 same-conditions-other-outcome。查询时另核验必需日志/已发布产物可用性，缺失阻止可核查失败到通过结论，但不重写历史 outcome。evidence-incomplete 有两个触发来源：记录封存时的 evidenceComplete 缺项，与查询时当前必需资产（日志/已发布产物）缺失；实施时都查，均不改写已录 outcome。

干预只来自 run-query 已录制 fork。坏侧保留原 verificationId/unavailable，另一侧仍可查。返回精确输入检查点、expectedSnapshotId、日志和产物回查定位，按需串用现有运行/文件比较，不自动选最新分支、按序号对齐或判根因。来源缺失/漂移仍可展示记录内条件，但不能称已核验修复分支或代码因果。

### D8. 验收与发行

领域、真实 Node stdio、桌面一致性、选定真实客户端四层分开留证。优先沿用 WorkBuddy，记录本轮实际版本，不继承旧验收。使用 R3 保留的真实失败/通过记录时标明来源/模板范围，不能把 fixture 或 SDK 探针称作真实客户端/真实项目。确需新执行时另走已有授权，不由查询触发。

生产 deploy 闭包、发行组装工具发现断言回归，实际打包上传另行安排。文档分别标注实施/验收/发行，未通过项留在 evidence-index。

## Risks / Trade-offs

完整哈希/严格解码可能读取整个资产，响应上限不等于读盘预算；实测大资产耗时/内存，不引入持久索引。历史环境明细以实际记录粒度为限，不能补造。共享提取保留桌面展示，独立抽查真实桌面。自由文本不保证去密。

## Migration / Rollback

无格式升级或数据迁移；旧导出兼容。回退新增工具/依赖/接线即可，不改历史记录或附件。设计不成立先修订 proposal 再实施。
