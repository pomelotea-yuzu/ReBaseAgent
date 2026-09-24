# 2026-09-09 工作日志 · ReBaseAgent V3b 完整闭环

> 今日主题：V3b「模型/采样参数 A/B 实验」（`add-model-ab-experiments`）从规划修订 → 审阅放行 → 实现 → 归档 → 真实冒烟 → 文档收口，全链路一次跑通。
> 配套文档：`docs/reviews/2026-09-09-v3b-model-ab-experiments-review.md`（三审记录）、`docs/product/2026-09-09-roadmap-gaps.md`（缺口与节奏）。
> 本文件不提交（遵循 docs/ 不入库约定，用户手动 push）。

---

## 一、今日总览

| 项 | 结果 |
|---|---|
| 核心交付 | V3b A/B 实验能力端到端可用（CLI + 桌面 UI 双入口） |
| 提交 | `c01a32d`（规划）→ `fd3ab71`（apply）→ `42005a5`（archive）→ `c912359`（冒烟脚本）→ `79d2fbf`（README） |
| 真实冒烟 | ✅ `exp_mttvdcko_6h5c` 两臂成功（DeepSeek，temperature 0.2 / 1.5） |
| 测试 | replay 66 / desktop 156 / agent-loop 52 / trace-sdk 75 / trace-test 65 / llm-proxy 16 全绿；openspec strict 10/10；biome 0 errors；electron-vite build 通过 |
| 主 spec | 10 个（新增 `model-experiments`，9 条 requirement） |

---

## 二、V3b 关键历程

### 2.1 第二审 + 修订（13:45，条件放行）
走**甲路线**：扩展既有 prompt fork（`fork.edit.field` 是自由字符串，无需新建 ExperimentRecord 体系），把 `model_params` 作为编辑维度并入。
第二审新发现 5 条必修（M1–M4、M11）与若干措辞项，全部消化后 `openspec validate --all --strict` 10/10 通过，提交 `c01a32d`。

关键发现：
- **M1 副作用门禁过严**：真实 trace 里 `write_file` 未标 `sideEffect`（默认 true），导致凡用过写文件的 run 都无法做 A/B；补标记又会改 `configHash`（违反「config_hash 与父一致」）。→ 加 `allowSideEffects` 逃生舱（默认拒绝、显式声明才放行），并写明可用性边界（首期只有未用 `write_file` 的 run 能做 A/B）。
- **M2 多次实验无法配对**：同父多臂都是兄弟 run，UI 分不出哪两臂一对。→ `model_params` value 加可选 `experimentId`，一次 `modelReplayRunMany` 即一批。
- **M3 CLI 悬空**：replay 无 bin；且 CLI 侧无工具 handler 来源。→ 新增独立 bin `rebaseagent-model-ab`，首期限定空工具表。
- **M4 漏前置**：缺「拒绝缺少 system 消息的父 run」场景。
- **M11 覆写 vs 拒绝冲突**：既有实现强制覆写 `systemPrompt`，沿用则「双真相源拒绝」永不触发。→ 写清**先校验后覆写**。

### 2.2 apply（commit `fd3ab71`）
五任务全勾（replay 内核 → 多臂编排 → 桌面 IPC/UI → 测试），tasks.md 17 项全 `[x]`。
- 内核口径：**`value.params` 缺省 = 继承父 params**（`prompt-fork.ts` L241 `value.params ?? parentParams`）；空实验 = 全部臂 model+params 均与父相同。
- 副作用门禁判据 = **父 run 录制工具表**（而非调用方入参），更贴近「真实数据是否会变」。

### 2.3 归档（commit `42005a5`）
`openspec archive add-model-ab-experiments` → `archive/2026-09-09-add-model-ab-experiments`；新建主 spec `openspec/specs/model-experiments/spec.md`（9 条 requirement），全仓主 spec 升至 10 个。

### 2.4 真实 A/B 冒烟（17:02 通过）
- **父 run 鸡生蛋缺口**：仓库内所有真实 run 要么 `source=proxy`（fork 门禁拒），要么带工具/未封存的测试 fixture，没有满足 CLI 父链门禁的父 run；桌面端也没有原生新建 run 入口。
- **解法**：新增 `scripts/create-ab-parent.mjs`——真实调一次 LLM，生成原生+纯对话+已封存父 run 落盘 traces（与测试 `createParent` 同构）。提交 `c912359`。
- **结果**：`exp_mttvdcko_6h5c`，两臂 `deepseek-chat` temperature=0.2 / 1.5 → `run_mttvdcko_0p8q` / `run_mttvddwj_mg81`，均成功；产物核对（parent / edit_field=model_params / 同 experimentId / 请求 params 与声明一致 / 回答确有差异）全过。

### 2.5 文档收口（commit `79d2fbf`）
README 更新（V3a/V3b 能力、双 CLI 用法、路线图勾掉 V3b、限制声明补原生 run 缺口）；另落 `docs/product/2026-09-09-roadmap-gaps.md` 缺口清单与发布节奏。

---

## 三、关键技术决策与不变量

| 主题 | 决策 |
|---|---|
| **双真相源守护** | `RunConfig.systemPrompt` 须与父 run 首次 `llm.call` 录制的 system 消息一致才允许 fork；config_hash 不可逆、不反推、不覆写掩盖 |
| **config_hash 校验** | 父链门禁比较 `configHash(systemPrompt, tools)` 与 `parent.record.meta.config_hash`，不一致拒绝 |
| **proxy 父 run 门禁** | `meta.source.kind === "proxy"` 的 run 不能作为 fork / A/B 父本（无重建源配置） |
| **ToolPolicy** | `require_pure` / `require_empty` + `allowSideEffects` 逃生舱；多臂**顺序执行**，副作用会污染后续臂 |
| **experimentId** | 同批实验必须相同，随 `fork.edit.value.experimentId` 落盘，桌面端按此分组 |
| **model_params 口径** | `value.params` 缺省 = 继承父 params；空实验 = 全部臂均与父相同 |
| **退出码** | CLI `0`=全成功 / `1`=某臂失败 / `2`=配置前置错误 |
| **runLoop 终止事件** | 正常结束发 `stopped`（reason=completed），**非** `completed` |
| **措辞纪律** | 沿链数字一律「累计增量（沿链求和）」，禁用「总耗时/总成本」 |

---

## 四、改动文件清单

**replay 内核**（`packages/replay/src/`）
- `prompt-fork.ts`：`PromptForkEdit` 扩展为 union（`system_prompt` / `user_message` / `model_params`），新增 `ModelParamsValue` zod schema，派生支持 model_params
- `fork-parent.ts`：抽取共用父链 / 封存 / proxy / config_hash / system 消息校验（`loadForkParent`）
- `model-replay-run.ts`：`modelReplayRunMany` 多臂顺序执行（独立 tracer/client/AbortController、`DEFAULT_MAX_ITERATIONS=10` / `DEFAULT_MAX_TOTAL_TOKENS=100_000`、副作用门禁、dry-run / `--confirm-cost`、experimentId 分批、单臂失败隔离 `ModelAbError`）
- `model-ab-cli.ts`：CLI `rebaseagent-model-ab`（`--parent/--dir/--arm "model;k=v"/--dry-run/--confirm-cost/--base-url/--experiment-id/--report json`）
- `index.ts`：导出 `modelReplayRunMany`、`ModelArmSpec` 等

**桌面端**（`apps/desktop/src/`）
- `shared/ipc.ts` + `channels.ts` + `preload/index.ts`：新增 `runs:modelAb` IPC（复用 settings 单一 baseURL/apiKey）
- `main/fork-runner.ts`：`buildForkConfig` 共用父链重建，`runModelAb` 编排
- `main/ipc.ts`：modelAb handler
- `renderer/src/store.ts`：`modelAb` action（dryRun 预览 / 真实执行共用，执行后刷新列表）
- `renderer/src/lib/model-ab.ts`：guard 纯函数（臂数、params JSON 校验、空实验 `sameAsParent`、副作用确认 `riskyToolNames`）
- `renderer/src/components/DetailPanel.tsx`：`ModelAbEditor`（2~4 臂编辑 → dry-run 预览 → 费用确认 → 结果横幅）
- `renderer/src/components/ComparePanel.tsx` + `BranchTree.tsx`：按 experimentId 分组
- `shared/derive.ts`：`forkEditLabel` 支持 model_params；`deriveRunSummary` 提取 `RunSummary.fork.experiment_id`

**其他**
- `scripts/create-ab-parent.mjs`：冒烟辅助（现造原生纯对话父 run）
- `biome.json`：新增 ignore `release/`
- `openspec/specs/model-experiments/spec.md`：9 条 requirement
- `docs/product/2026-09-09-roadmap-gaps.md`：缺口清单（不入库）
- `README.md`：V3a/V3b 能力、双 CLI 用法、路线图（入库 `79d2fbf`）

---

## 五、关键坑与修复

1. **PowerShell `\` 续行报错**：用户复制 Bash 风格多行命令，改为单行 + `$env:VAR="..."`（非 cmd 的 `set X=`）。
2. **proxy 父 run 被拒**：仓库无合法父 run，写 `create-ab-parent.mjs` 现造。
3. **脚本误报失败**：`create-ab-parent.mjs` 初版判断 `event !== "completed"` 误报；runLoop 正常终止是 `stopped`，父 run 事后 salvage 为 `run_mttvbmww`，脚本已修正为 `stopped` 判断。
4. **Biome `noArrayIndexKey`**：DetailPanel arm 行改用稳定 `newArmKey`；`noDelete` 改用 `env.X = undefined`（Node spawn 对 undefined env 按缺省处理，测试仍过）。
5. **Bash 工具 cwd 中途失效**：统一「绝对路径二进制 + `vitest run --root "D:/…"`（必须 Windows 风格，`/d/` 会被拼成 `d:\d\`）」；electron-vite build 用子 shell `(cd … && …)`。

---

## 六、真实冒烟结果

| 字段 | 值 |
|---|---|
| 实验 ID | `exp_mttvdcko_6h5c` |
| 父 run | `run_mttvbmww`（create-ab-parent.mjs 现造，原生+纯对话+已封存） |
| arm 1 | `deepseek-chat` temperature=0.2 → `run_mttvdcko_0p8q`（成功） |
| arm 2 | `deepseek-chat` temperature=1.5 → `run_mttvddwj_mg81`（成功） |
| 核对项 | parent / edit_field=model_params / 同 experimentId / 请求 params 与臂声明一致 / 两臂回答确有差异 ✅ |

---

## 七、缺口与下一步（详见 roadmap-gaps.md）

**A 级（产品核心，下一版本主线）**
- **A1 原生 run 入口**：桌面端无「直接新建 run」功能，A/B/CLI 缺合法父本 → 便携版用户无法从头体验。高杠杆小改动。
- **A2 共享前缀重跑**：改第 N 步脏 tool_result → 只重跑后半段（成本约 1/4），最直观的「省钱」demo。
- **A3 隔离世界真重跑**：sideEffect 分级预埋，带写文件工具的真实重跑仍空档。

**B 级（分发与信任）**
- **B1 CI**：GitHub Actions 跑 6 包 vitest + biome + `openspec validate --all --strict`。
- **B2 用户文档**：截图/GIF 演示 + 「5 分钟上手」。
- **B3 跨平台打包 / 代码签名评估**。

**C 级（远期，商业模式未定）**：协作分享、Pro/团队版（本地免费 MIT 不动摇）。

**建议节奏**：A1+B1 → v0.2.1；A2+A3 → v0.3.0。

---

## 八、提交与 push 状态

- 今日 5 个 commit：`c01a32d` / `fd3ab71` / `42005a5` / `c912359` / `79d2fbf`。
- 双远程（github `pomelotea-yuzu/ReBaseAgent` + gitee `yuzu-tea-duck/re-base-agent`）已由用户手动 push（用户确认 `push ok`）。
- **docs/ 与 HANDOFF.md 未提交**（遵循不入库约定，待用户手动 push）。

## 九、待办
- [ ] push `docs/`（roadmap-gaps.md、本 daily-summary.md、review.md，按约定手动）
- [ ] 下轮建议：A1 原生 run 入口 + B1 CI（一个 PR 周期内可完成）
- [ ] 桌面端 A/B 分组查看 UI（可选，实验已按 experimentId 落盘，UI 分组已实现）
