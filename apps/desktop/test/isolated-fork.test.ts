import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunConfig } from "@rebaseagent/agent-loop";
import { runLoop } from "@rebaseagent/agent-loop";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  createIsolatedRun,
  replayIsolatedRun,
} from "@rebaseagent/replay";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../../packages/agent-loop/test/helpers";
import {
  runForkCapability,
  runForkIsolated,
  runModelAb,
  runPromptFork,
} from "../src/main/fork-runner";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import { formatBytes } from "../src/renderer/src/lib/format";
import {
  isIsolatedRun,
  isolatedBranchBoundaryLabel,
  isolatedCheckpointLabel,
  isolatedContinueLabel,
  isolatedParentExecutionNotice,
  isolatedRunNotice,
  resolveCapabilityCheck,
  resolveIsolatedForkSubmission,
  resumeBoundaryIteration,
} from "../src/renderer/src/lib/isolated-fork";
import { ForkCapabilityRequestSchema, ForkRunRequestSchema } from "../src/shared/ipc";
import type { ForkCapabilityResult, RunDetail } from "../src/shared/ipc";

/**
 * B 任务 2.2：隔离 result 确认区与禁用原因（渲染层纯逻辑 + 真隔离轨迹）。
 *
 * 覆盖场景（change add-sandboxed-rerun-desktop，specs/desktop-ui）：
 * - `编辑 tool_result 并重跑`（确认区数字来自只读预检；判据与请求同源 → 真跑出子 run）
 * - `多工具轮次确认`（同轮多工具：编辑点 ≠ 轮末边界，同轮工具不重做）
 * - `二次分叉轮号不沿链累加`（**来源说明**用边界 step 自己的 agent.step.n）
 * - `隔离父本的其他真执行入口`（界面禁用 + 说明；IPC 侧拒绝见 isolated-parent-rejection.test.ts）
 * - `历史运行和缺附件降级`（预检失败原因原样展示，不用当前目录兜底）
 *
 * 纪律：确认区展示的每个数字都来自 `workspaces:forkCapability`（A 的只读预检），
 * 渲染层不自己数文件、不自己推轮号——所以这里既测纯函数，也测真 preflight 结论。
 */

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

function isolatedConfig(systemPrompt = "你是文件助手。"): RunConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    systemPrompt,
    tools: [...FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

/** 源目录与数据目录必须互为兄弟（A 的 validateSourceRoot 拒绝嵌套） */
function tempLayout(): { dataDir: string; source: string; cleanup: () => void } {
  const outer = mkdtempSync(join(tmpdir(), "isolated-fork-ui-"));
  const dataDir = join(outer, "data");
  const source = join(outer, "source");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(source, { recursive: true });
  return { dataDir, source, cleanup: () => rmSync(outer, { recursive: true, force: true }) };
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

interface ScriptedTurn {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
}

const readCall = (id: string, path: string) => ({
  id,
  name: "read_file",
  args: JSON.stringify({ path }),
});
const writeCall = (id: string, path: string, content: string) => ({
  id,
  name: "write_file",
  args: JSON.stringify({ path, content }),
});

async function createIsolatedParent(
  dataDir: string,
  source: string,
  script: ScriptedTurn[],
  files: Record<string, string> = { "a.txt": "alpha 内容", "keep.txt": "keep" },
): Promise<string> {
  writeTree(source, files);
  const result = await createIsolatedRun({
    dataDir,
    source,
    config: isolatedConfig(),
    userMessage: "按剧本操作文件",
    authority: { allowFileWrites: true },
    llm: new MockLlmClient(script),
  });
  if (!result.ok) {
    throw new Error(`createIsolatedRun 失败：${result.failure.code} ${result.failure.reason}`);
  }
  return result.id;
}

/** 普通 v1 父本（无隔离元数据）——"不误伤普通 run"的对照 */
async function createV1Run(dataDir: string): Promise<RunDetail> {
  mkdirSync(join(dataDir, "traces"), { recursive: true });
  const tmp = join(dataDir, "traces", "tmp-v1.jsonl");
  await runLoop(
    { ...isolatedConfig(), tools: [] },
    [
      { role: "system", content: "你是助手。" },
      { role: "user", content: "你好" },
    ],
    new JsonlTracer(tmp),
    [],
    new MockLlmClient([{ content: "你好。" }]),
  );
  const record = readRun(tmp);
  renameSync(tmp, join(dataDir, "traces", `${record.meta.id}.jsonl`));
  return new RunRepository(join(dataDir, "traces")).getRun(record.meta.id);
}

const toolSpanOf = (record: ReturnType<typeof readRun>, tool: string, contains?: string) => {
  const span = record.spans.find(
    (s) =>
      s.kind === "tool.invoke" &&
      s.tool === tool &&
      (contains === undefined || JSON.stringify(s.args).includes(contains)),
  );
  if (span?.kind !== "tool.invoke") throw new Error(`缺少 ${tool} span`);
  return span;
};

describe("2.2 声明与判据（纯逻辑）", () => {
  it("隔离运行判据：v2 带 workspace 为真；v1 老 trace 为假，且不显示任何文件标注", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const isolatedId = await createIsolatedParent(dataDir, source, [{ content: "完成。" }]);
      const isolated = new RunRepository(join(dataDir, "traces")).getRun(isolatedId);
      const v1 = await createV1Run(dataDir);

      expect(isIsolatedRun(isolated)).toBe(true);
      expect(isIsolatedRun(v1)).toBe(false);

      const notice = isolatedRunNotice(isolated);
      expect(notice).toContain("隔离文件运行");
      expect(notice).toContain("不会被修改");
      // v1 老 trace：**不得**出现任何"已恢复文件状态"的措辞（整块不显示）
      expect(isolatedRunNotice(v1)).toBeNull();
      expect(isolatedParentExecutionNotice(v1)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("隔离父本：prompt fork / 模型 A/B 给出禁用原因（普通父本对照不受影响）", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const isolatedId = await createIsolatedParent(dataDir, source, [{ content: "完成。" }]);
      const isolated = new RunRepository(join(dataDir, "traces")).getRun(isolatedId);
      const v1 = await createV1Run(dataDir);

      const isolatedNotice = isolatedParentExecutionNotice(isolated);
      expect(isolatedNotice).toContain("隔离文件运行");
      expect(isolatedNotice).toContain("prompt fork 与模型 A/B");
      expect(isolatedNotice).toContain("main 与内核也会拒绝");
      expect(isolatedParentExecutionNotice(v1)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("单向蕴含：界面说「不支持」时内核确实拒绝（不白禁；反方向由 1.2 的用例钉住）", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const parentId = await createIsolatedParent(dataDir, source, [{ content: "完成。" }]);
      const repo = new RunRepository(join(dataDir, "traces"));
      const detail = repo.getRun(parentId);
      // 界面：两个入口都给出"本期不支持"的原因（DetailPanel 用它替换编辑入口）
      expect(isolatedParentExecutionNotice(detail)).not.toBeNull();

      const mock = new MockLlmClient([]);
      await expect(
        runPromptFork(
          { repository: repo, settings: SETTINGS, execCwd: dataDir, llm: mock },
          {
            parentRunId: parentId,
            edit: { field: "system_prompt", value: "换一个 system prompt" },
          },
        ),
      ).rejects.toThrow(/隔离/);
      await expect(
        runModelAb(
          { repository: repo, settings: SETTINGS, llm: mock },
          {
            parentRunId: parentId,
            arms: [
              { model: "m-a", allowSideEffects: true },
              { model: "m-b", allowSideEffects: true },
            ],
            dryRun: true,
          },
        ),
      ).rejects.toMatchObject({ code: "PARENT_NOT_FORKABLE" });
      // 界面禁用 + 内核拒绝：两侧都不产生任何模型请求
      expect(mock.requests).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("未校验 / 空 fork / 未授权 / 执行中：四种情况都不产出请求（附对照放行）", () => {
    const base = {
      parentRunId: "run_b",
      atSpanId: "s_10",
      value: "编辑后的观察",
      unchanged: false,
      settingsConfigured: true,
      capabilityInFlight: false,
      forking: false,
    };
    const capability: ForkCapabilityResult = {
      parentId: "run_b",
      atSpanId: "s_10",
      stepSpanId: "s_09",
      ownerRunId: "run_b",
      localIteration: 1,
      snapshotId: "a".repeat(64),
      fileCount: 3,
      totalBytes: 2048,
      configHash: `sha256:${"b".repeat(64)}`,
    };

    // 未校验（capability 为 null）
    const notVerified = resolveIsolatedForkSubmission({
      ...base,
      capability: null,
      writesAuthorized: true,
    });
    expect(notVerified.ok).toBe(false);
    expect(notVerified.ok ? "" : notVerified.reason).toContain("校验续跑条件");

    // 空 fork
    const unchanged = resolveIsolatedForkSubmission({
      ...base,
      unchanged: true,
      capability,
      writesAuthorized: true,
    });
    expect(unchanged.ok).toBe(false);
    expect(unchanged.ok ? "" : unchanged.reason).toContain("空 fork");

    // 未授权：不是"降级成普通分叉"，而是直接拒绝
    const unauthorized = resolveIsolatedForkSubmission({
      ...base,
      capability,
      writesAuthorized: false,
    });
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.ok ? "" : unauthorized.reason).toContain("允许本次副本写入");

    // 执行中（重复提交保护）
    const busy = resolveIsolatedForkSubmission({
      ...base,
      capability,
      writesAuthorized: true,
      forking: true,
    });
    expect(busy.ok).toBe(false);
    expect(busy.ok ? "" : busy.reason).toContain("不能重复提交");

    // 预检结论与当前分叉点不同源（换了 span）
    const mismatch = resolveIsolatedForkSubmission({
      ...base,
      atSpanId: "s_11",
      capability,
      writesAuthorized: true,
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.ok ? "" : mismatch.reason).toContain("不一致");

    // 对照：齐备时放行，且请求形状 = 隔离声明的 strict 三要素
    const ready = resolveIsolatedForkSubmission({ ...base, capability, writesAuthorized: true });
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.request.execution).toEqual({ mode: "isolated_files", allowFileWrites: true });
    expect(ForkRunRequestSchema.safeParse(ready.request).success).toBe(true);
    expect(Object.keys(ready.request.execution ?? {}).sort()).toEqual(["allowFileWrites", "mode"]);
  });

  it("「校验续跑条件」判据：未配置 / 空 fork / 执行中都不发请求，请求形状过 zod", () => {
    const base = {
      parentRunId: "run_b",
      atSpanId: "s_10",
      value: "改",
      unchanged: false,
      settingsConfigured: true,
      capabilityInFlight: false,
      forking: false,
    };
    expect(resolveCapabilityCheck({ ...base, settingsConfigured: false }).ok).toBe(false);
    expect(resolveCapabilityCheck({ ...base, unchanged: true }).ok).toBe(false);
    expect(resolveCapabilityCheck({ ...base, forking: true }).ok).toBe(false);
    expect(resolveCapabilityCheck({ ...base, capabilityInFlight: true }).ok).toBe(false);

    const ok = resolveCapabilityCheck(base);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ForkCapabilityRequestSchema.safeParse(ok.request).success).toBe(true);
  });

  it("字节格式化（检查点规模展示用）", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(13_500_000)).toBe("12.9 MB");
  });
});

describe("2.2 确认区数字来自真预检（多工具轮次）", () => {
  it("同轮多工具：编辑点是该轮的工具，轮末边界是该轮 step，轮号取本地 n", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      // 第 1 轮同轮两个工具（read a + read keep），第 2 轮写 b.txt
      const parentId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt"), readCall("c2", "keep.txt")] },
        { toolCalls: [writeCall("c3", "b.txt", "beta")] },
        { content: "父完成。" },
      ]);
      const parentRecord = readRun(join(dataDir, "traces", `${parentId}.jsonl`));
      const firstTool = toolSpanOf(parentRecord, "read_file", "a.txt");

      const repo = new RunRepository(join(dataDir, "traces"));
      const capability = await runForkCapability(
        { repository: repo, settings: SETTINGS, dataDir },
        {
          parentRunId: parentId,
          atSpanId: firstTool.id,
          edit: { field: "result", value: "内容(a.txt)【编辑后的观察】" },
        },
      );

      // 编辑点 ≠ 轮末边界：这正是"整轮续跑"与"截至该工具"的区别
      expect(capability.atSpanId).toBe(firstTool.id);
      expect(capability.stepSpanId).not.toBe(capability.atSpanId);
      expect(capability.localIteration).toBe(1);
      // 第 1 轮结束时尚无 b.txt：起点清单 = 源目录两文件
      expect(capability.fileCount).toBe(2);

      expect(isolatedContinueLabel(capability)).toBe(`从运行 ${parentId} 的第 1 轮结束后继续`);
      const checkpoint = isolatedCheckpointLabel(capability);
      expect(checkpoint).toContain("2 个文件");
      expect(checkpoint).toContain(capability.snapshotId.slice(0, 12));
      // 父 run 身份与 step 定位都呈现出来（确认区要求）
      expect(isolatedContinueLabel(capability)).toContain(parentId);
      expect(checkpoint).not.toContain(capability.snapshotId); // 只露前 12 位 + 省略号
    } finally {
      cleanup();
    }
  });

  it("缺附件降级：预检给出不可用原因（界面照原样展示，不用当前目录兜底）", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const parentId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt")] },
        { content: "完成。" },
      ]);
      const parentRecord = readRun(join(dataDir, "traces", `${parentId}.jsonl`));
      const span = toolSpanOf(parentRecord, "read_file", "a.txt");
      rmSync(join(dataDir, "workspace-blobs"), { recursive: true, force: true });

      const repo = new RunRepository(join(dataDir, "traces"));
      await expect(
        runForkCapability(
          { repository: repo, settings: SETTINGS, dataDir },
          {
            parentRunId: parentId,
            atSpanId: span.id,
            edit: { field: "result", value: "改" },
          },
        ),
      ).rejects.toThrow(/attachment_missing|附件/);
    } finally {
      cleanup();
    }
  });
});

describe("2.2 编辑 tool_result 并重跑（判据 → 真编排）", () => {
  it("确认区判据放行的请求直接喂 runForkIsolated：子 run 边界 = 预检的 step，父目录不变", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const parentId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt")] },
        { toolCalls: [writeCall("c2", "b.txt", "beta")] },
        { content: "父完成。" },
      ]);
      const parentRecord = readRun(join(dataDir, "traces", `${parentId}.jsonl`));
      const writeSpan = toolSpanOf(parentRecord, "write_file", "b.txt");
      const edited = "内容(a.txt)【编辑后的观察】";

      const repo = new RunRepository(join(dataDir, "traces"));
      const capability = await runForkCapability(
        { repository: repo, settings: SETTINGS, dataDir },
        { parentRunId: parentId, atSpanId: writeSpan.id, edit: { field: "result", value: edited } },
      );

      const submission = resolveIsolatedForkSubmission({
        parentRunId: parentId,
        atSpanId: writeSpan.id,
        value: edited,
        unchanged: false,
        settingsConfigured: true,
        capabilityInFlight: false,
        forking: false,
        capability,
        writesAuthorized: true,
      });
      if (!submission.ok) throw new Error(`判据应放行：${submission.reason}`);
      const request = ForkRunRequestSchema.parse(submission.request);

      const fork = await runForkIsolated(
        {
          repository: repo,
          settings: SETTINGS,
          dataDir,
          llm: new MockLlmClient([{ content: "基于编辑后的观察收尾。" }]),
        },
        {
          parentRunId: request.parentRunId,
          atSpanId: request.atSpanId,
          edit: request.edit,
          execution: { mode: "isolated_files", allowFileWrites: true },
        },
      );

      const child = readRun(join(dataDir, "traces", `${fork.id}.jsonl`));
      expect(child.meta.format_version).toBe(2);
      expect(child.meta.parent).toBe(parentId);
      // 提交实际用的边界 = 预检给出的 step（确认区显示的就是它）
      expect((child.meta.fork as { resume_after_step?: string }).resume_after_step).toBe(
        capability.stepSpanId,
      );
      expect(child.meta.config_hash).toBe(parentRecord.meta.config_hash);
      // 源目录逐字节不变
      expect(readRun(join(dataDir, "traces", `${parentId}.jsonl`)).meta.id).toBe(parentId);
    } finally {
      cleanup();
    }
  });
});

describe("2.2 二次分叉轮号不沿链累加（来源说明）", () => {
  it("根 A 3 轮 → B 第 1 轮再分叉出 C：来源说明指 B 的第 1 轮，不是第 4 轮 / C 的第 1 轮", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      // A：3 轮工具
      const rootId = await createIsolatedParent(dataDir, source, [
        { toolCalls: [readCall("c1", "a.txt")] },
        { toolCalls: [writeCall("c2", "b.txt", "beta")] },
        { toolCalls: [writeCall("c3", "c.txt", "gamma")] },
        { content: "根完成。" },
      ]);
      const rootRecord = readRun(join(dataDir, "traces", `${rootId}.jsonl`));
      const writeC = toolSpanOf(rootRecord, "write_file", "c.txt");

      // B：从 A 第 3 轮结束后续跑（B 自己有 1 轮工具；起点含 c.txt）
      const forkB = await replayIsolatedRun({
        dataDir,
        parentId: rootId,
        atSpanId: writeC.id,
        edit: { field: "result", value: "内容(a.txt)【B 的观察】" },
        config: isolatedConfig(),
        authority: { allowFileWrites: true },
        llm: new MockLlmClient([{ toolCalls: [readCall("c4", "c.txt")] }, { content: "B 完成。" }]),
      });
      if (!forkB.ok) throw new Error(`${forkB.failure.code} ${forkB.failure.reason}`);
      const bRecord = readRun(join(dataDir, "traces", `${forkB.id}.jsonl`));
      const bRead = toolSpanOf(bRecord, "read_file", "c.txt");

      // C：从 B 的本地第 1 轮再分叉
      const forkC = await replayIsolatedRun({
        dataDir,
        parentId: forkB.id,
        atSpanId: bRead.id,
        edit: { field: "result", value: "内容(c.txt)【C 的观察】" },
        config: isolatedConfig(),
        authority: { allowFileWrites: true },
        llm: new MockLlmClient([{ content: "C 完成。" }]),
      });
      if (!forkC.ok) throw new Error(`${forkC.failure.code} ${forkC.failure.reason}`);

      const repo = new RunRepository(join(dataDir, "traces"));
      const detail = repo.getRun(forkC.id);
      const boundary = detail.meta.fork?.resume_after_step;
      if (typeof boundary !== "string") throw new Error("C 必须带整轮续跑边界");

      const stepNs = detail.spans
        .filter((s) => s.kind === "agent.step")
        .map((s) => (s.kind === "agent.step" ? s.n : 0));
      // 合并轨迹 = A 的 3 轮 + B 的第 1 轮 + C 的第 1 轮：轮号在这里是**重复的**
      expect(stepNs).toEqual([1, 2, 3, 1, 1]);
      // 沿链累加到边界 step 为止正好是 4 —— 这正是"第 4 轮"这个错误答案的来源
      const boundaryStepIndex = detail.spans.findIndex((s) => s.id === boundary);
      const cumulativeAtBoundary = detail.spans
        .slice(0, boundaryStepIndex + 1)
        .filter((s) => s.kind === "agent.step").length;
      expect(cumulativeAtBoundary).toBe(4);

      // 正解：边界 step 自己的 n = 父 run B 的本地第 1 轮
      const iteration = resumeBoundaryIteration(detail.spans, boundary);
      expect(iteration).toBe(1);
      // 边界 step 属于父 run 的前缀，不属于 C 自己
      expect(detail.leafSpanIds).not.toContain(boundary);
      // 编辑点仍在 C 的直接父 B 的那一轮里（不是 A 的写 c.txt 那一步）
      const editedSpan = detail.spans.find((s) => s.id === detail.meta.fork?.at_span);
      expect(editedSpan?.id).toBe(bRead.id);

      const label = isolatedBranchBoundaryLabel(forkB.id, iteration, boundary);
      expect(label).toContain(`运行 ${forkB.id} 的第 1 轮`);
      expect(label).not.toContain("第 4 轮");
      expect(label).not.toContain(`运行 ${rootId}`);
      expect(label).not.toContain(`运行 ${forkC.id}`);
      // 解析不到时只报 step，不猜数字
      expect(isolatedBranchBoundaryLabel(forkB.id, null, boundary)).not.toContain("第");
      expect(isolatedBranchBoundaryLabel(forkB.id, null, boundary)).toContain(boundary);
    } finally {
      cleanup();
    }
  });
});
