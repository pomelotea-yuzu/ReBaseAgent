import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceBlobStore, type exportWorkspaceSnapshot } from "@rebaseagent/replay";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_EXPORT_FAILED,
  WORKSPACE_EXPORT_IN_FLIGHT,
  exportWorkspaceEndpoint,
} from "../src/main/workspace-export-endpoint";
import type { WorkspaceExportEndpointDeps } from "../src/main/workspace-export-endpoint";
import { WorkspaceExportOutcomeSchema, WorkspaceExportRequestSchema } from "../src/shared/ipc";

/**
 * R2.1 任务 5.1/5.2a/5.2b/5.4（main 侧）：workspaces:export 端点集成测试。
 *
 * 覆盖（spec delta 场景 → main 那一半）：
 * - 严格请求 schema：额外物理路径键（targetDir/dataDir/blobRoot）与缺 runId 在
 *   副作用之前拒绝（信封失败），目录对话框与包层都未被调用；
 * - ownOnly / 损坏 trace：写入前来源重验返回导出语境稳定码，对话框**未被打开**；
 * - 目录取消：canceled 零写入，包层未被调用；
 * - 对话框期间父链变化：早期检查通过、返回后重验失败 → RUN_LINEAGE_INCOMPLETE；
 * - 成功导出：outcome 过严格 schema，目标文件树逐字节核对，dataDir 指纹不变；
 * - 同 main 在飞保护：第一次在飞时重复请求立即拒绝且不打开第二个对话框；
 *   结束（成功/失败）后槽位释放；
 * - 零 operation：端点 deps 不含 OperationRegistry（构造保证），请求无执行身份
 *   字段仍被接受。
 *
 * fixture 用轻量 v2 真轨迹（JsonlTracer + blob store 真发布），不跑 LLM。
 */

const ROOT_RUN = "run_export_root";
const CHILD_RUN = "run_export_child";
const GHOST_RUN = "run_export_ghost";
const PLAIN_RUN = "run_export_plain";

interface Fixture {
  readonly outer: string;
  readonly dataDir: string;
  readonly tracesDir: string;
  readonly rootStepSpanId: string;
  readonly cleanup: () => void;
}

async function buildFixture(): Promise<Fixture> {
  const outer = mkdtempSync(join(tmpdir(), "workspace-export-endpoint-"));
  const dataDir = join(outer, "data");
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });

  const store = createWorkspaceBlobStore(dataDir);
  const publish = async (content: string) => {
    const published = await store.publish(new TextEncoder().encode(content));
    return { path: "a.txt", sha256: published.sha256, bytes: published.bytes };
  };

  // 根 run：初始 a.txt="before"，自有 step a.txt="after"（补丁 written）
  const initial = createWorkspaceSnapshot([await publish("before")]);
  const tracer = new JsonlTracer(join(tracesDir, `${ROOT_RUN}.jsonl`));
  tracer.startRun({
    id: ROOT_RUN,
    format_version: 2,
    task: "导出端点 fixture",
    model: "deepseek-chat",
    created_at: "2026-10-12T00:00:00.000Z",
    parent: null,
    fork: null,
    workspace: {
      profile: "file-tools-v1",
      world_id: ROOT_RUN,
      write_authorized: true,
      initial_snapshot: initial,
      origin: { kind: "import" },
    },
  });
  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  tracer.endSpan(step, { workspace_snapshot: createWorkspaceSnapshot([await publish("after")]) });
  const rootStepSpanId = step;
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // 真父链 child run（early/late 来源检查的完整基准）
  const childTracer = new JsonlTracer(join(tracesDir, `${CHILD_RUN}.jsonl`), { spanSeqStart: 2 });
  childTracer.startRun({
    id: CHILD_RUN,
    format_version: 2,
    task: "导出端点 fixture 子 run",
    model: "deepseek-chat",
    created_at: "2026-10-12T00:00:01.000Z",
    parent: ROOT_RUN,
    fork: {
      at_span: rootStepSpanId,
      resume_after_step: rootStepSpanId,
      edit: { field: "result", value: "续跑" },
    },
    workspace: {
      profile: "file-tools-v1",
      world_id: CHILD_RUN,
      write_authorized: true,
      initial_snapshot: createWorkspaceSnapshot([]),
      origin: { kind: "checkpoint", run_id: ROOT_RUN, step_span: rootStepSpanId },
    },
  });
  childTracer.endRun({ event: "stopped", reason: "completed", at: 0 });

  // ghost 分支 run：父 trace 缺失（ownOnly ⇒ RUN_LINEAGE_INCOMPLETE 的唯一入口）
  const ghostTracer = new JsonlTracer(join(tracesDir, `${GHOST_RUN}.jsonl`), { spanSeqStart: 2 });
  ghostTracer.startRun({
    id: GHOST_RUN,
    format_version: 2,
    task: "ghost 分支",
    model: "deepseek-chat",
    created_at: "2026-10-12T00:00:02.000Z",
    parent: "run_export_missing_parent",
    fork: {
      at_span: "span_missing",
      resume_after_step: "span_missing",
      edit: { field: "result", value: "续跑" },
    },
    workspace: {
      profile: "file-tools-v1",
      world_id: GHOST_RUN,
      write_authorized: true,
      initial_snapshot: createWorkspaceSnapshot([]),
      origin: {
        kind: "checkpoint",
        run_id: "run_export_missing_parent",
        step_span: "span_missing",
      },
    },
  });
  ghostTracer.endRun({ event: "stopped", reason: "completed", at: 0 });

  // 普通 v1 run（无 workspace）：父链完整，包层拒绝职责的证明面
  const plainTracer = new JsonlTracer(join(tracesDir, `${PLAIN_RUN}.jsonl`));
  plainTracer.startRun({
    id: PLAIN_RUN,
    format_version: 1,
    task: "普通运行",
    model: "deepseek-chat",
    created_at: "2026-10-12T00:00:03.000Z",
    parent: null,
    fork: null,
  });
  plainTracer.endRun({ event: "stopped", reason: "completed", at: 0 });

  // 损坏 trace
  writeFileSync(join(tracesDir, "run_export_bad.jsonl"), "这不是 JSONL\n");

  return {
    outer,
    dataDir,
    tracesDir,
    rootStepSpanId,
    cleanup: () => rmSync(outer, { recursive: true, force: true }),
  };
}

/** 测试侧在飞保护（与 registerIpc 的闭包实现同形） */
function makeSlot() {
  let busy = false;
  return {
    acquireSlot: () => {
      if (busy) return false;
      busy = true;
      return true;
    },
    releaseSlot: () => {
      busy = false;
    },
  };
}

const fixture = await buildFixture();

describe("workspaces:export 端点（任务 5.1/5.2a/5.2b/5.4）", () => {
  const { dataDir, tracesDir, rootStepSpanId, cleanup } = fixture;
  const scratch: string[] = [];
  const pickCalls: string[] = [];

  afterEach(() => {
    for (const dir of scratch.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    pickCalls.length = 0;
  });

  function newTarget(name: string): string {
    const dir = join(fixture.outer, `target-${name}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    scratch.push(dir);
    return dir;
  }

  function makeDeps(
    overrides: Partial<WorkspaceExportEndpointDeps> = {},
  ): WorkspaceExportEndpointDeps & { pickCalls: () => number } {
    const slot = makeSlot();
    const deps: WorkspaceExportEndpointDeps = {
      dataDir,
      tracesDir,
      pickDirectory: async () => {
        pickCalls.push("pick");
        return newTarget(`pick-${pickCalls.length}`);
      },
      ...slot,
      ...overrides,
    };
    return { ...deps, pickCalls: () => pickCalls.length };
  }

  it("严格请求 schema：额外物理路径键被拒绝（INVALID_ARGUMENT），零副作用", async () => {
    const deps = makeDeps();
    const result = await exportWorkspaceEndpoint(deps, {
      runId: ROOT_RUN,
      // renderer 试图自带目标物理路径
      targetDir: "D:/evil/target",
    });
    expect(result.kind).toBe("envelope-failure");
    if (result.kind !== "envelope-failure") return;
    expect(result.code).toBe("INVALID_ARGUMENT");
    // schema 层面直接钉死：strict 形状拒绝额外键
    expect(
      WorkspaceExportRequestSchema.safeParse({ runId: ROOT_RUN, blobRoot: "D:/evil" }).success,
    ).toBe(false);
    expect(deps.pickCalls()).toBe(0);
  });

  it("缺 runId / 非字符串 stepSpanId：形状非法走信封失败", async () => {
    const deps = makeDeps();
    const missing = await exportWorkspaceEndpoint(deps, { stepSpanId: 1 });
    expect(missing.kind).toBe("envelope-failure");
    const badStep = await exportWorkspaceEndpoint(deps, { runId: ROOT_RUN, stepSpanId: 1 });
    expect(badStep.kind).toBe("envelope-failure");
    expect(deps.pickCalls()).toBe(0);
  });

  it("ownOnly（ghost 父链）：早期来源检查拒绝（RUN_LINEAGE_INCOMPLETE），对话框未打开", async () => {
    const deps = makeDeps();
    const result = await exportWorkspaceEndpoint(deps, { runId: GHOST_RUN });
    expect(result.kind).toBe("outcome");
    if (result.kind !== "outcome") return;
    const outcome = WorkspaceExportOutcomeSchema.parse(result.outcome);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe("RUN_LINEAGE_INCOMPLETE");
    expect(outcome.reason).toContain("导出来源不完整");
    expect(outcome.reason).toContain("run_export_missing_parent");
    expect(deps.pickCalls()).toBe(0);
  });

  it("损坏 trace：RUN_DETAIL_UNREADABLE 且对话框未打开", async () => {
    const deps = makeDeps();
    const result = await exportWorkspaceEndpoint(deps, { runId: "run_export_bad" });
    expect(result.kind).toBe("outcome");
    if (result.kind !== "outcome") return;
    const outcome = WorkspaceExportOutcomeSchema.parse(result.outcome);
    expect(outcome).toMatchObject({ status: "failed", code: "RUN_DETAIL_UNREADABLE" });
    expect(deps.pickCalls()).toBe(0);
  });

  it("普通无 workspace run：父链完整放行到包层，包层拒绝 no_workspace（main 不重复校验）", async () => {
    const deps = makeDeps();
    const result = await exportWorkspaceEndpoint(deps, { runId: PLAIN_RUN });
    expect(result.kind).toBe("outcome");
    if (result.kind !== "outcome") return;
    const outcome = WorkspaceExportOutcomeSchema.parse(result.outcome);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe("no_workspace");
    // 对话框打开过（来源检查通过），但包层校验挡在写入前——目标保持空
    expect(deps.pickCalls()).toBe(1);
  });

  it("目录取消：canceled 零写入，包层未被调用，槽位释放", async () => {
    let exportCalls = 0;
    const deps = makeDeps({
      pickDirectory: async () => {
        pickCalls.push("pick");
        return null; // 用户取消
      },
      exportSnapshot: (async () => {
        exportCalls += 1;
        throw new Error("取消后不应调用包层");
      }) as typeof exportWorkspaceSnapshot,
    });
    const result = await exportWorkspaceEndpoint(deps, { runId: ROOT_RUN });
    expect(result.kind).toBe("outcome");
    if (result.kind !== "outcome") return;
    const outcome = WorkspaceExportOutcomeSchema.parse(result.outcome);
    expect(outcome).toEqual({ status: "canceled" });
    expect(exportCalls).toBe(0);
    // 槽位已释放：下一个请求可正常走到包层桩
    const second = await exportWorkspaceEndpoint(
      makeDeps({ exportSnapshot: deps.exportSnapshot }),
      { runId: ROOT_RUN },
    );
    expect(second.kind).toBe("outcome");
  });

  it("对话框期间父链变化：早期通过、返回后重验失败 → RUN_LINEAGE_INCOMPLETE 零写入", async () => {
    let resolvePick!: (value: string | null) => void;
    const pending = new Promise<string | null>((resolve) => {
      resolvePick = resolve;
    });
    const deps = makeDeps({
      pickDirectory: async () => {
        pickCalls.push("pick");
        return pending;
      },
    });
    // 对话框打开期间，祖先 trace（root）被删除——用例结束前还原，不污染共享 fixture
    const rootTrace = join(tracesDir, `${ROOT_RUN}.jsonl`);
    const backup = readFileSync(rootTrace);
    rmSync(rootTrace);
    try {
      const inFlight = exportWorkspaceEndpoint(deps, { runId: CHILD_RUN });
      resolvePick(newTarget("changed-lineage"));

      const result = await inFlight;
      expect(result.kind).toBe("outcome");
      if (result.kind !== "outcome") return;
      const outcome = WorkspaceExportOutcomeSchema.parse(result.outcome);
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.code).toBe("RUN_LINEAGE_INCOMPLETE");
      expect(outcome.retained).toEqual([]);
    } finally {
      writeFileSync(rootTrace, backup);
    }
  });

  it("成功导出：outcome 过严格 schema、目标字节正确、dataDir 指纹不变", async () => {
    const { createHash } = await import("node:crypto");
    const fingerprint = (dir: string): string => {
      const walk = (root: string, prefix: string): string[] => {
        const out: string[] = [];
        for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
          a.name < b.name ? -1 : 1,
        )) {
          const full = join(root, entry.name);
          if (entry.isDirectory()) {
            out.push(...walk(full, `${prefix}${entry.name}/`));
          } else {
            const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
            out.push(`${prefix}${entry.name}:${hash}`);
          }
        }
        return out;
      };
      return walk(dir, "").join("\n");
    };
    const before = fingerprint(dataDir);

    const target = newTarget("success");
    const deps = makeDeps({
      pickDirectory: async () => {
        pickCalls.push("pick");
        return target;
      },
    });
    const result = await exportWorkspaceEndpoint(deps, {
      runId: ROOT_RUN,
      stepSpanId: rootStepSpanId,
    });
    expect(result.kind).toBe("outcome");
    if (result.kind !== "outcome") return;
    const outcome = WorkspaceExportOutcomeSchema.parse(result.outcome);
    expect(outcome.status).toBe("exported");
    if (outcome.status !== "exported") return;
    expect(outcome.fileCount).toBe(1);
    expect(outcome.filesRoot).toBe("files");
    expect(readFileSync(join(target, "files", "a.txt"), "utf8")).toBe("after");
    expect(outcome.patch.status).toBe("written");
    expect(outcome.unpreserved.permissions).toContain("未保留");
    expect(fingerprint(dataDir)).toBe(before);
  });

  it("同 main 在飞保护：在飞重复请求立即拒绝且不开第二个对话框；结束后槽位释放", async () => {
    let resolvePick!: (value: string | null) => void;
    const pending = new Promise<string | null>((resolve) => {
      resolvePick = resolve;
    });
    const deps = makeDeps({
      pickDirectory: async () => {
        pickCalls.push("pick");
        return pending;
      },
    });
    const first = exportWorkspaceEndpoint(deps, { runId: ROOT_RUN, stepSpanId: rootStepSpanId });
    // 第一次还在对话框里：第二次请求立即被在飞保护拒绝
    const second = await exportWorkspaceEndpoint(deps, { runId: ROOT_RUN });
    expect(second.kind).toBe("outcome");
    if (second.kind !== "outcome") return;
    const secondOutcome = WorkspaceExportOutcomeSchema.parse(second.outcome);
    expect(secondOutcome).toMatchObject({
      status: "failed",
      code: WORKSPACE_EXPORT_IN_FLIGHT,
    });
    expect(deps.pickCalls()).toBe(1); // 第二个对话框从未打开

    resolvePick(newTarget("inflight"));
    const firstResult = await first;
    expect(firstResult.kind).toBe("outcome");
    if (firstResult.kind !== "outcome") return;
    expect(WorkspaceExportOutcomeSchema.parse(firstResult.outcome).status).toBe("exported");

    // 槽位已释放：第三个请求可正常进行（取消路径）
    const third = await exportWorkspaceEndpoint(makeDeps({ pickDirectory: async () => null }), {
      runId: ROOT_RUN,
    });
    expect(third.kind).toBe("outcome");
    if (third.kind !== "outcome") return;
    expect(WorkspaceExportOutcomeSchema.parse(third.outcome)).toEqual({ status: "canceled" });
  });

  it("包层失败透传：稳定码 + 受控原因 + 清理残留相对路径", async () => {
    const deps = makeDeps({
      exportSnapshot: (async () => ({
        ok: false as const,
        failure: { code: "io" as const, reason: "注入的写入故障" },
        cleanup: {
          removed: ["files/a.txt"],
          retained: [{ path: "changes.patch", reason: "删除失败" }],
          complete: false,
        },
      })) as unknown as typeof exportWorkspaceSnapshot,
    });
    const result = await exportWorkspaceEndpoint(deps, {
      runId: ROOT_RUN,
      stepSpanId: rootStepSpanId,
    });
    expect(result.kind).toBe("outcome");
    if (result.kind !== "outcome") return;
    const outcome = WorkspaceExportOutcomeSchema.parse(result.outcome);
    expect(outcome).toEqual({
      status: "failed",
      code: "io",
      reason: "注入的写入故障",
      retained: ["changes.patch"],
    });
  });

  it("端点兜底：包层抛出的意外异常收敛为受控失败（WORKSPACE_EXPORT_FAILED），不跨进程抛", async () => {
    const deps = makeDeps({
      exportSnapshot: (async () => {
        throw new Error("意外的崩溃");
      }) as unknown as typeof exportWorkspaceSnapshot,
    });
    const result = await exportWorkspaceEndpoint(deps, {
      runId: ROOT_RUN,
      stepSpanId: rootStepSpanId,
    });
    expect(result.kind).toBe("outcome");
    if (result.kind !== "outcome") return;
    const outcome = WorkspaceExportOutcomeSchema.parse(result.outcome);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe(WORKSPACE_EXPORT_FAILED);
    expect(outcome.reason).toContain("意外的崩溃");
  });
});
