"use strict";
/**
 * 6.1 侦察轮（**不下判据**，只拿真形状）：D03 要钉"阅读位置/焦点/无新导航/无执行登记"，
 * 但 store 字段名、滚动容器选择器、页签文案都必须实测拿到，凭直觉写断言必然假红
 * （UI-VERIFY.md：「判据分层要按组件真实挂载点写」）。
 *
 * 前置：dev 已起在 9612（NO_SANDBOX=1 node scripts/start-dev.cjs --remoteDebuggingPort=9612）。
 */
const H = require("./lib/u4-smoke-harness.cjs");
const U = require("./lib/u2-cdp-util.cjs");

(async () => {
  const page = await U.cdpConnect(U.CDP_PORT || H.CDP_PORT);
  if (!page || !page.webSocketDebuggerUrl) throw new Error("拿不到 page target");
  const call = await U.makeSession(page.webSocketDebuggerUrl);
  await call("Runtime.enable");
  await call("Page.enable");

  const out = {};

  // 1) store 顶层键 + 只读面相关字段（storeQ 自己就 JSON.parse 过了，别再包一层）
  out.storeKeys = await H.storeQ(
      call,
      `return JSON.stringify({
           keys: Object.keys(s).sort(),
           view: s.view,
           runId: s.runId ?? s.selectedRunId ?? null,
           runs: s.runs.length,
           nav: s.navHistory ?? s.history ?? null,
           workspace: s.workspace ? Object.keys(s.workspace).slice(0, 12) : null,
           compare: s.compare ? Object.keys(s.compare).slice(0, 8) : null,
           execKeys: Object.keys(s).filter(k => /exec|operation|slot|submit|run_|start/i.test(k)),
         });`,
  );

  // 2) 页面上可点的主导航/页签文案（决定点击序列怎么写）
  out.buttons = JSON.parse(
    await H.ev(
      call,
      `(() => JSON.stringify(Array.from(document.querySelectorAll('button'))
            .map(b => (b.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 24))
            .filter(t => t.length > 0).slice(0, 60)))()`,
    ),
  );

  // 3) 滚动容器候选（阅读位置判据的落点）
  out.scrollers = JSON.parse(
    await H.ev(
      call,
      `(() => {
         const all = Array.from(document.querySelectorAll('div,main,section,aside'));
         const tall = all.filter(el => el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 120);
         return JSON.stringify(tall.slice(0, 12).map(el => ({
           cls: String(el.className).slice(0, 70),
           sh: el.scrollHeight,
           ch: el.clientHeight,
           st: el.scrollTop,
           id: el.id || null,
           dataAttrs: Object.keys(el.dataset || {}),
         })));
       })()`,
    ),
  );

  // 4) 当前视口/缩放/DPR（窄窗与 200% 档的自证基线）
  out.viewport = JSON.parse(
    await H.ev(
      call,
      `(() => JSON.stringify({
         cw: document.documentElement.clientWidth,
         iw: window.innerWidth,
         dpr: window.devicePixelRatio,
         ow: window.outerWidth, oh: window.outerHeight,
         title: document.title,
         url: location.href.slice(0, 60),
       }))()`,
    ),
  );

  // 5) 列表是否真有数据（dev 数据根 .rebaseagent/traces 的 run 数 vs store.runs）
  out.traceCount = H.readdirSync(H.TRACES).filter((n) => n.endsWith(".jsonl")).length;

  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})().catch((error) => {
  console.log("RECON FAILED:", String(error).slice(0, 600));
  process.exit(1);
});
