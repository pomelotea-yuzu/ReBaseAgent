/* eslint-disable */
/**
 * MCP0 任务 6.1 · D03「只读流程交互回归」实机批（真实 Electron + CDP 真点击）。
 *
 * spec 原文（openspec/changes/add-readonly-mcp-diagnostics/specs/desktop-ui/spec.md:15-17）：
 *   WHEN 在真实 Electron 完成列表到详情到比较到文件并返回，抽查窄窗/200%/键盘
 *   THEN 阅读位置/焦点/可达性保持，无新导航、无执行登记，原数据不变
 *
 * 本脚本跑 `chain`（宽档 CSS1207 主链）与 `narrow`（窄档 CSS800 同款主链）两个 tag；
 * 200% 与键盘分别见 d03-61-zoom.cjs / d03-61-keys.cjs（同一套判据函数）。
 *
 * 夹具 = 已在 dev 数据根里的两个隔离 run，默认检查点的期望值取**两个独立来源**：
 *   父 run_mvhmwr6f_ia6xbg（v2，自有 agent.step s_01…s_13）⇒ 期望 s_13
 *   子 run_mvhn8q64_c6ds（v3 隔离 prompt 实验，父=上面，s_01…s_16）⇒ 期望 s_16
 *   来源①=本脚本直接解析 traces/<id>.jsonl 的 span 行；来源②=.workbuddy/r22-72/seed.json
 *   （由 7.2 夹具生成器写下，与被测读取层无关）⇒ 落成 seed-cross-check.json。
 *
 * 前置：dev 带 CDP 9612 已起（NO_SANDBOX=1 node scripts/start-dev.cjs --remoteDebuggingPort=9612）
 * 跑法（必须清代理，否则 CDP /json/list 被 HTTP_PROXY 劫持）：
 *   HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= node apps/desktop/scripts/d03-61-cdp.cjs --tag=chain
 */
"use strict";
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } =
  require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const U = require("./lib/u2-cdp-util.cjs");

const TAG = (() => {
  const hit = process.argv.find((a) => a.startsWith("--tag="));
  return hit ? hit.slice(6) : "";
})();
if (TAG !== "chain" && TAG !== "narrow") {
  console.error("用法：--tag=<chain|narrow>");
  process.exit(2);
}

const DATA = join(H.REPO, ".rebaseagent");
const OUT = join(H.REPO, ".workbuddy", "mcp0-61");
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });

const PARENT = "run_mvhmwr6f_ia6xbg";
const CHILD = "run_mvhn8q64_c6ds";
const CSS_TARGET = TAG === "narrow" ? 800 : 1207;
const TIER = TAG === "narrow" ? "窄档CSS800" : "宽档CSS1207";

/** 数据根「零写入」封闭白名单（5.4 教训：只写"条数没变"会被"加一个 lock"糊过去） */
const WRITE_WHITELIST = [
  /^traces\/[^/]+\.jsonl$/,
  /^traces\/tmp-create-[^/]+\.tmp$/,
  /^workspace-blobs\/sha256\/[0-9a-f]{64}$/,
  /^current-source\/gone\.txt$/,
];
/** 白名单外、但已知的历史探针残留（来源：apps/desktop/scripts/measure-fork-cache.cjs:93） */
const KNOWN_DEBRIS = [/^traces\/tmp-measure-[a-z0-9-]+\.tmp$/];

// ---------------------------------------------------------------------------
// 台账
// ---------------------------------------------------------------------------
const checks = [];
const dump = { tag: TAG, tier: TIER, fixture: { parent: PARENT, child: CHILD }, viewport: null, versions: null, nav: [], steps: {} };
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${JSON.stringify(detail)}`}`);
  return ok === true;
}
/** 前置性判据：红了就没必要往下走（后续判据全都依赖这个落点） */
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
    JSON.stringify({ tag: TAG, generatedAt: new Date().toISOString(), checks, failed: failed.length, dump }, null, 2)
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 12 分钟未收尾`);
  try {
    writeFileSync(join(OUT, `d03-${TAG}-error.txt`), "watchdog timeout");
  } catch {}
  process.exit(3);
}, 720_000);

// ---------------------------------------------------------------------------
// 独立期望值（不由被测实现反推）
// ---------------------------------------------------------------------------
const stepNumber = (id) => {
  const m = /^s_(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : -1;
};
function ownStepIds(runId) {
  const file = join(DATA, "traces", `${runId}.jsonl`);
  if (!existsSync(file)) throw new Error(`夹具 trace 不在场：${runId}`);
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.type === "span" && l.kind === "agent.step")
    .map((l) => String(l.span_id ?? l.id ?? ""))
    .filter(Boolean)
    .sort((a, b) => stepNumber(a) - stepNumber(b));
}
const EXPECT = { parent: ownStepIds(PARENT), child: ownStepIds(CHILD) };
EXPECT.parentLast = EXPECT.parent[EXPECT.parent.length - 1];
EXPECT.childLast = EXPECT.child[EXPECT.child.length - 1];
/** 第二来源：7.2 夹具生成器留下的 seed.json（与被测读取层无关） */
const SEED2 = JSON.parse(readFileSync(join(H.REPO, ".workbuddy", "r22-72", "seed.json"), "utf8"));
const CROSS = {
  sourceOfTruth1: "本脚本解析 .rebaseagent/traces/<id>.jsonl 的 agent.step span 行",
  sourceOfTruth2: ".workbuddy/r22-72/seed.json 的 finalStepId（7.2 夹具生成器写下）",
  parent: { id: PARENT, stepsFromTrace: EXPECT.parent, last: EXPECT.parentLast, finalStepIdFromSeed: SEED2.root.finalStepId },
  child: { id: CHILD, stepsFromTrace: EXPECT.child, last: EXPECT.childLast, finalStepIdFromSeed: SEED2.seedChild.finalStepId },
};
writeFileSync(join(OUT, "seed-cross-check.json"), JSON.stringify(CROSS, null, 2));

// ---------------------------------------------------------------------------
// 数据根指纹
// ---------------------------------------------------------------------------
function fingerprint() {
  const files = [];
  const walk = (dir, rel) => {
    for (const n of readdirSync(dir)) {
      const fp = join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(fp).isDirectory()) walk(fp, r);
      else files.push(r);
    }
  };
  for (const root of ["traces", "workspace-blobs", "current-source"]) {
    if (existsSync(join(DATA, root))) walk(join(DATA, root), root);
  }
  const entries = {};
  const offWhitelist = [];
  for (const r of files) {
    if (!WRITE_WHITELIST.some((re) => re.test(r))) offWhitelist.push(r);
    entries[r] = createHash("sha256").update(readFileSync(join(DATA, r))).digest("hex");
  }
  const settings = join(DATA, "settings.json");
  entries["settings.json"] = existsSync(settings)
    ? createHash("sha256").update(readFileSync(settings)).digest("hex")
    : null;
  return { fileCount: files.length, entries, offWhitelist };
}

// ---------------------------------------------------------------------------
// 页内原语（H.ev 无 awaitPromise ⇒ 表达式一律同步 + JSON 字符串直返）
// ---------------------------------------------------------------------------
let call = null;
const E = (expr) => H.ev(call, expr);
const Q = (body) => H.storeQ(call, body);
const J = async (expr) => JSON.parse(await E(expr));

async function stableClientWidth(timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let same = 0;
  while (Date.now() < deadline) {
    const v = await E("(() => document.documentElement.clientWidth)()");
    if (typeof v === "number" && v > 120) {
      if (v === last) {
        same += 1;
        if (same >= 2) return v;
      } else {
        same = 0;
        last = v;
      }
    }
    await H.sleep(250);
  }
  return last;
}

async function resizeToCss(target, outerHeight) {
  let w = target + 11;
  for (let round = 0; round < 8; round++) {
    await E(`(() => { window.resizeTo(${w}, ${outerHeight}); return true; })()`);
    await H.sleep(700);
    const cw = await stableClientWidth();
    if (typeof cw === "number" && Math.abs(cw - target) <= 2) return { css: cw, outer: w, settled: true };
    if (typeof cw !== "number" || cw <= 0) break;
    w = Math.round(target * (w / cw));
  }
  return { css: await stableClientWidth(), outer: w, settled: false };
}

async function poll(fn, cond, timeoutMs = 8000, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await fn();
    if (cond(last)) return { ok: true, value: last };
    if (Date.now() > deadline) return { ok: false, value: last };
    await H.sleep(stepMs);
  }
}

/** 阅读位置/导航/执行登记的一站式读数 */
const SNAP = `
  const len = (o) => (o && typeof o === "object" ? Object.keys(o).length : -1);
  const r = s.selectedRunId ? (s.readingByRun[s.selectedRunId] ?? null) : null;
  const execJson = JSON.stringify(
    { confirmations: s.confirmations, draftSubmissions: s.draftSubmissions,
      operations: s.operations, binding: s.currentConfirmationBinding ?? null },
    (k, v) => (typeof v === "function" ? "[fn]" : v));
  return JSON.stringify({
    view: s.view,
    selectedRunId: s.selectedRunId,
    selectedSpanId: s.selectedSpanId,
    loadingDetail: s.loadingDetail,
    detailId: s.detail ? s.detail.meta.id : null,
    runs: s.runs.length,
    failed: Array.isArray(s.failed) ? s.failed.length : -1,
    tab: r ? r.tab : null,
    overviewScrollTop: r ? (r.overviewScrollTop ?? null) : null,
    stepsScrollTop: r ? (r.stepsScrollTop ?? null) : null,
    comparePair: s.comparePair ? { left: s.comparePair.leftRunId, right: s.comparePair.rightRunId } : null,
    compareReturnLocation: s.compareReturnLocation ?? null,
    compareFileView: s.compareFileView ?? null,
    compareNotice: s.compareNotice ?? null,
    confirmationCount: len(s.confirmations),
    submissionCount: s.draftSubmissions ? len(s.draftSubmissions.byId) : -1,
    submissionNextToken: s.draftSubmissions ? s.draftSubmissions.nextToken : null,
    operationCount: len(s.operations),
    forking: s.forking,
    creatingRun: s.creatingRun,
    modelAbInFlight: s.modelAbInFlight,
    execJson,
  });`;

async function snapshot() {
  const raw = await Q(SNAP);
  raw.execHash = fnv1a(String(raw.execJson ?? ""));
  return raw;
}
function fnv1a(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    h1 = (h1 ^ text.charCodeAt(i)) >>> 0;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + text.charCodeAt(i) * (i + 1)) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 7), 2654435761) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}

const clickRunRow = (id) =>
  J(
    `(() => {
       const sp = document.querySelector('span[title="完整 ID：' + ${JSON.stringify(id)} + '"]');
       const btn = sp ? sp.closest("button") : null;
       if (!btn) return JSON.stringify({ clicked: false });
       btn.click();
       return JSON.stringify({ clicked: true, row: (btn.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40) });
     })()`
  );

const clickTab = (label) =>
  J(
    `(() => {
       const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
       const t = tabs.find(b => (b.textContent || "").trim() === ${JSON.stringify(label)});
       if (!t) return JSON.stringify({ clicked: false, tabs: tabs.map(b => (b.textContent || "").trim()) });
       t.click();
       return JSON.stringify({ clicked: true, selected: t.getAttribute("aria-selected") });
     })()`
  );

const clickAria = (aria) =>
  J(
    `(() => {
       const b = document.querySelector("button[aria-label=" + ${JSON.stringify(JSON.stringify(aria))} + "]");
       if (!b) return JSON.stringify({ clicked: false });
       b.click();
       return JSON.stringify({ clicked: true, disabled: b.disabled });
     })()`
  );

const clickText = (text) =>
  J(
    `(() => {
       const list = Array.from(document.querySelectorAll("button"));
       const b = list.find(x => (x.textContent || "").trim() === ${JSON.stringify(text)});
       if (!b) return JSON.stringify({ clicked: false, sample: list.map(x => (x.textContent || "").trim().slice(0, 12)).filter(Boolean).slice(0, 20) });
       b.click();
       return JSON.stringify({ clicked: true });
     })()`
  );

const clickSel = (sel) =>
  J(
    `(() => {
       const b = document.querySelector(${JSON.stringify(sel)});
       if (!b) return JSON.stringify({ clicked: false });
       b.click();
       return JSON.stringify({ clicked: true });
     })()`
  );

const scrollEl = (sel, top) =>
  J(
    `(() => {
       const el = document.querySelector(${JSON.stringify(sel)});
       if (!el) return JSON.stringify({ ok: false, reason: "container-absent" });
       el.scrollTop = ${top};
       // 🔴 真滚动事件在后台/被遮窗口里会被渲染进程节流，异步队列里的 scroll 根本不投递到
       //    React 的 onScroll（本轮实测：scrollTop 已生效但 store 恒为 0）⇒ 同步补一次派发，
       //    让"滚动位被记住"这条判据打在真实处理函数上，而不是打在事件节流时序上。
       el.dispatchEvent(new Event("scroll", { bubbles: false }));
       return JSON.stringify({ ok: true, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
     })()`
  );

const readEl = (sel) =>
  J(
    `(() => {
       const el = document.querySelector(${JSON.stringify(sel)});
       if (!el) return JSON.stringify({ present: false });
       const r = el.getBoundingClientRect();
       return JSON.stringify({ present: true, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight,
         clientHeight: el.clientHeight, width: Math.round(r.width), x: Math.round(r.x) });
     })()`
  );

const activeInfo = () =>
  J(
    `(() => {
       const a = document.activeElement;
       if (!a) return JSON.stringify({ tag: null, inDoc: false, inMain: false, focusable: false });
       return JSON.stringify({
         tag: a.tagName.toLowerCase(),
         id: a.id || null,
         cls: String(a.className).slice(0, 48),
         text: (a.textContent || a.value || "").replace(/\\s+/g, " ").trim().slice(0, 28),
         inDoc: document.contains(a),
         inMain: !!a.closest && !!a.closest("main"),
         focusable: !["BODY", "HTML"].includes(a.tagName),
       });
     })()`
  );

const geometry = () =>
  J(
    `(() => {
       const de = document.documentElement;
       return JSON.stringify({
         clientWidth: de.clientWidth, innerWidth: window.innerWidth, dpr: window.devicePixelRatio,
         outerWidth: window.outerWidth, outerHeight: window.outerHeight,
         scrollWidth: de.scrollWidth, title: document.title, url: location.href.slice(0, 40),
         overflowX: de.scrollWidth - de.clientWidth,
       });
     })()`
  );

const a11y = () =>
  J(
    `(() => {
       const q = (sel) => Array.from(document.querySelectorAll(sel));
       const tabs = q('[role="tab"]');
       return JSON.stringify({
         tabs: tabs.map(t => ({ text: (t.textContent || "").trim(), sel: t.getAttribute("aria-selected") })),
         ariaButtons: q("button[aria-label]").length,
         plainButtons: q("button").length,
         ariaCurrent: q('[aria-current="true"]').length,
         ariaPressed: q("button[aria-pressed]").length,
         navSection: q("#steps-navigation").length,
         compareFilesView: q("[data-compare-files-view]").length,
         checkpointSelects: q("[data-compare-file-checkpoint]").length,
         defaultNotes: q("[data-compare-file-default]").length,
         monaco: q(".monaco-editor").length,
       });
     })()`
  );

const fileFacts = () =>
  J(
    `(() => {
       const sides = {};
       for (const side of ["left", "right"]) {
         const sel = document.querySelector('select[data-compare-file-checkpoint="' + side + '"]');
         const noteEl = document.querySelector('[data-compare-file-default="' + side + '"]');
         sides[side] = {
           present: !!sel,
           value: sel ? sel.value : null,
           options: sel ? Array.from(sel.options).map(o => o.value) : [],
           defaulted: !!noteEl,
           defaultNote: noteEl ? noteEl.textContent.trim() : null,
         };
       }
       const rows = Array.from(document.querySelectorAll("ul[data-compare-file-path-list] button"));
       return JSON.stringify({
         sides,
         pathRows: rows.length,
         pressed: rows.filter(b => b.getAttribute("aria-pressed") === "true").map(b => (b.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40)),
         firstPath: rows.length ? (rows[0].textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40) : null,
       });
     })()`
  );

const setCheckpoint = (side, value) =>
  J(
    `(() => {
       const sel = document.querySelector('select[data-compare-file-checkpoint="' + ${JSON.stringify(side)} + '"]');
       if (!sel) return JSON.stringify({ ok: false, reason: "select-absent" });
       if (!Array.from(sel.options).some(o => o.value === ${JSON.stringify(value)}))
         return JSON.stringify({ ok: false, reason: "option-missing", options: Array.from(sel.options).map(o => o.value) });
       const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
       setter.call(sel, ${JSON.stringify(value)});
       sel.dispatchEvent(new Event("change", { bubbles: true }));
       return JSON.stringify({ ok: true, value: sel.value });
     })()`
  );

const monacoFacts = () =>
  J(
    `(() => {
       const view = document.querySelector("[data-compare-files-view]");
       if (!view) return JSON.stringify({ viewPresent: false, monaco: 0, textLen: 0 });
       const wrap = Array.from(view.querySelectorAll(".editor.original, .editor.modified"));
       const lines = Array.from(view.querySelectorAll(".monaco-scrollable-element .view-lines"));
       return JSON.stringify({
         viewPresent: true,
         editorWraps: wrap.length,
         wrapWidths: wrap.map(w => Math.round(w.getBoundingClientRect().width)),
         monaco: view.querySelectorAll(".monaco-editor").length,
         textLen: lines.reduce((a, el) => a + (el.textContent || "").length, 0),
       });
     })()`
  );

// ---------------------------------------------------------------------------
// 主链（宽档与窄档同一套判据，只有视口与容器读数不同）
// ---------------------------------------------------------------------------
async function main() {
  const page = await U.cdpConnect(9612);
  if (!page || !page.webSocketDebuggerUrl) throw new Error("拿不到 page target（dev 未起或端口不对）");
  call = await U.makeSession(page.webSocketDebuggerUrl);
  await call("Runtime.enable");
  await call("Page.enable");

  const alive = await poll(() => E("(() => (document.getElementById('root')?.innerHTML.length ?? 0))()"), (v) => typeof v === "number" && v > 1000, 60000, 500);
  must(`${TIER}：CDP 已连且页面非空白（#root 有内容）`, alive.ok, alive.value);
  // 🔴 先真 reload 清掉上一批留下的会话内存态（compareFileView 的显式检查点选择是 store 内存态，
  //    不复位就会把"上一批的显式选择"读成"本批的默认口径"——本轮首跑就是这么把 D02 读红的）
  await call("Page.reload", { ignoreCache: false });
  const alive2 = await poll(
    async () => {
      try {
        const rootLen = await E("(() => (document.getElementById('root')?.innerHTML.length ?? 0))()");
        if (!(typeof rootLen === "number" && rootLen > 1000)) return { ready: false, rootLen };
        const q = await Q("return JSON.stringify({ ok: true });");
        return { ready: q?.ok === true, rootLen };
      } catch {
        return { ready: false };
      }
    },
    (v) => v.ready === true,
    90000,
    800
  );
  must(`${TIER}：reload 后应用重新就绪（root 有内容且 store 可导入）`, alive2.ok, alive2.value);

  // 1) 真实改窗（映射表只是近似 ⇒ 判据只认实测 CSS 宽度回读）
  const resized = await resizeToCss(CSS_TARGET, TAG === "narrow" ? 950 : 880);
  const geo = await geometry();
  dump.viewport = geo;
  must(
    `${TIER}：实测视口收敛到目标档（±2px 且不骑 959/960 断点线）`,
    resized.settled === true && Math.abs(resized.css - CSS_TARGET) <= 2 && ![959, 960].includes(geo.clientWidth),
    { resized, clientWidth: geo.clientWidth }
  );
  check(`${TIER}：页面无横向溢出`, geo.overflowX <= 1, geo);

  const versions = {};
  versions.electron = (geo ? await E("(() => (navigator.userAgent.match(/Electron\\/([\\d.]+)/)||[])[1]||null)()") : null);
  versions.dpr = geo.dpr;
  versions.appVersion = JSON.parse(readFileSync(join(H.REPO, "apps/desktop/package.json"), "utf8")).version;
  versions.mcpServerVersion = JSON.parse(readFileSync(join(H.REPO, "packages/mcp-server/package.json"), "utf8")).version;
  versions.sdk = JSON.parse(readFileSync(join(H.REPO, "packages/mcp-server/package.json"), "utf8")).dependencies?.["@modelcontextprotocol/sdk"] ?? null;
  versions.node = process.versions.node;
  versions.clientWidth = geo.clientWidth;
  versions.outer = `${geo.outerWidth}x${geo.outerHeight}`;
  dump.versions = versions;
  check(`${TIER}：尺寸/版本已记录（Electron / app / SDK / dpr）`, Boolean(versions.electron && versions.appVersion), versions);

  // 2) 基线：数据根指纹 + 执行登记摘要 + 导航记录器
  const fp0 = fingerprint();
  const offKnown = fp0.offWhitelist.filter((k) => !KNOWN_DEBRIS.some((re) => re.test(k)));
  check(
    `${TIER}：基线数据根条目只在零写入白名单内（白名单外只剩已知探针残留 traces/tmp-measure-*.tmp）`,
    offKnown.length === 0,
    { fileCount: fp0.fileCount, offWhitelist: fp0.offWhitelist.slice(0, 8), 未知条目: offKnown.slice(0, 8) }
  );
  const x0 = await snapshot();
  must(
    `${TIER}：基线无在飞执行且列表可读（forking/creatingRun=idle、modelAbInFlight=false）`,
    x0.forking === "idle" && x0.creatingRun === "idle" && x0.modelAbInFlight === false && x0.runs > 0,
    { forking: x0.forking, creatingRun: x0.creatingRun, modelAbInFlight: x0.modelAbInFlight, runs: x0.runs, failed: x0.failed }
  );
  await Q(`
    window.__d03nav = [];
    if (window.__d03unsub) { try { window.__d03unsub(); } catch (e) {} }
    window.__d03unsub = m.useAppStore.subscribe((st, prev) => {
      const push = (o) => { if (window.__d03nav.length < 400) window.__d03nav.push(o); };
      if (st.view !== prev.view) push({ e: "view", from: prev.view, to: st.view, run: st.selectedRunId });
      if (st.selectedRunId !== prev.selectedRunId) push({ e: "run", from: prev.selectedRunId, to: st.selectedRunId });
      if (st.selectedSpanId !== prev.selectedSpanId) push({ e: "span", from: prev.selectedSpanId, to: st.selectedSpanId });
      const tab = (x) => (x.selectedRunId && x.readingByRun[x.selectedRunId] ? x.readingByRun[x.selectedRunId].tab : null);
      if (tab(st) !== tab(prev)) push({ e: "tab", to: tab(st) });
      const pair = (x) => (x.comparePair ? x.comparePair.leftRunId + "/" + x.comparePair.rightRunId : null);
      if (pair(st) !== pair(prev)) push({ e: "pair", to: pair(st) });
      const fv = (x) => !!(x.compareFileView && x.compareFileView.open);
      if (fv(st) !== fv(prev)) push({ e: "filesView", to: fv(st) });
      if (st.forking !== "idle" || st.creatingRun !== "idle" || st.modelAbInFlight)
        push({ e: "EXEC", forking: st.forking, creating: st.creatingRun, ab: st.modelAbInFlight });
      const sub = (x) => Object.keys(x.draftSubmissions.byId).length;
      if (sub(st) !== sub(prev)) push({ e: "SUBMISSION", n: sub(st) });
    });
    return JSON.stringify({ installed: Array.isArray(window.__d03nav) });`);
  check(`${TIER}：store 导航/执行记录器已挂上`, true);

  // 3) 列表 → 详情（真点击运行行）
  const clickedChild = await clickRunRow(CHILD);
  const landed = await poll(snapshot, (v) => v.selectedRunId === CHILD && v.detailId === CHILD && v.loadingDetail === false, 25000, 200);
  must(`${TIER}：列表→详情真点击后选中并读出详情（view=trace）`, landed.ok && landed.value.view === "trace", {
    click: clickedChild,
    snap: landed.value,
  });

  // 4) 步骤页签 + 阅读位置
  const toSteps = await clickTab("步骤");
  const DETAIL_SEL = "div.flex-1.overflow-y-auto.pb-8";

  // 4a) 先在步骤目录里真点击选中一个 span：阅读位置必须钉在**同一个 span 的正文**上
  //     （正文高度随所选 span 变——先滚后选会把"换了内容的短正文"读成"阅读位置丢了"）
  const pickStep = await J(
    `(() => {
       const rows = Array.from(document.querySelectorAll('#steps-navigation button'))
         .filter(b => !b.getAttribute("aria-label") && (b.textContent || "").includes("步骤"));
       if (rows.length === 0) return JSON.stringify({ clicked: false, texts: Array.from(document.querySelectorAll('#steps-navigation button')).map(b => (b.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 20)).slice(0, 12) });
       const target = rows[rows.length - 1];
       target.click();
       return JSON.stringify({ clicked: true, text: (target.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 30) });
     })()`
  );
  const stepSpanSnap = await poll(snapshot, (v) => typeof v.selectedSpanId === "string" && EXPECT.child.includes(v.selectedSpanId), 12000);
  check(
    `${TIER}：步骤目录里真点击后选中的是该 run 自有步骤`,
    pickStep.clicked === true && stepSpanSnap.ok && stepSpanSnap.value.detailId === CHILD,
    { pickStep, picked: stepSpanSnap.value.selectedSpanId, ownSteps: EXPECT.child, detailId: stepSpanSnap.value.detailId }
  );

  // 4b) 找一个正文确实超高的 span（不超高就没有"位置"可复原，判据会空转）
  let chosenSpan = stepSpanSnap.value.selectedSpanId;
  let panel = await poll(() => readEl(DETAIL_SEL), (v) => v.present === true && v.scrollHeight > v.clientHeight + 40, 4000);
  if (!panel.ok) {
    const tried = [];
    for (let i = 0; i < 10 && !panel.ok; i++) {
      const moved = await J(
        `(() => {
           const rows = Array.from(document.querySelectorAll('#steps-navigation button')).filter(b => !b.getAttribute("aria-label"));
           const cur = document.querySelector('#steps-navigation button[aria-current="true"]');
           if (rows.length === 0 || !cur) return JSON.stringify({ ok: false });
           const idx = rows.indexOf(cur);
           const next = rows[(idx + 1 + ${i}) % rows.length];
           next.click();
           return JSON.stringify({ ok: true, text: (next.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 24) });
         })()`
      );
      if (!moved.ok) break;
      const s2 = await poll(snapshot, (v) => typeof v.selectedSpanId === "string" && v.loadingDetail === false, 8000);
      panel = await poll(() => readEl(DETAIL_SEL), (v) => v.present === true && v.scrollHeight > v.clientHeight + 40, 3500);
      tried.push({ span: s2.value.selectedSpanId, sh: panel.value.scrollHeight, ch: panel.value.clientHeight });
      if (panel.ok) chosenSpan = s2.value.selectedSpanId;
    }
    dump.steps.triedForOverflow = tried;
  }
  must(`${TIER}：点「步骤」页签后详情正文滚动容器在场且内容超高`, panel.ok, {
    click: toSteps,
    panel: panel.value,
    tried: dump.steps.triedForOverflow ?? null,
  });

  // 布局未稳定时滚动会先落 0 再落到位（Monaco/图片分块高度回填）⇒ 先把容器量稳再打判据
  const stablePanel = await poll(
    async () => {
      const a = await readEl(DETAIL_SEL);
      const b = await readEl(DETAIL_SEL);
      return a.present && b.present && a.scrollHeight === b.scrollHeight && a.clientHeight === b.clientHeight
        ? { ok: true, value: b }
        : { ok: false, value: b };
    },
    (v) => v.ok === true,
    12000,
    400
  );
  const sized = stablePanel.value && stablePanel.value.scrollHeight ? stablePanel.value : panel.value;
  const scrollTarget = Math.min(900, Math.max(80, sized.scrollHeight - sized.clientHeight - 60));
  const didScroll = await scrollEl(DETAIL_SEL, scrollTarget);
  // store 与 DOM 必须**同时刻**对齐（期间任何一次重排都可能把位置刷成别的值）
  const recorded = await poll(
    async () => {
      const dom = await readEl(DETAIL_SEL);
      const st = await snapshot();
      return { dom, store: st.overviewScrollTop, aligned: dom.present && st.overviewScrollTop > 0 && Math.abs(dom.scrollTop - st.overviewScrollTop) <= 2 };
    },
    (v) => v.aligned === true,
    12000,
    250
  );
  check(
    `${TIER}：正文滚动位被记住（DOM scrollTop=${recorded.value && recorded.value.dom.scrollTop} 与 store readingByRun 同值且非 0）`,
    didScroll.ok === true && recorded.ok,
    { dom: didScroll, atRecord: recorded.value, sized }
  );
  const recordedStoreTop = recorded.value ? recorded.value.store : null;
  dump.steps.scrollDetail = { dom: didScroll, store: recordedStoreTop, sized };

  const TREE_SEL = "#steps-navigation div.flex-1.overflow-y-auto.py-1";
  const tree = await readEl(TREE_SEL);
  if (tree.present && tree.scrollHeight > tree.clientHeight + 20) {
    const tTop = Math.min(240, tree.scrollHeight - tree.clientHeight);
    const didScrollTree = await scrollEl(TREE_SEL, tTop);
    const recTree = await poll(
      async () => {
        const dom = await readEl(TREE_SEL);
        const st = await snapshot();
        return { dom, store: st.stepsScrollTop, aligned: st.stepsScrollTop > 0 && Math.abs(dom.scrollTop - st.stepsScrollTop) <= 2 };
      },
      (v) => v.aligned === true,
      12000,
      250
    );
    check(`${TIER}：轨迹目录滚动位被记住（stepsScrollTop 同值）`, recTree.ok, { dom: didScrollTree, atRecord: recTree.value });
    dump.steps.scrollTree = { dom: didScrollTree, store: recTree.value.store };
  } else {
    note(`${TIER}：轨迹目录未超高/不在场 ⇒ 滚动位判据只打正文`, tree);
  }

  dump.steps.chosenSpan = chosenSpan;
  const focusBefore = await activeInfo();
  const a11ySteps = await a11y();
  dump.steps.focusBefore = focusBefore;
  dump.steps.a11ySteps = a11ySteps;

  // 5) 详情 → 比较（概览页的「与父运行对比」）
  const toOverview = await clickTab("概览");
  const overviewReady = await poll(() => readEl('[aria-label="运行概览"]'), (v) => v.present, 10000);
  const cmpBtn = await clickAria("与父运行对比（父左子右）");
  const inCompare = await poll(snapshot, (v) => v.view === "compare" && v.comparePair && v.comparePair.left === PARENT && v.comparePair.right === CHILD, 25000);
  must(`${TIER}：概览页「与父运行对比」真点击进入比较（pair=父左/子右）`, cmpBtn.clicked === true && inCompare.ok, {
    toOverview,
    overviewReady: overviewReady.value,
    cmpBtn,
    pair: inCompare.value.comparePair,
  });
  const loc = inCompare.value.compareReturnLocation;
  check(
    `${TIER}：进入比较前记下来源位置（view=trace / run=子 / tab=overview / span=所选）`,
    !!loc && loc.view === "trace" && loc.runId === CHILD && loc.tab === "overview" && loc.spanId === chosenSpan,
    loc
  );
  dump.steps.returnLocation = loc;
  const compareRead = await poll(() => Q(`return JSON.stringify({ notice: s.compareNotice ?? null, readKeys: s.compareRead ? Object.keys(s.compareRead).length : 0 });`), (v) => v.notice === null, 20000);
  check(`${TIER}：详细比较读取落到无失败提示（compareNotice 为空）`, compareRead.ok, compareRead.value);

  // 6) 比较 → 文件视图（D02：桌面默认检查点与旧 IPC 口径）
  //    默认标注只存在于「尚未显式化」的那一帧 ⇒ 先挂 MutationObserver 再点「文件」
  await E(
    `(() => {
       window.__d03def = { left: false, right: false, header: false, noteText: null };
       if (window.__d03defObs) { try { window.__d03defObs.disconnect(); } catch (e) {} }
       const obs = new MutationObserver(() => {
         for (const side of ["left", "right"]) {
           const el = document.querySelector('select[data-compare-file-checkpoint="' + side + '"]');
           if (el && el.parentElement && el.parentElement.querySelector('[data-compare-file-default="' + side + '"]')) {
             window.__d03def[side] = true;
             window.__d03def.noteText = el.parentElement.querySelector('[data-compare-file-default="' + side + '"]').textContent.trim();
           }
         }
         const v = document.querySelector("[data-compare-files-view]");
         if (v && !window.__d03def.header)
           window.__d03def.header = (v.textContent || "").includes("默认各取最近自有完成步骤（无则初始）");
       });
       obs.observe(document.body, { childList: true, subtree: true });
       window.__d03defObs = obs;
       return true;
     })()`
  );
  const fileBtn = await clickAria("查看比较文件视图");
  const viewUp = await poll(() => readEl("[data-compare-files-view]"), (v) => v.present, 20000);
  must(`${TIER}：点「文件」进入比较文件视图（[data-compare-files-view] 在场）`, fileBtn.clicked === true && viewUp.ok, { fileBtn, view: viewUp.value });

  const facts = await poll(fileFacts, (v) => v.sides.left.present && v.sides.right.present && v.pathRows > 0, 25000);
  const fileStore = await poll(snapshot, (v) => !!v.compareFileView, 10000);
  const defSeen = await J(`(() => { if (window.__d03defObs) window.__d03defObs.disconnect(); return JSON.stringify(window.__d03def || {}); })()`);
  dump.steps.defaultNoteObserved = defSeen;
  check(
    `${TIER}（D02）：用户未选步骤时两侧默认=各自最近自有完成步骤（父 ${EXPECT.parentLast} / 子 ${EXPECT.childLast}），select 与 store 同值`,
    facts.ok &&
      facts.value.sides.left.value === EXPECT.parentLast &&
      facts.value.sides.right.value === EXPECT.childLast &&
      fileStore.value.compareFileView.leftStepSpanId === EXPECT.parentLast &&
      fileStore.value.compareFileView.rightStepSpanId === EXPECT.childLast,
    { facts: facts.value.sides, store: fileStore.value.compareFileView, expect: { parentLast: EXPECT.parentLast, childLast: EXPECT.childLast } }
  );
  check(
    `${TIER}（D02）：默认口径在界面上有明示（首帧 [data-compare-file-default] 标注或视图内静态说明，二者至少其一在场）`,
    (defSeen.left === true && defSeen.right === true) || defSeen.header === true,
    defSeen
  );
  check(
    `${TIER}（D02）：检查点选项只给「初始 + 该 run 自有步骤」，不出现祖先步骤`,
    facts.ok &&
      JSON.stringify(facts.value.sides.right.options) === JSON.stringify(["initial", ...EXPECT.child]) &&
      JSON.stringify(facts.value.sides.left.options) === JSON.stringify(["initial", ...EXPECT.parent]),
    { left: facts.value.sides.left.options, right: facts.value.sides.right.options, expect: EXPECT }
  );
  check(
    `${TIER}（D02）：默认值与第二来源（7.2 seed.json）一致 ⇒ 非自证`,
    CROSS.parent.finalStepIdFromSeed === CROSS.parent.last && CROSS.child.finalStepIdFromSeed === CROSS.child.last,
    CROSS
  );

  const omitEnv = await H.apiCall(call, "inspectWorkspace", { runId: CHILD });
  const pickEnv = await H.apiCall(call, "inspectWorkspace", { runId: CHILD, stepSpanId: EXPECT.childLast });
  const omitData = omitEnv?.data ?? null;
  const pickData = pickEnv?.data ?? null;
  check(
    `${TIER}（D02）：旧 IPC 省略 selector=本 run 初始快照（stepSpanId=null、origin.kind=initial），信封过 zod 且 ok`,
    omitEnv?.ok === true && omitData?.stepSpanId === null && omitData?.origin?.kind === "initial",
    { ok: omitEnv?.ok, code: omitEnv?.code ?? null, stepSpanId: omitData?.stepSpanId ?? null, origin: omitData?.origin ?? null }
  );
  check(
    `${TIER}（D02）：显式 selector 走桌面默认口径（s_16）且快照与初始不同 ⇒ MCP 的省略=初始规则没有改写桌面默认`,
    pickEnv?.ok === true && pickData?.stepSpanId === EXPECT.childLast && !!pickData?.snapshotId && pickData.snapshotId !== omitData?.snapshotId,
    {
      omitSnapshot: omitData?.snapshotId ?? null,
      pickSnapshot: pickData?.snapshotId ?? null,
      pickStep: pickData?.stepSpanId ?? null,
      files: [Object.keys(omitData ?? {}).length, (pickData?.files ?? []).length],
    }
  );
  const snaps = await H.apiCall(call, "compareWorkspaceSnapshots", {
    left: { runId: PARENT, stepSpanId: EXPECT.parentLast },
    right: { runId: CHILD, stepSpanId: EXPECT.childLast },
  });
  const leftSnap = snaps?.data?.left?.selected?.snapshotId ?? null;
  const rightSnap = snaps?.data?.right?.selected?.snapshotId ?? null;
  const entryOf = (p) => (snaps?.data?.entries ?? []).find((e) => e.path === p) ?? null;
  const keep = entryOf("keep.txt");
  const blob = entryOf("blob.bin");
  check(
    `${TIER}（D02）：两侧清单读取信封 ok、逐侧 status=ok 且并集完整（旧 IPC schema 未被 MCP 收紧）`,
    snaps?.ok === true &&
      snaps?.data?.left?.status === "ok" &&
      snaps?.data?.right?.status === "ok" &&
      snaps?.data?.unionComplete === true &&
      !!leftSnap &&
      !!rightSnap,
    { ok: snaps?.ok, left: snaps?.data?.left?.status ?? null, right: snaps?.data?.right?.status ?? null, unionComplete: snaps?.data?.unionComplete ?? null, leftSnap, rightSnap }
  );
  check(
    `${TIER}（D02）：清单引用口径保持（keep.txt 两侧同哈希同字节 ⇒ reference=same；blob.bin 仅右侧在场）`,
    keep?.reference === "same" &&
      keep?.left?.sha256 === keep?.right?.sha256 &&
      keep?.left?.bytes === keep?.right?.bytes &&
      blob?.presence === "right_only" &&
      blob?.left === null &&
      blob?.right?.bytes === 17,
    { keep, blob }
  );
  const badFile = await H.apiCall(call, "readComparedWorkspaceFile", {
    left: { runId: PARENT, stepSpanId: EXPECT.parentLast },
    right: { runId: CHILD, stepSpanId: EXPECT.childLast },
    path: "__d03_absent__.txt",
    expectedSnapshotIds: { left: leftSnap, right: rightSnap },
  });
  const rawBad = JSON.stringify(badFile);
  check(
    `${TIER}（D02）：并集外路径按数据如实出门（信封 ok + 逐侧 not_found + 结论不可用），不泄露物理路径/堆栈、不带正文`,
    badFile?.ok === true &&
      badFile?.data?.left?.status === "not_found" &&
      badFile?.data?.right?.status === "not_found" &&
      badFile?.data?.conclusion === "not_found" &&
      badFile?.data?.text === undefined &&
      rawBad.indexOf(".rebaseagent") === -1 &&
      !/\bat\s+[\w.$]+\s*\(.*:\d+:\d+\)/.test(rawBad),
    { ok: badFile?.ok ?? null, left: badFile?.data?.left ?? null, right: badFile?.data?.right ?? null, conclusion: badFile?.data?.conclusion ?? null }
  );

  // 路径行必须挑**文本**那条：并集里第一条是 blob.bin（二进制镜像标本，本来就不出正文），
  // 拿它当"正文视图有文本"的判据必然假红（本轮首跑即如此）。
  const clickPath = (prefix) =>
    J(
      `(() => {
         const rows = Array.from(document.querySelectorAll("ul[data-compare-file-path-list] button"));
         const r = rows.find(b => (b.textContent || "").trim().startsWith(${JSON.stringify(prefix)}));
         if (!r) return JSON.stringify({ clicked: false, rows: rows.map(b => (b.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 24)) });
         r.click();
         return JSON.stringify({ clicked: true, text: (r.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40) });
       })()`
    );
  const textPathClick = facts.ok ? await clickPath("config.txt") : { clicked: false };
  const pressed = await poll(
    fileFacts,
    (v) => v.pressed.length === 1 && (v.pressed[0] || "").startsWith("config.txt"),
    15000
  );
  const mono = await poll(monacoFacts, (v) => v.viewPresent && v.monaco > 0 && v.textLen > 0, 25000);
  check(
    `${TIER}：点文本路径行后该行 aria-pressed 唯一且正文视图挂载有文本`,
    textPathClick.clicked === true && pressed.ok && mono.ok,
    { click: textPathClick, pressed: pressed.value.pressed, monaco: mono.value }
  );
  dump.steps.monaco = mono.value;

  const binClick = await clickPath("blob.bin");
  const binFacts = await poll(
    async () => {
      const m = await monacoFacts();
      const leak = await E(
        `(() => { const v = document.querySelector("[data-compare-files-view]"); return JSON.stringify(v ? String(v.textContent).includes(".rebaseagent") : null); })()`
      );
      return { m, leak: JSON.parse(leak) };
    },
    (v) => v.m.viewPresent === true && v.leak === false,
    12000
  );
  check(
    `${TIER}：切到二进制/单侧路径时视图不崩、不出物理路径（正文仍只在显式路径下出门）`,
    binClick.clicked === true && binFacts.ok,
    { click: binClick, monaco: binFacts.value.m, physicalPathInDom: binFacts.value.leak }
  );

  const explicit = await setCheckpoint("left", "initial");
  const afterExplicit = await poll(fileFacts, (v) => v.sides.left.value === "initial" && v.sides.left.defaulted === false, 15000);
  const storeExplicit = await snapshot();
  check(
    `${TIER}（D02）：显式改成初始检查点后默认标注消失、store 记为显式值（null=初始）`,
    explicit.ok && afterExplicit.ok && storeExplicit.compareFileView && storeExplicit.compareFileView.leftStepSpanId === null,
    { explicit, afterExplicit: afterExplicit.value, fileView: storeExplicit.compareFileView }
  );

  // 7) 返回：文件视图 → 比较 → 来源
  const backToFile = await clickSel("[data-compare-files-back]");
  const fileClosed = await poll(snapshot, (v) => v.compareFileView && v.compareFileView.open === false, 15000);
  const backGone = await poll(() => readEl("[data-compare-files-view]"), (v) => v.present === false, 10000);
  check(
    `${TIER}：「返回详细比较」关掉文件视图并留在比较（view=compare、pair 保留）`,
    backToFile.clicked === true && fileClosed.ok && backGone.ok && fileClosed.value.view === "compare" && fileClosed.value.comparePair?.right === CHILD,
    { backToFile, view: fileClosed.value.view, pair: fileClosed.value.comparePair }
  );

  const reopen = await clickAria("查看比较文件视图");
  const reopened = await poll(fileFacts, (v) => v.sides.left.value === "initial" && v.sides.left.defaulted === false, 20000);
  check(`${TIER}（D02）：重开文件视图仍是显式检查点（不回落默认）`, reopen.clicked === true && reopened.ok, reopened.value);
  await clickSel("[data-compare-files-back]");
  await poll(snapshot, (v) => v.compareFileView && v.compareFileView.open === false, 10000);

  const backToSource = await clickText("返回来源");
  const restored = await poll(snapshot, (v) => v.view === "trace" && v.selectedRunId === CHILD && v.tab === "overview" && v.selectedSpanId === chosenSpan, 25000);
  check(
    `${TIER}：「返回来源」回到 trace 并复原 run/tab/span`,
    backToSource.clicked === true && restored.ok,
    { backToSource, snap: restored.value, expectSpan: chosenSpan }
  );

  const toStepsAgain = await clickTab("步骤");
  // 恢复口径 = 记下的位置按当前内容高度裁剪（scroll-restore.ts:34-45），不是"必须等于旧 DOM 值"
  const restoredScroll = await poll(
    async () => {
      const v = await readEl(DETAIL_SEL);
      const max = Math.max(0, v.scrollHeight - v.clientHeight);
      const exp = recordedStoreTop === null ? null : Math.min(recordedStoreTop, max);
      return { v, exp, hit: v.present === true && exp !== null && exp > 0 && Math.abs(v.scrollTop - exp) <= 3 };
    },
    (r) => r.hit === true,
    20000
  );
  check(
    `${TIER}：回到步骤页签后正文阅读位置复原（复原 ${restoredScroll.value.v.scrollTop} ≈ 记下的 ${recordedStoreTop}，按当前内容高度裁剪到 ${restoredScroll.value.exp}）`,
    toStepsAgain.clicked === true && restoredScroll.ok && restoredScroll.value.v.scrollTop > 0,
    { recordedStoreTop, before: didScroll, after: restoredScroll.value.v, sized: dump.steps.scrollDetail.sized }
  );
  if (dump.steps.scrollTree) {
    const treeTop = dump.steps.scrollTree.store;
    const treeAfter = await poll(
      async () => {
        const v = await readEl(TREE_SEL);
        const max = Math.max(0, v.scrollHeight - v.clientHeight);
        const exp = treeTop === null ? null : Math.min(treeTop, max);
        return { v, exp, hit: v.present === true && exp !== null && Math.abs(v.scrollTop - exp) <= 3 };
      },
      (r) => r.hit === true,
      15000
    );
    check(`${TIER}：轨迹目录阅读位置复原`, treeAfter.ok, { recorded: treeTop, after: treeAfter.value.v });
  }
  const focusAfter = await activeInfo();
  dump.steps.focusAfter = focusAfter;
  check(
    `${TIER}：返回后焦点归属未漂移（与进入前同一宿主元素，且仍在文档内、未落到已卸载节点）`,
    focusAfter.inDoc === true && focusAfter.tag === focusBefore.tag && focusAfter.id === focusBefore.id,
    { before: focusBefore, after: focusAfter }
  );
  note(
    `${TIER}：这条返回路径没有显式 focus() 复位（returnFromCompare 不调焦点）⇒ 焦点判据取"未漂移"，键盘可达性由 keyboard 批打`
  );

  // 8) 无新导航 / 无执行登记 / 原数据不变
  const navList = await J("(() => JSON.stringify(window.__d03nav || []))()");
  dump.nav = navList;
  const viewSeq = navList.filter((x) => x.e === "view").map((x) => `${x.from ?? "null"}->${x.to}`);
  check(
    `${TIER}：view 迁移序列恰为「进入比较 + 返回来源」两次（无多余/自动导航）`,
    viewSeq.length === 2 && viewSeq[0] === "trace->compare" && viewSeq[1] === "compare->trace",
    { viewSeq, events: navList.map((x) => x.e) }
  );
  check(
    `${TIER}：导航流里没有执行哨兵（无 EXEC / SUBMISSION）`,
    navList.every((x) => x.e !== "EXEC" && x.e !== "SUBMISSION"),
    navList.filter((x) => x.e === "EXEC" || x.e === "SUBMISSION")
  );

  const x1 = await snapshot();
  check(
    `${TIER}：执行登记面逐项不变（confirmations/draftSubmissions/operations/binding 摘要与基线全等）`,
    x1.execHash === x0.execHash,
    { before: x0.execHash, after: x1.execHash, confirmationCount: [x0.confirmationCount, x1.confirmationCount], submissionCount: [x0.submissionCount, x1.submissionCount], operationCount: [x0.operationCount, x1.operationCount] }
  );
  check(
    `${TIER}：全程无在飞执行（终态 forking/creatingRun=idle、modelAbInFlight=false）`,
    x1.forking === "idle" && x1.creatingRun === "idle" && x1.modelAbInFlight === false,
    { forking: x1.forking, creatingRun: x1.creatingRun, modelAbInFlight: x1.modelAbInFlight }
  );

  const fp1 = fingerprint();
  const changed = [];
  for (const key of Object.keys(fp0.entries)) {
    if (fp1.entries[key] !== fp0.entries[key]) changed.push({ key, before: fp0.entries[key], after: fp1.entries[key] });
  }
  for (const key of Object.keys(fp1.entries)) {
    if (!(key in fp0.entries)) changed.push({ key, before: null, after: fp1.entries[key] });
  }
  check(
    `${TIER}：数据根逐文件指纹与基线逐字相同（${fp0.fileCount} 个条目 + settings.json）`,
    changed.length === 0,
    changed.slice(0, 6)
  );
  check(
    `${TIER}：终态白名单外条目集合与基线逐字相同（既没多出 lock/日志，也没少掉残留）`,
    fp1.offWhitelist.slice().sort().join("|") === fp0.offWhitelist.slice().sort().join("|") &&
      fp1.offWhitelist.every((k) => KNOWN_DEBRIS.some((re) => re.test(k))),
    { baseline: fp0.offWhitelist, final: fp1.offWhitelist }
  );
  const names0 = Object.keys(fp0.entries).filter((k) => k.startsWith("traces/")).sort();
  const names1 = Object.keys(fp1.entries).filter((k) => k.startsWith("traces/")).sort();
  check(
    `${TIER}：traces 文件名集合逐字恒定（无新 run / 无消失条目，${names0.length} 条）`,
    names0.length === names1.length && names0.every((k, i) => k === names1[i]),
    { added: names1.filter((k) => !names0.includes(k)).slice(0, 5), removed: names0.filter((k) => !names1.includes(k)).slice(0, 5) }
  );

  const aFinal = await a11y();
  dump.steps.a11yFinal = aFinal;
  check(
    `${TIER}：可达性锚点在场（三页签 role=tab 且恰一个 aria-selected、带 aria-label 的按钮存在）`,
    aFinal.tabs.length === 3 && aFinal.tabs.filter((t) => t.sel === "true").length === 1 && aFinal.ariaButtons > 0,
    aFinal
  );

  await U.shot(call, SHOTS, `d03-${TAG}-final.png`).catch((e) => note("截图失败（不影响判据）", String(e).slice(0, 120)));
  finish();
}

main().catch((e) => {
  console.error("批次异常：", String((e && (e.stack || e.message)) || e).slice(0, 900));
  try {
    writeFileSync(join(OUT, `d03-${TAG}-error.txt`), String((e && (e.stack || e.message)) || e));
  } catch {}
  clearTimeout(watchdog);
  process.exit(4);
});
