# A2 共享前缀重跑·事实校准（fork 缓存命中记账与成本兑现）

## Why

README 路线图承诺「共享前缀重跑——改中间某步后只重跑该步之后，前缀本地命中，成本约 1/4」，但该条目的缺口描述本身是**错的**：编辑 `tool_result` 从该步重跑、分叉点之前零 LLM 调用（截断拼接而非重放）**早已实现**（`replay-run.ts:103-104`，replay 主 spec 即其契约）。

真正剩余的缺口是**计费侧**：fork 重跑的第一个 LLM 调用仍要把整个前缀作为输入 tokens 重新发送，「成本约 1/4」依赖 provider 的 prompt cache 命中——而当前 trace 的 usage 只记 `{in, out}`（`llm-client.ts:283-290`），缓存命中**不记录、不展示、从未实测**。「1/4」是承诺不是事实（HANDOFF §三 口径）。

本 change 把这个承诺**校准成事实**：记录（trace 记账）→ 展示（桌面可视化）→ 实测（真机测量 + README 按实测改写），同时勘误 README 路线图条目的错误缺口描述。这也是 A2 作为「省钱卖点最直观演示素材」（hook demo）的收口。

## What Changes

1. **usage 记录缓存命中**（`agent-loop` / `trace-format`）：`llm.call` 的 `response.usage` 新增可选字段 `cache_hit` / `cache_miss`（tokens 数）。解析 provider 返回的 DeepSeek 扁平字段（`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`）与 OpenAI 风格嵌套字段（`prompt_tokens_details.cached_tokens`），两者容错、缺省合法；老 trace 文件不受影响（缺省字段，`format_version` 不变）。
2. **桌面端可视化**（`desktop-ui`）：llm.call 详情的 usage 行新增「缓存命中」展示（命中 tokens 与占输入比例，命中着色强调）；run 级累计缓存命中在共享派生层现算并展示。fork 确认弹窗在「当前运行配置的模型 ≠ 父 run 录制模型」时给出缓存可能不命中的提示（提示，不拦截）。
3. **真机实测与 README 校准**：用真实 provider（DeepSeek）执行「父 run → 编辑第 N 步 tool_result fork 重跑 → 与从头重跑对照」的测量，产出带失真清单的实测结论；README 路线图 A2 条目按实测改写（含勘误：原「当前所有重跑都是从头执行」的错误描述）。
4. 不改变任何重跑语义：fork / prompt fork / 模型 A/B 的执行路径、config_hash 门禁、world-free 保真度边界一概不动。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-loop`：新增「usage 解析记录缓存命中」requirement——SSE 聚合的 usage 解析扩展读取两种 provider 字段形态，容错缺省；`LlmResponse.usage` 类型扩展两个可选字段。
- `trace-format`：新增「llm.call usage 记录缓存命中与未命中」requirement——`response.usage` 可选 `cache_hit` / `cache_miss`，记录端有值才写，读取端缺省合法、不得报错或推断。
- `desktop-ui`：新增「缓存命中可视化与 fork 模型提示」requirement——llm.call 详情与 run 级汇总展示缓存命中（现算派生，不缓存）；fork 确认时模型不一致的缓存提示。

## Impact

- `packages/agent-loop/src/llm-client.ts`（usage 聚合解析：缓存字段与 `in`/`out` 同次赋值）＋ 类型导出
- `packages/trace-sdk`（span zod schema 的 usage 扩展：两个 optional 字段；缺失合法、越界非法）
- `apps/desktop/src/shared/derive.ts`（run 级缓存命中累计派生 + `deriveRunSummary.cacheHit`；**`findStepLlm` 从 main 私有函数上移为共享纯函数**，双端复用同一查表）
- `apps/desktop/src/shared/ipc.ts`（`RunSummarySchema` 增 `cacheHit: number | null`，加法式）
- `apps/desktop/src/main/fork-runner.ts`（私有 `findStepLlm` 改为复用共享实现；**门禁与执行路径不变**）
- `apps/desktop/src/renderer/src/components/DetailPanel.tsx`（llm.call 概要区缓存命中行、tool_result 分叉编辑器的模型不一致提示）
- `apps/desktop/src/renderer/src/components/RunList.tsx`（条目 tokens 合计旁展示 run 级缓存命中）
- `README.md`（路线图勘误 + 承诺按实测校准）
- 测试：agent-loop（解析容错，含 `hit: 0`）/ trace-sdk（schema 缺省合法 + 非法拒绝）/ desktop（共享派生与查表、提示判据）
- 真机实测脚本与记录（沿用既有 smoke 惯例，产物不入库）

## 断言口径（§五纪律）

- **源码依据**：usage 现只记 `{in, out}`（`llm-client.ts:283-290`）；分叉点之前零 LLM 调用已实现（`replay-run.ts:103-104`）；`buildRequestBody` 纯函数保证前缀逐字节稳定（prompt cache 命中前提，agent-loop 既有不变量）。
- **未验证假设 1**：DeepSeek `/v1` 流式 usage 携带 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。证伪命令：真机跑一次 fork 重跑，检查落盘 trace 的 `usage.cache_hit`（5 分钟内可验）。
- **未验证假设 2**：OpenAI 风格端点经 `prompt_tokens_details.cached_tokens` 携带命中数。证伪命令同上（换 baseURL）。
- **未验证假设 3**：DeepSeek 前缀缓存有效期足以覆盖「父 run 录制 → 用户编辑 → fork 重跑」的典型调试间隔。实测任务必须写明执行条件（缓存冷热），结论限定在被验证范围。
- **未验证假设 4**：`prompt_tokens` 包含缓存命中部分（即 `hit + miss = in`）。占比、miss 推算与成本区间均依赖该口径。证伪命令：真机 run 后核对 `cache_hit + cache_miss === usage.in`。派生与展示侧对 `in < cache_hit` 的异常数据须防御（clamp 并标注异常，不显示负值）。
- **未验证假设 5**：provider 对命中 tokens 按折扣价计费而非免费（折扣率属 provider 定价策略）。成本结论以**区间**表述——全价下界 Σ(miss + out) 与全价上界 Σ(in + out) 之间；折扣率可经 provider 账单页核对，不写入代码。

## Non-goals

- 不做货币成本核算（价格表随 provider 变动，只记 tokens；换算留给用户）
- 不做缓存命中的人为干预（不发送 `cache_control` 等提示参数——DeepSeek 为自动缓存，跨 provider 主动缓存策略超出本期）
- 不改任何重跑语义与门禁（fork / prompt fork / 模型 A/B / trace-test 的行为不变）
- 不做 llm-proxy 侧 usage 的缓存字段解析（代理录制是单请求级、走 `proxy:fork` 通道，缓存记账对它意义不同；需要时另行立 change）
- 不做 A3 隔离世界真重跑（COW/快照沙箱，路线图独立条目）
- 不做中间历史消息编辑（README 既有声明的边界，维持）
- 不引入已定稿技术栈外的新依赖
- 不做版本号 / changelog / 发版（发版时机由 owner 决定）

## 保真度边界

本 change **只加记账与展示，不动执行语义**，保真度口径完全沿用既有实现：

- fork 重跑仍是 world-free 截断拼接（分叉点之前零 LLM 调用）；分叉点后工具真实执行（同权限同 cwd）；外部状态源不承诺回退（replay 既有边界）。
- 缓存命中是 **provider 侧行为**：是否命中、命中率、缓存有效期均由 provider 决定，trace 只记录**当次实际返回值**，SHALL NOT 承诺命中率；fork 确认弹窗的模型提示是信息性提示，不是门禁。
- `usage.in` 语义不变（含命中部分的总量口径由 provider 返回的 `prompt_tokens` 原样记录），`cache_hit` / `cache_miss` 为附加维度；`deriveTotalTokens` 等既有派生不受影响。
