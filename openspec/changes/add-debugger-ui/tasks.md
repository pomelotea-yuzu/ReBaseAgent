## 1. trace-sdk：span 补时间区间

- [x] 1.1 在 `SpanCommon` 加可选 `timing: { started_at, ended_at }`（ISO 8601，嵌套对象保证成对）并导出类型，验证既有 52 个测试全绿（老文件无 timing 仍通过校验）
- [x] 1.2 `BaseTracer` 在 `startSpan` 记录起始时刻、`endSpan` 落盘时注入 `timing`，验证 JsonlTracer 产出的 span 行含成对 timing 且差值约等于实际耗时
- [x] 1.3 四份 fixtures（normal / tool-error / infinite-loop / branch）补齐 timing，验证 `readRun` 全部通过且先后关系正常
- [x] 1.4 新增测试：timing 成对性、缺失 timing 的老 span 读取不报错、耗时计算正确性，验证 trace-sdk 测试全绿（52 → 60）

## 2. apps/desktop 脚手架

- [x] 2.1 建 `apps/desktop`（electron-vite + React + Tailwind + zustand + tsconfig strict），依赖走 npmmirror，验证 `pnpm install --store-dir D:\ReBaseAgent\.pnpm-store` 成功（注：需 `--ignore-scripts` 绕过沙箱 wmic 拦截，再手动跑 electron install.js 补二进制）
- [ ] 2.2 配 Electron 主窗口（`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`）与空渲染入口，验证 `pnpm dev` 能起窗口（**被阻塞**：Electron 44.1.1 下 `require("electron")` 非确定性返回 npm 包的 exe 路径字符串而非 API，见 HANDOFF「阻塞问题」节；构建与类型检查已通过）
- [x] 2.3 根 `package.json` 的 dev/lint 脚本指向 desktop，`.gitignore` 加入 `.rebaseagent/`，验证 biome 检查通过

## 3. 数据目录与读取层（main 进程）

- [x] 3.1 实现 `resolveDataDir`（dev → 仓库内目录；portable.marker → `<exe 目录>/data`；否则提示选择并写入 exe 目录），验证三路径在单测中各自返回预期
- [x] 3.2 实现 `RunRepository.listRuns()`（扫描 `traces/*.jsonl` + `readRun`，单文件失败隔离为失败条目），验证混入损坏文件与高版本文件时其余行照常返回
- [x] 3.3 实现 `RunRepository.getRun(id)`（`meta.parent` 非空时走 `resolveBranch`），验证 branch fixture 返回父前缀 + 新增 span 的合并轨迹

## 4. IPC 契约与预加载

- [ ] 4.1 在 `src/shared/ipc.ts` 定义请求/响应 zod schema 与统一信封，验证 main 返回非法结构时校验失败
- [ ] 4.2 preload 用 `contextBridge` 暴露 `listRuns` / `getRun`，验证渲染层无 fs / ipcRenderer 直接访问能力
- [ ] 4.3 main 注册 `runs:list` / `runs:get` 处理器并包裹错误为信封，验证读取失败时返回 `{ ok: false }` 而非抛出

## 5. 派生层纯函数

- [x] 5.1 实现 `buildSpanTree`（按 parent 建树，孤儿 span 挂根并标注），验证 3 步 run 的树结构与文件顺序一致
- [x] 5.2 实现 `deriveRunSummary`（步数 / 工具数 / 出错数 / token 合计 / 耗时，缺失 timing 时耗时为 null），验证 token 合计等于各 llm.call usage 之和
- [x] 5.3 实现 `deriveStepStats`（step 子树聚合），验证单步 token 与耗时等于其子节点之和；以上三段单测全部通过（注：派生层放在 `src/shared/derive.ts` 供 main/renderer 双侧复用，design.md 已同步）

## 6. 界面三栏

- [ ] 6.1 zustand store（runs / failed / selectedRunId / selectedSpanId / expandedStepIds / loading / error）+ IPC 调用，验证选中与错误态流转正确
- [ ] 6.2 `RunList`：任务名、模型、创建时间、状态徽章（crashed 标注"运行中断"）、步数、工具数、错误数、token 合计、耗时，倒序；验证四份 fixtures 全部正确呈现
- [ ] 6.3 `SpanTree`：step 节点含 llm.call / tool.invoke 子节点、`error` 非空显著标注、可展开折叠与选中；验证 tool-error fixture 的出错节点被标注而 run 状态仍为已完成
- [ ] 6.4 `DetailPanel`：llm.call 展示完整 request.messages / tools / params 与 response（正文、思维链分区、tool_calls、usage、ttft_ms、耗时）；tool.invoke 展示 tool / args / result / error / dur_ms；长内容折叠可展开；验证 infinite-loop fixture 的思维链独立分区展示
- [ ] 6.5 分支标注：分叉点 span 与被编辑字段标注，并明示前缀来自父 run；验证 branch fixture 显示完整合并轨迹与提示文案

## 7. 端到端校验

- [ ] 7.1 `pnpm dev` 手工冒烟：四份 fixtures 逐一打开，逐条比对 specs/desktop-ui/spec.md 的 8 项 Requirement 全部场景通过
- [ ] 7.2 只读校验：浏览全程无任何文件写入，traces 目录下文件 mtime 与内容哈希不变
- [ ] 7.3 全仓测试与 lint 全绿（trace-sdk / agent-loop / desktop 派生层测试 + `biome check .`），并确认全程零真实 API 调用
