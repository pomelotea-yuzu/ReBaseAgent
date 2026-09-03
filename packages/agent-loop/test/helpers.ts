import type { Message, RunConfig, Tool } from "../src/index";
import type { LlmClient, LlmResponse } from "../src/index";

/** 合法的 RunConfig 样例（可覆盖字段）。默认带 sampleTools 的定义（不含 handler） */
export function sampleConfig(over: Partial<RunConfig> = {}): RunConfig {
  const tools = sampleTools().map(({ handler: _h, ...def }) => def);
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

export function sampleTools(): Tool[] {
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

/** 一轮 LLM 的编排响应（mock 用） */
export interface ScriptedTurn {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  usage?: { in: number; out: number };
}

/** 固定 LlmResponse 的 mock 客户端：按剧本逐轮返回 */
export class MockLlmClient implements LlmClient {
  readonly requests: Message[][] = [];
  private turn = 0;

  constructor(private readonly script: ScriptedTurn[]) {}

  async complete(
    messages: Message[],
    _signal: AbortSignal | null,
  ): Promise<{ response: LlmResponse; requestBody: unknown }> {
    this.requests.push([...messages]);
    const turn = this.script[this.turn];
    this.turn += 1;
    if (turn === undefined) {
      throw new Error(`剧本耗尽：第 ${this.turn} 轮无编排响应`);
    }
    return {
      response: {
        content: turn.content ?? null,
        reasoningContent: turn.reasoning ?? null,
        toolCalls: (turn.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        })),
        usage: turn.usage ?? { in: 100, out: 50 },
        ttftMs: 10,
      },
      requestBody: {},
    };
  }
}

/** 构造 SSE 字节流（chunk 化模拟真实流） */
export function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= events.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(events[i]));
      i += 1;
    },
  });
}

/** 单条 chat completion SSE 数据块 */
export function sseData(json: unknown): string {
  return `data: ${JSON.stringify(json)}\n\n`;
}

/** fetch mock：返回编排好的 SSE 响应 */
export function fetchReturningSse(
  events: string[],
  status = 200,
): (input: string, init?: unknown) => Promise<Response> {
  return async () => {
    const body = sseStream(events);
    return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
  };
}
