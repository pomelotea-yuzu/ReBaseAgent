import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FILE_TOOLS_V1_PROFILE,
  createWorkspaceBlobStore,
  promptReplayIsolatedRun,
} from "@rebaseagent/replay";
import * as shared from "@rebaseagent/run-query";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLlmClient } from "../../../packages/agent-loop/test/helpers";
import { makeConfig } from "../../../packages/replay/test/isolated-helpers";
import {
  BASELINE_CONFIG_HASH,
  BASELINE_MODEL,
  CONFIG_FINAL_B,
  CONFIG_INITIAL_A,
  CONFIG_PATH,
  type IsolatedPromptBaselineCase,
  NEW_USER_INSTRUCTION,
  buildIsolatedPromptBaselineCase,
} from "../../../packages/replay/test/isolated-prompt-baseline-fixture";
import { cleanupTempDirs, makeDataDir } from "../../../packages/replay/test/workspace-helpers";
import { compareRunsEndpoint } from "../src/main/compare-endpoints";
import { RunDetailReadError, RunReadContext } from "../src/main/run-read-context";
import { RunRepository } from "../src/main/run-repository";
import { inspectWorkspace, readWorkspaceFileForView } from "../src/main/workspace-view";
import { defaultCheckpointStepId } from "../src/renderer/src/lib/workspace-files";
import { deriveVerifiedComparison } from "../src/shared/compare-derive";
import { deriveRunSummary } from "../src/shared/derive";
import type { CompareRunItem, RunDetail } from "../src/shared/ipc";
import { classifyOutcome } from "../src/shared/outcome";
import { findRunDetailIntegrityViolation } from "../src/shared/run-detail-integrity";

/**
 * MCP0 任务 3.2（D01/D02、Q01）：同一 fixture 的 **desktop 旧出口 / 共享包出口**对照。
 *
 * 判据来自 delta「相同对象在桌面和 MCP 事实一致」与「三个 trace 版本使用同一事实实现」：
 * - 两入口读同一批 v1/v2/v3 对象，状态、归属、消耗、缺项与文件哈希逐项一致；
 * - "一致"的前提是**同一实现**，不是两份实现互相校对 ⇒ 先断言导出符号对象全等，
 *   再断言同 fixture 的产出深度全等；
 * - fixture 必须真的覆盖三版本与缺父/坏父/损坏/无 usage/未封存，否则对照是空转 ⇒ 每类都钉死取值。
 *
 * 桌面默认与共享缺省的分层（D02 的另一半）：省略 `stepSpanId` 在两入口都只等于
 * **本 run 初始快照**；桌面"最近自有完成步骤"由 renderer 解析成显式 selector 后再调用，
 * 两个默认互不改写。
 */

const T0 = "2026-10-20T00:00:00.000Z";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

interface Fixture {
  readonly dataDir: string;
  readonly tracesDir: string;
  /** v1 普通根（llm.call 带 cache_hit + tool.invoke） */
  readonly v1Root: string;
  readonly v1RootToolSpan: string;
  /** v1 result 分叉子（父 = v1Root，链完整） */
  readonly v1Child: string;
  /** v1 子：父文件确实缺失 ⇒ ownOnly / ANCESTOR_NOT_FOUND */
  readonly v1Orphan: string;
  /** v1 子：父文件损坏 ⇒ 严格失败 ANCESTOR_INVALID */
  readonly v1BadChild: string;
  /** 完全无法解析的文件：列表里必须以失败项在场 */
  readonly v1Corrupt: string;
  /** 文件名与 meta.id 不一致的 fixture（只在详细列表里成为失败项） */
  readonly v1IdentityFile: string;
  readonly v1IdentityRecordedId: string;
  /** v1 无 llm.call（usage 未知）且已封存的正常结局 */
  readonly v1NoLlm: string;
  /** v1 轮内中断（step 未落盘、无终止事件）⇒ 无自有完成步骤 */
  readonly v1MidRound: string;
  /** v2 隔离根（真实快照与附件） */
  readonly v2Root: string;
  readonly v2RootStep: string;
  readonly v2RootToolSpan: string;
  /** v2 result 分叉子（at_span=父轮内工具，resume_after_step=父轮末） */
  readonly v2Child: string;
  readonly v2ChildStep: string;
  /** v3 隔离 prompt 实验（真跑 mock 模型，起点 = 根初始快照 A） */
  readonly v3Child: string;
}

let fx!: Fixture;

/** 写一个 v1 普通 run：一步一请求一工具，按 opts 削减 */
function writeV1Run(
  tracesDir: string,
  id: string,
  opts: {
    readonly parent?: string | null;
    readonly fork?: { readonly at_span: string; readonly field: string; readonly value: unknown };
    readonly spanSeqStart?: number;
    readonly llmUsage?: { readonly in: number; readonly out: number; readonly cache_hit?: number };
    readonly seal?: boolean;
    readonly closeStep?: boolean;
  } = {},
): { readonly stepSpan: string; readonly toolSpan: string } {
  const tracer = new JsonlTracer(join(tracesDir, `${id}.jsonl`), {
    ...(opts.spanSeqStart === undefined ? {} : { spanSeqStart: opts.spanSeqStart }),
  });
  tracer.startRun({
    id,
    format_version: 1,
    task: `MCP0 3.2 对照夹具 ${id}`,
    model: "controlled-model",
    created_at: T0,
    parent: opts.parent ?? null,
    fork:
      opts.fork === undefined
        ? null
        : { at_span: opts.fork.at_span, edit: { field: opts.fork.field, value: opts.fork.value } },
  });
  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  if (opts.llmUsage !== undefined) {
    const llm = tracer.startSpan({
      kind: "llm.call",
      parent: step,
      request: {
        model: "controlled-model",
        messages: [
          { role: "system", content: "你是文件助手。" },
          { role: "user", content: "读一下 a.txt" },
        ],
      },
    });
    tracer.endSpan(llm, {
      response: {
        content: "已读取",
        reasoning_content: null,
        tool_calls: [],
        usage: { ...opts.llmUsage },
        ttft_ms: 3,
      },
    });
    const tool = tracer.startSpan({
      kind: "tool.invoke",
      parent: step,
      tool: "read_file",
      args: { path: "a.txt" },
    });
    tracer.endSpan(tool, { result: "alpha 内容", dur_ms: 4, error: null });
    tracer.endSpan(step);
    if (opts.seal !== false) {
      tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
    } else {
      tracer.dispose();
    }
    return { stepSpan: step, toolSpan: tool };
  }
  if (opts.closeStep !== false) {
    tracer.endSpan(step);
  }
  if (opts.seal !== false) {
    tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
  } else {
    // 轮内中断的事故现场：只关句柄，不补终止事件（readRun 如实判 crashed）
    tracer.dispose();
  }
  return { stepSpan: step, toolSpan: step };
}

/** v2 子 run 轮末写出的新内容（与父轮末 B 不同） */
const V2_CHILD_FINAL = `{
  "retries": 3,
  "custom_flag": "keep-me"
}
`;

/**
 * 写一个**真实可续跑**的 v2 result 分叉：`at_span` 指父轮内的工具调用、
 * `resume_after_step` 指该轮末尾（两者同指会被读取层如实拒绝，不能当对照夹具）。
 * 子的初始快照 = 父轮末 B（同一批已发布附件 ⇒ 快照 id 与父 final 相同）。
 */
async function writeV2ForkChild(baseline: IsolatedPromptBaselineCase, id: string): Promise<string> {
  const store = createWorkspaceBlobStore(baseline.dataDir);
  const published = await store.publish(new TextEncoder().encode(V2_CHILD_FINAL));
  const initialSnapshot = createWorkspaceSnapshot(baseline.root.finalFiles);
  const finalSnapshot = createWorkspaceSnapshot([
    { path: CONFIG_PATH, sha256: published.sha256, bytes: published.bytes },
  ]);

  const tracer = new JsonlTracer(join(baseline.dataDir, "traces", `${id}.jsonl`), {
    spanSeqStart: 100,
  });
  tracer.startRun({
    id,
    format_version: 2,
    task: "MCP0 3.2 对照夹具：v2 result 分叉（整轮续跑）",
    model: BASELINE_MODEL,
    created_at: "2026-10-20T00:01:00.000Z",
    parent: baseline.root.runId,
    fork: {
      at_span: baseline.root.toolSpanId,
      resume_after_step: baseline.root.stepSpanId,
      edit: { field: "result", value: "已写入 config.json（保留未知键）" },
    },
    config_hash: BASELINE_CONFIG_HASH,
    workspace: {
      profile: FILE_TOOLS_V1_PROFILE,
      world_id: id,
      write_authorized: true,
      initial_snapshot: initialSnapshot,
      origin: {
        kind: "checkpoint",
        run_id: baseline.root.runId,
        step_span: baseline.root.stepSpanId,
      },
    },
  });
  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  const llm = tracer.startSpan({
    kind: "llm.call",
    parent: step,
    request: {
      model: BASELINE_MODEL,
      messages: [
        { role: "system", content: "你是本地配置修复助手。" },
        { role: "user", content: NEW_USER_INSTRUCTION },
      ],
    },
  });
  tracer.endSpan(llm, {
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: [
        {
          id: "call_mcp0_v2_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: CONFIG_PATH, content: V2_CHILD_FINAL }),
          },
        },
      ],
      usage: { in: 160, out: 28 },
      ttft_ms: 4,
    },
  });
  const tool = tracer.startSpan({
    kind: "tool.invoke",
    parent: step,
    tool: "write_file",
    args: { path: CONFIG_PATH, content: V2_CHILD_FINAL },
  });
  tracer.endSpan(tool, { result: "已写入 config.json", dur_ms: 1, error: null });
  tracer.endSpan(step, { workspace_snapshot: finalSnapshot });
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
  return step;
}

async function buildFixture(): Promise<Fixture> {
  const tmp = makeDataDir();
  const dataDir = tmp.dataDir;
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const root = writeV1Run(tracesDir, "mcp0-v1-root", {
    llmUsage: { in: 100, out: 20, cache_hit: 40 },
  });
  writeV1Run(tracesDir, "mcp0-v1-child", {
    parent: "mcp0-v1-root",
    fork: { at_span: root.toolSpan, field: "result", value: "改后的工具结果" },
    spanSeqStart: 10,
    llmUsage: { in: 60, out: 10 },
  });
  writeV1Run(tracesDir, "mcp0-v1-orphan", {
    parent: "mcp0-v1-gone",
    fork: { at_span: "s_11", field: "result", value: "父已不在" },
    spanSeqStart: 20,
    llmUsage: { in: 30, out: 6 },
  });
  // 坏父：首行（meta）合法、次行非法 ⇒ 祖先读取以解析失败告终，不是缺失
  writeFileSync(
    join(tracesDir, "mcp0-v1-badparent.jsonl"),
    `${JSON.stringify({
      type: "run.meta",
      id: "mcp0-v1-badparent",
      format_version: 1,
      task: "坏父",
      model: "controlled-model",
      created_at: T0,
      parent: null,
      fork: null,
    })}\n{"type":"span","id":\n`,
  );
  writeV1Run(tracesDir, "mcp0-v1-badchild", {
    parent: "mcp0-v1-badparent",
    fork: { at_span: "s_31", field: "result", value: "父轨迹不可解析" },
    spanSeqStart: 30,
    llmUsage: { in: 12, out: 3 },
  });
  writeFileSync(join(tracesDir, "mcp0-v1-corrupt.jsonl"), "这不是 JSONL\n");
  // 身份错配：文件名与 meta.id 不同 ⇒ 只在详细列表里成为失败项（旧 listRuns 行为不变）
  writeFileSync(
    join(tracesDir, "mcp0-v1-identity.jsonl"),
    `${JSON.stringify({
      type: "run.meta",
      id: "mcp0-v1-other",
      format_version: 1,
      task: "身份错配",
      model: "controlled-model",
      created_at: T0,
      parent: null,
      fork: null,
    })}\n${JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" })}\n`,
  );
  writeV1Run(tracesDir, "mcp0-v1-nollm");
  writeV1Run(tracesDir, "mcp0-v1-midround", { seal: false, closeStep: false });

  const baseline = await buildIsolatedPromptBaselineCase({ dataDir, withSibling: false });
  const v2ChildStep = await writeV2ForkChild(baseline, "mcp0-v2-child");
  const v3 = await promptReplayIsolatedRun({
    dataDir,
    rootId: baseline.root.runId,
    edit: { field: "user_message", value: NEW_USER_INSTRUCTION },
    config: makeConfig(),
    authority: { allowFileWrites: true },
    llm: new MockLlmClient([{ content: "只改目标键，未知键保留。" }]),
  });
  if (!v3.ok) {
    throw new Error(`v3 夹具生成失败：${v3.failure.code} ${v3.failure.reason}`);
  }

  return {
    dataDir,
    tracesDir,
    v1Root: "mcp0-v1-root",
    v1RootToolSpan: root.toolSpan,
    v1Child: "mcp0-v1-child",
    v1Orphan: "mcp0-v1-orphan",
    v1BadChild: "mcp0-v1-badchild",
    v1Corrupt: "mcp0-v1-corrupt",
    v1IdentityFile: "mcp0-v1-identity",
    v1IdentityRecordedId: "mcp0-v1-other",
    v1NoLlm: "mcp0-v1-nollm",
    v1MidRound: "mcp0-v1-midround",
    v2Root: baseline.root.runId,
    v2RootStep: baseline.root.stepSpanId,
    v2RootToolSpan: baseline.root.toolSpanId,
    v2Child: "mcp0-v2-child",
    v2ChildStep,
    v3Child: v3.id,
  };
}

beforeAll(async () => {
  fx = await buildFixture();
}, 180_000);

afterAll(() => {
  cleanupTempDirs();
});

// ---------------------------------------------------------------------------
// 两入口取样器：A = desktop 旧出口（src/main、src/shared），B = 共享包出口
// ---------------------------------------------------------------------------

function desktopRepository(): RunRepository {
  return new RunRepository(fx.tracesDir);
}

function sharedRepository(): shared.RunRepository {
  return new shared.RunRepository(fx.tracesDir);
}

function desktopView() {
  return { dataDir: fx.dataDir, repository: desktopRepository() };
}

function sharedView() {
  return { dataDir: fx.dataDir, repository: sharedRepository() };
}

type DetailReader = RunRepository | RunReadContext;

/** 抛错也要可比：把异常归成 { name, code, message }，成功归成 { detail } */
function readDetailVia(
  context: DetailReader,
  id: string,
): { ok: true; detail: RunDetail } | { ok: false; name: string; code: string; message: string } {
  try {
    const detail =
      context instanceof RunRepository
        ? context.getRun(id)
        : (context as RunReadContext).detailOf(id);
    return { ok: true, detail };
  } catch (e) {
    if (e instanceof RunDetailReadError) {
      return { ok: false, name: e.name, code: e.code, message: e.message };
    }
    throw e;
  }
}

/** traces 目录平铺指纹（相对名 + 内容哈希） */
function fingerprint(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((entry) =>
      entry.isDirectory()
        ? `${entry.name}:dir`
        : `${entry.name}:${sha256(readFileSync(join(dir, entry.name)).toString("utf8"))}`,
    )
    .join("\n");
}

describe("MCP0 3.2 同一实现：桌面旧出口与共享包出口对象全等", () => {
  it("类、纯函数与判据都是同一个对象（不是两份实现互相校对）", () => {
    expect(RunRepository).toBe(shared.RunRepository);
    expect(RunReadContext).toBe(shared.RunReadContext);
    expect(RunDetailReadError).toBe(shared.RunDetailReadError);
    expect(inspectWorkspace).toBe(shared.inspectWorkspace);
    expect(readWorkspaceFileForView).toBe(shared.readWorkspaceFileForView);
    expect(deriveRunSummary).toBe(shared.deriveRunSummary);
    expect(classifyOutcome).toBe(shared.classifyOutcome);
    expect(deriveVerifiedComparison).toBe(shared.deriveVerifiedComparison);
    expect(findRunDetailIntegrityViolation).toBe(shared.findRunDetailIntegrityViolation);
    // replay 的跨运行比较经共享层接入，同样是同一函数（2.9）
    expect(shared.compareWorkspaceSnapshots).toBeTypeOf("function");
  });
});

describe("MCP0 3.2 版本覆盖：v1/v2/v3 同 fixture 双入口", () => {
  it("列表逐条与失败项在两入口逐字段全等", () => {
    const a = desktopRepository().listRuns();
    const b = sharedRepository().listRuns();
    expect(a).toEqual(b);

    const ids = new Set(a.runs.map((run) => run.id));
    for (const id of [fx.v1Root, fx.v1Child, fx.v2Root, fx.v2Child, fx.v3Child, fx.v1MidRound]) {
      expect(ids.has(id)).toBe(true);
    }
    // 损坏文件不得从列表消失（Q03 的对照面）
    expect(a.failed.some((fail) => fail.file.endsWith(`${fx.v1Corrupt}.jsonl`))).toBe(true);
  });

  it("三版本各自的 format_version 在两入口一致", () => {
    for (const [id, version] of [
      [fx.v1Root, 1],
      [fx.v2Root, 2],
      [fx.v3Child, 3],
    ] as const) {
      const a = readDetailVia(desktopRepository(), id);
      const b = readDetailVia(sharedRepository(), id);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) continue;
      expect(a.detail).toEqual(b.detail);
      expect(a.detail.meta.format_version).toBe(version);
    }
  });

  it("v1 result 分叉：合并前缀与分叉事实在两入口一致", () => {
    const a = readDetailVia(desktopRepository(), fx.v1Child);
    const b = readDetailVia(sharedRepository(), fx.v1Child);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.detail.meta.fork?.at_span).toBe(fx.v1RootToolSpan);
    expect(a.detail.completeness).toBe("complete");
    expect(a.detail.spanScope).toBe("resolved");
    expect(a.detail.chain.map((hop) => hop.meta.id)).toEqual([fx.v1Root, fx.v1Child]);
    // 合并视图含父前缀，自有 span 只有本 run 那三个
    expect(a.detail.spans.length).toBeGreaterThan(a.detail.leafSpanIds.length);
  });

  it("v2 分叉与 v3 实验的来源事实在两入口一致（分叉字段不丢）", () => {
    const a = readDetailVia(desktopRepository(), fx.v2Child);
    const b = readDetailVia(sharedRepository(), fx.v2Child);
    expect(a).toEqual(b);
    if (a.ok && b.ok) {
      expect(a.detail.meta.parent).toBe(fx.v2Root);
      expect(a.detail.meta.fork?.edit.field).toBe("result");
      expect(a.detail.meta.fork?.at_span).toBe(fx.v2RootToolSpan);
      expect(a.detail.meta.fork?.resume_after_step).toBe(fx.v2RootStep);
      expect(b.detail.meta.fork?.resume_after_step).toBe(a.detail.meta.fork?.resume_after_step);
      expect(a.detail.completeness).toBe("complete");
    }

    const v3a = readDetailVia(desktopRepository(), fx.v3Child);
    const v3b = readDetailVia(sharedRepository(), fx.v3Child);
    expect(v3a).toEqual(v3b);
    if (v3a.ok && v3b.ok) {
      expect(v3a.detail.meta.parent).toBe(fx.v2Root);
      expect(v3a.detail.meta.fork?.edit.field).toBe("user_message");
      expect(v3a.detail.meta.prompt_experiment?.baseline_run_id).toBe(fx.v2Root);
    }
  });
});

describe("MCP0 3.2 缺父 / 坏父 / 损坏 / usage 未知", () => {
  it("缺父：两入口同判 ownOnly + ANCESTOR_NOT_FOUND（不冒充完整链）", () => {
    const a = readDetailVia(desktopRepository(), fx.v1Orphan);
    const b = readDetailVia(sharedRepository(), fx.v1Orphan);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.detail.completeness).toBe("ownOnly");
    expect(a.detail.lineage).toEqual({
      status: "incomplete",
      reason: "ANCESTOR_NOT_FOUND",
      missingRunId: "mcp0-v1-gone",
    });
    expect(b.detail.lineage).toEqual(a.detail.lineage);
  });

  it("坏父：两入口同抛 RunDetailReadError + ANCESTOR_INVALID，不降级 ownOnly", () => {
    const a = readDetailVia(desktopRepository(), fx.v1BadChild);
    const b = readDetailVia(sharedRepository(), fx.v1BadChild);
    expect(a).toEqual(b);
    expect(a.ok).toBe(false);
    if (a.ok || b.ok) return;
    expect(a.code).toBe("ANCESTOR_INVALID");
    expect(b.code).toBe("ANCESTOR_INVALID");
    expect(a.name).toBe(b.name);
    expect(a.message).toBe(b.message);
  });

  it("损坏文件：listRunsDetailed 的失败项与稳定码在两入口一致", () => {
    const a = desktopRepository().listRunsDetailed();
    const b = sharedRepository().listRunsDetailed();
    expect(a).toEqual(b);
    const corrupt = a.failed.filter((fail) => fail.file.endsWith(`${fx.v1Corrupt}.jsonl`));
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]?.code).toBe("RUN_INVALID");
  });

  it("身份错配：详细列表的 IDENTITY_MISMATCH 在两入口一致，旧 listRuns 行为不变", () => {
    const a = desktopRepository().listRunsDetailed();
    const b = sharedRepository().listRunsDetailed();
    expect(a).toEqual(b);
    const mismatch = a.failed.filter((fail) => fail.file.endsWith(`${fx.v1IdentityFile}.jsonl`));
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.code).toBe("IDENTITY_MISMATCH");
    expect(mismatch[0]?.error).toContain(fx.v1IdentityRecordedId);
    // 旧列表仍按记录内容出条目（收紧只发生在 MCP 外部输入侧，不回头改桌面）
    expect(
      desktopRepository()
        .listRuns()
        .runs.some((run) => run.id === fx.v1IdentityRecordedId),
    ).toBe(true);
  });

  it("usage 未知：无 llm.call 的 run 在两入口都不得补 0", () => {
    const a = desktopRepository()
      .listRuns()
      .runs.find((run) => run.id === fx.v1NoLlm);
    const b = sharedRepository()
      .listRuns()
      .runs.find((run) => run.id === fx.v1NoLlm);
    expect(a).toEqual(b);
    expect(a?.cacheHit).toBeNull();
    expect(a?.tokensIn).toBe(0);
    expect(a?.status).toBe("completed");
  });

  it("未封存事故现场：状态与结局标签在两入口一致（不冒充进行中也不改判）", () => {
    const a = desktopRepository()
      .listRuns()
      .runs.find((run) => run.id === fx.v1MidRound);
    const b = sharedRepository()
      .listRuns()
      .runs.find((run) => run.id === fx.v1MidRound);
    expect(a).toEqual(b);
    expect(a?.status).toBe("crashed");
    expect(a?.reason).toBeNull();
    expect(classifyOutcome({ status: "crashed", reason: a?.reason ?? null }).label).toBe(
      "运行中断",
    );
    expect(shared.classifyOutcome({ status: "crashed", reason: a?.reason ?? null }).label).toBe(
      "运行中断",
    );
  });
});

describe("MCP0 3.2 比较：端点输出与共享派生在同一 fixture 上对齐", () => {
  /** 经由各自出口构造比较输入：A = desktop 端点，B = 包层读取上下文 */
  function sidesOf(
    side: "desktop" | "shared",
    runIds: readonly string[],
  ): readonly shared.CompareSideInput[] {
    if (side === "desktop") {
      const outcome = compareRunsEndpoint({ tracesDir: fx.tracesDir }, { runIds });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return [];
      return outcome.items
        .map((item) => item as CompareRunItem)
        .filter(
          (item): item is Extract<CompareRunItem, { status: "ready" }> => item.status === "ready",
        )
        .map((item) => ({ runId: item.runId, chainSummaries: item.chainSummaries }));
    }
    const context = new shared.RunReadContext(fx.tracesDir);
    return runIds.map((runId) => ({ runId, chainSummaries: context.readOf(runId).chainSummaries }));
  }

  it("逐侧 chainSummaries 在两入口全等（根→叶有序，含当前 run）", () => {
    const a = sidesOf("desktop", [fx.v2Root, fx.v2Child]);
    const b = sidesOf("shared", [fx.v2Root, fx.v2Child]);
    expect(a).toEqual(b);
    expect(a[1]?.chainSummaries.map((run) => run.id)).toEqual([fx.v2Root, fx.v2Child]);
  });

  it("共同祖先与相对增量：两入口全等且口径为沿链求和", () => {
    const a = deriveVerifiedComparison(sidesOf("desktop", [fx.v2Root, fx.v2Child]));
    const b = shared.deriveVerifiedComparison(sidesOf("shared", [fx.v2Root, fx.v2Child]));
    expect(a).toEqual(b);

    expect(a.relation).toEqual({ kind: "common", ancestorId: fx.v2Root });
    const child = a.sides.find((side) => side.runId === fx.v2Child);
    // fixture 固定用量：根 in 128/out 32，v2 子 in 160/out 28
    expect(child?.totals?.tokens).toBe(128 + 32 + 160 + 28);
    expect(child?.deltaFromAncestor?.tokens).toBe(160 + 28);
    expect(child?.totals?.steps).toBe(2);
  });

  it("缺父侧：两入口同判 incomplete，祖先差禁算、另一侧照常可读", () => {
    const a = deriveVerifiedComparison(sidesOf("desktop", [fx.v1Root, fx.v1Orphan]));
    const b = shared.deriveVerifiedComparison(sidesOf("shared", [fx.v1Root, fx.v1Orphan]));
    expect(a).toEqual(b);
    expect(a.relation.kind).toBe("incomplete");
    expect(a.ancestor).toBeNull();
    expect(a.sides.every((side) => side.deltaFromAncestor === null)).toBe(true);
    const rootSide = a.sides.find((side) => side.runId === fx.v1Root);
    expect(rootSide?.totals?.tokens).toBe(100 + 20);
  });

  it("端点逐项失败不拖垮合法侧（两入口同一判据）", () => {
    const outcome = compareRunsEndpoint(
      { tracesDir: fx.tracesDir },
      { runIds: [fx.v1Root, fx.v1BadChild] },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const items = outcome.items.map((item) => item as CompareRunItem);
    expect(items.map((item) => item.runId)).toEqual([fx.v1Root, fx.v1BadChild]);
    expect(items[0]?.status).toBe("ready");
    const bad = items[1];
    expect(bad?.status).toBe("unavailable");
    if (bad?.status === "unavailable") expect(bad.code).toBe("ANCESTOR_INVALID");
  });
});

describe("MCP0 3.2 检查点：清单与附件字节在两入口一致", () => {
  it("v2 根初始快照：两入口清单、哈希与 origin 全等", async () => {
    const a = await inspectWorkspace(desktopView(), { runId: fx.v2Root });
    const b = await inspectWorkspace(sharedView(), { runId: fx.v2Root });
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.result.origin).toEqual({ kind: "import" });
    expect(a.result.files.map((file) => file.path)).toEqual([CONFIG_PATH]);
    expect(a.result.files[0]?.sha256).toBe(sha256(CONFIG_INITIAL_A));
    expect(a.result.files[0]?.availability).toBe("ok");
  });

  it("v2 根轮末快照：change 按路径+哈希判，哈希等于 CONFIG_FINAL_B", async () => {
    const a = await inspectWorkspace(desktopView(), {
      runId: fx.v2Root,
      stepSpanId: fx.v2RootStep,
    });
    const b = await inspectWorkspace(sharedView(), { runId: fx.v2Root, stepSpanId: fx.v2RootStep });
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.result.localIteration).toBe(1);
    expect(a.result.files[0]).toMatchObject({ change: "modified", sha256: sha256(CONFIG_FINAL_B) });
  });

  it("v3 实验子：origin=initial 指向根初始快照，两入口全等", async () => {
    const a = await inspectWorkspace(desktopView(), { runId: fx.v3Child });
    const b = await inspectWorkspace(sharedView(), { runId: fx.v3Child });
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.result.origin.kind).toBe("initial");
    expect(a.result.snapshotId).toBe(a.result.initialSnapshotId);
  });

  it("文本读取与清单外路径：两入口的正文/状态/哈希全等", async () => {
    const textA = await readWorkspaceFileForView(desktopView(), {
      runId: fx.v3Child,
      path: CONFIG_PATH,
    });
    const textB = await readWorkspaceFileForView(sharedView(), {
      runId: fx.v3Child,
      path: CONFIG_PATH,
    });
    expect(textA).toEqual(textB);
    expect(textA.status).toBe("text");
    if (textA.status === "text") {
      expect(textA.text).toBe(CONFIG_INITIAL_A);
      expect(textA.sha256).toBe(sha256(CONFIG_INITIAL_A));
    }

    const goneA = await readWorkspaceFileForView(desktopView(), {
      runId: fx.v3Child,
      path: "nope.txt",
    });
    const goneB = await readWorkspaceFileForView(sharedView(), {
      runId: fx.v3Child,
      path: "nope.txt",
    });
    expect(goneA).toEqual(goneB);
    expect(goneA.status).toBe("not_found");

    // 穿越/绝对路径形态也只是"清单里没有这条路径"：不给宿主路径，不给物理原因
    const sneaky = await readWorkspaceFileForView(sharedView(), {
      runId: fx.v3Child,
      path: `../../${CONFIG_PATH}`,
    });
    expect(sneaky.status).toBe("not_found");
    if (sneaky.status === "not_found") {
      expect(sneaky.reason).not.toContain(fx.dataDir);
    }
    const absolute = await readWorkspaceFileForView(desktopView(), {
      runId: fx.v3Child,
      path: process.platform === "win32" ? "D:/Windows/system.ini" : "/etc/passwd",
    });
    expect(absolute.status).toBe("not_found");
  });

  it("分支 run 的相对初始是本 run 自己的初始快照（= 父轮末 B），两入口一致", async () => {
    const initialA = await inspectWorkspace(desktopView(), { runId: fx.v2Child });
    const initialB = await inspectWorkspace(sharedView(), { runId: fx.v2Child });
    expect(initialA).toEqual(initialB);
    expect(initialA.ok).toBe(true);
    if (!initialA.ok) return;
    expect(initialA.result.origin).toEqual({
      kind: "checkpoint",
      runId: fx.v2Root,
      stepSpanId: fx.v2RootStep,
    });
    expect(initialA.result.files[0]?.sha256).toBe(sha256(CONFIG_FINAL_B));
    expect(initialA.result.files[0]?.change).toBe("initial");

    const ownStep = await inspectWorkspace(sharedView(), {
      runId: fx.v2Child,
      stepSpanId: fx.v2ChildStep,
    });
    expect(ownStep.ok).toBe(true);
    if (!ownStep.ok) return;
    expect(ownStep.result.localIteration).toBe(1);
    expect(ownStep.result.files[0]?.change).toBe("modified");
    expect(ownStep.result.files[0]?.sha256).toBe(sha256(V2_CHILD_FINAL));
    const readOwn = await readWorkspaceFileForView(desktopView(), {
      runId: fx.v2Child,
      stepSpanId: fx.v2ChildStep,
      path: CONFIG_PATH,
    });
    expect(readOwn.status).toBe("text");
    if (readOwn.status === "text") expect(readOwn.text).toBe(V2_CHILD_FINAL);
  });

  it("非隔离 run：两入口同判可辨认拒绝，不用当前目录兜底", async () => {
    const a = await inspectWorkspace(desktopView(), { runId: fx.v1Root });
    const b = await inspectWorkspace(sharedView(), { runId: fx.v1Root });
    expect(a).toEqual(b);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.code).toBe("WORKSPACE_NO_WORKSPACE");
  });

  it("祖先步骤不是本 run 检查点：两入口同判 step_not_found", async () => {
    const a = await inspectWorkspace(desktopView(), {
      runId: fx.v2Child,
      stepSpanId: fx.v2RootStep,
    });
    const b = await inspectWorkspace(sharedView(), {
      runId: fx.v2Child,
      stepSpanId: fx.v2RootStep,
    });
    expect(a).toEqual(b);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.code).toBe("WORKSPACE_STEP_NOT_FOUND");
  });
});

describe("MCP0 3.2 分层默认：共享缺省=初始，桌面默认由 renderer 解析", () => {
  it("省略 stepSpanId：两入口都给初始快照，不是桌面默认检查点", async () => {
    const a = await inspectWorkspace(desktopView(), { runId: fx.v2Root });
    const b = await inspectWorkspace(sharedView(), { runId: fx.v2Root });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.result.stepSpanId).toBeNull();
    expect(b.result.stepSpanId).toBeNull();
    expect(a.result.snapshotId).toBe(a.result.initialSnapshotId);
  });

  it("桌面默认（最近自有完成步骤）解析成显式 selector 后另有一份清单", async () => {
    const detail = desktopRepository().getRun(fx.v2Root);
    const stepSpanId = defaultCheckpointStepId(detail);
    expect(stepSpanId).toBe(fx.v2RootStep);

    const asInitial = await inspectWorkspace(sharedView(), { runId: fx.v2Root });
    if (stepSpanId === null) {
      throw new Error("桌面默认应解析到最近自有完成步骤，而不是初始");
    }
    const asDefault = await inspectWorkspace(sharedView(), { runId: fx.v2Root, stepSpanId });
    expect(asInitial.ok && asDefault.ok).toBe(true);
    if (!asInitial.ok || !asDefault.ok) return;
    // 两个检查点必须可分辨：共享缺省不得改写桌面默认，反之亦然
    expect(asDefault.result.snapshotId).not.toBe(asInitial.result.snapshotId);
    expect(asDefault.result.localIteration).toBe(1);
    expect(asDefault.result.files[0]?.sha256).toBe(sha256(CONFIG_FINAL_B));
  });

  it("轮内中断的 run：桌面默认退初始（无自有完成步骤）", () => {
    const detail = desktopRepository().getRun(fx.v1MidRound);
    expect(defaultCheckpointStepId(detail)).toBeNull();
  });
});

describe("MCP0 3.2 只读：双入口读取不改数据", () => {
  it("读取前后 traces 目录清单与字节一致", async () => {
    const before = fingerprint(fx.tracesDir);
    desktopRepository().listRuns();
    sharedRepository().listRunsDetailed();
    new shared.RunReadContext(fx.tracesDir).detailOf(fx.v2Child);
    await inspectWorkspace(desktopView(), { runId: fx.v2Root });
    await readWorkspaceFileForView(sharedView(), { runId: fx.v3Child, path: CONFIG_PATH });
    expect(fingerprint(fx.tracesDir)).toBe(before);
    expect(statSync(join(fx.tracesDir, `${fx.v2Root}.jsonl`)).isFile()).toBe(true);
  });
});
