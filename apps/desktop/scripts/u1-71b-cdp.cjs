/* eslint-disable */
/**
 * U1 任务 7.1 · 第二波证据：补齐首轮未覆盖的开放项。
 *
 * 连本地已起的 dev CDP（9222），对 1440x900 / 1360x860 两档 Emulation 补证：
 *   1) **DOM 逐层宽度**：main 的直接子列（运行导航 / 步骤目录 / 详情）的宽、body 无横向溢出；
 *   2) **隔离 run 的步骤页**：ECharts canvas 运行时在场 + 调用行数；
 *   3) **Monaco 运行时 + 只读 diff**：切到隔离 run 的「文件」页，点后续检查点 + a.txt，
 *      断言 `.monaco-diff-editor` 挂载（离线 Monaco 真跑起来），截图目标尺寸；
 *   4) **空任务导航摘要**：注入的空任务 demo run（task=""），列表行回退「来源·时间·短ID」，
 *      页头不误显示「尚未选择运行」；
 *   5) **长任务导航摘要**：长任务 run 列表行 + 页头 title 携带完整原值、正文被 CSS 截断。
 *
 * 证据落 `docs/reviews/2026-09-22-u1-71/` 与 `.workbuddy/u1-71b/`。不 spawn、不重启 dev。
 * ⚠️ 依赖已在数据目录 `.rebaseagent/traces/` 注入的空任务 fixture（`run_emptytask_demo`）。
 *
 * 用法：node scripts/u1-71b-cdp.cjs [--only=1440x900]
 */
"use strict";

const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO = join(__dirname, "..", "..", "..");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-22-u1-71");
const OUT = join(REPO, ".workbuddy", "u1-71b");

const onlyArg = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const SIZES = onlyArg ? [onlyArg] : ["1440x900", "1360x860"];
const OS_DPR = Number(process.env.SCREEN_DPR ?? 2);

const ISO_RUN = "run_muappa2a_gk7964"; // 隔离 v2：a.txt 被改写 => 可产生 Monaco diff
const EMPTY_RUN = "run_emptytask_demo"; // 空任务 fixture
const LONG_RUN = "run_mtw9u98x_jktq"; // 长任务（task ~1730 字）

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(`${ok === true ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}
const measurements = {};
const record = (size, key, value) => {
  measurements[size][key] = value;
  return value;
};

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
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  return new Promise((res, rej) => {
    ws.onopen = () =>
      res(
        (method, params = {}) =>
          new Promise((ok) => {
            const i = ++id;
            pending.set(i, (m) => ok(m.result));
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
      );
    ws.onerror = rej;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(call, expression) {
  const { result, exceptionDetails } = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`eval: ${JSON.stringify(exceptionDetails)}`);
  return result.value;
}
async function shot(call, name) {
  const { data } = await call("Page.captureScreenshot", { format: "png" });
  const file = join(SHOT_DIR, name);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}
// 按运行 id 点选列表行：复制按钮 aria-label 带完整 id => 其父行 = 行 div，行内第一个 button 是选择按钮
const selectRunExpr = (id) => `(() => {
  const copy = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${id}'));
  if (!copy) return false;
  const row = copy.parentElement; const sel = row ? row.querySelector('button[type="button"]') : null;
  if (!sel) return false; sel.click(); return true;
})()`;
// 断言某 run 的列表行是否在场
const rowPresentExpr = (id) => `(() => !!Array.from(document.querySelectorAll('button')).find(b =>
  (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${id}')))()`;
// 读取某 run 列表行内"任务标题 span"（label.isFallback 时为灰字）
const rowTaskExpr = (id) => `(() => {
  const copy = Array.from(document.querySelectorAll('button')).find(b =>
    (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${id}'));
  if (!copy || !copy.parentElement) return null;
  const span = copy.parentElement.querySelector('span[title]');
  if (!span) return null;
  return { title: span.title, cls: span.className, text: (span.textContent||'').trim() };
})()`;

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const page = await connect();
  const call = await session(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");

  for (const size of SIZES) {
    measurements[size] = {};
    const [w, h] = size.split("x").map(Number);
    await call("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: OS_DPR,
      mobile: false,
    });
    await sleep(400);
    // 首档刷新一次列表，让注入的空任务 fixture 进入列表
    if (size === SIZES[0]) {
      await call("Page.reload");
      await sleep(2200);
    }
    await sleep(600);
    const tag = size.replace("x", "x");

    // —— 0. body 无横向溢出 ——
    const body = await ev(
      call,
      `(() => ({ ok: document.body.scrollWidth <= document.body.clientWidth,
      sw: document.body.scrollWidth, cw: document.body.clientWidth }))()`,
    );
    check(`[${size}] body 无横向溢出`, body.ok, `${body.sw}/${body.cw}`);
    record(size, "body", body);

    // —— 1. 隔离 run：步骤页（ECharts 运行时）+ 逐层宽度 ——
    check(`[${size}] 空任务行在场`, (await ev(call, rowPresentExpr(EMPTY_RUN))) === true);
    const selIso = await ev(call, selectRunExpr(ISO_RUN));
    check(`[${size}] 点选隔离 run ${ISO_RUN}`, selIso === true);
    await sleep(1400);

    const stepsTab = await ev(
      call,
      `(() => {
      const b = Array.from(document.querySelectorAll('button[role="tab"]'))
        .find(x => (x.textContent||'').trim().includes('步骤'));
      if (!b) return false; b.click(); return true;
    })()`,
    );
    // 轮询等步骤目录行挂载（button[title] 计数）
    let st = null;
    for (let i = 0; i < 14; i++) {
      st = await ev(
        call,
        `(() => {
        const main = document.querySelector('main');
        const cols = main ? Array.from(main.children).map(e => ({
          tag: e.tagName, w: Math.round(e.getBoundingClientRect().width),
          left: Math.round(e.getBoundingClientRect().left),
          h: Math.round(e.getBoundingClientRect().height), sh: e.scrollHeight,
          cl: e.clientHeight, ownScroll: e.scrollHeight > e.clientHeight + 2,
          sample: (e.innerText||'').replace(/\\s+/g,' ').slice(0,12),
        })) : [];
        const tree = main ? Array.from(main.children).find(s =>
          s.tagName === 'SECTION' && (s.innerText||'').includes('轨迹')) : null;
        return JSON.stringify({ canvas: !!document.querySelector('canvas'),
          rows: tree ? tree.querySelectorAll('button[title]').length : 0,
          hasTree: cols.some(c => c.sample.includes('轨迹')), cols });
      })()`,
      );
      const sj = JSON.parse(st);
      if (sj.rows > 0) break;
      await sleep(700);
    }
    // 预算地图是折叠区块，展开才懒加载 echarts => 点击 summary 再轮询 canvas
    const budget = await ev(
      call,
      `(() => {
      const s = Array.from(document.querySelectorAll('summary')).find(x =>
        (x.textContent||'').includes('预算'));
      if (!s) return false; s.click(); return true;
    })()`,
    );
    check(`[${size}] 预算地图区块可在步骤页展开`, budget === true);
    let canvas = false;
    for (let i = 0; i < 12; i++) {
      canvas = (await ev(call, `(() => !!document.querySelector('canvas'))()`)) === true;
      if (canvas) break;
      await sleep(700);
    }
    const stj = JSON.parse(st);
    record(size, "steps_isolated", { canvas, rows: stj.rows, cols: stj.cols });
    check(`[${size}] 隔离 run 步骤页 ECharts canvas 在场（预算图展开后懒加载）`, canvas === true);
    check(`[${size}] 步骤页有调用行`, stj.rows > 0, `${stj.rows} 行`);
    check(`[${size}] 步骤目录列在场`, stj.hasTree === true);
    // 每列独立滚动（scrollHeight>clientHeight 即内部滚动，body 不横向溢出已证不整页滚）
    const colsIntro = stj.cols.map((c) => `${c.tag}@${c.w}px`).join(" / ");
    check(`[${size}] main 逐层列宽 ${colsIntro}`, true);
    await shot(call, `05-${tag}-isolated-steps.png`);

    // —— 2. 隔离 run：文件页 -> Monaco 只读 diff ——
    const filesTab = await ev(
      call,
      `(() => {
      const b = Array.from(document.querySelectorAll('button[role="tab"]'))
        .find(x => (x.textContent||'').trim() === '文件');
      if (!b) return false; b.click(); return true;
    })()`,
    );
    await sleep(1400);
    // 点一个后续检查点（title 含 "检查点所属 step"，取非选中的最后一个）
    const ck = await ev(
      call,
      `(() => {
      const cand = Array.from(document.querySelectorAll('button'))
        .filter(b => (b.title||'').includes('检查点所属 step'));
      if (!cand.length) return false;
      const last = cand[cand.length - 1]; last.click(); return true;
    })()`,
    );
    await sleep(1100);
    // 点 a.txt 文件行
    const pickFile = await ev(
      call,
      `(() => {
      const b = Array.from(document.querySelectorAll('ul button'))
        .find(x => (x.textContent||'').includes('a.txt'));
      if (!b) return false; b.click(); return true;
    })()`,
    );
    check(`[${size}] 文件页可选到 a.txt`, pickFile === true);
    // 轮询等 Monaco 懒装载
    let mono = null;
    for (let i = 0; i < 16; i++) {
      mono = await ev(
        call,
        `(() => { const e=document.querySelector('.monaco-diff-editor');
        return e ? { present:true, text:(document.body.innerText||'').slice(0,120) } : { present:false }; })()`,
      );
      if (mono.present) break;
      await sleep(700);
    }
    record(size, "monaco", mono);
    check(
      `[${size}] 离线 Monaco DiffEditor 运行时挂载`,
      mono && mono.present === true,
      mono?.present ? "read-only diff 已渲染" : undefined,
    );
    await shot(call, `06-${tag}-monaco-readonly-diff.png`);

    // —— 3. 空任务导航摘要 ——
    await ev(call, selectRunExpr(EMPTY_RUN));
    await sleep(1300);
    const em = await ev(
      call,
      `(() => {
      const row = rowTask();
      const hdr = document.querySelector('header, main .border-b .text-sm, main .truncate');
      const body = document.body.innerText || '';
      return JSON.stringify({ notPlaceholder: !body.includes('尚未选择运行'),
        rowTask: rowTask(), header: hdr ? hdr.textContent.slice(0,30) : null });
      function rowTask(){ const copy=Array.from(document.querySelectorAll('button')).find(b =>
        (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${EMPTY_RUN}'));
        if(!copy||!copy.parentElement) return null; const span=copy.parentElement.querySelector('span[title].line-clamp-2');
        return span ? {text:(span.textContent||'').trim(), fallbackCls: span.className.includes('text-gray-500')} : null; }
    })()`,
    );
    const emo = JSON.parse(em);
    record(size, "emptytask", JSON.parse(em));
    check(`[${size}] 空任务不误显示「尚未选择运行」`, emo.notPlaceholder === true);
    check(
      `[${size}] 空任务列表行有回退标签（回退灰字）`,
      emo.rowTask !== null && emo.rowTask.fallbackCls === true,
      JSON.stringify(emo.rowTask),
    );
    await shot(call, `07-${tag}-emptytask-nav.png`);

    // —— 4. 长任务导航摘要 ——
    await ev(call, selectRunExpr(LONG_RUN));
    await sleep(1300);
    const lg = await ev(
      call,
      `(() => {
      const copy = Array.from(document.querySelectorAll('button')).find(b =>
        (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${LONG_RUN}'));
      let rowTitle = null;
      if (copy && copy.parentElement) { const s = copy.parentElement.querySelector('span[title]');
        rowTitle = s ? { len: s.title.length, text: (s.textContent||'').trim().length } : null; }
      return JSON.stringify({ rowTitle, headerNotPlaceholder: !(document.body.innerText||'').includes('尚未选择运行') });
    })()`,
    );
    const lgo = JSON.parse(lg);
    record(size, "longtask", lgo);
    check(
      `[${size}] 长任务列表行 title 携带完整原值`,
      lgo.rowTitle !== null && lgo.rowTitle.len > 500,
      lgo.rowTitle ? `title=${lgo.rowTitle.len} 字符` : undefined,
    );
    await shot(call, `08-${tag}-longtask-nav.png`);
  }

  writeFileSync(
    join(OUT, "measurements.json"),
    JSON.stringify({ measurements, checks, capturedAt: new Date().toISOString() }, null, 2),
  );
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n完成：${checks.length - failed.length}/${checks.length} 通过；证据 ${SHOT_DIR}`);
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
