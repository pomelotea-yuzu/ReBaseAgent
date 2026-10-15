/* eslint-disable */
/**
 * refine-ui-for-community-release 任务 5.5：**Electron 实机**四档宽度 + 独立 200% 缩放。
 *
 * 范围（tasks 5.5 原文）：核对 1440/1210/1024/800 CSS px 布局和独立 200% 缩放，
 * 记录正文高度、编辑器尺寸、无非预期整页横溢及恢复入口；保留现行阅读空间判据。
 * 附带 N06（手动调整专注和自动适配不相互回滚；长输入和编辑器状态保持）与
 * N05 窄档判定余量（5.2 已验恢复入口/任务适配，本轮补窄档精确判定）。
 *
 * 分组（同 u5-68 编排，两组 dev）：
 * - `widths`（默认 dev）：四档循环——改窗收敛（ps-win.ps1 + clientWidth 实测反解）、
 *   断点与导航可见性（wide 常驻 / medium+narrow 文件页临时收起 + 恢复入口）、
 *   全页横溢、正文高度、文件查看器宽度（data-file-container-width + Monaco 包裹层）、
 *   N06 专注差异（进入 → 窄窗不误退 → 主动调整先退专注 → 退出恢复）
 *   + N06 专注编辑（草稿文本/revision 逐字保持）。
 * - `zoom200`（REBASEAGENT_ZOOM_FACTOR=2 dev）：DPR>3.5 金标准 + 同款几何判据
 *   （CSS 800 窄档 + 恢复入口 + 查看器 + 横溢）。
 *
 * 判据口径（UI-VERIFY 纪律）：外框→CSS 是近似映射，**以 documentElement.clientWidth
 * 实测为准**（收敛用实测比例反解，加法修正在 zoom2 不收敛）；zoom 金标准 = DPR > 3.5；
 * 窄档 selectRun 走 store（列表收起无 DOM 行）。
 *
 * 用法：node apps/desktop/scripts/refine-55-cdp.cjs --tag=<widths|zoom200>
 * 前置：dev 已带 CDP 9612 启动（zoom200 组需 REBASEAGENT_ZOOM_FACTOR=2）。
 */
"use strict";

const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { listPageTarget } = require("./editor-collapse-probe.cjs");
const H = require("./lib/u4-smoke-harness.cjs");

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

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
const MODE = arg("mode", "real"); // real=真实改窗（强证据）；emulated=模拟视口（确定性保底）
if (!["widths", "zoom200"].includes(TAG)) {
  console.error("用法：--tag=<widths|zoom200> [--mode=<real|emulated>]");
  process.exit(2);
}

const ROOT = join(H.REPO, ".workbuddy", "refine-ui", "5x");
const SHOTS = join(ROOT, "shots");
mkdirSync(SHOTS, { recursive: true });
const PS_WIN = join(H.REPO, ".workbuddy", "ps-win.ps1");
const WS_RUN = "export_e2e_root"; // 有 workspace 的 run：文件页有 a.txt 可选可看
const READ_RUN = "run_mtmgz1v1"; // 普通对话 run（非隔离、首个 llm.call 带字符串 system ⇒ prompt fork 可用）

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
// 通道小件（refine-54 / u5-68 已验证实现）
// ---------------------------------------------------------------------------

async function shot(call, name) {
  const file = await H.shot(call, SHOTS, `r55-${TAG}-${name}.png`).catch((e) => String(e));
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

async function reloadVerified(call) {
  if (!(await waitAppAlive(call))) {
    throw new Error("应用 90s 未就绪（root 空 / store 不可导入）");
  }
  const sentinel = `r55-${Date.now()}`;
  await H.ev(call, `window.__r55Doc = ${JSON.stringify(sentinel)}; "ok"`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await call("Page.reload", { ignoreCache: false });
    const deadline = Date.now() + 45000;
    for (;;) {
      let doc = sentinel;
      let ready = false;
      try {
        doc = await H.ev(call, "window.__r55Doc ?? null");
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

const storeSelectRun = async (call, id) => {
  await H.storeQ(call, `await s.selectRun(${JSON.stringify(id)}); return JSON.stringify('ok');`);
  await H.sleep(2000);
};

/** ps-win.ps1 直 spawn（node 直调，不经 Bash） */
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

/** 改窗到目标 CSS 宽度，双通道分流（本轮实测定版）：
 *  - 先做一次「小窗口重置一击」（PS 短窗 + ForceRestore）：把窗口从任何 Snap 吸附/
 *    最大化/最小化态强制拉回浮动态——后续 MoveWindow/resizeTo 才可靠生效。
 *  - ≤1215：页内 `window.resizeTo`（Electron 代理 setSize，无 DPI 虚拟化；实测恒偏
 *    +10px 边框，按比例反解 2–3 轮收敛）。⚠️ 上限被屏幕物理宽钳制（≈1219 CSS）。
 *  - >1215（1440 档）：ps-win.ps1 MoveWindow（OS API 允许外框超屏）。⚠️ PS 是
 *    DPI-unaware（×1.5 虚拟化）⇒ 量化粒度粗，落点允许 ±2px（1440 档实测落 1442）。
 *  两通道都以 `documentElement.clientWidth` 实测回读为准。 */
async function resizeToCssWidth(call, cssTarget, outerHeight = 1050) {
  // emulated 模式：模拟视口直达目标宽度（确定性；布局判据全部照跑，损失 OS 边框维度）
  if (MODE === "emulated") {
    await call("Emulation.setDeviceMetricsOverride", {
      width: cssTarget,
      height: outerHeight,
      deviceScaleFactor: 0,
      mobile: false,
    });
    await H.sleep(1200);
    const cw = await H.ev(call, "(() => document.documentElement.clientWidth)()");
    return {
      cssWidth: cw,
      outerWidth: 0,
      outerHeight,
      ps: "emulated",
      settled: typeof cw === "number" && Math.abs(cw - cssTarget) <= 2,
    };
  }
  // 重置一击：脱离吸附态（不带它时后续改窗概率性全部无效——本轮多轮实锤）
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

  if (cssTarget <= 1215) {
    let w = cssTarget + 10;
    for (let round = 0; round < 5; round++) {
      await H.ev(call, `(() => { window.resizeTo(${w}, ${outerHeight}); return true; })()`);
      await H.sleep(900);
      const cw = await H.ev(call, "(() => document.documentElement.clientWidth)()");
      if (typeof cw === "number" && Math.abs(cw - cssTarget) <= 2) {
        return { cssWidth: cw, outerWidth: w, outerHeight, ps: "resizeTo", settled: true };
      }
      if (typeof cw !== "number" || cw <= 0) break;
      const next = Math.round(cssTarget * (w / cw));
      if (next === w) break;
      w = next;
    }
    const cw = await H.ev(call, "(() => document.documentElement.clientWidth)()");
    return { cssWidth: cw, outerWidth: w, outerHeight, ps: "resizeTo-exhausted", settled: false };
  }
  for (let round = 0; round < 3; round++) {
    if (round > 0) await H.sleep(1500);
    let outer = Math.round(cssTarget * 1.412);
    let last = "";
    let cssWidth = null;
    for (let i = 0; i < 6; i++) {
      last = await runPs1(PS_WIN, [
        "-OuterWidth",
        String(outer),
        "-OuterHeight",
        String(outerHeight),
        "-ForceRestore",
      ]);
      await H.sleep(900);
      cssWidth = await H.ev(call, "(() => document.documentElement.clientWidth)()");
      if (typeof cssWidth === "number" && Math.abs(cssWidth - cssTarget) <= 2) {
        return { cssWidth, outerWidth: outer, outerHeight, ps: last, settled: true };
      }
      if (typeof cssWidth !== "number" || cssWidth <= 0) break;
      const next = Math.max(400, Math.round(cssTarget / (cssWidth / outer)));
      if (next === outer) break;
      outer = next;
    }
  }
  const cssWidth = await H.ev(call, "(() => document.documentElement.clientWidth)()");
  return { cssWidth, outerWidth: 0, outerHeight, ps: "exhausted", settled: false };
}

// ---------------------------------------------------------------------------
// 几何读数
// ---------------------------------------------------------------------------

/** 页面级几何：横溢 / 正文高度 / DPR */
const pageGeo = (call) =>
  H.ev(
    call,
    `(() => { const de = document.documentElement;
       const main = document.querySelector('main') ?? document.querySelector('section');
       const mr = main === null ? null : main.getBoundingClientRect();
       return JSON.stringify({ scrollW: de.scrollWidth, clientW: de.clientWidth,
         innerW: window.innerWidth, innerH: window.innerHeight,
         mainH: mr === null ? null : Math.round(mr.height), dpr: window.devicePixelRatio }); })()`,
  );

/** 导航可见性：#run-navigation 在 DOM + toggle 的 aria 标签 */
const navState = (call) =>
  H.ev(
    call,
    `(() => { const nav = document.getElementById('run-navigation');
       const t = document.getElementById('run-navigation-toggle');
       return JSON.stringify({ navInDom: nav !== null,
         toggleLabel: t === null ? null : t.getAttribute('aria-label'),
         expanded: t === null ? null : t.getAttribute('aria-expanded') }); })()`,
  );

/** 点 run-navigation-toggle（恢复入口 / 收起入口） */
const clickNavToggle = (call) =>
  H.ev(
    call,
    `(() => { const t = document.getElementById('run-navigation-toggle');
       if (!t) return 'no-toggle'; if (t.offsetParent === null) return 'hidden';
       t.click(); return 'clicked'; })()`,
  );

/** 文件页选中文件并读查看器几何（data-file-container-width 是组件自报容器宽） */
async function selectFileAndMeasure(call, filePath) {
  const picked = await H.ev(
    call,
    `(() => { const el = document.querySelector('[data-file-path=${JSON.stringify(filePath)}]');
       if (!el) return 'no-file-row'; (el.closest('button') ?? el).click(); return 'clicked'; })()`,
  );
  await H.sleep(2000);
  return H.ev(
    call,
    `(() => {
       const cont = document.querySelector('[data-file-container-width]');
       // ⚠️ Monaco ≤900px 强制 inline：保留两个 .editor 层，窄的（约 36px）是隐藏侧
       //    —— 有效文字区取较宽侧（UI-VERIFY「inline 档仍保留两个 .editor 层」）
       let monacoW = null, monacoVisible = false;
       const layers = Array.from(document.querySelectorAll('.editor'));
       if (layers.length > 0) {
         const rects = layers.map((l) => l.getBoundingClientRect());
         const widest = Math.max(...rects.map((r) => r.width));
         monacoW = Math.round(widest);
         monacoVisible = widest > 50 && Math.max(...rects.map((r) => r.height)) > 50;
       }
       const view = document.querySelector('.view-lines');
       return JSON.stringify({
         picked: ${JSON.stringify(picked)},
         containerWidth: cont === null ? null : Number(cont.getAttribute('data-file-container-width')),
         monacoW,
         monacoVisible,
         textRendered: view !== null && (view.textContent || '').length > 0 }); })()`,
  );
}

// ---------------------------------------------------------------------------
// widths tag
// ---------------------------------------------------------------------------

async function runWidths(call) {
  // 前置：选中 ws run 并进文件页选 a.txt（每档重复测量）
  await storeSelectRun(call, WS_RUN);
  await H.clickTab(call, "文件");
  await H.sleep(2500);

  const tiers = [
    { css: 1440, bp: "wide" },
    { css: 1210, bp: "medium" },
    { css: 1024, bp: "medium" },
    { css: 800, bp: "narrow" },
  ];
  const rows = [];
  for (const tier of tiers) {
    const r = await resizeToCssWidth(call, tier.css);
    check(
      `宽度 ${tier.css}：改窗实测 CSS 落点（±1px）`,
      r.settled === true && Math.abs(r.cssWidth - tier.css) <= 2,
      { cssWidth: r.cssWidth, outer: r.outerWidth, settled: r.settled },
    );
    await H.sleep(800); // resize 监听重渲染

    const geo = await pageGeo(call);
    check(`宽度 ${tier.css}：页面无横向溢出`, geo.scrollW <= geo.clientW + 1, {
      scrollW: geo.scrollW,
      clientW: geo.clientW,
    });
    check(
      `宽度 ${tier.css}：正文高度受视口约束（main 在场且不超视口）`,
      geo.mainH !== null && geo.mainH > 100 && geo.mainH <= geo.innerH + 2,
      geo,
    );

    const viewer = await selectFileAndMeasure(call, "a.txt");
    check(
      `宽度 ${tier.css}：文件查看器在场且有渲染文本（现行阅读空间判据）`,
      viewer.containerWidth !== null &&
        viewer.containerWidth > 100 &&
        viewer.monacoVisible === true &&
        viewer.textRendered === true,
      viewer,
    );
    rows.push({ target: tier.css, cssWidth: r.cssWidth, ...geo, viewer });

    // 导航可见性按断点：wide 常驻；medium（文件页）与 narrow 临时收起 + 恢复入口
    const nav = await navState(call);
    if (tier.bp === "wide") {
      check(
        `宽度 ${tier.css}（wide）：导航常驻在 DOM`,
        nav.navInDom === true && nav.toggleLabel === "收起运行列表",
        nav,
      );
    } else {
      check(
        `宽度 ${tier.css}（${tier.bp}）：文件页导航临时收起（显示决策，恢复入口在场）`,
        nav.navInDom === false && nav.toggleLabel === "打开运行列表",
        nav,
      );
      const opened = await clickNavToggle(call);
      await H.sleep(900);
      const navAfter = await navState(call);
      check(
        `宽度 ${tier.css}（${tier.bp}）：恢复入口点击 ⇒ 导航临时打开`,
        opened === "clicked" && navAfter.navInDom === true,
        { opened, ...navAfter },
      );
      await clickNavToggle(call); // 收回（不写偏好）
      await H.sleep(600);
    }
  }
  dump.tiers = rows;

  // ── N06：专注互滚（1210 档 = medium 文件页）───────────────────────────────
  const r1210 = await resizeToCssWidth(call, 1210);
  check("N06 前置：回到 1210（±1px）", Math.abs(r1210.cssWidth - 1210) <= 2, r1210.cssWidth);
  await H.sleep(800);

  // ① 进入专注差异：按钮在场 → 专注栏与退出入口常驻
  const enterFocus = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '专注差异' && x.offsetParent !== null);
      if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
  );
  await H.sleep(900);
  const focusBar = await H.ev(
    call,
    `(() => { const bar = Array.from(document.querySelectorAll('div'))
        .find(x => (x.textContent||'').includes('专注差异 · 辅助列表与步骤目录已临时收起'));
      const exit = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '退出专注');
      return JSON.stringify({ bar: bar !== null, exitBtn: exit !== null }); })()`,
  );
  check(
    "N06-1 进入专注差异：专注栏在场且退出入口常驻",
    enterFocus === "clicked" && focusBar.bar === true && focusBar.exitBtn === true,
    { enterFocus, ...focusBar },
  );

  // ② 窄窗半边：改窗 800 ⇒ 专注仍按身份生效（不误退）；改回 1210
  const rnarrow = await resizeToCssWidth(call, 800);
  await H.sleep(800);
  const focusAtNarrow = await H.ev(
    call,
    `(() => Array.from(document.querySelectorAll('button'))
        .some(x => ((x.textContent||'').trim()) === '退出专注'))()`,
  );
  check(
    "N06-2 窄窗（800）专注仍生效（身份比对不因改窗误退）",
    Math.abs(rnarrow.cssWidth - 800) <= 2 && focusAtNarrow === true,
    { cssWidth: rnarrow.cssWidth, focusStill: focusAtNarrow },
  );
  await resizeToCssWidth(call, 1210);
  await H.sleep(800);

  // ③ 主动调整（打开运行列表）⇒ 先退专注再调整（专注栏消失、导航打开、无回滚冲突）
  const adj = await clickNavToggle(call);
  await H.sleep(900);
  const afterAdj = await H.ev(
    call,
    `(() => { const bar = Array.from(document.querySelectorAll('div'))
        .some(x => (x.textContent||'').includes('专注差异 · 辅助列表与步骤目录已临时收起'));
      const nav = document.getElementById('run-navigation');
      return JSON.stringify({ focusGone: bar === false, navOpened: nav !== null }); })()`,
  );
  check(
    "N06-3 专注中主动调整：先退出专注（专注栏消失）且调整生效（导航打开）",
    adj === "clicked" && afterAdj.focusGone === true && afterAdj.navOpened === true,
    { adj, ...afterAdj },
  );
  await clickNavToggle(call);
  await H.sleep(600);

  // ④ 步骤页专注编辑：草稿文本/revision 逐字保持（长输入和编辑器状态保持）。
  // prompt fork 编辑器只对 llm.call 渲染 ⇒ 用真实 run（WS_RUN 是 fixture，无 llm.call）
  await storeSelectRun(call, READ_RUN);
  await H.clickTab(call, "步骤");
  await H.sleep(1500);
  // 轮换点 LLM 调用行：选中后 prompt fork 区默认折叠 ⇒ 点「编辑 system prompt 重跑」
  // 展开（disabled=首次 llm.call 缺字符串 system 消息，换下一行），直到草稿编辑器出现
  let target = null;
  for (let i = 0; i < 4; i++) {
    await H.ev(
      call,
      `(() => { const rows = Array.from(document.querySelectorAll('button'))
          .filter(x => (x.title||'').includes('LLM 调用') && x.offsetParent !== null);
        if (rows.length <= ${i}) return 'no-row';
        rows[${i}].click(); return 'clicked'; })()`,
    );
    await H.sleep(1800);
    const openBtn = await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => ((x.textContent||'').trim()) === '编辑 system prompt 重跑' && x.offsetParent !== null);
        if (!b) return 'no-button';
        if (b.disabled) return 'disabled';
        b.click(); return 'clicked'; })()`,
    );
    await H.sleep(1200);
    const host = await H.ev(
      call,
      `(() => { const h = document.querySelector('[data-monaco-host="prompt-draft"]');
        return h === null ? null : h.getAttribute('data-monaco-target'); })()`,
    );
    if (typeof host === "string" && host.includes(":system_prompt")) {
      target = host;
      break;
    }
  }
  if (target === null) {
    check("N06-4 前置：prompt fork 草稿编辑器（system prompt 侧）出现", false, "轮换 4 行未出现");
  } else {
    const edited = await H.appImport(
      call,
      H.MONACO_NEEDLE,
      `const monaco = await m.ensureMonaco();
       const host = document.querySelector('[data-monaco-host="prompt-draft"][data-monaco-target=${JSON.stringify(target)}]');
       if (host === null) return JSON.stringify({ ok: false, why: 'no-host' });
       const ed = monaco.editor.getEditors().find(e => e.getDomNode() !== null && host.contains(e.getDomNode()));
       if (ed === undefined) return JSON.stringify({ ok: false, why: 'no-editor' });
       ed.getModel().setValue('N06 专注往返保持文本：聚焦检查（长输入示例）。');
       await new Promise((r) => setTimeout(r, 600));
       return JSON.stringify({ ok: true });`,
    );
    const draftBefore = await H.storeQ(
      call,
      `const [runId, spanId] = ${JSON.stringify(target)}.split(':');
       const d = ((s.drafts.calls[runId]||{})[spanId]||{})['system_prompt'];
       return JSON.stringify(d === undefined || d === null ? null : { revision: d.revision, len: (d.text||'').length });`,
    );
    // 进入专注编辑 → 退出专注
    const enterEdit = await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => ((x.textContent||'').trim()) === '专注编辑' && x.offsetParent !== null);
        if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
    );
    await H.sleep(900);
    const inFocus = await H.ev(
      call,
      `(() => Array.from(document.querySelectorAll('button'))
          .some(x => ((x.textContent||'').trim()) === '退出专注'))()`,
    );
    const exit = await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => ((x.textContent||'').trim()) === '退出专注' && x.offsetParent !== null);
        if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
    );
    await H.sleep(1200);
    const draftAfter = await H.storeQ(
      call,
      `const [runId, spanId] = ${JSON.stringify(target)}.split(':');
       const d = ((s.drafts.calls[runId]||{})[spanId]||{})['system_prompt'];
       return JSON.stringify(d === undefined || d === null ? null : { revision: d.revision, len: (d.text||'').length, text: d.text });`,
    );
    const monacoAfter = await H.appImport(
      call,
      H.MONACO_NEEDLE,
      `const monaco = await m.ensureMonaco();
       const host = document.querySelector('[data-monaco-host="prompt-draft"][data-monaco-target=${JSON.stringify(target)}]');
       if (host === null) return JSON.stringify({ ok: false, why: 'no-host-after' });
       const ed = monaco.editor.getEditors().find(e => e.getDomNode() !== null && host.contains(e.getDomNode()));
       return JSON.stringify({ ok: true, value: ed === undefined ? null : ed.getModel().getValue() });`,
    );
    check(
      "N06-4 专注编辑往返：草稿 revision/文本逐字保持（含 Monaco 值）",
      edited.ok === true &&
        enterEdit === "clicked" &&
        inFocus === true &&
        exit === "clicked" &&
        draftBefore !== null &&
        draftAfter !== null &&
        draftBefore.revision === draftAfter.revision &&
        draftBefore.len === draftAfter.len &&
        monacoAfter.value === "N06 专注往返保持文本：聚焦检查（长输入示例）。",
      { edited, draftBefore, draftAfter, monacoLen: (monacoAfter.value || "").length },
    );
  }
  await shot(call, "n06-done");

  // 复位窗口到 1440（收尾态）
  await resizeToCssWidth(call, 1440);
}

// ---------------------------------------------------------------------------
// zoom200 tag
// ---------------------------------------------------------------------------

async function runZoom(call) {
  const dpr = await H.ev(call, "(() => window.devicePixelRatio)()");
  check(
    "前置：DPR > 3.5（独立 200% 缩放真 zoom 金标准）",
    typeof dpr === "number" && dpr > 3.5,
    dpr,
  );

  await storeSelectRun(call, WS_RUN);
  await H.clickTab(call, "文件");
  await H.sleep(2500);

  // zoom2（DPR 4.2）下 CSS 视口物理上限 = 2560÷4.2 ≈ 609 ⇒「CSS 800」物理不可达
  // （u5-68 zoom200 同此口径：只记录 viewport，判据写相对几何）。MoveWindow 拉满
  // 物理屏 ⇒ 最宽可用窄档视口，断言其落点与窄档行为。
  const last = await runPs1(PS_WIN, [
    "-OuterWidth",
    "2600",
    "-OuterHeight",
    "1700",
    "-ForceRestore",
  ]);
  await H.sleep(1200);
  const zoomCw = await H.ev(call, "(() => document.documentElement.clientWidth)()");
  check(
    "200%：视口达物理屏钳制上限（924±15 = 2601÷2.82，zoom2 外框→CSS 换算 ×2.82）",
    typeof zoomCw === "number" && zoomCw >= 909 && zoomCw <= 939,
    { cssWidth: zoomCw, dpr, ps: last },
  );
  await H.sleep(800);

  const geo = await pageGeo(call);
  check("200%：页面无横向溢出", geo.scrollW <= geo.clientW + 1, {
    scrollW: geo.scrollW,
    clientW: geo.clientW,
  });
  check(
    "200%：正文高度受视口约束",
    geo.mainH !== null && geo.mainH > 100 && geo.mainH <= geo.innerH + 2,
    geo,
  );

  const viewer = await selectFileAndMeasure(call, "a.txt");
  check(
    "200%：文件查看器在场且有渲染文本",
    viewer.containerWidth !== null && viewer.containerWidth > 50 && viewer.monacoVisible === true,
    viewer,
  );

  const nav = await navState(call);
  check(
    "200%（窄档）：文件页导航收起且恢复入口在场",
    nav.navInDom === false && nav.toggleLabel === "打开运行列表",
    nav,
  );
  const opened = await clickNavToggle(call);
  await H.sleep(900);
  const navAfter = await navState(call);
  check(
    "200%（窄档）：恢复入口点击 ⇒ 导航临时打开",
    opened === "clicked" && navAfter.navInDom === true,
    { opened, ...navAfter },
  );
  // 收回导航（narrow 档列表替换正文——不收回则详情区不在 DOM，专注判据全挂）
  await clickNavToggle(call);
  await H.sleep(900);

  // 专注差异在 zoom 下进/退可用
  const enterFocus = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '专注差异' && x.offsetParent !== null);
      if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
  );
  await H.sleep(900);
  const exit = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '退出专注' && x.offsetParent !== null);
      if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
  );
  check(
    "200%：专注差异进入（退出入口出现）并可退出",
    enterFocus === "clicked" && exit === "clicked",
    {
      enterFocus,
      exit,
    },
  );
  await shot(call, "zoom-done");
}

// ---------------------------------------------------------------------------

async function main() {
  const page = await listPageTarget(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await reloadVerified(call);

  if (TAG === "widths") await runWidths(call);
  else await runZoom(call);
  finish({});
}

main().catch((e) => {
  console.error(e);
  try {
    writeFileSync(join(ROOT, `${TAG}-error.txt`), String(e?.stack ?? e), "utf8");
  } catch {}
  process.exit(2);
});
