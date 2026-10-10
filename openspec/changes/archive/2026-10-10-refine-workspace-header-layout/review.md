# 评审：收紧编辑与差异工作区页头布局

2026-10-10 审阅，评审对象为当前工作树（基于 main `1965391`）的全部改动与本 change 制品。方法：通读 proposal / design / tasks / delta / evidence-index 与 `docs/reviews/2026-10-10-workspace-header-layout.md`，逐文件核对 17 个改动文件，复跑 `pnpm check:spec`（14/14 通过，与 design 声明一致）。桌面全量测试与 `pnpm check:ci` 未由评审方复跑，采信作者日志并结合缺口登记。

## 总体结论

**方向正确，核心缺陷修复可信，无执行语义变化；建议归档前处理 2 个 P2，其余记 P3。** 页头信息分层与正文高度收益有实测支撑（messages 编辑器上沿 192→165px、文件 diff 正文 391.53px 约 55% 视口），`DraftCompareGrid` 的 React key 修复根因分析与实机复现吻合，测试改动均为断言加强而非放松。change 自身的 tasks 8/9 未勾、`check:ci` 未跑，作者已如实标注，不构成冒充。

## 正确性核对（通过项）

- **草稿覆盖修复**（[DraftCompareGrid.tsx](file:///D:/ReBaseAgent/apps/desktop/src/renderer/src/components/DraftCompareGrid.tsx#L120-L209)）：收起原值时渲染 children 从 `[original, resizer, draft]` 变为 `[draft]`，无 key 的位置匹配会把原值宿主复用为草稿宿主，与实机复现（修订 5→6、文本回退基线）一致。`key="original"` / `key="draft"` / `key="original-resizer"` 后草稿实例在折叠中保留、原值按需重挂，三条渲染路径的 key 集合一致，并排↔上下切换不错配。修复方式最小且对症。
- **执行边界不变**：全 diff 无新增 IPC 写通道、无模型调用、无写入入口；确认块仍是同一 [ConfirmationBlock.tsx](file:///D:/ReBaseAgent/apps/desktop/src/renderer/src/components/ConfirmationBlock.tsx) 且 `data-confirm-summary`、资格原因、blocked 提示均保留；diff 全程只读。
- **顺带修复**：[MessagesForkEditor.tsx](file:///D:/ReBaseAgent/apps/desktop/src/renderer/src/components/MessagesForkEditor.tsx#L441-L460) 常开形态不再渲染无文字却可收起编辑器的「取消」按钮——原实现是 `{alwaysOpen ? null : "取消"}` 留下的空按钮隐患。
- **测试改动可信**：`compare-workspace-view.test.tsx` 新增完整 ID 的 `title`/`aria-label` 断言（加强）；`prompt-messages-editor-draft.test.ts` 由字符串包含改为结构正则（更强）；`aux-workspace-entries.test.tsx` 同步接线签名。没有为过测而放松断言。
- **焦点回收**：复制菜单动作后关闭并把焦点还给 `summary`（[WorkspaceFileView.tsx](file:///D:/ReBaseAgent/apps/desktop/src/renderer/src/components/WorkspaceFileView.tsx#L1346-L1350)），方向正确（键盘路径本身待 tasks 8 补验）。

## 发现

### P2-1 新增两处原生 `<details>/<summary>` 绕过 Disclosure 统一语义，命中区不足 28px

主 spec「工作区折叠控制一致且可发现」（desktop-ui spec L2261）要求说明类折叠控制「提供至少 28 CSS px 高命中区和可见焦点」，且此前 UI 密度 change 已把折叠语义收敛到 [Disclosure.tsx](file:///D:/ReBaseAgent/apps/desktop/src/renderer/src/components/Disclosure.tsx)（min-h-[28px]、可辨文字/方向、显式 `aria-expanded`）。本 change 新增两处绕过：

1. [RunActionsBar.tsx](file:///D:/ReBaseAgent/apps/desktop/src/renderer/src/components/RunActionsBar.tsx#L64-L71) compact 形态的「不可用原因」——这是典型的**说明折叠控制**，`px-1 py-0.5` 命中区约 20px，且未走 `DisclosureButton`。
2. [WorkspaceFileView.tsx](file:///D:/ReBaseAgent/apps/desktop/src/renderer/src/components/WorkspaceFileView.tsx#L1420-L1421) 复制菜单的 `<summary>`——无 28px 命中区；且主 spec L1017 要求文件页工具控件有「悬停说明」，该 `summary` 无 `title`（菜单项有）。

建议：「不可用原因」改用 `DisclosureButton`/`Disclosure`；复制菜单 `summary` 至少补 28px 命中区与 `title`（若认定下拉菜单不属于折叠控制，可在 review 记录中说明豁免理由，但第 1 项不宜豁免）。

### P2-2 来源身份从常驻变为默认收起/按页签隐藏，与主 spec 的可辨性要求存在解读空间

- [App.tsx](file:///D:/ReBaseAgent/apps/desktop/src/renderer/src/App.tsx#L360)：`showSourceSummary={visible === "overview"}` 使隔离 run 的紧凑来源摘要（父 run / 轮次身份）只在概览页签出现；文件/步骤页签只剩「文件隔离」徽标。
- [WorkspaceFileView.tsx](file:///D:/ReBaseAgent/apps/desktop/src/renderer/src/components/WorkspaceFileView.tsx#L765-L783)：`checkpointOriginNote`（"本 run 的文件世界从父运行 X 第 N 轮续跑而来…"）移入默认收起的「检查点来源与说明」。

主 spec L708「子运行的来源说明 SHALL 明确父 run 身份」、L754「来源说明另标父 run」若按**默认可见**解读即冲突；delta Non-goals 也写了「不通过……隐藏异常、删除来源身份……来获得空间」。当前形态不是删除（一步展开可达，「文件隔离」徽标与检查点选择器常驻），倾向可接受，但应在 evidence-index 增加一条「来源身份可达性」场景（含截图与展开路径）显式钉住口径，或在 files/steps 页签保留一行极简父身份。另：messages 工作区常开形态的「源 run 不会被修改」半句随重复说明一并移除，仅存于完整 description，属轻微信息损失。

### P3（记录，不要求本轮处理）

- `WorkspaceHeading` 的 details 用 `hidden` 常驻 DOM，与 `Disclosure`「收起时内容不渲染」的既定纪律（组件头注释）两套机制并存；功能无碍，建议后续统一。
- `.workspace-heading` 的 container query 断点 560px 为经验阈值，未见校准记录；evidence 已如实标注其他工作区窄窗未补验。
- `ConfirmationBlock` 把 `.workspace-heading-actions`（grid 定位类）加在 `<button>` 上实现占位，可行但属布局类挪用，后续维护需知。
- `WorkspaceHeading` 的展开状态是组件本地 state，目标切换但组件不重挂时会保留展开状态（无害，留意即可）。

## 与验收口径的对照

- 高度、窄窗、无水平溢出、只读身份：有实测截图与几何数据支撑（约 1210/1020/800/640×713），1210×713 下文件 diff 正文 391.53px ≥ 357px 场景阈值。
- 未闭环（tasks 8/9，作者已标注，evidence-index 5 行「部分」）：指定 config.json 与比较返回路径重验、独立 200% 缩放、纯键盘复制菜单焦点、拖动/键盘区域调整重验、空串/尾随空白草稿、`pnpm check:ci` 全链路。

## 归档前清单

1. 处理 P2-1（折叠控件语义/命中区/悬停说明），P2-2 至少补 evidence 场景钉住口径。
2. 完成 tasks 8 的补验路径与 tasks 9 的 `pnpm check:ci` 全链路。
3. 按入库约定整理证据：`docs/reviews/2026-10-10-workspace-header-layout.md` 随 change 提交；`output/ui-header-review/` 为本地忽略目录，evidence-index 引用的日志/截图需按「被引用的必须入库」口径决定去留（作者已在 evidence-index 首段承诺归档前整理）。
