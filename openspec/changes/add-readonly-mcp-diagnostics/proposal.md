# MCP0 / MCP1：只读诊断服务

## Why

开发者在已有 AI 工具中分析 Agent 问题时，需要手动复制 ReBaseAgent 的运行、调用和文件，容易丢失来源与缺项。R2.2 已归档，其跨运行检查点比较可以作为首版基础。

本提案承接[正式路线 §3.3](../../../docs/product/evolution-roadmap.md#33-mcp在已有-ai-工具中使用调试能力)与 [MCP 服务规划](../../../docs/product/mcp-service-roadmap.md)，合并 MCP0 接入准备与 MCP1 只读诊断。源码核对基线 `2d39b1e`（2026-10-22）。R3 仍为下一项核心执行能力，本 change 不成为 R3 前置条件；提取范围明显扩大时先修订拆分或顺延。

**本次仅编写 change，尚未实施、验收或发行。** R2.2 源码归档不代表已进入 `0.5.0-rc.1`。

## What Changes

- 提取无 Electron/renderer 依赖的 `@rebaseagent/run-query`，共享运行摘要、父链校验、详情投影、比较和历史文件查询。桌面 IPC 与 MCP 使用同一事实实现，保持旧 IPC 和 UI 行为。
- 新增 `@rebaseagent/mcp-server`，独立 Node 进程、本地 stdio、显式已有数据目录，不依赖桌面启动，不创建数据目录或读取模型设置。
- 提供七个只读工具：`list_runs`、`get_run`、`get_step`、`compare_runs`、`inspect_checkpoint`、`read_checkpoint_file`、`compare_checkpoint_files`。先摘要/索引，再按需读取正文。
- 定义版本化返回、来源引用、稳定错误码、分页/续读、输出上限、来源变化拒绝和未知/缺失状态。
- 首个验收客户端选本机 WorkBuddy 5.9.0（Windows；Claude Desktop 本机未安装）。MCP0 第一项记录实际客户端/Node/SDK 版本并验证 stdio；尚未验证兼容，不提前写成已支持。
- 交付构建/接入指南、真实客户端代表任务、桌面事实一致性与数据不变性证据。首版支持源码工作区构建后 Node 启动，不承诺 npm 发布或桌面捆绑。

## Capabilities

### New Capabilities

- `run-query`：共享只读查询、来源/身份/父链语义、运行和文件比较。
- `mcp-service`：stdio 服务、七个工具、版本/容量/错误契约、客户端验收。

### Modified Capabilities

- `desktop-ui`：桌面查询复用共享事实实现，维持既有 IPC、交互与文件选择语义。

## Impact

新增两个 TS workspace 包。run-query 依赖 trace-sdk/replay/现有 zod；MCP 包另引入官方 `@modelcontextprotocol/sdk`，用于协商、schema、stdio 生命周期，避免手写协议。MCP0 根据现有 Node/TS/zod 锁定精确版本并记录许可证、传递依赖和体积；若需全仓升级先修订提案。

影响 desktop 的只读 main/shared 模块、依赖和构建顺序。不搬 renderer store/组件、执行 registry/端点；不变更 trace v1/v2/v3，不迁移数据、不新增持久索引。设计见 [design.md](design.md)，实施见 [tasks.md](tasks.md)，验收映射见 [evidence-index.md](evidence-index.md)。

## Non-goals

- MCP2 的真实命令、日志、退出码和环境查询；未录制的 R3 证据不补造。
- MCP3 的实验/重跑/测试提交、取消、授权、队列和跨进程执行协调。
- 内置 Agent 调用外部 MCP 工具、第二客户端、通用插件平台。
- HTTP/SSE、远程共享、常驻服务、实时订阅、多租户和自动启动。
- 写入、删除、导出、自动应用/合并、任意宿主文件读取、模型密钥读取。
- 新桌面导航、自动根因/修复成功判断、步骤自动对齐、新模型调用。
- npm 发布、安装器、桌面捆绑和发布日期。

## 保真度与费用边界

仅解释已有记录。result 分支沿用已验收前缀投影；prompt、代理 messages、模型实验和 v3 隔离 prompt 为独立执行边界，不跨界拼旧 spans。查询不复用消息发起执行、不恢复文件或工具副作用。文件来自指定运行自有初始/轮末快照及核验附件，不从当前源目录补齐；清单引用相同不等于字节已核验相同。

未封存只表示截至读取未记录终止，不能证明进程仍运行；正常终止不等于任务成功。服务不调用模型/工具，不产生 ReBaseAgent 模型费用。返回正文可能有业务秘密，客户端可外发给自身模型并计费；已知凭据过滤不等于自由文本已彻底脱敏。

## 验收口径

在选定客户端找到最近一条有明确出错终止记录的运行，读取错误调用，与用户指定分支比较，再核对明确检查点文件并引用来源。客户端分析不写回轨迹、不自动判根因或修复成功。

同一 fixture 的桌面/MCP 状态、归属、缺项、消耗和文件哈希一致。覆盖 v1/v2/v3、混合链、损坏/缺父/附件、部分记录、长输出、二进制、游标变化和断连。用文件集合及 SHA-256 验零写入、零模型/工具/导出调用和零执行登记。真实客户端、另一位使用者按指南接入、Electron 回归分别留证，协议/文档通过不代替实机验收。
