/* eslint-disable */
/**
 * U7 任务 6.5（Electron 实机第二批）：普通/隔离父子编辑值、最终/缺失输出、
 * 长文本复制查找、不同根、兄弟多跳及两侧独立调用；覆盖 Monaco 就绪与全文读取。
 *
 * 对应 delta 场景（evidence-index #12、#28–#34、#41、#43、#50–#53、#54–#55、
 * #56–#57、#59–#60）。
 *
 * 判据纪律（同 6.4）：
 * - 标本由 run-all 在起 dev 前注入（u7-compare 22 份 + isolated 3 份 + u7r_* 5 份
 *   + u7f_* 5 份生成标本）；本脚本只做只读验证，零执行通道、零模型调用；
 * - 数值期望（tokens/缓存）由本脚本**读 fixtures 现算**，不硬编码；
 * - 不可达半边如实分层（同 6.4：reason 枚举外形态不伪造）。
 *
 * 用法：`node apps/desktop/scripts/u7-65-cdp.cjs --tag=<TAG>`
 * TAG：compare-detail（比较工作区全路径） | compare-overview（概览自有输出/来源）
 * 前置：dev 已由 run-all 起（CDP 9612），完整标本集已注入。
 */
"use strict";
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["compare-detail", "compare-overview"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u7", "u7-65");
const SHOT_DIR = join(OUT_DIR, "shots");
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
  console.error(`看门狗：${TAG} 超过 12 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 720_000);

// ---------------------------------------------------------------------------
// fixtures 现算期望值（不硬编码数字；判据 = 真实 trace 文件实读）
// ---------------------------------------------------------------------------

const FIXTURE_TRACES = join(
  H.REPO,
  "apps",
  "desktop",
  "test",
  "fixtures",
  "u7-compare",
  "traces",
);

function readFixture(id) {
  const p = join(FIXTURE_TRACES, `${id}.jsonl`);
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}
function llmCallsOf(id) {
  return readFixture(id).filter((l) => l.kind === "llm.call");
}
/** 自有 llm usage 求和（标本文件即自有记录） */
function ownUsage(id) {
  let tin = 0;
  let tout = 0;
  for (const c of llmCallsOf(id)) {
    tin += c.response?.usage?.in ?? 0;
    tout += c.response?.usage?.out ?? 0;
  }
  return { in: tin, out: tout, total: tin + tout };
}
/** 复刻 compare-metrics 的缓存解释文案（测试 oracle，仅用于期望值） */
function cacheStrOf(id) {
  const calls = llmCallsOf(id);
  const total = calls.length;
  const withHit = calls.filter((c) => typeof c.response?.usage?.cache_hit === "number");
  const hitTotal = withHit.reduce((s, c) => s + c.response.usage.cache_hit, 0);
  if (withHit.length === 0) {
    return total === 0 ? "无自有模型调用" : "未记录（命中量未知）";
  }
  return `${hitTotal}（已记录 ${withHit.length} / ${total} 次调用）`;
}
/** 中间正文（最后一条**非空**正文；deriveOwnOutput 的 latestIntermediate 同口径） */
function lastContent(id) {
  const calls = llmCallsOf(id);
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]?.response?.content;
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}
/** 指标表数字缩写格式（实测 1728→"1.7k"、7593→"7.6k"、<1000 原样；测试 oracle） */
function fmt(n) {
  return n < 1000 ? String(n) : `${Math.round(n / 100) / 10}k`;
}
/** 父轨迹某 span 的工具名（编辑点工具标注期望） */
function toolOf(id, spanId) {
  const hit = readFixture(id).find((l) => l.kind === "tool.invoke" && l.id === spanId);
  return hit?.tool ?? null;
}

// 生成标本的固定常量（run-all genSpecimens65 写死，此处对齐）
const GEN = {
  u7f_r1: { usage: { in: 900, out: 30 } },
  u7f_n2: { usage: { in: 800, out: 20 } },
  u7f_n3: { usage: { in: 800, out: 20 } },
  u7f_e1: { usage: { in: 700, out: 15 } },
  u7f_z1: { usage: { in: 0, out: 0 } },
};
const usageStr = (u) => `${u.in} / ${u.out}`;

// 派生期望：#59 数字（g→p→c 链）
const U_G = ownUsage("u7c_g");
const U_P = ownUsage("u7c_p");
const U_C = ownUsage("u7c_c");
const EXP = {
  ownG: usageStr(U_G),
  ownC: usageStr(U_C),
  chainC: usageStr({ in: U_G.in + U_P.in + U_C.in, out: U_G.out + U_P.out + U_C.out }),
  deltaC: usageStr({ in: U_P.in + U_C.in, out: U_P.out + U_C.out }), // 侧累计 − 祖先累计（祖先含全部上游）
  fmtOwnG: fmt(U_G.total),
  fmtOwnC: fmt(U_C.total),
  fmtChainC: fmt(U_G.total + U_P.total + U_C.total),
  fmtDeltaC: fmt(U_P.total + U_C.total), // pair(g,c)：祖先 = g
  fmtInC: fmt(U_C.in),
  fmtOutC: fmt(U_C.out),
  fmtInG: fmt(U_G.in),
  fmtInP: fmt(U_P.in),
  cacheG: cacheStrOf("u7c_g"),
  cacheC: cacheStrOf("u7c_c"),
  cacheL1: cacheStrOf("u7c_l1"),
  cacheL2: cacheStrOf("u7c_l2"),
  cacheErr: cacheStrOf("u7c_err"),
  cacheZ1: "未记录（命中量未知）",
  toolG_S03: toolOf("u7c_g", "s_03"),
  interErr: lastContent("u7c_err"),
  finalG: lastContent("u7c_g"),
  finalL1: lastContent("u7c_l1"),
};
dump.expect = EXP;

// ---------------------------------------------------------------------------
// 读数与动作
// ---------------------------------------------------------------------------

/** DPR 哨兵：zoom 残留会让几何判据全假（U6 6.8 教训） */
async function dprSentinel(call) {
  const dpr = await H.ev(call, "window.devicePixelRatio");
  check("DPR ≈ 2.1（无 zoom 残留）", Math.abs(dpr - 2.1) < 0.15, `实测 ${dpr}`);
  return dpr;
}

const storeState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       view: s.view, selectedRunId: s.selectedRunId, runsN: s.runs.length,
       compareIds: s.compareIds, compareNotice: s.compareNotice,
       comparePair: s.comparePair, compareReturnLocation: s.compareReturnLocation,
       compareStepSelection: s.compareStepSelection,
       comparePrefixFolded: s.comparePrefixFolded,
       readSel: s.compareRead ? { selection: s.compareRead.selection, generation: s.compareRead.generation,
         kind: s.compareRead.conclusion ? s.compareRead.conclusion.kind : null,
         runIds: s.compareRead.conclusion && s.compareRead.conclusion.runIds ? s.compareRead.conclusion.runIds : null } : null,
     });`,
  );

/** 清集合 + 按加入顺序选两条 + 进入比较工作区（2 条 ⇒ 自动 pair：先选在左） */
async function setPair(call, l, r) {
  await H.storeQ(
    call,
    `s.clearCompare();
     s.toggleCompare(${JSON.stringify(l)});
     s.toggleCompare(${JSON.stringify(r)});
     await s.openCompareWorkspace();
     return JSON.stringify("ok");`,
  );
  await H.sleep(700);
  return waitDetail(call);
}

/** 等详细比较模式对齐（左列输出在场且 loading 文案消失），返回工作区文本 */
async function waitDetail(call, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await H.ev(
      call,
      `(() => {
         const ws = document.querySelector('[aria-label="比较工作区"]');
         return JSON.stringify({
           hasLeft: document.querySelector('[aria-label="左列输出"]') !== null,
           loading: ws !== null && ws.textContent.includes('正在读取详细比较对象'),
           text: ws === null ? null : ws.textContent,
         });
       })()`,
    ).then(JSON.parse);
    if (p !== null && p.hasLeft && !p.loading) return p;
    if (Date.now() > deadline) return p;
    await H.sleep(400);
  }
}

/** 编辑证据区读数（[aria-label="修改证据"] 整节文本） */
const evidenceText = (call) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('[aria-label="修改证据"]');
       return JSON.stringify({ present: sec !== null, text: sec === null ? null : sec.textContent });
     })()`,
  ).then(JSON.parse);

/** 单侧输出区读数 */
const sideText = (call, side) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('[aria-label="${side}输出"]');
       return JSON.stringify({
         present: sec !== null,
         text: sec === null ? null : sec.textContent,
         failBtn: sec === null ? null : (sec.querySelector('button[aria-label*="失败调用"]')?.getAttribute('aria-label') ?? null),
       });
     })()`,
  ).then(JSON.parse);

/** 步骤目录读数（按侧 runId；aria-labels 单列——span id 只在 aria-label 不在行文本） */
const catalogOf = (call, runId) =>
  H.ev(
    call,
    `(() => {
       const ul = document.querySelector('[data-testid="compare-steps-' + ${JSON.stringify(runId)} + '"]');
       if (ul === null) return JSON.stringify(null);
       const lis = Array.from(ul.children);
       const btn = ul.querySelector('button[aria-label="展开完整前缀"]');
       const labels = Array.from(ul.querySelectorAll('button')).map(b => b.getAttribute('aria-label'));
       return JSON.stringify({
         liCount: lis.length,
         text: ul.textContent,
         prefixSummary: btn === null ? null : btn.textContent,
         labels,
       });
     })()`,
  ).then(JSON.parse);

/** 指标表：切表 + 等挂载 + 逐行读数（label → 各列单元格文本） */
async function openMetrics(call) {
  await H.sleep(700);
  await H.ev(
    call,
    `(() => {
       const b = document.querySelector('[aria-label="查看指标对照表"]');
       if (b) b.click();
       return JSON.stringify(b ? 'clicked' : 'absent');
     })()`,
  );
  const deadline = Date.now() + 15000;
  for (;;) {
    const p = await H.ev(
      call,
      `(() => {
         const t = document.querySelector('table');
         const ws = document.querySelector('[aria-label="比较工作区"]');
         return JSON.stringify({ hasTable: t !== null, wsText: ws === null ? null : ws.textContent });
       })()`,
    ).then(JSON.parse);
    if (p !== null && p.hasTable) return p;
    if (Date.now() > deadline) return p;
    await H.sleep(400);
  }
}

/** 表逐行读数：tbody 每行 {label, cells[]}（label=首个 th/td，cells=其余 td） */
const metricsRows = (call) =>
  H.ev(
    call,
    `(() => {
       const t = document.querySelector('table');
       if (t === null) return JSON.stringify(null);
       const rows = Array.from(t.querySelectorAll('tbody tr')).map(tr => {
         const first = tr.querySelector('th') ?? tr.querySelector('td');
         const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim());
         return { label: first ? (first.textContent || '').trim() : null, cells };
       });
       return JSON.stringify(rows);
     })()`,
  ).then(JSON.parse);

function rowOf(rows, label) {
  if (rows === null) return null;
  const hit = rows.find((r) => r.label === label);
  return hit ?? null;
}

/** 概览读数：选中 run 后等 [aria-label="运行概览"]，按 section 拆文本 */
async function overviewOf(call, runId, timeoutMs = 15000) {
  await H.storeQ(call, `await s.selectRun(${JSON.stringify(runId)}); return JSON.stringify("ok");`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await H.ev(
      call,
      `(() => {
         const ov = document.querySelector('[aria-label="运行概览"]');
         if (ov === null) return JSON.stringify(null);
         const sec = (name) => {
           const el = ov.querySelector('[aria-label="' + name + '"]');
           return el === null ? null : el.textContent;
         };
         return JSON.stringify({
           text: ov.textContent,
           outcome: sec('运行结局'), result: sec('运行结果'), llmError: sec('LLM 错误'),
           toolError: sec('工具错误'), consumption: sec('本次消耗'), source: sec('来源'),
           compareParentBtn: ov.querySelector('[aria-label="与父运行对比（父左子右）"]') !== null,
         });
       })()`,
    ).then(JSON.parse);
    if (p !== null) return p;
    if (Date.now() > deadline) return null;
    await H.sleep(400);
  }
}

// ---------------------------------------------------------------------------
// tag：compare-detail（比较工作区全路径）
// ---------------------------------------------------------------------------

const FLOWS = {
  async "compare-detail"(call) {
    await dprSentinel(call);
    const st0 = await storeState(call);
    check(
      "标本已注入且应用可见（≥35 条：22 手工 + 3 隔离 + 5 终止原因 + 5 生成）",
      st0.runsN >= 35,
      `runsN=${st0.runsN}`,
    );
    dump.runsN = st0.runsN;

    // ── #50 直接父子真实编辑前后值（v1：u7c_g → u7c_p） ──
    let detail = await setPair(call, "u7c_g", "u7c_p");
    check("#50 前置：pair(g,p) 详情对齐", detail !== null && detail.hasLeft === true);
    let ev = await evidenceText(call);
    check(
      "#50 v1 verified：字段/方向/编辑点身份（result · 左列 → 右列 · g→p · s_03）",
      ev.present === true &&
        (ev.text || "").includes("字段「result」") &&
        (ev.text || "").includes("左列 → 右列") &&
        (ev.text || "").includes("u7c_g") &&
        (ev.text || "").includes("u7c_p") &&
        (ev.text || "").includes("s_03"),
      (ev.text || "").slice(0, 160),
    );
    check(
      "#50 语义徽标「共享父前缀 · 单点编辑」+ 工具结果编辑标注（工具名保留）",
      (ev.text || "").includes("共享父前缀 · 单点编辑") &&
        (ev.text || "").includes("工具结果编辑") &&
        (ev.text || "").includes(String(EXP.toolG_S03)),
      { tool: EXP.toolG_S03 },
    );
    check(
      "#50 原值/新值真实在场（G 原始观察 α → P 编辑后 β；LongText 折叠态 DOM 持有全文）",
      (ev.text || "").includes("原值（共同区保留原值）") &&
        (ev.text || "").includes("新值（fork 编辑值）") &&
        (ev.text || "").includes("README 内容 α") &&
        (ev.text || "").includes("README 内容 β"),
      null,
    );
    await H.shot(call, SHOT_DIR, "evidence-v1-direct.png");

    // ── #50 v2 隔离整轮边界（isolated_root → fork1，resume_after_step=s_04） ──
    detail = await setPair(call, "run_muo988yd_4btbgb", "run_muo9892a_w2qj");
    check("#50 前置：隔离 v2 pair 详情对齐", detail !== null && detail.hasLeft === true);
    ev = await evidenceText(call);
    check(
      "#50 v2 verified：隔离整轮边界标注（s_04 之后续跑）",
      ev.present === true &&
        (ev.text || "").includes("隔离整轮边界") &&
        (ev.text || "").includes("之后续跑") &&
        (ev.text || "").includes("s_04"),
      (ev.text || "").slice(0, 200),
    );
    check(
      "#50 v2 字段 result + 方向（隔离父 → 隔离子）",
      (ev.text || "").includes("字段「result」") &&
        (ev.text || "").includes("run_muo988yd_4btbgb") &&
        (ev.text || "").includes("run_muo9892a_w2qj"),
      null,
    );

    // ⚠️ #51 配对语义：p×c 是**直接父子**（出单点编辑证据，见 #50）；隔代 g×c 与
    // 兄弟 c×s 才出逐跳链。逐跳断言分别挂在下方 #56（g×c）与 #57（c×s）的 pair 上。

    // ── #52/#12 不同根（d1 × d2：事实并排 + 指标表不判祖先） ──
    detail = await setPair(call, "u7c_d1", "u7c_d2");
    check("#52 前置：pair(d1,d2) 详情对齐", detail !== null && detail.hasLeft === true);
    ev = await evidenceText(call);
    check(
      "#52 不同根标题（不声称分叉修改或共同前缀）",
      (ev.text || "").includes("不同根：只核对两侧实际输入配置"),
      (ev.text || "").slice(0, 120),
    );
    check(
      "#52 两侧事实并排：模型/system/user/参数取各自实际请求（d1 中文 vs d2 英文，逐字不同）",
      (ev.text || "").includes("u7c_d1") &&
        (ev.text || "").includes("u7c_d2") &&
        (ev.text || "").includes("deepseek-chat") &&
        (ev.text || "").includes("deepseek-reasoner") &&
        (ev.text || "").includes("任务 D1：总结构建日志") &&
        (ev.text || "").includes("Task D2: summarize build logs") &&
        (ev.text || "").includes("temperature"),
      null,
    );
    check("#52 不同根不得出现共同祖先判定", !(detail?.text || "").includes("共同祖先："), null);
    const m12 = await openMetrics(call);
    check(
      "#12 指标表：分属不同根 ⇒ 增量不计算说明 + 不冒充共同祖先",
      m12 !== null &&
        (m12.wsText || "").includes("分属不同根") &&
        !(m12.wsText || "").includes("共同祖先：u7c"),
      (m12?.wsText || "").slice(0, 180),
    );
    const rows12 = await metricsRows(call);
    check(
      "#12 两侧累计各自可读（累计增量 tokens 行两列均有数字）",
      (() => {
        const r = rowOf(rows12, "累计增量（tokens）");
        return (
          r !== null && r.cells.length >= 2 && r.cells.every((c) => /\d/.test(c))
        );
      })(),
      rowOf(rows12, "累计增量（tokens）"),
    );
    // 回详细比较
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="返回详细比较"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(900);
    await waitDetail(call);

    // ── #53 未记录 vs 真实空串（g × n2 / g × n3） ──
    detail = await setPair(call, "u7c_g", "u7f_n2");
    ev = await evidenceText(call);
    check(
      "#53 EDIT_VALUE_UNRECORDED：琥珀块稳定码 + 新值「未记录（不是空值）」",
      ev.present === true &&
        (ev.text || "").includes("EDIT_VALUE_UNRECORDED") &&
        (ev.text || "").includes("未记录（不是空值）"),
      (ev.text || "").slice(0, 200),
    );
    check(
      "#53 EDIT_VALUE_UNRECORDED ⇒ 整条不可核对：原值与新值都不补空（原值不反推，两处「未记录（不是空值）」）",
      ((ev.text || "").match(/未记录（不是空值）/g) || []).length >= 2,
      { hits: ((ev.text || "").match(/未记录（不是空值）/g) || []).length },
    );
    detail = await setPair(call, "u7c_g", "u7f_n3");
    ev = await evidenceText(call);
    check(
      "#53 真实空串是 value 不是未记录：新值块在场且无「未记录（不是空值）」",
      ev.present === true &&
        (ev.text || "").includes("新值（fork 编辑值）") &&
        !(ev.text || "").includes("未记录（不是空值）") &&
        !(ev.text || "").includes("EDIT_VALUE_UNRECORDED"),
      (ev.text || "").slice(0, 200),
    );
    await H.shot(call, SHOT_DIR, "evidence-empty-vs-unrecorded.png");

    // ── #54 最终输出分层（err × g：错误侧 unavailable + 中间正文 + 失败定位按钮） ──
    detail = await setPair(call, "u7c_err", "u7c_g");
    check("#54 前置：pair(err,g) 详情对齐", detail !== null && detail.hasLeft === true);
    const leftOut = await sideText(call, "左列");
    check(
      "#54 失败侧：出错终止徽标 + 未记录最终输出（最终调用带错误）+ 中间正文不冒充",
      leftOut.present === true &&
        (leftOut.text || "").includes("出错终止") &&
        (leftOut.text || "").includes("未记录最终输出") &&
        (leftOut.text || "").includes("最终调用带错误") &&
        (leftOut.text || "").includes("中间正文（不是最终结果）") &&
        (leftOut.text || "").includes(String(EXP.interErr)),
      (leftOut.text || "").slice(0, 200),
    );
    check(
      "#54 失败定位按钮绑定该侧身份（打开 u7c_err 的失败调用 · s_05）",
      (leftOut.text || "").includes("打开失败调用（s_05）") &&
        (leftOut.failBtn || "").includes("u7c_err"),
      leftOut.failBtn,
    );
    const rightOut54 = await sideText(call, "右列");
    check(
      "#54 就绪侧：最终输出在场（G 完成…）",
      (rightOut54.text || "").includes(String(EXP.finalG)),
      null,
    );
    const diffBtnErr = await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="切换文本差异"]');
         return JSON.stringify({ disabled: b ? b.disabled : null, title: b ? b.title : null }); })()`,
    ).then(JSON.parse);
    check(
      "#54 diff 门禁禁用：错误侧不能作为空文本参与 diff（title 说明缺因）",
      diffBtnErr.disabled === true && (diffBtnErr.title || "").includes("带错误"),
      diffBtnErr,
    );
    // 真实点击打开失败调用 → 跳 trace 视图 + 该侧 run 选中（pair 保留）
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label*="失败调用"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1400);
    let st = await storeState(call);
    check(
      "#54 打开失败调用落地：view=trace + 选中 u7c_err（pair 保留在 store）",
      st.view === "trace" && st.selectedRunId === "u7c_err" && st.comparePair !== null,
      { view: st.view, sel: st.selectedRunId, pair: st.comparePair },
    );
    // 页头常驻「返回比较」
    const backBar = await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="返回比较工作区"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1200);
    detail = await waitDetail(call);
    check("#54 返回比较：详情恢复（pair err×g）", detail !== null && detail.hasLeft === true);
    await H.shot(call, SHOT_DIR, "output-error-side.png");

    // ── #55 reasoning-only 侧（g × r1：思维链不参与伪空比较） ──
    detail = await setPair(call, "u7c_g", "u7f_r1");
    const rightOut55 = await sideText(call, "右列");
    check(
      "#55 reasoning-only：未记录最终输出 + 无正文分型（不借祖先正文；思维链措辞归概览层 #32）",
      (rightOut55.text || "").includes("未记录最终输出") &&
        (rightOut55.text || "").includes("无正文") &&
        !(rightOut55.text || "").includes(String(EXP.finalG)),
      (rightOut55.text || "").slice(0, 200),
    );
    const diffBtnR = await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="切换文本差异"]');
         return JSON.stringify({ disabled: b ? b.disabled : null, title: b ? b.title : null }); })()`,
    ).then(JSON.parse);
    check(
      "#55 diff 门禁禁用：无正文侧（最终调用无正文）",
      diffBtnR.disabled === true && (diffBtnR.title || "").includes("无正文"),
      diffBtnR,
    );

    // ── #55 长输出（l1 × l2：独立滚动 + Monaco diff 就绪 + 查找/复制） ──
    detail = await setPair(call, "u7c_l1", "u7c_l2");
    check("#55 前置：pair(l1,l2) 详情对齐", detail !== null && detail.hasLeft === true);
    // 先展开左列最终输出 LongText（折叠态列内容太短，滚动判据与查找框都需要展开态）
    // ⚠️ LongText 折叠入口是 <details><summary>，不是 button（实测踩过）
    const expanded = await H.ev(
      call,
      `(() => {
         const sec = document.querySelector('[aria-label="左列输出"]');
         const sum = Array.from(sec.querySelectorAll('details > summary'))
           .find(s => (s.textContent || '').includes('点击展开完整内容'));
         if (sum) sum.click();
         return JSON.stringify(sum ? 'clicked' : 'absent');
       })()`,
    );
    await H.sleep(700);
    check("#55 长文本折叠态有展开入口（summary 摘要行带字符数）", expanded === '"clicked"', expanded);
    // 两列独立滚动：滚左列不影响右列（展开后列内容远超视口）
    const scrollProbe = await H.ev(
      call,
      `(() => {
         const ws = document.querySelector('[aria-label="比较工作区"]');
         const cols = Array.from(ws.querySelectorAll('div')).filter(d =>
           typeof d.className === 'string' && d.className.includes('overflow-y-auto') &&
           d.querySelector(':scope > [aria-label="左列输出"], :scope > [aria-label="右列输出"]'));
         const left = cols.find(d => d.querySelector(':scope > [aria-label="左列输出"]'));
         const right = cols.find(d => d.querySelector(':scope > [aria-label="右列输出"]'));
         if (!left || !right) return JSON.stringify(null);
         left.scrollTop = 300;
         return JSON.stringify({ leftTop: left.scrollTop, rightTop: right.scrollTop,
           leftScrollable: left.scrollHeight > left.clientHeight });
       })()`,
    ).then(JSON.parse);
    check(
      "#55 默认两列独立滚动：左列滚动、右列保持 0（互不影响）",
      scrollProbe !== null &&
        scrollProbe.leftTop > 100 &&
        scrollProbe.rightTop === 0 &&
        scrollProbe.leftScrollable === true,
      scrollProbe,
    );
    // 查找/复制：展开态下的就近工具条
    const findProbe = await H.ev(
      call,
      `(() => {
         const sec = document.querySelector('[aria-label="左列输出"]');
         const input = sec.querySelector('input[aria-label="在最终输出中查找"]');
         if (input === null) return JSON.stringify(null);
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         setter.call(input, '银钥匙');
         input.dispatchEvent(new Event('input', { bubbles: true }));
         const copyBtn = Array.from(sec.querySelectorAll('button'))
           .find(b => (b.textContent || '').includes('复制原文'));
         return JSON.stringify({ found: true, copyPresent: copyBtn !== undefined,
           textLen: sec.textContent.length });
       })()`,
    ).then(JSON.parse);
    check(
      "#55 长文本展开后查找/复制工具就位（银钥匙命中计数 + 复制原文按钮）",
      findProbe !== null && findProbe.found === true && findProbe.copyPresent === true,
      findProbe,
    );
    // 计数反馈（aria-live 文本）
    const countProbe = await H.ev(
      call,
      `(() => {
         const sec = document.querySelector('[aria-label="左列输出"]');
         const live = sec.querySelector('[aria-live="polite"]');
         return JSON.stringify({ counter: live === null ? null : live.textContent });
       })()`,
    ).then(JSON.parse);
    check(
      "#55 查找计数反馈在场（第 n / m 个）",
      countProbe !== null &&
        countProbe.counter !== null &&
        /第\s*\d+\s*\/\s*\d+/.test(countProbe.counter),
      countProbe,
    );
    // Monaco diff：点「切换文本差异」→ 等 monaco 就绪
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="切换文本差异"]'); if (b) b.click(); return 'ok'; })()`,
    );
    let monacoOk = false;
    let monacoDetail = null;
    for (let i = 0; i < 40; i++) {
      monacoDetail = await H.ev(
        call,
        `(() => {
           const panel = document.querySelector('[data-testid="compare-diff-panel"]');
           const monacoEditors = document.querySelectorAll('.monaco-editor').length;
           const diffEditor = document.querySelectorAll('.monaco-diff-editor').length;
           const ws = document.querySelector('[aria-label="比较工作区"]');
           return JSON.stringify({ panel: panel !== null,
             monacoEditors, diffEditor, wsText: ws === null ? null : ws.textContent });
         })()`,
      ).then(JSON.parse);
      if (monacoDetail !== null && monacoDetail.monacoEditors >= 2 && monacoDetail.diffEditor >= 1) {
        monacoOk = true;
        break;
      }
      await H.sleep(500);
    }
    check(
      "#55 Monaco diff 就绪：懒加载容器 + 两侧 monaco 编辑器实例（同步滚动仅 diff 模式）",
      monacoOk === true && monacoDetail.panel === true,
      monacoDetail === null
        ? null
        : { panel: monacoDetail.panel, monacoEditors: monacoDetail.monacoEditors, diffEditor: monacoDetail.diffEditor },
    );
    check(
      "#55 diff 标注（左侧 → 右侧 + 仅双方均有已记录最终输出时可用）",
      (monacoDetail?.wsText || "").includes("只读文本差异") &&
        (monacoDetail?.wsText || "").includes("仅双方均有已记录最终输出时可用"),
      (monacoDetail?.wsText || "").match(/只读文本差异[^】]{0,80}/)?.[0] ?? null,
    );
    await H.shot(call, SHOT_DIR, "monaco-diff.png");
    // 退出 diff 回两列
    await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => (x.textContent || '').includes('退出文本差异')); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(900);
    const backCols = await H.ev(
      call,
      `(() => JSON.stringify({
         panel: document.querySelector('[data-testid="compare-diff-panel"]') !== null,
         left: document.querySelector('[aria-label="左列输出"]') !== null }))()`,
    ).then(JSON.parse);
    check("#55 退出 diff：回两列独立滚动（diff 面板卸载）", backCols.panel === false && backCols.left === true, backCols);

    // ── #56 共享前缀边界（g × c：C 侧目录折叠/展开）+ #51 逐跳链 ──
    // ⚠️ resolveBranch 前缀语义 = **截至 fork 点（含）**：C 的合并视图前缀 =
    //   g 的 s_01–s_03（至 p 的 fork 点）+ p 的 s_06–s_08（至 c 的 fork 点）= 6 条，
    //   不是全部祖先 span（g 的 s_04/s_05 与 p 的 s_09/s_10 按设计截断）。
    detail = await setPair(call, "u7c_g", "u7c_c");
    check("#56 前置：pair(g,c) 详情对齐", detail !== null && detail.hasLeft === true);
    // #51：g×c 隔代 ⇒ 逐跳链（不压缩成一次编辑）
    ev = await evidenceText(call);
    check(
      "#51 多跳：标题「逐跳来源链，不压缩为一次编辑」+ 到 u7c_c 的来源路径",
      (ev.text || "").includes("逐跳来源链，不压缩为一次编辑") &&
        (ev.text || "").includes("到 u7c_c 的来源路径"),
      (ev.text || "").slice(0, 120),
    );
    check(
      "#51 逐跳身份连续：g → p 与 p → c 两跳均「已核对」（跳数 = 链长）",
      (ev.text || "").includes("u7c_g → u7c_p") &&
        (ev.text || "").includes("u7c_p → u7c_c") &&
        ((ev.text || "").match(/已核对/g) || []).length >= 2,
      { hopHits: ((ev.text || "").match(/已核对/g) || []).length },
    );
    await H.shot(call, SHOT_DIR, "evidence-hops.png");
    let cat = await catalogOf(call, "u7c_c");
    check(
      "#56 折叠摘要：6 条前缀来自 g、p + 2 处编辑（截至 fork 点的截断语义）",
      cat !== null &&
        (cat.prefixSummary || "").includes("共享前缀：6 条来自 u7c_g、u7c_p") &&
        (cat.prefixSummary || "").includes("含 2 处编辑") &&
        cat.liCount === 3,
      { summary: cat?.prefixSummary, liCount: cat?.liCount },
    );
    // 展开
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-testid="compare-steps-u7c_c"] button[aria-label="展开完整前缀"]');
         if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(700);
    cat = await catalogOf(call, "u7c_c");
    check(
      "#56 展开后 8 行全量：编辑点标记恰 2 处（s_03/s_08）+ 前缀来源归属（来自 g/p）+ 自有行（LLM 调用）",
      cat !== null &&
        cat.liCount === 8 &&
        ((cat.text || "").match(/编辑点（result）/g) || []).length === 2 &&
        (cat.text || "").includes("来自 u7c_g") &&
        (cat.text || "").includes("来自 u7c_p") &&
        (cat.text || "").includes("LLM 调用"),
      {
        liCount: cat?.liCount,
        edits: ((cat?.text || "").match(/编辑点（result）/g) || []).length,
        fromG: (cat?.text || "").includes("来自 u7c_g"),
        fromP: (cat?.text || "").includes("来自 u7c_p"),
        llm: (cat?.text || "").includes("LLM 调用"),
        probe: (cat?.text || "").slice(0, 300),
      },
    );
    check(
      "#56 编辑点行琥珀标记 + 字段名（差异保留不隐藏）",
      (cat.text || "").includes("编辑点（result）"),
      null,
    );
    await H.shot(call, SHOT_DIR, "steps-prefix.png");

    // ── #57 重复 span ID（c × s：同 s_11/s_12 各归各列）+ #51 兄弟两臂逐跳链 ──
    detail = await setPair(call, "u7c_c", "u7c_s");
    check("#57 前置：pair(c,s) 详情对齐", detail !== null && detail.hasLeft === true);
    // #51 兄弟：共同祖先 = p，各侧从共同祖先逐跳列出 ⇒ 每侧恰 1 跳（跳数 = 链长）
    ev = await evidenceText(call);
    check(
      "#51 兄弟两臂：两侧逐跳链各自列出（到 c 与到 s 的来源路径），每侧 1 跳不压缩",
      (ev.text || "").includes("到 u7c_c 的来源路径") &&
        (ev.text || "").includes("到 u7c_s 的来源路径") &&
        (ev.text || "").includes("u7c_p → u7c_c") &&
        (ev.text || "").includes("u7c_p → u7c_s") &&
        ((ev.text || "").match(/已核对/g) || []).length >= 2,
      { hopHits: ((ev.text || "").match(/已核对/g) || []).length },
    );
    const catC = await catalogOf(call, "u7c_c");
    const catS = await catalogOf(call, "u7c_s");
    check(
      "#57 两侧目录独立挂载（data-testid 按 runId 区分）",
      catC !== null && catS !== null,
      { c: catC !== null, s: catS !== null },
    );
    // ⚠️ span id 在 aria-label（选中 s_NN）而非行文本；按 aria-label 数行数
    const spanRowsOf = (cat) =>
      cat === null ? 0 : (cat.labels || []).filter((l) => /^选中 s_/.test(l ?? "")).length;
    const hasSpan = (cat, id) => cat !== null && (cat.labels || []).includes(`选中 ${id}`);
    // ⚠️ setPair 进 pair 时两侧折叠态重置为 true ⇒ 折叠视图 = 摘要行 + 自有行；
    // 重复 ID 的自有行（s_11/s_12）两侧各自在场即「各归各列」的直接证据
    check(
      "#57 重复身份各归各列：折叠态两侧各自的自有 s_11/s_12 行在场（身份 = run + span）",
      hasSpan(catC, "s_11") &&
        hasSpan(catC, "s_12") &&
        hasSpan(catS, "s_11") &&
        hasSpan(catS, "s_12") &&
        spanRowsOf(catC) === 2 &&
        spanRowsOf(catS) === 2,
      { cRows: spanRowsOf(catC), sRows: spanRowsOf(catS) },
    );
    // 双侧展开 ⇒ 各自 8 行全量（6 前缀 + 2 自有），前缀行照常带 选中 aria-label
    await H.ev(
      call,
      `(() => {
         for (const rid of ['u7c_c','u7c_s']) {
           const b = document.querySelector('[data-testid="compare-steps-' + rid + '"] button[aria-label="展开完整前缀"]');
           if (b) b.click();
         }
         return 'ok';
       })()`,
    );
    await H.sleep(700);
    const catC2 = await catalogOf(call, "u7c_c");
    const catS2 = await catalogOf(call, "u7c_s");
    check(
      "#57 展开后两侧各 8 行全量（6 前缀 + 2 自有），重复 id 不对齐不合并",
      spanRowsOf(catC2) === 8 && spanRowsOf(catS2) === 8,
      { cRows: spanRowsOf(catC2), sRows: spanRowsOf(catS2) },
    );
    // 复合定位只动本侧
    await H.ev(
      call,
      `(() => { const ul = document.querySelector('[data-testid="compare-steps-u7c_c"]');
         const b = ul.querySelector('button[aria-label="选中 s_11"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(500);
    st = await storeState(call);
    check(
      "#57 selectCompareStep 只动本侧：左选 s_11，右保持 null",
      st.compareStepSelection.left === "s_11" && st.compareStepSelection.right === null,
      st.compareStepSelection,
    );
    await H.ev(
      call,
      `(() => { const ul = document.querySelector('[data-testid="compare-steps-u7c_s"]');
         const b = ul.querySelector('button[aria-label="选中 s_11"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(500);
    st = await storeState(call);
    check(
      "#57 右侧同名 s_11 可独立选中（两侧互不干扰）",
      st.compareStepSelection.left === "s_11" && st.compareStepSelection.right === "s_11",
      st.compareStepSelection,
    );

    // ── #59/#60 指标表数字与缓存解释（g × c） ──
    // 回到 pair(g,c)（#57 把 pair 换成了 c×s；显式重开保证量的是这一对的表）
    detail = await setPair(call, "u7c_g", "u7c_c");
    check("#59 前置：pair(g,c) 详情对齐", detail !== null && detail.hasLeft === true);
    const m59 = await openMetrics(call);
    const rows59 = await metricsRows(call);
    const ownRow = rowOf(rows59, "自有 tokens（合计）");
    check(
      "#59 自有 tokens 合计：左列 = G 自有，右列 = C 自有（继承前缀不重复计入；表内数字为缩写格式）",
      ownRow !== null &&
        ownRow.cells[0] === EXP.fmtOwnG &&
        ownRow.cells[1] === EXP.fmtOwnC,
      { expected: [EXP.fmtOwnG, EXP.fmtOwnC], got: ownRow?.cells },
    );
    const chainRow = rowOf(rows59, "累计增量（tokens）");
    check(
      "#59 沿链累计：右列 = G+P+C 自有求和（沿链口径）",
      chainRow !== null && chainRow.cells[1] === EXP.fmtChainC,
      { expected: EXP.fmtChainC, got: chainRow?.cells },
    );
    const deltaRow = rowOf(rows59, "相对祖先增量（tokens）");
    check(
      "#59 相对祖先增量 = 侧累计 − 祖先累计（P+C；不是左右互差）",
      deltaRow !== null && deltaRow.cells[1] === EXP.fmtDeltaC,
      { expected: EXP.fmtDeltaC, got: deltaRow?.cells },
    );
    const cacheRow59 = rowOf(rows59, "缓存");
    check(
      "#60 缓存行：g 部分记录（800 · 1/2）与 c 未记录两解释可辨",
      cacheRow59 !== null &&
        cacheRow59.cells[0] === EXP.cacheG &&
        cacheRow59.cells[1] === EXP.cacheC,
      { expected: [EXP.cacheG, EXP.cacheC], got: cacheRow59?.cells },
    );

    // ── #60 零命中/部分记录另形态（l1 × l2） ──
    await H.storeQ(
      call,
      `s.clearCompare(); s.toggleCompare("u7c_l1"); s.toggleCompare("u7c_l2");
       await s.enterCompareSelection(["u7c_l1","u7c_l2"]); return JSON.stringify("ok");`,
    );
    await H.sleep(1200);
    const m60 = await openMetrics(call);
    const rows60 = await metricsRows(call);
    const cacheRow60 = rowOf(rows60, "缓存");
    check(
      "#60 零命中（l2 · 0 已记录 2/2）与部分记录另形态（l1 · 512 已记录 1/2）分开",
      cacheRow60 !== null &&
        cacheRow60.cells[0] === EXP.cacheL1 &&
        cacheRow60.cells[1] === EXP.cacheL2,
      { expected: [EXP.cacheL1, EXP.cacheL2], got: cacheRow60?.cells },
    );

    // ── #60 失败占位零 token（z1 × g） ──
    await H.storeQ(
      call,
      `s.clearCompare(); s.toggleCompare("u7f_z1"); s.toggleCompare("u7c_g");
       await s.enterCompareSelection(["u7f_z1","u7c_g"]); return JSON.stringify("ok");`,
    );
    await H.sleep(1200);
    const m60z = await openMetrics(call);
    const rows60z = await metricsRows(call);
    const cacheRowZ = rowOf(rows60z, "缓存");
    const ownRowZ = rowOf(rows60z, "自有 tokens（合计）");
    check(
      "#60 失败占位：z1 缓存未记录（命中量未知）≠ 实际零；tokens 合计 0 挂占位说明",
      cacheRowZ !== null &&
        cacheRowZ.cells[0] === EXP.cacheZ1 &&
        ownRowZ !== null &&
        ownRowZ.cells[0] === "0" &&
        (m60z.wsText || "").includes("占位"),
      {
        cache: cacheRowZ?.cells,
        own: ownRowZ?.cells,
        noteHit: (m60z?.wsText || "").includes("不据此断言实际零消费"),
      },
    );

    // ── #41 交换/更换不动侧栏选择（g × c 详细模式） ──
    detail = await setPair(call, "u7c_g", "u7c_c");
    // ⚠️ #60 两块用 enterCompareSelection 换集合时 comparePair 未变 ⇒ pairKey 不变 ⇒
    // 容器 tableMode 仍为 true；此处 pair(g,c) 又与 #59 相同 ⇒ 表模式不会自动退出。
    // 显式点「返回详细比较」（真实用户路径）。
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="返回详细比较"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(900);
    detail = await waitDetail(call);
    check("#41 前置：pair(g,c) 详情模式（已退出表模式）", detail !== null && detail.hasLeft === true);
    // 先给左列一个步骤选中（交换后应跑到右列）
    await H.ev(
      call,
      `(() => { const ul = document.querySelector('[data-testid="compare-steps-u7c_g"]');
         const b = ul.querySelector('button[aria-label="选中 s_02"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(500);
    const idsBefore = (await storeState(call)).compareIds;
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="交换左右"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1500);
    detail = await waitDetail(call);
    st = await storeState(call);
    check(
      "#41 交换左右：pair 反转 + 按新序重读（selection=[c,g]）",
      st.comparePair !== null &&
        st.comparePair.leftRunId === "u7c_c" &&
        st.comparePair.rightRunId === "u7c_g" &&
        st.readSel !== null &&
        JSON.stringify(st.readSel.selection) === JSON.stringify(["u7c_c", "u7c_g"]),
      { pair: st.comparePair, readSel: st.readSel },
    );
    check(
      "#41 交换不动全局集合（compareIds 逐项不变）",
      JSON.stringify(st.compareIds) === JSON.stringify(idsBefore),
      { before: idsBefore, after: st.compareIds },
    );
    check(
      "#41 交换互换了复合定位与折叠态（左右对调，选择不丢）",
      st.compareStepSelection.left === null && st.compareStepSelection.right === "s_02",
      st.compareStepSelection,
    );
    check("#41 交换后详情对齐（c 左 g 右）", detail !== null && detail.hasLeft === true);
    // 更换一侧 = 指标表两步挑选（显式换 pair，不动集合）
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="查看指标对照表"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1200);
    await H.ev(
      call,
      `(() => {
         const l = document.querySelector('[aria-label="设为左列 u7c_g"]');
         const r = document.querySelector('[aria-label="设为右列 u7c_c"]');
         if (l) l.click(); if (r) r.click();
         return JSON.stringify({ l: l !== null, r: r !== null });
       })()`,
    ).then(JSON.parse);
    await H.sleep(500);
    const pickOpen = await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="打开所选两条的详细比较"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1500);
    detail = await waitDetail(call);
    st = await storeState(call);
    check(
      "#41 更换（两步挑选）：pair 重开为 g→c，全局集合不动",
      st.comparePair !== null &&
        st.comparePair.leftRunId === "u7c_g" &&
        st.comparePair.rightRunId === "u7c_c" &&
        JSON.stringify(st.compareIds) === JSON.stringify(idsBefore) &&
        detail !== null &&
        detail.hasLeft === true,
      { pair: st.comparePair, ids: st.compareIds, pick: pickOpen },
    );

    // ── #43 返回恢复来源与单侧阅读（d1：显式 pair → 打开单侧 → 返回比较 → 返回来源） ──
    await H.storeQ(call, `await s.selectRun("u7c_d1"); return JSON.stringify("ok");`);
    await H.sleep(900);
    await H.storeQ(
      call,
      `s.clearCompare(); s.toggleCompare("u7c_d1"); s.toggleCompare("u7c_d2");
       await s.openComparePair("u7c_d1","u7c_d2"); return JSON.stringify("ok");`,
    );
    await H.sleep(700);
    await waitDetail(call);
    const loc0 = (await storeState(call)).compareReturnLocation;
    check(
      "#43 进入比较：来源位置捕获（trace 视图 + u7c_d1）",
      loc0 !== null && JSON.stringify(loc0).includes("u7c_d1"),
      loc0,
    );
    // 打开单侧（selectRun 离开比较）：pair 与来源引用都保留
    await H.storeQ(call, `await s.selectRun("u7c_g"); return JSON.stringify("ok");`);
    await H.sleep(900);
    st = await storeState(call);
    check(
      "#43 打开单侧不清凭据：view=trace，pair 与 compareReturnLocation 都在",
      st.view === "trace" &&
        st.comparePair !== null &&
        st.comparePair.leftRunId === "u7c_d1" &&
        st.compareReturnLocation !== null,
      { view: st.view, pair: st.comparePair, loc: st.compareReturnLocation },
    );
    // 页头「返回比较」→ 详情恢复
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="返回比较工作区"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1200);
    detail = await waitDetail(call);
    st = await storeState(call);
    check(
      "#43 返回比较：view=compare + pair 保持 + 详情对齐（不同根 pair）",
      st.view === "compare" && detail !== null && detail.hasLeft === true,
      { view: st.view, aligned: detail?.hasLeft },
    );
    // 「返回来源」→ 恢复视图与位置，凭据一次性用掉
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="返回来源"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1200);
    st = await storeState(call);
    check(
      "#43 返回来源：view=trace + 选中回到 u7c_d1 + 凭据已清（一次性）",
      st.view === "trace" &&
        st.selectedRunId === "u7c_d1" &&
        st.compareReturnLocation === null,
      { view: st.view, sel: st.selectedRunId, loc: st.compareReturnLocation },
    );
    await H.shot(call, SHOT_DIR, "return-source.png");
  },

  // -------------------------------------------------------------------------
  // tag：compare-overview（概览自有输出/消耗/来源 + 限制中止形态）
  // -------------------------------------------------------------------------
  async "compare-overview"(call) {
    await dprSentinel(call);
    const st0 = await storeState(call);
    check("标本已注入且应用可见（≥35 条）", st0.runsN >= 35, `runsN=${st0.runsN}`);

    // ── #28 正常结束直接看到最终输出（u7c_g） ──
    let ov = await overviewOf(call, "u7c_g");
    check(
      "#28 正常结束：运行结果区给最终输出（正文 + 已记录徽标）",
      ov !== null &&
        (ov.result || "").includes(String(EXP.finalG)) &&
        (ov.result || "").includes("已记录"),
      (ov?.result || "").slice(0, 120),
    );
    // 复制按钮的文案在 aria-label 不在 textContent ⇒ 按 aria-label 查
    const copyBtn28 = await H.ev(
      call,
      `(() => JSON.stringify({
         present: document.querySelector('[aria-label="运行概览"] button[aria-label="复制最终输出完整原文"]') !== null }))()`,
    ).then(JSON.parse);
    check(
      "#28 复制完整原文入口在场（复制最终输出完整原文）",
      copyBtn28.present === true,
      copyBtn28,
    );

    // ── #29 失败概览定位真实自有调用（u7c_err：401） ──
    ov = await overviewOf(call, "u7c_err");
    check(
      "#29 LLM 错误区：本次失败原因 + HTTP 401 + 错误正文",
      ov !== null &&
        (ov.llmError || "").includes("本次失败原因") &&
        (ov.llmError || "").includes("HTTP 401") &&
        (ov.llmError || "").includes("invalid api key"),
      (ov?.llmError || "").slice(0, 160),
    );
    check(
      "#29 可定位入口在场（打开该调用并展开所属 step）",
      (ov?.llmError || "").includes("打开该调用并展开所属 step"),
      null,
    );

    // ── #30 旧失败记录没有错误详情（u7f_e1：missing） ──
    ov = await overviewOf(call, "u7f_e1");
    check(
      "#30 legacy：missing 说明（不反推原因，也不借用祖先的错误）+ 无定位按钮",
      ov !== null &&
        (ov.llmError || "").includes("没有 LLM 错误详情") &&
        !(ov.llmError || "").includes("打开该调用并展开所属 step"),
      (ov?.llmError || "").slice(0, 160),
    );

    // ── #31 限制/中止/中断如实展示（u7r_*） ──
    ov = await overviewOf(call, "u7r_limit");
    check(
      "#31 max_iterations：琥珀徽标 + 不是正常结束说明",
      ov !== null &&
        (ov.outcome || "").includes("达到迭代上限") &&
        (ov.outcome || "").includes("循环达到迭代上限后停止，不是正常结束"),
      ov?.outcome,
    );
    ov = await overviewOf(call, "u7r_budget");
    check(
      "#31 budget_exceeded：各自的说明互不冒充",
      (ov?.outcome || "").includes("超出预算") &&
        (ov?.outcome || "").includes("token / 预算超出上限后停止，不是正常结束"),
      ov?.outcome,
    );
    ov = await overviewOf(call, "u7r_aborted");
    check(
      "#31 aborted：明说不是正常结束 + 已记录内容保留（受控响应在场）",
      (ov?.outcome || "").includes("已中止") &&
        (ov?.outcome || "").includes("运行被中止，不是正常结束；已记录内容保留在下方") &&
        (ov?.result || "").includes("受控响应"),
      { outcome: ov?.outcome, result: (ov?.result || "").slice(0, 100) },
    );
    ov = await overviewOf(call, "u7r_crashed");
    check(
      "#31 无终止事件：运行中断（不标为正常成功或仍在执行）",
      (ov?.outcome || "").includes("运行中断"),
      ov?.outcome,
    );

    // ── #32 无最终正文不借用祖先补全（u7f_r1，父 = u7c_g 有正文） ──
    ov = await overviewOf(call, "u7f_r1");
    check(
      "#32 祖先正文一个字都不出现（本地优先的调试器 不在概览）",
      ov !== null && !(ov.text || "").includes("本地优先的调试器"),
      null,
    );
    check(
      "#32 内容类型如实说明：只记录了思维链 + 无块无入口时如实说「没有可展示的输出」",
      (ov?.result || "").includes("只记录了思维链") &&
        (ov?.result || "").includes("没有可展示的输出，也没有可定位的调用"),
      (ov?.result || "").slice(0, 200),
    );
    check(
      "#32 completed 但无正文：未记录徽标（不冒充最终结果）",
      (ov?.result || "").includes("未记录"),
      null,
    );

    // ── #33 本次指标不累计共享前缀（u7c_c：自有 = s_12 的用量） ──
    ov = await overviewOf(call, "u7c_c");
    const cons = ov?.consumption || "";
    check(
      "#33 本次消耗只算自有段：tokens 数字 = C 自有（缩写格式；不含 G/P 的用量）",
      cons.includes(EXP.fmtInC) &&
        cons.includes(EXP.fmtOutC) &&
        !cons.includes(EXP.fmtInG) &&
        !cons.includes(EXP.fmtInP),
      {
        expected: [EXP.fmtInC, EXP.fmtOutC],
        forbidden: [EXP.fmtInG, EXP.fmtInP],
        slice: cons.slice(0, 200),
      },
    );
    check("#33 缓存覆盖块在场（只报已记录范围）", (ov?.text || "").includes("缓存命中"), null);

    // ── #34 来源和隔离边界保持真实（四类分叉标本） ──
    // prompt fork：独立执行，禁止说「共享前缀」
    ov = await overviewOf(call, "u7c_pc1");
    check(
      "#34 prompt fork：独立执行说明 + 不出现「共享前缀」字样",
      ov !== null &&
        (ov.source || "").includes("prompt fork（从头重跑）：本 run 是独立执行，不共享父轨迹前缀") &&
        !(ov.source || "").includes("共享前缀"),
      (ov?.source || "").slice(0, 180),
    );
    check("#34 prompt 臂父子入口在场（父左子右）", ov?.compareParentBtn === true, null);
    // proxy：单请求级编辑重发
    ov = await overviewOf(call, "run_u7m2");
    check(
      "#34 代理分叉：单请求级编辑重发说明（不复用共享前缀措辞）",
      (ov?.source || "").includes("代理录制的分叉运行（单请求级编辑重发）"),
      (ov?.source || "").slice(0, 160),
    );
    // 隔离续跑：origin.run_id + 轮末检查点
    ov = await overviewOf(call, "run_muo9892a_w2qj");
    check(
      "#34 隔离续跑：从 run_muo988yd_4btbgb 的轮末检查点出发（不是改了文件）",
      (ov?.source || "").includes("隔离续跑：从运行 run_muo988yd_4btbgb 的轮末检查点出发") &&
        (ov?.source || "").includes("文件读写只发生在独立世界里"),
      (ov?.source || "").slice(0, 200),
    );
    // 隔离根：隔离文件世界根运行
    ov = await overviewOf(call, "run_muo988yd_4btbgb");
    check(
      "#34 隔离根：根运行说明 + 隔离文件运行边界 + 无父子入口",
      (ov?.source || "").includes("隔离文件世界的根运行") &&
        (ov?.source || "").includes("隔离文件运行：文件读写只发生在独立世界里") &&
        ov?.compareParentBtn === false,
      (ov?.source || "").slice(0, 160),
    );
    await H.shot(call, SHOT_DIR, "overview-isolated.png");
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

  try {
    await FLOWS[TAG](call);
  } catch (e) {
    check(`tag 执行异常：${String(e?.message ?? e).slice(0, 300)}`, false);
  }
  finish();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
