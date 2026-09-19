import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@rebaseagent/agent-loop";
import { readRun, resolveBranch } from "@rebaseagent/trace-sdk";
import type { AgentStepSpan, RunLoader, RunRecord, ToolInvokeSpan } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_TRACES_DIR_NAME, createIsolatedRun, replayIsolatedRun } from "../src/index";
import {
  ScriptedLlm,
  asLoopLlm,
  makeConfig,
  readCall,
  scriptedLlmResponse,
  writeCall,
} from "./isolated-helpers";
import type { ScriptedTurn } from "./isolated-helpers";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * 4.4：子分支再分叉与兄弟并发（集成）。
 *
 * 验证点（tasks.md 4.4）：`replay/分支 run 再分叉`、`父文件不可变`、`重跑遇工具报错`、
 * `新结果改变后续轨迹`，**源、父和兄弟逐字节不变**。
 *
 * ## 为什么是"集成"：全程真跑，只有 LLM 是桩
 *
 * 每个 run（根、子、孙）都由真实编排真跑：真导入 / 真受控工具 / 真 `runLoop` / 真落盘 /
 * 真 `resolveBranch` 展开。桩只提供"模型下一步做什么"的决策，而它恰好又充当"前缀零调用"的探针。
 *
 * ## 不变量的判据一律是**逐字节**
 *
 * "父文件不可变"用父 trace 的 sha256 前后比对；"源目录不变"用源文件内容与"源里不该出现的
 * 路径"双向断言；"兄弟互不影响"用**对方写的内容在自己 trace 里查不到**来判（而不是只看自己的
 * 读回值——那只证明自己对了，没证明没被串味）。
 */

const ROOT_SCRIPT: readonly ScriptedTurn[] = [
  { toolCalls: [writeCall("c1", "a.txt", "middle")] },
  { toolCalls: [writeCall("c2", "a.txt", "after")] },
  { content: "done" },
];

interface RootRun {
  readonly dataDir: string;
  readonly source: string;
  readonly id: string;
  readonly traceFile: string;
  readonly record: RunRecord;
  readonly step1: AgentStepSpan;
  readonly tools1: readonly ToolInvokeSpan[];
}

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function traceFileOf(dataDir: string, runId: string): string {
  return join(dataDir, WORKSPACE_TRACES_DIR_NAME, `${runId}.jsonl`);
}

function tracesDirOf(dataDir: string): string {
  return join(dataDir, WORKSPACE_TRACES_DIR_NAME);
}

/** 供 `resolveBranch` 用的加载器：只认该数据目录下的 run 文件 */
function loadOf(dataDir: string): RunLoader {
  return (id) => readRun(traceFileOf(dataDir, id));
}

function stepsOf(record: RunRecord): AgentStepSpan[] {
  return record.spans.filter((span): span is AgentStepSpan => span.kind === "agent.step");
}

function toolsOf(record: RunRecord, stepId?: string): ToolInvokeSpan[] {
  return record.spans.filter(
    (span): span is ToolInvokeSpan =>
      span.kind === "tool.invoke" && (stepId === undefined || span.parent === stepId),
  );
}

function seqOf(id: string): number {
  const m = /^s_(\d+)$/.exec(id);
  return m === null ? -1 : Number(m[1]);
}

function maxSeq(record: RunRecord): number {
  return record.spans.reduce((max, span) => Math.max(max, seqOf(span.id)), 0);
}

function minSeq(record: RunRecord): number {
  return record.spans.reduce((min, span) => Math.min(min, seqOf(span.id)), Number.MAX_SAFE_INTEGER);
}

function snapshotPaths(record: RunRecord, step: AgentStepSpan): string[] {
  return (step.workspace_snapshot?.files ?? []).map((file) => file.path);
}

/** 真跑一个三轮隔离根 run（轮 1 写 a=middle，轮 2 写 a=after） */
async function makeRoot(
  options: {
    readonly tree?: Record<string, string>;
    readonly script?: readonly ScriptedTurn[];
  } = {},
): Promise<RootRun> {
  const source = makeTempDir("isolated-44-src-");
  writeTree(source, options.tree ?? { "seed.txt": "seed" });
  const dataDir = join(makeTempDir("isolated-44-data-"), "data");

  const created = await createIsolatedRun({
    dataDir,
    source,
    config: makeConfig(),
    userMessage: "跑几轮",
    authority: { allowFileWrites: true },
    llm: asLoopLlm(new ScriptedLlm([...(options.script ?? ROOT_SCRIPT)])),
  });
  if (!created.ok) {
    throw new Error(`根 run 创建失败：${created.failure.code} ${created.failure.reason}`);
  }

  const traceFile = traceFileOf(dataDir, created.id);
  const record = readRun(traceFile);
  const step1 = stepsOf(record).find((step) => step.n === 1);
  const tools1 = toolsOf(record, step1?.id);
  if (step1 === undefined || tools1.length === 0) {
    throw new Error("根 fixture 结构不符预期");
  }
  return { dataDir, source, id: created.id, traceFile, record, step1, tools1 };
}

/** 从指定 run 的指定工具点分叉 */
function replayFrom(
  root: RootRun,
  options: {
    readonly parentId: string;
    readonly atSpanId: string;
    readonly editValue: string;
    readonly llm: unknown;
    readonly authority?: unknown;
  },
) {
  return replayIsolatedRun({
    dataDir: root.dataDir,
    parentId: options.parentId,
    atSpanId: options.atSpanId,
    edit: { field: "result", value: options.editValue },
    config: makeConfig(),
    authority: options.authority ?? { allowFileWrites: true },
    llm: asLoopLlm(options.llm),
  });
}

/** 按上下文决策的桩：用来证明"编辑后的结果真的改变了模型的下一步" */
class ReactiveLlm {
  readonly requests: Message[][] = [];
  private turn = 0;

  constructor(private readonly decideFirst: (messages: Message[]) => ScriptedTurn) {}

  async complete(messages: Message[]) {
    this.requests.push([...messages]);
    this.turn += 1;
    if (this.turn === 1) {
      return scriptedLlmResponse(this.decideFirst(messages));
    }
    if (this.turn === 2) {
      return scriptedLlmResponse({ toolCalls: [readCall("r2", "a.txt")] });
    }
    return scriptedLlmResponse({ content: "done" });
  }
}

afterEach(cleanupTempDirs);

describe("4.4 集成：分支 run 再分叉", () => {
  it("三层链的 parent / span 序号 / 起点检查点都正确，且两条父 trace 逐字节不变", async () => {
    const root = await makeRoot();
    const rootHash = sha256Of(root.traceFile);

    // ── child：从 root 轮 1 分叉；轮 1 读 a.txt（应得 middle），轮 2 写 c.txt ──────────
    const childLlm = new ScriptedLlm([
      { toolCalls: [readCall("r1", "a.txt")] },
      { toolCalls: [writeCall("w1", "c.txt", "child")] },
      { content: "done" },
    ]);
    const childResult = await replayFrom(root, {
      parentId: root.id,
      atSpanId: root.tools1[0]?.id ?? "",
      editValue: "第一层编辑",
      llm: childLlm,
    });
    expect(childResult.ok).toBe(true);
    if (!childResult.ok) {
      return;
    }
    const childFile = traceFileOf(root.dataDir, childResult.id);
    const child = readRun(childFile);
    const childHash = sha256Of(childFile);
    const childStep1 = stepsOf(child).find((step) => step.n === 1);
    const childTools1 = toolsOf(child, childStep1?.id);
    expect(childStep1).toBeDefined();
    expect(childTools1).toHaveLength(1);

    // ── grandchild：从 **child 轮 1** 分叉（那时 c.txt 还不存在）──────────────────────
    const grandLlm = new ScriptedLlm([
      { toolCalls: [readCall("g1", "a.txt")] },
      { content: "done" },
    ]);
    const grandResult = await replayFrom(root, {
      parentId: childResult.id,
      atSpanId: childTools1[0]?.id ?? "",
      editValue: "第二层编辑",
      llm: grandLlm,
    });
    expect(grandResult.ok).toBe(true);
    if (!grandResult.ok) {
      return;
    }
    const grand = readRun(traceFileOf(root.dataDir, grandResult.id));

    // ── parent 指向直接父；边界与 origin 都取直接父那一轮 ────────────────────────────
    expect(child.meta.parent).toBe(root.id);
    expect(grand.meta.parent).toBe(childResult.id);
    expect(grand.meta.fork?.resume_after_step).toBe(childStep1?.id);
    expect(grand.meta.workspace?.origin).toEqual({
      kind: "checkpoint",
      run_id: childResult.id,
      step_span: childStep1?.id,
    });

    // ── span 序号沿链不冲突（再分叉时叶优先按 id 查找的前提）──────────────────────────
    const rootIds = new Set(root.record.spans.map((span) => span.id));
    const childIds = child.spans.map((span) => span.id);
    const grandIds = grand.spans.map((span) => span.id);
    expect(childIds.some((id) => rootIds.has(id))).toBe(false);
    expect(grandIds.some((id) => childIds.includes(id) || rootIds.has(id))).toBe(false);
    expect(minSeq(grand)).toBeGreaterThan(maxSeq(child));

    // ── 起点的确是**child 轮 1** 的检查点：不含 c.txt（那是 child 轮 2 才写的）────────
    expect(grand.meta.workspace?.initial_snapshot.files.map((file) => file.path)).toEqual([
      "a.txt",
      "seed.txt",
    ]);
    const childLastStep = stepsOf(child)[stepsOf(child).length - 1];
    expect(childLastStep === undefined ? [] : snapshotPaths(child, childLastStep)).toEqual([
      "a.txt",
      "c.txt",
      "seed.txt",
    ]);
    // 孙读到的 a.txt 仍是 middle（child 轮 1 之后的状态）
    expect(String(toolsOf(grand)[0]?.result)).toBe("middle");

    // ── resolveBranch 展开三层：id 唯一、三段都在、链长 = 根+子+孙 ─────────────────
    const resolved = resolveBranch(grandResult.id, loadOf(root.dataDir));
    const resolvedIds = resolved.spans.map((span) => span.id);
    expect(new Set(resolvedIds).size).toBe(resolvedIds.length);
    expect(resolved.chain.map((hop) => hop.meta.id)).toEqual([
      root.id,
      childResult.id,
      grandResult.id,
    ]);
    expect(resolvedIds).toContain(root.tools1[0]?.id);
    expect(resolvedIds).toContain(childTools1[0]?.id);
    expect(grandIds.every((id) => resolvedIds.includes(id))).toBe(true);

    // ── 父文件不可变 + 源目录不变 ─────────────────────────────────────────────────
    expect(sha256Of(root.traceFile)).toBe(rootHash);
    expect(sha256Of(childFile)).toBe(childHash);
    expect(readFileSync(join(root.source, "seed.txt"), "utf8")).toBe("seed");
    expect(existsSync(join(root.source, "a.txt"))).toBe(false);
    expect(existsSync(join(root.source, "c.txt"))).toBe(false);
  });
});

describe("4.4 集成：兄弟并发", () => {
  it("两个分支并发：各自独立映射，彼此写的内容互不出现，父与源不变", async () => {
    const root = await makeRoot();
    const rootHash = sha256Of(root.traceFile);

    const makeScript = (label: string, value: string): ScriptedTurn[] => [
      { toolCalls: [readCall(`r_${label}`, "a.txt")] },
      { toolCalls: [writeCall(`w_${label}`, "a.txt", value)] },
      { toolCalls: [readCall(`r2_${label}`, "a.txt")] },
      { content: "done" },
    ];
    const leftLlm = new ScriptedLlm(makeScript("l", "left"));
    const rightLlm = new ScriptedLlm(makeScript("r", "right"));

    const [left, right] = await Promise.all([
      replayFrom(root, {
        parentId: root.id,
        atSpanId: root.tools1[0]?.id ?? "",
        editValue: "左分支编辑",
        llm: leftLlm,
      }),
      replayFrom(root, {
        parentId: root.id,
        atSpanId: root.tools1[0]?.id ?? "",
        editValue: "右分支编辑",
        llm: rightLlm,
      }),
    ]);

    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) {
      return;
    }
    expect(left.id).not.toBe(right.id);

    const leftTools = toolsOf(readRun(traceFileOf(root.dataDir, left.id)));
    const rightTools = toolsOf(readRun(traceFileOf(root.dataDir, right.id)));

    // 两边都从**同一个检查点**起步（a.txt = middle），随后各写各的、各读各的
    expect(String(leftTools[0]?.result)).toBe("middle");
    expect(String(rightTools[0]?.result)).toBe("middle");
    expect(String(leftTools[2]?.result)).toBe("left");
    expect(String(rightTools[2]?.result)).toBe("right");
    // 关键：对方的写入在自己的 trace 里**完全查不到**
    expect(leftTools.some((tool) => String(tool.result) === "right")).toBe(false);
    expect(rightTools.some((tool) => String(tool.result) === "left")).toBe(false);

    // 父 trace 与源目录不变；两个分支都归位成正式文件名（无临时残留）
    expect(sha256Of(root.traceFile)).toBe(rootHash);
    expect(readFileSync(join(root.source, "seed.txt"), "utf8")).toBe("seed");
    const files = readdirSync(tracesDirOf(root.dataDir)).sort();
    expect(files).toEqual([`${left.id}.jsonl`, `${right.id}.jsonl`, `${root.id}.jsonl`].sort());
  });

  it("并发兄弟的授权互相独立：一个未授权被拒，另一个照常完成", async () => {
    const root = await makeRoot();

    const deniedLlm = new ScriptedLlm([{ content: "不该被调用" }]);
    const allowedLlm = new ScriptedLlm([
      { toolCalls: [readCall("r1", "a.txt")] },
      { content: "done" },
    ]);

    const [denied, allowed] = await Promise.all([
      replayFrom(root, {
        parentId: root.id,
        atSpanId: root.tools1[0]?.id ?? "",
        editValue: "未授权",
        llm: deniedLlm,
        authority: { allowFileWrites: false },
      }),
      replayFrom(root, {
        parentId: root.id,
        atSpanId: root.tools1[0]?.id ?? "",
        editValue: "已授权",
        llm: allowedLlm,
      }),
    ]);

    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.failure.code).toBe("missing_authority");
    }
    expect(deniedLlm.requests).toHaveLength(0);
    expect(allowed.ok).toBe(true);

    // 被拒的那次不产生任何文件（traces 里只有根 + 成功的那一个）
    const files = readdirSync(tracesDirOf(root.dataDir)).sort();
    expect(files).toHaveLength(2);
    expect(files).toContain(`${root.id}.jsonl`);
  });
});

describe("4.4 集成：错误是数据且不越界补救", () => {
  it("重跑遇工具报错：错误入 trace、loop 继续，且不去源目录补救", async () => {
    const root = await makeRoot(); // 源树只有 seed.txt
    // 关键构造：文件是在**导入完成之后**才出现在源目录里的 ⇒ 它不在世界起点清单中。
    // 若工具会回读源目录补救，这次读取就会成功——用例正是靠这一点判"不越界"。
    writeFileSync(join(root.source, "only-in-source.txt"), "源里的内容");
    const llm = new ScriptedLlm([
      { toolCalls: [readCall("r1", "only-in-source.txt")] },
      { toolCalls: [readCall("r2", "a.txt")] },
      { content: "done" },
    ]);

    const result = await replayFrom(root, {
      parentId: root.id,
      atSpanId: root.tools1[0]?.id ?? "",
      editValue: "编辑",
      llm,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.outcome.event.event).toBe("stopped");

    const child = readRun(traceFileOf(root.dataDir, result.id));
    const tools = toolsOf(child);
    // 第一次调用失败：错误是**数据**（进 trace 的 error 字段），不是异常
    expect(tools[0]?.error).not.toBeNull();
    expect(String(tools[0]?.error)).toContain("only-in-source.txt");
    // loop 继续：下一轮照常执行并拿到真实内容
    expect(tools[1]?.error).toBeNull();
    expect(String(tools[1]?.result)).toBe("middle");
    // 不越界补救：源里的那个文件仍在，且不会因此进入世界
    expect(readFileSync(join(root.source, "only-in-source.txt"), "utf8")).toBe("源里的内容");
    const lastStep = stepsOf(child)[stepsOf(child).length - 1];
    expect(lastStep === undefined ? [] : snapshotPaths(child, lastStep)).toEqual([
      "a.txt",
      "seed.txt",
    ]);
  });

  it("LLM 失败后父与源逐字节不变（errored 也照常归位）", async () => {
    const root = await makeRoot();
    const rootHash = sha256Of(root.traceFile);
    const llm = new ScriptedLlm([{ toolCalls: [readCall("r1", "a.txt")] }]); // 第 2 轮耗尽

    const result = await replayFrom(root, {
      parentId: root.id,
      atSpanId: root.tools1[0]?.id ?? "",
      editValue: "编辑",
      llm,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.outcome.event.event).toBe("errored");
    expect(sha256Of(root.traceFile)).toBe(rootHash);
    expect(readFileSync(join(root.source, "seed.txt"), "utf8")).toBe("seed");
  });

  it("新结果改变后续轨迹：模型看到编辑后的上下文，走向不同的决策", async () => {
    const root = await makeRoot();
    // 父轮 1 的 write 结果是"a.txt（6 字节）"这类文本；编辑后模型看到"损坏"就改走修复路径
    const llm = new ReactiveLlm((messages) => {
      const toolMessage = messages.find((message) => message.role === "tool");
      const damaged =
        typeof toolMessage?.content === "string" && toolMessage.content.includes("损坏");
      return damaged
        ? { toolCalls: [writeCall("w1", "a.txt", "repaired")] }
        : { toolCalls: [readCall("r1", "a.txt")] };
    });

    const result = await replayFrom(root, {
      parentId: root.id,
      atSpanId: root.tools1[0]?.id ?? "",
      editValue: "文件已损坏",
      llm,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const child = readRun(traceFileOf(root.dataDir, result.id));
    const tools = toolsOf(child);
    // 决策变了：不是继续读，而是先修复
    expect(tools[0]?.tool).toBe("write_file");
    expect(tools[0]?.error).toBeNull();
    // 隔离写入被**后续读取**观察到
    expect(String(tools[1]?.result)).toBe("repaired");

    // 父世界不受影响：root 最后一轮的 a.txt 仍是 after
    const rootSteps = stepsOf(root.record);
    const rootLastStep = rootSteps[rootSteps.length - 1];
    const rootAFile = (rootLastStep?.workspace_snapshot?.files ?? []).find(
      (file) => file.path === "a.txt",
    );
    expect(rootAFile?.sha256).toBe(sha256OfText("after"));
    // 源目录里从来没有 a.txt
    expect(existsSync(join(root.source, "a.txt"))).toBe(false);
  });
});
