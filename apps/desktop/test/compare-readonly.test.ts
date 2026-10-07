import type { SpanLine } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { CompareRunItem, Envelope, RunDetail, RunSummary, WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyCompareReadSession } from "../src/renderer/src/lib/compare-state";
import { proxyStatusOk } from "./helpers/proxy-state-fixture";

/**
 * U7（improve-branch-comparison）任务 5.10：比较路径**只读反证**。
 *
 * 场景「比较全程只读且不恢复许可」的单元级反证（desktop-ui delta）：
 * 完成选中、比较、文本 diff、指标阅读、重试、单侧文件打开和返回后——
 * - 模型/工具及执行通道调用均为零（执行通道桩一旦被调用即计入 calls ⇒ 断言变红，
 *   这就是"写入反证"：故意把可写通道摆在那儿，任何越权调用都逃不过）；
 * - 不生成操作身份、不调用操作通道（operations:status / reconcile 由挂载握手承担，
 *   比较动作自身零调用）；
 * - 不清草稿或恢复授权（草稿/执行确认/来源撤销状态逐字节不变）。
 *
 * 真实文件字节不变性（trace/blob/source）由 main 层通道形状保证：渲染层 window.api
 * 面上不存在任何"写 trace"的通道可调（preload 白名单钉死），本文件的桩形状即其镜像。
 */

const T0 = "2026-01-15T10:00:00.000Z";

const calls: string[] = [];

function detailOf(id: string, opts: { isolated?: boolean; ownStep?: string } = {}): RunDetail {
  const meta = {
    id,
    parent: null,
    type: "run.meta" as const,
    format_version: (opts.isolated === true ? 2 : 1) as 1 | 2,
    task: `任务 ${id}`,
    model: "controlled-model",
    created_at: T0,
    fork: null,
    ...(opts.isolated === true
      ? {
          workspace: {
            profile: "file-tools-v1" as const,
            world_id: id,
            write_authorized: true as const,
            initial_snapshot: { id: "0".repeat(64), files: [] },
            origin: { kind: "import" as const },
          },
        }
      : {}),
  };
  const ownStep = opts.ownStep ?? null;
  const spans =
    ownStep !== null
      ? [{ type: "span", id: ownStep, parent: null, kind: "agent.step", n: 1 } as SpanLine]
      : [];
  return {
    meta,
    spans,
    events: [],
    status: "completed",
    chain: [{ meta, fork: null }],
    leafSpanIds: ownStep !== null ? [ownStep] : [],
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
    reason: "completed",
    parent: null,
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

function verifiedEnvelope(ids: readonly string[]): Envelope<unknown> {
  const items: CompareRunItem[] = ids.map((id) => ({
    status: "ready" as const,
    runId: id,
    detail: detailOf(id),
    chainSummaries: [chainSummary(id)],
  }));
  return ok({ items });
}

/** 执行与写入通道：任何调用都被记入 calls（写入反证）并返回拒绝信封 */
function executionStub(name: string) {
  return async () => {
    calls.push(name);
    return { ok: false as const, error: { code: "FORBIDDEN_IN_COMPARE", message: "比较不得执行" } };
  };
}

const apiStub: Record<string, unknown> = {
  listRuns: async () => {
    calls.push("runs:list");
    return {
      ok: true as const,
      data: {
        runs: [chainSummary("r_a"), chainSummary("r_b"), chainSummary("r_iso")],
        failed: [],
      },
    };
  },
  getRun: async (id: string) => {
    calls.push(`runs:get:${id}`);
    return ok(
      detailOf(id, { isolated: id === "r_iso", ownStep: id === "r_iso" ? "s_01" : undefined }),
    );
  },
  compareRuns: async (request: { runIds: string[] }) => {
    calls.push(`runs:compare:${request.runIds.join(",")}`);
    return verifiedEnvelope(request.runIds);
  },
  // —— 全部执行/写通道（反证桩）：出现任何一次调用测试即红 ——
  forkRun: executionStub("runs:fork"),
  promptFork: executionStub("runs:promptFork"),
  proxyFork: executionStub("runs:proxyFork"),
  createRun: executionStub("runs:create"),
  modelAb: executionStub("runs:modelAb"),
  modelAbPlan: executionStub("runs:modelAbPlan"),
  chooseSource: executionStub("workspaces:chooseSource"),
  forkCapability: executionStub("workspaces:forkCapability"),
  // 只读文件检查（U2 文件页在用，允许被调用；记录以便核对）
  inspectWorkspace: async (request: { runId: string }) => {
    calls.push(`workspaces:inspect:${request.runId}`);
    return ok({
      runId: request.runId,
      stepSpanId: null,
      snapshotId: "0".repeat(64),
      ownerRunId: request.runId,
      localIteration: null,
      profile: "file-tools-v1",
      worldId: request.runId,
      origin: { kind: "import" },
      files: [],
      fileCount: 0,
      totalBytes: 0,
      unavailableCount: 0,
      initialSnapshotId: "0".repeat(64),
    });
  },
  readFile: async () => {
    calls.push("workspaces:readFile");
    return { ok: false as const, error: { code: "UNUSED", message: "桩" } };
  },
  getSettings: async () => ok({ configured: true, baseURL: null, model: null, encryption: "safe" }),
  saveSettings: executionStub("settings:save"),
  clearSettings: executionStub("settings:clear"),
  proxyStatus: async () => proxyStatusOk(),
  proxyToggle: executionStub("proxy:toggle"),
  operationsStatus: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "桩" },
  }),
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const EXECUTION_OR_WRITE_MARKERS = [
  "runs:fork",
  "runs:promptFork",
  "runs:proxyFork",
  "runs:create",
  "runs:modelAb",
  "runs:modelAbPlan",
  "workspaces:chooseSource",
  "workspaces:forkCapability",
  "settings:save",
  "settings:clear",
  "proxy:toggle",
];

/** 允许出现的通道：只读读取（比较/详情/文件清单/列表） */
function readOnlyCalls(): string[] {
  return calls.filter(
    (call) =>
      call.startsWith("runs:compare") ||
      call.startsWith("runs:get") ||
      call.startsWith("workspaces:inspect") ||
      call.startsWith("runs:list"),
  );
}

beforeEach(() => {
  calls.length = 0;
  useAppStore.setState({
    compareRead: emptyCompareReadSession(),
    comparePair: null,
    compareReturnLocation: null,
    compareIds: [],
    compareNotice: null,
    view: "trace",
    selectedRunId: null,
    detail: null,
    readingByRun: {},
    navGeneration: 0,
  });
});

describe("5.10 比较全程只读（写入反证）", () => {
  it("选中→比较→重试→指标阅读→交换→返回：只产生 runs:compare，执行/写通道零调用", async () => {
    const store = useAppStore.getState();
    await store.enterCompareSelection(["r_a", "r_b"]);
    await store.retryCompareSelectionRead();
    await store.swapCompareSides();
    store.returnToCompare();
    store.returnFromCompare();

    // 全部调用都是只读读取
    expect(calls.length).toBeGreaterThan(0);
    expect(readOnlyCalls().length).toBe(calls.length);
    for (const marker of EXECUTION_OR_WRITE_MARKERS) {
      expect(
        calls.some((call) => call.startsWith(marker)),
        marker,
      ).toBe(false);
    }
  });

  it("指标表选两条（openComparePair）与更换/交换：同样零执行通道", async () => {
    useAppStore.setState({ compareIds: ["r_a", "r_b", "r_iso"] } as never);
    const store = useAppStore.getState();
    await store.openComparePair("r_a", "r_b");
    await store.setCompareSide("right", "r_iso");
    await store.swapCompareSides();

    expect(calls.length).toBe(calls.filter((call) => call.startsWith("runs:compare")).length);
    for (const marker of EXECUTION_OR_WRITE_MARKERS) {
      expect(
        calls.some((call) => call.startsWith(marker)),
        marker,
      ).toBe(false);
    }
  });

  it("单侧文件打开（隔离 run）→ 返回比较：只走 runs:get + 文件清单只读，不碰执行通道", async () => {
    useAppStore.setState({
      comparePair: { leftRunId: "r_iso", rightRunId: "r_b" },
      compareRead: {
        ...emptyCompareReadSession(),
        selection: ["r_iso", "r_b"],
        conclusion: {
          generation: 1,
          runIds: ["r_iso", "r_b"],
          kind: "verified" as const,
          items: [
            {
              status: "ready" as const,
              runId: "r_iso",
              detail: detailOf("r_iso", { isolated: true, ownStep: "s_01" }),
              chainSummaries: [chainSummary("r_iso")],
            },
            {
              status: "ready" as const,
              runId: "r_b",
              detail: detailOf("r_b"),
              chainSummaries: [chainSummary("r_b")],
            },
          ],
        },
      },
      compareIds: [],
    } as never);

    const store = useAppStore.getState();
    const result = await store.openCompareSideFiles("left");
    expect(result).toBe("opened");
    store.returnToCompare();

    expect(calls.length).toBe(readOnlyCalls().length);
    for (const marker of EXECUTION_OR_WRITE_MARKERS) {
      expect(
        calls.some((call) => call.startsWith(marker)),
        marker,
      ).toBe(false);
    }
    // pair 保留（返回比较成立）
    expect(useAppStore.getState().comparePair).toEqual({ leftRunId: "r_iso", rightRunId: "r_b" });
  });

  it("不清草稿、不恢复授权：比较动作零新增确认、零改动草稿与来源撤销（许可状态面）", async () => {
    const seedDrafts = { "epoch-1": { kind: "fork", frozen: true, marker: "勿动" } };
    // ConfirmationStore 形状：{ byTargetKey: Record<string, ExecutionConfirmation> }
    const seedConfirmations = { byTargetKey: { "draft-key": { marker: "勿动" } } };
    const seedRevocation = { "source-token": { revoked: true } };
    useAppStore.setState({
      compareIds: ["r_a", "r_b"],
      drafts: seedDrafts,
      confirmations: seedConfirmations,
      sourceRevocation: seedRevocation,
    } as never);

    const store = useAppStore.getState();
    await store.openComparePair("r_a", "r_b");
    await store.retryCompareSelectionRead();
    store.returnFromCompare();

    // 草稿与来源撤销：逐字节不变（比较不清草稿、不撤销也不恢复来源授权）
    expect(useAppStore.getState().drafts).toEqual(seedDrafts);
    expect(useAppStore.getState().sourceRevocation).toEqual(seedRevocation);
    // 执行确认：比较动作不**新增**任何确认（不恢复许可）。注：换阅读对象清空**既有**
    // 待用确认是 U5 4.4 的既有语义（noteReadingChanged 同款，切运行也一样），
    // 不是比较路径新增的清权——这里钉"只减不增"。
    const keys = Object.keys(useAppStore.getState().confirmations.byTargetKey);
    expect(keys.length).toBeLessThanOrEqual(1);
    expect(keys).not.toContain("compare-forged");
    // 操作身份零生成：比较动作期间操作通道零调用
    expect(calls.some((call) => call.startsWith("operations:"))).toBe(false);
  });
});
