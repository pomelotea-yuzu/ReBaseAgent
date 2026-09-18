import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import type { WorkspaceFile } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { createWorkspaceBlobStore } from "../src/workspace/blob-store";

/**
 * 隔离运行 fixture 构造器（仅供 workspace 相关用例使用）。
 *
 * 造的是**真的**事实链：附件先经 blob store 真发布（拿到真实哈希），再把哈希写进 v2 trace 的
 * 清单里。这样读接口的"先校验清单 id、再校验附件字节"两条都会真的被走到——手填哈希的 fixture
 * 只能测出前一条。
 */

/** 一个临时 dataDir（用完必须 cleanup） */
export interface TempDataDir {
  readonly dataDir: string;
  readonly cleanup: () => void;
}

export function makeDataDir(): TempDataDir {
  const dataDir = mkdtempSync(join(tmpdir(), "replay-workspace-"));
  return { dataDir, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

/** 一轮结束时的文件内容：逻辑路径 → 文本或原始字节 */
export type RoundContent = ReadonlyMap<string, string | Uint8Array>;

export interface WriteRunSpec {
  readonly dataDir: string;
  readonly runId: string;
  /** `[0]` = 初始快照；`[i]` = 第 i 轮结束时的**完整**清单（不是增量） */
  readonly rounds: readonly RoundContent[];
  /** 分支 run：父 run 与续跑边界（同时决定 `origin=checkpoint` 与 `fork.resume_after_step`） */
  readonly parent?: { readonly runId: string; readonly stepSpanId: string };
}

export interface WrittenRun {
  readonly runId: string;
  readonly traceFile: string;
  /** 各轮的清单条目（`[0]` 对应初始快照），顺序与 `spec.rounds` 一致 */
  readonly roundFiles: readonly WorkspaceFile[][];
  /** 各轮 step 的 `agent.step` span id（`[0]` 对应 `spec.rounds[1]`） */
  readonly stepSpanIds: readonly string[];
  /** 各轮 step 里那个 `tool.invoke` 的 span id（分支 fixture 的 `fork.at_span` 用它） */
  readonly toolSpanIds: readonly string[];
}

/**
 * 写出一个 v2 隔离 run（`.jsonl` + 它的全部附件）。
 *
 * 每轮除了 `agent.step`（带检查点）还会写一个 `tool.invoke`，代表"这一轮改了文件"的那次调用；
 * 分支 run 的 `fork.at_span` 因此可以指向父 run 里一个真实的工具 span。
 */
export async function writeIsolatedRun(spec: WriteRunSpec): Promise<WrittenRun> {
  const store = createWorkspaceBlobStore(spec.dataDir);
  const roundFiles: WorkspaceFile[][] = [];
  for (const round of spec.rounds) {
    const entries: WorkspaceFile[] = [];
    for (const [path, content] of round) {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      const published = await store.publish(bytes);
      entries.push({ path, sha256: published.sha256, bytes: published.bytes });
    }
    roundFiles.push(entries);
  }

  const initial = createWorkspaceSnapshot(roundFiles[0]);
  const traceFile = join(spec.dataDir, "traces", `${spec.runId}.jsonl`);
  // traces 目录由调用方（真实场景是桌面/编排层）准备，tracer 只负责写文件
  mkdirSync(join(spec.dataDir, "traces"), { recursive: true });

  const tracer = new JsonlTracer(traceFile);
  tracer.startRun({
    id: spec.runId,
    format_version: 2,
    task: "隔离运行 fixture",
    model: "deepseek-chat",
    created_at: "2026-09-18T00:00:00.000Z",
    parent: spec.parent?.runId ?? null,
    fork:
      spec.parent === undefined
        ? null
        : {
            // 该 span 的 kind 不参与本层校验（跨 run 的 span 关联是 4.x 预检的事）
            at_span: spec.parent.stepSpanId,
            resume_after_step: spec.parent.stepSpanId,
            edit: { field: "result", value: "编辑后的结果" },
          },
    workspace: {
      profile: "file-tools-v1",
      world_id: spec.runId,
      write_authorized: true,
      initial_snapshot: initial,
      origin:
        spec.parent === undefined
          ? { kind: "import" }
          : {
              kind: "checkpoint",
              run_id: spec.parent.runId,
              step_span: spec.parent.stepSpanId,
            },
    },
  });

  const stepSpanIds: string[] = [];
  const toolSpanIds: string[] = [];
  for (let round = 1; round < spec.rounds.length; round++) {
    const step = tracer.startSpan({ kind: "agent.step", n: round });
    const tool = tracer.startSpan({
      kind: "tool.invoke",
      parent: step,
      tool: "write_file",
      args: { path: `round-${round}.txt`, content: "…" },
    });
    tracer.endSpan(tool, { result: "已写入", dur_ms: 1, error: null });
    tracer.endSpan(step, { workspace_snapshot: createWorkspaceSnapshot(roundFiles[round]) });
    stepSpanIds.push(step);
    toolSpanIds.push(tool);
  }

  tracer.endRun({ event: "stopped", reason: "completed", at: spec.rounds.length - 1 });

  return { runId: spec.runId, traceFile, roundFiles, stepSpanIds, toolSpanIds };
}

/** 由路径与内容构造一份轮清单（保持插入顺序，便于写用例） */
export function round(entries: readonly (readonly [string, string | Uint8Array])[]): RoundContent {
  return new Map(entries);
}
