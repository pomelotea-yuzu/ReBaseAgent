/* eslint-disable */
/**
 * U4 实机批（6.2–6.8）共用的受控执行 harness：
 * 真 CDP 会话（含原生 window.confirm 真应答）+ 真 store / 真桥接面通道 + 页内 UI helper
 * + 落盘读取与逐文件哈希。机制原样搬自 U3 6.1–6.3 已验证的实现（u3-63-cdp.cjs 第 94–632 行），
 * ⚠️ 本文件不含判据——判据在各 u4-6x-cdp.cjs 里，别把这里的工具当断言读。
 *
 * 前置：dev 带 CDP 9612（node scripts/u2-dev-host.cjs）；受控服务由本库进程内起停。
 */
"use strict";
const { createHash } = require("node:crypto");
const {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} = require("node:fs");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, shot, call0 } = require("./u2-cdp-util.cjs");
const { startMockLlmServer } = require("../mock-llm-server.cjs");

const CDP_PORT = 9612;
const MOCK_PORT = 18799;
const PROXY_PORT = 18787;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
// 代理 upstream 的真实口径**不带路径**（handler 自己拼 /v1/chat/completions）
const MOCK_UPSTREAM = `http://127.0.0.1:${MOCK_PORT}`;
const TRACES = join(REPO, ".rebaseagent", "traces");
const SETTINGS_FILE = join(REPO, ".rebaseagent", "settings.json");
const OK_TURN = { content: "受控响应：本轮结束，不再调用工具。" };

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
module.exports = {
  REPO,
  sleep,
  cdpConnect,
  shot,
  call0,
  startMockLlmServer,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  join,
  createHash,
  CDP_PORT,
  MOCK_PORT,
  PROXY_PORT,
  MOCK_BASE,
  MOCK_UPSTREAM,
  TRACES,
  SETTINGS_FILE,
  OK_TURN,
  makeDialogSession,
  attachDialogHandler,
  ev3,
  ev,
  STORE_NEEDLE,
  MONACO_NEEDLE,
  appImport,
  evAsync,
  storeQ,
  drafts,
  submissions,
  execState,
  apiCall,
  fs,
  traceIds,
  hashAllTraces,
  hashSourceDir,
  readChild,
  waitForSettle,
  clickAndCaptureSub,
  newChildren,
  RUNS_EXPR,
  runs,
  clickTab,
  clickTabChecked,
  selectRun,
  clickSpan,
  clickByText,
  clickByTextChecked,
  clickInOpenDialog,
  dialogState,
  domState,
  clickLabelWith,
  monacoInfo,
  typeIntoEditableMonaco,
  setEditableMonaco,
  typeIntoDom,
  prepare,
  teardown,
};
