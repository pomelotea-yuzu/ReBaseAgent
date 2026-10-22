# 1.1 真实客户端最小 stdio 验证记录

状态（2026-10-22）：**1.1 支持路径完成**。真实客户端 WorkBuddy 5.9.0（内置 CodeBuddy CLI 2.165.0）
已完成协议初始化和工具发现；空 traces 的 `list_runs` 返回由同一服务的官方 SDK 客户端验证。
WorkBuddy GUI 的代表任务与工具调用仍归 6.2，本文件不把它写成已通过。

## 目标与验收

- 任务：选定 Windows WorkBuddy 实际版本，以最小 stdio 服务验证初始化/工具发现；
  记录客户端、Node、SDK 精确版本与 zod 兼容。验收 S01。
- 判定标准：真实客户端完成协议初始化与工具发现，只访问显式数据根，空 traces 返回合法空列表；
  失败先修支持路径，不先扩大客户端。

## 客户端事实

| 项 | 实测 |
|---|---|
| 客户端 | WorkBuddy 5.9.0（Windows） |
| 内置 CLI | CodeBuddy Code `2.165.0`（`resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`） |
| 安装 | 注册表 `DisplayName=WorkBuddy 5.9.0`；可执行 `C:\Users\28145\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe` |
| 用户级 MCP 配置 | `C:\Users\28145\.workbuddy\mcp.json`（现有 `lighthouse-ops` streamableHttp，disabled） |
| 项目级 MCP 配置 | `.mcp.json` / `mcp.json`（本轮临时使用 `D:\ReBaseAgent\.mcp.json`，验证后已删除） |
| 配置字段 | `command` 被客户端规范化为 `type:"stdio"`；支持 `args`/`env`/`cwd` |

## 真实客户端证据（已完成）

临时项目级配置：

```json
{
  "mcpServers": {
    "rebaseagent-spike": {
      "type": "stdio",
      "command": "D:\\nodejs\\node.exe",
      "args": [
        "D:\\ReBaseAgent\\.workbuddy\\mcp0-spike\\dist\\server.js",
        "--data-dir",
        "D:\\ReBaseAgent\\.workbuddy\\mcp0-11\\data"
      ],
      "description": "ReBaseAgent MCP0 1.1 最小 stdio 冒烟（临时）",
      "alwaysLoad": true
    }
  }
}
```

`codebuddy mcp get rebaseagent-spike`（WorkBuddy 内置 CLI）：

```text
Scope: project
Status: ✓ Connected
Type: stdio
Command: D:\nodejs\node.exe
Args: D:\ReBaseAgent\.workbuddy\mcp0-spike\dist\server.js --data-dir D:\ReBaseAgent\.workbuddy\mcp0-11\data
```

服务端事件账本 `.workbuddy/mcp0-11/server-events.log` 的对应记录：

```text
2026-10-22T06:01:03.345Z start {"pid":36700,"dataDir":"D:\\ReBaseAgent\\.workbuddy\\mcp0-11\\data"}
2026-10-22T06:01:03.361Z initialized {}
2026-10-22T06:01:03.363Z tools/list {}
```

- **初始化**：WorkBuddy 客户端启动子进程并完成 `initialize`（`initialized` 事件）。
- **工具发现**：客户端发出 `tools/list`（服务端账本记录）；服务只注册一个 `list_runs`。
- `codebuddy mcp list` 显示 `rebaseagent-spike: Needs approval`——这是工具执行审批状态，
  不是连接失败；`mcp get` 同时给出 `Status: ✓ Connected`。
- 证据汇总：`.workbuddy/mcp0-11/workbuddy-mcp-get.txt`；复跑前需重新放入临时 `.mcp.json`。

## 协议级验证（补充，非替代）

- 隔离目录：`.workbuddy/mcp0-spike/`；Node `v24.19.0`、SDK `1.32.1`、zod `3.25.76`、TypeScript `5.9.3`。
- 官方 SDK 客户端（`Client` + `StdioClientTransport`）：
  - 初始化成功，`tools/list` 恰一个 `list_runs`，annotations 为 readOnly/idempotent/openWorld=false。
  - 空 `traces/` → `runs: []`；非空 → 排序与 limit 生效；`limit:0` → `isError:true`。
  - 无/相对/缺 traces 的数据根 → 退出码 2、stdout 为空、stderr 固定 `DATA_DIR_INVALID`。
- 证据：`.workbuddy/mcp0-spike/spike-result.json`；复跑：`cd .workbuddy/mcp0-spike && node client.mjs`。

## 边界与后续

- 1.1 只证明**支持路径**：WorkBuddy 能启动 stdio 服务、完成初始化、发现工具。
- WorkBuddy 本次没有实际调用 `list_runs`（`mcp list` 显示需审批）；空 traces 的返回由官方 SDK
  客户端在同一服务、同一数据根上验证。真实 WorkBuddy GUI 的代表任务、工具调用与桌面一致性
  由 6.2 验收，不能用本文件顶替。
- 临时 `.mcp.json` 已在取证后删除；最终 4.1 交付 `packages/mcp-server/dist/cli.js`，不是 spike。
- 未扩大客户端：本轮只以 WorkBuddy 5.9.0 为准，未引入第二客户端。
