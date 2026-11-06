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

### 6.1b-2 result / prompt 编辑器（成功 / 失败 / 未配置）— 已完成 2026-11-01

- **构建/证据**：`b6a2ac8`；受控 mock `18799`；父 run `run_mu2iw4s1`（tool span `s_03`、
  首次 llm span `s_02`）；本批 **12/12 通过**。报告/截图
  `.workbuddy/i18n-61/report-61b-edit.json`、`shots-61b-edit/`；运行器 `run-61b-edit.cjs`。
- **判据**：Monaco 草稿真实写入后核对/提交；成功 = 新 run `Completed` 且受控服务 1 次请求；
  失败 = 新 run `Ended with error`（HTTP 500）；未配置 = result 侧 `SETTINGS_NOT_CONFIGURED`
  受控错误，prompt 侧提交门直接禁用并显示 `run.settingsRequiredForFork`，均零请求/零新 trace。
- **原文边界**：provider 错误详情（`LLM 端点返回 HTTP 500…`）按原文保留，不计漏翻。

### 6.1b-3 模型实验与 messages（成功 / 失败 / 不可用）— 已完成 2026-11-01

- **模型实验**：本批 **10/10 通过**（报告 `report-61b-experiment.json`、截图
  `shots-61b-experiment/`）。成功 = 两臂各一次受控请求、两个新 run `Completed`；
  失败 = 第二臂 HTTP 500，结果区显示 `Ended with error` 与失败臂；
  不可用 = 隔离父本入口禁用并展开 `detail.experimentEntryIsolated` 原因；本批零真实模型。
- **messages**：本批 **10/10 通过**（报告 `report-61b-messages.json`、截图
  `shots-61b-messages/`）。受控代理 `18787` + mock upstream `18799`：外部请求捕获 key 并落
  proxy run；编辑 messages 重发成功成 1 条新 proxy run，失败回合 500 落 errored run；
  代理停止时编辑器显示 `fork.messagesProxyStopped` 且提交禁用；请求计数 2（捕获+重发）。
- **原文边界**：provider 原始错误详情与代理请求正文保持原文，不计漏翻。

### 6.1c 录制 / 设置 / 导出 / 验证不可用 / 原生对话框 — 已完成 2026-11-01（补验见 6.1d）

- **录制**（6/6）：成功 = 真实监听并显示访问地址；失败 = 端口 18787 被占用，本地化摘要 +
  `PORT_UNAVAILABLE` 原始说明；不可用 = upstream 为空时字段错误且应用禁用。
- **设置**（6/6）：成功 = 保存并回读 `settings.savedVerified`；失败 = 主进程拒绝非法 baseURL，
  本地化失败摘要 + 原始 Zod 详情；不可用 = 配置缺失时状态行与保存禁用。
- **导出**（6/6）：通过 dev-only `REBASEAGENT_PICK_DIRECTORY_FILE` 控制目录选择；成功 =
  files/`changes.patch`/清单落盘并显示导出摘要；取消 = `export.canceled` 零写入；
  不可用 = 缺附件检查点入口禁用并显示附件不可用原因。
- **验证**（2/2 不可用）：Docker daemon 未运行（`引擎不可达（exit 1）`），两语言面板均显示
  本地化不可用说明 + 原始诊断；成功/失败路径于 2026-11-02 补验，见 6.1d。
- **原生对话框 D20**：英文界面真实目录选择框屏幕证据
  `.workbuddy/i18n-61/shots-61c/en-US-native-dialog.png`：应用标题 `Choose a directory` 为英文，
  OS 自带控件保持中文（未项目翻译）。中文界面对话框屏幕证据于 2026-11-02 补取，见 6.1d。
  导出取消路径已由控制文件覆盖。
- **配置保护**：各运行器均逐字节还原 `settings.json` / `ui-preferences.json`
  （`settingsRestored=true`、`prefsRestored=true`）。

### 6.1d 验证成功 / 失败与中文原生目录框 — 已完成 2026-11-02

- **构建/环境**：`be03d11`；Qoder 内
  `node apps/desktop/scripts/u2-dev-host.cjs --port 9300` 启动真实 Electron（CDP 9300；
  Windows 当前排除端口含 9594–9693，原 9612 不可用）。数据根 `<仓库根>/.rebaseagent`；
  Docker engine **29.9.2**；已准备环境 `prep-47c4e5384ed714bd`
  （image digest `sha256:fd809329…`，manifestVersion 4），run 无需先 prepare。
- **fixtures**：成功 `run_r3_63_slow`（initial 检查点、`test`、`passed`）；
  失败 `run_r3_61b_base`（initial、`test`、`check_failed`、exit 1）。
- **机器判据**：真实 UI 打开验证面板 → 确认执行 → 提交固定检查；`verificationLastOutcome`
  的 `outcome` / `evidenceComplete` 与预期一致；`data-verification-outcome` 文案当前语言。
  失败路径额外聚焦可信记录并读取 `test:stdout`：日志含 `not ok 2 - mul(2,3)=6`，
  记录 `command_end.exitCode=1`；成功路径日志含 `ok 2`、exit 0。英文产品 chrome 汉字残留 **0**；
  outcome/record 的原始 `detail`（`命令完成…` / `检查失败…`，属 runner 原文）
  按**完整混排句**白名单保留，不当作漏翻。
- **证据**：`.workbuddy/i18n-61/report-61-verify.json`、
  `.workbuddy/i18n-61/shots-61-verify/<lang>-<success|failure>-<outcome|record-log>.png`；
  运行器 `.workbuddy/i18n-61/run-61-verify.cjs`；**4 个两语言场景通过（8/8 采集）**；
  `settingsRestored=true`、`prefsRestored=true`。

| 场景 | 路径 | fixture | 结果 |
|---|---|---|---|
| 验证成功 | 成功 | `run_r3_63_slow` / initial / test | `passed`、证据完整；日志 `ok 2`、exit 0 |
| 验证失败 | 失败 | `run_r3_61b_base` / initial / test | `check_failed`、证据完整；日志 `not ok 2`、exit 1 |
| 原生目录框（中文） | 成功 | 真实「选择目录」 | UIA `#32770` 标题「选择目录」、按钮「选择/取消」；全屏截图已取 |

- **中文原生目录框做法**：`dialog-dump.ps1` 确认 UIA 可读标题与 `选择`/`取消`
  （2026-11-01 记录的“现代目录框非 #32770、UIA 不可见”是框未稳定/不在场时的误判，已由本轮推翻）；
  `MoveWindow` 移到 `80,40,1200,860` 让按钮进入屏幕，再全屏 `CopyFromScreen`；收尾
  `WM_CLOSE` 关闭并用 `dialog-text` 复核 `dialog=none`。截图
  `.workbuddy/i18n-61/shots-61c/zh-CN-native-dialog.png`。

### 6.1 剩余与边界

- **已执行**：验证成功/失败（6.1d）、中文原生目录框屏幕证据（6.1d）。
- **未覆盖**：真实模型、布局断点与 200%（6.2）、未提交/在飞/未知状态（6.4）；真键盘已由 6.3 覆盖。
- 本批累计实机场景：6.1a 24 + 6.1b-1 10 + 6.1b-2 12 + 6.1b-3 20 + 6.1c 14 + 导出 6 + 6.1d 4
  = **90** 个两语言场景通过；真实模型均未参与（受控 mock）；另有中英原生目录框屏幕证据各 1。

## 6.2 双语布局与 200% 缩放（D21）— 已完成 2026-11-02

- **构建/环境**：`1b5ff13`；Qoder 内 dev/CDP **9300**（Windows 当前排除段含
  9594–9693，原 9612 不可用）。100% 组 DPR 2.1；200% 组
  `REBASEAGENT_ZOOM_FACTOR=2`，DPR 4.2。数据根 `<仓库根>/.rebaseagent`。
- **实际尺寸**：1440 → inner **1442×701**（outer 2033，ps-win）；1024 → **1024×713**
  （outer 1034，resizeTo）；800 → **801×713**（outer 810，resizeTo）；
  200% → **924×582**（outer 2600，按实测 CSS 记录，不冒充具体档位）。
- **两语言代表视图（每个尺寸）**：步骤页「上下文预算图」echarts canvas、缺失附件长错误、
  验证面板长只读说明/长 ID/准备与执行按钮、result 编辑器外围（Monaco +
  确认重跑/取消/外围说明）。
- **机器判据**：整页无横向溢出；局部纵向滚动存在且无横向溢出；长译文/说明不横向裁切
  且在视口内；任务标题允许单行省略但 `title` 兜底完整；运行 ID 入口在视口内；
  图表 canvas 在视口内且不超容器；验证入口/按钮在视口内；Monaco 宽度 >200 且不超宽，
  确认/取消按钮不裁切。200% 另核 DPR>3.5。
- **结果**：100% 24 视图 / **318 条判据全过**；200% 8 视图 / **106 条判据全过**；
  合计 **34 张截图、424 条判据 0 失败**；`settingsRestored=true`、`prefsRestored=true`。
- **原生目录框（200%）**：zh 标题「选择目录」+ OS 按钮「选择/取消」；en 标题
  「Choose a directory」+ OS 按钮「Select/取消」（系统本地化混排，OS 控件不在项目
  翻译承诺内）。Qoder 抢前台时用无 Alt 的 `raise-window.ps1`（AttachThreadInput +
  BringWindowToTop + SetForegroundWindow）把框抬到前台再全屏截图；`WM_CLOSE` 收尾。
  两语言均 `raised=true`、`dialog=none`。
- **环境边界**：6.2 期间 Docker engine 已停止（`engine_unavailable`），验证面板走
  不可用态（长错误/长 ID/按钮布局已覆盖）；验证 `passed`/`check_failed` 的真实执行证据
  见 6.1d。200% 只复跑一个实测窗口（CSS 924），不宣称 1440/1024/800×200% 笛卡尔积；
  6.4 状态竞态仍未做；真键盘已由 6.3 覆盖。
- **证据**：`.workbuddy/i18n-62/report-62-widths.json`、`report-62-zoom200.json`、
  `report-62-geometry-widths.json`、`report-62-geometry-zoom200.json`、
  `report-62-native-zh-CN.json`、`report-62-native-en-US.json`、`shots/`（34 张）；
  运行器 `run-62-layout.cjs`、`run-62-native.cjs`、`probe-62-geometry.cjs`、
  `raise-window.ps1`、`dialog-dump.ps1`、`close-dialog.ps1`。结束后 `--reset-zoom`
  清持久 zoom（复核 remaining localhost zoom hosts = 0）。

## 6.3 键盘流程（D22）— 已完成 2026-11-05

- **构建/环境**：源码基线 `3550d36` + 本任务的焦点恢复修复（`LanguageSettings`）；
  真实 Electron dev（CDP **9300**，`Emulation.setFocusEmulationEnabled`）；数据根
  `<仓库根>/.rebaseagent`；视口 **1210×713**、DPR **2.1**。设置入口、页签、语言组、
  核对按钮、文件列表、模态标题与按钮、焦点环均按当前有效语言命名。
- **通道（如实口径）**：键击经 **CDP `Input.dispatchKeyEvent`（浏览器层受信事件）**
  投递；本机 OS 物理键盘无法投递到 Electron 窗口（历史实测见 mcp0-61），
  本批**不宣称 OS 物理键通道**。所有激活均由键击产生受信 click，全程无 `.click()`；
  仅有少量焦点预放（setup）用于定位夹具，均不计为激活证据。
- **流程**：`en-US → zh-CN → en-US` 键盘往返；结果编辑器中用键盘键入草稿
  （Monaco EditContext、Ctrl+A、Ctrl+M 脱离）、核对；在编辑态切语言后草稿/修订保持、
  执行确认被清除、未重新核对前提交按钮禁用；文件页 Home/ArrowDown 选择文件、
  切语言后仍停在文件页且所选文件保持、键盘返回概览；放弃确认模态两语言 Escape 关闭、
  焦点回到开启按钮、草稿逐字保留。
- **结果**：**124 条判据 0 失败**；全程零新 trace、零执行、`forking` 始终 idle、
  操作槽登记数不变；`settings.json` 与 `ui-preferences.json` 逐字节还原。
- **发现并修复**：语言保存期间三个单选被禁用会让焦点落到 `body`，保存完成后不恢复
  （键盘用户在设置中途丢失位置）。`LanguageSettings` 现在记住被禁用的当前项并在保存
  结束后归还焦点；实机确认焦点回到所选语言项且可见。
- **证据**：`.workbuddy/i18n-63/report-63-keyboard.json`、`shots/`（K1a/K1b/K2/K3/K4
  两语言截图）、运行器 `run-63-keyboard.cjs`。本地产物不随仓库交付。
- **未覆盖**：真实模型（本批未提交执行）、6.4 的未提交/在飞/未知/迟到竞态；
  Monaco 内部 EditContext 的可访问名称为库默认 “Editor content”（第三方控件），
  应用自有控件的名称已随语言切换。

## 6.4 未提交/在飞/迟到/竞态状态与未保存设置（D14—D18）— 已完成 2026-11-06

- **构建/环境**：源码基线 `00864e6`；真实 Electron dev（CDP **9630**，本日
  9123–9622 整段落入 Windows 排除端口段故换口）；数据根 `<仓库根>/.rebaseagent`；
  受控模型 mock（127.0.0.1:18799，剧本支持 `delayMs` 受控延迟，零费用）。
- **D14 偏好诚实性（专项 16 判据全过，`run-64-pref.cjs`，每用例独立重启应用）**：
  - 损坏偏好文件（截断 JSON）⇒ 按 system（zh-CN）启动、文件逐字节不被自动覆盖、
    设置里 `data-language-issue="corrupt"` 本地化提示；
  - 未知版本（`version:99,language:"en-US"`）⇒ 同样按 system 启动（不采纳未知版本的
    language 值）、不覆盖、`unknown_version` 本地化提示；
  - 保存失败（把 `ui-preferences.json` 换成同名目录构造真实写盘失败）⇒ `saveUiLanguage`
    返回 `failed`（不误报成功）、有效语言/单选/HTML lang 保持原值、`role=alert` 本地化
    失败提示（与 `settings.languageSaveFailed` 逐字一致）、目标路径仍是目录（main 未改写）；
  - 旧响应迟到（代次守卫）：同 tick 双保存 ⇒ 先发请求按 `stale` 丢弃、后发请求 `saved`、
    最终偏好/有效语言以后发为准、无失败误报；
  - 无 key 时切语言成功且不提交/不清运行配置（仍未配置）。
- **D15 草稿+未保存设置（P3）**：结果编辑器含空白草稿（前后空格+换行）+ 设置对话框
  内未保存的 baseURL 修改，对话框内切语言 ⇒ 未保存输入逐字保留、已保存配置未被提交、
  编辑器实例未重建（同 DOM 节点标记）、草稿正文/修订保持、可访问名称随新语言；
  脏关闭走放弃确认后设置仍为已保存值、草稿不受影响。
- **D16 确认清零（P4/P5）**：已勾执行确认 ⇒ 设置往返（含有效语言 en→zh 变化）后清零、
  核对文案回待核对、未重新核对前提交禁用、目标与草稿保持、`languageEpoch` 恰 +1、
  零模型调用、操作登记数不变；重新核对后提交可用。**同效语言不额外撤销**：store 级
  同值偏好保存（`saveUiLanguage` 同值）后确认保持、epoch 不变（P5 主查，store 级实机）。
- **D17 在飞/迟到（P6，受控延迟 6s）**：提交在飞中切语言 ⇒ 在飞身份
  （`operations.pending` 的 epoch+operationId，owner）不变、不重发（调用数恒 1）、
  不清冻结草稿/不推进修订、不抢导航（视图/所选 run/详情均不变）；迟到结果恰 1 条
  新 run、恰 1 次模型调用、按新语言（en）展示 Completed 与受控正文。
- **D18 提交与偏好保存竞态（P7）**：同 tick 发出提交与语言保存 ⇒ 已冻结载荷照常执行
  （恰 1 次调用、恰 1 条新 run）、偏好保存成功、结算后无错误；P8：P6/P7 两次重跑的
  模型请求逐字段一致（model/stream/messages/tools），locale 不进载荷。
- **回查**：调用计数全程恰 2 次（P6+P7，语言切换零新增）；owner = 在飞身份跨语言
  切换逐字段不变；草稿 = 在飞期冻结逐字保持、验证成功后按设计自动清理回基线原文
  （draftFrozenNote：可信身份核实到正常结束才清理）。P6 结算后如实记录：提交意图带
  导航，详情切到新 run（run_mw4iaxbe_awc3）；在飞期无抢导航。
- **结果**：主跑批 **60 判据 0 失败**（P1–P8 + 收尾安全检查）+ D14 专项 **16 判据
  0 失败**；新 trace 恰为两次受控提交（run_mw4iaxbe_awc3、run_mw4ib7jb_r1w4），
  无意外执行；`settings.json`、`ui-preferences.json` 逐字节还原。
- **关键发现（设计澄清，非缺陷）**：实机 UI 上语言偏好只能经设置对话框修改，而
  `setSettingsSection` 按 U5 4.4 设计「进设置即撤销待用执行确认（进出都算）」，强于
  D16 的有效语言规则（分步探针证实：仅打开对话框、epoch 不变即清零）。故 D16 的
  「同效语言不额外撤销」在实机 UI 路径被更强设计行为包含，只能 store 级验证（P5 主查）。
- **限制（如实登记）**：unknown 状态（通道失联/回执不可信）实机不可诚实触发——renderer
  与 main 同生命周期，杀 main 即关窗；该路径由入库测试（tasks 1.5、operations 分片
  测试）覆盖。R3 定向停止的 owner 绑定需 Docker engine（当前未运行，验证面板走不可用态），
  实机 owner 检查以 fork 在飞身份为准，R3 停止路径未做。P3/P7 的输入与提交用 DOM 级
  事件构造时序（非键击通道；键击通道已由 6.3 覆盖）。环境备注：本次曾误用带 BOM 的
  UTF-8 写偏好文件导致主进程按损坏回退（P1 首跑失败根因），已改无 BOM 重写后通过。
- **证据**：`.workbuddy/i18n-64/report-64.json`、`report-64-pref.json`、
  `shots/`（P3/P4/P6/P7 共 6 张）、`shots-pref/`（P1/P2/P3 共 3 张）、
  运行器 `run-64.cjs`、`run-64-pref.cjs`、诊断 `probe-64-confirm.cjs`。
  本地产物不随仓库交付。

## 6.5 指南同步与 M21 语境修正（D19/C01/M21/G06）— 已完成 2026-11-06

**证据类型：入库测试 + 源码/文档核对（无本地产物，全部随仓库交付）。**

- **M21 语境修正（入库测试）**：`packages/mcp-server/test/locale.test.ts`——
  两语言 `tools/list` 实测 `list_verifications.status` 的 schema 说明为
  `mcp.fieldVerificationRecordStatus` 的字面文案（zh 含 sealed/unterminated/corrupt/
  unsupported_version 四状态语境；en 同源），且与 `list_runs.status` 的运行结局说明
  **不相等**；既有全属性非空 description 与去 description 结构一致保证不变。
  实现：`packages/mcp-server/src/tool-metadata.ts` 新增 `TOOL_FIELD_DESCRIPTION_KEYS`
  按工具语境覆盖，`localizeInputSchema(schema, translator, toolName)` 由
  `server.ts` 发布时传入工具名；资源键 zh/en 于
  `packages/i18n/src/resources/{zh-CN,en-US}.ts`。
  执行：`vitest run test/locale.test.ts test/locale-errors.test.ts test/locale-budget.test.ts`
  ⇒ **3 文件 12/12 通过**（i18n 重建后 dist CLI 实测）；i18n 包全量 37/37 通过；
  `check:i18n` 通过（14 namespace / 144 归属文件 / 英文候选全部已审查）。
- **指南同步（源码核对，D19/C01 的文档面）**：
  - `docs/guide/mcp-readonly-diagnostics.md` + `.en.md`：新增 §2a「服务语言」——
    优先级 `--locale` > `REBASEAGENT_LOCALE` > 系统 > `en-US`、客户端 `env` 配置示例、
    初始化前校验（`INVALID_LOCALE`/退出 2）、每进程固定/重启换语言/`STALE_CURSOR`、
    zh 变体归一；新增「原文边界」段（历史正文/验证 `detail`/日志/产物保持原样，
    错误码/字段/枚举/协议版本/annotations 不变，64 KiB 预算按译文重算）；
    §7 信任声明注明随服务语言切换（zh 指南对应 `--locale zh-CN`、en 指南对应
    `--locale en-US`，事实与边界不变）。信任声明两语言等价性由
    `locale.test.ts` 的 `trustInstructions` 断言覆盖。
  - 根 `README.md` + `README.en.md`：CLI 节补 `--locale`/`REBASEAGENT_LOCALE`
    说明与「JSON 机器输出（字段/值/退出码/原始 detail）与历史记录正文不变」边界，
    链接 MCP 指南 §2a。
  - `packages/trace-test/README.md`：CLI 节补 `--locale` 优先级与
    `--report json` 字段/值/原始 detail/退出码不受语言影响（C03/C04 口径）。
- **边界**：未扩翻任何历史材料（历史报告/实验记录未动）；指南措辞与 design §2/§6.1/§6.2
  逐条对照，未宣称超出已测范围的语言能力。
- **环境限制（如实登记）**：本机 `mcp-server` 全量测试中 `stdio-protocol` /
  `stdio-lifecycle` 两个文件在 `cleanupStdioFixtures` 的 `rmSync` 处报 `ENOTEMPTY`
  （Windows 临时目录清理）；经 stash 基线对照确认**与本任务改动无关**（基线同样失败，
  两文件全部测试断言本身通过），归 6.6 全仓门禁复核。
