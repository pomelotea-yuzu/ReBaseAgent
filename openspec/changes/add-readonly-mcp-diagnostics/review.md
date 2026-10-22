# MCP0 / MCP1「只读诊断服务」提案审阅

日期：2026-10-22。审阅人：Trae 审阅会话。审阅对象为工作区未提交状态（change 目录当前 untracked，源码核对基线 `2d39b1e`，即当前 HEAD）。性质：提案与规格审阅，不含功能实现审查（功能尚未实施，evidence-index 35 个场景全部为待验证）。

## 结论

**合规，通过，无阻塞问题。** OpenSpec 严格校验通过（`13 passed, 0 failed`），config.yaml 三条 proposal rules 与两条 tasks rules 全部满足，制品结构与归档先例一致。proposal、design、3 份 delta、tasks、evidence-index 内部一致，design Context 的源码事实声明逐条属实。有 4 项低优先级观察项与 4 项实现期提醒，均不阻塞实施。

## 合规核对（对照 openspec/config.yaml rules）

| 规则 | 结论 | 依据 |
|---|---|---|
| proposal 必须含 Non-goals | 满足 | 明确排除 MCP2/MCP3、HTTP/SSE、写入删除导出、npm 发布、桌面捆绑、新 UI 等 |
| 时间旅行/replay 能力须声明保真度边界 | 满足 | 「保真度与费用边界」逐条写明 result 前缀投影、独立执行边界、不复用消息发起执行、文件取自运行自有快照、清单引用相同 ≠ 字节已核验相同 |
| 不引入技术栈外新依赖须显式说明理由 | 满足 | `@modelcontextprotocol/sdk` 说明用途（协商、schema、stdio 生命周期，避免手写协议），并由 1.2 要求审计许可证/传递依赖/体积、1.1 要求记录 zod 兼容；`packages/*` 新包沿用 zod/trace-sdk/replay 既有依赖 |
| 任务粒度 ≤2h | 满足 | 32 项任务全部 ≤2h（1h/1.5h/2h），并自留「超过先拆分」条款 |
| 每个实现任务对应 spec scenario | 满足 | evidence-index 35 行全部有任务映射，无空映射 |

## 已验证事实

### 源码核对（design.md Context 声明逐条属实）

| 声明 | 核对结果 |
|---|---|
| main 的 RunRepository / RunReadContext / run-lineage-read / run-detail-project 负责读取与父链投影 | 属实，四模块均在 [apps/desktop/src/main](file:///d:/ReBaseAgent/apps/desktop/src/main)，职责与描述一致（repository 扫描派生摘要、read-context 单请求缓存、lineage-read 父链诊断、detail-project 混合链投影） |
| compare-endpoints 不依赖 Electron，但依赖 desktop shared schema | 属实，[compare-endpoints.ts](file:///d:/ReBaseAgent/apps/desktop/src/main/compare-endpoints.ts) 不 import electron，使用 RunReadContext，逐侧 ready/unavailable |
| workspace-view 包装 replay/workspace/read-api | 属实，[workspace-view.ts](file:///d:/ReBaseAgent/apps/desktop/src/main/workspace-view.ts) 只做裁剪与状态归类，底层走 replay |
| R2.2 compare-api 已提供 compareWorkspaceSnapshots / readComparedWorkspaceFile | 属实，[compare-api.ts](file:///d:/ReBaseAgent/packages/replay/src/workspace/compare-api.ts) 为跨运行检查点只读比较的事实来源 |
| 新增两个 workspace 包可行 | 属实，[pnpm-workspace.yaml](file:///d:/ReBaseAgent/pnpm-workspace.yaml) 含 `packages/*`；现有 5 包（agent-loop/llm-proxy/replay/trace-sdk/trace-test）均无 run-query/mcp-server，且 packages 依赖均无 Electron，run-query 纯 TS 目标可达 |
| 承接正式路线 §3.3 与 MCP 服务规划 | 属实，[evolution-roadmap.md §3.3](file:///d:/ReBaseAgent/docs/product/evolution-roadmap.md) 的 MCP0 接口准备 + MCP1 只读诊断与本 change 范围吻合，「不成为 R3 前置条件」「不扩大渲染层重构范围」口径一致；`docs/product/mcp-service-roadmap.md` 存在 |
| 源码核对基线 `2d39b1e`（2026-10-22） | 属实，即当前 HEAD（R2.2 7.5 账本回填） |

### 内部一致性（程序化逐行核对，零失配）

- delta 场景 35 条 ↔ evidence-index 35 行：双向零缺失，标题逐字零失配（Q01–Q16 / S01–S16 / D01–D03）。
- 任务引用：32 个任务定义，evidence 映射全部有效（S03 的「4.2–4.7」为区间写法，覆盖的 4 个任务均存在）。
- 七工具命名（list_runs / get_run / get_step / compare_runs / inspect_checkpoint / read_checkpoint_file / compare_checkpoint_files）在 proposal、design D5、tasks 4.x、mcp-service delta 四处一致。
- 数字口径一致：完整结果 64 KiB、正文默认 4096 / 最大 8192 码点、条目默认 20 / 最大 100（design D6 ↔ delta「输出按完整序列化预算限制」）。
- 错误码口径一致：SPAN_AMBIGUOUS、STALE_CURSOR、INVALID_ARGUMENT、RESPONSE_LIMIT 等在 design D4/D5 与 delta 正文/场景间无漂移。
- 「省略 stepSpanId = 初始」双层语义与主 spec 互洽：MCP/包层缺省为初始，桌面默认为最近自有完成步骤、无则初始（[desktop-ui spec](file:///d:/ReBaseAgent/openspec/specs/desktop-ui/spec.md#L936)），delta 显式声明「MCP 规则不改变桌面默认」，未与既有契约冲突。
- `.openspec.yaml`（schema: spec-driven + created: 2026-10-22）与归档先例格式一致。

### 门禁复核（独立复跑）

| 检查 | 结果 |
|---|---|
| `node scripts/check-spec.mjs`（openspec validate --all --strict --no-interactive） | exit 0，`Totals: 13 passed, 0 failed`，change 通过 |
| change 内相对链接 | proposal→evolution-roadmap / mcp-service-roadmap、design→proposal/tasks、tasks→evidence-index 均无断链 |
| INFO 级提示 | 2 条「requirement 文本 >500 字符」，与全仓既有 spec 同类提示一致，非失败项 |

## 发现

### 观察项（低优先级，不阻塞）

1. **启动错误域与工具错误域混在同一张码表。** D3 规定数据根非法时「stderr 固定码、非零退出」，D4 的稳定码表却把 `DATA_DIR_INVALID` 与 `RUN_NOT_FOUND` 等工具期错误并列。两域的承载（stderr 文本 vs `error.code` 信封）与消费者不同，建议实施 4.1 时在 design 单列一行「哪些码只出现在启动域」，避免实现时把启动失败塞进工具错误信封或反向混用。

2. **limitation 码未像稳定错误码那样枚举。** 正文出现 TERMINATION_NOT_RECORDED、ANCESTOR_NOT_FOUND、BODY_NOT_EXPOSED、redacted 等，另有文件状态枚举（text/binary/not_found/missing/corrupt/rejected）。三类码的命名空间建议在 D4 补一张小表，防止实现期各工具自行造码、客户端无法按码分支。

3. **list_runs 失败项在分页序列中的位置有实现歧义。** D5 要求失败项「排后…占分页额度」，S07 又要求「失败项不重复回传全部」。失败项排在成功摘要之后的连续段时，跨页游标如何保证不重不漏（尤其筛选后成功项数量变化）未定义。建议 5.1 之前在 D6 补一句游标是否含失败项 offset。

4. **拆分触发判据偏软。** 1.3 审计 shared/ipc 最小闭包，D2 自认「闭包可能扩大」，但「超范围先修订拆分」没有量化线。参考上一轮 [compat-inventory.md](file:///d:/ReBaseAgent/openspec/changes/archive/2026-10-22-add-isolated-prompt-experiments/compat-inventory.md) 先例，建议 1.3 产出物落成文档，并在超出阈值（如需迁移的 shared 模块数、出现对 renderer 状态的依赖）时停下修订，避免 run-query 提取演变为 main 层半搬家、把 3.1/3.2 的桌面回归面撑爆——这关系到「不成为 R3 前置条件」的承诺能否兑现。

### 实现期提醒

5. **两层默认检查点语义沿用上一轮结论，勿混淆。** 上一轮 review 已要求桌面把默认解析为**显式 selector** 再调包层，不得依赖包层缺省兜底；本 delta「MCP 的省略 selector=初始规则 SHALL NOT 改变桌面最近自有完成步骤默认」正确固化了该区分，实施 3.1/4.6 时保持，勿让 MCP 缺省语义渗入旧 IPC。

6. **compare_runs({runIds}) 与 compare_checkpoint_files({left,right}) 参数风格不一致**（数组 vs 两侧对象）。外部契约首版发布后改动成本高，建议 4.2 定 schema 时统一（推荐两侧对象形式，因 checkpoint 比较需逐侧 stepSpanId）。

7. **6.2 真实客户端与 6.4 另一位使用者是非自主验收项。** evidence-index 门禁约束已写明「未完成不勾对应任务、不以模拟协议或维护者自验顶替」；按既定验收完成标准，收口时如实标记未通过项，不得预勾。

8. **UI 布局约束照旧适用。** 本 change 无新 UI，但 D03 实机回归含窄窗/200%/键盘抽查，主工作区 `overflow-hidden`、列容器 `min-h-0`、详情列独立滚动等既有约定不因回归而放松。

### 值得肯定的处理

- **诚实口径贯穿全文**：「本次仅编写 change，尚未实施、验收或发行」「尚未验证兼容，不提前写成已支持」「不承诺 npm 发布或桌面捆绑」「现有发行包不含 MCP」；evidence-index 顶部声明 35 场景全部待验证、门禁约束禁止预填通过——与社区文章口径约束同源，也符合「归档不等于发行」。
- **保真度边界写成契约而非脚注**：清单引用相同 ≠ 字节已核验相同、未封存 ≠ 进程仍运行、正常终止 ≠ 任务成功、已知凭据过滤 ≠ 自由文本彻底脱敏，四组「不等价」均落在 requirement 正文。
- **零写入/零执行的验收方法具体可测**：文件集合 + SHA-256、模型/工具/导出计数为零、无 operation 登记，且覆盖「源目录存在同名新文件」的对照（Q15/Q16/S14）。
- **与既有契约衔接有意识**：ownOnly/缺父语义、U6/U7/R2.2 前缀投影、desktop crashed 原状态保留、比较不判修复成功、错误不按文字猜码，均显式沿用而不重述为新发明。
- **支持路径验证排在最前**（1.1 先验选定客户端的最小 stdio，失败先修支持路径再扩大客户端），风险暴露顺序正确。
