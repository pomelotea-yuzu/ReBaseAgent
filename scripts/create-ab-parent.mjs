#!/usr/bin/env node
/**
 * 模型 A/B 冒烟辅助：现造一个满足 CLI 父链门禁的父 run。
 *
 * 背景：桌面端目前只有两条 run 来源——本地录制代理（proxy，被 fork 门禁拒绝）
 * 和 fork。仓库 traces 里没有"原生录制 + 纯对话 + 已封存"的父 run，CLI 的
 * rebaseagent-model-ab 就没有合法起点。本脚本用真实 LLM 调用跑一次无工具的
 * 纯对话 run 落盘到 traces 目录，作为 A/B 实验的父 run。消耗 1 次对话调用。
 *
 * 用法（PowerShell）：
 *   $env:REBASEAGENT_API_KEY = "sk-..."
 *   node scripts/create-ab-parent.mjs                       # 默认 deepseek-chat
 *   node scripts/create-ab-parent.mjs -m deepseek-reasoner  # 指定模型
 *   node scripts/create-ab-parent.mjs -b https://api.deepseek.com/v1
 *
 * 产出：打印新父 run 的 id，随后可跑：
 *   node packages/replay/dist/model-ab-cli.js --parent <id> --dir <traces> \
 *     --arm "deepseek-chat;temperature=0.2" --arm "deepseek-chat;temperature=1.5" \
 *     --confirm-cost
 */
import { renameSync } from "node:fs";
import { join } from "node:path";
import { configHash, OpenAiCompatClient, runLoop } from "../packages/agent-loop/dist/index.js";
import { JsonlTracer, readRun } from "../packages/trace-sdk/dist/index.js";

// ---- 参数 ----
const argv = process.argv.slice(2);
function opt(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const model = opt("-m", "deepseek-chat");
const baseURL = opt("-b", "https://api.deepseek.com/v1");
const apiKey = process.env.REBASEAGENT_API_KEY ?? "";
const tracesDir = opt("-d", join(process.cwd(), ".rebaseagent", "traces"));

if (apiKey.length === 0) {
  console.error("缺少 REBASEAGENT_API_KEY 环境变量（真实调用需要密钥）");
  process.exit(2);
}

const systemPrompt = "你是一个简洁的问答助手，用两三句话回答。";
const task = "用一句话解释什么是时间旅行调试（time-travel debugging），以及它对 Agent 开发者的价值。";

const config = {
  baseURL,
  apiKey,
  model,
  systemPrompt,
  tools: [], // 纯对话：CLI 首期只接受空工具表的父 run
  params: { temperature: 0.7 },
  exec: { cwd: process.cwd(), signal: null },
  maxIterations: 3,
  budget: { maxTotalTokens: 20_000 },
};

const tmpFile = join(tracesDir, "tmp-ab-parent.jsonl");
console.log(`调用 ${model} @ ${baseURL} …`);
const outcome = await runLoop(
  config,
  [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ],
  new JsonlTracer(tmpFile),
  [],
  new OpenAiCompatClient(config),
);

if (outcome.event.event !== "stopped") {
  console.error(`run 未正常完成：${outcome.event.event}（${outcome.event.reason}）`);
  console.error(`临时文件保留在 ${tmpFile} 供排查`);
  process.exit(1);
}

const record = readRun(tmpFile);
const finalName = join(tracesDir, `${record.meta.id}.jsonl`);
renameSync(tmpFile, finalName);

console.log("父 run 已生成：");
console.log(`  id           = ${record.meta.id}`);
console.log(`  文件         = ${finalName}`);
console.log(`  config_hash  = ${configHash(systemPrompt, [])}`);
console.log(`  期待 hash    = ${record.meta.config_hash}`);
console.log(`\n下一步（A/B 冒烟）：`);
console.log(
  `  node packages/replay/dist/model-ab-cli.js --parent ${record.meta.id} --dir "${tracesDir}" ` +
    `--arm "${model};temperature=0.2" --arm "${model};temperature=1.5" --confirm-cost`,
);
