"use strict";
/**
 * A2 事实校准：真机测量「编辑某步 tool_result → 重跑」的缓存命中与成本区间。
 *
 * 为什么用 Electron 跑：settings.json 里的 apiKey 是 safeStorage 加密的，只有 Electron 主进程
 * 能解密。本脚本在 Electron 里解出 key 后立即用于 runLoop / replayRun——**key 不打印、不落盘、
 * 不进日志**（只打印 baseURL 与 model）。
 *
 * 用到的包是真机路径的同一份 dist：agent-loop（执行）/ trace-sdk（落盘与读取）/ replay（fork 编排，
 * 与桌面端 runs:fork 同一实现）。
 *
 * 用法（沙箱需 NO_SANDBOX=1）：
 *   apps/desktop/node_modules/electron/dist/electron.exe apps/desktop/scripts/measure-fork-cache.cjs
 */
const { app, safeStorage } = require("electron");
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "..", "..");
const DATA = join(ROOT, ".rebaseagent");
const TRACES = join(DATA, "traces");
const WORK = join(DATA, "measure-work");

/**
 * safeStorage 的密钥材料绑定在应用的 userData 目录里：dev 应用的 userData 是
 * `%APPDATA%/<package.json name>`（这里 = `@rebaseagent/desktop`）。用默认的
 * `%APPDATA%/Electron` 会解不开应用加密的 apiKey（实测报 "Error while decrypting…"）。
 * 故必须在 app ready 之前把它锚定到应用自己的目录。
 */
const APP_USER_DATA = join(process.env.APPDATA ?? "", "@rebaseagent", "desktop");
if (existsSync(APP_USER_DATA)) app.setPath("userData", APP_USER_DATA);

// 本脚本无界面，且沙箱内 GPU 进程会反复崩溃（FATAL: GPU process isn't usable）⇒ 关掉硬件加速
app.disableHardwareAcceleration();

const SYSTEM =
  "你是一个文件助手。必须按用户步骤依次调用 read_file 读取两个文件，最后用一句话总结。";
const TASK =
  "第 1 步：调用 read_file 读取 a.txt。第 2 步：调用 read_file 读取 b.txt。第 3 步：用一句话总结两个文件的内容。不要跳步。";

const TOOL_DEF = {
  name: "read_file",
  description: "读取指定路径的文件",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  sideEffect: false,
};

/** 包内 dist 的 file:// URL（动态 import 需要正斜杠） */
function distUrl(relPath) {
  return `file:///${join(ROOT, relPath).replace(/\\/g, "/")}`;
}

/** 真机三段：父 run（多步带工具）→ 立刻 fork 最后一步的 tool_result → 逐调用读数 */
async function main() {
  const { runLoop, OpenAiCompatClient } = await import(
    distUrl("packages/agent-loop/dist/index.js")
  );
  const { JsonlTracer, readRun } = await import(distUrl("packages/trace-sdk/dist/index.js"));
  const { replayRun } = await import(distUrl("packages/replay/dist/index.js"));

  // 1. 取运行配置（key 只在内存里）
  const stored = JSON.parse(readFileSync(join(DATA, "settings.json"), "utf8"));
  const apiKey = stored.apiKeyEncrypted
    ? safeStorage.decryptString(Buffer.from(stored.apiKey, "base64"))
    : stored.apiKey;
  console.log(`provider = ${stored.baseURL}  model = ${stored.model}  keyLen = ${apiKey.length}`);
  console.log("");

  mkdirSync(TRACES, { recursive: true });
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, "a.txt"), "a.txt 的内容：时间旅行调试需要 trace。\n", "utf8");
  writeFileSync(join(WORK, "b.txt"), "b.txt 的内容：前缀缓存能把重跑变便宜。\n", "utf8");

  const makeTools = () => [
    {
      ...TOOL_DEF,
      handler: (args, ctx) => readFileSync(join(ctx.cwd, String(args.path)), "utf8"),
    },
  ];

  const config = {
    baseURL: stored.baseURL,
    apiKey,
    model: stored.model,
    systemPrompt: SYSTEM,
    tools: [TOOL_DEF],
    exec: { cwd: WORK, signal: null },
    maxIterations: 6,
    budget: { maxTotalTokens: 200_000 },
  };

  // 2. 父 run（真实调用，落盘成 ${meta.id}.jsonl）
  const tmp = join(TRACES, `tmp-measure-${Date.now().toString(36)}.tmp`);
  const parentOutcome = await runLoop(
    config,
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: TASK },
    ],
    new JsonlTracer(tmp),
    makeTools(),
    new OpenAiCompatClient(config),
  );
  const parentRec = readRun(tmp);
  const parentId = parentRec.meta.id;
  renameSync(tmp, join(TRACES, `${parentId}.jsonl`));

  const parentCalls = parentRec.spans.filter((s) => s.kind === "llm.call");
  const parentTools = parentRec.spans.filter((s) => s.kind === "tool.invoke");
  console.log(
    `父 run = ${parentId}  终止 = ${parentOutcome.event.event}/${parentOutcome.event.reason}`,
  );
  console.log(`  调用 ${parentCalls.length} 次 · 工具 ${parentTools.length} 次`);
  report("父 run", parentCalls);

  const baselineIn = parentCalls.reduce((n, s) => n + s.response.usage.in, 0);
  const baselineOut = parentCalls.reduce((n, s) => n + s.response.usage.out, 0);
  console.log(`  父 run 全价基线 Σ(in+out) = ${baselineIn + baselineOut}`);

  if (parentTools.length === 0) {
    console.log(
      "\n❌ 父 run 没有任何 tool.invoke（模型没按步骤用工具）——无法做 tool_result 分叉测量。",
    );
    return;
  }

  // 3. 立刻 fork：编辑最后一次 tool.invoke 的 result（后缀最短 = README「1/4」所指的乐观情形）
  const target = parentTools[parentTools.length - 1];
  console.log(`\n分叉点 = ${target.id}（工具 ${target.tool}）· 立刻重跑（缓存应仍在有效期内）`);

  const { id: forkId } = await replayRun({
    parentId,
    atSpanId: target.id,
    edit: {
      field: "result",
      value: `${String(target.result)}\n（本行由测量脚本改写，用于制造脏 tool_result）`,
    },
    config,
    tools: makeTools(),
    load: (id) => readRun(join(TRACES, `${id}.jsonl`)),
    outDir: TRACES,
  });

  const forkRec = readRun(join(TRACES, `${forkId}.jsonl`));
  const forkCalls = forkRec.spans.filter((s) => s.kind === "llm.call");
  console.log(`fork run = ${forkId}`);
  console.log(`  调用 ${forkCalls.length} 次（父 run ${parentCalls.length} 次）`);
  report("fork run", forkCalls);

  // 4. 成本区间：命中部分按折扣价（折扣率未知）⇒ 只给全价上下界
  const forkIn = forkCalls.reduce((n, s) => n + s.response.usage.in, 0);
  const forkOut = forkCalls.reduce((n, s) => n + s.response.usage.out, 0);
  const hit = forkCalls.reduce((n, s) => n + (s.response.usage.cache_hit ?? 0), 0);
  const miss = forkCalls.reduce((n, s) => n + (s.response.usage.cache_miss ?? 0), 0);
  const hitKnown = forkCalls.some((s) => s.response.usage.cache_hit !== undefined);

  console.log("\n===== 结果 =====");
  console.log(`调用次数比        fork ${forkCalls.length} / 父 ${parentCalls.length}`);
  console.log(`命中字段是否记录  ${hitKnown ? "是" : "否（⚠️ 断言 1 未成立）"}`);
  console.log(`Σcache_hit=${hit}  Σcache_miss=${miss}  Σin=${forkIn}  Σout=${forkOut}`);
  console.log(
    `恒等式 hit+miss=in  ${hit + miss === forkIn ? "成立" : `不成立（${hit + miss} ≠ ${forkIn}，⚠️ 断言 4 有问题）`}`,
  );
  console.log(
    `成本区间（全价）  下界 Σ(miss+out) = ${miss + forkOut} ｜ 上界 Σ(in+out) = ${forkIn + forkOut}`,
  );
  console.log(
    `对父 run 基线      ${baselineIn + baselineOut}  ⇒ 区间占比 ${pct(miss + forkOut, baselineIn + baselineOut)} ~ ${pct(forkIn + forkOut, baselineIn + baselineOut)}`,
  );
}

function pct(a, b) {
  return b === 0 ? "n/a" : `${Math.round((a / b) * 100)}%`;
}

function report(label, calls) {
  calls.forEach((s, i) => {
    const u = s.response.usage;
    const hit = u.cache_hit === undefined ? "缺失" : String(u.cache_hit);
    const miss = u.cache_miss === undefined ? "缺失" : String(u.cache_miss);
    console.log(
      `  [${label} #${i + 1}] in=${u.in} out=${u.out} cache_hit=${hit} cache_miss=${miss} ttft=${s.response.ttft_ms}ms`,
    );
  });
}

app.whenReady().then(() =>
  main()
    .catch((e) => {
      console.error("测量失败:", e);
      process.exitCode = 1;
    })
    .finally(() => app.quit()),
);
