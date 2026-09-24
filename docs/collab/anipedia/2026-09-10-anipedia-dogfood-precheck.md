# AniPedia × ReBaseAgent dogfood · 前置实测报告

> **来源**：AniPedia 侧实测产出，为 `docs/engineering/plans/2026-09-10-dogfood-plan.md` 的 P0–P2 提供依据。副本置于本仓库 `docs/` 便于对照引用。
> 日期：2026-09-10 · 环境：本机 Ollama 0.33.2（`qwen3.5:4b`，RTX 3060 6GB，全部本地、零费用、零数据出境）
> 复现脚本在 AniPedia 工作区（`D:\AniPedia\.workbuddy\dogfood-probe\probe_tokens.py` / `probe_distortion.py`）——它们 import AniPedia 的 `ask`/`answer`/`structured`，**只能在 AniPedia 侧运行**，故不随本文件复制。
> 口径：所有数字来自 Ollama 返回的 `prompt_eval_count` / `eval_count` / `usage.completion_tokens`，非字符估算。

---

## 一、结论先行

**方案 §七 里被列为「可能」的风险，实测是「必然」：走 V3b 的 `/v1` 路径，臂的 `content` 会是空字符串。**

原因是 Qwen3.5 的思考模式会把 `max_tokens`（= 生产 `num_predict` 768）整段吃掉。这直接导致 **P2 的验收判据「两臂能并排展示」无法达成**——两个臂都是空的。

**绕行办法已验证有效且零成本**：注入 `reasoning_effort:"none"`（P2.5 路 A 的 shim），输出与生产路径**逐字一致**。
→ **P2.5 路 A 不是「可选」，应从「P2.5（可选）」提升为 P2 的必要前置。**

---

## 二、实测 1：候选题的真实 prompt token 数

判据：`/api/generate` + `num_predict=1` + `options.num_ctx=16384`（窗口开大以免截断），读 `prompt_eval_count`。
口径含系统提示（`SYSTEM_PROMPT`，847 字符）+ 资料块 + 问句，与生产一致。

| 题 | 类型 | 资料块 | prompt 字符 | **prompt tokens** | +768 vs 默认窗口 4096 |
|---|---|---|---|---|---|
| Q1 | fact | 8 | 2904 | **2532** | 3300 ✅ 未超 |
| Q12 | series | 8 | 2775 | **2483** | 3251 ✅ |
| Q26 | rec | 8 | 2817 | **2449** | 3217 ✅ |
| Q11 | series | 8 | 2492 | **2415** | 3183 ✅ |
| Q32 | plot | 8 | 1908 | **1949** | 2717 ✅ |
| Q19 | compare | 8 | 1806 | **1893** | 2661 ✅ |
| Q33 | plot | 8 | 1986 | **1842** | 2610 ✅ |
| Q3 | fact | 8 | 1938 | **1765** | 2533 ✅ |
| Q2 | fact | 8 | 1730 | **1761** | 2529 ✅ |
| Q23 | filter | 7 | 1046 | **1198** | 1966 ✅ |
| Q16 | compare | 4 | 655 | **996** | 1764 ✅ |
| Q15 | series | 3 | 426 | **854** | 1622 ✅ |

**发现：没有任何一题接近 4096 边界（最高 2532，占默认窗口 62%）。**

→ 这**推翻了 AniPedia 项目记忆里「系列题 prompt 实测 4010 token」**的说法（实测 Q11=2415、Q12=2483，与之差 1.6 倍）。该旧数字已不可复现，应作废。

→ **「prompt 长度」不是首期的真风险**：真风险是思考模式也占用同一份 4096 窗口与 `num_predict` 预算（见实测 2）。

---

## 三、实测 2：同一 prompt 在三条路径下的输出（决定性）

题：`《鬼灭之刃》是由哪家公司制作的？`（prompt 1730 字符 / 1761 tokens，与生产一致，资料 8 块）

| # | 路径 | 耗时 | content | reasoning | completion_tokens | finish_reason |
|---|---|---|---|---|---|---|
| **A** | 生产 `/api/generate` + `think:false` | 1.4s | **24 字符** | — | 16 | `stop` |
| **B** | 臂 `/v1/chat/completions` 默认（思考开） | 20.0s | **0 字符（空）** | 2380 字符 | 768（= max_tokens 上限） | **`length`** |
| **C** | 臂 + shim `reasoning_effort:"none"` | 0.3s | **24 字符** | 0 字符 | 16 | `stop` |

正文逐字对比：

```text
A 生产   : '《鬼灭之刃》由 ufotable 制作 [1]。'
B 臂默认 : ''                                  ← 思考把 768 预算吃光，正文为空
C 臂+shim: '《鬼灭之刃》由 ufotable 制作 [1]。'   ← 与 A 逐字一致
```

**四条可执行结论：**

1. **B 是必然失败，不是概率失败**：`completion_tokens` 精确停在 768（上限）、`finish_reason=length`、正文空。这不是采样波动。
2. **失真不是「形态略有不同」，而是「零信息」**——若按方案 D2 选①「接受思考模式」，P2 拿到的两臂都是空内容，「链路跑通」无从证明。
3. **C 与 A 逐字一致**（同样 24 字符、同样 `completion_tokens=16`）→ shim 把失真从「质变」降到「无」。**`think` 这条失真不必接受，30 行转发就能消除。**
4. **shim 顺带快 60 倍**（0.3s vs 20.0s），因为它省掉了全部思考开销。

---

## 四、对执行方案的三条修正建议

| 方案原文 | 建议改为 | 依据 |
|---|---|---|
| D2：`think` 首期处置「① 接受思考模式」 | **改选「② 挂 shim」**，并把它从 P2.5 提前到 P2 前置 | 实测 2-B/C：接受 = 臂输出为空，链路无法证明 |
| P2.5「（可选）需要数字口径时」的路 A | **去掉「可选」**，作为 P2 的进入条件（约 30 行本地转发） | 同上；且它同时消除 `think` 与 `num_ctx` 两个失真源 |
| §七 风险「窗口仍不够（系列题 prompt ≈ 4000 token）」 | 降级：**prompt 上界实测 2532 tokens**，单看 prompt 不会撞窗口；真风险是**思考占用同一预算** | 实测 1 全表 |
| §二 表「`presence_penalty` 生效性未定论」 | 首期**两侧都固定 0**、不当变量即可，无需先定论 | 实测里 pp=0 路径 A/C 均 `stop` 正常 |

---

## 五、失真清单（首期 A/B 报告须随附）

以下为「实验条件 vs 生产」的全部已知差异。**只要用了 shim，前两条即归零。**

| # | 差异项 | 生产 | 臂（无 shim） | 臂（有 shim） |
|---|---|---|---|---|
| F1 | 思考模式 | 关闭（`think:false`） | **开启** → 正文为空 | 关闭（`reasoning_effort:"none"`）✅ |
| F2 | 上下文窗口 | `num_ctx=8192` | 随模型名（默认 4096） | 需 `ollama create` 派生模型 → 8192 —— **2026-09-10 双方已对齐：对照臂也派生 `qwen3:1.7b-8k`，两臂同为 8192**（对方已建并验证 `/api/ps` 显示 `@8192`） |
| F3 | 思维链字段 | 不收 | `reasoning`，`llm-client.ts` 只读 `reasoning_content` → **COT 丢弃但 token 计入 `usage.out`** | 同左（思考为 0 后无影响）✅ |
| F4 | `meta.model` | 实跑 `qwen3.5:4b` | 需记为派生名（如 `qwen3.5:4b-8k`）以带入窗口 | 同左 |
| F5 | `usage` 口径 | `prompt_eval_count`/`eval_count` | provider 直给（无需换算） | 同左 —— **2026-09-10 对方实测：两条路径同一输入 → `651 = 651`，差值 0 → 此条不是失真，可划掉**（出处：对方方案附录 A-3b） |
| F6 | 检索 | — | **臂不重跑检索**（深拷贝父 run messages）→ 各臂共享同一资料集 | 同左（也是优点：消除检索随机性） |

**结论限定**：即便用 shim，本次 A/B 仍只证明「V3b 链路能在真实 AniPedia trace 上端到端跑通」；**模型优劣**仍需判分口径（Auto-Judge 未落地）才能谈。

---

## 六、环境残留

实测后已 `keep_alive=0` 卸载模型（`/api/ps` 已空）、终止临时 `ollama serve`。无残留。
