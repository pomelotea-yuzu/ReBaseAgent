/**
 * 生成 U1（refactor-run-workspace）结局 fixture 组（开发辅助脚本，不入产品代码路径）。
 *
 * 背景：任务 1.1 要求为「普通成功 / 失败 / 上限 / 中止 / 中断、旧记录、仅工具·仅思维链、
 * 缓存部分覆盖」提供可重复生成的确定性数据，以验证四条断言：
 *   ① 正常结束直接看到最终输出
 *   ② 旧失败记录没有错误详情
 *   ③ 限制中止与中断如实展示
 *   ④ 无最终正文不借用祖先补全
 *
 * 本脚本用 JsonlTracer 直接写出**结构合法**的 trace（零 API、零时间依赖）：
 * 所有 created_at / timing 均为固定常量，故同版本脚本重复运行产出逐字节一致的文件。
 *
 * ── 诚实边界（不得据此宣称已验收）────────────────────────────────────
 * 这批数据是「结构合法、按预期结局手工编排」的标本，不是引擎原生运行产物：
 *  - usage 数字是按结局需要编造的，不代表真实计费；
 *  - config_hash 为占位值，**不可**作为 replay 分叉父本（会被既有校验拒绝，属预期）；
 *  - 它们用于验证「派生与展示是否忠实于记录」，不用于验证 loop 行为。
 *
 * ── 与既有 fixture 的关系 ───────────────────────────────────────────
 * 不修改 packages/trace-sdk/fixtures（那是 trace-sdk 的基准数据，被 fixtures.test.ts
 * 逐字段断言）。本组是 U1 自己的结局样本，落 dev 数据目录，只被 U1 的验证用例消费。
 *
 * 用法：node scripts/gen-u1-outcome-fixtures.cjs [目标目录] [--stdout]
 * 默认目标目录 = 仓库根 .rebaseagent/u1-fixtures
 */
"use strict";

const { JsonlTracer } = require("@rebaseagent/trace-sdk");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEFAULT_DIR = join(REPO_ROOT, ".rebaseagent", "u1-fixtures");

const MODEL = "deepseek-chat";
const REASONER = "deepseek-reasoner";
/** 占位指纹：标注「非真实源配置哈希」，不得用于 replay 分叉（见文件头诚实边界） */
const FAKE_HASH = "sha256:u1fixture0000000000000000000000000000000000000000000000000000";
/** 固定基准时刻：所有 timing 相对它递增，保证同输入同输出 */
const T0 = Date.parse("2026-09-21T10:00:00.000Z");

const READ_DEF = {
  name: "read_file",
  description: "读取指定路径的文件",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
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

/**
 * 手工写行的最小写入器。
 *
 * 不用 JsonlTracer 的原因：tracer 的 timing 取真实墙钟（`startSpan`/`endSpan` 时刻），
 * 生成的文件每次运行都不同，与本任务「可重复生成」的要求冲突。
 * 此处直接拼行，只保留 tracer 的**行顺序契约**：run.meta → span… → run.event。
 */
function createWriter() {
  const lines = [];
  return {
    meta(meta) {
      lines.push({ type: "run.meta", ...meta });
    },
    step(id, n, startMs, endMs, parent = null) {
      lines.push({
        type: "span",
        id,
        parent,
        timing: { started_at: iso(startMs), ended_at: iso(endMs) },
        kind: "agent.step",
        n,
      });
      return id;
    },
    llm(id, parent, startMs, endMs, request, response, error) {
      const line = {
        type: "span",
        id,
        parent,
        timing: { started_at: iso(startMs), ended_at: iso(endMs) },
        kind: "llm.call",
        request,
        response,
      };
      // error 是 object|undefined：成功调用省略字段（写入 undefined 会被 JSON.stringify 丢弃）
      if (error !== undefined) line.error = error;
      lines.push(line);
      return id;
    },
    tool(id, parent, startMs, endMs, tool, args, result, error, durMs) {
      lines.push({
        type: "span",
        id,
        parent,
        timing: { started_at: iso(startMs), ended_at: iso(endMs) },
        kind: "tool.invoke",
        tool,
        args,
        result,
        dur_ms: durMs,
        error,
      });
      return id;
    },
    event(event, reason, at) {
      lines.push({ type: "run.event", event, reason, at });
    },
    text() {
      return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    },
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** 请求体：完整系统提示 + 用户任务（保证「完整原始请求」在详情里可读） */
function request(model, messages, params = {}) {
  return { model, messages, tools: [READ_DEF, WRITE_DEF], params };
}

/** 一次成功的 llm.call（无 error 字段） */
function okResponse(content, toolCalls = [], usage = { in: 1000, out: 100 }, reasoning = null) {
  return {
    content,
    reasoning_content: reasoning,
    tool_calls: toolCalls,
    usage,
    ttft_ms: 200,
  };
}

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

// ---------------------------------------------------------------------------
// 各组 fixture
// ---------------------------------------------------------------------------

const SYSTEM = "你是文件助手，按用户要求完成文件任务。";
const TASK = "读取 README.md 并把要点写入 summary.md";

/** ① F-OK：普通成功 —— 最后自有 llm.call 有非空正文、无 error、无待执行工具调用 */
function fixtureOk() {
  const w = createWriter();
  w.meta({
    id: "u1_ok",
    format_version: 1,
    task: TASK,
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });

  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 2400);
  w.llm(
    "s_02",
    s1,
    m,
    m + 2200,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: TASK },
    ]),
    okResponse("我先读取 README.md。", [toolCall("call_001", "read_file", { path: "README.md" })], {
      in: 1450,
      out: 96,
    }),
  );
  w.tool(
    "s_03",
    s1,
    m + 2205,
    m + 2210,
    "read_file",
    { path: "README.md" },
    "# ReBaseAgent\n\n本地优先的时间旅行调试器。",
    null,
    5,
  );

  const s4 = w.step("s_04", 2, m + 2500, m + 4800);
  w.llm(
    "s_05",
    s4,
    m + 2500,
    m + 4600,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: TASK },
      { role: "assistant", content: "我先读取 README.md。" },
      {
        role: "tool",
        tool_call_id: "call_001",
        content: "# ReBaseAgent\n\n本地优先的时间旅行调试器。",
      },
    ]),
    okResponse(
      "已写入 summary.md。",
      [
        toolCall("call_002", "write_file", {
          path: "summary.md",
          content: "- 本地优先\n- 时间旅行调试",
        }),
      ],
      { in: 1600, out: 88 },
    ),
  );
  w.tool(
    "s_06",
    s4,
    m + 4605,
    m + 4620,
    "write_file",
    { path: "summary.md", content: "- 本地优先\n- 时间旅行调试" },
    "已写入 32 字节",
    null,
    15,
  );

  const s7 = w.step("s_07", 3, m + 5000, m + 7200);
  // 终局调用：非空正文、无工具调用、无 error ⇒ 概览应直接展示为最终输出
  w.llm(
    "s_08",
    s7,
    m + 5000,
    m + 7000,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: TASK },
      { role: "assistant", content: "已写入 summary.md。" },
      { role: "tool", tool_call_id: "call_002", content: "已写入 32 字节" },
    ]),
    okResponse("任务完成：README.md 的要点已写入 summary.md，共 2 条。", [], { in: 1750, out: 26 }),
  );
  w.event("stopped", "completed", 3);
  return w.text();
}

/** ② F-ERROR：失败 —— error 终止且**自有** llm.call 带 error 详情（可定位到真实调用） */
function fixtureErrorWithDetail() {
  const w = createWriter();
  w.meta({
    id: "u1_error_detail",
    format_version: 1,
    task: TASK,
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });

  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 2000);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1800,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: TASK },
    ]),
    okResponse("我先读取 README.md。", [toolCall("call_001", "read_file", { path: "README.md" })], {
      in: 1400,
      out: 80,
    }),
  );
  w.tool(
    "s_03",
    s1,
    m + 1805,
    m + 1810,
    "read_file",
    { path: "README.md" },
    "# ReBaseAgent",
    null,
    5,
  );

  const s4 = w.step("s_04", 2, m + 2200, m + 3200);
  // 失败调用：占位零用量 + error 详情（概览须定位到它，且零用量不得解释为实际零消费）
  w.llm(
    "s_05",
    s4,
    m + 2200,
    m + 3100,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: TASK },
      { role: "assistant", content: "我先读取 README.md。" },
      { role: "tool", tool_call_id: "call_001", content: "# ReBaseAgent" },
    ]),
    okResponse(null, [], { in: 0, out: 0 }),
    { message: "LLM 端点返回 HTTP 401：invalid api key", status: 401 },
  );
  w.event("errored", "error", 2);
  return w.text();
}

/** ③ F-OLD：旧记录 —— error 终止但**自有** LLM 无 error 详情，仅有工具错误（不得猜原因） */
function fixtureLegacyFailure() {
  const w = createWriter();
  w.meta({
    id: "u1_error_legacy",
    format_version: 1,
    task: "读取不存在的配置并改写",
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });

  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 1500);
  // 老记录形态：无 cache_hit 字段、无 error 详情
  w.llm(
    "s_02",
    s1,
    m,
    m + 1400,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "读取不存在的配置并改写" },
    ]),
    okResponse("读取 config.json。", [toolCall("call_001", "read_file", { path: "config.json" })], {
      in: 900,
      out: 30,
    }),
  );
  // 工具错误：真实记录，可单独定位，但**不得**被断言为终止根因
  w.tool(
    "s_03",
    s1,
    m + 1405,
    m + 1410,
    "read_file",
    { path: "config.json" },
    null,
    "ENOENT: no such file or directory, open 'config.json'",
    5,
  );

  const s4 = w.step("s_04", 2, m + 1700, m + 2100);
  w.llm(
    "s_05",
    s4,
    m + 1700,
    m + 2000,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "读取不存在的配置并改写" },
      { role: "assistant", content: "读取 config.json。" },
      { role: "tool", tool_call_id: "call_001", content: "ENOENT: no such file or directory" },
    ]),
    okResponse("文件不存在，无法继续。", [], { in: 1000, out: 12 }),
  );
  w.event("errored", "error", 2);
  return w.text();
}

/** ④ F-ABORT：中止（aborted）—— 保留最近自有正文为中间输出，不得标为正常成功 */
function fixtureAborted() {
  const w = createWriter();
  w.meta({
    id: "u1_aborted",
    format_version: 1,
    task: "遍历仓库并生成索引",
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });

  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 1800);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1600,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "遍历仓库并生成索引" },
    ]),
    okResponse("先列出目录结构。", [toolCall("call_001", "read_file", { path: "package.json" })], {
      in: 1200,
      out: 45,
    }),
  );
  w.tool(
    "s_03",
    s1,
    m + 1605,
    m + 1612,
    "read_file",
    { path: "package.json" },
    '{"name":"rebaseagent"}',
    null,
    7,
  );

  const s4 = w.step("s_04", 2, m + 2000, m + 3400);
  // 被中止时最后一条自有正文：只能作为「中止前输出」，不是最终结果
  w.llm(
    "s_05",
    s4,
    m + 2000,
    m + 3300,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "遍历仓库并生成索引" },
      { role: "assistant", content: "先列出目录结构。" },
      { role: "tool", tool_call_id: "call_001", content: '{"name":"rebaseagent"}' },
    ]),
    okResponse("继续读取 packages 目录，正在整理各包的入口文件……", [], { in: 1500, out: 60 }),
  );
  w.event("aborted", "aborted", 2);
  return w.text();
}

/** ⑤ F-CRASH：中断 —— 无终止事件（status 由 reader 判为 crashed） */
function fixtureCrashed() {
  const w = createWriter();
  w.meta({
    id: "u1_crashed",
    format_version: 1,
    task: "批量重命名资源文件",
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });

  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 1700);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1500,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "批量重命名资源文件" },
    ]),
    okResponse(
      "先看看 assets 目录。",
      [toolCall("call_001", "read_file", { path: "assets/index.txt" })],
      {
        in: 1100,
        out: 38,
      },
    ),
  );
  w.tool(
    "s_03",
    s1,
    m + 1505,
    m + 1510,
    "read_file",
    { path: "assets/index.txt" },
    "a.png\nb.png",
    null,
    5,
  );

  const s4 = w.step("s_04", 2, m + 1900, m + 3100);
  w.llm(
    "s_05",
    s4,
    m + 1900,
    m + 3000,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "批量重命名资源文件" },
      { role: "assistant", content: "先看看 assets 目录。" },
      { role: "tool", tool_call_id: "call_001", content: "a.png\nb.png" },
    ]),
    okResponse("准备重命名 a.png 与 b.png。", [], { in: 1300, out: 22 }),
  );
  // 刻意不写 run.event：进程中断，无终止事件
  return w.text();
}

/** ⑥ F-REASONING：仅思维链 —— 最后自有调用有 reasoning、无正文、无工具调用 */
function fixtureReasoningOnly() {
  const w = createWriter();
  w.meta({
    id: "u1_reasoning_only",
    format_version: 1,
    task: "评估仓库的测试覆盖策略",
    model: REASONER,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });

  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 2600);
  w.llm(
    "s_02",
    s1,
    m,
    m + 2400,
    request(REASONER, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "评估仓库的测试覆盖策略" },
    ]),
    okResponse(null, [], { in: 1400, out: 320 }, "先看测试目录再判断覆盖策略是否合理。"),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/** ⑦ F-TOOLONLY：仅工具调用 —— 最后自有调用有待执行 tool_calls、正文为空 */
function fixtureToolOnly() {
  const w = createWriter();
  w.meta({
    id: "u1_tool_only",
    format_version: 1,
    task: "读取三个配置文件并汇总",
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });

  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 1900);
  // 有待执行工具调用 ⇒ 不得把空正文当成「已记录最终输出」
  w.llm(
    "s_02",
    s1,
    m,
    m + 1800,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "读取三个配置文件并汇总" },
    ]),
    okResponse(null, [toolCall("call_001", "read_file", { path: "a.json" })], {
      in: 1050,
      out: 18,
    }),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/** ⑧ F-CACHEPART：缓存部分覆盖 —— 部分调用有 cache_hit、部分缺失；含缓冲 0 命中与全未知 */
function fixtureCachePartial() {
  const w = createWriter();
  w.meta({
    id: "u1_cache_partial",
    format_version: 1,
    task: "多轮读取并汇总长文档",
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });

  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 2200);
  // 有命中：800 / 1000
  w.llm(
    "s_02",
    s1,
    m,
    m + 2000,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "多轮读取并汇总长文档" },
    ]),
    okResponse("读取长文档。", [toolCall("call_001", "read_file", { path: "doc.md" })], {
      in: 1000,
      out: 40,
      cache_hit: 800,
      cache_miss: 200,
    }),
  );
  w.tool("s_03", s1, m + 2005, m + 2012, "read_file", { path: "doc.md" }, "…长文档内容…", null, 7);

  const s4 = w.step("s_04", 2, m + 2400, m + 4200);
  // 实测 0 命中（有值，不是未知）
  w.llm(
    "s_05",
    s4,
    m + 2400,
    m + 4000,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "多轮读取并汇总长文档" },
      { role: "assistant", content: "读取长文档。" },
      { role: "tool", tool_call_id: "call_001", content: "…长文档内容…" },
    ]),
    okResponse("继续汇总。", [toolCall("call_002", "read_file", { path: "appendix.md" })], {
      in: 1200,
      out: 55,
      cache_hit: 0,
      cache_miss: 1200,
    }),
  );
  w.tool(
    "s_06",
    s4,
    m + 4005,
    m + 4012,
    "read_file",
    { path: "appendix.md" },
    "…附录内容…",
    null,
    7,
  );

  const s7 = w.step("s_07", 3, m + 4400, m + 6000);
  // 缓存字段整体缺失（未知 ≠ 0）
  w.llm(
    "s_08",
    s7,
    m + 4400,
    m + 5800,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "多轮读取并汇总长文档" },
      { role: "assistant", content: "继续汇总。" },
      { role: "tool", tool_call_id: "call_002", content: "…附录内容…" },
    ]),
    okResponse("已汇总三个文件。", [], { in: 1800, out: 120 }),
  );
  w.event("stopped", "completed", 3);
  return w.text();
}

/**
 * ⑨ 分支对：u1_fork_parent（有自有输出）→ u1_fork_child（**无自有 llm.call**）
 *
 * 用途：验证「无最终正文不借用祖先补全」——子 run 没有自有调用，祖先有正文，
 * 概览必须说「未记录最终输出」而不是把祖先正文当作本次结果。
 */
function fixtureForkParent() {
  const w = createWriter();
  w.meta({
    id: "u1_fork_parent",
    format_version: 1,
    task: "读取 README 并总结",
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });

  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 2000);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1800,
    request(MODEL, [
      { role: "system", content: SYSTEM },
      { role: "user", content: "读取 README 并总结" },
    ]),
    okResponse("我先读取 README.md。", [toolCall("call_001", "read_file", { path: "README.md" })], {
      in: 1300,
      out: 70,
    }),
  );
  w.tool(
    "s_03",
    s1,
    m + 1805,
    m + 1810,
    "read_file",
    { path: "README.md" },
    "# ReBaseAgent",
    null,
    5,
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/** 子 run：只含祖先没走过的工具调用，**没有自有 llm.call**（故无自有正文可展示） */
function fixtureForkChild() {
  const w = createWriter();
  w.meta({
    id: "u1_fork_child",
    format_version: 1,
    task: "读取 README 并总结",
    model: MODEL,
    created_at: iso(T0 + 3600_000),
    parent: "u1_fork_parent",
    fork: {
      at_span: "s_03",
      edit: { field: "result", value: "# ReBaseAgent（被编辑过的 README 内容）" },
    },
    config_hash: FAKE_HASH,
  });

  // 分支文件的 span 挂在**自己的** step 下：读取被编辑后的结果
  const m = T0 + 3600_000;
  const s9 = w.step("s_09", 2, m, m + 900);
  w.tool(
    "s_10",
    s9,
    m + 100,
    m + 110,
    "read_file",
    { path: "README.md" },
    "# ReBaseAgent（被编辑过的 README 内容）",
    null,
    10,
  );
  w.event("stopped", "completed", 2);
  return w.text();
}

// ---------------------------------------------------------------------------
// 清单 + 预期结局表
// ---------------------------------------------------------------------------

const FIXTURES = {
  "u1-ok.jsonl": fixtureOk(),
  "u1-error-detail.jsonl": fixtureErrorWithDetail(),
  "u1-error-legacy.jsonl": fixtureLegacyFailure(),
  "u1-aborted.jsonl": fixtureAborted(),
  "u1-crashed.jsonl": fixtureCrashed(),
  "u1-reasoning-only.jsonl": fixtureReasoningOnly(),
  "u1-tool-only.jsonl": fixtureToolOnly(),
  "u1-cache-partial.jsonl": fixtureCachePartial(),
  "u1-fork-parent.jsonl": fixtureForkParent(),
  "u1-fork-child.jsonl": fixtureForkChild(),
};

/**
 * 预期结局表：1.1 的验收依据。
 *
 * 字段口径与 desktop-ui delta 的「运行概览呈现自有结果与消耗」requirement 对齐：
 *  - status / lastReason：reader 判定结果（无终止事件 ⇒ crashed / reason null）
 *  - ownsLlm：是否存在自有 llm.call
 *  - hasOwnLlmError：自有 llm.call 是否带 error 详情
 *  - finalOutput：正常终止且最后自有调用满足三个条件（非空正文 + 无 error + 无待执行
 *    tool_calls）时才有值；否则 null 表示「未记录最终输出」
 *  - intermediateOutput：非最终输出时保留的最近自有正文（可为 null）
 *  - cacheCoverage：[有 cache_hit 字段的自有 llm.call 数, 自有 llm.call 总数]
 *  - missingErrorDetail：deriveMissingLlmErrorDetail 的预期值
 *
 * ⚠️ 本表是**手工核对过的预期**，不是从实现反推的。用例拿它与真实派生比对；
 * 表与实现对不上时，先判断错的是哪一方，不得直接改表迁就实现。
 */
const EXPECTATIONS = {
  "u1-ok": {
    status: "completed",
    lastReason: "completed",
    outcome: "completed",
    label: "已结束",
    tone: "normal",
    ownsLlm: true,
    hasOwnLlmError: false,
    finalOutput: "任务完成：README.md 的要点已写入 summary.md，共 2 条。",
    intermediateOutput: null,
    cacheCoverage: [0, 3],
    missingErrorDetail: false,
  },
  "u1-error-detail": {
    status: "completed",
    lastReason: "error",
    outcome: "error",
    label: "出错终止",
    tone: "danger",
    ownsLlm: true,
    hasOwnLlmError: true,
    finalOutput: null,
    intermediateOutput: "我先读取 README.md。",
    cacheCoverage: [0, 2],
    missingErrorDetail: false,
  },
  "u1-error-legacy": {
    status: "completed",
    lastReason: "error",
    outcome: "error",
    label: "出错终止",
    tone: "danger",
    ownsLlm: true,
    hasOwnLlmError: false,
    finalOutput: null,
    intermediateOutput: "文件不存在，无法继续。",
    cacheCoverage: [0, 2],
    missingErrorDetail: true,
  },
  "u1-aborted": {
    status: "completed",
    lastReason: "aborted",
    outcome: "aborted",
    label: "已中止",
    tone: "neutral",
    ownsLlm: true,
    hasOwnLlmError: false,
    finalOutput: null,
    intermediateOutput: "继续读取 packages 目录，正在整理各包的入口文件……",
    cacheCoverage: [0, 2],
    missingErrorDetail: false,
  },
  "u1-crashed": {
    status: "crashed",
    lastReason: null,
    outcome: "interrupted",
    label: "运行中断",
    tone: "neutral",
    ownsLlm: true,
    hasOwnLlmError: false,
    finalOutput: null,
    intermediateOutput: "准备重命名 a.png 与 b.png。",
    cacheCoverage: [0, 2],
    missingErrorDetail: false,
  },
  "u1-reasoning-only": {
    status: "completed",
    lastReason: "completed",
    outcome: "completed",
    label: "已结束",
    tone: "normal",
    ownsLlm: true,
    hasOwnLlmError: false,
    finalOutput: null,
    intermediateOutput: null,
    cacheCoverage: [0, 1],
    missingErrorDetail: false,
  },
  "u1-tool-only": {
    status: "completed",
    lastReason: "completed",
    outcome: "completed",
    label: "已结束",
    tone: "normal",
    ownsLlm: true,
    hasOwnLlmError: false,
    finalOutput: null,
    intermediateOutput: null,
    cacheCoverage: [0, 1],
    missingErrorDetail: false,
  },
  "u1-cache-partial": {
    status: "completed",
    lastReason: "completed",
    outcome: "completed",
    label: "已结束",
    tone: "normal",
    ownsLlm: true,
    hasOwnLlmError: false,
    finalOutput: "已汇总三个文件。",
    intermediateOutput: null,
    /** 3 次自有调用中 2 次带 cache_hit 字段 ⇒ 部分覆盖，不得称「全量命中率」 */
    cacheCoverage: [2, 3],
    cacheHitTotal: 800,
    missingErrorDetail: false,
  },
  "u1-fork-parent": {
    status: "completed",
    lastReason: "completed",
    outcome: "completed",
    label: "已结束",
    tone: "normal",
    ownsLlm: true,
    hasOwnLlmError: false,
    finalOutput: "我先读取 README.md。",
    intermediateOutput: null,
    cacheCoverage: [0, 1],
    missingErrorDetail: false,
  },
  "u1-fork-child": {
    status: "completed",
    lastReason: "completed",
    outcome: "completed",
    label: "已结束",
    tone: "normal",
    /** 关键：自有调用数为 0 ⇒ 不借用祖先正文 */
    ownsLlm: false,
    hasOwnLlmError: false,
    finalOutput: null,
    intermediateOutput: null,
    cacheCoverage: [0, 0],
    missingErrorDetail: false,
  },
};

// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const toStdout = args.includes("--stdout");
  const targetArg = args.find((arg) => !arg.startsWith("--"));
  const outDir = targetArg === undefined ? DEFAULT_DIR : resolve(targetArg);

  if (toStdout) {
    for (const [name, text] of Object.entries(FIXTURES)) {
      process.stdout.write(`===== ${name} =====\n${text}`);
    }
    return;
  }

  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(FIXTURES)) {
    writeFileSync(join(outDir, name), text, "utf8");
  }
  writeFileSync(
    join(outDir, "EXPECTED-OUTCOMES.json"),
    `${JSON.stringify(EXPECTATIONS, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `已生成 ${Object.keys(FIXTURES).length} 份 fixture + 预期结局表 → ${outDir}\n`,
  );
}

main();
