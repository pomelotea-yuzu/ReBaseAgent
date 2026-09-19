import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  AgentStepSpan,
  RunRecord,
  ToolInvokeSpan,
  WorkspaceFile,
} from "@rebaseagent/trace-sdk";
import { readRun } from "@rebaseagent/trace-sdk";
import {
  WORKSPACE_BLOBS_DIR_NAME,
  createIsolatedRun,
  replayIsolatedRun,
  workspaceTraceFile,
} from "../src/index";
import { ScriptedLlm, asLoopLlm, makeConfig, writeCall } from "./isolated-helpers";
import type { ScriptedTurn } from "./isolated-helpers";
import { makeTempDir, writeTree } from "./workspace-helpers";

/**
 * **包 API 三轮 fixture**（before → middle → after）。
 *
 * tasks.md 7.1 要求"新增包 API 三轮 fixture：分叉恢复 middle 后写 child，断言源目录、
 * 父 trace/附件及兄弟哈希不变"。这里交付的是可复用的那部分：一个真跑出来的三轮隔离根 run +
 * 包 API 层面的指纹工具，供 7.1 的用例使用，也供后续包级回归（dataDir 迁移、重新加载）复用。
 *
 * ## 与 4.3 / 4.4 的分工（为什么又有一份 fixture）
 *
 * 4.3 验的是单次分叉的**消息与文件起点语义**（子读到 middle 而不是 after）；4.4 验的是
 * 三层链与兄弟并发。两者都只断言**父 trace 文件**逐字节不变。7.1 把不变性的断言面扩到
 * **父的附件存储**与**兄弟文件哈希**，并且只用 `../src/index` 的导出面——即"从包外看得到的东西"。
 * 所以这里不是重复 4.3/4.4，而是补它们没有的那一层证据。
 *
 * ## 只走包 API
 *
 * 本文件不 import `../src/workspace/*` 任何内部模块：造父本用 `createIsolatedRun`、分叉用
 * `replayIsolatedRun`、定位 trace 用 `workspaceTraceFile`。这样用例断言的每一条不变性，
 * 都是**包使用者**能观察到的不变性。
 */

/** 源目录初始内容：`before` 是分叉点**之前**的状态，`keep.txt` 是全程无人改动的旁观文件 */
export const FIXTURE_TREE: Readonly<Record<string, string>> = {
  "a.txt": "before",
  "keep.txt": "keep",
};

export const BEFORE = "before";
export const MIDDLE = "middle";
export const AFTER = "after";
export const SIBLING = "sibling";
export const CHILD = "child";

/**
 * 三轮剧本：
 * - 轮 1 同轮两个**兄弟工具**（T1 写 `a.txt=middle`、T2 写 `b.txt=sibling`）⇒ 轮末检查点即分叉起点；
 * - 轮 2 覆盖 `a.txt=after` ⇒ 与轮 1 形成"中间态 vs 最终态"的对照；
 * - 轮 3 无工具，loop 收尾。
 */
export const THREE_ROUND_SCRIPT: readonly ScriptedTurn[] = [
  { toolCalls: [writeCall("t1", "a.txt", MIDDLE), writeCall("t2", "b.txt", SIBLING)] },
  { toolCalls: [writeCall("t3", "a.txt", AFTER)] },
  { content: "done" },
];

export interface ThreeRoundParent {
  readonly dataDir: string;
  readonly source: string;
  readonly runId: string;
  readonly traceFile: string;
  readonly record: RunRecord;
  /** 三轮 `agent.step`（索引 0 = 轮 1） */
  readonly steps: readonly AgentStepSpan[];
  /** 轮 1 的 step（分叉边界） */
  readonly step1: AgentStepSpan;
  /** 轮 1 的两个工具，`[0]` 是默认分叉点（写 `a.txt`） */
  readonly tools1: readonly ToolInvokeSpan[];
}

/** 真跑一个三轮隔离根 run（真导入 → 真受控工具 → 真 loop → 真落盘） */
export async function createThreeRoundParent(): Promise<ThreeRoundParent> {
  const source = makeTempDir("pkg-fixture-src-");
  writeTree(source, FIXTURE_TREE);
  const dataDir = join(makeTempDir("pkg-fixture-data-"), "data");

  const created = await createIsolatedRun({
    dataDir,
    source,
    config: makeConfig(),
    userMessage: "三轮 fixture",
    authority: { allowFileWrites: true },
    llm: asLoopLlm(new ScriptedLlm([...THREE_ROUND_SCRIPT])),
  });
  if (!created.ok) {
    throw new Error(`三轮父本创建失败：${created.failure.code} ${created.failure.reason}`);
  }

  const traceFile = workspaceTraceFile(dataDir, created.id);
  const record = readRun(traceFile);
  const steps = stepsOf(record);
  const step1 = steps.find((step) => step.n === 1);
  if (step1 === undefined) {
    throw new Error("三轮 fixture 结构不符预期：缺少轮 1 的 agent.step");
  }
  const tools1 = toolsOf(record, step1.id);
  if (tools1.length !== 2) {
    throw new Error(`三轮 fixture 结构不符预期：轮 1 应有 2 个工具，实际 ${tools1.length}`);
  }
  return { dataDir, source, runId: created.id, traceFile, record, steps, step1, tools1 };
}

/** 从父本的轮 1 工具点分叉（默认编辑 T1 的 result） */
export function forkFromParent(
  parent: ThreeRoundParent,
  options: {
    readonly llm: unknown;
    readonly atSpanId?: string;
    readonly editValue?: string;
    readonly authority?: unknown;
  },
) {
  return replayIsolatedRun({
    dataDir: parent.dataDir,
    parentId: parent.runId,
    atSpanId: options.atSpanId ?? parent.tools1[0]?.id ?? "",
    edit: { field: "result", value: options.editValue ?? "编辑后的工具结果" },
    config: makeConfig(),
    authority: options.authority ?? { allowFileWrites: true },
    llm: asLoopLlm(options.llm),
  });
}

// ── 判据工具 ─────────────────────────────────────────────────────────────────────────

export function sha256OfFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 目录树指纹：相对路径 | 字节数 | 内容 sha256（排序后返回）。
 *
 * 比"文件个数没变"强得多——覆盖了"文件被换了内容"和"文件被另一个同名文件顶替"。
 * 相对路径一律规范成 `/`（指纹是**逻辑形状**，不该随宿主分隔符变化；用例会把条目内容
 * 拆出来与 `sha256/<hash>` 比对，用反斜杠会让断言在 Windows 上莫名其妙地红）。
 */
export function treeFingerprint(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of [...readdirSync(dir)].sort()) {
      const full = join(dir, name);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else {
        const rel = relative(root, full).replaceAll("\\", "/");
        out.push(`${rel}|${stats.size}|${sha256OfFile(full)}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** 附件存储指纹（`<dataDir>/workspace-blobs` 的目录树指纹），条目形如 `sha256/<hash>|<size>|<hash>` */
export function blobFingerprint(dataDir: string): string[] {
  return treeFingerprint(join(dataDir, WORKSPACE_BLOBS_DIR_NAME));
}

/** 指纹条目里的逻辑相对路径（`sha256/<hash>`） */
export function entryPath(entry: string): string {
  return entry.split("|")[0] ?? "";
}

/** 附件指纹里出现的全部附件路径 */
export function blobPaths(fingerprint: readonly string[]): string[] {
  return fingerprint.map(entryPath);
}

export function stepsOf(record: RunRecord): AgentStepSpan[] {
  return record.spans.filter((span): span is AgentStepSpan => span.kind === "agent.step");
}

export function toolsOf(record: RunRecord, stepId?: string): ToolInvokeSpan[] {
  return record.spans.filter(
    (span): span is ToolInvokeSpan =>
      span.kind === "tool.invoke" && (stepId === undefined || span.parent === stepId),
  );
}

/** 某份清单里某个逻辑路径的条目 */
export function fileOf(
  files: readonly WorkspaceFile[] | undefined,
  path: string,
): WorkspaceFile | undefined {
  return (files ?? []).find((file) => file.path === path);
}

/** 某轮检查点里 `逻辑路径 → sha256`（便于整体比对"哪些文件变过"） */
export function hashMapOf(step: AgentStepSpan | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of step?.workspace_snapshot?.files ?? []) {
    out[file.path] = file.sha256;
  }
  return out;
}
