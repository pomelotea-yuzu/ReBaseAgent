## MODIFIED Requirements

### Requirement: 格式带版本号

`run.meta` 行 SHALL 包含 `format_version` 整数字段。读取器 SHALL 支持 1 和 2：普通运行继续写 1，隔离文件运行写 2。v2 SHALL 携带 workspace 元数据，v1 SHALL NOT 携带 workspace、step 快照或整轮续跑字段。读取器遇到更高版本 SHALL 明确报“不支持的格式版本”，不得静默降级解析。旧版读取器 SHALL 明确拒绝 v2 隔离文件，不得剔除字段后执行为普通运行。

#### Scenario: 未来版本文件
- **WHEN** 读取 `format_version: 3` 的文件
- **THEN** 报错提示版本不支持，不产生部分解析结果

#### Scenario: 双版本与旧读取器
- **WHEN** 新读取器读取普通 v1 和合法隔离 v2 fixture，或旧 v1 读取器读取该 v2 fixture
- **THEN** 新读取器完整保留各自字段，普通 writer 仍产出 v1；旧读取器明确拒绝 v2

#### Scenario: 版本与隔离字段不匹配
- **WHEN** v1 带 workspace 或整轮续跑字段，或 v2 缺 workspace、已完成 step 缺快照
- **THEN** 校验拒绝并指出字段问题，不把隔离状态按未知字段静默删除

#### Scenario: v1 禁字段与其他扩展区分
- **WHEN** v1 原始 meta 自有 workspace 或 fork.resume_after_step，或 span 自有 workspace_snapshot，字段值为 null/false/空对象；另有只包含不相关扩展字段或消息正文内同名业务字段的对照记录
- **THEN** 前者均在字段转换或剔除之前被拒绝，后者沿用既有兼容行为；不得用全对象 strict 或递归同名搜索误伤普通 v1 数据

### Requirement: 分支用 fork 元数据表达

分支 run 的 `run.meta` SHALL 含 `parent`（父 run id）与 `fork` 对象（`at_span`：编辑点 span id；`edit`：字段及新值）。分支文件 SHALL 只记录新增 span，前缀经 parent 链共享。v1 保持截至 at_span 的既有规则；v2 隔离 result 分叉 SHALL 另带 `resume_after_step`，保留该轮完整步骤及所有工具子节点后再接子 run。at_span SHALL 属于指定 step，该 step SHALL 来自直接父 run 自有记录。

#### Scenario: 编辑工具结果后分叉
- **WHEN** 用户编辑普通 v1 r_01 中 s_04 的 tool_result 并重跑
- **THEN** 新文件 r_02 的 meta 含 `fork: { at_span: "s_04", edit: { field: "result", value: ... } }`，文件内只有新增 span，旧前缀拼接规则不变

#### Scenario: 隔离分叉保留同轮兄弟工具
- **WHEN** v2 某轮包含依次执行的 T1/T2，分叉编辑 T1 的 result
- **THEN** fork 同时记录 T1 和所属 step 的两个边界，展开前缀保留该轮 LLM、T1、T2 各一次，随后接入子运行；不遗漏 T2、不执行编辑或附件读取

#### Scenario: 隔离续跑边界矛盾
- **WHEN** resume_after_step 缺失、指向非步骤、与 at_span 所属步骤不符或只存在于祖先
- **THEN** 隔离父子关系校验拒绝，不猜测边界，不静默套用 v1 截断

## ADDED Requirements

### Requirement: 隔离元数据及检查点可独立解析

v2 `run.meta.workspace` SHALL 记录 `profile:"file-tools-v1"`、等于本 run id 的 `world_id`、`write_authorized:true`、`initial_snapshot` 和 `origin`。根 origin SHALL 为 `{kind:"import"}`，分支 origin SHALL 为 `{kind:"checkpoint",run_id,step_span}` 并与 parent/resume_after_step 一致。每个完整 `agent.step` SHALL 携带 `workspace_snapshot`，它代表整轮全部工具完成后的状态。

`write_authorized:true` SHALL 仅作为创建方记录该次运行已获确认的审计标注，SHALL NOT 作为当前执行权限或不可伪造的授权证明；新一次创建/分叉必须独立校验当前请求的副本写入授权，不得从父 trace 的该字段推导。

快照 SHALL 是 `{id,files:[{path,sha256,bytes}]}`，files 为排序后的合法唯一相对文件路径清单，id 为规范清单哈希。SHA-256 SHALL 是 64 位小写十六进制，bytes SHALL 为非负整数，路径 SHALL 满足文件世界约束；快照 SHALL 不携带绝对磁盘路径、凭据或内联文件字节。事件流、JSONL、MemoryTracer 和读取器往返 SHALL 保留这些字段。

#### Scenario: 根与分支快照往返
- **WHEN** 初始快照和两轮结束快照经 Tracer 写入，再通过读取器加载
- **THEN** 所有路径、哈希、来源及边界字段完整保留，span 语义顺序仍正确；空清单也可往返

#### Scenario: 非法清单拒绝
- **WHEN** 清单存在非法路径、重复或冲突路径、负 bytes、非法哈希、哈希与规范清单不符或矛盾的 origin
- **THEN** 返回明确校验错误，不生成部分可信快照

#### Scenario: 无附件仍能看轨迹
- **WHEN** 合法 v2 JSONL 存在但附件目录不可用
- **THEN** 普通 trace 解析不加载附件，仍返回完整消息与步骤；包附件读取和真实续跑分别报告不可用，不能改写 trace 补数据
