/* eslint-disable */
/**
 * R2.2 任务 7.2（几何批）：隔离 prompt 实验的**真实窗口宽度 + 200% 缩放**实机核对。
 *
 * 覆盖 tasks 7.2 的几何面：
 * - `widths`：1440 / 1360 / 1024 / 800 CSS px 四档，逐档核对
 *   ① 无横向溢出 ② `overflow-hidden` + `min-h-0` 高度链（从 `<main>` 到详情滚动容器逐跳读数）
 *   ③ 详情列**独立滚动**（滚动只动容器，不动窗口/左列）④ 滚动区底部与正文同色
 *   ⑤ 隔离编辑器（Monaco 草稿 + 核对卡 + 授权 + 提交）在该档可达可滚
 *   ⑥ 比较文件视图（两侧检查点 + 路径并集 + 只读 Monaco diff）在该档可用、窄档上下排列
 *   ⑦ 全程只读：dev 数据目录逐文件指纹不变
 * - `zoom200`：`REBASEAGENT_ZOOM_FACTOR=2` 真 zoom（DPR 实测），同款判据在钳制视口下复跑。
 *
 * 夹具：7.1 真实模型闭环的三个 run（根 `run_mvhj9cq8_1y8519` / 实验子 `run_mvhj9i9c_c22r`），
 * 由 `.workbuddy/r22-72/setup-fixture.cjs` 复制进 dev 数据目录。本 tag **不调模型**
 * （只读核对 = capability 预检通道），设置保持原样不动。
 *
 * 用法：node apps/desktop/scripts/r22-72-geometry-cdp.cjs --tag=<widths|zoom200>
 * 前置：dev 带 CDP 9612 已起（zoom200 组需 REBASEAGENT_ZOOM_FACTOR=2）。
 */
"use strict";
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { listPageTarget } = require("./editor-collapse-probe.cjs");

const rawEv = H.ev;
H.ev = async (call, expression) => {
  const v = await rawEv(call, expression);
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
};

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (TAG !== "widths" && TAG !== "zoom200") {
  console.error("用法：--tag=<widths|zoom200>");
  process.exit(2);
}

const DATA = join(H.REPO, ".rebaseagent");
const OUT = join(H.REPO, ".workbuddy", "r22-72");
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });
const PS_WIN = join(H.REPO, ".workbuddy", "ps-win.ps1");

/** 7.2 桌面夹具（r22-72-seed.cjs 产物；预算与 MAIN_EXECUTION_LIMITS 一致 ⇒ 预检放行） */
const SEED = JSON.parse(readFileSync(join(OUT, "seed.json"), "utf8"));
const ROOT_RUN = SEED.root.id;
const CHILD_RUN = SEED.seedChild.id;
const ROOT_FINAL = SEED.root.finalStepId;
const CHILD_FINAL = SEED.seedChild.finalStepId;
/** 7.1 package-layer 根：录制预算 300000 > 桌面上限 100000 ⇒ 预检必须如实拒绝（不静默截小） */
const R21_ROOT = "run_mvhj9cq8_1y8519";

const checks = [];
const dump = { tag: TAG, tiers: {}, viewport: null, dpr: null };
function check(name, ok, detail) {
  checks.push({ tag: TAG, name, ok: ok === true, detail: detail ?? null });
  console.log(
    `${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
}
function note(text) {
  console.log(`ℹ ${text}`);
  checks.push({ tag: TAG, name: `[登记] ${text}`, ok: true, note: true });
}
function finish() {
  const failed = checks.filter((c) => !c.ok && !c.note);
  writeFileSync(
    join(OUT, `${TAG}-measurements.json`),
    JSON.stringify(
      { tag: TAG, generatedAt: new Date().toISOString(), checks, failed: failed.length, dump },
      null,
      2,
    ),
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 16 分钟未收尾`);
  writeFileSync(join(OUT, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 960_000);

// ---------------------------------------------------------------------------
// 系统通道：真实改窗（ps-win.ps1 + 页内 resizeTo 双通道，抄 refine-55 定版）
// ---------------------------------------------------------------------------

function runPs1(script, args) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("close", () => resolve(out.trim()));
    child.on("error", (e) => resolve(String(e)));
  });
}

/**
 * clientWidth 稳定读数：MoveWindow 后 OS 应用尺寸是**异步**的，单次读会拿到上一档的
 * 陈旧值（2026-10-21 实机：1921 外框时读到 561 CSS ⇒ 反解发散、整批几何判据被带崩）。
 * 因此轮询到「连续两次相同」才算稳定（上限 6s）。
 */
/** 冷启动等待：root 有内容 + store 可导入（reload 后模块图要重新装配） */
async function waitAppAlive(call, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const rootLen = await H.ev(
        call,
        `(() => (document.getElementById('root')?.innerHTML.length ?? 0))()`,
      );
      if (typeof rootLen === "number" && rootLen > 1000) {
        const n = await H.storeQ(call, "return JSON.stringify({ ok: true });");
        if (n && n.ok === true) return true;
      }
    } catch {
      /* 模块图还在加载 */
    }
    if (Date.now() > deadline) throw new Error("应用 90s 未就绪（root 空 / store 不可导入）");
    await H.sleep(800);
  }
}

async function stableClientWidth(call, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let same = 0;
  while (Date.now() < deadline) {
    const v = await H.ev(call, "(() => document.documentElement.clientWidth)()");
    if (typeof v === "number" && v > 120) {
      if (v === last) {
        same += 1;
        if (same >= 2) return v;
      } else {
        same = 0;
        last = v;
      }
    }
    await H.sleep(300);
  }
  return last;
}

async function resizeToCssWidth(call, cssTarget, outerHeight = 1050) {
  // 重置一击：脱离 Win11 Snap 吸附态（不带它后续改窗概率性全无效——U6 6.8 实锤）
  await runPs1(PS_WIN, [
    "-OuterWidth",
    "800",
    "-OuterHeight",
    "700",
    "-X",
    "60",
    "-Y",
    "60",
    "-ForceRestore",
  ]);
  await H.sleep(900);
  if (cssTarget <= 1215) {
    let w = cssTarget + 10;
    for (let round = 0; round < 6; round++) {
      await H.ev(call, `(() => { window.resizeTo(${w}, ${outerHeight}); return true; })()`);
      await H.sleep(900);
      const cw = await stableClientWidth(call);
      if (typeof cw === "number" && Math.abs(cw - cssTarget) <= 2) {
        return { cssWidth: cw, outerWidth: w, channel: "resizeTo", settled: true };
      }
      if (typeof cw !== "number" || cw <= 0) break;
      w = Math.round(cssTarget * (w / cw));
    }
    const cw = await stableClientWidth(call);
    return { cssWidth: cw, outerWidth: w, channel: "resizeTo-exhausted", settled: false };
  }
  let outer = Math.round(cssTarget * 1.412);
  let last = "";
  for (let round = 0; round < 3; round++) {
    if (round > 0) await H.sleep(1200);
    let cssWidth = null;
    for (let i = 0; i < 6; i++) {
      last = await runPs1(PS_WIN, [
        "-OuterWidth",
        String(outer),
        "-OuterHeight",
        String(outerHeight),
        "-ForceRestore",
      ]);
      await H.sleep(900);
      cssWidth = await stableClientWidth(call);
      if (typeof cssWidth === "number" && Math.abs(cssWidth - cssTarget) <= 2) {
        return { cssWidth, outerWidth: outer, channel: "ps-win", settled: true, ps: last };
      }
      if (typeof cssWidth !== "number" || cssWidth <= 0) break;
      const next = Math.max(400, Math.round(cssTarget / (cssWidth / outer)));
      if (next === outer) break;
      outer = next;
    }
  }
  const cssWidth = await stableClientWidth(call);
  return { cssWidth, outerWidth: 0, channel: "exhausted", settled: false, ps: last };
}

/** 静默截图：不调 bringToFront（改窗批不需要前台，避免抢焦点） */
async function shot(call, name) {
  try {
    const file = await H.shot(call, SHOTS, `r2272-${TAG}-${name}.png`);
    console.log(`  [截图] ${file}`);
    return file;
  } catch (e) {
    console.log(`  [截图失败] ${String(e).slice(0, 120)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 几何读数（高度链 / 独立滚动 / 底部同色）
// ---------------------------------------------------------------------------

const pageGeo = (call) =>
  H.ev(
    call,
    `(() => { const de = document.documentElement;
       const main = document.querySelector('main');
       const mr = main === null ? null : main.getBoundingClientRect();
       return JSON.stringify({ scrollW: de.scrollWidth, clientW: de.clientWidth,
         innerW: window.innerWidth, innerH: window.innerHeight, scrollY: window.scrollY,
         mainH: mr === null ? null : Math.round(mr.height),
         mainBottom: mr === null ? null : Math.round(mr.bottom),
         dpr: window.devicePixelRatio }); })()`,
  );

/**
 * 从给定锚点（页内表达式求得的元素）向上走到 `<main>`，逐跳记录高度链事实：
 * overflow-y / min-height / clientHeight / scrollHeight。
 * 判据口径：链上必须存在 `min-h-0`（computed minHeight 为 0px 或 auto 但 flex 列可收缩）
 * 与 overflow-hidden，且**只有一个** overflow-y:auto 的滚动容器。
 */
const heightChain = (call, anchorExpr) =>
  H.ev(
    call,
    `(() => {
       let el = (${anchorExpr});
       if (el === null || el === undefined) return JSON.stringify({ ok: false, why: 'no-anchor' });
       const hops = [];
       const stop = document.querySelector('main');
       let scrollable = null;
       let overflowing = null;
       let guard = 0;
       while (el !== null && el !== document.body && guard < 24) {
         guard += 1;
         const cs = getComputedStyle(el);
         const isScrollY = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
         if (isScrollY && scrollable === null) scrollable = el;
         if (isScrollY && el.scrollHeight > el.clientHeight + 1 && overflowing === null) overflowing = el;
         hops.push({
           tag: el.tagName.toLowerCase(),
           id: el.id || null,
           cls: (typeof el.className === 'string' ? el.className : '').split(' ').filter(Boolean).slice(0, 6).join('.'),
           ovY: cs.overflowY, minH: cs.minHeight, h: Math.round(el.getBoundingClientRect().height),
           clientH: el.clientHeight, scrollH: el.scrollHeight,
           isMain: el === stop,
         });
         if (el === stop) break;
         el = el.parentElement;
       }
       const box = overflowing ?? scrollable;
       return JSON.stringify({ ok: true, viewportH: window.innerHeight,
         reachedMain: hops.some(h => h.isMain),
         hops,
         hasScrollAncestor: scrollable !== null,
         hasOverflowNow: overflowing !== null,
         scrollContainer: box === null ? null : {
           clientH: box.clientHeight, scrollH: box.scrollHeight,
           top: Math.round(box.getBoundingClientRect().top),
           bottom: Math.round(box.getBoundingClientRect().bottom),
           bg: getComputedStyle(box).backgroundColor } });
     })()`,
  );

/** 滚动容器底部取样：elementFromPoint 落点及其有效背景色（判「底部与正文同色」） */
const bottomColor = (call, anchorExpr) =>
  H.ev(
    call,
    `(() => {
       const anchor = (${anchorExpr});
       if (!anchor) return JSON.stringify({ ok: false, why: 'no-anchor' });
       anchor.scrollIntoView({ block: 'center' });
       // 取样盒 = 锚点向上第一个「真正裁切且落在视口内」的祖先（overflow auto/scroll/hidden）。
       // ⚠️ 不能用锚点自身矩形：卡/面板比视口高时它的底边在视口外，elementFromPoint 必然为 null
       //    （2026-10-21 首跑四档全红的根因）。也不能只认 overflow-y:auto：比较文件视图走的是
       //    overflow-hidden + Monaco 内部滚动，没有 auto 祖先。
       let box = anchor;
       while (box !== null) {
         const cs = getComputedStyle(box);
         const rr = box.getBoundingClientRect();
         if (['auto', 'scroll', 'hidden'].includes(cs.overflowY) && rr.bottom <= innerHeight + 2 && rr.height > 40) break;
         box = box.parentElement;
       }
       if (box === null) return JSON.stringify({ ok: false, why: 'no-clipping-box' });
       const r = box.getBoundingClientRect();
       const cx = Math.round(r.left + r.width / 2);
       const cy = Math.round(r.bottom - 3);
       const hit = document.elementFromPoint(cx, cy);
       const eff = (node) => { let n = node;
         while (n && n !== document.body) { const c = getComputedStyle(n).backgroundColor;
           if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; n = n.parentElement; }
         return getComputedStyle(document.body).backgroundColor; };
       return JSON.stringify({ ok: true, cx, cy,
         containerBg: getComputedStyle(box).backgroundColor,
         containerBottom: Math.round(r.bottom), viewportBottom: window.innerHeight,
         hitTag: hit === null ? null : hit.tagName.toLowerCase(),
         hitInside: hit === null ? false : box.contains(hit),
         effectiveBottomColor: hit === null ? null : eff(hit),
         bodyBg: getComputedStyle(document.body).backgroundColor });
     })()`,
  );

/** 独立滚动：只在容器内滚，窗口/左列不动 */
const ANCHOR_CARD = `document.querySelector('[data-isolated-prompt-check]')`;
const ANCHOR_DIFF = `document.querySelector('[data-testid="compare-files-diff-panel"]')`;

function scrollBoxExpr(anchorExpr) {
  return `(() => { let el = (${anchorExpr});
     while (el !== null) { const cs = getComputedStyle(el);
       if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return el;
       el = el.parentElement; }
     return null; })()`;
}

async function scrollIndependence(call, anchorExpr) {
  const getter = scrollBoxExpr(anchorExpr);
  const read = async () =>
    H.ev(
      call,
      `(() => { const box = ${getter};
       const nav = document.querySelector('#run-navigation') ?? document.querySelector('aside');
       const main = document.querySelector('main');
       if (box === null) return JSON.stringify({ ok: false });
       const r = box.getBoundingClientRect();
       return JSON.stringify({ ok: true, top: box.scrollTop, clientH: box.clientHeight, scrollH: box.scrollHeight,
         overflows: box.scrollHeight > box.clientHeight + 1,
         boxTop: Math.round(r.top), winY: window.scrollY,
         navTop: nav === null ? null : Math.round(nav.getBoundingClientRect().top),
         mainTop: main === null ? null : Math.round(main.getBoundingClientRect().top) }); })()`,
    );
  const before = await read();
  if (before.ok !== true) {
    return {
      ok: false,
      scrolled: false,
      before: {
        overflows: false,
        clientH: null,
        scrollH: null,
        winY: null,
        mainTop: null,
        navTop: null,
        top: null,
      },
      read: { winY: null, mainTop: null, navTop: null, top: null },
      why: "no-scroll-container",
    };
  }
  await H.ev(
    call,
    `(() => { const box = ${getter}; if (box === null) return false;
       box.scrollTop = Math.min(box.scrollTop + 240, box.scrollHeight - box.clientHeight);
       return true; })()`,
  );
  await H.sleep(400);
  const after = await read();
  return { ok: true, before, read: after, scrolled: after.top > before.top };
}

/** 独立滚动判据（内容超高档才打红；未超高档如实登记读数） */
async function scrollEvidence(label, call, anchorExpr) {
  const scroll = await scrollIndependence(call, anchorExpr);
  if (scroll.before.overflows === true) {
    check(
      `${label}：详情列独立滚动（容器 scrollTop 变化，窗口 scrollY 与左列/main 位置不动）`,
      scroll.ok === true &&
        scroll.scrolled === true &&
        scroll.read.winY === scroll.before.winY &&
        scroll.read.mainTop === scroll.before.mainTop &&
        (scroll.read.navTop === null || scroll.read.navTop === scroll.before.navTop),
      { before: scroll.before, read: scroll.read },
    );
  } else {
    note(
      `${label}：本档详情列内容未超高（clientH=${scroll.before.clientH} / scrollH=${scroll.before.scrollH}）⇒ 独立滚动只在超高档打判据；窗口/main 位置仍不随滚动变化（winY ${scroll.read.winY} / mainTop ${scroll.read.mainTop}）`,
    );
  }
  return scroll;
}

/** Monaco 读数：指定 host 的编辑器值/可见宽度（懒加载 ⇒ 轮询） */
async function monacoHostState(call, host, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await H.appImport(
      call,
      H.MONACO_NEEDLE,
      `const monaco = await m.ensureMonaco();
       const hostEl = document.querySelector('[data-monaco-host=${JSON.stringify(host)}]');
       if (hostEl === null) return JSON.stringify({ ok: false, why: 'no-host' });
       const rect = hostEl.getBoundingClientRect();
       const eds = monaco.editor.getEditors().filter(e => { const n = e.getDomNode(); return n !== null && hostEl.contains(n); });
       if (eds.length === 0) return JSON.stringify({ ok: false, why: 'no-editor-for-host', rect: { w: Math.round(rect.width), h: Math.round(rect.height) } });
       const e = eds[0];
       const viewLines = hostEl.querySelector('.view-lines');
       const vr = viewLines === null ? null : viewLines.getBoundingClientRect();
       return JSON.stringify({ ok: true,
         hostW: Math.round(rect.width), hostH: Math.round(rect.height),
         viewLinesW: vr === null ? 0 : Math.round(vr.width),
         viewLinesH: vr === null ? 0 : Math.round(vr.height),
         readOnly: e.getOption(monaco.editor.EditorOption.readOnly) === true,
         value: e.getModel() === null ? null : e.getModel().getValue(),
         renderedText: ((viewLines || {}).textContent || '').length });`,
    );
    if (r.ok === true) return r;
    if (Date.now() > deadline) return r;
    await H.sleep(1200);
  }
}

/** 只读 Monaco DiffEditor（比较文件视图）：两侧原文 + 真实行变更 + 插入/删除着色层 */
const monacoDiffState = (call) =>
  H.appImport(
    call,
    H.MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const diffs = monaco.editor.getDiffEditors ? monaco.editor.getDiffEditors() : [];
     const d = diffs[0] ?? null;
     if (d === null) return JSON.stringify({ ok: false, why: 'no-diff-editor' });
     const o = d.getOriginalEditor(), mo = d.getModifiedEditor();
     const host = document.querySelector('[data-testid="compare-files-diff-panel"]');
     const ins = host === null ? 0 : host.querySelectorAll('.line-insert').length;
     const del = host === null ? 0 : host.querySelectorAll('.line-delete').length;
     const txt = (e) => { const md = e.getModel(); return md === null ? null : md.getValue(); };
     const lines = (e) => { const md = e.getModel(); return md === null ? 0 : md.getLineCount(); };
     return JSON.stringify({ ok: true,
       hostW: host === null ? null : Math.round(host.getBoundingClientRect().width),
       hostH: host === null ? null : Math.round(host.getBoundingClientRect().height),
       original: txt(o), modified: txt(mo),
       originalLines: lines(o), modifiedLines: lines(mo),
       readOnlyOriginal: o.getOption(monaco.editor.EditorOption.readOnly) === true,
       readOnlyModified: mo.getOption(monaco.editor.EditorOption.readOnly) === true,
       lineChanges: (d.getLineChanges() ?? []).map(c => ({
         o1: c.originalStartLineNumber, o2: c.originalEndLineNumber,
         m1: c.modifiedStartLineNumber, m2: c.modifiedEndLineNumber })),
       insertDecorations: ins, deleteDecorations: del });`,
  );

async function waitForMonacoDiff(call, timeoutMs = 30000, minChanges = 0) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await monacoDiffState(call).catch((e) => ({
      ok: false,
      why: String(e).slice(0, 80),
    }));
    if (s.ok === true && s.lineChanges !== undefined) {
      // 真实 diff 完成才算（未算完时 lineChanges 为空数组且 decorations 为 0）
      if (s.original !== null && s.modified !== null && s.lineChanges.length >= minChanges)
        return s;
    }
    if (Date.now() > deadline) return s;
    await H.sleep(900);
  }
}

// ---------------------------------------------------------------------------
// 数据目录只读指纹
// ---------------------------------------------------------------------------

function dataFingerprint() {
  const hashFile = (full) =>
    createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16);
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}:${hashFile(full)}:${statSync(full).size}`);
    }
  };
  walk(join(DATA, "traces"), "traces/");
  walk(join(DATA, "workspace-blobs"), "blobs/");
  return out;
}

// ---------------------------------------------------------------------------
// UI 导航小件（本批用程序化点击；真键盘批另写）
// ---------------------------------------------------------------------------

async function storeSelectRun(call, id) {
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(id)}); return JSON.stringify({ sel: s.selectedRunId });`,
  );
  await H.sleep(1400);
}

async function openRootEditor(call) {
  await storeSelectRun(call, ROOT_RUN);
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(ROOT_RUN)}, "overview"); return JSON.stringify({ ok: true });`,
  );
  await H.sleep(1200);
  const clicked = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-isolated-prompt-start]');
       if (!b) return 'no-entry'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; })()`,
  );
  if (clicked !== "clicked") throw new Error(`根入口不可用：${clicked}`);
  await H.sleep(2200);
  // 未编辑时核对按钮应当是禁用的（guard：与原值相同）——先把草稿改出差异
  const draft = await monacoHostState(call, "prompt-draft");
  if (draft.ok !== true) throw new Error(`草稿 Monaco 未挂载：${JSON.stringify(draft)}`);
  await H.setEditableMonaco(call, draft.value + "\nR2.2-72 几何核对用长文本".repeat(18));
  await H.sleep(1800);
}

async function ensureCard(call) {
  // 草稿刚变 ⇒ 轮询到核对按钮可用（修订推进是同步的，但渲染需要一帧）
  const deadline = Date.now() + 20000;
  for (;;) {
    const state = await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-isolated-prompt-check-button]');
         if (!b) return JSON.stringify({ s: 'no-button' });
         return JSON.stringify({ s: b.disabled ? 'disabled' : 'enabled', text: (b.textContent||'').trim() }); })()`,
    );
    if (state.s === "enabled") break;
    if (Date.now() > deadline) throw new Error(`核对按钮始终不可用：${JSON.stringify(state)}`);
    await H.sleep(700);
  }
  await H.ev(
    call,
    `(() => { document.querySelector('[data-isolated-prompt-check-button]').click(); return true; })()`,
  );
  const cardDeadline = Date.now() + 30000;
  for (;;) {
    const card = await H.ev(
      call,
      `(() => JSON.stringify({
         confirm: !!document.querySelector('[data-confirm-execution]'),
         unavailable: (document.querySelector('[data-isolated-prompt-check-unavailable]')?.textContent ?? '').slice(0, 160) }))()`,
    );
    if (card.confirm === true || card.unavailable !== "") {
      // 展开「详细边界」：让长行（端点/历史未知/预算）参与本档排版判据
      if (card.confirm === true) {
        await H.ev(
          call,
          `(() => { const b = Array.from(document.querySelectorAll('button, summary'))
              .find(x => ((x.textContent||'').trim()).includes('展开详细边界') && x.offsetParent !== null);
             if (!b) return 'no-disclosure'; b.click(); return 'clicked'; })()`,
        );
        await H.sleep(700);
      }
      return card;
    }
    if (Date.now() > cardDeadline) throw new Error(`核对卡 30s 未出：${JSON.stringify(card)}`);
    await H.sleep(900);
  }
}

const cardReadout = (call) =>
  H.ev(
    call,
    `(() => {
       const view = document.querySelector('[data-isolated-prompt-check]');
       const hostRect = (sel) => { const e = document.querySelector(sel); if (!e) return null;
          const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), visible: e.offsetParent !== null }; };
       const wrapRect = (sel) => { const e = document.querySelector(sel); if (!e) return null;
          const r = e.getBoundingClientRect(); return { scrollW: e.scrollWidth, clientW: e.clientWidth }; };
       return JSON.stringify({
         card: hostRect('[data-isolated-prompt-check]'),
         cardOverflow: wrapRect('[data-isolated-prompt-check]'),
         notes: hostRect('[data-isolated-prompt-notes]'),
         summary: (document.querySelector('[data-confirm-summary]')?.textContent ?? '').slice(0, 260),
         rowsHidden: document.querySelector('[data-isolated-prompt-check] dl') === null,
         confirm: hostRect('[data-confirm-execution]'),
         auth: !!document.querySelector('[data-isolated-writes-authorization]'),
         authChecked: document.querySelector('[data-isolated-writes-authorization] input')?.checked ?? null,
         billing: (document.querySelector('[data-isolated-billing]')?.textContent ?? '').slice(0, 260),
         submit: hostRect('[data-isolated-prompt-submit-button]'),
         submitState: (document.querySelector('[data-isolated-prompt-submit-state]')?.textContent ?? '').slice(0, 160),
         submitDisabled: document.querySelector('[data-isolated-prompt-submit-button]')?.disabled ?? null,
       }); })()`,
  );

/** 把提交按钮滚进视口（判「独立滚动内可达」） */
const scrollTargetIntoView = (call, sel) =>
  H.ev(
    call,
    `(() => { const e = document.querySelector(${JSON.stringify(sel)});
       if (!e) return JSON.stringify({ ok: false, why: 'no-el' });
       e.scrollIntoView({ block: 'center' });
       const r = e.getBoundingClientRect();
       return JSON.stringify({ ok: true, top: Math.round(r.top), bottom: Math.round(r.bottom),
         inViewport: r.top >= 0 && r.bottom <= window.innerHeight }); })()`,
  );

async function waitForSelector(call, sel, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await H.ev(
      call,
      `(() => { const e = document.querySelector(${JSON.stringify(sel)});
         return JSON.stringify({ present: e !== null, disabled: e ? e.disabled === true : null }); })()`,
    );
    if (found.present === true && found.disabled !== true) return true;
    if (Date.now() > deadline) {
      const diag = await H.ev(
        call,
        `(() => JSON.stringify({ view: (() => { try { return null; } catch { return null; } })(),
           body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) }))()`,
      );
      throw new Error(
        `${label} 超时未就绪：${JSON.stringify(found)}；页面：${JSON.stringify(diag)}`,
      );
    }
    await H.sleep(800);
  }
}

async function waitForEither(call, sels, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await H.ev(
      call,
      `(() => JSON.stringify(${JSON.stringify(sels)}.filter((s) => document.querySelector(s))))()`,
    );
    if (hit.length > 0) return hit;
    if (Date.now() > deadline) {
      const diag = await H.ev(
        call,
        `(() => (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 260))()`,
      );
      throw new Error(`${label} 超时未就绪；页面：${diag}`);
    }
    await H.sleep(900);
  }
}

async function openCompareFilesView(call) {
  await storeSelectRun(call, CHILD_RUN);
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(CHILD_RUN)}, "overview"); return JSON.stringify({ ok: true });`,
  );
  await waitForSelector(call, "[data-prompt-experiment-compare]", 30000, "「与基线运行比较」入口");
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-prompt-experiment-compare]'); b.click(); return true; })()`,
  );
  // 详细比较要等 pair 对齐（两侧详情读取完成）才渲染头部工具条；
  // ⚠️ compareFileView.open 是会话态 ⇒ 上一段留在文件视图时这里直接就挂了，两种形态都要认
  await waitForEither(
    call,
    ['[aria-label="查看比较文件视图"]', "[data-compare-files-view]"],
    45000,
    "比较文件视图入口",
  );
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[aria-label="查看比较文件视图"]');
       if (b !== null) b.click(); return true; })()`,
  );
  const deadline = Date.now() + 30000;
  for (;;) {
    const rows = await H.ev(
      call,
      `(() => JSON.stringify(Array.from(document.querySelectorAll('[data-compare-file-path-list] button'))
          .map(b => (b.getAttribute('aria-pressed') === 'true') + '|' + (b.textContent||'').slice(0, 26))))()`,
    );
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) throw new Error("比较文件清单 30s 未出");
    await H.sleep(900);
  }
}

async function selectComparePath(call, path) {
  const clicked = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('[data-compare-file-path-list] button'))
        .find(x => (x.textContent || '').includes(${JSON.stringify(path)}));
       if (!b) return 'no-row'; b.click(); return 'clicked'; })()`,
  );
  if (clicked !== "clicked") throw new Error(`路径行不可选：${path} ${clicked}`);
  await H.sleep(2600);
}

const compareReadout = (call) =>
  H.ev(
    call,
    `(() => {
       const view = document.querySelector('[data-compare-files-view]');
       const vr = view === null ? null : view.getBoundingClientRect();
       const overflow = (sel) => { const e = document.querySelector(sel); if (!e) return null;
         return { scrollW: e.scrollWidth, clientW: e.clientWidth }; };
       const rect = (sel) => { const e = document.querySelector(sel); if (!e) return null;
         const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), visible: e.offsetParent !== null }; };
       return JSON.stringify({
         present: view !== null,
         viewRect: vr === null ? null : { w: Math.round(vr.width), h: Math.round(vr.height), top: Math.round(vr.top), bottom: Math.round(vr.bottom) },
         viewOverflow: overflow('[data-compare-files-view]'),
         gridCols: view === null ? null : getComputedStyle(view.querySelector(':scope > div:last-child')).gridTemplateColumns,
         leftCp: document.querySelector('[data-compare-file-checkpoint="left"]')?.value ?? null,
         rightCp: document.querySelector('[data-compare-file-checkpoint="right"]')?.value ?? null,
         conclusion: document.querySelector('[data-compare-file-conclusion]')?.getAttribute('data-compare-file-conclusion') ?? null,
         sideLabels: Array.from(document.querySelectorAll('[data-compare-files-view] [data-compare-file-side]')).map(x => (x.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 90)),
         fileHeader: (document.querySelector('[data-compare-files-view] [data-compare-file-conclusion]')?.parentElement?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0, 200),
         diffPanel: rect('[data-testid="compare-files-diff-panel"]'),
         pathList: rect('[data-compare-file-path-list]'),
         back: !!document.querySelector('[data-compare-files-back]'),
         exportRightDisabled: document.querySelector('[data-compare-file-export-side="right"]')?.disabled ?? null,
         exportLeftDisabled: document.querySelector('[data-compare-file-export-side="left"]')?.disabled ?? null,
       }); })()`,
  );

// ---------------------------------------------------------------------------
// 7.1 package-layer 根的实机诚实拒绝（预算 300000 > 桌面上限 100000 ⇒ 不静默截小）
// ---------------------------------------------------------------------------

async function checkR21Refusal(call) {
  await storeSelectRun(call, R21_ROOT);
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(R21_ROOT)}, "overview"); return JSON.stringify({ ok: true });`,
  );
  await H.sleep(1200);
  const opened = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-isolated-prompt-start]');
       if (!b) return 'no-entry'; b.click(); return 'clicked'; })()`,
  );
  if (opened !== "clicked") throw new Error(`7.1 根入口不可达：${opened}`);
  await H.sleep(2000);
  await H.setEditableMonaco(call, "R2.2 7.2 诚实拒绝核对（不静默截小预算）");
  await H.sleep(1500);
  await waitForSelector(call, "[data-isolated-prompt-check-button]", 20000, "7.1 根核对按钮");
  await H.ev(
    call,
    `(() => { document.querySelector('[data-isolated-prompt-check-button]').click(); return true; })()`,
  );
  const deadline = Date.now() + 30000;
  let state = null;
  for (;;) {
    state = await H.ev(
      call,
      `(() => JSON.stringify({
         unavailable: (document.querySelector('[data-isolated-prompt-check-unavailable]')?.textContent ?? '').replace(/\\s+/g,' ').trim(),
         stale: !!document.querySelector('[data-isolated-prompt-check-stale]'),
         confirm: !!document.querySelector('[data-confirm-execution]'),
         auth: !!document.querySelector('[data-isolated-writes-authorization]'),
         submit: document.querySelector('[data-isolated-prompt-submit-button]')?.disabled ?? null }))()`,
    );
    if (state.unavailable !== "" || state.confirm === true) break;
    if (Date.now() > deadline) break;
    await H.sleep(900);
  }
  check(
    "7.1 package-layer 根（录制预算 300000 > 桌面上限 100000）在 GUI 里被如实拒绝，且不给确认/授权/提交",
    state.unavailable.includes("config_unreconstructable") &&
      state.unavailable.includes("预算") &&
      state.confirm === false &&
      state.auth === false &&
      (state.submit === null || state.submit === true),
    state,
  );
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '取消' && x.offsetParent !== null);
       if (b) b.click(); return true; })()`,
  );
  await H.sleep(600);
  return state;
}

// ---------------------------------------------------------------------------
// 单档几何判据
// ---------------------------------------------------------------------------

async function geometryTier(tierName, call, cssTarget) {
  const r = await resizeToCssWidth(call, cssTarget);
  check(
    `${tierName}：改窗实测 CSS 落点（±2px）`,
    r.settled === true && Math.abs(r.cssWidth - cssTarget) <= 2,
    { cssWidth: r.cssWidth, outer: r.outerWidth, channel: r.channel },
  );
  await H.sleep(900);
  const geo = await pageGeo(call);
  dump.tiers[tierName] = { resize: r, geo };
  check(`${tierName}：页面无横向溢出`, geo.scrollW <= geo.clientW + 1, {
    scrollW: geo.scrollW,
    clientW: geo.clientW,
  });
  check(
    `${tierName}：主工作区高度受视口约束（main 底边不越界）`,
    geo.mainH !== null && geo.mainH > 80 && geo.mainBottom <= geo.innerH + 2,
    geo,
  );

  // ── 隔离编辑器 + 核对卡 ──
  const chain = await heightChain(call, ANCHOR_CARD);
  const hopsOv = (chain.hops ?? []).map((h) => `${h.tag}[${h.ovY}/${h.minH}]`);
  check(
    `${tierName}：高度链达标（锚点→main 贯通、main overflow-hidden、详情列 overflow-y 滚动容器在场）`,
    chain.ok === true &&
      chain.reachedMain === true &&
      (chain.hops ?? []).some((h) => h.isMain && h.ovY === "hidden") &&
      chain.hasScrollAncestor === true,
    {
      hops: hopsOv,
      reachedMain: chain.reachedMain,
      hasScrollAncestor: chain.hasScrollAncestor,
      hasOverflowNow: chain.hasOverflowNow,
    },
  );
  const draft = await monacoHostState(call, "prompt-draft");
  check(
    `${tierName}：草稿 Monaco 在场且有渲染文本（阅读空间判据）`,
    draft.ok === true &&
      draft.viewLinesW > 60 &&
      draft.renderedText > 0 &&
      draft.readOnly === false,
    draft,
  );
  const bottom = await bottomColor(call, ANCHOR_CARD);
  check(
    `${tierName}：详情滚动区底部不露页面灰底（落点在裁切盒内、颜色属正文一侧）`,
    bottom.ok === true &&
      bottom.hitInside === true &&
      // 「底部同色」判的是不露页面灰底（#f6f7f9）：落点必须在滚动容器内，且有效背景
      // 是正文一侧的颜色（白底或编辑器自身的着色块），不是页面底色
      bottom.effectiveBottomColor !== null &&
      bottom.effectiveBottomColor !== bottom.bodyBg &&
      bottom.containerBottom <= bottom.viewportBottom + 2,
    bottom,
  );
  const scroll = await scrollEvidence(tierName, call, ANCHOR_CARD);
  const intoView = await scrollTargetIntoView(call, "[data-isolated-prompt-submit-button]");
  const card = await cardReadout(call);
  check(
    `${tierName}：核对卡 + 授权 + 提交按钮在该档可滚动可达`,
    intoView.ok === true &&
      intoView.inViewport === true &&
      card.confirm !== null &&
      card.auth === true &&
      card.submitDisabled === true,
    { intoView, confirm: card.confirm, submitDisabled: card.submitDisabled },
  );
  const cardOverflow = card.cardOverflow;
  check(
    `${tierName}：核对卡自身不产生横向溢出（长端点/长摘要在卡内换行）`,
    cardOverflow === null || cardOverflow.scrollW <= cardOverflow.clientW + 1,
    cardOverflow,
  );
  return { geo, chain, draft, bottom, scroll, card };
}

async function compareTier(tierName, call) {
  const rows = await openCompareFilesView(call);
  // 先选中一条文本路径：diff 面板只在选中后可得（高度链/底部同色的锚点）
  await selectComparePath(call, "config.txt");
  const diff = await waitForMonacoDiff(call, 30000, 1);
  const cmp = await compareReadout(call);
  const chain = await heightChain(call, ANCHOR_DIFF);
  const bottom = await bottomColor(call, ANCHOR_DIFF);
  const geo = await pageGeo(call);
  dump.tiers[tierName] = {
    ...(dump.tiers[tierName] ?? {}),
    compare: { rows, cmp, chain, bottom, diff },
  };
  check(
    `${tierName} 比较文件视图：config.txt 原文逐字进 diff（CRLF 不被规范化、两侧只读）`,
    diff.ok === true &&
      diff.original === "B: parent-final" &&
      diff.modified === "A: initial-config\r\nB-added-line\r\n" &&
      diff.readOnlyOriginal === true &&
      diff.readOnlyModified === true,
    { ok: diff.ok, why: diff.why ?? null, modified: JSON.stringify(diff.modified) },
  );
  check(
    `${tierName} 比较文件视图：两侧清单可用且默认检查点为各自最近自有完成步骤`,
    cmp.present === true &&
      rows.length >= 6 &&
      cmp.leftCp === ROOT_FINAL &&
      cmp.rightCp === CHILD_FINAL,
    { rows: rows.length, leftCp: cmp.leftCp, rightCp: cmp.rightCp },
  );
  check(
    `${tierName} 比较文件视图：正文区高度链达标（diff 面板→main 贯通、main overflow-hidden、逐跳不超父级）`,
    chain.ok === true &&
      chain.reachedMain === true &&
      (chain.hops ?? []).some((h) => h.isMain && h.ovY === "hidden") &&
      (chain.hops ?? []).every((h) => h.h <= (chain.viewportH ?? 0) + 4) &&
      (chain.hops ?? [])[0].h > 60,
    { hops: (chain.hops ?? []).map((h) => `${h.tag}[${h.ovY}/${h.minH}/${h.h}]`) },
  );
  check(
    `${tierName} 比较文件视图：diff 底部不露页面灰底（与正文同色一侧）`,
    bottom.ok === true &&
      bottom.hitInside === true &&
      bottom.effectiveBottomColor !== null &&
      bottom.effectiveBottomColor !== bottom.bodyBg,
    bottom,
  );
  check(
    `${tierName} 比较文件视图：视图自身无横向溢出`,
    cmp.viewOverflow === null || cmp.viewOverflow.scrollW <= cmp.viewOverflow.clientW + 1,
    cmp.viewOverflow,
  );
  return cmp;
}

// ---------------------------------------------------------------------------
// widths
// ---------------------------------------------------------------------------

async function runWidths(call) {
  const fpBefore = dataFingerprint();
  await checkR21Refusal(call);
  await storeSelectRun(call, ROOT_RUN);
  await openRootEditor(call);
  const cardState = await ensureCard(call);
  check(
    "前置：只读核对出卡（未触发模型调用）",
    cardState.confirm === true || cardState.unavailable === "",
    cardState,
  );

  const tiers = [
    { css: 1440, bp: "wide" },
    { css: 1360, bp: "wide" },
    { css: 1024, bp: "medium" },
    { css: 800, bp: "narrow" },
  ];
  for (const tier of tiers) {
    const label = `宽度 ${tier.css}（${tier.bp}）`;
    await geometryTier(label, call, tier.css);
    // 回编辑现场（比较视图会切走视图/页签）
    await storeSelectRun(call, ROOT_RUN);
    await openRootEditorThin(call);
    await ensureCard(call);
    await compareTier(label, call);
    await shot(call, `w${tier.css}-compare`);
    await storeSelectRun(call, ROOT_RUN);
    await openRootEditorThin(call);
    await ensureCard(call);
    await shot(call, `w${tier.css}-editor`);
  }
  const fpAfter = dataFingerprint();
  const diff = fpAfter
    .filter((x) => !fpBefore.includes(x))
    .concat(fpBefore.filter((x) => !fpAfter.includes(x)));
  check(
    "宽度批全程只读：dev 数据目录逐文件指纹零变化（scenario「阅读过程不修改已有数据」）",
    diff.length === 0,
    { delta: diff.slice(0, 6) },
  );
}

/** 编辑器已在草稿态时重开：只走入口点击 + 等待 Monaco，不再改草稿 */
async function openRootEditorThin(call) {
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(ROOT_RUN)}, "overview"); return JSON.stringify({ ok: true });`,
  );
  await H.sleep(1200);
  const clicked = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-isolated-prompt-start]');
       if (!b) return 'no-entry'; b.click(); return 'clicked'; })()`,
  );
  if (clicked !== "clicked") throw new Error(`根入口重开失败：${clicked}`);
  await H.sleep(2000);
}

// ---------------------------------------------------------------------------
// zoom200
// ---------------------------------------------------------------------------

async function runZoom200(call) {
  const fpBefore = dataFingerprint();
  const geo0 = await pageGeo(call);
  dump.dpr = geo0.dpr;
  check(
    "200%：真 zoom 金标准 DPR > 3.5（非 Emulation 伪造）",
    typeof geo0.dpr === "number" && geo0.dpr > 3.5,
    { dpr: geo0.dpr, innerW: geo0.innerW, clientW: geo0.clientW },
  );

  await storeSelectRun(call, ROOT_RUN);
  await openRootEditor(call);
  const cardState = await ensureCard(call);
  check(
    "200%：只读核对出卡",
    cardState.confirm === true || cardState.unavailable === "",
    cardState,
  );

  // ⚠️ zoom2 的「外框→CSS」换算与 100% 档不同（实测 ≈÷2.82 ⇒ 目标 1440 需要外框 4061，
  // 远超物理屏宽），所以本档**不打 ±2px 落点判据**：按 refine-55/u5-68 定版直接 MoveWindow
  // 拉满，以实测 CSS 视口为准记录，判据写成相对几何 + 窄档行为。
  const last = await runPs1(PS_WIN, [
    "-OuterWidth",
    "2600",
    "-OuterHeight",
    "1700",
    "-ForceRestore",
  ]);
  await H.sleep(1400);
  const wide = { outerWidth: 2600, outerHeight: 1700, settled: true, ps: last };
  const geo = await pageGeo(call);
  dump.viewport = { resize: wide, geo };
  check(
    "200%：MoveWindow 拉满后实测 CSS 视口落在 ÷2.82 换算区间（如实记录，不冒充 1440 档）",
    typeof geo.clientW === "number" && geo.clientW >= 880 && geo.clientW <= 960,
    { cssWidth: geo.clientW, outer: wide.outerWidth, dpr: geo.dpr, innerH: geo.innerH },
  );
  const label = `200%（CSS ${geo.clientW}）`;
  dump.tiers[label] = { resize: wide, geo };
  check(`${label}：页面无横向溢出`, geo.scrollW <= geo.clientW + 1, {
    scrollW: geo.scrollW,
    clientW: geo.clientW,
  });
  check(
    `${label}：主工作区高度受视口约束`,
    geo.mainH !== null && geo.mainH > 80 && geo.mainBottom <= geo.innerH + 2,
    geo,
  );
  const chain = await heightChain(call, ANCHOR_CARD);
  check(
    `${label}：高度链达标（main overflow-hidden + 唯一滚动容器）`,
    chain.ok === true &&
      chain.reachedMain === true &&
      (chain.hops ?? []).some((h) => h.isMain && h.ovY === "hidden") &&
      chain.hasScrollAncestor === true,
    { hops: (chain.hops ?? []).map((h) => `${h.tag}[${h.ovY}/${h.minH}]`) },
  );
  const draft = await monacoHostState(call, "prompt-draft");
  check(
    `${label}：草稿 Monaco 在场且有渲染文本`,
    draft.ok === true && draft.viewLinesW > 60 && draft.renderedText > 0,
    draft,
  );
  const bottom = await bottomColor(call, ANCHOR_CARD);
  check(
    `${label}：详情滚动区底部不露页面灰底（落点在裁切盒内、颜色属正文一侧）`,
    bottom.ok === true &&
      bottom.hitInside === true &&
      // 「底部同色」判的是不露页面灰底（#f6f7f9）：落点必须在滚动容器内，且有效背景
      // 是正文一侧的颜色（白底或编辑器自身的着色块），不是页面底色
      bottom.effectiveBottomColor !== null &&
      bottom.effectiveBottomColor !== bottom.bodyBg &&
      bottom.containerBottom <= bottom.viewportBottom + 2,
    bottom,
  );
  await scrollEvidence(label, call, ANCHOR_CARD);
  const intoView = await scrollTargetIntoView(call, "[data-isolated-prompt-submit-button]");
  const card = await cardReadout(call);
  check(
    `${label}：核对卡、授权行与提交按钮在 200% 下可达（creation/confirm 窄窗可操作）`,
    intoView.ok === true &&
      intoView.inViewport === true &&
      card.auth === true &&
      card.confirm !== null,
    { intoView, confirm: card.confirm, auth: card.auth, submit: card.submit },
  );
  const nav = await H.ev(
    call,
    `(() => { const nav = document.getElementById('run-navigation');
       const t = document.getElementById('run-navigation-toggle');
       return JSON.stringify({ navInDom: nav !== null,
         toggleLabel: t === null ? null : t.getAttribute('aria-label') }); })()`,
  );
  check(
    "200%（窄档）：运行列表按显示决策收起且恢复入口在场",
    nav.navInDom === false && nav.toggleLabel === "打开运行列表",
    nav,
  );
  await shot(call, "zoom-editor");

  await compareTier(`200%（CSS ${geo.clientW}）`, call);
  const cmp = dump.tiers[`200%（CSS ${geo.clientW}）`]?.compare ?? {};
  check(
    "200%：比较文件视图 diff 面板有实际宽度（不只挂在 DOM）",
    typeof cmp.cmp?.diffPanel?.w === "number" && cmp.cmp.diffPanel.w > 60,
    cmp.cmp === undefined ? null : cmp.cmp.diffPanel,
  );
  await selectComparePath(call, "config.txt");
  const diff = await waitForMonacoDiff(call, 30000, 1);
  check(
    "200%：config.txt 双侧原文进 Monaco diff（只读、有行变更）",
    diff.ok === true && diff.readOnlyOriginal === true && diff.readOnlyModified === true,
    { ok: diff.ok, why: diff.why ?? null, lines: (diff.lineChanges ?? []).length },
  );
  await shot(call, "zoom-compare");

  const fpAfter = dataFingerprint();
  const delta = fpAfter
    .filter((x) => !fpBefore.includes(x))
    .concat(fpBefore.filter((x) => !fpAfter.includes(x)));
  check("200% 批全程只读：数据目录逐文件指纹零变化", delta.length === 0, {
    delta: delta.slice(0, 6),
  });
}

// ---------------------------------------------------------------------------

async function main() {
  const page = await listPageTarget(9612);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  // 开局哨兵 reload：compareFileView/草稿/阅读态都是会话态，上一段残留会让判据读成假红
  await call("Page.reload", { ignoreCache: false });
  await waitAppAlive(call);
  note("开局已 reload（清掉上一批遗留的会话态）");
  await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
  const ids = await H.storeQ(call, "return JSON.stringify({ ids: s.runs.map(r => r.id) });");
  for (const [label, id] of [
    ["7.2 种子根", ROOT_RUN],
    ["7.2 种子子", CHILD_RUN],
    ["7.1 真实模型根（诚实拒绝标的）", R21_ROOT],
  ]) {
    if (!ids.ids.includes(id)) throw new Error(`夹具缺失（${label}）：${id}`);
  }
  note(
    `夹具就位：dev 列表 ${ids.ids.length} 条；根 ${ROOT_RUN}（final ${ROOT_FINAL}）/ 子 ${CHILD_RUN}（final ${CHILD_FINAL}，预算 ${SEED.root.budget.max_total_tokens}）`,
  );
  note("本批不调用模型：核对按钮走只读 capability 预检；导出入口只读判据（不点确认）");

  if (TAG === "widths") await runWidths(call);
  else await runZoom200(call);
  finish();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT, `${TAG}-error.txt`), String(e?.stack ?? e));
  clearTimeout(watchdog);
  process.exit(2);
});
