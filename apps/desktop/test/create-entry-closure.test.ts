import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { CreateRunRequest, Envelope, ListRunsData, RunDetail, WindowApi } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { DraftSubmission } from "../src/renderer/src/lib/draft-submission";
import { CREATE_SUBMIT_TARGET } from "../src/renderer/src/lib/draft-submission";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore, resultReadKeyOf } from "../src/renderer/src/lib/result-verification";
import { deriveRunSummary } from "../src/shared/derive";
import { FAKE_EPOCH, statusSnapshot, toExecuted } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 3.1：**普通 / 隔离创建接进结果收尾**。
 *
 * 判据来源：design D3/D4 + delta「桌面端提供原生 run 创建入口」「结果按可信运行身份核实且
 * 读取重试不执行」。验收场景（delta 逐字标题）：
 * - 「新建 run 成功」——新 run **可选中**（不是"被自动选中"）；
 * - 「执行失败不产生半成品」——失败运行照样按可信身份可见、可读；
 * - 「失败信封仍可打开可信记录」——按登记的 runId 读，不解析错误文案、不扫列表最新项。
 *
 * 本文件钉的是**改判据的那一侧**：旧 `store.createRun` 在 ok 之后 `loadRuns()` +
 * `selectRun(信封里的 id)`，失败分支也自己再刷一次列表——响应的 id 与"响应即成功"因此成了
 * 结果真相源。U5 起这些一律归 §1/§2 已就位的终态消费点
 * （`submitActive` 回执 → `refreshOperationStatus` → `consumeSettledOperations`：
 * 解冻 → 整批至多一次列表刷新 → 按登记 `runIds` 串行核实 → 按修订收尾草稿）。
 *
 * ⚠️ 断言刻意不看"组件渲染出了什么"：创建对话框可能在响应前就被关闭/卸载
 *    （`resetCreateRun` 只复位展示态），收尾照样必须发生。
 */

/** 信封里那个 id：旧实现把它选成当前运行；U5 起它**不是**任何动作的依据 */
const ENVELOPE_RUN = "run_envelope_only";
/** main 登记的可信 id：唯一允许被读取的那个（与信封 id 刻意不同，才分得出谁在驱动） */
const REGISTERED = "run_registered_create";

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
  };
}

/** 创建操作的登记记录（普通/隔离只差 target.mode；其余字段填自洽值） */
function createRecord(overrides: Partial<OperationRecord>): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: "66666666-6666-4666-8666-666666666666",
    target: { kind: "create", mode: "plain" },
    state: "settled",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: "2026-09-27T00:00:05.000Z",
    runIds: [REGISTERED],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

const calls: string[] = [];
let snapshot: () => OperationRecord[] = () => [];
let registryVersion = 1;
let createEnvelope: Envelope<{ id: string }> | undefined;
/** 回执状态：settled = "响应即终态"（当前 main 形状）；running = 响应先到、结局后到 */
let ackState: "running" | "settled" = "settled";
/** 按 id 覆盖详情（默认给"自有正常终止"的 fixture） */
let details: Record<string, Envelope<RunDetail>> = {};
const createRunRequests: CreateRunRequest[] = [];

const apiStub: Record<string, unknown> = {
  operationsStatus: async () => {
    calls.push("operations:status");
    registryVersion += 1;
    return ok(statusSnapshot({ registryVersion, operations: snapshot(), activeOperationId: null }));
  },
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "NOT_STUBBED", message: "本文件不测核对路径" },
  }),
  listRuns: async (): Promise<Envelope<ListRunsData>> => {
    calls.push("runs:list");
    // 列表里就放着那条新 run（它"可选中"）——但选中与否不由入口决定
    const summary = { ...deriveRunSummary(recordOf("u1-ok")), id: REGISTERED };
    return ok({ runs: [summary], failed: [] });
  },
  getRun: async (id: string): Promise<Envelope<RunDetail>> => {
    calls.push(`runs:get:${id}`);
    return details[id] ?? ok(detailOf("u1-ok", id));
  },
  createRun: async (envelope: {
    operation: { epoch: string; operationId: string };
    request: CreateRunRequest;
  }) => {
    calls.push("runs:create");
    createRunRequests.push(envelope.request);
    const executed = toExecuted(
      createEnvelope ?? ok({ id: ENVELOPE_RUN }),
      envelope.operation,
      registryVersion + 1,
    );
    // 回执状态可切换：running = 响应先到、终态后由轮询/核对确认
    const operation = { ...executed.operation, state: ackState };
    return executed.ok
      ? { ...executed, operation }
      : { ...executed, operation: executed.operation === null ? null : operation };
  },
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const listCount = () => calls.filter((one) => one === "runs:list").length;
const readCalls = () => calls.filter((one) => one.startsWith("runs:get:"));
const entryOf = (assoc: DraftSubmission) =>
  useAppStore.getState().resultReads.byKey[
    resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: assoc.operationId, runId: REGISTERED })
  ];
const createDraft = () => useAppStore.getState().drafts.create;

/**
 * 与对话框同形：登记整份创建草稿 → 原子取提交关联（同一修订、同一快照），
 * 并把**该关联身份**的终态登记接进 status 桩（main 侧 operationId 由请求带来）。
 */
function seedCreate(
  userMessage: string,
  overrides: Partial<OperationRecord> = {},
): DraftSubmission {
  const store = useAppStore.getState();
  store.ensureCreateRunDraft();
  store.writeCreateRunDraft({ userMessage });
  store.setCreateSourceRef({ token: "tok_create", name: "lab", path: "D:\\lab" });
  const assoc = store.beginDraftSubmission({ channel: "create", target: CREATE_SUBMIT_TARGET });
  if (assoc === null) throw new Error("创建提交关联登记失败");
  snapshot = () => [createRecord({ operationId: assoc.operationId, ...overrides })];
  return assoc;
}

beforeEach(async () => {
  calls.length = 0;
  createRunRequests.length = 0;
  registryVersion = 1;
  createEnvelope = undefined;
  ackState = "settled";
  details = {};
  snapshot = () => [];
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: subLib.emptySubmissionStore(),
    runs: [],
    failed: [],
    listLoaded: false,
    listStale: false,
    listRefreshInFlight: 0,
    listRefreshPending: 0,
    error: null,
    selectedRunId: null,
    selectedSpanId: null,
    detail: null,
    readingByRun: {},
    view: "trace",
    creatingRun: "idle",
    createRunError: null,
    createRunErrorCode: null,
    createSourceRef: null,
    createDialogOpen: false,
  });
  // 握手一次（空闲会话）：入口的门禁要求已握手，之后各用例自行覆盖 snapshot
  await useAppStore.getState().refreshOperationStatus();
  calls.length = 0;
});

describe("3.1 创建入口不再消费响应（普通创建）", () => {
  it("「新建 run 成功」：按登记的可信 ID 收尾，零导航、列表只刷一次", async () => {
    const assoc = seedCreate("解释一下时间旅行调试");

    const returned = await useAppStore
      .getState()
      .createRun({ systemPrompt: "", userMessage: "解释一下时间旅行调试" }, assoc);

    expect(returned).toBe(true);
    // 唯一被读的是**登记里**的 id；信封那个 id 一次都不读（旧实现正是拿它去 selectRun）
    expect(readCalls()).toEqual([`runs:get:${REGISTERED}`]);
    expect(calls).not.toContain(`runs:get:${ENVELOPE_RUN}`);
    // 列表刷新只有终态消费的那一次（入口不再自己 loadRuns，也不重复刷）
    expect(listCount()).toBe(1);
    // 零导航：选中的运行、详情、页签、阅读状态、视图一概不动
    const state = useAppStore.getState();
    expect(state.selectedRunId).toBeNull();
    expect(state.detail).toBeNull();
    expect(state.readingByRun).toEqual({});
    expect(state.view).toBe("trace");
    expect(state.loadingDetail).toBe(false);
    // 「响应即成功」的展示态已不存在：请求交出后回到 idle
    expect(state.creatingRun).toBe("idle");
    expect(state.createRunError).toBeNull();
  });

  it("「新建 run 成功」的正常终止一侧：核实通过才按提交修订清理草稿与目录引用", async () => {
    const assoc = seedCreate("清理只认正常终止");

    await useAppStore
      .getState()
      .createRun({ systemPrompt: "", userMessage: "清理只认正常终止" }, assoc);

    expect(entryOf(assoc)?.phase).toBe("verified");
    expect(entryOf(assoc)?.facts?.normalEnd).toBe(true);
    const state = useAppStore.getState();
    // 整份创建草稿被清（CAS 命中提交修订）+ 该提交对应的目录引用同步失效
    expect(createDraft()).toBeNull();
    expect(state.createSourceRef).toBeNull();
    // 关联释放：不留第二份"将来可以替用户决定删什么"的凭据
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeUndefined();
  });

  it("结果不可读 ⇒ 解冻了也绝不先删草稿（关联留着等下一次核实）", async () => {
    details[REGISTERED] = {
      ok: false,
      error: { code: "RUN_READ_FAILED", message: "该 run 的源文件读取失败" },
    };
    const assoc = seedCreate("读不到就要留");

    await useAppStore
      .getState()
      .createRun({ systemPrompt: "", userMessage: "读不到就要留" }, assoc);

    expect(entryOf(assoc)?.phase).toBe("unreadable");
    const state = useAppStore.getState();
    expect(createDraft()?.userMessage).toBe("读不到就要留");
    expect(state.createSourceRef).not.toBeNull();
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeDefined();
    // 冻结已随明确返回解除（可继续编辑/重提），但清理没有发生
    expect(state.isDraftFrozen(CREATE_SUBMIT_TARGET)).toBe(false);
  });

  it("只读重试读到正常终止 ⇒ 这条响应路径当场完成收尾（不等下一轮 status）", async () => {
    details[REGISTERED] = {
      ok: false,
      error: { code: "RUN_READ_FAILED", message: "该 run 的源文件读取失败" },
    };
    const assoc = seedCreate("重试后才清");
    await useAppStore.getState().createRun({ systemPrompt: "", userMessage: "重试后才清" }, assoc);
    expect(createDraft()?.userMessage).toBe("重试后才清");

    // 详情恢复可读 ⇒ 显式只读重试（同一条身份、只走 runs:get）
    delete details[REGISTERED];
    const listBefore = listCount();
    await useAppStore
      .getState()
      .retryResultRead({ epoch: FAKE_EPOCH, operationId: assoc.operationId, runId: REGISTERED });

    expect(entryOf(assoc)?.facts?.normalEnd).toBe(true);
    expect(useAppStore.getState().drafts.create).toBeNull();
    // 重试只读：不额外刷列表、不导航、不清别的
    expect(listCount()).toBe(listBefore);
    expect(useAppStore.getState().selectedRunId).toBeNull();
  });
  it("响应先到、终态后到（回执 running）：响应不读结果也不清理，轮询到终态才收尾", async () => {
    ackState = "running";
    const assoc = seedCreate("结局由轮询决定");

    const returned = await useAppStore
      .getState()
      .createRun({ systemPrompt: "", userMessage: "结局由轮询决定" }, assoc);

    expect(returned).toBe(true);
    // 响应本身什么都不"决定"：零读取、零列表刷新、零导航，草稿仍在冻结
    expect(readCalls()).toEqual([]);
    expect(listCount()).toBe(0);
    expect(useAppStore.getState().selectedRunId).toBeNull();
    expect(useAppStore.getState().isDraftFrozen(CREATE_SUBMIT_TARGET)).toBe(true);
    expect(createDraft()?.userMessage).toBe("结局由轮询决定");
    // 回执 running ⇒ 轮询已排定；本用例自己手动推一次 status，定时器不参与（别跨用例渗漏）
    useAppStore.getState().stopOperationStatusPolling();

    // 轮询到终态 ⇒ 同一条消费路径：解冻 → 刷一次列表 → 按登记 ID 核实 → 按修订清理
    await useAppStore.getState().refreshOperationStatus();
    expect(readCalls()).toEqual([`runs:get:${REGISTERED}`]);
    expect(listCount()).toBe(1);
    const state = useAppStore.getState();
    expect(state.isDraftFrozen(CREATE_SUBMIT_TARGET)).toBe(false);
    expect(state.drafts.create).toBeNull();
    expect(state.createSourceRef).toBeNull();
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeUndefined();
  });
});

describe("3.1 失败信封仍按可信身份收尾（普通创建）", () => {
  const failEnvelope = (): void => {
    createEnvelope = {
      ok: false,
      error: {
        code: "CREATE_RUN_FAILED",
        message:
          "新建 run 执行失败：模型调用未完成（终止原因 error）。run run_x 已落盘，可在列表中点开该 run。",
      },
    };
  };

  it("「执行失败不产生半成品」：列表照样刷一次，失败运行按登记 ID 可读", async () => {
    failEnvelope();
    details[REGISTERED] = ok(detailOf("u1-error-detail", REGISTERED));
    const assoc = seedCreate("失败也要看得见", {
      requestOutcome: "failed",
      errorCode: "CREATE_RUN_FAILED",
    });

    const returned = await useAppStore
      .getState()
      .createRun({ systemPrompt: "", userMessage: "失败也要看得见" }, assoc);

    expect(returned).toBe(false);
    // 失败运行的可见性来自终态消费（登记里有它的 id），不是入口自己那次 loadRuns
    expect(listCount()).toBe(1);
    expect(readCalls()).toEqual([`runs:get:${REGISTERED}`]);
    const state = useAppStore.getState();
    // 请求事实与运行结局各占一行、互不覆盖
    expect(state.creatingRun).toBe("error");
    expect(state.createRunErrorCode).toBe("CREATE_RUN_FAILED");
    expect(state.createRunError).toContain("模型调用未完成");
    expect(entryOf(assoc)?.phase).toBe("verified");
    expect(entryOf(assoc)?.facts?.normalEnd).toBe(false);
    expect(entryOf(assoc)?.facts?.outcome.label).not.toBe("已结束");
    // 非正常终止 ⇒ 草稿与目录引用都保留
    expect(createDraft()?.userMessage).toBe("失败也要看得见");
    expect(state.createSourceRef).not.toBeNull();
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeDefined();
    // 失败也不产生导航
    expect(state.selectedRunId).toBeNull();
  });

  it("「失败信封仍可打开可信记录」的反面：登记没有 ID ⇒ 不解析文案、不扫列表", async () => {
    failEnvelope();
    const assoc = seedCreate("未定位就不猜", {
      runIds: [],
      requestOutcome: "failed",
      errorCode: "CREATE_RUN_FAILED",
    });

    await useAppStore
      .getState()
      .createRun({ systemPrompt: "", userMessage: "未定位就不猜" }, assoc);

    // 错误文案里明明写着 "run run_x 已落盘"，一次详情读取都不许发生
    expect(readCalls()).toEqual([]);
    expect(Object.keys(useAppStore.getState().resultReads.byKey)).toHaveLength(0);
    // 没有新运行身份 ⇒ 消费点也不刷列表（列表与结果分开报错）
    expect(listCount()).toBe(0);
    const state = useAppStore.getState();
    expect(state.createRunErrorCode).toBe("CREATE_RUN_FAILED");
    expect(createDraft()?.userMessage).toBe("未定位就不猜");
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeDefined();
  });
});

describe("3.1 隔离创建走同一条收尾（同一 store 动作）", () => {
  it("请求原样透传 workspace，收尾与清理同普通创建一条路", async () => {
    const assoc = seedCreate("读一下 a.txt", {
      target: { kind: "create", mode: "isolated" },
    });
    const request: CreateRunRequest = {
      systemPrompt: "",
      userMessage: "读一下 a.txt",
      workspace: { mode: "isolated_files", sourceToken: "tok_create", allowFileWrites: true },
    };

    const returned = await useAppStore.getState().createRun(request, assoc);

    expect(returned).toBe(true);
    // 授权与 token 不经渲染层改写（透传）
    expect(createRunRequests).toEqual([request]);
    expect(readCalls()).toEqual([`runs:get:${REGISTERED}`]);
    expect(listCount()).toBe(1);
    const state = useAppStore.getState();
    expect(state.selectedRunId).toBeNull();
    expect(createDraft()).toBeNull();
    expect(state.createSourceRef).toBeNull();
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeUndefined();
  });
});

describe("3.1 接线契约：旧局部分支不得复活", () => {
  const STORE_SRC = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/store.ts"),
    "utf8",
  );

  it("createRun 函数体里没有列表刷新、没有 selectRun；状态机没有 success", () => {
    const start = STORE_SRC.indexOf("async createRun(request, submission) {");
    const end = STORE_SRC.indexOf("resetCreateRun() {", start + 1);
    expect(start).toBeGreaterThan(-1);
    const body = STORE_SRC.slice(start, end);
    expect(body).not.toContain("get().loadRuns(");
    expect(body).not.toContain("get().selectRun(");
    // 清理凭据只在终态消费点与关联转存处释放：入口不碰草稿仓库
    expect(body).not.toContain("drafts");
    expect(STORE_SRC).not.toContain('creatingRun: "idle" | "in_progress" | "success" | "error"');
  });
});
