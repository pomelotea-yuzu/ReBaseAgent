# 1.2 MCP SDK、依赖与构建审计

状态：审计与协议级验证完成（2026-10-22）；**1.1 支持路径已用 WorkBuddy 5.9.0（内置 CLI 2.165.0）验证**，WorkBuddy GUI 代表任务归 6.2。
基线 `2d39b1e`；隔离实验目录 `.workbuddy/mcp0-spike/`（不进入仓库依赖）。

## 决策

- **锁定 `@modelcontextprotocol/sdk@1.32.1`**（审计时 npm latest）。
- **不升级全仓 Node/zod**：SDK `engines.node >=18`，本机 `v24.19.0`，仓库要求 `>=20`；
  SDK peer `zod ^3.25 || ^4.0`，工作区锁文件已解析 `zod@3.25.76`（各包声明 `^3.23.8`，范围兼容）。
  新 `mcp-server` 包显式声明 `zod ^3.25.0` 即可，不触碰其他包。
- **许可证无阻塞**：SDK 为 MIT；生产依赖 95 个包中 MIT 85、ISC 7、BSD-3-Clause 2、BSD-2-Clause 1，
  无 GPL/AGPL/未知许可证。
- **体积可接受**：生产依赖安装体积 **14,811,228 B（约 14.1 MiB）**，其中 SDK 4.49 MB、zod 3.59 MB、
  hono 1.29 MB、ajv 1.03 MB。SDK 的 HTTP/SSE/auth 依赖即使只用 stdio 也会被 npm/pnpm 安装；
  首版不随桌面打包，不影响发布包体积。
- **构建/运行形态**：ESM + NodeNext，`tsc -p tsconfig.json`，产物 `dist/`；
  本地以绝对 Node 路径启动 `dist/cli.js --data-dir <已有绝对路径>`。

## 版本与约束

| 项 | 实测/声明 |
|---|---|
| SDK | `1.32.1`，MIT，`"type":"module"`，同时提供 ESM/CJS exports |
| SDK engines | `node >=18` |
| SDK peer | `zod ^3.25 \|\| ^4.0`；`@cfworker/json-schema` 为 optional peer（未安装） |
| 工作区 zod | lockfile `3.25.76`；`apps/desktop` 与各包实际解析 3.25.76 |
| Node（本机） | `v24.19.0`（`node -v`） |
| TypeScript | 本机根 `5.9.3`；仓库范围 `^5.6.0` |
| 构建 | `tsc -p tsconfig.json`，`module/moduleResolution: NodeNext`，strict |
| 安装依赖数 | 生产 95，含 dev（typescript/@types/node）98 |

许可证分布为隔离目录 `npm install` 后逐包 `package.json` 统计；生产/开发拆分由
`audit-deps.mjs` 读取 `package-lock.json` 的 `dev` 标志计算。

## 构建与启动命令（2.x/4.x 采用）

```bash
# 构建（仓库根；本机 Bash 下 pnpm 直调 corepack）
node "D:/nodejs/node_modules/corepack/dist/pnpm.js" --filter @rebaseagent/run-query build
node "D:/nodejs/node_modules/corepack/dist/pnpm.js" --filter @rebaseagent/mcp-server build

# 或按拓扑构建全部包
node "D:/nodejs/node_modules/corepack/dist/pnpm.js" --filter "./packages/*" build

# 本地启动（源码工作区）
node packages/mcp-server/dist/cli.js --data-dir "D:/path/to/existing/data-dir"
```

- `data-dir` 必须已有且包含可读 `traces/`；CLI 不创建目录、不切换数据根。
- stdout 只输出 MCP 协议；日志走 stderr。
- 本机 WorkBuddy 5.9.0 的 MCP 配置位置是 `~/.workbuddy/mcp.json`，
  `command` 用 Node 绝对路径、`args` 指向 `dist/cli.js` 与数据根；**该配置尚未在真实客户端验证**。

## 协议级最小验证（非真实客户端）

隔离服务只注册一个 `list_runs` 工具（strict `limit` 1–100，只读 annotations），
客户端用官方 SDK 的 `Client` + `StdioClientTransport` 启动真实子进程。结果：

- 初始化成功：服务名/版本可见，`tools/list` 恰一个工具，annotations 四项符合预期。
- 空 `traces/` → `structuredContent.runs = []`，合法空列表。
- 非空 `traces/` → 按文件名排序、`limit` 生效。
- `limit: 0` → 工具错误 `isError: true`，SDK 参数校验拒绝（`Number must be greater than or equal to 1`）。
- 无 `--data-dir` / 相对路径 / 缺 `traces/` → 退出码 2、stdout 为空、stderr 固定码 `DATA_DIR_INVALID`。

证据：`.workbuddy/mcp0-spike/spike-result.json`；源码 `src/server.ts`、`client.mjs`；
`tsc -p tsconfig.json` exit 0。该验证证明 SDK/Node/zod/NodeNext 组合可用，**不证明 WorkBuddy 兼容**。

## 未验证与风险

- **真实 WorkBuddy 5.9.0 已完成支持路径验证**：项目级 `.mcp.json` 被内置 CodeBuddy CLI 2.165.0
  识别为 `type: stdio`，`mcp get` 返回 `Status: ✓ Connected`，服务端账本记录 `initialized` 与
  `tools/list`。客户端工具执行审批显示 `Needs approval`，实际 `list_runs` 调用与 GUI 代表任务归 6.2。
- SDK 依赖树包含 HTTP/SSE/auth 传输依赖；首版只用 stdio，安装体积约 14.1 MiB。若后续需要缩小分发体积，
  再评估专用 stdio 入口或打包裁剪，不在本次范围。
- 工作区当前 TypeScript 根版本 5.9.3，高于各包声明的 `^5.6.0`；SDK 类型在 NodeNext 下编译通过。
- 桌面 main 为 CJS 且 externalize workspace 包；2.x 需真实 Electron 启动验证 `require(ESM)` 路径（见闭包清单风险 1）。
