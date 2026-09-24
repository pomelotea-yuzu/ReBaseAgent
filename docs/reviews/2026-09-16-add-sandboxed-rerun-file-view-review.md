# 审阅：add-sandboxed-rerun-file-view 文档拆分

日期：2026-09-16。范围：C 的 proposal/design/tasks/desktop-ui delta，以及从原 change 迁入的文件显示义务。此为当前仓库的文档与源码对照审阅，不是实现验收；C 依赖 A、B 已归档，全部任务待实施。

## Findings

本轮未发现阻止文档拆分的遗留问题。文件选择器轮号、二进制/缺失/损坏显示、失败运行快照、重启/迁移和只读浏览已集中到 C 的新增 requirement。C 不整体替换 B 的已有 requirement，不重新定义 trace 契约。

源码核对发现现有视图使用 Monaco Editor，不能称文件 DiffEditor 已实现；proposal/design/tasks 已改为复用现有 Monaco 离线装配并新增懒加载 DiffEditor。只读 IPC 还明确拒绝可穿越 tracesDir 的非法 runId，避免把“经仓库定位”误认为自动获得路径约束。

## 源码依据

| 当前源码 | 核对结果与设计落点 |
|---|---|
| [run-repository.ts](D:/ReBaseAgent/apps/desktop/src/main/run-repository.ts:42) | leafSpanIds 来自原始自有 spans，可用于区分合并轨迹中的祖先；C 仍要验证自有完成 step |
| [run-repository.ts](D:/ReBaseAgent/apps/desktop/src/main/run-repository.ts:118) | loadRunRecord 按 id 拼接文件路径；新增 C 通道必须先约束 runId，不能直接信任 renderer 字符串 |
| [ipc.ts](D:/ReBaseAgent/apps/desktop/src/shared/ipc.ts:93) | RunDetail 有 meta/spans/chain/leafSpanIds，C 依赖 B 的 v2 校验后消费 |
| [DetailPanel.tsx](D:/ReBaseAgent/apps/desktop/src/renderer/src/components/DetailPanel.tsx:1) | 已使用 @monaco-editor/react 的 Editor；C 增加文件 diff，不需要引入另一个编辑器依赖 |
| [monaco-bootstrap.ts](D:/ReBaseAgent/apps/desktop/src/renderer/src/monaco-bootstrap.ts:9) | 已有离线 worker 装配可复用，新增 DiffEditor 仍须验证构建和实际渲染 |
| [run-loop.ts](D:/ReBaseAgent/packages/agent-loop/src/run-loop.ts:114) | step.n 是该 run 本地 iteration，文件选择器保留 ownerRunId/stepSpanId/localIteration |

## 文档验证

- C 有 9 项任务、9 个场景，预算 9.75h，每项不超过 2h，全部场景都有本段任务引用。
- 只新增“文件检查点和差异只读可查”，未重复 MODIFIED B 的三条 requirement。
- inspect/readFile 的输入、只读语义、清单/步骤所有权、非法 runId/物理路径拒绝及结果状态已写入 spec。
- 原跨段显示义务保留，三份 change 的全量 OpenSpec strict 通过，合计 14/14。

## 待实现证据

A/B 归档后重新核对包接口和 IPC，再完成文件 CDP、重启/整体迁移、失败运行、越权输入、窗口截图和真实哈希不变性验证。当前未运行上述验收或全仓代码测试；文档状态不能替代功能证据。
