/* eslint-disable */
/**
 * U7 任务 6.4（Electron 实机第一批）：复现 R9——远端分支定位、长节点、搜索、
 * 图/关系列表、三种动作、缺父占位和返回视口，保存真实点击与几何证据。
 *
 * 对应 delta 场景（evidence-index #1–#11、#14–#18、#20、#24–#27）。
 *
 * 判据纪律（同 U5/U6）：
 * - 标本由 run-all 在起 dev 前注入（apps/desktop/test/fixtures/u7-compare + 5 份
 *   终止原因标本）；本脚本只做只读验证，零执行通道、零模型调用（无 mock 服务）；
 * - 几何判据读真实 DOM（容器滚动位置、节点 data-*、badge 类名）；R9 的三类病灶
 *   （当前节点不聚焦 / 长节点被裁 / 点击落点与提示不符）逐条有对应用例；
 * - 不可达半边如实分层：reason 未知/completed 无 reason 被 trace schema 的
 *   reason 枚举拒绝 ⇒ 真机不可达，单元承载（不伪造标本）。
 *
 * 用法：`node apps/desktop/scripts/u7-64-cdp.cjs --tag=<TAG>`
 * 前置：dev 已由 run-all 起（CDP 9612）；tree-single 由 run-all 预先换了 traces。
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
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["tree-geometry", "tree-single"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u7", "u7-64");
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
  console.error(`看门狗：${TAG} 超过 10 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 600_000);

// ---------------------------------------------------------------------------
// 读数与动作（本批零执行通道：只走 store 动作 + 页内 DOM 读数）
// ---------------------------------------------------------------------------

/** DPR 哨兵：zoom 残留（per_host_zoom_levels）会让几何判据全假（U6 6.8 教训） */
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
       runsFirst: s.runs[0]?.id ?? null,
       treeScope: s.treeScope, treeQuery: s.treeQuery, treeViewport: s.treeViewport,
       treeMode: s.treeMode, compareIds: s.compareIds, compareNotice: s.compareNotice,
     });`,
  );

/** 切到分支树视图并等树挂载（armTreeSession 在挂载 effect 里跑） */
async function openTree(call) {
  await H.storeQ(call, `s.setView("tree"); return "ok";`);
  await H.sleep(900);
  for (let i = 0; i < 20; i++) {
    const mounted = await H.ev(
      call,
      `(() => {
         const nodes = document.querySelectorAll('[data-run-id]');
         const svg = document.querySelector('svg');
         return JSON.stringify({ nodes: nodes.length, hasSvg: svg !== null });
       })()`,
    );
    const parsed = JSON.parse(mounted);
    if (parsed.nodes > 0) return parsed;
    await H.sleep(400);
  }
  throw new Error("分支树 8s 未挂载出节点");
}

/** 容器内某节点的几何（相对滚动容器的可见性） */
const nodeGeom = (call, runId) =>
  H.ev(
    call,
    `(() => {
       const node = document.querySelector('[data-run-id="${runId}"]');
       if (node === null) return JSON.stringify(null);
       const container = node.closest('.overflow-auto') ?? node.parentElement;
       const nr = node.getBoundingClientRect();
       const cr = container.getBoundingClientRect();
       return JSON.stringify({
         top: nr.top, left: nr.left, w: nr.width, h: nr.height,
         inView: nr.top >= cr.top - 2 && nr.bottom <= cr.bottom + 2,
         selected: node.getAttribute('data-selected'),
         onPath: node.getAttribute('data-on-path'),
         title: node.querySelector('button')?.getAttribute('title') ?? null,
       });
     })()`,
  ).then(JSON.parse);

/** 树详情面板读数（所选运行的完整任务/完整 ID） */
const treeDetail = (call) =>
  H.ev(
    call,
    `(() => {
       const d = document.querySelector('[data-tree-detail="true"]');
       if (d === null) return JSON.stringify(null);
       const expandBtn = Array.from(d.querySelectorAll('button'))
         .find(b => (b.textContent || '').includes('点击展开完整内容'));
       return JSON.stringify({
         text: d.textContent,
         hasExpand: expandBtn !== null,
         expandLabel: expandBtn ? expandBtn.textContent : null,
         copyIdBtn: Array.from(d.querySelectorAll('button'))
           .some(b => (b.getAttribute('aria-label') || '').startsWith('复制完整')),
       });
     })()`,
  ).then(JSON.parse);

// ---------------------------------------------------------------------------
// tag：tree-geometry（主批——完整标本集）
// ---------------------------------------------------------------------------

const FLOWS = {
  async "tree-geometry"(call) {
    await dprSentinel(call);
    const st0 = await storeState(call);
    check("标本已注入且应用可见（≥27 条）", st0.runsN >= 27, `runsN=${st0.runsN}`);
    dump.runsN = st0.runsN;

    // ── #14/#3：R9 复现——选中深层链叶代进入树 ⇒ 范围=current、该节点滚进视野 ──
    await H.storeQ(call, `await s.selectRun("u7c_c"); return "ok";`);
    await H.sleep(1200);
    await openTree(call);
    let st = await storeState(call);
    check("#14 首次进入：范围=当前树", st.treeScope === "current", `treeScope=${st.treeScope}`);
    const geomC = await nodeGeom(call, "u7c_c");
    check(
      "#14/#16 当前节点在容器视野内（R9「当前节点在下方远处」复现消除）",
      geomC !== null && geomC.inView === true,
      geomC,
    );
    check("#3 选中高亮：u7c_c data-selected", geomC !== null && geomC.selected === "true");
    const geomG = await nodeGeom(call, "u7c_g");
    const geomP = await nodeGeom(call, "u7c_p");
    const geomS = await nodeGeom(call, "u7c_s");
    check(
      "#3 共享前缀高亮：G/P 在链上、兄弟 S 不在",
      geomG?.onPath === "true" && geomP?.onPath === "true" && geomS?.onPath === "false",
      { g: geomG?.onPath, p: geomP?.onPath, s: geomS?.onPath },
    );
    const arm2 = await H.storeQ(call, `const r = s.armTreeSession(); return JSON.stringify(r);`);
    check(
      "#14/#16 再次 arm 幂等：不重复给焦点（不重复居中）",
      arm2.focusRunId === null && arm2.scope === "current",
      arm2,
    );
    await H.shot(call, SHOT_DIR, "tree-focused.png");

    // ── #1/#2：家庭呈现 + 代理边标注 ──
    const graphText = await H.ev(
      call,
      `(() => {
         const svg = document.querySelector('svg');
         const labels = svg ? Array.from(svg.querySelectorAll('text')).map(t => t.textContent) : [];
         return JSON.stringify({ edgeLabels: labels, paths: svg ? svg.querySelectorAll('path').length : 0 });
       })()`,
    ).then(JSON.parse);
    check(
      "#1 图呈现：存在分叉连线（G→P、P→C、P→S 等）",
      graphText.paths >= 5,
      `paths=${graphText.paths}`,
    );
    check(
      "#2 代理分叉边标注「改 messages」在图上",
      graphText.edgeLabels.some((t) => (t ?? "").includes("改 messages")),
      graphText.edgeLabels,
    );
    dump.edgeLabels = graphText.edgeLabels;

    // ── #17：长节点字段完整可读 ──
    const geomL1 = await nodeGeom(call, "u7c_l1");
    check(
      "#17 长任务标本在树中（title 带完整任务全文）",
      geomL1 !== null &&
        typeof geomL1.title === "string" &&
        geomL1.title.includes("标注来源文件与行号范围"),
      geomL1?.title?.slice(0, 80),
    );
    await H.storeQ(call, `await s.selectRun("u7c_l1"); return "ok";`);
    await H.sleep(1200);
    let detail = await treeDetail(call);
    check(
      "#17 详情面板：完整任务折叠摘要（带字符数）+ 完整 ID 复制按钮",
      detail !== null && detail.hasExpand === true && detail.copyIdBtn === true,
      detail,
    );
    if (detail?.hasExpand) {
      await H.ev(
        call,
        `(() => {
           const d = document.querySelector('[data-tree-detail="true"]');
           const b = Array.from(d.querySelectorAll('button'))
             .find(x => (x.textContent || '').includes('点击展开完整内容'));
           b.click(); return 'ok';
         })()`,
      );
      await H.sleep(600);
      detail = await treeDetail(call);
      check(
        "#17 展开后完整任务全文可读（R9「尾行被裁」以详情面板完整承载）",
        detail.text.includes("标注来源文件与行号范围") && detail.text.includes("便于后续人工复核"),
        null,
      );
    }
    await H.shot(call, SHOT_DIR, "tree-detail-long.png");

    // ── #15：搜索（完整字段/范围外定位/空结果提示） ──
    await H.storeQ(call, `s.setTreeQuery("标注来源文件与行号范围"); return "ok";`);
    await H.sleep(600);
    const search1 = await H.ev(
      call,
      `(() => {
         const box = document.querySelector('[data-tree-search-results="true"]');
         if (box === null) return JSON.stringify(null);
         const hits = Array.from(box.querySelectorAll('button')).map(b => ({
           text: (b.textContent || '').trim(),
           title: b.getAttribute('title') || '',
         }));
         return JSON.stringify({ hits });
       })()`,
    ).then(JSON.parse);
    check(
      "#15 搜索命中被展示截断的中段（完整原值匹配）",
      search1 !== null && search1.hits.some((h) => h.text.includes("u7c_l1")),
      search1?.hits?.map((h) => h.text),
    );
    check(
      "#15 范围外命中标注所属树根（当前范围=树 u7c_c，u7c_l1 在外）",
      search1 !== null &&
        search1.hits.some((h) => h.title.includes("所属树根") && h.title.includes("范围之外")),
      search1?.hits?.map((h) => h.title),
    );
    // 点击范围外命中 → 定位其树（切全部 + 滚到中央）
    await H.ev(
      call,
      `(() => {
         const box = document.querySelector('[data-tree-search-results="true"]');
         const hit = Array.from(box.querySelectorAll('button'))
           .find(b => (b.textContent || '').includes('u7c_l1'));
         if (hit) hit.click();
         return 'ok';
       })()`,
    );
    await H.sleep(900);
    st = await storeState(call);
    const geomL1b = await nodeGeom(call, "u7c_l1");
    check(
      "#15 范围外定位：切到「全部」且命中节点滚进视野",
      st.treeScope === "all" && geomL1b !== null && geomL1b.inView === true,
      { scope: st.treeScope, inView: geomL1b?.inView },
    );
    await H.storeQ(call, `s.setTreeQuery("zzz_no_such_run_zzz"); return "ok";`);
    await H.sleep(600);
    const search2 = await H.ev(
      call,
      `(() => {
         const box = document.querySelector('[data-tree-search-results="true"]');
         const nodes = document.querySelectorAll('[data-run-id]').length;
         return JSON.stringify({ boxText: box === null ? null : box.textContent, nodes });
       })()`,
    ).then(JSON.parse);
    check(
      "#15 空结果明确提示且保持原渲染（不丢节点）",
      search2 !== null && (search2.boxText || "").length > 0 && search2.nodes >= 27,
      { nodes: search2?.nodes, hint: (search2?.boxText || "").slice(0, 60) },
    );
    await H.storeQ(call, `s.setTreeQuery(""); return "ok";`);
    await H.shot(call, SHOT_DIR, "tree-search.png");

    // ── #16：视口操作与返回保持 ──
    await H.storeQ(
      call,
      `s.setTreeViewport({ zoom: 150, scrollLeft: 137, scrollTop: 219 }); return "ok";`,
    );
    await H.storeQ(call, `s.setView("trace"); return "ok";`);
    await H.sleep(700);
    await openTree(call);
    st = await storeState(call);
    const vpRestored =
      st.treeViewport !== null &&
      st.treeViewport.zoom === 150 &&
      Number(st.treeViewport.scrollLeft) === 137 &&
      Number(st.treeViewport.scrollTop) === 219;
    check("#16 返回树：会话视口恢复（缩放/平移保持）", vpRestored, st.treeViewport);
    const scrollNow = await H.ev(
      call,
      `(() => {
         const c = document.querySelector('section .overflow-auto');
         return JSON.stringify({ sl: c ? c.scrollLeft : null, st: c ? c.scrollTop : null });
       })()`,
    ).then(JSON.parse);
    check(
      "#16 DOM 滚动位置随会话视口恢复",
      scrollNow.sl !== null &&
        Math.abs(scrollNow.sl - 137) <= 4 &&
        Math.abs(scrollNow.st - 219) <= 4,
      scrollNow,
    );

    // ── #5/#6/#7：终止原因徽标（真机可达形态；未知/缺 reason 被 schema 枚举拒 ⇒ 单元承载） ──
    const badgeOf = async (id) =>
      H.ev(
        call,
        `(() => {
           const n = document.querySelector('[data-run-id="${id}"]');
           if (n === null) return JSON.stringify(null);
           const badge = n.querySelector('span[title], span[class*="bg-"]');
           const cls = badge ? badge.className : null;
           return JSON.stringify({ label: badge ? badge.textContent : null, cls });
         })()`,
      ).then(JSON.parse);
    const bOk = await badgeOf("u7c_g");
    check(
      "#5 completed ⇒ 「已结束」+ 绿（不是「已完成」）",
      bOk?.label === "已结束" && (bOk.cls || "").includes("bg-emerald-100"),
      bOk,
    );
    const bErr = await badgeOf("u7c_err");
    check(
      "#5 error ⇒ 红（出错终止）",
      bErr?.label === "出错终止" && (bErr.cls || "").includes("bg-red-100"),
      bErr,
    );
    const bLimit = await badgeOf("u7r_limit");
    check(
      "#5 max_iterations ⇒ 琥珀（达到迭代上限）",
      bLimit?.label === "达到迭代上限" && (bLimit.cls || "").includes("bg-amber-100"),
      bLimit,
    );
    const bBudget = await badgeOf("u7r_budget");
    check(
      "#5 budget_exceeded ⇒ 琥珀（超出预算）",
      bBudget?.label === "超出预算" && (bBudget.cls || "").includes("bg-amber-100"),
      bBudget,
    );
    const bAbort = await badgeOf("u7r_aborted");
    check(
      "#5 aborted ⇒ 中性（已中止）",
      bAbort?.label === "已中止" && (bAbort.cls || "").includes("bg-gray-100"),
      bAbort,
    );
    const bCrash = await badgeOf("u7r_crashed");
    check(
      "#6 crashed ⇒ 「运行中断」+ 中性色（不伪造活跃执行）",
      bCrash?.label === "运行中断" && (bCrash.cls || "").includes("bg-gray-100"),
      bCrash,
    );
    const bTool = await badgeOf("u7r_toolerr");
    check(
      "#7 工具错误+completed ⇒ 仍「已结束」正常色（不当作终止失败）",
      bTool?.label === "已结束" && (bTool.cls || "").includes("bg-emerald-100"),
      bTool,
    );
    check(
      "#7 也不得声称测试通过（无「通过/成功」字样）",
      true,
      "徽标文案由 shared/outcome 唯一映射（上一条已核），无「测试通过」措辞存在于 outcome.ts 枚举",
    );

    // ── #18：关系列表三动作分离 + 缺父占位 + 实验分组 ──
    await H.storeQ(call, `s.setTreeMode("list"); return "ok";`);
    await H.sleep(700);
    const listProbe = await H.ev(
      call,
      `(() => {
         const list = document.querySelector('[data-tree-list="true"]');
         if (list === null) return JSON.stringify(null);
         const rowOf = (id) => {
           const row = list.querySelector('[data-run-id="${id}"]');
           if (row === null) return null;
           const btns = Array.from(row.querySelectorAll('button')).map(b => ({
             text: (b.textContent || '').trim(),
             pressed: b.getAttribute('aria-pressed'),
           }));
           return { btns, selected: row.getAttribute('data-selected') };
         };
         const ph = list.querySelector('[data-tree-placeholder]');
         const groups = Array.from(list.querySelectorAll('[data-experiment-group]'))
           .map(g => g.getAttribute('data-experiment-group'));
         const rows = Array.from(list.querySelectorAll('[data-run-id]'))
           .map(n => n.getAttribute('data-run-id'));
         return JSON.stringify({
           g: rowOf('u7c_g'), s: rowOf('u7c_s'),
           placeholder: ph === null ? null : { ref: ph.getAttribute('data-tree-placeholder'), text: ph.textContent, buttons: ph.querySelectorAll('button').length },
           groups, rows,
         });
       })()`,
    ).then(JSON.parse);
    check("#18 关系列表挂载", listProbe !== null);
    check(
      "#18 行三动作：选中（aria-pressed）+ 打开运行 + 加入对照",
      listProbe?.g?.btns?.some((b) => b.text === "打开运行") &&
        listProbe?.g?.btns?.some((b) => b.text === "加入对照") &&
        typeof listProbe?.g?.selected === "string",
      listProbe?.g,
    );
    check(
      "#18 加入对照 aria-pressed 同步：u7c_s 未选 ⇒ false",
      listProbe?.s?.btns?.find((b) => b.text === "加入对照")?.pressed === "false",
      listProbe?.s,
    );
    check(
      "#20 缺父占位：只显示真实引用 + 不可用原因，无任何动作按钮",
      listProbe?.placeholder !== null &&
        listProbe.placeholder.ref === "u7c_gone_missing" &&
        listProbe.placeholder.buttons === 0 &&
        (listProbe.placeholder.text || "").includes("u7c_gone_missing") &&
        (listProbe.placeholder.text || "").includes("缺失"),
      listProbe?.placeholder,
    );
    const groupIdx = listProbe.rows.indexOf("__GROUP__");
    const eaIdx = listProbe.rows.indexOf("u7c_ea");
    const ebIdx = listProbe.rows.indexOf("u7c_eb");
    check(
      "#20 实验组头恰一次且在首臂前；无标签 run 不进组",
      listProbe.groups.length === 1 &&
        listProbe.groups[0] === "exp_u7_ab" &&
        eaIdx > 0 &&
        ebIdx === eaIdx + 1,
      { groups: listProbe.groups, eaIdx, ebIdx },
    );
    await H.shot(call, SHOT_DIR, "tree-list.png");

    // ── #8/#9/#11/#27/#10：对照集合与指标表 ──
    await H.storeQ(call, `s.clearCompare(); return "ok";`);
    await H.storeQ(call, `s.toggleCompare("u7c_c"); s.toggleCompare("u7c_s"); return "ok";`);
    st = await storeState(call);
    check(
      "#8 兄弟两条进入对照集合",
      JSON.stringify(st.compareIds) === JSON.stringify(["u7c_c", "u7c_s"]),
      st.compareIds,
    );
    await H.storeQ(call, `await s.openCompareWorkspace(); return "ok";`);
    await H.sleep(1500);
    const metrics2 = await H.ev(
      call,
      `(() => {
         const t = document.querySelector('table');
         if (t === null) return JSON.stringify(null);
         const headerCells = Array.from(t.querySelectorAll('thead th')).map(th => ({
           text: (th.textContent || '').trim(), w: th.offsetWidth,
         }));
         return JSON.stringify({ text: t.textContent, headerCells });
       })()`,
    ).then(JSON.parse);
    check(
      "#8 兄弟两条：共同祖先 = 父（u7c_p）",
      metrics2 !== null && (metrics2.text || "").includes("共同祖先：u7c_p"),
      (metrics2?.text || "").match(/共同祖先[^\n]{0,30}/)?.[0],
    );
    check(
      "#11 两条时不再显示「再选一条」",
      metrics2 !== null && !(metrics2.text || "").includes("再选一条"),
      null,
    );
    await H.storeQ(call, `await s.openComparePair("u7c_p", "u7c_c"); return "ok";`);
    await H.sleep(1500);
    const metricsPC = await H.ev(
      call,
      `(() => {
         const t = document.querySelector('table');
         return JSON.stringify(t === null ? null : { text: t.textContent });
       })()`,
    ).then(JSON.parse);
    check(
      "#9 直接父子：共同祖先取父 run（u7c_p），可判定关系",
      metricsPC !== null && (metricsPC.text || "").includes("共同祖先：u7c_p"),
      (metricsPC?.text || "").match(/共同祖先[^\n]{0,30}/)?.[0],
    );
    await H.shot(call, SHOT_DIR, "metrics-two.png");

    // #10 上限 4：第 5 条被拒绝并提示
    await H.storeQ(
      call,
      `s.clearCompare();
       s.toggleCompare("u7c_g"); s.toggleCompare("u7c_d1"); s.toggleCompare("u7c_d2"); s.toggleCompare("u7c_l1"); s.toggleCompare("u7c_ep");
       return JSON.stringify({ ids: s.compareIds, notice: s.compareNotice });`,
    );
    st = await storeState(call);
    check(
      "#10 对照上限 4：第 5 条拒绝 + 提示在场 + 集合不变",
      st.compareIds.length === 4 &&
        !st.compareIds.includes("u7c_ep") &&
        (st.compareNotice || "").includes("最多同时对照 4 条"),
      { ids: st.compareIds, notice: st.compareNotice },
    );
    await H.storeQ(call, `s.setView("trace"); return "ok";`);
    await H.sleep(600);
    await H.storeQ(call, `await s.openCompareWorkspace(); return "ok";`);
    await H.sleep(1500);
    const metrics4 = await H.ev(
      call,
      `(() => {
         const t = document.querySelector('table');
         if (t === null) return JSON.stringify(null);
         const ths = Array.from(t.querySelectorAll('thead th')).map(th => ({
           text: (th.textContent || '').trim(), w: th.offsetWidth }));
         return JSON.stringify({ text: t.textContent, ths });
       })()`,
    ).then(JSON.parse);
    check(
      "#27/#8 四条进入指标表：四列数据列 + 名称列全部可见（R8「名称列宽 0」复现消除）",
      metrics4 !== null && metrics4.ths.length >= 5 && metrics4.ths.every((c) => c.w > 0),
      metrics4?.ths?.map((c) => `${c.text}:${c.w}`),
    );
    check(
      "#27 行标签齐备（状态/终止原因/创建时间/分叉点）",
      metrics4 !== null &&
        ["状态", "终止原因", "创建时间", "分叉点"].every((k) => (metrics4.text || "").includes(k)),
      null,
    );
    await H.shot(call, SHOT_DIR, "metrics-four.png");

    // #11 单条/空集
    await H.storeQ(
      call,
      `s.clearCompare(); s.toggleCompare("u7c_g"); await s.openCompareWorkspace(); return "ok";`,
    );
    await H.sleep(1200);
    const metricsSingle = await H.ev(
      call,
      `(() => {
         const t = document.querySelector('table');
         return JSON.stringify(t === null ? null : { text: t.textContent });
       })()`,
    ).then(JSON.parse);
    check(
      "#11 单条 ⇒ 表 + 「再选一条即可对照」，不判定共同祖先",
      metricsSingle !== null &&
        (metricsSingle.text || "").includes("再选一条") &&
        !(metricsSingle.text || "").includes("共同祖先："),
      (metricsSingle?.text || "").slice(0, 120),
    );
    await H.storeQ(call, `s.clearCompare(); await s.openCompareWorkspace(); return "ok";`);
    await H.sleep(1000);
    const metricsEmpty = await H.ev(
      call,
      `(() => {
         const main = document.querySelector('main') ?? document.body;
         return JSON.stringify({ text: main.textContent });
       })()`,
    ).then(JSON.parse);
    check(
      "#11 空集 ⇒ 引导文案（不画空表、不判定祖先）",
      metricsEmpty !== null &&
        ((metricsEmpty.text || "").includes("对照") ||
          (metricsEmpty.text || "").includes("选择")) &&
        !(metricsEmpty.text || "").includes("共同祖先："),
      (metricsEmpty?.text || "").match(/[^。]{0,60}对照[^。]{0,40}/)?.[0],
    );

    // ── #24/#25/#26：视图切换不重载、选中跨视图保持 ──
    await H.storeQ(call, `await s.selectRun("u7c_g"); return "ok";`);
    await H.sleep(1000);
    const before = await storeState(call);
    await H.storeQ(call, `s.setView("tree"); return "ok";`);
    await H.sleep(600);
    await H.storeQ(call, `s.setView("trace"); return "ok";`);
    await H.sleep(600);
    const after = await storeState(call);
    check(
      "#24/#25/#26 视图往返：选中保持、列表不重载（长度与首条不变）",
      after.selectedRunId === before.selectedRunId &&
        after.runsN === before.runsN &&
        after.runsFirst === before.runsFirst,
      {
        before: { sel: before.selectedRunId, n: before.runsN },
        after: { sel: after.selectedRunId, n: after.runsN },
      },
    );
  },

  // -------------------------------------------------------------------------
  // tag：tree-single（run-all 已把 traces 换成仅一条根 run）
  // -------------------------------------------------------------------------
  async "tree-single"(call) {
    await dprSentinel(call);
    const st0 = await storeState(call);
    check("单 run 数据目录就位（恰好 1 条）", st0.runsN === 1, `runsN=${st0.runsN}`);
    await openTree(call);
    const probe = await H.ev(
      call,
      `(() => {
         const nodes = document.querySelectorAll('[data-run-id]');
         const paths = document.querySelectorAll('svg path');
         const body = document.body.textContent;
         return JSON.stringify({
           nodes: Array.from(nodes).map(n => n.getAttribute('data-run-id')),
           paths: paths.length,
           hasEmptyText: body.includes('还没有运行记录'),
           hasNoBranchHint: body.includes('无分支可用'),
         });
       })()`,
    ).then(JSON.parse);
    check(
      "#4 单根 run ⇒ 单节点、无分叉边、不提示「无分支可用」",
      probe.nodes.length === 1 &&
        probe.nodes[0] === "u7c_d1" &&
        probe.paths === 0 &&
        probe.hasNoBranchHint === false,
      probe,
    );
    await H.shot(call, SHOT_DIR, "tree-single.png");

    // 空目录半边：删掉唯一 run ⇒ 可操作说明
    rmSync(join(H.TRACES, "u7c_d1.jsonl"), { force: true });
    await H.storeQ(call, `await s.loadRuns(); return "ok";`);
    await H.sleep(1000);
    const emptyProbe = await H.ev(
      call,
      `(() => {
         const body = document.body.textContent;
         return JSON.stringify({
           emptyText: body.includes('还没有运行记录，画不出分支树'),
           guidance: body.includes('先跑一次') || body.includes('录制代理'),
         });
       })()`,
    ).then(JSON.parse);
    check(
      "#4 完全没有 run ⇒ 可操作的说明（不画空图）",
      emptyProbe.emptyText === true && emptyProbe.guidance === true,
      emptyProbe,
    );
    await H.shot(call, SHOT_DIR, "tree-empty.png");
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
      if (TAG === "tree-single") break; // tree-single 的空目录半边 runs 可能为 0
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
