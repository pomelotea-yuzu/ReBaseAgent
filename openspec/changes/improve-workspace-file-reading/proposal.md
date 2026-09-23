# U2：文件阅读与状态恢复

## Why

U1 `refactor-run-workspace` 已完成但未归档，文件页已进入主工作区；内部仍固定文件目录与并排 diff，检查点和路径随组件卸载重置。用户需要在常见窗口宽度下读完整文件，并在文件、步骤和其他运行之间往返时继续阅读。

本 change 对应 [U 拆分计划](../../../docs/plans/2026-09-21-ui-change-split-plan.md) U2、[UI 方案 V0.2](../../../docs/plans/2026-09-19-ui-layout-discussion.md) §13 及文件部分的 §17/§18。[走查 R1/R7](../../../docs/reviews/2026-09-21-ui-usability-walkthrough.md) 是改造前的问题证据，不能作为 U2 验收结果：R1 曾测得 1210px 视口修改侧约 106px、1024px 约 5px；R7 复现文件页往返丢失第 1 轮和 a.txt。U1 已改善外层布局，U2 须在当前代码上重新测量文件正文。

源码依据（本轮未执行 GUI）：`WorkspaceFileView.tsx` 使用组件局部 selection/path/pane、挂载时选初始状态、`lg:w-72` 目录和固定并排 diff；`readSide` 将失败信封变为 null，初始侧非文本又可被呈现为不存在。U2 同时收口两侧状态与迟到响应，防止文件差异被错误解释。

## What Changes

- 依据文件内容容器实际宽度收起目录、切换列表/内容及 inline/并排 diff，提供可恢复的目录宽度和布局偏好，优先保证正文空间。
- 首次进入选择最近的自有完成步骤，无自有完成步骤时选择初始状态；明确检查点定位优先于会话记录，再优先于默认值。
- 将检查点、完整逻辑路径、列表/内容模式、搜索/筛选、布局偏好与阅读位置提升到按运行隔离的会话状态；每次返回重新读取并校验引用。
- 提供路径搜索、“全部 / 有变化”、无变化与空清单的独立提示，以及复制路径/原文、查找、换行、上一个/下一个差异和 diff 模式控件。
- 分别表达两侧加载、读取失败、不存在、零字节、二进制、缺失和损坏；只有符合比较条件的两侧进入 diff，不可用一侧不遮蔽另一侧的可读原文。
- 增加快速切换、重试、页签与跨运行恢复、窄窗口、200% 缩放、离线加载、重启读取和逐文件不变性验收。

## Capabilities

### New Capabilities

无新增 capability 目录。

### Modified Capabilities

- `desktop-ui`：修改“文件检查点和差异只读可查”，保留 C 的九个既有场景与行为，仅将窄窗口场景中过时的“提交和导航控件”改为“检查点与导航控件”；新增文件会话恢复、搜索筛选、容器布局、阅读工具和双侧加载一致性 requirements。

## Impact

主要修改 `apps/desktop/src/renderer/src/components/WorkspaceFileView.tsx`、`WorkspaceFilesPanel.tsx`、`lib/workspace-files.ts`、`lib/reading-state.ts`、`lib/reading-resolve.ts`、`store.ts` 和必要的工作区/步骤定位接线、样式；编辑器工具复用现有 `MonacoEditor.tsx` / `MonacoEditors.tsx` 的懒加载包装及 U1 已引入的 `lucide-react`。不新增依赖，不扩展 main/preload/shared IPC 或持久格式；测试与脚本覆盖当前 C 的读取契约。

硬依赖为 U1 的已实现工作区、会话阅读和离线 Monaco。当前主 spec 尚未合入 U1；本 change 仅修改主 spec 已有的 C requirement 并新增文件专属 requirements，不复制 U1 的未归档 delta。U1 中“文件仅恢复页签”的文字描述 U1 交付边界，文件内部恢复由 U2 扩展。后续按 U1 → U2 顺序归档并核对合并结果；本次不归档任何 change。

## Non-goals

- 不实现文件编辑、回写、应用补丁、导出、跨运行文件 diff、祖先步骤选择、附件修复或从源目录补历史。
- 不重建文件 IPC/清单/哈希派生，不新增持久内容缓存，不承诺 renderer 重载或应用重启后的阅读偏好恢复。
- 不实现 U3 草稿、U4 操作登记、U5 执行闭环、U6 缺父链详情降级或 U7 对比工作区。普通运行仍按已有能力显示页签，不生成文件历史。
- 不改变创建、重跑、授权、模型实验门禁或执行保真度；不打包、发布、提交或替用户归档 U1。

## 保真度边界

文件阅读只消费本运行初始与自有完成步骤的合法清单及其引用附件，零模型/工具调用、零 trace/blob 写入。普通 replay 仍遵守 world-free 边界，pure 工具按原契约复现、外部状态及副作用仍为 best-effort；隔离重跑仅操作既有授权下的分支副本。修改 tool_result 不等于修改文件，文件 diff 不等于测试通过，也不表示外部状态被撤销。

当前仅编写 change；U2 实现与桌面验收均未开始，文档校验通过不表示功能交付。
