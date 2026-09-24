# 审阅：add-sandboxed-rerun-desktop 文档拆分

日期：2026-09-16。范围：B 的 proposal/design/tasks/desktop-ui delta，以及 A/B/C 的依赖边界。此为针对当前仓库的文档与源码对照审阅，不是实现验收；A 尚未归档，B 全部任务未完成。

## Findings

本轮未发现阻止文档拆分的遗留问题。原计划中 IPC 校验留 A、文件视图成为 B 隐含验收前提、列表基准归属不明的问题已落实：IPC 归 B 1.1，B 场景只要求轨迹及来源，真实扫描归 B 3.4。B 依赖 A 归档，C 依赖 B 归档。

## 源码依据

| 当前源码 | 核对结果与设计落点 |
|---|---|
| [ipc.ts](D:/ReBaseAgent/apps/desktop/src/shared/ipc.ts:18) | RunRecordSchema 直接组合 meta/spans；原始版本守卫接入是 B 待办，不能因 schema import 已存在就视为完成 |
| [ipc.ts](D:/ReBaseAgent/apps/desktop/src/shared/ipc.ts:87) | ChainHop/RunDetail 包含祖先 meta 与 fork，需要连同详情做版本检查和合法元数据往返 |
| [run-repository.ts](D:/ReBaseAgent/apps/desktop/src/main/run-repository.ts:17) | listRuns 逐文件完整 readRun 后 deriveRunSummary，真实扫描成本必须在桌面测，A reader 结果不能代替 |
| [run-create.ts](D:/ReBaseAgent/apps/desktop/src/main/run-create.ts:65) | 当前创建 tools 为空，临时 trace 最后按 meta.id 归位，B 的纯对话/失败回归有真实基线 |
| [fork-runner.ts](D:/ReBaseAgent/apps/desktop/src/main/fork-runner.ts:278) | 普通 handler 真实读写 cwd；B 必须将隔离请求交给 A API，不复用普通 handler |
| [run-loop.ts](D:/ReBaseAgent/packages/agent-loop/src/run-loop.ts:100) | 每 run 从本地 iteration 开始，确认必须带所属 run 和 step，不沿父链累加 |

## 文档验证

- B 有 14 项任务、25 个场景，任务预算 14.25h，每项不超过 2h，全部场景有本段任务引用。
- 三个 MODIFIED requirement 保留主 spec 的全部既有场景；文件选择器、文件差异显示已迁 C。
- 每次桌面授权、直接 IPC 绕过、v1 原始禁字段、v2 往返及真实列表扫描均有明确场景。
- 三份 change 的全量 OpenSpec strict 通过，合计 14/14。

## 待实现证据

A 归档后需重新核对实际包导出，再执行 B 的 IPC/门禁测试、真实列表基准、受控模型 CDP、截图和全仓构建。当前没有这些执行证据，不将历史 615 个测试或本次规范校验作为 B 实现通过。
