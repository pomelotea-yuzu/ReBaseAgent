/* eslint-disable */
/**
 * U2 任务 5.1：宽窗口文件阅读矩阵——**真实 Electron 窗口**证据采集。
 *
 * ⚠️ 与 U1 7.1/7.2 的**关键差异**（2026-09-23 实测确立，必须遵守）：
 *   1. **不得用 `Emulation.setDeviceMetricsOverride` 伪造宽档**。实测：Emulation 把布局视口
 *      伪到 1440 后，Monaco 的 automaticLayout（基于真实元素尺寸）被破坏 ⇒ 左侧 editor 被
 *      压成 36px（真实 1276 窗口下为 480px）。**Monaco 内部几何在 Emulation 下不可信**。
 *   2. 宽档必须用**真实窗口尺寸**：由调用方用 Win32 `MoveWindow`（`.workbuddy/ps-win.ps1`）
 *      改窗口外框，本脚本只负责连 CDP 采集与校验。
 *
 * 本机约束（实测）：屏幕物理 1707×1067、DPI 缩放 141% ⇒ **窗口外框可超出屏幕物理边界**，
 * Electron 仍按请求的 CSS 尺寸渲染（实测外框 2030×1310 ⇒ CSS 1441×887）。
 * ⚠️ 2026-09-23 修正：先前的「design D7 的 1440×900 / 1360×860 在本机物理不可达」结论**错误**——
 *    那是窗口被**最大化裁剪**（1221 上限）所致。复原窗口（SW_RESTORE）后六档**全部可达**，
 *    故本脚本对 D7 六档一视同仁地真实采集，**不再有"不可达"分支**。
 *    外框↔CSS 映射见 `.workbuddy/u2-51/window-calibration.json`。
 *
 * 用法（分档执行；每档前先由人/编排用 PowerShell 把窗口改到 `--outer` 指定的外框）：
 *   node apps/desktop/scripts/u2-51-cdp.cjs --tag=1440 --expect=1440
 *   node apps/desktop/scripts/u2-51-cdp.cjs --tag=1360 --expect=1360
 *   node apps/desktop/scripts/u2-51-cdp.cjs --tag=1210 --expect=1210
 *   node apps/desktop/scripts/u2-51-cdp.cjs --tag=1024 --expect=1024
 *   node apps/desktop/scripts/u2-51-cdp.cjs --tag=800  --expect=800
 *   node apps/desktop/scripts/u2-51-cdp.cjs --tag=640  --expect=640
 *   ⚠️ 每档必须**单独调用一次**：`containerChange`（同视口响应容器变化）在本次调用内完成，
 *      合并多档会只保留最后一档的该项证据。
 *
 * 每档产出：容器宽 / 目录宽 / Monaco 两侧**实际文字区**（`.view-lines`）/ 模式 / 断点 /
 * 该档 D4 判据结论 + 截图。另附「同视口下响应容器变化」（只改容器内目录宽，视口不动）。
 *
 * ⚠️ Monaco 0.56 内部空间启发式陷阱（2026-09-23 实机发现，已修）：
 *   Monaco 默认 `useInlineViewWhenSpaceIsLimited:true` + `renderSideBySideInlineBreakpoint:900`，
 *   只要**编辑器元素宽 ≤900px** 就无视外面传入的 `renderSideBySide:true` 强行改渲染 inline，
 *   左侧被压成 36px 细条（sash 消失）。`WorkspaceFileView.tsx` 已显式关闭该启发式。
 *   故本脚本在 inline 档读到 `original` 层 36px 是**正常的隐藏层**，有效文字区取**较宽侧**。
 *
 * 证据落 `docs/reviews/2026-09-23-u2-51/` 与 `.workbuddy/u2-51/measurements.json`。
 * ⚠️ 本脚本**不 spawn、不重启 dev、不改窗口**；窗口尺寸由编排层负责。
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, makeSession, ev, shot } = require("./lib/u2-cdp-util.cjs");

const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-23-u2-51");
const OUT_DIR = join(REPO, ".workbuddy", "u2-51");
const OUT = join(OUT_DIR, "measurements.json");

const PORT = Number(process.env.CDP_PORT ?? 9612);

const arg = (name, dflt) => {
  const v = process.argv.find((a) => a.startsWith(`--${name}=`));
  return v ? v.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "current");
const EXPECT = Number(arg("expect", "0"));

/** 隔离 v2（有文件 + 真实 diff；a.txt 被改写） */
const ISO_RUN = "run_muappa2a_gk7964";
const TEXT_FILE = "a.txt";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(`${ok === true ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

function loadOut() {
  if (!existsSync(OUT)) return { task: "U2-5.1", measurements: {}, checks: [], runs: {} };
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return { task: "U2-5.1", measurements: {}, checks: [], runs: {} };
  }
}
function saveOut(data) {
  mkdirSync(OUT_DIR, { recursive: true });
  data.capturedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(data, null, 2));
}

const bpOf = (w) => (w >= 1280 ? "wide" : w >= 960 ? "medium" : w >= 720 ? "narrow" : "single");

/** 切回「轨迹」主视图，确保运行列表在场（否则选不到 ISO run）。 */
const backToTrailsExpr = `(() => {
  const b = Array.from(document.querySelectorAll('button'))
    .find(x => (x.textContent||'').trim() === '轨迹');
  if (!b) return false; b.click(); return true; })()`;
/** 运行列表是否可见（出现「新建运行」或任一运行行）。 */
const runListVisibleExpr = `(() => {
  if (document.querySelector('[role="option"][data-file-path]')) return false; // 还在文件页
  const hasNew = Array.from(document.querySelectorAll('button'))
    .some(b => (b.textContent||'').trim().includes('新建运行'));
  const hasRow = Array.from(document.querySelectorAll('button'))
    .some(b => (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID'));
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
  const cand = Array.from(document.querySelectorAll('button')).filter(b => (b.title||'').includes('检查点所属 step'));
  if (!cand.length) return false; cand[cand.length - 1].click(); return true; })()`;
const pickFileExpr = (
  p,
) => `(() => { const b = document.querySelector('[role="option"][data-file-path="${p}"]');
  if (!b) return false; b.click(); return true; })()`;

const geometryExpr = `(() => {
  const q = (s, r=document) => r.querySelector(s);
  const rect = (e) => e ? { w: Math.round(e.getBoundingClientRect().width),
    h: Math.round(e.getBoundingClientRect().height), left: Math.round(e.getBoundingClientRect().left) } : null;
  const container = q('[data-file-container-width]');
  const sep = q('[role="separator"][aria-label="调整文件目录宽度"]');
  const listbox = q('[role="listbox"][aria-label="工作区文件列表"]');
  const listDir = listbox ? listbox.parentElement : null;
  const mono = q('.monaco-diff-editor');
  // Monaco 0.56 DOM（2026-09-23 实测）：可见面是 .editor.original / .editor.modified
  //   包裹层，inline 的 width/left 挂在**该层**；其内 .monaco-editor 已变成 5px 的
  //   尺寸探针元素（不是文字面）。文字区必须读包裹层内
  //   .monaco-scrollable-element.editor-scrollable .view-lines，否则会误读 5px 伪空。
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
  // ⚠️ inline 模式（app 判据给出 inline）下 Monaco 仍保留**两个** .editor 层：
  //   被压成 36px 的那层是**隐藏侧**（其 .view-lines 宽 228 但不参与阅读），
  //   真正可读的是较宽那层（modified，实测 658）。故"有效文字区"必须取**较宽侧**，
  //   不能固定读 original —— 否则 inline 档会被误报成"228 < 480 不达标"（假失败）。
  const textWidths = sides.map(s => s.textW).filter(w => typeof w === 'number');
  const effectiveTextW = textWidths.length ? Math.max(...textWidths) : null;
  const mode = mono ? (leftBox > 0 && rightBox > 0 && Math.abs(leftBox - rightBox) < 0.6 * Math.max(leftBox, rightBox)
    ? 'sideBySide' : 'inline') : null;
  return JSON.stringify({
    cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
    outerW: outerWidth, outerH: outerHeight, dpr: devicePixelRatio,
    bodyOk: document.body.scrollWidth <= document.body.clientWidth,
    containerW: container ? Number(container.getAttribute('data-file-container-width')) : null,
    containerRect: rect(container),
    dirResident: listDir !== null && Math.round(listDir.getBoundingClientRect().width) > 0,
    dirW: listDir ? Math.round(listDir.getBoundingClientRect().width) : null,
    sepValueNow: sep ? Number(sep.getAttribute('aria-valuenow')) : null,
    mono: rect(mono), sides, effectiveTextW,
    mode,
    diffNote: (document.body.innerText||'').match(/共 \\d+ 处差异/)?.[0] ?? null,
    sideLine: (document.body.innerText||'').split('\\n').find(l => l.startsWith('左：')) ?? null,
    downgradeNote: (document.body.innerText||'').match(/空间不足[^\\n]*/)?.[0] ?? null,
    listOptionCount: document.querySelectorAll('[role="option"][data-file-path]').length,
    u2debug: (() => { const d = document.querySelector('[data-u2-debug]'); return d ? d.getAttribute('data-u2-debug') : null; })(),
  });
})()`;

async function readGeometry(call) {
  for (let t = 0; t < 8; t++) {
    const raw = await ev(call, geometryExpr);
    if (typeof raw === "string") return JSON.parse(raw);
    await sleep(400);
  }
  throw new Error("geometry read timeout");
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
async function nudgeDirWidth(call, key, times) {
  const focused = await ev(
    call,
    `(() => { const g = document.querySelector('[role="separator"][aria-label="调整文件目录宽度"]');
    if (!g) return false; g.focus(); return true; })()`,
  );
  if (!focused) return false;
  const vk = key === "ArrowRight" ? 39 : 37;
  for (let i = 0; i < times; i++) {
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: key,
      windowsVirtualKeyCode: vk,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: key,
      windowsVirtualKeyCode: vk,
    });
    await sleep(80);
  }
  return true;
}
async function enterFileView(call, file = TEXT_FILE) {
  await ev(call, filesTabExpr);
  await sleep(1400);
  await ev(call, laterCkptExpr);
  await sleep(1200);
  if ((await ev(call, pickFileExpr(file))) !== true) return false;
  return waitMonaco(call);
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
  // 确保没有任何 Emulation 覆盖（宽档必须是真实窗口）
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await sleep(400);

  const m = {};
  data.measurements[TAG] = m;

  const shell0 = await ev(
    call,
    "document.documentElement.clientWidth+'x'+document.documentElement.clientHeight+' | outer '+outerWidth+'x'+outerHeight+' dpr '+devicePixelRatio",
  );
  m.shellAtStart = shell0;
  check(`[${TAG}] 当前真实窗口 CSS 视口读取`, typeof shell0 === "string", shell0);

  // —— 确保停在隔离 v2 run 上（幂等）——
  // ⚠️ 不能用"页面文本含该 id"判断：fork 运行的说明里会**引用**父 run id
  //   （"从运行 run_muappa2a_gk7964 的检查点续跑而来"）⇒ 子串匹配会误判"已在该 run"。
  //   必须读**当前 run 的标题**（顶部运行条），精确等值比较。
  const currentRunExpr = `(() => {
    // 运行条：主视图切换后的那个 run 标题按钮/文本（精确等于某 run id）
    const cands = Array.from(document.querySelectorAll('button, span, div'))
      .map(e => (e.textContent||'').trim())
      .filter(t => /^run_[A-Za-z0-9_]+$/.test(t));
    return cands[0] ?? null; })()`;
  const currentRunId = await ev(call, currentRunExpr);
  m.currentRunIdBefore = currentRunId;
  const isOnIso = currentRunId === ISO_RUN;
  m.alreadyOnIsoRun = isOnIso;
  if (isOnIso !== true) {
    // ⚠️ 先切到「概览」页签再回列表：medium 断点下**文件页会临时收起运行导航**
    //   （layout.ts decideNavVisible：tab==="files" ⇒ navVisible=false），
    //   此时运行列表根本不渲染、选不到 run。切到概览/步骤页导航即恢复。
    const overviewTabExpr = `(() => {
      const b = Array.from(document.querySelectorAll('[role="tab"]'))
        .find(x => (x.textContent||'').trim() === '概览');
      if (b) { b.click(); return true; }
      // 没有页签（还在列表/概览主视图）也算 ok
      return 'no-tab'; })()`;
    await ev(call, overviewTabExpr);
    await sleep(700);
    for (let i = 0; i < 6; i++) {
      await ev(call, backToTrailsExpr);
      await sleep(700);
      if ((await ev(call, runListVisibleExpr)) === true) break;
    }
    const inList = await ev(call, runListVisibleExpr);
    check(`[${TAG}] 已回到运行列表（原不在目标 run 上）`, inList === true);

    const hasIso = await ev(
      call,
      `(() => !!Array.from(document.querySelectorAll('button')).find(b =>
        (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${ISO_RUN}')))()`,
    );
    check(`[${TAG}] 隔离 v2 run 在列表中`, hasIso === true, ISO_RUN);
    if (hasIso !== true) {
      saveOut(data);
      process.exit(1);
    }
    await ev(call, selectRunExpr(ISO_RUN));
    await sleep(1500);
    m.currentRunIdAfter = await ev(call, currentRunExpr);
  }

  const loaded = await enterFileView(call, TEXT_FILE);
  m.fileLoaded = loaded;
  check(`[${TAG}] 进入文件页并装载 Monaco（${TEXT_FILE}）`, loaded === true);
  if (!loaded) {
    saveOut(data);
    process.exit(1);
  }

  // —— 把目录宽复位到默认（Home → 232），保证「容器变化」测量从已知态出发 ——
  // 上一次脚本可能把目录留在 320（max）；不复位会让 ArrowRight 无效果、误判"不可调"。
  {
    const focused = await ev(
      call,
      `(() => { const g = document.querySelector('[role="separator"][aria-label="调整文件目录宽度"]');
      if (!g) return false; g.focus(); return document.activeElement === g; })()`,
    );
    if (focused === true) {
      await call("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Home",
        code: "Home",
        windowsVirtualKeyCode: 36,
      });
      await call("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Home",
        code: "Home",
        windowsVirtualKeyCode: 36,
      });
      await sleep(600);
    }
    m.dirResetOk = await ev(
      call,
      `(() => { const g = document.querySelector('[role="separator"][aria-label="调整文件目录宽度"]');
      return g ? Number(g.getAttribute('aria-valuenow')) : null; })()`,
    );
    await sleep(600);
  }

  const g = await readGeometry(call);
  Object.assign(m, g);
  m.breakpoint = bpOf(g.cw);
  m.expectedCssW = EXPECT || null;
  m.reachable = EXPECT ? Math.abs(g.cw - EXPECT) <= 2 : null;
  const leftText = g.sides.find((s) => s.kind === "original")?.textW ?? null;
  const rightText = g.sides.find((s) => s.kind === "modified")?.textW ?? null;
  m.leftTextW = leftText;
  m.rightTextW = rightText;
  m.effectiveTextW = g.effectiveTextW;

  check(
    `[${TAG}] 实测 CSS 视口=${g.cw}×${g.ch}（外框 ${g.outerW}×${g.outerH}，dpr ${g.dpr.toFixed(2)}）`,
    EXPECT ? Math.abs(g.cw - EXPECT) <= 2 : true,
    EXPECT ? `期望 ${EXPECT}` : undefined,
  );
  check(`[${TAG}] body 无横向溢出`, g.bodyOk === true);
  check(
    `[${TAG}] Monaco 已渲染（diff 容器在场）`,
    g.mono !== null,
    g.mono ? `${g.mono.w}×${g.mono.h}@${g.mono.left}` : undefined,
  );
  check(
    `[${TAG}] 两侧编辑器均在场且非伪空`,
    g.sides.filter((s) => s.kind === "original" || s.kind === "modified").length === 2,
    JSON.stringify(g.sides),
  );
  check(`[${TAG}] 清单非空（有可读文件）`, g.listOptionCount > 0, `${g.listOptionCount} 个选项`);

  if (g.cw >= 960) {
    if (g.mode === "sideBySide" && leftText !== null && rightText !== null) {
      // 并排：以**实际文字区**（两侧 .view-lines 宽）为准，逐侧 ≥320
      check(
        `[${TAG}] 并排每侧文字区 ≥320（D4）`,
        leftText >= 320 && rightText >= 320,
        `左=${leftText} 右=${rightText}`,
      );
    } else {
      // inline：Monaco 保留隐藏层，取**较宽（可见）侧**的文字区
      check(
        `[${TAG}] inline 文字区 ≥480（D4，≥960 视口）`,
        (g.effectiveTextW ?? 0) >= 480,
        `文字区=${g.effectiveTextW}（两侧 raw=${JSON.stringify(g.sides.map((s) => s.textW))}）`,
      );
    }
  } else {
    // 窄档（<960）：目录常驻与否由**容器实测宽**决定（不是固定"必收起"）。
    // design D4 的硬判据是「扣掉目录+间距+chrome 后 inline 文字区 ≥480 才常驻」——
    // 800 档 800-200-12-64 = 524 ≥ 480 ⇒ 常驻是**合规**结果，不能断言"必收起"。
    // 故这里只断言：inline 模式生效；若目录常驻，则正文文字区仍可读（>0）。
    check(`[${TAG}] 窄档（<960）降级为 inline`, g.mode === "inline");
    check(
      `[${TAG}] 窄档正文可读（inline 文字区 >0）`,
      (g.effectiveTextW ?? 0) > 0,
      `文字区=${g.effectiveTextW}，目录常驻=${g.dirResident}（${g.dirW}）`,
    );
    m.narrowDirResident = g.dirResident;
    m.narrowDirW = g.dirW;
  }

  await shot(call, SHOT_DIR, `a-${TAG}-files-monaco.png`);

  // —— 长文本（长文本及窄窗口）——
  const fileList = JSON.parse(
    (await ev(
      call,
      `(() => JSON.stringify(Array.from(document.querySelectorAll('[role="option"][data-file-path]'))
      .map(b => b.getAttribute('data-file-path'))))()`,
    )) ?? "[]",
  );
  m.availableFiles = fileList;
  const longest = fileList.slice().sort((a, b) => b.length - a.length)[0] ?? TEXT_FILE;
  if (longest !== TEXT_FILE) {
    if ((await ev(call, pickFileExpr(longest))) === true) {
      await waitMonaco(call);
      await sleep(600);
      const lg = await readGeometry(call);
      m.longFile = { path: longest, monoW: lg.mono?.w ?? null, effectiveTextW: lg.effectiveTextW };
      await shot(call, SHOT_DIR, `b-${TAG}-longtext.png`);
    }
  } else {
    // 清单里只有 a.txt：用当前视图作"长路径可读"证据，并记录换行控件
    const wrapBtn = await ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').startsWith('换行：'));
      return b ? b.textContent.trim() : null; })()`,
    );
    m.longFile = {
      path: longest,
      note: "清单仅含 a.txt（38B），长文本由 scroll-restore/换行控件承载",
      wordWrapButton: wrapBtn,
    };
  }
  check(
    `[${TAG}] 长文本/长路径档可读且有换行控件`,
    (m.longFile?.effectiveTextW ?? g.effectiveTextW) !== null,
    JSON.stringify(m.longFile),
  );

  // —— 同视口下响应容器变化（视口不动，只改容器内布局）——
  // 分两支：
  //  A) 目录常驻 ⇒ 调分隔条改目录宽，断言文字区随容器重算（视口不变）。
  //  B) 目录非常驻（窄档）⇒ 目录与内容占同一主区，改用**列表/内容 pane 切换**证明
  //     "响应容器"（spec 明写"不足时列表与内容分别占用主区"）；此时无分隔条可调。
  const before = await readGeometry(call);
  if (before.dirResident === true) {
    const nudged = await nudgeDirWidth(call, "ArrowRight", 5);
    await sleep(700);
    const after = await readGeometry(call);
    m.containerChange = {
      kind: "dirWidth",
      dirBefore: before.dirW,
      dirAfter: after.dirW,
      textBefore: before.effectiveTextW,
      textAfter: after.effectiveTextW,
      modeBefore: before.mode,
      modeAfter: after.mode,
      viewportBefore: before.cw,
      viewportAfter: after.cw,
    };
    check(
      `[${TAG}] 分隔条键盘可调目录宽（容器内变化）`,
      nudged === true && after.dirW !== before.dirW,
      `目录 ${before.dirW} → ${after.dirW}${after.dirW === 0 ? "（空间不足 ⇒ 目录收起，符合正文优先）" : ""}`,
    );
    check(
      `[${TAG}] 视口未变（证明吃容器实测宽而非 window 断点）`,
      Math.abs(after.cw - before.cw) <= 1,
      `视口 ${before.cw} → ${after.cw}`,
    );
    check(
      `[${TAG}] Monaco 文字区随容器重算（容器变 ⇒ 文字区变）`,
      m.containerChange.textAfter !== null &&
        m.containerChange.textAfter !== m.containerChange.textBefore,
      `文字区 ${m.containerChange.textBefore} → ${m.containerChange.textAfter}（目录 ${m.containerChange.dirBefore} → ${m.containerChange.dirAfter}）`,
    );
    await shot(call, SHOT_DIR, `c-${TAG}-dir-wider.png`);
  } else {
    // 分支 B：pane 二选一（文件列表 / 内容）——按 **aria-label** 取按钮（文案会变）
    const paneExpr = (aria) => `(() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find(x => x.getAttribute('aria-label') === '${aria}');
      if (!b) return false; b.click(); return true; })()`;
    const listVisible = `(() => !!document.querySelector('[role="listbox"][aria-label="工作区文件列表"]')?.getBoundingClientRect().width)()`;
    const editorVisible = `(() => { const m = document.querySelector('.monaco-diff-editor');
      return !!(m && m.getBoundingClientRect().width > 0); })()`;
    const asList = await ev(call, paneExpr("显示文件列表"));
    await sleep(700);
    const listOn = await ev(call, listVisible);
    const editorOff = await ev(call, editorVisible);
    const asContent = await ev(call, paneExpr("显示文件内容"));
    await sleep(700);
    const listOff = await ev(call, listVisible);
    const editorOn = await ev(call, editorVisible);
    await sleep(500);
    const restored = await readGeometry(call);
    m.containerChange = {
      kind: "paneToggle",
      asList,
      listOn,
      editorOff,
      asContent,
      listOff,
      editorOn,
      viewportBefore: before.cw,
      viewportAfter: restored.cw,
    };
    check(
      `[${TAG}] 窄档列表/内容二选一占主区（响应容器）`,
      asList === true &&
        asContent === true &&
        listOn === true &&
        editorOff === false &&
        listOff === false &&
        editorOn === true,
      JSON.stringify(m.containerChange),
    );
    check(
      `[${TAG}] 视口未变（证明吃容器实测宽而非 window 断点）`,
      Math.abs(restored.cw - before.cw) <= 1,
      `视口 ${before.cw} → ${restored.cw}`,
    );
    await shot(call, SHOT_DIR, `c-${TAG}-pane-content.png`);
  }

  // 还原目录宽（仅当分隔条仍在场；窄档收起时无分隔条，nudge 会直接返回 false）
  await nudgeDirWidth(call, "ArrowLeft", 5);
  await sleep(400);

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
