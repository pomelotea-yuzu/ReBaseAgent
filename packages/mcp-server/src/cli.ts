#!/usr/bin/env node
import { createDiagnosticLog } from "./diagnostics.js";
import { createQueryServer } from "./server.js";
import { STARTUP_EXIT_CODE, parseStartupArgv } from "./startup.js";
import { READONLY_TOOLS } from "./tools.js";

/**
 * CLI 入口：`node packages/mcp-server/dist/cli.js --data-dir <已有绝对路径>`。
 *
 * 顺序（design D3）：**数据根核验先于任何协议动作**——核验不过就不初始化、不协商、
 * 不连接 stdio 通道，只往 stderr 写一行固定码并以非零退出；不 mkdir、不换数据根。
 * 核验过了才交给官方 SDK 走 initialize / tools/list / tools/call，
 * 并在通道关闭（客户端 EOF）或收到中断信号后落定退出。
 *
 * 本文件不出现 `console.*`：stdout 只能承载 JSON-RPC 帧。
 */

const log = createDiagnosticLog();
const outcome = parseStartupArgv(process.argv.slice(2));

if (!outcome.ok) {
  log.event("startup_rejected", { code: outcome.code, reason: outcome.reason });
  process.exitCode = STARTUP_EXIT_CODE;
} else {
  const handle = createQueryServer(outcome.root, READONLY_TOOLS, log);
  const shutdown = (signal: string): void => {
    log.event("signal_shutdown", { signal });
    void handle.close();
  };
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  await handle.serve();
  process.exitCode = 0;
}
