/* eslint-disable */
/**
 * A2 缓存命中展示冒烟（沙箱自验）：选中带 cache_hit 的真机 run，核对
 * ① run 列表条目出现「命中 X」；② llm.call 概要区出现缓存命中行；③ 截图留证。
 * 用法：NODE_PATH=<workspace>/node_modules node scripts/cache-hit-cdp-smoke.cjs [runId]
 */
"use strict";
const { chromium } = require("playwright-core");
const { mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const OUT = join(resolve(__dirname, "..", "..", ".."), ".workbuddy", "cache-hit-smoke");
mkdirSync(OUT, { recursive: true });
const runId = process.argv[2] ?? "run_mu2iw4s1";

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes("localhost:5173"));
  if (page === undefined) throw new Error("未找到渲染层页面");

  await page.waitForTimeout(1500);

  // 1. 选中真机 run；列表条目应显示「命中 X」
  await page.locator(`button:has-text("${runId}")`).first().click();
  await page.waitForTimeout(1000);
  const listCacheText = await page
    .locator("aside")
    .getByText(/命中 /)
    .first()
    .textContent()
    .catch(() => null);
  console.log("列表条目命中文本:", JSON.stringify(listCacheText));
  await page.screenshot({ path: join(OUT, "20-list.png") });

  // 2. 点第一个 llm.call → 概要区应有缓存命中行（着色 + 占比 + miss）
  await page
    .getByRole("button", { name: /LLM 调用/ })
    .first()
    .click();
  await page.waitForTimeout(800);
  const cacheRow = await page
    .getByText(/缓存命中/)
    .first()
    .textContent()
    .catch(() => null);
  console.log("详情缓存命中行:", JSON.stringify(cacheRow));
  await page.screenshot({ path: join(OUT, "21-detail-cache.png") });

  const ok = listCacheText?.includes("命中") === true && cacheRow !== null;
  console.log(ok ? "冒烟通过 ✅" : "冒烟存在问题 ❌");
  console.log("截图目录:", OUT);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("冒烟失败:", e);
  process.exit(1);
});
