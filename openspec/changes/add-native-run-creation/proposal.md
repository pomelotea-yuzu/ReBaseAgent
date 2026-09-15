# 桌面端原生 run 创建入口（A1 含 D5）

## 背景

当前桌面端 run 只有两个来源：
1. **代理录制（proxy）**：通过本地 LLM 代理捕获的请求
2. **fork**：从已有 run 分叉产生的新 run

这导致一个关键问题：**陌生用户拿到便携版后无法从头体验完整链路**。用户必须：
- 先配置代理并让某个应用经代理跑一次（获得 proxy run）
- 或者使用 SDK 埋点 / `scripts/create-ab-parent.mjs` 脚本（开发者向）

才能进行 prompt fork、模型 A/B、trace-test 等操作。这与"零摩擦接入"的产品定位不一致。

## 目标

**让桌面端能够直接新建并执行一个 run**，无需依赖代理录制或外部脚本。

验收标准：
- 便携版双击 → 新建运行 → 得到原生父 run → 直接在其上跑 A/B / prompt fork / trace-test
- 全程无需写代码、无需配置代理、无需外部应用配合

## 方案概述

### 核心改动

1. **新增 IPC 通道 `runs:create`**
   - 请求体：`{ systemPrompt: string; userMessage: string }`
   - baseURL/apiKey/model 从 settings 取（复用既有运行配置，`settings.load()`）
   - 空工具表（D5 已在 allow-proxy-run-forking 中放开空表 fork）

2. **main 侧新增 `runCreate` 编排函数**（`apps/desktop/src/main/run-create.ts`）
   - 直接复用 `runLoop`（agent-loop）执行，不经 replay 包
   - 产出的 run 是根 run（`parent: null`、`fork: null`），带 `config_hash = configHash(systemPrompt, [])`
   - 作为 prompt fork / 模型 A/B / trace-test 的合法父本

3. **renderer 侧新增"新建运行"对话框**
   - 输入项：systemPrompt（可空）、userMessage（必填）
   - 提交后调用 `runs:create`，成功后刷新列表并自动选中新 run

### 关键设计决策

**为什么默认空工具表？**
- D5 已在 allow-proxy-run-forking 中实现（`buildForkConfig` 把 `recordedTools === undefined` 改为空表）
- 空工具表的 run 可被 fork（`configHash(systemPrompt, [])` 合法）
- 首期不做工具定义编辑 UI，降低复杂度

**为什么没有独立的 task 字段？**（2026-09-15 按代码事实修订）
- `runLoop` 无 task 入参：`run.meta.task` 由它从**首条 user 消息 content** 派生（`packages/agent-loop/src/run-loop.ts:69`）
- 要支持独立 task 必须改 agent-loop 核心（本 change 非目标）
- 因此对话框只收 systemPrompt + userMessage，`meta.task` 即 userMessage 全文——与 SDK 直录 run 口径一致

**为什么 run 落盘要先写临时文件再改名？**（2026-09-15 按代码事实修订）
- 根 run 的 id 由 `runLoop` 内部生成（`run-loop.ts:67`），调用方无法预先指定
- 而仓库按 id 取文件：`loadRunRecord(id)` 读 `${tracesDir}/${id}.jsonl`，列表扫描也只认 `*.jsonl`（`run-repository.ts:19,119`）
- 故落盘流程 = 写 `tmp-create-*.tmp`（不带 `.jsonl` 后缀，列表看不见半成品）→ `readRun` 取 `meta.id` → 改名为 `${meta.id}.jsonl`
- 与既有根 run 产出脚本同法：`scripts/create-ab-parent.mjs:58,77-79`

**为什么不复用 proxy fork？**
- proxy fork 是"编辑 messages 重发"，语义是单请求级分叉
- 原生 run 创建是"从头执行一个完整的 agent loop"，语义不同
- 分开更清晰，避免混淆

**为什么不引入新依赖？**
- runLoop 已具备完整能力
- 保持依赖最小化

## 影响范围

### 修改的文件

1. `apps/desktop/src/main/run-create.ts`（新增）
   - `RunCreateOptions` / `runCreate`

2. `apps/desktop/src/main/ipc.ts`
   - 注册 `runs:create` 通道（校验 → settings 拦截 → 编排 → 错误映射）

3. `apps/desktop/src/shared/channels.ts`
   - 新增 `CHANNELS.createRun = "runs:create"`

4. `apps/desktop/src/shared/ipc.ts`
   - 新增 `CreateRunRequestSchema` / `CreateRunResultSchema`
   - `WindowApi` 新增 `createRun`

5. `apps/desktop/src/preload/index.ts`
   - 暴露 `createRun`

6. `apps/desktop/src/renderer/src/store.ts`
   - 新增 `createRun` action

7. `apps/desktop/src/renderer/src/components/CreateRunDialog.tsx`（新增）

8. `apps/desktop/src/renderer/src/components/RunList.tsx`
   - 头部新增"新建运行"入口

9. `openspec/specs/desktop-ui/spec.md`（经本 change 的 delta）

### 不改动的部分

- 既有 fork / proxy fork 语义
- 历史 trace 文件
- agent-loop 核心逻辑（runLoop 签名与 startRun 语义不动）
- replay 包

## 验收标准

1. **功能验收**
   - 用户可在桌面端新建 run（填写 systemPrompt + userMessage）
   - 新 run 出现在列表中（文件名 = `meta.id`）并被自动选中
   - 新 run 可作为父本进行 prompt fork / 模型 A/B / trace-test

2. **边界情况**
   - 未配置 settings 时提示先配置（`SETTINGS_NOT_CONFIGURED`，不发任何网络请求）
   - systemPrompt 为空时允许（`config_hash = configHash("", [])`）
   - userMessage 为必填（renderer 禁用提交 + main 侧 zod 兜底）
   - 执行失败时返回 `CREATE_RUN_FAILED`，run 文件保留并可按 id 加载（列表徽标显示"出错终止"；`status` 字段只表示"是否含终止事件"，失败语义由终止原因表达）

3. **兼容性**
   - 既有 fork / proxy fork 行为不变
   - 历史 trace 文件不受影响
   - 新 run 的 `config_hash` 与 `configHash(systemPrompt, [])` 逐字节相等

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 用户填写的 systemPrompt / userMessage 触发模型报错 | `runLoop` 不抛 LLM 失败而是返回 `errored`；`runCreate` 据此抛 `CREATE_RUN_FAILED`，已落盘的 error run 保留供排查 |
| 进程在 run 中途被杀，留下 `tmp-create-*.tmp` | 临时文件不带 `.jsonl` 后缀，列表扫描不认（`run-repository.ts:19`），不产生半成品 run；残留文件仅占磁盘 |
| 与 proxy run 混淆 | 新建 run 不写 `source` 字段（与 SDK 直录同形），列表"仅本地直录"过滤可见 |
| 空工具表限制使用场景 | 首期 MVP，后续可扩展工具定义编辑 UI |

## 非目标（Non-goals）

- 不改 `agent-loop` 的 `runLoop` 签名与 `startRun` 语义（含"独立 task 字段"）
- 不做工具定义编辑 UI、多步对话、模板创建
- 不做"取消运行"（无 AbortController 接线）
- 不做版本号 / changelog / 打包发版（发版时机由 owner 决定）
- 不引入既定技术栈外的新依赖

## 后续扩展（不在本期范围）

- 工具定义编辑 UI（允许用户添加工具）
- 多步对话（当前只支持单轮 user message）
- 从模板创建（预设常用 systemPrompt）
- `maxIterations` / `budget.maxTotalTokens` 变为可配置（当前与既有 fork 硬编码值一致：10 / 100_000）
- 独立 task 显示名（需 agent-loop 支持 `task` 入参）
- **失败原因可诊断**（真机验证 2026-09-15 发现的缺口）：`runLoop` 捕获 LLM 失败后只写 `errored` 事件、不上报错误文本（只 `console.error`），故 UI 无法显示"为什么失败"。修复需 agent-loop 在失败 `llm.call` span 上带错误文本 + `trace-format` 允许该字段，属独立 change（拟名 `add-llm-error-detail`）
