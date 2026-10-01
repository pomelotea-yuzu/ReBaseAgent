import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ok } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveMessagesResults } from "../src/renderer/src/lib/messages-results";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import {
  emptyResultReadStore,
  resultReadKeyOf,
  setResultRead,
} from "../src/renderer/src/lib/result-verification";
import { FAKE_EPOCH, statusSnapshot } from "./helpers/operation-channels";

/**
 * U8 任务 5.4：**messages 工作区的重发结果区**（delta「messages 失败定位与返回不丢草稿」）。
 *
 * 判据来源：design D7（操作和结果复用 proxyFork 提交、登记、按 ID 核实）。
 * 逐条呈现的动作可用性由 deriveOperationResultView 的既有判据承载（U5 3.5/3.6）；
 * 本文件钉**工作区层的目标圈定、登记身份呈现与只读边界**。
 *
 * ⚠️ 本包无 jsdom ⇒ 组件喂 props 走 renderToStaticMarkup。
 */

// ---------------------------------------------------------------------------
// 5.5 store 行为：主动重发结果不借被动记录（交错回归）
// ---------------------------------------------------------------------------

// ⚠️ 桩必须先于组件 import 就位：MessagesResults → OperationsEntry → store 的导入链
// 会在模块加载时捕获 window.api——事后赋值来不及（首轮实测踩中：listRuns not a function）。
const apiStub: Record<string, unknown> = {
  listRuns: async () => ({
    ok: true as const,
    data: {
      runs: [
        { id: "run_passive", task: "被动录制的另一个请求" },
        { id: NEW_RUN, task: "重发产生的新 run" },
      ],
      failed: [],
    },
  }),
  getRun: async () => ({
    ok: false as const,
    error: { code: "RUN_UNREADABLE", message: "详情读取失败（桩）" },
  }),
  operationsStatus: async () =>
    ok(statusSnapshot({ operations: [proxyRecord({ epoch: FAKE_EPOCH })] })),
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "NOT_STUBBED", message: "本桩未实现核对" },
  }),
  proxyToggle: async () =>
    ok({ enabled: false, running: false, port: 18787, upstreamBaseUrl: "", hasKey: false }),
  proxyStatus: async () =>
    ok({ enabled: false, running: false, port: 18787, upstreamBaseUrl: "", hasKey: false }),
  settingsGet: async () => ok({ configured: true, baseURL: null, model: null, encryption: "safe" }),
  saveSettings: async () => ok(undefined),
  clearSettings: async () => ok(undefined),
};

// 桩先就位再动态 import（store 模块读 window.api；proxyRecord/NEW_RUN 由闭包惰性引用）
(globalThis as Record<string, unknown>).window = { api: apiStub as unknown };
const { MessagesResultsSection } = await import("../src/renderer/src/components/MessagesResults");
const { useAppStore } = await import("../src/renderer/src/store");

const EPOCH = "99999999-9999-4999-8999-999999999999";
const PARENT = "run_proxy_source";
const SPAN = "s_llm";
const OP_1 = "88888888-8888-4888-8888-888888888881";
const OP_2 = "88888888-8888-4888-8888-888888888882";
const NEW_RUN = "run_resend_new";

function proxyRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    epoch: EPOCH,
    operationId: OP_1,
    target: { kind: "proxy", parentRunId: PARENT, atSpanId: SPAN },
    state: "settled",
    rejection: null,
    startedAt: "2026-10-01T10:00:00.000Z",
    settledAt: "2026-10-01T10:00:03.000Z",
    runIds: [NEW_RUN],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

const noopDraftPresent = (): boolean => false;

describe("5.4 结果区派生：按目标圈定 proxy 提交，只认登记身份", () => {
  it("只取目标 run + span 的 proxy 登记；异目标 / 异 kind / tombstone 不进", () => {
    const results = deriveMessagesResults({
      targetRunId: PARENT,
      targetSpanId: SPAN,
      operations: [
        proxyRecord(),
        proxyRecord({
          operationId: OP_2,
          target: { kind: "proxy", parentRunId: "run_other", atSpanId: SPAN },
        }),
        proxyRecord({
          operationId: OP_2,
          target: { kind: "modelAb", parentRunId: PARENT, armCount: 2 },
        }),
        proxyRecord({
          operationId: OP_2,
          target: null,
          state: "notAccepted",
          rejection: "reconcile_tombstone",
          startedAt: null,
          settledAt: null,
          requestOutcome: null,
          runIds: [],
          arms: [],
        }),
      ],
      reads: emptyResultReadStore(),
      draftPresentOf: noopDraftPresent,
    });
    expect(results.map((r) => r.operationId)).toEqual([OP_1]);
  });

  it("失败信封（requestOutcome=failed）逐条结果仍按可信 ID 呈现：请求事实分层、不冒充结局", () => {
    const results = deriveMessagesResults({
      targetRunId: PARENT,
      targetSpanId: SPAN,
      operations: [proxyRecord({ requestOutcome: "failed", errorCode: "LLM_UPSTREAM_503" })],
      reads: setResultRead(
        emptyResultReadStore(),
        { epoch: EPOCH, operationId: OP_1, runId: NEW_RUN },
        {
          phase: "verified",
          attempt: 1,
          facts: null,
          reason: null,
        },
      ),
      draftPresentOf: noopDraftPresent,
    });
    expect(results.length).toBe(1);
    expect(results[0]!.requestLine).toContain("请求异常");
    expect(results[0]!.requestLine).toContain("失败信封不影响按可信 ID 打开");
    // 逐条结果动作：打开 + 返回草稿（记录级）在场
    expect(results[0]!.view.items[0]!.actions).toContain("open-result");
    expect(results[0]!.view.canReturnDraft).toBe(false);
  });

  it("多次提交按 startedAt 确定排序；draftPresentOf 注入决定「返回编辑」入口", () => {
    const results = deriveMessagesResults({
      targetRunId: PARENT,
      targetSpanId: SPAN,
      operations: [
        proxyRecord({ operationId: OP_2, startedAt: "2026-10-01T11:00:00.000Z" }),
        proxyRecord({ operationId: OP_1, startedAt: "2026-10-01T10:00:00.000Z" }),
      ],
      reads: emptyResultReadStore(),
      draftPresentOf: (record) => record.operationId === OP_2,
    });
    expect(results.map((r) => r.operationId)).toEqual([OP_1, OP_2]);
    expect(results[0]!.view.canReturnDraft).toBe(false);
    expect(results[1]!.view.canReturnDraft).toBe(true);
  });
});

describe("5.4 结果区视图：登记身份 + 诚实空态 + 返回编辑", () => {
  const noop = (): undefined => undefined;

  it("渲染：结果块带提交身份、动作按钮、草稿在场给「返回编辑」", () => {
    const results = deriveMessagesResults({
      targetRunId: PARENT,
      targetSpanId: SPAN,
      operations: [
        proxyRecord({
          requestOutcome: "failed",
          errorCode: "PROXY_NO_KEY",
          runIds: [],
        }),
        proxyRecord({ operationId: OP_2, startedAt: "2026-10-01T11:00:00.000Z" }),
      ],
      reads: emptyResultReadStore(),
      draftPresentOf: (record) => record.operationId === OP_2,
    });
    const markup = renderToStaticMarkup(
      createElement(MessagesResultsSection, { results, onAction: noop }),
    );
    expect(markup).toContain("重发结果（按 main 登记提交）");
    expect(markup).toContain("2 次");
    expect(markup).toContain(`data-messages-result="${OP_2}"`);
    expect(markup).toContain(`data-messages-return-draft="${OP_2}"`);
    expect(markup).toContain("返回编辑");
    // 诚实说明行：失败/未知保留输入、不借被动记录、源 trace 不改写
    expect(markup).toContain("不用被动录制补结果");
    expect(markup).toContain("源 trace 不会被改写");
  });

  it("零提交 ⇒ 引导语（被动录制不会出现在这里），不渲染任何结果块", () => {
    const markup = renderToStaticMarkup(
      createElement(MessagesResultsSection, { results: [], onAction: noop }),
    );
    expect(markup).toContain("本目标还没有重发提交登记");
    expect(markup).toContain("被动录制不会");
    expect(markup).not.toContain("data-messages-result=");
  });
});

describe("5.4/5.5 源码级：结果区接线与只读边界", () => {
  const read = (rel: string): string => readFileSync(resolve(import.meta.dirname, rel), "utf8");

  it("MessagesWorkspace 接线：deriveMessagesResults 按目标圈定，动作走既有 store 口", () => {
    const code = read("../src/renderer/src/components/MessagesWorkspace.tsx");
    expect(code).toContain("deriveMessagesResults({");
    expect(code).toContain("targetRunId,");
    expect(code).toContain("targetSpanId,");
    expect(code).toContain("operations: operations.operations");
    expect(code).toContain("isOperationDraftPresent");
    expect(code).toContain("openOperationResult(identity)");
    expect(code).toContain("openOperationFailure(identity)");
    expect(code).toContain("retryResultRead(identity)");
    expect(code).toContain("returnOperationDraft({");
  });

  it("结果区不自建执行/写通道；呈现层不摸草稿正文与凭据", () => {
    const container = read("../src/renderer/src/components/MessagesWorkspace.tsx");
    // 容器只有只读读取与结果动作，没有任何执行/写调用
    for (const forbidden of ["proxyFork(", "forkRun(", "createRun(", "modelAb(", "proxyToggle("]) {
      expect(container, forbidden).not.toContain(forbidden);
    }
    const view = read("../src/renderer/src/components/MessagesResults.tsx");
    const imports = view
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    for (const forbidden of ["debugging-drafts", "draft-submission", "apiKey", "sourceToken"]) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 5.5 store 行为：主动重发结果不借被动记录（交错回归）
// ---------------------------------------------------------------------------
// 5.5 store 行为（apiStub 与动态 import 已提到模块顶部，见文件头说明）
// ---------------------------------------------------------------------------

describe("5.5 store 行为：主动重发结果不借被动记录（录制交错 / 写入失败保留输入）", () => {
  beforeEach(async () => {
    useAppStore.setState({
      operations: initialSession(),
      resultReads: emptyResultReadStore(),
      runs: [],
      failed: [],
      listLoaded: false,
    });
    await useAppStore.getState().refreshOperationStatus();
  });

  it("列表里被动录制与重发的新 run 并存 ⇒ 结果区只呈现登记的可信 ID（不从列表/目录猜）", async () => {
    // 列表刷新把两条 run 都带进来（被动录制 + 重发产物）
    await useAppStore.getState().loadRuns();
    const state = useAppStore.getState();
    const results = deriveMessagesResults({
      targetRunId: PARENT,
      targetSpanId: SPAN,
      operations: state.operations.operations,
      reads: state.resultReads,
      draftPresentOf: () => false,
    });
    expect(results.length).toBe(1);
    // 逐条结果只来自登记 runIds：被动录制的 run_passive 结构上进不了结果区
    expect(results[0]!.view.items.map((item) => item.runId)).toEqual([NEW_RUN]);
    // 自动核实（getRun 桩失败）⇒ 如实呈现不可读——绝不从列表里的被动记录预演结局
    expect(results[0]!.view.items[0]!.label).toBe("结果不可读");
    expect(results[0]!.view.items[0]!.actions).toEqual(["retry-read"]);
  });

  it("提交失败后读取项不可读只给重试，草稿在场 ⇒ 返回编辑入口保留（失败不丢输入）", async () => {
    // 失败登记：requestOutcome=failed 的 settled 记录 + 读取项不可读
    useAppStore.setState((current) => ({
      operations: {
        ...current.operations,
        operations: current.operations.operations.map((record) => ({
          ...record,
          requestOutcome: "failed" as const,
          errorCode: "PROXY_NO_KEY",
        })),
      },
      resultReads: setResultRead(
        emptyResultReadStore(),
        { epoch: FAKE_EPOCH, operationId: OP_1, runId: NEW_RUN },
        { phase: "unreadable", attempt: 1, facts: null, reason: "结果详情读取失败" },
      ),
    }));
    const results = deriveMessagesResults({
      targetRunId: PARENT,
      targetSpanId: SPAN,
      operations: useAppStore.getState().operations.operations,
      reads: useAppStore.getState().resultReads,
      draftPresentOf: () => true,
    });
    expect(results[0]!.view.items[0]!.label).toBe("结果不可读");
    expect(results[0]!.view.items[0]!.actions).toEqual(["retry-read"]);
    // 草稿在场 ⇒ 返回编辑入口保留（失败不丢输入）
    expect(results[0]!.view.canReturnDraft).toBe(true);
    // 读取项身份仍是登记的那条（不换 id、不借被动记录）
    expect(
      resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: OP_1, runId: NEW_RUN }) in
        useAppStore.getState().resultReads.byKey,
    ).toBe(true);
  });
});
