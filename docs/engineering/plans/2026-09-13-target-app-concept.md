# 第三个项目（代号待定）· 概念提案 v0.1

> 日期：2026-09-13 · 状态：**待 owner 确认 §9 的四项后再动手**
> 由来：owner 拍板「AniPedia 按现有规划走，另起一个最适合 ReBaseAgent 的实验项目」，并补了一条真实需求——**现在自己的很多代码看不懂，面试又会问底层**。
> 性质：实验 + 自用 + 积累经验。第一目的是给 ReBaseAgent 提供**真实、可归因、可自动判分**的 trace。
> 约定：本目录属探讨类文档，按仓库约定不入库。

---

## 0. 一句话

**一个用自然语言问自己代码库的只读 Agent**，顺便把看不懂的地方变成面试题。
它回答时必须给出 `file:line` 引用；它的全部工具都是只读；它的每一条 run 都落成合法 trace 喂给 ReBaseAgent。

---

## 1. 为什么现在才提出来，以及为什么这次站得住

| | 09-10 那轮 | 这次 |
|---|---|---|
| 动作 | 把 AniPedia（已有产品）改成多步 agent | 新建一个项目 |
| 问题 | **为工具的 trace 好看而改造产品**——踩了"不能为工具叙事改造产品"这条红线 | 新产品本就是按工具的能力设计，**不存在迁就** |
| 理由结构 | 反向（工具需要 → 产品改） | 正向（我有真需求 → 顺带成为最佳 dogfood 目标） |

owner 的原话是「我做出来的工具我自己不用是没有意义的」。这条同时约束了两边：ReBaseAgent 需要真实 trace，而真实 trace 只能来自一个你自己天天开的应用。**本项目就是这条约束的解。**

---

## 2. JTBD（两个模式，一套工具）

| 模式 | 用户此刻在想什么 | 一句话 job |
|---|---|---|
| **A · 读懂** | "这段 IPC 到底怎么从 renderer 到 main 的？" | 在不打断工作流的前提下，把一段陌生代码解释清楚，并给出可跳转的出处 |
| **B · 面试 drill** | "面试官要是问我事件循环/允用队列怎么办？" | 基于**我真实写过的仓库**出题、给参考答案、再追问一层底层 |

模式 B 是这次新增的真实需求，也是本项目的差异化：市面上面试题是通用题库，这里的题是从你的代码里长出来的，因此**可验证**——答案必须能指向真实存在的 `file:line`。

---

## 3. 形态：`file:line` 引用 + 四步短轨迹

```text
① llm.call   system + 「xxx 是怎么工作的？」
       ↓ tool_calls
② tool.invoke  search_code(pattern, path_glob)      → 候选符号/文件
       ↓
③ llm.call   判断要看哪几处
       ↓ tool_calls
④ tool.invoke  read_span(path, from, to) / git_log(path)
       ↓
⑤ llm.call   输出解释，每个结论带 file:line
```

工具表（**全部只读、幂等**，Phase 1 只有四个）：

| 工具 | 参数 | 副作用 |
|---|---|---|
| `search_code` | `{ pattern, path_glob?, max_hits }` | 无 |
| `read_span` | `{ path, from, to }` | 无 |
| `git_log` | `{ path?, limit }` | 无 |
| `list_repos` | `{}` | 无 |

**刻意不做的事**：不提供 `apply_patch` / `run_command`。写操作留给 A3（隔离世界真重跑）之后再说——届时它会天然解锁。

---

## 4. 对齐调试器奖励结构的八条硬要求

这些不是偏好，是我从 ReBaseAgent 现网代码里倒推出来的约束，逐条有出处：

| # | 要求 | 出处 |
|---|---|---|
| 1 | **用 TypeScript / Node 写** | 工具要在 Electron 主进程注册；AniPedia 路线的最大沉没成本就是 Python→TS 的跨语言桥，新项目没有历史包袱可以直接绕开 |
| 2 | **SDK 埋点，不用录制代理** | 代理录的 run 没有 `config_hash`，D-A 落地前**不能作为 fork 父本**（`handler.ts:298` / `fork-parent.ts:54-57`） |
| 3 | 工具由**模型**发起 `tool_calls`，不由代码硬编排 | `derive.ts:76-104`：tool-result replay 的语义前提 |
| 4 | run 短（**3–6 span**） | A2 共享前缀重跑未做，现在任何重跑都是**整轮** |
| 5 | A/B 变量**数值化** | V3b 的 arm params 是 `Record<string, number>`，`boolean` 开关传不进去 |
| 6 | 工具**只读 / 幂等** | `sideEffect` 分级 + `allowSideEffects` 逃生舱；少副作用 = 少门禁 |
| 7 | 工具参数形状稳定 | Trace-as-Test 结构对齐会比对 args 形状，塞时间戳/随机 id 会误判 drift |
| 8 | **引用必须落到 `file:line`** | 这是让失败可归因的唯一办法，也是 §5 自动判据的基础 |

---

## 5. 评测：先有客观判据，再写产品

这是本项目能不能配得上"实验"两个字的关键。**ReBaseAgent 不做判分（V3b spec 用 SHALL NOT 写明不做自动评分/最佳模型推荐），判分必须由本项目自己提供。**

### Gold set（硬前置，25 题）

每题手工标注三项，不依赖任何 Agent：

```json
{ "id": "q07",
  "question": "shortcuts IPC 从 renderer 到 main 经过了哪几层？",
  "gold_files": ["apps/desktop/src/preload/index.ts", "apps/desktop/src/main/ipc.ts"],
  "gold_symbols": ["runs:fork", "contextBridge"] }
```

### 自动指标（零 LLM-as-judge）

| 指标 | 怎么算 | 判什么 |
|---|---|---|
| **检索召回 recall@5** | 首个 `search_code` 的命中里有没有 gold file | 工具选的对不对 |
| **引用路径存在率** | 答案里每个 `file:line` 的路径是否存在 | 硬幻觉 |
| **行内真值率** | 该行是否真的含 gold_symbol | 软幻觉（路径对、内容不对的那种） |
| **工具调用数** | 一条 run 几个 tool.invoke | 成本控制（A2 之前 = 整轮重跑成本） |

### 主观指标

挑 10 题做 4 级人判（答非所问 / 沾边 / 可用 / 能直接拿去回答面试官），由你自己判，一天能跑完。

### 纪律（继承 ReBaseAgent §5 那条）

任何 A/B 报告必须带**失真清单**：模型版本、`temperature`、`num_ctx`、`think` 是否生效、是否冷启动，结论限定在被验证的范围。

---

## 6. 现在能拿到什么，什么时候解锁

诚实地说清楚，避免又出现"承诺不是事实"：

| 能力 | 今天能用吗 | 说明 |
|---|---|---|
| 录制 + 查看 + 分支树 | ✅ | SDK 埋点天然满足全部硬门槛 |
| **Trace-as-Test 卡带回归** | ✅ | 卡带模式按 `(工具名, 调用序号)` 桩回放 tool.invoke，**不需要真实执行工具** ⇒ 有工具的 run 今天就有回归价值 |
| prompt fork | ⚠️ 待接通 | 需要桌面/CLI 侧能执行工具才行 |
| 模型 A/B（CLI） | ❌ 现在不行 | V3b CLI 首期**只支持空工具表**（`require_empty`） |
| **工具级分叉 / 改检索结果重跑下游** | ❌ 现在不行 | 桌面 handler 白名单只有 `read_file`/`write_file`；要等 **A3 隔离世界真重跑**或白名单扩展 |

**但这不影响现在开始。** 一句关键的判断：

> **trace 是资产，重跑能力随时间解锁。**
> 今天埋下去的 `tool.invoke` span，在 A3 落地那天会自动获得"改结果 + 只重跑下游"的能力，**不需要重新埋点**。反过来，如果为了今天能跑 A/B 而把项目退化成单轮无工具形态，等 A3 来了还得返工。

所以形态从一开始就按 §3 的真工具链来设计，只是**不指望今天就用上全部能力**。

---

## 7. 阶段与验收

| 阶段 | 内容 | 验收判据 | 依赖 |
|---|---|---|---|
| **P0** | Gold set 25 题 + 评判脚本（纯手写，不上 Agent） | 能跑出当前 baseline（你自己人工检索）的分数 | 无 |
| **P1** | TS 骨架 + 4 个只读工具 + SDK 埋点 + CLI 问答 | ① 一条 run 落进 `.rebaseagent/traces/`，`rebaseagent-trace-test` 跑绿 ② §5 四项自动指标出数 | `@rebaseagent/trace-sdk` / `agent-loop` |
| **P2** | 批量跑 gold set，出第一份带失真清单的报告 | 25 题全部有数；至少一次 A/B 或 prompt fork 对照 | P1 |
| **P3** | 面试 drill 模式（出题 + 追问 + 错题本） | 生成 20 道题且引用校验通过率 ≥ 阈值（阈值在 P0 一并定死） | P2 |

每阶段独立可验证，**任何时候都可以停**——这跟 AniPedia 那轮的教训一致：先把"值不值得"压缩成一个能跑出来的数字。

---

## 8. Non-goals

- **不改代码**（没有写工具、不走 shell）——至少在 A3 之前
- **不与 AniPedia 共享检索底座**（Chroma/Bangumi 那一套不进来）
- **不上传任何代码或 trace 到云端**（本地优先，符合 ReBaseAgent 卖点）
- **不做 IDE 插件 / 编辑器集成**（零摩擦接入以 SDK 埋点为主线）
- **不为了 trace 好看增加工具**：工具只有四个，每个都必须回答"用户为什么需要它"
- 不替代 WorkBuddy / Cursor 之类的编码助手——本项目是**读懂**，不是**帮你写**

---

## 9. 需要你拍的四件事

1. **项目名 + 仓库位置**：独立仓库（推荐，避免污染 ReBaseAgent 主线）还是 ReBaseAgent monorepo 里的第三个 app？候选名：`AskMyCode` / `SourceLine` / `ReadBack`
2. **依赖自家包的方式**：`file:` 链接 vs 发 npm 包（`@rebaseagent/*` 目前没发过）
3. **首批索引的仓库范围**：全部 11 个项目，还是先 ReBaseAgent + AniBox 两个最熟的
4. **模型策略**：纯本地 Ollama（零费用、TTFT 受 `think`/`num_ctx` 影响）还是接受一个便宜的付费 provider

---

## 10. 与其他计划的关系

- **AniPedia**：维持单轮 + dogfood P3 速度专项，不再为本项目让路
- **ReBaseAgent 主线**：D-A → D3 → A1 → A2/A3。**本项目是 A3 的受益者**，也是 A2/A3 落地时现成的验收对象
- 不抢占 ReBaseAgent 主线的开发时间：P0（gold set）零开发，可以立刻开始
