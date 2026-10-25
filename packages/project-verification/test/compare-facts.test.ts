import { describe, expect, it } from "vitest";
import {
  compareVerificationFacts,
  type VerificationFactsSide,
} from "../src/compare-facts.js";

/**
 * MCP2 tasks 2.5/2.6：共享比较纯事实（M14/M15/M16/M07 的共享层半边）。
 *
 * 判据（design D7）：
 * - argv 按数组逐元素比较（join 同串但边界不同 ⇒ different）；
 * - 对象按规范值比较（键序无关）；
 * - 历史缺项 ⇒ unknown，不补齐；
 * - 结论顺序：outcome-unknown → evidence-incomplete（双来源）→ conditions-differ
 *   → conditions-unknown → failed-to-passed → same-conditions-other-outcome；
 * - 来源缺失/漂移不改结论，只降 sourceVerified（不称"已核验修复分支"）；
 * - expectedSnapshotIds 固定 recordedTarget，不切最近步骤。
 */

function side(overrides: Partial<VerificationFactsSide>): VerificationFactsSide {
  return {
    verificationId: "ver_l",
    status: "sealed",
    profileId: "node-ts-v1",
    manifestVersion: 1,
    planBindingDigest: "a".repeat(64),
    commandId: "test",
    executable: "node",
    argv: ["node", "--test"],
    cwd: "/workspace",
    environment: {
      platform: "linux/amd64",
      imageDigest: `sha256:${"a".repeat(63)}1`,
      toolchain: { node: "20", npm: "10", typescript: "5.6" },
      limits: { cpus: 2, memoryBytes: 2147483648 },
      security: { runAsUser: 1000, networkMode: "none" },
    },
    outcome: "check_failed",
    evidenceComplete: true,
    recordedSnapshotId: "snap_1",
    sourceStatus: "present",
    locatedSnapshotId: "snap_1",
    currentAssetsAvailable: true,
    ...overrides,
  };
}

const passedRight = (overrides: Partial<VerificationFactsSide> = {}): VerificationFactsSide =>
  side({ verificationId: "ver_r", outcome: "passed", ...overrides });

describe("argv 数组判据（M15）", () => {
  it("join 后同串但边界不同 ⇒ command different", () => {
    const result = compareVerificationFacts(
      side({ argv: ["npx", "tsc --noEmit"] }),
      side({ ...passedRight(), argv: ["npx", "tsc", "--noEmit"] }),
    );
    expect(result.conditions.find((c) => c.key === "command")?.state).toBe("different");
    expect(result.verdict.kind).toBe("conditions-differ");
  });

  it("argv 数组逐元素一致 ⇒ same；缺 argv ⇒ unknown", () => {
    expect(
      compareVerificationFacts(side({}), side(passedRight())).conditions.find(
        (c) => c.key === "command",
      )?.state,
    ).toBe("same");
    expect(
      compareVerificationFacts(side({ argv: null }), side(passedRight())).conditions.find(
        (c) => c.key === "command",
      )?.state,
    ).toBe("unknown");
  });
});

describe("对象规范值判据（M15/V02）", () => {
  it("键序不同、值相同 ⇒ same；值不同 ⇒ different；环境缺 ⇒ unknown", () => {
    expect(
      compareVerificationFacts(
        side({}),
        passedRight({
          environment: {
            platform: "linux/amd64",
            imageDigest: `sha256:${"a".repeat(63)}1`,
            toolchain: { typescript: "5.6", node: "20", npm: "10" },
            limits: { memoryBytes: 2147483648, cpus: 2 },
            security: { networkMode: "none", runAsUser: 1000 },
          },
        }),
      ).verdict.kind,
    ).toBe("failed-to-passed");
    expect(
      compareVerificationFacts(
        side({}),
        passedRight({
          environment: {
            platform: "linux/amd64",
            imageDigest: `sha256:${"a".repeat(63)}1`,
            toolchain: { node: "22", npm: "10", typescript: "5.6" },
            limits: { cpus: 2, memoryBytes: 2147483648 },
            security: { runAsUser: 1000, networkMode: "none" },
          },
        }),
      ).verdict.kind,
    ).toBe("conditions-differ");
    expect(
      compareVerificationFacts(side({ environment: null }), passedRight()).verdict.kind,
    ).toBe("conditions-unknown");
  });
});

describe("结论顺序与证据门（M14/M16）", () => {
  it("同条件失败→通过成立（基线）", () => {
    const result = compareVerificationFacts(side({}), passedRight());
    expect(result.verdict.kind).toBe("failed-to-passed");
    expect(result.conditions.every((c) => c.state === "same")).toBe(true);
    expect(result.expectedSnapshotIds).toEqual({ left: "snap_1", right: "snap_1" });
  });

  it("非封存/不可读 ⇒ outcome-unknown（优先于一切条件结论）", () => {
    expect(
      compareVerificationFacts(side({ status: "corrupt", outcome: null }), passedRight()).verdict
        .kind,
    ).toBe("outcome-unknown");
  });

  it("evidence-incomplete 双来源：封存缺项与当前资产缺失都命中，历史 outcome 不改写", () => {
    const fromRecord = compareVerificationFacts(
      side({ evidenceComplete: false }),
      passedRight(),
    );
    expect(fromRecord.verdict.kind).toBe("evidence-incomplete");
    expect(fromRecord.evidenceIncompleteFromRecord).toBe(true);
    expect(fromRecord.evidenceIncompleteFromCurrentAssets).toBe(false);
    const fromAssets = compareVerificationFacts(
      side({ currentAssetsAvailable: false }),
      passedRight(),
    );
    expect(fromAssets.verdict.kind).toBe("evidence-incomplete");
    expect(fromAssets.evidenceIncompleteFromCurrentAssets).toBe(true);
    // 证据不完整优先于条件差异（顺序钉住）
    expect(
      compareVerificationFacts(
        side({ evidenceComplete: false, environment: null }),
        passedRight(),
      ).verdict.kind,
    ).toBe("evidence-incomplete");
  });

  it("同条件但结局不是失败→通过 ⇒ same-conditions-other-outcome，只声明实际结果", () => {
    expect(compareVerificationFacts(side({}), side({ verificationId: "ver_r", outcome: "cancelled" })).verdict.kind).toBe(
      "same-conditions-other-outcome",
    );
  });
});

describe("来源核对与 recordedTarget 固定（M07）", () => {
  it("来源缺失/漂移/未定位：结论不变，sourceVerified=false，expectedSnapshotId 仍是记录值", () => {
    const missing = compareVerificationFacts(
      side({ sourceStatus: "missing", locatedSnapshotId: null }),
      passedRight(),
    );
    expect(missing.verdict.kind).toBe("failed-to-passed");
    expect(missing.sourceVerified).toBe(false);
    expect(missing.expectedSnapshotIds.left).toBe("snap_1");
    const drifted = compareVerificationFacts(
      side({ locatedSnapshotId: "snap_moved" }),
      passedRight(),
    );
    expect(drifted.sourceVerified).toBe(false);
    expect(drifted.expectedSnapshotIds.left).toBe("snap_1");
    // present 但未做快照定位核对（located=null）⇒ 不能称已核验（D7 保守侧）
    const unlocated = compareVerificationFacts(
      side({ locatedSnapshotId: null }),
      passedRight(),
    );
    expect(unlocated.sourceVerified).toBe(false);
  });

  it("两侧都未核对来源 ⇒ sourceVerified=null；定位与 recorded 一致 ⇒ true", () => {
    expect(
      compareVerificationFacts(
        side({ sourceStatus: "unknown", locatedSnapshotId: null }),
        passedRight({ sourceStatus: "unknown", locatedSnapshotId: null }),
      ).sourceVerified,
    ).toBeNull();
    // trace 在场 ≠ 已核验定位：located 未给出时不能称"已核验修复分支"
    expect(
      compareVerificationFacts(
        side({ sourceStatus: "unknown", locatedSnapshotId: null }),
        passedRight({ locatedSnapshotId: null }),
      ).sourceVerified,
    ).toBe(false);
  });

  it("codeSame：recordedSnapshotId 缺 ⇒ null，不猜", () => {
    expect(compareVerificationFacts(side({ recordedSnapshotId: null }), passedRight()).codeSame).toBeNull();
  });
});
