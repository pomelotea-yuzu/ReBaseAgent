import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, RunDetail, WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import { isCurrentDetailAttempt } from "../src/shared/detail-request";
import { statusSnapshot } from "./helpers/operation-channels";

/**
 * U6（add-partial-run-reading）任务 4.5：详情刷新的 run ID / 读取代次 / 导航守卫。
 *
 * 对应 delta 场景：
 *   - 「读取重试不改变阅读位置」：重试在飞期间切换步骤/页签/运行 ⇒ 旧响应不覆盖新位置；
 *     恢复后的详情只应用到发起请求的 run ID，不抢焦点、不自动导航；
 *   - 「父文件恢复后重试全量重验」：恢复前的 ownOnly 旧响应**后到**时不得把
 *     恢复后的 complete 详情盖回去（同 run 连续重试的代次判别）。
 *
 * ⚠️ 全部经**真实 store 动作**驱动（`selectRun` / `reopenRun` / `selectSpan`）；
 *    归属判据（U1 3.3）挡不住同 run 重试，代次判据（`isCurrentDetailAttempt`）
 *    是 U6 新增——两条用例分别钉"位置不被覆盖"与"旧结论不覆盖新结论"。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");

/** 读真实 fixture 改 id：meta/schema 合法，spans 含 s_02/s_05/s_08 三个自有 llm.call */
function detailNamed(id: string, overrides: Partial<RunDetail> = {}): RunDetail {
  const record: RunRecord = readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl"));
  const meta = { ...record.meta, id };
  return {
    meta,
    spans: record.spans,
    events: record.events,
    status: record.status,
    chain: [{ meta, fork: null }],
    leafSpanIds: record.spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
    ...overrides,
  };
}

// ---- 可切换的 getRun 桩：canned 立即返回；deferred 排队等用例放行 ----
type Resolve = (envelope: Envelope<RunDetail>) => void;
let getRunImpl: (id: string) => Promise<Envelope<RunDetail>> = async () => {
  throw new Error("用例未设置 getRun 桩");
};
const pending: Resolve[] = [];
const calls: string[] = [];

const apiStub: Record<string, unknown> = {
  listRuns: async () => ok({ runs: [], failed: [] }),
  getRun: (id: string) => getRunImpl(id),
  operationsStatus: async () => ok(statusSnapshot()),
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "NOT_STUBBED", message: "本桩未实现核对" },
  }),
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

function useCanned(details: Record<string, Envelope<RunDetail>>) {
  getRunImpl = async (id: string) => {
    calls.push(`runs:get:${id}`);
    return details[id] ?? ok(detailNamed(id));
  };
}

function useDeferred() {
  getRunImpl = (id: string) => {
    calls.push(`runs:get:${id}`);
    return new Promise<Envelope<RunDetail>>((resolvePromise) => {
      pending.push(resolvePromise);
    });
  };
}

/** 按队列顺序放行一个挂起的详情请求 */
function respond(envelope: Envelope<RunDetail>): void {
  const resolveFn = pending.shift();
  if (resolveFn === undefined) throw new Error("没有挂起的详情请求可放行");
  resolveFn(envelope);
}

const { useAppStore } = await import("../src/renderer/src/store");

beforeEach(() => {
  pending.length = 0;
  calls.length = 0;
  useAppStore.setState({
    view: "trace",
    createReturnLocation: null,
    selectedRunId: null,
    selectedSpanId: null,
    expandedSteps: {},
    detail: null,
    loadingDetail: false,
    error: null,
    readingByRun: {},
    readingInvalidated: false,
  });
});

describe("U6 4.5：读取重试不改变阅读位置", () => {
  it("重试在飞期间选择别的调用 ⇒ 落地不覆盖新阅读位置", async () => {
    useCanned({});
    const store = useAppStore.getState();
    await store.selectRun("run_a");
    // 默认位置 = 首个自有 llm.call（s_02）；用户随后选了 s_05
    expect(useAppStore.getState().selectedSpanId).toBe("s_02");
    useAppStore.getState().selectSpan("s_05");

    // 重试（父文件恢复后同 ID 重读）：请求在飞
    useDeferred();
    const retry = useAppStore.getState().reopenRun("run_a");
    expect(pending.length).toBe(1);
    // 在飞期间用户又切换了步骤
    useAppStore.getState().selectSpan("s_08");

    respond(ok(detailNamed("run_a")));
    await retry;

    const state = useAppStore.getState();
    expect(state.selectedSpanId).toBe("s_08");
    expect(state.readingByRun.run_a?.spanId).toBe("s_08");
    expect(state.detail).not.toBeNull();
    expect(state.loadingDetail).toBe(false);
    // 用户明确选择过 ⇒ 不出现"原位置不可用"的失效回退提示
    expect(state.readingInvalidated).toBe(false);
  });

  it("重试在飞期间换页签 ⇒ 落地落在用户新页签上", async () => {
    useCanned({});
    await useAppStore.getState().selectRun("run_a");
    useAppStore.getState().setReadingTab("run_a", "overview");

    useDeferred();
    const retry = useAppStore.getState().reopenRun("run_a");
    useAppStore.getState().setReadingTab("run_a", "steps");

    respond(ok(detailNamed("run_a")));
    await retry;

    expect(useAppStore.getState().readingByRun.run_a?.tab).toBe("steps");
  });
});

describe("U6 4.5：读取代次——同 run 连续重试的旧响应整体丢弃", () => {
  it("恢复前的 ownOnly 旧响应后到 ⇒ 不覆盖恢复后的 complete 详情", async () => {
    useDeferred();
    const first = useAppStore.getState().selectRun("run_a"); // 代次 1（父文件恢复前的读取）
    const retry = useAppStore.getState().reopenRun("run_a"); // 代次 2（恢复后重试）
    expect(pending.length).toBe(2);

    // 旧代次先回话：ownOnly（恢复前的现状）
    respond(
      ok(
        detailNamed("run_a", {
          completeness: "ownOnly",
          spanScope: "own",
          lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_root" },
        }),
      ),
    );
    await first;

    // 旧响应到达的瞬间：界面仍是"在等新读取"的加载态，且没有任何旧结论落地
    const between = useAppStore.getState();
    expect(between.loadingDetail).toBe(true);
    expect(between.detail).toBeNull();
    expect(between.error).toBeNull();

    // 新代次回话：恢复后的 complete
    respond(ok(detailNamed("run_a")));
    await retry;

    const state = useAppStore.getState();
    expect(state.detail?.completeness).toBe("complete");
    expect(state.loadingDetail).toBe(false);
    expect(state.error).toBeNull();
  });

  it("旧代次的失败收尾不落地：不清新读取的加载态、不写全局错误", async () => {
    useDeferred();
    const first = useAppStore.getState().selectRun("run_a");
    const retry = useAppStore.getState().reopenRun("run_a");

    respond({
      ok: false,
      error: { code: "GET_RUN_FAILED", message: "祖先文件损坏（模拟旧读取的失败）" },
    });
    await first;

    const between = useAppStore.getState();
    expect(between.loadingDetail).toBe(true);
    expect(between.error).toBeNull();

    respond(ok(detailNamed("run_a")));
    await retry;

    const state = useAppStore.getState();
    expect(state.detail).not.toBeNull();
    expect(state.error).toBeNull();
  });

  it("isCurrentDetailAttempt：代次全等才算当代（大代次在飞 ⇒ 小代次整体丢弃）", () => {
    expect(isCurrentDetailAttempt(3, 3)).toBe(true);
    expect(isCurrentDetailAttempt(2, 3)).toBe(false);
    expect(isCurrentDetailAttempt(4, 3)).toBe(false);
  });
});

describe("U6 4.5：切换 run 的旧响应归属丢弃（U1 既有守卫回归）", () => {
  it("A 的响应在飞时切到 B ⇒ A 的成功不落地到 B 的现场", async () => {
    useDeferred();
    const toA = useAppStore.getState().selectRun("run_a");
    const toB = useAppStore.getState().selectRun("run_b");
    expect(pending.length).toBe(2);

    respond(ok(detailNamed("run_a")));
    await toA;
    expect(useAppStore.getState().selectedRunId).toBe("run_b");
    expect(useAppStore.getState().detail).toBeNull(); // A 的详情没有顶掉 B 的加载态

    respond(ok(detailNamed("run_b")));
    await toB;
    const state = useAppStore.getState();
    expect(state.detail?.meta.id).toBe("run_b");
    expect(state.loadingDetail).toBe(false);
  });
});
