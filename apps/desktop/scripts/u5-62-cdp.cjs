/* eslint-disable */
/**
 * U5 任务 6.2（第一批受控实机）：普通/隔离创建成功、503、执行中离开、配置返回，
 * 以及 evidence-index「实机入口 = 6.2」各计划 tag 的实机半边。
 *
 * 判据口径（与 6.1 同纪律）：
 * - 期望调用数 / 期望自有终止事件**一律从 `fixtureOf(剧本)` 读出**，不手写数字
 *   （6.1 方法教训：期望值必须由被引用的那份数据读出）；
 * - 真实执行 / 确实零执行两面都由受控服务 `served()` 与 traces 文件增量立证（零付费）；
 * - 身份三方比对：main 登记 runIds × 落盘 meta.id × 渲染层 resultReads 键；
 * - 登记/槽事实一律读 main 的 `operations:status`，renderer 会话只作对照；
 * - 源目录指纹用逐文件 sha256 前后差集（M3.9「源目录逐字节不变」）。
 *
 * 用法：`node apps/desktop/scripts/u5-62-cdp.cjs --tag=<TAG>`
 * 前置：dev 已由 run-all 起（CDP 9612，带 REBASEAGENT_SMOKE_PICK_DIR）。
 */
"use strict";
const { execSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { fixtureOf, FIXTURE_IDS } = require("./lib/u5-sse-fixtures.cjs");

const TAGS = [
  "create-check",
  "create-success",
  "create-503-no-partial",
  "isolated-root-create",
  "in-flight-off-page",
  "create-settings-roundtrip",
  "empty-task-disabled",
  "empty-system-allowed",
  "create-not-configured",
  "failed-envelope-open",
  "diagnostics-readable",
  "busy-no-second-run",
  "create-draft-roundtrip",
  "create-mode-switch-discard",
  "create-return-source",
  "discard-then-late",
  "dup-rejected",
  "first-load-late",
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

const OUT_DIR = join(H.REPO, ".workbuddy", "u5", "u5-62");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-28-u5-62");
const SRC_DIR = join(OUT_DIR, "src-fixture");
const MARK = "U5-62";
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

/** 各 tag 依赖的受控剧本（first-load-late 不依赖） */
const TAG_FIXTURE = {
  "create-check": "successPlain",
  "create-success": "successPlain",
  "create-503-no-partial": "fail503",
  "isolated-root-create": "successPlain",
  "in-flight-off-page": "delayedInFlight",
  "create-settings-roundtrip": "successPlain",
  "empty-task-disabled": "notConsumed",
  "empty-system-allowed": "successPlain",
  "create-not-configured": "notConsumed",
  "failed-envelope-open": "fail503",
  "diagnostics-readable": "fail503",
  "busy-no-second-run": "delayedInFlight",
  "create-draft-roundtrip": "successPlain",
  "create-mode-switch-discard": "successPlain",
  "create-return-source": "successPlain",
  "discard-then-late": "successPlain",
  "dup-rejected": "delayedInFlight",
  "first-load-late": "successPlain",
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
function sha12(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
  } catch {
    return "missing";
  }
}
function headShort() {
  // 优先读 .git（spawn 的 cmd shell 里 git 不一定在 PATH），失败再退 git 命令
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
    try {
      return execSync("git rev-parse --short HEAD", { cwd: H.REPO, encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
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
    fixture: TAG_FIXTURE[TAG] ?? null,
    fixtureSha: {
      "u5-sse-fixtures.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u5-sse-fixtures.cjs")),
      "u5-read-faults.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u5-read-faults.cjs")),
      "mock-llm-server.cjs": sha12(join(H.REPO, "apps/desktop/scripts/mock-llm-server.cjs")),
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
/** 看门狗（U3 6.6 纪律）：CDP 半开时进程会以 0 静默退出 ⇒ 超预算判 exit 3 */
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 10 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 600_000);

// ---------------------------------------------------------------------------
// U5 6.2 读数（真 store / 真 IPC / 真落盘）
// ---------------------------------------------------------------------------

/** main 登记事实 */
const opsStatus = (call) => H.apiCall(call, "operationsStatus");
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  const rec = (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null;
  return { rec, slot: st?.data?.activeOperationId ?? null, epoch: st?.data?.epoch ?? null };
};
/** 创建草稿 + 会话引用 + 冻结 + 请求状态（对照面） */
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
       frozen: s.isDraftFrozen({ field: "create" }),
       creating: s.creatingRun,
       createRunError: s.createRunError,
       createRunErrorCode: s.createRunErrorCode,
     });`,
  );
/** 待定提交（键 = "|create"，见 lib/draft-submission submissionIdOf） */
const createSubmission = (call) =>
  H.storeQ(
    call,
    `const x = s.draftSubmissions.byId["|create"];
     return JSON.stringify(x === undefined ? null : {
       token: x.token, operationId: x.operationId, epoch: x.epoch,
       revision: x.submittedRevision, submittedAt: x.submittedAt ?? null });`,
  );
/** 结果核实表（U5 1.2/1.3：按可信身份读取的结论） */
const resultReadFor = async (call, epoch, operationId, runId) => {
  const key = `${epoch}|${operationId}|${runId}`;
  const all = await H.storeQ(call, "return JSON.stringify(s.resultReads.byKey);");
  return all[key] ?? null;
};
/** 落盘 trace 的自有终止事实（最后一行 run.event） */
function traceFacts(id) {
  const lines = readFileSync(join(H.TRACES, `${id}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const meta = lines[0];
  const llms = lines.filter((l) => l.type === "span" && l.kind === "llm.call");
  const last = lines[lines.length - 1];
  return {
    meta,
    lines: lines.length,
    llmCalls: llms.length,
    firstLlmError: llms.length > 0 ? (llms[0].error ?? null) : null,
    firstSystem:
      llms.length > 0
        ? ((llms[0].request?.messages ?? []).find((m) => m.role === "system")?.content ?? null)
        : null,
    event: last?.type === "run.event" ? last.event : null,
    reason: last?.type === "run.event" ? last.reason : null,
  };
}

// --- 页内动作 -------------------------------------------------------------

/** 从全局栏点「新建运行」（真实入口），并核对进入创建工作区 */
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
/** 点「返回来源」页头按钮 */
async function clickReturnSource(call) {
  const ok = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-return-to-source]');
      if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked") throw new Error("创建页找不到 [data-return-to-source]");
  await H.sleep(1400);
}
async function fillUserMessage(call, text) {
  const r = await H.typeIntoDom(call, "#create-user-message", text);
  if (typeof r?.value !== "string" || !r.value.includes(text))
    throw new Error(`任务输入失败：${JSON.stringify(r).slice(0, 200)}`);
}
async function textareaValue(call, selector) {
  return H.ev(
    call,
    `(() => { const i = document.querySelector(${JSON.stringify(selector)});
      return i === null ? null : i.value; })()`,
  );
}
async function buttonState(call, textExact) {
  const raw = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === ${JSON.stringify(textExact)});
      return b === null ? null : { disabled: b.disabled }; })()`,
  );
  return raw;
}
async function setMode(call, label) {
  const ok = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button[aria-pressed]'))
        .find(x => ((x.textContent||'').trim()) === ${JSON.stringify(label)});
      if (!b) return 'no-button'; if (b.getAttribute('aria-pressed') === 'true') return 'already';
      b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked" && ok !== "already") throw new Error(`切模式「${label}」失败：${ok}`);
  await H.sleep(600);
}
const confirmBtnExpr = `document.querySelector('section[aria-label="新建运行"] [data-confirm-execution]')`;
/** 点「已核对，确认本次提交」并核对确认态真的挂上（aria-pressed） */
async function confirmSubmission(call) {
  const before = await H.ev(
    call,
    `(() => { const b = ${confirmBtnExpr};
      if (!b) return JSON.stringify({ error: 'no-confirm-button' });
      return JSON.stringify({ disabled: b.disabled, pressed: b.getAttribute('aria-pressed'),
                              text: (b.textContent||'').trim() }); })()`,
  );
  const parsed = JSON.parse(before);
  if (parsed.error) throw new Error(`确认按钮缺失：${parsed.error}`);
  if (parsed.disabled !== false) throw new Error(`确认按钮不可点：${JSON.stringify(parsed)}`);
  await H.ev(call, `(() => { ${confirmBtnExpr}.click(); return true; })()`);
  await H.sleep(600);
  const after = await H.ev(
    call,
    `(() => { const b = ${confirmBtnExpr};
      return b === null ? null : { pressed: b.getAttribute('aria-pressed'),
                                   text: (b.textContent||'').trim() }; })()`,
  );
  if (after?.pressed !== "true")
    throw new Error(`点确认后 aria-pressed=${after?.pressed}（text=${after?.text}）`);
  return { before: parsed, after };
}
/** 点提交按钮并在页内同帧捕获待定关联（毫秒级响应会扑空，见 U4 纪律） */
async function submitCreateAndCapture(call, buttonText) {
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === ${JSON.stringify(buttonText)});
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
          revision: x.submittedRevision, submittedAt: x.submittedAt ?? null });
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
/** 等待本次创建收口：待定关联消失 + creatingRun 离开 in_progress */
async function waitForCreateSettled(call, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sub = await createSubmission(call);
    const st = await createSession(call);
    if (sub === null && st.creating !== "in_progress") return { st };
    if (Date.now() > deadline) return { st, sub, timedOut: true };
    await H.sleep(500);
  }
}
/** 等待渲染层按可信 ID 核实落地（U5 1.2/1.3 的 resultReads） */
async function waitForVerified(call, epoch, operationId, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = await resultReadFor(call, epoch, operationId, runId);
    if (entry !== null && entry.phase !== "reading") return entry;
    if (Date.now() > deadline) return entry;
    await H.sleep(500);
  }
}
/** 打开全局操作面板（幂等） */
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
/** 受控源目录夹具（M3.9 指纹比对用） */
function ensureSourceFixture() {
  mkdirSync(SRC_DIR, { recursive: true });
  writeFileSync(join(SRC_DIR, "a.txt"), "alpha 内容", "utf8");
  writeFileSync(join(SRC_DIR, "keep.txt"), "keep", "utf8");
  return SRC_DIR;
}
/** 通用创建流程（普通/隔离共用）：打开 → 填任务 →（模式/源/授权）→ 确认 */
async function createFlow(call, opts) {
  const { task, mode = "chat", authorize = false } = opts;
  await openCreate(call);
  await fillUserMessage(call, task);
  if (mode === "isolated_files") {
    await setMode(call, "隔离文件运行");
    // 源目录由 REBASEAGENT_SMOKE_PICK_DIR 注入（dev 启动时已带 ⇒ 无原生对话框）
    await H.clickByTextChecked(call, "选择目录…", 1200);
    const srcState = await H.domState(call, 'section[aria-label="新建运行"] input[type=checkbox]');
    check(
      "隔离：选择目录后授权复选框可点（表单已带源引用）",
      srcState?.disabled === false,
      srcState,
    );
    if (authorize) {
      await H.clickLabelWith(call, "允许本次执行的副本写入");
    }
  }
  const confirmInfo = await confirmSubmission(call);
  check(
    "确认凭据挂上（aria-pressed=true）",
    confirmInfo.after.pressed === "true",
    confirmInfo.after,
  );
  return confirmInfo;
}

// ---------------------------------------------------------------------------
// 各 tag
// ---------------------------------------------------------------------------

const FLOWS = {
  /** A1.1「创建和普通重跑只声明已完成的检查」：披露只列本地检查 + 明说没有连通性预检 */
  "create-check": async (call, mock) => {
    const fx = fixtureOf("notConsumed");
    await openCreate(call);
    let body = await H.ev(call, "(() => document.body.innerText)()");
    check(
      "未补齐输入时确认区给就近原因（先补齐必填输入）",
      body.includes("先补齐必填输入，再核对本次提交"),
      null,
    );
    await fillUserMessage(call, `${MARK} create-check 披露核对`);
    body = await H.ev(call, "(() => document.body.innerText)()");
    check(
      "普通创建的「已做的检查」明说没有独立连通性预检",
      body.includes("没有独立的模型连通性预检"),
      null,
    );
    check(
      "执行范围就地可读：一次提交 = 一次真实模型调用",
      body.includes("一次提交 = 一次真实模型调用"),
      null,
    );
    check(
      "确认行不冒充做过只读预检（无「目录采集预览」话术）",
      !body.includes("目录采集预览"),
      null,
    );
    const confirmInfo = await confirmSubmission(call);
    check(
      "确认可挂上且文案切换为已确认",
      confirmInfo.after.text === "已确认本次提交",
      confirmInfo.after,
    );
    check(
      "零模型调用（本 tag 不提交，notConsumed 期望 0）",
      mock.served() === fx.expectedCalls,
      mock.served(),
    );
  },

  /** M3.1「新建 run 成功」+ A4.1 清理半边 + A5.1 导航半边 + M7.2 同形半边 */
  "create-success": async (call, mock) => {
    const fx = fixtureOf("successPlain");
    const task = `${MARK} create-success 受控任务`;
    const servedBefore = mock.served();
    const tracesBefore = H.traceIds();
    await createFlow(call, { task });
    const sub = await submitCreateAndCapture(call, "创建");
    check("提交登记待定关联（operationId 现生成）", typeof sub.operationId === "string", sub);
    const settled = await waitForCreateSettled(call);
    check(
      "请求收口：冻结解除、creatingRun 回 idle",
      settled.st.frozen === false && settled.st.creating === "idle",
      settled.st,
    );
    const servedAfter = mock.served();
    check(
      `受控服务恰 ${fx.expectedCalls} 次调用（期望值来自剧本目录）`,
      servedAfter - servedBefore === fx.expectedCalls,
      { before: servedBefore, after: servedAfter, expected: fx.expectedCalls },
    );
    const added = await H.newChildren(tracesBefore, 20000, 1);
    check("落盘恰 1 份新 trace", added.length === 1, added);
    const id = added[0];
    const facts = traceFacts(id);
    dump.trace = { id, task: facts.meta.task, format_version: facts.meta.format_version };
    check(
      "根 run：parent/fork 为空",
      facts.meta.parent === null && (facts.meta.fork ?? null) === null,
      {
        parent: facts.meta.parent,
        fork: facts.meta.fork ?? null,
      },
    );
    check("任务即列表标题（task = userMessage）", facts.meta.task === task, facts.meta.task);
    check(
      `自有终止 = ${fx.expectedEvent}/${fx.expectedReason}（来自剧本目录）`,
      facts.event === fx.expectedEvent && facts.reason === fx.expectedReason,
      { event: facts.event, reason: facts.reason },
    );
    const reg = await recordOf(call, sub.operationId);
    check("main 登记该操作且状态 settled", reg.rec?.state === "settled", {
      state: reg.rec?.state,
      slot: reg.slot,
    });
    check(
      "身份三方一致：main 登记 runIds × 落盘 meta.id",
      Array.isArray(reg.rec?.runIds) && reg.rec.runIds.length === 1 && reg.rec.runIds[0] === id,
      { runIds: reg.rec?.runIds, metaId: id },
    );
    const entry = await waitForVerified(call, reg.epoch, sub.operationId, id);
    check("渲染层按可信 ID 核实落地（phase=verified）", entry?.phase === "verified", {
      phase: entry?.phase,
      reason: entry?.reason ?? null,
    });
    const nav = await createSession(call);
    check(
      "留在流程内 ⇒ 自动导航进入登记的那条（A5.1 6.2 半边，successPlain 支）",
      nav.selectedRunId === id,
      { selectedRunId: nav.selectedRunId },
    );
    check("正常终止 ⇒ 创建草稿清理（A4.1 实机半边）", nav.draft === null, nav.draft);
    await H.shot(call, SHOT_DIR, `${TAG}-overview.png`);
  },

  /** M3.8「执行失败不产生半成品」（剧本=fail503） */
  "create-503-no-partial": async (call, mock) => {
    const fx = fixtureOf("fail503");
    const task = `${MARK} create-503 受控任务`;
    const servedBefore = mock.served();
    const tracesBefore = H.traceIds();
    await createFlow(call, { task });
    const sub = await submitCreateAndCapture(call, "创建");
    await waitForCreateSettled(call, 60000);
    const servedAfter = mock.served();
    check(
      `受控服务恰 ${fx.expectedCalls} 次调用、不重试`,
      servedAfter - servedBefore === fx.expectedCalls,
      {
        before: servedBefore,
        after: servedAfter,
      },
    );
    const added = await H.newChildren(tracesBefore, 30000, 1);
    check("落盘恰 1 份新 trace（失败也是完整 run，不产生半成品）", added.length === 1, {
      added,
      before: tracesBefore,
    });
    const id = added[0];
    const facts = traceFacts(id);
    check(
      `自有终止 = ${fx.expectedEvent}/${fx.expectedReason}`,
      facts.event === fx.expectedEvent && facts.reason === fx.expectedReason,
      { event: facts.event, reason: facts.reason },
    );
    check(
      `失败详情带 status=${fx.expectedErrorStatus}`,
      facts.firstLlmError?.status === fx.expectedErrorStatus,
      facts.firstLlmError,
    );
    const reg = await recordOf(call, sub.operationId);
    check(
      "main 登记且 settled（失败 run 仍按 meta.id 归位）",
      reg.rec?.state === "settled" && reg.rec?.runIds?.[0] === id,
      {
        state: reg.rec?.state,
        runIds: reg.rec?.runIds,
        metaId: id,
      },
    );
    const entry = await waitForVerified(call, reg.epoch, sub.operationId, id);
    check(
      "失败 run 同样核实落地（phase=verified，结局由自有事实说话）",
      entry?.phase === "verified",
      entry?.phase,
    );
    const nav = await createSession(call);
    check(
      "留在流程内 ⇒ 失败结局同样进入登记那条的概览（A5.1 6.2 半边，fail503 支）",
      nav.selectedRunId === id,
      { selectedRunId: nav.selectedRunId },
    );
    check(
      "失败 ⇒ 草稿保留（不被结果清理）",
      nav.draft?.userMessage.includes("create-503") === true,
      {
        userMessage: nav.draft?.userMessage ?? null,
      },
    );
    await H.shot(call, SHOT_DIR, `${TAG}-failed-overview.png`);
  },

  /** M3.9「直接创建隔离文件父本」（剧本=successPlain + 源目录指纹） */
  "isolated-root-create": async (call, mock) => {
    const fx = fixtureOf("successPlain");
    const srcDir = ensureSourceFixture();
    const before = H.hashSourceDir(srcDir);
    const task = `${MARK} isolated-root 受控任务`;
    const servedBefore = mock.served();
    const tracesBefore = H.traceIds();
    await createFlow(call, { task, mode: "isolated_files", authorize: true });
    const sub = await submitCreateAndCapture(call, "创建隔离运行");
    await waitForCreateSettled(call);
    const servedAfter = mock.served();
    check(
      `受控服务恰 ${fx.expectedCalls} 次调用`,
      servedAfter - servedBefore === fx.expectedCalls,
      {
        before: servedBefore,
        after: servedAfter,
      },
    );
    const added = await H.newChildren(tracesBefore, 30000, 1);
    check("落盘恰 1 份新 trace", added.length === 1, added);
    const id = added[0];
    const facts = traceFacts(id);
    dump.trace = {
      id,
      format_version: facts.meta.format_version,
      workspace: facts.meta.workspace ?? null,
    };
    check(
      "v2 根 run：format_version=2、parent=null",
      facts.meta.format_version === 2 && facts.meta.parent === null,
      {
        v: facts.meta.format_version,
        parent: facts.meta.parent,
      },
    );
    check(
      "隔离世界身份：workspace.world_id = 自身 id",
      facts.meta.workspace?.world_id === id,
      facts.meta.workspace,
    );
    check(
      `自有终止 = ${fx.expectedEvent}/${fx.expectedReason}`,
      facts.event === fx.expectedEvent && facts.reason === fx.expectedReason,
      { event: facts.event, reason: facts.reason },
    );
    const after = H.hashSourceDir(srcDir);
    const diff = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    check("源目录逐字节不变（逐文件 sha256 差集为空）", diff.length === 0, diff);
    const reg = await recordOf(call, sub.operationId);
    check("main 登记 runIds 与落盘 meta.id 一致", reg.rec?.runIds?.[0] === id, {
      runIds: reg.rec?.runIds,
      metaId: id,
    });
    await waitForVerified(call, reg.epoch, sub.operationId, id);
    const sess = await createSession(call);
    check(
      "正常终止 ⇒ 隔离创建草稿与目录引用清理",
      sess.draft === null && sess.sourceRef === null,
      sess,
    );
    await H.shot(call, SHOT_DIR, `${TAG}-isolated.png`);
  },

  /** A2.1「执行中离页仍可查询等待」（剧本=delayedInFlight） */
  "in-flight-off-page": async (call, mock) => {
    const fx = fixtureOf("delayedInFlight");
    const task = `${MARK} in-flight-off-page 受控任务`;
    const existing = [...H.traceIds()].filter((x) => x !== "u2bad55_noownsteps")[0];
    await createFlow(call, { task });
    const sub = await submitCreateAndCapture(call, "创建");
    check("提交进入在飞（待定关联在场）", typeof sub.operationId === "string", sub);
    // 在飞窗口：离开创建页（点开另一条 run），再打开全局操作面板
    await H.selectRun(call, existing);
    const left = await createSession(call);
    check("在飞期间离页成功（草稿冻结不锁整窗）", left.selectedRunId === existing, {
      selectedRunId: left.selectedRunId,
    });
    await openOperationsPanel(call);
    // 等待呈现：basis=submitted（本地提交时刻在场 ⇒ 「自提交起」）
    let waitRow = null;
    const deadline = Date.now() + 8000;
    for (;;) {
      waitRow = await H.ev(
        call,
        `(() => { const w = document.querySelector('#operations-panel [data-wait-basis]');
          return w === null ? null : { basis: w.getAttribute('data-wait-basis'), text: w.textContent }; })()`,
      );
      if (waitRow !== null || Date.now() > deadline) break;
      await H.sleep(400);
    }
    check("操作面板呈现等待行（真实计时）", waitRow !== null, waitRow);
    check("计时口径 = 自提交起（本地 submittedAt 在场）", waitRow?.basis === "submitted", waitRow);
    check(
      "文案明说等待不是模型耗时/进度",
      typeof waitRow?.text === "string" &&
        waitRow.text.includes("不是模型耗时") &&
        waitRow.text.includes("自提交起"),
      waitRow?.text,
    );
    const sess = await createSession(call);
    check("离页后草稿仍冻结（在飞不放行第二次执行）", sess.frozen === true, sess);
    check(
      "main 槽被本次创建占用",
      (await recordOf(call, sub.operationId)).slot === sub.operationId,
      null,
    );
    // 收口：等待行停增、草稿清理、恰 1 次调用
    await waitForCreateSettled(call, 30000);
    const reg = await recordOf(call, sub.operationId);
    const id = reg.rec?.runIds?.[0] ?? null;
    const facts = id === null ? null : traceFacts(id);
    check(
      `自有终止 = ${fx.expectedEvent}/${fx.expectedReason}`,
      facts !== null && facts.event === fx.expectedEvent && facts.reason === fx.expectedReason,
      facts && { event: facts.event, reason: facts.reason },
    );
    await waitForVerified(call, reg.epoch, sub.operationId, id);
    const waitAfter = await H.ev(
      call,
      `(() => { const w = document.querySelector('#operations-panel [data-wait-basis]');
        return w === null ? null : { basis: w.getAttribute('data-wait-basis'), text: w.textContent }; })()`,
    );
    check(
      "终态后计时不伪造（文案含「计时已停止」）",
      waitAfter?.text?.includes("计时已停止") === true,
      waitAfter,
    );
    const nav = await createSession(call);
    check("用户已离页 ⇒ 落地后不抢焦点（仍停在用户选的 run）", nav.selectedRunId === existing, {
      selectedRunId: nav.selectedRunId,
    });
    check("离页创建正常终止 ⇒ 草稿清理照常（遗留关联收尾）", nav.draft === null, null);
    await H.shot(call, SHOT_DIR, `${TAG}-panel-wait.png`);
  },

  /** A6.1「两模式配置后返回任务」（真实 UI 设置往返 + 授权撤销） */
  "create-settings-roundtrip": async (call) => {
    ensureSourceFixture();
    const task = `${MARK} settings-roundtrip 受控任务`;
    await openCreate(call);
    await fillUserMessage(call, task);
    await setMode(call, "隔离文件运行");
    await H.clickByTextChecked(call, "选择目录…", 1200);
    await H.clickLabelWith(call, "允许本次执行的副本写入");
    // 确认 → 进设置（往返即撤销）→ 真实 UI 保存（换 model 改指纹）→ 关闭
    await confirmSubmission(call);
    await H.clickByTextChecked(call, "运行配置…", 900);
    const dialogOpen = await H.ev(
      call,
      `(() => Array.from(document.querySelectorAll('dialog[open]')).length > 0)()`,
    );
    check("运行配置入口打开设置模态", dialogOpen === true, null);
    await H.typeIntoDom(call, 'input[placeholder="deepseek-chat"]', "mock-model-b");
    await H.clickInOpenDialog(call, "保存", 1500);
    const saved = await H.ev(
      call,
      `(() => document.body.innerText.includes("已保存并回读到配置状态"))()`,
    );
    check("真实 UI 保存成功（不冒充连通的反馈在场）", saved === true, null);
    await H.clickInOpenDialog(call, "关闭", 900);
    const sess = await createSession(call);
    check("配置后返回：仍在创建任务（view=create）", sess.view === "create", sess);
    check("任务文本保留", sess.draft?.userMessage === task, sess.draft?.userMessage ?? null);
    check("模式保留（隔离文件运行）", sess.draft?.mode === "isolated_files", sess.draft?.mode);
    check(
      "目录引用保留（token 有效性由 main 使用时判定）",
      sess.sourceRef !== null,
      sess.sourceRef,
    );
    const body = await H.ev(
      call,
      `(() => document.querySelector('section[aria-label="新建运行"]').innerText)()`,
    );
    check("摘要随新配置刷新（两模式共用的当前接入）", body.includes("mock-model-b"), null);
    const writes = await H.domState(call, 'section[aria-label="新建运行"] input[type=checkbox]');
    check(
      "授权随配置变化作废（复选框回到未勾选，5.3 revoke 实机面）",
      writes?.checked === false,
      writes,
    );
    const confirmState = await H.ev(
      call,
      `(() => { const b = ${confirmBtnExpr};
        return b === null ? null : { pressed: b.getAttribute('aria-pressed'), text: (b.textContent||'').trim() }; })()`,
    );
    check(
      "设置往返撤销旧确认（回到未确认态）",
      confirmState?.pressed !== "true" && confirmState?.text === "已核对，确认本次提交",
      confirmState,
    );
    // 切回纯对话：摘要与配置入口仍在（两模式都在）
    await setMode(call, "纯对话");
    const body2 = await H.ev(
      call,
      `(() => document.querySelector('section[aria-label="新建运行"]').innerText)()`,
    );
    check(
      "纯对话模式同样有接入摘要与配置入口",
      body2.includes("mock-model-b") && body2.includes("运行配置…"),
      null,
    );
    check(
      "纯对话模式下任务文本保留",
      (await textareaValue(call, "#create-user-message")) === task,
      null,
    );
    await H.shot(call, SHOT_DIR, `${TAG}-roundtrip.png`);
  },

  /** M3.6「userMessage 为空时禁用提交」（剧本=notConsumed，零消费） */
  "empty-task-disabled": async (call, mock) => {
    const fx = fixtureOf("notConsumed");
    const tracesBefore = H.traceIds().size;
    await openCreate(call);
    const submit1 = await buttonState(call, "创建");
    check("空任务 ⇒ 提交按钮 disabled", submit1?.disabled === true, submit1);
    const body = await H.ev(call, "(() => document.body.innerText)()");
    check(
      "拒绝就近给说明（确认区给就近原因）",
      body.includes("先补齐必填输入，再核对本次提交"),
      null,
    );
    // 纯空白同样拒绝（同一判据）
    await H.typeIntoDom(call, "#create-user-message", "   ");
    await H.sleep(500);
    const submit2 = await buttonState(call, "创建");
    check("纯空白同样 disabled", submit2?.disabled === true, submit2);
    check("零模型调用（notConsumed 期望 0）", mock.served() === fx.expectedCalls, mock.served());
    const sub = await createSubmission(call);
    check("零新 trace、零待定登记", H.traceIds().size === tracesBefore && sub === null, {
      traces: H.traceIds().size,
      before: tracesBefore,
      sub,
    });
  },

  /** M3.7「空 systemPrompt 允许」（剧本=successPlain） */
  "empty-system-allowed": async (call, mock) => {
    const fx = fixtureOf("successPlain");
    const task = `${MARK} empty-system 受控任务`;
    const servedBefore = mock.served();
    const tracesBefore = H.traceIds();
    await createFlow(call, { task });
    // 留空说明在高级区展开态里才渲染（初始按草稿内容决定展开 ⇒ 默认收起）
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-advanced-toggle]');
        if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`,
    );
    await H.sleep(500);
    const body = await H.ev(call, "(() => document.body.innerText)()");
    check("留空说明在场（按空 system 算 config_hash）", body.includes("留空也可以"), null);
    const sub = await submitCreateAndCapture(call, "创建");
    await waitForCreateSettled(call);
    check(
      `受控服务恰 ${fx.expectedCalls} 次调用`,
      mock.served() - servedBefore === fx.expectedCalls,
      mock.served(),
    );
    const added = await H.newChildren(tracesBefore, 20000, 1);
    check("落盘恰 1 份新 trace", added.length === 1, added);
    const facts = traceFacts(added[0]);
    check(
      "请求里 system 为空串（不是没发 system 位）",
      facts.firstSystem === "",
      facts.firstSystem,
    );
    check(
      `自有终止 = ${fx.expectedEvent}/${fx.expectedReason}`,
      facts.event === fx.expectedEvent && facts.reason === fx.expectedReason,
      { event: facts.event, reason: facts.reason },
    );
  },

  /** M3.5「settings 未配置时拒绝」（剧本=notConsumed；拒绝执法在 main） */
  "create-not-configured": async (call, mock) => {
    const fx = fixtureOf("notConsumed");
    // 清配置（真实通道），表单照常可填
    await H.apiCall(call, "clearSettings");
    await H.storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
    const task = `${MARK} not-configured 受控任务`;
    const tracesBefore = H.traceIds().size;
    await openCreate(call);
    const body = await H.ev(call, "(() => document.body.innerText)()");
    check(
      "未配置 ⇒ 摘要转告警态并点名稳定码",
      body.includes("尚未配置运行参数") && body.includes("SETTINGS_NOT_CONFIGURED"),
      null,
    );
    await fillUserMessage(call, task);
    await confirmSubmission(call);
    const sub = await submitCreateAndCapture(call, "创建");
    // 拒绝路径收口极快，捕获窗口可能扑空 —— 请求确实发出的证据 = main 拒绝回执在场
    await waitForCreateSettled(call);
    const sess = await createSession(call);
    check(
      "提交请求确实发出（登记被捕获或 main 拒绝回执在场，不由页面预检冒充）",
      typeof sub.operationId === "string" || sess.createRunErrorCode === "SETTINGS_NOT_CONFIGURED",
      { captured: sub.operationId ?? null, code: sess.createRunErrorCode },
    );
    check(
      "main 拒绝：稳定码 SETTINGS_NOT_CONFIGURED 原样透传",
      sess.createRunErrorCode === "SETTINGS_NOT_CONFIGURED",
      {
        code: sess.createRunErrorCode,
        error: sess.createRunError,
      },
    );
    check("零模型调用（期望 0）", mock.served() === fx.expectedCalls, mock.served());
    check("零新 trace", H.traceIds().size === tracesBefore, {
      after: H.traceIds().size,
      before: tracesBefore,
    });
    check(
      "任务文本保留（拒绝不清草稿）",
      sess.draft?.userMessage === task,
      sess.draft?.userMessage ?? null,
    );
    // 还原受控配置（后续 tag 需要）
    await H.apiCall(call, "saveSettings", {
      baseURL: H.MOCK_BASE,
      apiKey: "sk-u363-controlled",
      model: "mock-model",
    });
    await H.storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
  },

  /** A3.2「失败信封仍可打开可信记录」（剧本=fail503；打开走明确动作） */
  "failed-envelope-open": async (call) => {
    const task = `${MARK} failed-envelope 受控任务`;
    await createFlow(call, { task });
    const sub = await submitCreateAndCapture(call, "创建");
    await waitForCreateSettled(call, 60000);
    const reg = await recordOf(call, sub.operationId);
    const id = reg.rec?.runIds?.[0] ?? null;
    check("登记带真实 runId（失败信封不丢身份）", typeof id === "string", reg.rec?.runIds);
    await waitForVerified(call, reg.epoch, sub.operationId, id);
    // 从操作面板走「打开结果」明确动作（用户主动才切页面）
    await openOperationsPanel(call);
    const actions = await H.ev(
      call,
      `(() => { const panel = document.getElementById('operations-panel');
        const btns = Array.from(panel.querySelectorAll('button')).map(b => (b.textContent||'').trim());
        return JSON.stringify({ hasOpen: btns.includes('打开结果'), hasFailure: btns.includes('查看失败调用') }); })()`,
    );
    const parsed = JSON.parse(actions);
    check("失败结果给「打开结果」入口", parsed.hasOpen === true, parsed);
    check(
      "自有失败调用在场 ⇒ 给「查看失败调用」入口（不拿祖先凑数）",
      parsed.hasFailure === true,
      parsed,
    );
    const ok = await H.ev(
      call,
      `(() => { const panel = document.getElementById('operations-panel');
        const b = Array.from(panel.querySelectorAll('button')).find(x => ((x.textContent||'').trim()) === '打开结果');
        if (!b) return false; b.click(); return true; })()`,
    );
    if (ok !== true) throw new Error("点「打开结果」失败");
    await H.sleep(2500);
    const nav = await createSession(call);
    check("明确打开 ⇒ 停在登记那条（可信记录可打开）", nav.selectedRunId === id, {
      selectedRunId: nav.selectedRunId,
    });
    await H.shot(call, SHOT_DIR, `${TAG}-open-result.png`);
  },

  /** A2.5「操作详情可读诊断但不泄漏输入」（剧本=fail503） */
  "diagnostics-readable": async (call) => {
    const task = `${MARK} diagnostics 受控任务`;
    await createFlow(call, { task });
    const sub = await submitCreateAndCapture(call, "创建");
    await waitForCreateSettled(call, 60000);
    const reg = await recordOf(call, sub.operationId);
    const recJson = JSON.stringify(reg.rec ?? {});
    check(
      "登记记录 settled 且带 runIds",
      reg.rec?.state === "settled" && (reg.rec?.runIds ?? []).length === 1,
      {
        state: reg.rec?.state,
        runIds: reg.rec?.runIds,
      },
    );
    check("登记不含正文（用户任务文本不进操作登记）", !recJson.includes(task), null);
    check(
      "登记不含凭据类字段",
      !recJson.includes("sourceToken") && !recJson.includes("apiKey"),
      null,
    );
    // 🔴 本轮发现（写进索引）：`OperationRegistry.addDiagnostic` 当前**零调用方**——
    // main 侧没有任何产出诊断的路径，实机拿到的 diagnostics 恒为空。
    // 「可读诊断」的呈现面由单元用例承载（operation-request-facts 喂 props），
    // 本 tag 实机可证的半边 = 「不泄漏输入」+ 登记如实（空就是空，不编造）。
    dump.diagnostics = reg.rec?.diagnostics ?? null;
    check(
      "实机登记如实：diagnostics 为空（main 的 addDiagnostic 零调用方，发现见索引）",
      (reg.rec?.diagnostics ?? []).length === 0,
      reg.rec?.diagnostics,
    );
    await openOperationsPanel(call);
    const panelText = await H.ev(
      call,
      `(() => (document.getElementById('operations-panel')?.innerText ?? ''))()`,
    );
    check("面板不含任务正文（不泄漏输入）", !panelText.includes(task), null);
    await H.shot(call, SHOT_DIR, `${TAG}-panel.png`);
  },

  /** M6.3「创建忙碌期间不能通过焦点修复绕过关闭锁」（剧本=delayedInFlight） */
  "busy-no-second-run": async (call, mock) => {
    const fx = fixtureOf("delayedInFlight");
    const task = `${MARK} busy-no-second 受控任务`;
    const existing = [...H.traceIds()].filter((x) => x !== "u2bad55_noownsteps")[0];
    await createFlow(call, { task });
    const sub = await submitCreateAndCapture(call, "创建");
    check("第一次提交在场", typeof sub.operationId === "string", sub);
    // 在飞：离页再回创建页，表单恢复且仍冻结
    await H.selectRun(call, existing);
    await openCreate(call);
    const sess = await createSession(call);
    check(
      "回创建页：草稿恢复且仍冻结",
      sess.frozen === true && sess.draft?.userMessage === task,
      sess,
    );
    const btn = {
      submit: await buttonState(call, "创建"),
      discard: await buttonState(call, "放弃填写内容"),
    };
    check("提交按钮 disabled（冻结靠登记，不靠焦点锁）", btn.submit?.disabled === true, btn);
    check("放弃入口同样不可用", btn.discard?.disabled === true, btn.discard);
    // 在飞期间登记仍是同一条（token 不变 ⇒ 没有第二次关联）
    const sub2 = await createSubmission(call);
    check("重复点击不产生第二次登记（token 不变）", sub2?.token === sub.token, {
      first: sub.token,
      now: sub2?.token ?? null,
    });
    await waitForCreateSettled(call, 30000);
    check(
      `受控服务恰 ${fx.expectedCalls} 次调用（第二次执行没发出）`,
      mock.served() === fx.expectedCalls,
      mock.served(),
    );
  },

  /** M4.1「创建关闭配置再新建仍有任务」（草稿往返） */
  "create-draft-roundtrip": async (call) => {
    const task = `${MARK} draft-roundtrip 受控任务`;
    const existing = [...H.traceIds()].filter((x) => x !== "u2bad55_noownsteps")[0];
    await openCreate(call);
    await fillUserMessage(call, task);
    await setMode(call, "隔离文件运行");
    // 离开（切到别的 run）再回来
    await H.selectRun(call, existing);
    await openCreate(call);
    const restored = await textareaValue(call, "#create-user-message");
    check("离开再回来：任务逐字恢复", restored === task, restored);
    let st = await createSession(call);
    check(
      "模式跟会话草稿恢复（隔离文件运行）",
      st.draft?.mode === "isolated_files",
      st.draft?.mode,
    );
    // 系统指令也走草稿
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-advanced-toggle]');
        if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`,
    );
    await H.sleep(400);
    await H.typeIntoDom(call, "#create-system-prompt", "系统指令草稿往返");
    await H.selectRun(call, existing);
    await openCreate(call);
    st = await createSession(call);
    check(
      "系统指令同样逐字恢复",
      st.draft?.systemPrompt === "系统指令草稿往返",
      st.draft?.systemPrompt,
    );
  },

  /** M4.2「切创建模式保留文本而放弃重置表单」（真点放弃确认） */
  "create-mode-switch-discard": async (call) => {
    const task = `${MARK} mode-switch-discard 受控任务`;
    await openCreate(call);
    await fillUserMessage(call, task);
    await setMode(call, "隔离文件运行");
    check("切模式保留任务文本", (await textareaValue(call, "#create-user-message")) === task, null);
    await setMode(call, "纯对话");
    check("切回纯对话文本仍在", (await textareaValue(call, "#create-user-message")) === task, null);
    // 放弃：真模态确认（取消一支 + 确认一支）
    await H.clickByTextChecked(call, "放弃填写内容", 700);
    const dlgText = await H.ev(
      call,
      `(() => { const d = Array.from(document.querySelectorAll('dialog[open]')).pop();
        return d === null ? null : (d.innerText || '').slice(0, 200); })()`,
    );
    check(
      "放弃走真模态确认（标题点名放弃创建草稿）",
      typeof dlgText === "string" && dlgText.includes("放弃创建草稿"),
      dlgText,
    );
    await H.clickInOpenDialog(call, "取消", 600);
    check(
      "取消 ⇒ 文本逐字保留",
      (await textareaValue(call, "#create-user-message")) === task,
      null,
    );
    await H.clickByTextChecked(call, "放弃填写内容", 700);
    await H.clickInOpenDialog(call, "确认放弃", 800);
    const after = await textareaValue(call, "#create-user-message");
    check("确认放弃 ⇒ 表单重置（任务清空）", after === "", after);
    const st = await createSession(call);
    check("放弃后目录引用一并复位", st.sourceRef === null, st.sourceRef);
  },

  /** M3.10「创建工作区任务优先且可返回来源」 */
  "create-return-source": async (call) => {
    const existing = [...H.traceIds()].filter((x) => x !== "u2bad55_noownsteps")[0];
    await H.selectRun(call, existing);
    await openCreate(call);
    const sess1 = await createSession(call);
    check("从阅读位置进入创建（view=create）", sess1.view === "create", sess1.view);
    await clickReturnSource(call);
    const sess2 = await createSession(call);
    check(
      "返回来源 ⇒ 回到来源 run（一次性凭据）",
      sess2.view !== "create" && sess2.selectedRunId === existing,
      {
        view: sess2.view,
        selectedRunId: sess2.selectedRunId,
      },
    );
    // 再次进入创建（取新来源）再返回
    await openCreate(call);
    await clickReturnSource(call);
    const sess3 = await createSession(call);
    check("第二次往返同样可达（取新来源）", sess3.view !== "create", sess3.view);
  },

  /** A4.7「重复收尾与显式放弃不会误删重建草稿」（剧本=successPlain） */
  "discard-then-late": async (call, mock) => {
    const fx = fixtureOf("successPlain");
    const task = `${MARK} discard-then-late 第一笔`;
    await createFlow(call, { task });
    const sub = await submitCreateAndCapture(call, "创建");
    await waitForCreateSettled(call);
    const reg = await recordOf(call, sub.operationId);
    const id = reg.rec?.runIds?.[0];
    await waitForVerified(call, reg.epoch, sub.operationId, id);
    const sess1 = await createSession(call);
    dump.afterFirst = sess1;
    check("第一笔正常收口且草稿清理", sess1.draft === null, sess1);
    // 自动导航可能已把页面带去登记那条的概览 —— 重建草稿前先回到创建页
    await openCreate(call);
    // 重建草稿
    const task2 = `${MARK} discard-then-late 重建草稿`;
    await fillUserMessage(call, task2);
    // 迟到消费：核对状态（reconcile 只读）触发收尾重放，重建草稿不得被误删
    await openOperationsPanel(call);
    const clicked = await H.ev(
      call,
      `(() => { const panel = document.getElementById('operations-panel');
        const b = Array.from(panel.querySelectorAll('button')).find(x => ((x.textContent||'').trim()) === '核对状态');
        if (!b) return false; b.click(); return true; })()`,
    );
    if (clicked !== true) throw new Error("点「核对状态」失败");
    await H.sleep(2500);
    const sess = await createSession(call);
    check(
      "迟到核对后重建草稿仍在（不误删）",
      sess.draft?.userMessage === task2,
      sess.draft?.userMessage ?? null,
    );
    check(
      `受控服务调用数不变（${fx.expectedCalls}）`,
      mock.served() === fx.expectedCalls,
      mock.served(),
    );
  },

  /** A3.7「settled 无身份与 notAccepted 不猜测结果」（同 ID 重复 + 槽忙拒绝） */
  "dup-rejected": async (call, mock) => {
    const fx = fixtureOf("delayedInFlight");
    const task = `${MARK} dup-rejected 受控任务`;
    await createFlow(call, { task });
    const sub = await submitCreateAndCapture(call, "创建");
    check("第一次提交在场", typeof sub.operationId === "string", sub);
    const epochNow = (await opsStatus(call))?.data?.epoch ?? null;
    // ⚠️ OperationIdentitySchema 是 UUID strict——自拼串会被 INVALID_IDENTITY 拒掉
    const secondId = crypto.randomUUID();
    // 在飞期间：第二条 create（新 operationId）被槽拒绝 ⇒ notAccepted、零身份
    const second = await H.appImport(
      call,
      H.STORE_NEEDLE,
      `return JSON.stringify(await window.api.createRun({
         operation: { epoch: ${JSON.stringify(epochNow)}, operationId: ${JSON.stringify(secondId)} },
         request: { systemPrompt: "", userMessage: "${MARK} 第二条不该被执行" },
       }));`,
    );
    dump.second = second;
    check(
      "槽忙 ⇒ 第二主动入口被拒（OPERATION_NOT_ACCEPTED）",
      second?.ok === false && second?.error?.code === "OPERATION_NOT_ACCEPTED",
      second?.error,
    );
    const secondRec = (await recordOf(call, secondId)).rec;
    check(
      "被拒登记 notAccepted（reason=busy）且零身份",
      secondRec?.state === "notAccepted" &&
        secondRec?.rejection === "busy" &&
        (secondRec?.runIds ?? []).length === 0,
      {
        state: secondRec?.state,
        rejection: secondRec?.rejection,
        runIds: secondRec?.runIds,
      },
    );
    // 收口后：同 ID **同请求**重放 ⇒ OPERATION_DUPLICATED（幂等回执，不重复执行）；
    // 同 ID **异请求** ⇒ OPERATION_CONFLICT（U4 6.1 契约，顺带取证）
    await waitForCreateSettled(call, 30000);
    const dupRequest = `{ systemPrompt: "", userMessage: ${JSON.stringify(task)} }`;
    const dup = await H.appImport(
      call,
      H.STORE_NEEDLE,
      `return JSON.stringify(await window.api.createRun({
         operation: { epoch: ${JSON.stringify(epochNow)}, operationId: ${JSON.stringify(sub.operationId)} },
         request: ${dupRequest},
       }));`,
    );
    dump.dup = dup;
    check(
      "同 ID 同请求 ⇒ OPERATION_DUPLICATED 且不回 data",
      dup?.ok === false && dup?.error?.code === "OPERATION_DUPLICATED" && dup?.data === undefined,
      dup?.error,
    );
    const conflict = await H.appImport(
      call,
      H.STORE_NEEDLE,
      `return JSON.stringify(await window.api.createRun({
         operation: { epoch: ${JSON.stringify(epochNow)}, operationId: ${JSON.stringify(sub.operationId)} },
         request: { systemPrompt: "", userMessage: "${MARK} 异请求不该被执行" },
       }));`,
    );
    dump.conflict = conflict;
    check(
      "同 ID 异请求 ⇒ OPERATION_CONFLICT（稳定码，未执行）",
      conflict?.ok === false && conflict?.error?.code === "OPERATION_CONFLICT",
      conflict?.error,
    );
    check(
      `受控服务恰 ${fx.expectedCalls} 次调用（两条都没执行）`,
      mock.served() === fx.expectedCalls,
      mock.served(),
    );
    const reg2 = await recordOf(call, secondId);
    check(
      "notAccepted 记录始终零身份（不猜测结果）",
      (reg2.rec?.runIds ?? []).length === 0,
      reg2.rec?.runIds,
    );
  },

  /**
   * M2.1「首次打开与无运行入口」的实机半边（首次读取迟到不覆盖已进入的创建页）。
   * 诱出机制：`Page.addScriptToEvaluateOnNewDocument` 注入"最早用户"——store 模块
   * 一加载就调 `openCreateWorkspace()`（等价于用户在首读完成前点了「新建运行」），
   * 然后 Page.reload 重放首帧。真实竞速窗口（本地 listRuns 读 208 个文件）在
   * CDP 连接后基本抢不到，注入是这台机器上唯一能稳定站进窗口的合法途径。
   * reload 偶发不换文档（UI-VERIFY 已知坑）⇒ 哨兵核对，不换就重试一次。
   */
  async "first-load-late"(call) {
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.__u562epoch = "sentinel";
        (async () => {
          const deadline = Date.now() + 15000;
          for (;;) {
            // 用 performance entries 找应用自己的 store 模块 URL（两种 root-relative 形态都要认）
            const url = performance.getEntriesByType('resource').map(e => e.name)
              .find(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'));
            if (url !== undefined) {
              try {
                const m = await import(url);
                const s = m.useAppStore.getState();
                window.__u562early = { storeLoaded: true, view: s.view,
                                       listLoaded: s.listLoaded, selectedRunId: s.selectedRunId };
                s.openCreateWorkspace();
                const s2 = m.useAppStore.getState();
                window.__u562early = { storeLoaded: true, view: s2.view,
                                       listLoaded: s2.listLoaded, selectedRunId: s2.selectedRunId };
              } catch (e) {
                window.__u562early = { error: String(e) };
              }
              return;
            }
            if (Date.now() > deadline) { window.__u562early = { error: 'store-url-timeout' }; return; }
            await new Promise((r) => setTimeout(r, 10));
          }
        })();`,
    });
    let changed = false;
    for (let attempt = 0; attempt < 2 && !changed; attempt++) {
      await call("Page.reload", { ignoreCache: true });
      await H.sleep(4500);
      changed =
        (await H.ev(call, '(() => window.__u562epoch === "sentinel")()')) === true &&
        (await H.ev(call, "(() => window.__u562early !== undefined)()")) === true;
      dump[`reloadAttempt${attempt}`] = { changed };
    }
    if (!changed) throw new Error("reload 两次都未换文档（哨兵未出现），本 tag 无法取证");
    const early = await H.ev(call, "(() => JSON.stringify(window.__u562early))()");
    dump.early = JSON.parse(early);
    await H.sleep(2000);
    const after = await H.storeQ(
      call,
      "return JSON.stringify({ view: s.view, listLoaded: s.listLoaded, selectedRunId: s.selectedRunId });",
    );
    dump.after = after;
    check("注入的最早用户在 store 模块加载即进入创建页", dump.early?.view === "create", dump.early);
    check(
      "首读落地后不覆盖已进入的创建页（view 保持 create、selectedRunId 保持空）",
      after.view === "create" && after.selectedRunId === null && after.listLoaded === true,
      after,
    );
    await H.shot(call, SHOT_DIR, `${TAG}-first-load.png`);
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

  // 夹具就绪：重载后等运行列表非空（selectRun / 列表断言依赖）
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

  const fixtureId = TAG_FIXTURE[TAG];
  const mock = await H.prepare(call, fixtureOf(fixtureId).script);
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
