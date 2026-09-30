import { ok } from "@shared/ipc";
import type { CompareRunItem, Envelope, RunDetail, RunSummary, WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyCompareReadSession } from "../src/renderer/src/lib/compare-state";
import type { Deferred } from "./helpers/deterministic-schedule";
import { deferred } from "./helpers/deterministic-schedule";

/**
 * U7（improve-branch-comparison）任务 1.4/1.5 的 **store 接线半边**：
 * 比较选择集的代次守卫、迟到响应丢弃、销毁守卫与全量重试真的在 store 上生效。
 *
 * 场景对应：
 * - 「快速更换交换移出不串内容」——旧代次/离场后的响应整份丢弃；
 * - 「比较重试恢复必须全量重验」——重试先撤销旧结论，新失败撤销旧成功；
 * - 「比较全程只读且不恢复许可」——调用序列只有 runs:compare，零执行通道。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function detailOf(id: string): RunDetail {
  const meta = {
    id,
    parent: null,
    type: "run.meta" as const,
    format_version: 1,
    task: `任务 ${id}`,
    model: "controlled-model",
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

function chainSummary(id: string): RunSummary {
  return {
    id,
    task: `任务 ${id}`,
    model: "controlled-model",
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
  };
}

function readyItem(id: string): CompareRunItem {
  return { status: "ready", runId: id, detail: detailOf(id), chainSummaries: [chainSummary(id)] };
}

function verifiedPayload(...ids: string[]): Envelope<unknown> {
  return ok({ items: ids.map((id) => readyItem(id)) });
}

const calls: string[] = [];
/** 在途闸门：由用例决定哪一次响应先落地（代次竞争判据） */
let compareGates: Array<Deferred<Envelope<unknown>>> = [];
let compareEnvelope: Envelope<unknown> = verifiedPayload("r_a");

const apiStub: Record<string, unknown> = {
  listRuns: async () => {
    calls.push("runs:list");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  getRun: async (id: string) => {
    calls.push(`runs:get:${id}`);
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  compareRuns: async (request: { runIds: string[] }) => {
    calls.push(`runs:compare:${request.runIds.join(",")}`);
    const gate = compareGates.shift();
    if (gate !== undefined) return gate.promise;
    return compareEnvelope;
  },
  forkRun: async () => {
    calls.push("runs:fork");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  promptFork: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "默认桩" },
  }),
  proxyFork: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  createRun: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  modelAb: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  modelAbPlan: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "默认桩" },
  }),
  chooseSource: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
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
  getSettings: async () => ok({ configured: true, baseURL: null, model: null, encryption: "safe" }),
  saveSettings: async () => ok({ configured: true }),
  clearSettings: async () => ok({ configured: false }),
  proxyStatus: async () =>
    ok({ enabled: false, running: false, port: 18787, upstreamBaseUrl: "", hasKey: false }),
  proxyToggle: async () =>
    ok({ enabled: false, running: false, port: 18787, upstreamBaseUrl: "", hasKey: false }),
  operationsStatus: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "默认桩" },
  }),
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "默认桩" },
  }),
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

beforeEach(() => {
  calls.length = 0;
  compareGates = [];
  compareEnvelope = verifiedPayload("r_a");
  useAppStore.setState({ compareRead: emptyCompareReadSession() });
});

describe("U7 1.4 选择集代次与迟到响应守卫", () => {
  it("进入比较发起单次 runs:compare，结论携带请求顺序的逐项结果", async () => {
    compareEnvelope = verifiedPayload("r_a", "r_b");
    const result = await useAppStore.getState().enterCompareSelection(["r_a", "r_b"]);
    expect(result).toBe("started");

    const { compareRead } = useAppStore.getState();
    expect(compareRead.selection).toEqual(["r_a", "r_b"]);
    expect(compareRead.conclusion?.kind).toBe("verified");
    if (compareRead.conclusion?.kind === "verified") {
      expect(compareRead.conclusion.items.map((item) => item.runId)).toEqual(["r_a", "r_b"]);
    }
    expect(compareRead.request).toBeNull();
    expect(calls).toEqual(["runs:compare:r_a,r_b"]);
  });

  it("快速更换：旧响应在飞期间换对象 ⇒ 旧响应整份丢弃，不覆盖新选择集", async () => {
    const gate1 = deferred<Envelope<unknown>>();
    compareGates.push(gate1);
    const first = useAppStore.getState().enterCompareSelection(["r_a", "r_b"]);
    const generation1 = useAppStore.getState().compareRead.generation;

    const gate2 = deferred<Envelope<unknown>>();
    compareGates.push(gate2);
    const second = useAppStore.getState().enterCompareSelection(["r_a", "r_c"]);
    const generation2 = useAppStore.getState().compareRead.generation;
    expect(generation2).toBeGreaterThan(generation1);

    // 旧代次响应先落地：请求选择集 [a,b] ≠ 当前在飞 [a,c] ⇒ 丢弃
    gate1.resolve(verifiedPayload("r_a", "r_b"));
    await first;
    let state = useAppStore.getState().compareRead;
    expect(state.conclusion).toBeNull();
    expect(state.request?.runIds).toEqual(["r_a", "r_c"]);
    expect(state.request?.generation).toBe(generation2);

    // 当代响应落地：正常采信
    gate2.resolve(verifiedPayload("r_a", "r_c"));
    await second;
    state = useAppStore.getState().compareRead;
    expect(state.conclusion?.kind).toBe("verified");
    if (state.conclusion?.kind === "verified") {
      expect(state.conclusion.items.map((item) => item.runId)).toEqual(["r_a", "r_c"]);
    }
  });

  it("销毁守卫：离开比较后在飞响应落地 ⇒ 不复活选择集、不产生结论", async () => {
    const gate = deferred<Envelope<unknown>>();
    compareGates.push(gate);
    const pending = useAppStore.getState().enterCompareSelection(["r_a", "r_b"]);
    useAppStore.getState().leaveCompare();

    gate.resolve(verifiedPayload("r_a", "r_b"));
    await pending;

    const { compareRead } = useAppStore.getState();
    expect(compareRead.selection).toBeNull();
    expect(compareRead.request).toBeNull();
    expect(compareRead.conclusion).toBeNull();
    // 代次仍单调递增：离场前代次 + 离场推进，迟到响应的代次永远对不上
    expect(compareRead.generation).toBeGreaterThanOrEqual(2);
  });

  it("非法选择集（重复 id）不变更状态且不发请求", async () => {
    const result = await useAppStore.getState().enterCompareSelection(["r_a", "r_a"]);
    expect(result).toBe("invalid");
    expect(useAppStore.getState().compareRead).toEqual(emptyCompareReadSession());
    expect(calls).toEqual([]);
  });

  it("重复进入同一选择集幂等：不重读、保留在场结论", async () => {
    await useAppStore.getState().enterCompareSelection(["r_a", "r_b"]);
    const before = useAppStore.getState().compareRead;

    const result = await useAppStore.getState().enterCompareSelection(["r_a", "r_b"]);
    expect(result).toBe("unchanged");
    expect(useAppStore.getState().compareRead).toBe(before);
    expect(calls).toEqual(["runs:compare:r_a,r_b"]);
  });
});

describe("U7 1.5 显式只读重试：全量重验与结论撤销", () => {
  it("重试先撤销旧结论再读取：成功后旧成功不被当成本次成功（代次单调）", async () => {
    compareEnvelope = verifiedPayload("r_a", "r_b");
    await useAppStore.getState().enterCompareSelection(["r_a", "r_b"]);
    const firstConclusion = useAppStore.getState().compareRead.conclusion;
    expect(firstConclusion?.kind).toBe("verified");

    const gate = deferred<Envelope<unknown>>();
    compareGates.push(gate);
    const retryPromise = useAppStore.getState().retryCompareSelectionRead();
    // 重试发起的瞬间：旧结论已撤销（刷新明确撤销旧比较结论后再展示新结论）
    const reading = useAppStore.getState().compareRead;
    expect(reading.conclusion).toBeNull();
    expect(reading.generation).toBeGreaterThan(firstConclusion?.generation ?? 0);

    // 本次重试读到失败（文件被外部改坏）：新失败撤销旧成功
    gate.resolve({
      ok: false as const,
      error: { code: "GET_RUN_FAILED", message: "祖先 run r_x 校验失败" },
    });
    await retryPromise;
    const after = useAppStore.getState().compareRead;
    expect(after.conclusion?.kind).toBe("rejected");
    if (after.conclusion?.kind === "rejected") {
      expect(after.conclusion.code).toBe("GET_RUN_FAILED");
      expect(after.conclusion.reason).toContain("r_x");
    }
  });

  it("重试读到成功（祖先文件恢复）：整组重验后恢复 verified", async () => {
    compareEnvelope = {
      ok: false as const,
      error: { code: "INVALID_ARGUMENT", message: "run 标识非法：不能为空" },
    };
    await useAppStore.getState().enterCompareSelection(["r_a"]);
    expect(useAppStore.getState().compareRead.conclusion?.kind).toBe("rejected");

    compareEnvelope = verifiedPayload("r_a");
    const retried = await useAppStore.getState().retryCompareSelectionRead();
    expect(retried).toBe(true);
    const after = useAppStore.getState().compareRead;
    expect(after.conclusion?.kind).toBe("verified");
    // 全量重验 = 重新发整组请求（不是局部拼旧链）
    expect(calls).toEqual(["runs:compare:r_a", "runs:compare:r_a"]);
  });

  it("无活动选择集时不可重试（不伪造请求）", async () => {
    const retried = await useAppStore.getState().retryCompareSelectionRead();
    expect(retried).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("U7 1.4/1.5 只读边界", () => {
  it("进入、重试、离开全程只有 runs:compare 调用，零执行通道、零列表刷新", async () => {
    await useAppStore.getState().enterCompareSelection(["r_a", "r_b"]);
    await useAppStore.getState().retryCompareSelectionRead();
    useAppStore.getState().leaveCompare();
    expect(calls.every((call) => call.startsWith("runs:compare:"))).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
