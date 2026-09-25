/* eslint-disable */
/**
 * U3 任务 6.10：创建/设置/嵌套确认的 Tab/Shift+Tab/Esc、Monaco 内部弹层与 busy 关闭限制的实机验收。
 *
 * 验收（tasks 6.10）：创建设置和放弃确认不泄漏焦点 / Esc 只关闭最上层并恢复焦点 /
 * 创建忙碌期间不能通过焦点修复绕过关闭锁。对应 spec delta
 * 「保留模态框约束焦点并正确恢复」的三个场景与 design D7 层级纪律。
 *
 * 键盘/鼠标一律走 CDP `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`（trusted 输入，
 * 探针实证：Esc 能触发原生 dialog cancel、Tab 走浏览器焦点遍历、dialog:modal 选择器可用）；
 * 焦点判据 = 页内 `document.activeElement` 归属（inDialog / 具体按钮文案），逐步采集焦点序列落盘。
 *
 * 层级纪律（D7）：一次 Esc 只关最上层——嵌套放弃确认在场时创建对话框/底层编辑器必须仍在；
 * Monaco find 弹层先消费第一次 Esc（defaultPrevented/stopPropagation），第二次才收起编辑区；
 * busy（modalLocked）时 Esc 被 closeDisabled 吞掉、全部控件禁用（无可用操作按钮态）焦点仍不逃逸、
 * 受控服务只收到一次请求（不触发第二次提交）。
 *
 * 用法：node apps/desktop/scripts/u3-610-cdp.cjs --tag=<focus-create|focus-settings|
 *   nested-confirm|editor-confirm-esc|monaco-esc|busy-lock|fallback-focus>
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, shot } = require("./lib/u2-cdp-util.cjs");
const { startMockLlmServer } = require("./mock-llm-server.cjs");

const PORT = 9612;
const MOCK_PORT = 18799;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
const OUT_DIR = join(REPO, ".workbuddy", "u3", "u3-610");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-26-u3-610");
const MANIFEST = join(REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const OUT = join(OUT_DIR, "measurements.json");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "focus-create");

function fixture() {
  if (!existsSync(MANIFEST)) throw new Error(`缺 ${MANIFEST}——6.10 复用 6.1 的夹具`);
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
// CDP（有界求值 + 事件会话；意外原生 confirm 出现 = 记红）
// ---------------------------------------------------------------------------

const STORE_NEEDLE = ["/src/renderer/src/store.ts", "/src/store.ts"];
const MONACO_NEEDLE = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];

function makeEventSession(pageUrl) {
  const ws = new WebSocket(pageUrl);
  let id = 0;
  const pending = new Map();
  const handlers = [];
  ws.onmessage = (raw) => {
    const m = JSON.parse(raw.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
      return;
    }
    for (const h of handlers) if (h.method === m.method) h.fn(m.params);
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
      call.on = (method, fn) => handlers.push({ method, fn });
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
const apiCall = (call, path, payload) =>
  appImport(
    call,
    STORE_NEEDLE,
    `const env = await window.api.${path}(${JSON.stringify(payload ?? null)}); return JSON.stringify(env);`,
  );
const createDraftOf = (call) =>
  storeQ(
    call,
    "const c = s.drafts.create; return JSON.stringify(c === null ? null : { systemPrompt: c.systemPrompt, userMessage: c.userMessage, revision: c.revision });",
  );

// ---- 真键盘 / 真鼠标 --------------------------------------------------------

async function key(call, k, code, vk, modifiers = 0) {
  await callBounded(call, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: k,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  });
  await callBounded(call, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: k,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  });
}
const pressEsc = (call) => key(call, "Escape", "Escape", 27);
const pressTab = (call, shift = false) => key(call, "Tab", "Tab", 9, shift ? 8 : 0);
const pressCtrlF = (call) => key(call, "f", "KeyF", 70, 2);

async function clickAt(call, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await callBounded(call, "Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
}
/** 真鼠标点击（会移动焦点，正是模态触发/恢复判据需要的）；找不到即抛错 */
async function realClick(call, findExpr, label) {
  const pos = await ev(
    call,
    `(() => { const b = (${findExpr});
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`,
  );
  if (pos === null) throw new Error(`找不到元素（真鼠标）：${label ?? findExpr.slice(0, 70)}`);
  const p = JSON.parse(pos);
  await clickAt(call, p.x, p.y);
  await sleep(450);
  return p;
}
const btnByLabel = (label) =>
  `Array.from(document.querySelectorAll('button')).find(x => ((x.textContent||'').trim()) === ${JSON.stringify(label)})`;
const btnByContains = (label) =>
  `Array.from(document.querySelectorAll('button')).find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(label)}))`;

// ---- 焦点 / 模态探针 --------------------------------------------------------

const focusInfo = (call) =>
  ev(
    call,
    `(() => { const a = document.activeElement;
      if (!a) return JSON.stringify({ tag: 'NONE', text: '', inDialog: false });
      const dlg = a.closest ? a.closest('dialog') : null;
      return JSON.stringify({
        tag: a.tagName,
        text: ((a.textContent || a.value || a.getAttribute('aria-label') || '')).trim().slice(0, 20),
        inDialog: dlg !== null,
        dlgLabel: dlg ? dlg.getAttribute('aria-label') : null,
        isFallback: a.hasAttribute ? a.hasAttribute('data-modal-focus-fallback') : false,
      }); })()`,
  ).then((s) => JSON.parse(s));
const modalLabel = (call) =>
  ev(call, `document.querySelector('dialog:modal')?.getAttribute('aria-label') ?? null`);
/** 多层模态时 `querySelector` 按 DOM 序返回**首个**（=底层）；顶层要取 :modal 列表末位 */
const topModalLabel = (call) =>
  ev(
    call,
    `(() => { const ds = document.querySelectorAll('dialog:modal');
      const last = ds[ds.length - 1];
      return last === undefined ? null : last.getAttribute('aria-label'); })()`,
  );
const openDialogs = (call) =>
  ev(
    call,
    `JSON.stringify(Array.from(document.querySelectorAll('dialog[open]')).map(d => d.getAttribute('aria-label')))`,
  ).then((s) => JSON.parse(s));
/** 顶层模态内「第一个可见可用控件」的同款判定（与 firstFocusableOf 一致的选择器） */
const firstFocusableText = (call) =>
  ev(
    call,
    `(() => { const dlg = document.querySelector('dialog:modal'); if (!dlg) return null;
      const sel = "button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
      for (const el of dlg.querySelectorAll(sel)) {
        if (el.disabled === true) continue;
        if (el.offsetParent === null) continue;
        return ((el.textContent || el.getAttribute('aria-label') || 'TEXTAREA/INPUT')).trim().slice(0, 20);
      }
      return 'NONE'; })()`,
  );

/** Tab/Shift+Tab 走 n 步，采集焦点链；返回链 + 是否全程在模态内 + 回绕证据（首元素重现） */
async function focusChain(call, n, shift = false) {
  const chain = [];
  for (let i = 0; i < n; i++) {
    await pressTab(call, shift);
    await sleep(140);
    chain.push(await focusInfo(call));
  }
  return chain;
}
function assertChainConfined(tag, chain, expectDialogLabel) {
  const out = chain.filter((f) => !f.inDialog || f.dlgLabel !== expectDialogLabel);
  check(
    `${tag} Tab/Shift+Tab ${chain.length} 步焦点全程留在「${expectDialogLabel}」模态内`,
    out.length === 0,
    JSON.stringify(out.slice(0, 4)),
  );
}

// ---------------------------------------------------------------------------
// 导航（沿用 6.8 已验证 helper；真鼠标优先，程序化点击仅用于列表/页签）
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
const gridPresent = (call, marker) =>
  ev(call, `document.querySelector('[data-draft-compare="${marker}"]') !== null`);

// ---------------------------------------------------------------------------
// T1 focus-create：创建对话框的焦点禁闭 / 初始焦点 / 背景 inert / Esc 恢复
// ---------------------------------------------------------------------------

async function tagFocusCreate(call) {
  const before = await focusInfo(call);
  await realClick(call, btnByLabel("新建运行"), "新建运行");
  await sleep(900);
  check(
    "创建对话框进入 top layer（dialog:modal=新建运行）",
    (await modalLabel(call)) === "新建运行",
    String(await modalLabel(call)),
  );
  const f0 = await focusInfo(call);
  const first = await firstFocusableText(call);
  check(
    "初始焦点在模态内且= 第一个可见可用控件（非背景、非隐藏元素）",
    f0.inDialog === true &&
      f0.dlgLabel === "新建运行" &&
      (f0.text === first ||
        (first === "TEXTAREA/INPUT" && (f0.tag === "TEXTAREA" || f0.tag === "INPUT"))),
    JSON.stringify({ f0, first }),
  );
  const fwd = await focusChain(call, 16);
  assertChainConfined("创建", fwd, "新建运行");
  const texts = fwd.map((f) => `${f.tag}:${f.text}`);
  check(
    "Tab 循环回绕（焦点链出现周期性重现，非单向逃逸）",
    new Set(texts).size < texts.length,
    JSON.stringify(texts),
  );
  const back = await focusChain(call, 8, true);
  assertChainConfined("创建", back, "新建运行");
  // 背景 inert：真鼠标点背景「录制接入」与运行行——模态不关、背景无响应
  await realClick(call, btnByLabel("录制接入"), "录制接入(背景)").catch(() => {});
  await sleep(600);
  check(
    "背景控件不可被鼠标操作（点「录制接入」无效，模态在场不变）",
    (await modalLabel(call)) === "新建运行" && (await openDialogs(call)).length === 1,
    JSON.stringify(await openDialogs(call)),
  );
  await pressEsc(call);
  await sleep(700);
  check("Esc 关闭创建对话框", (await modalLabel(call)) === null, String(await modalLabel(call)));
  const fb = await focusInfo(call);
  check(
    `关闭后焦点恢复触发入口「新建运行」（打开前在按钮 ${before.text || before.tag}）`,
    fb.inDialog === false && fb.text.includes("新建运行"),
    JSON.stringify(fb),
  );
  const pic = await shot(call, SHOT_DIR, "610-focus-create-closed.png").catch(() => null);
  return { f0, first, fwd, back, fb, shot: pic !== null };
}

// ---------------------------------------------------------------------------
// T2 focus-settings：设置对话框同套判据
// ---------------------------------------------------------------------------

async function tagFocusSettings(call) {
  await realClick(call, btnByLabel("运行配置"), "运行配置");
  await sleep(900);
  check(
    "设置对话框进入 top layer（dialog:modal=运行配置）",
    (await modalLabel(call)) === "运行配置",
    String(await modalLabel(call)),
  );
  const f0 = await focusInfo(call);
  check(
    "初始焦点在设置模态内",
    f0.inDialog === true && f0.dlgLabel === "运行配置",
    JSON.stringify(f0),
  );
  const fwd = await focusChain(call, 14);
  assertChainConfined("设置", fwd, "运行配置");
  const back = await focusChain(call, 7, true);
  assertChainConfined("设置", back, "运行配置");
  // 背景真鼠标无效
  await realClick(call, btnByLabel("新建运行"), "新建运行(背景)").catch(() => {});
  await sleep(500);
  check(
    "背景「新建运行」不可被鼠标操作（设置模态在场、无第二对话框）",
    (await modalLabel(call)) === "运行配置" && (await openDialogs(call)).length === 1,
    JSON.stringify(await openDialogs(call)),
  );
  await pressEsc(call);
  await sleep(700);
  check("Esc 关闭设置对话框", (await modalLabel(call)) === null, String(await modalLabel(call)));
  const fb = await focusInfo(call);
  check(
    "关闭后焦点恢复触发入口「运行配置」",
    fb.inDialog === false && (fb.text.includes("运行配置") || fb.isFallback === true),
    JSON.stringify(fb),
  );
  const pic = await shot(call, SHOT_DIR, "610-focus-settings-closed.png").catch(() => null);
  return { f0, fwd, back, fb, shot: pic !== null };
}

// ---------------------------------------------------------------------------
// T3 nested-confirm：创建对话框 + 嵌套放弃确认——一次 Esc 只关最上层
// ---------------------------------------------------------------------------

async function tagNestedConfirm(call) {
  await realClick(call, btnByLabel("新建运行"), "新建运行");
  await sleep(900);
  const mark = `嵌套Esc核对-${Math.random().toString(36).slice(2, 6)}`;
  await setReactInput(call, 'textarea[placeholder^="要交给模型的任务"]', mark);
  await sleep(600);
  const d1 = await createDraftOf(call);
  check(
    "创建草稿已入 store（userMessage=标记）",
    (d1?.userMessage ?? "") === mark,
    JSON.stringify(d1),
  );
  await realClick(call, btnByLabel("放弃填写内容"), "放弃填写内容");
  await sleep(900);
  const dialogs = await openDialogs(call);
  check(
    "嵌套两层在场：创建对话框 + 放弃确认（确认在顶）",
    dialogs.length === 2 &&
      dialogs[1] === "放弃创建草稿" &&
      (await topModalLabel(call)) === "放弃创建草稿",
    JSON.stringify({ dialogs, top: await topModalLabel(call) }),
  );
  const f0 = await focusInfo(call);
  check(
    "确认框初始焦点=「取消」（破坏性动作安全缺省）",
    f0.inDialog === true && f0.dlgLabel === "放弃创建草稿" && f0.text === "取消",
    JSON.stringify(f0),
  );
  await pressEsc(call);
  await sleep(800);
  const after = await openDialogs(call);
  check(
    "一次 Esc 只关最上层：确认关闭、创建对话框仍在（回归钉：旧双通道会一起关掉）",
    after.length === 1 && after[0] === "新建运行" && (await modalLabel(call)) === "新建运行",
    JSON.stringify(after),
  );
  const d2 = await createDraftOf(call);
  check("取消确认不丢草稿（store 逐字保留）", (d2?.userMessage ?? "") === mark, JSON.stringify(d2));
  const fb = await focusInfo(call);
  check(
    "确认关闭后焦点恢复其触发按钮「放弃填写内容」",
    fb.inDialog === true && fb.dlgLabel === "新建运行" && fb.text.includes("放弃填写内容"),
    JSON.stringify(fb),
  );
  await pressEsc(call);
  await sleep(800);
  check(
    "第二次 Esc 关闭底层创建对话框",
    (await modalLabel(call)) === null,
    String(await modalLabel(call)),
  );
  const f3 = await focusInfo(call);
  check(
    "底层关闭后焦点=GlobalBar 触发入口「新建运行」",
    f3.inDialog === false && f3.text.includes("新建运行"),
    JSON.stringify(f3),
  );
  const d3 = await createDraftOf(call);
  check(
    "关闭创建对话框不等于放弃（草稿仍在）",
    (d3?.userMessage ?? "") === mark,
    JSON.stringify(d3),
  );
  const pic = await shot(call, SHOT_DIR, "610-nested-confirm.png").catch(() => null);
  return { f0, fb, f3, shot: pic !== null };
}

// ---------------------------------------------------------------------------
// T4 editor-confirm-esc：编辑器 + 放弃确认——Esc 不连带收起底层编辑器
// ---------------------------------------------------------------------------

async function openToolResultEditor(call, fx, draftMark) {
  await selectRun(call, fx.normalRun);
  await clickTab(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await realClick(call, btnByContains("在此重跑（时间旅行）"), "在此重跑");
  await sleep(1200);
  await typeIntoEditableMonaco(call, draftMark);
  await sleep(400);
}

async function tagEditorConfirmEsc(call, fx) {
  const mark = `编辑器核对-${Math.random().toString(36).slice(2, 6)}`;
  await openToolResultEditor(call, fx, mark);
  check("工具结果编辑器已打开（核对网格在场）", (await gridPresent(call, "tool-result")) === true);
  const stored = async () => {
    const d = await appImport(
      call,
      STORE_NEEDLE,
      `const s = m.useAppStore.getState(); return JSON.stringify(s.callDraftOf({ runId: ${JSON.stringify(fx.normalRun)}, spanId: "s_03", field: "result" }));`,
    );
    return d?.text ?? "";
  };
  check("草稿已入 store（含标记）", (await stored()).includes(mark), (await stored()).slice(-40));
  await realClick(call, btnByLabel("放弃修改"), "放弃修改");
  await sleep(900);
  const dialogs = await openDialogs(call);
  check(
    "放弃确认在 top layer（标题=放弃工具结果草稿）",
    (await modalLabel(call)) === "放弃工具结果草稿" && dialogs.includes("放弃工具结果草稿"),
    JSON.stringify(dialogs),
  );
  const f0 = await focusInfo(call);
  check(
    "确认框初始焦点=「取消」",
    f0.dlgLabel === "放弃工具结果草稿" && f0.text === "取消",
    JSON.stringify(f0),
  );
  await pressEsc(call);
  await sleep(800);
  check(
    "一次 Esc 只关确认：编辑器网格仍在（不连带收起底层编辑区）",
    (await gridPresent(call, "tool-result")) === true && (await modalLabel(call)) === null,
    JSON.stringify({ grid: await gridPresent(call, "tool-result"), modal: await modalLabel(call) }),
  );
  check("取消确认后草稿逐字保留", (await stored()).includes(mark));
  const fb = await focusInfo(call);
  check(
    "确认关闭后焦点恢复触发按钮「放弃修改」",
    fb.inDialog === false && fb.text.includes("放弃修改"),
    JSON.stringify(fb),
  );
  // 收起 = 同动作保留草稿（Esc 第三次：编辑区收起——顺带验收 6.10 的编辑区 Esc）
  await pressEsc(call);
  await sleep(800);
  check(
    "无弹层/模态时第二次 Esc 收起编辑区（与「取消」同动作）",
    (await gridPresent(call, "tool-result")) === false,
    String(await gridPresent(call, "tool-result")),
  );
  check("收起不等于放弃：store 草稿仍在", (await stored()).includes(mark));
  const pic = await shot(call, SHOT_DIR, "610-editor-confirm-esc.png").catch(() => null);
  return { f0, fb, shot: pic !== null };
}

// ---------------------------------------------------------------------------
// T5 monaco-esc：Monaco find 弹层优先消费第一次 Esc
// ---------------------------------------------------------------------------

async function tagMonacoEsc(call, fx) {
  const mark = `弹层优先-${Math.random().toString(36).slice(2, 6)}`;
  await openToolResultEditor(call, fx, mark);
  check("编辑器打开", (await gridPresent(call, "tool-result")) === true);
  // 聚焦草稿侧 monaco（可编辑、宽 >200 的那个）
  const f = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const eds = monaco.editor.getEditors().filter((e) => {
       const n = e.getDomNode();
       return n !== null && n.offsetParent !== null && n.getBoundingClientRect().width > 200 &&
         !e.getOption(monaco.editor.EditorOption.readOnly);
     });
     if (eds.length === 0) return JSON.stringify({ ok: false });
     eds[0].focus();
     return JSON.stringify({ ok: true });`,
  );
  if (f.ok !== true) throw new Error("无法聚焦可编辑 monaco");
  await sleep(400);
  await pressCtrlF(call);
  await sleep(900);
  const findState = await ev(
    call,
    `(() => { const w = document.querySelector('.find-widget');
      return w === null ? 'none' : (w.classList.contains('visible') ? 'visible' : 'hidden'); })()`,
  );
  check("真 Ctrl+F 打开 Monaco find 弹层", findState === "visible", String(findState));
  await pressEsc(call);
  await sleep(700);
  const findAfter = await ev(
    call,
    `(() => { const w = document.querySelector('.find-widget');
      return w === null ? 'none' : (w.classList.contains('visible') ? 'visible' : 'hidden'); })()`,
  );
  check(
    "第一次 Esc 只被弹层消费：find 关闭、编辑区仍在",
    findAfter !== "visible" && (await gridPresent(call, "tool-result")) === true,
    JSON.stringify({ findAfter, grid: await gridPresent(call, "tool-result") }),
  );
  const d = await appImport(
    call,
    STORE_NEEDLE,
    `const s = m.useAppStore.getState(); return JSON.stringify(s.callDraftOf({ runId: ${JSON.stringify(fx.normalRun)}, spanId: "s_03", field: "result" }));`,
  );
  check(
    "弹层消费不伤草稿：store 文本仍含标记",
    (d?.text ?? "").includes(mark),
    String(d?.text ?? "").slice(-40),
  );
  await pressEsc(call);
  await sleep(800);
  check(
    "第二次 Esc（无弹层）收起编辑区",
    (await gridPresent(call, "tool-result")) === false,
    String(await gridPresent(call, "tool-result")),
  );
  const d2 = await appImport(
    call,
    STORE_NEEDLE,
    `const s = m.useAppStore.getState(); return JSON.stringify(s.callDraftOf({ runId: ${JSON.stringify(fx.normalRun)}, spanId: "s_03", field: "result" }));`,
  );
  check("收起后草稿仍保留（Esc≠放弃）", (d2?.text ?? "").includes(mark));
  const pic = await shot(call, SHOT_DIR, "610-monaco-esc.png").catch(() => null);
  return { findState, findAfter, shot: pic !== null };
}

// ---------------------------------------------------------------------------
// T6 busy-lock：创建执行中——Esc 吞、控件全禁用、焦点不逃逸、零第二次提交
// ---------------------------------------------------------------------------

async function tagBusyLock(call) {
  const mock = await startMockLlmServer({
    port: MOCK_PORT,
    script: {
      turns: [{ content: "受控响应：忙碌核对轮。", delayMs: 6000 }],
      fallback: { content: "fallback" },
    },
  });
  try {
    await apiCall(call, "clearSettings", null);
    await apiCall(call, "saveSettings", {
      baseURL: MOCK_BASE,
      apiKey: "sk-u3610-busy",
      model: "mock-model",
    });
    await storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
    const mark = `忙碌锁定-${Math.random().toString(36).slice(2, 6)}`;
    await realClick(call, btnByLabel("新建运行"), "新建运行");
    await sleep(900);
    await setReactInput(call, 'textarea[placeholder^="要交给模型的任务"]', mark);
    await sleep(500);
    await realClick(call, btnByLabel("创建"), "创建");
    await sleep(1200);
    const st = await storeQ(
      call,
      `return JSON.stringify({ creating: s.creatingRun, modal: document.querySelector('dialog:modal')?.getAttribute('aria-label') ?? null });`,
    );
    check(
      "提交进入执行中（creatingRun=in_progress 且对话框在场）",
      st.creating === "in_progress" && st.modal === "新建运行",
      JSON.stringify(st),
    );
    const btnStates = await ev(
      call,
      `(() => { const dlg = document.querySelector('dialog:modal'); if (!dlg) return null;
        const pick = (t) => Array.from(dlg.querySelectorAll('button')).find(b => ((b.textContent||'').trim()) === t);
        const x = dlg.querySelector('button[aria-label="关闭"]');
        return JSON.stringify({
          submit: (pick('创建中…') ?? pick('创建'))?.disabled ?? null,
          cancel: pick('取消')?.disabled ?? null,
          discard: pick('放弃填写内容')?.disabled ?? null,
          closeX: x?.disabled ?? null,
          busyBanner: ((dlg.textContent||'').includes('执行中')),
        }); })()`,
    ).then((s) => (s === null ? null : JSON.parse(s)));
    check(
      "忙碌期全部关闭/放弃入口禁用（✕/取消/放弃填写内容/提交）且「执行中」横幅在场",
      btnStates !== null &&
        btnStates.submit === true &&
        btnStates.cancel === true &&
        btnStates.discard === true &&
        btnStates.closeX === true &&
        btnStates.busyBanner === true,
      JSON.stringify(btnStates),
    );
    await pressEsc(call);
    await pressEsc(call);
    await sleep(600);
    check(
      "busy 期连按两次 Esc 被吞：对话框仍在（焦点修复不绕关闭锁）",
      (await modalLabel(call)) === "新建运行",
      String(await modalLabel(call)),
    );
    const noFocusable = await firstFocusableText(call);
    const chain = await focusChain(call, 8);
    check(
      `无可用操作按钮态：模态内首个可见可用控件为空（${String(noFocusable)}）且 Tab 8 步焦点不逃逸到背景`,
      (noFocusable === "NONE" || noFocusable === null) &&
        chain.every((x) => x.inDialog === true || x.tag === "BODY" || x.tag === "DIALOG"),
      JSON.stringify({
        noFocusable,
        out: chain.filter((x) => !x.inDialog && x.tag !== "BODY" && x.tag !== "DIALOG").slice(0, 3),
      }),
    );
    check("忙碌期真鼠标点背景无效（模态在场）", (await modalLabel(call)) === "新建运行");
    const taRaw = await ev(
      call,
      `(() => { const t = document.querySelector('textarea[placeholder^="要交给模型的任务"]'); return t === null ? null : JSON.stringify({ value: t.value, disabled: t.disabled }); })()`,
    );
    const ta = taRaw === null ? null : JSON.parse(taRaw);
    check(
      "忙碌期输入内容不丢（textarea 值=提交快照）且禁用编辑",
      ta !== null && ta.value === mark && ta.disabled === true,
      JSON.stringify(ta),
    );
    await sleep(6500);
    const done = await storeQ(
      call,
      `return JSON.stringify({ creating: s.creatingRun, modal: document.querySelector('dialog:modal')?.getAttribute('aria-label') ?? null });`,
    );
    check(
      "应答返回后对话框正常关闭（成功路径 onClose，非绕过）",
      done.creating !== "in_progress" && done.modal === null,
      JSON.stringify(done),
    );
    check(
      "受控服务恰好收到一次请求（无第二次提交）",
      mock.entries().length === 1,
      `entries=${mock.entries().length}`,
    );
    const f3 = await focusInfo(call);
    check(
      "关闭后焦点恢复触发入口「新建运行」",
      f3.inDialog === false && f3.text.includes("新建运行"),
      JSON.stringify(f3),
    );
    // 锁生命周期不外泄：重开对话框 Esc 恢复正常
    await realClick(call, btnByLabel("新建运行"), "新建运行");
    await sleep(900);
    await pressEsc(call);
    await sleep(700);
    check(
      "重开后 Esc 恢复正常（一次性锁不泄漏）",
      (await modalLabel(call)) === null,
      String(await modalLabel(call)),
    );
    const pic = await shot(call, SHOT_DIR, "610-busy-lock.png").catch(() => null);
    return { st, btnStates, chain, ta, done, shot: pic !== null };
  } finally {
    await apiCall(call, "clearSettings", null).catch(() => {});
    await storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });").catch(
      () => {},
    );
    await mock.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// T7 fallback-focus：触发节点卸载 ⇒ 回退 [data-modal-focus-fallback]
// ---------------------------------------------------------------------------

async function tagFallbackFocus(call) {
  // 1) 制造一份创建草稿（开→写→取消关闭）
  await realClick(call, btnByLabel("新建运行"), "新建运行");
  await sleep(900);
  const mark = `回退锚点-${Math.random().toString(36).slice(2, 6)}`;
  await setReactInput(call, 'textarea[placeholder^="要交给模型的任务"]', mark);
  await sleep(500);
  await realClick(call, btnByLabel("取消"), "取消");
  await sleep(700);
  check(
    "取消关闭后创建草稿保留（为定位入口备料）",
    ((await createDraftOf(call))?.userMessage ?? "") === mark,
  );
  // 2) 会话草稿下拉 → 定位（触发按钮随下拉卸载）
  await realClick(call, btnByContains("会话草稿"), "会话草稿");
  await sleep(700);
  await realClick(
    call,
    `(() => { const li = Array.from(document.querySelectorAll('li')).find(x => (x.textContent||'').includes(${JSON.stringify(mark)}));
    return li ? Array.from(li.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '定位') : null; })()`,
    "定位",
  );
  await sleep(1200);
  const modal = await modalLabel(call);
  check("定位打开创建对话框（草稿恢复进表单）", modal === "新建运行", String(modal));
  const taVal = await ev(
    call,
    `(() => { const t = document.querySelector('textarea[placeholder^="要交给模型的任务"]'); return t === null ? null : t.value; })()`,
  );
  check("定位后表单值=草稿（恢复不覆盖输入）", taVal === mark, String(taVal).slice(0, 40));
  const panelGone = await ev(
    call,
    `(() => { const x = document.querySelector('button[aria-label="关闭草稿列表"]'); return x === null; })()`,
  );
  const locateCount = await ev(
    call,
    `Array.from(document.querySelectorAll('button')).filter(x => (x.textContent||'').trim() === '定位').length`,
  );
  check(
    "触发「定位」的下拉面板已关闭（触发节点随之卸载）",
    panelGone === true,
    `panelGone=${panelGone} locateCount=${locateCount}`,
  );
  // 3) Esc 关闭 ⇒ 焦点不能落 body/隐藏元素，必须回退锚点
  await pressEsc(call);
  await sleep(800);
  check("Esc 关闭对话框", (await modalLabel(call)) === null, String(await modalLabel(call)));
  const f = await focusInfo(call);
  check(
    "触发点失效 ⇒ 焦点=回退锚点 [data-modal-focus-fallback]（运行配置），不落 body/隐藏元素",
    f.isFallback === true && f.tag === "BUTTON" && f.text.includes("运行配置"),
    JSON.stringify(f),
  );
  const vis = await ev(
    call,
    `(() => { const a = document.activeElement; if (!a || a === document.body) return false;
    const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0 && a.offsetParent !== null; })()`,
  );
  check("回退焦点元素真实可见（非隐藏）", vis === true, String(vis));
  const pic = await shot(call, SHOT_DIR, "610-fallback-focus.png").catch(() => null);
  return { f, shot: pic !== null };
}

const TAGS = {
  "focus-create": tagFocusCreate,
  "focus-settings": tagFocusSettings,
  "nested-confirm": tagNestedConfirm,
  "editor-confirm-esc": tagEditorConfirmEsc,
  "monaco-esc": tagMonacoEsc,
  "busy-lock": tagBusyLock,
  "fallback-focus": tagFallbackFocus,
};

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
  // 意外原生对话框（本任务里放弃确认必须是页面模态）⇒ 记红并拒绝
  const nativeDialogs = [];
  call.on("Page.javascriptDialogOpening", (p) => {
    nativeDialogs.push({ type: p.type, message: String(p.message ?? "").slice(0, 120) });
    call("Page.handleJavaScriptDialog", { accept: false, promptText: "" }).catch(() => {});
  });
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
  if (readyRuns === 0)
    throw new Error("运行列表未就绪——夹具未加载（若近期跑过 6.9，先 --reset-zoom）");

  let out = {};
  let failure = null;
  try {
    out = (await run(call, fx)) ?? {};
  } catch (e) {
    failure = String(e);
    check(`[${TAG}] 场景未抛异常`, false, failure);
  }
  check(
    "全程零意外原生对话框（放弃确认必须是页面模态而非 window.confirm）",
    nativeDialogs.length === 0,
    JSON.stringify(nativeDialogs.slice(0, 2)),
  );
  out.nativeDialogs = nativeDialogs;
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
