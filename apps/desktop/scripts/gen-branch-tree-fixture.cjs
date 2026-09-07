/**
 * 生成一棵「分支树冒烟家庭」（开发辅助脚本，不入产品代码路径）。
 *
 * 背景：分支树视图需要多条互为父子/兄弟的 run 才有东西可看，而真实 fork 需要
 * 花 API 调用。本脚本用 JsonlTracer 直接写出**结构合法**的 trace 家庭（零 API）：
 *
 *   tree_r00（根，2 步）
 *   ├── tree_r01（改 tool_result @ s_03，1 步 + 1 工具）
 *   │   └── tree_r03（改 tool_result @ s_07，1 步，运行中断）
 *   ├── tree_r02（改 tool_result @ s_03，1 步）
 *   │   └── tree_r04（代理重发：改 messages @ s_06，source=proxy）
 *   │       └── tree_r05（代理重发：改 messages @ s_08，source=proxy）
 *
 * 诚实边界：这批数据是「结构合法但非引擎运行产物」——span 内容是占位文本、
 * usage 是编造数字、文件名统一 `tree_` 前缀。可以看树/对照/详情，
 * 但**不要**拿 tree_r01~r03 试「在此重跑」（config_hash 非真实，会被 replay
 * 校验拒绝——这是既有行为，属预期）。
 *
 * 用法：node scripts/gen-branch-tree-fixture.cjs [目标目录]
 * 默认目标目录 = 仓库根 .rebaseagent/traces（dev 数据目录）。
 */
"use strict";

const { JsonlTracer } = require("@rebaseagent/trace-sdk");
const { mkdirSync, readdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEFAULT_DIR = join(REPO_ROOT, ".rebaseagent", "traces");

const TASK = "读取 README.md 并把要点写入 summary.md";
const MODEL = "deepseek-chat";

/** 写一次 llm.call span（占位 request/response，usage 可指定） */
function llm(tracer, parent, inTok, outTok) {
  const id = tracer.startSpan({
    kind: "llm.call",
    parent,
    request: {
      model: MODEL,
      messages: [{ role: "user", content: "（占位消息：读 README 并写摘要）" }],
    },
  });
  tracer.endSpan(id, {
    response: {
      content: "（占位响应）",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: inTok, out: outTok },
      ttft_ms: 250,
    },
  });
  return id;
}

/** 写一次 tool.invoke span（read_file，成功） */
function tool(tracer, parent, path) {
  const id = tracer.startSpan({ kind: "tool.invoke", parent, tool: "read_file", args: { path } });
  tracer.endSpan(id, { result: `（占位内容：${path}）`, dur_ms: 8, error: null });
  return id;
}

function step(tracer, parent, n) {
  return tracer.startSpan({ kind: "agent.step", parent, n });
}

/**
 * 写一个 run。
 * spans: [{ kind: "step", llm: [in, out], tool?: path }, ...]
 * ended: false 表示不写终止事件 → readRun 判为 crashed（用于树上看琥珀节点）
 */
function writeRun(dir, opts) {
  const {
    id,
    parent = null,
    fork = null,
    source,
    createdAt,
    spanSeqStart = 0,
    spans,
    ended = true,
  } = opts;
  const tracer = new JsonlTracer(join(dir, `${id}.jsonl`), { spanSeqStart });
  tracer.startRun({
    id,
    format_version: 1,
    task: TASK,
    model: MODEL,
    created_at: createdAt,
    parent,
    fork,
    ...(source === undefined ? {} : { source }),
    // 结构合法的占位 config_hash：仅供展示；真实 fork 校验会拒绝（文件头已声明）
    config_hash: "sha256:tree-smoke-placeholder",
  });

  let seq = spanSeqStart;
  for (const [index, spec] of spans.entries()) {
    const stepId = step(tracer, null, index + 1);
    llm(tracer, stepId, spec.llm[0], spec.llm[1]);
    if (spec.tool !== undefined) tool(tracer, stepId, spec.tool);
    tracer.endSpan(stepId); // step 收尾（timing 落盘；endSpan 不占用新 id）
    seq += 2 + (spec.tool === undefined ? 0 : 1);
  }

  if (ended) {
    tracer.endRun({ event: "stopped", reason: "completed", at: spans.length });
  } else {
    // 崩溃 run：不写终止事件；显式关闭 fd（JsonlTracer 仅在 endRun 时 close）
    tracer.close?.();
  }
  return { lastSpanId: `s_${String(seq).padStart(2, "0")}` };
}

function main() {
  const dir = process.argv[2] === undefined ? DEFAULT_DIR : resolve(process.argv[2]);
  mkdirSync(dir, { recursive: true });

  // 可重跑：只清理本脚本产出的 tree_ 前缀文件，绝不碰其他 run
  for (const name of readdirSync(dir)) {
    if (name.startsWith("tree_") && name.endsWith(".jsonl")) {
      rmSync(join(dir, name));
    }
  }

  const t = (minute, second) =>
    `2026-09-06T09:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

  // 根：2 步（step1 含 read_file 工具 = s_03，step2 收尾）
  writeRun(dir, {
    id: "tree_r00",
    createdAt: t(0, 0),
    spanSeqStart: 0,
    spans: [{ llm: [5000, 200], tool: "README.md" }, { llm: [5200, 180] }],
  });

  // 兄弟 1：从 s_03 改 tool_result 分叉，2 步规模里自己只新增 1 步 + 1 工具（s_07）
  writeRun(dir, {
    id: "tree_r01",
    parent: "tree_r00",
    fork: { at_span: "s_03", edit: { field: "result", value: "（编辑后的 README 内容）" } },
    createdAt: t(5, 0),
    spanSeqStart: 5,
    spans: [{ llm: [1800, 90], tool: "README.md" }],
  });

  // 孙：从 tree_r01 的 s_07 再改一次 tool_result，运行中断（树上看琥珀状态）
  writeRun(dir, {
    id: "tree_r03",
    parent: "tree_r01",
    fork: { at_span: "s_07", edit: { field: "result", value: "（二次编辑后的内容）" } },
    createdAt: t(12, 0),
    spanSeqStart: 8,
    spans: [{ llm: [1500, 60] }],
    ended: false,
  });

  // 兄弟 2：同样从 s_03 分叉，新增 1 步
  writeRun(dir, {
    id: "tree_r02",
    parent: "tree_r00",
    fork: { at_span: "s_03", edit: { field: "result", value: "（另一种改法的内容）" } },
    createdAt: t(8, 0),
    spanSeqStart: 5,
    spans: [{ llm: [2100, 110] }],
  });

  // 代理链：tree_r02 的 llm.call（s_06）编辑 messages 重发，再重发一次
  const proxySource = { kind: "proxy", base_url: "http://127.0.0.1:18787/v1" };
  writeRun(dir, {
    id: "tree_r04",
    parent: "tree_r02",
    fork: { at_span: "s_06", edit: { field: "messages", value: "（编辑后的 messages）" } },
    source: proxySource,
    createdAt: t(16, 0),
    spanSeqStart: 7,
    spans: [{ llm: [900, 120] }],
  });
  writeRun(dir, {
    id: "tree_r05",
    parent: "tree_r04",
    fork: { at_span: "s_08", edit: { field: "messages", value: "（再次编辑后的 messages）" } },
    source: proxySource,
    createdAt: t(20, 0),
    spanSeqStart: 9,
    spans: [{ llm: [850, 110] }],
  });

  console.log(`分支树冒烟家庭已写入 ${dir}`);
  console.log("结构：tree_r00 → {tree_r01 → tree_r03(中断), tree_r02 → tree_r04 → tree_r05}");
  console.log("提醒：数据为占位内容，勿用于试「在此重跑」；删除时按 tree_ 前缀清理。");
}

main();
