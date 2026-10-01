## MODIFIED Requirements

### Requirement: 同一批实验必须可分组

一次编排调用 SHALL 视为一批实验，系统 SHALL 为其确定一个 `experimentId`（调用方传入或自动生成），同一批内所有 arm SHALL 相同。该字段 SHALL 随 edit value 写入 `fork.edit`，仅用于 UI 分组及共用比较工作区的默认候选，不参与校验、`config_hash` 或比较判据。

#### Scenario: 同批 arm 自动配对

- **WHEN** 用户在同一批实验下创建三个 arm
- **THEN** 三个 fork run 的 `fork.edit.value.experimentId` 相同，UI 将其归为一组并默认作为同批比较候选；三臂先进入指标表，再显式选两条详细比较，比较资格仍按既有校验判定

#### Scenario: 多批实验共存

- **WHEN** 同一父 run 上先后进行两批实验，产生多个同父兄弟 run
- **THEN** UI 按 `experimentId` 分开展示，不把不同批的 arm 混为一组

#### Scenario: 预览标签不充当真实批次身份

- **WHEN** dry-run 返回 experimentId 而真实执行尚未关联批次
- **THEN** 预览只展示计划，真实结果按本次 main 登记或已校验记录的 experimentId 分组，不把预览标签用于归并运行

#### Scenario: 同父同模型仍按真实批次分组

- **WHEN** 同父连续多批或不同父同名模型结果同时存在
- **THEN** 按真实 experimentId 与父本身份展示，不按模型名、时间、列表邻近或成功臂 ids 猜分组；标签相同不豁免比较资格

### Requirement: 成本确认和 dry-run 必须显式

真实执行 SHALL 在 CLI 要求 `--confirm-cost`，在桌面端要求用户针对当前有效计划明确确认；确认提示 SHALL 列出当前单一 provider、每个 model/params arm、预计调用臂数和工具策略。CLI SHALL 以独立 bin `rebaseagent-model-ab` 暴露，不与 V3a 的 `rebaseagent-trace-test` 合并。`--dry-run` SHALL 只做校验和展示，不需要 apiKey、不联网、不创建文件。没有调用方提供的价格估算器时成本 SHALL 为 unknown，不得内置或臆造价格。

dry-run 与执行前的确认展示 SHALL 包含每臂的**最终生效 params**：arm 显式给出的项 SHALL 标注为"覆盖"（父已有）或"新增"（父没有），父 run 录制值中因整体替换而被丢弃的项 SHALL 逐项列出。

plan 条目 SHALL 携带四个字段并由编排层计算一次：`params`（最终生效）/ `overridden`（arm 显式给出的键）/ `discarded`（被丢弃的父录项）/ `warnings`（知识库命中）。CLI 与桌面 SHALL 只读这些字段渲染，SHALL NOT 各自重算。没有调用方提供价格估算器时成本 SHALL 为 unknown，不得内置或臆造价格。

#### Scenario: 未确认时阻断真实调用

- **WHEN** 用户未提供确认参数或未在桌面确认
- **THEN** 系统不发起网络请求，返回可操作的确认错误

#### Scenario: dry-run 无密钥

- **WHEN** 用户使用 `--dry-run` 且未配置 apiKey
- **THEN** 系统只读父本校验并显示执行计划（含每臂最终生效 params 与被丢弃的父参数项），不改写 trace、不创建运行、不调用 provider

#### Scenario: dry-run 暴露整体替换的代价

- **WHEN** 父 run 录制 `num_predict=768`，某臂 params 只给出 `temperature=0.7`
- **THEN** dry-run 明确列出该臂最终生效 params 不含 `num_predict`（已被整体替换丢弃，逐项列于 `discarded`），用户在真实执行前可见

#### Scenario: dry-run 每臂三段固定展示

- **WHEN** 某臂 params 含 `temperature=0.7` 与 `num_ctx=8192`，父 run 录制 `num_predict=768`，baseURL 指向本机 Ollama
- **THEN** CLI 与桌面在该臂下展示三段：`生效 params`（`temperature=0.7（覆盖）`）、`丢弃父录值`（`num_predict=768`）、`⚠ 告警`（`num_ctx` 静默忽略与绕行方式）；无丢弃项时省略第二段，无告警时省略第三段，两端的字段语义 SHALL 一致

#### Scenario: 桌面预览沿用配置前置且零执行

- **WHEN** 桌面运行配置缺失、主动槽被其他操作占用或合法预览返回
- **THEN** 缺配置按既有条件拒绝并可去配置后返回，合法未冻结批次的只读预览不因主动槽占用被禁用；预览不登记操作、不消费许可、不调用模型/工具、不落盘，CLI 无密钥 dry-run 能力不变

#### Scenario: 费用确认区分臂数和请求数

- **WHEN** 用户对当前计划确认两个或更多臂真实执行
- **THEN** 列出单 provider、每臂生效 model/params、计划臂数与工具策略，无估价器时费用 unknown；不把臂数宣称为准确 API 请求次数或质量结论

## ADDED Requirements

### Requirement: 桌面实验计划绑定当前编辑与来源并拒绝迟到恢复

桌面实验 SHALL 先读取后端 dry-run 计划再允许明确执行。计划和确认 SHALL 绑定父本/调用、批次修订、已核实运行配置变化、来源校验和预览代次及本次工具声明；任何改变或离开恢复 SHALL 作废旧计划/确认。界面 SHALL 只读后端计划，不另算参数或 provider 能力；实际提交仍受 main 既有门禁。

#### Scenario: 计划直接展示生效覆盖新增丢弃告警

- **WHEN** 后端计划返回 params、overridden、added、discarded 和 warnings
- **THEN** 每臂按返回字段完整展示，保留整体替换和知识库未命中语义，不在 renderer 重算、不声称无告警即参数被 provider 接受

#### Scenario: 修改臂再改回不恢复计划

- **WHEN** 预览后改 model/params、增删/重排臂或修改副作用声明，再改回原值
- **THEN** 修订或声明变化使旧计划/确认作废，必须重新预览，稳定行身份和原始输入仍保留

#### Scenario: 配置轮换与来源撤销作废计划

- **WHEN** 同 model/baseURL 下保存新 key、保存回读失败、清除设置或父链来源资格撤销
- **THEN** 撤销旧计划/确认而不读取 key 值，保留批次；状态恢复后须重新预览，不能只比较 model/baseURL 复用旧结论

#### Scenario: 迟到和乱序预览不能安装旧计划

- **WHEN** 预览在飞时改目标/修订/配置/声明、离开、放弃后重建或另发预览
- **THEN** 只接纳当前目标与全部有效绑定一致的最新响应，旧响应零确认/许可副作用，不覆盖较新计划或新批次

#### Scenario: 无有效计划和确认不提交实验

- **WHEN** 计划失效或用户取消费用/副作用确认后尝试执行
- **THEN** 零主动执行调用，显示重新预览或确认原因；再次显式提交使用当前批次与新操作身份，后端复验不被绕过

#### Scenario: 副作用声明不承诺公平隔离

- **WHEN** 工具未标记 pure 而用户拒绝或明确接受既有副作用声明
- **THEN** 拒绝时按工具门禁阻断，接受时计划/确认显示顺序执行和前臂可能改变后臂外部状态；不启用隔离 A/B，不产出公平性或胜出结论
