## MODIFIED Requirements

### Requirement: 模型实验复用既有 prompt fork

系统 SHALL 在已封存且含 config_hash 的非隔离父 run 上创建模型实验；proxy 来源在满足指纹条件时 SHALL 与普通引擎 run 同等允许。每个 arm SHALL 通过 prompt fork 从头执行，直接 parent 相同，不建立第二套实验记录或把换模型伪装成 tool-result replay。空工具表父本 SHALL 允许实验，指纹按空表计算。首期带 workspace 的隔离父本 SHALL 在整批预检时拒绝，包括 dry-run 和显式 allowSideEffects，不能借此降级到普通 handler。

#### Scenario: 创建两个模型分支
- **WHEN** 用户从同一合法非隔离父 run 提交两个不同 model/params arm
- **THEN** 创建独立 fork run，edit.field=model_params，直接 parent 相同，既有分支树可展示

#### Scenario: 含 config_hash 的 proxy run 创建 A/B
- **WHEN** 已封存非隔离 proxy run 有 config_hash、字符串 system 且工具表为空
- **THEN** 每臂独立从头执行，config_hash 与父一致

#### Scenario: 拒绝不可 fork 父 run
- **WHEN** 父 run 未封存或缺 config_hash（含历史代理记录）
- **THEN** 在创建 tracer/文件/模型请求前拒绝；proxy 缺 hash 仍按 no_system/invalid_tool/未知给出重新录制、修正定义或重发提示

#### Scenario: 拒绝缺少 system 消息的父 run
- **WHEN** 首次请求不存在字符串 system 消息
- **THEN** 在任何文件写入和网络调用前拒绝，并说明启动上下文无法校验

#### Scenario: 带工具的代理父本沿用既有门禁
- **WHEN** 非隔离代理父本携带非空工具表
- **THEN** 未知桌面工具仍被拒绝；缺 sideEffect 仍按有副作用处理，未显式 allowSideEffects 前拒绝

#### Scenario: 隔离实验无降级逃生通道
- **WHEN** 父本带 workspace，无论 dry-run 或全部 arm 声明 allowSideEffects:true
- **THEN** 整批明确拒绝本期不支持隔离 A/B，零运行文件、零 LLM、零 handler 执行

### Requirement: 工具必须可执行且无副作用

每个 arm SHALL 传入与 config.tools 一一对应的 Tool[]。对非隔离父本，默认 SHALL 要求全部 sideEffect===false，缺标记按有副作用；不满足时在首个 run 前整批拒绝，不以卡带或桩冒充真实执行。非隔离父本保留显式 allowSideEffects 的既有授权路径；该授权 SHALL NOT 绕过隔离父本拒绝规则，也不承诺隔离外部文件、网络和数据库。

#### Scenario: pure 工具实验
- **WHEN** 非隔离工具表均明确 sideEffect:false 且 handler 一一对应
- **THEN** 每臂真实执行 handler，结果写入自己的 trace，比较继续

#### Scenario: 副作用工具阻断
- **WHEN** 非隔离工具表含 sideEffect:true 或缺标记，未显式 allowSideEffects
- **THEN** 返回不可执行错误并指出工具，不按 arm 顺序产生外部副作用

#### Scenario: 显式确认副作用后放行并留痕
- **WHEN** 非隔离父本的每个 arm 声明 allowSideEffects:true 且已确认费用
- **THEN** 仍按顺序真实执行，声明写入 fork.edit，UI 标注“顺序执行、外部状态可能已被前一臂改变”，比较判据不变

#### Scenario: CLI 遇到带工具的父 run
- **WHEN** CLI 对非空工具表父本发起实验
- **THEN** 返回配置错误，不以桩或空 handler 冒充真实结果；非隔离父本可提示改用桌面，隔离父本明确提示本期不支持隔离 A/B
