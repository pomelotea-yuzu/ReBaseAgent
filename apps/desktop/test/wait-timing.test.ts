import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ok } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveOperationRows } from "../src/renderer/src/lib/operation-list";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { deriveWaitView } from "../src/renderer/src/lib/wait-timing";
import { FAKE_EPOCH, statusSnapshot, toExecuted } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 5.2：**真实等待计时**。
 *
 * 判据来源：delta「跨页操作反馈展示真实等待与分层状态」之
 * 「执行中离页仍可查询等待」「终态和重载后的计时不伪造」；design D6 第一段。
 * 四条硬判据：时间事实只认本地提交时刻与 main startedAt/settledAt；终态停增；
 * 无时间事实不造数；时钟注入、判据不摸 Date.now()。
 *
 * ⚠️ 本包无 jsdom ⇒ 视图喂 props（与 `operation-result-view.test.ts` 同法），
 * 时钟 hook 只做源码级判据（它不该 import 任何执行/查询通道）。
 */

/** 主动通道桩：createRun 捕获**信封原文 + 调用时的在飞登记**（信封形状判据用它），status 恒答空闲快照 */
const createEnvelopes: { operation: Record<string, unknown>; request: unknown }[] = [];
const pendingSnapshots: { epoch: string; operationId: string; submittedAt: number }[] = [];
const apiStub: Record<string, unknown> = {
  operationsStatus: async () => ok(statusSnapshot({ registryVersion: 1, operations: [] })),
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "NOT_STUBBED", message: "本文件不测核对路径" },
  }),
  listRuns: async () => ok({ runs: [], failed: [] }),
  getRun: async (id: string) => ({
    ok: false as const,
    error: { code: "RUN_READ_FAILED", message: `桩不提供详情：${id}` },
  }),
  createRun: async (envelope: { operation: Record<string, unknown>; request: unknown }) => {
    createEnvelopes.push(envelope);
    // 在飞登记快照：此刻 pending 里应有本次身份与它的本地提交时刻
    pendingSnapshots.push(...useAppStore.getState().operations.pending);
    return toExecuted(
      ok({ id: "run_envelope_wait" }),
      envelope.operation as { epoch: string; operationId: string },
    );
  },
};
(globalThis as Record<string, unknown>).window = { api: apiStub };
const { OperationRowView } = await import("../src/renderer/src/components/OperationsEntry");
const { useAppStore } = await import("../src/renderer/src/store");

const EPOCH = "33333333-3333-4333-8333-333333333333";
const OP = "99999999-9999-4999-8999-999999999999";
const START_MS = Date.parse("2026-09-27T00:00:00.000Z");
const SUBMIT_MS = START_MS - 3_000; // 本地提交比 main 接受早 3 秒
const SETTLED_ISO = "2026-09-27T00:00:05.000Z";
const NOW_MS = START_MS + 10_000; // 接受后 10 秒

function record(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    epoch: EPOCH,
    operationId: OP,
    target: {
      kind: "result",
      mode: "plain",
      parentRunId: "r_parent",
      atSpanId: "s_03",
      editField: "result",
    },
    state: "running",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: null,
    runIds: [],
    experimentId: null,
    arms: [],
    requestOutcome: null,
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

describe("5.2 wait-timing 纯判据：只用给得出的时间事实", () => {
  it("running ∧ 本地提交时刻在场 ⇒ 自提交起，且明说不是模型耗时/进度", () => {
    const view = deriveWaitView({ record: record(), submittedAt: SUBMIT_MS, nowMs: NOW_MS });
    expect(view?.basis).toBe("submitted");
    expect(view?.text).toContain("自提交起已等待 13.0s");
    expect(view?.text).toContain("不是模型耗时");
    expect(view?.growing).toBe(true);
  });

  it("重载后只剩 main startedAt ⇒ 口径换成「自接受起」，不把接受冒充提交", () => {
    const view = deriveWaitView({ record: record(), submittedAt: null, nowMs: NOW_MS });
    expect(view?.basis).toBe("accepted");
    expect(view?.text).toContain("自接受起已等待 10.0s");
  });

  it("running 且没有任何时间事实（startedAt 缺失的异常记录）⇒ null，不造数", () => {
    expect(
      deriveWaitView({ record: record({ startedAt: null }), submittedAt: null, nowMs: NOW_MS }),
    ).toBeNull();
  });

  it("settled ⇒ 时长定格在 settledAt：nowMs 再大也不增长，文本写死计时已停止", () => {
    const settled = record({ state: "settled", settledAt: SETTLED_ISO, runIds: ["run_x"] });
    const at5s = deriveWaitView({ record: settled, submittedAt: null, nowMs: NOW_MS });
    const atHour = deriveWaitView({
      record: settled,
      submittedAt: null,
      nowMs: NOW_MS + 3_600_000,
    });
    expect(at5s).toEqual(atHour); // 终态后读数与"现在"无关
    expect(at5s?.text).toContain("自接受起等待 5.0s 后收口");
    expect(at5s?.text).toContain("计时已停止");
    expect(at5s?.growing).toBe(false);
  });

  it("notAccepted / reconcile 封禁 ⇒ null（契约禁止给未执行造时间）", () => {
    expect(
      deriveWaitView({
        record: record({
          state: "notAccepted",
          rejection: "busy",
          startedAt: null,
          settledAt: null,
        }),
        submittedAt: SUBMIT_MS,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it("未知历史：本地时刻在场 ⇒ 只报「自提交起已过」并否认进度含义；缺时刻 ⇒ null", () => {
    const withLocal = deriveWaitView({ record: null, submittedAt: SUBMIT_MS, nowMs: NOW_MS });
    expect(withLocal?.text).toContain("自提交起已过 13.0s");
    expect(withLocal?.text).toContain("不表示执行进度");
    expect(deriveWaitView({ record: null, submittedAt: null, nowMs: NOW_MS })).toBeNull();
  });

  it("跨时钟源乱序（本地时刻晚于 main 结束）不得产出负时长", () => {
    const view = deriveWaitView({
      record: record({ state: "settled", settledAt: SETTLED_ISO }),
      submittedAt: START_MS + 9_000, // 比 settledAt 还晚 4 秒（时钟抖动）
      nowMs: NOW_MS,
    });
    expect(view?.text).toContain("0ms");
    expect(view?.text).not.toContain("-");
  });
});

describe("5.2 面板接线：时长全部现算，组件不复算", () => {
  const sessionWithPending = (
    pending: { epoch: string; operationId: string; submittedAt: number }[],
  ) => ({
    ...initialSession(),
    epoch: EPOCH,
    operations: [record()],
    pending,
  });

  it("传时钟 ⇒ running 行带自提交计时；不传 ⇒ wait 为 null（U4 路径不变形）", () => {
    const withClock = deriveOperationRows(
      sessionWithPending([{ epoch: EPOCH, operationId: OP, submittedAt: SUBMIT_MS }]),
      undefined,
      { nowMs: NOW_MS },
    );
    const row = withClock.find((one) => one.operationId === OP);
    expect(row?.wait?.text).toContain("自提交起已等待");
    const without = deriveOperationRows(
      sessionWithPending([{ epoch: EPOCH, operationId: OP, submittedAt: SUBMIT_MS }]),
    );
    expect(without.find((one) => one.operationId === OP)?.wait).toBeNull();
  });

  it("settled 且 pending 已销账 ⇒ 口径自动退回「自接受起」（不假装还有本地时刻）", () => {
    const settledRecord = record({ state: "settled", settledAt: SETTLED_ISO, runIds: ["run_x"] });
    const rows = deriveOperationRows(
      { ...initialSession(), epoch: EPOCH, operations: [settledRecord], pending: [] },
      undefined,
      { nowMs: NOW_MS },
    );
    expect(rows.find((one) => one.operationId === OP)?.wait?.basis).toBe("accepted");
  });

  it("未知历史行也吃本地时刻：重载后（pending 无时刻）不显示计时", () => {
    const staleSession = {
      ...initialSession(),
      epoch: EPOCH,
      operations: [],
      pending: [
        { epoch: "11111111-1111-4111-8111-111111111111", operationId: OP, submittedAt: SUBMIT_MS },
      ],
    };
    const rows = deriveOperationRows(staleSession, undefined, { nowMs: NOW_MS });
    expect(rows[0]?.phase).toBe("unknown");
    expect(rows[0]?.wait?.text).toContain("自提交起已过");
    // NaN 时间戳不是时间事实（跨时钟源脏数据）：一律 null，绝不渲染 "NaNms" 假时长
    expect(
      deriveWaitView({
        record: null,
        submittedAt: Number.NaN,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it("行视图渲染计时文本与口径标注（喂 props）", () => {
    const rows = deriveOperationRows(
      {
        ...initialSession(),
        epoch: EPOCH,
        operations: [record()],
        pending: [{ epoch: EPOCH, operationId: OP, submittedAt: SUBMIT_MS }],
      },
      undefined,
      { nowMs: NOW_MS },
    );
    const markup = renderToStaticMarkup(
      createElement(OperationRowView, {
        row: rows.find((one) => one.operationId === OP)!,
        onReconcile: () => undefined,
        onAct: () => undefined,
      }),
    );
    expect(markup).toContain("自提交起已等待 13.0s");
    expect(markup).toContain('data-wait-basis="submitted"');
  });
});

describe("5.2 store 侧：在飞登记带本地提交时刻，信封不外带它", () => {
  beforeEach(async () => {
    createEnvelopes.length = 0;
    pendingSnapshots.length = 0;
    useAppStore.setState({
      operations: initialSession(),
      runs: [],
      failed: [],
      error: null,
      creatingRun: "idle",
      createRunError: null,
      createRunErrorCode: null,
      createSourceRef: null,
      selectedRunId: null,
      selectedSpanId: null,
      detail: null,
      readingByRun: {},
      view: "trace",
      settingsSection: null,
    });
    await useAppStore.getState().refreshOperationStatus();
  });

  it("提交时 pending 身份含有限 submittedAt；IPC 信封 operation 只有契约里的两键", async () => {
    const before = Date.now();
    const returned = await useAppStore
      .getState()
      .createRun({ systemPrompt: "", userMessage: "等待计时探针" });
    expect(returned).toBe(true);
    expect(createEnvelopes.length).toBe(1);
    // main 的 OperationIdentitySchema 是 strict 的：多带 submittedAt 会被判非法形状
    expect(Object.keys(createEnvelopes[0]?.operation ?? {}).sort()).toEqual([
      "epoch",
      "operationId",
    ]);
    expect(pendingSnapshots.length).toBe(1);
    const stamp = pendingSnapshots[0]?.submittedAt ?? Number.NaN;
    expect(Number.isFinite(stamp)).toBe(true);
    expect(stamp).toBeGreaterThanOrEqual(before - 1000);
    expect(pendingSnapshots[0]?.epoch).toBe(FAKE_EPOCH);
  });
});

describe("5.2 源码级：时钟受控、不驱动执行，判据不摸系统时间", () => {
  /** 禁用型断言先剥注释（纪律来源：ENGINEERING「源码级禁用型断言禁宽正则」——诚实句会提禁词） */
  const codeOf = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  it("use-wait-clock 不 import store/IPC/查询通道：计时到点只改读数", () => {
    const src = codeOf("../src/renderer/src/lib/use-wait-clock.ts");
    const imports = src
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    for (const forbidden of [
      "../store",
      "@shared/ipc",
      "window.api",
      "refreshOperationStatus",
      "reconcile",
    ]) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
  });

  it("wait-timing 纯判据不 Date.now()/不起定时器（时钟由调用方注入）", () => {
    const src = codeOf("../src/renderer/src/lib/wait-timing.ts");
    for (const forbidden of ["Date.now(", "setInterval", "setTimeout"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("OperationsEntry 只有一个时钟调用点，且受「面板开 ∧ 有可盯操作」约束；组件自己不动系统时间", () => {
    const src = codeOf("../src/renderer/src/components/OperationsEntry.tsx");
    expect(src.match(/useWaitClock\(/g)?.length).toBe(1);
    expect(src).toContain("useWaitClock(open && hasWatchableOperation(session))");
    expect(src).not.toContain("Date.now(");
    // 时长与增长判据不在组件里复算（它们在 lib/wait-timing）
    for (const forbidden of ["deriveWaitView", "clampElapsed", "formatDuration"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
