import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterAll, describe, expect, it } from "vitest";
import { findIllegalRunIdViolation, readRunLineage } from "../src/main/run-lineage-read";
import { RunRepository } from "../src/main/run-repository";

/**
 * U6（add-partial-run-reading）tasks §1：结构化读取诊断。
 *
 * 1.1 当前缺失/祖先 ENOENT 分类、1.2 损坏与不可读区分、1.3 版本守卫回归、
 * 1.4 身份与路径校验、1.5 结构检查与「缺失不遮蔽已知错误」、1.6 受控文案。
 *
 * 边界（§3 起生效）：普通/隔离 result 缺祖先返回结构化 ownOnly；prompt/代理的
 * 截断链同样 ownOnly（§2 起）。文件头注释随实施段落更新。
 */

const FIXTURES = resolve(import.meta.dirname, "../../../packages/trace-sdk/fixtures");
const T0 = "2026-01-15T10:00:00.000Z";

let root: string;
let traces: string;

function freshTraces(): string {
  root = mkdtempSync(join(tmpdir(), "u6-lineage-"));
  traces = join(root, "traces");
  mkdirSync(traces);
  return traces;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function metaLine(
  id: string,
  opts: {
    parent?: string | null;
    fork?: unknown;
    version?: number;
    extra?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: opts.version ?? 1,
    task: "u6 分类夹具",
    model: "controlled-model",
    created_at: T0,
    parent: opts.parent ?? null,
    fork: opts.fork ?? null,
    ...opts.extra,
  });
}

function stepLine(
  id: string,
  opts: { parent?: string | null; n?: number; snapshot?: unknown } = {},
): string {
  return JSON.stringify({
    type: "span",
    id,
    parent: opts.parent ?? null,
    kind: "agent.step",
    n: opts.n ?? 1,
    ...(opts.snapshot !== undefined ? { workspace_snapshot: opts.snapshot } : {}),
  });
}

const STOP = JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" });

function v1Fork(atSpan: string): unknown {
  return { at_span: atSpan, edit: { field: "result", value: "编辑后的结果" } };
}

/** v2 隔离分支 meta：origin.step_span 与 resume_after_step 同指（RunMetaSchema 自洽约束） */
function v2ChildMeta(id: string, parent: string, atSpan: string, resumeAfter: string): string {
  return metaLine(id, {
    parent,
    version: 2,
    fork: {
      at_span: atSpan,
      resume_after_step: resumeAfter,
      edit: { field: "result", value: "隔离重跑" },
    },
    extra: {
      workspace: {
        profile: "file-tools-v1",
        world_id: id,
        write_authorized: true,
        initial_snapshot: createWorkspaceSnapshot([]),
        origin: { kind: "checkpoint", run_id: parent, step_span: resumeAfter },
      },
    },
  });
}

function writeRun(id: string, lines: string[]): void {
  writeFileSync(join(traces, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

/** 受控文案判据：无 errno 原文、无物理路径、无堆栈行 */
function expectControlled(message: string): void {
  expect(message).not.toContain("ENOENT");
  expect(message).not.toContain("EACCES");
  expect(message).not.toContain(traces);
  expect(message).not.toMatch(/[A-Za-z]:\\/);
  expect(message).not.toContain("    at ");
}

/** 读文件计数注入（证明非法标识在任何 fs 访问之前就被拒绝） */
function countingReadFile(): { readFile: (file: string) => RunRecord; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    readFile: () => {
      calls += 1;
      throw new Error("计数注入不应真的读文件");
    },
  };
}

describe("U6 §1 readRunLineage：结构化读取诊断", () => {
  it("1.1 当前文件缺失 → CURRENT_RUN_NOT_FOUND，原因受控（对应「当前文件或祖先不是可确认的缺失」）", () => {
    freshTraces();
    const outcome = readRunLineage(traces, "r_ghost");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("CURRENT_RUN_NOT_FOUND");
    expect(outcome.message).toContain("r_ghost");
    expectControlled(outcome.message);
  });

  it("1.1 完整 v1 父链 → complete:true，记录按根到叶排列（对照「普通 result 的完整父链仍合并」）", () => {
    freshTraces();
    for (const [file, id] of [
      ["normal", "r_01"],
      ["branch", "r_02"],
    ] as const) {
      copyFileSync(join(FIXTURES, `${file}.jsonl`), join(traces, `${id}.jsonl`));
    }
    const outcome = readRunLineage(traces, "r_02");
    expect(outcome).toMatchObject({ ok: true, complete: true });
    if (!outcome.ok || !outcome.complete) return;
    expect(outcome.records.map((r) => r.meta.id)).toEqual(["r_01", "r_02"]);
  });

  it("1.1 直接父缺失 → 结构化 missingRunId 指向直接父（对照「普通 result 缺祖先只读当前记录」的分类半边）", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_no", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    const outcome = readRunLineage(traces, "r_c");
    expect(outcome).toMatchObject({ ok: true, complete: false, missingRunId: "r_no" });
    if (!outcome.ok || outcome.complete) return;
    expect(outcome.records.map((r) => r.meta.id)).toEqual(["r_c"]);
  });

  it("1.1 隔代祖先缺失 → 链保留当前与直接父，missingRunId 是隔代（对应「普通 result 的隔代祖先缺失」分类半边）", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: v1Fork("s_01") }),
      stepLine("c_s1"),
      STOP,
    ]);
    writeRun("r_b", [
      metaLine("r_b", { parent: "r_no", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    const outcome = readRunLineage(traces, "r_c");
    expect(outcome).toMatchObject({ ok: true, complete: false, missingRunId: "r_no" });
    if (!outcome.ok || outcome.complete) return;
    // 不把直接父误报为缺失，也不混入断点另一侧
    expect(outcome.records.map((r) => r.meta.id)).toEqual(["r_b", "r_c"]);
  });

  it("1.2 祖先 JSONL 损坏 → ANCESTOR_INVALID 严格失败，不降级（对应「祖先文件损坏不降级」）", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    writeFileSync(join(traces, "r_b.jsonl"), `${metaLine("r_b", { parent: null })}\n{"id":\n`);
    const outcome = readRunLineage(traces, "r_c");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("ANCESTOR_INVALID");
    expect(outcome.message).toContain("JSON 解析失败");
    expectControlled(outcome.message);
  });

  it("1.2 祖先位置是目录 → ANCESTOR_UNREADABLE（目录代替文件不是缺失）", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_dir", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    mkdirSync(join(traces, "r_dir.jsonl"));
    const outcome = readRunLineage(traces, "r_c");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("ANCESTOR_UNREADABLE");
    expectControlled(outcome.message);
  });

  it("1.2 权限错误按 errno 结构化判定 → ANCESTOR_UNREADABLE，不比较异常文本（注入祖先读取层）", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    const realC = readRunLineage(traces, "r_c");
    expect(realC.ok).toBe(true);
    const denied = Object.assign(new Error("EACCES: permission denied, open 'secret'"), {
      code: "EACCES",
    });
    // 只对祖先路径注入：当前 hop 走真实读取，EACCES 必须落在祖先分类上
    const outcome = readRunLineage(traces, "r_c", (file) => {
      if (file.includes("r_b")) throw denied;
      return readRun(file);
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("ANCESTOR_UNREADABLE");
    expect(outcome.message).not.toContain("EACCES");
    expectControlled(outcome.message);
  });

  it("1.3 未来版本祖先 → 版本守卫拒绝，不是缺失（对应「未来版本祖先不降级」）", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    writeRun("r_b", [metaLine("r_b", { version: 3 })]);
    const outcome = readRunLineage(traces, "r_c");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("ANCESTOR_INVALID");
    expect(outcome.message).toContain("3");
    expectControlled(outcome.message);
  });

  it("1.3 v1 祖先私带隔离字段（meta/fork/span 三处，值 null/空对象也算存在）→ 守卫失败而非缺失", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);

    // meta.workspace = false
    writeRun("r_b", [
      metaLine("r_b", { parent: null, extra: { workspace: false } }),
      stepLine("s_01"),
      STOP,
    ]);
    const viaMeta = readRunLineage(traces, "r_c");
    expect(viaMeta).toMatchObject({ ok: false, diagnostic: "ANCESTOR_INVALID" });

    // v1 fork.resume_after_step（值合法字符串；版本守卫在 schema 之前）
    writeRun("r_b", [
      metaLine("r_b", {
        parent: null,
        fork: { ...v1Fork("s_01"), resume_after_step: "s_01" },
      }),
      stepLine("s_01"),
      STOP,
    ]);
    const viaFork = readRunLineage(traces, "r_c");
    expect(viaFork).toMatchObject({ ok: false, diagnostic: "ANCESTOR_INVALID" });

    // v1 span.workspace_snapshot = {}
    writeRun("r_b", [metaLine("r_b", { parent: null }), stepLine("s_01", { snapshot: {} }), STOP]);
    const viaSpan = readRunLineage(traces, "r_c");
    expect(viaSpan).toMatchObject({ ok: false, diagnostic: "ANCESTOR_INVALID" });
  });

  it("1.4 非法请求标识在任何 fs 访问之前拒绝（对应「文件身份与路径不能伪造来源」的路径半边）", () => {
    freshTraces();
    const { readFile, calls } = countingReadFile();
    for (const bad of ["../evil", "a\\b", "C:\\x", ""]) {
      const outcome = readRunLineage(traces, bad, readFile);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.message).toContain("run 标识非法");
        expectControlled(outcome.message);
      }
    }
    expect(findIllegalRunIdViolation("run_ok")).toBeNull();
    expect(calls()).toBe(0);
  });

  it("1.4 祖先 meta.id 与文件名不符 → 拒绝详情，不从错误正文猜缺失 ID", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    writeRun("r_b", [metaLine("r_other", { parent: null }), stepLine("s_01"), STOP]);
    const outcome = readRunLineage(traces, "r_c");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("ANCESTOR_INVALID");
    expect(outcome.message).not.toContain("缺失");
    expectControlled(outcome.message);
  });

  it("1.5 祖先链成环 → LINEAGE_CYCLE 终止，不死循环不截断（对应「祖先链成环不降级」）", () => {
    freshTraces();
    writeRun("r_a", [
      metaLine("r_a", { parent: "r_b", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    writeRun("r_b", [
      metaLine("r_b", { parent: "r_a", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    const outcome = readRunLineage(traces, "r_a");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("LINEAGE_CYCLE");
    expectControlled(outcome.message);
  });

  it("1.5 可读 hop 缺 fork 且更早祖先缺失 → FORK_INVALID 优先于缺失（对应「已知无效关系不能被更早缺失遮蔽」）", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    writeRun("r_b", [metaLine("r_b", { parent: "r_no", fork: null }), stepLine("s_01"), STOP]);
    const outcome = readRunLineage(traces, "r_c");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("FORK_INVALID");
    expect(outcome.message).toContain("r_b");
  });

  it("1.5 根 run 携带 fork → FORK_INVALID", () => {
    freshTraces();
    writeRun("r_a", [
      metaLine("r_a", { parent: null, fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    const outcome = readRunLineage(traces, "r_a");
    expect(outcome).toMatchObject({ ok: false, diagnostic: "FORK_INVALID" });
  });

  it("1.5 祖先未封存且隔代缺失 → 严格失败而非 ownOnly（未封存不能被缺失遮蔽）", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    // r_b crashed：无终止事件
    writeRun("r_b", [metaLine("r_b", { parent: "r_no", fork: v1Fork("s_01") }), stepLine("s_01")]);
    const outcome = readRunLineage(traces, "r_c");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("FORK_INVALID");
    expect(outcome.message).toContain("crashed");
  });

  it("1.5 v2 整轮边界不在可读直接父自有记录、隔代缺失 → FORK_INVALID 优先（对应「fork 定位非法不降级」）", () => {
    freshTraces();
    writeRun("r_c", [
      v2ChildMeta("r_c", "r_b", "s_02", "s_ghost"),
      stepLine("c_s1", { snapshot: createWorkspaceSnapshot([]) }),
      STOP,
    ]);
    writeRun("r_b", [
      metaLine("r_b", { parent: "r_no", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      stepLine("s_02", { parent: "s_01", n: 2 }),
      STOP,
    ]);
    const outcome = readRunLineage(traces, "r_c");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("FORK_INVALID");
    expect(outcome.message).toContain("s_ghost");
  });

  it("1.5 对照：v1 at_span 依赖缺失祖先才能核实 → 记缺失而不是断言非法（未核实不谎称非法）", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: v1Fork("s_ghost") }),
      stepLine("c_s1"),
      STOP,
    ]);
    writeRun("r_b", [
      metaLine("r_b", { parent: "r_no", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    const outcome = readRunLineage(traces, "r_c");
    // at_span 只能对「已拼接前缀」核实，walk 阶段不可证明 ⇒ 走结构化缺失
    expect(outcome).toMatchObject({ ok: true, complete: false, missingRunId: "r_no" });
  });

  it("1.1 合法零 span 当前记录 + 祖先缺失 → 结构化缺失，空数组不当损坏（对照「合法零 span 记录可部分读取」分类半边）", () => {
    freshTraces();
    writeRun("r_c", [metaLine("r_c", { parent: "r_no", fork: v1Fork("s_01") }), STOP]);
    const outcome = readRunLineage(traces, "r_c");
    expect(outcome).toMatchObject({ ok: true, complete: false, missingRunId: "r_no" });
    if (!outcome.ok || outcome.complete) return;
    expect(outcome.records[0]?.spans).toEqual([]);
  });
});

describe("U6 §1 RunRepository 接线：信封保持 GET_RUN_FAILED，行为按 §1 边界", () => {
  it("完整链详情与既有语义一致（回归：resolveBranch 经单次上下文的缓存 loader）", () => {
    freshTraces();
    copyFileSync(join(FIXTURES, "normal.jsonl"), join(traces, "r_01.jsonl"));
    copyFileSync(join(FIXTURES, "branch.jsonl"), join(traces, "r_02.jsonl"));
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_02");
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
    // 逐字节同文件再读：单次上下文不改变成功形态的输出
    const again = repo.getRun("r_02");
    expect(again.spans).toEqual(detail.spans);
  });

  it("非法 run id → 抛受控原因（getRun 与 loadRunRecord 两处都在 fs 之前拒绝）", () => {
    freshTraces();
    const repo = new RunRepository(traces);
    expect(() => repo.getRun("../../../etc/passwd")).toThrow(/run 标识非法/);
    expect(() => repo.loadRunRecord("a\\b")).toThrow(/run 标识非法/);
    expect(readdirSync(traces)).toEqual([]);
  });

  it("普通 result 缺祖先 → 结构化 ownOnly（U6 §3.2 起生效；missingRunId 受校验）", () => {
    freshTraces();
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_no", fork: v1Fork("s_01") }),
      stepLine("s_01"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_c");
    expect(detail.completeness).toBe("ownOnly");
    expect(detail.spanScope).toBe("own");
    expect(detail.lineage).toEqual({
      status: "incomplete",
      reason: "ANCESTOR_NOT_FOUND",
      missingRunId: "r_no",
    });
    expect(detail.spans.map((s) => s.id)).toEqual(["s_01"]);
  });

  it("prompt fork 缺祖先 → 维持既有「链到此为止」行为，不抛（§3.4 起改 ownOnly）", () => {
    freshTraces();
    writeRun("r_p", [
      metaLine("r_p", {
        parent: "r_no",
        fork: { at_span: "s_01", edit: { field: "user_message", value: "改写后的问题" } },
      }),
      stepLine("p_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    const detail = repo.getRun("r_p");
    expect(detail.chain).toHaveLength(1);
    expect(detail.spans.map((s) => s.id)).toEqual(["p_s1"]);
  });

  it("完整链但 fork 定位非法（at_span 不在父轨迹）→ resolveBranch 权威拒绝，原因受控", () => {
    freshTraces();
    writeRun("r_a", [metaLine("r_a", { parent: null }), stepLine("s_01"), STOP]);
    writeRun("r_b", [
      metaLine("r_b", { parent: "r_a", fork: v1Fork("s_01") }),
      stepLine("s_02"),
      STOP,
    ]);
    writeRun("r_c", [
      metaLine("r_c", { parent: "r_b", fork: v1Fork("s_ghost") }),
      stepLine("c_s1"),
      STOP,
    ]);
    const repo = new RunRepository(traces);
    try {
      repo.getRun("r_c");
      expect.unreachable("at_span 不在前缀轨迹必须失败");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("分支轨迹解析失败");
      expect(message).toContain("s_ghost");
      expectControlled(message);
    }
  });
});
