/* eslint-disable */
/**
 * 「新建运行」GUI 冒烟（沙箱自验，**零成本**）：经 CDP 连上 dev 渲染层，验证
 * 入口按钮、对话框、表单校验，以及 runs:create 整条 IPC 链路（preload → ipcMain 的 zod 校验）。
 *
 * ⚠️ 刻意不点「创建」：settings 已配置时会发起真实计费调用。本脚本只走
 * 「userMessage 为空 ⇒ INVALID_ARGUMENT」这条零网络、零写文件的路径，并核对
 * traces 目录的 .jsonl 数量前后不变。
 *
 * 用法（先起 dev，CDP 端口 9222）：
 *   NODE_PATH=<workspace>/node_modules node scripts/create-run-cdp-smoke.cjs
 */
"use strict";
const { chromium } = require("playwright-core");
const { mkdirSync, readdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const OUT = join(resolve(__dirname, "..", "..", ".."), ".workbuddy", "create-run-smoke");
const TRACES = join(resolve(__dirname, "..", "..", ".."), ".rebaseagent", "traces");
mkdirSync(OUT, { recursive: true });

function traceCount() {
  try {
    return readdirSync(TRACES).filter((n) => n.endsWith(".jsonl")).length;
  } catch {
    return -1;
  }
}

(async () => {
  const before = traceCount();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes("localhost:5173"));
  if (page === undefined) throw new Error("未找到渲染层页面");

  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, "01-before.png") });

  // 1) 入口按钮存在且可点
  const entry = page.getByRole("button", { name: /新建运行/ });
  console.log("入口按钮数:", await entry.count());
  await entry.first().click();
  await page.waitForTimeout(400);

  const dialog = page.locator('dialog[aria-label="新建运行"]');
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  console.log("对话框已打开");
  await page.screenshot({ path: join(OUT, "02-dialog-open.png") });

  // 2) 表单校验：userMessage 为空 ⇒ 创建禁用；填入 ⇒ 启用
  const createBtn = dialog.getByRole("button", { name: /^创建$/ });
  const emptyDisabled = await createBtn.isDisabled();
  console.log("空 userMessage 时创建按钮 disabled:", emptyDisabled);

  const systemBox = dialog.locator("textarea").nth(0);
  const userBox = dialog.locator("textarea").nth(1);
  await systemBox.fill("你是一个简洁的问答助手，用两三句话回答。");
  await userBox.fill("用一句话解释什么是时间旅行调试。");
  await page.waitForTimeout(200);
  const filledDisabled = await createBtn.isDisabled();
  console.log("填入后创建按钮 disabled:", filledDisabled);
  await page.screenshot({ path: join(OUT, "03-filled.png") });

  // 3) IPC 链路（零成本分支）：preload → ipcMain 的 zod 校验，不产生任何文件与请求
  const empty = await page.evaluate(() =>
    window.api.createRun({ systemPrompt: "", userMessage: "" }),
  );
  console.log("空 userMessage 的 IPC 返回:", JSON.stringify(empty));
  const badShape = await page.evaluate(() => window.api.createRun({ userMessage: "x" }));
  console.log("缺 systemPrompt 的 IPC 返回:", JSON.stringify(badShape));
  writeFileSync(join(OUT, "ipc-results.json"), JSON.stringify({ empty, badShape }, null, 2));

  // 4) 关闭（取消）——不触发任何调用
  await dialog.getByRole("button", { name: "取消" }).click();
  await page.waitForTimeout(300);
  const stillOpen = await dialog.isVisible().catch(() => false);
  console.log("关闭后对话框仍可见:", stillOpen);
  await page.screenshot({ path: join(OUT, "04-closed.png") });

  const after = traceCount();
  console.log(`traces .jsonl 数量：${before} → ${after}（应相等）`);
  console.log("截图输出目录:", OUT);

  const ok =
    (await entry.count()) === 1 &&
    emptyDisabled === true &&
    filledDisabled === false &&
    empty.ok === false &&
    empty.error.code === "INVALID_ARGUMENT" &&
    badShape.ok === false &&
    badShape.error.code === "INVALID_ARGUMENT" &&
    stillOpen === false &&
    before === after;
  console.log(ok ? "冒烟通过 ✅" : "冒烟存在问题 ❌");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("冒烟失败:", e);
  process.exit(1);
});
