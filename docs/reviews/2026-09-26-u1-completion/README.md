# U1 归档后补齐与回归

日期：2026-09-26。范围：补齐 `refactor-run-workspace` 的导航可达性、面板宽度操作及原缺失的渲染证据。U4 仅保留已编写的 change 文档，本次不实施 U4。

## 原缺口与修复

归档的任务勾选不等于所有交互都已验证。原 evidence-index 为 61/62，缺少 `reasoning_content` 与响应正文区别分区的实际渲染核验；U2 实测记录还指出 U1 导航自动折叠后没有重新打开入口。

1. 全局栏增加运行列表开关，手动收起及自动折叠后均可重新打开。窄窗口用全宽列表临时替换工作区，选择运行或 Escape 返回，焦点进入搜索框并在返回时恢复到开关。
2. 显式打开步骤目录优先于自动折叠。小于 720px 或并排后正文不足 480px 时，目录临时占满工作区；选择调用或 Escape 返回详情。临时开合不覆盖宽窗口布局偏好。
3. 运行列表和步骤目录的宽度调节柄原本在纵向 flex 中没有可点击高度，现定位到面板右侧并覆盖高度。键盘事件是否消费在状态 updater 外同步判断，避免 React 延后更新导致浏览器默认动作未被阻止。
4. 全局栏完整运行 ID 可断行，避免窄窗口长 ID 撑开工具区域。

## 实际验收

入口脚本：[u1-completion-cdp.cjs](../../../apps/desktop/scripts/u1-completion-cdp.cjs)，原生窗口调节：[u1-completion-window.ps1](../../../apps/desktop/scripts/lib/u1-completion-window.ps1)。

运行在真实 Electron/preload 上，通过 CDP 鼠标、键盘、`Input.insertText` 驱动交互；未用 DOM `.click()` 替代被测导航。store 模块仅用于选择测试起点、读取断言状态及清理本脚本的草稿；Monaco API 仅定位编辑器、设置输入焦点及读取文本。没有发起模型或工具执行。

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| 100% 缩放 | 38/38 | [measurements.json](measurements.json) |
| 200% Electron 缩放 | 19/19 | [zoom200/measurements.json](zoom200/measurements.json) |
| 宽屏导航收起、重新打开 | 通过 | [wide-reopened.png](wide-reopened.png) |
| 800/640px 导航全宽替换、选择返回、焦点恢复 | 通过，两种缩放均验证 | [navigation-800.png](navigation-800.png)、[navigation-640.png](navigation-640.png)、[200% 640px](zoom200/navigation-640.png) |
| 640px 调用目录替换、Escape/Enter、选择返回 | 通过，两种缩放均验证 | [steps-640.png](steps-640.png)、[200% 640px](zoom200/steps-640.png) |
| 鼠标拖动步骤目录宽度、End 调到 320px | 通过 | `separator mouse drag` / `separator keyboard End` 断言 |
| 1024px 下 320px 目录自动折叠后重新打开 | 通过，目录占满工作区且导航暂时隐藏 | [steps-1024.png](steps-1024.png) |
| U2 文件状态经过导航替换后恢复 | 通过，`a.txt` / `s_15` / `content` 保持 | [file-restored-640.png](file-restored-640.png) |
| U3 未保存草稿经过导航替换后恢复 | 通过，文本与 revision=2 保持，重新打开编辑器显示原草稿 | [draft-restored-640.png](draft-restored-640.png) |
| reasoning 与正文独立呈现 | 通过，分区不重叠，记录字段分别在场；reasoning 为琥珀背景及 2px 左边框 | [reasoning-sections.png](reasoning-sections.png) |
| 既有 traces / workspace-blobs / settings | 两轮前后 SHA-256 映射相等 | 两份测量文件的最后一项断言 |

### 尺寸口径

本轮不调用 CDP Emulation。Win32 `MoveWindow` 以物理像素调整原生窗口，高度请求为 1000px；宽度按 CSS 测量迭代校准。以下是实际 `documentElement.clientWidth/clientHeight`，不将含边框的原生宽度当作内容宽度。脚本未保存 `GetWindowRect`，所以不将请求的外框值称为实测原生边界。

| Electron zoomFactor | force-device-scale-factor | CSS 视口 | DPR | 工作区 |
| --- | --- | --- | --- | --- |
| 1.0 | 1 | 1440 x 921 | 1 | 最终导航 264、目录 320、详情 856px |
| 1.0 | 1 | 1024 x 921 | 1 | 自动折叠目录后详情 760px；手动打开目录为 1024px |
| 1.0 | 1 | 800 x 921 | 1 | 临时导航 800px |
| 1.0 | 1 | 640 x 921 | 1 | 临时导航或步骤目录 640px |
| 2.0 | 1 | 800 x 460 | 2 | 临时导航 800px |
| 2.0 | 1 | 640 x 460 | 2 | 临时导航或步骤目录 640px |

以上采样均无文档横向溢出。200% 指通过现有 `REBASEAGENT_ZOOM_FACTOR=2` 设置的真实 Electron 缩放；未更改 Windows 系统 DPI。本次不扩大为所有系统 DPI、所有窗口尺寸或原生对话框均已验收。

### 数据与复现边界

脚本将仓库已有 U1 fixture 克隆为 `u1_completion_tools` / `u1_completion_reasoning` 两份明确命名的记录，后者同时包含受控 reasoning 和正文。它验证的是已记录字段的真实渲染，不是新发起的推理模型请求。同名文件内容不符时脚本拒绝覆盖。哈希基线在夹具准备后建立，验收期间不修改既有记录、附件或设置；截图和测量 JSON 为测试产物。

文件回归读取本机 U3 已有夹具 `.workbuddy/u3/u3-61/manifest.json` 的 `isoFork`。复现需要该夹具及附件存在；不是在空数据目录即可独立执行的测试。草稿仅使用本脚本的 `u1_completion_tools/s_03/result`，验证结束后清理该条测试草稿。脚本会重载专用 dev renderer，不应在有未保存工作的日常窗口执行。

本轮 UI 额外验证的是文件路径/检查点/显示模式，以及工具结果草稿经过新增导航入口后的恢复；没有据此声称重新执行了 U2/U3 所有 GUI 场景。其余 U1/U2/U3 义务沿用已有归档证据及本次全量 desktop 测试。

```powershell
# 专用 dev 窗口，9612 可用；先确保没有需要保留的 dev 会话草稿。
$env:REBASEAGENT_FORCE_SCALE_FACTOR = '1'
$env:REBASEAGENT_ZOOM_FACTOR = '1'
node apps/desktop/scripts/u2-dev-host.cjs
node apps/desktop/scripts/u1-completion-cdp.cjs

# 只停止上述脚本启动的进程树，再验 200%。
node apps/desktop/scripts/u2-dev-host.cjs --stop
$env:REBASEAGENT_ZOOM_FACTOR = '2'
node apps/desktop/scripts/u2-dev-host.cjs
node apps/desktop/scripts/u1-completion-cdp.cjs --zoom200
```

本轮结束已恢复 100% dev 窗口，renderer 地址 `http://localhost:5173/`；完整功能需 Electron preload，直接用普通浏览器打开该地址不等价于桌面应用。

## 工程检查

- Desktop Vitest：80 文件、1526 测试通过，含布局、阅读恢复、文件、草稿及既有受控执行回归。
- `pnpm.cmd --filter @rebaseagent/desktop typecheck`：通过。
- `pnpm.cmd exec biome check .`：368 文件通过。
- `pnpm.cmd --filter @rebaseagent/desktop build`：main/preload/renderer 构建通过；Vite 提示 Monaco React 包同时存在静态和动态导入，未阻塞构建。本次未调整打包策略，也未生成发行安装包。
- `openspec.cmd validate --all --strict --no-interactive`：13 项通过、0 失败。

据此将 U1 原缺失的 Req4-1 标为已补验，累计覆盖更新为 62/62；原归档日期与历史验收记录保留。这是 U1 补齐，不代替 U4 的实施和验收。
