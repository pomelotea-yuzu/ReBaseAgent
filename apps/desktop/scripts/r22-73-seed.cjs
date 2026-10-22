/* eslint-disable */
/**
 * R2.2 任务 7.3 前置夹具：为「失败与未知路径」实机批造三条**桌面策略合规**的隔离事实。
 *
 * 为什么必须重新造（而不是复用 7.2 夹具）：7.3 要往盘上做真实故障注入（藏附件、改字节、
 * 藏父 trace），不能污染 7.2 已归档的判据夹具；同时比较视图需要三类**形状**：
 *   ① 只在一侧存在的路径（summary.md 仅根最终）⇒ 逐侧状态不互相覆盖；
 *   ② 两侧字节相同的超大文件（big.txt ≈1 MiB）⇒ 正文读取有可测的在飞窗口，迟到判据不空转；
 *   ③ 只在初始快照里、后续从不改写的文件（fault.txt）⇒ 藏/改它的 blob 能如实打出
 *      attachment_missing / attachment_corrupt，且不会牵连别的运行（内容寻址、唯一字节）。
 *
 * 产物（`.workbuddy/r22-73/seed.json`）里带每个故障目标的 blob 物理文件名，
 * 探针只按清单里读出的 sha256 定位文件，不硬编码哈希（重造夹具后不会指错对象）。
 *
 * 模型：本地受控服务（127.0.0.1:18799）——真实模型闭环见 7.1，本批验的是失败/未知路径的
 * 桌面呈现与执行边界，不产生真实计费。
 *
 * 用法：node apps/desktop/scripts/r22-73-seed.cjs
 */
"use strict";
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { startMockLlmServer } = require("./mock-llm-server.cjs");

const REPO = join(__dirname, "..", "..", "..");
const DATA = join(REPO, ".rebaseagent");
const OUT = join(REPO, ".workbuddy", "r22-73");
const SOURCE = join(OUT, "source");
const SEED_FILE = join(OUT, "seed.json");
const MOCK_PORT = 18799;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;

/** 与 main/execution-config-state.ts 的 MAIN_EXECUTION_LIMITS 逐字段一致（UI-VERIFY 硬事实） */
const LIMITS = { maxIterations: 10, budget: { maxTotalTokens: 100_000 } };

const ROOT_SYSTEM =
  "你是受控文件助手。必须使用提供的工具，严格按用户给出的顺序执行，不要跳步，也不要凭记忆回答。";
const ROOT_USER = [
  "请严格按顺序完成，每步只做一件事：",
  "1. 调用 read_file 读取 config.txt；",
  '2. 调用 write_file 把 config.txt 的内容写成 "B: parent-final"（保留末尾换行）；',
  '3. 调用 write_file 新建 summary.md，内容写成 "root summary B"（保留末尾换行）。',
  "不要读取或改写其他任何文件。完成后只输出 DONE。",
].join("\n");

const CHILD_SYSTEM =
  "你是受控失败路径助手。只按顺序调用 write_file 写出给定内容，然后简述写了哪些文件；不要读取任何文件，不要调用别的工具。";
const CHILD_USER = [
  "请严格按顺序完成：",
  '1. 调用 write_file 把 notes.md 写成 "C notes, no trailing newline"（**不要**末尾换行）；',
  '2. 调用 write_file 新建 child-only.txt，内容写成 "child only\\n"。',
  "不要改写 config.txt、big.txt、fault.txt。完成后只输出 DONE。",
].join("\n");

const HYPOTHESIS =
  "7.3 失败注入批：模型失败/缺附件/缺父/旧响应/配置变更下，界面只呈现可信身份与真实结局，不吞草稿、不串页、不补造事实。";
const ACCEPTANCE =
  "失败子运行有真实 ID 且草稿保留；缺附件与缺父给稳定原因且零调用零子记录；迟到核对与迟到正文不安装旧计划、不污染新选择。";

/** 初始快照里后续永不改写的唯一内容 ⇒ 藏/改它的 blob 只影响本夹具 */
const FAULT_CONTENT = "R2273-FAULT-TARGET-unique-bytes-9dd1c2\n";

function bigText() {
  // ≈1 MiB、两侧字节完全相同（同一个 blob）：正文读取有可测耗时，且 diff 两侧一致
  const lines = [];
  for (let i = 1; i <= 26_000; i++) {
    lines.push(`L${String(i).padStart(6, "0")}|R2273-BIG|${"x".repeat(33)}\n`);
  }
  return lines.join("");
}

const SOURCE_A = {
  "config.txt": "A: initial-config\n",
  "keep.txt": "keep-A\n",
  "notes.md": "A notes\n",
  "fault.txt": FAULT_CONTENT,
  "big.txt": bigText(),
};

function sha256Text(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writeSource() {
  mkdirSync(SOURCE, { recursive: true });
  for (const [name, content] of Object.entries(SOURCE_A)) {
    const full = join(SOURCE, name);
    if (existsSync(full) && readFileSync(full, "utf8") !== content) {
      throw new Error(`源夹具 ${name} 已存在且内容不同，停手人工核对（别静默改写既有事实）`);
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
    events: record.events ?? [],
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

function terminalOf(record) {
  const event = record.events.find((s) => s.event === "stopped") ?? record.events[0] ?? null;
  return { event: event?.event ?? null, reason: event?.reason ?? null };
}

/** 步骤 span 上的检查点清单（final 侧的逐路径 sha256） */
function snapshotFilesOf(record, stepSpanId) {
  const span = record.spans.find((s) => s.kind === "agent.step" && s.id === stepSpanId);
  const snap = span?.workspace_snapshot ?? null;
  return { snapshotId: snap?.id ?? null, files: snap?.files ?? [] };
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
          args: JSON.stringify({ path: "config.txt", content: "B: parent-final\n" }),
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "r3",
          name: "write_file",
          args: JSON.stringify({ path: "summary.md", content: "root summary B\n" }),
        },
      ],
    },
  ];
  const childTurns = [
    {
      toolCalls: [
        {
          id: "c1",
          name: "write_file",
          args: JSON.stringify({ path: "notes.md", content: "C notes, no trailing newline" }),
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "c2",
          name: "write_file",
          args: JSON.stringify({ path: "child-only.txt", content: "child only\n" }),
        },
      ],
    },
  ];
  const CHILD_FINAL_TEXT =
    "已写出 notes.md（无末尾换行）与 child-only.txt；config.txt/big.txt/fault.txt 未改动。";

  const mock = await startMockLlmServer({
    port: MOCK_PORT,
    script: { turns: rootTurns, fallback: { content: "DONE" } },
  });
  const report = {
    format_version: 1,
    task: "R2.2 7.3 失败与未知路径实机夹具（受控模型）",
    limits: LIMITS,
    mockBase: MOCK_BASE,
  };
  try {
    const config = {
      baseURL: MOCK_BASE,
      apiKey: "sk-r2273-controlled",
      model: "r2273-control-model",
      systemPrompt: ROOT_SYSTEM,
      tools: FILE_TOOLS_V1_DEFINITIONS,
      params: undefined,
      exec: { cwd: SOURCE, signal: null },
      maxIterations: LIMITS.maxIterations,
      budget: { ...LIMITS.budget },
    };

    const created = await createIsolatedRun({
      dataDir: DATA,
      source: SOURCE,
      config,
      userMessage: ROOT_USER,
      authority: { allowFileWrites: true },
      llm: new OpenAiCompatClient(config),
    });
    if (!created.ok) throw new Error(`根创建失败：${JSON.stringify(created.failure)}`);
    const root = runRecord(readRun, created.id);
    const rootFinal = finalStepOf(root);
    const rootInitial = root.meta.workspace.initial_snapshot;
    const rootFinalSnap = snapshotFilesOf(root, rootFinal?.id ?? "");
    report.root = {
      id: created.id,
      status: root.status,
      terminal: terminalOf(root),
      finalStepId: rootFinal?.id ?? null,
      configHash: root.meta.config_hash ?? null,
      firstLlmSpanId: firstLlmOf(root)?.id ?? null,
      initialSnapshotId: rootInitial.id,
      finalSnapshotId: rootFinalSnap.snapshotId,
      traceSha256: sha256File(root.file),
      llmCalls: root.spans.filter((s) => s.kind === "llm.call").length,
      toolCalls: root.spans.filter((s) => s.kind === "tool.invoke").length,
      budget: root.meta.budget ?? null,
    };
    if (root.status !== "completed" || rootFinal === null) {
      throw new Error(`根未正常封存：${root.status} / final=${rootFinal?.id ?? "none"}`);
    }

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
    if (!preflight.ok) throw new Error(`子预检失败：${JSON.stringify(preflight.failure)}`);
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
    if (!child.ok) throw new Error(`子执行失败：${JSON.stringify(child.failure)}`);
    const childRecord = runRecord(readRun, child.id);
    const childFinal = finalStepOf(childRecord);
    const childFinalSnap = snapshotFilesOf(childRecord, childFinal?.id ?? "");
    report.child = {
      id: child.id,
      status: childRecord.status,
      terminal: terminalOf(childRecord),
      finalStepId: childFinal?.id ?? null,
      formatVersion: childRecord.meta.format_version,
      firstLlmSpanId: firstLlmOf(childRecord)?.id ?? null,
      initialSnapshotId: childRecord.meta.workspace.initial_snapshot.id,
      finalSnapshotId: childFinalSnap.snapshotId,
      baselineRunId: childRecord.meta.prompt_experiment?.baseline_run_id ?? null,
      planFingerprint: preflight.value.planFingerprint,
      traceSha256: sha256File(childRecord.file),
      llmCalls: childRecord.spans.filter((s) => s.kind === "llm.call").length,
      toolCalls: childRecord.spans.filter((s) => s.kind === "tool.invoke").length,
    };
    if (childRecord.meta.format_version !== 3) {
      throw new Error(`子不是 v3 实验记录：format_version=${childRecord.meta.format_version}`);
    }
    // 种子子必须与根同一个初始快照（比较视图「两侧同 blob」判据的前提）
    if (childRecord.meta.workspace.initial_snapshot.id !== rootInitial.id) {
      throw new Error("子初始快照与根不一致，比较夹具的 same 判据会失真");
    }

    const blobOf = (sha) => join(DATA, "workspace-blobs", "sha256", sha);
    const initialByPath = Object.fromEntries(rootInitial.files.map((f) => [f.path, f]));
    const rootFinalByPath = Object.fromEntries(rootFinalSnap.files.map((f) => [f.path, f]));
    const childFinalByPath = Object.fromEntries(childFinalSnap.files.map((f) => [f.path, f]));
    report.blobs = {
      // 故障注入目标：① 初始快照里的 fault.txt（capability 附件校验）
      initialFault: {
        sha256: initialByPath["fault.txt"].sha256,
        file: blobOf(initialByPath["fault.txt"].sha256),
        bytes: initialByPath["fault.txt"].bytes,
      },
      // ② 仅根最终存在的 summary.md（单侧读取错误）
      rootOnlySummary: {
        sha256: rootFinalByPath["summary.md"].sha256,
        file: blobOf(rootFinalByPath["summary.md"].sha256),
        bytes: rootFinalByPath["summary.md"].bytes,
      },
      // ③ 两侧字节相同的大文件（迟到窗口）
      big: {
        sha256: initialByPath["big.txt"].sha256,
        file: blobOf(initialByPath["big.txt"].sha256),
        bytes: initialByPath["big.txt"].bytes,
      },
    };
    // blob 必须真在盘上，且与清单字节数一致
    for (const [name, entry] of Object.entries(report.blobs)) {
      if (!existsSync(entry.file)) throw new Error(`blob 缺失：${name} → ${entry.file}`);
      if (readFileSync(entry.file).length !== entry.bytes) {
        throw new Error(`blob 字节与清单不符：${name}`);
      }
    }
    report.expected = {
      sourceA: Object.fromEntries(
        Object.entries(SOURCE_A).map(([k, v]) => [
          k,
          { bytes: Buffer.byteLength(v, "utf8"), sha256: sha256Text(v) },
        ]),
      ),
      rootSystem: ROOT_SYSTEM,
      childSystem: CHILD_SYSTEM,
      hypothesis: HYPOTHESIS,
      acceptanceCriterion: ACCEPTANCE,
      paths: {
        initial: rootInitial.files.map((f) => f.path).sort(),
        rootFinal: rootFinalSnap.files.map((f) => f.path).sort(),
        childFinal: childFinalSnap.files.map((f) => f.path).sort(),
      },
      texts: {
        configRootFinal: "B: parent-final\n",
        configChildFinal: "A: initial-config\n",
        notesRootFinal: "A notes\n",
        notesChildFinal: "C notes, no trailing newline",
        summaryRootFinal: "root summary B\n",
        childOnly: "child only\n",
        // 大文件只记形状（正文 1.3 MB 不写进证据文件，否则 seed.json 膨胀到 MB 级）
        bigShape: {
          bytes: Buffer.byteLength(SOURCE_A["big.txt"], "utf8"),
          lines: 26_000,
          marker: "R2273-BIG",
        },
      },
    };
    report.mockServed = mock.served?.() ?? null;
  } finally {
    await mock.close?.().catch?.(() => {});
  }

  writeFileSync(SEED_FILE, JSON.stringify(report, null, 2));
  console.log(
    `种子完成：root=${report.root?.id}(final ${report.root?.finalStepId}) / child=${report.child?.id}(final ${report.child?.finalStepId}) / big=${report.blobs?.big.bytes}B`,
  );
  console.log(`证据文件：${SEED_FILE}`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
