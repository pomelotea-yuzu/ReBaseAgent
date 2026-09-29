import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RunRepository } from "../src/main/run-repository";

/**
 * U6（add-partial-run-reading）tasks §3：repository 来源与轨迹投影。
 *
 * 3.2 直接缺父 ownOnly；3.3 隔代缺失连续 chain；3.4 prompt 独立范围；3.5 proxy
 * 不借其他记录；3.6 model_params 独立轨迹（不再误合并）；3.7 完整隔离 result 与
 * 直接/隔代缺失；3.8 混合链逐 hop 投影与未知 field 拒绝；3.9 恢复后全链重验。
 * 3.1 的单次读取上下文与严格 loader 复用在 §1 已落地，本文件以行为用例回锁。
 */

const T0 = "2026-01-15T10:00:00.000Z";
const ISO_FIXTURES = resolve(import.meta.dirname, "fixtures/u2-file-fixtures/iso-data/traces");

let root: string;
let traces: string;

function freshTraces(): string {
  root = mkdtempSync(join(tmpdir(), "u6-project-"));
  traces = join(root, "traces");
  mkdirSync(traces);
  return traces;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function metaLine(
  id: string,
  opts: {
    parent?: string | null;
    fork?: unknown;
    source?: unknown;
    extra?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task: "u6 投影夹具",
    model: "controlled-model",
    created_at: T0,
    parent: opts.parent ?? null,
    fork: opts.fork ?? null,
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...opts.extra,
  });
}

function stepLine(id: string, opts: { parent?: string | null; n?: number } = {}): string {
  return JSON.stringify({
    type: "span",
    id,
    parent: opts.parent ?? null,
    kind: "agent.step",
    n: opts.n ?? 1,
  });
}

const STOP = JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" });

function forkOf(field: string, atSpan: string): unknown {
  return { at_span: atSpan, edit: { field, value: `${field} 编辑值` } };
}

function writeRun(id: string, lines: string[]): void {
  writeFileSync(join(traces, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

describe("U6 §3.2/3.3：普通 result 缺祖先的结构化 ownOnly", () => {
  it("直接缺父：只读当前已校验自有记录，chain 只剩当前 run", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_no", fork: forkOf("result", "s_01") }),
      stepLine("c_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_c");
    expect(detail.completeness).toBe("ownOnly");
    expect(detail.spanScope).toBe("own");
    expect(detail.lineage).toEqual({
      status: "incomplete",
      reason: "ANCESTOR_NOT_FOUND",
      missingRunId: "r_no",
    });
    // 自有输出/步骤/消耗可读：spans/events/status 只来自当前 run
    expect(detail.spans.map((s) => s.id)).toEqual(["c_s1"]);
    expect(detail.leafSpanIds).toEqual(["c_s1"]);
    expect(detail.status).toBe("completed");
    expect(detail.chain.map((h) => h.meta.id)).toEqual(["r_c"]);
  });

  it("合法零 span 记录：空数组不当损坏，自有事件照常保留", () => {
    freshTraces();
    writeRun("r_c", [metaLine("r_c", { parent: "r_no", fork: forkOf("result", "s_01") }), STOP]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_c");
    expect(detail.completeness).toBe("ownOnly");
    expect(detail.spans).toEqual([]);
    expect(detail.leafSpanIds).toEqual([]);
    // 自有终止事件照常可读（不被祖先缺失抹掉）
    expect(detail.events).toHaveLength(1);
    expect(detail.status).toBe("completed");
  });

  it("3.3 隔代缺失：chain 保留当前与直接父，spans 不混入中间祖先轨迹", () => {
    freshTraces();
    writeRun("r_b", [
      metaLine("r_b", { parent: "r_no", fork: forkOf("result", "s_01") }),
      stepLine("b_s1"),
      STOP,
    ]);
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: forkOf("result", "b_s1") }),
      stepLine("c_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_c");
    expect(detail.completeness).toBe("ownOnly");
    expect(detail.lineage).toMatchObject({ missingRunId: "r_no" });
    // 不把直接父误报为缺失；连续 chain 保留；但轨迹只含当前 run 自有 spans
    expect(detail.chain.map((h) => h.meta.id)).toEqual(["r_b", "r_c"]);
    expect(detail.spans.map((s) => s.id)).toEqual(["c_s1"]);
  });
});

describe("U6 §3.4/3.5/3.6：独立执行边界（prompt / proxy / model_params）", () => {
  it("3.4 完整父链的 prompt fork：只展示自有 spans，父轨迹不进时间线", () => {
    freshTraces();
    writeRun("r_root", [metaLine("r_root"), stepLine("r_s1"), STOP]);
    writeRun("r_p", [
      metaLine("r_p", { parent: "r_root", fork: forkOf("user_message", "r_s1") }),
      stepLine("p_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_p");
    expect(detail.completeness).toBe("complete");
    expect(detail.spanScope).toBe("own");
    expect(detail.spans.map((s) => s.id)).toEqual(["p_s1"]);
    // chain 仍携带父级溯源（溯源不切断）
    expect(detail.chain.map((h) => h.meta.id)).toEqual(["r_root", "r_p"]);
  });

  it("3.4 prompt fork 缺祖先：从头轨迹语义不变，不补父 spans，父缺失原因可见", () => {
    freshTraces();
    writeRun("r_p", [
      metaLine("r_p", { parent: "r_no", fork: forkOf("user_message", "s_01") }),
      stepLine("p_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_p");
    expect(detail.completeness).toBe("ownOnly");
    expect(detail.spans.map((s) => s.id)).toEqual(["p_s1"]);
    expect(detail.chain.map((h) => h.meta.id)).toEqual(["r_p"]);
    expect(detail.lineage).toMatchObject({ missingRunId: "r_no" });
  });

  it("3.5 proxy fork 缺祖先：保留本次自有事实，缺失原因可见，不借用其他 proxy 记录", () => {
    freshTraces();
    const proxySource = { kind: "proxy", base_url: "http://127.0.0.1:9" };
    // 另一条完整的 proxy run 在盘上：缺失详情不得从它借任何记录
    writeRun("r_proxy_ok", [
      metaLine("r_proxy_ok", { parent: null, source: proxySource }),
      stepLine("ok_s1"),
      STOP,
    ]);
    writeRun("r_proxy_broken", [
      metaLine("r_proxy_broken", {
        parent: "r_ghost",
        fork: forkOf("messages", "s_01"),
        source: proxySource,
      }),
      stepLine("broken_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_proxy_broken");
    expect(detail.completeness).toBe("ownOnly");
    expect(detail.spans.map((s) => s.id)).toEqual(["broken_s1"]);
    expect(detail.chain.map((h) => h.meta.id)).toEqual(["r_proxy_broken"]);
    expect(JSON.stringify(detail)).not.toContain("ok_s1");
    expect(detail.lineage).toMatchObject({ missingRunId: "r_ghost" });
  });

  it("3.6 model_params 臂（完整链）：独立自有轨迹，不再误合并父前缀", () => {
    freshTraces();
    writeRun("r_root", [metaLine("r_root"), stepLine("r_s1"), STOP]);
    writeRun("r_arm", [
      metaLine("r_arm", { parent: "r_root", fork: forkOf("model_params", "r_s1") }),
      stepLine("arm_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_arm");
    // 修正点：旧实现把 model_params 臂交给 resolveBranch 合并 ⇒ spans 会混入 r_s1
    expect(detail.completeness).toBe("complete");
    expect(detail.spanScope).toBe("own");
    expect(detail.spans.map((s) => s.id)).toEqual(["arm_s1"]);
    expect(detail.chain.map((h) => h.meta.id)).toEqual(["r_root", "r_arm"]);
  });

  it("3.6 model_params 臂缺祖先：ownOnly，不算可比较结果，不补父历史", () => {
    freshTraces();
    writeRun("r_arm", [
      metaLine("r_arm", { parent: "r_no", fork: forkOf("model_params", "s_01") }),
      stepLine("arm_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_arm");
    expect(detail.completeness).toBe("ownOnly");
    expect(detail.spans.map((s) => s.id)).toEqual(["arm_s1"]);
    expect(detail.lineage).toMatchObject({ missingRunId: "r_no" });
  });
});

describe("U6 §3.7：隔离 result（v2）完整链与缺失", () => {
  /** u2 iso fixture 的隔离链：根(import v2) → 73kc → joiy（第四条文件是独立根，不入链） */
  function seedIso(): string[] {
    freshTraces();
    const ids = ["run_mufbxhbd_qp0ijq", "run_mufbxhen_73kc", "run_mufbxhf8_joiy"];
    for (const id of ids) {
      copyFileSync(join(ISO_FIXTURES, `${id}.jsonl`), join(traces, `${id}.jsonl`));
    }
    return ids;
  }

  it("完整隔离链：complete/resolved + 完整 lineage，v2 整轮前缀保留（含恢复点整轮的兄弟工具）", () => {
    const ids = seedIso();
    const leaf = ids[2] as string;
    const repo = new RunRepository(traces);
    const detail = repo.getRun(leaf);
    expect(detail.completeness).toBe("complete");
    expect(detail.spanScope).toBe("resolved");
    expect(detail.lineage).toEqual({ status: "complete" });
    expect(detail.chain.map((h) => h.meta.id)).toEqual(ids);
    // v2 语义：合并轨迹包含祖先轨迹的 span（叶自有之外还有继承前缀）
    const own = new Set(detail.leafSpanIds);
    const inherited = detail.spans.filter((s) => !own.has(s.id));
    expect(inherited.length).toBeGreaterThan(0);
  });

  it("隔离 result 直接父缺失：ownOnly，missingRunId 是直接父", () => {
    const ids = seedIso();
    rmSync(join(traces, `${ids[1]}.jsonl`));
    const repo = new RunRepository(traces);
    const detail = repo.getRun(ids[2] as string);
    expect(detail.completeness).toBe("ownOnly");
    expect(detail.lineage).toMatchObject({ missingRunId: ids[1] });
    expect(detail.chain.map((h) => h.meta.id)).toEqual([ids[2]]);
  });

  it("隔离 result 隔代缺失：chain 保留连续可读段，断点指向最接近缺失的祖先", () => {
    const ids = seedIso();
    rmSync(join(traces, `${ids[0]}.jsonl`));
    const repo = new RunRepository(traces);
    const detail = repo.getRun(ids[2] as string);
    expect(detail.completeness).toBe("ownOnly");
    expect(detail.lineage).toMatchObject({ missingRunId: ids[0] });
    expect(detail.chain.map((h) => h.meta.id)).toEqual([ids[1], ids[2]]);
    // 轨迹仍只含当前 run 自有 spans（不混入可读祖先的轨迹）
    const own = new Set(detail.spans.map((s) => s.id));
    for (const leafId of detail.leafSpanIds) {
      expect(own.has(leafId)).toBe(true);
    }
  });
});

describe("U6 §3.8：混合链逐 hop 投影", () => {
  it("result 的父是 prompt fork：不跨独立边界拼接（root 轨迹不进 result 时间线），chain 溯源不断", () => {
    freshTraces();
    writeRun("r_root", [metaLine("r_root"), stepLine("r_s1"), STOP]);
    writeRun("r_p", [
      metaLine("r_p", { parent: "r_root", fork: forkOf("user_message", "r_s1") }),
      stepLine("p_s1"),
      STOP,
    ]);
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_p", fork: forkOf("result", "p_s1") }),
      stepLine("c_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_c");
    expect(detail.completeness).toBe("complete");
    expect(detail.spanScope).toBe("resolved");
    // 投影：prompt 边界重置 ⇒ 时间线 = prompt 自有（截至分叉点）+ result 自有，无 root spans
    expect(detail.spans.map((s) => s.id)).toEqual(["p_s1", "c_s1"]);
    // chain 仍是根到叶的完整来源（溯源不切断）
    expect(detail.chain.map((h) => h.meta.id)).toEqual(["r_root", "r_p", "r_c"]);
  });

  it("纯 result 链不受投影改造影响：resolveBranch 既有行为逐 id 不变（对照「普通 result 的完整父链仍合并」）", () => {
    freshTraces();
    writeRun("r_a", [
      metaLine("r_a"),
      stepLine("s_01"),
      stepLine("s_02", { parent: "s_01" }),
      STOP,
    ]);
    writeRun("r_b", [
      metaLine("r_b", { parent: "r_a", fork: forkOf("result", "s_01") }),
      stepLine("b_s1"),
      STOP,
    ]);
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: forkOf("result", "b_s1") }),
      stepLine("c_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_c");
    expect(detail.completeness).toBe("complete");
    expect(detail.spanScope).toBe("resolved");
    expect(detail.spans.map((s) => s.id)).toEqual(["s_01", "b_s1", "c_s1"]);
  });

  it("未知 edit.field：明确拒绝，不默认按 result 拼接", () => {
    freshTraces();
    writeRun("r_a", [metaLine("r_a"), stepLine("s_01"), STOP]);
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_a", fork: forkOf("mystery_field", "s_01") }),
      stepLine("c_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    try {
      repo.getRun("r_c");
      expect.unreachable("未知字段必须拒绝");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("mystery_field");
      expect(message).toContain("不受支持");
    }
  });
});

describe("U6 §3.9：父文件恢复后全链重验（无跨调用缓存）", () => {
  it("ownOnly → 恢复父文件 → complete；恢复的是损坏文件 → 仍失败，不缓存旧结论", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: forkOf("result", "b_s1") }),
      stepLine("c_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const before = repo.getRun("r_c");
    expect(before.completeness).toBe("ownOnly");
    expect(before.lineage).toMatchObject({ missingRunId: "r_b" });

    // 恢复成损坏文件：重验失败（不是拿旧 ownOnly 糊弄，也不是降级）
    writeFileSync(join(traces, "r_b.jsonl"), "不是合法 JSONL\n");
    expect(() => repo.getRun("r_c")).toThrow(/祖先 run r_b/);

    // 恢复成合法文件：重新完成整条链校验后切回 complete
    writeRun("r_b", [
      metaLine("r_b", { parent: null }),
      stepLine("b_s1"),
      stepLine("b_s2", { parent: "b_s1" }),
      STOP,
    ]);
    const after = repo.getRun("r_c");
    expect(after.completeness).toBe("complete");
    expect(after.spanScope).toBe("resolved");
    expect(after.lineage).toEqual({ status: "complete" });
    // v1 截断语义：前缀截至 at_span（含），b_s2 在分叉点之后不进 c 的轨迹
    expect(after.spans.map((s) => s.id)).toEqual(["b_s1", "c_s1"]);
    expect(existsSync(join(traces, "r_b.jsonl"))).toBe(true);
  });
});
