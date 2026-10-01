import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunDetail, WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyCompareReadSession } from "../src/renderer/src/lib/compare-state";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import type { RunReadingState } from "../src/renderer/src/lib/reading-state";
import { emptyResultReadStore } from "../src/renderer/src/lib/result-verification";
import { deriveRunSummary } from "../src/shared/derive";
import { installOperationChannels } from "./helpers/operation-channels";

// U8 6.11 起 returnToAuxSource 用 requestAnimationFrame 回焦（4fdcc96）；本文件是裸 node
// 环境（无 DOM），焦点恢复契约由 aux-workspace-entries（组件层）承载 ⇒ 这里给**永不触发**
// 的桩，只为不抛 ReferenceError——回调不执行，store 导航判据不受影响。
(globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame ??=
  () => 0;

/**
 * U8（unify-recording-and-experiment-workspaces）任务 1.3 的 **store 接线**：
 * 辅助工作区进入 / 返回 / 重复进入守卫。
 *
 * 判据来源：design D1 + delta 场景（逐字标题）：
 * - 「运行入口打开明确实验目标」——进入即显式绑定目标，正文占主工作区；
 * - 「切运行不更换实验父本」——`selectRun` 永不改写目标，来源引用在 selectRun 离开时保留；
 * - 「缺凭据转录制再返回精确编辑」——messages→录制→返回回到 messages；
 * - 「离开实验恢复不带计划许可」的导航半边——离开/返回只动导航状态，计划/许可归 §3。
 *
 * ⚠️ 复位表纪律：本文件共享同一个 `useAppStore` 单例，U8 新增的五个会话字段
 * （三个来源引用 + 两个目标）必须逐条复位，否则上一条用例的现场会渗进下一条。
 */

const SOURCE = "run_aux_source";
const ELSEWHERE = "run_aux_elsewhere";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const recordOf = (name: string): RunRecord => readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));

function detailOf(name: string, id: string): RunDetail {
  const record = recordOf(name);
  const meta = record.meta.id === id ? record.meta : { ...record.meta, id };
  return {
    meta,
    spans: record.spans,
    events: record.events,
    status: record.status,
    chain: [{ meta, fork: record.meta.fork }],
    leafSpanIds: record.spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

const READING_DEFAULT: RunReadingState = {
  tab: "overview",
  spanId: null,
  expandedSteps: {},
  overviewScrollTop: 0,
  stepsScrollTop: 0,
  overviewExpanded: [],
  calls: {},
};

const calls: string[] = [];

const apiStub: Record<string, unknown> = {
  compareRuns: async (): Promise<Envelope<never>> =>
    // 1.6 只测导航与批次事实不变式，不测比较结论：给受控失败信封即可（结论 rejected 无碍导航）
    ({
      ok: false,
      error: { code: "UNUSED", message: "比较结论不在本文件断言范围" },
    }) as unknown as Envelope<never>,
  listRuns: async (): Promise<Envelope<ListRunsData>> => {
    calls.push("runs:list");
    return ok({
      runs: [
        { ...deriveRunSummary(recordOf("u1-ok")), id: SOURCE },
        { ...deriveRunSummary(recordOf("u1-ok")), id: ELSEWHERE },
      ],
      failed: [],
    });
  },
  getRun: async (id: string): Promise<Envelope<RunDetail>> => {
    calls.push(`runs:get:${id}`);
    return ok(detailOf("u1-ok", id));
  },
};
installOperationChannels(apiStub);

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const stateOf = () => useAppStore.getState();

beforeEach(async () => {
  calls.length = 0;
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    drafts: draftLib.emptyDraftRepo(),
    runs: [],
    failed: [],
    listLoaded: false,
    listStale: false,
    listRefreshInFlight: 0,
    listRefreshPending: 0,
    initialSelectionAttempted: false,
    error: null,
    selectedRunId: null,
    selectedSpanId: null,
    detail: null,
    readingByRun: {},
    navIntents: { byOperationId: {} },
    navGeneration: 0,
    view: "trace",
    createReturnLocation: null,
    compareReturnLocation: null,
    // U8 新增五字段：上一条用例的现场不得渗进下一条
    recordingReturnLocation: null,
    experimentReturnLocation: null,
    messagesReturnLocation: null,
    experimentTarget: null,
    messagesTarget: null,
    experimentSource: { phase: "idle", detail: null, errorMessage: null },
    // U8 5.1b：messages 源四态同表复位
    messagesSource: { phase: "idle", detail: null, errorMessage: null },
    // U7 比较族复位（1.6 往返用例的现场不得跨 describe 渗漏）
    compareIds: [],
    compareNotice: null,
    compareRead: emptyCompareReadSession(),
    comparePair: null,
    compareStepSelection: { left: null, right: null },
    comparePrefixFolded: { left: true, right: true },
    settingsSection: null,
  });
  await useAppStore.getState().loadRuns();
  calls.length = 0;
});

describe("U8 1.3：进入实验工作区——显式绑定目标（运行入口打开明确实验目标）", () => {
  it("从轨迹视图进入 ⇒ 视图切到实验、来源记全、目标显式绑定、代次推进", () => {
    useAppStore.setState({
      selectedRunId: SOURCE,
      readingByRun: {
        [SOURCE]: { ...structuredClone(READING_DEFAULT), tab: "steps", spanId: "s_03" },
      },
    });
    const before = stateOf().navGeneration;

    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });

    const state = stateOf();
    expect(state.view).toBe("experiment");
    expect(state.experimentTarget).toEqual({ runId: SOURCE, spanId: "s_01" });
    expect(state.experimentReturnLocation).toEqual({
      view: "trace",
      runId: SOURCE,
      tab: "steps",
      spanId: "s_03",
      file: null,
    });
    expect(state.navGeneration).toBe(before + 1);
  });

  it("实验页内重复进入（同目标）⇒ 来源同一对象、代次不推进、目标不变", () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });
    const first = stateOf().experimentReturnLocation;
    const generation = stateOf().navGeneration;

    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });

    expect(stateOf().experimentReturnLocation).toBe(first);
    expect(stateOf().navGeneration).toBe(generation);
    expect(stateOf().experimentTarget).toEqual({ runId: SOURCE, spanId: "s_01" });
  });

  it("实验页内显式换目标（另一 run 的入口）⇒ 来源沿用、目标按本次请求替换", () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });
    const first = stateOf().experimentReturnLocation;

    useAppStore.getState().openExperimentWorkspace({ runId: ELSEWHERE, spanId: "s_01" });

    expect(stateOf().view).toBe("experiment");
    expect(stateOf().experimentReturnLocation).toBe(first);
    expect(stateOf().experimentTarget).toEqual({ runId: ELSEWHERE, spanId: "s_01" });
  });

  it("设置往返（settingsSection 开合、视图未变）后再进实验入口 ⇒ 来源沿用（重跑编辑配置往返保持阅读的导航半边）", () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });
    const first = stateOf().experimentReturnLocation;

    // 设置是盖在页面之上的模态：视图始终是 experiment ⇒ 判据「人还在本页里」
    useAppStore.setState({ settingsSection: "proxy" });
    useAppStore.setState({ settingsSection: null });
    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });

    expect(stateOf().experimentReturnLocation).toBe(first);
    expect(stateOf().view).toBe("experiment");
  });

  it("messages 目标同口径绑定，与实验目标互不干扰", () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openMessagesWorkspace({ runId: SOURCE, spanId: "s_02" });

    expect(stateOf().view).toBe("messages");
    expect(stateOf().messagesTarget).toEqual({ runId: SOURCE, spanId: "s_02" });
    expect(stateOf().experimentTarget).toBeNull();
  });
});

describe("U8 1.3：切运行不更换实验父本（selectRun 不触碰目标）", () => {
  it("实验页在场时选中另一运行 ⇒ 离开到轨迹视图，但目标与来源引用都原样保留", async () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });
    const target = stateOf().experimentTarget;
    const location = stateOf().experimentReturnLocation;

    await useAppStore.getState().selectRun(ELSEWHERE);

    const state = stateOf();
    expect(state.view).toBe("trace");
    expect(state.selectedRunId).toBe(ELSEWHERE);
    expect(state.experimentTarget).toBe(target);
    expect(state.experimentReturnLocation).toBe(location);
  });

  it("messages 页同口径：切运行不更换 messagesTarget", async () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openMessagesWorkspace({ runId: SOURCE, spanId: "s_02" });
    const target = stateOf().messagesTarget;

    await useAppStore.getState().selectRun(ELSEWHERE);

    expect(stateOf().view).toBe("trace");
    expect(stateOf().messagesTarget).toBe(target);
  });
});

describe("U8 1.3：返回来源（一次性凭据 + 失效回退）", () => {
  it("trace 来源且运行还在 ⇒ 恢复视图与阅读位置，来源用掉", async () => {
    useAppStore.setState({
      selectedRunId: SOURCE,
      readingByRun: {
        [SOURCE]: { ...structuredClone(READING_DEFAULT), tab: "overview", spanId: null },
      },
    });
    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });
    // 在实验页里选中别的运行再返回（模拟"离开再回来"的返回路径）
    await useAppStore.getState().selectRun(ELSEWHERE);

    await useAppStore.getState().returnToAuxSource("experiment");

    const state = stateOf();
    expect(state.view).toBe("trace");
    expect(state.experimentReturnLocation).toBeNull();
    expect(state.selectedRunId).toBe(SOURCE);
    // 阅读位置按来源恢复到该 run 自己的会话状态
    expect(state.readingByRun[SOURCE]?.tab).toBe("overview");
  });

  it("来源运行已不在列表 ⇒ 回退轨迹视图并保留草稿场（不伪造旧位置）", async () => {
    useAppStore.setState({
      selectedRunId: SOURCE,
      experimentReturnLocation: {
        view: "trace",
        runId: "run_gone",
        tab: "overview",
        spanId: null,
        file: null,
      },
    });

    await useAppStore.getState().returnToAuxSource("experiment");

    const state = stateOf();
    expect(state.view).toBe("trace");
    expect(state.experimentReturnLocation).toBeNull();
    expect(state.selectedRunId).toBe(SOURCE);
  });

  it("没有来源（重载后）⇒ 回退轨迹视图，不凭空恢复", async () => {
    useAppStore.setState({ view: "experiment", experimentReturnLocation: null });

    await useAppStore.getState().returnToAuxSource("experiment");

    expect(stateOf().view).toBe("trace");
  });
});

describe("U8 1.3：messages→录制→返回（缺凭据转录制再返回精确编辑）", () => {
  it("从 messages 进录制 ⇒ 录制来源记 messages 视图；返回录制来源 ⇒ 回到 messages", () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openMessagesWorkspace({ runId: SOURCE, spanId: "s_02" });
    const messagesTarget = stateOf().messagesTarget;

    useAppStore.getState().openRecordingWorkspace();

    expect(stateOf().view).toBe("recording");
    expect(stateOf().recordingReturnLocation).toEqual({
      view: "messages",
      runId: null,
      tab: null,
      spanId: null,
      file: null,
    });

    return useAppStore
      .getState()
      .returnToAuxSource("recording")
      .then(() => {
        const state = stateOf();
        expect(state.view).toBe("messages");
        expect(state.recordingReturnLocation).toBeNull();
        // messages 目标与草稿不因录制往返丢失（导航半边；凭据重验归 5.2）
        expect(state.messagesTarget).toBe(messagesTarget);
      });
  });

  it("录制页内重复进入 ⇒ 来源沿用", () => {
    useAppStore.getState().openRecordingWorkspace();
    const first = stateOf().recordingReturnLocation;
    useAppStore.getState().openRecordingWorkspace();
    expect(stateOf().recordingReturnLocation).toBe(first);
  });
});

describe("U8 1.5：草稿定位路由到新工作区（openDraftAt）", () => {
  it("A/B 批次草稿 ⇒ 进入实验工作区并按草稿键绑定目标；不切全局选中、不登记 pending", async () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    await useAppStore.getState().openDraftAt({ runId: SOURCE, spanId: "s_01", field: "model_ab" });

    const state = stateOf();
    expect(state.view).toBe("experiment");
    expect(state.experimentTarget).toEqual({ runId: SOURCE, spanId: "s_01" });
    expect(state.pendingDraftTarget).toBeNull();
    expect(state.selectedRunId).toBe(SOURCE);
  });

  it("messages 草稿 ⇒ 进入 messages 工作区；草稿正文原样留在仓库（路由不触碰内容）", async () => {
    useAppStore.setState({
      drafts: draftLib.ensureCallDraft(
        draftLib.emptyDraftRepo(),
        { runId: SOURCE, spanId: "s_02", field: "messages" },
        "{ 非法 JSON 原样 }",
      ).repo,
    });
    await useAppStore.getState().openDraftAt({ runId: SOURCE, spanId: "s_02", field: "messages" });

    const state = stateOf();
    expect(state.view).toBe("messages");
    expect(state.messagesTarget).toEqual({ runId: SOURCE, spanId: "s_02" });
    // 精确身份的正文仍在（「messages 工作区恢复完整非法文本」的仓库半边）
    const entry = draftLib.callDraftOf(state.drafts, {
      runId: SOURCE,
      spanId: "s_02",
      field: "messages",
    });
    expect(entry?.text).toBe("{ 非法 JSON 原样 }");
  });

  it("result/system_prompt 的定位行为不变（仍走详情内编辑器的 pending 通道）", async () => {
    let selectedWith: string | null = null;
    useAppStore.setState({
      selectRun: async (id: string) => {
        selectedWith = id;
        useAppStore.setState({ selectedRunId: id });
      },
    });
    await useAppStore
      .getState()
      .openDraftAt({ runId: SOURCE, spanId: "s_03", field: "system_prompt" });

    expect(selectedWith).toBe(SOURCE);
    expect(stateOf().pendingDraftTarget).toEqual({
      runId: SOURCE,
      spanId: "s_03",
      field: "system_prompt",
    });
    expect(stateOf().view).toBe("trace");
  });
});

describe("U8 1.6：实验工作区与比较的往返（比较拒绝和返回实验不改批次事实）", () => {
  it("从实验进入比较 ⇒ 来源记 experiment、目标原样；返回 ⇒ 回到实验，目标与对照集合不动", async () => {
    useAppStore.setState({
      selectedRunId: SOURCE,
      compareIds: [SOURCE, ELSEWHERE],
    });
    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });
    const target = stateOf().experimentTarget;

    await useAppStore.getState().openCompareWorkspace();

    expect(stateOf().view).toBe("compare");
    // 来源引用记下实验工作区（进入比较不改结果/批次事实：目标原样、集合原样）
    expect(stateOf().compareReturnLocation).toEqual({
      view: "experiment",
      runId: null,
      tab: null,
      spanId: null,
      file: null,
    });
    expect(stateOf().experimentTarget).toBe(target);
    expect(stateOf().compareIds).toEqual([SOURCE, ELSEWHERE]);

    await useAppStore.getState().returnFromCompare();

    expect(stateOf().view).toBe("experiment");
    expect(stateOf().compareReturnLocation).toBeNull();
    expect(stateOf().experimentTarget).toBe(target);
    expect(stateOf().compareIds).toEqual([SOURCE, ELSEWHERE]);
  });
});

describe("U8 3.1b：实验目标的父本源读取（readExperimentSource）", () => {
  it("只读 runs:get：读到目标详情，不改选中项、不切视图、不动阅读代次", async () => {
    useAppStore.setState({ selectedRunId: SOURCE, view: "experiment" });
    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });
    const generation = stateOf().navGeneration;
    const selectedBefore = stateOf().selectedRunId;

    await useAppStore.getState().readExperimentSource();

    const source = stateOf().experimentSource;
    expect(source.phase).toBe("ready");
    expect(source.detail?.meta.id).toBe(SOURCE);
    expect(stateOf().selectedRunId).toBe(selectedBefore);
    expect(stateOf().view).toBe("experiment");
    expect(stateOf().navGeneration).toBe(generation);
    expect(calls.filter((c) => c.startsWith("runs:get:"))).toEqual([`runs:get:${SOURCE}`]);
  });

  it("读取失败 ⇒ phase failed + 错误保留（允许只读重试，不动草稿）", async () => {
    useAppStore.getState().openExperimentWorkspace({ runId: SOURCE, spanId: "s_01" });
    // 复位后重打桩：getRun 失败
    const failing = async (): Promise<Envelope<RunDetail>> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "父本已不在" },
    });
    useAppStore.setState({
      experimentSource: { phase: "idle", detail: null, errorMessage: null },
    });
    const api = (globalThis as { window: { api: Record<string, unknown> } }).window.api;
    const original = api.getRun;
    api.getRun = failing;
    try {
      await useAppStore.getState().readExperimentSource();
    } finally {
      api.getRun = original;
    }
    expect(stateOf().experimentSource.phase).toBe("failed");
    expect(stateOf().experimentSource.errorMessage).toContain("父本已不在");
  });

  it("换目标 ⇒ 源回到 idle（旧目标的详情不残留）", () => {
    useAppStore.setState({
      experimentSource: { phase: "ready", detail: null, errorMessage: null },
    });
    useAppStore.getState().openExperimentWorkspace({ runId: ELSEWHERE, spanId: "s_01" });
    expect(stateOf().experimentSource.phase).toBe("idle");
    expect(stateOf().experimentTarget).toEqual({ runId: ELSEWHERE, spanId: "s_01" });
  });
});

describe("U8 5.1b：messages 工作区目标的源读取（readMessagesSource，与 experimentSource 同判据）", () => {
  it("只读 runs:get：读到目标详情，不改选中项、不切视图、不动阅读代次", async () => {
    useAppStore.setState({ selectedRunId: SOURCE, view: "messages" });
    useAppStore.getState().openMessagesWorkspace({ runId: SOURCE, spanId: "s_01" });
    const generation = stateOf().navGeneration;
    const selectedBefore = stateOf().selectedRunId;

    await useAppStore.getState().readMessagesSource();

    const source = stateOf().messagesSource;
    expect(source.phase).toBe("ready");
    expect(source.detail?.meta.id).toBe(SOURCE);
    expect(stateOf().selectedRunId).toBe(selectedBefore);
    expect(stateOf().view).toBe("messages");
    expect(stateOf().navGeneration).toBe(generation);
    expect(calls.filter((c) => c.startsWith("runs:get:"))).toEqual([`runs:get:${SOURCE}`]);
  });

  it("读取失败 ⇒ phase failed + 错误保留（允许只读重试）", async () => {
    useAppStore.getState().openMessagesWorkspace({ runId: SOURCE, spanId: "s_01" });
    const failing = async (): Promise<Envelope<RunDetail>> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "源已不在" },
    });
    useAppStore.setState({ messagesSource: { phase: "idle", detail: null, errorMessage: null } });
    const api = (globalThis as { window: { api: Record<string, unknown> } }).window.api;
    const original = api.getRun;
    api.getRun = failing;
    try {
      await useAppStore.getState().readMessagesSource();
    } finally {
      api.getRun = original;
    }
    expect(stateOf().messagesSource.phase).toBe("failed");
    expect(stateOf().messagesSource.errorMessage).toContain("源已不在");
  });

  it("换目标 ⇒ 源回到 idle（旧目标的详情不残留）", () => {
    useAppStore.setState({
      messagesSource: { phase: "ready", detail: null, errorMessage: null },
    });
    useAppStore.getState().openMessagesWorkspace({ runId: ELSEWHERE, spanId: "s_01" });
    expect(stateOf().messagesSource.phase).toBe("idle");
    expect(stateOf().messagesTarget).toEqual({ runId: ELSEWHERE, spanId: "s_01" });
  });
});

describe("U8 1.3：经 setView 离开 = 来源用掉（与创建/比较同纪律）", () => {
  it("从实验页切视图 ⇒ 三个辅助来源引用清空；目标仍保留（显式凭据不随视图切换被抹）", () => {
    useAppStore.setState({
      view: "experiment",
      recordingReturnLocation: {
        view: "messages",
        runId: null,
        tab: null,
        spanId: null,
        file: null,
      },
      experimentReturnLocation: {
        view: "trace",
        runId: SOURCE,
        tab: "overview",
        spanId: null,
        file: null,
      },
      messagesReturnLocation: {
        view: "recording",
        runId: null,
        tab: null,
        spanId: null,
        file: null,
      },
      experimentTarget: { runId: SOURCE, spanId: "s_01" },
    });

    useAppStore.getState().setView("tree");

    const state = stateOf();
    expect(state.view).toBe("tree");
    expect(state.recordingReturnLocation).toBeNull();
    expect(state.experimentReturnLocation).toBeNull();
    expect(state.messagesReturnLocation).toBeNull();
    expect(state.experimentTarget).toEqual({ runId: SOURCE, spanId: "s_01" });
  });
});
