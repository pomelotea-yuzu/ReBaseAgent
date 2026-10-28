# 「现有软件完整中英双语」提案审阅

日期：2026-10-28。审阅人：Trae 审阅会话。审阅对象为工作区未提交状态（change 目录 untracked，源码核对基线 `dd32fef`，即当前 HEAD；盘点报告标注基线 `f1c132a`，两者间桌面及包层 src 无变更，proposal 声明属实）。性质：提案与规格审阅，不含功能实现审查（功能尚未实施，tasks 全部未勾选）。

## 结论

**合规，通过；有一处契约级问题需修订（已当场修订，见文末）。** OpenSpec 严格校验通过，`check-spec.mjs` 全仓 16 passed / 0 failed，config.yaml 三条 proposal rules 与两条 tasks rules 全部满足。proposal、design、5 份 delta、tasks 内部一致；引用的盘点报告、阶段决策文档、基线 commit 逐条属实；盘点数字多处自洽（3,603 = 2,252 + 226 + 1,125；批次 renderer 1,142 + 817 + 293 = 2,252）。发现 1 项契约级问题（场景编号与主 spec 冲突）与 4 项低优先级观察项、2 项实现期提醒。

## 合规核对（对照 openspec/config.yaml rules）

| 规则 | 结论 | 依据 |
|---|---|---|
| proposal 必须含 Non-goals | 满足 | 明确排除自动翻译用户/模型内容、改写发给模型的 prompt、新语言/繁体、平台与打包、全量翻译 docs/ 注释/测试标题等 |
| 涉及时间旅行/replay 的能力须声明保真度边界 | 满足 | 「保真度边界」章节逐条重申普通 result 续跑、prompt fork、隔离续跑语义不变，切语言不改消息/快照/指纹/操作身份，与 agent-loop、replay、sandboxed-rerun 既有归档口径逐字兼容 |
| 不引入技术栈外新依赖须显式说明理由 | 满足 | 「拟新增 i18next 与 react-i18next」给出理由（约三千条候选文案涉及复数、富文本和 React 订阅），限定纯包只依赖 i18next、React 适配限于桌面，并列负面清单（不加语言检测插件、HTTP backend、ICU 解析器等），实施时固定版本、核对许可、提交 lockfile（0.3 落实） |
| 任务粒度 ≤2h | 满足 | 44 项任务全部 ≤2h（1h/1.5h/2h），开头自留「超时拆子项而不删范围」条款，6.1 另有按工作区拆项规则 |
| 每个实现任务对应 spec scenario | 满足 | 37 个场景（S01–S11、D13–D22、M21–M26、C01–C04、G01–G06）全部有任务映射，逐条核对无缺号漏引 |

### 时机与路线图合规

- 阶段决策文档（2026-10-09 建档、2026-10-28 修订）明确「下一阶段收敛为现有软件完整中英双语 + 必要用户文档」「MCP 服务文案、CLI 输出或原生对话框不留作后续」「单独提出软件 i18n 的 OpenSpec 方案……审阅通过后再 apply」——本 change 即该方案，时机合规。
- 本 change 是当前唯一活跃 change（`add-readonly-mcp-diagnostics` 等前一阶段 change 均已归档），无并行冲突，不构成任何 R3 收口的阻塞项。
- proposal「此次只建立 change，不改变实现与发行状态」与决策文档「实施仍未开始，须另行放行」一致，无预勾、无冒充完成。

## 已验证事实

### 引用与外部核对

| 声明 | 核对结果 |
|---|---|
| 盘点报告 `2026-10-28-i18n-text-inventory.md` 存在且数字吻合 | 属实，3,603/3,105、renderer 2,252（lib/ 715）、main+shared 226（147+79）、包层 1,125（replay 352、project-verification 261、mcp-server 163、run-query 123、trace-sdk 114、trace-test 80、agent-loop 17、llm-proxy 15）、1,060 插值、274 量词、≥1,138 UI 断言、测试环境 node + renderToStaticMarkup 无 jsdom——逐项与报告一致 |
| 基线 `f1c132a` 与 HEAD `dd32fef` 存在且声明无 src 变更 | 属实，`f1c132a` 为「收敛阶段范围为软件中英双语＋用户文档英文化」提交，HEAD 即 `dd32fef`（发行 zip 英文说明），其间仅 docs/release 提交 |
| 「十三工具」口径 | 属实，与主 spec「完整实现后 SHALL 恰有十三个工具」一致（MCP1 七工具 + MCP2 六验证工具） |
| Envelope.error 为 `{code,message}`、渲染端直接显示 message 并拼中文前缀 | 属实（mcp-server structuredContent 信封、`store/slices/runs.ts` 等拼前缀，盘点报告 §6）——design §4 的 `presentation:{id,params}` 兼容扩展针对真实缺口 |
| 其余既有包层 CLI 存在 | 属实，`packages/replay/src/model-ab-cli.ts`（模型实验 CLI）、`packages/trace-test/src/cli.ts`、`packages/mcp-server/src/cli.ts`——tasks 5.7「含模型实验入口」对应真实工作量 |
| 原生对话框中文提示存在 | 属实（盘点报告 §7.3，`main/index.ts` 数据目录选择对话框） |

### 内部一致性

- 语言优先级（--locale > REBASEAGENT_LOCALE > LC_ALL/LC_MESSAGES/LANG/Intl > en-US）、zh 变体归 zh-CN、C/未知归 en-US、非法显式值退出 2：proposal、design §2、S09/S10、M22、C02 五处口径一致。
- 「切语言零新增执行、locale 不进入指纹、不重发、在飞按原身份核实」：proposal、design §5、D17/D18、D06 语义一致，且与主 spec「主动执行由 main 会话身份登记和去重」的既有不变量衔接（ADDED 不修改既有 requirement，正确）。
- MCP 预算（先本地化再算完整 UTF-8 序列化、64 KiB、STALE_CURSOR）与主 spec「输出按完整序列化预算限制」「分页和续读不能混合来源版本」既有契约兼容，均为加强而非改写。
- trace-test「JSON 契约不变、stdout 可解析、baseline 反馈转 stderr」与主 spec trace-as-test 既有报告/脱敏/退出码契约兼容。
- 术语表（Run/Step/Turn、Fork/Branch、Replay/Rerun、轮末、Unknown 等）与既有英文指南口径一致，且「不补 Passed/Cancelled/零消耗」延续主 spec 未知状态纪律。

### 门禁复核（独立复跑）

| 检查 | 结果 |
|---|---|
| `node scripts/check-spec.mjs`（修订前） | exit 0，`Totals: 16 passed, 0 failed` |
| `node scripts/check-spec.mjs`（修订后） | exit 0，`Totals: 16 passed, 0 failed` |
| `.openspec.yaml`（schema: spec-driven + created: 2026-10-28） | 与归档先例格式一致 |

## 发现

### 契约级问题（1 项，已修订）

1. **场景编号与主 spec 既有编号冲突。** desktop-ui delta 使用 D01–D10，但主 spec desktop-ui 已有 D01–D12（2026-10-22-add-isolated-prompt-experiments 引入）；mcp-service delta 使用 M01–M06，但主 spec mcp-service 已有 M01–M20（add-readonly-mcp-diagnostics 的 M01 与 add-mcp-verification-evidence 的 M02–M20）。OpenSpec CLI 不校验场景编号，strict 通过不代表编号无冲突；归档 sync 后主 spec 将出现两套同号场景，tasks/evidence-index 的验收引用将歧义。项目既有惯例是同一 capability 内编号唯一递增（MCP2 特意从 M02 起编避开 MCP1 的 M01）。**修订：** desktop-ui delta 重编为 D13–D22、mcp-service delta 重编为 M21–M26（顺序保持，语义不变）；ci-gates G05 的范围引用同步改为 D13—D22/M21—M26；tasks.md 全部 44 处验收引用联动更新（含 6.4 的区间引用 D02—D06 → D14—D18）。S01–S11（新 capability）、C01–C04、G01–G06（主 spec 无同类前缀编号）核对无冲突，保持。修订后 `--strict` 复验通过。

### 观察项（低优先级，不阻塞）

2. **proposal 引用本地 `.tmp/i18n-inventory.json`**（已 gitignore，仓库读者不可复现）。盘点报告本身入库且 §9 给出复跑命令与脚本路径，proposal 已写明「本地」字样，影响有限；实施期引用数据以入库报告为准即可，不改 change。
3. **部分 requirement 正文超 500 字符触发 INFO 提示**，与既有主 spec（desktop-ui、trace-as-test、mcp-service 大量同类）风格一致，属提示级不阻塞，不拆分。
4. **config.yaml「当前进度」段仍写「下一项新增能力为 R3」**，滞后于实际（R3 两 change 已于 10/25–10/26 归档）。非本 change 义务，但建议后续同步 config 校准段，避免下一轮提案误判路线图位置。
5. **desktop-ui 主 spec 内存在 M01/M02 编号**（R3 相关场景），与 mcp-service 的 M 前缀编号分属不同 spec 文件，本 change 重编为 M21–M26 后无歧义；此项仅提示未来 change 编号时留意跨 spec 前缀习惯。

### 实现期提醒（不改 change）

6. **i18next 版本冻结须在 0.3 兑现**：design §3 承诺「版本及许可证在第 0 批冻结并写 lockfile」，实施时核对 i18next/react-i18next 同步初始化行为（initSyncImmediate）与 Node `renderToStaticMarkup` 兼容，避免引入异步初始化路径。
7. **非自主验收项照旧**：6.1–6.4 真实 Electron/键盘/缩放属实机证据，evidence-index 须逐场景登记（6.7），收口时如实标记未通过项，不得预勾；外部验收未完成前不得归档；UI 布局约束（overflow-hidden、min-h-0、详情列独立滚动）对实机抽查照旧适用。

### 值得肯定的处理

- **引用事实全部可追溯**：盘点报告、阶段决策、基线 commit、十三工具口径、Envelope 结构、包层 CLI 清单逐条属实，数字多处交叉自洽，未发现虚构或臆测。
- **原文/机器数据边界干净**：模型输入、trace、日志、导出、哈希、游标、错误码全部声明不受 locale 影响，「不能匹配中文 message 猜错误类型」「不透传原始异常」把本地化约束写进契约而非实现细节。
- **诚实口径贯穿**：proposal「不预记任何实现验收为已通过」「归档不等于发行」、G06「中间态不冒充全量」、盘点报告自身标注启发式局限并被 proposal 原样引用。
- **切换语义与既有执行纪律严丝合缝**：D16–D18 以统一提交适配器冻结载荷为界区分未提交/在飞，延续主 spec「主动执行登记去重」「未知先核对」不变量，locale 不进入指纹的声明消除了制造新操作的可能。

## 修订记录（2026-10-28，均为文档修订，未动源码）

按发现 1 修订 change：

1. `specs/desktop-ui/spec.md`：D01–D10 → D13–D22（10 处场景标题）。
2. `specs/mcp-service/spec.md`：M01–M06 → M21–M26（6 处场景标题）。
3. `specs/ci-gates/spec.md`：G05 THEN 中范围引用改为 D13—D22/M21—M26/C01—C04/S01—S11。
4. `tasks.md`：全部验收编号引用联动更新（0.2、1.1–1.6、2.1–2.8、3.1–3.6、4.1–4.5、5.2–5.4、6.1–6.5 共 44 处）。

修订后复跑 `node scripts/check-spec.mjs` 通过（16 passed / 0 failed）。本审阅其余结论不变。
