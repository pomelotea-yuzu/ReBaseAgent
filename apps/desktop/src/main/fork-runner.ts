import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { OpenAiCompatClient } from "@rebaseagent/agent-loop";
import type { LlmClient, RunConfig, Tool, ToolDef } from "@rebaseagent/agent-loop";
import { promptReplayRun, replayRun } from "@rebaseagent/replay";
import type { RunRecord, SpanLine } from "@rebaseagent/trace-sdk";
import type { RunRepository } from "./run-repository";
import type { RunSettings } from "./settings";

/**
 * runs:fork 的编排：把"编辑某 tool.invoke 的 result 并重跑"在 main 进程执行到底。
 *
 * 职责：
 * - 校验 at_span 属于叶子 run 自身新增段（在祖先共享前缀上分叉语义未定义，拒绝）
 * - 从父 run 录制重建 config（system prompt / 工具表 / 采样参数原样来自录制，
 *   baseURL/apiKey/model 来自运行配置）→ config_hash 与原 run 天然一致；
 *   不一致说明录制与现算算法漂移，交由 replayRun 拒绝（异源 ≠ 时间旅行）
 * - 桌面内置工具 registry 只覆盖 read_file / write_file；父 run 用过其他工具
 *   一律拒绝（诚实 MVP：没有沙箱就承认不支持，不假装能重跑）
 * - 真实 LLM 调用（OpenAiCompatClient）；测试可注入 mock，零 API
 */

export interface ForkRunnerOptions {
  repository: RunRepository;
  /** 运行配置（main 已解密；未配置由调用方先行拦截） */
  settings: RunSettings;
  /** 工具执行的工作目录（trace 不记录首次 cwd，桌面以数据目录为落点） */
  execCwd: string;
  /** LLM 客户端（测试注入 mock；缺省真实调用 settings.baseURL） */
  llm?: LlmClient;
}

/** 各 IPC 错误码（渲染层据此给中文提示） */
export const FORK_ERROR_CODES = {
  SPAN_NOT_IN_LEAF: "FORK_SPAN_NOT_IN_LEAF",
  UNKNOWN_TOOL: "FORK_UNKNOWN_TOOL",
} as const;

export class ForkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ForkError";
  }
}

export async function runFork(
  options: ForkRunnerOptions,
  request: {
    parentRunId: string;
    atSpanId: string;
    edit: { field: "result"; value: string };
  },
): Promise<{ id: string }> {
  const { repository, settings, execCwd, llm } = options;

  // 1. 叶子 run 记录（缺失/损坏/未封存都由 replayRun 后续给出明确错误）
  const leaf = repository.loadRunRecord(request.parentRunId);

  // 2. at_span 必须属于叶子 run 自身新增段（leaf-first 语义；祖先共享前缀上分叉 = 改历史，MVP 拒绝）
  const atSpan = leaf.spans.find((s) => s.id === request.atSpanId);
  if (atSpan === undefined || atSpan.kind !== "tool.invoke") {
    throw new ForkError(
      FORK_ERROR_CODES.SPAN_NOT_IN_LEAF,
      `分叉点 ${request.atSpanId} 必须是当前 run 自身轨迹中的 tool.invoke（祖先共享前缀上的 span 不可作为分叉点）`,
    );
  }

  // 3. 重建 config：system prompt / 工具表 / 采样参数从分叉点所在 step 的 llm.call 录制取
  const stepLlm = findStepLlm(leaf, atSpan);
  if (stepLlm === null) {
    throw new ForkError(
      "FORK_NO_CONTEXT",
      `分叉点 ${request.atSpanId} 所在 step 缺少 llm.call 录制，无法重建重跑配置`,
    );
  }
  const recordedMessages = stepLlm.request.messages;
  const systemMessage = recordedMessages.find((m) => m.role === "system");
  if (systemMessage === undefined || typeof systemMessage.content !== "string") {
    throw new ForkError("FORK_NO_CONTEXT", "父 run 录制缺少 system 消息，无法重建重跑配置");
  }
  const recordedTools = stepLlm.request.tools;
  if (recordedTools === undefined) {
    throw new ForkError("FORK_NO_CONTEXT", "父 run 录制缺少工具表，无法重建重跑配置");
  }

  // 4. 桌面内置 registry 覆盖检查：未知工具拒绝（诚实 MVP 边界）
  const toolDefs = toToolDefs(recordedTools);
  const tools = attachHandlers(toolDefs);
  if (tools === null) {
    const unknown = toolDefs.map((t) => t.name).filter((name) => !HANDLERS.has(name));
    throw new ForkError(
      FORK_ERROR_CODES.UNKNOWN_TOOL,
      `桌面端暂不支持重跑工具：${unknown.join("、")}（内置 read_file/write_file）`,
    );
  }

  const config: RunConfig = {
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: systemMessage.content,
    tools: toolDefs,
    params: sanitizeParams(stepLlm.request.params),
    exec: { cwd: execCwd, signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100_000 },
  };

  // 5. replayRun：config_hash 一致（重建自录制应天然相等；异源会在此被拒）、
  //    落盘 outDir/<id>.jsonl（只新增文件，父文件不变）
  const result = await replayRun({
    parentId: request.parentRunId,
    atSpanId: request.atSpanId,
    edit: request.edit,
    config,
    tools,
    load: (id) => repository.loadRunRecord(id),
    outDir: repository.tracesDir,
    llm: llm ?? new OpenAiCompatClient(config),
  });
  return { id: result.id };
}

// ---------------------------------------------------------------------------
// runs:promptFork —— 编辑启动上下文（system prompt / 首条 user message）从头重跑
// ---------------------------------------------------------------------------

/** prompt fork 专属错误码（渲染层据此给中文提示） */
export const PROMPT_FORK_ERROR_CODES = {
  /** 首次 llm.call 缺少字符串 system 消息：RunConfig.systemPrompt 无法重建 */
  NO_SYSTEM: "PROMPT_FORK_NO_SYSTEM",
} as const;

/**
 * prompt fork 的桌面编排：与 runFork 共用工具表重建，但语义正交——
 * - 启动上下文只来自父 run 首次 llm.call 的录制请求（从头重跑，不共享前缀）
 * - 不要求 config_hash 与父一致（改 system prompt 本来就是新实验）
 * - config.systemPrompt 传父 run 录制原值；编排层会以编辑派生值覆写（双真相源守护）
 */
export async function runPromptFork(
  options: ForkRunnerOptions,
  request: {
    parentRunId: string;
    edit: { field: "system_prompt" | "user_message"; value: string };
  },
): Promise<{ id: string }> {
  const { repository, settings, execCwd, llm } = options;

  // 1. 父 run 的首次 llm.call（文件序 = 执行序；启动上下文的唯一事实源）
  const leaf = repository.loadRunRecord(request.parentRunId);
  const firstLlm = leaf.spans.find((s) => s.kind === "llm.call");
  if (firstLlm === undefined || firstLlm.kind !== "llm.call") {
    throw new ForkError(
      "FORK_NO_CONTEXT",
      `父 run ${leaf.meta.id} 的轨迹中没有 llm.call 录制，无法定位启动上下文`,
    );
  }

  // 2. 字符串 system 消息是重建 RunConfig.systemPrompt 的唯一来源：
  //    缺失时整个 prompt fork 不可用（不反推 config_hash、不猜、不假定空字符串）
  const systemMessage = firstLlm.request.messages.find(
    (m) => m.role === "system" && typeof m.content === "string",
  );
  if (systemMessage === undefined || typeof systemMessage.content !== "string") {
    throw new ForkError(
      PROMPT_FORK_ERROR_CODES.NO_SYSTEM,
      "父 run 首次 llm.call 不含字符串形式的 system 消息，无法重建 RunConfig.systemPrompt，prompt fork 不可用",
    );
  }

  // 3. 工具表从首次 llm.call 录制重建（与 runFork 同源的重建 + 覆盖检查）
  const recordedTools = firstLlm.request.tools;
  if (recordedTools === undefined) {
    throw new ForkError("FORK_NO_CONTEXT", "父 run 录制缺少工具表，无法重建重跑配置");
  }
  const toolDefs = toToolDefs(recordedTools);
  const tools = attachHandlers(toolDefs);
  if (tools === null) {
    const unknown = toolDefs.map((t) => t.name).filter((name) => !HANDLERS.has(name));
    throw new ForkError(
      FORK_ERROR_CODES.UNKNOWN_TOOL,
      `桌面端暂不支持重跑工具：${unknown.join("、")}（内置 read_file/write_file）`,
    );
  }

  const config: RunConfig = {
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    // 传父 run 录制原值；promptReplayRun 会以编辑派生值强制覆写（双真相源）
    systemPrompt: systemMessage.content,
    tools: toolDefs,
    params: sanitizeParams(firstLlm.request.params),
    exec: { cwd: execCwd, signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100_000 },
  };

  // 4. promptReplayRun：校验（封存/config_hash/空 fork/编辑目标）→ 从头重跑落盘
  const result = await promptReplayRun({
    parentId: request.parentRunId,
    edit: request.edit,
    config,
    tools,
    load: (id) => repository.loadRunRecord(id),
    outDir: repository.tracesDir,
    llm: llm ?? new OpenAiCompatClient(config),
  });
  return { id: result.id };
}

/** 定位分叉点 tool.invoke 所在 step 的 llm.call（与 derive 同源的查表逻辑） */
function findStepLlm(
  record: RunRecord,
  atSpan: Extract<SpanLine, { kind: "tool.invoke" }>,
): Extract<SpanLine, { kind: "llm.call" }> | null {
  if (atSpan.parent === null) return null;
  const step = record.spans.find((s) => s.id === atSpan.parent);
  if (step === undefined || step.kind !== "agent.step") return null;
  const llm = record.spans.find((s) => s.parent === step.id && s.kind === "llm.call");
  return llm !== undefined && llm.kind === "llm.call" ? llm : null;
}

// ---------------------------------------------------------------------------
// 桌面内置工具 registry（真实读写 exec.cwd 下文件，路径限定在 cwd 内）
// ---------------------------------------------------------------------------

type DesktopToolHandler = Tool["handler"];

interface RegisteredTool {
  sideEffect: boolean;
  handler: DesktopToolHandler;
}

const HANDLERS: ReadonlyMap<string, RegisteredTool> = new Map([
  [
    "read_file",
    {
      sideEffect: false,
      handler: (args, ctx) => {
        const path = resolvePath(ctx.cwd, (args as { path?: unknown }).path);
        return readFileSync(path, "utf8");
      },
    },
  ],
  [
    "write_file",
    {
      sideEffect: true,
      handler: (args, ctx) => {
        const { path, content } = args as { path?: unknown; content?: unknown };
        const target = resolvePath(ctx.cwd, path);
        mkdirSync(dirname(target), { recursive: true });
        const text = String(content ?? "");
        writeFileSync(target, text, "utf8");
        return `已写入 ${relative(ctx.cwd, target)}（${text.length} 字节）`;
      },
    },
  ],
]);

/** 路径解析 + cwd 包含检查（不做沙箱，但至少不许读写工作目录之外） */
function resolvePath(cwd: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("path 必须是非空字符串");
  }
  const resolved = resolve(cwd, raw);
  const rel = relative(cwd, resolved);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(`路径越界：${raw}（工具只允许读写工作目录内的文件）`);
  }
  return resolved;
}

/** 录制 params（跨包类型为 Record<string, unknown>）规整为 RunConfig 的数值采样参数 */
function sanitizeParams(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 把录制的工具表规整为 ToolDef。录制存在两种合法形状：
 * - 引擎新录制（runLoop 直接把 config.tools 写进 request.tools）：扁平
 *   { name, description, parameters, sideEffect? }
 * - 旧版手工 trace / 第三方兼容录制：OpenAI 请求体包装
 *   { type: "function", function: { name, description, parameters } }
 * 两种都解包为 ToolDef；sideEffect 仅在有布尔值时带出（config_hash 规范化的前提）。
 * 无法解析（如旧 fixture 每步只录单工具的残缺表）给出明确指引，不静默猜测。
 */
function toToolDefs(recorded: readonly Record<string, unknown>[]): ToolDef[] {
  const defs: ToolDef[] = [];
  for (const raw of recorded) {
    const def = unwrapToolDef(raw);
    if (def === null) {
      throw new ForkError(
        "FORK_NO_CONTEXT",
        "父 run 录制的工具表无法解析（需 name/description/parameters 或 OpenAI 的 function 包装）。" +
          "手工构造的旧 trace（每步只带单工具、config_hash 非引擎现算）不能作为分叉父本——" +
          "请对由 ReBaseAgent 引擎录制、config_hash 现算的 run 执行“在此重跑”",
      );
    }
    defs.push(def);
  }
  return defs;
}

function unwrapToolDef(raw: Record<string, unknown>): ToolDef | null {
  const wrapped = raw.function;
  const inner =
    typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : raw;
  const { name, description, parameters, sideEffect } = inner;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters)
  ) {
    return null;
  }
  return {
    name,
    description,
    parameters: parameters as Record<string, unknown>,
    ...(typeof sideEffect === "boolean" ? { sideEffect } : {}),
  };
}

/**
 * 为工具定义挂上桌面 handler；存在注册表外的工具时返回 null（调用方拒绝）。
 * 定义字段（name/description/parameters/sideEffect）原样保留录制值——
 * config_hash 一致的前提；handler 只是本地执行能力的附加。
 */
function attachHandlers(defs: readonly ToolDef[]): Tool[] | null {
  const tools: Tool[] = [];
  for (const def of defs) {
    const registered = HANDLERS.get(def.name);
    if (registered === undefined) {
      return null;
    }
    tools.push({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      ...(def.sideEffect === undefined ? {} : { sideEffect: def.sideEffect }),
      handler: registered.handler,
    });
  }
  return tools;
}
