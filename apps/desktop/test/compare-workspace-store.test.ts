import { ok } from "@shared/ipc";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { CompareRunItem, Envelope, RunDetail, RunSummary, WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyCompareReadSession } from "../src/renderer/src/lib/compare-state";
import type { Deferred } from "./helpers/deterministic-schedule";
import { deferred } from "./helpers/deterministic-schedule";

/**
 * U7（improve-branch-comparison）任务 2.1/2.2/2.3/2.5 的 **store 接线半边**：
 * 父子入口、pair 编辑、返回位置与单侧往返真的接在 store 上，且不碰侧栏选择。
 *
 * 场景对应：
 * - 「父子入口默认父左子右」——概览入口打开即父左子右；侧栏选择不动；
 * - 「更换交换不改变侧栏选择」——pair 编辑只动 comparePair/compareRead；
 * - 「返回恢复来源与单侧阅读」——返回来源恢复视图与阅读位置；打开单侧保留凭据。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function detailOf(
  id: string,
  opts: { parent?: string | null; forkField?: string; isolated?: boolean; ownStep?: string } = {},
): RunDetail {
  const parent = opts.parent ?? null;
  const forkField = opts.forkField;
  const fork =
    parent !== null && forkField !== undefined
      ? { at_span: "s_01", edit: { field: forkField, value: "x" } }
      : null;
  const meta = {
    id,
    parent,
    type: "run.meta" as const,
    format_version: (opts.isolated === true ? 2 : 1) as 1 | 2,
    task: `任务 ${id}`,
    model: "controlled-model",
    created_at: T0,
    fork,
    ...(opts.isolated === true
      ? // 完整合法的 v2 隔离 meta（过 RunDetailSchema：world_id = 本 run id、根 run ⇒ import）
        {
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
    chain: [{ meta, fork }],
    leafSpanIds: ownStep !== null ? [ownStep] : [],
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

function chainSummary(id: string, parent: string | null): RunSummary {
  return {
    id,
    task: `任务 ${id}`,
    model: "controlled-model",
    created_at: T0,
    status: "completed",
    parent,
    reason: "completed",
    fork: parent === null ? null : { at_span: "s_01", edit_field: "result", experiment_id: null },
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

function verifiedPayload(pairs: ReadonlyArray<[string, string | null]>): Envelope<unknown> {
  const items: CompareRunItem[] = pairs.map(([id, parent]) => ({
    status: "ready" as const,
    runId: id,
    detail: detailOf(id, { parent: parent }),
    chainSummaries: [chainSummary(id, parent)],
  }));
  return ok({ items });
}

const calls: string[] = [];
let compareGates: Array<Deferred<Envelope<unknown>>> = [];
let compareEnvelope: Envelope<unknown> = verifiedPayload([
  ["r_parent", null],
  ["r_child", "r_parent"],
]);

const apiStub: Record<string, unknown> = {
  listRuns: async () => {
    calls.push("runs:list");
    return {
      ok: true as const,
      data: {
        runs: [
          chainSummary("r_parent", null),
          chainSummary("r_child", "r_parent"),
          chainSummary("r_other", null),
        ],
        failed: [],
      },
    };
  },
  getRun: async (id: string) => {
    calls.push(`runs:get:${id}`);
    if (id === "r_iso") return ok(detailOf(id, { isolated: true, ownStep: "s_01" }));
    return ok(detailOf(id, { parent: id === "r_child" ? "r_parent" : null }));
  },
  compareRuns: async (request: { runIds: string[] }) => {
    calls.push(`runs:compare:${request.runIds.join(",")}`);
    const gate = compareGates.shift();
    if (gate !== undefined) return gate.promise;
    return compareEnvelope;
  },
  forkRun: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  promptFork: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  proxyFork: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  createRun: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  modelAb: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  modelAbPlan: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  chooseSource: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  forkCapability: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  inspectWorkspace: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  readWorkspaceFile: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  getSettings: async () => ok({ configured: true, baseURL: null, model: null, encryption: "safe" }),
  saveSettings: async () => ok({ configured: true }),
  clearSettings: async () => ok({ configured: false }),
  proxyStatus: async () =>
    ok({ enabled: false, running: false, port: 18787, upstreamBaseUrl: "", hasKey: false }),
  proxyToggle: async () =>
    ok({ enabled: false, running: false, port: 18787, upstreamBaseUrl: "", hasKey: false }),
  operationsStatus: async () => ({ ok: false as const, error: { code: "UNUSED", message: "桩" } }),
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "桩" },
  }),
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

/** 把界面摆在「正在读 r_child 的概览页」的位置上（父子入口的现场） */
async function placeReadingChild(): Promise<void> {
  useAppStore.setState({
    runs: [chainSummary("r_child", "r_parent"), chainSummary("r_parent", null)],
    selectedRunId: "r_child",
    detail: detailOf("r_child", { parent: "r_parent", forkField: "result" }),
    view: "trace",
    loadingList: false,
    listLoaded: true,
  });
  useAppStore.getState().setReadingTab("r_child", "overview");
}

beforeEach(() => {
  calls.length = 0;
  compareGates = [];
  compareEnvelope = verifiedPayload([
    ["r_parent", null],
    ["r_child", "r_parent"],
  ]);
  useAppStore.setState({
    compareRead: emptyCompareReadSession(),
    comparePair: null,
    compareReturnLocation: null,
    compareIds: [],
    compareNotice: null,
    view: "trace",
    selectedRunId: null,
    detail: null,
    navGeneration: 0,
  });
});

describe("U7 2.1 父子入口（概览）", () => {
  it("打开即父左子右：视图切比较、选中项与全局集合不动、读取按新序发起", async () => {
    await placeReadingChild();
    const generationBefore = useAppStore.getState().navGeneration;

    const result = await useAppStore.getState().openCompareWithParent("r_child");
    expect(result).toBe("opened");

    const state = useAppStore.getState();
    expect(state.view).toBe("compare");
    expect(state.comparePair).toEqual({ leftRunId: "r_parent", rightRunId: "r_child" });
    expect(state.compareRead.selection).toEqual(["r_parent", "r_child"]);
    // 侧栏选择与全局对照集合纹丝不动
    expect(state.selectedRunId).toBe("r_child");
    expect(state.compareIds).toEqual([]);
    // 进入比较 = 显式阅读意图 ⇒ 推进导航代次（2.4 的判据半边）
    expect(state.navGeneration).toBeGreaterThan(generationBefore);
    // 来源引用已捕获（trace + r_child）
    expect(state.compareReturnLocation).not.toBeNull();
    expect(state.compareReturnLocation?.view).toBe("trace");
    expect(state.compareReturnLocation?.runId).toBe("r_child");
  });

  it("model_params 臂被实验门禁挡住（blocked）；根 run 无入口（hidden）", async () => {
    await placeReadingChild();
    useAppStore.setState({
      detail: detailOf("r_arm", { parent: "r_parent", forkField: "model_params" }),
      selectedRunId: "r_arm",
    });
    expect(await useAppStore.getState().openCompareWithParent("r_arm")).toBe("blocked");
    expect(useAppStore.getState().view).toBe("trace");

    useAppStore.setState({
      detail: detailOf("r_root", { parent: null }),
      selectedRunId: "r_root",
    });
    expect(await useAppStore.getState().openCompareWithParent("r_root")).toBe("hidden");
    // 两次都没有发比较请求
    expect(calls.every((call) => !call.startsWith("runs:compare"))).toBe(true);
  });

  it("详情归属不符（串号/迟到）⇒ 不猜父本，按无入口处理", async () => {
    await placeReadingChild();
    expect(await useAppStore.getState().openCompareWithParent("r_other")).toBe("hidden");
    expect(useAppStore.getState().view).toBe("trace");
  });
});

describe("U7 2.2/2.5 手动集合与 pair 编辑", () => {
  it("恰好两条（先子后父）⇒ 加入顺序定左右：子左父右，并按该序读取（2.5）", async () => {
    useAppStore.setState({ compareIds: ["r_child", "r_parent"] });
    await useAppStore.getState().openCompareWorkspace();

    const state = useAppStore.getState();
    expect(state.view).toBe("compare");
    expect(state.comparePair).toEqual({ leftRunId: "r_child", rightRunId: "r_parent" });
    expect(state.compareRead.selection).toEqual(["r_child", "r_parent"]);
    expect(calls).toContain("runs:compare:r_child,r_parent");
    // 全局集合不被进入动作改变
    expect(state.compareIds).toEqual(["r_child", "r_parent"]);
  });

  it("更换一侧：pair 更新并按新序重读；侧栏选择不动；同 ID 拒绝、同值幂等", async () => {
    useAppStore.setState({ compareIds: ["r_parent", "r_child"] });
    await useAppStore.getState().openCompareWorkspace();
    const readsAfterEnter = calls.filter((call) => call.startsWith("runs:compare")).length;
    useAppStore.setState({ selectedRunId: "r_child" });

    const replaced = await useAppStore.getState().setCompareSide("right", "r_other");
    expect(replaced).toBe("replaced");
    expect(useAppStore.getState().comparePair).toEqual({
      leftRunId: "r_parent",
      rightRunId: "r_other",
    });
    expect(useAppStore.getState().compareRead.selection).toEqual(["r_parent", "r_other"]);
    // 侧栏选择纹丝不动
    expect(useAppStore.getState().selectedRunId).toBe("r_child");

    const unchanged = await useAppStore.getState().setCompareSide("right", "r_other");
    expect(unchanged).toBe("unchanged");
    const rejected = await useAppStore.getState().setCompareSide("right", "r_parent");
    expect(rejected).toBe("rejected");
    // 幂等与拒绝都不触发第二次读取
    expect(calls.filter((call) => call.startsWith("runs:compare")).length).toBe(
      readsAfterEnter + 1,
    );
  });

  it("交换左右：pair 反转并按新序重读；侧栏选择不动", async () => {
    useAppStore.setState({ compareIds: ["r_parent", "r_child"] });
    await useAppStore.getState().openCompareWorkspace();
    useAppStore.setState({ selectedRunId: "r_child" });

    const result = await useAppStore.getState().swapCompareSides();
    expect(result).toBe("swapped");
    expect(useAppStore.getState().comparePair).toEqual({
      leftRunId: "r_child",
      rightRunId: "r_parent",
    });
    expect(useAppStore.getState().compareRead.selection).toEqual(["r_child", "r_parent"]);
    expect(useAppStore.getState().selectedRunId).toBe("r_child");
  });

  it("三条集合：不自动选两条，如实提示后仍进工作区（无 pair）", async () => {
    useAppStore.setState({ compareIds: ["a", "b", "c"] });
    await useAppStore.getState().openCompareWorkspace();
    const state = useAppStore.getState();
    expect(state.view).toBe("compare");
    expect(state.comparePair).toBeNull();
    expect(state.compareNotice).toContain("显式选择两条");
  });

  it("集合进入清残留 pair：先 pair 进入再把集合缩到 1 条重进 ⇒ 旧 pair 必须清掉（6.4 实机坐实）", async () => {
    // 先经两条集合进入（pair 在场）
    useAppStore.setState({ compareIds: ["r_parent", "r_child"] });
    await useAppStore.getState().openCompareWorkspace();
    expect(useAppStore.getState().comparePair).not.toBeNull();
    // 再把集合缩到 1 条重进 ⇒ 残留 pair 若不清，工作区会卡在「正在读取详细比较对象…」
    useAppStore.setState({ compareIds: ["r_other"] });
    await useAppStore.getState().openCompareWorkspace();
    const state = useAppStore.getState();
    expect(state.view).toBe("compare");
    expect(state.comparePair).toBeNull();
    expect(state.compareRead.selection).toEqual(["r_other"]);
  });
});

describe("U7 5.3 指标表显式选两条（openComparePair）", () => {
  it("集合内互异两条 ⇒ 打开 pair 并按该序读取；全局集合纹丝不动", async () => {
    useAppStore.setState({ compareIds: ["r_parent", "r_child", "r_other"] });
    const generationBefore = useAppStore.getState().navGeneration;

    const result = await useAppStore.getState().openComparePair("r_child", "r_other");

    expect(result).toBe("opened");
    expect(useAppStore.getState().comparePair).toEqual({
      leftRunId: "r_child",
      rightRunId: "r_other",
    });
    expect(useAppStore.getState().compareRead.selection).toEqual(["r_child", "r_other"]);
    expect(calls).toContain("runs:compare:r_child,r_other");
    // 显式选择不改全局集合（D1）
    expect(useAppStore.getState().compareIds).toEqual(["r_parent", "r_child", "r_other"]);
    // 页内换 pair = 显式换阅读对象 ⇒ 推进导航代次（2.4 同款）
    expect(useAppStore.getState().navGeneration).toBeGreaterThan(generationBefore);
  });

  it("相同 ID ⇒ rejected（不进入、不读取）；集合外 id ⇒ rejected", async () => {
    useAppStore.setState({ compareIds: ["r_parent", "r_child"] });
    expect(await useAppStore.getState().openComparePair("r_child", "r_child")).toBe("rejected");
    expect(await useAppStore.getState().openComparePair("r_child", "r_ghost")).toBe("rejected");
    expect(useAppStore.getState().comparePair).toBeNull();
    expect(calls.every((call) => !call.startsWith("runs:compare"))).toBe(true);
  });

  it("同 pair 重复提交幂等：不重读（enterCompareSelection 同集幂等）", async () => {
    useAppStore.setState({ compareIds: ["r_parent", "r_child"] });
    await useAppStore.getState().openComparePair("r_parent", "r_child");
    const readsAfterOpen = calls.filter((call) => call.startsWith("runs:compare")).length;
    await useAppStore.getState().openComparePair("r_parent", "r_child");
    expect(calls.filter((call) => call.startsWith("runs:compare")).length).toBe(readsAfterOpen);
  });
});

describe("U7 5.6/5.7 单侧文件入口（openCompareSideFiles）", () => {
  it("普通运行 ⇒ unsupported：不发起 runs:get、不进文件页（不造文件历史）", async () => {
    useAppStore.setState({
      compareIds: [],
      comparePair: { leftRunId: "r_plain", rightRunId: "r_other" },
      compareRead: {
        ...emptyCompareReadSession(),
        selection: ["r_plain", "r_other"],
        conclusion: {
          generation: 1,
          runIds: ["r_plain", "r_other"],
          kind: "verified",
          items: [
            { status: "ready", runId: "r_plain", detail: detailOf("r_plain"), chainSummaries: [chainSummary("r_plain", null)] },
            { status: "ready", runId: "r_other", detail: detailOf("r_other"), chainSummaries: [chainSummary("r_other", null)] },
          ],
        },
      },
    } as never);

    const result = await useAppStore.getState().openCompareSideFiles("left");

    expect(result).toBe("unsupported");
    expect(calls.every((call) => !call.startsWith("runs:get"))).toBe(true);
    expect(useAppStore.getState().view).toBe("trace");
  });

  it("隔离运行 + 自有完成步骤选中 ⇒ 打开文件页：检查点落在该自有步骤上，pair 与来源引用保留", async () => {
    useAppStore.setState({
      compareIds: [],
      comparePair: { leftRunId: "r_iso", rightRunId: "r_other" },
      compareReturnLocation: { view: "tree", runId: null },
      compareRead: {
        ...emptyCompareReadSession(),
        selection: ["r_iso", "r_other"],
        conclusion: {
          generation: 1,
          runIds: ["r_iso", "r_other"],
          kind: "verified",
          items: [
            {
              status: "ready",
              runId: "r_iso",
              detail: detailOf("r_iso", { isolated: true, ownStep: "s_01" }),
              chainSummaries: [chainSummary("r_iso", null)],
            },
            { status: "ready", runId: "r_other", detail: detailOf("r_other"), chainSummaries: [chainSummary("r_other", null)] },
          ],
        },
      },
      compareStepSelection: { left: "s_01", right: null },
    } as never);

    const result = await useAppStore.getState().openCompareSideFiles("left");

    expect(result).toBe("opened");
    const state = useAppStore.getState();
    expect(state.view).toBe("trace");
    expect(state.selectedRunId).toBe("r_iso");
    expect(state.readingByRun.r_iso?.tab).toBe("files");
    // 5.7：检查点 = 该 run 的合法自有完成步骤（leafSpanIds 内 agent.step）
    expect(state.readingByRun.r_iso?.files?.checkpoint).toBe("s_01");    // 2.3：打开单侧不清 pair 与来源引用 ⇒ 「返回比较」仍成立
    expect(state.comparePair).toEqual({ leftRunId: "r_iso", rightRunId: "r_other" });
    expect(state.compareReturnLocation).toEqual({ view: "tree", runId: null });
  });

  it("选中步骤是祖先/非自有 ⇒ 打开文件页但不写该检查点（走 U2 已保存/默认）", async () => {
    useAppStore.setState({
      readingByRun: {},
      compareIds: [],
      comparePair: { leftRunId: "r_iso", rightRunId: "r_other" },
      compareRead: {
        ...emptyCompareReadSession(),
        selection: ["r_iso", "r_other"],
        conclusion: {
          generation: 1,
          runIds: ["r_iso", "r_other"],
          kind: "verified",
          items: [
            // 详情里没有自有步骤（leafSpanIds 为空）⇒ 任何选中都不能成为定位目标
            {
              status: "ready",
              runId: "r_iso",
              detail: detailOf("r_iso", { isolated: true }),
              chainSummaries: [chainSummary("r_iso", null)],
            },
            { status: "ready", runId: "r_other", detail: detailOf("r_other"), chainSummaries: [chainSummary("r_other", null)] },
          ],
        },
      },
      compareStepSelection: { left: "s_ghost", right: null },
    } as never);

    const result = await useAppStore.getState().openCompareSideFiles("left");

    expect(result).toBe("opened");
    const state = useAppStore.getState();
    expect(state.view).toBe("trace");
    expect(state.readingByRun.r_iso?.tab).toBe("files");
    // 未写检查点：仍处于「未进过文件页」语义，由 U2 默认规则接管
    expect(state.readingByRun.r_iso?.files?.checkpoint).toBeUndefined();
  });
});

describe("U7 2.3 返回位置与单侧往返", () => {
  it("返回来源：恢复视图与阅读位置，凭据一次性用掉", async () => {
    await placeReadingChild();
    useAppStore.getState().setReadingTab("r_child", "steps");
    await useAppStore.getState().openCompareWithParent("r_child");
    // 比较期间把页签切走（模拟在比较页里的阅读流）
    useAppStore.getState().setReadingTab("r_child", "overview");

    await useAppStore.getState().returnFromCompare();
    const state = useAppStore.getState();
    expect(state.view).toBe("trace");
    expect(state.compareReturnLocation).toBeNull();
    // 阅读位置恢复为进入比较前记录的 steps
    expect(state.readingByRun.r_child?.tab).toBe("steps");
    // pair 与比较会话保留（返回来源不清它们——再次进入比较可继续）
    expect(state.comparePair).toEqual({ leftRunId: "r_parent", rightRunId: "r_child" });
  });

  it("打开单侧不清凭据：selectRun 离开比较 → 返回比较 → 来源引用仍在", async () => {
    await placeReadingChild();
    await useAppStore.getState().openCompareWithParent("r_child");
    expect(useAppStore.getState().compareReturnLocation).not.toBeNull();

    // 打开单侧（另一条运行）：离开比较视图
    await useAppStore.getState().selectRun("r_other");
    expect(useAppStore.getState().view).toBe("trace");
    expect(useAppStore.getState().compareReturnLocation).not.toBeNull();
    expect(useAppStore.getState().comparePair).toEqual({
      leftRunId: "r_parent",
      rightRunId: "r_child",
    });

    // 返回比较：视图切回、pair 保留、同集不重读
    const readsBefore = calls.filter((call) => call.startsWith("runs:compare")).length;
    useAppStore.getState().returnToCompare();
    expect(useAppStore.getState().view).toBe("compare");
    expect(useAppStore.getState().comparePair).toEqual({
      leftRunId: "r_parent",
      rightRunId: "r_child",
    });
    expect(calls.filter((call) => call.startsWith("runs:compare")).length).toBe(readsBefore);
  });

  it("经 setView 离开比较 = 来源引用用掉（与创建页同纪律）", async () => {
    await placeReadingChild();
    await useAppStore.getState().openCompareWithParent("r_child");
    expect(useAppStore.getState().compareReturnLocation).not.toBeNull();
    useAppStore.getState().setView("tree");
    expect(useAppStore.getState().compareReturnLocation).toBeNull();
  });

  it("无来源引用（重载后）返回 ⇒ 回退到轨迹视图，不伪造旧位置", async () => {
    useAppStore.setState({ view: "compare", compareReturnLocation: null });
    await useAppStore.getState().returnFromCompare();
    expect(useAppStore.getState().view).toBe("trace");
  });
});
