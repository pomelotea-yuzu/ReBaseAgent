import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { RunRepository } from "../src/main/run-repository";
import type { RunDetail } from "../src/shared/ipc";
import { RunDetailSchema } from "../src/shared/ipc";
import { findRunDetailIntegrityViolation } from "../src/shared/run-detail-integrity";

/**
 * U6（add-partial-run-reading）tasks §2：详情完整性契约。
 *
 * 2.1 completeness/spanScope/lineage 必填结构与合法组合；2.2 chain 连续性/唯一性/
 * 末跳身份/缺失边界；2.3 leafSpanIds 自有范围（合法空数组）；2.4 main 返回自检与
 * renderer 消费入口对错配载荷的整份拒绝；2.5 的契约半边（错配载荷不能借缺省通过）。
 */

const FIXTURES = resolve(import.meta.dirname, "../../../packages/trace-sdk/fixtures");
const T0 = "2026-01-15T10:00:00.000Z";

let root: string;
let traces: string;

function freshTraces(): string {
  root = mkdtempSync(join(tmpdir(), "u6-detail-contract-"));
  traces = join(root, "traces");
  mkdirSync(traces);
  return traces;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function metaLine(
  id: string,
  opts: { parent?: string | null; fork?: unknown; extra?: Record<string, unknown> } = {},
): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task: "u6 契约夹具",
    model: "controlled-model",
    created_at: T0,
    parent: opts.parent ?? null,
    fork: opts.fork ?? null,
    ...opts.extra,
  });
}

const STOP = JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" });

function writeRun(id: string, lines: string[]): void {
  writeFileSync(join(traces, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

function hop(
  id: string,
  parent: string | null,
): { meta: { id: string; parent: string | null }; fork: null } {
  return {
    meta: {
      id,
      parent,
      type: "run.meta",
      format_version: 1,
      task: "t",
      model: "m",
      created_at: T0,
      fork: null,
    },
    fork: null,
  };
}

/** 合法根 run 详情（complete/own），各错配用例在其上做单点破坏 */
function validRootDetail(): RunDetail {
  return {
    meta: hop("r_a", null).meta as RunDetail["meta"],
    spans: [],
    events: [],
    status: "completed",
    chain: [hop("r_a", null)],
    leafSpanIds: [],
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

describe("U6 §2 完整性判据：合法组合", () => {
  it("2.1 complete/own（根 run）：chain 单跳即根，空 spans + 空 leafSpanIds 合法", () => {
    const detail = validRootDetail();
    expect(findRunDetailIntegrityViolation(detail)).toBeNull();
    expect(RunDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("2.1 complete/resolved：leafSpanIds 是 spans 的无重复子集", () => {
    const detail = validRootDetail();
    const resolved = {
      ...detail,
      spanScope: "resolved" as const,
      spans: [{ id: "s_1" }, { id: "s_2" }] as RunDetail["spans"],
      leafSpanIds: ["s_2"],
    };
    expect(findRunDetailIntegrityViolation(resolved)).toBeNull();
  });

  it("2.1 ownOnly/own：链在缺失点截断，首项 parent=missingRunId 且断点在链外", () => {
    const detail: RunDetail = {
      ...validRootDetail(),
      meta: hop("r_c", "r_b").meta as RunDetail["meta"],
      chain: [hop("r_b", "r_no"), { ...hop("r_c", "r_b") }],
      completeness: "ownOnly",
      spanScope: "own",
      lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_no" },
    };
    expect(findRunDetailIntegrityViolation(detail)).toBeNull();
    expect(RunDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("2.3 多跳 complete/resolved 的相邻连续与末跳身份成立（对照「普通 result 的隔代祖先缺失」的正形态）", () => {
    const detail: RunDetail = {
      ...validRootDetail(),
      meta: hop("r_c", "r_b").meta as RunDetail["meta"],
      spans: [{ id: "s_1" }] as RunDetail["spans"],
      chain: [hop("r_a", null), hop("r_b", "r_a"), hop("r_c", "r_b")],
      leafSpanIds: ["s_1"],
      spanScope: "resolved",
    };
    expect(findRunDetailIntegrityViolation(detail)).toBeNull();
  });
});

describe("U6 §2 完整性判据：错配整份拒绝（对应「详情完整性字段拒绝错配」）", () => {
  const cases: Array<[string, RunDetail]> = [
    [
      "complete 却携带缺失字段",
      {
        ...validRootDetail(),
        lineage: {
          status: "incomplete",
          reason: "ANCESTOR_NOT_FOUND",
          missingRunId: "r_x",
        },
      },
    ],
    [
      "ownOnly 却配 resolved",
      {
        ...validRootDetail(),
        meta: hop("r_c", "r_no").meta as RunDetail["meta"],
        chain: [hop("r_c", "r_no")],
        completeness: "ownOnly",
        spanScope: "resolved",
        lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_no" },
      },
    ],
    [
      "complete 首项不是根",
      {
        ...validRootDetail(),
        chain: [hop("r_b", "r_a"), hop("r_c", "r_b")],
      },
    ],
    [
      "chain 首尾断裂（相邻 parent 不连续）",
      { ...validRootDetail(), chain: [hop("r_a", null), hop("r_c", "r_x")] },
    ],
    [
      "chain 末跳身份与 meta 不符",
      { ...validRootDetail(), meta: hop("r_z", null).meta as RunDetail["meta"] },
    ],
    [
      "chain hop 重复",
      {
        ...validRootDetail(),
        chain: [hop("r_a", null), { ...hop("r_a", null) }],
      },
    ],
    ["chain 为空", { ...validRootDetail(), chain: [] }],
    [
      "ownOnly 首项 parent 不等于 missingRunId",
      {
        ...validRootDetail(),
        chain: [hop("r_c", "r_other")],
        completeness: "ownOnly",
        spanScope: "own",
        lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_no" },
      },
    ],
    [
      "missingRunId 出现在 chain 内（断点不在链外）",
      {
        ...validRootDetail(),
        chain: [hop("r_b", "r_a"), hop("r_c", "r_b")],
        completeness: "ownOnly",
        spanScope: "own",
        lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_b" },
      },
    ],
    [
      "ownOnly 缺 missingRunId（strict 拒未知形态）",
      {
        ...validRootDetail(),
        chain: [hop("r_c", "r_no")],
        completeness: "ownOnly",
        spanScope: "own",
        lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND" } as RunDetail["lineage"],
      },
    ],
    [
      "own 范围 leafSpanIds 遗漏自有 span",
      {
        ...validRootDetail(),
        spans: [{ id: "s_1" }] as RunDetail["spans"],
        leafSpanIds: [],
      },
    ],
    [
      "leafSpanIds 引用 spans 之外的 id（own 与 resolved 同拒）",
      {
        ...validRootDetail(),
        spanScope: "resolved",
        spans: [{ id: "s_1" }] as RunDetail["spans"],
        leafSpanIds: ["s_ghost"],
      },
    ],
    [
      "leafSpanIds 重复",
      {
        ...validRootDetail(),
        spanScope: "resolved",
        spans: [{ id: "s_1" }] as RunDetail["spans"],
        leafSpanIds: ["s_1", "s_1"],
      },
    ],
  ];

  for (const [name, detail] of cases) {
    it(`拒绝：${name}`, () => {
      expect(findRunDetailIntegrityViolation(detail)).not.toBeNull();
      expect(RunDetailSchema.safeParse(detail).success).toBe(false);
    });
  }

  it("未知枚举由 schema 拒绝（不能借未知字段剥离接受错配）", () => {
    const bad = {
      ...validRootDetail(),
      completeness: "partially",
    } as unknown as RunDetail;
    expect(RunDetailSchema.safeParse(bad).success).toBe(false);
    const badLineage = {
      ...validRootDetail(),
      lineage: { status: "unknown" },
    } as unknown as RunDetail;
    expect(RunDetailSchema.safeParse(badLineage).success).toBe(false);
  });

  it("缺省 completeness 整份拒绝（不允许静默缺省）", () => {
    const legacy = {
      meta: validRootDetail().meta,
      spans: [],
      events: [],
      status: "completed",
      chain: [hop("r_a", null)],
      leafSpanIds: [],
    };
    expect(RunDetailSchema.safeParse(legacy).success).toBe(false);
  });
});

describe("U6 §2 main 返回自检与消费入口", () => {
  it("2.4 main 四形态产出都能通过自家 schema：根 / 完整 result / prompt 完整 / prompt 缺祖先 ownOnly", () => {
    freshTraces();
    copyFileSync(join(FIXTURES, "normal.jsonl"), join(traces, "r_01.jsonl"));
    copyFileSync(join(FIXTURES, "branch.jsonl"), join(traces, "r_02.jsonl"));
    writeRun("r_p", [
      metaLine("r_p", {
        parent: "r_01",
        fork: { at_span: "s_01", edit: { field: "user_message", value: "改写后的问题" } },
      }),
      STOP,
    ]);
    writeRun("r_missing_child", [
      metaLine("r_missing_child", {
        parent: "r_ghost",
        fork: { at_span: "s_01", edit: { field: "user_message", value: "父不存在" } },
      }),
      STOP,
    ]);
    const repo = new RunRepository(traces);

    const rootDetail = repo.getRun("r_01");
    expect(rootDetail.completeness).toBe("complete");
    expect(rootDetail.spanScope).toBe("own");
    expect(RunDetailSchema.safeParse(rootDetail).success).toBe(true);

    const resultDetail = repo.getRun("r_02");
    expect(resultDetail.completeness).toBe("complete");
    expect(resultDetail.spanScope).toBe("resolved");
    expect(RunDetailSchema.safeParse(resultDetail).success).toBe(true);

    const promptDetail = repo.getRun("r_p");
    expect(promptDetail.completeness).toBe("complete");
    expect(promptDetail.spanScope).toBe("own");
    expect(RunDetailSchema.safeParse(promptDetail).success).toBe(true);

    const orphanDetail = repo.getRun("r_missing_child");
    expect(orphanDetail.completeness).toBe("ownOnly");
    expect(orphanDetail.spanScope).toBe("own");
    expect(orphanDetail.lineage).toEqual({
      status: "incomplete",
      reason: "ANCESTOR_NOT_FOUND",
      missingRunId: "r_ghost",
    });
    // chain 只含当前 run，自有 spans 不受影响（空 spans 也合法）
    expect(orphanDetail.chain.map((h) => h.meta.id)).toEqual(["r_missing_child"]);
    expect(RunDetailSchema.safeParse(orphanDetail).success).toBe(true);

    // 普通/隔离 result 缺祖先：U6 §3.2 起同样返回结构化 ownOnly
    writeRun("r_result_child", [
      metaLine("r_result_child", {
        parent: "r_ghost",
        fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
      }),
      STOP,
    ]);
    const resultOwnOnly = repo.getRun("r_result_child");
    expect(resultOwnOnly.completeness).toBe("ownOnly");
    expect(resultOwnOnly.spanScope).toBe("own");
    expect(resultOwnOnly.lineage).toEqual({
      status: "incomplete",
      reason: "ANCESTOR_NOT_FOUND",
      missingRunId: "r_ghost",
    });
    expect(RunDetailSchema.safeParse(resultOwnOnly).success).toBe(true);
  });

  it("2.5 U5 后台核实入口对错配载荷返回失败（verifyResultPayload 不放宽）", async () => {
    const { verifyResultPayload } = await import("../src/renderer/src/lib/result-verification");
    freshTraces();
    writeRun("r_ok", [metaLine("r_ok"), STOP]);
    const detail = readRun(join(traces, "r_ok.jsonl"));
    const legacy = {
      meta: detail.meta,
      spans: detail.spans,
      events: detail.events,
      status: detail.status,
      chain: [{ meta: detail.meta, fork: detail.meta.fork }],
      leafSpanIds: detail.spans.map((s) => s.id),
    };
    const envelope = { ok: true as const, data: legacy };
    const outcome = verifyResultPayload("r_ok", envelope);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // 拒绝原因落在完整性契约，而不是身份核对（身份本身是对的）
      expect(outcome.reason).toBeTruthy();
    }
  });
});
