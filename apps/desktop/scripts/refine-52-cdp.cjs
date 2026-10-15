/* eslint-disable */
/**
 * refine-ui-for-community-release 任务 5.2：**Electron 实机验收**。
 *
 * 流程（tasks 5.2 原文）：分支选择 → 双运行比较 → 单侧文件 → 返回比较／原来源；
 * 验证「选中状态跨视图保持」（R02）、「文件承载区不附带步骤目录」（R06）及
 * 对象方向、导航偏好（N05）、比较返回；附件异常与普通无文件运行分别核对。
 * 证据落 evidence-index：R02 / R06 / N01（比较余量）/ N05 / N07。
 *
 * 场景分段（单 dev、单 tag 顺序执行；**纯只读**——不起 mock、不动 settings、
 * 不创建 run，N07 判据 = trace 文件指纹与 operations 全程零新增）：
 * - P0 准备：按 U7 既有惯例注入比较 fixtures（手工三跳 u7c_g/p/c/s + 真实引擎
 *   隔离三跳 + workspace-blobs），收尾按清单逐字节清除（生产数据不变）。
 * - P1 R02＋N07：选中 u7c_c → steps + s_09 → 切「分支关系」→ 切回「运行记录」
 *   ⇒ 恢复 run/页签/调用位置；全程 trace 集合与登记数不变。
 * - P2 分支选择→比较（N01 比较面）：树里勾 u7c_c、u7c_s（加入顺序定左右）→
 *   「进入详细比较」⇒ pair 左 c 右 s、两列身份与完整 ID 复制入口各自在列、
 *   全局栏不冒充；交换左右方向翻转再还原。
 * - P3 R06-a 普通无文件运行：比较页两列「打开文件」禁用 + title 真实原因
 *   （openCompareSideFiles 的 unsupported 判据诚实呈现，不伪造文件页）。
 * - P4 R06-b 隔离单侧文件：清空对照 → 勾隔离父/子 → 比较 → 「打开文件」
 *   （available）⇒ 文件页**不附带步骤目录**（DOM 断言）⇒「返回比较工作区」
 *   （幂等不重读：pair 与两侧内容保留）⇒「返回来源」回进入前视图。
 * - P5 N05 导航偏好：进入比较不写偏好（navUserCollapsed 原样）；比较页
 *   「打开运行列表」恢复入口在场可点且点击真开；退出比较恢复进前状态；
 *   实验页任务级适配（3.1）：进实验页导航临时收起、偏好原样、退出恢复。
 * - P6 N07 收口：trace 指纹与登记数全程零新增。
 *
 * 用法：node apps/desktop/scripts/refine-52-cdp.cjs
 * 前置：dev 已带 CDP 9612 启动；U7 fixtures 在 apps/desktop/test/fixtures/u7-compare。
 */
"use strict";

const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { listPageTarget } = require("./editor-collapse-probe.cjs");

const ROOT = join(H.REPO, ".workbuddy", "refine-ui", "5x");
const SHOTS = join(ROOT, "shots");
mkdirSync(SHOTS, { recursive: true });

const FIXTURES = join(H.REPO, "apps", "desktop", "test", "fixtures", "u7-compare");
const BLOBS_DIR = join(H.REPO, ".rebaseagent", "workspace-blobs", "sha256");

const HAND_TRACES = ["u7c_g.jsonl", "u7c_p.jsonl", "u7c_c.jsonl", "u7c_s.jsonl", "u7c_ep.jsonl"];
const ISO_TRACES = [
  "run_muo988yd_4btbgb.jsonl",
  "run_muo9892a_w2qj.jsonl",
  "run_muo9892r_s1m3.jsonl",
];
const ISO_PARENT = "run_muo988yd_4btbgb";
const ISO_CHILD = "run_muo9892a_w2qj";
const C = "u7c_c";
const S = "u7c_s";
const SPAN_C_OWN = "s_09";

const TAG = "r52";
/** 注入清单（收尾无论成败按此逐项清除——U7 fixtures 惯例：生产数据不变） */
const CLEANUP = { traces: [], blobs: [] };

async function cleanupFixtures() {
  // 先尽力把应用状态拨回（清对照、回 trace、刷列表），再删文件
  try {
    const page = await listPageTarget(H.CDP_PORT);
    const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
    await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => (x.getAttribute('aria-label') || '') === '清空对照集合');
         if (b !== undefined && b !== null) b.click(); return "ok"; })()`,
    ).catch(() => {});
    await H.storeQ(call, `s.setView("trace"); return JSON.stringify("ok");`).catch(() => {});
  } catch {
    /* 应用可能已关；直接删文件 */
  }
  for (const f of CLEANUP.traces) rmSync(join(H.TRACES, f), { force: true });
  for (const f of CLEANUP.blobs) rmSync(join(BLOBS_DIR, f), { force: true });
  try {
    const page = await listPageTarget(H.CDP_PORT);
    const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
    await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("ok");`).catch(() => {});
  } catch {
    /* noop */
  }
  console.log(`fixtures 清除：trace ${CLEANUP.traces.length} 个、blob ${CLEANUP.blobs.length} 个`);
}
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
function finish(extra = {}) {
  const failed = checks.filter((c) => !c.ok && !c.note);
  writeOut();
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  return failed.length;
}
function writeOut() {
  const { writeFileSync } = require("node:fs");
  writeFileSync(
    join(ROOT, `${TAG}-measurements.json`),
    `${JSON.stringify({ tag: TAG, ...dump, checks }, null, 2)}\n`,
    "utf8",
  );
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 14 分钟未收尾`);
  // 看门狗路径也要清 fixtures（同步删，再退出）
  for (const f of CLEANUP.traces) {
    try {
      rmSync(join(H.TRACES, f), { force: true });
    } catch {
      /* noop */
    }
  }
  for (const f of CLEANUP.blobs) {
    try {
      rmSync(join(BLOBS_DIR, f), { force: true });
    } catch {
      /* noop */
    }
  }
  require("node:fs").writeFileSync(join(ROOT, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 840_000);

async function shot(call, name) {
  const file = await H.shot(call, SHOTS, `${TAG}-${name}.png`).catch((e) => String(e));
  console.log(`  [截图] ${file}`);
}

/** 全局栏 header（含 ReBaseAgent 品牌字的那个 header） */
const globalBarHasId = (call, id) =>
  H.ev(
    call,
    `(() => {
       const bar = Array.from(document.querySelectorAll('header'))
         .find(h => (h.textContent || '').includes('ReBaseAgent'));
       if (bar === null) return 'no-bar';
       return (bar.textContent || '').includes(${JSON.stringify(id)}) ||
              (bar.innerHTML || '').includes(${JSON.stringify(id)});
     })()`,
  );

/** 点视图切换按钮（ViewToggle，aria-pressed 单选态） */
async function switchView(call, label) {
  const ok = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('header button'))
        .find(x => ((x.textContent || '').trim()) === ${JSON.stringify(label)});
       if (b === undefined || b === null) return 'no-button';
       b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked") return false;
  await H.sleep(1500);
  return true;
}

/** 树视图勾选对照（BranchTree 的对照控件是 input[type=checkbox]，非按钮） */
async function toggleCompareInTree(call, runId) {
  const r = await H.ev(
    call,
    `(() => {
       const want = ${JSON.stringify(runId)};
       const el = document.querySelector(
         'input[type="checkbox"][aria-label="把 ' + want + ' 加入对照"]');
       if (el === null) {
         const off = Array.from(document.querySelectorAll(
           'input[type="checkbox"][aria-label="移出对照 ' + want + '"]'))[0];
         if (off !== undefined) { off.click(); return 'clicked'; }
         return 'no-checkbox';
       }
       el.click(); return 'clicked';
     })()`,
  );
  if (r !== "clicked") throw new Error(`树里勾选 ${runId} 失败：${r}`);
  await H.sleep(700);
}

/** 比较页两列的复制按钮所在列标签（左列/右列） */
const compareColumnOf = (call, runId) =>
  H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button'))
         .find(x => (x.getAttribute('aria-label') || '') === '复制完整 ID ' + ${JSON.stringify(runId)});
       if (b === undefined || b === null) return 'no-button';
       let node = b;
       for (let i = 0; i < 8 && node !== null; i++) {
         node = node.parentElement;
         if (node !== null) {
           const t = node.textContent || '';
           if (t.includes('左列') && !t.includes('右列')) return 'left';
           if (t.includes('右列') && !t.includes('左列')) return 'right';
         }
       }
       return 'column-not-found';
     })()`,
  );

/** 导航状态（纯 DOM；对象直返——stringify→parse 往返实测不稳定，勿回退） */
const navState = (call) =>
  H.ev(
    call,
    `(() => {
       const toggle = document.getElementById('run-navigation-toggle');
       const navEl = document.getElementById('run-navigation');
       return {
         togglePresent: toggle !== null,
         toggleExpanded: toggle === null ? null : toggle.getAttribute('aria-expanded'),
         navInDom: navEl !== null,
       };
     })()`,
  );

// ---------------------------------------------------------------------------

async function main() {
  const page = await listPageTarget(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});

  // 开局哨兵 reload（5.1 纪律：不继承崩溃/HMR 残局）
  {
    const sentinel = `r52-${Date.now()}`;
    await H.ev(call, `window.__r52Doc = ${JSON.stringify(sentinel)}; "ok"`);
    let swapped = false;
    await call("Page.reload", { ignoreCache: false });
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        const doc = await H.ev(call, "window.__r52Doc ?? null");
        if (doc !== sentinel) {
          const n = await H.storeQ(call, "return JSON.stringify({ runs: s.runs.length });");
          if (n.runs > 0) {
            swapped = true;
            break;
          }
        }
      } catch {
        /* 重载瞬间 */
      }
      if (Date.now() > deadline) break;
      await H.sleep(400);
    }
    if (!swapped) throw new Error("开局 reload 未换文档或列表未就绪");
  }

  // ── P0 注入 fixtures（按清单拷贝，收尾按清单清除）────────────────────────
  const copiedTraces = [];
  const copiedBlobs = [];
  for (const f of [...HAND_TRACES, ...ISO_TRACES]) {
    const src = join(
      FIXTURES,
      existsSync(join(FIXTURES, "traces", f)) ? "traces" : "isolated-traces",
      f,
    );
    if (!existsSync(src)) throw new Error(`fixture 缺失：${src}`);
    copyFileSync(src, join(H.TRACES, f));
    copiedTraces.push(f);
  }
  for (const f of require("node:fs").readdirSync(join(FIXTURES, "isolated-blobs", "sha256"))) {
    const dst = join(BLOBS_DIR, f);
    if (!existsSync(dst)) {
      copyFileSync(join(FIXTURES, "isolated-blobs", "sha256", f), dst);
      copiedBlobs.push(f);
    }
  }
  dump.copied = { traces: copiedTraces, blobs: copiedBlobs };
  CLEANUP.traces.push(...copiedTraces);
  CLEANUP.blobs.push(...copiedBlobs);
  await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("ok");`);
  await H.sleep(800);
  const injected = await H.storeQ(
    call,
    `const want = [${[...HAND_TRACES, ...ISO_TRACES].map((f) => JSON.stringify(f.replace(".jsonl", ""))).join(",")}];
     return JSON.stringify({
       missing: want.filter(id => !s.runs.some(r => r.id === id)),
       n: s.runs.length,
     });`,
  );
  check(
    "P0 fixtures 注入：7 条比较标本（手工三跳 + 隔离三跳）都在列表",
    injected.missing.length === 0,
    injected,
  );

  // 基线：trace 集合 + 登记数（N07 全程不变判据）
  const tracesBefore = H.traceIds();
  const opsBefore = await H.storeQ(
    call,
    "return JSON.stringify({ n: s.operations.operations.length });",
  );

  // ── P1 R02 选中状态跨视图保持 ──────────────────────────────────────────
  await H.selectRun(call, C);
  await H.sleep(800);
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(C)}, "steps");
     s.selectSpan(${JSON.stringify(SPAN_C_OWN)});
     return JSON.stringify("ok");`,
  );
  await H.sleep(1200);
  await switchView(call, "分支关系");
  const inTree = await H.storeQ(call, "return JSON.stringify({ view: s.view });");
  check("R02 前置：切到分支关系视图", inTree.view === "tree", inTree);
  await switchView(call, "运行记录");
  const restored = await H.storeQ(
    call,
    `const reading = s.readingByRun && s.readingByRun[${JSON.stringify(C)}];
     return JSON.stringify({
       view: s.view, sel: s.selectedRunId, span: s.selectedSpanId,
       tab: reading ? reading.tab : null,
     });`,
  );
  check(
    "R02 选中状态跨视图保持：切树再回记录，恢复 u7c_c 的 steps 页签与 s_09 调用",
    restored.view === "trace" &&
      restored.sel === C &&
      restored.span === SPAN_C_OWN &&
      restored.tab === "steps",
    restored,
  );
  const noNewTraces1 = [...H.traceIds()].filter((x) => !tracesBefore.has(x));
  check("N07 中查①：视图往返零 trace 写入", noNewTraces1.length === 0, noNewTraces1);
  await shot(call, "01-r02-restore");

  // ── P2 分支选择→比较（N01 比较面）─────────────────────────────────────
  await switchView(call, "分支关系");
  await toggleCompareInTree(call, C);
  await toggleCompareInTree(call, S);
  const enterCompare = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent || '').trim()) === '进入详细比较' && x.offsetParent !== null);
       if (b === undefined || b === null) return 'no-button';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(2200);
  const pairState = await H.storeQ(
    call,
    `return JSON.stringify({
       view: s.view, pair: s.comparePair,
       ids: s.compareIds === undefined ? 'absent' : s.compareIds,
     });`,
  );
  check(
    "P2 进入详细比较：加入顺序定方向（左 c 右 s），pair 独立于全局集合",
    enterCompare === "clicked" &&
      pairState.view === "compare" &&
      pairState.pair !== null &&
      pairState.pair.leftRunId === C &&
      pairState.pair.rightRunId === S,
    pairState,
  );
  const colC = await compareColumnOf(call, C);
  const colS = await compareColumnOf(call, S);
  check(
    "N01 比较两侧身份归位：u7c_c 的复制入口在左列、u7c_s 在右列（方向与 pair 一致）",
    colC === "left" && colS === "right",
    { colC, colS },
  );
  const barIdC = await globalBarHasId(call, C);
  const barIdS = await globalBarHasId(call, S);
  check("N01 比较页全局栏不冒充两侧身份", barIdC === false && barIdS === false, { barIdC, barIdS });

  // 交换左右（方向翻转再还原）
  const swapOnce = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('aria-label') || '') === '交换左右');
       if (b === undefined || b === null) return 'no-button';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(2000);
  const pairSwapped = await H.storeQ(call, "return JSON.stringify({ pair: s.comparePair });");
  const colAfterSwapC = await compareColumnOf(call, C);
  check(
    "P2 交换左右：pair 翻转且左列身份同步为 u7c_s",
    swapOnce === "clicked" &&
      pairSwapped.pair.leftRunId === S &&
      pairSwapped.pair.rightRunId === C &&
      colAfterSwapC === "right",
    { pair: pairSwapped.pair, colC: colAfterSwapC },
  );
  const swapBack = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('aria-label') || '') === '交换左右');
       if (b === undefined) return 'no-button';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(2000);
  const pairRestored = await H.storeQ(call, "return JSON.stringify({ pair: s.comparePair });");
  check(
    "P2 再交换还原：pair 回左 c 右 s",
    swapBack === "clicked" &&
      pairRestored.pair.leftRunId === C &&
      pairRestored.pair.rightRunId === S,
    pairRestored,
  );
  await shot(call, "02-compare-pair");

  // ── P3 R06-a 普通无文件运行：单侧文件入口诚实禁用 ────────────────────────
  // ⚠️ 页内直接返回对象（CDP returnByValue 自行序列化）——再套 JSON.stringify
  // 会被 H.ev 包装层二次解析，字符串往返在含特殊字符时不可靠（本轮实测踩坑）。
  const fileBtnState = await H.ev(
    call,
    `(() => {
       const btns = Array.from(document.querySelectorAll('button'))
         .filter(x => (x.getAttribute('aria-label') || '').startsWith('打开') &&
                      (x.getAttribute('aria-label') || '').endsWith('文件'));
       return btns.map(b => ({
         aria: b.getAttribute('aria-label'),
         disabled: b.disabled,
         title: (b.title || '').slice(0, 120),
       }));
     })()`,
  );
  check(
    "R06-a 普通无文件运行：比较页「打开文件」禁用且 title 给真实原因（不伪造文件页）",
    fileBtnState.length === 2,
    `length=${fileBtnState.length}`,
  );
  check(
    "R06-a 子判据：两列按钮均禁用且 title 非空",
    fileBtnState.every((b) => b.disabled === true) &&
      fileBtnState.every((b) => typeof b.title === "string" && b.title.length > 0),
    fileBtnState.map((b) => ({
      aria: b.aria,
      disabled: b.disabled,
      titleLen: (b.title || "").length,
    })),
  );
  await shot(call, "03-file-entry-disabled");

  // ── P4 R06-b 隔离单侧文件 + 返回比较/来源 ───────────────────────────────
  // 清空对照集合（选择条只在树视图渲染）→ 勾隔离父/子 → 进入详细比较。
  // ⚠️ 先选中隔离父（树 scope=current 聚焦选中链——decideTreeInitialFocus），
  // 否则隔离 run 不在可见链上，树上根本没有它的对照勾选框。
  await switchView(call, "运行记录");
  await H.selectRun(call, ISO_PARENT);
  await H.sleep(800);
  await switchView(call, "分支关系");
  const clearIds = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('aria-label') || '') === '清空对照集合' && x.offsetParent !== null);
       if (b === undefined) return 'no-button';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(600);
  await toggleCompareInTree(call, ISO_PARENT);
  await toggleCompareInTree(call, ISO_CHILD);
  const enterIso = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent || '').trim()) === '进入详细比较' && x.offsetParent !== null);
       if (b === undefined || b === null) return 'no-button';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(2200);
  const isoPair = await H.storeQ(
    call,
    "return JSON.stringify({ view: s.view, pair: s.comparePair });",
  );
  check(
    "P4 隔离父子进入比较：pair 左父右子",
    enterIso === "clicked" &&
      isoPair.view === "compare" &&
      isoPair.pair.leftRunId === ISO_PARENT &&
      isoPair.pair.rightRunId === ISO_CHILD,
    isoPair,
  );

  // 单侧文件（左列 = 隔离父，available ⇒ 可点）
  const openLeft = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('aria-label') || '') === '打开左列文件');
       if (b === undefined || b === null) return 'no-button';
       if (b.disabled) return 'disabled:' + (b.title || '');
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(2200);
  const filesView = await H.storeQ(
    call,
    `const reading = s.readingByRun && s.readingByRun[${JSON.stringify(ISO_PARENT)}];
     return JSON.stringify({
       view: s.view, sel: s.selectedRunId, tab: reading ? reading.tab : null,
       pairKept: s.comparePair === null ? null : s.comparePair.leftRunId + '->' + s.comparePair.rightRunId,
     });`,
  );
  check(
    "P4 打开左列文件：进入该运行的文件页且比较对象保留（pair 不清）",
    openLeft === "clicked" &&
      filesView.view === "trace" &&
      filesView.sel === ISO_PARENT &&
      filesView.tab === "files" &&
      filesView.pairKept === `${ISO_PARENT}->${ISO_CHILD}`,
    { click: openLeft, nav: filesView },
  );

  // R06：文件承载区不附带步骤目录（文件页 DOM 内无 SpanTree 的「步骤目录」区）
  const r06 = await H.ev(
    call,
    `(() => {
       const steps = document.querySelectorAll('[aria-label="步骤目录"]');
       const t = document.body.textContent || '';
       return {
         stepsInDom: steps.length,
         fileHints: {
           checkpoint: t.includes('检查点'),
           snapshot: t.includes('快照'),
           fileWord: t.includes('文件'),
         },
       };
     })()`,
  );
  check("R06 子判据①：文件页 DOM 内无「步骤目录」区", r06.stepsInDom === 0, {
    stepsInDom: r06.stepsInDom,
  });
  check(
    "R06 子判据②：文件承载内容在场（检查点/快照字样至少其一）",
    r06.fileHints.checkpoint === true || r06.fileHints.snapshot === true,
    r06.fileHints,
  );
  await shot(call, "04-isolated-files");

  // 返回比较（幂等不重读：pair 与两侧内容保留）
  const backToCompare = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('aria-label') || '') === '返回比较工作区');
       if (b === undefined || b === null) return 'no-button';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(1800);
  const backInCompare = await H.storeQ(
    call,
    `return JSON.stringify({
       view: s.view, pair: s.comparePair,
       readKind: s.compareRead && s.compareRead.conclusion ? s.compareRead.conclusion.kind : null,
     });`,
  );
  check(
    "P4 返回比较：视图回 compare、pair 保留、比较会话结论保留（幂等不重读）",
    backToCompare === "clicked" &&
      backInCompare.view === "compare" &&
      backInCompare.pair !== null &&
      backInCompare.pair.leftRunId === ISO_PARENT &&
      backInCompare.pair.rightRunId === ISO_CHILD &&
      backInCompare.readKind === "verified",
    backInCompare,
  );

  // 返回来源（比较页一次性凭据：回进入比较前的视图状态）
  const cmpReturnLabel = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('aria-label') || '') === '返回来源');
       return b === undefined ? null : { disabled: b.disabled, title: (b.title || '').slice(0, 80) }; })()`,
  );
  const clickCmpReturn = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('aria-label') || '') === '返回来源' && !x.disabled && x.offsetParent !== null);
       if (b === undefined || b === null) return 'no-button';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(1600);
  const backToSource = await H.storeQ(
    call,
    "return JSON.stringify({ view: s.view, sel: s.selectedRunId });",
  );
  check(
    "P4 返回来源：比较页返回入口可用且点击离开比较（回到进入前视图）",
    cmpReturnLabel !== null &&
      cmpReturnLabel.disabled === false &&
      clickCmpReturn === "clicked" &&
      backToSource.view !== "compare",
    { label: cmpReturnLabel, click: clickCmpReturn, nav: backToSource },
  );
  await shot(call, "05-back-to-source");

  // ── P5 N05 导航偏好（进比较不写偏好 + 恢复入口 + 实验页任务适配）─────────
  const navBeforeCompare = await navState(call);
  // 重新进入比较（对照集合还有隔离对）
  await switchView(call, "分支关系");
  const enterAgain = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent || '').trim()) === '进入详细比较' && x.offsetParent !== null);
       if (b === undefined || b === null) return 'no-button';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(2000);
  const navInCompare = await navState(call);
  // 恢复入口：全局栏「打开运行列表」在场可点
  const openNav = await H.ev(
    call,
    `(() => { const b = document.getElementById('run-navigation-toggle');
       if (b === null) return 'no-button';
       if (b.offsetParent === null) return 'hidden';
       if (b.getAttribute('aria-label') !== '打开运行列表') return 'already-open';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(1000);
  const navOpened = await navState(call);
  check(
    "N05 比较页恢复入口：「打开运行列表」在场可点且点击后导航真开",
    enterAgain === "clicked" && openNav === "clicked" && navOpened.toggleExpanded === "true",
    { before: navBeforeCompare, inCompare: navInCompare, open: openNav, after: navOpened },
  );
  // 退出比较（视图切换）⇒ 导航保持打开（用户动作状态，不被自动收回去）
  await switchView(call, "运行记录");
  const navAfterExit = await navState(call);
  check(
    "N05 退出比较：导航保持用户动作后的打开状态（临时打开不被吞回）",
    navAfterExit.toggleExpanded === "true",
    { toggle: navAfterExit.toggleExpanded },
  );
  await shot(call, "06-nav-restore");

  // 实验页任务级适配（3.1）：进实验页导航临时收起（RunList 离开 DOM），退出恢复
  await H.selectRun(call, "u7c_ep");
  await H.sleep(1200);
  const openExp = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent || '').trim()) === '模型实验' && x.offsetParent !== null);
       if (b === undefined || b === null) return 'no-button';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(1800);
  const navInExp = await navState(call);
  await switchView(call, "运行记录");
  const navAfterExp = await navState(call);
  check(
    "N05 实验页任务级适配：进实验页导航临时收起（3.1 纯显示层），退出恢复",
    openExp === "clicked" && navInExp.navInDom === false && navAfterExp.navInDom === true,
    { navInExp, navAfterExp },
  );

  // ── P6 N07 收口：全程零写入 ────────────────────────────────────────────
  const noNewTraces = [...H.traceIds()].filter((x) => !tracesBefore.has(x));
  const opsAfter = await H.storeQ(
    call,
    "return JSON.stringify({ n: s.operations.operations.length });",
  );
  check(
    "N07 布局往返不重新执行：全程 trace 零新增、登记数零新增",
    noNewTraces.length === 0 && opsAfter.n === opsBefore.n,
    { newTraces: noNewTraces, ops: [opsBefore.n, opsAfter.n] },
  );

  // ── 收尾：清对照、回 trace、按清单清除 fixtures（finally 统一执行）──────
  dump.cleanup = { traces: copiedTraces, blobs: copiedBlobs };
  return finish();
}

(async () => {
  let failed = 1;
  try {
    failed = await main();
  } catch (e) {
    console.error(String(e?.stack ?? e));
    try {
      require("node:fs").writeFileSync(
        join(ROOT, `${TAG}-error.txt`),
        String(e?.stack ?? e),
        "utf8",
      );
      writeOut();
    } catch {
      /* noop */
    }
  } finally {
    await cleanupFixtures();
  }
  process.exit(failed === 0 ? 0 : 1);
})();
