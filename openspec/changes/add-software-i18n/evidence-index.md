# 证据索引（实施中）

> 本文件按任务登记“场景 → 入库测试 / 实机证据”。**未执行项如实标注**，不以批次通过宣称全软件双语完成。
> 实机截图与机器报告按项目惯例放在 gitignored `.workbuddy/<任务>/`，不随仓库交付；本文件记录命令、构建与产物相对位置。

## 6.1 真实 Electron 两语言逐工作区走查（D19/D20/G05）

6.1 按工作区拆批执行；每批固定记录 fixture、构建、窗口/DPR、语言切换方式与机器判据。

### 6.1a 读工作面（外壳 / 运行列表 / 总览 / 步骤 / 文件 / 比较）— 已完成 2026-11-01

- **构建**：`dd2c137b8e3b293c3c2597e1ef3e1eab2a5eae64`；dev 由
  `NO_SANDBOX=1 node scripts/start-dev.cjs --remoteDebuggingPort=9612` 启动；
  数据根 `<仓库根>/.rebaseagent`；窗口 CSS **1210×713**、DPR **2.1**（CDP `innerWidth` 实测）。
- **语言上下文**：设置对话框真实切换 `zh-CN` / `en-US`，HTML lang 同步；每语言独立跑完本批场景。
- **受控性**：本批全部为只读场景（选择运行、切页签、打开比较、读取目录/文件清单），
  零模型调用、零执行、零写入；失败/不可用路径使用既有 fixture 与临时损坏 trace（用后删除）。
- **机器判据**：每个场景（1）断言当前语言的产品文案在场（资源键，含参数）；
  （2）英文界面下产品 chrome 的汉字残留必须为 0；正文/记录/文件内容按所选 run 的 trace 与
  附件文本白名单排除（截断片段按前缀匹配）；（3）截图归档。
- **证据**：`.workbuddy/i18n-61/report.json`、`.workbuddy/i18n-61/shots/<lang>-<scenario>.png`、
  运行器 `.workbuddy/i18n-61/run-61a.cjs`；本批 **24/24 场景通过**（12 场景 × 2 语言）。

| 场景 | 路径 | fixture | 判据摘要 |
|---|---|---|---|
| shell / 运行列表 | 成功 | 701 条既有运行 + 当前选中 | 视图切换、新建、配置、列表筛选/指标、复制 ID 均当前语言；英文 chrome 无汉字 |
| shell / 设置语言 | 成功 | 真实设置对话框 | 语言标题/三选项/帮助文案当前语言；真实切换后 HTML lang 生效 |
| 总览 completed | 成功 | `run_mvhj9cq8_1y8519`（隔离根，5 步） | 结局、消耗、来源分区标题当前语言；任务/输出原文保持 |
| 总览 errored | 失败 | `run_mu2guw5y`（errored/error） | 失败原因/LLM 错误标题当前语言；错误正文原文 |
| 步骤 completed | 成功 | `run_mvhj9cq8_1y8519` | 轨迹、耗时、tokens、轮次与文件清单入口当前语言 |
| 步骤 errored | 失败 | `run_mu2guw5y` | 轨迹 + “错误详情未记录”当前语言；不把历史正文当漏翻 |
| 文件 | 成功 | `run_mvhj9cq8_1y8519` | 初始/轮末检查点、来源、导出/验证入口、目录筛选当前语言 |
| 文件 | 不可用 | `run_mtljcbrr`（普通 v1 run） | 只有概览/步骤两个页签；无虚假文件页 |
| 文件 | 失败/不可用 | `run_mu9cij1b_xx82oe`（附件缺失） | 清单规模 + 附件不可用说明当前语言；导出入口如实禁用 |
| 比较 | 成功 | `run_mvhj9i9c_c22r` ← `run_mvhj9cq8_1y8519` | 左右输出、指标/文件/文本差异入口、编辑证据当前语言 |
| 比较 | 不可用 | 临时损坏 trace `run_i18n61_broken` | 不可读侧原因、无步骤目录、无可核对结论当前语言；原始读取诊断保留 |
| 运行列表 | 失败 | 临时损坏 trace `run_i18n61_corrupt` | “读取失败”行与错误详情可见；用后删除并重载恢复 |
| 全部场景 | — | — | 英文 chrome 汉字残留 **0**；正文/记录原文允许且可辨 |

- **发现并修复**：`CompareWorkspace` 派生单侧文件入口时未传当前 translator，英文界面的
  “文件”入口 title 落回中文默认值。修复于 `dd2c137`，并补英文文案断言与源码接线回归
  （`apps/desktop/test/compare-workspace-view.test.tsx`）。

### 6.1b-1 创建工作区（成功 / 失败 / 不可用）— 已完成 2026-11-01

- **构建**：`b6a2ac87b9a73d06218feb2421b06e670152d8ed`；dev/CDP 同 6.1a；受控模型服务
  `127.0.0.1:18799`（剧本制 OpenAI 兼容，零费用）；语言经设置对话框真实切换。
- **配置保护**：测试前备份 `settings.json` 与 `ui-preferences.json`，结束时逐字节还原
  （`settingsRestored=true`、`prefsRestored=true`，无语言偏好残留）。
- **证据**：`.workbuddy/i18n-61/report-61b-create.json`、
  `.workbuddy/i18n-61/shots-61b/<lang>-<scenario>.png`；运行器
  `.workbuddy/i18n-61/run-61b-create.cjs`；本批 **10/10 场景通过**。
- **机器判据**：产品文案当前语言；英文 chrome 汉字残留 0；受控服务请求计数；
  落盘 trace 增量；失败/不可用不得出现新 trace 或模型请求。

| 场景 | 路径 | 受控输入 | 结果 / 判据 |
|---|---|---|---|
| create-unavailable | 不可用 | 清除运行配置（未保存 baseURL/apiKey/model） | 表单显示“尚未配置运行参数”；确认/提交不可放行；新 trace **0**、请求 **0** |
| create-unavailable-blocked | 不可用 | 同上，尝试确认+提交 | 稳定码 `SETTINGS_NOT_CONFIGURED`；页面给本地化失败摘要 + 原始说明；新 trace **0**、请求 **0** |
| create-form | 成功路径的表单态 | 受控配置 + 已填任务 | 新建页标题/字段/核对块当前语言；任务原文保持 |
| create-success | 成功 | 受控 SSE 一轮文本回答 | 新 run `meta.id` 落盘；概览 `Completed`；受控服务恰 **1** 次请求；任务原文保持可辨 |
| create-failure | 失败 | 受控 HTTP 500 | 新 run 落盘且结局 `Ended with error`；稳定码 `CREATE_RUN_FAILED`；请求恰 **1** 次；provider 原始错误详情保留（`LLM 端点返回 HTTP 500…`，属原文，不计漏翻） |

- **未覆盖**：result/prompt/messages 编辑、模型实验（6.1b-2/3）；真实模型不参与本批。

### 待执行（同一 6.1 任务）

- **6.1b-2/3**：result/prompt/messages 编辑、模型实验的成功/失败/不可用两语言实机走查。
- **6.1c 录制/设置/导出/验证 + 原生对话框**：录制工作区启停与端口冲突、设置保存/清除、
  导出成功/取消（D20 原生选择器打开时语言）、验证面板可用/不可用/记录读取。
- **未覆盖**：真实模型、布局断点与 200%（6.2）、真键盘（6.3）、未提交/在飞/未知状态（6.4）。
