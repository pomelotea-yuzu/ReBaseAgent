/* eslint-disable */
/**
 * `fix-proxy-recording-reliability` 任务 4.1 / 4.3：可见编辑器塌缩的**复现探针**。
 *
 * ## 为什么要单独一个探针（评审 2026-10-06 的直接教训）
 *
 * 评审在 04/07 的 DOM 里看到「另有一个 0×0 Monaco 元素，同时两侧编辑器正常显示」，
 * 于是写下「单凭选择器命中某个零尺寸节点不能确认可见编辑器塌缩」。这句话是本探针
 * 的全部存在理由：**monaco 0.56 在页面里合法地存在零尺寸节点**——
 *   - `DiffEditor` 的 inline 档保留两层 `.editor`，窄的那层（约 36px）是隐藏侧；
 *   - EditContext 模式的隐藏输入面 `DIV.native-edit-context` / `ime-text-area` 尺寸为 0；
 *   - 被替换的 lazy 实例可能短暂留 0×0 壳。
 * 因此「`document.querySelector('.monaco-editor')` 宽 0」是**假缺陷**的经典形态。
 *
 * ## 判据（可见性优先，尺寸其次）
 *
 * 一个锚点宿主算「可见活动编辑器」必须**同时**满足：
 *   1. **可寻址**：命中我们自己打的 `data-monaco-host`，不扫全页 `.monaco-editor`
 *      ——全页扫必然命中隐藏 helper；
 *   2. **宿主自身有框**：`offsetWidth>0 && offsetHeight>0`（`offset*` 对 `display:none`
 *      的祖先返回 0，且不受 CSS transform 影响）；
 *   3. **祖先链无塌断点**：逐级向上，第一个「塌断点」= 祖先 offset 为 0 /
 *      `display:none` / `visibility:hidden`；
 *   4. **在视口内**：与视口矩形有实际交集；
 *   5. **内容可读**：`.monaco-scrollable-element.editor-scrollable .view-lines`
 *      （0.56 的可见面在 `.editor.original/.modified` 包裹层上，其内层
 *      `.monaco-editor` 已退化成 5px 尺寸探针，读它是伪空值）。
 *
 * 1–4 全过而 5 不过 ⇒ `visibleButEmpty`；连 2 都不过 ⇒ 归 `hiddenHelpers`，
 * **不得**记成塌缩。
 *
 * ## 真实窗口 vs CDP Emulation（不可混同）
 *
 * 每份快照带 `viewportSource`。spec/design 要求「CDP Emulation 不代替人工视口验收」
 * ⇒ 探针在 emulation 生效期间只记 `emulated`，退出时由调用方清 override。
 * `markEmulation(call, on)` 负责置/清页内标记，判定方据此拒绝把 emulation 结果
 * 记成「真实窗口已复现」。
 *
 * ## 用法
 *
 *   node apps/desktop/scripts/editor-collapse-probe.cjs            # 对 9612 的 page target 采一份
 *
 * 场景脚本（4.3）直接 `require` 本文件的 `collect(call)` / `markEmulation(call, on)`。
 */
"use strict";

const http = require("node:http");
const { makeSession } = require("./lib/u2-cdp-util.cjs");

const CDP_PORT = Number(
  (process.argv.find((a) => a.startsWith("--port=")) ?? "--port=9612").slice(7),
);

/**
 * 列 CDP page target。
 *
 * ⚠️ **不能用 `fetch`**：本机 `HTTP_PROXY=http://127.0.0.1:12020` 会劫持 localhost
 * 请求，`fetch` 走 undici 代理 ⇒ `TypeError: fetch failed`（`UI-VERIFY.md` 记过同族坑）。
 * 走 `node:http` 直连 127.0.0.1 才通。
 */
function listPageTarget(port = CDP_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/json/list" }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        try {
          const page = JSON.parse(body).find((p) => p.type === "page");
          page ? resolve(page) : reject(new Error("no page target"));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("cdp list timeout")));
  });
}

/**
 * 页内采集脚本（字符串）。⚠️ 只能是 ASCII+转义安全的形式：注释里出现过中文会被
 * `Runtime.evaluate` 按 UTF-16 长度算错偏移（`UI-VERIFY.md` 记过 param 块被注释撕碎），
 * 故这里的注释一律英文。
 */
const COLLECTOR = `(() => {
  const RECT = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const CS = (el) => {
    const s = getComputedStyle(el);
    return {
      display: s.display, visibility: s.visibility, overflow: s.overflow,
      overflowY: s.overflowY, flex: s.flex, minWidth: s.minWidth, height: s.height,
    };
  };

  // Walk ancestors, find first break point (zero box / hidden).
  function ancestorChain(host) {
    const chain = [];
    let breakAt = null;
    let el = host.parentElement;
    while (el) {
      const ow = el.offsetWidth, oh = el.offsetHeight;
      const cs = CS(el);
      const zero = ow === 0 || oh === 0;
      const hidden = cs.display === "none" || cs.visibility === "hidden";
      const cls = typeof el.className === "string" ? el.className.slice(0, 140) : "";
      const rec = {
        tag: el.tagName.toLowerCase(), cls,
        offsetW: ow, offsetH: oh, rect: RECT(el), ...cs,
        dataAttrs: Object.fromEntries(
          Array.from(el.attributes)
            .filter(a => a.name.startsWith("data-"))
            .map(a => [a.name, String(a.value).slice(0, 60)])
        ),
        zero, hidden,
      };
      chain.push(rec);
      if (breakAt === null && (zero || hidden)) breakAt = rec;
      if (el === document.documentElement) break;
      el = el.parentElement;
    }
    return { chain, breakAt };
  }

  const hosts = Array.from(document.querySelectorAll("[data-monaco-host]"));
  const allMonaco = document.querySelectorAll(".monaco-editor").length;

  const editors = hosts.map((host) => {
    const { chain, breakAt } = ancestorChain(host);
    const r = RECT(host);
    const hostOk = host.offsetWidth > 0 && host.offsetHeight > 0;
    // Visible face lives on .editor.original / .editor.modified wrappers.
    const scrollables = Array.from(host.querySelectorAll(".monaco-scrollable-element.editor-scrollable"));
    const viewLines = scrollables.map((s) => {
      const lines = s.querySelectorAll(".view-line");
      return {
        lineCount: lines.length,
        text: Array.from(lines).slice(0, 3).map(n => n.textContent || "").join("\\n").slice(0, 300),
      };
    });
    const inViewport =
      r.w > 0 && r.h > 0 &&
      r.x < window.innerWidth && r.y < window.innerHeight &&
      (r.x + r.w) > 0 && (r.y + r.h) > 0;
    return {
      role: host.getAttribute("data-monaco-host"),
      targetKey: host.getAttribute("data-monaco-target"),
      hostRect: r, hostOffsetW: host.offsetWidth, hostOffsetH: host.offsetHeight,
      hostOk, cs: CS(host),
      ancestorCount: chain.length, ancestorBreak: breakAt,
      ancestorChainHead: chain.slice(0, 5),
      scrollableCount: scrollables.length, viewLines,
      inViewport,
      visible: hostOk && breakAt === null && inViewport,
      visibleButEmpty: hostOk && breakAt === null && inViewport && scrollables.length === 0,
    };
  });

  const anchored = new Set();
  for (const h of hosts) for (const m of Array.from(h.querySelectorAll(".monaco-editor"))) anchored.add(m);
  const hiddenHelpers = Array.from(document.querySelectorAll(".monaco-editor"))
    .filter(m => !anchored.has(m))
    .map(m => {
      const owner = m.closest("[data-monaco-host]");
      return {
        rect: RECT(m), offsetW: m.offsetWidth, offsetH: m.offsetHeight,
        zero: m.offsetWidth === 0 || m.offsetHeight === 0,
        ownedBy: owner ? owner.getAttribute("data-monaco-host") : null,
        note: "not an anchor host => per spec not a visible-collapse verdict on its own",
      };
    });

  return {
    url: location.href,
    viewport: { innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio },
    viewportSource: window.__rbEmulated === true ? "emulated" : "window",
    documentElementClientW: document.documentElement.clientWidth,
    documentElementClientH: document.documentElement.clientHeight,
    monacoEditorNodeCount: allMonaco, anchorCount: hosts.length,
    editors, hiddenHelpers,
    // Collapse = an anchor host that SHOULD be visible but is not.
    collapsed: editors.filter(e => e.hostOk && e.ancestorBreak !== null && !e.inViewport),
  };
})()`;

/** 采一份快照（传入 u2-cdp-util 的 call）。 */
async function collect(call) {
  const r = await call("Runtime.evaluate", { expression: COLLECTOR, returnByValue: true });
  if (r?.exceptionDetails)
    throw new Error(`probe eval failed: ${JSON.stringify(r.exceptionDetails)}`);
  return r?.result?.value;
}

/**
 * 置/清页内 emulation 标记。**只改标记，不改视口**——真实改窗走 OS 层
 * （`setWindowOuter`），Emulation 与真实窗口必须在证据里分开记。
 */
async function markEmulation(call, on) {
  await call("Runtime.evaluate", {
    expression: `(() => { ${on ? "window.__rbEmulated = true;" : "delete window.__rbEmulated;"} return true; })()`,
    returnByValue: true,
  });
}

/** 一行摘要，给场景脚本的 check() 用。 */
function summarize(snap) {
  const vis = snap.editors.filter((e) => e.visible).length;
  const hostless = snap.editors.filter((e) => !e.hostOk).length;
  const empty = snap.editors.filter((e) => e.visibleButEmpty).length;
  return (
    `viewport=${snap.viewportSource} ${snap.viewport.innerW}x${snap.viewport.innerH}` +
    ` anchors=${snap.anchorCount} visible=${vis} hostless=${hostless} visibleButEmpty=${empty}` +
    ` hiddenHelpers=${snap.hiddenHelpers.length} monacoNodes=${snap.monacoEditorNodeCount}`
  );
}

module.exports = { COLLECTOR, collect, markEmulation, summarize, listPageTarget };

if (require.main === module) {
  (async () => {
    const page = await listPageTarget();
    const call = await makeSession(page.webSocketDebuggerUrl);
    const snap = await collect(call);
    console.log(JSON.stringify(snap, null, 2));
    console.error(summarize(snap));
    process.exit(0);
  })().catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
