import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveRunSummary } from "../src/shared/derive";
import { ok } from "../src/shared/ipc";
import type {
  Envelope,
  ForkRunResult,
  ListRunsData,
  RunDetail,
  SettingsState,
  WindowApi,
} from "../src/shared/ipc";

/**
 * store（zustand）流转测试：runs:fork 的 forking 状态机 + 成功后刷新列表并自动选中
 * 新 run + settings 加载。
 *
 * 渲染层 api 在 window.api 上（preload 注入）。模块只读 window.api 一次，故用一个
 * 共享 controller 的 stub（每个用例在 beforeEach 复位行为与 store 状态），避免
 * 模块缓存/重置的顺序陷阱。
 */

const FIXTURE = resolve(import.meta.dirname, "../../../packages/trace-sdk/fixtures/normal.jsonl");
const record: RunRecord = readRun(FIXTURE);

/** 由真实 fixture 构造能通过 RunDetailSchema 校验的 detail（main 侧同构） */
function detailFrom(rec: RunRecord): RunDetail {
  return {
    meta: rec.meta,
    spans: rec.spans,
    events: rec.events,
    status: rec.status,
    chain: [{ meta: rec.meta, fork: rec.meta.fork }],
    leafSpanIds: rec.spans.map((s) => s.id),
  };
}

const rootDetail = detailFrom(record);
const rootSummary = deriveRunSummary(record);
const forkedSummary = { ...rootSummary, id: "run_forked", parent: "r_01" };

/** 用例间共享的行为控制器（闭包捕获，读 call 时最新值） */
interface Controller {
  forkEnvelope: Envelope<ForkRunResult> | undefined;
  forkRequests: Array<{ parentRunId: string; atSpanId: string; value: string }>;
  listCalls: number;
}

function makeFakeApi(c: Controller): WindowApi {
  return {
    listRuns: async (): Promise<Envelope<ListRunsData>> => {
      c.listCalls += 1;
      // 第二次列表刷新后出现新的分支 run（排在前面）
      const runs = c.listCalls > 1 ? [forkedSummary, rootSummary] : [rootSummary];
      return ok({ runs, failed: [] });
    },
    getRun: async (): Promise<Envelope<RunDetail>> => ok(rootDetail),
    forkRun: async (request) => {
      c.forkRequests.push({
        parentRunId: request.parentRunId,
        atSpanId: request.atSpanId,
        value: request.edit.value,
      });
      return c.forkEnvelope ?? ok({ id: "run_forked" });
    },
    getSettings: async (): Promise<Envelope<SettingsState>> =>
      ok({ configured: false, baseURL: null, model: null, encryption: "safe" }),
    saveSettings: async () => ok({ configured: true }),
    clearSettings: async () => ok({ configured: false }),
  };
}

const controller: Controller = { forkEnvelope: undefined, forkRequests: [], listCalls: 0 };
(globalThis as Record<string, unknown>).window = { api: makeFakeApi(controller) };

// store 模块在其 import 的瞬间读 window.api——上面的 stub 必须先就位
const { useAppStore } = await import("../src/renderer/src/store");

/** 把 store 复位到初始状态（zustand 单例跨用例存活） */
function resetStore(): void {
  useAppStore.setState({
    runs: [],
    failed: [],
    detail: null,
    selectedRunId: null,
    selectedSpanId: null,
    expandedSteps: {},
    loadingList: false,
    loadingDetail: false,
    error: null,
    forking: "idle",
    forkError: null,
    forkErrorCode: null,
    settings: null,
    view: "trace",
    compareIds: [],
    compareNotice: null,
  });
}

beforeEach(() => {
  controller.forkEnvelope = undefined;
  controller.forkRequests = [];
  controller.listCalls = 0;
  resetStore();
});

describe("store：runs:fork 流转（tasks 6.1）", () => {
  it("成功：in_progress → success，列表刷新并自动选中新 run", async () => {
    await useAppStore.getState().loadRuns();
    expect(useAppStore.getState().runs).toHaveLength(1);

    const okFork = await useAppStore.getState().forkAt("r_01", "s_03", "编辑后的结果");
    expect(okFork).toBe(true);

    const state = useAppStore.getState();
    expect(state.forking).toBe("success");
    expect(state.forkError).toBeNull();
    expect(controller.forkRequests).toEqual([
      { parentRunId: "r_01", atSpanId: "s_03", value: "编辑后的结果" },
    ]);
    // 刷新后列表含新 run 且自动选中
    expect(controller.listCalls).toBeGreaterThanOrEqual(2);
    expect(state.runs[0]?.id).toBe("run_forked");
    expect(state.selectedRunId).toBe("run_forked");
    expect(state.detail).not.toBeNull();
  });

  it("失败：in_progress → error，保留信封错误信息与错误码，不选中新 run", async () => {
    controller.forkEnvelope = {
      ok: false,
      error: { code: "FORK_FAILED", message: "config_hash 不一致：换源码属于新实验" },
    };
    await useAppStore.getState().loadRuns();
    const okFork = await useAppStore.getState().forkAt("r_01", "s_03", "新值");
    expect(okFork).toBe(false);

    const state = useAppStore.getState();
    expect(state.forking).toBe("error");
    expect(state.forkError).toContain("config_hash 不一致");
    expect(state.forkErrorCode).toBe("FORK_FAILED");
    // 不自动选中（仍停留在原 run）
    expect(state.selectedRunId).toBeNull();
    expect(controller.listCalls).toBe(1);
  });

  it("resetFork 复位分叉状态，供下一次编辑重新开始", async () => {
    controller.forkEnvelope = { ok: false, error: { code: "X", message: "y" } };
    await useAppStore.getState().forkAt("r_01", "s_03", "新值");
    expect(useAppStore.getState().forking).toBe("error");
    useAppStore.getState().resetFork();
    expect(useAppStore.getState().forking).toBe("idle");
    expect(useAppStore.getState().forkError).toBeNull();
    expect(useAppStore.getState().forkErrorCode).toBeNull();
  });
});

describe("store：运行配置状态（tasks 5.2）", () => {
  it("loadSettings 把 settings 状态读入（不含 apiKey）", async () => {
    expect(useAppStore.getState().settings).toBeNull();
    await useAppStore.getState().loadSettings();
    const settings = useAppStore.getState().settings;
    expect(settings?.configured).toBe(false);
    expect(settings?.encryption).toBe("safe");
  });
});

describe("store：分支树视图与对照集合", () => {
  it("视图切换只改 view，不触发列表重新加载", async () => {
    await useAppStore.getState().loadRuns();
    expect(controller.listCalls).toBe(1);

    useAppStore.getState().setView("tree");
    useAppStore.getState().setView("trace");
    expect(useAppStore.getState().view).toBe("trace");
    expect(controller.listCalls).toBe(1);
  });

  it("切换视图后选中的 run 保持不变（两视图共享选中状态）", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    expect(useAppStore.getState().selectedRunId).toBe("r_01");

    useAppStore.getState().setView("tree");
    expect(useAppStore.getState().selectedRunId).toBe("r_01");
  });

  it("对照上限 4：第 5 条被拒绝并给出提示，已选集合不变", () => {
    const store = useAppStore.getState();
    for (const id of ["r_a", "r_b", "r_c", "r_d"]) store.toggleCompare(id);
    expect(useAppStore.getState().compareIds).toEqual(["r_a", "r_b", "r_c", "r_d"]);

    useAppStore.getState().toggleCompare("r_e");
    expect(useAppStore.getState().compareIds).toHaveLength(4);
    expect(useAppStore.getState().compareNotice).toContain("最多同时对照 4 条");
  });

  it("移出对照后提示清空；clearCompare 清空集合", () => {
    const store = useAppStore.getState();
    for (const id of ["r_a", "r_b", "r_c", "r_d"]) store.toggleCompare(id);
    useAppStore.getState().toggleCompare("r_e");
    expect(useAppStore.getState().compareNotice).not.toBeNull();

    useAppStore.getState().toggleCompare("r_a");
    expect(useAppStore.getState().compareNotice).toBeNull();
    expect(useAppStore.getState().compareIds).toEqual(["r_b", "r_c", "r_d"]);

    useAppStore.getState().clearCompare();
    expect(useAppStore.getState().compareIds).toEqual([]);
  });
});
