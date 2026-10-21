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
const LATE_EDIT_TEXT = `${EDIT_TEXT}\n（提交在飞期间的较新修订）`;

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
  const flow = await R.confirmAuthorizeSubmit(call);
  check("费用确认与本次副本授权都由本次现场达成", flow.pressed === "true" && (flow.auth?.checked === true), flow);
  const submitAt = Date.now();
  const submitted = await R.confirmAuthorizeSubmit(call, { authorize: false, submit: true });
  check("提交按钮在核对+确认+授权齐备后转为可点", submitted.ok === true, submitted);
  const subs = await submissions(call);
  const assoc = subs.list.find((x) => x.channel === "prompt_experiment") ?? null;
  return { flow, submitted, subs, assoc, traceBase, servedBase, submitAt, draftBefore: await R.draftState(call, DRAFT_KEY) };
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
  check("模型失败仍产出真实子记录（meta 先写出，失败落在其后的 llm.call）", settled.id !== null && lines !== null && lines[0].kind === "run.meta", { id: settled.id, lines: lines?.length ?? null });

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
  await H.sleep(2000);
  const failedView = await R.jev(
    call,
    `(() => JSON.stringify({
       detailOk: !!document.querySelector('main'),
       text: (document.querySelector('main')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,420),
     }))()`,
  );
  dump.mfFailedView = { env, failedView };
  check(
    "失败记录可查看：界面呈现真实失败事实，不宣称已修复、不评分判据",
    failedView.text.includes(settled.id) && !failedView.text.includes("已修复"),
    failedView,
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
  const fakeIds = (regBefore.record?.runIds ?? []).filter((x) => !idsOnDisk.has(x));
  check(
    "未知/在飞期间登记只报实际身份：要么为空，要么每个 ID 都真在盘上（不补假身份）",
    regBefore.record !== null && fakeIds.length === 0,
    { state: regBefore.record?.state ?? null, runIds: regBefore.record?.runIds ?? [], fakeIds },
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
  const wrote = await R.writeDraftText(call, DRAFT_KEY, LATE_EDIT_TEXT);
  const newerDraft = await R.draftState(call, DRAFT_KEY);
  dump.sdEdit = { submitted, wrote, newerDraft };
  check("在飞期间用户继续编辑：修订推进且提交快照已冻结", typeof submitted === "number" && newerDraft.revision > submitted, { submitted, revision: newerDraft.revision });

  // 同时把阅读目标切到既有 v3 子运行（模拟用户当前阅读意图）
  await H.storeQ(call, `await s.selectRun(${JSON.stringify(CHILD.id)}); return JSON.stringify({ ok: true });`);
  await H.sleep(1200);

  const settled = await R.waitChildSealed(call, run.traceBase, 120000);
  const lines = settled.id === null ? null : readTraceLines(settled.id);
  const terminal = lines?.[lines.length - 1] ?? null;
  dump.sdChild = { ...settled, lineCount: lines?.length ?? null, terminal, editedValue: lines?.[0]?.prompt_experiment?.fork?.edit?.value ?? lines?.[0]?.fork?.edit?.value ?? null };
  check("本次提交确实正常结束（迟到的是成功结果，不是失败）", settled.id !== null && terminal?.event === "stopped" && terminal?.reason === "completed", terminal);
  const recorded = lines?.[0]?.fork?.edit?.value ?? null;
  check("实验记录用的是提交时冻结的快照，不取迟到编辑后的新值", recorded === EDIT_TEXT, { recordedHead: (recorded ?? "").slice(0, 40), expectedHead: EDIT_TEXT.slice(0, 40) });

  const draft = await R.draftState(call, DRAFT_KEY);
  check("旧成功结果不清除较新修订的草稿（正文与修订原样保留）", draft.present === true && draft.text === LATE_EDIT_TEXT && draft.revision === newerDraft.revision, draft);
  const subs = await submissions(call);
  check("提交关联按身份收口（冻结解除，草稿保留）", !subs.list.some((x) => x.channel === "prompt_experiment"), subs.list);

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
  const paths = opened.st.rows.map((r) => r.text.split(" ")[0]);
  check("路径并集含全部七条（含仅一侧存在的路径）", [BIG, FAST, ONLY_LEFT, "child-only.txt", "config.txt", "notes.md", "fault.txt"].every((p) => paths.includes(p)), paths);

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

  // ② 真实交错：慢响应在切换之后才落地
  const race = await R.raceSwitch(call, BIG, FAST);
  dump.lcRace = race;
  check(
    `切换发生在慢读取的在飞窗口内（切换于 ${race.swapAtMs}ms < 慢读实测 ${measure.totalMs}ms ⇒ 旧响应必然迟到）`,
    race.ok === true && race.seenLoading === true && race.swapAtMs !== null && race.swapAtMs < measure.totalMs,
    { race, measure },
  );
  const after = await R.compareState(call);
  const afterModels = await R.diffModels(call);
  dump.lcAfterRace = { after, models: { ok: afterModels.ok, original: afterModels.original, modified: afterModels.modified } };
  check("落定后呈现的是新选择的路径（不是旧响应）", after.pathTitle === FAST && after.conclusion === "same", { pathTitle: after.pathTitle, conclusion: after.conclusion });
  const keepText = SEED.expected.sourceA["keep.txt"] !== undefined ? "keep-A\n" : null;
  check(
    "迟到的旧正文不污染新选择：新侧模型里没有大文件标记，且两侧正文就是新路径原文",
    afterModels.ok === true &&
      !(afterModels.original ?? "").includes("R2273-BIG") &&
      !(afterModels.modified ?? "").includes("R2273-BIG") &&
      (afterModels.original ?? "") === keepText &&
      (afterModels.modified ?? "") === keepText,
    { original: (afterModels.original ?? "").slice(0, 40), modified: (afterModels.modified ?? "").slice(0, 40), keepText },
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
  const swapped = await H.storeQ(call, `const r = await s.swapCompareSides(); return JSON.stringify({ r });`);
  await H.sleep(2500);
  const afterSwap = await R.compareState(call);
  dump.lcSwap = { swapUi, swapped, afterSwap };
  check(
    "交换两侧后身份仍正确：标题左右与选择器各自指向对应 run",
    swapped.r === "swapped" && afterSwap.leftCp === CHILD.finalStepId && afterSwap.rightCp === ROOT.finalStepId,
    { swapUi, swapped, head: afterSwap.pairHead.slice(0, 120) },
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
