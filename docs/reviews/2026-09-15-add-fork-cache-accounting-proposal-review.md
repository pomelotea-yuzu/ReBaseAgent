# 审阅：A2 共享前缀重跑·事实校准（add-fork-cache-accounting）

**审阅日期**：2026-09-15
**提案路径**：`openspec/changes/add-fork-cache-accounting/`
**审阅范围**：proposal.md、design.md、tasks.md、specs/{agent-loop,trace-format,desktop-ui}/spec.md

---

## 总体评价

**方向正确，范围校准准确。** 提案最重要的一步是对的：明确「共享前缀重跑」的执行机制已实现（`replay-run.ts:103-104` 分叉点前零 LLM 调用），把 A2 剩余范围收敛到 HANDOFF §三 口径的「prompt cache 命中/花销兑现」——记账 → 可视化 → 实测校准。三段式兑现路径清晰，Non-goals 完整（不做货币换算、不干预缓存、不动重跑语义），断言三档纪律执行到位（字段存在性已标注未验证假设 + 证伪命令）。

**可 apply 条件**：修复 2 项 P1（成本算术与数据语义假设）并确认 3 项 P2 后可落地。

---

## P1 问题（需修复才能 apply）

### P1-1：成本算术把「折扣计费」当「免费」，校准结论会系统性低估

**位置**：design.md §5 步骤 4「新增计费 tokens = Σ(in − cache_hit + out)」

**问题**：provider 对 cache hit tokens 是**折扣计费而非免费**（DeepSeek 命中输入按折扣价计费，折扣率属 provider 侧定价策略）。把 `in − cache_hit + out` 称作「新增计费 tokens」隐含「命中 = 不花钱」，会系统性低估 fork 重跑成本。本 change 的核心交付物就是「把 1/4 承诺校准成事实」，测量算术错了，README 的校准措辞就会是新的不诚实承诺。

**建议**：
- 测量输出**原始三元组**（hit / miss / out）而非单一"计费 tokens"数
- 成本以区间表述：下界 = Σ(miss + out) 全价、上界 = Σ(in + out) 全价；真实成本介于两者之间，取决于命中率与折扣率
- 折扣率单列为一条未验证假设（可经 provider 账单页实测核对），README 措辞按「全价口径 X；考虑缓存折扣后介于 Y–Z」的限定式表述
- 同步修 tasks 3.3 的计算公式与判据

### P1-2：「in ⊇ cache_hit」恒等式未列入未验证假设

**位置**：proposal.md 断言口径节（缺）；design.md §1「in 仍为 provider 返回的 prompt_tokens 原值」、§4.1 占比分母、§5.4 公式（均依赖此假设）

**问题**：整个记账体系依赖「`prompt_tokens` 包含命中部分（hit + miss = in）」。这是 provider 接口语义断言，按 §五纪律必须有实测或标注。若某 provider 口径不同（in 不含命中），`in − cache_hit` 会出负数或错值，UI 占比（X / in）也会失真。proposal 断言口径节现有 3 条未验证假设，恰好漏了最基础的这条。

**建议**：
- proposal 断言口径补「未验证假设 4：DeepSeek/OpenAI 的 prompt_tokens 含命中部分」+ 证伪命令（真机 run 后核对 hit + miss = in）
- 派生与展示侧对 `in < cache_hit` 的异常数据做防御（至少 clamp 或标注异常，不显示负占比）

---

## P2 问题（边界情况需确认）

### P2-1：run 级累计缓存命中的口径未定义（叶子自有段 vs 展开轨迹）

**位置**：design.md §4.2、specs/desktop-ui delta「run 级累计现算」scenario

**问题**：fork run 在详情面板是 `resolveBranch` **展开视图**（含祖先共享前缀的 llm.call），而 `deriveRunSummary` 的聚合口径是**叶子文件自有 spans**（`derive.ts:153-169`）。"run 级累计缓存命中"取哪个口径直接决定语义：
- 叶子自有段 = 「这次 fork 重跑实际新发生的计费」（正确语义）
- 展开轨迹 = 把祖先当年的命中混进来（误导）

design 与 spec scenario 均未写明；展开视图里祖先 llm.call 也会各自显示 cache_hit 行（这个是对的、单 span 维度无歧义），但 run 级合计必须定口径。

**建议**：明确 = 叶子自有段（与 `deriveRunSummary` 的 tokensIn/tokensOut 口径一致）；spec scenario 补「fork run 的累计不含祖先前缀」断言。

### P2-2：scenario「无缓存字段的调用降级」含二义的「或」

**位置**：specs/desktop-ui delta「无缓存字段的调用降级」

**问题**：「usage 区不展示缓存命中行**（或明确标注未知）**」——WHEN/THEN 必须唯一可测，二选一行为会让 apply 时测试断言摇摆。design §4.1 已定「整行省略」。

**建议**：spec 删去「（或明确标注未知）」，锁定「整行省略，不报错、不显示 0」。

### P2-3：tasks 1.2 验证位置笔误（trace-test → trace-sdk）

**位置**：tasks.md 1.2

**问题**：`LlmUsageSchema` 在 `packages/trace-sdk`，schema 用例应落在 `packages/trace-sdk/test/schema.test.ts`（已存在）；任务却写「trace-test 用例」。trace-test 是卡带重跑包，放错包会让用例无处安放或误导实现者。

**建议**：改为「trace-sdk 用例（`test/schema.test.ts`）」。

---

## P3 建议（非阻塞，可后续改进）

### P3-1：agent-loop delta 的「落盘」措辞越层

**位置**：specs/agent-loop delta「DeepSeek 扁平字段被记录」scenario

「落盘的 response.usage」——agent-loop 层产出的是内存中的 `LlmResponse`，落盘是 trace 层职责（trace-format delta 已正确表述）。建议改为「聚合结果的 usage」。

### P3-2：与「详情面板完整展示一步的原始请求与响应」的归并债

既有 requirement 枚举了 usage（in/out）展示，本 change 以 ADDED 旁挂缓存命中行。可接受（加法不改既有行为），但归档后主 spec 将有两处 requirement 约束同一 usage 区展示，长期可考虑 MODIFIED 归并。本期不阻塞，登记即可。

### P3-3：design 可补一句「不并入预算地图」的理由

预算地图是「上下文占用」语义（budget.ts 数据点 = 累计 token 占用），与「计费」正交，不并入是对的——但 design 未写，apply 时可能犹豫是否要往 BudgetMap 加缓存着色。建议补一句明确排除。

---

## 技术细节验证结果

| 验证项 | 结果 | 备注 |
|--------|------|------|
| usage 现只记 `{in, out}` | ✅ 实读 | `llm-client.ts:283-290` |
| 分叉点前零 LLM 调用已实现 | ✅ 实读 | `replay-run.ts:103-104` |
| `LlmUsageSchema` 位置与形状 | ✅ 实读 | `trace-sdk/src/schema.ts:25-28` |
| DetailPanel usage 行位置 | ✅ 实读 | `DetailPanel.tsx:676-678` |
| ForkEditor（在此重跑）位置 | ✅ 实读 | `DetailPanel.tsx:944-1059`，含空 fork amber 提示先例 |
| `deriveRunSummary` 叶子口径 | ✅ 实读 | `derive.ts:153-169`，tokensIn/Out 只算本文件 spans |
| `trace-sdk/test/schema.test.ts` 存在 | ✅ 实读 | tasks 1.2 应指向此处 |
| OpenAiCompatClient 仅流式单路径 | ✅ 实读 | `stream_options.include_usage`，无非流式分支需改 |
| DeepSeek/OpenAI 缓存字段存在性 | ⚠️ 未验证假设 | proposal 已标注（假设 1/2），待 task 3.2 实测 |
| 命中 tokens 折扣计费率 | ⚠️ 未标注 | **P1-1**：应补为未验证假设 |
| `prompt_tokens ⊇ hit` 恒等式 | ⚠️ 未标注 | **P1-2**：应补为未验证假设 |

---

## 结论

**修完 P1/P2 后可 apply**：

1. 修复 P1-1：成本算术改区间口径 + 折扣率列入未验证假设（design §5、tasks 3.3、README 改写模板同步）
2. 修复 P1-2：补「in ⊇ cache_hit」假设 + 异常数据防御（proposal 断言口径、design §1/§4.1）
3. 确认 P2-1：run 级累计锁定叶子自有段口径（design §4.2、desktop-ui delta）
4. 确认 P2-2：降级行为锁定「整行省略」（desktop-ui delta）
5. 确认 P2-3：tasks 1.2 验证位置改 trace-sdk

提案的记账-可视化-实测三段结构与「不改执行语义」的边界划分合理；两处 P1 均在测量方法学层，不影响架构选型，修复成本低。
