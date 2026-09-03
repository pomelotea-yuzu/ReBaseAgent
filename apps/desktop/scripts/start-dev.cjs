"use strict";
/**
 * dev 启动器：清除会被 Electron 系 IDE / Agent 宿主继承、并破坏主进程
 * 内建模块解析的环境变量后，再转交 electron-vite dev。
 *
 * 背景（见仓库 HANDOFF「阻塞问题」节）：
 * VSCode / Cursor / TRAE 等 Electron 系宿主常把 ELECTRON_RUN_AS_NODE=1 注入
 * 子进程环境。该模式下 electron 二进制按纯 Node 运行，require("electron")
 * 不会命中内建模块（此时 process.versions.electron 仍会报告版本号，容易误判），
 * 而是解析到 npm 包的 exe 路径字符串 → electron.app 为 undefined → 顶层崩溃。
 *
 * 另：部分 Agent 沙箱会注入 NODE_OPTIONS=--require=...shim，在 Electron 引导
 * 早期抢先加载第三方 require 钩子，存在干扰内建模块注册的竞态风险，一并清除。
 *
 * 两个变量在本机正常终端通常不存在，delete 无副作用；此脚本是纯防御。
 */
for (const name of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) {
  delete process.env[name];
}

const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");
const { spawn } = require("node:child_process");

// electron-vite 的 CLI 真实入口（不经 .bin/*.CMD，避免 shell 差异）。
// exports 只放行 ./package.json，故先解析包清单再拼 bin 路径。
const req = createRequire(__filename);
const pkgDir = dirname(req.resolve("electron-vite/package.json"));
const cli = join(pkgDir, "bin", "electron-vite.js");

// 透传 launcher 收到的额外参数（如 --rendererOnly），默认 dev
const args = ["dev", ...process.argv.slice(2)];

const child = spawn(process.execPath, [cli, ...args], {
  stdio: "inherit",
  env: process.env,
  windowsHide: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
