/* eslint-disable */
/**
 * U3 任务 6.4：关闭协商的实机验收（标题栏关闭 / Alt+F4 / app.quit × dirty·clean × 取消·确认 × 连续关闭）。
 *
 * 验收（tasks 6.4）：
 * - 有草稿时关闭可返回或明确退出；
 * - **最新 clean 应答才允许直接关闭**（dirty 时必出确认；建了又全部放弃 ⇒ 再关闭不再询问）；
 * - 重复关闭取消和迟到应答不会重入；
 * - 确认退出须观察**进程/窗口真实结束**，不能仅断言 guard 返回值。
 *
 * 触发面（本机实测口径，2026-09-25）：
 * - `close-titlebar`：X 按钮不可被 UIA 枚举（Chromium 自绘非客户区），故投递 X 的**系统等价物**
 *   `WM_SYSCOMMAND + SC_CLOSE`；并用 `styles` 动作打 WS_CAPTION/WS_SYSMENU 位证明该窗口确有标题栏；
 * - `altf4`：真 `keybd_event` 系统按键序列（ALT+F4），由 Windows 自己变成 SC_CLOSE 投递；
 * - `app-quit`：Windows 上外部无法调用 `app.quit()`，故走 main 的 dev-only 哨兵钩子
 *   （`REBASEAGENT_SMOKE_QUIT_FILE`，与 SMOKE_PICK_DIR / ZOOM_FACTOR 同族）。
 * - 原生确认框本身用 UIA 读写（`#32770` + `CCPushButton`），**不是**在渲染层伪造的应答。
 *
 * 纪律：真键入建草稿（走 6.1/6.3 的编辑器路径）、真点原生按钮、
 * 进程存活按 PID 独立复核（不依赖窗口句柄）；不改产品行为（只用既有钩子）。
 *
 * 用法：node apps/desktop/scripts/u3-64-cdp.cjs --tag=<titlebar-return|titlebar-quit|clean-direct|
 *                                                     altf4|reentry|late-answer|app-quit|app-quit-clean>
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createConnection } = require("node:net");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u3", "u3-64");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-25-u3-64");
const MANIFEST = join(REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const OUT = join(OUT_DIR, "measurements.json");
const PS1 = join(REPO, "apps", "desktop", "scripts", "lib", "u3-64-winops.ps1");
const QUIT_FLAG = join(OUT_DIR, "quit.flag");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "titlebar-return");

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
    if (process.env.U364_DEBUG === "1") {
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
    if (process.env.U364_DEBUG === "1") {
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

/** 标题栏关闭 + 有草稿 → 确认框（文案与按钮如实）→ 返回：不关窗、草稿保留、锁解除 */
async function tagTitlebarReturn(call, fx) {
  const text = await seedResultDraft(
    call,
    fx.normalRun,
    `6.4-返回对照-${Math.random().toString(36).slice(2, 6)}`,
  );
  const st = parseLines((await winops("styles")).lines);
  check(
    "窗口确有系统标题栏（WS_CAPTION+WS_SYSMENU，X 由此绘制）",
    st.WS_CAPTION === "True" && st.WS_SYSMENU === "True",
    JSON.stringify(st),
  );

  const before = parseLines((await winops("list")).lines);
  await winops("close-titlebar");
  const dlg = await waitDialog();
  check(
    "有草稿时关闭出现原生确认框（#32770「退出 ReBaseAgent」）",
    dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dlg),
  );
  const joined = allOf(dlg, "text");
  check(
    "确认框文案如实说明「有未放弃的调试草稿」与退出将丢失",
    joined.includes("有未放弃的调试草稿") && joined.includes("退出后将丢失"),
    joined.slice(0, 200),
  );
  const buttons = Object.entries(dlg ?? {})
    .filter(([k]) => k.startsWith("button["))
    .map(([, v]) => v);
  check(
    "确认框按钮为「返回」+「退出并丢弃草稿」（默认返回）",
    buttons.length === 2 && buttons[0] === "返回" && buttons[1].startsWith("退出"),
    JSON.stringify(buttons),
  );
  check("核对期间渲染层输入锁在场（覆盖整屏的遮罩）", (await overlayPresent(call)) === true);
  const dLocked = await draftsOf(call);
  check(
    "确认框停留期间草稿未被改动",
    (dLocked?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "") === text,
  );

  await winops("dialog-click", ["-Index", "0"]); // 返回
  check("点「返回」后确认框消失", (await waitDialogGone()) === true);
  const alive = await aliveInfo();
  check(
    "选择返回后窗口仍存活（IsWindow=True）",
    alive.window?.includes("iswindow=True") === true,
    JSON.stringify(alive),
  );
  const after = await draftsOf(call);
  check("返回后草稿逐字保留", (after?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "") === text);
  check("返回后输入锁解除", (await overlayPresent(call)) === false);

  // 再次关闭仍能协商（不被"已取消"永久短路）
  await winops("close-titlebar");
  const dlg2 = await waitDialog();
  check(
    "再次关闭仍能重新核对并再次询问",
    dlg2 !== null && dlg2["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dlg2).slice(0, 120),
  );
  await winops("dialog-click", ["-Index", "0"]);
  await waitDialogGone();
  return { text, st, before, alive };
}

/** 标题栏关闭 + 有草稿 → 选退出：窗口与进程真实结束 */
async function tagTitlebarQuit(call, fx) {
  const pidOfMain = MAIN_PID;
  await seedResultDraft(
    call,
    fx.normalRun,
    `6.4-退出对照-${Math.random().toString(36).slice(2, 6)}`,
  );
  await winops("close-titlebar");
  const dlg = await waitDialog();
  check("退出场景：确认框先出现", dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent");
  await winops("dialog-click", ["-Index", "1"]); // 退出并丢弃草稿
  const gone = await waitWindowGone();
  check(
    "选退出后窗口真实结束（句柄消失或 IsWindow=False）",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check(
    "选退出后进程真实结束（PID 不再存活）",
    pidGone.gone === true,
    JSON.stringify({ want: pidOfMain, pids: pidGone.pids }),
  );
  check("选退出后 CDP 端口随进程关闭", (await portOpen()) === false);
  return { pidOfMain, gone, pidGone };
}

/** clean 才允许直接关闭：先 dirty 出确认，放弃草稿回到 clean 后关闭应零询问 */
async function tagCleanDirect(call, fx) {
  await seedResultDraft(
    call,
    fx.normalRun,
    `6.4-clean前-${Math.random().toString(36).slice(2, 6)}`,
  );
  await winops("close-titlebar");
  const dirty = await waitDialog();
  check(
    "有草稿时仍然询问（clean 判定不是默认放行）",
    dirty !== null && dirty["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dirty).slice(0, 120),
  );
  await winops("dialog-click", ["-Index", "0"]);
  check("第一轮询问已应答（确认框消失）", (await waitDialogGone()) === true);
  check("第一轮应答后输入锁解除（渲染层可继续操作）", (await overlayPresent(call)) === false);
  const cleaned = await discardResultDraft(call, fx.normalRun);
  check("草稿已按修订放弃（回到 clean）", cleaned === true);
  const dirtyLeft = await appImport(
    call,
    ["/src/renderer/src/lib/draft-list.ts", "/src/lib/draft-list.ts"],
    `const store = await import((performance.getEntriesByType('resource')
        .map(e => e.name)
        .filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts')))[0]);
     const s = store.useAppStore.getState();
     return JSON.stringify({
       dirtyCount: m.dirtyCountOf(s.drafts),
       rows: m.deriveDraftList(s.drafts).map((r) => ({ key: r.listKey, dirty: r.dirty })),
     });`,
  );
  const pidOfMain = MAIN_PID;
  await winops("close-titlebar");
  await sleep(2500);
  const dialogs = await dialogCount();
  const scene = dialogs > 0 ? parseLines((await winops("dialog-text")).lines) : null;
  check(
    "clean 应答后直接关闭：不出现任何确认框",
    dialogs === 0,
    `dialogs=${dialogs} 现场=${JSON.stringify(scene)} dirtyLeft=${JSON.stringify(dirtyLeft)}`,
  );
  const gone = await waitWindowGone();
  check(
    "clean 关闭后窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check(
    "clean 关闭后进程真实结束",
    pidGone.gone === true,
    JSON.stringify({ want: pidOfMain, pids: pidGone.pids }),
  );
  return { dialogs, gone, pidGone, scene, dirtyLeft };
}

/** Alt+F4（真键盘序列）同样被拦；返回不关窗，退出真结束 */
async function tagAltF4(call, fx) {
  const pidOfMain = MAIN_PID;
  await seedResultDraft(call, fx.normalRun, `6.4-AltF4-${Math.random().toString(36).slice(2, 6)}`);
  const sent = parseLines((await winops("altf4")).lines);
  check(
    "Alt+F4 已作为真实系统按键投递",
    String(sent.RESULT ?? "").startsWith("altf4-keyboard"),
    JSON.stringify(sent),
  );
  const dlg = await waitDialog(10000);
  check(
    "Alt+F4 走同一关闭协商（确认框出现）",
    dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dlg).slice(0, 140),
  );
  await winops("dialog-click", ["-Index", "0"]);
  await waitDialogGone();
  const alive = await aliveInfo();
  check(
    "Alt+F4 选择返回后窗口与进程仍在",
    String(alive.window ?? "").includes("iswindow=True") &&
      String(alive["electron-pids"] ?? "").includes(String(pidOfMain)),
    JSON.stringify(alive),
  );
  // 再按一次并确认退出 → 进程真实结束
  await winops("altf4");
  const dlg2 = await waitDialog(10000);
  check(
    "第二次 Alt+F4 仍能重新核对并询问",
    dlg2 !== null && dlg2["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dlg2).slice(0, 120),
  );
  await winops("dialog-click", ["-Index", "1"]);
  const gone = await waitWindowGone();
  check(
    "Alt+F4 选退出后窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check(
    "Alt+F4 选退出后进程真实结束",
    pidGone.gone === true,
    JSON.stringify({ want: pidOfMain, pids: pidGone.pids }),
  );
  return { sent, alive, gone, pidGone };
}

/** 连续关闭不重入：确认框任何时刻只有一层；应答后若队列里后续的关闭再次询问，也算独立一轮 */
async function tagReentry(call, fx) {
  await seedResultDraft(call, fx.normalRun, `6.4-重入-${Math.random().toString(36).slice(2, 6)}`);
  await winops("close-titlebar");
  const dlg = await waitDialog();
  check("第一次关闭已询问", dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent");

  // 确认框停留期间再连发两次关闭：任何一次采样都不得出现第二层确认框（不叠加、不重入）
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
    "连发关闭期间始终只有一层确认框（不叠加、不重入）",
    maxStack === 1,
    `max=${maxStack} samples=${JSON.stringify(samples)}`,
  );

  // 逐轮应答「返回」：队列里被拦下的后续关闭可能各自再问一次——每次仍只有一层
  const rounds = [];
  for (let i = 0; i < 4; i++) {
    const n = await dialogCount();
    if (n === 0) break;
    const r = await winops("dialog-click", ["-Index", "0"]); // 返回
    rounds.push({ at: i, had: n, result: parseLines(r.lines).RESULT ?? r.err });
    await sleep(1200);
    const after = await dialogCount();
    if (after > 1) break;
    if (after === 0) break;
  }
  check(
    "应答后确认框最终清空（每轮各自独立、不并发）",
    (await waitDialogGone()) === true,
    JSON.stringify(rounds),
  );
  const d = await draftsOf(call);
  check(
    "重入测试后草稿仍在（取消不删任何东西）",
    Object.keys(d?.calls?.[fx.normalRun] ?? {}).length > 0,
    JSON.stringify(d?.calls?.[fx.normalRun] ?? null),
  );
  await winops("close-titlebar");
  const dlg2 = await waitDialog();
  check(
    "取消后再次关闭仍能询问（未卡死在未决状态）",
    dlg2 !== null && dlg2["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dlg2).slice(0, 120),
  );
  await winops("dialog-click", ["-Index", "0"]);
  await waitDialogGone();
  return { maxStack, samples, rounds };
}

/**
 * 迟到应答不会关窗：用真 preload 通道订阅 query（拿到**真实** sessionId/requestId），
 * 用户选返回（main 已取消该查询）后再补投同一 requestId 的应答 ⇒ guard 必须拒绝，
 * 窗口与进程都不得因此结束。
 */
async function tagLateAnswer(call, fx) {
  const pidOfMain = MAIN_PID;
  const text = await seedResultDraft(
    call,
    fx.normalRun,
    `6.4-迟到应答-${Math.random().toString(36).slice(2, 6)}`,
  );

  // 订阅真实查询事件（preload 暴露 onDraftCloseQuery；多一个监听者不改变任何行为）
  await ev(
    call,
    `(() => { window.__u364q = window.__u364q || [];
      if (window.__u364hooked === true) return 'already';
      window.__u364hooked = true;
      window.api.onDraftCloseQuery((q) => window.__u364q.push(q));
      return 'hooked'; })()`,
  );
  const hooked = await ev(call, "window.__u364hooked === true");
  check("已订阅真实关闭查询通道（拿真 requestId 用）", hooked === true);

  await winops("close-titlebar");
  const dlg = await waitDialog();
  check("迟到应答场景：先正常询问", dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent");
  const qCount = await ev(call, "(window.__u364q || []).length");
  check("本次查询确实抵达渲染层（真事件，非构造）", Number(qCount) >= 1, `queries=${qCount}`);

  await winops("dialog-click", ["-Index", "0"]); // 返回 ⇒ main 取消本次查询
  check("返回后确认框消失", (await waitDialogGone()) === true);

  // 补投迟到应答：同 sessionId + **同 requestId**（此刻已无挂起查询）、序号推进
  const late = await appImport(
    call,
    STORE_NEEDLE,
    `const qs = (window.__u364q || []);
     const q = qs[qs.length - 1] ?? null;
     if (q === null) return JSON.stringify({ error: 'no-query-captured' });
     await window.api.draftCloseAnswer({
       sessionId: q.sessionId,
       sequence: q.sequence + 10,
       requestId: q.requestId,
       dirtyCount: 0,
       inputSettled: true,
     });
     return JSON.stringify({ used: { sessionId: q.sessionId, requestId: q.requestId } });`,
  );
  check(
    "迟到应答已按真实 requestId 经真通道投递",
    late.used?.requestId !== undefined,
    JSON.stringify(late),
  );
  await sleep(2000);
  const alive = await aliveInfo();
  const d = await draftsOf(call);
  check(
    "迟到应答不会关窗（窗口仍存活）",
    String(alive.window ?? "").includes("iswindow=True"),
    JSON.stringify(alive),
  );
  check(
    "迟到应答不会结束进程（PID 仍在）",
    String(alive["electron-pids"] ?? "").includes(String(pidOfMain)),
    JSON.stringify(alive),
  );
  check(
    "迟到应答不删草稿",
    (d?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "") === text,
    JSON.stringify(d?.calls?.[fx.normalRun]?.s_03?.result?.text ?? "").slice(0, 120),
  );
  check(
    "迟到应答后应用仍可正常协商（再关闭仍询问）",
    (await (async () => {
      await winops("close-titlebar");
      const dlg2 = await waitDialog();
      const ok = dlg2 !== null && dlg2["dialog-name"] === "退出 ReBaseAgent";
      await winops("dialog-click", ["-Index", "0"]);
      await waitDialogGone();
      return ok;
    })()) === true,
  );
  return { late, alive, qCount };
}

/** app.quit（哨兵钩子）× dirty：返回 ⇒ 不退出；再触发 ⇒ 选退出后进程真实结束 */
async function tagAppQuit(call, fx) {
  const pidOfMain = MAIN_PID;
  await seedResultDraft(
    call,
    fx.normalRun,
    `6.4-APPQUIT-${Math.random().toString(36).slice(2, 6)}`,
  );
  writeFileSync(QUIT_FLAG, "quit\n");
  const dlg = await waitDialog(12000);
  check(
    "app.quit 也走同一协商（有草稿时询问）",
    dlg !== null && dlg["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dlg).slice(0, 140),
  );
  await winops("dialog-click", ["-Index", "0"]);
  check("询问被取消后确认框消失", (await waitDialogGone()) === true);
  await sleep(1500);
  const alive = await aliveInfo();
  check(
    "app.quit 被拦后进程与窗口仍存活（quit 未生效）",
    String(alive.window ?? "").includes("iswindow=True") &&
      String(alive["electron-pids"] ?? "").includes(String(pidOfMain)),
    JSON.stringify(alive),
  );

  // 再触发一次并确认退出
  writeFileSync(QUIT_FLAG, "quit\n");
  const dlg2 = await waitDialog(12000);
  check(
    "再次 app.quit 仍能重新核对并询问",
    dlg2 !== null && dlg2["dialog-name"] === "退出 ReBaseAgent",
    JSON.stringify(dlg2).slice(0, 120),
  );
  await winops("dialog-click", ["-Index", "1"]);
  const gone = await waitWindowGone();
  check(
    "确认退出后窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check(
    "确认退出后进程真实结束",
    pidGone.gone === true,
    JSON.stringify({ want: pidOfMain, pids: pidGone.pids }),
  );
  return { alive, gone, pidGone };
}

/** app.quit × clean：零询问直接结束（进程真实消失） */
async function tagAppQuitClean(call, fx) {
  void fx;
  const pidOfMain = MAIN_PID;
  writeFileSync(QUIT_FLAG, "quit\n");
  await sleep(3000);
  const dialogs = await dialogCount();
  check("无草稿时 app.quit 不询问", dialogs === 0, `dialogs=${dialogs}`);
  const gone = await waitWindowGone();
  check(
    "无草稿 app.quit 后窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    JSON.stringify(gone),
  );
  const pidGone = await waitPidGone(pidOfMain);
  check(
    "无草稿 app.quit 后进程真实结束",
    pidGone.gone === true,
    JSON.stringify({ want: pidOfMain, pids: pidGone.pids }),
  );
  return { dialogs, gone, pidGone };
}

const TAGS = {
  "titlebar-return": tagTitlebarReturn,
  "titlebar-quit": tagTitlebarQuit,
  "clean-direct": tagCleanDirect,
  altf4: tagAltF4,
  reentry: tagReentry,
  "late-answer": tagLateAnswer,
  "app-quit": tagAppQuit,
  "app-quit-clean": tagAppQuitClean,
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
    out.screenshot = await shot(call, SHOT_DIR, `64-${TAG}.png`).catch(() => null);
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
