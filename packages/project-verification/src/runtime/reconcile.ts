import type { z } from "zod";
import {
  RecordAppendError,
  appendInterruptedToPreparationRecord,
  appendInterruptedToVerificationRecord,
  probeRecordState,
} from "../records/append.js";
import { preparationRecordPath, verificationRecordPath } from "../records/layout.js";
import {
  PreparationEventSchema,
  type ResourceRegistration,
  VerificationEventSchema,
} from "../schema.js";
import {
  OWNER_LABEL_KEY,
  OWNER_LABEL_VALUE,
  type RegistrationIoError,
  listResourceRegistrations,
  markResourceRemoved,
} from "./registration.js";

/**
 * 启动残留核查（R3 tasks 3.7；验收 P22/P23 的核查面）。
 *
 * design D6 / delta spec「残留资源可核查但不恢复旧执行」在此落牙：
 * - **先分类后执行**：登记损坏、daemon 不可达、归属不明、记录缺失/损坏——任何异常
 *   都在**停止任何容器之前**发现并阻断（P23：不伪造清理成功、不停止陌生资源）；
 * - **归属判定双门**：容器名匹配确定性派生形态 **且** 登记在案（containerName 一致、
 *   owner 标签一致、已知容器 ID 不冲突）才认定本产品残留；带 owner 标签但登记/名字
 *   对不上的容器一律**归属不明** ⇒ 阻断且不动（P22/P23 分界）。无标签容器根本不进
 *   扫描面（label 过滤精确键值，§1.6），天然不被触碰；
 * - **只清理不恢复**：停止/确认/移除遗留容器，向**未封存**记录追加 interrupted 与
 *   清理事实；不写终止、不恢复旧 registry、不继续旧执行（新 main 用新 epoch，4.x）；
 * - **幂等**：已处理（phase=removed）的登记跳过；记录已有 interrupted 不二次追加；
 *   清理成功后登记收尾为 removed ⇒ 复跑为 no-op；
 * - **读记录不触发核查写盘**（design D6）：本模块只由 main 启动互斥区调用（4.x 接线），
 *   reader/list/readLog 永不进入此处。
 */

/** 核查端口：由 Docker 受控后端实现（docker-runtime.ts），包内测试用 fake。 */
export interface RuntimeResourceFacts {
  /** 64 位十六进制容器 ID（list 用 --no-trunc）。 */
  readonly containerId: string;
  /** 容器名（不带前导斜杠）。 */
  readonly name: string;
  /** Docker 容器状态（running/exited/created/…）。 */
  readonly state: string;
  /** 容器标签（defense-in-depth：核查侧复核 owner 标签，不依赖端口单方过滤）。 */
  readonly labels: Readonly<Record<string, string>>;
}

export interface RuntimeResourcePort {
  /** 列出带本产品 owner 标签的全部容器（含非 running；实现用 label 精确过滤）。 */
  listOwnedContainers(): Promise<RuntimeResourceFacts[]>;
  /** 容器级定向停止（TERM→宽限→KILL，覆盖容器内全部工作负载/后代）。基础设施失败抛错。 */
  stopContainer(containerId: string): Promise<void>;
  /** 确认容器不再运行（状态核验，不乐观宣布；「已不存在」视为已停）。失败抛错。 */
  confirmStopped(containerId: string): Promise<void>;
  /** 移除容器（「已不存在」视为成功）。基础设施失败抛错。 */
  removeContainer(containerId: string): Promise<void>;
}

export interface ReconciledResourceFact {
  readonly name: string;
  readonly containerId: string;
}

export type ReconciliationOutcome =
  | {
      readonly ok: true;
      readonly scannedRegistrations: number;
      readonly stopped: readonly ReconciledResourceFact[];
      readonly removed: readonly ReconciledResourceFact[];
      /** 成功追加 interrupted 事实的记录 ID（verificationId/preparationId）。 */
      readonly appendedRecords: readonly string[];
      /** 已封存（无需追加）的记录 ID。 */
      readonly sealedRecords: readonly string[];
      /** 登记在案但本次核查未见的资源名（如实登记，不冒充已停止）。 */
      readonly unconfirmed: readonly string[];
    }
  | {
      readonly ok: false;
      readonly kind: "blocked";
      readonly reason: string;
      /** 归属不明的带标签容器（P23 诊断；阻断时一律未触碰）。 */
      readonly unattributed?: readonly ReconciledResourceFact[];
      /** 阻断前已完成的清理事实（部分完成如实呈现）。 */
      readonly partialStopped?: readonly ReconciledResourceFact[];
      readonly partialRemoved?: readonly ReconciledResourceFact[];
    };

/** 归属判定：容器是否可确证为本产品（本数据根登记 + 确定性命名 + owner 标签三重一致）。 */
function attributeContainer(
  container: RuntimeResourceFacts,
  registrations: readonly ResourceRegistration[],
): ResourceRegistration | null {
  const name = container.name.startsWith("/") ? container.name.slice(1) : container.name;
  if (container.labels[OWNER_LABEL_KEY] !== OWNER_LABEL_VALUE) {
    return null;
  }
  const match = registrations.find((entry) => entry.containerName === name);
  if (match === undefined) {
    return null;
  }
  // 已知容器 ID 冲突 ⇒ 归属存疑（同名不同 ID = 外部干扰/登记过期），按陌生处理
  if (
    match.knownContainerIds.length > 0 &&
    !match.knownContainerIds.includes(container.containerId)
  ) {
    return null;
  }
  return match;
}

function recordIdOf(
  entry: ResourceRegistration,
): { id: string; kind: "prepare" | "verification" } | null {
  if (entry.verificationId !== null) {
    return { id: entry.verificationId, kind: "verification" };
  }
  if (entry.preparationId !== null) {
    return { id: entry.preparationId, kind: "prepare" };
  }
  return null;
}

function probePath(root: string, kind: "prepare" | "verification", id: string): string {
  return kind === "verification"
    ? verificationRecordPath(root, id)
    : preparationRecordPath(root, id);
}

function probeUnion(kind: "prepare" | "verification"): z.ZodType {
  return kind === "verification" ? VerificationEventSchema : PreparationEventSchema;
}

function appendInterrupted(
  root: string,
  kind: "prepare" | "verification",
  id: string,
  event: {
    reason: string;
    stoppedResources: ReconciledResourceFact[];
    removedResources: ReconciledResourceFact[];
    unconfirmedResources: string[];
    at: string;
  },
): void {
  if (kind === "verification") {
    appendInterruptedToVerificationRecord(root, id, event);
  } else {
    appendInterruptedToPreparationRecord(root, id, event);
  }
}

export interface ReconcileInput {
  /** 本实例数据根（登记与领域记录都在其内）。 */
  readonly root: string;
  readonly port: RuntimeResourcePort;
  /** 核查原因（写入 interrupted 事件；缺省 = main 启动残留核查）。 */
  readonly reason?: string;
  /** 覆盖当前时间（测试用；缺省取系统时钟）。 */
  readonly now?: () => Date;
}

/**
 * 启动残留核查主流程。结果只有「全部干净/清理完成」或「blocked（附诊断）」两种——
 * 调用方（main，4.x）只在 ok 时重新开放 R3；blocked 时 R3 保持关闭并呈现诊断。
 */
export async function reconcileStartupLeftovers(
  input: ReconcileInput,
): Promise<ReconciliationOutcome> {
  const now = input.now ?? (() => new Date());
  const reason = input.reason ?? "main 启动残留核查";

  // ── Phase A：只读分类（零副作用）——任何异常都在此阻断 ──────────────────
  let registrations: ResourceRegistration[];
  try {
    registrations = listResourceRegistrations(input.root);
  } catch (error) {
    const code = (error as RegistrationIoError).code ?? "REGISTRATION_IO_FAILED";
    return {
      ok: false,
      kind: "blocked",
      reason: `恢复日志不可信（${code}），R3 保持阻断：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let containers: RuntimeResourceFacts[];
  try {
    containers = await input.port.listOwnedContainers();
  } catch (error) {
    return {
      ok: false,
      kind: "blocked",
      reason: `daemon 不可达/资源枚举失败，R3 保持阻断（P23）：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const attributed = new Map<
    string,
    { registration: ResourceRegistration; container: RuntimeResourceFacts }
  >();
  const unattributed: ReconciledResourceFact[] = [];
  for (const container of containers) {
    const name = container.name.startsWith("/") ? container.name.slice(1) : container.name;
    const match = attributeContainer(container, registrations);
    if (match === null) {
      unattributed.push({ name, containerId: container.containerId });
    } else {
      attributed.set(match.resourceOwnerId, { registration: match, container });
    }
  }
  if (unattributed.length > 0) {
    return {
      ok: false,
      kind: "blocked",
      reason: `存在归属不明的带 owner 标签容器（${unattributed.length} 个），R3 保持阻断且未触碰（P23）`,
      unattributed,
    };
  }

  // 记录状态探测（缺失/损坏即阻断；封存 + 存活容器 = 收尾曾被伪称 ⇒ 阻断）
  const recordStates = new Map<string, ReturnType<typeof probeRecordState>>();
  for (const entry of registrations) {
    if (entry.phase === "removed") {
      continue; // 已收尾的历史登记：复跑幂等跳过
    }
    const linked = recordIdOf(entry);
    if (linked === null) {
      continue; // 无记录关联（登记先于记录建立即被中断）：无事实可补，仅做资源清理
    }
    let probe: ReturnType<typeof probeRecordState>;
    try {
      probe = probeRecordState(
        probePath(input.root, linked.kind, linked.id),
        linked.kind === "verification" ? "verificationId" : "preparationId",
        linked.id,
        probeUnion(linked.kind),
      );
    } catch (error) {
      return {
        ok: false,
        kind: "blocked",
        reason: `领域记录不可读（${linked.id}），R3 保持阻断：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!probe.exists) {
      return {
        ok: false,
        kind: "blocked",
        reason: `登记 ${entry.resourceOwnerId} 关联的${linked.kind === "verification" ? "验证" : "准备"}记录缺失（${linked.id}）——记录先于资源建立的纪律被破坏，R3 保持阻断`,
      };
    }
    if (probe.state === "corrupt") {
      return {
        ok: false,
        kind: "blocked",
        reason: `领域记录损坏（${linked.id}）：${probe.reason ?? "未知原因"}——不伪造中断事实，R3 保持阻断（P23）`,
      };
    }
    if (probe.state === "sealed" && attributed.has(entry.resourceOwnerId)) {
      return {
        ok: false,
        kind: "blocked",
        reason: `记录 ${linked.id} 已封存但其资源容器仍存活（${entry.containerName}）——收尾事实自相矛盾，R3 保持阻断`,
      };
    }
    recordStates.set(entry.resourceOwnerId, probe);
  }

  // ── Phase B：执行清理（登记 × 容器 → 停止/确认/移除 → 追加事实 → 登记收尾）────
  const stopped: ReconciledResourceFact[] = [];
  const removed: ReconciledResourceFact[] = [];
  const appendedRecords: string[] = [];
  const sealedRecords: string[] = [];
  const unconfirmed: string[] = [];
  try {
    for (const entry of registrations) {
      if (entry.phase === "removed") {
        continue;
      }
      const found = attributed.get(entry.resourceOwnerId);
      let stoppedForEntry: ReconciledResourceFact[] = [];
      let removedForEntry: ReconciledResourceFact[] = [];
      let unconfirmedForEntry: string[] = [];
      if (found !== undefined) {
        const fact = { name: found.container.name, containerId: found.container.containerId };
        await input.port.stopContainer(fact.containerId);
        await input.port.confirmStopped(fact.containerId);
        stoppedForEntry = [fact];
        stopped.push(fact);
        await input.port.removeContainer(fact.containerId);
        removedForEntry = [fact];
        removed.push(fact);
      } else {
        unconfirmedForEntry = [entry.containerName];
        unconfirmed.push(entry.containerName);
      }

      const linked = recordIdOf(entry);
      const probe = recordStates.get(entry.resourceOwnerId);
      if (
        linked !== null &&
        probe !== undefined &&
        probe.exists &&
        probe.state === "unsealed" &&
        !probe.hasInterrupted
      ) {
        appendInterrupted(input.root, linked.kind, linked.id, {
          reason,
          stoppedResources: stoppedForEntry,
          removedResources: removedForEntry,
          unconfirmedResources: unconfirmedForEntry,
          at: now().toISOString(),
        });
        appendedRecords.push(linked.id);
      } else if (
        linked !== null &&
        probe !== undefined &&
        probe.exists &&
        probe.state === "sealed"
      ) {
        sealedRecords.push(linked.id);
      }
      markResourceRemoved(input.root, entry.resourceOwnerId);
    }
  } catch (error) {
    const reasonText =
      error instanceof RecordAppendError
        ? `清理事实追加失败（${error.code}），记录不可写 ⇒ R3 保持阻断（P23）`
        : "残留清理未确认完成，R3 保持阻断（不乐观宣布，P23）";
    return {
      ok: false,
      kind: "blocked",
      reason: `${reasonText}：${error instanceof Error ? error.message : String(error)}`,
      partialStopped: stopped,
      partialRemoved: removed,
    };
  }

  return {
    ok: true,
    scannedRegistrations: registrations.filter((e) => e.phase !== "removed").length,
    stopped,
    removed,
    appendedRecords,
    sealedRecords,
    unconfirmed,
  };
}
