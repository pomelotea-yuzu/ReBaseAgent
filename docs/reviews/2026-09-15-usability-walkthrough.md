# ReBaseAgent 桌面可用性走查

> 日期：2026-09-15
> 方式：启动当前源码的 Electron 开发版，通过 Playwright/CDP 实际点击并截图，结合源码定位。
> 关联规划：`docs/engineering/plans/2026-09-15-usability-improvement-plan.md`
> 本次完成界面走查，未修改产品代码，未提交真实模型调用。

## 1. 主要发现

### F1 · 四条运行对比时，指标名称完全消失 [P2]

- 复现：进入分支树，依次勾选四条运行。本次使用 `run_mu2iw6hw_a3ly`、`run_mu2iw4s1`、`run_mu2guw5y`、`run_mu2h6jz9`。
- 实测：右侧只剩四列数字，“状态、创建时间、本 run tokens、本 run 耗时”等行名称不可见。用户无法确认每行数字的含义。
- 原因：对照面板固定为 256 CSS px，每列数字固定 56 px；四列加间距、内边距后将可收缩的指标列挤没。
- 建议：改为独立宽幅对比视图，保证指标名称列的最小宽度；超出空间时明确提供横向滚动。
- 定位：[ComparePanel.tsx:25](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/ComparePanel.tsx:25)、[固定侧栏宽度](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/ComparePanel.tsx:121)。
- 截图：[四条对比](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/compare-four.png)。

### F2 · 失败运行使用成功色，详情还给出错误解释 [P2]

- 复现：在运行列表打开 `run_mu2guw5y`，点击唯一的 LLM 调用。
- 实测：“出错终止”与“已完成”使用相同绿色徽标；详情显示工具调用为 0，却写着“无正文，仅有工具调用”。没有呈现具体失败原因。
- 影响：快速扫描时容易漏掉失败，进入详情后仍无法据此诊断。
- 原因：列表颜色只区分 `crashed`；已封存但以 error 结束的运行也走绿色分支。响应正文为空时，详情无条件使用“仅有工具调用”文案。
- 建议：区分成功、失败、中断和达到限制；空正文按实际工具调用和结束状态解释。新增错误信息链路，历史记录缺失时明确写“未记录失败原因”。
- 定位：[RunList.tsx:15](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/RunList.tsx:15)、[DetailPanel.tsx:748](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/DetailPanel.tsx:748)。分支树颜色也需同步核查：[BranchTree.tsx:16](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/BranchTree.tsx:16)。
- 截图：[失败详情](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/error-llm.png)。

### F3 · 对比列的运行编号截断后无法区分 [P2]

- 复现：对比父运行 `run_mu2iw4s1` 和子运行 `run_mu2iw6hw_a3ly`。
- 实测：两列 run id 都显示为 `run_mu2`；四条对比时四列也完全一样。面板底部存在完整编号，但需要用户自己按顺序回查。
- 原因：编号统一取前 7 个字符，容易只保留公共前缀。
- 建议：列头显示可辨识的名称或唯一短编号，配合模型、修改类型；保留完整编号的查看与复制入口。
- 定位：[ComparePanel.tsx:181](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/ComparePanel.tsx:181)。
- 截图：[两条对比](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/compare.png)。

### F4 · 分支树节点的累计数据被裁掉 [P2]

- 复现：在 100% 缩放下查看分支树中的父子运行节点。
- 实测：节点最后一行被裁切。父子节点按钮可见高度约 74 CSS px，内容高度约 98 px；其他节点也有 74/82 px 的差异。
- 原因：布局节点固定高 76 px，按钮使用 `overflow-hidden`，多行文本的实际高度超过分配高度。
- 建议：按内容行数设计稳定尺寸，同步调整布局与节点内容；关键数据必须完整显示。
- 定位：[derive.ts:619](/D:/ReBaseAgent/apps/desktop/src/shared/derive.ts:619)、[BranchTree.tsx:161](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/BranchTree.tsx:161)。
- 截图：[分支树](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/tree.png)。

### F5 · 分支树“点击节点查看详情”与实际行为不符 [P2]

- 复现：进入分支树，点击 `run_mu2iw4s1` 节点。
- 实测：选中状态和顶部编号改变，但页面仍停留在树和对照面板，没有出现运行详情。需要额外切回“轨迹”，再选择一个步骤。
- 影响：用户按页面提示点击后，容易认为没有响应，或继续寻找不存在的详情面板。
- 建议：提供明确的“打开运行”操作，或让点击直接展示详情；如果单击只用于选中，应采用与行为一致的提示。
- 定位：[BranchTree.tsx:158](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/BranchTree.tsx:158)、[页面提示](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/BranchTree.tsx:218)。
- 截图：[点击节点后](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/tree-selected.png)。

## 2. 布局与工作流问题

以下为实测基础上的改版建议，优先级应结合后续使用者走查确定。

### U1 · 两个导航栏占用空间过多

默认启动后测得内容视口约为 1210 × 713 CSS px，运行列表宽 320 px、步骤栏宽 384 px，正文宽约 506 px。通过 Playwright 将视口模拟为 1000 × 700 后，两栏宽度不变，正文只剩约 296 px。步骤栏大量空白与正文拥挤同时出现。

建议允许调整或折叠导航栏；在窄窗口中切换为单一导航层，优先保障正文和编辑器空间。

定位：[RunList.tsx:45](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/RunList.tsx:45)、[SpanTree.tsx:120](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/SpanTree.tsx:120)。截图：[窄视口](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/narrow.png)。

### U2 · 修改 prompt 与 A/B 入口位于长详情底部

打开多步运行的首次 LLM 调用，首屏能看到概要、响应和工具调用，修改 prompt 与 A/B 按钮位于请求消息、工具表之后，需要向下滚动。打开编辑器后，编辑器下部和提交区还需要继续滚动。

建议将运行级操作放入稳定的工具区；选择操作后直接呈现完整编辑区域。修改工具结果的入口可以继续贴近对应结果。

定位：[DetailPanel.tsx:797](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/DetailPanel.tsx:797)。截图：[详情首屏](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/llm.png)、[打开编辑器后](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/prompt-editor.png)。

### U3 · 选中运行后缺少运行概览

选中父运行后，右侧仍是“尚未选择 span”；步骤只有“第 N 轮、LLM 调用、read_file”等标识。想知道最终回答，需要先判断哪条调用包含结果，再点进去阅读。

建议选中运行时先展示最终结果、结束状态和关键指标，再提供步骤深入查看。

定位：[DetailPanel.tsx:1349](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/DetailPanel.tsx:1349)。截图：[刚选中运行](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/parent.png)。

### U4 · 列表和分支树都难以定位目标运行

本次界面显示 42 条运行，存在多条同名任务。运行列表只有来源筛选，缺少搜索；长任务标题截断后难以辨认。选中近期运行再切换分支树，视图从较早运行开始，没有自动定位当前节点。

建议补充任务名称或编号搜索、当前运行定位，并优先展示当前运行所在分支族。这里不要求先引入完整项目管理功能。

定位：[RunList.tsx:37](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/RunList.tsx:37)、[BranchTree.tsx:89](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/BranchTree.tsx:89)。截图：[列表](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/home.png)、[切入分支树](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/tree.png)。

### U5 · 对比内容不能直接回答“修改效果如何”

父子运行对比展示了步骤、token、耗时和累计增量，但没有最终输出或修改内容的并排展示。用户必须切回轨迹，分别查找两次输出，自行记忆和比较。

建议把修改内容、最终输出作为对比视图的主要内容，消耗指标作为辅助判断。保留累计增量的准确口径，不将其直接当作完整重跑成本。

定位：[ComparePanel.tsx:165](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/ComparePanel.tsx:165)。截图：[当前对比内容](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/compare.png)。

### U6 · 新建运行表单突出内部概念，却不显示本次模型

打开“新建运行”后，页面解释 `config_hash`、空工具表、父本、task 字段，但没有显示此次调用将使用的模型。用户需要关掉对话框，再去运行配置中核对。

建议在表单中展示当前模型与配置入口；将字段名改为易懂的任务和系统指令，把内部实现说明移出主操作流程。

定位：[CreateRunDialog.tsx:60](/D:/ReBaseAgent/apps/desktop/src/renderer/src/components/CreateRunDialog.tsx:60)。截图：[新建运行](/D:/ReBaseAgent/docs/reviews/2026-09-15-usability-assets/create.png)。

## 3. 建议处理顺序

1. 先修准确性和内容可见性：F1 至 F5，避免用户被错误状态、提示或裁切内容误导。
2. 绘制主界面与宽幅对比原型：优先解决 U1、U2、U3、U5，走通“查看、修改、重跑、对比”。
3. 补充导航与表单体验：U4、U6，统一命名、搜索、定位和当前配置展示。
4. 另做执行期间验证：使用受控的本地模拟服务覆盖等待、失败、取消、切换视图与完成后的跳转。

## 4. 验证边界

- 实际操作：打开运行、选择模型调用和工具步骤、打开并取消 prompt/工具结果编辑器、打开并关闭新建对话框、分支树节点选择、两条和四条运行对比、窄视口检查。
- 使用现有开发数据，其中既有真实运行，也有旧冒烟数据；未把旧记录的耗时或父链异常推断成当前执行内核缺陷。
- 本次未修改模型配置、启动代理、提交创建或重跑，没有新增 API 费用。
- 未验证真实执行期间的进度、取消和自动跳转，也未模拟空数据目录；这些仍是后续待测项。
- 默认窗口为实际 Electron 窗口；1000 × 700 为渲染视口模拟，不代表已经验证所有操作系统缩放比例。
- 未运行单元测试：本次为界面审阅，产品代码未改动。开发版启动时的 main/preload 构建成功。
- 截图保存在 `docs/reviews/2026-09-15-usability-assets/`，临时操作脚本位于 `.tmp-smoke-artifacts/usability-inspect.cjs`。
