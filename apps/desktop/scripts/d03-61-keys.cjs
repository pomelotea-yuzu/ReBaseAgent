/* eslint-disable */
/**
 * MCP0 任务 6.1 · D03 键盘档（CDP 受信键通道）。
 *
 * spec 原文（specs/desktop-ui/spec.md:15-17）：
 *   WHEN …抽查窄窗/200%/键盘  THEN 阅读位置/焦点/可达性保持，无新导航、无执行登记，原数据不变
 *
 * 只有一个 tag：`keys` —— CDP `Input.dispatchKeyEvent`（浏览器层受信事件）做 Tab 步进 +
 * Enter 激活，是"键盘能走到并激活只读链"的下限证据。
 * 🔴 OS 真键盘**不在这个脚本里**：`keybd_event`（node 侧与用户 PowerShell 侧各实测一次）本机
 *    Windows 回显 `RESULT=sent` + `foreground same=True`，页面却零收键 —— 系统键盘投递进不到
 *    该 Electron 窗口。真键盘证据改由 `d03-61-keys-manual.cjs`（人工按键、脚本只观察不注入）交付；
 *    失败通道读数留在 .workbuddy/mcp0-61/d03-realkeys-measurements.json 与 keys-*.txt 回显。
 *
 * 前置：dev 带 CDP 9612 已起（100% 档）；跑法清代理：
 *   HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= node apps/desktop/scripts/d03-61-keys.cjs --tag=keys
 */
"use strict";
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const U = require("./lib/u2-cdp-util.cjs");

const TAG = (() => {
  const hit = process.argv.find((a) => a.startsWith("--tag="));
  return hit ? hit.slice(6) : "";
})();
if (TAG !== "keys") {
  console.error("用法：--tag=keys");
  process.exit(2);
}

const DATA = join(H.REPO, ".rebaseagent");
const OUT = join(H.REPO, ".workbuddy", "mcp0-61");
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });
const PARENT = "run_mvhmwr6f_ia6xbg";
const CHILD = "run_mvhn8q64_c6ds";
const TIER = "键盘档CDP";
const PS_RAISE = join(__dirname, "lib", "d03-raise.ps1");

const WRITE_WHITELIST = [
  /^traces\/[^/]+\.jsonl$/,
  /^traces\/tmp-create-[^/]+\.tmp$/,
  /^workspace-blobs\/sha256\/[0-9a-f]{64}$/,
  /^current-source\/gone\.txt$/,
];
const KNOWN_DEBRIS = [/^traces\/tmp-measure-[a-z0-9-]+\.tmp$/];

const checks = [];
const dump = { tag: TAG, focusTrail: [], clicks: [], viewport: null, nav: [] };
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(
    `${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
  return ok === true;
}
function must(name, ok, detail) {
  if (check(name, ok, detail)) return;
  finish();
}
function note(text, detail) {
  console.log(`ℹ ${text}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function finish() {
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    join(OUT, `d03-${TAG}-measurements.json`),
    JSON.stringify(
      { tag: TAG, generatedAt: new Date().toISOString(), checks, failed: failed.length, dump },
      null,
      2,
    ),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 10 分钟未收尾`);
  process.exit(3);
}, 600_000);

function fingerprint() {
  const files = [];
  const walk = (dir, rel) => {
    for (const n of readdirSync(dir)) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(dir, n)).isDirectory()) walk(join(dir, n), r);
      else files.push(r);
    }
  };
  for (const root of ["traces", "workspace-blobs", "current-source"]) {
    if (existsSync(join(DATA, root))) walk(join(DATA, root), root);
  }
  const entries = {};
  const off = [];
  for (const r of files) {
    if (!WRITE_WHITELIST.some((re) => re.test(r))) off.push(r);
    entries[r] = createHash("sha256")
      .update(readFileSync(join(DATA, r)))
      .digest("hex");
  }
  const settings = join(DATA, "settings.json");
  entries["settings.json"] = existsSync(settings)
    ? createHash("sha256").update(readFileSync(settings)).digest("hex")
    : null;
  return { entries, off };
}

let call = null;
const E = (expr) => H.ev(call, expr);
const Q = (body) => H.storeQ(call, body);
const J = async (expr) => JSON.parse(await E(expr));

async function poll(fn, cond, timeoutMs = 10000, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await fn();
    if (cond(last)) return { ok: true, value: last };
    if (Date.now() > deadline) return { ok: false, value: last };
    await H.sleep(stepMs);
  }
}

const SNAP = `
  const len = (o) => (o && typeof o === "object" ? Object.keys(o).length : -1);
  const execJson = JSON.stringify(
    { confirmations: s.confirmations, draftSubmissions: s.draftSubmissions,
      operations: s.operations, binding: s.currentConfirmationBinding ?? null },
    (k, v) => (typeof v === "function" ? "[fn]" : v));
  return JSON.stringify({
    view: s.view, selectedRunId: s.selectedRunId, selectedSpanId: s.selectedSpanId,
    detailId: s.detail ? s.detail.meta.id : null, runs: s.runs.length,
    tab: s.selectedRunId && s.readingByRun[s.selectedRunId] ? s.readingByRun[s.selectedRunId].tab : null,
    overviewScrollTop: s.selectedRunId && s.readingByRun[s.selectedRunId] ? s.readingByRun[s.selectedRunId].overviewScrollTop : null,
    comparePair: s.comparePair ? { left: s.comparePair.leftRunId, right: s.comparePair.rightRunId } : null,
    compareReturnLocation: s.compareReturnLocation ?? null,
    confirmationCount: len(s.confirmations),
    submissionCount: s.draftSubmissions ? len(s.draftSubmissions.byId) : -1,
    operationCount: len(s.operations),
    forking: s.forking, creatingRun: s.creatingRun, modelAbInFlight: s.modelAbInFlight,
    execJson,
  });`;
const fnv1a = (text) => {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(((h2 + text.charCodeAt(i) * (i + 1)) >>> 0) ^ (h2 >>> 7), 2654435761) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
};
async function snapshot() {
  const raw = await Q(SNAP);
  raw.execHash = fnv1a(String(raw.execJson ?? ""));
  return raw;
}

const DESRIBE_FOCUS = `(() => {
  const a = document.activeElement;
  if (!a) return JSON.stringify({ tag: null });
  return JSON.stringify({
    tag: a.tagName.toLowerCase(),
    id: a.id || null,
    role: a.getAttribute ? a.getAttribute("role") : null,
    aria: a.getAttribute ? a.getAttribute("aria-label") : null,
    cls: String(a.className).slice(0, 40),
    text: (a.textContent || a.value || "").replace(/\\s+/g, " ").trim().slice(0, 26),
    inDoc: document.contains(a),
    tabIndex: a.tabIndex === undefined ? null : a.tabIndex,
    focusableByTab: !["BODY", "HTML"].includes(a.tagName),
  });
})()`;

/** 页内记录器：focusin 轨迹 + click 溯源（isTrusted 用来分辨真键/真鼠 vs el.click()） */
async function installRecorders() {
  await E(
    `(() => {
       window.__k = { focus: [], clicks: [] };
       const desc = (a) => ({
         tag: a.tagName.toLowerCase(), id: a.id || null,
         role: a.getAttribute ? a.getAttribute("role") : null,
         aria: a.getAttribute ? a.getAttribute("aria-label") : null,
         text: (a.textContent || a.value || "").replace(/\\s+/g, " ").trim().slice(0, 26),
         inDoc: document.contains(a), tabIndex: a.tabIndex === undefined ? null : a.tabIndex,
       });
       document.addEventListener("focusin", (e) => {
         if (window.__k.focus.length < 200) window.__k.focus.push(Object.assign({ trusted: e.isTrusted }, desc(e.target)));
       }, true);
       document.addEventListener("click", (e) => {
         const t = e.target && e.target.closest ? e.target.closest("button,[role=tab],a,input,select") : e.target;
         if (window.__k.clicks.length < 200)
           window.__k.clicks.push({ trusted: e.isTrusted, tag: t ? t.tagName.toLowerCase() : null, aria: t && t.getAttribute ? t.getAttribute("aria-label") : null, text: t ? (t.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 26) : null });
       }, true);
       return true;
     })()`,
  );
}
const readTrail = () => J("(() => JSON.stringify(window.__k ? window.__k.focus : []))()");
const readClicks = () => J("(() => JSON.stringify(window.__k ? window.__k.clicks : []))()");
const clearTrail = () =>
  E("(() => { window.__k.focus = []; window.__k.clicks = []; return true; })()");

async function resizeToCss(target, outerHeight) {
  const lo = Math.max(320, Math.round(target * 0.6));
  const hi = Math.round(target * 2.4);
  let w = Math.min(hi, target + 11);
  for (let round = 0; round < 8; round++) {
    await E(`(() => { window.resizeTo(${w}, ${outerHeight}); return true; })()`);
    await H.sleep(650);
    const a = await E("(() => document.documentElement.clientWidth)()");
    await H.sleep(250);
    const b = await E("(() => document.documentElement.clientWidth)()");
    if (a === b && typeof a === "number" && Math.abs(a - target) <= 2)
      return { css: a, outer: w, settled: true };
    if (typeof b !== "number" || b <= 0) break;
    w = Math.max(lo, Math.min(hi, Math.round(target * (w / b))));
  }
  return {
    css: await E("(() => document.documentElement.clientWidth)()"),
    outer: w,
    settled: false,
  };
}

async function press(k, code, vk, text) {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await call("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  if (text) await call("Input.dispatchKeyEvent", { type: "char", text, ...base });
  await call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
const cdpTab = () => press("Tab", "Tab", 9);
const cdpEnter = () => press("Enter", "Enter", 13, "\r");

const focusButtonByAria = (aria) =>
  J(
    `(() => {
       const b = document.querySelector('button[aria-label=' + ${JSON.stringify(JSON.stringify(aria))} + ']');
       if (!b) return JSON.stringify({ ok: false });
       b.focus();
       return JSON.stringify({ ok: true, focused: document.activeElement === b });
     })()`,
  );

function mainPid() {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
  const line = String(r.stdout ?? "")
    .split(/\r?\n/)
    .find((l) => l.includes("TCP") && l.includes("127.0.0.1:9612") && /LISTENING/i.test(l));
  return line ? Number(line.trim().split(/\s+/).pop()) : null;
}

/**
 * 抬前台（AttachThreadInput + BringWindowToTop + SetForegroundWindow，见脚本头注释）。
 * 实测：agent 每跑一条 Bash 命令，宿主就把前台抢回去 ⇒ 页面 hidden、键击默认动作被抑制；
 * 发键前抬一次前台，CDP 的 Tab/Enter 立刻恢复生效（本轮实测：抬窗后 4 次 Tab 轨迹齐全）。
 */
function raise() {
  const pid = mainPid();
  const outFile = join(OUT, `raise-${Date.now()}.txt`);
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      PS_RAISE,
      "-ProcId",
      String(pid),
      "-OutFile",
      outFile,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 60000 },
  );
  const text = existsSync(outFile) ? readFileSync(outFile, "utf8").replace(/^﻿/, "") : "";
  return {
    pid,
    status: r.status,
    error: r.error ? String(r.error).slice(0, 160) : null,
    raised: /RESULT=raised same=True/.test(text),
    tail: text.split(/\r?\n/).slice(-3),
  };
}

async function main() {
  const page = await U.cdpConnect(9612);
  if (!page || !page.webSocketDebuggerUrl) throw new Error("拿不到 page target");
  call = await U.makeSession(page.webSocketDebuggerUrl);
  await call("Runtime.enable");
  await call("Page.enable");
  // 🔴 键盘通道的硬前提（本轮判别实测，别再猜）：agent 跑批时宿主会把前台抢回去，
  //    页面 visibilityState 停在 hidden ⇒ Blink 抑制键击的默认动作（Tab 不移焦点、Enter 不激活），
  //    症状是"轨迹全空"，极易误判成产品键盘可达性坏了。
  //    实测：ps-raise 抬前台仍不够（raised same=True 但轨迹仍为 0）；
  //    开 Emulation.setFocusEmulationEnabled 后 visible 且 Tab/Enter 全部生效。
  //    两条通道都用这支；抬前台仍然保留（OS 真键的投递依赖前台）。
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  dump.focusEmulation = true;

  const alive0 = await poll(
    () => E("(() => (document.getElementById('root')?.innerHTML.length ?? 0))()"),
    (v) => typeof v === "number" && v > 1000,
    90000,
    800,
  );
  must(`${TIER}：CDP 已连且页面非空白`, alive0.ok, alive0.value);
  await call("Page.reload", { ignoreCache: false });
  const alive = await poll(
    async () => {
      try {
        const n = await E("(() => (document.getElementById('root')?.innerHTML.length ?? 0))()");
        if (!(typeof n === "number" && n > 1000)) return { ready: false };
        const q = await Q("return JSON.stringify({ ok: true });");
        return { ready: q?.ok === true };
      } catch {
        return { ready: false };
      }
    },
    (v) => v.ready === true,
    90000,
    800,
  );
  must(`${TIER}：reload 后应用重新就绪`, alive.ok, alive.value);

  const resized = await resizeToCss(1207, 880);
  // 键盘输入的前提是页面真可见：窗口被压在后面时 visibilityState=hidden，
  // 渲染进程节流会吞掉键击的默认动作（焦点移动/激活）⇒ 用 CDP 的 Page.bringToFront 抬窗，
  // 不要用 ShowWindow/SetActiveWindow（UI-VERIFY：那会把 Electron 窗口打成 occluded）
  await call("Page.bringToFront").catch(() => {});
  await H.sleep(400);
  const geo = await J(
    "(() => JSON.stringify({ clientWidth: document.documentElement.clientWidth, dpr: window.devicePixelRatio, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, visibility: document.visibilityState }))()",
  );
  dump.viewport = { ...geo, resized };
  check(
    `${TIER}：视口收敛到宽档 1207（±2px，不骑断点线）`,
    Math.abs(geo.clientWidth - 1207) <= 2 && ![959, 960].includes(geo.clientWidth),
    { clientWidth: geo.clientWidth, resized },
  );
  // 键盘通道真正的前提是**前台归属**，不是 visibilityState 的字面值：
  // 实测抬前台后 CDP 键的默认动作（移焦点/激活）恢复生效，而 visibilityState 仍报 hidden。
  const r0 = raise();
  dump.raise = r0;
  must(
    `${TIER}：抬前台通道可用（d03-raise.ps1 回显 RESULT=raised same=True）`,
    r0.raised === true,
    r0,
  );
  const pageRead = await J(
    "(() => JSON.stringify({ visibility: document.visibilityState, hasFocus: document.hasFocus() }))()",
  );
  note(
    `${TIER}：抬前台后的页面读数 visibilityState=${pageRead.visibility} / hasFocus=${pageRead.hasFocus}（键击判据以"激活真的发生"为准，不以该字面值为准）`,
    pageRead,
  );

  await installRecorders();
  await Q(`
    window.__nav = [];
    if (window.__navUnsub) { try { window.__navUnsub(); } catch (e) {} }
    window.__navUnsub = m.useAppStore.subscribe((st, prev) => {
      const push = (o) => { if (window.__nav.length < 300) window.__nav.push(o); };
      if (st.view !== prev.view) push({ e: "view", from: prev.view, to: st.view });
      if (st.forking !== "idle" || st.creatingRun !== "idle" || st.modelAbInFlight) push({ e: "EXEC", forking: st.forking, creating: st.creatingRun, ab: st.modelAbInFlight });
      const sub = (x) => Object.keys(x.draftSubmissions.byId).length;
      if (sub(st) !== sub(prev)) push({ e: "SUBMISSION", n: sub(st) });
    });
    return JSON.stringify({ installed: Array.isArray(window.__nav) });`);

  const fp0 = fingerprint();
  const x0 = await snapshot();
  must(
    `${TIER}：基线无在飞执行且列表可读`,
    x0.forking === "idle" &&
      x0.creatingRun === "idle" &&
      x0.modelAbInFlight === false &&
      x0.runs > 0,
    {
      forking: x0.forking,
      creatingRun: x0.creatingRun,
      runs: x0.runs,
    },
  );

  // 1) 键盘进详情：Tab 步进 + Enter 激活运行行（真点击由键击产生）
  const rowReady = await poll(
    async () =>
      J(
        `(() => {
           const sp = document.querySelector('span[title="完整 ID：' + ${JSON.stringify(CHILD)} + '"]');
           const btn = sp ? sp.closest("button") : null;
           if (!btn) return JSON.stringify({ ok: false, reason: "row-absent" });
           btn.scrollIntoView({ block: "center" });
           btn.focus();
           return JSON.stringify({ ok: true, focused: document.activeElement === btn, tabIndex: btn.tabIndex });
         })()`,
      ),
    (v) => v.ok === true,
    20000,
  );
  must(`${TIER}：运行行可获得焦点（focusable，键击目标就位）`, rowReady.ok, rowReady.value);
  await clearTrail();

  dump.raises = [r0, raise()];
  await cdpEnter();

  const activated = await poll(
    snapshot,
    (v) => v.selectedRunId === CHILD && v.detailId === CHILD,
    20000,
  );
  const clicks1 = await readClicks();
  check(
    `${TIER}：Enter 在聚焦的运行行上产生受信激活并读出详情`,
    activated.ok && clicks1.some((c) => c.trusted === true),
    { snap: activated.value, clicks: clicks1.slice(0, 4) },
  );
  check(
    `${TIER}：键击激活的运行行带可辨认身份（记录 aria/text 供人工核对）`,
    clicks1.length > 0,
    clicks1.slice(0, 3),
  );

  // 2) Tab 步进轨迹：从当前焦点起连续 Tab，检查落点全部在应用内且持续游走
  await clearTrail();
  const TABS = 14;
  dump.raises.push(raise());
  for (let i = 0; i < TABS; i++) {
    await cdpTab();
    await H.sleep(45);
  }
  const trail = await readTrail();
  const distinct = new Set(trail.map((t) => `${t.tag}|${t.id ?? ""}|${t.aria ?? ""}|${t.text}`));
  const inApp = trail.filter((t) => t.inDoc === true).length;
  check(
    `${TIER}：Tab 步进产生轨迹（≥6 个不同落点，全部仍在文档内）`,
    trail.length >= 6 && distinct.size >= 6 && inApp === trail.length,
    { trailLen: trail.length, distinct: distinct.size, inApp, tail: trail.slice(-4) },
  );
  const named = trail.filter(
    (t) => (t.aria ?? "").length > 0 || (t.role ?? "").length > 0 || (t.id ?? "").length > 0,
  );
  check(
    `${TIER}：Tab 轨迹上的落点带可播报语义（aria-label / role / id，屏读可用）`,
    named.length >= 3 && named.length / trail.length >= 0.3,
    { named: named.length, of: trail.length, sample: named.slice(0, 5) },
  );
  dump.focusTrail = trail;

  // 3) 键盘走比较链：Enter 激活「与父运行对比」→ 再 Enter 激活「返回来源」
  const cmpFocus = await poll(
    () => focusButtonByAria("与父运行对比（父左子右）"),
    (v) => v.ok === true,
    15000,
  );
  must(`${TIER}：「与父运行对比」可被聚焦（键盘目标就位）`, cmpFocus.ok, cmpFocus.value);
  await clearTrail();
  dump.raises.push(raise());
  await cdpEnter();
  const inCompare = await poll(
    snapshot,
    (v) => v.view === "compare" && v.comparePair?.right === CHILD,
    25000,
  );
  const clicks2 = await readClicks();
  // 本通道的激活证据是"受信 click + 紧随其后的 store 迁移"；
  // ⚠️ 不用 detail===0：那是**人手键盘**的特征（人工批用它区分鼠标），
  //    CDP 合成的 Enter 落进 Blink 后 detail 记为 1，写这条会永远红（本轮实测）。
  check(
    `${TIER}：Enter 激活「与父运行对比」进入比较（键击即导航，无需鼠标）`,
    inCompare.ok &&
      clicks2.some((c) => c.trusted === true && (c.aria ?? "").startsWith("与父运行对比")),
    { view: inCompare.value.view, pair: inCompare.value.comparePair, clicks: clicks2.slice(0, 4) },
  );

  const backFocus = await poll(
    () => focusByText("返回来源"),
    (v) => v.ok === true,
    15000,
  );
  must(`${TIER}：「返回来源」可被聚焦`, backFocus.ok, backFocus.value);
  dump.raises.push(raise());
  await cdpEnter();
  const backOk = await poll(
    snapshot,
    (v) => v.view === "trace" && v.selectedRunId === CHILD,
    25000,
  );
  check(
    `${TIER}：Enter 激活「返回来源」回到运行记录（键盘可完成整条往返）`,
    backOk.ok,
    backOk.value,
  );

  // 4) 只读性复核
  const nav = await J("(() => JSON.stringify(window.__nav || []))()");
  dump.nav = nav;
  const viewSeq = nav.filter((x) => x.e === "view").map((x) => `${x.from}->${x.to}`);
  check(
    `${TIER}：键盘链的 view 迁移恰为两次（进比较 + 回来源），无多余导航`,
    viewSeq.length === 2 && viewSeq[0] === "trace->compare" && viewSeq[1] === "compare->trace",
    { viewSeq, events: nav.map((x) => x.e) },
  );
  check(
    `${TIER}：键盘链没有执行哨兵（无 EXEC / SUBMISSION）`,
    nav.every((x) => x.e !== "EXEC" && x.e !== "SUBMISSION"),
    nav.filter((x) => x.e === "EXEC" || x.e === "SUBMISSION"),
  );
  const x1 = await snapshot();
  check(
    `${TIER}：执行登记面逐项不变（confirmations/draftSubmissions/operations/binding 摘要与基线全等）`,
    x1.execHash === x0.execHash,
    {
      before: x0.execHash,
      after: x1.execHash,
      counts: [
        x0.confirmationCount,
        x1.confirmationCount,
        x0.submissionCount,
        x1.submissionCount,
        x0.operationCount,
        x1.operationCount,
      ],
    },
  );
  const fp1 = fingerprint();
  const diff = Object.keys(fp0.entries)
    .filter((k) => fp1.entries[k] !== fp0.entries[k])
    .concat(Object.keys(fp1.entries).filter((k) => !(k in fp0.entries)));
  check(
    `${TIER}：数据根逐文件指纹与基线逐字相同（键盘链零写入）`,
    diff.length === 0 && fp1.off.length === fp0.off.length,
    diff.slice(0, 6),
  );

  await U.shot(call, SHOTS, `d03-${TAG}-final.png`).catch(() => note("截图失败（不影响判据）"));
  finish();
}

function focusByText(text) {
  return J(
    `(() => {
       const b = Array.from(document.querySelectorAll("button")).find(x => (x.textContent || "").trim() === ${JSON.stringify(text)});
       if (!b) return JSON.stringify({ ok: false });
       b.focus();
       return JSON.stringify({ ok: true, focused: document.activeElement === b });
     })()`,
  );
}

main().catch((e) => {
  console.error("批次异常：", String((e && (e.stack || e.message)) || e).slice(0, 900));
  try {
    writeFileSync(join(OUT, `d03-${TAG}-error.txt`), String((e && (e.stack || e.message)) || e));
  } catch {}
  clearTimeout(watchdog);
  process.exit(4);
});
