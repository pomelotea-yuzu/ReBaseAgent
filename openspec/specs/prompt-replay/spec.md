# prompt-replay Specification

## Purpose
定义 v2 的 prompt 分叉行为：从已完成的 SDK / agent-loop run 读取首次 LLM 请求中的启动上下文，一次修改 system prompt 或首条 user message，从头真实执行一个带父级溯源的新 run。prompt fork 是显式的新实验，不是共享父前缀的同源 replay。

## Requirements

### Requirement: 启动上下文从首次 LLM 请求确定性派生

系统 SHALL 只从直接父 run 自身的首次 llm.call.request.messages 读取可编辑启动上下文。system prompt 为其中第一条 role=system 且 content 为字符串的消息；初始用户指令为其中第一条 role=user 且 content 为字符串的消息。系统 SHALL 深拷贝 messages 后替换目标，SHALL NOT 修改父记录。

#### Scenario: 编辑 system prompt

- **WHEN** 父 run 首次 llm.call 含字符串 system 消息，用户提交不同的新内容
- **THEN** 派生 messages 仅该消息的 content 变化，其余消息逐字段一致，父 run 内容不变

#### Scenario: 编辑首条 user message

- **WHEN** 父 run 首次 llm.call 含多条 user 消息
- **THEN** 只允许编辑第一条 role=user 且 content 为字符串的消息，不需要消息索引元数据

#### Scenario: 缺少 system 消息

- **WHEN** 父 run 首次 llm.call 不含字符串形式的 system 消息
- **THEN** system prompt 与 user message 两种 prompt fork 均被明确拒绝；系统不从 config_hash 反推、不从桌面设置猜测、也不凭空假定空字符串

### Requirement: 一次分叉只修改一个变量

prompt fork 的 edit.field SHALL 且仅 SHALL 为 system_prompt 或 user_message，单次请求 SHALL 只携带其中一个字段与一个字符串新值。编辑前后原始字符串相同 SHALL 作为空 fork 拒绝，不 trim 或补默认内容。普通 prompt 的组合实验 SHALL 通过连续 fork 表达；首版隔离 prompt SHALL 只接受根基线，不支持在隔离分支上叠加编辑。隔离模型/参数实验 SHALL 继续拒绝。

#### Scenario: 同时修改两个字段
- **WHEN** 请求试图同时修改 system prompt 与 user message
- **THEN** 系统在创建文件和调用模型前拒绝，并提示一次分叉只允许修改一个变量

#### Scenario: 连续 prompt fork
- **WHEN** 先从普通 A 修改 system prompt 得到 B，再从 B 修改首条 user message 得到 C
- **THEN** C 的 parent 为 B，启动上下文取自 B 自身首次 llm.call，B 与 A 文件均不改变

#### Scenario: 隔离编辑保留空串和空白的真实变化
- **WHEN** 用户把原非空启动指令改为空串或只改变尾随空白，或提交与原值逐字相同的内容
- **THEN** 前两者作为实际字符串变化核对与执行，后者前置拒绝；非目标消息不变，不静默 trim 或合并其他编辑

### Requirement: prompt fork 从头真实执行并独立记录完整轨迹

校验通过后，系统 SHALL 从 agent.step 1 开始真实调用模型并执行新 run，所有新 spans SHALL 完整写入新文件。新 run 的 parent SHALL 指向直接父 run；fork.at_span SHALL 为直接父 run 的首次 llm.call id；fork.edit SHALL 记录单项编辑。父 run 只作溯源，不作为新 run 的共享轨迹前缀。

#### Scenario: 从头重跑

- **WHEN** 用户确认一项合法 prompt 编辑
- **THEN** 系统提示“将真实调用模型并计费”，新 run 从第 1 步执行并记录完整 spans，不承诺命中父 run 的 prompt cache

#### Scenario: prompt fork 不拼接父轨迹

- **WHEN** 打开一个 prompt fork 的详情
- **THEN** 详情只呈现新 run 自身的完整 spans，同时单独展示父级 chain；不得经 resolveBranch 拼入父 run 的旧 spans

### Requirement: system prompt 的配置指纹与实际请求一致

system prompt fork SHALL 使用同一个编辑值同时更新本次 RunConfig.systemPrompt 与启动 messages 中的 system content。新 run 的 config_hash SHALL 由该值与原工具表计算，首次 llm.call.request.messages 中 SHALL 出现完全相同的 system content。

#### Scenario: 双真相源保持一致

- **WHEN** system prompt 从 A 修改为 B 后运行
- **THEN** 新 run 的 config_hash 按 B 计算，首次真实 LLM 请求中的 system content 也为 B，不得出现指纹输入与实际请求不一致

### Requirement: prompt fork 的可用父本与失败原子性

直接父 run SHALL 已封存、含 config_hash、首次 LLM 请求含字符串 system 消息。普通 promptReplayRun SHALL 继续拒绝任何 workspace 父本，不能丢弃隔离元数据后执行普通 handler。隔离 prompt SHALL 只能经独立隔离编排、在根基线与初始快照完整验证后执行。

非隔离 proxy run 在具备 config_hash 时 SHALL 与普通引擎 run 同等允许；缺少 config_hash 的 proxy run SHALL 依 no_system/invalid_tool/未知原因给出既有重新录制/修正工具/messages 重发提示。字符串 system 是重建配置的唯一来源，不能从 hash 或桌面设置猜测。所有业务前置校验 SHALL 在创建子记录和调用模型前完成；前置失败零子记录、零调用，允许 main 按既有规则保留 rejected 操作登记。

#### Scenario: proxy run 拒绝
- **WHEN** 用户对 source.kind=proxy 但缺 config_hash 的 run 发起 prompt fork
- **THEN** 在文件和模型调用前拒绝，并按 no_system/invalid_tool/未知三类给出原有可操作提示

#### Scenario: 含 config_hash 的 proxy run 放行
- **WHEN** 非隔离 proxy run 已封存、含 config_hash 且首次请求有字符串 system
- **THEN** prompt fork 正常从头执行，parent 指向代理 run，同时保留独立代理重发入口

#### Scenario: 父 run 未封存
- **WHEN** 父 run 缺终止事件
- **THEN** 拒绝分叉，不创建文件、不调用模型

#### Scenario: 隔离父本不能转普通 prompt fork
- **WHEN** 带 workspace 的 v2/v3 run 经普通 promptReplayRun 包 API 发起 prompt fork
- **THEN** 明确拒绝隔离执行降级，不加载普通文件 handler、不创建子 run、不发 LLM 请求

### Requirement: 启动上下文编排可观察真实运行身份

普通 promptReplayRun SHALL 保留可选 onRunIdentified，覆盖已支持的 system_prompt/user_message/model_params；新增隔离 prompt 编排 SHALL 提供同一身份观察纪律。最终 run.meta 实际写出后、首次 LLM 前 SHALL 恰一次通知真实 ID；前置拒绝 SHALL 不通知身份。普通/隔离各自父本、配置和空编辑门禁保持。省略或抛错的观察者 SHALL 不改变执行结局或阻止收尾，真实 trace 写错误 SHALL 传播。

#### Scenario: prompt 身份在后续失败时仍可关联
- **WHEN** 合法普通 prompt/model_params 或隔离 prompt 调用写出 meta 后模型失败或编排抛错
- **THEN** 调用方已取得与实际记录一致的 ID，回调恰一次，不解析异常取身份，不修改父轨迹

#### Scenario: prompt 前置拒绝不报告假身份
- **WHEN** 普通路径拒绝 workspace，或各路径因缺父链、不可还原输入、空编辑、配置漂移，或隔离路径因非根/坏初始附件拒绝
- **THEN** 不调用身份回调，零模型调用且不创建子记录；隔离 model_params 继续拒绝

#### Scenario: prompt 观察者兼容且释放
- **WHEN** 省略回调或回调抛错后执行结束
- **THEN** 原执行、请求次数和文件语义保持，订阅随收尾释放，观察者不成为新增失败原因

### Requirement: 隔离 prompt 预检配对根启动输入与初始文件

系统 SHALL 提供只读预检，只接受已封存、完整来源、固定 file-tools-v1 的隔离根，配对该根自有第 1 步首次 llm.call 的完整启动消息与 initial_snapshot。首版 SHALL 至少有字符串 system/user，全部消息须可无损作为受支持启动输入，SHALL 拒绝历史 assistant/tool、多模态和不支持的执行字段。工具定义及原 system 的 config_hash SHALL 与录制一致，清单/配额及全部初始附件 SHALL 可验证。预检无文件写入、子身份、operation、槽或模型/工具副作用，正式提交 SHALL 重验。

#### Scenario: 合法根预检只读且提交重验
- **WHEN** 请求 ID 与 meta.id 匹配且根消息、profile、config_hash、初始清单与附件完整，取得计划后在提交前改变其中一项
- **THEN** 首次预检仅返回配对条件；正式提交因漂移拒绝，零子记录/调用，不能把旧计划当执行许可

#### Scenario: 中途分支只能显式返回根
- **WHEN** 从 result 分支或 v3 实验分支请求隔离 prompt，或来源缺父/成环
- **THEN** 非根拒绝，完整链可给出 rootId 供显式导航；缺链不猜根，不自动换目标/搬草稿/执行

#### Scenario: 缺失或不可还原的启动条件拒绝
- **WHEN** 请求 ID 与 meta.id 不符、根缺首次请求/system/user、含多模态或历史工具消息、profile/hash 不符、初始清单或附件缺失/损坏或有真实 I/O 错误
- **THEN** 返回可区分原因及重新采集提示，零子记录/模型/工具调用，不用当前源目录、父最终状态或设置补造事实

### Requirement: 隔离 prompt 固定可恢复配置并从头真实执行

新隔离 prompt SHALL 固定根 request.model 和可无损恢复的 params，SHALL NOT 使用 settings.model 覆盖或静默过滤不支持参数。已记录 token budget SHALL 复用，缺省预算/未记录的迭代上限才使用 main 既有限制并标历史未知；不接受的已知预算明确拒绝，不静默换值。当前 provider/凭据及执行限制由 main 核对并冻结。确认 SHALL 绑定基线、编辑、有效配置计划及 main 配置修订；凭据/输入/来源变化须重新确认。

通过预检和当前 allowFileWrites:true 后，系统 SHALL 从根 initial_snapshot 建新 world，仅使用固定隔离工具，从第 1 步独立执行并记录 v3 完整轨迹。父 spans 与已执行消息不复用，首次文件读取 SHALL 来自初始快照。模型错误按既有 llm.call.error/errored 收尾；存储错误仅保留实际落盘事实，不伪造成功或删除共享内容。

#### Scenario: 单项改动与首次实际请求一致
- **WHEN** 修改 system 或首条 user 后执行，桌面当前默认模型与根记录模型不同
- **THEN** 仅目标 content 改变，其他启动字段保持，实际使用根模型/原 params，已知 token budget 保持，system/config_hash 与实际请求一致；第 1 步读取根初始文件，父最终文件及当前源目录变化均不影响起点

#### Scenario: 不支持参数或配置漂移不能静默放行
- **WHEN** 根 params 有无法恢复的结构化项/保留键、已知预算不被当前策略接受，或确认后端点、凭据修订、执行限制或编辑改变
- **THEN** 前置拒绝并要求重新核对或重新采集，零子记录/调用，不丢参数、不偷偷换模型或沿用旧确认

#### Scenario: 历史未知条件与真实计费分别表达
- **WHEN** 历史 provider/执行限制未记录，价格/usage/缓存也未知
- **THEN** 提交前显示本次实际配置与历史未知项及真实计费边界，结果未知保持未知，不承诺缓存、严格因果或零费用

#### Scenario: 当前写入授权和失败事实不可替代
- **WHEN** 父有 write_authorized 但当前未授权，或合法执行后模型/存储失败
- **THEN** 未授权零子记录/调用；执行后按实际身份保留独立轨迹与已落盘检查点，父/兄弟/源目录不变，存储故障不补假终止或清理共享 blob
