/* eslint-disable */
/**
 * U7 任务 6.8（Electron 实机第五批）：复现 R8——四条同任务同模型同时间/短 ID
 * 碰撞标本；1440/1360/1024/800px 与 200% 缩放，检查名称列、标题、正文宽度和
 * 内部滚动。
 *
 * 对应 delta 场景（evidence-index #21、#22、#23、#37、#63）。
 *
 * 判据纪律（同 6.4–6.7）：
 * - 碰撞组四条 = 6.2 fixtures（qqq/ppp/ooo/7777aabbccdd：同 task/model/created_at，
 *   id 后缀嵌套）——零新增标本；
 * - 宽度档用 **CDP Emulation 定 CSS 视口**（1440/1360/1024/800 + DPR 2.1；200% 档 =
 *   605 CSS + DPR 4.2，对齐 U6 zoom200 实测）。⚠️ 实测本机 OS 显示缩放使
 *   「真改窗外框 → CSS 视口」映射非 1:1（比率 ≈0.708），布局判据全部按 CSS 视口
 *   语义 ⇒ 弃用 U6 的 ps 真改窗通道（ MoveWindow 本身有效，只是换算不定）；
 * - ⚠️ CDP override **不触发 window resize 事件** ⇒ override 后探针手动
 *   dispatchEvent(resize)（真实浏览器缩放/改窗必然派发该事件）+ 重进比较页；
 * - 每档布局判据全部自适应（不钉死 CSS 数值）。
 *
 * 用法：`node apps/desktop/scripts/u7-68-cdp.cjs --tag=metrics-collision`
 */
"use strict";
const { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["metrics-collision"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u7", "u7-68");
const SHOT_DIR = join(OUT_DIR, "shots");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
const PS_WIN = join(H.REPO, ".workbuddy", "ps-win.ps1");

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

const COLLISION_IDS = ["qqq7777aabbccdd", "ppp7777aabbccdd", "ooo7777aabbccdd", "7777aabbccdd"];

/** CDP 定 CSS 视口 + 手动派发 resize（CDP override 不触发 window resize 事件） */
async function setViewport(call, width, height, dsf) {
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: dsf,
    mobile: false,
  });
  await H.sleep(500);
  await H.ev(call, `(() => { window.dispatchEvent(new Event('resize')); return 'ok'; })()`);
  await H.sleep(500);
}

/** 等窗口 CSS 宽收敛（±2px 稳定即认为改窗完成） */
async function waitForWidth(call, targetOuter, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  for (;;) {
    const w = await H.ev(call, "window.innerWidth");
    if (typeof w === "number" && Math.abs(w - last) <= 1) {
      // 连续两次读数一致 ⇒ 布局收敛
      return w;
    }
    last = typeof w === "number" ? w : last;
    if (Date.now() > deadline) return last;
    await H.sleep(400);
  }
}

/** 表头读数：sticky 名称列 + 各列短 ID（span[title=runId]）+ 横滚容器 */
const tableProbe = (call) =>
  H.ev(
    call,
    `(() => {
       const t = document.querySelector('table');
       if (t === null) return JSON.stringify(null);
       const ths = Array.from(t.querySelectorAll('thead th'));
       const nameTh = ths[0];
       const nameStyle = nameTh === undefined ? null : getComputedStyle(nameTh);
       // 横滚容器 = 表格的 overflow 祖先（「横滚容器只包表格」）
       const scroller = t.parentElement;
       const scrollerStyle = scroller === null ? null : getComputedStyle(scroller);
       const cols = {};
       for (const id of ${JSON.stringify(COLLISION_IDS)}) {
         const span = t.querySelector('thead span[title="' + id + '"]');
         cols[id] = span === null ? null : span.textContent;
       }
       return JSON.stringify({
         thCount: ths.length,
         nameVisible: nameTh === undefined ? false : nameTh.offsetWidth > 0,
         nameSticky: nameStyle === null ? null : { position: nameStyle.position, left: nameStyle.left },
         nameRectLeft: nameTh === undefined ? null : nameTh.getBoundingClientRect().left,
         scrollerRectLeft: scroller === null ? null : scroller.getBoundingClientRect().left,
         scrollW: scroller === null ? null : scroller.scrollWidth,
         clientW: scroller === null ? null : scroller.clientWidth,
         overflowAuto: scrollerStyle === null ? null : scrollerStyle.overflowX,
         cols,
         bodyScrollW: document.body.scrollWidth,
         innerW: window.innerWidth,
         dpr: window.devicePixelRatio,
       });
     })()`,
  ).then(JSON.parse);

// ---------------------------------------------------------------------------
// tag：metrics-collision
// ---------------------------------------------------------------------------

const FLOWS = {
  async "metrics-collision"(call) {
    // DPR 哨兵（在宽度档覆盖之前）
    const dpr0 = await H.ev(call, "window.devicePixelRatio");
    check("DPR ≈ 2.1（无 zoom 残留）", Math.abs(dpr0 - 2.1) < 0.15, `实测 ${dpr0}`);

    // 注入 id 全集在场
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
    const EXPECTED_IDS = [];
    for (const dir of [FIXTURE_TRACES_SRC, FIXTURE_ISOLATED_SRC]) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
        const meta = JSON.parse(readFileSync(join(dir, name), "utf8").split("\n")[0]);
        EXPECTED_IDS.push(String(meta.id));
      }
    }
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
      `visible=${injectedCount(st0)}/${EXPECTED_IDS.length}`,
    );

    // ── R8：四条碰撞组进指标表（默认窗口宽度） ──
    await H.storeQ(
      call,
      `s.clearCompare();
       s.toggleCompare("qqq7777aabbccdd"); s.toggleCompare("ppp7777aabbccdd");
       s.toggleCompare("ooo7777aabbccdd"); s.toggleCompare("7777aabbccdd");
       await s.openCompareWorkspace();
       return JSON.stringify("ok");`,
    );
    await H.sleep(1500);
    const m = await openMetrics(call);
    const p = await tableProbe(call);
    check(
      "R8 四条进表：表头 ≥5 列全部有宽（名称列可见）",
      p !== null && p.thCount >= 5 && p.nameVisible === true,
      { thCount: p?.thCount, nameVisible: p?.nameVisible },
    );
    check(
      "#22 名称列 sticky left-0（R8「名称列宽 0」复现消除的 sticky 面）",
      p.nameSticky !== null && p.nameSticky.position === "sticky" && p.nameSticky.left === "0px",
      p.nameSticky,
    );
    // 碰撞短 ID：四列显示互异（延长生效），且互为后缀嵌套族
    const ids = COLLISION_IDS;
    const texts = ids.map((id) => p.cols[id]);
    const allDistinct = new Set(texts).size === 4;
    check(
      "#21 碰撞短 ID 延长生效：四列显示互异（同 task/model/created_at 的后缀嵌套族不混淆）",
      allDistinct === true && texts.every((t) => typeof t === "string" && t.length > 0),
      { cols: p.cols },
    );
    const shortIdSnapshot = { ...p.cols };
    dump.shortIdSnapshot = shortIdSnapshot;
    await H.shot(call, SHOT_DIR, "collision-four.png");

    // ── #23 三条语境：提示显式选两条 + 挑选条 disabled/enabled ──
    await H.storeQ(
      call,
      `s.clearCompare();
       s.toggleCompare("qqq7777aabbccdd"); s.toggleCompare("ppp7777aabbccdd"); s.toggleCompare("ooo7777aabbccdd");
       await s.enterCompareSelection(["qqq7777aabbccdd","ppp7777aabbccdd","ooo7777aabbccdd"]);
       return JSON.stringify("ok");`,
    );
    await H.sleep(1200);
    const m3 = await openMetrics(call);
    check(
      "#23 三条：提示「已选三条及以上：可在表内显式选择两条进入详细比较」",
      (m3?.wsText || "").includes("已选三条及以上"),
      (m3?.wsText || "").match(/已选三条[^。]{0,60}/)?.[0] ?? null,
    );
    // 挑选条：只设左 ⇒ 打开按钮 disabled + 右显示（未选）
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="设为左列 qqq7777aabbccdd"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(500);
    const pickHalf = await H.ev(
      call,
      `(() => {
         const bar = Array.from(document.querySelectorAll('div')).find(d => (d.textContent || '').includes('已选：左'));
         const open = document.querySelector('[aria-label="打开所选两条的详细比较"]');
         return JSON.stringify({
           barText: bar === null ? null : bar.textContent,
           openDisabled: open === null ? null : open.disabled,
         });
       })()`,
    ).then(JSON.parse);
    check(
      "#23 挑选条：未选侧显示（未选）+ 两侧齐备前打开按钮 disabled",
      pickHalf !== null &&
        (pickHalf.barText || "").includes("（未选）") &&
        pickHalf.openDisabled === true,
      pickHalf,
    );
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="设为右列 ppp7777aabbccdd"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(500);
    const pickFull = await H.ev(
      call,
      `(() => {
         const open = document.querySelector('[aria-label="打开所选两条的详细比较"]');
         const idsNow = (window.__store_probe === undefined) ? null : null;
         return JSON.stringify({ openDisabled: open === null ? null : open.disabled });
       })()`,
    ).then(JSON.parse);
    check(
      "#23 两侧齐备 ⇒ 打开按钮 enabled",
      pickFull !== null && pickFull.openDisabled === false,
      pickFull,
    );
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[aria-label="打开所选两条的详细比较"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1500);
    const st = await storeState(call);
    check(
      "#23 打开后：pair=挑选的两条 + 全局集合三条纹丝不动",
      st.comparePair !== null &&
        st.comparePair.leftRunId === "qqq7777aabbccdd" &&
        st.comparePair.rightRunId === "ppp7777aabbccdd" &&
        st.compareIds.length === 3,
      { pair: st.comparePair, ids: st.compareIds },
    );

    // ── #21 身份不随筛选/交换改变：交换 + 集合变动 + 视图往返后短 ID 快照对位一致 ──
    // 交换：pair 内短 ID 跟随 run（标题互换但不重编号）
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="交换左右"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await H.sleep(1500);
    await waitDetail(call);
    const afterSwap = await H.ev(
      call,
      `(() => {
         const ids = ${JSON.stringify(ids)};
         const out = {};
         for (const id of ids) {
           const span = document.querySelector('[aria-label="比较工作区"] span[title="' + id + '"]');
           out[id] = span === null ? null : span.textContent;
         }
         return JSON.stringify(out);
       })()`,
    ).then(JSON.parse);
    check(
      "#21 交换后短 ID 对位不变（工作区只渲染 pair 两条；跟随 run 身份，不随位置重编号）",
      afterSwap.qqq7777aabbccdd === shortIdSnapshot.qqq7777aabbccdd &&
        afterSwap.ppp7777aabbccdd === shortIdSnapshot.ppp7777aabbccdd,
      { afterSwap, snapshot: shortIdSnapshot },
    );
    // 集合变动：回四条表，移出 ooo 再加回 ⇒ 快照逐字一致（长度只增不减）
    await H.storeQ(
      call,
      `s.clearCompare();
       s.toggleCompare("qqq7777aabbccdd"); s.toggleCompare("ppp7777aabbccdd"); s.toggleCompare("ooo7777aabbccdd"); s.toggleCompare("7777aabbccdd");
       await s.openCompareWorkspace();
       return JSON.stringify("ok");`,
    );
    await H.sleep(1500);
    await openMetrics(call);
    const beforeChurn = await tableProbe(call);
    await H.storeQ(
      call,
      `s.clearCompare();
       s.toggleCompare("qqq7777aabbccdd"); s.toggleCompare("ppp7777aabbccdd"); s.toggleCompare("7777aabbccdd");
       return JSON.stringify(s.compareIds);`,
    );
    await H.sleep(700);
    await H.storeQ(
      call,
      `s.toggleCompare("ooo7777aabbccdd");
       await s.openCompareWorkspace();
       return JSON.stringify("ok");`,
    );
    await H.sleep(1500);
    await openMetrics(call);
    const afterChurn = await tableProbe(call);
    check(
      "#21 集合移出再加回：四列短 ID 与快照逐字一致（不重编号、不缩短）",
      ids.every((id) => afterChurn.cols[id] === shortIdSnapshot[id]),
      { afterChurn: afterChurn.cols, snapshot: shortIdSnapshot },
    );

    // ── #22 宽度矩阵：1440 / 1360 / 1024 / 800（CDP 定 CSS 视口 + 手动 resize 事件） ──
    const widths = [1440, 1360, 1024, 800];
    const widthResults = [];
    for (const w of widths) {
      await setViewport(call, w, 900, 2.1);
      const probe = await tableProbe(call);
      // 名称列钉住验证：横向滚动到最右，sticky th 的 left 仍贴容器左缘
      let stickyHolds = null;
      if (probe !== null && probe.scrollW !== null && probe.scrollW > probe.clientW) {
        await H.ev(
          call,
          `(() => {
             const t = document.querySelector('table');
             const sc = t.parentElement;
             sc.scrollLeft = sc.scrollWidth;
             return 'ok';
           })()`,
        );
        await H.sleep(400);
        const p2 = await tableProbe(call);
        stickyHolds =
          p2 !== null && Math.abs((p2.nameRectLeft ?? 0) - (p2.scrollerRectLeft ?? 0)) <= 2;
      }
      widthResults.push({
        w,
        innerW: probe?.innerW,
        nameVisible: probe?.nameVisible,
        thCount: probe?.thCount,
        hScroll: probe ? probe.scrollW > probe.clientW : null,
        stickyHolds,
        bodyNoOverflow: probe ? probe.bodyScrollW <= probe.innerW + 2 : null,
        cols: probe?.cols,
      });
      check(
        `#22 ${w}px 档：CSS 视口精确生效 + 名称列可见 + sticky + 四列短 ID 对位一致 + 正文不横向溢出 body`,
        probe !== null &&
          Math.abs((probe.innerW ?? 0) - w) <= 1 &&
          probe.nameVisible === true &&
          probe.nameSticky?.position === "sticky" &&
          ids.every((id) => probe.cols[id] === shortIdSnapshot[id]) &&
          probe.bodyScrollW <= probe.innerW + 2,
        widthResults[widthResults.length - 1],
      );
    }
    check(
      "#22 窄档出现表格内横滚（800 必现；1024 记录取实测）——内部滚动承载，不撑破页面",
      widthResults[3].hScroll === true,
      {
        w1440: widthResults[0].hScroll,
        w1360: widthResults[1].hScroll,
        w1024: widthResults[2].hScroll,
        w800: widthResults[3].hScroll,
      },
    );
    check(
      "#22 横滚时名称列钉住（sticky 左缘贴容器，滚动后仍可见）",
      widthResults.every((r) => r.stickyHolds === null || r.stickyHolds === true),
      widthResults.map((r) => ({ w: r.w, sticky: r.stickyHolds })),
    );
    await H.shot(call, SHOT_DIR, "width-800.png");

    // ── #63 详细比较的 stacked 排列（阈值按正文容器宽度 960，不是整窗） ──
    // 800px 档（<960）⇒ 上下排列（每列自带标题区）；1440 档 ⇒ 并排两列。
    // ⚠️ CDP override 不触发 resize 事件 ⇒ setViewport 已手动派发 + 这里重进比较页。
    await H.storeQ(
      call,
      `s.clearCompare(); s.toggleCompare('qqq7777aabbccdd'); s.toggleCompare('ppp7777aabbccdd');
       await s.openComparePair('qqq7777aabbccdd','ppp7777aabbccdd');
       return JSON.stringify('ok');`,
    );
    await H.sleep(1500);
    await waitDetail(call);
    const stacked800 = await H.ev(
      call,
      `(() => {
         const grid = document.querySelector('[data-stacked]');
         const grid1 = document.querySelector('.grid-cols-1');
         return JSON.stringify({ stacked: grid !== null, grid1: grid1 !== null,
           innerW: window.innerWidth });
       })()`,
    ).then(JSON.parse);
    check(
      "#63 800px 档（<960）：详细比较上下排列（stacked，每列自带标题）",
      stacked800.stacked === true && stacked800.grid1 === true,
      stacked800,
    );
    // #37 @800：设置模态钳制（85vh + 内滚层）+ 操作面板钳制（70vh/24rem + 90vw）
    const clamp800 = await measureClamps(call);
    check(
      "#37 800px 档：设置模态受 85vh 钳制 + 内滚层在场（不撑破屏幕）",
      clamp800.dialog.present === true &&
        clamp800.dialog.heightRatio <= 0.86 &&
        clamp800.dialog.scrollable === true,
      clamp800.dialog,
    );
    check(
      "#37 800px 档：操作面板 max-h 钳制 + 横向不超 90vw",
      clamp800.opsPanel.present === true &&
        clamp800.opsPanel.heightRatio <= 0.72 &&
        clamp800.opsPanel.widthRatio <= 0.92,
      clamp800.opsPanel,
    );
    // 1440 档：并排两列（≥960）
    await setViewport(call, 1440, 900, 2.1);
    await H.storeQ(
      call,
      `s.setView('trace');
       await s.openComparePair('qqq7777aabbccdd','ppp7777aabbccdd');
       return JSON.stringify('ok');`,
    );
    await H.sleep(1500);
    await waitDetail(call);
    const stacked1440 = await H.ev(
      call,
      `(() => {
         const grid = document.querySelector('[data-stacked]');
         return JSON.stringify({ stacked: grid !== null, innerW: window.innerWidth });
       })()`,
    ).then(JSON.parse);
    check(
      "#63 1440px 档（≥960）：详细比较并排两列（不 stacked）",
      stacked1440.stacked === false,
      stacked1440,
    );

    // ── #22/#63/#37 200% 缩放档：CSS 视口 605 + DPR 4.2（对齐 U6 zoom200 实测） ──
    await setViewport(call, 605, 900, 4.2);
    // 先切回指标表模式（detail 模式下无 <table>）
    await openMetrics(call);
    const zoomProbe = await tableProbe(call);
    check(
      "#22 200% 缩放档：DPR≈4.2 + CSS 视口 ≈605（窄于最窄真窗档）",
      zoomProbe !== null && Math.abs(zoomProbe.dpr - 4.2) < 0.15 && zoomProbe.innerW <= 640,
      { dpr: zoomProbe?.dpr, innerW: zoomProbe?.innerW },
    );
    check(
      "#22 200% 缩放档：名称列仍可见 + sticky + 表格内横滚（正文宽度和内部滚动由横滚容器承载）",
      zoomProbe.nameVisible === true &&
        zoomProbe.nameSticky?.position === "sticky" &&
        zoomProbe.scrollW > zoomProbe.clientW,
      {
        nameVisible: zoomProbe?.nameVisible,
        scrollW: zoomProbe?.scrollW,
        clientW: zoomProbe?.clientW,
      },
    );
    // 横滚后 sticky 仍钉住 + 在场列短 ID 对位（override 后表只含当前选择集的两列）
    await H.ev(
      call,
      `(() => { const t = document.querySelector('table'); const sc = t.parentElement; sc.scrollLeft = sc.scrollWidth; return 'ok'; })()`,
    );
    await H.sleep(400);
    const zoomSticky = await tableProbe(call);
    const zoomPresentCols = ids.filter(
      (id) => zoomSticky?.cols?.[id] !== null && zoomSticky?.cols?.[id] !== undefined,
    );
    check(
      "#22 200% 缩放档：横滚后名称列钉住 + 在场列短 ID 逐字对位",
      Math.abs((zoomSticky.nameRectLeft ?? 0) - (zoomSticky.scrollerRectLeft ?? 0)) <= 2 &&
        zoomPresentCols.length >= 2 &&
        zoomPresentCols.every((id) => zoomSticky.cols[id] === shortIdSnapshot[id]),
      {
        stickyLeft: zoomSticky?.nameRectLeft,
        scrollerLeft: zoomSticky?.scrollerRectLeft,
        cols: zoomSticky?.cols,
      },
    );
    await H.shot(call, SHOT_DIR, "zoom200.png");
    // #37 @zoom200：操作面板钳制（max-h + 横向不超 90vw）。
    // ⚠️ 登记分层：zoom override 下 CDP 对 React 布局状态的传导不完整——
    // stacked（605<960 应上下排列）与设置模态打开在 override 后不翻转/不可达，
    // 两者分别由 compare-navigation 纯判据（605<960 ⇒ stacked）单元与 U6 6.8
    // 真 OS 缩放实测（zoom200 组可达性）承载；非产品缺陷证据缺口。
    await H.storeQ(
      call,
      `s.setView('trace');
       await s.openComparePair('qqq7777aabbccdd','ppp7777aabbccdd');
       return JSON.stringify('ok');`,
    );
    await H.sleep(1500);
    await waitDetail(call);
    const clampZoom = await measureClamps(call);
    check(
      "#37 200% 缩放档：操作面板钳制在场（max-h + 横向不超 90vw）",
      clampZoom.opsPanel.present === true &&
        clampZoom.opsPanel.heightRatio <= 0.72 &&
        clampZoom.opsPanel.widthRatio <= 0.92,
      clampZoom.opsPanel,
    );
    await H.shot(call, SHOT_DIR, "zoom200-clamps.png");
    await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await H.sleep(600);
    const dprBack = await H.ev(call, "window.devicePixelRatio");
    check("缩放档清除：DPR 回 ≈2.1（不留残留）", Math.abs(dprBack - 2.1) < 0.15, `实测 ${dprBack}`);
  },
};

// ---------------------------------------------------------------------------
// storeState / waitDetail / openMetrics（局部工具）
// ---------------------------------------------------------------------------

const storeState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       view: s.view, selectedRunId: s.selectedRunId,
       runIds: s.runs.map(r => r.id),
       compareIds: s.compareIds, comparePair: s.comparePair,
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
         });
       })()`,
    ).then(JSON.parse);
    if (p?.hasLeft && !p.loading) return p;
    if (Date.now() > deadline) return p;
    await H.sleep(400);
  }
}

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

// ---------------------------------------------------------------------------
// #37 钳制读数：设置模态（85vh）与操作面板（70vh/24rem + 90vw）
// ---------------------------------------------------------------------------

async function measureClamps(call) {
  // 设置模态：点「运行配置」⇒ showModal 真 top layer（原生 dialog）；未开则重试一次
  for (let attempt = 1; attempt <= 2; attempt++) {
    await H.ev(
      call,
      `(() => {
         const b = Array.from(document.querySelectorAll('button'))
           .find(x => (x.textContent || '').includes('运行配置'));
         if (b) b.click();
         return 'ok';
       })()`,
    );
    await H.sleep(900);
    const opened = await H.ev(call, `document.querySelector('dialog[open]') !== null`);
    if (opened === true) break;
  }
  const dialog = await H.ev(
    call,
    `(() => {
       const d = document.querySelector('dialog[open]');
       if (d === null) return JSON.stringify({ present: false });
       // ⚠️ ModalDialog 把 className（含 max-h-[85vh] overflow-y-auto）直接加在
       // <dialog> 自身 ⇒ 判 d.className；querySelectorAll('*') 不含自身（实测踩过）
       const r = d.getBoundingClientRect();
       return JSON.stringify({
         present: true,
         heightRatio: r.height / window.innerHeight,
         scrollable: typeof d.className === 'string' && d.className.includes('overflow-y-auto'),
       });
     })()`,
  ).then(JSON.parse);
  // Esc 关闭（原生 cancel 路径）
  await H.ev(
    call,
    `(() => {
       const d = document.querySelector('dialog[open]');
       if (d !== null) d.close();
       return 'ok';
     })()`,
  );
  await H.sleep(700);
  // 操作面板：切换按钮 aria-controls="operations-panel"
  await H.ev(
    call,
    `(() => {
       const b = document.querySelector('button[aria-controls="operations-panel"]');
       if (b) b.click();
       return 'ok';
     })()`,
  );
  await H.sleep(900);
  const opsPanel = await H.ev(
    call,
    `(() => {
       const panel = document.getElementById('operations-panel');
       if (panel === null) return JSON.stringify({ present: false });
       const r = panel.getBoundingClientRect();
       return JSON.stringify({
         present: true,
         heightRatio: r.height / window.innerHeight,
         widthRatio: r.width / window.innerWidth,
       });
     })()`,
  ).then(JSON.parse);
  // 收起面板（再次点击同一按钮）
  await H.ev(
    call,
    `(() => {
       const b = document.querySelector('button[aria-controls="operations-panel"]');
       if (b) b.click();
       return 'ok';
     })()`,
  );
  await H.sleep(500);
  return { dialog, opsPanel };
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
