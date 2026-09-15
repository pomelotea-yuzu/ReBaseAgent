# 任务清单：桌面端原生 run 创建入口

> 2026-09-15 按代码事实重排（见 design.md §11 收口表）。apply 已落地，勾选状态为 2026-09-15 实测。

## 阶段 1：核心实现（main 进程）

### 1.1 创建 run-create.ts 模块

- [x] 新建 `apps/desktop/src/main/run-create.ts`
- [x] 定义 `RunCreateOptions`（repository / settings / execCwd / llm?，与 `ForkRunnerOptions` 同形）
- [x] 定义 `RunCreateRequest`（systemPrompt / userMessage）
- [x] 定义 `CreateRunError`（带 `code`，供 IPC 映射）
- [x] 实现 `runCreate`：
  - 组装 `RunConfig`（空工具表、`maxIterations: 10`、`budget: 100_000`，与既有 fork 一致）
  - 组装初始消息（system 恒存在、可为空串 + user）
  - `new JsonlTracer(tmpFile)`，tmp 文件**不带 `.jsonl` 后缀**
  - 调用 `runLoop`，**省略第 6 参 `forkRun`**（传 null 是类型错误）
  - `finally` 中按 `readRun(tmp).meta.id` 改名为 `${id}.jsonl`
  - 终止事件为 `errored` 时抛 `CreateRunError("CREATE_RUN_FAILED")`

### 1.2 注册 IPC 通道

- [x] `apps/desktop/src/shared/channels.ts` 加 `createRun: "runs:create"`
- [x] `apps/desktop/src/main/ipc.ts` 注册 handler：
  - zod 校验 → 失败 `INVALID_ARGUMENT`
  - `settings.load()` 为 null → `SETTINGS_NOT_CONFIGURED`（在任何写入/网络请求之前）
  - 调用 `runCreate` → 成功 `ok({ id })`
  - `CreateRunError` → 透传 `e.code`；其余 → `CREATE_RUN_FAILED`

### 1.3 更新 shared/ipc.ts

- [x] `CreateRunRequestSchema`（`systemPrompt: z.string()`、`userMessage: z.string().min(1)`）+ 类型
- [x] `CreateRunResultSchema`（`id: z.string().min(1)`）+ 类型
- [x] `WindowApi` 加 `createRun(request: CreateRunRequest): Promise<Envelope<CreateRunResult>>`

### 1.4 更新 preload

- [x] `apps/desktop/src/preload/index.ts` 暴露 `createRun: (request) => ipcRenderer.invoke(CHANNELS.createRun, request)`

## 阶段 2：UI 实现（renderer 进程）

### 2.1 创建 CreateRunDialog 组件

- [x] 新建 `apps/desktop/src/renderer/src/components/CreateRunDialog.tsx`（骨架照 `SettingsDialog`）
- [x] System Prompt 多行文本框（可空，空时给弱提示）
- [x] User Message 多行文本框（必填，空时禁用"创建"）
- [x] 取消 / 创建按钮；`创建中…` loading 态 + 防重复提交
- [x] 失败时对话框内显示错误（不关闭对话框）
- [x] Esc / 关闭按钮关闭（`onCancel` 阻止默认 + keydown 监听；创建中不响应）

### 2.2 集成到运行列表

- [x] `RunList.tsx` 标题区加"＋ 新建运行"按钮 + 本地 `useState` 控制开关
- [x] 创建成功后：关闭对话框 → `loadRuns()` → `selectRun(id)`

### 2.3 更新 store

- [x] `store.ts` 加 `createRun` action（含 `creatingRun` / `createRunError` / `createRunErrorCode` 状态）
- [x] 在 store 的 action 接口声明区补签名（另加 `resetCreateRun`）

## 阶段 3：测试

### 3.1 `apps/desktop/test/run-create.test.ts`（真实 runLoop + MockLlmClient + 临时 traces 目录）

- [x] 成功路径：文件名为 `${meta.id}.jsonl`、`status === "completed"`
- [x] meta 断言：`parent === null`、`fork === null`、`task === userMessage`、`config_hash === configHash(systemPrompt, [])`
- [x] 无 `source` 字段（与 SDK 直录同形）
- [x] 空 systemPrompt：允许，`config_hash === configHash("", [])`，且首条 system 消息内容为空串
- [x] LLM 失败：抛 `CreateRunError("CREATE_RUN_FAILED")`，文件仍归位、`status === "completed"` 且 `reason === "error"`（`status` 只表示"是否含终止事件"）
- [x] 两条路径均无残留 `tmp-create-*.tmp`

### 3.2 集成（A1 核心验收）

- [x] 新建 run 作为父本 → `runPromptFork` 成功，子 run `meta.parent` 指向它
- [x] 新建 run 作为父本 → `runModelAb` 两臂成功，各臂 `meta.parent` 指向它、`config_hash` 与父一致

## 阶段 4：文档与规范

- [x] delta 定稿：ADDED「桌面端提供原生 run 创建入口」+ MODIFIED 两条（「全程只读且只呈现原样数据」「分叉重跑是唯一的显式写路径」，均保留原 scenario 名）
- [x] `openspec validate add-native-run-creation --strict` 通过（**注意**：新 requirement 必须放 `## ADDED Requirements`；MODIFIED 是整体替换，旧 scenario 不写回会被拒）
- [x] README：快速开始补「什么都不写：在桌面应用里直接跑一个 run」+ 能力清单 + 路线图 A1 打勾 + 修正已过期的「代理 run 无 config_hash」限制条
- [ ] HANDOFF.md 状态更新（**待办**：收尾时随归档一起刷新）

## 阶段 5：验证

- [x] `pnpm check:ci`（build → typecheck → test → lint → spec）全绿
- [x] `openspec validate --all --strict` 12/12 通过
- [x] dev GUI 冒烟（**零成本分支**，`apps/desktop/scripts/create-run-cdp-smoke.cjs`）：入口按钮唯一、对话框打开、空 userMessage 禁用创建、填入后启用、`window.api.createRun` 两条非法请求均返回 `INVALID_ARGUMENT`、取消后对话框关闭、`traces/` 的 `.jsonl` 数量 38 → 38 不变
- [ ] **真实创建一次 run（点"创建"会发起真实计费调用）** —— 未做，留给 owner 手工验收；配置好运行参数后在 dev 或便携版点一次即可
- [x] 分次提交（中文 message），收尾告知待 push

## 依赖关系

```
1.1 → 1.2 → 1.3 → 1.4
              ↓
        2.1 → 2.2 → 2.3
              ↓
        3.1 / 3.2
              ↓
        4.x → 5.x
```

## 风险点

1. **临时文件改名**：`readRun` 对残缺文件会抛——必须保证不吞掉原错误（design.md §3）
2. **成败判据**：`runLoop` 不抛 LLM 失败，必须判 `outcome.event.event`，否则会把失败的 run 当成功返回
3. **空 systemPrompt 与 fork 门禁**：system 消息必须始终存在（内容可为空串），否则新建 run 无法作为 prompt fork 父本
4. **UI 重复提交**：创建中必须禁用按钮（一次 run 一次真实计费）

## 验收标准

- [x] 用户可在桌面端新建 run（填写 systemPrompt + userMessage）
- [x] 新 run 出现在列表中并被自动选中（编排层测试覆盖；真实点击待 owner 手工验收）
- [x] 新 run 可作为父本进行 prompt fork / 模型 A/B（trace-test 复用既有编排，未单独加用例）
- [x] 所有测试通过、lint 0 errors、spec 校验通过
- [x] 文档更新完成（HANDOFF 除外，见阶段 4）
