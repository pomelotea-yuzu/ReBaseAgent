import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { describe, expect, it } from "vitest";
import { findRunDetailVersionViolation } from "../src/shared/detail-version-guard";
import { RunDetailSchema, RunRecordSchema } from "../src/shared/ipc";

/**
 * R2.2 5.1：v3 RunRecord / RunDetail 的跨进程 schema 往返。
 *
 * trace-sdk 的 schema 已含 `prompt_experiment` 与 `origin.kind="initial"`；
 * 这里钉 IPC 复用的同一 schema 能完整保留 v3 字段，且 strip 前守卫要求
 * v3 必须带 workspace + prompt_experiment。
 */

const snapshot = createWorkspaceSnapshot([
  { path: "config.json", sha256: "a".repeat(64), bytes: 3 },
]);

const rootMeta = {
  type: "run.meta" as const,
  id: "r_root",
  format_version: 2 as const,
  task: "根",
  model: "m",
  created_at: "2026-10-21T00:00:00.000Z",
  parent: null,
  fork: null,
  config_hash: "sha256:root",
  workspace: {
    profile: "file-tools-v1" as const,
    world_id: "r_root",
    write_authorized: true as const,
    initial_snapshot: snapshot,
    origin: { kind: "import" as const },
  },
};

const v3Meta = {
  type: "run.meta" as const,
  id: "r_v3",
  format_version: 3 as const,
  task: "隔离 prompt 实验",
  model: "m",
  created_at: "2026-10-21T00:01:00.000Z",
  parent: "r_root",
  fork: { at_span: "s_02", edit: { field: "system_prompt", value: "new" } },
  config_hash: "sha256:new",
  workspace: {
    profile: "file-tools-v1" as const,
    world_id: "r_v3",
    write_authorized: true as const,
    initial_snapshot: snapshot,
    origin: { kind: "initial" as const, run_id: "r_root", snapshot_id: snapshot.id },
  },
  prompt_experiment: {
    baseline_run_id: "r_root",
    baseline_llm_span_id: "s_02",
    initial_snapshot_id: snapshot.id,
    original_value: "old",
    execution: {
      model: "m",
      params: { temperature: 0.2 },
      provider_endpoint: "https://api.example.com/v1",
      max_iterations: 10,
      budget: 100_000,
      config_fingerprint: "sha256:fp",
    },
    hypothesis: "假设",
    acceptance_criterion: "判据",
  },
};

const step = {
  type: "span" as const,
  id: "s_01",
  kind: "agent.step" as const,
  parent: null,
  n: 1,
  workspace_snapshot: snapshot,
};

const llm = {
  type: "span" as const,
  id: "s_02",
  kind: "llm.call" as const,
  parent: "s_01",
  request: {
    model: "m",
    messages: [
      { role: "system", content: "new" },
      { role: "user", content: "u" },
    ],
    tools: [],
    params: { temperature: 0.2 },
  },
  response: {
    content: "完成",
    reasoning_content: null,
    tool_calls: [],
    usage: { in: 10, out: 5 },
    ttft_ms: 1,
  },
};

const event = {
  type: "run.event" as const,
  event: "stopped" as const,
  reason: "completed" as const,
  at: 1,
};

describe("IPC v3 往返", () => {
  it("RunRecordSchema 完整保留 workspace.origin=initial 与 prompt_experiment", () => {
    const parsed = RunRecordSchema.parse({
      meta: v3Meta,
      spans: [step, llm],
      events: [event],
      status: "completed",
    });
    expect(parsed.meta.format_version).toBe(3);
    expect(parsed.meta.workspace?.origin).toEqual({
      kind: "initial",
      run_id: "r_root",
      snapshot_id: snapshot.id,
    });
    expect(parsed.meta.prompt_experiment).toEqual(v3Meta.prompt_experiment);
    expect(parsed.spans).toHaveLength(2);
  });

  it("RunDetailSchema：v3 自有轨迹 + 根→v3 链通过完整性与版本守卫", () => {
    const detail = {
      meta: v3Meta,
      spans: [step, llm],
      events: [event],
      status: "completed",
      chain: [
        { meta: rootMeta, fork: null },
        { meta: v3Meta, fork: v3Meta.fork },
      ],
      leafSpanIds: ["s_01", "s_02"],
      completeness: "complete",
      spanScope: "own",
      lineage: { status: "complete" },
    };
    const parsed = RunDetailSchema.parse(detail);
    expect(parsed.meta.prompt_experiment?.baseline_run_id).toBe("r_root");
    expect(parsed.meta.workspace?.origin.kind).toBe("initial");
    expect(findRunDetailVersionViolation(detail)).toBeNull();
  });

  it("strip 前守卫：v3 缺 prompt_experiment 明确拒绝", () => {
    const { prompt_experiment: _dropped, ...missing } = v3Meta;
    const detail = {
      meta: missing,
      spans: [step, llm],
      events: [event],
      status: "completed",
      chain: [
        { meta: rootMeta, fork: null },
        { meta: missing, fork: v3Meta.fork },
      ],
      leafSpanIds: ["s_01", "s_02"],
      completeness: "complete",
      spanScope: "own",
      lineage: { status: "complete" },
    };
    expect(findRunDetailVersionViolation(detail)).toContain("prompt_experiment");
    expect(RunDetailSchema.safeParse(detail).success).toBe(false);
  });
});
