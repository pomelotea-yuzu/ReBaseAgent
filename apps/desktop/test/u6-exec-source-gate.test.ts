import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  execCreateRun,
  execForkRun,
  execModelAb,
  execModelAbPlan,
  execPromptFork,
  execProxyFork,
} from "../src/main/exec-endpoints";
import {
  RUN_SOURCE_REJECTION,
  RunSourceRejection,
  checkRunSource,
} from "../src/main/run-source-gate";
import { OPERATION_ERROR } from "../src/shared/operations";
import {
  type ExecHarness,
  ONE_TURN,
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

// ---------------------------------------------------------------------------
// C. 5.4–5.6：prompt / proxy / A-B 整批三个执行入口接同一来源门禁
// ---------------------------------------------------------------------------

describe("5.4 prompt 端点：来源拒绝 + 原领域门禁保留", () => {
  let h: ExecHarness;
  beforeEach(() => {
    h = openExecHarness();
  });

  it("ownOnly prompt 父本 ⇒ RUN_LINEAGE_INCOMPLETE，零模型调用", async () => {
    h.configure();
    h.setScript([{ content: "父 run 一步完成。" }]);
    const parent = await h.makeParent();
    // 先 fork 出 prompt 子 run（正对照：父链完整时成功）
    h.setScript([{ content: "prompt 子 run 完成。" }]);
    const child = await execPromptFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(1, {
        parentRunId: parent.parentId,
        edit: { field: "system_prompt", value: "改过的 system prompt" },
      }),
    );
    expect(child.ok).toBe(true);
    if (!child.ok) return;

    rmSync(join(h.traces, `${parent.parentId}.jsonl`));
    const callsBefore = h.llmCalls();
    const response = await execPromptFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(2, {
        parentRunId: child.data.id,
        edit: { field: "user_message", value: "在 ownOnly 父本上的编辑" },
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.operation.state).toBe("settled");
    expect(response.error.code).toBe(RUN_SOURCE_REJECTION.incomplete);
    expect(h.registry.recordOf(opId(2))?.runIds).toEqual([]);
    expect(h.llmCalls()).toBe(callsBefore);
  });

  it("来源完整时原领域门禁照常拒绝（PROMPT_FORK_NO_SYSTEM 不被绕过）", async () => {
    h.configure();
    const noSystemParent = await h.makeNoSystemParent();
    const response = await execPromptFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(3, {
        parentRunId: noSystemParent,
        edit: { field: "system_prompt", value: "补一个 system prompt" },
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    // 来源门禁放行（父链完整）⇒ 领域门禁的稳定码原样保留
    expect(response.error.code).toBe("PROMPT_FORK_NO_SYSTEM");
  });
});

describe("5.5 proxy 端点：发请求/录制之前拒绝", () => {
  let h: ExecHarness;
  beforeEach(() => {
    h = openExecHarness();
  });

  it("ownOnly 父本 ⇒ RUN_LINEAGE_INCOMPLETE，代理 fork 零调用", async () => {
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
    // 正对照：完整父本 + 代理桩 ⇒ 成功（证明桩与门禁顺序）
    h.setProxyFork(async () => ({ id: "proxy_fork_child" }));
    const okCase = await execProxyFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(2, {
        parentRunId: child.data.id,
        atSpanId: toolSpanIdOf(h, child.data.id),
        messages: [{ role: "user", content: "编辑后的 messages" }],
      }),
    );
    expect(okCase.ok).toBe(true);

    rmSync(join(h.traces, `${parent.parentId}.jsonl`));
    const proxyBefore = h.proxyCalls();
    const response = await execProxyFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(3, {
        parentRunId: child.data.id,
        atSpanId: toolSpanIdOf(h, child.data.id),
        messages: [{ role: "user", content: "ownOnly 父本上的编辑" }],
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe(RUN_SOURCE_REJECTION.incomplete);
    expect(h.registry.recordOf(opId(3))?.runIds).toEqual([]);
    // 代理 fork 一次都没发生（不发请求、不录制）
    expect(h.proxyCalls()).toBe(proxyBefore);
  });
});

describe("5.6 A/B 整批执行：第一臂之前拒绝，无运行身份", () => {
  let h: ExecHarness;
  beforeEach(() => {
    h = openExecHarness();
  });

  it("ownOnly 父本 ⇒ RUN_LINEAGE_INCOMPLETE：零臂身份、零模型调用", async () => {
    h.configure();
    const pureParent = await h.makePureParent();
    // 先整批跑一次造出 model_params 臂（正对照：完整父本 ⇒ 批次成功）
    h.setScript([{ content: "臂完成。" }]);
    const batch = await execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(1, {
        parentRunId: pureParent,
        arms: [{ model: "m-a" }, { model: "m-b" }],
        dryRun: false,
      }),
    );
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    const armId = batch.data.ids[0];
    expect(armId).toBeTruthy();

    // 父文件消失 ⇒ 臂 run 变 ownOnly；以它为父本的整批必须在第一臂前拒绝
    rmSync(join(h.traces, `${pureParent}.jsonl`));
    const callsBefore = h.llmCalls();
    const response = await execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(2, {
        parentRunId: armId ?? "unreachable",
        arms: [{ model: "m-c" }, { model: "m-d" }],
        dryRun: false,
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.operation.state).toBe("settled");
    expect(response.error.code).toBe(RUN_SOURCE_REJECTION.incomplete);
    const record = h.registry.recordOf(opId(2));
    expect(record?.requestOutcome).toBe("rejected");
    expect(record?.runIds).toEqual([]);
    expect(record?.arms).toEqual([]);
    expect(record?.experimentId).toBeNull();
    expect(h.llmCalls()).toBe(callsBefore);
  });
});

describe("5.7 A/B dry-run 只读端点：同源拒绝、不占槽不登记、完整父本预览仍可用", () => {
  let h: ExecHarness;
  beforeEach(() => {
    h = openExecHarness();
  });

  it("正对照：完整父本的 dry-run 计划可用且不产生登记、零模型调用", async () => {
    h.configure();
    const pureParent = await h.makePureParent();
    const callsBefore = h.llmCalls();
    const plan = await execModelAbPlan(h.deps, TRUSTED_SENDER, {
      parentRunId: pureParent,
      arms: [{ model: "m-a" }, { model: "m-b" }],
      dryRun: true,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) return;
    expect(plan.data.plan).toHaveLength(2);
    expect(h.llmCalls()).toBe(callsBefore);
    expect(h.registry.snapshot().operations).toHaveLength(0);
  });

  it("ownOnly 父本 ⇒ RUN_LINEAGE_INCOMPLETE：无计划、零网络、登记仍为空", async () => {
    h.configure();
    const pureParent = await h.makePureParent();
    h.setScript([{ content: "臂完成。" }, { content: "臂完成。" }]);
    const batch = await execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(1, {
        parentRunId: pureParent,
        arms: [{ model: "m-a" }, { model: "m-b" }],
        dryRun: false,
      }),
    );
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    const armId = batch.data.ids[0];
    expect(armId).toBeTruthy();

    rmSync(join(h.traces, `${pureParent}.jsonl`));
    const callsBefore = h.llmCalls();
    const plan = await execModelAbPlan(h.deps, TRUSTED_SENDER, {
      parentRunId: armId ?? "unreachable",
      arms: [{ model: "m-c" }, { model: "m-d" }],
      dryRun: true,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe(RUN_SOURCE_REJECTION.incomplete);
    expect(h.llmCalls()).toBe(callsBefore);
    // 只读端点不登记、不占槽：registry 里没有这条请求的任何操作
    expect(h.registry.snapshot().operations).toHaveLength(1); // 只有第 1 步真实批次
  });
});

describe("5.9–5.11 服务端重读 / 同 ID 不复活 / 无父本路径回归", () => {
  let h: ExecHarness;
  beforeEach(() => {
    h = openExecHarness();
  });

  /** 真实造出 ownOnly 父本：父链完整时 fork 出子 run，再删父文件；返回父文件原文以便恢复 */
  async function makeOwnOnlyChild(): Promise<{
    childId: string;
    atSpanId: string;
    parentFile: string;
    parentContent: string;
  }> {
    h.setScript([{ content: "父 run 一步完成。" }]);
    const parent = await h.makeParent();
    h.setScript(CHILD_SCRIPT);
    const child = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(90, {
        parentRunId: parent.parentId,
        atSpanId: parent.atSpanId,
        edit: { field: "result", value: "编辑后的结果" },
      }),
    );
    if (!child.ok) throw new Error("正对照失败");
    const parentFile = join(h.traces, `${parent.parentId}.jsonl`);
    const parentContent = readFileSync(parentFile, "utf8");
    rmSync(parentFile);
    return {
      childId: child.data.id,
      atSpanId: toolSpanIdOf(h, child.data.id),
      parentFile,
      parentContent,
    };
  }

  it("5.9 直调端点（绕过 UI）：main 现读磁盘——预检通过后父文件消失仍拒绝", async () => {
    h.configure();
    h.setScript([{ content: "臂完成。" }, { content: "臂完成。" }]);
    const pureParent = await h.makePureParent();
    // 预检（只读端点）此刻通过——客户端视角"一切就绪"
    const plan = await execModelAbPlan(h.deps, TRUSTED_SENDER, {
      parentRunId: pureParent,
      arms: [{ model: "m-a" }, { model: "m-b" }],
      dryRun: true,
    });
    expect(plan.ok).toBe(true);

    // 预检之后、提交之前父文件消失：main 提交时**服务端重读**仍拒绝。
    // 父文件即当前 run ⇒ 严格失败形态（RUN_DETAIL_UNREADABLE，design D2「缺当前文件直接失败」）
    rmSync(join(h.traces, `${pureParent}.jsonl`));
    const response = await execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(91, {
        parentRunId: pureParent,
        arms: [{ model: "m-a" }, { model: "m-b" }],
        dryRun: false,
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe(RUN_SOURCE_REJECTION.unreadable);
    expect(h.llmCalls()).toBe(0);
  });

  it("5.10 来源拒绝后恢复父文件：同 ID 只命中判重不复活；新 ID 重检后可执行", async () => {
    h.configure();
    const { childId, atSpanId, parentFile, parentContent } = await makeOwnOnlyChild();

    // 第一次提交：来源拒绝（settled/rejected）
    const first = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(92, {
        parentRunId: childId,
        atSpanId,
        edit: { field: "result", value: "恢复前的编辑" },
      }),
    );
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe(RUN_SOURCE_REJECTION.incomplete);

    // 父文件恢复 ⇒ 同 ID 再提交：先命中 U4 判重（duplicate），**不重读父本、不执行**
    writeFileSync(parentFile, parentContent);
    const filesBefore = h.traceFiles();
    const callsBefore = h.llmCalls();
    const sameId = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(92, {
        parentRunId: childId,
        atSpanId,
        edit: { field: "result", value: "恢复前的编辑" },
      }),
    );
    expect(sameId.ok).toBe(false);
    if (sameId.ok) return;
    expect(sameId.error.code).toBe(OPERATION_ERROR.duplicated);
    expect(h.llmCalls()).toBe(callsBefore);
    expect(h.traceFiles()).toEqual(filesBefore);

    // 新 ID 重新提交：通过重检（父链已恢复）⇒ 正常执行
    const renewed = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(93, {
        parentRunId: childId,
        atSpanId,
        edit: { field: "result", value: "恢复后的新提交" },
      }),
    );
    expect(renewed.ok).toBe(true);
    expect(h.llmCalls()).toBeGreaterThan(callsBefore);
  });

  it("5.11 无父本的普通 create 不受已存在的 ownOnly run 阻断", async () => {
    h.configure();
    await makeOwnOnlyChild(); // 磁盘上存在 ownOnly run
    h.setScript(ONE_TURN);
    const created = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(94, {
        systemPrompt: "你是简洁的问答助手。",
        userMessage: "无父本创建照常工作。",
      }),
    );
    expect(created.ok).toBe(true);
    if (created.ok) return;
  });
});
