import { isAbsolute } from "node:path";
import { configHash } from "@rebaseagent/agent-loop";
import type { Message, RunConfig, ToolDef } from "@rebaseagent/agent-loop";
import { TraceReadError, assertForkable, readRun } from "@rebaseagent/trace-sdk";
import type { PromptExperiment, RunRecord, WorkspaceSnapshot } from "@rebaseagent/trace-sdk";
import { toToolDefs } from "../tool-unwrap.js";
import { WorkspaceBlobError, createWorkspaceBlobStore } from "./blob-store.js";
import { FILE_TOOLS_V1_DEFINITIONS, FILE_TOOLS_V1_PROFILE } from "./file-tools.js";
import {
  computePlanFingerprint,
  deriveIsolatedPromptState,
  sanitizeProviderEndpoint,
  validateIsolatedPromptEdit,
} from "./isolated-prompt-state.js";
import type { IsolatedPromptEdit } from "./isolated-prompt-state.js";
import { checkToolProfile } from "./profile-guard.js";
import { findFileSetQuotaViolation } from "./quota.js";
import { workspaceTraceFile } from "./read-api.js";

/**
 * **隔离 prompt 实验的只读预检**（R2.2 design D1/D2/D3）。
 *
 * 回答"这个根运行能不能作为启动指令实验的基线、编辑后第一次真实请求会是什么"，
 * 并把**可区分的原因**交还给调用方。三条硬约束：
 *
 * 1. **零执行副作用**：不写 trace/附件、不建目录、不分配 run 身份、不登记 operation、
 *    不调 LLM。只读 JSONL 与附件字节。
 * 2. **只认根**：直接父必须是已封存、来源完整的 `file-tools-v1` 隔离根（parent/fork 均为 null、
 *    origin=import）。中途 result 分支或 v3 分支只返回经完整父链验证的 `rootId` 作为**导航建议**，
 *    仍以 `parent_not_root` 拒绝——不把 rootId 当成已授权目标，也不自动换基线。
 * 3. **提交时重验**：预检结果不是执行凭证；正式提交（3.4）会重新调用本函数。
 *
 * 校验顺序：请求形状/安全 run ID → 父链完整（环/缺失/IO）→ 已封存 → 隔离根 →
 * 首次启动消息/单项编辑/params（纯派生）→ 固定 profile 与父根 config_hash →
 * 当前配置/预算/端点 → 初始清单配额 → 全部附件字节。
 *
 * 附件是最后一步（最贵）；缺失与损坏分别可辨认，真实 I/O 故障记为 `storage_io`，
 * 不伪装成"不存在"。
 */

export interface IsolatedPromptPreflightOptions {
  /** 数据目录：根 run 位于 `<dataDir>/traces/<id>.jsonl`，附件位于 `<dataDir>/workspace-blobs/` */
  readonly dataDir: string;
  /** 候选基线根 run id（必须就是根；中途分支只得到导航建议） */
  readonly rootId: string;
  /** 单项编辑：只允许 system_prompt / user_message；运行时仍做严格形状校验 */
  readonly edit: IsolatedPromptEdit;
  /**
   * 本次执行配置。只消费 `tools`（固定 profile）、`maxIterations`、`budget`、`baseURL`
   * （去凭据后的端点）；`model` / `systemPrompt` / `params` **刻意忽略**——
   * 模型与启动消息以根首次请求为准，桌面设置不得覆盖基线。
   */
  readonly config: RunConfig;
  /** 可选假设（≤4000 字符；随实验落盘，不参与计划指纹） */
  readonly hypothesis?: string;
  /** 可选人工判据（≤4000 字符；随实验落盘，不自动执行） */
  readonly acceptanceCriterion?: string;
}

/** 本次实验的**非密钥**执行条件（可进 IPC/详情；不含 key 或源物理路径） */
export interface IsolatedPromptExecutionPlan {
  readonly model: string;
  /** 根首次请求的无损标量参数；缺省与显式 `{}` 保持区别 */
  readonly params: Readonly<Record<string, string | number | boolean>> | undefined;
  /** 去除 userinfo/query/fragment 的端点 */
  readonly providerEndpoint: string;
  readonly maxIterations: number;
  /** 本次实际生效的 token 预算与可选成本上限 */
  readonly budget: {
    readonly maxTotalTokens: number;
    readonly maxCost?: number;
  };
  /** token 预算来源：根 meta 录制值 / 当前配置 */
  readonly tokenBudgetSource: "recorded" | "current";
  /** 历史上未录制的条件（不补造）：端点后端、迭代上限、token 预算（缺省时） */
  readonly historicalUnknowns: readonly ("provider_backend" | "max_iterations" | "token_budget")[];
}

export interface IsolatedPromptCapability {
  /** 已验证的根运行 id（也是 v3 baseline_run_id） */
  readonly rootId: string;
  /** 父根自有首次 llm.call（= fork.at_span） */
  readonly baselineLlmSpanId: string;
  /** 父根初始快照（新世界的唯一文件起点） */
  readonly initialSnapshot: WorkspaceSnapshot;
  readonly originalValue: string;
  readonly editedValue: string;
  /** 有效启动消息（编辑后；可直接作为 runLoop 初始输入） */
  readonly effectiveMessages: readonly Message[];
  readonly systemPrompt: string;
  readonly execution: IsolatedPromptExecutionPlan;
  /** 只由有效 system + 固定工具表计算 */
  readonly configHash: string;
  /** 计划指纹（覆盖消息/编辑/有效配置；不含 key） */
  readonly planFingerprint: string;
  /** 可直接落盘的 v3 实验记录（3.4 writer 消费） */
  readonly promptExperiment: PromptExperiment;
  /**
   * 真实计费边界：执行前 usage/单价/缓存都是未知，结果按实际记录呈现，**不得用 0 冒充**。
   * 与 `execution.historicalUnknowns`（历史条件未录制）分开表达。
   */
  readonly billing: {
    readonly usage: "unknown_until_execution";
    readonly price: "unknown";
    readonly cache: "unknown";
  };
  readonly fileCount: number;
  readonly totalBytes: number;
  /** 根记录（只读；3.4 复用，不重复读盘） */
  readonly records: readonly RunRecord[];
}

export type IsolatedPromptPreflightFailureCode =
  | "invalid_request"
  | "parent_not_root"
  | "parent_chain_invalid"
  | "parent_not_forkable"
  | "parent_not_isolated"
  | "startup_unavailable"
  | "profile_mismatch"
  | "source_changed"
  | "invalid_edit"
  | "empty_edit"
  | "config_unreconstructable"
  | "initial_snapshot_invalid"
  | "attachment_missing"
  | "attachment_corrupt"
  | "storage_io";

export interface IsolatedPromptPreflightFailure {
  readonly code: IsolatedPromptPreflightFailureCode;
  readonly reason: string;
  /**
   * **仅供导航**的根 id（仅 `parent_not_root` 且父链完整可验证时出现）。
   * 它不是已授权目标：用户必须显式打开根、核对初始输入与文件后重新预检。
   */
  readonly rootId?: string;
}

export type IsolatedPromptPreflightResult =
  | { readonly ok: true; readonly value: IsolatedPromptCapability }
  | { readonly ok: false; readonly failure: IsolatedPromptPreflightFailure };

function fail(
  code: IsolatedPromptPreflightFailureCode,
  reason: string,
  rootId?: string,
): { ok: false; failure: IsolatedPromptPreflightFailure } {
  return { ok: false, failure: rootId === undefined ? { code, reason } : { code, reason, rootId } };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

const MAX_RUN_ID_LENGTH = 200;

/** run id 只用于拼 `<traces>/<id>.jsonl`：挡路径穿越，不定字符集 */
function findRunIdViolation(id: string): string | null {
  if (id.length === 0) return "不能为空";
  if (id.length > MAX_RUN_ID_LENGTH) return `超过 ${MAX_RUN_ID_LENGTH} 字符`;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return "不能包含路径分隔符或 NUL";
  if (id.includes("..")) return "不能包含目录穿越片段";
  if (isAbsolute(id) || /^[a-zA-Z]:/.test(id)) return "必须是相对文件标识";
  return null;
}

type ChainLoadResult =
  | { readonly ok: true; readonly records: RunRecord[] }
  | {
      readonly ok: false;
      readonly code: "parent_chain_invalid" | "storage_io";
      readonly reason: string;
    };

/**
 * 读根→叶父链。缺失/结构非法/成环都是 `parent_chain_invalid`；真实 I/O 故障是 `storage_io`。
 * 不猜根：任何一跳失败都返回无 rootId 的失败。
 */
function loadRootChain(dataDir: string, startId: string): ChainLoadResult {
  const records: RunRecord[] = [];
  const seen = new Set<string>();
  let current: string | null = startId;
  while (current !== null) {
    const idViolation = findRunIdViolation(current);
    if (idViolation !== null) {
      return {
        ok: false,
        code: "parent_chain_invalid",
        reason: `父链中的 run 标识 ${JSON.stringify(current)} 非法：${idViolation}`,
      };
    }
    if (seen.has(current)) {
      return { ok: false, code: "parent_chain_invalid", reason: `parent 链成环：${current}` };
    }
    seen.add(current);

    let record: RunRecord;
    try {
      record = readRun(workspaceTraceFile(dataDir, current));
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return {
          ok: false,
          code: "parent_chain_invalid",
          reason: `父链 run ${current} 的 trace 文件不存在（不从当前目录或父最终状态补造）`,
        };
      }
      if (error instanceof TraceReadError) {
        return {
          ok: false,
          code: "parent_chain_invalid",
          reason: `父链 run ${current} 的记录非法：${error.message}`,
        };
      }
      return {
        ok: false,
        code: "storage_io",
        reason: `读取父链 run ${current} 失败（I/O 错误，不按不存在处理）：${messageOf(error)}`,
      };
    }
    records.unshift(record);
    current = record.meta.parent;
  }
  return { ok: true, records };
}

function validateNote(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return `${label}必须是字符串`;
  if (value.length > 4000) return `${label}超过 4000 字符（当前 ${value.length}）`;
  return null;
}

type ExecutionBuildResult =
  | { readonly ok: true; readonly value: IsolatedPromptExecutionPlan }
  | { readonly ok: false; readonly reason: string };

/**
 * 非密钥执行条件：模型来自根；端点来自当前配置；预算优先根 meta 录制值。
 *
 * 已知历史预算若大于当前策略上限，**明确拒绝**而不是静默截小后声称条件相同。
 */
function buildExecutionPlan(config: RunConfig, rootMeta: RunRecord["meta"]): ExecutionBuildResult {
  if (!Number.isInteger(config.maxIterations) || config.maxIterations <= 0) {
    return {
      ok: false,
      reason: `当前 maxIterations 必须是正整数（实际 ${String(config.maxIterations)}）`,
    };
  }
  if (typeof config.budget !== "object" || config.budget === null) {
    return { ok: false, reason: "当前执行配置缺少 budget 对象" };
  }
  const currentTokenBudget = config.budget.maxTotalTokens;
  if (
    currentTokenBudget !== undefined &&
    (!Number.isInteger(currentTokenBudget) || currentTokenBudget <= 0)
  ) {
    return {
      ok: false,
      reason: `当前 token 预算必须是正整数（实际 ${String(currentTokenBudget)}）`,
    };
  }
  const maxCost = config.budget.maxCost;
  if (
    maxCost !== undefined &&
    (typeof maxCost !== "number" || !Number.isFinite(maxCost) || maxCost <= 0)
  ) {
    return { ok: false, reason: `当前成本预算必须是正数（实际 ${String(maxCost)}）` };
  }

  const recordedTokenBudget = rootMeta.budget?.max_total_tokens;
  let maxTotalTokens: number;
  let tokenBudgetSource: "recorded" | "current";
  if (recordedTokenBudget !== undefined) {
    if (currentTokenBudget !== undefined && recordedTokenBudget > currentTokenBudget) {
      return {
        ok: false,
        reason: `根运行记录的 token 预算 ${recordedTokenBudget} 超过当前策略上限 ${currentTokenBudget}：不能静默截小后声称条件相同，请放宽当前策略或重新采集根运行`,
      };
    }
    maxTotalTokens = recordedTokenBudget;
    tokenBudgetSource = "recorded";
  } else if (currentTokenBudget !== undefined) {
    maxTotalTokens = currentTokenBudget;
    tokenBudgetSource = "current";
  } else {
    return {
      ok: false,
      reason: "根运行未记录 token 预算，当前配置也没有 maxTotalTokens：无法记录本次实际执行上限",
    };
  }

  const endpoint = sanitizeProviderEndpoint(config.baseURL);
  if (!endpoint.ok) {
    return { ok: false, reason: endpoint.reason };
  }

  const unknownList: Array<IsolatedPromptExecutionPlan["historicalUnknowns"][number]> = [
    "provider_backend",
    "max_iterations",
  ];
  if (recordedTokenBudget === undefined) {
    unknownList.push("token_budget");
  }
  const historicalUnknowns: IsolatedPromptExecutionPlan["historicalUnknowns"] = unknownList;

  return {
    ok: true,
    value: {
      model: "",
      params: undefined,
      providerEndpoint: endpoint.value,
      maxIterations: config.maxIterations,
      budget: {
        maxTotalTokens,
        ...(maxCost === undefined ? {} : { maxCost }),
      },
      tokenBudgetSource,
      historicalUnknowns,
    },
  };
}

/**
 * 只读预检隔离 prompt 能力。
 *
 * `ok: true` 表示：根已封存且来源完整、首次启动消息可无损还原、编辑条件与初始清单附件全部
 * 通过；返回的 `promptExperiment` 可直接作为 v3 记录（3.4 在提交时重验后再写）。
 */
export async function preflightIsolatedPromptReplay(
  options: IsolatedPromptPreflightOptions,
): Promise<IsolatedPromptPreflightResult> {
  const { dataDir, rootId, config } = options;

  // ── 1. 请求形状与安全 run ID（零 IO）──────────────────────────────────────────────────
  if (!isNonEmptyString(dataDir)) {
    return fail("invalid_request", `dataDir 必须是非空字符串，实际为 ${JSON.stringify(dataDir)}`);
  }
  if (!isNonEmptyString(rootId)) {
    return fail("invalid_request", `rootId 必须是非空字符串，实际为 ${JSON.stringify(rootId)}`);
  }
  const idViolation = findRunIdViolation(rootId);
  if (idViolation !== null) {
    return fail("invalid_request", `rootId ${JSON.stringify(rootId)} 非法：${idViolation}`);
  }
  if (typeof config !== "object" || config === null) {
    return fail("invalid_request", "config 必须是 RunConfig 对象");
  }
  const editShape = validateIsolatedPromptEdit(options.edit);
  if (!editShape.ok) {
    return fail(editShape.failure.code, editShape.failure.reason);
  }
  const hypothesisViolation = validateNote(options.hypothesis, "假设（hypothesis）");
  if (hypothesisViolation !== null) {
    return fail("invalid_request", hypothesisViolation);
  }
  const criterionViolation = validateNote(
    options.acceptanceCriterion,
    "人工判据（acceptanceCriterion）",
  );
  if (criterionViolation !== null) {
    return fail("invalid_request", criterionViolation);
  }

  // ── 2. 父链：环/缺失/结构/IO 可分辨；缺链不猜根 ──────────────────────────────────────
  const chain = loadRootChain(dataDir, rootId);
  if (!chain.ok) {
    return fail(chain.code, chain.reason);
  }
  const requested = chain.records[chain.records.length - 1];
  if (requested === undefined) {
    return fail("parent_chain_invalid", `根 run ${rootId} 加载失败`);
  }

  // ── 3. 必须已封存（缺终止事件的 crashed run 前缀不稳定）──────────────────────────────
  try {
    assertForkable(requested);
  } catch (error) {
    return fail("parent_not_forkable", messageOf(error));
  }

  // ── 4. 必须带隔离元数据（v1 父本没有初始快照，不能拿当前目录补）──────────────────────
  const workspace = requested.meta.workspace;
  if (workspace === undefined) {
    return fail(
      "parent_not_isolated",
      `run ${requested.meta.id} 不是隔离 run（没有 workspace 元数据，格式版本 ${requested.meta.format_version}）：没有可核验的初始文件快照；请先经隔离根入口采集一次`,
    );
  }
  if (workspace.profile !== FILE_TOOLS_V1_PROFILE) {
    return fail(
      "parent_not_isolated",
      `run ${requested.meta.id} 的 workspace.profile 为 ${JSON.stringify(workspace.profile)}，本版本只支持 ${FILE_TOOLS_V1_PROFILE}`,
    );
  }

  // ── 5. 必须是根：中途 result/v3 分支只给经完整父链验证的导航建议 ──────────────────────
  if (requested.meta.parent !== null || requested.meta.fork !== null) {
    const root = chain.records[0];
    if (
      root === undefined ||
      root.meta.parent !== null ||
      root.meta.workspace === undefined ||
      root.meta.workspace.origin.kind !== "import"
    ) {
      return fail(
        "parent_chain_invalid",
        `run ${requested.meta.id} 不是根，且父链首项不是可验证的隔离根（不猜根、不自动换基线）`,
      );
    }
    return fail(
      "parent_not_root",
      `run ${requested.meta.id} 是中途分支，不是隔离根：启动指令实验只能从根运行发起。请先显式打开根 ${root.meta.id}，核对初始输入与文件后重新预检——本建议不是执行授权，也不自动搬运编辑值或草稿`,
      root.meta.id,
    );
  }
  if (workspace.origin.kind !== "import") {
    return fail(
      "parent_not_isolated",
      `根 run ${requested.meta.id} 的 workspace.origin 必须是 import（实际 ${workspace.origin.kind}）`,
    );
  }

  // ── 6. 启动消息/单项编辑/params（纯派生）────────────────────────────────────────────
  const derived = deriveIsolatedPromptState({ record: requested, edit: editShape.value });
  if (!derived.ok) {
    return fail(derived.failure.code, derived.failure.reason);
  }
  const state = derived.value;

  // ── 7. 固定 profile（本次配置 + 父根录制工具表分别核对）──────────────────────────────
  const configProfile = checkToolProfile(config.tools, FILE_TOOLS_V1_PROFILE);
  if (!configProfile.ok) {
    return fail("profile_mismatch", configProfile.failure.reason);
  }
  const baselineLlm = requested.spans.find((span) => span.kind === "llm.call");
  if (baselineLlm === undefined || baselineLlm.kind !== "llm.call") {
    return fail("startup_unavailable", `根 run ${requested.meta.id} 没有自有 llm.call 录制`);
  }
  if (baselineLlm.request.tools === undefined) {
    return fail(
      "source_changed",
      `根 run ${requested.meta.id} 的首次请求未录制工具表，无法确认固定 profile 与 config_hash 的来源`,
    );
  }
  let recordedDefs: ToolDef[];
  try {
    recordedDefs = toToolDefs(baselineLlm.request.tools);
  } catch (error) {
    return fail(
      "profile_mismatch",
      `根 run ${requested.meta.id} 录制的工具表无法解包为固定 profile：${messageOf(error)}`,
    );
  }
  const recordedProfile = checkToolProfile(recordedDefs, FILE_TOOLS_V1_PROFILE);
  if (!recordedProfile.ok) {
    return fail(
      "profile_mismatch",
      `根 run ${requested.meta.id} 录制的工具表与 ${FILE_TOOLS_V1_PROFILE} 不一致：${recordedProfile.failure.reason}`,
    );
  }

  // ── 8. 原 system + 固定工具表的 config_hash 必须与根 meta 一致 ────────────────────────
  if (requested.meta.config_hash === undefined) {
    return fail(
      "config_unreconstructable",
      `根 run ${requested.meta.id} 没有 config_hash，无法确认原 system/工具表来源`,
    );
  }
  const originalHash = configHash(state.originalSystemPrompt, [
    ...FILE_TOOLS_V1_DEFINITIONS,
  ] as ToolDef[]);
  if (originalHash !== requested.meta.config_hash) {
    return fail(
      "source_changed",
      `根 run ${requested.meta.id} 的 config_hash 与首次请求的 system/固定工具表不一致（记录 ${requested.meta.config_hash}，复算 ${originalHash}）：来源已被改动，不能作为基线`,
    );
  }

  // ── 9. 当前配置/预算/端点：历史预算不可被静默截小 ─────────────────────────────────────
  const execution = buildExecutionPlan(config, requested.meta);
  if (!execution.ok) {
    return fail("config_unreconstructable", execution.reason);
  }
  const effectiveExecution: IsolatedPromptExecutionPlan = {
    ...execution.value,
    model: state.model,
    params: state.params,
  };

  // ── 10. 计划指纹：基线/首次请求/初始快照/编辑/有效消息/非密钥配置与工具定义 ────────────
  const planFingerprint = computePlanFingerprint({
    baseline_run_id: requested.meta.id,
    baseline_llm_span_id: state.baselineLlmSpanId,
    initial_snapshot_id: state.initialSnapshot.id,
    original_value: state.originalValue,
    edit: { field: editShape.value.field, value: editShape.value.value },
    messages: state.messages,
    execution: {
      model: effectiveExecution.model,
      ...(effectiveExecution.params === undefined ? {} : { params: effectiveExecution.params }),
      provider_endpoint: effectiveExecution.providerEndpoint,
      max_iterations: effectiveExecution.maxIterations,
      budget: effectiveExecution.budget,
      tool_profile: FILE_TOOLS_V1_PROFILE,
      tool_definitions: FILE_TOOLS_V1_DEFINITIONS,
      config_hash: state.configHash,
    },
  });

  const promptExperiment: PromptExperiment = {
    baseline_run_id: requested.meta.id,
    baseline_llm_span_id: state.baselineLlmSpanId,
    initial_snapshot_id: state.initialSnapshot.id,
    original_value: state.originalValue,
    execution: {
      model: effectiveExecution.model,
      ...(effectiveExecution.params === undefined ? {} : { params: effectiveExecution.params }),
      provider_endpoint: effectiveExecution.providerEndpoint,
      max_iterations: effectiveExecution.maxIterations,
      budget: effectiveExecution.budget.maxTotalTokens,
      config_fingerprint: planFingerprint,
    },
    ...(options.hypothesis === undefined ? {} : { hypothesis: options.hypothesis }),
    ...(options.acceptanceCriterion === undefined
      ? {}
      : { acceptance_criterion: options.acceptanceCriterion }),
  };

  // ── 11. 初始清单配额（先于附件读取：超限不需要读任何字节）────────────────────────────
  const quotaViolation = findFileSetQuotaViolation(state.initialSnapshot.files);
  if (quotaViolation !== null) {
    return fail(
      "initial_snapshot_invalid",
      `根 run ${requested.meta.id} 的初始清单超过固定配额：${quotaViolation}`,
    );
  }

  // ── 12. 全部附件逐字节核验（最贵的一步；缺失/损坏/IO 分别可辨认）──────────────────────
  const store = createWorkspaceBlobStore(dataDir);
  let totalBytes = 0;
  for (const file of state.initialSnapshot.files) {
    let verified: Awaited<ReturnType<typeof store.verify>>;
    try {
      verified = await store.verify({ sha256: file.sha256, bytes: file.bytes });
    } catch (error) {
      const ioDetail = error instanceof WorkspaceBlobError ? error.message : messageOf(error);
      return fail(
        "storage_io",
        `核验初始附件 ${file.path} 时发生 I/O 故障（不按缺失处理）：${ioDetail}`,
      );
    }
    if (verified.state !== "ok") {
      return fail(
        verified.state === "missing" ? "attachment_missing" : "attachment_corrupt",
        `初始列表中的 ${file.path} 附件不可用（${verified.reason}）——不能从当前源目录重新读取补齐，请重新采集隔离根`,
      );
    }
    totalBytes += file.bytes;
  }

  return {
    ok: true,
    value: {
      rootId: requested.meta.id,
      baselineLlmSpanId: state.baselineLlmSpanId,
      initialSnapshot: state.initialSnapshot,
      originalValue: state.originalValue,
      editedValue: editShape.value.value,
      effectiveMessages: state.messages,
      systemPrompt: state.systemPrompt,
      execution: effectiveExecution,
      configHash: state.configHash,
      planFingerprint,
      promptExperiment,
      billing: { usage: "unknown_until_execution", price: "unknown", cache: "unknown" },
      fileCount: state.initialSnapshot.files.length,
      totalBytes,
      records: [requested],
    },
  };
}
