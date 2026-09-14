# 设计

## 1. 类型放宽的最小面：标量，且只放宽一处语义

`params` 值类型从 `number` 扩为 `string | number | boolean`。五处类型点同步放宽，但**语义只有一个**：`buildRequestBody` 的平铺（`llm-client.ts:63-67`）本就把 params 原样放到请求体顶层，值是数字还是字符串对它无差别——所以这是一次纯类型放宽，不触碰前缀稳定性与请求体构造的任何代码路径。

| 位置 | 现状 | 改法 |
|---|---|---|
| `agent-loop/config.ts:95` `SampleParamsSchema` | `z.record(z.string(), z.number())` | `z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))` + 保留键 refine |
| `replay/prompt-fork.ts:31` `ModelParamsValueSchema.params` | `z.number().finite(...)` | 标量 union（沿用 strict 对象外壳与错误文案风格） |
| `replay/prompt-fork.ts:123` `numericParams` / `model-replay-run.ts` `numericParentParams` | 只保留数值 | 只保留标量（过滤逻辑同名改为 `scalarParams`） |
| `desktop/main/fork-runner.ts:334` `sanitizeParams` | `typeof value === "number"` | 标量判定 |
| `renderer/lib/model-ab.ts` `parseArmParams` | "必须是有限数字" | 接受字符串 / 布尔 / 有限数字 |

**不含嵌套对象**（`response_format` 这类）：实测痛点只有标量（`reasoning_effort` / `think`），嵌套对象会引入"保留键递归冲突""深比较语义"两摊新问题。等证据再加，Proposal Non-goals 已声明。

**保留键守卫放在 `SampleParamsSchema` 的 refine**，而非 `buildRequestBody` 运行时检查：保留键冲突是配置错误不是运行时意外，应在 `parseRunConfig` 阶段拒绝（零文件零调用纪律的最早入口）。

**常量落地位置（P1-1）**：

| 项 | 结论 |
|---|---|
| 常量名 | `RESERVED_BODY_KEYS` |
| 定义与导出位置 | `packages/agent-loop/src/config.ts`（与 `SampleParamsSchema` 同文件，紧邻其上方） |
| 类型 | `export const RESERVED_BODY_KEYS = ["model", "messages", "tools", "stream", "stream_options"] as const;` |
| 键集来源 | `buildRequestBody`（`llm-client.ts:46-51`）构造的固定键 + 按条件写入的 `tools` |
| 消费方 1 | `config.ts` 的 `SampleParamsSchema.refine`（本包内直接引用） |
| 消费方 2 | `packages/replay/src/prompt-fork.ts` 的 `ModelParamsValueSchema.refine` —— `import { RESERVED_BODY_KEYS } from "@rebaseagent/agent-loop"`（replay 已依赖 agent-loop，零新依赖） |
| 消费方 3 | `llm-proxy/src/handler.ts` 的 `buildForkRequest`（`handler.ts:501-523`）不用该常量但用同一键集——**在函数注释中引用常量名**，提示维护者同步 |

`buildRequestBody`（`llm-client.ts:45`）与 `buildForkRequest`（`handler.ts:501`）的 JSDoc 中 SHALL 各加一行："固定键集见 `RESERVED_BODY_KEYS`（agent-loop/config.ts）；新增固定键必须同步该常量。" 这是防"新增保留键忘记同步守卫"的唯一机制——review P1-1 与 P3-1 指向同一件事。

任务 1.1 落地为：`config.ts` 导出常量 → `SampleParamsSchema` 加 refine（错误信息含冲突键名）→ `llm-client.ts` 注释引用；任务 2.1 落地为：replay 从 agent-loop 导入常量（不复制粘贴键集）。

## 2. `reasoning` 字段兼容：谓词同源是关键约束

现状（实测）：Ollama `/v1` 的思维链 delta 在 `reasoning` 字段，`llm-client.ts:185/236` 只读 `reasoning_content` ⇒ 思维链整段静默丢失，且因不进"内容 delta"谓词，思考模型的 ttft 被记成"首正文 token 时间"。

改法：聚合处把 `reasoning` 与 `reasoning_content` 同等对待——

```ts
const r = delta.reasoning_content ?? delta.reasoning;
if (typeof r === "string" && r.length > 0) { agg.reasoning = (agg.reasoning ?? "") + r; sawAnything = true; }
```

两处（`complete` 内联聚合与 `aggregateStream`）同改；`llm-proxy/handler.ts:399-411` 的流式聚合按既有"与 llm-client 同标准"条款同步（代理 spec 文本不用动——它的聚合标准是引用性条款）。

**并存时的聚合语义（P1-2）：按出现顺序拼接，不做去重。**

```ts
const r = delta.reasoning_content ?? delta.reasoning;   // 每块内优先 reasoning_content
if (typeof r === "string" && r.length > 0) {
  agg.reasoning = (agg.reasoning ?? "") + r;            // 逐块累加 = 按出现顺序拼接
  sawAnything = true;
}
```

口径三条，缺一不可：

1. **块内二选一**：同一块 delta 同时含两字段时取 `reasoning_content`（`??` 短路），不拼接块内两份——避免同一块内容翻倍。
2. **块间累加**：不同块分别携带 `reasoning` 与 `reasoning_content` 时，按 SSE 到达顺序依次追加进同一 `agg.reasoning` 缓冲，**不比较、不去重**。去重需要内容级启发式（前缀匹配/相似度），在流式增量下不可靠且会把 provider 真实重复的文本误删。
3. **语义豁免**：真实 provider 不会在同一流并发两字段（实测 Ollama 只发 `reasoning`，DeepSeek 只发 `reasoning_content`）；若真的出现，拼接结果是最佳努力聚合，**不承诺语义正确**。此条 SHALL 写进 spec 的 scenario 文本。

对 ttft 的影响：`hasContentDelta` 谓词同步纳入两字段，故思考模型的 ttft 覆盖"首个 `reasoning` delta"——这是 fix-llm-ttft-timing spec"谓词同源"条款的符合性补全，不是语义变更。拼接导致思维链文本变长**不影响** ttft（ttft 取首个 delta 到达时刻，与文本长度无关）。

**ttft 语义自动修正**：fix-llm-ttft-timing 的 spec 已写明"判定'含内容 delta'的谓词 SHALL 与聚合所用谓词同源"——聚合纳入 `reasoning` 后，思考模型 ttft 自然从"首正文 token"变回"首内容 token"。这不是语义变更而是既有 spec 的符合性补全（F3 连带现象收口）；agent-loop delta 已把谓词范围写明。

trace 内部字段名恒为 `reasoning_content`（trace-format 不动，无迁移）。

## 3. 知识库：小、诚实、可拒配

**形态**：`packages/replay` 内一个纯数据模块 + 一个纯函数：

```ts
interface SilentIgnoreRule {
  provider: "ollama";
  /** baseURL 识别启发式（本机 11434 或路径含 ollama） */
  matches: (baseURL: string) => boolean;
  keys: string[];            // ["num_ctx"] / ["think"]
  reason: string;            // 实测结论原文（含日期）
  workaround: string;        // 派生模型 / reasoning_effort:"none"
}
export function warnSilentIgnores(baseURL: string, params: Record<string, Scalar>): Warning[];
```

**为什么是告警不是门禁**：知识库基于本机抽样实测（2026-09-10），provider 行为随版本漂移；`num_ctx` 的绕行（派生模型）恰恰要求用户继续保留该键在别处生效的意图，硬拒绝会把合法绕行也堵死。告警内容含参数名、风险、绕行方式三要素，CLI 走 stderr、桌面在编辑器与执行确认处展示。

**为什么放 replay 不放 agent-loop**：告警只发生在"参数实验编排"场景（A/B 臂、dry-run），agent-loop 是纯执行库不该带 provider 知识；replay 已是编排层，CLI 与桌面都从它取告警结果（同源，双端不各写一份）。

**首期只录两条**（都有实测记录）：Ollama `/v1` 静默忽略 `num_ctx`（三种写法）；Ollama `/v1` 顶层 `think` 无效。不追 API 面、不做官方适配——这是"已知坑的路标"，不是 provider 档案。

## 4. dry-run 参数透明化：只展示，不改语义

V3b 的"arm params 整体替换父录值"语义保留（改合并 = 契约变更，无证据）。补的是**把替换的代价放到 dry-run 里**。

**双端同源约束（P2-1）**：CLI 与桌面 SHALL NOT 各写一套展示逻辑。`modelReplayRunMany` 的 `plan` 结构扩展为携带渲染所需的全部分片，CLI 与桌面只做"排版"不做"推导"：

```ts
export interface ModelArmPlan {
  index: number;
  model: string;
  /** 最终生效 params（含继承的父录值；整体替换后 arm 给出的项覆盖父值） */
  params: Record<string, Scalar>;
  /** 相对父 run 实际改变的项（model / params.<key>） */
  changed: string[];
  /** params 中来自 arm 显式给出的键（展示时标"覆盖"） */
  overridden: string[];
  /** 父 run 录制值中因整体替换被丢弃的项，逐项列出（键 → 被丢弃的值） */
  discarded: Record<string, Scalar>;
  /** 知识库命中的静默忽略告警（空数组 = 无命中，不承诺"已生效"） */
  warnings: SilentIgnoreWarning[];
  allowSideEffects: boolean;
}
```

四条硬约束：

1. `params` / `discarded` / `warnings` 全部由 `modelReplayRunMany` 计算一次，**双端只读不重算**（避免"桌面算 discard、CLI 算覆盖"这类漂移）。
2. `overridden` 是"arm 给出的键 ∩ 父也有的键"——展示时标"（覆盖）"；arm 给出但父没有的键标"（新增）"。
3. `discarded` 只在**非空**时有意义（arm 未给 params 时 `discarded` 为 `{}`，不误报"丢弃"）。
4. `warnings` 与 plan 同批计算（design §3 已在编排入口算一次），dry-run 与真实执行共用同一批。

**展示格式（spec 固化的最小示例）**：

```text
实验 exp_xxx（父 run run-123）
  arm 1：qwen3.5:4b-8k
    生效 params：temperature=0.7（覆盖）
    丢弃父录值：num_predict=768   ← 整体替换不合并，此项不会进入请求
    ⚠ num_ctx：Ollama /v1 静默忽略此参数（实测 2026-09-10）；绕行：派生模型（Modelfile PARAMETER num_ctx）
```

CLI 在 dry-run 与 `--confirm-cost` 前的执行计划里按上述格式逐行打印（无告警时省略 `⚠` 行，无丢弃时省略"丢弃父录值"行）；桌面 ModelAbEditor 的计划面板 SHALL 复用同一组字段渲染同样三行语义（`生效 params` / `丢弃父录值` / `⚠ 告警`），视觉样式自定但**不省略任何一行**。

复用机制：dry-run 返回的 plan 已是 `ModelAbResult.plan` 的一部分（`ipc.ts:194-213` 的 `ModelArmPlanSchema` 同步扩字段），desktop 只做 zod schema 扩展 + 渲染，不新增 IPC 通道。

dogfood 实测的"只写 temperature 丢 num_predict，token 涨 10 倍"由此从坑变成看得见的两行字。

## 5. CLI arm 语法：宽松解析，显式引用

`model;key=value` 现状是 `parseFloat`（`model-ab-cli.ts:129`）。扩展解析规则（顺序固定）：

1. `true` / `false` → boolean（严格小写全等，`True` 按字符串）；
2. 合法 JSON number（含负号 / 小数）→ number；
3. 其余按原字符串（`none` / `high` / `q4_k_m`）；
4. 引号包裹（`key="123"`）→ 强制字符串。

**引号转义规则（P2-2）：`"` 为唯一分隔符，反斜杠是唯一转义字符，仅允许 `\"` 与 `\\` 两种转义。**

| 输入 | 结果 | 说明 |
|---|---|---|
| `k="123"` | `"123"`（string） | 规则 4，避免 `123` 被规则 2 吃成 number |
| `k="a b"` | `"a b"`（string） | 引号内含空格合法（命令行侧需 shell 引号包住整段） |
| `k="a\"b"` | `a"b`（string） | `\"` → 字面双引号 |
| `k="a\\b"` | `a\b`（string） | `\\` → 字面反斜杠 |
| `k="a\nb"` | 解析失败 | **不支持** `\n` / `\t` / `\uXXXX` 等转义，报该 arm 的中文错误 |
| `k="a"b"` | 解析失败 | 首字符 `"` 但末字符非 `"`（或引号未包到末尾）→ 报错 |
| `k=a"b` | 报错（含 `"` 但未包裹） | 中间出现裸 `"` → 报错，不静默按字面量吃掉 |
| `k=""` | `""`（空字符串） | 空串是合法字符串值，非"未提供" |
| `k` (无 `=`) | 不适用 | 按既有分支视为模型名（`model-ab-cli.ts:116-120`） |

**为什么不做完整转义集**：CLI 的 `--arm` 字符串在到达解析器前已被 shell 处理过一轮（bash / PowerShell / CMD 的引号规则各不相同），再做 `\n` / `\uXXXX` 解码只会制造"两层转义"的心智负担。参数值都是短标量（`none` / `high` / `q4_k_m`），字面反斜杠与双引号已是极限需求。

**为什么裸 `"` 报错而非按字面量**：静默吃掉会掩盖用户"以为引号生效了"的意图（例如 `k="a"b"` 被当成 `a"b"` 或 `"a"b` 都违反直觉）；报错成本低且给示例。

解析失败给出该 arm 的中文错误与示例。单测覆盖上表每一行。

## 6. 兼容性与回归面

- 既有数值 arm（`model;temperature=0.2`）解析结果不变（规则 2 原样覆盖）。
- 旧 trace 的 `request.params` 是 `Record<string, unknown>`（trace-sdk 宽松类型），读取侧本来就无约束；变化只在"派生父值"过滤口径（数值 → 标量），对纯数值旧 trace 无行为差异。
- `config_hash` 不吃 params（`config-hash.ts` 只输入 systemPrompt + 工具表），零指纹迁移。
- `sameParams` / 空 fork 判据是值比较，对标量天然成立（`"none" !== "high"`）。
- 代理通道（proxy fork）不受影响：`buildForkRequest` 重放原始录制 params，无新注入面；代理录制对 params 本就任意 JSON 平铺。

## 7. 拒绝路径与告警路径的时序

保留键 / 非标量：schema 校验阶段（`parseRunConfig` / `parseModelParamsValue`）拒绝——先于 tracer、文件、网络。知识库告警：编排入口计算一次（dry-run 与真实执行共用），真实执行时随 plan 一起再次输出，确保 `--confirm-cost` 的确认对象包含告警内容。
