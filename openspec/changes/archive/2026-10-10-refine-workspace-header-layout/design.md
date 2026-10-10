# 设计：收紧编辑与差异工作区页头布局

## 现状与约束

现有 `WorkspaceHeading` 之前没有统一承载两侧信息的结构；不同工作区分别渲染标题、状态、说明和操作，导致页头高度随文案叠加。`DraftCompareGrid` 的原值和草稿编辑器又可能在条件渲染下复用同一个 React 子节点。

## 方案

新增共享页头组件，使用 CSS grid 明确两列两行：对象与操作位于第一行，必要摘要与详情入口位于第二行，详情正文跨两列并受控隐藏。容器宽度不足时通过 container query 改为单列，保持操作和正文可达。页签栏提供 actions 槽，让模型实验、目录、专注和显示操作就近出现。

编辑工作区关闭重复页头说明，只在来源/详情区域保留完整信息。工具调用保留工具、span、耗时和草稿状态，参数与原始结果进入详情。文件和输出 diff 将左右短 ID、完整 ID 复制入口、只读摘要和详细来源放入紧凑页头。

`DraftCompareGrid` 为 original、draft 和 resize handle 使用稳定 key；标签行设定一致的最小高度。这样原值折叠不会让 React 把原值 Monaco 实例复用于草稿实例，草稿文本和 revision 继续由既有 store 持有。

## 兼容性

不新增状态持久化或执行通道。详情展开是局部 UI state；草稿、目标、修订、view state、确认和代理门禁仍使用既有机制。辅助工作区保留原布局，仅编辑和差异工作区使用紧凑页头。

## 验证

- 桌面端全量测试：198 个文件、3088 个测试通过。
- desktop typecheck、Biome、构建和 `git diff --check` 通过。
- Electron/CDP 真实窗口验证 1210×713、800×713、640×713；真实输入、说明展开、原值折叠/恢复、录制往返保留草稿与 revision，7 项键盘/交互检查通过。
- 几何和截图证据见 `docs/reviews/2026-10-10-workspace-header-layout.md` 与 `output/ui-header-review/`。
