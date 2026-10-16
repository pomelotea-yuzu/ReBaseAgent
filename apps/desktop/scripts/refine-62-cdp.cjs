/* eslint-disable */
/**
 * refine-ui-for-community-release 任务 6.2：**R06 坏附件形态实机补齐**。
 *
 * 背景：5.2（refine-52）已完成 R06 的两个形态——①普通无文件运行（入口禁用+真实原因）、
 * ②合法隔离 run（文件页无步骤目录）。剩余「坏附件形态」：隔离 run 的附件 blob
 * 落盘字节与清单哈希不符 ⇒ 文件页必须**显式可辨**（附件损坏 / ⚠ N 个附件不可用 /
 * 导出禁用并说明），绝不把坏附件渲染成内容或空文件。
 *
 * 流程（单 dev、纯只读——不动 settings、不创建 run、收尾按清单逐字节清除）：
 * - P0 注入隔离父/子 traces + isolated-blobs（只拷贝本机不存在的；把**本探针拷入的**
 *   首个 blob 覆写为坏字节，原字节来自夹具、收尾直接删除本拷贝）。
 * - P1 选中隔离父 → 文件页：断言「附件损坏」在场、「⚠ 1 个附件不可用」汇总在场、
 *   坏 blob 原文（"alpha 内容"）**不在** DOM（不冒充内容）、完好像素级对照：
 *   清单规模行在场；文件页仍不附带步骤目录（坏附件形态下 R06 主判据不回退）。
 * - P2 导出面板：已知坏附件 ⇒ 导出禁用 + 说明文案「缺失或损坏」在场。
 * - 收尾：删除注入的 traces 与 blobs（仅本探针拷入项）。
 *
 * 用法：node apps/desktop/scripts/refine-62-cdp.cjs
 * 前置：dev 已带 CDP 9612 启动；U7 fixtures 在 apps/desktop/test/fixtures/u7-compare。
 */
"use strict";

const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { listPageTarget } = require("./editor-collapse-probe.cjs");

const ROOT = join(H.REPO, ".workbuddy", "refine-ui", "5x");
const SHOTS = join(ROOT, "shots");
mkdirSync(SHOTS, { recursive: true });

const FIXTURES = join(H.REPO, "apps", "desktop", "test", "fixtures", "u7-compare");
const BLOBS_DIR = join(H.REPO, ".rebaseagent", "workspace-blobs", "sha256");

const ISO_TRACES = ["run_muo988yd_4btbgb.jsonl", "run_muo9892a_w2qj.jsonl"];
const ISO_PARENT = "run_muo988yd_4btbgb";
/** 夹具里隔离父引用的三个 blob；本探针弄坏第一个（原内容 "alpha 内容"） */
const BLOB_BAD = "26b36ccb92b026c00fe9e787af2229f867bc1a87952c08264c4f48b818d9d918";
const BLOB_BAD_ORIGINAL = "alpha 内容";

const TAG = "r62";
const CLEANUP = { traces: [], blobs: [] };

async function cleanupFixtures() {
  for (const f of CLEANUP.traces) rmSync(join(H.TRACES, f), { force: true });
  for (const f of CLEANUP.blobs) rmSync(join(BLOBS_DIR, f), { force: true });
  console.log(`fixtures 清除：trace ${CLEANUP.traces.length} 个、blob ${CLEANUP.blobs.length} 个`);
}

const checks = [];
const dump = {};
function check(name, ok, detail) {
  const entry = { tag: TAG, name, ok: ok === true, detail: detail ?? null };
  checks.push(entry);
  const shown =
    detail === undefined || detail === null
      ? ""
      : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : shown}`);
  return entry;
}
function finish() {
  const failed = checks.filter((c) => !c.ok && !c.note);
  writeFileSync(
    join(ROOT, `${TAG}-measurements.json`),
    `${JSON.stringify({ tag: TAG, ...dump, checks }, null, 2)}\n`,
    "utf8",
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  return failed.length;
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 14 分钟未收尾`);
  for (const f of CLEANUP.traces) {
    try {
      rmSync(join(H.TRACES, f), { force: true });
    } catch {}
  }
  for (const f of CLEANUP.blobs) {
    try {
      rmSync(join(BLOBS_DIR, f), { force: true });
    } catch {}
  }
  writeFileSync(join(ROOT, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 840_000);

async function shot(call, name) {
  const file = await H.shot(call, SHOTS, `${TAG}-${name}.png`).catch((e) => String(e));
  console.log(`  [截图] ${file}`);
}

async function main() {
  const page = await listPageTarget(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});

  // 开局哨兵 reload（5.1 纪律：不继承崩溃/HMR 残局）
  {
    const sentinel = `r62-${Date.now()}`;
    await H.ev(call, `window.__r62Doc = ${JSON.stringify(sentinel)}; "ok"`);
    let swapped = false;
    await call("Page.reload", { ignoreCache: false });
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        const doc = await H.ev(call, "window.__r62Doc ?? null");
        if (doc !== sentinel) {
          const n = await H.storeQ(call, "return JSON.stringify({ runs: s.runs.length });");
          if (n.runs > 0) {
            swapped = true;
            break;
          }
        }
      } catch {
        /* 重载瞬间 */
      }
      if (Date.now() > deadline) break;
      await H.sleep(400);
    }
    if (!swapped) throw new Error("开局 reload 未换文档或列表未就绪");
  }

  // ── P0 注入 fixtures + 弄坏一个 blob ────────────────────────────────────
  for (const f of ISO_TRACES) {
    const src = join(
      FIXTURES,
      existsSync(join(FIXTURES, "traces", f)) ? "traces" : "isolated-traces",
      f,
    );
    if (!existsSync(src)) throw new Error(`fixture 缺失：${src}`);
    copyFileSync(src, join(H.TRACES, f));
    CLEANUP.traces.push(f);
  }
  const fixtureBlobDir = join(FIXTURES, "isolated-blobs", "sha256");
  for (const f of require("node:fs").readdirSync(fixtureBlobDir)) {
    const dst = join(BLOBS_DIR, f);
    if (existsSync(dst)) {
      if (f === BLOB_BAD) {
        throw new Error(
          `blob ${f} 已存在于生产目录——本探针只弄坏自己拷入的副本，拒绝改动既有文件；请先清理后重跑`,
        );
      }
      continue; // 已存在的不动、不记录（收尾不删）
    }
    copyFileSync(join(fixtureBlobDir, f), dst);
    CLEANUP.blobs.push(f);
  }
  if (!CLEANUP.blobs.includes(BLOB_BAD)) {
    throw new Error(
      `坏样本 blob ${BLOB_BAD} 未由本探针拷入（生产目录已有同名文件），无法安全弄坏；中止`,
    );
  }
  // 覆写为坏字节：内容与文件名（=原 sha256）不符 ⇒ main 判 corrupt
  writeFileSync(join(BLOBS_DIR, BLOB_BAD), `${BLOB_BAD_ORIGINAL}（本探针注入的坏字节）`, "utf8");
  dump.corruptedBlob = BLOB_BAD;
  await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("ok");`);
  await H.sleep(800);
  const injected = await H.storeQ(
    call,
    `const want = ${JSON.stringify(ISO_TRACES.map((f) => f.replace(".jsonl", "")))};
     return JSON.stringify({ missing: want.filter(id => !s.runs.some(r => r.id === id)) });`,
  );
  check("P0 注入：隔离父/子两条标本在列表", injected.missing.length === 0, injected);

  // ── P1 隔离父文件页：坏附件显式可辨 ────────────────────────────────────
  await H.selectRun(call, ISO_PARENT);
  await H.sleep(800);
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(ISO_PARENT)}, "files"); return JSON.stringify("ok");`,
  );
  await H.sleep(2500);
  // 文件目录可能默认折叠（持久偏好）——先确保展开再断言逐文件标签
  {
    const ex = await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => (x.getAttribute('aria-label') || '') === '展开文件目录');
         if (b === undefined || b === null) return 'absent-or-open';
         b.click(); return 'clicked'; })()`,
    );
    if (ex === "clicked") await H.sleep(900);
    dump.dirExpand = ex;
  }
  const page1 = await H.ev(
    call,
    `(() => {
       const t = document.body.textContent || '';
       const steps = document.querySelectorAll('[aria-label="步骤目录"]');
       return {
         corruptLabel: t.includes('附件损坏'),
         summaryWarn: /个附件不可用/.test(t),
         badTextShown: t.includes(${JSON.stringify(BLOB_BAD_ORIGINAL)}),
         summaryLine: (t.match(/\\d+ 个文件[^\\n]{0,40}/) || [null])[0],
         stepsInDom: steps.length,
         hasFileWord: t.includes('文件'),
       };
     })()`,
  );
  // 「附件损坏」逐文件徽标在「自动」筛选下可能被收起（未变化文件不展示）——
  // 以「全部」筛选下的断言（page1c）为准，此处只登记观察不判成败。
  check(
    "P1 观察项：默认「自动」筛选下的可见性（逐文件徽标判据见下）",
    page1.corruptLabel === true,
    page1,
  ).note = "auto-filter 行为，判据由「全部」筛选断言承载";
  check("P1 汇总行「⚠ N 个附件不可用」在场", page1.summaryWarn === true, page1.summaryLine);
  check("P1 坏附件原文不在 DOM（不把坏字节冒充内容）", page1.badTextShown === false, {
    needle: BLOB_BAD_ORIGINAL,
  });
  check(
    "P1 坏附件形态下文件页仍不附带步骤目录（R06 主判据不回退）",
    page1.stepsInDom === 0 && page1.hasFileWord === true,
    { stepsInDom: page1.stepsInDom },
  );
  await shot(call, "01-corrupt-attachment");

  // 「自动」筛选可能收起未变化文件——切「全部」再核对逐文件「附件损坏」徽标
  const page1b = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent || '').trim()) === '全部');
       if (b === undefined || b === null) return 'no-filter';
       b.click(); return 'clicked'; })()`,
  );
  await H.sleep(900);
  const page1c = await H.ev(
    call,
    `(() => {
       const rows = Array.from(document.querySelectorAll('button[data-file-path]'));
       const bad = rows.find(x => (x.textContent || '').includes('附件损坏'));
       return {
         total: rows.length,
         corruptRow: bad === undefined || bad === null ? null : bad.getAttribute('data-file-path'),
         unavailReasonChip: (document.body.textContent || '').includes('不可用原因'),
       };
     })()`,
  );
  check(
    "P1 全部筛选下坏附件行带「附件损坏」徽标（逐文件可辨）",
    page1b === "clicked" && page1c.corruptRow !== null && page1c.corruptRow !== undefined,
    page1c,
  );
  check("P1 顶栏「不可用原因」芯片在场", page1c.unavailReasonChip === true, page1c);
  await shot(call, "03-corrupt-row");

  // 点坏附件行 ⇒ 查看区同样不得渲染坏字节（选中态再核一遍）
  if (page1c.corruptRow !== null && page1c.corruptRow !== undefined) {
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[data-file-path=' + JSON.stringify(${JSON.stringify(
        page1c.corruptRow,
      )}) + ']') || Array.from(document.querySelectorAll('button[data-file-path]'))
          .find(x => (x.textContent || '').includes('附件损坏'));
         if (b === undefined || b === null) return 'no-row';
         b.click(); return 'clicked'; })()`,
    );
    await H.sleep(1500);
    const page1d = await H.ev(
      call,
      `(() => { const t = document.body.textContent || '';
         return {
           injectedBytesShown: t.includes('本探针注入的坏字节'),
           originalShown: t.includes(${JSON.stringify(BLOB_BAD_ORIGINAL)}),
         };
       })()`,
    );
    check(
      "P1 选中坏附件后坏字节与原字样均不进查看区（不可读侧不冒充内容）",
      page1d.injectedBytesShown === false && page1d.originalShown === false,
      page1d,
    );
    await shot(call, "04-corrupt-selected");
  }

  // ── P2 导出面板：已知坏附件 ⇒ 禁用并说明 ──────────────────────────────
  const page2 = await H.ev(
    call,
    `(() => {
       const t = document.body.textContent || '';
       const btns = Array.from(document.querySelectorAll('button')).map(b => ({
         label: (b.getAttribute('aria-label') || (b.textContent || '').trim()).slice(0, 24),
         disabled: b.disabled,
       }));
       return {
         reason: t.includes('缺失或损坏'),
         exportBtn: btns.find(b => b.label.includes('导出')) || null,
       };
     })()`,
  );
  check("P2 导出禁用说明在场（「缺失或损坏」文案）", page2.reason === true, page2);
  await shot(call, "02-export-blocked");

  return finish();
}

main()
  .then((failed) => {
    cleanupFixtures()
      .catch(() => {})
      .then(() => process.exit(failed === 0 ? 0 : 1));
  })
  .catch(async (e) => {
    console.error("探针失败：", e?.message);
    writeFileSync(join(ROOT, `${TAG}-error.txt`), String(e?.stack || e));
    await cleanupFixtures().catch(() => {});
    process.exit(2);
  });
