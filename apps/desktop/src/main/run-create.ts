import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { OpenAiCompatClient, runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, Message, RunConfig, RunResult } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import type { RunRepository } from "./run-repository";
import type { RunSettings } from "./settings";

/**
 * runs:create 的编排：在 main 进程从头执行一个原生 run。
 *
 * 职责：
 * - 取运行配置（baseURL / apiKey / model）组装仅含对话的 RunConfig（空工具表）
 * - 用 runLoop 真实执行（OpenAiCompatClient）；测试可注入 mock，零 API
 * - 落盘成可被仓库按 id 加载的 `${meta.id}.jsonl`
 *
 * 语义边界（详见 change design.md）：
 * - 这是"从头执行"，不是"重跑"——没有父 run，不经 replay 包，也不需要 config_hash 门禁
 * - 与代理分叉（编辑 messages 重发）正交
 */

export interface RunCreateOptions {
  repository: RunRepository;
  /** 运行配置（main 已解密；未配置由调用方先行拦截） */
  settings: RunSettings;
  /** 工具执行的工作目录（首期空工具表，保持与 fork 同形） */
  execCwd: string;
  /** LLM 客户端（测试注入 mock；缺省真实调用 settings.baseURL） */
  llm?: LlmClient;
}

export interface RunCreateRequest {
  /** 可为空字符串：空 ⇒ config_hash = configHash("", []) */
  systemPrompt: string;
  /** 必填非空（renderer 已拦一次，main 侧 zod 兜底） */
  userMessage: string;
}

/** 各 IPC 错误码（渲染层据此给中文提示） */
export const CREATE_RUN_ERROR_CODES = {
  RUN_FAILED: "CREATE_RUN_FAILED",
} as const;

export class CreateRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CreateRunError";
  }
}

/** 与既有 fork 编排的硬编码值保持一致（避免两套口径分叉；可配置留作后续扩展） */
const MAX_ITERATIONS = 10;
const MAX_TOTAL_TOKENS = 100_000;

export async function runCreate(
  options: RunCreateOptions,
  request: RunCreateRequest,
): Promise<{ id: string }> {
  const { repository, settings, execCwd, llm } = options;
  const tracesDir = repository.tracesDir;

  // 1. 组装 RunConfig（空工具表；config.tools 与传给 runLoop 的 tools 必须等长）
  const config: RunConfig = {
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: request.systemPrompt,
    tools: [],
    exec: { cwd: execCwd, signal: null },
    maxIterations: MAX_ITERATIONS,
    budget: { maxTotalTokens: MAX_TOTAL_TOKENS },
  };

  // 2. 初始消息：system 恒存在（内容可为空串）——prompt fork 的门禁要求首次
  //    llm.call 含"字符串形式的 system 消息"（replay/src/fork-parent.ts:64-69），
  //    空串也是字符串；省掉这条消息会让新建 run 无法作为 prompt fork 父本。
  const messages: Message[] = [
    { role: "system", content: request.systemPrompt },
    { role: "user", content: request.userMessage },
  ];

  // 3. 落盘：根 run 的 id 由 runLoop 内部生成（无法预先指定），而仓库按
  //    `${id}.jsonl` 定位文件 ⇒ 先写临时文件，结束后按 meta.id 改名。
  //    临时文件不带 .jsonl 后缀 ⇒ 列表扫描（run-repository.ts:19）看不见半成品。
  const tmpFile = join(
    tracesDir,
    `tmp-create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const tracer = new JsonlTracer(tmpFile);

  let outcome: RunResult;
  let runId: string | null = null;
  try {
    // 第 6 参 forkRun 必须省略（可选参数，省略 = 根 run，parent/fork 均为 null）。
    // ⚠️ 不能传 null——那是类型错误，也会误表达"显式的空分叉"。
    outcome = await runLoop(config, messages, tracer, [], llm ?? new OpenAiCompatClient(config));
  } finally {
    // 成功与失败都要归位：error run 也是事实（spec 要求它存在且状态为 error）。
    // readRun 对残缺文件会抛（进程中途被杀）——此时保留 tmp 供排查，错误照常向上抛。
    if (existsSync(tmpFile)) {
      runId = readRun(tmpFile).meta.id;
      renameSync(tmpFile, join(tracesDir, `${runId}.jsonl`));
    }
  }

  // 4. runLoop 不抛 LLM 失败：它记 errored 并正常返回（run-loop.ts:113-130），
  //    因此成败判据是终止事件而非 try/catch。
  //
  //    ⚠️ 失败原因（如 HTTP 401 的响应体）目前只被 runLoop 打到主进程日志，
  //    不写入 trace（端上 llm.call 的 response 只有空 content 与 0 usage）。
  //    文案因此只承诺"能点开看这次请求"，不承诺 trace 里有错误详情。
  if (outcome.event.event === "errored") {
    throw new CreateRunError(
      CREATE_RUN_ERROR_CODES.RUN_FAILED,
      `新建 run 执行失败：模型调用未完成（终止原因 ${outcome.event.reason}）。run ${runId ?? "(未落盘)"} 已落盘，可在列表中点开查看这次请求；trace 不记录错误详情，请看应用主进程日志。`,
    );
  }

  if (runId === null) {
    throw new CreateRunError(CREATE_RUN_ERROR_CODES.RUN_FAILED, "run 未产出任何 trace 文件");
  }

  return { id: runId };
}
