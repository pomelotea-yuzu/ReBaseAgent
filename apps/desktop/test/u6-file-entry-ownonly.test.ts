import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  defaultCheckpointStepId,
  deriveCheckpointOptions,
  resolveCheckpoint,
  validateCheckpointStepId,
} from "../src/renderer/src/lib/workspace-files";

/**
 * U6（add-partial-run-reading）任务 4.4：ownOnly 文件入口的行为锁。
 *
 * 对应 delta 场景：
 *   - 「ownOnly 文件入口不显示祖先检查点」：文件选择器只列当前 run 初始状态和
 *     自有完成步骤，不显示或读取祖先检查点，不回读源目录；
 *   - 「缺祖先与缺附件分别诊断」：blob 缺失走原附件错误，不与祖先缺失混同，
 *     也不因来源缺失封禁全部自有文件阅读。
 *
 * ⚠️ 判据本身在 C/U2 时代就已落在 `leafSpanIds`（`deriveCheckpointOptions` 只取
 *    自有 step）；U6 §3 的 main 投影又保证 ownOnly 的 spans 只含当前 run 自有记录。
 *    本文件把两条保证**在 ownOnly 形状下**钉住——防止将来任何一侧放宽时静默回归。
 *    main 侧保证的负例（ownOnly 载荷混入祖先 span 被 schema/integrity 拒绝）
 *    在 `u6-detail-contract.test.ts` 承载，这里不重复。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");

/** 与 draft-closure-store 同法：读真实 fixture 的 meta，保证形状合法 */
function isolatedRunOwnOnly(spans: readonly SpanLine[], leafSpanIds: readonly string[]) {
  const record = readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl"));
  return {
    spans,
    leafSpanIds,
    meta: { ...record.meta, workspace: { mode: "isolated_files" as const } },
  };
}

function step(id: string, n: number): SpanLine {
  return {
    type: "span",
    kind: "agent.step",
    id,
    parent: null,
    n,
  } as unknown as SpanLine;
}

describe("U6 4.4：ownOnly 文件入口只列自有检查点", () => {
  it("祖先 step 即使出现在 spans 里也不进选择器（leafSpanIds 界定自有段）", () => {
    const run = isolatedRunOwnOnly(
      [step("ancestor_s1", 1), step("own_s2", 1), step("own_s3", 2)],
      ["own_s2", "own_s3"],
    );
    const options = deriveCheckpointOptions(run);
    expect(options.map((option) => option.stepSpanId)).toEqual([null, "own_s2", "own_s3"]);
    expect(options.map((option) => option.label)).toEqual([
      "本 run 初始状态",
      "本 run 第 1 轮结束",
      "本 run 第 2 轮结束",
    ]);
  });

  it("祖先检查点判 stale：不得改用另一个'看起来可读'的检查点以外的祖先", () => {
    const run = isolatedRunOwnOnly([step("ancestor_s1", 1), step("own_s2", 1)], ["own_s2"]);
    expect(validateCheckpointStepId(run, "ancestor_s1")).toBe("stale");
    expect(validateCheckpointStepId(run, "own_s2")).toBe("valid");
    expect(validateCheckpointStepId(run, null)).toBe("initial");
  });

  it("保存的祖先 step 失效 ⇒ 回退最近自有完成步骤，并给出失效标记", () => {
    const run = isolatedRunOwnOnly([step("ancestor_s1", 1), step("own_s2", 1)], ["own_s2"]);
    const resolved = resolveCheckpoint(run, { entered: true, checkpoint: "ancestor_s1" });
    expect(resolved).toEqual({ stepSpanId: "own_s2", invalidated: true });
    expect(defaultCheckpointStepId(run)).toBe("own_s2");
  });

  it("没有自有完成步骤 ⇒ 默认落初始状态（初始快照仍是本 run 的，不是祖先的）", () => {
    const run = isolatedRunOwnOnly([step("ancestor_s1", 1)], []);
    expect(defaultCheckpointStepId(run)).toBeNull();
    const options = deriveCheckpointOptions(run);
    expect(options.map((option) => option.stepSpanId)).toEqual([null]);
  });
});

describe("U6 4.4：缺祖先与缺附件分别诊断", () => {
  it("附件缺失走原附件错误文案，不提祖先/父链", async () => {
    const { availabilityLabel, canCompareText } = await import(
      "../src/renderer/src/lib/workspace-files"
    );
    expect(availabilityLabel("missing")).toBe("附件缺失");
    const verdict = canCompareText({
      status: "missing",
      path: "out.txt",
      bytes: 3,
      sha256: "a".repeat(64),
      reason: "附件不在磁盘上",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("附件缺失");
      expect(verdict.reason).not.toContain("祖先");
      expect(verdict.reason).not.toContain("父链");
    }
  });

  it("来源完整性提示与附件诊断是两套文案（互不冒充）", async () => {
    const { LINEAGE_INCOMPLETE_TEXT } = await import("../src/renderer/src/lib/detail-completeness");
    const { availabilityLabel } = await import("../src/renderer/src/lib/workspace-files");
    // 固定提示只说父链；附件标签只说附件——两者没有共享措辞，不混同
    expect(LINEAGE_INCOMPLETE_TEXT).not.toContain("附件");
    expect(availabilityLabel("missing")).not.toContain("父链");
    expect(availabilityLabel("corrupt")).toBe("附件损坏");
  });
});
