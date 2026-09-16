/* eslint-disable */
/**
 * LLM 失败详情 GUI 冒烟（沙箱自验，**零成本**）：经 CDP 连上 dev 渲染层，验证
 * 「失败 LLM 节点标记 + 错误详情 + 占位零值声明 + 错误详情缺失提示」四种界面事实。
 *
 * 自管理 fixture（无真实调用、零计费）：脚本启动时写入 dev traces 目录两条 run，
 * 结束时（含失败路径）删除，不污染本地运行记录：
 *   run_smoke_llmerr.jsonl      —— 错误终止 + llm.call.error{status:401}
 *   run_smoke_legacyerr.jsonl   —— 错误终止 + 无 error 字段（模拟老/代理失败 run）
 *
 * 用法（先起 dev：`NO_SANDBOX=1 node scripts/start-dev.cjs --remoteDebuggingPort=9222`）：
 *   NODE_PATH=<workspace>/node_modules node scripts/llm-error-cdp-smoke.cjs
 */
"use strict";
const { chromium } = require("playwright-core");
const { existsSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..", "..", "..");
const OUT = join(ROOT, ".workbuddy", "llm-error-smoke");
const TRACES = join(ROOT, ".rebaseagent", "traces");
mkdirSync(OUT, { recursive: true });

const MESSAGE = "LLM 端点返回 HTTP 401：Authentication Fails, Your api key is invalid";

function metaLine(id, task, createdAt) {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task,
    model: "deepseek-chat",
    created_at: createdAt,
    parent: null,
    fork: null,
    config_hash: "sha256:smoke-fixture",
  });
}

function spanLines({ withError }) {
  const step = JSON.stringify({
    type: "span",
    id: "s_01",
    kind: "agent.step",
    parent: null,
    n: 1,
    timing: { started_at: "2026-09-16T20:30:00.100Z", ended_at: "2026-09-16T20:30:00.900Z" },
  });
  const llm = JSON.stringify({
    type: "span",
    id: "s_02",
    kind: "llm.call",
    parent: "s_01",
    timing: { started_at: "2026-09-16T20:30:00.120Z", ended_at: "2026-09-16T20:30:00.880Z" },
    request: {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "你是助手。" },
        { role: "user", content: "你好" },
      ],
    },
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 0, out: 0 },
      ttft_ms: 0,
    },
    ...(withError ? { error: { message: MESSAGE, status: 401 } } : {}),
  });
  return [
    step,
    llm,
    JSON.stringify({ type: "run.event", event: "errored", reason: "error", at: 1 }),
  ];
}

const FIXTURES = [
  {
    id: "run_smoke_llmerr",
    // created_at 取未来时刻：确保排在既有本地 run 之上，脚本无需滚动列表
    lines: [
      metaLine("run_smoke_llmerr", "[冒烟] 失败详情已记录（HTTP 401）", "2027-01-01T00:00:02.000Z"),
      ...spanLines({ withError: true }),
    ],
  },
  {
    id: "run_smoke_legacyerr",
    lines: [
      metaLine(
        "run_smoke_legacyerr",
        "[冒烟] 老失败 run（无错误详情）",
        "2027-01-01T00:00:01.000Z",
      ),
      ...spanLines({ withError: false }),
    ],
  },
];

function writeFixtures() {
  for (const f of FIXTURES) {
    writeFileSync(join(TRACES, `${f.id}.jsonl`), `${f.lines.join("\n")}\n`, "utf8");
  }
}

function removeFixtures() {
  for (const f of FIXTURES) {
    const file = join(TRACES, `${f.id}.jsonl`);
    if (existsSync(file)) rmSync(file, { force: true });
  }
}

/** 断言小工具：收集每条布尔结论，最后统一打印（失败不早退，便于一次看全貌） */
const checks = [];
function check(name, actual, expected = true) {
  const ok = actual === expected;
  checks.push({ name, ok, actual, expected });
  console.log(`${ok ? "✓" : "✗"} ${name}（实际 ${JSON.stringify(actual)}）`);
}

(async () => {
  writeFixtures();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes("localhost:5173"));
  if (page === undefined) throw new Error("未找到渲染层页面");

  // 触发一次列表刷新，让新写入的 fixture 进入列表（app 启动早于写入时必需）
  await page.evaluate(() => window.api.listRuns());
  await page.reload();
  await page.waitForTimeout(1500);

  async function openRun(runId) {
    await page
      .getByRole("button", { name: new RegExp(runId) })
      .first()
      .click();
    await page.waitForTimeout(600);
  }

  // ---------------------------------------------------------------- 1) 有错误详情
  await openRun("run_smoke_llmerr");
  await page.screenshot({ path: join(OUT, "01-run-selected.png") });

  const llmNode = page.getByRole("button", { name: /LLM 调用/ }).first();
  const nodeText = await llmNode.innerText();
  check("轨迹树失败 LLM 节点带 ✕ 标记", nodeText.includes("✕"));
  check("失败节点是 LLM 节点（badge=LLM）", nodeText.includes("LLM"));

  await llmNode.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, "02-error-detail.png") });

  const detailText = await page.locator("section").last().innerText();
  check("详情展示错误原因", detailText.includes("Authentication Fails"));
  check("详情展示 HTTP 状态码", detailText.includes("HTTP 401"));
  check("详情声明占位零值不代表实际消耗", detailText.includes("失败占位零值"));
  check("有详情时不给缺失提示", detailText.includes("错误详情未记录"), false);
  check("失败调用不显示「仅有工具调用」", detailText.includes("仅有工具调用"), false);
  check("失败调用空正文文案正确", detailText.includes("调用失败，无响应正文"));
  check("失败调用仍可查看原始请求", detailText.includes("请求消息"));

  // ------------------------------------------------------------ 2) 缺失诚实降级
  await openRun("run_smoke_legacyerr");
  await page.screenshot({ path: join(OUT, "03-missing-notice.png") });

  const legacyText = await page.locator("section").last().innerText();
  check("老失败 run 显示「错误详情未记录」", legacyText.includes("错误详情未记录"));
  check("缺失提示不猜造原因（不出现 401）", legacyText.includes("HTTP 401"), false);

  await page
    .getByRole("button", { name: /LLM 调用/ })
    .first()
    .click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, "04-legacy-llm.png") });
  const legacyDetail = await page.locator("section").last().innerText();
  check("无 error 字段的 LLM 节点不显示错误区", legacyDetail.includes("调用失败"), false);
  check("无 error 字段的空正文走「响应为空正文」", legacyDetail.includes("响应为空正文"));
  check("缺失提示仍在（选中 span 后不消失）", legacyDetail.includes("错误详情未记录"));

  const failed = checks.filter((c) => !c.ok);
  writeFileSync(join(OUT, "checks.json"), JSON.stringify(checks, null, 2));
  console.log(`\n截图与结论：${OUT}`);
  console.log(failed.length === 0 ? "冒烟通过 ✅" : `冒烟失败 ❌（${failed.length} 项）`);
  return failed.length === 0;
})()
  .then((ok) => {
    removeFixtures();
    process.exit(ok ? 0 : 1);
  })
  .catch((e) => {
    console.error("冒烟失败:", e);
    removeFixtures();
    process.exit(1);
  });
