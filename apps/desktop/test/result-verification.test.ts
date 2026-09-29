import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, RunDetail } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { describe, expect, it } from "vitest";
import {
  beginResultRead,
  emptyResultReadStore,
  finishResultRead,
  resultReadAlreadySettledOrInFlight,
  resultReadEntryOf,
  resultReadKeyOf,
  resultReadOf,
  setResultRead,
  verifyResultPayload,
  viewOperationResult,
} from "../src/renderer/src/lib/result-verification";

/**
 * U5（unify-run-execution-workflow）任务 1.2 的**纯判据半边**：按可信 runId 核实结果。
 *
 * 判据来源：desktop-ui delta「结果按可信运行身份核实且读取重试不执行」：
 *   - 成功信封但运行错误（读取半边：详情到手后仍按自有终止事件判结局）
 *   - 结果不可读只重试同一记录（读取半边：不可读只产生说明，不造结论）
 *   - 祖先结束与失败调用不能冒充本次事实
 * 以及 design D4「读取核对包括请求 runId 与 meta.id 一致、自有终止事件所属运行、
 * 详情 schema 与版本」。
 *
 * ⚠️ 拒绝类用例一律配对照组（工程约定「判据假门清单」）：下面每个"必须拒"的载荷
 *    都有一条只改坏字段即可通过的对照，防止桩本身在撒谎。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const read = (name: string): RunRecord => readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));

/** 与 main 的 getRun 同构：chain 末跳即本 run（root run 只有一跳） */
function detailFor(record: RunRecord, id = record.meta.id): RunDetail {
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

const okDetail = detailFor(read("u1-ok"));
const errorDetail = detailFor(read("u1-error-detail"));

describe("verifyResultPayload：可信身份 + 合法详情 ⇒ 已核实的自有终止事实", () => {
  it("u1_ok ⇒ verified，正常结束只由自有 stopped/completed 证明", () => {
    const verified = verifyResultPayload("u1_ok", ok(okDetail));
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.facts.normalEnd).toBe(true);
    expect(verified.facts.outcome.label).toBe("已结束");
    expect(resultReadEntryOf(verified, 1)).toEqual({
      phase: "verified",
      attempt: 1,
      facts: verified.facts,
      // U6 4.6：verified 读取项携带经核实的来源完整性（complete 详情 ⇒ complete）
      lineage: { status: "complete" },
      reason: null,
    });
  });

  it("成功信封但运行 error ⇒ 仍核实通过，但结局是失败且能定位真实自有调用", () => {
    // 执行信封的 ok 与详情读取的 ok 都不参与结局判定（delta「成功信封但运行错误」）
    const verified = verifyResultPayload("u1_error_detail", ok(errorDetail));
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.facts.normalEnd).toBe(false);
    expect(verified.facts.outcome).toMatchObject({ kind: "error", label: "出错终止" });
    expect(verified.facts.failure.llmCallSpanId).toBe("s_05");
  });

  it("详情读取的失败信封 ⇒ 不可读并保留原诊断，不猜 run id", () => {
    const envelope: Envelope<unknown> = {
      ok: false,
      error: { code: "RUN_READ_FAILED", message: "该 run 的源文件读取失败" },
    };
    const result = verifyResultPayload("u1_missing", envelope);
    expect(result).toEqual({
      ok: false,
      reason: "结果读取失败（RUN_READ_FAILED）：该 run 的源文件读取失败",
    });
    expect(resultReadEntryOf(result, 1).phase).toBe("unreadable");
  });
});

describe("verifyResultPayload：身份核对不过 ⇒ 这条详情根本不解释本次操作", () => {
  it("载荷自称的 meta.id 与请求不符（main 回错 run）⇒ 拒绝采信", () => {
    const result = verifyResultPayload("u1_other", ok(okDetail));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("归属校验失败");
    // 对照组：同一份载荷按它自称的 id 请求即可通过 ⇒ 拒绝确实来自 id
    expect(verifyResultPayload("u1_ok", ok(okDetail)).ok).toBe(true);
  });

  it("祖先链末跳不是本次 run ⇒ 载荷不被采信（U6 起末跳身份先由 schema 拒，身份核对层由 terminal-facts 单测直承）", () => {
    const tampered: RunDetail = {
      ...okDetail,
      chain: [
        { meta: okDetail.meta, fork: okDetail.meta.fork },
        { meta: { ...okDetail.meta, id: "u1_ghost" }, fork: null },
      ],
    };
    const result = verifyResultPayload("u1_ok", ok(tampered));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // U6 完整性契约把「chain 末跳身份 = 当前 meta」下沉为载荷级规则 ⇒
    // 这份串号载荷在结构校验就被拒（拒得更早，结论不变：不可信、不解释本次操作）。
    expect(result.reason).toContain("结构校验失败");
    expect(result.reason).toContain("末跳");
  });

  it("版本守卫先于 schema：v1 载荷私带隔离字段 ⇒ 拒读（zod 会静默剥掉，界面不能照渲染）", () => {
    const tampered = {
      ...okDetail,
      meta: {
        ...(okDetail.meta as unknown as Record<string, unknown>),
        workspace: { path: "/tmp/x" },
      },
    } as unknown as RunDetail;
    const result = verifyResultPayload("u1_ok", ok(tampered));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("版本校验失败");
    // 对照组：同一 run 去掉私带字段即通过
    expect(verifyResultPayload("u1_ok", ok(okDetail)).ok).toBe(true);
  });

  it("schema 非法（未识别的终止原因）⇒ 结构校验失败，不为显示未知而放宽", () => {
    const tampered = {
      ...okDetail,
      events: [{ type: "run.event", event: "stopped", reason: "suspended_by_upstream" }],
    } as unknown as RunDetail;
    const result = verifyResultPayload("u1_ok", ok(tampered));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("结构校验失败");
  });
});

describe("结果读取项：按 (epoch, operationId, runId) 隔离，不可变更新", () => {
  const identity = {
    epoch: "11111111-1111-1111-8111-111111111111",
    operationId: "22222222-2222-2222-8222-222222222222",
    runId: "u1_ok",
  };
  const verified = resultReadEntryOf(verifyResultPayload(identity.runId, ok(okDetail)), 1);
  const unreadable = resultReadEntryOf(
    verifyResultPayload("u1_gone", { ok: false, error: { code: "X", message: "没了" } }),
    1,
  );

  it("未核实过的键 ⇒ 无条目（= 未读），不默认成任何结论", () => {
    expect(resultReadOf(emptyResultReadStore(), identity)).toBeUndefined();
  });

  it("同键覆盖为最新结论，异键互不覆盖（不同 run / 不同操作各留一条）", () => {
    let store = setResultRead(emptyResultReadStore(), identity, verified);
    store = setResultRead(store, { ...identity, runId: "u1_error_detail" }, unreadable);
    store = setResultRead(
      store,
      { ...identity, operationId: "33333333-3333-3333-8333-333333333333" },
      unreadable,
    );
    expect(resultReadOf(store, identity)).toBe(verified);
    expect(resultReadOf(store, { ...identity, runId: "u1_error_detail" })).toBe(unreadable);
    // 新结论覆盖旧结论：仍是同一条键，其他两条不动
    store = setResultRead(store, identity, unreadable);
    expect(resultReadOf(store, identity)).toBe(unreadable);
    expect(Object.keys(store.byKey)).toHaveLength(3);
  });

  it("键含三段身份：epoch 不同即另一条读取项（旧会话的结论不解释新会话）", () => {
    expect(resultReadKeyOf(identity)).toBe(`${identity.epoch}|${identity.operationId}|u1_ok`);
    const store = setResultRead(emptyResultReadStore(), identity, verified);
    expect(
      resultReadOf(store, { ...identity, epoch: "99999999-9999-9999-8999-999999999999" }),
    ).toBeUndefined();
  });
});

describe("任务 1.3：读取代次、去重守卫与记录级呈现", () => {
  const identity = {
    epoch: "11111111-1111-1111-8111-111111111111",
    operationId: "22222222-2222-2222-8222-222222222222",
    runId: "u1_ok",
  };
  const other = { ...identity, runId: "u1_error_detail" };
  const verifiedEntry = resultReadEntryOf(verifyResultPayload(identity.runId, ok(okDetail)), 2);
  const lateEntry = resultReadEntryOf(verifyResultPayload(identity.runId, ok(errorDetail)), 1);

  it("beginResultRead 递增代次并先占 reading 位（重复快照据此不再拉取）", () => {
    const first = beginResultRead(emptyResultReadStore(), identity);
    expect(first.attempt).toBe(1);
    expect(resultReadOf(first.store, identity)).toEqual({
      phase: "reading",
      attempt: 1,
      facts: null,
      // U6 4.6：非 verified 时 lineage 恒 null（不造结论）
      lineage: null,
      reason: null,
    });
    // 已有第 2 代结论时再读 ⇒ 3，且其他键不受影响
    const store = setResultRead(first.store, other, verifiedEntry);
    const second = beginResultRead(store, identity);
    expect(second.attempt).toBe(2);
    expect(resultReadOf(second.store, other)).toBe(verifiedEntry);
  });

  it("已在读 / 已核实 ⇒ 视为已处理；不可读 ⇒ 不算（只能显式只读重试）", () => {
    expect(resultReadAlreadySettledOrInFlight(undefined)).toBe(false);
    expect(resultReadAlreadySettledOrInFlight(verifiedEntry)).toBe(true);
    expect(
      resultReadAlreadySettledOrInFlight({
        phase: "reading",
        attempt: 1,
        facts: null,
        reason: null,
      }),
    ).toBe(true);
    expect(
      resultReadAlreadySettledOrInFlight({
        phase: "unreadable",
        attempt: 1,
        facts: null,
        reason: "读不到",
      }),
    ).toBe(false);
  });

  it("旧代次的迟到响应整份丢弃：不覆盖新读取，也不碰其他键", () => {
    const current = setResultRead(emptyResultReadStore(), identity, verifiedEntry);
    const withOther = setResultRead(current, other, verifiedEntry);
    const dropped = finishResultRead(withOther, identity, 1, { ok: false, reason: "迟到的旧结论" });
    expect(dropped).toBe(withOther); // 引用相同 = 什么都没写
    expect(resultReadOf(dropped, identity)).toBe(verifiedEntry);
    expect(resultReadOf(dropped, other)).toBe(verifiedEntry);
    // 对照组：当代代次可以落地
    const applied = finishResultRead(withOther, identity, 2, {
      ok: false,
      reason: "本次重试仍不可读",
    });
    expect(applied).not.toBe(withOther);
    expect(resultReadOf(applied, identity)).toMatchObject({ phase: "unreadable", attempt: 2 });
    // 其他键仍不动
    expect(resultReadOf(applied, other)).toBe(verifiedEntry);
    expect(lateEntry.phase).toBe("unreadable");
  });

  it("viewOperationResult：running / notAccepted / settled 无身份都不产出结局", () => {
    expect(viewOperationResult(recordIn("running", []), emptyResultReadStore())).toEqual({
      kind: "running",
    });
    expect(
      viewOperationResult(
        recordIn("notAccepted", [], { rejection: "busy" }),
        emptyResultReadStore(),
      ),
    ).toEqual({ kind: "not-accepted", rejection: "busy" });
    // settled 但 runIds 为空 ⇒ 未定位：没有可读的 ID，也就没有任何"结果"
    expect(viewOperationResult(recordIn("settled", []), emptyResultReadStore())).toEqual({
      kind: "unlocated",
    });
  });

  it("viewOperationResult：settled 逐条给出可信 ID 的读取状态，未读的不补结论", () => {
    const record = recordIn("settled", [identity.runId, other.runId]);
    const view = viewOperationResult(record, emptyResultReadStore());
    expect(view.kind).toBe("results");
    if (view.kind !== "results") throw new Error("unreachable");
    expect(view.items.map((item) => item.runId)).toEqual([identity.runId, other.runId]);
    expect(view.items.every((item) => item.entry === undefined)).toBe(true);

    // 只读过其中一条 ⇒ 另一条仍是"未读"，绝不从邻近记录推断
    const store = setResultRead(emptyResultReadStore(), identity, verifiedEntry);
    const partial = viewOperationResult(record, store);
    if (partial.kind !== "results") throw new Error("unreachable");
    expect(partial.items[0]?.entry).toBe(verifiedEntry);
    expect(partial.items[1]?.entry).toBeUndefined();
  });
});

/** 构造一条合法的登记记录（只关心 state / runIds / rejection，其余填自洽值） */
function recordIn(
  state: OperationRecord["state"],
  runIds: string[],
  extra: Partial<OperationRecord> = {},
): OperationRecord {
  const settled = state === "settled";
  return {
    epoch: "11111111-1111-1111-8111-111111111111",
    operationId: "22222222-2222-2222-8222-222222222222",
    target: { kind: "create", mode: "plain" },
    state,
    rejection: state === "notAccepted" ? "busy" : null,
    startedAt: state === "notAccepted" ? null : "2026-09-27T00:00:00.000Z",
    settledAt: settled ? "2026-09-27T00:00:05.000Z" : null,
    runIds,
    experimentId: null,
    arms: [],
    requestOutcome: settled ? "returned" : null,
    errorCode: null,
    diagnostics: [],
    ...extra,
  };
}
