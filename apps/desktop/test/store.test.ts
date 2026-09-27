import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import * as sessionLib from "../src/renderer/src/lib/operation-session";
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
import { FAKE_EPOCH, statusSnapshot, toExecuted } from "./helpers/operation-channels";

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
/** r_02 的详情：换一组 span id，用于验证两条 run 的阅读状态互不串 */
const otherDetail: RunDetail = {
  ...rootDetail,
  meta: { ...rootDetail.meta, id: "r_02" },
  spans: rootDetail.spans.map((s, i) => ({ ...s, id: `${s.id}_b${i}` })),
  leafSpanIds: rootDetail.spans.map((s, i) => `${s.id}_b${i}`),
};

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
  /**
   * U4（tasks 4.9）：每次主动提交带的执行身份（通道 + epoch + operationId）。
   * 断言"每次提交新 ID、epoch 来自握手"，而不是只看请求体。
   */
  activeOperations: Array<{ channel: string; epoch: string; operationId: string }>;
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
  /** 让指定 run 的 getRun 返回信封失败（供"首次详情失败不循环跳转"用例） */
  getRunFailureFor: string | undefined;
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
    // U4：主动入口提交前先握手取 epoch（默认给一份自洽的空闲快照）
    operationsStatus: async () => ok(statusSnapshot()),
    operationsReconcile: async () => ({
      ok: false as const,
      error: { code: "NOT_STUBBED", message: "本桩未实现核对" },
    }),
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
      if (c.getRunFailureFor === id) {
        return {
          ok: false,
          error: { code: "RUN_READ_FAILED", message: "该 run 的源文件读取失败" },
        };
      }
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
    forkRun: async (envelope) => {
      const request = envelope.request;
      c.activeOperations.push({ channel: "runs:fork", ...envelope.operation });
      c.forkRequests.push({
        parentRunId: request.parentRunId,
        atSpanId: request.atSpanId,
        value: request.edit.value,
        // 未传时不写该键：与真实请求体一致（普通父本请求里没有 execution）
        ...(request.execution === undefined ? {} : { execution: request.execution }),
      });
      return toExecuted(c.forkEnvelope ?? ok({ id: "run_forked" }), envelope.operation);
    },
    promptFork: async (envelope) => {
      const request = envelope.request;
      c.activeOperations.push({ channel: "runs:promptFork", ...envelope.operation });
      c.promptForkRequests.push({
        parentRunId: request.parentRunId,
        field: request.edit.field,
        value: request.edit.value,
      });
      return toExecuted(
        c.promptForkEnvelope ?? ok({ id: "run_prompt_forked" }),
        envelope.operation,
      );
    },
    getSettings: async (): Promise<Envelope<SettingsState>> =>
      ok({ configured: false, baseURL: null, model: null, encryption: "safe" }),
    saveSettings: async () => ok({ configured: true }),
    clearSettings: async () => ok({ configured: false }),
    createRun: async (envelope) => {
      c.activeOperations.push({ channel: "runs:create", ...envelope.operation });
      c.createRunRequests.push(envelope.request);
      return toExecuted(c.createRunEnvelope ?? ok({ id: "run_created" }), envelope.operation);
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
  activeOperations: [],
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
    readingInvalidated: false,
    loadingList: false,
    loadingDetail: false,
    listLoaded: false,
    listStale: false,
    listRefreshInFlight: 0,
    listRefreshPending: 0,
    searchQuery: "",
    initialSelectionAttempted: false,
    sourceUnavailable: false,
    sourceUnavailableReason: "unknown",
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
    createDialogOpen: false,
    settingsSection: null,
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

describe("store：runs:create 流转（A1 / B 2.1 请求透传 + U5 3.1 入口不再消费响应）", () => {
  it("成功：请求状态回到 idle，列表刷新与选中新 run 都由入口移除（收尾归终态消费）", async () => {
    await useAppStore.getState().loadRuns();
    const before = controller.listCalls;
    const created = await useAppStore
      .getState()
      .createRun({ systemPrompt: "你是助手。", userMessage: "解释一下时间旅行调试" });
    expect(created).toBe(true);

    const state = useAppStore.getState();
    // U5 任务 3.1 的**有意契约变更**：`creatingRun` 不再有 "success" 这个值——
    // 响应只证明请求明确返回，运行结局另由可信身份核实（见 operation-create-closure.test.ts）。
    expect(state.creatingRun).toBe("idle");
    expect(state.createRunError).toBeNull();
    // 纯对话请求里不带 workspace 键（main 据此走空工具表 + v1）
    expect(controller.createRunRequests).toEqual([
      { systemPrompt: "你是助手。", userMessage: "解释一下时间旅行调试" },
    ]);
    expect(
      controller.createRunRequests[0] !== undefined &&
        "workspace" in controller.createRunRequests[0],
    ).toBe(false);
    // 本文件的 status 桩答"没有任何登记操作"⇒ 终态消费无事可做 ⇒ 入口这条路零次列表刷新、
    // 零导航（旧实现在这里刷一次列表并把信封里的 id 选成当前运行）
    expect(controller.listCalls).toBe(before);
    expect(state.selectedRunId).toBeNull();
    expect(state.resultReads.byKey).toEqual({});
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
    expect(useAppStore.getState().creatingRun).toBe("idle");
  });

  it("失败：置 error 并保留错误码，入口不再自己刷列表（失败运行的可见性由终态消费负责）", async () => {
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
    // U5 任务 3.1：那条已落盘的 error run 之所以可见，是因为 main 把它的 id 挂在了操作上，
    // 终态消费据此刷**一次**列表并按该可信 ID 读详情（用例见 operation-create-closure.test.ts）；
    // 入口自己再拉一次列表是"用响应当结果"的旧形态，已移除。
    expect(controller.listCalls).toBe(before);
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

describe("store：滚动与展开恢复接线（任务 3.6）", () => {
  it("跨运行返回恢复阅读：滚动位置与长文本展开在回到 A 后都还在", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    const llmId = useAppStore.getState().detail?.spans.find((s) => s.kind === "llm.call")?.id ?? "";
    expect(llmId).not.toBe("");

    // 在 A 上：展开一块长文本 + 滚动概览与步骤目录
    useAppStore.getState().setReadingScroll("r_01", "overview", 480);
    useAppStore.getState().setReadingScroll("r_01", "steps", 260);
    useAppStore.getState().setCallReading("r_01", llmId, { expanded: ["content"] });
    useAppStore.getState().selectSpan(llmId);

    await useAppStore.getState().selectRun("r_02");
    await useAppStore.getState().selectRun("r_01");

    const state = useAppStore.getState();
    expect(state.readingOf("r_01").overviewScrollTop).toBe(480);
    expect(state.readingOf("r_01").stepsScrollTop).toBe(260);
    expect(state.readingOf("r_01").calls[llmId]?.expanded).toEqual(["content"]);
    expect(state.selectedSpanId).toBe(llmId);
    // B 完全没被污染
    expect(state.readingOf("r_02").overviewScrollTop).toBe(0);
    expect(state.readingOf("r_02").calls[llmId]).toBeUndefined();
  });

  it("重读后历史 span 已不存在 ⇒ 回退默认位置并置失效提示，不选另一 run 的同 ID span", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    // 先制造一条"指向不存在 span"的历史（模拟记录被重写/缩减后的旧位置）
    useAppStore.getState().selectSpan("s_vanished");
    expect(useAppStore.getState().readingInvalidated).toBe(false);

    // 重读同一 run：本次详情里没有 s_vanished ⇒ 必须回退 + 提示
    await useAppStore.getState().selectRun("r_02");
    useAppStore.getState().selectSpan("s_vanished_b0"); // B 里也不存在
    await useAppStore.getState().selectRun("r_01");

    const state = useAppStore.getState();
    expect(state.readingInvalidated).toBe(true);
    // 回退到本详情里的默认位置（首个自有 llm/tool 调用），**不是** s_vanished 借来的同 ID
    expect(state.selectedSpanId).not.toBe("s_vanished");
    expect(state.selectedSpanId).not.toBe("s_vanished_b0");
    expect(state.selectedSpanId).not.toBeNull();
  });

  it("有效历史恢复 ⇒ 不误报失效", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    const llmId = useAppStore.getState().detail?.spans.find((s) => s.kind === "llm.call")?.id ?? "";
    useAppStore.getState().selectSpan(llmId);
    await useAppStore.getState().selectRun("r_02");
    await useAppStore.getState().selectRun("r_01");
    expect(useAppStore.getState().readingInvalidated).toBe(false);
    expect(useAppStore.getState().selectedSpanId).toBe(llmId);
  });

  it("用户明确选择后失效提示即清除（提示只作一次性告知）", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    useAppStore.getState().selectSpan("s_vanished");
    await useAppStore.getState().selectRun("r_02");
    await useAppStore.getState().selectRun("r_01");
    expect(useAppStore.getState().readingInvalidated).toBe(true);

    const llmId = useAppStore.getState().detail?.spans.find((s) => s.kind === "llm.call")?.id ?? "";
    useAppStore.getState().selectSpan(llmId);
    expect(useAppStore.getState().readingInvalidated).toBe(false);
  });

  it("切 run 时不把上一条 run 的未校验 spanId 带进新 run（详情到手才解析阅读位置）", async () => {
    controller.getRunDetailById = { r_01: rootDetail, r_02: otherDetail };
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    const aSpan = rootDetail.spans[0]?.id ?? "";
    useAppStore.getState().selectSpan(aSpan);

    // B 的详情里没有 aSpan（span id 带 _bN 后缀）⇒ 切到 B 后不得短暂高亮 aSpan
    await useAppStore.getState().selectRun("r_02");
    const bState = useAppStore.getState();
    expect(bState.selectedSpanId).not.toBe(aSpan);
    // 落到 B 的**默认位置**（首个自有 llm/tool 调用，不是数组第一个 span）
    const bFirstCall = otherDetail.spans.find(
      (s) => s.kind === "llm.call" || s.kind === "tool.invoke",
    );
    expect(bState.selectedSpanId).toBe(bFirstCall?.id);
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

describe("store：首次选择与筛选/源失效状态（任务 3.5）", () => {
  const failedItem = { file: "broken.jsonl", error: "第 2 行缺少 type 字段" };

  it("首次打开：列表首次加载成功后只尝试最近可读摘要对应的运行并进入概览", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().autoSelectInitialRun();

    const state = useAppStore.getState();
    // 只读了**一条** run（最近可读 = 列表倒序第一条）
    expect(controller.getRunCalls).toEqual(["r_01"]);
    expect(state.selectedRunId).toBe("r_01");
    expect(state.detail?.meta.id).toBe("r_01");
    // 进入概览（默认页签），不是步骤页
    expect(state.readingOf("r_01").tab).toBe("overview");
    expect(state.initialSelectionAttempted).toBe(true);
    expect(state.error).toBeNull();
  });

  it("首次打开且无运行：不请求详情、不选中，界面据此显示新建/录制入口", async () => {
    controller.listEnvelope = ok({ runs: [], failed: [] });
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().autoSelectInitialRun();

    const state = useAppStore.getState();
    expect(controller.getRunCalls).toEqual([]);
    expect(state.selectedRunId).toBeNull();
    expect(state.detail).toBeNull();
    expect(state.error).toBeNull();
    // 无运行不是失败：不标未更新、不留错误
    expect(state.listStale).toBe(false);
  });

  it("首次详情失败不循环跳转：留在该 run 的错误态，不自动遍历其他记录", async () => {
    // 两条记录，第一条（最近可读）的详情读不出来
    controller.listEnvelope = ok({ runs: [forkedSummary, rootSummary], failed: [] });
    controller.getRunFailureFor = "run_forked";

    await useAppStore.getState().loadRuns();
    await useAppStore.getState().autoSelectInitialRun();

    const state = useAppStore.getState();
    // 只尝试了第一条；失败后**没有**去试 r_01
    expect(controller.getRunCalls).toEqual(["run_forked"]);
    expect(state.selectedRunId).toBe("run_forked");
    expect(state.detail).toBeNull();
    expect(state.loadingDetail).toBe(false);
    expect(state.error).toContain("读取 run 失败");
    // 原位可重试：再调一次 autoSelectInitialRun 不会重新遍历（已尝试过）
    controller.getRunCalls = [];
    await useAppStore.getState().autoSelectInitialRun();
    expect(controller.getRunCalls).toEqual([]);

    // 关键：即使选中项被清空（例如用户返回无选中态）并再刷新列表，
    // 也不得「再试一次」——否则详情一直读不出来时会退化成静默遍历整个列表。
    controller.getRunFailureFor = undefined;
    useAppStore.setState({ selectedRunId: null, detail: null });
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().autoSelectInitialRun();
    expect(controller.getRunCalls).toEqual([]); // 一次都没再读
    expect(useAppStore.getState().selectedRunId).toBeNull();
  });

  it("已有选中项时首次自动选择不做任何事（幂等，不覆盖用户选择）", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    controller.getRunCalls = [];

    await useAppStore.getState().autoSelectInitialRun();
    expect(controller.getRunCalls).toEqual([]);
    expect(useAppStore.getState().selectedRunId).toBe("r_01");
  });

  it("筛选隐藏当前运行：提示可辨、不自动改选，主工作区状态原样保留", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    expect(useAppStore.getState().filterVisibility()).toEqual({
      hidden: false,
      hasActiveFilters: false,
    });

    // 搜索一个匹配不到当前运行的词
    useAppStore.getState().setSearchQuery("完全不匹配的词");
    const visibility = useAppStore.getState().filterVisibility();
    expect(visibility.hidden).toBe(true);
    expect(visibility.hasActiveFilters).toBe(true);
    // 不自动改选、详情保持
    expect(useAppStore.getState().selectedRunId).toBe("r_01");
    expect(useAppStore.getState().detail?.meta.id).toBe("r_01");

    // 清除搜索即恢复
    useAppStore.getState().setSearchQuery("");
    expect(useAppStore.getState().filterVisibility().hidden).toBe(false);
  });

  it("来源条件隐藏当前运行同样只提示不改选（含无 source 的老文件归本地记录）", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");

    // 切到"代理录制"，而 r_01 是本地记录 ⇒ 被隐藏
    useAppStore.getState().setSourceFilter("proxy");
    expect(useAppStore.getState().filterVisibility()).toEqual({
      hidden: true,
      hasActiveFilters: true,
    });
    expect(useAppStore.getState().selectedRunId).toBe("r_01");

    useAppStore.getState().setSourceFilter("local");
    expect(useAppStore.getState().filterVisibility().hidden).toBe(false);
  });

  it("搜索词只影响筛选，不改原 task 与选中运行", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    const taskBefore = useAppStore.getState().runs[0]?.task;

    useAppStore.getState().setSearchQuery("r_0");
    expect(useAppStore.getState().runs[0]?.task).toBe(taskBefore);
    expect(useAppStore.getState().selectedRunId).toBe("r_01");
  });

  it("已选源记录不可用（记录消失）：旧内容保留但执行入口禁用，重新出现即恢复", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    expect(useAppStore.getState().canExecuteFromSource()).toBe(true);

    // 刷新后列表里没有 r_01 了（源文件被移走），且没有读取失败文件
    controller.listEnvelope = ok({ runs: [forkedSummary], failed: [] });
    await useAppStore.getState().loadRuns();

    const state = useAppStore.getState();
    expect(state.sourceUnavailable).toBe(true);
    expect(state.sourceUnavailableReason).toBe("missing");
    // 旧内容保留（不擦掉用户正在看的东西），但不得据此执行
    expect(state.detail?.meta.id).toBe("r_01");
    expect(state.canExecuteFromSource()).toBe(false);
    // 不自动改选其他运行
    expect(state.selectedRunId).toBe("r_01");

    // 重新读取并校验通过 ⇒ 自动恢复
    controller.listEnvelope = ok({ runs: [rootSummary], failed: [] });
    await useAppStore.getState().loadRuns();
    expect(useAppStore.getState().sourceUnavailable).toBe(false);
    expect(useAppStore.getState().canExecuteFromSource()).toBe(true);
  });

  it("已选源记录不可用（读取失败）：报不可读而非消失，同样禁用执行", async () => {
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");

    controller.listEnvelope = ok({ runs: [], failed: [failedItem] });
    await useAppStore.getState().loadRuns();

    const state = useAppStore.getState();
    expect(state.sourceUnavailable).toBe(true);
    // 有失败文件 ⇒ 报"读取失败"，但**不**断言是哪一条（只按列表事实陈述）
    expect(state.sourceUnavailableReason).toBe("unreadable");
    expect(state.canExecuteFromSource()).toBe(false);
    expect(state.detail?.meta.id).toBe("r_01");
  });

  it("详情读取中不放行执行（读取态本身不是可执行态）", async () => {
    await useAppStore.getState().loadRuns();
    const release = gateList();
    const inFlight = useAppStore.getState().selectRun("r_01");
    // 详情在途：尚无 detail，但也不能因为"列表里有"就放行执行
    expect(useAppStore.getState().loadingDetail).toBe(true);
    expect(useAppStore.getState().canExecuteFromSource()).toBe(false);
    release();
    await inFlight;
    expect(useAppStore.getState().canExecuteFromSource()).toBe(true);
  });

  it("列表尚未成功加载时源状态为 unknown：不误报不可用、也不放行执行", async () => {
    // 先选中一条（列表加载成功），随后刷新失败且**从未**成功加载过（listLoaded 复位）
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().selectRun("r_01");
    // 模拟"没有可依据的事实"：把 listLoaded 复位（首次读取失败的等价状态）
    useAppStore.setState({ listLoaded: false, runs: [], failed: [] });

    const state = useAppStore.getState();
    expect(state.sourceAvailability().reason).toBe("unknown");
    expect(state.sourceUnavailable).toBe(false); // 不误报"源已消失"
    expect(state.canExecuteFromSource()).toBe(false); // 但没有可执行资格
  });
});

// ---------------------------------------------------------------------------
// U1 任务 4.2：全局栏 / 列表标题区**共用同一创建流程**（spec：desktop-ui delta）
// ---------------------------------------------------------------------------

describe("store：新建运行对话框开关（任务 4.2）", () => {
  it("setCreateDialogOpen 落到 store，全局栏与列表读同一份状态", () => {
    expect(useAppStore.getState().createDialogOpen).toBe(false);
    useAppStore.getState().setCreateDialogOpen(true);
    expect(useAppStore.getState().createDialogOpen).toBe(true);
    useAppStore.getState().setCreateDialogOpen(false);
    expect(useAppStore.getState().createDialogOpen).toBe(false);
  });

  it("两个入口写的是**同一个**字段（不存在「各开各的」两份本地状态）", () => {
    // 全局栏入口
    useAppStore.getState().setCreateDialogOpen(true);
    expect(useAppStore.getState().createDialogOpen).toBe(true);
    useAppStore.getState().setCreateDialogOpen(false);

    // 列表标题区入口——同一个 setter、同一个字段
    useAppStore.getState().setCreateDialogOpen(true);
    const flag = useAppStore.getState().createDialogOpen;
    expect(flag).toBe(true);
  });

  it("录制接入口把设置定位到代理分区，常规打开设置不定位", () => {
    expect(useAppStore.getState().settingsSection).toBe(null);
    useAppStore.getState().setSettingsSection("proxy");
    expect(useAppStore.getState().settingsSection).toBe("proxy");
    // 定位是一次性的：消费后清掉，避免用户手动收起又被拉回去
    useAppStore.getState().setSettingsSection(null);
    expect(useAppStore.getState().settingsSection).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// U4 任务 4.9（随 3.1–3.4 同批落地）：主动入口的真实消费——每次提交带新身份，
// 握手没成功就"本地未发送"（不提交、不进通信未知）。
// 这些断言打在线段上（api 收到的实际载荷），不是只测纯 reducer。
// ---------------------------------------------------------------------------

describe("U4 4.9 主动入口的执行身份", () => {
  const apiObject = (globalThis.window as unknown as { api: Record<string, unknown> }).api;

  it("三条主动通道都经同一适配器：epoch 来自握手、operationId 每次都是新 UUID", async () => {
    useAppStore.setState({ operations: sessionLib.initialSession() });
    controller.activeOperations.length = 0;
    await useAppStore.getState().loadRuns();
    expect(await useAppStore.getState().forkAt("r_01", "s_03", "编辑后的结果")).toBe(true);
    expect(
      await useAppStore.getState().promptFork("r_01", { field: "user_message", value: "换个问法" }),
    ).toBe(true);
    expect(
      await useAppStore.getState().createRun({ systemPrompt: "", userMessage: "新任务" }),
    ).toBe(true);

    expect(controller.activeOperations.map((one) => one.channel)).toEqual([
      "runs:fork",
      "runs:promptFork",
      "runs:create",
    ]);
    for (const one of controller.activeOperations) {
      expect(one.epoch).toBe(FAKE_EPOCH);
      expect(one.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    }
    // 同一会话内三次提交互不相同（失败重试同样换新 ID，不复用被封禁/已结束的许可）
    expect(new Set(controller.activeOperations.map((one) => one.operationId)).size).toBe(3);
  });

  it("握手失败 ⇒ 本地未发送：不提交业务请求，错误码可针对性提示", async () => {
    useAppStore.setState({ operations: sessionLib.initialSession() });
    controller.activeOperations.length = 0;
    const forksBefore = controller.forkRequests.length;
    apiObject.operationsStatus = async () => ({
      ok: false,
      error: { code: "OPERATIONS_STATUS_FAILED", message: "通道断开" },
    });
    expect(await useAppStore.getState().forkAt("r_01", "s_03", "值")).toBe(false);
    const state = useAppStore.getState();
    expect(state.forking).toBe("error");
    expect(state.forkErrorCode).toBe("MAIN_HANDSHAKE_REQUIRED");
    expect(state.forkError).toContain("未发送");
    // 一次业务请求都没发出（不是"发出去后状态未知"）
    expect(controller.forkRequests).toHaveLength(forksBefore);
    expect(controller.activeOperations).toHaveLength(0);
  });

  it("握手返回非法快照 ⇒ 同样按未发送处理，不部分采纳", async () => {
    useAppStore.setState({ operations: sessionLib.initialSession() });
    apiObject.operationsStatus = async () => ({
      ok: true,
      data: { epoch: "not-a-uuid", registryVersion: 0, operations: [] },
    });
    expect(await useAppStore.getState().forkAt("r_01", "s_03", "值")).toBe(false);
    expect(useAppStore.getState().operations.epoch).toBeNull();
    expect(useAppStore.getState().forkErrorCode).toBe("MAIN_HANDSHAKE_REQUIRED");
  });
});
