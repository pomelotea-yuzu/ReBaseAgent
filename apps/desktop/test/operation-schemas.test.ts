import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ForkRunResultSchema } from "../src/shared/ipc";
import {
  ExecutionEnvelopeSchema,
  OPERATION_DIAGNOSTIC_MAX,
  OPERATION_DIAGNOSTIC_MESSAGE_MAX,
  OPERATION_ERROR,
  type OperationArmSummary,
  type OperationRecord,
  OperationRecordSchema,
  OperationStatusResultSchema,
  OperationTargetSchema,
  ReconcileRequestSchema,
  ReconcileResultSchema,
  executedResponseSchema,
  findSlotStateViolation,
} from "../src/shared/operations";

/**
 * U4 任务 1.1：执行 envelope、操作判别联合、目标/臂摘要与快照 schema。
 *
 * 判据来源：tasks.md 1.1 + design D1/D2/D4。
 * 验收场景（delta 逐字标题）：
 * - 「七类主动入口均绑定身份」——envelope 强制 epoch/operationId 为 UUID，
 *   形状不合（缺身份 / 平铺业务字段 / 非 UUID）在契约层即拒；
 * - 「非法操作响应不能解除门禁」——状态联合、摘要一致性、槽引用都写成 schema 精炼，
 *   所以 renderer 只需 `safeParse` 就能拒绝错误状态联合、非法 runIds、错配 epoch
 *   与不自洽槽引用，不会部分采纳所谓成功字段。
 *
 * 本组只测 shared 契约本身；registry 的行为在 1.2–1.7，IPC/渲染接线在 3.x/4.x。
 */

const EPOCH = randomUUID();
const OP = randomUUID();
const OP_B = randomUUID();
const T0 = "2026-09-26T08:00:00.000Z";
const T1 = "2026-09-26T08:00:09.000Z";

function record(over: Partial<OperationRecord> = {}): OperationRecord {
  return {
    epoch: EPOCH,
    operationId: OP,
    target: { kind: "create", mode: "plain" },
    state: "running",
    rejection: null,
    startedAt: T0,
    settledAt: null,
    runIds: [],
    experimentId: null,
    arms: [],
    requestOutcome: null,
    errorCode: null,
    diagnostics: [],
    ...over,
  } as OperationRecord;
}

function settled(over: Partial<OperationRecord> = {}): OperationRecord {
  return record({ state: "settled", settledAt: T1, requestOutcome: "returned", ...over });
}

function status(operations: OperationRecord[], activeOperationId: string | null = null) {
  return { ...slotState({ activeOperationId }), operations };
}

function slotState(over: Record<string, unknown> = {}) {
  return {
    epoch: EPOCH,
    registryVersion: 1,
    activeOperationId: null,
    closing: false,
    configurationBusy: false,
    ...over,
  };
}

describe("U4 1.1 执行 envelope：身份是主动入口的强制项", () => {
  it("合法 {operation:{epoch,operationId}, request} 通过，且 request 原样为未知形状", () => {
    const parsed = ExecutionEnvelopeSchema.safeParse({
      operation: { epoch: EPOCH, operationId: OP },
      request: { parentRunId: "run_a", atSpanId: "span_b", edit: { field: "result", value: "x" } },
    });
    expect(parsed.success).toBe(true);
  });

  it("缺身份、非 UUID、身份内多余字段一律拒绝（不留无身份后门的形状）", () => {
    const request = { parentRunId: "run_a" };
    const bad: unknown[] = [
      { request },
      { operation: { epoch: EPOCH }, request },
      { operation: { epoch: EPOCH, operationId: "op-1" }, request },
      { operation: { epoch: "not-a-uuid", operationId: OP }, request },
      { operation: { epoch: EPOCH, operationId: OP, rendererTab: "detail" }, request },
    ];
    for (const payload of bad) {
      expect(ExecutionEnvelopeSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(
        false,
      );
    }
  });

  it("业务字段平铺到顶层（不带 operation）被拒；envelope 的未知顶层键同样被拒", () => {
    expect(
      ExecutionEnvelopeSchema.safeParse({
        epoch: EPOCH,
        operationId: OP,
        parentRunId: "run_a",
      }).success,
    ).toBe(false);
    expect(
      ExecutionEnvelopeSchema.safeParse({
        operation: { epoch: EPOCH, operationId: OP },
        request: { a: 1 },
        draftRevision: 3,
      }).success,
    ).toBe(false);
  });

  it("operationId 超长度上限被拒（有界载荷）", () => {
    expect(
      ExecutionEnvelopeSchema.safeParse({
        operation: { epoch: EPOCH, operationId: "x".repeat(200) },
        request: {},
      }).success,
    ).toBe(false);
  });
});

describe("U4 1.1 目标摘要：七类入口可表达，正文与授权值无处可放", () => {
  it("五种 kind（create/result 各含普通与隔离 = 七类主动入口）均可表达", () => {
    const targets: unknown[] = [
      { kind: "create", mode: "plain" },
      { kind: "create", mode: "isolated" },
      { kind: "result", mode: "plain", parentRunId: "run_a", atSpanId: "s1", editField: "result" },
      {
        kind: "result",
        mode: "isolated",
        parentRunId: "run_a",
        atSpanId: "s1",
        editField: "result",
      },
      { kind: "prompt", parentRunId: "run_a", editField: "user_message" },
      { kind: "proxy", parentRunId: "run_a", atSpanId: "s1" },
      { kind: "modelAb", parentRunId: "run_a", armCount: 2 },
    ];
    for (const target of targets) {
      expect(OperationTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(true);
    }
  });

  it("未知 kind 与缺定位字段被拒", () => {
    expect(OperationTargetSchema.safeParse({ kind: "dryRun", armCount: 2 }).success).toBe(false);
    expect(
      OperationTargetSchema.safeParse({ kind: "prompt", editField: "user_message" }).success,
    ).toBe(false);
  });

  it("摘要里放正文/授权值/凭据（edit value、messages、sourceToken、apiKey）⇒ strict 拒绝", () => {
    const leaky: unknown[] = [
      { kind: "create", mode: "isolated", sourceToken: "tok" },
      { kind: "create", mode: "isolated", allowFileWrites: true },
      { kind: "create", mode: "plain", userMessage: "跑一次" },
      {
        kind: "result",
        mode: "plain",
        parentRunId: "run_a",
        atSpanId: "s1",
        editField: "result",
        editValue: "被改写过的工具结果",
      },
      { kind: "prompt", parentRunId: "run_a", editField: "user_message", value: "新 prompt" },
      { kind: "proxy", parentRunId: "run_a", atSpanId: "s1", messages: [{ role: "user" }] },
      { kind: "modelAb", parentRunId: "run_a", armCount: 2, apiKey: "sk-..." },
    ];
    for (const target of leaky) {
      expect(OperationTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(false);
    }
  });

  it("臂摘要：未开始的臂 id/结局为 null；非 modelAb 不得携带臂或 experimentId", () => {
    const arms: OperationArmSummary[] = [
      { index: 0, id: "run_arm0", outcome: "returned" },
      { index: 1, id: null, outcome: null },
    ];
    const ab = record({
      target: { kind: "modelAb", parentRunId: "run_a", armCount: 2 },
      experimentId: "exp_1",
      arms,
      state: "settled",
      settledAt: T1,
      requestOutcome: "returned",
      runIds: ["run_arm0"],
    });
    expect(OperationRecordSchema.safeParse(ab).success).toBe(true);
    expect(OperationRecordSchema.safeParse(record({ arms })).success).toBe(false);
    expect(OperationRecordSchema.safeParse(record({ experimentId: "exp_1" })).success).toBe(false);
    expect(
      OperationRecordSchema.safeParse(
        record({
          arms: [
            { index: 0, id: null, outcome: null },
            { index: 0, id: null, outcome: null },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("armCount < 2（桌面 A/B 的下界）与非法 runIds（重复）被拒", () => {
    expect(
      OperationTargetSchema.safeParse({ kind: "modelAb", parentRunId: "run_a", armCount: 1 })
        .success,
    ).toBe(false);
    expect(OperationRecordSchema.safeParse(record({ runIds: ["r", "r"] })).success).toBe(false);
  });
});

describe("U4 1.1 状态联合：running/settled/notAccepted 各自只允许该有的字段", () => {
  it("正例：running、settled 的三种请求结局、notAccepted 的三种拒绝、reconcile tombstone", () => {
    expect(OperationRecordSchema.safeParse(record()).success).toBe(true);
    for (const outcome of ["returned", "failed", "rejected"] as const) {
      expect(
        OperationRecordSchema.safeParse(
          settled({
            requestOutcome: outcome,
            errorCode: outcome === "returned" ? null : "SETTINGS_NOT_CONFIGURED",
          }),
        ).success,
      ).toBe(true);
    }
    for (const reason of ["busy", "closing", "configuration_busy"] as const) {
      expect(
        OperationRecordSchema.safeParse(
          record({
            state: "notAccepted",
            rejection: reason,
            startedAt: null,
          }),
        ).success,
      ).toBe(true);
    }
    expect(
      OperationRecordSchema.safeParse(
        record({
          state: "notAccepted",
          rejection: "reconcile_tombstone",
          target: null,
          startedAt: null,
        }),
      ).success,
    ).toBe(true);
  });

  it("反例：running 带终态、settled 缺时间/结局、notAccepted 带执行事实或运行身份", () => {
    const bad: OperationRecord[] = [
      record({ settledAt: T1 }),
      record({ requestOutcome: "returned" }),
      record({ errorCode: "X" }),
      record({ rejection: "busy" }),
      settled({ settledAt: null }),
      settled({ startedAt: null }),
      settled({ requestOutcome: null }),
      settled({ rejection: "busy" }),
      settled({ requestOutcome: "returned", errorCode: "X" }),
      settled({ requestOutcome: "rejected", errorCode: null }),
      record({ state: "notAccepted", rejection: "busy", startedAt: T0 }),
      record({ state: "notAccepted", rejection: "busy", runIds: ["run_a"] }),
      record({ state: "notAccepted", rejection: null, startedAt: null }),
    ];
    for (const payload of bad) {
      expect(OperationRecordSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
    }
  });

  it("target 为 null 只能配 reconcile_tombstone；已知目标不得自称封禁；tombstone 不得伪造时间/身份", () => {
    expect(
      OperationRecordSchema.safeParse(
        record({ target: null, state: "settled", settledAt: T1, requestOutcome: "returned" }),
      ).success,
    ).toBe(false);
    expect(
      OperationRecordSchema.safeParse(
        record({ target: null, state: "notAccepted", rejection: "busy", startedAt: null }),
      ).success,
    ).toBe(false);
    expect(
      OperationRecordSchema.safeParse(
        record({
          state: "notAccepted",
          rejection: "reconcile_tombstone",
          target: null,
          startedAt: null,
          settledAt: T1,
        }),
      ).success,
    ).toBe(false);
  });

  it("登记不泄漏输入与凭据：多一个正文字段即非法；诊断有码/阶段/限长", () => {
    expect(OperationRecordSchema.safeParse({ ...record(), task: "敏感任务正文" }).success).toBe(
      false,
    );
    expect(
      OperationRecordSchema.safeParse({
        ...settled(),
        diagnostics: [{ code: "RECORDER_WRITE_FAILED", stage: "finalize", message: "写入失败" }],
      }),
    ).toMatchObject({ success: true });
    expect(
      OperationRecordSchema.safeParse({
        ...settled(),
        diagnostics: [{ code: "X", stage: "whatever", message: "m" }],
      }).success,
    ).toBe(false);
    expect(
      OperationRecordSchema.safeParse({
        ...settled(),
        diagnostics: [{ code: "X", stage: "execute", message: "e".repeat(600), stack: "at ..." }],
      }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: OPERATION_DIAGNOSTIC_MAX + 1 }, () => ({
      code: "X",
      stage: "execute" as const,
      message: "m",
    }));
    expect(OperationRecordSchema.safeParse({ ...settled(), diagnostics: tooMany }).success).toBe(
      false,
    );
    expect(
      OperationRecordSchema.safeParse({
        ...settled(),
        diagnostics: [
          {
            code: "X",
            stage: "execute" as const,
            message: "e".repeat(OPERATION_DIAGNOSTIC_MESSAGE_MAX),
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("U4 1.1 status 快照：一次序列化必须自洽且含终态/封禁", () => {
  it("正例：空槽快照、单条 running 指向自己、settled 与 notAccepted 留在快照中", () => {
    expect(OperationStatusResultSchema.safeParse(status([])).success).toBe(true);
    expect(OperationStatusResultSchema.safeParse(status([record()], OP)).success).toBe(true);
    const snapshot = status([
      settled({ runIds: ["run_x"] }),
      record({ operationId: OP_B, state: "notAccepted", rejection: "busy", startedAt: null }),
    ]);
    expect(OperationStatusResultSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.operations.map((one) => one.state)).toEqual(["settled", "notAccepted"]);
  });

  it("反例：槽指向不存在/非 running 的操作、两个 running、跨 epoch、operationId 重复", () => {
    const bad: unknown[] = [
      status([record()], null),
      status([record()], OP_B),
      status([settled()], OP),
      status([record(), record({ operationId: OP_B })], OP),
      status([record({ epoch: randomUUID() })], null),
      status([record(), record()], null),
      status([record()], "not-a-uuid"),
      { ...status([record()], OP), registryVersion: 0 },
    ];
    for (const payload of bad) {
      expect(OperationStatusResultSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(
        false,
      );
    }
  });

  it("非法 epoch/版本与未知顶层字段不能进入快照（renderer 不部分采纳）", () => {
    expect(OperationStatusResultSchema.safeParse({ ...status([]), epoch: "x" }).success).toBe(
      false,
    );
    expect(
      OperationStatusResultSchema.safeParse({ ...status([]), registryVersion: 0 }).success,
    ).toBe(false);
    expect(
      OperationStatusResultSchema.safeParse({ ...status([]), activeOperation: "run_a" }).success,
    ).toBe(false);
  });

  it("findSlotStateViolation 与 schema 同判据（供接线侧复用，不另立口径）", () => {
    expect(findSlotStateViolation(status([]), [])).toBeNull();
    expect(findSlotStateViolation({ ...status([]), activeOperationId: OP }, [])).toBe(
      "activeOperationId 指向不存在的操作",
    );
    expect(findSlotStateViolation(status([record()], OP), [record()])).toBeNull();
  });
});

describe("U4 1.1 reconcile 结果与执行响应：锁由全局槽派生，不由被查操作派生", () => {
  it("核对已 settled 的 A，而 B 在跑 ⇒ 合法（A 不解锁，快照仍指向 B）", () => {
    const result = {
      ...slotState({ registryVersion: 7, activeOperationId: OP_B }),
      operation: settled({ runIds: ["run_a"] }),
    };
    expect(ReconcileResultSchema.safeParse(result).success).toBe(true);
  });

  it("反例：被查操作 running 却不占槽、槽指向非 running、被查操作属其他 epoch", () => {
    const bad: unknown[] = [
      { ...slotState({ activeOperationId: OP_B }), operation: record() },
      { ...slotState({ activeOperationId: OP }), operation: settled() },
      { ...slotState(), operation: record({ epoch: randomUUID() }) },
      // reconcile 结果不带 operations 列表，也不接受任何业务输入字段
      { ...slotState(), operation: record(), operations: [] },
      { ...slotState(), operation: record(), userMessage: "敏感正文" },
    ];
    for (const payload of bad) {
      expect(ReconcileResultSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
    }
  });

  it("被查操作确实占槽 ⇒ 合法；请求侧只有身份", () => {
    expect(
      ReconcileResultSchema.safeParse({
        ...slotState({ activeOperationId: OP }),
        operation: record(),
      }).success,
    ).toBe(true);
    expect(ReconcileRequestSchema.safeParse({ epoch: EPOCH, operationId: OP }).success).toBe(true);
    expect(
      ReconcileRequestSchema.safeParse({
        epoch: EPOCH,
        operationId: OP,
        request: { parentRunId: "run_a" },
      }).success,
    ).toBe(false);
  });

  it("执行响应两个分支都带登记回执；回执非法或结果走样都不能通过", () => {
    const schema = executedResponseSchema(ForkRunResultSchema);
    const ack = { epoch: EPOCH, operationId: OP, registryVersion: 3, state: "running" };
    expect(schema.safeParse({ ok: true, operation: ack, data: { id: "run_new" } }).success).toBe(
      true,
    );
    // 业务拒绝也带回执：renderer 按「身份 + 登记版本 + 状态」解冻，而不是把裸 fail 当结论
    expect(
      schema.safeParse({
        ok: false,
        operation: { ...ack, state: "settled" },
        error: { code: "FORK_FAILED", message: "父 run 未封存" },
      }).success,
    ).toBe(true);
    // 只有"接受之前"的拒绝（sender / 形状 / 旧 epoch）才允许回执为 null
    expect(
      schema.safeParse({
        ok: false,
        operation: null,
        error: { code: OPERATION_ERROR.staleEpoch, message: "旧 main 会话" },
      }).success,
    ).toBe(true);
    const bad: unknown[] = [
      { ok: true, data: { id: "run_new" } },
      { ok: true, operation: { ...ack, registryVersion: 0 }, data: { id: "run_new" } },
      { ok: true, operation: { ...ack, state: "done" }, data: { id: "run_new" } },
      { ok: true, operation: { ...ack, epoch: "not-a-uuid" }, data: { id: "run_new" } },
      { ok: true, operation: ack, data: {} },
      { ok: true, operation: ack, data: { id: "run_new" }, retried: true },
      { ok: false, operation: ack },
      { ok: false, error: { code: "X", message: "m" } },
      { ok: false, operation: ack, error: { code: "X", message: "m", zodIssues: [] } },
      { ok: false, operation: ack, error: { code: "X" } },
    ];
    for (const payload of bad) {
      expect(schema.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
    }
  });
});
