import type { RunConfig } from "@rebaseagent/agent-loop";
import type { Message } from "@rebaseagent/agent-loop";
import { FILE_TOOLS_V1_DEFINITIONS, preflightIsolatedPromptReplay } from "@rebaseagent/replay";
import {
  ISOLATED_PROMPT_REASON_MAX,
  IsolatedPromptCapabilityRequestSchema,
  fail,
  ok,
} from "../shared/ipc";
import type {
  Envelope,
  IsolatedPromptCapabilityResult,
  IsolatedPromptErrorCode,
  IsolatedPromptMessage,
} from "../shared/ipc";
import { type ExecutionConfigState, MAIN_EXECUTION_LIMITS } from "./execution-config-state";
import type { RunSettings } from "./settings";

/**
 * `workspaces:isolatedPromptCapability` 的 main 侧纯端点（R2.2 5.1/5.2）。
 *
 * 只读：不建运行、不写 trace/blob、不登记 operation、不占槽、不调模型。
 * 模型与启动消息以根首次请求为准；当前配置只贡献端点/key/执行限制。
 * 领域拒绝放在 ok 信封的 `status:"unavailable"` 里，以便携带非根导航建议 `rootId`；
 * 只有请求形状非法、配置未配置/读取失败才走失败信封。
 */

export interface IsolatedPromptEndpointDeps {
  readonly dataDir: string;
  /** 唯一配置修订拥有者：读取当前解密配置并在变化时轮换修订 */
  readonly configState: Pick<ExecutionConfigState, "refresh">;
}

function boundedReason(reason: string): string {
  return reason.length > ISOLATED_PROMPT_REASON_MAX
    ? reason.slice(0, ISOLATED_PROMPT_REASON_MAX)
    : reason;
}

/**
 * 预检/正式提交共用的当前配置载体：只有端点/key/工具/限制参与；
 * `model`/`systemPrompt`/`params` 由包层用根事实覆盖（预检也会拒绝它们覆盖基线）。
 */
export function buildPromptExperimentConfig(settings: RunSettings, dataDir: string): RunConfig {
  return {
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: "",
    tools: [...FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: dataDir, signal: null },
    maxIterations: MAIN_EXECUTION_LIMITS.maxIterations,
    budget: { ...MAIN_EXECUTION_LIMITS.budget },
  };
}

function toIpcMessages(messages: readonly Message[]): IsolatedPromptMessage[] {
  return messages.map((message) => {
    const name = (message as { name?: unknown }).name;
    return {
      role: message.role === "user" ? "user" : "system",
      content: message.content ?? "",
      ...(typeof name === "string" ? { name } : {}),
    };
  });
}

export async function runIsolatedPromptCapability(
  deps: IsolatedPromptEndpointDeps,
  request: unknown,
): Promise<Envelope<IsolatedPromptCapabilityResult>> {
  const parsed = IsolatedPromptCapabilityRequestSchema.safeParse(request);
  if (!parsed.success) {
    return fail("INVALID_ARGUMENT", parsed.error);
  }

  const snapshot = deps.configState.refresh();
  if (snapshot.loadError !== null) {
    return fail("SETTINGS_LOAD_FAILED", snapshot.loadError);
  }
  if (snapshot.settings === null) {
    return fail(
      "SETTINGS_NOT_CONFIGURED",
      new Error("尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置"),
    );
  }

  const config = buildPromptExperimentConfig(snapshot.settings, deps.dataDir);
  const preflight = await preflightIsolatedPromptReplay({
    dataDir: deps.dataDir,
    rootId: parsed.data.rootRunId,
    edit: parsed.data.edit,
    config,
    ...(parsed.data.hypothesis === undefined ? {} : { hypothesis: parsed.data.hypothesis }),
    ...(parsed.data.acceptanceCriterion === undefined
      ? {}
      : { acceptanceCriterion: parsed.data.acceptanceCriterion }),
  });

  if (!preflight.ok) {
    return ok({
      status: "unavailable",
      code: preflight.failure.code as IsolatedPromptErrorCode,
      reason: boundedReason(preflight.failure.reason),
      ...(preflight.failure.rootId === undefined ? {} : { rootId: preflight.failure.rootId }),
    });
  }

  const capability = preflight.value;
  return ok({
    status: "ok",
    rootId: capability.rootId,
    baselineLlmSpanId: capability.baselineLlmSpanId,
    initialSnapshotId: capability.initialSnapshot.id,
    fileCount: capability.fileCount,
    totalBytes: capability.totalBytes,
    originalValue: capability.originalValue,
    editedValue: capability.editedValue,
    systemPrompt: capability.systemPrompt,
    messages: toIpcMessages(capability.effectiveMessages),
    execution: {
      ...capability.execution,
      params:
        capability.execution.params === undefined ? undefined : { ...capability.execution.params },
      historicalUnknowns: [...capability.execution.historicalUnknowns],
    },
    configHash: capability.configHash,
    planFingerprint: capability.planFingerprint,
    configRevision: snapshot.revision,
    ...(parsed.data.hypothesis === undefined ? {} : { hypothesis: parsed.data.hypothesis }),
    ...(parsed.data.acceptanceCriterion === undefined
      ? {}
      : { acceptanceCriterion: parsed.data.acceptanceCriterion }),
    billing: capability.billing,
  });
}
