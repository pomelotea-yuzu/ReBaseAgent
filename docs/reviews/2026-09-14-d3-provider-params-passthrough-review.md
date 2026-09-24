# 审阅：`add-provider-params-passthrough`（D3）proposal

- 日期：2026-09-14
- 审阅对象：`openspec/changes/add-provider-params-passthrough/`（proposal.md / design.md / tasks.md / specs/agent-loop/spec.md / specs/model-experiments/spec.md）
- 审阅方式：逐条比对仓库实际结构（config.ts:94、llm-client.ts:185/236、prompt-fork.ts:31、model-ab.ts:41、model-ab-cli.ts:129、fork-runner.ts:334）
- 结论：**方向正确，设计质量高，有 2 个 P1 和 2 个 P2 需要澄清或调整**。修完可以 apply。

---

## 总评

D3 解决的是 dogfood 实测暴露的真实痛点：params 只接受数值导致 `reasoning_effort: "none"` 等关键开关无法传入，且 provider 静默忽略参数时无任何告警。立项依据充分（`docs/engineering/plans/2026-09-10-next-phase-plan.md` §八 owner 已批准排序），证据链完整（5 条实测记录均有日期与具体行为描述）。

设计思路清晰——**类型放宽最小面 + 保留键守卫 + reasoning 兼容 + 知识库告警 + dry-run 透明化**——五个改动互相独立、可分别验证。Non-goals 划得干净（不做探针、不做 provider 适配、不做嵌套对象），避免了范围蔓延。

问题集中在**实现细节的完整性和边界情况的语义明确性**上。

---

## P1：实现细节不完整，可能导致返工

### P1-1 `RESERVED_BODY_KEYS` 的"同一常量来源"未落地

design.md 第 1 节末尾：

> `ModelParamsValueSchema` 同步加同一条 refine——两处守卫、同一常量来源（从 agent-loop 导出 `RESERVED_BODY_KEYS`，replay 已依赖 agent-loop，零新依赖）。

**问题**：
- 任务 1.1 说"导出 `RESERVED_BODY_KEYS` 常量"
- 任务 2.1 说"保留键 refine（引用 `RESERVED_BODY_KEYS`）"
- 但 design.md 没有说明 `RESERVED_BODY_KEYS` 的具体导出位置（`config.ts`？`buildRequestBody` 所在模块？）和 replay 包的引用路径

**风险**：
- 实现时可能在两处各写一份键集，与"同一常量来源"的设计意图矛盾
- 未来如果 `buildRequestBody` 新增保留键（例如 `max_tokens`），维护者可能忘记同步

**建议**：
- 在任务 1.1 明确 `RESERVED_BODY_KEYS` 的导出位置（建议 `config.ts`，与 `SampleParamsSchema` 同文件）
- 在 `buildRequestBody`（`llm-client.ts`）的注释中引用此常量，提醒维护者同步更新

### P1-2 `reasoning` 与 `reasoning_content` 并存时的聚合语义未明确

design.md 第 2 节：

> 两字段并存于同一流时都计入（拼接语义，不做去重——真实 provider 不会两字段并发，去重反而引入启发式）。

spec（agent-loop）：

> 两字段 SHALL 聚合进同一思维链文本，trace 内部字段名恒为 `reasoning_content`；同一流中两字段并存时均计入

**问题**：
- "都计入"和"均计入"没有明确是**拼接**还是**去重**
- design.md 说"拼接语义"，但 spec 没有用这个词
- 如果 provider 真的同时发两字段（虽然 design 说"不会"），拼接结果会包含重复内容

**风险**：
- 实现时可能对"并存"做去重（启发式比较），引入不必要的复杂性
- 或者拼接后思维链长度翻倍，影响 ttft 计算（首 token 时间会提前）

**建议**：
- 在 spec 中明确："两字段并存时按出现顺序拼接，不做去重"
- 或者加一条注释："真实 provider 不会并发两字段；若出现，拼接结果是最佳努力聚合，不保证语义正确"

---

## P2：边界情况需要确认或补充测试

### P2-1 dry-run 明细的格式未在 spec 中固化

design.md 第 4 节给出了 dry-run 输出示例：

```text
arm 1：qwen3.5:4b-8k
  生效 params：temperature=0.7（覆盖）
  丢弃父录值：num_predict=768   ← 整体替换不合并，此项不会进入请求
  ⚠ num_ctx：Ollama /v1 静默忽略此参数（实测 2026-09-10）；绕行：派生模型
```

**问题**：
- spec（model-experiments）只说"dry-run 的展示 SHALL 包含每臂**最终生效 params**"，没有给出格式示例
- CLI 和桌面的展示格式可能不一致

**风险**：
- CLI 实现时可能用 JSON 格式输出，桌面用表格，用户难以对照
- 未来如果新增告警类型（例如"参数可能未生效"），格式可能需要扩展

**建议**：
- 在 model-experiments spec 的 dry-run scenario 中补充格式示例（至少一项）
- 或者在 design.md 中明确"CLI 与桌面复用同一格式模板"

### P2-2 CLI arm 语法的引号转义规则未明确

design.md 第 5 节：

> 4. 引号包裹（`key="123"`）→ 强制字符串。

**问题**：
- 没有说明引号内的转义规则（例如 `key="hello\"world"` 是否合法）
- 不同 shell 对引号的处理不同（bash vs PowerShell vs Windows CMD）

**风险**：
- 用户输入 `key="hello\"world"` 时，解析器可能行为不一致
- 如果支持转义，需要定义转义字符（反斜杠？双引号？）

**建议**：
- 在 design.md 或 tasks.md 明确引号内的转义规则
- 或者简单起见，不支持引号内的转义（遇到引号就报错，或按字面量处理）

---

## P3：文档化改进（可选）

### P3-1 `RESERVED_BODY_KEYS` 常量应导出并文档化

design.md 第 1 节末尾：

> 保留键集 = `model` / `messages` / `tools` / `stream` / `stream_options`（与 `buildRequestBody` 构造的固定键一致；`llm-proxy` 的 fork 请求体构造 `buildForkRequest` 用同一集合）。

**问题**：
- `RESERVED_BODY_KEYS` 是一个关键常量，但 proposal 没有明确它的导出位置
- 如果未来有人修改 `buildRequestBody` 添加新保留键（例如 `max_tokens`），需要同步更新 `RESERVED_BODY_KEYS`

**建议**：
- 在 `agent-loop/config.ts` 中导出 `RESERVED_BODY_KEYS` 常量
- 在 `buildRequestBody`（`llm-client.ts`）的注释中引用这个常量，提醒维护者同步更新

---

## 其他观察

### 任务分解质量

tasks.md 的任务分解很细致，每个任务都有明确的验收标准。特别是：
- 任务 1.1 明确要求"单测覆盖标量合法、保留键拒绝、对象/数组/null 拒绝、既有数值配置回归"
- 任务 2.4 明确要求"单测覆盖四种解析与既有 `temperature=0.2` 回归"

这是好的实践。

### 未验证假设的显式列出

proposal.md 的"证据与验证口径"部分：

> 未验证假设（实现前 5 分钟可证伪）：
> - DeepSeek 对 `reasoning_effort` 的接受度——`curl -s $BASE/v1/chat/completions -d '{"model":"deepseek-chat","messages":[...],"reasoning_effort":"none"}'` 观察 200 或 400；
> - 标量 params 平铺后 DeepSeek/Ollama 对未知字符串参数是否仍 200——同法各测一条（若 400 则告警知识库需补"硬拒绝"类目）。

这是成熟的做法——显式列出未验证假设，并给出验证方法。

---

## 总结

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P1-1 | `RESERVED_BODY_KEYS` 的"同一常量来源"未落地 | 明确导出位置（建议 `config.ts`），replay 引用；在 `buildRequestBody` 注释中引用 |
| P1-2 | `reasoning` 与 `reasoning_content` 并存时的聚合语义未明确 | 在 spec 中明确"按出现顺序拼接，不做去重" |
| P2-1 | dry-run 明细的格式未在 spec 中固化 | 在 model-experiments spec 中补充格式示例 |
| P2-2 | CLI arm 语法的引号转义规则未明确 | 明确引号内的转义规则，或不支持转义 |
| P3-1 | `RESERVED_BODY_KEYS` 常量应导出并文档化 | 在 `config.ts` 导出，并在 `buildRequestBody` 注释中引用 |

修完 P1 和 P2 可以 apply。P3 是文档化改进，可以在实现过程中顺手做。
