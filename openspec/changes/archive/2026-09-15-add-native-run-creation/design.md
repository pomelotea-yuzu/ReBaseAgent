# 设计：桌面端原生 run 创建入口

> 2026-09-15 按代码事实修订：审阅（`docs/reviews/2026-09-15-add-native-run-creation-proposal-review.md`）的
> 2×P1 / 2×P2 全部收口，另修入实现前调研发现的 1 项设计缺陷（task 字段）。逐条对照见文末 §11。

## 1. 架构选择：复用 runLoop，不新建执行路径

**决策**：新增 `runCreate` 编排函数直接调用 `runLoop`，不经过 replay 包。

**理由**：
- `runLoop` 是 agent-loop 的核心执行函数，接受 `RunConfig` + `initialMessages` + `tracer` + `tools` + `llm` + `forkRun`
- replay 包的 `replayRun` / `promptReplayRun` 是"从父 run 重建 config 再执行"，语义是"重跑"
- 原生 run 创建是"从头执行"，没有父 run，不需要 replay 的重建逻辑
- 直接调用 runLoop 更简单、更清晰

**实现位置**：`apps/desktop/src/main/run-create.ts`（新模块）
- 不放在 `fork-runner.ts`，因为语义不同（fork vs create）
- 与 `fork-runner.ts` 平级。**注意**：`fork-runner.ts` 的 `attachHandlers` / `toToolDefsOrThrow` 是模块私有函数（未导出）且面向"从父 run 恢复工具表 + 绑 handler"；本 change 首期是空工具表，**两者都用不到**，因此不为复用而改 fork-runner 的导出面。

## 2. IPC 通道设计

**通道名**：`runs:create`（常量 `CHANNELS.createRun`，定义在 `apps/desktop/src/shared/channels.ts`）

**请求体**：
```typescript
{
  systemPrompt: string;   // 必填字段，可为空字符串（空 ⇒ config_hash = configHash("", [])）
  userMessage: string;    // 必填，非空（main 侧 zod .min(1) 兜底）
}
```

**响应体**：
```typescript
{ id: string }  // 新 run 的 id
```

**错误码**：
- `INVALID_ARGUMENT`：请求形状不合法（zod 校验失败）
- `SETTINGS_NOT_CONFIGURED`：settings 未配置（复用既有错误码与文案）
- `CREATE_RUN_FAILED`：执行失败（`runLoop` 返回 `errored`）

**为什么请求体没有 `task`？**（原设计有，2026-09-15 删除）
- `runLoop` 的 `startRun` 把 `meta.task` 写成**首条 `role === "user"` 消息的 content**（`run-loop.ts:69`），**没有 task 入参**
- 原设计的"task 可选，缺省取 userMessage 前 50 字符"在现有 API 下**无法实现**；要支持必须改 agent-loop 核心，属本 change 非目标
- 结论：`meta.task` = userMessage 全文（与 SDK 直录 run 口径一致，列表渲染既有逻辑不变）

**为什么请求体没有 `tools` 字段？**
- 首期 MVP 只做空工具表；后续扩展时再加（可选，缺省空表）

## 3. 落盘约束：必须"临时文件 + 改名"

**代码事实**：
- 根 run 的 id **由 `runLoop` 内部生成**：`id: forkRun?.id ?? \`run_${Date.now().toString(36)}\``（`run-loop.ts:67`）。调用方只能通过 `forkRun.id` 指定 id，而传 `forkRun` 会同时把 run 变成 fork run（parent 非 null）——原生创建**不能用**。
- 仓库**按 id 定位文件**：`RunRepository.loadRunRecord(id)` 读 `${tracesDir}/${id}.jsonl`（`run-repository.ts:119`）；`listRuns()` 只扫 `*.jsonl`（`run-repository.ts:19`）。
- ⇒ 文件名必须等于 `meta.id`，但 id 只能在 run 开始后才能得知 ⇒ **先写临时文件，run 结束后按 `meta.id` 改名**。

**落盘流程**：
1. `tmpFile = join(tracesDir, \`tmp-create-${Date.now().toString(36)}.tmp\`)`——**不带 `.jsonl` 后缀**，列表扫描不认，因此半成品 run 永不出现在 UI
2. `new JsonlTracer(tmpFile)`（`JsonlTracer` 只接受路径字符串；文件已存在且非空时构造函数会抛）
3. `await runLoop(...)`
4. `finally`：若 tmp 文件存在 → `readRun(tmpFile).meta.id` → `renameSync(tmpFile, join(tracesDir, \`${id}.jsonl\`))`
   - 无论 run 成功还是 errored 都要归位：error run 也是事实，spec 要求它存在且状态为 error
   - `readRun` 抛错（中途被杀的残缺文件）时不吞原错误：保留 tmp 供排查，原错误继续向外抛

**与既有脚本同法**：`scripts/create-ab-parent.mjs:58,77-79` 就是这套（该脚本用 `tmp-ab-parent.jsonl`，本模块改为不带 `.jsonl` 后缀以避免被列表扫到）。

## 4. 编排逻辑

```typescript
// apps/desktop/src/main/run-create.ts
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { OpenAiCompatClient, runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, Message, RunConfig, RunResult } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import type { RunRepository } from "./run-repository.js";
import type { RunSettings } from "./settings.js";

/** 桌面端新建 run 的编排依赖（与 ForkRunnerOptions 同形） */
export interface RunCreateOptions {
  repository: RunRepository;
  /** 运行配置（main 已解密；未配置由调用方先行拦截） */
  settings: RunSettings;
  /** 工具执行的工作目录（首期空工具表，仅保持与 fork 同形） */
  execCwd: string;
  /** LLM 客户端（测试注入 mock；缺省真实调用 settings.baseURL） */
  llm?: LlmClient;
}

export interface RunCreateRequest {
  systemPrompt: string;
  userMessage: string;
}

export class CreateRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CreateRunError";
  }
}

/** 与既有 fork 硬编码值一致（fork-runner.ts 的 RunConfig 组装） */
const MAX_ITERATIONS = 10;
const MAX_TOTAL_TOKENS = 100_000;

export async function runCreate(
  options: RunCreateOptions,
  request: RunCreateRequest,
): Promise<{ id: string }> {
  const { repository, settings, execCwd, llm } = options;
  const tracesDir = repository.tracesDir;

  // 1. 组装 RunConfig（空工具表）
  const config: RunConfig = {
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: request.systemPrompt,
    tools: [], // 首期空工具表（D5 已放开空表 fork）
    exec: { cwd: execCwd, signal: null },
    maxIterations: MAX_ITERATIONS,
    budget: { maxTotalTokens: MAX_TOTAL_TOKENS },
  };

  // 2. 初始消息：system 恒存在（可为空串）——prompt fork 的门禁要求
  //    首次 llm.call 含"字符串形式的 system 消息"（replay/src/fork-parent.ts:64-69）
  const messages: Message[] = [
    { role: "system", content: request.systemPrompt },
    { role: "user", content: request.userMessage },
  ];

  // 3. 落盘见 §3：临时文件 → 按 meta.id 改名
  const tmpFile = join(tracesDir, `tmp-create-${Date.now().toString(36)}.tmp`);
  const tracer = new JsonlTracer(tmpFile);

  let outcome: RunResult;
  let runId: string | null = null;
  try {
    // 第 6 参 forkRun 必须省略：它可选（run-loop.ts:55），省略 = 根 run。
    // ⚠️ 不能传 null——类型是 `forkRun?: ForkRunMeta`，传 null 是类型错误。
    outcome = await runLoop(config, messages, tracer, [], llm ?? new OpenAiCompatClient(config));
  } finally {
    if (existsSync(tmpFile)) {
      runId = readRun(tmpFile).meta.id;
      renameSync(tmpFile, join(tracesDir, `${runId}.jsonl`));
    }
  }

  // 4. runLoop 不抛 LLM 失败：它记 errored 并正常返回（run-loop.ts:113-130）
  //    因此成败判据是终止事件，而不是 try/catch
  if (outcome.event.event === "errored") {
    throw new CreateRunError(
      "CREATE_RUN_FAILED",
      `run ${runId ?? "(未落盘)"} 执行失败（${outcome.event.reason}）——调用未完成，详见该 run 的 trace`,
    );
  }

  return { id: runId ?? "" };
}
```

**关键点**：
- `JsonlTracer` 只接受**文件路径字符串**（第 2 参是可选 `{ spanSeqStart }`）；**`config_hash` 不是构造参数**，它由 `runLoop` 现算并写进 `startRun` 的 meta（`run-loop.ts:79`），调用方不得重复计算
- `runLoop` 会写全 meta：`id` / `format_version` / `task`（首条 user 消息）/ `model` / `created_at` / `parent: null` / `fork: null` / `budget` / `config_hash`
- `config.tools` 与传入的 `tools`（含 handler）必须等长（`run-loop.ts:62`），空表两侧都是 `[]`，满足
- `llm` 由 `options` 注入（测试用 `MockLlmClient`），缺省 `new OpenAiCompatClient(config)`
- **`source` 字段不写**（`runLoop` 本就不写），见 §5

## 5. `source` 字段与来源归类

**现状（代码事实）**：
- 代理录制的 run 有 `meta.source = { kind: "proxy", base_url }`（由 `ProxyRunRecorder` 写）
- SDK 直录 / `runLoop` 直录的 run **无 `source` 字段**；IPC 侧 `RunSummary.source` 的 schema 是 `z.enum(["proxy"]).nullable()`（`shared/ipc.ts:63-65`）
- 列表渲染层**只有"代理"徽标**（`RunList.tsx:99-106` 判 `source === "proxy"`）；"本地直录"是**过滤按钮文案**（`RunList.tsx:52`，判据 `r.source !== "proxy"`）

**新建 run 的处理**：不写 `source`（与 SDK 直录同形）⇒ 列表归入「仅本地直录」过滤类别，**不新增徽标**、不改渲染逻辑。
（原始草案打算新增"本地直录"徽标，实测发现该文案只是过滤标签、并非徽标；为此新增 UI 属无收益扩面，故改为"与 SDK 直录同形"的口径。）

**既有 spec 已覆盖**：`desktop-ui` 的「run 列表标注录制来源并可过滤」已规定"无 `source` 字段的老文件归入「本地直录」，不报错"——新建 run 正落在此条内，**不重复立 requirement**。

## 6. UI 设计

**入口位置**：`RunList.tsx` 头部标题区（"运行记录"旁），新增"新建运行"按钮，点击弹出对话框。

**对话框内容**：
```
┌─────────────────────────────────────┐
│ 新建运行                              │
├─────────────────────────────────────┤
│ System Prompt（可选）:                │
│ ┌─────────────────────────────────┐ │
│ │ [多行文本框]                     │ │
│ └─────────────────────────────────┘ │
│                                      │
│ User Message（必填）:                 │
│ ┌─────────────────────────────────┐ │
│ │ [多行文本框]                     │ │
│ └─────────────────────────────────┘ │
│                                      │
│         [取消]  [创建]               │
└─────────────────────────────────────┘
```

**交互逻辑**：
- System Prompt 可为空（空时给出"建议填写"的弱提示文案）
- User Message 必填（为空时禁用"创建"按钮）
- 点击"创建"后：显示 loading（`创建中…`，按钮禁用防止重复提交）→ 调用 `window.api.createRun`
  - 成功：关闭对话框、刷新列表、自动选中新 run
  - 失败：对话框内显示错误信息（来自信封 `error.message`），不关闭对话框以便用户改后重试
- Esc / 点关闭按钮 / 取消 → 关闭（照 `SettingsDialog` 既有交互）

**组件与样式**：新建 `apps/desktop/src/renderer/src/components/CreateRunDialog.tsx`，骨架照 `SettingsDialog`（`fixed inset-0 z-50` 遮罩 + `<dialog open>` + `onCancel` 阻止默认 + Esc 监听）；主按钮 `rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40`。开关状态用 `RunList` 内的本地 `useState` 管理（与 `App.tsx:20` 管 `settingsOpen` 的方式一致）。

## 7. 与既有功能的集成

**与 prompt fork / 模型 A/B 的集成**：
- 新建 run 有 `config_hash`，且首次 `llm.call` 含字符串 system 消息（空串也算字符串），满足 `loadForkParent` 的全部门禁（`fork-parent.ts:49-69`）
- `buildForkConfig` 已把 `recordedTools === undefined` 改为空表（D5），空工具表父 run 可被 fork
- 复用既有 `runPromptFork` / `runModelAb` 编排，无需改动

**与 trace-test 的集成**：
- 新建 run 是根 run（`parent: null`），可作 trace-test 的目标
- 复用既有编排，无需改动

**与代理分叉（`proxy:fork`）无关**：新建 run 无 `source.kind === "proxy"`，不会走降级父链视图分支（`run-repository.ts:59`）

## 8. 错误处理

| 场景 | 发生位置 | 行为 |
|---|---|---|
| 请求形状不合法 | IPC handler | zod 校验失败 → `INVALID_ARGUMENT`，零副作用 |
| settings 未配置 | IPC handler（`settings.load()` 返回 null） | `SETTINGS_NOT_CONFIGURED`，**在创建 tracer / 发网络请求之前**拦截 |
| `userMessage` 为空 | renderer（禁用按钮）+ main（zod `.min(1)`） | 无网络请求 |
| 模型调用失败 | `runLoop` 内部 | 不抛：记 `errored` 终止事件并返回；`runCreate` 据此抛 `CreateRunError("CREATE_RUN_FAILED")`；**run 文件已按 `meta.id` 归位**，且 renderer 侧失败也会**重新拉取列表**（否则用户看不到那条 error run）——徽标显示"出错终止" |
| 进程中途被杀 | — | 只剩 `tmp-create-*.tmp`（列表不认）→ 不产生半成品 run |

**为什么 error run 要保留而不是删掉？**：trace 是不可变事实源，失败的 run 也是事实（`assertForkable` 会因未正常封存而拒绝对它 fork），删掉反而让用户失去事故现场。

**⚠️ 状态字段口径（实现时校正）**：`RunRecord.status` 只有 `"completed" | "crashed"` 两值，判据是"**是否含终止事件**"（`reader.ts:106`）——`errored` 也写了终止事件，故 error run 的 `status` 仍是 `completed`，失败语义由列表徽标渲染的终止原因（`reason: "error"` → "出错终止"，`lib/format.ts:40`）表达。原始草案写的"状态为 error"不成立，已按此更正 spec 与测试断言。

### 8.1 真机验证发现（2026-09-15，首次真实点击）

真机跑了一次（`run_mu2guw5y`，DeepSeek 返回 **HTTP 401：`Your api key: ****2e15 is invalid`**——settings 里那把 key 已失效）。核对结果：落盘与设计一致（文件名 = `meta.id`、`parent`/`fork` 为 `null`、无 `source`、`meta.task` = user message、`config_hash` 与现算值逐字节相等、请求体不含 `tools` 键、终止事件 `errored`）。

这次真跑也**暴露了两处实现不准确，已修**：

1. **错误文案在骗人**：原文案说"可在列表中查看详情"，但失败原因（401 的响应体）**只被 `runLoop` 打到主进程日志，不写入 trace**——端上 `llm.call` 的 response 只有空 content 与 `{in:0,out:0}`。文案已改为只承诺"能点开看这次请求"，并明说 trace 不记录错误详情。
2. **失败后不刷新列表**：`store.createRun` 原先在失败分支直接 `return false`，于是"在列表与详情中可查看"当场不成立（error run 落盘了但列表没重拉）。已改为失败分支同样 `loadRuns()`。

**遗留缺口（本 change 不修，见 proposal 后续扩展）**：失败原因无法从 UI 获得。要真正修好需要 agent-loop 在失败 span 上带错误文本 + `trace-format` 允许该字段，属独立 change（`add-llm-error-detail`）。

**成功路径真机复验（2026-09-15 17:34，owner 换有效 key 后）**：`run_mu2h6jz9` —— `run.event = stopped/completed`、`llm.call` 有真实内容、`usage = {in:25, out:40}`、`ttft_ms = 751`（非 0，说明 ttft 取时点确实落在流读取过程中，与 `fix-llm-ttft-timing` 的口径一致）。至此**成功与失败两条真实路径都验过**。

## 9. 测试策略

**遵循仓库既有测试约定**（`apps/desktop/test/*.test.ts`；vitest `environment: node`，`include: ["test/**/*.test.ts"]`）：
- **不 mock `runLoop`**：仓库既有测试一律跑真实 `runLoop` + `MockLlmClient`（`packages/agent-loop/test/helpers`），无 mock 先例——mock 掉就测不到 meta 落盘、config_hash 与临时文件改名
- **不测 `ipc.ts`**：仓库无 `ipcMain` mock 先例；IPC 层逻辑（zod 校验 + settings 拦截 + 错误码映射）在 handler 里是直白分支，改由 §7 的编排层测试 + 手工验收覆盖
- **临时 traces 目录**：`mkdtempSync(join(tmpdir(), "run-create-"))` + `RunRepository(traces)`

**用例清单**（`apps/desktop/test/run-create.test.ts`）：
1. 新建 run 成功 → 落盘文件名为 `${meta.id}.jsonl`、`status === "completed"`
2. 新 run meta：`parent === null`、`fork === null`、`task === userMessage`、`config_hash === configHash(systemPrompt, [])`
3. 无 `source` 字段（与 SDK 直录同形）
4. 空 systemPrompt → 允许，`config_hash === configHash("", [])`
5. LLM 失败（`MockLlmClient` 抛错）→ `runCreate` 抛 `CreateRunError("CREATE_RUN_FAILED")`，且文件仍按 `meta.id` 归位、`status === "error"`
6. 无残留 `tmp-create-*.tmp`（成功与失败两条路径）
7. **集成（A1 的核心验收）**：新建 run 作为父本 → `runPromptFork` 成功、子 run `meta.parent` 指向它
8. **集成**：新建 run 作为父本 → `runModelAb` 两臂成功、各臂 `meta.parent` 指向它

## 10. 文档更新

- `openspec/specs/desktop-ui/spec.md`（经本 change delta）：新增"桌面端提供原生 run 创建入口"；MODIFIED「分叉重跑是唯一的显式写路径」以容纳第二条写通道
- `README.md`：快速开始补"从桌面端新建 run"（含"无需代理、无需写代码"的定位说明）
- `HANDOFF.md`：A1 状态与下一步（收尾时更新）

## 11. 与审阅意见的对应（2026-09-15 收口）

| 审阅项 | 处理 |
|---|---|
| **P1-1** `runLoop` 调用参数不完整 / 建议显式传 `forkRun: null` | **按代码事实更正**：`forkRun?: ForkRunMeta` 是可选的（`run-loop.ts:55`），**省略即根 run**；传 `null` 反而是类型错误。§4 代码示例显式说明"省略"。`llm` 来源已明确：`options.llm ?? new OpenAiCompatClient(config)` |
| **P1-2** `FileTracer` 构造签名未核实 | **核实并更正**：类名是 `JsonlTracer`（`trace-sdk/src/index.ts:44`），构造函数 `(file: string, options?: { spanSeqStart?: number })`；**`config_hash` 不是构造参数**，由 `runLoop` 现算（`run-loop.ts:79`），调用方不得重复计算。§4 代码已按真实签名重写 |
| **P2-1** `maxIterations` / `budget` 硬编码 | **确认沿用**：与既有 `fork-runner.ts:115-116` 的硬编码值完全一致（10 / 100_000），首期保持一致以免两套编排口径分叉；已列入 proposal「后续扩展」 |
| **P2-2** `source` 字段实现细节缺失 | **已补 §5**：写入位置=不写；枚举=无（`RunSummary.source` 仅 `"proxy" \| null`）；老文件与新 run 都归入「本地直录」过滤类别。原拟新增"本地直录"徽标经核实现状只是过滤标签，故改为"与 SDK 直录同形"，并删掉了与既有 requirement 重复的第二条 ADDED requirement |
| **P3-1** `task` 截断边界 | **随字段删除而消解**（见 proposal 关键决策） |
| **P3-2** UI 提示文案 | 采纳：§6 明确空 systemPrompt 的弱提示与 loading 态 |
| **新发现（实现前调研）** 原设计含独立 `task` 字段 | **删除**：`runLoop` 无 task 入参，`meta.task` 由首条 user 消息派生，原设计不可实现（见 proposal 关键决策） |
| **新发现（spec 冲突）** `desktop-ui`「分叉重跑是唯一的显式写路径」与新增写通道冲突 | **MODIFIED 该 requirement**，正文改为"两条显式写通道（fork / create）"，并保留原 scenario 名（openspec 的 MODIFIED 是整体替换，旧 scenario 不写回会被拒）。requirement 名保留未改——openspec 按名字匹配，改名需 REMOVED+ADDED 组合，本期不做（**已知措辞债**："唯一的"字样已与正文不符） |
