#!/usr/bin/env node
/**
 * U2 5.x 专用：**持久**起本机 dev（带 CDP），供 CDP 探针连。
 *
 * 为什么不能直接 `node scripts/start-dev.cjs ... &`：
 *   bash 的 `&` 起的进程会随宿主 shell 退出被回收 —— 上一个会话里 CDP 起来后
 *   下一个 Bash 调用就 ECONNREFUSED，正是这个原因。故改用 node `spawn` +
 *   `detached: true` + `unref()`，stdio 全部重定向到日志文件（不留控制台窗口），
 *   再轮询 CDP 端口确认监听后才退出（不确认即等于假装成功）。
 *
 * ⚠️ 端口必须是**未被 Windows 排除**的端口：本机 netsh 排除范围含 9194–9293
 *    （Hyper-V/WSL 保留）⇒ 9222 会 bind 失败（`0x271D` WSAEACCES），
 *    devtools http server 起不来。故默认用 9612（不在排除表内）。
 *
 * 用法：
 *   node apps/desktop/scripts/u2-dev-host.cjs                 # 起（端口 9612）
 *   node apps/desktop/scripts/u2-dev-host.cjs --port 9613     # 换端口
 *   node apps/desktop/scripts/u2-dev-host.cjs --stop          # 停（杀进程树）
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { createConnection } = require("node:net");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..", "..");
const PID_FILE = path.join(REPO, ".workbuddy", "u2-5-dev.pid");
const LOG_FILE = path.join(REPO, ".workbuddy", "u2-5-dev.log");

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(argOf("port", "9612"));
const STOP = process.argv.includes("--stop");

function probePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
  });
}

async function waitForCdp(port, seconds) {
  for (let i = 1; i <= seconds; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return i;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function stop() {
  if (!fs.existsSync(PID_FILE)) {
    console.log("no pid file; nothing to stop");
    return;
  }
  const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
  const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    encoding: "utf8",
  });
  const detail = `${(r.stdout ?? "").trim()} ${(r.stderr ?? "").trim()}`.trim();
  console.log(`taskkill pid=${pid} (tree) exit=${r.status}${detail ? `\n${detail}` : ""}`);
  fs.rmSync(PID_FILE, { force: true });
}

async function main() {
  if (STOP) {
    stop();
    return;
  }
  if (await probePort(PORT)) {
    console.log(`port ${PORT} already listening — assume dev running`);
    return;
  }
  const out = fs.openSync(LOG_FILE, "w");
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "start-dev.cjs"), `--remoteDebuggingPort=${PORT}`],
    {
      cwd: path.join(REPO, "apps", "desktop"),
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      env: { ...process.env, NO_SANDBOX: "1" },
    },
  );
  child.unref();
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, `${child.pid}\n`, "utf8");
  console.log(`spawned dev pid=${child.pid} port=${PORT}; log=${LOG_FILE}`);

  const ready = await waitForCdp(PORT, 40);
  if (ready === null) {
    console.error(`CDP port ${PORT} not listening after 40s — check ${LOG_FILE}`);
    process.exit(1);
  }
  console.log(`CDP listening on ${PORT} after ${ready}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
