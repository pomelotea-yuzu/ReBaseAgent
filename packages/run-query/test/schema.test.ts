import { describe, expect, it } from "vitest";
import {
  COMPARE_REASON_MAX,
  CompareRunsRequestSchema,
  CompareRunsResultSchema,
  RunDetailSchema,
  RunSummarySchema,
  WorkspaceInspectResultSchema,
  WorkspaceReadFileResultSchema,
  findRunDetailIntegrityViolation,
} from "../src/schema";

const sha = (c: string) => c.repeat(64);

const rootMeta = {
  type: "run.meta" as const,
  id: "r_root",
  format_version: 1 as const,
  task: "根运行",
  model: "deepseek-chat",
  created_at: "2026-10-22T00:00:00.000Z",
  parent: null,
  fork: null,
  config_hash: "sha256:root",
};

const step = {
  type: "span" as const,
  id: "s_01",
  kind: "agent.step" as const,
  parent: null,
  n: 1,
};

const llm = {
  type: "span" as const,
  id: "s_02",
  kind: "llm.call" as const,
  parent: "s_01",
  request: {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "你好" }],
    tools: [],
  },
  response: {
    content: "完成",
    reasoning_content: null,
    tool_calls: [],
    usage: { in: 10, out: 5 },
    ttft_ms: 1,
  },
};

const stopped = {
  type: "run.event" as const,
  event: "stopped" as const,
  reason: "completed" as const,
  at: 100,
};

const completeDetail = {
  meta: rootMeta,
  spans: [step, llm],
  events: [stopped],
  status: "completed" as const,
  chain: [{ meta: rootMeta, fork: null }],
  leafSpanIds: ["s_01", "s_02"],
  completeness: "complete" as const,
  spanScope: "own" as const,
  lineage: { status: "complete" as const },
};

const childMeta = {
  type: "run.meta" as const,
  id: "r_child",
  format_version: 1 as const,
  task: "缺父分支",
  model: "deepseek-chat",
  created_at: "2026-10-22T00:01:00.000Z",
  parent: "r_missing",
  fork: { at_span: "s_02", edit: { field: "system_prompt", value: "新值" } },
  config_hash: "sha256:child",
};

const ownOnlyDetail = {
  meta: childMeta,
  spans: [step, llm],
  events: [stopped],
  status: "completed" as const,
  chain: [{ meta: childMeta, fork: childMeta.fork }],
  leafSpanIds: ["s_01", "s_02"],
  completeness: "ownOnly" as const,
  spanScope: "own" as const,
  lineage: {
    status: "incomplete" as const,
    reason: "ANCESTOR_NOT_FOUND" as const,
    missingRunId: "r_missing",
  },
};

describe("run-query 领域 schema", () => {
  it("RunSummary 保留未知消耗与实验分叉摘要", () => {
    const parsed = RunSummarySchema.parse({
      id: "r_1",
      task: "任务",
      model: "m",
      created_at: "2026-10-22T00:00:00.000Z",
      status: "completed",
      parent: null,
      reason: "completed",
      fork: { at_span: "s_02", edit_field: "model_params", experiment_id: "exp_1" },
      steps: 1,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 10,
      tokensOut: 5,
      cacheHit: null,
      durationMs: null,
      source: null,
    });
    expect(parsed.cacheHit).toBeNull();
    expect(parsed.durationMs).toBeNull();
    expect(parsed.fork?.experiment_id).toBe("exp_1");
  });

  it("RunDetail 接受 v1 完整根详情", () => {
    const parsed = RunDetailSchema.parse(completeDetail);
    expect(parsed.meta.id).toBe("r_root");
    expect(parsed.leafSpanIds).toEqual(["s_01", "s_02"]);
  });

  it("RunDetail 接受祖先缺失的 ownOnly 详情", () => {
    const parsed = RunDetailSchema.parse(ownOnlyDetail);
    expect(parsed.completeness).toBe("ownOnly");
    expect(parsed.lineage).toEqual({
      status: "incomplete",
      reason: "ANCESTOR_NOT_FOUND",
      missingRunId: "r_missing",
    });
  });

  it("RunDetail 拒绝 ownOnly 配 resolved 的错配", () => {
    const result = RunDetailSchema.safeParse({ ...ownOnlyDetail, spanScope: "resolved" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join("；")).toContain(
        "completeness=ownOnly 只允许 spanScope=own",
      );
    }
  });

  it("完整性判据拒绝 missingRunId 出现在 chain 内", () => {
    const violation = findRunDetailIntegrityViolation({
      ...ownOnlyDetail,
      chain: [
        { meta: { ...childMeta, id: "r_missing", parent: null }, fork: null },
        { meta: childMeta, fork: childMeta.fork },
      ],
    });
    expect(violation).toContain("不允许出现在 chain 内");
  });

  it("CompareRunsRequest 拒绝重复、空数组与超过 4 个", () => {
    expect(CompareRunsRequestSchema.safeParse({ runIds: ["a", "b"] }).success).toBe(true);
    expect(CompareRunsRequestSchema.safeParse({ runIds: ["a", "a"] }).success).toBe(false);
    expect(CompareRunsRequestSchema.safeParse({ runIds: [] }).success).toBe(false);
    expect(CompareRunsRequestSchema.safeParse({ runIds: ["a", "b", "c", "d", "e"] }).success).toBe(
      false,
    );
  });

  it("CompareRunsResult 保留逐侧 unavailable 的真实身份", () => {
    const parsed = CompareRunsResultSchema.parse({
      items: [
        { status: "unavailable", runId: "r_bad", code: "RUN_INVALID", reason: "损坏" },
        { status: "unavailable", runId: "r_ok", code: "ANCESTOR_UNREADABLE", reason: "不可读" },
      ],
    });
    expect(parsed.items.map((item) => item.runId)).toEqual(["r_bad", "r_ok"]);
    expect(COMPARE_REASON_MAX).toBe(512);
  });

  it("WorkspaceInspectResult 保留逐文件可用性与来源", () => {
    const parsed = WorkspaceInspectResultSchema.parse({
      runId: "r_1",
      stepSpanId: null,
      snapshotId: sha("a"),
      ownerRunId: "r_1",
      localIteration: null,
      profile: "file-tools-v1",
      worldId: "r_1",
      origin: { kind: "initial", runId: "r_root", snapshotId: sha("a") },
      files: [
        {
          path: "a.txt",
          bytes: 3,
          sha256: sha("b"),
          change: "initial",
          availability: "ok",
          unavailableReason: null,
        },
      ],
      fileCount: 1,
      totalBytes: 3,
      unavailableCount: 0,
      initialSnapshotId: sha("a"),
    });
    expect(parsed.files[0]?.availability).toBe("ok");
  });

  it("WorkspaceReadFileResult 六态可分辨", () => {
    const cases = [
      { status: "text", path: "a.txt", bytes: 1, sha256: sha("a"), text: "x" },
      { status: "binary", path: "b.bin", bytes: 1, sha256: sha("b") },
      { status: "not_found", path: "c.txt", reason: "清单无此路径" },
      { status: "missing", path: "d.txt", bytes: 1, sha256: sha("d"), reason: "附件缺失" },
      { status: "corrupt", path: "e.txt", bytes: 1, sha256: sha("e"), reason: "哈希不符" },
      { status: "rejected", code: "WORKSPACE_STEP_NOT_FOUND", reason: "步骤不属于本 run" },
    ];
    for (const item of cases) {
      expect(WorkspaceReadFileResultSchema.safeParse(item).success).toBe(true);
    }
  });
});
