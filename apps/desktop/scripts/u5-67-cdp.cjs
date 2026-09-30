/* eslint-disable */
/**
 * U5 任务 6.7（第六批受控实机）：设置保存/清除/未保存退出/合并窗口退出 + 密钥不回读证据。
 *
 * 覆盖 evidence-index「实机入口 = 6.7」各计划 tag（沿用同名 tag，§7.3 才对得上账）：
 * editor-settings-roundtrip / settings-roundtrip-confirm / settings-close-dirty / key-one-way /
 * save-fail-shapes / clear-confirm / recording-entry / esc-topmost / quit-executing / quit-return。
 *
 * 判据口径：
 * - 设置对话框的输入/按钮全部按真实 DOM 逐控件定位（React 受控 input 用原生 setter + input 事件）；
 * - 「未保存关闭三路同源」= ✕ / 底部关闭 / Esc 三条路都过 requestConfirm 真模态（A6.3 + M6.2）；
 * - 「密钥不回读」= 磁盘 settings.json（apiKeyEncrypted 标记分流）× 回读键集（无 apiKey）双面取证；
 * - 「保存失败 / 回读失败」：save-failed 用 main 的"apiKey 不能为空"校验自然诱发（零注入）；
 *   reread-failed 用竞速注入（保存落盘瞬间改写 settings.json 缺 apiKey ⇒ load() 抛"内容不完整"），
 *   诱不出来按单元承载登记（tasks 6.5 注记的预设口径）；
 * - quit-executing / quit-return 走 U4 6.7 的 winops 通道（原生 #32770 不在网页里，CDP 看不见），
 *   quit 哨兵 = dev 启动时注入的 REBASEAGENT_SMOKE_QUIT_FILE（验收钩子，不是新增 quit IPC）。
 *
 * 用法：`node apps/desktop/scripts/u5-67-cdp.cjs --tag=<TAG>`；前置 dev 由 run-all 起
 *（dev 必须带 REBASEAGENT_SMOKE_QUIT_FILE，quit-* tag 才有真 app.quit 入口）。
 */
"use strict";
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = [
  "editor-settings-roundtrip",
  "settings-roundtrip-confirm",
  "settings-close-dirty",
  "key-one-way",
  "save-fail-shapes",
  "clear-confirm",
  "recording-entry",
  "esc-topmost",
  "quit-return",
  "quit-executing",
];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u5", "u5-67");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-29-u5-67");
const MARK = "U5-67";
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const PID_FILE = join(H.REPO, ".workbuddy", "u2-5-dev.pid");
const DEV_HOST = join(H.REPO, "apps", "desktop", "scripts", "u2-dev-host.cjs");
const PS1 = join(H.REPO, "apps", "desktop", "scripts", "lib", "u3-64-winops.ps1");
const QUIT_FLAG = join(OUT_DIR, "quit.flag");
/** 在飞回合的延迟：必须长过整场协商（45s），否则槽自己释放 ⇒ 判据空转 */
const FLIGHT_MS = 45_000;
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
if (!existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
const FX = JSON.parse(readFileSync(MANIFEST, "utf8"));

const OK_TURN = { content: `${MARK} 受控成功：一步答完。`, usage: { in: 120, out: 40 } };

/** 各 tag 的受控剧本。零执行 tag 用 notConsumed 形状（任何一次消费都会留下 418 ⇒ 判据响亮地红） */
const NOT_CONSUMED = {
  turns: [{ mode: "fail", status: 418, content: `${MARK} 这个 tag 不该有任何模型调用` }],
};
const TAG_SCRIPT = {
  "editor-settings-roundtrip": NOT_CONSUMED,
  "settings-roundtrip-confirm": NOT_CONSUMED,
  "settings-close-dirty": NOT_CONSUMED,
  "key-one-way": NOT_CONSUMED,
  "save-fail-shapes": NOT_CONSUMED,
  "clear-confirm": {
    turns: [{ content: `${MARK} clear-confirm 慢响应：占槽窗口。`, delayMs: 8000 }],
    fallback: OK_TURN,
  },
  "recording-entry": NOT_CONSUMED,
  "esc-topmost": NOT_CONSUMED,
  "quit-return": {
    turns: [{ content: `${MARK} quit-return 在飞`, delayMs: FLIGHT_MS }],
    fallback: OK_TURN,
  },
  "quit-executing": {
    turns: [{ content: `${MARK} quit-executing 在飞`, delayMs: FLIGHT_MS }],
    fallback: OK_TURN,
  },
};

const EXPECTED_CALLS = {
  "editor-settings-roundtrip": 0,
  "settings-roundtrip-confirm": 0,
  "settings-close-dirty": 0,
  "key-one-way": 0,
  "save-fail-shapes": 0,
  "clear-confirm": 1,
  "recording-entry": 0,
  "esc-topmost": 0,
  "quit-return": 1,
  "quit-executing": 1,
};

// ---------------------------------------------------------------------------
// 检查与落盘
// ---------------------------------------------------------------------------

const checks = [];
const dump = {};
/** 当前 CDP 会话持有者：退出类 tag 杀掉应用后 teardown 用它做有界兜底 */
const SESSION = { call: null };
function check(name, ok, detail) {
  checks.push({ tag: TAG, name, ok: ok === true, detail: detail ?? null });
  const shown =
    detail === undefined || detail === null
      ? ""
      : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : shown}`);
}
function sha12(file) {
  try {
    return require("node:crypto")
      .createHash("sha256")
      .update(readFileSync(file))
      .digest("hex")
      .slice(0, 12);
  } catch {
    return "unknown";
  }
}
function headShort() {
  try {
    const head = readFileSync(join(H.REPO, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: (.+)$/);
    if (m) {
      const refFile = join(H.REPO, ".git", ...m[1].split("/"));
      if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim().slice(0, 7);
      const packed = readFileSync(join(H.REPO, ".git", "packed-refs"), "utf8");
      const line = packed.split(/\r?\n/).find((l) => l.endsWith(` ${m[1]}`));
      if (line) return line.split(" ")[0].slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}
function electronVersion() {
  try {
    return require(join(H.REPO, "apps", "desktop", "node_modules", "electron", "package.json"))
      .version;
  } catch {
    return "unknown";
  }
}
function finish(extraMeta = {}) {
  const failed = checks.filter((c) => !c.ok);
  const meta = {
    head: headShort(),
    electron: electronVersion(),
    node: process.version,
    scriptSha: {
      "u5-sse-fixtures.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u5-sse-fixtures.cjs")),
      "u5-read-faults.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u5-read-faults.cjs")),
      "mock-llm-server.cjs": sha12(join(H.REPO, "apps/desktop/scripts/mock-llm-server.cjs")),
      "u4-smoke-harness.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u4-smoke-harness.cjs")),
    },
    tracesCount: H.traceIds().size,
    ...extraMeta,
  };
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, meta, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条；meta=${JSON.stringify(meta)}`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 10 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 600_000);

// ---------------------------------------------------------------------------
// 读数（真 store / 真 IPC / 真落盘）
// ---------------------------------------------------------------------------

const rand = () => Math.random().toString(36).slice(2, 6);
let idSeq = 0;
const freshUuid = () => {
  idSeq += 1;
  return `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(9, "0")}${String(idSeq).padStart(3, "0")}`;
};
const opsStatus = (call) => H.apiCall(call, "operationsStatus");
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  const rec = (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null;
  return { rec, slot: st?.data?.activeOperationId ?? null, epoch: st?.data?.epoch ?? null };
};
async function waitRegistryRecordState(call, operationId, want, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const { rec } = await recordOf(call, operationId);
    last = rec;
    if (rec !== null && rec.state === want) return rec;
    if (Date.now() > deadline) return rec;
    await H.sleep(300);
  }
}
async function waitMainSettled(call, operationId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rec } = await recordOf(call, operationId);
    if (rec !== null && rec.state !== "running") return rec;
    if (Date.now() > deadline) return { ...rec, timedOut: true };
    await H.sleep(600);
  }
}
async function waitServedAtLeast(mock, target, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (mock.served() >= target) return true;
    if (Date.now() > deadline) return false;
    await H.sleep(200);
  }
}
const readSettingsDisk = () => {
  try {
    return { exists: true, raw: readFileSync(H.SETTINGS_FILE, "utf8") };
  } catch {
    return { exists: false, raw: null };
  }
};
const shaBuf = (raw) => H.createHash("sha256").update(String(raw)).digest("hex").slice(0, 16);
/** store 侧确认凭据与设置事实 */
const storeSettings = (call) =>
  H.storeQ(
    call,
    "return JSON.stringify({ settings: s.settings, confirmKeys: Object.keys(s.confirmations?.byTargetKey ?? {}), error: s.error });",
  );

// ---------------------------------------------------------------------------
// 页内：设置对话框 / 焦点 / Esc / 页面级对话框
// ---------------------------------------------------------------------------

const SETTINGS_DIALOG = 'dialog[open][aria-label="运行配置"]';
const SEL = {
  baseURL: 'input[placeholder="https://api.deepseek.com/v1"]',
  apiKey: 'input[type="password"]',
  model: 'input[placeholder="deepseek-chat"]',
};
const settingsOpen = (call) =>
  H.ev(call, `(() => document.querySelector(${JSON.stringify(SETTINGS_DIALOG)}) !== null)()`);
/** 打开设置并把焦点给触发按钮（真实用户点击必然聚焦按钮 ⇒ 焦点恢复判据可比） */
async function openSettingsViaBar(call) {
  const ok = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '运行配置');
      if (!b) return 'no-button'; b.focus(); b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked") throw new Error(`全局栏找不到「运行配置」：${ok}`);
  await H.sleep(900);
  if ((await settingsOpen(call)) !== true) throw new Error("设置模态未打开");
}
async function closeSettingsViaBottom(call) {
  await H.clickInOpenDialog(call, "关闭", 900);
  if ((await settingsOpen(call)) === true) throw new Error("点「关闭」后设置模态仍在");
}
/** 设置对话框内点按钮（精确匹配；顶层取最后一个 dialog —— 确认框在设置之上时命中确认框） */
const clickInSettings = (call, exact, wait = 1000) => H.clickInOpenDialog(call, exact, wait);
const settingsInputValue = (call, sel) =>
  H.ev(
    call,
    `(() => { const d = document.querySelector(${JSON.stringify(SETTINGS_DIALOG)});
      if (!d) return null; const i = d.querySelector(${JSON.stringify(sel)});
      return i === null ? null : i.value; })()`,
  );
async function typeSettingsInput(call, sel, text) {
  const r = await H.typeIntoDom(call, sel, text);
  if (typeof r?.value !== "string" || !r.value.includes(text))
    throw new Error(`设置输入失败（${sel}）：${JSON.stringify(r).slice(0, 160)}`);
  return r;
}
/** ✕ 按钮（aria-label="关闭"）——与底部「关闭」文字按钮同源 requestClose */
const clickSettingsX = async (call) => {
  const ok = await H.ev(
    call,
    `(() => { const d = document.querySelector(${JSON.stringify(SETTINGS_DIALOG)});
      if (!d) return 'no-dialog';
      const b = d.querySelector('button[aria-label="关闭"]');
      if (!b) return 'no-x'; b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked") throw new Error(`点 ✕ 失败：${ok}`);
  await H.sleep(900);
};
/** 真 Esc 键（Chromium 信任事件 ⇒ 原生 dialog cancel 会派发） */
async function pressEscape(call) {
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await H.sleep(800);
}
/** 关闭设置：dirty 时经「未保存确认」放弃收尾（三路同源 ⇒ 脏态的关闭必过确认） */
async function closeSettingsDiscarding(call) {
  await clickInSettings(call, "关闭", 900);
  const dlg = await waitConfirmDialog(call, "运行配置有未保存修改");
  if (dlg === null) {
    // 未触发确认 = 当前不脏，正常关闭
    if ((await settingsOpen(call)) === true) throw new Error("关闭设置失败（无确认且模态仍在）");
    return;
  }
  await clickInSettings(call, "放弃修改并关闭", 1200);
  if ((await pageDialogCount(call)) !== 0) throw new Error("放弃修改并关闭后仍有对话框");
}
const pageDialogCount = (call) =>
  H.ev(call, `(() => document.querySelectorAll('dialog[open]').length)()`);
const lastDialogInfo = (call) =>
  H.ev(
    call,
    `(() => { const ds = Array.from(document.querySelectorAll('dialog[open]'));
      const d = ds[ds.length - 1];
      return d === undefined ? null : { label: d.getAttribute('aria-label'), text: (d.innerText||'').slice(0, 500) }; })()`,
  );
const activeElInfo = (call) =>
  H.ev(
    call,
    `(() => { const a = document.activeElement;
      if (a === null) return null;
      return { tag: a.tagName, text: ((a.textContent||'').trim()).slice(0, 30),
               aria: a.getAttribute('aria-label'), title: a.getAttribute('title'), type: a.type ?? null }; })()`,
  );
/** 等最后一张对话框出现指定标题（真模态确认是异步挂载） */
async function waitConfirmDialog(call, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await lastDialogInfo(call);
    if (d !== null && d.label === label) return d;
    if (Date.now() > deadline) return d;
    await H.sleep(300);
  }
}

// ---------------------------------------------------------------------------
// 页内：创建 / 操作面板 / result 编辑器（复用 6.2/6.3/6.6 已验证实现）
// ---------------------------------------------------------------------------

async function openCreate(call) {
  const ok = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '新建运行');
      if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked") throw new Error(`全局栏找不到「新建运行」按钮：${ok}`);
  await H.sleep(900);
  const st = await H.storeQ(
    call,
    "return JSON.stringify({ view: s.view, draft: s.createRunDraftOf() === null ? null : { userMessage: s.createRunDraftOf().userMessage } });",
  );
  if (st.view !== "create") throw new Error(`点「新建运行」后 view=${st.view}，不在创建工作区`);
  return st;
}
async function fillUserMessage(call, text) {
  const r = await H.typeIntoDom(call, "#create-user-message", text);
  if (typeof r?.value !== "string" || !r.value.includes(text))
    throw new Error(`任务输入失败：${JSON.stringify(r).slice(0, 200)}`);
}
const confirmBtnExpr = `document.querySelector('section[aria-label="新建运行"] [data-confirm-execution]')`;
async function confirmSubmission(call) {
  const before = await H.ev(
    call,
    `(() => { const b = ${confirmBtnExpr};
      if (!b) return JSON.stringify({ error: 'no-confirm-button' });
      return JSON.stringify({ disabled: b.disabled, pressed: b.getAttribute('aria-pressed') }); })()`,
  );
  const parsed = JSON.parse(before);
  if (parsed.error) throw new Error(`确认按钮缺失：${parsed.error}`);
  if (parsed.disabled !== false) throw new Error(`确认按钮不可点：${JSON.stringify(parsed)}`);
  await H.ev(call, `(() => { ${confirmBtnExpr}.click(); return true; })()`);
  await H.sleep(600);
  const after = await H.ev(
    call,
    `(() => { const b = ${confirmBtnExpr};
      return b === null ? null : { pressed: b.getAttribute('aria-pressed') }; })()`,
  );
  if (after?.pressed !== "true") throw new Error(`点确认后 aria-pressed=${after?.pressed}`);
}
async function submitCreateAndCapture(call) {
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '创建');
      if (!btn) return JSON.stringify({ error: 'button-not-found' });
      if (btn.disabled) return JSON.stringify({ error: 'button-disabled' });
      btn.click();
      const deadline = Date.now() + 6000;
      for (;;) {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        if (!url) { await new Promise(res => setTimeout(res, 30)); continue; }
        const m = await import(url);
        const x = m.useAppStore.getState().draftSubmissions.byId['|create'];
        if (x !== undefined) return JSON.stringify({ operationId: x.operationId, token: x.token,
          epoch: x.epoch, revision: x.submittedRevision, submittedAt: x.submittedAt ?? null });
        if (Date.now() > deadline) return JSON.stringify({ none: true });
        await new Promise(res => setTimeout(res, 20));
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new Error(`submit capture eval: ${JSON.stringify(r.exceptionDetails).slice(0, 240)}`);
  const parsed = JSON.parse(r?.result?.value ?? "{}");
  if (parsed.error) throw new Error(`提交按钮不可用：${parsed.error}`);
  return parsed;
}
const createSessionState = (call) =>
  H.storeQ(
    call,
    `const d = s.createRunDraftOf();
     return JSON.stringify({ view: s.view, selectedRunId: s.selectedRunId,
       draft: d === null ? null : { userMessage: d.userMessage, revision: d.revision },
       frozen: s.isDraftFrozen({ field: "create" }), creating: s.creatingRun });`,
  );
async function waitForCreateSettled(call, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await createSessionState(call);
    if (st.creating !== "in_progress") return true;
    if (Date.now() > deadline) return false;
    await H.sleep(500);
  }
}
async function openOperationsPanel(call) {
  const ok = await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
      if (!b) return 'no-button';
      if (b.getAttribute('aria-expanded') === 'true') return 'already';
      b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked" && ok !== "already") throw new Error(`操作入口不可用：${ok}`);
  await H.sleep(800);
  const open = await H.ev(call, `(() => document.getElementById('operations-panel') !== null)()`);
  if (open !== true) throw new Error("操作面板未打开");
}
async function closeOperationsPanel(call) {
  await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-label="关闭操作列表"]');
      if (b) b.click(); return true; })()`,
  );
  await H.sleep(600);
}
/** 打开普通 result 编辑器（时间旅行）——normalRun 的 read_file span 固定 s_03（6.3 已验证） */
async function openPlainResultEditor(call, runId, spanId = "s_03") {
  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", spanId);
  const forkReadyExpr =
    "(() => { const b = Array.from(document.querySelectorAll('button'))" +
    ".find(x => ((x.textContent||'').trim()) === '在此重跑（时间旅行）');" +
    "return b == null ? 'no' : (b.disabled ? 'disabled' : 'ready'); })()";
  const deadline = Date.now() + 12000;
  for (;;) {
    const present = await H.ev(call, forkReadyExpr);
    if (present === "ready") break;
    if (Date.now() > deadline) throw new Error(`fork 入口 12s 未就绪：${present}`);
    await H.sleep(500);
  }
  await H.clickByTextChecked(call, "在此重跑（时间旅行）", 800);
}
const visibleConfirmExpr = `(() => {
  const all = Array.from(document.querySelectorAll('[data-confirm-execution]'));
  return all.find(b => b.offsetParent !== null) ?? null;
})()`;
async function confirmEditor(call) {
  const before = await H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      if (!b) return JSON.stringify({ error: 'no-visible-confirm' });
      return JSON.stringify({ disabled: b.disabled, pressed: b.getAttribute('aria-pressed'),
                              text: (b.textContent||'').trim() }); })()`,
  );
  const parsed = JSON.parse(before);
  if (parsed.error) throw new Error(`确认按钮缺失：${parsed.error}`);
  if (parsed.disabled !== false) throw new Error(`确认按钮不可点：${JSON.stringify(parsed)}`);
  await H.ev(call, `(() => { ${visibleConfirmExpr}.click(); return true; })()`);
  await H.sleep(500);
  const after = await H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      return b === null ? null : { pressed: b.getAttribute('aria-pressed'),
                                   text: (b.textContent||'').trim() }; })()`,
  );
  if (after?.pressed !== "true")
    throw new Error(`点确认后 aria-pressed=${after?.pressed}（text=${after?.text}）`);
  return after;
}
async function confirmState(call) {
  return H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      return b === null ? null : { disabled: b.disabled, pressed: b.getAttribute('aria-pressed'),
                                   text: (b.textContent||'').trim() }; })()`,
  );
}

// ---------------------------------------------------------------------------
// reread-failed 竞速注入：保存落盘瞬间把 settings.json 改写成"缺 apiKey"形状
//（main 的 load() 每次读盘 ⇒ settings:get 抛"内容不完整" ⇒ loadSettings false ⇒ reread-failed）
// ---------------------------------------------------------------------------

function startRereadRace() {
  const file = H.SETTINGS_FILE;
  let armed = true;
  let saved = null;
  const promise = new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      armed = false;
      clearInterval(timer);
      resolve(v);
    };
    let lastMtime = 0;
    let lastSize = -1;
    try {
      const st0 = H.fs.statSync(file);
      lastMtime = st0.mtimeMs;
      lastSize = st0.size;
    } catch {
      /* 尚无文件 */
    }
    const timer = setInterval(() => {
      if (!armed || done) return;
      try {
        const st = H.fs.statSync(file);
        if (st.mtimeMs === lastMtime && st.size === lastSize) return;
        lastMtime = st.mtimeMs;
        lastSize = st.size;
        const content = readFileSync(file, "utf8");
        saved = content;
        // 抢在 main 回读前改写：缺 apiKey ⇒ load() 抛「settings.json 内容不完整」
        writeFileSync(
          file,
          JSON.stringify({ baseURL: "u567-race", model: "u567" }, null, 2),
          "utf8",
        );
        finish({ won: true, saved });
      } catch (e) {
        finish({ won: false, why: String(e).slice(0, 160) });
      }
    }, 1);
    // 20s 封顶：竞速窗口本是毫秒级，超时即视为本轮未得手（别把整批拖到看门狗）
    setTimeout(() => finish({ won: false, why: "race-timeout" }), 20000);
  });
  return { done: () => promise, savedContent: () => saved };
}
/** 等保存反馈出现两种措辞之一（win=回读失败 / lose=正常保存） */
async function waitSaveOutcomeText(call, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await lastDialogInfo(call);
    if (d !== null && d.label === "运行配置") {
      if (d.text.includes("已保存，但配置状态回读失败"))
        return { kind: "reread-failed", text: d.text };
      if (d.text.includes("已保存并回读到配置状态")) return { kind: "saved", text: d.text };
    }
    if (Date.now() > deadline) return { kind: "timeout", text: d?.text ?? null };
    await H.sleep(300);
  }
}

// ---------------------------------------------------------------------------
// Win32/UIA 通道（仅 quit-* tag 用：原生 #32770 不在网页里，CDP 看不见）
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
async function waitDialog(timeoutMs = 25000) {
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
/** 逐轮点按钮直到框数清零（原生框首击可被吞 ⇒ 点击-核对-重试） */
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
/** 合并文案分类：只按 main `buildCloseConfirmText` 的 message 档位判（U4 6.7 同口径） */
function classifyClose(dialog) {
  const t = String(dialog?.texts ?? "");
  return {
    active: t.includes("有操作正在执行"),
    draftDirty: t.includes("有未放弃的调试草稿"),
    mergedDirtyActive: t.includes("有未放弃的调试草稿，且有操作正在执行"),
    mentionsActiveNote: t.includes("已登记的主动操作尚未结束"),
  };
}
function quitButtonIndex(dialog) {
  const buttons = String(dialog?.buttons ?? "").split("|");
  return buttons.findIndex((b) => b.includes("退出"));
}
const bridgeCreate = (call, epoch, operationId, userMessage) =>
  H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `return JSON.stringify(await window.api.createRun({
       operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
       request: { systemPrompt: "你是冒烟助手。只回一句话。", userMessage: ${JSON.stringify(userMessage)} },
     }));`,
  );

// ---------------------------------------------------------------------------

const FLOWS = {
  /** A6.2「重跑编辑配置往返保持阅读」：result 编辑器草稿与阅读位置跨设置往返逐字保留 */
  "editor-settings-roundtrip": async (call, mock) => {
    const servedBefore = mock.served();
    await openPlainResultEditor(call, FX.normalRun, "s_03");
    const draftText = `${MARK} roundtrip 草稿`;
    await H.typeIntoEditableMonaco(call, draftText);
    const before = await H.storeQ(
      call,
      "return JSON.stringify({ sel: s.selectedRunId, span: s.selectedSpanId, view: s.view });",
    );
    const info1 = await H.monacoInfo(call);
    const editorBefore =
      info1.editors.find((e) => e.visible === true && e.readOnly === false) ?? null;
    check(
      "前置：可编辑编辑器在场且含草稿",
      editorBefore !== null && String(editorBefore.value).includes(draftText),
      editorBefore?.value?.slice(0, 80) ?? null,
    );
    // 设置往返（含真实保存：配置指纹变化）
    await openSettingsViaBar(call);
    await typeSettingsInput(call, SEL.model, "mock-model-c");
    await clickInSettings(call, "保存", 1500);
    const d1 = await lastDialogInfo(call);
    check(
      "设置内真实保存成功（不冒充连通的反馈在场）",
      d1?.text?.includes("已保存并回读到配置状态") === true,
      d1?.text?.slice(0, 120),
    );
    await closeSettingsViaBottom(call);
    const after = await H.storeQ(
      call,
      "return JSON.stringify({ sel: s.selectedRunId, span: s.selectedSpanId, view: s.view });",
    );
    check(
      "设置往返后阅读位置逐字不动（运行/页签/调用都保持）",
      before.sel === after.sel && before.span === after.span && before.view === after.view,
      { before, after },
    );
    const info2 = await H.monacoInfo(call);
    const editorAfter =
      info2.editors.find((e) => e.visible === true && e.readOnly === false) ?? null;
    check(
      "重跑编辑草稿跨设置往返逐字保留",
      editorAfter !== null && String(editorAfter.value).includes(draftText),
      editorAfter?.value?.slice(0, 80) ?? null,
    );
    check(
      "零模型调用（本 tag 不提交，418 兜底：任何消费都会判红）",
      mock.served() === servedBefore,
      mock.served(),
    );
    await H.shot(call, SHOT_DIR, `${TAG}-roundtrip.png`);
  },

  /** A1.5 6.7 半边「返回修改与设置往返撤销旧确认」：确认挂上 → 设置往返 → 撤销 → 可重新挂上 */
  "settings-roundtrip-confirm": async (call, mock) => {
    const servedBefore = mock.served();
    await openPlainResultEditor(call, FX.normalRun, "s_03");
    await H.typeIntoEditableMonaco(call, `${MARK} confirm-roundtrip 文本`);
    const armed = await confirmEditor(call);
    check("前置：确认可挂上（绑定当前现场）", armed.pressed === "true", armed);
    const conf1 = await storeSettings(call);
    check("store 里恰好一份确认凭据", conf1.confirmKeys.length === 1, conf1.confirmKeys);
    // 设置往返：只打开再关闭（不改配置 → 撤销来自"离开现场"，不是配置变化）
    await openSettingsViaBar(call);
    await closeSettingsViaBottom(call);
    const st1 = await confirmState(call);
    check("设置往返 ⇒ 旧确认撤销（回到未确认态）", st1 !== null && st1.pressed !== "true", st1);
    const conf2 = await storeSettings(call);
    check("确认凭据出库（store 里不再持有）", conf2.confirmKeys.length === 0, conf2.confirmKeys);
    const rearmed = await confirmEditor(call);
    check("重新确认可挂上（往返不毁资格，只是要求重新核对）", rearmed.pressed === "true", rearmed);
    check("零模型调用", mock.served() === servedBefore, mock.served());
  },

  /** A6.3「未保存设置关闭可继续或放弃」：✕/Esc 走真模态确认，继续逐字保留、放弃只丢会话输入 */
  "settings-close-dirty": async (call, mock) => {
    void mock;
    const disk0 = readSettingsDisk();
    const saved0 = await storeSettings(call);
    check(
      "前置：已保存配置在场（dirty 对照的基线）",
      saved0.settings !== null,
      saved0.settings?.model ?? null,
    );
    await openSettingsViaBar(call);
    const typedKey = `sk-${MARK}-dirty-typed`;
    await typeSettingsInput(call, SEL.apiKey, typedKey);
    // 路 1：✕ → 真模态确认（初始焦点在「继续编辑」）
    await clickSettingsX(call);
    const dlg = await waitConfirmDialog(call, "运行配置有未保存修改");
    check(
      "✕ 触发未保存关闭确认（真模态，标题逐字）",
      dlg !== null && dlg.label === "运行配置有未保存修改",
      dlg?.label ?? null,
    );
    check(
      "确认文案点名密钥从未被写入（单向通道语义在场）",
      dlg?.text.includes("从未被写入"),
      dlg?.text?.slice(0, 160),
    );
    const focus1 = await activeElInfo(call);
    check(
      "初始焦点在「继续编辑」（破坏性动作的安全缺省，U3 纪律）",
      focus1?.text === "继续编辑",
      focus1,
    );
    await clickInSettings(call, "继续编辑", 900);
    check(
      "继续编辑 ⇒ 确认关闭、设置仍在",
      (await pageDialogCount(call)) === 1 && (await settingsOpen(call)) === true,
      null,
    );
    check(
      "继续编辑逐字保留（密钥输入原样）",
      (await settingsInputValue(call, SEL.apiKey)) === typedKey,
      null,
    );
    // 路 2：Esc → 同一条确认
    await pressEscape(call);
    const dlg2 = await waitConfirmDialog(call, "运行配置有未保存修改");
    check(
      "Esc 同样先过未保存确认（三路同源）",
      dlg2 !== null && dlg2.label === "运行配置有未保存修改",
      dlg2?.label ?? null,
    );
    await clickInSettings(call, "继续编辑", 900);
    // 路 3：✕ → 放弃修改并关闭
    await clickSettingsX(call);
    await waitConfirmDialog(call, "运行配置有未保存修改");
    await clickInSettings(call, "放弃修改并关闭", 1200);
    check("放弃修改并关闭 ⇒ 设置关闭", (await pageDialogCount(call)) === 0, null);
    const focus2 = await activeElInfo(call);
    check(
      "关闭后焦点恢复到触发入口（全局栏「运行配置」）",
      focus2 !== null && String(focus2.title ?? "").includes("配置 LLM 接入"),
      focus2,
    );
    // 放弃只丢会话输入：已保存配置逐字不动、磁盘逐字节不动、打过的密钥从未落盘
    const saved1 = await storeSettings(call);
    check(
      "放弃不动已保存配置",
      JSON.stringify(saved1.settings) === JSON.stringify(saved0.settings),
      { before: saved0.settings, after: saved1.settings },
    );
    const disk1 = readSettingsDisk();
    check(
      "放弃不动磁盘 settings.json（逐字节）",
      disk0.exists === disk1.exists && disk0.raw === disk1.raw,
      null,
    );
    check(
      "打过的密钥从未落盘（单向通道）",
      disk1.exists === false || !disk1.raw.includes(typedKey),
      null,
    );
    // 重开：密钥输入回到空（会话输入已丢）
    await openSettingsViaBar(call);
    check(
      "重开后密钥输入为空（放弃丢弃的是会话输入）",
      (await settingsInputValue(call, SEL.apiKey)) === "",
      null,
    );
    await closeSettingsViaBottom(call);
    await H.shot(call, SHOT_DIR, `${TAG}-dirty-close.png`);
  },

  /** A6.4「单向密钥与保存反馈不冒充连通」：磁盘侧密文/明文分流 × 回读键集无 apiKey × 反馈只称已保存 */
  "key-one-way": async (call, mock) => {
    void mock;
    const BASE_KEY = "sk-u363-controlled";
    const disk0 = readSettingsDisk();
    check("前置：磁盘 settings.json 在场", disk0.exists === true, null);
    let stored0 = null;
    try {
      stored0 = JSON.parse(disk0.raw);
    } catch {
      /* 不合法在下面判 */
    }
    const encrypted = stored0?.apiKeyEncrypted !== false;
    check(
      encrypted
        ? "磁盘侧：密文存储（safeStorage）⇒ 落盘字节不含密钥明文"
        : "磁盘侧：明文降级（加密不可用）⇒ 落盘含明文并带 apiKeyEncrypted=false 标记",
      encrypted
        ? !disk0.raw.includes(BASE_KEY)
        : disk0.raw.includes(BASE_KEY) && stored0.apiKeyEncrypted === false,
      { encrypted: stored0?.apiKeyEncrypted ?? null },
    );
    const saved0 = await storeSettings(call);
    check(
      "回读键集结构上没有 apiKey（单向密钥的机器判据）",
      saved0.settings !== null && !Object.keys(saved0.settings).includes("apiKey"),
      Object.keys(saved0.settings ?? {}),
    );
    check("回读载荷不含密钥明文", !JSON.stringify(saved0.settings).includes(BASE_KEY), null);
    // 打过字但未保存：密钥从未离开渲染层（磁盘逐字节不动）
    await openSettingsViaBar(call);
    const typedKey = `sk-${MARK}-typed-only-${rand()}`;
    await typeSettingsInput(call, SEL.apiKey, typedKey);
    const diskMid = readSettingsDisk();
    check(
      "打过字未保存 ⇒ 磁盘逐字节不动（密钥从未离开渲染层暂存）",
      diskMid.raw === disk0.raw,
      null,
    );
    // 保存：密钥进 main（单向通道），反馈只称"已保存/已回读"，不冒充连通
    await clickInSettings(call, "保存", 1500);
    const d1 = await lastDialogInfo(call);
    check(
      "保存反馈只称已保存并回读（无连接测试/连接成功字样）",
      d1?.text?.includes("已保存并回读到配置状态") === true &&
        d1.text.includes("未发起任何连接测试"),
      d1?.text?.slice(0, 140),
    );
    const disk1 = readSettingsDisk();
    check("保存后磁盘更新", disk1.exists === true && disk1.raw !== disk0.raw, null);
    let stored1 = null;
    try {
      stored1 = JSON.parse(disk1.raw);
    } catch {
      /* 下面判 */
    }
    check(
      "新密钥按同一加密方式落盘（密文不含明文 / 明文带标记）",
      encrypted
        ? !disk1.raw.includes(typedKey)
        : disk1.raw.includes(typedKey) && stored1?.apiKeyEncrypted === false,
      { encrypted: stored1?.apiKeyEncrypted ?? null },
    );
    const saved1 = await storeSettings(call);
    check(
      "保存后回读仍不含密钥（键集与载荷双面）",
      saved1.settings !== null &&
        !Object.keys(saved1.settings).includes("apiKey") &&
        !JSON.stringify(saved1.settings).includes(typedKey),
      null,
    );
    check(
      "保存成功后密钥输入被清空（不回显）",
      (await settingsInputValue(call, SEL.apiKey)) === "",
      null,
    );
    await closeSettingsViaBottom(call);
    await openSettingsViaBar(call);
    check(
      "重开对话框密钥输入仍为空（不回读明文到界面）",
      (await settingsInputValue(call, SEL.apiKey)) === "",
      null,
    );
    await closeSettingsViaBottom(call);
    await H.shot(call, SHOT_DIR, `${TAG}-one-way-key.png`);
  },

  /**
   * A6.5「保存失败和保存后回读失败区分」：
   * - save-failed 用 main 的「apiKey 不能为空」校验自然诱发（零注入）；
   * - reread-failed 用竞速注入（保存落盘瞬间改写 settings.json 缺 apiKey）；诱不出来按单元承载登记。
   */
  "save-fail-shapes": async (call, mock) => {
    void mock;
    // —— save-failed：未配置 + 空 apiKey ⇒ main 校验拒绝，输入逐字保留、settings 原样 ——
    // ⚠️ 走 store 动作（raw IPC 清 main 不动渲染层 store ⇒ settings 不会变 null，对照基线就错了）
    await H.storeQ(call, "await s.clearSettings(); return JSON.stringify({ ok: true });");
    const afterClear = await storeSettings(call);
    check(
      "前置：清除后 settings 为 null（save-failed 的对照基线）",
      afterClear.settings === null,
      null,
    );
    check("前置：settings.json 已从磁盘删除", readSettingsDisk().exists === false, null);
    await openSettingsViaBar(call);
    const bURL = H.MOCK_BASE;
    await typeSettingsInput(call, SEL.baseURL, bURL);
    await typeSettingsInput(call, SEL.model, "mock-model");
    check(
      "前置：apiKey 留空（未配置时空 key 必被 main 拒）",
      (await settingsInputValue(call, SEL.apiKey)) === "",
      null,
    );
    await clickInSettings(call, "保存", 1500);
    const d1 = await lastDialogInfo(call);
    check(
      "保存失败 ⇒ 反馈带 main 真实校验文案（apiKey 不能为空），不是笼统失败",
      d1?.text?.includes("保存运行配置失败") === true && d1.text.includes("apiKey 不能为空"),
      d1?.text?.slice(0, 160),
    );
    check(
      "保存失败 ⇒ 输入逐字保留",
      (await settingsInputValue(call, SEL.baseURL)) === bURL &&
        (await settingsInputValue(call, SEL.model)) === "mock-model",
      null,
    );
    const failed1 = await storeSettings(call);
    check(
      "保存失败 ⇒ settings 原样（没写进去也不该动事实）",
      failed1.settings === null,
      failed1.settings,
    );
    check(
      "保存失败 ⇒ 磁盘仍无 settings.json（零字节都不写）",
      readSettingsDisk().exists === false,
      null,
    );
    // 此刻输入仍是脏的（typed 值 ≠ saved null）⇒ 关闭必过「放弃修改并关闭」
    await closeSettingsDiscarding(call);
    // —— reread-failed：恢复配置后竞速注入 ——
    await H.apiCall(call, "saveSettings", {
      baseURL: H.MOCK_BASE,
      apiKey: "sk-u363-controlled",
      model: "mock-model",
    });
    // main 已有新配置；渲染层 store 还停在 null ⇒ 先回读，对话框才有正确的预填基线
    await H.storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
    const rereadOutcome = await (async () => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        await openSettingsViaBar(call);
        const marker = `http://u567-race-${attempt}.example`;
        await typeSettingsInput(call, SEL.baseURL, marker);
        const race = startRereadRace();
        await clickInSettings(call, "保存", 100);
        const raceResult = await race.done();
        const outcome = await waitSaveOutcomeText(call);
        const savedContent = race.savedContent();
        if (outcome.kind === "reread-failed" && raceResult.won === true) {
          return { attempt, outcome, savedContent, won: true };
        }
        // 竞速输了（main 先读）：若磁盘已被我们改写，恢复保存时内容
        if (typeof savedContent === "string") writeFileSync(H.SETTINGS_FILE, savedContent, "utf8");
        await closeSettingsViaBottom(call);
        await H.sleep(400);
      }
      return { won: false };
    })();
    if (rereadOutcome.won !== true) {
      dump.layerNote =
        "「保存成功但回读失败」的竞速窗口 5 次尝试未得手（main 保存与回读同在渲染层一个 await 链上，间隙毫秒级）⇒ reread-failed 分支按 settings-save-feedback 单测承载（tasks 6.7 预设口径）";
      check(
        "reread-failed 竞速未得手 ⇒ 按单元承载登记（save-failed 半边已实机坐实）",
        true,
        dump.layerNote,
      );
      return;
    }
    check(
      `第 ${rereadOutcome.attempt} 次竞速得手：保存已落盘但回读被注入打断`,
      rereadOutcome.outcome.kind === "reread-failed",
      rereadOutcome.outcome.text?.slice(0, 140),
    );
    const d2 = await lastDialogInfo(call);
    check(
      "回读失败 ⇒ 专属反馈在场（不把旧摘要当新配置事实）",
      d2?.text?.includes("已保存，但配置状态回读失败") === true && d2.text.includes("不会重新保存"),
      d2?.text?.slice(0, 180),
    );
    const rereadBtn = await H.ev(
      call,
      `(() => document.querySelector('[data-reread-settings]') !== null)()`,
    );
    check("回读失败 ⇒ 只读重试按钮在场（走 settings:get，不重新保存）", rereadBtn === true, null);
    const mid = await storeSettings(call);
    check(
      "回读失败 ⇒ settings 清空（不拿旧摘要冒充配置事实）",
      mid.settings === null,
      mid.settings,
    );
    // 还原磁盘 → 只读重试 → 回读核实
    writeFileSync(H.SETTINGS_FILE, rereadOutcome.savedContent, "utf8");
    await H.ev(
      call,
      `(() => { document.querySelector('[data-reread-settings]')?.click(); return true; })()`,
    );
    await H.sleep(1500);
    const d3 = await lastDialogInfo(call);
    check(
      "还原后只读重试 ⇒ 配置状态已回读核实",
      d3?.text?.includes("配置状态已回读核实") === true,
      d3?.text?.slice(0, 120),
    );
    const fin = await storeSettings(call);
    check(
      "只读重试成功 ⇒ settings 恢复（回读通道不写盘）",
      fin.settings !== null && fin.settings.baseURL !== null,
      fin.settings?.baseURL ?? null,
    );
    const rereadBtnGone = await H.ev(
      call,
      `(() => document.querySelector('[data-reread-settings]') === null)()`,
    );
    check("回读成功 ⇒ 重试按钮退场", rereadBtnGone === true, null);
    await closeSettingsViaBottom(call);
    await H.shot(call, SHOT_DIR, `${TAG}-reread-failed.png`);
  },

  /** A6.6「清除确认包含凭据且受槽约束」：在飞时写入口禁用 + 真模态确认（取消零清除 / 确认真清除） */
  "clear-confirm": async (call, mock) => {
    const servedBefore = mock.served();
    // —— 槽约束半边：在飞期间设置写入口整体禁用（U4 门禁接线到设置对话框这一层） ——
    await openCreate(call);
    const task = `${MARK} clear-confirm 占槽任务`;
    await fillUserMessage(call, task);
    await confirmSubmission(call);
    const sub = await submitCreateAndCapture(call);
    const flight = await waitRegistryRecordState(call, sub.operationId, "running", 20000);
    check("前置：在飞执行 running（真占槽）", flight?.state === "running", flight?.state ?? null);
    // configurationBusy 只随 main 快照进会话 ⇒ 显式刷一次 status（等价用户打开操作面板，U4 6.7 同做法）
    await H.storeQ(
      call,
      "await s.refreshOperationStatus(); return JSON.stringify({ done: true });",
    );
    await openSettingsViaBar(call);
    const gateDisabled = await H.ev(
      call,
      `(() => { const d = document.querySelector(${JSON.stringify(SETTINGS_DIALOG)});
        if (!d) return null;
        const btns = Array.from(d.querySelectorAll('button'));
        const clear = btns.find(b => ((b.textContent||'').trim()) === '清除配置');
        const save = btns.find(b => ((b.textContent||'').trim()) === '保存');
        const notice = d.querySelector('[data-testid="config-gate-notice"]');
        return { clearDisabled: clear?.disabled ?? null, saveDisabled: save?.disabled ?? null,
                 notice: notice === null ? null : (notice.textContent||'').slice(0, 80) }; })()`,
    );
    check(
      "在飞期间清除与保存都被 U4 配置门禁禁用（且就近给门禁说明）",
      gateDisabled?.clearDisabled === true &&
        gateDisabled?.saveDisabled === true &&
        gateDisabled?.notice !== null,
      gateDisabled,
    );
    await closeSettingsViaBottom(call);
    const settled = await waitForCreateSettled(call);
    check("占槽任务收口（对照面回到可写）", settled === true, settled);
    // —— 清除确认：取消一支 + 确认一支（真点选） ——
    const disk0 = readSettingsDisk();
    check("前置：磁盘配置在场（清除对照基线）", disk0.exists === true, null);
    await openSettingsViaBar(call);
    await clickInSettings(call, "清除配置", 900);
    const dlg = await waitConfirmDialog(call, "清除运行配置");
    check(
      "清除先过真模态确认（标题逐字）",
      dlg !== null && dlg.label === "清除运行配置",
      dlg?.label ?? null,
    );
    check(
      "确认文案点名保存凭据一并删除且不可恢复",
      dlg?.text.includes("apiKey（保存的凭据）一并删除") && dlg.text.includes("不可恢复"),
      dlg?.text?.slice(0, 200),
    );
    check(
      "确认文案写明调试草稿与已有运行不受影响",
      dlg?.text.includes("调试草稿与已有运行不受影响"),
      null,
    );
    // 取消一支：零清除调用
    await clickInSettings(call, "取消", 900);
    check(
      "取消 ⇒ 确认关闭、设置仍在",
      (await pageDialogCount(call)) === 1 && (await settingsOpen(call)) === true,
      null,
    );
    const diskAfterCancel = readSettingsDisk();
    check("取消 ⇒ 零清除调用（磁盘逐字节不动）", diskAfterCancel.raw === disk0.raw, null);
    const stAfterCancel = await storeSettings(call);
    check("取消 ⇒ 配置事实原样（settings 仍在）", stAfterCancel.settings !== null, null);
    // 确认一支：真清除
    await clickInSettings(call, "清除配置", 900);
    await waitConfirmDialog(call, "清除运行配置");
    await clickInSettings(call, "确认清除", 1500);
    const d2 = await lastDialogInfo(call);
    check(
      "确认清除 ⇒ 反馈「运行配置已清除。」",
      d2?.text?.includes("运行配置已清除。") === true,
      d2?.text?.slice(0, 120),
    );
    const stAfterClear = await storeSettings(call);
    check("确认清除 ⇒ settings 为 null", stAfterClear.settings === null, null);
    check("确认清除 ⇒ 磁盘 settings.json 已删除", readSettingsDisk().exists === false, null);
    const inputsAfter = await H.ev(
      call,
      `(() => { const d = document.querySelector(${JSON.stringify(SETTINGS_DIALOG)});
        if (!d) return null;
        return { baseURL: d.querySelector('input[placeholder="https://api.deepseek.com/v1"]')?.value ?? null,
                 model: d.querySelector('input[placeholder="deepseek-chat"]')?.value ?? null }; })()`,
    );
    check(
      "清除后输入复位（不残留旧值冒充未配置）",
      inputsAfter?.baseURL === "" && inputsAfter?.model === "",
      inputsAfter,
    );
    await closeSettingsViaBottom(call);
    check("恰一次模型调用（占槽任务）", mock.served() - servedBefore === 1, mock.served());
    await H.shot(call, SHOT_DIR, `${TAG}-clear-confirm.png`);
  },

  /** A6.7「录制入口保持现有代理区可达」：全局/轨迹两个状态都定位既有代理分区（不另建录制 UI） */
  "recording-entry": async (call, mock) => {
    void mock;
    const checkEntry = async (fromWhere) => {
      const ok = await H.ev(
        call,
        `(() => { const b = Array.from(document.querySelectorAll('button'))
            .find(x => ((x.textContent||'').trim()) === '录制接入');
          if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
      );
      if (ok !== "clicked") throw new Error(`全局栏找不到「录制接入」（${fromWhere}）：${ok}`);
      await H.sleep(900);
      const open = await settingsOpen(call);
      const focus = await activeElInfo(call);
      const proxyVisible = await H.ev(
        call,
        `(() => { const d = document.querySelector(${JSON.stringify(SETTINGS_DIALOG)});
          return d === null ? false : (d.innerText||'').includes('本地录制代理（零摩擦接入）'); })()`,
      );
      const section = await H.storeQ(
        call,
        "return JSON.stringify({ section: s.settingsSection });",
      );
      check(`${fromWhere}：录制入口打开的是既有设置模态`, open === true, null);
      check(`${fromWhere}：代理分区在场（不是另建一套录制界面）`, proxyVisible === true, null);
      check(
        `${fromWhere}：定位动作把焦点放到代理分区第一个控件（启用复选框）`,
        focus?.tag === "INPUT" && focus?.type === "checkbox",
        focus,
      );
      check(
        `${fromWhere}：定位是动作不是常驻状态（settingsSection 用后即清）`,
        section.section === null,
        section,
      );
      await closeSettingsViaBottom(call);
    };
    await checkEntry("全局（轨迹工作区）");
    await H.selectRun(call, FX.normalRun);
    await checkEntry("选中运行后（概览在场）");
    await H.shot(call, SHOT_DIR, `${TAG}-recording-entry.png`);
  },

  /** M6.2「Esc 只关闭最上层并恢复焦点」：真 Esc 键逐层关闭（设置 → 确认），恢复焦点到触发入口 */
  "esc-topmost": async (call, mock) => {
    void mock;
    const stackState = () =>
      H.ev(
        call,
        `(() => JSON.stringify(Array.from(document.querySelectorAll('dialog[open]'))
          .map(d => d.getAttribute('aria-label'))))()`,
      );
    const disk0 = readSettingsDisk();
    // 非脏：Esc 直接关闭设置并恢复焦点
    await openSettingsViaBar(call);
    await pressEscape(call);
    check("非脏 Esc ⇒ 设置关闭", (await pageDialogCount(call)) === 0, {
      stack: await stackState(),
    });
    const focus1 = await activeElInfo(call);
    check(
      "非脏 Esc ⇒ 焦点恢复到触发入口",
      focus1 !== null && String(focus1.title ?? "").includes("配置 LLM 接入"),
      focus1,
    );
    // 脏：第一层 Esc 先被"未保存确认"消费（设置不关）
    await openSettingsViaBar(call);
    const typedKey = `sk-${MARK}-esc-dirty`;
    await typeSettingsInput(call, SEL.apiKey, typedKey);
    await pressEscape(call);
    const dlg1 = await waitConfirmDialog(call, "运行配置有未保存修改");
    check(
      "脏态第一层 Esc ⇒ 未保存确认出现（设置仍在下层）",
      dlg1 !== null && (await pageDialogCount(call)) === 2,
      { stack: await stackState() },
    );
    // 第二层 Esc：只关确认（修复后逐层成立；修复前两步关闭把底层设置也关了）
    await pressEscape(call);
    await H.sleep(600);
    const stackAfterEsc2 = await stackState();
    dump.stackAfterEsc2 = stackAfterEsc2;
    check(
      "第二层 Esc ⇒ 只关确认，底层设置原位（Esc 只关闭最上层）",
      JSON.stringify(JSON.parse(stackAfterEsc2)) === JSON.stringify(["运行配置"]),
      stackAfterEsc2,
    );
    check(
      "确认被 Esc 取消后输入逐字保留",
      (await settingsInputValue(call, SEL.apiKey)) === typedKey,
      null,
    );
    // 第三层 Esc：确认可再次唤起（合成路径不依赖原生 cancel 的第一次豁免）
    await pressEscape(call);
    const dlg2 = await waitConfirmDialog(call, "运行配置有未保存修改");
    check("第三层 Esc ⇒ 确认可再次唤起（不是一次性）", dlg2 !== null, dlg2?.label ?? null);
    await clickInSettings(call, "放弃修改并关闭", 1200);
    check("放弃修改并关闭 ⇒ 全部关闭", (await pageDialogCount(call)) === 0, {
      stack: await stackState(),
    });
    const disk1 = readSettingsDisk();
    check(
      "整场 Esc 往返不动磁盘配置（逐字节）",
      disk0.exists === disk1.exists && disk0.raw === disk1.raw,
      null,
    );
    await H.shot(call, SHOT_DIR, `${TAG}-esc-topmost.png`);
  },

  /**
   * A2.3「关闭详情与退出不冒充停止」：面板 ✕ 只关闭查看（登记保持 running、槽不释放）；
   * 确认退出后进程真结束，且不把在飞那次伪装成已完成。
   */
  "quit-executing": async (call, mock) => {
    const s0 = await opsStatus(call);
    const servedBefore = mock.served();
    // 在飞（UI 路径 ⇒ renderer 会话持有 pending）。⚠️ run 文件在运行开始时就落盘
    // ⇒ 基线必须取在提交之前，否则"退出只留一份未完成文件"的判据会把目标当旧文件漏掉
    const idsBefore = new Set(H.traceIds());
    await openCreate(call);
    const task = `${MARK} quit-executing 在飞任务`;
    await fillUserMessage(call, task);
    await confirmSubmission(call);
    const sub = await submitCreateAndCapture(call);
    if (typeof sub.operationId !== "string") throw new Error(`创建未登记：${JSON.stringify(sub)}`);
    const flight = await waitRegistryRecordState(call, sub.operationId, "running", 20000);
    check("退出前：那条执行确实 running", flight?.state === "running", flight?.state ?? null);
    const reached = await waitServedAtLeast(mock, servedBefore + 1, 30000);
    check("在飞已把请求送到模型", reached === true, mock.served());
    // —— 关闭详情半边：面板 ✕ 只关闭查看 ——
    await openOperationsPanel(call);
    await closeOperationsPanel(call);
    const panelGone = await H.ev(
      call,
      `(() => document.getElementById('operations-panel') === null)()`,
    );
    check("面板 ✕ 只关闭查看（面板退场）", panelGone === true, null);
    const mid = await recordOf(call, sub.operationId);
    check(
      "关闭详情不冒充停止：登记仍 running、槽仍指向它",
      mid.rec?.state === "running" && mid.slot === sub.operationId,
      { state: mid.rec?.state, slot: mid.slot },
    );
    await openOperationsPanel(call);
    const rowBack = await H.ev(
      call,
      `(() => { const panel = document.getElementById('operations-panel');
        if (panel === null) return false;
        return panel.innerText.includes(${JSON.stringify(sub.operationId)}); })()`,
    );
    check("重开面板该操作仍在（✕ 不清理任何登记）", rowBack === true, null);
    await closeOperationsPanel(call);
    // —— 退出半边：哨兵 ⇒ 真 app.quit ⇒ 活跃操作档确认 ——
    await winops("restore");
    const resolved = await resolveMainPid();
    check("已唯一认定 dev 主进程 PID", resolved.pid > 0, resolved.info);
    writeFileSync(QUIT_FLAG, "u567-quit-exec\n");
    const dlg = await waitDialog(25000);
    const kinds = classifyClose(dlg);
    dump.quitDialog = {
      kinds,
      buttons: dlg?.buttons ?? null,
      texts: dlg?.texts?.slice(0, 300) ?? null,
    };
    check(
      "退出前仍弹一次确认（活跃操作档；退出不会取消上游请求的措辞在场）",
      dlg !== null && kinds.active === true && dlg.texts.includes("退出不会取消上游请求"),
      { kinds, texts: dlg?.texts?.slice(0, 200) },
    );
    const qi = quitButtonIndex(dlg);
    check("退出按钮可定位（下标 > 0 ⇒ 「返回」在 0）", qi > 0, { qi, buttons: dlg?.buttons });
    const pidOfMain = MAIN_PID;
    await winops("dialog-click", ["-Index", String(qi)]);
    const gone = await waitWindowGone();
    check(
      "确认退出 ⇒ 窗口真实结束",
      gone.window === "absent" || String(gone.window ?? "").includes("iswindow=False"),
      gone,
    );
    const pidGone = await waitPidGone(pidOfMain);
    check("进程真实结束（不是只关窗口）", pidGone.gone === true, pidGone);
    SESSION.call = null; // 应用已死：teardown 不得再走旧会话
    await H.sleep(3000);
    const newFiles = [...H.traceIds()].filter((x) => !idsBefore.has(x)).sort();
    // 口径对齐 U4 6.7（≤1）：llm.call span 未 end 不落盘 ⇒ 在飞中被杀的 run **盘上可能零痕迹**
    //（6.7 首跑实测 newFiles=[]，meta 都没写 ⇒ "在飞 run 文件运行开始时就落盘"的旧注记不成立）。
    // 「不冒充停止」的硬判据 = 留下的那份（若在）无终态事件 + 历史逐字节不变 + 请求只出过一次门。
    dump.layerNote =
      "在飞期被杀的 run 盘上零痕迹（trace-format：span 在 endSpan 时整行落盘，llm.call 未返回 ⇒ meta+span 都没写）⇒ 判据按 U4 6.7 的 ≤1 口径";
    check(
      "退出不把在飞那次伪装成已完成：至多留下它自己那一份未完成文件",
      newFiles.length <= 1,
      newFiles,
    );
    if (newFiles.length === 1) {
      const lines = readFileSync(join(H.TRACES, `${newFiles[0]}.jsonl`), "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      const last = lines[lines.length - 1];
      check("未完成文件没有终态事件（不回填 completed、不认领结局）", last?.type !== "run.event", {
        lastType: last?.type ?? null,
      });
    }
    check("被打断那次的请求只出过一次门（退出未重放）", mock.served() === servedBefore + 1, {
      served: mock.served(),
      servedBefore,
    });
    dump.servedAtExit = mock.served();
  },

  /**
   * M6.3 6.7 半边「创建忙碌期间不能通过焦点修复绕过关闭锁」：创建在飞 ⇒ 退出协商（活跃操作档）
   * ⇒ 询问期间第二入口被 main 拒 ⇒ 返回后不自动执行、原在飞照常收口。
   */
  "quit-return": async (call, mock) => {
    const s0 = await opsStatus(call);
    const servedBefore = mock.served();
    // 创建在飞（UI 路径）
    await openCreate(call);
    const task = `${MARK} quit-return 在飞任务`;
    await fillUserMessage(call, task);
    await confirmSubmission(call);
    const sub = await submitCreateAndCapture(call);
    if (typeof sub.operationId !== "string") throw new Error(`创建未登记：${JSON.stringify(sub)}`);
    const flight = await waitRegistryRecordState(call, sub.operationId, "running", 20000);
    check("前置：创建在飞 running", flight?.state === "running", flight?.state ?? null);
    await waitServedAtLeast(mock, servedBefore + 1, 30000);
    const idsAtFlight = new Set(H.traceIds());
    // 哨兵 ⇒ 真 app.quit ⇒ 协商
    await winops("restore");
    const resolved = await resolveMainPid();
    check("已唯一认定 dev 主进程 PID", resolved.pid > 0, resolved.info);
    writeFileSync(QUIT_FLAG, "u567-quit-return\n");
    const dlg = await waitDialog(25000);
    const kinds = classifyClose(dlg);
    dump.quitDialog = {
      kinds,
      buttons: dlg?.buttons ?? null,
      texts: dlg?.texts?.slice(0, 300) ?? null,
    };
    check("创建忙碌 ⇒ 退出仍先过协商（活跃操作档在场）", dlg !== null && kinds.active === true, {
      kinds,
      texts: dlg?.texts?.slice(0, 200),
    });
    const mid = await recordOf(call, sub.operationId);
    check(
      "询问期间 main 的 closing 在场且槽仍指向在飞那条",
      mid.slot === sub.operationId && (await opsStatus(call)).data?.closing === true,
      { slot: mid.slot, closing: (await opsStatus(call)).data?.closing },
    );
    // 询问期间第二入口被 main 拒（closing 是 main 事实，不看界面置灰）
    const secondId = freshUuid();
    const second = await bridgeCreate(
      call,
      s0.data?.epoch,
      secondId,
      `${MARK} 询问期间的第二入口 ${rand()}`,
    );
    const secondRec = (await recordOf(call, secondId)).rec;
    check(
      "询问期间第二主动入口被 main 拒 ⇒ OPERATION_NOT_ACCEPTED 且登记 notAccepted",
      second.ok === false &&
        second.error?.code === "OPERATION_NOT_ACCEPTED" &&
        secondRec?.state === "notAccepted",
      { code: second.error?.code, state: secondRec?.state },
    );
    check(
      "被拒那条零副作用：零模型请求、零新增文件",
      mock.served() === servedBefore + 1 && H.traceIds().size === idsAtFlight.size,
      { served: mock.served(), files: H.traceIds().size },
    );
    // 返回：退出被阻止，原在飞照常收口（不自动执行被拒那条）
    const drained = await drainDialogs(0);
    check(
      "quit 协商可返回（点击-核对-重试排空）",
      drained.clean && drained.rounds.length >= 1,
      drained.rounds.map((r) => ({ h: r.hwnd, after: r.after })),
    );
    const alive = await winops("alive");
    check(
      "用户选择返回 ⇒ 窗口仍在",
      String(parseLines(alive.lines).window ?? "").includes("iswindow=True"),
      parseLines(alive.lines).window ?? null,
    );
    const after = await recordOf(call, sub.operationId);
    check(
      "返回解除 closing 但不释放执行槽：那条仍 running、槽仍指向它",
      after.slot === sub.operationId && after.rec?.state === "running",
      { slot: after.slot, state: after.rec?.state },
    );
    const secondRec2 = (await recordOf(call, secondId)).rec;
    check(
      "返回后被拒那条不自动执行：仍 notAccepted、零新文件",
      secondRec2?.state === "notAccepted" && H.traceIds().size === idsAtFlight.size,
      { state: secondRec2?.state, files: H.traceIds().size },
    );
    const settled = await waitMainSettled(call, sub.operationId, 120000);
    check(
      "原在飞照常收口（返回不打断执行、也不重放）",
      settled?.state === "settled" && mock.served() === servedBefore + 1,
      { state: settled?.state, served: mock.served() },
    );
    const entry = await (async () => {
      const runId = settled?.runIds?.[0] ?? null;
      if (runId === null) return null;
      // 读取项键 = `epoch|operationId|runId`（与 resultReads.byKey 同源，6.6 同口径）
      const key = `${sub.epoch}|${sub.operationId}|${runId}`;
      const deadline = Date.now() + 30000;
      for (;;) {
        const all = await H.storeQ(call, "return JSON.stringify(s.resultReads.byKey);");
        const hit = all[key] ?? null;
        if (hit !== null && hit.phase !== "reading") return hit;
        if (Date.now() > deadline) return hit;
        await H.sleep(400);
      }
    })();
    check(
      "收口后结果按可信 ID 核实（verified / 正常结束）",
      entry !== null && entry.phase === "verified",
      entry?.phase ?? null,
    );
    await H.shot(call, SHOT_DIR, `${TAG}-quit-return.png`);
  },
};

// ---------------------------------------------------------------------------

async function main() {
  const page = await H.cdpConnect(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  SESSION.call = call;
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  // 带换文档自证的重载（U4 6.6 纪律：reload 不换文档 ⇒ 一切"重载后"判据凭空成立）
  await H.ev(call, "(() => { window.__u567Doc = (window.__u567Doc ?? 0) + 1; return true; })()");
  await call("Page.reload", { ignoreCache: true });
  let swapped = false;
  for (let i = 0; i < 80; i++) {
    await H.sleep(400);
    try {
      const doc = await H.ev(call, "(() => window.__u567Doc ?? null)()");
      if (doc === null) {
        swapped = true;
        break;
      }
    } catch {
      swapped = true;
      break;
    }
  }
  if (!swapped) throw new Error("Page.reload 未换文档（__u567Doc 仍在）——重载判据会全部假绿");
  for (let i = 0; i < 60; i++) {
    await H.sleep(500);
    try {
      if ((await H.runs(call)).length > 0) {
        await H.sleep(800);
        break;
      }
    } catch {
      /* 重载瞬间 */
    }
  }

  let mock = null;
  for (let attempt = 0; attempt < 2 && mock === null; attempt++) {
    try {
      mock = await H.prepare(call, TAG_SCRIPT[TAG]);
    } catch (e) {
      if (attempt > 0 || !String(e).includes("Failed to fetch")) throw e;
      console.log("[prepare] 模块加载失败，reload 后重试一次");
      await H.ev(call, "(() => { location.reload(); return true; })()");
      await H.sleep(4000);
    }
  }
  try {
    await FLOWS[TAG](call, mock);
  } catch (e) {
    check(`tag 执行异常：${String(e?.stack ?? e).slice(0, 600)}`, false);
  } finally {
    try {
      // teardown 有界化：退出类 tag 跑完时应用可能已真退出 ⇒ 不套超时会挂到看门狗
      await Promise.race([
        H.teardown(SESSION.call ?? call, mock),
        new Promise((r) => setTimeout(r, 15000)),
      ]);
    } catch {
      /* 尽力而为 */
    }
  }
  finish({ expectedCalls: EXPECTED_CALLS[TAG] });
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
