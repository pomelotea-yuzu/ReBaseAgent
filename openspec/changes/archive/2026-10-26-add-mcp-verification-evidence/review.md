# MCP2「只读验证证据查询」提案审阅

日期：2026-10-25。审阅人：Trae 审阅会话。审阅对象为工作区未提交状态（change 目录 untracked，源码核对基线 `87ac111`，即当前 HEAD——R3 归档提交）。性质：提案与规格审阅，不含功能实现审查（功能尚未实施，evidence-index 26 个场景全部为待验证）。

## 结论

**合规，通过；有一处契约级问题需修订（已当场修订，见文末）。** OpenSpec 严格校验通过，`check-spec.mjs` 全仓 16 passed / 0 failed，config.yaml 三条 proposal rules 与两条 tasks rules 全部满足。proposal、design、2 份 delta、tasks、evidence-index 内部一致，design Context 的源码事实声明逐条属实（逐条对照代码，含 R3 reader/schema、MCP1 信封/游标/预算、桌面比较与 readLog 端点）。发现 1 项契约级问题（MODIFIED requirement 标题与正文数量矛盾）与 3 项低优先级观察项、3 项实现期提醒。

## 合规核对（对照 openspec/config.yaml rules）

| 规则 | 结论 | 依据 |
|---|---|---|
| proposal 必须含 Non-goals | 满足 | 明确排除 MCP3 执行接口、自动修复/导出/CI、扩大 R3 范围、持久索引/网络服务、本次实现代码/打包发布等 |
| 涉及时间旅行/replay 能力须声明保真度边界 | 满足 | 「保真度边界」写明不续跑模型消息、输入固定为记录的 run/自有快照、回查不符则报告、R1/R3 既有语义不扩大 |
| 不引入技术栈外新依赖须显式说明理由 | 满足 | 「沿用 TypeScript、zod、官方 MCP SDK 和 Node 内置库，只增加工作区依赖，不新增第三方 npm 依赖」——`@rebaseagent/project-verification` 为既有工作区包 |
| 任务粒度 ≤2h | 满足 | 26 项任务全部 ≤2h（1h/1.5h/2h），并自留「发现契约不成立先修订 proposal/design/spec」条款 |
| 每个实现任务对应 spec scenario | 满足 | 26 个场景（原 2 + M01–M20 + V01–V04）全部有任务映射；1.3 的「M04–M07、M17、M19」为区间/证据准备写法，与上轮 MCP1 tasks 1.3 先例一致 |

## 已验证事实

### 源码核对（design.md Context 声明逐条属实）

| 声明 | 核对结果 |
|---|---|
| R3 已保存 `verifications/<id>.jsonl`、`verification-assets/sha256/<hash>`、`verification-environments/<id>.jsonl` | 属实，[layout.ts](file:///d:/ReBaseAgent/packages/project-verification/src/records/layout.ts) 定义三目录与 `assetPath`/`requireRecordId` |
| reader 提供 list/get/readLog | 属实，[reader.ts](file:///d:/ReBaseAgent/packages/project-verification/src/records/reader.ts) 提供 `listVerifications`/`getVerification`/`readLog`/`getPreparation`/`readLatestPreparedPreparation` |
| 包主入口同时导出执行器 | 属实，[index.ts](file:///d:/ReBaseAgent/packages/project-verification/src/index.ts) 混合导出 reader/writer/prepare/execute/orchestrate/runtime/docker——D1 拆 read/facts 子入口的前提成立 |
| 列表异常会静默跳过 | 属实，`listVerifications`/`listPreparations` 对单条 `getVerification` 抛错 `catch` 后跳过（reader.ts L218-220/L418-420）——D2「新增 scan 返回完整失败信息」针对的缺口属实 |
| readLog 字节切片后解码可能切断 UTF-8 | 属实，`bytes.subarray(start,end).toString("utf8")`（reader.ts L270）按字节切再解码，多字节字符可被截断——D5「严格解码完整 UTF-8 后按码点切片」针对的缺口属实 |
| MCP1 readVersion 主要覆盖 traces | 属实，[read-version.ts](file:///d:/ReBaseAgent/packages/mcp-server/src/query/read-version.ts) 以 `repository.traceFileLedger()` + `extra` 构成台账；D6 扩展验证附件/准备记录台账走既有 `extra` 机制可行 |
| 桌面按验证/命令/流定位日志 | 属实，[verification-read-endpoints.ts](file:///d:/ReBaseAgent/apps/desktop/src/main/verification-read-endpoints.ts) `verificationReadLog` 从记录内 command_end 解析 sha256，renderer 不传哈希——D2「从该记录唯一 command_end 定位附件」与桌面同构 |
| 比较在 renderer 的 `lib/verification-compare.ts` | 属实，条件字段清单（profileId/manifestVersion/planBindingDigest/commandId/executable+argv/cwd/platform/imageDigest/toolchain/limits/security）与 D7 逐项一致 |
| command_end 双口径 | 属实，[schema.ts](file:///d:/ReBaseAgent/packages/project-verification/src/schema.ts) `stdout/stderr` 含 `byteLength`/`totalBytes`/`sha256`/`truncated`（保留 vs 观测），与 D5 三层事实对应 |
| 验证记录四状态 + 十一 outcome | 属实，`VerificationRecordStatus`（sealed/unterminated/corrupt/unsupported_version）与 `VerificationOutcomeSchema` 十一值逐字一致 |
| planBindingDigest 来自准备计划 token | 属实，orchestrate/run.ts L270 `planBindingDigest: input.planToken`——D7「锚定计划×策略×配方、不展开明细」与 writer 事实一致 |
| 验证 ID 沿 R3 `^[a-z0-9][a-z0-9_-]{0,63}$` | 属实，reader.ts L19 `RECORD_ID_SAFE` |
| 单一数据根 | 属实，[ipc.ts](file:///d:/ReBaseAgent/apps/desktop/src/main/ipc.ts) 装配 `dataRoot: dataDir`——traces/ 与 verifications/ 同根，MCP2 沿用 MCP1 `--data-dir` 启动规则成立 |
| MCP1 七工具/信封/游标/预算复用面 | 属实，[tools.ts](file:///d:/ReBaseAgent/packages/mcp-server/src/tools.ts) 七工具注册表；[envelope.ts](file:///d:/ReBaseAgent/packages/mcp-server/src/envelope.ts) `rebaseagent.query.v1` 成功/失败双判别式 + limitation 封闭四项；[cursor.ts](file:///d:/ReBaseAgent/packages/mcp-server/src/query/cursor.ts) HMAC 游标（进程随机 keyId）；错误码 INVALID_ARGUMENT/STORAGE_IO/STALE_CURSOR/RESPONSE_LIMIT 与 REDACTED 均在既有封闭集内 |
| 既有发行包 MCP 能力以 MCP1 为准 | 属实，[assemble-release-zip.mjs](file:///d:/ReBaseAgent/scripts/assemble-release-zip.mjs) 现断言「tools/list 恰 7 个」——task 5.4「更新发行组装断言」对应真实存在的工作量 |

### 内部一致性（程序化逐行核对）

- delta 场景 26 条 ↔ evidence-index 26 行：双向零缺失（「原：」前缀为对 MCP1 既有场景的有意标注，语义同一）；M05 未字面出现于 tasks，由 1.3「M04–M07」与 2.2「M04–M06」区间写法覆盖，与上轮「S03 的 4.2–4.7 区间写法」先例一致。
- 六工具命名与参数在 proposal、design D2、tasks 3.x、mcp-service delta 四处一致；13 = 7 + 6 数字口径多处一致。
- 错误/limitation/数据状态三域码表（design D3）内部自洽：`VERIFICATION_RECORD_INVALID（带 recordStatus）`可区分 corrupt/unsupported_version；reader 现有 `RecordReadError` 六码可完整映射（RECORD_NOT_FOUND→NOT_FOUND、RECORD_CORRUPT/UNSUPPORTED_VERSION→RECORD_INVALID、ASSET_MISSING/CORRUPT 同名、INVALID_REQUEST→INVALID_ARGUMENT）。
- `compare_verifications({left,right})` 采用两侧对象风格，与 `compare_checkpoint_files` 一致——上轮 review 观察项 6（参数风格统一）已被采纳；上轮观察项 2（limitation/错误码命名空间小表）也已落实为 D3 三行表。
- 结论顺序（outcome-unknown→evidence-incomplete→conditions-differ→conditions-unknown→failed-to-passed→same-conditions-other-outcome）与桌面 `compareVerifications` 现实现（verification-compare.ts L346-379）逐字同序——「桌面与 MCP 共享判据」不是空话，现有实现已按此序。

### 门禁复核（独立复跑）

| 检查 | 结果 |
|---|---|
| `openspec validate add-mcp-verification-evidence --strict` | 通过 |
| `node scripts/check-spec.mjs` | exit 0，`Totals: 16 passed, 0 failed` |
| `.openspec.yaml`（schema: spec-driven + created: 2026-10-25） | 与归档先例格式一致 |

## 发现

### 契约级问题（1 项，已修订）

1. **MODIFIED requirement 标题与正文数量矛盾。** mcp-service delta 将「首版只发布七个诊断工具」MODIFIED 为「完整实现后 SHALL 恰有十三个工具」，但标题原样保留。归档 sync 后主规范将出现标题说七个、正文说十三个的 requirement，长期误导读者。OpenSpec 1.13 支持 RENAMED 段（`- FROM:` / `- TO:`，且 rename+modify 可同 delta 共存，MODIFIED 块按新名、主规范按旧名定位）。**修订：** delta 增加 RENAMED 段将标题改为「只发布只读诊断工具」，MODIFIED 标题同步改新名；正文不动。修改后 `--strict` 复验通过。

### 观察项（低优先级，均已补进 design，不阻塞）

2. **桌面判据缺陷未列入 Context 缺口清单。** 现有 renderer 比较的 command 行以 `argv.join(" ")`、toolchain/limits/security 行以格式化展示串判等（verification-compare.ts L313-314/L322-335）；桌面 readLog 以 `events.find` 首条 command_end 定位附件（verification-read-endpoints.ts L326-328），重复命令时取第一条。D7 已要求「argv 比数组、对象比规范值」「重复 commandId 拒绝」，但若不点明现状，实施者可能把「保留展示适配」误读为「保留现有判据」。**修订：** Context 缺口清单补第四条；D7 明确 V02 的「交互不变」指 UI 交互，判据升级属于预期内变化、桌面展示随共享判据收紧。
3. **evidence-incomplete 的双触发来源未点明。** 桌面现有 `evidenceComplete` 来自 terminated 事件（记录封存时点事实）；D7/M16 另要求「查询时核验当前必需资产可用性，缺失阻止可核查失败到通过」——同一结论码实际有两个来源（记录缺项 + 当前缺资产）。不写明会出现只查其一的偏差。**修订：** D7 补一句双来源都查、均不改写已录 outcome。
4. **VERIFICATION_UNREADABLE 与 STORAGE_IO 边界模糊。** D3 只说「整个目录枚举失败给 STORAGE_IO」，未定义单条记录文件级不可读（如 EACCES）落哪个码；现有 `classifyReadFailure` 把非 not_found 的 IO 一律归 STORAGE_IO。**修订：** D3 明确文件级不可读→VERIFICATION_UNREADABLE、目录级枚举/其他 IO→STORAGE_IO，两域不互串。

### 实现期提醒（不改 change）

5. **limitation 封闭枚举须同步扩展。** [envelope.ts](file:///d:/ReBaseAgent/packages/mcp-server/src/envelope.ts) 的 `LimitationSchema` z.enum 与 `isKnownLimitationCode` 硬编码 MCP1 四项；MCP2 七个 VERIFICATION_* limitation 须在 1.2/4.x 一并扩表，勿在工具内自行造码旁路。
6. **1.3 的验收映射是证据准备而非场景收口。** fixture 清单标明 R3 记录来源，支撑 M04–M07/M17/M19 的证据回填，但均不构成这些场景的通过证据（上轮 MCP1 tasks 1.3 回填时已自证「清单本身不构成 Q01/D02 通过证据」）；M19 的收口在 5.3。
7. **非自主验收项照旧。** 5.2 真实 Electron、5.3 真实客户端属非自主验收，evidence-index 门禁约束已写明；收口时如实标记未通过项，不得预勾，外部验收未完成前不得归档。UI 布局约束（overflow-hidden/min-h-0/详情列独立滚动）对 5.2 抽查照旧适用。

### 值得肯定的处理

- **复用声明全部属实且可执行**：Context 列的每个「现有缺口」都能对应到具体代码行（主入口混导出、list 吞异常、readLog 字节切断、readVersion 只盖 traces），D1–D6 的设计各自针对真实缺口而非想象问题。
- **上轮 review 建议的落地**：compare 参数风格统一为两侧对象（观察项 6）、三域码表（观察项 2）均已在本文本兑现。
- **诚实口径贯穿**：proposal 首段「本次只编写提案，以下工具尚未实现或验收；既有发行包的 MCP 能力仍以 MCP1 为准」、evidence-index 顶部「待验收不得理解为功能已存在」、M20「未实际打包的 MCP2 明确标未发行」——与「归档不等于发行」纪律同源。
- **结论限制写进契约而非实现**：M14 只声明「该固定检查失败到通过」、M15 禁止 join 判等、M16 坏侧不换验证，比桌面现状更严格的部分（当前资产核验、argv 数组比较）都有明确场景锚定。
- **六工具设计与 R3 schema 严丝合缝**：command_end 双口径（retainedBytes/observedBytes/truncated）、四状态、十一 outcome、environment optional 的旧记录未知语义，均直接消费 R3 既有字段，无新造事实源。

## 2026-10-25 修订记录

按上述发现 1–4 修订 change（均为文档修订，未动代码）：

1. `specs/mcp-service/spec.md`：新增 RENAMED 段（「首版只发布七个诊断工具」→「只发布只读诊断工具」），MODIFIED 标题同步改新名，正文不变。
2. `design.md` Context：缺口清单补第四条（桌面比较展示字符串判等、readLog find-first 首条定位）。
3. `design.md` D3：补 VERIFICATION_UNREADABLE（文件级）与 STORAGE_IO（目录级/其他 IO）边界。
4. `design.md` D7：补判据修正说明（V02「交互不变」指 UI 交互）与 evidence-incomplete 双触发来源。

修订后复跑 `openspec validate add-mcp-verification-evidence --strict` 与 `node scripts/check-spec.mjs` 均通过。本审阅其余结论不变。
