import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LlmCallSpan, RunRecord } from "@rebaseagent/trace-sdk";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_BLOBS_DIR_NAME,
  WORKSPACE_TRACES_DIR_NAME,
  preflightIsolatedReplay,
  readWorkspaceFile,
  replayIsolatedRun,
  workspaceTraceFile,
} from "../src/index";
import { ScriptedLlm, asLoopLlm, makeConfig, readCall, writeCall } from "./isolated-helpers";
import {
  AFTER,
  BEFORE,
  CHILD,
  MIDDLE,
  SIBLING,
  createThreeRoundParent,
  forkFromParent,
  sha256OfFile,
  sha256OfText,
  stepsOf,
  treeFingerprint,
} from "./package-fixture";
import { cleanupTempDirs, makeTempDir } from "./workspace-helpers";

/**
 * 7.2（一）：包 API **重新加载** 与 **dataDir 整体迁移**。
 *
 * 验证点（tasks.md 7.2）：`workspace-isolation/中断与数据目录迁移` 的后半句 + `trace-format/无附件仍能看轨迹`。
 * spec 原文：*"数据目录整体移动后重启 → 重新建立包 store/读取器后通过相对内容引用恢复解析、
 * 附件读取和合法续跑，无需原绝对路径"*；*"合法 v2 JSONL 存在但附件目录不可用 → 普通 trace 解析
 * 不加载附件，仍返回完整消息与步骤；包附件读取和真实续跑分别报告不可用，不能改写 trace 补数据"*。
 *
 * ## "重新加载"在包层意味着什么
 *
 * 包层没有会话对象：`dataDir` 是每次调用的入参，`workspaceTraceFile(dataDir, runId)` 按参数拼路径，
 * 附件物理位置由包内按 `sha256` 推导。所以"重新建立 store / 读取器"= **丢掉先前的一切引用，
 * 只凭 `dataDir` + `runId` 再来一次**。用例因此显式地不复用任何先前对象，并额外断言
 * **纯读不改 dataDir 一个字节**（证明重新加载没有"顺手写索引/缓存"这种隐藏状态）。
 *
 * ## "无需原绝对路径"要有直接证据
 *
 * 迁移后旧路径已不存在，能工作本身就是证据；但更强的证据是**读 trace 文本，里面不含任何
 * 绝对路径**（既不含旧 dataDir，也不含源目录）。两侧都断言，避免"其实只是恰好还能找到旧路径"。
 */

afterEach(cleanupTempDirs);

function llmCalls(record: RunRecord): LlmCallSpan[] {
  return record.spans.filter((span): span is LlmCallSpan => span.kind === "llm.call");
}

/** 从包只读接口读文本（非 text 状态就返回状态名，便于失败时一眼看清原因） */
async function readText(
  dataDir: string,
  runId: string,
  stepSpanId: string | undefined,
  path: string,
): Promise<string> {
  const result = await readWorkspaceFile({
    dataDir,
    runId,
    ...(stepSpanId === undefined ? {} : { stepSpanId }),
    path,
  });
  return result.status === "text" ? result.text : `<${result.status}>`;
}

describe("7.2 包 API 重新加载", () => {
  it("丢弃全部引用后只凭 dataDir + runId 重来：解析、附件读取与预检照旧可用且零写入", async () => {
    const parent = await createThreeRoundParent();
    const fingerprintBefore = treeFingerprint(parent.dataDir);

    // ── 重新加载：这里刻意不碰 parent.record / parent.steps 等任何先前对象 ────────────────
    const reloaded = readRun(workspaceTraceFile(parent.dataDir, parent.runId));
    expect(reloaded.meta.id).toBe(parent.runId);
    expect(reloaded.meta.format_version).toBe(2);
    expect(reloaded.status).toBe("completed");
    // 完整消息与步骤：3 轮 llm.call + 3 个 agent.step + 3 次工具调用
    expect(llmCalls(reloaded)).toHaveLength(3);
    expect(stepsOf(reloaded)).toHaveLength(3);
    expect(reloaded.spans.filter((span) => span.kind === "tool.invoke")).toHaveLength(3);
    expect(reloaded.events.at(-1)?.event).toBe("stopped");

    // 附件读取：三个历史态都对（起点 before / 轮 1 middle+sibling / 轮 2 after）
    const firstStep = stepsOf(reloaded)[0];
    const secondStep = stepsOf(reloaded)[1];
    expect(await readText(parent.dataDir, parent.runId, undefined, "a.txt")).toBe(BEFORE);
    expect(await readText(parent.dataDir, parent.runId, firstStep?.id, "a.txt")).toBe(MIDDLE);
    expect(await readText(parent.dataDir, parent.runId, firstStep?.id, "b.txt")).toBe(SIBLING);
    expect(await readText(parent.dataDir, parent.runId, secondStep?.id, "a.txt")).toBe(AFTER);

    // 预检：重新建立 store 之后仍可用
    const capability = await preflightIsolatedReplay({
      dataDir: parent.dataDir,
      parentId: parent.runId,
      atSpanId: reloaded.spans.find((span) => span.kind === "tool.invoke")?.id ?? "",
      edit: { field: "result", value: "重新加载后的编辑" },
      config: makeConfig(),
    });
    expect(capability.ok).toBe(true);
    if (capability.ok) {
      expect(capability.value.fileCount).toBe(3);
      expect(capability.value.snapshot.files.map((file) => file.path)).toEqual([
        "a.txt",
        "b.txt",
        "keep.txt",
      ]);
    }

    // 纯读：整个 dataDir 的逐项指纹不变（没有索引、缓存或临时文件留下）
    expect(treeFingerprint(parent.dataDir)).toEqual(fingerprintBefore);
  });
});

describe("7.2 dataDir 整体迁移", () => {
  it("迁移后解析、附件读取与续跑都在新位置完成，且 trace 里不含任何绝对路径", async () => {
    const parent = await createThreeRoundParent();
    const movedDir = join(makeTempDir("pkg-moved-"), "data");
    renameSync(parent.dataDir, movedDir);

    // 旧位置真的没了（否则"迁移后仍可用"可能只是"旧路径还在"）
    expect(existsSync(parent.dataDir)).toBe(false);
    expect(existsSync(join(movedDir, WORKSPACE_BLOBS_DIR_NAME))).toBe(true);

    // ── "无需原绝对路径"的直接证据：trace 文本里没有任何绝对路径 ────────────────────────
    const movedTrace = workspaceTraceFile(movedDir, parent.runId);
    const text = readFileSync(movedTrace, "utf8");
    expect(text).not.toContain(parent.dataDir);
    expect(text).not.toContain(parent.source);
    expect(text).not.toContain(movedDir);

    // ── 解析与附件读取 ────────────────────────────────────────────────────────────────
    const record = readRun(movedTrace);
    expect(record.meta.id).toBe(parent.runId);
    const firstStep = stepsOf(record)[0];
    expect(await readText(movedDir, parent.runId, firstStep?.id, "a.txt")).toBe(MIDDLE);
    expect(await readText(movedDir, parent.runId, firstStep?.id, "b.txt")).toBe(SIBLING);

    // ── 预检（重新建立 store/读取器）──────────────────────────────────────────────────
    const atSpanId = record.spans.find((span) => span.kind === "tool.invoke")?.id ?? "";
    const capability = await preflightIsolatedReplay({
      dataDir: movedDir,
      parentId: parent.runId,
      atSpanId,
      edit: { field: "result", value: "迁移后编辑" },
      config: makeConfig(),
    });
    expect(capability.ok).toBe(true);

    // ── 合法续跑：子 run 落在**新目录**，父文件与源目录都不变 ───────────────────────────
    const sourceBefore = treeFingerprint(parent.source);
    const childLlm = new ScriptedLlm([
      { toolCalls: [readCall("r1", "a.txt")] },
      { content: "done" },
    ]);
    const result = await replayIsolatedRun({
      dataDir: movedDir,
      parentId: parent.runId,
      atSpanId,
      edit: { field: "result", value: "迁移后编辑" },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(childLlm),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(existsSync(workspaceTraceFile(movedDir, result.id))).toBe(true);
    expect(readdirSync(join(movedDir, WORKSPACE_TRACES_DIR_NAME)).sort()).toEqual(
      [parent.runId, result.id].map((id) => `${id}.jsonl`).sort(),
    );
    // 子读到的仍是那一轮的中间态（迁移没有改变任何语义）
    const child = readRun(workspaceTraceFile(movedDir, result.id));
    const childTool = child.spans.find((span) => span.kind === "tool.invoke");
    expect(childTool === undefined ? null : String(childTool.result)).toBe(MIDDLE);
    expect(treeFingerprint(parent.source)).toEqual(sourceBefore);
  });
});

describe("7.2 附件不可用仍能看轨迹", () => {
  it("删掉附件目录：轨迹完整可读，附件读取与续跑分别报告不可用，且不改写 trace", async () => {
    const parent = await createThreeRoundParent();
    const traceHashBefore = sha256OfFile(parent.traceFile);
    const tracesBefore = readdirSync(join(parent.dataDir, WORKSPACE_TRACES_DIR_NAME)).sort();
    rmSync(join(parent.dataDir, WORKSPACE_BLOBS_DIR_NAME), { recursive: true, force: true });

    // ── 1) 普通 trace 解析不加载附件：完整消息与步骤照旧返回 ─────────────────────────────
    const record = readRun(parent.traceFile);
    expect(record.meta.format_version).toBe(2);
    expect(record.meta.workspace?.profile).toBe("file-tools-v1");
    expect(llmCalls(record)).toHaveLength(3);
    expect(stepsOf(record)).toHaveLength(3);
    // 检查点元数据（路径/哈希/字节数）仍在，只是字节取不到
    expect(
      stepsOf(record)
        .at(-1)
        ?.workspace_snapshot?.files.map((file) => file.path),
    ).toEqual(["a.txt", "b.txt", "keep.txt"]);

    // ── 2) 包附件读取报告 missing（可辨认，不是抛错）───────────────────────────────────
    const read = await readWorkspaceFile({
      dataDir: parent.dataDir,
      runId: parent.runId,
      path: "a.txt",
    });
    expect(read.status).toBe("missing");

    // ── 3) 真实续跑报告不可用：预检拒绝 + 编排拒绝，零 LLM、零子 trace ─────────────────
    const atSpanId = record.spans.find((span) => span.kind === "tool.invoke")?.id ?? "";
    const capability = await preflightIsolatedReplay({
      dataDir: parent.dataDir,
      parentId: parent.runId,
      atSpanId,
      edit: { field: "result", value: "附件没了还想分叉" },
      config: makeConfig(),
    });
    expect(capability.ok).toBe(false);
    if (!capability.ok) {
      expect(capability.failure.code).toBe("attachment_missing");
    }

    const llm = new ScriptedLlm([{ content: "不该被调用" }]);
    const replay = await replayIsolatedRun({
      dataDir: parent.dataDir,
      parentId: parent.runId,
      atSpanId,
      edit: { field: "result", value: "附件没了还想分叉" },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.failure.code).toBe("attachment_missing");
    }
    expect(llm.requests).toHaveLength(0);

    // ── 4) 不能改写 trace 补数据：trace 字节与 traces 目录清单都不变 ─────────────────────
    expect(sha256OfFile(parent.traceFile)).toBe(traceHashBefore);
    expect(readdirSync(join(parent.dataDir, WORKSPACE_TRACES_DIR_NAME)).sort()).toEqual(
      tracesBefore,
    );
  });
});

/** 迁移之后子分支照常写文件：新附件发布在新位置的存储里 */
describe("7.2 迁移后的隔离写入仍落在新目录", () => {
  it("迁移 + 子写文件：新附件发布在新目录，源与旧位置都不受影响", async () => {
    const parent = await createThreeRoundParent();
    const movedDir = join(makeTempDir("pkg-moved-write-"), "data");
    renameSync(parent.dataDir, movedDir);
    const sourceBefore = treeFingerprint(parent.source);
    const blobsBefore = readdirSync(join(movedDir, WORKSPACE_BLOBS_DIR_NAME, "sha256")).sort();

    const result = await forkFromParent(
      { ...parent, dataDir: movedDir, traceFile: workspaceTraceFile(movedDir, parent.runId) },
      {
        llm: new ScriptedLlm([
          { toolCalls: [readCall("r1", "a.txt")] },
          { toolCalls: [writeCall("w1", "a.txt", CHILD)] },
          { toolCalls: [readCall("r2", "a.txt")] },
          { content: "done" },
        ]),
        editValue: "迁移后写文件",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const child = readRun(workspaceTraceFile(movedDir, result.id));
    const childTools = child.spans.filter((span) => span.kind === "tool.invoke");
    // 读出 middle → 写入 child → 再读回 child：发布与映射都在新位置生效
    expect(String(childTools[0]?.result)).toBe(MIDDLE);
    expect(String(childTools[2]?.result)).toBe(CHILD);
    expect(readdirSync(join(movedDir, WORKSPACE_BLOBS_DIR_NAME, "sha256"))).toContain(
      sha256OfText(CHILD),
    );
    expect(readdirSync(join(movedDir, WORKSPACE_BLOBS_DIR_NAME, "sha256")).length).toBe(
      blobsBefore.length + 1,
    );
    expect(treeFingerprint(parent.source)).toEqual(sourceBefore);
    expect(existsSync(parent.dataDir)).toBe(false);
  });
});
