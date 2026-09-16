import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunRepository } from "../src/main/run-repository";

/** fixture 文件名 ↔ run id 映射（fixture 内部的 id 决定） */
const FIXTURES = resolve(import.meta.dirname, "../../../packages/trace-sdk/fixtures");
const MAPPING: Array<[string, string]> = [
  ["normal", "r_01"],
  ["branch", "r_02"],
  ["tool-error", "r_03"],
  ["infinite-loop", "r_04"],
];

let dir: string;
let repo: RunRepository;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rebase-repo-"));
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

describe("listRuns：扫描与隔离", () => {
  it("四份 run 全部列出，按创建时间倒序", () => {
    const { runs, failed } = repo.listRuns();
    expect(failed).toHaveLength(0);
    expect(runs.map((r) => r.id)).toEqual(["r_02", "r_04", "r_03", "r_01"]);
  });

  it("单个文件损坏只隔离该文件，其余照常展示（带行号的原因）", () => {
    const traces = join(dir, "traces");
    // 首行为合法 run.meta，第 2 行缺 type 字段
    writeFileSync(
      join(traces, "r_bad.jsonl"),
      `${readFirstTwoLinesOfNormal().split("\n")[0]}\n{"id":"s_01"}\n`,
    );

    const { runs, failed } = repo.listRuns();
    expect(runs.map((r) => r.id)).toEqual(["r_02", "r_04", "r_03", "r_01"]);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.file).toBe("r_bad.jsonl");
    expect(failed[0]?.error).toContain("第 2 行");
  });

  it("format_version 过高的文件呈失败条目并提示版本不支持", () => {
    const traces = join(dir, "traces");
    const lines = readFirstTwoLinesOfNormal();
    // v2 起是受支持版本（v1/v2 双读）⇒ 未来版本用 3
    writeFileSync(
      join(traces, "r_future.jsonl"),
      lines.replace('"format_version":1', '"format_version":3'),
    );

    const { failed } = repo.listRuns();
    const entry = failed.find((f) => f.file === "r_future.jsonl");
    expect(entry?.error).toContain("不支持的格式版本");
  });
});

function readFirstTwoLinesOfNormal(): string {
  const text = readFileSync(join(FIXTURES, "normal.jsonl"), "utf8");
  return text.split("\n").slice(0, 2).join("\n");
}

describe("getRun：根 run 与分支 run", () => {
  it("根 run：chain 只有一跳，spans 即文件原样内容", () => {
    const detail = repo.getRun("r_01");
    expect(detail.meta.id).toBe("r_01");
    expect(detail.chain).toHaveLength(1);
    expect(detail.spans).toHaveLength(8);
    expect(detail.status).toBe("completed");
  });

  it("分支 run：resolveBranch 拼接父前缀 + 新增 span，并暴露 fork 元数据", () => {
    const detail = repo.getRun("r_02");
    // 父 run 8 个 span，fork 点 s_03 及之前共享（s_01..s_03），加本 run 5 个新增
    expect(detail.spans.map((s) => s.id)).toEqual([
      "s_01",
      "s_02",
      "s_03",
      "s_09",
      "s_10",
      "s_11",
      "s_12",
      "s_13",
    ]);
    expect(detail.chain).toHaveLength(2);
    const leafHop = detail.chain[detail.chain.length - 1];
    expect(leafHop?.fork?.at_span).toBe("s_03");
    expect(leafHop?.fork?.edit.field).toBe("result");
  });

  it("父 run 文件缺失 → 明确报错，不静默返回部分轨迹", () => {
    expect(() => repo.getRun("r_missing_parent")).toThrow();
  });
});
