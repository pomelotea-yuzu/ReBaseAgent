/* eslint-disable */
/**
 * U4 任务 6.6：同 main renderer 重载 vs **真正的 main 重启** —— epoch / 槽 / 真实调用次数 / 旧响应行为。
 *
 * 覆盖 delta 场景（逐字标题）：
 * - `同 main 重载恢复操作`（tag `reload-running`）
 * - `乱序快照不回退新状态`（tag `out-of-order`：真机可测的那一半 + 不可诱发项的实测口径）
 * - `新 main 会话不伪造旧操作结局`（tag `main-restart`）
 *
 * 三条先量出来、决定判据怎么写的实机口径（`probe`  tag 复核）：
 * 1. **真重启原语**：`u2-dev-host.cjs --stop` 走 pid 文件 `taskkill /T /F` 真杀进程树 ⇒
 *    必须等 9612 真空出再起新 dev（项目记忆 `desktop-cdp-harness-gotchas.md`），
 *    重连后要重建 CDP 会话与 dialog 应答器；
 * 2. **status/reconcile 是 pull-only**：`window.api` 属性不可包装（6.5 实测）。`probe` 量的
 *    FIFO 只是 **main 侧的应答顺序**（并发 8 条 status 到达顺序乱序 0 次）；这不等于
 *    renderer 侧拿不到旧快照——变异 M-66E（摘掉 status 的代次/版本两条守卫）在
 *    `out-of-order` 上真机判红 2 条，红因就是"旧快照把已推进的状态压回去、轮询链已停 ⇒
 *    界面永远停在旧值"。⇒ 「迟到快照整份丢弃」在真机**有牙**，本 tag 的并发+重载形状就能撞出来；
 * 3. **`Page.reload` 必须验活体**：第一次跑 M-66D 时该 tag 全绿，事后查明那次 reload
 *    根本没换文档（旧 store 状态一路带过来 ⇒ 所有"重载后"判据空转）。现在 `reloadAndWait()`
 *    在导航前挂 `window.__u466Doc`，导航后读回来还在就**直接抛错**，不给空转的机会。
 * 4. **草稿与提交关联只在 renderer 内存**（U3 起的设计），所以重载必然带走它们。
 *    本批据此把「重载后不复活、也不伪造一条关联」写成**正向判据**，而不是当成缺陷。
 *
 * ⚠️ reload 后 CDP 真鼠标不再触发 React onClick（U3 6.6 实测）⇒ 本批一律用页内程序化动作。
 * ⚠️ 在飞判据必须给 `delayMs` 回合（6.5 的两次假红都栽在毫秒级返回）。
 *
 * 用法：node apps/desktop/scripts/u4-66-cdp.cjs --tag=<probe|reload-running|out-of-order|main-restart>
 */
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const { createConnection } = require("node:net");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["probe", "reload-running", "out-of-order", "main-restart"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u4", "u4-66");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-27-u4-66");
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const DEV_HOST = join(H.REPO, "apps", "desktop", "scripts", "u2-dev-host.cjs");
const PID_FILE = join(H.REPO, ".workbuddy", "u2-5-dev.pid");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

const checks = [];
const dump = { restarts: [], strayErrors: [] };
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
}, 480_000);

/** 重启会留下悬空的 CDP 响应（旧会话的 pending 永不 resolve）⇒ 异常只记录、不误杀采集 */
process.on("uncaughtException", (e) => {
  dump.strayErrors.push({
    kind: "uncaughtException",
    at: new Date().toISOString(),
    msg: String(e?.stack ?? e).slice(0, 500),
  });
  console.log("记录未捕获异常（重启期悬空响应）:", String(e?.message ?? e).slice(0, 160));
});
process.on("unhandledRejection", (e) => {
  dump.strayErrors.push({
    kind: "unhandledRejection",
    at: new Date().toISOString(),
    msg: String(e?.message ?? e).slice(0, 500),
  });
  console.log("记录未处理拒绝（重启期悬空响应）:", String(e?.message ?? e).slice(0, 160));
});

/** 当前活跃的 CDP 会话；真重启后由 `restartMain()` 换指向新 main 的新会话 */
let call = null;
const dialogs = [];

// ---------------------------------------------------------------------------
// 读数（登记只读 main；界面会话只作对照）
// ---------------------------------------------------------------------------
const rand = () => Math.random().toString(36).slice(2, 6);
/** 会话内自增尾号：同一毫秒连号也不会撞（旧写法只按毫秒，同 ms 两条会得同一身份） */
let idSeq = 0;
const freshId = () => {
  idSeq += 1;
  return `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(9, "0")}${String(idSeq).padStart(3, "0")}`;
};

async function mainStatus() {
  const st = await H.apiCall(call, "operationsStatus");
  const list = st?.data?.operations ?? [];
  return {
    ok: st?.ok === true,
    epoch: st?.data?.epoch ?? null,
    version: st?.data?.registryVersion ?? null,
    slot: st?.data?.activeOperationId ?? null,
    closing: st?.data?.closing ?? null,
    configBusy: st?.data?.configurationBusy ?? null,
    count: list.length,
    list,
  };
}
async function recordOf(operationId) {
  const snap = await mainStatus();
  return {
    rec: snap.list.find((o) => o.operationId === operationId) ?? null,
    slot: snap.slot,
    epoch: snap.epoch,
    count: snap.count,
    version: snap.version,
  };
}
const view = () =>
  H.storeQ(
    call,
    `return JSON.stringify({
        epoch: s.operations.epoch, registryVersion: s.operations.registryVersion,
        activeOperationId: s.operations.activeOperationId, unknown: s.operations.unknown,
        closing: s.operations.closing, configurationBusy: s.operations.configurationBusy,
        pending: s.operations.pending.map(p => p.operationId),
        operations: s.operations.operations.map(o => ({ id: o.operationId, state: o.state, runIds: o.runIds })),
       });`,
  );
const frozenKeys = () =>
  H.storeQ(call, "return JSON.stringify({ frozen: Object.keys(s.draftSubmissions.byId) });");
/** 只读入口徽标（点面板会触发一次 status 刷新 ⇒ 自动核对的判据必须用不点击的读数） */
const badgeText = () =>
  H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
      return b === null ? null : (b.textContent||'').trim(); })()`,
  );
const draftsEmpty = async () => {
  const d = await H.drafts(call);
  if (d === null || d === undefined) return false;
  const ab = Object.values(d.modelAb ?? {}).reduce(
    (acc, bySpan) => acc + Object.keys(bySpan ?? {}).length,
    0,
  );
  return Object.keys(d.calls ?? {}).length === 0 && ab === 0 && d.create === null;
};
async function entryGate() {
  const session = await H.storeQ(call, "return JSON.stringify(s.operations);");
  return H.appImport(
    call,
    ["/src/renderer/src/lib/entry-gate.ts", "/src/lib/entry-gate.ts"],
    `return JSON.stringify(m.deriveEntryGate(${JSON.stringify(session)}));`,
  );
}
/** 真桥接面直发（唯一合法的注入面：载荷可造，属性不可包装） */
const bridgeReconcile = (epoch, operationId) =>
  H.apiCall(call, "operationsReconcile", { epoch, operationId });
const storeReconcile = (operationId) =>
  H.storeQ(
    call,
    `await s.reconcileOperation(${JSON.stringify(operationId)}); return JSON.stringify({ done: true });`,
  );
const CREATE_SYSTEM = "你是冒烟助手。只回一句话。";
const createRun = (epoch, operationId, userMessage) =>
  H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `return JSON.stringify(await window.api.createRun({
       operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
       request: { systemPrompt: ${JSON.stringify(CREATE_SYSTEM)}, userMessage: ${JSON.stringify(userMessage)} },
     }));`,
  );
/** 起一次不 await 的真提交（留给重载/重启的在飞窗口） */
function fireCreate(epoch, operationId, userMessage) {
  return call("Runtime.evaluate", {
    expression: `(async () => JSON.stringify(await window.api.createRun({
      operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
      request: { systemPrompt: ${JSON.stringify(CREATE_SYSTEM)}, userMessage: ${JSON.stringify(userMessage)} },
    })))()`,
    returnByValue: true,
    awaitPromise: true,
  });
}
/** 起一次不 await 的**store 级** status 刷新（走真握手：代次守卫在 store 里） */
function fireStoreRefresh() {
  return call("Runtime.evaluate", {
    expression: `(async () => {
      const all = performance.getEntriesByType('resource').map(e => e.name);
      const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
      const m = await import(url);
      const s = await m.useAppStore.getState().refreshOperationStatus();
      return JSON.stringify({ v: s.registryVersion, slot: s.activeOperationId });
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
}
async function waitRunning(operationId, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await recordOf(operationId);
    if (r.rec !== null) return r;
    if (Date.now() > deadline) return r;
    await H.sleep(150);
  }
}
async function waitMainSettled(operationId, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await recordOf(operationId);
    if (r.rec !== null && r.rec.state !== "running") return r;
    if (Date.now() > deadline) return { ...r, timedOut: true };
    await H.sleep(500);
  }
}
/** 只读界面：等轮询自己把状态推进（不人为刷新，否则测不到"自动核对"） */
async function waitViewIdle(ms = 40_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await view();
    if (v.epoch !== null && v.activeOperationId === null && v.unknown === false) return v;
    if (Date.now() > deadline) return { ...v, timedOut: true };
    await H.sleep(500);
  }
}
async function waitServedAtLeast(mock, target, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (mock.served() >= target) return true;
    if (Date.now() > deadline) return false;
    await H.sleep(200);
  }
}
async function waitGateOpen(ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const gate = await entryGate();
    if (gate?.canSubmit === true) return gate;
    if (Date.now() > deadline) return { ...gate, timedOut: true };
    await H.sleep(600);
  }
}
async function reloadAndWait() {
  // 导航前在 window 上留一个"活体标记"：真重载会把它连同 JS 上下文一起销毁。
  // 读回来还在 ⇒ 这次根本没换文档 ⇒ 后面所有"重载后"的判据都是空转 ⇒ 直接炸给脚本看。
  await H.ev(call, `(() => { window.__u466Doc = ${Date.now()}; return true; })()`);
  await call("Page.reload", { ignoreCache: true });
  let readyMs = 0;
  for (let i = 0; i < 60; i++) {
    await H.sleep(500);
    readyMs += 500;
    try {
      if ((await H.runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间 */
    }
  }
  const alive = await H.ev(
    call,
    `(() => (typeof window.__u466Doc === 'number' ? window.__u466Doc : null))()`,
  );
  if (alive !== null) {
    throw new Error(`Page.reload 未换文档（活体标记仍在 ⇒ ${alive}）⇒ 重载类判据会空转`);
  }
  dump.reloadWaits = [...(dump.reloadWaits ?? []), readyMs];
  await H.sleep(1200);
  return readyMs;
}
async function openOperationsPanel() {
  const expanded = await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
       if (b === null) throw new Error('操作入口按钮不存在');
       return b.getAttribute('aria-expanded'); })()`,
  );
  if (expanded !== "true") {
    await H.ev(
      call,
      `(() => { document.querySelector('button[aria-controls="operations-panel"]').click(); return true; })()`,
    );
    await H.sleep(1000);
  }
  const text = await H.ev(
    call,
    `(() => { const p = document.querySelector('#operations-panel');
      return p === null ? null : p.innerText.slice(0, 4000); })()`,
  );
  if (typeof text !== "string") throw new Error("操作面板未展开（读不到 #operations-panel）");
  return text;
}
/** 面板逐条读数（一行一条操作；runId 链接是嵌套 li ⇒ 只取直接子 li） */
async function panelRows() {
  await openOperationsPanel();
  const raw = await H.ev(
    call,
    `(() => JSON.stringify(Array.from(document.querySelectorAll('#operations-panel > ul > li'))
      .map(x => (x.textContent||'').trim())))()`,
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// 真 main 重启（本批唯一的真重启通道）
// ---------------------------------------------------------------------------
function probePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
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
async function cdpHttpUp(seconds = 90) {
  for (let i = 1; i <= seconds; i++) {
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
/**
 * 真停真起：走 dev host 的 `--stop`（按 pid 文件 taskkill 整棵进程树，不按映像名杀），
 * 等 9612 真空出，再起新 host 并重连 CDP。返回实测读数（供判据用，不返回布尔）。
 */
async function restartMain(why) {
  const rec = {
    why,
    pidBefore: null,
    stopOut: "",
    freedAfter: null,
    upAfter: null,
    reconnect: false,
  };
  if (H.existsSync(PID_FILE)) rec.pidBefore = readFileSync(PID_FILE, "utf8").trim();
  try {
    call.ws.close();
  } catch {
    /* 旧会话本就悬空：重启期间不指望它响应 */
  }
  const stop = spawnSync(process.execPath, [DEV_HOST, "--stop"], {
    encoding: "utf8",
    windowsHide: true,
  });
  rec.stopOut = `${stop.stdout ?? ""}${stop.stderr ?? ""}`.trim().slice(0, 300);
  for (let i = 1; i <= 40; i++) {
    if (!(await probePort(H.CDP_PORT))) {
      rec.freedAfter = i;
      break;
    }
    await H.sleep(500);
  }
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
    H.attachDialogHandler(call, dialogs);
    rec.reconnect = true;
  }
  dump.restarts.push(rec);
  console.log(
    `[真重启:${why}] stop=${rec.stopOut} 空出=${rec.freedAfter} 起来=${rec.upAfter} 重连=${rec.reconnect}`,
  );
  return rec;
}

/** 并发 status 的到达顺序（FIFO 读数；真机能否诱发乱序就看这个数） */
async function measureArrivalOrder(n) {
  const raw = await H.evAsync(
    call,
    `(async () => { const order = [];
       await Promise.all(Array.from({ length: ${n} }, (_, i) =>
         window.api.operationsStatus().then(() => { order.push(i); })));
       const inversions = order.reduce((a, v, i) => a + (v === i ? 0 : 1), 0);
       return JSON.stringify({ order, inversions }); })()`,
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// tag：probe —— 真重启原语 + 两条不可注入面的实测口径
// ---------------------------------------------------------------------------
async function scenarioProbe(mock) {
  const before = await mainStatus();
  check(
    "probe：旧 main 会话可读（epoch 在场、槽空闲）",
    before.epoch !== null && before.slot === null,
    {
      epoch: before.epoch,
      slot: before.slot,
      version: before.version,
    },
  );

  const fifo = await measureArrivalOrder(8);
  dump.fifo = fifo;
  check(
    "probe：并发 status 乱序次数量成读数（0 ⇒ 旧快照迟到的分支真机不可诱发，交回 §4 单测）",
    Number.isInteger(fifo.inversions),
    fifo,
  );
  const apiShape = await H.apiCall(call, "operationsStatus");
  check(
    "probe：真桥接面可直发任意载荷（旧 epoch 这类注入只能走这条路）",
    apiShape?.ok === true && typeof apiShape.data?.epoch === "string",
    { ok: apiShape?.ok, keys: Object.keys(apiShape?.data ?? {}) },
  );

  const servedBefore = mock.served();
  const filesBefore = H.traceIds().size;
  const rec = await restartMain("probe");
  check("probe：旧 dev 真停 ⇒ 9612 在有限次探测内空出", Number.isInteger(rec.freedAfter), rec);
  check("probe：新 dev 起来并重新监听 9612", Number.isInteger(rec.upAfter), rec);
  check("probe：CDP 会话重连成功", rec.reconnect === true, rec);
  await reloadAndWait();
  const runCount = (await H.runs(call)).length;
  check("probe：重启后运行列表可读（工作区指针自动恢复，不需重开目录）", runCount > 0, runCount);

  const after = await mainStatus();
  check(
    "probe：真重启 ⇒ 新 main epoch 与旧会话完全不同",
    after.epoch !== null && after.epoch !== before.epoch,
    { before: before.epoch, after: after.epoch },
  );
  check(
    "probe：新会话登记为空（旧 running/settled 都不带过来 ⇒ 没有任何伪造结局可被读到）",
    after.count === 0 && after.slot === null,
    { count: after.count, slot: after.slot },
  );
  const gate = await waitGateOpen();
  check("probe：启动期配置变更标记会自己释放（新会话最终可提交）", gate?.canSubmit === true, gate);
  const firstView = await view();
  check(
    "probe：新 renderer 首次握手即采纳新 epoch",
    firstView.epoch === after.epoch && firstView.registryVersion === after.version,
    { view: firstView.epoch, main: after.epoch, v: firstView.registryVersion, mv: after.version },
  );

  const id = freshId();
  const r = await createRun(after.epoch, id, `U4-66 probe 重启后真跑通 ${rand()}`);
  const settled = await waitMainSettled(id);
  check(
    "probe：同一受控服务在重启后仍服务真请求（恰 +1 请求 +1 文件）",
    r.ok === true && mock.served() === servedBefore + 1 && H.traceIds().size === filesBefore + 1,
    { ok: r.ok, code: r.error?.code, served: mock.served(), files: H.traceIds().size },
  );
  check(
    "probe：重启后的执行登记照常收口（settled + 真实 runId）",
    settled.rec?.state === "settled" && settled.rec.runIds.length === 1,
    settled.rec,
  );
  check(
    "probe：采集全程无未捕获异常打断",
    dump.strayErrors.length === 0,
    dump.strayErrors.slice(0, 3),
  );
  await H.shot(call, SHOT_DIR, "66-probe.png");
  return { before: before.epoch, after: after.epoch, id, served: mock.served() };
}

// ---------------------------------------------------------------------------
// tag：reload-running —— 同 main 的真重载恢复在飞操作，且零重放
// ---------------------------------------------------------------------------
async function scenarioReloadRunning(mock, fx) {
  const epoch0 = (await mainStatus()).epoch;
  check(
    "同 main：起点 epoch 在场且槽空闲",
    epoch0 !== null && (await mainStatus()).slot === null,
    epoch0,
  );

  // ---- 基准：一次跑完的真提交（后面要跨重载重放它） ----
  const baseMsg = `U4-66 重放基准 ${rand()}`;
  const baseId = freshId();
  const base = await createRun(epoch0, baseId, baseMsg);
  const baseDone = await waitMainSettled(baseId);
  check(
    "基准提交真跑通并 settled（带可信 runId）",
    base.ok === true && baseDone.rec?.state === "settled" && baseDone.rec.runIds.length === 1,
    base.ok ? baseDone.rec : base.error,
  );
  const baseRunId = baseDone.rec?.runIds[0] ?? null;
  const baseHash = H.hashAllTraces()[`${baseRunId}.jsonl`] ?? null;

  // ---- 封禁：重载前立一个 tombstone，重载后必须仍然封着 ----
  const banId = freshId();
  const ban0 = await bridgeReconcile(epoch0, banId);
  check(
    "重载前建立核对封禁（notAccepted + 无目标 + 无执行时间）",
    ban0.ok === true &&
      ban0.data?.operation?.state === "notAccepted" &&
      ban0.data?.operation?.target === null &&
      ban0.data?.operation?.startedAt === null,
    ban0.ok ? ban0.data?.operation : ban0.error,
  );

  const servedBefore = mock.served();
  const filesBefore = H.traceIds().size;
  const versionBefore = (await mainStatus()).version;

  // ---- 在飞：走真 UI 的一次 result 续跑（延迟回合撑开窗口） ----
  const runId = fx.normalRun;
  const key = `${runId}|s_03|result`;
  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", "s_03");
  await H.clickByTextChecked(call, "在此重跑（时间旅行）", 1500);
  await H.typeIntoEditableMonaco(call, `U4-66 在飞的那一次 ${rand()}`);
  const idsBeforeFlight = new Set(H.traceIds());
  await H.clickByTextChecked(call, "确认重跑", 400);
  const sub = await H.submissions(call);
  const assoc = sub.ids.find((x) => x.id === key) ?? null;
  check("在飞提交在真草稿上登记了关联", assoc !== null && assoc.channel === "result", sub.ids);
  // 关联读数里没有 operationId（harness 只给草稿侧字段）⇒ 身份从界面在飞登记取
  const v0 = await view();
  const flightId = v0.pending[0] ?? null;
  check("在飞执行的身份已在界面登记（本地在飞 ⟹ 跨入口锁生效）", flightId !== null, v0);
  const during = await recordOf(flightId);
  check(
    "重载前 main：该执行 running 且占着唯一的槽",
    during.rec?.state === "running" && during.slot === flightId,
    { state: during.rec?.state, slot: during.slot },
  );
  check("重载前：恰 1 次模型请求已发出", mock.served() === servedBefore + 1, mock.served());
  // 实测：run 文件在**运行开始**时就创建（不是收口才写）⇒ 在飞期间盘上已有那一份。
  // 所以"重载不重放文件"要比的是"重载本身有没有多出第二份"，而不是"在飞那次落没落盘"。
  const filesAtReload = H.traceIds().size;
  const flightFilesAtReload = [...H.traceIds()].filter((x) => !idsBeforeFlight.has(x)).sort();
  dump.filesAtReload = { filesAtReload, flightFilesAtReload };
  check(
    "重载前实测：那次在飞只创建了它自己那一份 run 文件（文件随运行开始产生）",
    filesAtReload === filesBefore + 1 && flightFilesAtReload.length === 1,
    { filesAtReload, filesBefore, flightFilesAtReload },
  );

  // ---- 真重载（同 main） ----
  await reloadAndWait();

  const after = await mainStatus();
  check(
    "同 main 重载恢复操作：epoch 不变、登记里那条还在 running、槽未易主",
    after.epoch === epoch0 &&
      after.list.find((o) => o.operationId === flightId)?.state === "running" &&
      after.slot === flightId,
    {
      epoch: after.epoch,
      state: after.list.find((o) => o.operationId === flightId)?.state,
      slot: after.slot,
    },
  );
  const v1 = await view();
  check(
    "同 main 重载恢复操作：新 renderer 首次握手即采纳同一个 main 会话与在飞槽",
    v1.epoch === epoch0 && v1.activeOperationId === flightId && v1.unknown === false,
    v1,
  );
  check(
    "同 main 重载：登记版本不回退（新会话采纳的版本 ≥ 重载前）",
    v1.registryVersion >= versionBefore,
    { adopted: v1.registryVersion, before: versionBefore, main: after.version },
  );
  const badge = await badgeText();
  check(
    "同 main 重载：操作入口不靠「界面记得」也照常报出那条在飞执行（徽标含「执行中 1」）",
    typeof badge === "string" && badge.includes("执行中 1"),
    badge,
  );
  const gate = await entryGate();
  check(
    "同 main 重载：门禁仍按 main 的槽拒绝新提交（blockedBy=operation_running）",
    gate?.canSubmit === false && gate?.blockedBy === "operation_running",
    gate,
  );
  check("重载不重放在飞请求：模型请求计数没增加", mock.served() === servedBefore + 1, {
    served: mock.served(),
    expected: servedBefore + 1,
  });
  check(
    "重载不重放文件：份数与重载前一致（在飞那次的文件没被复制成第二份）",
    H.traceIds().size === filesAtReload,
    { files: H.traceIds().size, atReload: filesAtReload },
  );
  const sub2 = await H.submissions(call);
  const froz = await frozenKeys();
  check(
    "重载不复活也不伪造提交关联（草稿与关联同在 renderer 内存，一起清空）",
    sub2.ids.length === 0 && froz.frozen.length === 0 && (await draftsEmpty()),
    { ids: sub2.ids.length, frozen: froz.frozen },
  );

  // ---- 终态由轮询自己推进（不人为刷新） ----
  const idle = await waitViewIdle(60_000);
  check(
    "重载后无需人为点击：自动核对把那条推进为空闲（轮询在重载后仍在工作）",
    idle.timedOut !== true && idle.activeOperationId === null,
    idle,
  );
  const done = await recordOf(flightId);
  check(
    "在飞执行照常由 main 收口（settled + 恰一个可信 runId，与磁盘同名）",
    done.rec?.state === "settled" &&
      done.rec.runIds.length === 1 &&
      H.existsSync(join(H.TRACES, `${done.rec.runIds[0]}.jsonl`)),
    done.rec,
  );
  check(
    "收口认领的就是重载前那一份文件（在飞那次全程只有一份 run，没有第二份）",
    done.rec?.runIds?.[0] === flightFilesAtReload[0] && H.traceIds().size === filesAtReload,
    { claimed: done.rec?.runIds, atReload: flightFilesAtReload, files: H.traceIds().size },
  );
  const v2 = await view();
  check(
    "重载后的界面按身份恢复了那条的终态事实（runIds 属实）",
    v2.operations.find((o) => o.id === flightId)?.state === "settled" &&
      v2.operations.find((o) => o.id === flightId)?.runIds.join() === done.rec?.runIds?.join(),
    v2.operations.find((o) => o.id === flightId),
  );
  const panel = await openOperationsPanel();
  check(
    "重载后打开面板：那条按身份显示为「已收口」并带完整 operationId 与可信 runId",
    panel.includes("已收口") &&
      panel.includes(String(flightId)) &&
      panel.includes(String(done.rec?.runIds?.[0] ?? "")),
    panel.slice(0, 260),
  );
  check(
    "整段全程只发生 2 次真执行（基准 + 在飞），重载一次也没多问服务",
    mock.served() === servedBefore + 1 && servedBefore === 1,
    { servedBefore, served: mock.served(), entries: mock.entries().map((e) => e.n) },
  );

  // ---- 跨重载的旧响应/旧身份行为 ----
  const dup = await createRun(epoch0, baseId, baseMsg);
  check(
    "跨重载重放同一身份同一请求 ⇒ OPERATION_DUPLICATED、零执行零文件",
    dup.ok === false &&
      dup.error?.code === "OPERATION_DUPLICATED" &&
      mock.served() === servedBefore + 1,
    dup.ok ? dup.data : dup.error,
  );
  const dupRec = await recordOf(baseId);
  check(
    "重放不改写原登记（仍 settled、runId 还是那一个、文件哈希未变）",
    dupRec.rec?.state === "settled" &&
      dupRec.rec.runIds.join() === baseRunId &&
      H.hashAllTraces()[`${baseRunId}.jsonl`] === baseHash,
    dupRec.rec?.runIds,
  );
  const conflict = await createRun(epoch0, baseId, `${baseMsg}（改了正文）`);
  check(
    "跨重载同身份异参 ⇒ OPERATION_CONFLICT（原登记一字不改、不执行）",
    conflict.ok === false && conflict.error?.code === "OPERATION_CONFLICT",
    conflict.ok ? conflict.data : conflict.error,
  );
  const banned = await createRun(epoch0, banId, `U4-66 重载后想复活封禁 ${rand()}`);
  check(
    "跨重载的核对封禁仍然有效 ⇒ OPERATION_NOT_ACCEPTED，迟到提交复活不了它",
    banned.ok === false && banned.error?.code === "OPERATION_NOT_ACCEPTED",
    banned.ok ? banned.data : banned.error,
  );
  const ban1 = await recordOf(banId);
  check(
    "封禁那条重载后仍 notAccepted、无 runIds（不被迟到提交改写）",
    ban1.rec?.state === "notAccepted" && ban1.rec.runIds.length === 0,
    ban1.rec,
  );
  check(
    "三次旧身份重放合计零模型请求、零新增文件",
    mock.served() === servedBefore + 1 && H.traceIds().size === filesBefore + 1,
    { served: mock.served(), files: H.traceIds().size },
  );
  await H.shot(call, SHOT_DIR, "66-reload-running.png");
  return { epoch0, flightId, baseId, baseRunId, banId, served: mock.served() };
}

// ---------------------------------------------------------------------------
// tag：out-of-order —— 并发快照 / 重载采纳的可观测不变量
// ---------------------------------------------------------------------------
async function scenarioOutOfOrder(mock, fx) {
  void fx;
  const base = await mainStatus();
  check("起点：槽空闲、界面已采纳 main 当前版本", base.slot === null, base);
  const servedBefore = mock.served();
  const filesBefore = H.traceIds().size;

  // ---- 先留一条已收口的真操作（重载后要按身份恢复它，而不是重跑） ----
  const seedId = freshId();
  const seed = await createRun(base.epoch, seedId, `U4-66 风暴前的基准 ${rand()}`);
  const seedDone = await waitMainSettled(seedId);
  const seedRunId = seedDone.rec?.runIds[0] ?? null;
  const seedHash = H.hashAllTraces()[`${seedRunId}.jsonl`] ?? null;
  check(
    "基准操作 settled 并落盘（后面要按身份恢复这一份）",
    seed.ok === true && seedDone.rec?.state === "settled" && seedHash !== null,
    { ok: seed.ok, code: seed.error?.code, rec: seedDone.rec },
  );

  // ---- 在飞期间制造并发快照风暴 ----
  const flightId = freshId();
  // 重载会作废这个页内 Promise ⇒ 只让它自己落地，不在此 await（下面用 main 登记读数核对）
  fireCreate(base.epoch, flightId, `U4-66 风暴中的在飞 ${rand()}`).catch(() => {});
  const flight = await waitRunning(flightId);
  check(
    "风暴开始前：那条已在 main 登记为 running",
    flight.rec?.state === "running",
    flight.rec?.state,
  );
  const versionDuring = (await mainStatus()).version;
  // 先让界面采纳一次在飞快照：之后的采样才有"从 running 回退成空闲"可测
  await H.storeQ(call, "await s.refreshOperationStatus(); return JSON.stringify({ ok: true });");
  const adopted = await view();
  check(
    "风暴开始前：界面已采纳那条在飞执行（槽 = 该身份）",
    adopted.activeOperationId === flightId,
    adopted,
  );

  const samples = [];
  const fired = [];
  for (let i = 0; i < 8; i++) fired.push(fireStoreRefresh());
  for (let i = 0; i < 12; i++) {
    samples.push(await view());
    await H.sleep(200);
  }
  const versions = samples.map((x) => x.registryVersion);
  const monotonic = versions.every((v, i) => i === 0 || v >= versions[i - 1]);
  dump.storm = { versions, slotFlips: 0, mainVersion: versionDuring };
  check("乱序快照不回退新状态：并发 8 次刷新期间界面采纳版本单调不减", monotonic, versions);
  let flipToIdle = 0;
  for (const s of samples) if (s.epoch !== null && s.activeOperationId === null) flipToIdle += 1;
  const stillRunning = (await recordOf(flightId)).rec?.state === "running";
  dump.storm.slotFlips = flipToIdle;
  check(
    "乱序快照不回退新状态：采纳过在飞快照后，槽没有被旧快照抹成空闲",
    stillRunning === true && flipToIdle === 0,
    { flipToIdle, stillRunning },
  );
  await Promise.all(fired);
  const v3 = await view();
  const mainNow = await mainStatus();
  check(
    "风暴结束后界面采纳的就是 main 当前版本（旧快照不留在身上）",
    v3.registryVersion === mainNow.version && v3.registryVersion >= versionDuring,
    { adopted: v3.registryVersion, main: mainNow.version, during: versionDuring },
  );
  check(
    "并发查询不引发任何执行（风暴期间的模型请求数就是基准 + 在飞那两次）",
    mock.served() === servedBefore + 2,
    { served: mock.served(), servedBefore, entries: mock.entries().map((e) => e.n) },
  );
  const fifo = await measureArrivalOrder(8);
  dump.fifoDuringFlight = fifo;
  check(
    "FIFO 读数（在飞期间再量一次）：乱序次数如实记录，据此决定哪些分支留在单测层",
    Number.isInteger(fifo.inversions),
    fifo,
  );

  // ---- 真重载：新会话必须采纳到"最新"而不是回退 ----
  const adoptedBefore = (await view()).registryVersion;
  await reloadAndWait();
  const v4 = await view();
  const mainAfter = await mainStatus();
  check(
    "在飞中真重载：epoch 不变（同 main）、槽仍指向那条在飞执行",
    v4.epoch === base.epoch && v4.activeOperationId === flightId && mainAfter.slot === flightId,
    { view: v4.activeOperationId, main: mainAfter.slot },
  );
  check(
    "在飞中真重载：新会话采纳版本 = main 当前版本且 ≥ 重载前采纳版本（不回退）",
    v4.registryVersion === mainAfter.version && v4.registryVersion >= adoptedBefore,
    { adopted: v4.registryVersion, main: mainAfter.version, before: adoptedBefore },
  );
  const seedRecovered = v4.operations.find((o) => o.id === seedId) ?? null;
  check(
    "重载后按身份恢复既有事实：基准那条仍是 settled 且 runId 指向磁盘那份文件",
    seedRecovered?.state === "settled" &&
      seedRecovered.runIds.join() === seedRunId &&
      H.hashAllTraces()[`${seedRunId}.jsonl`] === seedHash,
    seedRecovered,
  );
  const done = await waitMainSettled(flightId);
  const v5 = await waitViewIdle(60_000);
  check(
    "重载后的在飞执行照常收口，且界面由自动核对推进到空闲（不点不刷）",
    done.rec?.state === "settled" && v5.timedOut !== true && v5.activeOperationId === null,
    { state: done.rec?.state, view: v5.registryVersion, main: done.version, v5 },
  );
  check(
    "收口后界面采纳的版本 = main 当前版本（既不回退也不停在旧值）",
    v5.registryVersion >= done.version,
    { view: v5.registryVersion, mainAtSettle: done.version, now: (await mainStatus()).version },
  );
  check(
    "整场风暴 + 重载合计恰 2 次真执行、恰 2 份文件（查询与重载都不产生调用）",
    mock.served() === servedBefore + 2 && H.traceIds().size === filesBefore + 2,
    { served: mock.served(), files: H.traceIds().size, filesBefore },
  );
  await H.shot(call, SHOT_DIR, "66-out-of-order.png");
  return { base: base.epoch, seedId, seedRunId, flightId, versions, fifo };
}

// ---------------------------------------------------------------------------
// tag：main-restart —— 真 main 重启：新会话不伪造旧操作结局
// ---------------------------------------------------------------------------
async function scenarioMainRestart(mock) {
  const old = await mainStatus();
  const servedBefore = mock.served();

  // ---- 旧会话里跑通一条真操作，并立一条核对封禁 ----
  const doneId = freshId();
  const doneRes = await createRun(old.epoch, doneId, `U4-66 重启前跑通 ${rand()}`);
  const doneRec = await waitMainSettled(doneId);
  const doneRunId = doneRec.rec?.runIds[0] ?? null;
  check(
    "重启前：一条真操作已 settled 并落盘（后面要证明新会话不认领它）",
    doneRes.ok === true && doneRec.rec?.state === "settled" && doneRunId !== null,
    doneRec.rec,
  );
  const banId = freshId();
  const ban = await bridgeReconcile(old.epoch, banId);
  check(
    "重启前：一条核对封禁在场（notAccepted）",
    ban.ok === true && ban.data?.operation?.state === "notAccepted",
    ban.ok ? ban.data?.operation?.state : ban.error,
  );
  const hashesBefore = H.hashAllTraces();

  // ---- 起一条真在飞执行，等它把请求送到模型，再在这个时刻杀 main ----
  const idsBeforeFlight = new Set(H.traceIds());
  const flightId = freshId();
  fireCreate(old.epoch, flightId, `U4-66 被重启打断的在飞 ${rand()}`).catch(() => {});
  const flight = await waitRunning(flightId);
  check(
    "重启前：那条执行确实 running（真在飞，不是假窗口）",
    flight.rec?.state === "running",
    flight.rec,
  );
  // 打断点要落在"模型正在回答"上，而不是"还没出门"：基准那次已经占了一个计数，
  // 所以要等计数涨到 servedBefore+2 才说明在飞这真的出门了（第一版拿 +1 当目标 ⇒ 秒过、假在飞）。
  const reachedModel = await waitServedAtLeast(mock, servedBefore + 2, 25_000);
  check(
    "重启前：那次在飞已把请求送到模型并在等回答（打断点是真在飞中段）",
    reachedModel && mock.served() === servedBefore + 2,
    { served: mock.served(), servedBefore },
  );
  const servedAtKill = mock.served();
  const filesAtKill = H.traceIds().size;
  const flightFilesAtKill = [...H.traceIds()].filter((x) => !idsBeforeFlight.has(x)).sort();
  const hashesAtKill = H.hashAllTraces();

  const rec = await restartMain("main-restart");
  check(
    "真 main 重启：旧进程树被真杀、9612 先空出再起新 dev 并重连",
    Number.isInteger(rec.freedAfter) && Number.isInteger(rec.upAfter) && rec.reconnect === true,
    rec,
  );
  await reloadAndWait();

  const neu = await mainStatus();
  check(
    "新 main 会话不伪造旧操作结局：epoch 全新、登记里一份记录都没有",
    neu.epoch !== null && neu.epoch !== old.epoch && neu.count === 0 && neu.slot === null,
    { old: old.epoch, new: neu.epoch, count: neu.count, slot: neu.slot },
  );
  const lostDone = await recordOf(doneId);
  const lostFlight = await recordOf(flightId);
  check(
    "旧会话那条 settled 与那条被打断的 running 在新会话都查无此操作（既不成功也不失败）",
    lostDone.rec === null && lostFlight.rec === null,
    { done: lostDone.rec, flight: lostFlight.rec },
  );
  check(
    "被打断的在飞执行：盘上就是它自己那一份未完成文件（不重复、也不被新会话认领）",
    H.traceIds().size === filesAtKill && flightFilesAtKill.length <= 1,
    { filesAtKill, flightFilesAtKill, filesNow: H.traceIds().size },
  );

  // ---- 旧 epoch 的核对与提交：整份拒绝、零副作用 ----
  const staleReconcile = await bridgeReconcile(old.epoch, flightId);
  check(
    "旧 epoch 的核对被整份拒绝（OPERATION_STALE_EPOCH）",
    staleReconcile.ok === false && staleReconcile.error?.code === "OPERATION_STALE_EPOCH",
    staleReconcile.ok ? staleReconcile.data : staleReconcile.error,
  );
  const afterStale = await mainStatus();
  check(
    "旧 epoch 的核对零副作用：不在新登记里建封禁、不占槽",
    afterStale.count === 0 && afterStale.slot === null,
    { count: afterStale.count, slot: afterStale.slot },
  );
  const staleSubmit = await createRun(old.epoch, freshId(), `U4-66 拿旧 epoch 提交 ${rand()}`);
  check(
    "旧 epoch 的主动提交被拒（OPERATION_STALE_EPOCH），且不进登记",
    staleSubmit.ok === false &&
      staleSubmit.error?.code === "OPERATION_STALE_EPOCH" &&
      (await mainStatus()).count === 0,
    staleSubmit.ok ? staleSubmit.data : staleSubmit.error,
  );
  check(
    "上面三次旧身份动作合计零模型请求、零新增文件",
    mock.served() === servedAtKill && H.traceIds().size === filesAtKill,
    { served: mock.served(), files: H.traceIds().size, servedAtKill, filesAtKill },
  );

  // ---- 新会话对旧 ID 只有"没见过"一种事实 ----
  const neuReconcile = await bridgeReconcile(neu.epoch, flightId);
  check(
    "新会话里核对旧 ID ⇒ 只建不认领的封禁（notAccepted、无目标、无执行时间）",
    neuReconcile.ok === true &&
      neuReconcile.data?.operation?.state === "notAccepted" &&
      neuReconcile.data?.operation?.target === null &&
      neuReconcile.data?.operation?.startedAt === null,
    neuReconcile.ok ? neuReconcile.data?.operation : neuReconcile.error,
  );
  const v6 = await view();
  check(
    "界面核对旧 ID 后不产生任何解冻或重发（关联与草稿本来就随 renderer 一起清空）",
    (await frozenKeys()).frozen.length === 0 && (await H.submissions(call)).ids.length === 0,
    { version: v6.registryVersion, unknown: v6.unknown },
  );
  const neuBan = await bridgeReconcile(neu.epoch, banId);
  check(
    "旧会话的封禁不跨会话继承：新会话对那个 ID 只新建一条 reconcile 封禁",
    neuBan.ok === true &&
      neuBan.data?.operation?.state === "notAccepted" &&
      neuBan.data?.operation?.rejection === "reconcile_tombstone",
    neuBan.ok ? neuBan.data?.operation : neuBan.error,
  );

  // ---- 新会话自己照常可用：锁只按新 main 的槽决定 ----
  const gate = await waitGateOpen();
  check(
    "新会话门禁只按新 main 的空槽判定为可提交（不被旧会话的未知结局锁死）",
    gate?.canSubmit === true && gate?.blockedBy === null,
    gate,
  );
  const fresh = freshId();
  const freshRes = await createRun(neu.epoch, fresh, `U4-66 新会话真跑通 ${rand()}`);
  const freshDone = await waitMainSettled(fresh);
  check(
    "换新 epoch 换新身份 ⇒ 真跑通一次（恰 +1 请求，文件数 = 杀进程那一刻的份数 +1）",
    freshRes.ok === true &&
      freshDone.rec?.state === "settled" &&
      mock.served() === servedAtKill + 1 &&
      H.traceIds().size === filesAtKill + 1,
    {
      ok: freshRes.ok,
      code: freshRes.error?.code,
      state: freshDone.rec?.state,
      served: mock.served(),
      servedAtKill,
      files: H.traceIds().size,
      filesAtKill,
    },
  );
  const viewAfter = await view();
  check(
    "新会话的界面登记与 main 同源（版本一致、unknown=false）",
    viewAfter.epoch === neu.epoch &&
      viewAfter.registryVersion >= neu.version &&
      viewAfter.unknown === false,
    {
      view: viewAfter.registryVersion,
      main: (await mainStatus()).version,
      unknown: viewAfter.unknown,
    },
  );

  // ---- 历史文件一字未改（含被打断那次留下的那一份） ----
  const hashesAfter = H.hashAllTraces();
  const touched = Object.keys(hashesAtKill).filter((n) => hashesAtKill[n] !== hashesAfter[n]);
  check(
    "重启前后：杀进程那一刻在场的 run 文件逐份哈希不变（新会话不改写任何历史）",
    touched.length === 0,
    { touched, kept: Object.keys(hashesAtKill).length },
  );
  check(
    "被打断那次的未完成文件原样留在盘上（新会话既不续写也不删，也不认领它）",
    flightFilesAtKill.length === 0 ||
      hashesAtKill[`${flightFilesAtKill[0]}.jsonl`] ===
        hashesAfter[`${flightFilesAtKill[0]}.jsonl`],
    flightFilesAtKill,
  );
  check(
    "重启前跑通的那份仍在原处、内容未变（真凭据不受重启影响）",
    hashesBefore[`${doneRunId}.jsonl`] !== undefined &&
      hashesAfter[`${doneRunId}.jsonl`] === hashesBefore[`${doneRunId}.jsonl`],
    doneRunId,
  );
  const rows = await panelRows();
  dump.restartPanelRows = rows;
  check(
    "界面上重启后看不见旧会话那条已收口操作（没在新会话被查过 ⇒ 一条都不呈现）",
    rows.every((r) => !r.includes(doneId)),
    rows.length,
  );
  const oldQueried = rows.filter((r) => r.includes(flightId) || r.includes(banId));
  check(
    "被新会话查过的旧 ID 只以「未接受」出现，绝不显示为已收口/执行中（不伪造旧结局）",
    oldQueried.length === 2 &&
      oldQueried.every(
        (r) => r.includes("未接受") && !r.includes("已收口") && !r.includes("执行中"),
      ),
    oldQueried,
  );
  const ownRowText = rows.find((r) => r.includes(fresh)) ?? "";
  check(
    "新会话自己的那条照常是「已收口 + 可信 runId」（旧会话不存在不影响新会话）",
    ownRowText !== "" &&
      ownRowText.includes("已收口") &&
      ownRowText.includes(String(freshDone.rec?.runIds?.[0] ?? "")),
    ownRowText.slice(0, 200),
  );
  check(
    "整场采集未被未捕获异常打断（重启期悬空响应已单独记录）",
    dump.strayErrors.length === 0,
    dump.strayErrors.slice(0, 3),
  );
  await H.shot(call, SHOT_DIR, "66-main-restart.png");
  return {
    old: old.epoch,
    new: neu.epoch,
    doneId,
    flightId,
    banId,
    fresh,
    served: mock.served(),
    restart: rec,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  if (!H.existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
  const fx = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const page = await H.cdpConnect(H.CDP_PORT);
  call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  H.attachDialogHandler(call, dialogs);
  await reloadAndWait();
  console.log(`冷重载完成：运行列表 ${(await H.runs(call)).length} 项`);

  const scripts = {
    probe: {
      turns: [{ content: "重启后真跑通的那一次", delayMs: 3000 }],
      fallback: { content: "兜底" },
    },
    "reload-running": {
      turns: [{ content: "基准那一次" }, { content: "在飞的那一次", delayMs: 30_000 }],
      fallback: { content: "兜底" },
    },
    "out-of-order": {
      turns: [{ content: "风暴前的基准" }, { content: "风暴中的在飞", delayMs: 25_000 }],
      fallback: { content: "兜底" },
    },
    "main-restart": {
      turns: [
        { content: "重启前跑通" },
        { content: "被打断的在飞", delayMs: 25_000 },
        { content: "新会话跑通" },
      ],
      fallback: { content: "兜底" },
    },
  };
  const mock = await H.prepare(call, scripts[TAG]);
  const scenarios = {
    probe: () => scenarioProbe(mock),
    "reload-running": () => scenarioReloadRunning(mock, fx),
    "out-of-order": () => scenarioOutOfOrder(mock, fx),
    "main-restart": () => scenarioMainRestart(mock),
  };
  let out = null;
  let failure = null;
  try {
    out = await scenarios[TAG]();
  } catch (e) {
    failure = String(e?.stack ?? e);
    check("场景未抛异常", false, failure);
  }
  dump.result = out ?? null;
  dump.failure = failure;
  dump.dialogs = dialogs.slice(0, 10);
  if (failure !== null) writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), failure);
  try {
    await H.teardown(call, mock);
  } catch {
    /* 旧会话已随重启作废：尽力而为 */
  }
  finish();
}

main().catch((e) => {
  console.error("采集失败:", e);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
