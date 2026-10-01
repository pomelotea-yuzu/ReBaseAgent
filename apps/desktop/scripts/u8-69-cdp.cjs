/* eslint-disable */
/**
 * U8 任务 6.9（Electron 实机第四批）：合法/不可比结果进入 U7、2/3/4/第5条、返回实验；
 * messages→录制→返回→受控重发/失败与被动交错；无新增执行权限。
 *
 * 三个 tag（run-all 编排；compare 不需要代理，messages 两段以真实 dev 重启分隔）：
 * - compare-experiment：真实执行两父本三批 ⇒ 结果区选 2/3/4 条进比较、第 5 条拒绝、
 *   异父混选 [PARENT_DIFFERS] 拒绝 + 返回实验批次事实原样（顺带 #52–#55 批次分组形态）；
 * - messages-live：真实代理启停（store toggleProxy → 真 IPC → main 真监听；录制 UI 应用路径
 *   已由 6.6 实机承载）→ 外部受控请求产生代理 run → messages 工作区：未修改禁用 /
 *   非法原文跨页逐字恢复 / 确认披露单请求边界 / 受控重发成功 + 在飞被动交错不借被动记录 /
 *   失败批（upstream 503）草稿逐字保留 + 返回编辑 / 停用代理仍有凭据（顺序有牙）；
 * - messages-restart：dev 重启后 key 仅内存暂存失效（autoStart 运行中 hasKey=false）⇒
 *   历史仍可读 + 未捕获 key 就近录制入口 → 转录制真实捕获 key → 返回精确编辑（草稿逐字）→
 *   重发闭环。
 *
 * 「无新增执行权限」判据 = mock served 分段计数 + 登记身份核对（重发只经 proxy:fork
 * 单请求、登记 runIds 只含本次 fork id；被动录制没有登记身份，结构上进不了结果区）。
 *
 * 用法：`node apps/desktop/scripts/u8-69-cdp.cjs --tag=<compare-experiment|messages-live|messages-restart>`
 * 前置：dev 已由 run-all 起（CDP 9612）；mock-llm 18799 已起（剧本由本探针分段切换）；
 * messages-restart 需 run-all 传 --proxy-run=<messages-live 录制的代理 run id>。
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
const TAG = arg("tag", "compare-experiment");
const PROXY_RUN_ARG = arg("proxy-run", "");
const PROXY_PORT = 19001;
const UPSTREAM = H.MOCK_UPSTREAM; // http://127.0.0.1:18799（无 /v1，handler 自拼路径）

const OUT_DIR = join(H.REPO, ".workbuddy", "u8", "u8-69");
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

/** mock 控制端点（node 侧直调） */
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

/** 外部受控应用请求：POST 经录制代理（真实转发 + 真实落盘 + 真实 key 捕获） */
function externalRequest(messages, { stream = false, key = "Bearer sk-u8-69-external" } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "deepseek-chat", messages, stream });
    const req = http.request(
      `http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: key,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () => resolve({ status: res.status, bytes: data.length }));
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

const proxyRecords = (call) =>
  H.storeQ(
    call,
    `const recs = s.operations.operations.filter(o => o.target && o.target.kind === 'proxy');
     return JSON.stringify(recs.map(o => ({
       operationId: o.operationId, epoch: o.epoch, state: o.state,
       runIds: o.runIds, parentRunId: o.target.parentRunId, atSpanId: o.target.atSpanId,
     })));`,
  );
const abRecords = (call) =>
  H.storeQ(
    call,
    `const recs = s.operations.operations.filter(o => o.target && o.target.kind === 'modelAb');
     return JSON.stringify(recs.map(o => ({
       operationId: o.operationId, epoch: o.epoch, state: o.state, armCount: o.target.armCount,
       arms: o.arms, runIds: o.runIds, experimentId: o.experimentId, parentRunId: o.target.parentRunId,
     })));`,
  );
const registrationsSnapshot = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       proxy: s.operations.operations.filter(o => o.target && o.target.kind === 'proxy').map(o => [o.operationId, o.state, o.runIds]),
       modelAb: s.operations.operations.filter(o => o.target && o.target.kind === 'modelAb').map(o => [o.operationId, o.state, o.runIds]),
       reads: Object.keys(s.resultReads.byKey),
     });`,
  );

/** 登记快照差集（storeQ 已返回解析对象；键序不敏感；输出 added/missing） */
function registrationsDiff(before, after) {
  const recKey = (r) => r.join("|");
  const report = {};
  for (const part of ["proxy", "modelAb"]) {
    const bs = new Set(before[part].map(recKey));
    const as = new Set(after[part].map(recKey));
    const added = after[part].filter((r) => !bs.has(recKey(r)));
    const missing = before[part].filter((r) => !as.has(recKey(r)));
    if (added.length > 0 || missing.length > 0) report[part] = { added, missing };
  }
  const bReads = new Set(before.reads);
  const aReads = new Set(after.reads);
  const readsAdded = after.reads.filter((k) => !bReads.has(k));
  const readsMissing = before.reads.filter((k) => !aReads.has(k));
  if (readsAdded.length > 0 || readsMissing.length > 0)
    report.reads = { added: readsAdded, missing: readsMissing };
  return report;
}

/** 等 U5 导航意图落地（messages 提交在流程内收口 ⇒ 自动跳到结果 run） */
async function waitAutoNav(call, expectRunId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await H.storeQ(
      call,
      "return JSON.stringify({ view: s.view, sel: s.selectedRunId });",
    );
    if (st.view === "trace" && st.sel === expectRunId) return st;
    if (Date.now() > deadline) return st;
    await H.sleep(500);
  }
}

/** 等结果区出现至少 minCount 块（重入工作区后派生与核实落地有延迟） */
async function waitMessagesBlocks(call, minCount, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dom = await resultsDom(call);
    if (dom.hasResults === true && dom.blockCount >= minCount) return dom;
    if (Date.now() > deadline) return dom;
    await H.sleep(500);
  }
}

/** 等待一条**新**的 proxy 登记收口（exclude = 已见的 operationId） */
async function waitProxySettled(call, exclude, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recs = await proxyRecords(call);
    const fresh = recs.find((o) => o.state === "settled" && !exclude.includes(o.operationId));
    if (fresh) return fresh;
    if (Date.now() > deadline)
      throw new Error(`代理登记收口 ${timeoutMs / 1000}s 未到：${JSON.stringify(recs)}`);
    await H.sleep(700);
  }
}

const resultsDom = (call) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('[data-messages-results]');
       const blocks = Array.from(document.querySelectorAll('[data-messages-result]'));
       return JSON.stringify({
         hasResults: sec !== null,
         blockCount: blocks.length,
         blockOps: blocks.map(b => b.getAttribute('data-messages-result')),
         text: sec ? sec.textContent.slice(0, 4000) : '',
       });
     })()`,
  ).then(JSON.parse);

const expResultsDom = (call) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('[data-experiment-results]');
       const batches = Array.from(document.querySelectorAll('[data-experiment-batch]'));
       const enter = document.querySelector('[data-experiment-enter-compare]');
       return JSON.stringify({
         hasResults: sec !== null,
         batchOps: batches.map(b => b.getAttribute('data-experiment-batch')),
         labels: batches.map(b => b.textContent.slice(0, 240)),
         enterLabel: enter ? enter.textContent.trim() : null,
         enterDisabled: enter ? enter.disabled : null,
       });
     })()`,
  ).then(JSON.parse);

/** 结果区指定批次内的对照选择按钮（加入对照 → 点击；已选的跳过） */
async function toggleArmCompare(call, operationId, nth) {
  const r = await H.ev(
    call,
    `(() => {
       const container = document.querySelector('[data-ab-batch-result="${operationId}"]');
       if (!container) return 'no-batch';
       const btns = Array.from(container.querySelectorAll('button'))
         .filter(b => ((b.textContent || '').trim() === '加入对照' || (b.textContent || '').trim() === '移出对照'));
       const b = btns[${nth}];
       if (!b) return 'no-button:' + btns.length;
       if (b.disabled) return 'disabled';
       if ((b.textContent || '').trim() === '移出对照') return 'already';
       b.click(); return 'clicked';
     })()`,
  );
  if (r !== "clicked" && r !== "already")
    throw new Error(`批次 ${operationId} 臂 ${nth} 对照选择失败：${r}`);
  await H.sleep(700);
}

async function clickEnterCompare(call) {
  const r = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-experiment-enter-compare]');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error("「进入比较」按钮不可点");
}

/** 等比较结论落地（进入/换集/重读都是异步读取） */
async function waitCompareConclusion(call, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = await H.storeQ(
      call,
      `const c = s.compareRead.conclusion;
       return JSON.stringify(c === null ? null : { kind: c.kind, code: c.code ?? null, n: c.items ? c.items.length : null });`,
    );
    if (c !== null) return c;
    if (Date.now() > deadline) throw new Error("比较结论 20s 未落地");
    await H.sleep(600);
  }
}

async function clickReturnSource(call) {
  const r = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => x.getAttribute('aria-label') === '返回来源' && !x.disabled);
       if (!b) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error("「返回来源」按钮不可点");
  await H.sleep(1800);
}

async function clickResend(call) {
  const r = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent || '').trim()) === '确认重发');
       if (!b) return 'no-button'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; })()`,
  );
  if (r !== "clicked") throw new Error(`「确认重发」不可点：${r}`);
}

async function clickMessagesEntry(call) {
  const r = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-messages-workspace-entry]');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error("「编辑 messages 重发」入口不可点");
}

/** 打开某 run 的 llm.call 详情（步骤页 + 选中 span —— 与 openCompareSideError 同一 store 口） */
async function openLlmCallDetail(call, runId, spanId) {
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(runId)});
     s.setReadingTab(${JSON.stringify(runId)}, "steps");
     s.selectSpan(${JSON.stringify(spanId)});
     return JSON.stringify("ok");`,
  );
  await H.sleep(1600);
}

/** 等 Monaco 编辑器就绪（懒加载；bootstrap 模块 URL 可能尚未进 resource entries ⇒ 防御轮询） */
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

const resendButtonState = (call) =>
  H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent || '').trim()) === '确认重发');
       return JSON.stringify(b === null ? null : { disabled: b.disabled }); })()`,
  ).then(JSON.parse);

const bodyHas = (call, text) =>
  H.ev(
    call,
    `JSON.stringify((document.body.textContent || '').includes(${JSON.stringify(text)}))`,
  ).then(JSON.parse);

const messagesStoreState = (call, runId) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       view: s.view,
       target: s.messagesTarget,
       recLoc: s.recordingReturnLocation === null ? null : { view: s.recordingReturnLocation.view },
       msgLoc: s.messagesReturnLocation === null ? null : { view: s.messagesReturnLocation.view },
       draftText: (() => { const d = s.callDraftOf(JSON.parse(${JSON.stringify(JSON.stringify({ runId, spanId: "s_02", field: "messages" }))})); return d ? d.text : null; })(),
       proxy: s.proxy,
     });`,
  );

// ---------------------------------------------------------------------------
// 创建父本与实验批（与 6.8 同一已验证编排）
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

async function armAndPreview(call) {
  const r = await H.ev(
    call,
    `(() => {
       const rows = Array.from(document.querySelectorAll('div'))
         .filter(d => typeof d.className === 'string' && d.className.includes('border-sky-200') && d.querySelector('input[placeholder="model 名"]'));
       const set = (el, v) => {
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         setter.call(el, v);
         el.dispatchEvent(new Event('input', { bubbles: true }));
       };
       if (rows.length < 2) return JSON.stringify({ error: 'rows<2', matched: rows.length });
       set(rows[0].querySelectorAll('input')[0], 'deepseek-chat');
       set(rows[0].querySelectorAll('input')[1], '{"temperature":0.2}');
       set(rows[1].querySelectorAll('input')[0], 'deepseek-reasoner');
       set(rows[1].querySelectorAll('input')[1], '{}');
       return JSON.stringify({ ok: true });
     })()`,
  ).then(JSON.parse);
  if (r.ok !== true) throw new Error(`配臂失败：${JSON.stringify(r)}`);
  await H.sleep(500);
  await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button'))
         .find(x => { const t = (x.textContent || '').trim(); return t === '校验并预览计划' || t === '重新校验'; });
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((x) => {
    if (x !== true) throw new Error("预览按钮不可点");
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    const has = await bodyHas(call, "校验通过 · 执行计划");
    if (has === true) break;
    if (Date.now() > deadline) throw new Error("预览 20s 未出计划");
    await H.sleep(500);
  }
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-confirm-execution]'); b.click(); return true; })()`,
  );
  await H.sleep(900);
  const pressed = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-confirm-execution]')?.getAttribute('aria-pressed'))`,
  ).then(JSON.parse);
  if (pressed !== "true") throw new Error(`实验确认未挂上：${pressed}`);
}

async function executeBatch(call, knownOpIds) {
  const r = await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button'))
         .find(x => (x.textContent || '').trim().startsWith('确认执行'));
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error("执行按钮不可点");
  const deadline = Date.now() + 60000;
  for (;;) {
    const recs = await abRecords(call);
    const rec = recs.find((o) => o.state === "settled" && !knownOpIds.has(o.operationId));
    if (rec) {
      knownOpIds.add(rec.operationId);
      return rec;
    }
    if (Date.now() > deadline) throw new Error(`批次收口 60s 未到：${JSON.stringify(recs)}`);
    await H.sleep(800);
  }
}

/** 读一份 run 落盘（meta / 全部 llm.call / 终态行） */
function readRunFile(runId) {
  const lines = readFileSync(join(H.TRACES, `${runId}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return {
    meta: lines[0],
    llms: lines.filter((o) => o.kind === "llm.call"),
    terminal: lines[lines.length - 1],
  };
}

/** 等到 traces 里出现 delta 份新 run 并返回新 id 列表 */
async function waitNewRuns(beforeSet, expect, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const fresh = [...H.traceIds()].filter((id) => !beforeSet.has(id));
    if (fresh.length >= expect) return fresh;
    if (Date.now() > deadline) throw new Error(`新 run 落盘超时（${fresh.length}/${expect}）`);
    await H.sleep(400);
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
  // ⚠️ 等列表真加载（6.7 坐实：空列表早退 ⇒ store 未水合判据全假）
  for (let i = 0; i < 80; i++) {
    await H.sleep(500);
    try {
      if ((await H.runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间 */
    }
  }
  await H.sleep(900);
  // reload 未换文档哨兵（U4 6.6 坑）
  const sentinel = await H.ev(call, "window.__u869Doc ?? null").catch(() => null);
  if (sentinel === "sentinel") {
    await call("Page.reload", { ignoreCache: true });
    await H.sleep(3000);
    for (let i = 0; i < 80; i++) {
      await H.sleep(500);
      try {
        if ((await H.runs(call)).length > 0) break;
      } catch {
        /* 重载瞬间 */
      }
    }
    await H.sleep(900);
  }

  const tracesBaseline = H.traceIds().size;

  if (TAG === "compare-experiment") {
    await tagCompareExperiment(call);
  } else if (TAG === "messages-live") {
    await tagMessagesLive(call);
  } else if (TAG === "messages-restart") {
    await tagMessagesRestart(call);
  } else {
    throw new Error(`未知 tag：${TAG}`);
  }

  dump.traces = { baseline: tracesBaseline, final: H.traceIds().size };
  await H.shot(call, SHOT_DIR, `${TAG}.png`);
  finish();
}

// ---------------------------------------------------------------------------
// tag：compare-experiment（#40 #41 + 顺带 #52–#55）
// ---------------------------------------------------------------------------

async function tagCompareExperiment(call) {
  const knownOps = new Set();

  // ── 父本 1 + 两批（各 [ok, ok]，同配置两批 = #55 的「同父同模型」面）──
  await mockReset({ turns: [SCRIPT_PLAIN_TURN], fallback: { content: "（剧本耗尽）" } });
  const parent1 = await createParent(call, "6.9p1");
  dump.parent1 = parent1;

  await mockReset({
    turns: [{ content: "臂受控回答。" }, { content: "臂受控回答。" }],
    fallback: { content: "（剧本耗尽）" },
  });
  await openExperimentFor(call, parent1);
  await armAndPreview(call);
  const emptyState = await expResultsDom(call);
  check(
    "#54 预览（dry-run）不产生批次：计划在场而批次区仍为空态",
    emptyState.hasResults === true && emptyState.batchOps.length === 0,
    emptyState,
  );
  const rec1 = await executeBatch(call, knownOps);
  let served = await mockServed();
  check("#52 前置：批 1 恰 2 次调用（分段计数）", served === 2, { served });

  await mockReset({
    turns: [{ content: "臂受控回答。" }, { content: "臂受控回答。" }],
    fallback: { content: "（剧本耗尽）" },
  });
  // 批 1 完整成功 ⇒ 草稿按提交修订自动清理，臂行随之消失（ensure 的 effect 只在挂载时跑）
  // ⇒ 离开再重进工作区触发重挂载 ensure（幂等，重新登记两臂基线）——真实用户路径。
  await H.storeQ(call, `s.setView("trace"); return JSON.stringify("ok");`);
  await H.sleep(600);
  await openExperimentFor(call, parent1);
  await armAndPreview(call);
  const rec2 = await executeBatch(call, knownOps);
  served = await mockServed();
  check("#52 前置：批 2 恰 2 次调用（分段计数）", served === 2, { served });
  check(
    "#52 前置：两批各两臂全 returned（真实执行的可信臂身份）",
    rec1.arms.length === 2 &&
      rec1.arms.every((a) => a.outcome === "returned") &&
      rec2.arms.length === 2 &&
      rec2.arms.every((a) => a.outcome === "returned"),
    [rec1.arms, rec2.arms].map((arms) => arms.map((a) => a.outcome)),
  );

  // ── 父本 2 + 一批（异父混选用）──
  await mockReset({ turns: [SCRIPT_PLAIN_TURN], fallback: { content: "（剧本耗尽）" } });
  const parent2 = await createParent(call, "6.9p2");
  dump.parent2 = parent2;
  await mockReset({
    turns: [{ content: "臂受控回答。" }, { content: "臂受控回答。" }],
    fallback: { content: "（剧本耗尽）" },
  });
  await openExperimentFor(call, parent2);
  await armAndPreview(call);
  const rec3 = await executeBatch(call, knownOps);
  served = await mockServed();
  check("#52 前置：父本 2 批恰 2 次调用（分段计数）", served === 2, { served });

  // ── 回父本 1 工作区：批次分组形态（#52/#53/#55）──
  await openExperimentFor(call, parent1);
  const res1 = await expResultsDom(call);
  check(
    "#53 多批共存：同父两批各自成块（operationId 互异、各自成组）",
    res1.batchOps.length === 2 &&
      res1.batchOps[0] !== res1.batchOps[1] &&
      res1.batchOps.every((op) => op === rec1.operationId || op === rec2.operationId),
    res1.batchOps,
  );
  check(
    "#52 同批自动配对：组头逐字呈现 main 登记的批次身份与实验组标签",
    res1.labels.every((t) => t.includes("批次") && t.includes("（main 登记）")) &&
      res1.labels.some(
        (t) => typeof rec1.experimentId === "string" && t.includes(rec1.experimentId),
      ),
    { labels: res1.labels, exp1: rec1.experimentId },
  );
  check(
    "#55 同父同模型仍按真实批次分组：两批同配置仍按 operationId 两块呈现、各自实验组标签独立",
    res1.batchOps.length === 2 &&
      typeof rec1.experimentId === "string" &&
      typeof rec2.experimentId === "string" &&
      rec1.experimentId !== rec2.experimentId,
    { ops: res1.batchOps, exp: [rec1.experimentId, rec2.experimentId] },
  );

  const beforeCompare = await registrationsSnapshot(call);

  // ── #40 两条：按选择顺序进详细比较 ──
  await toggleArmCompare(call, rec1.operationId, 0);
  await toggleArmCompare(call, rec1.operationId, 1);
  const sel2 = await H.storeQ(call, "return JSON.stringify({ ids: s.compareIds, view: s.view });");
  check("#40 选两条：对照集合 = 两臂按点击顺序", sel2.ids.length === 2, sel2);
  await clickEnterCompare(call);
  const cmp2Concl = await waitCompareConclusion(call);
  const cmp2 = await H.storeQ(
    call,
    `return JSON.stringify({ view: s.view, pair: s.comparePair,
       retLoc: s.compareReturnLocation === null ? null : s.compareReturnLocation.view });`,
  );
  check(
    "#40 两条 ⇒ 详细比较：pair 成立、读取结论 verified、来源记实验工作区",
    cmp2.view === "compare" &&
      cmp2.pair !== null &&
      cmp2Concl.kind === "verified" &&
      cmp2Concl.n === 2 &&
      cmp2.retLoc === "experiment",
    { ...cmp2, concl: cmp2Concl },
  );
  const pdDuringLegal = await bodyHas(call, "[PARENT_DIFFERS]");
  check("#40 合法同父选择无 [PARENT_DIFFERS] 拒绝呈现", pdDuringLegal === false, pdDuringLegal);
  await clickReturnSource(call);
  const back1 = await H.storeQ(
    call,
    `return JSON.stringify({ view: s.view, ids: s.compareIds, target: s.experimentTarget,
       retLoc: s.compareReturnLocation });`,
  );
  const afterCompare1 = await registrationsSnapshot(call);
  check(
    "#41 返回实验：视图恢复、对照集合保留、来源凭据一次性用掉",
    back1.view === "experiment" &&
      back1.ids.length === 2 &&
      back1.retLoc === null &&
      back1.target !== null &&
      back1.target.runId === parent1,
    back1,
  );
  check(
    "#41 批次事实原样：比较往返前后登记与读取项逐字一致（只读；键序不敏感差集）",
    (() => {
      const diff = registrationsDiff(beforeCompare, afterCompare1);
      dump.diff1 = diff;
      return Object.keys(diff).length === 0;
    })(),
    dump.diff1,
  );

  // ── #40 三条/四条：指标表模式（无 pair）──
  // ⚠️ 现状登记：指标表模式（pair 为空）没有「返回来源」按钮（该按钮只挂在详细比较头部）——
  // 返回经「列表点运行（selectRun 离开比较视图）→ 重开实验工作区」的真实路径承载。
  await openExperimentFor(call, parent1);
  await toggleArmCompare(call, rec2.operationId, 0);
  const res3 = await expResultsDom(call);
  check("#40 三条：入口计数 3/4", res3.enterLabel === "进入比较（已选 3/4）", res3.enterLabel);
  await clickEnterCompare(call);
  const cmp3Concl = await waitCompareConclusion(call);
  const cmp3 = await H.storeQ(
    call,
    "return JSON.stringify({ view: s.view, pair: s.comparePair, notice: s.compareNotice });",
  );
  check(
    "#40 三条 ⇒ 指标表模式（无 pair、提示显式选两条、整集合只读读取 verified）",
    cmp3.view === "compare" &&
      cmp3.pair === null &&
      typeof cmp3.notice === "string" &&
      cmp3.notice.includes("显式选择两条") &&
      cmp3Concl.kind === "verified" &&
      cmp3Concl.n === 3,
    { ...cmp3, concl: cmp3Concl },
  );
  await openExperimentFor(call, parent1);
  await toggleArmCompare(call, rec2.operationId, 1);
  await clickEnterCompare(call);
  const cmp4Concl = await waitCompareConclusion(call);
  const cmp4 = await H.storeQ(
    call,
    "return JSON.stringify({ view: s.view, pair: s.comparePair });",
  );
  check(
    "#40 四条 ⇒ 同口径（无 pair、4 项结论 verified）",
    cmp4.view === "compare" &&
      cmp4.pair === null &&
      cmp4Concl.kind === "verified" &&
      cmp4Concl.n === 4,
    { ...cmp4, concl: cmp4Concl },
  );
  await openExperimentFor(call, parent1);

  // ── #40 第 5 条：上限拒绝、集合不变 ──
  await H.storeQ(call, `s.toggleCompare(${JSON.stringify(parent1)}); return JSON.stringify("ok");`);
  const over = await H.storeQ(
    call,
    "return JSON.stringify({ ids: s.compareIds, notice: s.compareNotice });",
  );
  check(
    "#40 第 5 条被拒绝：提示在场、集合仍为 4 条不变",
    over.ids.length === 4 &&
      typeof over.notice === "string" &&
      over.notice.length > 0 &&
      !over.ids.includes(parent1),
    over,
  );

  // ── #41 不可比：异父混选 ⇒ [PARENT_DIFFERS]，返回实验事实原样 ──
  // 集合缩到父本 1 的一条臂（其余移出；上限拒绝未入集合，无需回退）
  const idsNow = await H.storeQ(call, "return JSON.stringify(s.compareIds);");
  for (const runId of idsNow) {
    if (runId !== rec1.arms[0].id) {
      await H.storeQ(
        call,
        `s.toggleCompare(${JSON.stringify(runId)}); return JSON.stringify("ok");`,
      );
    }
  }
  await openExperimentFor(call, parent2);
  await toggleArmCompare(call, rec3.operationId, 0);
  const cross = await H.storeQ(
    call,
    `return JSON.stringify({ ids: s.compareIds,
       hasP1: s.compareIds.includes(${JSON.stringify(rec1.arms[0].id)}),
       hasP2: s.compareIds.includes(${JSON.stringify(rec3.arms[0].id)}) });`,
  );
  check(
    "#41 异父混选就绪：集合 = 父1 臂 + 父2 臂",
    cross.hasP1 === true && cross.hasP2 === true && cross.ids.length === 2,
    cross,
  );
  await clickEnterCompare(call);
  const cmpGateConcl = await waitCompareConclusion(call);
  let pdText = false;
  const pdDeadline = Date.now() + 10000;
  for (;;) {
    pdText = await bodyHas(call, "[PARENT_DIFFERS]");
    if (pdText === true || Date.now() > pdDeadline) break;
    await H.sleep(500);
  }
  const cmpGate = await H.storeQ(call, "return JSON.stringify({ view: s.view });");
  check(
    "#41 不可比结果进入 U7：异父混选读取 verified 但实验门禁 [PARENT_DIFFERS] 就近呈现",
    cmpGate.view === "compare" && cmpGateConcl.kind === "verified" && pdText === true,
    { view: cmpGate.view, concl: cmpGateConcl, pdText },
  );
  const regBeforeReturn = await registrationsSnapshot(call);
  await clickReturnSource(call);
  const back2 = await H.storeQ(
    call,
    "return JSON.stringify({ view: s.view, ids: s.compareIds, target: s.experimentTarget });",
  );
  check(
    "#41 比较拒绝后返回实验：视图/目标/对照集合保留（返回不改批次事实）",
    back2.view === "experiment" &&
      back2.target !== null &&
      back2.target.runId === parent2 &&
      back2.ids.length === 2 &&
      back2.ids.includes(rec1.arms[0].id) &&
      back2.ids.includes(rec3.arms[0].id),
    back2,
  );
  const regAfterReturn = await registrationsSnapshot(call);
  check(
    "#41 登记与读取项与进入比较前逐字一致（键序不敏感差集）",
    (() => {
      const diff = registrationsDiff(regBeforeReturn, regAfterReturn);
      dump.diff2 = diff;
      return Object.keys(diff).length === 0;
    })(),
    dump.diff2,
  );
  note(
    "#40/#41 的零执行权限：比较全路径只走 runs:compare（compare-readonly 反证单元 + 本批 served 计数无重发类增量承载）。",
  );
  note(
    "#52/#53/#54/#55（批次分组族，任务列本指 6.7）已由本批真实三批形态顺带交付：多批成块/组头标签/预览不产批/同父不合并。",
  );
  note(
    "现状登记：指标表模式（pair 为空）无「返回来源」按钮（只挂在详细比较头部）——返回经列表点运行 + 重开实验工作区承载；是否补入口归定口径。",
  );
}

// ---------------------------------------------------------------------------
// tag：messages-live（#8 #9 #12 #13 #43 #45 #46）
// ---------------------------------------------------------------------------

async function tagMessagesLive(call) {
  const ids0 = new Set(H.traceIds());
  const parentProxyMessages = [
    { role: "system", content: "你是被录制的外部应用。" },
    { role: "user", content: "U8 6.9 外部请求一。" },
  ];

  // ── 真实启用代理（store toggleProxy → 真 IPC → main 真监听；录制 UI 应用路径归 6.6）──
  await mockReset({
    turns: [{ content: "外部受控响应。" }],
    fallback: { content: "（剧本耗尽）" },
  });
  await H.storeQ(
    call,
    `await s.toggleProxy(JSON.parse(${JSON.stringify(JSON.stringify({ enabled: true, port: PROXY_PORT, upstreamBaseUrl: UPSTREAM }))}));
     return JSON.stringify(s.proxy);`,
  );
  let proxyState = await H.storeQ(call, "return JSON.stringify(s.proxy);");
  check(
    "#10 前置：代理运行中且未捕获 key（真实启用、零流量）",
    proxyState.running === true && proxyState.hasKey === false && proxyState.port === PROXY_PORT,
    proxyState,
  );

  // ── 外部受控请求 ⇒ 代理 run 落盘 + key 捕获 ──
  await externalRequest(parentProxyMessages, { stream: false });
  const [proxyRunId] = await waitNewRuns(ids0, 1, 15000);
  await H.sleep(800);
  // key 捕获发生在 main 的 keyStore（外部请求不经过渲染层）⇒ 必须显式回读状态
  await H.storeQ(call, `await s.loadProxyStatus(); return JSON.stringify("ok");`);
  const served1 = await mockServed();
  proxyState = await H.storeQ(call, "return JSON.stringify(s.proxy);");
  check(
    "#8 前置：外部请求经代理录为 run 且 key 已捕获（真实转发 + 真实 keyStore）",
    typeof proxyRunId === "string" && served1 === 1 && proxyState.hasKey === true,
    { runId: proxyRunId, served: served1, hasKey: proxyState.hasKey },
  );
  const parentRun = readRunFile(proxyRunId);
  check(
    "#8 前置：代理 run 落盘形态（source=proxy、llm.call 消息与外部请求逐字一致）",
    parentRun.meta.source?.kind === "proxy" &&
      JSON.stringify(parentRun.llms[0].request.messages) === JSON.stringify(parentProxyMessages),
    { source: parentRun.meta.source, msg0: parentRun.llms[0].request.messages?.[0] },
  );
  dump.proxyRunId = proxyRunId;

  await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("ok");`);
  await openLlmCallDetail(call, proxyRunId, "s_02");
  const entryVisible = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-messages-workspace-entry]');
       return JSON.stringify(b === null ? null : { disabled: b.disabled, visible: b.offsetParent !== null }); })()`,
  ).then(JSON.parse);
  check(
    "#11 前置（SDK run 无此入口的正面）：代理 run 的自有 llm.call 给出工作区入口",
    entryVisible !== null && entryVisible.disabled === false && entryVisible.visible === true,
    entryVisible,
  );
  await clickMessagesEntry(call);
  const wsState = await messagesStoreState(call, proxyRunId);
  check(
    "#44 前置：messages 工作区打开、目标显式绑定（runId+spanId）",
    wsState.view === "messages" &&
      wsState.target?.runId === proxyRunId &&
      wsState.target?.spanId === "s_02",
    { view: wsState.view, target: wsState.target, loc: wsState.msgLoc },
  );

  // ── #9 未修改禁用 ──
  const mono0 = await waitMonaco(call, 2);
  const roCount = mono0.editors.filter((e) => e.readOnly).length;
  const editableCount = mono0.editors.length - roCount;
  check(
    "#9 编辑器双栏：原值只读 + 草稿可编辑（Monaco 懒加载就绪）",
    mono0.editors.length === 2 && roCount === 1 && editableCount === 1,
    mono0.editors.map((e) => ({ ro: e.readOnly, len: (e.value ?? "").length })),
  );
  const unchangedNote = await bodyHas(call, "未做任何修改（空 fork 被拒绝）");
  const resend0 = await resendButtonState(call);
  check(
    "#9 未修改禁用：诚实说明在场 + 确认重发禁用",
    unchangedNote === true && resend0?.disabled === true,
    { unchangedNote, resend0 },
  );

  // ── #43 非法原文跨页逐字恢复 ──
  await H.setEditableMonaco(call, "{invalid");
  await clickReturnSource(call); // messages → 返回来源（trace）
  const viewAfterLeave = await H.storeQ(call, "return JSON.stringify({ view: s.view });");
  await openLlmCallDetail(call, proxyRunId, "s_02");
  await clickMessagesEntry(call);
  const mono1 = await waitMonaco(call, 2);
  const draft1 = mono1.editors.find((e) => !e.readOnly);
  check(
    "#43 非法 JSON 原样保留：离开（返回来源）再进入逐字恢复、不格式化不清洗",
    viewAfterLeave.view === "trace" && draft1?.value === "{invalid",
    { view: viewAfterLeave.view, draft: draft1?.value },
  );

  // ── 编辑 + #45 确认披露（单请求边界）──
  const baselineMessages = JSON.parse(mono1.editors.find((e) => e.readOnly)?.value ?? "[]");
  const edited1 = JSON.parse(JSON.stringify(baselineMessages));
  edited1[edited1.length - 1].content = "U8 6.9 外部请求一。（已编辑）";
  const edited1Text = JSON.stringify(edited1, null, 2);
  await H.setEditableMonaco(call, edited1Text);
  const disclosure45 = await bodyHas(call, "只重发这一个请求：不执行任何外部 Agent 的工具");
  check("#45 确认披露单请求边界措辞在场", disclosure45 === true, disclosure45);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-confirm-execution]'); b.click(); return true; })()`,
  );
  await H.sleep(900);
  const pressed1 = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-confirm-execution]')?.getAttribute('aria-pressed'))`,
  ).then(JSON.parse);
  if (pressed1 !== "true") throw new Error(`messages 确认未挂上：${pressed1}`);

  // ── #8 + #13：受控重发成功 + 在飞被动交错不借被动记录 ──
  await mockReset({
    turns: [{ content: "重发受控响应。", delayMs: 2500 }, { content: "被动受控响应。" }],
    fallback: { content: "（剧本耗尽）" },
  });
  const idsBeforeResend = new Set(H.traceIds());
  await clickResend(call);
  await H.sleep(600); // 让 fork 先占住 mock 剧本第 1 席（2500ms 窗口）
  await externalRequest([{ role: "user", content: "U8 6.9 被动交错请求。" }], { stream: false });
  const newRunIds = await waitNewRuns(idsBeforeResend, 2, 25000);
  await H.sleep(800);
  const recFork1 = await waitProxySettled(call, [], 30000);
  const fork1Id = recFork1.runIds[0];
  const passiveId = newRunIds.find((id) => id !== fork1Id) ?? null;
  const served2 = await mockServed();
  check(
    "#13 在飞被动交错：重发与被动各自落盘（fork + 被动共 2 次上游调用）",
    served2 === 2 &&
      typeof fork1Id === "string" &&
      typeof passiveId === "string" &&
      passiveId !== fork1Id,
    { served: served2, fork1Id, passiveId },
  );
  check(
    "#13/#45 登记：runIds 只含本次 fork 的 id（单请求；被动 id 不入登记）",
    recFork1.runIds.length === 1 &&
      recFork1.runIds[0] === fork1Id &&
      !recFork1.runIds.includes(passiveId),
    recFork1,
  );
  const fork1Run = readRunFile(fork1Id);
  check(
    "#8 编辑并重发成功：fork run parent/at_span/edit 逐字正确、首请求 messages = 编辑后值",
    fork1Run.meta.parent === proxyRunId &&
      fork1Run.meta.fork?.at_span === "s_02" &&
      fork1Run.meta.fork?.edit?.field === "messages" &&
      JSON.stringify(fork1Run.llms[0].request.messages) === JSON.stringify(edited1),
    { parent: fork1Run.meta.parent, field: fork1Run.meta.fork?.edit?.field },
  );
  const passiveRun = readRunFile(passiveId);
  check(
    "#13 被动 run 是独立录制（无 parent/fork、消息未被编辑污染）",
    passiveRun.meta.parent === null &&
      passiveRun.meta.fork === null &&
      JSON.stringify(passiveRun.llms[0]?.request.messages ?? []) ===
        JSON.stringify([{ role: "user", content: "U8 6.9 被动交错请求。" }]),
    { parent: passiveRun.meta.parent, fork: passiveRun.meta.fork },
  );

  // U5 §3.4 导航意图：messages 提交在流程内收口 ⇒ 自动跳到结果 run（失败也跳）
  const nav1 = await waitAutoNav(call, fork1Id);
  check(
    "#8 收口自动导航：跳到本次重发的结果 run（U5 导航意图；离开 messages 工作区）",
    nav1.view === "trace" && nav1.sel === fork1Id,
    nav1,
  );
  // 清理判据必须在重入前取（重入会重挂 ensure 重建基线草稿——那是幂等语义，不是清理失败）
  const cleanedCheck = await messagesStoreState(call, proxyRunId);
  check(
    "#8/#45 收尾：正常结束 + 修订匹配 ⇒ 草稿自动清理（U5 收尾汇合点）",
    cleanedCheck.draftText === null,
    { draftText: cleanedCheck.draftText },
  );

  // 重入 messages 工作区看结果区（结果区按登记派生 ⇒ 跨页存活）
  await openLlmCallDetail(call, proxyRunId, "s_02");
  await clickMessagesEntry(call);
  const resDom1 = await waitMessagesBlocks(call, 1);
  check(
    "#13 结果区只呈现登记的可信 ID（1 块；fork id 在场、被动 id 不在场）",
    resDom1.hasResults === true &&
      resDom1.blockCount === 1 &&
      resDom1.blockOps[0] === recFork1.operationId &&
      resDom1.text.includes(fork1Id) &&
      !resDom1.text.includes(passiveId),
    {
      blocks: resDom1.blockOps,
      hasFork: resDom1.text.includes(fork1Id),
      hasPassive: resDom1.text.includes(passiveId ?? ""),
    },
  );
  const redraft = await messagesStoreState(call, proxyRunId);
  check(
    "#8 清理后重入 ⇒ ensure 重建的是基线草稿（旧编辑内容不复活）",
    redraft.draftText !== null &&
      JSON.stringify(JSON.parse(redraft.draftText)) === JSON.stringify(baselineMessages),
    { draftHead: (redraft.draftText ?? "").slice(0, 60) },
  );
  dump.fork1Id = fork1Id;
  dump.passiveId = passiveId;

  // ── #46 失败定位与返回不丢草稿（upstream 503 ⇒ run 落 error、草稿保留）──
  await mockReset({
    turns: [{ mode: "fail", status: 503 }],
    fallback: { content: "（剧本耗尽）" },
  });
  const monoForEdit = await waitMonaco(call, 2);
  const baseline2 = JSON.parse(monoForEdit.editors.find((e) => e.readOnly)?.value ?? "[]");
  const edited2 = JSON.parse(JSON.stringify(baseline2));
  edited2[edited2.length - 1].content = "U8 6.9 失败重发（503 剧本）。";
  const edited2Text = JSON.stringify(edited2, null, 2);
  await H.setEditableMonaco(call, edited2Text);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-confirm-execution]'); b.click(); return true; })()`,
  );
  await H.sleep(900);
  await clickResend(call);
  const recFork2 = await waitProxySettled(call, [recFork1.operationId], 30000);
  const fork2Id = recFork2.runIds[0];
  const fork2Run = readRunFile(fork2Id);
  check(
    "#46 失败落盘：upstream 503 ⇒ run 无 llm.call span、终态 stopped/error（错误事实诚实）",
    fork2Run.llms.length === 0 &&
      fork2Run.terminal.event === "stopped" &&
      fork2Run.terminal.reason === "error",
    {
      llms: fork2Run.llms.length,
      terminal: `${fork2Run.terminal.event}/${fork2Run.terminal.reason}`,
    },
  );
  const draftKept = await messagesStoreState(call, proxyRunId);
  check(
    "#46 草稿逐字保留：error 终态不是正常结束 ⇒ 不按提交修订清理",
    draftKept.draftText === edited2Text,
    { kept: (draftKept.draftText ?? "").slice(0, 80), expectLen: edited2Text.length },
  );
  // fork2 收口后同样自动导航（失败也跳）⇒ 重入 messages 工作区核对结果区与返回编辑
  const nav2 = await waitAutoNav(call, fork2Id);
  check(
    "#46 失败收口自动导航：跳到失败 run（失败也跳；编辑输入不受影响）",
    nav2.view === "trace" && nav2.sel === fork2Id,
    nav2,
  );
  await openLlmCallDetail(call, proxyRunId, "s_02");
  await clickMessagesEntry(call);
  const resDom2 = await waitMessagesBlocks(call, 2);
  const returnDraftBtn = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-messages-return-draft="${recFork2.operationId}"]');
       return JSON.stringify(b === null ? null : { disabled: b.disabled }); })()`,
  ).then(JSON.parse);
  check(
    "#46 返回编辑入口在场（草稿在场 ⇒ 记录级动作）",
    returnDraftBtn !== null && returnDraftBtn.disabled === false,
    returnDraftBtn,
  );
  check(
    "#46 结果区两块：失败块含 fork2 id（不冒充成功、不借被动补）",
    resDom2.hasResults === true &&
      resDom2.blockCount === 2 &&
      resDom2.blockOps.includes(recFork2.operationId) &&
      resDom2.text.includes(fork2Id),
    resDom2.blockOps,
  );
  dump.fork2Id = fork2Id;

  // ── #12 停用代理仍有凭据（顺序有牙）──
  await H.storeQ(
    call,
    `await s.toggleProxy(JSON.parse(${JSON.stringify(JSON.stringify({ enabled: false, port: PROXY_PORT, upstreamBaseUrl: UPSTREAM }))}));
     return JSON.stringify(s.proxy);`,
  );
  const stoppedState = await H.storeQ(call, "return JSON.stringify(s.proxy);");
  const reason12 = await bodyHas(call, "本地录制代理未运行：没有可重发的 upstream");
  const resend12 = await resendButtonState(call);
  check(
    "#12 停用代理仍有凭据不能重发：running=false && hasKey=true ⇒ 监听检查先挡（原因就近、按钮禁用）",
    stoppedState.running === false &&
      stoppedState.hasKey === true &&
      reason12 === true &&
      resend12?.disabled === true,
    { proxy: stoppedState, reason: reason12, resend: resend12 },
  );

  // ── 为重启段恢复 enabled=true（autoStart 前置；key 随 main 退出失效）──
  await H.storeQ(
    call,
    `await s.toggleProxy(JSON.parse(${JSON.stringify(JSON.stringify({ enabled: true, port: PROXY_PORT, upstreamBaseUrl: UPSTREAM }))}));
     return JSON.stringify(s.proxy);`,
  );
  note(
    "#10 未捕获 key 的正面呈现（running 且 hasKey=false）由 messages-restart 段承载：key 仅内存暂存，dev 重启后 autoStart 运行中 hasKey=false。",
  );
  note("#29 重启后凭据失效历史仍可读由 messages-restart 段承载（真实 main 重启 = 最硬证据）。");
  note(
    "代理启停走 store toggleProxy（真 IPC + main 真监听/真 keyStore）；录制 UI 应用路径（含端口占用分层）已由 6.6 实机承载，不重复。",
  );
}

// ---------------------------------------------------------------------------
// tag：messages-restart（#10 #29 #44）
// ---------------------------------------------------------------------------

async function tagMessagesRestart(call) {
  if (!PROXY_RUN_ARG)
    throw new Error("messages-restart 需要 --proxy-run=<messages-live 的代理 run id>");
  const parentProxyMessages = [
    { role: "system", content: "你是被录制的外部应用。" },
    { role: "user", content: "U8 6.9 外部请求一。" },
  ];

  // ── #29 前置：重启后 autoStart 运行中、key 失效 ──
  await H.storeQ(call, `await s.loadProxyStatus(); return JSON.stringify("ok");`);
  const proxyState = await H.storeQ(call, "return JSON.stringify(s.proxy);");
  check(
    "#29 前置：dev 重启后代理 autoStart 运行中且凭据失效（key 仅内存暂存）",
    proxyState.running === true && proxyState.hasKey === false,
    proxyState,
  );

  await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("ok");`);
  await openLlmCallDetail(call, PROXY_RUN_ARG, "s_02");
  await clickMessagesEntry(call);

  // ── #29 历史仍可读 ──
  const mono0 = await waitMonaco(call, 2);
  const ro0 = mono0.editors.find((e) => e.readOnly);
  const sourceFailed = await bodyHas(call, "源详情读取失败");
  check(
    "#29 凭据失效历史仍可读：源详情读取成功、原值完整呈现（与录制时逐字一致）",
    sourceFailed === false &&
      ro0 !== undefined &&
      JSON.stringify(JSON.parse(ro0.value ?? "[]")) === JSON.stringify(parentProxyMessages),
    { editors: mono0.editors.length, sourceFailed },
  );

  // ── #10 未捕获 key + 就近录制入口 ──
  const reason10 = await bodyHas(call, "本会话未捕获到 key：先把你的应用经代理跑一次，再回来重发");
  const recEntry = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-messages-recording-entry]');
       return JSON.stringify(b === null ? null : { disabled: b.disabled, visible: b.offsetParent !== null }); })()`,
  ).then(JSON.parse);
  const resend10 = await resendButtonState(call);
  check(
    "#10 未捕获 key：原因就近呈现 + 「打开录制工作区」入口在场 + 重发禁用（模型密钥不被借用是结构性的）",
    reason10 === true &&
      recEntry !== null &&
      recEntry.disabled === false &&
      resend10?.disabled === true,
    { reason: reason10, entry: recEntry, resend: resend10 },
  );

  // ── #44 缺凭据转录制再返回精确编辑 ──
  const baselineMessages = JSON.parse(mono0.editors.find((e) => e.readOnly)?.value ?? "[]");
  const edited3 = JSON.parse(JSON.stringify(baselineMessages));
  edited3[edited3.length - 1].content = "U8 6.9 转录制后精确编辑重发。";
  const edited3Text = JSON.stringify(edited3, null, 2);
  await H.setEditableMonaco(call, edited3Text);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-messages-recording-entry]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("录制入口不可点");
  });
  await H.sleep(1500);
  const recState = await messagesStoreState(call, PROXY_RUN_ARG);
  check(
    "#44 转录制：进入录制工作区、来源引用记 messages 视图、messages 目标不丢",
    recState.view === "recording" &&
      recState.recLoc?.view === "messages" &&
      recState.target?.runId === PROXY_RUN_ARG,
    { view: recState.view, recLoc: recState.recLoc, target: recState.target },
  );

  // 录制页内真实捕获 key（外部受控请求经代理）
  await mockReset({
    turns: [{ content: "转录制受控响应。" }, { content: "重发受控响应。" }],
    fallback: { content: "（剧本耗尽）" },
  });
  await externalRequest(parentProxyMessages, { stream: false });
  await H.storeQ(call, `await s.loadProxyStatus(); return JSON.stringify("ok");`);
  const hasKeyNow = await H.storeQ(
    call,
    "return JSON.stringify({ hasKey: s.proxy.hasKey, running: s.proxy.running });",
  );
  check(
    "#44 录制页捕获凭据：外部请求经代理 → hasKey 翻真",
    hasKeyNow.hasKey === true && hasKeyNow.running === true,
    hasKeyNow,
  );

  // 返回来源 ⇒ 回 messages；草稿逐字保留
  await clickReturnSource(call);
  const backState = await messagesStoreState(call, PROXY_RUN_ARG);
  const mono2 = await waitMonaco(call, 2);
  const draft2 = mono2.editors.find((e) => !e.readOnly);
  check(
    "#44 返回精确编辑：messages 工作区恢复、目标不变、草稿逐字保留（不格式化不丢字）",
    backState.view === "messages" &&
      backState.target?.runId === PROXY_RUN_ARG &&
      draft2?.value === edited3Text,
    { view: backState.view, draftLen: (draft2?.value ?? "").length, expectLen: edited3Text.length },
  );
  const reasonGone = await bodyHas(call, "本会话未捕获到 key");

  // 重发闭环（重新确认 → 单请求成功）
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-confirm-execution]'); b.click(); return true; })()`,
  );
  await H.sleep(900);
  const idsBeforeFork3 = new Set(H.traceIds());
  await clickResend(call);
  const recFork3 = await waitProxySettled(call, [], 30000);
  const fork3Id = recFork3.runIds[0];
  const fork3Run = readRunFile(fork3Id);
  const served3 = await mockServed();
  const fork3New = [...H.traceIds()].filter((id) => !idsBeforeFork3.has(id));
  check(
    "#44 闭环：转录制返回后重发成功（单请求、messages = 编辑后值、parent 指向历史 run）",
    reasonGone === false &&
      served3 === 2 &&
      fork3Run.meta.parent === PROXY_RUN_ARG &&
      fork3Run.meta.fork?.edit?.field === "messages" &&
      JSON.stringify(fork3Run.llms[0].request.messages) === JSON.stringify(edited3) &&
      fork3New.length === 1 &&
      fork3New[0] === fork3Id,
    { served: served3, parent: fork3Run.meta.parent, newRuns: fork3New },
  );
  dump.fork3Id = fork3Id;
  note(
    "#44 的 store 半边（来源引用恢复/目标保留）与 aux-workspace-store 单元互证；本段以真实 dev 重启提供凭据失效前提。",
  );
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
