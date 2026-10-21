import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  compareFileSelectionKey,
  compareFileSelectorOf,
  comparedFileSideLabel,
  expectedSnapshotIdsOf,
  referenceLabel,
  resolveCompareFileSide,
  textDiffSidesOf,
} from "../src/renderer/src/lib/compare-file-view";
import {
  defaultCheckpointStepId,
  validateCheckpointStepId,
} from "../src/renderer/src/lib/workspace-files";
import type { RunDetail } from "../src/shared/ipc";

/**
 * R2.2 6.4/6.5：比较文件视图的纯判据。
 *
 * 验收映射：
 * - 「两侧检查点独立且迟到结果不串页」：选择 key、显式默认解析、失效不改点；
 * - 「文件差异诚实呈现未验证和不可用」：引用状态与正文状态分开、二进制/超限不造 diff；
 * - 「选择快照变化不能拼出混合差异」：expectedSnapshotIds 只在双方清单可用时给出。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u2-file-fixtures/iso-data/traces");

function detailOf(fileName: string): RunDetail {
  const record: RunRecord = readRun(resolve(FIXTURE_DIR, fileName));
  return {
    meta: record.meta,
    spans: record.spans,
    events: record.events,
    status: record.status,
    chain: [{ meta: record.meta, fork: record.meta.fork }],
    leafSpanIds: record.spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

const ROOT = detailOf("run_mufbxhbd_qp0ijq.jsonl");
const BRANCH = detailOf("run_mufbxhen_73kc.jsonl");

function ownStep(detail: RunDetail): string {
  const step = detail.spans.find(
    (span) => span.kind === "agent.step" && detail.leafSpanIds.includes(span.id),
  );
  if (step === undefined) throw new Error("fixture 缺少自有 agent.step");
  return step.id;
}

describe("compareFileSelectorOf：只有初始才省略 stepSpanId", () => {
  it("初始（null）⇒ 不带字段；显式完成步骤 ⇒ 带真实 step ID", () => {
    expect(compareFileSelectorOf({ runId: "run_a", stepSpanId: null })).toEqual({
      runId: "run_a",
    });
    expect(compareFileSelectorOf({ runId: "run_a", stepSpanId: "s_03" })).toEqual({
      runId: "run_a",
      stepSpanId: "s_03",
    });
  });

  it("选择 key 区分两侧与初始/完成步骤（迟到守卫的身份）", () => {
    const left = { runId: "run_a", stepSpanId: "s_03" };
    const right = { runId: "run_b", stepSpanId: null };
    expect(compareFileSelectionKey(left, right)).toBe("run_a|s_03||run_b|initial");
    expect(compareFileSelectionKey(left, right)).not.toBe(
      compareFileSelectionKey({ ...left, stepSpanId: null }, right),
    );
  });
});

describe("resolveCompareFileSide：默认显式解析、失效不自动改点", () => {
  it("首次打开：默认最近自有完成步骤（无则初始），并标记 defaulted", () => {
    const state = resolveCompareFileSide({
      detail: ROOT,
      runId: ROOT.meta.id,
      unavailableReason: null,
      savedStepSpanId: undefined,
    });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") throw new Error("应为 ready");
    expect(state.defaulted).toBe(true);
    expect(state.selection.stepSpanId).toBe(defaultCheckpointStepId(ROOT));
    expect(state.selection.stepSpanId).not.toBeUndefined();
  });

  it("无自有完成步骤 ⇒ 默认初始（null），不让包层去猜最近一步", () => {
    const noSteps: RunDetail = { ...ROOT, spans: [], leafSpanIds: [] };
    const state = resolveCompareFileSide({
      detail: noSteps,
      runId: ROOT.meta.id,
      unavailableReason: null,
      savedStepSpanId: undefined,
    });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") throw new Error("应为 ready");
    expect(state.selection.stepSpanId).toBeNull();
  });

  it("已保存的合法完成步骤原样保留（不重新取默认）；失效步骤返回 stale 且不改点", () => {
    const step = ownStep(ROOT);
    const kept = resolveCompareFileSide({
      detail: ROOT,
      runId: ROOT.meta.id,
      unavailableReason: null,
      savedStepSpanId: step,
    });
    expect(kept).toMatchObject({
      kind: "ready",
      selection: { runId: ROOT.meta.id, stepSpanId: step },
      defaulted: false,
    });

    const stale = resolveCompareFileSide({
      detail: ROOT,
      runId: ROOT.meta.id,
      unavailableReason: null,
      savedStepSpanId: "s_not_owned_any_more",
    });
    expect(stale.kind).toBe("stale");
    if (stale.kind !== "stale") throw new Error("应为 stale");
    expect(stale.reason).toContain("不自动改点");
  });

  it("两侧独立：左侧失效不影响右侧仍选它自己的合法步骤", () => {
    const rightStep = ownStep(BRANCH);
    const left = resolveCompareFileSide({
      detail: ROOT,
      runId: ROOT.meta.id,
      unavailableReason: null,
      savedStepSpanId: "s_stale",
    });
    const right = resolveCompareFileSide({
      detail: BRANCH,
      runId: BRANCH.meta.id,
      unavailableReason: null,
      savedStepSpanId: rightStep,
    });
    expect(left.kind).toBe("stale");
    expect(right).toMatchObject({ kind: "ready", selection: { stepSpanId: rightStep } });
  });

  it("不可读/普通运行：明确不可用，不改选另一条运行冒充", () => {
    expect(
      resolveCompareFileSide({
        detail: null,
        runId: "run_missing",
        unavailableReason: "trace_invalid",
        savedStepSpanId: undefined,
      }),
    ).toMatchObject({ kind: "unavailable" });

    const v1 = { ...ROOT, meta: { ...ROOT.meta, workspace: undefined } } as unknown as RunDetail;
    expect(
      resolveCompareFileSide({
        detail: v1,
        runId: ROOT.meta.id,
        unavailableReason: null,
        savedStepSpanId: undefined,
      }),
    ).toMatchObject({ kind: "not-isolated" });
  });
});

describe("清单/正文状态：未核验与不可用分开", () => {
  it("expectedSnapshotIds 只在双方清单都 ok 时给出", () => {
    const okSide = {
      status: "ok" as const,
      requestedRunId: "run_a",
      requestedStepSpanId: null,
      selected: {
        runId: "run_a",
        stepSpanId: null,
        snapshotId: "a".repeat(64),
        initialSnapshotId: "a".repeat(64),
      },
    };
    const unavailableSide = {
      status: "unavailable" as const,
      requestedRunId: "run_b",
      requestedStepSpanId: null,
      failure: { code: "no_workspace" as const, reason: "no workspace" },
    };
    expect(expectedSnapshotIdsOf({ left: okSide, right: okSide })).toEqual({
      left: "a".repeat(64),
      right: "a".repeat(64),
    });
    expect(expectedSnapshotIdsOf({ left: okSide, right: unavailableSide })).toBeNull();
  });

  it("引用相同只表示清单引用，不冒充内容相同；仅一侧存在可辨", () => {
    const entry = (presence: "both" | "left_only", reference: "same" | "different" | null) =>
      ({
        path: "a.txt",
        presence,
        left: { path: "a.txt", sha256: "a".repeat(64), bytes: 1 },
        right: presence === "both" ? { path: "a.txt", sha256: "a".repeat(64), bytes: 1 } : null,
        reference,
      }) satisfies Parameters<typeof referenceLabel>[0];
    expect(referenceLabel(entry("both", "same"))).toContain("内容待核验");
    expect(referenceLabel(entry("both", "different"))).toContain("内容待核验");
    expect(referenceLabel(entry("left_only", null))).toContain("仅左侧");
  });

  it("逐侧错误标签可辨认；二进制/超限/缺失不伪装成空文件", () => {
    const base = { path: "a.txt" };
    expect(
      comparedFileSideLabel(
        { ...base, status: "binary", file: { path: "a.txt", sha256: "a".repeat(64), bytes: 10 } },
        "左",
      ),
    ).toContain("二进制");
    expect(
      comparedFileSideLabel(
        {
          ...base,
          status: "missing",
          file: { path: "a.txt", sha256: "a".repeat(64), bytes: 10 },
          reason: "blob missing",
        },
        "右",
      ),
    ).toContain("附件缺失");
    expect(
      comparedFileSideLabel({ ...base, status: "not_found", reason: "清单无此路径" }, "左"),
    ).toContain("不是空文件");
  });

  it("文本 diff 只允许 text/text 或 text+not_found；二进制不给伪差异", () => {
    const text = (value: string) => ({
      path: "a.txt",
      status: "text" as const,
      file: { path: "a.txt", sha256: "a".repeat(64), bytes: value.length },
      text: value,
    });
    const result = {
      path: "a.txt",
      left: text("a\r\nb"),
      right: text("a\nb"),
      conclusion: "different" as const,
      textDiffEligible: true,
    };
    expect(textDiffSidesOf(result)).toEqual({ original: "a\r\nb", modified: "a\nb" });

    const withNotFound = {
      ...result,
      left: { path: "a.txt", status: "not_found" as const, reason: "不存在" },
      conclusion: "right_only" as const,
    };
    expect(textDiffSidesOf(withNotFound)).toEqual({ original: "", modified: "a\nb" });

    const binary = {
      ...result,
      right: {
        path: "a.txt",
        status: "binary" as const,
        file: { path: "a.txt", sha256: "b".repeat(64), bytes: 8 },
      },
      textDiffEligible: false,
    };
    expect(textDiffSidesOf(binary)).toBeNull();
  });
});
