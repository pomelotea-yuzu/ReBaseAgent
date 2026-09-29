import type { LlmClient } from "@rebaseagent/agent-loop";
import { ModelAbError } from "@rebaseagent/replay";
import type { ChannelName } from "../shared/channels";
import { CHANNELS } from "../shared/channels";
import {
  CreateRunRequestSchema,
  ForkRunRequestSchema,
  ModelAbRequestSchema,
  PromptForkRequestSchema,
  ProxyForkRequestSchema,
} from "../shared/ipc";
import type {
  CreateRunRequest,
  CreateRunResult,
  ForkRunRequest,
  ForkRunResult,
  ModelAbRequest,
  ModelAbResult,
  PromptForkRequest,
  PromptForkResult,
  ProxyForkRequest,
  ProxyForkResult,
} from "../shared/ipc";
import type { ExecutedResponse, OperationAck, OperationTarget } from "../shared/operations";
import { OPERATION_ERROR } from "../shared/operations";
import {
  ExecutionEnvelopeSchema,
  type OperationRecord,
  type RegistryVersion,
} from "../shared/operations";
import {
  ForkError,
  type ModelAbRunResult,
  runFork,
  runForkIsolated,
  runModelAb,
  runPromptFork,
} from "./fork-runner";
import type { TrustedSender } from "./operation-endpoints";
import type { OperationContext, OperationRunResult } from "./operation-registry";
import { type RequestFingerprinter, parseBusinessRequest } from "./operation-request";
import type { ProxyManager } from "./proxy-manager";
import { ProxyForkError } from "./proxy-manager";
import { CreateRunError, runCreate, runCreateIsolated } from "./run-create";
import type { RunRepository } from "./run-repository";
import { RunSourceRejection, checkRunSource } from "./run-source-gate";
import type { SettingsStore } from "./settings";
import type { SourceTokenStore } from "./source-token";

/**
 * 七个主动执行入口的 **main 侧端点体**（U4 design D2/D3，tasks 3.1–3.4）。
 *
 * 与 `operation-endpoints.ts` / `config-endpoints.ts` 同一分层理由：不 import electron，
 * sender 以普通数据注入，因此「七类主动入口均绑定身份」「同 ID 重复只执行一次」
 * 「跨入口忙碌只有一个被接受」这些判据能在 vitest 下逐条直测；`ipc.ts` 只做
 * `ipcMain.handle(通道, (event, payload) => 端点(deps, senderOf(event), payload))` 的薄适配。
 *
 * 每条请求的固定顺序（任何副作用之前）：
 * 1. sender 必须是本应用窗口的主 frame；
 * 2. 外层信封只含 `{operation:{epoch,operationId}, request}`（多一个键即非法）；
 * 3. epoch 必须等于当前 main 会话 ⇒ 旧 epoch 零副作用；
 * 4. 业务 schema **只 parse 一次** ⇒ 一份不可变快照 + 一个会话 HMAC 指纹；
 * 5. `registry.submitExecution`：同步判重 + 判锁 + 占槽，然后才读 settings、
 *    消费 sourceToken、导入源目录、调模型/工具；
 * 6. 响应两个分支都带登记回执（身份 + 登记版本 + 状态）。
 *
 * 业务拒绝沿用各通道既有稳定码（`SETTINGS_NOT_CONFIGURED` / `FORK_*` / `MODEL_AB_*` /
 * `PROXY_*`…），登记为 `settled/rejected`；未预期异常登记为 `settled/failed`。
 * 真实运行身份通过 §2 的观察回调登记，**不解析异常文案**。
 */

export interface ExecEndpointDeps {
  registry: import("./operation-registry").OperationRegistry;
  fingerprinter: RequestFingerprinter;
  isTrustedSender: (sender: TrustedSender) => boolean;
  repository: RunRepository;
  /** 结构依赖：装配层传 `SettingsStore`，测试可计数/切换"未配置" */
  settings: Pick<SettingsStore, "load">;
  /** 工具执行的工作目录（与既有 fork/create 通道同口径） */
  execCwd: string;
  /** 数据目录：隔离创建/续跑的 trace 与附件锚点 */
  dataDir: string;
  /** 结构依赖：只有主动重发用得到 `fork` */
  proxy: Pick<ProxyManager, "fork">;
  /** 目录选择令牌：只在**已被接受**的操作里消费（判重先于许可消费） */
  sourceTokens: Pick<SourceTokenStore, "consume">;
  /**
   * LLM 客户端（与各编排函数的 `llm` 选项同口径：缺省真实调用 settings.baseURL，
   * 测试注入 mock ⇒ 零真实 API，且"同 ID 重复请求只执行一次"能数到真实模型调用次数）。
   */
  llm?: LlmClient;
}

/** 一条主动入口的规格：通道、业务 schema、受限目标摘要、真实编排 */
interface ActiveChannel<TRequest, TResult> {
  readonly channel: ChannelName;
  readonly schema: import("zod").ZodType<TRequest>;
  readonly targetOf: (business: TRequest) => OperationTarget;
  readonly run: (
    deps: ExecEndpointDeps,
    business: TRequest,
    ctx: OperationContext,
  ) => Promise<TResult>;
}

function ackOf(record: OperationRecord, registryVersion: RegistryVersion): OperationAck {
  return {
    epoch: record.epoch,
    operationId: record.operationId,
    registryVersion,
    state: record.state,
  };
}

/** 未接受/冲突/重复三类结论的稳定码与文案（操作事实本身经回执给出） */
function errorOfNonAccepted(
  acceptance: "duplicate" | "banned" | "conflict" | "not-accepted",
  record: OperationRecord,
): { code: string; message: string } {
  switch (acceptance) {
    case "conflict":
      return {
        code: OPERATION_ERROR.conflict,
        message: "该 operationId 已用于另一份业务请求，本次未执行",
      };
    case "duplicate":
      return {
        code: OPERATION_ERROR.duplicated,
        message: `该 operationId 已提交过（当前 ${record.state}），本次未重复执行`,
      };
    default:
      return {
        code: OPERATION_ERROR.notAccepted,
        message: `操作未被接受（${record.rejection ?? "unknown"}），本次未执行；请重新提交`,
      };
  }
}

/** 领域错误 → 既有稳定码；未预期异常 → OPERATION_EXECUTION_FAILED */
function toRunResult(error: unknown): OperationRunResult {
  const message = error instanceof Error ? error.message : String(error);
  // U6 §5.1：来源门禁拒绝（父本 ownOnly / 详情不可读）——在授权消费与业务副作用之前
  if (error instanceof RunSourceRejection) {
    return { outcome: "rejected", code: error.code, message };
  }
  if (error instanceof CreateRunError) {
    return { outcome: "rejected", code: error.code, message };
  }
  if (error instanceof ForkError) {
    return { outcome: "rejected", code: error.code, message };
  }
  if (error instanceof ProxyForkError) {
    return { outcome: "rejected", code: error.code, message };
  }
  if (error instanceof ModelAbError) {
    return { outcome: "rejected", code: `MODEL_AB_${error.code}`, message };
  }
  return { outcome: "failed", code: "OPERATION_EXECUTION_FAILED", message };
}

/**
 * 端点体的公共段。返回 `null` 表示"接受之前的拒绝"已直接产出响应——
 * 那一类响应**没有** operation 回执（main 里根本没有这条登记）。
 */
async function submitActive<TRequest, TResult>(
  deps: ExecEndpointDeps,
  sender: TrustedSender,
  spec: ActiveChannel<TRequest, TResult>,
  payload: unknown,
): Promise<ExecutedResponse<TResult>> {
  if (!deps.isTrustedSender(sender)) {
    return {
      ok: false,
      operation: null,
      error: {
        code: OPERATION_ERROR.untrustedSender,
        message: "主动执行通道只接受本应用窗口主 frame 的调用",
      },
    };
  }
  const envelope = ExecutionEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    return {
      ok: false,
      operation: null,
      error: {
        code: OPERATION_ERROR.invalidIdentity,
        message: "主动执行请求必须携带 {operation:{epoch,operationId}, request}",
      },
    };
  }
  const identity = envelope.data.operation;
  const registry = deps.registry;
  if (identity.epoch !== registry.epoch) {
    return {
      ok: false,
      operation: null,
      error: {
        code: OPERATION_ERROR.staleEpoch,
        message: "旧 main 会话的请求不会被执行，也不会影响当前登记",
      },
    };
  }
  const parsed = parseBusinessRequest(
    deps.fingerprinter,
    spec.channel,
    spec.schema,
    envelope.data.request,
  );
  if (!parsed.ok) {
    return { ok: false, operation: null, error: { code: parsed.code, message: parsed.message } };
  }
  // 业务值只在这一次解析里确定：指纹与实际编排入参同源（design D2）
  const business = parsed.request.value;
  const report = await registry.submitExecution({
    operationId: identity.operationId,
    target: spec.targetOf(business),
    fingerprint: parsed.request.fingerprint,
    async execute(ctx) {
      try {
        return { outcome: "returned", data: await spec.run(deps, business, ctx) };
      } catch (error) {
        return toRunResult(error);
      }
    },
  });
  const operation = ackOf(report.record, report.registryVersion);
  if (report.acceptance === "accepted" && report.error === null) {
    return { ok: true, operation, data: report.data as TResult };
  }
  return {
    ok: false,
    operation,
    error:
      report.error ??
      errorOfNonAccepted(
        report.acceptance === "accepted" ? "duplicate" : report.acceptance,
        report.record,
      ),
  };
}

// ---------------------------------------------------------------------------
// 1) runs:create —— 普通与隔离创建共用一个通道（mode 进目标摘要与指纹）
// ---------------------------------------------------------------------------

const createChannel: ActiveChannel<CreateRunRequest, CreateRunResult> = {
  channel: CHANNELS.createRun,
  schema: CreateRunRequestSchema,
  targetOf: (business) => ({
    kind: "create",
    mode: business.workspace === undefined ? "plain" : "isolated",
  }),
  async run(deps, business, ctx) {
    const loaded = deps.settings.load();
    if (loaded === null) {
      throw new CreateRunError(
        "SETTINGS_NOT_CONFIGURED",
        "尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置",
      );
    }
    const workspace = business.workspace;
    // 隔离分支：sourceToken 只在**已被接受**的操作里消费（一次性，失败也算已消费）
    if (workspace !== undefined) {
      const consumed = deps.sourceTokens.consume(workspace.sourceToken);
      if (!consumed.ok) {
        throw new CreateRunError(
          "INVALID_SOURCE_TOKEN",
          consumed.reason === "expired"
            ? "所选目录的确认已过期（超过 15 分钟），请重新选择目录并确认副本写入"
            : "目录选择凭证无效（不存在、已被使用或来自其他会话），请重新选择目录",
        );
      }
      const created = await runCreateIsolated(
        {
          repository: deps.repository,
          settings: loaded,
          execCwd: deps.dataDir,
          dataDir: deps.dataDir,
          sourcePath: consumed.path,
          llm: deps.llm,
          onRunIdentified: (id) => ctx.attachRunId(id),
        },
        {
          systemPrompt: business.systemPrompt,
          userMessage: business.userMessage,
          workspace,
        },
      );
      return { id: created.id };
    }
    const created = await runCreate(
      {
        repository: deps.repository,
        settings: loaded,
        execCwd: deps.execCwd,
        llm: deps.llm,
        onRunIdentified: (id) => ctx.attachRunId(id),
      },
      { systemPrompt: business.systemPrompt, userMessage: business.userMessage },
    );
    return { id: created.id };
  },
};

export function execCreateRun(
  deps: ExecEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Promise<ExecutedResponse<CreateRunResult>> {
  return submitActive(deps, sender, createChannel, payload);
}

// ---------------------------------------------------------------------------
// 2) runs:fork —— 普通与隔离 result 分叉（execution 模式必须与父本匹配）
// ---------------------------------------------------------------------------

const forkChannel: ActiveChannel<ForkRunRequest, ForkRunResult> = {
  channel: CHANNELS.forkRun,
  schema: ForkRunRequestSchema,
  targetOf: (business) => ({
    kind: "result",
    mode: business.execution === undefined ? "plain" : "isolated",
    parentRunId: business.parentRunId,
    atSpanId: business.atSpanId,
    editField: business.edit.field,
  }),
  async run(deps, business, ctx) {
    const loaded = deps.settings.load();
    if (loaded === null) {
      throw new ForkError(
        "SETTINGS_NOT_CONFIGURED",
        "尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置",
      );
    }
    // U6 §5.2/5.3：服务端重读被引用父本的来源（design D5：来源检查位于一切副作用之前）
    // ——ownOnly ⇒ RUN_LINEAGE_INCOMPLETE；读取失败 ⇒ RUN_DETAIL_UNREADABLE。
    // 普通/隔离两条分支共用同一判据；隔离分支的副本世界创建、trace 写入都在它之后。
    checkRunSource(deps.repository.tracesDir, business.parentRunId);
    const result =
      business.execution === undefined
        ? await runFork(
            {
              repository: deps.repository,
              settings: loaded,
              execCwd: deps.execCwd,
              llm: deps.llm,
              onRunIdentified: (id) => ctx.attachRunId(id),
            },
            business,
          )
        : await runForkIsolated(
            {
              repository: deps.repository,
              settings: loaded,
              dataDir: deps.dataDir,
              llm: deps.llm,
              onRunIdentified: (id) => ctx.attachRunId(id),
            },
            {
              parentRunId: business.parentRunId,
              atSpanId: business.atSpanId,
              edit: business.edit,
              execution: business.execution,
            },
          );
    return { id: result.id };
  },
};

export function execForkRun(
  deps: ExecEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Promise<ExecutedResponse<ForkRunResult>> {
  return submitActive(deps, sender, forkChannel, payload);
}

// ---------------------------------------------------------------------------
// 3) runs:promptFork —— 编辑启动上下文从头重跑
// ---------------------------------------------------------------------------

const promptChannel: ActiveChannel<PromptForkRequest, PromptForkResult> = {
  channel: CHANNELS.promptFork,
  schema: PromptForkRequestSchema,
  targetOf: (business) => ({
    kind: "prompt",
    parentRunId: business.parentRunId,
    editField: business.edit.field,
  }),
  async run(deps, business, ctx) {
    const loaded = deps.settings.load();
    if (loaded === null) {
      throw new ForkError(
        "SETTINGS_NOT_CONFIGURED",
        "尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置",
      );
    }
    // U6 §5.4：服务端重读 prompt 父本来源（design D5 同一判据）；来源拒绝后
    // 仍保留完整父本的原领域门禁（启动上下文 / config_hash 等不因 complete 绕过）
    checkRunSource(deps.repository.tracesDir, business.parentRunId);
    const result = await runPromptFork(
      {
        repository: deps.repository,
        settings: loaded,
        execCwd: deps.execCwd,
        llm: deps.llm,
        onRunIdentified: (id) => ctx.attachRunId(id),
      },
      business,
    );
    return { id: result.id };
  },
};

export function execPromptFork(
  deps: ExecEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Promise<ExecutedResponse<PromptForkResult>> {
  return submitActive(deps, sender, promptChannel, payload);
}

// ---------------------------------------------------------------------------
// 4) proxy:fork —— 编辑 messages 经代理重发（父 run 与代理 key 门禁在 manager 内）
// ---------------------------------------------------------------------------

const proxyChannel: ActiveChannel<ProxyForkRequest, ProxyForkResult> = {
  channel: CHANNELS.proxyFork,
  schema: ProxyForkRequestSchema,
  targetOf: (business) => ({
    kind: "proxy",
    parentRunId: business.parentRunId,
    atSpanId: business.atSpanId,
  }),
  async run(deps, business, ctx) {
    // U6 §5.5：服务端重读代理父本来源——必须在 ProxyManager.fork 发请求/录制之前
    //（ownOnly ⇒ RUN_LINEAGE_INCOMPLETE；不借用其他代理记录凑父链）
    checkRunSource(deps.repository.tracesDir, business.parentRunId);
    const result = await deps.proxy.fork(business);
    // 代理的身份来自 recorder 的返回值（本次 fork 上下文），不是全局"最后写入"字段
    ctx.attachRunId(result.id);
    return { id: result.id };
  },
};

export function execProxyFork(
  deps: ExecEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Promise<ExecutedResponse<ProxyForkResult>> {
  return submitActive(deps, sender, proxyChannel, payload);
}

// ---------------------------------------------------------------------------
// 5) runs:modelAb —— 整批占一个槽；dry-run 属另一条只读通道（见 execModelAbPlan）
// ---------------------------------------------------------------------------

const modelAbChannel: ActiveChannel<ModelAbRequest, ModelAbResult> = {
  channel: CHANNELS.modelAb,
  schema: ModelAbRequestSchema,
  targetOf: (business) => ({
    kind: "modelAb",
    parentRunId: business.parentRunId,
    armCount: business.arms.length,
  }),
  async run(deps, business, ctx) {
    if (business.dryRun === true) {
      // 两条分支不混用：预览是只读的，不该占用主动执行槽，也不该产生操作身份
      throw new ForkError(
        "MODEL_AB_DRY_RUN_CHANNEL",
        "A/B 计划预览请用只读通道（modelAbPlan）；执行通道会整批占住主动槽",
      );
    }
    const loaded = deps.settings.load();
    if (loaded === null) {
      throw new ForkError(
        "SETTINGS_NOT_CONFIGURED",
        "尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置",
      );
    }
    // U6 §5.6：整批来源门禁——在第一臂开始之前拒绝（零臂身份、零模型调用）；
    // dry-run 通道检查已在上面的分支里，此处只服务真实执行
    checkRunSource(deps.repository.tracesDir, business.parentRunId);
    const result: ModelAbRunResult = await runModelAb(
      {
        repository: deps.repository,
        settings: loaded,
        execCwd: deps.execCwd,
        llm: deps.llm,
        onArmRunIdentified: (info) => {
          ctx.attachExperimentId(info.experimentId);
          // 先登记身份（结局未知时 outcome 留 null，批次结束时由 attachArm 补齐）
          ctx.attachArm({ index: info.index, id: info.id, outcome: null });
          ctx.attachRunId(info.id);
        },
      },
      business,
    );
    for (const fact of result.armFacts) {
      ctx.attachArm({ index: fact.index, id: fact.id, outcome: fact.outcome });
    }
    return {
      experimentId: result.experimentId,
      ids: result.ids,
      ok: result.ok,
      plan: result.plan,
      sideEffectsAllowed: result.sideEffectsAllowed,
    };
  },
};

export function execModelAb(
  deps: ExecEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Promise<ExecutedResponse<ModelAbResult>> {
  return submitActive(deps, sender, modelAbChannel, payload);
}

/**
 * `runs:modelAbPlan` —— A/B 预览的**只读**分支（design D3：不占主动槽、不消耗执行授权、
 * 不建 operationId）。父链门禁、双真相源、工具策略与真实执行判据完全同源，
 * 因此"预览即真实判据"的既有语义一字不动。
 */
export async function execModelAbPlan(
  deps: ExecEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Promise<
  { ok: true; data: ModelAbResult } | { ok: false; error: { code: string; message: string } }
> {
  if (!deps.isTrustedSender(sender)) {
    return {
      ok: false,
      error: {
        code: OPERATION_ERROR.untrustedSender,
        message: "只读通道同样只接受本应用窗口主 frame 的调用",
      },
    };
  }
  const parsed = ModelAbRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: parsed.error.issues.map((one) => one.code).join("；"),
      },
    };
  }
  if (parsed.data.dryRun !== true) {
    return {
      ok: false,
      error: {
        code: "MODEL_AB_PLAN_REQUIRES_DRY_RUN",
        message: "只读预览通道必须显式 dryRun:true；真实执行请走主动执行通道",
      },
    };
  }
  const loaded = deps.settings.load();
  if (loaded === null) {
    return {
      ok: false,
      error: {
        code: "SETTINGS_NOT_CONFIGURED",
        message: "尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置",
      },
    };
  }
  // U6 §5.7：只读预览与真实执行同判据——ownOnly / 不可读父本直接给来源拒绝原因，
  // 不生成可执行计划、不调网络、不写文件；本通道本就不登记、不占槽
  try {
    checkRunSource(deps.repository.tracesDir, parsed.data.parentRunId);
  } catch (error) {
    if (error instanceof RunSourceRejection) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    throw error;
  }
  try {
    const { armFacts: _armFacts, ...result } = await runModelAb(
      { repository: deps.repository, settings: loaded, execCwd: deps.execCwd },
      parsed.data,
    );
    return { ok: true, data: result };
  } catch (error) {
    const mapped = toRunResult(error);
    return mapped.outcome === "returned"
      ? { ok: false, error: { code: "MODEL_AB_FAILED", message: "预览失败" } }
      : { ok: false, error: { code: mapped.code, message: mapped.message } };
  }
}
