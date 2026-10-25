## ADDED Requirements

### Requirement: 验证证据提供独立共享只读入口

系统 SHALL 提供不直接或间接导入准备/执行/停止/清理/写入模块的 read 子入口，以及仅依赖纯数据的 facts 子入口，供桌面和 MCP 复用。SHALL 共享记录投影、附件定位/核验和比较条件，不复制 JSONL 解析器或建立第二事实源。SHALL 保留已有导出、IPC schema 和日志字节接口兼容。

#### Scenario: V01 只读入口无执行依赖且无需后端
- **WHEN** 在无 Electron/Docker 的 Node 进程导入 read/facts 并查询既有记录
- **THEN** import 闭包不含 writer/prepare/execute/orchestrate/runtime/docker，无子进程/网络/写入副作用；历史读取可用

#### Scenario: V02 桌面与 MCP 对同对象事实一致
- **WHEN** 两个入口读取完整、缺环境、坏尾、缺来源的相同记录并比较两侧条件
- **THEN** 记录状态、可信终止、实际命令、环境未知及条件/结论一致，外部仅做白名单/容量投影，旧 IPC 名称/schema 和交互不变

### Requirement: 验证附件读取提供核验后的安全文本视图

系统 SHALL 复用内容寻址资产完整大小/哈希验证，从记录绑定日志/产物，不接受任意宿主路径或自由附件 hash 作为外部查询。SHALL 提供严格 UTF-8 视图和码点范围，分开采集/保留/本次响应范围，拒绝越界链接、非法对象、歧义命令及冲突产物路径。原字节读取接口 SHALL 保持既有兼容语义。

#### Scenario: V03 文本跨段与字节接口兼容
- **WHEN** 读取中文/emoji/CRLF/空日志的同一资产，旧桌面使用 offset/maxLength，新查询使用码点范围
- **THEN** 两者共享完整哈希核验且单位明确；新视图跨段不丢字/补替换字符，旧接口默认/上限与响应 schema 保持兼容，二进制不伪造文本

#### Scenario: V04 核验与枚举不掩盖坏数据
- **WHEN** 记录/目录不可读、资产缺失/大小或哈希不符、链接越界、重复命令/产物路径
- **THEN** scan 保留独立安全失败项而非静默跳过，正文受控拒绝或逐项标不可用；不从当前源目录修复，也不改历史 outcome
