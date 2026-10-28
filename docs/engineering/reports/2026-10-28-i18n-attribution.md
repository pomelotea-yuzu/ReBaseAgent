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

## 9. 局限

- 工作区与批次按文件名近似，包层不能精确拆到单个工作区；迁移时以实际入口为准修正。
- 符号路径是审查定位辅助，重构改名后需重跑生成器；它不是运行时契约。
- 英文候选扫描只覆盖 desktop 三层 ASCII-only 文本，不覆盖中英混排字符串中的英文片段；批次测试与人工复核仍是覆盖判据。
- 出现次数不是键数；一条插值/富文本消息可能拆成多个键，也可能与他处共用键。
- 不替代任务 0.5 的 `check:i18n` 门禁；本表先建立机器清单和边界断言，门禁接入在 0.5 完成。
