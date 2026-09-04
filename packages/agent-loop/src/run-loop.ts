import type { EndSpanPatch, Fork, StartSpanAttr, Tracer } from "@rebaseagent/trace-sdk";
import { configHash } from "./config-hash.js";
import type { Message, RunConfig, Tool } from "./config.js";
import type { LlmClient } from "./llm-client.js";
import { OpenAiCompatClient } from "./llm-client.js";
import { ToolRegistry } from "./tool-registry.js";

/**
 * fork run 元数据注入：仅覆盖新 run 的 id / parent / fork 三个 meta 字段，
 * 不引入任何可变状态，不改变循环语义。调用方（replay 编排层）负责先校验
 * config_hash 与父 run 一致——runLoop 无父 run 概念，信任注入。
 */
export interface ForkRunMeta {
  /** fork run 自身的 id（替代自动生成） */
  id: string;
  /** 父 run id（替代默认 null） */
  parent: string;
  /** 分叉描述（at_span + edit）；根 run 为 null，fork run 必填 */
  fork: Fork;
}

/** run 的最终结果 */
export interface RunResult {
  /** 完整消息演化（含初始消息与全部追加） */
  messages: Message[];
  /** 终止事件（与写出的 run.event 同构） */
  event: { event: "stopped" | "aborted" | "errored"; reason: string; at: number };
}

/** 工具 error 的固定渲染模板（前缀逐字节稳定的前提之一） */
export function renderToolError(error: string): string {
  return `工具执行失败：${error}`;
}

/** 从各轮 usage 求和派生累计 token（禁止自增累积） */
export function deriveTotalTokens(usages: Array<{ in: number; out: number }>): number {
  return usages.reduce((sum, u) => sum + u.in + u.out, 0);
}

/**
 * Agent 执行循环（纯函数式：输入只有 config + messages + tracer + tools）。
 *
 * - 运行中可变状态仅 messages（只追加，不修改不删除）
 * - 计数/成本从 messages 派生（usage 求和）
 * - 错误是数据：工具失败 → 带 error 的 tool_result，loop 继续
 * - 观测全部经 Tracer 流出，不写文件
 * - 只抛 loop 自身 bug（配置校验失败、Tracer 误用等）
 */
export async function runLoop(
  config: RunConfig,
  initialMessages: Message[],
  tracer: Tracer,
  tools: Tool[] = [],
  llm: LlmClient = new OpenAiCompatClient(config),
  forkRun?: ForkRunMeta,
): Promise<RunResult> {
  const messages: Message[] = [...initialMessages];
  const usages: Array<{ in: number; out: number }> = [];
  const registry = new ToolRegistry(tools);

  // config.tools 与 tools 必须一致（config 是纯数据契约，tools 含 handler）
  if (config.tools.length !== tools.length) {
    throw new Error("config.tools 与 tools（含 handler）数量不一致");
  }

  tracer.startRun({
    id: forkRun?.id ?? `run_${Date.now().toString(36)}`,
    format_version: 1,
    task: (messages.find((m) => m.role === "user")?.content as string) ?? "",
    model: config.model,
    created_at: new Date().toISOString(),
    parent: forkRun?.parent ?? null,
    fork: forkRun?.fork ?? null,
    // 预算随 run 录制为文件事实源；未声明 maxTotalTokens 则省略该字段（可选语义）
    budget:
      config.budget.maxTotalTokens !== undefined
        ? { max_total_tokens: config.budget.maxTotalTokens }
        : undefined,
    config_hash: configHash(config.systemPrompt, config.tools),
  });

  let iteration = 0;
  for (;;) {
    // 轮间中止检查（当前无未完成 span，直接收尾）
    if (config.exec.signal?.aborted) {
      return finish("aborted");
    }
    if (iteration >= config.maxIterations) {
      return finish("max_iterations");
    }
    if (deriveTotalTokens(usages) > (config.budget.maxTotalTokens ?? Number.MAX_SAFE_INTEGER)) {
      return finish("budget_exceeded");
    }

    iteration += 1;
    const step = tracer.startSpan({ kind: "agent.step", n: iteration } satisfies StartSpanAttr);

    // LLM 调用
    const llmSpan = tracer.startSpan({
      kind: "llm.call",
      parent: step,
      request: {
        model: config.model,
        messages: [...messages],
        ...(config.tools.length > 0 ? { tools: config.tools } : {}),
        ...(config.params !== undefined ? { params: config.params } : {}),
      },
    });

    let response: Awaited<ReturnType<LlmClient["complete"]>>["response"];
    try {
      response = (await llm.complete(messages, config.exec.signal ?? null)).response;
    } catch (e) {
      // 请求失败：记录失败 span 后按 error 终止（不重试）；messages 保持完整
      const message = e instanceof Error ? e.message : String(e);
      // 错误详情目前不落 trace（格式变更另走 spec），先打到主进程终端便于诊断
      console.error(`[runLoop] LLM 调用失败：${message}`);
      tracer.endSpan(llmSpan, {
        response: {
          content: null,
          reasoning_content: null,
          tool_calls: [],
          usage: { in: 0, out: 0 },
          ttft_ms: 0,
        },
      } satisfies EndSpanPatch);
      tracer.endSpan(step);
      tracer.endRun({ event: "errored", reason: "error", at: iteration });
      return { messages, event: { event: "errored", reason: "error", at: iteration } };
    }

    tracer.endSpan(llmSpan, {
      response: {
        content: response.content,
        reasoning_content: response.reasoningContent,
        tool_calls: response.toolCalls,
        usage: response.usage,
        ttft_ms: response.ttftMs,
      },
    } satisfies EndSpanPatch);

    usages.push(response.usage);
    messages.push({
      role: "assistant",
      content: response.content,
      ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {}),
    });

    // 工具调用（错误是数据：失败 → error tool_result，loop 继续）
    for (const call of response.toolCalls) {
      const toolSpan = tracer.startSpan({
        kind: "tool.invoke",
        parent: step,
        tool: call.function.name,
        args: safeParseArgs(call.function.arguments),
      } satisfies StartSpanAttr);
      const exec = await registry.execute(call.function.name, call.function.arguments, {
        cwd: config.exec.cwd,
        signal: config.exec.signal ?? null,
      });
      tracer.endSpan(toolSpan, {
        result: exec.result,
        dur_ms: exec.durMs,
        error: exec.error,
      } satisfies EndSpanPatch);
      messages.push({
        role: "tool",
        content: exec.error === null ? exec.result : renderToolError(exec.error),
        tool_call_id: call.id,
      });
    }
    tracer.endSpan(step);

    // 本轮结束后的终止判定
    if (response.toolCalls.length === 0) {
      return finish("completed");
    }
    if (config.exec.signal?.aborted) {
      return finish("aborted");
    }
    if (deriveTotalTokens(usages) > (config.budget.maxTotalTokens ?? Number.MAX_SAFE_INTEGER)) {
      return finish("budget_exceeded");
    }
  }

  function finish(
    reason: "completed" | "max_iterations" | "budget_exceeded" | "aborted",
  ): RunResult {
    const event = reason === "aborted" ? ("aborted" as const) : ("stopped" as const);
    tracer.endRun({ event, reason, at: iteration });
    return { messages, event: { event, reason, at: iteration } };
  }
}

/** args 解析失败也记为对象（trace 中 args 必须是对象） */
function safeParseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsJson);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { _raw: argsJson };
  } catch {
    return { _raw: argsJson };
  }
}
