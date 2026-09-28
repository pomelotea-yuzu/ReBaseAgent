/* eslint-disable */
/**
 * U5 任务 6.4（第三批受控实机）：prompt 与代理 messages 的确认、失败定位、正常清理和凭据缺失门禁。
 *
 * 覆盖 evidence-index「实机入口 = 6.4」各计划 tag：
 * prompt-confirm / messages-confirm（A1.3）、prompt-cleanup（A4.1）、failure-locate + return-draft（A3.5）、
 * messages-refork（M1.1）、messages-unchanged（M1.2）、messages-no-key（M1.3）、sdk-run-no-entry（M1.4）。
 *
 * 判据口径（与 6.2/6.3 同纪律）：
 * - 披露短语**运行时从 `lib/execution-confirmation.ts` 源码抽取静态字面量**再断言页面在场
 *   （判据与组件同一来源，不手抄第二份话术）；
 * - 代理捕获链路：proxyToggle 启用 → node 侧 POST 经代理（带 Authorization）⇒ 代理捕获 key
 *   并录制 run（meta.source.kind="proxy"）；重发经运行中的代理走 upstream mock（零付费）；
 * - 结局只按落盘 run.event 判；核实事实读 resultReads（epoch 取 main 当前值）。
 *
 * 用法：`node apps/desktop/scripts/u5-64-cdp.cjs --tag=<TAG>`；前置 dev 由 run-all 起。
 */
"use strict";
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { fixtureOf } = require("./lib/u5-sse-fixtures.cjs");

const TAGS = [
  "prompt-confirm",
  // 必须先于任何捕获 tag（见 run-all.cjs TAGS 注释）：同 dev 会话内 keyStore.lastKey
  // 一旦被捕获就不清（禁用代理不清 key），"未捕获"前提只在批首成立。
  "messages-no-key",
  "messages-confirm",
  "prompt-cleanup",
  "failure-locate",
  "return-draft",
  "messages-refork",
  "messages-unchanged",
  "sdk-run-no-entry",
];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u5", "u5-64");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-28-u5-64");
const MARK = "U5-64";
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const CONF_LIB = join(H.REPO, "apps/desktop/src/renderer/src/lib/execution-confirmation.ts");
const PANEL_FILE = join(H.REPO, "apps/desktop/src/renderer/src/components/DetailPanel.tsx");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
if (!existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
const FX = JSON.parse(readFileSync(MANIFEST, "utf8"));

const OK_TURN = { content: `${MARK} 受控成功：一步答完。` };
const FAIL503_TURN = { mode: "fail", status: 503, content: "upstream unavailable", delayMs: 1200 };
/** 组合剧本：turns 顺序消费（含代理捕获 POST 的转发），耗尽走 fallback */
const TAG_SCRIPT = {
  "prompt-confirm": { turns: [], fallback: OK_TURN },
  "messages-confirm": { turns: [], fallback: OK_TURN },
  "prompt-cleanup": { turns: [], fallback: OK_TURN },
  "failure-locate": { turns: [FAIL503_TURN], fallback: OK_TURN },
  "return-draft": { turns: [FAIL503_TURN], fallback: OK_TURN },
  "messages-refork": { turns: [], fallback: OK_TURN },
  "messages-unchanged": { turns: [], fallback: OK_TURN },
  "messages-no-key": { turns: [], fallback: OK_TURN },
  "sdk-run-no-entry": { turns: [], fallback: OK_TURN },
};
/** 该 tag 是否需要代理捕获（messages 系需要 key；no-key 明确不捕获） */
const NEEDS_CAPTURE = ["messages-confirm", "messages-refork", "messages-unchanged"];
const USES_PROXY = [...NEEDS_CAPTURE, "messages-no-key"];

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
function finish(extraMeta = {}) {
  const failed = checks.filter((c) => !c.ok);
  const meta = {
    head: headShort(),
    electron: electronVersion(),
    node: process.version,
    fixtures: { normalRun: FX.normalRun, isoRoot: FX.isoRoot, proxyRun: FX.proxyRun ?? null },
    tracesCount: H.traceIds().size,
    ...extraMeta,
  };
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, meta, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条；meta=${JSON.stringify(meta)}`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 10 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 600_000);

function headShort() {
  try {
    const head = readFileSync(join(H.REPO, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: (.+)$/);
    if (m) {
      const refFile = join(H.REPO, ".git", ...m[1].split("/"));
      if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim().slice(0, 7);
      const packed = readFileSync(join(H.REPO, ".git", "packed-refs"), "utf8");
      const line = packed.split(/\r?\n/).find((l) => l.endsWith(` ${m[1]}`));
      if (line) return line.split(" ")[0].slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}
function electronVersion() {
  try {
    return require(join(H.REPO, "apps", "desktop", "node_modules", "electron", "package.json"))
      .version;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// 披露短语自证：从 lib 源码抽指定函数体内的静态字面量（与组件同一来源）
// ---------------------------------------------------------------------------
function disclosurePhrases(fnName) {
  const src = readFileSync(CONF_LIB, "utf8");
  const at = src.indexOf(`export function ${fnName}`);
  if (at < 0) throw new Error(`lib 里找不到 ${fnName}`);
  const next = src.indexOf("\nexport ", at + 10);
  const body = src.slice(at, next > 0 ? next : undefined);
  const out = [];
  for (const m of body.matchAll(/"([^"\\]{6,})"|'([^'\\]{6,})'/g)) {
    const lit = m[1] ?? m[2];
    if (!lit.includes("${") && !lit.includes("input.") && !lit.includes("`")) out.push(lit);
  }
  return out;
}

/** 从 DetailPanel 源码抽指定片段之后的第一个字符串字面量（判据与组件同源，不手抄第二份话术） */
function panelLiteral(fragment) {
  const src = readFileSync(PANEL_FILE, "utf8");
  const at = src.indexOf(fragment);
  if (at < 0) throw new Error(`DetailPanel 里找不到 ${fragment}`);
  const m = src.slice(at).match(/"([^"]+)"/);
  if (!m) throw new Error(`DetailPanel ${fragment} 之后没有字符串字面量`);
  return m[1];
}

// ---------------------------------------------------------------------------
// 读数与页内动作
// ---------------------------------------------------------------------------
const opsStatus = (call) => H.apiCall(call, "operationsStatus");
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  const rec = (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null;
  return { rec, slot: st?.data?.activeOperationId ?? null, epoch: st?.data?.epoch ?? null };
};
const resultReadFor = async (call, epoch, operationId, runId) => {
  const all = await H.storeQ(call, "return JSON.stringify(s.resultReads.byKey);");
  return all[`${epoch}|${operationId}|${runId}`] ?? null;
};
async function waitForVerified(call, epoch, operationId, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = await resultReadFor(call, epoch, operationId, runId);
    if (entry !== null && entry.phase !== "reading") return entry;
    if (Date.now() > deadline) return entry;
    await H.sleep(400);
  }
}
const readingState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({ view: s.view, selectedRunId: s.selectedRunId,
       selectedSpanId: s.selectedSpanId,
       tab: s.selectedRunId ? (s.readingByRun[s.selectedRunId]?.tab ?? null) : null });`,
  );
const callDraftText = async (call, runId, spanId, field) => {
  const d = await H.drafts(call);
  return d?.calls?.[runId]?.[spanId]?.[field]?.text ?? null;
};
function traceFacts(id) {
  const lines = readFileSync(join(H.TRACES, `${id}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const llms = lines.filter((l) => l.type === "span" && l.kind === "llm.call");
  const last = lines[lines.length - 1];
  return {
    meta: lines[0],
    llmSpanId: llms.length > 0 ? llms[0].id : null,
    firstMessages: llms.length > 0 ? (llms[0].request?.messages ?? null) : null,
    firstLlmError: llms.length > 0 ? (llms[0].error ?? null) : null,
    event: last?.type === "run.event" ? last.event : null,
    reason: last?.type === "run.event" ? last.reason : null,
  };
}
const visibleConfirmExpr = `(() => {
  const all = Array.from(document.querySelectorAll('[data-confirm-execution]'));
  return all.find(b => b.offsetParent !== null) ?? null;
})()`;
async function confirmEditor(call) {
  const before = await H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      if (!b) return JSON.stringify({ error: 'no-visible-confirm' });
      return JSON.stringify({ disabled: b.disabled, pressed: b.getAttribute('aria-pressed') }); })()`,
  );
  const parsed = JSON.parse(before);
  if (parsed.error) throw new Error(`确认按钮缺失：${parsed.error}`);
  if (parsed.disabled !== false) throw new Error(`确认按钮不可点：${JSON.stringify(parsed)}`);
  await H.ev(call, `(() => { ${visibleConfirmExpr}.click(); return true; })()`);
  await H.sleep(500);
  const after = await H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      return b === null ? null : { pressed: b.getAttribute('aria-pressed') }; })()`,
  );
  if (after?.pressed !== "true") throw new Error(`点确认后 aria-pressed=${after?.pressed}`);
}
/** 提交并捕获关联（优先可用按钮；捕获扑空不抛，交由调用方按 none 处理） */
async function submitAndCapture(
  call,
  buttonText,
  key,
  { duringFlight = null, pollMs = 9000 } = {},
) {
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .filter(x => x.offsetParent !== null && !x.disabled)
        .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
      if (!btn) {
        const anyV = Array.from(document.querySelectorAll('button'))
          .filter(x => x.offsetParent !== null)
          .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
        return JSON.stringify({ error: anyV ? 'button-disabled' : 'button-not-found' });
      }
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
          const snap = { channel: x.channel, revision: x.submittedRevision, text: x.submittedText,
                         operationId: x.operationId ?? null, epoch: x.epoch ?? null };
          if (!flightDone && ${JSON.stringify(duringFlight ?? null)} !== null) {
            const [kind, name] = ${JSON.stringify(duringFlight ?? null)}.split(':');
            if (kind === 'tab') {
              const t = Array.from(document.querySelectorAll('[role="tab"]'))
                .find(y => ((y.textContent||'').trim()) === name);
              if (t) t.click();
            }
            flightDone = true;
            const x2 = m.useAppStore.getState().draftSubmissions.byId[${JSON.stringify(key)}];
            return JSON.stringify({ ...snap, afterNavOperationId: x2?.operationId ?? null, unmounted: true });
          }
          return JSON.stringify({ ...snap, afterNavOperationId: snap.operationId, unmounted: false });
        }
        if (Date.now() > deadline) return JSON.stringify({ none: true });
        await new Promise(res => setTimeout(res, 20));
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new Error(`submitAndCapture: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
  return JSON.parse(r?.result?.value ?? "{}");
}
async function waitForForkSettled(call, key, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sub = await H.submissions(call);
    const st = await H.execState(call);
    if (!sub.ids.some((x) => x.id === key) && st.forking !== "in_progress") return { st, sub };
    if (Date.now() > deadline) return { st, sub, timedOut: true };
    await H.sleep(500);
  }
}
async function openOpsPanel(call) {
  const expanded = await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
       return b === null ? null : b.getAttribute('aria-expanded'); })()`,
  );
  if (expanded !== "true") {
    await H.ev(
      call,
      `(() => { document.querySelector('button[aria-controls="operations-panel"]').click(); return true; })()`,
    );
    await H.sleep(900);
  }
}
async function rowActions(call, needle) {
  await openOpsPanel(call);
  const out = await H.ev(
    call,
    `(() => { const li = Array.from(document.querySelectorAll('#operations-panel li'))
        .find(x => (x.textContent||'').includes(${JSON.stringify(needle)}));
      if (li === undefined) return JSON.stringify({ found: false });
      const btns = Array.from(li.querySelectorAll('button')).map(b => (b.textContent||'').trim());
      return JSON.stringify({ found: true, btns, text: li.innerText.slice(0, 600) }); })()`,
  );
  return JSON.parse(out);
}
async function clickRowAction(call, needle, actionText) {
  await openOpsPanel(call);
  const out = await H.ev(
    call,
    `(() => { const li = Array.from(document.querySelectorAll('#operations-panel li'))
        .find(x => (x.textContent||'').includes(${JSON.stringify(needle)}));
      if (li === undefined) return JSON.stringify({ found: false });
      const b = Array.from(li.querySelectorAll('button'))
        .find(x => (x.textContent||'').trim() === ${JSON.stringify(actionText)});
      if (b === undefined) return JSON.stringify({ found: true, button: false });
      b.click(); return JSON.stringify({ found: true, button: true }); })()`,
  );
  await H.sleep(1800);
  return JSON.parse(out);
}
/** 代理捕获：启用代理 → node POST 经代理（带 key）→ 等录制 run → 刷列表；返回 {runId, spanId} */
async function captureProxyRun(call, taskText) {
  await H.apiCall(call, "proxyToggle", {
    enabled: true,
    port: H.PROXY_PORT,
    upstreamBaseUrl: H.MOCK_UPSTREAM,
  });
  await H.storeQ(call, "await s.loadProxyStatus(); return 1;");
  await H.sleep(1200);
  const before = H.traceIds();
  const resp = await fetch(`http://127.0.0.1:${H.PROXY_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-u564-captured-key" },
    body: JSON.stringify({
      model: "mock-model",
      messages: [{ role: "user", content: taskText }],
      stream: false,
    }),
  });
  if (resp.status !== 200) throw new Error(`代理捕获 POST 失败：${resp.status}`);
  await resp.json().catch(() => null);
  const deadline = Date.now() + 15000;
  let runId = null;
  for (;;) {
    const added = [...H.traceIds()].filter((x) => !before.has(x));
    if (added.length >= 1) {
      runId = added.find((x) => {
        try {
          const meta = JSON.parse(
            readFileSync(join(H.TRACES, `${x}.jsonl`), "utf8").split(/\r?\n/)[0],
          );
          return meta.source?.kind === "proxy";
        } catch {
          return false;
        }
      });
      if (runId !== undefined) break;
      runId = null;
    }
    if (Date.now() > deadline) break;
    await H.sleep(400);
  }
  if (runId === null) throw new Error("代理捕获后 15s 未见到 proxy 录制 run");
  await H.storeQ(call, "await s.loadRuns(); return 1;");
  await H.storeQ(call, "await s.loadProxyStatus(); return 1;");
  await H.sleep(600);
  const lines = readFileSync(join(H.TRACES, `${runId}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const spanId = lines.filter((l) => l.type === "span" && l.kind === "llm.call")[0].id;
  return { runId, spanId };
}
/** 打开 messages 编辑器（代理 run 的 llm span） */
async function openMessagesEditor(call, runId, spanId) {
  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "LLM", spanId);
  const entryExpr =
    "(() => { const b = Array.from(document.querySelectorAll('button'))" +
    ".filter(x => x.offsetParent !== null)" +
    ".find(x => ((x.textContent||'').trim()) === '编辑 messages 重发');" +
    "return b == null ? 'no' : (b.disabled ? 'disabled' : 'ready'); })()";
  const deadline = Date.now() + 12000;
  for (;;) {
    const st = await H.ev(call, entryExpr);
    if (st === "ready") break;
    if (Date.now() > deadline) throw new Error(`messages 入口 12s 未就绪：${st}`);
    await H.sleep(500);
  }
  await H.clickByTextChecked(call, "编辑 messages 重发", 1000);
}
/** 共用：result fork 流程（确认 + 提交捕获） */
async function forkFlow(call, { runId, spanId, text, key, duringFlight = null }) {
  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", spanId);
  await H.clickByTextChecked(call, "在此重跑（时间旅行）", 1500);
  await H.typeIntoEditableMonaco(call, text);
  await confirmEditor(call);
  return submitAndCapture(call, "确认重跑", key, { duringFlight });
}

// ---------------------------------------------------------------------------
// 各 tag
// ---------------------------------------------------------------------------

const FLOWS = {
  /** A1.3「prompt 与 messages 不冒充续跑完整世界」的 prompt 半边（不提交，零消费） */
  "prompt-confirm": async (call, mock) => {
    await H.selectRun(call, FX.normalRun);
    await H.clickTabChecked(call, "步骤");
    await H.clickSpan(call, "LLM", "s_02");
    await H.clickByTextChecked(call, "编辑 system prompt 重跑", 1200);
    await H.typeIntoEditableMonaco(call, `${MARK} prompt-confirm 披露核对`);
    const body = await H.ev(call, "(() => document.body.innerText)()");
    const phrases = disclosurePhrases("promptDisclosure").filter(
      (p) =>
        (p.length >= 12 && !p.includes("：") === false) ||
        p.includes("轨迹") ||
        p.includes("启动字段") ||
        p.includes("llm.call") ||
        p.includes("本地字段检查"),
    );
    dump.promptPhrases = phrases;
    const missing = phrases.filter((p) => !body.includes(p));
    check("prompt 披露的静态短语全部在场（短语从 lib 源码同源抽取）", missing.length === 0, {
      missing: missing.slice(0, 4),
      total: phrases.length,
    });
    await confirmEditor(call);
    check("确认可挂上（aria-pressed=true）", true, null);
    check("零模型调用（本 tag 不提交）", mock.served() === 0, mock.served());
  },

  /** A1.3 的 messages 半边（需要代理捕获；不提交，零消费） */
  "messages-confirm": async (call, mock) => {
    const cap = await captureProxyRun(call, `${MARK} messages-confirm 捕获`);
    await openMessagesEditor(call, cap.runId, cap.spanId);
    await H.sleep(600);
    const body = await H.ev(call, "(() => document.body.innerText)()");
    // 只断言**肯定分支**的静态短语（本 tag 代理运行且已捕获 key；
    // 否定分支「（代理未运行，无 upstream）」「未捕获 key：本次无法重发」归 messages-no-key 断言）
    const phrases = disclosurePhrases("messagesDisclosure").filter(
      (p) =>
        p.length >= 12 &&
        !p.startsWith("（代理未运行") &&
        !p.startsWith("未捕获 key") &&
        (p.includes("重发") ||
          p.includes("凭据") ||
          p.includes("messages") ||
          p.includes("本地") ||
          p.includes("upstream")),
    );
    dump.messagesPhrases = phrases;
    const missing = phrases.filter((p) => !body.includes(p));
    check("messages 披露的静态短语全部在场（短语从 lib 源码同源抽取）", missing.length === 0, {
      missing: missing.slice(0, 4),
      total: phrases.length,
    });
    check(
      "不冒充续跑：明说只重发这一个请求、不执行外部工具/不恢复工作区",
      body.includes("不执行外部") || body.includes("不恢复"),
      null,
    );
    check("肯定分支的凭据事实在场（使用代理会话最近捕获的 key）",
      body.includes("使用代理会话最近捕获的 key"), null);
    await confirmEditor(call);
    check("确认可挂上", true, null);
    const servedExpected = 1; // 捕获 POST 的转发恰一次
    check(
      `零额外消费（捕获转发恰 ${servedExpected} 次，本 tag 不重发）`,
      mock.served() === servedExpected,
      mock.served(),
    );
  },

  /** A4.1「单运行正常结束清理匹配修订」的 prompt 半边 */
  "prompt-cleanup": async (call, mock) => {
    const runId = FX.normalRun;
    const key = `${runId}|s_02|system_prompt`;
    const before = H.traceIds();
    await H.selectRun(call, runId);
    await H.clickTabChecked(call, "步骤");
    await H.clickSpan(call, "LLM", "s_02");
    await H.clickByTextChecked(call, "编辑 system prompt 重跑", 1200);
    const text = `${MARK} prompt-cleanup 重跑文本`;
    await H.typeIntoEditableMonaco(call, text);
    await confirmEditor(call);
    const sub = await submitAndCapture(call, "确认从头重跑", key);
    const settled = await waitForForkSettled(call, key);
    check("请求收口（prompt fork）", settled.st.forking === "idle", settled.st);
    const added = await H.newChildren(before, 30000, 1);
    check("落盘恰 1 份新 trace（子 run）", added.length === 1, added);
    const id = added[0];
    const facts = traceFacts(id);
    const fx = fixtureOf("successPlain");
    check(
      `子 run 自有终止 = ${fx.expectedEvent}/${fx.expectedReason}`,
      facts.event === fx.expectedEvent && facts.reason === fx.expectedReason,
      { event: facts.event, reason: facts.reason },
    );
    check(
      "落盘 fork.edit.value = 提交快照",
      facts.meta?.fork?.edit?.value === sub.text ?? false,
      facts.meta?.fork?.edit?.value?.slice?.(0, 40),
    );
    const reg = await recordOf(call, sub.operationId);
    check("main 登记 runIds = meta.id", reg.rec?.runIds?.[0] === id, reg.rec?.runIds);
    const entry = await waitForVerified(call, reg.epoch, sub.operationId, id);
    check("核实落地（verified）", entry?.phase === "verified", entry?.phase);
    check(
      "正常结束 ⇒ 匹配修订的 prompt 草稿清理",
      (await callDraftText(call, runId, "s_02", "system_prompt")) === null,
      null,
    );
  },

  /** A3.5「失败定位和返回草稿明确可达」——查看失败调用半边 */
  "failure-locate": async (call, mock) => {
    const runId = FX.normalRun;
    const key = `${runId}|s_03|result`;
    const before = H.traceIds();
    const text = `${MARK} failure-locate 失败子 run`;
    const sub = await forkFlow(call, { runId, spanId: "s_03", text, key });
    await waitForForkSettled(call, key, 60000);
    const added = await H.newChildren(before, 30000, 1);
    const id = added[0] ?? null;
    const childFacts = traceFacts(id);
    check(
      "子 run 以 errored/error 终止（自有失败调用在场）",
      childFacts.event === "errored" && childFacts.reason === "error",
      childFacts.event,
    );
    const reg = await recordOf(call, sub.operationId);
    await waitForVerified(call, reg.epoch, sub.operationId, id);
    const act = await clickRowAction(call, sub.operationId, "查看失败调用");
    check("「查看失败调用」按钮在位且可点", act.found === true && act.button === true, act);
    const nav = await readingState(call);
    check(
      "定位到真实自有失败调用（run + span + 步骤页签）",
      nav.selectedRunId === id && nav.selectedSpanId === childFacts.llmSpanId,
      { ...nav, expectSpan: childFacts.llmSpanId },
    );
    await H.shot(call, SHOT_DIR, `${TAG}-locate.png`);
  },

  /** A3.5——返回草稿半边 */
  "return-draft": async (call, mock) => {
    const runId = FX.normalRun;
    const key = `${runId}|s_03|result`;
    const before = H.traceIds();
    const text = `${MARK} return-draft 失败子 run`;
    const sub = await forkFlow(call, { runId, spanId: "s_03", text, key });
    await waitForForkSettled(call, key, 60000);
    const added = await H.newChildren(before, 30000, 1);
    const id = added[0] ?? null;
    const reg = await recordOf(call, sub.operationId);
    await waitForVerified(call, reg.epoch, sub.operationId, id);
    // 先借「查看失败调用」离场，再从操作面板「返回草稿」
    await clickRowAction(call, sub.operationId, "查看失败调用");
    const act = await clickRowAction(call, sub.operationId, "返回草稿");
    check("「返回草稿」按钮在位且可点", act.found === true && act.button === true, act);
    const nav = await readingState(call);
    check("返回草稿 ⇒ 回到原编辑目标（父 run 选中）", nav.selectedRunId === runId, nav);
    check(
      "草稿原文在场（未被结果清理）",
      (await callDraftText(call, runId, "s_03", "result")) === sub.text,
      null,
    );
    await H.shot(call, SHOT_DIR, `${TAG}-return.png`);
  },

  /** M1.1「编辑并重发成功」（需要代理捕获 + 重发） */
  "messages-refork": async (call, mock) => {
    const cap = await captureProxyRun(call, `${MARK} messages-refork 捕获`);
    const key = `${cap.runId}|${cap.spanId}|messages`;
    const before = H.traceIds();
    await openMessagesEditor(call, cap.runId, cap.spanId);
    await H.sleep(600);
    // 编辑 messages：原请求 messages 的最后一条 user 内容追加标记
    const orig = traceFacts(cap.runId).firstMessages;
    const edited = orig.map((m, i) =>
      i === orig.length - 1 ? { ...m, content: `${m.content}（${MARK} 编辑重发）` } : m,
    );
    await H.setEditableMonaco(call, JSON.stringify(edited, null, 2));
    await H.sleep(600);
    await confirmEditor(call);
    const sub = await submitAndCapture(call, "确认重发", key);
    const settled = await waitForForkSettled(call, key);
    check("重发请求收口", settled.st.forking === "idle", settled.st);
    const added = await H.newChildren(before, 30000, 1);
    check("落盘恰 1 份新 trace（重发子 run）", added.length === 1, added);
    const id = added[0];
    const facts = traceFacts(id);
    const fx = fixtureOf("successPlain");
    check(
      `重发子 run 自有终止 = ${fx.expectedEvent}/${fx.expectedReason}`,
      facts.event === fx.expectedEvent && facts.reason === fx.expectedReason,
      { event: facts.event, reason: facts.reason },
    );
    const lastUser = (facts.firstMessages ?? []).filter((m) => m.role === "user").pop();
    check(
      "重发请求带编辑后的 messages（编辑追加重发在场）",
      typeof lastUser?.content === "string" && lastUser.content.includes(`${MARK} 编辑重发`),
      lastUser?.content?.slice?.(0, 60),
    );
    // 捕获扑空时 sub.operationId 为 null ⇒ 按落盘子 run id 从登记表反查（6.3 教训）；
    // resultReads 的键用登记表里的 operationId（与落盘关联同源）
    let reg = await recordOf(call, sub.operationId);
    if (reg.rec === null) {
      const st = await opsStatus(call);
      const rec =
        (st?.data?.operations ?? []).find((o) => (o.runIds ?? []).includes(id)) ?? null;
      reg = { rec, slot: st?.data?.activeOperationId ?? null, epoch: st?.data?.epoch ?? null };
    }
    const opId = reg.rec?.operationId ?? sub.operationId ?? null;
    check("main 登记 runIds = 落盘 meta.id（身份三方一致）", reg.rec?.runIds?.[0] === id, {
      runIds: reg.rec?.runIds,
      id,
      opId,
    });
    const entry = await waitForVerified(call, reg.epoch, opId, id);
    check("核实落地（verified）", entry?.phase === "verified", entry?.phase);
    check(
      "正常结束 ⇒ 匹配修订的 messages 草稿清理",
      (await callDraftText(call, cap.runId, cap.spanId, "messages")) === null,
      null,
    );
    await H.shot(call, SHOT_DIR, `${TAG}-refork.png`);
  },

  /** M1.2「未修改禁用」 */
  "messages-unchanged": async (call, mock) => {
    const cap = await captureProxyRun(call, `${MARK} messages-unchanged 捕获`);
    await openMessagesEditor(call, cap.runId, cap.spanId);
    await H.sleep(600);
    const before = H.traceIds();
    const servedBefore = mock.served();
    const submit = await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .filter(x => x.offsetParent !== null)
          .find(x => ((x.textContent||'').trim()) === '确认重发');
        return b === null ? null : { disabled: b.disabled }; })()`,
    );
    check("未修改 ⇒ 提交按钮 disabled", submit?.disabled === true, submit);
    await H.sleep(1500);
    check(
      "零模型调用（捕获转发恰 1 次，未重发）",
      mock.served() - servedBefore === 0,
      mock.served(),
    );
    check("零新 trace", H.traceIds().size === before.size, H.traceIds().size);
  },

  /**
   * M1.3「未捕获 key」：代理运行但本会话零捕获 ⇒ 资格门禁在 UX 先拦（确认按钮 disabled、
   * 否定披露与就近资格原因先于提交在场——"不等提交才发现"）。main 侧稳定码 PROXY_NO_KEY
   * 由已交付单元用例承载（controlled-proxy.test.ts，evidence-index 行 3 口径）。
   * ⚠️ 必须先于任何捕获 tag 跑：keyStore.lastKey 是 main 会话级的、禁用代理不清 key
   *（proxy-manager.ts toggle 只停服务器），"未捕获"前提只在批首（新 dev 会话）成立。
   */
  "messages-no-key": async (call, mock) => {
    // 启用代理但**不**发捕获请求 ⇒ hasKey=false
    await H.apiCall(call, "proxyToggle", {
      enabled: true,
      port: H.PROXY_PORT,
      upstreamBaseUrl: H.MOCK_UPSTREAM,
    });
    await H.storeQ(call, "await s.loadProxyStatus(); return 1;");
    await H.sleep(1200);
    // storeQ 恒把返回值 JSON.parse（6.2 教训）：页内 stringify 出来的字符串到手里已是对象，
    // 外面再 parse 一次就是 "[object Object]" is not valid JSON——直接用解析后的对象。
    const proxy = await H.storeQ(
      call,
      "return JSON.stringify({ running: s.proxy?.running === true, hasKey: s.proxy?.hasKey === true });",
    );
    check("代理运行但未捕获 key", proxy?.running === true && proxy?.hasKey === false, proxy);
    // 用历史代理 run 夹具（fx.proxyRun）作为源（入口资格不依赖 key：isProxy+leafOwned+completed）
    const sourceRun = FX.proxyRun ?? null;
    if (sourceRun === null) throw new Error("manifest 缺 proxyRun 夹具");
    const lines = readFileSync(join(H.TRACES, `${sourceRun}.jsonl`), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const spanId = lines.filter((l) => l.type === "span" && l.kind === "llm.call")[0].id;
    await openMessagesEditor(call, sourceRun, spanId);
    await H.sleep(600);
    const body = await H.ev(call, "(() => document.body.innerText)()");
    // 资格门禁的 UX 形状：确认按钮 disabled（ineligible !== null ⇒ 禁用），不可挂确认
    const gate = JSON.parse(
      await H.ev(
        call,
        `(() => { const b = ${visibleConfirmExpr};
          return b === null ? JSON.stringify({ absent: true })
            : JSON.stringify({ absent: false, disabled: b.disabled,
                pressed: b.getAttribute('aria-pressed'), title: b.title ?? "" }); })()`,
      ),
    );
    check(
      "凭据缺失门禁在 UX 层先拦（确认按钮 disabled、无确认凭据可挂）",
      gate.absent === false && gate.disabled === true && gate.pressed === null,
      gate,
    );
    // 否定分支披露（判据与 lib 同源抽取）
    const neg = disclosurePhrases("messagesDisclosure").filter((p) => p.startsWith("未捕获 key"));
    const missingNeg = neg.filter((p) => !body.includes(p));
    check("否定分支披露先于提交在场（不等提交才发现）", missingNeg.length === 0, {
      missing: missingNeg.slice(0, 4),
      total: neg.length,
    });
    // 就近资格原因（判据与 DetailPanel 源码同源抽取；正文或按钮 title 任一在场即可）
    const ineligibleReason = panelLiteral("proxy?.hasKey !== true");
    check(
      "就近资格原因在场（本会话未捕获到 key ⇒ 先把应用经代理跑一次）",
      typeof ineligibleReason === "string" &&
        (body.includes(ineligibleReason) || (gate.title ?? "").includes(ineligibleReason)),
      { reason: ineligibleReason, inBody: body.includes(ineligibleReason ?? "\u0000"),
        inTitle: (gate.title ?? "").includes(ineligibleReason ?? "\u0000") },
    );
    // 编辑仍可写、门禁拦截不动草稿；全程零联网零新 trace
    const before = H.traceIds();
    const servedBefore = mock.served();
    const orig = traceFacts(sourceRun).firstMessages;
    const edited = (orig ?? []).map((m, i) =>
      i === (orig ?? []).length - 1
        ? { ...m, content: `${m.content}（${MARK} 无 key 重发尝试）` }
        : m,
    );
    await H.setEditableMonaco(call, JSON.stringify(edited, null, 2));
    await H.sleep(500);
    const draft = await callDraftText(call, sourceRun, spanId, "messages");
    check(
      "门禁拦截不动草稿（编辑仍保留）",
      typeof draft === "string" && draft.includes(`${MARK} 无 key 重发尝试`),
      typeof draft === "string" ? draft.slice(0, 40) : draft,
    );
    await H.sleep(1500);
    check("零模型调用（notConsumed 期望 0）", mock.served() - servedBefore === 0, mock.served());
    check("零新 trace", H.traceIds().size === before.size, H.traceIds().size);
  },

  /** M1.4「SDK run 无此入口」 */
  "sdk-run-no-entry": async (call, mock) => {
    // 选中态双证：normalRun 与 proxyRun 的 llm span 恰好同名 s_02，且 selectRun 点完
    // 不验证、clickSpan 只看全局 selectedSpanId ⇒ 上一 tag 的代理选中态若残留，
    // 探针看到的就是代理 run 的入口（首跑假红根因）。先确认 run 切到位再点 span。
    let sel = null;
    for (let i = 0; i < 3; i++) {
      await H.selectRun(call, FX.normalRun);
      sel = await H.storeQ(
        call,
        "return JSON.stringify({ run: s.selectedRunId, span: s.selectedSpanId });",
      );
      if (sel?.run === FX.normalRun) break;
    }
    check("选中的是 SDK 夹具 run（防跨 run 串台）", sel?.run === FX.normalRun, sel);
    await H.clickTabChecked(call, "步骤");
    await H.clickSpan(call, "LLM", "s_02");
    const sel2 = await H.storeQ(
      call,
      "return JSON.stringify({ run: s.selectedRunId, span: s.selectedSpanId });",
    );
    check(
      "span 选中落在本 run 的 s_02（与 proxyRun 同名，run+span 双证缺一不可）",
      sel2?.run === FX.normalRun && sel2?.span === "s_02",
      sel2,
    );
    // 只对**可见**按钮判 absent，并在 3s 窗口内稳定（不信瞬态 DOM）；total 仅作证据
    const probeExpr =
      `(() => { const all = Array.from(document.querySelectorAll('button'))` +
      `.filter(x => ((x.textContent||'').trim()) === '编辑 messages 重发');` +
      `return JSON.stringify({ total: all.length,` +
      ` visible: all.filter(x => x.offsetParent !== null).length }); })()`;
    let probe = { total: -1, visible: -1 };
    for (let i = 0; i < 6; i++) {
      probe = JSON.parse(await H.ev(call, probeExpr));
      if ((probe.visible ?? 0) > 0) break;
      await H.sleep(500);
    }
    check(
      "SDK/普通 run 的 llm span 无可见「编辑 messages 重发」入口（3s 稳定）",
      (probe.visible ?? 0) === 0,
      { probe, sel: sel2 },
    );
    check("零模型调用", mock.served() === 0, mock.served());
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

  let mock = null;
  for (let attempt = 0; attempt < 2 && mock === null; attempt++) {
    try {
      mock = await H.prepare(call, TAG_SCRIPT[TAG]);
    } catch (e) {
      if (attempt > 0 || !String(e).includes("Failed to fetch")) throw e;
      console.log(`[prepare] 模块加载失败，reload 后重试一次`);
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
    }
  }
  try {
    await FLOWS[TAG](call, mock);
  } catch (e) {
    check(`tag 执行异常：${String(e?.message ?? e).slice(0, 300)}`, false);
  } finally {
    try {
      await H.apiCall(call, "proxyToggle", {
        enabled: false,
        port: H.PROXY_PORT,
        upstreamBaseUrl: H.MOCK_UPSTREAM,
      });
    } catch {
      /* 尽力而为 */
    }
    await H.teardown(call, mock);
  }
  finish({ needsCapture: NEEDS_CAPTURE.includes(TAG), usesProxy: USES_PROXY.includes(TAG) });
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
