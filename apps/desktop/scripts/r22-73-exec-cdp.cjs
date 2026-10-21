/* eslint-disable */
/**
 * R2.2 任务 7.3 探针（执行与迟到组）：模型失败、响应未知 + renderer 重载、旧成功结果对上新修订、
 * 比较文件视图的迟到正文与单侧错误——全部在真实 Electron + 真 main + 真受控服务上跑。
 *
 * 用法：node apps/desktop/scripts/r22-73-exec-cdp.cjs --tag=<modelfail|reload|staledraft|latecompare>
 * 前置：dev 带 CDP 9612；夹具由 apps/desktop/scripts/r22-73-seed.cjs 造好（.workbuddy/r22-73/seed.json）。
 *
 * 注入手段分列（任务 7.3 的「测试注入与真实故障分列」）：
 * - **真实故障**：受控服务真返回 HTTP 503（走完整 HTTP 栈，非页内 hook）；真磁盘延迟（大文件正文读取）；
 *   真 renderer 重载（`Page.reload` 带换文档哨兵）；真实 blob 缺失（同卷 rename，收尾逐字节还原）。
 * - **测试注入**：`delayMs` 造真在飞窗口（真实 HTTP 延迟，只是时长由剧本给定）；
 *   正文写入走 store 动作 `writeCallDraftText`（与编辑器 onChange 同一实现，键盘面归 7.2）。
 * - 实机无注入面的一档（IPC 响应被篡改/被丢弃）继续按层引用单测，见 compat-inventory §17。
 */
"use strict";
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const R = require("./lib/r22-73-harness.cjs");
const H = R.H;
const { listPageTarget } = require("./editor-collapse-probe.cjs");

const TAG = (process.argv.find((a) => a.startsWith("--tag=")) ?? "").slice("--tag=".length);
const TAGS = ["modelfail", "reload", "staledraft", "latecompare"];
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const checks = [];
const dump = {};
let EXIT_CODE = 2;
function check(name, ok, detail) {
  checks.push({ tag: TAG, name, ok: ok === true, detail: detail ?? null });
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function note(text) {
  console.log(`ℹ ${text}`);
  checks.push({ tag: TAG, name: `[登记] ${text}`, ok: true, note: true });
}
function finish(extra = {}) {
  mkdirSync(R.OUT, { recursive: true });
  const failed = checks.filter((c) => !c.ok && !c.note).length;
  writeFileSync(
    join(R.OUT, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, generatedAt: new Date().toISOString(), checks, failed, dump: { ...dump, ...extra } }, null, 2),
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed} 条`);
  EXIT_CODE = failed === 0 ? 0 : 1;
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 14 分钟未收尾`);
  try {
    writeFileSync(join(R.OUT, `${TAG}-error.txt`), "watchdog timeout");
  } catch {
    /* 忽略 */
  }
  // 阻塞在满管道上时 process.exit 会卡在 stdout flush ⇒ 直接真退（证据文件已落盘）
  if (typeof process.reallyExit === "function") process.reallyExit(3);
  else process.exit(3);
}, 660_000);

const SEED = R.seed();
const ROOT = SEED.root;
const CHILD = SEED.child;
const DRAFT_KEY = { runId: ROOT.id, spanId: ROOT.firstLlmSpanId, field: "system_prompt", mode: "isolated" };
const MOCK_PORT = 18799;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
const EDIT_TEXT = `${SEED.expected.childSystem}\n\n（7.3 执行链受控编辑：真实键盘输入面见 7.2）`;
const LATE_EDIT_TEXT = `${EDIT_TEXT}\n（提交在飞期间尝试写入的较新修订，应被冻结拒绝）`;

/** 提交关联读数（含 U4 身份） */
const submissions = (call) =>
  H.storeQ(
    call,
    `const list = Object.entries(s.draftSubmissions.byId).map(([k, v]) => ({ key: k, channel: v.channel,
       submittedRevision: v.submittedRevision, submittedText: v.submittedText, operationId: v.operationId,
       epoch: v.epoch, target: JSON.stringify(v.target) }));
     return JSON.stringify({ list, nextToken: s.draftSubmissions.nextToken });`,
  );

/** main 登记快照里按 operationId 取记录 */
async function registryRecord(call, operationId) {
  const env = await R.rawIpc(call, "operationsStatus");
  const list = env?.data?.operations ?? [];
  return { epoch: env?.data?.epoch ?? null, record: list.find((r) => r.operationId === operationId) ?? null, count: list.length, activeOperationId: env?.data?.activeOperationId ?? null };
}

/** 打开根实验 → 核对 → 确认 → 授权 → 提交；返回现场与提交关联 */
async function submitExperiment(call, ctx, { editAfterCheck = null } = {}) {
  await R.selectRunAndOverview(call, ROOT.id);
  await R.clickSelector(call, "[data-isolated-prompt-start]", 2600);
  await R.writeDraftText(call, DRAFT_KEY, editAfterCheck ?? EDIT_TEXT);
  await R.writeDraftNotes(call, DRAFT_KEY, { hypothesis: SEED.expected.hypothesis, acceptanceCriterion: SEED.expected.acceptanceCriterion });
  await H.sleep(700);
  const checked = await R.checkAndWait(call);
  const card = await waitSettled(call);
  check("提交前：只读核对成功且默认未确认未授权", checked.ok === true && card.confirm !== null && card.authChecked === false, { checked, confirm: card.confirm, auth: card.authChecked });
  const traceBase = new Set(H.traceIds());
  const servedBase = ctx.mock.served();
  // 三连分开做：先费用确认 + 副本授权（不提交），再单独提交并抓关联。
  // ⚠️ 提交必须只点一次：第二次点会命中「提交进行中：不能重复提交」的禁用态（7.3 首跑判红根因）。
  const flow = await R.confirmAuthorizeSubmit(call, { submit: false });
  check(
    "费用确认与本次副本授权都由本次现场达成",
    String(flow.pressed) === "true" && flow.auth?.ok === true && flow.auth?.checked === true,
    flow,
  );
  const submitAt = Date.now();
  const captured = await R.submitAndCapture(call);
  check("提交按钮在核对+确认+授权齐备后可点，且当场抓到本次提交关联", captured.ok === true && captured.assoc !== null, captured);
  const assoc = captured.assoc ?? null;
  return { flow, captured, assoc, traceBase, servedBase, submitAt, draftBefore: await R.draftState(call, DRAFT_KEY) };
}

async function waitSettled(call, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await R.editorState(call);
    if (!st.checkLabel.includes("正在核对")) return st;
    if (Date.now() > deadline) return st;
    await H.sleep(600);
  }
}

function readTraceLines(id) {
  const { existsSync, readFileSync } = require("node:fs");
  const file = join(R.TRACES, `${id}.jsonl`);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// tag: modelfail —— 真实上游 503：失败只核对可信身份，不清草稿、不自动重发
// ---------------------------------------------------------------------------

async function tagModelFail(call, ctx) {
  const run = await submitExperiment(call, ctx);
  check("提交确实进入在飞（forking=in_progress 或提交关联在场）", run.assoc !== null, { assoc: run.assoc ?? null, exec: await R.execState(call) });

  const settled = await R.waitChildSealed(call, run.traceBase, 120000);
  const lines = settled.id === null ? null : readTraceLines(settled.id);
  dump.mfSettled = { ...settled, lineCount: lines?.length ?? null };
  check("模型失败仍产出真实子记录（meta 先写出，失败落在其后的 llm.call）", settled.id !== null && lines !== null && (lines[0].kind ?? lines[0].type) === "run.meta", { id: settled.id, lines: lines?.length ?? null, firstLine: lines?.[0]?.type ?? null });

  const llm = lines?.find((l) => l.kind === "llm.call") ?? null;
  const terminal = lines?.[lines.length - 1] ?? null;
  dump.mfFailure = { llmError: llm?.error ?? null, terminal, status: lines?.[0]?.status ?? null };
  check(
    "失败按既有 llm.call error / errored 收尾，错误状态如实落盘（不伪造成功）",
    llm?.error !== undefined && llm?.error !== null && terminal?.type === "run.event" && terminal?.event === "errored",
    { error: llm?.error ?? null, terminal },
  );

  const servedDelta = ctx.mock.served() - run.servedBase;
  check("模型失败不重试、不自动重发：本次执行恰一次模型调用", servedDelta === 1, { servedDelta });
  const extra = [...H.traceIds()].filter((x) => !run.traceBase.has(x)).sort();
  check("失败只产出这一条子记录，没有第二条", extra.length === 1 && extra[0] === settled.id, extra);

  const reg = await registryRecord(call, run.assoc?.operationId ?? "");
  dump.mfRegistry = reg;
  check(
    "操作登记只带实际子 ID（三方一致：登记 runIds = 落盘 meta.id = 信封 id）",
    reg.record !== null && Array.isArray(reg.record.runIds) && reg.record.runIds.length === 1 && reg.record.runIds[0] === settled.id,
    { record: reg.record ? { state: reg.record.state, runIds: reg.record.runIds, errorCode: reg.record.errorCode } : null },
  );

  const draft = await R.draftState(call, DRAFT_KEY);
  check("失败不清除草稿：正文、假设/判据与修订原样保留", draft.present === true && draft.text === EDIT_TEXT && draft.hypothesis === SEED.expected.hypothesis, draft);
  const subsAfter = await submissions(call);
  check("失败仍收口本次提交关联（冻结解除，但不删草稿）", !subsAfter.list.some((x) => x.channel === "prompt_experiment"), subsAfter.list);

  const env = await H.storeQ(call, `await s.selectRun(${JSON.stringify(settled.id)}); return JSON.stringify({ ok: true });`);
  await H.sleep(2200);
  const failedView = await H.storeQ(
    call,
    `const d = s.detail; return JSON.stringify({
       detailId: d?.meta?.id ?? null, spans: d?.spans?.length ?? null, status: d?.status ?? null });`,
  );
  const failedText = await R.jev(
    call,
    `(() => (document.querySelector('main')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,420))()`,
  );
  dump.mfFailedView = { env, failedView, failedText };
  check(
    "失败记录可查看：界面按可信 ID 打开该 run 并读到自有轨迹（不因为失败就不存在）",
    failedView.detailId === settled.id && failedView.spans > 0,
    failedView,
  );
  check(
    "失败呈现只复述事实：不把 errored 结局写成已修复，也不自动评分人工判据",
    /失败|错误|出错|未正常|异常|中断|503/.test(failedText) === true && !failedText.includes("已修复"),
    { text: failedText.slice(0, 200) },
  );

  const inv = R.onlyNewRunChanges(ctx.fp, R.fingerprint(), [settled.id]);
  dump.mfInvariant = inv;
  check("数据不变式：失败执行只新增本次子 run，父/兄弟/既有 blob 逐字节不变", inv.ok === true, inv);
}

// ---------------------------------------------------------------------------
// tag: reload —— 响应未知 + renderer 重载：只核对可信身份，不报取消
// ---------------------------------------------------------------------------

async function tagReload(call, ctx) {
  const run = await submitExperiment(call, ctx);
  const during = await R.execState(call);
  check("提交后请求真的在飞（重载前 forking/关联在场）", run.assoc !== null && (during.forking === "in_progress" || during.pending > 0), { assoc: run.assoc?.operationId ?? null, during: { forking: during.forking, pending: during.pending } });

  const reloaded = await R.reloadWithProof(call);
  check("renderer 已重载且证明换了文档（响应未知场景的真实成因）", reloaded.nav != null && reloaded.docs === null, reloaded);

  const regBefore = await registryRecord(call, run.assoc?.operationId ?? "");
  dump.rlRegistryDuringFlight = regBefore;
  const idsOnDisk = new Set(H.traceIds());
  const runIdsBefore = regBefore.record?.runIds ?? [];
  const shaped = runIdsBefore.every((x) => /^run_[a-z0-9]+_[a-z0-9]+$/.test(String(x)));
  check(
    "未知/在飞期间登记只报实际身份：身份是真实 run ID 形状，不出现占位、假 ID 或补出来的第二个身份",
    regBefore.record !== null && (regBefore.record.state === "running" || regBefore.record.state === "settled") && (runIdsBefore.length === 0 || (shaped && runIdsBefore.length === 1)),
    { state: regBefore.record?.state ?? null, runIds: runIdsBefore, shaped, activeOperationId: regBefore.activeOperationId },
  );
  note(
    `在飞期间盘上取证：登记已带身份 ${JSON.stringify(runIdsBefore)}，而该 run 的 trace 文件此刻${runIdsBefore.length > 0 && !runIdsBefore.every((x) => idsOnDisk.has(x)) ? "尚未出现" : "已在盘上"}（span 在 endSpan 整行落盘的既有形态，与 U5 §6.6 记录同形）⇒ 未知期间的定位只能按登记身份，落盘一致性由下一条判据核`,
  );
  check("重载后不把未知当取消：登记状态不是取消语义", String(regBefore.record?.state ?? "") !== "cancelled" && !String(regBefore.record?.errorCode ?? "").toLowerCase().includes("cancel"), regBefore.record ?? null);

  const settled = await R.waitChildSealed(call, run.traceBase, 120000);
  const regAfter = await registryRecord(call, run.assoc?.operationId ?? "");
  const lines = settled.id === null ? null : readTraceLines(settled.id);
  dump.rlAfter = { settled: { ...settled, lineCount: lines?.length ?? null }, regAfter };
  check("重载后仍能按原身份定位真实结果：登记 runIds 与落盘 meta.id 一致", settled.id !== null && (regAfter.record?.runIds ?? []).includes(settled.id), { id: settled.id, runIds: regAfter.record?.runIds ?? [] });

  const recon = await R.rawIpc(call, "operationsReconcile", { epoch: regAfter.epoch, operationId: run.assoc?.operationId ?? "" });
  const servedDelta = ctx.mock.served() - run.servedBase;
  dump.rlReconcile = { recon: recon.data ?? recon, servedDelta };
  check("只读 reconcile 不复活也不重复执行：模型调用数与首次一致", recon.ok === true && servedDelta === (settled.id === null ? 0 : 2), { ok: recon.ok, servedDelta });

  const afterReloadUi = await R.jev(
    call,
    `(() => JSON.stringify({
       cancelText: (document.body.innerText || '').includes('已取消') || (document.body.innerText || '').includes('取消成功'),
       bodyHead: (document.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0,160) }))()`,
  );
  dump.rlAfterReloadUi = afterReloadUi;
  check("重载后的界面不报告取消（未知就是未知）", afterReloadUi.cancelText === false, afterReloadUi);
  const draftAfter = await R.draftState(call, DRAFT_KEY);
  note(`重载后草稿随 renderer 会话内存丢失（既有 U3 口径：会话内恢复）：present=${draftAfter.present}`);

  const inv = R.onlyNewRunChanges(ctx.fp, R.fingerprint(), [settled.id]);
  dump.rlInvariant = inv;
  check("数据不变式：重载链只新增本次子 run 与其写出内容", inv.ok === true, inv);
}

// ---------------------------------------------------------------------------
// tag: staledraft —— 提交在飞时产生新修订：旧成功结果不清新草稿、不抢导航
// ---------------------------------------------------------------------------

async function tagStaleDraft(call, ctx) {
  const run = await submitExperiment(call, ctx);
  const submitted = run.assoc?.submittedRevision ?? null;
  const frozenBefore = await R.draftState(call, DRAFT_KEY);
  await R.writeDraftText(call, DRAFT_KEY, LATE_EDIT_TEXT);
  const afterLateWrite = await R.draftState(call, DRAFT_KEY);
  dump.sdEdit = { submitted, frozenBefore, afterLateWrite };
  check(
    "在飞期间该字段被冻结：改动被 store 拒绝，提交快照就是当场那份（修订不推进）",
    typeof submitted === "number" && frozenBefore.frozen === true && afterLateWrite.revision === submitted && afterLateWrite.text === EDIT_TEXT,
    { submitted, frozen: frozenBefore.frozen, revision: afterLateWrite.revision, textKept: afterLateWrite.text === EDIT_TEXT },
  );
  note("桌面锁的边界实测：改正文被 store 冻结拒绝、换字段被 disabled 拦住 ⇒「提交后新修订 vs 旧成功结果迟到」这一支在 GUI 没有前提");

  // 可达的另一支要看清锁的边界：在飞期间连**换编辑目标**都被禁（字段按钮 disabled），
  // 所以"新修订 vs 旧结果"这一支在桌面根本没有前提；如实按层引用单测。
  const lockState = await R.jev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
         .find(x => (x.textContent||'').trim() === '首条 user message');
       const s = document.querySelector('[data-isolated-prompt-submit-button]');
       return JSON.stringify({ present: b !== undefined && b !== null,
         fieldDisabled: b === undefined || b === null ? null : b.disabled === true,
         submitDisabled: s === null ? null : s.disabled === true,
         submitText: (s?.textContent ?? '').trim().slice(0,30) }); })()`,
  );
  // 同时把阅读目标切到既有 v3 子运行（模拟用户当前阅读意图）
  await H.storeQ(call, `await s.selectRun(${JSON.stringify(CHILD.id)}); return JSON.stringify({ ok: true });`);
  await H.sleep(1200);
  dump.sdLock = lockState;
  check(
    "在飞期间编辑现场整体被锁：换字段被禁、提交按钮转为进行中且不可重复提交",
    lockState.present === true && lockState.fieldDisabled === true && lockState.submitDisabled === true && /提交处理中|提交进行中/.test(lockState.submitText),
    lockState,
  );
  note("「提交后产生新修订而旧成功结果迟到」这一支在桌面不可达：改正文被 store 冻结拒绝、换字段被 disabled 拦住，且响应与终态同刻 ⇒ 该 CAS 分支按层引用 `fork-entry-closure` / `draft-closure-decision` 单测");

  const settled = await R.waitChildSealed(call, run.traceBase, 120000);
  const lines = settled.id === null ? null : readTraceLines(settled.id);
  const terminal = lines?.[lines.length - 1] ?? null;
  dump.sdChild = { ...settled, lineCount: lines?.length ?? null, terminal };
  check("本次提交确实正常结束（迟到的是成功结果，不是失败）", settled.id !== null && terminal?.event === "stopped" && terminal?.reason === "completed", terminal);
  const recorded = lines?.[0]?.fork?.edit?.value ?? null;
  check("实验记录用的是提交时冻结的快照（system_prompt 原提交值，不是后续任何改动）", recorded === EDIT_TEXT, { recordedHead: (recorded ?? "").slice(0, 40), expectedHead: EDIT_TEXT.slice(0, 40) });

  const submittedDraft = await R.draftState(call, DRAFT_KEY);
  dump.sdDrafts = { submittedDraft };
  check("正常收尾按匹配修订清本次提交目标（本案例修订未变 ⇒ 如实清理，不残留冻结）", submittedDraft.present === false, submittedDraft);
  const subs = await submissions(call);
  check("提交关联按身份收口（不残留冻结）", !subs.list.some((x) => x.channel === "prompt_experiment"), subs.list);

  const nav = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId, view: s.view });");
  dump.sdNav = nav;
  check("迟到的正常结果不抢用户当前阅读目标", nav.sel === CHILD.id, nav);

  const inv = R.onlyNewRunChanges(ctx.fp, R.fingerprint(), [settled.id]);
  dump.sdInvariant = inv;
  check("数据不变式：只新增本次子 run 与其写出内容", inv.ok === true, inv);
}

// ---------------------------------------------------------------------------
// tag: latecompare —— 比较文件视图：迟到正文不串页、两侧独立、单侧错误不覆盖
// ---------------------------------------------------------------------------

const BIG = "big.txt";
const FAST = "keep.txt";
const OTHER = "notes.md";
const ONLY_LEFT = "summary.md";

async function tagLateCompare(call, ctx) {
  await R.selectRunAndOverview(call, CHILD.id);
  const opened = await R.openCompareFiles(call, ROOT.id, CHILD.id);
  dump.lcOpen = opened;
  check(
    "默认检查点各取两侧最近自有完成步骤（不是按同轮号强行对齐）",
    opened.st.fileView === true && opened.st.leftCp === ROOT.finalStepId && opened.st.rightCp === CHILD.finalStepId,
    { left: opened.st.leftCp, right: opened.st.rightCp, rows: opened.st.rows.length },
  );
  const rowTexts = opened.st.rows.map((r) => r.text);
  check(
    "路径并集含全部七条（含仅一侧存在的路径）",
    [BIG, FAST, ONLY_LEFT, "child-only.txt", "config.txt", OTHER, "fault.txt"].every((p) => rowTexts.some((t) => t.includes(p))),
    rowTexts,
  );

  // ① 大文件的真实读取时长 = 迟到判据的量尺
  const measure = await R.measureRead(call, BIG);
  dump.lcMeasureBig = measure;
  check(`大文件正文读取确实有可测的在飞窗口（seenLoading=${measure.seenLoading}，实测 ${measure.totalMs}ms）`, measure.ok === true && measure.seenLoading === true, measure);
  const bigModels = await R.diffModels(call);
  dump.lcBigModels = { ok: bigModels.ok, oLen: bigModels.original?.length ?? null, mLen: bigModels.modified?.length ?? null };
  check(
    "对照：选中大文件时其正文标记确实在场（证明后文的缺席判据有牙）",
    bigModels.ok === true && (bigModels.original ?? "").includes("R2273-BIG") && (bigModels.modified ?? "").includes("R2273-BIG"),
    { ok: bigModels.ok, why: bigModels.why ?? null, head: (bigModels.original ?? "").slice(0, 24) },
  );
  check("两侧字节相同的大文件判为 same（不编造差异）", (await R.compareState(call)).conclusion === "same", await R.compareState(call));

  // ⚠️ 同一 (检查点,路径) 已结算时不重发 IPC ⇒ 先切走再切回来，否则"迟到"根本没发生过
  await R.clickPathRow(call, FAST, 1500);
  await R.waitBodySettled(call);

  // ② 真实交错：慢响应在切换之后才落地
  const race = await R.raceSwitch(call, BIG, OTHER);
  dump.lcRace = race;
  check(
    `切换发生在慢读取的在飞窗口内（切换于 ${race.swapAtMs}ms < 慢读实测 ${measure.totalMs}ms ⇒ 旧响应必然迟到）`,
    race.ok === true && race.seenLoading === true && race.swapAtMs !== null && race.swapAtMs < measure.totalMs,
    { race, measure },
  );
  const after = await R.compareState(call);
  const afterModels = await R.diffModels(call);
  dump.lcAfterRace = { after, models: { ok: afterModels.ok, original: afterModels.original, modified: afterModels.modified } };
  check("落定后呈现的是新选择的路径（不是旧响应）", after.pathTitle === OTHER && after.conclusion === "different", { pathTitle: after.pathTitle, conclusion: after.conclusion });
  check(
    "迟到的旧正文不污染新选择：新侧模型里没有大文件标记，且两侧正文就是新路径原文",
    afterModels.ok === true &&
      !(afterModels.original ?? "").includes("R2273-BIG") &&
      !(afterModels.modified ?? "").includes("R2273-BIG") &&
      (afterModels.original ?? "").startsWith("A notes") &&
      (afterModels.modified ?? "") === "C notes, no trailing newline",
    { original: (afterModels.original ?? "").slice(0, 40), modified: (afterModels.modified ?? "").slice(0, 40) },
  );
  check("切换后不留 loading 悬挂（在飞标记已消失）", after.bodyLoading === false && after.manifestLoading === false, after);

  // ③ 两侧检查点独立
  const leftChanged = await R.setCheckpoint(call, "left", "initial");
  await H.sleep(2500);
  const afterLeft = await R.compareState(call);
  dump.lcCheckpoint = { leftChanged, afterLeft };
  check(
    "只改左侧检查点：右侧选择与身份方向不被带动",
    afterLeft.leftCp === "initial" && afterLeft.rightCp === CHILD.finalStepId && afterLeft.pairHead.includes(ROOT.id) && afterLeft.pairHead.includes(CHILD.id),
    afterLeft,
  );

  // ④ 单侧真实故障：藏起仅左侧存在的附件 blob
  const hide = R.makeHandle("hideBlob", SEED.blobs.rootOnlySummary.file);
  const applied = hide.apply();
  dump.lcHide = applied;
  check("真实故障已施加：仅左侧检查点存在的 summary.md blob 不在盘上", applied.existsNow === false && applied.hiddenNow === true, applied);
  await R.setCheckpoint(call, "left", ROOT.finalStepId);
  await H.sleep(2000);
  await R.clickPathRow(call, ONLY_LEFT, 1200);
  const sideState = await R.waitBodySettled(call);
  const sideModels = await R.diffModels(call, 4000);
  const joined = sideState.sideLabels.join(" ");
  dump.lcSideFault = { sideState, sideModels };
  check(
    "单侧读取错误不覆盖另一侧：左侧如实 missing、右侧仍由合法清单证明不存在（不当空侧）",
    sideState.bodyLoading === false && sideState.conclusion === "unavailable" && joined.includes("missing") && joined.includes("not_found"),
    { conclusion: sideState.conclusion, sideLabels: sideState.sideLabels },
  );
  check("错误侧不生成伪文本差异（diff 面板不在场）", sideModels.ok === false, sideModels);
  const restored = hide.end();
  dump.lcRestore = restored;
  check("单侧故障逐字节还原", restored.restored === true && restored.hiddenResidue.length === 0, restored);
  await R.clickSelector(call, "[data-compare-files-refresh]", 2500);
  await R.clickPathRow(call, ONLY_LEFT, 1500);
  const afterRestore = await R.waitBodySettled(call);
  dump.lcAfterRestore = afterRestore;
  check("还原后同一路径重新可读：结论回到 left_only（对照，证明上一条不是恒错）", afterRestore.conclusion === "left_only", afterRestore);

  // ⑤ 交换两侧（store 动作；UI 入口是否在场如实登记）
  const swapUi = await R.jev(
    call,
    `(() => JSON.stringify({ swapButton: Array.from(document.querySelectorAll('button')).some(b => (b.textContent||'').includes('交换') || (b.getAttribute('aria-label')||'').includes('交换')) }))()`,
  );
  const swapped = await H.storeQ(call, `const r = await s.swapCompareSides(); return JSON.stringify({ r, pair: s.comparePair });`);
  await H.sleep(2500);
  let afterSwap = await R.compareState(call);
  if (afterSwap.fileView !== true) {
    // 交换推进阅读代次 ⇒ 文件视图退出比较正文；重新进入后按新 pair 读数（不冒充"一次点击还留在原地"）
    note("交换后文件视图随阅读代次退出 ⇒ 重新进入后取新 pair 现场");
    await H.storeQ(call, `s.openCompareFileView(); return JSON.stringify({ ok: true });`);
    await H.sleep(3000);
    afterSwap = await R.compareState(call);
  }
  dump.lcSwap = { swapUi, swapped, afterSwap };
  check(
    "交换两侧后标题方向随 pair 对调（左=原子、右=根，不出现同侧两个身份）",
    swapped.r === "swapped" && afterSwap.pairHead.startsWith(`左侧 ${CHILD.id}`) && afterSwap.pairHead.includes(`右侧 ${ROOT.id}`),
    { r: swapped.r, head: afterSwap.pairHead.slice(0, 140), fileView: afterSwap.fileView },
  );
  check(
    "交换后新左侧检查点要么合法自有、要么如实标失效并要求显式选点（不自动换点、不按同轮号强行对齐）",
    afterSwap.leftCp === CHILD.finalStepId || afterSwap.leftCp === null || afterSwap.staleDefault.left === true,
    { leftCp: afterSwap.leftCp, rightCp: afterSwap.rightCp, staleDefault: afterSwap.staleDefault },
  );
  if (swapUi.swapButton === false) note("界面无「交换两侧」入口（既有 U7/U8 待定口径）⇒ 本条由 store 动作承载");

  const servedDelta = ctx.mock.served() - ctx.servedBase;
  const extra = [...H.traceIds()].filter((x) => !ctx.traceBase.has(x)).sort();
  check("比较全程只读：零模型调用零子记录", servedDelta === 0 && extra.length === 0, { servedDelta, extra });
  const inv = R.diffFingerprint(ctx.fp, R.fingerprint(), []);
  dump.lcInvariant = inv;
  check("数据不变式：比较视图（含故障注入与还原）逐文件指纹零漂移", inv.unexpected.length === 0, inv);
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

function scriptFor(tag) {
  if (tag === "modelfail") {
    return { turns: [{ mode: "fail", status: 503, errorBody: { error: { message: "R2273 受控 503：上游拒绝" } } }], fallback: { mode: "fail", status: 503 } };
  }
  const slow = { delayMs: tag === "reload" ? 9000 : 7000, toolCalls: [{ id: "x1", name: "write_file", args: JSON.stringify({ path: "late-exec.txt", content: "7.3 在飞执行写出\n" }) }] };
  return { turns: [slow, { content: "已写出 late-exec.txt。" }], fallback: { content: "收尾。" } };
}

async function main() {
  const page = await listPageTarget(9612);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  const reloaded = await R.reloadWithProof(call);
  check("开局哨兵 reload 已证明换了文档", reloaded.nav != null && reloaded.docs === null, reloaded);

  let mock = null;
  const ctx = { mock: null, servedBase: 0, traceBase: new Set(), fp: {} };
  try {
    mock = await H.startMockLlmServer({ port: MOCK_PORT, script: scriptFor(TAG) });
    ctx.mock = mock;
    await H.apiCall(call, "proxyToggle", { enabled: false, port: 18787, upstreamBaseUrl: `http://127.0.0.1:${MOCK_PORT}` });
    await H.apiCall(call, "clearSettings");
    await H.apiCall(call, "saveSettings", { baseURL: MOCK_BASE, apiKey: "sk-r2273-controlled", model: "r2273-control-model" });
    await H.storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
    await H.sleep(1500);
    const ready = await H.storeQ(call, `const ids = s.runs.map(r => r.id); return JSON.stringify({ runs: ids.length, hasRoot: ids.includes(${JSON.stringify(ROOT.id)}), hasChild: ids.includes(${JSON.stringify(CHILD.id)}) });`);
    check("前置：夹具根与 v3 子在场、运行配置就绪", ready.runs > 0 && ready.hasRoot === true && ready.hasChild === true, ready);

    ctx.servedBase = mock.served();
    ctx.traceBase = new Set(H.traceIds());
    ctx.fp = R.fingerprint();

    if (TAG === "modelfail") await tagModelFail(call, ctx);
    else if (TAG === "reload") await tagReload(call, ctx);
    else if (TAG === "staledraft") await tagStaleDraft(call, ctx);
    else await tagLateCompare(call, ctx);
  } catch (e) {
    console.error(`✗ tag ${TAG} 异常：${String(e?.stack ?? e)}`);
    checks.push({ tag: TAG, name: `[异常] ${String(e?.message ?? e).slice(0, 180)}`, ok: false });
  } finally {
    const drained = R.drainActive();
    if (drained.length > 0) {
      console.log(`[兜底还原] ${JSON.stringify(drained)}`);
      dump.drained = drained;
      for (const d of drained) check(`句柄兜底还原 ${d.kind}`, d.restored === true, d);
    }
    await mock?.close?.().catch?.(() => {});
    finish();
    console.log(`[${TAG}] 完成：checks=${checks.length} exit=${EXIT_CODE}`);
    clearTimeout(watchdog);
    try {
      call.ws?.close?.();
    } catch {
      /* 忽略 */
    }
    // ⚠️ 显式收尾：CDP WebSocket 与未释放句柄会把事件轮拖住数分钟（7.3 实测），
    //    批量驱动会因此空等到超时。
    setTimeout(() => {
      if (typeof process.reallyExit === "function") process.reallyExit(EXIT_CODE);
      else process.exit(EXIT_CODE);
    }, 1500);
    process.exitCode = EXIT_CODE;
  }
}

process.on("unhandledRejection", (e) => {
  console.error(`✗ tag ${TAG} 未处理拒绝：${String(e?.stack ?? e)}`);
  try {
    mkdirSync(R.OUT, { recursive: true });
    writeFileSync(join(R.OUT, `${TAG}-error.txt`), String(e?.stack ?? e));
  } catch {
    /* 忽略 */
  }
  process.exit(4);
});

main();
