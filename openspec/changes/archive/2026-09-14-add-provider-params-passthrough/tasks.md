# 任务

## 1. agent-loop：类型放宽 + 保留键守卫 + reasoning 兼容

- [x] 1.1 `config.ts` 导出 `RESERVED_BODY_KEYS = ["model","messages","tools","stream","stream_options"] as const`（与 `SampleParamsSchema` 同文件、紧邻其上方）；`SampleParamsSchema` 值类型扩为 `z.union([z.string(), z.number(), z.boolean()])` 并加保留键 refine（引用该常量，错误信息指明冲突键名）；`llm-client.ts` 的 `buildRequestBody` JSDoc 加"固定键集见 `RESERVED_BODY_KEYS`，新增固定键必须同步"一行。单测覆盖标量合法、保留键拒绝、对象/数组/null 拒绝、既有数值配置回归。
- [x] 1.2 `llm-client.ts` 两处聚合（`complete` 内联 + 流聚合）改为 `const r = delta.reasoning_content ?? delta.reasoning`，逐块追加进同一缓冲（**块内二选一、块间按到达顺序拼接、不去重**）；`hasContentDelta` 谓词同步纳入 `reasoning`。单测：纯 `reasoning` 流聚合进 `reasoning_content`、不同块分携两字段按序拼接、同块两字段并存只取 `reasoning_content`（不翻倍）、ttft 按首个 `reasoning` delta 计、既有 `reasoning_content` 流回归。
- [x] 1.3 `llm-proxy/handler.ts` 流式聚合同步接受 `reasoning`（同标准条款）：`handler.ts:387` 改为 `delta.reasoning_content ?? delta.reasoning`，块内二选一、块间拼接；`buildForkRequest`（`handler.ts:501`）JSDoc 引用 `RESERVED_BODY_KEYS`。单测覆盖 Ollama 形态 fixture 的代理录制。

## 2. replay：编排层标量化 + 告警 + dry-run 明细

- [x] 2.1 `ModelParamsValueSchema.params` 扩为标量 union + 保留键 refine —— **从 `@rebaseagent/agent-loop` `import { RESERVED_BODY_KEYS }` 引用，禁止复制键集**；`numericParams`/`numericParentParams` 改为标量过滤并更名 `scalarParams`（两处实现合一，`numericParentParams` 改为委托）；`ModelOverride.params` / `ModelArmSpec.params` / `ModelArmPlan.params` / `ModelArmResult.params` 类型从 `Record<string, number>` 改 `Record<string, Scalar>`，导出 `Scalar` 类型别名；错误文案同步（"只接受 string/number/boolean 标量"）。单测覆盖标量合法、保留键拒绝、非标量拒绝、`scalarParams` 混合值过滤。
- [x] 2.2 新增纯数据知识库 + `warnSilentIgnores(baseURL, params)`（首期 Ollama 两条实测记录，含 reason 与绕行方式）；单测：命中/未命中/非 Ollama baseURL 不误报。
- [x] 2.3 `ModelArmPlan` 扩为 `{ index, model, params, changed, overridden, discarded, warnings, allowSideEffects }` —— `overridden` = arm 给出 ∩ 父已有键，`discarded` = 父有 ∩ arm 未给（arm 未给 params 时为 `{}`），`warnings` 由 `warnSilentIgnores` 在编排入口算一次、dry-run 与真实执行共用；单测覆盖覆盖/新增/丢弃三态与"未给 params 时 discarded 为空"。
- [x] 2.4 CLI arm 语法宽松解析：`true`/`false` 严格小写 → boolean；合法 JSON number → number；引号包裹 → 强制字符串（仅支持 `\"` 与 `\\`，其他转义报错；未闭合引号 / 裸引号报错；`k=""` 为合法空串）；其余按字符串。`--dry-run`/`--confirm-cost` 前按 design §4 三段格式打印（`生效 params` / `丢弃父录值` / `⚠ 告警`，空段省略）；单测覆盖四种解析、合法/非法转义、未闭合引号、既有 `temperature=0.2` 回归。

## 3. 桌面端

- [x] 3.1 `fork-runner.ts` 的 `sanitizeParams` 改为标量判定（`Record<string, Scalar> | undefined`）；既有数值路径回归。
- [x] 3.2 `renderer/lib/model-ab.ts` 的 `parseArmParams` 接受标量（`Record<string, Scalar>`，错误文案同步）；`sameAsParent` / `parentParams` 类型随标量扩展；`ipc.ts` 的 `ModelArmPlanSchema` 同步扩 `overridden` / `discarded` / `warnings` 三字段（zod schema）；ModelAbEditor 计划面板按 design §4 三段渲染（生效 params / 丢弃父录值 / ⚠ 告警，空段省略）；`modelAbGuard` 空 fork 判据随标量天然成立（补非数值对照用例）。

- [x] 3.3 双端展示一致性核对：同一 plan 输入下 CLI 输出与桌面渲染的字段语义逐项对照（覆盖/新增/丢弃/告警四类），确认无"一端算、另一端重算"的分叉。

## 4. 验证与收口

- [x] 4.1 实测两条未验证假设 → **假设 B（未知字符串参数）已证伪**：`/v1` 发完全未知键返回 **200 + 正常出结果**，provider 静默吞键不报 400 ⇒ 知识库无需"硬拒绝"类目，静默失败面比预想更大。**假设 A（DeepSeek `reasoning_effort` 接受度）仍不可达**（无 DeepSeek 凭据），但 Ollama 侧已实测 `reasoning_effort:"none"` 被接受且生效 ⇒ 该假设对设计无影响（400 走既有 `LlmRequestError`，不静默）。边界确认：**告警知识库 = 静默失败清单（200 但未生效）**，显式 4xx 拒绝不在其中。
- [x] 4.2 各包 vitest（agent-loop 77 / llm-proxy 18 / replay 118 / desktop 173）、Biome 144 文件 0 errors、双端 TypeScript、`check:ci` 全绿；`openspec validate --all --strict` 13/13 通过。
- [x] 4.3 真实 provider 冒烟（**2026-09-14 完成，Ollama 本机 0.33.2 + qwen3:1.7b**；DeepSeek 侧待凭据）：
  - **思维链字段确认**：流式 delta 形态 `{"role":"assistant","content":"","reasoning":"Okay"}`，`reasoning_content` 恒缺省 ⇒ 兼容修复确有必要；
  - **`reasoning_effort:"none"` 生效**：reasoning 从 ~2900 字 → **0**，content 正常（291 字），ttft 224ms → 78ms；
  - **`num_ctx` 三种 `/v1` 写法全部无效**：`/api/ps` 冷加载对照显示运行中 context 恒为默认 **4096**（顶层 / 嵌套 options / 字符串）；
  - **新增发现 A（已回写知识库 workaround）**：原生 `/api/generate` 的 `options.num_ctx=2048` **确实生效**（context 4096 → 2048）⇒ 轻量绕行可用，原先只写了派生模型；
  - **新增发现 B（已回写知识库 workaround）**：模型 card 报 `context_length: 40960`，运行时实际只加载 **4096**，易误导；
  - **端到端链路**（真实 agent-loop 库 → 真实 Ollama）：标量 params 逐字节进请求体、`reasoning` 聚合为 `reasoningContent`（2922 字）、保留键 5 个全在 schema 层零请求拒绝、`warnSilentIgnores` 真实 baseURL 命中 2 条 / DeepSeek baseURL 零误报；
  - dry-run 三段明细与告警双端一致性：**由 3.3 的单测覆盖锁定**（冒烟脚本不额外跑 CLI 端到端，避免重复）。
  - 冒烟脚本（一次性，不入库）：`.tmp-smoke-d3*.cjs`，结论落盘 `.tmp-smoke-d3-*.md`。
