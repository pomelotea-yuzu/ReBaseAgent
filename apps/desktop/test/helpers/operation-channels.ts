import type { Envelope } from "../../src/shared/ipc";
import { ok } from "../../src/shared/ipc";
import { OPERATION_ERROR } from "../../src/shared/operations";
import type {
  ExecutedResponse,
  OperationIdentity,
  OperationStatusResult,
  ReconcileRequest,
  ReconcileResult,
} from "../../src/shared/operations";

/**
 * U4 之后，渲染层的每个主动入口都要先与 main 握手（取 epoch）再提交，
 * 因此**任何**驱动 store 主动路径的 api 桩都必须能答 `operations:status`。
 * 本模块给出可用的默认应答与最小包装，避免每个测试文件各抄一份快照形状。
 */

/** 假的 main 会话 epoch（固定值：断言"同一会话内不变"时可复用） */
export const FAKE_EPOCH = "44444444-4444-4444-8444-444444444444";

/** 空闲会话的自洽快照（schema 能过 ⇒ store 会缓存 epoch） */
export function statusSnapshot(overrides?: Partial<OperationStatusResult>): OperationStatusResult {
  return {
    epoch: FAKE_EPOCH,
    registryVersion: 1,
    activeOperationId: null,
    closing: false,
    configurationBusy: false,
    operations: [],
    ...overrides,
  };
}

/**
 * 把既有的 `Envelope` 桩转成执行通道的响应形状（业务载荷原样进 `data`，
 * 回执用请求带来的身份 + 一个递增版本冒充——够 renderer 走「按身份处理」的分支）。
 */
export function toExecuted<T>(
  envelope: Envelope<T>,
  identity: OperationIdentity,
  registryVersion = 2,
): ExecutedResponse<T> {
  const operation = { ...identity, registryVersion, state: "settled" as const };
  return envelope.ok
    ? { ok: true, operation, data: envelope.data }
    : { ok: false, operation, error: envelope.error };
}

/**
 * 主动通道桩：按**请求带来的身份**回话（U4 之后 `ok:true` 必须带回执，
 * 否则 renderer 按「回执不可信」处理 = 未知，不部分采纳成功字段）。
 */
export function executedOk<T>(data: T, registryVersion = 2) {
  return async (request: {
    operation: OperationIdentity;
  }): Promise<ExecutedResponse<T>> => toExecuted(ok(data), request.operation, registryVersion);
}

/** 业务拒绝同样要带回执（settled 是可信终态，不是"没执行"） */
export function executedFail(code: string, message: string, registryVersion = 2) {
  return async (request: {
    operation: OperationIdentity;
  }): Promise<ExecutedResponse<never>> => ({
    ok: false,
    operation: {
      epoch: request.operation.epoch,
      operationId: request.operation.operationId,
      registryVersion,
      state: "settled",
    },
    error: { code, message },
  });
}

/** 空结果的 A/B 响应（草稿/编辑器类用例只关心"有明确返回"） */
export const EMPTY_MODEL_AB_RESULT = {
  experimentId: "exp_stub",
  ids: [],
  ok: true,
  plan: [],
  sideEffectsAllowed: false,
};

/**
 * 给"以 `api.xxx = ...` 方式打桩"的测试装好 U4 新增的两条操作通道与 A/B 两条通道默认值。
 * 已存在的桩一律不覆盖（用例自己注入的序列优先）。
 */
export function installOperationChannels(
  api: Record<string, unknown>,
  options?: { status?: OperationStatusResult },
): void {
  const stub = operationChannelsStub(options);
  api.operationsStatus ??= stub.operationsStatus;
  api.operationsReconcile ??= stub.operationsReconcile;
  api.modelAb ??= async () => ({ ok: true as const, data: EMPTY_MODEL_AB_RESULT });
  api.modelAbPlan ??= async () => ({ ok: true as const, data: EMPTY_MODEL_AB_RESULT });
}

/** 握手/核对两条通道的默认应答；用例覆盖时改 `status` / 自己实现 reconcile */
export function operationChannelsStub(options?: {
  status?: OperationStatusResult;
  /** 返回 null ⇒ 握手失败（通道失联口径） */
  statusEnvelope?: Envelope<OperationStatusResult> | null;
  reconcile?: (request: ReconcileRequest) => ReconcileResult;
}): {
  operationsStatus: () => Promise<Envelope<OperationStatusResult>>;
  operationsReconcile: (request: ReconcileRequest) => Promise<Envelope<ReconcileResult>>;
  /** 握手被调用次数（断言"每次提交只握手一次"等） */
  statusCalls: () => number;
} {
  let calls = 0;
  return {
    operationsStatus: async () => {
      calls += 1;
      if (options?.statusEnvelope === null) {
        return { ok: false, error: { code: "OPERATIONS_STATUS_FAILED", message: "通道断开" } };
      }
      return ok(options?.statusEnvelope?.data ?? options?.status ?? statusSnapshot());
    },
    operationsReconcile: async (request) => {
      const reconcile = options?.reconcile;
      if (reconcile === undefined) {
        return {
          ok: false,
          error: { code: OPERATION_ERROR.invalidIdentity, message: "桩未实现核对" },
        };
      }
      return ok(reconcile(request));
    },
    statusCalls: () => calls,
  };
}
