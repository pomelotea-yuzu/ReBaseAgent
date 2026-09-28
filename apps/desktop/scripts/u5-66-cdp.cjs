/* eslint-disable */
/**
 * U5 任务 6.6（第五批受控实机）：列表/结果读取失败与重试、终态解冻后新修订、通信核对和同 main 重载。
 *
 * 覆盖 evidence-index「实机入口 = 6.6」各计划 tag（沿用同名 tag，§7.3 才对得上账）：
 * reload-timing / stale-read / notice-only / limit-outcomes / unreadable-retry /
 * retry-then-cleanup / rev-after-settle / idempotent-closure / reload-return-fallback /
 * reconcile-single-unfreeze / unlocated-reconcile / reconcile-no-nav / main-restart / late-callback。
 *
 * 分层结论（6.1 坐实，别再追不存在的注入面）：
 * - 「列表刷新失败但详情可读」在 fs 层没有注入面 ⇒ 该场景只由 §1 store 用例承载（实机不成立行）；
 * - 非法 reason 的真机落点是读取失败（RunEventSchema.reason 是枚举）⇒ 由 unreadable-retry 的
 *   unknownTerminalReason 半边 + 单元层承载；
 * - aborted 桌面端不可诱发（无取消通道）⇒ 单元层；
 * - 「settled 且 runIds 为空」真机不可达（main 收尾必带 ≥1 runId）⇒ 单元层；
 * - 「旧读取响应迟到整份丢弃」无延时注入面（runs:get 无 delayMs 通道）⇒ 单元层；
 *   实机做得到的近亲 = 并发双重试只认最大代次（stale-read tag 内实测）。
 *
 * 判据口径：
 * - 期望调用数/终止事件一律从 `lib/u5-sse-fixtures.cjs` 目录读（不手写数字）；
 * - 注入一律走 `lib/u5-read-faults.cjs`（施加 → 还原 → 逐字节指纹核验）；
 * - 「收尾三连」需要"自动核实被挡下"的窗口 ⇒ 竞速注入：终态落盘的瞬间隐藏文件
 *   （收尾链 = 回执 → status → 解冻 → 列表刷新 → runs:get，节点侧 1ms 轮询稳定抢先）；
 * - 真重启走 U4 6.6 的路：u2-dev-host --stop → 等 9612 真空出 → spawn 新 host → 重连 CDP；
 *   受控服务起在 tag 进程内 ⇒ 重启不动它 ⇒ served 计数跨重启可比。
 *
 * 用法：`node apps/desktop/scripts/u5-66-cdp.cjs --tag=<TAG>`；前置 dev 由 run-all 起。
 */
"use strict";
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { fixtureOf, MAX_ITERATIONS } = require("./lib/u5-sse-fixtures.cjs");
const { beginReadFault } = require("./lib/u5-read-faults.cjs");

const TAGS = [
  "reload-timing",
  "stale-read",
  "notice-only",
  "limit-outcomes",
  "unreadable-retry",
  "retry-then-cleanup",
  "rev-after-settle",
  "idempotent-closure",
  "reload-return-fallback",
  "reconcile-single-unfreeze",
  "unlocated-reconcile",
  "reconcile-no-nav",
  "main-restart",
  "late-callback",
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

const OUT_DIR = join(H.REPO, ".workbuddy", "u5", "u5-66");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-29-u5-66");
const MARK = "U5-66";
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const PID_FILE = join(H.REPO, ".workbuddy", "u2-5-dev.pid");
const DEV_HOST = join(H.REPO, "apps", "desktop", "scripts", "u2-dev-host.cjs");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
if (!existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
const FX = JSON.parse(readFileSync(MANIFEST, "utf8"));

const OK_TURN = { content: `${MARK} 受控成功：一步答完。`, usage: { in: 120, out: 40 } };
/** registry 只收 UUID 形态的 operationId（assertOperationId / OperationUuidSchema），注入 ID 必须合法 */
let uuidSeq = 0;
const freshUuid = () => {
  uuidSeq += 1;
  return `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(9, "0")}${String(uuidSeq).padStart(3, "0")}`;
};

/** 各 tag 的受控剧本（turns 顺序消费；fallback 供重启后的新会话使用） */
const TAG_SCRIPT = {
  "reload-timing": { turns: [{ content: `${MARK} 慢响应：计时窗口。`, delayMs: 6000 }], fallback: OK_TURN },
  "stale-read": { turns: [OK_TURN, OK_TURN], fallback: OK_TURN },
  "notice-only": { turns: [{ content: `${MARK} 慢响应：重载窗口。`, delayMs: 6000 }], fallback: OK_TURN },
  "limit-outcomes": {
    turns: [fixtureOf("budgetExceeded").script.turns[0]],
    fallback: fixtureOf("maxIterations").script.fallback,
  },
  "unreadable-retry": { turns: [OK_TURN], fallback: OK_TURN },
  "retry-then-cleanup": { turns: [OK_TURN], fallback: OK_TURN },
  "rev-after-settle": { turns: [OK_TURN], fallback: OK_TURN },
  "idempotent-closure": { turns: [OK_TURN, OK_TURN], fallback: OK_TURN },
  // 纯零执行 tag：任何一次消费都会留下 418 ⇒「零模型调用」是数出来的
  "reload-return-fallback": {
    turns: [{ mode: "fail", status: 418, content: "这个 tag 不该有任何模型调用" }],
    fallback: OK_TURN,
  },
  "reconcile-single-unfreeze": {
    turns: [OK_TURN, { content: `${MARK} 慢响应：核对窗口。`, delayMs: 8000 }],
    fallback: OK_TURN,
  },
  "unlocated-reconcile": { turns: [OK_TURN], fallback: OK_TURN },
  "reconcile-no-nav": { turns: [OK_TURN], fallback: OK_TURN },
  "main-restart": {
    turns: [OK_TURN, { content: `${MARK} 被重启打断的在飞`, delayMs: 25_000 }, OK_TURN],
    fallback: OK_TURN,
  },
  "late-callback": {
    turns: [{ content: `${MARK} 被重启打断的在飞`, delayMs: 25_000 }, OK_TURN],
    fallback: OK_TURN,
  },
};

const EXPECTED_CALLS = {
  "reload-timing": 1,
  "stale-read": 2,
  "notice-only": 1,
  "limit-outcomes": 1 + MAX_ITERATIONS,
  "unreadable-retry": 1,
  "retry-then-cleanup": 1,
  "rev-after-settle": 1,
  "idempotent-closure": 2,
  "reload-return-fallback": 0,
  "reconcile-single-unfreeze": 2,
  "unlocated-reconcile": 1,
  "reconcile-no-nav": 1,
  "main-restart": 3,
  "late-callback": 2,
};

// ---------------------------------------------------------------------------
// 检查与落盘
// ---------------------------------------------------------------------------

const checks = [];
const dump = {};
/** 当前 CDP 会话持有者：重启类 tag 换会话后 teardown 用它拿最新的（旧 ws 已关闭 ⇒ 无界 await 会挂死） */
const SESSION = { call: null };
function check(name, ok, detail) {
  checks.push({ tag: TAG, name, ok: ok === true, detail: detail ?? null });
  const shown =
    detail === undefined || detail === null
      ? ""
      : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : shown}`);
}
function sha12(file) {
  try {
    return require("node:crypto").createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}
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
function finish(extraMeta = {}) {
  const failed = checks.filter((c) => !c.ok);
  const meta = {
    head: headShort(),
    electron: electronVersion(),
    node: process.version,
    scriptSha: {
      "u5-sse-fixtures.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u5-sse-fixtures.cjs")),
      "u5-read-faults.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u5-read-faults.cjs")),
      "mock-llm-server.cjs": sha12(join(H.REPO, "apps/desktop/scripts/mock-llm-server.cjs")),
      "u4-smoke-harness.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u4-smoke-harness.cjs")),
    },
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

// ---------------------------------------------------------------------------
// 读数（真 store / 真 IPC / 真落盘）
// ---------------------------------------------------------------------------

const opsStatus = (call) => H.apiCall(call, "operationsStatus");
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  const rec = (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null;
  return { rec, slot: st?.data?.activeOperationId ?? null, epoch: st?.data?.epoch ?? null };
};
const createSession = (call) =>
  H.storeQ(
    call,
    `const d = s.createRunDraftOf();
     return JSON.stringify({
       view: s.view,
       selectedRunId: s.selectedRunId,
       draft: d === null ? null : { mode: d.mode, systemPrompt: d.systemPrompt,
                                   userMessage: d.userMessage, revision: d.revision },
       sourceRef: s.createSourceRef === null ? null : { name: s.createSourceRef.name },
       returnLocation: s.createReturnLocation === null ? null : { view: s.createReturnLocation.view },
       frozen: s.isDraftFrozen({ field: "create" }),
       creating: s.creatingRun,
       createRunError: s.createRunError,
     });`,
  );
const createSubmission = (call) =>
  H.storeQ(
    call,
    `const x = s.draftSubmissions.byId["|create"];
     return JSON.stringify(x === undefined ? null : {
       token: x.token, operationId: x.operationId, epoch: x.epoch,
       revision: x.submittedRevision, submittedAt: x.submittedAt ?? null });`,
  );
const sessionSnapshot = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       epoch: s.operations.epoch, unknown: s.operations.unknown,
       registryVersion: s.operations.registryVersion,
       opsCount: s.operations.operations.length,
       opIds: s.operations.operations.map(o => o.operationId),
       pendingCount: s.operations.pending.length,
       pending: s.operations.pending.map(p => ({ epoch: p.epoch, operationId: p.operationId })),
       readKeys: Object.keys(s.resultReads.byKey).sort(),
       closures: Object.keys(s.draftSubmissions.closures).sort(),
       pendingSubs: Object.keys(s.draftSubmissions.byId).sort(),
     });`,
  );
const resultReadFor = async (call, epoch, operationId, runId) => {
  const key = `${epoch}|${operationId}|${runId}`;
  const all = await H.storeQ(call, "return JSON.stringify(s.resultReads.byKey);");
  return all[key] ?? null;
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
/** 显式只读重试（store 真动作；返回条目摘要含 facts 摘要） */
const retryRead = (call, x) =>
  H.storeQ(
    call,
    `const e = await s.retryResultRead({ epoch: ${JSON.stringify(x.epoch)}, operationId: ${JSON.stringify(x.operationId)}, runId: ${JSON.stringify(x.runId)} });
     return JSON.stringify({ phase: e.phase, attempt: e.attempt, reason: e.reason,
       facts: e.facts === null ? null : { normalEnd: e.facts.normalEnd,
         event: e.facts.event === null ? null : e.facts.event.event,
         reason: e.facts.reason, label: e.facts.outcome.label } });`,
  );
const reverify = (call, x) =>
  H.storeQ(
    call,
    `const e = await s.verifyRunResult({ epoch: ${JSON.stringify(x.epoch)}, operationId: ${JSON.stringify(x.operationId)}, runId: ${JSON.stringify(x.runId)} });
     return JSON.stringify({ phase: e.phase, attempt: e.attempt });`,
  );
/** 等登记记录进入指定状态（轮询 main registry —— 在飞期 renderer 会话不持有 running 记录，只有 main 有） */
async function waitRegistryRecordState(call, operationId, want, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const { rec } = await recordOf(call, operationId);
    last = rec;
    if (rec !== null && rec.state === want) return rec;
    if (Date.now() > deadline) return rec;
    await H.sleep(300);
  }
}
/** 等门禁开放（返回最后一次门禁读数） */
async function waitGateOpen(call, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await H.storeQ(
      call,
      `const op = s.operations;
       return JSON.stringify({ gate: op.epoch === null ? "not_handshaked"
         : op.unknown ? "communication_unknown" : op.closing ? "closing"
         : op.configurationBusy ? "configuration_busy"
         : (op.activeOperationId !== null || op.pending.some(p => p.epoch === op.epoch)) ? "operation_running" : null });`,
    );
    if (st.gate === null) return st;
    if (Date.now() > deadline) return st;
    await H.sleep(300);
  }
}
/** 落盘 trace 的自有终止事实（最后一行 run.event） */
function traceFacts(id) {
  const lines = readFileSync(join(H.TRACES, `${id}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const llms = lines.filter((l) => l.type === "span" && l.kind === "llm.call");
  const last = lines[lines.length - 1];
  return {
    meta: lines[0],
    llmCalls: llms.length,
    firstLlmError: llms.length > 0 ? (llms[0].error ?? null) : null,
    event: last?.type === "run.event" ? last.event : null,
    reason: last?.type === "run.event" ? last.reason : null,
  };
}
const liveText = (call) =>
  H.ev(
    call,
    `(() => { const el = document.getElementById('result-live');
      return el === null ? null : (el.textContent || '').trim(); })()`,
  );

// ---------------------------------------------------------------------------
// 页内动作
// ---------------------------------------------------------------------------

async function openCreate(call) {
  const ok = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '新建运行');
      if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked") throw new Error(`全局栏找不到「新建运行」按钮：${ok}`);
  await H.sleep(900);
  const st = await createSession(call);
  if (st.view !== "create") throw new Error(`点「新建运行」后 view=${st.view}，不在创建工作区`);
  return st;
}
async function fillUserMessage(call, text) {
  const r = await H.typeIntoDom(call, "#create-user-message", text);
  if (typeof r?.value !== "string" || !r.value.includes(text))
    throw new Error(`任务输入失败：${JSON.stringify(r).slice(0, 200)}`);
}
const confirmBtnExpr = `document.querySelector('section[aria-label="新建运行"] [data-confirm-execution]')`;
async function confirmSubmission(call) {
  const before = await H.ev(
    call,
    `(() => { const b = ${confirmBtnExpr};
      if (!b) return JSON.stringify({ error: 'no-confirm-button' });
      return JSON.stringify({ disabled: b.disabled, pressed: b.getAttribute('aria-pressed') }); })()`,
  );
  const parsed = JSON.parse(before);
  if (parsed.error) throw new Error(`确认按钮缺失：${parsed.error}`);
  if (parsed.disabled !== false) throw new Error(`确认按钮不可点：${JSON.stringify(parsed)}`);
  await H.ev(call, `(() => { ${confirmBtnExpr}.click(); return true; })()`);
  await H.sleep(600);
  const after = await H.ev(
    call,
    `(() => { const b = ${confirmBtnExpr};
      return b === null ? null : { pressed: b.getAttribute('aria-pressed') }; })()`,
  );
  if (after?.pressed !== "true") throw new Error(`点确认后 aria-pressed=${after?.pressed}`);
}
/** 点提交按钮并在页内同帧捕获待定关联（毫秒级响应会扑空） */
async function submitCreateAndCapture(call) {
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '创建');
      if (!btn) return JSON.stringify({ error: 'button-not-found' });
      if (btn.disabled) return JSON.stringify({ error: 'button-disabled' });
      btn.click();
      const deadline = Date.now() + 4000;
      for (;;) {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        if (!url) { await new Promise(res => setTimeout(res, 30)); continue; }
        const m = await import(url);
        const x = m.useAppStore.getState().draftSubmissions.byId['|create'];
        if (x !== undefined) return JSON.stringify({ operationId: x.operationId, token: x.token,
          epoch: x.epoch, revision: x.submittedRevision, submittedAt: x.submittedAt ?? null });
        if (Date.now() > deadline) return JSON.stringify({ none: true });
        await new Promise(res => setTimeout(res, 20));
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new Error(`submit capture eval: ${JSON.stringify(r.exceptionDetails).slice(0, 240)}`);
  const parsed = JSON.parse(r?.result?.value ?? "{}");
  if (parsed.error) throw new Error(`提交按钮不可用：${parsed.error}`);
  return parsed;
}
async function waitForCreateSettled(call, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sub = await createSubmission(call);
    const st = await createSession(call);
    if (sub === null && st.creating !== "in_progress") return true;
    if (Date.now() > deadline) return false;
    await H.sleep(500);
  }
}
/** 通用受控创建：打开 → 填任务 → 确认 → 提交 → 等收口 → 读自动核实条目 */
async function runCreate(call, mock, task) {
  const servedBefore = mock.served();
  await openCreate(call);
  await fillUserMessage(call, task);
  await confirmSubmission(call);
  const sub = await submitCreateAndCapture(call);
  if (typeof sub.operationId !== "string") throw new Error(`创建未登记：${JSON.stringify(sub)}`);
  const settled = await waitForCreateSettled(call);
  if (!settled) throw new Error(`创建未收口：${task}`);
  const { rec, epoch } = await recordOf(call, sub.operationId);
  if (rec?.state !== "settled") throw new Error(`登记未收口：${JSON.stringify(rec)}`);
  const runId = rec.runIds[0] ?? null;
  if (runId === null) throw new Error("settled 无 runId");
  const entry = await waitForVerified(call, epoch, sub.operationId, runId);
  if (mock.served() - servedBefore !== 1) throw new Error(`创建调用数异常：${mock.served()}`);
  return { operationId: sub.operationId, sub, epoch, runId, entry, rec };
}
async function openOperationsPanel(call) {
  const ok = await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
      if (!b) return 'no-button';
      if (b.getAttribute('aria-expanded') === 'true') return 'already';
      b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked" && ok !== "already") throw new Error(`操作入口不可用：${ok}`);
  await H.sleep(800);
  const open = await H.ev(call, `(() => document.getElementById('operations-panel') !== null)()`);
  if (open !== true) throw new Error("操作面板未打开");
}
async function closeOperationsPanel(call) {
  await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-label="关闭操作列表"]');
      if (b) b.click(); return true; })()`,
  );
  await H.sleep(600);
}
/** 操作面板行定位（行根 = className 含 mt-1 的 li）与行内动作 */
const ROW_EXPR = (opId) => `(() => {
  const panel = document.getElementById('operations-panel');
  if (panel === null) return JSON.stringify({ error: 'no-panel' });
  const lis = Array.from(panel.querySelectorAll('li')).filter(li => (li.className || '').includes('mt-1'));
  const row = lis.find(li => (li.textContent || '').includes(${JSON.stringify(opId)}));
  if (!row) return JSON.stringify({ error: 'no-row', rows: lis.length });
  return JSON.stringify({ text: (row.textContent || '').slice(0, 800),
    waits: Array.from(row.querySelectorAll('[data-wait-basis]')).map(w => w.getAttribute('data-wait-basis')) });
})()`;
async function rowRead(call, opId) {
  const raw = await H.ev(call, ROW_EXPR(opId));
  const p = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (p.error) throw new Error(`行读数失败（${opId.slice(0, 8)}）：${JSON.stringify(p)}`);
  return { text: p.text, basis: (p.waits ?? [])[0] ?? null };
}
async function rowActions(call, opId) {
  const raw = await H.ev(
    call,
    `(() => {
      const panel = document.getElementById('operations-panel');
      if (panel === null) return JSON.stringify({ error: 'no-panel' });
      const lis = Array.from(panel.querySelectorAll('li')).filter(li => (li.className || '').includes('mt-1'));
      const row = lis.find(li => (li.textContent || '').includes(${JSON.stringify(opId)}));
      if (!row) return JSON.stringify({ error: 'no-row' });
      return JSON.stringify(Array.from(row.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null)
        .map(b => ((b.textContent || '').trim()))
        .filter(Boolean));
    })()`,
  );
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}
async function clickRowAction(call, opId, label, wait = 1200) {
  const r = await H.ev(
    call,
    `(() => {
      const panel = document.getElementById('operations-panel');
      if (panel === null) return 'no-panel';
      const lis = Array.from(panel.querySelectorAll('li')).filter(li => (li.className || '').includes('mt-1'));
      const row = lis.find(li => (li.textContent || '').includes(${JSON.stringify(opId)}));
      if (!row) return 'no-row';
      const btn = Array.from(row.querySelectorAll('button'))
        .find(b => ((b.textContent || '').trim()).includes(${JSON.stringify(label)}) && b.offsetParent !== null);
      if (!btn) return 'no-button';
      if (btn.disabled) return 'disabled';
      btn.click(); return 'clicked';
    })()`,
  );
  if (r !== "clicked") throw new Error(`行内点「${label}」失败（${opId.slice(0, 8)}）：${r}`);
  await H.sleep(wait);
}
/** 放弃创建草稿（真模态确认） */
async function discardCreateDraft(call) {
  await openCreate(call);
  await H.clickByTextChecked(call, "放弃填写内容", 800);
  await H.clickInOpenDialog(call, "确认放弃", 1200);
}

// ---------------------------------------------------------------------------
// 重载 / 重启 / 竞速注入
// ---------------------------------------------------------------------------

/** 带「换文档自证」的重载（U4 6.6 纪律：reload 不换文档 ⇒ 一切"重载后"判据凭空成立） */
async function reloadWithGuard(call, { waitRuns = true } = {}) {
  await H.ev(call, `(() => { window.__u566Doc = (window.__u566Doc ?? 0) + 1; return true; })()`);
  await call("Page.reload", { ignoreCache: true });
  let swapped = false;
  for (let i = 0; i < 80; i++) {
    await H.sleep(400);
    try {
      const doc = await H.ev(call, "(() => window.__u566Doc ?? null)()");
      if (doc === null) {
        swapped = true;
        break;
      }
    } catch {
      /* 导航中求值失败：换文档的表现之一 */
      swapped = true;
      break;
    }
  }
  if (!swapped) throw new Error("Page.reload 未换文档（__u566Doc 仍在）——重载判据会全部假绿");
  if (!waitRuns) return;
  for (let i = 0; i < 60; i++) {
    await H.sleep(500);
    try {
      if ((await H.runs(call)).length > 0) {
        await H.sleep(800);
        return;
      }
    } catch {
      /* 重载瞬间 */
    }
  }
  throw new Error("重载后 30s 运行列表仍未就绪");
}

function probePort(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const { createConnection } = require("node:net");
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
  });
}
async function cdpHttpUp(tries) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${H.CDP_PORT}/json/version`);
      if (r.ok) return i;
    } catch {
      /* 还没起 */
    }
    await H.sleep(1000);
  }
  return null;
}
/** 首帧门禁采样器：每次新文档从 document-start 起 2ms 轮询 store，记录门禁状态迁移 */
const GATE_POLLER = `
  window.__u566GateLog = [];
  const __u566timer = setInterval(() => {
    (async () => {
      try {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        if (!url) return;
        const m = await import(url);
        const s = m.useAppStore.getState();
        const op = s.operations;
        const blocked = op.epoch === null ? 'not_handshaked'
          : op.unknown ? 'communication_unknown' : op.closing ? 'closing'
          : op.configurationBusy ? 'configuration_busy'
          : (op.activeOperationId !== null || op.pending.some(p => p.epoch === op.epoch)) ? 'operation_running' : null;
        const log = window.__u566GateLog;
        const sig = JSON.stringify([op.epoch === null, op.epoch, blocked]);
        const last = log[log.length - 1];
        if (!last || last.sig !== sig) {
          log.push({ t: Math.round(performance.now()), epochNull: op.epoch === null, epoch: op.epoch, blocked, sig });
        }
      } catch { /* store 未就绪 */ }
    })();
  }, 2);
  setTimeout(() => clearInterval(__u566timer), 30000);
`;
async function installGatePoller(call) {
  await call("Page.addScriptToEvaluateOnNewDocument", { source: GATE_POLLER });
}
/**
 * 真停真起（U4 6.6 的路）：杀 pid 文件进程树 → 等 9612 真空出 → spawn 新 host → 重连。返回新 call。
 * ⚠️ 不走 u2-dev-host --stop：那条链的内层 spawnSync(taskkill) 在本批环境必 EBUSY 静默失败
 * （看起来像"停了"实则没杀）⇒ 在 tag 进程内用**异步 spawn** 直发 taskkill（异步 spawn 全链可用）。
 */
async function restartMain(call, why) {
  const rec = { why, pidBefore: null, killOut: "", freedAfter: null, upAfter: null, reconnect: false };
  if (H.existsSync(PID_FILE)) {
    rec.pidBefore = H.readFileSync(PID_FILE, "utf8").trim();
    const { spawn } = require("node:child_process");
    rec.killOut = await new Promise((resolve) => {
      const k = spawn("taskkill", ["/PID", rec.pidBefore, "/T", "/F"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      k.stdout.on("data", (d) => {
        out += String(d);
      });
      k.stderr.on("data", (d) => {
        out += String(d);
      });
      k.on("close", (code) => resolve(`exit=${code} ${out.trim()}`.slice(0, 200)));
      k.on("error", (e) => resolve(`spawn-error ${String(e)}`.slice(0, 200)));
    });
    try {
      H.fs.rmSync(PID_FILE, { force: true });
    } catch {
      /* 尽力而为 */
    }
  }
  try {
    call.ws.close();
  } catch {
    /* 旧会话本就悬空 */
  }
  SESSION.call = null; // 旧 ws 已关：中途崩溃时 teardown 不得再走它（有界化兜底在 main finally）
  rec.killOut = rec.killOut || "(no pid file)";
  for (let i = 1; i <= 40; i++) {
    if (!(await probePort(H.CDP_PORT))) {
      rec.freedAfter = i;
      break;
    }
    await H.sleep(500);
  }
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, [DEV_HOST], {
    cwd: join(H.REPO, "apps", "desktop"),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
  rec.upAfter = await cdpHttpUp(90);
  const page = await H.cdpConnect(H.CDP_PORT);
  if (page?.webSocketDebuggerUrl !== undefined) {
    call = await H.makeDialogSession(page.webSocketDebuggerUrl);
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Page.bringToFront").catch(() => {});
    await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
    rec.reconnect = true;
    SESSION.call = call;
  }
  dump.restarts = dump.restarts ?? [];
  dump.restarts.push(rec);
  console.log(
    `[真重启:${why}] kill=${rec.killOut} 空出=${rec.freedAfter} 起来=${rec.upAfter} 重连=${rec.reconnect}`,
  );
  return { rec, call };
}
/**
 * 竞速注入：盯 traces 目录，新 run 文件的末行一变成终止事件就立刻施加 fileMissing。
 * 抢在"回执 → status → 解冻 → 列表刷新 → runs:get"收尾链前面，让自动核实吃一次读取失败。
 * ⚠️ 基线集合必须在**提交前**采样（run 文件在执行开始就创建，事后采样会把目标当旧文件漏掉）
 * ⇒ 用 startSettleWatcher() 先起观察、submit 后再 await .done()。
 */
function startSettleWatcher(timeoutMs = 120000) {
  const before = new Set(H.fs.readdirSync(H.TRACES).filter((n) => n.endsWith(".jsonl")));
  const promise = new Promise((resolve) => {
    let settled = false;
    const watcher = { close: null, stop: null };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      watcher.close?.();
      watcher.stop?.();
      resolve(value);
    };
    const tryName = (name) => {
      if (settled || !name || !name.endsWith(".jsonl") || before.has(name)) return;
      const full = H.join(H.TRACES, name);
      let last = null;
      try {
        const lines = H.readFileSync(full, "utf8")
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0);
        last = JSON.parse(lines[lines.length - 1]);
      } catch {
        last = null;
      }
      if (last !== null && last.type === "run.event" && typeof last.event === "string") {
        const runId = name.slice(0, -6);
        finish({ runId, handle: beginReadFault({ tracesDir: H.TRACES, runId }, "fileMissing") });
      }
    };
    // 事件驱动为主（fs.watch 毫秒级），1ms 忙轮询兜底（watch 漏事件的场合）
    const w = H.fs.watch(H.TRACES, (event, filename) => tryName(String(filename ?? "")));
    watcher.close = () => {
      try {
        w.close();
      } catch {
        /* 已关 */
      }
    };
    const timer = setInterval(() => {
      const names = H.fs.readdirSync(H.TRACES).filter((n) => n.endsWith(".jsonl") && !before.has(n));
      for (const name of names) tryName(name);
    }, 1);
    watcher.stop = () => clearInterval(timer);
    setTimeout(() => finish(null), timeoutMs);
  });
  return { done: () => promise };
}
async function waitServedAtLeast(mock, target, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (mock.served() >= target) return true;
    if (Date.now() > deadline) return false;
    await H.sleep(200);
  }
}

// ---------------------------------------------------------------------------
// 各 tag
// ---------------------------------------------------------------------------

const FLOWS = {
  /** 「终态和重载后的计时不伪造」（evidence-index 行 131）：在飞=自提交起 → 终态定格（main startedAt 口径）→ 重载不伪造 */
  "reload-timing": async (call, mock) => {
    const servedBefore = mock.served();
    await openCreate(call);
    const task = `${MARK} reload-timing 受控任务`;
    await fillUserMessage(call, task);
    await confirmSubmission(call);
    const sub = await submitCreateAndCapture(call);
    check("提交登记在场（operationId/epoch/revision）", typeof sub.operationId === "string" && typeof sub.epoch === "string", sub);
    const pendingSnap = await H.storeQ(
      call,
      `const p = s.operations.pending.find(x => x.operationId === ${JSON.stringify(sub.operationId)}) ?? null;
       return JSON.stringify(p);`,
    );
    check(
      "提交时待定身份带有限本地提交时刻（submittedAt 只活在会话 pending）",
      pendingSnap !== null && Number.isFinite(pendingSnap.submittedAt),
      pendingSnap,
    );
    const rec0 = await (async () => {
      for (let i = 0; i < 25; i++) {
        const r = (await recordOf(call, sub.operationId)).rec;
        if (r !== null) return r;
        await H.sleep(200);
      }
      return null;
    })();
    check(
      "IPC 信封的登记记录不含 submittedAt（本地时间事实不出门）",
      rec0 !== null && !JSON.stringify(rec0).includes("submittedAt"),
      rec0 === null ? "登记 5s 内未可见" : Object.keys(rec0),
    );
    await openOperationsPanel(call);
    const t1 = await rowRead(call, sub.operationId);
    check("运行中计时口径 = 自提交起（data-wait-basis=submitted）", t1.basis === "submitted" && t1.text.includes("自提交起已等待"), t1);
    check("运行中文本写明等待时长语义、无「计时已停止」", t1.text.includes("等待时长") && !t1.text.includes("计时已停止"), t1.text.slice(0, 120));
    const settled = await waitForCreateSettled(call);
    check("慢响应收口（约 6s 真窗口）", settled === true, settled);
    const t2 = await rowRead(call, sub.operationId);
    check("收口后计时定格（计时已停止）", t2.text.includes("计时已停止"), t2);
    check(
      "收口后口径 = 自接受起（终态行刻意按 main startedAt 定格：pending 已清账，submittedAt 不再可用）",
      t2.basis === "accepted" && !t2.text.includes("自提交起"),
      t2,
    );
    const tA = await rowRead(call, sub.operationId);
    await H.sleep(2200);
    const tB = await rowRead(call, sub.operationId);
    check("终态后 2.2s 文本逐字不变（不增长）", tA.text === tB.text, { a: tA.text.slice(0, 90), b: tB.text.slice(0, 90) });
    const rec = (await recordOf(call, sub.operationId)).rec;
    check("登记收口带 main 的 settledAt（时间事实来自 main）", rec?.state === "settled" && typeof rec?.settledAt === "string", rec?.state ?? null);
    await reloadWithGuard(call);
    await openOperationsPanel(call);
    const a1 = await rowRead(call, sub.operationId);
    check("重载后口径仍「自接受起」（不把接受冒充提交，也不凭空换算出提交时刻）", a1.basis === "accepted" && !a1.text.includes("自提交起"), a1);
    check("重载后仍定格（计时已停止）", a1.text.includes("计时已停止"), a1.text.slice(0, 120));
    await H.sleep(2200);
    const a2 = await rowRead(call, sub.operationId);
    check("重载后终态文本仍定格", a1.text === a2.text, null);
    check("恰一次模型调用", mock.served() - servedBefore === 1, mock.served());
    await H.shot(call, SHOT_DIR, `${TAG}-accepted-basis.png`);
  },

  /** 「旧读取响应不能污染其他结果」（行 147）：核实去重 + 显式重试代次递增 + 身份隔离（并发代次归单元层） */
  "stale-read": async (call, mock) => {
    const servedBefore = mock.served();
    const a = await runCreate(call, mock, `${MARK} stale-read 甲`);
    const b = await runCreate(call, mock, `${MARK} stale-read 乙`);
    check("甲：自动核实 verified 且 attempt=1", a.entry.phase === "verified" && a.entry.attempt === 1, a.entry);
    const again = await reverify(call, a);
    check("对已核实的身份重复核实不发第二次读取（attempt 仍 1）", again.phase === "verified" && again.attempt === 1, again);
    const r1 = await retryRead(call, a);
    check("显式只读重试 attempt=2（绕过去重）", r1.phase === "verified" && r1.attempt === 2, r1);
    const r2 = await retryRead(call, a);
    check("连续第二次重试 attempt=3", r2.phase === "verified" && r2.attempt === 3, r2);
    const fin = await resultReadFor(call, a.epoch, a.operationId, a.runId);
    check("最终条目认最大代次（attempt=3、verified）", fin?.attempt === 3 && fin?.phase === "verified", fin);
    const bNow = await resultReadFor(call, b.epoch, b.operationId, b.runId);
    check("乙的读取项与甲的重试互不影响（attempt 仍 1）", bNow?.attempt === 1, bNow);
    check("恰两次模型调用（两次创建）", mock.served() - servedBefore === 2, mock.served());
    dump.layerNote =
      "「旧读取响应迟到整份丢弃」的迟到窗需要 runs:get 可延时——真机无此注入面 ⇒ 按 result-verification-store 单测承载；并发双 retry 的代次交错语义同样归单元层（实机读取毫秒级落地，交错窗不可靠）";
    await H.shot(call, SHOT_DIR, `${TAG}-stale-read.png`);
  },

  /** 「恢复核对重试与批次结果只通知」（行 169）：重载恢复语义 + 重试不导航 + 通知区恒渲染 */
  "notice-only": async (call, mock) => {
    const servedBefore = mock.served();
    await openCreate(call);
    const task = `${MARK} notice-only 受控任务`;
    await fillUserMessage(call, task);
    await confirmSubmission(call);
    const sub = await submitCreateAndCapture(call);
    await reloadWithGuard(call);
    const sess0 = await sessionSnapshot(call);
    check("重载后在飞身份为空（pending 不跨重载）", sess0.pendingCount === 0, sess0.pendingCount);
    const settled = await waitRegistryRecordState(call, sub.operationId, "settled", 60000);
    check("重载后恢复轮询接管：登记收口", settled?.state === "settled", settled?.state ?? null);
    const entry = await waitForVerified(call, settled.epoch, sub.operationId, settled.runIds[0]);
    check("重载后读取结果自动核实（重载后快照终态全算新）", entry.phase === "verified", entry);
    const live1 = await liveText(call);
    check(
      "通知区在场且含成功结局播报（独立于操作面板）",
      typeof live1 === "string" && live1.includes("已有结果"),
      typeof live1 === "string" ? live1.slice(0, 120) : live1,
    );
    check("通知文本不含等待计时字样（计时进通知 = 每秒重复通知）", !live1.includes("已等待") && !live1.includes("计时已停止"), null);
    await H.sleep(1500);
    const live2 = await liveText(call);
    check("1.5s 后通知文本逐字相同（重复快照不重复播报）", live1 === live2, null);
    const before = await H.storeQ(
      call,
      "return JSON.stringify({ sel: s.selectedRunId, gen: s.navGeneration, view: s.view });",
    );
    await retryRead(call, { epoch: settled.epoch, operationId: sub.operationId, runId: settled.runIds[0] });
    const after = await H.storeQ(
      call,
      "return JSON.stringify({ sel: s.selectedRunId, gen: s.navGeneration, view: s.view });",
    );
    check("手动只读重试不导航（选择/代次/视图都不动）", before.sel === after.sel && before.gen === after.gen && before.view === after.view, { before, after });
    check("恰一次模型调用", mock.served() - servedBefore === 1, mock.served());
  },

  /** 「封存限制中止和未知不等于正常结束」（行 142）：budget_exceeded / max_iterations / crashed / 非法 reason 落读取失败 */
  "limit-outcomes": async (call, mock) => {
    const servedBefore = mock.served();
    const budgetFx = fixtureOf("budgetExceeded");
    const maxFx = fixtureOf("maxIterations");
    await openCreate(call);
    const taskA = `${MARK} limit-budget 任务`;
    await fillUserMessage(call, taskA);
    await confirmSubmission(call);
    const subA = await submitCreateAndCapture(call);
    const recA = await waitRegistryRecordState(call, subA.operationId, "settled", 30000);
    check("甲（预算超限）登记收口", recA?.state === "settled", recA?.state ?? null);
    const runA = recA.runIds[0];
    const factsA = traceFacts(runA);
    check(
      "甲自有终止 = stopped/budget_exceeded（期望与目录同源）",
      factsA.event === budgetFx.expectedEvent && factsA.reason === budgetFx.expectedReason,
      { event: factsA.event, reason: factsA.reason },
    );
    const entryA = await waitForVerified(call, recA.epoch, subA.operationId, runA);
    check("甲读取项 facts.normalEnd=false（限制中止不算正常结束）", entryA.phase === "verified" && entryA.facts?.normalEnd === false, entryA.facts);
    const sessA = await createSession(call);
    check("甲结算后创建草稿仍在（限制中止 ⇒ 不清理）", sessA.draft !== null && sessA.draft.userMessage === taskA, sessA.draft?.userMessage ?? null);
    // 乙：迭代上限
    await openCreate(call);
    const taskB = `${MARK} limit-maxiter 任务`;
    await fillUserMessage(call, taskB);
    await confirmSubmission(call);
    const subB = await submitCreateAndCapture(call);
    const recB = await waitRegistryRecordState(call, subB.operationId, "settled", 90000);
    check("乙（迭代上限）登记收口", recB?.state === "settled", recB?.state ?? null);
    const runB = recB.runIds[0];
    const factsB = traceFacts(runB);
    check("乙自有终止 = stopped/max_iterations", factsB.event === "stopped" && factsB.reason === "max_iterations", { event: factsB.event, reason: factsB.reason });
    check(`乙恰 ${MAX_ITERATIONS} 次 llm 调用（fallback 每轮回 tool_calls）`, factsB.llmCalls === maxFx.expectedCalls, factsB.llmCalls);
    const entryB = await waitForVerified(call, recB.epoch, subB.operationId, runB);
    check("乙读取项 facts.normalEnd=false", entryB.phase === "verified" && entryB.facts?.normalEnd === false, entryB.facts);
    const sessB = await createSession(call);
    check("乙结算后草稿是乙的文本（乙也不清）", sessB.draft !== null && sessB.draft.userMessage === taskB, sessB.draft?.userMessage ?? null);
    // 丙：摘掉甲的末行 run.event ⇒ 读得出来但 crashed（真机唯一合法的"非正常已封存"）
    const handle = beginReadFault({ tracesDir: H.TRACES, runId: runA }, "noTerminalEvent");
    const crashed = await retryRead(call, { epoch: recA.epoch, operationId: subA.operationId, runId: runA });
    check(
      "摘掉终止事件 ⇒ 重读成功但 event=null、normalEnd=false（运行中断，不猜结局）",
      crashed.phase === "verified" && crashed.facts?.event === null && crashed.facts?.normalEnd === false,
      crashed.facts,
    );
    const endC = handle.end();
    check("noTerminalEvent 注入逐字节还原", endC.clean === true, endC.diff);
    // 丁：非法 reason ⇒ 读取失败（RunEventSchema.reason 是枚举，不为显示未知而放宽）
    const handle2 = beginReadFault({ tracesDir: H.TRACES, runId: runB }, "unknownTerminalReason");
    const bad = await retryRead(call, { epoch: recB.epoch, operationId: subB.operationId, runId: runB });
    check(
      "非法终止原因 ⇒ 判不可读（main 侧 GET_RUN_FAILED / renderer 侧 schema，都不为显示未知而放宽）",
      bad.phase === "unreadable" && typeof bad.reason === "string" && bad.reason.length > 0,
      bad,
    );
    const endD = handle2.end();
    check("unknownTerminalReason 注入逐字节还原", endD.clean === true, endD.diff);
    check(
      "恰 11 次模型调用（1 预算 + 10 上限）",
      mock.served() - servedBefore === 1 + maxFx.expectedCalls,
      mock.served(),
    );
    dump.layerNote =
      "aborted 桌面端不可诱发（无取消通道）；「未识别 reason 的显示」不存在（落读取失败）⇒ 那两半边按单元层承载";
  },

  /** 「结果不可读只重试同一记录」（行 145）：三种注入各一轮，重读按钮只给同一条可信 runId */
  "unreadable-retry": async (call, mock) => {
    const servedBefore = mock.served();
    const a = await runCreate(call, mock, `${MARK} unreadable 任务`);
    const tracesBefore = H.traceIds().size;
    check("基线：自动核实 verified attempt=1", a.entry.phase === "verified" && a.entry.attempt === 1, a.entry);
    const rounds = ["fileMissing", "corruptTail", "unsupportedVersion"];
    let attempt = 1;
    for (const [index, kind] of rounds.entries()) {
      const handle = beginReadFault({ tracesDir: H.TRACES, runId: a.runId }, kind);
      const bad = await retryRead(call, a);
      dump[`${kind}-bad`] = bad;
      attempt += 1;
      check(
        `${kind}：显式重读判不可读（attempt=${attempt}，带诚实说明）`,
        bad.phase === "unreadable" && bad.attempt === attempt && typeof bad.reason === "string" && bad.reason.length > 0,
        bad,
      );
      const live = await liveText(call);
      if (index === 0) {
        check(
          `${kind}：面板关闭时通知区出现「结果不可读」（首次播报）`,
          typeof live === "string" && live.includes("结果不可读"),
          typeof live === "string" ? live.slice(0, 100) : live,
        );
      } else {
        check(
          `${kind}：同一身份的不可读通知已看过 ⇒ 不重复播报（两层去重）`,
          typeof live === "string" && !live.includes("结果不可读"),
          typeof live === "string" ? live.slice(0, 100) : live,
        );
      }
      await openOperationsPanel(call);
      const row = await rowRead(call, a.operationId);
      check(`${kind}：面板行保留同一条记录的重读说明`, row.text.includes("重读"), row.text.slice(0, 160));
      const end = handle.end();
      check(`${kind}：注入逐字节还原`, end.clean === true, end.diff);
      const good = await retryRead(call, a);
      attempt += 1;
      check(`${kind}：还原后重读回到 verified`, good.phase === "verified" && good.attempt === attempt, good);
      await closeOperationsPanel(call);
      check(`${kind}：零执行调用（重试不是重新执行）`, mock.served() === servedBefore + 1, mock.served());
    }
    check("全程零新 trace（重试不落盘）", H.traceIds().size === tracesBefore, { before: tracesBefore, after: H.traceIds().size });
  },

  /** 「失败与读取恢复分别收尾」的半边（行 157）：自动核实被挡 ⇒ 保留；重试读到正常终止 ⇒ 当场收尾 */
  "retry-then-cleanup": async (call, mock) => {
    const servedBefore = mock.served();
    const task = `${MARK} retry-cleanup 任务`;
    const watcher = startSettleWatcher();
    await openCreate(call);
    await fillUserMessage(call, task);
    await confirmSubmission(call);
    const sub = await submitCreateAndCapture(call);
    const race = await watcher.done();
    check("竞速注入得手（终态落盘瞬间隐藏文件）", race !== null, race);
    if (race === null) throw new Error("竞速注入失败");
    const rec = await waitRegistryRecordState(call, sub.operationId, "settled", 30000);
    check("登记收口且 runId 与被隐藏文件一致", rec?.runIds?.[0] === race.runId, { rec: rec?.runIds ?? null, race: race.runId });
    const auto = await resultReadFor(call, rec.epoch, sub.operationId, race.runId);
    check("自动核实被注入挡下 ⇒ unreadable（清理闸先过不了）", auto !== null && auto.phase === "unreadable", auto);
    const sess = await createSession(call);
    check("自动读取失败 ⇒ 草稿保留（不等下一轮也不预删）", sess.draft !== null && sess.draft.userMessage === task, sess.draft?.userMessage ?? null);
    const end = race.handle.end();
    check("注入逐字节还原", end.clean === true, end.diff);
    await openOperationsPanel(call);
    await clickRowAction(call, sub.operationId, "重读这条结果");
    const retried = await waitForVerified(call, rec.epoch, sub.operationId, race.runId);
    check("面板「重读」⇒ 同一可信 runId 落成 verified（attempt=2）", retried.phase === "verified" && retried.attempt === 2, retried);
    const closed = await createSession(call);
    check("重试读到正常终止 ⇒ 这条响应路径当场收尾（草稿被清理）", closed.draft === null, closed.draft?.userMessage ?? null);
    check("恰一次模型调用", mock.served() - servedBefore === 1, mock.served());
    await H.shot(call, SHOT_DIR, `${TAG}-after-cleanup.png`);
  },

  /** 「解冻后修改不被旧结果删除」（行 155）：修订推进后迟到的正常结果不清（内容改回原样也不清） */
  "rev-after-settle": async (call, mock) => {
    const servedBefore = mock.served();
    const v1 = `${MARK} rev 原始任务 v1`;
    const watcher = startSettleWatcher();
    await openCreate(call);
    await fillUserMessage(call, v1);
    await confirmSubmission(call);
    const sub = await submitCreateAndCapture(call);
    const race = await watcher.done();
    check("竞速注入得手", race !== null, race);
    if (race === null) throw new Error("竞速注入失败");
    const rec = await waitRegistryRecordState(call, sub.operationId, "settled", 30000);
    const auto = await resultReadFor(call, rec.epoch, sub.operationId, race.runId);
    check("自动核实 unreadable（草稿保留在场）", auto !== null && auto.phase === "unreadable", auto);
    const end = race.handle.end();
    check("注入逐字节还原", end.clean === true, end.diff);
    // 解冻后修改草稿（修订推进）
    await openCreate(call);
    const v2 = `${MARK} rev 修订任务 v2`;
    await fillUserMessage(call, v2);
    const sess = await createSession(call);
    check("解冻后修订推进（revision > 提交时修订）", sess.draft !== null && sess.draft.revision > sub.revision, { rev: sess.draft?.revision ?? null, submitted: sub.revision });
    await openOperationsPanel(call);
    await clickRowAction(call, sub.operationId, "重读这条结果");
    const retried = await waitForVerified(call, rec.epoch, sub.operationId, race.runId);
    check("迟到的正常结果落地（verified）", retried.phase === "verified", retried);
    const after = await createSession(call);
    check("修订推进 ⇒ 迟到的正常结果不清新修订（v2 文本保留）", after.draft !== null && after.draft.userMessage === v2, after.draft?.userMessage ?? null);
    // 内容改回原样也不清：判据只看修订。第二次重读走 store 的显式重试动作
    // （与面板按钮同一入口；按钮此刻不可用是因为条目已 verified——动作按可用性给）。
    await H.ev(call, "(() => { document.getElementById('operations-panel')?.querySelector('button[aria-label=\"关闭操作列表\"]')?.click(); return true; })()");
    await H.sleep(600);
    await openCreate(call);
    await fillUserMessage(call, v1);
    const retried2 = await retryRead(call, { epoch: rec.epoch, operationId: sub.operationId, runId: race.runId });
    check("第二次重读 verified（attempt=3）", retried2.phase === "verified" && retried2.attempt === 3, retried2);
    const after2 = await createSession(call);
    check("内容改回原样也不清（判据只看修订，不看内容）", after2.draft !== null && after2.draft.userMessage === v1, after2.draft?.userMessage ?? null);
    check("恰一次模型调用", mock.served() - servedBefore === 1, mock.served());
    await H.shot(call, SHOT_DIR, `${TAG}-rev-preserved.png`);
  },

  /** 「重复收尾与显式放弃不会误删重建草稿」（行 160）：放弃释放关联；重建后迟到结果不误删；重复重试幂等 */
  "idempotent-closure": async (call, mock) => {
    const servedBefore = mock.served();
    const taskA = `${MARK} idem 任务甲`;
    const watcher = startSettleWatcher();
    await openCreate(call);
    await fillUserMessage(call, taskA);
    await confirmSubmission(call);
    const subA = await submitCreateAndCapture(call);
    const race = await watcher.done();
    check("竞速注入得手", race !== null, race);
    if (race === null) throw new Error("竞速注入失败");
    const recA = await waitRegistryRecordState(call, subA.operationId, "settled", 30000);
    const auto = await resultReadFor(call, recA.epoch, subA.operationId, race.runId);
    check("甲自动核实 unreadable ⇒ 草稿保留", auto !== null && auto.phase === "unreadable", auto);
    const closureIdA = `${recA.epoch}|${subA.operationId}`;
    const cl1 = await H.storeQ(call, `return JSON.stringify(s.draftSubmissions.closures[${JSON.stringify(closureIdA)}] ?? null);`);
    check("甲的收尾关联在场（读取失败不清）", cl1 !== null, cl1 === null ? null : { targetKey: cl1.targetKey });
    const end = race.handle.end();
    check("注入逐字节还原", end.clean === true, end.diff);
    // 显式放弃（真模态）⇒ 关联一并释放
    await discardCreateDraft(call);
    const cl2 = await H.storeQ(call, `return JSON.stringify(s.draftSubmissions.closures[${JSON.stringify(closureIdA)}] ?? null);`);
    check("显式放弃 ⇒ 甲的关联一并释放", cl2 === null, cl2);
    const afterDiscard = await createSession(call);
    check("放弃后草稿复位（空表单新修订）", afterDiscard.draft === null || afterDiscard.draft.userMessage === "", afterDiscard.draft?.userMessage ?? null);
    // 重建同目标草稿并正常收口
    const taskB = `${MARK} idem 任务乙`;
    await openCreate(call);
    await fillUserMessage(call, taskB);
    await confirmSubmission(call);
    const subB = await submitCreateAndCapture(call);
    const settledB = await waitForCreateSettled(call);
    check("乙收口", settledB === true, settledB);
    const recB = await waitRegistryRecordState(call, subB.operationId, "settled", 30000);
    check("乙登记收口", recB?.state === "settled", recB?.state ?? null);
    const entryB = await waitForVerified(call, recB.epoch, subB.operationId, recB.runIds[0]);
    check("乙自动核实 verified", entryB.phase === "verified", entryB);
    const afterB = await createSession(call);
    check("乙正常收尾 ⇒ 草稿清理（乙自己的正常结果）", afterB.draft === null, afterB.draft?.userMessage ?? null);
    // 甲的迟到结果：重试 verified，但关联已释放 ⇒ 不复活任何草稿
    await openOperationsPanel(call);
    await clickRowAction(call, subA.operationId, "重读这条结果");
    const retriedA = await waitForVerified(call, recA.epoch, subA.operationId, race.runId);
    check("甲迟到重读 verified", retriedA.phase === "verified" && retriedA.attempt === 2, retriedA);
    const finalSess = await createSession(call);
    check("甲的迟到结果不复活已放弃/已清理的草稿", finalSess.draft === null, finalSess.draft?.userMessage ?? null);
    // 幂等：重复重试不再产生第二次删除
    const before = await sessionSnapshot(call);
    await retryRead(call, { epoch: recA.epoch, operationId: subA.operationId, runId: race.runId });
    await retryRead(call, { epoch: recB.epoch, operationId: subB.operationId, runId: recB.runIds[0] });
    const after = await sessionSnapshot(call);
    const finalDraft = await createSession(call);
    check("草稿仍为空（未复活）", finalDraft.draft === null, finalDraft.draft?.userMessage ?? null);
    check("关联键集不变", JSON.stringify(before.closures) === JSON.stringify(after.closures), { before: before.closures, after: after.closures });
    check("恰两次模型调用（甲乙各一次）", mock.served() - servedBefore === 2, mock.served());
  },

  /** 「创建工作区任务优先且可返回来源」的重载半边（行 231）：来源只在会话内、重载后取新来源不继承旧位置 */
  "reload-return-fallback": async (call, mock) => {
    const servedBefore = mock.served();
    const readLoc = () =>
      H.storeQ(
        call,
        `return JSON.stringify({ view: s.view, sel: s.selectedRunId,
           loc: s.createReturnLocation === null ? null : { view: s.createReturnLocation.view, runId: s.createReturnLocation.runId } });`,
      );
    const clickReturn = async () => {
      const ok = await H.ev(
        call,
        `(() => { const b = document.querySelector('section[aria-label="新建运行"] [data-return-to-source]');
          if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
      );
      if (ok !== "clicked") throw new Error(`点「返回来源」失败：${ok}`);
      await H.sleep(1400);
    };
    // 会话内：从 run 甲进入 ⇒ 记甲；返回回甲
    await H.selectRun(call, FX.normalRun);
    await openCreate(call);
    let st = await readLoc();
    check("从轨迹工作区进入 ⇒ 来源引用记当前选择（运行/视图）", st.loc !== null && st.loc.view === "trace" && st.loc.runId === FX.normalRun, st.loc);
    const hasReturn = await H.ev(
      call,
      `(() => document.querySelector('section[aria-label="新建运行"] [data-return-to-source]') !== null)()`,
    );
    check("页头「返回来源」按钮在场", hasReturn === true, hasReturn);
    await clickReturn();
    st = await readLoc();
    check("返回来源 ⇒ 回到轨迹视图且引用用过即清", st.view === "trace" && st.loc === null, st);
    // 换来源：选乙再进 ⇒ 取新来源，旧的不会被继承
    const runs = await H.runs(call);
    const other = runs.find((r) => r !== FX.normalRun) ?? null;
    check("列表里有第二个 run 可当新来源", other !== null, runs.length);
    if (other !== null) {
      await H.selectRun(call, other);
      await openCreate(call);
      st = await readLoc();
      check("换工作区再进创建 ⇒ 取新来源（旧引用不被继承）", st.loc !== null && st.loc.runId === other, st.loc);
      await clickReturn();
      st = await readLoc();
      check("再次返回落到新来源的运行", st.view === "trace" && st.sel === other, st);
    }
    // 重载：引用清空 ⇒ 再进创建取的是**当时**现场，不伪造旧位置
    await reloadWithGuard(call);
    const locAfterReload = await H.storeQ(
      call,
      `return JSON.stringify({ loc: s.createReturnLocation, view: s.view });`,
    );
    check("重载后来源引用清空（会话引用不落盘）", locAfterReload.loc === null && locAfterReload.view !== "create", locAfterReload);
    await openCreate(call);
    st = await readLoc();
    check(
      "重载后进创建 ⇒ 来源是**现在**的现场（runId 与当前选中一致，绝不等于重载前记的旧值）",
      st.loc !== null && st.loc.runId === st.sel,
      st,
    );
    await clickReturn();
    st = await readLoc();
    check("重载后「返回来源」照常回轨迹工作区（引用已重取 ⇒ restore，不 crash 不伪造）", st.view === "trace", st);
    check("全程零模型调用（418 剧本兜底：任何消费都会判红）", mock.served() - servedBefore === 0, mock.served());
    dump.layerNote =
      "「no-location 时点返回 ⇒ fallback」这一支真机不可达（进入创建必然现取来源）⇒ 按 create-workspace 单测承载";
    await H.shot(call, SHOT_DIR, `${TAG}-fresh-location.png`);
  },

  /**
   * 「核对终态只解冻对应修订」的可达半边（行 249）：核对 A（已收口）不解除 B（在飞）的冻结；
   * 迟到重读不复活草稿；重复核对按身份幂等。
   * ⚠️ 竞速注入（让 A 的自动核实 unreadable）不进本 tag：暖 dev 下 renderer 收尾链毫秒级，
   * 竞速胜率不稳（同款竞速在 retry-then-cleanup/rev-after-settle/idempotent-closure 各自承载），
   * 本 tag 的核心判据只依赖「A settled + B 在飞」这条稳定的时序。
   */
  "reconcile-single-unfreeze": async (call, mock) => {
    const servedBefore = mock.served();
    // A：正常收口（自动核实 verified ⇒ 正常草稿清理）
    const a = await runCreate(call, mock, `${MARK} single-unfreeze 甲`);
    check("甲收口并核实（正常结束 ⇒ 甲自己的草稿已按修订清理）", a.entry.phase === "verified" && a.entry.facts?.normalEnd === true, a.entry);
    // B：慢响应（8s）——B 在飞时创建目标被 B 冻结
    const taskB = `${MARK} single-unfreeze 乙`;
    await openCreate(call);
    await fillUserMessage(call, taskB);
    await confirmSubmission(call);
    const subB = await submitCreateAndCapture(call);
    const flightB = await waitRegistryRecordState(call, subB.operationId, "running", 20000);
    check("乙在飞（真窗口）", flightB?.state === "running", flightB?.state ?? null);
    const frozen1 = await createSession(call);
    check("乙在飞 ⇒ 创建目标被乙冻结", frozen1.frozen === true, frozen1.frozen);
    // 核对甲（面板按钮）：不许碰乙的冻结
    await openOperationsPanel(call);
    await clickRowAction(call, a.operationId, "核对状态");
    const frozen2 = await createSession(call);
    check("核对甲 ⇒ 乙仍冻结（解冻口只认匹配身份，核对别人的身份不解除当前在飞）", frozen2.frozen === true, frozen2.frozen);
    // 乙收口：乙自己的正常结果清乙的草稿
    const recB = await waitRegistryRecordState(call, subB.operationId, "settled", 30000);
    const entryB = await waitForVerified(call, recB.epoch, subB.operationId, recB.runIds[0]);
    check("乙收口并核实", entryB.phase === "verified", entryB);
    const closedB = await createSession(call);
    check("乙正常收尾 ⇒ 草稿清理（乙的修订、乙的清理）", closedB.draft === null, closedB.draft?.userMessage ?? null);
    // 甲的迟到重读（store 显式重试，与面板按钮同一动作入口）：不复活草稿、不动乙的关联
    const retriedA = await retryRead(call, a);
    check("甲迟到重读 verified（attempt=2，重复核实不产生第二次删除）", retriedA.phase === "verified" && retriedA.attempt === 2, retriedA);
    const c1 = await H.storeQ(call, "return JSON.stringify(Object.keys(s.draftSubmissions.closures).sort());");
    await clickRowAction(call, a.operationId, "核对状态");
    await clickRowAction(call, a.operationId, "核对状态");
    const c2 = await H.storeQ(call, "return JSON.stringify(Object.keys(s.draftSubmissions.closures).sort());");
    check("重复核对不产生第二条关联（按身份幂等）", JSON.stringify(c1) === JSON.stringify(c2), { c1, c2 });
    const finalDraft = await createSession(call);
    check("草稿保持已清理态（不复活）", finalDraft.draft === null, finalDraft.draft?.userMessage ?? null);
    check("恰两次模型调用", mock.served() - servedBefore === 2, mock.served());
    dump.layerNote =
      "「两条同 epoch 在飞同时冻结」真机不可达（统一执行槽一次只放一个 ⇒ 第二次提交被拒）⇒ 只解冻对应修订的那条/另一条仍冻结按单元层承载";
  },

  /** 「settled 无身份与 notAccepted 不猜测结果」+「操作详情可读诊断但不泄漏输入」的 6.6 半边（行 134/147/265） */
  "unlocated-reconcile": async (call, mock) => {
    const servedBefore = mock.served();
    const a = await runCreate(call, mock, `${MARK} unlocated 基准`);
    check("前置：正常 settled 操作在场（对照面）", a.entry.phase === "verified", a.entry);
    const gateBefore = await waitGateOpen(call);
    const ghostId = freshUuid();
    const r = await H.storeQ(
      call,
      `const sess = await s.reconcileOperation(${JSON.stringify(ghostId)});
       const rec = sess.operations.find(o => o.operationId === ${JSON.stringify(ghostId)}) ?? null;
       return JSON.stringify(rec);`,
    );
    check(
      "核对未知 ID ⇒ 只建不认领的封禁（notAccepted、无目标、无执行时间）",
      r?.state === "notAccepted" && r?.target === null && r?.startedAt === null,
      r,
    );
    const sess = await sessionSnapshot(call);
    check("读取项里一条结论都没有（不猜测结果）", sess.readKeys.every((k) => !k.includes(ghostId)), sess.readKeys.filter((k) => k.includes(ghostId)));
    const gateAfter = await waitGateOpen(call);
    check("封禁不占槽：门禁与核对前一致", gateAfter.gate === gateBefore.gate, { before: gateBefore, after: gateAfter });
    // 通知区（面板关着读）：诚实说明
    const live = await liveText(call);
    check(
      "通知区诚实说明（本次未被主进程接受：未执行，输入仍保留）",
      typeof live === "string" && live.includes("未被主进程接受") && live.includes("未执行"),
      typeof live === "string" ? live.slice(0, 140) : live,
    );
    // 面板行呈现：未接受 + 没有任何结果动作
    await openOperationsPanel(call);
    const row = await rowRead(call, ghostId);
    check("面板行呈现「未接受」", row.text.includes("未接受"), row.text.slice(0, 200));
    const actions = await rowActions(call, ghostId);
    check(
      "未接受行没有任何结果动作（打开结果/查看失败/重读都不在）",
      !actions.includes("打开结果") && !actions.includes("查看失败调用") && !actions.includes("重读这条结果"),
      actions,
    );
    const goodActions = await rowActions(call, a.operationId);
    check("对照：正常 settled 行保留结果动作（同面板互不影响）", goodActions.includes("打开结果"), goodActions);
    check("恰一次模型调用", mock.served() - servedBefore === 1, mock.served());
    dump.layerNote =
      "「settled 且 runIds 为空」的真机不可达（main 收尾必带 ≥1 runId）⇒ 未定位呈现按 result-verification 单测承载";
    await H.shot(call, SHOT_DIR, `${TAG}-tombstone.png`);
  },

  /** 「核对结果只由用户明确打开」（行 265）：核对不导航；打开结果才切换 */
  "reconcile-no-nav": async (call, mock) => {
    const servedBefore = mock.served();
    const a = await runCreate(call, mock, `${MARK} no-nav 任务`);
    await H.selectRun(call, FX.normalRun);
    const readSel = () =>
      H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId, span: s.selectedSpanId, gen: s.navGeneration, view: s.view });");
    const before = await readSel();
    check("前置：选择在别的 run 上", before.sel === FX.normalRun, before);
    await openOperationsPanel(call);
    await clickRowAction(call, a.operationId, "核对状态");
    const after = await readSel();
    check(
      "核对到达终态不导航（选择/页签/代次/视图都不动）",
      after.sel === before.sel && after.span === before.span && after.gen === before.gen && after.view === before.view,
      { before, after },
    );
    await clickRowAction(call, a.operationId, "打开结果");
    const opened = await readSel();
    check("「打开结果」显式动作才切到该 run", opened.sel === a.runId, opened);
    check("恰一次模型调用", mock.served() - servedBefore === 1, mock.served());
  },

  /** 「未知通信与新会话分开呈现」+「初始握手失败禁用主动入口」（行 133/263）：真 main 重启 */
  "main-restart": async (call, mock) => {
    const servedBefore = mock.served();
    const epoch0 = (await opsStatus(call)).data?.epoch ?? null;
    check("前置：旧 main 会话 epoch 在场", typeof epoch0 === "string", epoch0);
    // 重启前：跑通一条
    const done = await runCreate(call, mock, `${MARK} 重启前跑通`);
    check("重启前一条已收口并核实", done.entry.phase === "verified", done.entry);
    // 重启前：起一条真在飞
    await openCreate(call);
    const task2 = `${MARK} 被重启打断的在飞`;
    await fillUserMessage(call, task2);
    await confirmSubmission(call);
    const sub2 = await submitCreateAndCapture(call);
    const flight = await waitRegistryRecordState(call, sub2.operationId, "running", 20000);
    check("在飞确实 running（真在飞，不是假窗口）", flight?.state === "running", flight?.state ?? null);
    const reached = await waitServedAtLeast(mock, servedBefore + 2, 30000);
    check("在飞已把请求送到模型（打断点在中段）", reached === true && mock.served() === servedBefore + 2, mock.served());
    const hashesAtKill = H.hashAllTraces();
    // 真重启
    const { rec, call: call2 } = await restartMain(call, "main-restart");
    call = call2;
    SESSION.call = call2;
    check("真 main 重启：旧树真杀、9612 先空出再起新 dev 并重连", Number.isInteger(rec.freedAfter) && Number.isInteger(rec.upAfter) && rec.reconnect === true, rec);
    await installGatePoller(call);
    await reloadWithGuard(call);
    const gateLog = JSON.parse(await H.ev(call, "(() => JSON.stringify(window.__u566GateLog ?? []))()"));
    dump.gateLog = gateLog;
    const notHandshaked = gateLog.filter((s) => s.epochNull === true);
    check("采样到「未握手」首帧窗口（重启后必然存在）", notHandshaked.length > 0, { samples: gateLog.length, nh: notHandshaked.length });
    check("未握手窗口的禁用原因都是 not_handshaked（不知握手，不是未知）", notHandshaked.every((s) => s.blocked === "not_handshaked"), notHandshaked.slice(0, 3));
    // 新会话语义
    const neu = await opsStatus(call);
    check("新 main epoch 全新", typeof neu.data?.epoch === "string" && neu.data.epoch !== epoch0, { old: epoch0, new: neu.data?.epoch ?? null });
    check("新会话登记为空（旧 running/settled 都不带过来）", (neu.data?.operations ?? []).length === 0, (neu.data?.operations ?? []).length);
    const sess = await sessionSnapshot(call);
    check("新会话：pending 空、登记空、无未知锁（旧在飞身份不进新会话）", sess.pendingCount === 0 && sess.opsCount === 0 && sess.unknown === false, sess);
    check("读取项不跨会话（resultReads 空）", sess.readKeys.length === 0, sess.readKeys.length);
    const gate = await waitGateOpen(call);
    check("新会话门禁开放（不被旧会话的未知结局锁死）", gate.gate === null, gate);
    // 新会话真跑通
    const fresh = await runCreate(call, mock, `${MARK} 重启后跑通`);
    check("新会话真跑通并核实", fresh.entry.phase === "verified", fresh.entry);
    // 旧 ID 在新会话只有"没见过"一种事实
    const tomb = await H.storeQ(
      call,
      `const sess = await s.reconcileOperation(${JSON.stringify(done.operationId)});
       const rec = sess.operations.find(o => o.operationId === ${JSON.stringify(done.operationId)}) ?? null;
       return JSON.stringify(rec);`,
    );
    check("旧 opId 在新会话核对 ⇒ notAccepted 封禁（不认领旧结局）", tomb?.state === "notAccepted", tomb);
    // 落盘不变
    const hashesAfter = H.hashAllTraces();
    const touched = Object.keys(hashesAtKill).filter((n) => hashesAtKill[n] !== hashesAfter[n]);
    check("杀进程时在场的 run 文件逐份哈希不变（新会话不改写历史）", touched.length === 0, touched);
    check("恰三次模型调用（重启前两条 + 重启后一条）", mock.served() - servedBefore === 3, mock.served());
    await H.shot(call, SHOT_DIR, `${TAG}-fresh-session.png`);
  },

  /** 「迟到回调与未知状态不能错误解冻」（行 248）：旧 epoch 身份与新会话提交完全隔离 */
  "late-callback": async (call, mock) => {
    const servedBefore = mock.served();
    const epoch0 = (await opsStatus(call)).data?.epoch ?? null;
    // A：在飞 → 杀 main（旧 epoch 的回执永远到不了任何会话）
    await openCreate(call);
    const taskA = `${MARK} 旧会话在飞甲`;
    await fillUserMessage(call, taskA);
    await confirmSubmission(call);
    const subA = await submitCreateAndCapture(call);
    const flight = await waitRegistryRecordState(call, subA.operationId, "running", 20000);
    check("旧会话在飞 running", flight?.state === "running", flight?.state ?? null);
    const reached = await waitServedAtLeast(mock, servedBefore + 1, 30000);
    check("在飞已到模型", reached === true, mock.served());
    const { rec, call: call2 } = await restartMain(call, "late-callback");
    call = call2;
    SESSION.call = call2;
    check("真 main 重启完成", Number.isInteger(rec.freedAfter) && Number.isInteger(rec.upAfter) && rec.reconnect === true, rec);
    await installGatePoller(call);
    await reloadWithGuard(call);
    // 新会话：换新 epoch 新身份提交 B
    const gate = await waitGateOpen(call);
    check("新会话门禁开放", gate.gate === null, gate);
    const b = await runCreate(call, mock, `${MARK} 新会话的乙`);
    check("B 正常收口并核实（旧 epoch 的在飞不影响新会话）", b.entry.phase === "verified", b.entry);
    const sess = await sessionSnapshot(call);
    check("A 的身份没有跨会话泄漏（登记/pending/读取项/关联都无 A）", sess.opIds.includes(subA.operationId) === false && sess.readKeys.every((k) => !k.includes(subA.operationId)) && sess.closures.every((k) => !k.includes(subA.operationId)), { opIds: sess.opIds.length, pendingSubs: sess.pendingSubs });
    // 旧 epoch 直发：整份拒绝、零副作用
    const staleReconcile = await H.apiCall(call, "operationsReconcile", { epoch: epoch0, operationId: subA.operationId });
    check("旧 epoch 的核对被整份拒绝（OPERATION_STALE_EPOCH）", staleReconcile.ok === false && staleReconcile.error?.code === "OPERATION_STALE_EPOCH", staleReconcile.ok ? staleReconcile.data : staleReconcile.error);
    const staleCreate = await H.apiCall(call, "createRun", {
      operation: { epoch: epoch0, operationId: freshUuid() },
      request: { systemPrompt: "U5-66 stale", userMessage: `${MARK} 拿旧 epoch 提交` },
    });
    check("旧 epoch 的主动提交被拒", staleCreate.ok === false, staleCreate.ok ? staleCreate.data : staleCreate.error?.code ?? staleCreate.error);
    // 新会话对旧 ID 只有"没见过"
    const tomb = await H.storeQ(
      call,
      `const sess = await s.reconcileOperation(${JSON.stringify(subA.operationId)});
       const rec = sess.operations.find(o => o.operationId === ${JSON.stringify(subA.operationId)}) ?? null;
       return JSON.stringify(rec);`,
    );
    check("旧 ID 在新会话核对 ⇒ notAccepted 封禁（无目标、无时间）", tomb?.state === "notAccepted" && tomb?.target === null && tomb?.startedAt === null, tomb);
    const finalSess = await sessionSnapshot(call);
    check("B 的草稿已按正常清理（A 的任何迟到都不复活/不解冻任何东西）", (await createSession(call)).draft === null, null);
    check("关联与读取项仍无 A 痕迹", finalSess.closures.every((k) => !k.includes(subA.operationId)) && finalSess.readKeys.every((k) => !k.includes(subA.operationId)), finalSess.closures);
    check("恰两次模型调用（A 一次 + B 一次）", mock.served() - servedBefore === 2, mock.served());
    dump.layerNote =
      "「同一会话内迟到回执/通道抛错保留冻结」需要 renderer 存活跨 main 死亡——真机不可达 ⇒ 按单元层承载；本 tag 钉的是跨会话隔离半边";
  },
};

// ---------------------------------------------------------------------------

async function main() {
  const page = await H.cdpConnect(H.CDP_PORT);
  let call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  SESSION.call = call;
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await reloadWithGuard(call);

  let mock = null;
  for (let attempt = 0; attempt < 2 && mock === null; attempt++) {
    try {
      mock = await H.prepare(call, TAG_SCRIPT[TAG]);
    } catch (e) {
      if (attempt > 0 || !String(e).includes("Failed to fetch")) throw e;
      console.log("[prepare] 模块加载失败，reload 后重试一次");
      await reloadWithGuard(call);
    }
  }
  try {
    await FLOWS[TAG](call, mock);
  } catch (e) {
    check(`tag 执行异常：${String(e?.stack ?? e).slice(0, 600)}`, false);
  } finally {
    try {
      // teardown 有界化：ws 已关闭时 apiCall 会永挂（U3 6.6 的假绿通道教训）
      await Promise.race([
        H.teardown(SESSION.call ?? call, mock),
        new Promise((r) => setTimeout(r, 15000)),
      ]);
    } catch {
      /* 重启类 tag 旧会话可能已作废：尽力而为 */
    }
  }
  finish({ expectedCalls: EXPECTED_CALLS[TAG] });
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
