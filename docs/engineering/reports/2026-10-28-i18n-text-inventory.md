# 软件 i18n 文案盘点报告

日期：2026-10-28  
基线：本地 HEAD `f1c132a`（v0.7.0-rc.2 文档收口后）  
状态：**只读盘点，供软件 i18n OpenSpec 提案使用；不是实施批准，本轮不改代码、不建 change。**  
范围：`apps/desktop/src` 与 `packages/*/src` 中的中文字符串；不含 `docs/`、测试夹具、脚本、`dist/`、打包产物与运行数据。

## 1. 结论摘要

- **约 3,600 处出现、3,100 条去重中文字符串**；其中渲染端 2,252 处 / 1,927 条，占全部出现次数的 63%。
- 渲染端几乎全部面向用户：直接 UI 角色（文本、属性、标签、提示）约 1,522 处，其余 `return` / `call_arg` / `prop` 多数是运行时拼装的 UI 片段；真正内部日志仅 1 处。**翻译主体不只是按钮，还包括 `lib/` 里的标签表与消息构造函数（715 处，占渲染端 32%）。**
- 主进程 147 处、共享层 79 处：以错误说明和展示标签为主。主进程错误类普遍携带稳定 `code`，但渲染端当前直接显示 `message`，并自行拼接中文前缀。
- 包层 1,125 处：`replay` 352、`project-verification` 261（其中 4 条来自生成资产，应排除）、`mcp-server` 163、`run-query` 123、`trace-sdk` 114、`trace-test` 80、`agent-loop` 17、`llm-proxy` 15。
- 文本形状：**1,060 处含插值**、274 处包含中文量词（个/条/次/步/轮…）、95 条重复出现 ≥3 次、1,176 条含英文标识（产品名、字段名、工具名）；14 条超过 120 字符，其中 4 条是内嵌 runner 脚本（生成资产）。
- 测试影响面：366 个测试文件、1,780 条含中文字符串的断言；**至少 1,138 条直接引用渲染端文案**，247 条引用主进程/共享层/包消息，约 395 条无法自动归属（抽样显示其中仍有插值后的 UI 文案）。测试环境为 `node` + `renderToStaticMarkup`，**无 jsdom、无 testing-library、无快照**。
- 当前项目**没有任何 i18n 依赖，也没有 locale 文件**。
- 三个边界面仍是中文，需提案决定是否纳入本阶段：MCP 十三工具的描述与错误文案、CLI（`trace-test`）输出、原生目录选择对话框。

## 2. 方法与口径

- 使用 TypeScript 5.9.3 AST 解析源码，扫描 373 个源文件；**注释不计入翻译量**，`.d.ts` 不计。
- 计数单位：字符串字面量与无插值模板各计 1；带插值模板计 1；JSX 文本按文本节点计；`index.html` / CSS 单独统计。
- 角色分类规则（按最近祖先节点判定）：
  - `ui_text`：JSX 文本、三元分支、JSX 表达式中的可见文本；
  - `ui_attr`：JSX 属性（`title` / `aria-label` / `placeholder` / `label` 等）；
  - `ui_prop`：对象属性中的展示字段（`label` / `message` / `reason` / `text` 等）；
  - `error_message`：`fail(...)`、`throw`、`new XxxError(...)` 的参数；
  - `return` / `call_arg` / `prop` / `array_item` / `concat`：按上下文归类，其中渲染端多为 UI 片段；
  - `internal_log`：`console.*`，不在翻译范围。
- 工作区归属按文件名近似映射（组件名与 `lib/` 前缀），**不是逐文件人工确认**；包层不强行拆分到工作区，只给分层与近似矩阵。
- 测试归属：断言字符串先做精确匹配，再做去 HTML 标签后的包含匹配；归入 `ui` / `domain` / 未归属三类。**这是启发式结果，不能当验收判据**。
- 未覆盖：`docs/`、`fixtures/`、`scripts/`、`dist/`、运行数据、打包后的 `mcp/`；生成资产单列标注。

## 3. 总量与分布

### 3.1 分层

| 层 | 出现次数 | 去重 | 文件数 |
|---|---:|---:|---:|
| renderer | 2,252 | 1,927 | 107 |
| main | 147 | 134 | 20 |
| shared | 79 | 78 | 6 |
| preload | 0 | 0 | 0 |
| pkg:replay | 352 | 322 | 32 |
| pkg:project-verification | 261 | 218 | 30 |
| pkg:mcp-server | 163 | 148 | 24 |
| pkg:run-query | 123 | 110 | 13 |
| pkg:trace-sdk | 114 | 113 | 12 |
| pkg:trace-test | 80 | 73 | 10 |
| pkg:agent-loop | 17 | 17 | 5 |
| pkg:llm-proxy | 15 | 13 | 3 |
| **合计** | **3,603** | **3,105** | — |

另有含中文注释 4,274 条（renderer 2,095、main 442、shared 241、preload 23、packages 1,473），不在翻译范围。`project-verification` 的 261 条中有 4 条来自 `src/trusted-env/node-ts-v1-assets.generated.ts`（内嵌 runner 脚本，最长 4,593 字符），实施时应排除。

### 3.2 渲染端目录与角色

| 目录 | 出现次数 | 说明 |
|---|---:|---|
| `components/` | 1,473 | 视图与工作区组件 |
| `lib/` | 715 | 标签表、消息构造函数、派生视图 |
| `store/` | 53 | 状态层拼接的用户提示 |
| `App.tsx` 等外壳 | 11 | 全局导航 |

渲染端角色分布（出现次数）：`ui_text` 964、`ui_prop` 347、`ui_attr` 204、`return` 378、`prop` 128、`call_arg` 86、`array_item` 79、`constant` 23、`other` 22、`concat` 7、`error_message` 6、`ui_message` 5、`ui_constant` 2、`internal_log` 1。

判断：`return` / `call_arg` / `prop` 中的渲染端字符串绝大多数会进入可见文本（例如 `App.tsx` 的导航提示、`BranchTree.tsx` 的空态与说明），因此**渲染端 2,252 处基本都应视为 UI 文案候选**。

### 3.3 渲染端工作区（近似）

| 工作区 | 出现次数 | 去重 | 文件数 |
|---|---:|---:|---:|
| 通用外壳/组件 | 432 | 392 | 32 |
| 比较工作区 | 406 | 369 | 16 |
| 运行总览/详情 | 376 | 329 | 17 |
| 重跑/分叉 | 261 | 231 | 13 |
| 项目验证 | 257 | 220 | 3 |
| 文件工作区 | 154 | 144 | 8 |
| 模型实验 | 127 | 118 | 7 |
| 录制接入 | 80 | 75 | 4 |
| 创建运行 | 73 | 71 | 4 |
| 辅助/导出 | 45 | 42 | 2 |
| 设置 | 41 | 39 | 1 |

### 3.4 主进程工作区（近似）

| 工作区 | 出现次数 | 去重 | 文件数 |
|---|---:|---:|---:|
| 操作/草稿 | 46 | 46 | 5 |
| 隔离执行/实验 | 24 | 17 | 2 |
| 运行创建/读取/分叉 | 23 | 21 | 3 |
| 项目验证 | 19 | 19 | 3 |
| 外壳/其他 | 16 | 16 | 3 |
| 录制代理 | 12 | 12 | 1 |
| 设置/配置 | 5 | 5 | 2 |
| 比较 | 2 | 2 | 1 |

### 3.5 文本形状

| 维度 | 数量 | 含义 |
|---|---:|---|
| 字符串字面量 | 1,871 | 静态文案 |
| 模板字符串 | 1,060 | 含插值，英文需参数化与语序处理 |
| JSX 文本节点 | 671 | 富文本片段，不能整段字符串化 |
| 长度 ≤10 / 11–30 / 31–60 / 61–120 / >120 | 1,391 / 1,323 / 751 / 124 / 14 | 短标签为主，长文少 |
| 含中文量词 | 274 | 英文无对应量词，需 plural/单位规则 |
| 重复 ≥3 次 | 95 条 | 术语表与共用文案的收益点 |
| 含英文标识 | 1,176 | 产品名、字段名、工具名须原样保留 |

高频重复串示例：`未知`（9）、`尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置`（8）、`新建运行`（7）、`附件`（7）、`实验组`（6）、`返回来源`（6）、`未记录`（6）、`初始检查点`（6）、`返回`（5）、`原值` / `新值`（各 5）、`本页 ${…} 条，尚有 ${…} 条`（5）。

注意：**相同中文串不一定能复用同一个英文键**（例如“返回”在不同语境可能是 Back / Return），共用词表用于统一术语，不用于盲目去重。

## 4. 工作区 × 层近似矩阵

包层字符串不能精确拆到工作区，下表只给迁移规划的数量级参考（出现次数上界，非去重）。

| 工作区 | renderer | 关联主进程/包 | 备注 |
|---|---:|---|---|
| 创建运行 | 73 | main 运行创建/读取/分叉 23；replay 创建/导入路径 | 首次使用入口 |
| 运行总览/详情 | 376 | main 23；run-query 123；shared 79（跨工作区） | 核心阅读路径 |
| 重跑/分叉 | 261 | replay 352；trace-sdk 114；main 23 | 产品核心价值 |
| 模型实验 | 127 | main 隔离执行/实验 24；replay 实验路径 | 依赖重跑语义 |
| 比较工作区 | 406 | run-query 123；main 比较 2 | 文本量第二 |
| 文件工作区 | 154 | replay 文件工具/读取 | 与检查点语义绑定 |
| 项目验证 | 257 | project-verification 261；main 19 | 文本量第一的单工作区 |
| 录制接入 | 80 | main 录制代理 12；llm-proxy 15 | 配置类文案 |
| 设置 | 41 | main 设置/配置 5 | 配置类文案 |
| 通用外壳/组件 | 432 | shared 79；main 外壳/操作/草稿 62 | 跨工作区共用 |
| MCP（独立面） | — | mcp-server 163 | 边界待定 |
| CLI（独立面） | — | trace-test 80；run-query 123 | 边界待定 |

## 5. 测试影响面

- 366 个测试文件全部含中文；其中桌面 225 个、包层 141 个。
- 1,780 条断言参数中含中文字符串：桌面 1,475 条、包层 305 条。
- 匹配器分布：`toContain` 1,460、`toBe` 308、`toEqual` 12。**绝大多数是对渲染后的 HTML/文本做包含断言。**
- 归属：直接引用渲染端文案 1,138 条；引用主进程/共享层/包消息 247 条；无法自动归属 395 条（抽样中仍有 `aria-label="返回来源"`、`本 run 增量 2 步` 这类插值或富文本文案）。
- 测试环境：47 个文件使用 `renderToStaticMarkup`；`@testing-library` 引用 0；快照 0；Vitest `environment: "node"`。
- 中文测试标题 6,361 条；标题不属于迁移目标。

**对提案的硬约束：**

1. 翻译层必须能在**无 DOM、同步、静态渲染**下工作；不能依赖异步加载 locale 或浏览器 API。
2. 迁移一个工作区前，需要先建立稳定钩子（`data-testid` / 稳定 `aria-label` / 语义角色）或让测试显式传入 locale，否则每次改文案都会连带改大量断言。
3. 领域错误断言应从“匹配中文 message”改为“匹配稳定 code”；否则主进程本地化后会再次全面红。
4. 至少 1,138 条 UI 断言会受影响，必须按工作区分批迁移，不能一次性替换。

## 6. 稳定标识与错误路径

不翻译的稳定标识：

- **IPC 通道 39 个**（`apps/desktop/src/shared/channels.ts`）。
- **MCP 工具名 13 个**（`list_runs` / `get_run` / `get_step` / `compare_runs` / `inspect_checkpoint` / `read_checkpoint_file` / `compare_checkpoint_files` / `list_verifications` / `get_verification` / `read_verification_log` / `inspect_verification_artifacts` / `read_verification_artifact` / `compare_verifications`）。
- **错误码**：包层 45 个 `fail("...")` 小写码；主进程 24 个大写端点码；另有 `ISOLATED_PROMPT_ERROR_CODES` 15 个、`CompareSideFailureCode` 6 个、MCP `ToolErrorCode` 15 个，以及验证产物/物化错误枚举。
- **错误类**：`CreateRunError`、`ForkError`、`ProxyForkError`、`VerificationEndpointError`、`RunSourceRejection` 携带 `code`；`OperationRegistryInvariantError`、`RequestCanonicalError` 属内部不变量错误，不面向用户。
- 工具名、路径、协议字段、trace 版本、稳定 `code` 一律保持原值。

当前展示路径的问题：

- 渲染端直接读取 `envelope.error.message` 并拼接中文前缀，例如 `刷新 run 列表失败（仍显示上次结果）：${message}`（`store/slices/runs.ts:162-163`）、`父本详情数据结构校验失败：${...}`（`store/slices/navigation.ts:452`）、验证工作区多处 `verificationXxxError`。
- 共享层 79 条中包含 UI 展示标签（如 `改 tool_result`、`改 messages`），它们不在 renderer，但会显示在界面上。
- 因此**只翻渲染端或只翻服务层都会出现中英混排**；提案必须定义“服务层返回 code + 参数，渲染端负责本地化”的边界，或明确主进程如何获知 locale。

## 7. 边界与待决问题（交提案）

1. **MCP**：13 个工具描述与 15 条 `TOOL_ERROR_MESSAGES` 均为中文，外部客户端可见；163 条字符串是否纳入本阶段？
2. **CLI**：`trace-test` 的 `console.log/error` 输出为中文（80 条）；英文用户跑 CI 会看到中文。是否纳入？
3. **原生对话框**：`main/index.ts:192-194` 的数据目录选择对话框 2 条中文，是否纳入（属于桌面 UI）？
4. **验证日志/产物**：`project-verification` 的消息会写入运行记录与日志；旧记录按决策不翻译，新记录是否随 locale 生成？
5. **生成资产**：`node-ts-v1-assets.generated.ts` 的 4 条内嵌脚本字符串（含 4,593 字符）不是 UI，建议排除；但其运行输出可能出现在验证日志中，需确认展示口径。
6. **共享层标签**：79 条中的展示标签必须与 UI 同批翻译，不能留在中文。
7. **插值/语序/复数**：1,060 条插值、274 条量词；英文需要参数化消息与 plural 规则，不能沿用字符串拼接。
8. **富文本片段**：671 个 JSX 文本节点与内联 `<code>` / `<span>` 混排，需按片段建键，不能整段抽取。
9. **术语表**：沿用讨论稿 §7 的 Run / Step / Turn / Fork / Branch / Replay / Rerun / 轮末口径，并补入高频重复串中的产品词。
10. **默认语言、检测、持久化、切换与授权状态**：决策记录已列为提案内容，本盘点不预设。
11. **日期/数字格式**：`lib/format.ts` 已使用英文单位（`ms` / `s` / `k` / `B` / `KB`）与固定格式 `MM-DD HH:mm:ss`，未使用 `Intl`；英文侧风险较低，但需决定是否改为 locale-aware。
12. **历史数据**：用户输入、模型输出、既有 trace、文件正文不翻译（决策记录已定）。

## 8. 建议迁移批次（供提案参考，未批准）

按“完整工作区闭环”切分，每批包含 UI、对应主进程/共享层消息、测试同步与布局验收。数字为出现次数上界，不是工期。

| 批次 | 内容 | 估算出现次数 |
|---|---|---:|
| 0 | i18n 机制、locale 文件结构、术语表、测试助手与稳定钩子、CI 校验；**不迁移业务文案** | — |
| 1 | 通用外壳（432）+ 创建运行（73）+ 运行总览/详情（376）+ 重跑/分叉（261）；含 main `run` 相关 23、replay 352、trace-sdk 114、shared 79 | 约 1,700 |
| 2 | 项目验证（257）+ 比较（406）+ 文件（154）；含 project-verification 261、run-query 123、main 21 | 约 1,220 |
| 3 | 模型实验（127）+ 录制（80）+ 设置（41）+ 辅助/导出（45）；含 main 41、llm-proxy 15 | 约 349 |
| 4（条件） | MCP 163 + CLI 80，取决于第 7 节边界决定 | 约 243 |

说明：

- 通用外壳跨所有工作区，必须在第 1 批先建立统一词汇（按钮、确认、错误、空态），否则后续批次会重复造词。
- 第 1 批覆盖“首次使用 + 核心调试路径”，与决策记录的阶段目标一致；但它也是最大的一批，可按“创建运行 → 总览/详情 → 重跑/分叉”再拆三个 PR。
- 第 2 批两个大工作区（项目验证、比较）可各拆一个 PR；项目验证的文本量集中在 `VerificationPanel.tsx`（192 处）。
- 每批开始前先把该批的测试断言换成稳定钩子或 code 断言；否则翻译与测试改造会互相覆盖。

## 9. 复跑与数据

- 盘点脚本：`scripts/i18n-inventory.cjs`（只读，AST 解析，不写仓库文件）。
- 复跑：`node scripts/i18n-inventory.cjs`，输出 JSON 到 `.tmp/i18n-inventory.json`（`.tmp/` 已 gitignore）。
- 脚本输出包含：分层/工作区/角色汇总、Top 文件与高频串、逐文件统计、测试断言归属样例。

**局限**：工作区映射按文件名近似；包层不能精确拆到工作区；测试归属是启发式；字符串出现次数不等于翻译键数量（一条插值串可能拆成多条 ICU 消息）；不含构建产物与运行数据。

## 附录 A：文本量前 20 文件

| 出现 | 去重 | 文件 |
|---:|---:|---|
| 192 | 167 | `apps/desktop/src/renderer/src/components/VerificationPanel.tsx` |
| 111 | 97 | `apps/desktop/src/renderer/src/components/CompareWorkspaceView.tsx` |
| 102 | 90 | `apps/desktop/src/renderer/src/lib/execution-confirmation.ts` |
| 81 | 75 | `apps/desktop/src/renderer/src/components/workspace-file/FileContent.tsx` |
| 71 | 63 | `apps/desktop/src/renderer/src/components/OverviewPanel.tsx` |
| 68 | 62 | `apps/desktop/src/renderer/src/components/ModelAbEditor.tsx` |
| 67 | 61 | `apps/desktop/src/renderer/src/components/BranchTree.tsx` |
| 59 | 57 | `apps/desktop/src/renderer/src/lib/verification-entry.ts` |
| 58 | 57 | `apps/desktop/src/renderer/src/components/detail/PromptForkEditor.tsx` |
| 51 | 48 | `apps/desktop/src/renderer/src/components/RecordingWorkspaceView.tsx` |
| 50 | 50 | `apps/desktop/src/renderer/src/lib/compare-metrics.ts` |
| 49 | 48 | `apps/desktop/src/renderer/src/components/CreateRunWorkspace.tsx` |
| 48 | 47 | `apps/desktop/src/renderer/src/components/detail/ResultForkEditor.tsx` |
| 47 | 47 | `apps/desktop/src/renderer/src/lib/verification-compare.ts` |
| 46 | 40 | `apps/desktop/src/renderer/src/components/CompareFileWorkspace.tsx` |
| 46 | 41 | `apps/desktop/src/renderer/src/components/RunList.tsx` |
| 44 | 42 | `apps/desktop/src/renderer/src/lib/operation-result-view.ts` |
| 41 | 39 | `apps/desktop/src/renderer/src/components/SettingsDialog.tsx` |
| 41 | 41 | `apps/desktop/src/renderer/src/lib/isolated-prompt-card.ts` |
| 40 | 39 | `apps/desktop/src/renderer/src/components/detail/LlmCallDetail.tsx` |

## 附录 B：高频重复串（≥4 次）

| 次数 | 字符串 |
|---:|---|
| 9 | 未知 |
| 8 | 尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置 |
| 7 | 新建运行 |
| 7 | ；容器收尾未确认（登记保留，交启动核查） |
| 7 | 附件 |
| 6 | 实验组 |
| 6 | 返回来源 |
| 6 | 未记录 |
| 6 | 初始检查点 |
| 6 | 未保留（原状态未知） |
| 5 | 返回 |
| 5 | 左侧 |
| 5 | 原值 |
| 5 | 新值 |
| 5 | 首条 user message |
| 5 | 收起 |
| 5 | 尚未配置运行参数（baseURL / apiKey / model），请先点击右上角“运行配置” |
| 5 | 本页 ${…} 条，尚有 ${…} 条 |
| 5 | 记录 |
| 4 | 右侧 |
