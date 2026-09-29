import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { deriveTerminalReason } from "@shared/derive";
import { RunDetailSchema } from "@shared/ipc";
import {
  type OwnTerminalInput,
  deriveOwnTerminalFacts,
  findResultIdentityViolation,
} from "@shared/terminal-facts";
import { describe, expect, it } from "vitest";

/**
 * U5（unify-run-execution-workflow）任务 1.1：自有终止事件与结局判据。
 *
 * 判据来源：desktop-ui delta「结果按可信运行身份核实且读取重试不执行」三个场景：
 *   - 成功信封但运行错误
 *   - 封存限制中止和未知不等于正常结束
 *   - 祖先结束与失败调用不能冒充本次事实
 * 以及 design D4「正常结束 SHALL 由当前运行自有 `stopped/completed` 终止事件证明，
 * 文件封存、IPC ok、requestOutcome 或成功 ID 子集 SHALL NOT 替代该证明」。
 *
 * ⚠️ 反例纪律（沿用 overview.test.ts 的做法）：结局类判据必须**同时**给
 * 「看起来像正常结束」的输入（文件已封存、信封 ok、祖先已完成）与
 * 「实际不是正常结束」的事实，否则只测"error 时判非正常"毫无牙。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const read = (name: string) => readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));

/** 与 `getRun` 的 RunDetail 同构：文件内 span 恒为自有（分支前缀要显式拼） */
function own(name: string): OwnTerminalInput {
  const record = read(name);
  return {
    status: record.status,
    events: record.events,
    spans: record.spans,
    leafSpanIds: record.spans.map((span) => span.id),
  };
}

/** 给一段 spans 换 id（构造"祖先前缀 + 自有段"时避免两份 fixture 的 id 撞车） */
function renamed(spans: readonly SpanLine[], prefix: string): SpanLine[] {
  return spans.map((span) => ({
    ...span,
    id: `${prefix}${span.id}`,
    parent: span.parent === null ? null : `${prefix}${span.parent}`,
  }));
}

describe("deriveOwnTerminalFacts：正常结束只认自有 stopped/completed", () => {
  it("u1-ok（stopped/completed）⇒ normalEnd，展示结局「已结束」", () => {
    const facts = deriveOwnTerminalFacts(own("u1-ok"));
    expect(facts.event).toEqual({ event: "stopped", reason: "completed" });
    expect(facts.reason).toBe("completed");
    expect(facts.normalEnd).toBe(true);
    expect(facts.outcome).toMatchObject({ kind: "completed", label: "已结束", normalEnd: true });
    // 正常结束不产生失败定位
    expect(facts.failure.llmCallSpanId).toBeNull();
  });

  it("达到迭代上限 / 超出预算（event=stopped 但 reason 是限制）⇒ 不算正常结束", () => {
    for (const reason of ["max_iterations", "budget_exceeded"] as const) {
      const facts = deriveOwnTerminalFacts({
        status: "completed",
        events: [{ event: "stopped", reason }],
        spans: [],
        leafSpanIds: [],
      });
      expect(facts.normalEnd).toBe(false);
      expect(facts.outcome.normalEnd).toBe(false);
    }
    expect(
      deriveOwnTerminalFacts({
        status: "completed",
        events: [{ event: "stopped", reason: "max_iterations" }],
        spans: [],
        leafSpanIds: [],
      }).outcome.label,
    ).toBe("达到迭代上限");
    expect(
      deriveOwnTerminalFacts({
        status: "completed",
        events: [{ event: "stopped", reason: "budget_exceeded" }],
        spans: [],
        leafSpanIds: [],
      }).outcome.label,
    ).toBe("超出预算");
  });

  it("u1-aborted（event=aborted）⇒ 已中止，normalEnd false", () => {
    const facts = deriveOwnTerminalFacts(own("u1-aborted"));
    expect(facts.event).toEqual({ event: "aborted", reason: "aborted" });
    expect(facts.normalEnd).toBe(false);
    expect(facts.outcome).toMatchObject({ kind: "aborted", label: "已中止", normalEnd: false });
  });

  it("u1-crashed（无终止事件）⇒ 运行中断，事件与原因都为 null", () => {
    const facts = deriveOwnTerminalFacts(own("u1-crashed"));
    expect(facts.event).toBeNull();
    expect(facts.reason).toBeNull();
    expect(facts.normalEnd).toBe(false);
    expect(facts.outcome).toMatchObject({ kind: "interrupted", label: "运行中断" });
  });

  it("未识别的 reason ⇒ 保留原值并判未知，绝不因未知放行清理", () => {
    const facts = deriveOwnTerminalFacts({
      status: "completed",
      // 摘要侧 reason 是开放字符串：未知原值必须留得住（classifyOutcome 同口径）
      events: [{ event: "stopped", reason: "suspended_by_upstream" }],
      spans: [],
      leafSpanIds: [],
    });
    expect(facts.normalEnd).toBe(false);
    expect(facts.outcome).toMatchObject({ kind: "unknown", label: "结束原因未知" });
    expect(facts.outcome.reason).toBe("suspended_by_upstream");
  });

  it("详情侧的非法 reason 由 schema 拒读，本模块不放宽（RunDetailSchema 原样生效）", () => {
    const record = read("u1-ok");
    const raw = {
      meta: record.meta,
      spans: record.spans,
      // 未识别的终止原因：既有 schema 是枚举 ⇒ 校验失败（"不为显示未知而放宽 schema"）
      events: [{ type: "run.event", event: "stopped", reason: "suspended_by_upstream" }],
      status: record.status,
      chain: [{ meta: record.meta, fork: record.meta.fork }],
      leafSpanIds: record.spans.map((span) => span.id),
      completeness: "complete",
      spanScope: "own",
      lineage: { status: "complete" },
    };
    expect(RunDetailSchema.safeParse(raw).success).toBe(false);
    // 对照组：同一份记录只把 reason 换成合法枚举即可通过 ⇒ 失败确实来自 reason
    expect(
      RunDetailSchema.safeParse({
        ...raw,
        events: [{ type: "run.event", event: "stopped", reason: "completed" }],
      }).success,
    ).toBe(true);
  });

  it("event/reason 矛盾（errored + completed）⇒ 展示按 reason，清理判据仍不放行", () => {
    const facts = deriveOwnTerminalFacts({
      status: "completed",
      events: [{ event: "errored", reason: "completed" }],
      spans: [],
      leafSpanIds: [],
    });
    // 展示口径沿用 U1 既有规则（矛盾以 reason 为准），本任务不改它
    expect(facts.outcome.kind).toBe("completed");
    // 清理口径更严：两个字段必须同时是 stopped/completed，手工编辑的矛盾记录不算正常结束
    expect(facts.normalEnd).toBe(false);
  });

  it("多条事件取末条（与 deriveTerminalReason 同口径）", () => {
    const events = [
      { event: "stopped", reason: "max_iterations" },
      { event: "stopped", reason: "completed" },
    ];
    const facts = deriveOwnTerminalFacts({
      status: "completed",
      events,
      spans: [],
      leafSpanIds: [],
    });
    expect(facts.reason).toBe(deriveTerminalReason({ status: "completed", events }));
    expect(facts.normalEnd).toBe(true);
  });

  it("crashed 即便残留 stopped/completed 事件也不算正常结束（残留不可信）", () => {
    const facts = deriveOwnTerminalFacts({
      status: "crashed",
      events: [{ event: "stopped", reason: "completed" }],
      spans: [],
      leafSpanIds: [],
    });
    expect(facts.event).toBeNull();
    expect(facts.reason).toBeNull();
    expect(facts.normalEnd).toBe(false);
    expect(facts.outcome.kind).toBe("interrupted");
  });
});

describe("成功信封但运行错误：IPC ok 与 requestOutcome 都不进入结局判据", () => {
  it("u1-error-detail（自有 errored/error）⇒ 出错终止且定位到真实自有调用", () => {
    const facts = deriveOwnTerminalFacts(own("u1-error-detail"));
    expect(facts.normalEnd).toBe(false);
    expect(facts.outcome).toMatchObject({ kind: "error", label: "出错终止", tone: "danger" });
    // 失败记录入口：真实自有 s_05，含原错误正文与状态码
    expect(facts.failure).toMatchObject({
      llmCallSpanId: "s_05",
      missingDetail: false,
      status: 401,
    });
    expect(facts.failure.message).toContain("401");
  });

  it("error 终止但自有无失败详情 ⇒ missingDetail，不虚构入口", () => {
    const facts = deriveOwnTerminalFacts({
      status: "completed",
      events: [{ event: "errored", reason: "error" }],
      // 自有段只有一条正常 llm.call 之外的 step（无 error 字段）
      spans: read("u1-fork-child").spans,
      leafSpanIds: read("u1-fork-child").spans.map((span) => span.id),
    });
    expect(facts.normalEnd).toBe(false);
    expect(facts.failure).toMatchObject({ llmCallSpanId: null, missingDetail: true });
  });
});

describe("祖先结束与失败调用不能冒充本次事实", () => {
  /** 祖先（含失败调用、自身以 error 终止）+ 叶子自有段（s_09/s_10）的展开视图 */
  function branchOf(leafEvents: OwnTerminalInput["events"], status: OwnTerminalInput["status"]) {
    const ancestor = read("u1-error-detail");
    const leaf = read("u1-fork-child");
    return {
      status,
      events: leafEvents,
      // getRun 对分支 run 返回拼接后的轨迹：祖先 spans 也在其中
      spans: [...ancestor.spans, ...leaf.spans],
      // 自有段只有叶子新增的两个 span
      leafSpanIds: leaf.spans.map((span) => span.id),
    } satisfies OwnTerminalInput;
  }

  it("祖先正常结束、叶子无终止事件 ⇒ 运行中断，不从祖先补正常结局", () => {
    const facts = deriveOwnTerminalFacts(branchOf([], "crashed"));
    expect(facts.normalEnd).toBe(false);
    expect(facts.outcome).toMatchObject({ kind: "interrupted", label: "运行中断" });
    expect(facts.event).toBeNull();
  });

  it("叶子自有 stopped/completed ⇒ 正常结束只由自有事件证明", () => {
    const facts = deriveOwnTerminalFacts(
      branchOf([{ event: "stopped", reason: "completed" }], "completed"),
    );
    expect(facts.normalEnd).toBe(true);
    expect(facts.outcome.kind).toBe("completed");
  });

  it("祖先含失败调用、叶子以 error 终止但自有无详情 ⇒ 定位不到祖先的 s_05", () => {
    const facts = deriveOwnTerminalFacts(
      branchOf([{ event: "errored", reason: "error" }], "completed"),
    );
    expect(facts.normalEnd).toBe(false);
    expect(facts.failure.llmCallSpanId).toBeNull();
    expect(facts.failure.missingDetail).toBe(true);
  });

  it("叶子自有失败调用 ⇒ 定位只落在自有段（换成无错误的正常祖先前缀）", () => {
    // 两份 fixture 的 span id 会撞车，给自有段加前缀才能真正分辨"祖先 vs 本次"
    const leaf = renamed(read("u1-error-detail").spans, "own_");
    const facts = deriveOwnTerminalFacts({
      status: "completed",
      events: [{ event: "errored", reason: "error" }],
      // 祖先前缀换成正常结束的 u1-ok（自有段之外没有任何失败调用）
      spans: [...read("u1-ok").spans, ...leaf],
      leafSpanIds: leaf.map((span) => span.id),
    });
    expect(facts.failure.llmCallSpanId).toBe("own_s_05");
    expect(facts.failure.stepSpanId).toBe("own_s_04");
  });
});

describe("findResultIdentityViolation：身份先于事实", () => {
  const detail = (ids: { meta: string; chain: string[] }) => ({
    requestedRunId: ids.chain[ids.chain.length - 1] ?? ids.meta,
    detail: {
      meta: { id: ids.meta },
      chain: ids.chain.map((id) => ({ meta: { id } })),
    },
  });

  it("对照组：载荷与末跳都等于请求 id ⇒ 无违规", () => {
    const input = detail({ meta: "run_child", chain: ["run_root", "run_child"] });
    expect(findResultIdentityViolation({ ...input, requestedRunId: "run_child" })).toBeNull();
  });

  it("载荷自称的 run 与请求不符 ⇒ 违规说明同时给出两个 id", () => {
    const violation = findResultIdentityViolation({
      requestedRunId: "run_a",
      detail: { meta: { id: "run_b" }, chain: [{ meta: { id: "run_b" } }] },
    });
    expect(violation).not.toBeNull();
    expect(violation).toContain("run_a");
    expect(violation).toContain("run_b");
  });

  it("祖先链为空 ⇒ 无法确认终止事件归属", () => {
    const violation = findResultIdentityViolation({
      requestedRunId: "run_a",
      detail: { meta: { id: "run_a" }, chain: [] },
    });
    expect(violation).toContain("祖先链为空");
  });

  it("末跳记录不是本次请求的 run ⇒ 违规（终止事件归属不成立）", () => {
    const violation = findResultIdentityViolation({
      requestedRunId: "run_child",
      detail: { meta: { id: "run_child" }, chain: [{ meta: { id: "run_root" } }] },
    });
    expect(violation).toContain("末跳记录");
    expect(violation).toContain("run_root");
  });
});
