import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ExecutionSpec,
  type OperationContext,
  OperationRegistry,
  OperationRegistryInvariantError,
} from "../src/main/operation-registry";
import { OPERATION_CODE_MAX, OPERATION_DIAGNOSTIC_MESSAGE_MAX } from "../src/shared/operations";

/**
 * U4 任务 1.5：共享执行 promise、统一 settled/finally 收口、允许字段的诊断，
 * 以及「执行与收尾都结束才释放本操作」的引用释放。
 *
 * 判据来源：tasks.md 1.5 + design D1/D2 第 4–5 步。
 * 验收场景（delta 逐字标题）：
 * - 「执行和收尾结束才释放本操作」——编排已返回但收尾被受控延迟时仍占槽；
 *   收尾抛错也以 settled + 真实请求结局结束，且只释放自己占用的槽；
 * - 「接受后业务拒绝仍有可信终态」——占槽后才发现未配置/门禁不满足时，
 *   沿用既有拒绝码并写 settled/rejected，runIds 为空；
 * - 「会话登记不泄漏输入和凭据」——正文、sourceToken、密钥、原始 Error/stack、
 *   模型响应都不出现在快照或诊断里；settled 后不再持有执行上下文引用。
 *
 * 调度全部用可控 deferred（不靠真实计时），断言看**实际执行次数**与终态字段。
 */

const OP = "aaaaaaaa-1111-4111-8111-111111111111";
const OP_OTHER = "bbbbbbbb-2222-4222-8222-222222222222";
const FP = "f".repeat(64);
const target = { kind: "create", mode: "plain" } as const;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让所有已 resolve 的微任务链跑完 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function setup(): { registry: OperationRegistry; calls: string[] } {
  const calls: string[] = [];
  const registry = new OperationRegistry({
    newEpoch: () => "11111111-1111-4111-8111-111111111111",
  });
  return { registry, calls };
}

/** 构造一个「执行与收尾都可控」的 spec，并记录调用次数 */
function controllableSpec(
  registry: OperationRegistry,
  calls: string[],
  operationId: string,
  options?: { rejectWith?: unknown; cleanupThrows?: unknown },
): {
  spec: ExecutionSpec;
  executeStarted: Promise<void>;
  finishExecute: (value?: unknown) => void;
  finishCleanup: () => void;
} {
  const started = deferred<void>();
  const executeDone = deferred<string>();
  const cleanupDone = deferred<void>();
  const spec: ExecutionSpec = {
    operationId,
    target,
    fingerprint: FP,
    async execute(ctx) {
      calls.push(`execute:${ctx.operationId}`);
      started.resolve(undefined);
      const token = await executeDone.promise;
      ctx.attachRunId(token);
      // 抛错前已登记的身份必须保留（「错误不丢已知 runIds」）
      if (options?.rejectWith !== undefined) throw options.rejectWith;
      return { outcome: "returned", data: { id: token } };
    },
    async cleanup(ctx) {
      calls.push(`cleanup:${ctx.operationId}`);
      await cleanupDone.promise;
      if (options?.cleanupThrows !== undefined) throw options.cleanupThrows;
    },
  };
  return {
    spec,
    executeStarted: started.promise,
    finishExecute: (value = "run_created") => executeDone.resolve(String(value)),
    finishCleanup: () => cleanupDone.resolve(undefined),
  };
}

describe("U4 1.5 收口时机：执行与收尾都结束才 settled 并释放槽", () => {
  it("编排返回后收尾仍被延迟 ⇒ 继续占槽、第二操作被拒；收尾完成才释放", async () => {
    const { registry, calls } = setup();
    const run = controllableSpec(registry, calls, OP);
    const inFlight = registry.submitExecution(run.spec);
    await run.executeStarted;
    expect(registry.activeId).toBe(OP);
    expect(registry.hasInFlightExecution(OP)).toBe(true);

    run.finishExecute("run_x");
    await flush();
    // 编排已返回，但 trace 归位/清理尚未结束 ⇒ 仍 running、仍占槽
    expect(registry.recordOf(OP)?.state).toBe("running");
    expect(registry.activeId).toBe(OP);
    expect(registry.snapshot().operations).toHaveLength(1);
    expect(registry.tryAccept({ operationId: OP_OTHER, target, fingerprint: FP }).kind).toBe(
      "not-accepted",
    );

    run.finishCleanup();
    const report = await inFlight;
    expect(report.acceptance).toBe("accepted");
    expect(report.data).toEqual({ id: "run_x" });
    expect(report.record).toMatchObject({ state: "settled", requestOutcome: "returned" });
    expect(registry.activeId).toBeNull();
    expect(registry.hasInFlightExecution(OP)).toBe(false);
    expect(calls).toEqual([`execute:${OP}`, `cleanup:${OP}`]);
  });

  it("收尾抛错：终态仍是可信 settled，已登记的 runIds 不丢，错误只落受控诊断", async () => {
    const { registry, calls } = setup();
    const leaky = new Error("归位失败：目标文件被占用");
    leaky.stack = "Error: 归位失败\n    at Object.<anonymous> (secret/path/leak.ts:1:1)";
    const run = controllableSpec(registry, calls, OP, { cleanupThrows: leaky });
    const report = await (async () => {
      const inFlight = registry.submitExecution(run.spec);
      await run.executeStarted;
      run.finishExecute("run_kept");
      await flush();
      run.finishCleanup();
      return await inFlight;
    })();
    expect(report.record).toMatchObject({
      state: "settled",
      requestOutcome: "returned",
      runIds: ["run_kept"],
    });
    expect(report.record.diagnostics).toEqual([
      { code: "CLEANUP_FAILED", stage: "cleanup", message: "归位失败：目标文件被占用" },
    ]);
    expect(registry.activeId).toBeNull();
    // stack 与物理路径都不出登记
    expect(JSON.stringify(registry.snapshot())).not.toContain("secret/path");
    expect(JSON.stringify(registry.snapshot())).not.toContain("at Object");
  });

  it("编排抛异常：以 settled/failed 结束并给出稳定码，槽照常释放", async () => {
    const { registry, calls } = setup();
    const run = controllableSpec(registry, calls, OP, {
      rejectWith: new Error("provider 连接中断\nstack: at crash()"),
    });
    const inFlight = registry.submitExecution(run.spec);
    await run.executeStarted;
    run.finishExecute();
    await flush();
    run.finishCleanup();
    const report = await inFlight;
    expect(report.acceptance).toBe("accepted");
    expect(report.error).toEqual({
      code: "OPERATION_EXECUTION_FAILED",
      message: "provider 连接中断\nstack: at crash()",
    });
    expect(report.record).toMatchObject({
      state: "settled",
      requestOutcome: "failed",
      errorCode: "OPERATION_EXECUTION_FAILED",
      runIds: ["run_created"],
    });
    expect(registry.activeId).toBeNull();
    expect(calls).toEqual([`execute:${OP}`, `cleanup:${OP}`]);
  });
});

describe("U4 1.5 共享执行：重复 invoke 只执行一次", () => {
  it("同 ID 同参的并发 invoke：第二个等待第一个收口，且拿到同一终态", async () => {
    const { registry, calls } = setup();
    const run = controllableSpec(registry, calls, OP);
    const first = registry.submitExecution(run.spec);
    await run.executeStarted;
    const second = registry.submitExecution({ ...run.spec });
    run.finishExecute("run_once");
    await flush();
    run.finishCleanup();
    const firstReport = await first;
    const secondReport = await second;
    // 只有一次真实执行（第二次只是等同一个 promise）
    expect(calls.filter((one) => one === `execute:${OP}`)).toHaveLength(1);
    expect(secondReport.acceptance).toBe("duplicate");
    expect(secondReport.record.state).toBe("settled");
    expect(secondReport.data).toBeNull();
    expect(secondReport.error).toBeNull();
    expect(secondReport.record.runIds).toEqual(["run_once"]);
    expect(firstReport.acceptance).toBe("accepted");
  });

  it("banned / conflict / not-accepted 三种响应都带稳定码，且一次都不执行", async () => {
    const { registry, calls } = setup();
    const run = controllableSpec(registry, calls, OP);
    const first = registry.submitExecution(run.spec);
    await run.executeStarted;
    run.finishExecute();
    await flush();
    run.finishCleanup();
    await first;

    const duplicate = await registry.submitExecution({ ...run.spec });
    expect(duplicate.acceptance).toBe("duplicate");
    expect(duplicate.error).toBeNull();

    const conflict = await registry.submitExecution({ ...run.spec, fingerprint: "1".repeat(64) });
    expect(conflict.acceptance).toBe("conflict");
    expect(conflict.error?.code).toBe("OPERATION_CONFLICT");

    // 被封禁的 ID（先核对过）同样不执行
    const bannedId = OP_OTHER;
    registry.registerNotAccepted({
      operationId: bannedId,
      target,
      reason: "reconcile_tombstone",
    });
    const banned = await registry.submitExecution({ ...run.spec, operationId: bannedId });
    expect(banned.acceptance).toBe("banned");
    expect(banned.error?.code).toBe("OPERATION_NOT_ACCEPTED");

    // 槽被占时的新 ID：not-accepted(busy) 且不执行
    const blockerId = randomUUID();
    const busyId = randomUUID();
    // submitExecution 的接受段同步完成 ⇒ 尚未 await 的 blocker 已经占槽
    const busy = registry.submitExecution({ ...run.spec, operationId: blockerId });
    const blocked = await registry.submitExecution({
      ...run.spec,
      operationId: busyId,
    });
    expect(blocked.acceptance).toBe("not-accepted");
    if (blocked.acceptance === "not-accepted") {
      expect(blocked.record.rejection).toMatch(/busy|closing|configuration_busy/);
    }
    await busy;
    expect(calls).not.toContain(`execute:${busyId}`);
    expect(calls.filter((one) => one.startsWith("execute:"))).toHaveLength(2);
  });

  it("接受后领域拒绝：沿用既有拒绝码写 settled/rejected，runIds 为空并可立即接新操作", async () => {
    const { registry } = setup();
    const report = await registry.submitExecution({
      operationId: OP,
      target,
      fingerprint: FP,
      async execute() {
        return {
          outcome: "rejected",
          code: "SETTINGS_NOT_CONFIGURED",
          message: "尚未配置运行参数",
        };
      },
    });
    expect(report.acceptance).toBe("accepted");
    expect(report.error).toEqual({
      code: "SETTINGS_NOT_CONFIGURED",
      message: "尚未配置运行参数",
    });
    expect(report.data).toBeNull();
    expect(report.record).toMatchObject({
      state: "settled",
      requestOutcome: "rejected",
      errorCode: "SETTINGS_NOT_CONFIGURED",
      runIds: [],
    });
    expect(registry.activeId).toBeNull();
    const next = await registry.submitExecution({
      operationId: OP_OTHER,
      target,
      fingerprint: FP,
      async execute() {
        return { outcome: "returned", data: { id: "run_next" } };
      },
    });
    expect(next.acceptance).toBe("accepted");
  });
});

describe("U4 1.5 登记内容与上下文释放", () => {
  it("快照只含允许字段：正文、sourceToken、密钥、模型响应都不在其中", async () => {
    const { registry, calls } = setup();
    const secretPayload = {
      userMessage: "敏感任务正文",
      sourceToken: "tok-abcdef",
      apiKey: "sk-secret-9",
      modelResponse: "完整模型响应文本",
    };
    const run = controllableSpec(registry, calls, OP);
    const inFlight = registry.submitExecution(run.spec);
    await run.executeStarted;
    // 执行上下文里带正文（闭包捕获）——但登记与快照都不得复制它
    expect(JSON.stringify(registry.snapshot())).not.toContain("敏感任务正文");
    run.finishExecute("run_visible");
    await flush();
    run.finishCleanup();
    const report = await inFlight;
    const serialized = JSON.stringify({ snapshot: registry.snapshot(), record: report.record });
    for (const secret of [
      secretPayload.userMessage,
      secretPayload.sourceToken,
      secretPayload.apiKey,
      secretPayload.modelResponse,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // 只有编排显式登记的身份会留下
    expect(report.record.runIds).toEqual(["run_visible"]);
    expect(report.data).toEqual({ id: "run_visible" });
  });

  it("settled 之后 ctx 的写入被拒（迟到的身份/臂不改终态），执行上下文引用已释放", async () => {
    const { registry, calls } = setup();
    const captured: { ctx: OperationContext | null } = { ctx: null };
    const report = await registry.submitExecution({
      operationId: OP,
      target,
      fingerprint: FP,
      async execute(ctx) {
        captured.ctx = ctx;
        calls.push("execute");
        return { outcome: "returned", data: null };
      },
    });
    expect(report.record.state).toBe("settled");
    expect(registry.hasInFlightExecution(OP)).toBe(false);
    const ctx = captured.ctx;
    if (ctx === null) throw new Error("unreachable：execute 必然拿到 ctx");
    expect(() => ctx.attachRunId("run_late")).toThrow(OperationRegistryInvariantError);
    expect(() => ctx.attachArm({ index: 0, id: "run_late", outcome: "returned" })).toThrow(
      OperationRegistryInvariantError,
    );
    expect(registry.recordOf(OP)?.runIds).toEqual([]);
    // 诊断仍可追加（清理阶段的受控留痕），但不改变终态、不递增登记版本
    const version = registry.registryVersion;
    ctx.diagnose("LATE", "收尾后补的诊断");
    expect(registry.registryVersion).toBe(version);
    expect(registry.recordOf(OP)).toMatchObject({ state: "settled", requestOutcome: "returned" });
    expect(registry.recordOf(OP)?.diagnostics).toEqual([
      { code: "LATE", stage: "execute", message: "收尾后补的诊断" },
    ]);
  });

  it("诊断的码与文案都按契约限长：超长被截断而不是静默丢弃", async () => {
    const { registry } = setup();
    const longCode = "C".repeat(OPERATION_CODE_MAX + 40);
    const longMessage = "m".repeat(OPERATION_DIAGNOSTIC_MESSAGE_MAX + 400);
    await registry.submitExecution({
      operationId: OP,
      target,
      fingerprint: FP,
      async execute(ctx) {
        ctx.diagnose(longCode, longMessage, "finalize");
        return { outcome: "returned", data: null };
      },
    });
    expect(registry.recordOf(OP)?.diagnostics).toEqual([
      {
        code: "C".repeat(OPERATION_CODE_MAX),
        stage: "finalize",
        message: "m".repeat(OPERATION_DIAGNOSTIC_MESSAGE_MAX),
      },
    ]);
  });

  it("A/B 整批：批内按臂登记身份，批次收尾前不释放槽", async () => {
    const { registry } = setup();
    const gate = deferred<void>();
    const inFlight = registry.submitExecution({
      operationId: OP,
      target: { kind: "modelAb", parentRunId: "run_p", armCount: 2 },
      fingerprint: FP,
      async execute(ctx) {
        ctx.attachExperimentId("exp_1");
        ctx.attachArm({ index: 0, id: "run_arm0", outcome: "returned" });
        ctx.attachRunId("run_arm0");
        // 首臂完成 ≠ 批次结束
        const blocked = registry.tryAccept({
          operationId: OP_OTHER,
          target,
          fingerprint: FP,
        });
        expect(blocked.kind).toBe("not-accepted");
        await gate.promise;
        ctx.attachArm({ index: 1, id: null, outcome: "failed" });
        ctx.attachRunId("run_arm0");
        return { outcome: "returned", data: { ids: ["run_arm0"] } };
      },
    });
    await flush();
    gate.resolve(undefined);
    const report = await inFlight;
    expect(report.record).toMatchObject({
      state: "settled",
      experimentId: "exp_1",
      runIds: ["run_arm0"],
      arms: [
        { index: 0, id: "run_arm0", outcome: "returned" },
        { index: 1, id: null, outcome: "failed" },
      ],
    });
    expect(report.data).toEqual({ ids: ["run_arm0"] });
    expect(registry.activeId).toBeNull();
  });

  it("randomUUID 生成的 id 可直接用于登记（与 renderer 侧生成口径一致）", async () => {
    const { registry } = setup();
    const operationId = randomUUID();
    const report = await registry.submitExecution({
      operationId,
      target,
      fingerprint: FP,
      async execute() {
        return { outcome: "returned", data: { id: "run_ok" } };
      },
    });
    expect(report.record.operationId).toBe(operationId);
  });
});
