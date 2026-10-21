/* eslint-disable */
/**
 * R2.2 任务 7.2 前置：在 **dev 数据目录**里造一个「桌面策略合规」的隔离根 + 一个 v3 实验子，
 * 供 1440/1360/1024/800 宽度、200% 缩放与真键盘全链实机使用。
 *
 * 为什么要重新造根：7.1 的 package-layer 根录的是脚本自赋的 30 万 token 预算，
 * 而桌面唯一限制来源 `MAIN_EXECUTION_LIMITS` 是 10 万 ⇒ 隔离预检按 3.3 的口径
 * **如实拒绝**（`config_unreconstructable`，不静默截小）。这条拒绝本身是 7.2 的实机证据，
 * 但桌面链路还需要一个预算合规的根，故本脚本用与桌面逐字段一致的限制造夹具。
 *
 * 模型：本地受控服务（127.0.0.1:18799，剧本固定）——7.1 已交付真实模型闭环，
 * 7.2 验的是窗口/缩放/键盘/呈现，不再产生真实计费。
 *
 * 用法：node apps/desktop/scripts/r22-72-seed.cjs
 * 产物：.workbuddy/r22-72/seed.json（ids + 期望字节事实）+ dev 数据目录里的两条 run
 */
"use strict";
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { startMockLlmServer } = require("./mock-llm-server.cjs");

const REPO = join(__dirname, "..", "..", "..");
const DATA = join(REPO, ".rebaseagent");
const OUT = join(REPO, ".workbuddy", "r22-72");
const SOURCE = join(OUT, "source");
const SEED_FILE = join(OUT, "seed.json");
const MOCK_PORT = 18799;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;

/** 与 main/execution-config-state.ts 的 MAIN_EXECUTION_LIMITS 逐字段一致 */
const LIMITS = { maxIterations: 10, budget: { maxTotalTokens: 100_000 } };

const ROOT_SYSTEM =
  "你是受控文件助手。必须使用提供的工具，严格按用户给出的顺序执行，不要跳步，也不要凭记忆回答。";
const ROOT_USER = [
  "请严格按顺序完成，每步只做一件事：",
  "1. 调用 read_file 读取 config.txt；",
  '2. 调用 write_file 把 config.txt 的内容写成 "B: parent-final"；',
  "3. 调用 read_file 读取 keep.txt；",
  '4. 调用 write_file 新建 summary.md，内容写成 "root summary B"（保留末尾换行）。',
  "完成后只输出 DONE。不要调用其他工具。",
].join("\n");

/** 种子子的启动指令（真键盘批会在 GUI 里粘贴等价文本） */
const CHILD_SYSTEM =
  "你是受控换行核对助手。只按顺序调用 write_file 写出给定内容，然后简述写了哪些文件；不要读取其他文件，不要调用别的工具。";

const HYPOTHESIS =
  "从根初始快照重跑时，子运行文件世界保留初始 A，且 CRLF/空串/末尾换行/新增删除在比较视图里逐字可辨。";
const ACCEPTANCE =
  "config.txt 右侧为 CRLF 且多一行；notes.md 仅差末尾换行；summary.md 右侧为空串；only-child.txt 左侧不存在；blob.bin 逐侧非文本；单侧导出字节与清单一致。";

/** 子的受控剧本：逐条写出 7.2 要核对的换行/空串/二进制/新增形态 */
const CHILD_WRITES = [
  { path: "config.txt", content: "A: initial-config\r\nB-added-line\r\n" },
  { path: "notes.md", content: "A notes" },
  { path: "summary.md", content: "" },
  { path: "only-child.txt", content: "child-only\r\n" },
  { path: "blob.bin", content: "R2272\x00BINARY\x00TAIL" },
];
const CHILD_FINAL_TEXT = `已按顺序写出：\n${CHILD_WRITES.map(
  (w) => `- ${w.path}（${Buffer.byteLength(w.content, "utf8")} 字节）`,
).join(
  "\n",
)}\n\n${"R2.2 7.2 长文本核对段落：比较视图必须在窄档与 200% 缩放下保持可滚动、不撑破外层工作区。".repeat(
  12,
)}`;

const SOURCE_A = {
  "config.txt": "A: initial-config\n",
  "keep.txt": "keep-A\n",
  "notes.md": "A notes\n",
};

function argOf(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writeSource() {
  mkdirSync(SOURCE, { recursive: true });
  for (const [name, content] of Object.entries(SOURCE_A)) {
    const full = join(SOURCE, name);
    // 已经存在且内容不同 ⇒ 停手（夹具不可被静默改写）
    if (existsSync(full) && readFileSync(full, "utf8") !== content) {
      throw new Error(`源夹具 ${name} 已存在且内容不同，停手人工核对`);
    }
    writeFileSync(full, content, "utf8");
  }
}

function runRecord(readRun, id) {
  const file = join(DATA, "traces", `${id}.jsonl`);
  const record = readRun(file);
  return {
    file,
    meta: record.meta,
    spans: record.spans,
    events: record.events,
    status: record.status,
  };
}

function finalStepOf(record) {
  const steps = record.spans.filter((s) => s.kind === "agent.step").sort((a, b) => a.n - b.n);
  return steps.length === 0 ? null : steps[steps.length - 1];
}

function firstLlmOf(record) {
  return record.spans.find((s) => s.kind === "llm.call") ?? null;
}

function terminalReasonOf(record) {
  const event = (record.events ?? []).find((s) => s.event === "stopped");
  return event?.reason ?? null;
}

async function main() {
  const { OpenAiCompatClient } = await import(
    `file:///${join(REPO, "packages/agent-loop/dist/index.js").replace(/\\/g, "/")}`
  );
  const { readRun } = await import(
    `file:///${join(REPO, "packages/trace-sdk/dist/index.js").replace(/\\/g, "/")}`
  );
  const replayUrl = `file:///${join(REPO, "packages/replay/dist/index.js").replace(/\\/g, "/")}`;
  const {
    FILE_TOOLS_V1_DEFINITIONS,
    createIsolatedRun,
    preflightIsolatedPromptReplay,
    promptReplayIsolatedRun,
    readWorkspaceFile,
  } = await import(replayUrl);

  mkdirSync(DATA, { recursive: true });
  writeSource();

  const rootTurns = [
    { toolCalls: [{ id: "r1", name: "read_file", args: JSON.stringify({ path: "config.txt" }) }] },
    {
      toolCalls: [
        {
          id: "r2",
          name: "write_file",
          args: JSON.stringify({ path: "config.txt", content: "B: parent-final" }),
        },
      ],
    },
    { toolCalls: [{ id: "r3", name: "read_file", args: JSON.stringify({ path: "keep.txt" }) }] },
    {
      toolCalls: [
        {
          id: "r4",
          name: "write_file",
          args: JSON.stringify({ path: "summary.md", content: "root summary B\n" }),
        },
      ],
    },
  ];
  const childTurns = CHILD_WRITES.map((w, i) => ({
    toolCalls: [{ id: `c${i + 1}`, name: "write_file", args: JSON.stringify(w) }],
  }));

  const script = {
    turns: rootTurns,
    fallback: { content: "DONE" },
  };
  const mock = await startMockLlmServer({ port: MOCK_PORT, script });
  const report = {
    format_version: 1,
    task: "R2.2 7.2 桌面夹具（受控模型）",
    limits: LIMITS,
    mockBase: MOCK_BASE,
  };
  try {
    const config = {
      baseURL: MOCK_BASE,
      apiKey: "sk-r2272-controlled",
      model: "r2272-control-model",
      systemPrompt: ROOT_SYSTEM,
      tools: FILE_TOOLS_V1_DEFINITIONS,
      params: undefined,
      exec: { cwd: SOURCE, signal: null },
      maxIterations: LIMITS.maxIterations,
      budget: { ...LIMITS.budget },
    };

    // ── 根：隔离采集 + 真实执行（受控剧本）；--reuse-root=<id> 复用既有合规根 ──
    const reused = argOf("reuse-root", "");
    const created =
      reused === ""
        ? await createIsolatedRun({
            dataDir: DATA,
            source: SOURCE,
            config,
            userMessage: ROOT_USER,
            authority: { allowFileWrites: true },
            llm: new OpenAiCompatClient(config),
          })
        : { ok: true, id: reused };
    if (!created.ok) throw new Error(`根创建失败：${JSON.stringify(created.failure)}`);
    const root = runRecord(readRun, created.id);
    const rootFinal = finalStepOf(root);
    report.root = {
      id: created.id,
      status: root.status,
      terminalReason: terminalReasonOf(root),
      budget: root.meta.budget ?? root.meta.execution?.budget ?? null,
      maxIterations: root.meta.max_iterations ?? root.meta.maxIterations ?? null,
      configHash: root.meta.config_hash ?? null,
      initialSnapshotId: root.meta.workspace?.initial_snapshot?.id ?? null,
      firstLlmSpanId: firstLlmOf(root)?.id ?? null,
      finalStepId: rootFinal?.id ?? null,
      traceSha256: sha256File(root.file),
      llmCalls: root.spans.filter((s) => s.kind === "llm.call").length,
      toolCalls: root.spans.filter((s) => s.kind === "tool.invoke").length,
    };
    if (root.status !== "completed" || rootFinal === null) {
      throw new Error(`根未正常封存：${root.status} / final=${rootFinal?.id ?? "none"}`);
    }
    if (reused !== "") {
      // 复用模式必须证明这条根就是本脚本口径造出来的（预算/模型/启动指令逐项核对）
      const sys = firstLlmOf(root)?.request?.messages?.[0]?.content;
      const ok =
        root.meta.budget?.max_total_tokens === LIMITS.budget.maxTotalTokens &&
        root.meta.workspace?.origin?.kind === "import" &&
        root.meta.parent === null &&
        root.meta.model === config.model &&
        sys === ROOT_SYSTEM;
      if (!ok) {
        throw new Error(
          `复用根不合口径：budget=${JSON.stringify(root.meta.budget)} origin=${JSON.stringify(root.meta.workspace?.origin)} model=${root.meta.model}`,
        );
      }
      report.root.reused = true;
    }

    // ── 种子子：v3 实验（换行/空串/二进制/新增夹具）───────────────────────
    mock.reset({ turns: childTurns, fallback: { content: CHILD_FINAL_TEXT } });
    const edit = { field: "system_prompt", value: CHILD_SYSTEM };
    const preflight = await preflightIsolatedPromptReplay({
      dataDir: DATA,
      rootId: report.root.id,
      edit,
      config: { ...config, systemPrompt: CHILD_SYSTEM },
      hypothesis: HYPOTHESIS,
      acceptanceCriterion: ACCEPTANCE,
    });
    if (!preflight.ok) throw new Error(`种子子预检失败：${JSON.stringify(preflight.failure)}`);
    const child = await promptReplayIsolatedRun({
      dataDir: DATA,
      rootId: report.root.id,
      edit,
      config: { ...config, systemPrompt: CHILD_SYSTEM },
      authority: { allowFileWrites: true },
      hypothesis: HYPOTHESIS,
      acceptanceCriterion: ACCEPTANCE,
      expectedPlanFingerprint: preflight.value.planFingerprint,
      llm: new OpenAiCompatClient({ ...config, systemPrompt: CHILD_SYSTEM }),
    });
    if (!child.ok) throw new Error(`种子子执行失败：${JSON.stringify(child.failure)}`);
    const childRecord = runRecord(readRun, child.id);
    const childFinal = finalStepOf(childRecord);
    report.seedChild = {
      id: child.id,
      status: childRecord.status,
      terminalReason: terminalReasonOf(childRecord),
      finalStepId: childFinal?.id ?? null,
      formatVersion: childRecord.meta.format_version,
      planFingerprint: preflight.value.planFingerprint,
      initialSnapshotId: childRecord.meta.workspace?.initial_snapshot?.id ?? null,
      traceSha256: sha256File(childRecord.file),
      llmCalls: childRecord.spans.filter((s) => s.kind === "llm.call").length,
      toolCalls: childRecord.spans.filter((s) => s.kind === "tool.invoke").length,
    };

    // ── 期望事实：两侧逐路径字节（比较视图与导出判据的对照）───────────────
    const paths = [
      "config.txt",
      "keep.txt",
      "notes.md",
      "summary.md",
      "only-child.txt",
      "blob.bin",
    ];
    const side = async (runId, stepSpanId, path) => {
      const r = await readWorkspaceFile({ dataDir: DATA, runId, stepSpanId, path });
      const entryBytes = r?.file?.bytes ?? (r?.data ? Buffer.byteLength(r.data) : null);
      return {
        path,
        status: r.status,
        text: r.status === "text" ? r.text : null,
        bytes: entryBytes,
        sha256: r.status === "text" ? sha256Text(r.text) : null,
        reason: r.reason ?? r.failure?.code ?? null,
      };
    };
    report.expected = {
      sourceA: SOURCE_A,
      rootSystem: ROOT_SYSTEM,
      childSystem: CHILD_SYSTEM,
      childWrites: CHILD_WRITES,
      hypothesis: HYPOTHESIS,
      acceptanceCriterion: ACCEPTANCE,
      left: await Promise.all(paths.map((p) => side(report.root.id, report.root.finalStepId, p))),
      right: await Promise.all(
        paths.map((p) => side(report.seedChild.id, report.seedChild.finalStepId, p)),
      ),
    };
    report.mockServed = mock.served?.() ?? null;
    report.readRunSmoke = readRun(root.file).status;
  } finally {
    await mock.close?.().catch?.(() => {});
  }

  writeFileSync(SEED_FILE, JSON.stringify(report, null, 2));
  console.log(
    `种子完成：root=${report.root?.id} final=${report.root?.finalStepId} / ` +
      `child=${report.seedChild?.id} final=${report.seedChild?.finalStepId} / 预算 ${JSON.stringify(report.root?.budget)}`,
  );
  console.log(`证据文件：${SEED_FILE}`);
}

function sha256Text(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
