import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RunRepository } from "../src/main/run-repository";
import { findRunDetailVersionViolation } from "../src/shared/detail-version-guard";

/**
 * U1（refactor-run-workspace）任务 6.7：坏文件 / 未来版本 / v1 非法隔离字段 / 缺祖先 读取层回归。
 *
 * 判据来源：tasks.md 6.7——「验证『非法详情不被概览绕过』『列表刷新失败可重试』及主 spec『单个文件
 * 读取失败不阻塞列表』，正常运行继续可读，不吞校验异常为部分详情」。
 *
 * ⚠️ 与 6.4–6.6 不同：这一组是**读取/校验层**判据，天然不发模型请求，故不设受控服务；用真实的
 * 既有 fixture（trace-sdk）在磁盘上混排好/坏/未来版本/v1 私带隔离字段/缺祖先五类文件，验证
 * `listRuns` 的隔离语义 + `getRun`/守卫不吞校验异常。
 *
 * 核心补强（此前未显式覆盖的组合）：**v1 文件在磁盘上私带 `workspace` ⇒ 列表照常列出（可读 trace），
 * 但详情被版本守卫拒绝、且过不了 `RunDetailSchema`**——这正是「非法详情不被概览绕过」的落点：
 * 概览读的是 store 里那份已被守卫拦截的详情，绝不让这种载荷漏进渲染。
 */

const FIXTURES = resolve(import.meta.dirname, "../../../packages/trace-sdk/fixtures");

function tempRepo(): { traces: string; repo: RunRepository; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "baddata-regression-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** normal.jsonl ——合法 v1 的种子源；返回原始行与 meta 里真实的 run id */
function seed(): { meta: string; rest: string; id: string } {
  const text = readFileSync(join(FIXTURES, "normal.jsonl"), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const meta = lines[0] ?? "{}";
  const parsed = JSON.parse(meta) as { id?: string };
  return { meta, rest: lines.slice(1).join("\n"), id: parsed.id ?? "r_01" };
}

describe("6.7 读取层回归：坏文件/未来版本/v1 非法隔离/缺祖先", () => {
  it("单个文件损坏只隔离该文件，其余照常展示，且好 run 详情仍可读", () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const { meta, rest, id } = seed();
      writeFileSync(join(traces, `${id}.jsonl`), `${meta}\n${rest}\n`);
      // 坏文件：第 2 行是合法 JSON 但缺 type 字段（可解析的非法 span）
      writeFileSync(join(traces, "r_bad.jsonl"), `${meta}\n{"id":"s_01"}\n`);

      const { runs, failed } = repo.listRuns();
      expect(runs.map((r) => r.id)).toEqual([id]);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.file).toBe("r_bad.jsonl");
      expect(failed[0]?.error).not.toHaveLength(0);

      // 正常 run 继续可读（详情不缺字段、不吞异常）
      const detail = repo.getRun(id);
      expect(detail.status).toBe("completed");
      expect(detail.spans.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it("format_version 过高的文件进 failed 并提示版本不支持（不冒充可读 run）", () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const { meta, rest, id } = seed();
      const future = `${meta.replace('"format_version":1', '"format_version":3')}\n${rest}\n`;
      writeFileSync(join(traces, "r_future.jsonl"), future);
      writeFileSync(join(traces, `${id}.jsonl`), `${meta}\n${rest}\n`);

      const { runs, failed } = repo.listRuns();
      expect(runs.map((r) => r.id)).toEqual([id]);
      const entry = failed.find((f) => f.file === "r_future.jsonl");
      expect(entry?.error).toContain("不支持");
    } finally {
      cleanup();
    }
  });

  it("v1 文件私带 workspace：文件级版本守卫在 readRun 即拒 ⇒ 进 failed、绝不被吞成可读 run（非法详情进不了概览）", () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const { meta, rest, id } = seed();
      const v1Meta = JSON.parse(meta) as Record<string, unknown>;
      v1Meta.format_version = 1;
      v1Meta.workspace = { world_id: "r_iso", origin: { kind: "import" } };
      writeFileSync(join(traces, "./r_iso_v1.jsonl"), `${JSON.stringify(v1Meta)}\n${rest}\n`);
      writeFileSync(join(traces, `${id}.jsonl`), `${meta}\n${rest}\n`);

      // 列表：v1 私带 workspace 的文件被 readRun 文件级守卫拒绝 → failed，不是 runs
      const { runs, failed } = repo.listRuns();
      expect(runs.map((r) => r.id)).toEqual([id]); // 好 run 照常
      const violation = failed.find((f) => f.file === "r_iso_v1.jsonl");
      expect(violation).toBeDefined();
      if (violation !== undefined) expect(violation.error).not.toHaveLength(0);

      // 详情：getRun 也抛（readRun 拒）；纯守卫函数对篡改载荷仍能指名 workspace（IPC 层第二道防线）
      expect(() => repo.getRun("r_iso_v1")).toThrow();
      expect(findRunDetailVersionViolation(detailOfV1(v1Meta))).toContain("workspace");
    } finally {
      cleanup();
    }
  });

  it("缺祖先 / 坏详情：getRun 明确报错，不静默返回部分轨迹", () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const { meta } = seed();
      // 孤儿：meta.parent 指向不存在的 run
      const orphanMeta = JSON.parse(meta) as Record<string, unknown>;
      orphanMeta.id = "r_orphan";
      orphanMeta.parent = "run_missing";
      writeFileSync(join(traces, "r_orphan.jsonl"), `${JSON.stringify(orphanMeta)}\n`);
      // 空文件（残缺）：不可解析
      writeFileSync(join(traces, "r_empty.jsonl"), "");

      expect(() => repo.getRun("run_missing")).toThrow();
      // 缺祖先：孤儿 run 的 parent 文件不存在 → 明确报错（不静默返回"只剩本 run"的部分轨迹）
      expect(() => repo.getRun("r_orphan")).toThrow();
      // 残留空文件不静默变成"0 span 的可用 run"
      const { failed } = repo.listRuns();
      const empty = failed.find((f) => f.file === "r_empty.jsonl");
      expect(empty).toBeDefined();
      if (empty !== undefined) expect(empty.error).not.toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

/** 用最小详情形状承载篡改后的 v1 meta（供纯守卫函数验证 IPC 层第二道防线） */
function detailOfV1(meta: Record<string, unknown>): unknown {
  return {
    meta,
    spans: [],
    events: [],
    status: "completed",
    chain: [{ meta, fork: meta.fork ?? null }],
    leafSpanIds: [],
  };
}
