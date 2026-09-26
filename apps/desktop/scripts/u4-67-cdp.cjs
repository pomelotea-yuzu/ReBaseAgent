/* eslint-disable */
/**
 * U4 任务 6.7：关闭协商的**真机面**（§5 合并文案的正主）。
 *
 * 覆盖（tasks 6.7 验收逐字）：
 * - `无草稿的活跃操作也需确认`（tag `clean-running`：标题栏关闭 × 在飞真执行 + busy 拒第二入口 + 返回不释放槽）
 * - `草稿与操作合并且关闭竞争不漏保护`（tag `altf4-dirty`：Alt+F4 × dirty+running + 连发关闭不重入）
 * - 合并文案的 unknown 档（tag `frozen-unknown`：renderer 冻结 ⇒ `暂时无法确认草稿状态，且有操作正在执行`）
 * - `app.quit` 协商（tag `quit-return` / `quit-executing`：哨兵文件 ⇒ 真 `app.quit()` ⇒ 返回 / 退出）
 * - `退出输入锁保留已接收文字且不重放按键`（真键盘事件打在锁住的表单上 + 二次查询只读 dirty 元数据）
 *
 * 三条本轮新踩的口径（写断言前必须知道）：
 * 1. **§5 把 closing 接进了 registry ⇒ 询问期间第二个入口被拒是 main 事实**：判据读
 *    `operations:status` 的 `closing` 与被拒记录的 `notAccepted`，不看界面置灰；
 * 2. **原生确认框只在 UIA 侧**（CDP `Page.javascriptDialogOpening` 看不见 `#32770`）⇒
 *    文案判据一律 `dialog-text` 读 `message` + `detail` + 按钮，视觉证据走 `CopyFromScreen`；
 * 3. **在飞类判据必须给 `delayMs` 回合**（6.5/6.6 各栽过一次）。
 *
 * 用法：node apps/desktop/scripts/u4-67-cdp.cjs --tag=<clean-running|altf4-dirty|frozen-unknown|quit-return|quit-executing>
 * 前置：dev 带 CDP 9612 **且** `REBASEAGENT_SMOKE_QUIT_FILE` 指向本批 quit.flag（quit-* tag 用）。
 */
"use strict";
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["clean-running", "altf4-dirty", "frozen-unknown", "quit-return", "quit-executing"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u4", "u4-67");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-27-u4-67");
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const PS1 = join(H.REPO, "apps", "desktop", "scripts", "lib", "u3-64-winops.ps1");
const QUIT_FLAG = join(OUT_DIR, "quit.flag");
const TASK_MARK = "U4-67";
/** 在飞回合的延迟：必须长过整场协商（45s），否则槽自己释放 ⇒ 「返回不释放槽」判据空转 */
const FLIGHT_MS = 45_000;
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

const checks = [];
const dump = { dialogs: [], screens: [], strayErrors: [] };
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
// Win32/UIA 通道（U3 6.4/6.7 同纪律：每次调用独立产物文件 + 剥 BOM）
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
const dialogCount = async () => Number(parseLines((await winops("dialog-count")).lines).dialogs);
async function dialogInfo() {
  const info = parseLines((await winops("dialog-text")).lines);
  const texts = (Array.isArray(info.text) ? info.text : info.text ? [info.text] : []).join(" / ");
  // 原生框按钮被 winops 写成 `button[0]=返回 / button[1]=退出` ⇒ 按前缀收集（不是单一 "button" 键）
  const buttonKeys = Object.keys(info)
    .filter((k) => /^button\[\d+\]$/.test(k))
    .sort((a, b) => Number(a.slice(7, -1)) - Number(b.slice(7, -1)));
  const buttons = buttonKeys.map((k) => info[k]).join("|");
  return {
    present: info["dialog-name"] !== undefined,
    hwnd: info["dialog-hwnd"] ?? null,
    texts,
    buttons,
  };
}
async function waitDialog(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await dialogInfo();
    if (d.present) return d;
    if (Date.now() > deadline) return null;
    await H.sleep(400);
  }
}
async function waitDialogGone(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await dialogCount()) === 0) return true;
    if (Date.now() > deadline) return false;
    await H.sleep(400);
  }
}
const aliveInfo = async () => parseLines((await winops("alive")).lines);
async function resolveMainPid() {
  const info = parseLines((await winops("resolve")).lines);
  const n = Number(info["main-pid"]);
  MAIN_PID = Number.isInteger(n) && n > 0 ? n : 0;
  return { pid: MAIN_PID, info };
}
async function waitWindowGone(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await aliveInfo();
    if (a.window === "absent" || String(a.window ?? "").includes("iswindow=False")) return a;
    if (Date.now() > deadline) return a;
    await H.sleep(600);
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
    await H.sleep(1200);
  }
}
const windowAlive = async () => {
  const a = await aliveInfo();
  return { alive: String(a.window ?? "").includes("iswindow=True"), dialogs: Number(a.dialogs) };
};

/** 全屏截取：原生 #32770 不在网页里，CDP 截图只会给一张"没有框"的页面图（U3 6.6 实测） */
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

/**
 * 逐轮点按钮直到框数清零（U3 6.7：原生框首击可被吞 ⇒ 必须"点击-核对-重试"）。
 * 每轮记 {kind,hwnd,click,after}：hwnd 恒定 = 同一层框首击未生效，不是新轮新框。
 */
async function drainDialogs(buttonIndex = 0, maxRounds = 6) {
  const rounds = [];
  for (let i = 0; i < maxRounds; i++) {
    if ((await dialogCount()) === 0) return { rounds, clean: true };
    const info = await dialogInfo();
    const click = await winops("dialog-click", ["-Index", String(buttonIndex)]);
    rounds.push({
      at: i,
      hwnd: info.hwnd,
      text: info.texts.slice(0, 120),
      click: parseLines(click.lines).RESULT ?? click.err ?? null,
      after: await dialogCount(),
    });
    await H.sleep(1200);
  }
  return { rounds, clean: (await dialogCount()) === 0 };
}
/** 确认框里的「退出」按钮下标（dirty 档文案是「退出并丢弃草稿」） */
function quitButtonIndex(dialog) {
  const buttons = String(dialog?.buttons ?? "").split("|");
  const i = buttons.findIndex((b) => b.includes("退出"));
  return i;
}

// ---------------------------------------------------------------------------
// CDP（全部有界：冻结/退出路径下无界 await = 假绿）
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
async function evProbe(expression, timeoutMs = 4000) {
  const token = {};
  const raced = await Promise.race([
    evB(expression)
      .then((v) => ({ ok: true, v }))
      .catch((e) => ({ ok: false, why: String(e).slice(0, 160) })),
    H.sleep(timeoutMs).then(() => token),
  ]);
  if (raced === token) return { ok: false, why: "cdp-timeout" };
  return raced;
}
/** 冻结 renderer D 毫秒（真同步忙等，不合成任何协议事件）；返回投递前时刻（同机时钟可比） */
function freezeFire(ms) {
  const tFire = Date.now();
  call("Runtime.evaluate", {
    expression: `(() => { const t = Date.now(); while (Date.now() - t < ${ms}) {} return 1; })()`,
  }).catch(() => {});
  return tFire;
}
async function waitUnfrozen(budgetMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const p = await evProbe("1+1", 3000);
    if (p.ok === true && p.v === 2) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 > budgetMs) return { ok: false, ms: Date.now() - t0 };
    await H.sleep(500);
  }
}
/** 真键盘事件（走 DOM：keydown/beforeinput 可被输入锁的捕获监听阻止） */
async function realKeys(text) {
  for (const ch of text) {
    await callB("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch });
    await callB("Input.dispatchKeyEvent", { type: "keyUp" });
  }
}
/** 真鼠标点击"新建运行"对话框内指定文案的按钮中心（命中测试走 DOM） */
async function realClickDialogButton(text) {
  const box = await evB(
    `(() => { const dlg = document.querySelector(${JSON.stringify(CREATE_DIALOG)});
      if (!dlg) return JSON.stringify({ error: 'no-dialog' });
      const b = Array.from(dlg.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === ${JSON.stringify(text)});
      if (!b) return JSON.stringify({ error: 'no-button' });
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`,
  );
  const p = JSON.parse(box);
  if (p.error !== undefined) return p.error;
  await callB("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
  await callB("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
  return "clicked";
}

// ---------------------------------------------------------------------------
// 登记读数（只认 main）与页内状态
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
    epoch: st?.data?.epoch ?? null,
    version: st?.data?.registryVersion ?? null,
    slot: st?.data?.activeOperationId ?? null,
    closing: st?.data?.closing ?? null,
    configBusy: st?.data?.configurationBusy ?? null,
    count: list.length,
    list,
  };
}
const recordOf = async (operationId) => {
  const snap = await mainStatus();
  return { rec: snap.list.find((o) => o.operationId === operationId) ?? null, snap };
};
const CREATE_SYSTEM = "你是冒烟助手。只回一句话。";
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
const bridgeCreate = (epoch, operationId, userMessage) =>
  H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `return JSON.stringify(await window.api.createRun({
       operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
       request: { systemPrompt: ${JSON.stringify(CREATE_SYSTEM)}, userMessage: ${JSON.stringify(userMessage)} },
     }));`,
  );
async function waitRunning(operationId, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await recordOf(operationId);
    if (r.rec !== null) return r;
    if (Date.now() > deadline) return r;
    await H.sleep(150);
  }
}
async function waitMainSettled(operationId, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await recordOf(operationId);
    if (r.rec !== null && r.rec.state !== "running") return r;
    if (Date.now() > deadline) return { ...r, timedOut: true };
    await H.sleep(600);
  }
}
const view = () =>
  H.storeQ(
    call,
    `return JSON.stringify({
        epoch: s.operations.epoch, registryVersion: s.operations.registryVersion,
        activeOperationId: s.operations.activeOperationId, unknown: s.operations.unknown,
        closing: s.operations.closing, configurationBusy: s.operations.configurationBusy,
        pending: s.operations.pending.map(p => p.operationId),
        operations: s.operations.operations.map(o => ({ id: o.operationId, state: o.state, runIds: o.runIds })),
       });`,
  );
const overlayPresent = () =>
  evB(`!!document.querySelector('[data-testid="draft-close-lock"]')`).catch(() => null);
const createDraftTexts = () =>
  H.storeQ(
    call,
    `const c = s.drafts.create;
     return JSON.stringify(c === null ? null : { systemPrompt: c.systemPrompt, userMessage: c.userMessage, revision: c.revision });`,
  );
const entryGate = async () => {
  const session = await H.storeQ(call, "return JSON.stringify(s.operations);");
  return H.appImport(
    call,
    ["/src/renderer/src/lib/entry-gate.ts", "/src/lib/entry-gate.ts"],
    `return JSON.stringify(m.deriveEntryGate(${JSON.stringify(session)}));`,
  );
};
/** 在飞期间的真 UI 提交尝试（store 真动作，不是直接 IPC）：看请求是否离开 renderer */
const storeCreateAttempt = (userMessage) =>
  H.storeQ(
    call,
    `const before = (s.operations.pending ?? []).map(p => p.operationId);
     const okSubmit = await s.createRun({
       systemPrompt: ${JSON.stringify(CREATE_SYSTEM)}, userMessage: ${JSON.stringify(userMessage)} });
     const after = (s.operations.pending ?? []).map(p => p.operationId);
     return JSON.stringify({ okSubmit, errorCode: s.createRunErrorCode, before, after });`,
  );
async function hookAnswerClock() {
  await evB(
    `(() => { window.__q67 = [];
      if (window.__q67hooked === true) return 'already';
      window.__q67hooked = true;
      window.api.onDraftCloseQuery((q) => window.__q67.push({ requestId: q.requestId, t: Date.now() }));
      return 'hooked'; })()`,
  );
}
const answerLog = async () =>
  JSON.parse(String(await evB("JSON.stringify(window.__q67 || [])")));

// ---------------------------------------------------------------------------
// 草稿与对话框（真 UI 路径）
// ---------------------------------------------------------------------------

const CREATE_DIALOG = 'dialog[aria-label="新建运行"]';
// 两个 textarea 各在独立 <label> 里 ⇒ nth-of-type 命不中，按 placeholder 认 User Message
const CREATE_TEXTAREA = `${CREATE_DIALOG} textarea[placeholder^="要交给模型的任务"]`;
async function openCreateDialog(initial) {
  await H.clickByText(call, "新建运行", 1200);
  const got = await H.typeIntoDom(call, CREATE_TEXTAREA, initial);
  const d = await createDraftTexts();
  return { value: got.value, draft: d };
}
/** 起一次真在飞执行（受控服务延迟回合撑开窗口），并等它确实 running */
async function startFlight(epoch, mock) {
  const id = freshId();
  const servedBefore = mock.served();
  fireCreate(epoch, id, `${TASK_MARK} 在飞的那一次 ${rand()}`).catch(() => {});
  const r = await waitRunning(id);
  const reachedModel = await waitServedAtLeast(mock, servedBefore + 1, 15_000);
  // 在飞那次的 run 文件在**运行开始**时就落盘 ⇒ 以"出门之后"的这份集合为基准，
  // 后续任何判据只比"有没有比基准又多出文件"（6.6 同口径：绝对份数会因夹具漂移）。
  const filesAtFlight = new Set(H.traceIds());
  return {
    id,
    rec: r.rec,
    servedBefore,
    filesAtFlight,
    filesBefore: filesAtFlight.size,
    reachedModel,
  };
}
async function waitServedAtLeast(mock, target, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (mock.served() >= target) return true;
    if (Date.now() > deadline) return false;
    await H.sleep(200);
  }
}
/** 合并文案分类：只按 §5 `buildCloseConfirmText` 的 message 档位判 */
function classifyClose(dialog) {
  const t = String(dialog?.texts ?? "");
  return {
    active: t.includes("有操作正在执行"),
    draftDirty: t.includes("有未放弃的调试草稿"),
    unknownDraft: t.includes("暂时无法确认草稿状态"),
    configBusy: t.includes("有一次配置变更尚未完成"),
    mergedDirtyActive: t.includes("有未放弃的调试草稿，且有操作正在执行"),
    mergedUnknownActive: t.includes("暂时无法确认草稿状态，且有操作正在执行"),
    quitLabelDiscard: t.includes("退出并丢弃草稿"),
    mentionsActiveNote: t.includes("已登记的主动操作尚未结束"),
  };
}
/** 每次询问都落一条 dump（文案档位的原始证据，README 直接引用） */
async function noteDialog(label, dialog) {
  const c = dialog === null ? null : classifyClose(dialog);
  dump.dialogs.push({
    at: label,
    hwnd: dialog?.hwnd ?? null,
    buttons: dialog?.buttons ?? null,
    texts: dialog?.texts ?? null,
    kinds: c,
  });
  return c;
}

// ---------------------------------------------------------------------------
// tag: clean-running —— 无草稿 + main 占槽 ⇒ 仍弹一次确认（§5 的正主）
// ---------------------------------------------------------------------------
async function tagCleanRunning(mock, fx) {
  void fx;
  const s0 = await mainStatus();
  check("起点：epoch 在场且槽空闲", s0.epoch !== null && s0.slot === null, {
    epoch: s0.epoch,
    slot: s0.slot,
  });
  check("起点：无草稿（本次确认只由 main 事实触发）", (await createDraftTexts()) === null);

  const flight = await startFlight(s0.epoch, mock);
  check(
    "在飞是真在飞：登记 running + 占槽 + 请求已出门",
    flight.rec?.state === "running" && flight.id !== null && flight.reachedModel === true,
    { state: flight.rec?.state, slot: flight.id, served: mock.served() },
  );

  await winops("restore");
  await winops("close-titlebar");
  const dlg = await waitDialog();
  const kinds = await noteDialog("clean-running 第一次询问", dlg);
  check(
    "无草稿但 main 占槽 ⇒ 仍弹一次确认（文案档 = 有操作正在执行）",
    dlg !== null && kinds.active === true && kinds.draftDirty === false && kinds.configBusy === false,
    { kinds, texts: dlg?.texts?.slice(0, 200) },
  );
  check(
    "确认文案不诊断 renderer 存活、不宣称已取消（措辞纪律：只说不会取消/不会标已取消）",
    dlg !== null &&
      !dlg.texts.includes("已崩溃") &&
      !dlg.texts.includes("失联") &&
      !dlg.texts.includes("无响应") &&
      dlg.texts.includes("退出不会取消上游请求") &&
      dlg.texts.includes("操作记录同样不会标记为已取消"),
    dlg?.texts?.slice(0, 240),
  );
  const shot = await captureScreen(`67-${TAG}-dialog`);
  dump.screens.push({ at: "clean-running", file: typeof shot });

  const mid = await mainStatus();
  check(
    "询问期间 main 的 closing 标记在场（第二个入口被拒是 main 事实）",
    mid.closing === true && mid.slot === flight.id,
    { closing: mid.closing, slot: mid.slot },
  );
  const secondId = freshId();
  const second = await bridgeCreate(mid.epoch, secondId, `${TASK_MARK} 询问期间的第二入口 ${rand()}`);
  const secondRec = (await recordOf(secondId)).rec;
  check(
    "询问期间第二主动入口被 main 拒 ⇒ OPERATION_NOT_ACCEPTED 且登记 notAccepted",
    second.ok === false &&
      second.error?.code === "OPERATION_NOT_ACCEPTED" &&
      secondRec?.state === "notAccepted",
    { code: second.error?.code, state: secondRec?.state, rejection: secondRec?.rejection },
  );
  check(
    "被拒的那条零副作用：零模型请求、零新增文件（基准=在飞那次出门后的份数）",
    mock.served() === flight.servedBefore + 1 && H.traceIds().size === flight.filesBefore,
    { served: mock.served(), files: H.traceIds().size, baseline: flight.filesBefore },
  );

  const settingsBefore = H.existsSync(H.SETTINGS_FILE)
    ? H.readFileSync(H.SETTINGS_FILE)
    : null;
  const cfgWrite = await H.apiCall(call, "saveSettings", {
    baseURL: H.MOCK_BASE,
    apiKey: `${TASK_MARK}-should-not-be-written-${rand()}`,
    model: "mock-model",
  });
  const settingsAfter = H.existsSync(H.SETTINGS_FILE)
    ? H.readFileSync(H.SETTINGS_FILE)
    : null;
  check(
    "询问期间配置写被 main 拒（closing），且配置文件逐字节未变",
    cfgWrite.ok === false &&
      settingsBefore !== null &&
      settingsAfter !== null &&
      settingsBefore.equals(settingsAfter),
    { code: cfgWrite.error?.code, changed: !settingsBefore?.equals(settingsAfter ?? null) },
  );
  const cfgRead = await H.apiCall(call, "getSettings");
  check(
    "配置读不受锁影响（读取类通道照常可用）",
    cfgRead.ok === true && typeof cfgRead.data === "object",
    { ok: cfgRead.ok, hasKey: cfgRead.data?.hasKey },
  );

  // 在飞那次是从**真桥接面**（fireCreate）出的，renderer 没经手 ⇒ 它的 operations 会话
  // 不会自动知道槽被占（status 是 pull-only，轮询只在"界面已知有活跃操作"时才武装）。
  // 显式刷一次 status（等价于用户打开操作面板），让界面按 main 事实采纳那个在飞槽。
  const countBeforeAdopt = (await mainStatus()).count;
  await H.storeQ(
    call,
    "await s.refreshOperationStatus(); return JSON.stringify({ done: true });",
  );
  const gate = await entryGate().catch(() => null);
  check(
    "界面采纳 main 事实后拒绝新提交（询问在场 ⇒ blockedBy=closing，文案「应用正在退出」）",
    gate?.canSubmit === false && gate?.blockedBy === "closing",
    gate,
  );
  const attempt = await storeCreateAttempt(`${TASK_MARK} 锁内的真提交尝试 ${rand()}`);
  check(
    "门禁采纳后真 UI 提交在发出前就被本地拒（未新增任何登记）",
    attempt.after.length === 0 &&
      (await mainStatus()).count === countBeforeAdopt &&
      attempt.okSubmit === false,
    { attempt, countBeforeAdopt, countNow: (await mainStatus()).count },
  );

  const drained = await drainDialogs(0);
  check(
    "确认可取消（点击-核对-重试排空，hwnd 轨迹留证）",
    drained.clean && drained.rounds.length >= 1,
    drained.rounds.map((r) => ({ h: r.hwnd, after: r.after })),
  );
  const after = await mainStatus();
  check(
    "返回解除 closing 但**不释放执行槽**：那条仍 running、槽仍指向它",
    after.closing === false && after.slot === flight.id,
    { closing: after.closing, slot: after.slot },
  );
  const stillFlight = (await recordOf(flight.id)).rec;
  check(
    "返回不删登记、不把活跃操作记成已取消",
    stillFlight?.state === "running" &&
      String(JSON.stringify(stillFlight)).includes("cancel") === false,
    stillFlight,
  );
  const unlocked = await overlayPresent();
  check("返回解除输入锁", unlocked === false, unlocked);

  const settled = await waitMainSettled(flight.id, 120_000);
  check(
    "在飞那次照常收口（settled + 恰一个可信 runId + 恰一次模型请求）",
    settled.rec?.state === "settled" &&
      settled.rec?.runIds?.length === 1 &&
      mock.served() === flight.servedBefore + 1,
    { state: settled.rec?.state, runIds: settled.rec?.runIds, served: mock.served() },
  );
  const banAgain = await bridgeCreate(settled.snap.epoch, secondId, `${TASK_MARK} 复活被封禁的身份 ${rand()}`);
  check(
    "notAccepted 永不复活：稍后用同一身份再提仍被拒、仍是 notAccepted",
    banAgain.ok === false &&
      banAgain.error?.code === "OPERATION_NOT_ACCEPTED" &&
      (await recordOf(secondId)).rec?.state === "notAccepted",
    { code: banAgain.error?.code, state: (await recordOf(secondId)).rec?.state },
  );
  // 这条在飞是从桥接面外带发起的（renderer 没经手 ⇒ 未武装本地轮询），界面只会按用户
  // 明确动作刷新 ⇒ 打开面板前显式刷一次（等价用户点开），读出 main 的真实终态。
  await H.storeQ(
    call,
    "await s.refreshOperationStatus(); return JSON.stringify({ done: true });",
  );
  const rows = await panelRows();
  check(
    "界面上那条已收口（带可信 runId）+ 被拒那条以「未接受」在场（面板逐条读数）",
    rows.some(
      (r) =>
        r.includes(flight.id) &&
        r.includes("已收口") &&
        r.includes(String(settled.rec?.runIds?.[0] ?? "")),
    ) && rows.some((r) => r.includes(secondId) && r.includes("未接受")),
    { rows },
  );
  check(
    "整场只执行一次（返回与重放尝试都没多问服务、没多写文件）",
    mock.served() === flight.servedBefore + 1 && H.traceIds().size === flight.filesBefore + 1,
    { served: mock.served(), files: H.traceIds().size },
  );
  await H.shot(call, SHOT_DIR, `67-${TAG}.png`).catch(() => {});
  return { flightId: flight.id, secondId, served: mock.served() };
}

/** 界面采纳 main 的当前快照（等价用户点开操作面板）：桥接面外带发起的操作不会被本地轮询自动推进 */
async function adoptNow() {
  await H.storeQ(
    call,
    "await s.refreshOperationStatus(); return JSON.stringify({ done: true });",
  );
  return view();
}
async function panelRows() {
  const expanded = await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
       if (b === null) return 'no-button';
       return b.getAttribute('aria-expanded'); })()`,
  );
  if (expanded !== "true") {
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
        if (b) b.click(); return true; })()`,
    );
    await H.sleep(900);
  }
  const raw = await H.ev(
    call,
    `(() => JSON.stringify(Array.from(document.querySelectorAll('#operations-panel > ul > li'))
      .map(x => (x.textContent||'').trim())))()`,
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// tag: altf4-dirty —— Alt+F4 × dirty+running：合并文案 + 真键盘不重放
// ---------------------------------------------------------------------------
async function tagAltF4Dirty(mock, fx) {
  const s0 = await mainStatus();
  const flight = await startFlight(s0.epoch, mock);
  check("在飞执行已登记为 running", flight.rec?.state === "running", flight.rec?.state);

  const initial = `${TASK_MARK} 锁前已接收的文字 ${rand()}`;
  const opened = await openCreateDialog(initial);
  const draft0 = await createDraftTexts();
  check(
    "dirty 侧是真草稿：新建运行对话框的输入已进 store",
    draft0 !== null && String(draft0.userMessage).includes(initial),
    { opened: opened.draft !== null, draft: draft0 },
  );

  await hookAnswerClock();
  await winops("altf4");
  const dlg = await waitDialog();
  const kinds = await noteDialog("altf4-dirty 第一次询问", dlg);
  check(
    "Alt+F4 与标题栏走同一条协商 ⇒ 草稿与活跃操作**合并成一次**文案",
    dlg !== null && kinds.mergedDirtyActive === true,
    { kinds, texts: dlg?.texts?.slice(0, 240) },
  );
  check(
    "dirty 档的退出按钮明确写「退出并丢弃草稿」",
    String(dlg?.buttons ?? "").includes("退出并丢弃草稿"),
    dlg?.buttons,
  );
  await captureScreen(`67-${TAG}-dialog`).then((f) => dump.screens.push({ at: "altf4-dirty", file: typeof f }));

  const locked = await overlayPresent();
  check("询问在场时输入锁生效（遮罩渲染）", locked === true, locked);
  // 先把焦点显式给到 User Message（focus 不是输入锁拦的事件），再打真键盘 ⇒
  // 判据证明的是"锁挡住了键入"，而不是"恰好没聚焦"。
  await evB(
    `(() => { const t = document.querySelector(${JSON.stringify(CREATE_TEXTAREA)});
      if (t) t.focus(); return true; })()`,
  );
  const domValue0 = await evB(
    `(() => { const t = document.querySelector(${JSON.stringify(CREATE_TEXTAREA)});
      return t === null ? null : t.value; })()`,
  );
  const countBeforeClick = (await mainStatus()).count;
  const clickHit = await realClickDialogButton("创建");
  await H.sleep(800);
  const draft1 = await createDraftTexts();
  const domValue = await evB(
    `(() => { const t = document.querySelector(${JSON.stringify(CREATE_TEXTAREA)});
      return t === null ? null : t.value; })()`,
  );
  const st1 = await H.execState(call);
  const countAfterClick = (await mainStatus()).count;
  check(
    "锁内真键盘被挡且**不重放**：解锁前表单里没有锁内那几个字",
    draft1 !== null &&
      draft1.userMessage === draft0.userMessage &&
      String(domValue ?? "") === String(domValue0 ?? "") &&
      String(domValue ?? "").includes("锁内键入") === false,
    { domValue: String(domValue ?? "").slice(0, 120) },
  );
  check(
    "锁内真鼠标点击不触发提交（新建运行对话框在 top layer ⇒ 由捕获阶段拦，而非遮罩命中）",
    clickHit === "clicked" &&
      st1.creating !== "in_progress" &&
      countAfterClick === countBeforeClick,
    { clickHit, creating: st1.creating, countBeforeClick, countAfterClick },
  );
  const q1 = await answerLog();
  check(
    "输入锁期间表单未被改写（草稿修订不变）",
    draft1.revision === draft0.revision && q1.length >= 1,
    { rev0: draft0.revision, rev1: draft1.revision, queries: q1.length },
  );

  await H.storeQ(
    call,
    "await s.refreshOperationStatus(); return JSON.stringify({ done: true });",
  );
  const gate = await entryGate().catch(() => null);
  check("门禁采纳在飞槽后拒绝新提交", gate?.canSubmit === false, gate);

  const drained = await drainDialogs(0);
  check(
    "返回可取消（合并文案只问一次，排空后无残留框）",
    drained.clean && drained.rounds.length >= 1,
    drained.rounds.map((r) => ({ h: r.hwnd, after: r.after })),
  );
  const q2 = await answerLog();
  const unlocked = await overlayPresent();
  check(
    "迟到/排队应答不会二次弹框（本次协商只发起过一次查询）",
    q2.length === q1.length && unlocked === false,
    { before: q1.length, after: q2.length, unlocked },
  );
  const draft2 = await createDraftTexts();
  check(
    "退出输入锁保留已接收文字（往返后草稿逐字未变）",
    draft2 !== null && draft2.userMessage === draft0.userMessage,
    { kept: draft2?.userMessage?.slice(0, 80) },
  );
  const after = await mainStatus();
  check("返回后槽仍未释放（那条还在跑）", after.slot === flight.id, {
    slot: after.slot,
    flight: flight.id,
  });
  const settled = await waitMainSettled(flight.id, 120_000);
  check("在飞那次照常收口", settled.rec?.state === "settled", settled.rec?.state);

  const discard = await discardCreateDraft(initial);
  check("草稿可放弃（回到 clean 侧）", discard.clean === true, discard);
  const pidOfMain = MAIN_PID;
  await winops("close-titlebar");
  await H.sleep(3000);
  const dialogs = await dialogCount();
  check("草稿已放弃 + 操作已收口 ⇒ clean 直退零询问", dialogs === 0, `dialogs=${dialogs}`);
  const gone = await waitWindowGone();
  check(
    "窗口真实结束",
    gone.window === "absent" || String(gone.window).includes("iswindow=False"),
    gone,
  );
  const pidGone = await waitPidGone(pidOfMain);
  check("进程真实结束", pidGone.gone === true, pidGone);
  return { flightId: flight.id, initial, served: mock.served() };
}
async function discardCreateDraft() {
  const r = await evB(
    `(() => { const dlg = document.querySelector(${JSON.stringify(CREATE_DIALOG)});
      if (!dlg) return JSON.stringify({ error: 'no-dialog' });
      const b = Array.from(dlg.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '放弃填写内容');
      if (!b) return JSON.stringify({ error: 'no-discard' });
      b.click(); return JSON.stringify({ clicked: true }); })()`,
  );
  await H.sleep(700);
  const confirm = await evB(
    `(() => { const dlgs = Array.from(document.querySelectorAll('dialog[open]'));
      const last = dlgs[dlgs.length - 1];
      if (!last) return JSON.stringify({ error: 'no-confirm' });
      const b = Array.from(last.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()).includes('确认'));
      if (!b) return JSON.stringify({ error: 'no-confirm-button', text: (last.innerText||'').slice(0,80) });
      b.click(); return JSON.stringify({ clicked: true }); })()`,
  );
  await H.sleep(900);
  const d = await createDraftTexts();
  // 放弃后 create 草稿条目可能仍在但正文清空（dirtyCount 归零即达 clean 口径）
  const clean = d === null || String(d.userMessage ?? "").trim() === "";
  return { clean, draft: d, first: JSON.parse(r), confirm: JSON.parse(confirm) };
}

// ---------------------------------------------------------------------------
// tag: frozen-unknown —— 冻结 renderer：unknown × 活跃操作的合并档 + 不重入
// ---------------------------------------------------------------------------
async function tagFrozenUnknown(mock, fx) {
  void fx;
  const s0 = await mainStatus();
  const flight = await startFlight(s0.epoch, mock);
  const initial = `${TASK_MARK} 冻结前的草稿 ${rand()}`;
  await openCreateDialog(initial);
  await hookAnswerClock();

  const tFire = freezeFire(4000);
  await winops("close-titlebar");
  const dlg = await waitDialog(25000);
  const kinds = await noteDialog("frozen-unknown 第一次询问", dlg);
  check(
    "应答超阈 + main 占槽 ⇒ 合并成**一次** unknown×活跃文案（不是两层框）",
    dlg !== null && kinds.mergedUnknownActive === true,
    { kinds, texts: dlg?.texts?.slice(0, 240) },
  );
  check(
    "超时提示不诊断存活、不宣称草稿已丢失",
    dlg !== null && !dlg.texts.includes("已崩溃") && !dlg.texts.includes("丢失"),
    dlg?.texts?.slice(0, 240),
  );
  check(
    "unknown 档的退出按钮只说「退出」（不冒充「丢弃草稿」）",
    dlg !== null &&
      String(dlg.buttons).includes("退出") &&
      String(dlg.buttons).includes("丢弃") === false,
    dlg?.buttons,
  );
  await captureScreen(`67-${TAG}-dialog`).then((f) => dump.screens.push({ at: "frozen-unknown", file: typeof f }));

  await winops("close-titlebar");
  await winops("close-titlebar");
  const samples = [];
  for (let i = 0; i < 6; i++) {
    samples.push(await dialogCount());
    await H.sleep(500);
  }
  check(
    "无应答期间连发关闭仍至多一层（不重入、不叠加确认）",
    Math.max(...samples) === 1,
    samples,
  );
  const mid = await mainStatus();
  check("冻结期间 closing 仍守得住（询问未结束 ⇒ 第二个入口被拒）", mid.closing === true, {
    closing: mid.closing,
    slot: mid.slot,
  });

  const unf = await waitUnfrozen();
  check("冻结结束后渲染层恢复", unf.ok === true, unf);
  const q = await answerLog();
  const tQ = q[0]?.t ?? null;
  check(
    "应答确实迟到（查询处理时刻距关闭发起 > 1.5s 阈值 ⇒ 降级不是提前放行）",
    typeof tQ === "number" && tQ - tFire > 1500,
    { tQ, tFire, delta: tQ === null ? null : tQ - tFire },
  );
  const drained = await drainDialogs(0);
  check(
    "降级确认可取消（点击-核对-重试排空）",
    drained.clean && drained.rounds.length >= 1,
    drained.rounds.map((r) => ({ h: r.hwnd, after: r.after })),
  );
  await H.sleep(3000);
  const late = await windowAlive();
  const draftLate = await createDraftTexts();
  check(
    "迟到应答零后续效果（不弹新框、不关窗、草稿原样）",
    late.alive === true &&
      late.dialogs === 0 &&
      draftLate !== null &&
      String(draftLate.userMessage).includes(initial),
    { late, draft: draftLate?.userMessage?.slice(0, 80) },
  );
  const settled = await waitMainSettled(flight.id, 120_000);
  check(
    "被打断的核对不影响在飞执行收口",
    settled.rec?.state === "settled" && mock.served() === flight.servedBefore + 1,
    { state: settled.rec?.state, served: mock.served() },
  );
  const discard = await discardCreateDraft(initial);
  check("草稿放弃后回到 clean", discard.clean === true, discard);
  const pidOfMain = MAIN_PID;
  await winops("close-titlebar");
  await H.sleep(3000);
  const dialogs = await dialogCount();
  check("冻结风波后 clean 直退零询问", dialogs === 0, `dialogs=${dialogs}`);
  const gone = await waitWindowGone();
  check("窗口真实结束", gone.window === "absent", gone);
  const pidGone = await waitPidGone(pidOfMain);
  check("进程真实结束", pidGone.gone === true, pidGone);
  return { flightId: flight.id, tFire, tQ, samples };
}

// ---------------------------------------------------------------------------
// tag: quit-return —— 哨兵文件 ⇒ 真 app.quit() × 在飞 + dirty ⇒ 返回不退出
// ---------------------------------------------------------------------------
async function tagQuitReturn(mock, fx) {
  void fx;
  const s0 = await mainStatus();
  const initial = `${TASK_MARK} quit 往返保留 ${rand()}`;
  await openCreateDialog(initial);
  const flight = await startFlight(s0.epoch, mock);
  check("哨兵触发前：既有在飞执行 running", flight.rec?.state === "running", flight.rec?.state);

  writeFileSync(QUIT_FLAG, "quit\n");
  const dlg = await waitDialog(25000);
  const kinds = await noteDialog("quit-return 第一次询问", dlg);
  check(
    "app.quit 与标题栏关闭走同一条协商 ⇒ 一次合并确认（dirty × 活跃）",
    dlg !== null && kinds.mergedDirtyActive === true,
    { kinds, texts: dlg?.texts?.slice(0, 240) },
  );
  await captureScreen(`67-${TAG}-dialog`).then((f) => dump.screens.push({ at: "quit-return", file: typeof f }));
  check(
    "哨兵文件已被消费（一次 quit 只发起一次协商）",
    existsSync(QUIT_FLAG) === false,
    { still: existsSync(QUIT_FLAG) },
  );

  const drained = await drainDialogs(0);
  check("quit 协商可返回", drained.clean && drained.rounds.length >= 1, drained.rounds);
  const alive = await windowAlive();
  check(
    "用户选择返回 ⇒ 退出被阻止（窗口仍在、无残留框）",
    alive.alive === true && alive.dialogs === 0,
    alive,
  );
  const after = await mainStatus();
  check(
    "返回后 main 仍可服务（登记读得到、closing 已解除、槽未释放）",
    after.epoch === s0.epoch && after.closing === false && after.slot === flight.id,
    { closing: after.closing, slot: after.slot },
  );
  const draft = await createDraftTexts();
  check(
    "取消退出后草稿逐字保留且可继续编辑",
    draft !== null && String(draft.userMessage).includes(initial),
    draft?.userMessage?.slice(0, 80),
  );
  await H.storeQ(
    call,
    "await s.refreshOperationStatus(); return JSON.stringify({ done: true });",
  );
  const gate = await entryGate().catch(() => null);
  check(
    "取消退出后门禁仍按 main 的在飞槽判定（采纳后 blockedBy=operation_running）",
    gate?.canSubmit === false && gate?.blockedBy === "operation_running",
    gate,
  );
  const settled = await waitMainSettled(flight.id, 120_000);
  check(
    "在飞那次照常收口（返回不打断执行、也不重放）",
    settled.rec?.state === "settled" && mock.served() === flight.servedBefore + 1,
    { state: settled.rec?.state, served: mock.served() },
  );
  const discard = await discardCreateDraft();
  check("放弃填写内容 + 确认 ⇒ 草稿回到 clean（取消退出后再核对）", discard.clean === true, discard);
  const pidOfMain = MAIN_PID;
  writeFileSync(QUIT_FLAG, "quit-again\n");
  await H.sleep(4000);
  const dialogs = await dialogCount();
  const gone = await waitWindowGone();
  const pidGone = await waitPidGone(pidOfMain);
  check(
    "草稿已放弃 + 无活跃操作 ⇒ 再次 quit 直接退出（零询问）",
    dialogs === 0 &&
      (gone.window === "absent" || String(gone.window).includes("iswindow=False")) &&
      pidGone.gone === true,
    { dialogs, gone, pidGone },
  );
  return { flightId: flight.id, initial, served: mock.served() };
}

// ---------------------------------------------------------------------------
// tag: quit-executing —— 确认退出 × 操作仍在飞：进程真结束，且不谎称结局
// ---------------------------------------------------------------------------
async function tagQuitExecuting(mock, fx) {
  void fx;
  const s0 = await mainStatus();
  const flight = await startFlight(s0.epoch, mock);
  check("退出前：那条执行确实 running", flight.rec?.state === "running", flight.rec?.state);
  const idsBefore = new Set(H.traceIds());

  writeFileSync(QUIT_FLAG, "quit-exec\n");
  const dlg = await waitDialog(25000);
  const kinds = await noteDialog("quit-executing 询问", dlg);
  check(
    "clean + 活跃操作 ⇒ 仍弹一次确认，退出按钮是「退出」（无草稿可丢弃）",
    dlg !== null && kinds.active === true && kinds.draftDirty === false,
    { kinds, buttons: dlg?.buttons, texts: dlg?.texts?.slice(0, 200) },
  );
  const qi = quitButtonIndex(dlg);
  check("退出按钮可定位（下标 > 0 ⇒ 「返回」在 0）", qi > 0, { qi, buttons: dlg?.buttons });
  await captureScreen(`67-${TAG}-dialog`).then((f) => dump.screens.push({ at: "quit-executing", file: typeof f }));

  const pidOfMain = MAIN_PID;
  const clicked = await winops("dialog-click", ["-Index", String(qi)]);
  dump.quitClick = parseLines(clicked.lines).RESULT ?? clicked.err ?? null;
  const gone = await waitWindowGone();
  check(
    "确认退出 ⇒ 窗口真实结束",
    gone.window === "absent" || String(gone.window ?? "").includes("iswindow=False"),
    gone,
  );
  const pidGone = await waitPidGone(pidOfMain);
  check("进程真实结束（不是只关窗口）", pidGone.gone === true, pidGone);

  await H.sleep(3000);
  const newFiles = [...H.traceIds()].filter((x) => !idsBefore.has(x)).sort();
  const hashesNow = H.hashAllTraces();
  check(
    "退出不会把在飞那次伪装成已完成：它只留下自己那一份未完成文件",
    newFiles.length <= 1,
    { newFiles, files: H.traceIds().size },
  );
  check(
    "退出后既有历史逐字节不变（不回填终态、不认领被打断那次）",
    Object.entries(hashesNow).every(([n, v]) => n.endsWith(".jsonl") && typeof v === "string") &&
      newFiles.every((id) => H.existsSync(join(H.TRACES, `${id}.jsonl`))),
    { newFiles },
  );
  const leftover = await dialogCount();
  const leftoverInfo = leftover > 0 ? await dialogInfo() : null;
  check(
    "退场路径没有残留询问框（主进程 Error 框会计入 dialogs ⇒ 一并核对文案）",
    leftover === 0 || String(leftoverInfo?.texts ?? "").includes(TASK_MARK) === false,
    { leftover, texts: leftoverInfo?.texts?.slice(0, 160) },
  );
  dump.servedAtExit = mock.served();
  check(
    "被打断那次的请求确实只出过一次门（退出未重放）",
    mock.served() === flight.servedBefore + 1,
    { served: mock.served(), servedBefore: flight.servedBefore },
  );
  return { flightId: flight.id, newFiles, served: mock.served() };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const SCRIPTS = {
  "clean-running": {
    turns: [{ content: `${TASK_MARK} clean-running 在飞`, delayMs: FLIGHT_MS }],
    fallback: { content: "兜底" },
  },
  "altf4-dirty": {
    turns: [{ content: `${TASK_MARK} altf4-dirty 在飞`, delayMs: FLIGHT_MS }],
    fallback: { content: "兜底" },
  },
  "frozen-unknown": {
    turns: [{ content: `${TASK_MARK} frozen-unknown 在飞`, delayMs: FLIGHT_MS }],
    fallback: { content: "兜底" },
  },
  "quit-return": {
    turns: [{ content: `${TASK_MARK} quit-return 在飞`, delayMs: 20_000 }],
    fallback: { content: "兜底" },
  },
  "quit-executing": {
    turns: [{ content: `${TASK_MARK} quit-executing 在飞`, delayMs: FLIGHT_MS }],
    fallback: { content: "兜底" },
  },
};

async function main() {
  if (!H.existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
  const fx = JSON.parse(readFileSync(MANIFEST, "utf8"));
  try {
    if (existsSync(QUIT_FLAG)) rmSync(QUIT_FLAG);
  } catch {
    /* 并发触发 */
  }
  const page = await H.cdpConnect(H.CDP_PORT);
  if (!page?.webSocketDebuggerUrl) throw new Error("CDP 9612 上没有页面（dev 未起？）");
  call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  H.attachDialogHandler(call, pageDialogs);
  await winops("restore");
  const resolved = await resolveMainPid();
  check("已唯一认定本仓库 dev 主进程 PID", resolved.pid > 0, resolved.info);

  const ready = await waitForReady();
  check("运行列表就绪（夹具在场）", ready > 0, ready);

  const mock = await H.prepare(call, SCRIPTS[TAG]);
  const scenarios = {
    "clean-running": () => tagCleanRunning(mock, fx),
    "altf4-dirty": () => tagAltF4Dirty(mock, fx),
    "frozen-unknown": () => tagFrozenUnknown(mock, fx),
    "quit-return": () => tagQuitReturn(mock, fx),
    "quit-executing": () => tagQuitExecuting(mock, fx),
  };
  let out = null;
  let failure = null;
  try {
    out = await scenarios[TAG]();
  } catch (e) {
    failure = String(e?.stack ?? e);
    check("场景未抛异常", false, failure.slice(0, 400));
  }
  dump.result = out ?? null;
  dump.failure = failure;
  dump.pageDialogs = pageDialogs.slice(0, 10);
  if (failure !== null) writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), failure);
  // teardown 里的 CDP 调用无界（走真 apiCall）：clean 直退类 tag 跑完时应用可能已真退出 ⇒
  // 不套超时就会把整个进程挂到看门狗。race 一道超时，收尾必达。
  await Promise.race([
    H.teardown(call, mock).catch(() => {}),
    H.sleep(20_000).then(() => {
      console.log("[收尾] teardown 20s 未回（应用多已真退出）⇒ 跳过页内复位，继续关服务");
    }),
  ]);
  try {
    await mock.close().catch?.(() => {});
  } catch {
    /* 受控服务尽力关 */
  }
  finish();
}
async function waitForReady(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let prev = -1;
  for (;;) {
    await H.sleep(700);
    let n = 0;
    try {
      n = (await H.runs(call)).length;
    } catch {
      n = -1;
    }
    if (n > 0 && n === prev) return n;
    prev = n;
    if (Date.now() > deadline) return 0;
  }
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
