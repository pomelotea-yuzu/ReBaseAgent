import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { reconcileOperation } from "../src/main/operation-endpoints";
import type { TrustedSender } from "../src/main/operation-endpoints";
import {
  type ExecutionReport,
  type ExecutionSpec,
  OperationRegistry,
} from "../src/main/operation-registry";
import { RequestFingerprinter, parseBusinessRequest } from "../src/main/operation-request";
import type { ChannelName } from "../src/shared/channels";
import { CHANNELS } from "../src/shared/channels";
import {
  CreateRunRequestSchema,
  ForkRunRequestSchema,
  ModelAbRequestSchema,
  PromptForkRequestSchema,
  ProxyForkRequestSchema,
} from "../src/shared/ipc";
import type { OperationRecord, OperationTarget } from "../src/shared/operations";
import { OperationStatusResultSchema, findSlotStateViolation } from "../src/shared/operations";
import { deferred, flush } from "./helpers/deterministic-schedule";

/**
 * U4 任务 1.7：registry 竞争的**可控调度**测试（顺序反转、重复完成、跨入口并发）。
 *
 * 判据来源：tasks.md 1.7 + design D2/D3/D4。
 * 验收场景（delta 逐字标题）：
 * - 「不同入口并发只有一个被接受」——七类主动入口两两交错，同轮事件循环内只有一个 accepted；
 * - 「旧操作收尾不能释放新操作」——A 的重复完成、迟到 reconcile、duplicate 提交都不动 B 的槽；
 * - 「核对旧操作不解除另一操作的锁」——B 占槽时核对 A，快照仍指向 B。
 *
 * 时序全部由 deferred 门禁显式驱动（不用真实计时），断言看**实际执行次数**、
 * 登记版本单调性与快照自洽；七类入口的指纹来自真实业务 schema 的一次解析（1.3 口径），
 * 不是手填字符串。
 */

const SECRET = Buffer.alloc(32, 11);
const fingerprinter = new RequestFingerprinter(SECRET);
const SENDER: TrustedSender = { webContentsId: 1, frameRoutingId: 100 };

/** 七类主动入口的标签（create/result 各含普通与隔离） */
type EntryLabel =
  | "createPlain"
  | "createIsolated"
  | "resultPlain"
  | "resultIsolated"
  | "prompt"
  | "proxy"
  | "modelAb";

const ENTRY_LABELS: EntryLabel[] = [
  "createPlain",
  "createIsolated",
  "resultPlain",
  "resultIsolated",
  "prompt",
  "proxy",
  "modelAb",
];

interface Entry {
  readonly channel: ChannelName;
  readonly target: OperationTarget;
  readonly fingerprint: string;
}

function buildEntry(
  channel: ChannelName,
  schema: z.ZodType<unknown>,
  payload: unknown,
  target: OperationTarget,
): Entry {
  const parsed = parseBusinessRequest(fingerprinter, channel, schema, payload);
  if (!parsed.ok) throw new Error(`入口夹具应合法：${parsed.message}`);
  return { channel, target, fingerprint: parsed.request.fingerprint };
}

/** 七类主动入口（create/result 各含普通与隔离）的合法请求夹具 */
const ENTRIES: Record<EntryLabel, Entry> = {
  createPlain: buildEntry(
    CHANNELS.createRun,
    CreateRunRequestSchema,
    { systemPrompt: "", userMessage: "任务正文" },
    { kind: "create", mode: "plain" },
  ),
  createIsolated: buildEntry(
    CHANNELS.createRun,
    CreateRunRequestSchema,
    {
      systemPrompt: "",
      userMessage: "任务正文",
      workspace: { mode: "isolated_files", sourceToken: "tok_1", allowFileWrites: true },
    },
    { kind: "create", mode: "isolated" },
  ),
  resultPlain: buildEntry(
    CHANNELS.forkRun,
    ForkRunRequestSchema,
    { parentRunId: "run_p", atSpanId: "s_1", edit: { field: "result", value: "改后结果" } },
    { kind: "result", mode: "plain", parentRunId: "run_p", atSpanId: "s_1", editField: "result" },
  ),
  resultIsolated: buildEntry(
    CHANNELS.forkRun,
    ForkRunRequestSchema,
    {
      parentRunId: "run_p",
      atSpanId: "s_1",
      edit: { field: "result", value: "改后结果" },
      execution: { mode: "isolated_files", allowFileWrites: true },
    },
    {
      kind: "result",
      mode: "isolated",
      parentRunId: "run_p",
      atSpanId: "s_1",
      editField: "result",
    },
  ),
  prompt: buildEntry(
    CHANNELS.promptFork,
    PromptForkRequestSchema,
    { parentRunId: "run_p", edit: { field: "user_message", value: "新 prompt" } },
    { kind: "prompt", parentRunId: "run_p", editField: "user_message" },
  ),
  proxy: buildEntry(
    CHANNELS.proxyFork,
    ProxyForkRequestSchema,
    {
      parentRunId: "run_p",
      atSpanId: "s_1",
      messages: [{ role: "user", content: "重发的 messages" }],
    },
    { kind: "proxy", parentRunId: "run_p", atSpanId: "s_1" },
  ),
  modelAb: buildEntry(
    CHANNELS.modelAb,
    ModelAbRequestSchema,
    {
      parentRunId: "run_p",
      arms: [{ model: "a" }, { model: "b" }],
    },
    { kind: "modelAb", parentRunId: "run_p", armCount: 2 },
  ),
};

function setup(): {
  registry: OperationRegistry;
  calls: string[];
  /** 发起提交：接受判定在同步段完成；`entered` 表示编排真的开始执行了 */
  start: (
    label: EntryLabel,
    operationId: string,
  ) => {
    report: Promise<ExecutionReport>;
    entered: Promise<void>;
    release: () => void;
  };
  reconcile: (operationId: string) => OperationRecord | null;
  status: () => ReturnType<OperationRegistry["snapshot"]>;
} {
  const registry = new OperationRegistry();
  const calls: string[] = [];
  return {
    registry,
    calls,
    start: (label, operationId) => {
      const entry = ENTRIES[label];
      const gate = deferred<void>();
      let enteredResolve!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      const spec: ExecutionSpec = {
        operationId,
        target: entry.target,
        fingerprint: entry.fingerprint,
        async execute(ctx) {
          calls.push(`execute:${label}`);
          enteredResolve();
          await gate.promise;
          ctx.attachRunId(`run_${label}`);
          return { outcome: "returned", data: { id: `run_${label}` } };
        },
      };
      const report = registry.submitExecution(spec);
      return { report, entered, release: () => gate.resolve(undefined) };
    },
    reconcile: (operationId) => {
      const envelope = reconcileOperation({ registry, isTrustedSender: () => true }, SENDER, {
        epoch: registry.epoch,
        operationId,
      });
      if (!envelope.ok) return null;
      return envelope.data.operation;
    },
    status: () => {
      const snapshot = registry.snapshot();
      // 每一步都过一遍自洽判据（快照不自洽时 snapshot() 自身已抛）
      expect(OperationStatusResultSchema.safeParse(snapshot).success).toBe(true);
      return snapshot;
    },
  };
}

/** 跑完一次提交并放行（返回终态 report） */
async function complete(handle: {
  report: Promise<ExecutionReport>;
  entered: Promise<void>;
  release: () => void;
}): Promise<ExecutionReport> {
  handle.release();
  return await handle.report;
}

describe("U4 1.7 跨入口并发：同轮事件循环只有一个被接受", () => {
  it("七类入口轮流抢位：赢家占槽执行，其余 notAccepted 且此后永不自动执行", async () => {
    const labels = ENTRY_LABELS;
    for (const winner of labels) {
      const { registry, calls, start } = setup();
      // 让 winner 排在提交顺序的第一位 ⇒ 每个入口都当一次「先到者」
      const order = [winner, ...labels.filter((one) => one !== winner)];
      const submissions = order.map((label) => ({ label, operationId: randomUUID() }));
      const handles = submissions.map((one) => ({
        ...one,
        handle: start(one.label, one.operationId),
      }));
      const [first] = handles;
      if (first === undefined) throw new Error("unreachable：order 非空");
      first.handle.release();
      const reports = await Promise.all(handles.map((one) => one.handle.report));
      expect(reports.map((one) => one.acceptance)).toEqual([
        "accepted",
        ...order.slice(1).map(() => "not-accepted"),
      ]);
      expect(reports[1]?.record.rejection).toBe("busy");
      await first.handle.report;
      expect(calls).toEqual([`execute:${first.label}`]);

      // 被拒的 ID 永久封禁：槽已空后重放同一 ID 依然是 banned，不会自动执行
      for (const loser of handles.slice(1)) {
        const replay = await registry.submitExecution({
          operationId: loser.operationId,
          target: ENTRIES[loser.label].target,
          fingerprint: ENTRIES[loser.label].fingerprint,
          async execute(ctx) {
            calls.push(`execute:${loser.label}`);
            ctx.attachRunId(`run_${loser.label}`);
            return { outcome: "returned", data: null };
          },
        });
        expect(replay.acceptance).toBe("banned");
      }
      expect(calls).toEqual([`execute:${first.label}`]);
      expect(registry.activeId).toBeNull();
      // 用户要用新 ID 才能重新发起
      const retry = await registry.submitExecution({
        operationId: randomUUID(),
        target: ENTRIES[first.label].target,
        fingerprint: ENTRIES[first.label].fingerprint,
        async execute(ctx) {
          calls.push(`execute:${first.label}:retry`);
          ctx.attachRunId("run_retry");
          return { outcome: "returned", data: null };
        },
      });
      expect(retry.acceptance).toBe("accepted");
      expect(calls).toEqual([`execute:${first.label}`, `execute:${first.label}:retry`]);
    }
  });

  it("同 ID 同参的并发重复提交：第二个只等待同一收口，执行计数仍为 1", async () => {
    const { registry, calls, start } = setup();
    const operationId = randomUUID();
    const first = start("resultIsolated", operationId);
    await first.entered;
    const second = registry.submitExecution({
      operationId,
      target: ENTRIES.resultIsolated.target,
      fingerprint: ENTRIES.resultIsolated.fingerprint,
      async execute(ctx) {
        calls.push("execute:second");
        ctx.attachRunId("run_second");
        return { outcome: "returned", data: null };
      },
    });
    await flush();
    expect(calls).toEqual(["execute:resultIsolated"]);
    first.release();
    const [firstReport, secondReport] = await Promise.all([first.report, second]);
    expect(firstReport.acceptance).toBe("accepted");
    expect(secondReport.acceptance).toBe("duplicate");
    // 第二个响应拿到的是**同一个**操作的终态与身份，且自己没有执行
    expect(secondReport.record).toEqual(firstReport.record);
    expect(secondReport.record.runIds).toEqual(["run_resultIsolated"]);
    expect(calls).toEqual(["execute:resultIsolated"]);
  });

  it("同 ID 换入口（跨通道复用）⇒ conflict：原登记与执行都不受影响", async () => {
    const { registry, calls, start } = setup();
    const operationId = randomUUID();
    const create = start("createPlain", operationId);
    await create.entered;
    const crossChannel = await registry.submitExecution({
      operationId,
      target: ENTRIES.proxy.target,
      fingerprint: ENTRIES.proxy.fingerprint,
      async execute(ctx) {
        calls.push("execute:cross");
        ctx.attachRunId("run_cross");
        return { outcome: "returned", data: null };
      },
    });
    expect(crossChannel.acceptance).toBe("conflict");
    expect(crossChannel.error?.code).toBe("OPERATION_CONFLICT");
    expect(crossChannel.record.target).toEqual(ENTRIES.createPlain.target);
    await complete(create);
    expect(calls).toEqual(["execute:createPlain"]);
    expect(registry.recordOf(operationId)?.runIds).toEqual(["run_createPlain"]);
  });
});

describe("U4 1.7 顺序反转：reconcile 与执行的两种到达顺序", () => {
  it("reconcile 先到 ⇒ 封禁；迟到的正式执行被拒且零副作用", async () => {
    const { registry, calls, start, reconcile } = setup();
    const operationId = randomUUID();
    expect(reconcile(operationId)).toMatchObject({
      state: "notAccepted",
      rejection: "reconcile_tombstone",
      target: null,
    });
    const late = start("prompt", operationId);
    const report = await late.report;
    expect(report.acceptance).toBe("banned");
    expect(report.error?.code).toBe("OPERATION_NOT_ACCEPTED");
    expect(calls).toEqual([]);
    expect(registry.activeId).toBeNull();
    // 封禁不影响新 ID
    await complete(start("prompt", randomUUID()));
    expect(calls).toEqual(["execute:prompt"]);
  });

  it("执行先到 ⇒ 核对只读：running/settled 如实返回，绝不建封禁、不再次执行", async () => {
    const { registry, calls, start, reconcile } = setup();
    const operationId = randomUUID();
    const run = start("modelAb", operationId);
    await run.entered;
    expect(reconcile(operationId)).toMatchObject({ state: "running", operationId });
    expect(calls).toEqual(["execute:modelAb"]);
    run.release();
    await run.report;
    expect(reconcile(operationId)).toMatchObject({
      state: "settled",
      requestOutcome: "returned",
    });
    expect(reconcile(operationId)?.rejection).toBeNull();
    expect(calls).toEqual(["execute:modelAb"]);
    expect(registry.size).toBe(1);
  });
});

describe("U4 1.7 旧操作收尾与新操作占槽的交错", () => {
  it("settled A + running B：核对 A、重复完成 A、duplicate 提交 A 都不动 B 的槽", async () => {
    const { registry, calls, start, reconcile, status } = setup();
    const idA = randomUUID();
    const idB = randomUUID();
    await complete(start("createIsolated", idA));
    const b = start("resultPlain", idB);
    await b.entered;

    expect(reconcile(idA)).toMatchObject({ state: "settled", operationId: idA });
    const snapshot = status();
    expect(snapshot.activeOperationId).toBe(idB);
    expect(findSlotStateViolation(snapshot, snapshot.operations)).toBeNull();

    // A 的重复完成回调（迟到的 finally）
    const versionBefore = registry.registryVersion;
    const repeated = registry.settle({ operationId: idA, requestOutcome: "failed" });
    expect(repeated.requestOutcome).toBe("returned");
    expect(registry.registryVersion).toBe(versionBefore);
    expect(status().activeOperationId).toBe(idB);

    // A 的 duplicate 提交（同 ID 同参再来一次）
    const duplicate = await registry.submitExecution({
      operationId: idA,
      target: ENTRIES.createIsolated.target,
      fingerprint: ENTRIES.createIsolated.fingerprint,
      async execute(ctx) {
        calls.push("execute:late-a");
        return { outcome: "returned", data: null };
      },
    });
    expect(duplicate.acceptance).toBe("duplicate");
    expect(duplicate.record.state).toBe("settled");
    expect(status().activeOperationId).toBe(idB);

    // 只有 B 自己收尾才释放
    await complete(b);
    expect(status().activeOperationId).toBeNull();
    expect(calls).toEqual(["execute:createIsolated", "execute:resultPlain"]);
  });

  it("closing 期间的核对与迟到完成：状态如实，且解除 closing 前不接受新操作", async () => {
    const { registry, start, reconcile, status } = setup();
    const idA = randomUUID();
    const a = start("proxy", idA);
    await a.entered;
    registry.setClosing(true);
    expect(reconcile(idA)).toMatchObject({ state: "running" });
    expect(status()).toMatchObject({ closing: true, activeOperationId: idA });
    const during = await registry.submitExecution({
      operationId: randomUUID(),
      target: ENTRIES.prompt.target,
      fingerprint: ENTRIES.prompt.fingerprint,
      async execute() {
        throw new Error("关闭协商期间不应执行");
      },
    });
    expect(during.acceptance).toBe("not-accepted");
    if (during.acceptance === "not-accepted") expect(during.record.rejection).toBe("closing");
    await complete(a);
    // 操作已 settled，但 closing 未解除 ⇒ 仍不接受新执行
    expect(status()).toMatchObject({ activeOperationId: null, closing: true });
    registry.setClosing(false);
    const after = await registry.submitExecution({
      operationId: randomUUID(),
      target: ENTRIES.prompt.target,
      fingerprint: ENTRIES.prompt.fingerprint,
      async execute(ctx) {
        ctx.attachRunId("run_after");
        return { outcome: "returned", data: null };
      },
    });
    expect(after.acceptance).toBe("accepted");
    expect(after.record.state).toBe("settled");
  });

  it("配置变更与主动接受互斥：标记期间的新提交被拒，释放后按当前槽判定", async () => {
    const { registry, start } = setup();
    registry.beginConfigurationChange();
    const blocked = await registry.submitExecution({
      operationId: randomUUID(),
      target: ENTRIES.modelAb.target,
      fingerprint: ENTRIES.modelAb.fingerprint,
      async execute() {
        throw new Error("配置变更期间不应执行");
      },
    });
    expect(blocked.acceptance).toBe("not-accepted");
    if (blocked.acceptance === "not-accepted") {
      expect(blocked.record.rejection).toBe("configuration_busy");
    }
    registry.endConfigurationChange();
    await complete(start("modelAb", randomUUID()));
    expect(registry.activeId).toBeNull();
  });
});

describe("U4 1.7 贯穿竞争登记序列：版本单调、快照始终自洽", () => {
  it("混合驱动 30 步（接受/核对/完成/重复完成），每步快照都自洽且版本单调", async () => {
    const { registry, start, reconcile, status } = setup();
    const labels = ENTRY_LABELS;
    const pending: { operationId: string; release: () => void }[] = [];
    const finished: string[] = [];
    let lastVersion = registry.registryVersion;
    for (let step = 0; step < 30; step += 1) {
      switch (step % 5) {
        case 0: {
          // 未必抢到槽——抢不到就是 notAccepted，同样是合法的一步
          const operationId = randomUUID();
          const label = labels[step % labels.length];
          if (label === undefined) throw new Error("unreachable：取模必然落在标签表内");
          const handle = start(label, operationId);
          pending.push({ operationId, release: handle.release });
          break;
        }
        case 1: {
          reconcile(randomUUID());
          break;
        }
        case 2: {
          const current = pending.shift();
          if (current !== undefined) {
            current.release();
            finished.push(current.operationId);
          }
          break;
        }
        case 3: {
          const first = finished[0];
          if (first !== undefined) reconcile(first);
          break;
        }
        default: {
          const first = finished[0];
          if (first !== undefined) {
            // 重复完成：已 settled 的操作不得被改写，也不得动当前槽
            registry.settle({ operationId: first, requestOutcome: "failed" });
          }
          break;
        }
      }
      await flush();
      const snapshot = status();
      expect(findSlotStateViolation(snapshot, snapshot.operations)).toBeNull();
      expect(snapshot.registryVersion).toBeGreaterThanOrEqual(lastVersion);
      lastVersion = snapshot.registryVersion;
      expect(snapshot.operations.filter((one) => one.state === "running")).toHaveLength(
        snapshot.activeOperationId === null ? 0 : 1,
      );
    }
    for (const one of pending.splice(0, pending.length)) {
      one.release();
    }
    await flush();
    await flush();
    const final = status();
    expect(final.activeOperationId).toBeNull();
    expect(final.operations.length).toBeGreaterThan(0);
    expect(final.registryVersion).toBeGreaterThanOrEqual(lastVersion);
    expect(final.operations.every((one) => one.state !== "running")).toBe(true);
  });
});
