# A3-B：隔离文件运行的桌面创建与重跑

## Why

A 的包内核可以创建和恢复隔离文件运行，但桌面尚无目录选择、每次副本授权或隔离分叉确认，也未将详情 IPC 和主进程列表扫描接入 v2 的完整约束。本 change 使用户可以在桌面完成真实隔离运行，并明确编辑点与轮末续跑边界。

## Goal

跑通选择目录、创建父运行、修改工具结果、确认隔离分叉、重启后查看轨迹与来源；验证源目录、父分支和兄弟分支不变。本段不依赖文件差异页验收。

## Dependencies

实施与归档依赖 A `add-sandboxed-rerun` 已归档，消费其 createIsolatedRun/replayIsolatedRun、只读能力预检及 v2 纯校验 helper。C `add-sandboxed-rerun-file-view` 在 B 归档后实施，复用本段详情 IPC 和运行来源模型。

## What Changes

- 新建运行提供默认纯对话与隔离文件模式，原生目录选择使用会话 sourceToken，每次执行显式允许副本写入。
- main 注入便携 dataDir，配置和请求预检后调用 A 的包 API；保留纯对话、普通分叉和错误信封行为。
- 隔离 result 确认显示直接父 run、工具编辑位置、所属 step、本地轮号及轮末继续边界；不继承历史审计授权。
- main/IPC 严格匹配父本与执行模式，隔离父本的 prompt fork/A-B 禁用并由包门禁再次拒绝。
- 详情 IPC 在 schema 转换前检查 v1 隔离字段，合法 v2 元数据、快照和祖先来源完整往返；缺附件仍可读轨迹。
- 对真实 listRuns 做 1/10/50 run 完整扫描基准、结果一致性和只读验证；接受首期完整读取成本，不承诺大规模即时刷新。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `desktop-ui`：隔离创建/分叉、授权、详情 IPC 兼容、执行能力与来源、列表完整扫描。

## Impact

影响 apps/desktop 的 main、shared、preload、store、CreateRunDialog、分叉确认和对应测试/CDP。复用 React、zod 和现有 IPC 信封，不新增依赖，不修改 A 的 trace-format/workspace-isolation 契约。包层配置/路径/配额/授权规则不在桌面重定义。预算 14.25h，全部待实现。

## Non-goals

- 不交付文件 tab、检查点选择器、文本 diff 或 inspect/readFile 通道；这些由 C 提供。
- 不实现 shell、任意 handler、外部网络/数据库隔离、回写合并或附件 GC。
- 不给旧 run 补造快照，不支持隔离父本的 prompt fork/A-B 真执行。
- 不用 meta-only、惰性快照验证或持久化摘要缓存改变列表事实源。
- 不自动提交、归档或发版。

## 保真度边界

桌面只消费 A 的固定 read_file/write_file 文件世界。read_file 在固定快照下可确定读取；write_file 的副作用限于本分支映射。编辑 result 改变模型观察，恢复点是该工具所属完整轮次结束，历史工具不重做。模型续跑仍真实调用 provider，响应与费用不确定。目录采集不是 OS 原子快照，权限、链接身份、时间戳和外部状态不恢复。副本隔离不等于网络离线：读工具文本会进入已配置模型请求。
