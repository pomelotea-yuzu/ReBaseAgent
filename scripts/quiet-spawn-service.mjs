#!/usr/bin/env node
/**
 * 静默起（或停）本机 OpenAI 兼容服务，供真实 provider 冒烟用。
 *
 * 为什么需要它：在 Windows 沙箱里起本机服务有几个已知的坑，本脚本把它们一次绕开——
 *   1. `Start-Process`（PowerShell）会因当前进程环境里 `http_proxy`/`HTTP_PROXY`、
 *      `Path`/`PATH` 这类**大小写重复键**而抛「已添加项。字典中的关键字...」直接崩溃
 *      （Windows 环境变量大小写不敏感，.NET 环境字典构造要求键唯一）；
 *   2. bash 的 `&` 起的进程会随宿主 shell 退出被回收；
 *   3. `cmd /c start /B` 在 WorkBuddy 的 bash shim 里会退化成交互式 cmd；
 *   4. WMI `Win32_Process.Create("cmd.exe /c ...")` 能起来，但**会带出可见控制台窗口**，
 *      用户顺手叉掉就会让服务中途消失（后续请求报 ECONNREFUSED，徒增排障成本）。
 *
 * 本脚本用 node 的 `spawn` + `windowsHide: true` + `detached: true`，并手工构造最小
 * 环境变量（不含代理、只有一对大小写正确的键），从源头避免上述全部问题。
 *
 * 用法：
 *   node scripts/quiet-spawn-service.mjs ollama                # 起本机 Ollama
 *   node scripts/quiet-spawn-service.mjs ollama --stop         # 停（读 pid 文件）
 *   node scripts/quiet-spawn-service.mjs --exe "D:\path\x.exe" --args serve
 *
 * 起服务后会轮询端口，确认监听再退出（不确认就返回等于假装成功）。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";

const ROOT = process.cwd();
const PID_FILE = path.join(ROOT, ".tmp-quiet-spawn.pid");
const LOG_FILE = path.join(ROOT, ".tmp-quiet-spawn.log");

/** 预设服务（避免每次手敲路径） */
const PRESETS = {
  ollama: {
    exe: "D:\\Ollama\\ollama\\ollama.exe",
    args: ["serve"],
    port: 11434,
    env: {
      OLLAMA_MODELS: "D:\\Ollama\\models",
      OLLAMA_HOST: "127.0.0.1:11434",
    },
  },
};

/** 最小环境变量：只有一对大小写正确的基础键 + 服务自身需要的键，且不含代理 */
function minimalEnv(extra = {}) {
  return {
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    TEMP: process.env.TEMP ?? "C:\\Windows\\Temp",
    TMP: process.env.TMP ?? "C:\\Windows\\Temp",
    PATH: "C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem",
    // 显式声明 localhost 不走代理（本机 HTTP_PROXY 会劫持 localhost）
    NO_PROXY: "127.0.0.1,localhost",
    ...extra,
  };
}

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

async function waitForPort(port, seconds) {
  for (let i = 1; i <= seconds; i++) {
    if (await probePort(port)) return i;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function parseArgv(argv) {
  const out = { name: null, exe: null, args: null, stop: false, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stop") out.stop = true;
    else if (a === "--exe") out.exe = argv[++i];
    else if (a === "--args") out.args = (argv[++i] ?? "").split(" ").filter(Boolean);
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (!out.name) out.name = a;
  }
  return out;
}

function stopService() {
  if (!fs.existsSync(PID_FILE)) {
    console.log("no pid file; nothing to stop");
    return;
  }
  const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
  // 用 taskkill /T /F 杀**进程树**：服务常自 fork 子进程（如 ollama 的 runner），
  // 只杀父 pid 会留下孤儿监听；且 node 的 process.kill 对 detached 进程在 Windows
  // 上不可靠（常报 ESRCH）。node 在 Windows 下 spawnSync('taskkill') 需要 shell:false
  // 且路径可直接调用系统命令。
  const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.error) {
    console.log(`taskkill pid=${pid} failed: ${r.error.message}`);
  } else {
    // /T 会连子进程一起杀；若子进程已随父退出，taskkill 会报"没有找到进程"并以非 0 退出，
    // 这属于正常情形（我们只要最终端口不再监听）。故只报告、不视为失败。
    const detail = `${(r.stdout ?? "").trim()} ${(r.stderr ?? "").trim()}`.trim();
    console.log(`taskkill pid=${pid} (tree) exit=${r.status}${detail ? `\n${detail}` : ""}`);
  }
  fs.rmSync(PID_FILE, { force: true });
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));

  if (opts.stop) {
    stopService();
    return;
  }

  const preset = opts.name ? PRESETS[opts.name] : null;
  const exe = opts.exe ?? preset?.exe;
  const args = opts.args ?? preset?.args ?? [];
  const port = opts.port ?? preset?.port ?? null;

  if (!exe) {
    console.error("need a service name (ollama) or --exe <path>");
    process.exit(2);
  }
  if (!fs.existsSync(exe)) {
    console.error(`exe not found: ${exe}`);
    process.exit(2);
  }

  const out = fs.openSync(LOG_FILE, "a");
  const child = spawn(exe, args, {
    detached: true,
    stdio: ["ignore", out, out],
    // 关键：不创建控制台窗口——否则用户看到窗口会顺手叉掉服务
    windowsHide: true,
    env: minimalEnv(preset?.env),
  });
  child.unref();
  fs.writeFileSync(PID_FILE, `${child.pid}\n`, "utf8");
  console.log(`spawned pid=${child.pid} (hidden window): ${exe} ${args.join(" ")}`);

  if (port !== null) {
    const ready = await waitForPort(port, 30);
    if (ready === null) {
      console.error(`port ${port} not listening after 30s — check ${LOG_FILE}`);
      process.exit(1);
    }
    console.log(`port ${port} listening after ${ready}s`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
