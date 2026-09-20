import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { OpenAiCompatClient, runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, Message, RunConfig, RunResult } from "@rebaseagent/agent-loop";
import { FILE_TOOLS_V1_DEFINITIONS, createIsolatedRun } from "@rebaseagent/replay";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import type { IsolatedWorkspaceSelection } from "../shared/ipc";
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

  // 4. runLoop 不抛 LLM 失败：它记 errored 并正常返回（run-loop.ts:111-135），
  //    因此成败判据是终止事件而非 try/catch。
  //
  //    失败原因（如 HTTP 401 的响应体）已随失败 span 的 error 字段落盘（脱敏 + 限长），
  //    用户点开该 run 即可看到，无需再翻主进程日志——文案照此引导。
  if (outcome.event.event === "errored") {
    throw new CreateRunError(
      CREATE_RUN_ERROR_CODES.RUN_FAILED,
      `新建 run 执行失败：模型调用未完成（终止原因 ${outcome.event.reason}）。run ${runId ?? "(未落盘)"} 已落盘，可在列表中点开该 run，查看失败的那次 LLM 调用上的错误详情。`,
    );
  }

  if (runId === null) {
    throw new CreateRunError(CREATE_RUN_ERROR_CODES.RUN_FAILED, "run 未产出任何 trace 文件");
  }

  return { id: runId };
}

// ---------------------------------------------------------------------------
// 隔离文件模式（B 1.4）：runs:create 的 workspace 分支
// ---------------------------------------------------------------------------

export interface RunCreateIsolatedOptions extends RunCreateOptions {
  /** 数据目录（main 按便携策略注入）：trace 落 `<dataDir>/traces`，附件落 workspace-blobs */
  dataDir: string;
  /** 源目录真实路径（handler 已用 sourceToken 换出；renderer 永远拿不到签发前路径的书写权） */
  sourcePath: string;
}

export interface RunCreateIsolatedRequest {
  systemPrompt: string;
  userMessage: string;
  /** 已过 zod 校验的选择（mode/sourceToken/allowFileWrites:true）；token 消费在 handler */
  workspace: IsolatedWorkspaceSelection;
}

/** 隔离创建的失败码（渲染层据此提示；reason 来自 A 包的原始分类） */
export const ISOLATED_CREATE_ERROR_CODE = "ISOLATED_CREATE_FAILED";

/**
 * 隔离文件模式的 runs:create 编排：把 A 的 `createIsolatedRun` 接进桌面写通道。
 *
 * 职责边界（design §1/§4）：
 * - 工具表**恒为**固定 `file-tools-v1` profile（`FILE_TOOLS_V1_DEFINITIONS` 是唯一事实源，
 *   不得手抄第二份）——`checkToolProfile` 逐字段核对，桌面不定义自己的变体
 * - dataDir 由 main 注入；源目录校验（形态 / 与 dataDir 的关系 / 真实性）由 A 包在
 *   导入前重新做，桌面不预判、不降级
 * - `authority` 原样透传本次请求的授权声明：zod 层已保证 `allowFileWrites === true`，
 *   A 的 `checkWriteAuthority` 仍会再验一次（不信任调用方）
 * - LLM `errored` 也是落盘事实：run 照常归位，错误语义与普通创建一致（CREATE_RUN_FAILED
 *   + 引导查看详情），不因为隔离模式改变失败表现
 */
export async function runCreateIsolated(
  options: RunCreateIsolatedOptions,
  request: RunCreateIsolatedRequest,
): Promise<{ id: string }> {
  const { settings, dataDir, sourcePath, llm } = options;

  const config: RunConfig = {
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: request.systemPrompt,
    tools: [...FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: dataDir, signal: null },
    maxIterations: MAX_ITERATIONS,
    budget: { maxTotalTokens: MAX_TOTAL_TOKENS },
  };

  const result = await createIsolatedRun({
    dataDir,
    source: sourcePath,
    config,
    userMessage: request.userMessage,
    authority: request.workspace,
    llm: llm ?? new OpenAiCompatClient(config),
  });

  if (!result.ok) {
    throw new CreateRunError(
      ISOLATED_CREATE_ERROR_CODE,
      `隔离创建被拒绝（${result.failure.code}）：${result.failure.reason}`,
    );
  }

  // 成功也可能以 errored 终止（模型调用失败）：run 已按 meta.id 归位且可读，
  // 文案与普通创建保持同一语义——引导用户点开 run 看失败的那次 LLM 调用。
  if (result.outcome.event.event === "errored") {
    throw new CreateRunError(
      CREATE_RUN_ERROR_CODES.RUN_FAILED,
      `新建 run 执行失败：模型调用未完成（终止原因 ${result.outcome.event.reason}）。run ${result.id} 已落盘，可在列表中点开该 run，查看失败的那次 LLM 调用上的错误详情。`,
    );
  }

  return { id: result.id };
}
