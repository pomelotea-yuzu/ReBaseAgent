/* eslint-disable */
/**
 * U7 任务 6.6（Electron 实机第三批）：列表读后藏祖先、恢复重试、当前或祖先非法、
 * 快速换边与离开；同时核对概览 ownOnly 可读及非法详情报错，验证错误分栏、
 * 旧响应不覆盖及全程只读计数/哈希。
 *
 * 对应 delta 场景（evidence-index #13、#35、#36、#45、#46、#47、#48、#49、#58）。
 *
 * 判据纪律（同 6.4/6.5）：
 * - 标本由 run-all 在起 dev 前注入（u7-compare 22 + isolated 3 + blobs 3）；
 *   本批的核心手法是**动态文件手术**：探针在 dev 运行中对注入副本做
 *   删除/损坏/未来版本/成环注入，逐次字节级还原（md5 核验）；
 * - 竞速不可确定复现 ⇒ #48 实机核对「快速换边+离场后最终状态不变式」，
 *   确定性竞速由单元 + 6.3 反证（M1 迟到响应）承载，如实登记；
 * - 全程只读：批内 traces + settings 哈希逐字节不变（探针自核）。
 *
 * 用法：`node apps/desktop/scripts/u7-66-cdp.cjs --tag=compare-resilience`
 * 前置：dev 已由 run-all 起（CDP 9612），完整标本集已注入。
 */
"use strict";
const {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
} = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["compare-resilience"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u7", "u7-66");
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
// 文件手术工具（全部逐字节还原 + md5 自核）
// ---------------------------------------------------------------------------

const md5 = (buf) => createHash("md5").update(buf).digest("hex");
const fileMd5 = (p) => md5(readFileSync(p));

/** 删除前备份；restore 用内存副本写回并核对 md5 */
const backups = new Map();
function removeFile(name) {
  const p = join(H.TRACES, name);
  if (!backups.has(name)) backups.set(name, readFileSync(p));
  rmSync(p, { force: true });
}
function corruptFile(name, content) {
  const p = join(H.TRACES, name);
  if (!backups.has(name)) backups.set(name, readFileSync(p));
  writeFileSync(p, content, "utf8");
}
/** 还原全部手术文件；返回是否逐字节一致 */
function restoreAll() {
  let ok = true;
  for (const [name, buf] of backups) {
    const p = join(H.TRACES, name);
    writeFileSync(p, buf);
    if (fileMd5(p) !== md5(buf)) ok = false;
  }
  for (const name of PROBE_CREATED) {
    rmSync(join(H.TRACES, name), { force: true });
  }
  return ok;
}
const PROBE_CREATED = [];

/** 目录指纹（traces + settings，批首批尾各一次 ⇒ 全程只读哈希判据） */
function dirFingerprint() {
  const map = {};
  for (const name of readdirSync(H.TRACES).filter((n) => n.endsWith(".jsonl"))) {
    map[name] = fileMd5(join(H.TRACES, name));
  }
  const settingsPath = join(H.REPO, ".rebaseagent", "settings.json");
  map["<settings>"] = existsSync(settingsPath) ? fileMd5(settingsPath) : "absent";
  return map;
}

const FIXTURE_TRACES_SRC = join(
  H.REPO,
  "apps",
  "desktop",
  "test",
  "fixtures",
  "u7-compare",
  "traces",
);
const FIXTURE_ISOLATED_SRC = join(
  H.REPO,
  "apps",
  "desktop",
  "test",
  "fixtures",
  "u7-compare",
  "isolated-traces",
);

// d1/d2 的最终输出正文（概览部分载荷断言用：损坏后概览不得出现它；任务正文在页头不在概览区）
const D1_FINAL = (() => {
  const lines = readFileSync(
    join(H.REPO, "apps", "desktop", "test", "fixtures", "u7-compare", "traces", "u7c_d1.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const llm = lines.filter((l) => l.kind === "llm.call");
  return String(llm[llm.length - 1]?.response?.content ?? "");
})();
const D2_FINAL = (() => {
  const lines = readFileSync(
    join(H.REPO, "apps", "desktop", "test", "fixtures", "u7-compare", "traces", "u7c_d2.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const llm = lines.filter((l) => l.kind === "llm.call");
  return String(llm[llm.length - 1]?.response?.content ?? "");
})();
dump.d1Final = D1_FINAL;
dump.d2Final = D2_FINAL;

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
       failedN: s.failed ? s.failed.length : -1,
       error: s.error,
       loadingDetail: s.loadingDetail,
       compareIds: s.compareIds,
       comparePair: s.comparePair,
       readSel: s.compareRead ? { selection: s.compareRead.selection, generation: s.compareRead.generation,
         kind: s.compareRead.conclusion ? s.compareRead.conclusion.kind : null,
         runIds: s.compareRead.conclusion && s.compareRead.conclusion.runIds ? s.compareRead.conclusion.runIds : null,
         itemStatus: s.compareRead.conclusion && s.compareRead.conclusion.items ? s.compareRead.conclusion.items.map(it => ({ runId: it.runId, status: it.status })) : null } : null,
     });`,
  );

/** 等详细比较模式对齐（左列输出在场且 loading 文案消失） */
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
    if (p?.hasLeft && !p.loading) return p;
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

const evidenceText = (call) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('[aria-label="修改证据"]');
       return JSON.stringify({ present: sec !== null, text: sec === null ? null : sec.textContent });
     })()`,
  ).then(JSON.parse);

/** 步骤目录读数（labels 单列——span id 只在 aria-label） */
const catalogOf = (call, runId) =>
  H.ev(
    call,
    `(() => {
       const ul = document.querySelector('[data-testid="compare-steps-' + ${JSON.stringify(runId)} + '"]');
       if (ul === null) return JSON.stringify(null);
       const sec = ul.closest('section');
       const btn = ul.querySelector('button[aria-label="展开完整前缀"]');
       const labels = Array.from(ul.querySelectorAll('button')).map(b => b.getAttribute('aria-label'));
       return JSON.stringify({
         liCount: ul.children.length,
         text: sec === null ? ul.textContent : sec.textContent,
         prefixSummary: btn === null ? null : btn.textContent,
         hasFoldBtn: btn !== null,
         labels,
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
    if (p?.hasTable) return p;
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
  return rows === null ? null : (rows.find((r) => r.label === label) ?? null);
}

/** 概览读数（选中 run 后等 [aria-label="运行概览"]） */
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
           text: ov.textContent, outcome: sec('运行结局'), result: sec('运行结果'),
           llmError: sec('LLM 错误'), consumption: sec('本次消耗'), source: sec('来源'),
         });
       })()`,
    ).then(JSON.parse);
    if (p !== null) return p;
    if (Date.now() > deadline) return null;
    await H.sleep(400);
  }
}

// ---------------------------------------------------------------------------
// tag：compare-resilience
// ---------------------------------------------------------------------------

const FLOWS = {
  async "compare-resilience"(call) {
    await dprSentinel(call);
    // 期望注入 id 全集：从 fixtures 实读（含短 ID 碰撞组等不带统一前缀的 id）
    const EXPECTED_IDS = [];
    for (const dir of [FIXTURE_TRACES_SRC, FIXTURE_ISOLATED_SRC]) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
        const meta = JSON.parse(readFileSync(join(dir, name), "utf8").split("\n")[0]);
        EXPECTED_IDS.push(String(meta.id));
      }
    }
    dump.expectedInjectedN = EXPECTED_IDS.length;
    // 等列表把注入标本全部载入（440 份生产 + 25 份注入 ⇒ 首次读数可能仍在加载）
    let st0 = null;
    const injectedCount = (s) => EXPECTED_IDS.filter((id) => s.runIds.includes(id)).length;
    for (let i = 0; i < 30; i++) {
      st0 = await storeState(call);
      if (injectedCount(st0) >= EXPECTED_IDS.length) break;
      await H.sleep(500);
    }
    check(
      "标本已注入且应用可见（fixtures 实读 id 全集逐条在场）",
      injectedCount(st0) === EXPECTED_IDS.length,
      `visible=${injectedCount(st0)}/${EXPECTED_IDS.length} runsN=${st0.runIds.length}`,
    );
    const fpStart = dirFingerprint();
    dump.fpStartCount = Object.keys(fpStart).length;

    // ── #36 缺祖先概览沿用已校验自有事实（u7c_orphan：零注入 ownOnly） ──
    const ovOrphan = await overviewOf(call, "u7c_orphan");
    check(
      "#36 ownOnly 概览：来源区固定提示 + 缺失祖先 ID 可认（u7c_gone_missing）",
      ovOrphan !== null &&
        (ovOrphan.source || "").includes("父链不完整") &&
        (ovOrphan.source || "").includes("u7c_gone_missing"),
      (ovOrphan?.source || "").slice(0, 200),
    );
    check(
      "#36 自有结局可读：正常结束（不因祖先缺失变 unknown）",
      (ovOrphan?.outcome || "").includes("已结束"),
      ovOrphan?.outcome,
    );
    check(
      "#36 自有输出可读（ownOnly 侧完成。）+ 消耗口径说明在场（未知不补零）",
      (ovOrphan?.result || "").includes("ownOnly 侧完成。") &&
        (ovOrphan?.consumption || "").includes("未知"),
      {
        result: (ovOrphan?.result || "").slice(0, 80),
        cons: (ovOrphan?.consumption || "").slice(0, 160),
      },
    );
    await H.shot(call, SHOT_DIR, "overview-ownonly.png");

    // ── #46/#13/#58 前置：pair(p,c) 完整基线（verified + 直接父子证据） ──
    let detail = await setPair(call, "u7c_p", "u7c_c");
    check("#46 前置：pair(p,c) 完整读取对齐", detail !== null && detail.hasLeft === true);
    let st = await storeState(call);
    check("#46 前置：结论 verified（两侧 ready）", st.readSel.kind === "verified", st.readSel);
    let ev = await evidenceText(call);
    check("#46 前置：直接父子证据在场（s_08）", (ev.text || "").includes("s_08"), null);

    // ── 藏祖先：删 u7c_g.jsonl ⇒ 列表仍完整呈现 p/c，比较读取走结构化 ownOnly ──
    removeFile("u7c_g.jsonl");
    await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("ok");`);
    await H.sleep(1200);
    st = await storeState(call);
    check(
      "#46 列表完整但比较读取缺祖先：列表仍有 p/c、g 消失（不拖垮列表）",
      st.runIds.includes("u7c_p") && st.runIds.includes("u7c_c") && !st.runIds.includes("u7c_g"),
      {
        runsN: st.runIds.length,
        hasP: st.runIds.includes("u7c_p"),
        hasC: st.runIds.includes("u7c_c"),
      },
    );
    await H.storeQ(call, `await s.retryCompareSelectionRead(); return JSON.stringify("ok");`);
    await H.sleep(1500);
    detail = await waitDetail(call);
    st = await storeState(call);
    check(
      "#46 缺祖先读取：两侧仍是 ready（结构化 ownOnly，非整单拒绝）",
      st.readSel.kind === "verified" &&
        (st.readSel.itemStatus || []).every((it) => it.status === "ready"),
      st.readSel,
    );
    check("#46 缺祖先详情对齐（不白屏不崩）", detail !== null && detail.hasLeft === true, null);
    // #13/#58：判定不完整呈现
    ev = await evidenceText(call);
    check(
      "#13 判定不完整：修改证据区「共同祖先判定不完整（存在父缺失）」+ 祖先差不计算",
      (ev.text || "").includes("共同祖先判定不完整（存在父缺失）"),
      (ev.text || "").slice(0, 160),
    );
    const catP = await catalogOf(call, "u7c_p");
    const catC = await catalogOf(call, "u7c_c");
    check(
      "#58 ownOnly 侧目录：琥珀「祖先缺失：仅显示已校验自有步骤」+ 仅自有行（p 自有 = s_06–s_10 共 5 行）+ 无折叠按钮（不推断根）",
      catP !== null &&
        (catP.text || "").includes("祖先缺失：仅显示已校验自有步骤，前缀未知") &&
        catP.liCount === 5 &&
        catP.hasFoldBtn === false,
      { liCount: catP?.liCount, hasFoldBtn: catP?.hasFoldBtn },
    );
    check(
      "#58 另一侧（c）此时同样截断：同样 ownOnly 提示（两侧互不冒充完整）",
      catC !== null &&
        (catC.text || "").includes("祖先缺失：仅显示已校验自有步骤，前缀未知") &&
        catC.liCount === 2,
      { liCount: catC?.liCount },
    );
    const m46 = await openMetrics(call);
    check(
      "#13 指标表：判定不完整（说明不是本来就不同根）+ 祖先增量不计算",
      (m46?.wsText || "").includes("判定不完整") && !(m46?.wsText || "").includes("分属不同根"),
      (m46?.wsText || "").match(/[^。]{0,60}判定不完整[^。]{0,60}/)?.[0] ?? null,
    );
    // 回详细比较（供后续恢复重试在同一会话里看结论翻转）
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="返回详细比较"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(900);
    await waitDetail(call);

    // ── #49 恢复祖先 ⇒ 重试 ⇒ 整组重验回 verified ──
    writeFileSync(join(H.TRACES, "u7c_g.jsonl"), backups.get("u7c_g.jsonl"));
    const gRestored = fileMd5(join(H.TRACES, "u7c_g.jsonl")) === md5(backups.get("u7c_g.jsonl"));
    check("#49 前置：祖先文件逐字节还原", gRestored === true);
    await H.storeQ(call, `await s.retryCompareSelectionRead(); return JSON.stringify("ok");`);
    await H.sleep(1500);
    detail = await waitDetail(call);
    st = await storeState(call);
    check(
      "#49 恢复重试：结论回 verified（旧 ownOnly 结论被整组重验替换，不残留）",
      st.readSel.kind === "verified" &&
        (st.readSel.itemStatus || []).every((it) => it.status === "ready"),
      st.readSel,
    );
    ev = await evidenceText(call);
    check(
      "#49 恢复重试：证据回直接父子（s_08 在场，不残留「判定不完整」）",
      (ev.text || "").includes("s_08") && !(ev.text || "").includes("共同祖先判定不完整"),
      (ev.text || "").slice(0, 120),
    );
    const catC49 = await catalogOf(call, "u7c_c");
    check(
      "#49 恢复重试：c 侧目录回完整（折叠摘要 6 条前缀回到场，ownOnly 提示退场）",
      catC49 !== null &&
        (catC49.prefixSummary || "").includes("共享前缀：6 条来自 u7c_g、u7c_p") &&
        !(catC49.text || "").includes("祖先缺失：仅显示已校验自有步骤"),
      { summary: catC49?.prefixSummary },
    );

    // ── #58/#13 ownOnly 侧与完整另一侧互不影响（pair(orphan, c)，g 已恢复） ──
    detail = await setPair(call, "u7c_orphan", "u7c_c");
    check("#58 前置：pair(orphan,c) 详情对齐", detail !== null && detail.hasLeft === true);
    const catOrphan = await catalogOf(call, "u7c_orphan");
    const catFull = await catalogOf(call, "u7c_c");
    check(
      "#58 ownOnly 侧：琥珀提示 + 仅自有 2 行 + 无折叠按钮；完整侧照常带前缀目录（6 条摘要）",
      catOrphan !== null &&
        (catOrphan.text || "").includes("祖先缺失：仅显示已校验自有步骤，前缀未知") &&
        catOrphan.liCount === 2 &&
        catOrphan.hasFoldBtn === false &&
        catFull !== null &&
        (catFull.prefixSummary || "").includes("共享前缀：6 条"),
      {
        orphan: { liCount: catOrphan?.liCount, fold: catOrphan?.hasFoldBtn },
        full: { summary: catFull?.prefixSummary },
      },
    );
    ev = await evidenceText(call);
    check(
      "#13 父缺失对完整侧：判定不完整（不冒充不同根、不冒充共同祖先）",
      (ev.text || "").includes("共同祖先判定不完整（存在父缺失）"),
      (ev.text || "").slice(0, 140),
    );
    const m13 = await openMetrics(call);
    const rows13 = await metricsRows(call);
    const chain13 = rowOf(rows13, "累计增量（tokens）");
    check(
      "#13 完整侧累计照常可读（c 列数字），ownOnly 侧保持未知（不补零）",
      (m13?.wsText || "").includes("判定不完整") &&
        chain13 !== null &&
        /\d/.test(chain13.cells[1] ?? "") &&
        (chain13.cells[0] === "—" || chain13.cells[0] === "" || chain13.cells[0].includes("—")),
      {
        cells: chain13?.cells,
        note: (m13?.wsText || "").match(/[^。]{0,40}判定不完整[^。]{0,40}/)?.[0],
      },
    );
    await H.shot(call, SHOT_DIR, "ownonly-vs-complete.png");

    // ── #47 一侧不可读保留另一侧（损坏 d1 当前文件） ──
    corruptFile("u7c_d1.jsonl", "{{{not-json-at-all（受控损坏）\n");
    await H.storeQ(
      call,
      `s.clearCompare(); s.toggleCompare("u7c_d1"); s.toggleCompare("u7c_d2");
       await s.openCompareWorkspace(); return JSON.stringify("ok");`,
    );
    await H.sleep(1500);
    detail = await waitDetail(call);
    st = await storeState(call);
    check(
      "#47 损坏侧 unavailable + 合法侧 ready（结论仍 verified，单侧失败不拖垮）",
      st.readSel.kind === "verified" &&
        (st.readSel.itemStatus || []).some(
          (it) => it.runId === "u7c_d1" && it.status === "unavailable",
        ) &&
        (st.readSel.itemStatus || []).some((it) => it.runId === "u7c_d2" && it.status === "ready"),
      st.readSel,
    );
    const leftBad = await H.ev(
      call,
      `(() => {
         const sec = document.querySelector('[aria-label="左列输出"]');
         return JSON.stringify({ present: sec !== null, text: sec === null ? null : sec.textContent.slice(0, 200) });
       })()`,
    ).then(JSON.parse);
    check(
      "#47 不可读侧错误分栏：该侧不可读 + 受控原因（不伪正文）",
      leftBad.present === true && (leftBad.text || "").includes("该侧不可读"),
      leftBad.text,
    );
    const m47 = await openMetrics(call);
    const rows47 = await metricsRows(call);
    const own47 = rowOf(rows47, "自有 tokens（合计）");
    check(
      "#47 指标表不可读列：行值显示 —（不借列表补齐、不补 0），合法列数字照常",
      own47 !== null &&
        (own47.cells[0] === "—" || (own47.cells[0] || "").includes("—")) &&
        /\d/.test(own47.cells[1] ?? ""),
      { cells: own47?.cells },
    );
    check(
      "#47 指标表不可读说明在场（受控原因，不借列表缓存补齐）",
      (m47?.wsText || "").includes("不可读"),
      (m47?.wsText || "").match(/[^。]{0,50}不可读[^。]{0,50}/)?.[0] ?? null,
    );
    // 还原 d1 ⇒ 重试 ⇒ 两侧 ready
    writeFileSync(join(H.TRACES, "u7c_d1.jsonl"), backups.get("u7c_d1.jsonl"));
    await H.storeQ(call, `await s.retryCompareSelectionRead(); return JSON.stringify("ok");`);
    await H.sleep(1500);
    st = await storeState(call);
    check(
      "#47 还原后重试：两侧 ready（合法侧完整返回）",
      st.readSel.kind === "verified" &&
        (st.readSel.itemStatus || []).every((it) => it.status === "ready"),
      st.readSel,
    );

    // ── #35 非法详情不被概览绕过（损坏 JSON / 未来版本 / 成环） ──
    // 先让 d2 概览在场（对照基准；概览区断言用最终输出正文，任务正文在页头）
    const ovD2 = await overviewOf(call, "u7c_d2");
    check("#35 前置：d2 概览正常（含其最终输出正文）", (ovD2?.text || "").includes(D2_FINAL), null);
    // 损坏 JSON：selectRun(d1) 严格失败，error 原位可重试
    corruptFile("u7c_d1.jsonl", "{{{not-json-at-all（受控损坏）\n");
    await H.storeQ(call, `await s.selectRun("u7c_d1"); return JSON.stringify("ok");`);
    await H.sleep(1200);
    st = await storeState(call);
    check(
      "#35 损坏 JSON：读取严格失败（store.error 在场，非 ownOnly 降级）",
      st.error !== null && st.error.length > 0,
      String(st.error).slice(0, 160),
    );
    const ovAfterCorrupt = await H.ev(
      call,
      `(() => {
         const ov = document.querySelector('[aria-label="运行概览"]');
         return JSON.stringify({ present: ov !== null, text: ov === null ? null : ov.textContent });
       })()`,
    ).then(JSON.parse);
    check(
      "#35 损坏 JSON：概览不产出该 run 的任何载荷（d1 最终输出正文一个字都不出现）",
      (ovAfterCorrupt.text || "").includes(D1_FINAL) === false,
      { hasOverview: ovAfterCorrupt.present },
    );
    // 未来版本：读取层拒绝，同样不降级
    const d1Lines = backups.get("u7c_d1.jsonl").toString("utf8").trim().split("\n");
    const d1Future = d1Lines.map((l) => {
      const o = JSON.parse(l);
      if (o.type === "run.meta") o.format_version = 99;
      return JSON.stringify(o);
    });
    corruptFile("u7c_d1.jsonl", `${d1Future.join("\n")}\n`);
    await H.storeQ(call, `await s.selectRun("u7c_d2"); return JSON.stringify("ok");`);
    await H.sleep(800);
    await H.storeQ(call, `await s.selectRun("u7c_d1"); return JSON.stringify("ok");`);
    await H.sleep(1200);
    st = await storeState(call);
    check(
      "#35 未来版本：读取层拒绝（error 在场，不降级 ownOnly）",
      st.error !== null && st.error.length > 0,
      String(st.error).slice(0, 160),
    );
    // 成环（LINEAGE_CYCLE）不在本批实机范围：批次列明实机只覆盖 ancestorCorrupt/未来版本
    // 注入；成环需要伪造互指父本的文件对，读取路径行为由 u7-overview-ancestor-cases 单元承载。
    // 还原 d1 ⇒ 概览恢复可读
    writeFileSync(join(H.TRACES, "u7c_d1.jsonl"), backups.get("u7c_d1.jsonl"));
    for (const name of PROBE_CREATED) rmSync(join(H.TRACES, name), { force: true });
    await H.storeQ(call, `await s.selectRun("u7c_d2"); return JSON.stringify("ok");`);
    await H.sleep(800);
    const ovRecovered = await overviewOf(call, "u7c_d1");
    check(
      "#35 还原后概览恢复：d1 最终输出正文回到场（错误态可恢复）",
      ovRecovered !== null && (ovRecovered.text || "").includes(D1_FINAL),
      null,
    );
    await H.shot(call, SHOT_DIR, "overview-recovered.png");

    // ── #45 非法身份拒绝（两层分层，实测口径） ──
    // renderer 侧 schema 只查形状（重复/超限/空 id）⇒ invalid 且连 state 都不动；
    // 目录穿越的语义拒绝在 main 端点 ⇒ 请求发出但整体拒绝 ⇒ 结论 rejected（请求级拒绝呈现）。
    await H.storeQ(call, `s.setView("trace"); return JSON.stringify("ok");`);
    await H.sleep(600);
    const stBefore45 = await storeState(call);
    const rDup = await H.storeQ(
      call,
      `return JSON.stringify(await s.enterCompareSelection(["u7c_g","u7c_g"]));`,
    );
    const stAfterDup = await storeState(call);
    check(
      "#45 重复 id（形状非法）：renderer 同源校验 ⇒ invalid，代次与选择集逐字不变",
      rDup === "invalid" &&
        stAfterDup.readSel.generation === stBefore45.readSel.generation &&
        JSON.stringify(stAfterDup.readSel.selection) ===
          JSON.stringify(stBefore45.readSel.selection),
      { rDup, before: stBefore45.readSel, after: stAfterDup.readSel },
    );
    const rTrav = await H.storeQ(
      call,
      `return JSON.stringify(await s.enterCompareSelection(["../evil"]));`,
    );
    await H.sleep(1000);
    const stAfterTrav = await storeState(call);
    check(
      "#45 目录穿越：请求发出但 main 端点整体拒绝 ⇒ 结论 rejected（不半截采信）",
      rTrav === "started" && stAfterTrav.readSel.kind === "rejected",
      { rTrav, conclusion: stAfterTrav.readSel },
    );
    // 拒绝呈现：回比较视图（returnToCompare 同幂等不重读，rejected 结论保留）⇒ 工作区给
    // 受控错误码 + 重试读取入口；不渲染旧 pair 的内容
    await H.storeQ(
      call,
      `if (s.view !== "compare") { await s.returnToCompare(); }
       return JSON.stringify(s.view);`,
    );
    await H.sleep(900);
    const rejectView = await H.ev(
      call,
      `(() => {
         const ws = document.querySelector('[aria-label="比较工作区"]');
         const retry = document.querySelector('[aria-label="重试详细比较读取"]');
         return JSON.stringify({ text: ws === null ? null : ws.textContent, hasRetry: retry !== null });
       })()`,
    ).then(JSON.parse);
    check(
      "#45 拒绝呈现：受控错误码文本 + 重试读取按钮在场",
      (rejectView.hasRetry === true &&
        (rejectView.text || "").includes("[") &&
        (rejectView.text || "").includes("拒绝")) ||
        (rejectView.text || "").includes("非法"),
      { hasRetry: rejectView.hasRetry, text: (rejectView.text || "").slice(0, 200) },
    );

    // ── #48 快速换边与离开：在飞竞速后的最终状态不变式 ──
    // 在飞期间：开 pair(c,s) → 立即离场（trace）→ 立即交换（触发新代次读取）→ 回比较
    // ⚠️ openComparePair 要求两条都在对照集合内 ⇒ 先把 c/s 补进集合
    await H.storeQ(
      call,
      `s.toggleCompare("u7c_c"); s.toggleCompare("u7c_s");
       const p1 = s.openComparePair("u7c_c","u7c_s");
       s.setView("trace");
       const p2 = s.swapCompareSides();
       await p2; await p1.catch(() => {});
       await s.returnToCompare();
       return JSON.stringify("ok");`,
    );
    await H.sleep(1500);
    detail = await waitDetail(call);
    st = await storeState(call);
    check(
      "#48 快速换边+离场：最终 pair/选择集/结论三处同序（s 左 c 右），旧响应无处落地",
      st.comparePair !== null &&
        st.comparePair.leftRunId === "u7c_s" &&
        st.comparePair.rightRunId === "u7c_c" &&
        JSON.stringify(st.readSel.selection) === JSON.stringify(["u7c_s", "u7c_c"]) &&
        JSON.stringify(st.readSel.runIds) === JSON.stringify(["u7c_s", "u7c_c"]),
      { pair: st.comparePair, readSel: st.readSel },
    );
    check("#48 详情对齐（离场折返后不串内容）", detail !== null && detail.hasLeft === true, null);
    await H.sleep(1000);
    const stLate = await storeState(call);
    check(
      "#48 迟到响应不复活：静置后再读，结论仍是最后一次请求的那组",
      JSON.stringify(stLate.readSel.runIds) === JSON.stringify(["u7c_s", "u7c_c"]) &&
        stLate.readSel.kind === "verified",
      stLate.readSel,
    );
    // 注：确定性竞速（响应必晚于换对象）单元 + 6.3 反证 M1 承载，实机不可稳定复现（登记）

    // ── 全程只读：traces + settings 哈希逐字节不变（含探针自身手术的还原核验） ──
    const restoredOk = restoreAll();
    check("#66 手术文件全部逐字节还原（含成环文件清除）", restoredOk === true, null);
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
    check("#66 全程只读哈希：traces + settings 批首批尾逐字节一致", fpSame === true, {
      diff: fpDiff.slice(0, 5),
      startN: Object.keys(fpStart).length,
      endN: Object.keys(fpEnd).length,
    });
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
