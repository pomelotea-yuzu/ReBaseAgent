/* eslint-disable */
/**
 * U5 任务 6.3（第二批受控实机）：普通/隔离 result 成功/失败、离开再返回、读取途中导航。
 *
 * 覆盖 evidence-index「实机入口 = 6.3」各计划 tag：
 * result-check / result-plain-boundary / result-isolated-boundary / confirm-return /
 * envelope-ok-run-error / leaf-only-failure / navigate-in-flow / leave-and-return /
 * nav-during-read / unmount-keeps-snapshot / response-keeps-draft / resubmit-same-rev。
 *
 * 判据口径（与 6.2 同纪律）：
 * - 期望调用数 / 期望自有终止事件从 `fixtureOf(剧本)` 或组合剧本读出；
 * - 结局只按落盘 run.event 判（成功信封不冒充运行结局）；
 * - 渲染层核实事实读 `resultReads.byKey`（键 epoch|operationId|runId，epoch 取 main 当前值）；
 * - 导航意图的判定 = 用户动作是否推进阅读代次（切页签/切运行都推进）⇒ 落地后是否抢焦点；
 * - 父本夹具：U3 6.1 manifest 的 normalRun / isoRoot（真引擎产出，仍在盘上）。
 *
 * 用法：`node apps/desktop/scripts/u5-63-cdp.cjs --tag=<TAG>`
 * 前置：dev 已由 run-all 起（CDP 9612）。
 */
"use strict";
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { fixtureOf } = require("./lib/u5-sse-fixtures.cjs");

const TAGS = [
  "result-check",
  "result-plain-boundary",
  "result-isolated-boundary",
  "confirm-return",
  "envelope-ok-run-error",
  "leaf-only-failure",
  "navigate-in-flow",
  "leave-and-return",
  "nav-during-read",
  "unmount-keeps-snapshot",
  "response-keeps-draft",
  "resubmit-same-rev",
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

const OUT_DIR = join(H.REPO, ".workbuddy", "u5", "u5-63");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-28-u5-63");
const MARK = "U5-63";
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
if (!existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
const FX = JSON.parse(readFileSync(MANIFEST, "utf8"));

/** 各 tag 的组合剧本（turns 顺序消费，耗尽后走 fallback） */
const OK_TURN = { content: `${MARK} 受控成功：一步答完。` };
const FAIL503_TURN = {
  mode: "fail",
  status: 503,
  content: "upstream unavailable",
  delayMs: 1200,
};
const TAG_SCRIPT = {
  "result-check": { turns: [OK_TURN], fallback: OK_TURN },
  "result-plain-boundary": { turns: [OK_TURN], fallback: OK_TURN },
  "result-isolated-boundary": { turns: [OK_TURN], fallback: OK_TURN },
  "confirm-return": { turns: [OK_TURN], fallback: OK_TURN },
  "envelope-ok-run-error": { turns: [FAIL503_TURN], fallback: OK_TURN },
  // call1 = 失败父本（fail503），call2+ = 成功子 run（fallback）
  "leaf-only-failure": { turns: [FAIL503_TURN], fallback: OK_TURN },
  "navigate-in-flow": { turns: [], fallback: OK_TURN },
  "leave-and-return": fixtureOf("delayedInFlight").script,
  "nav-during-read": fixtureOf("delayedInFlight").script,
  "unmount-keeps-snapshot": fixtureOf("delayedInFlight").script,
  // call1 = 失败子 run（error ⇒ 草稿永久保留），call2 = 成功子 run（正常终止 ⇒ 清理）
  "response-keeps-draft": { turns: [FAIL503_TURN], fallback: OK_TURN },
  // call1 = 失败子 run（error settle，草稿保留在同修订），call2 = 同修订重发（延迟成功，留出核对窗口）
  "resubmit-same-rev": {
    turns: [FAIL503_TURN, { ...OK_TURN, delayMs: 6000 }],
    fallback: OK_TURN,
  },
};

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
    fixtures: { normalRun: FX.normalRun, isoRoot: FX.isoRoot },
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
// 读数（真 store / 真 IPC / 真落盘）
// ---------------------------------------------------------------------------

const opsStatus = (call) => H.apiCall(call, "operationsStatus");
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  const rec = (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null;
  return { rec, slot: st?.data?.activeOperationId ?? null, epoch: st?.data?.epoch ?? null };
};
/** 渲染层核实表（U5 1.2/1.3） */
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
/** 阅读现场 + 导航代次 */
const readingState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({ view: s.view, selectedRunId: s.selectedRunId,
       selectedSpanId: s.selectedSpanId, navGeneration: s.navGeneration });`,
  );
/** 调用草稿（result 通道） */
const callDraftText = async (call, runId, spanId, field) => {
  const d = await H.drafts(call);
  return d?.calls?.[runId]?.[spanId]?.[field]?.text ?? null;
};
/** 落盘 run 的自有终止事实 */
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
    firstLlmError: llms.length > 0 ? (llms[0].error ?? null) : null,
    event: last?.type === "run.event" ? last.event : null,
    reason: last?.type === "run.event" ? last.reason : null,
  };
}

// ---------------------------------------------------------------------------
// 页内动作
// ---------------------------------------------------------------------------

/** 打开普通 result 编辑器（时间旅行），返回编辑器在场 */
async function openPlainResultEditor(call, runId, spanId, spanTitle = "read_file") {
  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, spanTitle, spanId);
  // fork 入口随详情渲染就绪出现（errored run 的详情装载更慢）⇒ 轮询等待再点
  const forkReadyExpr =
    "(() => { const b = Array.from(document.querySelectorAll('button'))" +
    ".find(x => ((x.textContent||'').trim()) === '在此重跑（时间旅行）');" +
    "return b == null ? 'no' : (b.disabled ? 'disabled' : 'ready'); })()";
  const deadline = Date.now() + 12000;
  for (;;) {
    const present = await H.ev(call, forkReadyExpr);
    if (present === "ready") break;
    if (Date.now() > deadline) throw new Error(`fork 入口 12s 未就绪：${present}`);
    await H.sleep(500);
  }
  await H.clickByTextChecked(call, "在此重跑（时间旅行）", 800);
}
/** 打开隔离 result 编辑器 */
async function openIsolatedResultEditor(call, runId, spanId) {
  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", spanId);
  await H.clickByTextChecked(call, "在此重跑（隔离续跑）", 1500);
}
/** 当前可见的确认按钮（DetailPanel 四处 + 创建页一处，取可见者） */
const visibleConfirmExpr = `(() => {
  const all = Array.from(document.querySelectorAll('[data-confirm-execution]'));
  return all.find(b => b.offsetParent !== null) ?? null;
})()`;
async function confirmEditor(call) {
  const before = await H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      if (!b) return JSON.stringify({ error: 'no-visible-confirm' });
      return JSON.stringify({ disabled: b.disabled, pressed: b.getAttribute('aria-pressed'),
                              text: (b.textContent||'').trim() }); })()`,
  );
  const parsed = JSON.parse(before);
  if (parsed.error) throw new Error(`确认按钮缺失：${parsed.error}`);
  if (parsed.disabled !== false) throw new Error(`确认按钮不可点：${JSON.stringify(parsed)}`);
  await H.ev(call, `(() => { ${visibleConfirmExpr}.click(); return true; })()`);
  await H.sleep(500);
  const after = await H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      return b === null ? null : { pressed: b.getAttribute('aria-pressed'),
                                   text: (b.textContent||'').trim() }; })()`,
  );
  if (after?.pressed !== "true")
    throw new Error(`点确认后 aria-pressed=${after?.pressed}（text=${after?.text}）`);
  return after;
}
async function confirmState(call) {
  return H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      return b === null ? null : { disabled: b.disabled, pressed: b.getAttribute('aria-pressed'),
                                   text: (b.textContent||'').trim() }; })()`,
  );
}
/** 点提交并在页内同帧捕获本次关联（毫秒级响应会扑空） */
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
        const anyVisible = Array.from(document.querySelectorAll('button'))
          .filter(x => x.offsetParent !== null)
          .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
        return JSON.stringify({ error: anyVisible ? 'button-disabled' : 'button-not-found' });
      }
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
/** 等待收口：待定关联消失 + forking 离开 in_progress */
async function waitForForkSettled(call, key, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sub = await H.submissions(call);
    const st = await H.execState(call);
    const stillPending = sub.ids.some((x) => x.id === key);
    if (!stillPending && st.forking !== "in_progress") return { st, sub };
    if (Date.now() > deadline) return { st, sub, timedOut: true };
    await H.sleep(500);
  }
}
/** 操作面板某行的动作按钮集合 */
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
/** 共用流程：打开普通 result 编辑器 → 键入 → 确认 → 提交并捕获 */
async function forkFlow(
  call,
  { runId, spanId, text, key, duringFlight = null, isolated = false, spanTitle },
) {
  if (isolated) await openIsolatedResultEditor(call, runId, spanId);
  else await openPlainResultEditor(call, runId, spanId, spanTitle);
  await H.typeIntoEditableMonaco(call, text);
  const draftText = await callDraftText(call, runId, spanId, "result");
  if (draftText === null || !draftText.includes(text.slice(-8)))
    throw new Error(`草稿未入 store：${String(draftText).slice(0, 60)}`);
  await confirmEditor(call);
  const sub = await submitAndCapture(call, "确认重跑", key, { duringFlight });
  return { sub, draftText };
}

// ---------------------------------------------------------------------------
// 各 tag
// ---------------------------------------------------------------------------

const FLOWS = {
  /** A1.1「创建和普通重跑只声明已完成的检查」的 result 半边（剧本=successPlain，不提交） */
  "result-check": async (call, mock) => {
    await openPlainResultEditor(call, FX.normalRun, "s_03");
    const text = `${MARK} result-check 披露核对`;
    await H.typeIntoEditableMonaco(call, text);
    const body = await H.ev(call, "(() => document.body.innerText)()");
    check(
      "普通 result 的边界明说「世界不隔离」且后续工具真副作用",
      body.includes("世界不隔离：这是普通 replay 续跑") && body.includes("会真的执行"),
      null,
    );
    check(
      "明说没有独立续跑预检接口（隔离路径才有）",
      body.includes("没有独立的续跑条件预检接口（隔离路径才有）"),
      null,
    );
    check(
      "「已做的检查」只有本地字段检查（不联网、不调用模型）",
      body.includes("本地字段检查：必填项、模式与授权条件（不联网、不调用模型）"),
      null,
    );
    check("确认行不冒充隔离话术（无「轮末检查点」）", !body.includes("轮末检查点"), null);
    await confirmEditor(call);
    check("零模型调用（本 tag 不提交）", mock.served() === 0, mock.served());
  },

  /** A1.2「普通结果与隔离结果确认边界不同」的普通半边 */
  "result-plain-boundary": async (call, mock) => {
    await openPlainResultEditor(call, FX.normalRun, "s_03");
    await H.typeIntoEditableMonaco(call, `${MARK} plain-boundary 文本`);
    const body = await H.ev(call, "(() => document.body.innerText)()");
    check("普通侧：有「世界不隔离」", body.includes("世界不隔离"), null);
    check(
      "普通侧：无隔离专属话术（无「轮末检查点」、无「只读预检」）",
      !body.includes("轮末检查点") && !body.includes("只读预检"),
      null,
    );
    check(
      "普通侧：父运行不被修改、产出是新 run 的边界在场",
      body.includes("父运行与其后的步骤不会被修改") && body.includes("新 run"),
      null,
    );
    await confirmEditor(call);
    check("零模型调用（本 tag 不提交）", mock.served() === 0, mock.served());
  },

  /** A1.2「普通结果与隔离结果确认边界不同」的隔离半边 */
  "result-isolated-boundary": async (call, mock) => {
    await openIsolatedResultEditor(call, FX.isoRoot, "s_03");
    await H.typeIntoEditableMonaco(call, `${MARK} isolated-boundary 文本`);
    let body = await H.ev(call, "(() => document.body.innerText)()");
    check(
      "隔离侧：预检缺席时不冒充（说明缺的是什么）",
      body.includes("尚未取得只读预检结论") || !body.includes("只读预检 `runs:forkCapability`"),
      null,
    );
    // 只读预检（不占槽、零模型）
    await H.clickByTextChecked(call, "校验续跑条件", 2500);
    const deadline = Date.now() + 15000;
    for (;;) {
      body = await H.ev(call, "(() => document.body.innerText)()");
      if (body.includes("轮末检查点") || Date.now() > deadline) break;
      await H.sleep(400);
    }
    check("隔离侧：预检后「轮末检查点」进事实", body.includes("轮末检查点"), null);
    check(
      "隔离侧：披露只读预检（不创建运行、不写文件、不请求模型）",
      body.includes("只读预检") && body.includes("不创建运行、不写文件、不请求模型"),
      null,
    );
    check("隔离侧：不借用普通话术（无「世界不隔离」）", !body.includes("世界不隔离"), null);
    check(
      "预检不占执行槽（只读入口不登记）",
      (await opsStatus(call))?.data?.activeOperationId === null,
      null,
    );
    check("零模型调用（预检是只读的）", mock.served() === 0, mock.served());
  },

  /** A1.5「返回修改与设置往返撤销旧确认」的 6.3 半边（改输入 = 返回修改） */
  "confirm-return": async (call, mock) => {
    await openPlainResultEditor(call, FX.normalRun, "s_03");
    await H.typeIntoEditableMonaco(call, `${MARK} confirm-return 第一版`);
    const armed = await confirmEditor(call);
    check("确认可挂上", armed.pressed === "true", armed);
    // 返回修改：再编辑一次 ⇒ 修订推进 ⇒ 旧确认作废
    await H.typeIntoEditableMonaco(call, "（第二版追加）");
    await H.sleep(400);
    const st = await confirmState(call);
    check(
      "改输入 ⇒ 旧确认作废（回到未确认态）",
      st?.pressed !== "true" && st?.text === "已核对，确认本次重跑",
      st,
    );
    const submitBtn = await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '确认重跑');
      return b === null ? null : { disabled: b.disabled }; })()`,
    );
    check("旧确认作废后提交重新禁用", submitBtn?.disabled === true, submitBtn);
    // 重新确认 ⇒ 又可提交（确认是一次性凭据，不是一次性锁死）
    await confirmEditor(call);
    const submitBtn2 = await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '确认重跑');
      return b === null ? null : { disabled: b.disabled }; })()`,
    );
    check("重新确认后提交恢复可用", submitBtn2?.disabled === false, submitBtn2);
    check("零模型调用（本 tag 不提交）", mock.served() === 0, mock.served());
  },

  /** A3.1「成功信封但运行错误」（剧本=fail503）：信封 ok，结局按登记 ID 读出自有 error */
  "envelope-ok-run-error": async (call, mock) => {
    const runId = FX.normalRun;
    const key = `${runId}|s_03|result`;
    const before = H.traceIds();
    const text = `${MARK} envelope-ok-run-error`;
    const { sub } = await forkFlow(call, { runId, spanId: "s_03", text, key });
    check(
      "信封 ok ⇒ 请求正常返回（无本地错误码）",
      typeof sub.operationId === "string" && sub.channel === "result",
      sub,
    );
    const settled = await waitForForkSettled(call, key);
    check(
      "响应收口：解冻 + forking 回 idle（信封 ok 不等于运行成功）",
      settled.st.forking === "idle" && settled.st.forkErrorCode === null,
      settled.st,
    );
    const added = await H.newChildren(before, 30000, 1);
    check("落盘恰 1 份新 trace（子 run）", added.length === 1, added);
    const id = added[0];
    const facts = traceFacts(id);
    const fx = fixtureOf("fail503");
    check(
      `子 run 自有终止 = ${fx.expectedEvent}/${fx.expectedReason}（信封 ok 不改这一事实）`,
      facts.event === fx.expectedEvent && facts.reason === fx.expectedReason,
      { event: facts.event, reason: facts.reason },
    );
    check(
      `失败详情带 status=${fx.expectedErrorStatus}`,
      facts.firstLlmError?.status === fx.expectedErrorStatus,
      facts.firstLlmError,
    );
    const reg = await recordOf(call, sub.operationId);
    check("main 登记 runIds = 落盘 meta.id", reg.rec?.runIds?.[0] === id, {
      runIds: reg.rec?.runIds,
      id,
    });
    const entry = await waitForVerified(call, reg.epoch, sub.operationId, id);
    check(
      "核实落地（phase=verified，结局由自有事实说话）",
      entry?.phase === "verified",
      entry?.phase,
    );
    const nav = await readingState(call);
    check(
      "留在流程内 ⇒ 失败结局同样进入登记那条（不以打开冒充成功）",
      nav.selectedRunId === id,
      nav,
    );
    const row = await rowActions(call, sub.operationId);
    check(
      "失败行给「打开结果」与「查看失败调用」（自有失败在场）",
      row.found === true && row.btns.includes("打开结果") && row.btns.includes("查看失败调用"),
      row.btns,
    );
    check(
      "失败 ⇒ 草稿保留（结局非正常，不清理）",
      (await callDraftText(call, runId, "s_03", "result")) === sub.text,
      null,
    );
    await H.shot(call, SHOT_DIR, `${TAG}-failed-child.png`);
  },

  /** A3.4「祖先结束与失败调用不能冒充本次事实」（fail503 父本 + 成功子 run） */
  "leaf-only-failure": async (call, mock) => {
    // call1：直接 IPC 造一份 fail503 父本。⚠️ 实机契约（6.2 create-503 同形）：
    // 模型失败 ⇒ 信封 CREATE_RUN_FAILED（不是 ok），但 run 已落盘且登记仍带 runIds
    // ——这正是 A3.2「失败信封仍可打开可信记录」的形状。
    const tracesBefore = H.traceIds();
    const epochNow = (await opsStatus(call))?.data?.epoch ?? null;
    const parentOpId = globalThis.crypto.randomUUID();
    const parentEnv = await H.appImport(
      call,
      H.STORE_NEEDLE,
      `return JSON.stringify(await window.api.createRun({
         operation: { epoch: ${JSON.stringify(epochNow)}, operationId: ${JSON.stringify(parentOpId)} },
         request: { systemPrompt: "", userMessage: "${MARK} leaf-only 失败父本" },
       }));`,
    );
    check(
      "失败父本：信封 CREATE_RUN_FAILED（失败信封，不是 ok）",
      parentEnv?.ok === false && parentEnv?.error?.code === "CREATE_RUN_FAILED",
      parentEnv?.error ?? null,
    );
    const regP = await recordOf(call, parentOpId);
    const parentId = regP.rec?.runIds?.[0] ?? null;
    check("失败信封的登记仍带真实 runId（可信记录可打开）", typeof parentId === "string", {
      runIds: regP.rec?.runIds,
    });
    if (parentId === null) throw new Error("父本创建失败，无法继续 leaf-only 场景");
    // 直调 IPC 不走 store 消费 ⇒ 列表不会自动刷新，手动刷一次让 selectRun 找得到父本
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ ok: true });");
    await H.sleep(600);
    const deadline0 = Date.now() + 30000;
    let parentFacts = null;
    for (;;) {
      if (existsSync(join(H.TRACES, `${parentId}.jsonl`))) {
        parentFacts = traceFacts(parentId);
        if (parentFacts.event !== null) break;
      }
      if (Date.now() > deadline0) break;
      await H.sleep(500);
    }
    check(
      "父本以 errored/error 终止且 llm.call 自带 error",
      parentFacts?.event === "errored" &&
        parentFacts?.reason === "error" &&
        parentFacts?.firstLlmError?.status === 503,
      parentFacts && { event: parentFacts.event, err: parentFacts.firstLlmError?.status },
    );
    // 在父本的失败 LLM span 上做 prompt fork（llm span 没有 result 入口——
    // 那是工具结果 span 专属；llm span 的 fork 入口是「编辑初始 user message 重跑」）
    const spanId = parentFacts.llmSpanId;
    const key = `${parentId}|${spanId}|user_message`;
    const before = H.traceIds();
    const text = `${MARK} leaf-only 成功子 run`;
    await H.selectRun(call, parentId);
    await H.clickTabChecked(call, "步骤");
    await H.clickSpan(call, "LLM 调用", spanId);
    await H.clickByTextChecked(call, "编辑初始 user message 重跑", 1200);
    await H.typeIntoEditableMonaco(call, text);
    await confirmEditor(call);
    const sub = await submitAndCapture(call, "确认从头重跑", key);
    check(
      "prompt fork 提交（捕获或落盘二选一为证；fallback 毫秒级返回可能扑空）",
      (sub.channel === "prompt" && typeof sub.operationId === "string") || sub.none === true,
      { channel: sub.channel ?? null, none: sub.none ?? null },
    );
    const settled = await waitForForkSettled(call, key);
    check("子 run 请求收口", settled.st.forking === "idle", settled.st);
    const added = await H.newChildren(before, 30000, 1);
    check("落盘恰 1 份新 trace（子 run）", added.length === 1, added);
    const childId = added[0];
    const childFacts = traceFacts(childId);
    check(
      "子 run 自有终止 = stopped/completed（祖先失败不影响本次结局）",
      childFacts.event === "stopped" && childFacts.reason === "completed",
      { event: childFacts.event, reason: childFacts.reason },
    );
    // operationId 从登记表反查（runIds 含子 run 的那条登记）
    const st0 = await opsStatus(call);
    const rec = (st0?.data?.operations ?? []).find((o) => (o.runIds ?? []).includes(childId));
    const operationId = sub.operationId ?? rec?.operationId ?? null;
    check("登记表反查到本次操作的 operationId", typeof operationId === "string", {
      operationId,
      captured: sub.operationId ?? null,
    });
    const reg = await recordOf(call, operationId);
    const entry = await waitForVerified(call, reg.epoch, operationId, childId);
    check("核实落地（成功结局）", entry?.phase === "verified", entry?.phase);
    const row = await rowActions(call, operationId);
    const btns = row.btns ?? [];
    check("子 run 行有「打开结果」", row.found === true && btns.includes("打开结果"), btns);
    check(
      "自有无失败详情 ⇒ 不给「查看失败调用」（不从祖先的失败调用凑数）",
      !btns.includes("查看失败调用"),
      btns,
    );
    check(
      "行内给诚实说明（不以祖先冒充）",
      row.found === true &&
        (row.text.includes("失败") || row.text.includes("终止") || row.text.includes("自有")),
      (row.text ?? "").slice(0, 200),
    );
  },

  /** A5.1「留在当前流程可进入成功或失败概览」的 6.3 半边（result 成功支） */
  "navigate-in-flow": async (call, mock) => {
    const runId = FX.normalRun;
    const key = `${runId}|s_03|result`;
    const before = H.traceIds();
    const text = `${MARK} navigate-in-flow 成功子 run`;
    const { sub } = await forkFlow(call, { runId, spanId: "s_03", text, key });
    const settled = await waitForForkSettled(call, key);
    check("请求收口", settled.st.forking === "idle", settled.st);
    const added = await H.newChildren(before, 30000, 1);
    check("落盘恰 1 份新 trace", added.length === 1, added);
    const id = added[0];
    const reg = await recordOf(call, sub.operationId);
    const entry = await waitForVerified(call, reg.epoch, sub.operationId, id);
    check("核实落地", entry?.phase === "verified", entry?.phase);
    const nav = await readingState(call);
    check(
      "留在流程内 ⇒ 自动导航进入登记的那条（成功支；6.2 已证失败支）",
      nav.selectedRunId === id,
      nav,
    );
  },

  /** A5.2「离开再返回不恢复旧自动导航」（剧本=delayedInFlight） */
  "leave-and-return": async (call, mock) => {
    const runId = FX.normalRun;
    const key = `${runId}|s_03|result`;
    const before = H.traceIds();
    const text = `${MARK} leave-and-return`;
    const { sub } = await forkFlow(call, { runId, spanId: "s_03", text, key });
    check("提交在飞", typeof sub.operationId === "string", sub);
    // 切走再切回：两次 selectRun 都推进阅读代次 ⇒ 意图作废
    const others = (await H.runs(call)).filter((r) => r !== runId);
    await H.selectRun(call, others[0]);
    await H.selectRun(call, runId);
    const back = await readingState(call);
    check("已切回原 run", back.selectedRunId === runId, back);
    const settled = await waitForForkSettled(call, key, 60000);
    check("请求收口", settled.st.forking === "idle", settled.st);
    const added = await H.newChildren(before, 30000, 1);
    const id = added[0] ?? null;
    const reg = await recordOf(call, sub.operationId);
    const entry = await waitForVerified(call, reg.epoch, sub.operationId, id);
    check("结果照样核实到（离开不丢核实）", entry?.phase === "verified", entry?.phase);
    const nav = await readingState(call);
    check("结果到达也不跳（仍停在用户切回的原 run）", nav.selectedRunId === runId, nav);
  },

  /** A5.3「读取途中离页仍不抢焦点」（剧本=delayedInFlight；页内竞速捕获 reading 窗口） */
  "nav-during-read": async (call, mock) => {
    const runId = FX.normalRun;
    const key = `${runId}|s_03|result`;
    const before = H.traceIds();
    const text = `${MARK} nav-during-read`;
    const { sub } = await forkFlow(call, { runId, spanId: "s_03", text, key });
    const others = (await H.runs(call)).filter((r) => r !== runId);
    const otherId = others[0];
    // 详情读取在飞（phase=reading）的窗口只有一次 IPC 往返 ⇒ 用页内同帧竞速：
    // 轮询到 reading 出现的同一事件轮里就执行用户切走（store 动作 = 按钮同一次派发路径）
    const race = await call("Runtime.evaluate", {
      expression: `(async () => {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        const m = await import(url);
        const deadline = Date.now() + 45000;
        for (;;) {
          const s = m.useAppStore.getState();
          const reading = Object.entries(s.resultReads.byKey).find(([, v]) => v.phase === 'reading');
          if (reading !== undefined) {
            await m.useAppStore.getState().selectRun(${JSON.stringify(otherId)});
            return JSON.stringify({ caught: true, key: reading[0],
                                    generation: m.useAppStore.getState().navGeneration });
          }
          if (Date.now() > deadline) return JSON.stringify({ caught: false });
          await new Promise((r) => setTimeout(r, 5));
        }
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const raceOut = JSON.parse(race?.result?.value ?? "{}");
    dump.race = raceOut;
    check("竞速捕获到「读取途中」窗口并当场切走", raceOut.caught === true, raceOut);
    const settled = await waitForForkSettled(call, key, 60000);
    check("请求收口", settled.st.forking === "idle", settled.st);
    const added = await H.newChildren(before, 30000, 1);
    const id = added[0] ?? null;
    const reg = await recordOf(call, sub.operationId);
    const entry = await waitForVerified(call, reg.epoch, sub.operationId, id);
    check("读取照常落地（verified）", entry?.phase === "verified", entry?.phase);
    const nav = await readingState(call);
    check("落地后选择与详情仍是用户那一条（不抢焦点）", nav.selectedRunId === otherId, nav);
  },

  /** M5.1「提交快照独立于编辑器挂载」（剧本=delayedInFlight；在飞切页签卸载编辑器） */
  "unmount-keeps-snapshot": async (call, mock) => {
    const runId = FX.normalRun;
    const key = `${runId}|s_03|result`;
    const before = H.traceIds();
    const text = `${MARK} unmount-keeps-snapshot 快照原文`;
    const { sub, draftText } = await forkFlow(call, {
      runId,
      spanId: "s_03",
      text,
      key,
      duringFlight: "tab:概览",
    });
    check(
      "在飞期间切页签卸载编辑器，关联身份不变",
      sub.unmounted === true && sub.afterNavOperationId === sub.operationId,
      sub,
    );
    check("提交快照 = 草稿原文（同一份值）", sub.text === draftText, null);
    const kept = await callDraftText(call, runId, "s_03", "result");
    check("切页后草稿原样保留", kept === draftText, kept?.slice?.(0, 60));
    const { rec, slot } = await recordOf(call, sub.operationId);
    check(
      "main 登记在场且 running、槽被占住",
      rec?.state === "running" && slot === sub.operationId,
      { state: rec?.state, slot },
    );
    const settled = await waitForForkSettled(call, key, 60000);
    check("请求收口", settled.st.forking === "idle", settled.st);
    const added = await H.newChildren(before, 30000, 1);
    const id = added[0] ?? null;
    const reg = await recordOf(call, sub.operationId);
    check("登记 runIds = 新 run", reg.rec?.runIds?.[0] === id, reg.rec?.runIds);
    const child = traceFacts(id);
    check(
      "落盘 fork.edit.value = 提交快照原文（快照独立于编辑器挂载）",
      child.meta?.fork?.edit?.value === draftText,
      child.meta?.fork?.edit?.value?.slice?.(0, 60),
    );
    await waitForVerified(call, reg.epoch, sub.operationId, id);
    // 用户切到概览 ⇒ 阅读代次已推进 ⇒ 不跳；草稿在核实后被按修订清理（正常终止）
    const nav = await readingState(call);
    check("意图已在切页时作废 ⇒ 落地不抢焦点", nav.selectedRunId === runId, nav);
    check(
      "正常终止核实后按匹配修订清理该调用草稿",
      (await callDraftText(call, runId, "s_03", "result")) === null,
      null,
    );
  },

  /** M5.2「成功错误和部分失败均保留草稿」的 6.3 半边（error 保留 / success 清理对照） */
  "response-keeps-draft": async (call, mock) => {
    const runId = FX.normalRun;
    // ① fail503 子 run：error 结局 ⇒ 草稿保留（不被结果清理）
    const keyA = `${runId}|s_03|result`;
    const before = H.traceIds();
    const textA = `${MARK} response-keeps 错误子 run`;
    const { sub: subA } = await forkFlow(call, { runId, spanId: "s_03", text: textA, key: keyA });
    await waitForForkSettled(call, keyA, 60000);
    const addedA = await H.newChildren(before, 30000, 1);
    const idA = addedA[0] ?? null;
    const regA = await recordOf(call, subA.operationId);
    const entryA = await waitForVerified(call, regA.epoch, subA.operationId, idA);
    check("错误子 run 核实落地", entryA?.phase === "verified", entryA?.phase);
    check(
      "error 结局 ⇒ 草稿保留提交快照全文（响应与核实都不删）",
      (await callDraftText(call, runId, "s_03", "result")) === subA.text,
      null,
    );
    // ② 成功子 run（同 span 重写）：正常终止 ⇒ 核实后按匹配修订清理
    const textB = `${MARK} response-keeps 成功子 run`;
    await openPlainResultEditor(call, runId, "s_03");
    await H.typeIntoEditableMonaco(call, textB);
    await confirmEditor(call);
    const subB = await submitAndCapture(call, "确认重跑", keyA);
    await waitForForkSettled(call, keyA, 60000);
    const addedB = await H.newChildren(before, 30000, 1);
    const idB = addedB.find((x) => x !== idA) ?? null;
    const regB = await recordOf(call, subB.operationId);
    const entryB = await waitForVerified(call, regB.epoch, subB.operationId, idB);
    check("成功子 run 核实落地", entryB?.phase === "verified", entryB?.phase);
    check(
      "正常终止 ⇒ 匹配修订的草稿被清理（对照支）",
      (await callDraftText(call, runId, "s_03", "result")) === null,
      null,
    );
    check("两次子 run 都落盘（error run 也是完整 run）", addedB.length === 2, addedB);
  },

  /**
   * A4.3「同修订再次提交也不被旧操作清理」（剧本组合：error → 同修订重发 success）。
   * ⚠️ 「旧提交在飞时被接管」的Overlap半边真机诱不出（U5 4.3 门禁：冻结期第二次登记被拒，
   * 那正是 M6.3 的证据）⇒ 该半边按单元承载；本 tag 证的是真机可诱的半边：
   * 同修订的更晚提交不被旧操作的迟到核对误清理。
   */
  "resubmit-same-rev": async (call, mock) => {
    const runId = FX.normalRun;
    const key = `${runId}|s_03|result`;
    const before = H.traceIds();
    const text = `${MARK} resubmit-same-rev 同修订文本`;
    // ① 第一次提交：fail503 子 run ⇒ error 结局，草稿保留在同修订
    const { sub: subA } = await forkFlow(call, { runId, spanId: "s_03", text, key });
    await waitForForkSettled(call, key, 60000);
    const addedA = await H.newChildren(before, 30000, 1);
    const idA = addedA[0] ?? null;
    const regA = await recordOf(call, subA.operationId);
    const entryA = await waitForVerified(call, regA.epoch, subA.operationId, idA);
    check("第一次提交核实落地（error）", entryA?.phase === "verified", entryA?.phase);
    const revA = subA.revision;
    check(
      "error 后草稿保留且修订未变（快照全文在场）",
      (await callDraftText(call, runId, "s_03", "result")) === subA.text,
      null,
    );
    // ② 同修订再次提交（不改动文本）：success 子 run
    await openPlainResultEditor(call, runId, "s_03");
    await confirmEditor(call);
    const subB = await submitAndCapture(call, "确认重跑", key);
    check("同修订再次提交登记成功（修订逐字相同）", subB.revision === revA, {
      first: revA,
      second: subB.revision,
    });
    // ③ 旧操作的迟到核对（reconcile op1）不得误清理新提交的草稿
    await openOpsPanel(call);
    await H.ev(
      call,
      `(() => { const li = Array.from(document.querySelectorAll('#operations-panel li'))
        .find(x => (x.textContent||'').includes(${JSON.stringify(subA.operationId)}));
      const b = li && Array.from(li.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '核对状态');
      if (b) b.click(); return true; })()`,
    );
    await H.sleep(2500);
    check(
      "旧操作迟到核对后，新提交的草稿仍在（不被误清理）",
      (await callDraftText(call, runId, "s_03", "result")) === subB.text,
      null,
    );
    // ④ 新提交正常收口：核实成功 ⇒ 清理
    const settled = await waitForForkSettled(call, key, 60000);
    check("第二次提交收口", settled.st.forking === "idle", settled.st);
    const addedB = await H.newChildren(before, 30000, 1);
    const idB = addedB.find((x) => x !== idA) ?? null;
    const regB = await recordOf(call, subB.operationId);
    const entryB = await waitForVerified(call, regB.epoch, subB.operationId, idB);
    check("第二次提交核实落地（success）", entryB?.phase === "verified", entryB?.phase);
    check(
      "核实成功 ⇒ 草稿清理（属主是更晚的提交）",
      (await callDraftText(call, runId, "s_03", "result")) === null,
      null,
    );
    check("受控服务恰 2 次调用（fail503 父调用 + 成功子 run）", mock.served() === 2, mock.served());
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
  // 夹具就绪：重载后等运行列表非空
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
      console.log(`[prepare] 模块加载失败（${String(e).slice(0, 80)}），reload 后重试一次`);
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
    await H.teardown(call, mock);
  }
  finish();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
