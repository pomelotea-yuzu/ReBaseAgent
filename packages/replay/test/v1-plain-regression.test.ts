import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, PLAIN_FORMAT_VERSION, readRun, resolveBranch } from "@rebaseagent/trace-sdk";
import type { AgentStepSpan, RunLoader, RunRecord, ToolInvokeSpan } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { replayRun } from "../src/index";
import { ScriptedLlm, asLoopLlm, readCall } from "./isolated-helpers";

/**
 * 4.6：**v1 普通重跑的正向回归**。
 *
 * 验证点（tasks.md 4.6）：`replay/生成分支 run 文件` —— "新文件有正确 parent/fork，spans 从分叉点后
 * 开始，readRun 通过，**普通 run 的前缀拼接不变**"。
 *
 * ## 为什么隔离功能落地后必须补这条
 *
 * 1.1/1.3/1.4 动了 trace 版本契约与 `resolveBranch`（按格式版本分流）；4.1–4.5 又往同一批入口加了
 * 隔离门禁。**普通 v1 路径必须一字不变**——尤其是三件事：
 * - 普通重跑产出的新文件**仍是 v1**（`runLoop` 恒写 1，只有隔离执行的包装器才覆盖成 2）；
 * - 新文件的 `fork` **不带** `resume_after_step`（那是 v2 隔离分支的整轮边界）；
 * - meta **没有** `workspace` 字段（隔离元数据不得渗进普通产物）。
 *
 * 最后一条"前缀拼接不变"用 `resolveBranch` 展开后**逐项比对**父 run 记录里的对应前缀——只断言
 * "长度对得上"证明不了内容没被改动。
 */

const SYSTEM_PROMPT = "你是文件助手。";
const TASK = "读 a.txt";

/** 普通（非隔离）工具：handler 是纯函数，不碰文件系统——v1 重跑的工具由调用方任意提供 */
const PLAIN_TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "读取指定路径的文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sideEffect: false,
    handler: (args) => `内容(${(args as { path: string }).path})`,
  },
];

function plainConfig(): RunConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    systemPrompt: SYSTEM_PROMPT,
    tools: PLAIN_TOOLS.map(({ handler: _handler, ...def }) => def),
    params: undefined,
    exec: { cwd: "D:/tmp/plain-sandbox", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "v1-regression-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface ParentFixture {
  readonly dir: string;
  readonly parentId: string;
  readonly traceFile: string;
  readonly record: RunRecord;
  readonly step1: AgentStepSpan;
  readonly tool1: ToolInvokeSpan;
  readonly load: RunLoader;
}

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 真跑一个 v1 父 run（两轮：轮 1 调用 read_file，轮 2 收尾） */
async function makePlainParent(): Promise<ParentFixture> {
  const dir = makeDir();
  const tmp = join(dir, "tmp-parent.jsonl");
  await runLoop(
    plainConfig(),
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: TASK },
    ],
    new JsonlTracer(tmp),
    PLAIN_TOOLS,
    asLoopLlm(new ScriptedLlm([{ toolCalls: [readCall("c1", "a.txt")] }, { content: "完成" }])),
  );

  const record = readRun(tmp);
  // 归位成 `<id>.jsonl`（真实场景由编排层做；这里为了方便用同一个 loader）
  renameSync(tmp, join(dir, `${record.meta.id}.jsonl`));

  const step1 = record.spans.find(
    (span): span is AgentStepSpan => span.kind === "agent.step" && span.n === 1,
  );
  const tool1 = record.spans.find(
    (span): span is ToolInvokeSpan => span.kind === "tool.invoke" && span.parent === step1?.id,
  );
  if (step1 === undefined || tool1 === undefined) {
    throw new Error("父 fixture 结构不符预期");
  }
  if (record.meta.format_version !== PLAIN_FORMAT_VERSION) {
    throw new Error(`父 fixture 应是 v1，实际 ${record.meta.format_version}`);
  }

  return {
    dir,
    parentId: record.meta.id,
    traceFile: join(dir, `${record.meta.id}.jsonl`),
    record,
    step1,
    tool1,
    load: (id) => readRun(join(dir, `${id}.jsonl`)),
  };
}

describe("4.6：v1 普通重跑的正向回归", () => {
  it("生成分支 run 文件：parent/fork 正确、spans 从分叉点后开始、父文件逐字节不变", async () => {
    const parent = await makePlainParent();
    const parentHashBefore = sha256Of(parent.traceFile);
    const outDir = join(parent.dir, "forks");
    // outDir 不存在时 JsonlTracer 需要目录已存在（它只写文件、不建目录）
    mkdirSync(outDir, { recursive: true });

    const llm = new ScriptedLlm([{ content: "子 run 完成" }]);
    const result = await replayRun({
      parentId: parent.parentId,
      atSpanId: parent.tool1.id,
      edit: { field: "result", value: "被编辑的工具结果" },
      config: plainConfig(),
      tools: PLAIN_TOOLS,
      load: parent.load,
      outDir,
      llm: asLoopLlm(llm),
    });

    const childFile = join(outDir, `${result.id}.jsonl`);
    expect(existsSync(childFile)).toBe(true);
    const child = readRun(childFile);

    // ── 产物仍是"普通的 v1 分支"：没有隔离元数据渗进来 ────────────────────────────
    expect(child.meta.format_version).toBe(PLAIN_FORMAT_VERSION);
    expect(child.meta.parent).toBe(parent.parentId);
    expect(child.meta.fork?.at_span).toBe(parent.tool1.id);
    // v1 分支不带整轮边界（那是 v2 隔离分叉的字段）
    expect(child.meta.fork?.resume_after_step).toBeUndefined();
    expect(child.meta.workspace).toBeUndefined();

    // ── spans 从分叉点之后开始：新文件只记新增 span ────────────────────────────────
    const parentIds = new Set(parent.record.spans.map((span) => span.id));
    expect(child.spans.some((span) => parentIds.has(span.id))).toBe(false);
    const parentMax = parent.record.spans.reduce((max, span) => {
      const m = /^s_(\d+)$/.exec(span.id);
      return m === null ? max : Math.max(max, Number(m[1]));
    }, 0);
    const childSeqs = child.spans.map((span) => Number(/^s_(\d+)$/.exec(span.id)?.[1] ?? 0));
    expect(childSeqs[0]).toBe(parentMax + 1);
    expect(childSeqs.every((seq) => seq > parentMax)).toBe(true);

    // ── 子 run 的首次请求含被编辑后的 tool 消息（截断 + 替换语义）────────────────────
    expect(
      llm.requests[0]?.some((m) => m.role === "tool" && m.content === "被编辑的工具结果"),
    ).toBe(true);

    // ── 普通 run 的前缀拼接**逐项不变** ────────────────────────────────────────────
    // fixture 把子 run 写在了 forks/ 下（真实场景父子同目录），所以 loader 要能同时找到两处
    const loadBoth: RunLoader = (id) => {
      const inParentDir = join(parent.dir, `${id}.jsonl`);
      return readRun(existsSync(inParentDir) ? inParentDir : join(outDir, `${id}.jsonl`));
    };
    const resolved = resolveBranch(result.id, loadBoth);
    const forkIndex = parent.record.spans.findIndex((span) => span.id === parent.tool1.id);
    expect(forkIndex).toBeGreaterThanOrEqual(0);
    // 前缀 = 父记录里 at_span 及其之前的部分，逐项（深比较）相同
    expect(resolved.spans.slice(0, forkIndex + 1)).toEqual(
      parent.record.spans.slice(0, forkIndex + 1),
    );
    // 其后接上的正是本 run 新增的 span（顺序与内容一致）
    expect(resolved.spans.slice(forkIndex + 1)).toEqual(child.spans);
    expect(resolved.spans).toHaveLength(forkIndex + 1 + child.spans.length);

    // ── 父文件逐字节不变 ─────────────────────────────────────────────────────────
    expect(sha256Of(parent.traceFile)).toBe(parentHashBefore);
  });

  it("普通重跑不会连带写入隔离产物：forks 目录只有新 run 文件", async () => {
    const parent = await makePlainParent();
    const outDir = join(parent.dir, "forks2");
    mkdirSync(outDir, { recursive: true });

    const result = await replayRun({
      parentId: parent.parentId,
      atSpanId: parent.tool1.id,
      edit: { field: "result", value: "改了" },
      config: plainConfig(),
      tools: PLAIN_TOOLS,
      load: parent.load,
      outDir,
      llm: asLoopLlm(new ScriptedLlm([{ content: "完成" }])),
    });

    expect(readdirSync(outDir)).toEqual([`${result.id}.jsonl`]);
    // 没有附件目录、没有 traces 子目录：普通路径不碰文件世界
    expect(existsSync(join(outDir, "workspace-blobs"))).toBe(false);
    expect(existsSync(join(parent.dir, "workspace-blobs"))).toBe(false);
  });
});
