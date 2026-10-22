## MODIFIED Requirements

### Requirement: 格式带版本号

`run.meta` 行 SHALL 包含 format_version 整数字段。读取器 SHALL 支持 1、2、3：普通 writer 继续写 1，既有隔离根/result writer 继续写 2，本次隔离 prompt 实验写 3。v2/v3 SHALL 携带 workspace，v3 SHALL 满足独立初始快照实验契约。v1 SHALL NOT 携带 workspace、step 快照或整轮续跑字段；v1/v2 SHALL NOT 携带顶层 prompt_experiment 或 initial origin。新增字段存在性检查 SHALL 在 schema 剔除未知字段前进行，不递归检查业务正文同名键。读取器遇到更高版本 SHALL 明确报“不支持的格式版本”，不得静默降级；旧读取器 SHALL 拒绝超出其支持的版本。

#### Scenario: 未来版本文件
- **WHEN** 新读取器读取 format_version 为 4 的文件
- **THEN** 报错提示版本不支持，不产生部分解析结果

#### Scenario: 双版本与旧读取器
- **WHEN** 新读取器读取普通 v1 和合法隔离 v2 fixture，或旧 v1 读取器读取该 v2 fixture
- **THEN** 新读取器完整保留各自字段，普通 writer 仍产出 v1；旧读取器明确拒绝 v2

#### Scenario: 版本与隔离字段不匹配
- **WHEN** v1 带 workspace 或整轮续跑字段，或 v2/v3 缺 workspace、已完成 step 缺快照
- **THEN** 校验拒绝并指出字段问题，不把隔离状态按未知字段静默删除

#### Scenario: v1 禁字段与其他扩展区分
- **WHEN** v1 原始 meta 自有 workspace 或 fork.resume_after_step，或 span 自有 workspace_snapshot，字段值为 null/false/空对象；另有只包含不相关扩展字段或消息正文内同名业务字段的对照记录
- **THEN** 前者均在字段转换或剔除之前被拒绝，后者沿用既有兼容行为；不得用全对象 strict 或递归同名搜索误伤普通 v1 数据

#### Scenario: 三版本读取与写入职责分离
- **WHEN** 依次创建普通运行、隔离根、隔离 result 子运行和隔离 prompt 子运行，再用新旧读取器加载
- **THEN** writer 分别产出 1/2/2/3，新读取器保留全部合法字段，最高支持 v2 的旧读取器明确拒绝 v3；最高读取版本变化不改变既有 writer 或 v2 能力判据

#### Scenario: 新实验字段不能藏在旧版本中
- **WHEN** v1/v2 meta 顶层出现 prompt_experiment（含 null/空对象）或 workspace.origin.kind 为 initial
- **THEN** 在 schema strip 前拒绝；消息/工具正文中的同名业务字段沿用原兼容语义

## ADDED Requirements

### Requirement: 隔离 prompt 实验记录初始来源与有效配置

v3 meta SHALL 只表达本次隔离 prompt 从头实验，parent 指向经完整来源校验的隔离根，fork.at_span 指向该根自有首次 llm.call，edit.field 仅 system_prompt/user_message，SHALL NOT 含 resume_after_step。workspace SHALL 保留固定 profile、等于子 ID 的 world_id、审计 write_authorized、完整 initial_snapshot，origin SHALL 为 `{kind:"initial",run_id,snapshot_id}`，指向直接父及其初始快照。

prompt_experiment SHALL 记录 baseline_run_id、baseline_llm_span_id、initial_snapshot_id、原始字符串 original_value 和 execution（model、可选 params、去凭据 provider_endpoint、max_iterations、budget、config_fingerprint），可选 hypothesis/acceptance_criterion 各不超过 4000 字符。edit 保存新值。运行 ID、span ID 和快照 ID 的重复引用 SHALL 一致；完整来源读取 SHALL 验证父根身份、原值和初始快照对应，自有读取 SHALL 不因父缺失而伪造或删除这些字段。首次真实请求 SHALL 与记录的有效配置一致，config_hash SHALL 继续仅表示有效 system+工具。

schema、Tracer 事件、MemoryTracer、JSONL、reader、RunRecord/RunDetail IPC SHALL 往返保留记录。已完成 agent.step SHALL 仍携带轮末快照。正文只进入本地 trace/详情，列表、operation 元数据和诊断 SHALL 不携带正文、key、授权票据或源绝对路径。历史未知条件 SHALL 不补造。

#### Scenario: 初始来源与干预记录往返
- **WHEN** 一次合法 v3 实验经事件流、MemoryTracer/JSONL、reader 和详情 IPC 往返
- **THEN** 基线、初始清单、原值/新值、假设/判据、有效模型/参数/限制及指纹完整保留；实际首次请求与有效配置相符，子 world_id 等于实际子 ID

#### Scenario: 矛盾的实验来源拒绝
- **WHEN** v3 缺 prompt_experiment、携带 resume_after_step、edit 为 model_params，或 parent/origin/基线/快照/span 引用矛盾
- **THEN** 解析明确拒绝，不转成 v2 续跑或普通执行；父存在时完整来源校验也拒绝非根父或原值/初始快照不符

#### Scenario: 缺父或附件不阻止自有轨迹阅读
- **WHEN** v3 自有 JSONL 合法，但父文件或附件缺失
- **THEN** 合法自有轨迹和记录可读，来源按 ownOnly 或附件状态单列；执行和桌面导出仍依各自门禁拒绝，不从正文推造文件或来源
