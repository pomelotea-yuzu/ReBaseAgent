# 软件 i18n 双语术语表

版本：1（2026-10-28 冻结）。对应 change `add-software-i18n` 任务 0.2，验收口径 D19/C01/M23。

适用范围：桌面 UI、原生对话框、MCP 十三工具元信息/受控错误、`trace-test` 与其余包层 CLI 的人类可读输出、`zh-CN` / `en-US` 资源。**代码标识、协议字段、工具名、错误码、`tool_result` / `llm.call` / `agent.step` / `tool.invoke`、`config_hash`、`parent`、`fork`、`snapshot_id`、`operationId` 等原值不翻译。**

用词依据：现有英文指南 [README.en.md](../README.en.md)、[getting-started.en.md](../docs/guide/getting-started.en.md)、[isolated-project-verification.en.md](../docs/guide/isolated-project-verification.en.md)、[mcp-readonly-diagnostics.en.md](../docs/guide/mcp-readonly-diagnostics.en.md)、[replay-state-consistency.en.md](../docs/architecture/replay-state-consistency.en.md) 与 design §7；中文业务口径以对应中文指南和主 spec 为准。

## 1. 时间旅行与运行

| 概念 | 中文 | English | 约束 |
|---|---|---|---|
| 运行记录 | 运行（run） | Run / run | 首字母大写用于标题/按钮；正文可用小写 run。中文不要写成“会话” |
| 步骤 | 步骤 | Step | 指轨迹中的一个 `agent.step` / 工具步骤；不用 Step 代替整轮 |
| 整轮 | 整轮 | Turn / whole turn | 隔离续跑的边界是**轮末**；不要用“轮次”指 step |
| 轮末 | 轮末 | End of turn | 与“初始检查点”相对；必须说明是文件实际起点 |
| 初始检查点 | 初始检查点 | Initial checkpoint | 隔离根的初始文件快照；不要写成“第一个 step” |
| 检查点 | 检查点 | Checkpoint | 文件快照的展示单位；`snapshot_id` 原值保留 |
| 快照 | 快照 | Snapshot | 内容寻址的文件清单/附件集合 |
| 工具结果 | 工具结果 | Tool result | 代码字段 `tool_result` 不翻译；正文可写 tool result |
| 轨迹 | 轨迹 | Trace | 代码/文件名 `trace`、`.jsonl` 原值保留；UI 可用“轨迹” |
| 分叉（动作/记录） | 分叉 | Fork | 动词/记录语义；`fork` 字段原值保留；不要暗示 Git |
| 分支（血缘对象） | 分支 | Branch | 运行血缘中的分支；与 Git branch 区分 |
| 分叉点 | 分叉点 | Fork point | 编辑/分叉定位处；不要写成“分支点” |
| 分支点 | 分支点 | Branch point | 执行/血缘分叉处；与 fork point 区分 |
| 父 run | 父 run | Parent run | 不用“父运行”混排；`parent` 字段原值保留 |
| 根 run | 根 run | Root run | 隔离根/实验基线 |
| 兄弟分支 | 兄弟分支 | Sibling branch | 同轮其他分支；不得被隔离续跑撤销 |
| 来源目录 | 源目录 | Source directory | 隔离运行导入的目录；不写“工作目录” |
| 附件 | 附件 | Attachment | 内容寻址的 blob；`sha256` 原值保留 |
| 内容寻址 | 内容寻址 | Content-addressed | 不译成“按内容存储”作为术语 |

## 2. 执行方式

| 概念 | 中文 | English | 约束 |
|---|---|---|---|
| 回放 | 回放 | Replay | 只读取/重放既有记录，不新增真实模型/工具调用；Replay orchestrator 保留 |
| 重跑 | 重跑 | Rerun | 会真实执行；必须按入口说明费用与外部副作用 |
| 普通重跑 | 普通重跑 | Normal rerun | 复用分叉前消息，分叉后真实调用 |
| 隔离续跑 | 隔离续跑 | Isolated continuation / isolated rerun | 从轮末文件快照副本继续；不撤销同轮写入 |
| prompt fork | prompt fork | prompt fork | 产品既有写法保留小写；改启动上下文后从头执行 |
| 模型 A/B | 模型 A/B | Model A/B | 从同一父 run 派生多个实验臂 |
| 实验臂 | 实验臂 | Arm | 一次实验中的一个模型/参数组合 |
| 隔离 prompt 实验 | 隔离 prompt 实验 | Isolated prompt experiment | v3 记录；只接受合法根基线 |
| 套件/卡带 | 卡带 | Cassette | Trace-as-Test 的录制结果；不译作“磁带” |
| Trace-as-Test | Trace-as-Test | Trace-as-Test | 产品名，不翻译 |
| 录制代理 | 录制代理 | Recording proxy | 本地 LLM 录制代理 |
| 录制接入 | 录制接入 | Recording access | 设置中的入口名；不写“代理设置” |
| 重发 messages | 重发 messages | Resend messages | 只重发一个模型请求，不执行外部工具 |
| 定向停止 | 定向停止 | Targeted stop | 只停止指定验证/工作负载；不是强制取消 |
| 在飞 | 在飞 | In flight | 已提交、尚未落定；不要写成“运行中”造成与 run 混淆 |
| 迟到结果 | 迟到结果 | Late result | 按原操作身份关联；不抢导航、不重发 |
| 零执行 | 零执行 / 无新增执行 | No new execution | 切语言等展示变化不得新增模型/工具/准备/测试/导出调用 |
| 执行槽 | 执行槽 | Execution slot | main 统一登记的唯一执行位置 |
| 操作身份 | 操作身份 | Operation identity | `operationId` / epoch 原值保留 |
| 配置修订 | 配置修订 | Configuration revision | 不是“配置版本号”；修订变化使旧确认失效 |
| 计划指纹 | 计划指纹 | Plan fingerprint | 计划 token/digest 原值保留 |

## 3. 授权、费用与状态

| 概念 | 中文 | English | 约束 |
|---|---|---|---|
| 费用确认 | 费用确认 | Cost confirmation | 必须说明按实际调用计费；默认不勾选 |
| 费用 | 费用 | Cost | 不译成“价格”；`maxCost` 等字段原值保留 |
| 计价未知 | 计价未知 | Billing unknown | 不补 0、不猜价格 |
| 价格未知 | 价格未知 | Unknown price | 与“计价未知”同义场景择一，不混用 |
| 外发 | 外发（数据） | Data sent to the provider | 说明哪些 prompt/工具参数会发给服务商；不弱化 |
| 副本写入 | 副本写入 | Copy writes | 隔离副本世界的写入授权；不是源目录授权 |
| 数据根 | 数据根 | Data root | `--data-dir` 原值保留；不写“数据目录”混用 |
| 未记录 | 未记录 | Not recorded | 不推断缺失原因 |
| 未保留（原状态未知） | 未保留（原状态未知） | Not preserved (original state unknown) | 导出清单中的状态标签 |
| 未知 | 未知 | Unknown | 不补 Passed/Cancelled/零消耗 |
| 核对操作状态 | 核对操作状态 | Check operation status | 不用 Retry/重试暗示再次提交 |
| 不支持 | 不支持 | Not supported | 说明具体边界；不用“暂不可用”模糊化 |
| 本版本不支持 | 本版本不支持 | Not supported in this release | 比“暂不支持”更准确；仍要说明原因 |
| 封存 | 封存 | Sealed | 终止事件写入后不可追加；不是“锁定” |
| 结局 | 结局 | Outcome | 验证结局；未知结局不等于失败/通过 |

## 4. 项目验证

| 概念 | 中文 | English | 约束 |
|---|---|---|---|
| 项目验证 | 项目验证 | Project verification | 不写“项目测试” |
| 环境准备 | 环境准备 | Environment preparation | 与执行分开授权、分开记录 |
| 可信测试 | 可信测试 | Trusted tests | 固定模板内的测试；与“受信环境”配套，不写成“受信测试” |
| 受信环境 | 受信环境 | Trusted environment | `node-ts-v1` 等模板 |
| 验证记录 | 验证记录 | Verification record | `verificationId` 原值保留 |
| 验证产物 | 产物 | Artifact | `artifact` 字段原值保留 |
| 证据完整性 | 证据完整性 | Evidence completeness | `evidenceComplete=false` 不得显示为完整通过 |
| 来源缺失 | 来源缺失 | Source missing | 不猜同名来源 |
| 附件缺失/损坏 | 附件缺失/损坏 | Attachment missing / corrupt | 不得回退为空文件或源目录 |
| 检查失败 | 检查失败 | Check failed | 与 `failed` 结局区分 |
| 漂移 | 漂移 | Drift | 配置/请求/快照漂移；不译成“偏移” |
| 所测输入 | 所测输入 | Tested input | 导出的是代码快照，不含日志/产物 |

## 5. 桌面与通用 UI

| 概念 | 中文 | English | 约束 |
|---|---|---|---|
| 工作区 | 工作区 | Workspace | 不用“页面”替代 |
| 草稿 | 草稿 | Draft | 会话内恢复；不等于已提交 |
| 预检 | 预检 | Preflight | 只读，不调用模型/不写文件 |
| 确认 | 确认 | Confirmation | 与“授权”区分：确认是本次提交条件 |
| 提交 | 提交 | Submit | 不是“保存” |
| 新建运行 | 新建运行 | New run | 入口按钮 |
| 运行总览 | 运行总览 | Run overview | 与“详情”区分 |
| 详情 | 详情 | Detail | step/LLM/tool 详情 |
| 比较 | 比较 | Compare | 不是 diff；diff 保留为技术词 |
| 文件工作区 | 文件工作区 | File workspace | 检查点/差异/查找 |
| 设置 | 设置 | Settings | 模型/代理配置 |
| 可访问名称 | 可访问名称 | Accessible name | `aria-label` 等；要翻译，但测试不得固定中文 |
| 原始详情 | 原始详情 | Raw detail | 记录/异常原文；与产品解释分开 |
| 产品解释 | 产品解释 | Product explanation | 由稳定 code/参数派生的本地化说明 |
| 稳定码 | 稳定码 | Stable code | 错误码原值；不得翻译 |
| 机器报告 | 机器报告 | Machine report | JSON/结构化输出；字段与值不变 |

## 6. MCP 与 CLI

| 概念 | 中文 | English | 约束 |
|---|---|---|---|
| 只读诊断 | 只读诊断 | Read-only diagnostics | MCP 服务定位 |
| 工具 | 工具 | Tool | `list_runs` 等工具名原值保留 |
| 信任声明 | 信任声明 | Trust statement | initialize/服务说明；不弱化数据边界 |
| 结构化内容 | 结构化内容 | Structured content | `structuredContent` 原值保留 |
| 内容投影 | 内容投影 | Content projection | `content` 文本投影；不冒充全文 |
| 分页 | 分页 | Pagination | 原文范围/游标绑定不变 |
| 游标 | 游标 | Cursor | 不透明值；换语言需重启后旧游标失效 |
| 基线 | 基线（baseline） | Baseline | trace-test 基线；`--update-baseline` 原值保留 |
| 断言 | 断言 | Assertion | 断言 detail 属机器报告原文 |
| 隐私提示 | 隐私提示 | Privacy notice | 说明 trace 可能含 prompt/响应/工具参数 |
| 受控错误 | 受控错误 | Controlled error | 只外发白名单 code/说明，不透传原始异常 |
| 人类报告 | 人类报告 | Human report | CLI 人类可读汇总；与 JSON 报告分开 |
| 机器契约 | 机器契约 | Machine contract | 字段、值、退出码不变 |
| 脱敏 | 脱敏 | Redaction | 尽力而为；不承诺覆盖任意业务文本 |
| 工具说明 | 工具说明 | Tool description | MCP 对外元信息可翻译；Agent 工具定义不因此修改 |
| schema 说明 | schema 说明 | Schema description | 只翻纯说明字段，不改 schema 结构 |
| 帮助 | 帮助 | Help | `--help` 输出 |
| 用法 | 用法 | Usage | 命令语法 |
| 参数错误 | 参数错误 | Invalid argument | 不翻译参数名 |

## 7. 不得翻译的原值

- 包名、可执行名、命令与参数：`@rebaseagent/*`、`rebaseagent-mcp`、`rebaseagent-trace-test`、`rebaseagent-model-ab`、`--data-dir`、`--locale`、`--report json`、`--update-baseline`。
- MCP 工具名与协议字段：`list_runs`、`get_run`、`structuredContent`、`isError`、`retryable`、`STALE_CURSOR`、`INVALID_ARGUMENT` 等。
- 稳定标识：全部错误码、`config_hash`、`snapshot_id`、`verificationId`、`operationId`、`trace`、`span`、`llm.call`、`agent.step`、`tool.invoke`、`tool_result`、`read_file`、`write_file`、`file-tools-v1`、`node-ts-v1`。
- 技术单位与格式：`ms` / `s` / `k` / `B` / `KB`、`MM-DD HH:mm:ss`、路径、ID、哈希、URL。
- 用户输入、模型输出、历史 trace/验证日志、文件正文、导出正文与补丁。

## 8. 变更规则

- 本表冻结的是**术语与边界**，不是最终译文；新增术语先补表再迁移。
- 同一中文在不同语义下可对应不同英文键（如“返回”可能是 Back / Return），但同一概念在同一语言内必须一致。
- 英文不得删减费用、外发、副本写入、未知、只读、平台限制等风险事实；中文也不得因英文短而省略限制。
- 与现有英文指南冲突时，先改指南或本表并记录原因，不能只改 UI 造成双口径。
