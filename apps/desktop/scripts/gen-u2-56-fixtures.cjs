/**
 * 生成 U2 任务 5.6 的夹具（重启 / 数据目录迁移 / 离线读取）。
 *
 * 5.6 要验的 spec 场景（见 `openspec/changes/improve-workspace-file-reading/specs/desktop-ui/spec.md`）：
 *   - 重启后查看文件差异：**打开完成的隔离子 run**，选择一个**完成步骤的修改文件**
 *     ⇒ 从 trace 引用加载初始/当前文本、显示真实差异与步骤来源，零文件写入、零 LLM
 *   - 数据目录迁移后文件仍可查：整体移动后重启仍可读；只迁 JSONL 时明确显示附件缺失且轨迹可读
 *   - 文件阅读状态不跨进程承诺
 *   - 文件阅读键盘操作与离线加载
 *
 * ── 为什么必须新造夹具（实测 2026-09-24）─────────────────────────────
 *   扫遍 live 的 **25 条隔离 run**：`parent != null` 的**隔离子 run 一条都没有"自有步骤改动文件"**
 *   （子 run 的分叉初始快照 = 父 run 检查点，而它们的自有轮只读不写 ⇒ 初始与自有检查点哈希全同）。
 *   5.6 明确要求"隔离子 run + 完成步骤的**修改**文件"，故必须现造一条**自有轮写入**的续跑者。
 *
 * ── 与本 change 其它夹具的关系 ────────────────────────────────────────
 *   1.1 造"文件阅读语料"、5.4 造"单侧不可用"、5.5 造"IPC 安全 / 只读不变性"，
 *   三者的隔离样本都是**根 run**（或手工镜像）。本脚本只补"**子 run + 自有写入**"这一形态，
 *   目录独立（`u2-file-fixtures-56/`），不覆盖任何既有夹具。
 *
 * 用法：node scripts/gen-u2-56-fixtures.cjs [--no-install]
 */
"use strict";

const { createHash } = require("node:crypto");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { readRun } = require("@rebaseagent/trace-sdk");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const FIX_DIR = join(REPO_ROOT, ".rebaseagent", "u2-file-fixtures-56");
const SOURCE_DIR = join(FIX_DIR, "source"); // 与 data 目录**互为兄弟**（validateSourceRoot 拒绝嵌套）
const DATA_DIR = join(FIX_DIR, "data");
const LIVE_DIR = join(REPO_ROOT, ".rebaseagent");
const INSTALL = !process.argv.includes("--no-install");

const MODEL = "deepseek-chat";
const A_TXT = "alpha 内容（U2 5.6）\n";
const EDIT_R2 = "根第二轮改写\n";
const EDIT_SUB = "子 run 改写\n";

function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Mock LLM（CommonJS 重写 LlmClient 契约，与 1.1 / 5.4 / 5.5 同法） */
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

const readCall = (id, path) => ({ id, name: "read_file", args: JSON.stringify({ path }) });
const writeCall = (id, path, content) => ({
  id,
  name: "write_file",
  args: JSON.stringify({ path, content }),
});

function isoConfig() {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: MODEL,
    systemPrompt: "你是文件助手。",
    tools: [...require("@rebaseagent/replay").FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

function prepareSource() {
  mkdirSync(SOURCE_DIR, { recursive: true });
  writeFileSync(join(SOURCE_DIR, "a.txt"), A_TXT, "utf8");
  writeFileSync(join(SOURCE_DIR, "edit.txt"), "初始版本（5.6）\n", "utf8");
}

/**
 * 真实引擎谱系：
 *   R（根，3 轮）：读 a.txt → **写 edit.txt = 根第二轮改写** → 收尾
 *     └── S（隔离子 run，1 轮）：**写 edit.txt = 子 run 改写** → 收尾
 *   ⇒ S 的 `initial_snapshot` = R 第 2 轮末检查点（edit.txt = 根第二轮改写），
 *     S 自有第 1 轮末 = edit.txt = 子 run 改写 ⇒ **初始 vs 完成步骤有真实差异**。
 */
async function buildLineage() {
  const { createIsolatedRun, replayIsolatedRun } = require("@rebaseagent/replay");
  const config = isoConfig();
  const authority = { allowFileWrites: true };

  const root = await createIsolatedRun({
    dataDir: DATA_DIR,
    source: SOURCE_DIR,
    config,
    userMessage: "先读再写（U2 5.6 根）",
    authority,
    llm: new MockLlmClient([
      { toolCalls: [readCall("c1", "a.txt")] },
      { toolCalls: [writeCall("c2", "edit.txt", EDIT_R2)] },
      { content: "根 run 完成。" },
    ]),
  });
  if (!root.ok)
    throw new Error(`createIsolatedRun 失败：${root.failure.code} ${root.failure.reason}`);

  const rootRecord = readRun(join(DATA_DIR, "traces", `${root.id}.jsonl`));
  const rootSteps = rootRecord.spans.filter((s) => s.kind === "agent.step");
  const writeEdit = rootRecord.spans.find(
    (s) => s.kind === "tool.invoke" && JSON.stringify(s.args).includes("edit.txt"),
  );
  if (writeEdit === undefined) throw new Error("根 run 缺少写 edit.txt 的 span");

  // 子 run：从"根写 edit.txt"那一轮之后续跑，**自有轮自己再写一次** ⇒ 与初始产生真实差异
  const sub = await replayIsolatedRun({
    dataDir: DATA_DIR,
    parentId: root.id,
    atSpanId: writeEdit.id,
    edit: { field: "result", value: "内容(edit.txt)【5.6 子 run】" },
    config,
    authority,
    llm: new MockLlmClient([
      { toolCalls: [writeCall("s1", "edit.txt", EDIT_SUB)] },
      { content: "子 run 完成。" },
    ]),
  });
  if (!sub.ok) throw new Error(`replayIsolatedRun 失败：${sub.failure.code} ${sub.failure.reason}`);

  const subRecord = readRun(join(DATA_DIR, "traces", `${sub.id}.jsonl`));
  const subOwnSteps = subRecord.spans.filter((s) => s.kind === "agent.step");

  return {
    rootId: root.id,
    rootSteps: rootSteps.map((s) => s.id),
    subId: sub.id,
    subOwnSteps: subOwnSteps.map((s) => s.id),
    subParent: subRecord.meta.parent,
    subOrigin: subRecord.meta.workspace?.origin ?? null,
  };
}

/** 从 live 里挑一条**非隔离**的普通 run（优先带父的续跑者 ⇒ 同时能验"编辑入口"） */
function pickNormalRun() {
  const dir = join(LIVE_DIR, "traces");
  const rows = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    try {
      const record = readRun(join(dir, file));
      if (record.meta.workspace !== undefined) continue;
      rows.push({
        id: record.meta.id,
        parent: record.meta.parent,
        steps: record.spans.filter((s) => s.kind === "agent.step").length,
      });
    } catch {
      /* 读不出来的跳过 */
    }
  }
  rows.sort(
    (a, b) => (b.parent !== null ? 1 : 0) - (a.parent !== null ? 1 : 0) || a.id.localeCompare(b.id),
  );
  const chosen =
    rows.find((r) => r.parent !== null && r.steps > 0) ?? rows.find((r) => r.steps > 0);
  if (chosen === undefined) throw new Error("live 里找不到可用的普通（非隔离）run");
  return { ...chosen, root: rows.find((r) => r.parent === null && r.id === chosen.parent) ?? null };
}

function install(ids) {
  const destTraces = join(LIVE_DIR, "traces");
  const destBlobs = join(LIVE_DIR, "workspace-blobs", "sha256");
  mkdirSync(destTraces, { recursive: true });
  mkdirSync(destBlobs, { recursive: true });
  const blobsSrc = join(DATA_DIR, "workspace-blobs", "sha256");
  const result = { traces: [], blobsAdded: 0 };
  for (const id of ids) {
    copyFileSync(join(DATA_DIR, "traces", `${id}.jsonl`), join(destTraces, `${id}.jsonl`));
    result.traces.push(id);
  }
  for (const name of readdirSync(blobsSrc)) {
    const to = join(destBlobs, name);
    if (!existsSync(to)) {
      copyFileSync(join(blobsSrc, name), to);
      result.blobsAdded += 1;
    }
  }
  return result;
}

async function main() {
  rmSync(FIX_DIR, { recursive: true, force: true });
  mkdirSync(FIX_DIR, { recursive: true });
  prepareSource();
  mkdirSync(DATA_DIR, { recursive: true });

  const lineage = await buildLineage();
  const normal = pickNormalRun();
  const { locateWorkspaceSnapshot, readWorkspaceFile } = require("@rebaseagent/replay");

  // ── 自检：用**真实读取 API** 钉住"初始 vs 自有完成步骤确有差异" ──────────
  const subOwnStep = lineage.subOwnSteps[0];
  const readText = async (stepSpanId) => {
    const r = await readWorkspaceFile({
      dataDir: DATA_DIR,
      runId: lineage.subId,
      path: "edit.txt",
      ...(stepSpanId === null ? {} : { stepSpanId }),
    });
    if (r.status !== "text") throw new Error(`子 run edit.txt 期望 text，实得 ${r.status}`);
    return r.text;
  };
  const initialText = await readText(null);
  const ownText = await readText(subOwnStep);
  if (initialText.trim() !== EDIT_R2.trim()) {
    throw new Error(
      `子 run 初始快照的 edit.txt 期望「${EDIT_R2.trim()}」，实得「${initialText.trim()}」`,
    );
  }
  if (ownText.trim() !== EDIT_SUB.trim()) {
    throw new Error(
      `子 run 自有步骤的 edit.txt 期望「${EDIT_SUB.trim()}」，实得「${ownText.trim()}」`,
    );
  }
  const located = locateWorkspaceSnapshot({
    dataDir: DATA_DIR,
    runId: lineage.subId,
    stepSpanId: subOwnStep,
  });
  if (!located.ok) throw new Error(`子 run 自有检查点定位失败：${located.failure.code}`);
  const before = located.value.snapshot.files.find((f) => f.path === "edit.txt");
  const initSnap = locateWorkspaceSnapshot({ dataDir: DATA_DIR, runId: lineage.subId });
  if (!initSnap.ok) throw new Error("子 run 初始快照定位失败");
  const initFile = initSnap.value.snapshot.files.find((f) => f.path === "edit.txt");
  if (before === undefined || initFile === undefined || before.sha256 === initFile.sha256) {
    throw new Error("子 run 的 edit.txt 在初始与自有检查点之间**没有**差异 —— 夹具不成立");
  }

  const manifest = {
    生成器: "apps/desktop/scripts/gen-u2-56-fixtures.cjs",
    说明:
      "5.6（重启 / 迁移 / 离线）专用夹具。R 与 S 均为**真实引擎产物**；" +
      "本脚本只补「隔离子 run 自有轮写入 ⇒ 初始 vs 完成步骤有真实差异」这一形态。",
    数据目录: { fixtureRoot: FIX_DIR, data: DATA_DIR, source: SOURCE_DIR },
    源目录: SOURCE_DIR,
    隔离谱系: {
      root: { id: lineage.rootId, 步骤: lineage.rootSteps },
      sub: {
        id: lineage.subId,
        父: lineage.subParent,
        origin: lineage.subOrigin,
        自有步骤: lineage.subOwnSteps,
        第一轮末: subOwnStep,
      },
    },
    文件世界: {
      a: A_TXT,
      edit初始: "初始版本（5.6）\n",
      edit根第二轮: EDIT_R2,
      edit子run: EDIT_SUB,
    },
    目标文件: "edit.txt",
    普通run: normal,
  };
  writeFileSync(
    join(FIX_DIR, "MANIFEST-56.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  let installed = null;
  if (INSTALL) installed = install([lineage.rootId, lineage.subId]);

  process.stdout.write(
    [
      "已生成 U2 5.6 夹具：",
      `  真实引擎  root=${lineage.rootId}  sub=${lineage.subId}（父 ${lineage.subParent}）`,
      `  目标差异  edit.txt：初始「${EDIT_R2.trim()}」→ 子 run 第 1 轮「${EDIT_SUB.trim()}」`,
      `  普通 run  ${normal.id}（父 ${normal.parent ?? "无"}，${normal.steps} 步）`,
      `  源目录    ${SOURCE_DIR}`,
      installed === null
        ? "  未安装进 live 数据目录（--no-install）"
        : `  已安装：traces=${installed.traces.join(", ")}；新增附件 ${installed.blobsAdded} 份`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`生成失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
