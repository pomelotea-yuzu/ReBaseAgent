/* eslint-disable */
/**
 * 分支树 GUI 冒烟（沙箱自验）：经 CDP 连上 dev 中的 Electron 渲染层，
 * 截「轨迹 / 分支树 / 勾选对照」三张图，供人工核对。
 * 用法：NODE_PATH=<workspace>/node_modules node scripts/branch-tree-cdp-smoke.cjs
 */
"use strict";
const { chromium } = require("playwright-core");
const { mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const OUT = join(resolve(__dirname, "..", "..", ".."), ".workbuddy", "branch-tree-smoke");
mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes("localhost:5173"));
  if (page === undefined) throw new Error("未找到渲染层页面");

  await page.waitForTimeout(1500);

  // 1) 轨迹视图（三栏）
  await page.screenshot({ path: join(OUT, "01-trace-view.png") });

  // 2) 切到分支树
  await page.getByRole("button", { name: "分支树", exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, "02-tree-view.png") });

  // 3) 勾选两条兄弟分支加入对照
  const boxes = page.locator('input[title^="加入对照"]');
  const count = await boxes.count();
  console.log("checkbox 数量:", count);
  await boxes.nth(1).check();
  await boxes.nth(2).check();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "03-compare.png") });

  // 4) 点一个深层节点 → 详情加载
  await page.locator('button[title*="tree_r03"]').first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, "04-select-node.png") });

  // 5) 切回轨迹视图：选中应保持为 tree_r03
  await page.getByRole("button", { name: "轨迹", exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, "05-back-to-trace.png") });

  console.log("截图输出目录:", OUT);
  process.exit(0);
})().catch((e) => {
  console.error("冒烟失败:", e);
  process.exit(1);
});
