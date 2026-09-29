import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execCreateRun, execForkRun } from "../src/main/exec-endpoints";
import {
  RUN_SOURCE_REJECTION,
  RunSourceRejection,
  checkRunSource,
} from "../src/main/run-source-gate";
import {
  type ExecHarness,
  TRUSTED_SENDER,
  envelope,
  opId,
  openExecHarness,
} from "./helpers/exec-endpoints-harness";

/**
 * U6（add-partial-run-reading）tasks §5.1–5.3：共享 main 来源门禁与 result 端点接线。
 *
 * 对应 delta 场景：
 *   - 「详情加载失败在执行入口即拒绝」：当前 run 缺失/祖先损坏等 ⇒ RUN_DETAIL_UNREADABLE；
 *     ownOnly ⇒ RUN_LINEAGE_INCOMPLETE；均在 U4 接受（settled 回执在场）之后、
 *     授权消费与业务副作用之前拒绝，runIds 为空、finally 只释放本槽（registry 语义）；
 *   - 「ownOnly result 不可重跑」：零模型调用、零新 trace；
 *   - 「ownOnly 隔离 result 不消费副本授权」：合法 allowFileWrites 请求同样被来源门禁
 *     拒绝（不做副本世界/trace 创建；result 请求本就没有 sourceToken 字段）；
 *   - 「预检后父链变化仍由 main 拒绝」：服务端每次重读，不信任客户端详情。
 *
 * 正对照（6.3 的可达性要求在此先立一例）：父链完整时**同形请求成功**——
 * 拒绝确实来自来源门禁，不是请求形状或领域门禁的假阳性。
 *
 * 夹具沿用 `helpers/exec-endpoints-harness`（真 registry/仓库/settings，LLM 可控）；
 * ownOnly 标本用两种方式造：① 真实 fork 出子 run 后删除其父文件（模拟父文件消失）；
 * ② 手写 JSONL（祖先缺失的受控形状，与 u6-detail-project 同法）。
 */

// ---------------------------------------------------------------------------
// A. checkRunSource 纯单元（tmp traces + 手写夹具）
// ---------------------------------------------------------------------------

const T0 = "2026-01-15T10:00:00.000Z";

function metaLine(id: string, parent: string | null, fork: unknown = null): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task: "U6 来源门禁夹具",
    model: "controlled-model",
    created_at: T0,
    parent,
    fork,
  });
}

function stepLine(id: string): string {
  return JSON.stringify({ type: "span", id, parent: null, kind: "agent.step", n: 1 });
}

const STOP = JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" });

describe("5.1 checkRunSource：来源判定的纯单元", () => {
  const roots: string[] = [];
  let traces = "";
  const fresh = (): void => {
    const root = mkdtempSync(join(tmpdir(), "u6-source-gate-"));
    roots.push(root);
    traces = join(root, "traces");
    mkdirSync(traces, { recursive: true });
  };
  const write = (id: string, lines: string[]): void => {
    writeFileSync(join(traces, `${id}.jsonl`), `${lines.join("\n")}\n`);
  };

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("完整父链（根 run）⇒ 放行（不抛）", () => {
    fresh();
    write("r_root", [metaLine("r_root", null), stepLine("s1"), STOP]);
    expect(() => checkRunSource(traces, "r_root")).not.toThrow();
  });

  it("祖先缺失 ⇒ RUN_LINEAGE_INCOMPLETE 并携带受校验的 missingRunId", () => {
    fresh();
    write("r_child", [
      metaLine("r_child", "r_gone", { at_span: "s1", edit: { field: "result", value: "x" } }),
      stepLine("c_s1"),
      STOP,
    ]);
    try {
      checkRunSource(traces, "r_child");
      throw new Error("unreachable：应当拒绝");
    } catch (e) {
      expect(e).toBeInstanceOf(RunSourceRejection);
      const rejection = e as RunSourceRejection;
      expect(rejection.code).toBe(RUN_SOURCE_REJECTION.incomplete);
      expect(rejection.missingRunId).toBe("r_gone");
      // 受控文案：不含物理路径/盘符
      expect(rejection.message).not.toMatch(/:\\|[Tt]races/);
    }
  });

  it("当前文件损坏 ⇒ RUN_DETAIL_UNREADABLE（缺失不掩盖损坏，missingRunId 为 null）", () => {
    fresh();
    write("r_broken", ["{ 这不是合法 JSONL"]);
    try {
      checkRunSource(traces, "r_broken");
      throw new Error("unreachable：应当拒绝");
    } catch (e) {
      const rejection = e as RunSourceRejection;
      expect(rejection.code).toBe(RUN_SOURCE_REJECTION.unreadable);
      expect(rejection.missingRunId).toBeNull();
    }
  });

  it("当前 run 缺失 / 成环 ⇒ RUN_DETAIL_UNREADABLE（不把读取失败当缺失放行）", () => {
    fresh();
    expect(() => checkRunSource(traces, "r_absent")).toThrowError(RunSourceRejection);
    try {
      checkRunSource(traces, "r_absent");
    } catch (e) {
      expect((e as RunSourceRejection).code).toBe(RUN_SOURCE_REJECTION.unreadable);
    }
    write("r_a", [
      metaLine("r_a", "r_b", { at_span: "s1", edit: { field: "result", value: "x" } }),
      stepLine("a_s1"),
      STOP,
    ]);
    write("r_b", [
      metaLine("r_b", "r_a", { at_span: "a_s1", edit: { field: "result", value: "y" } }),
      stepLine("b_s1"),
      STOP,
    ]);
    try {
      checkRunSource(traces, "r_a");
      throw new Error("unreachable：成环应当拒绝");
    } catch (e) {
      expect((e as RunSourceRejection).code).toBe(RUN_SOURCE_REJECTION.unreadable);
    }
  });
});

// ---------------------------------------------------------------------------
// B. result 端点接线（真实 registry/仓库 + 可控 LLM）
// ---------------------------------------------------------------------------

/** 隔离父本剧本：读一次世界内文件再收尾（给出可分叉的 tool.invoke 叶子） */
const ISOLATED_PARENT: Parameters<ExecHarness["setScript"]>[number] = [
  { toolCalls: [{ id: "c1", name: "read_file", args: JSON.stringify({ path: "a.txt" }) }] },
  { content: "隔离创建完成。" },
];
/** fork 出的子 run 剧本：同样留一个 tool.invoke 叶子供下一级分叉 */
const CHILD_SCRIPT: Parameters<ExecHarness["setScript"]>[number] = [
  { toolCalls: [{ id: "c1", name: "read_file", args: JSON.stringify({ path: "README.md" }) }] },
  { content: "子任务完成。" },
];

function toolSpanIdOf(harness: ExecHarness, runId: string): string {
  const record = readRun(join(harness.traces, `${runId}.jsonl`));
  const toolSpan = record.spans.find((span) => span.kind === "tool.invoke");
  if (toolSpan?.kind !== "tool.invoke") throw new Error(`run ${runId} 没有 tool.invoke span`);
  return toolSpan.id;
}

describe("5.2 普通 result 端点：ownOnly / 不可读在执行入口即拒绝", () => {
  let h: ExecHarness;
  beforeEach(() => {
    h = openExecHarness();
  });

  it("正对照：父链完整时同形请求成功（拒绝确实来自来源门禁）", async () => {
    h.configure();
    h.setScript([{ content: "父 run 一步完成。" }]);
    const parent = await h.makeParent();
    h.setScript(CHILD_SCRIPT);
    const child = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(1, {
        parentRunId: parent.parentId,
        atSpanId: parent.atSpanId,
        edit: { field: "result", value: "编辑后的结果" },
      }),
    );
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    // 子 run 自己也有 tool.invoke ⇒ 可以作为下一级父本
    expect(toolSpanIdOf(h, child.data.id)).toBeTruthy();
  });

  it("父文件消失 ⇒ RUN_LINEAGE_INCOMPLETE：settled/rejected 回执 + runIds 空 + 零模型调用 + 零新 trace", async () => {
    h.configure();
    h.setScript([{ content: "父 run 一步完成。" }]);
    const parent = await h.makeParent();
    h.setScript(CHILD_SCRIPT);
    const child = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(1, {
        parentRunId: parent.parentId,
        atSpanId: parent.atSpanId,
        edit: { field: "result", value: "编辑后的结果" },
      }),
    );
    if (!child.ok) throw new Error("正对照失败：父链完整时应能 fork");
    const childId = child.data.id;
    // 父文件消失 ⇒ 子 run 变 ownOnly（U6 §3 的读取语义）
    const { rmSync } = await import("node:fs");
    rmSync(join(h.traces, `${parent.parentId}.jsonl`));

    const filesBefore = h.traceFiles();
    const callsBefore = h.llmCalls();
    const response = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(2, {
        parentRunId: childId,
        atSpanId: toolSpanIdOf(h, childId),
        edit: { field: "result", value: "在 ownOnly 父本上的编辑" },
      }),
    );

    expect(response.ok).toBe(false);
    if (response.ok) return;
    // U4 接受后的业务拒绝：带 settled 回执 + 稳定码 + 匹配回执
    expect(response.operation.state).toBe("settled");
    expect(response.error.code).toBe(RUN_SOURCE_REJECTION.incomplete);
    expect(response.error.message).toContain(parent.parentId);
    expect(response.error.message).not.toMatch(/:\\|[Tt]races/);
    const record = h.registry.recordOf(opId(2));
    expect(record?.state).toBe("settled");
    expect(record?.requestOutcome).toBe("rejected");
    expect(record?.errorCode).toBe(RUN_SOURCE_REJECTION.incomplete);
    expect(record?.runIds).toEqual([]);
    // 零业务副作用：零模型调用、零新 trace（槽由 registry finally 释放，登记保留）
    expect(h.llmCalls()).toBe(callsBefore);
    expect(h.traceFiles()).toEqual(filesBefore);
  });

  it("父文件损坏 ⇒ RUN_DETAIL_UNREADABLE（严格失败不降级）", async () => {
    h.configure();
    h.setScript([{ content: "父 run 一步完成。" }]);
    const parent = await h.makeParent();
    h.setScript(CHILD_SCRIPT);
    const child = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(1, {
        parentRunId: parent.parentId,
        atSpanId: parent.atSpanId,
        edit: { field: "result", value: "编辑后的结果" },
      }),
    );
    if (!child.ok) throw new Error("正对照失败");
    const childId = child.data.id;
    // 祖先损坏（非缺失）⇒ 读取失败 ⇒ RUN_DETAIL_UNREADABLE
    writeFileSync(join(h.traces, `${parent.parentId}.jsonl`), "{ 损坏的 JSONL\n");
    const callsBefore = h.llmCalls();

    const response = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(2, {
        parentRunId: childId,
        atSpanId: toolSpanIdOf(h, childId),
        edit: { field: "result", value: "损坏父本上的编辑" },
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe(RUN_SOURCE_REJECTION.unreadable);
    expect(h.registry.recordOf(opId(2))?.runIds).toEqual([]);
    expect(h.llmCalls()).toBe(callsBefore);
  });
});

describe("5.3 隔离 result 端点：副本授权消费之前拒绝", () => {
  let h: ExecHarness;
  beforeEach(() => {
    h = openExecHarness();
  });

  it("ownOnly 隔离父本 + 合法 allowFileWrites 请求 ⇒ RUN_LINEAGE_INCOMPLETE，无副本世界/trace 创建", async () => {
    h.configure();
    // 真实隔离根 run R（源目录只读 + 副本世界落盘）
    h.setScript(ISOLATED_PARENT);
    const sourceToken = h.issueSource();
    const created = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(1, {
        systemPrompt: "你是文件助手。",
        userMessage: "读一下 a.txt",
        workspace: { mode: "isolated_files", sourceToken, allowFileWrites: true },
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const rootId = created.data.id;

    // 正对照：从 R 隔离续跑出 C（此时 R 在场，父链完整）
    h.setScript(CHILD_SCRIPT);
    const child = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(2, {
        parentRunId: rootId,
        atSpanId: toolSpanIdOf(h, rootId),
        edit: { field: "result", value: "隔离续跑的编辑" },
        execution: { mode: "isolated_files", allowFileWrites: true },
      }),
    );
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    const childId = child.data.id;

    // 父文件（R）消失 ⇒ C 为 ownOnly；再次合法隔离续跑必须被来源门禁拒绝
    const { rmSync } = await import("node:fs");
    rmSync(join(h.traces, `${rootId}.jsonl`));
    const filesBefore = h.traceFiles();
    const callsBefore = h.llmCalls();

    const response = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(3, {
        parentRunId: childId,
        atSpanId: toolSpanIdOf(h, childId),
        edit: { field: "result", value: "ownOnly 隔离父本上的编辑" },
        execution: { mode: "isolated_files", allowFileWrites: true },
      }),
    );

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.operation.state).toBe("settled");
    expect(response.error.code).toBe(RUN_SOURCE_REJECTION.incomplete);
    expect(response.error.message).toContain(rootId);
    const record = h.registry.recordOf(opId(3));
    expect(record?.requestOutcome).toBe("rejected");
    expect(record?.runIds).toEqual([]);
    // 零业务副作用：零模型调用、零新 trace（无副本世界里的新 run 落盘）
    expect(h.llmCalls()).toBe(callsBefore);
    expect(h.traceFiles()).toEqual(filesBefore);
    // result 请求本就没有 sourceToken 字段（schema 层事实）；令牌消费计数不变
    expect(h.tokenConsumes()).toBe(1);
  });
});
