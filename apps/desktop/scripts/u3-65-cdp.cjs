/* eslint-disable */
/**
 * U3 任务 6.5：关闭协商「输入锁」的实机验收（真键盘最后一次键入 / 真粘贴 / 真中文输入法组合
 * 及其尾随事件 × 锁内阻止新输入 × 取消恢复与焦点）。
 *
 * 验收（tasks 6.5）：
 * - **退出输入锁保留已接收文字且不重放按键**（键入 / 粘贴 / 中文输入法组合）；
 * - 最新 clean 应答才允许直接关闭；
 * - 锁内新输入被阻止、取消后恢复焦点。
 *
 * 与 6.4 的分工：6.4 验的是「关闭协商的决策与真实退出」，本文件验的是「协商持锁那一段时间里
 * 输入面的行为」。⇒ 本文件不重复断言进程结束。
 *
 * 触发面（全部走系统级，不用 CDP 合成事件）：
 * - 键入：`apps/desktop/scripts/lib/u3-65-input.ps1` 的 `keys` 动作（keybd_event 真按键，
 *   焦点由 `fg` 动作先抬到目标窗口）；CDP 只负责**聚焦哪个控件**与**读回结果**；
 * - 粘贴：真系统剪贴板（`Set-Clipboard`）+ 真 Ctrl+V；
 * - 中文输入法：只发 ASCII 拼音字母与空格，汉字能否出现完全交给**系统 TSF 输入法**决定；
 *   合成 CompositionEvent 一律不用（tasks.md 明文禁止以合成事件冒充真实输入法）。
 * - 事件的「被阻止」判据：页内只观察不干预的 document 捕获记录仪读 `defaultPrevented`
 *   （产品自己的捕获监听注册在前），再加 store/DOM 值逐字不变这条硬判据。
 *
 * 用法：node apps/desktop/scripts/u3-65-cdp.cjs --tag=<probe|real-keys|paste|lock-blocks|
 *                                                     cancel-restore|ime-composing|ime-commit>
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createConnection } = require("node:net");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u3", "u3-65");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-25-u3-65");
const MANIFEST = join(REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const OUT = join(OUT_DIR, "measurements.json");
const PS1 = join(REPO, "apps", "desktop", "scripts", "lib", "u3-64-winops.ps1");
const PS1_IN = join(REPO, "apps", "desktop", "scripts", "lib", "u3-65-input.ps1");
const QUIT_FLAG = join(OUT_DIR, "quit.flag");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "probe");

function fixture() {
  if (!existsSync(MANIFEST)) throw new Error(`缺 ${MANIFEST}——6.4 复用 6.1 的夹具`);
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
// Win32/UIA 通道（PowerShell 子进程；异步 spawn，本沙箱 spawnSync 全线 EBUSY）
// ---------------------------------------------------------------------------

/** 本仓库 dev 主进程 PID（resolveMainPid 认定后填充；0 = 未认定，PS 侧退化为按标题匹配） */
let MAIN_PID = 0;

/** 本进程 PID + 自增序号：每次 PS 调用独立产物文件（共用一个文件会被并发轮询互相覆盖） */
let PS_SEQ = 0;

function winops(action, extra = []) {
  return new Promise((resolve) => {
    PS_SEQ += 1;
    const out = join(OUT_DIR, `winops-${process.pid}-${PS_SEQ}.txt`);
    const child = spawn(
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
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let err = "";
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("close", (code) => {
      let lines = [];
      try {
        // 读**本次调用**的产物文件（早前读共享路径 ⇒ 拿到上一轮遗留内容，全是假判定）
        // PS 的 Set-Content -Encoding UTF8 会写 BOM；不可见字符不能靠正则字面量剥（会被编辑工具规范化丢失）
        let txt = readFileSync(out, "utf8");
        if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
        lines = txt.split(/\r?\n/).filter((l) => l.trim() !== "");
      } catch {
        lines = [];
      }
      try {
        if (existsSync(out)) rmSync(out);
      } catch {
        /* 清理失败不影响判定 */
      }
      resolve({ code, lines, err: err.slice(0, 300) });
    });
    child.on("error", (e) => resolve({ code: null, lines: [], err: String(e) }));
  });
}
/** 把 ["dialog-name=X","text=A","text=B"] 之类的行折成对象；**同名键聚合成数组**
 *（确认框的多行文案都叫 text=，后者覆盖前者会把证据吃掉） */
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
/** 取某键的全部值（拼成一段文本，用于跨行文案断言） */
function allOf(info, key) {
  const v = info?.[key];
  if (v === undefined) return "";
  return (Array.isArray(v) ? v : [v]).join(" ");
}
const dialogInfo = async () => parseLines((await winops("dialog-text")).lines);
const dialogCount = async () => Number(parseLines((await winops("dialog-count")).lines).dialogs);
const aliveInfo = async () => parseLines((await winops("alive")).lines);

/**
 * 唯一认定「本仓库那个 electron 主进程」的 PID（命令行含 ReBaseAgent 且拥有 ReBaseAgent 窗口），
 * 之后所有窗口/对话框查询都按 PID 过滤 —— 历史遗留实例与别的应用的 #32770 都不会再串进来。
 */
async function resolveMainPid() {
  const info = parseLines((await winops("resolve", [])).lines);
  const n = Number(info["main-pid"]);
  MAIN_PID = Number.isInteger(n) && n > 0 ? n : 0;
  return { pid: MAIN_PID, info };
}

/** 轮询等确认框出现（返回 dialog-text 解析结果；超时返回 null） */
async function waitDialog(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const r = await winops("dialog-text");
    const info = parseLines(r.lines);
    last = { lines: r.lines, err: r.err, code: r.code };
    if (process.env.U365_DEBUG === "1") {
      console.log(
        `  [dialog-text] code=${r.code} lines=${JSON.stringify(r.lines)} err=${r.err.slice(0, 120)}`,
      );
    }
    if (info["dialog-name"] !== undefined) return info;
    if (Date.now() > deadline) {
      // 失败时把原始输出留进 measurements，便于区分「对话框真没出现」与「PS 通道失败」
      waitDialog.lastRaw = last;
      return null;
    }
    await sleep(500);
  }
}
waitDialog.lastRaw = null;
async function waitDialogGone(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await dialogCount();
    if (n === 0) return true;
    if (Date.now() > deadline) {
      waitDialogGone.lastRaw = { n, alive: (await aliveInfo()).dialogs };
      return false;
    }
    await sleep(500);
  }
}
waitDialogGone.lastRaw = null;
/** 窗口句柄与 PID 的真实消失（不看 guard 返回值） */
async function waitWindowGone(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await aliveInfo();
    const winGone = a.window === "absent" || a.window?.includes("iswindow=False") === true;
    if (winGone) return a;
    if (Date.now() > deadline) return a;
    await sleep(600);
  }
}
async function waitPidGone(pid, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await aliveInfo();
    const pids = String(a["electron-pids"] ?? "")
      .split(",")
      .filter(Boolean);
    if (pid !== null && pid !== undefined && !pids.includes(String(pid)))
      return { gone: true, pids };
    if (process.env.U365_DEBUG === "1") {
      console.log(
        `  [waitPidGone] want=${pid} alive=${pids.includes(String(pid))} pids=${pids.join(",")} window=${a.window}`,
      );
    }
    if (Date.now() > deadline) return { gone: false, pids };
    await sleep(1500);
  }
}
const portOpen = () =>
  new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port: PORT });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(800, () => done(false));
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
  });

// ---------------------------------------------------------------------------
// CDP / store / DOM（真键入建草稿）
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
        new Promise((ok) => {
          const i = ++id;
          pending.set(i, ok);
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      call.on = (method, fn) => handlers.push({ method, fn });
      call.onClose = (fn) => ws.addEventListener("close", fn);
      res(call);
    };
    ws.onerror = rej;
  });
}

const ev = async (call, expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails)
    throw new Error(`ev: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
  return r?.result?.value;
};
const evAwait = (call, expression) =>
  call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then(
    (r) => r?.result?.value,
  );

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
  const r = await call("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    throw new Error(
      `appImport: ${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails).slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(r?.result?.value);
  } catch {
    throw new Error(`appImport 非法 JSON：${String(r?.result?.value).slice(0, 200)}`);
  }
}
const storeQ = (call, body) =>
  appImport(call, STORE_NEEDLE, `const s = m.useAppStore.getState(); ${body}`);
const draftsOf = (call) => storeQ(call, "return JSON.stringify({ calls: s.drafts.calls });");

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
async function clickTabChecked(call, label) {
  if (!(await clickTab(call, label))) throw new Error(`页签切换到「${label}」失败`);
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
  // 列表是异步 loadRuns 的结果 ⇒ 轮询等待（首帧可能只有几十毫秒的按钮）
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
async function monacoInfo(call) {
  return appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const ed = monaco.editor.getEditors().map((e, i) => ({
       i,
       value: e.getModel()?.getValue() ?? null,
       readOnly: e.getOption(monaco.editor.EditorOption.readOnly) === true,
       visible: e.getDomNode() !== null && e.getDomNode().offsetParent !== null,
     }));
     return JSON.stringify({ editors: ed });`,
  );
}
async function typeIntoEditableMonaco(call, text) {
  let idx = null;
  for (let i = 0; i < 12; i++) {
    const info = await monacoInfo(call);
    const target = info.editors.filter((e) => e.visible && !e.readOnly);
    if (target.length > 0) {
      idx = target[0].i;
      break;
    }
    await sleep(500);
  }
  if (idx === null) throw new Error("无可编辑 monaco（轮询 6s）");
  const pathC = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const e = monaco.editor.getEditors()[${idx}];
     const cur = e.getModel().getValue();
     e.trigger('keyboard', 'type', { text: ${JSON.stringify(text)} });
     await new Promise((r) => setTimeout(r, 500));
     return JSON.stringify({ changed: e.getModel().getValue() !== cur });`,
  );
  if (pathC.changed !== true) throw new Error("monaco 键入未生效");
  return "monaco-trigger";
}

/** 打开该 span 的 result 编辑器（已开着就不重复点入口——入口按钮会被编辑器自身替换） */
async function openResultEditor(call, runId) {
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  const alreadyOpen = await ev(
    call,
    `(() => Array.from(document.querySelectorAll('button'))
       .some(x => (x.textContent||'').trim() === '放弃修改'))()`,
  );
  if (alreadyOpen !== true) await clickByText(call, "在此重跑（时间旅行）", 1200);
}

/** 真 UI 路径建一份 result 草稿（与 6.1/6.3 同一入口），返回草稿原文 */
async function seedResultDraft(call, runId, text) {
  await openResultEditor(call, runId);
  await typeIntoEditableMonaco(call, text);
  const d = await draftsOf(call);
  const got = d?.calls?.[runId]?.s_03?.result?.text ?? "";
  if (!got.includes(text)) throw new Error(`草稿未落入 store：${JSON.stringify(got)}`);
  return got;
}

/** 真 UI 放弃这份草稿（回到 clean） */
async function discardResultDraft(call, runId) {
  await openResultEditor(call, runId);
  await clickByText(call, "放弃修改", 900);
  await clickByText(call, "确认放弃", 900);
  const d = await draftsOf(call);
  return (
    d?.calls?.[runId]?.s_03?.result === undefined ||
    (d?.calls?.[runId]?.s_03?.result?.text ?? "") === ""
  );
}

const overlayPresent = (call) =>
  ev(call, `!!document.querySelector('[data-testid="draft-close-lock"]')`);

/** 取当前会话与序号（伪造迟到应答用：走真 preload 通道，由 main 的 guard 判定） */
const closeSession = (call) =>
  storeQ(
    call,
    `const s = m.useAppStore.getState();
     const c = s.__u364probe ?? null;
     return JSON.stringify({ seen: c });`,
  );

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 真键盘 / 真剪贴板 / 真输入法通道（u3-65-input.ps1；每次调用独立产物文件）
// ---------------------------------------------------------------------------

let IN_SEQ = 0;
function inputops(action, extra = []) {
  return new Promise((resolve) => {
    IN_SEQ += 1;
    const out = join(OUT_DIR, `input-${process.pid}-${IN_SEQ}.txt`);
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        PS1_IN,
        "-Action",
        action,
        "-ProcId",
        String(MAIN_PID),
        "-OutFile",
        out,
        ...extra,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let err = "";
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("close", (code) => {
      let lines = [];
      try {
        let txt = readFileSync(out, "utf8");
        if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
        lines = txt.split(/\r?\n/).filter((l) => l.trim() !== "");
      } catch {
        lines = [];
      }
      try {
        if (existsSync(out)) rmSync(out);
      } catch {
        /* 清理失败不影响判定 */
      }
      resolve({ code, lines, err: err.slice(0, 300) });
    });
    child.on("error", (e) => resolve({ code: null, lines: [], err: String(e) }));
  });
}
const inState = async () => parseLines((await inputops("ime-state")).lines);
const inFg = async () => parseLines((await inputops("fg")).lines);
/** 真系统按键序列：tokens 是 "n,i,h,a,o" / "ctrl+v" / "space" 之类的 keybd_event 序列 */
const sendKeys = async (tokens, gapMs = 90, raise = "1") =>
  parseLines(
    (await inputops("keys", ["-Send", tokens, "-GapMs", String(gapMs), "-Raise", raise])).lines,
  );
const setClipboard = async (value) =>
  parseLines((await inputops("clipboard", ["-Value", value])).lines);

/**
 * 页内事件记录仪：**只观察、不改变行为**（不 preventDefault、不 stopPropagation）。
 * 产品自己的 document 捕获监听注册在前，所以这里读到的 defaultPrevented 就是它的裁决；
 * 同一节点上的后续监听不受 stopPropagation 影响（那是 stopImmediatePropagation 的职责）。
 */
async function installRecorder(call) {
  return ev(
    call,
    `(() => {
      if (window.__u365) return 'already';
      const rec = { comp: [], bi: [], key: [], paste: [] };
      window.__u365 = rec;
      const snap = (e) => {
        const o = {
          t: e.type,
          at: Math.round(performance.now()),
          inputType: e.inputType === undefined ? null : e.inputType,
          data: e.data === undefined ? null : String(e.data).slice(0, 40),
          composing: e.isComposing === true,
          cancelable: e.cancelable === true,
          key: e.key === undefined ? null : e.key,
          tgt: e.target && e.target.tagName ? e.target.tagName : null,
        };
        setTimeout(() => { o.prevented = e.defaultPrevented === true; }, 0);
        return o;
      };
      const cap = { capture: true };
      for (const t of ['compositionstart', 'compositionupdate', 'compositionend'])
        document.addEventListener(t, (e) => rec.comp.push(snap(e)), cap);
      document.addEventListener('beforeinput', (e) => rec.bi.push(snap(e)), cap);
      document.addEventListener('keydown', (e) => rec.key.push(snap(e)), cap);
      document.addEventListener('paste', (e) => rec.paste.push(snap(e)), cap);
      return 'installed';
    })()`,
  );
}
const recorder = (call) =>
  ev(
    call,
    `(() => { const r = window.__u365; if (!r) return null;
       const cut = (a) => a.map(e => ({ t: e.t, it: e.inputType, d: e.data, c: e.composing,
         cl: e.cancelable, p: e.prevented === true, k: e.key, tgt: e.tgt }));
       return JSON.stringify({ comp: cut(r.comp), bi: cut(r.bi), paste: cut(r.paste),
         key: cut(r.key).filter(e => e.k !== null) }); })()`,
  ).then((s) => (typeof s === "string" ? JSON.parse(s) : s));
/** 焦点元素的可比对标识 */
const focusTag = (call) =>
  ev(
    call,
    `(() => { const a = document.activeElement;
       if (!a) return 'none';
       const cls = typeof a.className === 'string' ? a.className.split(' ')[0] : '';
       return a.tagName + (cls ? '.' + cls : '') + (a.getAttribute && a.getAttribute('data-testid')
         ? '#' + a.getAttribute('data-testid') : ''); })()`,
  );
/** 聚焦「可编辑」那个 Monaco（原值侧是 readOnly，绝不能误聚焦它） */
async function focusEditableMonaco(call) {
  const r = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const eds = monaco.editor.getEditors();
     const idx = eds.findIndex((e) => e.getDomNode() !== null && e.getDomNode().offsetParent !== null
       && e.getOption(monaco.editor.EditorOption.readOnly) !== true);
     if (idx < 0) return JSON.stringify({ ok: false });
     const dom = eds[idx].getDomNode();
     const ta = dom.querySelector('textarea.inputarea');
     if (ta) ta.focus(); else eds[idx].focus();
     await new Promise((r2) => setTimeout(r2, 300));
     const a = document.activeElement;
     return JSON.stringify({ ok: a === ta, active: a ? a.tagName + '.' + String(a.className).split(' ')[0] : null });`,
  );
  return r;
}
/** Monaco 模型现值 + store 草稿现值（两口径同时读，防止「界面写了 store 没写」） */
async function monacoValue(call, runId) {
  const mv = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const eds = monaco.editor.getEditors();
     const idx = eds.findIndex((e) => e.getDomNode() !== null && e.getDomNode().offsetParent !== null
       && e.getOption(monaco.editor.EditorOption.readOnly) !== true);
     return JSON.stringify({ value: idx < 0 ? null : (eds[idx].getModel()?.getValue() ?? null) });`,
  );
  const d = await draftsOf(call);
  return { monaco: mv.value, store: d?.calls?.[runId]?.s_03?.result?.text ?? "" };
}
/** 可编辑 Monaco 的选区（判「真 Ctrl+A 是否真的全选」用） */
async function monacoSelection(call) {
  return appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const eds = monaco.editor.getEditors();
     const idx = eds.findIndex((e) => e.getDomNode() !== null && e.getDomNode().offsetParent !== null
       && e.getOption(monaco.editor.EditorOption.readOnly) !== true);
     if (idx < 0) return JSON.stringify({ ok: false });
     const e = eds[idx];
     const sel = e.getSelection();
     const lines = e.getModel().getLineCount();
     return JSON.stringify({
       ok: true,
       focused: e.hasTextFocus() === true,
       from: sel ? [sel.startLineNumber, sel.startColumn] : null,
       to: sel ? [sel.endLineNumber, sel.endColumn] : null,
       lineCount: lines,
       selectedChars: sel ? e.getModel().getValueInRange(sel).length : 0,
       totalChars: e.getModel().getValue().length,
     });`,
  );
}

/**
 * 探针（不计入门禁口径，只用来坐实本机事实）：
 * 当前键盘布局 / IME 开关、真按键是否进入编辑器、真 Ctrl+V 是否粘贴、
 * 拼音串是否触发**系统输入法**组合。
 */
async function tagProbe(call, fx) {
  await installRecorder(call);
  await openResultEditor(call, fx.normalRun);
  const log = {
    focused: await focusEditableMonaco(call),
    before: await monacoValue(call, fx.normalRun),
  };
  const push = async (label) => {
    log[label] = await monacoValue(call, fx.normalRun);
  };
  // 1) 先按真 Esc：清掉上一轮可能残留的组合态，再试真 Ctrl+V
  log.fg = await inFg();
  log.st = await inState();
  await sendKeys("esc", 120);
  await sleep(400);
  log.clip0 = await setClipboard("U365粘贴探针-OK");
  log.selBefore = await monacoSelection(call);
  await sendKeys("ctrl+a", 120);
  await sleep(400);
  log.selAfterCtrlA = await monacoSelection(call);
  await sendKeys("ctrl+v", 150);
  await sleep(900);
  await push("afterCtrlV");
  log.recAfterPaste = await recorder(call);
  // 2) Shift 是否切换中英文模式（微软拼音的既有行为）：切完打纯字母看是否落字面
  await sendKeys("shift", 150);
  await sleep(300);
  const marker = "abcd";
  await focusEditableMonaco(call);
  await sendKeys(marker.split("").join(","), 130);
  await sleep(700);
  await push("afterShiftTyping");
  // 3) 再切回去打拼音 + 空格选词（真输入法）
  await sendKeys("shift", 150);
  await sleep(300);
  await focusEditableMonaco(call);
  await sendKeys("m,a,o", 150);
  await sleep(600);
  log.recDuringComp = await recorder(call);
  await push("afterPinyin");
  await sendKeys("space", 150);
  await sleep(700);
  await push("afterCommit");
  log.recEnd = await recorder(call);
  log.focusNow = await focusTag(call);
  console.log(`PROBE ${JSON.stringify(log, null, 1).slice(0, 9000)}`);
  check(
    "探针跑通（真键盘/真剪贴板/输入法状态全部有返回）",
    String(log.st?.hkl ?? "").length > 0,
    JSON.stringify({ st: log.st, fg: log.fg }),
  );
  return log;
}

/** 打开编辑器并把一个稳定标记打在「当前焦点元素」上，供解锁后比对焦点归还 */
async function markFocus(call) {
  return ev(
    call,
    `(() => { const a = document.activeElement;
      if (!(a instanceof HTMLElement)) return 'none';
      a.setAttribute('data-u365f', '1');
      return a.tagName + '.' + String(a.className).split(' ')[0]; })()`,
  );
}
const focusReturned = (call) =>
  ev(
    call,
    `(() => { const m = document.querySelector('[data-u365f]');
      return JSON.stringify({ present: !!m, isActive: m !== null && m === document.activeElement }); })()`,
  ).then((s) => (typeof s === "string" ? JSON.parse(s) : s));

/** 真键盘最后一次键入（模式自适应：中文模式下走拼音+空格选词，英文模式下走字母直落） */
async function tagRealKeys(call, fx) {
  await installRecorder(call);
  await openResultEditor(call, fx.normalRun);
  const baseline = await monacoValue(call, fx.normalRun);
  await focusEditableMonaco(call);
  const fg = await inFg();
  const st = await inState();
  check(
    "真键盘通道已抬到目标窗口（前台 pid = 主进程）",
    String(fg.foreground ?? "").includes("same=True"),
    JSON.stringify(fg),
  );

  // 先打一串纯字母：中文模式会进组合，英文模式直落字面 ⇒ 用「是否出现 CJK」判定输入法模式
  await sendKeys("m,a,o", 130);
  await sleep(600);
  const mid = await monacoValue(call, fx.normalRun);
  await sendKeys("space", 130);
  await sleep(800);
  const after = await monacoValue(call, fx.normalRun);
  const grew = after.store.length > baseline.store.length;
  const syncStore = after.monaco === after.store;
  const cjk = /[\u4e00-\u9fff]/.test(after.store);
  check(
    "最后一次真按键确实落入编辑器与 store（不是界面向 harness 自述）",
    grew && syncStore,
    JSON.stringify({ baseline: baseline.store, mid: mid.store, after: after.store }),
  );
  check(
    "系统输入法状态如实记录（hkl 与是否产出汉字）",
    String(st.hkl ?? "").length > 0 && typeof cjk === "boolean",
    JSON.stringify({ hkl: st.hkl, cjk }),
  );

  // 锁前快照：紧接着关闭 ⇒ 刚才这次键入必须已经被算进 dirtyCount（询问框出现）
  await winops("close-titlebar");
  const dlg = await waitDialog();
  check(
    "刚真键入过 ⇒ 关闭必须询问（锁前已接收文字进了 clean 判定）",
    dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dlg).slice(0, 160),
  );
  await winops("dialog-click", ["-Index", "0"]);
  check("返回后确认框消失", (await waitDialogGone()) === true);
  const kept = await monacoValue(call, fx.normalRun);
  check(
    "返回后已接收文字逐字保留",
    kept.store === after.store,
    JSON.stringify({ kept: kept.store, want: after.store }),
  );
  return { fg, st, baseline, mid, after, kept };
}

/** 真系统剪贴板 + 真 Ctrl+V：全选再粘贴，编辑器与 store 同时等于剪贴板内容 */
async function tagPaste(call, fx) {
  await installRecorder(call);
  await openResultEditor(call, fx.normalRun);
  await focusEditableMonaco(call);
  const clip = `U365粘贴-验证-${Math.random().toString(36).slice(2, 6)}`;
  const clipSet = await setClipboard(clip);
  check(
    "真系统剪贴板已写入（Set-Clipboard 回读等长）",
    String(clipSet.RESULT ?? "").includes("roundtrip=True"),
    JSON.stringify(clipSet),
  );
  await sendKeys("ctrl+a", 130);
  const sel = await monacoSelection(call);
  check(
    "真 Ctrl+A 选中全文（选区长度=全文长度）",
    sel.ok === true && sel.selectedChars === sel.totalChars && sel.totalChars > 0,
    JSON.stringify(sel),
  );
  await sendKeys("ctrl+v", 140);
  await sleep(1000);
  const v = await monacoValue(call, fx.normalRun);
  check(
    "真 Ctrl+V 粘贴生效：编辑器与 store 同时等于剪贴板内容",
    v.monaco === clip && v.store === clip,
    JSON.stringify(v),
  );
  const r = await recorder(call);
  check(
    "未锁定时真 paste 事件确实抵达页面（编辑器的正常处理路径可用）",
    r.paste.length >= 1,
    JSON.stringify(r.paste.slice(0, 4)),
  );
  return { clip, clipSet, sel, v, pasteEvents: r.paste };
}

/**
 * 锁内新输入一律无效。两段都要覆盖，因为它们的拦截层不同：
 * A 段=纯锁定期（关闭刚投递、原生确认框还没弹起 ⇒ 只有 DOM 捕获锁在挡）；
 * B 段=确认框在场（**不抬窗口**：真实用户面对应用模态框时无法把主窗拉到前台，
 *      所以按键根本不该抵达页面）。
 * ⚠️ B 段绝不发 space/enter/esc：那会激活确认框默认按钮，把「询问在场」测成「已应答」。
 */
async function tagLockBlocks(call, fx) {
  await installRecorder(call);
  await openResultEditor(call, fx.normalRun);
  await focusEditableMonaco(call);
  const clip = `BASE-LINE-${Math.random().toString(36).slice(2, 6)}`;
  await setClipboard(clip);
  await sendKeys("ctrl+a,ctrl+v", 140);
  await sleep(900);
  const locked0 = await monacoValue(call, fx.normalRun);
  check("锁前基线已建立（真粘贴写入）", locked0.store === clip, JSON.stringify({ locked0 }));

  // ---- A 段：关闭已投递、确认框未弹 ⇒ 纯 DOM 锁定期内真键入 + 真粘贴
  await winops("close-titlebar");
  await setClipboard("PHASE-A-不应出现");
  const aKeys = await sendKeys("p,a,s,t,e", 90, "0");
  const aPaste = await sendKeys("ctrl+a,ctrl+v", 110, "0");
  const aVal = await monacoValue(call, fx.normalRun);
  const aRec = await recorder(call);
  check(
    "A 段（纯锁定期）真键入与真粘贴都不改值",
    aVal.monaco === locked0.monaco && aVal.store === locked0.store,
    JSON.stringify({ want: locked0.store, got: aVal.store, aKeys, aPaste }),
  );
  const aArrived = aRec.key.filter((e) => e.k !== null && e.k !== "Control");
  const aInsertive = [...aRec.bi, ...aRec.paste];
  check(
    "A 段抵达页面的插入类事件（beforeinput/paste）全部被阻止",
    aInsertive.every((e) => e.p === true),
    JSON.stringify({
      keydownArrived: aArrived.length,
      bi: aRec.bi.length,
      paste: aRec.paste.length,
      sample: aInsertive.slice(0, 4),
    }),
  );

  // ---- B 段：确认框在场，不抬窗口
  const dlg = await waitDialog();
  check("B 段：确认框在场", dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent");
  check("持锁期间整屏输入锁遮罩在场", (await overlayPresent(call)) === true);
  await setClipboard("PHASE-B-不应出现");
  const bKeys = await sendKeys("x,y,z", 110, "0");
  const bPaste = await sendKeys("ctrl+v", 120, "0");
  await sleep(1200);
  const bVal = await monacoValue(call, fx.normalRun);
  check(
    "B 段（确认框在场）按键与粘贴都进不了草稿",
    bVal.monaco === locked0.monaco && bVal.store === locked0.store,
    JSON.stringify({ want: locked0.store, got: bVal.store, bKeys, bPaste }),
  );
  check(
    "B 段确认框未被误触发（询问仍在场）",
    (await dialogCount()) === 1,
    `dialogs=${await dialogCount()}`,
  );

  await winops("dialog-click", ["-Index", "0"]);
  check("返回后确认框消失", (await waitDialogGone()) === true);
  await sleep(2500);
  const after = await monacoValue(call, fx.normalRun);
  check(
    "解锁后不重放被拦的输入（等 2.5s 仍逐字等于锁前基线）",
    after.store === locked0.store,
    JSON.stringify({ after: after.store, want: locked0.store }),
  );
  check("解锁后输入锁遮罩撤除", (await overlayPresent(call)) === false);
  return { locked0, aVal, aRec, aKeys, aPaste, bVal, bKeys, bPaste, after };
}

/** 取消恢复：焦点归还锁前元素，解锁后真键盘仍可正常输入 */
async function tagCancelRestore(call, fx) {
  await installRecorder(call);
  await openResultEditor(call, fx.normalRun);
  // 先用真粘贴造一份确定的 dirty（真键盘在中文模式下可能只进组合、不落草稿）
  const clip = `cancel-seed-${Math.random().toString(36).slice(2, 6)}`;
  await setClipboard(clip);
  await focusEditableMonaco(call);
  await sendKeys("ctrl+a,ctrl+v", 140);
  await sleep(900);
  const seeded = await monacoValue(call, fx.normalRun);
  check("锁前草稿已由真粘贴建立", seeded.store === clip, JSON.stringify(seeded));
  const f = await focusEditableMonaco(call);
  const marked = await markFocus(call);
  await winops("close-titlebar");
  const dlg = await waitDialog();
  check(
    "询问出现（持锁）",
    dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify({ dlg, seeded: seeded.store }).slice(0, 160),
  );
  const duringFocus = await focusTag(call);
  await winops("dialog-click", ["-Index", "0"]);
  check("返回后确认框消失", (await waitDialogGone()) === true);
  await sleep(800);
  const back = await focusReturned(call);
  check(
    "焦点归还给锁前那个编辑面（同一元素，非 body）",
    back.present === true && back.isActive === true,
    JSON.stringify({ marked, duringFocus, back, focusedEditor: f }),
  );
  // 解锁后真键盘仍可正常输入（恢复可用，而不是卡在锁态）
  const before = await monacoValue(call, fx.normalRun);
  await sendKeys("h,e,l,l,o", 130);
  await sleep(900);
  const after = await monacoValue(call, fx.normalRun);
  check(
    "解锁后真键盘仍可输入并同步进 store",
    after.store.length > before.store.length && after.monaco === after.store,
    JSON.stringify({ before: before.store, after: after.store }),
  );
  return { clip, seeded, marked, duringFocus, back, before, after };
}

/** 真中文输入法组合中关闭：绝不允许零询问直接关闭；尾随选词不得丢也不得重复 */
async function tagImeComposing(call, fx) {
  const st = await inState();
  await installRecorder(call);
  await openResultEditor(call, fx.normalRun);
  await setClipboard("u365-base-line");
  await focusEditableMonaco(call);
  await sendKeys("ctrl+a,ctrl+v", 140);
  await sleep(800);
  const base = await monacoValue(call, fx.normalRun);
  check(
    "已建立可控基线（真粘贴，纯 ASCII 便于识别输入法产物）",
    base.store === "u365-base-line",
    JSON.stringify(base),
  );

  /** 输入法模式预检：拼音串 + 空格能否产出汉字。英文模式则按一次真 Shift 再试。 */
  const warm = async () => {
    await focusEditableMonaco(call);
    await sendKeys("m,a,o,space", 150);
    await sleep(700);
    const v = await monacoValue(call, fx.normalRun);
    return /[\u4e00-\u9fff]/.test(v.store.slice(base.store.length));
  };
  const chineseFirst = await warm();
  let shifted = false;
  let chineseNow = chineseFirst;
  if (!chineseNow) {
    await sendKeys("shift", 150);
    await sleep(400);
    shifted = true;
    chineseNow = await warm();
  }
  check(
    "系统中文输入法确在生效（ASCII 拼音串经输入法产出汉字）",
    chineseNow === true,
    JSON.stringify({ hkl: st.hkl, chineseFirst, shifted, chineseNow }),
  );
  // 复位到可控基线，再进入「组合在飞」的真场景
  await setClipboard("u365-base-line");
  await focusEditableMonaco(call);
  await sendKeys("ctrl+a,ctrl+v", 140);
  await sleep(800);

  // 打拼音但**不**收尾（组合在飞）：此时模型里带着组合文本
  await sendKeys("m,a,o", 150);
  await sleep(500);
  const composing = await monacoValue(call, fx.normalRun);
  const recDuring = await recorder(call);
  await winops("close-titlebar");
  const dlg = await waitDialog(15000);
  const kind = dlg === null ? "none" : allOf(dlg, "text");
  check(
    "组合在飞时关闭仍出询问（绝不零询问直接关闭）",
    dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify({ dlg, composing: composing.store }).slice(0, 220),
  );
  check(
    "询问种类如实记录（dirty 文案 / unknown 降级文案）",
    kind.includes("未放弃") || kind.includes("无法确认"),
    `kind=${JSON.stringify(kind)}`,
  );

  // 尾随事件：确认框弹起会抢走焦点，输入法要么在此之前收尾提交、要么干净丢弃候选。
  // 两种都可接受；**不可接受**的是零询问直接关闭、裸拼音留在草稿里、或同一汉字插两次。
  await sleep(2500);
  const midLock = await monacoValue(call, fx.normalRun);
  const cjk = /[\u4e00-\u9fff]/.test(midLock.store);
  check(
    "锁内组合收尾后编辑器与 store 仍同源",
    midLock.monaco === midLock.store,
    JSON.stringify(midLock),
  );
  await winops("dialog-click", ["-Index", "0"]);
  check("返回后确认框消失", (await waitDialogGone()) === true);
  await sleep(2000);
  const after = await monacoValue(call, fx.normalRun);
  const han = after.store.match(/[\u4e00-\u9fff]/g) ?? [];
  const committed = han.length === 1 && !after.store.includes("mao");
  const discarded = after.store === base.store;
  check(
    "组合收尾二选一且不重复：提交出恰好一个汉字（无裸拼音）或干净丢弃",
    (committed || discarded) && !after.store.includes("mao"),
    JSON.stringify({ after: after.store, base: base.store, han, committed, discarded }),
  );
  // D6 的保留言义针对**已确定接收**（已提交进 model）的文字：锁前那次真粘贴的基线必须还在，
  // 不得被换回更旧的值。未提交候选由输入法在失焦时自行丢弃，按 D6 不算"应用已接收文本"。
  check(
    "锁前已提交的文字未被换回旧基线（D6 保留口径）",
    after.store.startsWith(base.store) && after.store.length >= base.store.length,
    JSON.stringify({ base: base.store, after: after.store }),
  );
  check(
    "收尾结局如实记录（提交 or 丢弃，二者之一且不留裸拼音）",
    committed !== discarded,
    JSON.stringify({ committed, discarded }),
  );
  return {
    st,
    base,
    chineseFirst,
    shifted,
    chineseNow,
    composing,
    recDuring,
    kind,
    midLock,
    after,
    committed,
    discarded,
    // 实现面事实：本机 Monaco 走 native-edit-context，中文组合期 document 级 composition 事件是否可见
    compEventsSeen: recDuring.comp.length,
    compositionObservableAtDocument: recDuring.comp.length > 0,
  };
}

/** clean 才放行：锁 → 返回 → 真放弃 → 再关闭 ⇒ 零询问且窗口真实关闭 */
async function tagCleanUnlock(call, fx) {
  await installRecorder(call);
  await openResultEditor(call, fx.normalRun);
  const clip = `clean-unlock-${Math.random().toString(36).slice(2, 6)}`;
  await setClipboard(clip);
  await focusEditableMonaco(call);
  await sendKeys("ctrl+a,ctrl+v", 140);
  await sleep(900);
  const dirty = await monacoValue(call, fx.normalRun);
  check("已用真粘贴建立 dirty 草稿", dirty.store === clip, JSON.stringify(dirty));
  await winops("close-titlebar");
  const dlg = await waitDialog();
  check(
    "有已接收文字时关闭出询问",
    dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify({ dlg, dirty: dirty.store }).slice(0, 160),
  );
  await winops("dialog-click", ["-Index", "0"]);
  check("返回后确认框消失", (await waitDialogGone()) === true);
  // 现场留证：放弃入口存在且可用（dirty 才会启用），否则后面的点击不会凭空弹确认框
  const entries = JSON.parse(
    await ev(
      call,
      `JSON.stringify(Array.from(document.querySelectorAll('button'))
        .map(b => ({ t: (b.textContent || '').trim().slice(0, 12), d: b.disabled === true }))
        .filter(x => x.t.includes('放弃')))`,
    ),
  );
  check(
    "放弃入口在场且已启用",
    entries.some((x) => x.t === "放弃修改" && x.d === false),
    JSON.stringify(entries),
  );
  const cleaned = await discardResultDraft(call, fx.normalRun);
  check(
    "按修订真放弃草稿（回到 clean）",
    cleaned === true,
    JSON.stringify(await monacoValue(call, fx.normalRun)),
  );
  await winops("close-titlebar");
  await sleep(3000);
  const dialogs = await dialogCount();
  const gone = await waitWindowGone();
  check("clean 后直接关闭：零询问", dialogs === 0, `dialogs=${dialogs}`);
  check(
    "clean 关闭后窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  return { clip, dirty, dlg, entries, cleaned, dialogs, gone };
}

/**
 * 诊断用探针（不进默认门禁集）：把「锁定期」拆成两段看输入到底能不能进来——
 * A 段：SC_CLOSE 已投递、原生确认框**尚未**弹起（模态干扰不存在，纯 DOM 锁）；
 * B 段：确认框在场且**不**抬窗口（真实用户面对模态框的情形）。
 */
async function tagLockProbe(call, fx) {
  await installRecorder(call);
  await openResultEditor(call, fx.normalRun);
  await focusEditableMonaco(call);
  await setClipboard("BASE-LINE");
  await sendKeys("ctrl+a,ctrl+v", 140);
  await sleep(900);
  const out = { base: await monacoValue(call, fx.normalRun) };
  const snap = async (label) => {
    out[label] = await monacoValue(call, fx.normalRun);
    out[`${label}_rec`] = await recorder(call);
    out[`${label}_dlg`] = await dialogCount();
  };
  // A 段：关闭刚投递、确认框还没弹（不等 dialog），立刻真按键 + 真粘贴
  await winops("close-titlebar");
  await setClipboard("PHASE-A-PASTE");
  await sendKeys("p,a,s,t,e", 90, "0");
  await sendKeys("ctrl+a,ctrl+v", 110, "0");
  await sleep(400);
  await snap("phaseA");
  const dlg = await waitDialog(15000);
  out.dialog = dlg === null ? null : { name: dlg["dialog-name"], text: allOf(dlg, "text") };
  // B 段：确认框在场，不抬窗口，直接真按键 + 真粘贴
  await setClipboard("PHASE-B-PASTE");
  await sendKeys("z,h,o,n,g", 110, "0");
  await sendKeys("space", 110, "0");
  await sendKeys("ctrl+a,ctrl+v", 120, "0");
  await sleep(1200);
  await snap("phaseB");
  await winops("dialog-click", ["-Index", "0"]);
  await waitDialogGone();
  await sleep(2500);
  await snap("afterReturn");
  console.log(`LOCK-PROBE ${JSON.stringify(out, null, 1).slice(0, 8000)}`);
  check(
    "锁探针跑通（两段都有采样）",
    out.phaseA !== undefined && out.phaseB !== undefined,
    JSON.stringify(out.base),
  );
  return out;
}

const TAGS = {
  probe: tagProbe,
  "lock-probe": tagLockProbe,
  "real-keys": tagRealKeys,
  paste: tagPaste,
  "lock-blocks": tagLockBlocks,
  "cancel-restore": tagCancelRestore,
  "ime-composing": tagImeComposing,
  "clean-unlock": tagCleanUnlock,
};

async function main() {
  const fx = fixture();
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(QUIT_FLAG)) rmSync(QUIT_FLAG);
  const run = TAGS[TAG];
  if (run === undefined) throw new Error(`unknown tag: ${TAG}`);

  const data = loadOut();
  const page = await cdpConnect(PORT);
  if (!page) throw new Error("CDP 9612 上没有页面（dev 未起？）");
  const call = await makeEventSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Page.reload", { ignoreCache: true });
  const RUNS_EXPR = `(() => Array.from(document.querySelectorAll('button'))
    .map(b => b.getAttribute('aria-label') || '')
    .filter(a => a.startsWith('复制完整运行 ID')).length)()`;
  // ⚠️ 重载后**旧文档的行数会先被读到**（实测：第一次采样就有 111 行，新文档随后才清空再装满）
  // ⇒ 就绪判据必须"连续两次采样一致且非空"，不能只看第一次 >0
  let readyRuns = 0;
  let prev = -1;
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
  await sleep(500);
  console.log(`冷重载完成：运行列表 ${readyRuns} 项（稳定两次采样）`);
  if (readyRuns === 0) throw new Error("重载后运行列表未稳定就绪——夹具未加载");
  await winops("restore");
  const resolved = await resolveMainPid();
  check(
    "已唯一认定本仓库 dev 主进程 PID（历史遗留实例不参与）",
    resolved.pid > 0,
    JSON.stringify(resolved.info),
  );

  let out = {};
  let failure = null;
  try {
    out = (await run(call, fx)) ?? {};
  } catch (e) {
    failure = String(e);
    check(`[${TAG}] 场景未抛异常`, false, failure);
  }
  try {
    out.screenshot = await shot(call, SHOT_DIR, `65-${TAG}.png`).catch(() => null);
  } catch {
    /* 应用可能已退出（退出类 tag），截图失败属预期 */
    out.screenshot = "skipped-app-exited";
  }
  out.winopsAliveAtEnd = (await aliveInfo()).window ?? null;
  data.measurements[TAG] = failure === null ? out : { ...out, failure };
  data.checks = data.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
  saveOut(data);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n完成：[${TAG}] ${checks.length - failed.length}/${checks.length} 通过`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
