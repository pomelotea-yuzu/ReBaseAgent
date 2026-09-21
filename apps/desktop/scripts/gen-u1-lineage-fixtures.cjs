/**
 * 生成 U1（refactor-run-workspace）任务 1.2 的「继承/来源/搜索/坏版本」fixture 组。
 *
 * 1.2 的要求（tasks.md）：
 *   复用并整理隔离多工具/二次分叉、普通 result、prompt、代理和 model_params fixture，
 *   补长任务/长模型/短 ID 碰撞与坏版本数据；记录自有 span/祖先/源及附件哈希，
 *   验证"继承轨迹与独立执行来源""同名运行的短 ID 稳定可辨""非法详情不被概览绕过"
 *   的测试输入确实满足条件。
 *
 * ── 与 1.1 的分工 ─────────────────────────────────────────────────
 *   1.1 = 单个 run 的**结局**形状（成功/失败/上限/中止/中断…）。
 *   1.2 = run 之间的**关系**与**导航**形状（继承 vs 独立执行、同名短 ID、
 *         坏版本拒绝）。两者互补，不重叠。
 *
 * ── 诚实边界（不得据此宣称已验收）────────────────────────────────
 *   ① 隔离组（`u1iso_*`）由**真实引擎路径**产出（`createIsolatedRun` +
 *      `replayIsolatedRun` + Mock LLM），因此带真实 `workspace`/快照/附件哈希——
 *      这部分是引擎原生录制，不是手工编排。
 *   ② 手工组（`u1*`）是手工拼行的**结构合法标本**：`config_hash` 为占位值，
 *      **不可**作为 replay 分叉父本（既有校验会拒绝，属预期）。
 *   ③ 生成物含**绝对临时路径**（隔离组随数据目录变化）⇒ 不追求逐字节可重复；
 *      改为落一份 `MANIFEST.json` 记录关系/哈希，供用例断言。
 *   ④ 本任务**不实现**短 ID / 搜索派生（那是 2.4）——这里只保证"碰撞条件确实成立"。
 *
 * 用法：node scripts/gen-u1-lineage-fixtures.cjs [目标目录]
 * 默认目标目录 = 仓库根 .rebaseagent/u1-lineage
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
const { readRun, JsonlTracer } = require("@rebaseagent/trace-sdk");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEFAULT_DIR = join(REPO_ROOT, ".rebaseagent", "u1-lineage");

const MODEL = "deepseek-chat";
const REASONER = "deepseek-reasoner";
const FAKE_HASH = "sha256:u1lineage000000000000000000000000000000000000000000000000000000";
const T0 = Date.parse("2026-09-21T14:00:00.000Z");

function iso(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// 手工行写入器（与 1.1 同构：固定时间常量 ⇒ 可重复）
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

// ---------------------------------------------------------------------------
// 手工组：关系 / 导航 / 坏版本
// ---------------------------------------------------------------------------

/**
 * ① 普通 result 分叉对：`u1r_parent` → `u1r_child`
 *
 * 用途：验证"继承轨迹与独立执行来源"——result 分叉**共享父前缀**，
 * 详情是 resolveBranch 拼出来的（父 span + 自有 span），自有 span 从 `s_09` 起。
 * 这是与 prompt 分叉（独立执行、零祖先 span）成对的对照物。
 */
function fixtureResultParent() {
  const w = createWriter();
  w.meta({
    id: "u1r_parent",
    format_version: 1,
    task: "读取 README.md 并总结要点",
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
    { model: MODEL, messages: [{ role: "user", content: "读取 README.md 并总结要点" }] },
    {
      content: "我先读取 README.md。",
      reasoning_content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"README.md"}' },
        },
      ],
      usage: { in: 1200, out: 60 },
      ttft_ms: 180,
    },
  );
  w.tool(
    "s_03",
    s1,
    m + 1805,
    m + 1812,
    "read_file",
    { path: "README.md" },
    "# ReBaseAgent（原始内容）",
    null,
    7,
  );
  const s4 = w.step("s_04", 2, m + 2200, m + 3600);
  w.llm(
    "s_05",
    s4,
    m + 2200,
    m + 3400,
    { model: MODEL, messages: [{ role: "user", content: "读取 README.md 并总结要点" }] },
    {
      content: "已总结：这是一个本地优先的调试器。",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 1400, out: 40 },
      ttft_ms: 200,
    },
  );
  w.event("stopped", "completed", 2);
  return w.text();
}

/** 子 run：result 分叉（**共享前缀**），自有 span 从 s_09 起 */
function fixtureResultChild() {
  const w = createWriter();
  w.meta({
    id: "u1r_child",
    format_version: 1,
    task: "读取 README.md 并总结要点",
    model: MODEL,
    created_at: iso(T0 + 3600_000),
    parent: "u1r_parent",
    fork: {
      at_span: "s_03",
      edit: { field: "result", value: "# ReBaseAgent（被编辑过的观察）" },
    },
    config_hash: FAKE_HASH,
  });
  const m = T0 + 3600_000;
  const s9 = w.step("s_09", 2, m, m + 1500);
  w.llm(
    "s_10",
    s9,
    m,
    m + 1300,
    { model: MODEL, messages: [{ role: "user", content: "读取 README.md 并总结要点" }] },
    {
      content: "按编辑后的观察重新总结。",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 1500, out: 30 },
      ttft_ms: 210,
    },
  );
  w.event("stopped", "completed", 2);
  return w.text();
}

/**
 * ② prompt 分叉对：`u1p_parent` → `u1p_child`
 *
 * 用途：验证"独立执行来源"——prompt 分叉**从头重跑**，详情**不含任何祖先 span**，
 * 且轮号从本地第 1 轮重新开始（不沿链累加）。
 */
function fixturePromptParent() {
  const w = createWriter();
  w.meta({
    id: "u1p_parent",
    format_version: 1,
    task: "把要点写入 summary.md",
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
    {
      model: MODEL,
      messages: [
        { role: "system", content: "你是文件助手。" },
        { role: "user", content: "把要点写入 summary.md" },
      ],
    },
    {
      content: "原始 system prompt 下的回答。",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 900, out: 25 },
      ttft_ms: 150,
    },
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/** 子 run：prompt 分叉（**独立执行**），span id 从头从 s_01 编，**无祖先 span** */
function fixturePromptChild() {
  const w = createWriter();
  w.meta({
    id: "u1p_child",
    format_version: 1,
    task: "把要点写入 summary.md",
    model: MODEL,
    created_at: iso(T0 + 3600_000),
    parent: "u1p_parent",
    fork: {
      at_span: "s_01",
      edit: { field: "system_prompt", value: "你是严谨的文件助手，回答必须简短。" },
    },
    config_hash: FAKE_HASH,
  });
  const m = T0 + 3600_000;
  // 关键：span id 从 s_01 重新开始（独立新轨迹，不复用父的编号空间）
  const s1 = w.step("s_01", 1, m, m + 1400);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1200,
    {
      model: MODEL,
      messages: [
        { role: "system", content: "你是严谨的文件助手，回答必须简短。" },
        { role: "user", content: "把要点写入 summary.md" },
      ],
    },
    {
      content: "改后的 system prompt 下重新执行。",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 950, out: 20 },
      ttft_ms: 160,
    },
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/**
 * ③ model_params 分叉臂组：`u1m_parent` → `u1m_arm_a` / `u1m_arm_b`（同批 experimentId）
 *
 * 用途：验证同批 A/B 臂共享 `experimentId`、边标签为「换 model/params（A/B）」，
 * 且两臂的模型与父不同（缓存/模型变化提示的输入条件）。
 */
function fixtureModelAbParent() {
  const w = createWriter();
  w.meta({
    id: "u1m_parent",
    format_version: 1,
    task: "解释这段代码的作用",
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = T0;
  const s1 = w.step("s_01", 1, m, m + 1500);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1300,
    { model: MODEL, messages: [{ role: "user", content: "解释这段代码的作用" }] },
    {
      content: "基线模型回答。",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 800, out: 30 },
      ttft_ms: 140,
    },
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/** A/B 臂：同批 experimentId、不同 model；span id 从 s_01 起（独立执行） */
function fixtureModelAbArm(armId, model, content) {
  const w = createWriter();
  w.meta({
    id: armId,
    format_version: 1,
    task: "解释这段代码的作用",
    model,
    created_at: iso(T0 + 3600_000),
    parent: "u1m_parent",
    fork: {
      at_span: "s_01",
      edit: { field: "model_params", value: { model, params: {}, experimentId: "exp_u1_ab" } },
    },
    config_hash: FAKE_HASH,
  });
  const m = T0 + 3600_000;
  const s1 = w.step("s_01", 1, m, m + 1300);
  w.llm(
    "s_02",
    s1,
    m,
    m + 1100,
    { model, messages: [{ role: "user", content: "解释这段代码的作用" }] },
    { content, reasoning_content: null, tool_calls: [], usage: { in: 820, out: 35 }, ttft_ms: 150 },
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/**
 * ④ 代理录制对：`run_zz01`（代理根）→ `run_zz02`（代理分叉，改 messages）
 *
 * 用途：验证代理来源徽标/筛选、`source.kind === "proxy"`、**无 `config_hash`**
 * （代理录制无源配置可哈希 ⇒ 不可作 replay 父本，只能作代理分叉父本）。
 * id 刻意写成短且有共同后缀的形式，同时服务于下一条"同名短 ID"。
 */
function fixtureProxyRun(id, parent, forkAt, content, whenMs, variant) {
  const w = createWriter();
  const meta = {
    id,
    format_version: 1,
    task: "解释这段代码的作用",
    model: MODEL,
    created_at: iso(whenMs),
    parent,
    fork: null,
    // 关键：代理录制**不写** config_hash（无源配置可哈希）
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
    { model: MODEL, messages: [{ role: "user", content: content }] },
    {
      content: `代理录制响应（${variant}）`,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 600, out: 18 },
      ttft_ms: 120,
    },
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/**
 * ⑤ 同名短 ID 组：3 条 run，刻意构造两种碰撞
 *
 * U1 短 ID 规则（design D3）：从**末尾 8 字符**开始、在全部已加载记录中
 * **按需逐字符延长**、必要时用完整 ID；一个 ID 是另一个的后缀时较长者继续延长。
 *
 * ⚠️ 坑位（本组初版踩过）：短 ID 只切 id 的**末尾**，所以后缀关系必须建立在
 * **整条 id** 上——若给三条都加同一个 `u1s_` 前缀（`u1s_0a1b2c3d4`），
 * 那么 `u1s_x0a1b2c3d4` 并**不**以 `u1s_0a1b2c3d4` 结尾（共享的 `u1s_` 把它挡在中间），
 * 后缀关系根本不成立。故这里让三条 id 自身构成后缀嵌套：
 *   - `zzzz0000a1b2c3d4` 与 `yyyy0000a1b2c3d4` 后 8 位完全相同（`a1b2c3d4`）；
 *   - `0000a1b2c3d4` 是上面两条的**后缀**（更长者须继续延长）。
 * 三种 id 全部以 `0000a1b2c3d4` 收敛，正好同时满足"同 8 位"与"互为后缀"。
 *
 * ⚠️ 这里只保证"碰撞条件成立"；短 ID 算法本身属任务 2.4，未实现。
 */
function fixtureShortIdRun(id, seq) {
  const w = createWriter();
  w.meta({
    id,
    format_version: 1,
    task: "同名任务：整理构建产物",
    model: MODEL,
    created_at: iso(T0 + seq * 60_000),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = T0 + seq * 60_000;
  const s1 = w.step("s_01", 1, m, m + 900);
  w.llm(
    "s_02",
    s1,
    m,
    m + 700,
    { model: MODEL, messages: [{ role: "user", content: "同名任务：整理构建产物" }] },
    {
      content: `第 ${seq} 次执行。`,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 500 + seq, out: 12 },
      ttft_ms: 100,
    },
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/**
 * ⑥ 长任务 / 长模型（导航摘要边界）
 *
 * 用途：验证列表中长 task 与长 model 不遮挡相邻内容、可展开；
 * 空任务回退为来源/时间/短 ID（空任务样本在 ⑦ 坏版本组之外单独给一条）。
 */
function fixtureLongTextRun(id, task, model, seq) {
  const w = createWriter();
  w.meta({
    id,
    format_version: 1,
    task,
    model,
    created_at: iso(T0 + seq * 60_000),
    parent: null,
    fork: null,
    config_hash: FAKE_HASH,
  });
  const m = T0 + seq * 60_000;
  const s1 = w.step("s_01", 1, m, m + 800);
  w.llm(
    "s_02",
    s1,
    m,
    m + 600,
    { model, messages: [{ role: "user", content: task }] },
    {
      content: "完成。",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 400, out: 8 },
      ttft_ms: 90,
    },
  );
  w.event("stopped", "completed", 1);
  return w.text();
}

/** ⑦ 坏版本组：三份「读取必须失败」的文件（非法详情不得被概览绕过） */
function fixtureFutureVersion() {
  const text = fixtureLongTextRun("u1b_future", "未来版本运行", MODEL, 1);
  // v1/v2 双读 ⇒ 未来版本用 3
  return text.replace('"format_version":1', '"format_version":3');
}

function fixtureSchemaBroken() {
  const text = fixtureLongTextRun("u1b_schema", "结构损坏运行", MODEL, 2);
  const lines = text.split("\n").filter((line) => line !== "");
  // 单点破坏：第 2 行的 span 缺 type 字段（读取器报"第 2 行"）
  const broken = { ...JSON.parse(lines[1]), type: undefined };
  lines[1] = JSON.stringify(broken).replace('"type":null,', "").replace('"type":null', '"__err":1');
  return `${lines.join("\n")}\n`;
}

/**
 * v1 非法隔离字段：v1 的 meta 里私带 `workspace`
 * （zod object 会**剥离**未知键，靠 schema 本身拒不了 ⇒ 由版本守卫在 parse 前判定）。
 */
function fixtureV1WithWorkspace() {
  const text = fixtureLongTextRun("u1b_v1ws", "v1 私带隔离字段", MODEL, 3);
  return text.replace(
    `"config_hash":"${FAKE_HASH}"`,
    `"config_hash":"${FAKE_HASH}","workspace":{"world_id":"u1b_v1ws","origin":{"kind":"import"}}`,
  );
}

/** 空任务样本（导航摘要回退条件） */
function fixtureEmptyTask() {
  return fixtureLongTextRun("u1_empty_task", "", MODEL, 4);
}

// ---------------------------------------------------------------------------
// 隔离组：真实引擎路径（createIsolatedRun + replayIsolatedRun + Mock LLM）
// ---------------------------------------------------------------------------

/**
 * 本地 Mock LLM 客户端。
 *
 * 与 `packages/agent-loop/test/helpers.ts` 的 `MockLlmClient` 同形，但用 CommonJS 重写——
 * 那份是 TS 且位于 test/ 下，`.cjs` 脚本无法直接 require（同理也说明为何不能直接复用）。
 * 契约按 `LlmClient` 接口（`complete(messages, signal) → { response, requestBody }`）。
 */
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

/**
 * 产出真实 v2 隔离谱系：
 *
 *   u1iso_root（3 轮：读 a.txt → 写 b.txt → 收尾）
 *     └── u1iso_fork1（多工具轮：从写 b.txt 处续跑，该轮含 2 个工具）
 *           └── u1iso_fork2（二次分叉：轮号必须回到本地第 1 轮，不沿链累加）
 *
 * 这条链同时给出：真实 `workspace`/`resume_after_step`、真实附件哈希、
 * 自有 vs 祖先前缀的 span 边界、以及二次分叉的轮号条件。
 */
async function buildIsolatedLineage(dataDir) {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { writeFileSync } = require("node:fs");
  const {
    createIsolatedRun,
    replayIsolatedRun,
    FILE_TOOLS_V1_DEFINITIONS,
  } = require("@rebaseagent/replay");

  // 源目录与数据目录必须互为兄弟（validateSourceRoot 拒绝嵌套）
  const outer = mkdtempSync(join(tmpdir(), "u1iso-"));
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

  // 一次分叉：从写 b.txt 处续跑；该轮放 2 个工具 ⇒ 覆盖「多工具轮次」
  const fork1 = await replayIsolatedRun({
    dataDir: isoDataDir,
    parentId: root.id,
    atSpanId: writeB.id,
    edit: { field: "result", value: "内容(a.txt)【编辑后】" },
    config,
    authority,
    llm: new MockLlmClient([
      { toolCalls: [readCall("c3", "a.txt"), readCall("c4", "b.txt")] },
      { content: "分叉 1 完成。" },
    ]),
  });
  if (!fork1.ok)
    throw new Error(`replayIsolatedRun 失败：${fork1.failure.code} ${fork1.failure.reason}`);

  const fork1Record = readRun(join(isoDataDir, "traces", `${fork1.id}.jsonl`));
  const fork1Tool = fork1Record.spans.find((s) => s.kind === "tool.invoke");
  if (fork1Tool === undefined) throw new Error("分叉 1 缺少自有 tool.invoke span");

  // 二次分叉：从分叉 1 的自有工具处再续跑 ⇒ 轮号应为本地第 1 轮（不沿链累加）
  const fork2 = await replayIsolatedRun({
    dataDir: isoDataDir,
    parentId: fork1.id,
    atSpanId: fork1Tool.id,
    edit: { field: "result", value: "内容(b.txt)【二次编辑】" },
    config,
    authority,
    llm: new MockLlmClient([
      { toolCalls: [readCall("c5", "a.txt")] },
      { content: "分叉 2 完成。" },
    ]),
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

function main() {
  const targetArg = process.argv[2];
  const outDir = targetArg === undefined ? DEFAULT_DIR : resolve(targetArg);

  // 目标目录必须干净（避免上一轮残留污染清单）
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const tracesDir = join(outDir, "traces");
  mkdirSync(tracesDir, { recursive: true });

  // --- 手工组 ---
  const manual = {
    "u1r_parent.jsonl": fixtureResultParent(),
    "u1r_child.jsonl": fixtureResultChild(),
    "u1p_parent.jsonl": fixturePromptParent(),
    "u1p_child.jsonl": fixturePromptChild(),
    "u1m_parent.jsonl": fixtureModelAbParent(),
    "u1m_arm_a.jsonl": fixtureModelAbArm("u1m_arm_a", "deepseek-chat", "A 臂（同模型）回答。"),
    "u1m_arm_b.jsonl": fixtureModelAbArm("u1m_arm_b", REASONER, "B 臂（换模型）回答。"),
    "run_zz01.jsonl": fixtureProxyRun("run_zz01", null, null, "解释这段代码", T0, "原始"),
    "run_zz02.jsonl": fixtureProxyRun(
      "run_zz02",
      "run_zz01",
      "s_02",
      "解释这段代码",
      T0 + 1800_000,
      "改 messages",
    ),
    // 同名短 ID 组：后 8 位同前缀 + 一条是另一条的后缀（见 fixtureShortIdRun 的坑位说明）
    "zzzz0000a1b2c3d4.jsonl": fixtureShortIdRun("zzzz0000a1b2c3d4", 1),
    "yyyy0000a1b2c3d4.jsonl": fixtureShortIdRun("yyyy0000a1b2c3d4", 2),
    "0000a1b2c3d4.jsonl": fixtureShortIdRun("0000a1b2c3d4", 3),
    // 长任务 / 长模型 / 空任务
    "u1_long_task.jsonl": fixtureLongTextRun(
      "u1_long_task",
      "把仓库里所有 packages 的 README、CHANGELOG、以及 docs 下的规划文档合并成一份跨模块变更摘要，要求保留每个模块的接口不变量、已知缺口与待归属事项，并对冲突口径逐条标注来源文件与行号范围以便后续人工复核",
      MODEL,
      5,
    ),
    "u1_long_model.jsonl": fixtureLongTextRun(
      "u1_long_model",
      "长模型名样本",
      "deepseek-reasoner-2026-09-21-preview-with-an-extremely-long-model-identifier-for-layout-checks",
      6,
    ),
    "u1_empty_task.jsonl": fixtureEmptyTask(),
  };

  for (const [name, text] of Object.entries(manual)) {
    writeFileSync(join(tracesDir, name), text, "utf8");
  }

  // --- 坏版本组（单独子目录：它们**必须读取失败**，不能混进可读语料） ---
  const brokenDir = join(outDir, "broken");
  mkdirSync(brokenDir, { recursive: true });
  const broken = {
    "u1b_future.jsonl": fixtureFutureVersion(),
    "u1b_schema.jsonl": fixtureSchemaBroken(),
    "u1b_v1ws.jsonl": fixtureV1WithWorkspace(),
  };
  for (const [name, text] of Object.entries(broken)) {
    writeFileSync(join(brokenDir, name), text, "utf8");
  }

  // --- 隔离组（真实引擎） ---
  return buildIsolatedLineage(outDir).then((isolated) => {
    // 把隔离谱系的 traces 复制进清单用的单独子目录（避免与手工组混在同一 traces/）
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

    // --- 清单：关系 / 自有 vs 祖先 / 源 / 附件哈希 ---
    const manifest = {
      生成器: "apps/desktop/scripts/gen-u1-lineage-fixtures.cjs",
      说明: "1.2 语料清单。isolated-* 为真实引擎产物（含绝对临时路径，故不追求逐字节可重复）；手工组固定时间常量。",
      关系: {
        result: { parent: "u1r_parent", child: "u1r_child", 语义: "共享父前缀" },
        prompt: { parent: "u1p_parent", child: "u1p_child", 语义: "独立执行，零祖先 span" },
        model_params: {
          parent: "u1m_parent",
          arms: ["u1m_arm_a", "u1m_arm_b"],
          experimentId: "exp_u1_ab",
          语义: "同批 A/B 臂",
        },
        proxy: { parent: "run_zz01", child: "run_zz02", 语义: "代理分叉（改 messages）" },
        isolated: {
          root: isolated.rootId,
          fork1: isolated.fork1Id,
          fork2: isolated.fork2Id,
          语义: "一次分叉 + 二次分叉，真实 v2 隔离谱系",
        },
      },
      短ID碰撞组: ["zzzz0000a1b2c3d4", "yyyy0000a1b2c3d4", "0000a1b2c3d4"],
      坏版本组: Object.keys(broken),
      隔离附件哈希: listBlobs(isolated.dataDir),
      隔离源目录: isolated.sourceDir,
    };

    // 逐条记录：自有 vs 祖先 span 边界 + 源字段（供用例直接断言）
    manifest.轨迹边界 = {};
    for (const [label, file] of [
      ["result_parent", "u1r_parent.jsonl"],
      ["result_child", "u1r_child.jsonl"],
      ["prompt_parent", "u1p_parent.jsonl"],
      ["prompt_child", "u1p_child.jsonl"],
    ]) {
      const record = readRun(join(tracesDir, file));
      manifest.轨迹边界[label] = {
        id: record.meta.id,
        自有spanIds: record.spans.map((s) => s.id),
        parent: record.meta.parent,
        fork字段: record.meta.fork === null ? null : record.meta.fork.edit.field,
        有configHash: record.meta.config_hash !== undefined,
      };
    }
    for (const [label, file, id] of [
      ["isolated_root", null, isolated.rootId],
      ["isolated_fork1", null, isolated.fork1Id],
      ["isolated_fork2", null, isolated.fork2Id],
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
      `已生成 1.2 语料 → ${outDir}\n` +
        `  手工组 ${Object.keys(manual).length} 份 + 坏版本 ${Object.keys(broken).length} 份\n` +
        `  隔离谱系 3 条（真实引擎）：${isolated.rootId} → ${isolated.fork1Id} → ${isolated.fork2Id}\n` +
        `  隔离附件 ${manifest.隔离附件哈希.length} 份，清单 MANIFEST.json\n`,
    );
  });
}

/** 递归复制（避免依赖 fs.cpSync 的版本差异） */
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

main().catch((error) => {
  process.stderr.write(`生成失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
