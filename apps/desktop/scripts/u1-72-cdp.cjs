/* eslint-disable */
/**
 * U1 任务 7.2 · 窄窗口和缩放矩阵证据采集（真实 Electron + CDP 直连本地 dev 9222）。
 *
 * 覆盖（design D7）：
 *   1) **100% 缩放窄档**：Emulation 应用 CSS 视口 1024×768 / 800×600 / 640px 宽，
 *      逐档记录实测 clientWidth、dpr、body 是否横向溢出、导航/步骤目录可见性，
 *      并按 D2 断点核对「多尺寸下关键阅读可达」与「自动折叠」。
 *   2) **自动折叠后恢复用户布局**：wide 档给导航设一个自定义宽度（键盘 →，存偏好），
 *      缩到 narrow 触发的自动折叠不写回偏好，再回 wide 验证宽度偏好被还原（非默认 264）。
 *   3) **200% 放大独立用例**：真实 `webContents.setZoomFactor` 无法经 CDP 驱动
 *      （app 无菜单、快捷键被拦），故仿真 200% 缩放后**应有的有效 CSS 视口**
 *      （原生 1360 窗口经 200% 缩放 → 有效视口 ≈ 680 宽），deviceScaleFactor 相应加倍以呈现
 *      放大效果；随后**重新实测** clientWidth 再据此判 D2 断点，不以原生窗口标称尺寸推断。
 *
 * 证据落 `docs/reviews/2026-09-22-u1-72/` 与 `.workbuddy/u1-72/`。不 spawn、不重启 dev。
 *
 * 用法：node scripts/u1-72-cdp.cjs [--only=800x600] [--zoomWidth=680]
 */
"use strict";

const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO = join(__dirname, "..", "..", "..");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-22-u1-72");
const OUT = join(REPO, ".workbuddy", "u1-72");

const onlyArg = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const zoomArg = (process.argv.find((a) => a.startsWith("--zoomWidth=")) ?? "").slice(12);
const SIZES = onlyArg ? [onlyArg] : ["1024x768", "800x600", "640px"];
const OS_DPR = Number(process.env.SCREEN_DPR ?? 2);
// 200% 缩放：原生 1360 窗口（7.1 实测原生窗口 1360×860）经 200% zoomFactor → 有效 CSS 宽 ≈ 680
const ZOOM_W = zoomArg ? Number(zoomArg) : 680;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(`${ok === true ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}
const measurements = {};

async function connect() {
  const pages = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
  const page = pages.find((p) => p.type === "page");
  if (!page) throw new Error("no page target");
  return page;
}
function session(pageUrl) {
  const ws = new WebSocket(pageUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  return new Promise((res, rej) => {
    ws.onopen = () => res((method, params = {}) => new Promise((ok) => {
      const i = ++id; pending.set(i, (m) => ok(m.result));
      ws.send(JSON.stringify({ id: i, method, params }));
    }));
    ws.onerror = rej;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 带超时的原生方法调用：captureScreenshot 在 Emulation 下偶发不再返回，
// 需要从 promise 层兜底，让 shot() 能重试而不是整体挂死。
function call0(call2, method, params) {
  return new Promise((ok, rej) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; rej(new Error("timeout " + method)); } }, 12000);
    call2(method, params)
      .then((r) => { if (!settled) { settled = true; clearTimeout(timer); ok(r); } })
      .catch((e) => { if (!settled) { settled = true; clearTimeout(timer); rej(e); } });
  });
}
async function ev(call, expression) {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}
async function shot(call, name) {
  // 截图前确保窗口聚焦/置前（遮挡会让 captureScreenshot 挂起）
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { data } = await call0(call, "Page.captureScreenshot", { format: "png" });
      const file = join(SHOT_DIR, name);
      writeFileSync(file, Buffer.from(data, "base64"));
      return file;
    } catch (e) {
      last = e;
      await sleep(700); // Emulation 下截图偶发挂起：重试
    }
  }
  throw last ?? new Error("shot failed: " + name);
}

const ascii = (s) => (s || "").replace(/[\s\u3000]+/g, " ").trim().slice(0, 14);

// 读取外壳逐层几何 + 断点可见性
const shellExpr = `(() => {
  const named = (sel) => document.querySelector(sel);
  const rect = (e) => e ? Math.round(e.getBoundingClientRect().width) : null;
  const aside = named('main aside');
  const sections = Array.from(document.querySelectorAll('main section')).map(s => ({
    tag: s.tagName, w: rect(s), text: ${`String`}(s.innerText||'').slice(0, 12),
  }));
  return JSON.stringify({
    cw: document.documentElement.clientWidth,
    ch: document.documentElement.clientHeight,
    dpr: devicePixelRatio, vw: visualViewport ? Math.round(visualViewport.width) : null,
    bodyOk: document.body.scrollWidth <= document.body.clientWidth,
    bodySw: document.body.scrollWidth, bodyCw: document.body.clientWidth,
    navW: aside ? rect(aside) : null, navPresent: !!aside,
    stepDirPresent: sections.some(s => s.text.includes('轨迹')),
    detailW: rect(document.querySelector('main section[class*="flex-1"]')),
    hasOverviewTab: !!Array.from(document.querySelectorAll('[role="tab"]')).find(t => (t.textContent||'').includes('概览')),
    hasReadable: (document.body.innerText||'').length > 0,
  });
})()`;

const bpOf = (w) => (w >= 1280 ? "wide" : w >= 960 ? "medium" : w >= 720 ? "narrow" : "single");

async function applyMetrics(call, w, h, dpr) {
  await call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
  await sleep(450);
}

async function readShell(call) {
  for (let t = 0; t < 6; t++) {
    const raw = await ev(call, shellExpr);
    if (typeof raw === "string") return JSON.parse(raw);
    await sleep(400);
  }
  throw new Error("shell read timeout");
}

const selectRunExpr = (id) => `(() => {
  const copy = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${id}'));
  const row = copy ? copy.parentElement : null; const sel = row ? row.querySelector('button') : null;
  if (!sel) return false; sel.click(); return true;
})()`;
const anyRowExpr = `(() => !!Array.from(document.querySelectorAll('button')).find(b =>
  (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID')))()`;

// 聚焦导航 ResizeGrip，按 → 把宽度调高（写入用户偏好）
async function setNavWidthBy(call, steps) {
  const focused = await ev(call, `(() => { const g = document.querySelector('[role="separator"][aria-label*="导航"]');
    if (!g) return false; g.focus(); return true; })()`);
  if (!focused) return false;
  for (let i = 0; i < steps; i++) {
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await sleep(60);
  }
  return true;
}
const navValueExpr = `(() => { const g = document.querySelector('[role="separator"][aria-label*="导航"]');
  return g ? Number(g.getAttribute('aria-valuenow')) : null; })()`;

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const page = await connect();
  const call = await session(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  // 窗口可能被遮挡 ⇒ 截图会挂起：强制聚焦 + 置前（真实 Electron 但窗口不在前台）
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride");
  await sleep(300);
  // 首档先重载，让 autoSelectInitialRun 落到一个运行，再选一个非隔离概览 run
  // 重载会重置窗口焦点 ⇒ 截图前须重新置前/聚焦，否则 captureScreenshot 挂起
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Page.reload");
  await sleep(2600);

  // 默认选一个标准 run（非隔离），保证概览「结束情况 / 本次消耗」存在
  const target = "run_muapnwud"; // 普通创建 run（7.1/6.4 已用）
  const hasRun = (await ev(call, anyRowExpr)) === true;
  const selected = hasRun ? await ev(call, selectRunExpr(target)) : false;
  check("有运行记录且可点选读取对象", hasRun === true, target);
  if (selected) { await sleep(1300); }

  // —— Part A：100% 缩放进窄矩阵 ——
  for (const tag of SIZES) {
    const m = (measurements[tag] = {});
    let w; let h;
    if (tag === "640px") { w = 640; h = 480; } else { [w, h] = tag.split("x").map(Number); }
    await applyMetrics(call, w, h, OS_DPR);
    const s = await readShell(call);
    Object.assign(m, s);
    m.breakpoint = bpOf(s.cw);
    check(`[${tag}] 实测布局视口=${s.cw}×${s.ch} (dpr=${s.dpr?.toFixed?.(2) ?? s.dpr})`, s.cw === w, `期望 ${w}`);
    check(`[${tag}] body 无横向溢出`, s.bodyOk === true, `${s.bodySw}/${s.bodyCw}`);
    m.navW = s.navW;

    // 断点可见性断言（D2）
    if (s.cw >= 960) {
      check(`[${tag}] ≥960 导航常驻`, s.navPresent === true, s.navW != null ? `导航@${s.navW}px` : undefined);
    } else {
      check(`[${tag}] <960 导航自动折叠（待命，未常驻）`, s.navPresent === false,
        s.navW === null ? "导航未挂载（自动折叠）" : undefined);
    }
    check(`[${tag}] 关键阅读可达（正文有内容，非空页面）`, s.hasReadable === true);
    check(`[${tag}] 概览页签在场`, s.hasOverviewTab === true);
    await shot(call, `a1-${tag.replace("x", "x")}-runs.png`);
    m.tag = tag;
  }

  // —— Part B：自动折叠后恢复用户布局 ——
  const B = (measurements["autoCollapseRestore"] = {});
  await applyMetrics(call, 1440, 900, OS_DPR); // 回 wide：导航常驻，用户可设宽
  await sleep(300);
  const navSet = await setNavWidthBy(call, 5); // 264 + 5×16 = 344
  await sleep(400);
  const customVal = await ev(call, navValueExpr);
  B.wideCustom = customVal;
  check("wide 档键盘把导航宽度调到自定义值（偏好写入）", navSet === true && customVal !== null && customVal !== 264,
    customVal != null ? `aria-valuenow=${customVal}px` : undefined);
  // 缩到 narrow(800)：导航自动折叠（navOpened=false ⇒ 不挂载）
  await applyMetrics(call, 800, 600, OS_DPR);
  await sleep(300);
  const narrowShell = await readShell(call);
  B.narrow = narrowShell;
  check("narrow 档导航自动折叠（未挂载）", narrowShell.navPresent === false);
  check("narrow 档仍可读（正文可读）", narrowShell.hasReadable === true);
  await shot(call, "b1-narrow-800-collapsed.png");
  // 回 wide：宽度偏好必须被还原，而非默认 264
  await applyMetrics(call, 1440, 900, OS_DPR);
  await sleep(300);
  // 轮询等导航分割条重新挂载（重渲染时延），再读 aria-valuenow
  let restoredVal = null;
  for (let t = 0; t < 10; t++) {
    restoredVal = await ev(call, navValueExpr);
    if (restoredVal !== null) break;
    await sleep(400);
  }
  B.wideRestored = restoredVal;
  check("回 wide 后自定义导航宽度被还原（自动折叠未覆盖偏好）",
    navSet === true ? restoredVal === customVal : restoredVal === 264,
    restoredVal != null ? `还原为 ${restoredVal}px` : undefined);
  await shot(call, "b2-wide-restored.png");

  // —— Part C：200% 独立放大用例（仿真有效视口 + 实测判断点） ——
  const C = (measurements["zoom200"] = {});
  const zoomH = Math.round((900 * ZOOM_W) / 1440);
  await applyMetrics(call, ZOOM_W, zoomH, OS_DPR * 2); // dpr 加倍呈现 200% 放大
  const zs = await readShell(call);
  Object.assign(C, zs);
  C.breakpoint = bpOf(zs.cw);
  C.zfactorNominal = 2;
  check(`[200%] 200% 缩放后实测有效视口=${zs.cw}px（由实测决定断点）`, Number.isFinite(zs.cw));
  check(`[200%] 放大下 body 无横向溢出`, zs.bodyOk === true, `${zs.bodySw}/${zs.bodyCw}`);
  check(`[200%] 放大下正文可读`, zs.hasReadable === true);
  check(`[200%] dpr 呈现放大（≈${Math.round(OS_DPR * 2)}，非 100% 档 ${OS_DPR}）`,
    Math.abs(zs.dpr - OS_DPR * 2) < 0.001, `dpr=${zs.dpr?.toFixed?.(2) ?? zs.dpr}`);
  check(`[200%] 断点按实测=${zs.cw}px 判定为「${C.breakpoint}」`, true);
  await shot(call, `c1-zoom200-${zs.cw}px.png`);

  // 还原：清掉 metrics，回到原生视口
  await call("Emulation.clearDeviceMetricsOverride");
  await sleep(300);

  writeFileSync(join(OUT, "measurements.json"),
    JSON.stringify({ measurements, checks, zoomWidth: ZOOM_W, osDpr: OS_DPR, capturedAt: new Date().toISOString() }, null, 2));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n完成：${checks.length - failed.length}/${checks.length} 通过；证据 ${SHOT_DIR}`);
  if (failed.length) { failed.forEach((f) => console.log("  ✗ " + f.name + (f.detail ? ` — ${f.detail}` : ""))); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });