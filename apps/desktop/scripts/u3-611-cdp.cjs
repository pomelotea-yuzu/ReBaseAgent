/* eslint-disable */
/**
 * U3 任务 6.11：零调用 / 逐文件哈希 / 无草稿持久化 + 重载与重启不恢复草稿；回归 U1/U2 阅读与文件状态。
 *
 * 验收（tasks 6.11）：草稿不会跨 renderer 会话持久恢复 / 草稿操作零执行且已有文件不变 /
 * 原有执行入口和文件阅读继续可用。对应 spec delta
 * Requirement「草稿交互保持既有执行和数据边界」两场景 + design「无磁盘迁移」纪律。
 *
 * tag（run-all 固定顺序，每 tag 全新 dev ⇒ restart-pre/post 天然跨进程）：
 *   zero-exec      五通道草稿全操作（输入/导航恢复/复制/收起/放弃-取消/列表定位）+ 取消退出
 *                  （真哨兵 app.quit → 原生确认「返回」）⇒ 受控服务零请求、
 *                  traces/blobs/source/settings 逐文件 SHA-256 diff=[]、localStorage 零标记
 *   reload         真 Page.reload（renderer 会话结束）⇒ store 三区全空、徽标干净、
 *                  重开编辑器显示原值（草稿不复活）、磁盘全树零标记
 *   restart-pre    放草稿 + 记标记/计数，落 handoff.json（run-all 重启 dev = 真进程重启）
 *   restart-post   新进程：三区全空 + 磁盘零标记 + 重开编辑器原值 + traces 计数一致
 *   regression     U1/U2：页签/选中 span/文件页 path 会话内恢复；result/prompt/messages/A-B/
 *                  隔离续跑入口可达；文件内容真 IPC 可读
 *
 * ⚠️ reload 后 CDP 真鼠标失效（6.10 实测）⇒ reload 后的 UI 驱动一律程序化 click；
 * ⚠️ 本脚本不 spawn、不改窗；重启由 run-all 承担。
 *
 * 用法：node apps/desktop/scripts/u3-611-cdp.cjs --tag=<zero-exec|reload|restart-pre|restart-post|regression>
 */
"use strict";

const { createHash } = require("node:crypto");
const {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} = require("node:fs");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, shot } = require("./lib/u2-cdp-util.cjs");
const { startMockLlmServer } = require("./mock-llm-server.cjs");

const PORT = 9612;
const MOCK_PORT = 18799;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
const OUT_DIR = join(REPO, ".workbuddy", "u3", "u3-611");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-26-u3-611");
const MANIFEST = join(REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const HANDOFF = join(OUT_DIR, "restart-handoff.json");
const OUT = join(OUT_DIR, "measurements.json");
const PS1 = join(REPO, "apps", "desktop", "scripts", "lib", "u3-64-winops.ps1");
const QUIT_FLAG = join(OUT_DIR, "quit.flag");
const DATA = join(REPO, ".rebaseagent");
const TRACES = join(DATA, "traces");
const SOURCE = join(REPO, ".workbuddy", "u3", "u3-63", "source");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "zero-exec");

function fixture() {
  if (!existsSync(MANIFEST)) throw new Error(`缺 ${MANIFEST}——6.11 复用 6.1 的夹具`);
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
// 逐文件哈希冻结面（同 U2 5.5 口径）+ 全树标记扫描
// ---------------------------------------------------------------------------

function hashTree(root, rel = "") {
  const abs = join(root, rel);
  if (!existsSync(abs)) return {};
  const out = {};
  for (const name of readdirSync(abs)) {
    const childRel = rel === "" ? name : `${rel}/${name}`;
    const childAbs = join(root, childRel);
    if (statSync(childAbs).isDirectory()) Object.assign(out, hashTree(root, childRel));
    else out[childRel] = createHash("sha256").update(readFileSync(childAbs)).digest("hex");
  }
  return out;
}
/** 冻结面：live traces + 附件 blobs + 源目录 + settings.json（草稿一切操作都不该碰它们） */
function freezeSurface() {
  return {
    traces: hashTree(TRACES),
    blobs: hashTree(join(DATA, "workspace-blobs")),
    source: hashTree(SOURCE),
    settings: existsSync(join(DATA, "settings.json"))
      ? { "settings.json": readFileSync(join(DATA, "settings.json")).toString("base64") }
      : {},
  };
}
function diffSurface(a, b) {
  const out = [];
  for (const face of ["traces", "blobs", "source", "settings"]) {
    const keys = new Set([...Object.keys(a[face] ?? {}), ...Object.keys(b[face] ?? {})]);
    for (const k of keys) {
      if (a[face][k] !== b[face][k]) out.push(`${face}:${k}`);
    }
  }
  return out;
}
const traceCount = () =>
  existsSync(TRACES) ? readdirSync(TRACES).filter((n) => n.endsWith(".jsonl")).length : 0;

/** 全 .rebaseagent 树逐文件 utf8 读，命中任一标记即返回命中项（草稿内容永不落盘的硬证） */
function scanMarkers(marks) {
  const hits = [];
  const walk = (dir, rel) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else {
        const txt = readFileSync(abs).toString("utf8");
        for (const m of marks) if (txt.includes(m)) hits.push(`${r}~${m.slice(0, 12)}`);
      }
    }
  };
  walk(DATA, "");
  return hits;
}

// ---------------------------------------------------------------------------
// 进程通道（winops：dialog 应答——取消退出用）
// ---------------------------------------------------------------------------

let MAIN_PID = 0;
let PS_SEQ = 0;
function spawnCollect(exe, args, outFile) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let so = "";
    let err = "";
    child.stdout.on("data", (d) => {
      so += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
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
  const o = {};
  for (const l of lines) {
    const i = l.indexOf("=");
    if (i < 0) continue;
    const k = l.slice(0, i);
    const v = l.slice(i + 1);
    if (o[k] === undefined) o[k] = v;
    else o[k] = Array.isArray(o[k]) ? [...o[k], v] : [o[k], v];
  }
  return o;
}

// ---------------------------------------------------------------------------
// CDP（有界求值——同 6.6+ 纪律）
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
  // IIFE 括号错位会静默求值出函数对象 ⇒ `=== true` 恒假（6.11 实测的自伤坑）
  if (r?.result?.type === "function")
    throw new Error(`ev 求值出函数（表达式括号错位？）: ${expression.slice(0, 90)}`);
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
const draftSnapshot = (call) =>
  storeQ(
    call,
    "return JSON.stringify({ calls: s.drafts.calls, modelAb: s.drafts.modelAb, create: s.drafts.create === null ? null : { userMessage: s.drafts.create.userMessage, systemPrompt: s.drafts.create.systemPrompt, revision: s.drafts.create.revision } });",
  );
const apiCall = (call, path, payload) =>
  appImport(
    call,
    STORE_NEEDLE,
    `const env = await window.api.${path}(${JSON.stringify(payload ?? null)}); return JSON.stringify(env);`,
  );

// ---------------------------------------------------------------------------
// UI 驱动（真鼠标优先；reload 后一律程序化）
// ---------------------------------------------------------------------------

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
async function realClick(call, findExpr, label) {
  // scrollIntoView 可能是平滑滚动 ⇒ 先滚、等稳定，再取 rect，并用 elementFromPoint
  // 校验命中（6.11 实测：滚动未完成就取坐标会让点击落在运行列表上）
  const scrolled = await ev(
    call,
    `(() => { const b = (${findExpr});
      if (!b) return null;
      b.scrollIntoView({ block: 'center', behavior: 'instant' });
      return true; })()`,
  );
  if (scrolled === null) throw new Error(`找不到元素（真鼠标）：${label ?? findExpr.slice(0, 60)}`);
  await sleep(350);
  let p = null;
  for (let att = 0; att < 3; att++) {
    p = JSON.parse(
      await ev(
        call,
        `(() => { const b = (${findExpr});
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`,
      ),
    );
    if (p === null) throw new Error(`元素消失（真鼠标）：${label ?? ""}`);
    const hit = await ev(
      call,
      `(() => { const b = (${findExpr}); const t = document.elementFromPoint(${p.x}, ${p.y});
        return b === t || (b.contains !== undefined && b.contains(t)); })()`,
    );
    if (hit === true) {
      await clickAt(call, p.x, p.y);
      await sleep(450);
      return;
    }
    await sleep(400);
  }
  // 命中校验始终不过 ⇒ 抛错而不是盲点（盲点会误开「运行配置」等无辜控件——6.11 实机教训）
  const blocker = await ev(
    call,
    `(() => { const t = document.elementFromPoint(${p.x}, ${p.y});
      const d = t && t.closest ? t.closest("dialog") : null;
      return JSON.stringify({ tag: t?.tagName, txt: (t?.textContent || "").trim().slice(0, 24), inDialog: d ? d.getAttribute("aria-label") : null }); })()`,
  );
  throw new Error(`真鼠标命中失败：${label ?? findExpr.slice(0, 50)} 挡点者=${blocker}`);
}
const btnByLabel = (label) =>
  `Array.from(document.querySelectorAll('button')).find(x => ((x.textContent||'').trim()) === ${JSON.stringify(label)})`;
const btnByContains = (label) =>
  `Array.from(document.querySelectorAll('button')).find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(label)}))`;
/**
 * 编辑器/对话框内的「取消」按钮专用：全局 btnByLabel('取消') 会先命中
 * SettingsDialog 的 ✕ 关闭钮（textContent.trim()==='✕'==='取消' 字符巧合）⇒
 * 误开设置模态、其后所有真鼠标点击被 ::backdrop 吞掉（6.11 实机坐实）。
 * 限定：可见 + 在可滚动正文内（模态 backdrop 挡在外面）+ 排除 ✕。
 */
const cancelBtnInBody = `Array.from(document.querySelectorAll('button')).filter(x =>
  ((x.textContent||'').trim()) === '取消' && x.offsetParent !== null && !x.closest('dialog'))[0]`;
/** 当前最顶层模态内的「取消」（确认框/创建/设置对话框共用） */
const cancelInModal = `(() => { const ds = document.querySelectorAll('dialog:modal');
  const d = ds[ds.length - 1];
  return d ? Array.from(d.querySelectorAll('button')).find(x => ((x.textContent||'').trim()) === '取消') : null; })()`;
/** 程序化点击（reload 后唯一可靠通道） */
async function progClick(call, findExpr, label, wait = 700) {
  const ok = await ev(
    call,
    `(() => { const b = (${findExpr}); if (!b) return false; b.scrollIntoView({block:'center'}); b.click(); return true; })()`,
  );
  if (ok !== true) throw new Error(`找不到元素（程序化）：${label ?? findExpr.slice(0, 60)}`);
  await sleep(wait);
}

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
  // ⚠️ 必须排除 header 区按钮：GlobalBar「运行配置」的 title 含「LLM」
  // （"配置 LLM 接入…"），6.8/6.10 的旧 clickSpan 会先点它 ⇒ 设置模态被静默打开
  //（6.11 插桩坐实；对 6.8 的网格几何结论无影响——top layer 不改变底层布局）。
  const clickNth = (n) => `(() => {
    const rows = Array.from(document.querySelectorAll('button'))
      .filter(b => ((b.title||'').includes('${titleFragment}')) && b.closest('header') === null);
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
/** TEMP 诊断：当前所有 dialog 状态 */
const dlgState = async (call) =>
  JSON.parse(
    await ev(
      call,
      `JSON.stringify(Array.from(document.querySelectorAll('dialog')).map(d => d.getAttribute('aria-label') + (d.matches(':modal') ? ':MODAL' : d.open ? ':open' : ':closed')))`,
    ),
  );
async function step(call, name) {
  const s = await dlgState(call);
  console.log(`  [step] ${name} dialogs=${JSON.stringify(s)}`);
  if (s.some((x) => x.startsWith("运行配置"))) {
    throw new Error(`意外：运行配置模态在场 @ ${name} dialogs=${JSON.stringify(s)}`);
  }
}
/** 真鼠标点编辑器入口 + 校验对应核对网格在场，未命中重试（重渲染坐标漂移防御） */
async function openEditorEntry(call, findExpr, marker, label) {
  for (let i = 0; i < 3; i++) {
    await realClick(call, findExpr, label);
    await sleep(1300);
    if ((await gridPresent(call, marker)) === true) return;
  }
  const dump = await ev(
    call,
    `JSON.stringify({
      sel: (() => { try { return null; } catch { return null; } })(),
      btns: Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null)
        .map(b => (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 22))
        .filter(t => t !== '' && t !== '复制 ID' && !t.startsWith('已结束') && !t.startsWith('出错终止'))
        .slice(0, 40),
      grids: Array.from(document.querySelectorAll('[data-draft-compare]')).map(x => x.getAttribute('data-draft-compare')),
    })`,
  );
  throw new Error(
    `入口「${label}」点击后核对网格 ${marker} 未在场（重试 3 次）现场=${String(dump).slice(0, 600)}`,
  );
}
const resultDraftText = (call, runId) =>
  storeQ(
    call,
    `const d = s.callDraftOf({ runId: ${JSON.stringify(runId)}, spanId: "s_03", field: "result" }); return JSON.stringify(d === undefined ? null : { text: d.text, revision: d.revision });`,
  );
const webStorageScan = (call, marks) =>
  ev(
    call,
    `(() => { let all = '';
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) { const k = store.key(i); all += k + '=' + store.getItem(k) + '\\n'; }
      }
      return JSON.stringify(${JSON.stringify(marks)}.filter((m) => all.includes(m))); })()`,
  ).then((s) => JSON.parse(s));

// ---------------------------------------------------------------------------
// 草稿放置（三通道复用；prog=true 时全走程序化点击）
// ---------------------------------------------------------------------------

async function putResultDraft(call, fx, mark, prog) {
  await selectRun(call, fx.normalRun);
  await clickTab(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  if (prog) {
    await progClick(call, btnByContains("在此重跑（时间旅行）"), "在此重跑", 1300);
  } else {
    await openEditorEntry(call, btnByContains("在此重跑（时间旅行）"), "tool-result", "在此重跑");
  }
  if (mark !== "") await typeIntoEditableMonaco(call, mark);
}
async function putAbDraft(call, fx, mark, prog) {
  await selectRun(call, fx.normalRun);
  await clickTab(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  if (prog) {
    await progClick(call, btnByContains("模型 A/B"), "模型 A/B", 1300);
  } else {
    await openEditorEntry(call, btnByContains("模型 A/B"), "model-ab", "模型 A/B");
  }
  await setReactInput(call, 'input[placeholder^="采样参数 JSON"]', mark);
}
async function putCreateDraft(call, mark, prog) {
  const click = prog ? progClick : realClick;
  await click(call, btnByLabel("新建运行"), "新建运行");
  await sleep(900);
  await setReactInput(call, 'textarea[placeholder^="要交给模型的任务"]', mark);
  await sleep(500);
  await click(call, cancelInModal, "取消关闭创建");
}

// ---------------------------------------------------------------------------
// T1 zero-exec：全通道草稿操作 + 取消退出 ⇒ 零执行、零写入
// ---------------------------------------------------------------------------

async function tagZeroExec(call, fx) {
  const mock = await startMockLlmServer({
    port: MOCK_PORT,
    script: { turns: [{ content: "不应被消费" }], fallback: { content: "不应被消费" } },
  });
  try {
    await apiCall(call, "clearSettings", null);
    await apiCall(call, "saveSettings", {
      baseURL: MOCK_BASE,
      apiKey: "sk-u3611",
      model: "mock-model",
    });
    await storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
    const before = freezeSurface();
    const n0 = traceCount();
    const stamp = Date.now().toString(36);
    const marks = {
      result: `零执行-result-${stamp}`,
      promptA: `零执行-promptA-${stamp}`,
      promptB: `零执行-promptB-${stamp}`,
      messages: `{"坏JSON":[${stamp}`,
      ab: `{"temperature":0.5,"tag":"零执行-ab-${stamp}"}`,
      create: `零执行-创建-${stamp}`,
    };
    // ① result：输入 + 导航往返恢复 + 放弃-取消 + 收起
    await putResultDraft(call, fx, marks.result, false);
    await step(call, "putResultDraft");
    await clickTab(call, "概览");
    await clickTab(call, "步骤");
    await clickSpan(call, "read_file", "s_03");
    await step(call, "roundtrip");
    check(
      "result：页签往返后草稿仍在 store（导航恢复不丢输入）",
      (await resultDraftText(call, fx.normalRun))?.text?.includes(marks.result) === true,
    );
    // 编辑器 open 是组件局部态：往返后重开，输入必须原样恢复（R 场景主判据在 6.1，这里为放弃入口铺路）
    await openEditorEntry(
      call,
      btnByContains("在此重跑（时间旅行）"),
      "tool-result",
      "重开 result",
    );
    await step(call, "reopen");
    await realClick(call, btnByLabel("放弃修改"), "放弃修改");
    await sleep(900);
    await step(call, "放弃修改");
    check(
      "result：放弃确认=页面模态（放弃工具结果草稿）",
      (await ev(
        call,
        `document.querySelector('dialog:modal')?.getAttribute('aria-label') ?? null`,
      )) === "放弃工具结果草稿",
    );
    await realClick(call, cancelInModal, "确认取消");
    await step(call, "确认取消");
    check(
      "result：取消确认草稿逐字保留",
      (await resultDraftText(call, fx.normalRun))?.text?.includes(marks.result) === true,
    );
    await realClick(call, cancelBtnInBody, "result 取消收起");
    await step(call, "result 取消收起");
    // ② prompt 两字段
    await clickSpan(call, "LLM", "s_02");
    await step(call, "clickSpan s_02");
    await openEditorEntry(call, btnByContains("编辑 system prompt 重跑"), "prompt", "prompt 入口");
    await typeIntoEditableMonaco(call, marks.promptA);
    await realClick(call, btnByContains("首条 user message"), "切 user 字段");
    await sleep(1000);
    await typeIntoEditableMonaco(call, marks.promptB);
    await realClick(call, cancelBtnInBody, "prompt 取消收起");
    // ③ messages 非法 JSON 仍可暂存
    await selectRun(call, fx.proxyRun);
    await clickTab(call, "步骤");
    await clickSpan(call, "LLM", "s_02");
    await openEditorEntry(call, btnByContains("编辑 messages 重发"), "messages", "messages 入口");
    await typeIntoEditableMonaco(call, marks.messages);
    await realClick(call, cancelBtnInBody, "messages 取消收起");
    // ④ A/B：改参 + 放弃整批-取消
    await selectRun(call, fx.normalRun);
    await clickTab(call, "步骤");
    await clickSpan(call, "LLM", "s_02");
    await putAbDraft(call, fx, marks.ab, false);
    await realClick(call, btnByLabel("放弃整批"), "放弃整批");
    await sleep(900);
    await realClick(call, cancelInModal, "整批确认取消");
    check(
      "A/B：取消确认后批次草稿保留",
      JSON.stringify((await draftSnapshot(call)).modelAb ?? "").includes(stamp),
    );
    await realClick(call, btnByLabel("收起"), "A/B 收起");
    // ⑤ 创建：输入 + 关闭重开恢复 + 列表复制 + 定位
    await putCreateDraft(call, marks.create, false);
    await realClick(call, btnByLabel("新建运行"), "重开创建");
    await sleep(900);
    const taVal = await ev(
      call,
      `(() => { const t = document.querySelector('textarea[placeholder^="要交给模型的任务"]'); return t === null ? null : t.value; })()`,
    );
    check("创建：关闭重开逐字恢复", taVal === marks.create, String(taVal).slice(0, 40));
    await realClick(call, cancelInModal, "关闭创建");
    await realClick(call, btnByContains("会话草稿"), "打开草稿列表");
    await sleep(700);
    await realClick(
      call,
      `(() => { const li = Array.from(document.querySelectorAll('li')).find(x => (x.textContent||'').includes(${JSON.stringify(marks.create)}));
        return li ? Array.from(li.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '复制') : null; })()`,
      "列表复制",
    );
    await realClick(
      call,
      `(() => { const li = Array.from(document.querySelectorAll('li')).find(x => (x.textContent||'').includes(${JSON.stringify(marks.result)}));
        return li ? Array.from(li.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '定位') : null; })()`,
      "列表定位(result)",
    );
    await sleep(1200);
    check(
      "定位：result 编辑器自动打开且草稿完整",
      (await gridPresent(call, "tool-result")) === true &&
        (await resultDraftText(call, fx.normalRun))?.text?.includes(marks.result) === true,
    );
    await realClick(call, cancelBtnInBody, "定位后收起");
    // ⑥ 取消退出（真 app.quit → 原生确认「返回」）
    const info = parseLines((await winops("resolve")).lines);
    MAIN_PID = Number(info["main-pid"]) || 0;
    check("已认定 dev 主进程 PID", MAIN_PID > 0, JSON.stringify(info));
    writeFileSync(QUIT_FLAG, "quit");
    let dialog = null;
    for (let i = 0; i < 16; i++) {
      await sleep(700);
      dialog = parseLines((await winops("dialog-text")).lines);
      if (String(dialog["dialog-name"] ?? "") !== "") break;
    }
    const btnTexts = Array.isArray(dialog["button[0]"]) ? [] : [];
    void btnTexts;
    const buttonLine = (k) => String(dialog[k] ?? "");
    let backIdx = -1;
    for (let i = 0; i < 6; i++) {
      const t = buttonLine(`button[${i}]`);
      if (t.includes("返回")) backIdx = i;
    }
    check(
      "dirty 草稿 + app.quit ⇒ 原生确认在场且含「返回」",
      backIdx >= 0 && String(dialog["dialog-name"] ?? "").length > 0,
      JSON.stringify({
        name: dialog["dialog-name"],
        b0: buttonLine("button[0]"),
        b1: buttonLine("button[1]"),
      }),
    );
    const clicked = parseLines((await winops("dialog-click", ["-Index", String(backIdx)])).lines);
    check(
      "「返回」已应答",
      String(clicked.RESULT ?? "").startsWith("clicked"),
      JSON.stringify(clicked),
    );
    for (let i = 0; i < 10; i++) {
      const c = parseLines((await winops("dialog-count")).lines);
      if (Number(c.dialogs ?? 1) === 0) break;
      await sleep(600);
    }
    const alive = parseLines((await winops("alive")).lines);
    check(
      "取消退出后应用存活（窗口在场）",
      String(alive.window ?? "").startsWith("hwnd="),
      JSON.stringify(alive),
    );
    const snap = await draftSnapshot(call);
    check(
      "取消退出后全部草稿原样保留（三区都在）",
      JSON.stringify(snap.calls).includes(marks.result) &&
        JSON.stringify(snap.modelAb).includes(stamp) &&
        snap.create?.userMessage === marks.create,
      JSON.stringify(snap).slice(0, 120),
    );
    // ⑦ 零执行 + 零写入判据
    check(
      "受控服务零请求（草稿操作不调模型）",
      mock.entries().length === 0,
      `entries=${mock.entries().length}`,
    );
    const after = freezeSurface();
    const diff = diffSurface(before, after);
    check(
      "冻结面逐文件 SHA-256 前后 diff=[]（traces/blobs/source/settings）",
      diff.length === 0,
      JSON.stringify(diff.slice(0, 6)),
    );
    check("traces 文件数不变", traceCount() === n0, `${n0}→${traceCount()}`);
    const lsHits = await webStorageScan(call, Object.values(marks));
    check("localStorage+sessionStorage 零草稿标记", lsHits.length === 0, JSON.stringify(lsHits));
    const pic = await shot(call, SHOT_DIR, "611-zero-exec.png").catch(() => null);
    return { marks, entries: mock.entries().length, diff, n0, lsHits, shot: pic !== null };
  } finally {
    await apiCall(call, "clearSettings", null).catch(() => {});
    await mock.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// T2 reload：真重载 ⇒ 草稿不跨 renderer 会话恢复、磁盘零痕迹
// ---------------------------------------------------------------------------

async function tagReload(call, fx) {
  const stamp = Date.now().toString(36);
  const marks = {
    result: `重载不恢复-result-${stamp}`,
    ab: `{"temperature":0.9,"tag":"重载不恢复-ab-${stamp}"}`,
    create: `重载不恢复-创建-${stamp}`,
  };
  const n0 = traceCount();
  await putResultDraft(call, fx, marks.result, false);
  await putAbDraft(call, fx, marks.ab, false);
  await putCreateDraft(call, marks.create, false);
  const pre = await draftSnapshot(call);
  check(
    "重载前三区草稿都在场（前提成立）",
    JSON.stringify(pre.calls).includes(marks.result) &&
      JSON.stringify(pre.modelAb).includes(stamp) &&
      pre.create?.userMessage === marks.create,
    JSON.stringify(pre).slice(0, 120),
  );
  await callBounded(call, "Page.reload", { ignoreCache: false });
  const RUNS_EXPR = `(() => Array.from(document.querySelectorAll('button'))
    .map(b => b.getAttribute('aria-label') || '')
    .filter(a => a.startsWith('复制完整运行 ID')).length)()`;
  let prev = -1;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(700);
    let n = 0;
    try {
      n = Number(await ev(call, RUNS_EXPR)) || 0;
    } catch {
      n = -1;
    }
    if (n > 0 && n === prev) {
      ready = true;
      break;
    }
    prev = n;
  }
  if (!ready) throw new Error("reload 后运行列表未就绪");
  const post = await draftSnapshot(call);
  check(
    "reload 后 store 三区全空（calls={}、modelAb={}、create=null）",
    Object.keys(post.calls ?? {}).length === 0 &&
      Object.keys(post.modelAb ?? {}).length === 0 &&
      post.create === null,
    JSON.stringify(post).slice(0, 160),
  );
  const badge = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').includes('会话草稿')); return b ? b.textContent.trim() : null; })()`,
  );
  check(
    "reload 后「会话草稿」徽标无 dirty 计数",
    badge !== null && !badge.includes("·"),
    String(badge),
  );
  // 重开 result 编辑器：显示原值（草稿没复活）
  await putResultDraft(call, fx, "", true);
  const modelVal = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const eds = monaco.editor.getEditors().filter((e) => e.getDomNode()?.offsetParent !== null &&
       !e.getOption(monaco.editor.EditorOption.readOnly));
     return JSON.stringify({ value: eds.length === 0 ? null : (eds[0].getModel().getValue() ?? '').slice(0, 200) });`,
  );
  check(
    "reload 后重开编辑器=原值（不含旧标记）",
    modelVal.value !== null && !String(modelVal.value).includes(marks.result),
    String(modelVal.value).slice(0, 60),
  );
  const d = await resultDraftText(call, fx.normalRun);
  check(
    "reload 后重开只登记基线条目（无旧文本）",
    d === null || !String(d.text).includes(marks.result),
    JSON.stringify(d).slice(0, 80),
  );
  const hits = scanMarkers([marks.result, marks.ab, marks.create]);
  check(
    ".rebaseagent 全树零草稿痕迹（traces/blobs/settings 全无标记）",
    hits.length === 0,
    JSON.stringify(hits.slice(0, 4)),
  );
  const lsHits = await webStorageScan(call, [marks.result, marks.ab, marks.create]);
  check("localStorage+sessionStorage 零草稿痕迹", lsHits.length === 0, JSON.stringify(lsHits));
  check("traces 文件数不变", traceCount() === n0, `${n0}→${traceCount()}`);
  const pic = await shot(call, SHOT_DIR, "611-reload.png").catch(() => null);
  return { marks, post, badge, hits, lsHits, shot: pic !== null };
}

// ---------------------------------------------------------------------------
// T3/T4 restart-pre / restart-post（run-all 每 tag 重启 dev = 真进程重启）
// ---------------------------------------------------------------------------

async function tagRestartPre(call, fx) {
  const stamp = Date.now().toString(36);
  const marks = {
    result: `重启不恢复-result-${stamp}`,
    ab: `{"temperature":0.3,"tag":"重启不恢复-ab-${stamp}"}`,
    create: `重启不恢复-创建-${stamp}`,
  };
  await putResultDraft(call, fx, marks.result, false);
  await putAbDraft(call, fx, marks.ab, false);
  await putCreateDraft(call, marks.create, false);
  const pre = await draftSnapshot(call);
  check(
    "重启前三区草稿在场",
    JSON.stringify(pre.calls).includes(marks.result) &&
      JSON.stringify(pre.modelAb).includes(stamp) &&
      pre.create?.userMessage === marks.create,
  );
  writeFileSync(
    HANDOFF,
    JSON.stringify(
      { stamp, marks, traceCountAt: traceCount(), at: new Date().toISOString() },
      null,
      2,
    ),
  );
  const pic = await shot(call, SHOT_DIR, "611-restart-pre.png").catch(() => null);
  return { marks, shot: pic !== null };
}

async function tagRestartPost(call, fx) {
  if (!existsSync(HANDOFF)) throw new Error("缺 restart-handoff.json——restart-pre 未跑？");
  const hand = JSON.parse(readFileSync(HANDOFF, "utf8"));
  const post = await draftSnapshot(call);
  check(
    "进程重启后 store 三区全空（草稿不跨进程恢复）",
    Object.keys(post.calls ?? {}).length === 0 &&
      Object.keys(post.modelAb ?? {}).length === 0 &&
      post.create === null,
    JSON.stringify(post).slice(0, 160),
  );
  const hits = scanMarkers([hand.marks.result, hand.marks.ab, hand.marks.create]);
  check(
    "重启后磁盘全树零草稿痕迹（无草稿持久化文件）",
    hits.length === 0,
    JSON.stringify(hits.slice(0, 4)),
  );
  const badge = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').includes('会话草稿')); return b ? b.textContent.trim() : null; })()`,
  );
  check("重启后徽标无 dirty 计数", badge !== null && !badge.includes("·"), String(badge));
  await putResultDraft(call, fx, "", true);
  const d = await resultDraftText(call, fx.normalRun);
  check(
    "重启后重开编辑器=原值",
    d === null || !String(d.text).includes(hand.marks.result),
    JSON.stringify(d).slice(0, 80),
  );
  check(
    "traces 文件数与重启前一致",
    traceCount() === hand.traceCountAt,
    `${hand.traceCountAt}→${traceCount()}`,
  );
  const pic = await shot(call, SHOT_DIR, "611-restart-post.png").catch(() => null);
  return { hand, post, hits, shot: pic !== null };
}

// ---------------------------------------------------------------------------
// T5 regression：U1/U2 阅读与文件状态 + 原有执行入口
// ---------------------------------------------------------------------------

async function tagRegression(call, fx) {
  // ① 页签/选中 span 会话内恢复（U1）
  await selectRun(call, fx.normalRun);
  await clickTab(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickTab(call, "概览");
  await clickTab(call, "步骤");
  const st1 = await storeQ(
    call,
    `const r = s.readingByRun[${JSON.stringify(fx.normalRun)}]; return JSON.stringify({ tab: r?.tab, spanId: r?.spanId, sel: s.selectedSpanId });`,
  );
  check(
    "U1 回归：步骤页签与选中 span 往返后恢复",
    st1.tab === "steps" && st1.spanId === "s_03" && st1.sel === "s_03",
    JSON.stringify(st1),
  );
  // ② 文件页 path/pane 会话内恢复（U2）
  await selectRun(call, fx.isoFork);
  const hasFilesTab = await clickTab(call, "文件");
  check("U2 回归：隔离子 run 有「文件」页签", hasFilesTab === true);
  await sleep(1200);
  // 默认检查点=「本 run 初始状态」时 auto 过滤会筛空（6 个文件相对初始无变化）⇒
  // 先「查看全部」再数行；pane=list 常驻时目录并排渲染（u2-56 的「显示文件列表」
  // 切换钮只在非常驻态存在）
  await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === '查看全部'); if (b) b.click(); return !!b; })()`,
  );
  let listCount = 0;
  for (let i = 0; i < 12; i++) {
    await ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="显示文件列表"]'); if (b) b.click(); return 1; })()`,
    );
    await sleep(600);
    listCount = Number(await ev(call, `document.querySelectorAll('[role="option"]').length`));
    if (listCount > 0) break;
  }
  check("U2 回归：文件列表渲染（role=option 行 >0）", listCount > 0, `options=${listCount}`);
  await ev(
    call,
    `(() => { const o = document.querySelector('[role="option"]'); if (o) { const b = o.closest('button') ?? o; b.click(); return true; } return false; })()`,
  );
  await sleep(900);
  await ev(
    call,
    `(() => { const b = document.querySelector('button[aria-label="显示文件内容"]'); if (b) b.click(); return null; })()`,
  );
  await sleep(1200);
  const st2 = await storeQ(
    call,
    `const r = s.readingByRun[${JSON.stringify(fx.isoFork)}]; return JSON.stringify({ tab: r?.tab, path: r?.files?.path ?? null, pane: r?.files?.pane ?? null });`,
  );
  check(
    "U2 回归：文件选择写入阅读状态（path 非空）",
    st2.tab === "files" && typeof st2.path === "string" && st2.path.length > 0,
    JSON.stringify(st2),
  );
  await clickTab(call, "概览");
  await clickTab(call, "文件");
  await sleep(1000);
  const st3 = await storeQ(
    call,
    `const r = s.readingByRun[${JSON.stringify(fx.isoFork)}]; return JSON.stringify({ tab: r?.tab, path: r?.files?.path ?? null });`,
  );
  check(
    "U2 回归：页签往返后文件路径保持",
    st3.path === st2.path && st3.tab === "files",
    JSON.stringify({ st2, st3 }),
  );
  // ③ 五个执行入口可达（不提交）
  await selectRun(call, fx.normalRun);
  await clickTab(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  check(
    "入口：result「在此重跑（时间旅行）」在场",
    (await ev(
      call,
      `(() => Array.from(document.querySelectorAll('button')).some(x => (x.textContent||'').includes('在此重跑（时间旅行）')))()`,
    )) === true,
  );
  await clickSpan(call, "LLM", "s_02");
  check(
    "入口：prompt「编辑 system prompt 重跑」在场",
    (await ev(
      call,
      `(() => Array.from(document.querySelectorAll('button')).some(x => (x.textContent||'').includes('编辑 system prompt 重跑')))()`,
    )) === true,
  );
  check(
    "入口：「模型 A/B」在场",
    (await ev(
      call,
      `(() => Array.from(document.querySelectorAll('button')).some(x => (x.textContent||'').includes('模型 A/B')))()`,
    )) === true,
  );
  await selectRun(call, fx.proxyRun);
  await clickTab(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  check(
    "入口：messages「编辑 messages 重发」在场",
    (await ev(
      call,
      `(() => Array.from(document.querySelectorAll('button')).some(x => (x.textContent||'').includes('编辑 messages 重发')))()`,
    )) === true,
  );
  await selectRun(call, fx.isoFork);
  await clickTab(call, "步骤");
  // 隔离 run 的自有工具 span：逐个尝试工具行（共享前缀行会显示「祖先前缀」说明而非入口）
  let isoEntryFound = false;
  for (let n = 0; n < 6 && isoEntryFound !== true; n++) {
    const clicked = await ev(
      call,
      `(() => { const rows = Array.from(document.querySelectorAll('button'))
          .filter(x => /(read_file|write_file|list_dir|glob|grep)/.test(x.title || '') && x.closest('header') === null);
        if (rows.length <= ${n}) return false; rows[${n}].click(); return true; })()`,
    );
    if (clicked !== true) break;
    await sleep(1200);
    isoEntryFound =
      (await ev(
        call,
        `(() => Array.from(document.querySelectorAll('button')).some(x => (x.textContent||'').includes('在此重跑（隔离续跑）')))()`,
      )) === true;
  }
  check("入口：隔离子 run 自有工具行有「在此重跑（隔离续跑）」", isoEntryFound === true);
  // ④ 文件内容真 IPC 可读（合法读取通道仍通）
  const read = await storeQ(
    call,
    `const r = s.readingByRun[${JSON.stringify(fx.isoFork)}]; return JSON.stringify({ path: r?.files?.path ?? null });`,
  );
  const contentShown = await ev(
    call,
    `(() => { const b = document.body.innerText || ''; return b.includes(${JSON.stringify(String(read.path ?? ""))}); })()`,
  );
  check(
    `文件正文渲染在场（路径 ${String(read.path).slice(0, 30)} 显示于内容区）`,
    contentShown === true,
    String(contentShown),
  );
  // ⑤ 新会话不受历史草稿影响
  const snap = await draftSnapshot(call);
  check(
    "本会话未做任何草稿操作 ⇒ 三区全空（历史草稿零泄漏）",
    Object.keys(snap.calls ?? {}).length === 0 &&
      Object.keys(snap.modelAb ?? {}).length === 0 &&
      snap.create === null,
    JSON.stringify(snap).slice(0, 120),
  );
  const pic = await shot(call, SHOT_DIR, "611-regression.png").catch(() => null);
  return { st1, st2, st3, read, shot: pic !== null };
}

const TAGS = {
  "zero-exec": tagZeroExec,
  reload: tagReload,
  "restart-pre": tagRestartPre,
  "restart-post": tagRestartPost,
  regression: tagRegression,
};

async function main() {
  const fx = fixture();
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const run = TAGS[TAG];
  if (run === undefined) throw new Error(`unknown tag: ${TAG}`);
  const data = loadOut();
  const watchdog = setTimeout(() => {
    console.error("[watchdog] 400s 未收尾 ⇒ 非零退出并落盘已有检查");
    try {
      const dd = loadOut();
      dd.checks = dd.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
      dd.measurements[TAG] = { failure: "watchdog-300s" };
      saveOut(dd);
    } catch {
      /* 落盘失败也要非零 */
    }
    process.exit(3);
  }, 400000);
  const page = await cdpConnect(PORT);
  if (!page) throw new Error("CDP 9612 上没有页面（dev 未起？）");
  const call = await makeEventSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  const nativeDialogs = [];
  call.on?.("Page.javascriptDialogOpening", (p) => {
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
  if (readyRuns === 0) throw new Error("运行列表未就绪——夹具未加载");

  let out = {};
  let failure = null;
  try {
    out = (await run(call, fx)) ?? {};
  } catch (e) {
    failure = String(e);
    check(`[${TAG}] 场景未抛异常`, false, failure);
  }
  if (TAG !== "zero-exec") {
    check(
      "除取消退出外零意外原生对话框",
      nativeDialogs.length === 0,
      JSON.stringify(nativeDialogs.slice(0, 2)),
    );
    out.nativeDialogs = nativeDialogs;
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
