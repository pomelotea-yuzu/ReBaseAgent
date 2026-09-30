/* eslint-disable */
/**
 * U5 任务 6.8（第七批受控实机）：代表宽度 + 独立 200% 缩放 + 真键盘 + 只读指纹 + live 区域 a11y。
 *
 * 覆盖 evidence-index「实机入口 = 6.8」各计划 tag（沿用同名 tag，§7.3 才对得上账）：
 * real-keyboard / widths-1440-1210-1024-800 / narrow-keyboard-panel / readonly-fingerprint /
 * live-region-a11y / zoom200。
 *
 * 判据口径：
 * - 改窗走 `.workbuddy/ps-win.ps1`（SW_RESTORE + MoveWindow；外框→CSS 是近似值，必须按
 *   `documentElement.clientWidth` 实测回差 ±1px 微调，U2 6.8 坐实过 1134⇒801 的假档位）；
 * - 真键盘走 `lib/u3-65-input.ps1`（keybd_event 系统级输入；Tab/Shift+Tab/Esc 不涉 IME 组合，
 *   imm/hkl 状态只记录不断言——本 tag 不打字母）；模态在场时 Raise=0（真实用户抬不动前台）；
 * - zoom200 用 dev 启动环境变量 `REBASEAGENT_ZOOM_FACTOR=2`（主进程 did-finish-load 钩子），
 *   真 zoom 金标准 = DPR > 3.5；⚠️ zoom 会写进 Preferences 的 per_host_zoom_levels 且重启仍生效
 *   ⇒ 由 run-all 对 Preferences 做快照/还原；
 * - 只读指纹 = 逐文件 sha256 前后差集为空 + 对照支（一次真创建 ⇒ 恰 +1 份）证明判据有牙；
 * - live 区域只记 DOM/可访问属性证据（aria-live=polite、文本更新、重复快照不变化），
 *   **未实测屏幕阅读器，不宣称已验证实际播报**。
 *
 * 用法：`node apps/desktop/scripts/u5-68-cdp.cjs --tag=<TAG>`；前置 dev 由 run-all 起
 *（zoom200 需要带 REBASEAGENT_ZOOM_FACTOR=2 的 dev，其余 tag 用默认 dev）。
 */
"use strict";
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { beginReadFault } = require("./lib/u5-read-faults.cjs");

const TAGS = [
  "real-keyboard",
  "widths-1440-1210-1024-800",
  "narrow-keyboard-panel",
  "readonly-fingerprint",
  "live-region-a11y",
  "zoom200",
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

const OUT_DIR = join(H.REPO, ".workbuddy", "u5", "u5-68");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-29-u5-68");
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const PS_WIN = join(H.REPO, ".workbuddy", "ps-win.ps1");
const INPUT_PS1 = join(H.REPO, "apps", "desktop", "scripts", "lib", "u3-65-input.ps1");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
if (!existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
const FX = JSON.parse(readFileSync(MANIFEST, "utf8"));

const MARK = "U5-68";
const OK_TURN = { content: `${MARK} 受控成功：一步答完。` };

/** 各 tag 的受控剧本。零执行 tag 用 418 兜底（任何一次消费都会留下痕迹 ⇒ 判据响亮地红） */
const NOT_CONSUMED = {
  turns: [{ mode: "fail", status: 418, content: `${MARK} 这个 tag 不该有任何模型调用` }],
};
const TAG_SCRIPT = {
  "real-keyboard": NOT_CONSUMED,
  "widths-1440-1210-1024-800": { turns: [OK_TURN], fallback: OK_TURN },
  "narrow-keyboard-panel": { turns: [OK_TURN], fallback: OK_TURN },
  "readonly-fingerprint": { turns: [OK_TURN], fallback: OK_TURN },
  // 两支真实结局对照：成功（可查看）+ 失败（另一个结局标签）⇒ live 文本两轮都更新
  "live-region-a11y": {
    turns: [OK_TURN, { mode: "fail", status: 503, content: `${MARK} 受控失败回合` }],
    fallback: OK_TURN,
  },
  zoom200: { turns: [OK_TURN], fallback: OK_TURN },
};
const EXPECTED_CALLS = {
  "real-keyboard": 0,
  "widths-1440-1210-1024-800": 1,
  "narrow-keyboard-panel": 1,
  "readonly-fingerprint": 1,
  "live-region-a11y": 2,
  zoom200: 1,
};

// ---------------------------------------------------------------------------
// 检查与落盘（6.6/6.7 同构）
// ---------------------------------------------------------------------------

const checks = [];
const dump = {};
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
      "ps-win.ps1": sha12(PS_WIN),
      "u3-65-input.ps1": sha12(INPUT_PS1),
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
// 读数（真 store / 真 IPC）
// ---------------------------------------------------------------------------

const opsStatus = (call) => H.apiCall(call, "operationsStatus");
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  const rec = (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null;
  return { rec, slot: st?.data?.activeOperationId ?? null, epoch: st?.data?.epoch ?? null };
};
const createSubmission = (call) =>
  H.storeQ(
    call,
    `const x = s.draftSubmissions.byId["|create"];
     return JSON.stringify(x === undefined ? null : {
       token: x.token, operationId: x.operationId, epoch: x.epoch,
       revision: x.submittedRevision, submittedAt: x.submittedAt ?? null });`,
  );
const resultReadFor = async (call, epoch, operationId, runId) => {
  const key = `${epoch}|${operationId}|${runId}`;
  const all = await H.storeQ(call, "return JSON.stringify(s.resultReads.byKey);");
  return all[key] ?? null;
};
async function waitForVerified(call, epoch, operationId, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = await resultReadFor(call, epoch, operationId, runId);
    if (entry !== null && entry.phase !== "reading") return entry;
    if (Date.now() > deadline) return entry;
    await H.sleep(400);
  }
}
/** 显式只读重试（store 真动作，与面板「重读」同一入口） */
const retryRead = (call, x) =>
  H.storeQ(
    call,
    `const e = await s.retryResultRead({ epoch: ${JSON.stringify(x.epoch)}, operationId: ${JSON.stringify(x.operationId)}, runId: ${JSON.stringify(x.runId)} });
     return JSON.stringify({ phase: e.phase, attempt: e.attempt, reason: e.reason ?? null });`,
  );
const liveText = (call) =>
  H.ev(
    call,
    `(() => { const el = document.getElementById('result-live');
      return el === null ? null : (el.textContent || '').trim(); })()`,
  );
const activeElInfo = (call) =>
  H.ev(
    call,
    `(() => { const a = document.activeElement;
      if (a === null) return null;
      return { tag: a.tagName, text: ((a.textContent||'').trim()).slice(0, 30),
               aria: a.getAttribute('aria-label'), title: a.getAttribute('title'),
               ariaControls: a.getAttribute('aria-controls'),
               inCreateSection: a.closest('section[aria-label="新建运行"]') !== null,
               inDialog: a.closest('dialog[open]') === null ? null
                 : a.closest('dialog[open]').getAttribute('aria-label'),
               inHeader: a.closest('header') !== null }; })()`,
  );
const dialogStack = (call) =>
  H.ev(
    call,
    `(() => JSON.stringify(Array.from(document.querySelectorAll('dialog[open]'))
      .map(d => d.getAttribute('aria-label'))))()`,
  );

// ---------------------------------------------------------------------------
// 页内动作（创建 / 面板 / 编辑器 —— 复用 6.6/6.7 已验证实现）
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
  const view = await H.storeQ(call, "return JSON.stringify({ view: s.view });");
  if (view.view !== "create") throw new Error(`点「新建运行」后 view=${view.view}，不在创建工作区`);
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
async function waitForCreateSettled(call, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sub = await createSubmission(call);
    const st = await H.storeQ(call, "return JSON.stringify({ creating: s.creatingRun });");
    if (sub === null && st.creating !== "in_progress") return true;
    if (Date.now() > deadline) return false;
    await H.sleep(500);
  }
}
/** 通用受控创建：打开 → 填任务 → 确认 → 提交 → 等收口 → 读自动核实条目 */
async function runCreate(call, mock, task) {
  const servedBefore = mock.served();
  await openCreate(call);
  await fillUserMessage(call, task);
  await confirmSubmission(call);
  const sub = await submitCreateAndCapture(call);
  if (typeof sub.operationId !== "string") throw new Error(`创建未登记：${JSON.stringify(sub)}`);
  const settled = await waitForCreateSettled(call);
  if (!settled) throw new Error(`创建未收口：${task}`);
  const { rec, epoch } = await recordOf(call, sub.operationId);
  if (rec?.state !== "settled") throw new Error(`登记未收口：${JSON.stringify(rec)}`);
  const runId = rec.runIds[0] ?? null;
  if (runId === null) throw new Error("settled 无 runId");
  const entry = await waitForVerified(call, epoch, sub.operationId, runId);
  if (mock.served() - servedBefore !== 1) throw new Error(`创建调用数异常：${mock.served()}`);
  return { operationId: sub.operationId, sub, epoch, runId, entry, rec };
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
async function clickRowAction(call, opId, label, wait = 1200) {
  const r = await H.ev(
    call,
    `(() => {
      const panel = document.getElementById('operations-panel');
      if (panel === null) return 'no-panel';
      const lis = Array.from(panel.querySelectorAll('li')).filter(li => (li.className || '').includes('mt-1'));
      const row = lis.find(li => (li.textContent || '').includes(${JSON.stringify(opId)}));
      if (!row) return 'no-row';
      const btn = Array.from(row.querySelectorAll('button'))
        .find(b => ((b.textContent || '').trim()).includes(${JSON.stringify(label)}) && b.offsetParent !== null);
      if (!btn) return 'no-button';
      if (btn.disabled) return 'disabled';
      btn.click(); return 'clicked';
    })()`,
  );
  if (r !== "clicked") throw new Error(`行内点「${label}」失败（${opId.slice(0, 8)}）：${r}`);
  await H.sleep(wait);
}
async function openSettingsViaBar(call) {
  const ok = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '运行配置');
      if (!b) return 'no-button'; b.focus(); b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked") throw new Error(`全局栏找不到「运行配置」：${ok}`);
  await H.sleep(900);
  const open = await H.ev(
    call,
    `(() => document.querySelector('dialog[open][aria-label="运行配置"]') !== null)()`,
  );
  if (open !== true) throw new Error("设置模态未打开");
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
const resultEditorOpen = (call) =>
  H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('[data-confirm-execution]'))
        .find(x => x.offsetParent !== null);
      return b !== undefined; })()`,
  );

// ---------------------------------------------------------------------------
// 系统通道：改窗（ps-win.ps1）与真键盘（u3-65-input.ps1）—— node 直 spawn，不经 Bash
// ---------------------------------------------------------------------------

function runPs1(script, args) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("close", () => resolve(out.trim()));
    child.on("error", (e) => resolve(String(e)));
  });
}
/**
 * u3-65-input.ps1 的回执行写在 **OutFile**（stdout 只有 "lines=N"，与 u3-64-winops 同构）
 * ⇒ 必须读文件并剥 BOM（U3 6.4 纪律）。
 */
async function inputPs(action, extra = []) {
  PS_SEQ_TRACK.n += 1;
  const outFile = join(OUT_DIR, `input-${process.pid}-${PS_SEQ_TRACK.n}.txt`);
  await runPs1(INPUT_PS1, [
    "-Action",
    action,
    "-ProcId",
    String(MAIN_PID),
    "-OutFile",
    outFile,
    ...extra,
  ]);
  let txt = "";
  try {
    txt = readFileSync(outFile, "utf8");
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  } catch {
    txt = "";
  }
  return parseLines(txt);
}
/** 把窗口外框设到给定尺寸；返回 ps-win 的 stdout 回报行（这个脚本走 stdout） */
async function setWindowSize(outerW, outerH) {
  return runPs1(PS_WIN, ["-OuterWidth", String(outerW), "-OuterHeight", String(outerH)]);
}
/**
 * 改窗到目标 CSS 宽度：外框→CSS 是近似映射（DPR 2.1 下 ≈×1.41；200% zoom 下 ≈×2.82），
 * 必须按 `documentElement.clientWidth` 实测回差微调——收敛用**实测比例反解**
 * （outer = target / (css/outer)），加法修正在 zoom2 下不收敛（U2 6.8 坐实 1134⇒801 假档位）。
 */
async function resizeToCssWidth(call, cssTarget, outerHeight = 1050) {
  let outer = Math.round(cssTarget * 1.412);
  let last = "";
  let cssWidth = null;
  for (let i = 0; i < 5; i++) {
    last = await setWindowSize(outer, outerHeight);
    await H.sleep(700);
    cssWidth = await H.ev(call, "(() => document.documentElement.clientWidth)()");
    if (typeof cssWidth === "number" && Math.abs(cssWidth - cssTarget) <= 1) {
      return { cssWidth, outerWidth: outer, outerHeight, ps: last, settled: true };
    }
    if (typeof cssWidth !== "number" || cssWidth <= 0) break;
    outer = Math.max(400, Math.round(cssTarget / (cssWidth / outer)));
  }
  return { cssWidth, outerWidth: outer, outerHeight, ps: last, settled: false };
}
let MAIN_PID = 0;
const PS_SEQ_TRACK = { n: 0 };
function parseLines(text) {
  const out = {};
  for (const l of String(text ?? "").split(/\r?\n/)) {
    const i = l.indexOf("=");
    if (i < 0) continue;
    const k = l.slice(0, i);
    const v = l.slice(i + 1);
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}
async function resolveMainPid() {
  const info = await inputPs("resolve");
  const n = Number(info["main-pid"]);
  MAIN_PID = Number.isInteger(n) && n > 0 ? n : 0;
  return { pid: MAIN_PID, info };
}
/** 真键盘（keybd_event 系统级）：tokens 如 "TAB,TAB,ESC"；模态在场用 Raise=0 */
async function realKeys(tokens, { raise = "1", gapMs = 90 } = {}) {
  const info = await inputPs("keys", ["-Send", tokens, "-Raise", raise, "-GapMs", String(gapMs)]);
  if (info.RESULT === undefined || !String(info.RESULT).includes("sent")) {
    throw new Error(`真键盘发送失败：${JSON.stringify(info).slice(0, 200)}`);
  }
  await H.sleep(500);
  return info;
}
/** 抬前台 + 记录键盘布局 / IME 状态（观察项，本批不打字母 ⇒ 不做 IME 组合断言） */
async function raiseForeground() {
  return inputPs("fg");
}

// ---------------------------------------------------------------------------

/** store 级选中运行：窄档/200% 下导航整列收起、复制按钮不在 DOM ⇒ 不能走 H.selectRun（U4 6.8 同坑） */
async function selectRunAnywhere(call, runId) {
  const cur = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId });");
  if (cur.sel === runId) return true;
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(runId)});
     return JSON.stringify({ sel: s.selectedRunId });`,
  );
  await H.sleep(1200);
  const after = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId });");
  return after.sel === runId;
}

const FLOWS = {
  /**
   * A7.2 / M6.1 6.8 半边「创建页面键盘可离开而模态约束焦点」：真 Tab/Shift+Tab/Esc——
   * 创建页（非模态）焦点可离开；设置模态（top layer）Tab 禁闭；真 Esc 关闭并恢复焦点。
   */
  "real-keyboard": async (call, mock) => {
    void mock;
    const resolved = await resolveMainPid();
    check("已唯一认定 dev 主进程 PID（真键盘通道前置）", resolved.pid > 0, resolved.info);
    const fg = await raiseForeground();
    check(
      "前置：主窗口真实在前台（keybd_event 的落点就是它）",
      String(fg.foreground ?? "").includes("same=True"),
      fg,
    );
    dump.ime = {
      hkl: fg.hkl ?? null,
      immOpen: fg["imm-open"] ?? null,
      immConv: fg["imm-conv"] ?? null,
    };
    // —— 创建页：焦点可离开（不是模态禁闭） ——
    await openCreate(call);
    await H.ev(
      call,
      `(() => { const i = document.querySelector('#create-user-message'); if (i) i.focus(); return true; })()`,
    );
    const walk = [];
    let leftSection = false;
    for (let i = 0; i < 6; i++) {
      await realKeys("SHIFT+TAB", { raise: "0" });
      const a = await activeElInfo(call);
      walk.push({
        press: i + 1,
        inCreate: a?.inCreateSection ?? null,
        tag: a?.tag ?? null,
        text: a?.text ?? null,
      });
      if (a !== null && a.inCreateSection === false) {
        leftSection = true;
        break;
      }
    }
    dump.createTabWalk = walk;
    check(
      "真 Shift+Tab 可离开创建工作区（焦点不禁闭；创建页不是模态）",
      leftSection === true,
      walk,
    );
    check(
      "创建页无模态在场（对照：离开时没有 top layer 拦着）",
      (await dialogStack(call)) === "[]",
      await dialogStack(call),
    );
    // —— 设置模态：Tab 禁闭（top layer 原生保证） ——
    await openSettingsViaBar(call);
    const confine = [];
    let escaped = false;
    for (let i = 0; i < 6; i++) {
      await realKeys("TAB", { raise: "0" });
      const a = await activeElInfo(call);
      confine.push({ press: i + 1, inDialog: a?.inDialog ?? null, tag: a?.tag ?? null });
      if (a !== null && a.inDialog !== "运行配置") {
        escaped = true;
        break;
      }
    }
    dump.modalTabWalk = confine;
    check(
      "真 Tab 在设置模态内禁闭（top layer 原生约束；模态对照面成立）",
      escaped === false,
      confine,
    );
    // —— 真 Esc：关闭设置并恢复焦点到触发入口 ——
    await realKeys("ESC", { raise: "0" });
    const stack = await dialogStack(call);
    check("真 Esc ⇒ 设置关闭（合成路径在真键盘下同样成立）", stack === "[]", stack);
    const focus1 = await activeElInfo(call);
    check(
      "关闭后焦点恢复到触发入口（全局栏「运行配置」）",
      focus1 !== null && String(focus1.title ?? "").includes("配置 LLM 接入"),
      focus1,
    );
    await H.shot(call, SHOT_DIR, `${TAG}.png`);
  },

  /**
   * A7.1「长任务路径模型与结果不遮挡操作」：四个代表宽度下操作面板受视口约束、
   * 长任务文本/长 ID 不撑破横向布局、操作入口保持可点。
   */
  "widths-1440-1210-1024-800": async (call, mock) => {
    const longTask =
      `${MARK} 长任务：D:\\projects\\very-long-path\\nested\\deep\\folder-structure\\with-a-very-long-file-name-example.txt 的一步步分析，含超长路径与超长任务描述文本`.repeat(
        3,
      );
    const created = await runCreate(call, mock, longTask);
    check(
      "前置：长任务创建收口且按可信 ID 核实",
      created.entry?.phase === "verified",
      created.entry?.phase ?? null,
    );
    const widths = [];
    for (const target of [1440, 1210, 1024, 800]) {
      const r = await resizeToCssWidth(call, target);
      check(
        `宽度 ${target}：改窗实测 CSS 宽度落点（±1px）`,
        r.settled === true && Math.abs(r.cssWidth - target) <= 1,
        { cssWidth: r.cssWidth, outer: r.outerWidth, ps: r.ps },
      );
      const selected = await selectRunAnywhere(call, created.runId);
      check(
        `宽度 ${target}：长任务 run 在场（store 级选中，窄档导航收起不走 DOM 行）`,
        selected === true,
        selected,
      );
      await openOperationsPanel(call);
      const geo = await H.ev(
        call,
        `(() => {
          const panel = document.getElementById('operations-panel');
          if (panel === null) return JSON.stringify({ error: 'no-panel' });
          const pr = panel.getBoundingClientRect();
          const de = document.documentElement;
          const entry = document.querySelector('button[aria-controls="operations-panel"]');
          const er = entry === null ? null : entry.getBoundingClientRect();
          const hit = entry === null ? null : document.elementFromPoint(er.left + er.width / 2, er.top + er.height / 2);
          return JSON.stringify({
            panelW: Math.round(pr.width), panelH: Math.round(pr.height),
            innerW: window.innerWidth, innerH: window.innerHeight,
            pageScrollW: de.scrollWidth, pageClientW: de.clientWidth,
            idShown: panel.innerText.includes(${JSON.stringify(created.operationId)}),
            taskShown: panel.innerText.includes("长任务"),
            entryVisible: entry !== null && entry.offsetParent !== null,
            entryHit: hit !== null && (hit === entry || entry.contains(hit)),
          });
        })()`,
      );
      const g = typeof geo === "string" ? JSON.parse(geo) : geo;
      const row = { target, cssWidth: r.cssWidth, ...g };
      widths.push(row);
      check(
        `宽度 ${target}：面板受视口宽度约束（≤90vw）且不超视口高`,
        g.panelW <= g.innerW * 0.9 + 1 && g.panelH <= g.innerH + 1,
        row,
      );
      check(
        `宽度 ${target}：页面无横向溢出（长任务/长 ID 断行生效）`,
        g.pageScrollW <= g.pageClientW + 1,
        { scrollW: g.pageScrollW, clientW: g.pageClientW },
      );
      check(
        `宽度 ${target}：长操作 ID 完整在场（断行呈现，不是截断丢字）`,
        g.idShown === true,
        null,
      );
      check(
        `宽度 ${target}：操作入口可见且命中测试可点（长内容不遮挡操作）`,
        g.entryVisible === true && g.entryHit === true,
        row,
      );
      await closeOperationsPanel(call);
      const focus = await activeElInfo(call);
      check(
        `宽度 ${target}：✕ 关闭后焦点回到触发入口`,
        focus !== null && focus.ariaControls === "operations-panel",
        focus?.ariaControls ?? null,
      );
    }
    dump.widths = widths;
    await H.shot(call, SHOT_DIR, `${TAG}-last-width.png`);
  },

  /** M7.4「操作入口在窄窗口和键盘下可达」：800px 窄档 + 真键盘激活（焦点 + Enter 开合） */
  "narrow-keyboard-panel": async (call, mock) => {
    const resolved = await resolveMainPid();
    check("已唯一认定 dev 主进程 PID", resolved.pid > 0, resolved.info);
    const created = await runCreate(call, mock, `${MARK} 窄档键盘可达任务`);
    const r = await resizeToCssWidth(call, 800);
    check("前置：改窗实测 CSS 800（±1px）", r.settled === true && Math.abs(r.cssWidth - 800) <= 1, {
      cssWidth: r.cssWidth,
      outer: r.outerWidth,
      ps: r.ps,
    });
    const fg = await raiseForeground();
    check(
      "前置：主窗口在前台（真键盘落点正确）",
      String(fg.foreground ?? "").includes("same=True"),
      fg,
    );
    // 真键盘激活操作入口：CDP 只负责把焦点放上去，开合由真实 Enter 完成
    const focused = await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
        if (!b) return false; b.focus(); return document.activeElement === b; })()`,
    );
    check("前置：操作入口可聚焦（button 可聚焦且带 aria 关系）", focused === true, null);
    const aria = await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
        return b === null ? null : { expanded: b.getAttribute('aria-expanded'), controls: b.getAttribute('aria-controls') }; })()`,
    );
    check(
      "入口 aria 关系在场（aria-expanded / aria-controls）",
      aria?.expanded === "false" && aria?.controls === "operations-panel",
      aria,
    );
    await realKeys("ENTER", { raise: "0" });
    const opened = await H.ev(
      call,
      `(() => document.getElementById('operations-panel') !== null)()`,
    );
    const expanded = await H.storeQ(
      call,
      `return JSON.stringify({ expanded: document.querySelector('button[aria-controls="operations-panel"]').getAttribute('aria-expanded') });`,
    );
    check(
      "真 Enter ⇒ 面板打开（aria-expanded 翻 true）",
      opened === true && expanded.expanded === "true",
      { opened, expanded },
    );
    const geo = await H.ev(
      call,
      `(() => {
        const panel = document.getElementById('operations-panel');
        const pr = panel.getBoundingClientRect();
        const de = document.documentElement;
        return JSON.stringify({ panelW: Math.round(pr.width), innerW: window.innerWidth,
          pageScrollW: de.scrollWidth, pageClientW: de.clientWidth,
          idShown: panel.innerText.includes(${JSON.stringify(created.operationId)}) });
      })()`,
    );
    const g = typeof geo === "string" ? JSON.parse(geo) : geo;
    check("800px：面板受视口宽度约束（≤90vw）", g.panelW <= g.innerW * 0.9 + 1, g);
    check("800px：页面无横向溢出（长 ID 断行生效）", g.pageScrollW <= g.pageClientW + 1, {
      scrollW: g.pageScrollW,
      clientW: g.pageClientW,
    });
    check("800px：长操作 ID 完整在场", g.idShown === true, null);
    await realKeys("ENTER", { raise: "0" });
    const closed = await H.ev(
      call,
      `(() => document.getElementById('operations-panel') === null)()`,
    );
    const collapsed = await H.storeQ(
      call,
      `return JSON.stringify({ expanded: document.querySelector('button[aria-controls="operations-panel"]').getAttribute('aria-expanded') });`,
    );
    check(
      "再按真 Enter ⇒ 面板收起（aria-expanded 回 false）",
      closed === true && collapsed.expanded === "false",
      { closed, collapsed },
    );
    await H.shot(call, SHOT_DIR, `${TAG}-narrow.png`);
  },

  /**
   * A7.3 / M2.4「只读反馈和读取重试保持数据边界」：浏览/编辑器开合/重试全程逐文件 sha256
   * 差集为空；对照支一次真创建 ⇒ 恰 +1 份（判据有牙）。
   */
  "readonly-fingerprint": async (call, mock) => {
    const servedBefore = mock.served();
    await resizeToCssWidth(call, 1210);
    const base = H.hashAllTraces();
    // —— 只读动作一轮：选中运行 / 切页签 / 选 span / 开合时间旅行编辑器 / 文件页往返 / 面板开合 ——
    await H.selectRun(call, FX.normalRun);
    await H.clickTabChecked(call, "步骤");
    await H.clickSpan(call, "read_file", "s_03");
    await openPlainResultEditor(call, FX.normalRun, "s_03");
    const editorWasOpen = await resultEditorOpen(call);
    await H.ev(call, "(() => { document.activeElement?.blur?.(); return true; })()");
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
    await H.sleep(700);
    const editorClosed = await resultEditorOpen(call);
    check(
      "编辑器开合正常（对照：只读动作真的发生了）",
      editorWasOpen === true && editorClosed === false,
      { editorWasOpen, editorClosed },
    );
    await H.clickTabChecked(call, "概览");
    await openOperationsPanel(call);
    await closeOperationsPanel(call);
    const diff1 = {};
    const after1 = H.hashAllTraces();
    for (const [n, v] of Object.entries(after1))
      if (base[n] !== v) diff1[n] = { before: base[n], after: v };
    for (const n of Object.keys(base))
      if (after1[n] === undefined) diff1[n] = { before: base[n], after: "deleted" };
    check(
      "只读动作一轮 ⇒ traces 逐文件 sha256 差集为空（零写入）",
      Object.keys(diff1).length === 0,
      diff1,
    );
    // —— 对照支：一次真创建 ⇒ 恰 +1 份（判据有牙，不是"一律不变"的假判据） ——
    const created = await runCreate(call, mock, `${MARK} 指纹对照创建`);
    const after2 = H.hashAllTraces();
    const added = Object.keys(after2).filter((n) => base[n] === undefined);
    check(
      "对照：真创建 ⇒ 恰新增 1 份 trace（指纹判据有牙）",
      added.length === 1 && after2[`${created.runId}.jsonl`] !== undefined,
      added,
    );
    // —— 读取重试也零写入：注入 fileMissing ⇒ 重读 unreadable ⇒ 还原 ⇒ 重读 verified ——
    const fault = beginReadFault({ tracesDir: H.TRACES, runId: created.runId }, "fileMissing");
    const bad = await retryRead(call, {
      epoch: created.epoch,
      operationId: created.operationId,
      runId: created.runId,
    });
    check(
      "注入期间重读 ⇒ unreadable（attempt 递增）",
      bad.phase === "unreadable" && bad.attempt === 2,
      bad,
    );
    const midHash = H.hashAllTraces();
    const restore = fault.end();
    check("注入还原逐字节核验通过（无残留）", restore.clean === true, {
      restoreError: restore.restoreError,
      diff: restore.diff,
    });
    const good = await retryRead(call, {
      epoch: created.epoch,
      operationId: created.operationId,
      runId: created.runId,
    });
    check("还原后重读 ⇒ verified", good.phase === "verified", good);
    // ⚠️ 重试段的零写入基线必须是**注入前**的 after2：注入期间目标文件被隐藏本身就是一个
    // "差集"（midHash 里它不在场），拿 midHash 当基线会把还原误判成写入（首跑假红根因）
    const after3 = H.hashAllTraces();
    const diff3 = {};
    for (const [n, v] of Object.entries(after3))
      if (after2[n] !== v) diff3[n] = { before: after2[n], after: v };
    for (const n of Object.keys(after2))
      if (after3[n] === undefined) diff3[n] = { before: after2[n], after: "deleted" };
    check(
      "重试全程（unreadable ⇄ verified）零写入（差集为空，基线=注入前）",
      Object.keys(diff3).length === 0,
      diff3,
    );
    check("恰一次模型调用（对照创建）", mock.served() - servedBefore === 1, mock.served());
    await H.shot(call, SHOT_DIR, `${TAG}.png`);
  },

  /**
   * A5.4 6.8 半边「恢复核对重试与批次结果只通知」+ A2.3 面板 ✕ 焦点回位：
   * 面板关闭态 live 区域恒渲染且 polite，真实结局落地时文本更新、重复快照不变、焦点不变。
   * ⚠️ 只记 DOM/可访问属性证据，未实测屏幕阅读器，不宣称已验证实际播报。
   */
  "live-region-a11y": async (call, mock) => {
    const srEvidence = { note: "未实测屏幕阅读器 ⇒ 只记 DOM/可访问属性证据，不宣称已验证实际播报" };
    dump.sr = srEvidence;
    /** 提交后**立刻离页**（选中夹具 run）⇒ 落地不导航（代次 drop）⇒ 通知保持未读 ⇒ live 文本更新。
     *  不能用留在创建页的 runCreate：自动导航会打开结果 ⇒ 通知当场标已看（markNoticesSeen 触发面）。
     */
    async function createAndLeave(task) {
      const servedBefore = mock.served();
      await openCreate(call);
      await fillUserMessage(call, task);
      await confirmSubmission(call);
      const sub = await submitCreateAndCapture(call);
      if (typeof sub.operationId !== "string")
        throw new Error(`创建未登记：${JSON.stringify(sub)}`);
      await H.selectRun(call, FX.normalRun);
      const deadline = Date.now() + 60000;
      for (;;) {
        const { rec } = await recordOf(call, sub.operationId);
        if (rec !== null && rec.state === "settled") {
          const runId = rec.runIds[0] ?? null;
          if (runId === null) throw new Error("settled 无 runId");
          const entry = await waitForVerified(call, sub.epoch, sub.operationId, runId);
          if (mock.served() - servedBefore !== 1)
            throw new Error(`创建调用数异常：${mock.served()}`);
          return { operationId: sub.operationId, epoch: sub.epoch, runId, entry };
        }
        if (Date.now() > deadline) throw new Error(`创建未收口：${task}`);
        await H.sleep(500);
      }
    }
    // 面板关闭态：区域恒渲染、polite、sr-only（视觉零打扰）、不在任何焦点链上
    const live0 = await H.ev(
      call,
      `(() => { const el = document.getElementById('result-live');
        if (el === null) return null;
        return { tag: el.tagName, live: el.getAttribute('aria-live'), cls: el.className,
                 rendered: el.offsetParent !== null || el.getClientRects().length > 0,
                 text: (el.textContent || '').trim(),
                 focused: document.activeElement === el }; })()`,
    );
    check(
      "面板关闭态：live 区域恒渲染（空文本也不卸载）",
      live0 !== null && live0.rendered === true,
      live0,
    );
    check(
      "live 区域是 aria-live=polite 的 output（隐式 role=status）",
      live0?.tag === "OUTPUT" && live0?.live === "polite",
      live0,
    );
    check(
      "面板关闭态 live 区域不在焦点链上（不抢焦点、不弹模态）",
      live0?.focused === false,
      live0?.focused,
    );
    // 面板 ✕ 焦点回位（A2.3 6.8 半边）
    await openOperationsPanel(call);
    await closeOperationsPanel(call);
    const focusAfterX = await activeElInfo(call);
    check(
      "面板 ✕ 关闭后焦点回到触发入口（triggerRef.focus()）",
      focusAfterX !== null && focusAfterX.ariaControls === "operations-panel",
      focusAfterX?.ariaControls ?? null,
    );
    // 成功结局：面板关闭 + 用户已离页 ⇒ live 文本更新（真实结果变为可查看，通知保持未读）
    const created1 = await createAndLeave(`${MARK} 通知成功回合`);
    let text1 = null;
    const deadline = Date.now() + 20000;
    for (;;) {
      text1 = await liveText(call);
      if (text1 !== null && text1.length > 0) break;
      if (Date.now() > deadline) break;
      await H.sleep(400);
    }
    check(
      "成功收口（面板关闭）⇒ live 文本更新：新建运行 + 可信 runId + 结局在场",
      text1?.includes("新建运行") && text1.includes("已有结果") && text1.includes(created1.runId),
      text1,
    );
    const focusMid = await activeElInfo(call);
    await H.sleep(1600);
    const text1b = await liveText(call);
    const focusMid2 = await activeElInfo(call);
    check("重复快照（1.6s 后）文本逐字不变（不重复播报）", text1b === text1, {
      before: text1,
      after: text1b,
    });
    check(
      "等待期间焦点不变（live 区域不抢焦点）",
      JSON.stringify(focusMid) === JSON.stringify(focusMid2),
      { before: focusMid, after: focusMid2 },
    );
    // 失败结局：第二轮创建（受控 503，同样离页）⇒ live 文本随真实结局更新
    const created2 = await createAndLeave(`${MARK} 通知失败回合`);
    let text2 = null;
    const deadline2 = Date.now() + 20000;
    for (;;) {
      text2 = await liveText(call);
      if (text2 !== null && text2 !== text1) break;
      if (Date.now() > deadline2) break;
      await H.sleep(400);
    }
    check(
      "失败收口 ⇒ live 文本随真实结局更新（含新 runId；两轮通知并存或替换都是合法派生）",
      text2 !== null && text2 !== text1 && text2.includes(created2.runId),
      { text1, text2 },
    );
    const liveAttr = await H.ev(
      call,
      `(() => { const el = document.getElementById('result-live');
        return el === null ? null : { live: el.getAttribute('aria-live'), rendered: el.getClientRects().length > 0 }; })()`,
    );
    check(
      "两轮之后 live 区域仍是 polite 且恒渲染",
      liveAttr?.live === "polite" && liveAttr?.rendered === true,
      liveAttr,
    );
    await H.shot(call, SHOT_DIR, `${TAG}.png`);
  },

  /**
   * A7.1 / M7.4「独立 200% 缩放」：DPR > 3.5（真 zoom 金标准）下操作面板几何不破、
   * 设置模态受 85vh 钳制并内部滚动（长表单在框内滚，不撑破屏幕）。
   */
  zoom200: async (call, mock) => {
    const dpr = await H.ev(call, "(() => window.devicePixelRatio)()");
    check(
      "前置：DPR > 3.5（独立 200% 缩放的真 zoom 金标准）",
      typeof dpr === "number" && dpr > 3.5,
      dpr,
    );
    const r = await resizeToCssWidth(call, 908, 1400);
    dump.viewport = { cssWidth: r.cssWidth, dpr };
    const created = await runCreate(call, mock, `${MARK} 200% 缩放任务`);
    await openOperationsPanel(call);
    const geo = await H.ev(
      call,
      `(() => {
        const panel = document.getElementById('operations-panel');
        const pr = panel.getBoundingClientRect();
        const de = document.documentElement;
        const entry = document.querySelector('button[aria-controls="operations-panel"]');
        const er = entry.getBoundingClientRect();
        const hit = document.elementFromPoint(er.left + er.width / 2, er.top + er.height / 2);
        return JSON.stringify({ panelW: Math.round(pr.width), panelH: Math.round(pr.height),
          innerW: window.innerWidth, innerH: window.innerHeight,
          pageScrollW: de.scrollWidth, pageClientW: de.clientWidth,
          idShown: panel.innerText.includes(${JSON.stringify(created.operationId)}),
          entryHit: hit !== null && (hit === entry || entry.contains(hit)) });
      })()`,
    );
    const g = typeof geo === "string" ? JSON.parse(geo) : geo;
    check(
      "200%：面板受视口约束（≤90vw、不超视口高）",
      g.panelW <= g.innerW * 0.9 + 1 && g.panelH <= g.innerH + 1,
      g,
    );
    check("200%：页面无横向溢出（长 ID 断行）", g.pageScrollW <= g.pageClientW + 1, {
      scrollW: g.pageScrollW,
      clientW: g.pageClientW,
    });
    check("200%：长操作 ID 完整在场 + 入口命中可点", g.idShown === true && g.entryHit === true, g);
    await closeOperationsPanel(call);
    // 设置模态 85vh 钳制 + 内部滚动
    await openSettingsViaBar(call);
    const dlg = await H.ev(
      call,
      `(() => { const d = document.querySelector('dialog[open][aria-label="运行配置"]');
        if (!d) return null;
        const dr = d.getBoundingClientRect();
        return { h: Math.round(dr.height), innerH: window.innerHeight,
          clientH: d.clientHeight, scrollH: d.scrollHeight,
          overflowY: getComputedStyle(d).overflowY }; })()`,
    );
    check(
      "200%：设置模态受 85vh 钳制（框高 ≤ 85% 视口高）",
      dlg !== null && dlg.h <= dlg.innerH * 0.85 + 2,
      dlg,
    );
    check(
      "200%：长表单在框内滚动（内容超出框高且 overflow-y 可滚），不撑破屏幕",
      dlg !== null &&
        dlg.scrollH > dlg.clientH + 20 &&
        ["auto", "scroll", "overlay"].includes(String(dlg.overflowY)),
      dlg,
    );
    await H.clickInOpenDialog(call, "关闭", 900);
    check(
      "设置关闭（200% 往返无残留）",
      (await dialogStack(call)) === "[]",
      await dialogStack(call),
    );
    await H.shot(call, SHOT_DIR, `${TAG}-zoom200.png`);
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
  // 带换文档自证的重载（U4 6.6 纪律）
  await H.ev(call, "(() => { window.__u568Doc = (window.__u568Doc ?? 0) + 1; return true; })()");
  await call("Page.reload", { ignoreCache: true });
  let swapped = false;
  for (let i = 0; i < 80; i++) {
    await H.sleep(400);
    try {
      const doc = await H.ev(call, "(() => window.__u568Doc ?? null)()");
      if (doc === null) {
        swapped = true;
        break;
      }
    } catch {
      swapped = true;
      break;
    }
  }
  if (!swapped) throw new Error("Page.reload 未换文档（__u568Doc 仍在）——重载判据会全部假绿");
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
    const served = mock.served();
    check("受控服务调用数 = 目录期望", served === EXPECTED_CALLS[TAG], {
      served,
      expected: EXPECTED_CALLS[TAG],
    });
  } catch (e) {
    check(`tag 执行异常：${String(e?.stack ?? e).slice(0, 600)}`, false);
  } finally {
    try {
      await Promise.race([
        H.teardown(SESSION.call ?? call, mock),
        new Promise((r) => setTimeout(r, 15000)),
      ]);
    } catch {
      /* 尽力而为 */
    }
  }
  finish();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
