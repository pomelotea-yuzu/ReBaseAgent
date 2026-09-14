# Provider 原始参数透传 + 参数生效性自检

## Why

模型 A/B 的臂参数目前只接受数值（`Record<string, number>`），而真实 provider 的关键开关大量是非数值——`reasoning_effort: "none"`、`think: false`。更贵的问题是**静默失败**：参数发出去 HTTP 200、无警告，但 provider 根本没生效（Ollama `/v1` 对 `num_ctx` 三种写法全部静默忽略；`think:false` 无效需换 `reasoning_effort`）。2026-09-10 dogfood 实测累计 5 条这类"不报错但结果不对"的坑，任何用非标准 provider 的用户第一次接入就会踩到，而且无从察觉。本变更让参数通道接受标量原始参数，并把"哪些参数可能没生效"从猜谜变成显式信息。

立项依据：`docs/plans/2026-09-10-next-phase-plan.md` §八 owner 批准排序 `B1（已完成）→ D-A（已完成，2026-09-14）→ D3 → A1 → A2/A3`，本变更即 D3。

## What Changes

- **采样参数标量化**：`params` 值类型从 `number` 扩为 `string | number | boolean`（JSON 标量），贯穿 agent-loop `SampleParamsSchema`、replay `ModelParamsValueSchema`、桌面 `sanitizeParams`、渲染层编辑器与 CLI arm 语法。`buildRequestBody` 的平铺语义与逐字节稳定保证不变。
- **保留键守卫**：params 键与 `model` / `messages` / `tools` / `stream` / `stream_options` 冲突时在运行配置校验阶段拒绝——参数通道不得变成请求体注入通道。
- **Ollama 思维链字段兼容**：llm-client 与代理的 SSE 聚合同时接受 `reasoning` 与 `reasoning_content`（Ollama `/v1` 实测发 `reasoning`，现客户端只读 `reasoning_content`，思维链整段丢失且不报错）。内部 trace 字段名 `reasoning_content` 不变。
- **已知静默忽略告警**：内置首期两条实测记录（Ollama `/v1`：`num_ctx` 被静默忽略、顶层 `think` 无效），按 baseURL 启发式识别 provider；命中时 CLI 输出警告、桌面编辑器显示警示。告警不阻断——派生模型等绕行是合法用法，告警只负责"让你知道"。
- **dry-run 参数透明化**：dry-run 与执行前展示每臂最终生效 params（含继承的父录值）与相对父 run 的覆盖/丢弃明细——V3b 的"整体替换不合并"语义保持，但把"臂只写 temperature 会丢掉父的 num_predict"这类代价显性化。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-loop`：采样参数值类型扩为 JSON 标量；params 保留键冲突拒绝；SSE 聚合兼容 `reasoning` 字段（思维链与 ttft 的"内容 delta"谓词同源纳入）。
- `model-experiments`：臂 params 接受标量；空 fork 与同源判据随类型扩展；dry-run 展示生效 params 与丢弃明细；已知静默忽略参数在编排入口告警。

## Impact

- `packages/agent-loop/src/config.ts`（`SampleParamsSchema` + 保留键 refine + **导出 `RESERVED_BODY_KEYS` 常量**）、`llm-client.ts`（聚合谓词 + `buildRequestBody` 注释引用常量）
- `packages/llm-proxy/src/handler.ts`（流式聚合 `reasoning` 兼容——按既有"与 llm-client 同标准"条款跟随；`buildForkRequest` 注释引用常量）
- `packages/replay/src/prompt-fork.ts`（`ModelParamsValueSchema` 标量 union + 保留键 refine，**从 agent-loop 导入 `RESERVED_BODY_KEYS`，不复制键集**；`numericParams` → `scalarParams`）、`model-replay-run.ts`（`ModelArmPlan` 扩 `overridden`/`discarded`/`warnings`；`Scalar` 类型别名）、新增知识库模块、`model-ab-cli.ts`（标量解析 + 引号转义 + dry-run 三段展示）
- `apps/desktop/src/main/fork-runner.ts`（`sanitizeParams`）、`renderer/src/lib/model-ab.ts`（`parseArmParams` + `sameAsParent`）、`shared/ipc.ts`（`ModelArmPlanSchema` 扩三字段）、`components/DetailPanel.tsx`（计划面板三段渲染）
- 兼容性：既有数值 params 的 trace、arm 语法、UI 输入全部原样合法；`config_hash` 不吃 params，无指纹迁移。

## Non-goals

- **不做探针式生效性检测**（发对比请求判断参数是否生效）：temperature 这类参数无确定性判据，探针既不可靠又计费。首期自检 = 静态守卫 + 知识库告警 + 透明化，探针等真实需求证据。
- **不做 provider 适配**：知识库只是"已知静默忽略"的告警数据，不做任何 provider 的官方适配、不追 API 面（红线：不做外部工具官方适配）。
- **不做嵌套对象参数**（`response_format` 等）：首期标量即可覆盖实测痛点（`reasoning_effort` / `think`）；无证据不扩。
- **不改"params 整体替换不合并"语义**：只把丢弃项显性化；改成语义合并属 V3b 契约变更，无证据支撑。
- **不解决 `num_ctx` 本身**：那是 Ollama 的行为；知识库告警指路派生模型绕行（实测有效），不代管模型配置。
- **不做 keep_alive / 预热管理**：dogfood 运营问题，非产品能力。

## 保真度边界

参数透传只保证"请求体携带了声明的参数"；参数是否被 provider 采纳不在本系统可控范围（OpenAI 兼容协议无回执）。思维链兼容只解决字段名差异（`reasoning` vs `reasoning_content`），不承诺跨 provider 的思维链内容等价。知识库告警基于本机实测样本，不保证覆盖所有 provider 版本行为；告警缺失不构成"参数已生效"的证据。

## 证据与验证口径

- 实测（2026-09-10，本机 Ollama，记录于 `docs/plans/2026-09-10-dogfood-plan.md` §二 与 `HANDOFF.md` §六）：
  - `/v1` 静默忽略 `num_ctx`（顶层 / 嵌套 `options` / 字符串三种写法均不认）；
  - `think:false` 在 `/v1` 无效，`reasoning_effort:"none"` 实测与生产逐字一致；
  - Ollama `/v1` 思维链字段为 `reasoning`；
  - 臂 params 部分给出会整体替换父值（只写 `temperature` 丢 `num_predict`，token 实测涨约 10 倍）。
- 源码依据：`packages/agent-loop/src/config.ts:95`（`SampleParamsSchema = z.record(z.string(), z.number())`）；`packages/replay/src/prompt-fork.ts:31`（arm params 限数值）；`packages/agent-loop/src/llm-client.ts:185,236`（只读 `reasoning_content`）；`apps/desktop/src/renderer/src/lib/model-ab.ts:41`（"必须是有限数字"）；`packages/replay/src/model-ab-cli.ts:129`（`parseFloat`）。
- 未验证假设（实现前 5 分钟可证伪）：
  - DeepSeek 对 `reasoning_effort` 的接受度——`curl -s $BASE/v1/chat/completions -d '{"model":"deepseek-chat","messages":[...],"reasoning_effort":"none"}'` 观察 200 或 400；
  - 标量 params 平铺后 DeepSeek/Ollama 对未知字符串参数是否仍 200——同法各测一条（若 400 则告警知识库需补"硬拒绝"类目）。
- **实测状态（2026-09-14 收口）**：两条假设均**未能在本机证伪/证实**，原因是环境不可达而非设计缺陷——
  - 无 `REBASEAGENT_API_KEY` / `DEEPSEEK_API_KEY` 环境变量 ⇒ 不能向 DeepSeek 发真实请求；
  - 本机 Ollama 未运行（`curl http://127.0.0.1:11434/api/tags` → `connect failed, os error 10061`）⇒ 不能复测 Ollama。
  因此这两条**转入 4.3 真实 provider 冒烟**（用户凭据在场时执行），本变更按"未验证假设"提交：
  - 若 DeepSeek 对 `reasoning_effort` 返回 400，则参数通道的"硬拒绝"行为需在 UI/CLI 呈现（当前实现只做告警与透传，400 由既有 `LlmRequestError` 路径承载，不静默）；
  - 若某 provider 对未知字符串参数返回 400，知识库则不需补"硬拒绝"类目（400 本身即显式信号，非静默）；知识库只收录"**HTTP 200 但参数未生效**"这类静默失败。
  这一区分是本变更的边界：**告警知识库 = 静默失败清单**，显式拒绝（4xx）不在其中。
- 验收必须覆盖：标量参数逐字节进入请求体；保留键冲突零文件零调用拒绝；`reasoning` 字段聚合进 `reasoning_content` 且 ttft 谓词同步（两字段并存按到达顺序拼接、同块二选一不翻倍）；告警在 CLI 与桌面两端可见且字段同源；dry-run 三段展示（生效 params / 丢弃父录值 / 告警）双端语义一致；CLI 引号转义仅 `\"` 与 `\\`、非法转义与未闭合引号报错；既有数值 arm / 旧 trace 回归全绿。
- 审阅收口（2026-09-14，`docs/reviews/2026-09-14-d3-provider-params-passthrough-review.md`）：P1-1 常量导出位置落地为 `config.ts` + 双消费方引用（design §1 表）；P1-2 并存聚合语义明确为"块内二选一、块间按序拼接、不去重"并写入 spec scenario；P2-1 dry-run plan 字段与三段格式固化（design §4 表 + spec scenario）；P2-2 CLI 引号转义规则表化（design §5 表 + spec scenario）；P3-1 与 P1-1 合并处理。
