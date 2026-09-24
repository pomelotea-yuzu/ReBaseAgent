/**
 * U2 任务 5.6：重启 / 数据目录迁移 / 离线读取的**实机**验收。
 *
 * 覆盖（spec 四场景，见 `openspec/changes/improve-workspace-file-reading/specs/desktop-ui/spec.md`）：
 *   ① 重启后查看文件差异 —— 应用重启后打开**完成的隔离子 run**，选择完成步骤的**修改文件**，
 *      从 trace 引用加载初始/当前文本、显示真实差异与步骤来源，零文件写入、零 LLM。
 *   ② 数据目录迁移后文件仍可查 —— 整体移动后重新启动仍可读（无需原 source 路径）；
 *      只迁 JSONL（无附件）时明确显示**附件缺失**且轨迹可读。
 *   ③ 文件阅读状态不跨进程承诺 —— 重启后按首次进入策略选检查点：持久记录（trace）仍可重读，
 *      但阅读位置/内容副本/草稿/授权都不跨进程。
 *   ④ 文件阅读键盘操作与离线加载 —— 离线进入文件页并用键盘操作检查点/搜索/目录/宽度/工具栏；
 *      Monaco 从本地懒加载；返回列表聚焦原文件，关闭查找返回编辑器。
 *   另核：**普通 run 无伪文件页**，且现有概览/步骤/编辑/执行入口仍可达。
 *
 * ⚠️ 与 5.1–5.5 的关键差别（5.6 的题目本身要求）：**本脚本会重启 dev 应用、会临时移动数据目录**。
 *   - 重启：`node apps/desktop/scripts/u2-dev-host.cjs --stop` 后重新 spawn（按 PID 杀、绝不按映像名）。
 *   - 数据目录操作**全部是可逆重命名**，并在 `finally` 里还原；同时落一枚
 *     `.workbuddy/u2-56/RESTORE-NEEDED.txt` 标记，还原成功后删除（万一脚本中断可按标记手工还原）。
 *   - 仍**不伪造 deviceMetrics**（会破坏 Monaco automaticLayout），不改窗口尺寸。
 *
 * 用法（每次一个 tag）：
 *   node apps/desktop/scripts/u2-56-cdp.cjs --tag=probe
 *   node apps/desktop/scripts/u2-56-cdp.cjs --tag=restart-state
 *   node apps/desktop/scripts/u2-56-cdp.cjs --tag=first-enter
 *   node apps/desktop/scripts/u2-56-cdp.cjs --tag=migrate
 *   node apps/desktop/scripts/u2-56-cdp.cjs --tag=keyboard-offline
 *   node apps/desktop/scripts/u2-56-cdp.cjs --tag=compat
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, makeSession, ev, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u2-56");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-24-u2-56");
const OUT = join(OUT_DIR, "measurements.json");
const LIVE_DIR = join(REPO, ".rebaseagent");
const FIX56 = join(LIVE_DIR, "u2-file-fixtures-56");
const MANIFEST56 = join(FIX56, "MANIFEST-56.json");
const SRC56 = join(FIX56, "source");
const BLOBS_DIR = join(LIVE_DIR, "workspace-blobs");
const WORK_DIR = join(REPO, ".workbuddy", "u2-56");
const MOVE_DIR = join(WORK_DIR, "moved-data"); // 「整体迁移」的中转位置（不同绝对路径）
const BLOBS_BAK = join(WORK_DIR, "workspace-blobs-bak"); // 「仅迁 JSONL」临时移走的附件目录
const RESTORE_FLAG = join(WORK_DIR, "RESTORE-NEEDED.txt");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "probe");

if (!existsSync(MANIFEST56)) {
  throw new Error(
    `夹具清单不存在：${MANIFEST56}\n请先跑 node apps/desktop/scripts/gen-u2-56-fixtures.cjs`,
  );
}
const MF = JSON.parse(readFileSync(MANIFEST56, "utf8"));
const SUB_RUN = MF.隔离谱系.sub.id; // 隔离子 run（自有轮写入 ⇒ 初始 vs 完成步骤有真实差异）
const SUB_PARENT = MF.隔离谱系.sub.父;
const SUB_ROUND1 = MF.隔离谱系.sub.第一轮末;
const NORMAL_RUN = MF.普通run.id;
const NORMAL_ROOT = MF.普通run.parent;
const EDIT_RUN = MF.隔离谱系.root.id; // 「编辑」入口在自有工具 span 上验证（隔离根 run）
const TARGET_FILE = MF.目标文件;
const TEXT_ROOT_R2 = MF.文件世界.edit根第二轮.trim();
const TEXT_SUB = MF.文件世界.edit子run.trim();

const checks = [];
function check(name, ok, detail) {
  checks.push({ name: `[${TAG}] ${name}`, ok: !!ok, detail: detail ?? null });
}
function loadOut() {
  if (!existsSync(OUT)) return { tag: "u2-5.6", measurements: {}, checks: [] };
  return JSON.parse(readFileSync(OUT, "utf8"));
}
function saveOut(d) {
  d.capturedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(d, null, 2));
}

// ---------------------------------------------------------------------------
// 应用重启 / CDP 重连（5.6 特有）
// ---------------------------------------------------------------------------

const DEV_HOST = join(__dirname, "u2-dev-host.cjs");

/** 端口是否在监听（不能只看 u2-dev-host 的 pid 文件：pid 过期时它会静默认为"已在跑"） */
function portListening(port) {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  return (r.stdout ?? "")
    .split("\n")
    .some((line) => line.includes(`:${port} `) && line.includes("LISTENING"));
}

/** 按 PID 杀监听某端口的进程（绝不按映像名杀 electron.exe——WorkBuddy 自己就是 Electron） */
function killPort(port) {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  const pid = (r.stdout ?? "")
    .split("\n")
    .filter((line) => line.includes(`:${port} `) && line.includes("LISTENING"))
    .map((line) => line.trim().split(/\s+/).pop())
    .find((x) => /^\d+$/.test(x));
  if (pid === undefined) return null;
  spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { encoding: "utf8", windowsHide: true });
  return pid;
}

/**
 * 真重启：停 → **确认端口真的空出来** → 起 → 等 CDP + 名单就绪。
 * ⚠️ 只调 `--stop` 是不够的：pid 文件过期时 taskkill 失败、`--stop` 仍返回成功，
 *    紧接的启动会因端口仍被占用而打印「already listening」**直接返回**——
 *    那样"重启"就是假的，后续断言连接的还是旧进程。
 */
async function restartDevAndReconnect() {
  spawnSync(process.execPath, [DEV_HOST, "--stop"], { encoding: "utf8", windowsHide: true });
  for (let i = 0; i < 20 && portListening(PORT); i++) await sleep(500);
  let forced = null;
  if (portListening(PORT)) {
    forced = killPort(PORT);
    for (let i = 0; i < 20 && portListening(PORT); i++) await sleep(500);
  }
  const freed = !portListening(PORT);
  const start = spawnSync(process.execPath, [DEV_HOST], { encoding: "utf8", windowsHide: true });
  const call = await reconnect(true);
  return {
    forcedKillPid: forced,
    portFreed: freed,
    startLine: (start.stdout ?? "").trim().split("\n").pop(),
    call,
  };
}

/** 重启后重连 CDP，并等运行名单就绪（新进程 = 新页面会话） */
async function reconnect(expectRuns = true) {
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const page = await cdpConnect(PORT);
      if (!page) continue;
      const call = await makeSession(page.webSocketDebuggerUrl);
      await call("Page.enable");
      await call("Runtime.enable");
      await call("Page.bringToFront").catch(() => {});
      await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await sleep(1500);
      if (!expectRuns) return call;
      if ((await runs(call)).length > 0) return call;
    } catch {
      /* 启动中 */
    }
  }
  throw new Error("重启后 60s 内未能连上 CDP / 运行名单为空");
}

// ---------------------------------------------------------------------------
// 只读不变性：逐文件 SHA-256（同 5.5 口径）
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
function diffSurface(before, after) {
  const diffs = [];
  for (const group of Object.keys(before)) {
    const a = before[group];
    const b = after[group] ?? {};
    for (const k of Object.keys(a)) {
      if (!(k in b)) diffs.push(`${group}/${k} 消失`);
      else if (a[k] !== b[k]) diffs.push(`${group}/${k} 哈希变化`);
    }
    for (const k of Object.keys(b)) if (!(k in a)) diffs.push(`${group}/${k} 新增`);
  }
  return diffs;
}
/** 浏览期间要冻结的面：夹具目录（源 + data + 清单）与 live 的 traces/附件 */
function freezeSurface() {
  return {
    fixture56: hashTree(FIX56),
    traces: hashTree(join(LIVE_DIR, "traces")),
    blobs: hashTree(BLOBS_DIR),
  };
}

// ---------------------------------------------------------------------------
// 数据目录操作（全部可逆，带还原标记）
// ---------------------------------------------------------------------------

function writeRestoreFlag(lines) {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(RESTORE_FLAG, `${lines.join("\n")}\n`, "utf8");
}
function clearRestoreFlag() {
  rmSync(RESTORE_FLAG, { force: true });
}
/** 必须在 finally 里调用：任一 rename 失败都不能让数据目录停在半路 */
function restoreAll() {
  if (existsSync(MOVE_DIR) && !existsSync(LIVE_DIR)) renameSync(MOVE_DIR, LIVE_DIR);
  if (existsSync(BLOBS_BAK) && !existsSync(BLOBS_DIR)) renameSync(BLOBS_BAK, BLOBS_DIR);
  clearRestoreFlag();
}

// ---------------------------------------------------------------------------
// 求值 / 模块导入 / DOM
// ---------------------------------------------------------------------------

async function evAsync(call, expression) {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails)
    throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r?.result?.value;
}

/**
 * 按"应用自己用过的模块 URL"导入（候选子串数组，理由见 5.5 的同类注释：
 * Vite root = `apps/desktop/src/renderer`，真实 URL 形如 `/src/store.ts`）。
 */
async function appImport(call, needles, body) {
  const list = Array.isArray(needles) ? needles : [needles];
  const raw = await evAsync(
    call,
    `(async () => {
      const wanted = ${JSON.stringify(list)};
      const all = performance.getEntriesByType('resource').map(e => e.name)
        .filter(n => wanted.some(w => n.includes(w)));
      const rank = (n) => (n.includes('?t=') ? 0 : n.includes('/@fs/') ? 2 : 1);
      const url = all.slice().sort((a, b) => rank(a) - rank(b))[0] ?? null;
      if (url === null) return JSON.stringify({ error: 'module-url-not-found', needle: wanted.join(' | ') });
      const m = await import(url);
      ${body}
    })()`,
  );
  return JSON.parse(raw);
}

const STORE_NEEDLE = ["/src/renderer/src/store.ts", "/src/store.ts"];
const MONACO_NEEDLE = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];
const READING_STATE_NEEDLE = [
  "/src/renderer/src/lib/reading-state.ts",
  "/src/lib/reading-state.ts",
];

/**
 * 读某 run 的文件阅读会话状态（权威：位置/选择是否真的被记住）。
 * ⚠️ 字段名以 `FileReadingState` 为准：是 `directoryWidth` / `directoryCollapsed`，
 *    不是 `dirWidth`（写错只会得到 `undefined`，`JSON.stringify` 又会把它丢掉 ⇒ 判据静默变空）。
 */
async function storeState(call, runId) {
  return appImport(
    call,
    STORE_NEEDLE,
    `const rsUrl = (() => {
        const all = performance.getEntriesByType('resource').map(e => e.name)
          .filter(n => ${JSON.stringify(READING_STATE_NEEDLE)}.some(w => n.includes(w)));
        const rank = (n) => (n.includes('?t=') ? 0 : n.includes('/@fs/') ? 2 : 1);
        return all.slice().sort((a, b) => rank(a) - rank(b))[0] ?? null;
      })();
      if (rsUrl === null) return JSON.stringify({ error: 'module-url-not-found', needle: 'reading-state' });
      const rs = await import(rsUrl);
      const st = m.useAppStore.getState();
      const r = rs.readingStateOf(st.readingByRun, ${JSON.stringify(runId)});
      const f = rs.fileReadingOf(r);
      return JSON.stringify({
        moduleUrl: url, tab: r.tab, spanId: r.spanId,
        checkpoint: f.checkpoint, path: f.path, pane: f.pane,
        directoryWidth: f.directoryWidth, directoryCollapsed: f.directoryCollapsed,
        wordWrap: f.wordWrap, entered: r.files !== undefined,
        byRunKeys: Object.keys(st.readingByRun),
      });`,
  );
}

async function assertStoreLive(call, runId) {
  const s = await storeState(call, runId);
  if (s.error !== undefined) throw new Error(`store 探针失败：${JSON.stringify(s)}`);
  if (!Array.isArray(s.byRunKeys) || !s.byRunKeys.includes(runId)) {
    throw new Error(`store 探针未拿到应用同一实例（byRunKeys=${JSON.stringify(s.byRunKeys)}）`);
  }
  return s;
}

async function monacoState(call) {
  return appImport(
    call,
    MONACO_NEEDLE,
    `const bs = await import(url);
      const monaco = await bs.ensureMonaco();
      const getText = (e) => { const md = e.getModel(); return md === null ? null : md.getValue(); };
      const diff = monaco.editor.getDiffEditors()[0] ?? null;
      const edits = monaco.editor.getEditors();
      return JSON.stringify({
        loaded: true,
        models: monaco.editor.getModels().map(md => ({ lines: md.getLineCount(), text: md.getValue() })),
        standalone: edits.map(e => ({ readOnly: e.getOption(monaco.editor.EditorOption.readOnly), text: getText(e) })),
        diff: diff === null ? null : {
          originalText: getText(diff.getOriginalEditor()),
          modifiedText: getText(diff.getModifiedEditor()),
          lineChangeCount: (diff.getLineChanges() ?? []).length,
          modifiedReadOnly: diff.getModifiedEditor().getOption(monaco.editor.EditorOption.readOnly),
        },
      });`,
  );
}
async function monacoOrNull(call) {
  try {
    const s = await monacoState(call);
    return s.error !== undefined ? null : s;
  } catch {
    return null;
  }
}
function anyModelContains(m, fragment) {
  if (m === null) return false;
  return (
    (m.models ?? []).some((x) => (x.text ?? "").includes(fragment)) ||
    (m.diff?.originalText ?? "").includes(fragment) ||
    (m.diff?.modifiedText ?? "").includes(fragment) ||
    (m.standalone ?? []).some((x) => (x.text ?? "").includes(fragment))
  );
}
const noEditorAtAll = (m) => m === null || (m.diff === null && (m.standalone ?? []).length === 0);
const allReadOnly = (m) =>
  m === null ||
  ((m.standalone ?? []).every((s) => s.readOnly === true) &&
    (m.diff === null || m.diff.modifiedReadOnly === true));

const domExpr = `(() => {
  const q = (s, r = document) => r.querySelector(s);
  const txt = (e) => ((e && e.textContent) || '').trim();
  const btn = (label) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => txt(x) === label);
    return b === undefined ? null : { disabled: b.disabled === true, title: b.title || '' };
  };
  const body = document.body.textContent || '';
  const ae = document.activeElement;
  return JSON.stringify({
    cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
    dpr: +devicePixelRatio.toFixed(2),
    tabs: Array.from(document.querySelectorAll('[role="tab"]')).map(t => ({ label: txt(t), selected: t.getAttribute('aria-selected') === 'true' })),
    buttons: Array.from(new Set(Array.from(document.querySelectorAll('button')).map(b => txt(b)).filter(Boolean))).slice(0, 60),
    pathHeader: txt(Array.from(document.querySelectorAll('.break-all.font-code')).find(x => x.closest('[role="option"]') === null)),
    hasDiffEditor: !!q('.monaco-diff-editor'),
    hasSingleSideEditor: !!q('[data-testid="single-side-editor"]'),
    availabilityMissing: body.includes('附件缺失'),
    availabilityCorrupt: body.includes('附件损坏'),
    cards: Array.from(document.querySelectorAll('div.m-4')).map(txt),
    fakeEmptyClaim: (() => {
      const stripped = body.replace(/绝不会用空编辑器冒充[\\s\\S]*?参与 diff。/g, '');
      return /无变化|文件为空|文件是空的/.test(stripped);
    })(),
    diffCountText: (() => { const m = body.match(/共\\s*(\\d+)\\s*处差异/); return m === null ? null : Number(m[1]); })(),
    retryFileBtn: btn('重新读取该文件') !== null,
    failureNotMissing: body.includes('并不表示该文件不存在') || body.includes('读取失败（不是不存在）'),
    toolbar: {
      复制路径: btn('复制路径'),
      换行开: btn('换行：开'),
      换行关: btn('换行：关'),
      查找: btn('查找'),
      上一差异: btn('上一差异'),
      下一差异: btn('下一差异'),
    },
    fileOptions: Array.from(document.querySelectorAll('[role="option"][data-file-path]')).map(e => e.getAttribute('data-file-path')),
    selectedFile: (() => { const e = q('[role="option"][aria-selected="true"]'); return e === null ? null : e.getAttribute('data-file-path'); })(),
    listbox: q('[role="listbox"]') !== null,
    searchInput: (() => { const i = q('input[aria-label="按完整路径搜索文件"]'); return i === null ? null : i.value; })(),
    separator: q('[role="separator"]') !== null,
    ckpts: Array.from(document.querySelectorAll('button'))
      .filter(b => (b.title || '').includes('检查点所属 step') || (b.title || '').includes('文件世界起点'))
      .map(b => ({ label: txt(b), active: b.className.includes('bg-violet-600') })),
    filterBtns: Array.from(document.querySelectorAll('button'))
      .filter(b => ['自动', '全部', '有变化'].includes(txt(b)))
      .map(b => ({ label: txt(b), active: b.className.includes('bg-violet-600') })),
    findWidgetShown: (() => { const w = q('.find-widget'); return w === null ? false : (w.classList.contains('visible') || w.getBoundingClientRect().height > 0); })(),
    findWidgetClass: (() => { const w = q('.find-widget'); return w === null ? null : (w.className || '').toString(); })(),
    monoContainer: q('.monaco-editor') !== null,
    focus: ae === null || ae === undefined ? null : {
      tag: ae.tagName.toLowerCase(),
      role: ae.getAttribute('role'),
      aria: ae.getAttribute('aria-label'),
      filePath: ae.getAttribute('data-file-path'),
      label: txt(ae).slice(0, 40),
      cls: (typeof ae.className === 'string' ? ae.className : '').slice(0, 100),
    },
    bodyHasLoading: /正在读取|正在加载编辑器/.test(body),
    // ⚠️ 全文判据（**不要**用 bodySample：它只截前 500 字符，而详情面板在导航之后，
    //    用它判"详情里有没有某个入口"会得到假失败——首轮实测踩到）
    bodyHasRerunHere: /在此重跑/.test(body),
    bodyHasInheritedNotice: /位于祖先前缀/.test(body),
    bodySample: body.replace(/\\s+/g, ' ').slice(0, 500),
  });
})()`;

async function dom(call) {
  return JSON.parse(await ev(call, domExpr));
}

// ---------------------------------------------------------------------------
// 真交互助手
// ---------------------------------------------------------------------------

const RUNS_EXPR = `(() => JSON.stringify(Array.from(document.querySelectorAll('button'))
  .map(b => b.getAttribute('aria-label') || '')
  .filter(a => a.startsWith('复制完整运行 ID'))
  .map(a => a.replace('复制完整运行 ID ', ''))))()`;
async function runs(call) {
  return JSON.parse(await ev(call, RUNS_EXPR));
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
  let ok = await ev(call, hitRow);
  let detour = false;
  if (ok !== true) {
    detour = await clickTab(call, "概览");
    ok = await ev(call, hitRow);
  }
  if (ok === true) await sleep(1600);
  return { ok: ok === true, detour };
}

async function clickTab(call, label) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
      .find(x => ((x.textContent||'').trim()) === '${label}');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok !== true) return false;
  await sleep(1200);
  const selected = await ev(
    call,
    `(() => { const t = Array.from(document.querySelectorAll('[role="tab"]'))
      .find(x => x.getAttribute('aria-selected') === 'true');
      return t === null ? null : ((t.textContent||'').trim()); })()`,
  );
  return selected === label;
}

async function clickByText(call, text, wait = 500) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => ((x.textContent||'').trim()) === '${text}');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok === true) await sleep(wait);
  return ok === true;
}

async function clickByAria(call, aria, wait = 400) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => x.getAttribute('aria-label') === '${aria}');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok === true) await sleep(wait);
  return ok === true;
}

/** 把焦点移到某元素（**不移除 click 语义**：只 focus，不触发 onClick） */
async function focusExpr(call, selector) {
  return ev(
    call,
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.focus(); return document.activeElement === e; })()`,
  );
}
async function focusByText(call, text) {
  return ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => ((x.textContent||'').trim()) === ${JSON.stringify(text)});
      if (!b) return false; b.focus(); return document.activeElement === b; })()`,
  );
}

/** 真键盘：keyDown + keyUp（含 Enter/Escape/方向键/Home/End） */
async function key(call, k, code, vk, wait = 400) {
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: k,
    code,
    windowsVirtualKeyCode: vk,
  });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
  await sleep(wait);
}
const KEYS = {
  ArrowDown: ["ArrowDown", "ArrowDown", 40],
  ArrowUp: ["ArrowUp", "ArrowUp", 38],
  ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
  ArrowRight: ["ArrowRight", "ArrowRight", 39],
  Home: ["Home", "Home", 36],
  End: ["End", "End", 35],
  Escape: ["Escape", "Escape", 27],
  Backspace: ["Backspace", "Backspace", 8],
};
const press = (call, name, wait) => key(call, ...KEYS[name], wait);

/**
 * **键盘激活**（Enter）——必须补 `char` 事件，否则按钮的"默认动作"（click）不会发生。
 *
 * ⚠️ 实测（2026-09-24）：只发 keyDown+keyUp 时，焦点确实在按钮上、`document.activeElement`
 *    也对，但 `<button>` 的 Enter 激活**不触发** ⇒ 断言会得到一个"按键无效"的假失败
 *    （工具栏换行、检查点两处都栽在这里）。Chrome 的按钮激活需要完整的
 *    rawKeyDown → char(text:"\r") → keyUp 序列。
 */
async function activate(call, wait = 900) {
  await call("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await call("Input.dispatchKeyEvent", {
    type: "char",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
    unmodifiedText: "\r",
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await sleep(wait);
}

const CKPT_FILTER = `(b => (b.title || '').includes('检查点所属 step') || (b.title || '').includes('文件世界起点'))`;
const CKPT_ACTIVE_EXPR = `(() => { const a = Array.from(document.querySelectorAll('button')).filter(${CKPT_FILTER})
  .find(b => b.className.includes('bg-violet-600')) ?? null; return a === null ? null : ((a.textContent||'').trim()); })()`;

async function pickCheckpointLike(call, fragment) {
  const click = `(() => { const c = Array.from(document.querySelectorAll('button')).filter(${CKPT_FILTER});
    const t = c.find(b => ((b.textContent||'').trim()).includes(${JSON.stringify(fragment)}));
    if (!t) return null; const label = (t.textContent||'').trim(); t.click(); return label; })()`;
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const label = await ev(call, click);
    if (label === null) {
      await sleep(900);
      continue;
    }
    await sleep(1500);
    const active = await ev(call, CKPT_ACTIVE_EXPR);
    if (active === label) return true;
    last = { label, active };
    await sleep(600);
  }
  throw new Error(`未能把检查点切到「${fragment}」（最后一次 ${JSON.stringify(last)}）`);
}

async function pickFilter(call, label) {
  const click = `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => ((x.textContent||'').trim()) === '${label}');
    if (!b) return false; b.click(); return true; })()`;
  const activeExpr = `(() => { const a = Array.from(document.querySelectorAll('button'))
    .filter(b => ['自动','全部','有变化'].includes(((b.textContent||'').trim())))
    .find(b => b.className.includes('bg-violet-600')) ?? null;
    return a === null ? null : ((a.textContent||'').trim()); })()`;
  let lastActive = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = await ev(call, click);
    if (ok !== true) {
      await sleep(900);
      continue;
    }
    await sleep(900);
    lastActive = await ev(call, activeExpr);
    if (lastActive === label) return true;
    await sleep(500);
  }
  throw new Error(`未能把变化筛选切到「${label}」（最后一次活动项 ${JSON.stringify(lastActive)}）`);
}

async function pickFile(call, path) {
  const click = `(() => { const b = document.querySelector('[role="option"][data-file-path="${path}"]');
      if (!b) return false; b.click(); return true; })()`;
  let hit = await ev(call, click);
  if (hit !== true) {
    await clickByAria(call, "显示文件列表");
    hit = await ev(call, click);
  }
  if (hit !== true) return false;
  await sleep(1400);
  await clickByAria(call, "显示文件内容", 900);
  const selected = await ev(
    call,
    `(() => { const e = document.querySelector('[role="option"][aria-selected="true"]');
      return e === null ? null : e.getAttribute('data-file-path'); })()`,
  );
  return selected === path;
}

async function enterFiles(call, runId, ckptFragment = null, filterLabel = null) {
  const m = {};
  let available = (await runs(call)).includes(runId);
  if (!available) {
    await clickTab(call, "概览");
    available = (await runs(call)).includes(runId);
  }
  m.runAvailable = available;
  if (!available) throw new Error(`运行 ${runId} 不在运行名单里（已回概览重读）`);
  const picked = await selectRun(call, runId);
  m.selected = picked.ok;
  m.filesTab = await clickTab(call, "文件");
  if (ckptFragment !== null) m.ckpt = await pickCheckpointLike(call, ckptFragment);
  if (filterLabel !== null) m.filter = await pickFilter(call, filterLabel);
  m.live = await assertStoreLive(call, runId);
  return m;
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

async function scenarioProbe(call) {
  const m = {};
  m.location = await ev(call, "location.href");
  m.viewport = await dom(call);
  m.runListCount = (await runs(call)).length;
  m.fixturesPresent = {
    [SUB_RUN]: (await runs(call)).includes(SUB_RUN),
    [SUB_PARENT]: (await runs(call)).includes(SUB_PARENT),
    [NORMAL_RUN]: (await runs(call)).includes(NORMAL_RUN),
    ...(NORMAL_ROOT === null ? {} : { [NORMAL_ROOT]: (await runs(call)).includes(NORMAL_ROOT) }),
  };

  // 隔离子 run：页签与文件页事实
  Object.assign(m, await enterFiles(call, SUB_RUN, null, "全部"), { subEnter: true });
  m.subDom = await dom(call);
  m.subCkpts = m.subDom.ckpts;
  m.subPickSub = await pickFile(call, TARGET_FILE);
  m.subFileDom = await dom(call);
  m.subMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-1-隔离子run.png`);

  // 普通 run：页签
  const normalEnter = await enterFiles(call, NORMAL_RUN, null, null).catch((e) => ({
    error: String(e.message),
  }));
  m.normalEnter = normalEnter;
  m.normalDom = await dom(call);
  await shot(call, SHOT_DIR, `${TAG}-2-普通run.png`);
  return m;
}

/**
 * ① 重启后查看文件差异 + ③ 阅读状态不跨进程承诺。
 *
 * 重启前**故意选非默认检查点（初始）** ⇒ 重启后若被"恢复"就说明状态真的跨了进程；
 * 期望是按首次进入策略落回**默认检查点（最近自有完成步骤）**，而 trace 记录仍可重读。
 */
async function scenarioRestartState(call) {
  const m = {};
  const surfaceBefore = freezeSurface();

  // —— 重启前：进文件页、选非默认检查点、记下会话状态 ——
  Object.assign(m, await enterFiles(call, SUB_RUN, null, "全部"), { enter: true });
  m.beforeCkpts = (await dom(call)).ckpts;
  m.beforePickInitial = await pickCheckpointLike(call, "初始");
  m.beforeStore = await storeState(call, SUB_RUN);
  check(
    "重启前已把检查点切到**非默认**的初始状态（这样「是否跨进程」才可判）",
    m.beforeStore.entered === true && m.beforeStore.checkpoint === null,
    JSON.stringify({
      entered: m.beforeStore.entered,
      checkpoint: m.beforeStore.checkpoint,
      ckpts: m.beforeCkpts,
    }),
  );

  // —— 重启（真进程重启：停 → 确认端口空出 → 起 → 重连）——
  const restarted = await restartDevAndReconnect();
  m.restart = {
    portFreed: restarted.portFreed,
    forcedKillPid: restarted.forcedKillPid,
    startLine: restarted.startLine,
  };
  const call2 = restarted.call;
  check(
    "确是**新进程**（先确认端口真的空出来，再起新实例 ⇒ 不是连回旧会话）",
    restarted.portFreed === true,
    JSON.stringify(m.restart),
  );
  await shot(call2, SHOT_DIR, "restart-state-1-重启后.png");

  // —— 重启后：阅读状态**不在**（内存态），按首次进入策略落默认检查点 ——
  const after0 = await storeState(call2, SUB_RUN);
  m.afterRestartStoreBeforeEnter = after0;
  check(
    "重启后**文件**阅读状态未跨进程（`entered=false`：checkpoint/path/pane 都没被恢复）",
    after0.error === undefined && after0.entered === false,
    JSON.stringify(after0),
  );

  Object.assign(m, await enterFiles(call2, SUB_RUN, null, "全部"), { enterAfter: true });
  m.afterDom = await dom(call2);
  m.afterStore = await storeState(call2, SUB_RUN);
  const activeAfter = await ev(call2, CKPT_ACTIVE_EXPR);
  m.afterActiveCkpt = activeAfter;
  check(
    "重启后按首次进入策略落到**默认检查点**（最近自有完成步骤 = 第 2 轮），而非重启前刻意选的初始",
    typeof activeAfter === "string" &&
      activeAfter.includes("第 2 轮") &&
      m.beforeStore.checkpoint === null,
    JSON.stringify({ activeAfter, before: m.beforeStore.checkpoint, ckpts: m.afterDom.ckpts }),
  );

  // —— 重启后读真实差异（场景①）——
  m.pickSubRound1 = await pickCheckpointLike(call2, "第 1 轮");
  const beforeSelect = await dom(call2);
  m.domBeforeSelect = beforeSelect;
  check(
    "未选文件时**界面里没有该文件内容**（无内容副本被恢复出来）",
    !beforeSelect.bodySample.includes(TEXT_SUB) && !beforeSelect.bodySample.includes(TEXT_ROOT_R2),
    JSON.stringify({ sample: beforeSelect.bodySample.slice(0, 200) }),
  );
  m.pickFile = await pickFile(call2, TARGET_FILE);
  m.afterPickStore = await storeState(call2, SUB_RUN);
  m.fileDom = await dom(call2);
  m.fileMonaco = await monacoOrNull(call2);
  await shot(call2, SHOT_DIR, "restart-state-2-重启后真实差异.png");

  const d = m.fileMonaco?.diff ?? null;
  check(
    "重启后打开子 run 的完成步骤 + 修改文件 ⇒ 真 diff 两侧文本来自 trace 引用",
    d !== null &&
      (d.originalText ?? "").trim() === TEXT_ROOT_R2 &&
      (d.modifiedText ?? "").trim() === TEXT_SUB,
    JSON.stringify({ diff: d, cards: m.fileDom.cards }).slice(0, 500),
  );
  check(
    "显示了所选的完成步骤（第 1 轮）与真实差异数",
    m.fileDom.ckpts.some((c) => c.active === true && c.label.includes("第 1 轮")) &&
      (m.fileDom.diffCountText ?? 0) >= 1,
    JSON.stringify({ count: m.fileDom.diffCountText, ckpts: m.fileDom.ckpts }),
  );
  check(
    "重启后仍是只读通道（无替换入口）",
    allReadOnly(m.fileMonaco),
    JSON.stringify(d?.modifiedReadOnly ?? null),
  );

  // —— ③ 重启后浏览仍零写入、零 LLM ——
  const after = freezeSurface();
  m.surfaceDiff = diffSurface(surfaceBefore, after);
  check(
    "重启后浏览全程零文件写入（夹具目录 / traces / 附件逐文件哈希不变）",
    m.surfaceDiff.length === 0,
    JSON.stringify(m.surfaceDiff).slice(0, 300),
  );
  m.call = call2;
  return m;
}

/**
 * ② 数据目录迁移后文件仍可查。
 *
 * （a）**整体迁移**：把 `.rebaseagent` 整个重命名到**另一个绝对路径**，用真实读取 API + 应用重启验证仍可读；
 * （b）**仅迁 JSONL**：临时移走 `workspace-blobs` ⇒ 轨迹可读、附件明确缺失；再还原并验证恢复。
 */
async function scenarioMigrate(call) {
  const m = {};
  const { readRun } = require("@rebaseagent/trace-sdk");
  const { readWorkspaceFile } = require("@rebaseagent/replay");

  try {
    // —————————————— (a) 整体迁移 ——————————————
    writeRestoreFlag([
      "U2 5.6 migrate 中断复位说明：",
      `若 ${LIVE_DIR} 不存在而 ${MOVE_DIR} 存在 ⇒ 把后者改回前者`,
      `若 ${BLOBS_DIR} 不存在而 ${BLOBS_BAK} 存在 ⇒ 把后者改回前者`,
    ]);
    mkdirSync(WORK_DIR, { recursive: true });
    rmSync(MOVE_DIR, { recursive: true, force: true });
    renameSync(LIVE_DIR, MOVE_DIR); // 整个数据目录 → 新绝对路径
    m.movedTo = MOVE_DIR;
    m.afterMoveLiveExists = existsSync(LIVE_DIR);
    check(
      "整体迁移：数据目录已真的移到另一个绝对路径（原路径不存在）",
      m.afterMoveLiveExists === false && existsSync(join(MOVE_DIR, "traces")),
      JSON.stringify({
        live: LIVE_DIR,
        moved: MOVE_DIR,
        hasTraces: existsSync(join(MOVE_DIR, "traces")),
      }),
    );

    // 源目录此刻**随数据目录一起被移走了**（它在 .rebaseagent 内）⇒ 顺带证明"无需原 source 路径"
    const record = readRun(join(MOVE_DIR, "traces", `${SUB_RUN}.jsonl`));
    m.movedTraceReadable = record.meta.id === SUB_RUN;
    const initRead = await readWorkspaceFile({
      dataDir: MOVE_DIR,
      runId: SUB_RUN,
      path: TARGET_FILE,
    });
    const stepRead = await readWorkspaceFile({
      dataDir: MOVE_DIR,
      runId: SUB_RUN,
      path: TARGET_FILE,
      stepSpanId: SUB_ROUND1,
    });
    m.movedReads = {
      initial: initRead.status === "text" ? initRead.text.trim() : initRead.status,
      step: stepRead.status === "text" ? stepRead.text.trim() : stepRead.status,
    };
    check(
      "整体迁移：用**新的 dataDir** 读 trace 与文件内容都成功（初始/当前两侧都对）",
      m.movedTraceReadable &&
        m.movedReads.initial === TEXT_ROOT_R2 &&
        m.movedReads.step === TEXT_SUB,
      JSON.stringify(m.movedReads),
    );
    // 原始 source 路径此刻不可达 ⇒ 说明读取完全不依赖它
    m.sourceAbsentDuringMove = !existsSync(SRC56);
    check(
      "整体迁移：读取不依赖原 source 路径（迁移期间该路径不存在，仍读出真实内容）",
      m.sourceAbsentDuringMove === true,
      JSON.stringify({ source: SRC56, absent: m.sourceAbsentDuringMove }),
    );

    // 迁回原路径 + 重启应用 ⇒ 界面层仍可查
    renameSync(MOVE_DIR, LIVE_DIR);
    clearRestoreFlag();
    check(
      "整体迁移后复位成功（数据目录回到原路径）",
      existsSync(join(LIVE_DIR, "traces", `${SUB_RUN}.jsonl`)) && !existsSync(MOVE_DIR),
      JSON.stringify({ live: existsSync(LIVE_DIR), moved: existsSync(MOVE_DIR) }),
    );

    const r1 = await restartDevAndReconnect();
    m.restartAfterMove = r1.portFreed;
    let call2 = r1.call;
    Object.assign(m, await enterFiles(call2, SUB_RUN, "第 1 轮", "全部"), { enterAfterMove: true });
    m.pickAfterMove = await pickFile(call2, TARGET_FILE);
    m.afterMoveMonaco = await monacoOrNull(call2);
    m.afterMoveDom = await dom(call2);
    await shot(call2, SHOT_DIR, "migrate-1-整体迁移后重启.png");
    check(
      "整体迁移 + 重启后，界面仍显示真实差异（拔掉「必须原路径」的假设）",
      (m.afterMoveMonaco?.diff?.originalText ?? "").trim() === TEXT_ROOT_R2 &&
        (m.afterMoveMonaco?.diff?.modifiedText ?? "").trim() === TEXT_SUB,
      JSON.stringify({ diff: m.afterMoveMonaco?.diff ?? null }).slice(0, 400),
    );

    // —————————————— (b) 仅迁 JSONL（无附件）——————————————
    // 数据层：新路径下只有 traces/ ⇒ trace 可读、文件读取报 missing
    const jsonlOnly = join(WORK_DIR, "jsonl-only");
    rmSync(jsonlOnly, { recursive: true, force: true });
    mkdirSync(join(jsonlOnly, "traces"), { recursive: true });
    for (const id of [SUB_RUN, SUB_PARENT]) {
      cpSync(join(LIVE_DIR, "traces", `${id}.jsonl`), join(jsonlOnly, "traces", `${id}.jsonl`));
    }
    m.jsonlOnly = { dir: jsonlOnly, blobs: existsSync(join(jsonlOnly, "workspace-blobs")) };
    const onlyRecord = readRun(join(jsonlOnly, "traces", `${SUB_RUN}.jsonl`));
    const onlyRead = await readWorkspaceFile({
      dataDir: jsonlOnly,
      runId: SUB_RUN,
      path: TARGET_FILE,
    });
    m.jsonlOnlyRead = { status: onlyRead.status, metaId: onlyRecord.meta.id };
    check(
      "仅迁 JSONL（新路径、无附件）：**轨迹仍可读**，文件读取明确是 missing",
      m.jsonlOnlyRead.metaId === SUB_RUN && m.jsonlOnlyRead.status === "missing",
      JSON.stringify(m.jsonlOnlyRead),
    );

    // 应用层：临时移走 live 的附件目录 ⇒ 重启后轨迹可读、附件明确缺失
    writeRestoreFlag([
      "U2 5.6 migrate 中断复位说明：",
      `若 ${LIVE_DIR} 不存在而 ${MOVE_DIR} 存在 ⇒ 把后者改回前者`,
      `若 ${BLOBS_DIR} 不存在而 ${BLOBS_BAK} 存在 ⇒ 把后者改回前者`,
    ]);
    rmSync(BLOBS_BAK, { recursive: true, force: true });
    renameSync(BLOBS_DIR, BLOBS_BAK);
    m.blobsMoved = !existsSync(BLOBS_DIR) && existsSync(BLOBS_BAK);
    const r2 = await restartDevAndReconnect();
    m.restartNoBlobs = r2.portFreed;
    call2 = r2.call;
    Object.assign(m, await enterFiles(call2, SUB_RUN, "第 1 轮", "全部"), { enterNoBlobs: true });
    m.pickNoBlobs = await pickFile(call2, TARGET_FILE);
    m.noBlobsDom = await dom(call2);
    m.noBlobsMonaco = await monacoOrNull(call2);
    await shot(call2, SHOT_DIR, "migrate-2-仅迁JSONL.png");
    check(
      "仅迁 JSONL：轨迹可读（运行与步骤页仍在），文件明确标出**附件缺失**",
      m.noBlobsDom.availabilityMissing === true && m.noBlobsDom.fileOptions.includes(TARGET_FILE),
      JSON.stringify({ opts: m.noBlobsDom.fileOptions, cards: m.noBlobsDom.cards }).slice(0, 400),
    );
    check(
      "仅迁 JSONL：不渲染伪空文件（不把缺失当空文本参与 diff）",
      noEditorAtAll(m.noBlobsMonaco) && m.noBlobsDom.fakeEmptyClaim === false,
      JSON.stringify({ cards: m.noBlobsDom.cards, monaco: m.noBlobsMonaco }).slice(0, 400),
    );

    // 还原附件 + 重启 ⇒ 恢复可读
    renameSync(BLOBS_BAK, BLOBS_DIR);
    clearRestoreFlag();
    check(
      "仅迁 JSONL 后复位成功（附件目录回到原位）",
      existsSync(BLOBS_DIR) && !existsSync(BLOBS_BAK),
      JSON.stringify({ blobs: existsSync(BLOBS_DIR), bak: existsSync(BLOBS_BAK) }),
    );
    const r3 = await restartDevAndReconnect();
    m.restartRestored = r3.portFreed;
    call2 = r3.call;
    Object.assign(m, await enterFiles(call2, SUB_RUN, "第 1 轮", "全部"), { enterRestored: true });
    m.pickRestored = await pickFile(call2, TARGET_FILE);
    m.restoredMonaco = await monacoOrNull(call2);
    check(
      "复位后重启：文件恢复可读，diff 与迁移前逐字一致",
      (m.restoredMonaco?.diff?.originalText ?? "").trim() === TEXT_ROOT_R2 &&
        (m.restoredMonaco?.diff?.modifiedText ?? "").trim() === TEXT_SUB,
      JSON.stringify({ diff: m.restoredMonaco?.diff ?? null }).slice(0, 400),
    );
    m.call = call2;
  } finally {
    restoreAll();
  }
  return m;
}

/**
 * ④ 文件阅读键盘操作与离线加载。
 *
 * 先在联网下记录**全部网络请求**（含冷启动与 Monaco 懒加载），证明零外部请求；
 * 再切离线，用真键盘操作检查点 / 搜索 / 目录宽度 / 列表导航 / 工具栏与查找往返。
 */
async function scenarioKeyboardOffline(call) {
  const m = {};

  // —— 资源表：从冷启动开始收（monaco 懒加载也在内）——
  await call("Network.enable").catch(() => {});
  await call("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      if ((await runs(call)).length > 0) break;
    } catch {
      /* 重载中 */
    }
  }
  await sleep(800);

  Object.assign(m, await enterFiles(call, SUB_RUN, "第 1 轮", "全部"), { enter: true });
  m.pickSub = await pickFile(call, TARGET_FILE);
  m.warmMonaco = await monacoOrNull(call);
  await sleep(600);

  const resources = JSON.parse(
    await ev(
      call,
      `(() => JSON.stringify(performance.getEntriesByType('resource').map(e => e.name)))()`,
    ),
  );
  m.resourceHosts = [
    ...new Set(
      resources.map((u) => {
        try {
          return new URL(u).host;
        } catch {
          return "n/a";
        }
      }),
    ),
  ];
  m.externalRequests = resources.filter((u) => {
    try {
      const h = new URL(u).host;
      return !(h === "" || h.startsWith("localhost") || h.startsWith("127.0.0.1"));
    } catch {
      return false;
    }
  });
  m.resourceCount = resources.length;
  m.monacoResources = resources.filter((u) => /monaco|\.css|worker/i.test(u)).length;
  check(
    "Monaco 与全部资源都来自本地（冷启动 + 懒加载全程零外部 host）",
    m.externalRequests.length === 0 && m.monacoResources > 0,
    JSON.stringify({
      hosts: m.resourceHosts,
      external: m.externalRequests.slice(0, 5),
      monaco: m.monacoResources,
    }),
  );
  check(
    "联网下已渲染真 diff（后面离线的对照基准）",
    (m.warmMonaco?.diff?.lineChangeCount ?? 0) >= 1,
    JSON.stringify(m.warmMonaco?.diff ?? null).slice(0, 200),
  );

  // —— 切离线 ——
  await call("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await sleep(700);
  m.offlineFlag = await ev(call, "navigator.onLine");
  check("已切到离线（navigator.onLine === false）", m.offlineFlag === false, String(m.offlineFlag));

  // —— 离线：重新进文件页（Monaco 走本地缓存）——
  await clickTab(call, "概览");
  Object.assign(m, await enterFiles(call, SUB_RUN, "第 1 轮", "全部"), { enterOffline: true });
  m.pickOffline = await pickFile(call, TARGET_FILE);
  m.offlineDom = await dom(call);
  m.offlineMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, "keyboard-offline-1-离线文件页.png");
  check(
    "离线仍能进入文件页并渲染 Monaco（本地懒加载）",
    m.offlineDom.hasDiffEditor === true && m.offlineMonaco?.loaded === true,
    JSON.stringify({ diff: m.offlineDom.hasDiffEditor, loaded: m.offlineMonaco?.loaded ?? null }),
  );

  // —— 键盘：文件列表方向键导航 + 焦点跟随 ——
  m.kb = {};
  m.kb.listbox = m.offlineDom.listbox;
  m.kb.focusAfterPick = m.offlineDom.focus;
  const firstPath = m.offlineDom.fileOptions[0];
  await focusExpr(call, `[role="option"][data-file-path="${m.offlineDom.selectedFile}"]`);
  await press(call, "Home");
  m.kb.afterHome = await dom(call);
  await press(call, "End");
  m.kb.afterEnd = await dom(call);
  await press(call, "ArrowUp");
  m.kb.afterUp = await dom(call);
  check(
    "文件列表可用键盘导航（Home/End/ArrowUp）且焦点跟着走（roving tabindex）",
    m.kb.listbox === true &&
      m.kb.afterHome.selectedFile === firstPath &&
      m.kb.afterHome.focus?.filePath === firstPath &&
      m.kb.afterEnd.focus?.filePath ===
        m.offlineDom.fileOptions[m.offlineDom.fileOptions.length - 1] &&
      m.kb.afterUp.focus?.filePath === m.kb.afterUp.selectedFile,
    JSON.stringify({
      home: [m.kb.afterHome.selectedFile, m.kb.afterHome.focus?.filePath],
      end: [m.kb.afterEnd.selectedFile, m.kb.afterEnd.focus?.filePath],
      up: [m.kb.afterUp.selectedFile, m.kb.afterUp.focus?.filePath],
    }),
  );

  // —— 键盘：检查点用 Enter 激活 ——
  await focusByText(call, "本 run 初始状态");
  const ckptFocus = await dom(call);
  m.kb.ckptFocused = ckptFocus.focus?.label;
  await activate(call, 1500);
  m.kb.afterCkptEnter = await ev(call, CKPT_ACTIVE_EXPR);
  check(
    "检查点可用键盘激活（聚焦 + Enter）",
    m.kb.ckptFocused === "本 run 初始状态" && m.kb.afterCkptEnter === "本 run 初始状态",
    JSON.stringify({ focused: m.kb.ckptFocused, active: m.kb.afterCkptEnter }),
  );
  await pickCheckpointLike(call, "第 1 轮");

  // —— 键盘：搜索框键入 → 清单筛选 → 用退格清空 ——
  // ⚠️ 「清空搜索」只在**空态**（无匹配 / 无变化）才渲染；有匹配时页面上并没有这个按钮
  //    （首轮实测 `clearClicked=false`）⇒ 用真退格逐字删，这才是"键盘操作"本身。
  const beforeSearch = await dom(call);
  await focusExpr(call, 'input[aria-label="按完整路径搜索文件"]');
  await call("Input.insertText", { text: "edit" });
  await sleep(900);
  m.kb.afterSearch = await dom(call);
  for (let i = 0; i < 4; i++) await press(call, "Backspace", 250);
  await sleep(600);
  m.kb.afterSearchClear = await dom(call);
  check(
    "搜索框可用键盘输入并真的筛掉不匹配项，退格清空后恢复",
    m.kb.afterSearch.searchInput === "edit" &&
      m.kb.afterSearch.fileOptions.length > 0 &&
      m.kb.afterSearch.fileOptions.length < beforeSearch.fileOptions.length &&
      m.kb.afterSearchClear.searchInput === "" &&
      m.kb.afterSearchClear.fileOptions.length === beforeSearch.fileOptions.length,
    JSON.stringify({
      before: beforeSearch.fileOptions.length,
      typed: m.kb.afterSearch.fileOptions,
      afterClearInput: m.kb.afterSearchClear.searchInput,
      cleared: m.kb.afterSearchClear.fileOptions.length,
    }),
  );

  // —— 键盘：目录宽度分隔条 ——
  const sepOk = await focusExpr(call, '[role="separator"]');
  const widthBefore = (await storeState(call, SUB_RUN)).directoryWidth;
  await press(call, "ArrowRight", 700);
  const widthAfterKey = (await storeState(call, SUB_RUN)).directoryWidth;
  m.kb.separator = { focused: sepOk, widthBefore, widthAfterKey };
  check(
    "目录宽度分隔条可用键盘调整（focus + ArrowRight 写回会话状态）",
    sepOk === true && typeof widthBefore === "number" && widthAfterKey > widthBefore,
    JSON.stringify(m.kb.separator),
  );

  // —— 键盘：工具栏换行（Enter 激活）——
  const wrapBefore = (await storeState(call, SUB_RUN)).wordWrap;
  const wrapLabel = wrapBefore ? "换行：开" : "换行：关";
  await focusByText(call, wrapLabel);
  await activate(call, 800);
  const wrapAfter = (await storeState(call, SUB_RUN)).wordWrap;
  m.kb.wrap = { before: wrapBefore, after: wrapAfter, focusedLabel: wrapLabel };
  check(
    "工具栏按钮可用键盘激活（聚焦「换行」+ Enter ⇒ 状态真的翻转）",
    wrapAfter !== wrapBefore,
    JSON.stringify(m.kb.wrap),
  );

  // —— 键盘：查找打开 → Esc 关闭 → 焦点回编辑器 ——
  await clickByText(call, "查找", 900);
  const findOpen = await dom(call);
  await press(call, "Escape", 900);
  const findClosed = await dom(call);
  m.kb.find = {
    open: findOpen.findWidgetShown,
    openClass: findOpen.findWidgetClass,
    closed: findClosed.findWidgetShown,
    closedClass: findClosed.findWidgetClass,
    focus: findClosed.focus,
  };
  check(
    "离线仍可打开查找，Esc 关闭后焦点回到编辑器",
    findOpen.findWidgetClass !== null &&
      findOpen.findWidgetClass.includes("visible") === true &&
      findClosed.findWidgetClass !== null &&
      findClosed.findWidgetClass.includes("visible") === false &&
      (findClosed.focus?.cls?.includes("monaco") === true ||
        findClosed.focus?.tag === "textarea" ||
        findClosed.focus?.role === "textbox"),
    JSON.stringify(m.kb.find),
  );

  // —— 还原网络 ——
  await call("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await call("Network.disable").catch(() => {});
  m.offlineRestored = await ev(call, "navigator.onLine");
  return m;
}

/**
 * 兼容性：普通（非隔离）run **无伪文件页**，且现有概览/步骤/编辑/执行入口仍可达。
 */
async function scenarioCompat(call) {
  const m = {};
  // ⚠️ 不能用 `enterFiles`：它对普通 run 会去点「文件」页签（不存在）并做 store 活实例自检
  //    （普通 run 不产生文件阅读状态）⇒ 会误报。这里只做"选中 run + 读页签"。
  let available = (await runs(call)).includes(NORMAL_RUN);
  if (!available) {
    await clickTab(call, "概览");
    available = (await runs(call)).includes(NORMAL_RUN);
  }
  m.runAvailable = available;
  if (!available) throw new Error(`普通 run ${NORMAL_RUN} 不在运行名单里`);
  const picked = await selectRun(call, NORMAL_RUN);
  m.selected = picked.ok;

  await clickTab(call, "概览");
  m.overviewDom = await dom(call);
  m.tabs = m.overviewDom.tabs.map((t) => t.label);
  await shot(call, SHOT_DIR, "compat-1-普通run概览.png");
  check(
    "普通 run **没有**文件页（页签只有概览/步骤，且无文件清单/编辑器/伪文件页）",
    m.tabs.includes("概览") &&
      m.tabs.includes("步骤") &&
      !m.tabs.includes("文件") &&
      m.overviewDom.fileOptions.length === 0 &&
      m.overviewDom.listbox === false,
    JSON.stringify({
      tabs: m.tabs,
      opts: m.overviewDom.fileOptions.length,
      listbox: m.overviewDom.listbox,
    }),
  );
  check(
    "现有「概览」入口仍可达且有内容",
    m.overviewDom.tabs.some((t) => t.label === "概览" && t.selected === true) &&
      m.overviewDom.bodySample.length > 200,
    JSON.stringify({ sample: m.overviewDom.bodySample.slice(0, 200) }).slice(0, 320),
  );

  const stepsOk = await clickTab(call, "步骤");
  m.stepsDom = await dom(call);
  m.stepsSelected = m.stepsDom.tabs.find((t) => t.label === "步骤")?.selected === true;
  await shot(call, SHOT_DIR, "compat-2-普通run步骤.png");
  check(
    "现有「步骤」入口仍可达（页签选中 + 步骤内容渲染）",
    stepsOk === true && m.stepsSelected === true && m.stepsDom.bodySample.length > 100,
    JSON.stringify({
      stepsOk,
      selected: m.stepsSelected,
      sample: m.stepsDom.bodySample.slice(0, 200),
    }),
  );

  // 编辑入口：`runs:fork` 的「在此重跑」编辑器只在**选中本 run 自有的 tool.invoke 行**时才渲染。
  // ⚠️ 两条实测教训（首轮都踩过）：
  //   ①「编辑 messages 重发」是**代理 run** 专用通道（proxy:fork），本地续跑 run 上没有它；
  //   ②`r_02` 的工具行是**继承**（祖先前缀）⇒ 产品如实提示"打开其所属 run 才可在此重跑"，
  //     并**不**给重跑入口（这是正确行为，不是缺陷）。
  //   ⇒ 改在 5.6 的隔离根 run（自有工具 span）上验这条入口。
  const editEnter = await selectRun(call, EDIT_RUN);
  await clickTab(call, "步骤");
  let expandClicks = 0;
  for (let i = 0; i < 4; i++) {
    const n = await ev(
      call,
      `(() => { const bs = Array.from(document.querySelectorAll('button[aria-label="展开该步骤"]')); bs.forEach(b => b.click()); return bs.length; })()`,
    );
    expandClicks += n;
    await sleep(700);
    if (n === 0) break;
  }
  m.expandClicks = expandClicks;
  m.editEnterSelect = editEnter;
  const toolRowClicked = await ev(
    call,
    `(() => {
      const rows = Array.from(document.querySelectorAll('button[title]'))
        .filter(b => !b.hasAttribute('aria-label'));
      const tool = rows.find(b => ((b.textContent||'').trim()).startsWith('工具') && !(b.textContent||'').includes('继承'));
      const target = tool ?? null;
      if (target === null) return null;
      target.click();
      return (target.textContent||'').trim().slice(0, 40);
    })()`,
  );
  await sleep(1400);
  m.stepsAfterSelect = await dom(call);
  m.editEntry = {
    run: EDIT_RUN,
    rowClicked: toolRowClicked,
    hasRerunHere: m.stepsAfterSelect.bodyHasRerunHere,
    rerunButtons: m.stepsAfterSelect.buttons.filter((b) => /在此重跑|重跑/.test(b)),
  };
  check(
    "「编辑」入口仍可达（选中本 run 自有工具行后出现「在此重跑」编辑器）",
    toolRowClicked !== null && m.editEntry.hasRerunHere === true,
    JSON.stringify({
      row: toolRowClicked,
      rerunButtons: m.editEntry.rerunButtons,
      sample: m.stepsAfterSelect.bodySample.slice(0, 300),
    }).slice(0, 600),
  );

  // 执行类入口：新建运行 / 运行配置 / 录制接入代理 等壳层入口
  const shellButtons = m.stepsDom.buttons.filter((b) =>
    /新建运行|运行配置|录制接入代理|代理|执行|重跑/.test(b),
  );
  m.execEntry = shellButtons;
  check(
    "既有「执行」类入口仍可达（新建运行 / 运行配置 / 录制接入 等）",
    shellButtons.length > 0,
    JSON.stringify(m.stepsDom.buttons.slice(0, 40)),
  );
  return m;
}

/**
 * A1 专项：**首次进入文件页**是否落「最近自有完成步骤」
 * （delta：首次进入 SHALL 选择最近自有完成步骤，而不是停在初始）。
 *
 * 与 `restart-state` 的分工：本 tag **不做进程重启**，只依赖 main() 的**冷重载**——
 * 文件阅读状态是 zustand **内存态**，冷重载即等价于「本会话首次进入」，故 A1 可单独复跑。
 * `restart-state` 仍是更强证据（真进程重启 + 跨进程不恢复 + 之后读真实差异），保留不删。
 * 拆出的原因（2026-09-24 验收复跑实测）：脚本内 `spawn` 起 dev 在本环境起不来
 * （detached 子进程随父脚本退出被回收）⇒ 需要一个不依赖重启也能钉住 A1 的 tag。
 */
async function scenarioFirstEnter(call) {
  const m = {};

  const before = await storeState(call, SUB_RUN);
  m.beforeEnter = before;
  check(
    "冷重载后文件阅读状态为「从未进入」（entered=false ⇒ 后续断言才是真正的首次进入）",
    before.error === undefined && before.entered === false,
    JSON.stringify(before),
  );

  Object.assign(m, await enterFiles(call, SUB_RUN, null, "全部"), { enter: true });
  m.ckpts = (await dom(call)).ckpts;
  m.store = await storeState(call, SUB_RUN);
  const active = await ev(call, CKPT_ACTIVE_EXPR);
  m.activeCkpt = active;
  await shot(call, SHOT_DIR, "first-enter-1-首次进入落默认检查点.png");

  check(
    "首次进入落到**最近自有完成步骤**（第 2 轮），而不是初始状态",
    typeof active === "string" && active.includes("第 2 轮"),
    JSON.stringify({ active, ckpts: m.ckpts }),
  );
  check(
    "会话状态真的被写回默认检查点（checkpoint 非 null ⇒ 不是「停在初始」）",
    m.store.error === undefined && m.store.entered === true && m.store.checkpoint !== null,
    JSON.stringify({ entered: m.store.entered, checkpoint: m.store.checkpoint }),
  );

  return m;
}

// ---------------------------------------------------------------------------
// 驱动
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const data = loadOut();
  const call = await reconnect(false).catch(async () => {
    const page = await cdpConnect(PORT);
    return makeSession(page.webSocketDebuggerUrl);
  });
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

  // 冷重载：清掉上一个 tag 留下的选中 run / 页面状态，并保证运行名单可读
  // （`keyboard-offline` 随后还会再 reload 一次——它要在自己的 reload 之后采集资源表）
  await call("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      if ((await runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间 */
    }
  }
  await sleep(900);
  const ready = (await runs(call)).length;
  console.log(`冷重载完成：运行列表 ${ready} 项`);
  if (ready === 0) throw new Error("运行列表为空——夹具未就绪");

  let out = {};
  if (TAG === "probe") out = await scenarioProbe(call);
  else if (TAG === "restart-state") out = await scenarioRestartState(call);
  else if (TAG === "first-enter") out = await scenarioFirstEnter(call);
  else if (TAG === "migrate") out = await scenarioMigrate(call);
  else if (TAG === "keyboard-offline") out = await scenarioKeyboardOffline(call);
  else if (TAG === "compat") out = await scenarioCompat(call);
  else throw new Error(`unknown tag: ${TAG}`);
  data.measurements[TAG] = out;

  if (TAG !== "probe") {
    data.checks = data.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
  }
  saveOut(data);

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n完成：[${TAG}] ${checks.length - failed.length}/${checks.length} 通过；证据 ${SHOT_DIR}`,
  );
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  restoreAll();
  console.error(e);
  process.exit(1);
});
