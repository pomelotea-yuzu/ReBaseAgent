import type {
  LlmClient,
  LlmResponse,
  Message,
  RequestBody,
  RunConfig,
  Tool,
} from "@rebaseagent/agent-loop";
import { runLoop } from "@rebaseagent/agent-loop";
import {
  MemoryTracer,
  type RunEventLine,
  type RunMetaLine,
  type SpanLine,
} from "@rebaseagent/trace-sdk";

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
