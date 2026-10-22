# 1.1 真实客户端最小 stdio 验证记录

状态（2026-10-22）：**进行中**。协议级最小 stdio 已通过；WorkBuddy 5.9.0 的项目级 MCP 配置已就位，
等待客户端新会话/重启加载并完成真实初始化与工具发现。真实客户端未通过前，1.1 不勾选、S01 不填通过证据。

## 目标与验收

- 任务：选定 Windows WorkBuddy 实际版本，以最小 stdio 服务验证初始化/工具发现；
  记录客户端、Node、SDK 精确版本与 zod 兼容。验收 S01。
- 判定标准：真实客户端完成协议初始化与工具发现，只访问显式数据根，空 traces 返回合法空列表；
  失败先修支持路径，不先扩大客户端。

## 客户端事实

| 项 | 实测 |
|---|---|
| 客户端 | WorkBuddy 5.9.0（Windows） |
| 安装 | 注册表 `DisplayName=WorkBuddy 5.9.0`；可执行 `C:\Users\28145\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe` |
| 运行 | 审计时多个 `WorkBuddy.exe` 进程在运行 |
| 用户级 MCP 配置 | `C:\Users\28145\.workbuddy\mcp.json`（现有 `lighthouse-ops` streamableHttp，disabled） |
| 项目级 MCP 配置 | 支持 `.mcp.json` / `mcp.json`；本轮使用 `D:\ReBaseAgent\.mcp.json`（临时） |
| 配置字段 | `command` 会被客户端规范化为 `type:"stdio"`；支持 `args`/`env`/`cwd` |

## 协议级最小验证（已完成）

- 隔离目录：`.workbuddy/mcp0-spike/`（不在 workspace 内，不进入仓库依赖）。
- 版本：Node `v24.19.0`、SDK `1.32.1`、zod `3.25.76`、TypeScript `5.9.3`。
- 服务：官方 `McpServer` + `StdioServerTransport`，一个只读 `list_runs` 工具（strict limit 1–100）。
- 客户端：官方 `Client` + `StdioClientTransport` 启动真实子进程。
- 通过项：
  - 初始化/协商成功，`tools/list` 恰一个工具，annotations 为 readOnly/idempotent/openWorld=false。
  - 空 `traces/` → `runs: []`。
  - 非空 `traces/` → 排序与 limit 生效。
  - 非法参数 `limit: 0` → `isError: true`。
  - 无/相对/缺 traces 的数据根 → 退出码 2、stdout 为空、stderr 固定 `DATA_DIR_INVALID`。
- 证据：`.workbuddy/mcp0-spike/spike-result.json`；复跑：`cd .workbuddy/mcp0-spike && node client.mjs`。
- 服务端事件账本：`.workbuddy/mcp0-11/server-events.log`（start / initialized / call list_runs）。

## 真实客户端接入（等待加载）

临时项目级配置 `D:\ReBaseAgent\.mcp.json`：

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

**当前观察**：配置写入后 WorkBuddy 尚未启动 spike 子进程（`server-events.log` 无新 `start`）；
客户端很可能在会话启动/重启时加载 MCP 配置。需要在 WorkBuddy 中打开 `D:\ReBaseAgent` 项目并新建会话
（或重启客户端），然后让助手列出/调用 MCP 工具。

待完成判据：

1. WorkBuddy 新会话启动后，`server-events.log` 出现 `start` 与 `initialized`。
2. WorkBuddy 的工具清单出现 `list_runs`（工具发现）。
3. 调用 `list_runs` 返回 `runs: []`（当前数据根为空 traces）。
4. 记录 WorkBuddy 完整版本、Node/SDK 版本与配置位置；把观察写回本文件与 tasks/evidence-index。

## 诚实边界

- 协议级验证证明 SDK/Node/zod/NodeNext 组合可用，不证明 WorkBuddy 兼容。
- 配置已就位但尚未被客户端加载；真实初始化/工具发现/调用均未通过，1.1 保持未完成。
- 临时 `.mcp.json` 与 spike 服务在验证完成后清理；最终 4.1 交付的是 `packages/mcp-server/dist/cli.js`，
  不是本临时入口。
