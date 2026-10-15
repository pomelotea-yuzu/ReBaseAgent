/* eslint-disable */
/**
 * refine-ui-for-community-release 任务 5.6：**Electron 实机验收**。
 *
 * 流程（tasks 5.6 原文）：纯键盘走通上述入口、来源返回、完整 ID 复制、折叠、活动和确认，
 * 核对模态焦点与背景隔离；另用独立空／非空测试数据目录验证「首次打开与无运行入口」，
 * 核对列表迟到不覆盖已进入创建及详情失败不遍历。证据落索引 R01/R05/R07/N04/N08/N16。
 *
 * 三组（每组一 dev 一轮——5.5 纪律）：
 * - `--tag=keyboard`（默认 dev 数据目录）：真键盘（lib/u3-65-input.ps1，keybd_event 系统级）
 *   走通——新建运行（R07 键盘面）→ 列表「＋ 新建运行」同流程（N16）→ 搜索过滤 + 真键盘选 run →
 *   键盘切「分支关系」（R01，trace 指纹零新增）→ LongText 折叠/展开 →
 *   键盘复制完整 ID（N04 键盘路径，剪贴板回读）→ 会话活动开/Esc 关焦点还原（N08 键盘可达）→
 *   设置模态（焦点入对话框 + Tab 焦点圈 + Esc 关焦点还原）→ 录制接入 + 返回来源 →
 *   放弃草稿确认模态（背景真实坐标点击被 top layer 拦截 + 键盘确认删除 + Esc 取消保留）。
 * - `--tag=emptydir`（前置：.rebaseagent 已整体改名走、dev 起在**全新空数据目录**上）：
 *   空目录首开——「数据目录里还没有运行记录」空态 + 可操作的新建/录制入口（无营销欢迎页）；
 *   进入创建输入文本后 loadRuns 迟到不覆盖（R05 半边）。
 * - `--tag=nonempty`（前置：数据目录已还原、dev 全新启动）：非空首开——自动只进最近可读 run
 *   的概览且不遍历（R05）；列表迟到不覆盖已进入创建（R05）；详情读取失败原位错误 +
 *   不自动遍历 + 还原后原位重试成功（R05）。
 *
 * 🔴 键盘步进纪律（首版实测教训 2026-10-15：无锚点长步进把焦点沿运行列表逐行游走、
 *    逐条选中 trace，既慢又扰人）：
 * - **一律近锚点短步进**：先 DOM 锚定到目标邻近的已知元素（U6 6.8 同款「页签栏锚点」），
 *   真键盘 TAB/SHIFT+TAB 只走 ≤14 步，绝不穿越运行列表；
 * - 列表选行走真实用户路径：**搜索框过滤到单行 → TAB 一两步 → ENTER**，不走长途；
 * - 模态在场时真键盘一律 `-Raise 0`。
 *
 * 其他证据纪律：
 * - 真键盘只发 TAB/SHIFT+TAB/ENTER/ESC（不涉 IME 组合）；回执行在 OutFile。
 * - H.ev 自动 parse 包装下布尔比较一律 `=== false`/`=== true`（5.4 坑）。
 * - 剪贴板回读 Promise.race 3s 限时（U6 6.8 坑）。
 * - 背景隔离判据用 CDP dispatchMouseEvent 真实坐标（程序化 click 绕过 top layer——5.3 坑）。
 * - R01 指纹判据：traces 目录全量（相对路径+sha256）切换前后一致 ⇒ 无新增扫描。
 *
 * 用法：node apps/desktop/scripts/refine-56-cdp.cjs --tag=keyboard|emptydir|nonempty
 * 前置：dev 已带 CDP 9612 启动（后台托管）；本探针无 LLM 执行段（不占 18799）。
 */
"use strict";

const { readFileSync, writeFileSync, mkdirSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const H = require("./lib/u4-smoke-harness.cjs");
const { listPageTarget } = require("./editor-collapse-probe.cjs");

// 本探针的 H.ev 表达式**全部**返回 JSON.stringify 字符串 ⇒ 包一层自动解析。
// ⚠️ storeQ 已是解析对象（不能再 parse）；非 JSON 字符串（如 'clicked'）原样透传。
const _rawEv = H.ev;
H.ev = async (call, expression) => {
  const v = await _rawEv(call, expression);
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
};

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");
    return i < 0 ? [a.replace(/^--/, ""), true] : [a.slice(2, i), a.slice(i + 1)];
  }),
);
const TAG = String(ARGS.tag ?? "keyboard");

const ROOT = join(H.REPO, ".workbuddy", "refine-ui", "5x");
const SHOTS = join(ROOT, "shots");
mkdirSync(SHOTS, { recursive: true });

const INPUT_PS1 = join(H.REPO, "apps", "desktop", "scripts", "lib", "u3-65-input.ps1");
const TRACES = H.TRACES ?? join(H.REPO, ".rebaseagent", "traces");
const RUN_FORK = process.env.R56_FORK_RUN ?? "run_mtmgz1v1"; // 普通对话 run（键盘选行标的）
const RUN_LONG = process.env.R56_LONG_RUN ?? "run_mudwrlbg_199xw1"; // 含 10k 长文本

const checks = [];
const dump = {};
function check(name, ok, detail) {
  checks.push({ tag: TAG, name, ok: ok === true, detail: detail ?? null });
  const shown =
    detail === undefined || detail === null
      ? ""
      : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : shown}`);
}
function note(text) {
  console.log(`ℹ ${text}`);
  checks.push({ tag: TAG, name: `[登记] ${text}`, ok: true, note: true });
}
function finish(extra = {}) {
  const failed = checks.filter((c) => !c.ok && !c.note);
  writeFileSync(
    join(ROOT, `r56-${TAG}-measurements.json`),
    `${JSON.stringify({ tag: TAG, ...extra, checks, failed: failed.length, dump }, null, 2)}\n`,
    "utf8",
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：r56/${TAG} 超过 16 分钟未收尾`);
  writeFileSync(join(ROOT, `r56-${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 960_000);

// ---------------------------------------------------------------------------
// 通道小件
// ---------------------------------------------------------------------------

const evAwait = async (call, expression) => {
  const r = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`evAwait: ${d.exception?.description ?? d.text}`);
  }
  return r?.result?.value;
};

async function shot(call, name) {
  const file = await H.shot(call, SHOTS, `r56-${TAG}-${name}.png`).catch((e) => String(e));
  console.log(`  [截图] ${file}`);
  return file;
}

/** 等应用活着：root 有内容且 store 可导入（dev 冷启动时 vite 首轮构建可能数十秒） */
async function waitAppAlive(call, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const alive = await H.ev(
        call,
        `(() => JSON.stringify({
           root: (document.getElementById('root')?.innerHTML.length ?? 0) > 1000,
         }))()`,
      );
      if (alive.root === true) {
        const n = await H.storeQ(call, "return JSON.stringify({ ok: true });");
        if (n && n.ok === true) return true;
      }
    } catch {
      /* 模块图还在加载 */
    }
    if (Date.now() > deadline) return false;
    await H.sleep(600);
  }
}

/** 带「文档哨兵」的 reload（U4 6.6：reload 偶发不换文档 ⇒ 全程假绿） */
async function reloadVerified(call) {
  const sentinel = `r56-${Date.now()}`;
  await H.ev(call, `window.__r56Doc = ${JSON.stringify(sentinel)}; "ok"`);
  await call("Page.reload").catch(() => {});
  for (;;) {
    let doc = sentinel;
    try {
      doc = await H.ev(call, "window.__r56Doc ?? null");
    } catch {
      /* 文档在换 */
    }
    if (doc !== sentinel && (await waitAppAlive(call, 30000))) return;
    if (!(await waitAppAlive(call, 20000))) continue;
  }
}

// ── 真键盘通道（u6-68 同款基建）──────────────────────────────────────────────

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
    out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}
/** u3-65-input.ps1 的回执行写在 OutFile（stdout 只有 lines=N）⇒ 读文件并剥 BOM */
async function inputPs(action, extra = []) {
  PS_SEQ += 1;
  const outFile = join(ROOT, `r56-input-${process.pid}-${PS_SEQ}.txt`);
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
async function realKeys(tokens, { raise = "0", gapMs = 90 } = {}) {
  const info = await inputPs("keys", ["-Send", tokens, "-Raise", raise, "-GapMs", String(gapMs)]);
  if (info.RESULT === undefined || !String(info.RESULT).includes("sent")) {
    throw new Error(`真键盘发送失败：${JSON.stringify(info).slice(0, 200)}`);
  }
  await H.sleep(600);
  return info;
}
/** 激活主窗口并拿 pid（首轮 raise=1 保证前台；其后一律 raise=0） */
async function resolveMainWindow() {
  const info = await inputPs("resolve");
  const n = Number(info["main-pid"]);
  MAIN_PID = Number.isInteger(n) && n > 0 ? n : 0;
  if (MAIN_PID === 0) throw new Error(`找不到主窗口 pid：${JSON.stringify(info).slice(0, 200)}`);
  // 首次激活
  await realKeys("TAB", { raise: "1" });
}

/** 读焦点（aria/text/tag/title 摘要） */
const focusInfo = (call) =>
  H.ev(
    call,
    `(() => { const e = document.activeElement; return e === null ? null
        : JSON.stringify({ tag: e.tagName, aria: e.getAttribute('aria-label') ?? '',
                           text: (e.textContent || '').trim().slice(0, 24),
                           id: e.id ?? '', title: e.title ?? '' }); })()`,
  );

/**
 * 近锚点短步进：先执行 anchorJs（DOM 内聚焦锚点，**不按键**），再真键盘 TAB/SHIFT+TAB
 * 有界步进到谓词命中。anchorJs 是页内语句（如 `document.querySelector('...').focus();`）。
 */
async function tabUntil(call, anchorJs, match, { max = 14, back = false } = {}) {
  await H.ev(call, `(() => { ${anchorJs} return JSON.stringify('anchored'); })()`);
  await H.sleep(250);
  // 锚点即目标（活动条首钮即触发钮等）⇒ 零步可达，如实登记
  const f0raw = await focusInfo(call);
  const p0 = typeof f0raw === "string" ? JSON.parse(f0raw) : f0raw;
  if (p0 !== null && match(p0)) return { arrived: true, steps: 0, focus: p0, trail: [] };
  const key = back ? "SHIFT+TAB" : "TAB";
  const trail = [];
  for (let i = 0; i < max; i++) {
    await realKeys(key);
    const f = await focusInfo(call);
    const p = typeof f === "string" ? JSON.parse(f) : f;
    if (p === null) {
      // 焦点丢失（如走入原生菜单条/未挂载元素）⇒ 立即停步，绝不继续游走
      trail.push(null);
      return { arrived: false, focus: null, trail };
    }
    trail.push(p);
    if (match(p)) return { arrived: true, steps: i + 1, focus: p, trail };
  }
  return { arrived: false, focus: null, trail };
}

/** 真实坐标点击指定选择器元素中心（先滚动进视口）。
 * allowCovered=true：elementFromPoint 被盖（如 top layer 的 dialog backdrop）也算取点成功——
 * 「背景点击被模态拦截」判据里被盖本身即预期（5.3 坑：程序化 click 绕过 top layer，必须真坐标）。 */
async function realClickSelector(call, pickExpr, label, { allowCovered = false } = {}) {
  const pt = await H.ev(
    call,
    `(() => {
       const el = (${pickExpr});
       if (!el || el.offsetParent === null) return JSON.stringify({ ok: false, why: 'no-el' });
       el.scrollIntoView({ behavior: 'instant', block: 'center' });
       const r = el.getBoundingClientRect();
       const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
       const hit = document.elementFromPoint(cx, cy);
       if (!hit || (hit !== el && !el.contains(hit) && !hit.contains(el)))
         return JSON.stringify({ ok: ${allowCovered === true}, why: 'covered', cx, cy });
       return JSON.stringify({ ok: true, cx, cy });
     })()`,
  );
  if (pt.ok !== true) throw new Error(`真实坐标点击(${label})取点失败：${JSON.stringify(pt)}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await call("Input.dispatchMouseEvent", {
      type,
      x: pt.cx,
      y: pt.cy,
      button: "left",
      clickCount: 1,
    });
  }
  await H.sleep(800);
  return pt;
}

/** 页内点按钮（文本精确匹配） */
const clickButtonByText = async (call, text) =>
  H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button')).find(x =>
         ((x.textContent || '').trim()) === ${JSON.stringify(text)} && x.offsetParent !== null);
       if (!b) return 'no-button';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked';
     })()`,
  );

/** 剪贴板回读（3s 限时：权限未决时 readText 永不 resolve —— U6 6.8 坑） */
async function readClipboard(call) {
  const raw = await evAwait(
    call,
    `(async () => {
       try {
         const t = await Promise.race([
           navigator.clipboard.readText(),
           new Promise((_, rej) => setTimeout(() => rej(new Error('clipboard-timeout')), 3000)),
         ]);
         return JSON.stringify({ ok: true, text: t });
       } catch (e) {
         return JSON.stringify({ ok: false, why: String((e && e.message) || e) });
       }
     })()`,
  );
  return JSON.parse(raw);
}

/** traces 目录指纹（相对路径 + sha256；R01 无新增扫描判据） */
function tracesFingerprint() {
  const out = new Map();
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else {
        const buf = readFileSync(p);
        out.set(r, createHash("sha256").update(buf).digest("hex"));
      }
    }
  };
  walk(TRACES, "");
  return out;
}

function fingerprintsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

/** store 视图状态 */
const viewState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({ view: s.view, sel: s.selectedRunId,
       reading: s.readingByRun && s.selectedRunId ? (s.readingByRun[s.selectedRunId] ?? null) : null });`,
  );

/** 全局栏读数（refine-51 同款） */
const globalBarState = (call) =>
  H.ev(
    call,
    `(() => {
       const bars = Array.from(document.querySelectorAll('header'))
         .filter(h => (h.textContent || '').includes('ReBaseAgent'));
       const bar = bars[0] ?? null;
       if (bar === null) return JSON.stringify({ present: false });
       const toggle = (t) => {
         const b = Array.from(bar.querySelectorAll('button'))
           .find(x => ((x.textContent || '').trim()) === t);
         return b === undefined ? null : { present: true, pressed: b.getAttribute('aria-pressed') === 'true' };
       };
       return JSON.stringify({
         present: true,
         runView: toggle('运行记录'),
         branchView: toggle('分支关系'),
       });
     })()`,
  );

/** 活动面板状态（refine-53 同款） */
const activityState = (call) =>
  H.ev(
    call,
    `(() => {
       const trigger = document.querySelector('button[aria-controls="session-activity-panel"]');
       const panel = document.getElementById('session-activity-panel');
       return JSON.stringify({
         triggerPresent: trigger !== null,
         triggerFocused: trigger !== null && document.activeElement === trigger,
         panelOpen: panel !== null,
       });
     })()`,
  );

// 常用锚点（近锚点短步进纪律：锚点 = 目标邻近的已知元素，DOM 聚焦不按键）
const ANCHOR = {
  // 全局栏第一个按钮（header 在 DOM 最前，2–4 步内到目标，不穿越列表）
  headerFirst: `const gb = Array.from(document.querySelectorAll('header')).find(h => (h.textContent || '').includes('ReBaseAgent'));
     const b0 = gb && gb.querySelector('button'); if (b0) b0.focus();`,
  // 页签栏第一个可见页签（详情区短步进起点——U6 6.8 同款）
  tabBarFirst: `const t0 = Array.from(document.querySelectorAll('[role="tab"]')).find(x => x.offsetParent !== null);
     if (t0) t0.focus();`,
  // 底部活动条容器第一个按钮
  activityBarFirst: `const trig = document.querySelector('button[aria-controls="session-activity-panel"]');
     const bar = trig && trig.closest('footer,div');
     const b0 = bar && bar.querySelector('button'); if (b0) b0.focus();`,
  // 通用容器第一个可聚焦元素
  containerFirst: (sel) => `const c = document.querySelector(${JSON.stringify(sel)});
     const b0 = c && c.querySelector('button, [href], input, [tabindex]:not([tabindex="-1"])');
     if (b0) b0.focus();`,
  blur: "if (document.activeElement) document.activeElement.blur();",
};

// ---------------------------------------------------------------------------
// keyboard 组
// ---------------------------------------------------------------------------

async function runKeyboard(call) {
  note(
    "前置 fixtures：键盘组依赖 dev 数据目录既有 run（R56_FORK_RUN / R56_LONG_RUN，缺则先重注入）",
  );
  const runs = await H.storeQ(call, "return JSON.stringify({ ids: s.runs.map(r => r.id) });");
  if (!runs.ids.includes(RUN_FORK) || !runs.ids.includes(RUN_LONG)) {
    throw new Error(
      `fixtures 缺失：fork=${runs.ids.includes(RUN_FORK)} long=${runs.ids.includes(RUN_LONG)}`,
    );
  }
  const fpBefore = tracesFingerprint();

  // ── K1 R07 键盘面：全局栏短步进到「新建运行」并进入创建 ────────────────────
  const k1 = await tabUntil(call, ANCHOR.headerFirst, (p) => p.text === "新建运行", { max: 8 });
  check("K1 R07 键盘面：全局栏「新建运行」键盘可达（近锚点短步进）", k1.arrived === true, {
    steps: k1.arrived ? k1.steps : k1.trail.length,
    trail: k1.trail.map((x) => x?.text ?? x?.aria),
  });
  await realKeys("ENTER");
  await H.sleep(900);
  const st1 = await viewState(call);
  check("K1 真键盘 ENTER 进入创建工作区（s.view === 'create'）", st1.view === "create", st1);

  // ── K2 N16：创建草稿写入 → 列表「＋ 新建运行」是同一流程（草稿保持）────────
  const draftText = "r56 键盘连通性输入";
  await H.typeIntoDom(call, "#create-user-message", draftText);
  const afterType = await H.ev(
    call,
    `(() => JSON.stringify({ v: document.querySelector('#create-user-message')?.value ?? null }))()`,
  );
  check("K2 前置：创建表单 User Message 写入成功", afterType.v === draftText, afterType);
  await clickButtonByText(call, "运行记录");
  await H.sleep(700);
  const listCreate = await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button')).find(x =>
         ((x.textContent || '').replace(/\\s+/g, ' ').trim()) === '＋ 新建运行' && x.offsetParent !== null);
       if (!b) return 'no-button';
       b.click(); return 'clicked';
     })()`,
  );
  await H.sleep(800);
  const st2 = await viewState(call);
  const val2 = await H.ev(
    call,
    `(() => JSON.stringify({ v: document.querySelector('#create-user-message')?.value ?? null }))()`,
  );
  check(
    "K2 N16 列表「＋ 新建运行」与全局栏同一流程：回到创建且草稿逐字保持",
    listCreate === "clicked" && st2.view === "create" && val2.v === draftText,
    { listCreate, view: st2.view, value: val2.v },
  );

  // ── K3 真键盘选 run：搜索框过滤到单行 → TAB 一两步 → ENTER（真实用户路径）──
  await clickButtonByText(call, "运行记录");
  await H.sleep(700);
  await H.typeIntoDom(call, 'input[placeholder="搜索完整任务或运行 ID"]', RUN_FORK);
  await H.sleep(900);
  const filtered = await H.storeQ(
    call,
    "return JSON.stringify({ n: s.runs.length, sel: s.selectedRunId });",
  );
  // 锚点 = 搜索框本身（列表已过滤到目标单行，TAB 一两步即到行钮，不穿越长列表）
  const k3 = await tabUntil(
    call,
    `const s0 = document.querySelector('input[placeholder="搜索完整任务或运行 ID"]'); if (s0) s0.focus();`,
    (p) =>
      String(p.aria).startsWith(`复制完整运行 ID ${RUN_FORK}`) ||
      String(p.aria).includes(RUN_FORK.slice(0, 12)),
    { max: 8 },
  );
  check("K3 搜索过滤后真键盘 TAB 可达目标 run 行（不穿越长列表）", k3.arrived === true, {
    steps: k3.arrived ? k3.steps : k3.trail.length,
    filteredRuns: filtered.n,
  });
  if (k3.arrived) {
    // 行结构：选择钮在复制钮之前。若正落在复制钮上，SHIFT+TAB 一步到选择钮
    const onCopy = String(k3.focus.aria ?? "").startsWith(`复制完整运行 ID ${RUN_FORK}`);
    if (onCopy) await realKeys("SHIFT+TAB");
    const selBefore = await viewState(call);
    await realKeys("ENTER");
    await H.sleep(1400);
    const selAfter = await viewState(call);
    check(
      "K3 真键盘 ENTER 选中该 run（selectedRunId 切到目标）",
      selAfter.sel === RUN_FORK && selBefore.sel !== RUN_FORK,
      { before: selBefore.sel, after: selAfter.sel },
    );
  }
  await H.typeIntoDom(call, 'input[placeholder="搜索完整任务或运行 ID"]', "");
  await H.sleep(500);

  // ── K4 R01 键盘切「分支关系」：视图切换 + 列表复用 + trace 指纹零新增 ──────
  const k4 = await tabUntil(call, ANCHOR.headerFirst, (p) => p.text === "分支关系", { max: 8 });
  check("K4 R01 键盘可达「分支关系」视图切换钮", k4.arrived === true, {
    steps: k4.arrived ? k4.steps : k4.trail.length,
  });
  if (k4.arrived) {
    await realKeys("ENTER");
    await H.sleep(1200);
    const gb4 = await globalBarState(call);
    const tree4 = await H.ev(
      call,
      `(() => JSON.stringify({ svg: document.querySelectorAll('svg').length }))()`,
    );
    check(
      "K4 R01 键盘 ENTER 切到分支树（aria-pressed 真且树渲染）",
      gb4.branchView !== null && gb4.branchView.pressed === true && tree4.svg > 0,
      { gb: gb4.branchView, svg: tree4.svg },
    );
    const fpAfterTree = tracesFingerprint();
    check(
      "K4 R01 分支树切换复用列表、无新增扫描（traces 指纹逐字节不变）",
      fingerprintsEqual(fpBefore, fpAfterTree),
      { before: fpBefore.size, after: fpAfterTree.size },
    );
    // 键盘切回运行记录（带一次重试：真键 ENTER 偶发落在游移焦点上）
    let k4bPresses = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const k4b = await tabUntil(call, ANCHOR.headerFirst, (p) => p.text === "运行记录", {
        max: 8,
      });
      if (!k4b.arrived) break;
      await realKeys("ENTER");
      k4bPresses += 1;
      await H.sleep(900);
      const gbTry = await globalBarState(call);
      if (gbTry.runView?.pressed === true) break;
    }
    const gb4b = await globalBarState(call);
    check(
      "K4 R01 键盘切回「运行记录」（单选态回正；ENTER 次数如实登记）",
      gb4b.runView?.pressed === true,
      { runView: gb4b.runView, presses: k4bPresses },
    );
  }

  // ── K5 折叠：LongText 展开/收起（真键盘；锚点 = 页签栏）───────────────────
  // 先确保回到运行记录视图（K4 后视图态可能残留树视图）
  await clickButtonByText(call, "运行记录");
  await H.sleep(700);
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(RUN_LONG)}); return JSON.stringify("ok");`,
  );
  await H.sleep(1500);
  // 切到步骤页签（selectRun 落在概览，LLM 调用行只在步骤页）
  await H.ev(
    call,
    `(() => {
       const t = Array.from(document.querySelectorAll('[role="tab"]'))
         .find(x => (x.textContent || '').includes('步骤') && x.offsetParent !== null);
       if (!t) return 'no-tab';
       t.click(); return 'clicked';
     })()`,
  );
  await H.sleep(1000);
  // 轮换 llm.call 行直到出现「点击展开」（r54 同款，DOM 定位仅用于备好判据现场；上限放宽到 12 行）
  let expandedReady = false;
  for (let i = 0; i < 12 && !expandedReady; i++) {
    await H.ev(
      call,
      `(() => {
         const rows = Array.from(document.querySelectorAll('button'))
           .filter(x => (x.title || '').includes('LLM 调用') && x.offsetParent !== null);
         if (rows.length <= ${i}) return 'no-row-' + rows.length;
         rows[${i}].click(); return 'clicked';
       })()`,
    );
    await H.sleep(1200);
    expandedReady = await H.ev(
      call,
      `(() => Array.from(document.querySelectorAll('summary, button'))
          .some(x => (x.textContent || '').includes('点击展开') && x.offsetParent !== null))()`,
    );
  }
  check("K5 前置：定位到含长文本折叠块的步骤行", expandedReady === true, { expandedReady });
  if (expandedReady) {
    // 锚点 = 页签栏首签（详情区短步进，绝不回到列表）
    const k5 = await tabUntil(
      call,
      ANCHOR.tabBarFirst,
      (p) => String(p.text).includes("点击展开") || String(p.text).includes("收起"),
      { max: 14 },
    );
    check("K5 键盘可达长文本折叠钮（页签栏锚点短步进）", k5.arrived === true, {
      steps: k5.arrived ? k5.steps : k5.trail.length,
      trail: k5.trail.map((x) => x?.text ?? x?.aria),
    });
    if (k5.arrived) {
      await realKeys("ENTER");
      await H.sleep(800);
      // 判据 = 焦点所在 details 的 open 态（页面上可能同时有多个长文本块，
      // 「全部无折叠摘要」是错误判据——只断言被操作的那一块真实展开）
      const openState = await H.ev(
        call,
        `(() => {
           const ae = document.activeElement;
           const d = ae && ae.closest ? ae.closest('details') : null;
           return JSON.stringify({ focusedDetailsOpen: d !== null && d.open === true });
         })()`,
      );
      check(
        "K5 键盘 ENTER 展开长文本（焦点所在 details open）",
        openState.focusedDetailsOpen === true,
        openState,
      );
      // 焦点仍在原 summary 上 ⇒ 再 ENTER 收起
      await realKeys("ENTER");
      await H.sleep(800);
      const closedState = await H.ev(
        call,
        `(() => {
           const ae = document.activeElement;
           const d = ae && ae.closest ? ae.closest('details') : null;
           return JSON.stringify({ focusedDetailsOpen: d !== null && d.open === true });
         })()`,
      );
      check(
        "K5 键盘再 ENTER 收起长文本（焦点所在 details 收起）",
        closedState.focusedDetailsOpen === false,
        closedState,
      );
    }
  }

  // ── K6 N04 键盘路径：键盘复制完整运行 ID（锚点 = 页签栏，反向短步进）───────
  const k6 = await tabUntil(
    call,
    ANCHOR.tabBarFirst,
    (p) => String(p.aria).startsWith(`复制完整 运行 ID ${RUN_LONG}`),
    { max: 14, back: true },
  );
  check("K6 N04 键盘可达页头「复制完整 运行 ID」钮", k6.arrived === true, {
    steps: k6.arrived ? k6.steps : k6.trail.length,
  });
  if (k6.arrived) {
    await realKeys("ENTER");
    await H.sleep(700);
    const clip = await readClipboard(call);
    const feedback = await H.ev(
      call,
      `(() => {
         const b = Array.from(document.querySelectorAll('button'))
           .find(x => (x.getAttribute('aria-label') || '').startsWith('复制完整 运行 ID '));
         if (!b) return 'no-button';
         return JSON.stringify((b.parentElement ? b.parentElement.textContent : '').includes('已复制完整 ID'));
       })()`,
    );
    check(
      "K6 N04 键盘复制：剪贴板回读 == 完整原始 ID + 「已复制完整 ID」反馈",
      clip.ok === true && clip.text === RUN_LONG && feedback === true,
      { clip: clip.ok === true ? `len=${clip.text.length}` : clip.why, feedback },
    );
  }

  // ── K7 N08 键盘可达：会话活动开/Esc 关 + 焦点还原（锚点 = 活动条首钮）──────
  const k7 = await tabUntil(
    call,
    ANCHOR.activityBarFirst,
    // ⚠️ 触发钮可访问名来自文本（无 aria-label 属性）⇒ 按 text 匹配
    (p) => String(p.text).includes("会话活动") || String(p.aria).includes("会话活动"),
    { max: 6 },
  );
  check(
    "K7 N08 键盘可达「会话活动」触发钮（活动条锚点短步进；steps=0 表示锚点即目标）",
    k7.arrived === true,
    {
      steps: k7.arrived ? k7.steps : k7.trail.length,
      focus: k7.focus,
    },
  );
  if (k7.arrived) {
    await realKeys("ENTER");
    await H.sleep(800);
    const open7 = await activityState(call);
    check("K7 键盘 ENTER 打开会话活动面板", open7.panelOpen === true, open7);
    await realKeys("ESC");
    await H.sleep(700);
    const afterEsc = await activityState(call);
    check(
      "K7 真键 Esc 关闭活动面板且焦点还原触发按钮（N08 键盘面）",
      afterEsc.panelOpen === false && afterEsc.triggerFocused === true,
      afterEsc,
    );
  }

  // ── K8 设置模态：键盘开、焦点入对话框、Tab 焦点圈、Esc 关焦点还原 ──────────
  const k8 = await tabUntil(
    call,
    ANCHOR.headerFirst,
    (p) => String(p.title).includes("配置 LLM 接入"),
    { max: 8 },
  );
  check("K8 键盘可达「配置 LLM 接入」设置入口", k8.arrived === true, {
    steps: k8.arrived ? k8.steps : k8.trail.length,
  });
  if (k8.arrived) {
    // ENTER 打开（带一次重试：真键 ENTER 偶发落在游移焦点上；次数如实登记）
    let k8Presses = 0;
    let dlg8 = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await realKeys("ENTER");
      k8Presses += 1;
      await H.sleep(900);
      dlg8 = await H.ev(
        call,
        `(() => {
           const dlgs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"]'));
           const d = dlgs[dlgs.length - 1] ?? null;
           const ae = document.activeElement;
           return JSON.stringify({
             open: d !== null,
             focusInside: d !== null && ae !== null && d.contains(ae),
           });
         })()`,
      );
      if (dlg8.open === true) break;
      // 重试前重新锚定（上一发 ENTER 可能落在游移焦点上）
      await tabUntil(call, ANCHOR.headerFirst, (p) => String(p.title).includes("配置 LLM 接入"), {
        max: 8,
      });
    }
    check(
      "K8 键盘 ENTER 打开设置模态且焦点落入对话框内（ENTER 次数如实登记）",
      dlg8 !== null && dlg8.open === true && dlg8.focusInside === true,
      { ...dlg8, presses: k8Presses },
    );
    let trapOk = true;
    const trapTrail = [];
    for (let i = 0; i < 6; i++) {
      await realKeys("TAB");
      const inside = await H.ev(
        call,
        `(() => {
           const dlgs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"]'));
           const d = dlgs[dlgs.length - 1] ?? null;
           const ae = document.activeElement;
           return JSON.stringify(d !== null && ae !== null && d.contains(ae));
         })()`,
      );
      trapTrail.push(inside);
      if (inside !== true) trapOk = false;
    }
    check("K8 模态焦点圈：连续 6 次真 TAB 焦点始终在对话框内（背景隔离）", trapOk, trapTrail);
    await realKeys("ESC");
    await H.sleep(700);
    let closed8 = await H.ev(
      call,
      `(() => JSON.stringify({ n: document.querySelectorAll('dialog[open], [role="dialog"]').length }))()`,
    );
    let escPresses = 1;
    if (closed8.n > 0) {
      await realKeys("ESC");
      escPresses = 2;
      await H.sleep(700);
      closed8 = await H.ev(
        call,
        `(() => JSON.stringify({ n: document.querySelectorAll('dialog[open], [role="dialog"]').length }))()`,
      );
    }
    const k8f = await focusInfo(call);
    const k8p = typeof k8f === "string" ? JSON.parse(k8f) : k8f;
    check(
      "K8 真键 Esc 关闭设置模态且焦点还原设置入口（按下次数如实登记）",
      closed8.n === 0 && k8p !== null && String(k8p.title).includes("配置 LLM 接入"),
      { escPresses, closed: closed8.n, focus: k8p },
    );
  }

  // ── K9 R07 键盘面：录制接入进入既有工作区 + 返回来源 ────────────────────────
  const k9 = await tabUntil(call, ANCHOR.headerFirst, (p) => p.text === "录制接入", { max: 8 });
  check("K9 R07 键盘可达「录制接入」入口", k9.arrived === true, {
    steps: k9.arrived ? k9.steps : k9.trail.length,
  });
  if (k9.arrived) {
    await realKeys("ENTER");
    await H.sleep(1100);
    const st9 = await viewState(call);
    const rec9 = await H.ev(
      call,
      `(() => JSON.stringify({
         recText: (document.body.textContent || '').includes('录制'),
         hasReturn: Array.from(document.querySelectorAll('button')).some(x => {
           const a = x.getAttribute('aria-label') || '';
           return a === '返回来源' || a.startsWith('返回') ||
                  ((x.textContent || '').trim()).startsWith('回到运行记录');
         }),
       }))()`,
    );
    check(
      "K9 R07 键盘 ENTER 进入既有录制工作区（N16：不新建第二条流程）",
      st9.view !== "create" && rec9.recText === true && rec9.hasReturn === true,
      { view: st9.view, ...rec9 },
    );
    // 键盘返回来源：锚点 = AuxWorkspaceFrame 容器（data-aux-frame）首可聚焦元素，短步进找返回钮
    // （返回钮 aria 可能是自定义 returnLabel，如「返回运行记录…」⇒ 按「返回*」前缀匹配）
    const k9b = await tabUntil(
      call,
      ANCHOR.containerFirst('[data-aux-frame="true"]'),
      (p) =>
        String(p.aria) === "返回来源" ||
        String(p.aria).startsWith("返回") ||
        String(p.text).startsWith("回到运行记录"),
      { max: 10 },
    );
    if (k9b.arrived) {
      await realKeys("ENTER");
      await H.sleep(1000);
      const st9b = await viewState(call);
      check(
        "K9 键盘返回来源：退出录制工作区回到来源 run 阅读位（R07 来源返回；trace/runs 均为运行记录视图族）",
        st9b.view === "runs" ||
          st9b.view === "trace" ||
          st9b.view === "tree" ||
          st9b.view === "run",
        st9b,
      );
    } else {
      check("K9 键盘返回来源入口可达", false, {
        note: "短步进未命中返回钮",
        trail: k9b.trail.map((x) => x?.text ?? x?.aria),
      });
    }
  }

  // ── K10 确认模态：背景隔离（真实坐标点击被拦截）+ 键盘取消保留 / 确认删除 ──
  await clickButtonByText(call, "新建运行");
  await H.sleep(900);
  await H.typeIntoDom(call, "#create-user-message", "r56 放弃确认草稿");
  await H.ev(
    call,
    `(() => {
       const t = document.querySelector('button[aria-controls="session-activity-panel"]');
       if (t) t.click();
       return 'ok';
     })()`,
  );
  await H.sleep(700);
  const abandon10 = await H.ev(
    call,
    `(() => {
       const panel = document.getElementById('session-activity-panel');
       if (!panel) return 'no-panel';
       const b = Array.from(panel.querySelectorAll('button')).find(x => (x.title || '').startsWith('放弃该草稿'));
       if (!b) return 'no-abandon';
       b.click(); return 'clicked';
     })()`,
  );
  await H.sleep(800);
  const dlg10 = await H.ev(
    call,
    `(() => {
       const dlgs = Array.from(document.querySelectorAll('dialog[open]'));
       const d = dlgs[dlgs.length - 1] ?? null;
       return JSON.stringify({
         open: d !== null,
         isAbandon: d !== null && (d.textContent || '').includes('放弃草稿'),
       });
     })()`,
  );
  check(
    "K10 前置：放弃草稿确认模态在场（放弃草稿 + 确认/取消）",
    dlg10.open === true && dlg10.isAbandon === true,
    { abandon: abandon10, ...dlg10 },
  );
  if (dlg10.open === true) {
    // (a) 背景隔离：真实坐标点击全局栏「新建运行」必须被 top layer 拦截
    // （allowCovered：坐标点被 dialog backdrop 盖住即 top layer 在场的直接证据，不是失败）
    await realClickSelector(
      call,
      `Array.from(document.querySelectorAll('header button')).find(x => ((x.textContent || '').trim()) === '新建运行')`,
      "背景·全局栏新建运行",
      { allowCovered: true },
    );
    const afterBg = await H.ev(
      call,
      `(() => {
         const dlgs = Array.from(document.querySelectorAll('dialog[open]'));
         const d = dlgs[dlgs.length - 1] ?? null;
         return JSON.stringify({ stillOpen: d !== null, n: dlgs.length });
       })()`,
    );
    check(
      "K10 背景隔离：模态在场时真实坐标点击全局栏入口被 top layer 拦截（视图不动、模态不关）",
      afterBg.stillOpen === true,
      afterBg,
    );
    // (b) Esc 取消保留：真键 Esc ⇒ 模态关、草稿保留
    await realKeys("ESC", { raise: "0" });
    await H.sleep(700);
    const afterCancel = await H.ev(
      call,
      `(() => JSON.stringify({
         n: document.querySelectorAll('dialog[open]').length,
         draft: document.querySelector('#create-user-message')?.value ?? null,
       }))()`,
    );
    check(
      "K10 键盘 Esc = 取消：模态关闭且草稿逐字保留",
      afterCancel.n === 0 && afterCancel.draft === "r56 放弃确认草稿",
      afterCancel,
    );
    // (c) 再放弃 ⇒ 键盘短步进到「确认放弃」⇒ ENTER ⇒ 草稿删除（锚点 = 对话框内首钮）
    await H.ev(
      call,
      `(() => {
         const panel = document.getElementById('session-activity-panel');
         const b = panel && Array.from(panel.querySelectorAll('button')).find(x => (x.title || '').startsWith('放弃该草稿'));
         if (!b) return 'no-abandon';
         b.click(); return 'clicked';
       })()`,
    );
    await H.sleep(800);
    const k10 = await tabUntil(
      call,
      `const dlgs = Array.from(document.querySelectorAll('dialog[open]'));
       const d = dlgs[dlgs.length - 1];
       const b0 = d && d.querySelector('button'); if (b0) b0.focus();`,
      (p) => p.text === "确认放弃",
      { max: 6 },
    );
    if (k10.arrived) {
      await realKeys("ENTER");
      await H.sleep(900);
      const afterConfirm = await H.ev(
        call,
        `(() => JSON.stringify({
           n: document.querySelectorAll('dialog[open]').length,
           draft: document.querySelector('#create-user-message')?.value ?? null,
         }))()`,
      );
      check(
        "K10 键盘 ENTER 确认放弃：模态关、草稿删除（确认经键盘完成）",
        afterConfirm.n === 0 && (afterConfirm.draft === null || afterConfirm.draft === ""),
        afterConfirm,
      );
    } else {
      check("K10 键盘可达「确认放弃」钮", false, {
        note: "短步进未命中",
        trail: k10.trail.map((x) => x?.text ?? x?.aria),
      });
    }
  }

  await shot(call, "final");
}

// ---------------------------------------------------------------------------
// emptydir 组（前置：.rebaseagent 已改名走、dev 起在全新空数据目录）
// ---------------------------------------------------------------------------

async function runEmptyDir(call) {
  await reloadVerified(call);
  // E1 空态首开：无营销欢迎页 + 可操作的新建/录制入口
  const empty1 = await H.ev(
    call,
    `(() => {
       const t = document.body.textContent || '';
       const noRuns = t.includes('数据目录里还没有运行记录');
       const btns = Array.from(document.querySelectorAll('button'));
       const mkEmpty = btns.find(x => ((x.textContent || '').trim()) === '新建运行' && x.offsetParent !== null);
       const recEmpty = btns.find(x => ((x.textContent || '').trim()) === '接入录制' && x.offsetParent !== null);
       const gb = Array.from(document.querySelectorAll('header')).find(h => (h.textContent || '').includes('ReBaseAgent'));
       const gbCreate = gb && Array.from(gb.querySelectorAll('button')).find(x => ((x.textContent || '').trim()) === '新建运行');
       const gbRec = gb && Array.from(gb.querySelectorAll('button')).find(x => ((x.textContent || '').trim()) === '录制接入');
       return JSON.stringify({
         noRuns, hasEmptyCreate: mkEmpty !== undefined, hasEmptyRecord: recEmpty !== undefined,
         gbCreateOk: gbCreate !== undefined && gbCreate.disabled === false,
         gbRecOk: gbRec !== undefined && gbRec.disabled === false,
         bodyHead: t.replace(/\\s+/g, ' ').slice(0, 200),
       });
     })()`,
  );
  check(
    "E1 R05 空目录首开：空态文案 + 空态新建/录制两钮 + 全局栏两入口可操作（无营销欢迎页）",
    empty1.noRuns === true &&
      empty1.hasEmptyCreate === true &&
      empty1.hasEmptyRecord === true &&
      empty1.gbCreateOk === true &&
      empty1.gbRecOk === true,
    empty1,
  );
  await shot(call, "empty-first-open");

  // E2 从空态进入创建并写入输入
  const e2 = await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button')).find(x =>
         ((x.textContent || '').trim()) === '新建运行' && x.offsetParent !== null);
       if (!b) return 'no-button';
       b.click(); return 'clicked';
     })()`,
  );
  await H.sleep(900);
  const st2 = await viewState(call);
  check("E2 空态「新建运行」进入创建工作区", e2 === "clicked" && st2.view === "create", {
    e2,
    view: st2.view,
  });
  const draftText = "r56 空目录首开输入";
  await H.typeIntoDom(call, "#create-user-message", draftText);

  // E3 R05 列表迟到不覆盖已进入创建：loadRuns（真实读路径）落地后页面与输入保持
  const before3 = await viewState(call);
  await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("loaded");`);
  await H.sleep(800);
  const after3 = await viewState(call);
  const val3 = await H.ev(
    call,
    `(() => JSON.stringify({ v: document.querySelector('#create-user-message')?.value ?? null }))()`,
  );
  check(
    "E3 R05 列表迟到不覆盖：创建页保持、输入逐字保持、选中不被列表落地方改写",
    after3.view === "create" && val3.v === draftText && after3.sel === before3.sel,
    { view: after3.view, value: val3.v, selBefore: before3.sel, selAfter: after3.sel },
  );

  // E4 空态下键盘可达性冒烟：全局栏「录制接入」空目录同样可达（R07 空目录面）
  const e4 = await tabUntil(call, ANCHOR.headerFirst, (p) => p.text === "录制接入", { max: 8 });
  check("E4 R07 空目录面：真键盘 TAB 仍可达「录制接入」入口", e4.arrived === true, {
    steps: e4.arrived ? e4.steps : e4.trail.length,
  });
}

// ---------------------------------------------------------------------------
// nonempty 组（前置：数据目录已还原、dev 全新启动）
// ---------------------------------------------------------------------------

async function runNonEmpty(call) {
  // N1 R05 非空首开：自动只进最近可读 run 的概览，且不遍历
  await waitAppAlive(call);
  await H.sleep(1200); // 等自动选择落定
  const st1 = await viewState(call);
  const runs1 = await H.storeQ(
    call,
    "return JSON.stringify({ ids: s.runs.map(r => r.id), len: s.runs.length });",
  );
  const autoSelected = st1.sel !== null && st1.sel !== undefined;
  const isLatest = autoSelected && runs1.ids.length > 0 && st1.sel === runs1.ids[0];
  const tab1 = st1.reading ? st1.reading.tab : null;
  check(
    "N1 R05 非空首开：无选中起点自动只进最近可读 run（选中 == 列表首条）",
    autoSelected === true && isLatest === true,
    { sel: st1.sel, first: runs1.ids[0], total: runs1.len },
  );
  check("N1 R05 首选进入概览页签", tab1 === "overview", { tab: tab1 });
  // 不遍历：3s 内选中稳定不跳
  await H.sleep(3000);
  const st1b = await viewState(call);
  check("N1 R05 不遍历：3s 后选中稳定不跳（无自动遍历其他运行）", st1b.sel === st1.sel, {
    before: st1.sel,
    after: st1b.sel,
  });

  // N2 R05 列表迟到不覆盖已进入创建（非空目录形态）
  await H.ev(
    call,
    `(() => {
       const gb = Array.from(document.querySelectorAll('header')).find(h => (h.textContent || '').includes('ReBaseAgent'));
       const b = gb && Array.from(gb.querySelectorAll('button')).find(x => ((x.textContent || '').trim()) === '新建运行');
       if (!b) return 'no-button';
       b.click(); return 'clicked';
     })()`,
  );
  await H.sleep(900);
  const draftText = "r56 非空迟到输入";
  await H.typeIntoDom(call, "#create-user-message", draftText);
  const before2 = await viewState(call);
  await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("loaded");`);
  await H.sleep(800);
  const after2 = await viewState(call);
  const val2 = await H.ev(
    call,
    `(() => JSON.stringify({ v: document.querySelector('#create-user-message')?.value ?? null }))()`,
  );
  check(
    "N2 R05 列表迟到不覆盖已进入创建：页面保持、输入保持、选中不变",
    after2.view === "create" && val2.v === draftText && after2.sel === before2.sel,
    { view: after2.view, value: val2.v, selBefore: before2.sel, selAfter: after2.sel },
  );

  // N3 R05 详情失败不遍历：隐藏目标 run 文件 ⇒ 选中失败原位错误 ⇒ 还原后原位重试
  const faults = require("./lib/u5-read-faults.cjs");
  const target = runs1.ids.find((x) => x !== st1.sel) ?? runs1.ids[0];
  const handle = faults.beginReadFault({ tracesDir: TRACES, runId: target }, "fileMissing");
  try {
    await H.storeQ(
      call,
      `await s.selectRun(${JSON.stringify(target)}); return JSON.stringify("ok");`,
    );
    await H.sleep(1800);
    // 不遍历：轮询选中 5×400ms，只允许「钉在目标」或「回退到此前选中」两种形态
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      const st = await viewState(call);
      seen.add(st.sel);
      await H.sleep(400);
    }
    const legal = new Set([target, st1.sel]);
    const noHop = Array.from(seen).every((x) => legal.has(x)) && seen.size <= 2;
    check(
      "N3 R05 详情失败不遍历：选中只钉在目标/回退旧选中，绝不自动跳到其他运行",
      noHop === true,
      { seen: Array.from(seen), target, prev: st1.sel },
    );
    // 原位错误：store error 落地「读取 run 失败：<原因>」（外壳红色横幅消费该字段）
    const errUi = await H.storeQ(
      call,
      "return JSON.stringify({ err: s.error, loading: s.loadingDetail });",
    );
    const errOk =
      typeof errUi.err === "string" &&
      errUi.err.includes("读取 run 失败") &&
      errUi.loading === false;
    check(
      "N3 R05 选择失败原位可辨（store error 落真实读取失败原因，不静默吞掉）",
      errOk === true,
      errUi,
    );
    // 还原后原位重试：先解除注入，再 reopenRun（spec「结果不可读不重执行」的显式只读重试口）
    let ended = false;
    const endOnce = () => {
      if (!ended) {
        ended = true;
        handle.end();
      }
    };
    endOnce();
    await H.sleep(600);
    await H.storeQ(
      call,
      `await s.reopenRun(${JSON.stringify(target)}); return JSON.stringify("ok");`,
    );
    await H.sleep(1800);
    const stRetry = await viewState(call);
    const detailOk = await H.storeQ(
      call,
      `return JSON.stringify({ sel: s.selectedRunId, err: s.error,
         detailId: s.detail && s.detail.meta ? s.detail.meta.id : null });`,
    );
    check(
      "N3 R05 原位重试：故障还原后 reopenRun 同 ID 重读 ⇒ 详情读取成功（不换运行、不重执行）",
      detailOk.sel === target && detailOk.detailId === target && detailOk.err === null,
      { sel: stRetry.sel, ...detailOk },
    );
  } catch (e) {
    try {
      handle.end();
    } catch {
      /* 已还原 */
    }
    throw e;
  } finally {
    try {
      handle.end();
    } catch {
      /* 已还原（body 正常路径已 end，finally 二次 end 抛错属预期） */
    }
  }
  await shot(call, "nonempty-final");
}

// ---------------------------------------------------------------------------

async function main() {
  const page = await listPageTarget(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

  if (TAG === "nonempty") {
    // 非空首开判据必须在**首次加载**上做——不 reload（reload 会带上会话态，不算首开）。
    const alive = await waitAppAlive(call);
    if (!alive) throw new Error("应用 120s 未就绪（nonempty 组要求干净首开）");
    dump.firstLoad = true;
    await runNonEmpty(call);
  } else {
    await reloadVerified(call);
    await resolveMainWindow();
    if (TAG === "emptydir") await runEmptyDir(call);
    else if (TAG === "keyboard") await runKeyboard(call);
    else throw new Error(`未知 tag：${TAG}（keyboard|emptydir|nonempty）`);
  }
  finish({ when: new Date().toISOString() });
}

main().catch((e) => {
  console.error(`r56/${TAG} 探针异常：${e?.stack ?? e}`);
  writeFileSync(join(ROOT, `r56-${TAG}-error.txt`), String(e?.stack ?? e));
  clearTimeout(watchdog);
  process.exit(2);
});
