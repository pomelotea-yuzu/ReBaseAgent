import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { configHash } from "@rebaseagent/agent-loop";
import { readRun } from "@rebaseagent/trace-sdk";
import type { AgentStepSpan, RunRecord, ToolInvokeSpan } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  WORKSPACE_TRACES_DIR_NAME,
  createIsolatedRun,
  preflightIsolatedReplay,
  replayIsolatedRun,
} from "../src/index";
import type { FileToolDefinition, IsolatedPreflightOptions, ReplayEdit } from "../src/index";
import {
  SYSTEM_PROMPT,
  ScriptedLlm,
  asLoopLlm,
  makeConfig,
  readCall,
  writeCall,
} from "./isolated-helpers";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * 4.2：隔离能力预检（`preflightIsolatedReplay`）。
 *
 * 验证点（tasks.md 4.2）：`replay/缺检查点与祖先编辑点拒绝`、`崩溃的 run 拒绝分叉`、
 * `源代码变化拒绝分叉`、`分叉点必须是被编辑的 tool.invoke`，**拒绝零子 trace / 零 LLM**；
 * 另覆盖 `workspace-isolation/隔离能力预检无执行副作用`。
 *
 * ## fixture 策略：真父本 + 定向破坏
 *
 * 正向的父本一律由 4.1 的 `createIsolatedRun` **真跑**出来（真导入、真受控工具、真 runLoop、
 * 真落盘）——这样预检消费的是真实产物，而不是"手写的、看起来像真 run 的 JSONL"。
 * 拒绝类用例在这份真父本上做**单点破坏**（截掉终止事件、删某一行、删附件、改一个字节），
 * 每个用例只改一件事，因此失败原因统一、断言不会互相掩盖。
 *
 * "祖先共享前缀的编辑点"需要一个**分叉 run** 当叶子：现在用 4.3 的 `replayIsolatedRun` 真分叉
 * （4.2 落地时它还不存在，当时用手写 JSONL 桩顶着；桩与写入端契约脱节，已按 4.4 的计划换掉）。
 *
 * ## 零副作用的判据是**目录树指纹**
 *
 * 断言"预检前后整个 dataDir 的相对路径 + 字节数 + 内容哈希完全一致"——比"traces 目录没多文件"
 * 强得多：它同时覆盖"不写 trace、不写附件、不建目录、不改已落盘内容"。
 */

const EDIT: ReplayEdit = { field: "result", value: "编辑后的结果" };

/** 父本脚本：**一轮两个工具**（同轮兄弟）+ 第二轮收尾，用于覆盖整轮边界 */
const PARENT_SCRIPT = [
  { toolCalls: [writeCall("call_1", "a.txt", "A"), writeCall("call_2", "b.txt", "B")] },
  { content: "完成了" },
];

interface ParentFixture {
  readonly source: string;
  readonly dataDir: string;
  readonly parentId: string;
  readonly traceFile: string;
  readonly record: RunRecord;
  /** 第 1 轮的 step（检查点所在） */
  readonly step1: AgentStepSpan;
  /** 第 1 轮的两个工具调用（同轮兄弟） */
  readonly tool1: ToolInvokeSpan;
  readonly tool2: ToolInvokeSpan;
}

/** 用 4.1 的编排造一个**真实**隔离根 run 作为预检对象 */
async function makeIsolatedParent(script = PARENT_SCRIPT): Promise<ParentFixture> {
  const source = makeTempDir("preflight-src-");
  writeTree(source, { "seed.txt": "seed" });
  const dataDir = join(makeTempDir("preflight-data-"), "data");

  const created = await createIsolatedRun({
    dataDir,
    source,
    config: makeConfig(),
    userMessage: "把两个文件写进工作区",
    authority: { allowFileWrites: true },
    llm: asLoopLlm(new ScriptedLlm([...script])),
  });
  if (!created.ok) {
    throw new Error(`父本创建失败：${created.failure.code} ${created.failure.reason}`);
  }

  const traceFile = join(dataDir, WORKSPACE_TRACES_DIR_NAME, `${created.id}.jsonl`);
  const record = readRun(traceFile);
  const steps = record.spans.filter((span): span is AgentStepSpan => span.kind === "agent.step");
  const step1 = steps.find((span) => span.n === 1);
  const tools = record.spans.filter(
    (span): span is ToolInvokeSpan => span.kind === "tool.invoke" && span.parent === step1?.id,
  );
  const [tool1, tool2] = tools;
  if (step1 === undefined || tool1 === undefined || tool2 === undefined) {
    throw new Error("父本 fixture 结构不符预期：缺少第 1 轮 step 或同轮两个工具");
  }
  return { source, dataDir, parentId: created.id, traceFile, record, step1, tool1, tool2 };
}

/** 用默认参数发起预检（用例只关心自己要覆盖的那一项） */
function preflight(
  fixture: Pick<ParentFixture, "dataDir" | "parentId" | "tool1">,
  overrides: Partial<IsolatedPreflightOptions> = {},
) {
  return preflightIsolatedReplay({
    dataDir: fixture.dataDir,
    parentId: fixture.parentId,
    atSpanId: fixture.tool1.id,
    edit: EDIT,
    config: makeConfig(),
    ...overrides,
  });
}

// ── JSONL 定向破坏工具（每个用例只改一件事）────────────────────────────────────────────

function readTraceLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** 逐行改写（返回 null 即删除该行），写回时保持 JSONL 形态 */
function rewriteTrace(
  file: string,
  transform: (line: Record<string, unknown>) => Record<string, unknown> | null,
): void {
  const out: string[] = [];
  for (const raw of readTraceLines(file)) {
    const next = transform(JSON.parse(raw) as Record<string, unknown>);
    if (next !== null) {
      out.push(JSON.stringify(next));
    }
  }
  writeFileSync(file, `${out.join("\n")}\n`);
}

/** 目录树指纹：相对路径 + 字节数 + 内容哈希（零副作用的判据） */
function treeFingerprint(root: string): string[] {
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
        out.push(
          `${relative(root, full)}|${stats.size}|${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
        );
      }
    }
  };
  walk(root);
  return out.sort();
}

/** 手写一个 v1 普通 run（非隔离），用于"旧格式父本拒绝" */
function writeV1Run(dataDir: string, runId: string): void {
  const file = join(dataDir, WORKSPACE_TRACES_DIR_NAME, `${runId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const lines: Array<Record<string, unknown>> = [
    {
      type: "run.meta",
      id: runId,
      format_version: 1,
      task: "v1 普通 run",
      model: "deepseek-chat",
      created_at: "2026-09-19T00:00:00.000Z",
      parent: null,
      fork: null,
      config_hash: configHash(SYSTEM_PROMPT, [...FILE_TOOLS_V1_DEFINITIONS]),
    },
    { type: "span", id: "s_01", parent: null, kind: "agent.step", n: 1 },
    {
      type: "span",
      id: "s_02",
      parent: "s_01",
      kind: "tool.invoke",
      tool: "write_file",
      args: {},
      result: "ok",
      dur_ms: 1,
      error: null,
    },
    { type: "run.event", event: "stopped", reason: "completed", at: 0 },
  ];
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

/** 起点清单里某个文件的附件物理路径 */
function blobPath(dataDir: string, sha256: string): string {
  return join(dataDir, "workspace-blobs", "sha256", sha256);
}

afterEach(cleanupTempDirs);

describe("preflightIsolatedReplay：可用时返回起点数据", () => {
  it("对真实隔离根 run 给出完整能力数据", async () => {
    const fixture = await makeIsolatedParent();

    const result = await preflight(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const capability = result.value;

    expect(capability.parentId).toBe(fixture.parentId);
    expect(capability.atSpanId).toBe(fixture.tool1.id);
    expect(capability.stepSpanId).toBe(fixture.step1.id);
    expect(capability.ownerRunId).toBe(fixture.parentId);
    expect(capability.localIteration).toBe(1);
    // **本次续跑世界**的来源：由"父身份 + 边界 step"推导，与父本自己的 origin（import）无关
    expect(capability.origin).toEqual({
      kind: "checkpoint",
      run_id: fixture.parentId,
      step_span: fixture.step1.id,
    });
    expect(capability.configHash).toBe(configHash(SYSTEM_PROMPT, [...FILE_TOOLS_V1_DEFINITIONS]));

    // 起点清单 = 第 1 轮**全部工具完成后**的状态（含同轮两个工具的效果）
    expect(capability.snapshot.files.map((file) => file.path)).toEqual([
      "a.txt",
      "b.txt",
      "seed.txt",
    ]);
    expect(capability.fileCount).toBe(3);
    expect(capability.totalBytes).toBe(1 + 1 + 4); // A / B / seed
    expect(capability.snapshot.id).toBe(fixture.step1.workspace_snapshot?.id);
    expect(capability.records).toHaveLength(1);
    expect(capability.records[0]?.meta.id).toBe(fixture.parentId);
  });

  it("预检零执行副作用：合法父本与不可用父本都不动 dataDir 一个字节", async () => {
    const fixture = await makeIsolatedParent();
    const before = treeFingerprint(fixture.dataDir);
    expect(before.length).toBeGreaterThan(0);

    const usable = await preflight(fixture);
    expect(usable.ok).toBe(true);
    expect(treeFingerprint(fixture.dataDir)).toEqual(before);

    const unusable = await preflight(fixture, { parentId: "run_does_not_exist" });
    expect(unusable.ok).toBe(false);
    expect(treeFingerprint(fixture.dataDir)).toEqual(before);
  });

  it("同一输入重复预检结论一致（提交时会重新预检）", async () => {
    const fixture = await makeIsolatedParent();

    const first = await preflight(fixture);
    const second = await preflight(fixture);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.stepSpanId).toBe(first.value.stepSpanId);
      expect(second.value.snapshot).toEqual(first.value.snapshot);
    }
  });
});

describe("preflightIsolatedReplay：父本不可用", () => {
  it("父 run 不存在 → parent_chain_invalid", async () => {
    const fixture = await makeIsolatedParent();

    const result = await preflight(fixture, { parentId: "run_missing" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("parent_chain_invalid");
      expect(result.failure.reason).toContain("run_missing");
    }
  });

  it("缺检查点的记录读不出来 → 以父链加载失败拒绝（缺快照不被兜底）", async () => {
    const fixture = await makeIsolatedParent();
    // 删掉该 step 的 workspace_snapshot：reader 的 v2 跨行约束会直接拒绝这条记录
    rewriteTrace(fixture.traceFile, (line) => {
      if (line.type === "span" && line.id === fixture.step1.id) {
        const copy = { ...line };
        // JSON.stringify 会略去 undefined 值 ⇒ 产物里该键被真正删除
        copy.workspace_snapshot = undefined;
        return copy;
      }
      return line;
    });

    const result = await preflight(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("parent_chain_invalid");
      // 关键：拒绝理由指向"必须携带 workspace_snapshot"，而不是拿父 run 最终状态顶替
      expect(result.failure.reason).toContain("workspace_snapshot");
    }
  });

  it("崩溃的 run（缺终止事件）→ parent_not_forkable", async () => {
    const fixture = await makeIsolatedParent();
    rewriteTrace(fixture.traceFile, (line) => (line.type === "run.event" ? null : line));

    const result = await preflight(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("parent_not_forkable");
      expect(result.failure.reason).toContain("只能从已完成的 run 分支");
    }
  });

  it("v1 普通 run 不能作隔离父本 → parent_not_isolated", async () => {
    const fixture = await makeIsolatedParent();
    writeV1Run(fixture.dataDir, "run_v1_plain");

    const result = await preflight(fixture, { parentId: "run_v1_plain" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("parent_not_isolated");
      expect(result.failure.reason).toContain("不是隔离 run");
    }
  });

  it("起点附件缺失 → attachment_missing（不从源目录补齐）", async () => {
    const fixture = await makeIsolatedParent();
    const target = fixture.step1.workspace_snapshot?.files.find((file) => file.path === "a.txt");
    expect(target).toBeDefined();
    rmSync(blobPath(fixture.dataDir, target?.sha256 ?? ""), { force: true });

    const result = await preflight(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("attachment_missing");
      expect(result.failure.reason).toContain("a.txt");
    }
  });

  it("起点附件被篡改 → attachment_corrupt", async () => {
    const fixture = await makeIsolatedParent();
    const target = fixture.step1.workspace_snapshot?.files.find((file) => file.path === "b.txt");
    expect(target).toBeDefined();
    // 同长度改写：长度校验过不了才轮得到哈希，这里刻意让两条都动不了手脚
    writeFileSync(blobPath(fixture.dataDir, target?.sha256 ?? ""), "Z");

    const result = await preflight(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("attachment_corrupt");
      expect(result.failure.reason).toContain("b.txt");
    }
  });
});

describe("preflightIsolatedReplay：分叉点与编辑值", () => {
  it("分叉点不存在 → invalid_edit_point", async () => {
    const fixture = await makeIsolatedParent();

    const result = await preflight(fixture, { atSpanId: "s_999" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_edit_point");
      expect(result.failure.reason).toContain("不存在于父 run");
    }
  });

  it("分叉点不是 tool.invoke → invalid_edit_point", async () => {
    const fixture = await makeIsolatedParent();

    const result = await preflight(fixture, { atSpanId: fixture.step1.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_edit_point");
      expect(result.failure.reason).toContain("必须是 tool.invoke");
    }
  });

  it("编辑点落在祖先共享前缀 → ancestor_edit_point（真实分叉链）", async () => {
    const fixture = await makeIsolatedParent();

    // 用 4.3 的编排真分叉出一个子 run 当叶子（不再手写 JSONL：手写版会与写入端契约脱节）
    const childResult = await replayIsolatedRun({
      dataDir: fixture.dataDir,
      parentId: fixture.parentId,
      atSpanId: fixture.tool1.id,
      edit: { field: "result", value: "第一层编辑" },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(
        new ScriptedLlm([{ toolCalls: [readCall("r1", "a.txt")] }, { content: "done" }]),
      ),
    });
    expect(childResult.ok).toBe(true);
    if (!childResult.ok) {
      return;
    }
    const childRecord = readRun(
      join(fixture.dataDir, WORKSPACE_TRACES_DIR_NAME, `${childResult.id}.jsonl`),
    );
    const childTool = childRecord.spans.find((span) => span.kind === "tool.invoke");
    expect(childTool).toBeDefined();

    // 叶是子 run，请求却编辑**祖先（根 run）**的工具点
    const ancestor = await preflight(
      { dataDir: fixture.dataDir, parentId: childResult.id, tool1: fixture.tool1 },
      { atSpanId: fixture.tool1.id },
    );

    expect(ancestor.ok).toBe(false);
    if (!ancestor.ok) {
      expect(ancestor.failure.code).toBe("ancestor_edit_point");
      expect(ancestor.failure.reason).toContain(fixture.parentId);
    }

    // 对照：编辑叶子**自有**的工具点，预检真的通过 —— 证明失败确实来自"祖先"而非别的原因
    const own = await preflight(
      { dataDir: fixture.dataDir, parentId: childResult.id, tool1: fixture.tool1 },
      { atSpanId: childTool?.id ?? "", edit: { field: "result", value: "改了" } },
    );
    expect(own.ok).toBe(true);
  });

  it("编辑字段或取值非法 → invalid_edit", async () => {
    const fixture = await makeIsolatedParent();

    const badField = await preflight(fixture, {
      edit: { field: "content" } as unknown as ReplayEdit,
    });
    expect(badField.ok).toBe(false);
    if (!badField.ok) {
      expect(badField.failure.code).toBe("invalid_edit");
    }

    const badValue = await preflight(fixture, {
      edit: { field: "result", value: 42 } as unknown as ReplayEdit,
    });
    expect(badValue.ok).toBe(false);
    if (!badValue.ok) {
      expect(badValue.failure.code).toBe("invalid_edit");
    }
  });

  it("编辑前后相同（空 fork）→ derive_failed", async () => {
    const fixture = await makeIsolatedParent();
    const original = fixture.tool1.result;

    const result = await preflight(fixture, {
      edit: { field: "result", value: String(original) },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("derive_failed");
      expect(result.failure.reason).toContain("空 fork 被拒绝");
    }
  });
});

describe("preflightIsolatedReplay：批次完整性与源码一致性", () => {
  it("该轮缺 llm.call → incomplete_tool_batch", async () => {
    const fixture = await makeIsolatedParent();
    rewriteTrace(fixture.traceFile, (line) =>
      line.type === "span" && line.kind === "llm.call" && line.parent === fixture.step1.id
        ? null
        : line,
    );

    const result = await preflight(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("incomplete_tool_batch");
      expect(result.failure.reason).toContain("缺少 llm.call");
    }
  });

  it("同轮兄弟工具少录一个 → incomplete_tool_batch（整轮边界无法复原）", async () => {
    const fixture = await makeIsolatedParent();
    rewriteTrace(fixture.traceFile, (line) =>
      line.type === "span" && line.id === fixture.tool2.id ? null : line,
    );

    const result = await preflight(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("incomplete_tool_batch");
      expect(result.failure.reason).toContain("工具批次不完整");
    }
  });

  it("system prompt 变化 → source_changed", async () => {
    const fixture = await makeIsolatedParent();

    const result = await preflight(fixture, { config: makeConfig("换了个 system prompt") });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("source_changed");
      expect(result.failure.reason).toContain("config_hash 不一致");
    }
  });

  it("工具定义被改写（删 sideEffect）→ profile_mismatch", async () => {
    const fixture = await makeIsolatedParent();
    const config = makeConfig();
    const [read, write] = FILE_TOOLS_V1_DEFINITIONS as readonly FileToolDefinition[];
    config.tools = [
      {
        name: read?.name ?? "",
        description: read?.description ?? "",
        parameters: read?.parameters ?? {},
        sideEffect: false,
      },
      {
        name: write?.name ?? "",
        description: write?.description ?? "",
        parameters: write?.parameters ?? {},
      },
    ];

    const result = await preflight(fixture, { config });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("profile_mismatch");
    }
  });

  it("参数形状非法 → invalid_request", async () => {
    const fixture = await makeIsolatedParent();

    const emptyParent = await preflight(fixture, { parentId: "" });
    expect(emptyParent.ok).toBe(false);
    if (!emptyParent.ok) {
      expect(emptyParent.failure.code).toBe("invalid_request");
    }

    const emptyAtSpan = await preflight(fixture, { atSpanId: "" });
    expect(emptyAtSpan.ok).toBe(false);
    if (!emptyAtSpan.ok) {
      expect(emptyAtSpan.failure.code).toBe("invalid_request");
    }

    const emptyDataDir = await preflight(fixture, { dataDir: "" });
    expect(emptyDataDir.ok).toBe(false);
    if (!emptyDataDir.ok) {
      expect(emptyDataDir.failure.code).toBe("invalid_request");
    }
  });
});
