import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Message, RunConfig } from "@rebaseagent/agent-loop";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  READ_FILE_TOOL_NAME,
  WORKSPACE_TRACES_DIR_NAME,
  WRITE_FILE_TOOL_NAME,
} from "../src/index";
import type { CreateIsolatedRunOptions } from "../src/index";

/**
 * 隔离相关用例的共用 fixture 零件（4.1 与 4.2 共用）。
 *
 * 抽出来的东西只有一类：**与真实 LLM 无关的那部分编排桩**（按剧本逐轮返回的客户端、
 * 固定 profile 的 RunConfig、工具调用构造）。刻意不把"怎么造父本"也放进来——
 * 4.1 用 `createIsolatedRun` 造根 run、4.2 在其上做定向破坏，两者的意图完全不同。
 * （`agent-loop` 自己的测试 helper 不在其包导出面里，跨包引用等于依赖别人的测试目录，
 * 所以这里自带最小桩。）
 */

export const SYSTEM_PROMPT = "你是文件助手。";

/** 一轮 LLM 的编排响应 */
export interface ScriptedTurn {
  readonly content?: string;
  readonly toolCalls?: Array<{ readonly id: string; readonly name: string; readonly args: string }>;
}

/**
 * 最小桩：按剧本逐轮返回；剧本耗尽即抛（loop 会把 LLM 失败记成 `errored` 终止）。
 *
 * `tracesDir` 传入时，在**首次**被调用那一刻抓一次现场——用来证明"初始采集完成后才调用 LLM"
 * （首次请求发出时，meta 已经带上了 v2 与初始快照）。
 */
export class ScriptedLlm {
  readonly requests: Message[][] = [];
  atFirstCall: { readonly files: readonly string[]; readonly metaLine: unknown } | null = null;
  private turn = 0;

  constructor(
    private readonly script: readonly ScriptedTurn[],
    private readonly tracesDir?: string,
  ) {}

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
    if (this.turn === 0 && this.tracesDir !== undefined) {
      this.atFirstCall = captureTraces(this.tracesDir);
    }
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

/** 编排层的 LLM 客户端类型（桩只实现 complete） */
export const asLoopLlm = (llm: ScriptedLlm): CreateIsolatedRunOptions["llm"] =>
  llm as unknown as CreateIsolatedRunOptions["llm"];

/** 抓一次 traces 目录现场：文件名清单 + 第一个临时文件的首行（meta） */
export function captureTraces(dir: string): { files: readonly string[]; metaLine: unknown } {
  if (!existsSync(dir)) {
    return { files: [], metaLine: null };
  }
  const files = [...readdirSync(dir)].sort();
  const tmp = files.find((name) => name.endsWith(".tmp"));
  if (tmp === undefined) {
    return { files, metaLine: null };
  }
  const firstLine = readFileSync(join(dir, tmp), "utf8").split("\n")[0] ?? "";
  return { files, metaLine: JSON.parse(firstLine) as unknown };
}

/**
 * 一份与固定 `file-tools-v1` 完全一致的 RunConfig。
 *
 * `tools` 直接取自 profile 常量本身（不是手抄一份）：改 profile 却忘了改这里，
 * 所有用例会一起以 `profile_mismatch` 失败——那正是想要的信号。
 */
export function makeConfig(systemPrompt = SYSTEM_PROMPT): RunConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    systemPrompt,
    tools: [...FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

/** 一轮 write_file 调用（args 是字符串，与真实 LLM 给的形式一致） */
export function writeCall(id: string, path: string, content: string) {
  return { id, name: WRITE_FILE_TOOL_NAME, args: JSON.stringify({ path, content }) };
}

/** 一轮 read_file 调用 */
export function readCall(id: string, path: string) {
  return { id, name: READ_FILE_TOOL_NAME, args: JSON.stringify({ path }) };
}

export function tracesDirOf(dataDir: string): string {
  return join(dataDir, WORKSPACE_TRACES_DIR_NAME);
}
