import type { Fork, SpanLine } from "@rebaseagent/trace-sdk/schema";
import { describe, expect, it } from "vitest";
import {
  findModelParamsRecordViolation,
  findToolRecordViolation,
} from "../src/shared/experiment-records";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 5.14/5.16：历史实验比较的逐记录资格判据。
 *
 * 判据来源：model-experiments delta「历史比较不依赖当前密钥和预览」：
 * - 只从**已校验记录**核对（config_hash 只比已记录值，绝不重算/反推 RunConfig）；
 * - 记录不足以证明 ⇒ unverifiable（不冒充通过）；不自洽 ⇒ ineligible（不放宽）；
 * - 等价锚点：sideEffect 缺失按有副作用处理、工具表含 sideEffect 字段的有无、
 *   params 整体覆盖语义——全部与执行路径（model-replay-run 既有门禁）同款判据；
 *   执行路径零改动，replay 既有测试套即等价回归。
 */

const T0 = "2026-01-15T10:00:00.000Z";
const HASH = "sha256:aaaa";

function meta(
  id: string,
  parent: string | null,
  fork: Fork | null,
  configHash?: string,
): RunDetail["meta"] {
  return {
    type: "run.meta",
    id,
    format_version: 1,
    task: `任务 ${id}`,
    model: "m",
    created_at: T0,
    parent,
    fork,
    ...(configHash !== undefined ? { config_hash: configHash } : {}),
  };
}

function stepSpan(id: string, n = 1): Extract<SpanLine, { kind: "agent.step" }> {
  return { type: "span", id, parent: null, kind: "agent.step", n };
}

function llmSpan(
  id: string,
  opts: {
    model?: string;
    params?: Record<string, unknown>;
    tools?: Array<Record<string, unknown>>;
  } = {},
): Extract<SpanLine, { kind: "llm.call" }> {
  return {
    type: "span",
    id,
    parent: "s_01",
    kind: "llm.call",
    request: {
      model: opts.model ?? "m",
      messages: [{ role: "system", content: "系统提示" }],
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      ...(opts.params !== undefined ? { params: opts.params } : {}),
    },
    response: {
      content: "正文",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 1, out: 1, cache_hit: 0 },
      ttft_ms: 0,
    },
  };
}

function detailOf(
  id: string,
  parent: string | null,
  fork: Fork | null,
  spans: SpanLine[],
  configHash?: string,
): RunDetail {
  const hop = (
    id: string,
    parent: string | null,
    fork: Fork | null,
  ): RunDetail["chain"][number] => ({
    meta: meta(id, parent, fork),
    fork,
  });
  return {
    meta: meta(id, parent, fork, configHash),
    spans,
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    chain:
      parent === null ? [hop(id, null, fork)] : [hop(parent, null, null), hop(id, parent, fork)],
    leafSpanIds: spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

/** 纯对话父本（无工具、temperature 0.7）+ 换模型的合法臂；hash 传 null = 不记录（老文件） */
function legitPair(opts: {
  armModel?: string;
  /** 编辑值声明的模型（缺省 m2）；与臂请求模型（armModel）分开，便于构造不自洽 */
  editModel?: string;
  armParams?: Record<string, unknown> | undefined;
  editParams?: Record<string, unknown> | undefined;
  parentTools?: Array<Record<string, unknown>>;
  armTools?: Array<Record<string, unknown>>;
  allowSideEffects?: boolean;
  armHash?: string | null;
  parentHash?: string | null;
}) {
  const parentTools = opts.parentTools;
  const armTools = opts.armTools ?? parentTools;
  const parent = detailOf(
    "r_p",
    null,
    null,
    [
      stepSpan("s_01"),
      llmSpan("c_01", {
        params: { temperature: 0.7 },
        ...(parentTools !== undefined ? { tools: parentTools } : {}),
      }),
    ],
    opts.parentHash === undefined ? HASH : (opts.parentHash ?? undefined),
  );
  const editValue: Record<string, unknown> = {
    model: opts.editModel ?? "m2",
    ...(opts.editParams !== undefined ? { params: opts.editParams } : {}),
    ...(opts.allowSideEffects !== undefined ? { allowSideEffects: opts.allowSideEffects } : {}),
  };
  const fork: Fork = { at_span: "c_01", edit: { field: "model_params", value: editValue } };
  const armSpan: Extract<SpanLine, { kind: "llm.call" }> = {
    ...llmSpan("c_01", {
      model: opts.armModel ?? "m2",
      params: opts.armParams ?? { temperature: 0.7 },
      ...(armTools !== undefined ? { tools: armTools } : {}),
    }),
  };
  const arm = detailOf(
    "r_a",
    "r_p",
    fork,
    [stepSpan("s_01", 1), armSpan],
    opts.armHash === undefined ? HASH : (opts.armHash ?? undefined),
  );
  return { parent, arm };
}

describe("5.14 参数/首请求/config_hash 记录一致性", () => {
  it("合法臂：同源 hash + 首请求模型/参数自洽 ⇒ eligible", () => {
    const { arm, parent } = legitPair({});
    expect(findModelParamsRecordViolation(arm, parent.meta)).toEqual({
      status: "eligible",
      code: "OK",
      reason: "",
    });
  });

  it("臂缺 config_hash（老文件）⇒ unverifiable（不冒充通过、不反推）", () => {
    const { arm, parent } = legitPair({ armHash: null });
    const result = findModelParamsRecordViolation(arm, parent.meta);
    expect(result).toMatchObject({ status: "unverifiable", code: "CONFIG_HASH_UNRECORDED" });
  });

  it("父本缺 config_hash ⇒ unverifiable", () => {
    const { arm, parent } = legitPair({ parentHash: null });
    expect(findModelParamsRecordViolation(arm, parent.meta)).toMatchObject({
      status: "unverifiable",
      code: "CONFIG_HASH_UNRECORDED",
    });
  });

  it("hash 不同源（工具表/system 被改过）⇒ ineligible（明确拒绝）", () => {
    const { arm, parent } = legitPair({ armHash: "sha256:bbbb" });
    expect(findModelParamsRecordViolation(arm, parent.meta)).toMatchObject({
      status: "ineligible",
      code: "CONFIG_HASH_MISMATCH",
    });
  });

  it("首请求模型与编辑值不一致 ⇒ ineligible", () => {
    const { arm, parent } = legitPair({ armModel: "m3" }); // 编辑值说 m2，请求却是 m3
    expect(findModelParamsRecordViolation(arm, parent.meta)).toMatchObject({
      status: "ineligible",
      code: "REQUEST_MODEL_MISMATCH",
    });
  });

  it("params 整体覆盖语义：编辑给 params ⇒ 与臂请求核对；未给 ⇒ 沿用父值", () => {
    // 编辑给了 { temperature: 0.9 }，臂请求也是 0.9 ⇒ eligible
    const given = legitPair({ editParams: { temperature: 0.9 }, armParams: { temperature: 0.9 } });
    expect(findModelParamsRecordViolation(given.arm, given.parent.meta).status).toBe("eligible");

    // 编辑给了 0.9 但请求还是 0.7 ⇒ mismatch
    const wrong = legitPair({ editParams: { temperature: 0.9 }, armParams: { temperature: 0.7 } });
    expect(findModelParamsRecordViolation(wrong.arm, wrong.parent.meta)).toMatchObject({
      status: "ineligible",
      code: "REQUEST_PARAMS_MISMATCH",
    });

    // 编辑未给 params ⇒ 沿用父值 0.7（臂请求 0.7 ⇒ eligible）
    const inherited = legitPair({ editParams: undefined, armParams: { temperature: 0.7 } });
    expect(findModelParamsRecordViolation(inherited.arm, inherited.parent.meta).status).toBe(
      "eligible",
    );
  });

  it("臂无自有 llm.call ⇒ unverifiable（首请求无从核对）", () => {
    const { arm, parent } = legitPair({});
    const empty: RunDetail = { ...arm, spans: [], leafSpanIds: [] };
    expect(findModelParamsRecordViolation(empty, parent.meta)).toMatchObject({
      status: "unverifiable",
      code: "START_REQUEST_UNRECORDED",
    });
  });

  it("非 model_params 臂 ⇒ ineligible（调用方契约的防御确认）", () => {
    const parent = detailOf("r_p", null, null, [stepSpan("s_01"), llmSpan("c_01")], HASH);
    const arm = detailOf(
      "r_a",
      "r_p",
      { at_span: "c_01", edit: { field: "system_prompt", value: "x" } },
      [stepSpan("s_01", 1), llmSpan("c_01")],
      HASH,
    );
    expect(findModelParamsRecordViolation(arm, parent.meta)).toMatchObject({
      status: "ineligible",
      code: "NOT_MODEL_ARM",
    });
  });
});

describe("5.16 工具表/副作用声明", () => {
  it("空工具表（两侧都无 tools 字段）⇒ eligible", () => {
    const { arm, parent } = legitPair({});
    expect(findToolRecordViolation(arm, parent.meta)).toEqual({
      status: "eligible",
      code: "OK",
      reason: "",
    });
  });

  it("无风险工具（sideEffect: false 显式标记）⇒ eligible，无需声明", () => {
    const safe = [{ name: "read_file", sideEffect: false }];
    const { arm, parent } = legitPair({ parentTools: safe, armTools: safe });
    expect(findToolRecordViolation(arm, parent.meta).status).toBe("eligible");
  });

  it("风险工具（标记缺失按有副作用）+ 显式 allowSideEffects: true ⇒ eligible（留痕）", () => {
    const risky = [{ name: "write_file" }]; // 无 sideEffect 字段 ⇒ 风险
    const { arm, parent } = legitPair({
      parentTools: risky,
      armTools: risky,
      allowSideEffects: true,
    });
    expect(findToolRecordViolation(arm, parent.meta).status).toBe("eligible");
  });

  it("风险工具 + 未声明 ⇒ ineligible（SIDE_EFFECT_UNDECLARED，如实拒绝）", () => {
    const risky = [{ name: "write_file" }];
    const { arm, parent } = legitPair({ parentTools: risky, armTools: risky });
    expect(findToolRecordViolation(arm, parent.meta)).toMatchObject({
      status: "ineligible",
      code: "SIDE_EFFECT_UNDECLARED",
    });
  });

  it("风险工具 + 显式 false ⇒ 声明与记录矛盾（SIDE_EFFECT_CONTRADICTION）", () => {
    const risky = [{ name: "write_file" }];
    const { arm, parent } = legitPair({
      parentTools: risky,
      armTools: risky,
      allowSideEffects: false,
    });
    expect(findToolRecordViolation(arm, parent.meta)).toMatchObject({
      status: "ineligible",
      code: "SIDE_EFFECT_CONTRADICTION",
    });
  });

  it("工具表不一致 ⇒ ineligible；含 sideEffect 字段有无的差异（补标记被拒）——hash 随之不同源", () => {
    // 工具表差异必然伴随 config_hash 不同源（指纹输入含工具表逐字段）
    const parentTools = [{ name: "write_file", sideEffect: false }];
    const armTools = [{ name: "write_file" }];
    const { arm, parent } = legitPair({
      parentTools,
      armTools,
      armHash: "sha256:cccc",
    });
    expect(findToolRecordViolation(arm, parent.meta)).toMatchObject({
      status: "ineligible",
      code: "TOOLS_MISMATCH",
    });

    // 真正的表不同（多一个工具）同样拒
    const more = legitPair({
      parentTools: [{ name: "write_file", sideEffect: false }],
      armTools: [
        { name: "write_file", sideEffect: false },
        { name: "read_file", sideEffect: false },
      ],
      armHash: "sha256:cccc",
    });
    expect(findToolRecordViolation(more.arm, more.parent.meta)).toMatchObject({
      status: "ineligible",
      code: "TOOLS_MISMATCH",
    });
  });

  it("臂无自有 llm.call ⇒ unverifiable", () => {
    const { arm, parent } = legitPair({});
    const empty: RunDetail = { ...arm, spans: [], leafSpanIds: [] };
    expect(findToolRecordViolation(empty, parent.meta)).toMatchObject({
      status: "unverifiable",
      code: "START_REQUEST_UNRECORDED",
    });
  });
});

// ---------------------------------------------------------------------------
// tasks 5.11–5.13：选择集级实验门禁（deriveExperimentGate）
// ---------------------------------------------------------------------------

import { deriveExperimentGate } from "../src/shared/experiment-records";
import type { CompareRunItem } from "../src/shared/ipc";

function gateItem(
  id: string,
  parent: string | null,
  fork: Fork | null,
  opts: {
    hash?: string;
    parentHash?: string;
    completeness?: "complete" | "ownOnly";
    model?: string;
    outcome?: "completed" | "error";
  } = {},
): CompareRunItem {
  const parentMeta = meta(parent ?? "r_p_missing", null, null, opts.parentHash ?? HASH);
  const armMeta = meta(id, parent, fork, opts.hash ?? HASH);
  const armCall = llmSpan("c_01", { model: opts.model ?? "m2" });
  const spans =
    opts.outcome === "error"
      ? [stepSpan("s_01"), { ...armCall, error: { message: "上游失败" } }]
      : [stepSpan("s_01"), armCall];
  const detail: RunDetail = {
    meta: armMeta,
    spans,
    events: [
      opts.outcome === "error"
        ? { type: "run.event", event: "errored", reason: "error" }
        : { type: "run.event", event: "stopped", reason: "completed" },
    ],
    status: "completed",
    chain:
      parent === null
        ? [{ meta: armMeta, fork }]
        : [
            { meta: parentMeta, fork: null },
            { meta: armMeta, fork },
          ],
    leafSpanIds: spans.map((span) => span.id),
    completeness: opts.completeness ?? "complete",
    spanScope: opts.completeness === "ownOnly" ? "own" : "own",
    lineage:
      opts.completeness === "ownOnly"
        ? { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: parent ?? "r_x" }
        : { status: "complete" },
  };
  return { status: "ready", runId: id, detail, chainSummaries: [] };
}

/** 合法 model_params 臂（同父 r_p、hash 同源、无工具） */
function armItem(
  id: string,
  opts: {
    hash?: string;
    parent?: string;
    experimentId?: string;
    model?: string;
    outcome?: "completed" | "error";
  } = {},
) {
  const editValue: Record<string, unknown> = {
    model: opts.model ?? "m2",
    ...(opts.experimentId !== undefined ? { experimentId: opts.experimentId } : {}),
  };
  const fork: Fork = { at_span: "c_01", edit: { field: "model_params", value: editValue } };
  return gateItem(id, opts.parent ?? "r_p", fork, {
    hash: opts.hash ?? HASH,
    parentHash: HASH,
    model: opts.model ?? "m2",
    outcome: opts.outcome,
  });
}

function normalItem(id: string): CompareRunItem {
  const detail: RunDetail = {
    meta: meta(id, null, null, HASH),
    spans: [stepSpan("s_01"), llmSpan("c_01")],
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    chain: [hop2(id, null)],
    leafSpanIds: ["s_01", "c_01"],
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
  return { status: "ready", runId: id, detail, chainSummaries: [] };
}

function hop2(id: string, parent: string | null): RunDetail["chain"][number] {
  return { meta: meta(id, parent, null, HASH), fork: null };
}

describe("5.12/5.13 选择集级实验门禁", () => {
  it("同父合法两臂 ⇒ eligible，批次身份保留各臂已记录 experimentId", () => {
    const gate = deriveExperimentGate([
      armItem("r_a1", { experimentId: "exp_1" }),
      armItem("r_a2", { experimentId: "exp_2" }),
    ]);
    expect(gate.status).toBe("eligible");
    if (gate.status === "eligible") {
      expect(gate.batch).toEqual({
        parentRunId: "r_p",
        experimentIds: ["exp_1", "exp_2"],
      });
    }
  });

  it("无 model_params 臂 ⇒ notExperiment（普通比较路径）", () => {
    const gate = deriveExperimentGate([normalItem("r_a"), normalItem("r_b")]);
    expect(gate.status).toBe("notExperiment");
  });

  it("混入普通 run ⇒ ineligible MIXED_SELECTION（experimentId 相同也不能豁免）", () => {
    const gate = deriveExperimentGate([
      armItem("r_a", { experimentId: "exp_1" }),
      normalItem("r_n"),
    ]);
    expect(gate).toMatchObject({ status: "ineligible", code: "MIXED_SELECTION" });
  });

  it("异父臂 ⇒ ineligible PARENT_DIFFERS；相同 experimentId 不能绕过", () => {
    const gate = deriveExperimentGate([
      armItem("r_a1", { experimentId: "exp_same" }),
      armItem("r_a2", { parent: "r_other_p", experimentId: "exp_same" }),
    ]);
    expect(gate).toMatchObject({ status: "ineligible", code: "PARENT_DIFFERS" });
  });

  it("任一臂 ownOnly（父链不完整）⇒ ineligible CHAIN_INCOMPLETE", () => {
    const ownOnlyFork: Fork = {
      at_span: "c_01",
      edit: { field: "model_params", value: { model: "m2" } },
    };
    const gate = deriveExperimentGate([
      armItem("r_a1"),
      gateItem("r_a2", "r_missing", ownOnlyFork, {
        completeness: "ownOnly",
        parentHash: "sha256:zzz",
      }),
    ]);
    expect(gate).toMatchObject({ status: "ineligible", code: "CHAIN_INCOMPLETE" });
  });

  it("臂 hash 与父不同源 ⇒ ineligible CONFIG_HASH_MISMATCH", () => {
    const gate = deriveExperimentGate([armItem("r_a1"), armItem("r_a2", { hash: "sha256:bbbb" })]);
    expect(gate).toMatchObject({ status: "ineligible", code: "CONFIG_HASH_MISMATCH" });
  });

  it("存在不可读侧 ⇒ unverifiable RUN_UNREADABLE", () => {
    const gate = deriveExperimentGate([
      armItem("r_a1"),
      { status: "unavailable", runId: "r_x", code: "RUN_UNREADABLE", reason: "读取失败" },
    ]);
    expect(gate).toMatchObject({ status: "unverifiable", code: "RUN_UNREADABLE" });
  });

  it("风险工具未声明 ⇒ ineligible SIDE_EFFECT_UNDECLARED（5.16 判据在选择集生效）", () => {
    const risky = [{ name: "write_file" }];
    const fork: Fork = { at_span: "c_01", edit: { field: "model_params", value: { model: "m2" } } };
    const item = gateItem("r_a1", "r_p", fork, { hash: HASH, parentHash: HASH });
    const withTools: RunDetail = {
      ...item.detail,
      spans: [
        stepSpan("s_01"),
        {
          ...(item.detail.spans[1] as Extract<SpanLine, { kind: "llm.call" }>),
          request: {
            ...(item.detail.spans[1] as Extract<SpanLine, { kind: "llm.call" }>).request,
            tools: risky,
          },
        },
      ],
    };
    const gate = deriveExperimentGate([
      item,
      { status: "ready", runId: "r_a2", detail: withTools, chainSummaries: [] },
    ]);
    expect(gate).toMatchObject({ status: "ineligible", code: "SIDE_EFFECT_UNDECLARED" });
  });

  it("合法失败臂（error 结局）不因结局自动拒绝 ⇒ eligible（事实比较保留）", () => {
    const gate = deriveExperimentGate([armItem("r_a1", { outcome: "error" }), armItem("r_a2")]);
    expect(gate.status).toBe("eligible");
  });
});
