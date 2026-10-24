/* eslint-disable */
/**
 * README 四张截图重拍（v0.5.0-rc.1 界面口径）。
 *
 * 产物（覆盖 docs/readme-shots/）：
 *   - rerun.png   2560×1600：隔离续跑编辑确认区（run 详情步骤页 + 在此重跑）
 *   - files.png   2560×1600：文件页检查点 diff（README.md 修改对比）
 *   - compare.png 2560×1600：分支关系视图（fork 链 + 对照）
 *   - hero.png    2052×845 ：左文案 + 右窗口截图的合成横幅
 *
 * 视口：1280×800 CSS × DPR 2（Emulation.setDeviceMetricsOverride，与旧图同尺寸）。
 * 用法：node apps/desktop/scripts/readme-shots-cdp.cjs（前置：dev 已带 CDP 9612 启动，
 *       gen-readme-demo.cjs 已注入演示数据）。
 */
"use strict";

const { writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { listPageTarget } = require("./editor-collapse-probe.cjs");

const REPO = H.REPO;
const SHOTS = join(REPO, "docs", "readme-shots");
const DEMO = JSON.parse(
  readFileSync(join(REPO, ".rebaseagent", "readme-demo-manifest.json"), "utf8"),
);
const ROOT_ID = DEMO.rootId;
const CHILD_ID = DEMO.childId;

const W = 1280;
const HGT = 800;
const DPR = 2;

function savePng(call, outPath, name) {
  return call("Page.captureScreenshot", { format: "png" }).then((r) => {
    writeFileSync(outPath, Buffer.from(r.data, "base64"));
    console.log(`  [图] ${name} -> ${outPath}`);
  });
}

async function setViewport(call, width, height, dpr) {
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: dpr,
    mobile: false,
  });
  await H.sleep(900);
}

async function main() {
  const page = await listPageTarget(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});

  // 开局哨兵 reload
  {
    const sentinel = `shots-${Date.now()}`;
    await H.ev(call, `window.__shotsDoc = ${JSON.stringify(sentinel)}; "ok"`);
    await call("Page.reload", { ignoreCache: false });
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        const doc = await H.ev(call, "window.__shotsDoc ?? null");
        if (doc !== sentinel) {
          const n = await H.storeQ(call, "return JSON.stringify({ runs: s.runs.length });");
          if (n.runs > 0) break;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error("reload 未就绪");
      await H.sleep(400);
    }
  }

  await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("ok");`);
  await H.sleep(600);
  const has = await H.storeQ(
    call,
    `return JSON.stringify({ root: s.runs.some(r => r.id === ${JSON.stringify(ROOT_ID)}),
       child: s.runs.some(r => r.id === ${JSON.stringify(CHILD_ID)}) });`,
  );
  if (!has.root || !has.child) throw new Error(`演示 run 未入列表：${JSON.stringify(has)}`);

  // ── rerun.png：run 详情步骤页，选中写 README 的 tool，打开隔离续跑编辑确认区 ──
  await setViewport(call, W, HGT, DPR);
  await H.selectRun(call, ROOT_ID);
  await H.sleep(900);
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(ROOT_ID)}, "steps"); return JSON.stringify("ok");`,
  );
  await H.sleep(900);
  // 找到写 README.md 的 tool.invoke span（用 trace 数据取 span id）
  const spanId = await H.storeQ(
    call,
    `const rec = s.detail && s.detail.record;
     const sp = rec && rec.spans && rec.spans.find(x => x.kind === "tool.invoke" && x.tool === "write_file");
     return JSON.stringify({ id: sp ? sp.id : null });`,
  );
  if (!spanId.id) throw new Error("未找到写 README 的 tool span");
  await H.storeQ(call, `s.selectSpan(${JSON.stringify(spanId.id)}); return JSON.stringify("ok");`);
  await H.sleep(900);
  // 点「在此重跑（隔离续跑）」
  const clicked = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.textContent || '').includes('在此重跑'));
       if (b === undefined || b === null) return 'no-button';
       b.click(); return 'clicked'; })()`,
  );
  if (clicked !== "clicked") throw new Error(`在此重跑按钮点击失败：${clicked}`);
  await H.sleep(1600);
  await savePng(call, join(SHOTS, "rerun.png"), "rerun");

  // ── files.png：文件页，选第 2 轮检查点 + README.md diff ──────────────────
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('aria-label') || '') === '放弃修改'
                || (x.textContent || '').trim() === '取消');
       if (b !== undefined && b !== null) b.click(); return 'ok'; })()`,
  ).catch(() => {});
  await H.sleep(700);
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(ROOT_ID)}, "files"); return JSON.stringify("ok");`,
  );
  await H.sleep(1800);
  // 选第 2 轮检查点（文本「本 run 第 2 轮结束」）
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.textContent || '').trim() === '本 run 第 2 轮结束');
       if (b !== undefined && b !== null) b.click(); return 'ok'; })()`,
  );
  await H.sleep(1500);
  // 选 README.md 行
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button[data-file-path]'))
        .find(x => (x.getAttribute('data-file-path') || '').endsWith('README.md'));
       if (b !== undefined && b !== null) b.click(); return 'ok'; })()`,
  );
  await H.sleep(2000);
  await savePng(call, join(SHOTS, "files.png"), "files");

  // ── compare.png：分支关系视图，选中根 run（树上可见 fork 链）──────────────
  await H.storeQ(call, `s.setView("tree"); return JSON.stringify("ok");`);
  await H.sleep(1500);
  await H.storeQ(call, `s.selectRun(${JSON.stringify(CHILD_ID)}); return JSON.stringify("ok");`);
  await H.sleep(1500);
  await savePng(call, join(SHOTS, "compare.png"), "compare");

  // ── hero.png：2052×845 合成横幅（左文案 + 右 rerun 窗口截图）──────────────
  const rerunB64 = readFileSync(join(SHOTS, "rerun.png")).toString("base64");
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 2052px; height: 845px; background: #fff; font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
         display: flex; align-items: center; overflow: hidden; }
  .left { width: 990px; padding: 0 24px 0 72px; }
  h1 { font-size: 64px; letter-spacing: 1px; color: #17171c; margin-bottom: 18px; }
  .slogan { font-size: 40px; font-weight: 700; color: #17171c; margin-bottom: 36px; }
  .slogan .hi { color: #7c3aed; }
  p { font-size: 20px; line-height: 1.75; color: #3f3f46; margin-bottom: 18px; }
  .badges { margin-top: 34px; display: flex; gap: 14px; }
  .badge { border: 1.5px solid #d4d4d8; border-radius: 999px; padding: 8px 22px;
           font-size: 17px; color: #52525b; background: #fafafa; }
  .right { flex: 1; display: flex; align-items: center; justify-content: center; padding-right: 8px; }
  .right img { width: 1000px; height: auto; border-radius: 10px;
               box-shadow: 0 18px 50px rgba(0,0,0,.16), 0 2px 8px rgba(0,0,0,.10); }
</style></head><body>
  <div class="left">
    <h1>ReBaseAgent</h1>
    <div class="slogan">改掉那一步，<span class="hi">让它从那里重新跑。</span></div>
    <p>Agent 写错了文件：停在出错的那一步，改掉模型当时看到的工具结果，从该步继续执行。</p>
    <p>本地保存轨迹与文件快照，源目录不动；模型请求按你配置的 baseURL 发送。</p>
    <div class="badges"><span class="badge">MIT 开源</span><span class="badge">体积 &lt; 100 MB</span><span class="badge">文件状态可回退</span></div>
  </div>
  <div class="right"><img src="data:image/png;base64,${rerunB64}"></div>
</body></html>`;
  const heroTmp = join(REPO, ".rebaseagent", "readme-hero.html");
  writeFileSync(heroTmp, html, "utf8");
  await setViewport(call, 2052, 845, 1);
  await call("Page.navigate", { url: `file:///${heroTmp.replace(/\\/g, "/")}` });
  await H.sleep(1600);
  await savePng(call, join(SHOTS, "hero.png"), "hero");

  console.log("ALL_SHOTS_DONE");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("截图失败：", e?.stack || e);
    process.exit(1);
  });
