/* eslint-disable */
/**
 * U6 任务 6.4（第一批受控实机）：普通/隔离 result 直接与隔代缺失、文件自有检查点、
 * 缺祖先与缺附件分别诊断。
 *
 * 对应 delta 场景（evidence-index #3/#4/#21/#22/#40/#41/#44/#47）：
 * - 普通 result 缺祖先只读当前记录 / 隔代祖先缺失（注入=ancestorMissing）；
 * - 合法零 span 记录可部分读取（独立 tag 的对照半边在单元层，本批以 ownOnly 形状承载）；
 * - 读取诊断不泄漏路径和正文（ownOnly 提示只含 run id，不含盘符/物理路径）；
 * - 部分普通分支不伪造共享前缀（措辞判据：固定文案 + 不出现「共享前缀」）；
 * - 部分来源链首项不冒充根（截断链标注 + 首项 = mid）；
 * - ownOnly 文件入口不显示祖先检查点 / 缺祖先与缺附件分别诊断。
 *
 * 判据纪律（同 U5）：
 * - 链条用**真 IPC** 直调（`window.api.createRun / forkRun`）现造——场景明说
 *   「绕过 UI 直接提交对应 IPC」是合法入口；UI 侧断言打在真详情渲染上；
 * - 注入用 `scripts/lib/u6-lineage-faults.cjs`（同卷 rename + finally 还原 + 逐字节核验）；
 * - **指纹基线取「注入前」**（U5 6.8 教训：拿注入中的快照当基线会把还原误判成写入）；
 * - 重读用真 store 动作（切走再切回触发新的 getRun；同 ID 短路 ⇒ 不能只重选同一条）；
 * - 「零模型调用」用受控服务 `served()` 增量立证。
 *
 * 用法：`node apps/desktop/scripts/u6-64-cdp.cjs --tag=<TAG>`
 * 前置：dev 已由 run-all 起（CDP 9612，带 REBASEAGENT_SMOKE_PICK_DIR）。
 */
"use strict";
const { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const faults = require("./lib/u6-lineage-faults.cjs");

const TAGS = ["result-direct-missing", "result-grandparent-missing", "isolated-ownonly-files"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u6", "u6-64");
const SHOT_DIR = join(OUT_DIR, "shots");
const MARK = "U6-64";
const BLOBS_DIR = join(H.REPO, ".rebaseagent", "workspace-blobs", "sha256");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

/** 各 tag 的受控剧本（回合按调用序消费：away 1 + 根 2 + 每层 fork 1） */
const TOOL_TURN = {
  toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }],
};
const TAG_SCRIPT = {
  "result-direct-missing": {
    turns: [
      { content: "away 受控回答" },
      TOOL_TURN,
      { content: "根 run 最终回答" },
      { content: "子 run（fork）最终回答" },
    ],
  },
  "result-grandparent-missing": {
    turns: [
      { content: "away 受控回答" },
      TOOL_TURN,
      { content: "根 run 最终回答" },
      // mid 的 replay 轮要再回 tool_calls ⇒ mid 才有自有 tool.invoke（孙代的编辑点）
      TOOL_TURN,
      { content: "中层 fork 最终回答" },
      { content: "孙代 fork 最终回答" },
    ],
  },
  "isolated-ownonly-files": {
    turns: [
      { content: "away 受控回答" },
      TOOL_TURN,
      { content: "隔离根最终回答" },
      { content: "隔离子 run 最终回答" },
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
  const meta = {
    head: headShort(),
    node: process.version,
    tracesCount: H.traceIds().size,
    ...extraMeta,
  };
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, meta, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 10 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 600_000);

// ---------------------------------------------------------------------------
// 读数与动作
// ---------------------------------------------------------------------------

/** 真 IPC 直调并拆信封（ok:false 直接抛，不留半截现场）——只读通道 */
async function envOf(call, path, payload) {
  const raw = await H.apiCall(call, path, payload);
  if (raw?.ok !== true) {
    throw new Error(`${path} 信封非 ok：${JSON.stringify(raw?.error ?? raw).slice(0, 300)}`);
  }
  return raw.data;
}

/**
 * 执行类通道直调（createRun / forkRun 等）：U4 起请求必须包
 * `{operation:{epoch, operationId}, request}`——epoch 取自 main（operationsStatus），
 * operationId 由调用方现生成（UUID）；响应两个分支都带登记回执。
 */
async function execOf(call, path, request) {
  const st = await H.apiCall(call, "operationsStatus", null);
  const epoch = st?.data?.epoch;
  if (typeof epoch !== "string") throw new Error(`拿不到 main epoch：${JSON.stringify(st).slice(0, 200)}`);
  const raw = await H.appImport(
    call,
    H.STORE_NEEDLE,
    `const env = await window.api.${path}({ operation: { epoch: ${JSON.stringify(epoch)}, operationId: crypto.randomUUID() }, request: ${JSON.stringify(request)} });
     return JSON.stringify(env);`,
  );
  if (raw?.ok !== true) {
    throw new Error(`${path} 信封非 ok：${JSON.stringify(raw?.error ?? raw).slice(0, 300)}`);
  }
  return raw.data;
}

/** 直调 createRun 造 run 并等它封存（真 main 执行，受控服务付费为零） */
async function seedRun(call, { systemPrompt, userMessage, workspace }) {
  const data = await execOf(call, "createRun", {
    systemPrompt: systemPrompt ?? "你是简洁的受控助手。",
    userMessage,
    ...(workspace === undefined ? {} : { workspace }),
  });
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
/** run 自有 tool.invoke span（fork 的编辑点） */
function toolSpanOf(id) {
  const span = traceLines(id).find((l) => l.type === "span" && l.kind === "tool.invoke");
  if (span === undefined) throw new Error(`run ${id} 没有 tool.invoke span，无法 result-fork`);
  return span.id;
}
/** run 自有 span id 集合（ownOnly 断言的对照面） */
function ownSpanIds(id) {
  return traceLines(id).filter((l) => l.type === "span").map((l) => l.id);
}
/** run 自有已完成 step 数（文件入口选择器期望值） */
function ownCompletedSteps(id) {
  return traceLines(id).filter((l) => l.type === "span" && l.kind === "agent.step" && l.end_ts !== undefined).length;
}

/** store 动作选 run（真 store 路径；窄档/列表态都稳） */
const selectViaStore = (call, id) =>
  H.storeQ(call, `await s.selectRun(${JSON.stringify(id)}); return JSON.stringify({ sel: s.selectedRunId });`);
/** 切走再切回 ⇒ 触发对 child 的全新 getRun（同 ID 短路 ⇒ 必须先离开）。
 *  ⚠️ selectedRunId 在详情读取落地后才更新 ⇒ 轮询到目标选中 + 完整性字段在场，不快照立刻的值 */
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
/** 详情 store 投影 */
const detailState = (call) =>
  H.storeQ(
    call,
    `const d = s.detail;
     return JSON.stringify(d === null ? null : {
       completeness: d.completeness, spanScope: d.spanScope, lineage: d.lineage,
       chainLen: d.chain.length, chainFirst: d.chain[0]?.meta?.id ?? null,
       chainIds: d.chain.map(h => h.meta.id),
       spanIds: d.spans.map(x => x.id), leafSpanIds: d.leafSpanIds,
     });`,
  );
/** 概览的来源区缺失说明——先切回概览页签（noticeDom 会切去步骤页，两者对称防串页） */
async function overviewIncomplete(call) {
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
        .find(x => (x.textContent||'').includes('概览'));
      if (b) b.click(); return 'ok'; })()`,
  );
  await H.sleep(1200);
  const raw = await H.ev(
    call,
    `(() => { const si = document.querySelector('[data-source-incomplete="true"]');
      return JSON.stringify(si === null ? null : si.textContent); })()`,
  );
  return JSON.parse(raw);
}
/** 步骤页 DOM：ownOnly 提示块 + 截断链标题（页内 JSON.stringify ⇒ 侧解析）。
 *  ⚠️ 实测锚点分布：`data-lineage-incomplete` 与截断链块在**步骤页/文件页**（tasks 4.2 口径），
 *  概览只有来源区 `data-source-incomplete` ⇒ 先切到步骤页再查。 */
async function noticeDom(call) {
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
        .find(x => (x.textContent||'').includes('步骤'));
      if (b) b.click(); return 'ok'; })()`,
  );
  await H.sleep(1200);
  const raw = await H.ev(
    call,
    `(() => {
      const li = document.querySelector('[data-lineage-incomplete="true"]');
      const copyBtn = li ? li.querySelector('button[aria-label^="复制缺失祖先 run ID"]') : null;
      const sky = Array.from(document.querySelectorAll('div')).find(d =>
        d.className && String(d.className).includes('border-sky-200'));
      return JSON.stringify({
        lineage: li === null ? null : { text: li.textContent, hasCopy: copyBtn !== null,
                                         copyLabel: copyBtn ? copyBtn.getAttribute('aria-label') : null },
        chainTitle: sky ? sky.textContent : null,
      });
    })()`,
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// 三个 tag
// ---------------------------------------------------------------------------

const FLOWS = {
  /** #3/#22/#40：直接父缺失 ⇒ 结构化 ownOnly；提示只含 run id；零模型调用；恢复后重读 complete
   *  ⚠️ 实机分层：普通 create 工具表恒空（run-create.ts:85）⇒ 不可作 fork 父本（FORK_NO_CONTEXT
   *  是产品既有门禁）。实机用**隔离链**承载同一详情面（ownOnly 提示/时间线/来源区对 v1/v2 同构）；
   *  普通 v1 的 ownOnly 行为由 u6-detail-project/u6-lineage-read 单元逐条覆盖。 */
  "result-direct-missing": async (call, mock) => {
    const away = await seedRun(call, { userMessage: `${MARK} away 任务` });
    const token = (await envOf(call, "chooseSource", null)).sourceToken;
    const root = await seedRun(call, {
      userMessage: `${MARK} result-direct 根任务`,
      workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
    });
    const toolSpan = toolSpanOf(root);
    dump.root = { id: root, toolSpan };
    const child = (
      await execOf(call, "forkRun", {
        parentRunId: root,
        atSpanId: toolSpan,
        edit: { field: "result", value: `${MARK} 受控编辑后的工具结果` },
        execution: { mode: "isolated_files", allowFileWrites: true },
      })
    ).id;
    dump.child = child;

    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    await selectViaStore(call, child);
    await H.sleep(1200);
    const before = await detailState(call);
    check("正对照：完整父链 ⇒ complete/resolved（拒绝确实来自缺失，不是请求形状）", before.completeness === "complete" && before.spanScope === "resolved", before);
    const beforeDom = await noticeDom(call);
    check("正对照：完整链无 ownOnly 提示块与截断链标注", beforeDom.lineage === null && beforeDom.chainTitle === null, beforeDom);
    check("正对照：complete/resolved 的 leafSpanIds 只是当前自有 spans", Array.isArray(before.leafSpanIds) && before.leafSpanIds.every((x) => before.spanIds.includes(x)) === true, before);

    // 指纹基线取「注入前」（U5 6.8 教训）
    const fpBefore = H.hashAllTraces();
    const servedBefore = mock.served();
    const handle = faults.beginLineageFault({ tracesDir: H.TRACES, childRunId: child, ancestorRunId: root }, "ancestorMissing");
    await reRead(call, away, child);
    const after = await detailState(call);
    const servedAfter = mock.served();
    check("重读零模型调用（读路径不碰受控服务）", servedAfter === servedBefore, { servedBefore, servedAfter });
    check("缺直接父 ⇒ ownOnly/own + ANCESTOR_NOT_FOUND", after.completeness === "ownOnly" && after.spanScope === "own" && after.lineage?.status === "incomplete" && after.lineage?.reason === "ANCESTOR_NOT_FOUND", after);
    check("missingRunId = 真实缺失的直接父", after.lineage?.missingRunId === root, { got: after.lineage?.missingRunId, want: root });
    check("chain 截断为当前 run 单跳", after.chainLen === 1 && after.chainFirst === child, after);
    const own = ownSpanIds(child);
    check("spans 精确等于自有记录（不拼父前缀、不补零）", JSON.stringify([...after.spanIds].sort()) === JSON.stringify([...own].sort()), { detail: after.spanIds, own });
    check("leafSpanIds 精确覆盖自有 spans", JSON.stringify([...after.leafSpanIds].sort()) === JSON.stringify([...own].sort()), after.leafSpanIds);

    // 概览（未切页签）：来源区缺失说明
    const ovNote = await overviewIncomplete(call);
    check("概览来源区带缺失说明（data-source-incomplete）", typeof ovNote === "string" && ovNote.includes(root) === true, ovNote);
    const dom = await noticeDom(call);
    check("ownOnly 提示块在场（固定文案 + 缺失 ID）", dom.lineage !== null && dom.lineage.text.includes("仅显示本运行记录，父链不完整") === true && dom.lineage.text.includes(root) === true, dom.lineage);
    check("复制动作是真按钮且 aria-label 带完整缺失 ID", dom.lineage?.hasCopy === true && (dom.lineage?.copyLabel ?? "").includes(root) === true, dom.lineage?.copyLabel);
    check("提示不泄漏物理路径与盘符（受控中文，只露 run id）", !dom.lineage?.text.includes(":\\") && !dom.lineage?.text.includes("traces") && !ovNote.includes(":\\"), { lineage: dom.lineage?.text, src: ovNote });
    // 口径说明是**否定式披露**（"共享前缀与祖先增量未知，不补零、不推算"）——
    // 断言它明示未知与不补零，而不是禁词扫描（禁词会连否定句一起咬，ENGINEERING 纪律）
    check(
      "口径说明明示祖先前缀未知且不补零（诚实披露，不伪造共享前缀）",
      dom.lineage?.text.includes("未知") === true && dom.lineage?.text.includes("不补零、不推算") === true,
      dom.lineage?.text,
    );
    // 单跳 ownOnly（缺直接父）⇒ 分叉链块不渲染（chain.length<=1 无来源链可列，
    // 产品不绘制虚假根叶连接）；截断链标注（多跳）由 grandparent tag 承载
    check("单跳链不渲染分叉链块（不留虚假根到叶连接）", dom.chainTitle === null, dom.chainTitle);
    await H.shot(call, SHOT_DIR, `${TAG}-ownonly-overview.png`);

    // 还原 = 父文件恢复 ⇒ 重读全量重验回 complete
    const end = handle.end();
    check("注入逐字节还原（指纹差集为空）", end.clean === true, end);
    await reRead(call, away, child);
    const restored = await detailState(call);
    check("父文件恢复后重试 ⇒ 全量重验 complete/resolved", restored.completeness === "complete" && restored.spanScope === "resolved" && restored.chainLen === 2, restored);
    const restoredDom = await noticeDom(call);
    await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
          .find(x => (x.textContent||'').includes('概览'));
        if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1200);
    const restoredOv = await overviewIncomplete(call);
    check("恢复后提示块消失（步骤页与概览来源区都干净）", restoredDom.lineage === null && restoredOv === null, { lineage: restoredDom.lineage, ov: restoredOv });
    check("全程 traces 逐字节不变（指纹差集为空）", JSON.stringify(H.hashAllTraces()) === JSON.stringify(fpBefore), null);
  },

  /** #4/#41：隔代缺失 ⇒ chain 保留 child+mid 两跳，missingRunId 是隔代根，首项不冒充根
   *  （隔离链承载，同 tag1 的分层口径；v2 整轮语义下孙代编辑点 = 直接父自有 tool span） */
  "result-grandparent-missing": async (call, mock) => {
    const away = await seedRun(call, { userMessage: `${MARK} away 任务` });
    const token = (await envOf(call, "chooseSource", null)).sourceToken;
    const root = await seedRun(call, {
      userMessage: `${MARK} result-grandparent 根任务`,
      workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
    });
    const toolSpan = toolSpanOf(root);
    const mid = (
      await execOf(call, "forkRun", {
        parentRunId: root,
        atSpanId: toolSpan,
        edit: { field: "result", value: `${MARK} 中层受控编辑` },
        execution: { mode: "isolated_files", allowFileWrites: true },
      })
    ).id;
    // 孙代：v2 整轮语义，编辑点取 mid 自有的 tool span（mid 继承 file-tools-v1 工具表 ⇒ 可 fork）
    const midToolSpan = toolSpanOf(mid);
    const child = (
      await execOf(call, "forkRun", {
        parentRunId: mid,
        atSpanId: midToolSpan,
        edit: { field: "result", value: `${MARK} 孙代受控编辑` },
        execution: { mode: "isolated_files", allowFileWrites: true },
      })
    ).id;
    dump.chain = { root, mid, child };

    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    await selectViaStore(call, child);
    await H.sleep(1200);
    const before = await detailState(call);
    check("正对照：三代完整链 ⇒ complete、chain 三跳（根→mid→child）", before.completeness === "complete" && before.chainLen === 3 && before.chainIds[0] === root, before);

    const fpBefore = H.hashAllTraces();
    const handle = faults.beginLineageFault({ tracesDir: H.TRACES, childRunId: mid, ancestorRunId: root }, "ancestorMissing");
    await reRead(call, away, child);
    const after = await detailState(call);
    check("隔代缺失 ⇒ ownOnly，chain 保留当前与直接父两跳", after.completeness === "ownOnly" && after.chainLen === 2 && after.chainIds[0] === mid && after.chainIds[1] === child, after);
    check("missingRunId = 隔代根（不误报直接父）", after.lineage?.missingRunId === root, { got: after.lineage?.missingRunId, want: root });
    const own = ownSpanIds(child);
    check("spans 仍精确等于当前 run 自有（不混入中间祖先轨迹）", JSON.stringify([...after.spanIds].sort()) === JSON.stringify([...own].sort()), { detail: after.spanIds?.length, own: own.length });
    const dom = await noticeDom(call);
    check("截断链标注在场且首项是 mid（不冒充根）", typeof dom.chainTitle === "string" && dom.chainTitle.includes("截断") === true && dom.chainTitle.includes(mid) === true, dom.chainTitle);
    await H.shot(call, SHOT_DIR, `${TAG}-grandparent-ownonly.png`);
    const end = handle.end();
    check("注入逐字节还原", end.clean === true, end);
    await reRead(call, away, child);
    const restored = await detailState(call);
    check("恢复隔代根 ⇒ 重验 complete、chain 回三跳", restored.completeness === "complete" && restored.chainLen === 3, restored);
    check("全程 traces 逐字节不变", JSON.stringify(H.hashAllTraces()) === JSON.stringify(fpBefore), null);
  },

  /** #44/#47：ownOnly 隔离 run 的文件入口只列自有检查点；缺附件 ≠ 缺祖先 */
  "isolated-ownonly-files": async (call, mock) => {
    const away = await seedRun(call, { userMessage: `${MARK} away 任务` });
    const srcDir = join(OUT_DIR, "src-fixture");
    mkdirSync(srcDir, { recursive: true });
    const srcPick = await envOf(call, "chooseSource", null);
    dump.srcPick = { name: srcPick?.name, hasToken: typeof srcPick?.sourceToken === "string" };
    check("源目录令牌签发（env 钩子）", typeof srcPick?.sourceToken === "string", srcPick);
    const root = await seedRun(call, {
      userMessage: `${MARK} 隔离根任务`,
      workspace: { mode: "isolated_files", sourceToken: srcPick.sourceToken, allowFileWrites: true },
    });
    const toolSpan = toolSpanOf(root);
    const child = (
      await execOf(call, "forkRun", {
        parentRunId: root,
        atSpanId: toolSpan,
        edit: { field: "result", value: `${MARK} 隔离子受控编辑` },
        execution: { mode: "isolated_files", allowFileWrites: true },
      })
    ).id;
    dump.chain = { root, child };

    // 子 run 自有 blob 清单（快照 manifest 引用的 sha256）
    const lines = traceLines(child);
    const hashSet = new Set();
    for (const l of lines) {
      for (const m of JSON.stringify(l).matchAll(/[0-9a-f]{64}/g)) hashSet.add(m[0]);
    }
    const childBlobs = [...hashSet].filter((h) => existsSync(join(BLOBS_DIR, h)));
    dump.childBlobs = { referenced: hashSet.size, onDisk: childBlobs.length };
    check("隔离子 run 自有检查点 blob 在盘（自有文件可读的前提）", childBlobs.length > 0, childBlobs.length);

    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    await selectViaStore(call, child);
    await H.sleep(1200);
    const before = await detailState(call);
    check("正对照：完整隔离链 ⇒ complete/resolved、v2 整轮前缀保留", before.completeness === "complete" && before.spanScope === "resolved" && before.chainLen === 2, before);

    const fpBefore = H.hashAllTraces();
    const handle = faults.beginLineageFault({ tracesDir: H.TRACES, childRunId: child, ancestorRunId: root }, "ancestorMissing");
    await reRead(call, away, child);
    const after = await detailState(call);
    check("隔离链缺根 ⇒ ownOnly + 真实 missingRunId", after.completeness === "ownOnly" && after.lineage?.missingRunId === root, after);
    const dom = await noticeDom(call);
    check("ownOnly 提示在场（文件入口不被封禁的前提下持续可见）", dom.lineage !== null, dom.lineage?.text?.slice(0, 60));

    // 文件入口：只列自有检查点（初始 + 自有完成步骤）
    await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
          .find(x => (x.textContent||'').includes('文件'));
        if (!b) return 'no-tab'; b.click(); return 'clicked'; })()`,
    );
    await H.sleep(1500);
    // 检查点选择器 = 「文件检查点」标题行内的按钮组（title 区分初始/step；role=option 是文件列表）
    const ckptRaw = await H.ev(
      call,
      `(() => {
        const head = Array.from(document.querySelectorAll('span'))
          .find(x => (x.textContent||'').trim() === '文件检查点');
        if (!head) return JSON.stringify({ error: 'no-ckpt-head' });
        const btns = Array.from(head.parentElement.querySelectorAll('button'))
          .map(b => b.getAttribute('title') ?? '');
        return JSON.stringify({ count: btns.length, titles: btns });
      })()`,
    );
    const ckpts = JSON.parse(ckptRaw);
    dump.ckpts = ckpts;
    const ownSteps = traceLines(child)
      .filter((l) => l.type === "span" && l.kind === "agent.step")
      .map((l) => l.id);
    const stepTitles = (ckpts.titles ?? []).filter((t) => t.startsWith("检查点所属 step"));
    const expected = ownSteps.length + 1; // + 初始状态
    check(`文件检查点只列自有检查点（${expected} = 自有 step + 初始）`, ckpts.count === expected, { got: ckpts.count, want: expected, titles: ckpts.titles });
    check("检查点 title 里的 step 全部是本 run 自有（祖先 step 不进选择器）", stepTitles.every((t) => ownSteps.some((id) => t.includes(id))) === true, { stepTitles, ownSteps });
    await H.shot(call, SHOT_DIR, `${TAG}-ownonly-files.png`);

    // 缺附件 ≠ 缺祖先：删子 run 自有 blob ⇒ 附件错误；祖先缺失提示同时在场（两套文案互不冒充）
    const blobFile = join(BLOBS_DIR, childBlobs[0]);
    const blobSnap = readFileSync(blobFile);
    unlinkSync(blobFile);
    try {
      // 两个定位档位都试：省略 stepSpanId（默认检查点）与显式自有 step
      const stepSpan = traceLines(child).find((l) => l.type === "span" && l.kind === "agent.step");
      const probeA = await H.apiCall(call, "readWorkspaceFile", { runId: child, path: "a.txt" });
      const probeB =
        stepSpan === undefined
          ? null
          : await H.apiCall(call, "readWorkspaceFile", {
              runId: child,
              path: "a.txt",
              stepSpanId: stepSpan.id,
            });
      dump.blobMissingProbe = { probeA, probeB };
      const failing = [probeA, probeB].find((p) => p?.data?.status === "missing") ?? null;
      check(
        "blob 缺失 ⇒ 附件读取六态里的 missing（不是祖先缺失语义）",
        failing !== null && JSON.stringify(failing.data ?? {}).includes("附件不存在") === true,
        failing?.data,
      );
      const dom2 = await noticeDom(call);
      check("附件缺失期间祖先缺失提示仍在场（两套诊断互不冒充）", dom2.lineage !== null && dom2.lineage.text.includes(root) === true, dom2.lineage?.text?.slice(0, 60));
    } finally {
      writeFileSync(blobFile, blobSnap);
    }
    const probeOk = await H.apiCall(call, "readWorkspaceFile", { runId: child, path: "a.txt" });
    check("blob 还原后自有附件恢复可读（逐字节写回 ⇒ text 六态）", probeOk?.data?.status === "text", probeOk?.data ?? probeOk?.error ?? null);
    check("blob 目录逐字节还原", existsSync(blobFile) && readFileSync(blobFile).equals(blobSnap) === true, null);

    const end = handle.end();
    check("注入逐字节还原", end.clean === true, end);
    check("全程 traces 逐字节不变", JSON.stringify(H.hashAllTraces()) === JSON.stringify(fpBefore), null);
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
