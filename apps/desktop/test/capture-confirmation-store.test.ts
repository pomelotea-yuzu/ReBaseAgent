import { ok } from "@shared/ipc";
import type { Envelope, ProxyState, WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { CallDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import { emptyConfirmationStore } from "../src/renderer/src/lib/execution-confirmation";
import { initialProxyFactCursor } from "../src/renderer/src/lib/proxy-changes";
import { initialProxyStatusReadState } from "../src/renderer/src/lib/proxy-status-read";
import { installOperationChannels } from "./helpers/operation-channels";
import { FAKE_PROXY_EPOCH, proxyStateFixture, proxyStatusOk } from "./helpers/proxy-state-fixture";

/**
 * tasks 2.2a 的**接线半边**：捕获/监听变化撤销已打开编辑器的执行确认。
 *
 * 判据来源：delta `desktop-ui`「重发门禁使用当前代理事实且隔离迟到读取」：
 * - 「捕获通知更新已打开编辑器」→ 外部首次捕获后，已 arm 的确认失效、门禁回读、
 *   草稿不变、**不自动重发**（`proxy:fork` 计数=0）；
 * - 「凭据轮换撤销旧确认」→ 捕获版本 / 监听 / 上游变化各自撤销；
 * - 「重复只读核对不撤销未变化的确认」→ 相同事实的回读不撤销、也不产生读取风暴。
 *
 * 纯判据在 `confirmation-binding-capture.test.ts`；本份只钉**接线**：通知 ⇒ 状态回读
 * ⇒ 指纹变化 ⇒ 现算比对判定失效（不靠"记得去清确认"）。
 */

const DRAFT_KEY: CallDraftKey = { runId: "r_01", spanId: "s_02", field: "messages" };
const BASELINE = '[{"role":"user","content":"hi"}]';

const calls: string[] = [];
const listeners: Array<(event: unknown) => void> = [];
let proxyStatusImpl: () => Promise<Envelope<ProxyState>> = () => Promise.resolve(proxyStatusOk());

const apiStub: Record<string, unknown> = {
  listRuns: async () => {
    calls.push("runs:list");
    return ok({ runs: [], failed: [] });
  },
  getRun: async () => ok(null),
  proxyStatus: async () => {
    calls.push("proxy:status");
    return proxyStatusImpl();
  },
  proxyToggle: async () => proxyStatusOk(),
  proxyFork: async () => {
    calls.push("proxy:fork");
    return { ok: false as const, error: { code: "UNUSED", message: "本用例不应提交" } };
  },
  onProxyChanged: (listener: (event: unknown) => void) => {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  },
};
installOperationChannels(apiStub);
(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");
const stateOf = () => useAppStore.getState();

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function emitChange(event: unknown): void {
  for (const listener of [...listeners]) listener(event);
}

/**
 * 代理在跑、已捕获 key 的现场。
 *
 * 🔴 `revision` 与 `keyCaptureRevision` **一起推进**，这不是偷懒而是main 的真实行为：
 * 每次捕获都同时推进两者（见 `ProxyManager` 的 `onAuthorizationCaptured`）。
 * 本文件第一版只推进捕获版本、把 `revision` 留在 0，于是通知声明 revision=9 而状态
 * 响应 revision=0 —— 快照新旧守卫**正确地**把这判成"迟到的旧快照"并整份丢弃，
 * 表现为"确认没被撤销"。教训：伪造 main 事实时必须让两个版本自洽，否则被守卫拦下
 * 的不是 bug 而是你自己造的矛盾。
 */
const live = (captureRevision: number, over: Partial<ProxyState> = {}): ProxyState =>
  proxyStateFixture({
    running: true,
    enabled: true,
    upstreamBaseUrl: "https://api.deepseek.com/v1",
    port: 18787,
    hasKey: true,
    keyCaptureRevision: captureRevision,
    // 与捕获版本同一个数字：main 每次捕获同时推进两者（`onAuthorizationCaptured`）。
    // 两者不一致的夹具会被 2.1 的快照守卫当成"迟到的旧快照"整份丢弃。
    revision: captureRevision,
    ...over,
  });

const statusCalls = (): number => calls.filter((c) => c === "proxy:status").length;
const forkCalls = (): number => calls.filter((c) => c === "proxy:fork").length;

/** 播种：草稿 + 已 arm 的确认（现场=代理在跑已捕获） */
function seedConfirmed(): void {
  stateOf().ensureCallDraft(DRAFT_KEY, BASELINE, {
    runId: DRAFT_KEY.runId,
    spanId: DRAFT_KEY.spanId,
    field: "messages",
    signature: "sig",
  } as never);
  stateOf().armExecutionConfirmation(stateOf().currentConfirmationBinding("messages", DRAFT_KEY));
}

const confirmed = (): boolean =>
  stateOf().executionConfirmationReady(stateOf().currentConfirmationBinding("messages", DRAFT_KEY));

beforeEach(() => {
  calls.length = 0;
  listeners.length = 0;
  stateOf().releaseProxyChangeSubscription();
  proxyStatusImpl = () => Promise.resolve(proxyStatusOk(live(7)));
  stateOf().ensureProxyChangeSubscription();
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
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: subLib.emptySubmissionStore(),
    confirmations: emptyConfirmationStore(),
    checkGenerations: {},
    view: "trace",
    messagesTarget: null,
    messagesSource: { phase: "idle", detail: null, errorMessage: null },
    recordingDraft: null,
    recordingStatusReadFailed: false,
    settings: {
      configured: true,
      encryption: "safe",
      baseURL: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    },
  } as never);
});

describe("2.2a 捕获通知更新已打开编辑器", () => {
  it("外部首次捕获 ⇒ 已 arm 的确认失效、门禁读到 hasKey=true、草稿不变、零自动重发", async () => {
    // 先以「未捕获」现场 arm 一次确认（旧 hasKey 缓存的等价物）
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk(live(0, { hasKey: false })));
    await stateOf().loadProxyStatus();
    seedConfirmed();
    expect(confirmed()).toBe(true);

    // 外部合法请求经过代理 ⇒ main 捕获凭据并发status 通知
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk(live(1, { hasKey: true })));
    emitChange({ epoch: FAKE_PROXY_EPOCH, revision: 1, recordsRevision: 0, changes: ["status"] });
    await settle();

    expect(stateOf().proxy?.hasKey).toBe(true);
    expect(confirmed()).toBe(false);
    // 草稿逐字保留，不因凭据变化清空
    expect(draftLib.callDraftOf(stateOf().drafts, DRAFT_KEY)?.text).toBe(BASELINE);
    // 绝不自动重发
    expect(forkCalls()).toBe(0);
  });

  it("凭据轮换（hasKey 仍为 true、捕获版本推进）⇒ 确认失效", async () => {
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk(live(5)));
    await stateOf().loadProxyStatus();
    seedConfirmed();
    expect(confirmed()).toBe(true);

    proxyStatusImpl = () => Promise.resolve(proxyStatusOk(live(6)));
    emitChange({ epoch: FAKE_PROXY_EPOCH, revision: 6, recordsRevision: 0, changes: ["status"] });
    await settle();

    expect(confirmed()).toBe(false);
    expect(forkCalls()).toBe(0);
  });

  it("监听停掉 / 上游换地址 ⇒ 确认各自失效", async () => {
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk(live(7)));
    await stateOf().loadProxyStatus();
    seedConfirmed();

    proxyStatusImpl = () => Promise.resolve(proxyStatusOk(live(8, { running: false })));
    emitChange({ epoch: FAKE_PROXY_EPOCH, revision: 8, recordsRevision: 0, changes: ["status"] });
    await settle();
    expect(confirmed()).toBe(false);

    // 重新确认后只换上游地址
    seedConfirmed();
    expect(confirmed()).toBe(true);
    proxyStatusImpl = () =>
      Promise.resolve(proxyStatusOk(live(9, { upstreamBaseUrl: "https://other.example.com/v1" })));
    emitChange({ epoch: FAKE_PROXY_EPOCH, revision: 9, recordsRevision: 0, changes: ["status"] });
    await settle();
    expect(confirmed()).toBe(false);
  });
});

describe("2.2a 重复只读核对不撤销未变化的确认", () => {
  it("相同语义状态与捕获版本的重复回读 ⇒ 确认保留、无额外副作用", async () => {
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk(live(7)));
    await stateOf().loadProxyStatus();
    seedConfirmed();
    expect(confirmed()).toBe(true);

    // 反复核对：同一组事实读三次
    for (let i = 0; i < 3; i += 1) await stateOf().reconcileProxyGate();

    expect(confirmed()).toBe(true);
    expect(forkCalls()).toBe(0);
    expect(stateOf().proxy?.keyCaptureRevision).toBe(7);
  });

  it("重复 arm 同一现场不换引用（不制造重绘风暴）", async () => {
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk(live(7)));
    await stateOf().loadProxyStatus();
    seedConfirmed();
    const before = stateOf().confirmations;
    stateOf().armExecutionConfirmation(stateOf().currentConfirmationBinding("messages", DRAFT_KEY));
    expect(stateOf().confirmations).toBe(before);
  });

  it("旧会话的通知不撤销当前确认（新 main 的事实为准）", async () => {
    proxyStatusImpl = () => Promise.resolve(proxyStatusOk(live(4)));
    await stateOf().loadProxyStatus();
    seedConfirmed();
    expect(confirmed()).toBe(true);

    // 上一届 main 的捕获通知：epoch 不同 ⇒ 整条丢弃
    emitChange({
      epoch: "proxy-epoch-STALE",
      revision: 99,
      recordsRevision: 0,
      changes: ["status"],
    });
    await settle();

    expect(confirmed()).toBe(true);
    expect(stateOf().proxy?.keyCaptureRevision).toBe(4);
  });
});
