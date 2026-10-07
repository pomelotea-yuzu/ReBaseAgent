import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunDetail, RunSummary, WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import { initialProxyFactCursor } from "../src/renderer/src/lib/proxy-changes";
import type { ProxyFactCursor } from "../src/renderer/src/lib/proxy-changes";
import { FAKE_PROXY_EPOCH, proxyStateFixture, proxyStatusOk } from "./helpers/proxy-state-fixture";

/**
 * tasks 1.4 的**接线半边**：`proxy:changed` 通知在真实 store 里的行为。
 *
 * 判据来源：tasks 1.3/1.4 + delta spec `desktop-ui`
 * 「被动代理录制自动更新列表并保留阅读」：
 * - 「空闲 main 的被动录制自动可见」→ 一条 records 通知 ⇒ 恰好一次列表刷新，当前阅读不跳转
 * - 「并发录制保留筛选和当前阅读」→ burst 合并成「一个在飞 + 一次尾随」，不清输入、不改筛选
 * - 「订阅前与失焦期间的变化可补读」→ 激活核对补刷；旧会话通知不覆盖当前事实
 * 以及 llm-proxy delta「代理变化通知不属于主动执行」在 renderer 侧的零请求证明。
 *
 * ⚠️ 全部经**真实 store 动作**驱动（`ensureProxyChangeSubscription` + `loadRuns` +
 *    `reconcileProxyFacts`），并直接向 store 注入通知载荷，不调 lib——
 *    判据在 lib 里绿不代表接上了消费点（工程约定「import 了但没消费 = 功能缺口」）。
 */

const EPOCH_A = FAKE_PROXY_EPOCH;
const EPOCH_B = "proxy-epoch-0002";

/** 记录所有对 main 的调用，用来证明"通知路径零自动请求" */
const calls: string[] = [];
/** 已捕获的通知监听器（由 onProxyChanged 注册；数组长度即当前订阅数） */
const listeners: Array<(event: unknown) => void> = [];
/** 由用例替换的 proxyStatus 应答（默认真实夹具） */
let proxyStatusImpl: () => Promise<Envelope<ReturnType<typeof proxyStateFixture>>> = () =>
  Promise.resolve(proxyStatusOk());
/** 由用例替换的 listRuns 应答 */
let listRunsImpl: () => Promise<Envelope<ListRunsData>> = () => {
  calls.push("runs:list");
  return Promise.resolve(ok({ runs: [], failed: [] }));
};
/** 由用例替换的 getRun 应答（选中 run 的详情） */
let getRunImpl: (id: string) => Promise<Envelope<RunDetail>> = () =>
  Promise.resolve({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } });

/** 详情桩：够过 RunDetailSchema 即可（只断言"详情不被覆盖"，不读内容） */
function detailOf(id: string): RunDetail {
  return {
    meta: {
      id,
      task: "t",
      started_at: "2026-10-07T00:00:00.000Z",
      isolation: {
        format_version: 2,
        profile: "file-tools-v1",
        world_id: id,
        write_authorized: true,
        initial_snapshot: "",
        origin: "local",
      },
    },
    spans: [],
    events: [],
    status: "completed",
    chain: [],
    leafSpanIds: [],
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  } as unknown as RunDetail;
}

/**
 * 合规的 run 摘要。
 *
 * ⚠️ `RunSummarySchema` 有 14 个必填字段（`model`/`parent`/`fork`/`toolCalls`/…），
 * 少一个就被 `ListRunsDataSchema.safeParse` **静默**拒掉——症状是 `runs` 变空、
 * `error` 里出现"列表数据结构校验失败"，离病因很远。故只在这里造一次。
 */
function runSummary(id: string): RunSummary {
  return {
    id,
    task: "外部录制",
    model: "deepseek-chat",
    created_at: "2026-10-07T00:00:00.000Z",
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
    source: "proxy",
  };
}

const apiStub: Record<string, unknown> = {
  listRuns: async () => listRunsImpl(),
  getRun: async (id: string) => {
    calls.push(`runs:get:${id}`);
    return getRunImpl(id);
  },
  operationsStatus: async () => {
    calls.push("operations:status");
    return ok({ epoch: "op-epoch", registryVersion: 1, operations: [] });
  },
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "NOT_STUBBED", message: "本桩未实现核对" },
  }),
  selectDirectory: async () => ok(null),
  forkRun: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  promptFork: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  proxyFork: async () => {
    calls.push("proxy:fork");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  createRun: async () => {
    calls.push("runs:create");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  modelAb: async () => {
    calls.push("model:ab");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  modelAbPlan: async () =>
    ok({ experimentId: "e", ids: [], ok: true, plan: [], sideEffectsAllowed: false }),
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
  proxyStatus: async () => {
    calls.push("proxy:status");
    return proxyStatusImpl();
  },
  proxyToggle: async () => proxyStatusOk(),
  onProxyChanged: (listener: (event: unknown) => void) => {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  },
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

/** 送一条通知给当前所有 store 监听器（模拟 main 的 webContents.send） */
function emitChange(event: unknown): void {
  for (const listener of [...listeners]) listener(event);
}

function changePayload(overrides?: Record<string, unknown>) {
  return { epoch: EPOCH_A, revision: 1, recordsRevision: 1, changes: ["records"], ...overrides };
}

/** 让所有挂起的微任务/已登记的补发落定 */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** 已订阅且读到初始状态（模拟 App 挂载序：先订阅后首读） */
async function subscribeAndRead(cursor?: ProxyFactCursor): Promise<void> {
  useAppStore.getState().ensureProxyChangeSubscription();
  if (cursor) useAppStore.setState({ proxyFactCursor: cursor });
  await useAppStore.getState().loadProxyStatus();
}

beforeEach(() => {
  calls.length = 0;
  // 上一支用例可能注册过监听器；每支都从"未订阅"开始（跨用例残留会污染计数断言）
  useAppStore.getState().releaseProxyChangeSubscription();
  listeners.length = 0;
  proxyStatusImpl = () => Promise.resolve(proxyStatusOk());
  listRunsImpl = () => {
    calls.push("runs:list");
    return Promise.resolve(ok({ runs: [], failed: [] }));
  };
  getRunImpl = () =>
    Promise.resolve({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } });
  useAppStore.setState({
    proxyFactCursor: initialProxyFactCursor,
    proxy: null,
    runs: [],
    failed: [],
    listLoaded: false,
    listStale: false,
    loadingList: false,
    listRefreshInFlight: 0,
    listRefreshPending: 0,
    error: null,
    sourceFilter: "all",
    searchQuery: "",
    selectedRunId: null,
    detail: null,
    readingByRun: {},
    recordingStatusReadFailed: false,
    view: "trace",
  });
});

describe("订阅幂等与生命周期清理", () => {
  it("重复 ensure 只注册一个监听器（StrictMode 双挂载不会让一次落盘刷两次）", () => {
    useAppStore.getState().ensureProxyChangeSubscription();
    useAppStore.getState().ensureProxyChangeSubscription();
    useAppStore.getState().ensureProxyChangeSubscription();
    expect(listeners).toHaveLength(1);
  });

  it("卸载即解绑：release 后再发通知不再触发任何读取，且可重新订阅", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 0, recordsRevision: 0 });
    useAppStore.getState().releaseProxyChangeSubscription();
    expect(listeners).toHaveLength(0);

    calls.length = 0;
    emitChange(changePayload({ revision: 5, recordsRevision: 5 }));
    await settle();
    expect(calls).toEqual([]);

    // 重新挂载后仍能收通知（否则第二次打开窗口就永久失去自动刷新）
    await subscribeAndRead({ epoch: EPOCH_A, revision: 5, recordsRevision: 5 });
    expect(listeners).toHaveLength(1);
    calls.length = 0;
    emitChange(changePayload({ revision: 6, recordsRevision: 6 }));
    await settle();
    expect(calls.filter((c) => c === "runs:list")).toHaveLength(1);
  });

  it("订阅动作本身零 IPC：只注册监听，不读状态也不读列表", () => {
    useAppStore.getState().ensureProxyChangeSubscription();
    expect(calls).toEqual([]);
  });
});

describe("空闲 main 的被动录制自动可见", () => {
  it("一条 records 通知 ⇒ 恰好一次列表刷新 + 一次状态回读", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 0, recordsRevision: 0 });
    calls.length = 0;

    emitChange(changePayload({ revision: 1, recordsRevision: 1 }));
    await settle();

    expect(calls.filter((c) => c === "runs:list")).toHaveLength(1);
    expect(calls.filter((c) => c === "proxy:status")).toHaveLength(1);
    expect(useAppStore.getState().proxyFactCursor).toEqual({
      epoch: EPOCH_A,
      revision: 1,
      recordsRevision: 1,
    });
  });

  it("刷新不自动跳到被动记录：选中项、详情、筛选、搜索词原样", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 0, recordsRevision: 0 });
    useAppStore.setState({
      selectedRunId: "run_reading",
      detail: detailOf("run_reading"),
      sourceFilter: "proxy",
      searchQuery: "关键词",
      readingByRun: { run_reading: { spanId: "s_01" } },
    } as never);
    calls.length = 0;

    emitChange(changePayload({ revision: 1, recordsRevision: 1 }));
    await settle();

    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe("run_reading");
    expect(state.detail?.meta.id).toBe("run_reading");
    expect(state.sourceFilter).toBe("proxy");
    expect(state.searchQuery).toBe("关键词");
    expect(state.readingByRun.run_reading).toEqual({ spanId: "s_01" });
  });

  it("列表刷新失败沿用旧列表：只标未更新，不清空已有记录与阅读位置", async () => {
    // ⚠️ 前置条件：必须先有一次**成功加载**——`resolveRefreshFailure` 的口径是
    // "有过成功加载才标未更新"（首次失败本来就没有可过期的数据）
    await useAppStore.getState().loadRuns();
    await subscribeAndRead({ epoch: EPOCH_A, revision: 0, recordsRevision: 0 });
    useAppStore.setState({ runs: [runSummary("run_old")] } as never);
    listRunsImpl = () => {
      calls.push("runs:list");
      return Promise.resolve({
        ok: false as const,
        error: { code: "DISK", message: "磁盘不可读" },
      });
    };

    emitChange(changePayload({ revision: 1, recordsRevision: 1 }));
    await settle();

    const state = useAppStore.getState();
    expect(state.runs).toHaveLength(1);
    expect(state.listStale).toBe(true);
    expect(state.error).toContain("仍显示上次结果");
  });
});

describe("并发录制：burst 合并成「一个在飞 + 一次尾随」", () => {
  it("在飞期间的 N 条通知 ⇒ 至多一个在飞 + 一次尾随，最终可见全部新 ID", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 0, recordsRevision: 0 });
    // 让列表读取卡住，模拟"多个请求在列表读取在飞期间落盘"
    let releaseList: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listCalls = 0;
    listRunsImpl = async () => {
      listCalls += 1;
      calls.push("runs:list");
      if (listCalls === 1) await gate;
      return ok({
        runs: Array.from({ length: 3 }, (_, i) => runSummary(`run_new_${i}`)),
        failed: [],
      });
    };

    const first = useAppStore.getState().loadRuns();
    await settle();
    // 三条落盘通知在第一次读取在飞时陆续到达
    emitChange(changePayload({ revision: 1, recordsRevision: 1 }));
    emitChange(changePayload({ revision: 2, recordsRevision: 2 }));
    emitChange(changePayload({ revision: 3, recordsRevision: 3 }));
    await settle();
    // 不做 N 次全量读取：在飞计数被压住
    expect(listCalls).toBe(1);

    releaseList?.();
    await first;
    await settle();

    // 尾随补发把全部新 ID 带进来（不是只有最后一条通知对应的那一个）
    expect(listCalls).toBe(2);
    expect(useAppStore.getState().runs.map((r) => r.id)).toEqual([
      "run_new_0",
      "run_new_1",
      "run_new_2",
    ]);
    expect(useAppStore.getState().proxyFactCursor).toEqual({
      epoch: EPOCH_A,
      revision: 3,
      recordsRevision: 3,
    });
  });

  it("重复投递同一条落盘事实（recordsRevision 未前进）⇒ 不刷列表", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 2, recordsRevision: 2 });
    calls.length = 0;

    // 两条**逐字相同**的通知：游标在发起读取前已推进到 revision 3，
    // 故两条都不含新的落盘事实 ⇒ 一次列表读取都不该发生
    emitChange(changePayload({ revision: 3, recordsRevision: 2 }));
    emitChange(changePayload({ revision: 3, recordsRevision: 2 }));
    await settle();

    expect(calls.filter((c) => c === "runs:list")).toHaveLength(0);
    // 状态回读允许发生（凭据可能同时变了）：它是廉价只读，且规则 3 只禁止回退游标，
    // 不禁止重复确认状态。**不**把它断言成"恰好 1 次"——那是实现细节，不是判据。
    expect(calls.filter((c) => c === "proxy:status").length).toBeGreaterThanOrEqual(1);
  });

  it("同会话内乱序：落后通知既不刷列表也不回退游标", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 5, recordsRevision: 5 });
    calls.length = 0;

    emitChange(changePayload({ revision: 3, recordsRevision: 3 }));
    await settle();

    expect(calls).toEqual([]);
    expect(useAppStore.getState().proxyFactCursor).toEqual({
      epoch: EPOCH_A,
      revision: 5,
      recordsRevision: 5,
    });
  });
});

describe("旧会话通知不得覆盖当前事实", () => {
  it("epoch 不同的通知 ⇒ 零读取、游标不动", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 4, recordsRevision: 4 });
    calls.length = 0;

    emitChange(changePayload({ epoch: EPOCH_B, revision: 99, recordsRevision: 99 }));
    await settle();

    expect(calls).toEqual([]);
    expect(useAppStore.getState().proxyFactCursor).toEqual({
      epoch: EPOCH_A,
      revision: 4,
      recordsRevision: 4,
    });
  });

  it("非法载荷整条丢弃：缺字段 / 未知类别都不触发读取，也不改游标", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 2, recordsRevision: 2 });
    calls.length = 0;

    // 缺 recordsRevision（曾真实发生过的形状漂移）
    emitChange({ epoch: EPOCH_A, revision: 3, changes: ["records"] });
    // 未知类别
    emitChange({ epoch: EPOCH_A, revision: 3, recordsRevision: 3, changes: ["credentials"] });
    // 空类别
    emitChange({ epoch: EPOCH_A, revision: 3, recordsRevision: 3, changes: [] });
    await settle();

    expect(calls).toEqual([]);
    expect(useAppStore.getState().proxyFactCursor).toEqual({
      epoch: EPOCH_A,
      revision: 2,
      recordsRevision: 2,
    });
  });

  it("迟到的 proxyStatus 旧响应不得把游标拉回旧版本（乱序守卫跨通道生效）", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 6, recordsRevision: 6 });
    // 让状态读取卡住，期间来一条新通知推进到 8
    let releaseStatus: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    proxyStatusImpl = async () => {
      await gate;
      return proxyStatusOk({ revision: 1, recordsRevision: 0 });
    };

    const staleRead = useAppStore.getState().loadProxyStatus();
    await settle();
    emitChange(changePayload({ revision: 8, recordsRevision: 8 }));
    await settle();
    releaseStatus?.();
    await staleRead;
    await settle();

    expect(useAppStore.getState().proxyFactCursor.revision).toBe(8);
    expect(useAppStore.getState().proxyFactCursor.recordsRevision).toBe(8);
  });
});

describe("失焦恢复：只读核对补齐漏掉的落盘", () => {
  it("失焦期间有新 run 落盘 ⇒ 激活核对补刷列表", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 1, recordsRevision: 1 });
    listRunsImpl = () => {
      calls.push("runs:list");
      return Promise.resolve(ok({ runs: [runSummary("run_missed")], failed: [] }));
    };
    // 模拟 main 在失焦期间推进到 3（renderer 没收到通知）
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk({ revision: 3, recordsRevision: 3 }));

    calls.length = 0;
    await useAppStore.getState().reconcileProxyFacts();

    expect(calls.filter((c) => c === "proxy:status")).toHaveLength(1);
    expect(calls.filter((c) => c === "runs:list")).toHaveLength(1);
    expect(useAppStore.getState().runs.map((r) => r.id)).toEqual(["run_missed"]);
  });

  it("没有新变化 ⇒ 只读一次状态，不刷列表（每次点回窗口都白读全量 traces 不可接受）", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 1, recordsRevision: 1 });
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk({ revision: 1, recordsRevision: 1 }));

    calls.length = 0;
    await useAppStore.getState().reconcileProxyFacts();

    expect(calls.filter((c) => c === "proxy:status")).toHaveLength(1);
    expect(calls.filter((c) => c === "runs:list")).toHaveLength(0);
  });

  it("状态读取失败 ⇒ 保守补刷（状态未知时不能断言没有变化）", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 1, recordsRevision: 1 });
    proxyStatusImpl = () =>
      Promise.resolve({ ok: false as const, error: { code: "ENOENT", message: "读不到" } });

    calls.length = 0;
    await useAppStore.getState().reconcileProxyFacts();

    expect(calls.filter((c) => c === "runs:list")).toHaveLength(1);
    // 读取失败时游标不前进，也如实标出"状态待读取"
    expect(useAppStore.getState().proxyFactCursor).toEqual({
      epoch: EPOCH_A,
      revision: 1,
      recordsRevision: 1,
    });
    expect(useAppStore.getState().recordingStatusReadFailed).toBe(true);
  });

  it("凭据捕获（status 类别）不刷列表，只更新状态门禁事实", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 1, recordsRevision: 1 });
    proxyStatusImpl = () =>
      Promise.resolve(proxyStatusOk({ hasKey: true, revision: 2, recordsRevision: 1 }));
    calls.length = 0;

    emitChange(changePayload({ revision: 2, recordsRevision: 1, changes: ["status"] }));
    await settle();

    expect(calls.filter((c) => c === "runs:list")).toHaveLength(0);
    expect(useAppStore.getState().proxy?.hasKey).toBe(true);
  });
});

describe("零主动登记 / 零自动请求（llm-proxy delta 的 renderer 半边）", () => {
  it("订阅 + N 条通知 ⇒ 不碰 operations:status / proxy:fork / runs:create / model:ab", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 0, recordsRevision: 0 });
    calls.length = 0;

    emitChange(changePayload({ revision: 1, recordsRevision: 1 }));
    emitChange(changePayload({ revision: 2, recordsRevision: 2, changes: ["status"] }));
    emitChange(changePayload({ revision: 3, recordsRevision: 3 }));
    await settle();
    await useAppStore.getState().reconcileProxyFacts();
    await settle();

    expect(calls.filter((c) => c === "proxy:fork")).toHaveLength(0);
    expect(calls.filter((c) => c === "runs:create")).toHaveLength(0);
    expect(calls.filter((c) => c === "model:ab")).toHaveLength(0);
    // 只允许两种只读通道
    const allowed = new Set(["runs:list", "proxy:status"]);
    expect(calls.filter((c) => !allowed.has(c))).toEqual([]);
  });

  it("通知不改动 operation 会话：被动录制不占执行槽、不进登记表", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 0, recordsRevision: 0 });
    const before = useAppStore.getState().operations;

    emitChange(changePayload({ revision: 1, recordsRevision: 1 }));
    emitChange(changePayload({ revision: 2, recordsRevision: 2 }));
    await settle();

    expect(useAppStore.getState().operations).toBe(before);
  });
});

describe("刷新失败与游标推进的交互", () => {
  it("列表读取失败后游标已推进：重投同一条通知不会再次刷列表（靠游标而非重试计数）", async () => {
    // 前置：一次成功加载（否则失败不标 stale，测的就不是"沿用旧列表"了）
    await useAppStore.getState().loadRuns();
    await subscribeAndRead({ epoch: EPOCH_A, revision: 0, recordsRevision: 0 });
    listRunsImpl = () => {
      calls.push("runs:list");
      return Promise.resolve({
        ok: false as const,
        error: { code: "DISK", message: "磁盘不可读" },
      });
    };
    emitChange(changePayload({ revision: 1, recordsRevision: 1 }));
    await settle();
    expect(useAppStore.getState().listStale).toBe(true);

    calls.length = 0;
    emitChange(changePayload({ revision: 1, recordsRevision: 1 }));
    await settle();
    // 游标在读取**之前**推进，所以同一条通知不会把失败的读取再来一遍；
    // 需要重试时走既有的只读重试入口（spec：刷新失败沿用旧列表未更新提示与只读重试）
    expect(calls.filter((c) => c === "runs:list")).toHaveLength(0);
  });

  it("status 载荷过不了 schema ⇒ proxy 置 null 且游标不前进", async () => {
    await subscribeAndRead({ epoch: EPOCH_A, revision: 2, recordsRevision: 2 });
    // 真实的形状漂移：main 少给一个版本字段
    proxyStatusImpl = () =>
      Promise.resolve(
        ok({ ...proxyStateFixture(), revision: undefined } as unknown as ReturnType<
          typeof proxyStateFixture
        >),
      );

    await useAppStore.getState().loadProxyStatus();

    const state = useAppStore.getState();
    expect(state.proxy).toBeNull();
    expect(state.error).toContain("校验失败");
    expect(state.proxyFactCursor).toEqual({ epoch: EPOCH_A, revision: 2, recordsRevision: 2 });
  });
});
