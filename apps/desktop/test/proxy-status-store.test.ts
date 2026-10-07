import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunSummary, WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import { initialProxyFactCursor } from "../src/renderer/src/lib/proxy-changes";
import { initialProxyStatusReadState } from "../src/renderer/src/lib/proxy-status-read";
import { FAKE_PROXY_EPOCH, proxyStateFixture, proxyStatusOk } from "./helpers/proxy-state-fixture";

/**
 * tasks 2.1 的**接线半边**：状态读取的合并、两条守卫与 messages 打开核对。
 *
 * 判据来源：delta spec `desktop-ui`「重发门禁使用当前代理事实且隔离迟到读取」：
 * - 「打开重发即核对当前状态」→ 打开 messages 即发一次只读核对，不必去录制页手动重读；
 * - 「迟到读取不能覆盖新事实」→ 旧快照（以及**迟到的失败**）不得覆盖后来成功读到的事实；
 * - 「重复只读核对不撤销未变化的确认」→ 相同事实的重复读取不产生额外副作用。
 *
 * ⚠️ 全部经**真实 store 动作**驱动（`openMessagesWorkspace` / `loadProxyStatus` /
 *    `reconcileProxyFacts`），不直接调 lib——判据在 lib 里绿不代表接上了消费点。
 */

const EPOCH_A = FAKE_PROXY_EPOCH;

const calls: string[] = [];
const listeners: Array<(event: unknown) => void> = [];

let proxyStatusImpl: () => Promise<Envelope<ReturnType<typeof proxyStateFixture>>> = () =>
  Promise.resolve(proxyStatusOk());
/** 由用例替换的 `runs:list` 应答（默认真空列表） */
let listRunsImpl: () => Promise<Envelope<ListRunsData>> = () =>
  Promise.resolve(ok({ runs: [], failed: [] } satisfies ListRunsData));

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
  listRuns: async () => {
    calls.push("runs:list");
    return listRunsImpl();
  },
  getRun: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  operationsStatus: async () => ok({ epoch: "op-epoch", registryVersion: 1, operations: [] }),
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
  createRun: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  modelAb: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
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

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function emitChange(event: unknown): void {
  for (const listener of [...listeners]) listener(event);
}

function changePayload(overrides?: Record<string, unknown>) {
  return { epoch: EPOCH_A, revision: 1, recordsRevision: 1, changes: ["records"], ...overrides };
}

const statusCalls = (): number => calls.filter((c) => c === "proxy:status").length;
const listCalls = (): number => calls.filter((c) => c === "runs:list").length;

/**
 * 让**此后**发出的状态读取卡住，返回释放句柄（用于构造"响应乱序"）。
 *
 * ⚠️ 必须在本用例**最后**设置完 `proxyStatusImpl` 之后再调用：本函数捕获当前实现并
 * 换成一个等待闸门的包装器。顺序反了会把包装器连同它捕获的旧实现一起覆盖掉。
 */
function stallStatus(): { release: () => void } {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = proxyStatusImpl;
  proxyStatusImpl = async () => {
    await gate;
    return inner();
  };
  return { release: () => release?.() };
}

// returnToAuxSource 用 requestAnimationFrame 回焦（U8 6.11）；本文件是裸 node 环境，
// 给**永不触发**的桩只为不抛 ReferenceError——回调不执行，导航判据不受影响。
(globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame ??=
  () => 0;

beforeEach(() => {
  calls.length = 0;
  useAppStore.getState().releaseProxyChangeSubscription();
  listeners.length = 0;
  proxyStatusImpl = () => Promise.resolve(proxyStatusOk());
  listRunsImpl = () => Promise.resolve(ok({ runs: [], failed: [] } satisfies ListRunsData));
  useAppStore.setState({
    proxyFactCursor: initialProxyFactCursor,
    proxyStatusRead: initialProxyStatusReadState,
    proxyReadGeneration: 0,
    proxy: null,
    runs: [],
    failed: [],
    listLoaded: false,
    listRefreshInFlight: 0,
    listRefreshPending: 0,
    error: null,
    sourceFilter: "all",
    searchQuery: "",
    selectedRunId: null,
    detail: null,
    view: "trace",
    messagesTarget: null,
    messagesSource: { phase: "idle", detail: null, errorMessage: null },
    recordingDraft: null,
    recordingStatusReadFailed: false,
  } as never);
});

describe("打开重发即核对当前状态", () => {
  it("openMessagesWorkspace 立刻发一次只读核对：store 里的旧 hasKey=false 被真实事实替换", async () => {
    // main 已捕获凭据且代理在跑，但 store 仍停在"未捕获"（用户还没打开过编辑器）
    proxyStatusImpl = () =>
      Promise.resolve(proxyStatusOk({ running: true, hasKey: true, revision: 3 }));
    useAppStore.getState().ensureProxyChangeSubscription();
    await useAppStore.getState().loadProxyStatus();
    expect(useAppStore.getState().proxy?.hasKey).toBe(true);
    calls.length = 0;

    useAppStore.getState().openMessagesWorkspace({ runId: "r_proxy01", spanId: "s_01" });
    await settle();

    expect(statusCalls()).toBe(1);
    expect(useAppStore.getState().view).toBe("messages");
    // 只读：不刷列表、不碰任何主动通道
    expect(listCalls()).toBe(0);
    expect(calls.filter((c) => c === "proxy:fork")).toHaveLength(0);
  });

  it("已在 messages 页时换目标也核对一次（目标变化同样是核对时机）", async () => {
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk({ running: true, revision: 2 }));
    useAppStore.getState().openMessagesWorkspace({ runId: "r1", spanId: "s1" });
    await settle();
    calls.length = 0;

    useAppStore.getState().openMessagesWorkspace({ runId: "r2", spanId: "s2" });
    await settle();

    expect(statusCalls()).toBe(1);
    expect(useAppStore.getState().messagesTarget).toEqual({ runId: "r2", spanId: "s2" });
  });

  it("从录制页返回 messages ⇒ 核对刚应用的启停/凭据事实（不必手动重读）", async () => {
    // 先在 messages 页进入录制页（来源记为 messages），应用配置后返回
    useAppStore.setState({ view: "trace", runs: [runSummary("r1")] } as never);
    useAppStore.getState().openMessagesWorkspace({ runId: "r1", spanId: "s1" });
    await settle();
    useAppStore.getState().openRecordingWorkspace();
    await settle();
    // 录制页里刚把代理启用并跑过一次（hasKey 捕获）
    proxyStatusImpl = () =>
      Promise.resolve(proxyStatusOk({ running: true, hasKey: true, enabled: true, revision: 5 }));
    useAppStore.setState({
      proxy: proxyStateFixture({ running: false, hasKey: false, revision: 1 }),
    } as never);
    calls.length = 0;

    await useAppStore.getState().returnToAuxSource("recording");
    await settle();

    expect(useAppStore.getState().view).toBe("messages");
    expect(statusCalls()).toBe(1);
    // 刚应用的启停与凭据进入门禁，不必再去录制页手动重读
    expect(useAppStore.getState().proxy?.hasKey).toBe(true);
    expect(listCalls()).toBe(0);
  });

  it("返回到非 messages 视图时不白读状态（落到 trace 时读状态是浪费）", async () => {
    useAppStore.setState({ view: "trace", runs: [runSummary("r1")] } as never);
    useAppStore.getState().openRecordingWorkspace();
    await settle();
    calls.length = 0;

    await useAppStore.getState().returnToAuxSource("recording");
    await settle();

    expect(useAppStore.getState().view).toBe("trace");
    expect(statusCalls()).toBe(0);
  });

  it("reconcileProxyGate 等静默：读取在飞时调用也不会拿到「什么都没读到」就返回", async () => {
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk({ revision: 4, recordsRevision: 4 }));
    const stall = stallStatus();
    useAppStore.setState({ proxy: proxyStateFixture({ revision: 1 }) } as never);

    const reading = useAppStore.getState().reconcileProxyGate();
    await settle();
    // 在飞期间再要一次核对（会被合并成尾随并立即返回的那次调用）
    const merged = useAppStore.getState().reconcileProxyGate();
    await settle();
    expect(statusCalls()).toBe(1);

    stall.release();
    await reading;
    await merged;
    await settle();

    // 补发已发生，最终事实是较新的那份
    expect(statusCalls()).toBe(2);
    expect(useAppStore.getState().proxyFactCursor.revision).toBe(4);
    expect(useAppStore.getState().proxyStatusRead.inFlight).toBe(0);
  });
});

describe("迟到读取不能覆盖新事实", () => {
  it("较旧快照整份丢弃：proxy 不被写回、游标不动", async () => {
    useAppStore.setState({
      proxyFactCursor: { epoch: EPOCH_A, revision: 6, recordsRevision: 6 },
      proxy: proxyStateFixture({ revision: 6, hasKey: true }),
    } as never);
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk({ revision: 2, hasKey: false }));

    await useAppStore.getState().loadProxyStatus();

    const state = useAppStore.getState();
    expect(state.proxy?.hasKey).toBe(true);
    expect(state.proxy?.revision).toBe(6);
    expect(state.proxyFactCursor).toEqual({ epoch: EPOCH_A, revision: 6, recordsRevision: 6 });
  });

  it("迟到的失败响应不得把后来成功读到的事实清成「状态待读取」", async () => {
    // 先成功读到 revision 5（hasKey=true）
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk({ revision: 5, hasKey: true }));
    await useAppStore.getState().loadProxyStatus();
    expect(useAppStore.getState().proxy?.hasKey).toBe(true);

    // 制造"旧请求的失败响应晚于新成功响应"的形状：先发一次注定失败的读取，
    // 飞行中再发一次（被合并成尾随）并让它成功。
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let seq = 0;
    proxyStatusImpl = async () => {
      seq += 1;
      if (seq === 1) {
        await gate;
        return { ok: false as const, error: { code: "ENOENT", message: "读不到" } };
      }
      return proxyStatusOk({ revision: 6, hasKey: true });
    };

    const stale = useAppStore.getState().loadProxyStatus();
    await settle();
    const fresh = useAppStore.getState().loadProxyStatus();
    await settle();
    releaseFirst?.();
    await stale;
    await fresh;
    await settle();

    const state = useAppStore.getState();
    // 关键：事实停在较新的成功读取上，没有被先发那次失败清掉
    expect(state.proxy?.hasKey).toBe(true);
    expect(state.recordingStatusReadFailed).toBe(false);
    expect(state.proxyFactCursor.revision).toBe(6);
  });

  it("飞行中的旧响应不采纳，补发读到的新事实落地", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seq = 0;
    proxyStatusImpl = async () => {
      seq += 1;
      if (seq === 1) {
        await gate;
        return proxyStatusOk({ revision: 2, hasKey: false });
      }
      return proxyStatusOk({ revision: 9, recordsRevision: 9, hasKey: true });
    };

    const first = useAppStore.getState().loadProxyStatus();
    await settle();
    useAppStore.getState().loadProxyStatus();
    await settle();
    release?.();
    await first;
    await settle();

    expect(useAppStore.getState().proxy?.hasKey).toBe(true);
    expect(useAppStore.getState().proxyFactCursor.recordsRevision).toBe(9);
    expect(useAppStore.getState().proxyStatusRead).toEqual({
      inFlight: 0,
      pending: 0,
      generation: 2,
    });
  });

  it("读取期间表达「核对中」，收尾后消失（UI 不谎报未捕获、也不闪恐吓话）", async () => {
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk({ revision: 2, hasKey: true }));
    const stall = stallStatus();
    const reading = useAppStore.getState().loadProxyStatus();
    await settle();
    expect(useAppStore.getState().proxyStatusRead.inFlight).toBe(1);

    stall.release();
    await reading;
    await settle();
    expect(useAppStore.getState().proxyStatusRead.inFlight).toBe(0);
  });

  it("读取失败仍如实标「状态待读取」并清 proxy（守卫不放过期，当前代次的失败照旧生效）", async () => {
    useAppStore.setState({ proxy: proxyStateFixture({ revision: 1 }) } as never);
    proxyStatusImpl = () =>
      Promise.resolve({ ok: false as const, error: { code: "ENOENT", message: "读不到" } });

    await useAppStore.getState().loadProxyStatus();

    expect(useAppStore.getState().proxy).toBeNull();
    expect(useAppStore.getState().recordingStatusReadFailed).toBe(true);
    expect(useAppStore.getState().proxyStatusRead.inFlight).toBe(0);
  });

  it("通道本身抛错（api.proxyStatus 不存在/抛异常）⇒ 走同一条失败路径，不产生未处理拒绝", async () => {
    // 这不是假想：`openMessagesWorkspace` / `returnToAuxSource` 以 `void` 方式发起读取，
    // 异常一旦抛出去就是未处理拒绝——没有可重试入口，也没人看得见。
    // 实测坐实：aux-workspace-store 的 api 桩没有 proxyStatus，8 处未处理错误全来自这条路径。
    useAppStore.setState({ proxy: proxyStateFixture({ revision: 1 }) } as never);
    proxyStatusImpl = () => Promise.reject(new Error("proxyStatus is not a function"));

    await expect(useAppStore.getState().loadProxyStatus()).resolves.toBeUndefined();

    const state = useAppStore.getState();
    expect(state.recordingStatusReadFailed).toBe(true);
    expect(state.error).toContain("proxyStatus is not a function");
    // 计数必须已收尾，否则此后所有读取都会被"合并"成尾随而永不发射
    expect(state.proxyStatusRead).toEqual({ inFlight: 0, pending: 0, generation: 1 });

    // 通道恢复后下一次读取照旧工作（失败不是粘住的）
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk({ running: true, revision: 2 }));
    await useAppStore.getState().loadProxyStatus();
    expect(useAppStore.getState().proxy?.running).toBe(true);
    expect(useAppStore.getState().recordingStatusReadFailed).toBe(false);
  });
});

describe("通知 / 失焦路径与合并的交互", () => {
  it("burst 通知 ⇒ 状态读取至多「一个在飞 + 一次尾随」，且不刷多余列表", async () => {
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk({ revision: 3, recordsRevision: 3 }));
    const stall = stallStatus();
    useAppStore.getState().ensureProxyChangeSubscription();
    useAppStore.setState({
      proxyFactCursor: { epoch: EPOCH_A, revision: 0, recordsRevision: 0 },
    } as never);
    calls.length = 0;

    emitChange(changePayload({ revision: 1, recordsRevision: 1 }));
    emitChange(changePayload({ revision: 2, recordsRevision: 2 }));
    emitChange(changePayload({ revision: 3, recordsRevision: 3 }));
    await settle();

    // 第一条通知已发射读取并卡住；后两条只登记尾随 ⇒ 状态读取仍是「一个在飞」。
    // ⚠️ 这里刻意**不**断言列表读取次数：状态读取被 stall 住而列表读取立即完成，
    // 三条通知各自触发一次列表读取是 §1 既有语义（游标已推进、合并只在"在飞"时生效），
    // 与 2.1 无关。状态侧收敛为 1+1 才是本条要钉的东西。
    expect(statusCalls()).toBe(1);

    stall.release();
    await settle();
    await settle();

    // 尾随补发恰好一次
    expect(statusCalls()).toBe(2);
  });

  it("失焦补读：被合并时也等到静默再判据（状态未知 ⇒ 保守补刷列表）", async () => {
    const stall = stallStatus();
    useAppStore.setState({
      proxyFactCursor: { epoch: EPOCH_A, revision: 1, recordsRevision: 1 },
      proxy: proxyStateFixture({ revision: 1, recordsRevision: 1 }),
    } as never);
    proxyStatusImpl = () =>
      Promise.resolve({ ok: false as const, error: { code: "ENOENT", message: "读不到" } });
    calls.length = 0;

    const reconciling = useAppStore.getState().reconcileProxyFacts();
    await settle();
    // 补读在飞期间窗口又被激活一次（合并成尾随并立即返回的那条路径）
    void useAppStore.getState().reconcileProxyFacts();
    await settle();

    stall.release();
    await reconciling;
    await settle();

    // 两次激活都没读到事实 ⇒ 保守补刷（把"没读到"当成"没有变化"才是原来的 bug）
    expect(listCalls()).toBeGreaterThanOrEqual(1);
    expect(useAppStore.getState().recordingStatusReadFailed).toBe(true);
    expect(useAppStore.getState().proxyStatusRead.inFlight).toBe(0);
  });

  it("状态读取计数与列表读取计数互不影响（守卫锚点不同，合并不许串味）", async () => {
    // 列表在飞时，状态读取仍必须能发射（否则代理门禁会被列表刷新拖住）
    let releaseList: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    listRunsImpl = async () => {
      calls.push("runs:list");
      await gate;
      return ok({ runs: [], failed: [] } satisfies ListRunsData);
    };

    const listing = useAppStore.getState().loadRuns();
    await settle();
    expect(useAppStore.getState().listRefreshInFlight).toBe(1);

    await useAppStore.getState().loadProxyStatus();
    expect(statusCalls()).toBe(1);
    // 列表在飞不影响状态读取发射，也不被状态读取的收尾清掉
    expect(useAppStore.getState().listRefreshInFlight).toBe(1);
    expect(useAppStore.getState().proxyStatusRead.inFlight).toBe(0);

    releaseList?.();
    await listing;
    expect(useAppStore.getState().listRefreshInFlight).toBe(0);
  });
});

describe("重复只读核对不撤销未变化的确认（2.2a 的前置）", () => {
  it("相同事实的重复读取：门禁事实与确认绑定都稳定，不产生额外副作用", async () => {
    proxyStatusImpl = () =>
      Promise.resolve(proxyStatusOk({ running: true, hasKey: true, revision: 2 }));
    useAppStore.getState().ensureProxyChangeSubscription();
    await useAppStore.getState().loadProxyStatus();
    useAppStore.setState({ settings: { configured: true, model: "m", baseURL: null } } as never);
    const target = { runId: "r1", spanId: "s1", field: "messages" } as const;
    const binding = useAppStore.getState().currentConfirmationBinding("messages", target);
    const genAfterFirst = useAppStore.getState().proxyReadGeneration;

    await useAppStore.getState().reconcileProxyGate();
    await useAppStore.getState().reconcileProxyGate();

    // ⚠️ 判据是**确认绑定**而不是 `proxy` 对象引用：`loadProxyStatus` 每次都写一份
    // 新对象（这是对的——载荷整体替换），但只要语义事实逐字相同，确认就必须继续有效。
    const after = useAppStore.getState().currentConfirmationBinding("messages", target);
    expect(after.settingsStamp).toBe(binding.settingsStamp);
    expect(after.revision).toBe(binding.revision);
    expect(after.generation).toBe(binding.generation);
    expect(useAppStore.getState().executionConfirmationReady(after)).toBe(
      useAppStore.getState().executionConfirmationReady(binding),
    );
    // 代次确实推进了（它是守卫锚点），但不参与确认绑定
    expect(useAppStore.getState().proxyReadGeneration).toBe(genAfterFirst + 2);
    expect(calls.filter((c) => c === "proxy:fork")).toHaveLength(0);
  });
});
