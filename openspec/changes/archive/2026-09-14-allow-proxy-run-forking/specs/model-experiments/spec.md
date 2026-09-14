# model-experiments Delta: 代理 run 作为模型 A/B 父本

## MODIFIED Requirements

### Requirement: 模型实验复用既有 prompt fork

系统 SHALL 在已封存且含 `config_hash` 的父 run 上创建模型实验；proxy 来源的 run 在具备 `config_hash` 时 SHALL 与引擎 run 同等允许。每个 arm SHALL 通过既有 prompt fork 的从头重跑语义生成独立 run，直接 parent SHALL 相同；不得创建第二套实验记录或把 model 替换伪装成 tool-result replay。空工具表父本（引擎空 tools 或代理无工具）SHALL 允许创建实验：`configHash` 对空表成立，各臂 `config_hash` 与父一致。

#### Scenario: 创建两个模型分支

- **WHEN** 用户从同一父 run 提交两个不同 model/params 的 arm

- **THEN** 系统为每个 arm 创建独立 fork run，`fork.edit.field` 为 `model_params`，两个 run 的直接 parent 相同，现有分支树可展示它们

#### Scenario: 含 config_hash 的 proxy run 创建 A/B

- **WHEN** 用户对已封存、meta 含 `config_hash`、首次请求含字符串 system 消息且工具表为空的代理 run 发起两个 arm

- **THEN** 每个 arm 独立从头执行，各臂 run 的 `config_hash` 与父 run 一致（工具表按空表参与指纹）

#### Scenario: 拒绝不可 fork 父 run

- **WHEN** 父 run 未封存或缺少 `config_hash`（含历史无 hash 代理 trace）

- **THEN** 系统在创建 tracer、文件或模型请求前返回明确配置错误；proxy 来源缺 hash 时 SHALL 依 `meta.config_hash_reason` 区分缺因（`no_system` → 指向重新经代理录制带 system 的请求；`invalid_tool` → 指向修正工具定义；缺该字段 → 指向「编辑 messages 重发」入口）

#### Scenario: 拒绝缺少 system 消息的父 run

- **WHEN** 父 run 首次 `llm.call.request.messages` 中不存在 content 为字符串的 system 消息

- **THEN** 系统在任何文件写入和网络调用前拒绝，并说明启动上下文无法校验

#### Scenario: 带工具的代理父本沿用既有门禁

- **WHEN** 代理父本的首次请求携带非空工具表（wire 格式，无 sideEffect 标记）

- **THEN** 工具名不在桌面内置 registry 时按既有 UNKNOWN\_TOOL 拒绝；在 registry 内时按既有「缺 sideEffect 标记视为有副作用」规则处理，未显式 `allowSideEffects` 前拒绝——不因代理来源放宽工具可执行与副作用门禁
