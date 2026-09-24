# `direction-2026H2.md` 二审记录（2026-09-10 · WorkBuddy 自查）

> 被审对象：`docs/product/direction-2026H2.md`（v2.1）
> 一审记录：`docs/reviews/2026-09-10-direction-2026h2-review.md`（外部模型，结论「通过」）
> 二审执行：WorkBuddy，**在 ReBaseAgent 工作区独立复现 + 本机实测**（非文档复述）
> 方法：① 独立复跑测试矩阵；② 核对一审引用的行号是否真实；③ **用本机 Ollama 做参数保真度实验**；④ 跨语言复刻 `config_hash` 并比对字节
> 结论：**文档方向成立、可执行，但 §4.1「AniPedia 是 V3b 的理想适配场景」需要降级**——实测发现 V3b 走的 OpenAI 兼容路径**无法忠实传达 AniPedia 的两个关键生成参数**（静默失效，无报错），dogfood 的结论边界必须写明。

---

## 一、对一审的复核

### 1.1 一审引用**属实**（我上一轮的怀疑不成立，特此更正）

我上一轮在一审记录里加注「前两条实为读 `HANDOFF.md` 而非独立复现」。二审逐行核对了它的行号引用，**全部真实存在且内容对得上**：

| 一审引用的位置 | 实际内容 | 判定 |
|---|---|---|
| `HANDOFF.md` §二 第 19-20 行 | 「主 spec（现行行为契约，**10 个**）」「**11 个**已归档 change」 | ✅ 准确 |
| `HANDOFF.md` §三 第 45-46 行 | 「测试全绿零 API（2026-09-10 逐包实测）… = 430」 | ✅ 准确 |
| `HANDOFF.md` §五 第 86 行 | 「dev 数据目录恒为 `<仓库根>/.rebaseagent`…`REBASEAGENT_TRACES_DIR` 不存在」 | ✅ 准确 |

→ 一审确实读了文件原文，「疑似没真读」的暗示是我判断错误。**但它对「430 全绿」的确认方式仍是"与文档一致"而非独立复现**；独立复现在二审完成（见 §1.2）。

### 1.2 我独立复跑的结果

六包逐包 `vitest run`（cwd = 包目录）：trace-sdk 75 / agent-loop 52 / replay 66 / llm-proxy 16 / trace-test 65 / desktop 156 = **430 全绿**。与文档、与一审一致 ✅

### 1.3 一审判断我认可的部分

- §3.1 把「代理倒挂」重新定义为漏斗问题、修补叙事而非修代理 —— **认可**，这是本轮最有价值的定性意见
- Auto-Judge 归应用层、无更好切法 —— **认可**
- 定位张力在 dogfood 之后、下一个大功能立项前重开 —— **认可**
- 多题批量「值得补但不是现在」+ 先手动跑 40 次当需求探针 —— **认可**

### 1.4 一审有一处表述不准确

> 一审：「② `ttft_ms` 与 `usage` 要自造……接受它是合理近似。」

**部分不准确。** 实测：V3b 走的是 OpenAI 兼容端点，**`usage` 由 provider 直接返回**（`{"prompt_tokens":21,"completion_tokens":207,...}`，流式也带），**不需要自造也谈不上近似**。"自造/换算"只发生在**AniPedia 手写的父 trace** 上（`/api/generate` 给的是 `prompt_eval_count` / `eval_count`）。这条要拆成两半说，否则会让人以为整个 dogfood 的数字都是估算的。

---

## 二、二审的新发现（一审与文档都没提，实测得出）

### F1 ⚠️ `num_ctx` 在 OpenAI 兼容路径被**静默忽略**

`num_ctx` 是 AniPedia 系列题不截断的必要条件（`answer.py` 注释：默认 4096 会把输出挤死，实测 prompt 4010 token）。

**实验（干净环境，先卸载模型）**：

```text
卸载后                    → 实例数=0
/v1/chat/completions 顶层 num_ctx=8192 → 实例数=1  ["qwen3.5:4b@4096"]   ← 未采纳
/api/generate options.num_ctx=2048     → 实例数=1  ["qwen3.5:4b@2048"]   ← 采纳
```

- 判据用 `/api/ps` 的 `context_length`（模型实例实际加载的上下文窗口）
- `/v1` 路径**无报错、无警告**，HTTP 200，只是不生效

**后果**：V3b 的臂一律落在默认 4096。系列题（prompt ≈ 4000 token）**必然截断**（`done_reason=length`）→ 臂的回答变差**不是因为换了模型，而是因为上下文窗口没配上**。这会把「模型 A/B」悄悄变成混合实验。

**为什么之前没人发现**：V3b 冒烟的父 run 是 `create-ab-parent.mjs` 现造的一句话任务（prompt 21 token），**根本碰不到上下文窗口边界**，所以冒烟全绿掩盖了这个问题。

### F2 ⚠️ `think: false` 在 OpenAI 兼容路径无效 → 默认思考，小 `max_tokens` 下正文**为空**

AniPedia 生产用 `think: False`（`/api/generate` 顶层字段）；V3b 的 arm params 只能是**数值**（`Record<string, number>`），布尔本来就传不了——但实测发现**即使传了也没用**：

| 路径 | 请求 | 结果 |
|---|---|---|
| `/api/generate` + `think:false` | 问「1+1」 | `response="2"`，**`eval_count=2`**（零思考） |
| `/v1/chat/completions`（默认） | 同上 | `content="2"`，但 `completion_tokens=207`、`message.reasoning` 有 1849 字符 |
| `/v1` + `max_tokens=32` | 同上 | **`content=""`（正文为空，token 全被思考吃掉）** |

「正文为空」这一现象我在三轮实验里**复现了三次**（`max_tokens` 32 全空 → 256 才出 `"2"` → 300 全空 → 1500 才出）。

**后果**：dogfood 的臂会在**思考模式**下生成，而 AniPedia 生产是关闭思考的 → 臂的输出形态、token 量都与生产不可比（同一问题：**432–2160 completion tokens vs 生产 eval_count=2**，差两个数量级）。若 dogfood 的臂被报告为「某模型变差了」，那很可能是**思考模式**造成的，不是模型。

### F3 ⚠️ 字段名不匹配：Ollama 给 `reasoning`，trace schema 要 `reasoning_content`

- Ollama `/v1` 的 message 字段是 `role, content, reasoning`
- `packages/agent-loop/src/llm-client.ts:195` 只读 `delta.reasoning_content`

**后果**：经 V3b 产出的 trace，`response.reasoning_content` 恒为 `null`。**不阻塞**（schema 是 `string | null`，trace 仍合法），但**思维链内容被丢弃**，而它的 token **照样计入 `usage.out`** → 数字里含一笔看不见的开销。

### F4 ✅ 好消息：`usage` 由 provider 直接给，`ttft` 可实测

- 流式（`stream:true` + `stream_options.include_usage`）能拿到 `usage`：`{"prompt_tokens":21,"completion_tokens":216,...}` ✅ 与 §一 1.4 对应
- 流式下 `ttft` 可测得（实测 3166ms）✅ 但注意：这 3166ms 是**首个 reasoning 片段**的时间；生产路径（关闭思考）的 ttft 是**首个正文字**的时间 → **两条路径的 ttft 语义不同**，不要混比

### F5 ✅ 降低摩擦：CLI 的 `systemPrompt` 是**自动从父 run 派生**的

`model-ab-cli.ts:184-192`：`systemPrompt` 从父 run 首次 `llm.call.request.messages` 的 system 消息取（取不到则留空串，由双真相源校验给出精确报错）。

→ **40 题不需要 40 份 `--config` 模块**（`ConfigModule` 只有 `baseURL / cwd / maxIterations / budget`，没有 systemPrompt）。一个 `--base-url` 就够。这条把 §3.4 的"40 次独立调用"摩擦降了一档。

### F6 ✅ 实测确认：`config_hash` 跨语言复刻可做到**逐字节一致**

用 AniPedia **真实的 SYSTEM_PROMPT**（从 `answer.py` 提取，847 字符）实算：

| 实现 | 结果 |
|---|---|
| JS（`packages/agent-loop/dist` 的 `configHash`） | `sha256:f0d043ffc1cc8e4640dbdff8f0242dacdc5adbd2fab36c6ebf61a6db4743fbea` |
| Python 候选复刻（`ensure_ascii=False` + `separators=(",",":")` + `sort_keys=True`） | `sha256:f0d043ffc1cc8e4640dbdff8f0242dacdc5adbd2fab36c6ebf61a6db4743fbea` ✅ **一致** |
| Python **误用** `ensure_ascii` 默认值 | `sha256:49b89497fe6394f1efcfb7b618cdd61f8cb89c70400600b27043f655ba9f1a1a` ❌ 完全不同 |

→ §4.1 那条硬约束被实证；且 **Python 侧可直接抄的实现已就位**（见文末附录）。`num_ctx` 那类坑是"静默失效"，而这个坑是"静默不等"——**不测就一定会踩**。

---

## 三、对 v2.1 文档的具体修正建议

| 位置 | 现状 | 建议改为 |
|---|---|---|
| §4.1 结论 | 「AniPedia 恰好是纯对话——**这是 V3b 的理想适配场景**」 | 降级为「**结构上适配**（纯对话、空工具表、单请求），但**参数保真度上有实测缺口**（F1/F2），dogfood 结论只能用于验证『V3b 链路能否在真实 trace 上跑通』，**不能用于评估模型好坏**」 |
| §4.1 provider 表 | 只列了哪些参数「可作变量」 | 补一行「**实测失效**」：`num_ctx`（/v1 静默忽略）、`think`（/v1 无效，且非数值本就不可传）；另标注 `presence_penalty` **倾向生效但未定论**（temperature=0 下 pp=0/1.5 的 completion_tokens 为 762/432，但 reasoning 长度本身有波动） |
| §8 风险 | 「`usage` / `ttft_ms` 要自造」「arm params 只接受数值」 | 前者按 §1.4 拆分改写；后者升级为「**不止是表达力缺口**：`num_ctx` 与 `think` 在 OpenAI 兼容路径实测静默失效，会实质性改变臂的输出质量与 token 量」 |
| §7 问题 6 ③ | 只谈 `tools: []` | 补一条：**dogfood 前必须决定**——是接受 F1/F2 的失真（并把结论限定为链路验证），还是先给 V3b 加「provider 原生参数逃生舱」（例如允许 arm 声明一段透传给 provider 的原始 options） |
| §4.1 新增 | — | 补「**冒烟为何没发现**」：现造父 run 的 prompt 只有 21 token，碰不到上下文窗口边界，故 F1/F2 在冒烟中不可见 |

---

## 四、我没能定论的部分（诚实声明）

1. **`presence_penalty` 是否真的生效**：观察到 `pp=0 → 762 tokens` vs `pp=1.5 → 432 tokens`（temperature=0），倾向生效；但 reasoning 长度存在自然波动（同一请求两次分别 207 / 216），**未做重复性统计**，不足以定论。
2. **真实 AniPedia prompt（≈4000 token，含检索资料）下的端到端行为**：本次只用极短 prompt 验证机制，没有跑真实的系列题（需 Ollama 已加载 + 完整检索链路）。
3. **F1 的规避是否可行**：理论上可在**桌面端**路径绕过（桌面端也走 agent-loop 的 `buildRequestBody`，同样平铺 → 同样受限），故「换桌面端」**不解决** F1/F2；但这一条我只做了源码推断，**没有在桌面端实跑验证**。
4. **40 次手工调用的实际耗时/可行性**：未测。

---

## 五、二审结论

1. **文档方向与里程碑仍然成立**（先 dogfood、零新功能、零成本），一审的定性意见我也认可。
2. **但「理想适配场景」这个判断要降级**：实测 F1/F2 说明 V3b 当前无法忠实复现 AniPedia 的生产生成条件，且失效是**静默的**（无报错）——这比"缺个布尔参数"严重，因为它会让人把「思考模式 + 上下文窗口差异」误读成「模型差异」。
3. **可执行的折中**：dogfood 照跑，但把结论口径限定为「V3b 链路在真实 trace 上端到端跑通 + 暴露首期参数保真度缺口」；**模型好坏的结论留到参数保真度补齐之后**（这正好给 §3.4 的"是否补表达力"提供了一个由实测背书的立项理由）。
4. **顺带一个产品启示**：F1/F2 是**任何**用 Ollama / 非标准 provider 的用户都会踩的坑（静默失效最难查）。ReBaseAgent 若要吃"本地优先"这批用户，**provider 参数透传与生效性校验**可能比 V3b 的下一个功能更值钱。

---

## 附录：AniPedia 侧可用的 `config_hash` 复刻实现（已实测与 JS 逐字节一致）

```python
import hashlib, json

def config_hash(system_prompt: str, tools: list) -> str:
    """复刻 packages/agent-loop/src/config-hash.ts：
    sha256(规范化 JSON of {systemPrompt, tools})——键排序、工具按 name 排序、无空白。
    ⚠️ ensure_ascii=False 是硬要求（默认 True 会把中文转义成 \\uXXXX，指纹必然不等）。
    """
    canonical = {
        "systemPrompt": system_prompt,
        "tools": sorted(
            [
                {
                    "description": t["description"],
                    "name": t["name"],
                    "parameters": t["parameters"],
                    **({"sideEffect": t["sideEffect"]} if "sideEffect" in t else {}),
                }
                for t in tools
            ],
            key=lambda t: t["name"],
        ),
    }
    blob = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return "sha256:" + hashlib.sha256(blob).hexdigest()
```

实测（AniPedia 真实 SYSTEM_PROMPT，847 字符，`tools=[]`）：
`sha256:f0d043ffc1cc8e4640dbdff8f0242dacdc5adbd2fab36c6ebf61a6db4743fbea` — 与 JS 实现一致。

---

## 附录 B：参数保真度探针（可复跑，零费用）

结论 F1/F2 的复现脚本。**判据不是看响应内容，而是看 `/api/ps` 里模型实例实际的 `context_length`** —— 这是"参数是否真的生效"唯一可靠的可观测面（响应体里不回声 options）。

```js
// node probe-provider-params.mjs（需本地 Ollama 已启动、模型已拉取）
const V1 = "http://127.0.0.1:11434/v1/chat/completions";
const H = { "Content-Type": "application/json", Authorization: "Bearer ollama" };
const P = "http://127.0.0.1:11434";

async function instances(label) {
  const p = await (await fetch(`${P}/api/ps`)).json();
  console.log(`[${label}]`, (p.models ?? []).map((m) => `${m.name}@${m.context_length}`));
}
async function unload(model) {
  await fetch(`${P}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, keep_alive: 0 }),
  });
  await new Promise((r) => setTimeout(r, 1500));
}

await unload("qwen3.5:4b"); await instances("卸载后");
// OpenAI 兼容路径：顶层 num_ctx —— 预期「不生效」
await fetch(V1, { method: "POST", headers: H, body: JSON.stringify({
  model: "qwen3.5:4b", messages: [{ role: "user", content: "hi" }], max_tokens: 2, stream: false, num_ctx: 8192 }) });
await instances("/v1 顶层 num_ctx=8192 后");
// 生产路径：options.num_ctx —— 预期「生效」
await unload("qwen3.5:4b");
await fetch(`${P}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "qwen3.5:4b", prompt: "hi", stream: false, options: { num_ctx: 2048, num_predict: 1 } }) });
await instances("/api/generate options.num_ctx=2048 后");
```

实测输出（2026-09-10）：

```text
[卸载后] []                                          ← 干净起点
[/v1 顶层 num_ctx=8192 后] ["qwen3.5:4b@4096"]        ← 未采纳（无报错）
[/api/generate options.num_ctx=2048 后] ["qwen3.5:4b@2048"]  ← 采纳
```

思考模式（F2）复现：同一问题分别走两条路径，比对 `eval_count` / `completion_tokens`（生产路径 `think:false` 时为 **2**，`/v1` 默认路径 **207–762**），并注意 `/v1` 在 `max_tokens` 偏小时 `content` 会**整段为空**。
