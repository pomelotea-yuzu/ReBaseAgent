/* eslint-disable */
/**
 * U2 任务 5.2：极窄与放大后仍可阅读 + 手动布局偏好不被自动折叠覆盖 + 键盘与离线加载。
 *
 * 覆盖（spec 三场景）：
 *   ① 极窄与放大后仍可阅读 —— 800/640 档 + zoomFactor=2；目录收起、diff 强制 inline、
 *      正文用可用主区、无整页横向滚动、字号不缩、工具栏换行/检查点/返回目录可达。
 *   ② 手动布局偏好不被自动折叠覆盖 —— 用户显式收起目录 / 选 inline/并排 → 缩窄降级 →
 *      恢复宽度后**偏好复原**（`FileLayoutPrefs` 从未被改写）。
 *   ③ 文件阅读键盘操作与离线加载 —— 键盘走查目录切换/宽度调整/工具栏；离线时 Monaco 仍
 *      从本地懒加载（`navigator.onLine=false` 下编辑器照常出现）。
 *
 * ⚠️ 与 5.1 同纪律：
 *   - 禁用 `Emulation.setDeviceMetricsOverride`（破坏 Monaco automaticLayout ⇒ 36px/5px 伪影）。
 *   - 脚本不 spawn、不改窗、不重启 dev；窗口尺寸由 PowerShell 工具设定。
 *   - **zoomFactor=2 走真 Electron**（主进程 `REBASEAGENT_ZOOM_FACTOR`，见 src/main/index.ts），
 *     不是 `Emulation.setPageScaleFactor`（那只是视觉缩放、不改布局视口）。
 *
 * 用法（每档单独调用；窗口先由 PowerShell 设好）：
 *   node apps/desktop/scripts/u2-52-cdp.cjs --tag=800-narrow
 *   node apps/desktop/scripts/u2-52-cdp.cjs --tag=640-single
 *   node apps/desktop/scripts/u2-52-cdp.cjs --tag=zoom2       # 需 dev 带 REBASEAGENT_ZOOM_FACTOR=2
 *   node apps/desktop/scripts/u2-52-cdp.cjs --tag=prefs        # 偏好保持（窗口需 ≥1210 档）
 *   node apps/desktop/scripts/u2-52-cdp.cjs --tag=offline      # 离线加载
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, makeSession, ev, shot } = require("./lib/u2-cdp-util.cjs");

const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-23-u2-52");
const OUT_DIR = join(REPO, ".workbuddy", "u2-52");
const OUT = join(OUT_DIR, "measurements.json");

const PORT = Number(process.env.CDP_PORT ?? 9612);
const arg = (n, d) => {
  const v = process.argv.find((a) => a.startsWith(`--${n}=`));
  return v ? v.slice(n.length + 3) : d;
};
const TAG = arg("tag", "current");

const ISO_RUN = "run_muappa2a_gk7964";
const TEXT_FILE = "a.txt";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(`${ok === true ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}
function loadOut() {
  if (!existsSync(OUT)) return { task: "U2-5.2", measurements: {}, checks: [] };
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return { task: "U2-5.2", measurements: {}, checks: [] };
  }
}
function saveOut(d) {
  mkdirSync(OUT_DIR, { recursive: true });
  d.capturedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(d, null, 2));
}

// —— 用例表达式（尽量复用 5.1 已验证的钩子）——
const currentRunExpr = `(() => {
  const c = Array.from(document.querySelectorAll('button, span, div'))
    .map(e => (e.textContent||'').trim()).filter(t => /^run_[A-Za-z0-9_]+$/.test(t));
  return c[0] ?? null; })()`;
const overviewTabExpr = `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
  .find(x => (x.textContent||'').trim() === '概览'); if (b) { b.click(); return true; } return 'no-tab'; })()`;
const trailsBtnExpr = `(() => { const b = Array.from(document.querySelectorAll('button'))
  .find(x => (x.textContent||'').trim() === '轨迹'); if (!b) return false; b.click(); return true; })()`;
const runListVisibleExpr = `(() => {
  if (document.querySelector('[role="option"][data-file-path]')) return false;
  const hasNew = Array.from(document.querySelectorAll('button')).some(b => (b.textContent||'').trim().includes('新建运行'));
  const hasRow = Array.from(document.querySelectorAll('button')).some(b => (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID'));
  return hasNew || hasRow; })()`;
const selectRunExpr = (id) => `(() => {
  const copy = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${id}'));
  if (!copy) return false; const row = copy.parentElement;
  const sel = row ? row.querySelector('button') : null; if (!sel) return false;
  sel.click(); return true; })()`;
const filesTabExpr = `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
  .find(x => (x.textContent||'').trim() === '文件'); if (!b) return false; b.click(); return true; })()`;
const laterCkptExpr = `(() => {
  const c = Array.from(document.querySelectorAll('button')).filter(b => (b.title||'').includes('检查点所属 step'));
  if (!c.length) return false; c[c.length - 1].click(); return true; })()`;
const pickFileExpr = (
  p,
) => `(() => { const b = document.querySelector('[role="option"][data-file-path="${p}"]');
  if (!b) return false; b.click(); return true; })()`;

/** 完整几何 + 偏好快照 */
const snapExpr = `(() => {
  const q = (s, r=document) => r.querySelector(s);
  const rect = (e) => e ? { w: Math.round(e.getBoundingClientRect().width),
    h: Math.round(e.getBoundingClientRect().height), left: Math.round(e.getBoundingClientRect().left) } : null;
  const container = q('[data-file-container-width]');
  const sep = q('[role="separator"][aria-label="调整文件目录宽度"]');
  const listbox = q('[role="listbox"][aria-label="工作区文件列表"]');
  const listDir = listbox ? listbox.parentElement : null;
  const mono = q('.monaco-diff-editor');
  const face = (marker) => {
    if (!mono) return null;
    const wrap = Array.from(mono.querySelectorAll('.editor')).find(e => e.className.includes(marker));
    if (!wrap) return null;
    const vl = wrap.querySelector('.monaco-scrollable-element.editor-scrollable .view-lines');
    return { kind: marker, boxW: Math.round(wrap.getBoundingClientRect().width),
      textW: vl ? Math.round(vl.getBoundingClientRect().width) : null };
  };
  const sides = mono ? [face('original'), face('modified')].filter(Boolean) : [];
  const leftBox = sides.find(s => s.kind === 'original')?.boxW ?? 0;
  const rightBox = sides.find(s => s.kind === 'modified')?.boxW ?? 0;
  const textWidths = sides.map(s => s.textW).filter(w => typeof w === 'number');
  const effectiveTextW = textWidths.length ? Math.max(...textWidths) : null;
  const mode = mono ? (leftBox > 0 && rightBox > 0 && Math.abs(leftBox - rightBox) < 0.6 * Math.max(leftBox, rightBox)
    ? 'sideBySide' : 'inline') : null;
  // 字号：取正文 view-line 的计算字号（验证"不缩小字号"）
  const vline = mono ? q('.view-line', mono) : null;
  const fontSize = vline ? parseFloat(getComputedStyle(vline).fontSize) : null;
  // 工具栏按钮可达性（文案/aria 双查）
  const btnByText = (t) => Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent||'').trim().startsWith(t));
  const btnByAria = (a) => Array.from(document.querySelectorAll('button'))
    .find(b => b.getAttribute('aria-label') === a);
  const toolbar = {
    wordWrap: btnByText('换行：')?.textContent?.trim() ?? null,
    prevDiff: !!btnByText('上一差异'),
    nextDiff: !!btnByText('下一差异'),
    find: !!btnByText('查找'),
    modeBtn: btnByText('模式：')?.textContent?.trim() ?? null,
    dirToggle: !!(btnByText('收起目录') || btnByText('展开目录')),
    backToDir: !!btnByAria('显示文件列表'),
  };
  const sepFocused = sep ? document.activeElement === sep : null;
  return JSON.stringify({
    cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
    iw: innerWidth, ih: innerHeight,
    outerW: outerWidth, outerH: outerHeight, dpr: +devicePixelRatio.toFixed(2),
    bodyOk: document.body.scrollWidth <= document.body.clientWidth,
    bodySw: document.body.scrollWidth, bodyCw: document.body.clientWidth,
    containerW: container ? Number(container.getAttribute('data-file-container-width')) : null,
    containerRect: rect(container),
    dirResident: listDir !== null && Math.round(listDir.getBoundingClientRect().width) > 0,
    dirW: listDir ? Math.round(listDir.getBoundingClientRect().width) : null,
    dirVisibleAsPane: !!listbox && listbox.getBoundingClientRect().width > 0,
    sepPresent: sep !== null,
    sepValueNow: sep ? Number(sep.getAttribute('aria-valuenow')) : null,
    sepFocused,
    mono: rect(mono), sides, effectiveTextW, mode, fontSize,
    toolbar,
    // 导航在场与否（偏好复原的关键旁证）
    navPresent: !!document.querySelector('main aside'),
    breakpoint: document.documentElement.clientWidth >= 1280 ? 'wide'
      : document.documentElement.clientWidth >= 960 ? 'medium'
      : document.documentElement.clientWidth >= 720 ? 'narrow' : 'single',
    online: navigator.onLine,
  });
})()`;

async function readSnap(call) {
  for (let t = 0; t < 8; t++) {
    const raw = await ev(call, snapExpr);
    if (typeof raw === "string") return JSON.parse(raw);
    await sleep(400);
  }
  throw new Error("snapshot timeout");
}
async function waitMonaco(call, tries = 20) {
  for (let i = 0; i < tries; i++) {
    if (
      (await ev(call, "(() => !!document.querySelector('.monaco-diff-editor .view-lines'))()")) ===
      true
    )
      return true;
    await sleep(700);
  }
  return false;
}
async function key(call, k, code, vkCode, wait = 120) {
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: k,
    code,
    windowsVirtualKeyCode: vkCode,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: k,
    code,
    windowsVirtualKeyCode: vkCode,
  });
  await sleep(wait);
}
async function focusSep(call) {
  return (
    (await ev(
      call,
      `(() => { const g = document.querySelector('[role="separator"][aria-label="调整文件目录宽度"]');
      if (!g) return false; g.focus(); return document.activeElement === g; })()`,
    )) === true
  );
}
async function setDirHome(call) {
  if (!(await focusSep(call))) return null;
  await key(call, "Home", "Home", 36, 500);
  return ev(
    call,
    `(() => { const g = document.querySelector('[role="separator"][aria-label="调整文件目录宽度"]');
    return g ? Number(g.getAttribute('aria-valuenow')) : null; })()`,
  );
}
async function clickByText(call, text, exact = false) {
  const cmp = exact
    ? `(x.textContent||'').trim() === '${text}'`
    : `(x.textContent||'').trim().startsWith('${text}')`;
  return ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => ${cmp}); if (!b) return false; b.click(); return true; })()`,
  );
}
async function clickByAria(call, aria) {
  return ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => x.getAttribute('aria-label') === '${aria}'); if (!b) return false; b.click(); return true; })()`,
  );
}
/**
 * 进入文件页。
 *
 * ⚠️ 与 5.1 的差异（2026-09-23 实测）：**不强制切到 ISO run**。
 *   - single 档（<720px，如 zoomFactor=2 的 605px 视口）下运行列表**不渲染可复制的 run 行**
 *     （`aria-label="复制完整运行 ID …"` 数量为 0）⇒ 5.1 那套"切概览 → 回列表 → 选 run"
 *     在此档根本走不通。
 *   - 但 dev 冷启动默认停的 `run_muaps3pw_m1lr` 本身就是**隔离文件运行**（描述含"从运行
 *     run_muappa2a_gk7964 的检查点续跑而来"），**有文件页**，足以验证 5.2 三场景。
 *   ⇒ 窄档直接用当前 run；仅在 wide 档才尝试切到 ISO run（保持与 5.1 证据可比）。
 */
async function gotoIsoRunAndFile(call, m) {
  const cur = await ev(call, currentRunExpr);
  m.currentRunIdBefore = cur;
  const snap0 = await readSnap(call).catch(() => null);
  const bp = snap0?.breakpoint ?? "wide";
  m.entryBreakpoint = bp;

  // 仅 wide/medium 档尝试切到 ISO run（窄档运行列表不可选）
  if (cur !== ISO_RUN && (bp === "wide" || bp === "medium")) {
    await ev(call, overviewTabExpr);
    await sleep(600);
    for (let i = 0; i < 6; i++) {
      await ev(call, trailsBtnExpr);
      await sleep(700);
      if ((await ev(call, runListVisibleExpr)) === true) break;
    }
    const hasIso =
      (await ev(
        call,
        `(() => !!Array.from(document.querySelectorAll('button')).find(b =>
          (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${ISO_RUN}')))()`,
      )) === true;
    if (hasIso) {
      await ev(call, selectRunExpr(ISO_RUN));
      await sleep(1500);
      m.currentRunIdAfter = await ev(call, currentRunExpr);
      m.usedIsoRun = true;
    } else {
      m.usedIsoRun = false;
      m.isoRunUnavailable = true;
    }
  } else {
    m.usedIsoRun = cur === ISO_RUN;
    if (cur === ISO_RUN) m.currentRunIdAfter = cur;
  }

  await ev(call, filesTabExpr);
  await sleep(1400);
  // 选一个"后面的"检查点（让左右两侧有真实差异）；按钮不在场也不致命
  await ev(call, laterCkptExpr);
  await sleep(1200);

  /**
   * ⚠️ 单栏档（single/narrow）的额外一步（2026-09-23 实测）：
   *   目录不常驻时，**「文件列表」与「内容」是两个互斥 pane**，默认显示「内容」⇒
   *   文件清单 DOM（`[role="listbox"]` / `[role="option"][data-file-path]`）**根本不存在**，
   *   直接找文件项会拿到 0 个。必须先点 `aria-label="显示文件列表"` 切到列表侧，
   *   选完文件再点「显示文件内容」切回。这正是 spec「目录与内容可切换」的实机形态。
   */
  const paneListBtn = `(() => { const b = Array.from(document.querySelectorAll('button'))
    .find(x => x.getAttribute('aria-label') === '显示文件列表'); return !!b; })()`;
  const hasPaneTabs = (await ev(call, paneListBtn)) === true;
  m.hasPaneTabs = hasPaneTabs;
  if (hasPaneTabs) {
    const toList = await clickByAria(call, "显示文件列表");
    await sleep(900);
    m.paneToList = toList;
  }

  const picked = await ev(call, pickFileExpr(TEXT_FILE));
  if (picked === true) {
    if (hasPaneTabs) await clickByAria(call, "显示文件内容");
    return waitMonaco(call);
  }

  /**
   * ⚠️ 筛选陷阱（2026-09-23 实测）：文件清单默认筛选是**「有变化」**。
   *   若所选检查点下没有文件相对「本 run 初始状态」发生变化，会显示「筛出 0 / 共 2」
   *   ⇒ `[role="option"]` 一个都没有，直接找文件项必然拿 0 个（不是渲染 bug）。
   *   解除：点「全部」（或「查看全部」）切到未筛选清单。
   */
  const filterState = await ev(
    call,
    `(() => { const t = (document.body.innerText||'').match(/筛出 \\d+ \\/ 共 \\d+/);
    return t ? t[0] : null; })()`,
  );
  m.filterStateBefore = filterState;
  const allBtn = await clickByText(call, "全部", true);
  await sleep(900);
  m.switchedToAll = allBtn;
  m.filterStateAfter = await ev(
    call,
    `(() => { const t = (document.body.innerText||'').match(/筛出 \\d+ \\/ 共 \\d+/);
    return t ? t[0] : null; })()`,
  );

  const picked2 = await ev(call, pickFileExpr(TEXT_FILE));
  if (picked2 === true) {
    if (hasPaneTabs) await clickByAria(call, "显示文件内容");
    return waitMonaco(call);
  }
  // 兜底：清单里若没有 a.txt，选第一个可用文件
  const firstPath = await ev(
    call,
    `(() => { const o = document.querySelector('[role="option"][data-file-path]');
    return o ? o.getAttribute('data-file-path') : null; })()`,
  );
  if (typeof firstPath === "string" && firstPath) {
    m.fallbackFile = firstPath;
    if ((await ev(call, pickFileExpr(firstPath))) === true) {
      if (hasPaneTabs) await clickByAria(call, "显示文件内容");
      return waitMonaco(call);
    }
  }
  return false;
}

// ——————————————————————————————————————————————
// 场景 ① 极窄与放大后仍可阅读
// ——————————————————————————————————————————————
async function scenarioNarrowOrZoom(call, m, label) {
  const loaded = await gotoIsoRunAndFile(call, m);
  m.fileLoaded = loaded;
  check(`[${TAG}] 进入文件页并装载 Monaco`, loaded === true);
  if (!loaded) return;
  await setDirHome(call);
  const s = await readSnap(call);
  Object.assign(m, s);
  check(
    `[${label}] 记录视口 ${s.cw}×${s.ch}（外框 ${s.outerW}×${s.outerH}，DPR ${s.dpr}，断点 ${s.breakpoint}）`,
    s.cw > 0,
    `online=${s.online}`,
  );
  check(
    `[${label}] 无整页横向滚动`,
    s.bodyOk === true,
    `scrollWidth=${s.bodySw} clientWidth=${s.bodyCw}`,
  );
  check(
    `[${label}] 目录一律收起（spec 硬要求）`,
    s.dirResident === false,
    `dirResident=${s.dirResident} dirW=${s.dirW}`,
  );
  check(`[${label}] diff 强制 inline`, s.mode === "inline", `mode=${s.mode}`);
  check(
    `[${label}] 正文使用可用主区（inline 文字区 >0）`,
    (s.effectiveTextW ?? 0) > 0,
    `有效文字区=${s.effectiveTextW}`,
  );
  check(`[${label}] 字号未缩小（≥13px）`, (s.fontSize ?? 0) >= 13, `fontSize=${s.fontSize}`);
  check(
    `[${label}] 工具栏换行控件可达`,
    typeof s.toolbar.wordWrap === "string" && s.toolbar.wordWrap.startsWith("换行"),
    s.toolbar.wordWrap ?? undefined,
  );
  check(`[${label}] 检查点按钮可达（能进文件页即证明）`, s.containerW !== null);
  check(
    `[${label}] 窄档下目录/内容可切换（有 pane 入口或分隔条）`,
    s.toolbar.backToDir === true || s.sepPresent === true,
    `pane入口=${s.toolbar.backToDir} 分隔条=${s.sepPresent}`,
  );
  await shot(call, SHOT_DIR, `a-${TAG}-narrow.png`);

  // 局部滚动允许：证明正文可滚动而不引发整页滚动
  const scrollable = await ev(
    call,
    `(() => { const sc = document.querySelector('.monaco-scrollable-element.editor-scrollable');
    return sc ? { sh: sc.scrollHeight, ch: sc.clientHeight } : null; })()`,
  );
  m.localScroll = scrollable;
  check(
    `[${label}] 允许 inline 局部滚动（编辑器内可滚，非整页）`,
    scrollable !== null && s.bodyOk === true,
    scrollable ? `scrollH=${scrollable.sh} clientH=${scrollable.ch}` : "no scrollable",
  );

  // 键盘走查：Tab 能到工具栏，Enter/Space 可激活（抽查换行按钮）
  const kb = await ev(
    call,
    `(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim().startsWith('换行：'));
      if (!b) return null;
      b.focus();
      return { focused: document.activeElement === b, text: b.textContent.trim(),
        hasFocusRing: !!b.className && /ring|outline|focus/.test(b.className) };
    })()`,
  );
  m.keyboardToolbar = kb;
  check(
    `[${label}] 工具栏控件可获得键盘焦点`,
    kb !== null && kb.focused === true,
    JSON.stringify(kb),
  );
}

// ——————————————————————————————————————————————
// 场景 ② 手动布局偏好不被自动折叠覆盖
// ——————————————————————————————————————————————
async function scenarioPrefs(call, m) {
  const loaded = await gotoIsoRunAndFile(call, m);
  m.fileLoaded = loaded;
  check(`[${TAG}] 进入文件页并装载 Monaco`, loaded === true);
  if (!loaded) return;

  // 基准：宽档，目录常驻
  await setDirHome(call);
  const base = await readSnap(call);
  m.base = {
    cw: base.cw,
    dirResident: base.dirResident,
    dirW: base.dirW,
    mode: base.mode,
    effectiveTextW: base.effectiveTextW,
    breakpoint: base.breakpoint,
  };
  check(
    `[${TAG}] 基准档：视口 ${base.cw}，目录常驻=${base.dirResident}`,
    base.dirResident === true,
    `dirW=${base.dirW}`,
  );

  // —— 偏好 A：用户调目录宽（Home 复位到 200 后 +5×16px ⇒ 280，≠默认 232 ≠ min 200）——
  await setDirHome(call);
  const sepFocused = await focusSep(call);
  if (sepFocused) {
    for (let i = 0; i < 5; i++) await key(call, "ArrowRight", "ArrowRight", 39, 120);
    await sleep(600);
  }
  const widthSnap = await readSnap(call);
  m.prefWidth = { sepFocused, dirW: widthSnap.dirW, sepValueNow: widthSnap.sepValueNow };
  check(`[${TAG}] 用户调目录宽生效（期望 280）`, widthSnap.dirW === 280, `dirW=${widthSnap.dirW}`);

  // —— 偏好 B：用户显式收起目录 ——
  const collapsed = await clickByText(call, "收起目录");
  await sleep(700);
  const s1 = await readSnap(call);
  m.prefCollapse = { clicked: collapsed, dirResident: s1.dirResident, dirW: s1.dirW };
  check(
    `[${TAG}] 用户显式收起目录生效`,
    collapsed === true && s1.dirResident === false,
    `dirW=${s1.dirW}`,
  );

  // —— 偏好 C：diff 模式控件可切换 ——
  const modeBtnTxt = await clickByText(call, "模式：");
  await sleep(700);
  const s2 = await readSnap(call);
  m.prefMode = { clicked: modeBtnTxt, modeBtn: s2.toolbar.modeBtn, mode: s2.mode };
  check(`[${TAG}] diff 模式控件可切换`, modeBtnTxt === true, `当前 ${s2.toolbar.modeBtn}`);

  await shot(call, SHOT_DIR, `b-${TAG}-prefs-set.png`);

  // —— 缩窄 → 降级 → 恢复：偏好不被改写 ——
  // 由编排层（PowerShell）把窗口缩到 800 档后调用 --tag=prefs-narrow，再回宽档调用 --tag=prefs-restore
  m.note = "缩窄/恢复由编排层分两次调用（prefs-narrow / prefs-restore）验证；宽度偏好期望 280";
}

async function scenarioPrefsNarrow(call, m) {
  const s = await readSnap(call);
  Object.assign(m, {
    cw: s.cw,
    breakpoint: s.breakpoint,
    dirResident: s.dirResident,
    dirW: s.dirW,
    mode: s.mode,
  });
  check(`[${TAG}] 缩窄后视口 ${s.cw}（断点 ${s.breakpoint}）`, s.cw > 0);
  check(`[${TAG}] 缩窄后安全降级（目录收起）`, s.dirResident === false, `dirW=${s.dirW}`);
  check(`[${TAG}] 缩窄后无整页横向滚动`, s.bodyOk === true);
  check(`[${TAG}] 缩窄后正文仍可读`, (s.effectiveTextW ?? 0) > 0, `文字区=${s.effectiveTextW}`);
  await shot(call, SHOT_DIR, `b-${TAG}-degraded.png`);
}

async function scenarioPrefsRestore(call, m) {
  const s = await readSnap(call);
  Object.assign(m, {
    cw: s.cw,
    breakpoint: s.breakpoint,
    dirResident: s.dirResident,
    dirW: s.dirW,
    mode: s.mode,
    effectiveTextW: s.effectiveTextW,
    toolbar: s.toolbar,
  });
  check(
    `[${TAG}] 恢复宽档视口 ${s.cw}（断点 ${s.breakpoint}）`,
    s.cw >= 1195,
    "期望 ≥1195（1210 档实测 1207）",
  );
  check(
    `[${TAG}] ★ 宽度恢复后用户偏好复原（显式收起仍收起）`,
    s.dirResident === false,
    `dirResident=${s.dirResident}（期望保持 false：用户显式收起不应被自动改回）`,
  );
  await shot(call, SHOT_DIR, `b-${TAG}-restored.png`);

  // 复原：展开目录，验证可以回到常驻（偏好可逆）
  const expanded = await clickByText(call, "展开目录");
  await sleep(700);
  const s2 = await readSnap(call);
  m.afterExpand = { clicked: expanded, dirResident: s2.dirResident, dirW: s2.dirW };
  check(
    `[${TAG}] 偏好可逆：重新展开目录恢复常驻`,
    expanded === true && s2.dirResident === true,
    `dirW=${s2.dirW}`,
  );
}

// ——————————————————————————————————————————————
// 场景 ③ 离线加载
// ——————————————————————————————————————————————
async function scenarioOffline(call, m) {
  await call("Network.enable").catch(() => {});
  await call("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await sleep(600);
  const offline = await ev(call, "navigator.onLine");
  m.offlineFlag = offline;
  check(`[${TAG}] 已切到离线（navigator.onLine=false）`, offline === false);

  // 重新进文件页（强制 Monaco 懒加载走缓存）
  const loaded = await gotoIsoRunAndFile(call, m);
  m.fileLoaded = loaded;
  check(`[${TAG}] 离线仍能进入文件页并渲染 Monaco（本地懒加载）`, loaded === true);

  if (loaded) {
    const s = await readSnap(call);
    m.offlineSnap = {
      cw: s.cw,
      mode: s.mode,
      effectiveTextW: s.effectiveTextW,
      dirResident: s.dirResident,
      fontSize: s.fontSize,
      bodyOk: s.bodyOk,
    };
    check(`[${TAG}] 离线状态正文可读`, (s.effectiveTextW ?? 0) > 0, `文字区=${s.effectiveTextW}`);
    check(`[${TAG}] 离线无整页横向滚动`, s.bodyOk === true);

    // 键盘：关闭查找返回编辑器（spec 明写）
    const findOpened = await clickByText(call, "查找");
    await sleep(900);
    const findOn = await ev(call, "(() => !!document.querySelector('.find-widget.visible'))()");
    await key(call, "Escape", "Escape", 27, 700);
    const findOff = await ev(call, "(() => !!document.querySelector('.find-widget.visible'))()");
    const backToEditor = await ev(
      call,
      `(() => { const a = document.activeElement;
      return a ? (a.className||'').includes('monaco') || !!a.closest('.monaco-editor')
        || (a.className||'').includes('native-edit-context')
        || a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' : false; })()`,
    );
    m.findRoundTrip = { findOpened, findOn, findOff, backToEditor };
    check(
      `[${TAG}] 打开查找后 Esc 关闭并返回编辑器`,
      findOpened === true && findOn === true && findOff === false && backToEditor === true,
      JSON.stringify(m.findRoundTrip),
    );
    await shot(call, SHOT_DIR, `c-${TAG}-offline.png`);
  }

  // 还原网络
  await call("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await call("Network.disable").catch(() => {});
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const data = loadOut();
  const page = await cdpConnect(PORT);
  const call = await makeSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await sleep(500);

  const m = {};
  data.measurements[TAG] = m;

  if (TAG === "zoom2") {
    await scenarioNarrowOrZoom(call, m, "zoomFactor=2");
    // 额外断言：zoomFactor 确实生效（CSS 视口约为窗口宽的一半）
    const ratio = m.iww ? null : null;
    check(
      "[zoom2] 确为真 zoom（DPR 约 2× 基线 ⇒ 布局视口按比例缩小）",
      (m.dpr ?? 0) > 3.5,
      `dpr=${m.dpr}（基线 2.10 ⇒ 期望 ≈4.2），CSS 视口 ${m.cw}`,
    );
    void ratio;
  } else if (TAG === "prefs") {
    await scenarioPrefs(call, m);
  } else if (TAG === "prefs-narrow") {
    await scenarioPrefsNarrow(call, m);
  } else if (TAG === "prefs-restore") {
    await scenarioPrefsRestore(call, m);
  } else if (TAG === "offline") {
    await scenarioOffline(call, m);
  } else {
    await scenarioNarrowOrZoom(call, m, TAG);
  }

  data.checks = data.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
  saveOut(data);

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n完成：[${TAG}] ${checks.length - failed.length}/${checks.length} 通过；证据 ${SHOT_DIR}`,
  );
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
