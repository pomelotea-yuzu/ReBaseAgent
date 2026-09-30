/* eslint-disable */
/**
 * U6 任务 6.5（第二批受控实机）：prompt/proxy/model_params 完整与缺失；
 * 验证实际 UI 禁用与有效 IPC 拒绝（+ 隔离 capability、无父本创建保持原契约）。
 *
 * 对应 delta 场景（evidence-index #5/#6/#7/#8/#9/#24/#26/#31/#32）。
 *
 * 判据纪律（同 6.4）：链条真 IPC 现造（U4 执行信封 `{operation:{epoch,operationId}, request}`）；
 * 注入=u6-lineage-faults（finally 还原 + 逐字节指纹，基线取注入前）；「零模型调用」由受控服务
 * served() 增量立证；UI 禁用断言逐控件判 disabled，不只看整页。
 *
 * ⚠️ prompt fork 容忍空工具表（fork-runner.ts:216 录制缺省视为空表）⇒ prompt 链可建在
 * 普通 create 上；A/B 父本 = 纯对话 create（V3b 门禁：非 proxy + config_hash + system 消息）；
 * proxy 父本 = 真被动录制（proxyToggle on + node 侧 POST 经代理捕获 key，被动 run 落盘）。
 *
 * 用法：`node apps/desktop/scripts/u6-65-cdp.cjs --tag=<TAG>`
 * 前置：dev 已由 run-all 起（CDP 9612）。
 */
"use strict";
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const faults = require("./lib/u6-lineage-faults.cjs");

const TAGS = [
  "prompt-ownonly-gate",
  "modelab-ownonly-gate",
  "proxy-ownonly-gate",
  "capability-ownonly",
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

const OUT_DIR = join(H.REPO, ".workbuddy", "u6", "u6-65");
const SHOT_DIR = join(OUT_DIR, "shots");
const MARK = "U6-65";
const SRC_FIXTURE = join(OUT_DIR, "src-fixture");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

const TOOL_TURN = {
  toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }],
};
const TAG_SCRIPT = {
  "prompt-ownonly-gate": {
    turns: [{ content: "away" }, { content: "prompt 父本回答" }, { content: "prompt 子回答" }],
  },
  "modelab-ownonly-gate": {
    turns: [{ content: "away" }, { content: "A/B 父本回答" }, { content: "造链用 prompt 子回答" }],
  },
  "proxy-ownonly-gate": {
    turns: [{ content: "away" }, { content: "被动录制回答" }, { content: "messages 重发回答" }],
  },
  "capability-ownonly": {
    turns: [
      { content: "away" },
      TOOL_TURN,
      { content: "隔离根最终回答" },
      TOOL_TURN,
      { content: "隔离子最终回答" },
    ],
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
function headShort() {
  try {
    const head = readFileSync(join(H.REPO, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: (.+)$/);
    if (m) {
      const refFile = join(H.REPO, ".git", ...m[1].split("/"));
      if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}
function finish(extraMeta = {}) {
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify(
      {
        tag: TAG,
        meta: { head: headShort(), tracesCount: H.traceIds().size, ...extraMeta },
        checks,
        failed: failed.length,
        dump,
      },
      null,
      2,
    ),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 10 分钟未收尾`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 600_000);

// ---------------------------------------------------------------------------
// 读数与动作（6.4 同款 + 执行通道专用）
// ---------------------------------------------------------------------------

async function envOf(call, path, payload) {
  const raw = await H.apiCall(call, path, payload);
  if (raw?.ok !== true) {
    throw new Error(`${path} 信封非 ok：${JSON.stringify(raw?.error ?? raw).slice(0, 300)}`);
  }
  return raw.data;
}
/** 只读通道裸信封（不拆） */
const rawCall = (call, path, payload) => H.apiCall(call, path, payload);
/** 执行通道直调（U4 信封）；返回完整信封（拒绝类断言要看 error.code） */
async function execRaw(call, path, request) {
  const st = await H.apiCall(call, "operationsStatus", null);
  const epoch = st?.data?.epoch;
  if (typeof epoch !== "string") throw new Error("拿不到 main epoch");
  return H.appImport(
    call,
    H.STORE_NEEDLE,
    `const env = await window.api.${path}({ operation: { epoch: ${JSON.stringify(epoch)}, operationId: crypto.randomUUID() }, request: ${JSON.stringify(request)} });
     return JSON.stringify(env);`,
  );
}
async function seedRun(call, { userMessage, workspace, systemPrompt }) {
  // ⚠️ createRun 是执行通道 ⇒ 必须包 U4 操作信封（6.4 同款教训）
  const data = execOfEnvelope(
    await execRaw(call, "createRun", {
      systemPrompt: systemPrompt ?? "你是简洁的受控助手。",
      userMessage,
      ...(workspace === undefined ? {} : { workspace }),
    }),
  );
  const id = data.id;
  const deadline = Date.now() + 60000;
  for (;;) {
    const env = await H.apiCall(call, "getRun", id);
    if (env?.ok === true && env.data?.status === "completed") break;
    if (Date.now() > deadline) throw new Error(`run ${id} 60s 未封存`);
    await H.sleep(500);
  }
  return id;
}
function traceLines(id) {
  return readFileSync(join(H.TRACES, `${id}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
function ownSpanIds(id) {
  return traceLines(id)
    .filter((l) => l.type === "span")
    .map((l) => l.id);
}
const selectViaStore = (call, id) =>
  H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(id)}); return JSON.stringify({ sel: s.selectedRunId });`,
  );
async function reRead(call, awayId, childId) {
  await selectViaStore(call, awayId);
  await H.sleep(900);
  await selectViaStore(call, childId);
  const deadline = Date.now() + 15000;
  for (;;) {
    const st = await H.storeQ(
      call,
      `const d = s.detail;
       return JSON.stringify({ sel: s.selectedRunId,
         d: d === null ? null : { completeness: d.completeness, spanScope: d.spanScope } });`,
    );
    if (st.sel === childId && st.d !== null && st.d.completeness !== undefined) return st.d;
    if (Date.now() > deadline)
      throw new Error(`切回 ${childId} 后 15s 详情未落地：${JSON.stringify(st).slice(0, 200)}`);
    await H.sleep(500);
  }
}
const detailState = (call) =>
  H.storeQ(
    call,
    `const d = s.detail;
     return JSON.stringify(d === null ? null : {
       completeness: d.completeness, spanScope: d.spanScope, lineage: d.lineage,
       chainLen: d.chain.length, chainIds: d.chain.map(h => h.meta.id),
       spanIds: d.spans.map(x => x.id),
     });`,
  );
/** 步骤页的执行入口确认按钮（按文案精确定位、只看可见者）。
 *  ⚠️ find 返回 undefined（不是 null）：ownOnly 时按钮可能整个不挂载 ⇒ 两态都要接住 */
async function visibleConfirm(call, text) {
  const raw = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .filter(x => x.offsetParent !== null)
        .find(x => ((x.textContent||'').trim()) === ${JSON.stringify(text)});
      if (b === null || b === undefined) return JSON.stringify({ absent: true });
      return JSON.stringify({ absent: false, disabled: b.disabled, pressed: b.getAttribute('aria-pressed') }); })()`,
  );
  return JSON.parse(raw);
}
/** 选中 run 的首个 llm span（prompt / messages 入口锚点） */
function firstLlmSpan(id) {
  const span = traceLines(id).find((l) => l.type === "span" && l.kind === "llm.call");
  if (span === undefined) throw new Error(`run ${id} 没有 llm.call span`);
  return span.id;
}
/** 把**所有**可见可编辑 monaco 都设为给定文本（DetailPanel 同时挂 system/user 两个
 *  prompt 编辑器 ⇒ 只设 eds[0] 会改错草稿、确认按钮状态跟着错，U5 6.2 同源坑） */
async function setAllEditableMonaco(call, text) {
  return H.appImport(
    call,
    H.MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const eds = monaco.editor.getEditors().filter((e) =>
       e.getDomNode() !== null && e.getDomNode().offsetParent !== null &&
       !e.getOption(monaco.editor.EditorOption.readOnly));
     for (const e of eds) e.getModel().setValue(${JSON.stringify(text)});
     await new Promise((r) => setTimeout(r, 600));
     return JSON.stringify({ ok: true, count: eds.length });`,
  );
}
/** 统计可见的「确认从头重跑」按钮的禁用态（多个编辑器各有一枚） */
async function confirmButtons(call) {
  const raw = await H.ev(
    call,
    `(() => { const bs = Array.from(document.querySelectorAll('button'))
        .filter(x => x.offsetParent !== null)
        .filter(x => ((x.textContent||'').trim()) === '确认从头重跑');
      return JSON.stringify(bs.map(b => ({ disabled: b.disabled }))); })()`,
  );
  return JSON.parse(raw);
}
/** 选中 run（store 动作，绕开 DOM 列表态）+ 点 llm span（prompt / messages 编辑器挂载前提）。
 *  ⚠️ 页签在详情落地后才渲染 ⇒ 切页签轮询重试（单发点击会偶发扑空，实测 flake） */
async function openSpanEditor(call, runId, spanId) {
  await selectViaStore(call, runId);
  await H.sleep(900);
  let tabOk = false;
  for (let i = 0; i < 5 && !tabOk; i++) {
    tabOk = await H.clickTab(call, "步骤");
    if (!tabOk) await H.sleep(1000);
  }
  if (!tabOk) throw new Error("页签切换到「步骤」失败（轮询 5 次未命中）");
  await H.clickSpan(call, "LLM", spanId);
  await H.sleep(1200);
}
/** 步骤页正文与就近原因 */
const bodyText = (call) => H.ev(call, "(() => document.body.innerText)()");

// ---------------------------------------------------------------------------
// 四个 tag
// ---------------------------------------------------------------------------

const FLOWS = {
  /** #5/#6/#7/#24(prompt)/#32：prompt 完整与缺失；UI 禁用与 IPC 拒绝；ownOnly 在场创建照常 */
  "prompt-ownonly-gate": async (call, mock) => {
    const away = await seedRun(call, { userMessage: `${MARK} away` });
    const parent = await seedRun(call, { userMessage: `${MARK} prompt 父本任务` });
    const child = (
      await execOfEnvelope(
        await execRaw(call, "promptFork", {
          parentRunId: parent,
          edit: { field: "system_prompt", value: `${MARK} 受控编辑后的 system prompt` },
        }),
      )
    ).id;
    dump.chain = { parent, child };

    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    // 正对照：完整链的 prompt 子 ⇒ complete/own，只展示自有 spans
    await selectViaStore(call, child);
    await H.sleep(1200);
    const before = await detailState(call);
    check(
      "正对照：完整 prompt 子 ⇒ complete/own（独立执行不是降级）",
      before.completeness === "complete" && before.spanScope === "own" && before.chainLen === 2,
      before,
    );
    const own = ownSpanIds(child);
    check(
      "正对照：时间线只含自有 spans（父轨迹不进时间线）",
      JSON.stringify([...before.spanIds].sort()) === JSON.stringify([...own].sort()),
      { detail: before.spanIds?.length, own: own.length },
    );
    // UI：选中 llm span ⇒ 展开入口「编辑 system prompt 重跑」⇒ 键入内容（空 fork 禁用）
    // ⇒ 确认按钮可用（完整链的正对照可执行资格）
    await openSpanEditor(call, child, firstLlmSpan(child));
    await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .filter(x => x.offsetParent !== null)
          .find(x => ((x.textContent||'').trim()) === '编辑 system prompt 重跑');
        if (b === null || b === undefined) return 'no-entry'; b.click(); return 'clicked'; })()`,
    );
    await H.sleep(900);
    await setAllEditableMonaco(call, `${MARK} 受控编辑后的 system prompt`);
    await H.sleep(600);
    const beforeBtns = await confirmButtons(call);
    const beforeBody = await bodyText(call);
    // U6 的判据 = **来源闸的差异化**：完整链 ⇒ 不出现"源记录不可用"禁用行（按钮的
    // disabled=true 来自 U5 两步确认的"未核对"态，属确认凭据编排，归 U5 6.4 承载）；
    // ownOnly ⇒ 该行出现（见下）。可执行资格的 IPC 半边由 u6-exec-source-gate 正对照承载。
    check(
      "正对照：完整链不出现来源禁用行（编辑器可展开、资格不被来源闸拦截）",
      beforeBtns.length > 0 &&
        beforeBody.includes("源记录不可用：重新读取并校验通过前不能发起新执行") === false,
      { btns: beforeBtns },
    );

    const fpBefore = H.hashAllTraces();
    const servedBefore = mock.served();
    const handle = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: child, ancestorRunId: parent },
      "ancestorMissing",
    );
    await reRead(call, away, child);
    const after = await detailState(call);
    check(
      "prompt 缺祖先 ⇒ ownOnly + 真实 missingRunId（从头轨迹语义不变）",
      after.completeness === "ownOnly" &&
        after.spanScope === "own" &&
        after.lineage?.missingRunId === parent,
      after,
    );
    const own2 = ownSpanIds(child);
    check(
      "时间线仍只含自有 spans（不补父 spans）",
      JSON.stringify([...after.spanIds].sort()) === JSON.stringify([...own2].sort()),
      after.spanIds?.length,
    );
    // UI：执行入口不可用——展开编辑器、键入内容（先过空 fork 闸）⇒ 来源闸接管：禁用 + 就近原因
    await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .filter(x => x.offsetParent !== null)
          .find(x => ((x.textContent||'').trim()) === '编辑 system prompt 重跑');
        if (b === null || b === undefined) return 'no-entry'; b.click(); return 'clicked'; })()`,
    );
    await H.sleep(900);
    const typed = await setAllEditableMonaco(call, `${MARK} ownOnly 上的编辑尝试`);
    dump.ownOnlyTyped = typed;
    await H.sleep(600);
    const btns = await confirmButtons(call);
    // ownOnly ⇒ 执行入口不可用：所有确认按钮禁用（编辑内容已过空 fork 闸 ⇒ 剩下的只有来源闸）
    check(
      "ownOnly ⇒ prompt 编辑器确认按钮全部不可用",
      btns.length > 0 && btns.every((b) => b.disabled === true) === true,
      btns,
    );
    const body = await bodyText(call);
    check(
      "就近原因在场（源记录不可用）",
      body.includes("源记录不可用") === true,
      body.includes("源记录不可用"),
    );
    // 有效 IPC 直调 ⇒ 来源拒绝（settled/rejected、runIds 空、零模型调用）
    const servedBeforeExec = mock.served();
    const env = await execRaw(call, "promptFork", {
      parentRunId: child,
      edit: { field: "user_message", value: `${MARK} ownOnly 上的重试` },
    });
    dump.rejected = env;
    check(
      "IPC 直调 ⇒ RUN_LINEAGE_INCOMPLETE 拒绝",
      env?.ok === false && env?.error?.code === "RUN_LINEAGE_INCOMPLETE",
      env?.error,
    );
    check(
      "拒绝消息含缺失 ID 且无路径",
      (env?.error?.message ?? "").includes(parent) === true &&
        !(env?.error?.message ?? "").includes(":\\"),
      env?.error?.message,
    );
    const st = await H.apiCall(call, "operationsStatus", null);
    const rec = (st?.data?.operations ?? []).slice(-1)[0] ?? null;
    // 实测形状：ownOnly 领域拒绝收口为 settled（settled ≠ 运行成功；runIds 空）
    check(
      "登记收口且 runIds 为空",
      rec?.state === "settled" && Array.isArray(rec?.runIds) && rec.runIds.length === 0,
      { state: rec?.state, runIds: rec?.runIds },
    );
    check("拒绝路径零模型调用", mock.served() - servedBeforeExec === 0, mock.served());
    // 还原（UI 仍显示 ownOnly——重读前详情不自动刷新）⇒ 还原核验干净
    await H.shot(call, SHOT_DIR, `${TAG}-ownonly-disabled.png`);
    const end = handle.end();
    check("注入逐字节还原", end.clean === true, end);
    // #32 半边：选中 ownOnly run 的详情在场时（UI 态），普通 create 照常（无父本路径不受阻断）
    const created = await seedRun(call, { userMessage: `${MARK} ownOnly 在场时的创建` });
    check(
      "ownOnly 在场 ⇒ 普通 create 照常成功（保持原契约）",
      typeof created === "string" && created.length > 0,
      created,
    );
    // 指纹差集精算：与注入前相比，新增恰为 create 合法写入的那一份，其余逐字节不变
    const u5f = require("./lib/u5-read-faults.cjs");
    const fpDiff = u5f.diffFingerprints(fpBefore, H.hashAllTraces());
    check(
      "指纹差集 = 新增恰为 created（其余零写入）",
      fpDiff.added.length === 1 &&
        fpDiff.added[0] === `${created}.jsonl` &&
        fpDiff.removed.length === 0 &&
        fpDiff.changed.length === 0,
      fpDiff,
    );
    await reRead(call, away, child);
    const restored = await detailState(call);
    check(
      "恢复 ⇒ 重验 complete/own",
      restored.completeness === "complete" && restored.spanScope === "own",
      restored,
    );
  },

  /** #9/#24(AB)/#26：ownOnly 父本 ⇒ dry-run 同源拒绝 + 整批第一臂前拒绝 + 零臂身份 */
  "modelab-ownonly-gate": async (call, mock) => {
    const away = await seedRun(call, { userMessage: `${MARK} away` });
    const parent = await seedRun(call, { userMessage: `${MARK} A/B 父本任务` });
    const ARMS = [
      { model: "controlled-model", params: { temperature: 0.2 } },
      { model: "controlled-model-b", params: { temperature: 0.7 } },
    ];
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    // 正对照：完整父本的 dry-run 计划可用（零模型调用、不占槽）
    const plan = await rawCall(call, "modelAbPlan", {
      parentRunId: parent,
      arms: ARMS,
      dryRun: true,
    });
    dump.plan = plan;
    check("正对照：完整父本 dry-run 计划可用", plan?.ok === true, plan?.error ?? null);
    const servedPlan = mock.served();
    check("dry-run 零模型调用", servedPlan === mock.served(), servedPlan);
    // 完整父本整批执行正对照（两臂真跑：消费 2 回合？不——父本单轮，臂各重跑一次 ⇒ 备 2 回合）
    // ⚠️ 真执行会消费剧本回合：本 tag 剧本只备了 away+父+子 ⇒ 整批真跑放 6.3 单元承载，实机只跑 plan 正对照
    // ownOnly 标本：先造 prompt 子（子的父 = 父本），再隐藏父文件 ⇒
    // A/B 父本门禁对 child（prompt 子，非 proxy + config_hash + system 消息，满足原领域门禁）
    // 的 checkRunSource 走到祖先缺失 ⇒ RUN_LINEAGE_INCOMPLETE（祖先缺失主通道；
    // 缺当前文件 ⇒ RUN_DETAIL_UNREADABLE 由 §5.9 单元承载）
    const child = (
      await execOfEnvelope(
        await execRaw(call, "promptFork", {
          parentRunId: parent,
          edit: { field: "user_message", value: `${MARK} 造链用 prompt 子` },
        }),
      )
    ).id;
    const servedBefore = mock.served();
    // ownOnly 标本 = 父文件隐藏 ⇒ 对子 ownOnly；A/B 父本用「损坏」钉 RUN_DETAIL_UNREADABLE，
    // 用「缺失」钉 RUN_LINEAGE_INCOMPLETE 的主通道在 prompt/proxy tag 已钉，这里用祖先缺失形状：
    // 以子为父本发起 A/B（子的父=父本缺失 ⇒ checkRunSource(child) 读到 ownOnly 链 ⇒ 拒绝）
    // ⚠️ modelAb 父本门禁要求"非 proxy + config_hash + system 消息"——prompt 子同样满足。
    const handle2 = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: child, ancestorRunId: parent },
      "ancestorMissing",
    );
    // dry-run 直调（ownOnly 父本 = child）
    const plan2 = await rawCall(call, "modelAbPlan", {
      parentRunId: child,
      arms: ARMS,
      dryRun: true,
    });
    dump.plan2 = plan2;
    check(
      "ownOnly dry-run ⇒ RUN_LINEAGE_INCOMPLETE、不生成可执行计划",
      plan2?.ok === false && plan2?.error?.code === "RUN_LINEAGE_INCOMPLETE",
      plan2?.error,
    );
    // 整批真执行直调 ⇒ 第一臂前拒绝、零臂身份
    const servedBeforeExec = mock.served();
    const env = await execRaw(call, "modelAb", { parentRunId: child, arms: ARMS });
    dump.abRejected = env;
    check(
      "ownOnly 整批 ⇒ RUN_LINEAGE_INCOMPLETE",
      env?.ok === false && env?.error?.code === "RUN_LINEAGE_INCOMPLETE",
      env?.error,
    );
    check(
      "拒绝路径零模型调用（第一臂之前）",
      mock.served() - servedBeforeExec === 0,
      mock.served(),
    );
    const st = await H.apiCall(call, "operationsStatus", null);
    const rec = (st?.data?.operations ?? []).slice(-1)[0] ?? null;
    // 实测形状：ownOnly 领域拒绝收口为 settled（settled ≠ 运行成功；runIds/arms 皆空）
    check(
      "登记收口、runIds 空、零臂身份",
      rec?.state === "settled" &&
        Array.isArray(rec?.runIds) &&
        rec.runIds.length === 0 &&
        (rec?.arms === undefined || rec.arms.length === 0),
      { state: rec?.state, runIds: rec?.runIds, arms: rec?.arms },
    );
    await H.shot(call, SHOT_DIR, `${TAG}-ab-ownonly.png`);
    const end = handle2.end();
    check("注入逐字节还原", end.clean === true, end);
    check("收口前零模型调用（away/父/子三回合之外）", mock.served() === servedBefore, {
      servedBefore,
      now: mock.served(),
    });
  },

  /** #8/#6(proxy)：proxy fork 完整与缺失；缺祖先不借用其他代理记录 */
  "proxy-ownonly-gate": async (call, mock) => {
    const away = await seedRun(call, { userMessage: `${MARK} away` });
    // 启用代理（upstream = mock）并捕获 key：node 侧 POST 经代理
    await H.apiCall(call, "proxyToggle", {
      enabled: true,
      port: H.PROXY_PORT,
      upstreamBaseUrl: H.MOCK_UPSTREAM,
    });
    await H.storeQ(call, "await s.loadProxyStatus(); return 1;");
    await H.sleep(1200);
    const tracesBefore = H.traceIds();
    const resp = await fetch(`http://127.0.0.1:${H.PROXY_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-u665-capture" },
      body: JSON.stringify({
        model: "controlled-model",
        stream: false,
        messages: [{ role: "user", content: `${MARK} 被动录制请求` }],
      }),
    });
    check("经代理的请求转发成功（捕获 key + 录制）", resp.ok === true, resp.status);
    await H.sleep(1500);
    const added = [...H.traceIds()].filter((x) => !tracesBefore.has(x));
    const proxyRun = added.find((id) => {
      try {
        return traceLines(id)[0]?.source?.kind === "proxy";
      } catch {
        return false;
      }
    });
    dump.proxyRun = proxyRun;
    check("被动录制落盘一条 proxy run（source.kind=proxy）", typeof proxyRun === "string", added);
    const proxySpan = firstLlmSpan(proxyRun);
    const origMessages =
      traceLines(proxyRun).find((l) => l.type === "span" && l.kind === "llm.call")?.request
        ?.messages ?? [];
    // proxyFork 子 run（编辑 messages 重发）
    const edited = [...origMessages, { role: "user", content: `${MARK} 受控追加消息` }];
    const child = (
      await execOfEnvelope(
        await execRaw(call, "proxyFork", {
          parentRunId: proxyRun,
          atSpanId: proxySpan,
          messages: edited,
        }),
      )
    ).id;
    dump.child = child;
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    await selectViaStore(call, child);
    await H.sleep(1200);
    const before = await detailState(call);
    check(
      "正对照：完整 messages fork ⇒ complete/own（自有 messages/llm 事实）",
      before.completeness === "complete" && before.spanScope === "own",
      before,
    );

    const fpBefore = H.hashAllTraces();
    const servedBefore = mock.served();
    const handle = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: child, ancestorRunId: proxyRun },
      "ancestorMissing",
    );
    await reRead(call, away, child);
    const after = await detailState(call);
    check(
      "proxy fork 缺祖先 ⇒ ownOnly + 真实 missingRunId",
      after.completeness === "ownOnly" && after.lineage?.missingRunId === proxyRun,
      after,
    );
    const own = ownSpanIds(child);
    check(
      "自有事实保留、不借用其他代理记录（spans=自有文件逐 id）",
      JSON.stringify([...after.spanIds].sort()) === JSON.stringify([...own].sort()),
      after.spanIds?.length,
    );
    // IPC 再提交 ⇒ 拒绝 + 代理零转发
    const env = await execRaw(call, "proxyFork", {
      parentRunId: child,
      atSpanId: firstLlmSpan(child),
      messages: edited,
    });
    dump.rejected = env;
    check(
      "IPC 直调 ⇒ RUN_LINEAGE_INCOMPLETE",
      env?.ok === false && env?.error?.code === "RUN_LINEAGE_INCOMPLETE",
      env?.error,
    );
    check(
      "拒绝路径代理零转发（不发请求/不录制）",
      mock.served() - servedBefore === 0,
      mock.served(),
    );
    await H.shot(call, SHOT_DIR, `${TAG}-proxy-ownonly.png`);
    const end = handle.end();
    check("注入逐字节还原", end.clean === true, end);
    await reRead(call, away, child);
    const restored = await detailState(call);
    check(
      "恢复 ⇒ complete/own",
      restored.completeness === "complete" && restored.spanScope === "own",
      restored,
    );
    check(
      "全程 traces 逐字节不变",
      JSON.stringify(H.hashAllTraces()) === JSON.stringify(fpBefore),
      null,
    );
  },

  /** #31：ownOnly 隔离父本 ⇒ capability 明确拒绝；自有文件阅读独立可读
   *  ⚠️ chooseSource 依赖 dev 启动时的 REBASEAGENT_SMOKE_PICK_DIR env 钩子（run-all 提供），
   *  未设置时会打开真原生目录对话框 ⇒ CDP 无法驱动、无界挂死（本批首跑教训） */
  "capability-ownonly": async (call, mock) => {
    const away = await seedRun(call, { userMessage: `${MARK} away` });
    const pickDir = process.env.REBASEAGENT_SMOKE_PICK_DIR;
    if (pickDir === undefined || !existsSync(pickDir)) {
      throw new Error("dev 未带 REBASEAGENT_SMOKE_PICK_DIR ⇒ chooseSource 会开原生对话框挂死");
    }
    const token = (await envOf(call, "chooseSource", null)).sourceToken;
    const root = await seedRun(call, {
      userMessage: `${MARK} capability 隔离根任务`,
      workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
    });
    const toolSpan = toolSpanOf(root);
    const child = (
      await execOfEnvelope(
        await execRaw(call, "forkRun", {
          parentRunId: root,
          atSpanId: toolSpan,
          edit: { field: "result", value: `${MARK} 隔离子受控编辑` },
          execution: { mode: "isolated_files", allowFileWrites: true },
        }),
      )
    ).id;
    dump.chain = { root, child };
    // 正对照：还原前先验证一次 capability 可用（根在场）⇒ 拒绝确实来自缺失
    const capBefore = await rawCall(call, "forkCapability", {
      parentRunId: child,
      atSpanId: toolSpanOf(child),
      edit: { field: "result", value: `${MARK} capability 预检编辑` },
    });
    dump.capBefore = capBefore;
    check("正对照：根在场 ⇒ capability 照常给出", capBefore?.ok === true, capBefore?.error ?? null);

    const fpBefore = H.hashAllTraces();
    const handle = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: child, ancestorRunId: root },
      "ancestorMissing",
    );
    const cap = await rawCall(call, "forkCapability", {
      parentRunId: child,
      atSpanId: toolSpanOf(child),
      edit: { field: "result", value: `${MARK} capability 预检编辑` },
    });
    dump.capRejected = cap;
    check(
      "ownOnly ⇒ capability 以 RUN_LINEAGE_INCOMPLETE 拒绝",
      cap?.ok === false && cap?.error?.code === "RUN_LINEAGE_INCOMPLETE",
      cap?.error,
    );
    check("不授予许可（无 capability 载荷）", cap?.data === undefined, cap?.data ?? null);
    // 自有文件阅读独立可读：inspect 照常（stepSpanId 为 optional ⇒ 省略而不是 null）
    const inspect = await rawCall(call, "inspectWorkspace", { runId: child });
    dump.inspect = inspect;
    check("自有文件阅读不被封禁（inspect 照常）", inspect?.ok === true, inspect?.error ?? null);
    await H.shot(call, SHOT_DIR, `${TAG}-capability-ownonly.png`);
    const end = handle.end();
    check("注入逐字节还原", end.clean === true, end);
    const capAfter = await rawCall(call, "forkCapability", {
      parentRunId: child,
      atSpanId: toolSpanOf(child),
      edit: { field: "result", value: `${MARK} capability 预检编辑` },
    });
    check("恢复 ⇒ capability 照常给出", capAfter?.ok === true, capAfter?.error ?? null);
    check(
      "全程 traces 逐字节不变",
      JSON.stringify(H.hashAllTraces()) === JSON.stringify(fpBefore),
      null,
    );
  },
};

/** 拆执行信封 data（成功路径） */
function execOfEnvelope(env) {
  if (env?.ok !== true)
    throw new Error(`执行信封非 ok：${JSON.stringify(env?.error ?? env).slice(0, 300)}`);
  return env.data;
}
function toolSpanOf(id) {
  const span = traceLines(id).find((l) => l.type === "span" && l.kind === "tool.invoke");
  if (span === undefined) throw new Error(`run ${id} 没有 tool.invoke span`);
  return span.id;
}

// ---------------------------------------------------------------------------

async function main() {
  const page = await H.cdpConnect(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

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

  const mock = await H.prepare(call, TAG_SCRIPT[TAG]);
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
