import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { Message, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { FORMAT_VERSION, JsonlTracer, MemoryTracer, readRun } from "@rebaseagent/trace-sdk";
import type {
  EndSpanPatch,
  RunEventInput,
  RunMetaInput,
  SpanKind,
  WorkspaceOrigin,
} from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TOOLS_V1_PROFILE,
  READ_FILE_TOOL_NAME,
  WORKSPACE_TRACES_DIR_NAME,
  WRITE_FILE_TOOL_NAME,
  createFileToolsV1,
  createWorkspaceCheckpointTracer,
  createWorkspaceWorld,
  hashWorkspaceContent,
  importSourceTree,
  locateWorkspaceSnapshot,
  readWorkspaceFile,
} from "../src/index";
import type { WorkspaceWorld } from "../src/index";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * 3.4：workspace Tracer 包装器。
 *
 * 验证点（tasks.md 3.4）：`trace-format/根与分支快照往返`、`workspace-isolation/LLM 失败仍保留已完成
 * 文件事实`，以及 runLoop **不新增** fs / global state。
 *
 * ## 用例为什么必须真跑 runLoop
 *
 * 包装器的全部意义是"在 loop 的边界上把它的 v1 meta 换成 v2 隔离 meta、并在每一轮末尾补一个检查点"。
 * 手工调 `startSpan`/`endSpan` 只能证明包装器自己记得住 kind——证明不了它与真实 loop 的**调用契约**
 * 对接得上：loop 调 `endSpan(step)` 时**不传 patch**（3.4 的核心发现），也不传 kind。所以这里的
 * 正向用例一律走"真导入 → 真世界 → 真工具 → runLoop + 桩 LLM → JsonlTracer 落盘 → readRun 校验"。
 *
 * ## 桩 LLM 的落点
 *
 * `agent-loop` 的测试 helper（`test/helpers.ts`）不在本包的包导出面里，跨包引用等于依赖别人的测试
 * 目录。这里只用到"按剧本逐轮返回"这一条语义，故在本文件内自带一个最小桩（30 行），换来用例不
 * 依赖兄弟包的私有路径。
 */

/** 一轮 LLM 的编排响应 */
interface ScriptedTurn {
  readonly content?: string;
  readonly toolCalls?: Array<{ readonly id: string; readonly name: string; readonly args: string }>;
}

/** 最小桩：按剧本逐轮返回；剧本耗尽即抛（loop 会把 LLM 失败记成 errored 终止） */
class ScriptedLlm {
  readonly requests: Message[][] = [];
  private turn = 0;

  constructor(private readonly script: readonly ScriptedTurn[]) {}

  async complete(messages: Message[]): Promise<{
    response: {
      content: string | null;
      reasoningContent: string | null;
      toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
      usage: { in: number; out: number };
      ttftMs: number;
    };
    requestBody: unknown;
  }> {
    this.requests.push([...messages]);
    const turn = this.script[this.turn];
    this.turn += 1;
    if (turn === undefined) {
      throw new Error(`剧本耗尽：第 ${this.turn} 轮无编排响应`);
    }
    return {
      response: {
        content: turn.content ?? null,
        reasoningContent: null,
        toolCalls: (turn.toolCalls ?? []).map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.args },
        })),
        usage: { in: 100, out: 50 },
        ttftMs: 10,
      },
      requestBody: {},
    };
  }
}

/** 让桩 LLM 闭嘴的"缺方法"检查：runLoop 只用 complete */
const asLoopLlm = (llm: ScriptedLlm): Parameters<typeof runLoop>[4] =>
  llm as unknown as Parameters<typeof runLoop>[4];

afterEach(cleanupTempDirs);

// ── fixture ─────────────────────────────────────────────────────────────────────────────

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Fixture {
  readonly dataDir: string;
  readonly world: WorkspaceWorld;
}

/** 真导入一棵源树 → 建世界（授权显式给出） */
async function makeWorld(options: {
  tree: Record<string, string>;
  allowFileWrites?: boolean;
}): Promise<Fixture> {
  const source = makeTempDir("tracer-src-");
  const dataDir = join(makeTempDir("tracer-data-"), "data");
  writeTree(source, options.tree);

  const imported = await importSourceTree({ source, dataDir });
  if (!imported.ok) {
    throw new Error(`fixture 导入失败：${imported.failure.reason}`);
  }
  const created = createWorkspaceWorld({
    dataDir,
    snapshot: createWorkspaceSnapshot(imported.value.files),
    allowFileWrites: options.allowFileWrites ?? true,
  });
  if (!created.ok) {
    throw new Error(`fixture 建世界失败：${created.failure.reason}`);
  }
  // traces 目录由编排层准备（JsonlTracer 只负责写文件，不建目录——见其 `openSync(file, "a")`）。
  // 真实场景里这一步是 4.1 `createIsolatedRun` 的活；这里显式建出来，是为了让用例直接对着
  // 真实 JsonlTracer 跑，而不是先用 stderr 记录下"少建了一个目录"。
  mkdirSync(join(dataDir, WORKSPACE_TRACES_DIR_NAME), { recursive: true });
  return { dataDir, world: created.value };
}

/** 固定的两个受控工具，定义取自 profile 常量本身（不是手抄一份） */
function fixedTools(world: WorkspaceWorld): Tool[] {
  return createFileToolsV1(world);
}

function makeConfig(tools: readonly Tool[]): RunConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    systemPrompt: "你是文件助手。",
    tools: tools.map(({ handler: _handler, ...def }) => def),
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

function initialMessages(task: string): Message[] {
  return [
    { role: "system", content: "你是文件助手。" },
    { role: "user", content: task },
  ];
}

/** 一轮 write_file 的工具调用（args 是**字符串**，与真实 LLM 给的形式一致） */
function writeCall(id: string, path: string, content: string) {
  return { id, name: WRITE_FILE_TOOL_NAME, args: JSON.stringify({ path, content }) };
}

function readCall(id: string, path: string) {
  return { id, name: READ_FILE_TOOL_NAME, args: JSON.stringify({ path }) };
}

/** 把一次完整隔离运行串起来：世界 → 包装器（委托 JsonlTracer） → runLoop */
async function runIsolated(options: {
  fixture: Fixture;
  runId: string;
  script: readonly ScriptedTurn[];
  task?: string;
  tools?: Tool[];
  origin?: WorkspaceOrigin;
}): Promise<{ messages: Message[]; event: { event: string; reason: string; at: number } }> {
  const tools = options.tools ?? fixedTools(options.fixture.world);
  const traceFile = join(
    options.fixture.dataDir,
    WORKSPACE_TRACES_DIR_NAME,
    `${options.runId}.jsonl`,
  );
  const delegate = new JsonlTracer(traceFile);
  const tracer = createWorkspaceCheckpointTracer({
    delegate,
    world: options.fixture.world,
    runId: options.runId,
    origin: options.origin ?? { kind: "import" },
  });

  return runLoop(
    makeConfig(tools),
    initialMessages(options.task ?? "在 a.txt 里写入 hello"),
    tracer,
    tools,
    asLoopLlm(new ScriptedLlm(options.script)),
  );
}

/** 从落盘文件里读出所有 agent.step 的检查点（按 span id 升序） */
function stepSnapshots(dataDir: string, runId: string) {
  const record = readRun(join(dataDir, WORKSPACE_TRACES_DIR_NAME, `${runId}.jsonl`));
  return record.spans
    .filter((span) => span.kind === "agent.step")
    .map((span) => ({
      id: span.id,
      n: span.kind === "agent.step" ? span.n : -1,
      files: span.kind === "agent.step" ? (span.workspace_snapshot?.files ?? []) : [],
      paths: (span.kind === "agent.step" ? (span.workspace_snapshot?.files ?? []) : []).map(
        (file) => file.path,
      ),
    }));
}

// ── 正向：真跑 runLoop ──────────────────────────────────────────────────────────────────

describe("包装器：根运行端到端（真 runLoop + 真世界 + JsonlTracer）", () => {
  it("loop 照旧写 v1/id，落盘的是覆盖后的 v2 meta + 本次 run id + 世界字段", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "before", "dir/b.txt": "b" } });
    await runIsolated({
      fixture,
      runId: "run_isolated_root",
      script: [
        { content: "我先读一下", toolCalls: [readCall("c1", "a.txt")] },
        { content: "读完了" },
      ],
    });

    const record = readRun(
      join(fixture.dataDir, WORKSPACE_TRACES_DIR_NAME, "run_isolated_root.jsonl"),
    );

    // 版本被覆盖：loop 写的是 1（见 run-loop.ts 的字面量与注释），隔离格式必须是 2
    expect(record.meta.format_version).toBe(FORMAT_VERSION);
    // id 被覆盖：loop 自造 `run_<36 进制>`，这里必须是编排层给的
    expect(record.meta.id).toBe("run_isolated_root");
    // 其余 loop 写的字段原样保留（覆盖只针对 id/版本 + 注入 workspace）
    expect(record.meta.task).toBe("在 a.txt 里写入 hello");
    expect(record.meta.model).toBe("deepseek-chat");
    expect(record.meta.parent).toBeNull();
    expect(record.meta.fork).toBeNull();
    // 普通运行不会有的字段：config_hash 由 loop 算（`sha256:` 前缀是既有格式，不属本次改动）
    expect(record.meta.config_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const workspace = record.meta.workspace;
    expect(workspace).toBeDefined();
    expect(workspace?.profile).toBe(FILE_TOOLS_V1_PROFILE);
    expect(workspace?.world_id).toBe("run_isolated_root");
    expect(workspace?.origin).toEqual({ kind: "import" });
    // 审计标注恒真（真正的授权判据是当前请求的 allowFileWrites，3.3 已挡在前面）
    expect(workspace?.write_authorized).toBe(true);
    // 初始快照 = 导入时的起点
    expect(workspace?.initial_snapshot.files.map((file) => file.path)).toEqual([
      "a.txt",
      "dir/b.txt",
    ]);
  });

  it("每一轮 agent.step 都带检查点，且 v2 读取器接受整份文件（无跨行约束违规）", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "before" } });
    await runIsolated({
      fixture,
      runId: "run_two_rounds",
      script: [
        { toolCalls: [writeCall("c1", "a.txt", "first")] },
        { toolCalls: [writeCall("c2", "b.txt", "second")] },
        { content: "好了" },
      ],
    });

    const steps = stepSnapshots(fixture.dataDir, "run_two_rounds");

    expect(steps.map((step) => step.n)).toEqual([1, 2, 3]);
    // 检查点是**增量累积**的完整清单：第 2 轮结束时有 a.txt 与 b.txt
    expect(steps[0]?.paths).toEqual(["a.txt"]);
    expect(steps[1]?.paths).toEqual(["a.txt", "b.txt"]);
    expect(steps[2]?.paths).toEqual(["a.txt", "b.txt"]);
  });

  it("初始快照在**首次 LLM 之前**就已就绪：第一轮请求还没发出，世界起点已经落盘", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "before" } });
    const llm = new ScriptedLlm([{ content: "不调工具" }]);
    const tools = fixedTools(fixture.world);
    const traceFile = join(fixture.dataDir, WORKSPACE_TRACES_DIR_NAME, "run_early_meta.jsonl");
    const tracer = createWorkspaceCheckpointTracer({
      delegate: new JsonlTracer(traceFile),
      world: fixture.world,
      runId: "run_early_meta",
      origin: { kind: "import" },
    });

    await runLoop(makeConfig(tools), initialMessages("只聊天"), tracer, tools, asLoopLlm(llm));

    // 首次 LLM 调用发生在 startRun 之后 ⇒ 那一刻文件事实已在 meta 里
    expect(llm.requests.length).toBe(1);
    const record = readRun(traceFile);
    expect(record.meta.workspace?.initial_snapshot.files.map((file) => file.path)).toEqual([
      "a.txt",
    ]);
  });

  it("检查点快照经读接口可用：按 step span id 定位到那一轮的文件内容", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "v1" } });
    await runIsolated({
      fixture,
      runId: "run_readable",
      script: [
        { toolCalls: [writeCall("c1", "a.txt", "v2")] },
        { toolCalls: [writeCall("c2", "a.txt", "v3")] },
        { content: "好了" },
      ],
    });

    const steps = stepSnapshots(fixture.dataDir, "run_readable");
    const first = steps[0];
    expect(first).toBeDefined();

    // 第 1 轮结束时的 a.txt 是 v2（不是最终态 v3）——这正是"时间旅行"要能取回的历史文件
    const atFirst = await readWorkspaceFile({
      dataDir: fixture.dataDir,
      runId: "run_readable",
      stepSpanId: first?.id,
      path: "a.txt",
    });
    expect(atFirst).toMatchObject({ status: "text", text: "v2" });

    // 初始快照仍是起点 v1（未被任何一轮写入污染）
    const atStart = await readWorkspaceFile({
      dataDir: fixture.dataDir,
      runId: "run_readable",
      path: "a.txt",
    });
    expect(atStart).toMatchObject({ status: "text", text: "v1" });
  });

  it("分支 origin 原样写入 meta：带 parent/fork 的续跑 run 可以声明 checkpoint 来源", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "v1" } });
    const tools = fixedTools(fixture.world);
    const delegate = new JsonlTracer(
      join(fixture.dataDir, WORKSPACE_TRACES_DIR_NAME, "run_child.jsonl"),
    );
    const tracer = createWorkspaceCheckpointTracer({
      delegate,
      world: fixture.world,
      runId: "run_child",
      origin: { kind: "checkpoint", run_id: "run_parent", step_span: "s_05" },
    });

    // 分支 run 必须同时给出 parent 与 fork（schema 的跨字段约束），由 loop 的 ForkRunMeta 通道传
    await runLoop(
      makeConfig(tools),
      initialMessages("续跑"),
      tracer,
      tools,
      asLoopLlm(new ScriptedLlm([{ content: "好了" }])),
      {
        id: "run_child",
        parent: "run_parent",
        fork: {
          at_span: "s_05",
          resume_after_step: "s_05",
          edit: { field: "result", value: "编辑后的结果" },
        },
      },
    );

    const record = readRun(join(fixture.dataDir, WORKSPACE_TRACES_DIR_NAME, "run_child.jsonl"));
    // 包装器只覆盖 id/版本并注入 workspace；parent/fork 走 loop 自己的通道，原样保留
    expect(record.meta.parent).toBe("run_parent");
    expect(record.meta.fork?.at_span).toBe("s_05");
    expect(record.meta.workspace?.origin).toEqual({
      kind: "checkpoint",
      run_id: "run_parent",
      step_span: "s_05",
    });
    // 关键：world_id 恒等于**本 run 的 id**（schema 的跨字段约束），而不是来源 run
    expect(record.meta.workspace?.world_id).toBe("run_child");
  });

  it("runLoop 不新增 fs：工具不碰源目录，全部文件事实只经世界与 trace 出口", async () => {
    const source = makeTempDir("tracer-src-frozen-");
    writeTree(source, { "a.txt": "before" });
    const dataDir = join(makeTempDir("tracer-data-frozen-"), "data");

    const imported = await importSourceTree({ source, dataDir });
    if (!imported.ok) {
      throw new Error(imported.failure.reason);
    }
    const created = createWorkspaceWorld({
      dataDir,
      snapshot: createWorkspaceSnapshot(imported.value.files),
      allowFileWrites: true,
    });
    if (!created.ok) {
      throw new Error(created.failure.reason);
    }
    mkdirSync(join(dataDir, WORKSPACE_TRACES_DIR_NAME), { recursive: true });

    await runIsolated({
      fixture: { dataDir, world: created.value },
      runId: "run_source_frozen",
      script: [{ toolCalls: [writeCall("c1", "a.txt", "after")] }, { content: "好了" }],
    });

    // 源目录逐字节不变：写入只落在附件存储里
    expect(readFileSync(join(source, "a.txt"), "utf8")).toBe("before");
    // 世界映射已更新，且读接口能拿到新内容
    expect(created.value.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
    // 注意：不传 stepSpanId 时读的是**初始快照**（起点那份 before）——要看写入后的状态，
    // 必须显式指向那一轮的检查点。这正是"检查点 = 那一轮末尾的文件事实"的可观测形态。
    const atStart = await readWorkspaceFile({
      dataDir,
      runId: "run_source_frozen",
      path: "a.txt",
    });
    expect(atStart).toMatchObject({ status: "text", text: "before" });

    const lastStep = stepSnapshots(dataDir, "run_source_frozen").at(-1);
    const atEnd = await readWorkspaceFile({
      dataDir,
      runId: "run_source_frozen",
      stepSpanId: lastStep?.id,
      path: "a.txt",
    });
    expect(atEnd).toMatchObject({ status: "text", text: "after" });
  });
});

// ── 反向：LLM 失败仍保留已完成文件事实 ────────────────────────────────────────────────

describe("包装器：LLM 失败仍保留已完成文件事实", () => {
  it("一轮写文件后 LLM 抛错 → errored 封存，已完成 step 的检查点保留写入", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "before" } });
    // 第 1 轮写文件成功；第 2 轮剧本耗尽 → 桩抛错 → loop 记 errored
    const result = await runIsolated({
      fixture,
      runId: "run_llm_error",
      script: [{ toolCalls: [writeCall("c1", "a.txt", "written-before-crash")] }],
    });

    expect(result.event).toMatchObject({ event: "errored", reason: "error", at: 2 });

    const record = readRun(join(fixture.dataDir, WORKSPACE_TRACES_DIR_NAME, "run_llm_error.jsonl"));
    expect(record.events.map((event) => event.event)).toEqual(["errored"]);
    expect(record.status).toBe("completed");

    // 失败那一轮的 step 也落盘了（loop 在 LLM 失败路径上同样 endSpan(step)），
    // 且它的检查点里 a.txt 已是第 1 轮写入后的状态——文件事实没被回滚，也没被伪造。
    // 关键语义：**失败那一轮没有工具 span**，所以失败轮的检查点 = 上一轮结束时的清单。
    const steps = stepSnapshots(fixture.dataDir, "run_llm_error");
    expect(steps.map((step) => step.n)).toEqual([1, 2]);
    expect(steps.map((step) => step.paths)).toEqual([["a.txt"], ["a.txt"]]);
    // 检查点里的哈希必须是**写入后**的内容：把它与"直接对文本算哈希"的结果比，
    // 也就顺带证明了检查点指向的确实是新发布的那份附件（而不是起点那份）。
    expect(steps[0]?.files[0]?.sha256).toBe(hashWorkspaceContent(utf8("written-before-crash")));

    // 读接口能取回第 1 轮写入的内容（用第 1 轮的检查点，而不是初始快照）
    const firstStepId = steps[0]?.id;
    const read = await readWorkspaceFile({
      dataDir: fixture.dataDir,
      runId: "run_llm_error",
      stepSpanId: firstStepId,
      path: "a.txt",
    });
    expect(read).toMatchObject({ status: "text", text: "written-before-crash" });

    // 初始快照仍留住起点那份（失败运行的起点事实未被覆盖）
    const atStart = await readWorkspaceFile({
      dataDir: fixture.dataDir,
      runId: "run_llm_error",
      path: "a.txt",
    });
    expect(atStart).toMatchObject({ status: "text", text: "before" });
  });

  it("失败轮之后世界仍可继续写（世界不因 LLM 失败被封存）", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "before" } });
    await runIsolated({
      fixture,
      runId: "run_then_continue",
      script: [{ toolCalls: [writeCall("c1", "a.txt", "one")] }],
    });

    // trace 已封存，但世界是应用层对象：同一 run 的后续尝试可以直接续写
    const written = await fixture.world.writeFile("b.txt", utf8("two"));
    expect(written.ok).toBe(true);
    expect(fixture.world.listFiles().map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
  });
});

// ── 底层事件转发与 span kind 跟踪 ──────────────────────────────────────────────────────

describe("包装器：事件转发与 span kind 跟踪", () => {
  it("subscribe 转发底层事件，且 span.end 里**已带**检查点（加工发生在 delegate 之前）", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "before" } });
    const delegate = new JsonlTracer(
      join(fixture.dataDir, WORKSPACE_TRACES_DIR_NAME, "run_subscribe.jsonl"),
    );
    const tracer = createWorkspaceCheckpointTracer({
      delegate,
      world: fixture.world,
      runId: "run_subscribe",
      origin: { kind: "import" },
    });

    const seen: Array<{ type: string; kind?: SpanKind; paths?: string[] }> = [];
    const unsubscribe = tracer.subscribe((event) => {
      if (event.type === "span.end") {
        seen.push({
          type: event.type,
          kind: event.span.kind,
          paths:
            event.span.kind === "agent.step"
              ? (event.span.workspace_snapshot?.files ?? []).map((file) => file.path)
              : undefined,
        });
      } else {
        seen.push({ type: event.type });
      }
    });

    const tools = fixedTools(fixture.world);
    await runLoop(
      makeConfig(tools),
      initialMessages("写文件"),
      tracer,
      tools,
      asLoopLlm(
        new ScriptedLlm([{ toolCalls: [writeCall("c1", "b.txt", "x")] }, { content: "好了" }]),
      ),
    );

    expect(seen.filter((event) => event.type === "run.meta")).toHaveLength(1);
    // 只有 agent.step 带检查点，llm.call / tool.invoke 一律不带
    const stepEvents = seen.filter((event) => event.kind === "agent.step");
    expect(stepEvents.map((event) => event.paths)).toEqual([
      ["a.txt", "b.txt"],
      ["a.txt", "b.txt"],
    ]);
    for (const event of seen) {
      if (event.kind !== undefined && event.kind !== "agent.step") {
        expect(event.paths).toBeUndefined();
      }
    }

    // 取消订阅之后不再收到事件（用包装器自身的 startSpan 触发一次事件；包装器在运行结束后
    // 仍可被调用，但底层已封存会抛错——所以这里换一个新的委托实例，只验证"取消订阅"这一条）
    unsubscribe();
    const probe = new MemoryTracer();
    const probeTracer = createWorkspaceCheckpointTracer({
      delegate: probe,
      world: fixture.world,
      runId: "run_probe",
      origin: { kind: "import" },
    });
    const afterUnsubscribe: string[] = [];
    const off = probeTracer.subscribe((event) => afterUnsubscribe.push(event.type));
    off();
    probeTracer.startRun({
      id: "run_probe",
      format_version: 1,
      task: "t",
      model: "m",
      created_at: "2026-09-18T00:00:00.000Z",
      parent: null,
      fork: null,
    });
    expect(afterUnsubscribe).toEqual([]);

    // 保留一个对照：同一实例未取消订阅时会收到事件（否则上面那条断言可能因"根本没接线"而假绿）
    const stillOn: string[] = [];
    probeTracer.subscribe((event) => stillOn.push(event.type));
    probeTracer.startSpan({ kind: "agent.step", n: 1 });
    expect(stillOn).toContain("span.start");
  });

  it("非 agent.step 的 span 原样透传：patch 与 kind 都不被改动", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "before" } });
    const delegate = new MemoryTracer();
    const tracer = createWorkspaceCheckpointTracer({
      delegate,
      world: fixture.world,
      runId: "run_memory",
      origin: { kind: "import" },
    });

    const tools = fixedTools(fixture.world);
    await runLoop(
      makeConfig(tools),
      initialMessages("读文件"),
      tracer,
      tools,
      asLoopLlm(new ScriptedLlm([{ toolCalls: [readCall("c1", "a.txt")] }, { content: "好了" }])),
    );

    // 委托用的 MemoryTracer 直接拿到完整 span 流（本用例同时证明"包装器可委托任意 Tracer"）
    expect(delegate.metas).toHaveLength(1);
    expect(delegate.metas[0]?.format_version).toBe(FORMAT_VERSION);

    const readSpan = delegate.spans.find(
      (span) => span.kind === "tool.invoke" && span.tool === READ_FILE_TOOL_NAME,
    );
    expect(readSpan).toBeDefined();
    // 读工具的 result 原样透传（文本内容），并没有被包装器塞进 workspace_snapshot
    expect(readSpan && "workspace_snapshot" in readSpan).toBe(false);

    const stepSpans = delegate.spans.filter((span) => span.kind === "agent.step");
    expect(stepSpans).toHaveLength(2);
    for (const span of stepSpans) {
      expect(span.kind === "agent.step" && span.workspace_snapshot).toBeDefined();
    }
  });

  it("端到端组合：runLoop 写 v1 → 包装器覆盖 → v2 读取器与快照 id 重算都通过", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "before" } });
    await runIsolated({
      fixture,
      runId: "run_roundtrip",
      script: [{ toolCalls: [writeCall("c1", "d/e.txt", "nested")] }, { content: "好了" }],
    });

    // readRun 会在解析期重算初始快照与每份 step 检查点的 id —— 能读出来即"id 与清单相符"
    const record = readRun(join(fixture.dataDir, WORKSPACE_TRACES_DIR_NAME, "run_roundtrip.jsonl"));
    const step = record.spans.find((span) => span.kind === "agent.step");
    expect(step?.kind === "agent.step" && step.workspace_snapshot?.files).toEqual(
      createWorkspaceSnapshot([
        { path: "a.txt", sha256: expect.any(String) as unknown as string, bytes: 6 },
        { path: "d/e.txt", sha256: expect.any(String) as unknown as string, bytes: 6 },
      ]).files,
    );

    // 读接口能定位到嵌套路径（逻辑父目录不必真实存在）。
    // 同样必须显式指向某一轮的检查点：初始快照里还没有 d/e.txt。
    const lastStep = stepSnapshots(fixture.dataDir, "run_roundtrip").at(-1);
    const nested = await readWorkspaceFile({
      dataDir: fixture.dataDir,
      runId: "run_roundtrip",
      stepSpanId: lastStep?.id,
      path: "d/e.txt",
    });
    expect(nested).toMatchObject({ status: "text", text: "nested" });

    // 初始快照里没有这条路径 ⇒ 读接口给可辨的 not_found（而不是抛错）
    const nestedAtStart = await readWorkspaceFile({
      dataDir: fixture.dataDir,
      runId: "run_roundtrip",
      path: "d/e.txt",
    });
    expect(nestedAtStart).toMatchObject({ status: "not_found" });

    // 未授权的世界：写失败，但检查点照旧记录当前（未变的）文件事实
    const readonlyFixture = await makeWorld({
      tree: { "a.txt": "before" },
      allowFileWrites: false,
    });
    await runIsolated({
      fixture: readonlyFixture,
      runId: "run_readonly",
      script: [{ toolCalls: [writeCall("c1", "a.txt", "nope")] }, { content: "好了" }],
    });

    const readonlyRecord = readRun(
      join(readonlyFixture.dataDir, WORKSPACE_TRACES_DIR_NAME, "run_readonly.jsonl"),
    );
    const failed = readonlyRecord.spans.find(
      (span) => span.kind === "tool.invoke" && span.tool === WRITE_FILE_TOOL_NAME,
    );
    expect(failed?.kind === "tool.invoke" && failed.error).toContain("not_authorized");
    const readonlySteps = readonlyRecord.spans.filter((span) => span.kind === "agent.step");
    for (const span of readonlySteps) {
      expect(span.kind === "agent.step" && span.workspace_snapshot?.files).toEqual([
        { path: "a.txt", sha256: expect.any(String) as unknown as string, bytes: 6 },
      ]);
    }
  });
});

// ── 契约层：包装器本身的最小性质 ────────────────────────────────────────────────────────

describe("包装器：契约与生命周期", () => {
  it("hasStarted 反映生命周期（startRun 前 false，endRun 后回到 false）", async () => {
    const fixture = await makeWorld({ tree: {} });
    const tracer = createWorkspaceCheckpointTracer({
      delegate: new MemoryTracer(),
      world: fixture.world,
      runId: "run_lifecycle",
      origin: { kind: "import" },
    });

    expect(tracer.hasStarted()).toBe(false);
    const meta: RunMetaInput = {
      id: "ignored",
      format_version: 1,
      task: "t",
      model: "m",
      created_at: "2026-09-18T00:00:00.000Z",
      parent: null,
      fork: null,
    };
    tracer.startRun(meta);
    expect(tracer.hasStarted()).toBe(true);
    tracer.endRun({ event: "stopped", reason: "completed", at: 0 });
    expect(tracer.hasStarted()).toBe(false);
  });

  it("不在 startRun 之前自作主张：未开始时只做纯转发（底层照常抛错）", async () => {
    const fixture = await makeWorld({ tree: {} });
    const tracer = createWorkspaceCheckpointTracer({
      delegate: new MemoryTracer(),
      world: fixture.world,
      runId: "run_not_started",
      origin: { kind: "import" },
    });

    // 底层负责生命周期防护；包装器不改变这些语义（不吞错、不补默认值）
    expect(() => tracer.startSpan({ kind: "agent.step", n: 1 })).toThrow(/尚未 startRun/);
  });

  it("endSpan 的调用方 patch 与检查点合并：其余字段原样保留", async () => {
    const fixture = await makeWorld({ tree: { "a.txt": "before" } });
    const delegate = new MemoryTracer();
    const tracer = createWorkspaceCheckpointTracer({
      delegate,
      world: fixture.world,
      runId: "run_patch",
      origin: { kind: "import" },
    });

    tracer.startRun({
      id: "run_patch",
      format_version: 1,
      task: "t",
      model: "m",
      created_at: "2026-09-18T00:00:00.000Z",
      parent: null,
      fork: null,
    });
    const step = tracer.startSpan({ kind: "agent.step", n: 1 });
    const patch: EndSpanPatch = {};
    tracer.endSpan(step, patch);
    tracer.endRun({ event: "stopped", reason: "completed", at: 1 } satisfies RunEventInput);

    const span = delegate.spans.find((entry) => entry.id === step);
    expect(span?.kind).toBe("agent.step");
    expect(
      span?.kind === "agent.step" && span.workspace_snapshot?.files.map((f) => f.path),
    ).toEqual(["a.txt"]);
  });
});
