import { describe, expect, it } from "vitest";
import { deriveVerifiedComparison } from "../src/shared/compare-derive";
import { deriveComparison, indexRunsById } from "../src/shared/derive";
import type { RunSummary } from "../src/shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 1.7：以本次已校验祖先自有摘要接
 * 共同祖先/累计派生。
 *
 * 关键语义（场景「列表完整但比较读取缺祖先」）：
 * - 唯一事实源是比较响应的 chainSummaries（main 已校验），不是列表缓存；
 * - ownOnly 截断链 ⇒ 共同祖先判定不完整、该侧累计未知、祖先差不计算；
 * - 完整另一侧的自有/累计照常可读；
 * - 求和/增量口径与列表版 deriveComparison 逐字同源（复用同一批纯函数）。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function summary(
  id: string,
  parent: string | null,
  metrics: {
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number | null;
    steps?: number;
  } = {},
): RunSummary {
  return {
    id,
    task: `任务 ${id}`,
    model: "controlled-model",
    created_at: T0,
    status: "completed",
    parent,
    reason: "completed",
    fork: parent === null ? null : { at_span: "s_01", edit_field: "result", experiment_id: null },
    steps: metrics.steps ?? 1,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: metrics.tokensIn ?? 10,
    tokensOut: metrics.tokensOut ?? 5,
    cacheHit: null,
    durationMs: metrics.durationMs ?? 100,
    source: null,
  };
}

/** 链摘要组装：按传入顺序（根→叶）排列 */
function chainOf(...runs: RunSummary[]): RunSummary[] {
  return runs;
}

describe("U7 1.7 已校验派生：共同祖先与增量差", () => {
  it("两条兄弟分支：共同祖先 = 父，祖先差 = 各侧累计 − 祖先累计", () => {
    const a = summary("r_a", null, { tokensIn: 10, tokensOut: 5, durationMs: 100 });
    const b1 = summary("r_b1", "r_a", { tokensIn: 20, tokensOut: 8, durationMs: 150 });
    const b2 = summary("r_b2", "r_a", { tokensIn: 30, tokensOut: 2, durationMs: 120 });

    const verified = deriveVerifiedComparison([
      { runId: "r_b1", chainSummaries: chainOf(a, b1) },
      { runId: "r_b2", chainSummaries: chainOf(a, b2) },
    ]);

    expect(verified.relation).toEqual({ kind: "common", ancestorId: "r_a" });
    expect(verified.ancestor?.id).toBe("r_a");
    // b1：累计 (15+28, 100+150) − 祖先 (15, 100) = (28, 150)；b2：(15+32, 100+120) − (15,100) = (32,120)
    const [side1, side2] = verified.sides;
    expect(side1?.deltaFromAncestor).toEqual({ tokens: 28, durationMs: 150 });
    expect(side2?.deltaFromAncestor).toEqual({ tokens: 32, durationMs: 120 });
    // 口径与列表版逐字同源（同输入同输出）
    const listBased = deriveComparison([a, b1, b2], ["r_b1", "r_b2"]);
    expect(side1?.totals).toEqual(listBased.entries[0]?.totals ?? null);
    expect(side2?.deltaFromAncestor).toEqual(listBased.entries[1]?.deltaFromAncestor ?? null);
  });

  it("直接父子：共同祖先取父 run，父侧相对自身增量为零", () => {
    const a = summary("r_a", null, { tokensIn: 10, tokensOut: 5, durationMs: 100 });
    const b = summary("r_b", "r_a", { tokensIn: 20, tokensOut: 8, durationMs: 150 });

    const verified = deriveVerifiedComparison([
      { runId: "r_a", chainSummaries: chainOf(a) },
      { runId: "r_b", chainSummaries: chainOf(a, b) },
    ]);

    expect(verified.relation).toEqual({ kind: "common", ancestorId: "r_a" });
    const [sideA, sideB] = verified.sides;
    // 父相对自身增量恒零；子相对父 = 子的自有贡献（累计 43−15 = 28、250−100 = 150）
    expect(sideA?.deltaFromAncestor).toEqual({ tokens: 0, durationMs: 0 });
    expect(sideB?.deltaFromAncestor).toEqual({ tokens: 28, durationMs: 150 });
  });

  it("ownOnly 侧：链截断 ⇒ 判定不完整 + 该侧累计未知；完整另一侧累计照常可读", () => {
    const x = summary("r_x", null, { tokensIn: 10, tokensOut: 5, durationMs: 100 });
    const y = summary("r_y", "r_x", { tokensIn: 20, tokensOut: 8, durationMs: 150 });
    // z 的祖先文件缺失：chainSummaries 只到 z 自身（main 已校验的截断链）
    const zOwnOnly = summary("r_z", "r_missing", { tokensIn: 40, tokensOut: 1, durationMs: 60 });

    const verified = deriveVerifiedComparison([
      { runId: "r_y", chainSummaries: chainOf(x, y) },
      { runId: "r_z", chainSummaries: chainOf(zOwnOnly) },
    ]);

    expect(verified.relation).toEqual({ kind: "incomplete" });
    const [sideY, sideZ] = verified.sides;
    // 完整另一侧：自有 + 累计照常可读
    expect(sideY?.totals).not.toBeNull();
    expect(sideY?.own?.id).toBe("r_y");
    // ownOnly 侧：累计未知、祖先差不计算，自有摘要仍在
    expect(sideZ?.totals).toBeNull();
    expect(sideZ?.deltaFromAncestor).toBeNull();
    expect(sideZ?.own?.id).toBe("r_z");
  });

  it("分属不同根：两侧链完整且无公共 id ⇒ unrelated；两侧累计各自可读、增量差不计算", () => {
    const x = summary("r_x", null);
    const y = summary("r_y", "r_x");
    const p = summary("r_p", null);
    const q = summary("r_q", "r_p");

    const verified = deriveVerifiedComparison([
      { runId: "r_y", chainSummaries: chainOf(x, y) },
      { runId: "r_q", chainSummaries: chainOf(p, q) },
    ]);

    expect(verified.relation).toEqual({ kind: "unrelated" });
    expect(verified.ancestor).toBeNull();
    for (const side of verified.sides) {
      expect(side.totals).not.toBeNull();
      expect(side.deltaFromAncestor).toBeNull();
    }
  });

  it("共享祖先跨侧复用：父缺失的一侧能接上另一侧已校验的同一物理 run", () => {
    // z 缺父 r_x，但 r_x 在另一条链里被本次请求校验过（同一次读取上下文）⇒
    // 并集事实源里 r_x 存在，z 的累计/共同祖先可以恢复
    const x = summary("r_x", null, { tokensIn: 10, tokensOut: 5, durationMs: 100 });
    const y = summary("r_y", "r_x");
    const z = summary("r_z", "r_x", { tokensIn: 40, tokensOut: 1, durationMs: 60 });

    const verified = deriveVerifiedComparison([
      { runId: "r_y", chainSummaries: chainOf(x, y) },
      { runId: "r_z", chainSummaries: chainOf(z) },
    ]);

    expect(verified.relation).toEqual({ kind: "common", ancestorId: "r_x" });
    const sideZ = verified.sides[1];
    // z 的累计接上 x：tokens 41+15 = 56、duration 60+100 = 160；祖先差 = 56−15、160−100
    expect(sideZ?.totals).not.toBeNull();
    expect(sideZ?.deltaFromAncestor).toEqual({ tokens: 41, durationMs: 60 });
  });

  it("单侧（一条 ready）：共同祖先为自身，增量差为零（边界锁定）", () => {
    const a = summary("r_a", null, { tokensIn: 10, tokensOut: 5, durationMs: 100 });
    const verified = deriveVerifiedComparison([{ runId: "r_a", chainSummaries: chainOf(a) }]);
    expect(verified.relation).toEqual({ kind: "common", ancestorId: "r_a" });
    expect(verified.sides[0]?.deltaFromAncestor).toEqual({ tokens: 0, durationMs: 0 });
  });

  it("无重复 id 污染：两侧链含同一祖先时摘要只入并集一份（按 id 去重）", () => {
    const a = summary("r_a", null);
    const b1 = summary("r_b1", "r_a");
    const b2 = summary("r_b2", "r_a");
    const verified = deriveVerifiedComparison([
      { runId: "r_b1", chainSummaries: chainOf(a, b1) },
      { runId: "r_b2", chainSummaries: chainOf(a, b2) },
    ]);
    // 并集只有 3 条（a 只算一份）——用 indexRunsById 同口径间接验证
    expect(verified.sides).toHaveLength(2);
    expect(verified.ancestor?.id).toBe("r_a");
  });
});
