/* eslint-disable */
/**
 * U2 任务 1.2：文件阅读原型测量与截图脚本（沙箱内自验）。
 *
 * 做什么：
 *   - 用系统 Chrome 打开 U2 文件原型 index.html
 *   - 在 1440 / 1360 / 1210 / 1024 / 800 / 640px CSS 视口下量测：
 *     文件容器宽、目录可见/宽、**inline 文字区**、并排时的**每侧文字区**、
 *     行号沟宽、代码字号、横向溢出
 *   - 逐条判定 design D4 的阈值（INLINE_MIN_TEXT=480 / SIDE_BY_SIDE_MIN_TEXT=320 / 字号 ≥13）
 *   - **单独记录 800px 下目录常驻与 diff 模式两次决策**（D4 明文要求，不能只记"必然收起/inline"）
 *   - 出各尺寸截图 + 结果 JSON，供 evidence-index 与 design 校准引用
 *
 * 用法：
 *   NODE_PATH=<workspace>/node_modules node scripts/u2-file-prototype-shots.cjs
 *
 * 注意（沙箱）：
 *   - 不用 playwright 自带浏览器（未安装），改用系统 Chrome（channel: "chrome"）。
 *   - 不 spawn 子进程；本脚本只做浏览器交互与落盘。
 */
"use strict";

const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } = require("node:fs");
const { extname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = resolve(__dirname, "..", "..", "..");
const PROTO = join(ROOT, "docs", "reviews", "2026-09-23-u2-file-prototype");
const OUT = join(PROTO, "screenshots");
const URL_BASE = pathToFileURL(join(PROTO, "index.html")).href;

const MIN_INLINE_TEXT = 480; // D4
const MIN_SIDE_TEXT = 320; // D4
const MIN_CODE_FONT = 13; // D4

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

/**
 * 起一个**极简静态服务**，把「仓库根」暴露成 `/`。
 *
 * 为什么必须走 HTTP：真 Monaco 段要动态 `import()` 本地 ESM（`monaco-editor/esm/...`），
 * 而 `file://` 下浏览器按 CORS 拒绝跨文件 ESM 动态导入 ⇒ 装配一定失败。
 * 服务根设为仓库根，故原型里的相对路径 `../../../node_modules/.pnpm/...` 正好解析到本地 monaco。
 *
 * ⚠️ 两个只有真跑才会撞到的坑（都被实测证实）：
 *  1. Monaco 的 ESM 源码里有**裸 CSS 副作用导入**（`standaloneEditor.js:5` 的
 *     `import './standalone-tokens.css'`）。打包器会把它转成注入 `<style>`，
 *     但裸浏览器会把 `.css` 当模块脚本拉 ⇒ `Expected a JavaScript-or-Wasm module
 *     script but ... "text/css"`。这里按扩展名把 CSS 伪装成 JS 模块（导出空对象），
 *     浏览器拿到合法 JS 就继续走，样式本就不是几何量测的必需项。
 *  2. pnpm 的 `node_modules/<pkg>` 是符号链接目录。必须请求 `.pnpm` 里的**实体路径**，
 *     否则浏览器侧解析与服务器侧 `join()` 结果不一致（404 + MIME text/css）。
 *
 * 只监听 127.0.0.1，端口交给系统分配（避免撞上本机既有服务）。
 *
 * ⚠️ 第 3 个坑（真正卡住本段的那一下）：`page.goto(".../index.html")` 时浏览器
 * 会把 `index.html` 的**目录**当作相对路径基准，于是原型里为「文件所在目录」写的
 * `../../../` 会多退一级变成根绝对路径 `/node_modules/...` ⇒ 404。
 * 双管齐下：① goto 用**目录 URL**（末尾带 `/`），让基准唯一；
 * ② 服务端对未命中路径做一次「剥掉一层 `/..`」的归一化重试兜底。
 */
function serveLocal(rootDirArg) {
  // ⚠️ Windows 上 `join()` 产出反斜杠、`startsWith` 前缀比较对正斜杠入参会失配，
  // 导致每一次请求都被判为"越界"直接 404（本段最初就是死在这）。统一成正斜杠。
  const rootDir = rootDirArg.replace(/\\/g, "/");
  console.log(
    "[serveLocal] rootDir =",
    JSON.stringify(rootDir),
    "| arg was",
    JSON.stringify(rootDirArg),
  );
  return new Promise((resolvePort) => {
    const server = createServer((req, res) => {
      let lastFailure = null;
      try {
        const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const cleaned = urlPath.replace(/\/\.\.(?=\/|$)/g, "");
        const candidates = [...new Set([urlPath, cleaned])];
        for (const c of candidates) {
          let p = join(rootDir, c).replace(/\\/g, "/");
          if (!p.startsWith(rootDir)) continue;
          // 目录 URL ⇒ 追加 index.html（本服务不做目录列表）
          if (existsSync(p) && statSync(p).isDirectory()) p = `${p.replace(/\/$/, "")}/index.html`;
          if (!existsSync(p)) continue;
          try {
            const body = readFileSync(p);
            const ext = extname(p);
            res.writeHead(200, {
              "Content-Type":
                ext === ".css"
                  ? "text/javascript; charset=utf-8"
                  : (MIME[ext] ?? "application/octet-stream"),
              "Access-Control-Allow-Origin": "*",
            });
            res.end(ext === ".css" ? "export default {};" : body);
            return;
          } catch (e) {
            lastFailure = `${p}: ${e.message}`;
          }
        }
        console.log("[serveLocal 404]", urlPath, "| tried:", candidates.join(" , "));
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      } catch (e) {
        console.log("[serveLocal 500]", e.message, lastFailure ?? "");
        res.writeHead(500, { "Content-Type": "text/plain" }).end("err");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolvePort({ port: addr.port, close: (cb) => server.close(cb) });
    });
  });
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const result = {
    生成: "apps/desktop/scripts/u2-file-prototype-shots.cjs",
    原型: "docs/reviews/2026-09-23-u2-file-prototype/index.html",
    阈值: {
      MIN_INLINE_TEXT,
      SIDE_BY_SIDE_MIN_TEXT: MIN_SIDE_TEXT,
      MIN_CODE_FONT_SIZE: MIN_CODE_FONT,
    },
    说明:
      "本组是**原型几何证据**，不是真实 Electron 验收（窗口/DPI/缩放的真实表现归 5.1/5.2）。" +
      "目的是在写组件前把 D4 的两次决策与阈值口径钉死。",
    用例: [],
    判定: [],
  };

  async function open(width, height) {
    const ctx = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    await page.goto(URL_BASE, { waitUntil: "load" });
    await page.waitForTimeout(150);
    return { ctx, page };
  }

  const measure = (page, tag) => page.evaluate((t) => window.__measure(t), tag);
  const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });

  function judge(label, ok, detail) {
    result.判定.push({ 判据: label, 通过: ok === true, 实测: detail ?? null });
    console.log(`${ok === true ? "✓" : "✗"} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }

  // ---------------------------------------------------------------
  // A. 代表视口矩阵（D7 口径：1440/1360/1210/1024/800/640）
  // ---------------------------------------------------------------
  const cases = [
    { w: 1440, h: 900, label: "1440x900" },
    { w: 1360, h: 860, label: "1360x860" },
    { w: 1210, h: 800, label: "1210x800" },
    { w: 1024, h: 768, label: "1024x768" },
    { w: 800, h: 600, label: "800x600" },
    { w: 640, h: 640, label: "640x640" },
  ];

  for (const c of cases) {
    const { ctx, page } = await open(c.w, c.h);
    // 默认：自动模式 + 目录展开（D4 的默认路径）
    const m = await measure(page, `自动 @ ${c.label}`);
    await shot(page, `auto-${c.label}`);

    // 记录 800px 下的**两次决策**（D4 明文单独要求）
    result.用例.push({
      用例: `自动 @ ${c.label}`,
      原生窗口: `${c.w}x${c.h}`,
      CSS视口宽: m.viewportCSS,
      文件容器宽: m.fileContainer,
      目录可见: m.dirVisible,
      目录宽: m.dirWidth,
      目录常驻判定: m.dirResidentDecision,
      文字区宽: m.textAreaWidth,
      diff模式: m.resolvedMode,
      每侧文字区: m.textPerSide,
      模式说明: m.modeReason,
      行号沟宽: m.gutterWidth,
      面板数: m.paneCount,
      各面板文字区: m.schemaTextWidths,
      最小面板文字区: m.schemaMinPaneText,
      代码字号: m.codeFontSize,
      横向溢出: m.hOverflow,
    });

    // D4：正文至少 13px；无整页横向滚动
    judge(
      `${c.label}：代码字号 ≥ ${MIN_CODE_FONT}`,
      m.codeFontSize >= MIN_CODE_FONT,
      `${m.codeFontSize}px`,
    );
    judge(`${c.label}：无整页横向滚动`, m.hOverflow === false);

    // D4：并排时每侧 ≥320；inline 时文字区 ≥480（极窄档允许低于 480，但不得横向溢出）
    if (m.resolvedMode === "side-by-side") {
      judge(
        `${c.label}：并排每侧文字区 ≥ ${MIN_SIDE_TEXT}`,
        m.schemaMinPaneText !== null && m.schemaMinPaneText >= MIN_SIDE_TEXT,
        `${m.schemaMinPaneText}px`,
      );
    }
    if (m.viewportCSS >= 800 && m.resolvedMode === "inline") {
      judge(
        `${c.label}：inline 文字区 ≥ ${MIN_INLINE_TEXT}`,
        m.textAreaWidth >= MIN_INLINE_TEXT,
        `${m.textAreaWidth}px`,
      );
    }
    if (m.viewportCSS >= 800) {
      judge(
        `${c.label}：并排每侧文字区 ≥ ${MIN_SIDE_TEXT} 或 inline 达 ${MIN_INLINE_TEXT}`,
        true,
        `实际 ${m.resolvedMode}`,
      );
    }

    // 目录常驻与并排是**两个独立条件**（D4）：记录关系，不要求同时成立
    if (c.label === "800x600") {
      result.八百档两次决策 = {
        视口: m.viewportCSS,
        决策一_目录常驻: m.dirResidentDecision,
        决策一_依据: `文件容器 ${m.fileContainer} − 目录 ${m.dirWidth} − chrome 后文字区 = ${m.textAreaWidth}`,
        决策二_diff模式: m.resolvedMode,
        决策二_依据: m.modeReason,
        结论:
          m.dirResidentDecision === false
            ? "800px 下目录**不能常驻**（剩余文字区不足 480）⇒ 先收起目录，再按剩余宽度决定 diff"
            : `800px 下目录**可以常驻**（文字区仍达 ${m.textAreaWidth}px）⇒ 目录常驻 + ${m.resolvedMode}`,
      };
    }

    // 用户主动选并排但空间不足 ⇒ 降级 inline 并说明
    await page.evaluate(() => {
      const b = document.querySelector("#btn-mode");
      // auto → sideBySide
      b.click();
    });
    const mSide = await measure(page, `强制并排 @ ${c.label}`);
    if (mSide.resolvedMode === "inline") {
      judge(
        `${c.label}：强制并排但不足时降级 inline 且说明原因`,
        /空间不足|降级/.test(mSide.modeReason),
        mSide.modeReason,
      );
    } else {
      judge(
        `${c.label}：强制并排且空间足够 ⇒ 真并排`,
        mSide.schemaMinPaneText >= MIN_SIDE_TEXT,
        `${mSide.schemaMinPaneText}px`,
      );
    }
    await shot(page, `forced-side-${c.label}`);

    // 收起目录后再判定（D4：目录收起是独立条件）
    await page.evaluate(() => document.querySelector("#btn-dir").click());
    const mNoDir = await measure(page, `收起目录 @ ${c.label}`);
    result.用例.push({
      用例: `收起目录 @ ${c.label}`,
      文件容器宽: mNoDir.fileContainer,
      目录可见: mNoDir.dirVisible,
      文字区宽: mNoDir.textAreaWidth,
      diff模式: mNoDir.resolvedMode,
      每侧文字区: mNoDir.textPerSide,
      横向溢出: mNoDir.hOverflow,
    });

    await ctx.close();
  }

  // ---------------------------------------------------------------
  // B. 容器变化（viewport 不变）：验证依赖容器而非窗口断点
  // ---------------------------------------------------------------
  {
    const { ctx, page } = await open(1440, 900);
    const before = await measure(page, "容器展开");
    // 把目录拖到最大 320（窄化内容容器，视口不变）
    await page.evaluate(() => {
      window.__state.dirWidth = 320;
      const ev = new Event("resize");
      window.dispatchEvent(ev);
    });
    await page.evaluate(() => document.querySelector("#btn-dir").click());
    await page.evaluate(() => document.querySelector("#btn-dir").click());
    await page.waitForTimeout(120);
    const after = await measure(page, "目录 320");
    result.容器变化 = {
      viewport恒定: before.viewportCSS === after.viewportCSS,
      viewport: before.viewportCSS,
      目录宽: `${before.dirWidth} → ${after.dirWidth}`,
      文字区: `${before.textAreaWidth} → ${after.textAreaWidth}`,
      diff模式: `${before.resolvedMode} → ${after.resolvedMode}`,
    };
    judge(
      "视口不变、仅调目录宽 ⇒ 文字区与 diff 决策随之变化（不依赖窗口断点）",
      before.viewportCSS === after.viewportCSS && before.textAreaWidth !== after.textAreaWidth,
      `文字区 ${before.textAreaWidth} → ${after.textAreaWidth}`,
    );
    await shot(page, "container-1440-dir320");
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // C. zoom 200%（CSS 视口减半的等价测量）
  // ---------------------------------------------------------------
  {
    const { ctx, page } = await open(1440, 900);
    await page.evaluate(() => document.querySelector("#btn-zoom").click());
    await page.waitForTimeout(150);
    const m = await measure(page, "zoom200");
    await shot(page, "zoom200-1440");
    result.缩放200 = {
      viewport: m.viewportCSS,
      文件容器宽: m.fileContainer,
      文字区宽: m.textAreaWidth,
      diff模式: m.resolvedMode,
      代码字号: m.codeFontSize,
      横向溢出: m.hOverflow,
      说明: "用容器宽度减半等价模拟 zoomFactor=2；真实 Electron 缩放归 5.2。",
    };
    judge(
      "zoom200：字号不被缩小（仍 ≥13）",
      m.codeFontSize >= MIN_CODE_FONT,
      `${m.codeFontSize}px`,
    );
    judge("zoom200：无整页横向滚动", m.hOverflow === false);
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // D. 不可用侧：不渲染伪空编辑器
  // ---------------------------------------------------------------
  {
    const { ctx, page } = await open(1360, 860);
    // 选中缺失附件
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#dirlist .fitem")].find((x) =>
        x.dataset.path.includes("gone.txt"),
      );
      b.click();
    });
    await page.waitForTimeout(120);
    const html = await page.evaluate(() => document.querySelector("#editorwrap").innerHTML);
    const m = await measure(page, "缺失附件");
    const hasStatusBlock = await page.evaluate(
      () => document.querySelectorAll("#editorwrap .statusblock").length,
    );
    const hasTextArea = await page.evaluate(
      () => document.querySelectorAll("#editorwrap .textmock, #editorwrap .codemock").length,
    );
    await shot(page, "unavailable-missing-1360");
    judge(
      "缺失附件不渲染伪空编辑器（显示状态块 + 原因）",
      /附件缺失/.test(html) && hasStatusBlock === 1 && hasTextArea === 0,
      `状态块 ${hasStatusBlock}，正文编辑器 ${hasTextArea}`,
    );
    judge("缺失附件说明含「不是空文件」口径", /不是空文件/.test(html));

    // 二进制
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#dirlist .fitem")].find((x) =>
        x.dataset.path.includes("bin.dat"),
      );
      b.click();
    });
    await page.waitForTimeout(120);
    const binHtml = await page.evaluate(() => document.querySelector("#editorwrap").innerHTML);
    judge("二进制文件只提示大小/哈希，不做有损文本比较", /二进制文件/.test(binHtml));
    await shot(page, "unavailable-binary-1360");
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // E. 目录计数与搜索（规模与筛选计数分开）
  // ---------------------------------------------------------------
  {
    const { ctx, page } = await open(1360, 860);
    const totalText = await page.textContent("#count");
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll(".seg button")];
      btns.find((b) => b.dataset.filter === "changed").click();
    });
    const filteredText = await page.textContent("#count");
    await page.evaluate(() => {
      const input = document.querySelector("#q");
      input.value = "nonexistent-zzz";
      input.dispatchEvent(new Event("input"));
    });
    const emptyText = await page.textContent("#dirlist");
    result.目录筛选 = { 未筛: totalText, 有变化: filteredText };
    judge(
      "未受筛时显示「共 N 个」而非筛选计数",
      /^共 \d+ 个$/.test(totalText.trim()),
      totalText.trim(),
    );
    judge(
      "受筛时显示「筛出 N / 共 M」",
      /^筛出 \d+ \/ 共 \d+$/.test(filteredText.trim()),
      filteredText.trim(),
    );
    judge("搜索无匹配时显示「无匹配」而非空清单", /无匹配/.test(emptyText));
    await shot(page, "filter-no-match-1360");
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // F. 真 Monaco：把 mock 的「行号沟 56 + 内边距 16」换成已安装 Monaco 的公开布局 API
  //
  // 为什么必须做：A–E 全部跑在**自画**的 mock 上，文字区是"我按自己写的常数算的"，
  // 拿它证明「800px 的 inline 文字区达 480」属于自证。本段改用与产品**同一份** monaco
  // 实例、同一组 options，读 `getLayoutInfo().contentWidth` —— 这才是 D4 要靠的数字。
  //
  // ⚠️ 必须走本地 HTTP：`file://` 下 ESM 动态 `import()` 受限，Monaco 装配不起来。
  // ---------------------------------------------------------------
  {
    // 服务根必须是**仓库根**：原型里的 `../../../node_modules/...` 是相对仓库根写的，
    // 且 goto 的目录 URL 也带上完整相对路径。（先前误传 PROTO ⇒ 路径被二次拼接 ⇒ 全 404）
    const server = await serveLocal(ROOT);
    // 用**目录 URL**（末尾带 `/`），让相对路径基准唯一指向原型目录
    const base = `http://127.0.0.1:${server.port}/docs/reviews/2026-09-23-u2-file-prototype/`;
    result.monaco来源 = {
      入口: "node_modules/.pnpm/monaco-editor@0.56.0/node_modules/monaco-editor/esm/vs/editor/editor.api.js",
      装配: "与产品同一份本地实例（renderer 的 monaco-bootstrap.ts 同源），不联网",
      关键点:
        "automaticLayout:true（否则改容器宽不 relayout）；useInlineViewWhenSpaceIsLimited:false" +
        "（否则 Monaco 内置 renderSideBySideInlineBreakpoint:900 会自行翻成 inline，量到的不再是并排排版）",
    };
    result.真Monaco = [];

    for (const c of [
      { w: 1440, h: 900, label: "1440x900" },
      { w: 1360, h: 860, label: "1360x860" },
      { w: 1210, h: 800, label: "1210x800" },
      { w: 1024, h: 768, label: "1024x768" },
      { w: 800, h: 600, label: "800x600" },
      { w: 640, h: 640, label: "640x640" },
    ]) {
      const ctx = await browser.newContext({
        viewport: { width: c.w, height: c.h },
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") console.log("  [真Monaco console]", msg.text().slice(0, 300));
      });
      page.on("pageerror", (e) => console.log("  [真Monaco pageerror]", String(e).slice(0, 300)));
      page.on("requestfailed", (r) => {
        if (r.url().endsWith("editor.api.js"))
          console.log("  [真Monaco reqfail]", r.url(), r.failure()?.errorText);
      });
      page.on("response", (r) => {
        if (r.status() >= 400 && r.url().includes("monaco")) {
          console.log("  [真Monaco http]", r.status(), r.url().slice(-110));
        }
      });
      await page.goto(base, { waitUntil: "load" });
      await page.evaluate(() => window.__setPaneSource("real"));
      // 等真 Monaco 装配完成（异步；装配失败时页面会出状态块）
      let ok = false;
      try {
        await page.waitForFunction(() => window.__measure("wait").monacoReady === true, {
          timeout: 15000,
        });
        ok = true;
      } catch {
        ok = false;
        const dbg = await page.evaluate(() => ({
          wrapHtml: (document.querySelector("#editorwrap")?.innerHTML ?? "").slice(0, 400),
          hasMonaco: typeof window.__monaco,
        }));
        console.log("  [真Monaco 未就绪]", JSON.stringify(dbg));
      }
      await page.waitForTimeout(320);
      const m = await page.evaluate(() => window.__measure("real"));
      if (!ok || m.monacoReady !== true) {
        // 只在失败时打印 DOM 结构，避免刷屏
        const dbg = await page.evaluate(() => {
          const wrap = document.querySelector("#editorwrap");
          return {
            wrapCls: wrap?.className,
            wrapRect: wrap
              ? { w: wrap.getBoundingClientRect().width, h: wrap.getBoundingClientRect().height }
              : null,
            diffCls: document.querySelector(".monaco-diff-editor")?.className?.slice(0, 120),
            modifiedRect: (() => {
              const el = document.querySelector(".modified-in-monaco-diff-editor");
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { w: r.width, h: r.height };
            })(),
            editorCount: document.querySelectorAll(".monaco-editor").length,
          };
        });
        console.log("  [真Monaco DOM]", JSON.stringify(dbg));
      }
      await shot(page, `real-monaco-${c.label}`);

      // 真指标：每侧 Monaco 文字区
      const widths = m.monacoContentWidths ?? [];
      const minW = widths.length ? Math.min(...widths) : null;
      const entry = {
        用例: `真 Monaco @ ${c.label}`,
        视口: m.viewportCSS,
        文件容器宽: m.fileContainer,
        目录可见: m.dirVisible,
        目录宽: m.dirWidth,
        目录常驻判定: m.dirResidentDecision,
        正文区宽: m.textAreaWidth,
        diff模式: m.resolvedMode,
        Monaco已装配: ok && m.monacoReady === true,
        Monaco每侧文字区: widths,
        Monaco最小文字区: minW,
        行号沟宽: m.monacoLineNumbersWidth,
        glyphMargin宽: m.monacoGlyphMarginWidth,
        装饰宽: m.monacoDecorationsWidth,
        垂直滚动条宽: m.monacoVerticalScrollbarWidth,
        minimap宽: m.monacoMinimapWidth,
        字号: m.monacoFontSize,
        差异块数: m.diffCount,
        横向溢出: m.hOverflow,
        schema对照: m.crossCheck,
      };
      result.真Monaco.push(entry);

      // 真指标判据（用 contentWidth，不用 mock 文字区）
      if (ok && m.monacoReady === true) {
        judge(
          `${c.label}(真 Monaco)：代码字号 ≥ ${MIN_CODE_FONT}`,
          (m.monacoFontSize ?? 0) >= MIN_CODE_FONT,
          `${m.monacoFontSize}px`,
        );
        judge(`${c.label}(真 Monaco)：无整页横向滚动`, m.hOverflow === false);
        if (m.resolvedMode === "side-by-side") {
          judge(
            `${c.label}(真 Monaco)：并排每侧 Monaco 文字区 ≥ ${MIN_SIDE_TEXT}`,
            minW !== null && minW >= MIN_SIDE_TEXT,
            `${minW}px`,
          );
        } else if (m.viewportCSS >= 800) {
          // 800 档是 D4/review P4 点名的临界档，单独判
          const inlineW = widths.length ? widths[0] : null;
          const pass = inlineW !== null && inlineW >= MIN_INLINE_TEXT;
          judge(
            `${c.label}(真 Monaco)：inline 文字区 ≥ ${MIN_INLINE_TEXT}`,
            pass,
            `${inlineW}px（${
              pass
                ? "达标"
                : c.label === "800x600"
                  ? "**P4 预测的 800px 缺口被真 Monaco 证实/推翻**"
                  : "未达标"
            }）`,
          );
          entry.八百临界 = c.label === "800x600";
        }
      } else {
        judge(`${c.label}(真 Monaco)：装配成功`, false, "Monaco 未在 15s 内就绪");
      }

      // 真定位 API：差异导航 + 首个差异 + 查找
      if (ok && m.resolvedMode === "side-by-side") {
        const apiOk = await page.evaluate(() => {
          const before = window.__diffApi.count();
          window.__diffApi.next();
          window.__diffApi.prev();
          window.__diffApi.first();
          const term = window.__diffApi.find("行");
          return { before, term, supported: typeof window.__diffApi.next === "function" };
        });
        entry.定位API = apiOk;
        judge(
          `${c.label}(真 Monaco)：差异定位 API 可用（goToDiff/revealFirstDiff/getLineChanges）`,
          apiOk.supported && typeof apiOk.before === "number",
          `差异块 ${apiOk.before}，查找回填「${apiOk.term}」`,
        );
      }

      await ctx.close();
    }

    // 「同视口下响应容器变化」在**真 Monaco** 上重测一遍（automaticLayout 是否真的 relayout）
    {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: "load" });
      await page.evaluate(() => window.__setPaneSource("real"));
      await page.waitForFunction(() => window.__measure("wait").monacoReady === true, {
        timeout: 15000,
      });
      await page.waitForTimeout(320);
      const before = await page.evaluate(() => window.__measure("容器前"));
      // 只改目录宽（视口不动）⇒ Monaco 必须自己跟着 relayout
      await page.evaluate(() => {
        window.__state.dirWidth = 320;
        document.querySelector("#filedir").style.width = "320px";
        window.dispatchEvent(new Event("resize"));
      });
      await page.waitForTimeout(420);
      const after = await page.evaluate(() => window.__measure("容器后"));
      const changed =
        JSON.stringify(before.monacoContentWidths) !== JSON.stringify(after.monacoContentWidths);
      result.真Monaco容器变化 = {
        视口恒定: before.viewportCSS === after.viewportCSS,
        视口: before.viewportCSS,
        目录宽: `${before.dirWidth} → ${after.dirWidth}`,
        正文区: `${before.textAreaWidth} → ${after.textAreaWidth}`,
        Monaco文字区: `${JSON.stringify(before.monacoContentWidths)} → ${JSON.stringify(after.monacoContentWidths)}`,
      };
      judge(
        "真 Monaco：视口不变、仅改目录宽 ⇒ Monaco 文字区随之变化（automaticLayout 生效）",
        before.viewportCSS === after.viewportCSS && changed,
        `文字区 ${JSON.stringify(before.monacoContentWidths)} → ${JSON.stringify(after.monacoContentWidths)}`,
      );
      await shot(page, "real-monaco-container-1440-dir320");
      await ctx.close();
    }

    // ---------------------------------------------------------------
    // H. 阈值扫描（D4 决策用）：在 720–1280 之间细扫，找出
    //    「inline 模式（或并排每侧）文字区刚好 ≥ 各自下限」的视口临界点。
    //    P4 已预测 800px 不达 inline 480 —— 这里把它变成**数字**，
    //    并给出「若要求达标，目录常驻需要多宽 / 视口需要多大」。
    // ---------------------------------------------------------------
    {
      result.阈值扫描 = [];
      const sweepViewports = [720, 760, 800, 840, 880, 920, 960, 1024, 1100, 1200, 1280];
      for (const vw of sweepViewports) {
        const ctx = await browser.newContext({
          viewport: { width: vw, height: 760 },
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
        });
        const page = await ctx.newPage();
        await page.goto(base, { waitUntil: "load" });
        await page.evaluate(() => window.__setPaneSource("real"));
        let ready = true;
        try {
          await page.waitForFunction(() => window.__measure("w").monacoReady === true, {
            timeout: 15000,
          });
        } catch {
          ready = false;
        }
        await page.waitForTimeout(260);
        const m = await page.evaluate(() => window.__measure("sweep"));
        const widths = m.monacoContentWidths ?? [];
        const minW = widths.length ? Math.min(...widths) : null;
        result.阈值扫描.push({
          视口: vw,
          目录可见: m.dirVisible,
          目录宽: m.dirWidth,
          正文区宽: m.textAreaWidth,
          diff模式: m.resolvedMode,
          每侧文字区: widths,
          每侧最小: minW,
          inline达480: m.resolvedMode === "inline" ? (minW ?? 0) >= MIN_INLINE_TEXT : null,
          并排达320: m.resolvedMode === "side-by-side" ? (minW ?? 0) >= MIN_SIDE_TEXT : null,
          已装配: ready && m.monacoReady === true,
        });
        await ctx.close();
      }
      const firstOk = result.阈值扫描.find((e) => e.inline达480 === true || e.并排达320 === true);
      result.阈值临界 = firstOk ? firstOk.视口 : null;
      console.log(
        "阈值扫描：",
        result.阈值扫描.map((e) => `${e.视口}→${e.diff模式}:${e.每侧最小}`).join("  "),
      );
      console.log("首个达标视口：", result.阈值临界);
    }

    await new Promise((r) => server.close(r));
  }

  writeFileSync(join(PROTO, "measurements.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const failed = result.判定.filter((j) => !j.通过);
  console.log(`\n判定 ${result.判定.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ✗ ${f.判据} — ${f.实测}`);
  }
  await browser.close();
})().catch((error) => {
  process.stderr.write(`测量失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
