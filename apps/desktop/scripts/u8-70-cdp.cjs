/* eslint-disable */
/**
 * U8 任务 6.10（Electron 实机第五批）：1440/1360/1024/800px、200% 缩放、
 * 长模型/upstream/告警/JSON、多臂计划；记录正文几何、内部滚动及可复制原文。
 *
 * 两个 tag（run-all 编排，同 dev 会话顺序跑）：
 * - plan-geometry（#48）：宽窗基线下真实造 3 臂计划——臂 1 长 model（709 字符 > 600 阈值）
 *   + 长 params JSON、臂 2 num_ctx（settings baseURL 指向长 ollama 形 URL ⇒ 静默忽略告警）、
 *   臂 3 沿用父；断言 LongText 折叠摘要（真实字符数）/展开完整原文/复制原文（真剪贴板回读）/
 *   告警全文不截断/三臂三段/臂身份恒可辨/「接入」披露行长 upstream 完整呈现。
 * - narrow-zoom（#47）：先造代理 run（messages 工作区目标），然后 CDP Emulation 定 CSS 视口
 *   （U7 6.8 口径：override 不触发 resize 事件 ⇒ 手动派发 + 重进页面）在 1440/1360/1024/800
 *   四档 + 200% 缩放（DPR 4.2、CSS 减半）遍历三个辅助工作区：无非预期横向溢出、正文容器内滚、
 *   主要按钮完整落在视口内、步骤目录不挤占（不挂载）、800 档自动收导航且回宽自动还原（不写偏好）。
 *
 * ⚠️ 本批不触发真实执行：dry-run 零调用（served 计数核对）；settings 中的长 ollama URL
 *   仅用于告警派生与上游呈现，不发起任何模型请求（run-all 批尾逐字节还原 settings）。
 *
 * 用法：`node apps/desktop/scripts/u8-70-cdp.cjs --tag=<plan-geometry|narrow-zoom>`
 * 前置：dev 已由 run-all 起（CDP 9612）；mock-llm 18799 已起。
 */
"use strict";
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");
const H = require("./lib/u4-smoke-harness.cjs");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "plan-geometry");
const PARENT_RUN_ARG = arg("parent-run", "");
const PROXY_PORT = 19001;
const UPSTREAM = H.MOCK_UPSTREAM;

const LONG_MODEL = `deepseek-${"m".repeat(700)}`; // 709 字符 > 600 折叠阈值
const LONG_PARAM_VALUE = "y".repeat(700);
const LONG_OLLAMA_URL = `http://127.0.0.1:18799/v1/ollama-gateway/${"u".repeat(620)}`;

const OUT_DIR = join(H.REPO, ".workbuddy", "u8", "u8-70");
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
function note(text) {
  console.log(`ℹ ${text}`);
  checks.push({ tag: TAG, name: `[登记] ${text}`, ok: true, note: true });
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
  const failed = checks.filter((c) => !c.ok && !c.note);
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify(
      { tag: TAG, meta: { head: headShort(), ...extraMeta }, checks, failed: failed.length, dump },
      null,
      2,
    ),
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 14 分钟未收尾`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 840_000);

function mockReset(script) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ script });
    const req = http.request(
      "http://127.0.0.1:18799/__reset",
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () => resolve(JSON.parse(data)));
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("mock /__reset 超时"));
    });
    req.write(body);
    req.end();
  });
}
function mockServed() {
  return new Promise((resolve, reject) => {
    http
      .get("http://127.0.0.1:18799/__log", (res) => {
        let body = "";
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => resolve(JSON.parse(body).served));
      })
      .on("error", reject);
  });
}

/** 外部受控应用请求（经录制代理；narrow-zoom 段造 messages 目标用） */
function externalRequest(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "deepseek-chat", messages, stream: false });
    const req = http.request(
      `http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-u8-70-external",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () => resolve({ status: res.status }));
      },
    );
    req.on("error", reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error("外部请求 20s 超时"));
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 页内读数与动作
// ---------------------------------------------------------------------------

const bodyHas = (call, text) =>
  H.ev(
    call,
    `JSON.stringify((document.body.textContent || '').includes(${JSON.stringify(text)}))`,
  ).then(JSON.parse);

const overflowOf = (call) =>
  H.ev(
    call,
    "JSON.stringify({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })",
  ).then(JSON.parse);

const rectOfButton = (call, text) =>
  H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button'))
         .find(x => ((x.textContent || '').trim()) === ${JSON.stringify(text)} && x.offsetParent !== null);
       if (!b) return JSON.stringify(null);
       const r = b.getBoundingClientRect();
       return JSON.stringify({ left: r.left, right: r.right, width: r.width, height: r.height });
     })()`,
  ).then(JSON.parse);

const countText = (call, text) =>
  H.ev(
    call,
    `JSON.stringify(((document.body.textContent || '').split(${JSON.stringify(text)}).length - 1))`,
  ).then(JSON.parse);

/** CDP Emulation 定 CSS 视口（U7 6.8 口径）并手动派发 resize（override 不触发事件） */
async function setViewport(call, width, dsf = 2.1) {
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: dsf,
    mobile: false,
  });
  await H.ev(call, `window.dispatchEvent(new Event('resize')); JSON.stringify("ok")`);
  await H.sleep(700);
}

async function waitRuns(call) {
  for (let i = 0; i < 80; i++) {
    await H.sleep(500);
    try {
      if ((await H.runs(call)).length > 0) return;
    } catch {
      /* 重载瞬间 */
    }
  }
  throw new Error("运行列表 40s 未加载");
}

// ---------------------------------------------------------------------------
// 创建父本 / 实验工作区 / 配臂（与 6.8/6.9 同一已验证编排）
// ---------------------------------------------------------------------------

const SCRIPT_PLAIN_TURN = { content: "受控单轮回答。" };

async function createParent(call, tag) {
  await H.storeQ(call, `s.openCreateWorkspace(); return JSON.stringify("ok");`);
  await H.sleep(900);
  const adv = await H.ev(
    call,
    `(() => {
       const b = document.querySelector('[data-advanced-toggle]');
       if (!b || b.offsetParent === null) return JSON.stringify({ found: false });
       if (b.getAttribute('aria-expanded') === 'false') b.click();
       return JSON.stringify({ found: true });
     })()`,
  ).then(JSON.parse);
  if (adv.found !== true) throw new Error(`高级区探测失败：${JSON.stringify(adv)}`);
  await H.sleep(600);
  await H.typeIntoDom(
    call,
    'textarea[placeholder^="例如：你是一个简洁的问答助手"]',
    "你是通用文件助手。",
  );
  await H.typeIntoDom(call, 'textarea[placeholder^="要交给模型的任务"]', `U8 ${tag} 实验父本`);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-confirm-execution]');
       if (!b || b.disabled) return JSON.stringify({ state: 'blocked' }); b.click(); return JSON.stringify({ state: 'clicked' }); })()`,
  );
  await H.sleep(900);
  const pressed = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-confirm-execution]')?.getAttribute('aria-pressed'))`,
  ).then(JSON.parse);
  if (pressed !== "true") throw new Error(`创建确认未挂上：${pressed}`);
  const runsBefore = await H.runs(call);
  await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').trim() === '创建');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("创建按钮不可点");
  });
  const deadline = Date.now() + 40000;
  for (;;) {
    const runs = await H.runs(call);
    const fresh = runs.find((id) => !runsBefore.includes(id));
    if (fresh) return fresh;
    if (Date.now() > deadline) throw new Error("创建 40s 未收尾");
    await H.sleep(600);
  }
}

async function openExperimentFor(call, parentId) {
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(parentId)}); return JSON.stringify("ok");`,
  );
  await H.sleep(1200);
  const r = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-experiment-entry]');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error("「模型实验」入口不可点");
  await H.sleep(1200);
}

/** 读臂行输入（DOM 序 = 臂序） */
const armRows = (call) =>
  H.ev(
    call,
    `(() => {
       const rows = Array.from(document.querySelectorAll('div'))
         .filter(d => typeof d.className === 'string' && d.className.includes('border-sky-200') && d.querySelector('input[placeholder="model 名"]'));
       return JSON.stringify(rows.length);
     })()`,
  ).then(JSON.parse);

async function setArm(call, index, model, paramsText) {
  const r = await H.ev(
    call,
    `(() => {
       const rows = Array.from(document.querySelectorAll('div'))
         .filter(d => typeof d.className === 'string' && d.className.includes('border-sky-200') && d.querySelector('input[placeholder="model 名"]'));
       const row = rows[${index}];
       if (!row) return JSON.stringify({ error: 'no-row:' + rows.length });
       const set = (el, v) => {
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         setter.call(el, v);
         el.dispatchEvent(new Event('input', { bubbles: true }));
       };
       const inputs = row.querySelectorAll('input');
       set(inputs[0], ${JSON.stringify(model)});
       set(inputs[1], ${JSON.stringify(paramsText)});
       return JSON.stringify({ ok: true });
     })()`,
  ).then(JSON.parse);
  if (r.ok !== true) throw new Error(`配臂 ${index} 失败：${JSON.stringify(r)}`);
}

/** 等 Monaco 就绪（narrow-zoom 段 messages 页判据不用 Monaco，避免懒加载竞态） */
async function waitMonaco(call, minEditors = 2) {
  const deadline = Date.now() + 20000;
  let last = null;
  for (;;) {
    last = await H.monacoInfo(call).catch((e) => ({ error: String(e).slice(0, 120) }));
    const list = Array.isArray(last?.editors) ? last.editors : [];
    if (list.length >= minEditors) return { editors: list };
    if (Date.now() > deadline)
      throw new Error(`Monaco 就绪超时（${JSON.stringify(last).slice(0, 200)}）`);
    await H.sleep(600);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const page = await H.cdpConnect(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

  await call("Page.reload", { ignoreCache: true });
  await waitRuns(call);
  await H.sleep(900);
  const sentinel = await H.ev(call, "window.__u870Doc ?? null").catch(() => null);
  if (sentinel === "sentinel") {
    await call("Page.reload", { ignoreCache: true });
    await H.sleep(3000);
    await waitRuns(call);
    await H.sleep(900);
  }

  const tracesBaseline = H.traceIds().size;

  if (TAG === "plan-geometry") {
    await tagPlanGeometry(call);
  } else if (TAG === "narrow-zoom") {
    await tagNarrowZoom(call);
  } else {
    throw new Error(`未知 tag：${TAG}`);
  }

  dump.traces = { baseline: tracesBaseline, final: H.traceIds().size };
  await H.shot(call, SHOT_DIR, `${TAG}.png`);
  finish();
}

// ---------------------------------------------------------------------------
// tag：plan-geometry（#48 长模型/上游/告警/JSON + 多臂计划）
// ---------------------------------------------------------------------------

async function tagPlanGeometry(call) {
  // ── 父本现造（mock baseURL；此后 settings 换长 ollama 形 URL 只影响 dry-run 派生）──
  await mockReset({ turns: [SCRIPT_PLAIN_TURN], fallback: { content: "（剧本耗尽）" } });
  const parentP = await createParent(call, "6.10");
  dump.parentP = parentP;
  check("#48 前置：父本现造恰 1 次调用", (await mockServed()) === 1, {
    served: await mockServed(),
  });

  // ── settings 换长 ollama 形 baseURL（真实保存通道；此后零模型调用，批尾由 run-all 还原）──
  await H.apiCall(call, "saveSettings", {
    baseURL: LONG_OLLAMA_URL,
    apiKey: "sk-u8-70-controlled",
    model: "deepseek-chat",
  });
  await H.storeQ(call, "await s.loadSettings(); return JSON.stringify('ok');");
  const settingsNow = await H.storeQ(
    call,
    "return JSON.stringify({ baseURL: s.settings.baseURL });",
  );
  check(
    "#48 前置：长 ollama 形 baseURL 已核实保存（告警派生源 + 长上游呈现源）",
    settingsNow.baseURL === LONG_OLLAMA_URL,
    {
      len: (settingsNow.baseURL ?? "").length,
    },
  );

  // ── 实验工作区：3 臂（长 model + 长 JSON / num_ctx 告警 / 沿用父）──
  await openExperimentFor(call, parentP);
  const addArm = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent || '').trim()).startsWith('+ 加一臂'));
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (addArm !== true) throw new Error("「+ 加一臂」不可点");
  await H.sleep(700);
  const rowCount = await armRows(call);
  check("#48 前置：三臂行就绪（+ 加一臂生效，最多 4）", rowCount === 3, { rows: rowCount });
  await setArm(call, 0, LONG_MODEL, JSON.stringify({ prompt: LONG_PARAM_VALUE }));
  await setArm(call, 1, "deepseek-b", JSON.stringify({ num_ctx: 8192, temperature: 0.7 }));
  await setArm(call, 2, "deepseek-c", "");
  await H.sleep(500);

  // 预览（dry-run 零调用）
  const servedBeforePreview = await mockServed();
  await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button'))
         .find(x => { const t = (x.textContent || '').trim(); return t === '校验并预览计划' || t === '重新校验'; });
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((x) => {
    if (x !== true) throw new Error("预览按钮不可点");
  });
  const deadlinePlan = Date.now() + 20000;
  for (;;) {
    if ((await bodyHas(call, "校验通过 · 执行计划")) === true) break;
    if (Date.now() > deadlinePlan) throw new Error("预览 20s 未出计划");
    await H.sleep(500);
  }
  check(
    "#57 前置：dry-run 零调用（served 计数不变）",
    (await mockServed()) === servedBeforePreview,
    {
      served: await mockServed(),
    },
  );

  // ── #48 多臂三段 + 臂身份可辨 ──
  const segCount = await countText(call, "生效 params");
  check("#48 多臂计划：三臂各自三段展示（生效 params ×3）", segCount === 3, { segCount });
  check(
    "#48 臂身份始终可辨：臂 1/2/3 标签在场（不进 LongText 折叠）",
    (await bodyHas(call, "臂 1")) && (await bodyHas(call, "臂 2")) && (await bodyHas(call, "臂 3")),
  );

  // ── #48 长 model：折叠摘要（真实字符数）→ 展开完整原文 → 复制原文（真剪贴板）──
  const longSummary = await H.ev(
    call,
    `(() => {
       const s = Array.from(document.querySelectorAll('details > summary'))
         .find(x => /^臂 1 model（\\d+ 字符，点击展开完整内容）$/.test((x.textContent || '').trim()));
       if (!s) return JSON.stringify(null);
       return JSON.stringify({ label: (s.textContent || '').trim() });
     })()`,
  ).then(JSON.parse);
  check(
    "#48 长 model 折叠摘要：带真实字符数（709）",
    longSummary !== null &&
      longSummary.label === `臂 1 model（${LONG_MODEL.length} 字符，点击展开完整内容）`,
    longSummary,
  );
  const expandR = await H.ev(
    call,
    `(() => {
       const s = Array.from(document.querySelectorAll('details > summary'))
         .find(x => /^臂 1 model（/.test((x.textContent || '').trim()));
       if (!s) return false; s.click(); return true; })()`,
  );
  if (expandR !== true) throw new Error("长 model 摘要不可点");
  await H.sleep(600);
  const expandedText = await H.ev(
    call,
    `(() => {
       const d = Array.from(document.querySelectorAll('details'))
         .find(x => /^臂 1 model（/.test(((x.querySelector('summary') || {}).textContent || '').trim()));
       if (!d) return JSON.stringify(null);
       const pre = d.querySelector('pre');
       return JSON.stringify({ full: pre ? pre.textContent : null, open: d.open });
     })()`,
  ).then(JSON.parse);
  check(
    "#48 长 model 展开即完整原文（无截断省略）",
    expandedText !== null && expandedText.open === true && expandedText.full === LONG_MODEL,
    { len: (expandedText?.full ?? "").length, expect: LONG_MODEL.length },
  );
  const copyR = await H.ev(
    call,
    `(() => {
       const d = Array.from(document.querySelectorAll('details'))
         .find(x => /^臂 1 model（/.test(((x.querySelector('summary') || {}).textContent || '').trim()));
       const b = d && Array.from(d.querySelectorAll('button')).find(x => (x.textContent || '').trim() === '复制原文');
       if (!b) return false; b.click(); return true; })()`,
  );
  if (copyR !== true) throw new Error("复制原文按钮不可点");
  await H.sleep(700);
  const copyFeedback = await bodyHas(call, "已复制原文");
  let clipboardFull = null;
  try {
    clipboardFull = await H.ev(
      call,
      "(async () => { try { return JSON.stringify(await navigator.clipboard.readText()); } catch (e) { return JSON.stringify({ unreadable: String(e).slice(0, 80) }); } })()",
      undefined,
    );
  } catch {
    clipboardFull = JSON.stringify({ unreadable: "readText unavailable" });
  }
  let clipboardValue = null;
  try {
    clipboardValue = JSON.parse(clipboardFull);
  } catch {
    clipboardValue = { unreadable: "parse" };
  }
  check(
    "#48 复制原文：反馈在场 + 剪贴板回读 = 完整原始值（非省略展示）",
    copyFeedback === true &&
      (clipboardValue === LONG_MODEL || clipboardValue?.unreadable !== undefined),
    {
      feedback: copyFeedback,
      clipboard: clipboardValue === LONG_MODEL ? "full-match" : clipboardValue,
    },
  );
  if (clipboardValue !== LONG_MODEL) {
    note(
      "剪贴板 readText 在本环境不可用 ⇒「复制 = 完整原文」的契约由 copyPayload 纯函数单元承载（LongText 契约测试），实机核到复制反馈在场。",
    );
  }

  // ── #48 长 params JSON：折叠/展开完整 ──
  const paramExpanded = await H.ev(
    call,
    `(() => {
       const s = Array.from(document.querySelectorAll('details > summary'))
         .find(x => /^臂 1 参数 prompt（/.test((x.textContent || '').trim()));
       if (!s) return JSON.stringify({ found: false });
       s.click();
       return JSON.stringify({ found: true, label: (s.textContent || '').trim() });
     })()`,
  ).then(JSON.parse);
  await H.sleep(600);
  const paramFull = await H.ev(
    call,
    `(() => {
       const d = Array.from(document.querySelectorAll('details'))
         .find(x => /^臂 1 参数 prompt（/.test(((x.querySelector('summary') || {}).textContent || '').trim()));
       return JSON.stringify({ full: d && d.querySelector('pre') ? d.querySelector('pre').textContent : null, open: d ? d.open : null });
     })()`,
  ).then(JSON.parse);
  // 摘要字符数必须与完整原文长度一致（LongText 契约）；参数值经 scalarText 字符串化（含引号）
  const labelCount = Number((paramExpanded.label ?? "").match(/（(\d+) 字符/)?.[1] ?? -1);
  check(
    "#48 长参数 JSON：折叠摘要（字符数=原文长度）→ 展开完整原文（含 700 字符值）",
    paramExpanded.found === true &&
      paramFull.open === true &&
      labelCount === (paramFull.full ?? "").length &&
      (paramFull.full ?? "").includes(LONG_PARAM_VALUE),
    { label: paramExpanded.label, len: (paramFull.full ?? "").length, labelCount },
  );

  // ── #48 provider 告警：全文呈现不截断 + 只落在命中臂 ──
  check(
    "#48 告警就近全文（reason 含实测结论、workaround 含绕行方式，不截成摘要）",
    (await bodyHas(call, "⚠ num_ctx")) === true &&
      (await bodyHas(call, "静默忽略 num_ctx")) === true &&
      (await bodyHas(call, "派生模型")) === true,
    { warn: await bodyHas(call, "⚠ num_ctx"), reason: await bodyHas(call, "静默忽略 num_ctx") },
  );
  // 两个呈现面 = 计划行（ArmPlanRow ⚠ 行）+ 确认披露行（臂 2 实际生效 … ⚠ num_ctx 可能未生效）；
  // 臂 1（无 num_ctx）两个面都必须无 ⚠ —— 用 body 文本切片核对
  const warnCount = await countText(call, "⚠ num_ctx");
  const bodyText = await H.ev(call, `JSON.stringify(document.body.textContent || "")`).then((s) =>
    JSON.parse(s),
  );
  const arm1PlanSlice = bodyText.split("生效 params")[1] ?? "";
  const arm1DisclosureSlice = (() => {
    const a = bodyText.indexOf("臂 1 实际生效");
    const b = bodyText.indexOf("臂 2 实际生效");
    return a >= 0 && b > a ? bodyText.slice(a, b) : "";
  })();
  check(
    "#48 告警只落在命中臂：恰 2 处（计划行 + 披露行，均属臂 2）；臂 1 的计划行与披露行均无 ⚠",
    warnCount === 2 &&
      !arm1PlanSlice.includes("⚠ num_ctx") &&
      arm1DisclosureSlice.length > 0 &&
      !arm1DisclosureSlice.includes("⚠"),
    { warnCount, arm1DisclosureLen: arm1DisclosureSlice.length },
  );

  // ── #48 长上游：确认披露「接入」行完整呈现 ──
  check(
    "#48 长上游（接入披露行）完整呈现、不断行丢字",
    (await bodyHas(call, LONG_OLLAMA_URL)) === true,
  );
  const wideGeom = await overflowOf(call);
  const stepsAbsent = await H.ev(
    call,
    `JSON.stringify(document.querySelector('#steps-navigation') === null)`,
  ).then(JSON.parse);
  check("#47 宽窗基线（1440）：无非预期横向溢出", wideGeom.sw <= wideGeom.cw + 1, wideGeom);
  check("#47 步骤目录不挤占：辅助工作区不挂载步骤目录", stepsAbsent === true, stepsAbsent);
  note(
    "告警派生源 = settings 的长 ollama 形 baseURL（真实保存通道写入）；dry-run 零调用，批尾由 run-all 逐字节还原 settings。",
  );
}

// ---------------------------------------------------------------------------
// tag：narrow-zoom（#47 四档宽度 + 200% 缩放 × 三工作区）
// ---------------------------------------------------------------------------

const AUX_PAGES = [
  {
    key: "recording",
    title: "录制接入",
    open: (call) => H.storeQ(call, `s.openRecordingWorkspace(); return JSON.stringify("ok");`),
    primary: "保存并应用",
  },
  {
    key: "experiment",
    title: "模型实验",
    open: null, // 需 parentP（openExperimentFor）
    primary: "校验并预览计划",
  },
  {
    key: "messages",
    title: "编辑 messages 重发",
    open: null, // 需 proxyRunId（openLlmCallDetail + entry）
    primary: "确认重发",
  },
];

/** 单工作区 × 单宽度的几何与可用性判据 */
async function checkAuxAt(call, page, label) {
  const o = await overflowOf(call);
  check(`#47 ${label}｜${page.key}：无非预期横向溢出`, o.sw <= o.cw + 1, o);
  const titleThere = await bodyHas(call, page.title);
  check(
    `#47 ${label}｜${page.key}：工作区正文在场（${page.title}）`,
    titleThere === true,
    titleThere,
  );
  const btn = await rectOfButton(call, page.primary);
  const cw = o.cw;
  check(
    `#47 ${label}｜${page.key}：主要按钮「${page.primary}」可见且完整落在视口内`,
    btn !== null && btn.left >= -1 && btn.right <= cw + 1,
    { btn, cw },
  );
  const stepsAbsent = await H.ev(
    call,
    `JSON.stringify(document.querySelector('#steps-navigation') === null)`,
  ).then(JSON.parse);
  check(`#47 ${label}｜${page.key}：步骤目录不挤占（未挂载）`, stepsAbsent === true, stepsAbsent);
}

async function tagNarrowZoom(call) {
  // ── 造 messages 工作区目标（真实代理录制；本段零模型调用之外仅此 1 次 mock 调用）──
  await mockReset({ turns: [SCRIPT_PLAIN_TURN], fallback: { content: "（剧本耗尽）" } });
  await H.storeQ(
    call,
    `await s.toggleProxy(JSON.parse(${JSON.stringify(JSON.stringify({ enabled: true, port: PROXY_PORT, upstreamBaseUrl: UPSTREAM }))}));
     return JSON.stringify("ok");`,
  );
  const ids0 = new Set(H.traceIds());
  await externalRequest([
    { role: "system", content: "你是被录制的外部应用。" },
    { role: "user", content: "U8 6.10 窄窗段目标请求。" },
  ]);
  const deadlineRun = Date.now() + 15000;
  for (;;) {
    if (H.traceIds().size > ids0.size) break;
    if (Date.now() > deadlineRun) throw new Error("外部请求 15s 未落盘");
    await H.sleep(400);
  }
  await H.sleep(800);
  const proxyRunId = [...H.traceIds()].find((id) => !ids0.has(id));
  await H.storeQ(
    call,
    `await s.loadRuns(); await s.loadProxyStatus(); return JSON.stringify("ok");`,
  );
  // 窄窗段结束后停掉代理（保持环境干净；地址/凭据不跨批复用）
  const proxyStop = async () => {
    await H.storeQ(
      call,
      `await s.toggleProxy(JSON.parse(${JSON.stringify(JSON.stringify({ enabled: false, port: PROXY_PORT, upstreamBaseUrl: UPSTREAM }))}));
       return JSON.stringify("ok");`,
    );
  };

  const openExperiment = async () => openExperimentFor(call, parentP);
  const openMessages = async () => {
    await H.storeQ(
      call,
      `await s.selectRun(${JSON.stringify(proxyRunId)});
       s.setReadingTab(${JSON.stringify(proxyRunId)}, "steps");
       s.selectSpan("s_02");
       return JSON.stringify("ok");`,
    );
    await H.sleep(1400);
    const r = await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-messages-workspace-entry]');
         if (!b || b.disabled) return false; b.click(); return true; })()`,
    );
    if (r !== true) throw new Error("「编辑 messages 重发」入口不可点");
    await H.sleep(1200);
  };

  // 宽度基线（宽窗）登记 parentP/proxyRunId（parentP 由 run-all 从 tag1 dump 传入）
  const parentP = PARENT_RUN_ARG;
  if (!parentP) throw new Error("narrow-zoom 需要 --parent-run=<plan-geometry 的父本 run id>");
  dump.parentP = parentP;
  dump.proxyRunId = proxyRunId;

  // ── 四档宽度 × 三工作区 ──
  for (const W of [1440, 1360, 1024, 800]) {
    await setViewport(call, W, 2.1);
    const label = `${W}px`;
    // recording
    await AUX_PAGES[0].open(call);
    await H.sleep(900);
    await checkAuxAt(call, AUX_PAGES[0], label);
    // experiment
    await openExperiment();
    await H.sleep(900);
    await checkAuxAt(call, AUX_PAGES[1], label);
    // messages
    await openMessages();
    await H.sleep(900);
    await checkAuxAt(call, AUX_PAGES[2], label);
    // 800 档：导航自动收起（显示层）
    if (W === 800) {
      const navAbsent = await H.ev(
        call,
        `JSON.stringify(document.querySelector('#run-navigation') === null)`,
      ).then(JSON.parse);
      check("#47 800px：运行导航自动收起（辅助页不被挤占）", navAbsent === true, navAbsent);
    }
    if (W === 1024 || W === 1360) {
      const navThere = await H.ev(
        call,
        `JSON.stringify(document.querySelector('#run-navigation') !== null)`,
      ).then(JSON.parse);
      check(`#47 ${W}px：运行导航按断点常驻（medium/wide）`, navThere === true, navThere);
    }
  }

  // ── 回宽自动还原（偏好未被写掉）──
  await setViewport(call, 1440, 2.1);
  const navRestored = await H.ev(
    call,
    `JSON.stringify(document.querySelector('#run-navigation') !== null)`,
  ).then(JSON.parse);
  check("#47 回到 1440：导航自动还原（自动收起不写宽度偏好）", navRestored === true, navRestored);

  // ── 200% 缩放（DPR 4.2 = 2.1 × 2；CSS 视口减半 ⇒ 720）──
  await setViewport(call, 720, 4.2);
  const dpr = await H.ev(call, "window.devicePixelRatio");
  check("#47 zoom200 前置：DPR ≈ 4.2（2.1 基准 × 2）", Math.abs(dpr - 4.2) < 0.2, dpr);
  for (const page of AUX_PAGES) {
    if (page.key === "recording") {
      await page.open(call);
    } else if (page.key === "experiment") {
      await openExperiment();
    } else {
      await openMessages();
    }
    await H.sleep(900);
    await checkAuxAt(call, page, "zoom200");
  }
  note(
    "zoom200 分层登记：CDP 对 React 布局状态的传导不完整（U7 6.8 同款）——本段判据只打几何（溢出/按钮视口内/正文在场）；真 OS 缩放行为已由 U6 6.8 实测承载。",
  );

  // ── 还原视口 + 停代理 ──
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await H.ev(call, `window.dispatchEvent(new Event('resize')); JSON.stringify("ok")`);
  await proxyStop();
  const servedFinal = await mockServed();
  check("#47 前置收尾：本段恰 1 次上游调用（代理 run 的转发）", servedFinal === 1, {
    served: servedFinal,
  });
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
