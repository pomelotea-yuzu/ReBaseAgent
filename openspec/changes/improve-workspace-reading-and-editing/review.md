# improve-workspace-reading-and-editing change 审阅

> 日期：2026-10-06。对象：proposal / design / tasks / desktop-ui delta。范围：文档与源码核对，未实施产品代码、未运行功能或 Electron 验收。本文件为该 change 的首轮独立评审记录。

## 结论

**可作为实施基线**：未发现 P1/P2 问题。数量、场景-任务映射、与主 spec 76 个既有 requirement 的兼容性、文案缺陷源码锚点、与 fix-proxy-recording-reliability 的交界声明全部核实通过；仅余 4 项不阻塞观察项。

## 对照依据

- 主 spec：`desktop-ui` 76 requirements。重点核对：L915「工作区在窄窗口和键盘操作下可读」、L994「文件目录和差异按内容容器宽度适配」、L1015「文件阅读工具操作完整原文且保持只读」、L1118「编辑核对与明确放弃区分于收起」、L1290「保留模态框约束焦点并正确恢复」、L877「会话内按运行恢复阅读位置」、L936「文件阅读在会话内按运行恢复并校验定位」。
- 源码锚点：`execution-confirmation.ts:461`（字面 `**`）、`MessagesForkEditor.tsx:305`（空 fork 文案）、`DetailPanel.tsx:1252/1268`（时间旅行双称呼）。
- 基线核对：`openspec validate improve-workspace-reading-and-editing --strict` 通过；`docs/reviews/2026-10-06-ui-density-review.md` 与 `output/ui-density-review-2026-10-06/` 均存在（1210×713 实测基线、y≈509、16×16 箭头等数字与 proposal 一致）。
- 注意：change 目录当前**未提交**（untracked），提交时随本 review 一并入库。

## 已核实事实（全部属实）

1. **数量与结构**（独立解析）：delta 仅 **8 ADDED（desktop-ui）、22 scenarios**，与主 spec 既有 requirement 零重名；22 个场景全部被 tasks 括号精确引用（4.5 兜底「本 change 全部场景」），无悬空引用。
2. **与既有 requirement 全部理顺，无冲突**：
   - 折叠要求「不等于放弃、取消执行或解除授权门禁」与 L1118「编辑核对与明确放弃区分于收起」同向；
   - 「放弃修改模态视觉明确」只动遮罩/居中/滚动视觉，显式保留 showModal、焦点限制、Esc、修订 CAS——与 L1290 行为契约互补不重叠；
   - 「编辑与差异获得实际可用空间」补的是**高度**维度，与 L994 的**宽度**适配互补；「不缩小字号」与 L915 窄窗可读方向一致；
   - 折叠/专注的阅读状态归 ridingByRun/草稿体系，承接 L877/L936 的既有会话恢复机制；
   - 只读 diff 不可写、折叠零执行零写通道，与 L1015、L262「分叉重跑是唯一的显式写路径」一致。
3. **357px 数字自洽**：713/2 ≈ 357，scenario WHEN 限定「真实 1210×713 视口」，绝对像素写在条件化场景内不越界；基线 y≈509 的改善目标有实测出处。
4. **文案缺陷锚点全部属实**：`execution-confirmation.ts:461`「凭据是代理会话**最近捕获**的那一个」确有字面 `**` 进入 UI 确认文案（ui-density-review L54 所指即此）；`MessagesForkEditor.tsx:305`「未做任何修改（空 fork 被拒绝）」即任务 3.4 要替换的实现术语文案；「在此重跑（时间旅行）/（隔离续跑）」双称呼确实并存于 `DetailPanel.tsx:1252/1268`。
5. **与 fix-proxy-recording-reliability 的交界双向闭环**：双方 Non-goals 互指（本 change 不管代理 freshness/凭据/失败录制；对方不管折叠/说明/专注/空间）；编辑器恢复归属对方、布局归属本 change；公共 Monaco 包装接口最低面（onMount、尺寸接线、失败占位）两处 design 表述一致，且互相声明了两种合入顺序下的处理；任务 4.4 承载合入后重跑。
6. 对 export-run-results 的前向约束（文件页动作放紧凑工具栏、不提前显示未交付能力）只做边界声明，不越权修改对方 change。

## 不阻塞观察项

1. **evidence-index 粒度偏粗**：22 场景映射 8 组，组内多场景合并登记；收口时须逐 scenario 回填测试名/截图（fix-proxy 是 28 场景 6 组但每场景都有任务级引用，两组都在合格线上），建议回填时按 scenario 逐行列出而非按组。
2. **专注模式的状态存储未定位**：D1 说折叠状态「沿用 readingByRun/草稿和布局偏好」，但「进入专注前手动偏好快照、退出恢复」是一个新的临时状态维度，design 未指明落在哪（readingByRun 扩展 or 独立 focus 状态）。实施时需钉死，避免出现第三处与草稿并行的状态源——这是既往 bug 的高发形态（参考 U2 5.6 把「从未进入」与「进入后失效」混为一谈的教训）。
3. **「技术详情」应单一机制**：D2 的「来源与技术详情」展开区与 D5 的「fork/main 登记/config_hash 工程解释进入技术详情」若各自实现会产出两套「技术详情」组件，建议实施时复用同一展开组件。
4. 窄窗/200% 缩放验收依赖真实宿主环境，evidence-index 已声明「宿主不可达项单独记录」；当前 Windows 真实窗口可满足 1024/800 与 200% 缩放，无需 Emulation 替代——与 D7「不用 Emulation 假几何」一致。

## 实施时继续遵守的边界

- 两段确认、来源门禁、当前凭据规则、工具副作用授权、安全退出保护全部维持；折叠/专注是纯阅读状态，不新增授权、不恢复失效许可。
- 修改同一编辑器组件时与 fix-proxy-recording-reliability 互相重跑场景（任务 4.4 已承载，勿删）。
- 本轮为文档与源码核对，不构成功能交付或归档放行；19 条任务全部未勾选。
