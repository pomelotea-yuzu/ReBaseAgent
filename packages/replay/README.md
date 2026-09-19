# @rebaseagent/replay

回放编排器：从**已完成的 run** 派生"如果当时改一步会怎样"的分支，并真跑一遍。

纯 TypeScript，可 headless / 进 CI。它不负责采集 trace（那是 [`trace-sdk`](../trace-sdk)），也不提供 UI。

## 三种执行方式，先分清

|                        | 普通重跑 / prompt fork            | **隔离文件执行**（A 段新增）            | 卡带重跑（[`trace-test`](../trace-test)） |
| ---------------------- | ----------------------------- | ------------------------------ | --------------------------------- |
| 文件从哪来                  | 宿主磁盘（`config.exec.cwd`）        | **快照的副本世界**（不碰宿主）              | 不涉及文件                             |
| 工具怎么执行                 | 调用方传入的 handler                | 固定 `file-tools-v1`（只有受控读/写）    | **不执行**，逐条消费录制结果                  |
| 文件状态能回退吗               | ❌ 不承诺                         | ✅ 回到分叉那一轮的轮末状态                 | —                                 |
| 父 trace / 源目录会被改吗      | 父 trace 不改；**磁盘可能被改**          | 父 trace、源目录、兄弟分支都逐字节不变         | 只读                                |
| 真调 LLM 吗                | 是（分支点之后）                      | 是（分支点之后）                       | 否（零网络、零费用）                        |
| 适用                       | 只读工具 / 纯对话任务                  | **带写工具的 run 也能安全重跑**           | 已封存 trace 当回归用例                   |

> 一句话：普通重跑快但你得自己承担外部状态不可回退；隔离执行把文件状态也变成可回退的；卡带根本不执行，只验证结构对齐。

## 普通重跑与 prompt fork

- `replayRun`：编辑某个 `tool.invoke` 的 `result`，从该步续跑。分叉点之前的上下文**本地拼接复用**（零 API 调用），只有分支点之后才真调模型。
- `promptReplayRun`：编辑启动上下文（system prompt / 首条 user message）后**从头重跑**，独立记录完整新轨迹。
- `deriveReplayState`：纯函数，导出派生逻辑本身（校验调用方可用它做"这次能不能重跑"的演练，不产生副作用）。
- `modelReplayRunMany`：同一父 run 起点批量换 model / 采样参数（模型 A/B），见下。

**保真边界**：普通重跑的后续工具在 `config.exec.cwd` 里真实执行，**不承诺**外部文件 / 网络 / 数据库 / 任意 handler 的状态可回退。

## 隔离文件执行

三个入口，顺序即调用顺序：

```ts
import { createIsolatedRun, preflightIsolatedReplay, replayIsolatedRun } from "@rebaseagent/replay";

// 1) 从一个显式目录创建一个**可作分叉父本**的根 run（采集完成先于首次 LLM 调用）
const created = await createIsolatedRun({
  dataDir: "data",
  source: "D:/proj/agent-x",
  config,                       // config.tools 必须逐字段等于固定 file-tools-v1
  userMessage: "把 README 的要点写进 summary.md",
  authority: { allowFileWrites: true },   // 本次请求的副本写入授权；缺省即拒绝
  llm,                          // 可选：测试注入
});
if (!created.ok) throw new Error(created.failure.reason);

// 2) 只读预检：这次能不能从那一轮分叉（零 trace / 零 blob / 零 LLM 写入）
const capability = await preflightIsolatedReplay({
  dataDir: "data", parentId: created.id, atSpanId: "s_03",
  edit: { field: "result", value: "编辑后的工具结果" },
  config,
});

// 3) 提交执行：提交时**重新预检**，然后从那一轮的轮末检查点建新世界并续跑
const branch = await replayIsolatedRun({
  dataDir: "data", parentId: created.id, atSpanId: "s_03",
  edit: { field: "result", value: "编辑后的工具结果" },
  config, authority: { allowFileWrites: true }, llm,
});
```

**只读接口**（读历史文件状态，不写任何东西、不要求 run 已封存）：

```ts
import { locateWorkspaceSnapshot, readWorkspaceFile } from "@rebaseagent/replay";

const listed = locateWorkspaceSnapshot({ dataDir: "data", runId: created.id });          // 同步；缺 stepSpanId ⇒ 初始快照
const file = await readWorkspaceFile({ dataDir: "data", runId: created.id, stepSpanId: "s_02", path: "a.txt" });
// file.status: "text" | "binary" | "not_found" | "missing" | "corrupt" | "rejected"
```

留意两点：**不传 `stepSpanId` 读的是初始快照**（要看某轮写入后的文件必须指向那轮的 `agent.step`）；逻辑路径必须在所选清单内，接口不接受物理 blob 路径。

### 文件保真度（诚实声明）

- **保真的**：受控**普通文件的内容**——路径、原始字节与哈希。二进制按原字节保存（不经过替换字符），但读工具只认严格 UTF-8，非 UTF-8 会明确报错而不是给你一份被"修正"过的文本。
- **不保真的**：文件权限、时间戳、符号链接身份、目录结构之外的一切（网络、数据库、进程、环境变量）。源目录里的链接/junction 在导入期被**拒绝**（不跟随、不跳过），不是被"复制成普通文件"。
- **写入范围**：只有副本世界的映射表；源目录在导入之后不再被读，导入完成后源目录怎么变都不影响本次运行。
- **配额**（首期）：单文件 8 MiB、快照 2000 文件 / 64 MiB、一次运行新增唯一内容 128 MiB、逻辑路径 512 UTF-16 单元 / 32 段。超限在导入期拒绝；运行期写入超限变成工具错误，旧映射与已有检查点不变。

### 谁能当父本、谁不能

可以：已封存（有终止事件）、`format_version: 2` 隔离 run、`config_hash` 与本次配置一致、复跑时起始清单的附件逐项可用。

不能（都在创建子 trace 与调用模型**之前**拒绝）：未封存（崩溃）的 run、带 `workspace` 的父本走普通入口、编辑点不在直接父自有记录里（祖先共享前缀）、指向快照之外的编辑点、附件缺失或损坏、`config_hash` 不一致。

## dataDir 布局

```text
<dataDir>/
  traces/<runId>.jsonl                  一 run 一文件，append-only，封存后不可改
  workspace-blobs/sha256/<64 位哈希>      内容寻址附件，跨 run 共享同一份
```

- **附件不是"每 run 一份备份"**：内容相同只存一份（并发发布同一内容也只留一份）。
- **整体迁移 dataDir**：搬走后按新路径重建即可。trace 里只有逻辑路径与哈希、**没有绝对路径**，因此解析、附件读取与后续分叉都不依赖原位置。
- 附件丢失 / 被篡改 / 长度不符：读取接口给出可区分的 `missing` / `corrupt`，分叉被拒；**不会**从源目录重新读来补——那等于把"历史事实"换成"当前磁盘"。
- 临时文件只针对**本请求**创建的那些；已发布的共享附件在任何失败路径上都不删。

## 模型 A/B（`modelReplayRunMany`）

同一父 run 起点批量换 model / 采样参数，每臂独立 fork run、按 experimentId 分组。

- 门禁顺序：臂数 ≥2 → 工具表一致 → 父本校验（父链 / 已封存 / 非隔离 / `config_hash` / 字符串 system 消息）→ 每臂 edit → 双真相源 → **工具策略** → 同源校验 → dry-run → 顺序执行。
- 工具策略：桌面默认 `require_pure`（每个工具都必须显式 `sideEffect: false`，**缺标记按有副作用处理**）；CLI 首期 `require_empty`（只接受空工具表父本）。整批一起裁决，不会"前几臂跑完才发现最后一臂不合格"。显式 `allowSideEffects: true` 是**全批**逃生舱，声明写进 `fork.edit` 供事后审计。
- CLI：`rebaseagent-model-ab`（`--dry-run` 免密钥不联网；真实执行需 `--confirm-cost` 与 `REBASEAGENT_API_KEY`）。用法见根 [`README`](../../README.md)。
- 带 `workspace` 的隔离父本在本期被整批拒绝（dry-run 与 `allowSideEffects` 都不是逃生通道）。

## 开发

```bash
pnpm --filter @rebaseagent/replay test    # vitest（零 API 消耗）
pnpm --filter @rebaseagent/replay build   # tsc → dist/
```

隔离相关用例的共用夹具在 `test/package-fixture.ts`（三轮 before→middle→after 父本）与 `test/isolated-helpers.ts`（LLM 桩）。
