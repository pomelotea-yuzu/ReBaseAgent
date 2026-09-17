import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertDeletable, assertForkable, readRun, resolveBranch } from "../src/index";
import type { RunMetaInput, RunRecord, SpanLine, WorkspaceSnapshot } from "../src/index";
import { createWorkspaceSnapshot } from "../src/workspace-hash";
import { buildRecord, sampleMeta, sampleRequest, sampleResponse } from "./helpers";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** 内存 loader：按 id 查表 */
function loaderOf(map: Record<string, RunRecord>) {
  return (id: string): RunRecord => {
    const rec = map[id];
    if (rec === undefined) {
      throw new Error(`文件不存在：${id}.jsonl`);
    }
    return rec;
  };
}

describe("resolveBranch：fixtures 分支链拼接", () => {
  it("branch.jsonl 沿 parent 链拼接出完整轨迹（copy-on-write 前缀共享）", () => {
    const normal = readRun(`${fixturesDir}normal.jsonl`);
    const branch = readRun(`${fixturesDir}branch.jsonl`);
    const resolved = resolveBranch("r_02", loaderOf({ r_01: normal, r_02: branch }));

    // 前缀 = r_01 中 fork 点 s_03 及之前的 3 个 span；后接 r_02 新增的 5 个 span
    expect(resolved.spans.map((s) => s.id)).toEqual([
      "s_01",
      "s_02",
      "s_03",
      "s_09",
      "s_10",
      "s_11",
      "s_12",
      "s_13",
    ]);
    // 暴露 fork 元数据（编辑语义由 replay 层应用）
    expect(resolved.chain).toHaveLength(2);
    expect(resolved.chain[0]?.fork).toBeNull();
    expect(resolved.chain[1]?.fork?.at_span).toBe("s_03");
    expect(resolved.chain[1]?.fork?.edit.field).toBe("result");
    expect(resolved.meta.id).toBe("r_02");
    expect(resolved.meta.parent).toBe("r_01");
  });

  it("根 run（无 parent）直接返回自身轨迹", () => {
    const normal = readRun(`${fixturesDir}normal.jsonl`);
    const resolved = resolveBranch("r_01", loaderOf({ r_01: normal }));
    expect(resolved.spans.map((s) => s.id)).toEqual([
      "s_01",
      "s_02",
      "s_03",
      "s_04",
      "s_05",
      "s_06",
      "s_07",
      "s_08",
    ]);
    expect(resolved.chain).toHaveLength(1);
  });
});

describe("resolveBranch：多级链与错误路径", () => {
  const root = buildRecord(sampleMeta({ id: "r_root" }));
  root.spans = [
    { type: "span", id: "s_01", kind: "agent.step", parent: null, n: 1 },
    { type: "span", id: "s_02", kind: "agent.step", parent: null, n: 2 },
    { type: "span", id: "s_03", kind: "agent.step", parent: null, n: 3 },
  ];
  const mid = buildRecord(
    sampleMeta({
      id: "r_mid",
      parent: "r_root",
      fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
    }),
  );
  mid.spans = [
    { type: "span", id: "m_01", kind: "agent.step", parent: null, n: 2 },
    { type: "span", id: "m_02", kind: "agent.step", parent: null, n: 3 },
  ];
  const leaf = buildRecord(
    sampleMeta({
      id: "r_leaf",
      parent: "r_mid",
      fork: { at_span: "m_02", edit: { field: "result", value: "y" } },
    }),
  );
  leaf.spans = [{ type: "span", id: "l_01", kind: "agent.step", parent: null, n: 4 }];

  it("两级分支链逐级截断拼接", () => {
    const resolved = resolveBranch("r_leaf", loaderOf({ r_root: root, r_mid: mid, r_leaf: leaf }));
    // root[s_01..s_03] --fork s_01--> [s_01, m_01, m_02] --fork m_02--> [s_01, m_01, m_02, l_01]
    expect(resolved.spans.map((s) => s.id)).toEqual(["s_01", "m_01", "m_02", "l_01"]);
    expect(resolved.chain.map((c) => c.meta.id)).toEqual(["r_root", "r_mid", "r_leaf"]);
  });

  it("环检测：parent 链成环报错", () => {
    const a = buildRecord(
      sampleMeta({
        id: "r_a",
        parent: "r_b",
        fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
      }),
    );
    const b = buildRecord(
      sampleMeta({
        id: "r_b",
        parent: "r_a",
        fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
      }),
    );
    expect(() => resolveBranch("r_a", loaderOf({ r_a: a, r_b: b }))).toThrow(/成环/);
  });

  it("父 run 文件缺失：报错指明 run id", () => {
    const orphan = buildRecord(
      sampleMeta({
        id: "r_x",
        parent: "r_missing",
        fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
      }),
    );
    expect(() => resolveBranch("r_x", loaderOf({ r_x: orphan }))).toThrow(
      /父 run 文件缺失或无法读取：r_missing/,
    );
  });

  it("从未封存（crashed）的 run 分叉：拒绝", () => {
    const crashed = buildRecord(sampleMeta({ id: "r_crashed" }), { crashed: true });
    const child = buildRecord(
      sampleMeta({
        id: "r_child",
        parent: "r_crashed",
        fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
      }),
    );
    expect(() =>
      resolveBranch("r_child", loaderOf({ r_crashed: crashed, r_child: child })),
    ).toThrow(/只能从已完成的 run 分支/);
  });

  it("fork 点不存在于父轨迹：报错", () => {
    const badFork = buildRecord(
      sampleMeta({
        id: "r_bad",
        parent: "r_root",
        fork: { at_span: "s_99", edit: { field: "result", value: "x" } },
      }),
    );
    expect(() => resolveBranch("r_bad", loaderOf({ r_root: root, r_bad: badFork }))).toThrow(
      /fork 点 s_99 不存在于 r_root 的轨迹/,
    );
  });

  it("parent 非空但缺少 fork 元数据：报错", () => {
    const noFork = buildRecord(sampleMeta({ id: "r_noFork", parent: "r_root" }));
    expect(() => resolveBranch("r_noFork", loaderOf({ r_root: root, r_noFork: noFork }))).toThrow(
      /缺少 fork 元数据/,
    );
  });
});

describe("保护守卫", () => {
  it("assertForkable：crashed 的 run 不可作为分叉父", () => {
    expect(() => assertForkable(buildRecord(sampleMeta(), { crashed: true }))).toThrow(
      /只能从已完成的 run 分支/,
    );
    expect(() => assertForkable(buildRecord(sampleMeta()))).not.toThrow();
  });

  it("assertDeletable：有子分支的 run 拒绝删除并提示数量", () => {
    const metas = [
      buildRecord(sampleMeta({ id: "r_01" })).meta,
      buildRecord(
        sampleMeta({
          id: "r_02",
          parent: "r_01",
          fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
        }),
      ).meta,
    ];
    expect(() => assertDeletable("r_01", metas)).toThrow(/有 1 个分支引用此 run/);
    expect(() => assertDeletable("r_02", metas)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// v2 整轮截断（隔离文件重跑）
// ---------------------------------------------------------------------------

/** 手工组装语义序轨迹用的行构造器 */
function stepLine(
  id: string,
  parent: string | null,
  n: number,
  snapshot: WorkspaceSnapshot,
): SpanLine {
  return { type: "span", id, kind: "agent.step", parent, n, workspace_snapshot: snapshot };
}

function llmLine(id: string, parent: string): SpanLine {
  return {
    type: "span",
    id,
    kind: "llm.call",
    parent,
    request: sampleRequest(),
    response: sampleResponse(),
  };
}

function toolLine(id: string, parent: string, result: string): SpanLine {
  return {
    type: "span",
    id,
    kind: "tool.invoke",
    parent,
    tool: "write_file",
    args: { path: "a.txt" },
    result,
    dur_ms: 1,
    error: null,
  };
}

/** v2 隔离根 run 的 meta（origin=import） */
function v2Root(id: string): RunMetaInput {
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
      initial_snapshot: createWorkspaceSnapshot([]),
      origin: { kind: "import" },
    },
  };
}

/** v2 隔离分支 run 的 meta（origin=checkpoint，带整轮续跑边界） */
function v2Fork(id: string, parent: string, atSpan: string, stepSpan: string): RunMetaInput {
  return {
    id,
    format_version: 2,
    task: "隔离分支",
    model: "deepseek-chat",
    created_at: "2026-09-17T00:00:00.000Z",
    parent,
    fork: {
      at_span: atSpan,
      resume_after_step: stepSpan,
      edit: { field: "result", value: "改后的结果" },
    },
    config_hash: "sha256:abc",
    workspace: {
      profile: "file-tools-v1",
      world_id: id,
      write_authorized: true,
      initial_snapshot: createWorkspaceSnapshot([]),
      origin: { kind: "checkpoint", run_id: parent, step_span: stepSpan },
    },
  };
}

describe("resolveBranch：v2 整轮截断（隔离分叉）", () => {
  const empty = createWorkspaceSnapshot([]);

  /** 父 run：第 1 轮里有两个**依次执行**的兄弟工具（s_03 是被编辑的 T1，s_04 是 T2） */
  const parent = buildRecord(v2Root("r_iso"));
  parent.spans = [
    stepLine("s_01", null, 1, empty),
    llmLine("s_02", "s_01"),
    toolLine("s_03", "s_01", "写入 a"),
    toolLine("s_04", "s_01", "写入 b"),
    stepLine("s_05", null, 2, empty),
    llmLine("s_06", "s_05"),
  ];

  it("前缀保留该轮全部兄弟工具，再接入子运行", () => {
    const child = buildRecord(v2Fork("r_iso_child", "r_iso", "s_03", "s_01"));
    child.spans = [stepLine("s_07", null, 1, empty), llmLine("s_08", "s_07")];
    const resolved = resolveBranch("r_iso_child", loaderOf({ r_iso: parent, r_iso_child: child }));
    // 恢复点是"该轮末尾" ⇒ s_04（同轮兄弟）保留，第 2 轮（s_05/s_06）被截掉
    expect(resolved.spans.map((s) => s.id)).toEqual([
      "s_01",
      "s_02",
      "s_03",
      "s_04",
      "s_07",
      "s_08",
    ]);
  });

  it("对照 v1：同一结构按 at_span 截断会丢掉同轮兄弟工具", () => {
    const v1Parent = buildRecord(sampleMeta({ id: "r_v1" }));
    v1Parent.spans = [
      { type: "span", id: "s_01", kind: "agent.step", parent: null, n: 1 },
      llmLine("s_02", "s_01"),
      toolLine("s_03", "s_01", "写入 a"),
      toolLine("s_04", "s_01", "写入 b"),
      { type: "span", id: "s_05", kind: "agent.step", parent: null, n: 2 },
    ];
    const v1Child = buildRecord(
      sampleMeta({
        id: "r_v1_child",
        parent: "r_v1",
        fork: { at_span: "s_03", edit: { field: "result", value: "改后的结果" } },
      }),
    );
    v1Child.spans = [llmLine("s_09", "s_05")];
    const resolved = resolveBranch("r_v1_child", loaderOf({ r_v1: v1Parent, r_v1_child: v1Child }));
    // v1 语义不变：截至 at_span ⇒ s_04 与 s_05 都被截掉（这正是 v2 要修的）
    expect(resolved.spans.map((s) => s.id)).toEqual(["s_01", "s_02", "s_03", "s_09"]);
  });

  it("多级 v2 链：逐级按整轮边界拼接", () => {
    const mid = buildRecord(v2Fork("r_mid2", "r_iso", "s_03", "s_01"));
    mid.spans = [
      stepLine("m_01", null, 1, empty),
      toolLine("m_02", "m_01", "写入 c"),
      toolLine("m_03", "m_01", "写入 d"),
    ];
    const leaf = buildRecord(v2Fork("r_leaf2", "r_mid2", "m_02", "m_01"));
    leaf.spans = [stepLine("l_01", null, 1, empty)];
    const resolved = resolveBranch(
      "r_leaf2",
      loaderOf({ r_iso: parent, r_mid2: mid, r_leaf2: leaf }),
    );
    expect(resolved.spans.map((s) => s.id)).toEqual([
      "s_01",
      "s_02",
      "s_03",
      "s_04",
      "m_01",
      "m_02",
      "m_03",
      "l_01",
    ]);
  });

  it("边界矛盾：v2 分支缺 resume_after_step ⇒ 拒绝（不静默套用 v1 截断）", () => {
    const meta = v2Fork("r_c1", "r_iso", "s_03", "s_01");
    const child = buildRecord({
      ...meta,
      fork: { at_span: "s_03", edit: { field: "result", value: "x" } },
    });
    expect(() => resolveBranch("r_c1", loaderOf({ r_iso: parent, r_c1: child }))).toThrow(
      /缺少 fork.resume_after_step/,
    );
  });

  it("边界矛盾：resume_after_step 指向非步骤 ⇒ 拒绝", () => {
    const child = buildRecord(v2Fork("r_c2", "r_iso", "s_03", "s_02")); // s_02 是 llm.call
    expect(() => resolveBranch("r_c2", loaderOf({ r_iso: parent, r_c2: child }))).toThrow(
      /必须是 agent.step/,
    );
  });

  it("边界矛盾：at_span 不属于该 step ⇒ 拒绝", () => {
    // s_06 属第 2 轮（s_05），却把边界指成第 1 轮（s_01）
    const child = buildRecord(v2Fork("r_c3", "r_iso", "s_06", "s_01"));
    expect(() => resolveBranch("r_c3", loaderOf({ r_iso: parent, r_c3: child }))).toThrow(
      /不属于 resume_after_step/,
    );
  });

  it("边界矛盾：at_span 等于 step 本身 ⇒ 拒绝", () => {
    const child = buildRecord(v2Fork("r_c4", "r_iso", "s_01", "s_01"));
    expect(() => resolveBranch("r_c4", loaderOf({ r_iso: parent, r_c4: child }))).toThrow(
      /不能等于 resume_after_step/,
    );
  });

  it("边界矛盾：step 只存在于祖先、不在直接父自有记录 ⇒ 拒绝", () => {
    const mid = buildRecord(v2Fork("r_mid", "r_iso", "s_03", "s_01"));
    mid.spans = [stepLine("m_01", null, 1, empty), llmLine("m_02", "m_01")];
    // 叶子把边界指成 **root** 的 s_01，而它不在直接父 r_mid 的自有记录里
    const leaf = buildRecord(v2Fork("r_leaf", "r_mid", "m_02", "s_01"));
    leaf.spans = [stepLine("l_01", null, 1, empty)];
    expect(() =>
      resolveBranch("r_leaf", loaderOf({ r_iso: parent, r_mid: mid, r_leaf: leaf })),
    ).toThrow(/不在直接父 run r_mid 的自有记录中/);
  });

  it("根 run 携带 fork ⇒ 拒绝（没有可续跑的父）", () => {
    const bad = buildRecord({
      ...v2Root("r_root_bad"),
      fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
    });
    bad.spans = [stepLine("s_01", null, 1, empty)];
    expect(() => resolveBranch("r_root_bad", loaderOf({ r_root_bad: bad }))).toThrow(
      /根 run r_root_bad 不应携带 fork 元数据/,
    );
  });
});
