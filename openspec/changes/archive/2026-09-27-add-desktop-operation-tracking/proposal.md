# U4：主进程操作登记与核对

## Why

U1/U2/U3 已归档。U3 保留了草稿并将提交绑定到修订，但当前执行仍依赖 renderer 的长 IPC 返回和局部 busy 状态：main 没有统一执行槽、幂等身份或状态查询，通信中断后无法可靠确认是否执行，也无法防止重复请求消耗授权或再次调用模型。settings 保存/清除只在 UI 侧限制，直接 IPC 可以绕过。

本 change 对应 [U 拆分计划](../../../docs/engineering/plans/2026-09-21-ui-change-split-plan.md) U4、[UI 方案 V0.2](../../../docs/engineering/plans/2026-09-19-ui-layout-discussion.md) §12.3，以及 R3/R4/R5 的操作契约基础。已核对当前源码：`CreateRunError` 不含结构化 ID；`runModelAb` 的 `ids` 仅保留成功臂；`ProxyManager.lastWrittenRunId` 由主动重发和被动录制共用。以上不能作为可信关联的基础，须随操作登记一起修正。本轮仅编写 change，未重新执行 GUI 走查。

## What Changes

- main 每次启动生成 epoch，持有会话内操作登记和一个主动执行槽。普通/隔离创建、普通/隔离 result fork、prompt fork、代理 messages 重发、A/B 真实执行全部接入；A/B 整批占一个槽。
- 执行请求携带 epoch/operationId。相同 ID 和相同规范化请求仅关联原操作；异参拒绝。去重先于 sourceToken 消费、授权使用、目录导入、文件写入和模型/工具调用。
- 增加 `operations:status` 握手/快照和 `operations:reconcile` 原子核对。未接受的 ID 在 reconcile 时登记为不可再执行的 `notAccepted`，拒绝迟到请求；已接受操作保留 `running/settled` 及可信 runIds、请求结局和脱敏诊断直到 main 结束。
- 执行及收尾完成后才释放该操作的槽，列表/详情读取失败不阻止释放；配置保存/清除由 main 同步校验。代理配置启停也纳入互斥，避免重发途中替换处理器；被动录制本身不占主动执行槽。
- 以受控生命周期回调和结构化错误关联 ID：保留创建失败记录、各分叉已创建记录和 A/B 各臂身份；代理按本次重发上下文关联，消除全局最后 ID 的竞争。
- shared/preload/store 及全部现有入口同步迁移。renderer 启动/重载先握手，提供最小操作状态、核对和真实 ID 读取入口；通信未知保持执行/配置锁，不自动重发。U3 提交修订关联继续生效，任何结局均不自动清草稿。
- 将 main 活跃操作合入 U3 的一次退出确认，退出协商期间阻止新主动执行，避免 clean 判定后才接受任务。

## Capabilities

### New Capabilities

无新增 capability 目录。

### Modified Capabilities

- `desktop-ui`：新增主动操作身份、执行槽、原子核对、可信结果关联与最小 renderer 接线；完整修改 IPC 校验、运行配置、提交草稿和常规退出 requirements，保留既有场景。
- `replay`：普通 result、隔离创建/续跑编排增加可选的可信运行身份回调，保留失败后的已知身份及原执行/文件语义。
- `prompt-replay`：prompt/model_params 单次编排增加同类可选身份回调，不改变从头执行和父链门禁。
- `model-experiments`：批次编排提供 experimentId/arm index/runId 关联，含失败臂；dry-run 不产生运行身份。

## Impact

main 新增操作登记模块，接入 `index.ts`、`ipc.ts`、`run-create.ts`、`fork-runner.ts`、`proxy-manager.ts`、`proxy-recorder.ts` 及 U3 关闭协商。shared/preload 定义受限 schema；renderer 的 store、API 适配、提交关联和现有创建/详情/设置入口消费 main 状态。复用 zod、zustand、Node crypto 和既有 UI 控件，不增加依赖。

包层最小扩展为 `replayRun`、`promptReplayRun`、`createIsolatedRun`、`replayIsolatedRun` 的可选 `onRunIdentified`，以及 `modelReplayRunMany` 的可选 `onArmRunIdentified`；通过现有 tracer `run.meta` 事件获取已实际写出的身份。`CreateRunError` 增加可选 runId；桌面 A/B 保留原成功 `ids` 的含义，另传完整臂关联。代理复用已有 `ProxyForkMeta` 和 recorder 回调，无需修改 llm-proxy 公共接口。具体产出点、失败语义及兼容性见 design。

以 U3 归档后的主 spec（desktop-ui 47 requirements / 200 scenarios）起草。trace-format、workspace-isolation、agent-loop 和 llm-proxy 不增加格式或执行能力要求；不将 epoch/operationId 写入 JSONL，不增加持久事实源。

## Non-goals

- 不实现 U5 的创建工作区、完整跨页通知/导航策略、终止事件核实和按修订自动清草稿；不把 settled 或 IPC ok 称为运行成功/测试通过。
- 不实现真正取消、实时步骤事件、执行队列、多主动操作并发或跨 main 重启任务恢复。
- 不持久化操作登记、请求正文或凭据；不扩大 U3 草稿的 renderer 会话恢复保证。
- 不实现 U6 缺父链读取、U7 双运行比较或 U8 录制/实验工作区，不重做页面布局。
- 不增加隔离 prompt/A-B、工具权限、源目录写入、失败自动重发、发布、打包或归档。

## 保真度边界

status、reconcile 和结果读取不调用模型/工具，不写 trace/blob/source；reconcile 只修改 main 内存封禁记录。主动执行仍通过既有预检：普通 replay 的 pure 工具按原契约，外部状态及副作用为 best-effort；隔离创建/续跑仅在显式授权的副本文件世界执行，前缀零调用、轮末边界不变。幂等保证仅限本 main epoch 内同 operationId 的执行，不保证 provider、进程重启或外部副作用的全局 exactly-once。退出不代表上游取消或费用撤销。

当前只完成设计文档，所有实施与验收任务待办；文档校验不作为功能通过证据。
