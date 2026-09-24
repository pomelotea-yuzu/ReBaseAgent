# AniPedia × ReBaseAgent · dogfood 执行方案（v0.7）

> 日期：2026-09-10 · 状态：**待拍板**（决策点见 §六；D2 已按实测改判）
> 依据：`docs/product/direction-2026H2.md`（一审 `…-review.md` / 二审 `…-review-2.md`）+ AniPedia 侧前置实测 `docs/collab/anipedia/2026-09-10-anipedia-dogfood-precheck.md` + 本机臂级实测（附录 A）
> 目标：用 **AniPedia 自己产出的真实 trace** 跑通 V3b 的模型 A/B
> **一句话结论：首期不需要改 ReBaseAgent 一行代码**，但必须**先挂参数补丁 shim**（否则臂没有输出），并做一处绕行（上下文窗口 → 派生模型）。

---

## 〇、v0.2 修订说明（相对 v0.1）

| # | 改动 | 触发来源 |
|---|---|---|
| 1 | **D2 改判**：`think` 从「接受思考模式」改为「**挂 shim**」，并从"可选"提升为 **P2 的进入条件** | AniPedia 侧实测：真实 prompt（1761 tokens）下思考把 768 预算吃光 → 臂 `content` **整段为空**、`finish_reason=length`；挂 shim 后与生产**逐字一致**、还快 60 倍 |
| 2 | §七 风险行「系列题 prompt ≈ 4000 token」**作废** → 实测上界 **2532 tokens**（12 题全表） | AniPedia 侧实测 1；其项目记忆里的「4010 token」同样作废 |
| 3 | `presence_penalty` 从「未定论」降为**首期两侧固定 0、不当变量** | 同上 |
| 4 | P0-1 的 4 项工程债**按 AniPedia 侧结论重写**（3 项处置与原判断不同）；验收基线「26/29」**作废** → 先重跑定基线 | AniPedia 侧答复 §7 + 四个 eval dump 互相矛盾 |
| 5 | **新增 F7 失真项：`ttft_ms` 是假数据**（ReBaseAgent 缺陷，本次实测发现，见附录 A-3） | 本机臂级实测 |
| 6 | **新增参数继承规则实测**：臂不给 `params` → 继承父的**数值** params；臂一旦给 `params` → **整体替换（不合并）** | 源码 + `--dry-run` 实测（附录 A-2） |
| 7 | AniPedia 侧提出的三个「未验证假设」**全部确认成立**，其中第 3 条是**独立于 AniPedia 的缺陷**（见 §八） | 本机实测 |

**v0.3 修订（同日，AniPedia 侧第二次回信后）**

| # | 改动 | 触发来源 |
|---|---|---|
| 8 | **P2 命令改为两臂都用 8k 派生模型** —— 原方案存在**未受控变量**：派生臂 8192、对照臂 4096 | AniPedia 侧交叉发现（我们的实测缺陷）；已实测 `qwen3:1.7b-8k` 派生 + `/v1` 加载 `@8192` 成功 |
| 9 | §三 验收判据：**去掉对 `ttft_ms` 的任何数值要求**，改为 `usage.in/out > 0`；`ttft_ms` 仅作占位、不参与比较 | AniPedia 侧建议（F7 缺陷的结构性后果） |
| 10 | 新增：**`ttft_ms` 的用户可见影响** —— 桌面端 `DetailPanel.tsx:609` 展示「首 token 延迟 Nms」= 假数字 | 本机核实（不是 ComparePanel，见 §七 F7） |
| 11 | `usage` 口径**已实测一致**（`/api/generate` 的 `prompt_eval_count` vs `/v1` 的 `usage.prompt_tokens`：651 = 651，同 system+user）→ 失真清单 F5 可从"口径不同"降为"**同口径**" | 本机对照实测（回答 AniPedia 侧提问） |
| 12 | 臂 `params` 策略定为**「全不给」（继承父的数值 params）**，理由：唯一变量只剩 `model`，避免手写三个参数与父 run 写岔 | AniPedia 侧决定 |

**v0.4 修订（同日，`fix-llm-ttft-timing` 落地后）**

| # | 改动 | 触发来源 |
|---|---|---|
| 13 | **F7 根因已修并归档**：`ttft_ms` 取时点已从"读完流之后遍历缓冲"挪进 `parser.onEvent` 的流读取过程，`complete()` 在 `fetch` 前取 `sentAt` → 现为**真实的"首个含内容 delta 时刻 − 请求发出时刻"**。判据 = agent-loop 新增 4 个用例（在旧实现上会失败）；真机同路径对照 161ms（关思考）vs 20448ms（开思考） | change `fix-llm-ttft-timing`（已归档）；报告 `docs/engineering/reports/2026-09-10-fix-llm-ttft-timing-apply.md` |
| 14 | §九 D4 状态 → **已 apply 并归档**；§七 F7 风险行加注"根因已修，**旧 trace 仍不可信**" | 同上 |
| 15 | §三 验收判据的「去掉 ttft 数值要求」**维持不改**：根因虽修，但臂若开思考仍会因 F3（`reasoning` vs `reasoning_content`）得到"首**正文** token 时间" ⇒ 首期继续以 `usage.in/out > 0` 为主判据 | 同上（保守取用） |
| 16 | 附录 A-3 补"修复后"对照数据 | 同上 |

**v0.5 修订（同日，AniPedia 侧第四次回信后）**

| # | 改动 | 触发来源 |
|---|---|---|
| 17 | **§二 建议①（非流式诚实记 `0`）作废** —— AniPedia 生产**是流式**：`app/src/renderer/src/api.ts:72` 的 `askStream` 是唯一接线（`App.tsx:77`），非流式 `ask()`（`api.ts:51`）与 `POST /api/ask`（`server.py:273`）**均为死代码/死端点**。⇒ 父 trace 的 `ttft_ms` 取**②**：按 spec 口径实测「首个含内容 delta 的 chunk 与请求发出时刻之差」，起点取请求发出前 | AniPedia reply-4 + 我方逐行核实（含比其更硬的"死代码"证据） |
| 18 | **新增：冷启动会把「模型加载」计入 ttft** —— 真实跑前须把两个 `-8k` **各预热一次**、并确认 `/api/ps` 里两个模型**都在列且未过期**（原提醒只有"查窗口 `@8192`"）；父 trace 若在模型刚被卸载时记录，其 ttft 是冷启动值、须在报告注明 | 本轮推演（与"查窗口"同级、更隐蔽） |
| 19 | **新增：trace writer 加自洽性断言 `0 < ttft_ms < dur_ms`** —— 写入期即可拦住"解析耗时"（个位数/0）与"总耗时"（≈dur）两类错；该判据两侧共用，作为 P2 报告"数据质量"一节固定一行 | 同源判据（我方修复时即用此判） |
| 20 | **口径翻译（供 writer 注释）**：spec 的「内容 delta」是 OpenAI `/v1` 术语，native `/api/generate` 的对应物是**首个非空 `response` 字段**（`response` ≡ `delta.content`）；不改 spec，仅注明语义等价 | AniPedia 走 native NDJSON |

**v0.6 修订（同日，AniPedia 侧第五次回信后；含 3 次本机实测）**

| # | 改动 | 触发来源 |
|---|---|---|
| 21 | ⭐ **实测：两模型在本机不能共存** ⇒ "两个都预热"**不可能**。数据：`qwen3.5:4b@8192` = 3.27GB vram（载入 11.4s）；`qwen3:1.7b@8192` = 2.24GB（载入 7.5s，@512 仅 1.29GB —— KV 随窗口涨）；**载入后者会把前者挤出**（`/api/ps` 只剩 1 个）。⇒ **"至少一臂必然冷启动"是结构性事实**（后一臂的加载必挤掉前一臂，每批皆然）⇒ 预热降级为「**只预热第一个臂的模型**」+ **单独测两模型载入耗时作已知常数**（供读者估扣） | 本机实测（`/api/generate` + `/api/ps`） |
| 22 | ⭐ **实测：预热与臂走不同端点 ⇒ 窗口不一致会触发重载、预热白做**。数据：预热 `/api/generate options.num_ctx=2048` → `/api/ps@2048`；随后一个 `/v1` 请求 → `/api/ps@**4096**` 且该 1-token 请求耗时 **4.3s**（=重载）。根因：`/v1` 忽略 `num_ctx`（回落 Modelfile），`/api/generate` 尊重 `options.num_ctx` ⇒ **预热必须只按派生模型名、不传 `options.num_ctx`** | 本机实测 |
| 23 | `keep_alive` 格式：`"1h"` → 200；数字 `3600` → 200（**数字按秒**）；**裸数字串 `"3600000"` → 400**。生产若写字符串需改（1h 应为 `3600`） | 本机实测 |
| 24 | **自洽断言措辞收窄**：`0 < ttft_ms < dur_ms` **只覆盖"取时点类"错误**；"条件类"（冷启动）数值型态正常 ⇒ 只能靠条件检查。报告中分两行写，避免"已加断言 = 已保证可信"的错觉 | AniPedia reply-5 §3.1（成立） |
| 25 | **`dur_ms` 跨臂不可比**（不含输出长度；且"至少一臂必冷启动"）⇒ 速度一节必须 `dur_ms` 与 `usage.out` 成对、或给 tok/s 并声明局限（含加载 + 含思考 token）；**不做跨臂 `dur_ms` 比较** | AniPedia reply-5 §四（我方复算逐项一致） |
| 26 | 我方 CLI 与预热**不冲突**（实测：`packages/replay/src` + `agent-loop/src` 对 `keep_alive`/`/api/ps`/`unload`/`ollama` **零命中**——纯 OpenAI 兼容客户端）；唯一耦合是 #22 的窗口重载 | 本机 + 源码核实 |

**v0.7 修订（同日，AniPedia 侧第六次回信后）**

| # | 改动 | 触发来源 |
|---|---|---|
| 27 | ⭐ **否决"父 trace 改记派生模型名"** —— 会把 `arm1` 判成**空 fork 硬拒**：`packages/replay/src/prompt-fork.ts:242-248`（`value.model === parent.model && sameParams(...)` ⇒ `throw`；编排层判配置错误 ⇒ CLI **exit 2**；`--dry-run` 即暴露）。⇒ 改为 **(a)：父仍记基座 `qwen3.5:4b`**（=生产实况），臂用派生名 ⇒ **模型名不同自动过门禁**、"臂 params 全不给（继承父值）"策略保留；「arm1 热」改由**显式预热**拿到（checklist [2]）；**F4 保留为记账型失真**（一行说明）；**checklist [7]（跑臂前卸载基座）仍然必要** | 我方源码核实（回应 AniPedia reply-6 §四） |
| 28 | **不能靠"给臂略不同的 params"绕过 #27**：`answer.py:29-35 GEN_OPTIONS = {temperature:0, presence_penalty:0, num_predict:768, num_ctx:8192}` —— 三项数值均为确定性/长度必需，改任一即**真失真**；且编排层 **params 整体替换不合并** ⇒ 要给就得给全三项（正是当初想避的风险） | 同上 |
| 29 | **P2 不出速度表**（**撤回** v0.6 的"给 `dur_ms` 加免责声明"）：冷启动 ≈11 400ms ÷ 挂 shim 后真实生成 ≈180ms ≈ **63 倍** ⇒ 短答场景下 `dur_ms` 实为"模型加载计时器"。只发布两个**载入常数**与"本次两臂均含冷启动"这一条件；速度作为结论留 P3（需稳态 + 挂 shim + 与 `usage.out` 成对 + 多轮） | AniPedia reply-6 §五（比我方原建议更彻底，采纳） |
| 30 | **流程：本轮起转入异步** —— 双方已无互待问题（他们无阻塞项、我方无新问题）⇒ 停止"每条都确认一遍"的往返，等其一次性发**父 trace + dry-run 输出**，我方一次核对（重点：两臂 `改变：` 是否仅 `model` 一项、两臂窗口是否都 8192） | 收敛（当日已七封） |
| 31 | `keep_alive` 单位坑（对方自查发现）：`answer.py:175`/`:196` 用 `3600000` = **41.7 天**（注释写"1 小时"），而 `eval_rag.py:150` 写 `3600`——**同一项目两文件矛盾**。后果：基座被长钉占 3.3GB，与臂争显存（放大 #21） | AniPedia reply-6 §一 |

---

## 一、一页摘要

```text
P0   AniPedia 侧前置（工程债按新结论 + trace 写出器）   ← 全在 AniPedia，零 ReBaseAgent 改动
P1   落一条合法父 run（验收：--dry-run 过）
P1.5 挂参数补丁 shim（reasoning_effort:"none"）        ← v0.2 新增，P2 的进入条件
P2   1 题 × 2 臂真实 A/B（本地 Ollama，零费用）         ← 产出「链路跑通」结论
P2.5（可选）需要"原生口径"时：把 shim 的能力做进 ReBaseAgent（独立小 change）
P3   5 题探针 → 40 题回归（+ AniPedia 侧 Auto-Judge）
P4   CI + 定位重开（前置：P3 出结论）
```

**方案支柱**

1. **`num_ctx` 用「模型属性」绕开**（已实测）：`ollama create` 派生 `PARAMETER num_ctx 8192` 的副本，窗口随模型名带入 → 绕过"arm params 只收数值 + `/v1` 忽略 `num_ctx`"的双重限制。
2. **`think` 用 shim 归零**（v0.2 改判）：本地转发注入 `reasoning_effort:"none"` —— 实测输出与生产**逐字一致**（24 字符、`completion_tokens=16`、`stop`），耗时 0.3s vs 20.0s。

**非目标**（明确不做）

- 不改 ReBaseAgent 核心（trace v1 格式、fork 门禁、`config_hash` 语义、OpenAI 兼容协议）
- 不做多题批量编排层（先用 5 题手工探针拿需求证据）
- 不在 ReBaseAgent 侧做判分（V3b spec 用 SHALL NOT 明示）
- 不启动 P3 LoRA；**首期不对模型下优劣结论**（判分口径未落地）

---

## 二、参数保真：实测结论与绕行方式

AniPedia 生产用 `/api/generate` + `options` + 顶层 `think:False`；V3b 走 OpenAI 兼容 `/v1/chat/completions`，`params` 平铺到请求体顶层（`buildRequestBody` 的 `body[k]=v`）。

| 参数 | 生产写法 | V3b 现状 | 处置 | 依据 |
|---|---|---|---|---|
| `model` | — | ✅ 一等公民 | 用派生模型名（如 `qwen3.5:4b-8k`） | 附录 A-1 |
| `temperature` / `num_predict` | `options` | ✅ 数值可传 | 可作变量；**`num_predict` 必须显式给足** | 附录 A-2 |
| `presence_penalty` | `options`（必须为 0） | ⚠️ 可传 | **两侧都固定 0，不当变量**（无需先定论生效性） | AniPedia precheck §四 |
| **`num_ctx`** | `options.num_ctx=8192` | ❌ **静默忽略**（顶层 / 嵌套 `options` / 字符串三种写法都不认） | ✅ **派生模型**：`FROM qwen3.5:4b` + `PARAMETER num_ctx 8192` → `/v1` 加载即 `@8192` | 附录 A-1 |
| **`think`** | `/api/generate` 顶层 | ❌ 非数值传不了；**且 `think:false` 在 `/v1` 无效** | ✅ **shim 注入 `reasoning_effort:"none"`**（实测等同生产） | AniPedia precheck §三 |
| SYSTEM_PROMPT | 模块常量 | ❌ 不是 arm（属 prompt fork） | 静态常量 → 各题一致，非问题 | `answer.py:37` |

**两条必须记住的执行规则**

- **臂的 `params` 要么全不给、要么给全。** `prompt-fork.ts:243` 是 `value.params ?? parentParams`，而编排层把它**整体**塞进 `armConfig.params`（不合并）→ 臂只写 `temperature` 会**丢掉父的 `num_predict`**。两种后果都糟：继承 768 = 思考吃光正文为空；丢掉上限 = 思考跑到上下文满，token 涨约 10 倍（实测 out=1028 vs 生产 16）。
- **`num_ctx` 不要写进 `params`**：写了不生效，还会污染"相对父 run 是否真的变了"的判定。

**顺带否掉的两个方向**：`PARAMETER think false` 不被 Modelfile 支持（`unknown parameter`）；桌面端路径同样走 `buildRequestBody`，所以「换桌面端」不解决 `num_ctx`/`think`。

---

## 三、分阶段方案

### P0 · AniPedia 侧前置

**P0-1 工程债（按 AniPedia 侧结论重写）**

| 项 | v0.1 判断 | v0.2 结论（AniPedia 侧定） |
|---|---|---|
| `api.ts:99` SSE error 被吞 | 改 | **改，且是唯一建议前置**——它决定 P2 判据「无 provider 错误」是否看得见 |
| `server.py:88` health 恒 `ok` | 改 | **不改**：是 liveness/readiness 分层，前端 `App.tsx:141-148` 已按三分支消费；改反而把用户引向错误排查方向 |
| `data/anime_seed.json` 死代码 | 决策去留 | **不做删文件了事**：`common.py:10` / `build_index.py:29` / `ask.py:280` / `eval_rag.py:131` 共 4 处引用，`build_index` 会先打印"回退迷你数据集"再崩 → 四处一起改 |
| `server.py` 4 处 `read_text` 无缓存 | 复用 `structured._load()` | **换做法**：把 `_load()` 提升到 `common.py` 作公共 `load_animes()`，两处共用（不 import 私有函数） |

**P0-1 验收线作废**：v0.1 写的「不低于现状 26/29」是假线——四个 dump 互相矛盾（`eval_baseline_40` 22/29、`eval_after_filter` 26/29、`eval_after_pin` 29/29、`eval_zh_all` 27/29），且 `aecdaed` 修了判分器但没重跑 dump，commit 与 HANDOFF 声称的 29/29 与产物不符。→ **先重跑一次定基线**，再动工程债。

**P0-2 / P0-3**：trace 写出器（新文件 `src/trace_writer.py`，复用 `retrieve_smart()` / `build_prompt()` / `SYSTEM_PROMPT` / `config_hash`；给 `generate_stream()` 加可选出参以拿到 token 计数与首 token 时间，避免"录制版与线上版参数漂移"）+ `--dry-run` 冒烟。

### P1 · 落一条合法父 run（验收：`--dry-run` 退出码 0）

契约清单见 §四；落点固定 `D:\ReBaseAgent\.rebaseagent\traces\run_xxx.jsonl`。

### P1.5 · 挂参数补丁 shim（v0.2 新增，P2 的进入条件）

约 30 行本地转发：`--base-url` 指向它，对每个请求注入 `reasoning_effort:"none"`。验收：同一 prompt 经 shim 的输出与生产 `/api/generate` **逐字一致**。

### P2 · 1 题 × 2 臂真实 A/B（本地 Ollama，零费用）

```bash
# 1) 派生两个模型（一次，秒级无下载）——【v0.3 关键修正】两臂窗口必须一致
#    Modelfile_A = FROM qwen3.5:4b / PARAMETER num_ctx 8192
#    Modelfile_B = FROM qwen3:1.7b / PARAMETER num_ctx 8192
ollama create qwen3.5:4b-8k -f Modelfile_A
ollama create qwen3:1.7b-8k -f Modelfile_B
# 2) 起 shim（P1.5）→ 得到 http://127.0.0.1:11435/v1
# 3) 先离线核验：两臂 params 应显示为「继承父录值」、变更项只有 model
node packages/replay/dist/model-ab-cli.js \
  --parent <runId> --dir "D:/ReBaseAgent/.rebaseagent/traces" \
  --arm "qwen3.5:4b-8k" --arm "qwen3:1.7b-8k" --dry-run
# 4) 真实执行（params 全不给 = 继承父的数值 params）
REBASEAGENT_API_KEY=ollama node packages/replay/dist/model-ab-cli.js \
  --parent <runId> --dir "D:/ReBaseAgent/.rebaseagent/traces" \
  --base-url http://127.0.0.1:11435/v1 \
  --arm "qwen3.5:4b-8k" --arm "qwen3:1.7b-8k" --confirm-cost
```

> **为什么两臂都要派生**：窗口是模型属性、不是请求参数，所以"派生一个、留一个原版"会让两臂跑在 **8192 vs 4096** 两个窗口上——这是**未受控变量**。首期 prompt 上界 2532 + `num_predict` 768 < 4096 尚不咬；但只要将来为容纳更长回答把 `num_predict` 调大（如 2048），只有 4096 那臂会截断，而截断会被误读成"模型差"。
> **另一条已知的对照组设计缺陷**（首期不处理、下阶段必须重设计）：`qwen3:1.7b` 与 `qwen3.5:4b` 是**代际 + 参数量两个变量同动**，差异不可归因到单一因素。

**验收判据（逐条勾）**

- [ ] 两臂均正常结束，无 provider 错误（`api.ts` 修好后错误可见）
- [ ] 两臂 `experimentId` 相同、直接 parent 相同
- [ ] 臂 trace 的 `request.params` = **继承父录值**（dry-run 阶段先确认），变更项只有 `model`
- [ ] **两臂窗口一致**：执行中 `/api/ps` 应看到两个 `@8192`
- [ ] **（v0.5 新增，v0.6 改写）预热**：**只预热第一个臂的模型**（两模型在本机不能共存 ⇒ 无法都热）；预热 = 按**派生模型名** POST `/api/generate`、**不传 `options.num_ctx`**、带长 `keep_alive`（数字秒或 `"1h"`，勿用裸数字串）；另**单独测两模型载入耗时**作已知常数
- [ ] **（v0.5 新增）每次臂跑完立刻取 `/api/ps`** → 记录该臂模型的 `context_length` 与 `expires_at`（并据实记录哪一臂是冷启动）
- [ ] `usage.in / out > 0`（**v0.3 改**：不再要求 `ttft_ms > 0`——该字段曾是结构性失真。**v0.5 注**：根因已修 + 命中 §〇 #17 的②口径后臂侧 ttft 已可信，但仍不作为比较项）
- [ ] **（v0.5 新增，v0.6 收窄）`0 < ttft_ms < dur_ms`** —— **只覆盖"取时点类"错误**（拦"解析耗时"与"总耗时"）；**拦不住"条件类"**（冷启动），后者另靠条件检查（见 §〇 #24）
- [ ] **（v0.7 新增）父 trace 记基座模型**（`qwen3.5:4b`），**臂用派生名**（`-8k`）——模型名不同才过得了"空 fork"门禁（见 §〇 #27）；臂**不给 params**（继承父三项数值）
- [ ] **（v0.7 新增）真实跑前卸载基座模型**（`keep_alive: 0`）——父记为基座 ⇒ 基座常驻，会与臂的派生模型争 6GB 显存
- [ ] **（v0.7 新增）P2 报告不出速度表**，只发两个载入常数（4b@8192 ≈ 11.4s / 1.7b@8192 ≈ 7.5s）与"两臂均含冷启动"条件（见 §〇 #29）
- [ ] 两臂 `content` **非空**、`finish_reason` 不是 `length`（AniPedia 侧补的判据）
- [ ] 报告写明「本次经本地 shim 注入 `reasoning_effort`（N 次）」并计入失真清单
- [ ] 桌面端能并排展示且有共同祖先
- [ ] **`ttft_ms` 仅作占位、不参与任何比较**（见 §七 F7）

**止损**：schema 报错 / 两臂均失败 / 两臂 `content` 空 → 回 P1 或 P1.5，不进入 P3。

### P2.5 ·（可选）把 shim 的能力做进 ReBaseAgent

路 B：让 arm 支持"provider 原始参数透传"（`reasoning_effort` 这类**非数值**参数）+ 参数生效性自检。实测给它补了更硬的立项理由：**任何用非标准 provider 的人第一次接就会踩，而且是静默的**（HTTP 200、无警告）。仍建议由 P3 的需求数据背书后再立项（D3 维持"等数据"）。

### P3 · 规模化（5 题探针 → 40 题回归）

先 5 题手工跑，拿三样数据：单次耗时、失败率、是否真需要编排层。Auto-Judge 落 AniPedia 侧，先小样本与人判对齐再上量。

### P4 · CI 与定位重开

前置是 P3 出结论。

---

## 四、P1 契约清单（缺一条就 fork 不了）

| # | 要求 | 出处 |
|---|---|---|
| 1 | 父 run **已封存**（末行 `run.event`） | `fork-parent.ts:44` |
| 2 | `meta.source` **非 proxy**；`meta.config_hash` **必须存在** | `fork-parent.ts:48,55` |
| 3 | `config_hash` = `sha256:` + canonical JSON(`{systemPrompt, tools:[]}`)，键排序、无空白、**`ensure_ascii=False`** | `config-hash.ts:10-23`；Python 实现见二审附录（已实测一致） |
| 4 | 首次 `llm.call.request.messages` 含**字符串** `role=system` | `fork-runner.ts:160-168` |
| 5 | `request.tools` **显式 `[]`**（CLI 容缺、桌面端不容缺 → 统一写） | `fork-runner.ts:171-174` |
| 6 | `request.params` 只写数值项；**`num_predict` 给足**、**不写 `num_ctx`** | `model-replay-run.ts:63`；附录 A-2 |
| 7 | `response`：`content` / `reasoning_content`（**null**）/ `tool_calls`（`[]`）/ `usage{in,out}` / `ttft_ms` 全必填 | `schema.ts:138-146` |
| 8 | span id 形如 **`s_01`**（`/^s_(\d+)$/`），结构 = `agent.step` + 其下 `llm.call` | `replay-run.ts:56-67` |
| 9 | `meta.model` = **派生模型名**（窗口随模型带入） | 附录 A-1 |
| 10 | 文件落在 `<仓库根>/.rebaseagent/traces/`（**无** `REBASEAGENT_TRACES_DIR`） | `data-dir.ts:102` |
| 11 | `usage` 由 `prompt_eval_count`→`in`、`eval_count`→`out` 换算（唯一需换算处） | 附录 A-3 |

> 可照 `run_mttvbmww.jsonl` 的骨架（4 行，span 倒序落盘），**但必须补 `request.tools: []`**——它现在没有该字段。

---

## 五、里程碑依赖

```text
P0-1 工程债 → P0-2 写出器 → P0-3 dry-run → P1 父 run → P1.5 shim → P2 1题2臂 → P3 5题 → P3 40题 → P4
                                                              └──(需原生口径)──→ P2.5 路B（独立小 change）
```

P0 → P2 全程**不依赖 ReBaseAgent 任何改动**（shim 是外部转发，不算改动）。

---

## 六、决策点

| # | 决策 | 结论 / 建议 |
|---|---|---|
| D1 | 本次口径 | **① 链路验证**（同意）。**新增前提**：必须已完成 P1.5 shim，否则"链路跑通"也拿不到——臂会是空的 |
| D2 | `think` 处置 | **改选 ② 挂 shim**（v0.1 的"① 接受"已被实测否决：代价不是"形态不同"，是**零信息**） |
| D3 | 是否立"provider 原始参数透传 + 生效性自检"change | **维持 ② 等 P3 数据**；理由已加强（见 P2.5） |
| D4 | `ttft_ms` 缺陷是否现在修（见 §七 F7） | **AniPedia 侧已拍板：修根因**（理由：`DetailPanel.tsx:609/610` 把「首 token 延迟 `2ms`」与「耗时 `20.1s`」并排展示，用户先撞上；`.gitignore:12` = `.rebaseagent/` 说明无存量数据兼容负担；`llm-proxy` 已有正确的流内实现可搬）。**我方核实三条依据全部成立**，并补一条决定性依据（`design.md:40` 已定义正确语义 → conformance 回归）。
**打包建议（与对方"并入 A1/B1"略有分歧）**：**单开一个最小 change**（如 `fix-llm-ttft-timing`）——① 它是 spec 符合性修复，验收判据现成；② 按刚写入 HANDOFF 的「一次只推进一个可独立验证的单元」，不该把"修 ttft"与"A1 建原生 run 入口"混成一个 change（两者验收目标无关）；③ 但 propose 可以极短，无需完整重流程。
**必须配一个单测**：编排 SSE 序列 + 断言 ttft 落在"请求发出 → 首个含内容 delta"之间（现在会测出 ~0）。
**状态（2026-09-10）**：owner 已放行 → 提案 → 审阅（补 3 项：dist 重建 / 延时流 helper / 块数无关性改差分）→ **已 apply 并归档 ✅**（`openspec/changes/archive/2026-09-10-fix-llm-ttft-timing/`）。验证：agent-loop **56**（新增 4 用例，**在旧实现上会失败**）/ 其余五包 75·66·16·65·156 = **434 全绿**；`biome check .` 0 errors；`validate --all --strict` 10/10。真机探针（同路径同模型，仅改 provider 参数）：思考关 `ttft=161ms`（**真实网络首 token 时间**）vs 思考开 `ttft=20448ms`。报告 `docs/engineering/reports/2026-09-10-fix-llm-ttft-timing-apply.md`。 |
| D5 | **新增**：桌面端「缺 `tools`」门禁缺陷 | **建议并入 A1**（不单开）：A1 的验收本就是"桌面端能新建 run 且其产出可被 fork"，这条天然是 A1 的一部分。修法取②（桌面端把"缺失"视同空表，与 CLI 一致），不改 trace 形状。 |

---

## 七、风险与止损

| 风险 | 触发信号 | 处置 |
|---|---|---|
| **F7 `ttft_ms` 是假数据**（v0.2 新增实测；**v0.4 根因已修**）——性质：实现违反既有 spec，不是设计缺口 | trace 里 `ttft_ms` 为个位数毫秒而实际调用数百毫秒~20 秒 | **根因已修并归档** ✅（2026-09-10，change `fix-llm-ttft-timing`，见 D4）——取时点已移入流读取过程。⚠️ **旧 trace 仍不可信**：修复前产出的 `.rebaseagent/` 历史 jsonl 未重算，引用 ttft 须注明 trace 产出时间；⚠️ 臂若开思考仍受 F3 影响（得"首**正文** token 时间"）⇒ 首期验收仍以 `usage.in/out > 0` 为主判据
**决定性依据**：`openspec/changes/archive/2026-09-03-add-agent-loop/design.md:40` 原文即「`ttft_ms`：**首个含内容 delta 的 chunk 与请求发出时刻之差**」→ spec 定义正确、实现不符 → 这是**conformance 回归**，修复**不需要 spec delta**（验收判据现成），也不该与功能 change 混批 |
| **F7 的产品侧连带影响**（v0.3 新增） | 桌面端 `DetailPanel.tsx:609` 直接展示「首 token 延迟 `{ttft_ms}`ms」= 假数字；**用户比 dogfood 先撞上** | 候选修复见 D4（隐藏该行 / 标注不可比 / 修根因）。注：**ComparePanel 不展示响应时间**，误导发生在 span 详情面板 |
| **两臂窗口不一致**（v0.3 新增，我们自己的实测缺陷） | 派生臂 8192 vs 对照臂 4096 | 已修：两臂都派生 `-8k`（见 §三 P2 命令）；`qwen3:1.7b-8k` 派生 + `/v1` 加载 `@8192` 已实测通过 |
| **对照组两变量同动** | `qwen3:1.7b` vs `qwen3.5:4b` = 代际 + 参数量同时变 | 首期只验链路可通过；**下阶段要下模型结论前必须重设计对照组**，否则差异不可归因 |
| **臂的 `content` 为空** | `finish_reason=length` / 正文空 | 已由 P1.5 shim 消除；若复现，先查 `num_predict` 是否被思考吃光 |
| trace 契约踩坑 | `readRun` 抛错 / fork 被拒 | 按错误码回 §四 对应行；错误信息本身即文档 |
| 窗口：**prompt 上界实测 2532 tokens**（v0.2 更正） | `done_reason=length` | 真风险不是 prompt 长度，而是**思考与输出共用同一份窗口与 `num_predict` 预算** → 已由 shim 消除 |
| 本地模型不确定（temperature=0 仍非逐字确定） | 同臂重复跑输出不同 | 记为已知条件；暂不做多轮取多数 |
| 范围蔓延 | 单阶段超过 2 个可独立验证单元 | 严守 P0→P2 只做一件事：**让一条 trace 跑通一次 A/B** |

---

## 八、AniPedia 侧提出的三个「未验证假设」：实测全部成立

| # | 假设 | 结论 | 依据 |
|---|---|---|---|
| 1 | 臂是否继承父 run 的 `num_predict`？ | **成立**：臂不给 `params` → 继承父的**数值** params（dry-run 显示 `temperature=0.7` = 父录值）；臂给了 `params` → **整体替换不合并** | `prompt-fork.ts:243` + 附录 A-2 |
| 2 | 派生模型在真实臂里是否真生效？ | **成立**：真实臂执行中 `/api/ps` 观察到 `qwen3.5:4b-8k@8192`；对照臂 `qwen3:1.7b@4096` | 附录 A-1 |
| 3 | SDK 产出的纯对话 run 是否也过不了桌面端 fork 门禁？ | **成立，且是独立于 AniPedia 的缺陷** | 见下 |

**#3 详情（独立缺陷）**：`run-loop.ts:105` 在空工具表时**不写** `tools` 字段（实测 `run_mttvbmww.jsonl` 的 request 只有 `model / messages / params`）；而桌面端 `fork-runner.ts:171-174` 要求该字段**存在**，缺失直接 `FORK_NO_CONTEXT`。

- 后果：**任何用 SDK 跑纯对话 Agent 的用户，在桌面端都无法做 prompt fork / 模型 A/B**（CLI 反而可以，`fork-parent` 不检查该字段）
- 与 A1 的关系：A1（原生 run 创建入口）若用 `runLoop` + 空工具表实现，**产出物会立刻不可 fork** —— 这是 A1 立项前必须先处理的前置缺陷
- 两个修法：① `run-loop` 空工具表也写 `tools: []`（改变既有 trace 形状，需评估兼容）；② 桌面端门禁把"缺失"视同空表（与 CLI 一致）。**建议 ②**

---

## 附录 A：本次臂级实测（2026-09-10，本机 Ollama，零费用）

**A-1 派生模型在真实臂里生效 + 第一次真实臂跑通**

```text
ollama create qwen3.5:4b-8k -f Modelfile（FROM qwen3.5:4b / PARAMETER num_ctx 8192）→ success
CLI: --parent run_mttvbmww --base-url http://127.0.0.1:11434/v1 --confirm-cost
  arm 1（qwen3.5:4b-8k）：成功 run_mtv8nqy6_wf3c
  arm 2（qwen3:1.7b）：成功  run_mtv8o6ht_csbm      exit 0
/api/ps 全程观察：qwen3.5:4b-8k@8192 | qwen3:1.7b@4096   ← 派生模型窗口生效
   ⚠️ 但这也暴露了我们的失误：两臂窗口 8192 vs 4096 是**未受控变量**（由 AniPedia 侧交叉发现）
      → v0.3 修正：两臂都派生 -8k；已实测 qwen3:1.7b-8k 派生成功且 /v1 加载 @8192
臂 1 trace：content 非空、usage{in:47, out:1028}、dur_ms 20120、reasoning_content=null
```

> 本次臂**未挂 shim**，故 `out=1028`（含思考）、耗时 20.1s —— 与 AniPedia 侧"B 路 20.0s"吻合。父 run prompt 仅 21 tokens，故本轮未复现"正文为空"（该现象由 `num_predict=768` 上限触发）。

**A-2 参数继承与替换（`--dry-run` 实测）**

```text
--arm "qwen3.5:4b-8k"                 → 计划显示 temperature=0.7（父录值）· 改变：model
--arm "qwen3.5:4b-8k;temperature=0"   → 计划显示 temperature=0   · 改变：model、params.temperature
```

**A-3 `ttft_ms` 缺陷（本次新发现）**

`packages/agent-loop/src/llm-client.ts:155-177`：先把整个 SSE 流读到底（`events.push` 缓冲），**之后**才 `const startedAt = Date.now()` 再遍历缓冲事件 → `ttft_ms` 实际是**首个缓冲事件的解析耗时**，与首 token 时间无关。

```text
本次臂实测：ttft_ms = 2ms，而该次调用实际耗时 20.1s
全仓 48 个 llm.call 的 ttft_ms：0×18、1×2、2、7、10×6、250×6、338、380、390、410、540、580、600、620、700、850、900、980、1200
其中 deepseek-chat 真实调用 160ms~1656ms 的记录里，ttft 多为 0ms
```

范围界定：**仅 agent-loop 的 SSE 聚合路径**（SDK 录制 + 所有 fork 重跑/臂）；`packages/llm-proxy` 的 `agg.firstTokenAt`（`handler.ts:453`）是流内实测，**代理录制的 run 不受影响**（非流式那两条是诚实记 0）。

**A-3 修复后对照（v0.4 新增）** —— change `fix-llm-ttft-timing` 已归档：

```text
【改前】run_mtv8nqy6_wf3c（qwen3.5:4b）   ttft_ms=2      dur=20120ms    ← 个位数，= 解析耗时
【改后】run_mtva4wiw（qwen3.5:4b）        ttft_ms=42398  dur=43049ms    ← 结构性判据 0<ttft<dur 通过，
                                                                         但 ttft/dur=0.985，被 F3 污染、不具说服力
【改后·决定性对照】同一代码路径、同一模型，仅改一个 provider 参数：
  思考开（默认）                 ttft_ms=20448  dur=20465ms  out=1437
  思考关 reasoning_effort:"none" ttft_ms=161    dur=180ms    out=2
  ⇒ 161ms 是【真实网络首 token 时间】：既非解析耗时（旧实现必为个位数），也非总耗时（180ms）。
     两组仅差一个参数而 ttft 相差 127 倍 ⇒ 该字段现在确实随真实流时序变化。
```

判据（写入 `agent-loop` 主 spec 的 Scenario + 4 个单测）：**延时流下界 / 块数无关性差分 / usage-only 保底 0 / 端到端**——**在旧实现上会失败**（旧值恒为 `0`）。

**A-3b `usage` 口径对照（回答 AniPedia 侧提问，v0.3 新增）**

同一 system（AniPedia 真实 `SYSTEM_PROMPT`，847 字符）+ 同一 user 内容，两条路径各跑一次：

```text
/api/generate  prompt_eval_count = 651   eval_count = 1
/v1            prompt_tokens     = 651   completion_tokens = 1
差值 = 0
```

→ **两边同口径**：父 trace 的 `usage.in`（由 `prompt_eval_count` 换算）与臂的 `usage.in`（provider 直给）可直接比较，**不构成失真**。

**A-4 流式首块形态（解释"思考吃光预算"的机制）**

```text
headers 到达 7644ms → chunk#1 立即(7645ms) 到，delta = {role, content:"", reasoning:"8 字符"}
… 思考期间 content 恒为空字符串；最后一个 chunk 带 usage，随后 [DONE]
```

即 Ollama 的思考内容走 `delta.reasoning`，而 `llm-client.ts:195` 只读 `reasoning_content` → **COT 被丢弃**（F3），且思考期间 `content` 为空 → 这正是"思考吃光 `num_predict` 后正文为空"的机制。

**环境**：实测后已 `ollama rm qwen3.5:4b-8k`、`ollama stop`、终止临时 serve；`ollama list` 已恢复原有 3 个模型。本次产生的两条臂 run 保留在 `.rebaseagent/traces/`（`run_mtv8nqy6_wf3c` / `run_mtv8o6ht_csbm`）供复查。

## 附录 B：`config_hash` 的 Python 实现

见 `docs/reviews/2026-09-10-direction-2026h2-review-2.md` 附录。实测值（AniPedia 真实 `SYSTEM_PROMPT`，847 字符，`tools=[]`）：JS 与 Python 均为 `sha256:f0d043ffc1cc8e4640dbdff8f0242dacdc5adbd2fab36c6ebf61a6db4743fbea`；误用 `ensure_ascii` 默认值 → `sha256:49b89497…`（完全不同）。
