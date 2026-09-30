import type { CompareRunItem, RunDetail } from "@shared/ipc";
import { ok } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import {
  COMPARE_RESPONSE_MISMATCH,
  applyCompareResponse,
  beginCompareRead,
  destroyCompareRead,
  emptyCompareReadSession,
  findCompareSelectionViolation,
  retryCompareRead,
  sameCompareSelection,
} from "../src/renderer/src/lib/compare-state";

/**
 * U7 任务 1.4/1.5 的纯判据半边：选择集合法性（与 IPC schema 同源）、
 * 代次推进、响应错配整份拒绝。store 接线半边见 compare-store.test.ts。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function detailOf(id: string): RunDetail {
  const meta = {
    id,
    parent: null,
    type: "run.meta" as const,
    format_version: 1 as const,
    task: `任务 ${id}`,
    model: "m",
    created_at: T0,
    fork: null,
  };
  return {
    meta,
    spans: [],
    events: [],
    status: "completed",
    chain: [{ meta, fork: null }],
    leafSpanIds: [],
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

function readyItem(id: string): CompareRunItem {
  return {
    status: "ready",
    runId: id,
    detail: detailOf(id),
    chainSummaries: [
      {
        id,
        task: `任务 ${id}`,
        model: "m",
        created_at: T0,
        status: "completed",
        parent: null,
        reason: "completed",
        fork: null,
        steps: 1,
        toolCalls: 0,
        toolErrors: 0,
        tokensIn: 10,
        tokensOut: 5,
        cacheHit: null,
        durationMs: 100,
        source: null,
      },
    ],
  };
}

describe("U7 1.4 选择集合法性（与 IPC schema 同源）", () => {
  it("空集/第五条/重复/空 id 各给首条受控原因", () => {
    expect(findCompareSelectionViolation([])).toContain("至少");
    expect(findCompareSelectionViolation(["a", "b", "c", "d", "e"])).toContain("最多");
    expect(findCompareSelectionViolation(["a", "a"])).toContain("比较对象重复");
    expect(findCompareSelectionViolation([""])).toContain("不能为空");
    expect(findCompareSelectionViolation(["r_a", "r_b"])).toBeNull();
  });

  it("顺序即身份：同 id 不同序不是同一选择集（左右语义的一部分）", () => {
    expect(sameCompareSelection(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameCompareSelection(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameCompareSelection(["a"], ["a", "b"])).toBe(false);
    expect(sameCompareSelection(null, null)).toBe(true);
    expect(sameCompareSelection(null, ["a"])).toBe(false);
  });
});

describe("U7 1.4 响应应用守卫（纯判据）", () => {
  it("无在飞请求时响应整份丢弃（离场/替换后的迟到响应无处落地）", () => {
    const state = emptyCompareReadSession();
    const applied = applyCompareResponse(state, 1, ["r_a"], ok({ items: [readyItem("r_a")] }));
    expect(applied).toBe(state);
  });

  it("响应与请求错配（缺一项）⇒ rejected 结论点明错配，不半截采信", () => {
    const started = beginCompareRead(emptyCompareReadSession(), ["r_a", "r_b"]);
    const applied = applyCompareResponse(
      started,
      started.generation,
      started.request?.runIds ?? [],
      ok({ items: [readyItem("r_a")] }),
    );
    expect(applied.conclusion?.kind).toBe("rejected");
    if (applied.conclusion?.kind === "rejected") {
      expect(applied.conclusion.code).toBe(COMPARE_RESPONSE_MISMATCH);
      expect(applied.conclusion.reason).toContain("项数与请求不符");
    }
    // 在飞随结论落地出清
    expect(applied.request).toBeNull();
  });

  it("同代次同选择集的正常响应落地为 verified", () => {
    const started = beginCompareRead(emptyCompareReadSession(), ["r_a"]);
    const applied = applyCompareResponse(
      started,
      started.generation,
      ["r_a"],
      ok({ items: [readyItem("r_a")] }),
    );
    expect(applied.conclusion?.kind).toBe("verified");
  });
});

describe("U7 1.5 重试与销毁（纯判据）", () => {
  it("重试推进代次、清旧结论、保持选择集；无选择集不可重试", () => {
    const started = beginCompareRead(emptyCompareReadSession(), ["r_a", "r_b"]);
    const retried = retryCompareRead(started);
    expect(retried).not.toBeNull();
    if (retried !== null) {
      expect(retried.generation).toBe(started.generation + 1);
      expect(retried.selection).toEqual(["r_a", "r_b"]);
      expect(retried.conclusion).toBeNull();
      expect(retried.request?.generation).toBe(retried.generation);
    }
    expect(retryCompareRead(emptyCompareReadSession())).toBeNull();
  });

  it("销毁清空全部在场事实但代次仍单调（迟到响应永不复活）", () => {
    const started = beginCompareRead(emptyCompareReadSession(), ["r_a"]);
    const left = destroyCompareRead(started);
    expect(left.selection).toBeNull();
    expect(left.request).toBeNull();
    expect(left.conclusion).toBeNull();
    expect(left.generation).toBeGreaterThan(started.generation);
  });
});
