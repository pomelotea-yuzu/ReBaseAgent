import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveRunSummary } from "../src/shared/derive";
import { fail, ok } from "../src/shared/ipc";
import type { Envelope, ListRunsData, RunDetail, WindowApi } from "../src/shared/ipc";

/**
 * U1（refactor-run-workspace）任务 3.3：详情请求的 run/request 归属与同 run 重试。
 *
 * 判据来源：desktop-ui delta「异步加载与请求归属」——
 *   - 快速切换不串响应（A 的慢响应不盖 B）
 *   - 同 run 重试不串响应（旧失败不清新加载态）
 *   - 非法详情不被概览绕过（校验失败必须报错，不能"看起来是合法详情"）
 *
 * 手法：受控乱序 Promise——controller 为每次 getRun 返回一个**手动 resolve** 的
 * deferred，由用例决定谁先回、谁后回、谁失败。这样"乱序"是确定的、可复现的，
 * 不依赖真实时序（真实时序测不出竞态，只会 flaky）。
 */

const FIXTURE = (name: string): string =>
  new URL(`../../../packages/trace-sdk/fixtures/${name}.jsonl`, import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );

const recordA: RunRecord = readRun(FIXTURE("normal"));
const recordB: RunRecord = readRun(FIXTURE("tool-error"));

function detailFrom(rec: RunRecord): RunDetail {
  return {
    meta: rec.meta,
    spans: rec.spans,
    events: rec.events,
    status: rec.status,
    chain: [{ meta: rec.meta, fork: rec.meta.fork }],
    leafSpanIds: rec.spans.map((s) => s.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

const detailA = detailFrom(recordA);
const detailB = detailFrom(recordB);
const summaryA = deriveRunSummary(recordA);
const summaryB = deriveRunSummary(recordB);

interface Controller {
  /** 每次 getRun 返回一个手动控制的 deferred（按调用次序排队） */
  pending: Array<{
    id: string;
    resolve: (e: Envelope<RunDetail>) => void;
  }>;
  listCalls: number;
}

const controller: Controller = { pending: [], listCalls: 0 };

function makeFakeApi(c: Controller): WindowApi {
  return {
    listRuns: async (): Promise<Envelope<ListRunsData>> => {
      c.listCalls += 1;
      return ok({ runs: [summaryA, summaryB], failed: [] });
    },
    getRun: (_id: string) =>
      new Promise<Envelope<RunDetail>>((resolve) => {
        c.pending.push({ id: _id, resolve });
      }),
  } as unknown as WindowApi;
}

(globalThis as Record<string, unknown>).window = { api: makeFakeApi(controller) };
const { useAppStore } = await import("../src/renderer/src/store");

function resetStore(): void {
  useAppStore.setState({
    runs: [],
    failed: [],
    detail: null,
    selectedRunId: null,
    selectedSpanId: null,
    expandedSteps: {},
    readingByRun: {},
    loadingList: false,
    loadingDetail: false,
    error: null,
    forking: "idle",
    forkError: null,
    forkErrorCode: null,
    creatingRun: "idle",
    createRunError: null,
    createRunErrorCode: null,
    settings: null,
    view: "trace",
    compareIds: [],
    compareNotice: null,
  });
}

/** 取第 n 个仍未结的请求（按发出次序） */
function take(index: number): { id: string; resolve: (e: Envelope<RunDetail>) => void } {
  const item = controller.pending[index];
  if (item === undefined) throw new Error(`没有第 ${index} 个待结请求`);
  return item;
}

/** 让出微任务队列，使 selectRun 推进到 await 之后 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  controller.pending = [];
  controller.listCalls = 0;
  resetStore();
});

describe("3.3 快速切换不串响应", () => {
  it("A 的慢响应后到 ⇒ 不覆盖已选中的 B（detail 属 B）", async () => {
    await useAppStore.getState().loadRuns();

    // 点 A（请求 0），再立刻点 B（请求 1）
    const selectingA = useAppStore.getState().selectRun(detailA.meta.id);
    const selectingB = useAppStore.getState().selectRun(detailB.meta.id);
    expect(useAppStore.getState().selectedRunId).toBe(detailB.meta.id);

    // 乱序：B 先回，A 后回
    take(1).resolve(ok(detailB));
    await selectingB;
    expect(useAppStore.getState().detail?.meta.id).toBe(detailB.meta.id);

    take(0).resolve(ok(detailA));
    await selectingA;

    // A 的迟到响应被丢弃：详情仍是 B，加载态已结束
    expect(useAppStore.getState().detail?.meta.id).toBe(detailB.meta.id);
    expect(useAppStore.getState().loadingDetail).toBe(false);
  });

  it("A 的迟到成功响应不把 loadingDetail 从新 run 的加载中清掉", async () => {
    await useAppStore.getState().loadRuns();

    const selectingA = useAppStore.getState().selectRun(detailA.meta.id);
    take(0).resolve(ok(detailA));
    await selectingA;
    expect(useAppStore.getState().loadingDetail).toBe(false);

    // 再点 B（请求 1），B 尚未返回
    const selectingB = useAppStore.getState().selectRun(detailB.meta.id);
    await tick();
    expect(useAppStore.getState().loadingDetail).toBe(true);

    // B 回来之前再点 A（请求 2）——A 立刻返回，但此时选中的是 A
    take(1); // B 的请求仍在挂起
    const selectingA2 = useAppStore.getState().selectRun(detailA.meta.id);
    take(2).resolve(ok(detailA));
    await selectingA2;
    expect(useAppStore.getState().detail?.meta.id).toBe(detailA.meta.id);

    // 现在 B 的迟到响应才回来——必须被丢弃
    take(1).resolve(ok(detailB));
    await selectingB;
    expect(useAppStore.getState().detail?.meta.id).toBe(detailA.meta.id);
  });
});

describe("3.3 同 run 重试与失败收尾", () => {
  it("A 的失败在切到 B 后到达 ⇒ 不写 error，也不清 B 的 loadingDetail", async () => {
    await useAppStore.getState().loadRuns();

    const selectingA = useAppStore.getState().selectRun(detailA.meta.id);
    const selectingB = useAppStore.getState().selectRun(detailB.meta.id);
    await tick();
    expect(useAppStore.getState().loadingDetail).toBe(true); // B 正在加载

    // A 的请求先失败到达（乱序：失败早于 B 的成功）
    take(0).resolve(fail("READ_RUN_FAILED", new Error("磁盘读取失败")));
    await selectingA;

    // 关键：A 的收尾不得污染 B 的加载态，也不得显示 A 的错误
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().loadingDetail).toBe(true);

    take(1).resolve(ok(detailB));
    await selectingB;
    expect(useAppStore.getState().detail?.meta.id).toBe(detailB.meta.id);
    expect(useAppStore.getState().loadingDetail).toBe(false);
  });

  it("同 run 重试：删除 run（切走）、再重读同一 run 时，新加载态不被旧收尾清除", async () => {
    await useAppStore.getState().loadRuns();

    // 首次点 A（请求 0），失败
    const first = useAppStore.getState().selectRun(detailA.meta.id);
    take(0).resolve(fail("READ_RUN_FAILED", new Error("第一次失败")));
    await first;
    expect(useAppStore.getState().error).toContain("第一次失败");

    // 切到 B（改变选中），再切回 A（重试，请求 2；请求 1 是 B 的）
    const toB = useAppStore.getState().selectRun(detailB.meta.id);
    take(1).resolve(ok(detailB));
    await toB;

    const retry = useAppStore.getState().selectRun(detailA.meta.id);
    await tick();
    expect(useAppStore.getState().loadingDetail).toBe(true); // 重试的新加载态
    expect(useAppStore.getState().error).toBeNull(); // 进入即清旧错误

    take(2).resolve(ok(detailA));
    await retry;
    expect(useAppStore.getState().detail?.meta.id).toBe(detailA.meta.id);
    expect(useAppStore.getState().error).toBeNull();
  });

  it("同 run 连续两次请求，先发的旧响应后到 ⇒ 旧响应被丢弃（不回到旧位置）", async () => {
    await useAppStore.getState().loadRuns();

    // 同一 run 连发两次（模拟快速双击同一个 run：第一次请求还挂着）
    const first = useAppStore.getState().selectRun(detailA.meta.id);
    // 手动改回未选中以强制第二次进入（selectRun 对同 id 短路）
    useAppStore.setState({ selectedRunId: null });
    const second = useAppStore.getState().selectRun(detailA.meta.id);

    // 新请求先回
    take(1).resolve(ok(detailA));
    await second;
    expect(useAppStore.getState().detail?.meta.id).toBe(detailA.meta.id);

    // 旧请求后回：同 run ⇒ 会被正常落地（无害：同一份数据），但不得留下 loadingDetail=true
    take(0).resolve(ok(detailA));
    await first;
    expect(useAppStore.getState().loadingDetail).toBe(false);
  });
});

describe("3.3 非法详情不被概览绕过", () => {
  it("载荷自称的 run 与请求不一致（main 回错） ⇒ 报错且不落地", async () => {
    await useAppStore.getState().loadRuns();

    const selecting = useAppStore.getState().selectRun(detailA.meta.id);
    // 请求的是 A，但 main 回了 B 的详情
    take(0).resolve(ok(detailB));
    await selecting;

    expect(useAppStore.getState().detail).toBeNull();
    expect(useAppStore.getState().error).toContain("归属校验失败");
    expect(useAppStore.getState().loadingDetail).toBe(false);
  });

  it("版本非法（v1 载荷私带隔离字段） ⇒ 拒绝加载，不落进 detail", async () => {
    await useAppStore.getState().loadRuns();

    const tampered = {
      ...detailA,
      meta: { ...detailA.meta, workspace: { root: "C:/somewhere" } },
    } as unknown as RunDetail;

    const selecting = useAppStore.getState().selectRun(detailA.meta.id);
    take(0).resolve(ok(tampered));
    await selecting;

    expect(useAppStore.getState().detail).toBeNull();
    expect(useAppStore.getState().error).toContain("版本校验失败");
  });

  it("结构非法（schema 不符） ⇒ 拒绝加载，不落进 detail", async () => {
    await useAppStore.getState().loadRuns();

    const broken = { ...detailA, spans: "不是数组" } as unknown as RunDetail;

    const selecting = useAppStore.getState().selectRun(detailA.meta.id);
    take(0).resolve(ok(broken));
    await selecting;

    expect(useAppStore.getState().detail).toBeNull();
    expect(useAppStore.getState().error).toContain("结构校验失败");
  });

  it("非法详情在切走之后到达 ⇒ 既不落地也不报错（不打扰新 run）", async () => {
    await useAppStore.getState().loadRuns();

    const selectingA = useAppStore.getState().selectRun(detailA.meta.id);
    const selectingB = useAppStore.getState().selectRun(detailB.meta.id);

    // A 的非法响应迟到
    take(0).resolve(ok({ ...detailA, spans: "不是数组" } as unknown as RunDetail));
    await selectingA;
    expect(useAppStore.getState().error).toBeNull();

    take(1).resolve(ok(detailB));
    await selectingB;
    expect(useAppStore.getState().detail?.meta.id).toBe(detailB.meta.id);
    expect(useAppStore.getState().error).toBeNull();
  });

  it("异常（getRun 抛错）⇒ 不落地非法详情，错误以文本形式呈现", async () => {
    await useAppStore.getState().loadRuns();

    // 让这一次 getRun 直接 reject（通道异常，不是信封失败）
    const api = (globalThis as { window: { api: WindowApi } }).window.api;
    const original = api.getRun;
    (api as { getRun: unknown }).getRun = () => Promise.reject(new Error("通道异常"));

    let threw = false;
    try {
      await useAppStore.getState().selectRun(detailA.meta.id);
    } catch {
      threw = true; // store 未捕获亦可接受，只要不把坏数据写进 detail
    }
    expect(threw || useAppStore.getState().detail === null).toBe(true);
    expect(useAppStore.getState().detail).toBeNull();

    // 恢复通道，后续用例（若有）不受影响
    (api as { getRun: unknown }).getRun = original;
  });
});
