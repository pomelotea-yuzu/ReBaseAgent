import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunConfig, Tool } from "@rebaseagent/agent-loop";
import { runLoop } from "@rebaseagent/agent-loop";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  createIsolatedRun,
  replayIsolatedRun,
} from "@rebaseagent/replay";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../../packages/agent-loop/test/helpers";
import { FORK_ERROR_CODES, runForkCapability, runForkIsolated } from "../src/main/fork-runner";
import { ISOLATED_CREATE_ERROR_CODE, runCreateIsolated } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import { SourceTokenStore } from "../src/main/source-token";
import { inspectWorkspace } from "../src/main/workspace-view";
import { CreateRunRequestSchema, ForkRunRequestSchema } from "../src/shared/ipc";

/**
 * B 任务 1.3 / 1.4 / 1.5 的桌面编排层测试（零真实 API）：
 *
 * - 1.3 `SourceTokenStore`：会话签发 / 一次性消费 / 无效与过期分流；取消不签发由
 *   handler 的 `pickDirectory === null` 分支保证（薄逻辑，dialog 交互归 3.2 CDP 冒烟）。
 * - 1.4 `runCreateIsolated` / `runForkIsolated`：把 A 的 createIsolatedRun /
 *   replayIsolatedRun 接进 runs:create / runs:fork——桌面层只负责 dataDir 注入、
 *   token 换出、错误码映射，**不重定义** profile/配额/授权（那是 A 的唯一事实源）。
 * - 1.5 `runForkCapability`：确认区数据源（ownerRunId/stepSpanId/localIteration），
 *   覆盖"多工具轮次""二次分叉轮号不沿链累加""历史 run 与缺附件降级"三个场景。
 */

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

function isolatedConfig(systemPrompt = "你是文件助手。"): RunConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    systemPrompt,
    tools: [...FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

/** 源目录与数据目录必须互为兄弟（A 的 validateSourceRoot 拒绝嵌套） */
function tempLayout(): { dataDir: string; source: string; cleanup: () => void } {
  const outer = mkdtempSync(join(tmpdir(), "isolated-desktop-flows-"));
  const dataDir = join(outer, "data");
  const source = join(outer, "source");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(source, { recursive: true });
  return { dataDir, source, cleanup: () => rmSync(outer, { recursive: true, force: true }) };
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

/** 整个目录树的指纹（相对路径 + 内容哈希）——"预检/浏览零写入"的判据 */
function treeFingerprint(dir: string): string {
  const acc: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
        continue;
      }
      acc.push(`${rel} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return acc.join("\n");
}

interface ScriptedTurn {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
}

async function createIsolatedParent(
  dataDir: string,
  source: string,
  script: ScriptedTurn[],
  files: Record<string, string> = { "a.txt": "alpha 内容", "keep.txt": "keep" },
): Promise<string> {
  writeTree(source, files);
  const result = await createIsolatedRun({
    dataDir,
    source,
    config: isolatedConfig(),
    userMessage: "按剧本操作文件",
    authority: { allowFileWrites: true },
    llm: new MockLlmClient(script),
  });
  if (!result.ok) {
    throw new Error(`createIsolatedRun 失败：${result.failure.code} ${result.failure.reason}`);
  }
  return result.id;
}

const readCall = (id: string, path: string) => ({
  id,
  name: "read_file",
  args: JSON.stringify({ path }),
});
const writeCall = (id: string, path: string, content: string) => ({
  id,
  name: "write_file",
  args: JSON.stringify({ path, content }),
});

/** 普通 v1 父本（runLoop 真跑、单 read_file 工具、无隔离元数据）——非隔离父本用例共用 */
async function createV1Parent(dataDir: string, source: string): Promise<RunRecord> {
  const pureTool: Tool = {
    name: "read_file",
    description: "读取指定路径的文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sideEffect: false,
    handler: (args) => `内容(${(args as { path: string }).path})`,
  };
  const { handler: _handler, ...def } = pureTool;
  writeTree(source, { "a.txt": "alpha" });
  mkdirSync(join(dataDir, "traces"), { recursive: true });
  const tmp = join(dataDir, "traces", "tmp-parent.jsonl");
  await runLoop(
    { ...isolatedConfig(), tools: [def] },
    [
      { role: "system", content: "你是文件助手。" },
      { role: "user", content: "读 a.txt" },
    ],
    new JsonlTracer(tmp),
    [pureTool],
    new MockLlmClient([{ toolCalls: [readCall("c1", "a.txt")] }, { content: "完成。" }]),
  );
  const record = readRun(tmp);
  renameSync(tmp, join(dataDir, "traces", `${record.meta.id}.jsonl`));
  return record;
}

// ---------------------------------------------------------------------------
// 1.3 sourceToken 会话
// ---------------------------------------------------------------------------

describe("SourceTokenStore：会话签发与一次性消费（B 1.3）", () => {
  it("签发 → 消费换出真实路径；二次消费报 invalid（一次性）", () => {
    const store = new SourceTokenStore();
    // ⚠️ 路径按平台给：`name` 用平台 `basename` 提取末段——Windows 风格的 "D:\some\dir"
    // 在 POSIX 上反斜杠不是分隔符（整串就是 basename），Linux CI 会假红（2026-09-24 实证）。
    const selected = process.platform === "win32" ? "D:\\some\\dir" : "/some/dir";
    const issued = store.issue(selected);
    expect(issued.name).toBe("dir");
    expect(issued.token).toMatch(/^[0-9a-f]{32}$/);

    const consumed = store.consume(issued.token);
    expect(consumed).toEqual({ ok: true, path: selected });
    expect(store.consume(issued.token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("未签发 / 形状不对的 token → invalid", () => {
    const store = new SourceTokenStore();
    expect(store.consume("deadbeef")).toEqual({ ok: false, reason: "invalid" });
    expect(store.consume(undefined)).toEqual({ ok: false, reason: "invalid" });
    expect(store.consume(42)).toEqual({ ok: false, reason: "invalid" });
  });

  it("超过 TTL → expired（且条目已焚毁，不可复活）", async () => {
    const store = new SourceTokenStore(1);
    const issued = store.issue("D:\\x");
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(store.consume(issued.token)).toEqual({ ok: false, reason: "expired" });
    expect(store.consume(issued.token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("expiresAt 按 TTL 推算；同一路径可重复签发（每次操作独立 token）", () => {
    const store = new SourceTokenStore();
    const before = Date.now();
    const first = store.issue("D:\\x");
    const second = store.issue("D:\\x");
    const lower = before + 15 * 60 * 1000;
    expect(Date.parse(first.expiresAt)).toBeGreaterThanOrEqual(lower);
    expect(first.token).not.toBe(second.token);
    expect(store.consume(second.token)).toEqual({ ok: true, path: "D:\\x" });
  });
});

describe("schema 层的授权形状（zod literal(true)）", () => {
  it("runs:create 的 workspace：allowFileWrites 非 true / 多余字段 → 拒绝", () => {
    const base = { mode: "isolated_files", sourceToken: "t" };
    expect(
      CreateRunRequestSchema.safeParse({
        systemPrompt: "",
        userMessage: "hi",
        workspace: { ...base, allowFileWrites: true },
      }).success,
    ).toBe(true);
    expect(
      CreateRunRequestSchema.safeParse({
        systemPrompt: "",
        userMessage: "hi",
        workspace: { ...base, allowFileWrites: false },
      }).success,
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        systemPrompt: "",
        userMessage: "hi",
        workspace: { ...base, allowFileWrites: true, quotaOverride: { max: 1 } },
      }).success,
    ).toBe(false);
  });

  it("runs:fork 的 execution：缺 allowFileWrites / 非 isolated_files 模式 → 拒绝", () => {
    const base = {
      parentRunId: "run_x",
      atSpanId: "s_01",
      edit: { field: "result", value: "v" },
    };
    expect(
      ForkRunRequestSchema.safeParse({
        ...base,
        execution: { mode: "isolated_files", allowFileWrites: true },
      }).success,
    ).toBe(true);
    expect(
      ForkRunRequestSchema.safeParse({ ...base, execution: { mode: "isolated_files" } }).success,
    ).toBe(false);
    expect(
      ForkRunRequestSchema.safeParse({
        ...base,
        execution: { mode: "normal_exec", allowFileWrites: true },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1.4 隔离创建
// ---------------------------------------------------------------------------

describe("runCreateIsolated（B 1.4）", () => {
  it("happy path：v2 根 run 落进 <dataDir>/traces 并可被仓库扫描", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      writeTree(source, { "a.txt": "alpha" });
      const repo = new RunRepository(join(dataDir, "traces"));
      const before = treeFingerprint(source);

      const result = await runCreateIsolated(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: dataDir,
          dataDir,
          sourcePath: source,
          llm: new MockLlmClient([{ toolCalls: [readCall("c1", "a.txt")] }, { content: "完成。" }]),
        },
        {
          systemPrompt: "",
          userMessage: "读一下 a.txt",
          workspace: { mode: "isolated_files", sourceToken: "t", allowFileWrites: true },
        },
      );

      const record = readRun(join(dataDir, "traces", `${result.id}.jsonl`));
      expect(record.meta.format_version).toBe(2);
      expect(record.meta.workspace?.world_id).toBe(result.id);
      expect(record.meta.config_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(repo.listRuns().runs.map((r) => r.id)).toContain(result.id);
      // 源目录逐字节不变
      expect(treeFingerprint(source)).toBe(before);
    } finally {
      cleanup();
    }
  });

  it("源目录与 dataDir 嵌套 → A 边界拒绝透传（ISOLATED_CREATE_FAILED，桌面不预判也不放行）", async () => {
    const { dataDir, cleanup } = tempLayout();
    try {
      const nestedSource = join(dataDir, "source");
      mkdirSync(nestedSource, { recursive: true });
      const repo = new RunRepository(join(dataDir, "traces"));
      await expect(
        runCreateIsolated(
          {
            repository: repo,
            settings: SETTINGS,
            execCwd: dataDir,
            dataDir,
            sourcePath: nestedSource,
          },
          {
            systemPrompt: "",
            userMessage: "hi",
            workspace: { mode: "isolated_files", sourceToken: "t", allowFileWrites: true },
          },
        ),
      ).rejects.toMatchObject({ code: ISOLATED_CREATE_ERROR_CODE });
    } finally {
      cleanup();
    }
  });

  it("模型调用失败 → CREATE_RUN_FAILED 且 error run 已按 meta.id 归位（隔离模式同语义）", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      writeTree(source, { "a.txt": "alpha" });
      const repo = new RunRepository(join(dataDir, "traces"));
      // 空剧本 = 首轮即抛 → runLoop 记 errored 并正常返回
      await expect(
        runCreateIsolated(
          {
            repository: repo,
            settings: SETTINGS,
            execCwd: dataDir,
            dataDir,
            sourcePath: source,
            llm: new MockLlmClient([]),
          },
          {
            systemPrompt: "",
            userMessage: "hi",
            workspace: { mode: "isolated_files", sourceToken: "t", allowFileWrites: true },
          },
        ),
      ).rejects.toMatchObject({ code: "CREATE_RUN_FAILED" });

      const { runs, failed } = repo.listRuns();
      expect(failed).toEqual([]);
      expect(runs).toHaveLength(1);
      const landed = readRun(join(dataDir, "traces", `${runs[0]?.id}.jsonl`));
      expect(landed.status).toBe("completed"); // status=封存态；结局在终止事件（errored）
      expect(landed.meta.format_version).toBe(2);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 1.4 隔离续跑 + 1.5 能力预检
// ---------------------------------------------------------------------------

describe("runForkIsolated（B 1.4）", () => {
  it("happy path：子 run v2、config_hash 同父、resume_after_step 指向父轮 step", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const parentId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt")] },
        { toolCalls: [writeCall("c2", "b.txt", "beta")] },
        { content: "父完成。" },
      ]);
      const parentRecord = readRun(join(dataDir, "traces", `${parentId}.jsonl`));
      const writeSpan = parentRecord.spans.find(
        (s) => s.kind === "tool.invoke" && s.tool === "write_file",
      );
      if (writeSpan?.kind !== "tool.invoke") throw new Error("缺少 write_file span");

      const repo = new RunRepository(join(dataDir, "traces"));
      const fork = await runForkIsolated(
        {
          repository: repo,
          settings: SETTINGS,
          dataDir,
          llm: new MockLlmClient([{ content: "基于编辑后的观察收尾。" }]),
        },
        {
          parentRunId: parentId,
          atSpanId: writeSpan.id,
          edit: { field: "result", value: "内容(a.txt)【编辑后的观察】" },
          execution: { mode: "isolated_files", allowFileWrites: true },
        },
      );

      const child = readRun(join(dataDir, "traces", `${fork.id}.jsonl`));
      expect(child.meta.format_version).toBe(2);
      expect(child.meta.config_hash).toBe(parentRecord.meta.config_hash);
      expect(child.meta.parent).toBe(parentId);
      expect(child.meta.fork?.edit).toEqual({
        field: "result",
        value: "内容(a.txt)【编辑后的观察】",
      });
      // resume_after_step 与 origin.step_span 同源（schema 跨字段约束）
      const origin = child.meta.workspace?.origin;
      if (origin?.kind !== "checkpoint") throw new Error("origin 应为 checkpoint");
      expect(origin.run_id).toBe(parentId);
      expect((child.meta.fork as { resume_after_step?: string }).resume_after_step).toBe(
        origin.step_span,
      );
    } finally {
      cleanup();
    }
  });

  it("空 fork（编辑值与原 result 相同）→ ISOLATED_FORK_FAILED（derive_failed 透传）", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const parentId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt")] },
        { content: "完成。" },
      ]);
      const parentRecord = readRun(join(dataDir, "traces", `${parentId}.jsonl`));
      const readSpan = parentRecord.spans.find((s) => s.kind === "tool.invoke");
      if (readSpan?.kind !== "tool.invoke") throw new Error("缺少 tool.invoke span");
      const original = readSpan.result;

      const repo = new RunRepository(join(dataDir, "traces"));
      await expect(
        runForkIsolated(
          { repository: repo, settings: SETTINGS, dataDir, llm: new MockLlmClient([]) },
          {
            parentRunId: parentId,
            atSpanId: readSpan.id,
            edit: { field: "result", value: original },
            execution: { mode: "isolated_files", allowFileWrites: true },
          },
        ),
      ).rejects.toMatchObject({ code: FORK_ERROR_CODES.ISOLATED_FORK_FAILED });
    } finally {
      cleanup();
    }
  });

  it("非隔离父本带 execution → parent_not_isolated（普通分叉没有文件世界可续）", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const v1Record = await createV1Parent(dataDir, source);
      const repo = new RunRepository(join(dataDir, "traces"));
      await expect(
        runForkIsolated(
          { repository: repo, settings: SETTINGS, dataDir, llm: new MockLlmClient([]) },
          {
            parentRunId: v1Record.meta.id,
            atSpanId: "s_01",
            edit: { field: "result", value: "改" },
            execution: { mode: "isolated_files", allowFileWrites: true },
          },
        ),
      ).rejects.toMatchObject({ code: FORK_ERROR_CODES.ISOLATED_FORK_FAILED });
    } finally {
      cleanup();
    }
  });
});

function renameSyncFixture(from: string, to: string): void {
  renameSync(from, to);
}

describe("U6 5.8：runForkCapability 对不完整来源拒绝，自有文件阅读独立可读", () => {
  it("正对照：根在场时二次分叉父本的 capability 照常给出", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const rootId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt")] },
        { toolCalls: [writeCall("c2", "b.txt", "beta")] },
        { content: "根完成。" },
      ]);
      const rootRecord = readRun(join(dataDir, "traces", `${rootId}.jsonl`));
      const writeB = rootRecord.spans.find(
        (s) => s.kind === "tool.invoke" && s.tool === "write_file",
      );
      if (writeB?.kind !== "tool.invoke") throw new Error("缺少写工具 span");

      const forkB = await replayIsolatedRun({
        dataDir,
        parentId: rootId,
        atSpanId: writeB.id,
        edit: { field: "result", value: "内容(a.txt)【B 的观察】" },
        config: isolatedConfig(),
        authority: { allowFileWrites: true },
        llm: new MockLlmClient([{ toolCalls: [readCall("c4", "b.txt")] }, { content: "B 完成。" }]),
      });
      if (!forkB.ok) throw new Error(`${forkB.failure.code} ${forkB.failure.reason}`);
      const bRecord = readRun(join(dataDir, "traces", `${forkB.id}.jsonl`));
      const bRead = bRecord.spans.find((s) => s.kind === "tool.invoke");
      if (bRead?.kind !== "tool.invoke") throw new Error("B 缺少自有 tool.invoke span");

      const repo = new RunRepository(join(dataDir, "traces"));
      const capability = await runForkCapability(
        { repository: repo, settings: SETTINGS, dataDir },
        { parentRunId: forkB.id, atSpanId: bRead.id, edit: { field: "result", value: "改" } },
      );
      expect(capability.parentId).toBe(forkB.id);
    } finally {
      cleanup();
    }
  });

  it("根 trace 消失 ⇒ capability 以 RUN_LINEAGE_INCOMPLETE 拒绝（不授予许可、不写文件）", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const rootId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt")] },
        { content: "根完成。" },
      ]);
      const rootRecord = readRun(join(dataDir, "traces", `${rootId}.jsonl`));
      const readSpan = rootRecord.spans.find((s) => s.kind === "tool.invoke");
      if (readSpan?.kind !== "tool.invoke") throw new Error("缺少 tool.invoke span");

      const forkB = await replayIsolatedRun({
        dataDir,
        parentId: rootId,
        atSpanId: readSpan.id,
        edit: { field: "result", value: "内容(a.txt)【B 的观察】" },
        config: isolatedConfig(),
        authority: { allowFileWrites: true },
        llm: new MockLlmClient([{ toolCalls: [readCall("c4", "b.txt")] }, { content: "B 完成。" }]),
      });
      if (!forkB.ok) throw new Error(`${forkB.failure.code} ${forkB.failure.reason}`);
      const bRecord = readRun(join(dataDir, "traces", `${forkB.id}.jsonl`));
      const bRead = bRecord.spans.find((s) => s.kind === "tool.invoke");
      if (bRead?.kind !== "tool.invoke") throw new Error("B 缺少自有 tool.invoke span");

      // 根 trace 消失 ⇒ B 为 ownOnly（U6 §3 的读取语义）
      rmSync(join(dataDir, "traces", `${rootId}.jsonl`));
      const repo = new RunRepository(join(dataDir, "traces"));
      await expect(
        runForkCapability(
          { repository: repo, settings: SETTINGS, dataDir },
          { parentRunId: forkB.id, atSpanId: bRead.id, edit: { field: "result", value: "改" } },
        ),
      ).rejects.toMatchObject({ code: "RUN_LINEAGE_INCOMPLETE", missingRunId: rootId });

      // 自有文件接口保持独立可读：B 自己的初始快照照常取得（来源缺失不封禁自有文件）
      const inspect = await inspectWorkspace({ dataDir, repository: repo }, { runId: forkB.id });
      expect(inspect.ok).toBe(true);
      if (inspect.ok) {
        expect(inspect.result.runId).toBe(forkB.id);
        expect(inspect.result.origin.kind).toBe("checkpoint");
      }
    } finally {
      cleanup();
    }
  });
});

describe("runForkCapability（B 1.5）", () => {
  it("多工具轮次：定位三元组指向该轮，轮末快照是初始清单（本例无写入）", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      // 第 1 轮同轮两个工具（c1/c2），第 2 轮写 b.txt；编辑第 1 轮的 c1
      const parentId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt"), readCall("c2", "keep.txt")] },
        { toolCalls: [writeCall("c3", "b.txt", "beta")] },
        { content: "父完成。" },
      ]);
      const parentRecord = readRun(join(dataDir, "traces", `${parentId}.jsonl`));
      const c1 =
        parentRecord.spans.find((s) => s.kind === "tool.invoke" && s.id.endsWith("s_02")) ??
        parentRecord.spans.find((s) => s.kind === "tool.invoke");
      if (c1?.kind !== "tool.invoke") throw new Error("缺少 tool.invoke span");

      const repo = new RunRepository(join(dataDir, "traces"));
      const capability = await runForkCapability(
        { repository: repo, settings: SETTINGS, dataDir },
        {
          parentRunId: parentId,
          atSpanId: c1.id,
          edit: { field: "result", value: "内容(a.txt)【改】" },
        },
      );

      expect(capability.ownerRunId).toBe(parentId);
      expect(capability.localIteration).toBe(1);
      expect(typeof capability.stepSpanId).toBe("string");
      expect(capability.configHash).toBe(parentRecord.meta.config_hash);
      // 第 1 轮结束后还没有 b.txt：起点清单只有源目录两文件
      expect(capability.fileCount).toBe(2);
      expect(capability.totalBytes).toBeGreaterThan(0);
      expect(capability.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      cleanup();
    }
  });

  it("二次分叉轮号不沿链累加：根 A 3 轮 → B 第 1 轮再分叉，capability 指 B 第 1 轮", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      // 根 A：3 轮工具（read / write b / write c）
      const rootId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt")] },
        { toolCalls: [writeCall("c2", "b.txt", "beta")] },
        { toolCalls: [writeCall("c3", "c.txt", "gamma")] },
        { content: "根完成。" },
      ]);
      const rootRecord = readRun(join(dataDir, "traces", `${rootId}.jsonl`));
      const writeB = rootRecord.spans.find(
        (s) =>
          s.kind === "tool.invoke" &&
          s.tool === "write_file" &&
          JSON.stringify(s.args).includes("b.txt"),
      );
      if (writeB?.kind !== "tool.invoke") throw new Error("缺少写 b.txt 的 span");

      // B：从 A 第 2 轮结束后续跑（起点 = a+b+keep，不含 c.txt）
      const forkB = await replayIsolatedRun({
        dataDir,
        parentId: rootId,
        atSpanId: writeB.id,
        edit: { field: "result", value: "内容(a.txt)【B 的观察】" },
        config: isolatedConfig(),
        authority: { allowFileWrites: true },
        llm: new MockLlmClient([{ toolCalls: [readCall("c4", "b.txt")] }, { content: "B 完成。" }]),
      });
      if (!forkB.ok) throw new Error(`${forkB.failure.code} ${forkB.failure.reason}`);
      const bRecord = readRun(join(dataDir, "traces", `${forkB.id}.jsonl`));
      const bRead = bRecord.spans.find((s) => s.kind === "tool.invoke");
      if (bRead?.kind !== "tool.invoke") throw new Error("B 缺少自有 tool.invoke span");

      // span 序号沿链延续，但轮号回到本地第 1 轮（spec：不得标作第 4 轮）
      const maxRootSeq = Math.max(
        ...rootRecord.spans.map((s) => Number(s.id.replace("s_", "")) || 0),
      );
      const minBSeq = Math.min(...bRecord.spans.map((s) => Number(s.id.replace("s_", "")) || 0));
      expect(minBSeq).toBeGreaterThan(maxRootSeq);

      const repo = new RunRepository(join(dataDir, "traces"));
      const capability = await runForkCapability(
        { repository: repo, settings: SETTINGS, dataDir },
        {
          parentRunId: forkB.id,
          atSpanId: bRead.id,
          edit: { field: "result", value: "内容(b.txt)【C 的观察】" },
        },
      );
      expect(capability.parentId).toBe(forkB.id);
      expect(capability.ownerRunId).toBe(forkB.id);
      expect(capability.localIteration).toBe(1);

      // 起点清单 = A 第 2 轮末（3 文件），不是 A 的最终状态（4 文件）
      expect(capability.fileCount).toBe(3);
    } finally {
      cleanup();
    }
  });

  it("历史 v1 run（无检查点）→ FORK_CAPABILITY_UNAVAILABLE，不提供目录兜底", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const v1Record = await createV1Parent(dataDir, source);
      const readSpan = v1Record.spans.find((s) => s.kind === "tool.invoke");
      if (readSpan?.kind !== "tool.invoke") throw new Error("缺少 tool.invoke span");

      const repo = new RunRepository(join(dataDir, "traces"));
      await expect(
        runForkCapability(
          { repository: repo, settings: SETTINGS, dataDir },
          {
            parentRunId: v1Record.meta.id,
            atSpanId: readSpan.id,
            edit: { field: "result", value: "改" },
          },
        ),
      ).rejects.toMatchObject({ code: FORK_ERROR_CODES.FORK_CAPABILITY_UNAVAILABLE });
    } finally {
      cleanup();
    }
  });

  it("缺附件 → attachment_missing（真实 v2 父本上单点破坏：删除 workspace-blobs）", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const parentId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt")] },
        { content: "完成。" },
      ]);
      const parentRecord = readRun(join(dataDir, "traces", `${parentId}.jsonl`));
      const span = parentRecord.spans.find((s) => s.kind === "tool.invoke");
      if (span?.kind !== "tool.invoke") throw new Error("缺少 tool.invoke span");
      rmSync(join(dataDir, "workspace-blobs"), { recursive: true, force: true });

      const repo = new RunRepository(join(dataDir, "traces"));
      await expect(
        runForkCapability(
          { repository: repo, settings: SETTINGS, dataDir },
          {
            parentRunId: parentId,
            atSpanId: span.id,
            edit: { field: "result", value: "改" },
          },
        ),
      ).rejects.toThrow(/attachment_missing|附件/);
    } finally {
      cleanup();
    }
  });

  it("预检只读：前后 dataDir 全树指纹逐字节一致", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const parentId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [writeCall("c1", "b.txt", "beta")] },
        { content: "完成。" },
      ]);
      const parentRecord = readRun(join(dataDir, "traces", `${parentId}.jsonl`));
      const span = parentRecord.spans.find((s) => s.kind === "tool.invoke");
      if (span?.kind !== "tool.invoke") throw new Error("缺少 tool.invoke span");

      const repo = new RunRepository(join(dataDir, "traces"));
      const before = treeFingerprint(dataDir);
      await runForkCapability(
        { repository: repo, settings: SETTINGS, dataDir },
        {
          parentRunId: parentId,
          atSpanId: span.id,
          edit: { field: "result", value: "内容(alpha)【改】" },
        },
      );
      expect(treeFingerprint(dataDir)).toBe(before);
    } finally {
      cleanup();
    }
  });
});
