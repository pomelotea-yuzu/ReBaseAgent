import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { OperationRecord } from "@shared/operations";
import { deriveOwnTerminalFacts } from "@shared/terminal-facts";
import { describe, expect, it } from "vitest";
import {
  armNavigationIntent,
  decideResultNavigation,
  emptyNavigationIntents,
  navigationIntentOf,
  releaseNavigationIntent,
} from "../src/renderer/src/lib/navigation-intent";
import type { ResultReadEntry } from "../src/renderer/src/lib/result-verification";

/**
 * U5（unify-run-execution-workflow）任务 3.4：**结果导航意图**的纯判据。
 *
 * 判据来源：design D6 + delta「结果导航尊重用户当前阅读意图」。四条规则：
 * 1. 资格按**阅读代次**判，不按"位置是否等于提交时位置"判 ⇒ 离开再返回不恢复；
 * 2. 判定用的是**导航前一刻**的代次（本模块是纯函数，调用方必须现取现判）；
 * 3. 覆盖模态在场只是"这一刻不跳"（`wait`），不是撤销资格；
 * 4. 显式核对、A/B 批次、多运行、未定位、不可读 ⇒ 永久作废（`drop`），
 *    只有"结果还在读 / 仍在执行"才留着（`wait`）。
 *
 * 三条 spec 场景的落点：「留在当前流程可进入成功或失败概览」「离开再返回不恢复旧自动导航」
 * 「读取途中离页仍不抢焦点」——store 侧接线见 `navigation-intent-store.test.ts`。
 */

const OP = "66666666-6666-4666-8666-666666666666";
const RUN = "run_registered_target";

const normalFacts = deriveOwnTerminalFacts({
  status: "completed",
  events: [
    { event: "started", reason: "" },
    { event: "stopped", reason: "completed" },
  ],
  spans: [],
  leafSpanIds: [],
});

function entry(overrides: Partial<ResultReadEntry> = {}): ResultReadEntry {
  return { phase: "verified", attempt: 1, facts: normalFacts, reason: null, ...overrides };
}

function record(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    epoch: "44444444-4444-4444-8444-444444444444",
    operationId: OP,
    target: {
      kind: "result",
      mode: "plain",
      parentRunId: "r_parent",
      atSpanId: "s_03",
      editField: "result",
    },
    state: "settled",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: "2026-09-27T00:00:05.000Z",
    runIds: [RUN],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

/** 一次判定的默认入参：留在流程、无覆盖模态、单运行、结果已核实 */
function decide(overrides: Partial<Parameters<typeof decideResultNavigation>[0]> = {}) {
  return decideResultNavigation({
    intent: { operationId: OP, generation: 7 },
    generation: 7,
    coveringModal: false,
    record: record(),
    entry: entry(),
    trigger: "status",
    ...overrides,
  });
}

describe("3.4 导航意图的登记与作废（幂等）", () => {
  it("同一身份、同一代次重复登记 ⇒ 引用不变（重复快照不产生第二份意图）", () => {
    const armed = armNavigationIntent(emptyNavigationIntents(), OP, 3);
    expect(armNavigationIntent(armed, OP, 3)).toBe(armed);
    expect(navigationIntentOf(armed, OP)).toEqual({ operationId: OP, generation: 3 });
  });

  it("释放不存在的身份 ⇒ 引用不变；释放后查不到", () => {
    const empty = emptyNavigationIntents();
    expect(releaseNavigationIntent(empty, OP)).toBe(empty);
    const armed = armNavigationIntent(empty, OP, 1);
    const released = releaseNavigationIntent(armed, OP);
    expect(released).not.toBe(armed);
    expect(navigationIntentOf(released, OP)).toBeUndefined();
  });
});

describe("3.4 资格判定：什么时候才允许自动跳", () => {
  it("留在流程 + 单运行 + 结果已核实 ⇒ 进入那条记录的概览", () => {
    expect(decide()).toEqual({ kind: "navigate", runId: RUN });
  });

  it("「留在当前流程可进入成功或失败概览」：核实但结局是 error ⇒ 照样进（进失败概览）", () => {
    const failed = deriveOwnTerminalFacts({
      status: "completed",
      events: [{ event: "errored", reason: "error" }],
      spans: [],
      leafSpanIds: [],
    });
    expect(failed.normalEnd).toBe(false);
    expect(decide({ entry: entry({ facts: failed }) })).toEqual({ kind: "navigate", runId: RUN });
  });

  it("本会话没提交过（重载恢复）⇒ none：不凭「结果可读」就跳", () => {
    expect(decide({ intent: undefined })).toEqual({ kind: "none" });
  });

  it("「离开再返回不恢复旧自动导航」：代次不等 ⇒ drop（不是 wait）", () => {
    const left = decide({ generation: 8 });
    expect(left.kind).toBe("drop");
    expect(left.kind === "drop" && left.reason).toContain("返回同一位置也不恢复");
  });

  it("「读取途中离页仍不抢焦点」：判定只看当下代次 ⇒ 读取开始时是 7、切换时已是 8 ⇒ drop", () => {
    // 读取开始时快照下来的 generation = 7 **不参与**判定：入参 generation 是导航前一刻的值
    const startedAtGeneration7 = { operationId: OP, generation: 7 };
    expect(decide({ intent: startedAtGeneration7, generation: 8 }).kind).toBe("drop");
  });

  it("「有覆盖模态在场」⇒ wait（这一刻不跳，也不算撤销）", () => {
    expect(decide({ coveringModal: true }).kind).toBe("wait");
  });

  it("A/B 批次 ⇒ drop：永不自动聚焦，由用户挑臂", () => {
    // 刻意用"只识别出一条臂"的形状：此时"单运行"条件成立，
    // 唯一拦住跳转的是**批次规则**（换成两臂的样本，这条判据就没牙了）。
    const batch = record({
      target: { kind: "modelAb", parentRunId: "r_parent", armCount: 2 },
      runIds: [RUN],
      experimentId: "exp_1",
      arms: [
        { index: 0, id: RUN, outcome: "returned" },
        { index: 1, id: null, outcome: null },
      ],
    });
    const decision = decide({ record: batch });
    expect(decision.kind).toBe("drop");
    expect(decision.kind === "drop" && decision.reason).toContain("批次");
  });

  it("多运行（非批次）⇒ drop；settled 无可信 id（未定位）⇒ drop 且说明不猜", () => {
    const many = decide({ record: record({ runIds: [RUN, "run_second"] }) });
    expect(many.kind).toBe("drop");
    const unlocated = decide({ record: record({ runIds: [] }), entry: undefined });
    expect(unlocated.kind).toBe("drop");
    expect(unlocated.kind === "drop" && unlocated.reason).toContain("不猜");
  });

  it("结果仍在读 / 记录还在跑 ⇒ wait（留着意图，等真正可读的那一轮）", () => {
    expect(decide({ entry: undefined }).kind).toBe("wait");
    expect(decide({ entry: entry({ phase: "reading", facts: null }) }).kind).toBe("wait");
    expect(
      decide({ record: record({ state: "running", settledAt: null, requestOutcome: null }) }).kind,
    ).toBe("wait");
  });

  it("结果不可读 ⇒ drop：不给「跳过去只看到一个读不出来的页面」留余地", () => {
    const decision = decide({
      entry: entry({ phase: "unreadable", facts: null, reason: "结果详情结构校验失败" }),
    });
    expect(decision.kind).toBe("drop");
    expect(decision.kind === "drop" && decision.reason).toContain("结构校验失败");
  });

  it("「核对结果只由用户明确打开」：终态由 reconcile 到达 ⇒ 即使一切都合规也 drop", () => {
    expect(decide({ trigger: "reconcile" }).kind).toBe("drop");
  });

  it("notAccepted ⇒ drop（没有结果可进入）", () => {
    const decision = decide({
      record: record({
        state: "notAccepted",
        rejection: "busy",
        runIds: [],
        startedAt: null,
        settledAt: null,
        requestOutcome: null,
      }),
      entry: undefined,
    });
    expect(decision.kind).toBe("drop");
  });
});
