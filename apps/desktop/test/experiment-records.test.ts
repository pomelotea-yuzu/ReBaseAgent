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
    expect(findModelParamsRecordViolation(arm, parent)).toEqual({
      status: "eligible",
      code: "OK",
      reason: "",
    });
  });

  it("臂缺 config_hash（老文件）⇒ unverifiable（不冒充通过、不反推）", () => {
    const { arm, parent } = legitPair({ armHash: null });
    const result = findModelParamsRecordViolation(arm, parent);
    expect(result).toMatchObject({ status: "unverifiable", code: "CONFIG_HASH_UNRECORDED" });
  });

  it("父本缺 config_hash ⇒ unverifiable", () => {
    const { arm, parent } = legitPair({ parentHash: null });
    expect(findModelParamsRecordViolation(arm, parent)).toMatchObject({
      status: "unverifiable",
      code: "CONFIG_HASH_UNRECORDED",
    });
  });

  it("hash 不同源（工具表/system 被改过）⇒ ineligible（明确拒绝）", () => {
    const { arm, parent } = legitPair({ armHash: "sha256:bbbb" });
    expect(findModelParamsRecordViolation(arm, parent)).toMatchObject({
      status: "ineligible",
      code: "CONFIG_HASH_MISMATCH",
    });
  });

  it("首请求模型与编辑值不一致 ⇒ ineligible", () => {
    const { arm, parent } = legitPair({ armModel: "m3" }); // 编辑值说 m2，请求却是 m3
    expect(findModelParamsRecordViolation(arm, parent)).toMatchObject({
      status: "ineligible",
      code: "REQUEST_MODEL_MISMATCH",
    });
  });

  it("params 整体覆盖语义：编辑给 params ⇒ 与臂请求核对；未给 ⇒ 沿用父值", () => {
    // 编辑给了 { temperature: 0.9 }，臂请求也是 0.9 ⇒ eligible
    const given = legitPair({ editParams: { temperature: 0.9 }, armParams: { temperature: 0.9 } });
    expect(findModelParamsRecordViolation(given.arm, given.parent).status).toBe("eligible");

    // 编辑给了 0.9 但请求还是 0.7 ⇒ mismatch
    const wrong = legitPair({ editParams: { temperature: 0.9 }, armParams: { temperature: 0.7 } });
    expect(findModelParamsRecordViolation(wrong.arm, wrong.parent)).toMatchObject({
      status: "ineligible",
      code: "REQUEST_PARAMS_MISMATCH",
    });

    // 编辑未给 params ⇒ 沿用父值 0.7（臂请求 0.7 ⇒ eligible）
    const inherited = legitPair({ editParams: undefined, armParams: { temperature: 0.7 } });
    expect(findModelParamsRecordViolation(inherited.arm, inherited.parent).status).toBe("eligible");
  });

  it("臂无自有 llm.call ⇒ unverifiable（首请求无从核对）", () => {
    const { arm, parent } = legitPair({});
    const empty: RunDetail = { ...arm, spans: [], leafSpanIds: [] };
    expect(findModelParamsRecordViolation(empty, parent)).toMatchObject({
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
    expect(findModelParamsRecordViolation(arm, parent)).toMatchObject({
      status: "ineligible",
      code: "NOT_MODEL_ARM",
    });
  });
});

describe("5.16 工具表/副作用声明", () => {
  it("空工具表（两侧都无 tools 字段）⇒ eligible", () => {
    const { arm, parent } = legitPair({});
    expect(findToolRecordViolation(arm, parent)).toEqual({
      status: "eligible",
      code: "OK",
      reason: "",
    });
  });

  it("无风险工具（sideEffect: false 显式标记）⇒ eligible，无需声明", () => {
    const safe = [{ name: "read_file", sideEffect: false }];
    const { arm, parent } = legitPair({ parentTools: safe, armTools: safe });
    expect(findToolRecordViolation(arm, parent).status).toBe("eligible");
  });

  it("风险工具（标记缺失按有副作用）+ 显式 allowSideEffects: true ⇒ eligible（留痕）", () => {
    const risky = [{ name: "write_file" }]; // 无 sideEffect 字段 ⇒ 风险
    const { arm, parent } = legitPair({
      parentTools: risky,
      armTools: risky,
      allowSideEffects: true,
    });
    expect(findToolRecordViolation(arm, parent).status).toBe("eligible");
  });

  it("风险工具 + 未声明 ⇒ ineligible（SIDE_EFFECT_UNDECLARED，如实拒绝）", () => {
    const risky = [{ name: "write_file" }];
    const { arm, parent } = legitPair({ parentTools: risky, armTools: risky });
    expect(findToolRecordViolation(arm, parent)).toMatchObject({
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
    expect(findToolRecordViolation(arm, parent)).toMatchObject({
      status: "ineligible",
      code: "SIDE_EFFECT_CONTRADICTION",
    });
  });

  it("工具表不一致 ⇒ ineligible；含 sideEffect 字段有无的差异（补标记被拒）", () => {
    // 两侧都是 write_file，但父补了 sideEffect: false——「补齐缺失标记」即不同源
    const parentTools = [{ name: "write_file", sideEffect: false }];
    const armTools = [{ name: "write_file" }];
    const { arm, parent } = legitPair({ parentTools, armTools });
    expect(findToolRecordViolation(arm, parent)).toMatchObject({
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
    });
    expect(findToolRecordViolation(more.arm, more.parent)).toMatchObject({
      status: "ineligible",
      code: "TOOLS_MISMATCH",
    });
  });

  it("臂无自有 llm.call ⇒ unverifiable", () => {
    const { arm, parent } = legitPair({});
    const empty: RunDetail = { ...arm, spans: [], leafSpanIds: [] };
    expect(findToolRecordViolation(empty, parent)).toMatchObject({
      status: "unverifiable",
      code: "START_REQUEST_UNRECORDED",
    });
  });
});
