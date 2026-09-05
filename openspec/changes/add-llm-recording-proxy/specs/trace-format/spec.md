# trace-format Delta: 录制来源元数据与 config_hash 可选性

## ADDED Requirements

### Requirement: 无 config_hash 的 run（代理录制形态）

`run.meta` 的 `config_hash` SHALL 放宽为可选字段（存在时仍须非空字符串）：由 SDK / agent-loop 直接录制时照常写入；由代理录制时 SHALL 省略（代理观察到的是无 loop 语境的独立请求，无源配置可哈希，诚实缺省而非占位值）。读取器 SHALL 接受缺失 `config_hash` 的 meta（老文件不受影响，它们均含该字段），不得报错。无 `config_hash` 的 run SHALL NOT 能作为 replay 分叉（`runs:fork` 路径）的父本——校验层 SHALL 明确拒绝并提示；但 SHALL 能作为代理分叉（`proxy:fork` 路径）的父本。`task` 字段保持必填：代理录制的 run SHALL 以常量 `"(llm-proxy)"` 填充（确定性纯函数，不做首条消息截断等启发式）。

#### Scenario: 代理 run 缺省 config_hash

- **WHEN** 一次请求经本地代理录制为 run

- **THEN** 落盘的 `run.meta` 含 `source` 与 `task: "(llm-proxy)"`，不含 `config_hash`；读取器校验通过

#### Scenario: 代理 run 拒绝 replay 分叉

- **WHEN** 对一个无 `config_hash` 的 run 走既有 `runs:fork` 路径（编辑 tool.result 重跑）

- **THEN** 校验层明确拒绝（该 run 无工具表与源配置，replay 语义不成立），提示而非报错崩溃

#### Scenario: 老 run 不受影响

- **WHEN** 读取既有含 `config_hash` 的 trace 文件并对其做 replay 分叉

- **THEN** 行为与此前完全一致（config_hash 校验照常）

### Requirement: run.meta 可记录录制来源

`run.meta` SHALL 支持可选 `source` 对象，结构为 `{ "kind": string, "base_url": string }`；`kind` 当前枚举仅 `"proxy"`（本地 LLM 录制代理录制）。当 run 由代理录制时，`source.kind` SHALL 为 `"proxy"`，且 `source.base_url` SHALL 为**代理自身监听地址**（即用户在自己应用里填的那个 base\_url，如 `http://127.0.0.1:8787/v1`）——SHALL NOT 混用为 upstream 转发目标地址（upstream 属代理配置，不进 trace）。由 SDK / agent-loop 直接录制时 SHALL 省略 `source`（缺省字段，仅 meta 层增量）。读取器 SHALL 接受缺失 `source` 的 meta（老文件与手工构造数据合法），不得报错。该字段 SHALL NOT 影响 `format_version`（保持不变）。

#### Scenario: 代理录制的 run

- **WHEN** 一次请求经本地代理（端口 8787）录制为 run

- **THEN** 落盘的 `run.meta` 含 `source: { "kind": "proxy", "base_url": "http://127.0.0.1:8787/v1" }`

#### Scenario: SDK 直接录制的 run

- **WHEN** 一次 run 由 trace-sdk / agent-loop 直接录制（非代理）

- **THEN** 落盘的 `run.meta` 不包含 `source` 字段，其余字段与解析行为不变

#### Scenario: 无来源信息的老文件

- **WHEN** 读取一份 `run.meta` 无 `source` 字段的既有 trace 文件

- **THEN** 校验通过，读取结果中该 run 无来源信息，调用方按"来源未知（视同 SDK 直录）"处理
