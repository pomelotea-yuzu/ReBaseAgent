## ADDED Requirements

### Requirement: 桌面查询复用共享事实且保持兼容

桌面 SHALL 通过共享只读查询实现读取/派生运行、来源、比较和历史文件；既有 IPC 名、schema、状态、逐侧错误、草稿/阅读位置及主动操作语义 SHALL 保持。MCP 外部投影的容量/正文限制 SHALL NOT 收紧桌面；MCP 的省略 selector=初始规则 SHALL NOT 改变桌面最近自有完成步骤默认。

#### Scenario: 相同对象在桌面和 MCP 事实一致
- **WHEN** 两入口读取相同完整/缺父/损坏/v3 fixture 及检查点
- **THEN** 状态、归属、消耗、缺项和文件哈希一致，差异仅为明示字段/容量投影

#### Scenario: 桌面默认检查点和旧 IPC 保持
- **WHEN** 提取后通过旧 IPC 打开运行、比较和文件页
- **THEN** schema/逐侧错误不变，桌面仍默认最近自有完成步骤，显式选择不被 MCP 初始规则覆盖

#### Scenario: 只读流程交互回归
- **WHEN** 在真实 Electron 完成列表到详情到比较到文件并返回，抽查窄窗/200%/键盘
- **THEN** 阅读位置/焦点/可达性保持，无新导航、无执行登记，原数据不变
