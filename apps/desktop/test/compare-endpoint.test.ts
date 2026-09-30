import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  COMPARE_RUN_INVALID_CODE,
  COMPARE_RUN_UNREADABLE_CODE,
  compareRunsEndpoint,
} from "../src/main/compare-endpoints";
import { CompareRunsResultSchema } from "../src/shared/ipc";
import type { CompareRunItem, RunDetail } from "../src/shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 1.3：逐对象失败结果和合法侧保留。
 *
 * 端点级判据（design D3）：请求级拒绝在文件读取之前；逐项 ready/unavailable
 * 顺序恒等于请求顺序；单侧失败不拖垮合法侧；失败项保留真实 runId 与受控中文
 * 原因（不伪空文本、不降级 ownOnly、不换对象）；响应整体通过自家 schema。
 * 场景对应「一侧不可读保留另一侧」与「比较拒绝非法身份和错配载荷」的请求半边。
 */

const T0 = "2026-01-15T10:00:00.000Z";

let root: string;
let traces: string;

function freshTraces(): string {
  root = mkdtempSync(join(tmpdir(), "u7-compare-endpoint-"));
  traces = join(root, "traces");
  mkdirSync(traces);
  return traces;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function metaLine(id: string, opts: { parent?: string | null; fork?: unknown } = {}): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task: "u7 端点夹具",
    model: "controlled-model",
    created_at: T0,
    parent: opts.parent ?? null,
    fork: opts.fork ?? null,
  });
}

function stepLine(id: string): string {
  return JSON.stringify({ type: "span", id, parent: null, kind: "agent.step", n: 1 });
}

const STOP = JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" });

function forkOf(field: string, atSpan: string): unknown {
  return { at_span: atSpan, edit: { field, value: `${field} 编辑值` } };
}

function writeRun(id: string, lines: string[]): void {
  writeFileSync(join(traces, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

function endpoint(runIds: string[]): ReturnType<typeof compareRunsEndpoint> {
  return compareRunsEndpoint({ tracesDir: traces }, { runIds });
}

function itemsAs(
  result: Extract<ReturnType<typeof compareRunsEndpoint>, { ok: true }>,
): CompareRunItem[] {
  const parsed = CompareRunsResultSchema.safeParse({ items: result.items });
  expect(parsed.success).toBe(true);
  return (parsed.data as { items: CompareRunItem[] }).items;
}

describe("U7 1.3 请求级拒绝（文件读取之前）", () => {
  it("非法 run 标识（目录穿越）整体拒绝，合法侧也一并拒绝且不建读取上下文", () => {
    freshTraces();
    writeRun("r_ok", [metaLine("r_ok"), STOP]);
    const outcome = endpoint(["r_ok", "../escape"]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("INVALID_ARGUMENT");
      expect(outcome.message).toContain("run 标识非法");
    }
  });

  it("绝对路径与路径分隔符同判非法（拒绝发生在任何 trace 读取之前）", () => {
    freshTraces();
    expect(endpoint(["C:\\other\\x"]).ok).toBe(false);
    expect(endpoint(["a/b"]).ok).toBe(false);
  });

  it("schema 形状非法（超上限/重复/空 id/多余字段）走 INVALID_ARGUMENT 且受控文案", () => {
    freshTraces();
    const tooMany = compareRunsEndpoint(
      { tracesDir: traces },
      {
        runIds: ["a", "b", "c", "d", "e"],
      },
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.message).toContain("最多");

    const duplicate = compareRunsEndpoint({ tracesDir: traces }, { runIds: ["a", "a"] });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.message).toContain("比较对象重复");

    const strict = compareRunsEndpoint({ tracesDir: traces }, { runIds: ["a"], extra: 1 });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.code).toBe("INVALID_ARGUMENT");
  });
});

describe("U7 1.3 逐对象失败结果与合法侧保留", () => {
  it("合法侧 ready + 缺失侧 unavailable：顺序恒等于请求，响应整体过 schema", () => {
    freshTraces();
    writeRun("r_good", [metaLine("r_good"), stepLine("g_s1"), STOP]);
    const outcome = endpoint(["r_good", "r_gone"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const items = itemsAs(outcome);
      expect(items.map((item) => item.runId)).toEqual(["r_good", "r_gone"]);
      expect(items[0]?.status).toBe("ready");
      expect(items[1]?.status).toBe("unavailable");
      if (items[1]?.status === "unavailable") {
        expect(items[1].code).toBe("CURRENT_RUN_NOT_FOUND");
        expect(items[1].reason).toContain("trace 文件不存在");
      }
    }
  });

  it("单侧失败不拖垮合法侧：损坏祖先与成环都逐项 unavailable，合法侧完整返回", () => {
    freshTraces();
    writeRun("r_good2", [metaLine("r_good2"), STOP]);
    writeRun("r_bad_anc", ['{"type":"run.meta","id":"r_bad_anc"']);
    writeRun("r_on_bad", [
      metaLine("r_on_bad", { parent: "r_bad_anc", fork: forkOf("result", "s_01") }),
      STOP,
    ]);
    // 成环：两跳互相引用
    writeRun("r_loop_a", [
      metaLine("r_loop_a", { parent: "r_loop_b", fork: forkOf("result", "s_01") }),
      STOP,
    ]);
    writeRun("r_loop_b", [
      metaLine("r_loop_b", { parent: "r_loop_a", fork: forkOf("result", "s_01") }),
      STOP,
    ]);

    const outcome = endpoint(["r_good2", "r_on_bad", "r_loop_a"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const items = itemsAs(outcome);
      expect(items.map((item) => item.status)).toEqual(["ready", "unavailable", "unavailable"]);
      if (items[1]?.status === "unavailable") {
        expect(items[1].code).toBe("ANCESTOR_INVALID");
        expect(items[1].reason).toContain("r_bad_anc");
      }
      if (items[2]?.status === "unavailable") {
        expect(items[2].code).toBe("LINEAGE_CYCLE");
      }
      // 合法侧不被降级：ready 项携带完整详情
      if (items[0]?.status === "ready") {
        const detail = items[0].detail as RunDetail;
        expect(detail.completeness).toBe("complete");
      }
    }
  });

  it("祖先缺失（ownOnly 语义）在比较中也是 ready 项：detail 自带 ownOnly 标签", () => {
    freshTraces();
    writeRun("r_own", [
      metaLine("r_own", { parent: "r_missing", fork: forkOf("result", "s_01") }),
      STOP,
    ]);
    const outcome = endpoint(["r_own"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const items = itemsAs(outcome);
      expect(items[0]?.status).toBe("ready");
      if (items[0]?.status === "ready") {
        expect(items[0].detail.completeness).toBe("ownOnly");
      }
    }
  });

  it("fork 定位非法（resolveBranch 拒绝）映射 FORK_INVALID，不落兜底码", () => {
    freshTraces();
    writeRun("r_parent", [metaLine("r_parent"), stepLine("other_s1"), STOP]);
    writeRun("r_fork_bad", [
      metaLine("r_fork_bad", { parent: "r_parent", fork: forkOf("result", "s_not_there") }),
      STOP,
    ]);
    const outcome = endpoint(["r_fork_bad"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const items = itemsAs(outcome);
      if (items[0]?.status === "unavailable") {
        expect(items[0].code).toBe("FORK_INVALID");
        expect(items[0].reason).toContain("分支轨迹解析失败");
      } else {
        throw new Error("fork 定位非法应逐项不可用");
      }
    }
  });

  it("超长受控原因被有界截断（超长 run id 场景），不撑破响应 schema", () => {
    freshTraces();
    const longId = `r_${"长".repeat(400)}`;
    const outcome = endpoint([longId]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const items = itemsAs(outcome);
      if (items[0]?.status === "unavailable") {
        expect([...items[0].reason].length).toBeLessThanOrEqual(513);
      } else {
        throw new Error("缺失的超长 id 应逐项不可用");
      }
    }
  });

  it("稳定码都在受控集合内：无诊断的当前 run 失败用 RUN_INVALID 而非异常原文", () => {
    freshTraces();
    writeRun("r_broken_self", ["这不是 JSON"]);
    const outcome = endpoint(["r_broken_self"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const items = itemsAs(outcome);
      if (items[0]?.status === "unavailable") {
        expect(items[0].code).toBe(COMPARE_RUN_INVALID_CODE);
        expect([COMPARE_RUN_INVALID_CODE, COMPARE_RUN_UNREADABLE_CODE]).toContain(items[0].code);
      } else {
        throw new Error("损坏的当前记录应逐项不可用");
      }
    }
  });
});
