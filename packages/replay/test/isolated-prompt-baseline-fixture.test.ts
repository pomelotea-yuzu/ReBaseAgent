import { readFileSync } from "node:fs";
import { readRun } from "@rebaseagent/trace-sdk";
import type { LlmCallSpan, WorkspaceSnapshot } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceBlobStore } from "../src/workspace/blob-store";
import { FILE_TOOLS_V1_DEFINITIONS } from "../src/workspace/file-tools";
import {
  ACCEPTANCE_CRITERION,
  BASELINE_CONFIG_HASH,
  BASELINE_MODEL,
  BASELINE_PARAMS,
  CONFIG_FINAL_B,
  CONFIG_INITIAL_A,
  CONFIG_PATH,
  CONFIG_SIBLING_FINAL,
  CONFIG_SOURCE_C,
  HYPOTHESIS,
  NEW_SYSTEM_PROMPT,
  NEW_USER_INSTRUCTION,
  ORIGINAL_MESSAGES,
  TARGET_INITIAL_VALUE,
  TARGET_KEY,
  TARGET_VALUE,
  UNKNOWN_KEY,
  UNKNOWN_VALUE,
  buildIsolatedPromptBaselineCase,
  deriveEditedMessages,
} from "./isolated-prompt-baseline-fixture";
import { cleanupTempDirs, makeDataDir } from "./workspace-helpers";

/**
 * R2.2 任务 1.1 验收：受控案例自身的确定性不变量（mock 层证据）。
 *
 * 对应 scenario：
 * - workspace「根初始状态与父最终及源目录分离」
 * - prompt「单项改动与首次实际请求一致」（fixture 层参考实现）
 * - workspace「空初始世界与后续超限遵守原配额」的 fixture 基座（emptyInitial 变体）
 *
 * 真实模型证据在 7.1 分列；本文件不宣称修复成立。
 */

afterEach(() => {
  cleanupTempDirs();
});

describe("R2.2 受控案例 fixture（config.json 未知键保留）", () => {
  it("根初始状态与父最终及源目录分离（三态互异、未知键判据成立）", async () => {
    const tmp = makeDataDir();
    const record = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
    const store = createWorkspaceBlobStore(tmp.dataDir);

    const readText = async (file: { sha256: string; bytes: number }): Promise<string> => {
      const result = await store.readVerified(file);
      expect(result.state).toBe("ok");
      return result.state === "ok" ? new TextDecoder().decode(result.data) : "";
    };

    // A：根初始快照 —— 未知键在、目标键初值错误
    const initialText = await readText(record.root.initialFiles[0]!);
    const initialConfig = JSON.parse(initialText) as Record<string, unknown>;
    expect(initialConfig[UNKNOWN_KEY]).toBe(UNKNOWN_VALUE);
    expect(initialConfig[TARGET_KEY]).toBe(TARGET_INITIAL_VALUE);
    expect(initialText).toBe(CONFIG_INITIAL_A);

    // B：父轮末快照 —— 原指令覆盖式重写导致未知键丢失
    const finalText = await readText(record.root.finalFiles[0]!);
    const finalConfig = JSON.parse(finalText) as Record<string, unknown>;
    expect(finalConfig[UNKNOWN_KEY]).toBeUndefined();
    expect(finalConfig[TARGET_KEY]).toBe(TARGET_VALUE);
    expect(finalText).toBe(CONFIG_FINAL_B);

    // A ≠ B（快照 id 层面）
    expect(record.root.initialSnapshotId).not.toBe(record.root.finalSnapshotId);

    // C：源目录真实落盘，且与 A、B 内容均不同
    const sourceText = readFileSync(`${record.sourceDir}/${CONFIG_PATH}`, "utf8");
    expect(sourceText).toBe(CONFIG_SOURCE_C);
    expect(sourceText).not.toBe(CONFIG_INITIAL_A);
    expect(sourceText).not.toBe(CONFIG_FINAL_B);
  });

  it("首次请求与单项编辑一致：只动一条消息的 content，其余逐字段保留", async () => {
    const tmp = makeDataDir();
    const record = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
    const run = readRun(record.root.traceFile);

    const llm = run.spans.find((s): s is LlmCallSpan => s.kind === "llm.call");
    expect(llm).toBeDefined();
    expect(llm!.request.model).toBe(BASELINE_MODEL);
    expect(llm!.request.params).toEqual(BASELINE_PARAMS);
    expect(llm!.request.tools).toEqual([...FILE_TOOLS_V1_DEFINITIONS]);
    expect(llm!.request.messages).toEqual([...ORIGINAL_MESSAGES]);

    // user_message 编辑：只有首条 user 的 content 变
    const userEdit = deriveEditedMessages("user_message", NEW_USER_INSTRUCTION);
    expect(userEdit).toHaveLength(ORIGINAL_MESSAGES.length);
    expect(userEdit[1]!.content).toBe(NEW_USER_INSTRUCTION);
    expect(userEdit[0]).toEqual(ORIGINAL_MESSAGES[0]);

    // system_prompt 编辑：只有首条 system 的 content 变
    const systemEdit = deriveEditedMessages("system_prompt", NEW_SYSTEM_PROMPT);
    expect(systemEdit[0]!.content).toBe(NEW_SYSTEM_PROMPT);
    expect(systemEdit[1]).toEqual(ORIGINAL_MESSAGES[1]);

    // 空串编辑是真实变化（不 trim、不拒绝）——参考实现按原样替换
    const emptyEdit = deriveEditedMessages("user_message", "");
    expect(emptyEdit[1]!.content).toBe("");
  });

  it("根 meta 形状正确：v2 隔离根（origin import）+ config_hash 与消息/工具表同源", async () => {
    const tmp = makeDataDir();
    const record = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
    const run = readRun(record.root.traceFile);

    expect(run.meta.format_version).toBe(2);
    expect(run.meta.parent).toBeNull();
    expect(run.meta.fork).toBeNull();
    expect(run.meta.config_hash).toBe(BASELINE_CONFIG_HASH);
    expect(run.meta.workspace?.profile).toBe("file-tools-v1");
    expect(run.meta.workspace?.origin).toEqual({ kind: "import" });
  });

  it("兄弟分支指纹：以父轮末 B 为起点、终态与根及 A 均不同，指纹可复算", async () => {
    const tmp = makeDataDir();
    const record = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
    expect(record.sibling).not.toBeNull();
    const sibling = record.sibling!;
    const run = readRun(sibling.traceFile);

    expect(run.meta.parent).toBe(record.root.runId);
    expect(run.meta.workspace?.origin).toEqual({
      kind: "checkpoint",
      run_id: record.root.runId,
      step_span: record.root.stepSpanId,
    });
    expect(run.meta.fork?.resume_after_step).toBe(record.root.stepSpanId);

    // 分支起点 = 父轮末 B（真实 result 分叉语义）
    expect(sibling.initialSnapshotId).toBe(record.root.finalSnapshotId);
    // 终态与根轮末、A 均不同
    expect(sibling.finalSnapshotId).not.toBe(record.root.finalSnapshotId);
    expect(sibling.finalSnapshotId).not.toBe(record.root.initialSnapshotId);
    const store = createWorkspaceBlobStore(tmp.dataDir);
    const siblingBlob = await store.readVerified(sibling.finalFiles[0]!);
    expect(siblingBlob.state).toBe("ok");
    const siblingText = JSON.parse(
      siblingBlob.state === "ok" ? new TextDecoder().decode(siblingBlob.data) : "{}",
    ) as Record<string, unknown>;
    expect(siblingText[UNKNOWN_KEY]).toBe("sibling-kept");
    expect(siblingText[TARGET_KEY]).toBe(TARGET_VALUE);
  });

  it("同一案例在全新 dataDir 重建：A/B/兄弟指纹逐字节可复现", async () => {
    const tmpA = makeDataDir();
    const tmpB = makeDataDir();
    const a = await buildIsolatedPromptBaselineCase({ dataDir: tmpA.dataDir });
    const b = await buildIsolatedPromptBaselineCase({ dataDir: tmpB.dataDir });

    expect(b.root.initialSnapshotId).toBe(a.root.initialSnapshotId);
    expect(b.root.finalSnapshotId).toBe(a.root.finalSnapshotId);
    expect(b.sibling?.finalSnapshotId).toBe(a.sibling?.finalSnapshotId);
  });

  it("空初始世界变体：initial_snapshot 为空清单，第 1 轮仍落盘 config.json", async () => {
    const tmp = makeDataDir();
    const record = await buildIsolatedPromptBaselineCase({
      dataDir: tmp.dataDir,
      emptyInitial: true,
    });
    const run = readRun(record.root.traceFile);

    expect(record.root.initialFiles).toHaveLength(0);
    const snapshot = run.meta.workspace!.initial_snapshot as WorkspaceSnapshot;
    expect(snapshot.files).toHaveLength(0);
    expect(record.root.finalFiles).toHaveLength(1);
    expect(record.root.finalSnapshotId).not.toBe(record.root.initialSnapshotId);
  });

  it("案例记录完整：假设/判据文本随常量导出（供 v3 prompt_experiment 落盘）", () => {
    expect(HYPOTHESIS.length).toBeGreaterThan(0);
    expect(ACCEPTANCE_CRITERION).toContain(UNKNOWN_KEY);
    expect(ACCEPTANCE_CRITERION).toContain(String(TARGET_VALUE));
    // 判据必须覆盖「未知键保留」与「目标值正确」两个维度
    expect(ACCEPTANCE_CRITERION).toContain("未知键保留");
    expect(ACCEPTANCE_CRITERION).toContain("目标值正确");
  });
});
