/* U1 7.2 · 200% 独立缩放的稳定复用：applyMetrics 后等待充分再读 DOM 并截图，
   消除 resize 过渡期的半挂载读取，确保证据一致。 */
"use strict";
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const REPO = join(__dirname, "..", "..", "..");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-22-u1-72");
const OUT = join(REPO, ".workbuddy", "u1-72");
const OS_DPR = 2;
const ZOOM_W = 680;
const ZOOM_H = 425;

async function connect() {
  const pages = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
  const page = pages.find((p) => p.type === "page");
  if (!page) throw new Error("no page");
  return page;
}
function session(url) {
  const ws = new WebSocket(url); let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return new Promise((res, rej) => { ws.onopen = () => res((method, params = {}) => new Promise((ok) => { const i = ++id; pend.set(i, (m) => ok(m.result)); ws.send(JSON.stringify({ id: i, method, params })); })); ws.onerror = rej; });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (call, expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails));
  return r.result?.value;
};
function call0(call2, method, params) {
  return new Promise((ok, rej) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; rej(new Error("timeout " + method)); } }, 12000);
    call2(method, params).then((r) => { if (!settled) { settled = true; clearTimeout(timer); ok(r); } })
      .catch((e) => { if (!settled) { settled = true; clearTimeout(timer); rej(e); } });
  });
}
async function shot(call, name) {
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  let last;
  for (let i = 0; i < 6; i++) {
    try { const { data } = await call0(call, "Page.captureScreenshot", { format: "png" });
      const f = join(SHOT_DIR, name); writeFileSync(f, Buffer.from(data, "base64")); return f; }
    catch (e) { last = e; await sleep(700); }
  }
  throw last;
}
const shellExpr = `(() => {
  const rect = (e) => e ? Math.round(e.getBoundingClientRect().width) : null;
  const aside = document.querySelector('main aside');
  const sections = Array.from(document.querySelectorAll('main section')).map(s => (s.innerText||'').slice(0,8));
  return JSON.stringify({
    cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
    dpr: devicePixelRatio,
    bodyOk: document.body.scrollWidth <= document.body.clientWidth,
    bodySw: document.body.scrollWidth, bodyCw: document.body.clientWidth,
    navW: aside ? rect(aside) : null, navPresent: !!aside,
    detailW: rect(document.querySelector('main section[class*="flex-1"]')),
    hasOverviewTab: !!Array.from(document.querySelectorAll('[role="tab"]')).find(t => (t.textContent||'').includes('概览')),
    hasReadable: (document.body.innerText||'').length > 0,
    sections,
  });
})()`;
const bpOf = (w) => (w >= 1280 ? "wide" : w >= 960 ? "medium" : w >= 720 ? "narrow" : "single");

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const page = await connect();
  const call = await session(page.webSocketDebuggerUrl);
  await call("Page.enable"); await call("Runtime.enable");
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  // 一档中间尺寸（medium）把导航拉回常驻并写默认行为，再进 200% 仿真
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: OS_DPR, mobile: false });
  await sleep(700);
  await call("Emulation.setDeviceMetricsOverride", { width: ZOOM_W, height: ZOOM_H, deviceScaleFactor: OS_DPR * 2, mobile: false });
  await sleep(1200); // 充分等待：breakpoint 跨档后 React 已复位临时/偏好
  const raw = await ev(call, shellExpr);
  const s = JSON.parse(raw);
  console.log(JSON.stringify(s, null, 2));
  console.log("breakpoint=" + bpOf(s.cw));
  const f = await shot(call, "c1-zoom200-680px.png");
  console.log("shot ->", f);
  writeFileSync(join(OUT, "zoom200-settled.json"), JSON.stringify({ s, breakpoint: bpOf(s.cw), zoomWidth: ZOOM_W, osDpr: OS_DPR }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });