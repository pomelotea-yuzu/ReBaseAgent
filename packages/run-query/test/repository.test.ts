import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveCacheHitTotal, deriveRunSummary, deriveTerminalReason } from "../src/facts/summary";
import { RunRepository } from "../src/read/repository";

const FIXTURES = resolve(import.meta.dirname, "../../trace-sdk/fixtures");
const MAPPING: Array<[string, string]> = [
  ["normal", "r_01"],
  ["branch", "r_02"],
  ["tool-error", "r_03"],
  ["infinite-loop", "r_04"],
];
const T0 = "2026-10-22T00:00:00.000Z";

let dir: string;
let repo: RunRepository;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "run-query-repo-"));
  const traces = join(dir, "traces");
  mkdirSync(traces);
  for (const [fixture, id] of MAPPING) {
    copyFileSync(join(FIXTURES, `${fixture}.jsonl`), join(traces, `${id}.jsonl`));
  }
  repo = new RunRepository(traces);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function firstTwoLinesOfNormal(): string {
  const text = readFileSync(join(FIXTURES, "normal.jsonl"), "utf8");
  return text.split("\n").slice(0, 2).join("\n");
}

describe("run-query RunRepository", () => {
  it("扫描四份 fixture 并按创建时间倒序", () => {
    const { runs, failed } = repo.listRuns();
    expect(failed).toHaveLength(0);
    expect(runs.map((run) => run.id)).toEqual(["r_02", "r_04", "r_03", "r_01"]);
  });

  it("坏文件隔离为独立失败项，不拖垮合法摘要", () => {
    const firstLine = firstTwoLinesOfNormal().split("\n")[0] ?? "";
    writeFileSync(join(dir, "traces", "r_bad.jsonl"), `${firstLine}\n{"id":"s_01"}\n`);
    const { runs, failed } = repo.listRuns();
    expect(runs.map((run) => run.id)).toEqual(["r_02", "r_04", "r_03", "r_01"]);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.file).toBe("r_bad.jsonl");
    expect(failed[0]?.error).toContain("第 2 行");
  });

  it("未来版本文件成为失败项", () => {
    writeFileSync(
      join(dir, "traces", "r_future.jsonl"),
      firstTwoLinesOfNormal().replace('"format_version":1', '"format_version":4'),
    );
    const entry = repo.listRuns().failed.find((item) => item.file === "r_future.jsonl");
    expect(entry?.error).toContain("不支持的格式版本");
  });

  it("详细列表把身份错配作为独立失败项，详情读取仍拒绝", () => {
    copyFileSync(join(FIXTURES, "normal.jsonl"), join(dir, "traces", "wrong_name.jsonl"));
    const detailed = repo.listRunsDetailed();
    const entry = detailed.failed.find((item) => item.file === "wrong_name.jsonl");
    expect(entry?.code).toBe("IDENTITY_MISMATCH");
    expect(entry?.error).toContain("meta.id");
    // 旧 listRuns 行为不变：文件名可任意，不作为失败项
    expect(repo.listRuns().failed.some((item) => item.file === "wrong_name.jsonl")).toBe(false);
    expect(() => repo.getRun("wrong_name")).toThrow("身份不符");
  });

  it("坏文件在详细列表给 RUN_INVALID", () => {
    const firstLine = firstTwoLinesOfNormal().split("\n")[0] ?? "";
    writeFileSync(join(dir, "traces", "r_code_bad.jsonl"), `${firstLine}\n{"id":"s_01"}\n`);
    const entry = repo.listRunsDetailed().failed.find((item) => item.file === "r_code_bad.jsonl");
    expect(entry?.code).toBe("RUN_INVALID");
  });

  it("根 run 详情与分支 run 投影保持既有行为", () => {
    const root = repo.getRun("r_01");
    expect(root.meta.id).toBe("r_01");
    expect(root.chain).toHaveLength(1);
    expect(root.spanScope).toBe("own");

    const branch = repo.getRun("r_02");
    expect(branch.chain).toHaveLength(2);
    expect(branch.spanScope).toBe("resolved");
    expect(branch.spans.map((span) => span.id)).toEqual([
      "s_01",
      "s_02",
      "s_03",
      "s_09",
      "s_10",
      "s_11",
      "s_12",
      "s_13",
    ]);
  });

  it("缺父 result 分支仍严格失败", () => {
    expect(() => repo.getRun("r_missing_parent")).toThrow();
  });
});

describe("摘要事实：未知不补造", () => {
  const step = {
    type: "span" as const,
    id: "s_1",
    kind: "agent.step" as const,
    parent: null,
    n: 1,
  };
  const llm = {
    type: "span" as const,
    id: "s_2",
    kind: "llm.call" as const,
    parent: "s_1",
    request: {
      model: "m",
      messages: [{ role: "user", content: "u" }],
      tools: [],
    },
    response: {
      content: "ok",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 10, out: 5, cache_hit: 0 },
      ttft_ms: 1,
    },
  };
  const meta = {
    id: "r_1",
    task: "t",
    model: "m",
    created_at: T0,
    parent: null,
    fork: null,
  };

  it("无 llm.call 时 cacheHit/duration 保持未知，不补 0", () => {
    const summary = deriveRunSummary({
      meta,
      spans: [step],
      events: [{ reason: "completed" }],
      status: "completed",
    });
    expect(summary.steps).toBe(1);
    expect(summary.tokensIn).toBe(0);
    expect(summary.cacheHit).toBeNull();
    expect(summary.durationMs).toBeNull();
    expect(summary.reason).toBe("completed");
  });

  it("crashed 的残留 reason 不作为终止原因", () => {
    expect(deriveTerminalReason({ status: "crashed", events: [{ reason: "error" }] })).toBeNull();
  });

  it("cache_hit=0 是实测零命中，字段缺失才是未知", () => {
    expect(deriveCacheHitTotal([llm])).toBe(0);
    expect(
      deriveCacheHitTotal([{ ...llm, response: { ...llm.response, usage: { in: 10, out: 5 } } }]),
    ).toBeNull();
  });

  it("摘要保留 model_params 实验组标签", () => {
    const summary = deriveRunSummary({
      meta: {
        ...meta,
        parent: "r_parent",
        fork: {
          at_span: "s_1",
          edit: { field: "model_params", value: { experimentId: "exp_1" } },
        },
      },
      spans: [step],
      events: [{ reason: "completed" }],
      status: "completed",
    });
    expect(summary.fork).toEqual({
      at_span: "s_1",
      edit_field: "model_params",
      experiment_id: "exp_1",
    });
  });
});
