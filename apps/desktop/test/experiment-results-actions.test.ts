import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunDetail, WindowApi } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveExperimentBatches } from "../src/renderer/src/lib/experiment-results";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore, resultReadKeyOf } from "../src/renderer/src/lib/result-verification";
import { FAKE_EPOCH, statusSnapshot } from "./helpers/operation-channels";
import { proxyStatusOk } from "./helpers/proxy-state-fixture";

/**
 * U8（unify-recording-and-experiment-workspaces）任务 4.3：**实验工作区逐臂动作的
 * 只读反证**（delta「实验结果不可读仅重试读取」）。
 *
 * 工作区结果区与操作面板共用同一批 store 口（openOperationResult / openOperationFailure /
 * retryResultRead——源码级接线判据在 `experiment-results.test.ts`）。本文件钉**行为层**：
 * - 不可读臂只能按**同一条**可信 ID 只读重试：整条路径只有 `runs:get`，
 *   执行/创建/分支/预览/代理通道一次都不被碰到；
 * - 打开结果同样是纯只读：不改选中项、不切页、不触发执行。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const read = (name: string): RunRecord => readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));

function detailFor(record: RunRecord, id: string): RunDetail {
  const meta = record.meta.id === id ? record.meta : { ...record.meta, id };
  return {
    meta,
    spans: record.spans,
    events: record.events,
    status: record.status,
    chain: [{ meta, fork: record.meta.fork }],
    leafSpanIds: record.spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

const PARENT = "run_ab_parent";
const OP_ID = "55555555-5555-4555-8555-555555555555";
const ARM_A = "run_ab_arm_a";
const ARM_B = "run_ab_arm_b";

const calls: string[] = [];
let getRunOk = true;

/** 4.3 的靶子：一批评置 modelAb 登记（两臂都有可信 ID） */
function settledAbRecord(): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: OP_ID,
    target: { kind: "modelAb", parentRunId: PARENT, armCount: 2 },
    state: "settled",
    rejection: null,
    startedAt: "2026-10-01T08:00:00.000Z",
    settledAt: "2026-10-01T08:00:05.000Z",
    runIds: [ARM_A, ARM_B],
    experimentId: "exp_43",
    arms: [
      { index: 0, id: ARM_A, outcome: "returned" },
      { index: 1, id: ARM_B, outcome: "returned" },
    ],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
  };
}

const apiStub: Record<string, unknown> = {
  listRuns: async (): Promise<Envelope<ListRunsData>> => {
    calls.push("runs:list");
    return { ok: false, error: { code: "LIST_FAILED", message: "列表读取失败（桩）" } };
  },
  getRun: async (id: string): Promise<Envelope<RunDetail>> => {
    calls.push(`runs:get:${id}`);
    if (!getRunOk) {
      return { ok: false, error: { code: "RUN_UNREADABLE", message: "详情读取失败（桩）" } };
    }
    return ok(detailFor(read("u1-ok"), id));
  },
  operationsStatus: async () => ok(statusSnapshot({ operations: [settledAbRecord()] })),
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "NOT_STUBBED", message: "本桩未实现核对" },
  }),
  selectDirectory: async () => ok(null),
  forkRun: async () => {
    calls.push("runs:fork");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  promptFork: async () => {
    calls.push("runs:promptFork");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  proxyFork: async () => {
    calls.push("proxy:fork");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  createRun: async () => {
    calls.push("runs:create");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  modelAb: async () => {
    calls.push("runs:modelAb");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  modelAbPlan: async () => {
    calls.push("runs:modelAbPlan");
    return ok({ experimentId: "exp", ids: [], ok: true, plan: [], sideEffectsAllowed: false });
  },
  // U8 4.5：比较读取是只读通道；这里给错误信封，顺带承载"比较拒绝不改批次事实"
  compareRuns: async (request: { runIds: readonly string[] }) => {
    calls.push(`compareRuns:${request.runIds.join(",")}`);
    return {
      ok: false as const,
      error: { code: "COMPARE_STUB", message: "比较读取失败（桩）" },
    };
  },
  forkCapability: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "默认桩" },
  }),
  inspectWorkspace: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "默认桩" },
  }),
  readWorkspaceFile: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "默认桩" },
  }),
  settingsGet: async () => ok({ configured: true, baseURL: null, model: null, encryption: "safe" }),
  saveSettings: async () => ok(undefined),
  clearSettings: async () => ok(undefined),
  proxyStatus: async () => proxyStatusOk(),
  proxyToggle: async () => proxyStatusOk(),
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

/** 执行/预览/创建/分支/代理通道的调用次数（4.3 的反证判据：全程必须为 0） */
function executionChannelCalls(): number {
  return calls.filter(
    (one) => one !== "runs:list" && !one.startsWith("runs:get") && !one.startsWith("compareRuns"),
  ).length;
}

beforeEach(async () => {
  calls.length = 0;
  getRunOk = true;
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    readingByRun: {},
    pendingFileTarget: null,
    pendingDraftTarget: null,
    view: "trace",
  });
  // 握手采纳快照（含本批登记）；自动消费会按登记核实一遍，随后清流水与读取项
  await useAppStore.getState().refreshOperationStatus();
  calls.length = 0;
  useAppStore.setState({ resultReads: emptyResultReadStore() });
});

describe("4.3 工作区逐臂动作：只读核实，零执行通道", () => {
  it("打开结果（openOperationResult）⇒ 只有 runs:get + 明确导航到该臂；执行通道零调用", async () => {
    // 「打开结果」是用户明确动作：经既有 selectRun 落地到该臂概览（openOperationResult
    // 本身不写读取项——读取项归核实/重试通道），只读性体现在执行通道零调用。
    await useAppStore.getState().openOperationResult({
      epoch: FAKE_EPOCH,
      operationId: OP_ID,
      runId: ARM_A,
    });
    expect(calls.filter((one) => one.startsWith("runs:get"))).toEqual([`runs:get:${ARM_A}`]);
    expect(executionChannelCalls()).toBe(0);
    const after = useAppStore.getState();
    expect(after.selectedRunId).toBe(ARM_A);
    expect(after.view).toBe("trace");
    expect(after.detail?.meta.id).toBe(ARM_A);
  });

  it("不可读臂只按同一条可信 ID 重试：文件依旧坏 ⇒ 诊断保留、仍不换 id 不触发执行", async () => {
    getRunOk = false;
    await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: OP_ID,
      runId: ARM_B,
    });
    const failed =
      useAppStore.getState().resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: OP_ID, runId: ARM_B })
      ];
    expect(failed?.phase).toBe("unreadable");
    expect(failed?.reason).toContain("详情读取失败");
    // 文件归位后再重试：仍是 ARM_B 这一条，且整条路径只有 runs:get
    getRunOk = true;
    await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: OP_ID,
      runId: ARM_B,
    });
    expect(calls.filter((one) => one.startsWith("runs:get"))).toEqual([
      `runs:get:${ARM_B}`,
      `runs:get:${ARM_B}`,
    ]);
    expect(executionChannelCalls()).toBe(0);
    expect(
      useAppStore.getState().resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: OP_ID, runId: ARM_B })
      ]?.phase,
    ).toBe("verified");
  });

  it("失败定位（openOperationFailure）只消费已核实的自有失败事实：没有事实 ⇒ 零读取零执行", async () => {
    // 读取项为空（没有任何已核实事实）⇒ 不开运行、不猜调用、更不触发执行
    const landed = await useAppStore.getState().openOperationFailure({
      epoch: FAKE_EPOCH,
      operationId: OP_ID,
      runId: ARM_B,
    });
    expect(landed).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("4.5 从实验结果进入共用比较：只读往返，批次事实不变", () => {
  let opsBefore: ReturnType<typeof useAppStore.getState>["operations"];
  let readsBefore: ReturnType<typeof useAppStore.getState>["resultReads"];
  let locBefore: ReturnType<typeof useAppStore.getState>["experimentReturnLocation"];

  async function enterCompareFromExperiment(): Promise<void> {
    useAppStore.setState({
      view: "experiment",
      compareIds: [ARM_A, ARM_B],
      compareNotice: null,
    });
    opsBefore = useAppStore.getState().operations;
    readsBefore = useAppStore.getState().resultReads;
    locBefore = useAppStore.getState().experimentReturnLocation;
    await useAppStore.getState().openCompareWorkspace();
  }

  it("两条按选择顺序进入详细比较；比较入口只读——登记/读取项引用原样", async () => {
    await enterCompareFromExperiment();
    const after = useAppStore.getState();
    expect(after.view).toBe("compare");
    expect(after.compareRead.selection).toEqual([ARM_A, ARM_B]);
    expect(after.comparePair).toEqual({ leftRunId: ARM_A, rightRunId: ARM_B });
    // 来源引用记的是实验工作区（返回要回得去）
    expect(after.compareReturnLocation?.view).toBe("experiment");
    // 只读反证：比较入口不改批次登记与结果读取（引用相等 = 零改写）
    expect(after.operations).toBe(opsBefore);
    expect(after.resultReads).toBe(readsBefore);
    // 比较读取走了只读通道；执行/创建/分支/代理通道零调用
    expect(calls.filter((one) => one.startsWith("compareRuns"))).toEqual([
      `compareRuns:${ARM_A},${ARM_B}`,
    ]);
    expect(executionChannelCalls()).toBe(0);
  });

  it("比较读取被拒绝（信封错误）后返回实验：视图恢复、对照集合保留、批次事实仍原样", async () => {
    await enterCompareFromExperiment();
    // 比较结论是错误（桩返回 error 信封）——拒绝呈现归比较工作区，这里钉"返回不改批次事实"
    await useAppStore.getState().returnFromCompare();
    const after = useAppStore.getState();
    expect(after.view).toBe("experiment");
    expect(after.compareIds).toEqual([ARM_A, ARM_B]);
    expect(after.operations).toBe(opsBefore);
    expect(after.resultReads).toBe(readsBefore);
    // 实验目标没有被返回动作改写/清除（批次编辑现场不动）
    expect(after.experimentReturnLocation).toBe(locBefore);
    expect(executionChannelCalls()).toBe(0);
  });
});

describe("4.6 跨页结束与重载恢复实验结果", () => {
  it("重载后由登记快照恢复：批次呈现恢复、结果读取可重建、内存草稿与待定提交零补造", async () => {
    // beforeEach 已模拟重载后的首次握手（登记快照采纳 + 自动核实）；这里核对恢复口径
    const state = useAppStore.getState();
    const batches = deriveExperimentBatches({
      targetRunId: PARENT,
      operations: state.operations.operations,
      reads: state.resultReads,
    });
    expect(batches.length).toBe(1);
    expect(batches[0]!.view.statusLabel).toBe("已收口");
    // 重载后读取项从零开始（beforeEach 已清空）——结果读取**可重建**：显式核实即恢复
    for (const runId of [ARM_A, ARM_B]) {
      const entry = await useAppStore.getState().verifyRunResult({
        epoch: FAKE_EPOCH,
        operationId: OP_ID,
        runId,
      });
      expect(entry.phase).toBe("verified");
    }
    expect(executionChannelCalls()).toBe(0);
    // 不补造内存草稿：登记里有批次 ⇒ 草稿仓库的 model_ab 区仍为空；待定/收尾关联为空
    expect(Object.keys(state.drafts.modelAb).length).toBe(0);
    expect(Object.keys(state.draftSubmissions.byId).length).toBe(0);
  });

  it("后台结束不抢页：采纳已收口批次快照时，人在别的页面就留在别的页面（A/B 意图恒 drop）", async () => {
    // 干净会话 + 用户摆在录制页（无选中运行）
    useAppStore.setState({
      operations: initialSession(),
      resultReads: emptyResultReadStore(),
      view: "recording",
      selectedRunId: null,
    });
    calls.length = 0;
    await useAppStore.getState().refreshOperationStatus();
    const after = useAppStore.getState();
    expect(after.view).toBe("recording");
    expect(after.selectedRunId).toBeNull();
    // 批次事实照常恢复（登记在场、臂读取项落地），只是零抢焦点零自动跳转
    expect(after.operations.operations.some((r) => r.operationId === OP_ID)).toBe(true);
    expect(
      after.resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: OP_ID, runId: ARM_A })
      ]?.phase,
    ).toBe("verified");
  });
});
