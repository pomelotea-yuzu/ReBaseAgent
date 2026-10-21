import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { OpenAiCompatClient, runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, Message, RunConfig, RunResult, ToolDef } from "@rebaseagent/agent-loop";
import { JsonlTracer, PROMPT_EXPERIMENT_FORMAT_VERSION, readRun } from "@rebaseagent/trace-sdk";
import { newForkRunId } from "../replay-run.js";
import { observeRunIdentity } from "../run-identity.js";
import type { OnRunIdentified } from "../run-identity.js";
import { createWorkspaceCheckpointTracer } from "./checkpoint-tracer.js";
import { FILE_TOOLS_V1_DEFINITIONS, createFileToolsV1 } from "./file-tools.js";
import { preflightIsolatedPromptReplay } from "./isolated-prompt-preflight.js";
import type { IsolatedPromptPreflightFailureCode } from "./isolated-prompt-preflight.js";
import type { IsolatedPromptEdit } from "./isolated-prompt-state.js";
import { checkWriteAuthority } from "./profile-guard.js";
import { WORKSPACE_TRACES_DIR_NAME } from "./read-api.js";
import { createWorkspaceWorld } from "./world.js";

/**
 * **隔离 prompt 实验编排**（R2.2 design D4）：`promptReplayIsolatedRun`。
 *
 * 语义一句话：从**根运行的初始快照**建立一个全新世界，只替换一条启动指令，
 * 从第 1 步真实调用模型与固定文件工具，并写出 v3 实验轨迹。
 *
 * ## 顺序（授权/预检先于一切副作用）
 *
 * ```
 * 当前请求授权 → 提交时重新预检（D1/D2/D3，零副作用）
 *   → 从已核验 initial_snapshot 建新世界 → 固定受控工具
 *   → 临时 trace（v3 + initial origin + prompt_experiment）
 *   → runLoop（从第 1 步；失败即落盘事实）→ 按 meta.id 归位
 * ```
 *
 * ## 与其它入口的边界
 *
 * - **不复用父 spans / 父消息前缀**：启动消息来自根首次请求 + 单项编辑，父记录仅溯源。
 * - **不回读源目录**：世界只认初始清单与附件存储；源目录的当前状态不参与。
 * - **不接受外部 handler / 物理路径 / 快照对象**：工具由固定工厂从世界造，起点快照来自预检。
 * - **模型/参数固定为根首次请求**；桌面 settings 的 model/params 不覆盖基线。
 * - **当前授权只来自本次请求**；父 trace 的 `write_authorized` 只是审计标注。
 */

export interface PromptReplayIsolatedRunOptions {
  /** 数据目录：根与附件都在其下；新 trace 写入 `<dataDir>/traces` */
  readonly dataDir: string;
  /** 已核验的根 run id（预检会再次核对根资格） */
  readonly rootId: string;
  /** 单项启动指令编辑 */
  readonly edit: IsolatedPromptEdit;
  /** 当前执行配置：端点/key/限制取当前；模型与启动消息由根事实覆盖 */
  readonly config: RunConfig;
  /** 当前请求的副本写入授权：唯一通过形状 `{ allowFileWrites: true }` */
  readonly authority: unknown;
  readonly hypothesis?: string;
  readonly acceptanceCriterion?: string;
  /**
   * 可选：调用方确认过的计划指纹（来自只读预检）。提交时重验结果不同即拒绝，
   * 避免"确认后根/配置变化"仍按新计划执行。
   */
  readonly expectedPlanFingerprint?: string;
  /** LLM 客户端（测试注入 mock；缺省真调当前端点） */
  readonly llm?: LlmClient;
  /**
   * 可信身份观察：最终 v3 meta 写出后、首次 LLM 前通知一次实际 run id。
   * 前置拒绝不回调；执行后失败（模型/存储）仍保留已报告身份。
   */
  readonly onRunIdentified?: OnRunIdentified;
}

export type PromptReplayIsolatedRunFailureCode =
  | "missing_authority"
  | "plan_changed"
  | "invalid_snapshot"
  | "run_not_landed"
  | IsolatedPromptPreflightFailureCode;

export interface PromptReplayIsolatedRunFailure {
  readonly code: PromptReplayIsolatedRunFailureCode;
  readonly reason: string;
}

export type PromptReplayIsolatedRunResult =
  | {
      readonly ok: true;
      /** 新 v3 run 的 id（文件位于 `<dataDir>/traces/<id>.jsonl`） */
      readonly id: string;
      /** loop 终止结果（模型失败是 `errored` 落盘事实，不是异常） */
      readonly outcome: RunResult;
    }
  | { readonly ok: false; readonly failure: PromptReplayIsolatedRunFailure };

function fail(
  code: PromptReplayIsolatedRunFailureCode,
  reason: string,
): { readonly ok: false; readonly failure: PromptReplayIsolatedRunFailure } {
  return { ok: false, failure: { code, reason } };
}

/**
 * 执行一次隔离 prompt 实验。
 *
 * 返回 `ok: true` 表示 v3 文件已归位（即使 `outcome.event.event === "errored"`：
 * 失败现场也是事实，调用方据 `outcome` 决定提示）。前置拒绝零子记录、零模型调用。
 */
export async function promptReplayIsolatedRun(
  options: PromptReplayIsolatedRunOptions,
): Promise<PromptReplayIsolatedRunResult> {
  const { dataDir, rootId, edit, config, authority, llm } = options;

  // ── 1. 当前写入授权：唯一授权输入，先于任何预检 IO ────────────────────────────────────
  const authorityCheck = checkWriteAuthority(authority);
  if (!authorityCheck.ok) {
    return fail("missing_authority", authorityCheck.failure.reason);
  }

  // ── 2. 提交时重新预检（不信任调用方此前的预检结果）────────────────────────────────────
  const preflight = await preflightIsolatedPromptReplay({
    dataDir,
    rootId,
    edit,
    config,
    ...(options.hypothesis === undefined ? {} : { hypothesis: options.hypothesis }),
    ...(options.acceptanceCriterion === undefined
      ? {}
      : { acceptanceCriterion: options.acceptanceCriterion }),
  });
  if (!preflight.ok) {
    return fail(preflight.failure.code, preflight.failure.reason);
  }
  const capability = preflight.value;

  // 调用方确认过的计划必须与提交时重验结果一致；任何漂移都要重新确认。
  if (
    options.expectedPlanFingerprint !== undefined &&
    capability.planFingerprint !== options.expectedPlanFingerprint
  ) {
    return fail(
      "plan_changed",
      `确认后的计划已变化（确认 ${options.expectedPlanFingerprint}，当前 ${capability.planFingerprint}）：请重新预检并确认，不能沿用旧许可`,
    );
  }

  // ── 3. 新世界：起点 = root initial_snapshot（不读父最终状态/当前源目录）─────────────────
  const created = createWorkspaceWorld({
    dataDir,
    snapshot: capability.initialSnapshot,
    // 授权已在第 1 步通过门禁；这里传 true 是把校验结果转成世界入参，不是新判定。
    allowFileWrites: true,
  });
  if (!created.ok) {
    return fail("invalid_snapshot", created.failure.reason);
  }
  const world = created.value;

  // ── 4. 固定受控工具：从世界造，调用方无法塞 handler ───────────────────────────────────
  const tools = createFileToolsV1(world);

  // ── 5. 有效配置：模型/params/启动消息用根事实；端点/key/exec 用当前配置 ────────────────
  const effectiveConfig: RunConfig = {
    ...config,
    systemPrompt: capability.systemPrompt,
    model: capability.execution.model,
    params:
      capability.execution.params === undefined ? undefined : { ...capability.execution.params },
    tools: [...FILE_TOOLS_V1_DEFINITIONS] as ToolDef[],
    maxIterations: capability.execution.maxIterations,
    budget: {
      maxTotalTokens: capability.execution.budget.maxTotalTokens,
      ...(capability.execution.budget.maxCost === undefined
        ? {}
        : { maxCost: capability.execution.budget.maxCost }),
    },
  };

  // ── 6. 临时 trace：v3 + initial origin + prompt_experiment ────────────────────────────
  const tracesDir = join(dataDir, WORKSPACE_TRACES_DIR_NAME);
  // JsonlTracer 不建目录；父根 trace 已在里面时这一步幂等。
  mkdirSync(tracesDir, { recursive: true });
  const runId = newForkRunId();
  const tmpFile = join(
    tracesDir,
    `tmp-isolated-prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const delegate = new JsonlTracer(tmpFile);
  const tracer = createWorkspaceCheckpointTracer({
    delegate,
    world,
    runId,
    origin: {
      kind: "initial",
      run_id: capability.rootId,
      snapshot_id: capability.initialSnapshot.id,
    },
    formatVersion: PROMPT_EXPERIMENT_FORMAT_VERSION,
    promptExperiment: capability.promptExperiment,
  });

  // 独立执行边界：parent 仅供溯源，fork 不带 resume_after_step。
  const forkRun = {
    id: runId,
    parent: capability.rootId,
    fork: {
      at_span: capability.baselineLlmSpanId,
      edit: { field: edit.field, value: edit.value },
    },
  };

  let outcome: RunResult | null = null;
  let landedId: string | null = null;
  // 身份观察挂底层 delegate：拿到的是 checkpoint tracer 注入后的最终 v3 meta.id。
  const releaseIdentityWatch = observeRunIdentity(delegate, options.onRunIdentified);
  try {
    outcome = await runLoop(
      effectiveConfig,
      [...capability.effectiveMessages] as Message[],
      tracer,
      tools,
      llm ?? new OpenAiCompatClient(effectiveConfig),
      forkRun,
    );
  } finally {
    releaseIdentityWatch();
    // 与既有隔离编排同序：先释放句柄，再归位；errored/未封存记录都保留。
    delegate.dispose();
    if (existsSync(tmpFile)) {
      landedId = readRun(tmpFile).meta.id;
      renameSync(tmpFile, join(tracesDir, `${landedId}.jsonl`));
    }
  }

  if (outcome === null || landedId === null) {
    return fail(
      "run_not_landed",
      "隔离 prompt 实验未产出 trace 文件（loop 未走到 startRun，或临时文件已丢失）",
    );
  }

  return { ok: true, id: landedId, outcome };
}
