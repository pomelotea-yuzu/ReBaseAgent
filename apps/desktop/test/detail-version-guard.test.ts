import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunConfig } from "@rebaseagent/agent-loop";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  WORKSPACE_BLOBS_DIR_NAME,
  createIsolatedRun,
  replayIsolatedRun,
} from "@rebaseagent/replay";
import { readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../../packages/agent-loop/test/helpers";
import { RunRepository } from "../src/main/run-repository";
import { findRunDetailVersionViolation } from "../src/shared/detail-version-guard";
import { RunDetailSchema } from "../src/shared/ipc";

/**
 * B 任务 1.1：详情 IPC 的**原始版本守卫**与合法 v2 快照往返。
 *
 * 两个方向都必须钉住：
 * - 拒绝方向——v1 载荷在**自有属性存在性**上携带隔离字段（含 null/false/空对象/显式
 *   undefined）必须被拒，祖先 meta 不遗漏；业务正文里的同名字段与不相关扩展不误伤。
 * - 往返方向——真实 `createIsolatedRun` / `replayIsolatedRun` 产出的 v2 记录经
 *   main（RunRepository）→（守卫）→ renderer（RunDetailSchema）后，workspace、
 *   初始/空清单/完成步骤快照、origin、fork 边界完整保留；缺附件仍可读轨迹。
 *
 * fixture 布局注意：源目录与 dataDir 必须是**兄弟**——A 的 validateSourceRoot 会拒绝
 * "源在数据目录内"（source_conflicts_data_dir），这正是本守卫要服务的边界之一。
 * 零真实 API（LLM 用剧本桩）。
 */

const TASK = "读取 a.txt 并把要点写入 b.txt";

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

/** 源目录与数据目录互为兄弟（不能嵌套，见文件头说明） */
function tempLayout(): { dataDir: string; source: string; cleanup: () => void } {
  const outer = mkdtempSync(join(tmpdir(), "detail-version-guard-"));
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

/** 真跑一个隔离根 run（默认剧本：读 a.txt → 写 b.txt → 收尾） */
async function createIsolatedParent(
  dataDir: string,
  source: string,
  script?: Array<{
    content?: string;
    toolCalls?: Array<{ id: string; name: string; args: string }>;
  }>,
): Promise<string> {
  writeTree(source, { "a.txt": "alpha 内容", "keep.txt": "keep" });
  const result = await createIsolatedRun({
    dataDir,
    source,
    config: isolatedConfig(),
    userMessage: TASK,
    authority: { allowFileWrites: true },
    llm: new MockLlmClient(
      script ?? [
        { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }] },
        {
          toolCalls: [{ id: "c2", name: "write_file", args: '{"path":"b.txt","content":"beta"}' }],
        },
        { content: "任务完成。" },
      ],
    ),
  });
  if (!result.ok) {
    throw new Error(`createIsolatedRun 失败：${result.failure.code} ${result.failure.reason}`);
  }
  return result.id;
}

// ---------------------------------------------------------------------------
// 拒绝方向：v1 载荷携带隔离字段（自有属性存在性判定）
// ---------------------------------------------------------------------------

/** v1 叶子 meta 的最小形状（守卫在 schema 之前跑，只依赖 format_version 与受查字段） */
function v1Meta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run_leaf",
    parent: null,
    fork: null,
    format_version: 1,
    task: "t",
    created_at: "2026-09-20T00:00:00.000Z",
    config_hash: `sha256:${"0".repeat(64)}`,
    ...extra,
  };
}

function detailOf(meta: unknown, spans: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    meta,
    spans,
    events: [],
    status: "completed",
    chain: [{ meta, fork: (meta as Record<string, unknown>).fork ?? null }],
    leafSpanIds: (spans as Array<Record<string, unknown>>).map((s) => s.id),
    ...extra,
  };
}

describe("守卫拒绝：v1 载荷携带隔离字段（自有属性存在性，不看 truthiness）", () => {
  it.each([
    ["对象", { world_id: "run_x", origin: { kind: "import" }, format_version: 2 }],
    ["null", null],
    ["false", false],
    ["空对象", {}],
    ["显式 undefined", undefined],
  ])("v1 meta.workspace（%s）→ 拒绝", (_label, value) => {
    // spread 保留显式 undefined 的自有属性，正是"内存输入"的判定面
    const detail = detailOf(v1Meta({ workspace: value }), []);
    expect(findRunDetailVersionViolation(detail)).toContain("workspace");
  });

  it.each([
    ["字符串", "s_09"],
    ["null", null],
  ])("v1 meta.fork.resume_after_step（%s）→ 拒绝", (_label, value) => {
    const detail = detailOf(
      v1Meta({
        fork: { at_span: "s_03", edit: { field: "result", value: "x" }, resume_after_step: value },
      }),
      [],
    );
    expect(findRunDetailVersionViolation(detail)).toContain("resume_after_step");
  });

  it.each([
    ["对象", { id: `sha256:${"0".repeat(64)}`, files: [] }],
    ["null", null],
    ["false", false],
    ["空对象", {}],
  ])("v1 叶子 span.workspace_snapshot（%s）→ 拒绝并指名 span", (_label, value) => {
    const detail = detailOf(v1Meta(), [
      { id: "s_01", kind: "agent.step", n: 1, workspace_snapshot: value },
    ]);
    const violation = findRunDetailVersionViolation(detail);
    expect(violation).toContain("workspace_snapshot");
    expect(violation).toContain("s_01");
  });

  it("v2 meta 缺 workspace → 拒绝（v2 契约是必须携带）", () => {
    const detail = detailOf(v1Meta({ format_version: 2 }), []);
    expect(findRunDetailVersionViolation(detail)).toContain("v2 必须携带 workspace");
  });

  it("祖先链的 v1 meta 带隔离字段 → 拒绝并指明跳数（祖先元数据不遗漏）", () => {
    const leafMeta = v1Meta({
      id: "run_child",
      parent: "run_root",
      format_version: 2,
      workspace: {
        world_id: "run_child",
        origin: { kind: "checkpoint", run_id: "run_root", step_span: "s_02" },
      },
    });
    const rootMeta = v1Meta({ id: "run_root", workspace: { world_id: "run_root" } });
    const detail = {
      meta: leafMeta,
      spans: [],
      events: [],
      status: "completed",
      chain: [
        { meta: rootMeta, fork: null },
        { meta: leafMeta, fork: null },
      ],
      leafSpanIds: [],
    };
    expect(findRunDetailVersionViolation(detail)).toContain("祖先链第 1 跳");
  });
});

describe("守卫不误伤：非结构位置与不相关扩展保持兼容", () => {
  it("不相关扩展字段（未来字段）不拒绝", () => {
    const meta = v1Meta({ future_extension: { anything: true } });
    const detail = detailOf(meta, [{ id: "s_01", kind: "agent.step", n: 1, custom_note: "x" }]);
    expect(findRunDetailVersionViolation(detail)).toBeNull();
  });

  it("业务正文里的同名字段（工具 args/result、消息内容）不触发结构守卫", () => {
    const detail = detailOf(v1Meta(), [
      {
        id: "s_02",
        kind: "tool.invoke",
        tool: "write_file",
        args: { path: "x", workspace_snapshot: { fake: true } },
        result: '{"workspace":{"world_id":"伪造"}}',
        dur_ms: 1,
        error: null,
      },
      {
        id: "s_03",
        kind: "llm.call",
        request: {
          model: "m",
          messages: [{ role: "system", content: '{"workspace":1}' }],
        },
        response: { content: "ok", toolCalls: [], usage: { in: 1, out: 1 }, ttftMs: 1 },
      },
    ]);
    expect(findRunDetailVersionViolation(detail)).toBeNull();
  });

  it("祖先前缀 span 无法逐条归属 → 不做 span 级检查（文件级已由 reader 守卫）；可归属的照样拒", () => {
    // 合并轨迹：s_00 来自祖先（不在 leafSpanIds，携带快照也不检查）；s_02 是叶子自有（干净）
    const detail = {
      meta: v1Meta(),
      spans: [
        { id: "s_00", kind: "agent.step", n: 1, workspace_snapshot: { id: "x", files: [] } },
        { id: "s_02", kind: "agent.step", n: 1 },
      ],
      events: [],
      status: "completed",
      chain: [{ meta: v1Meta(), fork: null }],
      leafSpanIds: ["s_02"],
    };
    expect(findRunDetailVersionViolation(detail)).toBeNull();

    // 对照：把祖先前缀的 span id 放进 leafSpanIds（归属错误/被篡改）→ 按叶子 v1 版本被拒
    const misAttributed = { ...detail, leafSpanIds: ["s_00", "s_02"] };
    expect(findRunDetailVersionViolation(misAttributed)).toContain("s_00");
  });

  it("载荷缺失 leafSpanIds（异常形状）→ 宁可全量误报也不漏放", () => {
    const detail = {
      meta: v1Meta(),
      spans: [{ id: "s_01", kind: "agent.step", n: 1, workspace_snapshot: {} }],
      events: [],
      status: "completed",
      chain: [{ meta: v1Meta(), fork: null }],
    };
    expect(findRunDetailVersionViolation(detail)).toContain("workspace_snapshot");
  });
});

// ---------------------------------------------------------------------------
// 往返方向：真实 v2 根与分支经守卫 + schema 后字段完整保留
// ---------------------------------------------------------------------------

describe("详情 IPC 快照往返（真实 createIsolatedRun / replayIsolatedRun 产物）", () => {
  it("根 run：workspace、初始与各轮检查点快照完整往返", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const id = await createIsolatedParent(dataDir, source);
      const repo = new RunRepository(join(dataDir, "traces"));
      const detail = repo.getRun(id);

      // 对照（守卫必须前置的原因）：给真实载荷加一个未来扩展字段——
      // 守卫放行（不在结构位置），但 schema parse 会把它剥离；守卫若放在 parse 后就晚了
      const withExtension = {
        ...detail,
        meta: { ...detail.meta, future_extension: { anything: true } },
      };
      expect(findRunDetailVersionViolation(withExtension)).toBeNull();

      expect(findRunDetailVersionViolation(detail)).toBeNull();
      const parsed = RunDetailSchema.safeParse(withExtension);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const data = parsed.data;
      expect((data.meta as Record<string, unknown>).future_extension).toBeUndefined();

      // meta：v2 + import origin + world_id = 本 run id
      expect(data.meta.format_version).toBe(2);
      expect(data.meta.workspace?.world_id).toBe(id);
      expect(data.meta.workspace?.origin).toEqual({ kind: "import" });

      // 快照：初始快照含源目录两文件；最后一个 agent.step 的轮末快照含写入后的三个文件
      const steps = data.spans.filter((s) => s.kind === "agent.step");
      expect(steps.length).toBeGreaterThanOrEqual(2);
      const initial = data.meta.workspace?.initial_snapshot;
      expect(initial?.files.map((f) => f.path).sort()).toEqual(["a.txt", "keep.txt"]);
      const lastStep = steps[steps.length - 1];
      if (lastStep.kind !== "agent.step") throw new Error("unreachable");
      expect(lastStep.workspace_snapshot?.files.map((f) => f.path).sort()).toEqual([
        "a.txt",
        "b.txt",
        "keep.txt",
      ]);
      // 快照 id 是裸 64 位 hex 指纹（注意与 config_hash 的 `sha256:` 前缀不同）
      expect(lastStep.workspace_snapshot?.id).toMatch(/^[0-9a-f]{64}$/);

      // 祖先链（根 run 只有一跳）同样携带 workspace
      expect(data.chain).toHaveLength(1);
      expect(data.chain[0]?.meta.workspace?.world_id).toBe(id);
    } finally {
      cleanup();
    }
  });

  it("分支 run：fork.resume_after_step 与 checkpoint origin 往返；空清单快照也保留", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      // 空源目录的隔离 run：初始快照为空清单（往返场景的三种快照形态之一）
      writeTree(source, {});
      const emptyResult = await createIsolatedRun({
        dataDir,
        source,
        config: isolatedConfig(),
        userMessage: "空目录也要能跑",
        authority: { allowFileWrites: true },
        llm: new MockLlmClient([{ content: "目录是空的。" }]),
      });
      if (!emptyResult.ok) throw new Error(emptyResult.failure.reason);
      const repo = new RunRepository(join(dataDir, "traces"));
      const emptyDetail = repo.getRun(emptyResult.id);
      expect(findRunDetailVersionViolation(emptyDetail)).toBeNull();
      const emptyParsed = RunDetailSchema.safeParse(emptyDetail);
      expect(emptyParsed.success).toBe(true);
      if (emptyParsed.success) {
        expect(emptyParsed.data.meta.workspace?.initial_snapshot.files).toEqual([]);
      }

      // 分支：编辑根 run 的 write_file 结果，从那一轮结束后续跑
      const parentId = await createIsolatedParent(dataDir, source);
      const parentRecord = readRun(join(dataDir, "traces", `${parentId}.jsonl`));
      const writeSpan = parentRecord.spans.find(
        (s) => s.kind === "tool.invoke" && s.tool === "write_file",
      );
      if (writeSpan?.kind !== "tool.invoke") throw new Error("父 run 没有 write_file span");

      const fork = await replayIsolatedRun({
        dataDir,
        parentId,
        atSpanId: writeSpan.id,
        edit: { field: "result", value: "内容(a.txt)【编辑后的模型观察】" },
        config: isolatedConfig(),
        authority: { allowFileWrites: true },
        llm: new MockLlmClient([{ content: "基于编辑后的观察收尾。" }]),
      });
      if (!fork.ok) throw new Error(`${fork.failure.code} ${fork.failure.reason}`);

      const detail = repo.getRun(fork.id);
      expect(findRunDetailVersionViolation(detail)).toBeNull();
      const parsed = RunDetailSchema.safeParse(detail);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const data = parsed.data;

      // 子 run 的 workspace.origin 指向直接父与边界 step；fork 带整轮续跑边界（两者同源）
      expect(data.meta.format_version).toBe(2);
      const origin = data.meta.workspace?.origin;
      if (origin?.kind !== "checkpoint") throw new Error("子 run origin 应为 checkpoint");
      expect(origin.run_id).toBe(parentId);
      expect(typeof origin.step_span).toBe("string");
      const forkMeta = data.meta.fork;
      expect(forkMeta?.edit.field).toBe("result");
      if (forkMeta?.edit.field !== "result") throw new Error("unreachable");
      expect(forkMeta.resume_after_step).toBe(origin.step_span);

      // 祖先链两跳都完整：根（import）→ 子（checkpoint）
      expect(data.chain.map((hop) => hop.meta.id)).toEqual([parentId, fork.id]);
      expect(data.chain[0]?.meta.workspace?.origin).toEqual({ kind: "import" });
      expect(data.chain[1]?.meta.workspace?.origin?.kind).toBe("checkpoint");

      // 合并轨迹里叶子的 v2 span（带检查点）不被误拒（leafSpanIds 归属）
      const ownSteps = data.spans.filter(
        (s) => s.kind === "agent.step" && data.leafSpanIds.includes(s.id),
      );
      expect(ownSteps.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it("缺附件仍可读轨迹：删除 workspace-blobs 后守卫与 schema 均通过", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const id = await createIsolatedParent(dataDir, source);
      const blobs = join(dataDir, WORKSPACE_BLOBS_DIR_NAME);
      expect(readdirSync(blobs).length).toBeGreaterThan(0);
      rmSync(blobs, { recursive: true, force: true });

      const repo = new RunRepository(join(dataDir, "traces"));
      const detail = repo.getRun(id);
      expect(findRunDetailVersionViolation(detail)).toBeNull();
      expect(RunDetailSchema.safeParse(detail).success).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("守卫有牙：把真实 v2 详情的 format_version 改回 1（workspace 仍在）会被拒", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const id = await createIsolatedParent(dataDir, source);
      const repo = new RunRepository(join(dataDir, "traces"));
      const detail = repo.getRun(id);

      // 单点破坏：叶子 meta 的 format_version 改成 1（workspace 仍在）＝"v1 私带隔离字段"
      const tampered = { ...detail, meta: { ...detail.meta, format_version: 1 } };
      expect(findRunDetailVersionViolation(tampered)).toContain("workspace");
    } finally {
      cleanup();
    }
  });
});

/** 守卫实现口径：纯子路径再导出与主出口必须是同一实现（防"两份判定"） */
describe("守卫实现口径", () => {
  it("trace-sdk 纯子路径导出的守卫与主出口是同一实现", async () => {
    const fromSchema = await import("@rebaseagent/trace-sdk/schema");
    const fromMain = await import("@rebaseagent/trace-sdk");
    expect(fromSchema.findVersionFieldViolation).toBe(fromMain.findVersionFieldViolation);
  });

  it("真实 v2 trace 文件的首行确为带 workspace 的 meta（往返数据不是手搭桩）", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      const id = await createIsolatedParent(dataDir, source);
      const firstLine =
        readFileSync(join(dataDir, "traces", `${id}.jsonl`), "utf8").split("\n")[0] ?? "";
      const meta = JSON.parse(firstLine) as { format_version: number; workspace?: unknown };
      expect(meta.format_version).toBe(2);
      expect(meta.workspace).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
