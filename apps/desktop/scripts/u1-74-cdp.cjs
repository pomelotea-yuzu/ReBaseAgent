/* eslint-disable */
/**
 * U1 任务 7.4 · 只读语义哈希回归的真实 Electron 阅读循环。
 *
 * 目标：验证「阅读过程不修改既有数据」（desktop-ui / 主 spec 文件只读场景）。
 * 前置/结论：
 *   - `u1-74-snapshot.cjs` 在**阅读前**对 `.rebaseagent/traces`（58 个 *.jsonl）与
 *     `.rebaseagent/workspace-blobs`（6 个隔离文件 blob）逐文件 SHA-256 建基线；
 *   - 本脚本在真实 Electron（CDP 直连本地 dev 9222）里做一组**纯只读**操作：
 *     打开多个 run（普通 + 隔离 v1/v2）、概览/步骤/文件页签、选中 span 展开 step、
 *     打开文件页读取隔离文件并触发 Monaco 只读 diff、展开预算图（ECharts 懒加载）；
 *   - 全程**不点任何执行入口**（新建运行/在此重跑/分叉/续跑/设置回写），故不应写入 trace/附件；
 *   - 阅读结束后再 `snapshot` 一次，逐文件对比哈希 → 必须全部相等、文件数不变。
 *
 * ⚠️ dev 的代理（proxy 4025/自动录制）若在跑，读取本身也不应产生新 trace；本脚本通过
 *    settings 显示「代理 已停」时仅做只读，不启停代理。若数据目录临时出现新文件由脚本报出不通过。
 *
 * 证据落 `.workbuddy/u1-74/`。不 spawn、不重启 dev。用法：
 *   node scripts/u1-74-snapshot.cjs  .workbuddy/u1-74/base.json   # 阅读前基线（已建）
 *   node scripts/u1-74-cdp.cjs                                    # 阅读循环
 *   node scripts/u1-74-snapshot.cjs  .workbuddy/u1-74/after.json  # 阅读后再快照
 *   node scripts/u1-74-cdp.cjs --compare=after.json --base=base.json  # 比对（可在同一次执行内完成）
 */
"use strict";

const { readFileSync, writeFileSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const REPO = join(__dirname, "..", "..", "..");
const OUT = join(REPO, ".workbuddy", "u1-74");
const DATA = join(REPO, ".rebaseagent");

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const doCompare = process.argv.includes("--compare-inline");

const RUNS_READ = ["run_muapnwud", "r_01", "r_03", "run_muappa2a_gk7964", "run_muapr3rp_vm52"];
// 隔离 v2 run（有文件页 → Monaco 只读 diff）与 v1 隔离 run
const FILES_RUN_V2 = "run_muappa2a_gk7964";
const FILES_RUN_V1 = "run_muapr3rp_vm52";

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
function call0(call, method, params) {
  return new Promise((ok, rej) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rej(new Error(`timeout ${method}`));
      }
    }, 12000);
    call(method, params)
      .then((r) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ok(r);
        }
      })
      .catch((e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rej(e);
        }
      });
  });
}
async function ev(call, expression) {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result?.value;
}
async function shot(call, name) {
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      const { data } = await call0(call, "Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
      return;
    } catch (e) {
      last = e;
      await sleep(700);
    }
  }
  throw last ?? new Error(`shot failed ${name}`);
}
const selectRunExpr = (id) => `(() => {
  const copy = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('aria-label')||'').startsWith('复制完整运行 ID ${id}'));
  const row = copy ? copy.parentElement : null; const sel = row ? row.querySelector('button[type="button"]') : null;
  if (!sel) return false; sel.click(); return true;
})()`;
const tabExpr = (label) =>
  `(() => { const t = Array.from(document.querySelectorAll('[role="tab"]')).find(x=>(x.textContent||'').trim()==='${label}'); if(!t) return false; t.click(); return true; })()`;

function hashTree(scopeRoot) {
  const map = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile())
        map[f.slice(DATA.length + 1).replace(/\\/g, "/")] = require("node:crypto")
          .createHash("sha256")
          .update(readFileSync(f))
          .digest("hex");
    }
  };
  walk(scopeRoot);
  return map;
}
function compareInline() {
  const base = JSON.parse(readFileSync(join(OUT, "base.json"), "utf8"));
  const after = hashTree(join(DATA, "traces"));
  const afterBlobs = hashTree(join(DATA, "workspace-blobs"));
  check(
    "阅读后 no 新 trace 文件（文件数不变）",
    Object.keys(after).length === base.traces.fileCount,
    `${Object.keys(after).length}/${base.traces.fileCount}`,
  );
  check(
    "阅读后 no 新 workspace-blob（文件数不变）",
    Object.keys(afterBlobs).length === base["workspace-blobs"].fileCount,
    `${Object.keys(afterBlobs).length}/${base["workspace-blobs"].fileCount}`,
  );
  let changed = 0;
  const diffs = [];
  for (const rel of Object.keys(base.traces.files)) {
    if (after[rel] !== base.traces.files[rel]) {
      changed++;
      diffs.push(`trace:${rel}`);
    }
  }
  for (const rel of Object.keys(base["workspace-blobs"].files)) {
    if (afterBlobs[rel] !== base["workspace-blobs"].files[rel]) {
      changed++;
      diffs.push(`blob:${rel}`);
    }
  }
  check(
    "阅读后全部既有 trace/blob 逐文件哈希一致（零变化）",
    changed === 0,
    changed ? `变化 ${diffs.join(", ")}` : "traces + blob 全部一致",
  );
  return changed;
}

async function main() {
  const page = await connect();
  const call = await session(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(400);
  await call("Page.reload");
  await sleep(2400);
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  const read = { runs: {}, files: {} };

  for (const id of RUNS_READ) {
    check(`只读-打开 run ${id}`, (await ev(call, selectRunExpr(id))) === true);
    await sleep(1400);
    const base = await ev(
      call,
      `(() => JSON.stringify({ hasOverview: !!document.querySelector('[aria-label="运行概览"]'),
      bodyOk: document.body.scrollWidth <= document.body.clientWidth, text: (document.body.innerText||'').length }))()`,
    ).then(JSON.parse);
    read.runs[id] = { overview: base.hasOverview, bodyTextLen: base.text };
    check(`只读-${id} 概览渲染`, base.hasOverview === true);
    check(`只读-${id} 无横向溢出`, base.bodyOk === true);

    // 步骤页：选中一个 span（无副作用）
    await ev(call, tabExpr("步骤"));
    await sleep(1100);
    const rowSel = await ev(
      call,
      `(() => { const b=Array.from(document.querySelectorAll('button[title]')).find(x=>(x.getAttribute('title')==='LLM 调用'||x.getAttribute('title')==='write_file'||x.getAttribute('title')==='read_file')); if(!b)return false; b.click(); return true; })()`,
    );
    check(`只读-${id} 步骤页可选择调用行`, rowSel === true);
    await sleep(900);
    // 预算图（展开懒加载 echarts）
    await ev(
      call,
      `(() => { const s=Array.from(document.querySelectorAll('summary')).find(x=>(x.textContent||'').includes('预算')); if(s)s.click(); })()`,
    );
    await sleep(900);
    await shot(call, `read-${id}-steps.png`);
  }

  // 文件页（隔离 v2 run → 读取隔离文件 + Monaco 只读 diff）
  check("文件-打开隔离 v2 run", (await ev(call, selectRunExpr(FILES_RUN_V2))) === true);
  await sleep(1500);
  await ev(call, tabExpr("文件"));
  await sleep(1500);
  // 先选一个「后续检查点」（内容已变化，产生可 diff 上下文），再点 a.txt ⇒ 挂载只读 Monaco diff
  const ck = await ev(
    call,
    `(() => {
    const cand = Array.from(document.querySelectorAll('button')).filter(b => (b.title||'').includes('检查点'));
    if (!cand.length) return false;
    cand[cand.length - 1].click(); return true;
  })()`,
  );
  check("文件-v2 可选后续检查点（产生 diff 上下文）", ck === true);
  await sleep(1200);
  const pickA = await ev(
    call,
    `(() => { const b=Array.from(document.querySelectorAll('ul button')).find(x=>(x.textContent||'').includes('a.txt')); if(!b)return false; b.click(); return true; })()`,
  );
  check("文件-读取隔离文件 a.txt（含 Monaco 只读 diff）", pickA === true);
  await sleep(1600);
  let mono = false;
  for (let i = 0; i < 14; i++) {
    mono = (await ev(call, `(() => !!document.querySelector('.monaco-diff-editor'))()`)) === true;
    if (mono) break;
    await sleep(600);
  }
  // Monaco 只读 diff 属于「文件读取展示」，非只读安全判据（安全判据 = 哈希不变）；
  // 若当前数据无后续变化检查点（无可 diff 上下文），如实记录不硬报失败。
  check("文件-离线 Monaco DiffEditor 只读挂载（若有可 diff 检查点）", mono === true);
  read.files.v2 = { ck: ck === true, mono };
  await shot(call, "file-v2-monaco.png");

  // 文件页（隔离 v1 run）：确认 file 页可打开但无 Monaco（v1 隔离世界只读展示）
  check("文件-打开隔离 v1 run", (await ev(call, selectRunExpr(FILES_RUN_V1))) === true);
  await sleep(1500);
  await ev(call, tabExpr("文件"));
  await sleep(1400);
  const v1read = await ev(
    call,
    `(() => JSON.stringify({ hasFileList: (document.body.innerText||'').includes('a.txt'),
    blobReadable: (document.body.innerText||'').length > 0 }))()`,
  ).then(JSON.parse);
  check("文件-隔离 v1 文件世界可读", v1read.hasFileList === true, v1read.blobReadable);
  await shot(call, "file-v1-read.png");

  // 回到 list 只读浏览（刷新列表也属读层）
  await ev(
    call,
    `(() => { const r=Array.from(document.querySelectorAll('button')).find(b=>(b.textContent||'').includes('刷新')); if(r){r.click();return true;} return false; })()`,
  );
  await sleep(1400);

  // —— 比对：阅读前后哈希 ——
  if (!doCompare && existsSync(join(OUT, "base.json"))) {
    const changed = compareInline();
    console.log(`比对完成：既有 trace/blob 变化文件数 = ${changed}`);
  }

  writeFileSync(
    join(OUT, "read.json"),
    JSON.stringify({ read, checks, capturedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`完成：${checks.length - failed}/${checks.length} 通过；证据 ${OUT}`);
  if (failed) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
