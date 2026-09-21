import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveRunSummary } from "../src/shared/derive";
import { ok } from "../src/shared/ipc";
import type {
  ChooseSourceResult,
  CreateRunRequest,
  Envelope,
  ForkCapabilityRequest,
  ForkCapabilityResult,
  ForkRunResult,
  IsolatedExecutionMode,
  ListRunsData,
  PromptForkResult,
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
  forkRequests: Array<{
    parentRunId: string;
    atSpanId: string;
    value: string;
    execution?: IsolatedExecutionMode;
  }>;
  promptForkEnvelope: Envelope<PromptForkResult> | undefined;
  promptForkRequests: Array<{
    parentRunId: string;
    field: string;
    value: string;
  }>;
  createRunEnvelope: Envelope<{ id: string }> | undefined;
  /** 原样记录透传出去的请求（含隔离模式的 workspace，B 2.1） */
  createRunRequests: CreateRunRequest[];
  /** 覆盖 chooseSource 的返回（默认取消；供"目录选择结果校验"用例注入非法载荷） */
  chooseSourceEnvelope: Envelope<ChooseSourceResult> | undefined;
  chooseSourceCalls: number;
  /** 覆盖 forkCapability 的返回（默认一条合法预检结论；B 2.2） */
  forkCapabilityEnvelope: Envelope<ForkCapabilityResult> | undefined;
  forkCapabilityRequests: ForkCapabilityRequest[];
  /** 覆盖 getRun 的返回详情（默认 rootDetail）；供版本守卫接线用例注入被篡改载荷 */
  getRunDetail: RunDetail | undefined;
  /** 按 run id 覆盖详情（供跨运行恢复用例让两条 run 返回不同轨迹） */
  getRunDetailById: Record<string, RunDetail> | undefined;
  /** 记录 getRun 的调用顺序（同 run 重试用例断言真的重新读了） */
  getRunCalls: string[];
  listCalls: number;
  /** 覆盖 listRuns 的返回（默认第一条只有 root，第二次起出现分支 run） */
  listEnvelope: Envelope<ListRunsData> | undefined;
  /** 列表返回按调用序逐个取用（末项重复），用于"失败后重试成功"的序列注入 */
  listEnvelopesByCall: Envelope<ListRunsData>[] | undefined;
  /** 挂起列表返回，直到用例手动 resolve（制造"请求在途"窗口） */
  listGate: { promise: Promise<void>; release: () => void } | undefined;
}

/** 合法预检结论（main 侧 `ForkCapabilityResultSchema` 的形状） */
const CAPABILITY: ForkCapabilityResult = {
  parentId: "r_01",
  atSpanId: "s_03",
  stepSpanId: "s_02",
  ownerRunId: "r_01",
  localIteration: 1,
  snapshotId: "a".repeat(64),
  fileCount: 2,
  totalBytes: 1536,
  configHash: `sha256:${"b".repeat(64)}`,
};

function makeFakeApi(c: Controller): WindowApi {
  return {
    listRuns: async (): Promise<Envelope<ListRunsData>> => {
      const callIndex = c.listCalls;
      c.listCalls += 1;
      // 在途窗口（任务 3.4）：用例可挂起列表返回，模拟"请求还没回来时又有人要刷新"
      if (c.listGate !== undefined) await c.listGate.promise;
      if (c.listEnvelopesByCall !== undefined) {
        return (
          c.listEnvelopesByCall[Math.min(callIndex, c.listEnvelopesByCall.length - 1)] ??
          ok({ runs: [], failed: [] })
        );
      }
      if (c.listEnvelope !== undefined) return c.listEnvelope;
      // 第二次列表刷新后出现新的分支 run（排在前面）
      const runs = callIndex > 0 ? [forkedSummary, rootSummary] : [rootSummary];
      return ok({ runs, failed: [] });
    },
    getRun: async (id: string): Promise<Envelope<RunDetail>> => {
      c.getRunCalls.push(id);
      // 按 run id 返回各自详情（默认 rootDetail）；供跨运行恢复用例区分两条 run
      const base = c.getRunDetailById?.[id] ?? c.getRunDetail ?? rootDetail;
      // 载荷归属（任务 3.3）：详情自称的 meta.id 必须与请求的 id 一致，
      // 否则渲染层会拒绝加载。默认详情来自 fixture（meta.id = "r_01"），
      // 请求别的 run（如 fork 产生的 run_forked）时按请求 id 改写，模拟 main 的真实行为。
      if (base.meta.id === id) return ok(base);
      return ok({
        ...base,
        meta: { ...base.meta, id },
        chain: [{ meta: { ...base.meta, id }, fork: base.meta.fork }],
      });
    },
    forkRun: async (request) => {
      c.forkRequests.push({
        parentRunId: request.parentRunId,
        atSpanId: request.atSpanId,
        value: request.edit.value,
        // 未传时不写该键：与真实请求体一致（普通父本请求里没有 execution）
        ...(request.execution === undefined ? {} : { execution: request.execution }),
      });
      return c.forkEnvelope ?? ok({ id: "run_forked" });
    },
    promptFork: async (request) => {
      c.promptForkRequests.push({
        parentRunId: request.parentRunId,
        field: request.edit.field,
        value: request.edit.value,
      });
      return c.promptForkEnvelope ?? ok({ id: "run_prompt_forked" });
    },
    getSettings: async (): Promise<Envelope<SettingsState>> =>
      ok({ configured: false, baseURL: null, model: null, encryption: "safe" }),
    saveSettings: async () => ok({ configured: true }),
    clearSettings: async () => ok({ configured: false }),
    createRun: async (request) => {
      c.createRunRequests.push(request);
      return c.createRunEnvelope ?? ok({ id: "run_created" });
    },
    // B 1.3/1.5 的只读辅助通道：chooseSource 与 forkCapability 均已接（2.1 / 2.2）
    chooseSource: async () => {
      c.chooseSourceCalls += 1;
      return c.chooseSourceEnvelope ?? ok({ canceled: true });
    },
    forkCapability: async (request) => {
      c.forkCapabilityRequests.push(request);
      return c.forkCapabilityEnvelope ?? ok(CAPABILITY);
    },
  };
}

const controller: Controller = {
  forkEnvelope: undefined,
  forkRequests: [],
  promptForkEnvelope: undefined,
  promptForkRequests: [],
  createRunEnvelope: undefined,
  createRunRequests: [],
  chooseSourceEnvelope: undefined,
  chooseSourceCalls: 0,
  forkCapabilityEnvelope: undefined,
  forkCapabilityRequests: [],
  getRunCalls: [],
  listCalls: 0,
  listEnvelope: undefined,
  listEnvelopesByCall: undefined,
  listGate: undefined,
};
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
    readingByRun: {},
    loadingList: false,
    loadingDetail: false,
    listLoaded: false,
    listStale: false,
    listRefreshInFlight: 0,
    listRefreshPending: 0,
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

beforeEach(() => {
  controller.forkEnvelope = undefined;
  controller.forkRequests = [];
  controller.promptForkEnvelope = undefined;
  controller.promptForkRequests = [];
  controller.createRunEnvelope = undefined;
  controller.createRunRequests = [];
  controller.chooseSourceEnvelope = undefined;
  controller.chooseSourceCalls = 0;
  controller.forkCapabilityEnvelope = undefined;
  controller.forkCapabilityRequests = [];
  controller.getRunDetail = undefined;
  controller.getRunDetailById = undefined;
  controller.getRunCalls = [];
  controller.listCalls = 0;
  controller.listEnvelope = undefined;
  controller.listEnvelopesByCall = undefined;
  controller.listGate = undefined;
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

describe("store：runs:promptFork 流转（add-prompt-replay）", () => {
  it("成功：in_progress → success，列表刷新并自动选中新 run", async () => {
    await useAppStore.getState().loadRuns();

    const okFork = await useAppStore
      .getState()
      .promptFork("r_01", { field: "system_prompt", value: "新的 system prompt" });
    expect(okFork).toBe(true);

    const state = useAppStore.getState();
    expect(state.forking).toBe("success");
    expect(state.forkError).toBeNull();
    expect(controller.promptForkRequests).toEqual([
      { parentRunId: "r_01", field: "system_prompt", value: "新的 system prompt" },
    ]);
    expect(controller.listCalls).toBeGreaterThanOrEqual(2);
    expect(state.selectedRunId).toBe("run_prompt_forked");
    expect(state.detail).not.toBeNull();
  });

  it("失败：error 状态保留信封错误与错误码，不刷新出伪 run", async () => {
    controller.promptForkEnvelope = {
      ok: false,
      error: {
        code: "PROMPT_FORK_NO_SYSTEM",
        message: "父 run 首次 llm.call 不含字符串形式的 system 消息，prompt fork 不可用",
      },
    };
    await useAppStore.getState().loadRuns();
    const okFork = await useAppStore
      .getState()
      .promptFork("r_01", { field: "user_message", value: "新指令" });
    expect(okFork).toBe(false);

    const state = useAppStore.getState();
    expect(state.forking).toBe("error");
    expect(state.forkErrorCode).toBe("PROMPT_FORK_NO_SYSTEM");
    expect(state.forkError).toContain("system 消息");
    // 不自动选中（失败不产生伪 run）
    expect(state.selectedRunId).toBeNull();
    expect(controller.listCalls).toBe(1);
  });

  it("未配置运行参数的错误码原样透传（SETTINGS_NOT_CONFIGURED）", async () => {
    controller.promptForkEnvelope = {
      ok: false,
      error: { code: "SETTINGS_NOT_CONFIGURED", message: "尚未配置运行参数" },
    };
    const okFork = await useAppStore
      .getState()
      .promptFork("r_01", { field: "system_prompt", value: "x" });
    expect(okFork).toBe(false);
    expect(useAppStore.getState().forkErrorCode).toBe("SETTINGS_NOT_CONFIGURED");
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

describe("store：runs:create 流转（A1 / B 2.1 请求透传）", () => {
  it("成功：in_progress → success，列表刷新并自动选中新 run", async () => {
    await useAppStore.getState().loadRuns();
    const created = await useAppStore
      .getState()
      .createRun({ systemPrompt: "你是助手。", userMessage: "解释一下时间旅行调试" });
    expect(created).toBe(true);

    const state = useAppStore.getState();
    expect(state.creatingRun).toBe("success");
    expect(state.createRunError).toBeNull();
    // 纯对话请求里不带 workspace 键（main 据此走空工具表 + v1）
    expect(controller.createRunRequests).toEqual([
      { systemPrompt: "你是助手。", userMessage: "解释一下时间旅行调试" },
    ]);
    expect(
      controller.createRunRequests[0] !== undefined &&
        "workspace" in controller.createRunRequests[0],
    ).toBe(false);
    expect(state.selectedRunId).toBe("run_created");
  });

  it("隔离模式：store 原样透传 workspace（授权与 token 不经渲染层改写）", async () => {
    await useAppStore.getState().createRun({
      systemPrompt: "",
      userMessage: "读一下 a.txt",
      workspace: { mode: "isolated_files", sourceToken: "tok_1", allowFileWrites: true },
    });

    expect(controller.createRunRequests).toEqual([
      {
        systemPrompt: "",
        userMessage: "读一下 a.txt",
        workspace: { mode: "isolated_files", sourceToken: "tok_1", allowFileWrites: true },
      },
    ]);
    expect(useAppStore.getState().creatingRun).toBe("success");
  });

  it("失败：置 error 并保留错误码，且仍刷新列表（error run 已落盘，必须可见）", async () => {
    controller.createRunEnvelope = {
      ok: false,
      error: {
        code: "CREATE_RUN_FAILED",
        message:
          "新建 run 执行失败：模型调用未完成（终止原因 error）。run run_x 已落盘，可在列表中点开该 run，查看失败的那次 LLM 调用上的错误详情。",
      },
    };
    await useAppStore.getState().loadRuns();
    const before = controller.listCalls;

    const created = await useAppStore
      .getState()
      .createRun({ systemPrompt: "", userMessage: "你好" });
    expect(created).toBe(false);

    const state = useAppStore.getState();
    expect(state.creatingRun).toBe("error");
    expect(state.createRunErrorCode).toBe("CREATE_RUN_FAILED");
    expect(state.createRunError).toContain("模型调用未完成");
    // 关键：失败也要重拉列表，否则用户看不到那条已按 meta.id 落盘的 error run
    expect(controller.listCalls).toBeGreaterThan(before);
    expect(state.selectedRunId).toBeNull();
  });
});

describe("store：chooseSource 只读通道（B 2.1）", () => {
  it("成功结果经 schema 校验后回给对话框（含 token / 展示名 / 路径）", async () => {
    controller.chooseSourceEnvelope = ok({
      canceled: false,
      sourceToken: "tok_9",
      name: "lab",
      path: "D:\\lab",
      expiresAt: "2026-09-20T12:30:00.000Z",
    });
    const result = await useAppStore.getState().chooseSource();

    expect(controller.chooseSourceCalls).toBe(1);
    expect(result).toEqual({
      canceled: false,
      sourceToken: "tok_9",
      name: "lab",
      path: "D:\\lab",
      expiresAt: "2026-09-20T12:30:00.000Z",
    });
    expect(useAppStore.getState().error).toBeNull();
  });

  it("取消返回 {canceled:true}（不是失败，组件据此不改变已选目录）", async () => {
    const result = await useAppStore.getState().chooseSource();
    expect(result).toEqual({ canceled: true });
    expect(useAppStore.getState().error).toBeNull();
  });

  it("非法载荷 → null + 可读 error（跨进程数据不可信）", async () => {
    controller.chooseSourceEnvelope = ok({ canceled: false, sourceToken: "", name: 1 } as never);
    const result = await useAppStore.getState().chooseSource();
    expect(result).toBeNull();
    expect(useAppStore.getState().error).toContain("目录选择结果结构校验失败");
  });

  it("通道失败 → null + 可读 error，不误当作取消", async () => {
    controller.chooseSourceEnvelope = {
      ok: false,
      error: { code: "CHOOSE_SOURCE_FAILED", message: "对话框不可用" },
    };
    const result = await useAppStore.getState().chooseSource();
    expect(result).toBeNull();
    expect(useAppStore.getState().error).toContain("选择源目录失败");
  });
});

describe("store：隔离续跑的 execution 声明与能力预检（B 2.2）", () => {
  it("隔离父本：execution 原样透传（本次显式 allowFileWrites）", async () => {
    const okFork = await useAppStore
      .getState()
      .forkAt("r_01", "s_03", "编辑后的观察", { mode: "isolated_files", allowFileWrites: true });

    expect(okFork).toBe(true);
    expect(controller.forkRequests).toEqual([
      {
        parentRunId: "r_01",
        atSpanId: "s_03",
        value: "编辑后的观察",
        execution: { mode: "isolated_files", allowFileWrites: true },
      },
    ]);
  });

  it("普通父本：请求里不出现 execution 键（不误加隔离声明、不降级隔离父本）", async () => {
    await useAppStore.getState().forkAt("r_01", "s_03", "编辑后的观察");
    const sent = controller.forkRequests[0];
    expect(sent).toEqual({ parentRunId: "r_01", atSpanId: "s_03", value: "编辑后的观察" });
    expect(sent !== undefined && "execution" in sent).toBe(false);
  });

  it("能力预检成功：结果经 schema 校验后返回（不入全局状态，故不污染其它编辑器）", async () => {
    const outcome = await useAppStore.getState().loadForkCapability({
      parentRunId: "r_01",
      atSpanId: "s_03",
      edit: { field: "result", value: "改" },
    });

    expect(controller.forkCapabilityRequests).toEqual([
      { parentRunId: "r_01", atSpanId: "s_03", edit: { field: "result", value: "改" } },
    ]);
    expect(outcome).toEqual({ ok: true, data: CAPABILITY });
  });

  it("能力预检通道失败：返回错误码与消息，不抛异常", async () => {
    controller.forkCapabilityEnvelope = {
      ok: false,
      error: { code: "FORK_CAPABILITY_UNAVAILABLE", message: "该 run 未记录文件检查点" },
    };
    const outcome = await useAppStore.getState().loadForkCapability({
      parentRunId: "r_01",
      atSpanId: "s_03",
      edit: { field: "result", value: "改" },
    });

    expect(outcome).toEqual({
      ok: false,
      code: "FORK_CAPABILITY_UNAVAILABLE",
      message: "该 run 未记录文件检查点",
    });
  });

  it("能力预检结果结构非法：拦在渲染层（快照 id 形状不对）", async () => {
    controller.forkCapabilityEnvelope = ok({ ...CAPABILITY, snapshotId: "not-hex" } as never);
    const outcome = await useAppStore.getState().loadForkCapability({
      parentRunId: "r_01",
      atSpanId: "s_03",
      edit: { field: "result", value: "改" },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.code).toBe("CAPABILITY_SCHEMA_INVALID");
    expect(outcome.ok ? "" : outcome.message).toContain("结构校验失败");
  });
});

describe("store：详情 IPC 的版本守卫接线（B 1.1）", () => {
  it("v1 载荷私带隔离字段 → selectRun 拒绝加载并给出可读错误，detail 不进状态", async () => {
    await useAppStore.getState().loadRuns();
    // 单点破坏：真实 v1 fixture 的 meta 上注入 workspace（自有属性存在）
    controller.getRunDetail = {
      ...rootDetail,
      meta: { ...rootDetail.meta, workspace: { world_id: "run_伪造" } },
    };

    await useAppStore.getState().selectRun("r_01");

    const state = useAppStore.getState();
    expect(state.detail).toBeNull();
    expect(state.loadingDetail).toBe(false);
    expect(state.error).toContain("轨迹数据版本校验失败");
    expect(state.error).toContain("workspace");
  });

  it("正常载荷不受影响（守卫放行，schema 校验后进状态）", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    const state = useAppStore.getState();
    expect(state.error).toBeNull();
    expect(state.detail?.meta.id).toBe(record.meta.id);
  });
});

describe("store：阅读状态按运行恢复（任务 3.1）", () => {
  /** r_02 的详情：换一组 span id，用于验证两条 run 的阅读状态互不串 */
  const otherDetail: RunDetail = {
    ...rootDetail,
    meta: { ...rootDetail.meta, id: "r_02" },
    spans: rootDetail.spans.map((s, i) => ({ ...s, id: `${s.id}_b${i}` })),
    leafSpanIds: rootDetail.spans.map((s, i) => `${s.id}_b${i}`),
  };

  it("跨运行返回恢复阅读：A 的页签/选中/展开在回到 A 后恢复", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    const firstStep = useAppStore.getState().detail?.spans.find((s) => s.kind === "agent.step");
    expect(firstStep).toBeDefined();

    // 在 A 上改动阅读状态
    useAppStore.getState().setReadingTab("r_01", "steps");
    useAppStore.getState().selectSpan(firstStep?.id ?? "");
    useAppStore.getState().toggleStep(firstStep?.id ?? ""); // 折叠

    // 切到 B，再回到 A
    await useAppStore.getState().selectRun("r_02");
    await useAppStore.getState().selectRun("r_01");

    const state = useAppStore.getState();
    expect(state.readingOf("r_01").tab).toBe("steps");
    expect(state.selectedSpanId).toBe(firstStep?.id);
    // 折叠状态被恢复（默认全展开，用户折叠过 ⇒ false）
    expect(state.expandedSteps[firstStep?.id ?? ""]).toBe(false);
  });

  it("A/B 相同 span ID 不串状态（各自记录各自的值）", async () => {
    controller.getRunDetailById = { r_01: rootDetail, r_02: otherDetail };
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    const aFirst = rootDetail.spans[0]?.id ?? "";
    useAppStore.getState().selectSpan(aFirst);

    await useAppStore.getState().selectRun("r_02");
    // B 的详情里没有 aFirst 这个 id 时不会误选；显式给 B 选它自己的 span
    const bFirst = otherDetail.spans[0]?.id ?? "";
    useAppStore.getState().selectSpan(bFirst);

    expect(useAppStore.getState().readingOf("r_01").spanId).toBe(aFirst);
    expect(useAppStore.getState().readingOf("r_02").spanId).toBe(bFirst);
    expect(aFirst).not.toBe(bFirst);
  });

  it("selectRun 恢复历史展开集合：用户折叠过的 step 保持折叠", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    const stepId =
      useAppStore.getState().detail?.spans.find((s) => s.kind === "agent.step")?.id ?? "";
    useAppStore.getState().toggleStep(stepId);
    expect(useAppStore.getState().expandedSteps[stepId]).toBe(false);

    // 切走再回来
    await useAppStore.getState().selectRun("r_02");
    await useAppStore.getState().selectRun("r_01");
    expect(useAppStore.getState().expandedSteps[stepId]).toBe(false);
  });

  it("滚动位置按 run 记忆（概览/步骤各一处），互不覆盖", () => {
    useAppStore.getState().setReadingScroll("r_01", "overview", 120);
    useAppStore.getState().setReadingScroll("r_01", "steps", 340);
    useAppStore.getState().setReadingScroll("r_02", "overview", 7);

    expect(useAppStore.getState().readingOf("r_01").overviewScrollTop).toBe(120);
    expect(useAppStore.getState().readingOf("r_01").stepsScrollTop).toBe(340);
    expect(useAppStore.getState().readingOf("r_02").overviewScrollTop).toBe(7);
    expect(useAppStore.getState().readingOf("r_02").stepsScrollTop).toBe(0);
  });

  it("调用分区状态按 run + span 记忆", () => {
    useAppStore.getState().setCallReading("r_01", "s_02", { io: "input", scrollTop: 5 });
    useAppStore.getState().setCallReading("r_01", "s_02", { expanded: ["reasoning"] });
    const call = useAppStore.getState().readingOf("r_01").calls.s_02;
    expect(call).toEqual({ io: "input", scrollTop: 5, expanded: ["reasoning"] });
    // 另一个 run 不共享
    expect(useAppStore.getState().readingOf("r_02").calls.s_02).toBeUndefined();
  });

  it("阅读恢复不保存授权/草稿：readingByRun 结构里没有这些键", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    useAppStore.getState().setReadingTab("r_01", "files");
    const reading = useAppStore.getState().readingOf("r_01");
    for (const forbidden of [
      "draft",
      "authorization",
      "sourceToken",
      "allowFileWrites",
      "content",
    ]) {
      expect(Object.keys(reading)).not.toContain(forbidden);
    }
  });
});

/** 把列表返回挂起，制造"请求在途"窗口（任务 3.4 的受控窗口） */
function gateList(): () => void {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  controller.listGate = { promise, release };
  return () => {
    controller.listGate = undefined;
    release();
  };
}

describe("store：列表刷新合并（任务 3.4）", () => {
  it("刷新合并且保留阅读：请求在途时执行收尾触发的刷新被合并，并尾随补发一次", async () => {
    await useAppStore.getState().loadRuns();
    expect(controller.listCalls).toBe(1);
    // 在 A 上留下阅读位置与选中，验证刷新不打扰它们
    await useAppStore.getState().selectRun("r_01");
    const stepId =
      useAppStore.getState().detail?.spans.find((s) => s.kind === "agent.step")?.id ?? "";
    useAppStore.getState().setReadingTab("r_01", "steps");
    useAppStore.getState().toggleStep(stepId);
    useAppStore.getState().selectSpan(stepId);

    // 挂起列表返回：模拟"用户在刷新还没回来时，执行收尾又要求刷新"
    const release = gateList();
    const inFlight = useAppStore.getState().loadRuns();
    // 在途期间的两次"重复刷新"（如执行收尾 + 手动重试）→ 只登记一次尾随，不发新请求
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().loadRuns();
    expect(controller.listCalls).toBe(2); // 挂起的这一次 + 首次挂载的那一次，没有并发发射
    expect(useAppStore.getState().listRefreshPending).toBe(1);
    release();
    await inFlight;

    // 尾随补发恰好一次 ⇒ 新记录最终可见
    expect(controller.listCalls).toBe(3);
    expect(useAppStore.getState().runs.map((r) => r.id)).toEqual(["run_forked", "r_01"]);
    // 刷新不自动选择新记录，阅读位置与展开集合完整保留
    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe("r_01");
    expect(state.readingOf("r_01").tab).toBe("steps");
    expect(state.readingOf("r_01").spanId).toBe(stepId);
    expect(state.expandedSteps[stepId]).toBe(false);
    expect(state.detail?.meta.id).toBe("r_01");
    // 合并登记已消费干净
    expect(state.listRefreshInFlight).toBe(0);
    expect(state.listRefreshPending).toBe(0);
  });

  it("单纯刷新不自动选择新记录（首次进入列表后 selectedRunId 仍为空）", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().loadRuns();
    const state = useAppStore.getState();
    expect(state.runs).toHaveLength(2); // 新记录确实在列表里
    expect(state.selectedRunId).toBeNull();
    expect(state.detail).toBeNull();
  });

  it("尾随补发自身也在途：补发期间的新刷新被继续合并，不并发发射", async () => {
    // 判据：补发必须与普通刷新走同一套在途登记（而非旁路直发）。
    // 若补发走旁路，则补发进行中再来的刷新会被误判为"无人在途"而并发发射。
    await useAppStore.getState().loadRuns();
    const releaseFirst = gateList();
    const inFlight = useAppStore.getState().loadRuns();
    await useAppStore.getState().loadRuns(); // 登记尾随
    expect(useAppStore.getState().listRefreshPending).toBe(1);

    // 收紧：放开第一次后立刻挂上新 gate，让"补发"这一轮也停在在途状态。
    // 注意 releaseFirst() 会清掉 listGate，故新 gate 必须在它之后同步挂上。
    releaseFirst();
    const releaseSecond = gateList();
    // 等补发真正发起（微任务推进）
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    const duringRefire = controller.listCalls;
    expect(duringRefire).toBe(3); // 补发已发出且仍在途

    // 补发在途期间的刷新：必须被合并（不发新请求）
    await useAppStore.getState().loadRuns();
    expect(controller.listCalls).toBe(duringRefire);
    expect(useAppStore.getState().listRefreshPending).toBe(1);

    releaseSecond();
    await inFlight;
    expect(useAppStore.getState().listRefreshInFlight).toBe(0);
    expect(useAppStore.getState().listRefreshPending).toBe(0);
  });

  it("切换不重载：setView 与 selectRun 都不触发列表请求", async () => {
    await useAppStore.getState().loadRuns();
    const before = controller.listCalls;

    useAppStore.getState().setView("tree");
    await useAppStore.getState().selectRun("r_01");
    useAppStore.getState().setView("trace");
    await useAppStore.getState().selectRun("r_02");

    expect(controller.listCalls).toBe(before);
  });

  it("列表刷新失败可重试：保留旧记录、给出可读错误与未更新标记，重试后恢复", async () => {
    await useAppStore.getState().loadRuns();
    expect(useAppStore.getState().runs).toHaveLength(1);
    await useAppStore.getState().selectRun("r_01");
    const stepId =
      useAppStore.getState().detail?.spans.find((s) => s.kind === "agent.step")?.id ?? "";
    useAppStore.getState().selectSpan(stepId);

    // 第 1 次成功、第 2 次失败、第 3 次成功
    controller.listEnvelopesByCall = [
      ok({ runs: [rootSummary], failed: [] }),
      { ok: false, error: { code: "LIST_FAILED", message: "traces 目录暂时不可读" } },
      ok({ runs: [forkedSummary, rootSummary], failed: [] }),
    ];

    await useAppStore.getState().loadRuns(); // 失败的一次

    const afterFailure = useAppStore.getState();
    // 保留旧记录（不清空）并标记未更新
    expect(afterFailure.runs.map((r) => r.id)).toEqual(["r_01"]);
    expect(afterFailure.listStale).toBe(true);
    expect(afterFailure.loadingList).toBe(false);
    expect(afterFailure.error).toContain("仍显示上次结果");
    // 不生成假记录、不清空已成功加载的阅读位置
    expect(afterFailure.readingOf("r_01").spanId).toBe(stepId);
    expect(afterFailure.selectedRunId).toBe("r_01");
    expect(afterFailure.detail?.meta.id).toBe("r_01");

    // 重试成功：旧记录被替换为新结果，未更新标记清除
    await useAppStore.getState().loadRuns();
    const afterRetry = useAppStore.getState();
    expect(afterRetry.runs.map((r) => r.id)).toEqual(["run_forked", "r_01"]);
    expect(afterRetry.listStale).toBe(false);
    expect(afterRetry.error).toBeNull();
    expect(afterRetry.readingOf("r_01").spanId).toBe(stepId);
  });

  it("首次列表读取失败：给可重试错误，不标未更新、不生成假记录", async () => {
    controller.listEnvelope = {
      ok: false,
      error: { code: "LIST_FAILED", message: "数据目录不存在" },
    };
    await useAppStore.getState().loadRuns();

    const state = useAppStore.getState();
    expect(state.runs).toEqual([]);
    expect(state.listLoaded).toBe(false);
    expect(state.listStale).toBe(false); // 从来没有可过期的数据
    expect(state.loadingList).toBe(false);
    expect(state.error).toContain("读取 run 列表失败");
  });

  it("列表结构非法同样不倒退：保留旧记录并标未更新", async () => {
    await useAppStore.getState().loadRuns();
    controller.listEnvelope = ok({ runs: "not-an-array" } as never);
    await useAppStore.getState().loadRuns();

    const state = useAppStore.getState();
    expect(state.runs.map((r) => r.id)).toEqual(["r_01"]);
    expect(state.listStale).toBe(true);
    expect(state.error).toContain("仍显示上次结果");
  });
});
