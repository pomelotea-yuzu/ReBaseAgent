/* eslint-disable */
/**
 * U3 任务 6.6：renderer 崩溃 / 失联 / 重载 / 旧·伪造消息 / 系统会话结束边界的实机验收。
 *
 * 验收（tasks 6.6）：
 * - renderer 失联或应答无效仍有退出确认；
 * - 重载不能用空仓库抹掉旧会话未知状态；
 * - 旧会话伪造发送者和乱序消息不影响关闭；
 * - 系统会话结束不沿用普通退出承诺（**不触发宿主机注销/关机**——用 main 的
 *   dev-only 合成事件钩子核对边界；源码契约在 draft-close-flow.test.ts 4.4 +
 *   u3-66-smoke-hook.test.ts；本文件用真进程坐实「合成了事件也无任何确认/阻止」）。
 *
 * 注入面（独立 Electron dev 进程，不带用户数据路径改动）：
 * - 真崩溃：`REBASEAGENT_SMOKE_EVENT_FILE` 哨兵 ⇒ `forcefullyCrashRenderer()`（真 render-process-gone）；
 * - 失联（挂起）：CDP 投递一段同步忙等脚本——renderer 主线程冻结，**不合成任何事件**；
 * - 重载：CDP `Page.reload`（真实文档轮换 ⇒ did-finish-load ⇒ guard.rotateSession）；
 * - 伪造消息：走真 preload 通道 `window.api.draftCloseReport/Answer` 直发任意载荷
 *   （schema/会话/序号/requestId 校验全在 main guard——6.4 迟到应答同款通道）；
 * - 关闭由系统发起（WM_SYSCOMMAND SC_CLOSE），确认框 UIA 读写（u3-64-winops.ps1）。
 *
 * 判据纪律：退出与否只看**窗口句柄/PID/CDP 端口**的真实消失；文案断言读**框内文本**；
 * 「伪造消息不影响关闭」用反证——脏数据型伪造全被拒 ⇒ 旧会话轮换按真实 clean 状态评估 ⇒
 * 重载后关闭应**零询问直接结束**（若任何伪造被接受，必出丢失/未知确认，判红）。
 *
 * 用法：node apps/desktop/scripts/u3-66-cdp.cjs --tag=<crash-gone|hung-timeout|reload-empty-repo|forged-stale|session-event>
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createConnection } = require("node:net");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u3", "u3-66");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-25-u3-66");
const MANIFEST = join(REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const OUT = join(OUT_DIR, "measurements.json");
const PS1 = join(REPO, "apps", "desktop", "scripts", "lib", "u3-64-winops.ps1");
const HOOK_FLAG = join(OUT_DIR, "hook.flag");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "crash-gone");

function fixture() {
  if (!existsSync(MANIFEST)) throw new Error(`缺 ${MANIFEST}——6.6 复用 6.1 的夹具`);
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

/** 写哨兵 ⇒ main 侧对真窗口执行白名单动作（crash-renderer / 合成系统会话结束事件） */
function writeHook(action) {
  writeFileSync(HOOK_FLAG, `${action}\n`);
}

// ---------------------------------------------------------------------------
// Win32/UIA 通道（与 6.4 同一套纪律：独立产物文件 + 剥 BOM + 按 PID 认定）
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

async function waitDialog(timeoutMs = 15000) {
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
    const winGone = a.window === "absent" || String(a.window ?? "").includes("iswindow=False");
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

/** 全屏位图截取（原生 #32770 确认框不在网页里，CDP 截图截不到——视觉证据走系统屏幕） */
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
// CDP / store / DOM（复用 6.1/6.4 的三级键入与页内求值）
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
      call.onClose = (fn) => ws.addEventListener("close", fn);
      call.wsClosed = () => closed;
      res(call);
    };
    ws.onerror = rej;
  });
}

/**
 * 有界调用：renderer 失联后 ws 可能"半开"（send 不抛、回应永不到）。
 * 6.6 变异 A 实测：无界 await ⇒ 事件轮排空 ⇒ **node 静默以 0 退出**（假绿，判红信息全丢）。
 * 所有 CDP 求值必须有界。
 */
const CALL_TIMEOUT_MS = 25000;
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
/** 对可能已死/冻结的 renderer 求值：超时或抛错都如实返回状态字符串（失联证据用） */
async function evProbe(call, expression, timeoutMs = 5000) {
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
const dirtyCountOfPage = (call) =>
  appImport(
    call,
    ["/src/renderer/src/lib/draft-list.ts", "/src/lib/draft-list.ts"],
    `const store = await import((performance.getEntriesByType('resource')
        .map(e => e.name)
        .filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts')))[0]);
     const s = store.useAppStore.getState();
     return JSON.stringify({ dirty: m.dirtyCountOf(s.drafts) });`,
  );

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
/** 重载/冷启动就绪：连续两次采样一致且非空（6.4 实测旧文档行数会先被读到） */
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

/** 经真 preload 通道直发任意载荷（伪造消息：main guard 负责判定） */
const forge = (call, kind, payload) =>
  evAwait(
    call,
    `window.api.${kind === "report" ? "draftCloseReport" : "draftCloseAnswer"}(${JSON.stringify(payload)}); 'sent'`,
  );
/** 取当前文档会话 id（invoke 幂等：只标记握手并返回现值） */
const currentSession = (call) =>
  evAwait(
    call,
    `window.api.draftCloseHandshake().then(e => e.ok ? e.data.sessionId : ('ERR:' + e.error.code))`,
  );

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

/** ① 真崩溃失联：仍有退出确认（unknown + 丢失说明）；「返回」清除遗留标志后仍保守询问 */
async function tagCrashGone(call, fx) {
  void fx;
  const pidOfMain = MAIN_PID;
  const before = await evProbe(call, "1+1");
  check(
    "崩溃前 CDP 通道正常（对照）",
    before.ok === true && before.v === 2,
    JSON.stringify(before),
  );

  writeHook("crash-renderer");
  await sleep(5000);
  const probe = await evProbe(call, "1+1", 5000);
  const wsClosed = call.wsClosed?.() === true;
  check(
    "renderer 真崩溃：CDP 求值失联（超时或通道断开）",
    probe.ok !== true || wsClosed,
    JSON.stringify({ probe, wsClosed }),
  );
  const alive1 = await aliveInfo();
  check(
    "崩溃后窗口仍存活（失联 ≠ 窗口消失，确认无从谈起之前先证明窗口在）",
    String(alive1.window ?? "").includes("iswindow=True"),
    JSON.stringify(alive1),
  );

  await winops("close-titlebar");
  const dlg = await waitDialog();
  check(
    "renderer 失联时关闭仍有退出确认（#32770）",
    dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dlg ?? (await Promise.resolve(waitDialog.lastRaw))).slice(0, 200),
  );
  const joined = allOf(dlg, "text");
  check(
    "失联询问按 unknown 文案（不诊断存活、不宣称已崩溃）",
    joined.includes("暂时无法确认草稿状态") && !joined.includes("已崩溃"),
    joined.slice(0, 240),
  );
  check(
    "崩溃置遗留标志 ⇒ 文案含「先前会话…可能已经丢失」",
    joined.includes("丢失"),
    joined.slice(0, 240),
  );
  const shotDlg = await captureScreen(`66-${TAG}-dialog`);
  check("失联确认框在场时截屏（原生框视觉证据）", typeof shotDlg === "string", String(shotDlg));

  await winops("dialog-click", ["-Index", "0"]); // 返回
  check("返回后确认框消失", (await waitDialogGone()) === true);
  const alive2 = await aliveInfo();
  check(
    "失联返回后进程与窗口仍存活",
    String(alive2.window ?? "").includes("iswindow=True") &&
      String(alive2["electron-pids"] ?? "").includes(String(pidOfMain)),
    JSON.stringify(alive2),
  );

  // 第二次关闭：仍失联 ⇒ 仍询问；但丢失遗留标志已被「返回」清除 ⇒ 文案不再带丢失说明
  await winops("close-titlebar");
  const dlg2 = await waitDialog();
  const joined2 = allOf(dlg2, "text");
  check(
    "失联未恢复时再次关闭仍保守询问（unknown 不因返回而放行）",
    dlg2 !== null && joined2.includes("暂时无法确认草稿状态"),
    JSON.stringify({ d: dlg2, j: joined2.slice(0, 160) }),
  );
  check(
    "「返回」已确认知悉 ⇒ 丢失遗留标志清除（本次文案无丢失说明）",
    !joined2.includes("丢失"),
    joined2.slice(0, 240),
  );
  await winops("dialog-click", ["-Index", "0"]);
  await waitDialogGone();
  return { probe, wsClosed, alive1, joined, joined2 };
}

/** ② 挂起失联（忙等冻结）：超时降级 ⇒ 询问；恢复后可重新核对 ⇒ dirty 询问 ⇒ 放弃后零询问直退 */
async function tagHungTimeout(call, fx) {
  const pidOfMain = MAIN_PID;
  const text = await seedResultDraft(
    call,
    fx.normalRun,
    `6.6-挂起-${Math.random().toString(36).slice(2, 6)}`,
  );

  // 同步忙等 9s：不合成任何事件，纯真实冻结（query 无法被应答、应答也无法送达）
  call("Runtime.evaluate", {
    expression: "(() => { const t = Date.now(); while (Date.now() - t < 9000) {} return 1; })()",
  }).catch(() => {});
  await sleep(400);
  const hungProbe = await evProbe(call, "1+1", 1500);
  check(
    "renderer 已冻结（忙等期间 CDP 求值超时）",
    hungProbe.ok !== true,
    JSON.stringify(hungProbe),
  );

  await winops("close-titlebar");
  const dlg = await waitDialog();
  check(
    "失联（应答无效路径）仍有退出确认",
    dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dlg ?? (await Promise.resolve(waitDialog.lastRaw))).slice(0, 200),
  );
  const joined = allOf(dlg, "text");
  check(
    "本次 unknown 由超时降级 ⇒ 文案不含丢失说明（无会话丢失事件）、不宣称崩溃",
    joined.includes("暂时无法确认草稿状态") &&
      !joined.includes("丢失") &&
      !joined.includes("已崩溃"),
    joined.slice(0, 240),
  );
  await winops("dialog-click", ["-Index", "0"]); // 返回
  check("超时询问可取消（返回后确认框消失）", (await waitDialogGone()) === true);
  const alive = await aliveInfo();
  check(
    "取消后窗口与进程存活",
    String(alive.window ?? "").includes("iswindow=True") &&
      String(alive["electron-pids"] ?? "").includes(String(pidOfMain)),
    JSON.stringify(alive),
  );

  // 等冻结结束（自挂起起共 ~10.5s）：恢复后必须能重新核对
  let recovered = false;
  for (let i = 0; i < 20 && !recovered; i++) {
    const p = await evProbe(call, "1+1", 3000);
    recovered = p.ok === true && p.v === 2;
    if (!recovered) await sleep(700);
  }
  check("冻结结束后渲染层恢复可核对", recovered);
  let unlocked = false;
  for (let i = 0; i < 10 && !unlocked; i++) {
    unlocked = (await overlayPresent(call)) === false;
    if (!unlocked) await sleep(500);
  }
  check("排队中的旧查询/释放按序消化后输入锁不遗留", unlocked);
  const d = await draftsOf(call);
  check(
    "冻结期间的草稿未丢失（值逐字保留）",
    (d?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "") === text,
  );

  await winops("close-titlebar");
  const dlg2 = await waitDialog();
  const joined2 = allOf(dlg2, "text");
  check(
    "恢复后重新核对 ⇒ 本次是 fresh dirty 询问（有未放弃的调试草稿）",
    dlg2 !== null && joined2.includes("有未放弃的调试草稿"),
    joined2.slice(0, 200),
  );
  await winops("dialog-click", ["-Index", "0"]);
  check("第二次询问已取消", (await waitDialogGone()) === true);

  const cleaned = await discardResultDraft(call, fx.normalRun);
  check("草稿已放弃（回到 clean）", cleaned === true);
  await winops("close-titlebar");
  await sleep(3000);
  const dialogs = await dialogCount();
  check("失联风波后 clean 关闭仍零询问", dialogs === 0, `dialogs=${dialogs}`);
  const gone = await waitWindowGone();
  check(
    "窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check("进程真实结束", pidGone.gone === true, JSON.stringify(pidGone));
  return { joined, joined2, dialogs };
}

/** ③ 重载空仓库不能抹掉旧会话未知状态：dirty 时重载 ⇒ 新会话 clean 应答仍被降级询问 */
async function tagReloadEmptyRepo(call, fx) {
  const pidOfMain = MAIN_PID;
  const s1 = await currentSession(call);
  check("已取得当前文档会话 id", typeof s1 === "string" && !s1.startsWith("ERR:"), String(s1));
  const text = await seedResultDraft(
    call,
    fx.normalRun,
    `6.6-重载-${Math.random().toString(36).slice(2, 6)}`,
  );
  const dirtyBefore = await dirtyCountOfPage(call);
  check(
    "重载前旧会话确为 dirty（真上报过 dirtyCount>0）",
    dirtyBefore.dirty >= 1,
    JSON.stringify(dirtyBefore),
  );
  await sleep(1200); // 让 report 送达并被 guard 接受

  await call("Page.reload", { ignoreCache: true });
  const runs = await waitForReady(call);
  check("重载完成且运行列表就绪", runs > 0, `runs=${runs}`);
  const dirtyAfter = await dirtyCountOfPage(call);
  check(
    "重载后新会话是空仓库（dirtyCount=0，草稿随 renderer 内存消失）",
    dirtyAfter.dirty === 0,
    JSON.stringify(dirtyAfter),
  );
  const s2 = await currentSession(call);
  check(
    "文档会话已轮换（sessionId 变化）",
    typeof s2 === "string" && s2 !== s1,
    JSON.stringify({ s1, s2 }),
  );

  await winops("close-titlebar");
  const dlg = await waitDialog();
  const joined = allOf(dlg, "text");
  check(
    "空仓库不能抹掉未知态：新会话 clean 应答仍出确认（unknown 降级）",
    dlg !== null && joined.includes("暂时无法确认草稿状态"),
    JSON.stringify({ d: dlg, j: joined.slice(0, 160) }),
  );
  check(
    "确认文案含「先前会话…可能已经丢失」（重载遗留标志在场）",
    joined.includes("丢失"),
    joined.slice(0, 240),
  );
  const locked = await overlayPresent(call);
  check("渲染层确实应答了本次查询（输入锁在场 ⇒ 询问非超时假降级）", locked === true);
  const shotReload = await captureScreen(`66-${TAG}-dialog`);
  check(
    "空仓库仍出询问时截屏（确认框+输入锁在场）",
    typeof shotReload === "string",
    String(shotReload),
  );

  await winops("dialog-click", ["-Index", "0"]); // 返回 = 明确知悉丢失
  check("返回后确认框消失", (await waitDialogGone()) === true);
  let unlocked = false;
  for (let i = 0; i < 10 && !unlocked; i++) {
    unlocked = (await overlayPresent(call)) === false;
    if (!unlocked) await sleep(500);
  }
  check("应答方解锁（release 按 requestId 匹配）", unlocked);

  // 用户已确认知悉 ⇒ 遗留标志清除，此后空仓库的 clean 应答可信 ⇒ 零询问直退
  await winops("close-titlebar");
  await sleep(3000);
  const dialogs = await dialogCount();
  check(
    "「返回」知悉后再次关闭 ⇒ clean 直退零询问（标志只能由用户确认清除、且确实被清）",
    dialogs === 0,
    `dialogs=${dialogs} 现场=${JSON.stringify(await dialogInfo())}`,
  );
  const gone = await waitWindowGone();
  check(
    "窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check("进程真实结束", pidGone.gone === true, JSON.stringify(pidGone));
  void text;
  return { s1, s2, dirtyBefore, dirtyAfter, joined };
}

/** ④ 伪造/乱序消息不影响关闭：全部被拒 ⇒ 关闭行为与从未收到它们一致 */
async function tagForgedStale(call, fx) {
  const pidOfMain = MAIN_PID;
  const s1 = await currentSession(call);
  check("已取得当前会话 id", typeof s1 === "string" && !s1.startsWith("ERR:"), String(s1));
  // 真 UI 建草稿再放弃：推进真实序号与 lastReported（伪造者必须撞上"更小的序号/更旧的会话"）
  await seedResultDraft(call, fx.normalRun, `6.6-伪造前-${Math.random().toString(36).slice(2, 6)}`);
  const cleaned = await discardResultDraft(call, fx.normalRun);
  check("草稿已放弃（真实状态即将作为伪造攻击的对照组）", cleaned === true);
  await sleep(1200);

  const forged = [
    [
      "report",
      { sessionId: "sess-forged-not-real", sequence: 999999, dirtyCount: 99 },
      "假会话 id",
    ],
    ["report", { sessionId: s1, sequence: 0, dirtyCount: 99 }, "旧会话+更小序号（乱序/重放）"],
    ["report", { sessionId: s1, sequence: -1, dirtyCount: 99 }, "负序号（schema）"],
    ["report", { sessionId: s1, sequence: 5, dirtyCount: 1.5 }, "非整数计数（schema）"],
    [
      "report",
      { sessionId: s1, sequence: 6, dirtyCount: Number.MAX_SAFE_INTEGER },
      "超界计数（schema）",
    ],
    [
      "answer",
      {
        sessionId: s1,
        sequence: 7,
        requestId: "req-forged-no-pending",
        dirtyCount: 0,
        inputSettled: true,
      },
      "无挂起查询的应答",
    ],
    [
      "answer",
      { sessionId: "sess-forged", sequence: 8, requestId: "x", dirtyCount: 99, inputSettled: true },
      "假会话应答",
    ],
  ];
  for (const [kind, payload, label] of forged) {
    const sent = await forge(call, kind, payload);
    if (sent !== "sent") throw new Error(`伪造消息「${label}」未能经真通道发出：${sent}`);
  }
  await sleep(1500);
  const probe = await evProbe(call, "1+1");
  check("伪造消息未搞死主进程（渲染层仍可求值）", probe.ok === true, JSON.stringify(probe));
  const alive = await aliveInfo();
  const dlgN = await dialogCount();
  check(
    "伪造消息不触发任何确认/询问",
    dlgN === 0 && String(alive.window ?? "").includes("iswindow=True"),
    JSON.stringify({ dlgN, alive }),
  );
  const overlay = await overlayPresent(call);
  check("伪造消息未误置输入锁（锁只随真实查询起）", overlay === false);

  // 真实状态对照：clean 仓库 + 已握手 ⇒ 现在关闭应零询问直退（伪造若被接受必出丢失/dirty 询问）
  await call("Page.reload", { ignoreCache: true });
  const runs = await waitForReady(call);
  check("重载就绪（旧会话自此失效）", runs > 0, `runs=${runs}`);
  const s2 = await currentSession(call);
  check("会话已轮换", s2 !== s1 && !String(s2).startsWith("ERR:"), JSON.stringify({ s1, s2 }));
  // 旧会话重放（此刻 sessionId 已失效，序号再大也没用）
  await forge(call, "report", { sessionId: s1, sequence: 999999, dirtyCount: 99 });
  await forge(call, "answer", {
    sessionId: s1,
    sequence: 999998,
    requestId: "req-replay",
    dirtyCount: 99,
    inputSettled: false,
  });
  await sleep(1500);
  const dirtyNow = await dirtyCountOfPage(call);
  check("新会话自身状态可信（空仓库 dirty=0）", dirtyNow.dirty === 0, JSON.stringify(dirtyNow));

  await winops("close-titlebar");
  await sleep(3500);
  const dialogs = await dialogCount();
  const scene = dialogs > 0 ? await dialogInfo() : null;
  check(
    "全部伪造/乱序/旧会话消息被拒 ⇒ 关闭按真实状态零询问直退（反证：任何一条被接受都会出询问）",
    dialogs === 0,
    `dialogs=${dialogs} 现场=${JSON.stringify(scene)}`,
  );
  const gone = await waitWindowGone();
  check(
    "窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check("进程真实结束", pidGone.gone === true, JSON.stringify(pidGone));
  check("退出后 CDP 端口随进程关闭", (await portOpen()) === false);
  return { forged, dlgN, dialogs, s1, s2 };
}

/** ⑤ 系统会话结束边界：合成两种事件 ⇒ 零确认/零阻止/零退出；普通关闭承诺随后仍成立 */
async function tagSessionEvent(call, fx) {
  const pidOfMain = MAIN_PID;
  const text = await seedResultDraft(
    call,
    fx.normalRun,
    `6.6-系统事件-${Math.random().toString(36).slice(2, 6)}`,
  );

  for (const evtName of ["query-session-end", "session-end"]) {
    writeHook(evtName);
    await sleep(3000);
    const dialogs = await dialogCount();
    const alive = await aliveInfo();
    const probe = await evProbe(call, "1+1");
    check(
      `合成 ${evtName} 后：无确认框、窗口/进程存活、应用可用（不沿用普通退出确认）`,
      dialogs === 0 &&
        String(alive.window ?? "").includes("iswindow=True") &&
        String(alive["electron-pids"] ?? "").includes(String(pidOfMain)) &&
        probe.ok === true,
      JSON.stringify({ dialogs, alive, probe }),
    );
    const d = await draftsOf(call);
    check(
      `合成 ${evtName} 不改动任何草稿状态`,
      (d?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "") === text,
    );
  }
  check("哨兵已被消费（一次性，不重复触发）", !existsSync(HOOK_FLAG));

  // 普通关闭承诺仍在（且没被合成事件"预消费"）：dirty ⇒ 询问 ⇒ 确认退出真结束
  await winops("close-titlebar");
  const dlg = await waitDialog();
  const joined = allOf(dlg, "text");
  check(
    "合成系统事件后普通关闭仍走协商并询问（dirty 文案如实）",
    dlg !== null && joined.includes("有未放弃的调试草稿"),
    joined.slice(0, 200),
  );
  await winops("dialog-click", ["-Index", "1"]); // 退出并丢弃草稿
  const gone = await waitWindowGone();
  check(
    "确认退出后窗口真实结束（普通承诺未被合成事件破坏）",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check("进程真实结束", pidGone.gone === true, JSON.stringify(pidGone));
  return { joined };
}

const TAGS = {
  "crash-gone": tagCrashGone,
  "hung-timeout": tagHungTimeout,
  "reload-empty-repo": tagReloadEmptyRepo,
  "forged-stale": tagForgedStale,
  "session-event": tagSessionEvent,
};

async function main() {
  const fx = fixture();
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(HOOK_FLAG)) rmSync(HOOK_FLAG);
  const run = TAGS[TAG];
  if (run === undefined) throw new Error(`unknown tag: ${TAG}`);

  const data = loadOut();
  /**
   * 兜底看门狗：任何遗漏的无界等待都必须以**非零**退出暴露。
   * （6.6 变异 A 实测：失联后的无界 await ⇒ 事件轮排空 ⇒ node 静默以 0 退出 = 假绿）
   */
  const watchdog = setTimeout(() => {
    console.error("[watchdog] 240s 未收尾（疑似无界等待命中失联通道）——按失败退出并落盘已有检查");
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
    // ⚠️ 崩溃类 tag：ws 通道可能仍在但 renderer 永不回应 ⇒ shot 必须有界（实测无界时整进程挂死到 420s）
    out.screenshot = await Promise.race([
      shot(call, SHOT_DIR, `66-${TAG}.png`).catch(() => null),
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
