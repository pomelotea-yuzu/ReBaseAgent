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
  ForkRunResult,
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
  forkRequests: Array<{ parentRunId: string; atSpanId: string; value: string }>;
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
  /** 覆盖 getRun 的返回详情（默认 rootDetail）；供版本守卫接线用例注入被篡改载荷 */
  getRunDetail: RunDetail | undefined;
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
    getRun: async (): Promise<Envelope<RunDetail>> => ok(c.getRunDetail ?? rootDetail),
    forkRun: async (request) => {
      c.forkRequests.push({
        parentRunId: request.parentRunId,
        atSpanId: request.atSpanId,
        value: request.edit.value,
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
    // B 1.3/1.5 的只读辅助通道：chooseSource 已接（2.1），forkCapability 的 UI 属 2.2
    chooseSource: async () => {
      c.chooseSourceCalls += 1;
      return c.chooseSourceEnvelope ?? ok({ canceled: true });
    },
    forkCapability: async () => {
      throw new Error("store.test 不应调用 forkCapability");
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
  listCalls: 0,
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

beforeEach(() => {
  controller.forkEnvelope = undefined;
  controller.forkRequests = [];
  controller.promptForkEnvelope = undefined;
  controller.promptForkRequests = [];
  controller.createRunEnvelope = undefined;
  controller.createRunRequests = [];
  controller.chooseSourceEnvelope = undefined;
  controller.chooseSourceCalls = 0;
  controller.getRunDetail = undefined;
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
