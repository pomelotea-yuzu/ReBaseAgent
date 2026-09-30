import { describe, expect, it } from "vitest";
import {
  type ComparePair,
  decideCompareWithParent,
  decideManualPair,
  decidePairSideEdit,
  swapComparePair,
} from "../src/renderer/src/lib/compare-navigation";

/**
 * U7（improve-branch-comparison）任务 2.1/2.2/2.5 的纯判据半边：
 * pair 编辑三态、交换、父子入口三态与手动集合的加入顺序。
 * store 接线半边见 compare-workspace-store.test.ts。
 */

const PAIR: ComparePair = { leftRunId: "r_left", rightRunId: "r_right" };

describe("U7 2.2 pair 编辑判据", () => {
  it("更换另一侧成功，本侧不变；产出新 pair 对象（不可变更新）", () => {
    const decision = decidePairSideEdit(PAIR, "right", "r_new");
    expect(decision).toEqual({
      kind: "replace",
      pair: { leftRunId: "r_left", rightRunId: "r_new" },
    });
    // 原 pair 不被就地修改
    expect(PAIR.rightRunId).toBe("r_right");
  });

  it("换成本侧现值 ⇒ 幂等无变化；换成对侧现值 ⇒ 相同 ID 拒绝（两枚必须互异）", () => {
    expect(decidePairSideEdit(PAIR, "left", "r_left")).toEqual({ kind: "unchanged" });
    expect(decidePairSideEdit(PAIR, "right", "r_left")).toEqual({
      kind: "rejected",
      reason: "same-id",
    });
    expect(decidePairSideEdit(PAIR, "left", "r_right")).toEqual({
      kind: "rejected",
      reason: "same-id",
    });
  });

  it("交换左右：往返交换回到原状", () => {
    const swapped = swapComparePair(PAIR);
    expect(swapped).toEqual({ leftRunId: "r_right", rightRunId: "r_left" });
    expect(swapComparePair(swapped)).toEqual(PAIR);
  });
});

describe("U7 2.1 父子入口判据（父左子右恒定）", () => {
  it("有真实直接父 ⇒ 打开，左=父、右=当前运行", () => {
    const decision = decideCompareWithParent({
      meta: { id: "r_child", parent: "r_parent", fork: { edit: { field: "result" } } },
    });
    expect(decision).toEqual({
      kind: "open",
      pair: { leftRunId: "r_parent", rightRunId: "r_child" },
    });
  });

  it("无 parent 引用 ⇒ 入口不显示（hidden）", () => {
    const decision = decideCompareWithParent({
      meta: { id: "r_root", parent: null, fork: null },
    });
    expect(decision).toEqual({ kind: "hidden", reason: "no-parent" });
  });

  it("model_params 臂 ⇒ 被实验门禁挡住，不提供普通比较旁路", () => {
    const decision = decideCompareWithParent({
      meta: {
        id: "r_arm",
        parent: "r_parent",
        fork: { edit: { field: "model_params" } },
      },
    });
    expect(decision).toEqual({ kind: "blocked", reason: "model-params-gate" });
  });
});

describe("U7 2.5 手动集合的加入顺序", () => {
  it("恰好两条 ⇒ 按加入顺序定左右：先子后父也是子左父右（不自动重排）", () => {
    const decision = decideManualPair(["r_child", "r_parent"]);
    expect(decision).toEqual({
      kind: "pair",
      pair: { leftRunId: "r_child", rightRunId: "r_parent" },
    });
    // 反序加入则父左子右——顺序只由加入先后决定，与父子关系无关
    expect(decideManualPair(["r_parent", "r_child"])).toEqual({
      kind: "pair",
      pair: { leftRunId: "r_parent", rightRunId: "r_child" },
    });
  });

  it("三或四条 ⇒ 不自动选两条（§5.3 显式选择）；零或一条 ⇒ 无 pair", () => {
    expect(decideManualPair(["a", "b", "c"])).toEqual({ kind: "none", reason: "explicit-select" });
    expect(decideManualPair(["a", "b", "c", "d"])).toEqual({
      kind: "none",
      reason: "explicit-select",
    });
    expect(decideManualPair([])).toEqual({ kind: "none", reason: "needs-two" });
    expect(decideManualPair(["a"])).toEqual({ kind: "none", reason: "needs-two" });
  });
});
