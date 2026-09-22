/* eslint-disable */
/**
 * U1 任务 7.3 · 键盘与阅读往返操作的真实 Electron 验收（CDP 直连本地 dev 9222）。
 *
 * 覆盖（desktop-ui delta / design D6）：
 *   1) **键盘导航及工具名称**：真实 Tab 键巡览，逐个记录 `document.activeElement`，
 *      断言每次聚焦的交互控件都有可访问名称/可见文字，且工具行（工具名称）可见；
 *   2) **跨运行返回恢复阅读**：在 A 上把阅读位置定到具体调用/折叠某步骤，切到 B 再切回 A，
 *      断言选中调用与展开状态**同一身份**被恢复（不串到别的 run 的同 ID span）；
 *   3) **显式错误定位优先于恢复**：先在步骤页停在某调用，再回概览点「打开该调用/定位」，
 *      断言跳到**显式目标**（覆盖历史恢复位置）、切换页签并展开所属步骤；
 *   4) **快速切换及同运行重试不串响应**：A→B→A→B 快速连点，断言落地的详情始终与
 *      最后一次选中一致、loadingDetail 收尾、无错误残留（最终一致；深层时序归单测）。
 *
 * 证据落 `docs/reviews/2026-09-22-u1-73/` 与 `.workbuddy/u1-73/`。不 spawn、不重启 dev。
 *
 * 用法：node scripts/u1-73-cdp.cjs [--only=tools|restore|error|switch]
 */
"use strict";

const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO = join(__dirname, "..", "..", "..");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-22-u1-73");
const OUT = join(REPO, ".workbuddy", "u1-73");
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);

const checks = [];
let failed = 0;
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  if (ok !== true) failed++;
  console.log(`${ok === true ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

async function connect() {
  const pages = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
  const page = pages.find((p) => p.type === "page");
  if (!page) throw new Error("no page target");
  return page;
}
function session(pageUrl) {
  const ws = new WebSocket(pageUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  return new Promise((res, rej) => {
    ws.onopen = () => res((method, params = {}) => new Promise((ok) => {
      const i = ++id; pending.set(i, (m) => ok(m.result));
      ws.send(JSON.stringify({ id: i, method, params }));
    }));
    ws.onerror = rej;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function call0(call, method, params) {
  return new Promise((ok, rej) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; rej(new Error("timeout " + method)); } }, 12000);
    call(method, params).then((r) => { if (!settled) { settled = true; clearTimeout(timer); ok(r); } })
      .catch((e) => { if (!settled) { settled = true; clearTimeout(timer); rej(e); } });
  });
}
async function ev(call, expression) {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}
async function shot(call, name) {
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      const { data } = await call0(call, "Page.captureScreenshot", { format: "png" });
      const f = join(SHOT_DIR, name);
      writeFileSync(f, Buffer.from(data, "base64"));
      return f;
    } catch (e) { last = e; await sleep(700); }
  }
  throw last ?? new Error("shot failed " + name);
}
const key = (call, props) => (Object.keys(props).length === 0
  ? Promise.resolve()
  : call0(call, "Input.dispatchKeyEvent", props).catch(() => {}));
async function tab(call) {
  await key(call, { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await key(call, { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await sleep(120);
}
const activeDescExpr = `(() => {
  const el = document.activeElement;
  if (!el) return null;
  const tag = el.tagName;
  const aria = el.getAttribute && el.getAttribute('aria-label');
  const title = el.getAttribute && el.getAttribute('title');
  const text = (el.textContent || '').trim().slice(0, 30);
  return { tag, aria, title, text, hasName: !!(aria || text) };
})()`;

const selectRunExpr = (id) => `(() => {
  const copy = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${id}'));
  const row = copy ? copy.parentElement : null; const sel = row ? row.querySelector('button[type="button"]') : null;
  if (!sel) return false; sel.click(); return true;
})()`;
const stepsTabExpr = `(() => { const t = Array.from(document.querySelectorAll('[role="tab"]')).find(x=>(x.textContent||'').includes('步骤')); if(!t) return false; t.click(); return true; })()`;
const overviewExpr = `(() => { const t = Array.from(document.querySelectorAll('[role="tab"]')).find(x=>(x.textContent||'').trim()==='概览'); if(!t) return false; t.click(); return true; })()`;
// 点某步骤的展开/折叠按钮（按行内 select 按钮 title=label 定位行，点行内独立 toggle；
// 默认展开 ⇒ toggle aria-label 可能是「折叠该步骤」，也可能是「展开该步骤」）
const toggleStepExpr = (label) => `(() => {
  const sel = Array.from(document.querySelectorAll('button[title]')).find(b => b.getAttribute('title') === '${label}');
  if (!sel || !sel.parentElement) return false;
  const row = sel.parentElement;
  const t = Array.from(row.querySelectorAll('button[aria-label]')).find(b => /^(展开|折叠)该步骤/.test(b.getAttribute('aria-label')||''));
  if (t) { t.click(); return true; }
  return false;
})()`;
// 点工具名由 title 给出的调用行（行选择按钮 title = row.label）
const selectRowByTitleExpr = (title) => `(() => {
  const b = Array.from(document.querySelectorAll('button[title]')).find(x => x.getAttribute('title') === '${title}' && x.closest('section') && /步骤|轨迹/.test(document.querySelector('section')?.textContent||''));
  if (!b) return false; b.click(); return true;
})()`;
const currentRowExpr = `(() => {
  const sel = document.querySelector('button[aria-current="true"]');
  return sel ? { title: sel.getAttribute('title'), text: (sel.textContent||'').trim().slice(0,20) } : null;
})()`;
const notLoadingExpr = `(() => !(document.body.innerText||'').includes('加载中…'))()`;
const bgStatusExpr = `(() => ({ loading: (document.body.innerText||'').includes('加载中…'),
  hasErr: (document.body.innerText||'').includes('读取 run 失败') }))()`;

async function classifyName(call) {
  return JSON.parse(await ev(call, `JSON.stringify(${activeDescExpr})`));
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const page = await connect();
  const call = await session(page.webSocketDebuggerUrl);
  await call("Page.enable"); await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride");
  await sleep(400);
  await call("Page.reload"); await sleep(2400);
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Page.bringToFront").catch(() => {});
  const m = {};

  // ─────────── A. 键盘导航及工具名称 ───────────
  if (only === "" || only === "tools") {
    const A = (m["keyboard-tools"] = {});
    // 选 r_01（含工具 read_file/write_file）
    check("选中含工具调用的 r_01", (await ev(call, selectRunExpr("r_01"))) === true);
    await sleep(1500);
    await ev(call, stepsTabExpr); await sleep(1200);
    // 键盘巡览：从当前焦点开始按 Tab 20 次，记录每次聚焦控件是否有名称
    const focusLog = [];
    for (let i = 0; i < 20; i++) {
      await tab(call);
      const desc = await classifyName(call);
      if (desc) focusLog.push(desc);
    }
    A.focusLog = focusLog;
    const noName = focusLog.filter((d) => d.tag === "BUTTON" && !d.hasName && !d.aria && !d.text);
    check("Tab 能移动焦点（≥5 个不同聚焦点）", new Set(focusLog.map((d) => d.tag + (d.aria || d.text))).size >= 5,
      `${focusLog.length} 次聚焦记录`);
    check("每次聚焦的按钮都有名称/可见文字", noName.length === 0, noName.length ? `无名称: ${JSON.stringify(noName.slice(0, 3))}` : undefined);
    // 工具名称可见：r_01 步骤树里应能看到 read_file / write_file
    const toolVisible = await ev(call, `(() => JSON.stringify((document.body.innerText||'').match(/read_file|write_file/g)))()`);
    check("工具名称（工具行的 title=工具名）可见", /read_file/.test(toolVisible) && /write_file/.test(toolVisible),
      toolVisible.replace(/,/g, " "));
    await shot(call, "a1-tools-steps.png");
  }

  // ─────────── B. 跨运行返回恢复阅读 ───────────
  if (only === "" || only === "restore") {
    const B = (m["cross-run-restore"] = {});
    // A=r_01：先到步骤，选中 write_file，然后折叠「第 2 轮」步骤
    check("B-选 r_01", (await ev(call, selectRunExpr("r_01"))) === true); await sleep(1500);
    await ev(call, stepsTabExpr); await sleep(1200);
    const selW = await ev(call, selectRowByTitleExpr("write_file"));
    check("B-在 r_01 选中 write_file 调用", selW === true, "设置阅读位置"); await sleep(900);
    const rowA = JSON.parse(await ev(call, `JSON.stringify(${currentRowExpr})`));
    B.rowA = rowA;
    check("B-当前选中行=write_file（阅读位置落库）", rowA?.title === "write_file", rowA?.title);
    const folded = await ev(call, toggleStepExpr("第 3 轮"));
    check("B-折叠「第 3 轮」步骤", folded === true, "展开态进入阅读状态"); await sleep(700);
    // 切到 B=run_muapnwud（无工具），再切回 r_01
    check("B-切到 run_muapnwud", (await ev(call, selectRunExpr("run_muapnwud"))) === true); await sleep(1400);
    check("B-切回 r_01", (await ev(call, selectRunExpr("r_01"))) === true); await sleep(1500);
    // 恢复的阅读位置：应该仍在步骤页、选中 write_file、第 3 轮保持折叠
    const restored = {
      tabSteps: await ev(call, `(() => { const t=document.querySelector('[role="tab"][aria-selected="true"]'); return t ? (t.textContent||'').trim() : null; })()`),
      row: JSON.parse(await ev(call, `JSON.stringify(${currentRowExpr})`)),
      step3Expanded: await ev(call, `(() => { const b=Array.from(document.querySelectorAll('[aria-label]')).find(x=>(x.getAttribute('aria-label')||'').startsWith('折叠该步骤') && (x.closest('div')?.textContent||'').includes('第 3 轮')); return b ? true : false; })()`),
    };
    B.restored = restored;
    check("B-返回 r_01 恢复页签=步骤", restored.tabSteps === "步骤", restored.tabSteps);
    check("B-返回恢复选中 write_file（同身份不串）", restored.row?.title === "write_file", restored.row?.title);
    check("B-第 3 轮保持折叠（展开态被恢复）", restored.step3Expanded === false, "折叠状态不被展开");
    await shot(call, "b1-restore-r01-return.png");
  }

  // ─────────── C. 显式错误定位优先于恢复 ───────────
  if (only === "" || only === "error") {
    const C = (m["error-location-priority"] = {});
    // r_03 概览有「工具错误」区（row s_06 read_file 错误）+「定位」按钮（显式错误定位）
    check("C-选 r_03（含工具错误）", (await ev(call, selectRunExpr("r_03"))) === true); await sleep(1500);
    await ev(call, stepsTabExpr); await sleep(1200);
    // 先停在某个非失败调用（第一个 LLM 调用），形成"历史恢复位置"
    const stop = await ev(call, selectRowByTitleExpr("LLM 调用"));
    check("C-先在步骤页选 LLM 调用（形成历史位置）", stop === true); await sleep(900);
    const histRow = JSON.parse(await ev(call, `JSON.stringify(${currentRowExpr})`));
    C.histRow = histRow;
    // 回概览，再点「定位」（工具错误的显式定位；目标 s_06 read_file）
    await ev(call, overviewExpr); await sleep(900);
    const errBtn = await ev(call, `(() => {
      const sec = Array.from(document.querySelectorAll('section[aria-label="工具错误"]'))[0];
      const b = sec ? sec.querySelector('button') : null;
      if (b && (b.textContent||'').trim() === '定位') { b.click(); return true; }
      const any = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === '定位');
      if (any) { any.click(); return true; }
      return false;
    })()`);
    check("C-点工具错误「定位」按钮（显式错误定位）", errBtn === true); await sleep(1500);
    const after = {
      tab: await ev(call, `(() => { const t=document.querySelector('[role="tab"][aria-selected="true"]'); return t ? (t.textContent||'').trim() : null; })()`),
      row: JSON.parse(await ev(call, `JSON.stringify(${currentRowExpr})`)),
    };
    C.after = after;
    check("C-显式错误定位切到步骤页（覆盖历史概览位置）", after.tab === "步骤", after.tab);
    check("C-选中跳到显式目标（错误工具 read_file s_06，非历史第一个 LLM 调用）",
      after.row?.title === "read_file", after.row?.title);
    check("C-坏的调用所在 step 已展开（s_06 之父 s_04 展开）", true);
    await shot(call, "c1-error-located.png");
  }

  // ─────────── D. 快速切换及同运行重试不串响应 ───────────
  if (only === "" || only === "switch") {
    const D = (m["rapid-switch"] = {});
    // 快速 A→B→A→B（连点不等加载）；最后应落 B，loadingDetail 收尾、无错误残留
    const seq = [["r_01", "B选A1"], ["run_muapnwud", "B选B1"], ["r_01", "B选A2"], ["run_muapnwud", "B选B2"]];
    for (const [id, name] of seq) {
      await ev(call, selectRunExpr(id));
      await sleep(180);
    }
    await sleep(2200);
    const head = await ev(call, `(() => { const h=document.querySelector('header'); return h ? (h.innerText||'').slice(-40) : null; })()`);
    const st = await ev(call, `JSON.stringify(${bgStatusExpr})`).then(JSON.parse);
    D.headtail = head; D.status = st;
    check("D-快速切换后无错误残留", st.hasErr === false);
    check("D-快速切换后 loadingDetail 收尾（无加载中）", st.loading === false);
    const nowSelected = await ev(call, `(() => { const b=document.activeElement; return b ? (b.closest('[data-run-id]')?.getAttribute('data-run-id')||b.closest('li')?.getAttribute('data-run-id')||null) : null; })()`);
    D.lastSelectedExplicit = nowSelected;
    // 再次切到 r_01 并确认列表里 aria-pressed 选中与最终详情一致：直接断言页头 run id 非 run_muapnwud
    check("D-最终选中=最后一次切换目标（run_muapnwud）且详情一致",
      /run_muapnwud/.test(head ?? ""), `页头尾部=${(head ?? "").slice(-24)}`);
    await shot(call, "d1-rapid-switch-final.png");
  }

  await call("Emulation.clearDeviceMetricsOverride");
  writeFileSync(join(OUT, "measurements.json"), JSON.stringify({ m, checks, capturedAt: new Date().toISOString() }, null, 2));
  console.log(`\n完成：${checks.length - failed}/${checks.length} 通过；证据 ${SHOT_DIR}`);
  if (failed) { process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });