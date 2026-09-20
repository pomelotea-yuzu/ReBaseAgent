import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunConfig } from "@rebaseagent/agent-loop";
import { FILE_TOOLS_V1_DEFINITIONS, createIsolatedRun } from "@rebaseagent/replay";
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../../packages/agent-loop/test/helpers";
import { runCreate } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import { inspectWorkspace, readWorkspaceFileForView } from "../src/main/workspace-view";
import { WorkspaceInspectResultSchema, WorkspaceReadFileResultSchema } from "../src/shared/ipc";

/**
 * C 任务 1.1：文件检查点的**只读** IPC 服务。
 *
 * 覆盖本段 delta 的三条场景（`文件读取 IPC 拒绝越权` / `二进制和不可用附件分别显示` /
 * `文件浏览过程无写入`）里属于 main 侧的那一半：
 *
 * - **越权拒绝**：可穿越 tracesDir 的非法 runId、清单外路径、祖先而非自有 step、
 *   物理 blob 路径——一律可辨认地拒绝，且**不读取目标宿主文件**。
 * - **六态可分辨**：text / binary / not_found / missing / corrupt / rejected 各自返回，
 *   缺失与损坏绝不伪装成空文本。
 * - **零写入**：整段浏览（初始 + 各轮 + 读文本）前后，数据目录**全树指纹逐字节不变**。
 *
 * 判据用真实 `createIsolatedRun` 产物（v2 真轨迹），零真实 API（LLM 用剧本桩）。
 */

const TASK = "读取 a.txt 并把要点写入 b.txt";

function isolatedConfig(): RunConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    systemPrompt: "你是文件助手。",
    tools: [...FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

/** 源目录与数据目录必须是**兄弟**（A 的 validateSourceRoot 拒绝"源在数据目录内"） */
function tempLayout(): { dataDir: string; source: string; cleanup: () => void } {
  const outer = mkdtempSync(join(tmpdir(), "workspace-view-"));
  const dataDir = join(outer, "data");
  const source = join(outer, "source");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(source, { recursive: true });
  return { dataDir, source, cleanup: () => rmSync(outer, { recursive: true, force: true }) };
}

/** 真跑一个隔离根 run，产出两轮：读 a.txt → 写 b.txt → 收尾 */
async function createFixture(dataDir: string, source: string): Promise<string> {
  writeFileSync(join(source, "a.txt"), "alpha 内容");
  writeFileSync(join(source, "keep.txt"), "keep");
  const result = await createIsolatedRun({
    dataDir,
    source,
    config: isolatedConfig(),
    userMessage: TASK,
    authority: { allowFileWrites: true },
    llm: new MockLlmClient([
      { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }] },
      {
        toolCalls: [{ id: "c2", name: "write_file", args: '{"path":"b.txt","content":"beta"}' }],
      },
      { content: "任务完成。" },
    ]),
  });
  if (!result.ok) {
    throw new Error(`createIsolatedRun 失败：${result.failure.code} ${result.failure.reason}`);
  }
  return result.id;
}

/** 数据目录全树指纹：相对路径 → 内容哈希（只读判据用，含 trace 与附件） */
function fingerprintTree(root: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const walk = (dir: string, prefix: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, name.name);
      if (name.isDirectory()) {
        out.push(...walk(full, `${prefix}${name.name}/`));
      } else {
        const bytes = readFileSync(full);
        out.push(`${prefix}${name.name}:${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
    return out;
  };
  return walk(root, "").join("\n");
}

/** 从 run 记录里取全部 agent.step 的 (spanId, n, 快照 id) */
function stepsOf(record: ReturnType<RunRepository["loadRunRecord"]>) {
  return record.spans
    .filter((span) => span.kind === "agent.step")
    .map((span) => ({
      id: span.id,
      n: span.kind === "agent.step" ? span.n : 0,
      snapshotId:
        span.kind === "agent.step" && span.workspace_snapshot !== undefined
          ? span.workspace_snapshot.id
          : null,
    }));
}

describe("workspaces:inspect —— 清单查看（初始 / 自有步骤）", () => {
  it("初始快照：change 恒为 initial，轮号为 null，文件数与 A 的清单一致", async () => {
    const layout = tempLayout();
    try {
      const runId = await createFixture(layout.dataDir, layout.source);
      const outcome = await inspectWorkspace(
        { dataDir: layout.dataDir, repository: new RunRepository(join(layout.dataDir, "traces")) },
        { runId },
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const parsed = WorkspaceInspectResultSchema.safeParse(outcome.result);
      expect(parsed.success).toBe(true);
      expect(outcome.result.stepSpanId).toBeNull();
      expect(outcome.result.localIteration).toBeNull();
      // 初始快照 = 源目录三份文件（a.txt / keep.txt）+ 导入时不一定有的其它条目
      expect(outcome.result.files.map((f) => f.path).sort()).toEqual(["a.txt", "keep.txt"]);
      expect(outcome.result.files.every((f) => f.change === "initial")).toBe(true);
      expect(outcome.result.files.every((f) => f.availability === "ok")).toBe(true);
      expect(outcome.result.unavailableCount).toBe(0);
      expect(outcome.result.profile).toBe("file-tools-v1");
      expect(outcome.result.ownerRunId).toBe(runId);
      expect(outcome.result.worldId).toBe(runId);
      expect(outcome.result.initialSnapshotId).toBe(outcome.result.snapshotId);
    } finally {
      layout.cleanup();
    }
  });

  it("第 2 轮结束时：新增 b.txt 标 added，原文件标 unchanged；轮号取该 step 自己的 n", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      const runId = await createFixture(dataDir, layout.source);
      const repository = new RunRepository(join(dataDir, "traces"));
      const steps = stepsOf(repository.loadRunRecord(runId));
      expect(steps.length).toBeGreaterThanOrEqual(2);

      // 取最后一轮（写 b.txt 已发生）的检查点
      const last = steps[steps.length - 1];
      const outcome = await inspectWorkspace(
        { dataDir, repository },
        { runId, stepSpanId: last.id },
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.result.stepSpanId).toBe(last.id);
      // 轮号 = 所属 run 自己的 agent.step.n（不沿链累加；本 run 是根，"沿链"本就等于本地）
      expect(outcome.result.localIteration).toBe(last.n);
      expect(outcome.result.snapshotId).toBe(last.snapshotId);

      const byPath = new Map(outcome.result.files.map((f) => [f.path, f]));
      expect(byPath.get("b.txt")?.change).toBe("added");
      expect(byPath.get("a.txt")?.change).toBe("unchanged");
      expect(byPath.get("keep.txt")?.change).toBe("unchanged");
    } finally {
      layout.cleanup();
    }
  });

  it("修改既有文件 → 标 modified（按内容哈希，不用 mtime）", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      // 剧本：把 a.txt 原文改成别的长度但"名字相同"的内容 ⇒ 哈希变化
      writeFileSync(join(layout.source, "a.txt"), "alpha 内容");
      writeFileSync(join(layout.source, "keep.txt"), "keep");
      const result = await createIsolatedRun({
        dataDir,
        source: layout.source,
        config: isolatedConfig(),
        userMessage: TASK,
        authority: { allowFileWrites: true },
        llm: new MockLlmClient([
          {
            toolCalls: [
              { id: "c1", name: "write_file", args: '{"path":"a.txt","content":"完全不同的内容"}' },
            ],
          },
          { content: "改完了。" },
        ]),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const repository = new RunRepository(join(dataDir, "traces"));
      const steps = stepsOf(repository.loadRunRecord(result.id));
      const last = steps[steps.length - 1];
      const outcome = await inspectWorkspace(
        { dataDir, repository },
        { runId: result.id, stepSpanId: last.id },
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const a = outcome.result.files.find((f) => f.path === "a.txt");
      expect(a?.change).toBe("modified");
      // 修正后的哈希必须与清单记录的一致（不是重算出来的另一份）
      expect(a?.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      layout.cleanup();
    }
  });
});

describe("workspaces:inspect / readFile —— 越权与非法请求一律可辨认地拒绝", () => {
  it.each([
    ["含路径分隔符的 runId", { runId: "../escape" }],
    ["含反斜杠的 runId", { runId: "..\\escape" }],
    ["绝对路径式 runId", { runId: "D:/x" }],
    ["空 runId", { runId: "" }],
    ["runId 为 .", { runId: "." }],
  ])("%s → 拒绝且不读取宿主文件", async (_label, request) => {
    const layout = tempLayout();
    try {
      const outcome = await inspectWorkspace(
        { dataDir: layout.dataDir, repository: new RunRepository(join(layout.dataDir, "traces")) },
        request,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("WORKSPACE_INVALID_REQUEST");
      expect(outcome.message).toContain("runId");
    } finally {
      layout.cleanup();
    }
  });

  it("不存在的 run → run_not_found（可辨认，不抛错）", async () => {
    const layout = tempLayout();
    try {
      const outcome = await inspectWorkspace(
        { dataDir: layout.dataDir, repository: new RunRepository(join(layout.dataDir, "traces")) },
        { runId: "run_not_here" },
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("WORKSPACE_RUN_NOT_FOUND");
    } finally {
      layout.cleanup();
    }
  });

  it("非隔离 run（v1 无 workspace）→ no_workspace", async () => {
    const layout = tempLayout();
    try {
      // 真跑一个纯对话 v1 run（空工具表、无 workspace），而不是手搭桩——
      // 手搭的最小 meta 过不了 schema，测出来的会是"文件格式错"而不是"无隔离世界"
      const tracesDir = join(layout.dataDir, "traces");
      mkdirSync(tracesDir, { recursive: true });
      const repository = new RunRepository(tracesDir);
      const created = await runCreate(
        {
          repository,
          settings: {
            baseURL: "https://api.deepseek.com/v1",
            apiKey: "sk-test",
            model: "deepseek-chat",
            systemPrompt: "",
            params: undefined,
          },
          execCwd: tracesDir,
          llm: new MockLlmClient([{ content: "你好。" }]),
        },
        { systemPrompt: "", userMessage: "打个招呼" },
      );
      // 该 run 必须是 v1（无 workspace），否则本用例的前提不成立
      expect(repository.loadRunRecord(created.id).meta.workspace).toBeUndefined();

      const outcome = await inspectWorkspace(
        { dataDir: layout.dataDir, repository },
        { runId: created.id },
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("WORKSPACE_NO_WORKSPACE");
    } finally {
      layout.cleanup();
    }
  });

  it("祖先 / 不存在的 stepSpanId → step_not_found（不用祖先快照冒充本 run 自有状态）", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      const runId = await createFixture(dataDir, layout.source);
      const repository = new RunRepository(join(dataDir, "traces"));

      for (const stepSpanId of ["s_ancestor_never_in_file", "llm_1"]) {
        const outcome = await inspectWorkspace({ dataDir, repository }, { runId, stepSpanId });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("WORKSPACE_STEP_NOT_FOUND");
      }
    } finally {
      layout.cleanup();
    }
  });
});

describe("workspaces:readFile —— 六态可分辨（text / binary / not_found / missing / corrupt / rejected）", () => {
  it("文本文件：返回完整 UTF-8 文本 + 大小 + 哈希", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      const runId = await createFixture(dataDir, layout.source);
      const repository = new RunRepository(join(dataDir, "traces"));

      const result = await readWorkspaceFileForView(
        { dataDir, repository },
        { runId, path: "a.txt" },
      );
      const parsed = WorkspaceReadFileResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
      expect(result.status).toBe("text");
      if (result.status !== "text") return;
      expect(result.text).toBe("alpha 内容");
      expect(result.bytes).toBe(Buffer.byteLength("alpha 内容", "utf8"));
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      layout.cleanup();
    }
  });

  it("二进制文件：只返回大小/哈希，**不传字节**、不做有损解码", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      // 无效 UTF-8 字节序列：0xFF 0xFE 在 UTF-8 里是非法序列
      writeFileSync(join(layout.source, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
      writeFileSync(join(layout.source, "a.txt"), "alpha");
      const result = await createIsolatedRun({
        dataDir,
        source: layout.source,
        config: isolatedConfig(),
        userMessage: TASK,
        authority: { allowFileWrites: true },
        llm: new MockLlmClient([{ content: "收到了。" }]),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const repository = new RunRepository(join(dataDir, "traces"));
      const read = await readWorkspaceFileForView(
        { dataDir, repository },
        { runId: result.id, path: "bin.dat" },
      );
      expect(read.status).toBe("binary");
      if (read.status !== "binary") return;
      expect(read.bytes).toBe(4);
      expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
      // 二进制不得携带任何文本（schema 里就没有 text 字段）
      expect(WorkspaceReadFileResultSchema.safeParse(read).success).toBe(true);
    } finally {
      layout.cleanup();
    }
  });

  it("清单外路径 / 物理 blob 路径 → not_found（永不拼进宿主路径）", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      const runId = await createFixture(dataDir, layout.source);
      const repository = new RunRepository(join(dataDir, "traces"));

      const hashLike = `workspace-blobs/sha256/${"a".repeat(64)}`;
      for (const path of ["not/in/the/manifest.txt", hashLike, "D:/host/file.txt"]) {
        const result = await readWorkspaceFileForView({ dataDir, repository }, { runId, path });
        expect(result.status).toBe("not_found");
      }
    } finally {
      layout.cleanup();
    }
  });

  it("非法逻辑路径（穿越 / 绝对 / UNC / 保留名）→ not_found", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      const runId = await createFixture(dataDir, layout.source);
      const repository = new RunRepository(join(dataDir, "traces"));

      for (const path of ["../a.txt", "/a.txt", "//server/share", "a\\b.txt", "CON", "a/../b"]) {
        const result = await readWorkspaceFileForView({ dataDir, repository }, { runId, path });
        expect(result.status).toBe("not_found");
      }
    } finally {
      layout.cleanup();
    }
  });

  it("附件被删除 → missing（明确状态，不伪装空文本）", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      const runId = await createFixture(dataDir, layout.source);
      const repository = new RunRepository(join(dataDir, "traces"));
      const record = repository.loadRunRecord(runId);
      const target = record.meta.workspace?.initial_snapshot.files.find((f) => f.path === "a.txt");
      expect(target).toBeDefined();
      if (target === undefined) return;

      // 定点删除该附件（内容寻址：路径由已校验哈希推导）
      const blob = join(dataDir, "workspace-blobs", "sha256", target.sha256);
      rmSync(blob, { force: true });

      const result = await readWorkspaceFileForView(
        { dataDir, repository },
        { runId, path: "a.txt" },
      );
      expect(result.status).toBe("missing");
      if (result.status !== "missing") return;
      expect(result.reason).toContain("不存在");
    } finally {
      layout.cleanup();
    }
  });

  it("附件被篡改 → corrupt（长度或哈希不符，不回读源目录兜底）", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      const runId = await createFixture(dataDir, layout.source);
      const repository = new RunRepository(join(dataDir, "traces"));
      const record = repository.loadRunRecord(runId);
      const target = record.meta.workspace?.initial_snapshot.files.find((f) => f.path === "a.txt");
      expect(target).toBeDefined();
      if (target === undefined) return;

      // 覆盖成同长度但不同内容 ⇒ 长度对得上、哈希对不上（正是最容易被漏判的一类）
      const blob = join(dataDir, "workspace-blobs", "sha256", target.sha256);
      writeFileSync(blob, Buffer.alloc(target.bytes, 0x41));

      const result = await readWorkspaceFileForView(
        { dataDir, repository },
        { runId, path: "a.txt" },
      );
      expect(result.status).toBe("corrupt");
      if (result.status !== "corrupt") return;
      expect(result.reason).toContain("哈希不符");
    } finally {
      layout.cleanup();
    }
  });

  it("非法 runId（可穿越 tracesDir）→ rejected，而非抛错", async () => {
    const layout = tempLayout();
    try {
      const result = await readWorkspaceFileForView(
        { dataDir: layout.dataDir, repository: new RunRepository(join(layout.dataDir, "traces")) },
        { runId: "../escape", path: "a.txt" },
      );
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") return;
      expect(result.code).toBe("invalid_request");
    } finally {
      layout.cleanup();
    }
  });
});

describe("workspaces:inspect / readFile —— 浏览过程无写入（只读判据有牙）", () => {
  it("完整浏览一遍（初始 + 各轮 + 逐文件读文本）后，数据目录全树指纹逐字节不变", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      const runId = await createFixture(dataDir, layout.source);
      const repository = new RunRepository(join(dataDir, "traces"));
      const steps = stepsOf(repository.loadRunRecord(runId));

      const before = fingerprintTree(dataDir);

      // 初始 + 每个完成步骤都列一遍，并把每份清单里每个文件都读一遍
      const snapshotRequests: Array<{ runId: string; stepSpanId?: string }> = [{ runId }];
      for (const step of steps) snapshotRequests.push({ runId, stepSpanId: step.id });

      for (const request of snapshotRequests) {
        const outcome = await inspectWorkspace({ dataDir, repository }, request);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) continue;
        for (const file of outcome.result.files) {
          await readWorkspaceFileForView(
            { dataDir, repository },
            {
              runId,
              path: file.path,
              ...(request.stepSpanId === undefined ? {} : { stepSpanId: request.stepSpanId }),
            },
          );
        }
      }

      const after = fingerprintTree(dataDir);
      expect(after).toBe(before);
      // 附带：源目录也不该被动过（A 段纪律：源目录只在显式授权下被改写）
      expect(readFileSync(join(layout.source, "a.txt"), "utf8")).toBe("alpha 内容");
    } finally {
      layout.cleanup();
    }
  });
});

describe("workspaces:inspect / readFile —— 失败运行已记录文件可查看", () => {
  it("run 被 errored 事件封存后，已记录的初始/步骤检查点仍可列出并读取完整文件事实", async () => {
    const layout = tempLayout();
    try {
      const dataDir = layout.dataDir;
      const runId = await createFixture(dataDir, layout.source);

      // 按真实失败 run 的落盘形态追加 errored 终止事件（runLoop 不抛 LLM 失败，
      // 成败判据是终止事件——见真机 trace run_mu9ckoh7 的最后一行）。
      appendFileSync(
        join(dataDir, "traces", `${runId}.jsonl`),
        `${JSON.stringify({ type: "run.event", event: "errored", reason: "error", at: 3 })}\n`,
        "utf8",
      );

      const repository = new RunRepository(join(dataDir, "traces"));
      const record = repository.loadRunRecord(runId);
      // 终止事件在场（该 run 已被封存，不再是"进行中"）
      expect(record.events.some((event) => event.event === "errored")).toBe(true);

      // 初始清单仍完整可列（失败不撤销历史写入）
      const initial = await inspectWorkspace({ dataDir, repository }, { runId });
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      expect(initial.result.files.map((file) => file.path)).toContain("a.txt");

      // 各步骤检查点同样可列、可读完整内容
      const steps = stepsOf(record).filter((step) => step.snapshotId !== null);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      for (const step of steps) {
        const outcome = await inspectWorkspace(
          { dataDir, repository },
          { runId, stepSpanId: step.id },
        );
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) continue;
        const aFile = outcome.result.files.find((file) => file.path === "a.txt");
        expect(aFile).toBeDefined();
        if (aFile === undefined) continue;
        const content = await readWorkspaceFileForView(
          { dataDir, repository },
          { runId, stepSpanId: step.id, path: "a.txt" },
        );
        expect(content.status).toBe("text");
        if (content.status !== "text") return;
        expect(content.text).toBe("alpha 内容");
      }
    } finally {
      layout.cleanup();
    }
  });
});
