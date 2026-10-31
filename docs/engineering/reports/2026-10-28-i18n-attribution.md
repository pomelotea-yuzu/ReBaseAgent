# 软件 i18n 候选文案归属表

日期：2026-10-28。状态：**只读盘点与归属，不是实施批准**。对应 change `add-software-i18n` 任务 0.1，验收口径 S07/S11/G03。

机器清单：[i18n/attribution.json](../../../i18n/attribution.json)（逐文件、逐符号）。英文候选：[i18n/english-product-candidates.json](../../../i18n/english-product-candidates.json)。生成器：[scripts/i18n-attribution.cjs](../../../scripts/i18n-attribution.cjs)。

## 1. 方法

- TypeScript AST 扫描 `apps/desktop/src` 与 `packages/*/src` 的 TS/TSX；统计字符串字面量、无插值模板、带插值模板与 JSX 文本，注释不计，`.d.ts` 不计。
- 每条候选记录文件、层、工作区、符号路径、角色（`ui_text`/`ui_attr`/`ui_prop`/`error_message`/`return` 等）、行号与分类。
- 分类只有四类，互斥：
  - **product**：产品展示，需要按批次迁移为双语资源；
  - **original**：原文、模型输入、持久化记录、导出/JSON 报告正文，不随 UI locale 改写；
  - **internal**：内部诊断、console 日志、存储/不变量错误，不面向用户；
  - **generated**：生成资产，不作为产品文案。
- 分类是审查辅助，不是运行时判据。文件级规则与理由在生成器的 `fileRule` 与理由表中维护；后续批次可修正分类，但必须保留理由。
- 与盘点报告同口径：`node scripts/i18n-attribution.cjs --compare-inventory` 校验分层计数；差异只允许盘点把 `index.css` 的中文注释汇总为 1 条记录。

## 2. 总量

| 分类 | 出现次数 | 含义 |
|---|---:|---|
| product | 3,172 | 迁移候选；不表示最终键数 |
| original | 378 | 模型输入、记录/导出/报告原文、第三方/协议正文 |
| internal | 48 | console 与内部不变量 |
| generated | 4 | 生成 runner 资产 |
| **合计** | **3,602** | 与盘点 3,603 相差 1 条：盘点的 CSS 汇总记录（中文均为注释） |

按层：

| 层 | 文件 | 出现 | product | original | internal | generated |
|---|---:|---:|---:|---:|---:|---:|
| renderer | 106 | 2,251 | 2,250 | 0 | 1 | 0 |
| main | 20 | 147 | 147 | 0 | 0 | 0 |
| shared | 6 | 79 | 79 | 0 | 0 | 0 |
| preload | 0 | 0 | 0 | 0 | 0 | 0 |
| pkg:replay | 32 | 352 | 302 | 32 | 18 | 0 |
| pkg:project-verification | 30 | 261 | 61 | 168 | 28 | 4 |
| pkg:mcp-server | 24 | 163 | 163 | 0 | 0 | 0 |
| pkg:run-query | 13 | 123 | 123 | 0 | 0 | 0 |
| pkg:trace-sdk | 12 | 114 | 0 | 114 | 0 | 0 |
| pkg:trace-test | 10 | 80 | 42 | 38 | 0 | 0 |
| pkg:agent-loop | 5 | 17 | 2 | 14 | 1 | 0 |
| pkg:llm-proxy | 3 | 15 | 3 | 12 | 0 | 0 |

产品候选按迁移批次（批次定义见 design §8）：

| 批次 | product 出现 |
|---|---:|
| 1 | 1,626 |
| 2 | 979 |
| 3 | 329 |
| 4 | 238 |

数字包含批次 1–3 的关联包层产品解释，因此不等于盘点报告的 renderer 1,142 / 817 / 293；差值来自包层与 main/shared。

## 3. 排除项核实

### 3.1 生成资产

- `packages/project-verification/src/trusted-env/node-ts-v1-assets.generated.ts`：4 条内嵌 runner/supervisor 脚本，整文件 `generated`，不计入翻译。
- 该文件的运行输出可能进入验证日志；展示侧只翻外围说明，日志正文按 original 保留。`--verify-boundaries` 固定断言该项为 4 条生成字符串。

### 3.2 模型上下文与工具声明

| 文件 | 出现 | 理由 |
|---|---:|---|
| `packages/replay/src/workspace/file-tools.ts` | 24 | 隔离文件工具的 description/parameters，直接进入模型上下文 |
| `packages/replay/src/tool-unwrap.ts` | 2 | 父录工具声明解析事实，属于模型工具定义 |
| `packages/agent-loop/src/llm-client.ts`、`diagnostic.ts`、`run-loop.ts`、`tool-registry.ts` | 14 | 模型/工具错误与工具结果事实，写入 trace 或工具结果 |
| `packages/llm-proxy/src/handler.ts`、`diagnostic.ts` | 12 | 录制代理对外 HTTP 响应与上游错误原文 |
| `packages/trace-sdk/src/*` | 114 | trace schema、读取、版本守卫、快照与分支校验事实 |
| `packages/trace-test/src/assertions.ts`、`shape-align.ts`、`cassette-llm-client.ts`、`format.ts` | 38 | 进入 `--report json` 的原始 detail |
| `packages/project-verification/src/*`（除 5 个产品文件） | 168 | 验证记录/runner/日志正文，持久化事实 |

这些文件的产品解释将通过稳定 code/参数在展示端投影，不改写原文；`--verify-boundaries` 对上述关键文件断言 product 为 0。

### 3.3 内部诊断

- 48 条 internal：`project-verification` 的 main 启动残留核查/容器登记/受信环境（27）、`replay` 的附件存储/隔离世界/检查点 tracer 与 console（18）、`agent-loop` 与 renderer 的 console（各 1）、`project-verification` 的 docker CLI 包装（1）。
- console 只在非 CLI 文件计 internal；`trace-test`、`model-ab-cli`、MCP 启动的 stdout/stderr 属产品输出，计 product。

### 3.4 CSS 与 HTML

- `apps/desktop/src/renderer/src/index.css` 的 15 行中文均为注释，不计候选；`index.html` 当前无中文。
- 因此归属表比盘点总数少 1 条汇总记录。

## 4. 全部现有 CLI

| bin | 包 | 源码候选 | 结论 |
|---|---|---:|---|
| `rebaseagent-mcp` | `packages/mcp-server` | 163 product | 十三工具描述、信任声明、受控错误与内容摘要全部计入批次 4 |
| `rebaseagent-trace-test` | `packages/trace-test` | 80：42 product / 38 original | 人类帮助/错误/摘要计 product；JSON 报告 detail 保持 original |
| `rebaseagent-model-ab` | `packages/replay` | 33 product | 模型实验 CLI 单独归入批次 4（任务 5.7） |

非产品 CLI：`packages/project-verification/src/docker/cli.ts` 是 Docker 子进程包装，1 条 internal；`scripts/*`、`apps/desktop/scripts/*` 是开发/发布脚本，不在软件产品面。`--verify-boundaries` 断言三个 bin 所在包均有产品候选，且 `model-ab-cli.ts` 归入批次 4。

## 5. 英文硬编码产品文本审查方法

正则不能证明覆盖；本表只用于发现候选，最终以逐条人工复核与批次测试为准。

1. 扫描 desktop 三层的 ASCII-only 字符串/JSX 文本，按最近祖先判定 UI 角色；
2. 过滤 `className`/CSS 工具类、路径/URL/ID、协议字段与技术值；
3. 对剩余项逐条判定：产品文案、产品文案片段（随所在句迁移）、技术标识（不翻译）；
4. 每个迁移批次复核本批文件，新增英文硬编码进入同批测试；收口时归属表与 `check:i18n`（任务 0.5）共同拦截未归属产品文本。

本次共 15 条候选，逐条结论：

| 文件 | 候选 | 结论 |
|---|---|---|
| `components/detail/DetailShared.tsx` | `· miss` | 片段，随所在元信息标签迁移（批次 1） |
| `components/detail/PromptForkEditor.tsx` | `system prompt` | 产品标签，翻译（批次 1） |
| `components/detail/PromptForkEditor.tsx` | `user message` | 产品标签，翻译（批次 1） |
| `components/RecordingWorkspaceView.tsx` | `upstream base_url` | 产品说明 + 技术标识；保留 `base_url`（批次 3） |
| `components/VerificationPanel.tsx` | `」· run` | 片段，随验证摘要迁移（批次 2） |
| `components/VerificationPanel.tsx` | `· snapshot` | 片段，随验证摘要迁移（批次 2） |
| `components/workspace-file/FileContent.tsx` | `· sha256` | 技术标识，不翻译（批次 2 复核） |
| `components/workspace-file/WorkspaceFileViewBody.tsx` | `· profile` | 技术标识，不翻译（批次 2 复核） |
| `lib/draft-list.ts` | `prompt · user` | 草稿类型标签，翻译/重排（批次 1） |
| `lib/draft-submission.ts` | `|create` | 复合键分隔符，技术值，不翻译 |
| `lib/execution-confirmation.ts` | `System Prompt` | 产品标签，翻译（批次 1） |
| `lib/prompt-experiment-view.ts` | `system prompt` | 产品标签，翻译（批次 3） |
| `lib/verification-compare.ts` | `cap drop all` | 产品标签，翻译（批次 2） |
| `lib/verification-compare.ts` | `supervisor PID 1` | `PID` 保留，外围说明翻译（批次 2） |
| `main/operation-request.ts` | `(root)` | 技术父标识，不翻译 |

## 6. 机器核对与复跑

```powershell
node scripts/i18n-attribution.cjs --compare-inventory --verify-boundaries
```

通过时的关键输出：

```text
[i18n-attribution] files=261 occurrences=3602
[i18n-attribution] product=3172 original=378 internal=48 generated=4
[i18n-attribution] 边界核对通过：生成资产/模型输入/记录原文/内部诊断/全部 CLI/批次归属
[i18n-attribution] 与盘点报告分层计数一致（renderer 扣除 CSS 汇总记录 1 条）
```

`--verify-boundaries` 的断言包括：生成资产整文件排除且恰 4 条；模型工具声明与 trace/记录/报告原文的关键文件 product 为 0；三个 bin 包均有产品候选；`model-ab-cli.ts` 属批次 4；所有产品文件有批次，所有排除项有理由。

## 7. 1.x 增量（2026-10-28）

1.3 把全局 store 错误改为稳定 code/受控描述（文案内容未变，符号路径变化）；1.6 把关闭确认与原生目录对话框的默认中文从 main 迁入 i18n 资源，并把语言偏好存储/IPC 的安全拒绝归为 internal。当前机器清单为 **3,586 处**（product 3,154 / original 378 / internal 50 / generated 4）；0.1 的 3,602 是迁移前快照，差异来自这 16 处默认文案迁入资源与 2 处内部拒绝改类。

## 8. 2.1–2.2 增量（2026-10-28）

2.1 迁移外壳导航、通用按钮/模态、活动/空态与 shared 导航标签（App、GlobalBar、SessionActivity、ConfirmDialog、ConfirmationBlock、Disclosure、WorkspaceHeading、ResizeGrip、LongText、RunWorkspace 空态、shared/nav），并把四处确属内部诊断的 renderer 文件改为 internal：`main.tsx`（启动断言）、`lib/a11y-action.ts`（开发期审计）、`lib/navigation-intent.ts`（内部判定理由）、`lib/format.ts`（`reasonLabel` 无产品消费点）。当前机器清单 **3,504 处**（product 3,049 / original 378 / internal 73 / generated 4）；相对 1.x 的 3,586：82 处产品文案迁入资源，23 处由 product 改判 internal（总数不变）。批次 1 仍有 98 个 pending 文件。

2.2 继续迁移执行确认构造器（创建/result/prompt/messages/A-B）、操作行/结果/通知/等待计时、详情完整性长文与结局标签投影；机器清单更新为 **3,282 处**（product 2,827 / original 378 / internal 73 / generated 4）。2.2 内 2.2a 降 98、2.2b 降 124。共享 Zod/操作登记校验提示仍留 4.5，操作面板内的草稿列表留 4.4。

2.3 迁移创建运行闭环（创建页、模式/校验/源目录/副本授权、返回目的地、门禁提示），并把 `main/run-create.ts`、`main/run-source-gate.ts` 的原始失败说明改判 original（渲染层显示为“原始详情”，产品摘要按稳定码本地化）。机器清单 **3,206 处**（product 2,744 / original 385 / internal 73 / generated 4）：2.3 迁入资源 76 处、改判 original 7 处。批次 1 余 87 个 pending 文件。

2.4 迁移运行列表（搜索/筛选/指标/刷新重试/空态/复制）、状态徽章、工作区页签与页头、隔离来源说明、分叉边标签，以及总览（结局/错误/结果/消耗/缓存/来源/prompt 实验）和预算地图；`overview-view` 迁移后只剩安全渲染审计说明，改判 internal。机器清单 **2,989 处**（product 2,524 / original 385 / internal 76 / generated 4）：2.4 迁入资源 217 处、改判 internal 3 处。批次 1 余 77 个 pending 文件。

2.5 迁移步骤目录与分支树（节点/边标签、范围/搜索/模式、选中详情与缺父占位）、树行与分支边的按语言投影、缓存命中措辞，以及 step/LLM/tool 详情（概要、请求/响应、思维链、失败占位、入参与结果）、详情提示区与原文区外围；`cache-view` 移除结论文案只留 tone/异常判据，`branch-relations` 的缺父原因改为稳定类别由展示层翻译。机器清单 **2,759 处**（product 2,294 / original 385 / internal 76 / generated 4）：2.5 迁入资源 230 处。批次 1 余 64 个 pending 文件。

2.6a 迁移 result 编辑共享层与 ResultForkEditor 主体：`draft-source` 的恢复重验原因全部接 translator（result/prompt/messages/A-B 四个编辑器同源），`DraftSourceBanner` 的阻断说明与两个动作、`DraftCompareGrid` 的默认标签与收起/恢复入口，以及 result 编辑器的入口/隔离续跑说明、轮末起点与预检事实、副本授权、两份核对确认、放弃/冻结/失败摘要与按钮全部迁移；工具结果文本（`ResultForkEditor.toolMessageText` / `draft-source.toolResultText`）按符号改判 original——它是写入新 trace 并作为模型消息重新送入的正文，不随 UI locale 生成。机器清单 **2,682 处**（product 2,215 / original 387 / internal 76 / generated 4）：迁入资源 77 处、改判 original 2 处。批次 1 余 63 个 pending 文件。

2.6c 归属收口：`execution-confirmation` 的 `decideConfirmation` 原因改判 internal（界面只消费 confirmed/missing/stale，不显示原因）；`result-verification` 的读取核对诊断改判 original（按原始详情展示）；`fork-runner` 与 `exec-endpoints` 的 fork 通道分叉失败原文改判 original（渲染层已给本地化摘要 + 稳定码 + 原始说明）。机器清单 **2,682 处**（product 2,187 / original 410 / internal 81 / generated 4）；收口门禁 `--final` 仍红 152 个 pending 文件（批次 1 余 61）。2.6 完成。

2.7 迁移普通/隔离 prompt 单项编辑：`prompt-fork` 与 `isolated-prompt` 的本地拦截/根定位原因接 translator；`isolated-prompt-card` 的核对卡（根/初始文件/消息/工具/参数/预算/未知项/计费/计划指纹/副本）与提交判据全部按语言投影；`PromptForkEditor`（入口、字段、假设/判据、隔离核对与费用/副本确认、普通确认、放弃/冻结、失败原文）与 `IsolatedPromptEntry`（根/分支导航）全量迁移。replay 的 prompt/preflight/run/state 五个文件与 main 的隔离 prompt 能力预检说明改判 original（原始诊断，产品摘要由渲染层给出）。机器清单 **2,565 处**（product 1,987 / original 493 / internal 81 / generated 4）：迁入资源 117 处、改判 original 83 处。收口门禁 `--final` 仍红 141 个 pending 文件（批次 1 余 50）。2.7 完成。

2.8 迁移代理 messages 编辑/授权/结果与未知核实：`messages-eligibility` 的五类原因接 translator；`MessagesForkEditor`（入口、代理核对、草稿放弃/冻结、重发失败摘要+原始说明、重发确认与录制入口、底部动作）、`MessagesWorkspace`（未绑定/读取中/读取失败/目标缺失、框架标题与来源标签）、`MessagesResults`（标题/计数/空态/动作提示/返回编辑/结果说明）全量迁移；main `ProxyManager.fork` 的凭据/配置漂移原文改判 original（渲染层已给本地化摘要）。机器清单 **2,508 处**（product 1,919 / original 504 / internal 81 / generated 4）：迁入资源 57 处、改判 original 11 处。收口门禁 `--final` 仍红 137 个 pending 文件（批次 1 余 46）。2.8 完成。

3.1 迁移验证入口/环境/准备/测试计划及不可用原因：`verification-entry` 的目标标签、三类不可用原因（引擎/来源/未准备）、限额行、两份确认披露（准备/执行）全部接 translator；确认判定改为 locale 无关的稳定原因码（`not_armed`/`target_changed`/`plan_unknown`/`plan_changed`/`command_changed`），展示层按码取文案，store 提交门只消费码。`VerificationPanel` 迁移入口/展开头、条件表（精确输入/已准备环境/本机后端/计划 token/profile/准备计划）、核对异常与重试、不可用原因、两份确认块与提交按钮/禁用说明、提交失败摘要+原始说明；5.2–5.5 的停止/记录/日志/比较/导出区域留待 3.2/3.3。main 三个验证端点文件（可用性门、执行端点、只读端点）的原始诊断与包层 `prepare/plan.ts`（网络范围/许可随计划 token 冻结）、`source/precheck.ts`（来源预检原因作为不可用原因参数）改判 original。D16 补接线：`revokeVerificationConfirmations` 此前只有定义无调用，现随有效语言变化清零两份未提交验证许可，保留显式目标/只读核对且零新增 IPC。机器清单 **2,408 处**（product 1,791 / original 532 / internal 81 / generated 4）：迁入资源 100 处、改判 original 28 处。收口门禁 `--final` 仍红 132 个 pending 文件（批次 1 余 46；3.1 后 `VerificationPanel`/`verification-entry` 仍余 143/8 处，属 3.2/3.3）。3.1 完成。

3.2 迁移验证在飞/定向停止/结局/未知/记录与日志外围：`verification-reading` 的状态行（封存/未封存/坏尾行号/版本不支持）与 `verification-entry` 的登记记录摘要（类型/状态/未知回落）接 translator；`VerificationPanel` 迁移在飞提示（准备不可中断/执行可定向停止）、停止按钮与幂等说明、main 停止说明的原文标注、停止失败码、操作状态未知、登记记录区、记录阅读（事件数/阶段/结局/证据完整性/命令双口径字节/读流入口）、日志切片（身份/加载中/稳定码+附件损坏缺失/分页续读/截断与完整日志边界）、D04 结局三层与验证身份。包层 `records/reader.ts`、`records/assets-view.ts` 的读取与附件诊断改判 original（作为稳定码之外的原始详情）。机器清单 **2,330 处**（product 1,666 / original 579 / internal 81 / generated 4）：迁入资源 78 处、改判 original 47 处。收口门禁 `--final` 仍红 128 个 pending 文件（批次 1 余 46；`VerificationPanel` 余 79 处属 3.3 比较与导出）。3.2 完成。

3.3 迁移验证比较、代码关联与所测输入导出：`verification-compare` 的条件行（profile/manifest/计划绑定/命令/argv/cwd/平台/镜像/工具链/限额/隔离基线）、干预措辞、六类结论与限制说明全部接 translator；`VerificationPanel` 迁移 A/B 选择（来源行/自比禁用）、判定横幅、差异/未知项、逐侧摘要（状态/快照/干预/结局/证据/退出码/日志双口径）、代码差异入口与条件行，以及导出区（绑定/空目录/未封存阻断）与导出反馈（在飞/取消/失败+残留/成功快照一致+补丁+回查+“文件导出≠测试通过”）。包层五个 `export-*` 文件的写入/定位诊断改判 original（稳定码之外的原始详情）。机器清单 **2,204 处**（product 1,504 / original 615 / internal 81 / generated 4）：迁入资源 126 处、改判 original 36 处。收口门禁 `--final` 仍红 121 个 pending 文件（批次 1 余 46；3.3 后验证面板与比较/导出均已产品归零）。3.3 完成。

3.4 迁移运行比较的选择/指标/派生标签与逐侧失败：`compare-metrics` 的空态/数量提示、共同祖先三态、全部行标签与口径解释、缓存/累计/祖先增量说明接 translator；`CompareSelectionBar`（选择栏/chips 移出/进入详细或指标/清空）、`CompareMetricsTable`（标题/挑选条/列头动作/不可读标签/重试）迁移；`CompareWorkspaceView` 全量迁移（标题与列名、diff 门禁与模式、交换/返回/文件/指标入口、逐侧输出缺型、失败定位、步骤目录折叠摘要与来源归属、编辑证据三态/逐跳链/不同根、模型实验比较与副作用说明）；`CompareWorkspace` 容器（指标表模式、详细模式、挑选拒绝、读取/重试、不可读侧与关系受限）。main `compare-endpoints` 的请求/读取失败、`compare-state` 的载荷/错配诊断与 run-query 三个 compare-facts 文件的领域原因改判 original（带稳定码，渲染层给本地化摘要/标签、原文作详情）。机器清单 **1,991 处**（product 1,241 / original 665 / internal 81 / generated 4）：迁入资源 213 处、改判 original 50 处。收口门禁 `--final` 仍红 111 个 pending 文件（批次 1 余 46；比较工作区余 3.5 的文件视图与 4.4 的草稿列表）。3.4 完成。

3.5 迁移比较文件视图：`compare-files` 的单侧文件入口判据（不可读/非隔离/失效步骤原因与定位说明）、`compare-file-view` 的默认解析/失效不改点原因、清单引用状态（仅左/仅右/引用同异，内容待核验）、逐侧正文状态（文本/二进制/缺失/损坏/超限/IO/快照变化/不可用）接 translator（库保留无 translator 时的中文默认，非展示消费者只判 kind）；`CompareFileWorkspace` 迁移标题/两侧目标/检查点选择与默认注记、文件隔离标记、打开与导出入口（固定本次比较检查点）、清单加载/错误/并集不完整、路径并集与引用状态、正文核验、逐侧回退与导出提示。文件名/路径/sha256/字节数保持原值。机器清单 **1,924 处**（product 1,174 / original 665 / internal 81 / generated 4）：迁入资源 67 处。收口门禁 `--final` 仍红 108 个 pending 文件（批次 1 余 46；比较工作区产品文案归零，余 4.4 草稿列表与 3.6 文件工作区）。3.5 完成。

3.6 迁移单运行文件工作区：`workspace-files` 的检查点标签/来源说明/变更与可用性标签/清单规模/可比较性原因、`file-directory` 空态、`file-layout` 并排宽度不足原因、`file-tools` 的未消费剪贴板辅助删除；`FileContent` 迁移加载/失败/拒绝/不存在、两侧状态行、复制菜单与反馈、换行/查找/差异导航/模式、二进制与不可读卡、单侧只读展示与两侧缺席说明；`WorkspaceFileViewBody` 迁移检查点选择与来源/只读说明、失效回退、目录开关与搜索/筛选/计数、清单加载与错误、文件列表与空态、拖拽分隔条；`WorkspaceFilesPanel` 迁移专注差异入口/退出/加载态；导出不可用原因迁移。文件名/路径/sha256/字节数/差异条数保持原值。机器清单 **1,770 处**（product 1,020 / original 665 / internal 81 / generated 4）：迁入资源 153 处、删除死代码 1 处。收口门禁 `--final` 仍红 100 个 pending 文件（批次 1 余 46；3.x 完成，余项为 4.4 草稿列表与后续 MCP/CLI）。3.6 完成，**3.x 全部完成**。

4.1 迁移模型实验工作区：`model-ab` 的 params 解析与提交前拦截改为稳定原因码（非法 JSON/非对象/保留键/非标量/非有限数；配置/臂数/副作用/空 fork），`modelAbGuard`、`experimentArmSelectabilityOf`、`experimentCompareHintOf` 按 translator 派生文案（组件按 `code`/`detail` 呈现，测试按码与结构断言），`prompt-experiment-view` 的字段标签、params 缺省与结局说明接 translator（总览页调用同步）。`ModelAbEditor` 迁移入口与提示、臂卡与基线对照、计划预览（生效 params、覆盖/新增/继承、丢弃父录值、告警与绕行）、副作用与费用确认、计划过期两种措辞、失败摘要+原始说明、冻结/放弃/预览状态与按钮标题；`AbBatchResult` 迁移逐臂身份、请求层结局、动作提示与对照选择；`ExperimentResults` 迁移批次身份、空态、进入比较与结果说明；`ExperimentWorkspace` 迁移目标未绑定/父本读取失败与重试/目标调用缺失/框架标题与目标行。D16 沿用既有接线：有效语言变化清空 A/B 执行确认，编辑器同时撤销副作用勾选，只读计划与草稿修订保留。内核 `model-replay-run.ts` 与 main `modelAbChannel.run` 的校验/执行失败原文改判 original（渲染层按稳定码给摘要、原文作详情；CLI 人类报告留 5.7）。机器清单 **1,643 处**（product 875 / original 683 / internal 81 / generated 4）：迁入资源 127 处、改判 original 18 处。收口门禁 `--final` 仍红 92 个 pending 文件（批次 1 余 46；模型实验工作区产品文案归零）。4.1 完成。

4.2 迁移录制代理配置/接入说明、状态/错误与凭据边界：`recording-draft` 的端口/upstream 校验改稳定码（`RecordingFieldError`，store 只认码，视图按 translator 派生），`proxy-recovery-view` 接 translator 并把失败拆成**本地化摘要（按 PORT_UNAVAILABLE/LISTEN_FAILED/UNKNOWN 投影）+ 原始诊断**；`recordingStatusLines` 同样接 translator，诊断行按「摘要 → 原始诊断」分层。`RecordingWorkspaceView` 迁移配置区（启用意图/端口/上游/应用与字段错误）、真实状态区（意图/监听/恢复原因/凭据、只读重读、恢复中与失败处置、停止边界）、接入地址区（仅已核实监听可复制、复制零请求说明、不可用原因）与代理记录区；应用失败改为「稳定码摘要 + 原始说明 + 保存≠监听后果」。`RecordingWorkspace` 迁移框架标题/描述、初始化入口与放弃确认（含端口/upstream/启用意图原文）。store 增 `recordingApplyErrorCode`（信封稳定码；成功即清）。`packages/llm-proxy/src/server.ts`（监听启动失败/内部错误原文）与 main `classifyRecoveryFailure.message`（脱敏限长诊断）改判 original。机器清单 **1,563 处**（product 791 / original 687 / internal 81 / generated 4）：迁入资源 80 处、改判 original 4 处。收口门禁 `--final` 仍红 86 个 pending 文件（批次 1 余 46；录制工作区产品文案归零）。4.2 完成。

4.3 迁移模型/代理设置校验、加密降级/清除与语言入口：`SettingsDialog` 迁移未保存关闭确认、跳转录制前确认、保存/回读失败反馈（本地化摘要 + 原始说明）、清除确认与成功/失败、明文降级与 safeStorage 提示、必填缺失提示、代理真实摘要与跳转入口及框架文案；新增 `LanguageSettings` 纯视图（跟随系统/简体中文/English、独立保存、保存中与失败提示、偏好文件损坏/未知版本的可关闭提示、切语言保留草稿/清未提交确认/不提交模型输入的帮助说明），接入设置对话框。store 的 settings/proxy 错误改为保留原始 detail，产品摘要由稳定码在展示层派生；main `settings.ts` 与 `config-endpoints.ts` 的诊断改判 original。机器清单 **1,514 处**（product 737 / original 692 / internal 81 / generated 4）：迁入资源 49 处、改判 original 5 处。收口门禁 `--final` 仍红 82 个 pending 文件（批次 1 余 45；设置工作区产品文案归零）。4.3 完成。

4.4 迁移辅助框架、草稿列表/关闭保护、导出与剩余跨页提示：`AuxWorkspaceFrame` 的返回来源与失效说明；`DraftListPanel` 的状态徽标、定位/复制/放弃动作；`draft-list` 的草稿种类/隔离实验标题/预览与调用旁徽章，关闭协商 dirty 计数显式接收 translator；`RunActionsBar` 实验入口与三类不可用原因；Monaco 加载/失败占位与就地重试、检查点缺省名。`WorkspaceExportPanel` 全量迁移（入口资格与原因、确认卡空目录/布局/未保留/源不动、四态反馈：在飞/取消/失败稳定码+原始说明+残留警示/成功数量与清单、补丁三态与未保留边界）。`compareNotice` 与定向停止提示改稳定码、由展示层投影；验证自比较错误按稳定码本地化；store 的诊断前缀改为原始 detail；`draft-closure` 与 `runs` 分片的内部结论改判 internal；main 导出端点的目标/来源/会话诊断改判 original。机器清单 **1,419 处**（product 584 / original 716 / internal 115 / generated 4）：迁入资源 60 处、改判 original 24 处、internal 8 处。收口门禁 `--final` 仍红 67 个 pending 文件（批次 1 余 35；渲染层剩余为 shared/main 跨层项）。4.4 完成。

4.5 跨层收口：比较页结局标签改用 `outcomeLabelOf(kind)`（不再直接显示 run-query 的中文 label）；模型实验的静默忽略告警按稳定键（`num_ctx` / `think`）投影双语说明，未知键回退内核原文。shared 的 Zod/契约校验提示（`ipc.ts`、`operations.ts`）、详情版本守卫、实验资格判据原因，main `exec-endpoints.ts`、`ipc.ts`，以及 agent-loop 配置校验、replay 回放/父本/预检/读取/配额/profile/静默忽略、run-query 只读查询、project-verification schema 的领域事实与诊断改判 original（渲染层按稳定码给摘要、原文作详情）；main `operation-registry.ts`、`operation-request.ts`、`operation-endpoints.ts`、`draft-close-attach.ts` 的内部不变量改判 internal。**桌面三层（main/renderer/shared）产品待迁移归零**：机器清单 **1,419 处**（product 238 / original 1,032 / internal 145 / generated 4），余 **31** 个 pending 全为批次 4（MCP 24 / trace-test 6 / model-ab CLI 1，属 5.x）。4.5 完成。

## 9. 局限

- 工作区与批次按文件名近似，包层不能精确拆到单个工作区；迁移时以实际入口为准修正。
- 符号路径是审查定位辅助，重构改名后需重跑生成器；它不是运行时契约。
- 英文候选扫描只覆盖 desktop 三层 ASCII-only 文本，不覆盖中英混排字符串中的英文片段；批次测试与人工复核仍是覆盖判据。
- 出现次数不是键数；一条插值/富文本消息可能拆成多个键，也可能与他处共用键。
- 不替代任务 0.5 的 `check:i18n` 门禁；本表先建立机器清单和边界断言，门禁接入在 0.5 完成。
