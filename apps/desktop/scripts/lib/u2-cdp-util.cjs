/* U2 5.x 公共设施：真实改变 Electron 窗口尺寸 + CDP 会话 + 截图。
 *
 * 为什么必须"真实改窗口"而不是 Emulation：
 *   实测（2026-09-23）`Emulation.setDeviceMetricsOverride` 会把布局视口伪造到 1440，
 *   但 Monaco 的 automaticLayout 基于真实元素尺寸 ⇒ 左侧 editor 被压成 36px（vs 正常 447），
 *   **Monaco 内部几何在 Emulation 下不可信**。故宽档矩阵一律用 PowerShell MoveWindow
 *   真实改窗口，再经 CDP 采集 —— 这样 Monaco/断点/滚动全部是真值。
 *
 * 本机约束（2026-09-23 实测，CDP `screen.width/height` + `devicePixelRatio` 证实）：
 *   物理屏 2560×1600 @ Windows 缩放 210% ⇒ CSS 桌面 1220×762（DPR 基线 2.1），
 *   可达 CSS 视口上限 ≈ 1207（「1210 档」实测 1207 的由来）；design D7 的 1440/1360
 *   在**本机物理不可达**（须外接更大屏）。
 *   ⚠️ DPI-unaware PowerShell 读到的「物理 1707×1067 @141%」是**虚拟化假象**
 *   （虚拟化系数 1.5：MoveWindow/GetWindowRect 的 1704 实际落在 2560 物理档）。
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

// __dirname = <repo>/apps/desktop/scripts/lib ⇒ 需回退四层才是仓库根
const REPO = join(__dirname, "..", "..", "..", "..");
// ⚠️ 用 ps-dbg.ps1 而不是 ps-win.ps1（2026-10-08 实测）：ps-win 要求窗口标题**恰为**
//    `ReBaseAgent`，而 dev 下标题带变体 ⇒ 枚举不到、返回空串（静默无操作）。
//    ps-dbg 按类名枚举且逐步落盘 ps-dbg-steps.txt，改窗后可自证走到第几步。
const WIN_PS1 = join(REPO, ".workbuddy", "ps-dbg.ps1");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 让 PowerShell 改窗口外框尺寸；返回实测外框字符串。 */
function setWindowOuter(width, height) {
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      WIN_PS1,
      "-OuterWidth",
      String(width),
      "-OuterHeight",
      String(height),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return (r.stdout ?? "").trim();
}

function cdpConnect(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`)
    .then((r) => r.json())
    .then((pages) => pages.find((p) => p.type === "page"));
}

function makeSession(pageUrl, opts = {}) {
  const ws = new WebSocket(pageUrl);
  let id = 0;
  const pending = new Map();
  const consoleLines = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
    if (m.method === "Runtime.consoleAPICalled") {
      const txt = (m.params.args || []).map((a) => a.value).join(" ");
      consoleLines.push(txt);
      if (opts.onConsole) opts.onConsole(txt);
    }
  };
  return new Promise((res, rej) => {
    ws.onopen = () => {
      const call = (method, params = {}) =>
        new Promise((ok) => {
          const i = ++id;
          pending.set(i, ok);
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      call.consoleLines = consoleLines;
      res(call);
    };
    ws.onerror = rej;
  });
}

function call0(call, method, params) {
  return new Promise((ok, rej) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rej(new Error(`timeout ${method}`));
      }
    }, 12000);
    call(method, params)
      .then((r) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ok(r);
        }
      })
      .catch((e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rej(e);
        }
      });
  });
}

async function ev(call, expression) {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails)}`);
  return r?.result?.value;
}

async function shot(call, dir, name) {
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { data } = await call0(call, "Page.captureScreenshot", { format: "png" });
      mkdirSync(dir, { recursive: true });
      const file = join(dir, name);
      writeFileSync(file, Buffer.from(data, "base64"));
      return file;
    } catch (e) {
      last = e;
      await sleep(700);
    }
  }
  throw last ?? new Error(`shot failed: ${name}`);
}

module.exports = { REPO, sleep, setWindowOuter, cdpConnect, makeSession, call0, ev, shot };
