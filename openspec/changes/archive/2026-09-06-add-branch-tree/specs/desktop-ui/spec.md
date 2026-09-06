## ADDED Requirements

### Requirement: run 列表载荷暴露 fork 摘要

run 列表的每条记录 SHALL 携带该 run 的分叉摘要：`fork: { at_span, edit_field } | null`（根 run 与老文件为 `null`）。摘要 SHALL 只含分叉点 span id 与被编辑字段名，SHALL NOT 携带被编辑的值（value 可能是整段工具结果或完整 messages，列表载荷不需要，也不得因此放大跨进程数据量）。该字段为向后兼容新增——不含该字段的旧载荷 SHALL 被按「无分叉摘要」处理，不报错。

#### Scenario: 分支 run 带摘要

- **WHEN** run B 的 `meta.fork` 为 `{ at_span: "s_03", edit: { field: "result", value: "…" } }`
- **THEN** 列表载荷中 B 的 fork 摘要为 `{ at_span: "s_03", edit_field: "result" }`，不含 value

#### Scenario: 根 run 与老文件

- **WHEN** run 为根 run（`parent` 为 null、`fork` 为 null）
- **THEN** 其 fork 摘要为 `null`，不臆造分叉信息

### Requirement: 界面提供分支树与轨迹两种视图

header SHALL 提供「分支树 / 轨迹」视图切换入口。切到分支树时，主区域 SHALL 呈现分支树视图（全宽），切回轨迹视图时 SHALL 恢复既有三栏（列表 / span 树 / 详情）。两种视图 SHALL 共享同一份 run 列表数据与同一个选中 run 状态——在分支树里点选的 run，切回轨迹视图后仍是被选中的那个，反之亦然。视图切换 SHALL NOT 触发列表重新加载。

#### Scenario: 切到分支树

- **WHEN** 用户在 header 点击「分支树」
- **THEN** 主区域切换为分支树视图，已有 run 列表数据直接复用，不重新读取磁盘

#### Scenario: 选中状态跨视图保持

- **WHEN** 用户在分支树视图点选 run B，然后切回轨迹视图
- **THEN** 轨迹视图呈现 B 的 span 树与详情，无需用户再次选择

#### Scenario: 切换不重载

- **WHEN** 用户在两视图间来回切换
- **THEN** 列表数据不发生第二次加载（无重复 IO），失败文件条目同样保持
