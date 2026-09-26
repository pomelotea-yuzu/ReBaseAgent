/* eslint-disable */
/**
 * U4 任务 6.5：Unknown 的可核对性——reconcile/执行的两种到达顺序 + 核对不解除别人的锁。
 *
 * 覆盖 delta 场景（逐字标题）：
 * - `reconcile 先到封禁迟到提交`（tag `reconcile-first`）
 * - `执行先到核对实际状态`（tag `execution-first`）
 * - `核对旧操作不解除另一操作的锁` + `核对终态只解冻对应修订`（tag `lock-isolation`）
 *
 * ⚠️ `probe` 的实测结论（决定本批能测什么，别按"应该能注入"写判据）：
 * 渲染层**不能包装 `window.api.*`**——contextBridge 暴露的属性
 * `writable:false / configurable:false`，`Object.defineProperty(window.api,'createRun',…)`
 * 直接抛 `TypeError: Cannot redefine property`。所以「篡改 status 载荷 / 丢弃执行响应」
 * 这类**桥接面注入在真机做不到**；对应的「非法结构整份拒收」「状态通道不可用保持未知」
 * 「响应丢失不自动重发」由 §4 的 store 用例（M-N/M-Q/M-R/M-S/M-AF）承载，
 * 本批**不冒充实测**（README 如实标注，别写成"全部实机覆盖"）。
 *
 * 另两条踩过的坑（写这类 tag 前先看）：
 * - **单槽设计下不可能两条真提交同时在飞**：所以「另一条操作」必须是
 *   一条**已完整跑完**的真提交（settled）。靠"只登记关联、不发出请求"造出来的关联
 *   没有 epoch 绑定，reconcile 也不该解它的锁——那是构造无效，不是产品缺陷。
 * - **在飞窗口要给延迟回合**：毫秒级返回时探针读到的已经是 settled（第一版两次假红都栽在这）。
 *
 * 用法：`node apps/desktop/scripts/u4-65-cdp.cjs --tag=<probe|reconcile-first|execution-first|lock-isolation>`
 */
"use strict";
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["probe", "reconcile-first", "execution-first", "lock-isolation"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u4", "u4-65");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-26-u4-65");
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
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
function finish() {
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条；证据 ${SHOT_DIR}`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超时未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 600_000);

// ---------------------------------------------------------------------------
// 读数（登记只读 main；界面会话只作对照）
// ---------------------------------------------------------------------------
const freshId = () =>
  `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(12, "0")}`;
async function opsSnapshot(call) {
  const st = await H.apiCall(call, "operationsStatus");
  const list = st?.data?.operations ?? [];
  return {
    ok: st?.ok === true,
    count: list.length,
    slot: st?.data?.activeOperationId ?? null,
    epoch: st?.data?.epoch ?? null,
    list,
  };
}
async function recordOf(call, operationId) {
  const snap = await opsSnapshot(call);
  return {
    rec: snap.list.find((o) => o.operationId === operationId) ?? null,
    slot: snap.slot,
    epoch: snap.epoch,
  };
}
const sessionView = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
        epoch: s.operations.epoch, unknown: s.operations.unknown,
        activeOperationId: s.operations.activeOperationId,
        pending: s.operations.pending.map(p => p.operationId),
       });`,
  );
const frozenKeys = (call) =>
  H.storeQ(call, "return JSON.stringify({ frozen: Object.keys(s.draftSubmissions.byId) });");
async function entryGate(call) {
  const session = await H.storeQ(call, "return JSON.stringify(s.operations);");
  return H.appImport(
    call,
    ["/src/renderer/src/lib/entry-gate.ts", "/src/lib/entry-gate.ts"],
    `return JSON.stringify(m.deriveEntryGate(${JSON.stringify(session)}));`,
  );
}
const reconcile = (call, epoch, operationId) =>
  H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `return JSON.stringify(await window.api.operationsReconcile({ epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} }));`,
  );
const storeReconcile = (call, operationId) =>
  H.storeQ(
    call,
    `await s.reconcileOperation(${JSON.stringify(operationId)}); return JSON.stringify({ done: true });`,
  );
const createRun = (call, epoch, operationId, userMessage) =>
  H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `return JSON.stringify(await window.api.createRun({
       operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
       request: { systemPrompt: '你是冒烟助手。只回一句话。', userMessage: ${JSON.stringify(userMessage)} },
     }));`,
  );
/** 起一次不 await 的真提交（留给"执行先到"的在飞窗口） */
function fireCreate(call, epoch, operationId, userMessage) {
  return call("Runtime.evaluate", {
    expression: `(async () => JSON.stringify(await window.api.createRun({
      operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
      request: { systemPrompt: '你是冒烟助手。只回一句话。', userMessage: ${JSON.stringify(userMessage)} },
    })))()`,
    returnByValue: true,
    awaitPromise: true,
  });
}
/** 页内：click → 捕获关联身份（可在飞期间切页签卸载编辑器） */
async function submitAndCapture(
  call,
  buttonText,
  key,
  { duringFlight = null, pollMs = 9000 } = {},
) {
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
      if (!btn) return JSON.stringify({ error: 'button-not-found' });
      if (btn.disabled) return JSON.stringify({ error: 'button-disabled', title: btn.title });
      btn.click();
      let flightDone = false;
      const deadline = Date.now() + ${pollMs};
      for (;;) {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        const m = await import(url);
        const x = m.useAppStore.getState().draftSubmissions.byId[${JSON.stringify(key)}];
        if (x !== undefined) {
          const snap = {
            channel: x.channel,
            revision: x.submittedRevision,
            text: x.submittedText,
            operationId: x.operationId ?? null,
            epoch: x.epoch ?? null,
          };
          if (!flightDone && ${JSON.stringify(duringFlight ?? null)} !== null) {
            const name = ${JSON.stringify(duringFlight)}.split(':')[1];
            const t = Array.from(document.querySelectorAll('[role="tab"]'))
              .find(y => ((y.textContent||'').trim()) === name);
            if (t) t.click();
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

// ---------------------------------------------------------------------------
// tag：probe —— 把注入通道的真实性量出来
// ---------------------------------------------------------------------------
async function scenarioProbe(call) {
  dump.descriptors = await H.ev(
    call,
    `(() => { const one = (k) => { const d = Object.getOwnPropertyDescriptor(window.api, k);
        return d ? { writable: d.writable === true, configurable: d.configurable === true } : null; };
      return JSON.stringify({ createRun: one('createRun'), operationsStatus: one('operationsStatus'),
                              operationsReconcile: one('operationsReconcile') }); })()`,
  );
  dump.redefineAttempt = await H.ev(
    call,
    `(() => { try {
        Object.defineProperty(window.api, 'createRun', { value: async () => ({ ok: false }), configurable: true });
        return 'succeeded';
      } catch (e) { return String(e); } })()`,
  );
  console.log("桥接面描述符:", JSON.stringify(dump.descriptors));
  console.log("defineProperty 尝试:", JSON.stringify(dump.redefineAttempt));
  check(
    "probe：桥接面不可包装（据此把不可注入项交回单测层，不冒充实测）",
    dump.redefineAttempt !== "succeeded",
    dump.redefineAttempt,
  );
  await H.shot(call, SHOT_DIR, "65-probe.png");
  // 注意别 return dump 自身：dump.result = out 会形成循环引用，finish 落盘直接抛
  return { descriptors: dump.descriptors, redefineAttempt: dump.redefineAttempt };
}

// ---------------------------------------------------------------------------
// tag：reconcile-first —— 核对先到的 ID 永久封禁，之后正式提交零执行
// ---------------------------------------------------------------------------
async function scenarioReconcileFirst(call, fx, mock) {
  void fx;
  const epoch = (await opsSnapshot(call)).epoch;
  const operationId = freshId();
  const filesBefore = H.traceIds().size;
  const servedBefore = mock.served();

  const rec0 = await reconcile(call, epoch, operationId);
  check(
    "reconcile 先到：为从未接受的 ID 建立 notAccepted 封禁",
    rec0.ok === true && rec0.data?.operation?.state === "notAccepted",
    rec0.ok ? rec0.data?.operation?.state : rec0.error,
  );
  check(
    "封禁那条不含目标与时间（不伪造执行事实）",
    rec0.data?.operation?.target === null && rec0.data?.operation?.startedAt === null,
    {
      target: rec0.data?.operation?.target,
      startedAt: rec0.data?.operation?.startedAt,
    },
  );
  check(
    "reconcile 自身零模型请求、零文件",
    mock.served() === servedBefore && H.traceIds().size === filesBefore,
    {
      served: mock.served(),
      files: H.traceIds().size,
    },
  );

  const late = await createRun(
    call,
    epoch,
    operationId,
    `U4-65 迟到提交 ${Math.random().toString(36).slice(2, 6)}`,
  );
  dump.late = late;
  check(
    "迟到正式提交被拒（OPERATION_NOT_ACCEPTED）",
    late.ok === false && late.error?.code === "OPERATION_NOT_ACCEPTED",
    late.ok ? late.data : late.error,
  );
  const rec1 = await recordOf(call, operationId);
  check(
    "封禁不被迟到提交复活（仍 notAccepted、无 runIds）",
    rec1.rec?.state === "notAccepted" && (rec1.rec?.runIds ?? []).length === 0,
    {
      state: rec1.rec?.state,
      runIds: rec1.rec?.runIds,
    },
  );
  check(
    "封禁期间零执行（服务与文件计数都没动）",
    mock.served() === servedBefore && H.traceIds().size === filesBefore,
    {
      served: mock.served(),
      files: H.traceIds().size,
    },
  );

  const okId = freshId();
  const good = await createRun(
    call,
    epoch,
    okId,
    `U4-65 封禁不扩散 ${Math.random().toString(36).slice(2, 6)}`,
  );
  check(
    "换新 ID 的正常提交被接受并落盘",
    good.ok === true && typeof good.data?.id === "string",
    good.ok ? good.data : good.error,
  );
  check(
    "新提交恰 1 次请求、1 份文件",
    mock.served() === servedBefore + 1 && H.traceIds().size === filesBefore + 1,
    {
      served: mock.served(),
      files: H.traceIds().size,
    },
  );
  await H.shot(call, SHOT_DIR, "65-reconcile-first.png");
  return { operationId, okId, served: mock.served() };
}

// ---------------------------------------------------------------------------
// tag：execution-first —— 已接受后核对返回实际状态，不再次执行
// ---------------------------------------------------------------------------
async function scenarioExecutionFirst(call, fx, mock) {
  void fx;
  const epoch = (await opsSnapshot(call)).epoch;
  const operationId = freshId();
  const servedBefore = mock.served();
  const filesBefore = H.traceIds().size;

  const pending = fireCreate(
    call,
    epoch,
    operationId,
    `U4-65 执行先到 ${Math.random().toString(36).slice(2, 6)}`,
  );
  await H.sleep(1500);
  const during = await recordOf(call, operationId);
  check(
    "执行先到时核对返回真实 running（不是 notAccepted）",
    during.rec?.state === "running",
    during.rec?.state,
  );
  check("核对不改变槽归属（仍指向这一次执行）", during.slot === operationId, during.slot);

  const r = JSON.parse((await pending)?.result?.value ?? "{}");
  check(
    "执行正常返回身份",
    r.ok === true && typeof r.data?.id === "string",
    r.ok ? r.data : r.error,
  );
  const after = await recordOf(call, operationId);
  check(
    "结束后核对返回 settled 且带真实 runIds",
    after.rec?.state === "settled" && after.rec.runIds.join() === r.data?.id,
    after.rec,
  );
  const rec = await reconcile(call, epoch, operationId);
  check(
    "再次核对仍返回既有 settled，绝不登记 notAccepted",
    rec.ok === true && rec.data?.operation?.state === "settled",
    rec.ok ? rec.data?.operation?.state : rec.error,
  );
  check(
    "两次核对都没有再执行（服务 +1、文件 +1 而已）",
    mock.served() === servedBefore + 1 && H.traceIds().size === filesBefore + 1,
    {
      served: mock.served(),
      files: H.traceIds().size,
    },
  );
  await H.shot(call, SHOT_DIR, "65-execution-first.png");
  return { operationId, id: r.data?.id ?? null };
}

// ---------------------------------------------------------------------------
// tag：lock-isolation —— 核对别的操作不解除本操作的锁
// ---------------------------------------------------------------------------
/**
 * A 是一条**完整跑完**的真提交（settled，可被核对）；B 是第二次真提交
 * （延迟回合造在飞窗口）。在飞期间核对 A ⇒ B 仍 running、仍占槽、关联仍冻结、
 * 门禁仍拒绝；B 只能被自己的响应收尾。两次真执行恰两次模型请求（核对不引发重发）。
 */
async function scenarioLockIsolation(call, fx, mock) {
  const runId = fx.normalRun;
  const key = `${runId}|s_03|result`;

  // ---- A：完整跑通一次真提交 ----
  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", "s_03");
  await H.clickByTextChecked(call, "在此重跑（时间旅行）", 1200);
  await H.typeIntoEditableMonaco(
    call,
    `U4-65 第一次真提交 ${Math.random().toString(36).slice(2, 6)}`,
  );
  const subA = await submitAndCapture(call, "确认重跑", key);
  check(
    "A：真提交登记关联并带身份（epoch 已绑定）",
    subA.channel === "result" && subA.operationId !== null && subA.epoch !== null,
    subA,
  );
  const settledA = await H.waitForSettle(call, [key], 120000);
  check(
    "A：正常收尾并解冻",
    !settledA.sub.ids.some((x) => x.id === key) && settledA.st.forking === "success",
    {
      forking: settledA.st.forking,
      code: settledA.st.forkErrorCode,
    },
  );
  const recA0 = await recordOf(call, subA.operationId);
  check(
    "A：登记 settled 且带真实 runId（后面要核对的就是这条）",
    recA0.rec?.state === "settled" && recA0.rec.runIds.length === 1,
    recA0.rec?.runIds,
  );
  const runA = recA0.rec?.runIds[0] ?? null;

  // ---- B：第二次真提交，造在飞窗口 ----
  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", "s_03");
  await H.clickByTextChecked(call, "在此重跑（时间旅行）", 1500);
  await H.typeIntoEditableMonaco(
    call,
    `U4-65 第二次真提交 ${Math.random().toString(36).slice(2, 6)}`,
  );
  const subB = await submitAndCapture(call, "确认重跑", key, { duringFlight: "tab:概览" });
  check(
    "B：新提交用新身份登记（不复用 A 的 operationId）",
    subB.operationId !== null && subB.operationId !== subA.operationId,
    {
      a: subA.operationId,
      b: subB.operationId,
    },
  );
  let duringB = await recordOf(call, subB.operationId);
  check(
    "B：main 槽归 B（running）",
    duringB.rec?.state === "running" && duringB.slot === subB.operationId,
    {
      state: duringB.rec?.state,
      slot: duringB.slot,
    },
  );

  // ---- 在飞期间核对 A：不得解除 B 的锁 ----
  await storeReconcile(call, subA.operationId);
  duringB = await recordOf(call, subB.operationId);
  check(
    "核对 A 之后：B 仍 running 且仍占槽",
    duringB.rec?.state === "running" && duringB.slot === subB.operationId,
    {
      state: duringB.rec?.state,
      slot: duringB.slot,
    },
  );
  const frozenNow = await frozenKeys(call);
  check(
    "核对 A 之后：B 的关联仍冻结（别人的终态解不开它）",
    frozenNow.frozen.includes(key),
    frozenNow,
  );
  const gateNow = await entryGate(call);
  check("核对 A 之后：门禁仍拒绝新提交（B 还在跑）", gateNow?.canSubmit === false, gateNow);
  const recA1 = await recordOf(call, subA.operationId);
  check(
    "A 的既有事实未被改写（仍 settled、runId 还是那一个）",
    recA1.rec?.state === "settled" && recA1.rec.runIds.join() === runA,
    recA1.rec?.runIds,
  );
  const view = await sessionView(call);
  check(
    "界面会话与 main 同源（unknown=false、本地在飞身份含 B）",
    view.unknown === false && view.pending.includes(subB.operationId),
    view,
  );

  // ---- B 只能被自己的响应收尾 ----
  const settledB = await H.waitForSettle(call, [key], 150000);
  check(
    "B 自己收尾才解冻（只有它的响应能结它的账）",
    !settledB.sub.ids.some((x) => x.id === key) && settledB.st.forking === "success",
    {
      ids: settledB.sub.ids.map((x) => x.id),
      forking: settledB.st.forking,
      code: settledB.st.forkErrorCode,
    },
  );
  const recB = await recordOf(call, subB.operationId);
  check(
    "B 登记 settled 且带自己的真实 runId（与 A 不同）",
    recB.rec?.state === "settled" && recB.rec.runIds.length === 1 && recB.rec.runIds[0] !== runA,
    {
      a: runA,
      b: recB.rec?.runIds,
    },
  );
  check("两次真提交恰 2 次模型请求（核对 A 不引发重发）", mock.served() === 2, mock.served());
  await H.shot(call, SHOT_DIR, "65-lock-isolation.png");
  return { a: subA.operationId, b: subB.operationId, runA, runB: recB.rec?.runIds[0] ?? null };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  if (!H.existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
  const fx = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const page = await H.cdpConnect(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  H.attachDialogHandler(call, []);
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
  console.log(`冷重载完成：运行列表 ${(await H.runs(call)).length} 项`);

  const scripts = {
    probe: { turns: [{ content: "不该被调用" }], fallback: { content: "不该被调用" } },
    "reconcile-first": {
      turns: [{ content: "封禁不扩散的那一次" }],
      fallback: { content: "兜底" },
    },
    // 在飞探针要给延迟回合：毫秒级返回时读到的已是 settled
    "execution-first": {
      turns: [{ content: "执行先到的那一次", delayMs: 6000 }],
      fallback: { content: "兜底" },
    },
    "lock-isolation": {
      turns: [{ content: "第一次真提交" }, { content: "第二次真提交", delayMs: 6000 }],
      fallback: { content: "兜底" },
    },
  };
  const mock = await H.prepare(call, scripts[TAG]);
  const scenarios = {
    probe: () => scenarioProbe(call),
    "reconcile-first": () => scenarioReconcileFirst(call, fx, mock),
    "execution-first": () => scenarioExecutionFirst(call, fx, mock),
    "lock-isolation": () => scenarioLockIsolation(call, fx, mock),
  };
  let out = null;
  let failure = null;
  try {
    out = await scenarios[TAG]();
  } catch (e) {
    failure = String(e?.stack ?? e);
    check("场景未抛异常", false, failure);
  } finally {
    await H.teardown(call, mock);
  }
  dump.result = out ?? null;
  dump.failure = failure;
  if (failure !== null) writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), failure);
  finish();
}

main().catch((e) => {
  console.error("采集失败:", e);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
