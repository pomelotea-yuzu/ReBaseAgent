# 外部 agent 会话 trace 导入 ReBaseAgent——发现与总结（历史探针记录）

> 归档说明（2026-10-12）：保留 10/11 的探针记录与当时判断，本次未复跑。文中“无人提供查看器”“竞品没有”“零门槛”、缺失 token 显示为 0 及对特定工具加密/数据主权的推论，均不能直接作为当前产品结论。后续竞争与数据保真口径见[10/12 调研](2026-10-12-agent-differentiation-and-community-needs.md)；适配器尚未立项。

- 日期：2026-10-11
- 性质：探针验证记录（未入库功能设想，无对应 change）
- 测试环境：`D:\test-rebaseagent-workbuddy\`（独立目录，rc.2 便携包副本，SHA-256 `c5f61709…` 与发行记录一致）
- 结论先行：**外部 agent 会话 JSONL 可以低成本导入 ReBaseAgent 原生查看；「通用 agent trace 导入器」是 local-first 差异化的自然延伸，值得立 change。**

---

## 一、两个友商/本家工具的本地数据格式

### WorkBuddy（本机 `C:\Users\28145\.workbuddy\`）

| 目录 | 内容 | 价值 |
|---|---|---|
| `projects\<项目路径转义>\<会话uuid>.jsonl` | 会话事件流水：`message`（user/assistant）、`reasoning`、`function_call`、`function_call_result`、`file-history-snapshot`、`ai-title`；每行带 `id`/`parentId`/`timestamp`/`sessionId`/`cwd` | **导入数据源**（内容全：prompt/reasoning/工具参数/工具原始输出） |
| `traces\<pid>\trace_*.json` | 纯遥测：span 时间线 + token 汇总统计（含 cached），无对话内容 | 诊断用，与上面互补 |
| `<uuid>.file-rollback.ndjson` | 文件改动回滚记录 | 可用于"该会话动了哪些文件"视图（未做） |

关键映射锚点：
- `providerData.messageId` 把 `reasoning` / `function_call` / assistant `message` 归并为**一次模型调用**；
- `function_call.providerData.usage` 自带每调用 `inputTokens/outputTokens` 与 `inputTokensDetails[0].cached_tokens`、模型名 → 可完整还原 token 统计与缓存命中；
- user 消息首条常带 `<system-reminder>` 注入块，取 task 标题必须剥离。

### Qoder（本机 `C:\Users\28145\.qoder-cn\projects\`）

Claude Code 风格：`user`/`assistant` 事件 + `message.content` 内容块（`thinking`/`text`/`tool_use`/`tool_result`）+ `parentUuid` 链。
- `tool_result` 不在 assistant 侧，而在**后续 user 消息**里，按 `tool_use_id` 配对；
- `isSidechain: true` 是子代理侧链，主链转换应跳过；
- **usage 的 `input_tokens/output_tokens` 全被清零**（只有 `credits`/`context_usage_ratio`）→ 导入后 run 显示 0 tokens 是数据源如此，不是转换缺陷；
- 流式输出把一次模型调用拆成多行 assistant 事件，**必须按 `message.id` 归并**（实测 412 行 → 205 次真实调用）。

## 二、ReBaseAgent 侧的摄入路径（决定导入成本）

- runs 发现 = **纯磁盘目录扫描** `<dataDir>/traces/*.jsonl`（`apps/desktop/src/main/run-repository.ts` `listRuns()`），无索引、无注册——文件放进去重启即见；
- 一 run 一扁平 JSONL：`run.meta` 首行 → `span` 行（`agent.step`/`llm.call`/`tool.invoke` 三种）→ `run.event` 终止行；schema 真源 `packages/trace-sdk/src/schema.ts`；
- **v1 格式无 workspace 负担**：外部普通会话导入用 `format_version: 1` 即可，完全绕开 v2 的 `initial_snapshot` 规范哈希重算、`world_id = run id`、step 检查点等强校验；
- `runs:create` IPC 是真实执行通道不是导入语义；桌面端目前**没有任何导入 UI**（无 showOpenDialog/拖拽入口）。

## 三、实测结果

| 会话 | 来源 | 转换产物 | readRun | 实机（rc.2） |
|---|---|---|---|---|
| 「帮我启动dev」（09-06，hy3） | WorkBuddy | `wb-0f44e631-6e3.jsonl`，26 步/26 llm/23 工具，991 KB | ✅ | 列表+概览+步骤树全正常；1373.5k tokens、命中 1226.2k、89m45s 全部还原 |
| worktree 补打包 rc.2（10-11，glm-5.3-flash） | WorkBuddy | `wb-56259f11-822.jsonl`，85 步/85 llm/104 工具，8.3 MB | ✅ | 6792.0k tokens、命中 6208.3k（74/85 次命中）、53m52s、工具错误 0 |
| 「阅读handoff进入6.x」（09-28，qfmodel） | Qoder | `qo-0e3f9bc3-0f5.jsonl`，205 步/205 llm/206 工具，5 MB | ✅ | 列表与轨迹树正常；0 tokens（数据源如此） |

转换器（探针，留在测试目录不入库）：
- `D:\test-rebaseagent-workbuddy\wb2rebase.mjs` — WorkBuddy 会话 → v1 trace
- `D:\test-rebaseagent-workbuddy\qoder2rebase.mjs` — Qoder 会话 → v1 trace
- 两者均内置 trace-sdk `readRun` 自校验；用法 `node <转换器> <会话jsonl> <data/traces目录>`

## 四、转换层踩坑记录（对实现导入器直接有用）

1. **`run.event.at` 是迭代号不是时间戳**（ISO 串会被 zod 拒：`Invalid input`）——可选字段，省略即可。
2. **task 标题剥 `<system-reminder>` 块**，否则 run 列表标题全是注入上下文。
3. **Qoder 按 `message.id` 归并**：不归并会得到成倍假 step（412 vs 205）。
4. **请求快照必须瘦身**：每步全量对话快照在长会话上会膨胀（实测 115 MB → 窗口 30 条 + 单条截 2000 字符 → 5 MB）。
5. **Qoder 侧链跳过**：`isSidechain: true` 不进主 run。
6. trace-sdk 是 ESM（`packages/trace-sdk/dist/index.js`），node 探针用 `import("file:///…")` 即可复用 `readRun` 自校验。

## 五、价值判断

1. **产品方向（最大）**：Claude Code / Qoder / WorkBuddy 等工具都会话明文落盘本地 JSONL，但无人提供好用的查看器。ReBaseAgent 现成轨迹/预算/时间线视图 + 每源一个轻量适配器即可通吃——「把你过去任何 agent 会话拖进来看」是竞品没有的卖点，架构上已验证零门槛（目录扫描发现机制天然支持外部文件）。
2. **测试夹具**：真实脏数据暴露了自产 run 不会出现的形状——usage 全零、205 步/616 span/5 MB 单文件、无 `config_hash` 的不可分叉 run。可沉淀为夹具补充桌面端边界用例。
3. **日用**：历史会话按 token 成本复盘、工具调用时间线回看，产品自己的 dogfood。

## 六、边界（诚实口径）

- 导入 run 是**只读快照**：无 `config_hash` ⇒ 不可作 replay 分叉父本（校验层按设计拒绝）；时间旅行/重跑对外部会话不适用，价值在查看与分析，不在重执行。
- Qoder 源数据 token 用量缺失 ⇒ 预算类视图对它只有时间线与工具维度，token 维度诚实显示 0。

## 七、Codex：数据最全的明文源（2026-10-11 补）

OpenAI Codex（本机 `C:\Users\28145\.codex\`，716 MB，Desktop/CLI 通用格式）：
- 会话存储 `sessions\<YYYY>\<MM>\<DD>\rollout-<时间>-<uuid>.jsonl`（本机 41 个，**明文**）；`session_index.jsonl` 提供会话标题（thread_name）索引；
- 事件类型：`session_meta`（cwd/模型/来源）、`response_item`（payload：`message`（role user/developer/assistant）、`reasoning`、`custom_tool_call`/`custom_tool_call_output`（call_id 配对）、`function_call` 等）、`event_msg`（`user_message`/`agent_message`/`token_count`/`task_started`/`task_complete`/`patch_apply_end`/`mcp_tool_call_end`）、**`token_usage_record`（每次响应的完整 usage：input/cached_input/cache_write/output/reasoning_output tokens）**、`turn_context`、`world_state`；
- **token 数据是四家里最全的**（每响应粒度 + 缓存命中），实测 09-06 会话还原出 in 6.45M / out 51k、缓存命中 5962.4k，实机显示 6504.2k tokens / 命中 5962.4k；
- ⚠️ 唯一缺口：`reasoning` 的思维链是 `encrypted_content`（GPT-5 加密），`summary` 为空 ⇒ reasoning_content 诚实记 null；
- ⚠️ 工具入参是 JS 脚本字符串（`custom_tool_call.input`），不是结构化 JSON——args 记为 `{script}` 截断存储；
- 分组口径：`token_usage_record` = 一次模型响应边界 → 一个 agent.step（实测 404 行事件 → 59 步/52 工具，2.8 MB）；
- 墙钟时间含空闲（1379m14s 是首尾跨度），时间线视图按 span 区间展示不受影响。

结论：**Codex 完全可导入且数据质量最高**，适配成本与 WorkBuddy 相当。四家对照：WorkBuddy（明文/含 token）、Claude Code 风格的 Qoder（明文/token 被清零）、Codex（明文/token 最全/思维链加密）、Trae（加密库，不可导入对照组）。

## 八、Trae：不可导入的对照组（2026-10-11 补）

TRAE SOLO CN 本地数据（用户自查 + 抽样验证）：
- 对话主存储 `AppData\Roaming\TRAE SOLO CN\database.db`（约 111 MB）是 **SQLite WAL 结构但文件头非明文、加密且被进程锁定**，无法直接读取；
- 唯一明文入口 `~/.trae-cn/memory/projects/<项目>/<YYYYMMDD>/session_memory_<id>.jsonl`，实测每行为 `{intent, actions[], outcome, learned[], message_summary_time, message_id}` 的**会话记忆摘要**（每会话仅数 KB）——无消息本体、无工具调用、无 token 用量。

结论：**三个 trace 核心维度全缺，不值得做适配器**。硬转只能得到标题级空壳 run，与内容级查看定位不匹配。

真正的价值是**竞品对照素材**：Trae 选择"加密 + 锁定"= 用户对自己的 agent 运行数据没有主权；这从反面印证了两点——
1. ReBaseAgent local-first（明文 JSONL 落盘、用户可直接拿走数据）的定位有真实对照物；
2. 「通用导入器」的适用边界 = 把数据明文留给用户的工具（WorkBuddy / Claude Code / Qoder），封闭生态天然排除——这本身就是 local-first 的论证。

## 九、若立项（建议，未起草）

候选 change 名：`import-external-agent-traces`。要点：
- 适配器抽象 + 首批三源（WorkBuddy / Claude Code 风格 / Qoder），格式探测按事件形状判别；
- 导入入口（菜单/拖拽），导入时转换 + `readRun` 自校验 + 落 `<dataDir>/traces/`；
- 请求快照瘦身参数化（窗口/截断），防止长会话爆炸；
- 需决策：Qoder 0-token 的 UI 提示口径（"数据源未提供"vs 显示 0）；
- 可选增强：读 `.file-rollback.ndjson` 呈现"会话改动文件"视图。
