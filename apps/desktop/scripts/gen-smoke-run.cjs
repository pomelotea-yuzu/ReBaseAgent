/**
 * 生成一条"可 fork 的冒烟父 run"（开发辅助脚本，不入产品代码路径）。
 *
 * 背景：packages/trace-sdk/fixtures 的 r_01~r_04 是早期手工构造的展示数据——
 * request.tools 是 OpenAI 包装形状且每步只带单工具、config_hash 为假值，
 * 不能作为"在此重跑"的分叉父本（时间旅行要求 config_hash 自洽、工具表完整）。
 *
 * 本脚本用真实 runLoop + 内置 stub LLM（零 API）在 dev 数据目录
 * .rebaseagent/traces/ 下生成一条引擎原生录制的 completed run：
 * 系统提示 / 工具表全量入 request、config_hash 现算 → fork-runner/replayRun
 * 可对其正常执行"编辑 read_file 结果 → 从该步重跑"。
 *
 * 用法（PowerShell）：node scripts/gen-smoke-run.cjs [目标目录]
 * 默认目标目录 = 仓库根 .rebaseagent/traces（dev 数据目录）。
 */
"use strict";

const { runLoop } = require("@rebaseagent/agent-loop");
const { JsonlTracer, readRun } = require("@rebaseagent/trace-sdk");
const { mkdirSync, renameSync } = require("node:fs");
const { join, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEFAULT_DIR = join(REPO_ROOT, ".rebaseagent", "traces");
const DEFAULT_BUDGET = 100000;

const TASK = "读取 README.md 并把要点写入 summary.md";
const SYSTEM_PROMPT = "你是文件助手。";

// 工具定义（不带 handler 的纯数据，进 config.tools / config_hash）
const READ_DEF = {
  name: "read_file",
  description: "读取指定路径的文件",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  sideEffect: false,
};
const WRITE_DEF = {
  name: "write_file",
  description: "把内容写入指定路径",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};
const TOOLS = [
  {
    ...READ_DEF,
    handler: (args) => {
      const path = String(args.path ?? "");
      return path === "missing.json"
        ? (() => {
            throw new Error("ENOENT: no such file or directory");
          })()
        : `内容(${path})`;
    },
  },
  {
    ...WRITE_DEF,
    handler: (args) => {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      return `已写入 ${path}（${content.length} 字节）`;
    },
  },
];

/** 固定剧本的 stub LLM（与 agent-loop 测试 helpers 同构，零网络） */
class StubLlm {
  constructor() {
    this.requests = [];
    this.turn = 0;
    this.script = [
      { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
      {
        toolCalls: [
          {
            id: "c2",
            name: "write_file",
            args: '{"path":"summary.md","content":"# 要点\\n- 时间旅行调试器"}',
          },
        ],
      },
      { content: "任务完成：要点已写入 summary.md。" },
    ];
  }

  async complete(messages) {
    this.requests.push(messages);
    const turn = this.script[this.turn];
    if (turn === undefined) {
      throw new Error(`剧本耗尽：第 ${this.turn + 1} 轮无编排响应`);
    }
    this.turn += 1;
    return {
      response: {
        content: turn.content ?? null,
        reasoningContent: null,
        toolCalls: (turn.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        })),
        usage: { in: 2000, out: 100 },
        ttftMs: 10,
      },
      requestBody: {},
    };
  }
}

async function main() {
  const outDir = process.argv[2] ?? DEFAULT_DIR;
  // 可选第三参：覆盖预算上限，用于演示预算地图参考线/超限（默认足够大，不会超）
  const budgetTokens = process.argv[3] ? Number(process.argv[3]) : DEFAULT_BUDGET;
  mkdirSync(outDir, { recursive: true });

  const llm = new StubLlm();
  const config = {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-placeholder",
    model: "deepseek-chat",
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS.map(({ handler: _h, ...def }) => def),
    params: { temperature: 0.7 },
    exec: { cwd: outDir, signal: null },
    maxIterations: 10,
    // 预算会随 1.3 转录进 run.meta.budget，预算地图据此显示参考线
    budget: { maxTotalTokens: budgetTokens },
  };

  const tmpFile = join(outDir, "tmp-smoke-parent.jsonl");
  await runLoop(
    config,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: TASK },
    ],
    new JsonlTracer(tmpFile),
    TOOLS,
    llm,
  );

  const record = readRun(tmpFile);
  if (record.status !== "completed") {
    throw new Error(`生成的 run 未完成：${record.status}`);
  }
  const finalFile = join(outDir, `${record.meta.id}.jsonl`);
  renameSync(tmpFile, finalFile);

  console.log("生成可 fork 的冒烟父 run：");
  console.log(`  id:   ${record.meta.id}`);
  console.log(`  文件: ${finalFile}`);
  console.log(
    `  steps:${record.spans.filter((s) => s.kind === "agent.step").length} · ` +
      `llm 调用 ${llm.requests.length} 次（stub，零真实 API）`,
  );
  console.log(`  budget: ${budgetTokens}（meta.budget 已转录，预算地图可显示参考线）`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
