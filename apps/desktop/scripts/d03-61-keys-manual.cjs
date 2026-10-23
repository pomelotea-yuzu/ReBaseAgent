/* eslint-disable */
/**
 * MCP0 任务 6.1 · D03 键盘档「人工真键」批（最强证据：键击由人手敲出，脚本一律不注入键）。
 *
 * 为什么要这一支（本轮实测，别再重复踩）：
 *   · CDP Input.dispatchKeyEvent：页面 visibilityState 停在 hidden 时 Blink 抑制键击默认动作，
 *     必须 Emulation.setFocusEmulationEnabled(true) 才生效 ⇒ 属浏览器层注入，不是 OS 键盘路径；
 *   · keybd_event（node 侧与用户 PowerShell 侧各跑一次）：Windows 回显 RESULT=sent +
 *     foreground same=True，页面零收键 ⇒ 这台机器的系统键盘投递进不到该窗口；
 *   · Chromium 在文档未获系统焦点时把 focus 事件挂延迟队列（实测连续 focus() 不同按钮，
 *     focusin 一个都不发）⇒ 焦点轨迹一律靠 node 侧轮询 activeElement，不挂 focusin。
 *
 * 本脚本**不发键**，只做：预放焦点（setup，明确登记为非证据）→ 等你按 → 按判据结算。
 * 你只需要按两种键：Tab（第 0 轮）与 Enter（每轮看到 ▶ 提示按一下）。
 *
 * 用法（普通 PowerShell，dev 已带 CDP 9612 在跑；脚本自己不 reload、不清态）：
 *   $env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; $env:NO_PROXY='*'
 *   node apps\desktop\scripts\d03-61-keys-manual.cjs
 */
"use strict";
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const U = require("./lib/u2-cdp-util.cjs");

const DATA = join(H.REPO, ".rebaseagent");
const OUT = join(H.REPO, ".workbuddy", "mcp0-61");
mkdirSync(OUT, { recursive: true });
const PARENT = "run_mvhmwr6f_ia6xbg";
const CHILD = "run_mvhn8q64_c6ds";

const WRITE_WHITELIST = [
  /^traces\/[^/]+\.jsonl$/,
  /^traces\/tmp-create-[^/]+\.tmp$/,
  /^workspace-blobs\/sha256\/[0-9a-f]{64}$/,
  /^current-source\/gone\.txt$/,
];

const checks = [];
const dump = { tag: "manual", rounds: [], trail: [], keys: [], clicks: [], nav: [], viewport: null };
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${JSON.stringify(detail)}`}`);
  return ok === true;
}
function note(text, detail) {
  console.log(`ℹ ${text}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function finish() {
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    join(OUT, "d03-manual-measurements.json"),
    JSON.stringify({ tag: "manual", generatedAt: new Date().toISOString(), checks, failed: failed.length, dump }, null, 2)
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error("看门狗：manual 超过 7 分钟未收尾");
  process.exit(3);
}, 420_000);

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
    entries[r] = createHash("sha256").update(readFileSync(join(DATA, r))).digest("hex");
  }
  const settings = join(DATA, "settings.json");
  entries["settings.json"] = existsSync(settings) ? createHash("sha256").update(readFileSync(settings)).digest("hex") : null;
  return { entries, off };
}

let call = null;
const E = (expr) => H.ev(call, expr);
const Q = (body) => H.storeQ(call, body);
const J = async (expr) => JSON.parse(await E(expr));

async function poll(fn, cond, timeoutMs = 60000, stepMs = 200) {
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
    view: s.view, selectedRunId: s.selectedRunId, runs: s.runs.length,
    tab: s.selectedRunId && s.readingByRun[s.selectedRunId] ? s.readingByRun[s.selectedRunId].tab : null,
    comparePair: s.comparePair ? { left: s.comparePair.leftRunId, right: s.comparePair.rightRunId } : null,
    confirmationCount: len(s.confirmations),
    submissionCount: s.draftSubmissions ? len(s.draftSubmissions.byId) : -1,
    operationCount: len(s.operations),
    forking: s.forking, creatingRun: s.creatingRun, modelAbInFlight: s.modelAbInFlight,
    execJson,
  });`;
const fnv1a = (t) => {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < t.length; i++) {
    a = Math.imul(a ^ t.charCodeAt(i), 16777619) >>> 0;
    b = Math.imul(((b + t.charCodeAt(i) * (i + 1)) >>> 0) ^ (b >>> 7), 2654435761) >>> 0;
  }
  return `${a.toString(16)}${b.toString(16)}`;
};
async function snapshot() {
  const raw = await Q(SNAP);
  raw.execHash = fnv1a(String(raw.execJson ?? ""));
  return raw;
}

/** 记录器：只监听 keydown/click（真键的两种可观察痕迹），焦点轨迹由 node 侧轮询 */
async function installRecorders() {
  await E(
    `(() => {
       window.__m = { keys: [], clicks: [] };
       document.addEventListener("keydown", (e) => {
         if (window.__m.keys.length < 500 && ["Tab", "Enter", " ", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key))
           window.__m.keys.push({ t: Date.now(), key: e.key, trusted: e.isTrusted, target: e.target && e.target.tagName ? e.target.tagName.toLowerCase() : null });
       }, true);
       document.addEventListener("click", (e) => {
         const t = e.target && e.target.closest ? e.target.closest("button,[role=tab],a,input,select") : e.target;
         if (window.__m.clicks.length < 500)
           window.__m.clicks.push({
             t: Date.now(), trusted: e.isTrusted, detail: e.detail,
             tag: t ? t.tagName.toLowerCase() : null,
             aria: t && t.getAttribute ? t.getAttribute("aria-label") : null,
             text: t ? String(t.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 26) : null,
           });
       }, true);
       return true;
     })()`
  );
}

const ACTIVE_DESC = `(() => {
  const a = document.activeElement;
  if (!a) return JSON.stringify({ tag: null, inDoc: false, vis: document.visibilityState, hf: document.hasFocus() });
  return JSON.stringify({
    t: Date.now(),
    tag: a.tagName.toLowerCase(),
    id: a.id || null,
    role: a.getAttribute ? a.getAttribute("role") : null,
    aria: a.getAttribute ? a.getAttribute("aria-label") : null,
    text: String(a.textContent || a.value || "").replace(/\\s+/g, " ").trim().slice(0, 26),
    inDoc: document.contains(a),
    tabIndex: a.tabIndex === undefined ? null : a.tabIndex,
    vis: document.visibilityState,
    hf: document.hasFocus(),
  });
})()`;

const counts = () => J(`(() => JSON.stringify({ keys: window.__m.keys.length, clicks: window.__m.clicks.length }))()`);
const readKeys = () => J(`(() => JSON.stringify(window.__m.keys))()`);
const readClicks = () => J(`(() => JSON.stringify(window.__m.clicks))()`);

/** setup：把焦点预放到指定控件（明确登记为非证据；本脚本从不发键） */
const focusTabByLabel = (label) =>
  J(
    `(() => {
       const t = Array.from(document.querySelectorAll('[role="tab"]')).find(b => (b.textContent || "").trim() === ${JSON.stringify(label)});
       if (!t) return JSON.stringify({ ok: false, tabs: Array.from(document.querySelectorAll('[role="tab"]')).map(b => (b.textContent || "").trim()) });
       t.focus();
       return JSON.stringify({ ok: true, focused: document.activeElement === t, label: ${JSON.stringify(label)} });
     })()`
  );
const focusByAria = (aria) =>
  J(
    `(() => {
       const b = document.querySelector('button[aria-label=' + ${JSON.stringify(JSON.stringify(aria))} + ']');
       if (!b) return JSON.stringify({ ok: false });
       b.focus();
       return JSON.stringify({ ok: true, focused: document.activeElement === b, aria: b.getAttribute("aria-label") });
     })()`
  );
const focusByText = (text) =>
  J(
    `(() => {
       const b = Array.from(document.querySelectorAll("button")).find(x => (x.textContent || "").trim() === ${JSON.stringify(text)});
       if (!b) return JSON.stringify({ ok: false, sample: Array.from(document.querySelectorAll("button")).map(x => (x.textContent || "").trim().slice(0, 12)).filter(Boolean).slice(0, 18) });
       b.focus();
       return JSON.stringify({ ok: true, focused: document.activeElement === b, text: (b.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 26) });
     })()`
  );

/** setup：切工作区页签（click 属前置动作，不作键盘证据；聚焦不等于激活） */
const clickTabSetup = async (label) => {
  const r = await J(
    `(() => {
       const t = Array.from(document.querySelectorAll('[role="tab"]')).find(b => (b.textContent || "").trim() === ${JSON.stringify(label)});
       if (!t) return JSON.stringify({ ok: false, tabs: Array.from(document.querySelectorAll('[role="tab"]')).map(b => (b.textContent || "").trim()) });
       t.click();
       return JSON.stringify({ ok: true, label: ${JSON.stringify(label)} });
     })()`
  );
  await H.sleep(800);
  return r;
};

/** 一轮：预放焦点 → 等一次"受信且 detail=0（键盘激活）"的 click → 返回该 click */
async function round(label, focusFn, timeoutMs = 75000) {
  const before = await counts();
  const f = await focusFn();
  if (f.ok !== true || f.focused !== true) {
    check(`${label}：目标控件可被预聚焦（键盘目标就位）`, false, f);
    return null;
  }
  console.log(`▶ ${label}：焦点已放在「${f.text || f.aria || f.label}」——请按一下 Enter（别碰鼠标）`);
  const res = await poll(
    async () => {
      const c = await counts();
      const all = await readClicks();
      const fresh = all.slice(before.clicks).filter((x) => x.trusted === true);
      const kb = fresh.filter((x) => x.detail === 0);
      return { c, fresh, kb, keys: (await readKeys()).slice(before.keys).filter((k) => k.trusted === true) };
    },
    (v) => v.kb.length >= 1,
    timeoutMs,
    250
  );
  if (!res.ok) {
    check(`${label}：等到一次真键盘激活（受信 click 且 detail=0）`, false, {
      hint: "Enter 落到了不产生激活的元素，或期间点了鼠标；本轮读数如下",
      freshClicks: res.value.fresh,
      keysSincePrompt: res.value.keys.slice(-8),
      counts: res.value.c,
    });
    return null;
  }
  dump.rounds.push({ label, activation: res.value.kb[0], keysSincePrompt: res.value.keys.length });
  return res.value.kb[0];
}

async function main() {
  const page = await U.cdpConnect(9612);
  if (!page || !page.webSocketDebuggerUrl) {
    console.error("拿不到 page target：dev 是否带 --remoteDebuggingPort=9612 起着？");
    process.exit(2);
  }
  call = await U.makeSession(page.webSocketDebuggerUrl);
  await call("Runtime.enable");
  const alive = await poll(() => E("(() => (document.getElementById('root')?.innerHTML.length ?? 0))()"), (v) => typeof v === "number" && v > 1000, 60000, 500);
  if (!alive.ok) {
    console.error("页面未就绪");
    process.exit(2);
  }
  // ⚠️ 不调 Page.reload / bringToFront / setFocusEmulation / 任何 Input.*（那会让真键盘退化成合成通道）
  await installRecorders();
  await Q(`
    window.__mnav = [];
    if (window.__mnavUnsub) { try { window.__mnavUnsub(); } catch (e) {} }
    window.__mnavUnsub = m.useAppStore.subscribe((st, prev) => {
      const push = (o) => { if (window.__mnav.length < 400) window.__mnav.push(Object.assign({ t: Date.now() }, o)); };
      if (st.view !== prev.view) push({ e: "view", from: prev.view, to: st.view });
      if (st.selectedRunId !== prev.selectedRunId) push({ e: "run", from: prev.selectedRunId, to: st.selectedRunId });
      if (st.tab !== prev.tab) push({ e: "tab", to: st.tab });
      if (st.forking !== "idle" || st.creatingRun !== "idle" || st.modelAbInFlight) push({ e: "EXEC", forking: st.forking, creating: st.creatingRun, ab: st.modelAbInFlight });
      const sub = (x) => Object.keys(x.draftSubmissions.byId).length;
      if (sub(st) !== sub(prev)) push({ e: "SUBMISSION", n: sub(st) });
    });
    return JSON.stringify({ installed: Array.isArray(window.__mnav) });`);

  const geo = JSON.parse(await E(ACTIVE_DESC));
  dump.viewport = geo;
  check("通道：CDP 只读连接已建立且控件可辨", geo.tag !== null, geo);

  const fp0 = fingerprint();
  const x0 = await snapshot();
  check(
    "基线：无在飞执行且列表可读",
    x0.forking === "idle" && x0.creatingRun === "idle" && x0.modelAbInFlight === false && x0.runs > 0,
    { forking: x0.forking, creatingRun: x0.creatingRun, runs: x0.runs }
  );

  // setup：确保选中夹具子 run（程序化点击只作前置，不进判据）
  if (x0.selectedRunId !== CHILD) {
    const prepared = await J(
      `(() => {
         const sp = document.querySelector('span[title="完整 ID：' + ${JSON.stringify(CHILD)} + '"]');
         const btn = sp ? sp.closest("button") : null;
         if (!btn) return JSON.stringify({ ok: false, reason: "row-absent" });
         btn.scrollIntoView({ block: "center" });
         btn.click();
         return JSON.stringify({ ok: true });
       })()`
    );
    await poll(snapshot, (v) => v.selectedRunId === CHILD, 20000);
    note("前置：已用程序化点击把阅读对象设成夹具子 run（不作为键盘证据）", prepared);
  }
  // 前置动作可能自带导航 ⇒ 导航/执行账目从第 0 轮起算
  await E("(() => { window.__mnav = []; return true; })()");

  console.log("");
  console.log("=== 轮到你（只按 Tab 和 Enter，全程别碰鼠标）===");
  console.log("第 0 轮：先【Alt+Tab 或点窗口标题栏空白处】把 ReBaseAgent 切到前台，然后连按 Tab 10 次（每次约 0.3 秒）");
  console.log("");

  // 第 0 轮：Tab 步进轨迹（焦点轨迹靠轮询，不依赖 focus 事件）
  const trail = [];
  let lastSig = null;
  const t0 = Date.now();
  await poll(
    async () => {
      const act = JSON.parse(await E(ACTIVE_DESC));
      const sig = `${act.tag}|${act.id ?? ""}|${act.aria ?? ""}|${act.text}`;
      if (sig !== lastSig) {
        lastSig = sig;
        if (trail.length < 300) trail.push(act);
      }
      return { trail: trail.length, ...(await counts()) };
    },
    (v) => v.trail >= 8 && v.keys >= 9,
    90000,
    110
  );
  const tabRound = { trailLen: trail.length, keys: (await counts()).keys, elapsedMs: Date.now() - t0 };
  dump.trail = trail;
  const inDoc = trail.filter((t) => t.inDoc === true);
  check(
    "可达性：真键盘 Tab 步进产生焦点轨迹（≥6 个不同落点且全部仍在文档内）",
    inDoc.length >= 6 && trail.length >= 6,
    { trail: trail.length, inDoc: inDoc.length, head: trail.slice(0, 3), tail: trail.slice(-3) }
  );
  const named = inDoc.filter((t) => (t.aria ?? "").length > 0 || (t.role ?? "").length > 0 || (t.id ?? "").length > 0);
  check(
    "可达性：Tab 轨迹落点带可播报语义（aria-label / role / id，屏读可用）",
    named.length >= 3 && named.length / Math.max(1, inDoc.length) >= 0.3,
    { named: named.length, of: inDoc.length, sample: named.slice(0, 5) }
  );
  const keys0 = (await readKeys()).filter((k) => k.trusted === true && k.key === "Tab");
  check("真键盘：Tab 键击本身到达渲染进程（受信 keydown Tab ≥6）", keys0.length >= 6, { trustedTabs: keys0.length });
  note("第 0 轮读数", tabRound);

  // 第 1 轮：页签激活（只改阅读态）。前置先把页签放回「概览」，让「步骤」成为待激活目标
  note("前置：页签切到「概览」", await clickTabSetup("概览"));
  const a1 = await round("第 1 轮 页签「步骤」", () => focusTabByLabel("步骤"));
  if (a1) {
    const after1 = await poll(snapshot, (v) => v.tab === "steps", 10000);
    check("激活：真键盘 Enter 在页签上产生受信激活并切换阅读页签（tab=steps）", after1.ok, { activation: a1, tab: after1.value.tab });
  }

  // 第 2 轮：进比较。「与父运行对比」只在**概览页**在场 ⇒ 必须先切回概览（聚焦不等于激活）
  note("前置：页签切回「概览」（与父运行对比按钮所在页）", await clickTabSetup("概览"));
  const a2 = await round("第 2 轮 与父运行对比", () => focusByAria("与父运行对比（父左子右）"));
  if (a2) {
    const inCompare = await poll(snapshot, (v) => v.view === "compare" && v.comparePair?.right === CHILD && v.comparePair?.left === PARENT, 20000);
    check("链：真键盘 Enter 激活「与父运行对比」进入比较（pair=父左/子右）", inCompare.ok, { activation: a2, snap: inCompare.value });
  }

  // 第 3 轮：回来源
  await H.sleep(600);
  const a3 = await round("第 3 轮 返回来源", () => focusByAria("返回来源"));
  if (a3) {
    const back = await poll(snapshot, (v) => v.view === "trace" && v.selectedRunId === CHILD, 20000);
    check("链：真键盘 Enter 激活「返回来源」回到运行记录（整条只读往返键盘可完成）", back.ok, { activation: a3, snap: back.value });
  }

  // 只读性复核
  const keys = (await readKeys()).filter((k) => k.trusted === true);
  const nav = await J(`(() => JSON.stringify(window.__mnav || []))()`);
  dump.keys = keys;
  dump.clicks = await readClicks();
  dump.nav = nav;
  check("真键盘：全过程受信 keydown ≥12 次", keys.length >= 12, { keys: keys.length, tail: keys.slice(-6) });
  check(
    "无新导航：view 迁移恰为「进比较 + 回来源」两次，且无 EXEC/SUBMISSION 哨兵",
    nav.filter((x) => x.e === "view").length === 2 && nav.filter((x) => x.e === "EXEC" || x.e === "SUBMISSION").length === 0,
    { views: nav.filter((x) => x.e === "view").map((x) => `${x.from}->${x.to}`), events: nav.map((x) => x.e) }
  );
  const x1 = await snapshot();
  check("无执行登记：confirmations/draftSubmissions/operations/binding 摘要与基线全等", x1.execHash === x0.execHash, {
    before: x0.execHash,
    after: x1.execHash,
  });
  const fp1 = fingerprint();
  const diff = Object.keys(fp0.entries)
    .filter((k) => fp1.entries[k] !== fp0.entries[k])
    .concat(Object.keys(fp1.entries).filter((k) => !(k in fp0.entries)));
  check("原数据不变：数据根逐文件指纹与基线逐字相同，白名单外条目数不变", diff.length === 0 && fp1.off.length === fp0.off.length, {
    diff: diff.slice(0, 6),
  });
  const foreground = trail.filter((t) => t.vis === "visible" && t.hf === true).length;
  check("投递前提：键击期间窗口出现过 visible + hasFocus=true", foreground >= 1, { foreground, of: trail.length });

  finish();
}

main().catch((e) => {
  console.error("批次异常：", String((e && (e.stack || e.message)) || e).slice(0, 900));
  try {
    writeFileSync(join(OUT, "d03-manual-error.txt"), String((e && (e.stack || e.message)) || e));
  } catch {}
  clearTimeout(watchdog);
  process.exit(4);
});
