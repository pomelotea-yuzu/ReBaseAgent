import { describe, expect, it } from "vitest";
import {
  COMPARE_CODE_MAX,
  COMPARE_REASON_MAX,
  CompareRunsRequestSchema,
  CompareRunsResultSchema,
  findCompareResponseMismatch,
} from "../src/shared/ipc";
import type {
  CompareRunItem,
  CompareRunsRequest,
  CompareRunsResult,
  RunDetail,
  RunSummary,
} from "../src/shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 1.1：只读比较请求/响应契约。
 *
 * 数量（1–4）、唯一身份（互异）、完整性（逐项 ready/unavailable 结构 + RunDetail
 * 原样校验）与受控错误（code/reason 有界、拒绝未知形态）；响应错配判定
 * `findCompareResponseMismatch` 对数量/顺序/身份/重复逐一咬人。
 * main 侧接线与非法标识的路径校验归 1.2/1.6，这里只钉跨进程契约本身。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function hop(id: string, parent: string | null): { meta: RunDetail["meta"]; fork: null } {
  return {
    meta: {
      id,
      parent,
      type: "run.meta",
      format_version: 1,
      task: "u7 比较夹具",
      model: "controlled-model",
      created_at: T0,
      fork: null,
    },
    fork: null,
  };
}

/** 合法根 run 详情（complete/own），供 ready 项使用 */
function validRootDetail(id: string): RunDetail {
  return {
    meta: hop(id, null).meta,
    spans: [],
    events: [],
    status: "completed",
    chain: [hop(id, null)],
    leafSpanIds: [],
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

/** 该 run 的自有摘要（根→叶有序、含自身；U7 1.7 起为 ready 项必填） */
function ownSummaries(id: string, parent: string | null = null): RunSummary[] {
  return [
    {
      id,
      task: `任务 ${id}`,
      model: "controlled-model",
      created_at: T0,
      status: "completed",
      parent,
      reason: "completed",
      fork: null,
      steps: 1,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 10,
      tokensOut: 5,
      cacheHit: null,
      durationMs: 100,
      source: null,
    },
  ];
}

function readyItem(id: string): CompareRunItem {
  return {
    status: "ready",
    runId: id,
    detail: validRootDetail(id),
    chainSummaries: ownSummaries(id),
  };
}

function unavailableItem(id: string): CompareRunItem {
  return {
    status: "unavailable",
    runId: id,
    code: "COMPARE_RUN_UNREADABLE",
    reason: "trace 文件无法读取",
  };
}

function parseRequest(runIds: string[]) {
  return CompareRunsRequestSchema.safeParse({ runIds } satisfies { runIds: string[] });
}

function parseResult(items: CompareRunItem[]) {
  return CompareRunsResultSchema.safeParse({ items } satisfies { items: CompareRunItem[] });
}

describe("U7 1.1 比较请求契约：数量与唯一身份", () => {
  it("1–4 个互异非空 id 合法（单条也允许：单侧自有事实阅读）", () => {
    expect(parseRequest(["r_a"]).success).toBe(true);
    expect(parseRequest(["r_a", "r_b", "r_c", "r_d"]).success).toBe(true);
  });

  it("空集合被拒：至少需要 1 个运行", () => {
    const parsed = parseRequest([]);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("至少");
    }
  });

  it("第五条被拒：最多 4 个运行", () => {
    const parsed = parseRequest(["r_a", "r_b", "r_c", "r_d", "r_e"]);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("最多");
    }
  });

  it("重复 id 被拒：受控文案点名重复对象", () => {
    const parsed = parseRequest(["r_a", "r_b", "r_a"]);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const text = JSON.stringify(parsed.error.issues);
      expect(text).toContain("比较对象重复");
      expect(text).toContain("r_a");
    }
  });

  it("空字符串 id 被拒（与 main 侧非法标识校验互补，不重复其路径判据）", () => {
    expect(parseRequest([""]).success).toBe(false);
  });

  it("strict：多余字段与缺失 runIds 一律拒绝，不接受客户端自报指标或执行身份", () => {
    expect(
      CompareRunsRequestSchema.safeParse({ runIds: ["r_a"], operation: { epoch: 1 } }).success,
    ).toBe(false);
    expect(CompareRunsRequestSchema.safeParse({}).success).toBe(false);
    expect(CompareRunsRequestSchema.safeParse({ runIds: "r_a" }).success).toBe(false);
  });
});

describe("U7 1.1 比较响应契约：逐项 ready/unavailable", () => {
  it("ready 项携带与 runs:get 同一 schema 的详情（完整性标签随 detail 自带）", () => {
    expect(parseResult([readyItem("r_a")]).success).toBe(true);
    // ownOnly 详情同样是合法 ready 项——比较层不二次降级；链摘要同步截断
    const ownOnly = validRootDetail("r_c");
    ownOnly.completeness = "ownOnly";
    ownOnly.spanScope = "own";
    ownOnly.chain = [hop("r_b", "r_no"), hop("r_c", "r_b")];
    ownOnly.lineage = {
      status: "incomplete",
      reason: "ANCESTOR_NOT_FOUND",
      missingRunId: "r_no",
    };
    expect(
      parseResult([
        {
          status: "ready",
          runId: "r_c",
          detail: ownOnly,
          chainSummaries: [{ ...ownSummaries("r_c")[0]!, parent: "r_b" }],
        },
      ]).success,
    ).toBe(true);
  });

  it("ready 项缺链摘要被拒：共同祖先/累计派生必须吃本次已校验自有摘要（1.7）", () => {
    expect(
      parseResult([
        {
          status: "ready",
          runId: "r_a",
          detail: validRootDetail("r_a"),
        } as unknown as CompareRunItem,
      ]).success,
    ).toBe(false);
  });

  it("unavailable 项保留真实身份并携带有界受控码与原因", () => {
    expect(parseResult([unavailableItem("r_a")]).success).toBe(true);
  });

  it("受控错误有界：code/reason 超长拒绝，不透传路径与堆栈的载体", () => {
    expect(
      parseResult([
        {
          status: "unavailable",
          runId: "r_a",
          code: "c".repeat(COMPARE_CODE_MAX + 1),
          reason: "原因",
        },
      ]).success,
    ).toBe(false);
    expect(
      parseResult([
        {
          status: "unavailable",
          runId: "r_a",
          code: "CODE",
          reason: "长".repeat(COMPARE_REASON_MAX + 1),
        },
      ]).success,
    ).toBe(false);
    // 边界内恰好合法
    expect(
      parseResult([
        {
          status: "unavailable",
          runId: "r_a",
          code: "c".repeat(COMPARE_CODE_MAX),
          reason: "长".repeat(COMPARE_REASON_MAX),
        },
      ]).success,
    ).toBe(true);
  });

  it("未知形态拒绝：未知 status、空 code/reason、ready 缺详情、strict 多余字段", () => {
    expect(
      parseResult([{ status: "pending", runId: "r_a" } as unknown as CompareRunItem]).success,
    ).toBe(false);
    expect(
      parseResult([{ status: "unavailable", runId: "r_a", code: "", reason: "原因" }]).success,
    ).toBe(false);
    expect(
      parseResult([{ status: "ready", runId: "r_a" } as unknown as CompareRunItem]).success,
    ).toBe(false);
    expect(
      parseResult([
        { ...unavailableItem("r_a"), detail: validRootDetail("r_a") } as unknown as CompareRunItem,
      ]).success,
    ).toBe(false);
  });

  it("items 数量边界与请求一致（空集合与超上限都在响应侧拒绝）", () => {
    expect(parseResult([]).success).toBe(false);
    expect(
      parseResult([
        readyItem("r_a"),
        unavailableItem("r_b"),
        readyItem("r_c"),
        unavailableItem("r_d"),
        readyItem("r_e"),
      ]).success,
    ).toBe(false);
  });
});

describe("U7 1.1 响应错配判定：身份、顺序、数量与重复", () => {
  const request: CompareRunsRequest = { runIds: ["r_a", "r_b"] };

  it("与请求逐项相容时返回 null（ready 与 unavailable 都按 runId 对位）", () => {
    const result: CompareRunsResult = {
      items: [readyItem("r_a"), unavailableItem("r_b")],
    };
    expect(findCompareResponseMismatch(request.runIds, result)).toBeNull();
  });

  it("项数不符拒绝：少一项或多一项都不是整体应用的对象", () => {
    expect(findCompareResponseMismatch(request.runIds, { items: [readyItem("r_a")] })).toContain(
      "项数与请求不符",
    );
    expect(
      findCompareResponseMismatch(request.runIds, {
        items: [readyItem("r_a"), unavailableItem("r_b"), readyItem("r_c")],
      }),
    ).toContain("项数与请求不符");
  });

  it("顺序不符拒绝：不把另一对象内容放到当前标题下", () => {
    const result: CompareRunsResult = {
      items: [unavailableItem("r_b"), readyItem("r_a")],
    };
    const mismatch = findCompareResponseMismatch(request.runIds, result);
    expect(mismatch).not.toBeNull();
    expect(mismatch ?? "").toContain("r_b");
  });

  it("响应内重复 runId 拒绝：同对象不能顶替两个请求位", () => {
    const result: CompareRunsResult = {
      items: [readyItem("r_a"), unavailableItem("r_a")],
    };
    const mismatch = findCompareResponseMismatch(request.runIds, result);
    expect(mismatch).not.toBeNull();
    expect(mismatch ?? "").toContain("重复");
  });
});
