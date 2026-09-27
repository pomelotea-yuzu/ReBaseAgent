import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { OperationRecord } from "@shared/operations";
import { OperationRecordSchema } from "@shared/operations";
import { deriveOwnTerminalFacts } from "@shared/terminal-facts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OperationRow } from "../src/renderer/src/lib/operation-list";
import { deriveOperationRows } from "../src/renderer/src/lib/operation-list";
import type { OperationResultView } from "../src/renderer/src/lib/operation-result-view";
import {
  deriveAbBatchResult,
  requestFactsLineOf,
} from "../src/renderer/src/lib/operation-result-view";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore, setResultRead } from "../src/renderer/src/lib/result-verification";

/**
 * U5（unify-run-execution-workflow）任务 5.1：**操作列表/详情的请求事实、结果状态、
 * 受控诊断与结果动作**。
 *
 * 判据来源：delta「跨页操作反馈展示真实等待与分层状态」+「结果按可信运行身份核实且读取重试不执行」；
 * 本项验收场景 =「操作详情可读诊断但不泄漏输入」「失败信封仍可打开可信记录」
 * 「settled 无身份与 notAccepted 不猜测结果」。design D4 末段给了措辞口径：
 * **`requestOutcome=rejected` 是编排分类，不一律等于"零调用未执行"**——那个说法只属于
 * notAccepted；请求诊断与运行结局各占一行，互不覆盖。
 *
 * ⚠️ 本包无 jsdom ⇒ 组件测试一律喂 props（与 `operation-result-view.test.ts` 同法）：
 * 桩先就位再动态 import（组件文件树经 store 摸到 `window.api`）。
 */

(globalThis as Record<string, unknown>).window = { api: {} };
const { OperationRowView } = await import("../src/renderer/src/components/OperationsEntry");
const { AbBatchResultSection } = await import("../src/renderer/src/components/AbBatchResult");

const EPOCH = "55555555-5555-4555-8555-555555555555";
const OP = "88888888-8888-4888-8888-888888888888";
const ARM_A = "run_ab_arm_a";
const ARM_B = "run_ab_arm_b";
const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");

const normalEnd = deriveOwnTerminalFacts({
  status: "completed",
  events: [{ event: "stopped", reason: "completed" }],
  spans: readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl")).spans,
  leafSpanIds: readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl")).spans.map((span) => span.id),
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
    runIds: [ARM_A],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

const abRecord = (overrides: Partial<OperationRecord> = {}): OperationRecord =>
  record({
    target: { kind: "modelAb", parentRunId: "r_parent", armCount: 2 },
    experimentId: "exp_51",
    runIds: [ARM_A, ARM_B],
    arms: [
      { index: 0, id: ARM_A, outcome: "returned" },
      { index: 1, id: ARM_B, outcome: "returned" },
    ],
    ...overrides,
  });

const readsWith = (
  runId: string,
  entry: {
    phase: "reading" | "verified" | "unreadable";
    facts?: typeof normalEnd;
    reason?: string;
  },
) =>
  setResultRead(
    emptyResultReadStore(),
    { epoch: EPOCH, operationId: OP, runId },
    {
      phase: entry.phase,
      attempt: 1,
      facts: entry.phase === "verified" ? (entry.facts ?? normalEnd) : null,
      reason: entry.phase === "unreadable" ? (entry.reason ?? "源文件缺失") : null,
    },
  );

describe("5.1 请求事实行：与运行结局分层、措辞不越界", () => {
  it("returned ⇒ 单独一行且明说不是结局宣告（A/B 措辞另含'可含失败臂'）", () => {
    const plain = requestFactsLineOf(record());
    expect(plain).toContain("请求事实");
    expect(plain).toContain("只看自有终止事件");
    const ab = requestFactsLineOf(abRecord());
    expect(ab).toContain("A/B 的返回可含失败臂");
    expect(ab).toContain("不宣告任何一条");
  });

  it("failed ⇒ 报请求异常与稳定码，并声明不阻断按可信 ID 打开", () => {
    const line = requestFactsLineOf(
      record({ requestOutcome: "failed", errorCode: "LLM_UPSTREAM_503" }),
    );
    expect(line).toContain("请求异常");
    expect(line).toContain("LLM_UPSTREAM_503");
    expect(line).toContain("失败信封不影响按可信 ID 打开");
  });

  it("「rejected 不一律称为零调用」：拒绝行只报编排分类，「没有开始执行」只属于 notAccepted 侧", () => {
    const line = requestFactsLineOf(
      record({ requestOutcome: "rejected", errorCode: "GATE_DENIED" }),
    );
    expect(line).toContain("业务拒绝");
    expect(line).toContain("不一律等于零模型调用");
    expect(line).not.toContain("没有开始执行");
    // notAccepted：请求事实行为 null——它的"未执行"文案由记录级拒绝说明承担
    expect(
      requestFactsLineOf(
        record({
          state: "notAccepted",
          rejection: "busy",
          startedAt: null,
          settledAt: null,
          requestOutcome: null,
          runIds: [],
        }),
      ),
    ).toBeNull();
  });

  it("running / 未知历史 ⇒ 没有请求事实可陈述，不提前给收口口径", () => {
    expect(
      requestFactsLineOf(
        record({ state: "running", settledAt: null, requestOutcome: null, runIds: [] }),
      ),
    ).toBeNull();
  });

  it("「失败信封仍可打开可信记录」分层呈现：请求异常行与逐条动作互不覆盖", () => {
    const failedRecord = record({ requestOutcome: "failed", errorCode: "LLM_UPSTREAM_503" });
    expect(requestFactsLineOf(failedRecord)).toContain("请求异常");
    // 同一行的登记 runId 仍给出「打开结果」——失败信封不削减结果动作
    const rows = deriveOperationRows(
      { ...initialSession(), epoch: EPOCH, operations: [failedRecord] },
      { reads: readsWith(ARM_A, { phase: "verified" }), draftPresentOf: () => true },
    );
    const row = rows.find((one) => one.operationId === OP);
    expect(row?.requestLine).toContain("失败信封不影响");
    expect(row?.result?.items[0]?.actions).toContain("open-result");
  });

  it("「settled 无身份与 notAccepted 不猜测结果」在详情层同样成立：请求事实有、结果链接无", () => {
    const unlocated = record({ runIds: [], requestOutcome: "rejected", errorCode: "GATE_DENIED" });
    const rows = deriveOperationRows(
      { ...initialSession(), epoch: EPOCH, operations: [unlocated] },
      { reads: emptyResultReadStore(), draftPresentOf: () => true },
    );
    const row = rows.find((one) => one.operationId === OP);
    expect(row?.requestLine).toContain("业务拒绝");
    expect(row?.result?.kind).toBe("unlocated");
    expect(row?.result?.items).toEqual([]);
    expect(row?.runLinks).toEqual([]);
  });
});

describe("5.1 受控诊断：详情可读但不泄漏输入", () => {
  const diagRecord = record({
    diagnostics: [
      { code: "ARM_FAILED", stage: "execute", message: "臂 1 的 provider 返回 503（限长文案）" },
      { code: "CLEANUP_SKIPPED", stage: "cleanup", message: "结局不满足清理判据：草稿保留" },
    ],
  });

  it("派生行原样携带诊断列表（条数从列表现数，不另存第二份）", () => {
    const rows = deriveOperationRows({
      ...initialSession(),
      epoch: EPOCH,
      operations: [diagRecord],
    });
    const row = rows.find((one) => one.operationId === OP);
    expect(row?.diagnostics.length).toBe(2);
    expect(row?.diagnostics[0]?.code).toBe("ARM_FAILED");
  });

  it("面板渲染出每条诊断的码/阶段/文案；操作摘要不含正文与 sourceToken 类字段", () => {
    const result: OperationResultView | null = null;
    const row: OperationRow = {
      key: `${EPOCH}/${OP}`,
      phase: "settled",
      kindLabel: "结果重跑",
      targetText: "父 r_parent · 步 s_03 · 改 result",
      operationId: OP,
      epoch: EPOCH,
      runLinks: [],
      diagnostics: diagRecord.diagnostics,
      requestLine: requestFactsLineOf(diagRecord),
      experimentId: null,
      canReconcile: true,
      hint: "已收口：请求执行并收尾完毕；不等于运行成功",
      wait: null,
      result,
    };
    const markup = renderToStaticMarkup(
      createElement(OperationRowView, {
        row,
        onReconcile: () => undefined,
        onAct: () => undefined,
      }),
    );
    expect(markup).toContain("受控诊断 2 条");
    expect(markup).toContain("ARM_FAILED");
    expect(markup).toContain("臂 1 的 provider 返回 503");
    expect(markup).toContain("CLEANUP_SKIPPED");
    expect(markup).toContain("结局不满足清理判据");
    // 摘要与诊断之外不出现任何输入类字段名（schema 里根本没有这些键 ⇒ 出现即为夹带）
    for (const forbidden of ["sourceToken", "apiKey", "submittedText", "messages"]) {
      expect(markup.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("夹带未知字段的登记记录在 schema 层即非法：strict 契约是'不泄漏'的机器判据", () => {
    const smuggled = {
      ...record(),
      // 有人想把正文/授权塞进登记——契约上没有这些字段，整条快照即被拒
      submittedText: "SECRET_BODY",
      sourceToken: "tok_leak",
    };
    const parsed = OperationRecordSchema.safeParse(smuggled);
    expect(parsed.success).toBe(false);
  });

  it("源码级：呈现层没有任何拿到草稿正文/授权/token 的通道", () => {
    const files = [
      "../src/renderer/src/lib/operation-list.ts",
      "../src/renderer/src/components/OperationsEntry.tsx",
      "../src/renderer/src/components/AbBatchResult.tsx",
    ];
    for (const rel of files) {
      const src = readFileSync(resolve(import.meta.dirname, rel), "utf8");
      // 只扫 import 语句（文档注释里"不包含 X"的纪律陈述允许出现）
      const imports = src
        .split("\n")
        .filter((line) => line.trimStart().startsWith("import"))
        .join("\n");
      for (const forbidden of [
        "debugging-drafts",
        "draft-submission",
        "submittedText",
        "sourceToken",
        "chooseSource",
        "apiKey",
      ]) {
        expect(imports, `${rel}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("5.1 A/B 批次结果区：逐臂读取状态，基准是登记不是信封 ids", () => {
  it("登记快照未到场 ⇒ 只报等待，不给任何状态/动作/实验号", () => {
    const view = deriveAbBatchResult({
      operationId: OP,
      record: null,
      reads: emptyResultReadStore(),
    });
    expect(view.epoch).toBeNull();
    expect(view.statusLabel).toBe("等待登记快照");
    expect(view.arms).toEqual([]);
    expect(view.requestLine).toBeNull();
    expect(view.experimentId).toBeNull();
  });

  it("settled 两臂 ⇒ 逐臂给可信 ID + 读取状态；未读的臂只给「打开结果」，不预告结局", () => {
    const view = deriveAbBatchResult({
      operationId: OP,
      record: abRecord(),
      reads: readsWith(ARM_A, { phase: "verified" }),
    });
    expect(view.epoch).toBe(EPOCH);
    expect(view.statusLabel).toBe("已收口");
    expect(view.arms.length).toBe(2);
    expect(view.arms[0]?.runId).toBe(ARM_A);
    expect(view.arms[0]?.item?.label).toBe("已结束");
    expect(view.arms[0]?.item?.actions).toContain("open-result");
    expect(view.arms[1]?.runId).toBe(ARM_B);
    expect(view.arms[1]?.item?.label).toBe("结果待读取");
    // 请求层臂结局与运行结局分层：returned 不等于"成功臂"
    expect(view.arms[0]?.armOutcome).toBe("returned");
    expect(view.statusDetail).toContain("收口不等于全部成功");
  });

  it("「实验缺臂部分失败」逐臂诚实：登记短于 armCount 也不从信封多报的 id 凑", () => {
    // target.armCount = 2，登记 arms 只有臂 0；臂 1 的 id 为 null（未开始）
    const view = deriveAbBatchResult({
      operationId: OP,
      record: abRecord({
        arms: [
          { index: 0, id: ARM_A, outcome: "returned" },
          { index: 1, id: null, outcome: null },
        ],
        runIds: [ARM_A],
      }),
      reads: emptyResultReadStore(),
    });
    expect(view.arms.length).toBe(2);
    expect(view.arms[1]?.runId).toBeNull();
    expect(view.arms[1]?.item).toBeNull();
    expect(view.arms[1]?.note).toContain("不生成结果链接");
    expect(view.arms[1]?.note).toContain("不从信封多报的 id");
  });

  it("执行中 ⇒ 逐臂'尚无登记 ID'，不显示进度；notAccepted ⇒ 整批没有结果可列", () => {
    const running = deriveAbBatchResult({
      operationId: OP,
      record: abRecord({
        state: "running",
        settledAt: null,
        requestOutcome: null,
        runIds: [],
        arms: [],
        experimentId: null,
      }),
      reads: emptyResultReadStore(),
    });
    expect(running.statusLabel).toBe("执行中");
    expect(running.arms.length).toBe(2);
    expect(running.arms[0]?.note).toContain("执行中，未观察到不代表失败");
    expect(running.arms[0]?.item).toBeNull();

    const banned = deriveAbBatchResult({
      operationId: OP,
      record: abRecord({
        state: "notAccepted",
        rejection: "busy",
        startedAt: null,
        settledAt: null,
        requestOutcome: null,
        runIds: [],
        arms: [],
        experimentId: null,
      }),
      reads: emptyResultReadStore(),
    });
    expect(banned.statusLabel).toBe("本次未接受");
    expect(banned.arms).toEqual([]);
    expect(banned.requestLine).toBeNull();
  });

  it("不可读臂只给同一 ID 的重读动作；渲染后不出现臂间差值/胜出臂结论，也无'实验完成'措辞", () => {
    const view = deriveAbBatchResult({
      operationId: OP,
      record: abRecord({
        requestOutcome: "failed",
        errorCode: "ARM_ABORTED",
        arms: [
          { index: 0, id: ARM_A, outcome: "failed" },
          { index: 1, id: ARM_B, outcome: "returned" },
        ],
      }),
      reads: readsWith(ARM_A, { phase: "unreadable", reason: "结果详情结构校验失败" }),
    });
    expect(view.requestLine).toContain("请求异常");
    expect(view.arms[0]?.item?.actions).toEqual(["retry-read"]);

    const markup = renderToStaticMarkup(
      createElement(AbBatchResultSection, { view, onAct: () => undefined }),
    );
    expect(markup).toContain("臂 1");
    expect(markup).toContain("臂 2");
    expect(markup).toContain("重读这条结果");
    expect(markup).toContain("实验组 exp_51");
    // 诚实说明行在场；"胜出臂"只允许出现在那句否定里，不允许出现在任何结论位（判据在 derive 与视图里都没有比较）
    expect(markup).toContain("不产出臂间差值");
    expect(markup).not.toContain("实验完成");
    expect(markup).not.toContain("成功 1 臂");
  });

  it("DetailPanel 接线（源码级）：批次面板只吃 deriveAbBatchResult，信封 ModelAbResult 不再进面板", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
      "utf8",
    );
    expect(src).toContain("deriveAbBatchResult");
    expect(src).toContain("<AbBatchResultSection");
    // 请求事实仍由 store 的 modelAbError/ErrorCode 单独呈现；面板不再消费执行信封的返回值
    for (const forbidden of ["setExecuted(", "实验完成", "ids.length", "executed.ids"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
