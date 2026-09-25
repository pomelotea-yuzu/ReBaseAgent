/* eslint-disable */
/**
 * U3 任务 6.9：独立验证 Electron **200% 页面缩放**（`REBASEAGENT_ZOOM_FACTOR=2`）下的
 * 原值/草稿核对网格——记录实际 viewport、zoom/DPR 与编辑/操作可达性。
 *
 * 验收（tasks 6.9）：宽窄窗口均可核对**完整编辑内容**（200% 缩放）；
 * 不要求四档宽度 × 缩放的笛卡尔积（6.8 已覆盖 zoom 1 四档）。
 * 对应 spec（desktop-ui delta）「宽窄窗口均可核对完整编辑内容」场景中的
 * 「独立 200% 缩放」分支：正文可完整滚动阅读、窄窗上下排列、操作可达、
 * 无整页横向溢出、不通过缩小正文掩盖空间不足。
 *
 * 机制（沿用 6.8，探针 2026-09-25 实测复验）：
 * - 缩放走主进程 `webContents.setZoomFactor`（`did-finish-load` 后设置），**禁 Emulation**；
 * - 改窗一律 Win32 `MoveWindow`（`.workbuddy/ps-win.ps1`），窗口可超出物理屏；
 * - 探针实测：zoom=2 时 `devicePixelRatio = 2.1 × 2 = 4.2`，CSS = zoom1 校准值 ÷ 2
 *   （outer 2030→CSS 720 / 1134→400）；outer 3610→**CSS 1284 ⇒ 200% 下并排档仍可达**；
 * - 每档读**实际** `window.innerWidth` 记录，不拿请求值冒充。
 *
 * 判据口径（同 6.8）：
 * - 内容完整性用 **Monaco model**（虚拟滚动下 DOM 只含视口行）；
 * - 「无右溢」= 草稿侧绘制越界 ≤2px（wordWrap 生效）；「无整页横向溢出」=
 *   `documentElement.scrollWidth ≤ innerWidth + 2`（200% 专属加测）；
 * - 轨道数 = xl 断点（实测 innerW ≥1280 ⇒ 2，<1280 ⇒ 1）；
 * - 「编辑可达」= 窄档（CSS≈400）现场键入/写入并核对 store 更新；
 * - 「操作可达」= 「放弃修改」scrollIntoView 后完整落入视口。
 *
 * 用法：node apps/desktop/scripts/u3-69-cdp.cjs --tag=<tool-result|prompt|model-ab>
 * ⚠️ dev 必须带 REBASEAGENT_ZOOM_FACTOR=2 启动（.workbuddy/u3/u3-69/start-dev.cjs）。
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u3", "u3-69");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-25-u3-69");
const MANIFEST = join(REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const OUT = join(OUT_DIR, "measurements.json");
const PS1 = join(REPO, "apps", "desktop", "scripts", "lib", "u3-64-winops.ps1");
const PSWIN = join(REPO, ".workbuddy", "ps-win.ps1");

/** 探针实测校准（2026-09-25，zoom=2）：Win32 外框 → CSS 视口（≈ zoom1 校准 ÷ 2） */
const TIERS = [
  { css: 1280, outer: [3610, 2200] }, // 并排档：CSS≈1284 ≥1280
  { css: 720, outer: [2030, 1310] }, // 上下档（原 1440 档 ÷2）
  { css: 400, outer: [1134, 1050] }, // 极窄档（原 800 档 ÷2）
];

/** zoom=2 的系统 DPR×zoom 理论值（探针实测 4.1999998）；M1 变异（禁用注入）时回落 2.1 */
const EXPECT_DPR = 4.2;

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "tool-result");

function fixture() {
  if (!existsSync(MANIFEST)) throw new Error(`缺 ${MANIFEST}——6.9 复用 6.1 的夹具`);
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

const checks = [];
function check(name, ok, detail) {
  checks.push({
    name: `[${TAG}] ${name}`,
    ok: ok === true,
    detail: ok === true ? "" : String(detail ?? ""),
  });
  console.log(
    `${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${String(detail ?? "")}`}`,
  );
}
function loadOut() {
  if (existsSync(OUT)) return JSON.parse(readFileSync(OUT, "utf8"));
  return { measurements: {}, checks: [] };
}
function saveOut(d) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(d, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 进程通道（异步 spawn；独立产物文件——同 6.8 纪律）
// ---------------------------------------------------------------------------

let MAIN_PID = 0;
let PS_SEQ = 0;
function spawnCollect(exe, args, outFile) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let err = "";
    let so = "";
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.stdout.on("data", (d) => {
      so += String(d);
    });
    child.on("close", (code) => {
      let lines = [];
      if (outFile !== undefined) {
        try {
          let txt = readFileSync(outFile, "utf8");
          if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
          lines = txt.split(/\r?\n/).filter((l) => l.trim() !== "");
        } catch {
          lines = [];
        }
        try {
          if (existsSync(outFile)) rmSync(outFile);
        } catch {
          /* 忽略 */
        }
      }
      resolve({ code, lines, so: so.trim(), err: err.slice(0, 200) });
    });
    child.on("error", (e) => resolve({ code: null, lines: [], so: "", err: String(e) }));
  });
}
function winops(action, extra = []) {
  PS_SEQ += 1;
  const out = join(OUT_DIR, `winops-${process.pid}-${PS_SEQ}.txt`);
  return spawnCollect(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      PS1,
      "-Action",
      action,
      "-ProcId",
      String(MAIN_PID),
      "-OutFile",
      out,
      ...extra,
    ],
    out,
  );
}
function parseLines(lines) {
  const out = {};
  for (const l of lines) {
    const i = l.indexOf("=");
    if (i < 0) continue;
    const k = l.slice(0, i);
    const v = l.slice(i + 1);
    if (out[k] === undefined) out[k] = v;
    else out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
  }
  return out;
}
const resolveMainPid = async () => {
  const info = parseLines((await winops("resolve")).lines);
  const n = Number(info["main-pid"]);
  MAIN_PID = Number.isInteger(n) && n > 0 ? n : 0;
  return { pid: MAIN_PID, info };
};
async function setOuter(w, h) {
  const r = await spawnCollect("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    PSWIN,
    "-OuterWidth",
    String(w),
    "-OuterHeight",
    String(h),
  ]);
  return r.so || r.err;
}

/**
 * 改窗到目标档并**以页内实测 CSS 复核**（≤4 次重试）。
 * 6.9 首轮实机教训：off-screen 158×26 幽灵窗会让 ps-win 的面积筛选选错 hwnd，
 * MoveWindow 全部打在不可见窗上、回报却像"成功"（outer 恒 158x26）⇒
 * **回报不可信，一律用实测 innerW 判定是否真的改到位**。
 */
async function resizeTo(call, tier) {
  let ps = "";
  let geo = null;
  for (let att = 0; att < 4; att++) {
    ps = await setOuter(tier.outer[0], tier.outer[1]);
    await sleep(900);
    geo = await geometry(call);
    if (Math.abs(geo.innerW - tier.css) <= 24) {
      await sleep(400);
      return { ps, geo, attempts: att + 1 };
    }
  }
  return { ps, geo, attempts: 4 };
}

// ---------------------------------------------------------------------------
// CDP（全部有界——6.6/6.7 假绿教训）
// ---------------------------------------------------------------------------

const STORE_NEEDLE = ["/src/renderer/src/store.ts", "/src/store.ts"];
const MONACO_NEEDLE = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];

function makeEventSession(pageUrl) {
  const ws = new WebSocket(pageUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (raw) => {
    const m = JSON.parse(raw.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  };
  return new Promise((res, rej) => {
    ws.onopen = () => {
      const call = (method, params = {}) =>
        new Promise((ok, bad) => {
          const i = ++id;
          pending.set(i, ok);
          try {
            ws.send(JSON.stringify({ id: i, method, params }));
          } catch (e) {
            pending.delete(i);
            bad(e);
          }
        });
      res(call);
    };
    ws.onerror = rej;
  });
}
const CALL_TIMEOUT_MS = 30000;
const callBounded = (call, method, params = {}) =>
  Promise.race([
    call(method, params),
    sleep(CALL_TIMEOUT_MS).then(() => {
      throw new Error(`cdp-call-timeout: ${method}`);
    }),
  ]);
const ev = async (call, expression) => {
  const r = await callBounded(call, "Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails)
    throw new Error(`ev: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
  return r?.result?.value;
};
async function appImport(call, needles, body) {
  const expr = `(async () => {
    const all = performance.getEntriesByType('resource').map(e => e.name);
    const rank = (n) => (n.includes('?t=') ? 0 : n.includes('/@fs/') ? 2 : 1);
    const urls = all.filter(n => ${JSON.stringify(needles)}.some(w => n.includes(w)))
      .sort((a, b) => rank(a) - rank(b));
    if (urls.length === 0) return JSON.stringify({ error: 'module-url-not-found' });
    const m = await import(urls[0]);
    ${body}
  })()`;
  const r = await callBounded(call, "Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new Error(`appImport: ${r.exceptionDetails.exception?.description ?? "err"}`);
  return JSON.parse(String(r?.result?.value));
}
const storeQ = (call, body) =>
  appImport(call, STORE_NEEDLE, `const s = m.useAppStore.getState(); ${body}`);
const draftsOf = (call) =>
  storeQ(call, "return JSON.stringify({ calls: s.drafts.calls, modelAb: s.drafts.modelAb });");

const geometry = (call) =>
  ev(
    call,
    "JSON.stringify({innerW:window.innerWidth,innerH:window.innerHeight,dpr:window.devicePixelRatio,vvScale:window.visualViewport?window.visualViewport.scale:null})",
  ).then((s) => JSON.parse(s));

/** 整页横向溢出（200% 专属加测：不通过横向滚动藏正文） */
const pageOverflow = (call) =>
  ev(
    call,
    "JSON.stringify({scrollW:document.documentElement.scrollWidth,bodyScrollW:document.body.scrollWidth,innerW:window.innerWidth})",
  ).then((s) => JSON.parse(s));

/** 读核对网格几何：轨道数 + 两侧宽/绘制右溢/可见性 +「放弃修改」视口可达（同 6.8） */
function measureGrid(call, marker) {
  return ev(
    call,
    `(() => {
      const grid = document.querySelector('[data-draft-compare="${marker}"]');
      if (!grid) return JSON.stringify({ error: 'grid-not-found' });
      const cs = getComputedStyle(grid);
      const tracks = cs.gridTemplateColumns.split(/\\s+/).filter((x) => x !== "" && parseFloat(x) > 0).length;
      const cells = Array.from(grid.children);
      const sideOf = (cell) => {
        const ed = cell.querySelector('.monaco-editor');
        const ta = cell.querySelector('textarea');
        const box = ed ?? ta ?? cell;
        const rect = box.getBoundingClientRect();
        let paintOverflowRight = 0;
        let renderedLines = 0;
        if (ed) {
          const vl = Array.from(ed.querySelectorAll('.view-lines .view-line'));
          renderedLines = vl.filter((l) => (l.textContent ?? '').trim() !== '').length;
          for (const l of vl) paintOverflowRight = Math.max(paintOverflowRight, Math.round(l.getBoundingClientRect().right - rect.right));
        } else if (ta) {
          paintOverflowRight = Math.max(0, Math.round(ta.scrollWidth - ta.clientWidth));
          renderedLines = (ta.value ?? '').split('\\n').length;
        } else {
          paintOverflowRight = Math.max(0, Math.round(cell.scrollWidth - cell.clientWidth));
          renderedLines = (cell.innerText ?? '').split('\\n').filter((x) => x.trim() !== '').length;
        }
        const labelEl = cell.querySelector('div');
        return {
          kind: ed ? 'monaco' : ta ? 'textarea' : 'text',
          label: (labelEl?.textContent ?? '').trim().slice(0, 24),
          boxW: Math.round(rect.width),
          boxH: Math.round(rect.height),
          paintOverflowRight: Math.max(0, paintOverflowRight),
          renderedLines,
          cellText: ed || ta ? null : (cell.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160),
          visible: rect.width > 0 && rect.height > 0 && box.offsetParent !== null,
        };
      };
      const btn = (label) => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => ((x.textContent || '').trim()) === label && x.offsetParent !== null);
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        return { w: Math.round(r.width), inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight };
      };
      return JSON.stringify({ tracks, sideCount: cells.length, sides: cells.map(sideOf), discardBtn: btn('放弃修改') });
    })()`,
  ).then((s) => JSON.parse(s));
}

/** 网格内两个 Monaco 的 model 完整度（同 6.8：原值只读、草稿可编辑） */
function monacoModelInfo(call) {
  return appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
    const eds = monaco.editor.getEditors().filter((e) => e.getDomNode()?.offsetParent !== null);
    const ro = eds.find((e) => e.getOption(monaco.editor.EditorOption.readOnly) === true);
    const ed = eds.find((e) => e.getOption(monaco.editor.EditorOption.readOnly) !== true);
    const snap = (e) => {
      if (!e) return null;
      const mdl = e.getModel();
      const n = mdl.getLineCount();
      return { lines: n, chars: mdl.getValueLength(), value: (mdl.getValue() ?? '').slice(0, 2000) };
    };
    return JSON.stringify({ original: snap(ro), draft: snap(ed) });`,
  );
}

// ---------------------------------------------------------------------------
// 编辑器导航（复用 6.1/6.4/6.8 真 UI 路径）
// ---------------------------------------------------------------------------

async function clickTab(call, label) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
      .find(x => ((x.textContent||'').trim()) === '${label}');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok !== true) return false;
  await sleep(1000);
  const selected = await ev(
    call,
    `(() => { const t = Array.from(document.querySelectorAll('[role="tab"]'))
      .find(x => x.getAttribute('aria-selected') === 'true');
      return t === null ? null : ((t.textContent||'').trim()); })()`,
  );
  return selected === label;
}
async function selectRun(call, id) {
  const hitRow = `(() => {
      const copy = Array.from(document.querySelectorAll('button'))
        .find(b => (b.getAttribute('aria-label') || '').startsWith('复制完整运行 ID ${id}'));
      if (!copy) return false;
      const row = copy.parentElement;
      const sel = row ? row.querySelector('button') : null;
      if (!sel) return false;
      sel.click(); return true; })()`;
  let ok = false;
  for (let i = 0; i < 24 && ok !== true; i++) {
    ok = await ev(call, hitRow);
    if (ok !== true) {
      await clickTab(call, "概览");
      await sleep(700);
    }
  }
  if (ok !== true) throw new Error(`运行列表找不到 ${id}`);
  await sleep(1500);
}
async function clickSpan(call, titleFragment, expectSpanId) {
  const clickNth = (n) => `(() => {
    const rows = Array.from(document.querySelectorAll('button'))
      .filter(b => ((b.title||'').includes('${titleFragment}')));
    if (rows.length <= ${n}) return false;
    rows[${n}].click(); return true; })()`;
  for (let n = 0; n < 6; n++) {
    if ((await ev(call, clickNth(n))) !== true) break;
    await sleep(1200);
    const sel = await storeQ(call, "return JSON.stringify({ sel: s.selectedSpanId });");
    if (sel.sel === expectSpanId) return true;
  }
  throw new Error(`未能选中 span ${expectSpanId}`);
}
async function clickByText(call, text, wait = 800) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => ((x.textContent||'').trim()).includes('${text}'));
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok !== true) throw new Error(`找不到按钮「${text}」`);
  await sleep(wait);
}
async function typeIntoEditableMonaco(call, text) {
  let idx = null;
  for (let i = 0; i < 12; i++) {
    const info = await appImport(
      call,
      MONACO_NEEDLE,
      `const monaco = await m.ensureMonaco();
      const ed = monaco.editor.getEditors().map((e, i) => ({
        i,
        readOnly: e.getOption(monaco.editor.EditorOption.readOnly) === true,
        visible: e.getDomNode() !== null && e.getDomNode().offsetParent !== null,
      }));
      return JSON.stringify({ editors: ed });`,
    );
    const target = info.editors.filter((e) => e.visible && !e.readOnly);
    if (target.length > 0) {
      idx = target[0].i;
      break;
    }
    await sleep(500);
  }
  if (idx === null) throw new Error("无可编辑 monaco（轮询 6s）");
  const c = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const e = monaco.editor.getEditors()[${idx}];
     const cur = e.getModel().getValue();
     e.trigger('keyboard', 'type', { text: ${JSON.stringify(text)} });
     await new Promise((r) => setTimeout(r, 600));
     return JSON.stringify({ changed: e.getModel().getValue() !== cur });`,
  );
  if (c.changed !== true) throw new Error("monaco 键入未生效");
}
async function setReactInput(call, selector, value) {
  const r = await ev(
    call,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'no-el';
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'set:' + (el.value ?? '').length; })()`,
  );
  if (!String(r).startsWith("set:")) throw new Error(`受控输入写入失败(${selector}): ${r}`);
}

const LONG_LINES = 12;
function makeLongDraft(tagMark) {
  return Array.from(
    { length: LONG_LINES },
    (_, i) => `L${i + 1}-${tagMark}-200缩放完整核对-${"内容".repeat(40)}-${i + 1}末`,
  ).join("\n");
}

/** 等网格就绪：在场且两侧盒宽 ≥100px（Monaco 换档重挂首帧 5px 壳——6.8 实测） */
async function waitGridReady(call, marker, budgetMs = 12000) {
  const t0 = Date.now();
  let mg = null;
  for (;;) {
    mg = await measureGrid(call, marker);
    if (!mg.error && mg.sides.length >= 2 && mg.sides.every((s) => s.boxW >= 100)) return mg;
    if (Date.now() - t0 > budgetMs) return mg;
    await sleep(600);
  }
}

// ---------------------------------------------------------------------------
// 每档共用断言（200% 缩放专属）
// ---------------------------------------------------------------------------

function assertZoomTier(tier, geo, mg, po) {
  const name = (n) => `${tier.css}px(200%) ${n}`;
  check(
    name("缩放真实生效：dpr=系统2.1×zoom2≈4.2"),
    Math.abs(geo.dpr - EXPECT_DPR) <= 0.05,
    JSON.stringify(geo),
  );
  check(
    name("视口实测命中目标 CSS 档（±24）"),
    Math.abs(geo.innerW - tier.css) <= 24,
    JSON.stringify(geo),
  );
  const expectTracks = geo.innerW >= 1280 ? 2 : 1;
  check(
    name(`网格轨道数 = ${expectTracks}（xl=1280 断点：${expectTracks === 2 ? "并排" : "上下"}）`),
    mg.tracks === expectTracks,
    `tracks=${mg.tracks}`,
  );
  check(
    name("两侧面板都在场（原值 + 草稿）"),
    mg.sideCount >= 2,
    JSON.stringify(mg.sides.map((s) => s.kind)),
  );
  const [orig, draft] = mg.sides;
  check(
    name("原值侧可见、正文盒 ≥200px（未缩小正文）"),
    orig.visible === true && orig.boxW >= 200,
    JSON.stringify(orig),
  );
  check(
    name("草稿侧可见、正文盒 ≥200px（未缩小正文）"),
    draft.visible === true && draft.boxW >= 200,
    JSON.stringify(draft),
  );
  check(
    name("两侧绘制无右溢（wordWrap 生效，不靠横滚看全文）"),
    orig.paintOverflowRight <= 2 && draft.paintOverflowRight <= 2,
    JSON.stringify([orig.paintOverflowRight, draft.paintOverflowRight]),
  );
  check(
    name("整页无横向溢出（scrollWidth ≤ 视口+2）"),
    po.scrollW <= po.innerW + 2 && po.bodyScrollW <= po.innerW + 2,
    JSON.stringify(po),
  );
  check(
    name("操作可达：滚动后「放弃修改」按钮完整落入视口"),
    mg.discardBtn !== null && mg.discardBtn.inViewport === true,
    JSON.stringify(mg.discardBtn),
  );
}

/** 内容完整度（Monaco model）：草稿 12 行全在、首/末行标记齐；原值非空 */
function assertTierContent(tier, mi, tagMark) {
  const name = (n) => `${tier.css}px(200%) ${n}`;
  const v = mi.draft?.value ?? "";
  check(
    name(
      `草稿侧 model 完整（≥${LONG_LINES} 行，含 L1-${tagMark} / L${LONG_LINES}-${tagMark} / ${LONG_LINES}末）`,
    ),
    mi.draft !== null &&
      mi.draft.lines >= LONG_LINES &&
      v.includes(`L1-${tagMark}`) &&
      v.includes(`L${LONG_LINES}-${tagMark}`) &&
      v.includes(`${LONG_LINES}末`),
    JSON.stringify({ lines: mi.draft?.lines, chars: mi.draft?.chars, tail: v.slice(-40) }),
  );
  check(
    name("原值侧 model 非空（就近对照在场）"),
    mi.original !== null && mi.original.chars > 0,
    JSON.stringify(mi.original?.chars),
  );
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

/** ① tool-result：三档核对 + 极窄档现场键入（编辑可达） */
async function tagToolResult(call, fx) {
  await selectRun(call, fx.normalRun);
  await clickTab(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickByText(call, "在此重跑（时间旅行）", 1500);
  const draft = makeLongDraft("TR");
  await typeIntoEditableMonaco(call, draft);
  const d0 = await draftsOf(call);
  let curText = d0?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "";
  check(
    "长草稿已入 store（含末行标记）",
    curText.includes(`L${LONG_LINES}-TR`) && curText.includes("末"),
    curText.slice(-60),
  );

  const per = {};
  for (const [tierIdx, tier] of TIERS.entries()) {
    const { ps, geo } = await resizeTo(call, tier);
    // 极窄档：先现场键入再测——200% 缩放态编辑可达（store 同源核对）
    if (tierIdx === TIERS.length - 1) {
      await typeIntoEditableMonaco(call, "-Z2极窄档键入末");
      const dz = await draftsOf(call);
      curText = dz?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "";
      check(
        "200% 极窄档现场键入进 store（编辑可达）",
        curText.includes("Z2极窄档键入末"),
        curText.slice(-60),
      );
    }
    const mg = await waitGridReady(call, "tool-result");
    if (mg.error) throw new Error(`${tier.css}px 网格未找到：${mg.error}`);
    const po = await pageOverflow(call);
    assertZoomTier(tier, geo, mg, po);
    const mi = await monacoModelInfo(call);
    assertTierContent(tier, mi, "TR");
    const dd = await draftsOf(call);
    check(
      `${tier.css}px(200%) 改窗往返草稿逐字保留`,
      (dd?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "") === curText,
    );
    const pic = await shot(call, SHOT_DIR, `69-tool-result-${tier.css}.png`).catch(() => null);
    per[tier.css] = { ps, geo, mg, po, mi, shot: pic !== null };
  }
  return per;
}

/** ② prompt：两字段独立草稿 × 三档；极窄档现场键入 */
async function tagPrompt(call, fx) {
  await selectRun(call, fx.normalRun);
  await clickTab(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  await clickByText(call, "编辑 system prompt 重跑", 1500);
  const vA = makeLongDraft("PA");
  const vB = makeLongDraft("PB");
  await typeIntoEditableMonaco(call, vA);
  await clickByText(call, "首条 user message", 1200);
  await typeIntoEditableMonaco(call, vB);
  const d = await draftsOf(call);
  const fields = d?.calls?.[fx.normalRun]?.s_02 ?? {};
  const tA = fields?.system_prompt?.text ?? "";
  const tB = fields?.user_message?.text ?? "";
  check(
    "两字段草稿各自入 store 且不串值",
    tA.includes("L12-PA") && tB.includes("L12-PB") && !tA.includes("PB") && !tB.includes("PA"),
    JSON.stringify([tA.slice(-16), tB.slice(-16)]),
  );
  await clickByText(call, "system prompt", 1200);

  const per = {};
  for (const [tierIdx, tier] of TIERS.entries()) {
    const { ps, geo } = await resizeTo(call, tier);
    if (tierIdx === TIERS.length - 1) {
      await typeIntoEditableMonaco(call, "-Z2窄档键入末");
      const dz = await draftsOf(call);
      check(
        "200% 极窄档现场键入进 store（编辑可达、只进当前字段）",
        (dz?.calls?.[fx.normalRun]?.s_02?.system_prompt?.text ?? "").includes("Z2窄档键入末"),
      );
    }
    const mg = await waitGridReady(call, "prompt");
    if (mg.error) throw new Error(`${tier.css}px 网格未找到：${mg.error}`);
    const po = await pageOverflow(call);
    assertZoomTier(tier, geo, mg, po);
    const mi = await monacoModelInfo(call);
    assertTierContent(tier, mi, "PA");
    const pic = await shot(call, SHOT_DIR, `69-prompt-${tier.css}.png`).catch(() => null);
    per[tier.css] = { geo, mg, po, mi, shot: pic !== null };
  }
  return per;
}

/** ③ model-ab：长臂参数静态对照 × 三档；极窄档现场写入 */
async function tagModelAb(call, fx) {
  await selectRun(call, fx.normalRun);
  await clickTab(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  await clickByText(call, "模型 A/B", 1500);
  const longParams = `{"temperature":0.${"7".repeat(30)},"tag":"AB200缩放核对-末"}`;
  await setReactInput(call, 'input[placeholder^="采样参数 JSON"]', longParams);
  const d = await draftsOf(call);
  const rowsText = JSON.stringify(d?.modelAb?.[fx.normalRun] ?? null);
  check(
    "A/B 批次草稿已入 store（长 params 在位）",
    rowsText.includes("AB200缩放核对"),
    rowsText.slice(0, 100),
  );

  const per = {};
  for (const [tierIdx, tier] of TIERS.entries()) {
    const { ps, geo } = await resizeTo(call, tier);
    if (tierIdx === TIERS.length - 1) {
      await setReactInput(call, 'input[placeholder^="采样参数 JSON"]', `${longParams}Z2窄档写入末`);
      const dz = await draftsOf(call);
      check(
        "200% 极窄档现场写入臂参数进 store（编辑可达）",
        JSON.stringify(dz?.modelAb?.[fx.normalRun] ?? "").includes("Z2窄档写入末"),
      );
    }
    const mg = await measureGrid(call, "model-ab");
    if (mg.error) throw new Error(`${tier.css}px 网格未找到：${mg.error}`);
    const po = await pageOverflow(call);
    const name = (n) => `${tier.css}px(200%) ${n}`;
    check(
      name("缩放真实生效：dpr=系统2.1×zoom2≈4.2"),
      Math.abs(geo.dpr - EXPECT_DPR) <= 0.05,
      JSON.stringify(geo),
    );
    check(
      name("视口实测命中目标 CSS 档（±24）"),
      Math.abs(geo.innerW - tier.css) <= 24,
      JSON.stringify(geo),
    );
    const expectTracks = geo.innerW >= 1280 ? 2 : 1;
    check(name(`网格轨道数 = ${expectTracks}`), mg.tracks === expectTracks, `tracks=${mg.tracks}`);
    const [base, draftSide] = mg.sides;
    check(
      name("基线侧与草稿侧都在场且 ≥200px（未缩小正文）"),
      mg.sideCount >= 2 &&
        base.visible &&
        draftSide.visible &&
        base.boxW >= 200 &&
        draftSide.boxW >= 200,
      JSON.stringify(mg.sides.map((s) => ({ w: s.boxW, k: s.kind }))),
    );
    check(
      name("草稿侧就近显示长 params 全文（含末标记，不截断）"),
      String(draftSide.cellText ?? "").includes("末") &&
        String(draftSide.cellText ?? "").includes("AB200缩放核对"),
      String(draftSide.cellText ?? "").slice(0, 100),
    );
    check(
      name("基线侧非空且与草稿侧不同（两侧不串值）"),
      String(base.cellText ?? "").length > 0 && base.cellText !== draftSide.cellText,
      JSON.stringify([
        String(base.cellText ?? "").slice(0, 40),
        String(draftSide.cellText ?? "").slice(0, 40),
      ]),
    );
    check(
      name("两侧无横向绘制溢出 + 整页无横向溢出"),
      base.paintOverflowRight <= 2 &&
        draftSide.paintOverflowRight <= 2 &&
        po.scrollW <= po.innerW + 2,
      JSON.stringify([base.paintOverflowRight, draftSide.paintOverflowRight, po]),
    );
    const inputsIn = await ev(
      call,
      `(() => { const t = document.querySelector('input[placeholder^="采样参数 JSON"]');
        if (!t) return false;
        t.scrollIntoView({ block: 'center' });
        const r = t.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; })()`,
    );
    check(name("操作可达：臂参数输入框滚动后完整落入视口"), inputsIn === true, String(inputsIn));
    const pic = await shot(call, SHOT_DIR, `69-model-ab-${tier.css}.png`).catch(() => null);
    per[tier.css] = { geo, mg, po, shot: pic !== null };
  }
  return per;
}

const TAGS = { "tool-result": tagToolResult, prompt: tagPrompt, "model-ab": tagModelAb };

async function main() {
  const fx = fixture();
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const run = TAGS[TAG];
  if (run === undefined) throw new Error(`unknown tag: ${TAG}`);
  const data = loadOut();
  const watchdog = setTimeout(() => {
    console.error("[watchdog] 300s 未收尾 ⇒ 非零退出并落盘已有检查");
    try {
      const dd = loadOut();
      dd.checks = dd.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
      dd.measurements[TAG] = { failure: "watchdog-300s" };
      saveOut(dd);
    } catch {
      /* 落盘失败也要非零 */
    }
    process.exit(3);
  }, 300000);
  const page = await cdpConnect(PORT);
  if (!page) throw new Error("CDP 9612 上没有页面（dev 未起？）");
  const call = await makeEventSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});

  // ⚠️ 200% 缩放的窗口次序坑（6.9 实机）：默认窗口在 zoom=2 下 CSS≈605 ⇒ 落进**窄档**、
  // 运行导航整列收起（「复制完整运行 ID」按钮不渲染）⇒ 就绪轮询必须先**真实改窗到宽档**再做
  //（6.8 的 zoom1 默认窗 1210 CSS 属 medium 档、列表在场，所以顺序不同也能过）。
  await winops("restore");
  const resolved = await resolveMainPid();
  check("已唯一认定本仓库 dev 主进程 PID", resolved.pid > 0, JSON.stringify(resolved.info));
  const start = await resizeTo(call, TIERS[0]);
  check(
    "起点宽档窗口真实就位（CSS≈1284，运行列表在场的前提）",
    Math.abs(start.geo.innerW - TIERS[0].css) <= 24,
    JSON.stringify({ ps: start.ps, geo: start.geo, attempts: start.attempts }),
  );

  const RUNS_EXPR = `(() => Array.from(document.querySelectorAll('button'))
    .map(b => b.getAttribute('aria-label') || '')
    .filter(a => a.startsWith('复制完整运行 ID')).length)()`;
  let prev = -1;
  let readyRuns = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(700);
    let n = 0;
    try {
      n = Number(await ev(call, RUNS_EXPR)) || 0;
    } catch {
      n = -1;
    }
    if (n > 0 && n === prev) {
      readyRuns = n;
      break;
    }
    prev = n;
  }
  if (readyRuns === 0) throw new Error("运行列表未就绪——夹具未加载");

  // 缩放注入在场性（早退判据：M1 变异禁用注入时 dpr=2.1 ⇒ 这里就红）
  const baseGeo = await geometry(call);
  check(
    "dev 以 REBASEAGENT_ZOOM_FACTOR=2 启动（基准 dpr≈4.2）",
    Math.abs(baseGeo.dpr - EXPECT_DPR) <= 0.05,
    JSON.stringify(baseGeo),
  );

  let out = {};
  let failure = null;
  try {
    out = (await run(call, fx)) ?? {};
    out.baseGeo = baseGeo;
  } catch (e) {
    failure = String(e);
    check(`[${TAG}] 场景未抛异常`, false, failure);
  }
  data.measurements[TAG] = failure === null ? out : { ...out, failure };
  data.checks = data.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
  saveOut(data);
  const failed = checks.filter((c) => !c.ok);
  clearTimeout(watchdog);
  console.log(`\n完成：[${TAG}] ${checks.length - failed.length}/${checks.length} 通过`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
