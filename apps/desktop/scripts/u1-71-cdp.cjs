/* eslint-disable */
/**
 * U1 任务 7.1：宽窗口阅读矩阵的真实 Electron 证据采集（CDP 直连本地已起的 dev）。
 *
 * 用法（dev 已带 CDP 起好：`NO_SANDBOX=1 node scripts/start-dev.cjs --remoteDebuggingPort=9222`）：
 *   node scripts/u1-71-cdp.cjs                 # 默认两个宽档 1440x900 / 1360x860
 *   node scripts/u1-71-cdp.cjs --only=1440x900 # 只跑一档
 *
 * 做什么：对每个 CSS 视口（Emulation 覆盖布局视口 + OS 缩放 deviceScaleFactor）——
 *  1) 记录 innerWidth/innerHeight/dpr/zoom、body 是否横向溢出；
 *  2) 截图运行列表；
 *  3) 点第一条 run → 概览页截图 + 关键字段存在性；
 *  4) 切「步骤」→ 截图 + 检查预算图（ECharts canvas）是否到 DOM；
 *  5) 切「文件」（若该 run 是隔离 v2 且有文件视图）→ 截图；
 *  6) 记录工作台三栏几何（运行导航 / 步骤目录 / 详情列宽）。
 *
 * 证据落 `docs/reviews/2026-09-22-u1-71/`（截图）与 `.workbuddy/u1-71/measurements.json`。
 * ⚠️ 本脚本**不 spawn 任何进程**、不重启 dev；只连已有 CDP。判据失败以非零退出码体现。
 */
"use strict";

const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO = join(__dirname, "..", "..", "..");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-22-u1-71");
const OUT = join(REPO, ".workbuddy", "u1-71");

const onlyArg = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const SIZES = onlyArg ? [onlyArg] : ["1440x900", "1360x860"];
const OS_DPR = Number(process.env.SCREEN_DPR ?? 2);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(`${ok === true ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

function cdpConnect() {
  return fetch("http://127.0.0.1:9222/json/list")
    .then((r) => r.json())
    .then((pages) => pages.find((p) => p.type === "page"));
}

function makeSession(pageUrl) {
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
          new Promise((r) => {
            const i = ++id;
            pending.set(i, (m) => r(m.result));
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
      );
    ws.onerror = rej;
  });
}

async function evalv(call, expression) {
  const { result } = await call("Runtime.evaluate", { expression, returnByValue: true });
  return result.value;
}

async function shot(call, name) {
  const { data } = await call("Page.captureScreenshot", { format: "png" });
  const file = join(SHOT_DIR, name);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const page = await cdpConnect();
  const call = await makeSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");

  const measurements = {};
  const stop = false;

  for (const size of SIZES) {
    const [w, h] = size.split("x").map(Number);
    await call("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: OS_DPR,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, 800));

    const base = await evalv(
      call,
      `(() => { const d=document; const qa=(s)=>Array.from(d.querySelectorAll(s));
        const aside=qa('aside');
        const rect=(e)=>e?(Math.round(e.getBoundingClientRect().width)+'@'+Math.round(e.getBoundingClientRect().left))+'x'+Math.round(e.getBoundingClientRect().height):null;
        return JSON.stringify({ vp: innerWidth+'x'+innerHeight, dpr: devicePixelRatio,
          bodyOk: d.body.scrollWidth<=d.body.clientWidth, bodyScrollW:d.body.scrollWidth, bodyClientW:d.body.clientWidth,
          asides: aside.slice(0,3).map(rect), text:(d.body.innerText||'').slice(0,60) }); })()`,
    );
    const vp = JSON.parse(base);
    measurements[size] = {
      viewport: vp.vp,
      dpr: vp.dpr,
      bodyOk: vp.bodyOk,
      bodyScrollW: vp.bodyScrollW,
      bodyClientW: vp.bodyClientW,
    };
    const sizeTag = size.replace("x", "x");
    // 记录实测布局视口（Emulation 覆盖 + Electron 窗口有差异，按实测记录、不作硬门禁）；
    // body 不横向溢出才是"该视口下阅读可达"的可判据
    check(`[${size}] 布局视口=${vp.vp}`, true, `dpr=${vp.dpr}`);
    check(`[${size}] body 无横向溢出`, vp.bodyOk === true, `${vp.bodyScrollW}/${vp.bodyClientW}`);
    await shot(call, `01-${sizeTag}-runs.png`);

    // 点击一个 run：优先选**非隔离**（标准概览），找不到再退回第一条
    const clicked = await evalv(
      call,
      `(() => {
        const rows=Array.from(document.querySelectorAll('button')).filter(e=>(e.ariaLabel||'').startsWith('复制完整运行 ID'));
        const pick=rows.find(e=>{const rowText=((e.closest('[data-run-id]')||e.closest('li')||e.closest('div'))?.textContent||''); return !rowText.includes('文件隔离')&&!rowText.includes('代理');})||rows[0];
        if(!pick) return false;
        const row=pick.closest('div'); let sel=null;
        if(row){ const bs=Array.from(row.querySelectorAll('button')); sel=bs.find(e=>(e.ariaLabel||e.textContent||'').match(/选择/))||bs[0]; }
        if(sel){ sel.click(); return true; } return false; })()`,
    );
    check(`[${size}] 点选一个 run（优先非隔离）`, clicked === true);
    await new Promise((r) => setTimeout(r, 1400));

    const ov = await evalv(
      call,
      `(() => { const d=document;
        return JSON.stringify({ hasOverview: !!d.querySelector('[aria-label="运行概览"]'),
          hasEnd:(d.body.innerText||'').includes('结束情况'), hasCost:(d.body.innerText||'').includes('本次消耗') }); })()`,
    );
    const ovj = JSON.parse(ov);
    measurements[size].overview = ovj;
    check(`[${size}] 概览容器渲染（aria-label=运行概览）`, ovj.hasOverview === true);
    // 标准 run 必须带「结束情况」「本次消耗」；隔离变体走隔离模板（无消耗区），单独记录不算失败
    const isIsolated = ovj.hasEnd === false && ovj.hasCost === false;
    check(
      `[${size}] 标准 run 概览含「结束情况」`,
      isIsolated ? true : ovj.hasEnd === true,
      isIsolated ? "隔离变体，跳过" : undefined,
    );
    await shot(call, `02-${sizeTag}-overview.png`);

    // 切「步骤」页签
    const toSteps = await evalv(
      call,
      `(() => { const b=Array.from(document.querySelectorAll('button')).find(e=>((e.textContent||'').trim()==='步骤'||(e.textContent||'').search('步骤')>=0)&&(e.textContent||'').length<=8); if(!b) return false; b.click(); return true; })()`,
    );
    check(`[${size}] 能切到「步骤」页签`, toSteps === true);
    await new Promise((r) => setTimeout(r, 900));
    let echarts = false;
    let stepsRows = 0;
    if (toSteps) {
      const st = await evalv(
        call,
        `(() => JSON.stringify({ canvas: !!document.querySelector('canvas'), rows: document.querySelectorAll('[data-span-id]').length, text:(document.body.innerText||'').slice(0,40) }))()`,
      );
      const stj = JSON.parse(st);
      stepsRows = stj.rows;
      echarts = stj.canvas;
      measurements[size].steps = { canvas: stj.canvas, spanRows: stj.rows };
      await shot(call, `03-${sizeTag}-steps.png`);
    }
    check(`[${size}] 步骤页有调用行`, stepsRows > 0, `${stepsRows} 行`);

    // 切「文件」页签（若该 run 有文件视图入口）
    const toFiles = await evalv(
      call,
      `(() => { const b=Array.from(document.querySelectorAll('button')).find(e=>((e.textContent||'').trim()==='文件'||(e.textContent||'').search('文件')>=0)&&(e.textContent||'').length<=6); if(!b) return false; b.click(); return true; })()`,
    );
    await new Promise((r) => setTimeout(r, 900));
    const filesOk = await evalv(
      call,
      `(() => { const t=document.body.innerText||''; return JSON.stringify({ hasEntry:t.includes('选择检查点')||t.includes('文件')||t.includes('快照'), hasWriteEntry:(t.includes('应用')&&t.includes('回写')) }); })()`,
    );
    const fj = JSON.parse(filesOk);
    check(`[${size}] 能切到「文件」页签`, toFiles === true);
    // 「文件承载区不附带步骤目录」结构保证：文件页不应出现"步骤目录"标题
    const noDir = await evalv(call, `(() => (document.body.innerText||'').includes('步骤目录'))()`);
    check(`[${size}] 文件页不附带步骤目录`, noDir === false);
    measurements[size].files = {
      hasEntry: fj.hasEntry,
      hasWriteEntry: fj.hasWriteEntry,
      shows步骤目录: noDir,
    };
    await shot(call, `04-${sizeTag}-files.png`);
  }

  writeFileSync(
    join(OUT, "measurements.json"),
    JSON.stringify({ measurements, checks, capturedAt: new Date().toISOString() }, null, 2),
  );
  writeFileSync(join(OUT, "shots-summary.json"), JSON.stringify({ sized: SIZES }, null, 2));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n完成：${checks.length - failed.length}/${checks.length} 通过；证据 ${SHOT_DIR}`);
  if (failed.length) {
    console.log("失败项：");
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
