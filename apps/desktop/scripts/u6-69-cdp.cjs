/* eslint-disable */
/**
 * U6 任务 6.9（第六批受控实机）：回归完整链 v1/v2、独立轨迹、U1/U2 阅读恢复及 U3/U5 草稿/结果流程，
 * 核对源/父/兄弟/blob 指纹。
 *
 * 覆盖 evidence-index 待实机场景：
 * - #1 普通 result 的完整父链仍合并 / #38 分支 run 的轨迹 / #42 完整普通分支保留被编辑字段；
 * - #2 根 run 以自有轨迹返回；
 * - #45 完整隔离 result 保留整轮前缀（v2 隔离链回归）；
 * - #39 完整独立分支不拼接父轨迹 / #43 独立分支来源链完整但不共享执行前缀；
 * - #46 混合父链不跨独立边界拼接；
 * - #13 v1 祖先携带隔离字段不降级（元数据级注入，实机与单元同形）；
 * - 阅读恢复（U1/U2）与草稿/结果流程（U3/U5）回归 + 源/父/兄弟/blob 逐字节指纹（全程只读零写入）。
 *
 * 用法：`node apps/desktop/scripts/u6-69-cdp.cjs --tag=<TAG>`（前置 dev 由 run-all 起）
 */
"use strict";
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const H = require("./lib/u4-smoke-harness.cjs");
const faults = require("./lib/u6-lineage-faults.cjs");

const TAGS = ["complete-chain-regression", "draft-result-regression", "exec-gate-result"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u6", "u6-69");
const SHOT_DIR = join(OUT_DIR, "shots");
const MARK = "U6-69";
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const BLOBS = join(H.REPO, ".rebaseagent", "workspace-blobs");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
if (!existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
const FX = JSON.parse(readFileSync(MANIFEST, "utf8"));

const TOOL_TURN = {
  toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }],
};
const OK_TURN = { content: `${MARK} 受控成功：一步答完。`, usage: { in: 120, out: 40 } };
const FAIL_TURN = { mode: "fail", status: 503, content: "上游超时（受控失败）" };
const TAG_SCRIPT = {
  // child1(1) + isoRoot(2) + isoChild(1) + promptChild(2) + mixedChild(1) = 7
  "complete-chain-regression": {
    turns: [OK_TURN, TOOL_TURN, OK_TURN, OK_TURN, TOOL_TURN, OK_TURN, OK_TURN],
  },
  // 成功子(1) + 失败子(1) = 2
  "draft-result-regression": { turns: [OK_TURN, FAIL_TURN] },
  // isoRoot(TOOL,OK=2) + isoChild(TOOL,OK=2) + abParent(1) + 恢复后新 ID 重检执行(1) = 6；
  // 418 哨兵不被消费 ⇒「零模型调用」是数出来的
  "exec-gate-result": {
    turns: [
      TOOL_TURN,
      OK_TURN,
      TOOL_TURN,
      OK_TURN,
      OK_TURN,
      OK_TURN,
      { mode: "fail", status: 418, content: "这个 tag 不该有多余模型调用" },
    ],
  },
};

// ---------------------------------------------------------------------------
// 检查与落盘
// ---------------------------------------------------------------------------

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
    return "unknown";
  }
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
  drainActive(TAG);
  const meta = {
    head: headShort(),
    node: process.version,
    scriptSha: {
      "u6-lineage-faults.cjs": sha12(
        join(H.REPO, "apps/desktop/scripts/lib/u6-lineage-faults.cjs"),
      ),
      "u4-smoke-harness.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u4-smoke-harness.cjs")),
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
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 12 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  drainActive(TAG);
  process.exit(3);
}, 720_000);

// ---------------------------------------------------------------------------
// 注入句柄崩 安全（u6-67 纪律）
// ---------------------------------------------------------------------------

const ACTIVE = [];
function safeBeginLineageFault(args, kind) {
  const handle = faults.beginLineageFault(args, kind);
  ACTIVE.push(handle);
  return {
    end: () => {
      const i = ACTIVE.indexOf(handle);
      if (i >= 0) ACTIVE.splice(i, 1);
      return handle.end();
    },
  };
}
function drainActive(why) {
  while (ACTIVE.length > 0) {
    const h = ACTIVE.pop();
    try {
      const end = h.end();
      console.error(`[兜底还原:${why}] ${end.clean === true ? "干净" : "有残留"}`);
    } catch (e) {
      console.error(`[兜底还原:${why}] 失败：${String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 读数与动作
// ---------------------------------------------------------------------------

async function envOf(call, path, payload) {
  const raw = await H.apiCall(call, path, payload);
  if (raw?.ok !== true) {
    throw new Error(`${path} 信封非 ok：${JSON.stringify(raw?.error ?? raw).slice(0, 300)}`);
  }
  return raw.data;
}
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
function execOfEnvelope(env) {
  if (env?.ok !== true)
    throw new Error(`执行信封非 ok：${JSON.stringify(env?.error ?? env).slice(0, 300)}`);
  return env.data;
}
/** 带指定 operationId 的直调（#29 同 ID 判重 / 新 ID 重检需要可控身份；registry 只收 UUID） */
let uuidSeq = 0;
function freshUuid() {
  uuidSeq += 1;
  return `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(9, "0")}${String(uuidSeq).padStart(3, "0")}`;
}
async function execRawId(call, path, request, operationId) {
  const st = await H.apiCall(call, "operationsStatus", null);
  const epoch = st?.data?.epoch;
  if (typeof epoch !== "string") throw new Error("拿不到 main epoch");
  const opId = operationId ?? freshUuid();
  return H.appImport(
    call,
    H.STORE_NEEDLE,
    `const env = await window.api.${path}({ operation: { epoch: ${JSON.stringify(epoch)}, operationId: ${JSON.stringify(opId)} }, request: ${JSON.stringify(request)} });
     return JSON.stringify(env);`,
  );
}
async function seedRun(call, { userMessage, workspace }) {
  const data = execOfEnvelope(
    await execRaw(call, "createRun", {
      systemPrompt: "你是简洁的受控助手。",
      userMessage,
      ...(workspace === undefined ? {} : { workspace }),
    }),
  );
  const id = data.id;
  await waitSealed(call, id);
  return id;
}
async function waitSealed(call, id, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const env = await H.apiCall(call, "getRun", id);
    if (env?.ok === true && env.data?.status === "completed") return;
    if (Date.now() > deadline) throw new Error(`run ${id} 60s 未封存`);
    await H.sleep(500);
  }
}
function traceLines(id) {
  return readFileSync(join(H.TRACES, `${id}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
function toolSpanOf(id) {
  const span = traceLines(id).find((l) => l.type === "span" && l.kind === "tool.invoke");
  if (span === undefined) throw new Error(`run ${id} 没有 tool.invoke span`);
  return span.id;
}
const bodyText = (call) => H.ev(call, "(() => document.body.innerText)()");
/** store 级选中（本批不缩窗，但统一走 store 免 DOM 依赖） */
async function selectRunAnywhere(call, runId) {
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(runId)});
     return JSON.stringify({ sel: s.selectedRunId });`,
  );
  await H.sleep(1400);
}
/** 详情读数（成功态形状） */
const detailState = (call) =>
  H.storeQ(
    call,
    `const d = s.detail;
     return JSON.stringify(d === null ? null : {
       completeness: d.completeness, spanScope: d.spanScope,
       chainLen: d.chain.length, chainIds: d.chain.map(h => h.meta.id),
       spanIds: d.spans.map(x => x.id),
     });`,
  );

/** 指纹：traces + workspace-blobs 逐文件 sha256（只读回归的零写入判据） */
function hashDir(dir) {
  const acc = {};
  if (!existsSync(dir)) return acc;
  for (const n of readdirSync(dir).filter(
    (x) => x.endsWith(".jsonl") || x.endsWith(".png") || !x.includes("."),
  )) {
    try {
      acc[`${dir}/${n}`] = createHash("sha256")
        .update(readFileSync(join(dir, n)))
        .digest("hex");
    } catch {
      /* 跳过读到一半的文件 */
    }
  }
  return acc;
}
const hashAll = () => ({ ...hashDir(H.TRACES), ...hashDir(BLOBS) });
function diffFingerprints(before, after) {
  const added = Object.keys(after).filter((k) => before[k] === undefined);
  const removed = Object.keys(before).filter((k) => after[k] === undefined);
  const changed = Object.keys(before).filter(
    (k) => after[k] !== undefined && before[k] !== after[k],
  );
  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// tag A：完整链回归（v1 普通 / v2 隔离 / 独立 / 混合 + 根 + #13 注入 + 指纹）
// ---------------------------------------------------------------------------

const FLOWS = {
  "complete-chain-regression": async (call, mock) => {
    void mock;
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    // ── 播种五条链（全部直调，执行通道包 operation 信封）
    // ① v1 普通 fork 子（父 = 夹具 normalRun）
    const child1 = execOfEnvelope(
      await execRaw(call, "forkRun", {
        parentRunId: FX.normalRun,
        atSpanId: "s_03",
        edit: { field: "result", value: `${MARK} v1 受控编辑` },
      }),
    ).id;
    await waitSealed(call, child1);
    // ② v2 隔离链
    const token = (await envOf(call, "chooseSource", null)).sourceToken;
    const isoRoot = await seedRun(call, {
      userMessage: `${MARK} 隔离根任务`,
      workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
    });
    const isoChild = execOfEnvelope(
      await execRaw(call, "forkRun", {
        parentRunId: isoRoot,
        atSpanId: toolSpanOf(isoRoot),
        edit: { field: "result", value: `${MARK} 隔离受控编辑` },
        execution: { mode: "isolated_files", allowFileWrites: true },
      }),
    ).id;
    await waitSealed(call, isoChild);
    // ③ 独立轨迹（prompt fork，自带工具回合 ⇒ 有自有 tool span）
    const promptChild = execOfEnvelope(
      await execRaw(call, "promptFork", {
        parentRunId: FX.normalRun,
        edit: { field: "user_message", value: `${MARK} 独立轨迹改写` },
      }),
    ).id;
    await waitSealed(call, promptChild);
    // ④ 混合父链（result fork 的父 = prompt 独立 run）
    const mixedChild = execOfEnvelope(
      await execRaw(call, "forkRun", {
        parentRunId: promptChild,
        atSpanId: toolSpanOf(promptChild),
        edit: { field: "result", value: `${MARK} 混合链受控编辑` },
      }),
    ).id;
    await waitSealed(call, mixedChild);
    dump.specimen = { child1, isoRoot, isoChild, promptChild, mixedChild };

    // 指纹基线取在全部播种之后（播种本身合法写盘）
    const fpBefore = hashAll();

    // ── #2 根 run 以自有轨迹返回
    await selectRunAnywhere(call, FX.normalRun);
    const rootD = await detailState(call);
    check(
      "#2 根 run：chain 单跳即根、spanScope=own、complete",
      rootD.completeness === "complete" &&
        rootD.spanScope === "own" &&
        rootD.chainLen === 1 &&
        rootD.chainIds[0] === FX.normalRun,
      rootD,
    );

    // ── #1/#38/#42 v1 普通 fork 子：完整父链合并 + 轨迹 + 被编辑字段
    await selectRunAnywhere(call, child1);
    const c1 = await detailState(call);
    check(
      "#1 完整父链：complete/resolved",
      c1.completeness === "complete" && c1.spanScope === "resolved",
      c1,
    );
    // 合并语义 = 父轨迹「分叉点（含）之前的前缀」+ 自有重放 span（父在分叉点之后的 span 不进子时间线）
    const nrmSpanLines = traceLines(FX.normalRun).filter((l) => l.type === "span");
    const nrmSpans = nrmSpanLines.map((l) => l.id);
    const forkIdx = nrmSpans.indexOf("s_03");
    const parentPrefix = nrmSpans.slice(0, forkIdx + 1);
    check(
      "#38 轨迹合并：父分叉点前缀（含）全在场 + 自有新增 span，链两跳溯源不断",
      c1.chainLen === 2 &&
        c1.chainIds[0] === FX.normalRun &&
        c1.chainIds[1] === child1 &&
        parentPrefix.every((id) => c1.spanIds.includes(id)) &&
        c1.spanIds.length > parentPrefix.length,
      { chain: c1.chainIds, prefix: parentPrefix, spanIds: c1.spanIds },
    );
    await H.clickTabChecked(call, "概览");
    await H.sleep(600);
    const srcOverview = await bodyText(call);
    await H.clickTabChecked(call, "步骤");
    await H.sleep(600);
    const srcSteps = await bodyText(call);
    const union = `${srcOverview}\n${srcSteps}`;
    check(
      "#42 被编辑字段保留：分叉点与编辑字段标注在场（概览或步骤页）",
      union.includes("s_03") &&
        union.includes("result") &&
        union.includes(FX.normalRun.slice(0, 12)),
      {
        overviewHas: { span: srcOverview.includes("s_03"), field: srcOverview.includes("result") },
        stepsHas: { span: srcSteps.includes("s_03"), field: srcSteps.includes("result") },
      },
    );

    // ── #45 v2 完整隔离 result：整轮前缀保留（v2 边界 = 分叉点所在整轮，含兄弟工具）
    await selectRunAnywhere(call, isoChild);
    const ic = await detailState(call);
    const isoRootSpanLines = traceLines(isoRoot).filter((l) => l.type === "span");
    const isoRootSpans = isoRootSpanLines.map((l) => l.id);
    const icOverlap = isoRootSpans.filter((id) => ic.spanIds.includes(id));
    check(
      "#45 完整隔离链：complete/resolved + 链两跳 + 父整轮前缀在场（含兄弟工具）+ 自有重放在场",
      ic.completeness === "complete" &&
        ic.spanScope === "resolved" &&
        ic.chainLen === 2 &&
        icOverlap.length > 0 &&
        ic.spanIds.length > icOverlap.length,
      { chain: ic.chainIds, rootSpans: isoRootSpans, overlap: icOverlap, spanIds: ic.spanIds },
    );

    // ── #39/#43 独立轨迹：链完整但不拼父轨迹
    // ⚠️ span id 按 run 重编号（都叫 s_01…），跨 run 按 id 比对会假阴/假阳 ⇒
    //    判据 = 详情 span 集 **恰好等于** 自有 trace 文件的 span 集（若拼入父轨迹，
    //    父文件里子没有的 id（如 s_06…）必然出现、集合不再相等）
    await selectRunAnywhere(call, promptChild);
    const pc = await detailState(call);
    const pcOwnFileSpans = traceLines(promptChild)
      .filter((l) => l.type === "span")
      .map((l) => l.id);
    const pcSame =
      JSON.stringify([...pc.spanIds].sort()) === JSON.stringify([...pcOwnFileSpans].sort());
    check(
      "#39/#43 独立分支：complete + spanScope=own + 详情 span 集=自有文件（父轨迹零拼接）+ 链完整溯源",
      pc.completeness === "complete" &&
        pc.spanScope === "own" &&
        pc.chainLen === 2 &&
        pc.chainIds[0] === FX.normalRun &&
        pc.chainIds[1] === promptChild &&
        pcSame,
      { chain: pc.chainIds, spanIds: pc.spanIds, ownFileSpans: pcOwnFileSpans },
    );

    // ── #46 混合父链：不跨独立边界拼接、chain 溯源不断
    // 判据（id 重编号纪律）：详情 span 集 ⊆ 独立父文件 ∪ 自有文件，且 root 文件**独有**的
    // id（promptChild 文件里没有的）一个都不在场 ⇒ 没有跨独立边界拉取 root 轨迹
    await selectRunAnywhere(call, mixedChild);
    const mx = await detailState(call);
    const promptSpans = traceLines(promptChild)
      .filter((l) => l.type === "span")
      .map((l) => l.id);
    const mixedOwnSpans = traceLines(mixedChild)
      .filter((l) => l.type === "span")
      .map((l) => l.id);
    const allowed = new Set([...promptSpans, ...mixedOwnSpans]);
    const nrmExclusive = nrmSpans.filter((id) => !promptSpans.includes(id));
    const leaked = mx.spanIds.filter((id) => nrmExclusive.includes(id));
    const outsideAllowed = mx.spanIds.filter((id) => !allowed.has(id));
    const mxPromptOverlap = promptSpans.filter((id) => mx.spanIds.includes(id));
    check(
      "#46 混合链：complete + 自有重放全在场 + 独立父前缀在场 + root 独有轨迹零泄漏 + chain 三跳溯源不断",
      mx.completeness === "complete" &&
        mx.chainLen === 3 &&
        mx.chainIds[0] === FX.normalRun &&
        mx.chainIds[1] === promptChild &&
        mx.chainIds[2] === mixedChild &&
        mixedOwnSpans.every((id) => mx.spanIds.includes(id)) &&
        mxPromptOverlap.length > 0 &&
        leaked.length === 0 &&
        outsideAllowed.length === 0,
      {
        chain: mx.chainIds,
        spanScope: mx.spanScope,
        spanIds: mx.spanIds,
        promptSpans,
        mixedOwnSpans,
        nrmExclusive,
        leaked,
        outsideAllowed,
      },
    );
    await H.shot(call, SHOT_DIR, `${TAG}-mixed-chain.png`);

    // ── U1/U2 阅读恢复回归：child1 上选 span → 切走 → 切回 ⇒ 位置保持
    await selectRunAnywhere(call, child1);
    await H.clickTabChecked(call, "步骤");
    const ownLlm = traceLines(child1).find((l) => l.type === "span" && l.kind === "llm.call");
    if (ownLlm !== undefined) {
      await H.clickSpan(call, "LLM", ownLlm.id);
    }
    const posBefore = await H.storeQ(
      call,
      "return JSON.stringify({ sel: s.selectedRunId, span: s.selectedSpanId, tab: s.readingOf(s.selectedRunId)?.tab ?? null });",
    );
    await selectRunAnywhere(call, FX.isoRoot);
    await selectRunAnywhere(call, child1);
    const posAfter = await H.storeQ(
      call,
      "return JSON.stringify({ sel: s.selectedRunId, span: s.selectedSpanId, tab: s.readingOf(s.selectedRunId)?.tab ?? null });",
    );
    check(
      "U1/U2 阅读恢复：切走切回后选中/页签保持",
      posAfter.sel === posBefore.sel && posAfter.tab === posBefore.tab,
      { before: posBefore, after: posAfter },
    );

    // ── #13 v1 祖先携带隔离字段：元数据级注入 ⇒ 严格失败不降级（实机与单元同形）
    const h13 = safeBeginLineageFault(
      { tracesDir: H.TRACES, childRunId: child1, ancestorRunId: FX.normalRun },
      "ancestorV1IsolationField",
    );
    const env13 = await H.apiCall(call, "getRun", child1);
    check(
      "#13 v1 祖先携带隔离字段 ⇒ 严格失败（不降级 ownOnly）",
      env13?.ok === false &&
        typeof env13?.error?.message === "string" &&
        !(env13?.error?.message ?? "").includes(":\\"),
      env13?.error?.message?.slice(0, 120) ?? env13?.error?.code,
    );
    const end13 = h13.end();
    check("#13 注入逐字节还原", end13.clean === true, end13.diff);
    await selectRunAnywhere(call, FX.normalRun);
    await selectRunAnywhere(call, child1);
    const c1Again = await detailState(call);
    check(
      "#13 还原后重读 ⇒ complete（全量重验）",
      c1Again.completeness === "complete",
      c1Again.completeness,
    );

    // ── 指纹：全程只读回归零写入（traces + blobs 逐字节）
    const fpDiff = diffFingerprints(fpBefore, hashAll());
    check(
      "全程 traces + workspace-blobs 逐字节不变（只读回归零写入）",
      fpDiff.added.length === 0 && fpDiff.removed.length === 0 && fpDiff.changed.length === 0,
      fpDiff,
    );
    await H.shot(call, SHOT_DIR, `${TAG}-final.png`);
  },

  /**
   * #23/#25/#29/#30 的实机面（此前 6.4/6.6 未布断言）：result/隔离 result 端点的
   * ownOnly 执行拒绝、恢复后同 ID 判重不复活 / 新 ID 重检可执行、A/B 预检后父链变化仍拒。
   * 418 哨兵不被消费 ⇒ 「零模型调用」是数出来的；指纹与 blobs 计数兜底「零落盘」。
   */
  "exec-gate-result": async (call, mock) => {
    const token = (await envOf(call, "chooseSource", null)).sourceToken;
    const isoRoot = await seedRun(call, {
      userMessage: `${MARK} 隔离根任务`,
      workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
    });
    const isoChild = execOfEnvelope(
      await execRawId(call, "forkRun", {
        parentRunId: isoRoot,
        atSpanId: toolSpanOf(isoRoot),
        edit: { field: "result", value: `${MARK} 隔离子受控编辑` },
        execution: { mode: "isolated_files", allowFileWrites: true },
      }),
    ).id;
    await waitSealed(call, isoChild);
    // A/B 预检父本 = 纯对话 create（系统提示 + config_hash 满足 V3b 门禁）
    const abParent = await seedRun(call, { userMessage: `${MARK} A/B 纯对话父本` });
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    const servedBase = mock.served();
    const fpBefore = hashAll();
    const ARMS = [
      { model: "controlled-model", params: { temperature: 0.2 } },
      { model: "controlled-model-b", params: { temperature: 0.7 } },
    ];

    // 隐藏 isoRoot ⇒ isoChild ownOnly
    const inj = safeBeginLineageFault(
      { tracesDir: H.TRACES, childRunId: isoChild, ancestorRunId: isoRoot },
      "ancestorMissing",
    );
    const op1 = freshUuid();
    const forkReq1 = {
      parentRunId: isoChild,
      atSpanId: toolSpanOf(isoChild),
      edit: { field: "result", value: `${MARK} ownOnly 上的重跑尝试` },
    };
    const env1 = await execRawId(call, "forkRun", forkReq1, op1);
    check(
      "#23 ownOnly result 直调 ⇒ RUN_LINEAGE_INCOMPLETE（信封 ok:false）",
      env1?.ok === false && env1?.error?.code === "RUN_LINEAGE_INCOMPLETE",
      env1?.error ?? env1,
    );
    const st1 = await H.apiCall(call, "operationsStatus", null);
    const rec1 = (st1?.data?.operations ?? []).find((o) => o.operationId === op1) ?? null;
    check(
      "#23 登记按 settled/rejected 收口且 runIds 空",
      rec1 !== null &&
        (rec1.state === "settled" || rec1.state === "rejected") &&
        Array.isArray(rec1?.runIds) &&
        rec1.runIds.length === 0,
      { state: rec1?.state, runIds: rec1?.runIds },
    );
    check("#23 拒绝路径零模型调用", mock.served() === servedBase, mock.served());

    // #25 隔离 result 端点：ownOnly + 合法 allowFileWrites ⇒ 拒绝 + 无副本世界/trace 创建
    const blobsBefore = Object.keys(hashDir(BLOBS)).length;
    const tracesBefore = H.traceIds().size;
    const env2 = await execRawId(
      call,
      "forkRun",
      { ...forkReq1, execution: { mode: "isolated_files", allowFileWrites: true } },
      freshUuid(),
    );
    check(
      "#25 ownOnly 隔离 result ⇒ RUN_LINEAGE_INCOMPLETE（不消费副本授权）",
      env2?.ok === false && env2?.error?.code === "RUN_LINEAGE_INCOMPLETE",
      env2?.error ?? env2,
    );
    check(
      "#25 零 trace 创建 + blobs 计数不变（无副本世界）",
      H.traceIds().size === tracesBefore && Object.keys(hashDir(BLOBS)).length === blobsBefore,
      {
        traces: { before: tracesBefore, after: H.traceIds().size },
        blobs: { before: blobsBefore, after: Object.keys(hashDir(BLOBS)).length },
      },
    );

    // #29 恢复父文件 ⇒ 同 ID 只命中判重不复活；新 ID 重检后可执行
    const endInj = inj.end();
    check("#29 注入逐字节还原", endInj.clean === true, endInj.diff);
    await selectRunAnywhere(call, FX.normalRun);
    await selectRunAnywhere(call, isoChild);
    const icBack = await detailState(call);
    check(
      "#29 恢复后重读 ⇒ complete（全量重验）",
      icBack.completeness === "complete",
      icBack.completeness,
    );
    const env3 = await execRawId(call, "forkRun", forkReq1, op1);
    check(
      "#29 同 ID 再提交 ⇒ 判重不复活（OPERATION_DUPLICATED，零重读零执行）",
      env3?.ok === false && env3?.error?.code === "OPERATION_DUPLICATED",
      env3?.error ?? env3,
    );
    check("#29 判重路径零模型调用", mock.served() === servedBase, mock.served());
    // 新 ID 重检 ⇒ 隔离续跑执行（隔离子代的普通重跑被领域门禁拒：OPERATION_EXECUTION_FAILED
    // 「父 run 是隔离 run…请改用隔离续跑」——门禁本身正确工作，已如实记录）
    const env4 = await execRawId(
      call,
      "forkRun",
      { ...forkReq1, execution: { mode: "isolated_files", allowFileWrites: true } },
      freshUuid(),
    );
    check(
      "#29 新 ID 重检 ⇒ 正常执行（信封 ok；隔离续跑路径）",
      env4?.ok === true,
      env4?.error ?? "ok",
    );
    await H.sleep(1500);
    check("#29 新 ID 路径恰 +1 模型调用", mock.served() === servedBase + 1, mock.served());

    // #30 A/B 预检通过后父链变化仍由 main 拒绝（直调等价绕过 UI）
    const plan = await H.apiCall(call, "modelAbPlan", {
      parentRunId: abParent,
      arms: ARMS,
      dryRun: true,
    });
    check(
      "#30 前置：完整父本的 dry-run 计划可用（零模型调用）",
      plan?.ok === true && mock.served() === servedBase + 1,
      plan?.error ?? plan?.data?.arms?.length,
    );
    const inj30 = safeBeginLineageFault(
      { tracesDir: H.TRACES, childRunId: abParent },
      "currentMissing",
    );
    const env5 = await execRawId(
      call,
      "modelAb",
      { parentRunId: abParent, arms: ARMS },
      freshUuid(),
    );
    check(
      "#30 预检后父链变化 ⇒ 真提交仍拒绝（当前 run 缺失 ⇒ RUN_DETAIL_UNREADABLE）",
      env5?.ok === false && env5?.error?.code === "RUN_DETAIL_UNREADABLE",
      env5?.error ?? env5,
    );
    const st5 = await H.apiCall(call, "operationsStatus", null);
    void st5;
    check("#30 拒绝路径零网络（served 不再增长）", mock.served() === servedBase + 1, mock.served());
    const end30 = inj30.end();
    check("#30 注入逐字节还原", end30.clean === true, end30.diff);
    await H.shot(call, SHOT_DIR, `${TAG}-exec-gate.png`);
  },

  /** U3/U5 草稿/结果流程回归（完整链 UI 提交路径）：成功清理 / 失败保留 / 设置往返保留 */
  "draft-result-regression": async (call, mock) => {
    // ── ① 成功子 run：UI 提交 → verified complete ⇒ 草稿按修订清理（U5 结果收尾回归）
    await openPlainResultEditor(call);
    const text1 = `${MARK} 成功子 run 草稿`;
    await H.typeIntoEditableMonaco(call, text1);
    await confirmEditor(call);
    const sub1 = await submitAndCapture(call, "确认重跑", `${FX.normalRun}|s_03|result`);
    if (typeof sub1.operationId !== "string")
      throw new Error(`fork 未登记：${JSON.stringify(sub1)}`);
    const { rec: rec1, epoch: epoch1 } = await waitRegistryRecordState(
      call,
      sub1.operationId,
      "settled",
      60000,
    );
    const child1 = rec1?.runIds?.[0] ?? null;
    check(
      "成功子：登记收口带可信 runId",
      rec1?.state === "settled" && typeof child1 === "string",
      rec1?.state ?? null,
    );
    const entry1 = await waitForVerified(call, epoch1, sub1.operationId, child1);
    check(
      "成功子：核实 verified complete",
      entry1?.phase === "verified" && entry1?.facts?.normalEnd === true,
      entrySummary(entry1),
    );
    check("成功子：草稿按原修订清理", (await callDraftText(call)) === null, null);
    check("成功子：收尾关联释放", (await closureOf(call, epoch1, sub1.operationId)) === null, null);

    // ── ② 失败子 run：error 结局 ⇒ 草稿保留（U5 M5.2 回归）
    const text2 = `${MARK} 失败子 run 草稿`;
    await openPlainResultEditor(call);
    await H.typeIntoEditableMonaco(call, text2);
    await confirmEditor(call);
    const sub2 = await submitAndCapture(call, "确认重跑", `${FX.normalRun}|s_03|result`);
    const { rec: rec2, epoch: epoch2 } = await waitRegistryRecordState(
      call,
      sub2.operationId,
      "settled",
      60000,
    );
    const child2 = rec2?.runIds?.[0] ?? null;
    const entry2 = await waitForVerified(call, epoch2, sub2.operationId, child2);
    check(
      "失败子：核实 verified 但 normalEnd=false",
      entry2?.phase === "verified" && entry2?.facts?.normalEnd === false,
      entrySummary(entry2),
    );
    check(
      "失败子：草稿保留全文",
      (await callDraftText(call))?.includes(text2.slice(-8)) === true,
      null,
    );
    check("失败子：收尾关联保留", (await closureOf(call, epoch2, sub2.operationId)) !== null, null);

    // ── ③ U3 设置往返：打开运行配置再关闭 ⇒ 草稿保留（关闭 ≠ 放弃）
    await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => x.offsetParent !== null && ((x.textContent || '').includes('运行配置')));
        if (b) b.click(); return true; })()`,
    );
    await H.sleep(1200);
    await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => x.offsetParent !== null && ((x.textContent || '').trim()) === '✕');
        if (b) b.click(); return true; })()`,
    );
    await H.sleep(1000);
    check(
      "U3 设置往返：草稿逐字保留（关闭 ≠ 放弃）",
      (await callDraftText(call))?.includes(text2.slice(-8)) === true,
      null,
    );

    // ── ④ 只读重试不导航（U5 回归，light）
    const navBefore = await H.storeQ(
      call,
      "return JSON.stringify({ sel: s.selectedRunId, gen: s.navGeneration });",
    );
    await H.storeQ(
      call,
      `await s.retryResultRead({ epoch: ${JSON.stringify(epoch2)}, operationId: ${JSON.stringify(sub2.operationId)}, runId: ${JSON.stringify(child2)} });
       return true;`,
    );
    await H.sleep(800);
    const navAfter = await H.storeQ(
      call,
      "return JSON.stringify({ sel: s.selectedRunId, gen: s.navGeneration });",
    );
    check(
      "重试不导航（选中/代次不动）",
      navAfter.sel === navBefore.sel && navAfter.gen === navBefore.gen,
      { before: navBefore, after: navAfter },
    );
    await H.shot(call, SHOT_DIR, `${TAG}-draft-kept.png`);
  },
};

// ---------------------------------------------------------------------------
// 页内动作（普通 result 编辑器，u5-63 同款）
// ---------------------------------------------------------------------------

async function openPlainResultEditor(call) {
  await H.selectRun(call, FX.normalRun);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", "s_03");
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
const visibleConfirmExpr = `(() => {
  const all = Array.from(document.querySelectorAll('[data-confirm-execution]'));
  return all.find(b => b.offsetParent !== null) ?? null;
})()`;
async function confirmEditor(call) {
  const before = await H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      if (!b) return JSON.stringify({ error: 'no-visible-confirm' });
      return JSON.stringify({ disabled: b.disabled }); })()`,
  );
  const parsed = JSON.parse(before);
  if (parsed.error) throw new Error(`确认按钮缺失：${parsed.error}`);
  if (parsed.disabled !== false) throw new Error(`确认按钮不可点：${JSON.stringify(parsed)}`);
  await H.ev(call, `(() => { ${visibleConfirmExpr}.click(); return true; })()`);
  await H.sleep(500);
  const after = await H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      return b === null ? null : { pressed: b.getAttribute('aria-pressed') }; })()`,
  );
  if (after?.pressed !== "true") throw new Error(`点确认后 aria-pressed=${after?.pressed}`);
}
async function submitAndCapture(call, buttonText, key) {
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .filter(x => x.offsetParent !== null)
        .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
      if (!btn) return JSON.stringify({ error: 'button-not-found' });
      if (btn.disabled) return JSON.stringify({ error: 'button-disabled' });
      btn.click();
      const deadline = Date.now() + 9000;
      for (;;) {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        const m = await import(url);
        const s = m.useAppStore.getState();
        const x = s.draftSubmissions.byId[${JSON.stringify(key)}];
        if (x !== undefined) return JSON.stringify({ operationId: x.operationId, epoch: x.epoch, revision: x.submittedRevision });
        if (Date.now() > deadline) return JSON.stringify({ none: true });
        await new Promise(res => setTimeout(res, 20));
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new Error(`submitAndCapture: ${JSON.stringify(r.exceptionDetails).slice(0, 240)}`);
  const parsed = JSON.parse(r?.result?.value ?? "{}");
  if (parsed.error) throw new Error(`提交按钮不可用：${parsed.error}`);
  return parsed;
}
const opsStatus = (call) => H.apiCall(call, "operationsStatus");
async function waitRegistryRecordState(call, operationId, want, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const st = await opsStatus(call);
    last = (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null;
    if (last !== null && last.state === want) return { rec: last, epoch: st?.data?.epoch ?? null };
    if (Date.now() > deadline) return { rec: last, epoch: st?.data?.epoch ?? null };
    await H.sleep(300);
  }
}
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
const entrySummary = (entry) =>
  entry === null
    ? null
    : {
        phase: entry.phase,
        attempt: entry.attempt,
        normalEnd: entry.facts?.normalEnd ?? null,
        event: entry.facts?.event ?? null,
      };
const callDraftText = async (call) => {
  const d = await H.drafts(call);
  return d?.calls?.[FX.normalRun]?.s_03?.result?.text ?? null;
};
const closureOf = (call, epoch, operationId) =>
  H.storeQ(
    call,
    `return JSON.stringify(s.draftSubmissions.closures[${JSON.stringify(`${epoch}|${operationId}`)}] ?? null);`,
  );

// ---------------------------------------------------------------------------

async function main() {
  const page = await H.cdpConnect(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

  await call("Page.reload", { ignoreCache: true });
  let runsReady = false;
  for (let i = 0; i < 60; i++) {
    await H.sleep(500);
    try {
      const cnt = await H.storeQ(call, "return JSON.stringify(s.runs.length);");
      if (cnt > 0) {
        runsReady = true;
        break;
      }
    } catch {
      /* 重载瞬间 */
    }
  }
  if (!runsReady) throw new Error("重载后 30s 运行列表仍未就绪（store.runs 为空）");
  const dpr = await H.ev(call, "(() => window.devicePixelRatio)()");
  if (Math.abs(dpr - 2.1) > 0.3) {
    throw new Error(`DPR=${dpr} ≠ 2.1 基线——疑有 zoom 残留（per_host_zoom_levels），先复位再跑`);
  }
  await H.sleep(900);

  const mock = await H.prepare(call, TAG_SCRIPT[TAG]);
  try {
    await FLOWS[TAG](call, mock);
  } catch (e) {
    drainActive(TAG);
    check(`tag 执行异常：${String(e?.message ?? e).slice(0, 300)}`, false);
  } finally {
    await H.teardown(call, mock);
  }
  finish();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  drainActive(TAG);
  process.exit(1);
});
