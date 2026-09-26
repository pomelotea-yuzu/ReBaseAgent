/* eslint-disable */
/**
 * U4 任务 6.4：A/B 实验的实机面——dry-run 只读、实际部分失败保留各臂事实、整批占一个槽。
 *
 * 覆盖 delta 场景（`specs/desktop-ui/spec.md` 与 `specs/model-experiments/spec.md`，逐字标题）：
 * - `只读入口和被动录制不占主动槽`（dry-run 预览：零登记、零请求、零文件、槽仍空闲）
 * - `A-B 一批占槽直到全部收尾`（首臂结束不放槽；批内第二入口与配置写都被拒）
 * - `A-B 部分失败保留各臂事实`（成功臂 + 503 臂：各臂 id/outcome 逐臂对上落盘 trace；
 *   `data.ids` 只数成功臂，`settled` 不冒充"全部臂正常结束"）
 *
 * 判据口径：
 * - **两臂两条真实 trace**：登记 `arms[i].id` 与落盘 `meta.id` 逐臂比对，失败臂必须带
 *   `llm.call.error` + `run.event=errored`，成功臂必须没有；
 * - 「整批占一个槽」= 在飞期间 `activeOperationId` 就是这一批的 operationId，
 *   且**第二个主动入口**（result fork）与**配置写**（settings:save）都在副作用前被拒；
 * - 服务请求数与 traces 文件数同时核对（不是只看界面横幅）。
 *
 * 用法：`node apps/desktop/scripts/u4-64-cdp.cjs --tag=<dry-run|partial-fail>`
 */
"use strict";
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["dry-run", "partial-fail"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u4", "u4-64");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-26-u4-64");
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
// 读数
// ---------------------------------------------------------------------------
const opsStatus = (call) => H.apiCall(call, "operationsStatus");
/** 会话级读数：登记条数 + 当前槽（status 信封本身没有 count，别把它当字段读） */
async function opsSnapshot(call) {
  const st = await opsStatus(call);
  const list = st?.data?.operations ?? [];
  return {
    ok: st?.ok === true,
    count: list.length,
    slot: st?.data?.activeOperationId ?? null,
    epoch: st?.data?.epoch ?? null,
  };
}
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  return {
    rec: (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null,
    slot: st?.data?.activeOperationId ?? null,
    count: (st?.data?.operations ?? []).length,
  };
};
const freshId = () =>
  `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(12, "0")}`;

/** 真 IPC：A/B 实际执行（带执行信封） */
function modelAb(call, epoch, operationId, request) {
  return H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `return JSON.stringify(await window.api.modelAb({
       operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
       request: ${JSON.stringify(request)},
     }));`,
  );
}
/** 起一次不 await 的 A/B 执行（留给"批次在飞"窗口用） */
function fireModelAb(call, epoch, operationId, request) {
  return call("Runtime.evaluate", {
    expression: `(async () => JSON.stringify(await window.api.modelAb({
      operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
      request: ${JSON.stringify(request)},
    })))()`,
    returnByValue: true,
    awaitPromise: true,
  });
}
/** 只读预览通道（dry-run 走这里，不进执行信封） */
const modelAbPlan = (call, request) => H.apiCall(call, "modelAbPlan", request);
/** 只读入口是否可用（列表 + 设置读取都该照常） */
const readonlyAlive = (call) =>
  H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `const a = await window.api.listRuns();
     const b = await window.api.getSettings();
     return JSON.stringify({ runs: a.ok === true, settings: b.ok === true, configured: b.ok === true ? b.data.configured : null });`,
  );

async function waitEpoch(call) {
  const st = await opsStatus(call);
  return st.data.epoch;
}
function readTrace(id) {
  return readFileSync(join(H.TRACES, `${id}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
/** 一臂的落盘事实：身份、模型、是否真有 llm.call.error、结局事件 */
function armFacts(id) {
  const lines = readTrace(id);
  const meta = lines[0];
  const llm = lines.filter((l) => l.kind === "llm.call");
  const evt = lines.find((l) => l.type === "run.event");
  return {
    id,
    metaId: meta.id,
    model: meta.model,
    hasLlmError: llm.some((l) => l.error !== undefined && l.error !== null),
    event: evt ? evt.event : null,
  };
}

// 父本：原生创建、已封存、含 config_hash、首次 llm.call 带字符串 system（U3 6.1 的真实 run）
const ARMS_OK = [
  { model: "mock-model-a", params: { temperature: 0.2 } },
  { model: "mock-model-b", params: { temperature: 1.5 } },
];

// ---------------------------------------------------------------------------
// 场景 A：dry-run 只读——零登记、零请求、零文件、不占槽
// ---------------------------------------------------------------------------
async function scenarioDryRun(call, fx, mock) {
  void fx;
  const epoch = await waitEpoch(call);
  // A/B 首期只支持**无副作用工具表**的父本（MODEL_AB_TOOL_POLICY 实测拒绝带 write_file 的夹具父本）
  // ⇒ 现造一个空工具表的单轮纯对话父本，两个 tag 同一口径。
  const parentRunId = await createSingleTurnParent(call, epoch);
  const parentRec = await H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `const r = await window.api.getRun(${JSON.stringify(parentRunId)});
     return JSON.stringify({ configHash: r.ok === true ? r.data.meta.config_hash ?? null : null,
                             llmCalls: r.ok === true ? r.data.spans.filter(x => x.kind === 'llm.call').length : -1 });`,
  );
  check(
    "父本满足 A/B 门禁：含 config_hash 且恰 1 次模型调用",
    parentRec.configHash !== null && parentRec.llmCalls === 1,
    parentRec,
  );
  const before = { files: H.traceIds().size, served: mock.served() };
  const opsBefore = (await opsSnapshot(call)).count;

  const plan = await modelAbPlan(call, { parentRunId, arms: ARMS_OK, dryRun: true });
  dump.plan = plan;
  // ModelAbResult 的计划条目在 **`data.plan`**（不是 data.arms）；dry-run 的 `ids` 恒为空数组
  const planArms = plan.ok === true ? (plan.data?.plan ?? []) : [];
  check(
    "预览（dry-run）成功返回计划（两臂、有实验号）",
    plan.ok === true && planArms.length === 2 && typeof plan.data?.experimentId === "string",
    plan.ok ? planArms.map((a) => a.model) : plan.error,
  );
  check(
    "预览两臂的模型按计划改写、参数如实算出 changed/added",
    planArms.map((a) => a.model).join() === "mock-model-a,mock-model-b" &&
      planArms.every((a) => a.changed?.includes("model") && a.params?.temperature !== undefined),
    planArms.map((a) => `${a.model}/${JSON.stringify(a.params)}/${JSON.stringify(a.changed)}`),
  );
  check(
    "预览不产出任何运行身份（ids 为空 ⇒ 没有臂落盘）",
    plan.ok === true && (plan.data?.ids ?? [1]).length === 0,
    plan.data?.ids,
  );
  check("预览零模型请求", mock.served() === before.served, {
    before: before.served,
    now: mock.served(),
  });
  check("预览零新文件", H.traceIds().size === before.files, {
    before: before.files,
    now: H.traceIds().size,
  });
  const afterOps = await opsSnapshot(call);
  check("预览不产生任何登记（只读通道不进执行信封）", afterOps.count === opsBefore, {
    opsBefore,
    count: afterOps.count,
  });
  check("预览不占主动槽", afterOps.slot === null, afterOps.slot);

  // 误闯主动执行通道 ⇒ 必须被拒且有可信终态（不是"默默没跑"）
  const operationId = freshId();
  const mistaken = await modelAb(call, epoch, operationId, {
    parentRunId,
    arms: ARMS_OK,
    dryRun: true,
  });
  dump.mistaken = mistaken;
  check(
    "dryRun 误闯主动通道被拒（稳定码 MODEL_AB_DRY_RUN_CHANNEL）",
    mistaken.ok === false && mistaken.error?.code === "MODEL_AB_DRY_RUN_CHANNEL",
    mistaken.ok ? mistaken.data : mistaken.error,
  );
  const mis = await recordOf(call, operationId);
  check(
    "误闯仍留下可信终态（settled/rejected）且零执行",
    mis.rec?.state === "settled" &&
      mis.rec?.requestOutcome === "rejected" &&
      mock.served() === before.served,
    { state: mis.rec?.state, outcome: mis.rec?.requestOutcome, served: mock.served() },
  );
  check(
    "误闯那条 runIds 为空",
    Array.isArray(mis.rec?.runIds) && mis.rec.runIds.length === 0,
    mis.rec?.runIds,
  );

  // 主动通道正常提交（真执行一次）前先确认：预览没有消耗任何许可/配额
  const alive = await readonlyAlive(call);
  check("只读入口在预览前后都可用", alive.runs === true && alive.settings === true, alive);
  await H.shot(call, SHOT_DIR, "64-dry-run.png");
  return {
    served: mock.served(),
    files: H.traceIds().size,
    opsCount: (await opsSnapshot(call)).count,
  };
}

// ---------------------------------------------------------------------------
// 场景 B：整批占槽 + 部分臂失败保留各臂事实
// ---------------------------------------------------------------------------
/**
 * 现造一个**单轮纯对话**父本（1 次 llm.call）做 A/B 的父母。
 * 为什么不能用历史夹具：臂的模型调用次数 = 父本的步数，多步父本会让
 * 「臂 1 成功、臂 2 失败」的剧本回合对不上（回合是按调用序消费的）。
 */
async function createSingleTurnParent(call, epoch) {
  const operationId = freshId();
  const res = await H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `return JSON.stringify(await window.api.createRun({
       operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(operationId)} },
       request: { systemPrompt: '你是冒烟助手。只回一句话。',
                  userMessage: 'U4-64 A-B 父本：说「一」' },
     }));`,
  );
  if (res.ok !== true) throw new Error(`父本创建失败：${JSON.stringify(res.error)}`);
  return res.data.id;
}

async function scenarioPartialFail(call, fx, mock) {
  void fx;
  const epoch = await waitEpoch(call);
  const parentRunId = await createSingleTurnParent(call, epoch);
  const parentFacts = armFacts(parentRunId);
  check("父本就绪：单轮、含 1 次模型调用", parentFacts.hasLlmError === false, parentFacts);
  const parentRec = await H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `const r = await window.api.getRun(${JSON.stringify(parentRunId)});
     return JSON.stringify({ configHash: r.ok === true ? r.data.meta.config_hash ?? null : null,
                             llmCalls: r.ok === true ? r.data.spans.filter(x => x.kind === 'llm.call').length : -1 });`,
  );
  check(
    "父本满足 A/B 门禁：含 config_hash 且首次 llm.call 有 system",
    parentRec.configHash !== null && parentRec.llmCalls === 1,
    parentRec,
  );

  const filesBefore = H.traceIds().size;
  const servedBefore = mock.served();
  const operationId = freshId();
  const request = { parentRunId, arms: ARMS_OK };

  // 起批次（不 await）：两臂顺序执行，臂 1 成功、臂 2 由剧本注入 503
  const pending = fireModelAb(call, epoch, operationId, request);
  await H.sleep(1500);
  const during = await recordOf(call, operationId);
  check(
    "批次执行中登记 running 且整批占住唯一的槽",
    during.rec?.state === "running" && during.slot === operationId,
    { state: during.rec?.state, slot: during.slot },
  );

  // 在飞期间：第二个主动入口（result fork）必须被拒，且零副作用
  const servedAtSecond = mock.served();
  const filesAtSecond = H.traceIds().size;
  const secondId = freshId();
  const second = await H.appImport(
    call,
    ["/src/renderer/src/store.ts", "/src/store.ts"],
    `return JSON.stringify(await window.api.forkRun({
       operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(secondId)} },
       request: { parentRunId: ${JSON.stringify(parentRunId)}, atSpanId: 's_03',
                  edit: { field: 'result', value: 'U4-64 批次期间的第二操作' } },
     }));`,
  );
  dump.second = second;
  check(
    "批次期间第二主动入口被拒（notAccepted/busy，未执行）",
    second.ok === false && second.error?.code === "OPERATION_NOT_ACCEPTED",
    second.ok ? second.data : second.error,
  );
  const secondRec = (await recordOf(call, secondId)).rec;
  check(
    "被拒的第二操作登记为 notAccepted（reason=busy）且零身份",
    secondRec?.state === "notAccepted" &&
      secondRec?.rejection === "busy" &&
      (secondRec?.runIds ?? []).length === 0,
    {
      state: secondRec?.state,
      rejection: secondRec?.rejection,
      runIds: secondRec?.runIds,
    },
  );
  check(
    "被拒的第二操作零模型请求、零新文件",
    mock.served() === servedAtSecond && H.traceIds().size === filesAtSecond,
    {
      servedAtSecond,
      served: mock.served(),
      filesAtSecond,
      files: H.traceIds().size,
    },
  );

  // 在飞期间：配置写也必须被拒（同一个互斥）
  const cfg = await H.apiCall(call, "saveSettings", {
    baseURL: `${H.MOCK_BASE}`,
    apiKey: "sk-u464-busy",
    model: "mock-model",
  });
  dump.configDuringBatch = cfg;
  check(
    "批次期间配置写被 main 拒绝（不靠界面置灰）",
    cfg.ok === false,
    cfg.ok ? cfg.data : cfg.error,
  );
  const alive = await readonlyAlive(call);
  check("配置读取仍可用（拒绝只针对写）", alive.settings === true && alive.runs === true, alive);

  const r = JSON.parse((await pending)?.result?.value ?? "{}");
  dump.response = r;
  check(
    "批次返回：整批一条操作，回执 settled",
    r.ok === true && r.operation?.state === "settled",
    r.ok ? r.operation : r.error,
  );
  check(
    "批次 settled 不冒充全部臂正常结束（ids 只数成功臂）",
    r.ok === true,
    r.ok ? r.operation : r.error,
  );

  const rec = (await recordOf(call, operationId)).rec;
  const arms = rec?.arms ?? [];
  check(
    "登记目标摘要：kind=modelAb 且按批次记 armCount=2",
    rec?.target?.kind === "modelAb" && rec?.target?.armCount === 2,
    rec?.target,
  );
  check(
    "登记携带 experimentId（批次归一条操作，不是两条）",
    typeof rec?.experimentId === "string" && rec.experimentId.length > 0,
    rec?.experimentId,
  );
  check(
    "登记按臂携带事实：两条臂、index 有序",
    arms.length === 2 && arms[0].index === 0 && arms[1].index === 1,
    arms,
  );
  check(
    "两臂都有真实运行身份（失败臂不丢 id）",
    arms.every((a) => typeof a.id === "string" && a.id.length > 0),
    arms.map((a) => ({ index: a.index, id: a.id, outcome: a.outcome })),
  );
  const runIds = rec?.runIds ?? [];
  check(
    "runIds 覆盖两条臂的真实身份",
    runIds.length === 2 && arms.every((a) => runIds.includes(a.id)),
    { runIds, arms: arms.map((a) => a.id) },
  );
  check("traces 恰 +2（一臂一份）", H.traceIds().size === filesBefore + 2, {
    before: filesBefore,
    after: H.traceIds().size,
  });
  check("服务恰 +2（两臂各一次模型调用，无重试）", mock.served() === servedBefore + 2, {
    before: servedBefore,
    after: mock.served(),
  });

  // 逐臂与落盘 trace 比对
  const facts = arms.map((a) => armFacts(a.id));
  dump.armFacts = facts;
  check(
    "臂 0 落盘对得上：meta.id 相同、模型是 a、无 llm.call.error、结局不是 errored",
    facts[0].metaId === arms[0].id &&
      facts[0].model === "mock-model-a" &&
      facts[0].hasLlmError === false &&
      facts[0].event !== "errored",
    facts[0],
  );
  check(
    "臂 1 落盘对得上：meta.id 相同、模型是 b、确有 llm.call.error 且结局 errored",
    facts[1].metaId === arms[1].id &&
      facts[1].model === "mock-model-b" &&
      facts[1].hasLlmError === true &&
      facts[1].event === "errored",
    facts[1],
  );
  check(
    "两臂 id 互不相同（不是把同一份 run 记两次）",
    arms[0].id !== arms[1].id,
    arms.map((a) => a.id),
  );

  // 旧 `ids` 语义仍成立：只数成功臂，不把失败臂混进去报"成功 2 臂"
  const ids = r.ok === true ? (r.data?.ids ?? []) : [];
  check("data.ids 只计成功臂（部分失败不谎报成功数）", ids.length === 1 && ids[0] === arms[0].id, {
    ids,
    armIds: arms.map((a) => a.id),
  });

  // 批结束槽已释放：下一个主动入口可以正常被接受（读取失败那份不锁配置）
  const afterSlot = (await recordOf(call, operationId)).slot;
  check("批次收尾后槽已释放", afterSlot !== operationId, afterSlot);
  const cfgAfter = await H.apiCall(call, "saveSettings", {
    baseURL: H.MOCK_BASE,
    apiKey: "sk-u464-after",
    model: "mock-model",
  });
  check("收尾后配置写恢复可用", cfgAfter.ok === true, cfgAfter.ok ? cfgAfter.data : cfgAfter.error);
  await H.shot(call, SHOT_DIR, "64-partial-fail.png");
  return {
    operationId,
    arms: arms.map((a) => ({ index: a.index, id: a.id, outcome: a.outcome })),
    ids,
    facts,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  if (!H.existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
  const fx = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (!H.existsSync(join(H.TRACES, `${fx.normalRun}.jsonl`)))
    throw new Error(`夹具父本缺失：${fx.normalRun}`);

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

  // 回合按调用序消费：父本 1 次 + 臂 1 一次成功 + 臂 2 一次 503（臂顺序 = 提交顺序）
  const scripts = {
    "dry-run": { turns: [{ content: "不该被调用" }], fallback: { content: "不该被调用" } },
    "partial-fail": {
      turns: [
        { content: "父本回应" },
        { content: "臂 A 的回应", delayMs: 6000 },
        {
          mode: "fail",
          status: 503,
          errorBody: { error: { message: "冒烟注入：臂 B 模型不可用" } },
        },
      ],
      fallback: { content: "兜底" },
    },
  };
  const mock = await H.prepare(call, scripts[TAG]);
  const scenarios = {
    "dry-run": () => scenarioDryRun(call, fx, mock),
    "partial-fail": () => scenarioPartialFail(call, fx, mock),
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
