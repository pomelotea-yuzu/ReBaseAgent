import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OperationRegistry, OperationRegistryInvariantError } from "../src/main/operation-registry";
import type { OperationStatusResult } from "../src/shared/operations";
import {
  OPERATION_DIAGNOSTIC_MAX,
  OPERATION_DIAGNOSTIC_MESSAGE_MAX,
  OperationStatusResultSchema,
} from "../src/shared/operations";

/**
 * U4 任务 1.2：main 生命周期唯一 registry、epoch、登记版本与受限元数据快照。
 *
 * 判据来源：tasks.md 1.2 + design D1/D3/D4。
 * 验收场景（delta 逐字标题）：
 * - 「握手和快照自洽」——`snapshot()` 出口同时过 shared 契约与槽引用校验，
 *   activeOperationId 必指向同 epoch 的 running，且本会话全部操作（含 settled/notAccepted）
 *   都在快照里；
 * - 「同 main 重载恢复操作」——registry 不持有任何 renderer/窗口维度的状态，
 *   因此换一份消费者（= 重载后的新 renderer）读到的仍是同一 epoch、同一槽与同一登记；
 * - 「执行和收尾结束才释放本操作」的存储侧前置：running 期间追加身份不动槽、不改状态。
 *
 * 接受判定（1.4）、执行 promise 收口（1.5）、handler 与 tombstone（1.6）不在本组，
 * 这里只固定「状态容器 + 快照」的语义。时钟注入 ⇒ 时间戳可断言。
 */

const T0_MS = Date.parse("2026-09-26T08:00:00.000Z");
const T1_MS = Date.parse("2026-09-26T08:00:10.000Z");
const T2_MS = Date.parse("2026-09-26T08:00:20.000Z");
const T3_MS = Date.parse("2026-09-26T08:00:30.000Z");

/** operationId 必须是 UUID（schema 判据）；测试用可辨认的固定值 */
const uuid = (label: string): string =>
  `${label.repeat(8)}-${label.repeat(4)}-4${label.repeat(3)}-8${label.repeat(3)}-${label.repeat(12)}`;
const OP_A = uuid("a");
const OP_B = uuid("b");
const OP_AB = uuid("c");
const OP_X = uuid("d");
const OP_BUSY = uuid("e");
const OP_NEVER = uuid("f");
const OP_GHOST = uuid("0");

function setup(options?: { epoch?: string }): {
  registry: OperationRegistry;
  changes: Array<{ change: string; version: number }>;
  /** 推进时钟：每次取时间戳都前进一格，令断言不依赖真实时间 */
  advance: () => void;
} {
  const clock = [T0_MS, T1_MS, T2_MS, T3_MS];
  let tick = 0;
  const changes: Array<{ change: string; version: number }> = [];
  const registry = new OperationRegistry({
    newEpoch: () => options?.epoch ?? "11111111-1111-4111-8111-111111111111",
    now: () => clock[Math.min(tick, clock.length - 1)] as number,
    onChanged: (change, version) => {
      changes.push({ change, version });
    },
  });
  return {
    registry,
    changes,
    advance: (): void => {
      tick += 1;
    },
  };
}

/** 快照出口必须始终是合法契约对象（不自洽就抛，绝不产出半成品） */
function snapshotOf(registry: OperationRegistry): OperationStatusResult {
  const snapshot = registry.snapshot();
  const parsed = OperationStatusResultSchema.safeParse(snapshot);
  expect(parsed.success).toBe(true);
  return snapshot;
}

describe("U4 1.2 registry 会话身份", () => {
  it("epoch 在构造时确定、之后不变；缺省用 UUID；两个 main 会话互不相同", () => {
    const first = new OperationRegistry();
    const second = new OperationRegistry();
    expect(randomUUID().length).toBe(first.epoch.length);
    expect(first.epoch).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    expect(second.epoch).not.toBe(first.epoch);
    const { registry } = setup({ epoch: first.epoch });
    expect(registry.epoch).toBe(first.epoch);
  });

  it("空会话的握手快照自洽：版本 1、无活跃槽、无操作", () => {
    const { registry } = setup();
    expect(registry.registryVersion).toBe(1);
    expect(snapshotOf(registry)).toEqual({
      epoch: registry.epoch,
      registryVersion: 1,
      activeOperationId: null,
      closing: false,
      configurationBusy: false,
      operations: [],
    });
  });
});

describe("U4 1.2 running/settled/notAccepted 的登记与快照", () => {
  it("登记 running ⇒ 占槽且快照自洽；身份/时间来自登记而非臆造", () => {
    const { registry } = setup();
    const record = registry.registerRunning({
      operationId: OP_A,
      target: { kind: "create", mode: "isolated" },
    });
    expect(record.state).toBe("running");
    expect(record.startedAt).toBe(new Date(T0_MS).toISOString());
    expect(record.settledAt).toBeNull();
    expect(record.requestOutcome).toBeNull();
    const snapshot = snapshotOf(registry);
    expect(snapshot.activeOperationId).toBe(OP_A);
    expect(snapshot.operations).toHaveLength(1);
    expect(registry.isAccepting()).toEqual({ accepting: false, reason: "busy" });
  });

  it("settled 后释放自己的槽，但记录仍在快照中（终态不随面板关闭消失）", () => {
    const { registry, advance } = setup();
    advance();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    advance();
    const settled = registry.settle({ operationId: OP_A, requestOutcome: "returned" });
    expect(settled.state).toBe("settled");
    expect(settled.startedAt).toBe(new Date(T1_MS).toISOString());
    expect(settled.settledAt).toBe(new Date(T2_MS).toISOString());
    expect(registry.activeId).toBeNull();
    expect(registry.isAccepting()).toEqual({ accepting: true });
    for (let round = 0; round < 5; round += 1) {
      const snapshot = snapshotOf(registry);
      expect(snapshot.operations.map((one) => [one.operationId, one.state])).toEqual([
        [OP_A, "settled"],
      ]);
      expect(snapshot.activeOperationId).toBeNull();
    }
    expect(registry.size).toBe(1);
  });

  it("notAccepted 不占槽、不伪造执行时间，并与后续操作共存于快照", () => {
    const { registry } = setup();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    const rejected = registry.registerNotAccepted({
      operationId: OP_BUSY,
      target: { kind: "prompt", parentRunId: "run_p", editField: "user_message" },
      reason: "busy",
    });
    expect(rejected).toMatchObject({
      state: "notAccepted",
      rejection: "busy",
      startedAt: null,
      settledAt: null,
      runIds: [],
      requestOutcome: null,
    });
    // 槽仍属 A
    expect(snapshotOf(registry).activeOperationId).toBe(OP_A);
    const tombstone = registry.registerNotAccepted({
      operationId: OP_NEVER,
      target: null,
      reason: "reconcile_tombstone",
    });
    expect(tombstone.target).toBeNull();
    expect(snapshotOf(registry).operations.map((one) => one.operationId)).toEqual([
      OP_A,
      OP_BUSY,
      OP_NEVER,
    ]);
  });

  it("业务拒绝的终态：settled/rejected 必须带稳定错误码（未配置等门禁不被绕过）", () => {
    const { registry } = setup();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    const settled = registry.settle({
      operationId: OP_A,
      requestOutcome: "rejected",
      errorCode: "SETTINGS_NOT_CONFIGURED",
    });
    expect(settled).toMatchObject({
      state: "settled",
      requestOutcome: "rejected",
      errorCode: "SETTINGS_NOT_CONFIGURED",
      runIds: [],
    });
    expect(snapshotOf(registry).operations).toHaveLength(1);
  });
});

describe("U4 1.2 同 main 重载与面板关闭不改变登记", () => {
  it("重载后的新消费者握手：同一 epoch、同一槽、同一登记（含 running）", () => {
    const { registry } = setup();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    registry.attachRunId(OP_A, "run_1");
    const before = snapshotOf(registry);
    // 「另一个 renderer 会话」——纯函数式读取，registry 不持窗口/文档会话状态
    const afterReload = snapshotOf(registry);
    expect(afterReload).toEqual(before);
    expect(afterReload.operations[0]).toMatchObject({
      operationId: OP_A,
      state: "running",
      runIds: ["run_1"],
    });
  });

  it("快照方法无任何过滤参数 ⇒ 无法按界面开合裁剪终态或封禁", () => {
    const { registry } = setup();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    registry.settle({ operationId: OP_A, requestOutcome: "failed", errorCode: "FORK_FAILED" });
    registry.registerNotAccepted({
      operationId: OP_B,
      target: null,
      reason: "reconcile_tombstone",
    });
    expect(registry.snapshot.length).toBe(0);
    expect(registry.recordOf.length).toBe(1);
    expect(registry.slotState()).not.toHaveProperty("operations");
    expect(snapshotOf(registry).operations).toHaveLength(2);
  });
});

describe("U4 1.2 登记版本与身份追加", () => {
  it("每次可见状态转换都递增版本；诊断追加不递增（迟到诊断不得伪装成新状态）", () => {
    const { registry, changes } = setup();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    registry.attachRunId(OP_A, "run_1");
    registry.addDiagnostic(OP_A, { code: "X", stage: "execute", message: "m" });
    registry.setClosing(true);
    registry.setClosing(true);
    registry.setClosing(false);
    expect(changes.map((one) => one.change)).toEqual(["accept", "identity", "flag", "flag"]);
    expect(registry.registryVersion).toBe(1 + changes.length);
    expect([...new Set(changes.map((one) => one.version))].length).toBe(changes.length);
  });

  it("runIds 去重追加，且追加不改变状态、不释放槽", () => {
    const { registry } = setup();
    registry.registerRunning({
      operationId: OP_A,
      target: {
        kind: "result",
        mode: "isolated",
        parentRunId: "run_p",
        atSpanId: "s1",
        editField: "result",
      },
    });
    registry.attachRunId(OP_A, "run_new");
    registry.attachRunId(OP_A, "run_new");
    const snapshot = snapshotOf(registry);
    expect(snapshot.operations[0]?.runIds).toEqual(["run_new"]);
    expect(snapshot.activeOperationId).toBe(OP_A);
  });

  it("A/B 臂摘要：未开始的臂保持 null，按 index 有序，重复同身份幂等", () => {
    const { registry } = setup();
    registry.registerRunning({
      operationId: OP_AB,
      target: { kind: "modelAb", parentRunId: "run_p", armCount: 3 },
    });
    registry.attachExperimentId(OP_AB, "exp_1");
    registry.attachArm(OP_AB, { index: 2, id: null, outcome: null });
    registry.attachArm(OP_AB, { index: 0, id: "run_a0", outcome: "returned" });
    registry.attachArm(OP_AB, { index: 1, id: null, outcome: null });
    registry.attachArm(OP_AB, { index: 0, id: "run_a0", outcome: null });
    const record = registry.recordOf(OP_AB);
    expect(record?.arms).toEqual([
      { index: 0, id: "run_a0", outcome: "returned" },
      { index: 1, id: null, outcome: null },
      { index: 2, id: null, outcome: null },
    ]);
    expect(record?.runIds).toEqual([]);
    expect(record?.experimentId).toBe("exp_1");
    expect(() => registry.attachExperimentId(OP_AB, "exp_2")).toThrow(
      OperationRegistryInvariantError,
    );
    expect(() => registry.attachArm(OP_AB, { index: 0, id: "run_other", outcome: null })).toThrow(
      OperationRegistryInvariantError,
    );
  });

  it("settled 之后不再接受身份追加（终态不可倒流）", () => {
    const { registry } = setup();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    registry.settle({ operationId: OP_A, requestOutcome: "returned" });
    expect(() => registry.attachRunId(OP_A, "run_late")).toThrow(OperationRegistryInvariantError);
    expect(registry.recordOf(OP_A)?.runIds).toEqual([]);
  });

  it("诊断：不合契约的条目不入登记，超过上限只丢新条目（终态与 runIds 永不裁剪）", () => {
    const { registry } = setup();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    registry.addDiagnostic(OP_A, {
      code: "X",
      stage: "not-a-stage" as "execute",
      message: "m",
    });
    registry.addDiagnostic(OP_A, {
      code: "X",
      stage: "execute",
      message: "e".repeat(OPERATION_DIAGNOSTIC_MESSAGE_MAX + 1),
    });
    expect(registry.recordOf(OP_A)?.diagnostics).toEqual([]);
    for (let index = 0; index < OPERATION_DIAGNOSTIC_MAX + 5; index += 1) {
      registry.addDiagnostic(OP_A, { code: `C${index}`, stage: "execute", message: "m" });
    }
    const diagnostics = registry.recordOf(OP_A)?.diagnostics ?? [];
    expect(diagnostics).toHaveLength(OPERATION_DIAGNOSTIC_MAX);
    expect(diagnostics[0]?.code).toBe("C0");
    expect(diagnostics.at(-1)?.code).toBe(`C${OPERATION_DIAGNOSTIC_MAX - 1}`);
    // 未登记 id：静默忽略，不抛、不建新记录
    registry.addDiagnostic(OP_GHOST, { code: "X", stage: "execute", message: "m" });
    expect(registry.size).toBe(1);
    expect(snapshotOf(registry).operations[0]?.state).toBe("running");
  });
});

describe("U4 1.2 关闭与配置变更标记", () => {
  it("closing / configurationBusy 反映在快照与接受判定中，但不是主动操作", () => {
    const { registry } = setup();
    registry.setClosing(true);
    expect(snapshotOf(registry)).toMatchObject({ closing: true, activeOperationId: null });
    expect(registry.isAccepting()).toEqual({ accepting: false, reason: "closing" });
    registry.setClosing(false);
    registry.beginConfigurationChange();
    expect(registry.isAccepting()).toEqual({ accepting: false, reason: "configuration_busy" });
    // 双重占标记是 main 内部错误：必须抛，不能静默把两个变更叠成一个 finally
    expect(() => registry.beginConfigurationChange()).toThrow(OperationRegistryInvariantError);
    expect(registry.recordOf("configuration-busy")).toBeNull();
    const snapshot = snapshotOf(registry);
    expect(snapshot.configurationBusy).toBe(true);
    expect(snapshot.operations).toEqual([]);
    registry.endConfigurationChange();
    expect(registry.isAccepting()).toEqual({ accepting: true });
    // 未占标记时释放为无操作（finally 可无条件调用）
    expect(() => registry.endConfigurationChange()).not.toThrow();
  });

  it("running 期间的配置变更标记不改变槽 owner", () => {
    const { registry } = setup();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    registry.beginConfigurationChange();
    expect(snapshotOf(registry)).toMatchObject({
      activeOperationId: OP_A,
      configurationBusy: true,
    });
    expect(registry.isAccepting()).toEqual({ accepting: false, reason: "configuration_busy" });
  });
});

describe("U4 1.2 登记不变量（拒绝会造成状态倒流或误解锁的调用）", () => {
  it("同一 operationId 不能重复登记 running；槽被占用时不能登记第二个 running", () => {
    const { registry } = setup();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    expect(() =>
      registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } }),
    ).toThrow(OperationRegistryInvariantError);
    expect(() =>
      registry.registerRunning({ operationId: OP_B, target: { kind: "create", mode: "plain" } }),
    ).toThrow(OperationRegistryInvariantError);
    expect(snapshotOf(registry).operations).toHaveLength(1);
  });

  it("notAccepted 不能被反标为 settled；已存在的操作不能被改写为 notAccepted", () => {
    const { registry } = setup();
    registry.registerNotAccepted({
      operationId: OP_X,
      target: null,
      reason: "reconcile_tombstone",
    });
    expect(() => registry.settle({ operationId: OP_X, requestOutcome: "returned" })).toThrow(
      OperationRegistryInvariantError,
    );
    expect(() =>
      registry.registerNotAccepted({ operationId: OP_X, target: null, reason: "busy" }),
    ).toThrow(OperationRegistryInvariantError);
    expect(() => registry.settle({ operationId: OP_GHOST, requestOutcome: "failed" })).toThrow(
      OperationRegistryInvariantError,
    );
  });

  it("非 UUID 的 operationId 在登记入口即拒（坏身份不会漂到后来的快照读取才爆）", () => {
    const { registry } = setup();
    expect(() =>
      registry.registerRunning({
        operationId: "renderer-tab-1",
        target: { kind: "create", mode: "plain" },
      }),
    ).toThrow(OperationRegistryInvariantError);
    expect(() =>
      registry.registerNotAccepted({ operationId: "x", target: null, reason: "busy" }),
    ).toThrow(OperationRegistryInvariantError);
    expect(snapshotOf(registry).operations).toEqual([]);
    expect(registry.activeId).toBeNull();
  });

  it("重复完成只保留既有终态：不二次释放槽，旧操作的迟到收尾不影响新操作", () => {
    const { registry } = setup();
    registry.registerRunning({ operationId: OP_A, target: { kind: "create", mode: "plain" } });
    const first = registry.settle({ operationId: OP_A, requestOutcome: "returned" });
    registry.registerRunning({ operationId: OP_B, target: { kind: "create", mode: "plain" } });
    const versionBefore = registry.registryVersion;
    const repeated = registry.settle({ operationId: OP_A, requestOutcome: "failed" });
    expect(repeated).toEqual(first);
    expect(repeated.requestOutcome).toBe("returned");
    expect(snapshotOf(registry).activeOperationId).toBe(OP_B);
    expect(registry.registryVersion).toBe(versionBefore);
  });
});
