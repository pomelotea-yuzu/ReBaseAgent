/**
 * 生成 U7（improve-branch-comparison）任务 6.2 的「比较验收标本」组。
 *
 * 6.2 的要求（tasks.md）：
 *   准备隔离测试目录与普通/隔离父子、多跳、兄弟、不同根、prompt、messages、
 *   model_params、ownOnly、错误和长文本标本；索引引用真实来源，生产数据不变。
 *
 * ── 与既有语料的分工 ─────────────────────────────────────────────
 *   u1-lineage（U1 1.2）= 关系/导航/坏版本的通用语料；
 *   本组 = **比较工作区（runs:compare）专用**的链路形状：三跳 result 链、
 *   同父兄弟（含重复 span id）、不同根输入事实、ownOnly 常驻标本、
 *   长文本/缓存形态、短 ID 碰撞四条、真实引擎 v2 隔离三跳。
 *   两者互补，本组不重复 u1 已覆盖的形状。
 *
 * ── 诚实边界（不得据此宣称已验收）────────────────────────────────
 *   ① 手工组（u7c_* / run_u7*）是手工拼行的**结构合法标本**：config_hash
 *      为占位值，不可作为 replay 分叉父本（既有校验会拒绝，属预期）。
 *   ② 隔离组（u7iso_*）由**真实引擎路径**产出（createIsolatedRun +
 *      replayIsolatedRun + Mock LLM），带真实 workspace/快照/附件哈希。
 *   ③ 隔离组含**绝对临时路径** ⇒ 不追求逐字节可重复；MANIFEST.json 记录
 *      关系/边界/哈希，供实机批次（6.4–6.9）与回查脚本断言。
 *   ④ 本任务只保证"标本条件确实成立"；实机验收在 6.4–6.9。
 *
 * ── 生产数据不变 ────────────────────────────────────────────────
 *   产物落在仓库 fixtures 目录（apps/desktop/test/fixtures/u7-compare/），
 *   与 dev 数据目录 .rebaseagent/ 完全隔离。实机批次注入时只拷贝本清单
 *   点名的文件（前缀 u7c_ / run_u7 / 碰撞组 id），批次结束按清单清除。
 *
 * 用法：node scripts/gen-u7-compare-fixtures.cjs [目标目录]
 * 默认目标目录 = apps/desktop/test/fixtures/u7-compare（入库，批次可直接拷贝）
 */
"use strict";

const { createHash } = require("node:crypto");
const {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { readRun } = require("@rebaseagent/trace-sdk");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEFAULT_DIR = join(REPO_ROOT, "apps", "desktop", "test", "fixtures", "u7-compare");

const MODEL = "deepseek-chat";
const REASONER = "deepseek-reasoner";
const FAKE_HASH = "sha256:u7compare000000000000000000000000000000000000000000000000000000";
/** 固定时间常量 ⇒ 手工组逐字节可重复 */
const T0 = Date.parse("2026-09-30T10:00:00.000Z");

function iso(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// 手工行写入器（与 gen-u1-lineage-fixtures 同构）
// ---------------------------------------------------------------------------

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
      // error 是 object|undefined：成功调用省略字段（写 undefined 会被 JSON 丢弃）
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

/** 一次成功 llm 响应（usage 可携带/省略 cache_hit） */
function resp(content, usage, opts = {}) {
  return {
    content,
    reasoning_content: opts.reasoning ?? null,
    tool_calls: opts.toolCalls ?? [],
    usage,
    ttft_ms: opts.ttft ?? 120,
  };
}

// ---------------------------------------------------------------------------
// A. 三跳 result 链 G→P→C + 兄弟 S（重复 span id）
// ---------------------------------------------------------------------------

/** 三跳链祖父：2 轮，s_03 = read_file 工具（P 在此编辑 result） */
function fixtureChainG() {
  const w = createWriter();
  w.meta({
    id: "u7c_g",
    format_version: 1,
    task: "U7 链根：读取 README 并总结",
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 2000);
  // call1 带 cache_hit（有记录）
  w.llm(
    "s_02",
    s1,
    m,
    m + 1800,
    {
      model: MODEL,
      messages: [{ role: "user", content: "读取 README.md 并总结要点" }],
      params: { temperature: 0.5 },
    },
    resp(
      "我先读取 README.md。",
      { in: 1200, out: 60, cache_hit: 800 },
      {
        toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }],
      },
    ),
  );
  // s_03：P/S 侧的编辑点（原值 = 该 tool.invoke.result）
  w.tool(
    "s_03",
    s1,
    m + 1805,
    m + 1812,
    "read_file",
    { path: "README.md" },
    "G 原始观察：README 内容 α",
    null,
    7,
  );
  const s4 = w.step("s_04", 2, m + 2200, m + 3600);
  // call2 无 cache_hit 字段（未记录）⇒ 部分记录形态
  w.llm(
    "s_05",
    s4,
    m + 2200,
    m + 3400,
    { model: MODEL, messages: [{ role: "user", content: "读取 README.md 并总结要点" }] },
    resp("G 完成：这是一个本地优先的调试器。", { in: 1400, out: 40 }),
  );
  w.event("stopped", "completed", 2);
  return w.text();
}

/** 三跳链中代：fork at G.s_03（编辑 result），own s_06..s_10（s_08 = C/S 的编辑点） */
function fixtureChainP() {
  const w = createWriter();
  w.meta({
    id: "u7c_p",
    format_version: 1,
    task: "U7 链中代：按编辑后观察续跑",
    model: MODEL,
    created_at: iso(T0 + 3600_000),
    parent: "u7c_g",
    fork: {
      at_span: "s_03",
      edit: { field: "result", value: "P 编辑后的观察：README 内容 β" },
    },
    config_hash: FAKE_HASH,
  });
  const m = T0 + 3600_000;
  const s6 = w.step("s_06", 3, m, m + 1500);
  w.llm(
    "s_07",
    s6,
    m,
    m + 1300,
    { model: MODEL, messages: [{ role: "user", content: "按编辑后的观察继续" }] },
    resp(
      "我写入总结文件。",
      { in: 1500, out: 35, cache_hit: 900 },
      {
        toolCalls: [{ id: "c2", name: "write_file", args: '{"path":"summary.md","content":"v1"}' }],
      },
    ),
  );
  // s_08：C/S 侧的编辑点（原值 = 该 tool.invoke.result）
  w.tool(
    "s_08",
    s6,
    m + 1305,
    m + 1315,
    "write_file",
    { path: "summary.md", content: "v1" },
    "P 工具结果：summary 已写入 v1",
    null,
    10,
  );
  const s9 = w.step("s_09", 4, m + 1800, m + 3000);
  w.llm(
    "s_10",
    s9,
    m + 1800,
    m + 2900,
    { model: MODEL, messages: [{ role: "user", content: "按编辑后的观察继续" }] },
    resp("P 完成：总结已按编辑后观察更新。", { in: 1600, out: 30 }),
  );
  w.event("stopped", "completed", 4);
  return w.text();
}

/**
 * 三跳链叶代：fork at P.s_08（编辑 result），自有 s_11/s_12。
 * 直接父子对 (P,C) 的编辑证据：原值 = P.s_08 tool result，新值 = 本 fork.edit.value。
 */
function fixtureChainC() {
  const w = createWriter();
  w.meta({
    id: "u7c_c",
    format_version: 1,
    task: "U7 链叶代：二次编辑后续跑",
    model: MODEL,
    created_at: iso(T0 + 7200_000),
    parent: "u7c_p",
    fork: {
      at_span: "s_08",
      edit: { field: "result", value: "C 编辑后的观察：summary 内容 v2" },
    },
    config_hash: FAKE_HASH,
  });
  const m = T0 + 7200_000;
  const s11 = w.step("s_11", 5, m, m + 1400);
  w.llm(
    "s_12",
    s11,
    m,
    m + 1200,
    { model: MODEL, messages: [{ role: "user", content: "按二次编辑后的观察收尾" }] },
    resp("C 完成：最终总结 v2。", { in: 1700, out: 28 }),
  );
  w.event("stopped", "completed", 5);
  return w.text();
}

/**
 * 兄弟臂：与 u7c_c 同父（u7c_p）、同编辑点 s_08、**同自有 span id（s_11/s_12）**。
 * 用途：兄弟两臂逐跳链 + 「重复 span ID 与独立分支不强行对齐」的实机标本。
 */
function fixtureChainS() {
  const w = createWriter();
  w.meta({
    id: "u7c_s",
    format_version: 1,
    task: "U7 链兄弟臂：同点异值编辑",
    model: MODEL,
    created_at: iso(T0 + 7200_000 + 60_000),
    parent: "u7c_p",
    fork: {
      at_span: "s_08",
      edit: { field: "result", value: "S 兄弟编辑后的观察：summary 内容 v2-alt" },
    },
    config_hash: FAKE_HASH,
  });
  const m = T0 + 7200_000 + 60_000;
  const s11 = w.step("s_11", 5, m, m + 1350);
  w.llm(
    "s_12",
    s11,
    m,
    m + 1150,
    { model: MODEL, messages: [{ role: "user", content: "按兄弟臂编辑后的观察收尾" }] },
    resp("S 完成：兄弟臂最终总结。", { in: 1720, out: 26 }),
  );
  w.event("stopped", "completed", 5);
  return w.text();
}

// ---------------------------------------------------------------------------
// B. prompt 组（独立执行；两臂同父同 span id ⇒ 第二组重复 ID 标本）
// ---------------------------------------------------------------------------

/** prompt 父：1 轮，system/user 原值 = own 首次 llm.call */
function fixturePromptParent() {
  const w = createWriter();
  w.meta({
    id: "u7c_pp",
    format_version: 1,
    task: "U7 prompt 父：把要点写入 summary.md",
    model: MODEL,
    created_at: iso(T0 + 600_000),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = T0 + 600_000;
  const s1 = w.step("s_01", 1, m, m + 1800);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1600,
    {
      model: MODEL,
      messages: [
        { role: "system", content: "你是通用文件助手。" },
        { role: "user", content: "把要点写入 summary.md" },
      ],
      params: { temperature: 0.7 },
    },
    resp("原始 prompt 下的回答。", { in: 900, out: 25 }),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/** prompt 臂 1：system_prompt 编辑（独立执行，span 从 s_01 重编） */
function fixturePromptArmSystem() {
  const w = createWriter();
  w.meta({
    id: "u7c_pc1",
    format_version: 1,
    task: "U7 prompt 臂 A：改 system",
    model: MODEL,
    created_at: iso(T0 + 660_000),
    parent: "u7c_pp",
    fork: {
      at_span: "s_01",
      edit: { field: "system_prompt", value: "你是严谨的文件助手，回答必须给出依据。" },
    },
    config_hash: FAKE_HASH,
  });
  const m = T0 + 660_000;
  const s1 = w.step("s_01", 1, m, m + 1400);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1200,
    {
      model: MODEL,
      messages: [
        { role: "system", content: "你是严谨的文件助手，回答必须给出依据。" },
        { role: "user", content: "把要点写入 summary.md" },
      ],
    },
    resp("严谨版回答（有依据）。", { in: 950, out: 22 }),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/** prompt 臂 2：user_message 编辑（独立执行，span 从 s_01 重编 ⇒ 与臂 A 重复 s_01/s_02） */
function fixturePromptArmUser() {
  const w = createWriter();
  w.meta({
    id: "u7c_pc2",
    format_version: 1,
    task: "U7 prompt 臂 B：改 user",
    model: MODEL,
    created_at: iso(T0 + 720_000),
    parent: "u7c_pp",
    fork: {
      at_span: "s_01",
      edit: { field: "user_message", value: "只保留三条要点写入 summary.md" },
    },
    config_hash: FAKE_HASH,
  });
  const m = T0 + 720_000;
  const s1 = w.step("s_01", 1, m, m + 1380);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1180,
    {
      model: MODEL,
      messages: [
        { role: "system", content: "你是通用文件助手。" },
        { role: "user", content: "只保留三条要点写入 summary.md" },
      ],
    },
    resp("三条要点版回答。", { in: 930, out: 21 }),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

// ---------------------------------------------------------------------------
// C. 代理 messages 对（run_u7m1 → run_u7m2）
// ---------------------------------------------------------------------------

function fixtureProxyRun(id, parent, forkAt, whenMs, variant) {
  const w = createWriter();
  const meta = {
    id,
    format_version: 1,
    task: "U7 代理标本：解释这段代码",
    model: MODEL,
    created_at: iso(whenMs),
    parent,
    fork: null,
    // 代理录制不写 config_hash（无源配置可哈希）
    source: { kind: "proxy", base_url: "http://127.0.0.1:18799/v1" },
  };
  if (forkAt !== null) {
    meta.fork = {
      at_span: forkAt,
      edit: { field: "messages", value: `改后的 messages（${variant}）` },
    };
  }
  w.meta(meta);
  const m = whenMs;
  const s1 = w.step(forkAt === null ? "s_01" : "s_09", 1, m, m + 1200);
  w.llm(
    forkAt === null ? "s_02" : "s_10",
    s1,
    m,
    m + 1000,
    { model: MODEL, messages: [{ role: "user", content: "解释这段代码" }] },
    resp(`代理录制响应（${variant}）`, { in: 600, out: 18 }),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

// ---------------------------------------------------------------------------
// D. model_params 实验臂组（u7c_ep → u7c_ea / u7c_eb，同批 experimentId）
// ---------------------------------------------------------------------------

function fixtureExperimentParent() {
  const w = createWriter();
  w.meta({
    id: "u7c_ep",
    format_version: 1,
    task: "U7 实验父：解释这段代码的作用",
    model: MODEL,
    created_at: iso(T0 + 900_000),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = T0 + 900_000;
  const s1 = w.step("s_01", 1, m, m + 1500);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1300,
    { model: MODEL, messages: [{ role: "user", content: "解释这段代码的作用" }] },
    resp("基线模型回答。", { in: 800, out: 30 }),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

function fixtureExperimentArm(armId, model, content, whenMs) {
  const w = createWriter();
  w.meta({
    id: armId,
    format_version: 1,
    task: "U7 实验父：解释这段代码的作用",
    model,
    created_at: iso(whenMs),
    parent: "u7c_ep",
    fork: {
      at_span: "s_01",
      edit: {
        field: "model_params",
        value: { model, params: { temperature: 0.7 }, experimentId: "exp_u7_ab" },
      },
    },
    config_hash: FAKE_HASH,
  });
  const m = whenMs;
  const s1 = w.step("s_01", 1, m, m + 1300);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1100,
    { model, messages: [{ role: "user", content: "解释这段代码的作用" }] },
    resp(content, { in: 820, out: 35 }),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

// ---------------------------------------------------------------------------
// E. 不同根对（u7c_d1 / u7c_d2：模型/system/user/params 全不同）
// ---------------------------------------------------------------------------

function fixtureDifferentRoot(id, model, system, user, params, content, whenMs) {
  const w = createWriter();
  w.meta({
    id,
    format_version: 1,
    task: `U7 不同根标本：${id}`,
    model,
    created_at: iso(whenMs),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = whenMs;
  const s1 = w.step("s_01", 1, m, m + 1200);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1000,
    {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      params,
    },
    resp(content, { in: 700, out: 20 }),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

// ---------------------------------------------------------------------------
// F. 错误标本（F-ERROR 形状：errored 事件 + 自有 llm.call 带 error + 占位零用量）
// ---------------------------------------------------------------------------

function fixtureErrorRun() {
  const w = createWriter();
  w.meta({
    id: "u7c_err",
    format_version: 1,
    task: "U7 错误标本：读取并总结",
    model: MODEL,
    created_at: iso(T0 + 1200_000),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = T0 + 1200_000;
  const s1 = w.step("s_01", 1, m, m + 2000);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1800,
    { model: MODEL, messages: [{ role: "user", content: "读取 README.md 并总结" }] },
    resp(
      "我先读取 README.md。",
      { in: 1400, out: 80 },
      {
        toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }],
      },
    ),
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
  // 失败调用：占位零用量 + error 详情（零用量不得解释为实际零消费；无 cache_hit ⇒ 未记录）
  w.llm(
    "s_05",
    s4,
    m + 2200,
    m + 3100,
    { model: MODEL, messages: [{ role: "user", content: "读取 README.md 并总结" }] },
    resp(null, { in: 0, out: 0 }),
    { message: "LLM 端点返回 HTTP 401：invalid api key", status: 401 },
  );
  w.event("errored", "error", 2);
  return w.text();
}

// ---------------------------------------------------------------------------
// G. 长文本对 + 缓存形态（u7c_l1 部分记录 / u7c_l2 零命中）
// ---------------------------------------------------------------------------

/** 构造约 targetChars 字符的长正文：带可查找标记词与编号段落，便于实机复制/查找断言 */
function longText(prefix, marker, targetChars) {
  const lines = [];
  const para = `${prefix}：这是用于比较视图长文本阅读、复制与查找验收的段落。标记词【${marker}】出现在这里。`;
  let total = 0;
  for (let i = 0; total < targetChars; i += 1) {
    const line = `${String(i + 1).padStart(4, "0")} · ${i % 7 === 3 ? `【${marker}】` : ""}${para}`;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

/** u7c_l1：两次调用，call1 无 cache_hit（未记录）、call2 cache_hit=512 ⇒ 部分记录 */
function fixtureLongL1() {
  const w = createWriter();
  const task =
    "U7 长文本标本 A：把仓库里所有模块的 README、CHANGELOG 与 docs 下的规划文档合并成一份跨模块变更摘要，要求保留每个模块的接口不变量、已知缺口与待归属事项，并对冲突口径逐条标注来源文件与行号范围以便后续人工复核（本句刻意写长以覆盖任务名换行与展开的布局验收）";
  w.meta({
    id: "u7c_l1",
    format_version: 1,
    task,
    model: MODEL,
    created_at: iso(T0 + 1500_000),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = T0 + 1500_000;
  const s1 = w.step("s_01", 1, m, m + 2000);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1900,
    { model: MODEL, messages: [{ role: "user", content: task }] },
    resp(
      `我先起草前半部分。\n${longText("A 前半", "金苹果", 6 * 1024)}`,
      { in: 2100, out: 900 },
      {
        toolCalls: [],
      },
    ),
  );
  const s3 = w.step("s_03", 2, m + 2400, m + 4600);
  w.llm(
    "s_04",
    s3,
    m + 2400,
    m + 4400,
    { model: MODEL, messages: [{ role: "user", content: task }] },
    resp(`${longText("A 后半", "银钥匙", 12 * 1024)}\nA 完成。`, {
      in: 3200,
      out: 1100,
      cache_hit: 512,
    }),
  );
  w.event("stopped", "completed", 2);
  return w.text();
}

/** u7c_l2：两次调用都记录 cache_hit=0 ⇒ 零命中（全量计费） */
function fixtureLongL2() {
  const w = createWriter();
  const task =
    "U7 长文本标本 B：为三份历史快照分别生成时间旅行对照说明，逐条列出每次分叉的编辑字段、编辑前后的取值差异，以及各臂随后续跑时实际读取到的观察内容，保证阅读顺序与真实执行时间线一致（本句刻意写长以覆盖任务名换行与展开的布局验收）";
  w.meta({
    id: "u7c_l2",
    format_version: 1,
    task,
    model: REASONER,
    created_at: iso(T0 + 1560_000),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = T0 + 1560_000;
  const s1 = w.step("s_01", 1, m, m + 2100);
  w.llm(
    "s_02",
    s1,
    m,
    m + 2000,
    {
      model: REASONER,
      messages: [
        { role: "system", content: "你是严谨的调试助手。" },
        { role: "user", content: task },
      ],
      params: { temperature: 0.2 },
    },
    resp(
      `B 第一段。\n${longText("B 一", "铜罗盘", 6 * 1024)}`,
      { in: 2600, out: 950, cache_hit: 0 },
      {
        reasoning: "B 的思维链（不参与最终输出比较）。",
      },
    ),
  );
  const s3 = w.step("s_03", 2, m + 2500, m + 4800);
  w.llm(
    "s_04",
    s3,
    m + 2500,
    m + 4600,
    { model: REASONER, messages: [{ role: "user", content: task }], params: { temperature: 0.2 } },
    resp(`${longText("B 二", "铁齿轮", 12 * 1024)}\nB 完成。`, {
      in: 3600,
      out: 1050,
      cache_hit: 0,
    }),
  );
  w.event("stopped", "completed", 2);
  return w.text();
}

// ---------------------------------------------------------------------------
// H. ownOnly 常驻标本（父文件不存在 ⇒ 读取即结构化 ownOnly；树上呈缺父占位）
// ---------------------------------------------------------------------------

function fixtureOrphan() {
  const w = createWriter();
  w.meta({
    id: "u7c_orphan",
    format_version: 1,
    task: "U7 ownOnly 标本：父本已缺失的续跑",
    model: MODEL,
    created_at: iso(T0 + 1800_000),
    parent: "u7c_gone_missing",
    fork: {
      at_span: "s_03",
      edit: { field: "result", value: "父本缺失后仍保留的编辑值" },
    },
    config_hash: FAKE_HASH,
  });
  const m = T0 + 1800_000;
  const s1 = w.step("s_01", 1, m, m + 1300);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1100,
    { model: MODEL, messages: [{ role: "user", content: "按既有观察收尾" }] },
    resp("ownOnly 侧完成。", { in: 1100, out: 24 }),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

// ---------------------------------------------------------------------------
// I. 短 ID 碰撞四条（6.8：同任务/同模型/同 created_at）
//    id 互为后缀嵌套 + 后 8 位相同（短 ID 规则从末尾 8 字符起逐字符延长）
// ---------------------------------------------------------------------------

const COLLISION_IDS = ["qqq7777aabbccdd", "ppp7777aabbccdd", "ooo7777aabbccdd", "7777aabbccdd"];

function fixtureCollisionRun(id, seq) {
  const w = createWriter();
  w.meta({
    id,
    format_version: 1,
    task: "U7 碰撞标本：同名任务（四条同任务同模型同时间）",
    model: MODEL,
    created_at: iso(T0 + 2100_000),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = T0 + 2100_000;
  const s1 = w.step("s_01", 1, m, m + 900 + seq);
  w.llm(
    "s_02",
    s1,
    m,
    m + 700,
    { model: MODEL, messages: [{ role: "user", content: "同名任务：整理构建产物" }] },
    resp(`第 ${seq} 次执行。`, { in: 500 + seq, out: 12 }),
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

// ---------------------------------------------------------------------------
// J. broken 组（读取必须失败；供 6.6 单侧不可读保留另一侧）
// ---------------------------------------------------------------------------

function fixtureFutureVersion() {
  const text = fixtureDifferentRoot(
    "u7c_b_future",
    MODEL,
    "坏版本：未来版本",
    "任务：坏版本",
    { temperature: 0.1 },
    "不应被读到。",
    T0 + 2400_000,
  );
  // v1/v2 双读 ⇒ 未来版本用 3
  return text.replace('"format_version":1', '"format_version":3');
}

/** v1 非法隔离字段：v1 的 meta 里私带 workspace（版本守卫在 parse 前判定） */
function fixtureV1WithWorkspace() {
  const text = fixtureDifferentRoot(
    "u7c_b_v1ws",
    MODEL,
    "坏版本：v1 私带隔离字段",
    "任务：坏版本",
    { temperature: 0.1 },
    "不应被读到。",
    T0 + 2460_000,
  );
  return text.replace(
    `"config_hash":"${FAKE_HASH}"`,
    `"config_hash":"${FAKE_HASH}","workspace":{"world_id":"u7c_b_v1ws","origin":{"kind":"import"}}`,
  );
}

// ---------------------------------------------------------------------------
// K. 隔离组：真实引擎路径（v2 三跳：root → fork1 → fork2）
// ---------------------------------------------------------------------------

class MockLlmClient {
  constructor(script) {
    this.script = script;
    this.turn = 0;
  }

  async complete(_messages, _signal) {
    const turn = this.script[this.turn];
    this.turn += 1;
    if (turn === undefined) {
      throw new Error(`剧本耗尽：第 ${this.turn} 轮无编排响应`);
    }
    return {
      response: {
        content: turn.content ?? null,
        reasoningContent: turn.reasoning ?? null,
        toolCalls: (turn.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        })),
        usage: turn.usage ?? { in: 100, out: 50 },
        ttftMs: 10,
      },
      requestBody: {},
    };
  }
}

async function buildIsolatedLineage(outDir) {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const {
    createIsolatedRun,
    replayIsolatedRun,
    FILE_TOOLS_V1_DEFINITIONS,
  } = require("@rebaseagent/replay");

  // 源目录与数据目录必须互为兄弟（validateSourceRoot 拒绝嵌套）
  const outer = mkdtempSync(join(tmpdir(), "u7iso-"));
  const source = join(outer, "source");
  const isoDataDir = join(outer, "data");
  mkdirSync(source, { recursive: true });
  mkdirSync(isoDataDir, { recursive: true });
  writeFileSync(join(source, "a.txt"), "alpha 内容");
  writeFileSync(join(source, "keep.txt"), "keep");

  const config = {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: MODEL,
    systemPrompt: "你是文件助手。",
    tools: [...FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
  const authority = { allowFileWrites: true };

  const readCall = (id, path) => ({ id, name: "read_file", args: JSON.stringify({ path }) });
  const writeCall = (id, path, content) => ({
    id,
    name: "write_file",
    args: JSON.stringify({ path, content }),
  });

  // 根：3 轮（读 a.txt → 写 b.txt → 收尾）
  const root = await createIsolatedRun({
    dataDir: isoDataDir,
    source,
    config,
    userMessage: "按剧本操作文件",
    authority,
    llm: new MockLlmClient([
      { toolCalls: [readCall("c1", "a.txt")] },
      { toolCalls: [writeCall("c2", "b.txt", "beta 内容")] },
      { content: "根 run 完成。" },
    ]),
  });
  if (!root.ok)
    throw new Error(`createIsolatedRun 失败：${root.failure.code} ${root.failure.reason}`);

  const rootRecord = readRun(join(isoDataDir, "traces", `${root.id}.jsonl`));
  const writeB = rootRecord.spans.find(
    (s) => s.kind === "tool.invoke" && JSON.stringify(s.args).includes("b.txt"),
  );
  if (writeB === undefined) throw new Error("根 run 缺少写 b.txt 的 span");

  // 一次分叉：从写 b.txt 处续跑，编辑该工具的 result
  const fork1 = await replayIsolatedRun({
    dataDir: isoDataDir,
    parentId: root.id,
    atSpanId: writeB.id,
    edit: { field: "result", value: "内容(b.txt)【一次编辑】" },
    config,
    authority,
    llm: new MockLlmClient([
      { toolCalls: [readCall("c3", "b.txt")] },
      { content: "分叉 1 完成。" },
    ]),
  });
  if (!fork1.ok)
    throw new Error(`replayIsolatedRun 失败：${fork1.failure.code} ${fork1.failure.reason}`);

  const fork1Record = readRun(join(isoDataDir, "traces", `${fork1.id}.jsonl`));
  const fork1Tool = fork1Record.spans.find((s) => s.kind === "tool.invoke");
  if (fork1Tool === undefined) throw new Error("分叉 1 缺少自有 tool.invoke span");

  // 二次分叉：从分叉 1 的自有工具处再续跑 ⇒ v2 混合链三跳
  const fork2 = await replayIsolatedRun({
    dataDir: isoDataDir,
    parentId: fork1.id,
    atSpanId: fork1Tool.id,
    edit: { field: "result", value: "内容(b.txt)【二次编辑】" },
    config,
    authority,
    llm: new MockLlmClient([{ content: "分叉 2 完成。" }]),
  });
  if (!fork2.ok) throw new Error(`二次分叉失败：${fork2.failure.code} ${fork2.failure.reason}`);

  return {
    dataDir: isoDataDir,
    sourceDir: source,
    rootId: root.id,
    fork1Id: fork1.id,
    fork2Id: fork2.id,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listBlobs(dataDir) {
  const dir = join(dataDir, "workspace-blobs", "sha256");
  try {
    return readdirSync(dir)
      .sort()
      .map((name) => ({ name, sha256: sha256File(join(dir, name)) }));
  } catch {
    return [];
  }
}

function copyDir(src, dst) {
  const { mkdirSync: mk, readdirSync: rd, statSync: st, copyFileSync } = require("node:fs");
  mk(dst, { recursive: true });
  for (const name of rd(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    if (st(from).isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

function main() {
  const targetArg = process.argv[2];
  const outDir = targetArg === undefined ? DEFAULT_DIR : resolve(targetArg);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const tracesDir = join(outDir, "traces");
  mkdirSync(tracesDir, { recursive: true });

  // --- 手工组（v1 结构合法标本） ---
  const manual = {
    // A. 三跳 result 链 + 兄弟（重复 span id s_09/s_10）
    "u7c_g.jsonl": fixtureChainG(),
    "u7c_p.jsonl": fixtureChainP(),
    "u7c_c.jsonl": fixtureChainC(),
    "u7c_s.jsonl": fixtureChainS(),
    // B. prompt 组（独立执行；两臂重复 s_01/s_02）
    "u7c_pp.jsonl": fixturePromptParent(),
    "u7c_pc1.jsonl": fixturePromptArmSystem(),
    "u7c_pc2.jsonl": fixturePromptArmUser(),
    // C. 代理 messages 对
    "run_u7m1.jsonl": fixtureProxyRun("run_u7m1", null, null, T0 + 300_000, "原始"),
    "run_u7m2.jsonl": fixtureProxyRun("run_u7m2", "run_u7m1", "s_02", T0 + 330_000, "改 messages"),
    // D. model_params 实验臂
    "u7c_ep.jsonl": fixtureExperimentParent(),
    "u7c_ea.jsonl": fixtureExperimentArm("u7c_ea", MODEL, "A 臂（同模型）回答。", T0 + 960_000),
    "u7c_eb.jsonl": fixtureExperimentArm("u7c_eb", REASONER, "B 臂（换模型）回答。", T0 + 990_000),
    // E. 不同根对
    "u7c_d1.jsonl": fixtureDifferentRoot(
      "u7c_d1",
      MODEL,
      "中文助手 A（U7 不同根）",
      "任务 D1：总结构建日志",
      { temperature: 0.3 },
      "D1 完成。",
      T0 + 1350_000,
    ),
    "u7c_d2.jsonl": fixtureDifferentRoot(
      "u7c_d2",
      REASONER,
      "English assistant B (U7 different roots)",
      "Task D2: summarize build logs",
      { temperature: 0.9, top_p: 0.95 },
      "D2 done.",
      T0 + 1380_000,
    ),
    // F. 错误标本
    "u7c_err.jsonl": fixtureErrorRun(),
    // G. 长文本 + 缓存形态
    "u7c_l1.jsonl": fixtureLongL1(),
    "u7c_l2.jsonl": fixtureLongL2(),
    // H. ownOnly 常驻标本（父 u7c_gone_missing 不存在）
    "u7c_orphan.jsonl": fixtureOrphan(),
    // I. 短 ID 碰撞四条
    ...Object.fromEntries(
      COLLISION_IDS.map((id, i) => [`${id}.jsonl`, fixtureCollisionRun(id, i + 1)]),
    ),
  };

  for (const [name, text] of Object.entries(manual)) {
    writeFileSync(join(tracesDir, name), text, "utf8");
  }

  // --- broken 组（必须读取失败，单独子目录） ---
  const brokenDir = join(outDir, "broken");
  mkdirSync(brokenDir, { recursive: true });
  const broken = {
    "u7c_b_future.jsonl": fixtureFutureVersion(),
    "u7c_b_v1ws.jsonl": fixtureV1WithWorkspace(),
  };
  for (const [name, text] of Object.entries(broken)) {
    writeFileSync(join(brokenDir, name), text, "utf8");
  }

  // --- 隔离组（真实引擎 v2 三跳） ---
  return buildIsolatedLineage(outDir).then((isolated) => {
    const isoTracesDir = join(outDir, "isolated-traces");
    mkdirSync(isoTracesDir, { recursive: true });
    const isoTracesSrc = join(isolated.dataDir, "traces");
    for (const name of readdirSync(isoTracesSrc)) {
      writeFileSync(join(isoTracesDir, name), readFileSync(join(isoTracesSrc, name)));
    }
    const isoBlobsSrc = join(isolated.dataDir, "workspace-blobs");
    const isoBlobsDst = join(outDir, "isolated-blobs");
    if (statSync(isoBlobsSrc, { throwIfNoEntry: false }) !== undefined) {
      copyDir(isoBlobsSrc, isoBlobsDst);
    }

    // --- 清单：关系 / 边界 / 编辑值 / 缓存 / 注入清单 ---
    const manifest = {
      生成器: "apps/desktop/scripts/gen-u7-compare-fixtures.cjs",
      说明:
        "U7 6.2 比较验收标本。isolated-* 为真实引擎产物（含绝对临时路径，不追求逐字节可重复）；手工组固定时间常量。" +
        "实机批次注入：把 traces/*.jsonl 拷入数据目录 traces/，isolated-traces/*.jsonl 拷入 traces/、isolated-blobs/ 拷入 workspace-blobs/；" +
        "批次结束按本清单文件名清除。生产数据目录（.rebaseagent）内既有文件不碰。",
      手工文件: Object.keys(manual),
      坏版本文件: Object.keys(broken).map((n) => `broken/${n}`),
      关系: {
        三跳result链: {
          g: "u7c_g",
          p: "u7c_p",
          c: "u7c_c",
          兄弟: "u7c_s",
          语义: "G→P→C 三跳纯 result 链（共享前缀逐跳合并）；S 与 C 同父同编辑点（s_07）、同自有 span id（s_09/s_10）",
          编辑点P: {
            at_span: "s_03",
            原值: "G 原始观察：README 内容 α",
            新值: "P 编辑后的观察：README 内容 β",
          },
          编辑点C: {
            at_span: "s_08",
            原值: "P 工具结果：summary 已写入 v1",
            新值: "C 编辑后的观察：summary 内容 v2",
          },
          编辑点S: {
            at_span: "s_08",
            原值: "P 工具结果：summary 已写入 v1",
            新值: "S 兄弟编辑后的观察：summary 内容 v2-alt",
          },
        },
        prompt: {
          parent: "u7c_pp",
          arms: ["u7c_pc1", "u7c_pc2"],
          语义: "独立执行（system_prompt / user_message 两类编辑）；两臂 own span 互为 s_01/s_02（第二组重复 ID）",
        },
        proxy: { parent: "run_u7m1", child: "run_u7m2", 语义: "代理分叉（改 messages）" },
        model_params: {
          parent: "u7c_ep",
          arms: ["u7c_ea", "u7c_eb"],
          experimentId: "exp_u7_ab",
          语义: "同批 A/B 臂（同模型 / 换模型）",
        },
        不同根: {
          left: "u7c_d1",
          right: "u7c_d2",
          语义: "模型/system/user/params 全不同（unrelated）",
        },
        ownOnly: {
          id: "u7c_orphan",
          missingRunId: "u7c_gone_missing",
          语义: "父文件不存在 ⇒ 读取即 ownOnly；树上缺父占位",
        },
        碰撞组: COLLISION_IDS,
      },
      缓存形态: {
        部分记录:
          "u7c_g（call1 cache_hit=800、call2 无字段）、u7c_l1（call1 无字段、call2 cache_hit=512）",
        零命中: "u7c_l2（两次 cache_hit=0）",
        未记录: "u7c_err 等其余标本（无 cache_hit 字段）",
        失败占位: "u7c_err（占位零用量 + error 详情）",
      },
      错误标本: {
        id: "u7c_err",
        形状: "errored 事件 + 自有 llm.call(s_05) 带 error{status:401} + 占位零用量",
      },
      长文本: {
        l1: "u7c_l1（输出 ~13KB，标记词：金苹果/银钥匙）",
        l2: "u7c_l2（输出 ~13KB，标记词：铜罗盘/铁齿轮；含 reasoning_content 侧样本）",
      },
      隔离附件哈希: listBlobs(isolated.dataDir),
    };

    // 逐条记录：自有 vs 祖先 span 边界（供实机批次直接断言）
    manifest.轨迹边界 = {};
    const boundaryFiles = [
      ["chain_g", "u7c_g.jsonl"],
      ["chain_p", "u7c_p.jsonl"],
      ["chain_c", "u7c_c.jsonl"],
      ["chain_s", "u7c_s.jsonl"],
      ["prompt_parent", "u7c_pp.jsonl"],
      ["prompt_arm1", "u7c_pc1.jsonl"],
      ["prompt_arm2", "u7c_pc2.jsonl"],
      ["proxy_parent", "run_u7m1.jsonl"],
      ["proxy_child", "run_u7m2.jsonl"],
      ["exp_parent", "u7c_ep.jsonl"],
      ["exp_arm_a", "u7c_ea.jsonl"],
      ["exp_arm_b", "u7c_eb.jsonl"],
      ["diff_root_1", "u7c_d1.jsonl"],
      ["diff_root_2", "u7c_d2.jsonl"],
      ["error", "u7c_err.jsonl"],
      ["long_1", "u7c_l1.jsonl"],
      ["long_2", "u7c_l2.jsonl"],
      ["ownonly", "u7c_orphan.jsonl"],
      ["collision_1", `${COLLISION_IDS[0]}.jsonl`],
      ["collision_2", `${COLLISION_IDS[1]}.jsonl`],
      ["collision_3", `${COLLISION_IDS[2]}.jsonl`],
      ["collision_4", `${COLLISION_IDS[3]}.jsonl`],
    ];
    for (const [label, file] of boundaryFiles) {
      const record = readRun(join(tracesDir, file));
      manifest.轨迹边界[label] = {
        id: record.meta.id,
        自有spanIds: record.spans.map((s) => s.id),
        parent: record.meta.parent,
        fork字段: record.meta.fork === null ? null : record.meta.fork.edit.field,
        有configHash: record.meta.config_hash !== undefined,
      };
    }
    for (const [label, id] of [
      ["isolated_root", isolated.rootId],
      ["isolated_fork1", isolated.fork1Id],
      ["isolated_fork2", isolated.fork2Id],
    ]) {
      const record = readRun(join(isoTracesDir, `${id}.jsonl`));
      manifest.轨迹边界[label] = {
        id: record.meta.id,
        自有spanIds: record.spans.map((s) => s.id),
        parent: record.meta.parent,
        fork字段: record.meta.fork === null ? null : record.meta.fork.edit.field,
        resumeAfterStep: record.meta.fork?.resume_after_step ?? null,
        workspaceWorldId: record.meta.workspace?.world_id ?? null,
        originKind: record.meta.workspace?.origin?.kind ?? null,
        步骤轮号: record.spans.filter((s) => s.kind === "agent.step").map((s) => s.n),
      };
    }

    writeFileSync(join(outDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    process.stdout.write(
      `已生成 U7 6.2 比较标本 → ${outDir}\n` +
        `  手工组 ${Object.keys(manual).length} 份 + 坏版本 ${Object.keys(broken).length} 份\n` +
        `  隔离谱系 3 条（真实引擎 v2）：${isolated.rootId} → ${isolated.fork1Id} → ${isolated.fork2Id}\n` +
        `  隔离附件 ${manifest.隔离附件哈希.length} 份，清单 MANIFEST.json\n`,
    );
  });
}

main().catch((error) => {
  process.stderr.write(`生成失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
