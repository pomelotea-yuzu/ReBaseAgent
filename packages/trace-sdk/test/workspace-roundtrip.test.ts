import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlTracer } from "../src/jsonl-tracer";
import { MemoryTracer } from "../src/memory-tracer";
import { TraceReadError, parseRunText, readRun } from "../src/reader";
import type { RunMetaInput, WorkspaceSnapshot } from "../src/schema";
import { createWorkspaceSnapshot } from "../src/workspace-hash";
import { sampleMeta, sampleRequest, sampleResponse, tempDir } from "./helpers";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

/** 最小合法 v2 隔离根 run meta（初始快照可指定；空清单有确定哈希） */
function v2RootMeta(options: { id?: string; initial?: WorkspaceSnapshot } = {}): RunMetaInput {
  const id = options.id ?? "r_iso";
  return {
    id,
    format_version: 2,
    task: "隔离运行",
    model: "deepseek-chat",
    created_at: "2026-09-17T00:00:00.000Z",
    parent: null,
    fork: null,
    config_hash: "sha256:abc",
    workspace: {
      profile: "file-tools-v1",
      world_id: id,
      write_authorized: true,
      initial_snapshot: options.initial ?? createWorkspaceSnapshot([]),
      origin: { kind: "import" },
    },
  };
}

/** 最小合法 v2 隔离分支 run meta（parent + resume_after_step + checkpoint origin） */
function v2ForkMeta(options: { parent: string; stepSpan: string }): RunMetaInput {
  return {
    id: "r_iso_child",
    format_version: 2,
    task: "隔离分支",
    model: "deepseek-chat",
    created_at: "2026-09-17T00:00:00.000Z",
    parent: options.parent,
    fork: {
      at_span: "s_02",
      resume_after_step: options.stepSpan,
      edit: { field: "result", value: "改后的结果" },
    },
    config_hash: "sha256:abc",
    workspace: {
      profile: "file-tools-v1",
      world_id: "r_iso_child",
      write_authorized: true,
      initial_snapshot: createWorkspaceSnapshot([]),
      origin: { kind: "checkpoint", run_id: options.parent, step_span: options.stepSpan },
    },
  };
}

describe("快照往返：经 Tracer 写入再读取", () => {
  it("初始快照与两轮 step 快照完整往返（JsonlTracer 真实文件）", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, "r_iso.jsonl");
      const initial = createWorkspaceSnapshot([
        { path: "a.txt", sha256: HASH_A, bytes: 3 },
        { path: "dir/b.txt", sha256: HASH_B, bytes: 10 },
      ]);
      const round1 = createWorkspaceSnapshot([
        ...initial.files,
        { path: "out/1.txt", sha256: HASH_C, bytes: 5 },
      ]);
      const round2 = createWorkspaceSnapshot([
        ...round1.files,
        { path: "out/2.txt", sha256: HASH_B, bytes: 7 },
      ]);

      const tracer = new JsonlTracer(file);
      tracer.startRun(v2RootMeta({ initial }));
      const step1 = tracer.startSpan({ kind: "agent.step", n: 1 });
      const llm = tracer.startSpan({ kind: "llm.call", parent: step1, request: sampleRequest() });
      tracer.endSpan(llm, { response: sampleResponse() });
      tracer.endSpan(step1, { workspace_snapshot: round1 });
      const step2 = tracer.startSpan({ kind: "agent.step", n: 2 });
      tracer.endSpan(step2, { workspace_snapshot: round2 });
      tracer.endRun({ event: "stopped", reason: "completed", at: 2 });

      const record = readRun(file);
      expect(record.meta.format_version).toBe(2);
      expect(record.meta.workspace?.initial_snapshot).toEqual(initial);
      expect(record.meta.workspace?.origin).toEqual({ kind: "import" });
      expect(record.meta.workspace?.world_id).toBe("r_iso");

      const steps = record.spans.filter((span) => span.kind === "agent.step");
      expect(steps).toHaveLength(2);
      expect(
        steps.map((span) => (span.kind === "agent.step" ? span.workspace_snapshot?.id : null)),
      ).toEqual([round1.id, round2.id]);

      // span 语义顺序：step 先于其子 span（父在子前），且 step 之间按 n 递增
      expect(record.spans[0].kind).toBe("agent.step");
      expect(record.spans[1].kind).toBe("llm.call");
      expect(steps.map((span) => (span.kind === "agent.step" ? span.n : null))).toEqual([1, 2]);
    } finally {
      cleanup();
    }
  });

  it("分支 run：origin=checkpoint、resume_after_step 与快照一并往返", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, "r_iso_child.jsonl");
      const tracer = new JsonlTracer(file);
      tracer.startRun(v2ForkMeta({ parent: "r_iso", stepSpan: "s_03" }));
      const step = tracer.startSpan({ kind: "agent.step", n: 1 });
      tracer.endSpan(step, { workspace_snapshot: createWorkspaceSnapshot([]) });
      tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

      const record = readRun(file);
      expect(record.meta.parent).toBe("r_iso");
      expect(record.meta.fork?.resume_after_step).toBe("s_03");
      expect(record.meta.workspace?.origin).toEqual({
        kind: "checkpoint",
        run_id: "r_iso",
        step_span: "s_03",
      });
      expect(record.meta.workspace?.world_id).toBe("r_iso_child");
    } finally {
      cleanup();
    }
  });

  it("空清单的初始快照与 step 快照也可往返", () => {
    const tracer = new MemoryTracer();
    const empty = createWorkspaceSnapshot([]);
    tracer.startRun(v2RootMeta({ initial: empty }));
    const step = tracer.startSpan({ kind: "agent.step", n: 1 });
    tracer.endSpan(step, { workspace_snapshot: empty });
    tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

    const record = tracer.snapshot();
    expect(record.meta.workspace?.initial_snapshot.files).toEqual([]);
    const first = record.spans.find((span) => span.kind === "agent.step");
    expect(first?.kind === "agent.step" ? first.workspace_snapshot?.files : null).toEqual([]);
  });
});

describe("v2 跨行约束：已落盘的 step 必须带检查点", () => {
  it("v2 的 agent.step 缺 workspace_snapshot ⇒ 读取报错", () => {
    const lines = [
      JSON.stringify(v2RootMetaWithType()),
      JSON.stringify({ type: "span", id: "s_01", kind: "agent.step", parent: null, n: 1 }),
      JSON.stringify({ type: "run.event", event: "stopped", reason: "completed", at: 1 }),
    ];
    expect(() => parseRunText(lines)).toThrow(TraceReadError);
    expect(() => parseRunText(lines)).toThrow(/workspace_snapshot/);
  });

  it("v1 的 agent.step 无快照不受该约束（版本门禁只管 v2）", () => {
    const lines = [
      JSON.stringify({ type: "run.meta", ...sampleMeta(), format_version: 1 }),
      JSON.stringify({ type: "span", id: "s_01", kind: "agent.step", parent: null, n: 1 }),
      JSON.stringify({ type: "run.event", event: "stopped", reason: "completed", at: 1 }),
    ];
    expect(parseRunText(lines).status).toBe("completed");
  });

  it("v2 的 llm.call / tool.invoke 不要求快照（约束只针对 step）", () => {
    const record = parseRunText([
      JSON.stringify(v2RootMetaWithType()),
      JSON.stringify({
        type: "span",
        id: "s_01",
        kind: "agent.step",
        parent: null,
        n: 1,
        workspace_snapshot: createWorkspaceSnapshot([]),
      }),
      JSON.stringify({
        type: "span",
        id: "s_02",
        kind: "llm.call",
        parent: "s_01",
        request: sampleRequest(),
        response: sampleResponse(),
      }),
      JSON.stringify({ type: "run.event", event: "stopped", reason: "completed", at: 1 }),
    ]);
    expect(record.spans).toHaveLength(2);
  });
});

describe("快照 id 重算：读取时即拒绝哈希不符的文件", () => {
  it("v2 初始快照 id 与清单不符 ⇒ 读取报错", () => {
    const snapshot = createWorkspaceSnapshot([{ path: "a.txt", sha256: HASH_A, bytes: 3 }]);
    const meta = v2RootMetaWithType();
    (meta.workspace as { initial_snapshot: unknown }).initial_snapshot = {
      ...snapshot,
      id: HASH_B,
    };
    const lines = [
      JSON.stringify(meta),
      JSON.stringify({
        type: "span",
        id: "s_01",
        kind: "agent.step",
        parent: null,
        n: 1,
        workspace_snapshot: snapshot,
      }),
      JSON.stringify({ type: "run.event", event: "stopped", reason: "completed", at: 1 }),
    ];
    expect(() => parseRunText(lines)).toThrow(/初始快照校验失败/);
  });

  it("v2 步骤快照 id 与清单不符 ⇒ 读取报错", () => {
    const snapshot = createWorkspaceSnapshot([{ path: "a.txt", sha256: HASH_A, bytes: 3 }]);
    const lines = [
      JSON.stringify(v2RootMetaWithType()),
      JSON.stringify({
        type: "span",
        id: "s_01",
        kind: "agent.step",
        parent: null,
        n: 1,
        workspace_snapshot: { ...snapshot, id: HASH_B },
      }),
      JSON.stringify({ type: "run.event", event: "stopped", reason: "completed", at: 1 }),
    ];
    expect(() => parseRunText(lines)).toThrow(/步骤快照校验失败/);
  });
});

describe("无附件仍能看轨迹", () => {
  it("v2 文件可完整解析，即使附件目录从未存在", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, "r_iso.jsonl");
      const snapshot = createWorkspaceSnapshot([{ path: "a.txt", sha256: HASH_A, bytes: 12 }]);
      const tracer = new JsonlTracer(file);
      tracer.startRun(v2RootMeta({ initial: snapshot }));
      const step = tracer.startSpan({ kind: "agent.step", n: 1 });
      tracer.endSpan(step, { workspace_snapshot: snapshot });
      tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

      // 附件（内容寻址 blob）一个都没写：解析必须不依赖它，也不该顺手创建目录
      expect(existsSync(join(dir, "workspace-blobs"))).toBe(false);

      const record = readRun(file);
      expect(record.status).toBe("completed");
      // 轨迹内容照旧完整：清单里仍然写明文件引用（只是字节不在手边）
      expect(record.meta.workspace?.initial_snapshot.files).toEqual([
        { path: "a.txt", sha256: HASH_A, bytes: 12 },
      ]);
      expect(record.spans).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

describe("BaseTracer 版本门禁：转换前守卫（与 reader 同一套 helper）", () => {
  it("v1 meta 私带 workspace ⇒ startRun 抛错", () => {
    const tracer = new MemoryTracer();
    const meta = { ...sampleMeta(), workspace: {} } as unknown as RunMetaInput;
    expect(() => tracer.startRun(meta)).toThrow(/workspace/);
  });

  it("v1 meta 私带 workspace: undefined（自有属性）也拒绝", () => {
    const tracer = new MemoryTracer();
    const meta = { ...sampleMeta(), workspace: undefined } as RunMetaInput;
    expect(() => tracer.startRun(meta)).toThrow(/workspace/);
  });

  it("v1 meta 私带 fork.resume_after_step ⇒ startRun 抛错", () => {
    const tracer = new MemoryTracer();
    const meta = {
      ...sampleMeta(),
      fork: { at_span: "s_02", resume_after_step: "s_01", edit: {} },
    } as unknown as RunMetaInput;
    expect(() => tracer.startRun(meta)).toThrow(/resume_after_step/);
  });

  it("v1 运行里给 step 传 workspace_snapshot ⇒ endSpan 抛错（否则会被 zod 静默丢弃）", () => {
    const tracer = new MemoryTracer();
    tracer.startRun(sampleMeta());
    const step = tracer.startSpan({ kind: "agent.step", n: 1 });
    expect(() => tracer.endSpan(step, { workspace_snapshot: createWorkspaceSnapshot([]) })).toThrow(
      /workspace_snapshot/,
    );
  });

  it("给非 step 的 span 传 workspace_snapshot ⇒ 抛错（否则会被 schema 静默剥离）", () => {
    const tracer = new MemoryTracer();
    tracer.startRun(v2RootMeta());
    const step = tracer.startSpan({ kind: "agent.step", n: 1 });
    const llm = tracer.startSpan({ kind: "llm.call", parent: step, request: sampleRequest() });
    // 经变量传入以绕开对象字面量的多余属性检查——模拟"调用方写错 kind"的真实情形
    const wrongKindPatch = {
      response: sampleResponse(),
      workspace_snapshot: createWorkspaceSnapshot([]),
    };
    expect(() => tracer.endSpan(llm, wrongKindPatch)).toThrow(/只能由 agent.step 携带/);
  });

  it("v1 携带无关扩展字段仍照旧放行（不泛化 strict）", () => {
    const tracer = new MemoryTracer();
    const meta = { ...sampleMeta(), future_field: { anything: 1 } } as unknown as RunMetaInput;
    expect(() => tracer.startRun(meta)).not.toThrow();
  });

  it("v2 隔离运行：workspace 与 step 快照均正常写入", () => {
    const tracer = new MemoryTracer();
    tracer.startRun(v2RootMeta());
    const step = tracer.startSpan({ kind: "agent.step", n: 1 });
    tracer.endSpan(step, { workspace_snapshot: createWorkspaceSnapshot([]) });
    tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
    expect(tracer.snapshot().meta.workspace?.profile).toBe("file-tools-v1");
  });
});

/** v2 根 meta 的原始行对象（含 type 判别字段，供 parseRunText 直接消费） */
function v2RootMetaWithType(): Record<string, unknown> {
  return { type: "run.meta", ...v2RootMeta() };
}
