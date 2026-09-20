依赖 A 已归档。预算 14.25h，全部待实现；每项括号列原任务来源。不得因 A helper 已实现而提前勾选 IPC 接入。本段独立验收不依赖 C 文件页；所有验证场景来自本段 desktop-ui delta。

## 1. 桌面边界与 IPC

- [x] 1.1 接入 RunRecord/RunDetail 和祖先元数据的原始版本守卫、合法 v2 快照往返；使用 A 导出的纯 helper（0.5h，原 1.3-B）。验证：`详情 IPC 快照往返`、`详情 IPC 拒绝 v1 隔离字段`，包含 null/false/空对象/自有 undefined 与不相关扩展。证据：`apps/desktop/src/shared/detail-version-guard.ts`（renderer store 在 `RunDetailSchema.safeParse` 前调用；trace-sdk `./schema` 纯子路径再导出 `findVersionFieldViolation`，与主出口同一实现的同一性断言在测试内）；`apps/desktop/test/detail-version-guard.test.ts`（23 条：拒绝/不误伤/真实 v2 根与分支往返/空清单/缺附件/守卫有牙）+ `store.test.ts` 接线用例（禁用守卫即红，已做变异验证）。
- [x] 1.2 核对 main 的普通 result、prompt fork、A/B 路由均经过 A 门禁，直接 IPC 漏隔离模式也拒绝（0.5h，原 4.5-B）。验证：`非法请求被拒绝`、`隔离父本的其他真执行入口`；含 dry-run、allowSideEffects。证据：`apps/desktop/test/isolated-parent-rejection.test.ts`（5 条，真跑 `createIsolatedRun` 造隔离父本：runFork / runPromptFork 拒绝且零落盘零调用；runModelAb dry-run 与 confirmCost+allowSideEffects 两种形态均 `PARENT_NOT_FORKABLE`）。
- [x] 1.3 增加原生目录选择、15 分钟 sourceToken 会话绑定及提交消费，注入便携 dataDir，执行前重新校验（1.5h，原 5.1）。验证：`浏览过程无写入`、`非法请求被拒绝`；取消零写入，无效/过期 token 不执行。证据：`main/source-token.ts`（15 分钟 TTL + 一次性消费 + 取消不签发，单测 4 条）；`main/ipc.ts` 的 `workspaces:chooseSource`（`pickDirectory === null` 即取消路径，零写入；dialog 交互归 3.2 CDP）；token 消费在 runs:create handler，invalid/expired 分别报 `INVALID_SOURCE_TOKEN`；dataDir 已入 `IpcDeps`（index.ts 按便携策略传入）。
- [x] 1.4 扩展 create/fork 请求 schema、通道分流、preload/store 和错误信封，失败封存 run 归位并刷新列表（2h，原 5.2）。验证：`非法请求被拒绝`、`空 fork 被拒绝`、`settings 未配置时拒绝`、`执行失败不产生半成品`。证据：`shared/ipc.ts` 的 `IsolatedWorkspaceSelectionSchema` / `IsolatedExecutionModeSchema`（literal(true) 授权 + strict 拒绝配额覆盖/handler 注入，单测 2 条）；runs:create → `runCreateIsolated`（createIsolatedRun，errored 照常归位 + CREATE_RUN_FAILED 同语义）、runs:fork 带 execution → `runForkIsolated`（replayIsolatedRun），不带 execution 落普通路径被 A 门禁拒（1.2 已钉）；新测试 `isolated-desktop-flows.test.ts` 17 条。
- [x] 1.5 派生执行能力与续跑来源，保留 ownerRunId/stepSpanId/localIteration；复用 A 的只读预检获取附件不可用原因，不依赖 C 通道（0.75h，原 5.4-B）。验证：`历史运行和缺附件降级`、`多工具轮次确认`、`二次分叉轮号不沿链累加`。证据：`workspaces:forkCapability`（只读；A `preflightIsolatedReplay` 的 IPC 裁剪面——快照完整清单不跨进程，只带定位三元组/规模/指纹）→ `runForkCapability`；测试覆盖多工具轮次（localIteration=1）、根 A 3 轮→B 第 1 轮（localIteration=1 且起点清单 3 文件≠A 最终 4 文件）、历史 v1 run 与缺附件（attachment_missing）均 FORK_CAPABILITY_UNAVAILABLE、预检前后 dataDir 全树指纹逐字节一致（只读判据）。

## 2. 创建与分叉交互

- [ ] 2.1 接 CreateRunDialog 模式、目录、副本授权及提交状态，每次新操作重新确认授权（2h，原 6.1）。验证：`直接创建隔离文件父本`、`新建 run 成功`、`userMessage 为空时禁用提交`、`空 systemPrompt 允许`、`每次桌面操作独立确认写入`；默认纯对话仍为空工具表。
- [ ] 2.2 接隔离 result 确认、prompt/A-B 禁用原因、重复提交保护，显示父 run、本地轮号、step 和真实调用/副本授权（1.5h，原 6.2）。验证：`编辑 tool_result 并重跑`、`多工具轮次确认`、`二次分叉轮号不沿链累加`、`隔离父本的其他真执行入口`；不要求文件选择器。

## 3. 回归、冒烟与性能

- [ ] 3.1 回归桌面纯对话及后续操作（0.5h，原 7.3-B）。验证：`新建 run 作为父本进行 prompt fork`、`新建 run 作为父本进行模型 A/B`、`新建 run 作为父本进行 trace-test`、`超长消息`。
- [ ] 3.2 受控模型服务 CDP 跑通目录选择→父运行→改 result→隔离分叉→重启查看轨迹/来源，按 fixture 哈希核对真实文件不变（1.5h，原 7.4-B，承接原 7.1 桌面断言）。验证：`直接创建隔离文件父本`、`浏览过程无写入`、`分叉不触碰既有文件`、`新建运行不触碰既有文件`、`详情 IPC 快照往返`；文件 diff 冒烟迁 C。
- [ ] 3.3 Windows 代表性桌面和窄窗口截图核对长源路径、确认区、授权及提交状态（0.25h，原 7.5-B）。验证：`创建与确认在窄窗口可操作`。
- [ ] 3.4 复用 A 的 1/10/50 run、短/长 ASCII/中文路径和 v1 fixture，调用真实 RunRepository/listRuns 测完整扫描、汇总一致性、首次进程/重复耗时及峰值内存（1h，原 7.7-B）。验证：`真实列表扫描完整且只读`、`浏览过程无写入`；记录环境/字节量，不读 blob/写缓存、不省略校验，不能把 A reader 基准当桌面结论。

## 4. 文档与验收

- [ ] 4.1 先包 build，再执行 pnpm check:ci、OpenSpec 全量 strict 与 pnpm --filter @rebaseagent/desktop build，记录通过/失败摘要（1h，原 7.6-B）。验证：本段场景测试全过，尤其 `详情 IPC 拒绝 v1 隔离字段`、`隔离父本的其他真执行入口`；文档校验不是运行验收。
- [ ] 4.2 更新桌面创建/授权、源文件采集与模型请求边界说明，说明文件视图由 C 交付（0.25h，原 8.1-B）。验证：与 `直接创建隔离文件父本`、`每次桌面操作独立确认写入` 一致。
- [ ] 4.3 汇总本段 scenario→测试/fixture/截图索引，保留三个 MODIFIED requirement 的全部既有场景，核对迁 C 的显示义务（1h，原 8.2-B，新增独立收口）。验证：本段全部场景有证据；未做项不勾选，不自动提交、归档或发版。
