/* eslint-disable */
/**
 * U4 任务 6.8：窄窗口 / 200% 缩放 / 键盘焦点下的操作入口，U1–U3 回归，
 * 以及"只读入口与被动录制不占主动槽 / 核对只由用户明确打开 / 登记不泄漏输入与凭据"。
 *
 * 覆盖 delta 场景（逐字标题）：
 * - `操作入口在窄窗口和键盘下可达`（tag `narrow-keyboard` @800px、tag `zoom200-keyboard` @200%）
 * - `核对结果只由用户明确打开`、`只读入口和被动录制不占主动槽`、`会话登记不泄漏输入和凭据`（tag `readonly-noslot`）
 * - U1 阅读 / U2 文件 / U3 草稿 回归 + `既有文件哈希不变`（折进 `narrow-keyboard` 与 `readonly-noslot`）
 *
 * 三条写判据前必须知道的口径：
 * 1. **改窗宽一律真 MoveWindow + 页内 `window.innerWidth` 复核**（项目记忆 6.9 条：GetWindowRect 回报不可信）；
 * 2. **`REBASEAGENT_ZOOM_FACTOR` 会被 Chromium 持久化** ⇒ 驱动跑完必须在 dev 停止后 reset-zoom（u3-69 的现成件）；
 * 3. **top-layer 模态盖不住、输入锁靠捕获 preventDefault**（6.7 实测）⇒ 键盘可达性一律
 *    `element.focus()` + 真 `Input.dispatchKeyEvent`，别拿 `elementFromPoint` 当命中判据。
 *
 * 用法：node apps/desktop/scripts/u4-68-cdp.cjs --tag=<narrow-keyboard|zoom200-keyboard|readonly-noslot>
 */
"use strict";
const { createConnection } = require("node:net");
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { setWindowOuter } = require("./lib/u2-cdp-util.cjs");

const TAGS = ["narrow-keyboard", "zoom200-keyboard", "readonly-noslot"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u4", "u4-68");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-27-u4-68");
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const TASK_MARK = "U4-68";
const API_KEY_MARK = "sk-u468-leakcanary";
const ENTRY_BTN = 'button[aria-controls="operations-panel"]';
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

const checks = [];
const dump = { layout: [], leaks: [], strayErrors: [] };
function check(name, ok, detail) {
  checks.push({ tag: TAG, name, ok: ok === true, detail: detail ?? null });
  const shown =
    detail === undefined || detail === null
      ? ""
      : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : shown}`);
}
function finish() {
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条；证据 ${SHOT_DIR}`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超时未收尾 ⇒ 判失败退出`);
  try {
    writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  } catch {
    /* 落盘失败也要非零退出 */
  }
  process.exit(3);
}, 420_000);

let call = null;
const pageDialogs = [];

// ---------------------------------------------------------------------------
// 有界 CDP + 真键盘 + 真改窗
// ---------------------------------------------------------------------------

const CALL_TIMEOUT_MS = 30_000;
const callB = (method, params = {}) =>
  Promise.race([
    call(method, params),
    H.sleep(CALL_TIMEOUT_MS).then(() => {
      throw new Error(`cdp-call-timeout(${CALL_TIMEOUT_MS}ms): ${method}`);
    }),
  ]);
const evB = async (expression) => {
  const r = await callB("Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails)
    throw new Error(`ev: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
  return r?.result?.value;
};
/** 页内实测视口（MoveWindow 的回报不可信，只信这个） */
const innerWidth = async () => Number(await evB("String(window.innerWidth)"));
/**
 * 真改外框到**目标 CSS 视口宽**。本机 virtual→CSS 比值 ≈1.42（不是 DPR 2.1，DPI-unaware 的
 * PowerShell 坐标虚拟化把它压掉了）；但比值会随当前窗口态漂移，故先量一次算比值再解一次，
 * MoveWindow 的回报不可信（幽灵窗抢 hwnd）⇒ 一律以页内 `window.innerWidth` 判命中。
 */
async function resizeOuter(cssWidth, cssHeight = 900, slack = 48) {
  const attempt = async (virtual, vHeight) => {
    const ps = setWindowOuter(virtual, vHeight);
    await H.sleep(1100);
    const got = await innerWidth();
    dump.layout.push({ want: cssWidth, virtual, got, ps: ps.slice(0, 60) });
    return got;
  };
  let v = cssWidth;
  let got = await attempt(v, cssHeight);
  for (let i = 0; i < 4 && got > 0 && Math.abs(got - cssWidth) > slack; i++) {
    v = Math.round(v * (cssWidth / got));
    got = await attempt(v, Math.round(cssHeight * (cssWidth / got)));
  }
  return got;
}
/** 窄档下步骤目录默认收起 ⇒ 若在就点「重新打开步骤目录」 */
async function ensureStepsOpen() {
  const r = await evB(
    `(() => { const b = document.querySelector('[data-open-steps]');
      if (!b) return 'not-needed';
      b.click(); return 'opened'; })()`,
  );
  await H.sleep(1200);
  return r;
}
/** 窄档（narrow/single）下运行列表默认收起 ⇒ 回归前先按 aria-controls 打开导航开关 */
async function ensureNavOpen() {
  const before = (await H.runs(call).catch(() => [])).length;
  const st = await evB(
    `(() => { const b = document.querySelector('button[aria-controls="run-navigation"]');
      if (!b) return 'no-toggle';
      const expanded = b.getAttribute('aria-expanded');
      if (expanded !== 'true') b.click();
      return 'clicked:' + expanded; })()`,
  );
  await H.sleep(1500);
  const after = (await H.runs(call).catch(() => [])).length;
  return { st, before, after };
}
/**
 * 真按键三件套。⚠️ 只发 keyDown/keyUp **不会**触发按钮默认激活（实测 Enter 打不开面板）：
 * Blink 的"回车点击聚焦按钮"发生在 keyPress/text 派发链上 ⇒ 必须补 keyPress。
 */
/**
 * 真按键。⚠️ 本批实测：`keyDown(带 text)` 会让 Blink 自己补一次 keypress，再显式发一次 `char`
 * 就是**两个原生 click** ⇒ 对"入口是开关"的按钮等于开→关，面板看着没开。
 * 故激活一律走 `activateFocused` 的"单发序列"，并把命中的序列记进 dump。
 */
async function sendKey(type, key, code, text) {
  const base = {
    type,
    key,
    code,
    windowsVirtualKeyCode: keyCodeOf(code),
    nativeVirtualKeyCode: keyCodeOf(code),
  };
  if (text !== undefined) await callB("Input.dispatchKeyEvent", { ...base, text, unmodifiedText: text });
  else await callB("Input.dispatchKeyEvent", base);
}
function keyCodeOf(code) {
  return { Enter: 13, Space: 32, Escape: 27, Tab: 9 }[code] ?? 0;
}
const KEY_SEQUENCES = {
  "char-only": [{ t: "char", x: "\r" }],
  "down-up": [
    { t: "keyDown", x: "\r" },
    { t: "keyUp" },
  ],
  "down-char-up": [
    { t: "keyDown", x: "\r" },
    { t: "char", x: "\r" },
    { t: "keyUp" },
  ],
};
/**
 * 键盘激活当前焦点元素：装真 click 计数哨，逐个候选序列试到**恰一次** click 为止
 * （多了就是被开关吃掉，少了就是没激活 ⇒ 都换下一个序列）。
 */
async function activateFocused(label) {
  const before = await evB(
    `(() => { const a = document.activeElement;
      if (!a) return 'none';
      window.__actSpy = 0;
      a.addEventListener('click', () => { window.__actSpy += 1; });
      return (a.tagName||'') + '|' + ((a.textContent||'').trim()).slice(0, 30) + '|' + (a.getAttribute('aria-label')||''); })()`,
  );
  const trials = [];
  let via = null;
  for (const [name, steps] of Object.entries(KEY_SEQUENCES)) {
    await evB("(() => { window.__actSpy = 0; return true; })()");
    for (const s of steps) await sendKey(s.t, s.t === "keyUp" ? "Enter" : "Enter", "Enter", s.x);
    await H.sleep(600);
    const spy = Number(await evB("String(window.__actSpy ?? -1)"));
    const open = await evB(
      `(() => { const b = document.querySelector(${JSON.stringify(ENTRY_BTN)});
        return b === null ? 'no-btn' : (b.getAttribute('aria-expanded') ?? 'null'); })()`,
    );
    trials.push({ seq: name, spy, expanded: open });
    if (spy === 1 && open === "true") {
      via = name;
      break;
    }
    if (open === "true") via = via ?? `${name}(spy=${spy})`;
  }
  dump.layout.push({ at: `activate:${label}`, before, trials, via });
  return { before, via, trials };
}
async function pressKey(key, code) {
  await sendKey("keyDown", key, code);
  await sendKey("keyUp", key, code);
}
/** 把焦点交给页内某个元素（等价用户 Tab 到它；焦点不是被锁拦截的事件） */
async function focusBy(selector) {
  const r = await evB(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'missing'; if (el.disabled) return 'disabled';
      el.focus();
      return document.activeElement === el ? 'focused' : 'not-focused'; })()`,
  );
  await H.sleep(300);
  return r;
}
/** 元素矩形是否完整落在视口内（"长文本不遮挡命令"的可测口径） */
async function rectsInViewport(selector) {
  const raw = await evB(
    `(() => JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .map(x => { const r = x.getBoundingClientRect();
        return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom),
                 w: Math.round(r.width), h: Math.round(r.height), text: ((x.textContent||'').trim()).slice(0, 24) }; })
      .filter(x => x.w > 0 || x.h > 0)))()`,
  );
  const vw = await innerWidth();
  const vh = Number(await evB("String(window.innerHeight)"));
  const rects = JSON.parse(raw);
  return { vw, vh, rects, allInside: rects.every((x) => x.l >= 0 && x.r <= vw && x.t >= 0 && x.b <= vh) };
}
/** 文档横向溢出（长 ID 撑破布局的直接证据） */
const hOverflow = async () =>
  Number(
    await evB(
      "String(document.documentElement.scrollWidth - document.documentElement.clientWidth)",
    ),
  );

// ---------------------------------------------------------------------------
// 读数
// ---------------------------------------------------------------------------

const rand = () => Math.random().toString(36).slice(2, 6);
let idSeq = 0;
const freshId = () => {
  idSeq += 1;
  return `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(9, "0")}${String(idSeq).padStart(3, "0")}`;
};
async function mainStatus() {
  const st = await H.apiCall(call, "operationsStatus");
  const list = st?.data?.operations ?? [];
  return {
    ok: st?.ok === true,
    raw: st,
    epoch: st?.data?.epoch ?? null,
    slot: st?.data?.activeOperationId ?? null,
    closing: st?.data?.closing ?? null,
    configBusy: st?.data?.configurationBusy ?? null,
    count: list.length,
    list,
  };
}
const view = () =>
  H.storeQ(
    call,
    `return JSON.stringify({
        epoch: s.operations.epoch, activeOperationId: s.operations.activeOperationId,
        unknown: s.operations.unknown, selectedRunId: s.selectedRunId, selectedSpanId: s.selectedSpanId,
        tab: s.selectedRunId === null ? null : (s.readingByRun?.[s.selectedRunId]?.tab ?? null), operations: s.operations.operations.map(o => ({ id: o.operationId, state: o.state, runIds: o.runIds })),
       });`,
  );
const adoptNow = async () => {
  await H.storeQ(
    call,
    "await s.refreshOperationStatus(); return JSON.stringify({ done: true });",
  );
  return view();
};
const CREATE_SYSTEM = "你是冒烟助手。只回一句话。";
const bridgeCreate = (epoch, operationId, userMessage) =>
  H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `return JSON.stringify(await window.api.createRun({
       operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
       request: { systemPrompt: ${JSON.stringify(CREATE_SYSTEM)}, userMessage: ${JSON.stringify(userMessage)} },
     }));`,
  );
function fireCreate(epoch, operationId, userMessage) {
  return call("Runtime.evaluate", {
    expression: `(async () => JSON.stringify(await window.api.createRun({
      operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
      request: { systemPrompt: ${JSON.stringify(CREATE_SYSTEM)}, userMessage: ${JSON.stringify(userMessage)} },
    })))()`,
    returnByValue: true,
    awaitPromise: true,
  });
}
async function waitMainSettled(operationId, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const st = await mainStatus();
    const rec = st.list.find((o) => o.operationId === operationId) ?? null;
    if (rec !== null && rec.state !== "running") return { rec, st };
    if (Date.now() > deadline) return { rec, st, timedOut: true };
    await H.sleep(500);
  }
}
/** 面板**只读**快照（绝不点按钮：点一下就分不清"键盘打开的"还是"脚本打开的"） */
async function panelSnapshot() {
  const expanded = await evB(
    `(() => { const b = document.querySelector(${JSON.stringify(ENTRY_BTN)});
      if (!b) return 'no-entry';
      return b.getAttribute('aria-expanded') ?? 'null'; })()`,
  );
  const body = await evB(
    `(() => { const p = document.querySelector('#operations-panel');
      return p === null ? null : (p.innerText||''); })()`,
  );
  const buttons = await evB(
    `(() => JSON.stringify(Array.from(document.querySelectorAll('#operations-panel button'))
      .map(x => ((x.textContent||'').trim()).slice(0, 12))))()`,
  );
  return { expanded, open: body !== null, body: body ?? "", buttons: JSON.parse(buttons) };
}
/** 用鼠标把面板点开（只用于与"键盘可达性"无关的判据：泄漏扫描 / 核对-打开按钮） */
async function openPanelByClick() {
  await evB(
    `(() => { const b = document.querySelector(${JSON.stringify(ENTRY_BTN)});
      if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`,
  );
  await H.sleep(900);
  return panelSnapshot();
}
/** 经登记/快照/面板找敏感串（一处不放过：整棵 JSON 的值叶子 + 面板可见文本） */
async function leakScan(sentinel, where) {
  const st = await mainStatus();
  const panel = await openPanelByClick();
  const reconcileProbe = await H.apiCall(call, "operationsReconcile", {
    epoch: st.epoch,
    operationId: st.list[0]?.operationId ?? freshId(),
  });
  const settingsGet = await H.apiCall(call, "getSettings");
  const haystacks = {
    status: JSON.stringify(st.raw),
    panel: panel.body,
    reconcile: JSON.stringify(reconcileProbe),
    settings: JSON.stringify(settingsGet),
  };
  const hits = Object.entries(haystacks)
    .filter(([, text]) => String(text).includes(sentinel))
    .map(([k]) => k);
  dump.leaks.push({
    where,
    sentinel: sentinel.slice(0, 24),
    hits,
    sizes: Object.fromEntries(Object.entries(haystacks).map(([k, v]) => [k, String(v).length])),
    settingsKeys: Object.keys(settingsGet?.data ?? {}),
  });
  return hits;
}
/** 落盘快照：全部 run 文件 + 隔离工作区 blob（`workspace-blobs`，回归面要求逐字节不变） */
const WORKSPACE_BLOBS = join(H.TRACES, "..", "workspace-blobs");
function snapshotHashes(_fx) {
  const traces = H.hashAllTraces();
  const attach = {};
  if (existsSync(WORKSPACE_BLOBS)) {
    for (const name of H.readdirSync(WORKSPACE_BLOBS)) {
      const p = join(WORKSPACE_BLOBS, name);
      if (H.fs.statSync(p).isDirectory()) attach[name] = H.hashSourceDir(p);
      else
        attach[name] = {
          [name]: H.createHash("sha256").update(H.readFileSync(p)).digest("hex"),
        };
    }
  }
  return { traces, attach, roots: existsSync(WORKSPACE_BLOBS) ? [WORKSPACE_BLOBS] : [] };
}
/** 嵌套（目录→文件→哈希）差分 */
function attachHashDiff(before, after) {
  const changed = [];
  const removed = [];
  const added = [];
  for (const [dir, files] of Object.entries(before)) {
    const b = after[dir];
    if (b === undefined) {
      removed.push(dir);
      continue;
    }
    for (const [f, h] of Object.entries(files)) {
      if (b[f] === undefined) removed.push(`${dir}/${f}`);
      else if (b[f] !== h) changed.push(`${dir}/${f}`);
    }
  }
  for (const dir of Object.keys(after)) if (before[dir] === undefined) added.push(dir);
  return { changed, removed, added };
}
function hashDiff(before, after) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [n, h] of Object.entries(before)) {
    if (after[n] === undefined) removed.push(n);
    else if (after[n] !== h) changed.push(n);
  }
  for (const n of Object.keys(after)) if (before[n] === undefined) added.push(n);
  return { changed, added, removed };
}

// ---------------------------------------------------------------------------
// tag: narrow-keyboard —— 800px 窄窗 + 真键盘可达 + U1/U2/U3 回归
// ---------------------------------------------------------------------------
async function tagNarrowKeyboard(fx) {
  const css = await resizeOuter(800, 900);
  check("窄窗口命中 800px 档（页内实测视口）", Math.abs(css - 800) <= 48, css);

  const epoch = (await adoptNow()).epoch;
  const id = freshId();
  const created = await bridgeCreate(epoch, id, `${TASK_MARK} 窄窗真键盘那条 ${rand()}`);
  const done = await waitMainSettled(id);
  const runId = done.rec?.runIds?.[0] ?? null;
  check(
    "窄窗下先有一条真操作可看（真桥接面信封 + settled + 可信 runId）",
    created.ok === true && done.rec?.state === "settled" && runId !== null,
    { ok: created.ok, code: created.error?.code, rec: done.rec?.state },
  );

  const focused = await focusBy(ENTRY_BTN);
  check("操作入口按钮可获得键盘焦点", focused === "focused", focused);
  const activated = await activateFocused("操作入口");
  const panel = await panelSnapshot();
  check(
    "真键盘激活即打开操作入口（恰一次原生 click，不依赖鼠标坐标）",
    activated.via === "char-only" ||
      (Array.isArray(activated.trials) &&
        activated.trials.some((t) => t.spy === 1 && t.expanded === "true")),
    { via: activated.via, trials: activated.trials, open: panel.open },
  );
  check(
    "窄窗下面板里类型 / 状态 / 完整 ID 可读（36 位 operationId 逐字在场）",
    panel.body.includes("纯对话创建") &&
      panel.body.includes("已收口") &&
      panel.body.includes(id) &&
      panel.body.includes(String(runId)),
    panel.body.slice(0, 260),
  );
  // 面板脚注本身会写"登记不显示进度或取消按钮" ⇒ 判据只数**按钮**，不对整段文案做 includes
  check(
    "登记不显示取消能力（按钮里没有停止/取消/中止一类无实现的命令）",
    panel.buttons.every((b) => /停止|取消|中止|终止/.test(b) === false) &&
      panel.buttons.some((b) => b.includes("核对")),
    panel.buttons,
  );
  const cmd = await rectsInViewport("#operations-panel button");
  dump.layout.push({ at: "narrow-panel-buttons", ...cmd });
  check(
    "长文本不遮挡命令（面板内按钮矩形完整落在 800px 视口内）",
    cmd.rects.length >= 1 && cmd.allInside === true,
    { vw: cmd.vw, rects: cmd.rects },
  );
  const overflow = await hOverflow();
  check("窄窗 + 长 ID 不撑破文档横向布局", overflow <= 0, overflow);
  await H.shot(call, SHOT_DIR, "68-narrow-keyboard-panel.png").catch(() => {});

  // ---- 键盘走到行内动作，并确认焦点可回到入口（模态规则的可达性半边） ----
  await focusBy('#operations-panel button[title^="operations:reconcile"]');
  const rowFocused = await evB(
    `(() => { const a = document.activeElement;
      return a === null ? 'none' : ((a.textContent||'').trim()).slice(0, 12); })()`,
  );
  check("面板内动作按钮可被键盘聚焦（Tab 可达）", rowFocused.includes("核对"), rowFocused);
  await pressKey("Escape", "Escape");
  await H.sleep(600);

  // ---- U1 阅读 / U2 文件 / U3 草稿回归（全部在 800px 窄档内做） ----
  const before = snapshotHashes(fx);
  const tracesBefore = before.traces;
  const nav = await ensureNavOpen();
  check("窄档下运行列表可经导航开关打开（回归面的前置）", nav.after > 0, nav);
  await H.clickTab(call, "概览");
  await H.selectRun(call, fx.normalRun);
  const v1 = await view();
  check("U1 回归：窄窗下仍能选中运行并读到身份", v1.selectedRunId === fx.normalRun, v1.selectedRunId);
  const tabs = await evB(
    `(() => JSON.stringify(Array.from(document.querySelectorAll('[role="tab"]'))
      .map(t => ({ label: (t.textContent||'').trim(), sel: t.getAttribute('aria-selected'), dis: t.disabled === true }))))()`,
  );
  dump.layout.push({ at: "narrow-tabs", tabs });
  await H.clickTabChecked(call, "步骤");
  await ensureStepsOpen();
  const spanOk = await H.ev(
    call,
    `(() => Array.from(document.querySelectorAll('button'))
       .some(b => (b.title||'').includes('read_file')))()`,
  );
  check("U1 回归：步骤树在窄窗可读（span 行在场）", spanOk === true, spanOk);
  // U2 文件页签只对**有工作区世界**的 run 出现（普通根 run 只有概览/两页签）⇒ 选隔离根
  await ensureNavOpen();
  await H.clickTab(call, "概览");
  let fileTab = false;
  let fileBody = "";
  try {
    await H.selectRun(call, fx.isoRoot);
    fileTab = await H.clickTab(call, "文件");
    fileBody = String(
      await evB(
        `(() => { const t = document.querySelector('#workspace-panel, [data-workspace-files]')
            ?? document.querySelector('main');
          return t === null ? '' : (t.innerText||'').replace(/\\s+/g,' ').slice(0, 400); })()`,
      ),
    );
  } catch (e) {
    fileBody = `selectRun(isoRoot) 失败：${String(e).slice(0, 120)}`;
  }
  check(
    "U2 回归：隔离根的文件页签在窄窗可达且读得到清单文本",
    fileTab === true && fileBody.length > 20,
    { fileTab, body: fileBody.slice(0, 140) },
  );
  const attachNow = snapshotHashes(fx);
  const attachDiff = attachHashDiff(before.attach, attachNow.attach);
  check(
    "U2 回归：既有工作区附件逐字节不变（只读呈现不写盘）",
    before.roots.length > 0 && attachDiff.changed.length === 0 && attachDiff.removed.length === 0,
    { roots: before.roots, attachDiff },
  );
  await H.clickTab(call, "步骤");
  const draftText = `U4-68 窄窗草稿 ${rand()}`;
  const seeded = await seedResultDraftSafe(fx.normalRun, draftText);
  check("U3 回归：改 result 的草稿在窄窗仍能落 store 并保留", seeded.kept === true, seeded);
  const after = snapshotHashes(fx);
  const diff = hashDiff(tracesBefore, after.traces);
  check(
    "回归全程只读：既有 run 文件逐字节不变（源/父/兄弟都不被改写）",
    diff.changed.length === 0 && diff.removed.length === 0,
    diff,
  );
  const discard = await discardResultDraftSafe(fx.normalRun);
  check("U3 回归收尾：草稿可放弃（不污染下一批）", discard === true, discard);
  return { id, runId, css, panelButtons: panel.buttons.length };
}
async function seedResultDraftSafe(runId, text) {
  try {
    await ensureNavOpen();
    await H.clickTab(call, "概览");
    await H.selectRun(call, runId);
    await H.clickTabChecked(call, "步骤");
    await ensureStepsOpen();
    await H.clickSpan(call, "read_file", "s_03");
    await H.clickByTextChecked(call, "在此重跑（时间旅行）", 1500);
    await H.typeIntoEditableMonaco(call, text);
  } catch (e) {
    return { kept: false, why: String(e).slice(0, 200) };
  }
  const d = await H.drafts(call);
  const got = d?.calls?.[runId]?.s_03?.result?.text ?? "";
  return { kept: got.includes(text), got: got.slice(0, 60) };
}
async function discardResultDraftSafe(runId) {
  try {
    await H.clickByTextChecked(call, "放弃修改", 900);
    await H.clickByTextChecked(call, "确认放弃", 900);
  } catch (e) {
    return `discard-failed: ${String(e).slice(0, 120)}`;
  }
  const d = await H.drafts(call);
  const t = d?.calls?.[runId]?.s_03?.result?.text ?? "";
  return t === "";
}

// ---------------------------------------------------------------------------
// tag: zoom200-keyboard —— 200% 缩放下同一条可达性面
// ---------------------------------------------------------------------------
async function tagZoom200Keyboard(fx) {
  const css = await resizeOuter(1280, 1400);
  const zoom = await evB(
    `(() => { const d = window.devicePixelRatio; return String(d); })()`,
  );
  dump.layout.push({ at: "zoom200", css, dpr: zoom, outer: await evB("String(window.outerWidth)") });
  check(
    "200% 缩放确实生效（dpr ≈ 基线 2.1 × 2；非 Emulation 伪缩放）",
    Number(zoom) > 3.6,
    { dpr: zoom, css },
  );
  const epoch = (await adoptNow()).epoch;
  const id = freshId();
  const created = await bridgeCreate(epoch, id, `${TASK_MARK} 200% 缩放那条 ${rand()}`);
  const done = await waitMainSettled(id);
  const runId = done.rec?.runIds?.[0] ?? null;
  check(
    "200% 缩放下执行链路照常（settled + 可信 runId）",
    created.ok === true && done.rec?.state === "settled" && runId !== null,
    { ok: created.ok, state: done.rec?.state },
  );
  const focused = await focusBy(ENTRY_BTN);
  check("200% 下操作入口仍可获得键盘焦点", focused === "focused", focused);
  await activateFocused("操作入口@200%");
  const panel = await panelSnapshot();
  check(
    "200% 下面板可读（类型 / 状态 / 完整 ID 逐字在场）",
    panel.open === true &&
      panel.body.includes("已收口") &&
      panel.body.includes(id) &&
      panel.body.includes(String(runId)),
    panel.body.slice(0, 240),
  );
  const cmd = await rectsInViewport("#operations-panel button");
  dump.layout.push({ at: "zoom200-panel-buttons", ...cmd });
  check(
    "200% 下动作按钮未被裁出视口（真键盘可达的前提是有命中盒）",
    cmd.rects.length >= 1 && cmd.allInside === true,
    { vw: cmd.vw, rects: cmd.rects },
  );
  const overflow = await hOverflow();
  check("200% 下不出现横向溢出（无遮挡/无破版）", overflow <= 0, overflow);
  await H.shot(call, SHOT_DIR, "68-zoom200-keyboard-panel.png").catch(() => {});
  // 回归一条只读面：200% 下仍能读运行列表
  await ensureNavOpen();
  await H.clickTab(call, "概览");
  await H.selectRun(call, fx.normalRun);
  const v = await view();
  check("200% 下 U1 阅读面照常（可选运行、可读身份）", v.selectedRunId === fx.normalRun, v.selectedRunId);
  return { id, runId, css, dpr: zoom };
}

// ---------------------------------------------------------------------------
// tag: readonly-noslot —— 只读入口/被动录制不占槽 + 核对不导航 + 不泄漏
// ---------------------------------------------------------------------------
async function tagReadonlyNoslot(mock, fx) {
  const css = await resizeOuter(1400, 900);
  dump.layout.push({ at: "readonly-noslot-width", css });
  const base = await mainStatus();
  check("起点：登记为空且槽空闲", base.count === 0 && base.slot === null, {
    count: base.count,
    slot: base.slot,
  });
  const snapshots = snapshotHashes(fx);
  const servedStart = mock.served();
  const filesStart = H.traceIds().size;

  // ---- 只读入口 1：A/B 预览（modelAbPlan，不带信封、不占槽） ----
  const plan = await H.apiCall(call, "modelAbPlan", {
    parentRunId: fx.normalRun,
    arms: [{ model: "mock-model" }, { model: "mock-model", params: { temperature: 1.2 } }],
    dryRun: true,
  });
  const a1 = await mainStatus();
  check(
    "A/B 预览不占主动槽、不登记（只读通道）",
    a1.slot === null && a1.count === 0,
    { slot: a1.slot, count: a1.count, planOk: plan.ok },
  );
  check(
    "A/B 预览零模型请求、零新增文件",
    mock.served() === servedStart && H.traceIds().size === filesStart,
    { served: mock.served(), files: H.traceIds().size },
  );
  dump.preview = { ok: plan.ok, code: plan.error?.code ?? null, arms: plan.data?.plan?.length ?? null };

  // ---- 只读入口 2：隔离能力预检（forkCapability） ----
  const cap = await H.apiCall(call, "forkCapability", {
    parentRunId: fx.normalRun,
    atSpanId: "s_03",
    edit: { field: "result", value: "只读预检不写任何东西" },
  });
  const a2 = await mainStatus();
  check(
    "隔离预检同样不占槽、不登记、零副作用",
    a2.slot === null && a2.count === 0 && mock.served() === servedStart,
    { ok: cap.ok, code: cap.error?.code ?? null, slot: a2.slot, count: a2.count },
  );

  // ---- 被动录制：经代理的外部请求按原契约独立落盘 ----
  const proxyOn = await H.storeQ(
    call,
    `const st = await s.toggleProxy({ enabled: true, port: ${H.PROXY_PORT}, upstreamBaseUrl: ${JSON.stringify(H.MOCK_UPSTREAM)} });
     return JSON.stringify({ running: st?.running === true, hasKey: st?.hasKey === true });`,
  );
  const passive = await proxyChat(`${TASK_MARK} 被动录制不占槽 ${rand()}`);
  const a3 = await mainStatus();
  const kids = [...H.traceIds()].filter((x) => !snapshots.traces[`${x}.jsonl`]).length;
  check(
    "被动录制照常受理并独立落盘，但**不产生登记、不占主动槽**",
    proxyOn.running === true &&
      passive.status === 200 &&
      a3.count === 0 &&
      a3.slot === null &&
      H.traceIds().size === filesStart + 1 &&
      kids >= 1,
    { proxyOn, passive, count: a3.count, slot: a3.slot, files: H.traceIds().size, filesStart },
  );
  await H.storeQ(
    call,
    `await s.toggleProxy({ enabled: false, port: ${H.PROXY_PORT}, upstreamBaseUrl: ${JSON.stringify(H.MOCK_UPSTREAM)} }); return JSON.stringify({ ok: true });`,
  );

  // ---- 一条真操作（带 canary 正文与密钥）⇒ 供核对/打开与泄漏扫描 ----
  const canary = `${TASK_MARK}-正文canary-${rand()}`;
  await H.apiCall(call, "saveSettings", {
    baseURL: H.MOCK_BASE,
    apiKey: API_KEY_MARK,
    model: "mock-model",
  });
  await H.storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
  const epoch = (await adoptNow()).epoch;
  const id = freshId();
  const created = await bridgeCreate(epoch, id, canary);
  const done = await waitMainSettled(id);
  const runId = done.rec?.runIds?.[0] ?? null;
  check(
    "带 canary 正文的真执行收口（供只读面判据使用）",
    created.ok === true && done.rec?.state === "settled" && runId !== null,
    { ok: created.ok, state: done.rec?.state },
  );

  // ---- 会话登记不泄漏输入和凭据 ----
  const bodyHits = await leakScan(canary, "登记不泄漏请求正文");
  check("登记/status/核对/面板全都不含请求正文（canary 零命中）", bodyHits.length === 0, bodyHits);
  const keyHits = await leakScan(API_KEY_MARK, "登记不泄漏凭据");
  check(
    "配置读与登记全都不含 apiKey（凭据 canary 零命中）",
    keyHits.length === 0,
    keyHits,
  );
  const stackHits = await leakScan("at Object.", "登记不泄漏 stack");
  const rawDump = JSON.stringify((await mainStatus()).raw);
  check(
    "快照里没有堆栈与 Error.stack 形状文本",
    stackHits.length === 0 && /"stack"\s*:/.test(rawDump) === false,
    stackHits,
  );

  // ---- 核对结果只由用户明确打开（M-AL 的实机面） ----
  await adoptNow();
  await openPanelByClick();
  const beforeNav = await view();
  const recClicked = await evB(
    `(() => { const b = Array.from(document.querySelectorAll('#operations-panel button'))
        .find(x => ((x.textContent||'').trim()) === '核对状态');
      if (!b) return 'missing'; b.click(); return 'clicked'; })()`,
  );
  await H.sleep(1500);
  const afterReconcile = await view();
  check(
    "点「核对状态」不导航：selectedRunId / span / 页签三项不变",
    recClicked === "clicked" &&
      afterReconcile.selectedRunId === beforeNav.selectedRunId &&
      afterReconcile.selectedSpanId === beforeNav.selectedSpanId &&
      afterReconcile.activeTab === beforeNav.activeTab,
    { recClicked, before: beforeNav.selectedRunId, after: afterReconcile.selectedRunId },
  );
  check(
    "核对也不重放执行：模型请求计数未增",
    mock.served() === servedStart + 2,
    { served: mock.served(), servedStart },
  );
  const opened = await evB(
    `(() => { const b = Array.from(document.querySelectorAll('#operations-panel button'))
        .find(x => ((x.textContent||'').trim()) === '打开记录');
      if (!b) return 'missing'; b.click(); return 'clicked'; })()`,
  );
  await H.sleep(2000);
  const afterOpen = await view();
  check(
    "只有「打开记录」这一条用户明确动作会导航到该 runId",
    opened === "clicked" && afterOpen.selectedRunId === runId,
    { opened, want: runId, got: afterOpen.selectedRunId },
  );
  await H.shot(call, SHOT_DIR, "68-readonly-noslot.png").catch(() => {});

  // ---- 只读面合计：既有文件一字未改 ----
  const after = snapshotHashes(fx);
  const diff = hashDiff(snapshots.traces, after.traces);
  check(
    "只读入口 + 被动录制 + 核对：既有 run 文件逐字节不变（源/父/兄弟不被改写）",
    diff.changed.length === 0 && diff.removed.length === 0,
    diff,
  );
  return {
    id,
    runId,
    canary: canary.slice(0, 12),
    hits: { bodyHits, keyHits, stackHits },
    served: mock.served(),
    preview: dump.preview,
  };
}
async function proxyChat(content, timeoutMs = 40_000) {
  try {
    const r = await fetch(`http://127.0.0.1:${H.PROXY_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY_MARK}` },
      body: JSON.stringify({
        model: "mock-model",
        stream: false,
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, body: (await r.text()).slice(0, 120) };
  } catch (e) {
    return { status: 0, error: String(e).slice(0, 160) };
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const SCRIPTS = {
  "narrow-keyboard": { turns: [{ content: "窄窗那条" }], fallback: { content: "兜底" } },
  "zoom200-keyboard": { turns: [{ content: "200% 那条" }], fallback: { content: "兜底" } },
  "readonly-noslot": { turns: [{ content: "只读面那条" }], fallback: { content: "兜底" } },
};

async function main() {
  if (!H.existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
  const fx = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const page = await H.cdpConnect(H.CDP_PORT);
  if (!page?.webSocketDebuggerUrl) throw new Error("CDP 9612 上没有页面（dev 未起？）");
  call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  H.attachDialogHandler(call, pageDialogs);

  let ready = 0;
  for (let i = 0; i < 30 && ready === 0; i++) {
    await H.sleep(1000);
    ready = (await H.runs(call).catch(() => []))
      .length;
  }
  if (ready === 0) {
    // 200% 缩放把默认窗口压进窄档 ⇒ 运行列表收起，H.runs 读不到 ⇒ 先开导航开关再探一次
    await resizeOuter(1400, 1000).catch(() => {});
    const nav = await ensureNavOpen().catch(() => null);
    for (let i = 0; i < 20 && ready === 0; i++) {
      await H.sleep(1000);
      ready = (await H.runs(call).catch(() => [])).length;
    }
    dump.layout.push({ at: "readiness-fallback", nav, ready });
  }
  check("运行列表就绪（夹具在场）", ready > 0, ready);
  if (ready === 0) finish();

  const mock = await H.prepare(call, SCRIPTS[TAG]);
  let out = null;
  let failure = null;
  try {
    out =
      TAG === "narrow-keyboard"
        ? await tagNarrowKeyboard(fx)
        : TAG === "zoom200-keyboard"
          ? await tagZoom200Keyboard(fx)
          : await tagReadonlyNoslot(mock, fx);
  } catch (e) {
    failure = String(e?.stack ?? e);
    check("场景未抛异常", false, failure.slice(0, 400));
  }
  dump.result = out ?? null;
  dump.failure = failure;
  dump.pageDialogs = pageDialogs.slice(0, 10);
  if (failure !== null) writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), failure);
  // 收尾一律把窗口改回宽档（否则下一批被窄档布局坑）；应用可能已不在 ⇒ 有界 + 吞错
  await Promise.race([
    H.teardown(call, mock).catch(() => {}),
    H.sleep(20_000).then(() => {
      console.log("[收尾] teardown 20s 未回 ⇒ 跳过页内复位");
    }),
  ]);
  try {
    await mock.close().catch?.(() => {});
  } catch {
    /* 受控服务尽力关 */
  }
  finish();
}

main().catch((e) => {
  console.error("采集失败:", e);
  try {
    writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  } catch {
    /* 落盘失败也要非零退出 */
  }
  process.exit(1);
});
