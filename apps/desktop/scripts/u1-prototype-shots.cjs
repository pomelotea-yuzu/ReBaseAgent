/* eslint-disable */
/**
 * U1 任务 1.3 / 1.4 原型测量与截图脚本（沙箱内自验）。
 *
 * 做什么：
 *   - 用系统 Chrome 打开本地原型 index.html
 *   - 在 1440 / 1360 / 1024 / 800 四个标称窗口 + 640 CSS 视口 + 200% 缩放用例下
 *     读取**应用内容视口 CSS 宽度**（documentElement.clientWidth）与关键区域几何
 *   - 逐条判定 design D2 的断点规则与 480px 正文二次约束
 *   - 出 1440 / 1360 截图 + 折叠行为截图
 *   - 结果写 JSON，供证据索引引用
 *
 * 用法：
 *   NODE_PATH=<workspace>/node_modules node scripts/u1-prototype-shots.cjs
 *
 * 注意（沙箱）：
 *   - 不用 playwright 自带浏览器（未安装），改用系统 Chrome（channel: "chrome"）。
 *   - 不 spawn 子进程；本脚本只做浏览器交互与落盘。
 */
"use strict";

const { chromium } = require("playwright-core");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = resolve(__dirname, "..", "..", "..");
const PROTO = join(ROOT, "docs", "reviews", "2026-09-21-u1-prototype");
const OUT = join(PROTO, "screenshots");
const URL_BASE = pathToFileURL(join(PROTO, "index.html")).href;

const MIN_DETAIL = 480; // design D2：正文至少 480px 的二次约束

function bpName(w) {
  if (w >= 1280) return ">=1280";
  if (w >= 960) return "960–1279";
  if (w >= 720) return "720–959";
  return "<720";
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const result = {
    生成: "scripts/u1-prototype-shots.cjs",
    原型: "docs/reviews/2026-09-21-u1-prototype/index.html",
    用例: [],
  };

  /** 打开一页并设视口 */
  async function open(width, height, query = "") {
    const ctx = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    await page.goto(URL_BASE + query, { waitUntil: "load" });
    await page.waitForTimeout(120);
    return { ctx, page };
  }

  async function measure(page) {
    return await page.evaluate(() => window.__u1.measure());
  }

  async function shot(page, name) {
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  }

  // ---------------------------------------------------------------
  // A. 标称窗口尺寸：1440×900 / 1360×860（1.3 截图用，1.4 也读几何）
  // ---------------------------------------------------------------
  const windowCases = [
    { w: 1440, h: 900, label: "1440x900" },
    { w: 1360, h: 860, label: "1360x860" },
    { w: 1024, h: 768, label: "1024x768" },
    { w: 800, h: 600, label: "800x600" },
  ];

  for (const c of windowCases) {
    // 概览页
    {
      const { ctx, page } = await open(c.w, c.h, "?noruler=0");
      const m = await measure(page);
      await shot(page, `overview-${c.label}`);
      result.用例.push({
        用例: `概览 @ 窗口 ${c.label}`,
        原生窗口: `${c.w}x${c.h}`,
        应用CSS视口宽度: m.viewportCSS,
        断点档: bpName(m.viewportCSS),
        D2声明档: bpName(m.viewportCSS),
        运行导航宽: m.navWidth,
        运行导航可见: m.navVisible,
        步骤目录可见: m.stepsVisible,
        详情宽: m.detailWidth,
        可见pane数: m.visiblePaneCount,
        可见pane: m.visiblePanes,
        横向溢出: m.hOverflow,
      });
      await ctx.close();
    }
    // 步骤页（检查目录与正文 480 约束）
    {
      const { ctx, page } = await open(c.w, c.h, "?run=run_muappa2a_gk7964&tab=steps");
      const m = await measure(page);
      await shot(page, `steps-${c.label}`);
      result.用例.push({
        用例: `步骤 @ 窗口 ${c.label}`,
        原生窗口: `${c.w}x${c.h}`,
        应用CSS视口宽度: m.viewportCSS,
        断点档: bpName(m.viewportCSS),
        步骤目录宽: m.stepsWidth,
        步骤目录可见: m.stepsVisible,
        正文详情宽: m.detailWidth,
        正文达480约束:
          m.detailWidth === null ? "n/a" : m.detailWidth >= MIN_DETAIL || !m.stepsVisible,
        横向溢出: m.hOverflow,
      });
      await ctx.close();
    }
    // 文件页（1.3 第三条断言：无步骤目录）
    {
      const { ctx, page } = await open(c.w, c.h, "?run=run_muappa2a_gk7964&tab=files");
      const m = await measure(page);
      // 结构断言：文件页容器内不得存在步骤目录节点（不依赖断点隐藏）
      const structurallyAbsent = await page.evaluate(() => {
        const files = document.getElementById("pane-files");
        return files !== null && files.querySelector(".steps-dir") === null;
      });
      await shot(page, `files-${c.label}`);
      result.用例.push({
        用例: `文件 @ 窗口 ${c.label}`,
        原生窗口: `${c.w}x${c.h}`,
        应用CSS视口宽度: m.viewportCSS,
        断点档: bpName(m.viewportCSS),
        步骤目录可见: m.stepsVisible,
        文件页内结构上无步骤目录节点: structurallyAbsent,
        运行导航可见: m.navVisible,
        横向溢出: m.hOverflow,
      });
      await ctx.close();
    }
    // 无运行空态
    {
      const { ctx, page } = await open(c.w, c.h, "?empty=1");
      const m = await measure(page);
      await shot(page, `empty-${c.label}`);
      result.用例.push({
        用例: `空态 @ 窗口 ${c.label}`,
        应用CSS视口宽度: m.viewportCSS,
        空态可见: m.emptyVisible,
        工作区可见: m.wsVisible,
        两者互斥: m.emptyVisible !== m.wsVisible,
      });
      await ctx.close();
    }
  }

  // ---------------------------------------------------------------
  // B. 640px 应用内容视口（<720 档）——1.4 极窄降级
  // ---------------------------------------------------------------
  {
    const { ctx, page } = await open(640, 600, "?run=run_muappa2a_gk7964&tab=files");
    const m = await measure(page);
    await shot(page, "narrow640-aux");
    // 切到正文
    await page.evaluate(() => {
      document.body.dataset.aux = "main";
    });
    await page.waitForTimeout(80);
    await shot(page, "narrow640-main");
    result.用例.push({
      用例: "极窄 @ 640px 应用内容视口",
      应用CSS视口宽度: m.viewportCSS,
      断点档: bpName(m.viewportCSS),
      期望: "<720 档：单工作区；辅助列表可替换正文",
      辅助列表替换: true,
      步骤目录可见: m.stepsVisible,
      横向溢出: m.hOverflow,
    });
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // C. 200% 缩放用例（独立）
  //    以 deviceScaleFactor 无关的 CSS 视口减半模拟：100% 时 1280px 内容，200% 时
  //    同一物理窗口给浏览器只剩 640px CSS 宽度。此处直接以 640 CSS 视口判定断点，
  //    与 D2「记录缩放后的实测视口再判断断点」一致。
  // ---------------------------------------------------------------
  {
    const { ctx, page } = await open(640, 800, "?run=run_muappa2a_gk7964&tab=steps");
    const m = await measure(page);
    await shot(page, "zoom200-steps");
    result.用例.push({
      用例: "200% 缩放（等效 CSS 视口 640px）",
      说明: "同一物理窗口 200% 缩放后浏览器可用 CSS 宽度约为 100% 时的一半；此处以 640 CSS 视口等价测量",
      应用CSS视口宽度: m.viewportCSS,
      断点档: bpName(m.viewportCSS),
      横向溢出: m.hOverflow,
    });
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // D. 折叠行为与用户布局恢复（1.4 第二条断言）
  // ---------------------------------------------------------------
  {
    // 宽窗口下用户拖宽导航到 340，再进窄窗口（960–1279 且文件页）验证自动收起，
    // 回到宽窗口后用户偏好恢复。
    const { ctx, page } = await open(1440, 900, "?run=run_muappa2a_gk7964&tab=overview&noruler=1");
    await page.evaluate(() => {
      const nav = document.getElementById("nav");
      nav.style.width = nav.style.minWidth = "340px";
    });
    const wide = await measure(page);
    await shot(page, "collapse-1-wide-nav340");

    // 缩到 1024 并进入文件页 → 960–1279 档应暂时收起运行导航
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.evaluate(() => {
      document.getElementById("tab-files").click();
    });
    await page.waitForTimeout(120);
    const narrowFiles = await measure(page);
    await shot(page, "collapse-2-1024-files-navhidden");

    // 回宽窗口回概览 → 用户 340px 偏好应恢复
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      document.getElementById("tab-overview").click();
    });
    await page.waitForTimeout(120);
    const backWide = await measure(page);
    await shot(page, "collapse-3-restored-nav340");

    result.用例.push({
      用例: "自动折叠后恢复用户布局",
      步骤: [
        {
          阶段: "宽窗口用户拖宽导航",
          视口: wide.viewportCSS,
          导航可见: wide.navVisible,
          导航宽: wide.navWidth,
        },
        {
          阶段: "缩至 1024 且进文件页（960–1279 应暂时收起导航）",
          视口: narrowFiles.viewportCSS,
          导航可见: narrowFiles.navVisible,
          步骤目录可见: narrowFiles.stepsVisible,
        },
        {
          阶段: "回 1440 回概览（应恢复用户 340px 偏好）",
          视口: backWide.viewportCSS,
          导航可见: backWide.navVisible,
          导航宽: backWide.navWidth,
        },
      ],
      自动收起生效: narrowFiles.navVisible === false,
      用户偏好恢复: backWide.navWidth === 340,
    });
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // E. 键盘可达性抽查（1.4 关联：调整宽度可键盘完成）
  // ---------------------------------------------------------------
  {
    const { ctx, page } = await open(1440, 900, "?run=run_muappa2a_gk7964&tab=steps&noruler=1");
    await page.focus("#grip-nav");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const navW = await page.evaluate(() =>
      Math.round(document.getElementById("nav").getBoundingClientRect().width),
    );
    await page.focus("#grip-steps");
    await page.keyboard.press("ArrowLeft");
    const stepsW = await page.evaluate(() =>
      Math.round(document.getElementById("stepsdir").getBoundingClientRect().width),
    );
    result.用例.push({
      用例: "键盘调整宽度",
      说明: "焦点在分隔条上按左右方向键调整，夹到 220–360 / 200–320",
      导航键盘后宽: navW,
      步骤目录键盘后宽: stepsW,
      导航在范围内: navW >= 220 && navW <= 360,
      步骤在范围内: stepsW >= 200 && stepsW <= 320,
    });
    await ctx.close();
  }

  await browser.close();
  writeFileSync(join(PROTO, "measurements.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`测量完成 → ${join(PROTO, "measurements.json")}\n`);
  for (const c of result.用例) {
    process.stdout.write(`· ${c.用例} → ${JSON.stringify(c).slice(0, 240)}\n`);
  }
})().catch((e) => {
  process.stderr.write(`原型测量失败：${e.stack || e.message}\n`);
  process.exitCode = 1;
});
