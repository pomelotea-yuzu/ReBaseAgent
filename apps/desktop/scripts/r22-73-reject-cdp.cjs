/* eslint-disable */
/**
 * R2.2 任务 7.3 探针（拒绝与降级组）：在真实 Electron 桌面里跑「前置拒绝 / 缺附件 / 缺父 /
 * 非法模式与旧许可」四条链，判据全部来自真 main、真磁盘、真 IPC 与真渲染层。
 *
 * 用法：node apps/desktop/scripts/r22-73-reject-cdp.cjs --tag=<entry|attachment|parent|ipcguard>
 * 前置：dev 带 CDP 9612；夹具由 apps/desktop/scripts/r22-73-seed.cjs 造好（.workbuddy/r22-73/seed.json）。
 *
 * 分层口径（写死，别读成"实机全测了"）：
 * - 本文件只做**不执行**或**执行前被拒**的路径（ipcguard 的判重案例外，它确实执行一次）；
 * - 真键盘与几何面归 7.2；模型失败、在飞重载、迟到正文归 `r22-73-exec-cdp.cjs`；
 * - 「非法请求形状」一律**真 IPC 直调**（不经 store）= 测试注入；
 *   「附件缺失/损坏」「父 trace 缺失」= 真实磁盘故障（同卷 rename / 追加字节，收尾逐字节还原）。
 */
"use strict";
const { randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const R = require("./lib/r22-73-harness.cjs");
const H = R.H;
const { listPageTarget } = require("./editor-collapse-probe.cjs");

const TAG = (process.argv.find((a) => a.startsWith("--tag=")) ?? "").slice("--tag=".length);
const TAGS = ["entry", "attachment", "parent", "ipcguard"];
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const checks = [];
const dump = {};
let EXIT_CODE = 2;
function check(name, ok, detail) {
  checks.push({ tag: TAG, name, ok: ok === true, detail: detail ?? null });
  console.log(
    `${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
}
function note(text) {
  console.log(`ℹ ${text}`);
  checks.push({ tag: TAG, name: `[登记] ${text}`, ok: true, note: true });
}
function finish(extra = {}) {
  mkdirSync(R.OUT, { recursive: true });
  writeFileSync(
    join(R.OUT, `${TAG}-measurements.json`),
    JSON.stringify(
      {
        tag: TAG,
        generatedAt: new Date().toISOString(),
        checks,
        failed: checks.filter((c) => !c.ok && !c.note).length,
        dump: { ...dump, ...extra },
      },
      null,
      2,
    ),
  );
  const failed = checks.filter((c) => !c.ok && !c.note).length;
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed} 条`);
  EXIT_CODE = failed === 0 ? 0 : 1;
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 12 分钟未收尾`);
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
const DRAFT_KEY = {
  runId: ROOT.id,
  spanId: ROOT.firstLlmSpanId,
  field: "system_prompt",
  mode: "isolated",
};
const CHILD_DRAFT_KEY = {
  runId: CHILD.id,
  spanId: CHILD.firstLlmSpanId,
  field: "system_prompt",
  mode: "isolated",
};
const MOCK_PORT = 18799;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
const EDIT_TEXT = `${SEED.expected.childSystem}\n\n（7.3 受控编辑：只为让本次实验不是空编辑；真键盘输入面见 7.2）`;

/** 隔离实验的合法主动请求形状（shared/ipc.ts IsolatedPromptForkRequestSchema） */
function isolatedRequest(input) {
  return {
    executionMode: "isolated",
    parentRunId: input.parentRunId,
    edit: { field: "system_prompt", value: input.editValue },
    allowFileWrites: true,
    expectedConfigRevision: input.configRevision,
    expectedPlanFingerprint: input.planFingerprint,
    hypothesis: SEED.expected.hypothesis,
    acceptanceCriterion: SEED.expected.acceptanceCriterion,
  };
}

/** 本 tag 起点之后的执行增量：模型调用数与新 trace（拒绝必须两面都零） */
function execDelta(ctx) {
  return {
    served: ctx.mock.served() - ctx.servedBase,
    traces: [...H.traceIds()].filter((x) => !ctx.traceBase.has(x)).sort(),
  };
}

/** main 登记快照里按 operationId 取记录（真 IPC，不经 renderer） */
async function registryRecord(call, operationId) {
  const env = await R.rawIpc(call, "operationsStatus");
  const list = env?.data?.operations ?? [];
  return {
    slot: {
      epoch: env?.data?.epoch ?? null,
      activeOperationId: env?.data?.activeOperationId ?? null,
      configurationBusy: env?.data?.configurationBusy ?? null,
    },
    record: list.find((r) => r.operationId === operationId) ?? null,
    count: list.length,
  };
}

/** 点核对后等它落定（在飞文案消失），返回编辑器现场 */
async function waitSettledCheck(call, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await R.editorState(call);
    if (!st.checkLabel.includes("正在核对")) return st;
    if (Date.now() > deadline) return st;
    await H.sleep(700);
  }
}

/** 打开根实验编辑器并写入受控正文（正文走 store 动作，与 onChange 同一实现） */
async function openRootEditor(call, { withNotes = false } = {}) {
  await R.selectRunAndOverview(call, ROOT.id);
  const opened = await R.clickSelector(call, "[data-isolated-prompt-start]", 2600);
  const state = await R.editorState(call);
  if (state.editorOpen !== true)
    throw new Error(`隔离编辑器未打开：${JSON.stringify({ opened, state })}`);
  await R.writeDraftText(call, DRAFT_KEY, EDIT_TEXT);
  if (withNotes) {
    await R.writeDraftNotes(call, DRAFT_KEY, {
      hypothesis: SEED.expected.hypothesis,
      acceptanceCriterion: SEED.expected.acceptanceCriterion,
    });
  }
  await H.sleep(700);
  return { opened, state, draft: await R.draftState(call, DRAFT_KEY) };
}

// ---------------------------------------------------------------------------
// tag: entry —— 既有入口可达 + 隔离父本的其他真执行入口 + 分支显式回根
// ---------------------------------------------------------------------------

async function tagEntry(call, ctx) {
  const before = await R.jev(
    call,
    `(() => JSON.stringify({
       rootEntry: !!document.querySelector('[data-isolated-prompt-entry="root"]'),
       start: !!document.querySelector('[data-isolated-prompt-start]'),
       branch: !!document.querySelector('[data-isolated-prompt-entry="branch"]'),
     }))()`,
  );
  await R.selectRunAndOverview(call, ROOT.id);
  const head = await R.jev(
    call,
    `(() => JSON.stringify({
       rootEntry: !!document.querySelector('[data-isolated-prompt-entry="root"]'),
       start: !!document.querySelector('[data-isolated-prompt-start]'),
       entryText: (document.querySelector('[data-isolated-prompt-entry="root"]')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,200),
     }))()`,
  );
  dump.entryHead = { before, head };
  check(
    "根概览给独立「修改启动指令」入口（隔离根不套用普通 prompt 编辑器）",
    head.rootEntry === true && head.start === true,
    head,
  );

  const opened = await openRootEditor(call);
  const isolatedEditor = await R.jev(
    call,
    `(() => JSON.stringify({
       isolatedRootAnchor: !!document.querySelector('[data-isolated-prompt-root]'),
       headText: (document.querySelector('[data-isolated-prompt-root]')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,200),
       checkLabel: (document.querySelector('[data-isolated-prompt-check-button]')?.textContent ?? '').trim(),
     }))()`,
  );
  dump.entryEditor = { opened, isolatedEditor };
  check(
    "进入的是隔离实验现场：页头绑定根运行与首次调用，先只读核对后才谈执行",
    isolatedEditor.isolatedRootAnchor === true && isolatedEditor.headText.includes(ROOT.id),
    isolatedEditor,
  );

  // 首次 llm.call 详情：隔离父本的 A-B 入口显示「本期不支持」
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(ROOT.id)}, "steps"); return JSON.stringify({ ok: true });`,
  );
  await H.sleep(1500);
  const spanClick = await R.jev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.title || '') === 'LLM 调用' && x.closest('header') === null);
       if (!b) return JSON.stringify({ ok: false, why: 'no-llm-row' });
       b.click(); return JSON.stringify({ ok: true }); })()`,
  );
  await H.sleep(1800);
  const sel = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedSpanId });");
  const detail = await R.jev(
    call,
    `(() => JSON.stringify({
       unsupportedPresent: !!document.querySelector('[data-isolated-parent-unsupported]'),
       unsupported: (document.querySelector('[data-isolated-parent-unsupported]')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,220),
     }))()`,
  );
  dump.entrySpanDetail = { spanClick, sel, detail };
  check(
    "隔离父本的模型 A/B 入口如实显示本期不支持",
    detail.unsupportedPresent === true && /A\/B|模型/.test(detail.unsupported),
    { sel, detail },
  );

  const epoch = await R.currentEpoch(call);
  const abEnv = await R.rawIpc(call, "modelAb", {
    operation: { epoch, operationId: randomUUID() },
    request: {
      parentRunId: ROOT.id,
      arms: [
        { model: "r2273-arm-a", params: {} },
        { model: "r2273-arm-b", params: {} },
      ],
    },
  });
  const deltaAb = execDelta(ctx);
  dump.entryAb = { abEnv, deltaAb };
  check(
    "隔离根作 A-B 父本：真 IPC 在 main 侧同样被拒且零调用零子记录",
    abEnv.ok === false && deltaAb.served === 0 && deltaAb.traces.length === 0,
    {
      code: abEnv.error?.code ?? null,
      message: (abEnv.error?.message ?? "").slice(0, 140),
      delta: deltaAb,
    },
  );

  const plainEnv = await R.rawIpc(call, "promptFork", {
    operation: { epoch, operationId: randomUUID() },
    request: {
      parentRunId: ROOT.id,
      edit: { field: "system_prompt", value: `${SEED.expected.rootSystem}（普通降级尝试）` },
    },
  });
  const deltaPlain = execDelta(ctx);
  dump.entryPlain = { plainEnv, deltaPlain };
  check(
    "隔离父本不能转普通 prompt fork：拒绝且不落到普通 handler",
    plainEnv.ok === false && deltaPlain.served === 0 && deltaPlain.traces.length === 0,
    {
      code: plainEnv.error?.code ?? null,
      message: (plainEnv.error?.message ?? "").slice(0, 160),
      delta: deltaPlain,
    },
  );

  // 分支入口（v3 实验子）：只有经验证根的显式导航
  await R.selectRunAndOverview(call, CHILD.id);
  const branch = await R.jev(
    call,
    `(() => JSON.stringify({
       branchEntry: !!document.querySelector('[data-isolated-prompt-entry="branch"]'),
       goto: !!document.querySelector('[data-isolated-prompt-goto-root]'),
       startButton: !!document.querySelector('[data-isolated-prompt-start]'),
       reason: (document.querySelector('[data-isolated-prompt-entry="branch"]')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,260),
     }))()`,
  );
  dump.entryBranch = branch;
  check(
    "v3 分支入口只有「前往根运行」：不给根编辑按钮，也不把分支消息当根启动上下文",
    branch.branchEntry === true &&
      branch.goto === true &&
      branch.startButton === false &&
      branch.reason.includes("分支"),
    branch,
  );

  const clicked = await R.clickSelector(call, "[data-isolated-prompt-goto-root]", 2800);
  const afterNav = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId });");
  const navDelta = execDelta(ctx);
  const childDraft = await R.draftState(call, CHILD_DRAFT_KEY);
  dump.entryNavigation = { clicked, afterNav, navDelta, childDraft };
  check("点「前往根运行」经只读预检核实后落到经验证的根", afterNav.sel === ROOT.id, {
    clicked,
    afterNav,
  });
  check(
    "根导航只读：零模型调用零子记录",
    navDelta.served === 0 && navDelta.traces.length === 0,
    navDelta,
  );
  check("导航不自动搬草稿：分支侧没有隔离草稿条目", childDraft.present === false, childDraft);

  // 旧入口回归
  const openCreate = await R.jev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('header button')).find(x => (x.textContent||'').trim() === '新建运行');
       if (!b) return JSON.stringify({ ok: false, why: 'no-globalbar-create' }); b.click(); return JSON.stringify({ ok: true }); })()`,
  );
  await H.sleep(1600);
  const createView = await R.jev(
    call,
    `(() => JSON.stringify({ createSection: !!document.querySelector('[aria-label="新建运行"]'),
       headings: (document.querySelector('[aria-label="新建运行"]')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,120) }))()`,
  );
  dump.entryCreate = { openCreate, createView };
  check(
    "全局栏「新建运行」仍打开同一个创建工作区（新分支没吃掉旧入口）",
    createView.createSection === true,
    createView,
  );

  const openSettings = await R.jev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('header button')).find(x => (x.textContent||'').trim() === '运行配置');
       if (!b) return JSON.stringify({ ok: false, why: 'no-settings-button' }); b.click(); return JSON.stringify({ ok: true }); })()`,
  );
  await H.sleep(1500);
  const dialogs = await R.jev(call, `(() => document.querySelectorAll('dialog[open]').length)()`);
  dump.entrySettings = { openSettings, dialogs };
  check("设置入口仍打开既有模态（可用、可关、不写数据）", dialogs >= 1, dialogs);
  await R.jev(
    call,
    `(() => { const d = Array.from(document.querySelectorAll('dialog[open]')).pop();
       if (d) d.close(); return JSON.stringify({ closed: !!d }); })()`,
  );
  await H.sleep(900);

  const zero = execDelta(ctx);
  check(
    "入口遍历全程零执行（不点提交就没有任何模型调用与子记录）",
    zero.served === 0 && zero.traces.length === 0,
    zero,
  );
  const inv = R.diffFingerprint(ctx.fp, R.fingerprint(), []);
  dump.entryInvariant = inv;
  check("数据不变式：入口遍历不写任何文件", inv.unexpected.length === 0, inv);
}

// ---------------------------------------------------------------------------
// tag: attachment —— 真实磁盘故障：初始快照附件缺失 / 损坏
// ---------------------------------------------------------------------------

async function tagAttachment(call, ctx) {
  await openRootEditor(call, { withNotes: true });

  const okCheck = await R.checkAndWait(call);
  const healthyCard = await waitSettledCheck(call);
  const healthyCap = await R.rawIpc(call, "isolatedPromptCapability", {
    rootRunId: ROOT.id,
    edit: { field: "system_prompt", value: EDIT_TEXT },
    hypothesis: SEED.expected.hypothesis,
    acceptanceCriterion: SEED.expected.acceptanceCriterion,
  });
  ctx.healthyPlan = healthyCap?.data?.planFingerprint ?? null;
  ctx.healthyRevision = healthyCap?.data?.configRevision ?? null;
  dump.attHealthy = {
    okCheck,
    healthyCard,
    plan: ctx.healthyPlan?.slice(0, 18),
    rev: ctx.healthyRevision?.slice(0, 18),
  };
  note(
    `健康核对实测：seenInFlight=${okCheck.seenInFlight}，本次核对往返 ${okCheck.elapsedMs ?? "n/a"}ms`,
  );
  check(
    "对照：附件完好时只读核对成功并给出可确认卡（费用确认与副本授权默认未选）",
    healthyCard.confirm !== null &&
      healthyCard.confirm.pressed !== "true" &&
      healthyCard.authChecked === false &&
      healthyCard.submitDisabled === true,
    healthyCard,
  );

  const hide = R.makeHandle("hideBlob", SEED.blobs.initialFault.file);
  const applied = hide.apply();
  dump.attHide = applied;
  check(
    "真实故障已施加：初始快照内 fault.txt 的 blob 不在盘上（同卷改名，未删除）",
    applied.existsNow === false && applied.hiddenNow === true,
    applied,
  );

  await R.clickSelector(call, "[data-isolated-prompt-check-button]", 1500);
  const missing = await waitSettledCheck(call);
  dump.attMissing = missing;
  check(
    "缺附件：核对如实返回 attachment_missing 并说明原因（不拿当前源目录冒充历史快照）",
    missing.unavailableCard.includes("attachment_missing") &&
      missing.unavailableCard.includes("核对未通过"),
    missing,
  );
  check(
    "缺附件：不给费用确认、不给副本授权、提交不可达",
    missing.confirm === null &&
      missing.authPresent === false &&
      (missing.submitPresent === false || missing.submitDisabled === true),
    missing,
  );
  const deltaMissing = execDelta(ctx);
  check(
    "缺附件拒绝零执行：零模型调用零子记录",
    deltaMissing.served === 0 && deltaMissing.traces.length === 0,
    deltaMissing,
  );

  // 带着健康时拿到的计划提交（提交会重跑预检）
  const opId = randomUUID();
  const epoch = await R.currentEpoch(call);
  const submitEnv = await R.rawIpc(call, "promptFork", {
    operation: { epoch, operationId: opId },
    request: isolatedRequest({
      parentRunId: ROOT.id,
      editValue: EDIT_TEXT,
      planFingerprint: ctx.healthyPlan,
      configRevision: ctx.healthyRevision,
    }),
  });
  const deltaSubmit = execDelta(ctx);
  const reg = await registryRecord(call, opId);
  dump.attSubmitReject = { submitEnv, deltaSubmit, reg };
  check(
    "旧计划在附件失效后提交被拒（提交时重跑预检，不把只读结论当执行凭证）",
    submitEnv.ok === false &&
      String(submitEnv.error?.code ?? "").includes("ATTACHMENT_MISSING") &&
      deltaSubmit.served === 0 &&
      deltaSubmit.traces.length === 0,
    {
      code: submitEnv.error?.code ?? null,
      message: (submitEnv.error?.message ?? "").slice(0, 160),
      delta: deltaSubmit,
    },
  );
  check(
    "受理后的拒绝保留真实登记：settled 且 runIds 为空（不是伪造的子 run）",
    submitEnv.operation !== null &&
      reg.record !== null &&
      reg.record.state === "settled" &&
      (reg.record.runIds ?? []).length === 0 &&
      reg.record.errorCode !== null,
    { ack: submitEnv.operation ?? null, record: reg.record ?? null },
  );

  const restored = hide.end();
  dump.attRestore = restored;
  check(
    "缺附件故障逐字节还原（哈希回到施加前、无隐藏残留）",
    restored.restored === true && restored.hiddenResidue.length === 0,
    restored,
  );

  await R.clickSelector(call, "[data-isolated-prompt-check-button]", 1500);
  const afterRestore = await waitSettledCheck(call);
  dump.attAfterRestore = afterRestore;
  check(
    "还原后同一通道重新核对成功（证明上一条不是恒拒）",
    afterRestore.confirm !== null && afterRestore.unavailableCard === "",
    afterRestore,
  );
  await R.shot(call, "attachment-restored");

  const corrupt = R.makeHandle("corruptBlob", SEED.blobs.initialFault.file);
  const cApplied = corrupt.apply();
  dump.attCorrupt = { bytesBefore: cApplied.before.slice(0, 12), bytesNow: cApplied.bytesNow };
  check(
    "损坏故障已施加：blob 字节数变大而目标仍在盘上",
    cApplied.existsNow === true && cApplied.bytesNow > cApplied.original.length,
    cApplied,
  );
  await R.clickSelector(call, "[data-isolated-prompt-check-button]", 1500);
  const corruptState = await waitSettledCheck(call);
  dump.attCorruptState = corruptState;
  check(
    "损坏附件给出可区分原因 attachment_corrupt（与缺失不同码，也不静默补写覆盖）",
    corruptState.unavailableCard.includes("attachment_corrupt"),
    corruptState,
  );
  const cRestore = corrupt.end();
  dump.attCorruptRestore = cRestore;
  check("损坏故障逐字节还原（应用侧未覆盖共享内容）", cRestore.restored === true, cRestore);

  const zero = execDelta(ctx);
  check("附件故障全程零执行", zero.served === 0 && zero.traces.length === 0, zero);
  const inv = R.diffFingerprint(ctx.fp, R.fingerprint(), []);
  dump.attInvariant = inv;
  check("数据不变式：注入与还原后逐文件指纹零漂移", inv.unexpected.length === 0, inv);
}

// ---------------------------------------------------------------------------
// tag: parent —— 缺父链：自有轨迹仍可读、不猜根、不降级
// ---------------------------------------------------------------------------

async function tagParent(call, ctx) {
  const traceFile = join(R.TRACES, `${ROOT.id}.jsonl`);
  check("夹具根 trace 在盘上（施加前自证）", existsSync(traceFile), traceFile);

  await R.selectRunAndOverview(call, CHILD.id);
  const healthy = await R.jev(
    call,
    `(() => JSON.stringify({
       goto: !!document.querySelector('[data-isolated-prompt-goto-root]'),
       error: (document.querySelector('[data-isolated-prompt-root-error]')?.textContent ?? '').trim().slice(0,200),
     }))()`,
  );
  dump.parentHealthy = healthy;
  check(
    "对照：父链完整时分支入口的「前往根运行」在场且无报错",
    healthy.goto === true && healthy.error === "",
    healthy,
  );

  const hide = R.makeHandle("hideTrace", traceFile);
  const applied = hide.apply();
  dump.parentHide = applied;
  check(
    "真实缺父已施加：根 trace 同卷隐藏（不是改字段伪造）",
    applied.existsNow === false && applied.hiddenNow === true,
    applied,
  );

  await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
  await H.sleep(1200);
  // 强制重读详情：selectRun 对"已选中"不重新取详情 ⇒ 先切到别的 run 再切回来（否则读到施加故障前的缓存）
  const otherId = await H.storeQ(
    call,
    `const ids = s.runs.map(r => r.id).filter(x => x !== ${JSON.stringify(CHILD.id)} && x !== ${JSON.stringify(ROOT.id)});
     return JSON.stringify({ other: ids[0] ?? null });`,
  );
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(otherId.other)}); return JSON.stringify({ ok: true });`,
  );
  await H.sleep(1500);
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(CHILD.id)}); return JSON.stringify({ ok: true });`,
  );
  await H.sleep(2200);
  const ownDetail = await H.storeQ(
    call,
    `const d = s.detail; return JSON.stringify({ hasDetail: d !== null, id: d?.meta?.id ?? null,
       spans: d?.spans?.length ?? null, lineageStatus: d?.lineage?.status ?? null,
       missingRunId: d?.lineage?.missingRunId ?? null,
       overviewText: (document.querySelector('main')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,160) });`,
  );
  // main 侧未加工读数（不经 renderer 缓存）：自有可读 + 缺失祖先如实标注
  const rawRun = await R.rawIpc(call, "getRun", CHILD.id);
  const rawLineage = {
    ok: rawRun?.ok ?? null,
    id: rawRun?.data?.meta?.id ?? null,
    spans: rawRun?.data?.spans?.length ?? null,
    status: rawRun?.data?.lineage?.status ?? null,
    missingRunId: rawRun?.data?.lineage?.missingRunId ?? null,
    completeness: rawRun?.data?.completeness ?? null,
  };
  dump.parentOwn = { ownDetail, rawLineage, otherId };
  check(
    "缺父时自有轨迹仍可读：界面自有 spans 完整（不被整链失败拖成不可读）",
    ownDetail.hasDetail === true && ownDetail.id === CHILD.id && ownDetail.spans > 0,
    ownDetail,
  );
  check(
    "缺失祖先如实标注：renderer 与 main 未加工读数都给出 lineage=incomplete + missingRunId=根",
    ownDetail.lineageStatus === "incomplete" &&
      ownDetail.missingRunId === ROOT.id &&
      rawLineage.status === "incomplete" &&
      rawLineage.missingRunId === ROOT.id,
    {
      ui: { status: ownDetail.lineageStatus, missingRunId: ownDetail.missingRunId },
      main: rawLineage,
    },
  );

  const blocked = await R.clickSelector(call, "[data-isolated-prompt-goto-root]", 2600);
  const errorText = await R.jev(
    call,
    `(() => (document.querySelector('[data-isolated-prompt-root-error]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,240))()`,
  );
  const stillChild = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId });");
  dump.parentBlocked = { blocked, errorText, stillChild };
  check(
    "缺父链不猜根：报错留在原位、不换目标、不自动开编辑",
    errorText.length > 0 && stillChild.sel === CHILD.id,
    { errorText, stillChild },
  );

  const capEnv = await R.rawIpc(call, "isolatedPromptCapability", {
    rootRunId: CHILD.id,
    edit: { field: "system_prompt", value: "探测用（不作为编辑值）" },
  });
  const capData = capEnv?.data ?? {};
  const zeroDelta = execDelta(ctx);
  dump.parentCapability = { capEnv, zeroDelta };
  check(
    "分支作为根请求预检：返回不可执行原因且不给 rootId（无导航建议即不导航）",
    capEnv.ok === true &&
      capData.status === "unavailable" &&
      capData.rootId === undefined &&
      typeof capData.code === "string",
    capData,
  );
  check(
    "缺父路径零执行：零模型调用零子记录",
    zeroDelta.served === 0 && zeroDelta.traces.length === 0,
    zeroDelta,
  );

  const restored = hide.end();
  dump.parentRestore = restored;
  check(
    "根 trace 逐字节还原",
    restored.restored === true && restored.hiddenResidue.length === 0,
    restored,
  );
  await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
  await R.selectRunAndOverview(call, CHILD.id);
  await R.clickSelector(call, "[data-isolated-prompt-goto-root]", 2800);
  const afterRestore = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId });");
  dump.parentAfterRestore = afterRestore;
  check(
    "还原后同一入口恢复可用：显式导航落到经验证的根（对照：上一条不是恒拒）",
    afterRestore.sel === ROOT.id,
    afterRestore,
  );

  const inv = R.diffFingerprint(ctx.fp, R.fingerprint(), []);
  dump.parentInvariant = inv;
  check(
    "数据不变式：缺父注入与还原只动过又被换回",
    inv.unexpected.length === 0 && inv.added.length === 0,
    inv,
  );
}

// ---------------------------------------------------------------------------
// tag: ipcguard —— 非法模式 / 伪造字段 / 空编辑 / 旧修订 / 旧指纹 / 判重 / 未知操作
// ---------------------------------------------------------------------------

async function submitCase(call, ctx, label, wrapper, expect) {
  const operationId = randomUUID();
  const epoch =
    wrapper.staleEpoch === true
      ? "00000000-0000-4000-8000-000000000000"
      : await R.currentEpoch(call);
  const envelope = await R.rawIpc(call, "promptFork", {
    operation: { epoch, operationId },
    request: wrapper.request,
  });
  const delta = execDelta(ctx);
  const reg = await registryRecord(call, operationId);
  dump[`case-${label}`] = { envelope, delta, reg };
  const code = String(envelope.error?.code ?? "");
  check(
    `${label}：提交被拒（${expect.codeIncludes ?? "非 ok"}）且零模型调用零子记录`,
    envelope.ok === false &&
      delta.served === 0 &&
      delta.traces.length === 0 &&
      code.includes(expect.codeIncludes ?? "") === true,
    { code: code || null, message: (envelope.error?.message ?? "").slice(0, 150), delta },
  );
  check(
    `${label}：登记形状符合 U4——${expect.preExecutionNull ? "受理前拒绝无登记（operation 为 null）" : "受理后拒绝有登记且 runIds 为空"}`,
    expect.preExecutionNull
      ? envelope.operation == null && reg.record === null
      : envelope.operation != null && (reg.record?.runIds ?? []).length === 0,
    {
      ack: envelope.operation ?? null,
      record: reg.record
        ? { state: reg.record.state, runIds: reg.record.runIds, errorCode: reg.record.errorCode }
        : null,
    },
  );
  return envelope;
}

async function tagIpcguard(call, ctx) {
  await openRootEditor(call, { withNotes: true });
  const checked = await R.checkAndWait(call);
  const capEnv = await R.rawIpc(call, "isolatedPromptCapability", {
    rootRunId: ROOT.id,
    edit: { field: "system_prompt", value: EDIT_TEXT },
    hypothesis: SEED.expected.hypothesis,
    acceptanceCriterion: SEED.expected.acceptanceCriterion,
  });
  ctx.healthyPlan = capEnv?.data?.planFingerprint ?? null;
  ctx.healthyRevision = capEnv?.data?.configRevision ?? null;
  dump.ipcGuardPlan = {
    checked,
    plan: ctx.healthyPlan?.slice(0, 18),
    rev: ctx.healthyRevision?.slice(0, 18),
    status: capEnv?.data?.status,
  };
  check(
    "合法根的只读能力预检返回计划指纹与 main 配置修订（后续各案的基线）",
    capEnv.ok === true &&
      capEnv.data?.status === "ok" &&
      typeof ctx.healthyPlan === "string" &&
      typeof ctx.healthyRevision === "string",
    dump.ipcGuardPlan,
  );
  const planDelta = execDelta(ctx);
  check(
    "只读预检无副作用：零调用零子记录、也不登记操作",
    planDelta.served === 0 && planDelta.traces.length === 0,
    planDelta,
  );

  // over 里的 editValue/planFingerprint/configRevision/parentRunId 是**构造入参**，
  // 其余键当作顶层多余字段（伪造字段案就用这个）——两者不能混在一个展开里，
  // 否则 editValue 会变成请求的多余键，strict schema 直接 unrecognized_keys（7.3 首跑判红根因）。
  const valid = (over = {}) => {
    const { editValue, planFingerprint, configRevision, parentRunId, ...extras } = over;
    const req = isolatedRequest({
      parentRunId: parentRunId ?? ROOT.id,
      editValue: editValue ?? EDIT_TEXT,
      planFingerprint: planFingerprint ?? ctx.healthyPlan,
      configRevision: configRevision ?? ctx.healthyRevision,
    });
    return { ...req, ...extras };
  };
  const drop = (key) => {
    const r = valid();
    delete r[key];
    return r;
  };

  await submitCase(
    call,
    ctx,
    "缺本次副本写入授权",
    { request: drop("allowFileWrites") },
    { codeIncludes: "INVALID", preExecutionNull: true },
  );
  await submitCase(
    call,
    ctx,
    "副本授权为 false",
    { request: valid({ allowFileWrites: false }) },
    { codeIncludes: "INVALID", preExecutionNull: true },
  );
  await submitCase(
    call,
    ctx,
    "renderer 伪造模型/物理路径字段",
    { request: { ...valid(), model: "evil-model", dataDir: "D:/tmp", sourcePath: "C:/Windows" } },
    { codeIncludes: "INVALID", preExecutionNull: true },
  );
  await submitCase(
    call,
    ctx,
    "一次改两个字段",
    {
      request: {
        ...valid(),
        edit: { field: "system_prompt", value: EDIT_TEXT, extraValue: "顺手改 user" },
      },
    },
    { codeIncludes: "INVALID", preExecutionNull: true },
  );
  await submitCase(
    call,
    ctx,
    "缺 executionMode 的隔离请求落到普通分支",
    { request: { parentRunId: ROOT.id, edit: { field: "system_prompt", value: EDIT_TEXT } } },
    { preExecutionNull: false },
  );
  await submitCase(
    call,
    ctx,
    "旧 main 会话 epoch",
    { request: valid(), staleEpoch: true },
    { codeIncludes: "STALE", preExecutionNull: true },
  );
  await submitCase(
    call,
    ctx,
    "空编辑（与原值逐字相同）",
    { request: valid({ editValue: SEED.expected.rootSystem }) },
    { codeIncludes: "EMPTY_EDIT", preExecutionNull: false },
  );
  await submitCase(
    call,
    ctx,
    "非根作根（v3 实验子）",
    { request: valid({ parentRunId: CHILD.id }) },
    { codeIncludes: "PARENT_NOT_ROOT", preExecutionNull: false },
  );
  await submitCase(
    call,
    ctx,
    "配置修订已变化",
    { request: valid({ configRevision: "rev-obsolete" }) },
    { codeIncludes: "CONFIG_CHANGED", preExecutionNull: false },
  );
  await submitCase(
    call,
    ctx,
    "计划指纹不符",
    { request: valid({ planFingerprint: `sha256:${"0".repeat(64)}` }) },
    { codeIncludes: "PLAN_CHANGED", preExecutionNull: false },
  );

  // 判重：同 operationId 同参重发。先取一份**当前**配置修订（上一案之后配置未变，这里再取一次防漂移）
  const freshCap = await R.rawIpc(call, "isolatedPromptCapability", {
    rootRunId: ROOT.id,
    edit: { field: "system_prompt", value: EDIT_TEXT },
    hypothesis: SEED.expected.hypothesis,
    acceptanceCriterion: SEED.expected.acceptanceCriterion,
  });
  const fresh = isolatedRequest({
    parentRunId: ROOT.id,
    editValue: EDIT_TEXT,
    planFingerprint: freshCap.data.planFingerprint,
    configRevision: freshCap.data.configRevision,
  });
  const epoch = await R.currentEpoch(call);
  const dupId = randomUUID();
  const first = await R.rawIpc(call, "promptFork", {
    operation: { epoch, operationId: dupId },
    request: fresh,
  });
  const second = await R.rawIpc(call, "promptFork", {
    operation: { epoch, operationId: dupId },
    request: fresh,
  });
  const dupDelta = execDelta(ctx);
  const dupReg = await registryRecord(call, dupId);
  const dupChild = first.ok === true ? (first.data?.id ?? null) : null;
  dump.ipcGuardDuplicate = { first, second, dupDelta, dupReg, dupChild };
  check(
    "同 ID 同参重发按 U4 判重：第二次明确「未重复执行」",
    first.ok === true &&
      second.ok === false &&
      String(second.error?.code ?? "").includes("DUPLICATED"),
    { firstOk: first.ok, secondCode: second.error?.code ?? null },
  );
  check(
    "判重不产生重复子记录：只新增一次执行的子 run",
    dupDelta.traces.length === 1 && dupDelta.traces[0] === dupChild,
    dupDelta,
  );

  // 未知但合法的 operationId 只读核对
  const unknownId = randomUUID();
  const recon = await R.rawIpc(call, "operationsReconcile", { epoch, operationId: unknownId });
  const afterRecon = execDelta(ctx);
  dump.ipcGuardReconcile = { recon, afterRecon };
  check(
    "未知操作只读核对：返回真实/封禁事实，不补身份、不新增执行",
    recon.ok === true && afterRecon.traces.length === dupDelta.traces.length,
    { code: recon.error?.code ?? null, data: recon.data?.operation ?? recon.data ?? null },
  );

  // ⑪ 迟到核对：响应落地时草稿修订已推进 ⇒ 旧结论只能是"失效提示"，不能安装成可执行卡
  const LATE_TEXT = `${EDIT_TEXT}\n（核对在飞期间推进的修订）`;
  const late = await R.checkThenEdit(call, DRAFT_KEY, LATE_TEXT);
  const lateState = await waitSettledCheck(call);
  dump.ipcGuardLateCheck = { late, lateState };
  note(
    `迟到核对实测：看见在飞=${late.seenInFlight}，改动于 ${late.editedAtMs}ms（触发方式=${late.editTrigger}），核对往返 ${late.elapsedMs}ms`,
  );
  check(
    "迟到核对不装旧计划：修订已推进时只给「需重新核对」的失效提示，费用确认/副本授权/提交都不在场",
    lateState.stale === true &&
      lateState.confirm === null &&
      lateState.authPresent === false &&
      (lateState.submitPresent === false || lateState.submitDisabled === true) &&
      lateState.unavailableCard === "",
    lateState,
  );
  await R.clickSelector(call, "[data-isolated-prompt-check-button]", 1500);
  const recheckState = await waitSettledCheck(call);
  dump.ipcGuardRecheck = recheckState;
  check(
    "对照：重新核对后卡恢复（证明上一条不是恒锁）",
    recheckState.confirm !== null && recheckState.stale === false,
    recheckState,
  );

  const inv = R.onlyNewRunChanges(ctx.fp, R.fingerprint(), [dupChild]);
  dump.ipcGuardInvariant = inv;
  check(
    "除判重案那一次真实执行外没有别的写入（新增只能是该子 run 与其新附件，既有文件零改动）",
    inv.ok === true,
    inv,
  );
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

async function main() {
  const page = await listPageTarget(9612);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  const reloaded = await R.reloadWithProof(call);
  check(
    "开局哨兵 reload 已证明换了文档（UI-VERIFY：Page.reload 偶发不换文档会凭空造绿）",
    reloaded.nav != null && reloaded.docs === null,
    reloaded,
  );

  const script = {
    turns: [
      {
        toolCalls: [
          {
            id: "z1",
            name: "write_file",
            args: JSON.stringify({
              path: "guard-probe.txt",
              content: "R2273 判重案的真实执行产物\n",
            }),
          },
        ],
      },
      { content: "受控收尾。" },
    ],
    fallback: { content: "受控收尾。" },
  };
  let mock = null;
  const ctx = {
    mock: null,
    servedBase: 0,
    traceBase: new Set(),
    fp: {},
    healthyPlan: null,
    healthyRevision: null,
  };
  try {
    mock = await H.startMockLlmServer({ port: MOCK_PORT, script });
    ctx.mock = mock;
    await H.apiCall(call, "proxyToggle", {
      enabled: false,
      port: 18787,
      upstreamBaseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    });
    await H.apiCall(call, "clearSettings");
    await H.apiCall(call, "saveSettings", {
      baseURL: MOCK_BASE,
      apiKey: "sk-r2273-controlled",
      model: "r2273-control-model",
    });
    await H.storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
    await H.sleep(1500);
    const ready = await H.storeQ(
      call,
      "return JSON.stringify({ runs: s.runs.length, configured: s.settings?.configured ?? null });",
    );
    const listed = await H.storeQ(
      call,
      `const ids = s.runs.map(r => r.id); return JSON.stringify({ hasRoot: ids.includes(${JSON.stringify(ROOT.id)}), hasChild: ids.includes(${JSON.stringify(CHILD.id)}) });`,
    );
    check(
      "前置：dev 已加载夹具根与 v3 子，运行配置就绪",
      ready.runs > 0 &&
        ready.configured === true &&
        listed.hasRoot === true &&
        listed.hasChild === true,
      { ready, listed },
    );

    ctx.servedBase = mock.served();
    ctx.traceBase = new Set(H.traceIds());
    ctx.fp = R.fingerprint();

    if (TAG === "entry") await tagEntry(call, ctx);
    else if (TAG === "attachment") await tagAttachment(call, ctx);
    else if (TAG === "parent") await tagParent(call, ctx);
    else await tagIpcguard(call, ctx);
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
    // ⚠️ 显式收尾：CDP WebSocket 与未释放句柄会把事件轮拖住数分钟，
    //    批量驱动因此空等到超时（7.3 实测 parent 完成后 10+ 分钟不退出）。
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
