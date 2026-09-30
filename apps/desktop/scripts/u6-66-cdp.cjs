/* eslint-disable */
/**
 * U6 任务 6.6（第三批受控实机）：恢复、损坏/未来版本、已知错误叠加缺失；
 * 权限不可实机诱发 ⇒ 按注入层证据单列（§1.2 EACCES 注入已由 u6-lineage-read 单测承载）。
 *
 * 对应 delta 场景（evidence-index #10/#11/#12/#14/#15/#16/#20/#28/#29/#30 部分）。
 * 注入种类（u6-lineage-faults 八种）：ancestorCorrupt / ancestorFutureVersion /
 * ancestorV1IsolationField / lineageCycle / forkInvalid / ancestorForkMissing /
 * currentMissing / ancestorMissing。
 *
 * 判据口径：
 * - 严格失败不降级：损坏/版本/成环/定位非法 ⇒ `runs:get` ok:false 受控中文，绝不返回 ownOnly；
 * - UI 失败形状 = store `error: "读取 run 失败：<受控中文>"`，断言不含盘符/物理路径；
 * - 执行门禁半边：注入期间直调 promptFork ⇒ RUN_DETAIL_UNREADABLE + settled 收口 + runIds 空
 *   + 零模型调用（6.5 实测形状：领域拒绝收口 settled）；
 * - 叠加（#20）：可读祖先缺 fork（结构非法）+ 更早祖先缺失 ⇒ FORK_INVALID 优先，不截成 ownOnly；
 * - 恢复（#16）：ownOnly → 恢复成损坏文件 ⇒ 仍失败（不缓存旧结论）→ 恢复合法文件 ⇒ complete。
 *
 * 用法：`node apps/desktop/scripts/u6-66-cdp.cjs --tag=<TAG>`（前置：run-all 起 dev）
 */
"use strict";
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const faults = require("./lib/u6-lineage-faults.cjs");

const TAGS = ["ancestor-error-gates", "cycle-forkinvalid-overlay", "restore-corrupt"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u6", "u6-66");
const SHOT_DIR = join(OUT_DIR, "shots");
const MARK = "U6-66";
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

const TOOL_TURN = {
  toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }],
};
const TAG_SCRIPT = {
  "ancestor-error-gates": {
    turns: [
      { content: "away" },
      TOOL_TURN,
      { content: "隔离根最终回答" },
      { content: "隔离子最终回答" },
    ],
  },
  "cycle-forkinvalid-overlay": {
    turns: [
      { content: "away" },
      TOOL_TURN,
      { content: "隔离根最终回答" },
      TOOL_TURN,
      { content: "中层 fork 最终回答" },
      { content: "孙代 fork 最终回答" },
    ],
  },
  "restore-corrupt": {
    turns: [
      { content: "away" },
      TOOL_TURN,
      { content: "隔离根最终回答" },
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
// 读数与动作（6.4/6.5 同款）
// ---------------------------------------------------------------------------

async function envOf(call, path, payload) {
  const raw = await H.apiCall(call, path, payload);
  if (raw?.ok !== true) {
    throw new Error(`${path} 信封非 ok：${JSON.stringify(raw?.error ?? raw).slice(0, 300)}`);
  }
  return raw.data;
}
const rawCall = (call, path, payload) => H.apiCall(call, path, payload);
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
async function seedRun(call, { userMessage, workspace }) {
  const data = execOfEnvelope(
    await execRaw(call, "createRun", {
      systemPrompt: "你是简洁的受控助手。",
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
function toolSpanOf(id) {
  const span = traceLines(id).find((l) => l.type === "span" && l.kind === "tool.invoke");
  if (span === undefined) throw new Error(`run ${id} 没有 tool.invoke span`);
  return span.id;
}
const selectViaStore = (call, id) =>
  H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(id)}); return JSON.stringify({ sel: s.selectedRunId });`,
  );
/** 详情状态（成功态） */
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
/** 切走切回并轮询详情**落地或失败**（ownOnly ⇒ completeness；读取失败 ⇒ error 行） */
async function reReadEither(call, awayId, targetId) {
  await selectViaStore(call, awayId);
  await H.sleep(900);
  await selectViaStore(call, targetId);
  const deadline = Date.now() + 15000;
  for (;;) {
    const st = await H.storeQ(
      call,
      `return JSON.stringify({ sel: s.selectedRunId, detailNull: s.detail === null,
         completeness: s.detail?.completeness ?? null, error: s.error });`,
    );
    if (
      st.sel === targetId &&
      (st.completeness !== null || (st.error ?? "").includes("读取 run 失败"))
    )
      return st;
    if (Date.now() > deadline)
      throw new Error(`切回 ${targetId} 后 15s 详情未收束：${JSON.stringify(st).slice(0, 200)}`);
    await H.sleep(500);
  }
}
const bodyText = (call) => H.ev(call, "(() => document.body.innerText)()");

/** 造隔离链：root(v2, 带 tool span) + child(隔离 fork) */
async function seedIsolatedChain(call) {
  if (!existsSync(join(OUT_DIR, "src-fixture")))
    mkdirSync(join(OUT_DIR, "src-fixture"), { recursive: true });
  const token = (await envOf(call, "chooseSource", null)).sourceToken;
  const root = await seedRun(call, {
    userMessage: `${MARK} 隔离根任务`,
    workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
  });
  const child = execOfEnvelope(
    await execRaw(call, "forkRun", {
      parentRunId: root,
      atSpanId: toolSpanOf(root),
      edit: { field: "result", value: `${MARK} 受控编辑` },
      execution: { mode: "isolated_files", allowFileWrites: true },
    }),
  ).id;
  return { root, child };
}

// ---------------------------------------------------------------------------
// 三个 tag
// ---------------------------------------------------------------------------

const FLOWS = {
  /** #10/#11/#12/#28：祖先损坏/未来版本/当前缺失 ⇒ 严格失败；执行入口 RUN_DETAIL_UNREADABLE */
  "ancestor-error-gates": async (call, mock) => {
    const away = await seedRun(call, { userMessage: `${MARK} away` });
    const { root, child } = await seedIsolatedChain(call);
    dump.chain = { root, child };
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    await selectViaStore(call, child);
    await H.sleep(1200);
    const before = await detailState(call);
    check(
      "正对照：完整隔离链 ⇒ complete/resolved",
      before.completeness === "complete" && before.spanScope === "resolved",
      before,
    );

    const fpBefore = H.hashAllTraces();
    const servedBase = mock.served();

    // ── ancestorCorrupt：祖先损坏 ⇒ 严格失败（UI + IPC + 执行门禁三面）
    const h1 = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: child, ancestorRunId: root },
      "ancestorCorrupt",
    );
    const env1 = await rawCall(call, "getRun", child);
    check(
      "祖先损坏 ⇒ getRun ok:false（受控中文）",
      env1?.ok === false && typeof env1?.error?.message === "string",
      env1?.error,
    );
    check(
      "损坏诊断不透传路径/盘符",
      !(env1?.error?.message ?? "").includes(":\\") &&
        !(env1?.error?.message ?? "").includes("traces"),
      env1?.error?.message,
    );
    const ui1 = await reReadEither(call, away, child);
    check(
      "UI：详情读取失败横幅（读取 run 失败）",
      (ui1.error ?? "").includes("读取 run 失败") === true,
      ui1.error,
    );
    check("UI 失败文案不泄漏盘符", !(ui1.error ?? "").includes(":\\"), ui1.error);
    const servedBeforeExec = mock.served();
    const exec1 = await execRaw(call, "promptFork", {
      parentRunId: child,
      edit: { field: "user_message", value: `${MARK} 损坏祖先上的执行尝试` },
    });
    check(
      "祖先损坏 ⇒ 执行入口 RUN_DETAIL_UNREADABLE",
      exec1?.ok === false && exec1?.error?.code === "RUN_DETAIL_UNREADABLE",
      exec1?.error,
    );
    const st1 = await H.apiCall(call, "operationsStatus", null);
    const rec1 = (st1?.data?.operations ?? []).slice(-1)[0] ?? null;
    check(
      "登记收口、runIds 空",
      rec1?.state === "settled" && Array.isArray(rec1?.runIds) && rec1.runIds.length === 0,
      { state: rec1?.state, runIds: rec1?.runIds },
    );
    check("拒绝路径零模型调用", mock.served() - servedBeforeExec === 0, mock.served());
    await H.shot(call, SHOT_DIR, `${TAG}-corrupt.png`);
    const e1 = h1.end();
    check("corrupt 注入逐字节还原", e1.clean === true, e1);

    // ── ancestorFutureVersion：版本守卫拒绝（点名版本值）
    const h2 = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: child, ancestorRunId: root },
      "ancestorFutureVersion",
    );
    const env2 = await rawCall(call, "getRun", child);
    check(
      "未来版本祖先 ⇒ getRun ok:false 且点名版本值",
      env2?.ok === false && (env2?.error?.message ?? "").includes("99") === true,
      env2?.error,
    );
    const ui2 = await reReadEither(call, away, child);
    check(
      "UI：版本失败同样进入读取失败横幅",
      (ui2.error ?? "").includes("读取 run 失败") === true,
      ui2.error,
    );
    const e2 = h2.end();
    check("version 注入逐字节还原", e2.clean === true, e2);

    // ── currentMissing：当前文件缺失 ⇒ 读取直接失败（不返回 ownOnly）
    const h3 = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: child },
      "currentMissing",
    );
    const env3 = await rawCall(call, "getRun", child);
    check(
      "当前文件缺失 ⇒ ok:false 且文案含「不存在」",
      env3?.ok === false && (env3?.error?.message ?? "").includes("不存在") === true,
      env3?.error,
    );
    const e3 = h3.end();
    check("currentMissing 注入逐字节还原", e3.clean === true, e3);

    check("全程零模型调用（读失败与拒绝都不碰受控服务）", mock.served() === servedBase, {
      servedBase,
      now: mock.served(),
    });
    const fpDiff = require("./lib/u5-read-faults.cjs").diffFingerprints(
      fpBefore,
      H.hashAllTraces(),
    );
    check(
      "全程 traces 逐字节不变",
      fpDiff.added.length === 0 && fpDiff.removed.length === 0 && fpDiff.changed.length === 0,
      fpDiff,
    );
  },

  /** #14/#15/#20：成环 / 定位非法 / 可读祖先结构非法 + 更早缺失叠加 ⇒ FORK_INVALID 优先 */
  "cycle-forkinvalid-overlay": async (call, mock) => {
    const away = await seedRun(call, { userMessage: `${MARK} away` });
    const token = (await envOf(call, "chooseSource", null)).sourceToken;
    const root = await seedRun(call, {
      userMessage: `${MARK} 隔离根任务`,
      workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
    });
    const rootTool = toolSpanOf(root);
    const mid = execOfEnvelope(
      await execRaw(call, "forkRun", {
        parentRunId: root,
        atSpanId: rootTool,
        edit: { field: "result", value: `${MARK} 中层受控编辑` },
        execution: { mode: "isolated_files", allowFileWrites: true },
      }),
    ).id;
    const grand = execOfEnvelope(
      await execRaw(call, "forkRun", {
        parentRunId: mid,
        atSpanId: toolSpanOf(mid),
        edit: { field: "result", value: `${MARK} 孙代受控编辑` },
        execution: { mode: "isolated_files", allowFileWrites: true },
      }),
    ).id;
    dump.chain = { root, mid, grand };
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    await selectViaStore(call, grand);
    await H.sleep(1200);
    const before = await detailState(call);
    check(
      "正对照：三代完整链 ⇒ complete、chain 三跳",
      before.completeness === "complete" && before.chainLen === 3,
      before,
    );

    const fpBefore = H.hashAllTraces();

    // ── lineageCycle：改 root.parent → mid ⇒ 父链成环。
    //    ⚠️ 实测形状：隔离根是 v2，补的 v1 形状 fork 先于成环判定被版本/结构校验拒 ⇒
    //    落 ANCESTOR_UNREADABLE（仍是严格失败、不降级 ownOnly）；LINEAGE_CYCLE 的专项
    //    判据（补齐合法 fork 后到达成环）由 u6-lineage-read 1.5 单测承载。
    const h1 = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: mid, ancestorRunId: root },
      "lineageCycle",
    );
    const env1 = await rawCall(call, "getRun", grand);
    check(
      "父链成环注入 ⇒ ok:false 严格失败（不降级 ownOnly、不死循环）",
      env1?.ok === false && typeof env1?.error?.message === "string",
      env1?.error,
    );
    const e1 = h1.end();
    check("cycle 注入逐字节还原", e1.clean === true, e1);

    // ── forkInvalid：grand 的 at_span → 不存在的 span ⇒ 定位非法。
    //    ⚠️ 实测形状：v2 链的边界检查在 walk 层拒绝（「fork.at_span … 不在直接父 … 的自有记录中」）。
    const h2 = faults.beginLineageFault({ tracesDir: H.TRACES, childRunId: grand }, "forkInvalid");
    const env2 = await rawCall(call, "getRun", grand);
    check(
      "at_span 不属于父轨迹 ⇒ ok:false（定位非法）",
      env2?.ok === false && (env2?.error?.message ?? "").includes("at_span") === true,
      env2?.error,
    );
    const e2 = h2.end();
    check("forkInvalid 注入逐字节还原", e2.clean === true, e2);

    // ── 叠加（#20）：可读祖先 mid 缺 fork（结构非法）+ 更早 root 缺失 ⇒ FORK_INVALID 优先于缺失
    const h3a = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: grand, ancestorRunId: mid },
      "ancestorForkMissing",
    );
    const h3b = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: mid, ancestorRunId: root },
      "ancestorMissing",
    );
    const env3 = await rawCall(call, "getRun", grand);
    check(
      "叠加 ⇒ 结构非法优先于缺失（不截成 ownOnly）",
      env3?.ok === false && (env3?.error?.message ?? "").includes("fork") === true,
      env3?.error ?? null,
    );
    const e3b = h3b.end();
    const e3a = h3a.end();
    check("叠加注入逐字节还原", e3a.clean === true && e3b.clean === true, { a: e3a, b: e3b });

    // ── 对照：单独 root 缺失 ⇒ grand ownOnly（缺失本身合法，叠加非法才严格失败）
    const h4 = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: grand, ancestorRunId: root },
      "ancestorMissing",
    );
    const ui4 = await reReadEither(call, away, grand);
    const after4 = await detailState(call);
    check(
      "对照：单独隔代缺失 ⇒ 结构化 ownOnly（missingRunId=root）",
      after4.completeness === "ownOnly" && after4.lineage?.missingRunId === root,
      after4,
    );
    void ui4;
    const e4 = h4.end();
    check("missing 注入逐字节还原", e4.clean === true, e4);
    await reReadEither(call, away, grand);
    const restored = await detailState(call);
    check(
      "恢复 ⇒ 重验 complete、chain 三跳",
      restored.completeness === "complete" && restored.chainLen === 3,
      restored,
    );
    const fpDiff = require("./lib/u5-read-faults.cjs").diffFingerprints(
      fpBefore,
      H.hashAllTraces(),
    );
    check(
      "全程 traces 逐字节不变",
      fpDiff.added.length === 0 && fpDiff.removed.length === 0 && fpDiff.changed.length === 0,
      fpDiff,
    );
  },

  /** #16：ownOnly → 恢复成损坏文件 ⇒ 仍失败（不缓存旧结论）→ 恢复合法文件 ⇒ complete */
  "restore-corrupt": async (call, mock) => {
    const away = await seedRun(call, { userMessage: `${MARK} away` });
    const { root, child } = await seedIsolatedChain(call);
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    await selectViaStore(call, child);
    await H.sleep(1200);
    const fpBefore = H.hashAllTraces();

    // 第一步：祖先缺失 ⇒ ownOnly
    const h1 = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: child, ancestorRunId: root },
      "ancestorMissing",
    );
    const st1 = await reReadEither(call, away, child);
    const d1 = await detailState(call);
    check(
      "祖先缺失 ⇒ ownOnly（结构化降级在场）",
      d1.completeness === "ownOnly" && d1.lineage?.missingRunId === root,
      d1,
    );
    void st1;
    const e1 = h1.end();
    check("缺失注入还原", e1.clean === true, e1);

    // 第二步：恢复的是**损坏文件** ⇒ 重读仍失败（不缓存旧 ownOnly、不局部拼接）
    const h2 = faults.beginLineageFault(
      { tracesDir: H.TRACES, childRunId: child, ancestorRunId: root },
      "ancestorCorrupt",
    );
    const st2 = await reReadEither(call, away, child);
    check(
      "恢复成损坏文件 ⇒ 重读仍失败（不缓存旧结论）",
      (st2.error ?? "").includes("读取 run 失败") === true && st2.detailNull === true,
      st2,
    );
    const e2 = h2.end();
    check("损坏注入还原", e2.clean === true, e2);

    // 第三步：恢复合法文件 ⇒ 全量重验 complete
    const st3 = await reReadEither(call, away, child);
    const d3 = await detailState(call);
    check(
      "恢复合法文件 ⇒ 全量重验 complete/resolved",
      st3.completeness === "complete" &&
        d3.completeness === "complete" &&
        d3.spanScope === "resolved",
      d3,
    );
    await H.shot(call, SHOT_DIR, `${TAG}-restored.png`);
    const fpDiff = require("./lib/u5-read-faults.cjs").diffFingerprints(
      fpBefore,
      H.hashAllTraces(),
    );
    check(
      "全程 traces 逐字节不变",
      fpDiff.added.length === 0 && fpDiff.removed.length === 0 && fpDiff.changed.length === 0,
      fpDiff,
    );
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
