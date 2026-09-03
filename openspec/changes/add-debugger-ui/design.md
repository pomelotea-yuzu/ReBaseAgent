# Design: add-debugger-ui

## Context

trace-sdk（Spec #1）定义了 JSONL trace 格式与读写 API，agent-loop（Spec #2）能产出标准 trace，但两者都跑在命令行里——没有任何界面能看见一次运行。本变更新增 `apps/desktop`，把已有的读取能力（`readRun` / `resolveBranch`）接到桌面上。动机见 proposal.md，行为要求见 specs/desktop-ui/spec.md 与 specs/trace-format/spec.md（delta）。

约束（来自 openspec/config.yaml，不再重述）：JSONL 是唯一事实源、数据只存数据目录、渲染层为 React + Tailwind + zustand、可视化用 ECharts + Monaco 但本次后置、UI 侧唯一碰 Electron 的包是 `apps/desktop`。

## Goals / Non-Goals

**Goals:**

- 一次 `pnpm dev` 就能看到 4 份 fixtures 的完整轨迹，零 API 消耗
- 派生逻辑（树构建、统计聚合）为纯函数、零 Electron 依赖、vitest 可测
- 进程边界干净：渲染层零文件权限，跨进程数据经 zod 校验
- 时间维度可查：span 记录起止时刻，回答"哪一步慢"

**Non-Goals:**

- 不做编辑 / 重跑 / fork 创建（Spec #4）
- 不做预算地图与 Monaco（本次只预留挂载位，不写死结构）
- 不做索引持久化、不做打包、不做 e2e（见 proposal 的 Non-goals）

## Decisions

### D1：electron-vite 三段结构，渲染层零 Node 权限

`apps/desktop/src/{main,preload,renderer}`：

- `main`：唯一持有 `fs` 与 `app` 的一侧，负责数据目录解析、目录扫描、`readRun`、`resolveBranch`
- `preload`：`contextBridge.exposeInMainWorld('api', ...)` 暴露有限方法；`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- `renderer`：React + Tailwind + zustand，只依赖 `@rebaseagent/trace-sdk` 的类型与纯函数

**产物格式（实施期修订）**：main 与 preload 都强制输出 CJS（`.cjs`，electron-vite 的 `output.format: "cjs"`）。原因有二：Electron 的 sandbox 不支持 ESM preload（package.json 为 `type: module` 时默认输出 `.mjs` 会加载失败）；ESM main 的 `import { app } from "electron"` 具名导入在本环境被解析到 npm 包（见 HANDOFF「阻塞问题」），CJS 输出同时规避两者，`__dirname` 也可直接使用。`package.json` 的 `main` 字段指向 `./dist/main/index.cjs`。

备选：关闭 sandbox 让渲染层直接读文件（省掉 IPC 样板）→ 渲染层一旦加载第三方内容即获得全盘读写能力。这是本地优先工具的核心信任边界，弃。

### D2：数据目录解析只有三条路径

`resolveDataDir(app.isPackaged, exeDir)`：

1. 开发模式 → 仓库根 `.rebaseagent/`（进 .gitignore）
2. 打包 + exe 旁存在 `portable.marker` → `<exe 目录>/data`
3. 打包 + 无 marker → 弹出一次性目录选择对话框，结果写入 `<exe 目录>/data-dir.json`；该位置不可写则报错并引导放置 `portable.marker`

trace 目录恒为 `<数据目录>/traces/`，启动时确保其存在。全程不写 AppData、用户主目录或注册表。

备选：把数据目录选择存进 `app.getPath('userData')` → 指针本身落在 AppData，与便携不变量冲突，弃（代价：程序安装到 Program Files 这类不可写目录的场景本次不支持，见风险）。

### D3：main 侧 RunRepository 隔离单文件失败

- `listRuns()`：`readdir(traces/*.jsonl)` → 逐文件 `readRun`；成功产出摘要，失败捕获为 `{ file, error: 错误文本 }` 条目。**任一文件损坏不影响其余文件**
- `getRun(id)`：`readRun`；若 `meta.parent` 非空则 `resolveBranch(id, loader)`（loader 按 id 读同目录文件），返回 `{ meta, spans, events, status, chain }`

备选：SQLite 维护索引 → 索引是可弃派生数据，当前规模（数十 run、单 run 数百行）目录扫描足够，引入即增加重建与一致性负担，弃。

### D4：IPC 走统一信封 + 共享 zod schema

`apps/desktop/src/shared/ipc.ts` 定义请求/响应 schema，main 与 preload 共用：

```ts
type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
```

通道只有两个：`runs:list`、`runs:get`。RunRecord 内无 Date/Map/函数，结构化克隆安全。

备选：直接 `invoke` 裸数据不校验 → 跨进程边界不可信，且错误形态不统一，弃。

### D5：派生层是纯函数（可单测，零 Electron）

置于 **`src/shared/derive.ts`**（实施期从"renderer 的 lib/"上移到 shared：main 的列表摘要与 renderer 的树/详情都要用，且零 Electron、零 Node 依赖，vitest 直测），全部输入 spans → 输出派生结构：

- `buildSpanTree(spans)`：按 `parent` 建树，根为 `parent === null`；父 id 不存在的孤儿 span 挂载到根并标注（防御手工编辑的文件）
- `deriveRunSummary(record)`：步数 = `agent.step` 计数；工具调用数 / 出错数 = `tool.invoke` 计数与 `error` 非空计数；token 合计 = 各 `llm.call.usage` 求和；总耗时 = 有 `timing` 时取 `min(started_at) → max(ended_at)`，否则 `null`
- `deriveStepStats(node)`：单个 step 子树内的 token 与耗时聚合

备选：读取时算好缓存进 store → 与"计数从数据派生、禁止自增累积"不变量冲突，且编辑场景（Spec #4）下缓存必失效，弃。

### D6：zustand 单 store，选择器内现算

store 只存**选择状态与原始数据**：`{ runs, failed, selectedRunId, selectedSpanId, expandedStepIds, loading, error }`；聚合数字在组件用 `useMemo` 调 D5 的纯函数现算，不进 store、不做持久化。

### D7：span 时间区间用可选嵌套对象，ISO 8601

schema 在 `SpanCommon` 加：

```ts
timing: z.object({ started_at: z.string(), ended_at: z.string() }).optional()
```

- **嵌套对象而非两个平铺可选字段**：成对性天然成立，无需 refine，读取侧也不会出现"有起点没终点"
- **ISO 8601 而非 epoch 毫秒**：与 `run.meta.created_at` 风格一致，且 JSONL 是给人看的（直接打开文件排查是高频动作）；耗时用 `Date.parse` 相减，毫秒精度足够
- **记录点**：`BaseTracer` 在 `startSpan` 时把 `startedAt` 存入活跃 span 表，`endSpan` 落盘该行时注入 `timing`（模板方法的既有钩子，JsonlTracer / NullTracer 自动获得）
- **与 `dur_ms` 的关系**：`tool.invoke.dur_ms` 保持为"工具执行耗时"的权威值（既有契约不动）；`timing` 提供跨 span 的统一时间坐标，供时间轴与 step 聚合使用
- **向后兼容**：字段可选，老文件照常通过校验；旧读取器 strip 未知字段；`format_version` 仍为 1

备选：把时间戳写进 `run.event` 或只给 `agent.step` 加 → 无法定位"是 LLM 慢还是工具慢"，弃。另备选：升 `format_version` 到 2 → 无必要，可选字段非破坏性变更，弃。

fixtures 四份文件补 `timing`，保持原有先后关系正常（不改任何其他字段），使耗时展示在开发数据上可见。

### D8：三栏布局，为后置功能留插槽不写死

`RunList | SpanTree | DetailPanel` 三栏 flex。DetailPanel 内以容器 + 插槽注释预留预算地图（ECharts）与消息编辑器（Monaco）的挂载位——本次渲染为空，但不把面板结构写死成"只有这两块"。列表与详情的选中联动只经 store 的 `selectedRunId` / `selectedSpanId`。

配色：中性灰底 + 语义色（错误红、`llm.call` 蓝紫、`tool.invoke` 青）；不引入主题系统。

## Risks / Trade-offs

- [打包到 Program Files 等不可写目录时无法落数据目录] → MVP 只发 portable 版（exe 旁 `portable.marker`）；NSIS 安装场景随打包 spec 一并解决，本次在风险中明示
- [`readRun` 为同步 IO] → 在 main 进程执行，不阻塞渲染；单文件数百行无感。若后续出现超大 run，改为分批读取 + 进度事件
- [老文件与手工 fixtures 缺 `timing`] → 耗时显示"—"，不臆造；fixtures 已补齐，真实数据自 agent-loop 产出即带
- [超长 messages 渲染卡顿] → 默认折叠；当前规模无碍，真出现再上虚拟滚动
- [Electron 依赖体积大、下载慢] → 安装走 npmmirror 镜像；本变更不引入技术栈外新依赖
- [孤儿 span（父 id 不存在）] → 挂到根并标注，不静默丢弃——手工编辑的 trace 文件是合法输入

## Migration Plan

1. 改 `packages/trace-sdk`：schema 加可选 `timing`、BaseTracer 记录、4 份 fixtures 补齐，跑既有 52 个测试确认全绿
2. 新建 `apps/desktop`：脚手架 → 数据目录 → IPC → 派生纯函数（含单测）→ 三栏 UI
3. 开发模式指向仓库内数据目录，加载 fixtures 手工冒烟
4. 归档时同步主 spec：`openspec/specs/desktop-ui/spec.md` 新建、`openspec/specs/trace-format/spec.md` 合入 delta

回滚：删除 `apps/desktop` 即可；`timing` 为可选字段，trace-sdk 侧回滚无需数据迁移。

## Open Questions

（无）
