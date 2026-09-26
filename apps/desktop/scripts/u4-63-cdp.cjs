/* eslint-disable */
/**
 * U4 任务 6.3：proxy 主动重发 × 被动录制交错、无 key、录制写入失败、被动录制不占槽。
 *
 * 覆盖 delta 场景（`specs/desktop-ui/spec.md` 与 `specs/llm-proxy` 侧的既有契约，逐字标题）：
 * - `主动代理重发与被动录制交错`（THEN：主动操作只关联本次 fork 上下文的 ID，不能返回被动 run ID；
 *   写入失败明确记录失败且不二次录制，不修改被动录制结果）
 * - `同 ID 重复请求只执行一次`（proxy 通道那一份）
 * - `只读入口和被动录制不占主动槽`
 * - `接受后业务拒绝仍有可信终态`（PROXY_NO_KEY：main 独立复核，渲染层禁用只是 UX）
 *
 * 判据口径：
 * - 代理启动/停止一律走 **store 真动作** `toggleProxy`（界面状态与 main 同源），
 *   upstream 用**不带路径**的 `http://127.0.0.1:18799`（handler 自己拼 `/v1/chat/completions`）；
 * - 外部请求从 harness 进程直连代理（渲染层 fetch 受系统代理干扰，U3 6.3 实测）；
 * - 「主动身份」只认 main 的 `operations:status` 登记 runIds，并与落盘 `meta.id`、
 *   被动 run 的 id **三方比对**（相等就是串号，判红）；
 * - 写入失败注入 = 在飞窗口把 `.rebaseagent/traces` **同卷 rename** 走（不删一个文件），
 *   `finally` 立即还原并核对文件数一致；这是唯一能在真机造出「录制写入失败」而不破坏数据的方式。
 *
 * 用法：`node apps/desktop/scripts/u4-63-cdp.cjs --tag=<interleave|dup|nokey|write-fail|passive-no-slot>`
 */
"use strict";
const { mkdirSync, writeFileSync, readdirSync, renameSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["interleave", "dup", "nokey", "write-fail", "passive-no-slot"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u4", "u4-63");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-26-u4-63");
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
// 读数与操作
// ---------------------------------------------------------------------------
const SLOW_TURN = { delayMs: 6000, content: "受控响应：本轮结束。" };
const opsStatus = (call) => H.apiCall(call, "operationsStatus");
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  return {
    rec: (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null,
    slot: st?.data?.activeOperationId ?? null,
    epoch: st?.data?.epoch ?? null,
  };
};
const submissionsU4 = (call) =>
  H.storeQ(
    call,
    `const ids = Object.keys(s.draftSubmissions.byId).map((k) => {
         const x = s.draftSubmissions.byId[k];
         return { id: k, channel: x.channel, operationId: x.operationId, epoch: x.epoch };
       });
     return JSON.stringify({ ids });`,
  );

/** 起/停代理走 store 真动作（界面状态与 main 同源，不是直调 api） */
async function setProxy(call, enabled) {
  return H.storeQ(
    call,
    `const st = await s.toggleProxy({ enabled: ${enabled}, port: ${H.PROXY_PORT}, upstreamBaseUrl: ${JSON.stringify(H.MOCK_UPSTREAM)} });
     return JSON.stringify({ running: st?.running === true, hasKey: st?.hasKey === true, enabled: st?.enabled === true });`,
  );
}
/** 外部请求经代理（node 侧，真实用法同形） */
async function proxyChat(content, timeoutMs = 40000) {
  try {
    const r = await fetch(`http://127.0.0.1:${H.PROXY_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-u463-session" },
      body: JSON.stringify({
        model: "mock-model",
        stream: false,
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, body: (await r.text()).slice(0, 160) };
  } catch (e) {
    return { error: String(e) };
  }
}
/** 页内真 IPC：带执行信封调 proxy:fork（重复提交那条只能这样构造） */
async function proxyForkWithIdentity(call, epoch, operationId, request) {
  return H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `const env = await window.api.proxyFork({ operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} }, request: ${JSON.stringify(request)} });
     return JSON.stringify(env);`,
  );
}
/** 起一次带身份的 proxy:fork，但**不 await**（调用方拿到的 promise 留给"在飞窗口"用） */
function fireProxyFork(call, epoch, operationId, request) {
  return call("Runtime.evaluate", {
    expression: `(async () => JSON.stringify(await window.api.proxyFork({
      operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
      request: ${JSON.stringify(request)},
    })))()`,
    returnByValue: true,
    awaitPromise: true,
  });
}
async function waitEpoch(call) {
  const st = await opsStatus(call);
  if (st?.ok !== true && st?.data === undefined)
    throw new Error(`status 失败：${JSON.stringify(st)}`);
  return st.data.epoch;
}

/** 录制一个代理父本并打开它的 messages 编辑器，返回 {seedRunId, draftText, messages} */
async function prepareMessagesDraft(call, mock) {
  const before = H.traceIds();
  const mark = Math.random().toString(36).slice(2, 8);
  const seed = await proxyChat(`U4-63 代理录制 ${mark}`);
  check("经代理的外部请求成功返回（真转发到受控 upstream）", seed.status === 200, seed);
  const kids = await H.newChildren(before, 25000, 1);
  const seedRunId = kids[0] ?? null;
  check("被动录制产出新 run（可作 messages 重发的父本）", seedRunId !== null, kids);
  await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
  await H.selectRun(call, seedRunId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "LLM", "s_02");
  await H.clickByTextChecked(call, "编辑 messages 重发", 1500);
  const recorded = (H.readChild(seedRunId)?.firstRequestMessages ?? []).map((m) =>
    m.role === "user" ? { ...m, content: `${m.content}（已编辑重发）` } : m,
  );
  await H.setEditableMonaco(call, JSON.stringify(recorded, null, 2));
  const draftText = (await H.drafts(call))?.calls?.[seedRunId]?.s_02?.messages?.text ?? "";
  check(
    "messages 草稿已入 store（含编辑标记）",
    draftText.includes("已编辑重发"),
    draftText.slice(0, 80),
  );
  void mock;
  return { seedRunId, draftText, messages: recorded };
}

/** 点「确认重发」并在页内捕获关联身份——返回时**执行仍在飞**（受控服务该回合 delayMs 6s），
 * 于是 node 侧有真窗口可以做被动录制（页内 fetch 会受系统代理干扰，U3 6.3 实测） */
async function submitResend(call, key, pollMs = 12000) {
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()).includes('确认重发'));
      if (!btn) return JSON.stringify({ error: 'button-not-found' });
      if (btn.disabled) return JSON.stringify({ error: 'button-disabled', title: btn.title });
      btn.click();
      const deadline = Date.now() + ${pollMs};
      for (;;) {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        const m = await import(url);
        const x = m.useAppStore.getState().draftSubmissions.byId[${JSON.stringify(key)}];
        if (x !== undefined) {
          return JSON.stringify({ channel: x.channel, revision: x.submittedRevision, text: x.submittedText,
                                  operationId: x.operationId ?? null, epoch: x.epoch ?? null });
        }
        if (Date.now() > deadline) return JSON.stringify({ none: true });
        await new Promise(res => setTimeout(res, 20));
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new Error(`submitResend: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
  return JSON.parse(r?.result?.value ?? "{}");
}

// ---------------------------------------------------------------------------
// 场景 A：主动重发 × 被动录制交错（串号判据）
// ---------------------------------------------------------------------------
async function scenarioInterleave(call, fx, mock) {
  void fx;
  const proxy = await setProxy(call, true);
  check("代理已启动（store 真动作，界面与 main 同源）", proxy.running === true, proxy);
  const { seedRunId, draftText, messages } = await prepareMessagesDraft(call, mock);
  const key = `${seedRunId}|s_02|messages`;
  const filesBefore = [...H.traceIds()];
  const opsBefore = ((await opsStatus(call))?.data?.operations ?? []).length;
  const servedBefore = mock.served();

  // 提交（页内捕获身份，返回时执行仍在飞）⇒ **在同一在飞窗口里**做一条被动录制
  const sub = await submitResend(call, key);
  check(
    "messages 提交登记关联且带可信身份",
    sub.channel === "messages" && sub.operationId !== null,
    sub,
  );
  const operationId = sub.operationId;
  const passive = await proxyChat(`U4-63 交错被动录制 ${Math.random().toString(36).slice(2, 6)}`);
  check(
    "主动重发在飞期间，被动录制照常受理（两条通道不互相阻塞）",
    passive.status === 200,
    passive,
  );

  const during = await recordOf(call, operationId);
  check(
    "在飞期间 main 登记 running 且占槽",
    during.rec?.state === "running" && during.slot === operationId,
    { state: during.rec?.state, slot: during.slot },
  );
  check(
    "登记类型是 proxy（主动重发，不是被动录制）",
    during.rec?.target?.kind === "proxy",
    during.rec?.target,
  );
  const opsDuring = ((await opsStatus(call))?.data?.operations ?? []).length;
  check("被动录制没有增加登记条目（登记数仍只多我们那一次）", opsDuring === opsBefore + 1, {
    opsBefore,
    opsDuring,
  });

  const settled = await H.waitForSettle(call, [key], 120000);
  check(
    "响应后按身份解冻",
    !settled.sub.ids.some((x) => x.id === key) && !settled.timedOut,
    settled.sub.ids.map((x) => x.id),
  );

  const after = await recordOf(call, operationId);
  const runIds = after.rec?.runIds ?? [];
  check(
    "主动登记只带本次 fork 的一个身份（没把被动 run 混进来）",
    runIds.length === 1 && runIds[0] !== seedRunId,
    runIds,
  );
  const forkId = runIds[0] ?? null;
  const forkTrace = forkId === null ? null : H.readChild(forkId);
  check(
    "fork 记录真存在且 fork.edit.value = 提交快照（结构逐字段一致）",
    JSON.stringify(forkTrace?.meta?.fork?.edit?.value ?? null) === JSON.stringify(messages),
    forkTrace?.meta?.fork?.edit?.value?.slice?.(0, 80),
  );
  check(
    "settled 且请求结局 returned（重发成功）",
    after.rec?.state === "settled" && after.rec?.requestOutcome === "returned",
    { state: after.rec?.state, outcome: after.rec?.requestOutcome, code: after.rec?.errorCode },
  );
  check("槽已释放", after.slot !== operationId, after.slot);

  // 被动录制独立落盘：本窗新增 = 主动 fork + 同窗被动 = 2
  const nowFiles = [...H.traceIds()];
  const added = nowFiles.filter((id) => !filesBefore.includes(id));
  check("本次窗口新增 2 份 run（主动 fork + 同窗被动录制）", added.length === 2, added);
  const passiveId = added.find((id) => id !== forkId) ?? null;
  check(
    "被动录制那一份有自己独立的 id（不与主动 fork 同号）",
    passiveId !== null && passiveId !== forkId,
    { passiveId, forkId },
  );
  const passiveTrace = passiveId === null ? null : H.readChild(passiveId);
  // 真实形状：被动录制的 meta.fork 是 **null**（不是缺字段），主动那份才带 edit
  check(
    "被动录制结果未被改写（它的 fork 仍是 null，主动那一份带 fork.edit）",
    (passiveTrace?.meta?.fork ?? null) === null &&
      forkTrace?.meta?.fork?.edit?.field === "messages",
    { passiveFork: passiveTrace?.meta?.fork, forkField: forkTrace?.meta?.fork?.edit?.field },
  );
  // servedBefore 已含 seed 那一次 ⇒ 本窗新增 = 主动重发 1 + 交错被动 1 = 2
  check("受控服务本窗恰多 2 次请求（主动重发 + 交错被动）", mock.served() === servedBefore + 2, {
    servedBefore,
    now: mock.served(),
  });
  check(
    "messages 重发后草稿保留",
    (await H.drafts(call)).calls?.[seedRunId]?.s_02?.messages?.text === draftText,
  );
  await H.shot(call, SHOT_DIR, "63-interleave.png");
  return { seedRunId, forkId, passiveId, operationId, runIds, served: mock.served() };
}

// ---------------------------------------------------------------------------
// 场景 B：同 ID 重复提交（并发两条同 identity，真 IPC）
// ---------------------------------------------------------------------------
async function scenarioDup(call, fx, mock) {
  void fx;
  const proxy = await setProxy(call, true);
  check("代理已启动", proxy.running === true, proxy);
  const { seedRunId, messages } = await prepareMessagesDraft(call, mock);
  const epoch = await waitEpoch(call);
  const operationId = `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(12, "0")}`;
  const request = { parentRunId: seedRunId, atSpanId: "s_02", messages };
  const filesBefore = H.traceIds().size;
  const servedBefore = mock.served();

  const [a, b] = await Promise.all([
    proxyForkWithIdentity(call, epoch, operationId, request),
    proxyForkWithIdentity(call, epoch, operationId, request),
  ]);
  dump.pair = [a, b];
  check(
    "并发同 ID：一条被接受并返回真实 fork 身份",
    a.ok === true && typeof a.data?.id === "string",
    a.ok ? a.data : a.error,
  );
  check(
    "并发同 ID：另一条明确未重复执行（OPERATION_DUPLICATED）",
    b.ok === false && b.error?.code === "OPERATION_DUPLICATED",
    b.ok ? b.data : b.error,
  );
  check(
    "两条响应指向同一登记身份与同一终态",
    a.operation?.operationId === operationId &&
      b.operation?.operationId === operationId &&
      a.operation?.state === b.operation?.state,
    { a: a.operation, b: b.operation },
  );
  check("受控服务只多 1 次请求（被动 seed 之外没有二次重发）", mock.served() === servedBefore + 1, {
    servedBefore,
    now: mock.served(),
  });
  check("traces 只多 1 份文件", H.traceIds().size === filesBefore + 1, {
    before: filesBefore,
    after: H.traceIds().size,
  });
  const after = await recordOf(call, operationId);
  check(
    "登记 settled 且 runIds 恰 1（就是那条 fork）",
    after.rec?.state === "settled" &&
      after.rec.runIds.length === 1 &&
      after.rec.runIds[0] === a.data?.id,
    after.rec,
  );

  // settled 后同 ID 再提交：仍不重新执行
  const again = await proxyForkWithIdentity(call, epoch, operationId, request);
  check(
    "settled 后同 ID 再提交仍不产生新请求",
    again.ok === false &&
      again.error?.code === "OPERATION_DUPLICATED" &&
      mock.served() === servedBefore + 1,
    again.ok ? again.data : again.error,
  );

  // 同 ID 异参：拒绝且不改原登记
  const conflict = await proxyForkWithIdentity(call, epoch, operationId, {
    ...request,
    messages: messages.map((m) => ({ ...m, content: `${m.content}-改了` })),
  });
  check(
    "同 ID 异参被拒（OPERATION_CONFLICT）且原登记未改写",
    conflict.ok === false && conflict.error?.code === "OPERATION_CONFLICT",
    conflict.ok ? conflict.data : conflict.error,
  );
  const last = await recordOf(call, operationId);
  check(
    "异参请求没改动 runIds 与终态",
    last.rec?.state === "settled" && last.rec.runIds.join() === a.data?.id,
    last.rec,
  );
  check("异参同样零新增请求", mock.served() === servedBefore + 1, mock.served());
  await H.shot(call, SHOT_DIR, "63-dup.png");
  return { seedRunId, forkId: a.data?.id ?? null, operationId, served: mock.served() };
}

// ---------------------------------------------------------------------------
// 场景 C：无 key —— main 独立复核（渲染层禁用不是安全边界）
// ---------------------------------------------------------------------------
async function scenarioNokey(call, fx, mock) {
  void fx;
  const proxy = await setProxy(call, true);
  check("代理已启动并录制会话", proxy.running === true, proxy);
  const { seedRunId, messages, draftText } = await prepareMessagesDraft(call, mock);
  const servedBefore = mock.served();
  const filesBefore = H.traceIds().size;

  // 关代理 ⇒ 会话内 key 失效
  await setProxy(call, false);
  await H.sleep(600);
  const epoch = await waitEpoch(call);
  const operationId = `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(12, "0")}`;
  const res = await proxyForkWithIdentity(call, epoch, operationId, {
    parentRunId: seedRunId,
    atSpanId: "s_02",
    messages,
  });
  dump.nokey = res;
  check(
    "PROXY_NO_KEY 在 main 被独立复核拒绝（越过 UI 真 IPC）",
    res.ok === false && res.error?.code === "PROXY_NO_KEY",
    res.ok ? res.data : res.error,
  );
  check(
    "拒绝也带可信回执（不是裸 ok:false）",
    res.operation?.operationId === operationId && res.operation?.state === "settled",
    res.operation,
  );
  const rec = (await recordOf(call, operationId)).rec;
  check(
    "登记终态 settled + 稳定拒绝码",
    rec?.state === "settled" &&
      rec?.errorCode === "PROXY_NO_KEY" &&
      rec?.requestOutcome === "rejected",
    { state: rec?.state, code: rec?.errorCode, outcome: rec?.requestOutcome },
  );
  check(
    "接受后拒绝 ⇒ runIds 为空（未产生运行时身份）",
    Array.isArray(rec?.runIds) && rec.runIds.length === 0,
    rec?.runIds,
  );
  check(
    "零模型请求、零新文件",
    mock.served() === servedBefore && H.traceIds().size === filesBefore,
    { served: mock.served(), files: H.traceIds().size },
  );
  check(
    "草稿逐字保留（拒绝不清输入）",
    (await H.drafts(call)).calls?.[seedRunId]?.s_02?.messages?.text === draftText,
  );
  const still = await recordOf(call, operationId);
  check("拒绝后槽已释放（下一次提交可正常开放）", still.slot !== operationId, still.slot);
  await H.shot(call, SHOT_DIR, "63-nokey.png");
  return { seedRunId, operationId, code: rec?.errorCode ?? null };
}

// ---------------------------------------------------------------------------
// 场景 D：录制写入失败 ⇒ 不借用别的 run id 冒充成功
// ---------------------------------------------------------------------------
async function scenarioWriteFail(call, fx, mock) {
  void fx;
  const proxy = await setProxy(call, true);
  check("代理已启动（先正常录出父本，再进写入失败窗口）", proxy.running === true, proxy);
  const TRACES = H.TRACES;
  const MOVED = `${TRACES}.u463-hidden`;
  const { seedRunId, messages, draftText } = await prepareMessagesDraft(call, mock);
  const epoch = await waitEpoch(call);
  const operationId = `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(12, "0")}`;
  const filesBefore = readdirSync(TRACES).length;
  const servedBefore = mock.served();
  // ⚠️ 窗口位置就是这支判据的命门：代理 fork 的顺序是「读父 run → 转发 upstream → 录制写盘」。
  // 在请求发出前把目录改走，只会命中 PROXY_PARENT_INVALID（读父失败，本轮第一版就是这么误判的），
  // 永远测不到「录制写入失败不借用别的 id」。⇒ 先起请求（该回合 delayMs 6s），
  // 等父 run 读完、请求确实在飞，再把目录同卷改名走。
  const pending = fireProxyFork(call, epoch, operationId, {
    parentRunId: seedRunId,
    atSpanId: "s_02",
    messages,
  });
  await H.sleep(900);
  const during = await recordOf(call, operationId);
  check(
    "改名前请求已在飞（登记 running 且占槽），窗口位置成立",
    during.rec?.state === "running" && during.slot === operationId,
    {
      state: during.rec?.state,
      slot: during.slot,
    },
  );
  renameSync(TRACES, MOVED);
  let res = null;
  try {
    const r = await pending;
    res = JSON.parse(r?.result?.value ?? "{}");
  } finally {
    // 无条件还原：还原后再核对文件数
    if (!existsSync(TRACES) && existsSync(MOVED)) renameSync(MOVED, TRACES);
  }
  dump.writeFail = res;
  const filesAfter = readdirSync(TRACES).length;
  check("数据目录已还原（同卷 rename，一份不丢）", filesAfter === filesBefore, {
    filesBefore,
    filesAfter,
  });
  check(
    "录制写入失败返回明确稳定码（不冒充成功）",
    res?.ok === false && res?.error?.code === "PROXY_RECORDING_WRITE_FAILED",
    res?.ok ? res.data : res?.error,
  );
  const rec = (await recordOf(call, operationId)).rec;
  // 分类口径（实测坐实，exec-endpoints.ts:66 + toRunResult）：**带稳定领域码 ⇒ `rejected`，
  // 未预期异常 ⇒ `failed`**。录制写失败有码（PROXY_RECORDING_WRITE_FAILED）⇒ 归 `rejected`。
  // 「已经执行、只是录制没落盘」算不算"拒绝"是一条口径观察，已记进 README，不在实机批里静默改产品。
  check(
    "失败仍登记可信终态（settled + 同一身份回执 + 有稳定码归 rejected）",
    rec?.state === "settled" &&
      rec?.errorCode === "PROXY_RECORDING_WRITE_FAILED" &&
      rec?.requestOutcome === "rejected",
    { state: rec?.state, code: rec?.errorCode, outcome: rec?.requestOutcome },
  );
  check(
    "写入失败 ⇒ runIds 为空（**绝不借用别的 run id**）",
    Array.isArray(rec?.runIds) && rec.runIds.length === 0,
    rec?.runIds,
  );
  check("请求确实打到过 upstream（响应已转发后才失败）", mock.served() === servedBefore + 1, {
    servedBefore,
    now: mock.served(),
  });
  // 不二次录制：还原后再走一次被动请求，结果正常且只多一份
  await setProxy(call, true);
  const afterRestore = await proxyChat(
    `U4-63 还原后被动 ${Math.random().toString(36).slice(2, 6)}`,
  );
  const filesNew = readdirSync(TRACES).length;
  check(
    "还原后被动录制正常落盘且不受影响（+1 份）",
    afterRestore.status === 200 && filesNew === filesAfter + 1,
    { status: afterRestore.status, filesAfter, filesNew },
  );
  check("失败那一次没有留下半成品文件", filesAfter === filesBefore, { filesBefore, filesAfter });
  check(
    "草稿保留（失败不清输入）",
    (await H.drafts(call)).calls?.[seedRunId]?.s_02?.messages?.text === draftText,
  );
  await H.shot(call, SHOT_DIR, "63-write-fail.png");
  return {
    seedRunId,
    operationId,
    code: rec?.errorCode ?? null,
    filesBefore,
    filesAfter,
    filesNew,
  };
}

// ---------------------------------------------------------------------------
// 场景 E：被动录制不占主动槽（外部请求在飞时仍可主动提交）
// ---------------------------------------------------------------------------
async function scenarioPassiveNoSlot(call, fx, mock) {
  void fx;
  const proxy = await setProxy(call, true);
  check("代理已启动", proxy.running === true, proxy);
  const { seedRunId, messages } = await prepareMessagesDraft(call, mock);
  const epoch = await waitEpoch(call);
  const opsBefore = ((await opsStatus(call))?.data?.operations ?? []).length;

  // 外部请求在飞（受控服务该回合 delayMs 6s）——它**不是**主动操作，不该占槽
  const external = proxyChat(`U4-63 被动在飞 ${Math.random().toString(36).slice(2, 6)}`);
  await H.sleep(400);
  const slotDuringPassive = (await opsStatus(call))?.data?.activeOperationId ?? null;
  check("被动录制在飞时 main 执行槽仍空闲", slotDuringPassive === null, slotDuringPassive);

  const operationId = `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(12, "0")}`;
  const fork = await proxyForkWithIdentity(call, epoch, operationId, {
    parentRunId: seedRunId,
    atSpanId: "s_02",
    messages,
  });
  check(
    "被动录制期间主动重发被接受（外部流量不构成执行中）",
    fork.ok === true && typeof fork.data?.id === "string",
    fork.ok ? fork.data : fork.error,
  );
  const rec = (await recordOf(call, operationId)).rec;
  check(
    "主动登记与被动录制互不串号（runIds 只含本次 fork）",
    rec?.state === "settled" && rec.runIds.length === 1 && rec.runIds[0] === fork.data?.id,
    rec?.runIds,
  );

  const ext = await external;
  check("在飞的外部请求正常返回（被动录制不受主动操作影响）", ext.status === 200, ext);
  const statusAfter = await opsStatus(call);
  const opsAfter = statusAfter?.data?.operations ?? [];
  check(
    "被动录制不产生任何登记条目（登记数只增加了我们那一次主动提交）",
    opsAfter.length === opsBefore + 1,
    { opsBefore, opsAfter: opsAfter.length, ids: opsAfter.map((o) => o.operationId) },
  );
  check(
    "只读入口在外部流量期间始终可用（status 返回当前 epoch）",
    statusAfter?.data?.epoch === epoch,
    statusAfter?.data?.epoch,
  );
  await H.shot(call, SHOT_DIR, "63-passive-no-slot.png");
  return {
    seedRunId,
    forkId: fork.data?.id ?? null,
    operationId,
    opsBefore,
    opsAfter: opsAfter.length,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
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
  const filesReady = [...H.traceIds()].length;
  console.log(`冷重载完成：运行列表 ${(await H.runs(call)).length} 项，traces ${filesReady} 份`);

  // 交错场景需要在飞窗口 ⇒ 回合 2 给延迟；其余用快回合
  const scripts = {
    interleave: {
      turns: [{ content: "seed" }, SLOW_TURN, { content: "被动" }, { content: "重发" }],
      fallback: { content: "兜底" },
    },
    dup: { turns: [{ content: "seed" }, SLOW_TURN, SLOW_TURN], fallback: { content: "兜底" } },
    nokey: { turns: [{ content: "seed" }], fallback: { content: "兜底" } },
    "write-fail": { turns: [{ content: "seed" }, SLOW_TURN], fallback: { content: "兜底" } },
    "passive-no-slot": {
      turns: [{ content: "seed" }, SLOW_TURN, SLOW_TURN],
      fallback: { content: "兜底" },
    },
  };
  const mock = await H.prepare(call, scripts[TAG]);
  const scenarios = {
    interleave: () => scenarioInterleave(call, {}, mock),
    dup: () => scenarioDup(call, {}, mock),
    nokey: () => scenarioNokey(call, {}, mock),
    "write-fail": () => scenarioWriteFail(call, {}, mock),
    "passive-no-slot": () => scenarioPassiveNoSlot(call, {}, mock),
  };
  let out = null;
  let failure = null;
  try {
    out = await scenarios[TAG]();
  } catch (e) {
    failure = String(e?.stack ?? e);
    check("场景未抛异常", false, failure);
  } finally {
    try {
      await setProxy(call, false);
    } catch {
      /* 尽力而为 */
    }
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
