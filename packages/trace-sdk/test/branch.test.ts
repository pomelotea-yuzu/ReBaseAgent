import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertDeletable, assertForkable, readRun, resolveBranch } from "../src/index";
import type { RunRecord } from "../src/index";
import { buildRecord, sampleMeta } from "./helpers";

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
