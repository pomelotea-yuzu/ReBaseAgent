import { join } from "node:path";
import { OpenAiCompatClient, configHash, parseRunConfig, runLoop } from "@rebaseagent/agent-loop";
import type { ForkRunMeta, LlmClient, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import type { Fork, RunLoader } from "@rebaseagent/trace-sdk";
import { loadForkParent } from "./fork-parent.js";
import { derivePromptForkState } from "./prompt-fork.js";
import type { DerivedPromptForkState, ModelParamsEdit, ModelParamsValue } from "./prompt-fork.js";
import { newForkRunId } from "./replay-run.js";

/**
 * 模型 A/B 多臂实验编排（V3b，2.1-2.5）。
 *
 * 与 V3a 卡带测试的语义相反：这里每一臂都是**真实模型调用**，会产生费用、
 * 结果不可复现。因此编排层把门禁做在"创建第一个 tracer / 发起第一个请求"之前：
 * 任何一臂不合法 = 整批拒绝、零文件、零调用。
 *
 * 与 promptReplayRun 的关系：复用同一条父链门禁、同一套 derive、同一种
 * "先校验后覆写"双真相源守护；差别只在一次调用跑多个 arm，并把 experimentId
 * 写进 fork.edit 供 UI 分组。
 */

/** 入口默认值：与桌面 fork runner 保持一致（只是缺省，调用方可覆盖） */
export const DEFAULT_MAX_ITERATIONS = 10;
export const DEFAULT_MAX_TOTAL_TOKENS = 100_000;

/** 前置拒绝的错误码（桌面据此给针对性提示，CLI 一律退出码 2） */
export type ModelAbErrorCode =
  | "TOO_FEW_ARMS"
  | "TOOLS_MISMATCH"
  | "PARENT_NOT_FORKABLE"
  | "INVALID_ARM"
  | "EMPTY_EDIT"
  | "DUAL_SOURCE"
  | "CONFIG_MISMATCH"
  | "TOOL_POLICY"
  | "EXPERIMENT_CONFLICT"
  | "COST_NOT_CONFIRMED"
  | "MISSING_KEY";

/** 模型实验的前置拒绝：携带稳定错误码，避免调用方靠错误文本做判断 */
export class ModelAbError extends Error {
  constructor(
    readonly code: ModelAbErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelAbError";
  }
}

/**
 * 工具策略：
 * - require_pure（默认，桌面）：每个工具都必须显式 sideEffect === false
 * - require_empty（CLI 首期）：父 run 不得带工具——replay 包不提供 handler，
 *   桌面内置 handler 不跨进程复用，卡带测试的 StubToolTable 更是不能冒充真实结果
 */
export type ToolPolicy = "require_pure" | "require_empty";

/** 单个实验臂的输入（与 model_params edit value 一一对应） */
export interface ModelArmSpec {
  model: string;
  params?: Record<string, number>;
  /** 显式确认允许带副作用的工具；全批一致为 true 时放行（逃生舱） */
  allowSideEffects?: boolean;
  /** 该臂声明的 experimentId；同批必须相同，缺省由编排层生成 */
  experimentId?: string;
}

export interface ModelReplayRunManyOptions {
  /** 直接父 run id（已封存、含 config_hash、首次 llm.call 含字符串 system 消息；proxy 与引擎 run 同判据） */
  parentId: string;
  /** 至少两个 arm */
  arms: ModelArmSpec[];
  /** 完整运行配置（systemPrompt 必须等于父 run 首次请求录制的 system 内容） */
  config: RunConfig;
  /** 含 handler 的工具（与 config.tools 1:1） */
  tools: Tool[];
  load: RunLoader;
  outDir: string;
  /** 批次分组标签；不传则自动生成（2.5） */
  experimentId?: string;
  /** 只校验与展示计划：不需要 apiKey、不联网、不写文件（2.4） */
  dryRun?: boolean;
  /** 真实执行必须显式确认费用（CLI --confirm-cost / 桌面确认弹窗） */
  confirmCost?: boolean;
  toolPolicy?: ToolPolicy;
  /** 父级取消信号：级联到每一臂的独立 AbortController（2.4） */
  signal?: AbortSignal | null;
  /** LLM 客户端（测试注入；可给工厂以便每臂不同剧本）；缺省真调 config.baseURL */
  llm?: LlmClient | ((arm: { index: number; config: RunConfig }) => LlmClient);
}

export interface ModelArmPlan {
  index: number;
  model: string;
  params: Record<string, number>;
  /** 相对父 run 实际改变的项（model / params.<key>） */
  changed: string[];
  allowSideEffects: boolean;
}

export interface ModelArmResult {
  index: number;
  model: string;
  params: Record<string, number>;
  /** 成功落盘的 fork run id；dry-run、未开始或被拒绝为 null */
  id: string | null;
  /** 该臂的失败原因；成功为 null */
  error: string | null;
}

export interface ModelReplayRunManyResult {
  experimentId: string;
  parentId: string;
  /** 全部 arm 成功 */
  ok: boolean;
  plan: ModelArmPlan[];
  arms: ModelArmResult[];
  /** 逃生舱是否放行（含副作用工具被真实执行） */
  sideEffectsAllowed: boolean;
}

/** 把外部中止级联到本臂的 controller；返回解绑函数 */
function linkAbort(parent: AbortSignal | null, controller: AbortController): () => void {
  if (parent === null) return () => {};
  const onAbort = () => controller.abort();
  if (parent.aborted) {
    controller.abort();
    return () => {};
  }
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

/** 同批 experimentId 解析：全批一致才放行，缺省生成（2.5） */
function resolveExperimentId(
  explicit: string | undefined,
  declared: Array<string | undefined>,
): string {
  const values = new Set(declared.filter((v): v is string => typeof v === "string"));
  if (values.size > 1) {
    throw new ModelAbError(
      "EXPERIMENT_CONFLICT",
      `experimentId 冲突：同一批实验出现 ${values.size} 个不同分组标签（${[...values].join("、")}），一次调用即一批，必须相同`,
    );
  }
  const one = [...values][0];
  if (explicit !== undefined && one !== undefined && explicit !== one) {
    throw new ModelAbError(
      "EXPERIMENT_CONFLICT",
      `experimentId 冲突：调用方指定 ${explicit}，但 arm 自带 ${one}；一次调用即一批，二者必须相同`,
    );
  }
  return (
    explicit ?? one ?? `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  );
}

/**
 * 从父 run 录制的工具表读取每个工具的 sideEffect 标记（含"字段缺失"这一状态）。
 * 录制存在两种合法形状：引擎直录的扁平 ToolDef，与 OpenAI 的 function 包装。
 */
function recordedToolFlags(
  recorded: readonly Record<string, unknown>[] | undefined,
): Array<{ name: string; sideEffect: boolean | undefined }> {
  if (recorded === undefined) return [];
  return recorded.map((raw) => {
    const wrapped = raw.function;
    const inner =
      typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)
        ? (wrapped as Record<string, unknown>)
        : raw;
    return {
      name: typeof inner.name === "string" ? inner.name : "<未命名工具>",
      sideEffect: typeof inner.sideEffect === "boolean" ? inner.sideEffect : undefined,
    };
  });
}

/**
 * 工具门禁（2.3）：判据是**父 run 录制的工具表**，不是调用方传了什么——
 * 传空 tools 并不能让带工具的父 run 变得可跑。
 * 默认整批拒绝；只有全批显式 allowSideEffects 才放行（逃生舱，且留痕）。
 */
function assertToolPolicy(
  recorded: readonly Record<string, unknown>[] | undefined,
  arms: readonly ModelArmSpec[],
  policy: ToolPolicy,
): boolean {
  const flags = recordedToolFlags(recorded);

  if (policy === "require_empty") {
    if (flags.length > 0) {
      throw new ModelAbError(
        "TOOL_POLICY",
        `父 run 带 ${flags.length} 个工具（${flags.map((f) => f.name).join("、")}），命令行首期只支持空工具表（纯对话任务）：replay 包不提供工具 handler，桌面内置 handler 不跨进程复用，卡带测试的桩工具更不能冒充真实结果。请改用桌面端执行该实验`,
      );
    }
    return false;
  }

  const risky = flags.filter((f) => f.sideEffect !== false).map((f) => f.name);
  if (risky.length === 0) return false;

  const allAllowed = arms.length > 0 && arms.every((arm) => arm.allowSideEffects === true);
  if (!allAllowed) {
    throw new ModelAbError(
      "TOOL_POLICY",
      `工具 ${risky.join("、")} 未标记 sideEffect: false（缺失标记按有副作用处理），模型实验首期只支持无副作用工具表。这是诚实的可用性边界：真实 trace 里的 write_file 往往连标记都没有，因此首期默认只有全程未使用写工具的 run 能做 A/B。多臂顺序执行时，前一臂的外部副作用会污染后一臂的起点，比较结果将不可信。若确认接受（外部状态可能已被前一臂改变），请为每个 arm 显式声明 allowSideEffects: true`,
    );
  }
  return true;
}

/** 相对父 run 的实际改变项（供确认面板与计划展示） */
function describeChanges(
  parentModel: string,
  parentParams: Record<string, number>,
  model: string,
  params: Record<string, number>,
): string[] {
  const changed: string[] = [];
  if (model !== parentModel) changed.push("model");
  const keys = new Set([...Object.keys(parentParams), ...Object.keys(params)]);
  for (const key of [...keys].sort()) {
    if (parentParams[key] !== params[key]) {
      changed.push(`params.${key}`);
    }
  }
  return changed;
}

/**
 * 模型 A/B 实验：一次调用 = 一批实验，顺序执行至少两个 arm。
 *
 * 全流程门禁（任一失败 = 零文件、零调用）：
 * arm 数量 ≥ 2 → 工具表一致 → 父链/封存/config_hash/system 消息 →
 * 每臂 edit 校验（zod + 空编辑）→ 双真相源先校验后覆写 → 工具策略 →
 * experimentId 一致 →（真实执行）费用确认 + apiKey。
 */
export async function modelReplayRunMany(
  options: ModelReplayRunManyOptions,
): Promise<ModelReplayRunManyResult> {
  const {
    parentId,
    arms,
    config,
    tools,
    load,
    outDir,
    experimentId: explicitId,
    dryRun = false,
    confirmCost = false,
    toolPolicy = "require_pure",
    signal = null,
    llm,
  } = options;

  // 1. 一批至少两臂：单臂不是 A/B，直接用 promptReplayRun
  if (arms.length < 2) {
    throw new ModelAbError(
      "TOO_FEW_ARMS",
      `模型实验至少需要 2 个 arm（当前 ${arms.length} 个）；单臂请用 prompt fork`,
    );
  }
  // 2. 工具表一致（runLoop 的不变量，提前暴露避免半文件）
  if (config.tools.length !== tools.length) {
    throw new ModelAbError(
      "TOOLS_MISMATCH",
      "config.tools 与 tools（含 handler）数量不一致，无法重跑",
    );
  }

  // 3. 父链门禁（与 prompt fork 共用；失败零文件、零调用）
  const parent = loadParentOrThrow(parentId, load);
  const parentModel = parent.llmSpan.request.model;
  const parentParams = numericParentParams(parent.llmSpan.request.params);

  // 4. 每臂：值校验 + 空编辑拒绝 + 启动上下文派生（纯函数，零副作用）
  const prepared = arms.map((arm, index) => {
    const value: ModelParamsValue = {
      model: arm.model,
      ...(arm.params !== undefined ? { params: arm.params } : {}),
      ...(arm.experimentId !== undefined ? { experimentId: arm.experimentId } : {}),
      ...(arm.allowSideEffects !== undefined ? { allowSideEffects: arm.allowSideEffects } : {}),
    };
    const edit: ModelParamsEdit = { field: "model_params", value };
    // derive 抛的是领域错误（zod 校验、空 fork、缺 system 消息）：统一收成 INVALID_ARM
    let state: DerivedPromptForkState;
    try {
      state = derivePromptForkState({ record: parent.record, edit });
    } catch (e) {
      throw new ModelAbError(
        "INVALID_ARM",
        `第 ${index + 1} 个 arm 不合法：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return { index, arm, edit, state };
  });

  // 5. 双真相源：先校验后覆写（与 promptReplayRun 同一判据——父 run 首次请求的 system 原值）
  if (config.systemPrompt !== parent.system.content) {
    throw new ModelAbError(
      "DUAL_SOURCE",
      `双真相源不一致：RunConfig.systemPrompt 与父 run ${parentId} 首次 llm.call 录制的 system 消息不同。系统提示词必须与录制事实一致才能 fork（config_hash 不可逆，不反推、不猜、不覆写掩盖）`,
    );
  }

  // 6. 工具策略在前置阶段裁决整批：不允许"前几臂跑完才发现最后一臂带副作用"
  const sideEffectsAllowed = assertToolPolicy(parent.llmSpan.request.tools, arms, toolPolicy);

  // 6.5 同源校验：只换 model/params，system prompt 与工具表必须与父逐字段一致
  //     （configHash 计入 sideEffect 字段的有无——"补齐缺失标记"会改变指纹并被拒绝，
  //      这同时堵死了给 write_file 补标记绕过副作用门禁的路径）
  const hash = configHash(config.systemPrompt, config.tools);
  if (hash !== parent.record.meta.config_hash) {
    throw new ModelAbError(
      "CONFIG_MISMATCH",
      `config_hash 不一致：本次 ${hash} ≠ 父 run ${parentId} 的 ${String(parent.record.meta.config_hash)}。模型实验只换 model 与采样参数，system prompt 与工具表必须与父 run 逐字段一致（含 sideEffect 字段的有无）`,
    );
  }

  // 7. 同批 experimentId（2.5）
  const experimentId = resolveExperimentId(
    explicitId,
    prepared.map((p) => p.arm.experimentId),
  );

  const plan: ModelArmPlan[] = prepared.map((p) => ({
    index: p.index,
    model: p.arm.model,
    params: p.state.modelOverride?.params ?? {},
    changed: describeChanges(
      parentModel,
      parentParams,
      p.arm.model,
      p.state.modelOverride?.params ?? {},
    ),
    allowSideEffects: p.arm.allowSideEffects === true,
  }));

  // 8. dry-run：只展示校验后的计划，不需要 apiKey、不联网、不写文件（2.4）
  if (dryRun) {
    return {
      experimentId,
      parentId,
      ok: true,
      plan,
      arms: [],
      sideEffectsAllowed,
    };
  }

  // 9. 真实执行门禁：显式费用确认 + 可用 apiKey（key 不进任何错误文本）
  if (!confirmCost) {
    throw new ModelAbError(
      "COST_NOT_CONFIRMED",
      "未确认费用：模型实验会按 arm 数真实调用 provider 并产生费用。" +
        "命令行请加 --confirm-cost，桌面端请在确认弹窗中确认",
    );
  }
  if (config.apiKey.length === 0) {
    throw new ModelAbError(
      "MISSING_KEY",
      "缺少 apiKey：真实执行需要可用密钥（命令行设置 REBASEAGENT_API_KEY，桌面端在“运行配置”中填写）",
    );
  }

  // 10. 顺序执行（默认）：保证纯工具实验的确定性；单臂失败只记该臂（2.1）
  const results: ModelArmResult[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    if (p === undefined) continue;
    const { model, params } = p.state.modelOverride ?? { model: p.arm.model, params: undefined };

    // 取消：已中止时后续 arm 不创建 run（2.4），已完成 arm 不受影响
    if (signal?.aborted === true) {
      results.push({
        index: p.index,
        model: p.arm.model,
        params: params ?? {},
        id: null,
        error: "实验已被取消，该臂未开始",
      });
      continue;
    }

    const controller = new AbortController();
    const unlink = linkAbort(signal ?? null, controller);
    const armConfig = parseRunConfig({
      ...config,
      model,
      params,
      systemPrompt: p.state.systemPrompt,
      exec: { ...config.exec, signal: controller.signal },
    });

    // experimentId / allowSideEffects 原样落进 fork.edit：前者供 UI 分组，后者供事后审计
    const fork: Fork = {
      at_span: p.state.fork.at_span,
      edit: {
        field: "model_params",
        value: { ...p.edit.value, experimentId },
      },
    };

    const id = newForkRunId();
    try {
      const tracer = new JsonlTracer(join(outDir, `${id}.jsonl`));
      const forkRun: ForkRunMeta = { id, parent: parentId, fork };
      // provider 错误不会抛出——runLoop 把 error outcome 记进 trace 并正常返回（错误即数据）。
      // 因此"这一臂失败"要看终止事件，而不是等异常；否则失败臂会被当成成功。
      // 同时包一层 client 把 LLM 的原始错误留下来：runLoop 只把它打到控制台，不外传。
      let llmError: string | null = null;
      const delegate =
        typeof llm === "function"
          ? llm({ index: p.index, config: armConfig })
          : (llm ?? new OpenAiCompatClient(armConfig));
      const client: LlmClient = {
        complete: async (messages, signal) => {
          try {
            return await delegate.complete(messages, signal);
          } catch (e) {
            llmError = e instanceof Error ? e.message : String(e);
            throw e;
          }
        },
      };
      const outcome = await runLoop(armConfig, p.state.messages, tracer, tools, client, forkRun);
      const failure =
        llmError ??
        (outcome.event.event === "errored"
          ? `该臂在第 ${outcome.event.at} 步以 error 终止（${outcome.event.reason}）`
          : outcome.event.event === "aborted"
            ? `该臂被中止（${outcome.event.reason}）`
            : null);
      results.push({
        index: p.index,
        model: p.arm.model,
        params: params ?? {},
        id,
        error: failure,
      });
    } catch (e) {
      results.push({
        index: p.index,
        model: p.arm.model,
        params: params ?? {},
        id: null,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      unlink();
    }
  }

  return {
    experimentId,
    parentId,
    ok: results.every((r) => r.error === null),
    plan,
    arms: results,
    sideEffectsAllowed,
  };
}

/** 父链门禁：把父本校验的领域错误统一收成 PARENT_NOT_FORKABLE（失败零文件、零调用） */
function loadParentOrThrow(parentId: string, load: RunLoader): ReturnType<typeof loadForkParent> {
  try {
    return loadForkParent(parentId, load);
  } catch (e) {
    throw new ModelAbError("PARENT_NOT_FORKABLE", e instanceof Error ? e.message : String(e));
  }
}

function numericParentParams(raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
}
