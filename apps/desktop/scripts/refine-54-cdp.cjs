/* eslint-disable */
/**
 * refine-ui-for-community-release 任务 5.4：**Electron 实机回归**。
 *
 * 范围（tasks 5.4 原文）：
 * - R2.1 导出回归：确认／取消／成功／失败及切检查点反馈；来源、阅读和目标不串。
 * - R08「阅读过程不修改已有数据」：**单独在纯阅读阶段**核对零模型／工具调用 +
 *   trace／附件／源目录指纹不变。
 * - 导出仅写选定空目录的显式路径：由「目标三件套逐项核对 + dataDir 全程指纹不变」承载。
 *
 * 段序（单 dev、无 mock——导出与阅读均不调模型）：
 * - P0 准备：连接 + 开局哨兵 reload + 基线（dataDir 指纹 / pick 行数 / 登记数 / runs 数）。
 * - P1 R08 纯阅读（run_mtmgz1v1，llm/step/tool/budget 俱备）：loadRuns 刷新、列表搜索、
 *   概览/步骤/文件往返、选中 llm.call、展开长文本原文、展开预算地图、分支树往返；
 *   终判指纹不变 + runs 不变 + 登记零新增。
 * - P2 导出成功：export_e2e_root 自有 step s_01 → 确认卡 → exported → 目标三件套。
 * - P3 切检查点反馈：切初始 → 确认卡收起 + s_01 反馈不显示。
 * - P4 取消：pick 控制文件 __cancel__ → canceled + 零写入文案。
 * - P5 失败两形态：ghost ownOnly（RUN_LINEAGE_INCOMPLETE 且对话框未开）；
 *   非空目标（target_invalid 且既有内容不变）。
 * - P6 来源/阅读/目标不串：切 meta run 反馈不串显；meta 导出成功独立目标；
 *   切回 root 反馈按提交键存活；概览往返存活；终判 dataDir 指纹仍等于基线。
 *
 * 前置：dev 已带 CDP 9612 + REBASEAGENT_PICK_DIRECTORY_FILE=<本目录 r54-pick-control.txt> 启动
 * （目录对话框经控制文件接管，每次接管向 <file>.calls.log 追加一行）。
 * fixture（export_e2e_*）已在 dev dataDir（上次 7.1a 批次遗留，本轮不注入不改动）。
 * 用法：node apps/desktop/scripts/refine-54-cdp.cjs
 */
"use strict";

const {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { listPageTarget } = require("./editor-collapse-probe.cjs");
const H = require("./lib/u4-smoke-harness.cjs");

// H.ev 返回值统一自动 parse（refine-51 纪律：非 JSON 字符串原样透传）
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

const ROOT = join(H.REPO, ".workbuddy", "refine-ui", "5x");
const SHOTS = join(ROOT, "shots");
mkdirSync(SHOTS, { recursive: true });

const TAG = "r54";
const PICK_FILE = join(ROOT, `${TAG}-pick-control.txt`);
const PICK_LOG = `${PICK_FILE}.calls.log`;
const DATA = join(H.REPO, ".rebaseagent");

const READ_RUN = "run_mudwrlbg_199xw1"; // R08 纯阅读 run（ws + budget + 3 llm.call，最长报文 10k 字符可折叠展开）
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
    join(ROOT, `${TAG}-measurements.json`),
    `${JSON.stringify({ tag: TAG, ...extra, checks, failed: failed.length, dump }, null, 2)}\n`,
    "utf8",
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 14 分钟未收尾`);
  writeFileSync(join(ROOT, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 840_000);

// ---------------------------------------------------------------------------
// 通道小件（抄自 refine-51 已验证实现）
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
  const file = await H.shot(call, SHOTS, `${TAG}-${name}.png`).catch((e) => String(e));
  console.log(`  [截图] ${file}`);
  return file;
}

async function waitAppAlive(call, timeoutMs = 90000) {
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
  if (!(await waitAppAlive(call))) {
    throw new Error("应用 90s 未就绪（root 空 / store 不可导入）");
  }
  const sentinel = `${TAG}-${Date.now()}`;
  await H.ev(call, `window.__${TAG}Doc = ${JSON.stringify(sentinel)}; "ok"`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await call("Page.reload", { ignoreCache: false });
    const deadline = Date.now() + 45000;
    for (;;) {
      let doc = sentinel;
      let ready = false;
      try {
        doc = await H.ev(call, `window.__${TAG}Doc ?? null`);
        if (doc !== sentinel) {
          const n = await H.storeQ(call, "return JSON.stringify({ runs: s.runs.length });");
          ready = n.runs > 0;
        }
      } catch {
        /* 重载瞬间 */
      }
      if (doc !== sentinel && ready) return true;
      if (Date.now() > deadline) break;
      await H.sleep(400);
    }
    console.log(`  [reload] 第 ${attempt} 次未换文档或未就绪，重试`);
    await waitAppAlive(call);
  }
  throw new Error("reload 三次均未换文档（U4 6.6 已知坑，重试仍失败）");
}

/** store 直选 run（列表 aria-label 受视图状态影响，store 是权威导航——71a 纪律） */
const storeSelectRun = async (call, id) => {
  await H.storeQ(call, `await s.selectRun(${JSON.stringify(id)}); return JSON.stringify('ok');`);
  await H.sleep(2000);
};

const opsCount = async (call) => {
  const st = await H.apiCall(call, "operationsStatus");
  if (!st.ok) throw new Error(`operationsStatus 失败：${JSON.stringify(st.error)}`);
  return st.data.operations.length;
};
const runsCount = async (call) => {
  const n = await H.storeQ(call, "return JSON.stringify({ n: s.runs.length });");
  return n.n;
};

// ---------------------------------------------------------------------------
// pick 控制文件与 dataDir 指纹（抄自 probe-71a 已验证实现）
// ---------------------------------------------------------------------------

function setPick(value) {
  writeFileSync(PICK_FILE, value === null ? "__cancel__\n" : `${value}\n`);
}
function pickCalls() {
  try {
    return readFileSync(PICK_LOG, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** traces + workspace-blobs 内容指纹（R08：阅读与导出不得改动数据目录） */
function dataFingerprint() {
  const hashFile = (full) =>
    createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16);
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}:${hashFile(full)}`);
    }
  };
  walk(join(DATA, "traces"), "traces/");
  walk(join(DATA, "workspace-blobs"), "blobs/");
  return out;
}

function targetFiles(target) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}:${statSync(full).size}`);
    }
  };
  walk(target, "");
  return out;
}

// ---------------------------------------------------------------------------
// 导出 UI 交互（抄自 probe-71a 已验证实现）
// ---------------------------------------------------------------------------

async function waitForFeedback(call, kinds, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const kind = await H.ev(
      call,
      `(() => { const el = document.querySelector('[data-export-feedback]');
        return el ? el.getAttribute('data-export-feedback') : null; })()`,
    );
    if (kind !== null && kinds.includes(kind)) return kind;
    await H.sleep(400);
  }
  return null;
}
const feedbackText = (call) =>
  H.ev(call, `(() => document.querySelector('[data-export-feedback]')?.textContent ?? '')()`);

async function ensureFileTab(call) {
  await H.clickTab(call, "文件");
  await H.sleep(2500);
  const entry = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-export-entry]');
      if (!b) return 'no-entry'; if (b.disabled) return 'disabled'; return 'ok'; })()`,
  );
  if (entry !== "ok") throw new Error(`导出入口不可用：${entry}`);
  // 幂等展开：确认卡已展开（上一段残留）则不重复 toggle（否则会收起）
  const expanded = await H.ev(
    call,
    `(() => document.querySelector('[data-export-entry]')?.getAttribute('aria-expanded'))()`,
  );
  if (expanded !== "true") {
    await H.ev(call, `document.querySelector('[data-export-entry]').click()`);
    await H.sleep(500);
  }
  const confirmText = await H.ev(
    call,
    `(() => { const el = document.querySelector('[data-export-confirm="true"]');
      const card = el ? el.closest('[data-export-confirm]') : null;
      return card ? card.textContent : null; })()`,
  );
  return confirmText;
}

async function clickConfirm(call) {
  const ok = await H.ev(
    call,
    `(() => { const b = document.querySelector('button[data-export-confirm="true"]');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok !== true) throw new Error("确认按钮未找到");
}

function confirmTextOk(text) {
  return (
    typeof text === "string" &&
    text.includes("空目录") &&
    text.includes("files/") &&
    text.includes("未保留") &&
    text.includes("选择目标目录并导出") &&
    text.includes("取消（不写入）")
  );
}

// ---------------------------------------------------------------------------
// R08 阅读动作小件
// ---------------------------------------------------------------------------

/** 列表搜索框输入与清空（placeholder 定位） */
async function searchRuns(call, text) {
  await H.typeIntoDom(call, 'input[placeholder="搜索完整任务或运行 ID"]', text);
  const value = await H.ev(
    call,
    `(() => document.querySelector('input[placeholder="搜索完整任务或运行 ID"]')?.value ?? null)()`,
  );
  await H.typeIntoDom(call, 'input[placeholder="搜索完整任务或运行 ID"]', "");
  return value;
}

/** 详情区内展开第一个可展开长文本（LongText 摘要行含「点击展开」） */
async function expandFirstLongText(call) {
  return H.ev(
    call,
    `(() => {
       const s = Array.from(document.querySelectorAll('summary, button'))
         .find(x => (x.textContent || '').includes('点击展开') && x.offsetParent !== null);
       if (!s) return 'no-collapsed-longtext';
       s.click(); return 'expanded';
     })()`,
  );
}

/** 展开预算地图折叠区块（标题文本「上下文预算地图」） */
async function expandBudgetMap(call) {
  return H.ev(
    call,
    `(() => {
       const t = Array.from(document.querySelectorAll('summary, button, [role="button"]'))
         .find(x => (x.textContent || '').includes('上下文预算地图') && x.offsetParent !== null);
       if (!t) return 'no-budget-block';
       t.click(); return 'clicked';
     })()`,
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const page = await listPageTarget(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await reloadVerified(call);

  // ── P0 准备：目标目录预置 + 基线 ─────────────────────────────────────────
  for (const name of ["target-r54", "target-r54-meta", "target-r54-nonempty"]) {
    rmSync(join(ROOT, name), { recursive: true, force: true });
  }
  mkdirSync(join(ROOT, "target-r54"), { recursive: true });
  mkdirSync(join(ROOT, "target-r54-meta"), { recursive: true });
  mkdirSync(join(ROOT, "target-r54-nonempty"), { recursive: true });
  writeFileSync(join(ROOT, "target-r54-nonempty", "existing.txt"), "hello\n");
  setPick(join(ROOT, "target-r54")); // P2 目标（控制文件可能残留上一轮的值）

  const fp0 = dataFingerprint();
  const picks0 = pickCalls();
  const ops0 = await opsCount(call);
  const runs0 = await runsCount(call);
  dump.baseline = { files: fp0.length, picks: picks0, ops: ops0, runs: runs0 };
  console.log(
    `  [基线] 指纹文件 ${fp0.length} 个、pick ${picks0} 行、登记 ${ops0} 条、runs ${runs0} 个`,
  );

  // ── P1 R08 纯阅读（全程不点任何执行入口）─────────────────────────────────
  await storeSelectRun(call, READ_RUN);
  const selCheck = await H.storeQ(
    call,
    "return JSON.stringify({ sel: s.selectedRunId, tabs: s.readingByRun ? Object.keys(s.readingByRun).length : -1 });",
  );
  check("R08-1 纯阅读进入 run（store 选中回读）", selCheck.sel === READ_RUN, selCheck);

  // loadRuns 刷新读路径（列表无独立刷新按钮 ⇒ 直调同一条读路径，如实登记）
  const reloaded = await H.storeQ(
    call,
    "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });",
  );
  check("R08-2 刷新（loadRuns 读路径）成功", reloaded.n === runs0, reloaded);

  const searchVal = await searchRuns(call, "时间旅行");
  check("R08-3 列表搜索输入与清空", searchVal === "时间旅行", searchVal);

  const tabMiss = [];
  for (const tab of ["概览", "步骤", "文件", "概览"]) {
    if (!(await H.clickTab(call, tab))) tabMiss.push(tab);
    await H.sleep(900);
  }
  check(
    "R08-4 概览/步骤/文件页签往返（READ_RUN 有自有 workspace ⇒ 三页签齐备）",
    tabMiss.length === 0,
    tabMiss,
  );

  await H.clickTab(call, "步骤");
  await H.sleep(1500);
  // 轮换点击 LLM 调用行，直到详情出现可折叠长文本（该 run 仅 s_12 的 10k 报文超阈值）
  let spanClicked = "no-row";
  let spanSel = null;
  for (let i = 0; i < 4; i++) {
    spanClicked = await H.ev(
      call,
      `(() => { const rows = Array.from(document.querySelectorAll('button'))
          .filter(x => (x.title||'').includes('LLM 调用') && x.offsetParent !== null);
        if (rows.length <= ${i}) return 'no-row-' + rows.length;
        rows[${i}].click(); return 'clicked'; })()`,
    );
    await H.sleep(1500);
    const hasLongText = await H.ev(
      call,
      `(() => Array.from(document.querySelectorAll('summary, button'))
          .some(x => (x.textContent || '').includes('点击展开') && x.offsetParent !== null))()`,
    );
    spanSel = await H.storeQ(call, "return JSON.stringify({ span: s.selectedSpanId });");
    if (hasLongText === true) break;
  }
  check("R08-5 选中含长文本的 llm.call 行", spanClicked === "clicked" && spanSel?.span != null, {
    spanClicked,
    spanSel,
  });

  const expand1 = await expandFirstLongText(call);
  const expandedDom = await H.ev(
    call,
    `(() => document.querySelector('input[placeholder="在原文中查找"]') !== null
        || Array.from(document.querySelectorAll('button')).some(x => (x.textContent||'').includes('复制原文')))()`,
  );
  check("R08-6 展开长文本原文（查找/复制工具条在场）", expandedDom === true, {
    expand1,
    expandedDom,
  });

  const budget = await expandBudgetMap(call);
  check("R08-7 预算地图区块展开动作", budget === "clicked", budget);

  // 分支树往返（全局栏切换按钮）
  await H.clickTab(call, "概览");
  await H.sleep(600);
  const toBranch = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '分支关系' && x.offsetParent !== null);
      if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
  );
  await H.sleep(1200);
  const branchPressed = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '分支关系');
      return b ? b.getAttribute('aria-pressed') === 'true' : null; })()`,
  );
  const backToList = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '运行记录');
      if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
  );
  await H.sleep(800);
  check(
    "R08-8 分支树切出并切回",
    toBranch === "clicked" && branchPressed === true && backToList === "clicked",
    {
      toBranch,
      branchPressed,
      backToList,
    },
  );
  await shot(call, "p1-reading-done");

  const fp1 = dataFingerprint();
  const ops1 = await opsCount(call);
  const runs1 = await runsCount(call);
  check(
    "R08-9 阅读全程 trace/附件/源目录指纹逐字节不变",
    JSON.stringify(fp1) === JSON.stringify(fp0),
    { baseline: fp0.length, after: fp1.length },
  );
  check(
    "R08-10 阅读全程零新 run、零新登记（⇒ 零模型/工具调用的可证伪面）",
    runs1 === runs0 && ops1 === ops0,
    { runs: [runs0, runs1], ops: [ops0, ops1] },
  );
  note(
    "「零模型/工具调用」由指纹链承载：任何模型/工具执行都会经 runLoop 新建或追加 trace span（新 run 或 fork），指纹不变 ⇒ 零调用；另有登记计数零新增兜底。",
  );
  note(
    "「不从历史阅读状态继承执行授权」由提交链结构承载（隔离 fork 授权复选框每次提交默认未选、父 trace 的 write_authorized 只是历史审计标注——lib/isolated-fork.ts 与 DetailPanel.tsx 注释链 + 既有单测），非本轮实机判据。",
  );
  note(
    "「刷新」动作：运行列表 UI 无独立刷新按钮，用与刷新同一条读路径 loadRuns 直调承载（真实 IPC 读取）。",
  );

  // ── P2 导出成功（export_e2e_root 自有 step s_01）──────────────────────────
  await storeSelectRun(call, "export_e2e_root");
  await H.clickTab(call, "文件");
  await H.sleep(2500);
  const pickedStep = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.title||'') === '检查点所属 step：s_01');
      if (!b) return 'no-btn'; b.click(); return 'ok'; })()`,
  );
  if (pickedStep !== "ok") throw new Error(`选 s_01 失败：${pickedStep}`);
  // inspect 读取在途时入口短暂禁用 ⇒ 轮询至可用（固定等待会踩在途窗口）
  const entryDeadline = Date.now() + 15000;
  let entryEnabled = null;
  for (;;) {
    entryEnabled = await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-export-entry]');
        return b ? b.disabled : null; })()`,
    );
    if (entryEnabled === false) break;
    if (Date.now() > entryDeadline) break;
    await H.sleep(500);
  }
  check("E1 导出入口可用（清单核实且附件齐）", entryEnabled === false, entryEnabled);

  const confirmCard = await ensureFileTab(call);
  check("E2 确认卡列明空目录/files/布局/未保留，无物理路径输入", confirmTextOk(confirmCard), {
    len: confirmCard?.length ?? 0,
  });

  const beforePicks = pickCalls();
  await clickConfirm(call);
  const kindA = await waitForFeedback(call, ["exported", "failed"]);
  check("E3 导出成功反馈（exported）", kindA === "exported", kindA);
  check("E4 目录选择经控制文件接管恰一次", pickCalls() === beforePicks + 1, {
    delta: pickCalls() - beforePicks,
  });

  const textA = await feedbackText(call);
  check(
    "E5 成功反馈含目标/数量/补丁/未保留/诚实边界",
    textA.includes("target-r54") &&
      textA.includes("3 个文件") &&
      textA.includes("changes.patch") &&
      textA.includes("未保留") &&
      textA.includes("不表示项目可构建、测试通过或已应用"),
    textA.slice(0, 120),
  );

  const t1 = join(ROOT, "target-r54");
  check(
    "E6 目标三件套 + files/ 字节（仅写选定空目录的显式路径）",
    existsSync(join(t1, "rebaseagent-export.json")) &&
      existsSync(join(t1, "changes.patch")) &&
      existsSync(join(t1, "files", "added.txt")) &&
      !existsSync(join(t1, "files", "gone.txt")) &&
      readFileSync(join(t1, "files", "a.txt"), "utf8") === "after\nsecond line\n",
    targetFiles(t1),
  );
  const manifest = JSON.parse(readFileSync(join(t1, "rebaseagent-export.json"), "utf8"));
  check(
    "E7 清单 source（run/step）与补丁状态正确",
    manifest.source.run_id === "export_e2e_root" &&
      manifest.source.step_span_id === "s_01" &&
      manifest.patch.status === "written" &&
      manifest.files.every((f) => f.status === "exported"),
    manifest.patch.status,
  );

  // ── P3 切检查点反馈 ──────────────────────────────────────────────────────
  const switchedB = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.title||'').includes('文件世界起点'));
      if (!b) return false; b.click(); return true; })()`,
  );
  await H.sleep(2500); // inspect 重载 + 切换收起 effect
  // ⚠️ H.ev 已自动 parse ⇒ aria-expanded 字符串 "false" 到手即布尔 false
  const collapsedB = await H.ev(
    call,
    `(() => document.querySelector('[data-export-entry]')?.getAttribute('aria-expanded'))()`,
  );
  const textB = await feedbackText(call);
  check(
    "E8 切检查点：确认卡收起且 s_01 反馈（target-r54）不显示",
    switchedB === true && collapsedB === false && !textB.includes("target-r54"),
    { switchedB, collapsedB, hasOldTarget: textB.includes("target-r54") },
  );

  // ── P4 取消 ──────────────────────────────────────────────────────────────
  setPick(null);
  await ensureFileTab(call);
  await clickConfirm(call);
  const kindF = await waitForFeedback(call, ["canceled", "exported", "failed"]);
  const textF = await feedbackText(call);
  check(
    "E9 取消：canceled 反馈（零写入文案）",
    kindF === "canceled" && textF.includes("没有写入任何内容"),
    kindF,
  );

  // ── P5 失败两形态 ────────────────────────────────────────────────────────
  // ① ghost ownOnly：入口可用（资格只看自有 inspect）、提交后 main 来源检查拒绝、对话框未开
  setPick(join(ROOT, "target-r54-meta")); // 若被错误打开会写入这里（预期不发生）
  const picksBeforeE = pickCalls();
  await storeSelectRun(call, "export_e2e_ghost");
  await ensureFileTab(call);
  await clickConfirm(call);
  const kindE = await waitForFeedback(call, ["failed", "exported", "canceled"]);
  const textE = await feedbackText(call);
  check(
    "E10 ownOnly 导出被拒（RUN_LINEAGE_INCOMPLETE）且对话框未开",
    kindE === "failed" && textE.includes("RUN_LINEAGE_INCOMPLETE") && pickCalls() === picksBeforeE,
    { kindE, picks: pickCalls() - picksBeforeE },
  );

  // ② 非空目标
  setPick(join(ROOT, "target-r54-nonempty"));
  await storeSelectRun(call, "export_e2e_root");
  await ensureFileTab(call);
  await clickConfirm(call);
  const kindG = await waitForFeedback(call, ["failed", "canceled"]);
  const textG = await feedbackText(call);
  check(
    "E11 非空目标：target_invalid 且既有内容逐字节不变",
    kindG === "failed" &&
      textG.includes("target_invalid") &&
      textG.includes("非空") &&
      readFileSync(join(ROOT, "target-r54-nonempty", "existing.txt"), "utf8") === "hello\n",
    textG.slice(0, 80),
  );
  await shot(call, "p5-failure-done");

  // ── P6 来源/阅读/目标不串 ────────────────────────────────────────────────
  await storeSelectRun(call, "export_e2e_meta");
  const textMeta0 = await feedbackText(call);
  await ensureFileTab(call);
  const textMeta = await feedbackText(call);
  check(
    "E12 切到 meta run：root 的成功反馈不串显（反馈按提交 run/step 键隔离）",
    !textMeta0.includes("target-r54") &&
      !textMeta0.includes("3 个文件") &&
      !textMeta.includes("3 个文件"),
    { beforeTab: textMeta0.slice(0, 60), afterTab: textMeta.slice(0, 60) },
  );
  setPick(join(ROOT, "target-r54-meta"));
  await clickConfirm(call);
  const kindM = await waitForFeedback(call, ["exported", "failed"]);
  check("E13 meta run 独立目标导出成功", kindM === "exported", kindM);
  const mManifest = JSON.parse(
    readFileSync(join(ROOT, "target-r54-meta", "rebaseagent-export.json"), "utf8"),
  );
  check(
    "E14 meta 清单 source 归属正确（来源不串）",
    mManifest.source.run_id === "export_e2e_meta",
    mManifest.source.run_id,
  );

  await storeSelectRun(call, "export_e2e_root");
  await H.clickTab(call, "文件");
  await H.sleep(2500);
  // 文件页恢复上次检查点选择（P5b 时是 initial，其键上是 P5b 的 failed 反馈）；
  // 「反馈按提交键存活」的正验：切回 s_01 ⇒ 显示 s_01 提交的 exported（target-r54）
  const backStep = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.title||'') === '检查点所属 step：s_01');
      if (!b) return 'no-btn'; b.click(); return 'ok'; })()`,
  );
  const entryDeadline2 = Date.now() + 15000;
  for (;;) {
    const d = await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-export-entry]');
        return b ? b.disabled : null; })()`,
    );
    if (d === false || Date.now() > entryDeadline2) break;
    await H.sleep(500);
  }
  const textBack = await feedbackText(call);
  check(
    "E15 切回 root 并选回 s_01：该提交的 exported 反馈（target-r54）按提交键存活",
    backStep === "ok" && textBack.includes("target-r54") && textBack.includes("3 个文件"),
    { backStep, text: textBack.slice(0, 90) },
  );

  await H.clickTab(call, "概览");
  await H.sleep(800);
  await H.clickTab(call, "文件");
  await H.sleep(1500);
  const kindAfterReturn = await H.ev(
    call,
    `(() => document.querySelector('[data-export-feedback]')?.getAttribute('data-export-feedback') ?? null)()`,
  );
  check("E16 概览往返后反馈仍按提交目标显示", kindAfterReturn === "exported", kindAfterReturn);

  // ── 终判：整个会话（阅读+导出）dataDir 指纹不变 ─────────────────────────────
  const fp2 = dataFingerprint();
  check(
    "E17 全程 trace/附件/源目录指纹不变（导出仅写选定空目录的显式路径）",
    JSON.stringify(fp2) === JSON.stringify(fp0),
    { baseline: fp0.length, final: fp2.length },
  );
  const totalPicks = pickCalls();
  check(
    "E18 pick 接管总计恰 4 次（成功 2 / 取消 1 / 非空 1；ghost 不开框）",
    totalPicks === picks0 + 4,
    { baseline: picks0, total: totalPicks },
  );
  note(
    "「导出仅写选定空目录的显式路径」由 E6（目标三件套逐项核对）+ E17（dataDir 全程指纹不变）共同承载。",
  );

  const failed = checks.filter((c) => !c.ok && !c.note);
  await shot(call, "final");
  finish({
    readRun: READ_RUN,
    baseline: { files: fp0.length, picks: picks0, ops: ops0, runs: runs0 },
    targets: {
      success: targetFiles(t1),
      meta: targetFiles(join(ROOT, "target-r54-meta")),
    },
  });
}

main().catch((e) => {
  console.error(e);
  try {
    writeFileSync(join(ROOT, `${TAG}-error.txt`), String(e?.stack ?? e), "utf8");
  } catch {}
  process.exit(2);
});
