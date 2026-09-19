import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  LlmClient,
  LlmResponse,
  Message,
  RequestBody,
  RunConfig,
  Tool,
} from "@rebaseagent/agent-loop";
import { configHash, runLoop } from "@rebaseagent/agent-loop";
import {
  FORMAT_VERSION,
  JsonlTracer,
  MemoryTracer,
  type RunEventLine,
  type RunMetaLine,
  type RunRecord,
  type SpanLine,
  readRun,
} from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";

/** —— 合法 RunConfig 样例（与 agent-loop 测试同构；卡带模式不碰网络） —— */

export function fakeConfig(over: Partial<RunConfig> = {}): RunConfig {
  const tools = fakeTools().map(({ handler: _h, ...def }) => def);
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    systemPrompt: "你是文件助手。",
    tools,
    params: undefined,
    exec: { cwd: "D:/tmp/sandbox", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
    ...over,
  };
}

/** 确定性假工具（无 fs / 无网络）：missing.json 报错，其余返回稳定文本 */
export function fakeTools(): Tool[] {
  return [
    {
      name: "read_file",
      description: "读取指定路径的文件",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      sideEffect: false,
      handler: (args) => {
        const { path } = args as { path: string };
        if (path === "missing.json") {
          throw new Error("ENOENT: no such file or directory");
        }
        return `内容(${path})`;
      },
    },
    {
      name: "write_file",
      description: "把内容写入指定路径",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      handler: (args) => `已写入 ${(args as { path: string }).path}`,
    },
  ];
}

export function initialMessages(task: string): Message[] {
  return [
    { role: "system", content: "你是文件助手。" },
    { role: "user", content: task },
  ];
}

/** —— 脚本化 LlmClient：按顺序吐响应，供「录制」真实轨迹用 —— */

export function cannedResponse(over: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: null,
    reasoningContent: null,
    toolCalls: [],
    usage: { in: 10, out: 5 },
    ttftMs: 1,
    ...over,
  };
}

export function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

export function scriptClient(responses: LlmResponse[]): LlmClient {
  let i = 0;
  return {
    async complete(
      messages: Message[],
    ): Promise<{ response: LlmResponse; requestBody: RequestBody }> {
      const response = responses[i];
      i += 1;
      if (response === undefined) {
        throw new Error(`脚本响应耗尽：第 ${i} 次调用无响应`);
      }
      return {
        response,
        requestBody: {
          model: "deepseek-chat",
          messages,
          stream: true,
          stream_options: { include_usage: true },
        },
      };
    },
  };
}

/** 用当前代码真实跑一遍（假 LLM + 假工具），录下基线 RunRecord */
export async function recordRun(
  responses: LlmResponse[],
  over: { config?: Partial<RunConfig>; task?: string } = {},
): Promise<ReturnType<MemoryTracer["snapshot"]>> {
  const tracer = new MemoryTracer();
  await runLoop(
    fakeConfig(over.config),
    initialMessages(over.task ?? "读一下 a.json"),
    tracer,
    fakeTools(),
    scriptClient(responses),
  );
  return tracer.snapshot();
}

/** 手工拼最小 RunRecord（单测 shape-align / stub-tools 用） */
export function recordOfSpans(
  spans: SpanLine[],
  event: RunEventLine | null,
): {
  meta: RunMetaLine;
  spans: SpanLine[];
  events: RunEventLine[];
  status: "completed" | "crashed";
} {
  return {
    meta: {
      type: "run.meta",
      id: "run_fixture",
      format_version: 1,
      task: "t",
      model: "deepseek-chat",
      created_at: "2026-09-08T06:00:00.000Z",
      parent: null,
      fork: null,
      config_hash: "h",
    },
    spans,
    events: event === null ? [] : [event],
    status: event === null ? "crashed" : "completed",
  };
}

export const stepSpan = (id: string, n: number, parent: string | null = null): SpanLine => ({
  type: "span",
  id,
  kind: "agent.step",
  parent,
  n,
});

/** 一条隔离卡带基线的落点 */
export interface IsolatedCassetteFixture {
  readonly dir: string;
  readonly traceFile: string;
  readonly runId: string;
  readonly record: RunRecord;
}

/**
 * 写一条**隔离 v2 卡带基线**（tasks 4.6）：含 `run.meta.workspace` 与每轮 `workspace_snapshot`，
 * 但**故意不写任何附件**（目录里连 `workspace-blobs/` 都不建）。
 *
 * 它就是"卡带路径保持录制结果语义"这条断言的输入：Trace-as-Test 只消费录制的 LLM / 工具结果，
 * 不加载文件世界——**附件不可用也必须照常重跑**。若哪天有人让卡带去读附件或真实 handler，
 * 这条基线立刻失败。
 *
 * `snapshotPath` 用来换一份"内容不同的快照清单"：结构对齐必须**忽略** `workspace_snapshot`
 * 字段本身，所以换了清单也要对齐通过（对照用例）。
 */
export function writeIsolatedCassetteTrace(
  dir: string,
  options: { readonly runId?: string; readonly snapshotPath?: string } = {},
): IsolatedCassetteFixture {
  const runId = options.runId ?? "run_isolated_cassette";
  const traceFile = join(dir, `${runId}.jsonl`);
  const snapshotPath = options.snapshotPath ?? "a.txt";
  const config = fakeConfig();
  // 清单里的哈希按真实算法算（附件**故意不写**：卡带路径不该读它）
  const bytes = new TextEncoder().encode("before");
  const snapshot = createWorkspaceSnapshot([
    {
      path: snapshotPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    },
  ]);

  const tracer = new JsonlTracer(traceFile);
  tracer.startRun({
    id: runId,
    format_version: FORMAT_VERSION,
    task: "隔离卡带基线",
    model: config.model,
    created_at: "2026-09-19T00:00:00.000Z",
    parent: null,
    fork: null,
    config_hash: configHash(config.systemPrompt, config.tools),
    workspace: {
      profile: "file-tools-v1",
      world_id: runId,
      write_authorized: true,
      initial_snapshot: snapshot,
      origin: { kind: "import" },
    },
  });

  // 行的落盘顺序 = endSpan 顺序（JsonlTracer 在 endSpan 时写 span 行），与真 loop 一致：
  // llm.call → tool.invoke → agent.step
  const toolCalls = [
    {
      id: "c1",
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
    },
  ];

  const step1 = tracer.startSpan({ kind: "agent.step", n: 1 });
  const llm1 = tracer.startSpan({
    kind: "llm.call",
    parent: step1,
    request: { model: config.model, messages: initialMessages("读 a.txt 并总结") },
  });
  tracer.endSpan(llm1, {
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: toolCalls,
      usage: { in: 10, out: 5 },
      ttft_ms: 1,
    },
  });
  const tool1 = tracer.startSpan({
    kind: "tool.invoke",
    parent: step1,
    tool: "read_file",
    args: { path: "a.txt" },
  });
  tracer.endSpan(tool1, { result: "内容(a.txt)", dur_ms: 1, error: null });
  tracer.endSpan(step1, { workspace_snapshot: snapshot });

  const step2 = tracer.startSpan({ kind: "agent.step", n: 2 });
  const llm2 = tracer.startSpan({
    kind: "llm.call",
    parent: step2,
    request: {
      model: config.model,
      messages: [
        ...initialMessages("读 a.txt 并总结"),
        { role: "assistant", content: null, tool_calls: toolCalls },
        { role: "tool", tool_call_id: "c1", content: "内容(a.txt)" },
      ],
    },
  });
  tracer.endSpan(llm2, {
    response: {
      content: "完成",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 12, out: 6 },
      ttft_ms: 1,
    },
  });
  tracer.endSpan(step2, { workspace_snapshot: snapshot });
  tracer.endRun({ event: "stopped", reason: "completed", at: 2 });

  return { dir, traceFile, runId, record: readRun(traceFile) };
}
