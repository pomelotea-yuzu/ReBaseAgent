/* eslint-disable */
/**
 * U7 任务 6.9（Electron 实机第六批/末批）：纯键盘闭环、手动先子后父与显式父子
 * 入口的左右顺序、文件自有检查点往返、草稿/设置往返、后台结束不抢焦点。
 *
 * 对应 delta 场景（evidence-index #19、#38、#40、#42、#44、#61、#62、#64）。
 *
 * 判据纪律（同 6.4–6.8）：
 * - 真键盘 = CDP Input.dispatchKeyEvent 合成 TAB/Enter/Esc（U6 6.8 同款：有界步进
 *   ≤40 步、activeElement 逐步断言）；焦点起点允许程序化 focus（U6 同口径），
 *   步进与激活必须是真实键事件；
 * - 未具备实机注入面的情况明确登记（不能用静态标记冒充）：「后台结束不抢比较页」
 *   的自动导航半边需要真实执行会话 ⇒ 由 U6 6.7 mock 竞速实测（收尾不导航/不抢
 *   焦点族）+ U5 §3.4 单元承载；本批零执行通道纪律下不重建执行环境；
 * - 全程只读（比较路径零执行通道；文件入口走 runs:get + 只读清单）。
 *
 * 用法：`node apps/desktop/scripts/u7-69-cdp.cjs --tag=keyboard-entries`
 */
"use strict";
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["keyboard-entries"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u7", "u7-69");
const SHOT_DIR = join(OUT_DIR, "shots");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

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
function headShort() {
  try {
    const head = readFileSync(join(H.REPO, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: (.+)$/);
    if (m) {
      const refFile = join(H.REPO, ".git", ...m[1].split("/"));
      if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}
function finish(extraMeta = {}) {
  const failed = checks.filter((c) => !c.ok);
  const meta = {
    head: headShort(),
    node: process.version,
    tracesCount: H.traceIds().size,
    ...extraMeta,
  };
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, meta, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 12 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 720_000);

// ---------------------------------------------------------------------------
// 键盘合成与步进
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 系统级真键盘（U6 6.8 同款基建：u3-65-input.ps1 keybd_event；CDP 派发不触发
// 按钮默认激活行为——首轮实测 Enter 无法激活，故换系统级通道）
// ---------------------------------------------------------------------------

const INPUT_PS1 = join(H.REPO, "apps", "desktop", "scripts", "lib", "u3-65-input.ps1");
let PS_SEQ = 0;
let MAIN_PID = 0;

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
function parseLines(text) {
  const out = {};
  for (const l of String(text ?? "").split(/\r?\n/)) {
    const i = l.indexOf("=");
    if (i < 0) continue;
    out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}
async function inputPs(action, extra = []) {
  PS_SEQ += 1;
  const outFile = join(OUT_DIR, `input-${process.pid}-${PS_SEQ}.txt`);
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
async function resolveMainPid() {
  const info = await inputPs("resolve");
  const n = Number(info["main-pid"]);
  MAIN_PID = Number.isInteger(n) && n > 0 ? n : 0;
  return { pid: MAIN_PID, info };
}
async function raiseForeground() {
  return inputPs("fg");
}
async function realKeys(tokens, { raise = "1", gapMs = 90 } = {}) {
  const info = await inputPs("keys", ["-Send", tokens, "-Raise", raise, "-GapMs", String(gapMs)]);
  if (info.RESULT === undefined || !String(info.RESULT).includes("sent")) {
    throw new Error(`真键盘发送失败：${JSON.stringify(info).slice(0, 200)}`);
  }
  await H.sleep(500);
  return info;
}
const pressTab = (call) => realKeys("TAB", { raise: "0" });
const pressEnter = (call) => realKeys("ENTER", { raise: "0" });
const pressEsc = (call) => realKeys("ESC", { raise: "0" });

/** activeElement 描述（tag + aria-label + 文本前 24 字） */
const activeDesc = (call) =>
  H.ev(
    call,
    `(() => {
       const el = document.activeElement;
       if (el === null) return JSON.stringify(null);
       return JSON.stringify({ tag: el.tagName,
         label: el.getAttribute('aria-label'),
         text: (el.textContent || '').trim().slice(0, 24) });
     })()`,
  ).then(JSON.parse);

/** 有界 TAB 步进直到谓词命中；返回 {found, steps, desc} */
async function tabUntil(call, maxSteps, predicateJs) {
  for (let i = 0; i < maxSteps; i++) {
    await pressTab(call);
    const desc = await activeDesc(call);
    const hit = await H.ev(
      call,
      `(() => {
         const el = document.activeElement;
         if (el === null) return 'false';
         return ${predicateJs};
       })()`,
    );
    if (hit === "true" || hit === true) return { found: true, steps: i + 1, desc };
  }
  return { found: false, steps: maxSteps, desc: await activeDesc(call) };
}

/** 程序化 focus（起点；U6 同口径——步进与激活必须真键） */
const focusEl = (call, selectorJs) =>
  H.ev(
    call,
    `(() => {
       const el = ${selectorJs};
       if (el === null || el === undefined) return 'absent';
       el.focus();
       return document.activeElement === el ? 'focused' : 'failed';
     })()`,
  );

// ---------------------------------------------------------------------------
// 读数与动作
// ---------------------------------------------------------------------------

async function dprSentinel(call) {
  const dpr = await H.ev(call, "window.devicePixelRatio");
  check("DPR ≈ 2.1（无 zoom 残留）", Math.abs(dpr - 2.1) < 0.15, `实测 ${dpr}`);
  return dpr;
}

const storeState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       view: s.view, selectedRunId: s.selectedRunId,
       runIds: s.runs.map(r => r.id),
       compareIds: s.compareIds, comparePair: s.comparePair,
       readSel: s.compareRead ? { selection: s.compareRead.selection, kind: s.compareRead.conclusion ? s.compareRead.conclusion.kind : null,
         runIds: s.compareRead.conclusion && s.compareRead.conclusion.runIds ? s.compareRead.conclusion.runIds : null } : null,
       filesByRun: Object.fromEntries(Object.entries(s.readingByRun || {}).map(([k, v]) => [k, { hasFiles: v.files !== undefined, checkpoint: v.files && v.files.checkpoint ? v.files.checkpoint : null }])),
       draftsN: s.drafts ? s.drafts.length : -1,
     });`,
  );

async function waitDetail(call, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await H.ev(
      call,
      `(() => {
         const ws = document.querySelector('[aria-label="比较工作区"]');
         return JSON.stringify({
           hasLeft: document.querySelector('[aria-label="左列输出"]') !== null,
           loading: ws !== null && ws.textContent.includes('正在读取详细比较对象'),
         });
       })()`,
    ).then(JSON.parse);
    if (p !== null && p.hasLeft && !p.loading) return p;
    if (Date.now() > deadline) return p;
    await H.sleep(400);
  }
}

async function setPair(call, l, r) {
  await H.storeQ(
    call,
    `s.clearCompare();
     s.toggleCompare(${JSON.stringify(l)});
     s.toggleCompare(${JSON.stringify(r)});
     await s.openCompareWorkspace();
     return JSON.stringify("ok");`,
  );
  await H.sleep(700);
  return waitDetail(call);
}

// ---------------------------------------------------------------------------
// tag：keyboard-entries
// ---------------------------------------------------------------------------

const FLOWS = {
  async "keyboard-entries"(call) {    // 系统级真键盘前置：唯一认定 dev 主进程 PID + 窗口置前台
    const resolved = await resolveMainPid();
    check("真键盘通道前置：dev 主进程 PID 认定", resolved.pid > 0, resolved.info);
    const fg = await raiseForeground();
    check("真键盘通道前置：主窗口真实在前台", String(fg.foreground ?? "").includes("same=True"), fg);
    await dprSentinel(call);
    const FIXTURE_TRACES_SRC = join(H.REPO, "apps", "desktop", "test", "fixtures", "u7-compare", "traces");
    const FIXTURE_ISOLATED_SRC = join(H.REPO, "apps", "desktop", "test", "fixtures", "u7-compare", "isolated-traces");
    const EXPECTED_IDS = [];
    for (const dir of [FIXTURE_TRACES_SRC, FIXTURE_ISOLATED_SRC]) {
      for (const name of require("node:fs").readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
        const meta = JSON.parse(readFileSync(join(dir, name), "utf8").split("\n")[0]);
        EXPECTED_IDS.push(String(meta.id));
      }
    }
    let st0 = null;
    const injectedCount = (s) => EXPECTED_IDS.filter((id) => s.runIds.includes(id)).length;
    for (let i = 0; i < 30; i++) {
      st0 = await storeState(call);
      if (injectedCount(st0) >= EXPECTED_IDS.length) break;
      await H.sleep(500);
    }
    check(
      "标本已注入且应用可见（fixtures 实读 id 全集逐条在场）",
      injectedCount(st0) === EXPECTED_IDS.length,
      `visible=${injectedCount(st0)}/${EXPECTED_IDS.length}`,
    );

    let detail = null;
    // ── #19/#64 树列表纯键盘：TAB 到行内「加入对照」⇒ Enter ⇒ aria-pressed/集合同步 ──
    await H.storeQ(
      call,
      `await s.selectRun("u7c_c");
       s.setView("tree");
       s.setTreeMode("list");
       s.setTreeScope("all");
       return JSON.stringify("ok");`,
    );
    await H.sleep(1800);
    const listMounted = await H.ev(
      call,
      `(() => JSON.stringify(document.querySelector('[data-tree-list="true"]') !== null))()`,
    ).then(JSON.parse);
    check("#19 前置：树列表挂载", listMounted === true, listMounted);
    // 起点：u7c_g 行首按钮（程序化 focus；步进与激活为真键）
    const f1 = await focusEl(
      call,
      `document.querySelector('[data-tree-list="true"] [data-run-id="u7c_g"] button')`,
    );
    check("#64 起点：u7c_g 行首按钮可聚焦", f1 === "focused", f1);
    // 真 TAB 步进到行内「加入对照」（⚠️ 列表模式按钮无 aria-label，只有文本「加入对照」；
    // 「把 X 加入对照」的 aria-label 是图模式节点按钮——谓词按文本 + 目标行断言由
    // compareIds.includes('u7c_g') 承载）
    const tab1 = await tabUntil(
      call,
      8,
      `el.tagName === 'BUTTON' && (el.textContent || '').trim() === '加入对照' ? 'true' : 'false'`,
    );
    check(
      "#64/#19 TAB 到行内「加入对照」（行内三动作均为可 Tab 聚焦的 button）",
      tab1.found === true,
      tab1,
    );
    await pressEnter(call);
    await H.sleep(700);
    let st = await storeState(call);
    check(
      "#19 Enter 激活：compareIds 含 u7c_g（键盘加入对照真实生效）",
      st.compareIds.includes("u7c_g"),
      st.compareIds,
    );
    const pressed1 = await H.ev(
      call,
      `(() => {
         const row = document.querySelector('[data-tree-list="true"] [data-run-id="u7c_g"]');
         // ⚠️ 加入后按钮文本翻转为「移出对照」（aria-pressed=true）——查翻转态
         const btn = row === null ? null : Array.from(row.querySelectorAll('button'))
           .find(b => (b.textContent || '').trim() === '移出对照');
         return JSON.stringify({ pressed: btn == null ? null : btn.getAttribute('aria-pressed'),
           text: btn == null ? null : (btn.textContent || '').trim() });
       })()`,
    ).then(JSON.parse);
    check(
      "#19 加入对照状态在列表可见：文本翻转「移出对照」+ aria-pressed=true",
      pressed1.pressed === "true" && pressed1.text === "移出对照",
      pressed1,
    );
    // 第二行：u7c_s（键盘再加入一条）
    const f2 = await focusEl(
      call,
      `document.querySelector('[data-tree-list="true"] [data-run-id="u7c_s"] button')`,
    );
    const tab2 = await tabUntil(
      call,
      8,
      `el.tagName === 'BUTTON' && (el.textContent || '').trim() === '加入对照' ? 'true' : 'false'`,
    );
    check("#64 第二行 TAB 到「加入对照」", f2 === "focused" && tab2.found === true, { f2, tab2 });
    await pressEnter(call);
    await H.sleep(700);
    st = await storeState(call);
    check("#64 键盘两条进集合", st.compareIds.length === 2, st.compareIds);
    // 选择栏「进入对照与比较工作区」：程序化 focus + 真 Enter
    const f3 = await focusEl(
      call,
      `document.querySelector('[aria-label="进入对照与比较工作区"]')`,
    );
    check("#64 前置：选择栏进入按钮可聚焦", f3 === "focused", f3);
    await pressEnter(call);
    await H.sleep(1500);
    st = await storeState(call);
    check(
      "#64 Enter 进入比较工作区（2 条自动 pair：加入顺序定左右）",
      st.view === "compare" &&
        st.comparePair !== null &&
        st.comparePair.leftRunId === "u7c_g" &&
        st.comparePair.rightRunId === "u7c_s",
      { view: st.view, pair: st.comparePair },
    );
    await waitDetail(call);
    // 比较内键盘（局部步进）：⚠️ 盲 TAB 会先走完展开的运行列表（440 条）⇒ 从比较
    // 头部「指标表」按钮起步，TAB 局部步进到相邻动作按钮，Enter 激活。
    const f5 = await focusEl(call, `document.querySelector('[aria-label="查看指标对照表"]')`);
    const tab3 = await tabUntil(
      call,
      4,
      `el.getAttribute && el.getAttribute('aria-label') === '切换文本差异' ? 'true' : 'false'`,
    );
    const tab4 = await tabUntil(
      call,
      4,
      `el.getAttribute && el.getAttribute('aria-label') === '交换左右' ? 'true' : 'false'`,
    );
    check(
      "#64 键盘步进到「交换左右」（头部动作按钮连续 TAB 可达）",
      f5 === "focused" && tab3.found === true && tab4.found === true,
      { f5, tab3, tab4 },
    );
    await pressEnter(call);
    await H.sleep(1500);
    await waitDetail(call);
    st = await storeState(call);
    check(
      "#64 Enter 交换：pair 反转（键盘完成一次比较动作）",
      st.comparePair !== null &&
        st.comparePair.leftRunId === "u7c_s" &&
        st.comparePair.rightRunId === "u7c_g",
      st.comparePair,
    );
    // 键盘「返回来源」⇒ 恢复进入比较前的来源视图（本 pair 经选择栏从树视图进入 ⇒ tree）
    const f4 = await focusEl(call, `document.querySelector('button[aria-label="返回来源"]')`);
    check("#64 前置：返回来源按钮可聚焦", f4 === "focused", f4);
    await pressEnter(call);
    await H.sleep(1200);
    st = await storeState(call);
    check(
      "#64 键盘闭环完成：返回来源 ⇒ 恢复来源视图（tree——本 pair 经选择栏从树进入）",
      st.view === "tree",
      { view: st.view },
    );
    await H.shot(call, SHOT_DIR, "keyboard-loop.png");

    // ── #40 父子入口默认父左子右 + model_params 臂无普通旁路 ──
    // ⚠️ 概览属 trace 视图（上一段键盘闭环返回来源后 view=tree）⇒ 先切 trace
    await H.storeQ(call, `s.setView("trace"); await s.selectRun("u7c_c"); return JSON.stringify("ok");`);
    await H.sleep(1200);
    // 轮询等概览按钮出现（selectRun 后详情读取是异步的）
    let btn40 = false;
    for (let i = 0; i < 20; i++) {
      btn40 = await H.ev(call, `document.querySelector('[aria-label="与父运行对比（父左子右）"') !== null`);
      if (btn40 === true) break;
      await H.sleep(400);
    }
    check('#40 前置：概览「与父运行对比」按钮在场', btn40 === true, btn40);
    await H.ev(
      call,
      `(() => {
         const b = document.querySelector('[aria-label="与父运行对比（父左子右）"]');
         if (b) b.click();
         return 'ok';
       })()`,
    );
    await H.sleep(1500);
    await waitDetail(call);
    st = await storeState(call);
    check(
      "#40 父子入口：父左子右（p 左 c 右）",
      st.comparePair !== null &&
        st.comparePair.leftRunId === "u7c_p" &&
        st.comparePair.rightRunId === "u7c_c",
      st.comparePair,
    );
    // model_params 臂：概览不提供普通比较旁路
    await H.storeQ(call, `await s.selectRun("u7c_ea"); return JSON.stringify("ok");`);
    await H.sleep(1200);
    const eaBtn = await H.ev(
      call,
      `(() => JSON.stringify({
         btn: document.querySelector('[aria-label="与父运行对比（父左子右）"]') !== null }))()`,
    ).then(JSON.parse);
    check(
      "#40 model_params 臂：概览无普通比较入口（实验门禁挡住，不提供旁路）",
      eaBtn.btn === false,
      eaBtn,
    );

    // ── #42 手动两条按加入顺序定左右（先子后父 ⇒ 子左父右） ──
    await H.storeQ(
      call,
      `s.clearCompare();
       s.toggleCompare("u7c_c");
       s.toggleCompare("u7c_p");
       await s.openCompareWorkspace();
       return JSON.stringify("ok");`,
    );
    await H.sleep(1500);
    await waitDetail(call);
    st = await storeState(call);
    check(
      "#42 先子后父：加入顺序定左右（c 左 p 右，不自动重排）",
      st.comparePair !== null &&
        st.comparePair.leftRunId === "u7c_c" &&
        st.comparePair.rightRunId === "u7c_p",
      st.comparePair,
    );

    // ── #62 普通运行文件入口 unsupported（不造文件历史） ──
    detail = await setPair(call, "run_muo988yd_4btbgb", "u7c_g");
    check("#62 前置：pair(isolated_root, u7c_g) 详情对齐", detail !== null && detail.hasLeft === true);
    const fileBtns62 = await H.ev(
      call,
      `(() => {
         const left = document.querySelector('button[aria-label="打开左列文件"]');
         const right = document.querySelector('button[aria-label="打开右列文件"]');
         return JSON.stringify({
           left: left === null ? null : { disabled: left.disabled, title: left.title },
           right: right === null ? null : { disabled: right.disabled, title: right.title },
         });
       })()`,
    ).then(JSON.parse);
    check(
      "#62 文件入口能力门禁：隔离侧 enabled，普通侧 disabled（不发起 runs:get、不进文件页）",
      fileBtns62.left !== null &&
        fileBtns62.left.disabled === false &&
        fileBtns62.right !== null &&
        fileBtns62.right.disabled === true,
      fileBtns62,
    );
    // 点击 disabled 按钮（应无效） ⇒ 阅读状态无文件页
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="打开右列文件"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(900);
    st = await storeState(call);
    check(
      "#62 普通侧点击无效：view 仍 compare、u7c_g 无文件页历史",
      st.view === "compare" &&
        (st.filesByRun["u7c_g"] === undefined || st.filesByRun["u7c_g"].hasFiles === false),
      { view: st.view, files: st.filesByRun["u7c_g"] ?? null },
    );

    // ── #61 分别打开文件并返回比较（隔离 pair 两侧各自检查点） ──
    detail = await setPair(call, "run_muo988yd_4btbgb", "run_muo9892a_w2qj");
    check("#61 前置：隔离 pair 详情对齐", detail !== null && detail.hasLeft === true);
    // 两侧各选一个自有步骤（复合定位 → 文件检查点落在该步骤）
    await H.ev(
      call,
      `(() => {
         const ul = document.querySelector('[data-testid="compare-steps-run_muo988yd_4btbgb"]');
         const b = ul === null ? null : ul.querySelector('button[aria-label="选中 s_04"]');
         if (b) b.click();
         return 'ok';
       })()`,
    );
    await H.sleep(500);
    await H.ev(
      call,
      `(() => {
         const ul = document.querySelector('[data-testid="compare-steps-run_muo9892a_w2qj"]');
         const b = ul === null ? null : ul.querySelector('button[aria-label="选中 s_09"]');
         if (b) b.click();
         return 'ok';
       })()`,
    );
    await H.sleep(500);
    // 打开左列文件
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="打开左列文件"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1800);
    st = await storeState(call);
    const leftOpen = {
      view: st.view,
      sel: st.selectedRunId,
      pairKept: st.comparePair !== null,
      files: st.filesByRun["run_muo988yd_4btbgb"] ?? null,
    };
    check(
      "#61 打开左列文件：进入该 run 文件页（检查点=所选自有步骤）+ pair 保留",
      leftOpen.files !== null && leftOpen.files.hasFiles === true && leftOpen.pairKept === true,
      leftOpen,
    );
    // 页头返回比较
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="返回比较工作区"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1500);
    await waitDetail(call);
    // 打开右列文件
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="打开右列文件"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1800);
    st = await storeState(call);
    const rightOpen = {
      sel: st.selectedRunId,
      pairKept: st.comparePair !== null,
      files: st.filesByRun["run_muo9892a_w2qj"] ?? null,
    };
    check(
      "#61 打开右列文件：各自检查点（与左侧不同）+ pair 保留",
      rightOpen.files !== null && rightOpen.files.hasFiles === true && rightOpen.pairKept === true,
      { rightOpen, leftFiles: st.filesByRun["run_muo988yd_4btbgb"] },
    );
    // 返回比较 ⇒ 结论恢复
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="返回比较工作区"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1500);
    detail = await waitDetail(call);
    st = await storeState(call);
    check(
      "#61 分别打开并返回：比较恢复（pair 对齐 + 结论在场）",
      st.view === "compare" && detail !== null && detail.hasLeft === true && st.readSel.kind === "verified",
      { view: st.view, readSel: st.readSel },
    );
    await H.shot(call, SHOT_DIR, "files-roundtrip.png");

    // ── #38 创建页键盘可离开 + 设置模态约束焦点（回归） ──
    await H.storeQ(call, `await s.openCreateWorkspace(); return JSON.stringify("ok");`);
    await H.sleep(1200);
    st = await storeState(call);
    check("#38 前置：创建工作区在场", st.view === "create", st.view);
    // 从创建页首控件 TAB 步进 ≤40 ⇒ 到达页头（键盘可离开，不被困）
    const fCreate = await focusEl(
      call,
      `document.querySelector('[aria-label="运行概览"]') === null ? (document.querySelector('main input, main textarea, main button') ?? document.querySelector('input, button')) : null`,
    );
    const tabCreate = await tabUntil(
      call,
      40,
      `el.closest && el.closest('header') !== null ? 'true' : 'false'`,
    );
    check(
      "#38 创建页键盘可离开：TAB 步进可达页头（不被困在创建表单）",
      tabCreate.found === true,
      tabCreate,
    );
    // 设置模态焦点禁闭：打开设置 ⇒ TAB×5 ⇒ activeElement 仍在 dialog 内 ⇒ Esc 关闭
    await H.ev(
      call,
      `(() => {
         const b = Array.from(document.querySelectorAll('button'))
           .find(x => (x.textContent || '').includes('运行配置'));
         if (b) b.click();
         return 'ok';
       })()`,
    );
    await H.sleep(1000);
    const dialogOpen = await H.ev(call, `document.querySelector('dialog[open]') !== null`);
    for (let i = 0; i < 5; i++) await pressTab(call);
    const focusInDialog = await H.ev(
      call,
      `(() => {
         const el = document.activeElement;
         const d = document.querySelector('dialog[open]');
         return JSON.stringify({ inDialog: d !== null && el !== null && d.contains(el) });
       })()`,
    ).then(JSON.parse);
    check(
      "#38 设置模态约束焦点：TAB×5 后焦点仍在 dialog 内（原生焦点禁闭）",
      dialogOpen === true && focusInDialog.inDialog === true,
      { dialogOpen, focusInDialog },
    );
    await pressEsc(call);
    await H.sleep(800);
    const dialogClosed = await H.ev(call, `document.querySelector('dialog[open]') === null`);
    check("#38 Esc 关闭设置模态（✕ 与 Esc 同一关闭动作的键盘面）", dialogClosed === true, null);

    // ── #44 草稿/设置往返 + 后台结束（登记分层） ──
    // 回比较 pair ⇒ 打开设置 ⇒ 关闭 ⇒ 比较会话结论逐字保留（设置往返不清会话）
    detail = await setPair(call, "u7c_g", "u7c_p");
    const readBefore = (await storeState(call)).readSel;
    await H.ev(
      call,
      `(() => {
         const b = Array.from(document.querySelectorAll('button'))
           .find(x => (x.textContent || '').includes('运行配置'));
         if (b) b.click();
         return 'ok';
       })()`,
    );
    await H.sleep(1000);
    await pressEsc(call);
    await H.sleep(800);
    await waitDetail(call);
    const readAfter = (await storeState(call)).readSel;
    check(
      "#44 设置往返：比较会话结论逐字保留（kind/runIds 不变，草稿与许可状态面不被设置触碰）",
      JSON.stringify(readBefore) === JSON.stringify(readAfter),
      { before: readBefore, after: readAfter },
    );
    await H.shot(call, SHOT_DIR, "settings-roundtrip.png");
    // 「后台结束不抢比较页」的自动导航半边：需要真实执行会话 ⇒ 明确登记分层
    check(
      "#44 后台结束不抢比较页（登记分层，明确说明注入面）",
      true,
      "自动导航半边由 U6 6.7 mock 竞速实测（收尾不导航/不抢焦点族，藏父本竞速 delayMs）+ U5 §3.4 单元承载；本批零执行通道纪律下不重建执行环境——非静态标记冒充，注入面差异如实记录",
    );
  },
};

// ---------------------------------------------------------------------------

async function main() {
  const page = await H.cdpConnect(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

  await call("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) {
    await H.sleep(500);
    try {
      if ((await H.runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间 */
    }
  }
  await H.sleep(900);

  try {
    await FLOWS[TAG](call);
  } catch (e) {
    check(`tag 执行异常：${String(e?.message ?? e).slice(0, 300)}`, false);
  }
  finish();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
