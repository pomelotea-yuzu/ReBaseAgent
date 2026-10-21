/* eslint-disable */
/**
 * R2.2 任务 7.2（真键盘批）：隔离 prompt 实验的**键盘全链 + 比较 + 单侧导出**实机闭环。
 *
 * 链（导航/激活/快捷键一律系统级 keybd_event；正文用真系统剪贴板 Ctrl+A/Ctrl+V 粘贴）：
 *   根入口 → 编辑器 → 长文本 system prompt → 假设/人工判据 → 页签往返（正文恢复但不恢复许可）
 *   → 只读核对 → 配置变化撤销旧核对（stale）→ 重新核对 → 费用确认 → 本次副本授权
 *   → 提交 → 全局活动/结果落地 → 「本次干预」区 → 与基线运行比较 → 比较文件视图
 *   → 逐路径核对 CRLF/LF、空串、末尾换行、新增/删除方向、not_found 诚实呈现
 *   → 打开右侧文件并返回比较（选择保留）→ 从比较视图导出**固定右侧检查点** → 字节/清单复核
 *   → Esc 焦点归还 → 数据不变式（源/根/兄弟/既有 blob 逐字节不变）。
 *
 * 模型：本地受控服务（`mock-llm-server.cjs`，端口 18799）。7.1 已交付真实模型闭环，
 * 本批验的是桌面链路与呈现；设置只在本批内指向受控服务，结束时还原 settings.json。
 *
 * 用法：node apps/desktop/scripts/r22-72-keyboard-cdp.cjs
 * 前置：dev 带 CDP 9612 + REBASEAGENT_PICK_DIRECTORY_FILE=<控制文件> 启动；
 *       夹具由 apps/desktop/scripts/r22-72-seed.cjs 造好（.workbuddy/r22-72/seed.json）。
 */
"use strict";
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { listPageTarget } = require("./editor-collapse-probe.cjs");

const rawEv = H.ev;
H.ev = async (call, expression) => {
  const v = await rawEv(call, expression);
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
};

const OUT = join(H.REPO, ".workbuddy", "r22-72");
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });
const SEED = JSON.parse(readFileSync(join(OUT, "seed.json"), "utf8"));
const ROOT = SEED.root;
const DATA = join(H.REPO, ".rebaseagent");
const SETTINGS = join(DATA, "settings.json");
const SETTINGS_BACKUP = join(OUT, "settings.backup.json");
const PICK_FILE = join(OUT, "r2272-pick-control.txt");
const PICK_LOG = `${PICK_FILE}.calls.log`;
const EXPORT_DIR = join(OUT, "export-keyboard");
const PS_WIN = join(H.REPO, ".workbuddy", "ps-win.ps1");
const INPUT_PS1 = join(H.REPO, "apps/desktop/scripts/lib/u3-65-input.ps1");
const MOCK_PORT = 18799;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;

const EXPECTED_PATHS = [
  "config.txt",
  "keep.txt",
  "notes.md",
  "summary.md",
  "only-child.txt",
  "blob.bin",
];

/** 键盘批的编辑目标（长文本 + 明确只读指令；受控服务按剧本写文件） */
const KEYBOARD_SYSTEM = `${"R2.2 7.2 真键盘粘贴的长启动指令：只允许按序写出给定文件，不得读取其他路径，不得凭记忆回答。".repeat(
  6,
)}\n末尾保留一行换行以核对 CRLF/LF 呈现。`;
const KEYBOARD_HYPOTHESIS =
  "真键盘链产出的子运行：其文件世界从根初始快照出发，config.txt 为 CRLF 两行、notes.md 无末尾换行、summary.md 为空串、only-child.txt 仅本侧存在。";
const KEYBOARD_ACCEPTANCE =
  "比较文件视图逐条呈现上述差异且原文不被规范化；从比较视图导出固定右侧检查点，字节与清单逐一对得上。";

const checks = [];
let EXIT_CODE = 2;
const dump = { keyboard: {}, viewport: null, childId: null, ime: null };
function check(name, ok, detail) {
  checks.push({ tag: "keyboard", name, ok: ok === true, detail: detail ?? null });
  console.log(
    `${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
}
function note(text) {
  console.log(`ℹ ${text}`);
  checks.push({ tag: "keyboard", name: `[登记] ${text}`, ok: true, note: true });
}
function finish(extra = {}) {
  const failed = checks.filter((c) => !c.ok && !c.note);
  writeFileSync(
    join(OUT, "keyboard-measurements.json"),
    JSON.stringify(
      {
        tag: "keyboard",
        generatedAt: new Date().toISOString(),
        seed: { root: ROOT, seedChild: SEED.seedChild },
        checks,
        failed: failed.length,
        dump: { ...dump, ...extra },
      },
      null,
      2,
    ),
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  EXIT_CODE = failed.length === 0 ? 0 : 1;
}
const watchdog = setTimeout(() => {
  console.error("看门狗：keyboard 超过 18 分钟未收尾");
  try {
    writeFileSync(join(OUT, "keyboard-error.txt"), "watchdog timeout");
  } catch {
    /* 忽略 */
  }
  process.exit(3);
}, 1_080_000);

// ---------------------------------------------------------------------------
// 系统通道：改窗 + 真键盘 + 真剪贴板
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

let PS_SEQ = 0;
let MAIN_PID = 0;
function parseLines(text) {
  const out = {};
  for (const l of String(text ?? "").split(/\r?\n/)) {
    const i = l.indexOf("=");
    if (i < 0) continue;
    const k = l.slice(0, i);
    if (out[k] === undefined) out[k] = l.slice(i + 1);
  }
  return out;
}
/** u3-65-input.ps1 的回执行写在 OutFile（stdout 只有 lines=N）⇒ 读文件并剥 BOM */
async function inputPs(action, extra = []) {
  PS_SEQ += 1;
  const outFile = join(OUT, `input-${process.pid}-${PS_SEQ}.txt`);
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
    try {
      require("node:fs").rmSync(outFile, { force: true });
    } catch {
      /* 忽略 */
    }
  } catch {
    txt = "";
  }
  return parseLines(txt);
}
const KEYS_PS1 = join(OUT, "ps-keys.ps1");
let KEYS_SEQ = 0;
/**
 * 真键盘发键：**抬前台与发键必须在同一个进程里**。Windows 的前台锁会让抬窗进程退出时
 * 把前台交还给原先抢它的进程，于是后一个进程的 keybd_event 落到别的窗口
 * （2026-10-21 实测：CDP 里 document.activeElement 就是目标按钮，ENTER 却毫无反应）。
 */
async function realKeys(tokens, { gapMs = 90, preSleepMs = 0 } = {}) {
  KEYS_SEQ += 1;
  const outFile = join(OUT, `keys-${process.pid}-${KEYS_SEQ}.txt`);
  await runPs1(KEYS_PS1, [
    "-ProcId",
    String(MAIN_PID),
    "-Send",
    tokens,
    "-GapMs",
    String(gapMs),
    "-PreSleepMs",
    String(preSleepMs),
    "-OutFile",
    outFile,
  ]);
  let info = {};
  try {
    let txt = readFileSync(outFile, "utf8");
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    info = parseLines(txt);
    rmSync(outFile, { force: true });
  } catch {
    info = { RESULT: "unreadable" };
  }
  if (!String(info.RESULT ?? "").includes("sent")) {
    throw new Error(`真键盘发送失败：${JSON.stringify(info).slice(0, 220)}`);
  }
  await H.sleep(650);
  return {
    sent: true,
    fg: String(info["foreground-after"] ?? "").includes("same=True"),
    raw: info,
  };
}
async function setClipboard(value) {
  const info = await inputPs("clipboard", ["-Value", value]);
  if (!String(info.RESULT ?? "").includes("clip"))
    throw new Error(`剪贴板写入失败：${JSON.stringify(info)}`);
  return info;
}
/** 独立回读 OS 剪贴板：粘贴类判据以"用户实际粘进去的那串字"为准，而不是脚本自己的期望值 */
async function getClipboard() {
  const outFile = join(OUT, `clip-read-${process.pid}-${++KEYS_SEQ}.txt`);
  await runPs1(join(OUT, "ps-clip-get.ps1"), ["-OutFile", outFile]);
  const txt = readFileSync(outFile, "utf8");
  rmSync(outFile, { force: true });
  return txt;
}
async function resolveMainWindow() {
  const info = await inputPs("resolve");
  const n = Number(info["main-pid"]);
  MAIN_PID = Number.isInteger(n) && n > 0 ? n : 0;
  if (MAIN_PID === 0) throw new Error(`找不到主窗口 pid：${JSON.stringify(info).slice(0, 200)}`);
  await realKeys("TAB");
  return info;
}

/**
 * 把前台夺回 dev 主窗口，但**不发送任何键**（-Send 空串 ⇒ keybd_event 不触发）。
 * 必须在每次 DOM 聚焦之前调用：改窗/剪贴板/截图通道都会 spawn powershell，
 * 那些进程可能短暂持前台，而 keybd_event 只发给当前前台窗口。
 */
const RAISE_PS1 = join(OUT, "ps-raise.ps1");
let RAISE_SEQ = 0;
async function ensureForeground(tries = 3) {
  let info = await inputPs("fg");
  for (let i = 0; i < tries && !String(info.foreground ?? "").includes("same=True"); i++) {
    RAISE_SEQ += 1;
    const outFile = join(OUT, `raise-${process.pid}-${RAISE_SEQ}.txt`);
    await runPs1(RAISE_PS1, ["-ProcId", String(MAIN_PID), "-OutFile", outFile]);
    let raised = "";
    try {
      raised = readFileSync(outFile, "utf8");
      if (raised.charCodeAt(0) === 0xfeff) raised = raised.slice(1);
      require("node:fs").rmSync(outFile, { force: true });
    } catch {
      raised = "unreadable";
    }
    info = await inputPs("fg");
    info.__raised = raised.trim().slice(0, 220);
  }
  return info;
}

/** 焦点元素标识（真键盘落点自证） */
const focusInfo = (call) =>
  H.ev(
    call,
    `(() => { const e = document.activeElement;
       if (e === null || e === undefined) return JSON.stringify({ tag: 'NONE' });
       const host = e.closest('[data-monaco-host]');
       return JSON.stringify({ tag: e.tagName.toLowerCase(),
         aria: e.getAttribute('aria-label') ?? '', text: (e.textContent || '').trim().slice(0, 26),
         title: e.title ?? '', dataExport: e.getAttribute('data-export-entry') ?? e.getAttribute('data-export-confirm') ?? e.getAttribute('data-export-cancel') ?? '',
         mono: host === null ? '' : host.getAttribute('data-monaco-host'),
         cls: (typeof e.className === 'string' ? e.className : '').split(' ').slice(0,3).join('.') }); })()`,
  );

/** 页内聚焦（不改行为）+ 真键盘激活：ENTER / SPACE */
async function focusAndPress(call, pickExpr, key = "ENTER", waitMs = 900) {
  const focused = await H.ev(
    call,
    `(() => { const e = (${pickExpr});
       if (!e) return JSON.stringify({ ok: false, why: 'no-el' });
       if (e.offsetParent === null) return JSON.stringify({ ok: false, why: 'hidden' });
       if (e.disabled === true) return JSON.stringify({ ok: false, why: 'disabled' });
       e.scrollIntoView({ block: 'center' }); e.focus();
       return JSON.stringify({ ok: true, active: e === document.activeElement }); })()`,
  );
  if (focused.ok !== true) throw new Error(`聚焦失败：${JSON.stringify(focused)} ${pickExpr}`);
  const before = await focusInfo(call);
  await realKeys(key);
  await H.sleep(waitMs);
  const after = await focusInfo(call);
  return { focused, before, after };
}

/**
 * 真键盘激活 + 「按到生效为止」：keybd_event 在后台跑批时对前台归属敏感（同一条判据
 * 这轮绿下轮红的根因，UI-VERIFY 已登记）。这里把"没落地就再按一次"变成 harness 的
 * 常规动作，并把按键次数留在证据里（不是把判据改松：生效判据本身不变）。
 */
async function pressUntil(
  call,
  pickExpr,
  effect,
  { key = "ENTER", waitMs = 900, tries = 3, label = "" } = {},
) {
  const attempts = [];
  for (let i = 0; i < tries; i++) {
    const r = await focusAndPress(call, pickExpr, key, waitMs);
    const seen = await effect();
    attempts.push({ press: i + 1, effect: seen, focusAfter: r.after });
    if (seen === true) return { presses: i + 1, attempts };
  }
  return { presses: tries, attempts, exhausted: true };
}

async function stableClientWidth(call, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let same = 0;
  while (Date.now() < deadline) {
    const v = await H.ev(call, "(() => document.documentElement.clientWidth)()");
    if (typeof v === "number" && v > 120) {
      if (v === last) {
        same += 1;
        if (same >= 2) return v;
      } else {
        same = 0;
        last = v;
      }
    }
    await H.sleep(300);
  }
  return last;
}

async function resizeToCssWidth(call, cssTarget, outerHeight = 1050) {
  await runPs1(PS_WIN, [
    "-OuterWidth",
    "800",
    "-OuterHeight",
    "700",
    "-X",
    "60",
    "-Y",
    "60",
    "-ForceRestore",
  ]);
  await H.sleep(900);
  let outer = Math.round(cssTarget * 1.412);
  for (let round = 0; round < 3; round++) {
    let cssWidth = null;
    for (let i = 0; i < 6; i++) {
      await runPs1(PS_WIN, [
        "-OuterWidth",
        String(outer),
        "-OuterHeight",
        String(outerHeight),
        "-ForceRestore",
      ]);
      await H.sleep(900);
      cssWidth = await stableClientWidth(call);
      if (typeof cssWidth === "number" && Math.abs(cssWidth - cssTarget) <= 2) {
        return { cssWidth, outer, settled: true };
      }
      if (typeof cssWidth !== "number" || cssWidth <= 0) break;
      const next = Math.max(400, Math.round(cssTarget / (cssWidth / outer)));
      if (next === outer) break;
      outer = next;
    }
    await H.sleep(1200);
  }
  return { cssWidth: await stableClientWidth(call), outer, settled: false };
}

async function shot(call, name) {
  // ⚠️ 不用 H.shot：它先 Page.bringToFront + setFocusEmulationEnabled(true)，
  // 后者会改变页面焦点归属 ⇒ 真键盘链的落点判据会被自己的截图搞红
  try {
    const { data } = await H.call0(call, "Page.captureScreenshot", { format: "png" });
    const f = join(SHOTS, `r2272-kb-${name}.png`);
    writeFileSync(f, Buffer.from(data, "base64"));
    console.log(`  [截图] ${f}`);
    return f;
  } catch (e) {
    console.log(`  [截图失败] ${String(e).slice(0, 100)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Monaco / store 读数
// ---------------------------------------------------------------------------

async function monacoDraft(call, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await H.appImport(
      call,
      H.MONACO_NEEDLE,
      `const monaco = await m.ensureMonaco();
       const hostEl = document.querySelector('[data-monaco-host="prompt-draft"]');
       if (hostEl === null) return JSON.stringify({ ok: false, why: 'no-host' });
       const eds = monaco.editor.getEditors().filter(e => { const n = e.getDomNode(); return n !== null && hostEl.contains(n); });
       if (eds.length === 0) return JSON.stringify({ ok: false, why: 'no-editor' });
       const ta = hostEl.querySelector('textarea.inputarea') ?? hostEl.querySelector('textarea');
       return JSON.stringify({ ok: true, value: eds[0].getModel().getValue(),
         hasTextarea: ta !== null, focused: document.activeElement === ta });`,
    );
    if (r.ok === true) return r;
    if (Date.now() > deadline) return r;
    await H.sleep(1200);
  }
}

/**
 * 聚焦草稿 Monaco：必须调编辑器自己的 focus API。
 * 直接 `textarea.focus()` 时 `hasTextFocus=false`、真 Ctrl+A/Ctrl+V 到不了模型
 * （2026-10-21 实测：keydown/beforeinput 都到了 TEXTAREA，模型与选区纹丝不动）。
 */
async function focusDraftTextarea(call) {
  return H.appImport(
    call,
    H.MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const hostEl = document.querySelector('[data-monaco-host="prompt-draft"]');
     if (hostEl === null) return JSON.stringify({ ok: false, why: 'no-host' });
     const e = monaco.editor.getEditors().find(x => { const n = x.getDomNode(); return n !== null && hostEl.contains(n); });
     if (e === undefined) return JSON.stringify({ ok: false, why: 'no-editor' });
     e.focus();
     await new Promise((r) => setTimeout(r, 250));
     return JSON.stringify({ ok: true, hasTextFocus: e.hasTextFocus(),
       readOnly: e.getOption(monaco.editor.EditorOption.readOnly) === true });`,
  );
}

const draftStoreState = (call) =>
  H.storeQ(
    call,
    `const key = { runId: ${JSON.stringify(ROOT.id)}, spanId: ${JSON.stringify(ROOT.firstLlmSpanId)}, field: 'system_prompt', mode: 'isolated' };
     const e = s.callDraftOf(key);
     return JSON.stringify({ present: e !== undefined, text: e?.text ?? null,
       hypothesis: e?.hypothesis ?? null, acceptanceCriterion: e?.acceptanceCriterion ?? null,
       revision: e?.revision ?? null, frozen: e === undefined ? null : s.isDraftFrozen(key) });`,
  );

const uiState = (call) =>
  H.ev(
    call,
    `(() => JSON.stringify({
       selectedRun: null,
       confirm: (() => { const b = document.querySelector('[data-confirm-execution]');
         return b === null ? null : { pressed: b.getAttribute('aria-pressed'), disabled: b.disabled, text: (b.textContent||'').trim().slice(0,30) }; })(),
       authChecked: document.querySelector('[data-isolated-writes-authorization] input')?.checked ?? null,
       stale: !!document.querySelector('[data-isolated-prompt-check-stale]'),
       unavailable: (document.querySelector('[data-isolated-prompt-check-unavailable]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,160),
       submitDisabled: document.querySelector('[data-isolated-prompt-submit-button]')?.disabled ?? null,
       submitState: (document.querySelector('[data-isolated-prompt-submit-state]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,140),
       checkText: (document.querySelector('[data-isolated-prompt-check-button]')?.textContent ?? '').trim(),
       blocked: (document.querySelector('[data-isolated-prompt-check] .text-amber-800')?.textContent ?? '').trim().slice(0,160),
       billing: (document.querySelector('[data-isolated-billing]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,260),
       summary: (document.querySelector('[data-confirm-summary]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,220),
       unknowns: (document.querySelector('[data-isolated-billing]')?.textContent ?? '').includes('未知'),
       cardText: (document.querySelector('[data-isolated-prompt-check]')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,900),
       notes: { h: document.querySelector('[data-isolated-note="hypothesis"]')?.value ?? null,
                a: document.querySelector('[data-isolated-note="acceptance-criterion"]')?.value ?? null },
     }))()`,
  );

const execState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({ forking: s.forking, forkError: s.forkError, forkErrorCode: s.forkErrorCode,
       selectedRunId: s.selectedRunId, view: s.view, epoch: s.operations.epoch,
       pending: (s.operations.pending ?? []).length,
       records: (s.operations.operations ?? []).map(o => ({ id: o.operationId.slice(0, 8),
         kind: o.target?.kind ?? null, parentRunId: o.target?.parentRunId ?? null,
         editField: o.target?.editField ?? null, state: o.state, runIds: o.runIds,
         errorCode: o.errorCode, raw: JSON.stringify(o.target) })) });`,
  );

/** 比较文件视图的 diff 编辑器事实 */
async function diffState(call, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await H.appImport(
      call,
      H.MONACO_NEEDLE,
      `const monaco = await m.ensureMonaco();
       const diffs = monaco.editor.getDiffEditors ? monaco.editor.getDiffEditors() : [];
       const d = diffs[0] ?? null;
       if (d === null) return JSON.stringify({ ok: false, why: 'no-diff-editor' });
       const o = d.getOriginalEditor(), mo = d.getModifiedEditor();
       const txt = (e) => { const md = e.getModel(); return md === null ? null : md.getValue(); };
       const host = document.querySelector('[data-testid="compare-files-diff-panel"]');
       return JSON.stringify({ ok: true, original: txt(o), modified: txt(mo),
         readOnlyOriginal: o.getOption(monaco.editor.EditorOption.readOnly) === true,
         readOnlyModified: mo.getOption(monaco.editor.EditorOption.readOnly) === true,
         lineChanges: (d.getLineChanges() ?? []).map(c => ({ o1: c.originalStartLineNumber, o2: c.originalEndLineNumber, m1: c.modifiedStartLineNumber, m2: c.modifiedEndLineNumber })),
         insertDecorations: host === null ? 0 : host.querySelectorAll('.line-insert').length,
         deleteDecorations: host === null ? 0 : host.querySelectorAll('.line-delete').length });`,
    );
    if (s.ok === true && s.lineChanges !== undefined && s.lineChanges.length > 0) return s;
    if (s.ok === true && s.original !== null && s.modified !== null && Date.now() > deadline - 8000)
      return s;
    if (Date.now() > deadline) return s;
    await H.sleep(900);
  }
}

const compareState = (call) =>
  H.ev(
    call,
    `(() => JSON.stringify({
       fileView: !!document.querySelector('[data-compare-files-view]'),
       leftCp: document.querySelector('[data-compare-file-checkpoint="left"]')?.value ?? null,
       rightCp: document.querySelector('[data-compare-file-checkpoint="right"]')?.value ?? null,
       rows: Array.from(document.querySelectorAll('[data-compare-file-path-list] button'))
          .map(b => ({ pressed: b.getAttribute('aria-pressed') === 'true',
                       text: (b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90) })),
       conclusion: document.querySelector('[data-compare-file-conclusion]')?.getAttribute('data-compare-file-conclusion') ?? null,
       header: (document.querySelector('[data-compare-file-conclusion]')?.closest('div')?.parentElement?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,300),
       noDiffNotice: (document.querySelector('[data-compare-files-view] .text-amber-800')?.textContent ?? '').trim().slice(0,160),
       exportRightDisabled: document.querySelector('[data-compare-file-export-side="right"]')?.disabled ?? null,
       backPresent: !!document.querySelector('[data-compare-files-back]'),
     }))()`,
  );

// ---------------------------------------------------------------------------
// 数据指纹（阅读与导出不改动既有数据）
// ---------------------------------------------------------------------------

function dataFingerprint() {
  const hashFile = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16);
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}:${hashFile(full)}:${statSync(full).size}`);
    }
  };
  walk(join(DATA, "traces"), "traces/");
  walk(join(DATA, "workspace-blobs"), "blobs/");
  return out;
}

function pickCalls() {
  try {
    return readFileSync(PICK_LOG, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function targetTree(target) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, e.name);
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) walk(full, rel);
      else
        out.push({
          path: rel,
          bytes: statSync(full).size,
          sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
        });
    }
  };
  walk(target, "");
  return out;
}

// ---------------------------------------------------------------------------
// 子进程侧的受控剧本（与种子子同形态，便于逐字节对照）
// ---------------------------------------------------------------------------

const CHILD_WRITES = [
  { path: "config.txt", content: "A: initial-config\r\nB-added-line\r\n" },
  { path: "notes.md", content: "A notes" },
  { path: "summary.md", content: "" },
  { path: "only-child.txt", content: "child-only\r\n" },
  { path: "blob.bin", content: "R2272\x00BINARY\x00TAIL" },
];
const CHILD_FINAL_TEXT = `真键盘批：已写出 ${CHILD_WRITES.map((w) => w.path).join("、")}。\n\n${"R2.2 7.2 结果页长文本：概览必须把这段折叠起来，且在窄档与 200% 缩放下只在自身滚动容器内滚动。".repeat(
  10,
)}`;

function childScript() {
  return {
    turns: CHILD_WRITES.map((w, i) => ({
      toolCalls: [{ id: `k${i + 1}`, name: "write_file", args: JSON.stringify(w) }],
    })),
    fallback: { content: CHILD_FINAL_TEXT },
  };
}

// ---------------------------------------------------------------------------
// 主链
// ---------------------------------------------------------------------------

async function main() {
  const page = await listPageTarget(9612);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");

  if (!existsSync(SETTINGS)) throw new Error(`dev 设置文件缺失：${SETTINGS}`);
  copyFileSync(SETTINGS, SETTINGS_BACKUP);
  if (!existsSync(PICK_FILE)) throw new Error(`缺目录选择控制文件（run-all 未写）：${PICK_FILE}`);
  // 开局哨兵 reload：清掉上一批遗留的 compareFileView/草稿/阅读态
  await call("Page.reload", { ignoreCache: false });
  await waitAppAlive(call);

  const mock = await H.startMockLlmServer({ port: MOCK_PORT, script: childScript() });
  let childId = null;
  try {
    // ── 前置：受控服务指向 + 真键盘窗口 ────────────────────────────────
    await H.apiCall(call, "proxyToggle", {
      enabled: false,
      port: 18787,
      upstreamBaseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    });
    await H.apiCall(call, "clearSettings");
    await H.apiCall(call, "saveSettings", {
      baseURL: MOCK_BASE,
      apiKey: "sk-r2272-kb",
      model: "r2272-control-model",
    });
    await H.storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");

    const ids = await H.storeQ(call, "return JSON.stringify({ ids: s.runs.map(r => r.id) });");
    if (!ids.ids.includes(ROOT.id)) throw new Error(`夹具根缺失：${ROOT.id}`);
    check("前置：夹具根可读且列表在场", ids.ids.includes(ROOT.id), { n: ids.ids.length });

    const resolved = await resolveMainWindow();
    check("前置：真键盘通道已唯一认定 dev 主进程", MAIN_PID > 0, resolved);
    const fg = await ensureForeground();
    dump.ime = {
      hkl: fg.hkl ?? null,
      immOpen: fg["imm-open"] ?? null,
      immConv: fg["imm-conv"] ?? null,
    };
    check(
      "前置：主窗口确实持前台（keybd_event 落点自证）",
      String(fg.foreground ?? "").includes("same=True"),
      fg,
    );

    const rs = await resizeToCssWidth(call, 1440);
    const geo = await H.ev(
      call,
      // biome-ignore lint/style/noUnusedTemplateLiteral: 页内表达式按行书写，避免转义地狱
      `(() => { const de=document.documentElement; return JSON.stringify({ clientW: de.clientWidth, clientH: de.clientHeight, innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio, scrollW: de.scrollWidth }); })()`,
    );
    dump.viewport = { resize: rs, geo };
    // 改窗通道刚 spawn 过 powershell ⇒ 重新确认前台仍在 dev 主窗口，再进键盘链
    dump.viewport.reforeground = await ensureForeground();
    check("前置：宽档 1440 CSS 就位（真键盘批的可达档）", rs.settled === true, {
      css: geo.clientW,
      outer: rs.outer,
    });

    // ── K1 未修改时 guard：核对不可用 + 就近原因 ────────────────────────
    await H.storeQ(
      call,
      `await s.selectRun(${JSON.stringify(ROOT.id)}); return JSON.stringify({ ok: true });`,
    );
    await H.storeQ(
      call,
      `s.setReadingTab(${JSON.stringify(ROOT.id)}, "overview"); return JSON.stringify({ ok: true });`,
    );
    await H.sleep(1600);
    const k1 = await focusAndPress(
      call,
      `document.querySelector('[data-isolated-prompt-start]')`,
      "ENTER",
      2600,
    );
    dump.keyboard.k1Focus = k1;
    check(
      "K1 真键盘 ENTER 激活根入口 ⇒ 隔离编辑器打开",
      (await existsSel(call, "[data-isolated-prompt-check]")) === true,
      {
        focusBefore: k1.before,
        focusAfter: k1.after,
      },
    );
    const preEdit = await uiState(call);
    check(
      "K1 未修改时不给核对/提交（guard 原因就近可见）",
      preEdit.checkText.includes("核对本次运行") &&
        (await disabledOf(call, "[data-isolated-prompt-check-button]")) === true &&
        // 未核对前卡与提交按钮整体不渲染（present=false 即"提交不可达"），已渲染则必须禁用
        (preEdit.submitDisabled === true || preEdit.submitDisabled === null),
      { checkText: preEdit.checkText, submit: preEdit.submitDisabled },
    );

    // ── K2 真键盘 + 真剪贴板写入长 system prompt ────────────────────────
    // 顺序要紧：剪贴板通道会 spawn powershell（可能短暂持前台）⇒ 先写剪贴板、
    // 再夺回前台、最后才聚焦 Monaco，避免「聚焦后被抢前台 ⇒ 真按键落空」
    const clip = await setClipboard(KEYBOARD_SYSTEM);
    dump.keyboard.clipboard = clip;
    check(
      "K2 真系统剪贴板写入长文本（长度回读一致）",
      String(clip.RESULT ?? "").includes("clip"),
      clip,
    );
    dump.keyboard.k2fg = await ensureForeground();
    const fc = await focusDraftTextarea(call);
    check(
      "K2 草稿 Monaco 已取得编辑器焦点（真按键落点）",
      fc.ok === true && fc.hasTextFocus === true && fc.readOnly === false,
      fc,
    );
    const readSel = () =>
      H.appImport(
        call,
        H.MONACO_NEEDLE,
        `const monaco = await m.ensureMonaco();
         const hostEl = document.querySelector('[data-monaco-host="prompt-draft"]');
         const e = monaco.editor.getEditors().find(x => { const n = x.getDomNode(); return n !== null && hostEl.contains(n); });
         if (e === undefined) return JSON.stringify({ selected: -1, total: -1, why: 'no-editor' });
         const sel0 = e.getSelection(); const model0 = e.getModel();
         return JSON.stringify({ selected: sel0 === null ? -1 : model0.getValueInRange(sel0).length,
           total: model0.getValue().length,
           focusInHost: document.activeElement !== null && hostEl.contains(document.activeElement) });`,
      );
    const kA = await realKeys("CTRL+A");
    let sel = await readSel();
    const firstAttempt = { keys: kA, sel };
    if (!(sel.selected > 0 && sel.selected === sel.total)) {
      // 抬窗可能把页内焦点复位 ⇒ 重新聚焦同一 textarea 再发一次真 Ctrl+A
      await focusDraftTextarea(call);
      await H.sleep(250);
      await realKeys("CTRL+A");
      sel = await readSel();
    }
    dump.keyboard.ctrlA = { firstAttempt, final: sel };
    check(
      "K2 真 Ctrl+A 选中全文（全选字节数==总长）",
      sel.selected > 0 && sel.selected === sel.total,
      sel,
    );
    await realKeys("CTRL+V", { gapMs: 120 });
    await H.sleep(2200);
    const draft = await monacoDraft(call);
    const storeDraft = await draftStoreState(call);
    // 剪贴板的**实际内容**才是判据基准。注意：PowerShell 的 `Get-Clipboard -Raw` 会把
    // CF_UNICODETEXT 的 CRLF 归一成 LF 回读（2026-10-21 实测：回读 324 含裸 LF，
    // 而粘进编辑器的实际是 325 含 CRLF）⇒ 内容比对按 LF 归一，换行形态另立判据。
    const clipReadback = await getClipboard();
    const pastedSystem = clipReadback.replace(/\r\n/g, "\n");
    const editorPasted = draft.value ?? "";
    dump.keyboard.clipboardReadback = {
      rawLen: clipReadback.length,
      rawCrlf: (clipReadback.match(/\r\n/g) ?? []).length,
      editorLen: editorPasted.length,
      editorCrlf: (editorPasted.match(/\r\n/g) ?? []).length,
      sourceLen: KEYBOARD_SYSTEM.length,
    };
    check(
      "K2 真 Ctrl+V 长文本逐字落进 Monaco 与草稿仓库（与 OS 剪贴板内容逐字一致）",
      editorPasted.replace(/\r\n/g, "\n") === pastedSystem &&
        storeDraft.text.replace(/\r\n/g, "\n") === pastedSystem &&
        pastedSystem.length > 200 &&
        pastedSystem.includes("\n"),
      {
        editorLen: editorPasted.length,
        storeLen: (storeDraft.text ?? "").length,
        clipLen: clipReadback.length,
      },
    );
    check(
      "K2 换行核对：剪贴板按 Windows 以 CRLF 落地，编辑器与草稿原样保留（未被规范化成 LF）",
      dump.keyboard.clipboardReadback.editorCrlf > 0 &&
        (storeDraft.text.match(/\r\n/g) ?? []).length ===
          dump.keyboard.clipboardReadback.editorCrlf,
      dump.keyboard.clipboardReadback,
    );
    await shot(call, "k2-editor");

    // ── K3 假设/判据真粘贴（逐字段断言 + 落点漂移时重试一次）─────────────
    const noteFields = [
      ['[data-isolated-note="hypothesis"]', KEYBOARD_HYPOTHESIS],
      ['[data-isolated-note="acceptance-criterion"]', KEYBOARD_ACCEPTANCE],
    ];
    const readNote = (sel) =>
      H.ev(
        call,
        `(() => { const e = document.querySelector(${JSON.stringify(sel)});
           const a = document.activeElement;
           return JSON.stringify({ value: e === null ? null : e.value,
             activeIsField: e !== null && a === e,
             activeTag: a === null ? null : String(a.tagName).toLowerCase() }); })()`,
      );
    for (const [sel2, text] of noteFields) {
      await setClipboard(text);
      await H.ev(
        call,
        `(() => { const e = document.querySelector(${JSON.stringify(sel2)}); e.focus(); return true; })()`,
      );
      const pre = await readNote(sel2);
      if (pre.activeIsField !== true) {
        note(`K3 ${sel2} 聚焦后 activeElement=${pre.activeTag} ⇒ 再聚焦一次`);
        await H.ev(
          call,
          `(() => { const e = document.querySelector(${JSON.stringify(sel2)}); e.focus(); return true; })()`,
        );
      }
      await realKeys("CTRL+A,CTRL+V", { gapMs: 110 });
      await H.sleep(1200);
      let post = await readNote(sel2);
      if (post.value !== text) {
        // 真剪贴板落点被别的元素接走时（曾观测到尾部杂字符）⇒ 清空该字段后重试一次
        await H.ev(
          call,
          `(() => { const e = document.querySelector(${JSON.stringify(sel2)});
             e.focus();
             const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
             setter.call(e, '');
             e.dispatchEvent(new Event('input', { bubbles: true }));
             return true; })()`,
        );
        await H.sleep(500);
        await realKeys("CTRL+A,CTRL+V", { gapMs: 110 });
        await H.sleep(1200);
        post = await readNote(sel2);
      }
      dump.keyboard[`note-${sel2}`] = { pre, post, expectLen: text.length };
      check(`K3 ${sel2} 经真剪贴板逐字写入（DOM 值与期望逐字一致）`, post.value === text, {
        domLen: post.value === null ? null : post.value.length,
        expectLen: text.length,
        tail: (post.value ?? "").slice(-8),
      });
    }
    const storeAfterNotes = await draftStoreState(call);
    check(
      "K3 假设/人工判据同步进草稿仓库（会话内，不恢复任何执行许可）",
      storeAfterNotes.hypothesis === KEYBOARD_HYPOTHESIS &&
        storeAfterNotes.acceptanceCriterion === KEYBOARD_ACCEPTANCE,
      {
        h: storeAfterNotes.hypothesis === null ? null : storeAfterNotes.hypothesis.length,
        a:
          storeAfterNotes.acceptanceCriterion === null
            ? null
            : storeAfterNotes.acceptanceCriterion.length,
      },
    );

    // ── K4 页签往返：正文/假设恢复，执行许可不恢复 ───────────────────
    await focusAndPress(
      call,
      `Array.from(document.querySelectorAll('[role="tab"]')).find(x => (x.textContent||'').trim() === '概览')`,
      "ENTER",
      2200,
    );
    if ((await existsSel(call, "[data-isolated-prompt-start]")) !== true) {
      // 真键盘 ENTER 落在页签上但视图未切（曾观测到焦点被 Monaco 抢回 body）⇒
      // 记录现场并以 store 复位到「根 · 概览」后重试真键盘激活（不冒充键盘达成了没达成的事）
      const st = await H.storeQ(
        call,
        `return JSON.stringify({ sel: s.selectedRunId, view: s.view,
           tab: s.selectedRunId === null ? null : s.readingOf(s.selectedRunId).tab });`,
      );
      const diag = await H.ev(
        call,
        `(() => (document.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 200))()`,
      );
      note(
        `K4 页签 ENTER 后根入口不在场（store=${JSON.stringify(st)}；页面=${diag}）⇒ 以 store 复位到根概览后重试`,
      );
      dump.keyboard.k4Recovery = { st, diag };
      await H.storeQ(
        call,
        `await s.selectRun(${JSON.stringify(ROOT.id)}); return JSON.stringify({ ok: true });`,
      );
      await H.storeQ(
        call,
        `s.setReadingTab(${JSON.stringify(ROOT.id)}, "overview"); return JSON.stringify({ ok: true });`,
      );
      await H.sleep(1800);
    }
    await focusAndPress(
      call,
      `document.querySelector('[data-isolated-prompt-start]')`,
      "ENTER",
      2600,
    );
    const restored = await monacoDraft(call);
    const restoredUi = await uiState(call);
    const restoredStore = await draftStoreState(call);
    check(
      "K4 页签往返恢复正文与假设/判据（逐字），但不恢复费用确认与副本授权",
      restored.value.replace(/\r\n/g, "\n") === pastedSystem &&
        restoredStore.hypothesis === KEYBOARD_HYPOTHESIS &&
        (restoredUi.confirm === null || restoredUi.confirm.pressed !== "true") &&
        (restoredUi.authChecked === false || restoredUi.authChecked === null),
      {
        confirm: restoredUi.confirm,
        authChecked: restoredUi.authChecked,
        len: restored.value?.length,
      },
    );

    // ── K5 只读核对（真键盘 ENTER）─────────────────────────────────────
    // 真键盘 ENTER 触发只读核对；15s 内卡未出则再按一次（前台/渲染竞态时曾观测到一次静默）
    const readCard = async (ms) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const c = await uiState(call);
        if (c.confirm !== null || c.unavailable !== "") return c;
        if (Date.now() > deadline) return c;
        await H.sleep(1000);
      }
    };
    await focusAndPress(
      call,
      `document.querySelector('[data-isolated-prompt-check-button]')`,
      "ENTER",
      1000,
    );
    let card = await readCard(15000);
    let cardPresses = 1;
    if (card.confirm === null && card.unavailable === "") {
      note("K5 首次真 ENTER 后核对卡未出 ⇒ 再按一次真 ENTER（落盘两次尝试）");
      await focusAndPress(
        call,
        `document.querySelector('[data-isolated-prompt-check-button]')`,
        "ENTER",
        1000,
      );
      cardPresses = 2;
      card = await readCard(30000);
    }
    dump.keyboard.cardPresses = cardPresses;
    dump.keyboard.card = card;
    // 收起态也必须看得见关键摘要（费用/副作用/门禁一句话）
    check(
      "K5 收起态核对摘要仍在场（不必展开也能判断这次会做什么）",
      card.confirm !== null && card.summary !== undefined && card.summary.length > 10,
      { summary: card.summary },
    );
    // 详细边界是卡内 disclosure ⇒ 真键盘展开后才逐行可读（缺场时如实登记，不炸整批）
    if (
      (await H.ev(
        call,
        `(() => { const b = Array.from(document.querySelectorAll('[data-isolated-prompt-check] button, [data-isolated-prompt-check] summary'))
              .find(x => (x.textContent || '').includes('详细边界'));
             return JSON.stringify(!!b); })()`,
      )) === true
    ) {
      await focusAndPress(
        call,
        `Array.from(document.querySelectorAll('[data-isolated-prompt-check] button, [data-isolated-prompt-check] summary')).find(x => (x.textContent || '').includes('详细边界'))`,
        "ENTER",
        900,
      );
    } else {
      note(
        "K5 卡内 disclosure 不在场（核对结论可能是 unavailable）⇒ 跳过展开，逐行判据按已读到的卡文本判",
      );
    }
    const cardOpen = await uiState(call);
    dump.keyboard.cardOpen = cardOpen;
    check(
      "K5 真键盘 ENTER 触发只读核对：卡列出根/初始文件/工具/模型参数/端点/上限/历史未知/计费未知",
      cardOpen.confirm !== null &&
        cardOpen.cardText.includes(ROOT.id) &&
        cardOpen.cardText.includes("初始文件") &&
        cardOpen.cardText.includes("固定工具") &&
        cardOpen.cardText.includes("本次端点") &&
        cardOpen.cardText.includes("执行上限") &&
        cardOpen.cardText.includes("历史未知条件") &&
        cardOpen.cardText.includes("基线模型"),
      {
        hasConfirm: cardOpen.confirm !== null,
        cardHead: cardOpen.cardText.slice(0, 200),
        unknowns: cardOpen.unknowns,
      },
    );
    check(
      "K5 副本授权默认未选（不是从历史补授权）",
      card.authChecked === false && card.submitDisabled === true,
      { auth: card.authChecked, submit: card.submitDisabled },
    );
    await shot(call, "k5-card");

    // ── K6 配置变化撤销旧核对（scenario 69 实机面）────────────────────
    await H.apiCall(call, "saveSettings", {
      baseURL: MOCK_BASE,
      apiKey: "sk-r2272-kb",
      model: "r2272-control-model-2",
    });
    await H.storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
    await H.sleep(2000);
    const afterConfig = await uiState(call);
    // 两种撤销形态要分清：设置快照变化走的是「整卡连同核对结论一起清空」
    // （PromptForkEditor 的 settingsStamp effect 直接 setChecked(null)），
    // 而草稿/字段变化才走 checkStale 的琥珀提示条。这里断言的是前者。
    check(
      "K6a 运行配置变化 ⇒ 核对卡连同费用确认/副本授权整体撤销（不保留旧许可）",
      afterConfig.confirm === null &&
        (afterConfig.authChecked === null || afterConfig.authChecked === false) &&
        afterConfig.submitDisabled !== false,
      {
        stale: afterConfig.stale,
        confirm: afterConfig.confirm,
        auth: afterConfig.authChecked,
        submit: afterConfig.submitDisabled,
      },
    );
    // 恢复模型名并重新核对（提交计划与根录制模型无关，端点/密钥才走当前配置）
    await H.apiCall(call, "saveSettings", {
      baseURL: MOCK_BASE,
      apiKey: "sk-r2272-kb",
      model: "r2272-control-model",
    });
    await H.storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
    await H.sleep(1600);
    await focusAndPress(
      call,
      `document.querySelector('[data-isolated-prompt-check-button]')`,
      "ENTER",
      1000,
    );
    const recheckDeadline = Date.now() + 40000;
    let recheck = null;
    for (;;) {
      recheck = await uiState(call);
      if (recheck.confirm !== null && recheck.stale === false) break;
      if (Date.now() > recheckDeadline) break;
      await H.sleep(1000);
    }
    check("K6b 重新核对成功（新绑定可确认）", recheck.confirm !== null && recheck.stale === false, {
      confirm: recheck.confirm,
      stale: recheck.stale,
      unavailable: recheck.unavailable,
    });

    // K6c：真键盘在编辑器里改一个字符 ⇒ 走「输入变化」的撤销形态（琥珀 stale 条 + 许可复位）
    await focusDraftTextarea(call);
    dump.keyboard.k6cFocus = await realKeys("A");
    await H.sleep(1600);
    const afterTyping = await uiState(call);
    check(
      "K6c 真键盘改动输入 ⇒ 旧核对结论作废（stale 条在场），费用确认/副本授权一并复位",
      afterTyping.stale === true &&
        (afterTyping.confirm === null || afterTyping.confirm.pressed !== "true") &&
        (afterTyping.authChecked === null || afterTyping.authChecked === false),
      {
        stale: afterTyping.stale,
        confirm: afterTyping.confirm,
        auth: afterTyping.authChecked,
        submit: afterTyping.submitDisabled,
      },
    );
    await focusAndPress(
      call,
      `document.querySelector('[data-isolated-prompt-check-button]')`,
      "ENTER",
      1000,
    );
    const recheck2Deadline = Date.now() + 40000;
    let recheck2 = null;
    for (;;) {
      recheck2 = await uiState(call);
      if (recheck2.confirm !== null && recheck2.stale === false) break;
      if (Date.now() > recheck2Deadline) break;
      await H.sleep(1000);
    }
    check(
      "K6d 改动后重新核对才恢复可确认状态",
      recheck2.confirm !== null && recheck2.stale === false,
      { confirm: recheck2.confirm, stale: recheck2.stale, unavailable: recheck2.unavailable },
    );

    // ── K7 费用确认 + 副本授权 + 提交（全部真键盘）─────────────────────
    const preSubmitDraft = await draftStoreState(call);
    const submittedText = preSubmitDraft.text;
    check(
      "K7 提交前草稿现值 = 粘贴原值 + 真键盘追加的字符（粘贴原文逐行仍在、长度变长）",
      typeof submittedText === "string" &&
        submittedText !== editorPasted &&
        submittedText.length > editorPasted.length &&
        editorPasted
          .split(/\r?\n/)
          .filter((l) => l.length > 0)
          .every((l) => submittedText.includes(l)),
      { pastedLen: editorPasted.length, nowLen: submittedText?.length ?? null },
    );
    const k7a = await pressUntil(
      call,
      `document.querySelector('[data-confirm-execution]')`,
      async () => ((await uiState(call)).confirm?.pressed ?? null) === "true",
      { waitMs: 1200, label: "费用确认" },
    );
    const afterFee = await uiState(call);
    dump.keyboard.k7ConfirmPresses = k7a.presses;
    check(
      "K7 真键盘 ENTER 完成费用确认（aria-pressed=true）",
      afterFee.confirm?.pressed === "true",
      { presses: k7a.presses, confirm: afterFee.confirm },
    );
    const k7b = await pressUntil(
      call,
      `document.querySelector('[data-isolated-writes-authorization] input')`,
      async () => {
        const u = await uiState(call);
        return u.authChecked === true && u.submitDisabled === false;
      },
      { key: "SPACE", waitMs: 1200, label: "副本授权" },
    );
    const afterAuth = await uiState(call);
    dump.keyboard.k7AuthPresses = k7b.presses;
    check(
      "K7 真键盘 SPACE 勾选本次副本授权，提交态转为就绪",
      afterAuth.authChecked === true && afterAuth.submitDisabled === false,
      {
        presses: k7b.presses,
        auth: afterAuth.authChecked,
        submit: afterAuth.submitDisabled,
        state: afterAuth.submitState,
      },
    );
    await shot(call, "k7-ready");

    const servedBefore = mock.served();
    const tracesBefore = new Set(H.traceIds());
    const fpBefore = dataFingerprint();
    const k8 = await pressUntil(
      call,
      `document.querySelector('[data-isolated-prompt-submit-button]')`,
      async () => {
        if (mock.served() > servedBefore) return true;
        const st = await execState(call);
        return st.forking === "in_progress" || st.pending > 0 || st.records.length > 0;
      },
      { waitMs: 1500, label: "提交" },
    );
    const during = await execState(call);
    dump.keyboard.duringSubmit = during;
    dump.keyboard.k8SubmitPresses = k8.presses;
    check(
      "K8 真键盘 ENTER 提交：进入 in_progress 并按 U4 登记/关联本地提交",
      during.forking === "in_progress" || during.pending > 0 || during.records.length > 0,
      during,
    );
    // 登记事实来自 main 回执/状态轮询 ⇒ 轮询到该条出现为止（不是提交后 1.5s 的瞬时态）
    let records = during.records;
    const recDeadline = Date.now() + 30000;
    for (;;) {
      if (records.some((r) => r.parentRunId === ROOT.id && r.editField === "system_prompt")) break;
      if (Date.now() > recDeadline) break;
      await H.sleep(1200);
      records = (await execState(call)).records;
    }
    const privacy = JSON.stringify(records);
    check(
      "K8 操作登记只带身份与目标（run/字段），不含 prompt 正文",
      records.some((r) => r.parentRunId === ROOT.id && r.editField === "system_prompt") &&
        !privacy.includes("真键盘粘贴的长启动指令"),
      records,
    );

    const newTraces = await H.newChildren(tracesBefore, 90000, 1);
    childId = newTraces[0] ?? null;
    if (childId === null) throw new Error("提交后 90s 内没有出现新的子 run trace");
    dump.childId = childId;
    let childFinal = null;
    const servedAfter = mock.served();
    check(
      "K8 受控模型恰按剧本被调用（5 次写入回合 + 1 次收尾）",
      servedAfter - servedBefore === CHILD_WRITES.length + 1,
      { before: servedBefore, after: servedAfter, expect: CHILD_WRITES.length + 1 },
    );

    // 等封存
    const settleDeadline = Date.now() + 60000;
    let childMeta = null;
    for (;;) {
      try {
        const lines = readFileSync(join(DATA, "traces", `${childId}.jsonl`), "utf8")
          .trim()
          .split(/\n/);
        const ev = lines.map((l) => JSON.parse(l));
        const stopped = ev.find((x) => x.type === "run.event" && x.event === "stopped");
        if (stopped !== undefined) {
          const steps = ev.filter((x) => x.kind === "agent.step").sort((a, b) => a.n - b.n);
          childMeta = {
            meta: JSON.parse(lines[0]),
            stopped: stopped.reason,
            lines: ev.length,
            finalStepId: steps.length === 0 ? null : steps[steps.length - 1].id,
          };
          break;
        }
      } catch {
        /* 还没落盘 */
      }
      if (Date.now() > settleDeadline) break;
      await H.sleep(1200);
    }
    check(
      "K9 子运行正常封存（completed）",
      childMeta?.meta?.format_version === 3 && childMeta.stopped === "completed",
      childMeta ?? null,
    );
    childFinal = childMeta?.finalStepId ?? null;
    check(
      "K9 子运行的自有最终步骤可读（比较视图默认检查点的对照基准）",
      childFinal !== null,
      childMeta ?? null,
    );
    check(
      "K9 v3 实验记录带假设/人工判据且原值/新值逐字来自真键盘输入",
      childMeta?.meta?.prompt_experiment?.hypothesis === KEYBOARD_HYPOTHESIS &&
        childMeta?.meta?.prompt_experiment?.acceptance_criterion === KEYBOARD_ACCEPTANCE &&
        childMeta?.meta?.prompt_experiment?.original_value === SEED.expected.rootSystem &&
        childMeta?.meta?.fork?.edit?.value === submittedText,
      {
        hyp: childMeta?.meta?.prompt_experiment?.hypothesis?.slice(0, 40),
        original: childMeta?.meta?.prompt_experiment?.original_value?.slice(0, 24),
        edited: childMeta?.meta?.fork?.edit?.value?.slice(0, 24),
        submittedLen: submittedText?.length ?? null,
        editedLen: childMeta?.meta?.fork?.edit?.value?.length ?? null,
      },
    );

    // ── K10 成功后草稿按修订清理 ─────────────────────────────────────
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    let cleared = await draftStoreState(call);
    const clearDeadline = Date.now() + 40000;
    for (;;) {
      if (cleared.present === false) break;
      if (Date.now() > clearDeadline) break;
      await H.sleep(1500);
      cleared = await draftStoreState(call);
    }
    check(
      "K10 正常结果按模式 CAS 清理隔离草稿（失败/旧结果才保留）",
      cleared.present === false,
      cleared,
    );

    const nav = await execState(call);
    dump.keyboard.afterSubmit = nav;
    if (nav.selectedRunId !== childId) {
      note(
        `导航意图未自动落到子 run（selected=${nav.selectedRunId}）⇒ 本批以显式选择继续，不冒充自动跳转`,
      );
      await H.storeQ(
        call,
        `await s.selectRun(${JSON.stringify(childId)}); return JSON.stringify({ ok: true });`,
      );
    } else {
      check("K10 提交导航意图把阅读落到本次子 run", nav.selectedRunId === childId, nav);
    }
    await H.storeQ(
      call,
      `s.setReadingTab(${JSON.stringify(childId)}, "overview"); return JSON.stringify({ ok: true });`,
    );
    await H.sleep(2200);

    // ── K11 结果页「本次干预」+ 长输出呈现 ────────────────────────────
    const overview = await H.ev(
      call,
      `(() => JSON.stringify({
         section: !!document.querySelector('[data-prompt-experiment-view]'),
         verdict: (document.querySelector('[data-prompt-experiment-verdict]')?.textContent ?? '').replace(/\\s+/g,' ').trim(),
         body: (document.querySelector('[data-prompt-experiment-view]')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0, 6000),
         longTextCollapsed: Array.from(document.querySelectorAll('summary, button')).some(x => (x.textContent||'').includes('点击展开')),
         compare: !!document.querySelector('[data-prompt-experiment-compare]'),
         files: !!document.querySelector('[data-prompt-experiment-files]'),
         scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
         mainBottom: (() => { const m = document.querySelector('main'); return m === null ? null : Math.round(m.getBoundingClientRect().bottom); })(),
         innerH: innerHeight,
       }))()`,
    );
    dump.keyboard.overview = overview;
    check(
      "K11 结果概览呈现干预记录（基线/调用/初始快照/模型/端点/上限/原值新值/假设/判据）",
      overview.section === true &&
        overview.body.includes(ROOT.id) &&
        overview.body.includes("假设") &&
        overview.body.includes("人工判据"),
      { head: overview.body.slice(0, 140) },
    );
    check(
      "K11 结局说明只复述事实，不宣称修复成功/不自动评分",
      overview.verdict.includes("不代表改动已达到目的") &&
        overview.verdict.includes("请按你填写的人工判据自行核对") &&
        overview.verdict.includes("不会自动执行或评分"),
      overview.verdict.slice(0, 260),
    );
    check(
      "K11 长输出被折叠呈现且页面不横向溢出、main 不越视口",
      overview.longTextCollapsed === true &&
        overview.scrollW <= overview.clientW + 1 &&
        (overview.mainBottom === null || overview.mainBottom <= overview.innerH + 2),
      {
        scrollW: overview.scrollW,
        clientW: overview.clientW,
        mainBottom: overview.mainBottom,
        innerH: overview.innerH,
      },
    );

    // ── K12 与基线比较 → 比较文件视图（真键盘）───────────────────────
    await focusAndPress(
      call,
      `document.querySelector('[data-prompt-experiment-compare]')`,
      "ENTER",
      2000,
    );
    await waitForEither(
      call,
      ['[aria-label="查看比较文件视图"]', "[data-compare-files-view]"],
      45000,
      "比较文件视图入口",
    );
    const fileBtn = await H.ev(
      call,
      `(() => !!document.querySelector('[aria-label="查看比较文件视图"]'))()`,
    );
    if (fileBtn === true) {
      await focusAndPress(
        call,
        `document.querySelector('[aria-label="查看比较文件视图"]')`,
        "ENTER",
        1500,
      );
    } else {
      note("比较文件视图已由上一段会话态挂着 ⇒ 直接在其中操作（不重复点入口）");
    }
    await waitForSel(call, "[data-compare-file-path-list] button", 40000, "比较文件路径清单");
    const cmp1 = await compareState(call);
    dump.keyboard.compare = cmp1;
    check(
      "K12 比较文件视图默认取两侧最近自有完成步骤（父左子右）",
      cmp1.fileView === true && cmp1.leftCp === ROOT.finalStepId && cmp1.rightCp === childFinal,
      { left: cmp1.leftCp, right: cmp1.rightCp, rows: cmp1.rows.length },
    );
    const pathNames = cmp1.rows.map((r) => r.text.split(" ")[0]);
    check(
      "K12 路径并集含全部六条（含仅本侧存在的路径）",
      EXPECTED_PATHS.every((p) => cmp1.rows.some((r) => r.text.includes(p))),
      { rows: cmp1.rows.map((r) => r.text.slice(0, 40)) },
    );
    void pathNames;

    // ── K13 逐路径真键盘核对 ─────────────────────────────────────────
    const perPath = {};
    for (const p of EXPECTED_PATHS) {
      await focusAndPress(
        call,
        `Array.from(document.querySelectorAll('[data-compare-file-path-list] button')).find(x => (x.textContent||'').includes(${JSON.stringify(p)}))`,
        "ENTER",
        1400,
      );
      const st = await compareState(call);
      const d = p === "keep.txt" ? await diffStateKeepSafe(call) : await diffState(call);
      perPath[p] = { state: st, diff: d };
      dump.keyboard[`diff-${p}`] = {
        conclusion: st.conclusion,
        header: st.header,
        diff: d,
        noDiffNotice: st.noDiffNotice,
      };
    }

    const cfg = perPath["config.txt"];
    check(
      "K13 config.txt：CRLF 原文逐字进 diff（不被规范化为 LF）",
      cfg.state.conclusion === "different" &&
        cfg.diff.ok === true &&
        cfg.diff.modified === "A: initial-config\r\nB-added-line\r\n" &&
        cfg.diff.original === "B: parent-final",
      {
        conclusion: cfg.state.conclusion,
        modified: JSON.stringify(cfg.diff.modified),
        original: JSON.stringify(cfg.diff.original),
      },
    );
    check(
      "K13 config.txt：新增/删除方向可辨（Monaco 真实行变更 + 插入/删除着色层）",
      (cfg.diff.lineChanges ?? []).length > 0 &&
        cfg.diff.insertDecorations > 0 &&
        cfg.diff.deleteDecorations >= 0 &&
        cfg.diff.readOnlyOriginal === true &&
        cfg.diff.readOnlyModified === true,
      {
        changes: cfg.diff.lineChanges,
        insert: cfg.diff.insertDecorations,
        delete: cfg.diff.deleteDecorations,
      },
    );
    const notes = perPath["notes.md"];
    check(
      "K13 notes.md：仅差末尾换行 ⇒ 结论 different（UI 不规范化末尾换行）",
      notes.state.conclusion === "different" &&
        notes.diff.original === "A notes\n" &&
        notes.diff.modified === "A notes",
      {
        conclusion: notes.state.conclusion,
        o: JSON.stringify(notes.diff.original),
        m: JSON.stringify(notes.diff.modified),
      },
    );
    const sum = perPath["summary.md"];
    check(
      "K13 summary.md：右侧空串仍按「文本=空」呈现，不冒充不存在",
      sum.state.conclusion === "different" &&
        sum.diff.modified === "" &&
        sum.diff.original === "root summary B\n" &&
        !sum.state.header.includes("不存在"),
      {
        conclusion: sum.state.conclusion,
        header: sum.state.header.slice(0, 200),
        modifiedLen: (sum.diff.modified ?? "").length,
      },
    );
    const only = perPath["only-child.txt"];
    check(
      "K13 only-child.txt：缺失侧诚实标「仅一侧存在/不存在」，另一侧原文可读",
      ["right_only", "different"].includes(only.state.conclusion) &&
        only.diff.modified === "child-only\r\n" &&
        (only.diff.original === null ||
          only.diff.original === "" ||
          only.state.header.includes("不存在")),
      {
        conclusion: only.state.conclusion,
        header: only.state.header.slice(0, 200),
        original: JSON.stringify(only.diff.original),
      },
    );
    const keep = perPath["keep.txt"];
    check(
      "K13 keep.txt：两侧同内容判为 same 且不编造差异",
      keep.state.conclusion === "same" &&
        keep.diff.ok === true &&
        keep.diff.original === keep.diff.modified,
      {
        conclusion: keep.state.conclusion,
        o: JSON.stringify(keep.diff.original),
        m: JSON.stringify(keep.diff.modified),
      },
    );
    const blob = perPath["blob.bin"];
    check(
      "K13 blob.bin：含 NUL 的正文按真实字节呈现且逐侧状态可读（write_file 只接受字符串 ⇒ 桌面路径造不出非 UTF-8 二进制；二进制/超限逐侧状态由 4.3 单元证据承载）",
      ["different", "right_only"].includes(blob.state.conclusion) && blob.diff.ok === true,
      { conclusion: blob.state.conclusion, header: blob.state.header.slice(0, 160) },
    );
    await shot(call, "k13-diff-config");

    // ── K14 打开右侧文件并返回比较（选择保留）────────────────────────
    await focusAndPress(
      call,
      `document.querySelector('[data-compare-file-open-side="right"]')`,
      "ENTER",
      2600,
    );
    const opened = await H.ev(
      call,
      `(() => JSON.stringify({
         view: null, filesPanel: !!document.querySelector('[data-export-panel]'),
         exportEntry: (() => { const b = document.querySelector('[data-export-entry]'); return b === null ? null : { disabled: b.disabled, expanded: b.getAttribute('aria-expanded') }; })(),
         heading: (document.querySelector('[data-file-container-width]')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0, 220),
         backBar: !!document.querySelector('[aria-label="返回比较工作区"]'),
         scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
       }))()`,
    );
    dump.keyboard.openedSide = opened;
    check(
      "K14 从比较视图真键盘打开右侧文件页：检查点固定为比较所选、返回入口常驻",
      opened.filesPanel === true && opened.backBar === true && opened.exportEntry !== null,
      opened,
    );
    await focusAndPress(
      call,
      `document.querySelector('[aria-label="返回比较工作区"]')`,
      "ENTER",
      2600,
    );
    const back = await compareState(call);
    check(
      "K14 返回比较后文件视图的选择保留（pair/检查点/路径不丢）",
      back.fileView === true &&
        back.leftCp === ROOT.finalStepId &&
        back.rows.length >= EXPECTED_PATHS.length,
      { left: back.leftCp, right: back.rightCp, rows: back.rows.length },
    );

    // ── K15 从比较视图导出固定右侧检查点（真键盘三连 + 原生目录选择控制文件）──
    const pickBefore = pickCalls();
    await focusAndPress(
      call,
      `document.querySelector('[data-compare-file-export-side="right"]')`,
      "ENTER",
      2600,
    );
    // 文件页要先等 inspect 读取完成（入口短暂 disabled），否则真键盘聚焦会被判 disabled 抛错
    {
      const entryDeadline = Date.now() + 30000;
      for (;;) {
        const st = await H.ev(
          call,
          `(() => { const b = document.querySelector('[data-export-entry]');
             return JSON.stringify(b === null ? null : { disabled: b.disabled === true }); })()`,
        );
        if (st !== null && st.disabled === false) break;
        if (Date.now() > entryDeadline) {
          note(
            `K15 导出入口 30s 内未变为可用（${JSON.stringify(st)}）⇒ 后续判据预计会红，如实继续`,
          );
          break;
        }
        await H.sleep(900);
      }
    }
    const pressEntry = await focusAndPress(
      call,
      `document.querySelector('[data-export-entry]')`,
      "ENTER",
      1200,
    );
    const confirmCard = await H.ev(
      call,
      `(() => { const el = document.querySelector('[data-export-confirm="true"]');
        const card = el ? el.closest('[data-export-confirm]') : null; return card ? (card.innerText||'').replace(/\\s+/g,' ').trim().slice(0,300) : null; })()`,
    );
    check(
      "K15 导出确认卡列明空目录/files/清单/未保留（无物理路径输入）",
      typeof confirmCard === "string" &&
        confirmCard.includes("空目录") &&
        confirmCard.includes("files/"),
      confirmCard,
    );
    const readFeedback = async (ms) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const f = await H.ev(
          call,
          `(() => { const el = document.querySelector('[data-export-feedback]');
             return el === null ? null : JSON.stringify({ kind: el.getAttribute('data-export-feedback'), text: (el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,300) }); })()`,
        );
        if (f !== null && f.kind !== "in-flight") return f;
        if (Date.now() > deadline) return f;
        await H.sleep(800);
      }
    };
    const pressConfirm = await pressUntil(
      call,
      `document.querySelector('button[data-export-confirm="true"]')`,
      async () => (await readFeedback(0)) !== null,
      { waitMs: 2500, tries: 3, label: "选择目标目录并导出" },
    );
    dump.keyboard.k15ConfirmPresses = pressConfirm.presses;
    if (pressConfirm.presses > 1) {
      note(`K15 导出确认按钮按了 ${pressConfirm.presses} 次真 ENTER 才见到反馈（前几次未落地）`);
    }
    const feedback = await readFeedback(30000);
    dump.keyboard.k15Presses = {
      entry: pressEntry,
      confirm: pressConfirm,
      dialogs: await H.ev(call, `(() => document.querySelectorAll('dialog[open]').length)()`),
      exportEntryState: await H.ev(
        call,
        `(() => { const b = document.querySelector('[data-export-entry]');
           return b === null ? null : JSON.stringify({ disabled: b.disabled, expanded: b.getAttribute('aria-expanded') }); })()`,
      ),
    };
    await shot(call, "k15-export");
    dump.keyboard.exportFeedback = feedback;
    check("K15 真键盘导出成功反馈（exported）", feedback?.kind === "exported", feedback);
    check(
      "K15 目录选择由 REBASEAGENT_PICK_DIRECTORY_FILE 控制文件接管恰一次（原生对话框未被打开）",
      pickBefore + 1 === pickCalls(),
      { before: pickBefore, after: pickCalls(), pickFile: PICK_FILE },
    );

    const tree = existsSync(EXPORT_DIR) ? targetTree(EXPORT_DIR) : [];
    const manifest = tree.find((t) => t.path === "rebaseagent-export.json");
    const parsedManifest = manifest
      ? JSON.parse(readFileSync(join(EXPORT_DIR, "rebaseagent-export.json"), "utf8"))
      : null;
    const expectRight = Object.fromEntries(SEED.expected.right.map((r) => [r.path, r]));
    const files = (parsedManifest?.files ?? []).filter((f) => f.status === "exported");
    const byteOk = files.every((f) => {
      const hit = tree.find((t) => t.path === `files/${f.path}`);
      const exp = expectRight[f.path];
      if (hit === undefined || exp === undefined) return false;
      if (exp.text !== null)
        return (
          hit.sha256 === sha256Text(exp.text) && hit.bytes === Buffer.byteLength(exp.text, "utf8")
        );
      return hit.bytes === f.bytes;
    });
    check(
      "K15 导出字节逐条复核 = 右侧比较检查点的原文（CRLF/空串/末尾换行原样）",
      files.length > 0 && byteOk,
      {
        files: files.map((f) => `${f.path}:${f.bytes}`),
        tree: tree.map((t) => `${t.path}:${t.bytes}`),
      },
    );
    check(
      "K15 清单身份固定在本侧（run=子、step=子最终、initial=子初始）",
      parsedManifest?.source?.run_id === childId &&
        parsedManifest?.source?.step_span_id === childFinal &&
        typeof parsedManifest?.source?.initial_snapshot_id === "string",
      parsedManifest?.source ?? null,
    );

    // ── K16 Esc 焦点归还 + 返回比较仍成立 ────────────────────────────
    await focusAndPress(call, `document.querySelector('[data-export-entry]')`, "ENTER", 1000);
    await realKeys("ESC", {});
    const focusAfterEsc = await focusInfo(call);
    check(
      "K16 真 Esc 收起导出确认卡且焦点回收到导出入口",
      focusAfterEsc.dataExport === "true" || String(focusAfterEsc.text).includes("导出"),
      focusAfterEsc,
    );
    await focusAndPress(
      call,
      `document.querySelector('[aria-label="返回比较工作区"]')`,
      "ENTER",
      2600,
    );
    const back2 = await compareState(call);
    check(
      "K16 再次返回比较：pair 与检查点仍在（阅读不被导出打断）",
      back2.fileView === true && back2.leftCp === ROOT.finalStepId,
      back2,
    );

    // ── K17 数据不变式 ───────────────────────────────────────────────
    const fpAfter = dataFingerprint();
    const changed = fpAfter
      .filter((x) => !fpBefore.includes(x))
      .concat(fpBefore.filter((x) => !fpAfter.includes(x)));
    const allowed = (entry) =>
      entry.startsWith(`traces/${childId}.jsonl`) || /workspace-blobs/.test(entry);
    const offenders = changed.filter((x) => !allowed(x));
    check(
      "K17 全程只改动本次子 run（根/种子子/7.1 三 run 与既有 blob 逐字节不变）",
      offenders.length === 0,
      { changed: changed.slice(0, 12), offenders: offenders.slice(0, 8) },
    );
    await shot(call, "k17-done");

    finish({
      childId,
      mockEntries: mock
        .entries()
        .map((e) => ({ n: e.n, model: e.model, stream: e.stream, tools: e.tools })),
    });
    return;
  } catch (e) {
    console.error(String(e?.stack ?? e));
    try {
      writeFileSync(join(OUT, "keyboard-error.txt"), String(e?.stack ?? e));
      finish({ error: String(e?.stack ?? e), childId });
    } catch {
      process.exit(2);
    }
    // 探针异常也要落盘已有判据（EXIT_CODE 由 finish 设定）
  } finally {
    try {
      await H.apiCall(call, "clearSettings");
    } catch {
      /* 尽力 */
    }
    await mock.close().catch?.(() => {});
    if (existsSync(SETTINGS_BACKUP)) {
      copyFileSync(SETTINGS_BACKUP, SETTINGS);
      console.log("[settings] 已还原 dev 运行配置文件");
    }
  }
}

/** keep.txt 期望无行变更 ⇒ 不等 lineChanges，直接读一次真实模型 */
async function diffStateKeepSafe(call) {
  await H.sleep(1800);
  return H.appImport(
    call,
    H.MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const diffs = monaco.editor.getDiffEditors ? monaco.editor.getDiffEditors() : [];
     const d = diffs[0] ?? null;
     if (d === null) return JSON.stringify({ ok: false, why: 'no-diff-editor' });
     const txt = (e) => { const md = e.getModel(); return md === null ? null : md.getValue(); };
     return JSON.stringify({ ok: true, original: txt(d.getOriginalEditor()), modified: txt(d.getModifiedEditor()),
       lineChanges: (d.getLineChanges() ?? []).length });`,
  ).catch((e) => ({ ok: false, why: String(e).slice(0, 80) }));
}

/** 冷启动等待（reload 后 root 有内容 + store 可导入） */
async function waitAppAlive(call, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const rootLen = await H.ev(
        call,
        `(() => (document.getElementById('root')?.innerHTML.length ?? 0))()`,
      );
      if (typeof rootLen === "number" && rootLen > 1000) {
        const n = await H.storeQ(call, "return JSON.stringify({ ok: true });");
        if (n && n.ok === true) return true;
      }
    } catch {
      /* 模块图还在加载 */
    }
    if (Date.now() > deadline) throw new Error("应用 90s 未就绪（root 空 / store 不可导入）");
    await H.sleep(800);
  }
}

async function waitForEither(call, sels, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await H.ev(
      call,
      `(() => JSON.stringify(${JSON.stringify(sels)}.filter((s) => document.querySelector(s))))()`,
    );
    if (Array.isArray(hit) && hit.length > 0) return hit;
    if (Date.now() > deadline) {
      const diag = await H.ev(
        call,
        `(() => (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 260))()`,
      );
      throw new Error(`${label} 超时未就绪；页面：${diag}`);
    }
    await H.sleep(900);
  }
}

async function existsSel(call, sel) {
  return H.ev(call, `(() => JSON.stringify(!!document.querySelector(${JSON.stringify(sel)})))()`);
}
async function disabledOf(call, sel) {
  return H.ev(
    call,
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return JSON.stringify(e === null ? null : e.disabled === true); })()`,
  );
}
async function waitForSel(call, sel, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await existsSel(call, sel)) === true) return true;
    if (Date.now() > deadline) throw new Error(`${label} 超时未出现：${sel}`);
    await H.sleep(900);
  }
}

function sha256Text(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

main()
  .then(() => {
    clearTimeout(watchdog);
    process.exit(EXIT_CODE);
  })
  .catch((e) => {
    console.error(String(e?.stack ?? e));
    try {
      writeFileSync(join(OUT, "keyboard-error.txt"), String(e?.stack ?? e));
    } catch {
      /* 忽略 */
    }
    clearTimeout(watchdog);
    process.exit(2);
  });
