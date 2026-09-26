import type { Envelope } from "../shared/ipc";
import { fail, ok } from "../shared/ipc";
import type { OperationStatusResult, ReconcileResult } from "../shared/operations";
import { OPERATION_ERROR, ReconcileRequestSchema } from "../shared/operations";
import type { OperationRegistry } from "./operation-registry";

/**
 * U4 `operations:status` / `operations:reconcile` 两条通道的**纯逻辑处理体**（design D4/D6）。
 *
 * 与 `draft-close-guard.ts` 同一分层理由：本文件不 import electron，sender/frame 的可信度
 * 由 electron 适配层（`ipc.ts`）以普通数据注入，因此「旧 epoch 和非法身份无副作用」
 * 这类判据可以在 vitest 下逐条直测。
 *
 * 校验顺序（每一步都在任何副作用之前）：
 * 1. 发送者必须是本应用创建窗口的**主 frame**（子 frame、其他 webContents 一律不信）；
 * 2. 载荷形状：只接受 `{epoch, operationId}`，多一个字段即非法；
 * 3. epoch 必须是当前 main 会话（旧 epoch 零副作用——绝不因它建封禁、也不释放当前槽）；
 * 4. 通过后才进入 registry 的同步核对段。
 */

/** 渲染层发送者的受限描述（从 IpcMainInvokeEvent 提取；取不到主 frame 时给 -1 ⇒ 必然不匹配） */
export interface TrustedSender {
  readonly webContentsId: number;
  readonly frameRoutingId: number;
}

export interface OperationEndpointDeps {
  readonly registry: OperationRegistry;
  /** 该 sender 是否为已登记窗口的主 frame */
  readonly isTrustedSender: (sender: TrustedSender) => boolean;
}

function rejectUntrusted(
  deps: OperationEndpointDeps,
  sender: TrustedSender,
): Envelope<never> | null {
  if (deps.isTrustedSender(sender)) return null;
  return fail(
    OPERATION_ERROR.untrustedSender,
    new Error("操作通道只接受本应用窗口主 frame 的调用"),
  );
}

/**
 * `operations:status`：无参只读握手/快照。
 * 唯一能让它失败的是「发送者不可信」与「main 自己造出自相矛盾的快照」——
 * 后者以失败信封暴露，renderer 因此保留未知与锁，而不是拿到半份状态。
 */
export function readOperationStatus(
  deps: OperationEndpointDeps,
  sender: TrustedSender,
): Envelope<OperationStatusResult> {
  const rejected = rejectUntrusted(deps, sender);
  if (rejected !== null) return rejected;
  try {
    return ok(deps.registry.snapshot());
  } catch (error) {
    return fail("OPERATIONS_STATUS_FAILED", error);
  }
}

/**
 * `operations:reconcile`：按 epoch/operationId 原子核对。
 * 已登记 ⇒ 返回真实状态（running/settled/notAccepted）；从未接受 ⇒ 建立永久封禁。
 * 响应同时带 main 当前槽与登记版本——**锁不由被查询的操作决定**。
 */
export function reconcileOperation(
  deps: OperationEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Envelope<ReconcileResult> {
  const rejected = rejectUntrusted(deps, sender);
  if (rejected !== null) return rejected;
  const parsed = ReconcileRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return fail(
      OPERATION_ERROR.invalidIdentity,
      new Error("核对请求必须只含当前 epoch 与 operationId（UUID）"),
    );
  }
  if (parsed.data.epoch !== deps.registry.epoch) {
    return fail(
      OPERATION_ERROR.staleEpoch,
      new Error("旧 main 会话的核对不会影响当前登记，也不会释放当前槽"),
    );
  }
  const operation = deps.registry.reconcile(parsed.data.operationId);
  return ok({ ...deps.registry.slotState(), operation });
}
