import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { OperationRecord } from "@shared/operations";
import { deriveOwnTerminalFacts } from "@shared/terminal-facts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OperationRow } from "../src/renderer/src/lib/operation-list";
import type { OperationResultView } from "../src/renderer/src/lib/operation-result-view";
import {
  buildOperationResultViews,
  deriveOperationResultView,
  resultViewKeyOf,
} from "../src/renderer/src/lib/operation-result-view";
import { deriveResultNotices, noticeKeyOf } from "../src/renderer/src/lib/result-notices";
import type { ResultReadStore } from "../src/renderer/src/lib/result-verification";
import { emptyResultReadStore, setResultRead } from "../src/renderer/src/lib/result-verification";

/**
 * U5（unify-run-execution-workflow）任务 3.5 / 3.6 的**呈现与通知判据**（纯函数 + 喂 props 的视图）。
 *
 * 判据来源：design D6 末段 + delta「失败定位和返回草稿明确可达」「核对结果只由用户明确打开」
 * 「恢复核对重试与批次结果只通知」「祖先结束与失败调用不能冒充本次事实」。
 *
 * ⚠️ 本包无 jsdom ⇒ 组件测试只能**喂 props**（行视图已导出），
 * store 订阅部分归 `operation-result-actions.test.ts`。
 * 视图组件所在文件树会经 store 摸到 `window.api` ⇒ 桩先就位，再动态 import
 * （ESM 静态 import 会提升到语句之前，与 `run-workspace.test.ts` 同法）。
 */
(globalThis as Record<string, unknown>).window = { api: {} };
const { OperationRowView } = await import("../src/renderer/src/components/OperationsEntry");

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const read = (name: string) => readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
const EPOCH = "44444444-4444-4444-8444-444444444444";
const OP = "66666666-6666-4666-8666-666666666666";
const RUN = "run_result_target";

/** 自有段换 id（构造"祖先前缀 + 自有段"时避免两份 fixture 撞车） */
function renamed(spans: readonly SpanLine[], prefix: string): SpanLine[] {
  return spans.map((span) => ({
    ...span,
    id: `${prefix}${span.id}`,
    parent: span.parent === null ? null : `${prefix}${span.parent}`,
  }));
}

function factsOf(input: Parameters<typeof deriveOwnTerminalFacts>[0]) {
  return deriveOwnTerminalFacts(input);
}

/** 自有失败调用：整段都是本 run 的 u1-error-detail ⇒ 定位得到 s_05 */
const ownFailure = factsOf({
  status: "completed",
  events: [{ event: "errored", reason: "error" }],
  spans: read("u1-error-detail").spans,
  leafSpanIds: read("u1-error-detail").spans.map((span) => span.id),
});
/** 祖先含失败调用、自有段正常 ⇒ 拿不到自有失败（spec 明令不得冒充） */
const ancestorOnlyFailure = (() => {
  const leaf = renamed(read("u1-ok").spans, "own_");
  return factsOf({
    status: "completed",
    events: [{ event: "errored", reason: "error" }],
    spans: [...read("u1-error-detail").spans, ...leaf],
    leafSpanIds: leaf.map((span) => span.id),
  });
})();
const normalEnd = factsOf({
  status: "completed",
  events: [{ event: "stopped", reason: "completed" }],
  spans: read("u1-ok").spans,
  leafSpanIds: read("u1-ok").spans.map((span) => span.id),
});

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
    state: "settled",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: "2026-09-27T00:00:05.000Z",
    runIds: [RUN],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

function reads(entry: Parameters<typeof setResultRead>[2] | undefined): ResultReadStore {
  return entry === undefined
    ? emptyResultReadStore()
    : setResultRead(emptyResultReadStore(), { epoch: EPOCH, operationId: OP, runId: RUN }, entry);
}

const verified = (facts: typeof normalEnd) =>
  ({ phase: "verified", attempt: 1, facts, reason: null }) as const;
const unreadable = (reason: string) =>
  ({ phase: "unreadable", attempt: 1, facts: null, reason }) as const;

describe("3.5 结果呈现：动作只给得出事实的那些", () => {
  it("尚未读过 ⇒ 只给「打开结果」，不预告任何结局", () => {
    const view = deriveOperationResultView({
      record: record(),
      reads: reads(undefined),
      draftPresent: true,
    });
    expect(view.kind).toBe("items");
    expect(view.items[0]?.label).toBe("结果待读取");
    expect(view.items[0]?.actions).toEqual(["open-result"]);
  });

  it("正在读取 ⇒ 一个动作都不给（避免点了个还在飞的东西）", () => {
    const view = deriveOperationResultView({
      record: record(),
      reads: reads({ phase: "reading", attempt: 1, facts: null, reason: null }),
      draftPresent: true,
    });
    expect(view.items[0]?.label).toBe("正在读取结果");
    expect(view.items[0]?.actions).toEqual([]);
  });

  it("「结果不可读只重试同一记录」⇒ 只给重读，且明说此时不做失败定位", () => {
    const view = deriveOperationResultView({
      record: record(),
      reads: reads(unreadable("结果读取失败（RUN_READ_FAILED）：源文件缺失")),
      draftPresent: true,
    });
    expect(view.items[0]?.label).toBe("结果不可读");
    expect(view.items[0]?.actions).toEqual(["retry-read"]);
    expect(view.items[0]?.detail).toContain("源文件缺失");
    expect(view.items[0]?.failureNote).toContain("不拿别的记录凑原因");
  });

  it("自有失败调用在场 ⇒ 给「查看失败调用」，并带真实错误正文", () => {
    expect(ownFailure.failure.llmCallSpanId).toBe("s_05");
    const view = deriveOperationResultView({
      record: record(),
      reads: reads(verified(ownFailure)),
      draftPresent: true,
    });
    // 展示标签**复用** shared 的唯一来源（各写一份必然与列表/概览口径分叉）
    expect(ownFailure.outcome.kind).toBe("error");
    expect(view.items[0]?.label).toBe(ownFailure.outcome.label);
    expect(view.items[0]?.actions).toEqual(["open-result", "view-failure"]);
    expect(ownFailure.failure.message).not.toBeNull();
    expect(view.items[0]?.detail).toContain(ownFailure.failure.message as string);
    expect(view.items[0]?.failureNote).toBeNull();
  });

  it("「祖先结束与失败调用不能冒充本次事实」⇒ 没有自有失败就没有入口，只有说明", () => {
    // 前置事实：祖先里有失败调用，但 leafSpanIds 之外的都不算本次原因
    expect(ancestorOnlyFailure.failure.llmCallSpanId).toBeNull();
    expect(ancestorOnlyFailure.failure.missingDetail).toBe(true);
    const view = deriveOperationResultView({
      record: record(),
      reads: reads(verified(ancestorOnlyFailure)),
      draftPresent: true,
    });
    expect(view.items[0]?.actions).toEqual(["open-result"]);
    expect(view.items[0]?.failureNote).toContain("不取祖先调用冒充原因");
  });

  it("正常结束 ⇒ 不给失败定位入口，并说清「本次不是以错误终止」", () => {
    const view = deriveOperationResultView({
      record: record(),
      reads: reads(verified(normalEnd)),
      draftPresent: true,
    });
    expect(view.items[0]?.label).toBe("已结束");
    expect(view.items[0]?.actions).toEqual(["open-result"]);
    expect(view.items[0]?.failureNote).toContain("没有失败调用可定位");
  });

  it("未定位（settled 无可信 id）⇒ 没有任何结果动作，只让核对登记", () => {
    const view = deriveOperationResultView({
      record: record({ runIds: [] }),
      reads: reads(undefined),
      draftPresent: true,
    });
    expect(view.kind).toBe("unlocated");
    expect(view.items).toEqual([]);
    expect(view.detail).toContain("不按列表最新项");
  });

  it("执行中 / 本次未接受 ⇒ 记录级说明，不出现「结果可读」的暗示", () => {
    const running = deriveOperationResultView({
      record: record({
        state: "running",
        settledAt: null,
        requestOutcome: null,
        runIds: [],
      }),
      reads: reads(undefined),
      draftPresent: true,
    });
    expect(running.label).toBe("执行中");
    expect(running.detail).toContain("不显示进度");
    const rejected = deriveOperationResultView({
      record: record({
        state: "notAccepted",
        rejection: "busy",
        runIds: [],
        startedAt: null,
        settledAt: null,
        requestOutcome: null,
      }),
      reads: reads(undefined),
      draftPresent: true,
    });
    expect(rejected.label).toBe("本次未接受");
    expect(rejected.detail).toContain("没有开始执行");
  });

  it("「失败定位和返回草稿明确可达」：草稿在才给返回；被清理后给回退说明且不复活", () => {
    const present = deriveOperationResultView({
      record: record(),
      reads: reads(verified(normalEnd)),
      draftPresent: true,
    });
    expect(present.canReturnDraft).toBe(true);
    expect(present.draftNote).toBeNull();

    const gone = deriveOperationResultView({
      record: record(),
      reads: reads(verified(normalEnd)),
      draftPresent: false,
    });
    expect(gone.canReturnDraft).toBe(false);
    expect(gone.draftNote).toContain("不复活旧内容");
  });

  it("批量派生的键与操作行的 key 同编码（两处不各造一份身份）", () => {
    const built = buildOperationResultViews({
      records: [record()],
      reads: reads(verified(normalEnd)),
      draftPresentOf: () => true,
    });
    expect(Object.keys(built)).toEqual([resultViewKeyOf(record())]);
    expect(resultViewKeyOf(record())).toBe(`${EPOCH}/${OP}`);
  });
});

describe("3.6 只通知与去重：同一结论只说一次", () => {
  const noticesOf = (
    readsStore: ResultReadStore,
    seenKeys: Record<string, true> = {},
    records: readonly OperationRecord[] = [record()],
  ) => deriveResultNotices({ records, reads: readsStore, seenKeys });

  it("未读 / 正在读取都不是通知（没有新事实）", () => {
    expect(noticesOf(reads(undefined)).unreadCount).toBe(0);
    expect(
      noticesOf(reads({ phase: "reading", attempt: 1, facts: null, reason: null })).unreadCount,
    ).toBe(0);
  });

  it("可查看 / 不可读 / 未定位 / 本次未接受各算一条，且都带类型与人话", () => {
    const view = noticesOf(reads(verified(ownFailure)));
    expect(view.unreadCount).toBe(1);
    expect(view.liveText).toContain("结果重跑");
    expect(view.liveText).toContain(RUN);
    expect(noticesOf(reads(unreadable("文件缺失"))).liveText).toContain("不可读");
    expect(noticesOf(reads(undefined), {}, [record({ runIds: [] })]).liveText).toContain(
      "结果未定位",
    );
    expect(
      noticesOf(reads(undefined), {}, [
        record({ state: "notAccepted", rejection: "busy", runIds: [] }),
      ]).liveText,
    ).toContain("未被主进程接受");
  });

  it("标成已看之后不再通知；重复快照堆不出第二份", () => {
    const store = reads(verified(normalEnd));
    const key = noticeKeyOf(EPOCH, OP, RUN);
    expect(noticesOf(store).unreadCount).toBe(1);
    expect(noticesOf(store, { [key]: true }).unreadCount).toBe(0);
    // 同一结论再到达一次（同一份 reads + 同一条记录）⇒ 还是那一条，看过就是零
    const twice = noticesOf(store, { [key]: true }, [record(), record()]);
    expect(twice.unreadCount).toBe(0);
    expect(noticesOf(store, {}, [record(), record()]).unreadCount).toBe(1);
  });

  it("等待计时不进通知文本（进了就等于每秒重复通知）", () => {
    const text = noticesOf(reads(verified(normalEnd))).liveText ?? "";
    expect(text).not.toMatch(/秒|分钟|等待|已用/);
  });

  it("批次逐臂各算一条：不把整批并成一条，也不漏臂", () => {
    const second = "run_result_arm_b";
    const batch = record({
      target: { kind: "modelAb", parentRunId: "r_parent", armCount: 2 },
      runIds: [RUN, second],
      experimentId: "exp_1",
      arms: [
        { index: 0, id: RUN, outcome: "returned" },
        { index: 1, id: second, outcome: "returned" },
      ],
    });
    // 两条臂各自按身份落结论（读取项的键含 runId ⇒ 不会互相盖掉）
    const store = setResultRead(
      setResultRead(
        emptyResultReadStore(),
        { epoch: EPOCH, operationId: OP, runId: RUN },
        verified(normalEnd),
      ),
      { epoch: EPOCH, operationId: OP, runId: second },
      verified(normalEnd),
    );
    const view = noticesOf(store, {}, [batch]);
    expect(view.unreadCount).toBe(2);
    expect(view.liveText).toContain("模型 A/B");
    expect(view.liveText).toContain(second);
  });
});

describe("3.5 面板视图（喂 props）：入口与说明互斥地出现", () => {
  const row = (result: OperationResultView | null): OperationRow => ({
    key: `${EPOCH}/${OP}`,
    phase: "settled",
    kindLabel: "结果重跑",
    targetText: "父 r_parent · 步 s_03 · 改 result",
    operationId: OP,
    epoch: EPOCH,
    runLinks: [{ runId: RUN, note: "身份来自编排回调，未确认文件可读" }],
    diagnosticCount: 0,
    experimentId: null,
    canReconcile: true,
    hint: "已收口：请求执行并收尾完毕；不等于运行成功",
    result,
  });

  const render = (result: OperationResultView | null): string =>
    renderToStaticMarkup(
      createElement(OperationRowView, {
        row: row(result),
        onReconcile: () => undefined,
        onAct: () => undefined,
      }),
    );

  it("自有失败调用 ⇒ 「查看失败调用」在场；只有祖先失败时它缺席、改为说明", () => {
    const withFailure = deriveOperationResultView({
      record: record(),
      reads: reads(verified(ownFailure)),
      draftPresent: true,
    });
    const markup = render(withFailure);
    expect(markup).toContain("查看失败调用");
    expect(markup).toContain("打开结果");

    const ancestorOnly = deriveOperationResultView({
      record: record(),
      reads: reads(verified(ancestorOnlyFailure)),
      draftPresent: true,
    });
    const without = render(ancestorOnly);
    expect(without).not.toContain("查看失败调用");
    expect(without).toContain("不取祖先调用冒充原因");
  });

  it("草稿不在 ⇒ 没有「返回草稿」，只有回退说明", () => {
    const gone = deriveOperationResultView({
      record: record(),
      reads: reads(verified(normalEnd)),
      draftPresent: false,
    });
    const markup = render(gone);
    expect(markup).not.toContain("返回草稿");
    expect(markup).toContain("不复活旧内容");
    const kept = deriveOperationResultView({
      record: record(),
      reads: reads(verified(normalEnd)),
      draftPresent: true,
    });
    expect(render(kept)).toContain("返回草稿");
  });

  it("面板不复述运行文件读不到的原因细节时也不隐藏诊断条数", () => {
    const view = deriveOperationResultView({
      record: record(),
      reads: reads(unreadable("结果详情版本校验失败：不支持的 format_version")),
      draftPresent: true,
    });
    const markup = render(view);
    expect(markup).toContain("重读这条结果");
    expect(markup).toContain("不支持的 format_version");
  });

  it("源码级：行视图不自己判断能否跳转，动作可用性全部来自纯派生", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/OperationsEntry.tsx"),
      "utf8",
    );
    // 组件里不出现结局判据与动作可用性判据（那些都在 lib/operation-result-view）
    for (const forbidden of [
      "normalEnd",
      "leafSpanIds",
      "deriveOwnTerminalFacts",
      "viewOperationResult",
      "classifyOutcome",
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    expect(src).toContain("item.actions.map");
  });
});
