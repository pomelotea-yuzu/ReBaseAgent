import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configHash } from "@rebaseagent/agent-loop";
import type { Tool, ToolDef } from "@rebaseagent/agent-loop";
import { readRun, resolveBranch } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { promptReplayRun } from "../src/prompt-replay-run";
import { createWorkspaceBlobStore } from "../src/workspace/blob-store";
import { FILE_TOOLS_V1_DEFINITIONS } from "../src/workspace/file-tools";
import { preflightIsolatedPromptReplay } from "../src/workspace/isolated-prompt-preflight";
import { promptReplayIsolatedRun } from "../src/workspace/isolated-prompt-run";
import { replayIsolatedRun } from "../src/workspace/isolated-replay";
import { ScriptedLlm, asLoopLlm, makeConfig, readCall, writeCall } from "./isolated-helpers";
import {
  ACCEPTANCE_CRITERION,
  BASELINE_MODEL,
  BASELINE_PARAMS,
  CONFIG_FINAL_B,
  CONFIG_INITIAL_A,
  CONFIG_PATH,
  CONFIG_SOURCE_C,
  HYPOTHESIS,
  NEW_SYSTEM_PROMPT,
  NEW_USER_INSTRUCTION,
  ORIGINAL_SYSTEM_PROMPT,
  buildIsolatedPromptBaselineCase,
  deriveEditedMessages,
} from "./isolated-prompt-baseline-fixture";
import { cleanupTempDirs, makeDataDir } from "./workspace-helpers";

/**
 * R2.2 任务 3.4：隔离 prompt 实验编排。
 *
 * 证据边界：确定性 mock LLM + 真实文件世界/JSONL；真实模型闭环在 7.1。
 * 本文件不宣称修复成立，只证"起点/编辑/身份/失败事实"这些结构不变量。
 */

afterEach(() => {
  cleanupTempDirs();
});

const FIXED_TOOLS = [...FILE_TOOLS_V1_DEFINITIONS] as ToolDef[];

function tracesDir(dataDir: string): string {
  return join(dataDir, "traces");
}

function blobDir(dataDir: string): string {
  return join(dataDir, "workspace-blobs", "sha256");
}

function loaderOf(map: Record<string, RunRecord>) {
  return (id: string): RunRecord => {
    const record = map[id];
    if (record === undefined) throw new Error(`缺少 run：${id}`);
    return record;
  };
}

async function baseline() {
  const tmp = makeDataDir();
  const fixture = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
  return { tmp, fixture };
}

describe("promptReplayIsolatedRun：从根初始快照独立执行", () => {
  it("system 编辑：从 A 起跑、首次请求用基线模型/params、写 v3、身份一致", async () => {
    const { tmp, fixture } = await baseline();
    const rootBefore = readFileSync(fixture.root.traceFile);
    const siblingBefore = readFileSync(fixture.sibling!.traceFile);
    const sourceBefore = readFileSync(join(fixture.sourceDir, CONFIG_PATH));
    const blobsBefore = readdirSync(blobDir(tmp.dataDir)).sort();

    const llm = new ScriptedLlm(
      [{ toolCalls: [readCall("c1", CONFIG_PATH)] }, { content: "完成" }],
      tracesDir(tmp.dataDir),
    );
    const identities: string[] = [];
    const plan = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: makeConfig(),
      hypothesis: HYPOTHESIS,
      acceptanceCriterion: ACCEPTANCE_CRITERION,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const result = await promptReplayIsolatedRun({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      hypothesis: HYPOTHESIS,
      acceptanceCriterion: ACCEPTANCE_CRITERION,
      llm: asLoopLlm(llm),
      onRunIdentified: (id) => identities.push(id),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.event).toEqual({ event: "stopped", reason: "completed", at: 2 });
    expect(identities).toEqual([result.id]);

    // 首次 LLM 前 meta 已写出：身份/版本/实验记录都是最终值
    const firstMeta = llm.atFirstCall?.metaLine as Record<string, unknown> | null;
    expect(firstMeta).not.toBeNull();
    expect(firstMeta?.id).toBe(result.id);
    expect(firstMeta?.format_version).toBe(3);
    expect(firstMeta?.model).toBe(BASELINE_MODEL);
    expect((firstMeta?.fork as { resume_after_step?: unknown }).resume_after_step).toBeUndefined();
    expect(firstMeta?.prompt_experiment).toBeDefined();

    const traceFile = join(tracesDir(tmp.dataDir), `${result.id}.jsonl`);
    const record = readRun(traceFile);
    expect(record.meta.format_version).toBe(3);
    expect(record.meta.parent).toBe(fixture.root.runId);
    expect(record.meta.fork).toEqual({
      at_span: fixture.root.llmSpanId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
    });
    expect(record.meta.workspace?.world_id).toBe(result.id);
    expect(record.meta.workspace?.origin).toEqual({
      kind: "initial",
      run_id: fixture.root.runId,
      snapshot_id: fixture.root.initialSnapshotId,
    });
    expect(record.meta.workspace?.initial_snapshot.id).toBe(fixture.root.initialSnapshotId);
    expect(record.meta.config_hash).toBe(configHash(NEW_SYSTEM_PROMPT, FIXED_TOOLS));
    expect(record.meta.prompt_experiment).toMatchObject({
      baseline_run_id: fixture.root.runId,
      baseline_llm_span_id: fixture.root.llmSpanId,
      initial_snapshot_id: fixture.root.initialSnapshotId,
      original_value: ORIGINAL_SYSTEM_PROMPT,
      hypothesis: HYPOTHESIS,
      acceptance_criterion: ACCEPTANCE_CRITERION,
    });
    expect(record.meta.prompt_experiment?.execution.model).toBe(BASELINE_MODEL);
    expect(record.meta.prompt_experiment?.execution.params).toEqual(BASELINE_PARAMS);
    expect(record.meta.prompt_experiment?.execution.config_fingerprint).toBe(
      plan.value.planFingerprint,
    );

    // 首次实际请求：只改 system，模型/params 取根事实
    const firstLlm = record.spans.find((span) => span.kind === "llm.call");
    expect(firstLlm?.kind).toBe("llm.call");
    if (firstLlm?.kind !== "llm.call") return;
    expect(firstLlm.request.messages).toEqual(
      deriveEditedMessages("system_prompt", NEW_SYSTEM_PROMPT),
    );
    expect(firstLlm.request.model).toBe(BASELINE_MODEL);
    expect(firstLlm.request.params).toEqual(BASELINE_PARAMS);

    // 第 1 步读到的必须是根初始 A（不是父最终 B、也不是源目录 C）
    const tool = record.spans.find((span) => span.kind === "tool.invoke");
    expect(tool?.kind).toBe("tool.invoke");
    if (tool?.kind === "tool.invoke") {
      expect(tool.result).toBe(CONFIG_INITIAL_A);
      expect(tool.result).not.toBe(CONFIG_FINAL_B);
      expect(tool.result).not.toBe(CONFIG_SOURCE_C);
    }
    const step = record.spans.find((span) => span.kind === "agent.step");
    expect(
      step?.kind === "agent.step"
        ? step.workspace_snapshot?.files.find((file) => file.path === CONFIG_PATH)?.sha256
        : null,
    ).toBe(fixture.root.initialFiles[0]?.sha256);

    // 父/兄弟/源目录/既有 blob 不变（只读，不补写）
    expect(readFileSync(fixture.root.traceFile)).toEqual(rootBefore);
    expect(readFileSync(fixture.sibling!.traceFile)).toEqual(siblingBefore);
    expect(readFileSync(join(fixture.sourceDir, CONFIG_PATH))).toEqual(sourceBefore);
    expect(readdirSync(blobDir(tmp.dataDir)).sort()).toEqual(blobsBefore);

    // v3 读取：独立边界只呈现自有 spans，父链仅溯源
    const rootRecord = readRun(fixture.root.traceFile);
    const resolved = resolveBranch(
      result.id,
      loaderOf({ [fixture.root.runId]: rootRecord, [result.id]: record }),
    );
    expect(resolved.spans.map((span) => span.id)).toEqual(record.spans.map((span) => span.id));
    expect(resolved.chain.map((hop) => hop.meta.id)).toEqual([fixture.root.runId, result.id]);
  });

  it("空初始世界：可合法从头执行并写入新文件", async () => {
    const tmp = makeDataDir();
    const fixture = await buildIsolatedPromptBaselineCase({
      dataDir: tmp.dataDir,
      emptyInitial: true,
      withSibling: false,
    });
    const llm = new ScriptedLlm(
      [{ toolCalls: [writeCall("c1", CONFIG_PATH, '{"retries":3}')] }, { content: "完成" }],
      tracesDir(tmp.dataDir),
    );
    const result = await promptReplayIsolatedRun({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "user_message", value: NEW_USER_INSTRUCTION },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = readRun(join(tracesDir(tmp.dataDir), `${result.id}.jsonl`));
    const step = record.spans.find((span) => span.kind === "agent.step");
    expect(
      step?.kind === "agent.step" ? step.workspace_snapshot?.files.map((file) => file.path) : [],
    ).toEqual([CONFIG_PATH]);
    expect(record.meta.workspace?.initial_snapshot.files).toEqual([]);
    expect(record.meta.workspace?.origin.kind).toBe("initial");
  });

  it("空初始世界 + 超大写入：成为工具错误，映射/检查点不被污染，loop 继续完成", async () => {
    const tmp = makeDataDir();
    const fixture = await buildIsolatedPromptBaselineCase({
      dataDir: tmp.dataDir,
      emptyInitial: true,
      withSibling: false,
    });
    const oversized = "x".repeat(8 * 1024 * 1024 + 1);
    const llm = new ScriptedLlm(
      [{ toolCalls: [writeCall("c1", "huge.txt", oversized)] }, { content: "已确认失败并结束" }],
      tracesDir(tmp.dataDir),
    );
    const result = await promptReplayIsolatedRun({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.event.event).toBe("stopped");
    const record = readRun(join(tracesDir(tmp.dataDir), `${result.id}.jsonl`));
    const tool = record.spans.find((span) => span.kind === "tool.invoke");
    expect(tool?.kind).toBe("tool.invoke");
    if (tool?.kind === "tool.invoke") {
      expect(tool.error).toContain("单文件超过上限");
    }
    const step = record.spans.find((span) => span.kind === "agent.step");
    expect(step?.kind === "agent.step" ? step.workspace_snapshot?.files : []).toEqual([]);
  });
});

describe("promptReplayIsolatedRun：前置拒绝零子记录/零调用", () => {
  it("未授权：返回 missing_authority，零 LLM、零 trace、零身份", async () => {
    const { tmp, fixture } = await baseline();
    const tracesBefore = readdirSync(tracesDir(tmp.dataDir)).sort();
    const llm = new ScriptedLlm([{ content: "不该被调用" }]);
    const identities: string[] = [];
    const result = await promptReplayIsolatedRun({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: makeConfig(),
      authority: { allowFileWrites: false },
      llm: asLoopLlm(llm),
      onRunIdentified: (id) => identities.push(id),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("missing_authority");
    expect(llm.requests).toHaveLength(0);
    expect(identities).toEqual([]);
    expect(readdirSync(tracesDir(tmp.dataDir)).sort()).toEqual(tracesBefore);
  });

  it("非根：parent_not_root，零 LLM、零子记录、零身份", async () => {
    const { tmp, fixture } = await baseline();
    const tracesBefore = readdirSync(tracesDir(tmp.dataDir)).sort();
    const llm = new ScriptedLlm([{ content: "不该被调用" }]);
    const identities: string[] = [];
    const result = await promptReplayIsolatedRun({
      dataDir: tmp.dataDir,
      rootId: fixture.sibling!.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
      onRunIdentified: (id) => identities.push(id),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("parent_not_root");
    expect(llm.requests).toHaveLength(0);
    expect(identities).toEqual([]);
    expect(readdirSync(tracesDir(tmp.dataDir)).sort()).toEqual(tracesBefore);
  });

  it("提交时附件已缺失：重验拒绝，零 LLM、零子记录", async () => {
    const { tmp, fixture } = await baseline();
    const { unlinkSync } = await import("node:fs");
    unlinkSync(
      join(tmp.dataDir, "workspace-blobs", "sha256", fixture.root.initialFiles[0]!.sha256),
    );
    const tracesBefore = readdirSync(tracesDir(tmp.dataDir)).sort();
    const llm = new ScriptedLlm([{ content: "不该被调用" }]);
    const result = await promptReplayIsolatedRun({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("attachment_missing");
    expect(llm.requests).toHaveLength(0);
    expect(readdirSync(tracesDir(tmp.dataDir)).sort()).toEqual(tracesBefore);
  });
});

describe("promptReplayIsolatedRun：失败事实与观察者", () => {
  it("模型失败：v3 落盘 errored、身份可关联、实验记录保留、无工具调用", async () => {
    const { tmp, fixture } = await baseline();
    const identities: string[] = [];
    const llm = new ScriptedLlm([]);
    const result = await promptReplayIsolatedRun({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
      onRunIdentified: (id) => identities.push(id),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.event).toEqual({ event: "errored", reason: "error", at: 1 });
    expect(identities).toEqual([result.id]);

    const record = readRun(join(tracesDir(tmp.dataDir), `${result.id}.jsonl`));
    expect(record.status).toBe("completed"); // 有终止事件：失败也是已封存事实
    expect(record.events[0]).toMatchObject({ event: "errored", reason: "error" });
    expect(record.meta.id).toBe(identities[0]);
    expect(record.meta.format_version).toBe(3);
    expect(record.meta.prompt_experiment?.execution.config_fingerprint).toMatch(/^sha256:/);
    const failed = record.spans.find((span) => span.kind === "llm.call");
    expect(failed?.kind === "llm.call" ? failed.error : undefined).toMatchObject({
      message: expect.stringContaining("剧本耗尽"),
    });
    expect(record.spans.some((span) => span.kind === "tool.invoke")).toBe(false);
  });

  it("观察者抛错：执行/请求数/文件语义不变，身份仍恰一次", async () => {
    const { tmp, fixture } = await baseline();
    const llm = new ScriptedLlm([{ content: "完成" }]);
    let calls = 0;
    const result = await promptReplayIsolatedRun({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
      onRunIdentified: () => {
        calls += 1;
        throw new Error("观察者自己的异常");
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.event.event).toBe("stopped");
    expect(llm.requests).toHaveLength(1);
    expect(calls).toBe(1);
    const record = readRun(join(tracesDir(tmp.dataDir), `${result.id}.jsonl`));
    expect(record.events[0]?.event).toBe("stopped");
  });
});

describe("3.6 回归：v3 父本不得降级到普通 prompt fork", () => {
  it("promptReplayRun 拒绝 v3 父本：零子文件、零模型调用", async () => {
    const { tmp, fixture } = await baseline();
    const v3 = await promptReplayIsolatedRun({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(new ScriptedLlm([{ content: "完成" }])),
    });
    expect(v3.ok).toBe(true);
    if (!v3.ok) return;

    const outDir = join(tmp.dataDir, "ordinary-fork-out");
    const tools: Tool[] = FILE_TOOLS_V1_DEFINITIONS.map((definition) => ({
      ...definition,
      handler: () => "普通 handler 不应被执行",
    }));
    let message = "";
    try {
      await promptReplayRun({
        parentId: v3.id,
        edit: { field: "system_prompt", value: "试图绕过隔离边界" },
        config: makeConfig(NEW_SYSTEM_PROMPT),
        tools,
        load: (id) => readRun(join(tracesDir(tmp.dataDir), `${id}.jsonl`)),
        outDir,
        llm: asLoopLlm(new ScriptedLlm([{ content: "不该被调用" }])),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("隔离 run");
    expect(existsSync(outDir)).toBe(false);
  });
});

describe("3.6 回归：v3 父的 result 子仍写 v2", () => {
  it("从 v3 自身整轮继续 result 续跑：子写 v2，前缀只含 v3 自有执行", async () => {
    const { tmp, fixture } = await baseline();
    const v3Llm = new ScriptedLlm([
      { toolCalls: [writeCall("c1", CONFIG_PATH, '{"retries":3}')] },
      { content: "完成" },
    ]);
    const v3 = await promptReplayIsolatedRun({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(v3Llm),
    });
    expect(v3.ok).toBe(true);
    if (!v3.ok) return;
    const v3Record = readRun(join(tracesDir(tmp.dataDir), `${v3.id}.jsonl`));
    const tool = v3Record.spans.find((span) => span.kind === "tool.invoke");
    const step = v3Record.spans.find((span) => span.kind === "agent.step");
    expect(tool?.kind).toBe("tool.invoke");
    expect(step?.kind).toBe("agent.step");
    if (tool?.kind !== "tool.invoke" || step?.kind !== "agent.step") return;

    const resultLlm = new ScriptedLlm([{ content: "完成" }]);
    const child = await replayIsolatedRun({
      dataDir: tmp.dataDir,
      parentId: v3.id,
      atSpanId: tool.id,
      edit: { field: "result", value: "重试后的结果" },
      config: makeConfig(NEW_SYSTEM_PROMPT),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(resultLlm),
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    const childRecord = readRun(join(tracesDir(tmp.dataDir), `${child.id}.jsonl`));
    expect(childRecord.meta.format_version).toBe(2);
    expect(childRecord.meta.parent).toBe(v3.id);
    expect(childRecord.meta.workspace?.origin).toEqual({
      kind: "checkpoint",
      run_id: v3.id,
      step_span: step.id,
    });
    expect(childRecord.meta.fork?.resume_after_step).toBe(step.id);

    const resolved = resolveBranch(
      child.id,
      loaderOf({
        [fixture.root.runId]: readRun(fixture.root.traceFile),
        [v3.id]: v3Record,
        [child.id]: childRecord,
      }),
    );
    // 前缀截止 v3 第 1 轮整轮（step + 其 llm/tool），第 2 轮与实验根都不进入
    const firstRound = v3Record.spans.filter(
      (span) => span.id === step.id || span.parent === step.id,
    );
    const v3SpanIds = new Set(v3Record.spans.map((span) => span.id));
    const inherited = resolved.spans.filter((span) => v3SpanIds.has(span.id));
    expect(inherited.map((span) => span.id)).toEqual(firstRound.map((span) => span.id));
    expect(inherited.map((span) => span.id)).toEqual(["s_01", "s_02", "s_03"]);

    // span id 在不同 run 间可以重复（owner 区分），所以按内容证明前缀来自 v3 而不是实验根：
    // v3 首轮 llm 是编辑后的 system，根首轮 llm 是原始 system。
    const resolvedFirstLlm = resolved.spans.find((span) => span.kind === "llm.call");
    const v3FirstLlm = v3Record.spans.find((span) => span.kind === "llm.call");
    const rootFirstLlm = readRun(fixture.root.traceFile).spans.find(
      (span) => span.kind === "llm.call",
    );
    expect(
      resolvedFirstLlm?.kind === "llm.call" ? resolvedFirstLlm.request.messages : null,
    ).toEqual(v3FirstLlm?.kind === "llm.call" ? v3FirstLlm.request.messages : undefined);
    expect(
      resolvedFirstLlm?.kind === "llm.call" ? resolvedFirstLlm.request.messages : null,
    ).not.toEqual(rootFirstLlm?.kind === "llm.call" ? rootFirstLlm.request.messages : undefined);
  });
});
