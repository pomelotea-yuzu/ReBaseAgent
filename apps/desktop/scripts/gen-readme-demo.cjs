/**
 * README 演示数据生成器：为 docs/readme-shots 四张截图重建演示语料。
 *
 * 产出（写入 --out 指定的数据目录）：
 *   - demo_root（隔离根 run）：真实引擎（createIsolatedRun + Mock LLM 剧本）
 *     任务 = 读 README.md / index.js，给 README 补「## 安装」一节；3+1 轮，真实检查点。
 *   - demo_child（隔离续跑）：replayIsolatedRun 从写 README 的 tool 处编辑后续跑。
 *   - demo_chat_a / demo_chat_b（手工 v1 聊天 run）：列表语料。
 *
 * 所有 run 的 model 显示为 deepseek-flash；生成清单落 --out/readme-demo-manifest.json
 * （记录本脚本写入的文件，供拍完截图后清理）。
 *
 * 用法：node scripts/gen-readme-demo.cjs <数据目录>
 */
"use strict";

const { createHash } = require("node:crypto");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { readRun } = require("@rebaseagent/trace-sdk");

const OUT = resolve(process.argv[2]);
if (!OUT || !existsSync(OUT)) throw new Error("用法：node gen-readme-demo.cjs <已存在的数据目录>");

const MODEL = "deepseek-flash";
const T0 = Date.parse("2026-10-16T09:30:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const sha256Buf = (buf) => createHash("sha256").update(buf).digest("hex");

const written = { traces: [], blobs: [] };
function noteTrace(p) {
  written.traces.push(p);
}
function noteBlob(p) {
  written.blobs.push(p);
}

// ── 源目录（与数据目录互为兄弟，validateSourceRoot 拒绝嵌套）───────────────
const outer = mkdtempSync(join(tmpdir(), "readme-demo-"));
const source = join(outer, "source");
const dataDir = join(outer, "data");
mkdirSync(source, { recursive: true });
mkdirSync(join(dataDir, "traces"), { recursive: true });
mkdirSync(join(dataDir, "workspace-blobs", "sha256"), { recursive: true });

const README_ORIG = [
  "# test",
  "",
  "一个用来演示 Agent 文件重跑的测试项目。",
  "",
  "## 简介",
  "",
  "这里原本只有一句话。",
  "",
  "## 用法",
  "",
  "```bash",
  "node index.js",
  "```",
  "",
].join("\n");
const README_EDITED = README_ORIG.replace(
  "## 用法",
  ["## 安装", "", "依赖通过 npm 安装：", "", "```bash", "npm install", "```", "", "## 用法"].join(
    "\n",
  ),
);
const INDEX_JS = [
  "// 演示项目入口：打印一句问候",
  'const msg = "Hello, ReBaseAgent!";',
  "console.log(msg);",
  "",
].join("\n");

writeFileSync(join(source, "README.md"), README_ORIG, "utf8");
writeFileSync(join(source, "index.js"), INDEX_JS, "utf8");

// ── 真实引擎：隔离根 + 编辑后续跑 ─────────────────────────────────────────
class MockLlmClient {
  constructor(script) {
    this.script = script;
    this.turn = 0;
  }
  async complete() {
    const turn = this.script[this.turn];
    this.turn += 1;
    if (turn === undefined) throw new Error(`剧本耗尽：第 ${this.turn} 轮无编排响应`);
    return {
      response: {
        content: turn.content ?? null,
        reasoningContent: null,
        toolCalls: (turn.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        })),
        usage: turn.usage ?? { in: 640, out: 90 },
        ttftMs: 10,
      },
      requestBody: {},
    };
  }
}

async function buildLineage() {
  const {
    createIsolatedRun,
    replayIsolatedRun,
    FILE_TOOLS_V1_DEFINITIONS,
  } = require("@rebaseagent/replay");

  const config = {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-demo",
    model: MODEL,
    systemPrompt: "你是文件助手，按用户要求完成文件任务。",
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
  const TASK =
    "读一下 README.md 和 index.js，然后在 README.md 里补一节「## 安装」，说明用 npm install 装依赖。改完 README.md 就行。";

  const root = await createIsolatedRun({
    dataDir,
    source,
    config,
    userMessage: TASK,
    authority,
    llm: new MockLlmClient([
      { toolCalls: [readCall("c1", "README.md")], usage: { in: 1240, out: 86 } },
      { toolCalls: [readCall("c2", "index.js")], usage: { in: 1520, out: 64 } },
      { toolCalls: [writeCall("c3", "README.md", README_EDITED)], usage: { in: 1810, out: 210 } },
      {
        content: "已把「## 安装」一节补进 README.md，说明用 npm install 装依赖。",
        usage: { in: 2050, out: 42 },
      },
    ]),
  });
  if (!root.ok)
    throw new Error(`createIsolatedRun 失败：${root.failure.code} ${root.failure.reason}`);

  const rootRecord = readRun(join(dataDir, "traces", `${root.id}.jsonl`));
  const writeSpan = rootRecord.spans.find(
    (s) =>
      s.kind === "tool.invoke" &&
      JSON.stringify(s.args).includes("README.md") &&
      s.tool === "write_file",
  );
  if (writeSpan === undefined) throw new Error("根 run 缺少写 README.md 的 span");

  const child = await replayIsolatedRun({
    dataDir,
    parentId: root.id,
    atSpanId: writeSpan.id,
    edit: { field: "result", value: "已写入 README.md（476 字节）【编辑后】" },
    config,
    authority,
    llm: new MockLlmClient([
      { toolCalls: [readCall("c4", "README.md")], usage: { in: 1690, out: 72 } },
      { content: "编辑后的 README.md 已确认，「## 安装」一节完整。", usage: { in: 1880, out: 38 } },
    ]),
  });
  if (!child.ok)
    throw new Error(`replayIsolatedRun 失败：${child.failure.code} ${child.failure.reason}`);

  return { rootId: root.id, childId: child.id, writeSpanId: writeSpan.id };
}

// ── 手工聊天 run（v1 结构，照 r_01 形状）─────────────────────────────────
function chatRun(id, task, turns, endReason) {
  const lines = [];
  const meta = {
    type: "run.meta",
    id,
    format_version: 1,
    task,
    model: MODEL,
    created_at: iso(T0),
    parent: null,
    fork: null,
    config_hash: `sha256:${sha256Buf(Buffer.from(id)).slice(0, 12)}`,
  };
  lines.push(JSON.stringify(meta));
  let t = T0;
  let n = 0;
  const msgs = [{ role: "user", content: task }];
  let sid = 0;
  for (const turn of turns) {
    n += 1;
    t += 1400 + Math.floor(Math.random() * 400);
    const stepStart = iso(t);
    t += turn.durMs ?? 1500;
    const stepEnd = iso(t);
    lines.push(
      JSON.stringify({
        type: "span",
        id: `s_${String(++sid).padStart(2, "0")}`,
        parent: null,
        timing: { started_at: stepStart, ended_at: stepEnd },
        kind: "agent.step",
        n,
      }),
    );
    const stepId = `s_${String(sid).padStart(2, "0")}`;
    lines.push(
      JSON.stringify({
        type: "span",
        id: `s_${String(++sid).padStart(2, "0")}`,
        parent: stepId,
        timing: { started_at: stepStart, ended_at: iso(t - 20) },
        kind: "llm.call",
        request: {
          model: MODEL,
          messages: [...msgs],
          params: { temperature: 0.7 },
        },
        response: {
          content: turn.content,
          reasoning_content: null,
          tool_calls: [],
          usage: { in: turn.inTok, out: turn.outTok },
          ttft_ms: 380,
        },
      }),
    );
    msgs.push({ role: "assistant", content: turn.content });
  }
  lines.push(
    JSON.stringify({
      type: "run.event",
      event: "stopped",
      reason: endReason ?? "completed",
      at: n,
    }),
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { rootId, childId } = await buildLineage();

  // 把引擎产出的 traces + blobs 拷进 OUT 并登记
  for (const f of readdirSync(join(dataDir, "traces"))) {
    copyFileSync(join(dataDir, "traces", f), join(OUT, "traces", f));
    noteTrace(f);
  }
  const blobSrc = join(dataDir, "workspace-blobs", "sha256");
  mkdirSync(join(OUT, "workspace-blobs", "sha256"), { recursive: true });
  for (const f of readdirSync(blobSrc)) {
    const dst = join(OUT, "workspace-blobs", "sha256", f);
    if (!existsSync(dst)) {
      copyFileSync(join(blobSrc, f), dst);
      noteBlob(f);
    }
  }

  // 聊天 run（列表语料）
  const chatA = chatRun("demo_chat_a", "你好你好，吃白饭的大肥鱼，能帮我写一个 README 吗", [
    {
      content: "当然可以！把项目主题和读者告诉我，我先给你搭一节「## 简介」的骨架。",
      inTok: 86,
      outTok: 120,
      durMs: 1200,
    },
    {
      content: "这是按你刚才的描述拟的 README 初稿，看看方向对不对。",
      inTok: 240,
      outTok: 310,
      durMs: 1800,
    },
  ]);
  const chatB = chatRun("demo_chat_b", "大鱼，介绍一下自己", [
    {
      content: "我是一条吃白饭的大肥鱼，擅长把跑歪的 Agent 拉回正道。",
      inTok: 64,
      outTok: 88,
      durMs: 900,
    },
  ]);
  const chatC = chatRun("demo_chat_c", "大肥鱼，介绍一下你自己", [
    {
      content: "我是 demo 里的一条deepseek-flash 鱼，专门演示列表长什么样。",
      inTok: 58,
      outTok: 76,
      durMs: 800,
    },
  ]);
  for (const [name, body] of [
    ["demo_chat_a.jsonl", chatA],
    ["demo_chat_b.jsonl", chatB],
    ["demo_chat_c.jsonl", chatC],
  ]) {
    writeFileSync(join(OUT, "traces", name), body, "utf8");
    noteTrace(name);
  }

  writeFileSync(
    join(OUT, "readme-demo-manifest.json"),
    `${JSON.stringify({ written, rootId, childId, sourceDir: source }, null, 2)}\n`,
    "utf8",
  );
  console.log(`root=${rootId} child=${childId}`);
  console.log(`traces=${written.traces.length} blobs=${written.blobs.length}`);
  console.log(`manifest=${join(OUT, "readme-demo-manifest.json")}`);
}

main().catch((e) => {
  console.error("生成失败：", e?.stack || e);
  process.exit(1);
});
