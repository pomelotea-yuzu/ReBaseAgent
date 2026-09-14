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

- [x] 4.1 实测两条未验证假设 → **环境不可达（无 API key、本机 Ollama 未运行，`os error 10061`），已回写 proposal 证据节**：转入 4.3 冒烟，并明确"告警知识库 = 静默失败清单，显式 4xx 拒绝不在其中"的边界。
- [x] 4.2 各包 vitest（agent-loop 77 / llm-proxy 18 / replay 118 / desktop 173）、Biome 144 文件 0 errors、双端 TypeScript、`check:ci` 全绿；`openspec validate --all --strict` 13/13 通过。
- [ ] 4.3 真实 provider 冒烟（Ollama 本机 + DeepSeek，用户凭据，不进 CI）：`reasoning_effort:"none"` 臂生效（输出与 dogfood 实测的 shim 结果一致）、`num_ctx` 告警可见、dry-run 三段明细正确。**待用户凭据在场时执行**（4.1 的两条假设亦在此证伪）。
