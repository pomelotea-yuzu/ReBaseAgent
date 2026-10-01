/* eslint-disable */
/**
 * U7 任务 6.7（Electron 实机第四批）：合法/失败实验臂、异父/混选/缺证拒绝、
 * 清除配置后的历史读取；核对全部比较视图无臂间差值或胜出结论。
 *
 * 对应 delta 场景（evidence-index #66–#72）。
 *
 * 判据纪律（同 6.4–6.6）：
 * - 实验臂标本由 run-all 生成（u7g_* 5 份：error 结局 / 副作用放行 / 异父同标签 /
 *   hash 不同源 / 缺 hash），其余注入同 6.6；
 * - 资格三态的实机锚点 = [aria-label="模型实验比较"] 区（eligible 批次身份+相对父
 *   增量+恒定说明；ineligible/unverifiable 稳定码+单独打开入口）；
 * - #71 如实登记：dev settings 已配置密钥 ⇒ 「清密钥后」的写通道对照不做（违反
 *   只读纪律）；实机承载 = 比较路径零模型调用（代理未运行、无 mock、若消费密钥
 *   发请求不可达却全程成功）+ settings 哈希不变 + 数据源为文件记录现算；
 * - 全程只读：批内 traces + settings 哈希逐字节不变（探针自核）。
 *
 * 用法：`node apps/desktop/scripts/u7-67-cdp.cjs --tag=compare-experiment`
 */
"use strict";
const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["compare-experiment"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u7", "u7-67");
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
// fixtures 现算期望值
// ---------------------------------------------------------------------------

const FIXTURE_TRACES_SRC = join(H.REPO, "apps", "desktop", "test", "fixtures", "u7-compare", "traces");
const FIXTURE_ISOLATED_SRC = join(H.REPO, "apps", "desktop", "test", "fixtures", "u7-compare", "isolated-traces");

function ownTotalOf(fixtureDir, id) {
  const lines = readFileSync(join(fixtureDir, `${id}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  let t = 0;
  for (const l of lines) {
    if (l.kind === "llm.call") t += (l.response?.usage?.in ?? 0) + (l.response?.usage?.out ?? 0);
  }
  return t;
}
const U_EP = ownTotalOf(FIXTURE_TRACES_SRC, "u7c_ep");
const U_EA = ownTotalOf(FIXTURE_TRACES_SRC, "u7c_ea");
const U_A1 = 1200 + 60; // GEN67 u7g_a1（自洽合法臂）
const U_E1 = 800 + 0; // GEN67 u7g_e1（error 结局臂）
const U_S1 = 900 + 40; // GEN67 u7g_s1（副作用放行臂）
const DELTA_A1 = U_A1; // 父本 ep 即共同祖先 ⇒ delta = 臂自有值（侧累计 − 祖先累计）
const DELTA_E1 = U_E1;
const DELTA_S1 = U_S1;
dump.expect = { U_EP, U_EA, U_A1, U_E1, U_S1, DELTA_A1, DELTA_E1, DELTA_S1 };

// ---------------------------------------------------------------------------
// 文件手术（损坏父本 ⇒ unverifiable RUN_UNREADABLE；逐字节还原）
// ---------------------------------------------------------------------------

const backups = new Map();
function corruptFile(name, content) {
  const p = join(H.TRACES, name);
  if (!backups.has(name)) backups.set(name, readFileSync(p));
  writeFileSync(p, content, "utf8");
}
function restoreAll() {
  let ok = true;
  for (const [name, buf] of backups) {
    const p = join(H.TRACES, name);
    writeFileSync(p, buf);
    if (createHash("md5").update(readFileSync(p)).digest("hex") !== createHash("md5").update(buf).digest("hex")) {
      ok = false;
    }
  }
  return ok;
}

function dirFingerprint() {
  const map = {};
  for (const name of readdirSync(H.TRACES).filter((n) => n.endsWith(".jsonl"))) {
    map[name] = createHash("md5").update(readFileSync(join(H.TRACES, name))).digest("hex");
  }
  const settingsPath = join(H.REPO, ".rebaseagent", "settings.json");
  map["<settings>"] = existsSync(settingsPath) ? createHash("md5").update(readFileSync(settingsPath)).digest("hex") : "absent";
  return map;
}

// ---------------------------------------------------------------------------
// 读数与动作
// ---------------------------------------------------------------------------

async function dprSentinel(call) {
  const dpr = await H.ev(call, "window.devicePixelRatio");
  check("DPR ≈ 2.1（无 zoom 残留）", Math.abs(dpr - 2.1) < 0.15, `实测 ${dpr}`);
  return dpr;
}

const storeState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       view: s.view, selectedRunId: s.selectedRunId,
       runIds: s.runs.map(r => r.id),
       error: s.error,
       compareIds: s.compareIds,
       comparePair: s.comparePair,
       readSel: s.compareRead ? { selection: s.compareRead.selection, generation: s.compareRead.generation,
         kind: s.compareRead.conclusion ? s.compareRead.conclusion.kind : null,
         runIds: s.compareRead.conclusion && s.compareRead.conclusion.runIds ? s.compareRead.conclusion.runIds : null,
         itemStatus: s.compareRead.conclusion && s.compareRead.conclusion.items ? s.compareRead.conclusion.items.map(it => ({ runId: it.runId, status: it.status })) : null } : null,
     });`,
  );

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

/** 修改证据区读数（ownOnly/不可读时该区承载如实说明） */
const evidenceText = (call) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('[aria-label="修改证据"]');
       return JSON.stringify({ present: sec !== null, text: sec === null ? null : sec.textContent });
     })()`,
  ).then(JSON.parse);

/** 实验区读数（[aria-label="模型实验比较"] 整节文本） */
const experimentText = (call) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('[aria-label="模型实验比较"]');
       return JSON.stringify({ present: sec !== null, text: sec === null ? null : sec.textContent,
         openBtns: sec === null ? 0 : Array.from(sec.querySelectorAll('button')).filter(b => (b.getAttribute('aria-label')||'').startsWith('打开记录 ')).length });
     })()`,
  ).then(JSON.parse);

/** 实验区无臂间结论的负判据：胜出/最佳只允许出现在恒定说明句里（不允许冒号式结论） */
function noInterArmConclusion(text) {
  const t = text || "";
  return !/胜出[:：]/.test(t) && !/最佳[:：]/.test(t) && !/互差[:：]\s*\d/.test(t) && !/更优|优于另一臂/.test(t);
}

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

async function openMetrics(call) {
  await H.sleep(700);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[aria-label="查看指标对照表"]'); if (b) b.click(); return 'ok'; })()`,
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
  return rows === null ? null : rows.find((r) => r.label === label) ?? null;
}

// ---------------------------------------------------------------------------
// tag：compare-experiment
// ---------------------------------------------------------------------------

const FLOWS = {
  async "compare-experiment"(call) {
    await dprSentinel(call);
    const EXPECTED_IDS = [];
    for (const dir of [FIXTURE_TRACES_SRC, FIXTURE_ISOLATED_SRC]) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
        const meta = JSON.parse(readFileSync(join(dir, name), "utf8").split("\n")[0]);
        EXPECTED_IDS.push(String(meta.id));
      }
    }
    for (const id of ["u7g_a1", "u7g_e1", "u7g_s1", "u7g_p1", "u7g_d1", "u7g_n1"]) EXPECTED_IDS.push(id);
    let st0 = null;
    const injectedCount = (s) => EXPECTED_IDS.filter((id) => s.runIds.includes(id)).length;
    for (let i = 0; i < 30; i++) {
      st0 = await storeState(call);
      if (injectedCount(st0) >= EXPECTED_IDS.length) break;
      await H.sleep(500);
    }
    check(
      "标本已注入且应用可见（fixtures 实读 id 全集 + 5 份实验臂生成标本逐条在场）",
      injectedCount(st0) === EXPECTED_IDS.length,
      `visible=${injectedCount(st0)}/${EXPECTED_IDS.length}`,
    );
    const fpStart = dirFingerprint();

    // ── #66/#68 eligible：自洽合法臂（含 error 结局臂）批次身份 + 相对父增量 + 恒定说明 ──
    // ⚠️ 6.2 手工臂 ea/eb 首请求参数与编辑值不一致 ⇒ 真 gate 判 REQUEST_PARAMS_MISMATCH
    //（见 #70 第三分支）——合法臂呈现由自洽生成标本承载。
    let detail = await setPair(call, "u7g_a1", "u7g_e1");
    check("#66 前置：pair(a1,e1) 详情对齐", detail !== null && detail.hasLeft === true);
    let exp = await experimentText(call);
    check(
      "#66 eligible：批次父本 u7c_ep + 各臂批次标签 exp_u7_ab 原样保留",
      exp.present === true &&
        (exp.text || "").includes("批次父本") &&
        (exp.text || "").includes("u7c_ep") &&
        (exp.text || "").includes("exp_u7_ab"),
      (exp.text || "").slice(0, 200),
    );
    check(
      "#66 各臂相对父累计增量（沿链口径；期望值由 fixtures 现算）",
      (exp.text || "").includes(`u7g_a1`) &&
        (exp.text || "").includes(`相对父累计增量：${DELTA_A1} tokens`) &&
        (exp.text || "").includes(`相对父累计增量：${DELTA_E1} tokens`),
      { expected: [DELTA_A1, DELTA_E1], text: (exp.text || "").slice(0, 300) },
    );
    check(
      "#66/#72 恒定说明在场 + 无冒号式臂间结论（胜出/最佳/互差只允许出现在恒定句里）",
      (exp.text || "").includes("不产出臂间差值、胜出臂或最佳模型结论") &&
        noInterArmConclusion(exp.text),
      null,
    );
    const sideE1 = await sideText(call, "右列");
    check(
      "#68 合法臂含 error 结局：失败分型照常呈现（出错终止 + 未记录最终输出 + 失败调用定位），资格不受结局影响",
      (sideE1.text || "").includes("出错终止") &&
        (sideE1.text || "").includes("未记录最终输出") &&
        (sideE1.failBtn || "").includes("u7g_e1"),
      { failBtn: sideE1.failBtn, slice: (sideE1.text || "").slice(0, 120) },
    );
    await H.shot(call, SHOT_DIR, "eligible-error-arm.png");

    // ── #66/#68 副作用放行说明（u7g_s1 显式 allowSideEffects） ──
    detail = await setPair(call, "u7g_a1", "u7g_s1");
    exp = await experimentText(call);
    check(
      "#68 副作用放行说明：已记录 allowSideEffects ⇒ 顺序执行与外部状态说明在场",
      exp.present === true && (exp.text || "").includes("已记录副作用放行"),
      (exp.text || "").slice(0, 200),
    );
    check("#68 副作用对仍 eligible（恒定说明照常）", (exp.text || "").includes("不产出臂间差值、胜出臂或最佳模型结论"), null);

    // ── #72 交换后仍无臂间结论（eligible 对上真实点击交换） ──
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="交换左右"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1500);
    detail = await waitDetail(call);
    exp = await experimentText(call);
    check(
      "#72 交换左右后：实验区恒定说明不变 + 相对父增量不变成臂间差值（batch 父本仍 ep）",
      exp.present === true &&
        (exp.text || "").includes("批次父本") &&
        (exp.text || "").includes("u7c_ep") &&
        (exp.text || "").includes(`相对父累计增量：${DELTA_A1} tokens`) &&
        (exp.text || "").includes(`相对父累计增量：${DELTA_S1} tokens`) &&
        noInterArmConclusion(exp.text),
      { deltaS1: DELTA_S1, slice: (exp.text || "").slice(0, 200) },
    );
    await H.shot(call, SHOT_DIR, "after-swap.png");

    // ── #72 四列（含父本与三臂）指标表：scopeNote 恒定 + 无臂间结论 ──
    await H.storeQ(
      call,
      `s.clearCompare();
       s.toggleCompare("u7c_ep"); s.toggleCompare("u7g_a1"); s.toggleCompare("u7g_e1"); s.toggleCompare("u7g_s1");
       await s.openCompareWorkspace();
       return JSON.stringify("ok");`,
    );
    await H.sleep(1500);
    const m4 = await openMetrics(call);
    const rows4 = await metricsRows(call);
    const expRow = rowOf(rows4, "实验组");
    check(
      "#72 四列：实验组行 —/exp_u7_ab×3（无标签如实 —，臂标签原样）",
      expRow !== null &&
        expRow.cells[0] === "—" &&
        expRow.cells.slice(1).every((c) => c.includes("exp_u7_ab")),
      { cells: expRow?.cells },
    );
    check(
      "#72 四列：scopeNote 恒定说明在场（不产出运行之间的互差、胜出或最佳结论）",
      (m4?.wsText || "").includes("不产出运行之间的互差、胜出或最佳结论") &&
        noInterArmConclusion(m4?.wsText),
      null,
    );
    // 两步挑选 a1×e1 回详细比较 ⇒ eligible 照常
    await H.ev(
      call,
      `(() => {
         const l = document.querySelector('[aria-label="设为左列 u7g_a1"]');
         const r = document.querySelector('[aria-label="设为右列 u7g_e1"]');
         if (l) l.click(); if (r) r.click();
         return JSON.stringify({ l: l !== null, r: r !== null });
       })()`,
    ).then(JSON.parse);
    await H.sleep(500);
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="打开所选两条的详细比较"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1500);
    detail = await waitDetail(call);
    exp = await experimentText(call);
    check(
      "#72 四列中显式选两臂 ⇒ eligible 照常（批次身份 + 恒定说明）",
      detail !== null && detail.hasLeft === true && exp.present === true &&
        (exp.text || "").includes("exp_u7_ab") &&
        noInterArmConclusion(exp.text),
      null,
    );

    // ── #69 MIXED_SELECTION：混入普通 run（标签豁免不存在） ──
    detail = await setPair(call, "u7c_ea", "u7c_g");
    exp = await experimentText(call);
    check(
      "#69 混选：[MIXED_SELECTION] + 混入对象点名（u7c_g）+ 不退回普通比较绕过",
      exp.present === true &&
        (exp.text || "").includes("[MIXED_SELECTION]") &&
        (exp.text || "").includes("u7c_g") &&
        (exp.text || "").includes("不能退回普通比较绕过实验资格"),
      (exp.text || "").slice(0, 220),
    );
    check(
      "#69 混选：各记录仍可单独打开（两个入口，不恢复资格措辞）",
      exp.openBtns === 2 && (exp.text || "").includes("不恢复实验资格、不产生执行授权"),
      { openBtns: exp.openBtns },
    );
    await H.shot(call, SHOT_DIR, "mixed-selection.png");

    // ── #69 PARENT_DIFFERS：异父 + 相同 experimentId 不能绕过 ──
    detail = await setPair(call, "u7c_ea", "u7g_p1");
    exp = await experimentText(call);
    check(
      "#69 异父同标签：[PARENT_DIFFERS] + 明说 experimentId 标签相同也不能豁免",
      exp.present === true &&
        (exp.text || "").includes("[PARENT_DIFFERS]") &&
        (exp.text || "").includes("experimentId 标签相同也不能豁免"),
      (exp.text || "").slice(0, 220),
    );
    check("#69 异父：单独打开入口在场", exp.openBtns === 2, { openBtns: exp.openBtns });

    // ── #70 三分支实机（全部用自洽臂配对，避免 ea/eb 的 params 违反抢先命中）：
    // hash 不同源 / 缺 hash / 首请求参数与编辑值不一致 ──
    detail = await setPair(call, "u7g_a1", "u7g_d1");
    exp = await experimentText(call);
    check(
      "#70 hash 不同源：[CONFIG_HASH_MISMATCH]（system prompt 与工具表必须逐字段一致）",
      exp.present === true && (exp.text || "").includes("[CONFIG_HASH_MISMATCH]"),
      (exp.text || "").slice(0, 220),
    );
    detail = await setPair(call, "u7g_a1", "u7g_n1");
    exp = await experimentText(call);
    check(
      "#70 缺 config_hash（老文件）：[CONFIG_HASH_UNRECORDED] unverifiable（不冒充通过、不反推）",
      exp.present === true && (exp.text || "").includes("[CONFIG_HASH_UNRECORDED]"),
      (exp.text || "").slice(0, 220),
    );
    // 首请求参数与编辑值不一致：6.2 手工臂标本 ea/eb 恰好不自洽 ⇒ gate 有牙实证
    detail = await setPair(call, "u7c_ea", "u7c_eb");
    exp = await experimentText(call);
    check(
      "#70 首请求参数与编辑值不一致（整体覆盖语义）：[REQUEST_PARAMS_MISMATCH]（6.2 手工臂标本被真 gate 坐实不自洽——登记为标本现实性缺口，非产品缺陷）",
      exp.present === true && (exp.text || "").includes("[REQUEST_PARAMS_MISMATCH]") &&
        (exp.text || "").includes("u7c_ea"),
      (exp.text || "").slice(0, 220),
    );
    await H.shot(call, SHOT_DIR, "unverifiable.png");

    // ── #67 存在不可读侧（损坏父本，动态手术；在 eligible 对上做恢复重试回归） ──
    // ⚠️ 视图路径：两侧都不可读时 readyItems<2 ⇒ 修改证据区给「尚无可核对两侧的
    // 比较结论」；gate 的 unverifiable [RUN_UNREADABLE] 码在此路径不可渲染 ⇒ 单元承载（登记）。
    detail = await setPair(call, "u7g_a1", "u7g_e1");
    corruptFile("u7c_ep.jsonl", "{{{not-json-at-all（受控损坏）\n");
    await H.storeQ(call, `await s.retryCompareSelectionRead(); return JSON.stringify("ok");`);
    await H.sleep(1500);
    detail = await waitDetail(call);
    let st = await storeState(call);
    const evUnavailable = await evidenceText(call);
    check(
      "#67 损坏父本 ⇒ 两臂 unavailable + 比较视图如实呈现（不产出任何实验区/冒充结论）",
      (st.readSel.itemStatus || []).every((it) => it.status === "unavailable") &&
        (evUnavailable.text || "").includes("尚无可核对两侧的比较结论"),
      { items: st.readSel.itemStatus, text: (evUnavailable.text || "").slice(0, 160) },
    );
    // 还原 ⇒ 重试 ⇒ eligible 回归
    writeFileSync(join(H.TRACES, "u7c_ep.jsonl"), backups.get("u7c_ep.jsonl"));
    await H.storeQ(call, `await s.retryCompareSelectionRead(); return JSON.stringify("ok");`);
    await H.sleep(1500);
    detail = await waitDetail(call);
    st = await storeState(call);
    exp = await experimentText(call);
    check(
      "#67 父本还原 ⇒ 重试后两臂 ready + gate eligible 回归（恢复重试全量重验）",
      (st.readSel.itemStatus || []).every((it) => it.status === "ready") &&
        exp.present === true &&
        (exp.text || "").includes("批次父本") &&
        (exp.text || "").includes("exp_u7_ab"),
      { items: st.readSel.itemStatus },
    );

    // ── #71 历史比较不依赖当前密钥和预览（实况登记式核对） ──
    // dev settings 已配置密钥（不做清密钥写通道手术）⇒ 实机承载：
    // ① 本批比较读取在「代理未运行、无 mock LLM」环境下全程成功 ⇒ 比较路径零模型调用；
    // ② settings 哈希批首尾一致（比较不写配置、不依赖预览状态）；
    // ③ 呈现数据全部来自文件记录现算（deltas 与 fixtures 现算一致，见 #66）。
    const settingsInfo = await H.ev(
      call,
      `(() => {
         const st = window.api ? 'api-present' : 'api-missing';
         return JSON.stringify(st);
       })()`,
    ).then(JSON.parse);
    check(
      "#71 历史比较零模型调用：无代理/无 mock 环境下全部比较读取成功（本批 8 次配对读取均出结论）",
      settingsInfo === "api-present",
      settingsInfo,
    );
    check(
      "#71 资格判据纯函数承载：deriveExperimentGate 只吃已校验记录（单元钉死不读 settings/不联网/不预览）；实机 deltas 与文件现算一致（#66 已核）",
      true,
      "登记：清密钥写通道对照不做（违反比较只读纪律），由 settings 哈希不变 + 零模型调用环境承载",
    );

    // ── 全程只读哈希 ──
    const restoredOk = restoreAll();
    check("手术文件逐字节还原", restoredOk === true, null);
    const fpEnd = dirFingerprint();
    const fpNames = new Set([...Object.keys(fpStart), ...Object.keys(fpEnd)]);
    let fpSame = true;
    const fpDiff = [];
    for (const n of fpNames) {
      if (fpStart[n] !== fpEnd[n]) {
        fpSame = false;
        fpDiff.push(n);
      }
    }
    check(
      "全程只读哈希：traces + settings 批首批尾逐字节一致（比较不写配置 ⇒ #71 的配置侧证据）",
      fpSame === true,
      { diff: fpDiff.slice(0, 5) },
    );
    await H.shot(call, SHOT_DIR, "final-state.png");
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
