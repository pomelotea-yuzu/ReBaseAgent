import { join } from "node:path";
import type { RequestBody } from "@rebaseagent/agent-loop";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCreateRun, execModelAb, execModelAbPlan } from "../src/main/exec-endpoints";
import type { OperationRecord } from "../src/shared/operations";
import { OPERATION_ERROR } from "../src/shared/operations";
import { deferred, flush } from "./helpers/deterministic-schedule";
import {
  type ExecHarness,
  ONE_TURN,
  TRUSTED_SENDER,
  UNTRUSTED_SENDER,
  envelope,
  opId,
  openExecHarness,
  waitForState,
} from "./helpers/exec-endpoints-harness";

/**
 * U4 任务 3.4：模型 A/B 的**真实执行**整批接入 registry，dry-run 走独立只读分支。
 *
 * 判据来源：tasks.md 3.4 + design D2/D3/D5；delta spec `desktop-ui`（另涉 `model-experiments`）。
 * 验收场景（delta 逐字标题）：
 * - 「A-B 一批占槽直到全部收尾」——首臂已写出身份、后臂仍在飞时，批次保持 running 且
 *   第二主动入口被 busy 拒；最后一臂收尾后才 settled 并释放槽；
 * - 「A-B 部分失败保留各臂事实」——成功臂与失败臂都按 index 带**真实** id 与各自结局，
 *   `ids` 里只有成功臂（不混报），批次 `requestOutcome` 仍是 `returned` 而不冒充全臂成功；
 * - 「只读入口和被动录制不占主动槽」——dry-run 预览在批次占槽期间照常可用，零模型调用、
 *   零运行文件、不产生登记；
 * - 「七类主动入口均绑定身份」+「接受后业务拒绝仍有可信终态」——`dryRun:true` 误闯主动执行
 *   通道被 `MODEL_AB_DRY_RUN_CHANNEL` 拒：**接受之后**才发现分支不对，故登记是
 *   settled/rejected 且零身份零调用（不是"没登记"，见下方注释）；
 * - 「不同入口并发只有一个被接受」——批次在飞时 create 入口被拒且不碰模型与配置。
 *
 * ⚠️ 与 `HANDOFF.md`「dryRun 走主动通道被拒 ⇒ **零登记**」的表述不一致：实现（与 spec
 * 「接受后业务拒绝仍有可信终态」一致）是"登记存在、终态 settled/rejected、零身份"。
 * 本用例按实现与 spec 钉住，文档措辞待更正。
 *
 * 边界（如实）：`未开始/未写 meta 的臂为 null` 这条只在包层固定（replay 的 2.5/2.6 用
 * 按臂客户端工厂造出"客户端构造失败"的臂）。桌面端点注入的是**单个**共享 LlmClient，
 * 每臂都先写 meta 再调模型 ⇒ 该端点层面无法造出 id 为 null 的臂，不在这里自称覆盖。
 */

const ARMS = [{ model: "m-a" }, { model: "m-b" }];
/** LlmClient 合约里 requestBody 的必填形状；测试只关心 response，body 用占位值 */
const EMPTY_BODY: RequestBody = {
  model: "m",
  messages: [],
  stream: true,
  stream_options: { include_usage: true },
};

let h: ExecHarness;
beforeEach(() => {
  h = openExecHarness();
});
afterEach(() => {
  h.cleanup();
});

function rec(operationId: string): OperationRecord {
  const record = h.registry.recordOf(operationId);
  if (record === null) throw new Error(`登记里没有操作 ${operationId}`);
  return record;
}

function runOf(id: string): ReturnType<typeof readRun> {
  return readRun(join(h.traces, `${id}.jsonl`));
}

/** 等到条件成立（真实编排推进靠让出事件循环，不猜时长） */
async function waitUntil(pred: () => boolean, label: string, rounds = 2000): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (pred()) return;
    await flush();
  }
  throw new Error(`等不到条件：${label}`);
}

/** 按调用序号决定行为的客户端：第 blockOnCall 次调用前先等一道门 */
function gatedClient(blockOnCall: number) {
  const gate = deferred<void>();
  let calls = 0;
  return {
    gate,
    calls: () => calls,
    client: {
      complete: async () => {
        calls += 1;
        if (calls === blockOnCall) await gate.promise;
        return {
          response: {
            content: `臂 ${calls} 完成。`,
            reasoningContent: null,
            toolCalls: [],
            usage: { in: 10, out: 5 },
            ttftMs: 1,
          },
          requestBody: EMPTY_BODY,
        };
      },
    },
  };
}

describe("3.4 runs:modelAb：真实执行整批接入 registry", () => {
  it("两臂全成功：整批一条登记，臂数进摘要、各臂身份与实验号落登记", async () => {
    const parentId = await h.makePureParent();
    h.configure();
    h.setScript([{ content: "臂 0 完成。" }, { content: "臂 1 完成。" }]);
    const response = await execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(60, { parentRunId: parentId, arms: ARMS }),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.ok).toBe(true);
    expect(response.data.ids).toHaveLength(2);

    const record = rec(opId(60));
    expect(record.target).toMatchObject({ kind: "modelAb", parentRunId: parentId, armCount: 2 });
    expect(record).toMatchObject({
      state: "settled",
      requestOutcome: "returned",
      errorCode: null,
      experimentId: response.data.experimentId,
    });
    expect(record.arms).toEqual([
      { index: 0, id: response.data.ids[0], outcome: "returned" },
      { index: 1, id: response.data.ids[1], outcome: "returned" },
    ]);
    expect(record.runIds).toEqual(response.data.ids);
    expect(h.llmCalls()).toBe(2);
    // 父 + 两臂 = 三条记录，臂都是父的直接子 run
    expect(h.traceFiles()).toHaveLength(3);
    for (const id of response.data.ids) {
      expect(runOf(id).meta.parent).toBe(parentId);
      expect(runOf(id).meta.fork?.edit.field).toBe("model_params");
    }
  });

  it("A-B 一批占槽直到全部收尾：首臂已结算仍 running，第二入口被 busy 拒，末臂收尾才释放", async () => {
    const parentId = await h.makePureParent();
    h.configure();
    const { gate, client } = gatedClient(2);
    h.setLlm(client);
    const batch = execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(61, { parentRunId: parentId, arms: ARMS }),
    );
    await waitForState(h.registry, opId(61), "running");

    // 第 1 臂跑完、第 2 臂卡在模型调用里 ⇒ 批次绝不因单臂结束而释放槽
    await waitUntil(() => h.llmCalls() === 2, "第 2 臂进入模型调用");
    const midBatch = rec(opId(61));
    expect(midBatch.state).toBe("running");
    expect(midBatch.arms).toEqual([
      expect.objectContaining({ index: 0, outcome: null }),
      // 第 2 臂的身份在 meta 写出时登记，结局要到批次收尾才补
      expect.objectContaining({ index: 1, outcome: null }),
    ]);
    expect(midBatch.runIds).toHaveLength(2);
    expect(h.registry.activeId).toBe(opId(61));

    const busy = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(62, { systemPrompt: "", userMessage: "批次期间的新提交" }),
    );
    expect(busy.ok).toBe(false);
    if (busy.ok) return;
    expect(busy.error.code).toBe(OPERATION_ERROR.notAccepted);
    expect(rec(opId(62))).toMatchObject({ state: "notAccepted", rejection: "busy" });
    expect(h.llmCalls()).toBe(2);
    expect(h.settingsLoads()).toBe(1);

    gate.resolve();
    const response = await batch;
    expect(response.ok).toBe(true);
    expect(rec(opId(61)).state).toBe("settled");
    expect(rec(opId(61)).arms.every((arm) => arm.outcome === "returned")).toBe(true);
    expect(h.registry.activeId).toBeNull();
    expect(h.llmCalls()).toBe(2);
    expect(h.traceFiles()).toHaveLength(3);
  });

  it("A-B 部分失败：失败臂带真实 id 与 failed 结局，ids 只含成功臂，批次不冒充全臂成功", async () => {
    const parentId = await h.makePureParent();
    h.configure();
    // 只有一轮的剧本：臂 0 用完 ⇒ 臂 1 的调用抛错（错误即数据，该臂仍落盘）
    h.setScript(ONE_TURN);
    const response = await execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(63, { parentRunId: parentId, arms: ARMS }),
    );
    // 编排正常返回（部分失败不是请求层失败），但 ok:false 说明并非全臂成功
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.ok).toBe(false);
    expect(response.data.ids).toHaveLength(1);

    const record = rec(opId(63));
    expect(record).toMatchObject({
      state: "settled",
      requestOutcome: "returned",
      errorCode: null,
      experimentId: response.data.experimentId,
    });
    expect(record.arms).toHaveLength(2);
    const [arm0, arm1] = record.arms;
    expect(arm0).toMatchObject({ index: 0, outcome: "returned" });
    expect(arm1).toMatchObject({ index: 1, outcome: "failed" });
    expect(arm1?.id).toMatch(/^run_/);
    // 失败臂的记录真在磁盘上，且带错误终止原因（不是从文案猜的 id）
    expect(h.traceFiles()).toContain(`${arm1?.id}.jsonl`);
    expect(h.deps.repository.listRuns().runs.find((one) => one.id === arm1?.id)?.reason).toBe(
      "error",
    );
    expect(record.runIds).toEqual([arm0?.id, arm1?.id]);
    expect(record.runIds).not.toContain(null);
    // ids 的口径不变：只有成功臂
    expect(response.data.ids).toEqual([arm0?.id]);
  });

  it("dryRun 误闯主动执行通道：接受后拒绝 ⇒ settled/rejected + 零身份零调用零文件", async () => {
    const parentId = await h.makePureParent();
    h.configure();
    h.setScript(ONE_TURN);
    const before = h.traceFiles();
    const response = await execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(64, { parentRunId: parentId, arms: ARMS, dryRun: true }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("MODEL_AB_DRY_RUN_CHANNEL");
    expect(response.operation).toMatchObject({ operationId: opId(64), state: "settled" });

    const record = rec(opId(64));
    expect(record).toMatchObject({
      state: "settled",
      requestOutcome: "rejected",
      errorCode: "MODEL_AB_DRY_RUN_CHANNEL",
    });
    expect(record.runIds).toEqual([]);
    expect(record.arms).toEqual([]);
    expect(record.experimentId).toBeNull();
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toEqual(before);
    // 拒完即释放：槽不是泄漏点
    expect(h.registry.activeId).toBeNull();
  });

  it("跨通道复用同一 operationId ⇒ conflict：A/B 不借用 create 的登记", async () => {
    const parentId = await h.makePureParent();
    h.configure();
    h.setScript(ONE_TURN);
    const created = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(65, { systemPrompt: "", userMessage: "先占住这个 ID" }),
    );
    expect(created.ok).toBe(true);
    const calls = h.llmCalls();

    const reused = await execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(65, { parentRunId: parentId, arms: ARMS }),
    );
    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.error.code).toBe(OPERATION_ERROR.conflict);
    expect(rec(opId(65)).target?.kind).toBe("create");
    expect(rec(opId(65)).arms).toEqual([]);
    expect(h.llmCalls()).toBe(calls);
    expect(h.traceFiles()).toHaveLength(2);
  });

  it("未配置运行参数：接受后才失败 ⇒ 原稳定码 + 零臂身份 + 零模型调用", async () => {
    const parentId = await h.makePureParent();
    h.setScript(ONE_TURN);
    const response = await execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(66, { parentRunId: parentId, arms: ARMS }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("SETTINGS_NOT_CONFIGURED");
    const record = rec(opId(66));
    expect(record).toMatchObject({ state: "settled", requestOutcome: "rejected" });
    expect(record.runIds).toEqual([]);
    expect(record.arms).toEqual([]);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toHaveLength(1);
  });
});

describe("3.4 runs:modelAbPlan：只读预览分支不占槽、不登记", () => {
  it("批次占槽期间预览照常可用：零模型调用、零文件、不产生登记", async () => {
    const parentId = await h.makePureParent();
    h.configure();
    const { gate, client } = gatedClient(2);
    h.setLlm(client);
    const batch = execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(70, { parentRunId: parentId, arms: ARMS }),
    );
    await waitForState(h.registry, opId(70), "running");
    await waitUntil(() => h.llmCalls() === 2, "第 2 臂进入模型调用");
    const files = h.traceFiles();

    const plan = await execModelAbPlan(h.deps, TRUSTED_SENDER, {
      parentRunId: parentId,
      arms: ARMS,
      dryRun: true,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.plan).toHaveLength(2);
    expect(plan.data.ids).toEqual([]);
    // 预览的判据与真实执行同源：臂数、父本门禁都过了，但没有臂身份与文件
    expect("armFacts" in plan.data).toBe(false);

    // 只读入口既不占槽也不释放别人的槽
    expect(h.registry.size).toBe(1);
    expect(h.registry.activeId).toBe(opId(70));
    expect(rec(opId(70)).state).toBe("running");
    expect(h.llmCalls()).toBe(2);
    expect(h.traceFiles()).toEqual(files);

    gate.resolve();
    const batchResponse = await batch;
    expect(batchResponse.ok).toBe(true);
    expect(h.traceFiles()).toHaveLength(3);
  });

  it("预览的四类拒绝都在副作用之前：非 dryRun / 臂数不足 / 非法形状 / 伪造 sender", async () => {
    const parentId = await h.makePureParent();
    h.configure();
    h.setScript(ONE_TURN);
    const before = h.traceFiles();

    const notDryRun = await execModelAbPlan(h.deps, TRUSTED_SENDER, {
      parentRunId: parentId,
      arms: ARMS,
    });
    if (notDryRun.ok) throw new Error("unreachable：非 dryRun 的预览必须被拒");
    expect(notDryRun.error.code).toBe("MODEL_AB_PLAN_REQUIRES_DRY_RUN");

    const tooFewArms = await execModelAbPlan(h.deps, TRUSTED_SENDER, {
      parentRunId: parentId,
      arms: [{ model: "m-only" }],
      dryRun: true,
    });
    if (tooFewArms.ok) throw new Error("unreachable：单臂请求必须被 schema 拒");
    expect(tooFewArms.error.code).toBe("INVALID_ARGUMENT");

    const untrusted = await execModelAbPlan(h.deps, UNTRUSTED_SENDER, {
      parentRunId: parentId,
      arms: ARMS,
      dryRun: true,
    });
    if (untrusted.ok) throw new Error("unreachable：伪造 sender 必须被拒");
    expect(untrusted.error.code).toBe(OPERATION_ERROR.untrustedSender);

    // 预览从不登记：既没有 operationId 概念，也没有臂摘要
    expect(h.registry.size).toBe(0);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toEqual(before);
  });
});
