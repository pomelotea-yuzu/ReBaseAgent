## 1. 记账层：usage 解析与 schema

- [x] 1.1 `packages/agent-loop/src/llm-client.ts`：`LlmResponse.usage` 改用 trace-sdk 的 `LlmUsage`（同一语义只写一处）；聚合处按「扁平优先、嵌套兜底、**存在性判定 `!== undefined`（`0` 是有值）**、非 number/负数/非整数视为缺失、**与 `in`/`out` 同一次赋值（覆盖式）**」解析（验证：6 个 SSE fixture 用例全绿——扁平 / 零命中如实记录为 0 / 嵌套 / 并存扁平优先 / 缺省省略 / 非法值降级）
- [x] 1.2 `packages/trace-sdk/src/schema.ts`：`LlmUsageSchema` 新增两个 optional 非负整数字段（验证：`packages/trace-sdk/test/schema.test.ts` 4 个新用例——老格式通过 / `0` 通过 / llm.call 老文件通过 / 负数·非整数·非数字拒绝）
- [x] 1.3 回归确认既有派生不受影响（验证：`deriveTotalTokens` 与既有 `{in,out}` 断言全绿；旧用例 `toEqual({in,out})` 仍通过 ⇒ 缺字段时不多写键）

## 2. 可视化层：桌面端展示

- [x] 2.1 `derive.ts` 新增 `deriveCacheHitTotal(spans): number | null`（无字段 ⇒ null；`0` ⇒ 0）并由 `deriveRunSummary` 吸收为 `cacheHit`；`shared/ipc.ts` 的 `RunSummarySchema` 增 `cacheHit`（nullable）（验证：6 个新用例，含老 fixture ⇒ null 且 tokensIn 不变）
- [x] 2.2 `DetailPanel.tsx` 的 `LlmCallDetail` 概要区新增 `CacheHitRow`（`KeyValue` 不支持逐项着色 ⇒ 独立元素）：展示「缓存命中 X / in（占比）· miss Y」，命中为主 emerald、否则 amber「全量计费」；`0` 走展示分支；字段缺失整行省略；`cache_hit > in` clamp 并标注；`in === 0` 不做除法（验证：CDP 冒烟见下）
- [x] 2.3 `RunList.tsx` 条目在 tokens 合计旁展示 run 级 `cacheHit`（null 不渲染，`>0` emerald / `=0` amber）（验证：同一冒烟）
- [x] 2.4 **`findStepLlm` 上移共享**：`shared/derive.ts` 新增；`main/fork-runner.ts` 删除私有副本改复用（`findStepLlm(leaf.spans, atSpan.id)`）（验证：共享函数 5 态用例 + 既有 fork/prompt-fork/A-B 用例全绿 = 行为等价回归）
- [x] 2.5 `ForkEditor`（仅 tool_result 分叉）模型不一致提示：经共享 `findStepLlm` 取分叉点 step 的 `request.model` 与 `settings.model` 比对，不一致显示 amber 提示、不拦截；prompt fork / 代理 messages 分叉不加此提示
- [x] 2.6 GUI 冒烟（CDP）：见 §5 验证记录

## 3. 事实校准：真机实测

- [x] 3.1 造 ≥3 步带 `read_file` 的父 run（真实 DeepSeek）→ `run_mu2iw4s1`：**3 次调用 / 2 次工具**，正常封存、可 fork
- [x] 3.2 立刻 fork 最后一次 tool.invoke → `run_mu2iw6hw_a3ly`：**fork 首个调用的 `cache_hit=256` 被记录**（断言 1 证实）、**`hit+miss=484=in`**（断言 4 证实）、fork 只发生 **1 次** llm.call（父 3 次）
- [x] 3.3 成本区间：Σcache_hit=256 / Σcache_miss=228 / Σout=53 ⇒ **下界 281（21%）· 上界 537（40%）** vs 父基线 1332；折扣率留待 provider 账单页（假设 5）。原始三元组、结论与失真清单已回填 design.md §8
- [ ] 3.4 （可选）冷缓存对照 —— **未做**：需要隔夜或换账号，条件不允许；已在 design §8 失真清单中明写"无命中时的上限未实测"

## 4. 文档与收口

- [x] 4.1 README：路线图 A2 条目**勘误**（删去「当前所有重跑都是从头执行」）并打 ✅；正文「成本约 1/4」按 §8 实测改写为**区间 + 条件**表述（21%~40%）；新增「缓存命中记账与可视化」能力条
- [x] 4.2 全量回归 + validate：6 包 **557** 测试全绿（18/79/83/67/119/191）、`biome check .` 149 文件 0 errors、`openspec validate --all --strict` 全通过
- [x] 4.3 HANDOFF §三/§六 更新

## 5. 验证记录（2026-09-15）

- 真机实测脚本：`apps/desktop/scripts/measure-fork-cache.cjs`（Electron 内跑 + safeStorage 解密 apiKey；**key 不打印不落盘**）。两个坑已固化进脚本注释：① `ELECTRON_RUN_AS_NODE=1` 会让 `require("electron")` 拿不到 `app`（须 `env -u` 清掉，同 `start-dev.cjs`）；② safeStorage 密钥材料绑定在应用 userData（dev = `%APPDATA%/@rebaseagent/desktop`），不锚定 `app.setPath("userData", …)` 会解密失败；③ 沙箱内须 `--disable-gpu` 否则 GPU 进程 FATAL。
- 测试增量：trace-sdk 75→79、agent-loop 77→83、desktop 180→191（**合计 536→557**）。

## 审阅收口（apply 前）

- **change 内 `review.md`（2×P1 + 5×P2）**：P1-1 查表上移共享（task 2.4）✅ / P1-2 存在性判定（`!== undefined`，`0` 是有值，含 agent-loop + trace-format + desktop 三处约束与两个测试）✅ / P2-1 命名论证补正 ✅ / P2-2 分母语义 + `in=0` 不除零 ✅ / P2-3 trace-format 补「非法值被拒绝」scenario ✅ / P2-4 提示收窄到 tool_result 分叉 ✅ / P2-5 缓存字段与 `in`/`out` 同次赋值 ✅
- **外部 `docs/reviews/2026-09-15-...`（2×P1 + 3×P2）**：P1-1 成本区间口径 ✅（实测按此算）/ P1-2 `in ⊇ cache_hit` 列为假设 4 且**已被实测证实** ✅ / P2-1 run 级口径锁叶子自有段 ✅ / P2-2 删二义「或」✅ / P2-3 tasks 1.2 指向 trace-sdk ✅ / P3-1 agent-loop delta 措辞改「聚合结果」✅ / P3-3 补「不并入预算地图」理由 ✅（P3-2 归并债：登记不阻塞）
- **apply 前自行发现（两处落点与实情不符，已改）**：`DetailPanel` 的 usage 行用 `KeyValue`（不支持逐项着色）⇒ 缓存行改独立元素；详情面板**没有** run 级 token 合计落点 ⇒ run 级展示改挂 run 列表条目
