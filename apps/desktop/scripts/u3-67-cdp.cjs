/* eslint-disable */
/**
 * U3 任务 6.7：应答延迟注入（<1.5s / >1.5s）× CDP CPU 降速的实机验收。
 *
 * 验收（tasks 6.7）：
 * - 慢响应降级后**可取消并重新核对**；
 * - 重复关闭取消和迟到应答**不会重入**；
 * - 记录：超时提示、取消解锁、迟到应答、下次正常查询；
 * - ⚠️ 不以"慢 renderer 不能超时"为判据；不宣称开发机注入等于真实慢机校准
 *   （注入面是 wall-clock 冻结与 CPU 降速，两者都只证明"阈值两侧的行为"，不是阈值校准）。
 *
 * 注入面（独立 dev 实例；无产品代码改动、无新钩子）：
 * - `slow-fast`：关闭请求后 renderer 忙等冻结 1.5s（应答迟到但**在 1.5s 阈值内**抵达 main，
 *   含投递余量）⇒ 确认必须是 dirty（慢应答被有效接受，不得误降级为 unknown）；
 * - `slow-slow`：冻结 4s（应答**必然晚于**超时确认出现）⇒ unknown 降级 + 超时提示文案；
 *   确认在场时连发关闭 ⇒ 至多一层（不重入）；取消 ⇒ 解锁；解冻后迟到应答 ⇒ 无任何后续效果
 *   （不弹新框、不关窗、草稿原样）；下次关闭走正常查询（fresh dirty）；放弃后 clean 直退；
 * - `cpu-throttle`：`Emulation.setCPUThrottlingRate` 20× 降速 ⇒ 关闭**绝不静默放行**，
 *   询问类型（dirty/unknown 均为合法降级）如实记录；解除降速后恢复正常核对与直退。
 *
 * 判据纪律（沿用 6.6）：全部 CDP 求值有界（失联/冻结窗口内 await 必须有界，否则
 * 事件轮排空 ⇒ 静默 exit 0 假绿）；退出判定只看窗口句柄/PID/端口；确认框走真 UIA；
 * 关闭由系统发起（WM_SYSCOMMAND SC_CLOSE）；应答时刻用 renderer 侧 Date.now()
 * 经真 preload 订阅记录（与客户端 handler 同一次消息派发，即应答发出时刻）。
 *
 * 用法：node apps/desktop/scripts/u3-67-cdp.cjs --tag=<slow-fast|slow-slow|cpu-throttle>
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createConnection } = require("node:net");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u3", "u3-67");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-25-u3-67");
const MANIFEST = join(REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const OUT = join(OUT_DIR, "measurements.json");
const PS1 = join(REPO, "apps", "desktop", "scripts", "lib", "u3-64-winops.ps1");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "slow-fast");

function fixture() {
  if (!existsSync(MANIFEST)) throw new Error(`缺 ${MANIFEST}——6.7 复用 6.1 的夹具`);
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
// Win32/UIA 通道（与 6.4/6.6 同纪律）
// ---------------------------------------------------------------------------

let MAIN_PID = 0;
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
function allOf(info, key) {
  const v = info?.[key];
  if (v === undefined) return "";
  return (Array.isArray(v) ? v : [v]).join(" ");
}
const dialogInfo = async () => parseLines((await winops("dialog-text")).lines);
const dialogCount = async () => Number(parseLines((await winops("dialog-count")).lines).dialogs);
const aliveInfo = async () => parseLines((await winops("alive")).lines);

async function resolveMainPid() {
  const info = parseLines((await winops("resolve", [])).lines);
  const n = Number(info["main-pid"]);
  MAIN_PID = Number.isInteger(n) && n > 0 ? n : 0;
  return { pid: MAIN_PID, info };
}
async function waitDialog(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = parseLines((await winops("dialog-text")).lines);
    if (info["dialog-name"] !== undefined) return info;
    if (Date.now() > deadline) {
      waitDialog.lastRaw = info;
      return null;
    }
    await sleep(500);
  }
}
async function waitDialogGone(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await dialogCount()) === 0) return true;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}
async function waitWindowGone(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await aliveInfo();
    if (a.window === "absent" || String(a.window ?? "").includes("iswindow=False")) return a;
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

/** 全屏截取：原生 #32770 确认框不在网页里，CDP 截图截不到（6.6 实测） */
function captureScreen(name) {
  return new Promise((resolve) => {
    const outFile = join(SHOT_DIR, `${name}.png`);
    const cmd = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size); $bmp.Save("${outFile}"); 'ok'`;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd],
      { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
    );
    child.on("close", () => resolve(existsSync(outFile) ? outFile : null));
    child.on("error", () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// CDP（全部有界）与页内工具
// ---------------------------------------------------------------------------

const STORE_NEEDLE = ["/src/renderer/src/store.ts", "/src/store.ts"];
const MONACO_NEEDLE = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];

function makeEventSession(pageUrl) {
  const ws = new WebSocket(pageUrl);
  let id = 0;
  const pending = new Map();
  const handlers = [];
  let closed = false;
  ws.onmessage = (raw) => {
    const m = JSON.parse(raw.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
      return;
    }
    for (const h of handlers) if (h.method === m.method) h.fn(m.params);
  };
  ws.onclose = () => {
    closed = true;
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
      call.wsClosed = () => closed;
      res(call);
    };
    ws.onerror = rej;
  });
}

/** renderer 冻结/失联时 await 必须有界（6.6 假绿教训：无界 await ⇒ 静默 exit 0） */
const CALL_TIMEOUT_MS = 30000;
const callBounded = (call, method, params = {}) =>
  Promise.race([
    call(method, params),
    sleep(CALL_TIMEOUT_MS).then(() => {
      throw new Error(`cdp-call-timeout(${CALL_TIMEOUT_MS}ms): ${method}`);
    }),
  ]);

const ev = async (call, expression) => {
  const r = await callBounded(call, "Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails)
    throw new Error(`ev: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
  return r?.result?.value;
};
const evAwait = (call, expression) =>
  callBounded(call, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }).then((r) => r?.result?.value);
async function evProbe(call, expression, timeoutMs = 4000) {
  const token = {};
  const raced = await Promise.race([
    ev(call, expression)
      .then((v) => ({ ok: true, v }))
      .catch((e) => ({ ok: false, why: String(e).slice(0, 160) })),
    sleep(timeoutMs).then(() => token),
  ]);
  if (raced === token) return { ok: false, why: "cdp-timeout" };
  return raced;
}

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
async function seedResultDraft(call, runId, text) {
  await openResultEditor(call, runId);
  await typeIntoEditableMonaco(call, text);
  const d = await draftsOf(call);
  const got = d?.calls?.[runId]?.s_03?.result?.text ?? "";
  if (!got.includes(text)) throw new Error(`草稿未落入 store：${JSON.stringify(got)}`);
  return got;
}
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

const RUNS_EXPR = `(() => Array.from(document.querySelectorAll('button'))
    .map(b => b.getAttribute('aria-label') || '')
    .filter(a => a.startsWith('复制完整运行 ID')).length)()`;
async function waitForReady(call, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let prev = -1;
  for (;;) {
    await sleep(700);
    let n = 0;
    try {
      n = Number(await ev(call, RUNS_EXPR)) || 0;
    } catch {
      n = -1;
    }
    if (n > 0 && n === prev) return n;
    prev = n;
    if (Date.now() > deadline) return 0;
  }
}

// ---------------------------------------------------------------------------
// 6.7 专属：冻结注入 + 应答时刻记录 + 降速
// ---------------------------------------------------------------------------

/**
 * 冻结 renderer D 毫秒（真同步忙等，不合成任何事件）。fire-and-forget：
 * 返回**投递前的 harness 时刻** tFire（renderer 侧应答时刻与它同机器时钟可比）。
 */
function freezeFire(call, ms) {
  const tFire = Date.now();
  call("Runtime.evaluate", {
    expression: `(() => { const t = Date.now(); while (Date.now() - t < ${ms}) {} return 1; })()`,
  }).catch(() => {});
  return tFire;
}

/** 订阅真实查询事件记录应答时刻（与客户端 handler 同一次派发 ⇒ 即应答发出时刻） */
async function hookAnswerClock(call) {
  await ev(
    call,
    `(() => { window.__q67 = [];
      if (window.__q67hooked === true) return 'already';
      window.__q67hooked = true;
      window.api.onDraftCloseQuery((q) => window.__q67.push({ requestId: q.requestId, t: Date.now() }));
      return 'hooked'; })()`,
  );
}
const answerLog = async (call) =>
  JSON.parse(String(await ev(call, "JSON.stringify(window.__q67 || [])")));

/** 等解冻：CDP 求值恢复；返回耗时 */
async function waitUnfrozen(call, budgetMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const p = await evProbe(call, "1+1", 3000);
    if (p.ok === true && p.v === 2) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > budgetMs) return { ok: false, ms: Date.now() - t0 };
    await sleep(500);
  }
}
const dialogKind = (joined) =>
  joined.includes("有未放弃的调试草稿")
    ? "dirty"
    : joined.includes("暂时无法确认草稿状态")
      ? "unknown"
      : "other";

/**
 * 逐轮点「返回」直到确认框清空。**为什么需要循环重试**：6.7 实测原生 #32770 框的
 * 首次 BM_CLICK 偶发被 UIA 吞掉（同 hwnd 连读两轮、after 仍=1，第二击才 after=0）——
 * 单次 dialog-click + waitDialogGone 会把这种 flaky 误判成"确认无法取消"。
 * 每轮记录 {kind, hwnd, click, after}：hwnd 恒定 ⇒ 是同一层框未关（首击被吞），
 * 而非"排队中的后续关闭又开新框"（那会看到不同 hwnd）。上限 rounds 轮。
 */
async function drainDialogs(maxRounds = 6) {
  const kinds = [];
  const rounds = [];
  for (let i = 0; i < maxRounds; i++) {
    if ((await dialogCount()) === 0) return { kinds, rounds, clean: true };
    const info = await dialogInfo();
    const kind = dialogKind(allOf(info, "text"));
    kinds.push(kind);
    const click = await winops("dialog-click", ["-Index", "0"]); // 返回
    rounds.push({
      at: i,
      kind,
      hwnd: info["dialog-hwnd"] ?? null,
      text: allOf(info, "text").slice(0, 120),
      click: parseLines(click.lines).RESULT ?? click.err ?? null,
      after: await dialogCount(),
    });
    await sleep(1200);
  }
  return { kinds, rounds, clean: (await dialogCount()) === 0 };
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

/** ① 慢而阈内（冻结 1.5s）：应答被有效接受 ⇒ dirty，不得误降级 unknown */
async function tagSlowFast(call, fx) {
  const text = await seedResultDraft(
    call,
    fx.normalRun,
    `6.7-阈内-${Math.random().toString(36).slice(2, 6)}`,
  );
  await hookAnswerClock(call);

  const tFire = freezeFire(call, 1500);
  await winops("close-titlebar");
  const dlg = await waitDialog();
  const joined = allOf(dlg, "text");
  const kind = dialogKind(joined);
  check(
    "慢而阈内的应答 ⇒ dirty 确认（未被误降级成超时提示）",
    dlg !== null && kind === "dirty",
    JSON.stringify({ kind, j: joined.slice(0, 160) }),
  );
  const qlog = await answerLog(call);
  const tQ = qlog[0]?.t ?? null;
  const delayMs = tQ === null ? null : tQ - tFire;
  check(
    "应答确实被冻结推迟（查询处理时刻距关闭发起 ≥1.2s ⇒ 忙等窗口覆盖了应答路径）",
    typeof delayMs === "number" && delayMs >= 1200,
    JSON.stringify({ delayMs, queries: qlog.length }),
  );
  const shot1 = await captureScreen(`67-${TAG}-dialog`);
  await winops("dialog-click", ["-Index", "0"]); // 返回
  check("取消后确认框消失", (await waitDialogGone()) === true);
  let unlocked = false;
  for (let i = 0; i < 10 && !unlocked; i++) {
    unlocked = (await overlayPresent(call)) === false;
    if (!unlocked) await sleep(500);
  }
  check("取消解除输入锁", unlocked);
  const d = await draftsOf(call);
  check("慢应答往返后草稿逐字保留", (d?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "") === text);

  // 阈值内的慢应答不污染后续：再关闭仍是正常核对，放弃后 clean 直退
  await winops("close-titlebar");
  const dlg2 = await waitDialog();
  check(
    "再次关闭仍正常核对出 dirty 询问",
    dlg2 !== null && dialogKind(allOf(dlg2, "text")) === "dirty",
  );
  await winops("dialog-click", ["-Index", "0"]);
  await waitDialogGone();
  const cleaned = await discardResultDraft(call, fx.normalRun);
  check("草稿已放弃（回到 clean）", cleaned === true);
  const pidOfMain = MAIN_PID;
  await winops("close-titlebar");
  await sleep(3000);
  const dialogs = await dialogCount();
  check("阈内慢应答史不影响 clean 直退", dialogs === 0, `dialogs=${dialogs}`);
  const gone = await waitWindowGone();
  check(
    "窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check("进程真实结束", pidGone.gone === true, JSON.stringify(pidGone));
  return { tFire, tQ, delayMs, kind, joined, shot1: typeof shot1 === "string" };
}

/** ② 慢而超阈（冻结 4s）：unknown 降级 + 不重入 + 取消解锁 + 迟到应答零效果 + 下次正常查询 */
async function tagSlowSlow(call, fx) {
  const text = await seedResultDraft(
    call,
    fx.normalRun,
    `6.7-超阈-${Math.random().toString(36).slice(2, 6)}`,
  );
  await hookAnswerClock(call);
  const pidOfMain = MAIN_PID;

  const tFire = freezeFire(call, 4000);
  await winops("close-titlebar");
  const dlg = await waitDialog();
  const joined = allOf(dlg, "text");
  const kind = dialogKind(joined);
  check(
    "应答超阈 ⇒ 超时降级出 unknown 确认（超时提示在场）",
    dlg !== null && kind === "unknown",
    JSON.stringify({ kind, j: joined.slice(0, 160) }),
  );
  check(
    "超时提示只说未及时核对（不宣称已崩溃/失联，也无丢失说明）",
    !joined.includes("已崩溃") && !joined.includes("丢失"),
    joined.slice(0, 200),
  );
  const shotDlg = await captureScreen(`67-${TAG}-dialog`);

  // 确认在场时连发关闭 ⇒ 复用当前流程，至多一层（不重入）
  await winops("close-titlebar");
  await winops("close-titlebar");
  let maxStack = 0;
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const n = await dialogCount();
    samples.push(n);
    if (n > maxStack) maxStack = n;
    await sleep(500);
  }
  check(
    "慢应答期间连发关闭仍至多一层确认（不重入）",
    maxStack === 1,
    `max=${maxStack} samples=${JSON.stringify(samples)}`,
  );

  // 逐轮点击并核对框数直到清零（原生框首击偶发被吞 ⇒ 单次点击+等待会假判"无法取消"）
  const drained = await drainDialogs();
  check(
    "降级确认可取消（点击-核对-重试排空；hwnd 轨迹区分'首击被吞'与'新轮新框'）",
    drained.clean && drained.kinds.length >= 1,
    JSON.stringify(drained.rounds.map((r) => ({ k: r.kind, h: r.hwnd, after: r.after }))),
  );
  const alive = await aliveInfo();
  check(
    "取消后窗口与进程存活",
    String(alive.window ?? "").includes("iswindow=True") &&
      String(alive["electron-pids"] ?? "").includes(String(pidOfMain)),
    JSON.stringify(alive),
  );

  // 等解冻；应答时刻必须晚于本次核对（迟到）
  const unf = await waitUnfrozen(call);
  check("冻结结束后渲染层恢复", unf.ok === true, JSON.stringify(unf));
  const qlog = await answerLog(call);
  const tQ = qlog[0]?.t ?? null;
  check(
    "应答确实迟到（查询处理时刻距关闭发起 >1.5s 阈值 ⇒ 本次降级不是提前放行）",
    typeof tQ === "number" && tQ - tFire > 1500,
    JSON.stringify({ tQ, tFire, delta: tQ === null ? null : tQ - tFire }),
  );
  let unlocked = false;
  for (let i = 0; i < 12 && !unlocked; i++) {
    unlocked = (await overlayPresent(call)) === false;
    if (!unlocked) await sleep(500);
  }
  check("取消解除输入锁（排队中的查询/释放按序消化，不遗留）", unlocked);

  // 迟到应答零效果：解冻后不自主弹框、不关窗、草稿原样
  await sleep(3000);
  const lateDialogs = await dialogCount();
  const alive2 = await aliveInfo();
  const d = await draftsOf(call);
  check(
    "迟到应答无后续效果（不弹新框、不关窗）",
    lateDialogs === 0 && String(alive2.window ?? "").includes("iswindow=True"),
    JSON.stringify({ lateDialogs, alive2 }),
  );
  check("迟到应答不删草稿", (d?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "") === text);

  // 下次正常查询：恢复后关闭走 fresh 应答 ⇒ dirty
  await winops("close-titlebar");
  const dlg2 = await waitDialog();
  const kind2 = dialogKind(allOf(dlg2, "text"));
  check("下次关闭走正常查询（fresh 应答 ⇒ dirty 询问）", dlg2 !== null && kind2 === "dirty", kind2);
  await winops("dialog-click", ["-Index", "0"]);
  await waitDialogGone();

  const cleaned = await discardResultDraft(call, fx.normalRun);
  check("草稿已放弃（回到 clean）", cleaned === true);
  await winops("close-titlebar");
  await sleep(3000);
  const dialogs = await dialogCount();
  check("降级风波后 clean 直退零询问", dialogs === 0, `dialogs=${dialogs}`);
  const gone = await waitWindowGone();
  check(
    "窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check("进程真实结束", pidGone.gone === true, JSON.stringify(pidGone));
  return { tFire, tQ, kind, kind2, samples, drained, shotDlg: typeof shotDlg === "string" };
}

/** ③ CPU 20× 降速：关闭绝不静默放行；询问类型如实记录；解除后恢复正常 */
async function tagCpuThrottle(call, fx) {
  const text = await seedResultDraft(
    call,
    fx.normalRun,
    `6.7-降速-${Math.random().toString(36).slice(2, 6)}`,
  );
  await hookAnswerClock(call);
  const pidOfMain = MAIN_PID;

  await callBounded(call, "Emulation.setCPUThrottlingRate", { rate: 20 });
  const t0 = Date.now();
  await winops("close-titlebar");
  const dlg = await waitDialog(30000);
  const joined = allOf(dlg, "text");
  const kind = dialogKind(joined);
  const elapsed = Date.now() - t0;
  check(
    "20× 降速下关闭绝不静默放行（确认框必现，类型如实记录）",
    dlg !== null && (kind === "dirty" || kind === "unknown"),
    JSON.stringify({ kind, elapsed, j: joined.slice(0, 120) }),
  );
  // 降速下连发关闭同样不重入
  await winops("close-titlebar");
  await sleep(1500);
  const stack = await dialogCount();
  check("降速下连发关闭仍至多一层确认", stack <= 1, `dialogs=${stack}`);
  const drained = await drainDialogs();
  check(
    "降速下确认可取消（点击-核对-重试直到框数清零）",
    drained.clean && drained.kinds.length >= 1,
    JSON.stringify(drained.rounds.map((r) => ({ k: r.kind, h: r.hwnd, after: r.after }))),
  );

  await callBounded(call, "Emulation.setCPUThrottlingRate", { rate: 1 });
  const unf = await waitUnfrozen(call, 30000);
  check("解除降速后渲染层恢复", unf.ok === true, JSON.stringify(unf));
  const d = await draftsOf(call);
  check("降速往返草稿逐字保留", (d?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "") === text);

  await winops("close-titlebar");
  const dlg2 = await waitDialog();
  const kind2 = dialogKind(allOf(dlg2, "text"));
  check(
    "解除降速后关闭走正常核对（fresh 应答 ⇒ dirty）",
    dlg2 !== null && kind2 === "dirty",
    kind2,
  );
  await winops("dialog-click", ["-Index", "0"]);
  await waitDialogGone();
  const cleaned = await discardResultDraft(call, fx.normalRun);
  check("草稿已放弃（回到 clean）", cleaned === true);
  await winops("close-titlebar");
  await sleep(3000);
  const dialogs = await dialogCount();
  check("clean 直退零询问", dialogs === 0, `dialogs=${dialogs}`);
  const gone = await waitWindowGone();
  check(
    "窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check("进程真实结束", pidGone.gone === true, JSON.stringify(pidGone));
  return { kind, elapsed, kind2, drained };
}

const TAGS = { "slow-fast": tagSlowFast, "slow-slow": tagSlowSlow, "cpu-throttle": tagCpuThrottle };

async function main() {
  const fx = fixture();
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const run = TAGS[TAG];
  if (run === undefined) throw new Error(`unknown tag: ${TAG}`);

  const data = loadOut();
  // 兜底看门狗（6.6 教训）：任何无界等待都必须以非零退出暴露，静默退 0 = 假绿
  const watchdog = setTimeout(() => {
    console.error("[watchdog] 240s 未收尾（疑似无界等待命中冻结通道）——按失败退出并落盘已有检查");
    try {
      const d = loadOut();
      d.checks = d.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
      d.measurements[TAG] = { failure: "watchdog-240s" };
      saveOut(d);
    } catch {
      /* 落盘失败也要非零退出 */
    }
    process.exit(3);
  }, 240000);
  const page = await cdpConnect(PORT);
  if (!page) throw new Error("CDP 9612 上没有页面（dev 未起？）");
  const call = await makeEventSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Page.reload", { ignoreCache: true });
  const readyRuns = await waitForReady(call);
  await sleep(500);
  console.log(`冷重载完成：运行列表 ${readyRuns} 项（稳定两次采样）`);
  if (readyRuns === 0) throw new Error("重载后运行列表未稳定就绪——夹具未加载");
  await winops("restore");
  const resolved = await resolveMainPid();
  check("已唯一认定本仓库 dev 主进程 PID", resolved.pid > 0, JSON.stringify(resolved.info));

  let out = {};
  let failure = null;
  try {
    out = (await run(call, fx)) ?? {};
  } catch (e) {
    failure = String(e);
    check(`[${TAG}] 场景未抛异常`, false, failure);
  }
  try {
    out.screenshot = await Promise.race([
      shot(call, SHOT_DIR, `67-${TAG}.png`).catch(() => null),
      sleep(15000).then(() => "shot-timeout-15s"),
    ]);
  } catch {
    out.screenshot = "skipped-app-exited-or-dead";
  }
  try {
    out.winopsAliveAtEnd = (await aliveInfo()).window ?? null;
  } catch {
    out.winopsAliveAtEnd = "unavailable";
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
