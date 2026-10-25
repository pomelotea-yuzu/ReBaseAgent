# MCP2：查询真实测试证据

## Why

MCP0/1 已提供运行、步骤和历史文件查询，但外部客户端尚不能读取 R3 的独立验证记录。Agent 声称“测试通过”、运行正常结束或文件发生变化，都不能代替实际命令、日志和检查结果。

R3 `add-isolated-project-verification` 已于 2026-10-25 归档，验收首个 Windows x64 + Docker Desktop Linux containers + `node-ts-v1` 模板环境，满足 MCP2 消费记录的前提；真实项目接入 I 仍未验收。本 change 承接 [MCP 路线 §5](../../../docs/product/mcp-service-roadmap.md)和[正式路线](../../../docs/product/evolution-roadmap.md)，交付“定位失败验证 → 读取命令与日志 → 比较指定修复分支验证 → 回查所测输入和产物”。

本次只编写提案，以下工具尚未实现或验收；既有发行包的 MCP 能力仍以 MCP1 为准。

## What Changes

- 新增六个只读工具：`list_verifications`、`get_verification`、`read_verification_log`、`inspect_verification_artifacts`、`read_verification_artifact`、`compare_verifications`。保留 MCP1 七工具的名称、参数和行为，完整实现后共十三个工具。
- 为 `project-verification` 增加独立只读子入口，复用版本化 JSONL、事件和内容寻址附件校验。读取闭包不导入准备、执行、停止、资源清理或写入模块，查询无需桌面或 Docker 运行。
- 返回实际命令、参数数组、容器工作目录、UTC 起止、耗时、exit/signal、历史环境、日志/产物索引及停止/中断事实。正文按需读，历史缺项保持未知。
- 复用 MCP1 的完整结果 64 KiB 预算、content 自足和正文单次承载；日志和产物采用认证游标，区分采集截断与响应分页，处理 UTF-8 边界和二进制。
- 提取桌面验证比较的纯事实判据，桌面与 MCP 共享。固定用户选定的两个 verification，展示条件相同、不同或未知；只描述已记录固定检查结果。
- 增加领域/stdio/桌面一致性/真实客户端验收、接入指南和逐场景证据。

## Capabilities

### New Capabilities

无新增顶层 capability。

### Modified Capabilities

- `mcp-service`：十三工具发现、验证查询、日志/产物读取、条件比较和真实客户端验收。
- `project-verification`：只读模块闭包、共享证据投影/比较、验证附件读取与 UTF-8 安全视图。

## Impact

影响 `packages/project-verification` 的读取导出/纯派生，`packages/mcp-server` 的契约、查询、版本/游标、预算与测试。桌面仅调整 `verification-read-endpoints.ts` 和 `lib/verification-compare.ts` 的共享事实接线，保留 IPC 名称、已有 schema 和交互；`run-query`/`replay` 继续提供运行、分叉和检查点校验，不复制解析器。

沿用 TypeScript、zod、官方 MCP SDK 和 Node 内置库，只增加工作区依赖，不新增第三方 npm 依赖。不升级 trace/验证记录格式，不迁移历史数据。新增导出纳入生产 deploy 闭包与发行组装探针回归，实际打包/上传另行安排。

## Non-goals

- MCP3 的预检/准备/执行/重跑/停止接口，任意宿主命令、Docker 探测和资源清理。
- 自动修复、模型调用、导出、补丁应用、CI、批量评测或证据材料包。
- 扩大 R3 的语言/环境/项目支持范围，或以模板验收声称真实项目接入通过。
- 从当前源目录、当前环境或其他验证补历史；新增持久索引、网络服务、实时订阅或执行恢复。
- 改变桌面布局、增加客户端矩阵、本次实现代码/执行项目/修改客户端配置/打包发布。

## 保真度边界

查询不复用或续跑模型消息，不执行历史命令或工具。所测输入固定为记录的 run/自有初始或完成步骤/snapshot；回查不符则报告，不切换最近步骤。R1 的文件路径/字节保真和 R3 的容器边界保持既有语义，不恢复网络、数据库、权限或历史宿主环境。

产物属于指定 verification，既不是 Agent 检查点，也不是当前源项目文件。历史环境只取记录及明确关联的准备记录，不能用当前 manifest 补齐。查询不产生 ReBaseAgent 模型费用；日志/文件返回后可能由客户端外发到其模型并计费。

## 验收口径

选定一个真实客户端，回查两条独立失败/通过验证的命令、日志、环境、所测输入和产物，与桌面核对。覆盖旧环境缺项、坏记录、缺来源/附件、长输出、Unicode、二进制、游标漂移、越界、取消和断连。查询前后文件集合/哈希不变，执行/模型/导出/登记/清理调用为零。见 [design.md](design.md)、[tasks.md](tasks.md) 和 [evidence-index.md](evidence-index.md)。
