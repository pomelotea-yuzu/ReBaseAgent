/* eslint-disable */
/**
 * U8 任务 6.11（Electron 实机第六批）：系统真键盘完成录制→重发及实验→比较；
 * 设置/放弃焦点、仅录制 dirty 退出及其他 dirty/操作合并；无法实测的竞争由确定性单元承载并单列。
 *
 * 两个 tag（run-all 编排，同 dev 会话顺序跑）：
 * - keyboard-flows（#49/#50）：系统级 keybd_event 真键盘（u3-65-input.ps1；CDP 派发不触发
 *   按钮默认激活）。#49 录制→重发闭环：真键 SPACE 勾启用 → ENTER 应用（真实 toggle）→
 *   ENTER 复制地址（真剪贴板）→ ENTER 查看代理记录（sourceFilter=proxy）→ 真 CTRL+A/CTRL+V
 *   粘贴编辑 messages（真剪贴板通道）→ ENTER 确认 → ENTER 重发（真实 fork 落盘）→
 *   ENTER 入口重进 → ENTER 返回来源（恢复来源）；逐步断言 activeElement 可见 + 可访问名称，
 *   messages 工作区 TAB 有界可达页头（不困焦点）。#50 实验→比较闭环：真键加臂/删臂 →
 *   ENTER 预览 → 放弃模态（初始焦点在取消、TAB 不逃逸、ESC 取消保草稿）→ ENTER 确认 →
 *   ENTER 执行（真实批次落盘、臂身份可辨）→ ENTER 加入对照×2 → ENTER 进入比较 →
 *   ENTER 返回来源（回到原实验目标）。
 * - recording-dirty（#24/#25）：录制放弃取消（真模态 + ESC，输入保持、settings 字节不变、
 *   不重新 toggle）与确认放弃（匹配修订 ⇒ 恢复已核实配置基线）；「旧修订确认不能删除新输入」
 *   的竞争为确定性单元承载并单列；#25 录制 dirty 计入会话 dirty 计数、未修改默认表单不误报，
 *   窗口关闭合并退出确认归 draft-close-client/guard 单元承载（CDP 无法真实触发窗口级关闭协商）。
 *
 * 用法：`node apps/desktop/scripts/u8-71-cdp.cjs --tag=<keyboard-flows|recording-dirty>`
 * 前置：dev 已由 run-all 起（CDP 9612）；mock-llm 18799 已起（settings 的代理 upstream 指向 mock）。
 */
"use strict";
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");
const H = require("./lib/u4-smoke-harness.cjs");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "keyboard-flows");
const PROXY_PORT = 19001;
const UPSTREAM = H.MOCK_UPSTREAM;

const OUT_DIR = join(H.REPO, ".workbuddy", "u8", "u8-71");
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
        res.on("data", (d) => (data += d));
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
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve(JSON.parse(body).served));
      })
      .on("error", reject);
  });
}

function externalRequest(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "deepseek-chat", messages, stream: false });
    const req = http.request(
      `http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-u8-71-external",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
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
// 系统级真键盘（u3-65-input.ps1 keybd_event；u7-69 同款基建）
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
  return MAIN_PID;
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

/** 键盘步骤通用断言：焦点可见（offsetParent 非空）+ 有可访问名称（aria-label 或文本） */
const focusQuality = (call) =>
  H.ev(
    call,
    `(() => {
       const el = document.activeElement;
       if (el === null || el === document.body) return JSON.stringify({ ok: false, reason: 'no-focus' });
       const name = el.getAttribute('aria-label') || (el.textContent || '').trim();
       const r = el.getBoundingClientRect();
       return JSON.stringify({ ok: el.offsetParent !== null && name.length > 0 && r.width > 0 && r.height > 0,
         tag: el.tagName, name: name.slice(0, 30) });
     })()`,
  ).then(JSON.parse);

// ---------------------------------------------------------------------------
// 页内读数与动作
// ---------------------------------------------------------------------------

const bodyHas = (call, text) =>
  H.ev(
    call,
    `JSON.stringify((document.body.textContent || '').includes(${JSON.stringify(text)}))`,
  ).then(JSON.parse);

const waitRuns = async (call) => {
  for (let i = 0; i < 80; i++) {
    await H.sleep(500);
    try {
      if ((await H.runs(call)).length > 0) return;
    } catch {
      /* 重载瞬间 */
    }
  }
  throw new Error("运行列表 40s 未加载");
};

const SCRIPT_PLAIN_TURN = { content: "受控单轮回答。" };

async function createParent(call, tag) {
  // ⚠️ #49 的「查看代理记录」会把列表筛成 proxy 来源——本地创建的父本不进被筛选的
  // DOM 列表（6.11 首轮坐实：run 已落盘但列表 40s 看不到）⇒ 创建前清回全部来源。
  await H.storeQ(call, `s.setSourceFilter("all"); return JSON.stringify("ok");`);
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

const armRowsCount = (call) =>
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

/** 真 Ctrl+A / Ctrl+V 粘贴到可见可编辑 Monaco（焦点经 monaco API；选区与粘贴为真键） */
async function pasteIntoDraftMonaco(call, text) {
  const focusR = await H.appImport(
    call,
    H.MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const eds = monaco.editor.getEditors().filter((e) =>
       e.getDomNode() !== null && e.getDomNode().offsetParent !== null &&
       !e.getOption(monaco.editor.EditorOption.readOnly));
     if (eds.length === 0) return JSON.stringify({ ok: false });
     eds[0].focus();
     return JSON.stringify({ ok: document.activeElement !== null && eds[0].getDomNode().contains(document.activeElement) });`,
  );
  if (focusR.ok !== true) throw new Error(`Monaco 聚焦失败：${JSON.stringify(focusR)}`);
  await realKeys("CTRL+A", { raise: "0" });
  await realKeys("CTRL+V", { raise: "0" });
  await H.sleep(700);
  const info = await waitMonaco(call, 2);
  const draft = info.editors.find((e) => !e.readOnly);
  return draft?.value ?? null;
}

const proxyRecords = (call) =>
  H.storeQ(
    call,
    `const recs = s.operations.operations.filter(o => o.target && (o.target.kind === 'proxy' || o.target.kind === 'modelAb'));
     return JSON.stringify(recs.map(o => ({ kind: o.target.kind, operationId: o.operationId, state: o.state, runIds: o.runIds, arms: o.arms ?? null })));`,
  );

async function waitSettled(call, kind, exclude, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recs = await proxyRecords(call);
    const rec = recs.find(
      (o) => o.kind === kind && o.state === "settled" && !exclude.includes(o.operationId),
    );
    if (rec) return rec;
    if (Date.now() > deadline)
      throw new Error(`${kind} 登记收口 ${timeoutMs / 1000}s 未到：${JSON.stringify(recs)}`);
    await H.sleep(800);
  }
}

/** 等 U5 导航意图落地（messages 提交收口 ⇒ 自动跳结果 run） */
async function waitAutoNav(call, expectRunId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await H.storeQ(
      call,
      `return JSON.stringify({ view: s.view, sel: s.selectedRunId });`,
    );
    if (st.view === "trace" && st.sel === expectRunId) return st;
    if (Date.now() > deadline) return st;
    await H.sleep(500);
  }
}

const readRunFile = (runId) => {
  const lines = readFileSync(join(H.TRACES, `${runId}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return {
    meta: lines[0],
    llms: lines.filter((o) => o.kind === "llm.call"),
    terminal: lines[lines.length - 1],
  };
};

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
  const sentinel = await H.ev(call, `window.__u871Doc ?? null`).catch(() => null);
  if (sentinel === "sentinel") {
    await call("Page.reload", { ignoreCache: true });
    await H.sleep(3000);
    await waitRuns(call);
    await H.sleep(900);
  }

  MAIN_PID = await resolveMainPid();
  if (MAIN_PID <= 0) throw new Error("无法解析 ReBaseAgent 主窗口进程（keybd_event 通道不可用）");
  await raiseForeground();
  const tracesBaseline = H.traceIds().size;

  if (TAG === "keyboard-flows") {
    await tagKeyboardFlows(call);
  } else if (TAG === "recording-dirty") {
    await tagRecordingDirty(call);
  } else {
    throw new Error(`未知 tag：${TAG}`);
  }

  dump.traces = { baseline: tracesBaseline, final: H.traceIds().size };
  await H.shot(call, SHOT_DIR, `${TAG}.png`);
  finish();
}

// ---------------------------------------------------------------------------
// tag：keyboard-flows（#49 + #50）
// ---------------------------------------------------------------------------

async function tagKeyboardFlows(call) {
  const ids0 = new Set(H.traceIds());
  const parentProxyMessages = [
    { role: "system", content: "你是被录制的外部应用。" },
    { role: "user", content: "U8 6.11 外部请求一。" },
  ];

  // ══ #49 步骤 1：真键进入录制（全局栏「录制接入」） ══
  const fRec = await focusEl(
    call,
    `Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '录制接入')`,
  );
  check("#49 起点：全局栏「录制接入」可聚焦", fRec === "focused", fRec);
  await pressEnter(call);
  await H.sleep(1200);
  const viewRec = await H.storeQ(call, `return JSON.stringify({ view: s.view });`);
  check("#49 真键 ENTER 进入录制工作区", viewRec.view === "recording", viewRec);
  const qRec = await focusQuality(call);
  check("#49 焦点可见且有可访问名称（进入录制后）", qRec.ok === true, qRec);

  // ══ #49 步骤 2：真键 SPACE 勾启用 + ENTER 应用（真实 toggle） ══
  const fChk = await focusEl(call, `document.querySelector('[data-recording-enabled]')`);
  check("#49 启用复选框可聚焦", fChk === "focused", fChk);
  await realKeys("SPACE", { raise: "0" });
  await H.sleep(600);
  const enabledNow = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-recording-enabled]').checked)`,
  ).then(JSON.parse);
  check(
    "#49 真键 SPACE 勾选启用（dirty 随现）",
    enabledNow === true && (await bodyHas(call, "有未应用的修改")) === true,
    { enabledNow },
  );
  const fApply = await focusEl(call, `document.querySelector('[data-recording-apply]')`);
  if (fApply !== "focused") throw new Error("保存并应用不可聚焦");
  await pressEnter(call);
  const deadlineRunning = Date.now() + 20000;
  let proxyNow = null;
  for (;;) {
    proxyNow = await H.storeQ(call, `return JSON.stringify(s.proxy);`);
    if (proxyNow.running === true) break;
    if (Date.now() > deadlineRunning)
      throw new Error(`键盘应用后 20s 未监听：${JSON.stringify(proxyNow)}`);
    await H.sleep(600);
  }
  check(
    "#49 真键 ENTER 应用 ⇒ 真实监听（running=true、端口/上游来自已核实草稿）",
    proxyNow.running === true &&
      proxyNow.port === PROXY_PORT &&
      proxyNow.upstreamBaseUrl === UPSTREAM,
    proxyNow,
  );
  const qApply = await focusQuality(call);
  check("#49 焦点可见且有可访问名称（应用后）", qApply.ok === true, qApply);

  // ══ #49 步骤 3：真键 ENTER 复制地址（真剪贴板写入） ══
  const fCopy = await focusEl(call, `document.querySelector('button[aria-label^="复制接入地址"]')`);
  check("#49 复制地址按钮可聚焦（已核实监听 ⇒ 地址可复制）", fCopy === "focused", fCopy);
  await pressEnter(call);
  await H.sleep(800);
  check("#49 真键 ENTER 复制地址 ⇒「已复制」反馈在场", (await bodyHas(call, "已复制")) === true);

  // 外部受控请求（key 捕获 + 代理 run；外部应用流量不是用户键盘动作，node 侧发起）
  await mockReset({ turns: [SCRIPT_PLAIN_TURN], fallback: { content: "（剧本耗尽）" } });
  await externalRequest(parentProxyMessages);
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
  dump.proxyRunId = proxyRunId;

  // ══ #49 步骤 4：真键 ENTER 查看代理记录（sourceFilter=proxy） ══
  const fRecs = await focusEl(call, `document.querySelector('[data-recording-open-records]')`);
  if (fRecs !== "focused") throw new Error("查看代理记录不可聚焦");
  await pressEnter(call);
  await H.sleep(1500);
  const recState = await H.storeQ(
    call,
    `return JSON.stringify({ view: s.view, filter: s.sourceFilter });`,
  );
  check(
    "#49 真键 ENTER 查看代理记录 ⇒ 轨迹视图 + 代理来源筛选",
    recState.view === "trace" && recState.filter === "proxy",
    recState,
  );

  // ══ #49 步骤 5：编辑重发（列表行/入口激活为真键；阅读页签/选中 span 为 store 口——U7 6.9 同口径） ══
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(proxyRunId)});
     s.setReadingTab(${JSON.stringify(proxyRunId)}, "steps");
     s.selectSpan("s_02");
     return JSON.stringify("ok");`,
  );
  await H.sleep(1400);
  const fEntry = await focusEl(call, `document.querySelector('[data-messages-workspace-entry]')`);
  check("#49 messages 工作区入口可聚焦（代理 run 自有调用）", fEntry === "focused", fEntry);
  await pressEnter(call);
  await H.sleep(2000);
  const wsState = await H.storeQ(
    call,
    `return JSON.stringify({ view: s.view, target: s.messagesTarget });`,
  );
  check(
    "#49 真键 ENTER 打开 messages 工作区（目标显式绑定）",
    wsState.view === "messages" && wsState.target?.runId === proxyRunId,
    wsState,
  );

  // 真剪贴板粘贴编辑（真 CTRL+A/CTRL+V；编辑后的 messages 为合法 JSON 数组）
  const mono0 = await waitMonaco(call, 2);
  const baseline = JSON.parse(mono0.editors.find((e) => e.readOnly)?.value ?? "[]");
  const edited = JSON.parse(JSON.stringify(baseline));
  edited[edited.length - 1].content = "U8 6.11 真键盘粘贴编辑重发。";
  const editedText = JSON.stringify(edited, null, 2);
  await inputPs("clipboard", ["-Value", editedText]);
  const pasted = await pasteIntoDraftMonaco(call, editedText);
  check("#49 真键粘贴编辑：草稿 = 剪贴板原文（逐字）", pasted === editedText, {
    pastedLen: (pasted ?? "").length,
    expectLen: editedText.length,
  });

  // 真键确认 + 重发
  const fConf = await focusEl(call, `document.querySelector('[data-confirm-execution]')`);
  if (fConf !== "focused") throw new Error("重发确认按钮不可聚焦");
  await pressEnter(call);
  await H.sleep(900);
  const pressed = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-confirm-execution]')?.getAttribute('aria-pressed'))`,
  ).then(JSON.parse);
  check("#49 真键 ENTER 确认重发（核对凭据挂上）", pressed === "true", pressed);

  await mockReset({
    turns: [{ content: "重发受控响应。", delayMs: 1200 }],
    fallback: { content: "（剧本耗尽）" },
  });
  const idsBeforeResend = new Set(H.traceIds());
  const fResend = await focusEl(
    call,
    `Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '确认重发')`,
  );
  if (fResend !== "focused") throw new Error("确认重发按钮不可聚焦");
  await pressEnter(call);
  const deadlineFork = Date.now() + 25000;
  for (;;) {
    if (H.traceIds().size >= idsBeforeResend.size + 1) break;
    if (Date.now() > deadlineFork) throw new Error("重发 25s 未落盘");
    await H.sleep(400);
  }
  await H.sleep(800);
  const recFork = await waitSettled(call, "proxy", [], 30000);
  const forkId = recFork.runIds[0];
  const forkRun = readRunFile(forkId);
  check(
    "#49 真键 ENTER 重发 ⇒ 真实 fork 落盘（单请求、messages = 粘贴编辑值）",
    recFork.runIds.length === 1 &&
      forkRun.meta.parent === proxyRunId &&
      forkRun.meta.fork?.edit?.field === "messages" &&
      JSON.stringify(forkRun.llms[0].request.messages) === JSON.stringify(edited),
    { parent: forkRun.meta.parent, field: forkRun.meta.fork?.edit?.field },
  );
  const nav1 = await waitAutoNav(call, forkId);
  check(
    "#49 收口自动导航到结果 run（U5 导航意图；随后键盘返回）",
    nav1.view === "trace" && nav1.sel === forkId,
    nav1,
  );
  dump.forkId = forkId;

  // ══ #49 步骤 6：真键重进 + 返回来源 ══
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(proxyRunId)});
     s.setReadingTab(${JSON.stringify(proxyRunId)}, "steps");
     s.selectSpan("s_02");
     return JSON.stringify("ok");`,
  );
  await H.sleep(1400);
  const fEntry2 = await focusEl(call, `document.querySelector('[data-messages-workspace-entry]')`);
  if (fEntry2 !== "focused") throw new Error("重进入口不可聚焦");
  await pressEnter(call);
  await H.sleep(1800);
  const reState = await H.storeQ(call, `return JSON.stringify({ view: s.view });`);
  check("#49 真键重进 messages 工作区", reState.view === "messages", reState);
  // 不困焦点：从工作区头部 TAB 有界步进可达全局栏（页头）
  const fHead = await focusEl(
    call,
    `document.querySelector('#run-navigation-toggle') ?? document.querySelector('header button')`,
  );
  const escapeTab = await tabUntil(
    call,
    40,
    `(() => {
       const el = document.activeElement;
       const header = el && el.closest('header');
       return header ? 'true' : 'false';
     })()`,
  );
  check(
    "#49 工作区不困焦点：TAB 有界步进可达页头",
    fHead === "focused" && escapeTab.found === true,
    {
      steps: escapeTab.steps,
      at: escapeTab.desc,
    },
  );
  const fRet = await focusEl(
    call,
    `Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === '返回来源' && !b.disabled)`,
  );
  if (fRet !== "focused") throw new Error("返回来源不可聚焦");
  await pressEnter(call);
  await H.sleep(1800);
  const backState = await H.storeQ(
    call,
    `return JSON.stringify({ view: s.view, sel: s.selectedRunId,
       tab: s.selectedRunId ? s.readingOf(s.selectedRunId).tab : null, span: s.selectedSpanId });`,
  );
  check(
    "#49 真键 ENTER 返回来源 ⇒ 恢复来源视图与阅读位置（proxy run · steps · s_02）",
    backState.view === "trace" &&
      backState.sel === proxyRunId &&
      backState.tab === "steps" &&
      backState.span === "s_02",
    backState,
  );
  const qBack = await H.ev(
    call,
    `(() => {
       const el = document.activeElement;
       if (el === null || el === document.body) return JSON.stringify({ ok: false, reason: 'no-focus' });
       const anchored = el.tagName === 'MAIN' || el.getAttribute('data-aux-frame') === 'true';
       return JSON.stringify({ ok: anchored, tag: el.tagName, aux: el.getAttribute('data-aux-frame') });
     })()`,
  ).then(JSON.parse);
  check(
    "#49 返回后焦点有效（落回来源视图容器 main / data-aux-frame，不落 body）",
    qBack.ok === true,
    qBack,
  );

  // ══ #50 键盘实验→比较闭环 ══
  await mockReset({ turns: [SCRIPT_PLAIN_TURN], fallback: { content: "（剧本耗尽）" } });
  const parentP = await createParent(call, "6.11");
  dump.parentP = parentP;
  await openExperimentFor(call, parentP);

  // 增臂（真键 ENTER）
  const fAdd = await focusEl(
    call,
    `Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim().startsWith('+ 加一臂'))`,
  );
  check("#50 + 加一臂可聚焦", fAdd === "focused", fAdd);
  await pressEnter(call);
  await H.sleep(700);
  const rowsAfterAdd = await armRowsCount(call);
  // 删臂（真键 ENTER；第三行的 ✕）
  const fDel = await focusEl(
    call,
    `(() => {
       const rows = Array.from(document.querySelectorAll('div'))
         .filter(d => typeof d.className === 'string' && d.className.includes('border-sky-200') && d.querySelector('input[placeholder="model 名"]'));
       const x = rows[2] && Array.from(rows[2].querySelectorAll('button')).find(b => (b.textContent || '').trim() === '✕');
       return x ?? null;
     })()`,
  );
  check("#50 第三行 ✕（删臂）可聚焦", fDel === "focused", fDel);
  await pressEnter(call);
  await H.sleep(700);
  const rowsAfterDel = await armRowsCount(call);
  check(
    "#50 真键增删臂：3 行 → 删回 2 行（臂身份由行序承载）",
    rowsAfterAdd === 3 && rowsAfterDel === 2,
    {
      rowsAfterAdd,
      rowsAfterDel,
    },
  );
  await setArm(call, 0, "deepseek-chat", '{"temperature":0.3}');
  await setArm(call, 1, "deepseek-reasoner", "{}");
  await H.sleep(400);

  // 预览（真键 ENTER；dry-run 零调用）
  const servedPrePreview = await mockServed();
  const fPreview = await focusEl(
    call,
    `Array.from(document.querySelectorAll('button')).find(b => { const t = (b.textContent || '').trim(); return t === '校验并预览计划' || t === '重新校验'; })`,
  );
  if (fPreview !== "focused") throw new Error("预览按钮不可聚焦");
  await pressEnter(call);
  const deadlinePlan = Date.now() + 20000;
  for (;;) {
    if ((await bodyHas(call, "校验通过 · 执行计划")) === true) break;
    if (Date.now() > deadlinePlan) throw new Error("预览 20s 未出计划");
    await H.sleep(500);
  }
  check(
    "#50 真键 ENTER 预览 ⇒ 计划在场（dry-run 零调用：served 计数不变）",
    (await mockServed()) === servedPrePreview,
    {
      served: [servedPrePreview, await mockServed()],
    },
  );

  // 放弃确认：模态约束焦点 + 支持取消（真键；A/B 的放弃按钮文本 =「放弃整批」）
  const fDiscard = await focusEl(
    call,
    `Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '放弃整批')`,
  );
  if (fDiscard !== "focused") throw new Error("放弃修改不可聚焦");
  await pressEnter(call);
  await H.sleep(800);
  const modalState = await H.ev(
    call,
    `(() => {
       const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
       if (!dlg) return JSON.stringify(null);
       const inDialog = dlg.contains(document.activeElement);
       const initial = (document.activeElement.textContent || '').trim();
       return JSON.stringify({ open: true, inDialog, initial });
     })()`,
  ).then(JSON.parse);
  check(
    "#50 放弃确认模态：打开且初始焦点在模态内（安全缺省 = 取消）",
    modalState !== null && modalState.inDialog === true,
    modalState,
  );
  await pressTab(call);
  await pressTab(call);
  const stillIn = await H.ev(
    call,
    `(() => { const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
       return JSON.stringify(dlg ? dlg.contains(document.activeElement) : false); })()`,
  ).then(JSON.parse);
  check("#50 放弃确认模态：TAB×2 焦点不逃逸", stillIn === true, stillIn);
  await pressEsc(call);
  await H.sleep(700);
  const modalClosed = await H.ev(
    call,
    `JSON.stringify(document.querySelector('dialog[open]') === null)`,
  ).then(JSON.parse);
  const planStill = await bodyHas(call, "校验通过 · 执行计划");
  check(
    "#50 ESC 取消 ⇒ 模态关闭、计划与草稿保留（支持取消）",
    modalClosed === true && planStill === true,
    {
      modalClosed,
      planStill,
    },
  );

  // 确认 + 执行（真键 ENTER）
  const fConf2 = await focusEl(call, `document.querySelector('[data-confirm-execution]')`);
  if (fConf2 !== "focused") throw new Error("实验确认不可聚焦");
  await pressEnter(call);
  await H.sleep(900);
  const pressed2 = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-confirm-execution]')?.getAttribute('aria-pressed'))`,
  ).then(JSON.parse);
  check("#50 真键 ENTER 确认执行（核对挂上）", pressed2 === "true", pressed2);

  await mockReset({
    turns: [{ content: "臂受控回答。" }, { content: "臂受控回答。" }],
    fallback: { content: "（剧本耗尽）" },
  });
  const fExec = await focusEl(
    call,
    `Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim().startsWith('确认执行'))`,
  );
  if (fExec !== "focused") throw new Error("执行按钮不可聚焦");
  await pressEnter(call);
  const recBatch = await waitSettled(call, "modelAb", [], 60000);
  check(
    "#50 真键 ENTER 执行 ⇒ 真实批次落盘、臂身份可辨（两臂 returned、runIds 逐臂）",
    recBatch.arms.length === 2 &&
      recBatch.arms.every((a) => a.outcome === "returned") &&
      recBatch.runIds.length === 2,
    recBatch.arms.map((a) => a.outcome),
  );

  // 选两条比较（真键）：结果区两臂「加入对照」→ 进入比较 → 返回来源
  await H.sleep(1200);
  const fCmp1 = await focusEl(
    call,
    `(() => {
       const c = document.querySelector('[data-ab-batch-result="${recBatch.operationId}"]');
       if (!c) return null;
       return Array.from(c.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '加入对照') ?? null;
     })()`,
  );
  check("#50 结果区「加入对照」可聚焦", fCmp1 === "focused", fCmp1);
  await pressEnter(call);
  await H.sleep(600);
  const fCmp2 = await focusEl(
    call,
    `(() => {
       const c = document.querySelector('[data-ab-batch-result="${recBatch.operationId}"]');
       // 第一条加入后文本翻转为「移出对照」⇒ 剩余「加入对照」的第一个即第二条臂
       return Array.from(c.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '加入对照') ?? null;
     })()`,
  );
  if (fCmp2 !== "focused") throw new Error("第二条「加入对照」不可聚焦");
  await pressEnter(call);
  await H.sleep(600);
  const selState = await H.storeQ(call, `return JSON.stringify({ ids: s.compareIds });`);
  check("#50 真键选两条：对照集合 = 两臂", selState.ids.length === 2, selState);
  const fEnter = await focusEl(call, `document.querySelector('[data-experiment-enter-compare]')`);
  if (fEnter !== "focused") throw new Error("进入比较不可聚焦");
  await pressEnter(call);
  await H.sleep(2500);
  const cmpState = await H.storeQ(
    call,
    `const c = s.compareRead.conclusion;
     return JSON.stringify({ view: s.view, pair: s.comparePair, retLoc: s.compareReturnLocation === null ? null : s.compareReturnLocation.view,
       concl: c === null ? null : { kind: c.kind, n: c.items ? c.items.length : null } });`,
  );
  check(
    "#50 真键进入比较：pair 成立、结论 verified、来源记实验工作区",
    cmpState.view === "compare" &&
      cmpState.pair !== null &&
      cmpState.concl?.kind === "verified" &&
      cmpState.retLoc === "experiment",
    cmpState,
  );
  const fRet2 = await focusEl(
    call,
    `Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === '返回来源' && !b.disabled)`,
  );
  if (fRet2 !== "focused") throw new Error("比较返回来源不可聚焦");
  await pressEnter(call);
  await H.sleep(1800);
  const back50 = await H.storeQ(
    call,
    `return JSON.stringify({ view: s.view, target: s.experimentTarget });`,
  );
  check(
    "#50 真键返回 ⇒ 回到原实验目标（比较返回到原实验目标）",
    back50.view === "experiment" && back50.target !== null && back50.target.runId === parentP,
    back50,
  );

  // 收尾：停代理（keyboard-apply 开的；状态由 recording-dirty 段接手前保持干净语义）
  await H.storeQ(
    call,
    `await s.toggleProxy(JSON.parse(${JSON.stringify(JSON.stringify({ enabled: false, port: PROXY_PORT, upstreamBaseUrl: UPSTREAM }))}));
     return JSON.stringify("ok");`,
  );
  const servedFinal = await mockServed();
  check("#50 前置收尾：批段恰 2 次上游调用（两臂，最后一段 reset 后计数）", servedFinal === 2, {
    served: servedFinal,
  });
  note(
    "#49「复制/读取失败有可感知反馈」：复制失败分支本环境不可真实诱发（Electron 剪贴板恒可用）⇒ 反馈文案与分支由 LongText/6.6 判据承载。",
  );
  note(
    "#50「打开失败或选两条比较」为 OR 分支：本批走选两条比较；打开失败（错误定位键盘路径）由结果区键盘可达性（同批加入对照/动作按钮同为 button）与 U5 判据承载。",
  );
}

// ---------------------------------------------------------------------------
// tag：recording-dirty（#24 + #25）
// ---------------------------------------------------------------------------

const dirtyCountRead = (call) =>
  H.storeQ(
    call,
    `const storeUrl = performance.getEntriesByType('resource').map(e => e.name)
       .filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
     if (!storeUrl) return JSON.stringify({ error: 'store-url-not-found' });
     const st = (await import(storeUrl)).useAppStore.getState();
     const dl = await import(new URL('./lib/draft-list.ts', storeUrl).href);
     return JSON.stringify({ count: dl.sessionDirtyCountOf(st.drafts, st.recordingDraft) });`,
  );

async function tagRecordingDirty(call) {
  const SETTINGS = join(H.REPO, ".rebaseagent", "settings.json");
  const settingsFingerprint = () =>
    H.createHash("sha256").update(readFileSync(SETTINGS)).digest("hex");
  const fp0 = settingsFingerprint();

  // 进录制工作区（store 口；本 tag 非键盘闭环节点）
  await H.storeQ(call, `s.openRecordingWorkspace(); return JSON.stringify("ok");`);
  await H.sleep(1000);

  // ── #25 未修改默认表单不误报 dirty ──
  const dirtyClean = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-recording-dirty]') === null)`,
  ).then(JSON.parse);
  const dirtyCountClean = await dirtyCountRead(call);
  check(
    "#25 未修改默认表单不误报：无 dirty 标记 + 会话 dirty 计数为 0",
    dirtyClean === true && dirtyCountClean.count === 0,
    { dirtyClean, count: dirtyCountClean },
  );

  // ── #24 修改端口 ⇒ dirty；真键打开放弃确认 → ESC 取消（输入保持） ─═
  await H.typeIntoDom(call, "[data-recording-port]", "19055");
  await H.sleep(700);
  const dirtyNow = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-recording-dirty]') !== null)`,
  ).then(JSON.parse);
  const dirtyCountNow = await dirtyCountRead(call);
  check(
    "#25 仅录制草稿未应用 ⇒ 计入会话 dirty 计数（单独成条）",
    dirtyNow === true && dirtyCountNow.count >= 1,
    { dirtyNow, count: dirtyCountNow },
  );

  MAIN_PID = await resolveMainPid();
  await raiseForeground();
  const fDiscard = await focusEl(call, `document.querySelector('[data-recording-discard]')`);
  if (fDiscard !== "focused") throw new Error("放弃修改不可聚焦");
  await pressEnter(call);
  await H.sleep(800);
  const modal1 = await H.ev(
    call,
    `(() => {
       const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
       if (!dlg) return JSON.stringify(null);
       return JSON.stringify({ open: true, inDialog: dlg.contains(document.activeElement),
         initial: (document.activeElement.textContent || '').trim() });
     })()`,
  ).then(JSON.parse);
  check(
    "#24 放弃确认模态打开（初始焦点在取消——破坏性动作安全缺省）",
    modal1 !== null && modal1.inDialog === true && modal1.initial === "取消",
    modal1,
  );
  await pressEsc(call);
  await H.sleep(700);
  const portAfterCancel = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-recording-port]').value)`,
  ).then(JSON.parse);
  const dirtyAfterCancel = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-recording-dirty]') !== null)`,
  ).then(JSON.parse);
  check(
    "#24 取消放弃：输入逐字保持、dirty 仍在（取消保持输入）",
    portAfterCancel === "19055" && dirtyAfterCancel === true,
    { portAfterCancel, dirtyAfterCancel },
  );
  check("#24 取消零配置写调用：settings 字节不变、监听状态不变", settingsFingerprint() === fp0, {
    fp: [fp0.slice(0, 12), settingsFingerprint().slice(0, 12)],
  });

  // ── #24 确认放弃（匹配修订）⇒ 恢复已核实配置基线，不重新 toggle ──
  const fDiscard2 = await focusEl(call, `document.querySelector('[data-recording-discard]')`);
  if (fDiscard2 !== "focused") throw new Error("放弃修改不可聚焦（二）");
  await pressEnter(call);
  await H.sleep(800);
  const fConfirm = await focusEl(
    call,
    `(() => { const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
       return dlg ? Array.from(dlg.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '确认放弃') ?? null : null; })()`,
  );
  if (fConfirm !== "focused") throw new Error("确认放弃按钮不可聚焦");
  const proxyBefore = await H.storeQ(
    call,
    `return JSON.stringify({ running: s.proxy.running, enabled: s.proxy.enabled });`,
  );
  await pressEnter(call);
  await H.sleep(900);
  const portAfterDiscard = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-recording-port]').value)`,
  ).then(JSON.parse);
  const dirtyGone = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-recording-dirty]') === null)`,
  ).then(JSON.parse);
  const proxyAfter = await H.storeQ(
    call,
    `return JSON.stringify({ running: s.proxy.running, enabled: s.proxy.enabled });`,
  );
  check(
    "#24 匹配修订确认放弃：恢复已核实配置基线（端口回到已保存值）、dirty 消失",
    portAfterDiscard !== "19055" && dirtyGone === true,
    { portAfterDiscard, dirtyGone },
  );
  check(
    "#24 放弃不重新 toggle：监听状态前后不变（零配置写通道）",
    proxyBefore.running === proxyAfter.running &&
      proxyBefore.enabled === proxyAfter.enabled &&
      settingsFingerprint() === fp0,
    { before: proxyBefore, after: proxyAfter, settingsUnchanged: settingsFingerprint() === fp0 },
  );

  note(
    "#24「确认打开后输入修订改变 ⇒ 旧确认不能删除新输入」的竞争无法在真机确定性诱发（需在模态打开窗口内并发改草稿）⇒ 由 recording-draft-store 的 CAS 单元承载并单列（2.2 注记 + 6.3 反证）。",
  );
  note(
    "#25「与其他草稿/活跃操作并存时的合并退出确认」需要真实窗口关闭触发关闭协商（main↔renderer 握手）⇒ CDP 内无法不杀进程地真实触发 ⇒ 由 draft-close-client / draft-close-guard / use-draft-close-guard 单元承载并单列；本批实机承载其输入口径（sessionDirtyCountOf 计入录制 dirty、未修改不误报）。",
  );
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
