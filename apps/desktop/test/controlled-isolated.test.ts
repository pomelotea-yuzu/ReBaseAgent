import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  runForkCapability,
  runForkIsolated,
  runModelAb,
  runPromptFork,
} from "../src/main/fork-runner";
import { runCreateIsolated } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import { resumeBoundaryIteration } from "../src/renderer/src/lib/isolated-fork";
import { withMockLlm } from "./helpers/mock-llm-harness";

/**
 * U1（refactor-run-workspace）任务 6.5：在受控模型服务上回归隔离创建 / 隔离 result 续跑 / 只读预检。
 *
 * 判据来源：tasks.md 6.5——「在受控服务上回归隔离创建/result 及只读预检；验证『旧创建设置及执行
 * 入口保持可达』『来源和隔离边界保持真实』，记录每次授权、多工具轮末及二次分叉，隔离 prompt/A-B
 * 仍拒绝」。
 *
 * 与 6.4 同手法：入口**都不注入 llm**，让入口自行 new 真实 `OpenAiCompatClient`（baseURL 指向受控
 * 服务），用受控服务请求日志钉「格式/次数/顺序」。隔离父本也经受控服务现造（`createIsolatedRun`
 * 的受控 read_file/write_file 在隔离工作区内真实执行，模型只负责发 tool_calls）。
 */

const SYS = "你是文件助手。";
const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

/** 隔离创建的授权声明（zod 保证 allowFileWrites 恒 true；A 层会再验一次） */
const WORKSPACE = {
  mode: "isolated_files" as const,
  sourceToken: "t",
  allowFileWrites: true as const,
};
/** 隔离续跑的强制执行模式（mode/allowFileWrites 双真值缺一不可） */
const EXECUTION = { mode: "isolated_files" as const, allowFileWrites: true as const };

function tempLayout(): { dataDir: string; source: string; cleanup: () => void } {
  const outer = mkdtempSync(join(tmpdir(), "controlled-isolated-"));
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

/** 整个目录树的指纹（相对路径 + 内容哈希）——"源目录逐字节不变/隔离边界真实"的判据 */
function treeFingerprint(dir: string): string {
  const acc: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
        continue;
      }
      acc.push(`${rel} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return acc.join("\n");
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

// ---------------------------------------------------------------------------
// 1. 隔离创建（runs:create workspace 分支）
// ---------------------------------------------------------------------------

describe("6.5 受控服务回归：隔离创建（runCreateIsolated）", () => {
  it("按剧本在受控服务上恰两次提交：v2 隔离根 run 进概览、授权被记录、源目录逐字节不变", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      writeTree(source, { "a.txt": "alpha", "keep.txt": "keep" });
      const before = treeFingerprint(source);
      const repo = new RunRepository(join(dataDir, "traces"));

      await withMockLlm(
        { turns: [{ toolCalls: [readCall("c1", "a.txt")] }, { content: "完成。" }] },
        async (h) => {
          const { id } = await runCreateIsolated(
            {
              repository: repo,
              settings: { ...SETTINGS, baseURL: h.baseURL },
              execCwd: dataDir,
              dataDir,
              sourcePath: source,
            },
            { systemPrompt: SYS, userMessage: "读一下 a.txt", workspace: WORKSPACE },
          );

          // 一次受控提交序列：工具轮 + 收尾轮，格式正确
          const entries = h.entries();
          expect(h.served()).toBe(2);
          expect(entries).toHaveLength(2);
          expect(
            entries.every((e) => e.stream && e.mode === "sse" && e.path === "/v1/chat/completions"),
          ).toBe(true);
          // 隔离 profile 恒为 read_file/write_file；回合按剧本 FIFO
          expect(entries[0]?.tools).toEqual(["read_file", "write_file"]);
          expect(entries[0]?.turn).toEqual({ toolCalls: ["read_file"] });
          expect(entries[1]?.turn).toEqual({ content: "完成。" });

          // 结果进入概览：v2 隔离根 run，授权（world_id）被记录
          const record = repo.loadRunRecord(id);
          expect(record.meta.format_version).toBe(2);
          expect(record.meta.workspace?.world_id).toBe(id);
          expect(record.meta.config_hash).toMatch(/^sha256:/);
          expect(record.meta.budget).toEqual({ max_total_tokens: 100_000 });
          expect(record.status).toBe("completed");
          expect(repo.listRuns().runs.map((r) => r.id)).toContain(id);

          // 隔离边界真实：源目录不被修改（写入只落在隔离工作区副本）
          expect(treeFingerprint(source)).toBe(before);
        },
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 多工具轮末：只读预检（零请求）+ 隔离 result 续跑
// ---------------------------------------------------------------------------

describe("6.5 受控服务回归：隔离只读预检 + result 续跑（多工具轮末）", () => {
  it("预检零模型请求；续跑恰一次提交、resume_after_step=轮末 step、源目录不变", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      writeTree(source, { "a.txt": "alpha", "keep.txt": "keep" });
      const before = treeFingerprint(source);
      const repo = new RunRepository(join(dataDir, "traces"));

      // 父：第 1 轮同轮两工具（read a + read keep），第 2 轮写 b.txt，第 3 轮收尾
      const combined = [
        { toolCalls: [readCall("c1", "a.txt"), readCall("c2", "keep.txt")] },
        { toolCalls: [writeCall("c3", "b.txt", "beta")] },
        { content: "父完成。" },
        { content: "基于编辑后的观察收尾。" }, // 续跑一次提交
      ];
      await withMockLlm({ turns: combined }, async (h) => {
        const parent = await runCreateIsolated(
          {
            repository: repo,
            settings: { ...SETTINGS, baseURL: h.baseURL },
            execCwd: dataDir,
            dataDir,
            sourcePath: source,
          },
          { systemPrompt: SYS, userMessage: "按剧本操作文件", workspace: WORKSPACE },
        );
        const parentId = parent.id;
        expect(h.served()).toBe(3);
        const parentRecord = repo.loadRunRecord(parentId);
        // 编辑点是第 1 轮的一个工具（不是轮末边界）
        const firstTool = toolSpanOf(parentRecord, "read_file", "a.txt");
        const edited = "alpha【编辑后的观察】";

        // 只读预检：零模型请求（确认区数字来源）
        const capability = await runForkCapability(
          { repository: repo, settings: { ...SETTINGS, baseURL: h.baseURL }, dataDir },
          {
            parentRunId: parentId,
            atSpanId: firstTool.id,
            edit: { field: "result", value: edited },
          },
        );
        expect(h.served()).toBe(3); // 预检不请求模型
        expect(capability.atSpanId).toBe(firstTool.id);
        expect(capability.stepSpanId).not.toBe(capability.atSpanId); // 编辑点 ≠ 轮末边界
        expect(capability.localIteration).toBe(1);
        expect(capability.fileCount).toBe(2); // 第 1 轮末：源目录两文件

        // 隔离 result 续跑：恰一次提交，执行授权（EXECUTION）被使用
        const fork = await runForkIsolated(
          { repository: repo, settings: { ...SETTINGS, baseURL: h.baseURL }, dataDir },
          {
            parentRunId: parentId,
            atSpanId: firstTool.id,
            edit: { field: "result", value: edited },
            execution: EXECUTION,
          },
        );
        expect(h.served()).toBe(4);
        const forkEntry = h.entries()[3];
        expect(forkEntry?.stream).toBe(true);
        expect(forkEntry?.tools).toEqual(["read_file", "write_file"]);

        const child = repo.loadRunRecord(fork.id);
        expect(child.meta.format_version).toBe(2);
        expect(child.meta.parent).toBe(parentId);
        // 提交实际用的边界 = 预检给出的轮末 step
        expect((child.meta.fork as { resume_after_step?: string }).resume_after_step).toBe(
          capability.stepSpanId,
        );
        expect(child.meta.config_hash).toBe(parentRecord.meta.config_hash);
        expect(child.meta.budget).toEqual({ max_total_tokens: 100_000 });
        expect(child.status).toBe("completed");
        expect(repo.listRuns().runs.map((r) => r.id)).toContain(fork.id);

        expect(treeFingerprint(source)).toBe(before);
      });
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 二次分叉：A → B → C（来源边界不沿链累加）
// ---------------------------------------------------------------------------

describe("6.5 受控服务回归：隔离二次分叉", () => {
  it("A→B→C 各按剧本提交：C 的续跑边界指向 B 本地第 1 轮，源目录不变", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      writeTree(source, { "a.txt": "alpha", "keep.txt": "keep" });
      const before = treeFingerprint(source);
      const repo = new RunRepository(join(dataDir, "traces"));

      const combined = [
        { toolCalls: [readCall("c1", "a.txt")] }, // A 轮 1
        { content: "A 完成。" }, // A 轮 2
        { toolCalls: [readCall("c2", "keep.txt")] }, // B 本地轮 1
        { content: "B 完成。" }, // B 轮 2
        { content: "C 完成。" }, // C 单轮
      ];
      await withMockLlm({ turns: combined }, async (h) => {
        const A = await runCreateIsolated(
          {
            repository: repo,
            settings: { ...SETTINGS, baseURL: h.baseURL },
            execCwd: dataDir,
            dataDir,
            sourcePath: source,
          },
          { systemPrompt: SYS, userMessage: "按剧本操作文件", workspace: WORKSPACE },
        );
        const aRec = repo.loadRunRecord(A.id);
        const aRead = toolSpanOf(aRec, "read_file", "a.txt");
        expect(h.served()).toBe(2);

        const B = await runForkIsolated(
          { repository: repo, settings: { ...SETTINGS, baseURL: h.baseURL }, dataDir },
          {
            parentRunId: A.id,
            atSpanId: aRead.id,
            edit: { field: "result", value: "alpha【B 观察】" },
            execution: EXECUTION,
          },
        );
        const bRec = repo.loadRunRecord(B.id);
        const bRead = toolSpanOf(bRec, "read_file", "keep.txt");
        expect(h.served()).toBe(4);

        const C = await runForkIsolated(
          { repository: repo, settings: { ...SETTINGS, baseURL: h.baseURL }, dataDir },
          {
            parentRunId: B.id,
            atSpanId: bRead.id,
            edit: { field: "result", value: "keep【C 观察】" },
            execution: EXECUTION,
          },
        );
        expect(h.served()).toBe(5);

        const cDetail = repo.getRun(C.id);
        expect(cDetail.meta.format_version).toBe(2);
        expect(cDetail.meta.parent).toBe(B.id);
        const boundary = cDetail.meta.fork?.resume_after_step;
        if (typeof boundary !== "string") throw new Error("C 必须带整轮续跑边界");
        // 边界是 B 的本地第 1 轮（轮号不沿链累加）
        expect(resumeBoundaryIteration(cDetail.spans, boundary)).toBe(1);
        expect(cDetail.status).toBe("completed");
        // 列表收录 A/B/C 三层（fresh 目录恰好三个）
        const listed = repo.listRuns().runs.map((r) => r.id);
        expect(listed).toHaveLength(3);
        expect(listed).toEqual(expect.arrayContaining([A.id, B.id, C.id]));

        expect(treeFingerprint(source)).toBe(before);
      });
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 隔离 prompt/A-B 仍拒绝（受控服务零请求）
// ---------------------------------------------------------------------------

describe("6.5 受控服务回归：隔离 prompt/A-B 拒绝", () => {
  it("隔离父本上 prompt fork / 模型 A-B 经受控服务仍拒绝，且零模型请求", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      writeTree(source, { "a.txt": "alpha" });
      const repo = new RunRepository(join(dataDir, "traces"));

      await withMockLlm(
        { turns: [{ toolCalls: [readCall("c1", "a.txt")] }, { content: "完成。" }] },
        async (h) => {
          const parent = await runCreateIsolated(
            {
              repository: repo,
              settings: { ...SETTINGS, baseURL: h.baseURL },
              execCwd: dataDir,
              dataDir,
              sourcePath: source,
            },
            { systemPrompt: SYS, userMessage: "按剧本操作文件", workspace: WORKSPACE },
          );
          const parentId = parent.id;
          expect(h.served()).toBe(2);

          await expect(
            runPromptFork(
              { repository: repo, settings: { ...SETTINGS, baseURL: h.baseURL }, execCwd: dataDir },
              {
                parentRunId: parentId,
                edit: { field: "system_prompt", value: "换一个 system prompt" },
              },
            ),
          ).rejects.toThrow(/隔离/);
          await expect(
            runModelAb(
              { repository: repo, settings: { ...SETTINGS, baseURL: h.baseURL } },
              {
                parentRunId: parentId,
                arms: [{ model: "m-a" }, { model: "m-b" }],
                dryRun: true,
              },
            ),
          ).rejects.toBeTruthy();

          // 拒绝都发生在联网之前：受控服务计数停在创建的 2 次
          expect(h.served()).toBe(2);
          expect(h.entries()).toHaveLength(2);
        },
      );
    } finally {
      cleanup();
    }
  });
});
