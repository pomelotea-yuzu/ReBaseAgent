import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, RunConfig } from "@rebaseagent/agent-loop";
import { readRun } from "@rebaseagent/trace-sdk";
import type { AgentStepSpan, LlmCallSpan, RunRecord, ToolInvokeSpan } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_TRACES_DIR_NAME, createIsolatedRun, replayIsolatedRun } from "../src/index";
import { ScriptedLlm, asLoopLlm, makeConfig, readCall, writeCall } from "./isolated-helpers";
import type { ScriptedTurn } from "./isolated-helpers";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * 4.3：隔离 result 分叉（`replayIsolatedRun`）。
 *
 * 验证点（tasks.md 4.3）：`replay/恢复历史中间文件而非最终文件`、`同轮多工具及最终轮回退路径`，
 * **spy 断言前缀工具 / LLM 均零调用**。
 *
 * ## 父本仍是真跑出来的
 *
 * 与 4.1/4.2 同一套路：父 run 由 `createIsolatedRun` 真跑（真导入、真受控工具、真落盘），
 * 子 run 也真跑一遍 loop。唯一被替换的是 LLM 网络调用——而它正好是"零调用"断言的探针：
 * 桩上的 `requests` 数组就是**已发出的请求清单**，前缀若被重放，它一定会多出条目。
 *
 * ## "前缀零工具调用"的三重证据
 *
 * 1. 子 trace 里只有子自己新增的工具调用（没有父那几轮的工具）；
 * 2. 子读到的是**那一轮**的文件状态（`middle`），而不是后续轮的 `after` 或源目录现值；
 * 3. 子 trace 的首个 span 序号**紧接父链最大值**——若前缀被重放，序号不会连续。
 */

/** span id → 序号（`s_NN`） */
function seqOf(id: string): number {
  const m = /^s_(\d+)$/.exec(id);
  return m === null ? -1 : Number(m[1]);
}

function maxSeq(record: RunRecord): number {
  return record.spans.reduce((max, span) => Math.max(max, seqOf(span.id)), 0);
}

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

interface ParentRun {
  readonly dataDir: string;
  readonly source: string;
  readonly parentId: string;
  readonly traceFile: string;
  readonly record: RunRecord;
  /** 第 1 轮的 step 与其工具（分叉点默认用第一个工具） */
  readonly step1: AgentStepSpan;
  readonly tools1: readonly ToolInvokeSpan[];
}

/** 真跑一个隔离根 run 作为分叉父本 */
async function makeParent(options: {
  readonly script: readonly ScriptedTurn[];
  readonly tree?: Record<string, string>;
  readonly maxIterations?: number;
}): Promise<ParentRun> {
  const source = makeTempDir("isolated-replay-src-");
  writeTree(source, options.tree ?? { "seed.txt": "seed" });
  const dataDir = join(makeTempDir("isolated-replay-data-"), "data");
  const config: RunConfig = {
    ...makeConfig(),
    maxIterations: options.maxIterations ?? 10,
  };

  const created = await createIsolatedRun({
    dataDir,
    source,
    config,
    userMessage: "跑几轮",
    authority: { allowFileWrites: true },
    llm: asLoopLlm(new ScriptedLlm([...options.script])),
  });
  if (!created.ok) {
    throw new Error(`父本创建失败：${created.failure.code} ${created.failure.reason}`);
  }

  const traceFile = join(dataDir, WORKSPACE_TRACES_DIR_NAME, `${created.id}.jsonl`);
  const record = readRun(traceFile);
  const step1 = record.spans.find(
    (span): span is AgentStepSpan => span.kind === "agent.step" && span.n === 1,
  );
  if (step1 === undefined) {
    throw new Error("父本 fixture 结构不符预期：缺少第 1 轮 step");
  }
  const tools1 = record.spans.filter(
    (span): span is ToolInvokeSpan => span.kind === "tool.invoke" && span.parent === step1.id,
  );
  if (tools1.length === 0) {
    throw new Error("父本 fixture 结构不符预期：第 1 轮没有工具调用");
  }
  return { dataDir, source, parentId: created.id, traceFile, record, step1, tools1 };
}

function childTraceFile(dataDir: string, childId: string): string {
  return join(dataDir, WORKSPACE_TRACES_DIR_NAME, `${childId}.jsonl`);
}

function llmCalls(record: RunRecord): LlmCallSpan[] {
  return record.spans.filter((span): span is LlmCallSpan => span.kind === "llm.call");
}

function toolCalls(record: RunRecord): ToolInvokeSpan[] {
  return record.spans.filter((span): span is ToolInvokeSpan => span.kind === "tool.invoke");
}

/** 从子 run 的首次 llm.call 录制请求里取一条 tool 消息（按 call id） */
function toolMessageOf(record: RunRecord, callId: string): Message | undefined {
  const first = llmCalls(record)[0];
  return first?.request.messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
}

afterEach(cleanupTempDirs);

describe("replayIsolatedRun：恢复历史中间文件而非最终文件", () => {
  it("子从那一轮的检查点继续：读到的 a.txt 是 middle 而不是 after", async () => {
    const parent = await makeParent({
      script: [
        { toolCalls: [writeCall("c1", "a.txt", "middle")] },
        { toolCalls: [writeCall("c2", "a.txt", "after")] },
        { content: "done" },
      ],
    });
    const parentHashBefore = sha256Of(parent.traceFile);
    const childLlm = new ScriptedLlm([
      { toolCalls: [readCall("r1", "a.txt")] },
      { content: "done" },
    ]);

    const result = await replayIsolatedRun({
      dataDir: parent.dataDir,
      parentId: parent.parentId,
      atSpanId: parent.tools1[0]?.id ?? "",
      edit: { field: "result", value: "编辑后的工具结果" },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(childLlm),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const child = readRun(childTraceFile(parent.dataDir, result.id));
    const meta = child.meta;

    // ── 分支元数据：parent / fork（含整轮边界）/ checkpoint origin ────────────────────
    expect(meta.parent).toBe(parent.parentId);
    expect(meta.fork?.at_span).toBe(parent.tools1[0]?.id);
    expect(meta.fork?.resume_after_step).toBe(parent.step1.id);
    expect(meta.workspace?.origin).toEqual({
      kind: "checkpoint",
      run_id: parent.parentId,
      step_span: parent.step1.id,
    });
    expect(meta.workspace?.world_id).toBe(result.id);
    expect(meta.format_version).toBe(2);
    expect(meta.config_hash).toBe(parent.record.meta.config_hash);

    // ── 关键断言：恢复的是**那一轮**的中间状态 ───────────────────────────────────────
    const childTools = toolCalls(child);
    expect(childTools).toHaveLength(1); // 只有子自己新增的这一次调用
    expect(childTools[0]?.tool).toBe("read_file");
    expect(String(childTools[0]?.result)).toBe("middle");
    expect(String(childTools[0]?.result)).not.toBe("after");

    // ── 前缀零 LLM：桩只被调 2 次（子自己的两轮），且首次请求就是父轮 2 的录制 ──────────
    expect(childLlm.requests).toHaveLength(2);
    const parentSecondRequest = llmCalls(parent.record)[1];
    expect(childLlm.requests[0]).toHaveLength(parentSecondRequest?.request.messages.length ?? -1);
    // 被编辑的那条工具消息已替换，同轮/后轮其余消息原样
    expect(toolMessageOf(child, "c1")?.content).toBe("编辑后的工具结果");

    // ── 前缀零工具调用 + 前缀零重放：span 序号紧接父链最大值 ─────────────────────────
    expect(child.spans[0]?.id).toBe(`s_${String(maxSeq(parent.record) + 1).padStart(2, "0")}`);
    // 子自己没有写文件的调用（写入只应由父的历史提供）
    expect(childTools.some((tool) => tool.tool === "write_file")).toBe(false);

    // ── 源目录与父 trace 都不受影响 ────────────────────────────────────────────────
    expect(readFileSync(join(parent.source, "seed.txt"), "utf8")).toBe("seed");
    expect(existsSync(join(parent.source, "a.txt"))).toBe(false);
    expect(sha256Of(parent.traceFile)).toBe(parentHashBefore);
  });
});

describe("replayIsolatedRun：同轮多工具与最终轮回退路径", () => {
  it("编辑同轮 T1：消息含两条工具结果（仅 T1 替换），文件含 T1/T2 原效果，不重做", async () => {
    // maxIterations=1 ⇒ 第 1 轮两个工具执行完后 loop 停止 ⇒ **该轮之后没有录制 LLM 调用**
    const parent = await makeParent({
      script: [{ toolCalls: [writeCall("c1", "a.txt", "X"), writeCall("c2", "b.txt", "Y")] }],
      maxIterations: 1,
    });
    expect(llmCalls(parent.record)).toHaveLength(1);
    const [tool1, tool2] = parent.tools1;
    expect(tool2).toBeDefined();
    const parentHashBefore = sha256Of(parent.traceFile);

    const childLlm = new ScriptedLlm([
      { toolCalls: [readCall("r1", "a.txt"), readCall("r2", "b.txt")] },
      { content: "done" },
    ]);

    const result = await replayIsolatedRun({
      dataDir: parent.dataDir,
      parentId: parent.parentId,
      atSpanId: tool1?.id ?? "",
      edit: { field: "result", value: "T1 的新结果" },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(childLlm),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const child = readRun(childTraceFile(parent.dataDir, result.id));

    // ── 消息：该轮基础 + assistant + 两条 tool 结果，仅 T1 被替换 ─────────────────────
    const firstRequest = childLlm.requests[0] ?? [];
    const parentStepRequest = llmCalls(parent.record)[0]?.request.messages.length ?? -1;
    expect(firstRequest).toHaveLength(parentStepRequest + 3); // +1 assistant、+2 tool
    expect(toolMessageOf(child, "c1")?.content).toBe("T1 的新结果");
    expect(toolMessageOf(child, "c2")?.content).toBe(String(tool2?.result));
    // 该轮的工具调用 id 与原顺序都保留（同轮兄弟不被丢弃）
    const assistant = firstRequest.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.map((call) => call.id)).toEqual(["c1", "c2"]);

    // ── 文件：T1/T2 的原效果都在（起点 = 该轮**轮末**检查点）────────────────────────
    const childTools = toolCalls(child);
    expect(childTools).toHaveLength(2);
    expect(childTools.map((tool) => String(tool.result))).toEqual(["X", "Y"]);
    // ── 不重做 T1/T2：子没有任何 write_file 调用 ───────────────────────────────────
    expect(childTools.every((tool) => tool.tool === "read_file")).toBe(true);

    // ── 父 trace 与源目录不变 ────────────────────────────────────────────────────
    expect(sha256Of(parent.traceFile)).toBe(parentHashBefore);
    expect(existsSync(join(parent.source, "a.txt"))).toBe(false);
  });
});

describe("replayIsolatedRun：拒绝时零子 trace、零 LLM", () => {
  it("本次请求缺授权 → missing_authority", async () => {
    const parent = await makeParent({
      script: [{ toolCalls: [writeCall("c1", "a.txt", "X")] }, { content: "done" }],
    });
    const before = readdirSync(join(parent.dataDir, WORKSPACE_TRACES_DIR_NAME)).sort();
    const llm = new ScriptedLlm([{ content: "不该被调用" }]);

    const result = await replayIsolatedRun({
      dataDir: parent.dataDir,
      parentId: parent.parentId,
      atSpanId: parent.tools1[0]?.id ?? "",
      edit: { field: "result", value: "改了" },
      config: makeConfig(),
      authority: { allowFileWrites: false },
      llm: asLoopLlm(llm),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("missing_authority");
    }
    expect(llm.requests).toHaveLength(0);
    expect(readdirSync(join(parent.dataDir, WORKSPACE_TRACES_DIR_NAME)).sort()).toEqual(before);
  });

  it("预检失败原样透传（分叉点不存在 / system prompt 变化 / 父崩溃）", async () => {
    const cases: Array<{
      readonly name: string;
      readonly prepare?: (parent: ParentRun) => ParentRun;
      readonly atSpanId?: (parent: ParentRun) => string;
      readonly config?: () => RunConfig;
      readonly expected: string;
    }> = [
      {
        name: "分叉点不存在",
        atSpanId: () => "s_999",
        expected: "invalid_edit_point",
      },
      {
        name: "system prompt 变化",
        config: () => makeConfig("换了个 system prompt"),
        expected: "source_changed",
      },
      {
        name: "父 run 崩溃（缺终止事件）",
        prepare: (parent) => {
          const lines = readFileSync(parent.traceFile, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0 && !line.includes('"run.event"'));
          writeFileSync(parent.traceFile, `${lines.join("\n")}\n`);
          return parent;
        },
        expected: "parent_not_forkable",
      },
    ];

    for (const testCase of cases) {
      const parent = testCase.prepare
        ? testCase.prepare(
            await makeParent({
              script: [{ toolCalls: [writeCall("c1", "a.txt", "X")] }, { content: "done" }],
            }),
          )
        : await makeParent({
            script: [{ toolCalls: [writeCall("c1", "a.txt", "X")] }, { content: "done" }],
          });
      const before = readdirSync(join(parent.dataDir, WORKSPACE_TRACES_DIR_NAME)).sort();
      const llm = new ScriptedLlm([{ content: "不该被调用" }]);

      const result = await replayIsolatedRun({
        dataDir: parent.dataDir,
        parentId: parent.parentId,
        atSpanId: testCase.atSpanId?.(parent) ?? parent.tools1[0]?.id ?? "",
        edit: { field: "result", value: "改了" },
        config: testCase.config?.() ?? makeConfig(),
        authority: { allowFileWrites: true },
        llm: asLoopLlm(llm),
      });

      expect(result.ok, testCase.name).toBe(false);
      if (!result.ok) {
        expect(result.failure.code, testCase.name).toBe(testCase.expected);
      }
      expect(llm.requests, testCase.name).toHaveLength(0);
      expect(
        readdirSync(join(parent.dataDir, WORKSPACE_TRACES_DIR_NAME)).sort(),
        testCase.name,
      ).toEqual(before);
    }
  });
});

describe("replayIsolatedRun：errored 也归位", () => {
  it("子 LLM 失败仍落盘并保留已完成轮次的文件事实", async () => {
    const parent = await makeParent({
      script: [{ toolCalls: [writeCall("c1", "a.txt", "X")] }, { content: "done" }],
    });
    // 子的剧本只有一轮：第 2 次请求时桩抛错 ⇒ loop 记 errored 并封存
    const llm = new ScriptedLlm([{ toolCalls: [readCall("r1", "a.txt")] }]);

    const result = await replayIsolatedRun({
      dataDir: parent.dataDir,
      parentId: parent.parentId,
      atSpanId: parent.tools1[0]?.id ?? "",
      edit: { field: "result", value: "改了" },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.outcome.event.event).toBe("errored");

    const child = readRun(childTraceFile(parent.dataDir, result.id));
    expect(child.status).toBe("completed");
    expect(child.events.map((event) => event.event)).toContain("errored");
    // 已完成的第 1 轮带着本 run 自己的检查点（新世界的文件事实）
    const step = child.spans.find(
      (span): span is AgentStepSpan => span.kind === "agent.step" && span.n === 1,
    );
    expect(step?.workspace_snapshot?.files.map((file) => file.path)).toEqual(["a.txt", "seed.txt"]);
    expect(String(toolCalls(child)[0]?.result)).toBe("X");
  });
});
