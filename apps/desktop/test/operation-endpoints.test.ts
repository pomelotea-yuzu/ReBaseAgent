import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type OperationEndpointDeps,
  type TrustedSender,
  readOperationStatus,
  reconcileOperation,
} from "../src/main/operation-endpoints";
import type { ExecutionSpec } from "../src/main/operation-registry";
import { OperationRegistry } from "../src/main/operation-registry";
import type { Envelope } from "../src/shared/ipc";
import type { OperationStatusResult, ReconcileResult } from "../src/shared/operations";
import {
  OPERATION_ERROR,
  OperationStatusResultSchema,
  ReconcileResultSchema,
} from "../src/shared/operations";
import { deferred, flush } from "./helpers/deterministic-schedule";

/**
 * U4 任务 1.6：`operations:status` / `operations:reconcile` 的处理体。
 *
 * 判据来源：tasks.md 1.6 + design D4。
 * 验收场景（delta 逐字标题）：
 * - 「reconcile 先到封禁迟到提交」——同 epoch/operationId 的核对先到达即建立
 *   notAccepted 封禁，之后同 ID 的正式执行始终被拒，且不产生任何执行；
 * - 「执行先到核对实际状态」——被接受后核对返回真实 running，settled 后返回 settled，
 *   都不登记 notAccepted、不再次执行，响应同时反映 main 当前槽；
 * - 「旧 epoch 和非法身份无副作用」——旧 epoch、非法身份、不受信任 sender/frame
 *   在副作用之前被拒：不建当前会话操作、不释放当前槽、不消耗任何许可。
 *
 * 本组直测纯处理体（不 import electron）；sender/frame 以普通数据注入。
 */

const WINDOW = 1;
const MAIN_FRAME = 100;
const FP = "f".repeat(64);
const target = { kind: "create", mode: "plain" } as const;

function sender(over?: Partial<TrustedSender>): TrustedSender {
  return { webContentsId: WINDOW, frameRoutingId: MAIN_FRAME, ...over };
}

function setup(): {
  deps: OperationEndpointDeps;
  registry: OperationRegistry;
  calls: string[];
} {
  const registry = new OperationRegistry();
  const calls: string[] = [];
  const deps: OperationEndpointDeps = {
    registry,
    isTrustedSender: (candidate) =>
      candidate.webContentsId === WINDOW && candidate.frameRoutingId === MAIN_FRAME,
  };
  return { deps, registry, calls };
}

/** 一个可控执行的 spec：execute 停在 gate 上，由测试放行 */
function gatedSpec(
  calls: string[],
  operationId: string,
): { spec: ExecutionSpec; release: () => void } {
  const gate = deferred<void>();
  const spec: ExecutionSpec = {
    operationId,
    target,
    fingerprint: FP,
    async execute(ctx) {
      calls.push(`execute:${ctx.operationId}`);
      await gate.promise;
      ctx.attachRunId("run_real");
      return { outcome: "returned", data: { id: "run_real" } };
    },
  };
  return { spec, release: () => gate.resolve(undefined) };
}

function expectFailure(envelope: Envelope<unknown>, code: string): void {
  expect(envelope.ok).toBe(false);
  if (envelope.ok) throw new Error(`期望失败信封 ${code}，实际成功`);
  expect(envelope.error.code).toBe(code);
}

function expectStatus(deps: OperationEndpointDeps): OperationStatusResult {
  const envelope = readOperationStatus(deps, sender());
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) throw new Error(`status 被拒：${envelope.error.message}`);
  expect(OperationStatusResultSchema.safeParse(envelope.data).success).toBe(true);
  return envelope.data;
}

describe("U4 1.6 operations:status", () => {
  it("可信主 frame：返回自洽快照，且读操作本身零副作用（版本不变）", () => {
    const { deps, registry } = setup();
    const empty = expectStatus(deps);
    expect(empty).toMatchObject({ epoch: registry.epoch, activeOperationId: null, operations: [] });
    const version = registry.registryVersion;
    expectStatus(deps);
    expectStatus(deps);
    expect(registry.registryVersion).toBe(version);
  });

  it("子 frame 与其他 webContents 一律拒绝，且不产生任何登记", () => {
    const { deps, registry } = setup();
    const version = registry.registryVersion;
    for (const bad of [sender({ frameRoutingId: MAIN_FRAME + 1 }), sender({ webContentsId: 99 })]) {
      expectFailure(readOperationStatus(deps, bad), OPERATION_ERROR.untrustedSender);
    }
    expect(registry.size).toBe(0);
    expect(registry.registryVersion).toBe(version);
  });

  it("settled 与 notAccepted 都在 status 里：面板关闭/列表淘汰不影响可读事实", async () => {
    const { deps, registry, calls } = setup();
    const run = gatedSpec(calls, randomUUID());
    const inFlight = registry.submitExecution(run.spec);
    run.release();
    await inFlight;
    registry.registerNotAccepted({
      operationId: randomUUID(),
      target: null,
      reason: "reconcile_tombstone",
    });
    const snapshot = expectStatus(deps);
    expect(snapshot.operations.map((one) => one.state).sort()).toEqual(["notAccepted", "settled"]);
    expect(snapshot.activeOperationId).toBeNull();
    expect(snapshot.operations.find((one) => one.state === "settled")?.runIds).toEqual([
      "run_real",
    ]);
  });
});

describe("U4 1.6 operations:reconcile —— 先到封禁、后到只读", () => {
  it("reconcile 先到：原子建立 notAccepted 封禁，迟到的正式执行零副作用", async () => {
    const { deps, registry, calls } = setup();
    const operationId = randomUUID();
    const envelope = reconcileOperation(deps, sender(), { epoch: registry.epoch, operationId });
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error("unreachable");
    expect(envelope.data).toMatchObject({
      epoch: registry.epoch,
      activeOperationId: null,
      operation: {
        operationId,
        state: "notAccepted",
        rejection: "reconcile_tombstone",
        target: null,
        startedAt: null,
        settledAt: null,
        runIds: [],
      },
    });
    expect(ReconcileResultSchema.safeParse(envelope.data).success).toBe(true);

    // 迟到的执行请求：banned，且一次都不执行
    const run = gatedSpec(calls, operationId);
    const report = await registry.submitExecution(run.spec);
    expect(report.acceptance).toBe("banned");
    expect(calls).toEqual([]);
    expect(registry.recordOf(operationId)).toMatchObject({
      state: "notAccepted",
      rejection: "reconcile_tombstone",
    });
    // 再次核对：同一结论，不叠加登记
    const versionAfter = registry.registryVersion;
    const again = reconcileOperation(deps, sender(), { epoch: registry.epoch, operationId });
    expect(again.ok).toBe(true);
    expect(registry.registryVersion).toBe(versionAfter);
    expect(registry.size).toBe(1);
  });

  it("执行先到：核对返回真实 running，不建封禁、不取消、不再次执行", async () => {
    const { deps, registry, calls } = setup();
    const operationId = randomUUID();
    const run = gatedSpec(calls, operationId);
    const inFlight = registry.submitExecution(run.spec);
    await flush();
    const during = reconcileOperation(deps, sender(), { epoch: registry.epoch, operationId });
    expect(during.ok).toBe(true);
    if (!during.ok) throw new Error("unreachable");
    expect(during.data).toMatchObject({
      activeOperationId: operationId,
      operation: { state: "running", operationId },
    });
    expect(registry.size).toBe(1);
    run.release();
    await inFlight;
    const after = reconcileOperation(deps, sender(), { epoch: registry.epoch, operationId });
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("unreachable");
    expect(after.data.operation).toMatchObject({
      state: "settled",
      requestOutcome: "returned",
      runIds: ["run_real"],
    });
    expect(after.data.activeOperationId).toBeNull();
    expect(calls).toEqual([`execute:${operationId}`]);
  });

  it("核对旧操作不解除另一操作的锁：响应里的槽始终指向当前 running", async () => {
    const { deps, registry, calls } = setup();
    const oldId = randomUUID();
    const oldRun = gatedSpec(calls, oldId);
    const oldInFlight = registry.submitExecution(oldRun.spec);
    oldRun.release();
    await oldInFlight;
    // 新操作占槽后再核对旧操作
    const newId = randomUUID();
    registry.submitExecution(gatedSpec(calls, newId).spec);
    const late = reconcileOperation(deps, sender(), { epoch: registry.epoch, operationId: oldId });
    expect(late.ok).toBe(true);
    if (!late.ok) throw new Error("unreachable");
    expect(late.data).toMatchObject({
      operation: { operationId: oldId, state: "settled" },
      activeOperationId: newId,
    });
    expect(registry.activeId).toBe(newId);
  });

  it("旧 epoch 与非法身份一律在副作用前拒绝：不建封禁、不释放当前槽", () => {
    const { deps, registry, calls } = setup();
    const runningId = randomUUID();
    registry.submitExecution(gatedSpec(calls, runningId).spec);
    const sizeBefore = registry.size;
    const versionBefore = registry.registryVersion;
    const staleEpoch = randomUUID();
    expectFailure(
      reconcileOperation(deps, sender(), { epoch: staleEpoch, operationId: randomUUID() }),
      OPERATION_ERROR.staleEpoch,
    );
    for (const bad of [
      {},
      { epoch: registry.epoch },
      { operationId: randomUUID() },
      { epoch: registry.epoch, operationId: "not-a-uuid" },
      { epoch: registry.epoch, operationId: randomUUID(), request: { parentRunId: "run_p" } },
      { epoch: registry.epoch, operationId: randomUUID(), operationId2: "x" },
      null,
      "reconcile",
    ]) {
      expectFailure(reconcileOperation(deps, sender(), bad), OPERATION_ERROR.invalidIdentity);
    }
    expectFailure(
      reconcileOperation(deps, sender({ frameRoutingId: -1 }), {
        epoch: registry.epoch,
        operationId: randomUUID(),
      }),
      OPERATION_ERROR.untrustedSender,
    );
    expect(registry.size).toBe(sizeBefore);
    expect(registry.registryVersion).toBe(versionBefore);
    expect(registry.activeId).toBe(runningId);
    expect(calls).toEqual([`execute:${runningId}`]);
  });
});

describe("U4 1.6 状态通道的失联面（供 renderer 侧守卫复用）", () => {
  it("两条通道的成功返回都过 shared 契约：main 不会发出renderer 无法校验的形状", () => {
    const { deps, registry } = setup();
    const status = readOperationStatus(deps, sender());
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("unreachable");
    expect(OperationStatusResultSchema.parse(status.data).epoch).toBe(registry.epoch);
    const reconcile = reconcileOperation(deps, sender(), {
      epoch: registry.epoch,
      operationId: randomUUID(),
    });
    expect(reconcile.ok).toBe(true);
    if (!reconcile.ok) throw new Error("unreachable");
    const validated: ReconcileResult = ReconcileResultSchema.parse(reconcile.data);
    expect(validated.operation.state).toBe("notAccepted");
    expect(validated.registryVersion).toBeGreaterThan(1);
  });
});
