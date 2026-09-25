/* eslint-disable */
/**
 * U3 任务 6.3：受控执行（真 IPC + 真模型通道，全部打到本地受控服务，零付费请求）。
 *
 * 验收（tasks 6.3）：
 * - 覆盖**所有执行入口**：result 时间旅行 / 隔离续跑 / prompt fork / messages 重发 /
 *   A/B 整批 / 创建（整份）；
 * - **503 故障注入**（受控服务 mode:fail status:503）：失败 run 仍落盘、草稿保留、解冻；
 * - **业务拒绝**（SETTINGS_NOT_CONFIGURED / PROXY_NO_KEY / INVALID_SOURCE_TOKEN）：
 *   零模型请求、草稿保留、解冻；
 * - **部分 A/B 失败**（臂 1 成功 + 臂 2 503）：整批保留、解冻、executed 如实计数；
 * - **卸载重挂**（在飞期间切页签卸载编辑器）与**迟到回调**（在飞期间同目标重复登记被拒、
 *   不换令牌 ⇒ 旧响应的收尾只命中自己那次关联）；
 * - **提交快照独立于编辑器挂载**：冻结期 store 拒绝写入，提交值取快照原文，重挂后控件=快照；
 * - **授权复位**：隔离续跑/隔离创建重新打开都须重新勾选；
 * - **原门禁**：空 fork / 未预检 / 未授权 / 执行前先预览 / 副作用声明，全部仍然生效；
 * - **真实 IPC 的提交值**：落盘 trace 的 `fork.edit.value` 与 mock 收到的请求体逐字核对；
 * - **原有执行入口和文件阅读继续可用**（regression tag）。
 *
 * 纪律（沿 u3-61/62）：
 *   - 全部真点击/真键入/真模态应答（window.confirm 经 CDP javascriptDialogOpening 真接受），
 *     真 store / 真 monaco 读回；执行走真 IPC（main → OpenAiCompatClient → 受控服务）；
 *   - 故障注入全部落在**受控服务剧本**（不发真实付费请求）；
 *   - 每个 tag 从 Page.reload 干净起点开始，自行配置 settings/proxy，收尾复位；
 *   - 不改产品代码。
 *
 * 前置：dev 带 CDP 9612 且 `REBASEAGENT_SMOKE_PICK_DIR=<.workbuddy/u3/u3-63/source>`
 *       （由 .workbuddy/u3/u3-63/run-all.cjs 在同一次调用内起停）。
 *
 * 用法：node apps/desktop/scripts/u3-63-cdp.cjs --tag=<result|prompt|messages|ab|create|
 *                                                     isolated|business|fault|ab-partial|late|regression>
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, shot, call0 } = require("./lib/u2-cdp-util.cjs");
const { startMockLlmServer } = require("./mock-llm-server.cjs");

const PORT = 9612;
const MOCK_PORT = 18799;
const PROXY_PORT = 18787;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
// 代理 upstream 的真实口径**不带路径**（设置页默认值 `https://api.deepseek.com` 同理）：
// handler 会自己拼 ctx.path=/v1/chat/completions，写成 …/v1 会发出 /v1/v1/… 的失真请求
const MOCK_UPSTREAM = `http://127.0.0.1:${MOCK_PORT}`;
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;
const OUT_DIR = join(REPO, ".workbuddy", "u3", "u3-63");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-25-u3-63");
const MANIFEST = join(REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const OUT = join(OUT_DIR, "measurements.json");
const TRACES = join(REPO, ".rebaseagent", "traces");
const SETTINGS_FILE = join(REPO, ".rebaseagent", "settings.json");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "result");

function fixture() {
  if (!existsSync(MANIFEST)) {
    throw new Error(`缺 ${MANIFEST}——6.3 复用 6.1 的夹具（trace 需已在 .rebaseagent/traces/）`);
  }
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

const checks = [];
function check(name, ok, detail) {
  checks.push({
    name: `[${TAG}] ${name}`,
    ok: ok === true,
    detail: ok === true ? "" : String(detail ?? ""),
  });
  console.log(
    `${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${String(detail ?? "")}`}`,
  );
}

function loadOut() {
  if (existsSync(OUT)) return JSON.parse(readFileSync(OUT, "utf8"));
  return { measurements: {}, checks: [] };
}
function saveOut(d) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(d, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// CDP 会话（本页专用：支持事件订阅，用于真原生 window.confirm）
// ---------------------------------------------------------------------------

function makeDialogSession(pageUrl) {
  const ws = new WebSocket(pageUrl);
  let id = 0;
  const pending = new Map();
  const handlers = [];
  ws.onmessage = (raw) => {
    const m = JSON.parse(raw.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
      return;
    }
    for (const h of handlers) if (h.method === m.method) h.fn(m.params);
  };
  return new Promise((res, rej) => {
    ws.onopen = () => {
      const call = (method, params = {}) =>
        new Promise((ok) => {
          const i = ++id;
          pending.set(i, ok);
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      call.on = (method, fn) => handlers.push({ method, fn });
      call.ws = ws;
      res(call);
    };
    ws.onerror = rej;
  });
}

/** 原生 window.confirm 的真应答：观察器记录并应答，acceptNow 决定确认/取消 */
function attachDialogHandler(call, log) {
  let acceptNow = true;
  call.on("Page.javascriptDialogOpening", (p) => {
    log.push({ type: p.type, message: String(p.message ?? "").slice(0, 300), accept: acceptNow });
    call("Page.handleJavaScriptDialog", {
      accept: acceptNow,
      promptText: p.promptText ?? "",
    }).catch(() => {});
  });
  return {
    setAccept(v) {
      acceptNow = v;
    },
    log,
  };
}

// ---------------------------------------------------------------------------
// 应用侧通道（真 store / 真 api）
// ---------------------------------------------------------------------------

const ev3 = async (call, expression) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(
      `ev@${expression.slice(0, 90).replace(/\s+/g, " ")} → ${d.exception?.description ?? d.text}`,
    );
  }
  return r?.result?.value;
};
const ev = ev3;

const STORE_NEEDLE = ["/src/renderer/src/store.ts", "/src/store.ts"];
const MONACO_NEEDLE = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];

async function appImport(call, needles, body) {
  const expr = `(async () => {
    const all = performance.getEntriesByType('resource').map(e => e.name);
    const rank = (n) => (n.includes('?t=') ? 0 : n.includes('/@fs/') ? 2 : 1);
    const urls = all.filter(n => ${JSON.stringify(needles)}.some(w => n.includes(w)))
      .sort((a, b) => rank(a) - rank(b));
    if (urls.length === 0) return JSON.stringify({ error: 'module-url-not-found' });
    const m = await import(urls[0]);
    ${body}
  })()`;
  const r = await call("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(
      `eval@${String(body).slice(0, 60)}: ${d.exception?.description ?? d.text ?? JSON.stringify(d).slice(0, 200)}`,
    );
  }
  const raw = r?.result?.value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`appImport 非法 JSON：${String(raw).slice(0, 200)}`);
  }
}
const evAsync = (call, expression) =>
  call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then(
    (r) => r?.result?.value,
  );

const storeQ = (call, body) =>
  appImport(call, STORE_NEEDLE, `const s = m.useAppStore.getState(); ${body}`);

const drafts = (call) =>
  storeQ(
    call,
    `return JSON.stringify({
       calls: s.drafts.calls,
       modelAb: s.drafts.modelAb,
       create: s.drafts.create === null ? null : {
         mode: s.drafts.create.mode, systemPrompt: s.drafts.create.systemPrompt,
         userMessage: s.drafts.create.userMessage, revision: s.drafts.create.revision,
       },
     });`,
  );

const submissions = (call) =>
  storeQ(
    call,
    `const ids = Object.keys(s.draftSubmissions.byId).map((k) => {
         const x = s.draftSubmissions.byId[k];
         return { id: k, channel: x.channel, revision: x.submittedRevision,
                  text: x.submittedText, token: x.token };
       });
     return JSON.stringify({ ids, nextToken: s.draftSubmissions.nextToken });`,
  );

/** 当前执行状态（forking/create/A-B 三通道）+ 错误码 */
const execState = (call) =>
  storeQ(
    call,
    `return JSON.stringify({
        forking: s.forking, forkError: s.forkError, forkErrorCode: s.forkErrorCode,
        creating: s.creatingRun, createRunError: s.createRunError,
        createRunErrorCode: s.createRunErrorCode,
        modelAbInFlight: s.modelAbInFlight, modelAbErrorCode: s.modelAbErrorCode,
        sourceRef: s.createSourceRef === null ? null : { name: s.createSourceRef.name },
       });`,
  );

const apiCall = (call, path, payload) =>
  appImport(
    call,
    STORE_NEEDLE,
    `const env = await window.api.${path}(${JSON.stringify(payload ?? null)});
     return JSON.stringify(env);`,
  );

const fs = require("node:fs");
const traceIds = () =>
  new Set(
    fs
      .readdirSync(TRACES)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => n.slice(0, -6)),
  );
const hashAllTraces = () => {
  const acc = {};
  for (const n of fs.readdirSync(TRACES).filter((x) => x.endsWith(".jsonl"))) {
    acc[n] = createHash("sha256")
      .update(readFileSync(join(TRACES, n)))
      .digest("hex");
  }
  return acc;
};
const hashSourceDir = (dir) => {
  const acc = {};
  if (!existsSync(dir)) return acc;
  for (const n of fs.readdirSync(dir)) {
    const p = join(dir, n);
    if (fs.statSync(p).isFile())
      acc[n] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return acc;
};
const readChild = (id) => {
  const lines = readFileSync(join(TRACES, `${id}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const llms = lines.filter((l) => l.kind === "llm.call");
  return {
    meta: lines[0],
    firstRequestMessages: llms.length > 0 ? llms[0].request.messages : [],
    firstError: llms.length > 0 ? llms[0].error : null,
    lines: lines.length,
  };
};

async function waitForSettle(call, ids, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sub = await submissions(call);
    const st = await execState(call);
    const stillPending = sub.ids.some((x) => ids.includes(x.id));
    const busy =
      st.forking === "in_progress" || st.creating === "in_progress" || st.modelAbInFlight === true;
    if (!stillPending && !busy) return { sub, st };
    if (Date.now() > deadline) return { sub, st, timedOut: true };
    await sleep(500);
  }
}

/**
 * 点击提交并**立即捕获待定关联**（受控服务毫秒级返回，事后读会扑空）：
 * 在同一个页内异步循环里「click → 轮询至出现关联」，拿到即快照返回；
 * 未出现的兜底 = 收尾读 drafts（业务/本地拒绝路径下关联登记后被即刻 settle）。
 */
async function clickAndCaptureSub(
  call,
  buttonText,
  key,
  { pollMs = 4000, waitAfter = 200, inDialog = false, duringFlight = null } = {},
) {
  // ⚠️ 页内是 async IIFE ⇒ 必须 awaitPromise（否则 Promise 被序列化成 {}，
  //    ev() 的 returnByValue 拿到的是对象，JSON.parse 直接 "[object Object]"）
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const scope = ${String(inDialog)} ? (Array.from(document.querySelectorAll('dialog[open]')).pop() ?? document) : document;
      const btn = Array.from(scope.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
      if (!btn) return JSON.stringify({ error: 'button-not-found' });
      if (btn.disabled) return JSON.stringify({ error: 'button-disabled' });
      btn.click();
      let flightDone = false;
      const deadline = Date.now() + ${pollMs};
      for (;;) {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        const m = await import(url);
        const s = m.useAppStore.getState();
        const x = s.draftSubmissions.byId[${JSON.stringify(key)}];
        if (x !== undefined) {
          if (!flightDone && ${JSON.stringify(duringFlight ?? null)} !== null) {
            // 在飞窗口内的 DOM 动作（如切页签卸载编辑器）；只执行一次
            const [kind, name] = ${JSON.stringify(duringFlight ?? null)}.split(':');
            if (kind === 'tab') {
              const t = Array.from(document.querySelectorAll('[role="tab"]'))
                .find(y => ((y.textContent||'').trim()) === name);
              if (t) t.click();
            }
            flightDone = true;
            continue;
          }
          return JSON.stringify({ channel: x.channel, revision: x.submittedRevision, text: x.submittedText, token: x.token, unmountDone: flightDone });
        }
        if (Date.now() > deadline) return JSON.stringify({ none: true });
        await new Promise(res => setTimeout(res, 30));
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new Error(`captureSub eval: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
  await sleep(waitAfter);
  return JSON.parse(r?.result?.value ?? "{}");
}

async function newChildren(before, timeoutMs = 40000, expect = 1) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const added = [...traceIds()].filter((x) => !before.has(x)).sort();
    if (added.length >= expect) return added;
    if (Date.now() > deadline) return added;
    await sleep(600);
  }
}

// ---------------------------------------------------------------------------
// DOM 交互（自足拷贝自 u3-61/62 的已验证实现）
// ---------------------------------------------------------------------------

const RUNS_EXPR = `(() => JSON.stringify(Array.from(document.querySelectorAll('button'))
  .map(b => b.getAttribute('aria-label') || '')
  .filter(a => a.startsWith('复制完整运行 ID'))
  .map(a => a.replace('复制完整运行 ID ', ''))))()`;
async function runs(call) {
  return JSON.parse(await ev(call, RUNS_EXPR));
}
async function clickTab(call, label) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
      .find(x => ((x.textContent||'').trim()) === '${label}');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok !== true) return false;
  await sleep(1200);
  const selected = await ev(
    call,
    `(() => { const t = Array.from(document.querySelectorAll('[role="tab"]'))
      .find(x => x.getAttribute('aria-selected') === 'true');
      return t === null ? null : ((t.textContent||'').trim()); })()`,
  );
  return selected === label;
}
async function clickTabChecked(call, label) {
  if (!(await clickTab(call, label))) throw new Error(`页签切换到「${label}」失败`);
}
async function selectRun(call, id) {
  const hitRow = `(() => {
      const copy = Array.from(document.querySelectorAll('button'))
        .find(b => (b.getAttribute('aria-label') || '').startsWith('复制完整运行 ID ${id}'));
      if (!copy) return false;
      const row = copy.parentElement;
      const sel = row ? row.querySelector('button') : null;
      if (!sel) return false;
      sel.click(); return true; })()`;
  let ok = await ev(call, hitRow);
  if (ok !== true) {
    await clickTab(call, "概览");
    ok = await ev(call, hitRow);
  }
  if (ok !== true) throw new Error(`运行列表找不到 ${id}`);
  await sleep(1600);
}
async function clickSpan(call, titleFragment, expectSpanId) {
  const clickNth = (n) => `(() => {
    const rows = Array.from(document.querySelectorAll('button'))
      .filter(b => ((b.title||'').includes('${titleFragment}')));
    if (rows.length <= ${n}) return false;
    rows[${n}].click(); return true; })()`;
  for (let n = 0; n < 6; n++) {
    if ((await ev(call, clickNth(n))) !== true) break;
    await sleep(1300);
    const sel = await storeQ(call, "return JSON.stringify({ sel: s.selectedSpanId });");
    if (sel.sel === expectSpanId) return true;
  }
  throw new Error(`未能选中 span ${expectSpanId}`);
}
async function clickByText(call, text, wait = 800) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => ((x.textContent||'').trim()).includes('${text}'));
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok !== true) throw new Error(`找不到按钮「${text}」`);
  await sleep(wait);
  return true;
}
async function clickByTextChecked(call, text, wait = 800) {
  return clickByText(call, text, wait);
}
/** 在**当前打开的对话框**内点按钮（精确匹配，避免与全局栏同名按钮混淆） */
async function clickInOpenDialog(call, text, wait = 800) {
  const r = await ev(
    call,
    `(() => { const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
      if (!dlg) return 'no-dialog';
      const b = Array.from(dlg.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === ${JSON.stringify(text)});
      if (!b) return 'no-button: ' + (dlg.innerText||'').replace(/\\s+/g,' ').slice(0, 120);
      if (b.disabled) return 'disabled';
      b.click(); return 'clicked'; })()`,
  );
  if (r !== "clicked") throw new Error(`对话框内点「${text}」失败：${r}`);
  await sleep(wait);
}
async function dialogState(call, text) {
  return ev(
    call,
    `(() => { const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
      if (!dlg) return null;
      const b = Array.from(dlg.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === ${JSON.stringify(text)});
      return b === null ? null : { disabled: b.disabled }; })()`,
  );
}
async function domState(call, selector) {
  return ev(
    call,
    `(() => { const i = document.querySelector(${JSON.stringify(selector)});
      if (!i) return null;
      return { disabled: i.disabled === true, checked: i.checked === true,
               value: i.value !== undefined ? i.value : null }; })()`,
  );
}
async function clickLabelWith(call, fragment, wait = 600) {
  const ok = await ev(
    call,
    `(() => { const l = Array.from(document.querySelectorAll('label'))
        .find(x => ((x.textContent||'').includes(${JSON.stringify(fragment)})));
      if (!l) return false;
      const cb = l.querySelector('input[type=checkbox]');
      if (!cb) return 'no-checkbox';
      cb.click(); return true; })()`,
  );
  if (ok !== true) throw new Error(`找不到含「${fragment}」的授权复选框：${ok}`);
  await sleep(wait);
}
async function monacoInfo(call) {
  return appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const ed = monaco.editor.getEditors().map((e, i) => ({
       i,
       value: e.getModel()?.getValue() ?? null,
       readOnly: e.getOption(monaco.editor.EditorOption.readOnly) === true,
       visible: e.getDomNode() !== null && e.getDomNode().offsetParent !== null,
     }));
     return JSON.stringify({ editors: ed });`,
  );
}
async function typeIntoEditableMonaco(call, text) {
  let idx = null;
  for (let i = 0; i < 12; i++) {
    const info = await monacoInfo(call);
    const target = info.editors.filter((e) => e.visible && !e.readOnly);
    if (target.length > 0) {
      idx = target[0].i;
      break;
    }
    await sleep(500);
  }
  if (idx === null) {
    const info = await monacoInfo(call);
    throw new Error(`无可编辑 monaco（轮询 6s）：${JSON.stringify(info).slice(0, 300)}`);
  }
  const pathB = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const e = monaco.editor.getEditors()[${idx}];
     const node = e.getDomNode();
     const ta = node.querySelector('textarea.inputarea') ?? node.querySelector('textarea');
     if (!ta) return JSON.stringify({ changed: false, reason: 'no-textarea' });
     ta.focus();
     const cur = e.getModel().getValue();
     const proto = window.HTMLTextAreaElement.prototype;
     Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, cur + ${JSON.stringify(text)});
     ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)}, inputType: 'insertText' }));
     await new Promise((r) => setTimeout(r, 500));
     return JSON.stringify({ changed: e.getModel().getValue() !== cur });`,
  );
  if (pathB.changed === true) return "dom-input-event";
  const pathC = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const e = monaco.editor.getEditors()[${idx}];
     const cur = e.getModel().getValue();
     e.trigger('keyboard', 'type', { text: ${JSON.stringify(text)} });
     await new Promise((r) => setTimeout(r, 500));
     return JSON.stringify({ changed: e.getModel().getValue() !== cur });`,
  );
  if (pathC.changed === true) return "monaco-trigger";
  throw new Error(`键入路径失败：B=${JSON.stringify(pathB)} C=${JSON.stringify(pathC)}`);
}
/** 把可编辑 monaco 整体设为给定文本（与真实删除→输入走同一 onChange 事件源） */
async function setEditableMonaco(call, text) {
  return appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const eds = monaco.editor.getEditors().filter((e) =>
       e.getDomNode() !== null && e.getDomNode().offsetParent !== null &&
       !e.getOption(monaco.editor.EditorOption.readOnly));
     if (eds.length === 0) return JSON.stringify({ ok: false, count: monaco.editor.getEditors().length });
     eds[0].getModel().setValue(${JSON.stringify(text)});
     await new Promise((r) => setTimeout(r, 600));
     return JSON.stringify({ ok: true, value: eds[0].getModel().getValue() });`,
  );
}
async function typeIntoDom(call, selector, text) {
  const focused = await ev(
    call,
    `(() => { const i = document.querySelector(${JSON.stringify(selector)});
      if (!i || i.offsetParent === null) return false;
      i.focus(); i.select(); return true; })()`,
  );
  if (focused !== true) throw new Error(`无法聚焦 ${selector}`);
  await call("Input.insertText", { text });
  await sleep(800);
  const readBack = `(() => { const i = document.querySelector(${JSON.stringify(selector)});
    return i === null ? null : i.value; })()`;
  let value = await ev(call, readBack);
  if (typeof value === "string" && value.includes(text)) return { value, path: "insertText" };
  await ev(
    call,
    `(() => { const i = document.querySelector(${JSON.stringify(selector)});
      if (!i) return false;
      const proto = i.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(i, ${JSON.stringify(text)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true; })()`,
  );
  await sleep(600);
  value = await ev(call, readBack);
  return { value, path: "native-setter" };
}

// ---------------------------------------------------------------------------
// 受控服务与配置复位
// ---------------------------------------------------------------------------

async function prepare(call, script) {
  // 受控服务：本 tag 私有（进程内起停，剧本从 turn[0] 开始）
  const mock = await startMockLlmServer({ port: MOCK_PORT, script });
  // 配置从干净起点开始：代理关、settings 清空，再按本 tag 需要写入
  await apiCall(call, "proxyToggle", {
    enabled: false,
    port: PROXY_PORT,
    upstreamBaseUrl: MOCK_UPSTREAM,
  });
  await apiCall(call, "clearSettings");
  await apiCall(call, "saveSettings", {
    baseURL: MOCK_BASE,
    apiKey: "sk-u363-controlled",
    model: "mock-model",
  });
  await storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
  return mock;
}

async function teardown(call, mock) {
  try {
    await apiCall(call, "proxyToggle", {
      enabled: false,
      port: PROXY_PORT,
      upstreamBaseUrl: MOCK_UPSTREAM,
    });
  } catch {
    /* 尽力而为 */
  }
  try {
    await apiCall(call, "clearSettings");
  } catch {
    /* 尽力而为 */
  }
  await mock.close().catch?.(() => {});
}

// ---------------------------------------------------------------------------
// 场景 A：普通 result 时间旅行 —— 快照提交 + 真实 IPC 值 + 空 fork 门禁
// ---------------------------------------------------------------------------

async function scenarioResult(call, fx) {
  const runId = fx.normalRun;
  const mark = Math.random().toString(36).slice(2, 6);
  const text = `受控执行-result-快照-${mark}`;
  const before = traceIds();
  const hashBefore = hashAllTraces();

  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1200);

  // 原门禁 1：未修改（空 fork）时「确认重跑」禁用
  const submitDisabledWhenUnchanged = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.textContent||'').trim() === '确认重跑');
      return b === null ? null : b.disabled; })()`,
  );
  check(
    "result 门禁：内容未修改时空 fork 禁用提交",
    submitDisabledWhenUnchanged === true,
    JSON.stringify({ submitDisabledWhenUnchanged }),
  );

  await typeIntoEditableMonaco(call, text);
  const d1 = await drafts(call);
  const draftText = d1?.calls?.[runId]?.s_03?.result?.text ?? "";
  const rev = d1?.calls?.[runId]?.s_03?.result?.revision ?? null;
  check(
    "result 草稿已入 store（提交前）",
    draftText.includes(mark),
    JSON.stringify(draftText).slice(0, 120),
  );

  const key = `${runId}|s_03|result`;
  const sub = await clickAndCaptureSub(call, "确认重跑", key);
  check(
    "result 提交登记了本次关联（通道/快照/修订）",
    sub.channel === "result" && sub.revision === rev && sub.text === draftText,
    JSON.stringify(sub).slice(0, 220),
  );
  const settled = await waitForSettle(call, [key], 90000);
  check(
    "result 响应后关联已收尾（解冻）",
    !settled.sub.ids.some((x) => x.id === key) && !settled.timedOut,
    JSON.stringify(settled.sub.ids),
  );
  check(
    "result 执行成功（forking=success）",
    settled.st.forking === "success",
    JSON.stringify({ forking: settled.st.forking, code: settled.st.forkErrorCode }),
  );

  const kids = await newChildren(before);
  check("result 产出 1 份新 run", kids.length === 1, JSON.stringify(kids));
  const child = kids.length > 0 ? readChild(kids[0]) : null;
  const editValue = child?.meta?.fork?.edit?.value ?? null;
  check(
    "真实 IPC 的提交值 = 快照原文（fork.edit.value 逐字）",
    editValue === draftText,
    JSON.stringify({ editValue, draftText }).slice(0, 220),
  );

  const d2 = await drafts(call);
  const kept = d2?.calls?.[runId]?.s_03?.result?.text ?? "";
  check(
    "成功后草稿保留（任何响应都不删草稿）",
    kept === draftText,
    JSON.stringify(kept).slice(0, 120),
  );

  // 只读不变性：既有 trace 逐字节不变（执行只新增文件）
  const hashAfter = hashAllTraces();
  const changed = Object.keys(hashAfter).filter(
    (k) => hashBefore[k] !== undefined && hashBefore[k] !== hashAfter[k],
  );
  check("执行不改动既有 trace（逐文件哈希一致）", changed.length === 0, JSON.stringify(changed));

  await shot(call, SHOT_DIR, "63-result-executed.png");
  return { runId, child: kids[0] ?? null, draftText, editValue, rev };
}

// ---------------------------------------------------------------------------
// 场景 B：prompt fork —— window.confirm 真应答 + 快照 system 值
// ---------------------------------------------------------------------------

async function scenarioPrompt(call, fx, dialogs) {
  const runId = fx.normalRun;
  const mark = Math.random().toString(36).slice(2, 6);
  const text = `受控执行-prompt-快照-${mark}`;
  const before = traceIds();
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  await clickByTextChecked(call, "编辑 system prompt 重跑", 1200);
  await typeIntoEditableMonaco(call, text);
  const d1 = await drafts(call);
  const draftText = d1?.calls?.[runId]?.s_02?.system_prompt?.text ?? "";

  const nBefore = dialogs.log.length;
  const keyP = `${runId}|s_02|system_prompt`;
  const subP = await clickAndCaptureSub(call, "确认从头重跑", keyP);
  check(
    "prompt 提交登记了字段关联（快照=草稿原文）",
    subP.channel === "prompt" && subP.text === draftText,
    JSON.stringify(subP).slice(0, 200),
  );
  const confirmed = dialogs.log.slice(nBefore).some((x) => x.message.includes("从头重跑"));
  check(
    "prompt 提交经原生确认真实发生（不是绕过）",
    confirmed === true,
    JSON.stringify(dialogs.log.slice(nBefore)),
  );
  const settled = await waitForSettle(call, [keyP], 90000);
  check(
    "prompt 关联收尾 + 执行成功",
    settled.st.forking === "success" && !settled.sub.ids.some((x) => x.id === keyP),
    JSON.stringify({ forking: settled.st.forking, ids: settled.sub.ids }),
  );
  const kids = await newChildren(before);
  const child = kids.length > 0 ? readChild(kids[0]) : null;
  const editValue = child?.meta?.fork?.edit?.value ?? null;
  check(
    "prompt 真实 IPC 的提交值 = 快照（fork.edit.value）",
    editValue === draftText,
    JSON.stringify({ editValue, draftText }).slice(0, 220),
  );
  const sysMsg = (child?.firstRequestMessages ?? []).find((m) => m.role === "system");
  check(
    "子 run 首次请求的 system 消息即提交快照（模型真收到）",
    typeof sysMsg?.content === "string" && sysMsg.content === draftText,
    JSON.stringify(sysMsg?.content ?? null).slice(0, 200),
  );
  const d2 = await drafts(call);
  check(
    "prompt 成功后草稿保留",
    (d2?.calls?.[runId]?.s_02?.system_prompt?.text ?? "") === draftText,
  );
  await shot(call, SHOT_DIR, "63-prompt-executed.png");
  return { runId, child: kids[0] ?? null, draftText, dialogs: dialogs.log.slice(nBefore) };
}

// ---------------------------------------------------------------------------
// 场景 C：messages 重发 —— 真代理会话（捕获 key → 重发 → 关代理后业务拒绝）
// ---------------------------------------------------------------------------

async function proxyChat(urlPath, content) {
  // 从 harness 进程直连代理（渲染层 fetch 受系统代理/扩展Origin 干扰，实测 Failed to fetch；
  // 「外部应用经代理跑一次」本就是代理录制的设计用法，node 侧请求与真实用户同形）
  try {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}${urlPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-u363-session",
      },
      body: JSON.stringify({
        model: "mock-model",
        stream: false,
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    return JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 120) });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}

async function scenarioMessages(call, fx, mock) {
  void fx;
  // 1. 起代理（upstream 指向受控服务）——走 store 真动作，界面 proxy 状态与 main 同源
  const toggled = await storeQ(
    call,
    `const st = await s.toggleProxy({ enabled: true, port: ${PROXY_PORT}, upstreamBaseUrl: ${JSON.stringify(MOCK_UPSTREAM)} });
     return JSON.stringify({ running: st?.running === true, hasKey: st?.hasKey === true });`,
  );
  check(
    "代理启动（upstream=受控服务，走 store 真动作，界面状态同源）",
    toggled.running === true,
    JSON.stringify(toggled),
  );

  // 2. 经代理真跑一次请求 ⇒ 本会话捕获 key + 录出代理 run
  //（基线取在请求**之前**：seed run 就是本步的合法产出）
  const before = traceIds();
  const seed = await proxyChat(
    "/v1/chat/completions",
    `U3-63 代理录制 ${Math.random().toString(36).slice(2, 6)}`,
  );
  check(
    "经代理的请求成功返回（真转发到受控 upstream）",
    typeof seed === "string" && seed.includes('"status":200'),
    seed,
  );
  const status = await apiCall(call, "proxyStatus");
  check(
    "本会话已捕获 key（hasKey=true）",
    status.ok === true && status.data.hasKey === true,
    JSON.stringify(status).slice(0, 200),
  );

  // 新录制的代理 run（span 恒为 s_01/s_02）
  const kids = await newChildren(before, 20000, 1);
  const seedRunId = kids[0] ?? null;
  check("代理录制产出新 run（可作 messages 分叉父本）", seedRunId !== null, JSON.stringify(kids));
  const seedTrace = seedRunId !== null ? readChild(seedRunId) : null;
  const recordedMessages = seedTrace?.firstRequestMessages ?? [];

  // 3. 打开 messages 编辑器，写入**修改后的合法 JSON**
  //（列表是 store 内存态：外部录制的 run 须 loadRuns 后才进列表——用户重开应用同理）
  await storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
  await selectRun(call, seedRunId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  await clickByTextChecked(call, "编辑 messages 重发", 1200);
  const edited = recordedMessages.map((m) =>
    m.role === "user" ? { ...m, content: `${m.content}（已编辑重发）` } : m,
  );
  const payload = JSON.stringify(edited, null, 2);
  await setEditableMonaco(call, payload);
  const d1 = await drafts(call);
  const draftText = d1?.calls?.[seedRunId]?.s_02?.messages?.text ?? "";
  check(
    "messages 草稿已入 store",
    draftText.includes("已编辑重发"),
    JSON.stringify(draftText).slice(0, 120),
  );

  // 4. 重发（真 confirm）
  const before2 = traceIds();
  const servedBefore = mock.served();
  const key = `${seedRunId}|s_02|messages`;
  const subM = await clickAndCaptureSub(call, "确认重发", key, { pollMs: 10000 });
  // 原生 confirm 阻塞渲染线程 ⇒ begin 可能发生在同一 tick 的轮询间隙（毫秒级），
  // 扑空不算失败：提交值=快照由下方 fork.edit.value 逐字段核对兜底
  check(
    "messages 提交登记了关联（或经快照兜底证明）",
    (subM.channel === "messages" && subM.text === draftText) || subM.none === true,
    JSON.stringify(subM).slice(0, 200),
  );
  const settled = await waitForSettle(call, [key], 90000);
  check(
    "messages 响应后解冻",
    !settled.sub.ids.some((x) => x.id === key) && !settled.timedOut,
    JSON.stringify(settled.sub.ids),
  );
  check(
    "messages 重发成功",
    settled.st.forking === "success",
    JSON.stringify({ forking: settled.st.forking, code: settled.st.forkErrorCode }),
  );
  const kids2 = await newChildren(before2);
  const forkId = kids2[0] ?? null;
  const forkTrace = forkId !== null ? readChild(forkId) : null;
  const editVal = forkTrace?.meta?.fork?.edit?.value ?? null;
  check(
    "messages 真实 IPC 的提交值 = 快照（结构逐字段一致）",
    JSON.stringify(editVal) === JSON.stringify(JSON.parse(draftText)),
    JSON.stringify({ editVal, draftText }).slice(0, 240),
  );
  check(
    "messages 重发确实打到受控服务（1 次调用）",
    mock.served() === servedBefore + 1,
    `served ${servedBefore} → ${mock.served()}`,
  );

  // 5. 关闭代理（会话内 key 随之失效）→ 同草稿再提交 ⇒ 业务拒绝且草稿保留
  await storeQ(
    call,
    `await s.toggleProxy({ enabled: false, port: ${PROXY_PORT}, upstreamBaseUrl: ${JSON.stringify(MOCK_UPSTREAM)} });
     return JSON.stringify({ ok: true });`,
  );
  await sleep(500);
  // 成功后 store 自动选中新 fork run（编辑器随选中切换卸载）⇒ 回到 seed run 重开编辑器再看门禁
  await selectRun(call, seedRunId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  await clickByTextChecked(call, "编辑 messages 重发", 1500);
  const btnAfterStop = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.textContent||'').trim() === '确认重发');
      if (b === undefined) return 'button-missing';
      return { disabled: b.disabled, title: b.title }; })()`,
  );
  check(
    "代理停止后 UI 门禁：重发按钮禁用并说明原因",
    btnAfterStop !== null &&
      btnAfterStop.disabled === true &&
      btnAfterStop.title.includes("代理未运行"),
    JSON.stringify(btnAfterStop),
  );
  const servedBeforeReject = mock.served();
  // UI 点不动（正是门禁的预期）⇒ 越过 UI 直调**同一 store 执行函数**，验证 main 独立复核：
  // 渲染层禁用只是 UX，不作为安全边界（PROXY_NO_KEY 必须在 main 也被拒）
  const reject = await storeQ(
    call,
    `const t = { runId: ${JSON.stringify(seedRunId)}, spanId: 's_02', field: 'messages' };
     const assoc = s.beginDraftSubmission({ channel: 'messages', target: t });
     if (assoc === null) return JSON.stringify({ error: 'begin-rejected' });
     let parsed;
     try { parsed = JSON.parse(assoc.submittedText); } catch (e) { return JSON.stringify({ error: 'parse' }); }
     const okRes = await s.proxyFork(${JSON.stringify(seedRunId)}, 's_02', parsed, assoc);
     const st = m.useAppStore.getState();
     return JSON.stringify({
       okRes, code: st.forkErrorCode,
       left: Object.keys(st.draftSubmissions.byId),
       text: st.callDraftOf(t)?.text ?? null,
     });`,
  );
  check(
    "PROXY_NO_KEY 业务拒绝（main 独立复核，不经 UI）",
    reject.okRes === false && reject.code === "PROXY_NO_KEY",
    JSON.stringify(reject).slice(0, 240),
  );
  check(
    "业务拒绝零模型请求",
    mock.served() === servedBeforeReject,
    `served ${servedBeforeReject} → ${mock.served()}`,
  );
  check(
    "业务拒绝后关联仍收尾（不永久冻结）",
    Array.isArray(reject.left) && !reject.left.includes(`${seedRunId}|s_02|messages`),
    JSON.stringify(reject.left),
  );
  const d2 = await drafts(call);
  check(
    "业务拒绝后草稿逐字保留",
    (d2?.calls?.[seedRunId]?.s_02?.messages?.text ?? "") === draftText && reject.text === draftText,
  );
  await shot(call, SHOT_DIR, "63-messages-rejected.png");
  return { seedRunId, forkId, draftText, editVal, capture: subM };
}

// ---------------------------------------------------------------------------
// 场景 D：A/B 整批 —— 门禁（副作用声明 / 先预览）+ 预览零调用 + 真执行
// ---------------------------------------------------------------------------

async function armModelsInput(call, index, value) {
  const sel = `input[placeholder="model 名"]`;
  return ev(
    call,
    `(() => { const list = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
      const i = list[${index}]; if (!i) return 'missing:' + list.length;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      i.focus(); setter.call(i, ${JSON.stringify(value)});
      i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`,
  );
}

async function buttonState(call, textExact) {
  return ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()).startsWith(${JSON.stringify(textExact)}));
      return b === null ? null : { disabled: b.disabled, t: (b.textContent||'').trim().slice(0, 40) }; })()`,
  );
}

async function scenarioAb(call, fx, mock) {
  const runId = fx.normalRun;
  const mark = Math.random().toString(36).slice(2, 6);
  const modelA = `u363-arm-a-${mark}`;
  const modelB = `u363-arm-b-${mark}`;
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  await clickByTextChecked(call, "模型 A/B 实验（换 model / params 对比）", 1200);

  await armModelsInput(call, 0, modelA);
  await armModelsInput(call, 1, modelB);
  await sleep(600);
  const d1 = await drafts(call);
  const rows = d1?.modelAb?.[runId]?.s_02?.rows ?? [];
  check(
    "A/B 两臂改动落入批次草稿",
    rows.length === 2 && rows[0].model === modelA && rows[1].model === modelB,
    JSON.stringify(rows),
  );

  // 原门禁 2：带副作用工具且未勾选 ⇒ 预览禁用（含原因）
  const previewBefore = await buttonState(call, "校验并预览计划");
  check(
    "A/B 门禁：未声明副作用时「校验并预览计划」禁用",
    previewBefore !== null && previewBefore.disabled === true,
    JSON.stringify(previewBefore),
  );
  await clickLabelWith(call, "未标记 sideEffect");

  // 原门禁 3：未预览 ⇒ 执行禁用
  const execBefore = await buttonState(call, "确认执行");
  check(
    "A/B 门禁：未预览计划时执行按钮禁用",
    execBefore !== null && execBefore.disabled === true,
    JSON.stringify(execBefore),
  );

  const servedBeforePreview = mock.served();
  await clickByTextChecked(call, "校验并预览计划", 1800);
  check(
    "A/B 预览（dry-run）零模型调用",
    mock.served() === servedBeforePreview,
    `served ${servedBeforePreview} → ${mock.served()}`,
  );
  const subAfterPreview = await submissions(call);
  check(
    "A/B 预览不登记提交关联（预览不是提交）",
    subAfterPreview.ids.length === 0,
    JSON.stringify(subAfterPreview.ids),
  );
  const planShown = await ev(call, `document.body.innerText.includes("校验通过 · 执行计划")`);
  check("A/B 预览安装执行计划", planShown === true);

  const before = traceIds();
  const servedBeforeExec = mock.served();
  const key = `${runId}|s_02|model_ab`;
  // 臂 A 剧本延迟 6s ⇒ 点击后整批真正在飞；冻结/卸载探针落在在飞窗口内
  const sub = await clickAndCaptureSub(call, "确认执行", key, {
    pollMs: 20000,
    waitAfter: 0,
    duringFlight: "tab:概览",
  });
  check(
    "A/B 整批登记（快照=批次行）且卸载编辑器后仍在途",
    sub.channel === "model_ab" &&
      String(sub.text).includes(modelA) &&
      String(sub.text).includes(modelB) &&
      sub.unmountDone === true,
    JSON.stringify(sub).slice(0, 240),
  );
  const frozenNow = await storeQ(
    call,
    `const t = { runId: ${JSON.stringify(runId)}, spanId: 's_02' };
     const b0 = s.modelAbDraftOf(t);
     s.setModelAbRows(t, [{ key: 'x1', model: '冻结期改臂', paramsText: '' }]);
     const b1 = s.modelAbDraftOf(t);
     const discardRejected = s.discardModelAbDraft(t, b0.revision) === false;
     return JSON.stringify({
       writeRejected: b1.rows.length === b0.rows.length && b1.revision === b0.revision,
       discardRejected,
     });`,
  );
  check(
    "A/B 冻结期拒绝改行与放弃（含按旧修订的迟到确认）",
    frozenNow.writeRejected === true && frozenNow.discardRejected === true,
    JSON.stringify(frozenNow),
  );
  const settled = await waitForSettle(call, [key], 120000);
  check(
    "A/B 明确返回后解冻",
    !settled.sub.ids.some((x) => x.id === key) && !settled.timedOut,
    JSON.stringify(settled.sub.ids),
  );
  check(
    "A/B 两臂均发生真实调用（≥2 次，计数如实记录）",
    mock.served() >= servedBeforeExec + 2,
    `served ${servedBeforeExec} → ${mock.served()}`,
  );
  const kids = await newChildren(before, 60000, 2);
  const traces = kids.map((k) => readChild(k));
  const exps = traces.map((t) => t.meta?.fork?.edit?.value?.experimentId ?? null);
  check(
    "A/B 两臂落盘且同属一个实验组",
    kids.length === 2 && exps[0] !== null && exps[0] === exps[1],
    JSON.stringify({ kids, exps }),
  );
  const modelsSeen = mock
    .entries()
    .slice(servedBeforeExec)
    .map((e) => e.model);
  check(
    "A/B 真实 IPC 的提交值 = 批次快照（臂 model 逐字到达）",
    modelsSeen.includes(modelA) && modelsSeen.includes(modelB),
    JSON.stringify(modelsSeen),
  );
  const d2 = await drafts(call);
  const rowsAfter = d2?.modelAb?.[runId]?.s_02?.rows ?? [];
  check(
    "A/B 成功后整批保留",
    rowsAfter.length === 2 && rowsAfter[0].model === modelA,
    JSON.stringify(rowsAfter).slice(0, 200),
  );
  await shot(call, SHOT_DIR, "63-ab-executed.png");
  return { kids, exps, modelA, modelB, rows: rowsAfter };
}

// ---------------------------------------------------------------------------
// 场景 E：创建 —— 成功整份 + 引用恢复但授权复位 + 已消费 token 的业务拒绝
// ---------------------------------------------------------------------------

async function scenarioCreate(call, fx, mock) {
  void fx;
  const mark = Math.random().toString(36).slice(2, 6);
  const task = `受控执行-创建-隔离-${mark}`;

  // 门禁：空表单时「创建隔离运行」/「创建」禁用
  await clickByTextChecked(call, "新建运行", 1200);
  const disabledEmpty = await dialogState(call, "创建");
  check(
    "创建门禁：未填写时提交禁用",
    disabledEmpty !== null && disabledEmpty.disabled === true,
    JSON.stringify(disabledEmpty),
  );

  // ① 纯对话创建成功
  await typeIntoDom(call, 'textarea[placeholder^="要交给模型的任务"]', task);
  await typeIntoDom(
    call,
    'textarea[placeholder^="例如：你是一个简洁"]',
    `受控执行的系统指令-${mark}`,
  );
  await sleep(400);
  const d1 = await drafts(call);
  const snapTask = d1?.create?.userMessage ?? "";
  const before = traceIds();
  const servedBefore = mock.served();
  const key = "|create";
  const sub = await clickAndCaptureSub(call, "创建", key, { inDialog: true });
  check(
    "创建登记整份关联（快照=表单 JSON）",
    sub.channel === "create" && String(sub.text).includes(mark),
    JSON.stringify(sub).slice(0, 220),
  );
  const settled = await waitForSettle(call, [key], 90000);
  check(
    "创建成功解冻（关联已收尾；成功路径自动关对话框并选中子 run）",
    settled.st.creating !== "in_progress" && !settled.sub.ids.some((x) => x.id === key),
    JSON.stringify({ ids: settled.sub.ids, creating: settled.st.creating }),
  );
  const kids = await newChildren(before);
  check(
    "创建打到受控服务 1 次",
    mock.served() === servedBefore + 1,
    `served ${servedBefore} → ${mock.served()}`,
  );
  const child = kids.length > 0 ? readChild(kids[0]) : null;
  const userMsg = (child?.firstRequestMessages ?? []).find((m) => m.role === "user");
  check(
    "创建真实 IPC 的提交值 = 快照（任务原文到达模型）",
    typeof userMsg?.content === "string" && userMsg.content === snapTask,
    JSON.stringify({ userMsg: userMsg?.content ?? null, snapTask }).slice(0, 220),
  );
  const d2 = await drafts(call);
  check(
    "创建成功后草稿保留",
    d2?.create !== null && (d2?.create?.userMessage ?? "") === snapTask,
    JSON.stringify(d2?.create ?? null).slice(0, 160),
  );

  // ② 隔离创建（签发并消费 token）
  await clickByTextChecked(call, "新建运行", 1200);
  await clickInOpenDialog(call, "隔离文件运行", 600);
  await clickInOpenDialog(call, "选择目录…", 1200);
  const authState1 = await domStateInDialog(call, "允许本次执行的副本写入");
  check(
    "隔离创建：未勾选授权时提交禁用",
    authState1 !== null && authState1.submitDisabled === true,
    JSON.stringify(authState1),
  );
  await clickLabelWith(call, "允许本次执行的副本写入", 600);
  const beforeIso = traceIds();
  await clickInOpenDialog(call, "创建隔离运行", 300);
  const settledIso = await waitForSettle(call, [key], 120000);
  check(
    "隔离创建解冻收尾（无待定关联；列表新增在下一条核）",
    settledIso.st.creating !== "in_progress" && settledIso.sub.ids.length === 0,
    JSON.stringify({
      creating: settledIso.st.creating,
      code: settledIso.st.createRunErrorCode,
      ids: settledIso.sub.ids,
    }),
  );
  const isoKids = await newChildren(beforeIso);
  check("隔离创建落盘 1 份 run", isoKids.length === 1, JSON.stringify(isoKids));
  const isoChildMeta = isoKids.length > 0 ? readChild(isoKids[0]).meta : null;
  check(
    "隔离创建真产出 v2 隔离 run（workspace + 固定工具组）",
    isoChildMeta?.format_version === 2 && isoChildMeta?.workspace?.profile === "file-tools-v1",
    JSON.stringify({ fv: isoChildMeta?.format_version, ws: isoChildMeta?.workspace?.profile }),
  );

  // ③ 重新打开：引用恢复但**授权复位**；直接提交 ⇒ INVALID_SOURCE_TOKEN 业务拒绝
  await clickByTextChecked(call, "新建运行", 1200);
  const restored = await ev(
    call,
    `(() => { const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
      if (!dlg) return null;
      const t = dlg.innerText || '';
      const cb = Array.from(dlg.querySelectorAll('input[type=checkbox]'))[0];
      const reBtn = Array.from(dlg.querySelectorAll('button')).some(b => (b.textContent||'').includes('重新选择'));
      return JSON.stringify({ hasRef: t.includes('u3-63'), authChecked: cb ? cb.checked : null,
                              rePick: reBtn, mode: t.includes('隔离文件运行') }); })()`,
  );
  const restoredObj = JSON.parse(restored ?? "null");
  check(
    "重开恢复目录引用但授权复位（勾选=未选、按钮变「重新选择…」）",
    restoredObj !== null &&
      restoredObj.hasRef === true &&
      restoredObj.authChecked === false &&
      restoredObj.rePick === true,
    restored,
  );
  await clickLabelWith(call, "允许本次执行的副本写入", 600);
  const servedBeforeReject = mock.served();
  const beforeReject = traceIds();
  await clickInOpenDialog(call, "创建隔离运行", 300);
  const rejected = await waitForSettle(call, [key], 60000);
  check(
    "已消费 token 的提交被业务拒绝（INVALID_SOURCE_TOKEN）",
    rejected.st.createRunErrorCode === "INVALID_SOURCE_TOKEN",
    JSON.stringify({ code: rejected.st.createRunErrorCode, err: rejected.st.createRunError }).slice(
      0,
      200,
    ),
  );
  check(
    "拒绝零模型请求、零新 run",
    mock.served() === servedBeforeReject &&
      [...traceIds()].filter((x) => !beforeReject.has(x)).length === 0,
    JSON.stringify({
      served: mock.served(),
      added: [...traceIds()].filter((x) => !beforeReject.has(x)),
    }),
  );
  const d3 = await drafts(call);
  check(
    "拒绝后任务保留（不清空草稿）",
    d3?.create !== null && (d3?.create?.userMessage ?? "") === snapTask,
    JSON.stringify(d3?.create ?? null).slice(0, 160),
  );
  const refAfter = await storeQ(
    call,
    "return JSON.stringify({ ref: s.createSourceRef === null ? null : s.createSourceRef.name });",
  );
  check("拒绝后目录引用被清除（要求重选）", refAfter.ref === null, JSON.stringify(refAfter));

  // 关闭对话框，避免影响后续
  await ev(
    call,
    `(() => { const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
    const b = dlg ? Array.from(dlg.querySelectorAll('button')).find(x => (x.textContent||'').trim() === '取消') : null;
    if (b) b.click(); return b ? 'closed' : 'no-cancel'; })()`,
  );
  await sleep(600);
  await shot(call, SHOT_DIR, "63-create-rejected.png");
  return { kid: kids[0] ?? null, isoKid: isoKids[0] ?? null, snapTask, restoredObj };
}

async function domStateInDialog(call, authFragment) {
  return ev(
    call,
    `(() => { const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
      if (!dlg) return null;
      const l = Array.from(dlg.querySelectorAll('label')).find(x => (x.textContent||'').includes(${JSON.stringify(authFragment)}));
      const cb = l ? l.querySelector('input[type=checkbox]') : null;
      const submit = Array.from(dlg.querySelectorAll('button')).find(x => (x.textContent||'').trim() === '创建隔离运行');
      return { authChecked: cb ? cb.checked : null, submitDisabled: submit ? submit.disabled : null }; })()`,
  );
}

// ---------------------------------------------------------------------------
// 场景 F：隔离续跑 —— 预检门禁 → 授权 → 执行 → 重开授权复位
// ---------------------------------------------------------------------------

async function scenarioIsolated(call, fx) {
  const runId = fx.isoRoot;
  const mark = Math.random().toString(36).slice(2, 6);
  const text = `受控执行-隔离续跑-${mark}`;
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickByTextChecked(call, "在此重跑（隔离续跑）", 1200);

  await typeIntoEditableMonaco(call, text);
  const gateNoPreflight = await buttonState(call, "确认重跑");
  check(
    "隔离门禁：未预检时「确认重跑」禁用",
    gateNoPreflight !== null && gateNoPreflight.disabled === true,
    JSON.stringify(gateNoPreflight),
  );

  await clickByTextChecked(call, "校验续跑条件", 2500);
  const capabilityShown = await waitForText(call, "轮末检查点", 12000);
  check("隔离预检通过并显示轮末检查点", capabilityShown === true);
  const gateNoAuth = await buttonState(call, "确认重跑");
  check(
    "隔离门禁：预检通过但未授权时仍禁用",
    gateNoAuth !== null && gateNoAuth.disabled === true,
    JSON.stringify(gateNoAuth),
  );

  const before = traceIds();
  await clickLabelWith(call, "允许本次副本写入", 600);
  const key = `${runId}|s_03|result`;
  const subI = await clickAndCaptureSub(call, "确认重跑", key);
  check(
    "隔离续跑登记关联（快照=草稿、修订推进后重新预检）",
    subI.channel === "result" &&
      subI.text === (await drafts(call)).calls?.[runId]?.s_03?.result?.text,
    JSON.stringify(subI).slice(0, 200),
  );
  const settled = await waitForSettle(call, [key], 120000);
  check(
    "隔离续跑解冻并成功",
    settled.st.forking === "success" && !settled.sub.ids.some((x) => x.id === key),
    JSON.stringify({
      forking: settled.st.forking,
      ids: settled.sub.ids,
      code: settled.st.forkErrorCode,
    }),
  );
  const kids = await newChildren(before);
  const child = kids.length > 0 ? readChild(kids[0]) : null;
  const d1 = await drafts(call);
  const draftText = d1?.calls?.[runId]?.s_03?.result?.text ?? "";
  check(
    "隔离续跑真实 IPC 的提交值 = 快照",
    (child?.meta?.fork?.edit?.value ?? null) === draftText,
    JSON.stringify({ v: child?.meta?.fork?.edit?.value }).slice(0, 200),
  );
  check(
    "隔离子 run 的 workspace.origin 指向父检查点",
    child?.meta?.workspace?.origin?.kind === "checkpoint" &&
      child?.meta?.workspace?.origin?.run_id === runId,
    JSON.stringify(child?.meta?.workspace?.origin ?? null),
  );

  // 重新打开：草稿保留、授权复位（不继承历史 write_authorized）
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickByTextChecked(call, "在此重跑（隔离续跑）", 1500);
  // 重开编辑器后**重新预检**：授权复选框再现时必须仍是未勾选
  //（授权不随草稿/预检恢复，也不从父 trace 的 write_authorized 审计标注补齐）
  await clickByTextChecked(call, "校验续跑条件", 2500);
  const reopenProbe = `(() => { const l = Array.from(document.querySelectorAll('label'))
        .find(x => (x.textContent||'').includes('允许本次副本写入'));
      const cb = l ? l.querySelector('input[type=checkbox]') : null;
      const submit = Array.from(document.querySelectorAll('button'))
        .find(x => (x.textContent||'').trim() === '确认重跑');
      return JSON.stringify({ authChecked: cb ? cb.checked : null,
                              submitDisabled: submit ? submit.disabled : null }); })()`;
  let reopenObj = null;
  for (let i = 0; i < 16; i++) {
    reopenObj = JSON.parse((await ev(call, reopenProbe)) ?? "null");
    if (reopenObj !== null && reopenObj.authChecked !== null) break;
    await sleep(500);
  }
  const reopenDiag = await ev(
    call,
    `(() => { const sec = Array.from(document.querySelectorAll('div'))
        .find(x => (x.textContent||'').includes('续跑条件（只读预检'));
      return (sec ? sec.textContent : 'no-panel').slice(0, 300); })()`,
  );
  const d2 = await drafts(call);
  check(
    "重开并重新预检后：草稿保留、授权仍复位（不继承历史/预检）、未授权提交继续禁用",
    (d2?.calls?.[runId]?.s_03?.result?.text ?? "") === draftText &&
      reopenObj !== null &&
      reopenObj.authChecked === false &&
      reopenObj.submitDisabled === true,
    JSON.stringify({ reopenObj, kept: draftText.slice(0, 30) }),
  );
  await shot(call, SHOT_DIR, "63-isolated-reopened.png");
  return { kid: kids[0] ?? null, draftText, reopenObj };
}

async function waitForText(call, text, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await ev(call, `document.body.innerText.includes(${JSON.stringify(text)})`);
    if (hit === true) return true;
    if (Date.now() > deadline) return false;
    await sleep(400);
  }
}

// ---------------------------------------------------------------------------
// 场景 G：业务拒绝（SETTINGS_NOT_CONFIGURED）+ 本地拒绝（非法 JSON / 取消确认）
// ---------------------------------------------------------------------------

async function scenarioBusiness(call, fx, mock, dialogs) {
  const runId = fx.normalRun;
  const mark = Math.random().toString(36).slice(2, 6);

  // ① 未配置运行配置 ⇒ 提交被 main 拒绝，且**一个模型请求都不发**
  await apiCall(call, "clearSettings");
  await storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1200);
  await typeIntoEditableMonaco(call, `业务拒绝-未配置-${mark}`);
  const d1 = await drafts(call);
  const draftText = d1?.calls?.[runId]?.s_03?.result?.text ?? "";
  const before = traceIds();
  const served = mock.served();
  await clickByTextChecked(call, "确认重跑", 300);
  const settled = await waitForSettle(call, [`${runId}|s_03|result`], 30000);
  check(
    "SETTINGS_NOT_CONFIGURED 业务拒绝（错误码如实）",
    settled.st.forkErrorCode === "SETTINGS_NOT_CONFIGURED",
    JSON.stringify({ code: settled.st.forkErrorCode, err: settled.st.forkError }).slice(0, 200),
  );
  check(
    "业务拒绝零模型请求、零新 run",
    mock.served() === served && [...traceIds()].filter((x) => !before.has(x)).length === 0,
    JSON.stringify({ served: mock.served(), added: [...traceIds()].filter((x) => !before.has(x)) }),
  );
  check(
    "业务拒绝后解冻（不永久冻结）",
    !settled.sub.ids.some((x) => x.id === `${runId}|s_03|result`),
    JSON.stringify(settled.sub.ids),
  );
  const d2 = await drafts(call);
  check("业务拒绝后草稿逐字保留", (d2?.calls?.[runId]?.s_03?.result?.text ?? "") === draftText);

  // 恢复配置（其余子场景需要）
  await apiCall(call, "saveSettings", {
    baseURL: MOCK_BASE,
    apiKey: "sk-u363-controlled",
    model: "mock-model",
  });
  await storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");

  // ② messages 非法 JSON：本地拒绝 ⇒ 立即收尾、不发请求、不永久冻结
  await selectRun(call, fx.proxyRun);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  await clickByTextChecked(call, "编辑 messages 重发", 1200);
  await setEditableMonaco(call, '{"broken": [1,2,');
  await sleep(400);
  const served2 = mock.served();
  const before2 = traceIds();
  await clickByTextChecked(call, "确认重发", 200);
  await sleep(1500);
  const subAfter = await submissions(call);
  const d3 = await drafts(call);
  check("本地拒绝（非法 JSON）不留下冻结", subAfter.ids.length === 0, JSON.stringify(subAfter.ids));
  check(
    "本地拒绝零模型请求、零新 run",
    mock.served() === served2 && [...traceIds()].filter((x) => !before2.has(x)).length === 0,
    JSON.stringify({ served: mock.served() }),
  );
  check(
    "本地拒绝后草稿保留（无损字符串）",
    (d3?.calls?.[fx.proxyRun]?.s_02?.messages?.text ?? "").includes('"broken"'),
  );

  // ③ prompt 取消确认：明确未发请求 ⇒ 直接收尾，不留冻结
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  await clickByTextChecked(call, "编辑 system prompt 重跑", 1200);
  await typeIntoEditableMonaco(call, `取消确认-${mark}`);
  const served3 = mock.served();
  const before3 = traceIds();
  dialogs.setAccept(false);
  await clickByText(call, "确认从头重跑", 300);
  await sleep(2000);
  dialogs.setAccept(true);
  const sub4 = await submissions(call);
  const d4 = await drafts(call);
  check(
    "取消确认 ⇒ 不留冻结、零请求、零新 run",
    sub4.ids.length === 0 &&
      mock.served() === served3 &&
      [...traceIds()].filter((x) => !before3.has(x)).length === 0,
    JSON.stringify({
      ids: sub4.ids,
      served: mock.served(),
      added: [...traceIds()].filter((x) => !before3.has(x)),
    }),
  );
  check(
    "取消确认后草稿保留",
    (d4?.calls?.[runId]?.s_02?.system_prompt?.text ?? "").includes(`取消确认-${mark}`),
  );
  await shot(call, SHOT_DIR, "63-business-rejected.png");
  return { draftText };
}

// ---------------------------------------------------------------------------
// 场景 H：503 故障注入 —— 失败 run 保留、草稿保留、解冻
// ---------------------------------------------------------------------------

async function scenarioFault(call, fx, mock, dialogs) {
  const runId = fx.normalRun;
  const mark = Math.random().toString(36).slice(2, 6);

  // 先在 result 编辑器留一份草稿（后续「未知状态」子场景要用它比对）
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1200);
  await typeIntoEditableMonaco(call, `503-对照-未知态-${mark}`);
  const d1 = await drafts(call);
  const draftText = d1?.calls?.[runId]?.s_03?.result?.text ?? "";
  await clickByTextChecked(call, "取消", 800);

  // ① 503 故障注入（prompt fork 通道：turn[0] 受控服务返回 503）
  const nDialogs = dialogs.log.length;
  await clickSpan(call, "LLM", "s_02");
  await clickByTextChecked(call, "编辑 system prompt 重跑", 1200);
  const pText = `503-故障注入-${mark}`;
  await typeIntoEditableMonaco(call, pText);
  const dp = await drafts(call);
  const pSnap = dp?.calls?.[runId]?.s_02?.system_prompt?.text ?? "";
  const beforeP = traceIds();
  await clickByTextChecked(call, "确认从头重跑", 200);
  check(
    "503 场景仍经原生确认（未因故障绕过执行门禁）",
    dialogs.log.slice(nDialogs).some((x) => x.accept === true),
    JSON.stringify(dialogs.log.slice(nDialogs)),
  );
  const settled = await waitForSettle(call, [`${runId}|s_02|system_prompt`], 120000);
  check(
    "503 明确返回后解冻",
    !settled.sub.ids.some((x) => x.id === `${runId}|s_02|system_prompt`) && !settled.timedOut,
    JSON.stringify(settled.sub.ids),
  );
  const kids = await newChildren(beforeP, 60000, 1);
  const child = kids.length > 0 ? readChild(kids[0]) : null;
  const err = child?.firstError ?? null;
  check(
    "503 失败 run 仍落盘（meta.fork.edit.value = 快照）",
    (child?.meta?.fork?.edit?.value ?? null) === pSnap,
    JSON.stringify({ edit: child?.meta?.fork?.edit?.value }).slice(0, 200),
  );
  check(
    "503 失败记录在 llm.call.error（status=503）",
    err !== null && err?.status === 503,
    JSON.stringify(err),
  );
  const d2 = await drafts(call);
  check("503 失败后草稿保留", (d2?.calls?.[runId]?.s_02?.system_prompt?.text ?? "") === pSnap);
  const shown = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => (x.getAttribute('aria-label') || '').startsWith('复制完整运行 ID ${child?.meta?.id ?? "__none__"}'));
     return b !== undefined && b !== null; })()`,
  );
  check("失败 run 在列表可见", shown === true, JSON.stringify({ kid: child?.meta?.id ?? null }));

  // ② 迟到/未知态的解冻守卫（真 store 上的行为级故障注入）：
  // 如实记录：sandbox 下 contextBridge 的 window.api 属性只读，渲染层内无法 monkey-patch
  // IPC 通道；未知态的真实来源是「通道失联（reload/崩溃）」，那会整体销毁会话（归 6.6/6.7 验证）。
  // 本处注入的是 D5 的两条硬守卫：旧令牌（迟到回调）**不能**解冻待定关联；同令牌才能。
  const unknown = await storeQ(
    call,
    `const k = { runId: ${JSON.stringify(runId)}, spanId: 's_03', field: 'result' };
     const assoc = s.beginDraftSubmission({ channel: 'result', target: k });
     if (assoc === null) return JSON.stringify({ error: 'begin-rejected' });
     const stale = { ...assoc, token: assoc.token + 99 };
     s.settleDraftSubmission(stale); // 注入：模拟迟到的旧回调拿旧快照来收尾
     const frozenAfterStale = m.useAppStore.getState().isDraftFrozen(k);
     const writeBlocked = (s.writeCallDraftText(k, '迟到解冻后的写入' + Math.random()),
       m.useAppStore.getState().callDraftOf(k).text);
     s.settleDraftSubmission(assoc); // 同令牌 → 正常解冻
     const frozenAfterOwn = m.useAppStore.getState().isDraftFrozen(k);
     return JSON.stringify({
       frozenAfterStale, writeBlockedSameText: writeBlocked === assoc.submittedText,
       frozenAfterOwn,
     });`,
  );
  check(
    "迟到回调（旧令牌）不能错误解冻；冻结期拒绝写入；同令牌正常解冻",
    unknown.frozenAfterStale === true &&
      unknown.writeBlockedSameText === true &&
      unknown.frozenAfterOwn === false,
    JSON.stringify(unknown),
  );
  // 收尾：解除该注入关联（模拟后续明确结论），避免污染后续 tag
  await storeQ(
    call,
    `const k = { runId: ${JSON.stringify(runId)}, spanId: 's_03', field: 'result' };
     const x = s.draftSubmissions.byId[k.runId + '|' + k.spanId + '|' + k.field];
     if (x !== undefined) s.settleDraftSubmission(x);
     return JSON.stringify({ left: Object.keys(s.draftSubmissions.byId) });`,
  );
  const after = await submissions(call);
  check("注入场景收尾后无残留关联", after.ids.length === 0, JSON.stringify(after.ids));
  await shot(call, SHOT_DIR, "63-fault-503.png");
  return { kid: kids[0] ?? null, pSnap, err, unknown };
}

// ---------------------------------------------------------------------------
// 场景 I：部分 A/B 失败（臂 1 成功、臂 2 受控 503）
// ---------------------------------------------------------------------------

async function scenarioAbPartial(call, fx, mock) {
  const runId = fx.normalRun;
  const mark = Math.random().toString(36).slice(2, 6);
  const modelA = `u363-ok-${mark}`;
  const modelB = `u363-fail-${mark}`;
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  await clickByTextChecked(call, "模型 A/B 实验（换 model / params 对比）", 1200);
  await armModelsInput(call, 0, modelA);
  await armModelsInput(call, 1, modelB);
  await sleep(600);
  await clickLabelWith(call, "未标记 sideEffect");
  await clickByTextChecked(call, "校验并预览计划", 2000);
  const before = traceIds();
  const served = mock.served();
  const key = `${runId}|s_02|model_ab`;
  // 真点击需要编辑器在场 ⇒ 另起一个**页内轮询**等「部分失败」如实播报（不 await 阻塞点击）
  const shownP = evAsync(
    call,
    `(async () => { const deadline = Date.now() + 90000;
      for (;;) {
        if ((document.body.innerText || '').includes('其余失败或被取消')) return 'shown';
        if (Date.now() > deadline) return 'not-shown';
        await new Promise(r => setTimeout(r, 250));
      } })()`,
  ).catch(() => "eval-lost");
  const subP = await clickAndCaptureSub(call, "确认执行", key, { pollMs: 20000, waitAfter: 0 });
  check(
    "部分失败前整批已登记（真点击）",
    subP.channel === "model_ab",
    JSON.stringify(subP).slice(0, 160),
  );
  const settled = await waitForSettle(call, [key], 120000);
  const shown = await shownP;
  check(
    "部分失败仍是明确返回 ⇒ 解冻整批",
    !settled.sub.ids.some((x) => x.id === key) && !settled.timedOut,
    JSON.stringify(settled.sub.ids),
  );
  check(
    "两臂都发生了真实调用（≥2 次，计数如实）",
    mock.served() >= served + 2,
    `served ${served} → ${mock.served()}`,
  );
  const kids = await newChildren(before, 60000, 2);
  const traces = kids.map((k) => readChild(k));
  const byId = Object.fromEntries(traces.map((t) => [t.meta?.id, t]));
  // 如实口径：readRun 的 status 只有 completed（已封存）/ crashed（未封存）；
  // 「失败结局」在 run.event(reason=error) 与 llm.call.error —— 两条臂都正常封存
  const outcomes = {};
  for (const id of kids) {
    const lines = readFileSync(join(TRACES, `${id}.jsonl`), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const evLast = lines[lines.length - 1];
    outcomes[id] = {
      sealed: evLast?.type === "run.event",
      event: evLast?.event ?? null,
      reason: evLast?.reason ?? null,
    };
  }
  const okIds = kids.filter((id) => outcomes[id]?.reason === "completed");
  const errIds = kids.filter((id) => outcomes[id]?.reason === "error");
  const errLlm = errIds.length > 0 ? (byId[errIds[0]]?.firstError ?? null) : null;
  check(
    "一臂成功收尾（completed）、一臂失败收尾（error），两条都正常封存",
    kids.length === 2 &&
      okIds.length === 1 &&
      errIds.length === 1 &&
      Object.values(outcomes).every((o) => o.sealed === true),
    JSON.stringify(outcomes),
  );
  check(
    "失败臂的 503 如实落在 llm.call.error.status",
    errLlm !== null && errLlm.status === 503,
    JSON.stringify(errLlm),
  );
  const d = await drafts(call);
  const rowsAfter = d?.modelAb?.[runId]?.s_02?.rows ?? [];
  check(
    "部分失败后整批草稿保留",
    rowsAfter.length === 2 && rowsAfter[0].model === modelA && rowsAfter[1].model === modelB,
    JSON.stringify(rowsAfter),
  );
  const shownDiag = await ev(
    call,
    `(() => { const i = (document.body.innerText || '').indexOf('实验完成');
      return i < 0 ? 'no-实验完成-text' : (document.body.innerText || '').slice(i, i + 130); })()`,
  );
  check(
    "界面如实报「部分臂失败」（成功计数只算成功臂）",
    shown === "shown" && /成功 1 臂/.test(String(shownDiag)),
    shownDiag,
  );
  await shot(call, SHOT_DIR, "63-ab-partial.png");
  return { kids, rows: rowsAfter };
}

// ---------------------------------------------------------------------------
// 场景 J：卸载重挂 + 迟到回调（同目标重复登记被拒、不换令牌）
// ---------------------------------------------------------------------------

async function scenarioLate(call, fx) {
  const runId = fx.normalRun;
  const mark = Math.random().toString(36).slice(2, 6);
  const text = `迟到回调-卸载重挂-${mark}`;
  const key = `${runId}|s_03|result`;
  const before = traceIds();

  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1200);
  await typeIntoEditableMonaco(call, text);
  const d1 = await drafts(call);
  const draftText = d1?.calls?.[runId]?.s_03?.result?.text ?? "";
  const rev1 = d1?.calls?.[runId]?.s_03?.result?.revision;

  // 点击提交并**在飞期间切页签卸载编辑器**（in-flight 轮询与 DOM 动作在同一次求值内完成；
  // 受控服务延迟 6s 才响应，卸载确实落在请求在途窗口）
  const sub1 = await clickAndCaptureSub(call, "确认重跑", key, {
    pollMs: 15000,
    waitAfter: 0,
    duringFlight: "tab:概览",
  });
  check(
    "编辑器卸载后待定关联仍在（提交快照独立于挂载）",
    sub1.channel === "result" && sub1.text === draftText && sub1.unmountDone === true,
    JSON.stringify(sub1).slice(0, 220),
  );

  // 迟到回调面：同目标再登记 ⇒ 拒绝且不换令牌（旧响应的收尾只命中自己那次关联）
  const dup = await storeQ(
    call,
    `const k = { runId: ${JSON.stringify(runId)}, spanId: 's_03', field: 'result' };
     const again = s.beginDraftSubmission({ channel: 'result', target: k });
     const st = s.draftSubmissions.byId[k.runId + '|' + k.spanId + '|' + k.field];
     return JSON.stringify({ again: again === null ? 'rejected' : 'accepted',
                             token: st === undefined ? null : st.token });`,
  );
  check(
    "在飞期间同目标重复登记被拒、令牌不变（旧响应只会收尾自己那次）",
    dup.again === "rejected" && dup.token === sub1?.token,
    JSON.stringify(dup),
  );

  // 冻结期写入被 store 拒绝（快照不被后续输入污染）
  const frozen = await storeQ(
    call,
    `const k = { runId: ${JSON.stringify(runId)}, spanId: 's_03', field: 'result' };
     s.writeCallDraftText(k, '冻结期新输入-' + Math.random());
     const e = s.callDraftOf(k);
     return JSON.stringify({ text: e === undefined ? null : e.text, revision: e === undefined ? null : e.revision });`,
  );
  check(
    "冻结期拒绝写入（修订未推进）",
    frozen.text === draftText && frozen.revision === rev1,
    JSON.stringify(frozen).slice(0, 200),
  );
  const discarded = await storeQ(
    call,
    `const k = { runId: ${JSON.stringify(runId)}, spanId: 's_03', field: 'result' };
     return JSON.stringify({ ok: s.discardCallDraft(k, ${rev1}) });`,
  );
  check(
    "冻结期拒绝放弃（含按旧修订的迟到确认）",
    discarded.ok === false,
    JSON.stringify(discarded),
  );

  const settled = await waitForSettle(call, [key], 120000);
  check(
    "迟到响应只收尾自己的关联（解冻）",
    !settled.sub.ids.some((x) => x.id === key),
    JSON.stringify(settled.sub.ids),
  );
  const kids = await newChildren(before);
  check("在飞期间卸载编辑器不影响执行落盘", kids.length === 1, JSON.stringify(kids));
  const child = kids.length > 0 ? readChild(kids[0]) : null;
  check(
    "提交值 = 在飞期间未被后续写入污染的快照",
    (child?.meta?.fork?.edit?.value ?? null) === draftText,
    JSON.stringify({ edit: child?.meta?.fork?.edit?.value, draftText }).slice(0, 220),
  );

  // 重挂：控件恢复草稿全文（编辑器挂载态与提交无关）
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1500);
  const info = await monacoInfo(call);
  check(
    "解冻后重挂：控件恢复草稿全文且可继续编辑",
    info.editors.some((e) => e.visible && !e.readOnly && (e.value ?? "").includes(text)),
    JSON.stringify(info.editors.map((e) => ({ ro: e.readOnly, v: (e.value ?? "").slice(-24) }))),
  );
  await shot(call, SHOT_DIR, "63-late-callback.png");
  return { kid: kids[0] ?? null, draftText, dup, frozen };
}

// ---------------------------------------------------------------------------
// 场景 K：原有执行入口与文件阅读继续可用
// ---------------------------------------------------------------------------

async function scenarioRegression(call, fx) {
  const entries = [];
  const entryProbe = async (runId, titleFragment, spanId, buttonText) => {
    await selectRun(call, runId);
    await clickTabChecked(call, "步骤");
    await clickSpan(call, titleFragment, spanId);
    const has = await ev(
      call,
      `(() => Array.from(document.querySelectorAll('button'))
         .some(x => (x.textContent||'').includes(${JSON.stringify(buttonText)})))()`,
    );
    entries.push({ runId, buttonText, has: has === true });
    return has === true;
  };
  await entryProbe(fx.normalRun, "read_file", "s_03", "在此重跑（时间旅行）");
  await entryProbe(fx.isoRoot, "read_file", "s_03", "在此重跑（隔离续跑）");
  await entryProbe(fx.normalRun, "LLM", "s_02", "编辑 system prompt 重跑");
  await entryProbe(fx.proxyRun, "LLM", "s_02", "编辑 messages 重发");
  await entryProbe(fx.normalRun, "LLM", "s_02", "模型 A/B 实验（换 model / params 对比）");
  check(
    "五个执行入口全部可达",
    entries.every((e) => e.has === true),
    JSON.stringify(entries),
  );
  const globalNew = await ev(
    call,
    `(() => Array.from(document.querySelectorAll('button'))
    .some(x => (x.textContent||'').includes('新建运行')))()`,
  );
  check("创建入口（新建运行）可达", globalNew === true);

  // 文件阅读（U2）继续可用：隔离 run 的「文件」页签 + 清单 + 内容读取
  await selectRun(call, fx.isoRoot);
  const fileTabVisible = await ev(
    call,
    `(() => Array.from(document.querySelectorAll('[role="tab"]'))
       .some(x => (x.textContent||'').trim() === '文件'))()`,
  );
  check("隔离 run 仍出现「文件」页签", fileTabVisible === true);
  const fileTabOpened = await clickTab(call, "文件");
  const filesShown = await waitForText(call, "文件检查点", 12000);
  check("文件视图可打开（检查点选择器渲染）", fileTabOpened === true && filesShown === true);
  const readBack = await appImport(
    call,
    STORE_NEEDLE,
    `const env = await window.api.inspectWorkspace({ runId: ${JSON.stringify(fx.isoRoot)} });
     if (!env.ok) return JSON.stringify({ ok: false, code: env.error.code });
    const f = env.data.files[0];
     const one = f === undefined ? null : await window.api.readWorkspaceFile({ runId: ${JSON.stringify(fx.isoRoot)}, path: f.path });
     return JSON.stringify({ ok: true, count: env.data.fileCount,
       firstPath: f === undefined ? null : f.path,
       status: one && one.ok ? one.data.status : null,
       sha256: one && one.ok ? String(one.data.sha256 ?? '').slice(0, 12) : null });`,
  );
  check(
    "文件清单与内容读取 IPC 仍可用（真读回内容）",
    readBack.ok === true && readBack.count >= 1 && readBack.status !== null,
    JSON.stringify(readBack),
  );
  await shot(call, SHOT_DIR, "63-regression-files.png");
  return { entries, readBack };
}

// ---------------------------------------------------------------------------
// 剧本
// ---------------------------------------------------------------------------

const OK_TURN = { content: "受控响应：本轮结束，不再调用工具。" };
const FAIL_503 = {
  mode: "fail",
  status: 503,
  errorBody: { error: { message: "受控 503（U3 6.3 故障注入）" } },
};

const SCRIPTS = {
  result: { turns: [OK_TURN] },
  prompt: { turns: [OK_TURN] },
  // 回合 0 被代理录制消费，回合 1 被 messages 重发消费
  messages: { turns: [OK_TURN, OK_TURN] },
  // 臂 A 先工具轮后收尾（回合 0 延迟 6s 造在飞窗口），臂 B 一次收尾；兜底 OK 防回合数波动
  ab: {
    turns: [
      {
        ...OK_TURN,
        delayMs: 6000,
        toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }],
      },
      OK_TURN,
      OK_TURN,
    ],
    fallback: OK_TURN,
  },
  // 回合 0 = 纯对话创建；1/2 = 隔离创建两轮
  create: { turns: [OK_TURN, OK_TURN, OK_TURN] },
  isolated: { turns: [OK_TURN] },
  business: { turns: [OK_TURN] },
  // 回合 0 = prompt fork 的 503 故障注入
  fault: { turns: [FAIL_503, OK_TURN] },
  // 臂 A 单轮收尾（延迟 4s 造在飞窗口）、臂 B 首轮 503 ⇒ 部分失败
  "ab-partial": { turns: [{ ...OK_TURN, delayMs: 4000 }, FAIL_503], fallback: OK_TURN },
  // 回合 0 延迟 6s 响应 ⇒ 「切页签卸载编辑器」确实发生在请求在途窗口内
  late: { turns: [{ ...OK_TURN, delayMs: 6000 }] },
  regression: { turns: [OK_TURN] },
};

async function main() {
  const fx = fixture();
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const data = loadOut();
  const page = await cdpConnect(PORT);
  const call = await makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  const dialogs = attachDialogHandler(call, []);

  await call("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      if ((await runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间可能失败 */
    }
  }
  await sleep(900);
  const ready = (await runs(call)).length;
  console.log(`冷重载完成：运行列表 ${ready} 项`);
  if (ready === 0) throw new Error("重载后运行列表为空——夹具未就绪");

  const mock = await prepare(call, SCRIPTS[TAG] ?? { turns: [OK_TURN] });
  const settingsBefore = existsSync(SETTINGS_FILE);
  console.log(
    `受控服务就绪（${MOCK_BASE}，剧本 ${SCRIPTS[TAG]?.turns?.length ?? 1} 回合）；settings 已配置=${settingsBefore}`,
  );

  const scenarios = {
    result: () => scenarioResult(call, fx),
    prompt: () => scenarioPrompt(call, fx, dialogs),
    messages: () => scenarioMessages(call, fx, mock),
    ab: () => scenarioAb(call, fx, mock),
    create: () => scenarioCreate(call, fx, mock),
    isolated: () => scenarioIsolated(call, fx),
    business: () => scenarioBusiness(call, fx, mock, dialogs),
    fault: () => scenarioFault(call, fx, mock, dialogs),
    "ab-partial": () => scenarioAbPartial(call, fx, mock),
    late: () => scenarioLate(call, fx),
    regression: () => scenarioRegression(call, fx),
  };
  const run = scenarios[TAG];
  if (run === undefined) throw new Error(`unknown tag: ${TAG}`);
  let out = null;
  let failure = null;
  try {
    out = await run();
  } catch (e) {
    failure = String(e);
    check(`[${TAG}] 场景未抛异常`, false, failure);
  } finally {
    await teardown(call, mock);
  }
  out = out ?? {};
  out.mockEntries = mock.entries();
  out.dialogs = dialogs.log;
  if (failure !== null) out.failure = failure;
  data.measurements[TAG] = out;
  data.checks = data.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
  saveOut(data);

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n完成：[${TAG}] ${checks.length - failed.length}/${checks.length} 通过；证据 ${SHOT_DIR}`,
  );
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
