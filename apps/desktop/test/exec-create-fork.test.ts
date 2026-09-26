import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCreateRun, execForkRun } from "../src/main/exec-endpoints";
import type { OperationRecord } from "../src/shared/operations";
import { OPERATION_ERROR } from "../src/shared/operations";
import { deferred, flush } from "./helpers/deterministic-schedule";
import {
  EXEC_EPOCH,
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
 * U4 任务 3.1 + 3.2：普通/隔离 create 与普通/隔离 result fork **真的**接进了 registry。
 *
 * 判据来源：tasks.md 3.1/3.2 + design D2/D3；delta spec `desktop-ui`。
 * 验收场景（delta 逐字标题）：
 * - 「同 ID 重复请求只执行一次」——重复提交不新登记、不重跑：**等原执行收口**后带原终态
 *   返回，落盘文件集合与真实模型调用次数都不再增长；
 * - 「普通和隔离创建失败保留 ID」——模型失败后登记里的 runIds 就是那条失败记录的
 *   真实 id（`listRuns` 的 reason 仍是 error），不来自异常文案；
 * - 「接受后业务拒绝仍有可信终态」——settings 未配置 / 令牌失效 / 隔离门禁拒绝都在
 *   **接受之后**才发生：响应 ok:false 且带回执，登记 settled + 原稳定码 + 零运行身份；
 * - 「七类主动入口均绑定身份」——缺身份信封、伪造 sender、旧 epoch 都在任何副作用之前
 *   被拒，且不产生登记；
 * - 「不同入口并发只有一个被接受」——A running 时 B 被 busy 拒，且 B 没碰到
 *   settings / 令牌 / 模型；
 * - 「指纹与执行使用同一解析快照」「同 ID 异参和跨通道复用被拒绝」——改 edit.value 或
 *   把 create 的 ID 用到 fork 通道都判 conflict，副作用计数为 0。
 *
 * 夹具见 `helpers/exec-endpoints-harness.ts`：registry/指纹器/仓库/令牌/settings 文件全为真件，
 * 只有 LLM 与代理 fork 是可控桩；父 run 由真实 runLoop 现造。
 *
 * 顺带钉住一条现状（不是本 change 引入）：包层 `assertNotIsolatedParent` 抛**无 code 的裸 Error**，
 * 所以"隔离父本漏传 execution"只能落进 `OPERATION_EXECUTION_FAILED` 兜底码；A 的 `preflight`
 * 分类（`parent_not_isolated`）则经 `ISOLATED_FORK_FAILED` 的 reason 透传。收紧需改包层错误形状。
 */

const NEW_README = "# ReBaseAgent（编辑后的历史）\n\n不止回放，还能改变。";
/** 一步答完（fork/重跑的通用剧本） */
const ONE_TURN_LOCAL = ONE_TURN;
/** 隔离父本：读一次世界内文件再收尾（给出可分叉的 tool.invoke 叶子） */
const ISOLATED_PARENT: typeof ONE_TURN = [
  { toolCalls: [{ id: "c1", name: "read_file", args: JSON.stringify({ path: "a.txt" }) }] },
  { content: "隔离创建完成。" },
];
void ONE_TURN_LOCAL;

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

describe("3.1 runs:create：普通与隔离创建接入 registry", () => {
  it("普通创建成功：回执 + 受限登记 + 真实落盘三者口径一致", async () => {
    h.configure();
    h.setScript(ONE_TURN);
    const response = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(1, {
        systemPrompt: "你是简洁的问答助手。",
        userMessage: "用一句话解释时间旅行调试。",
      }),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.operation).toEqual({
      epoch: EXEC_EPOCH,
      operationId: opId(1),
      registryVersion: response.operation.registryVersion,
      state: "settled",
    });
    expect(rec(opId(1)).runIds).toEqual([response.data.id]);
    const record = runOf(response.data.id);
    expect(record.status).toBe("completed");
    expect(record.spans.filter((span) => span.kind === "llm.call")).toHaveLength(1);
    // 回执里的登记版本确实推进过（握手快照能看出这条操作存在）
    expect(response.operation.registryVersion).toBeGreaterThan(0);
  });

  it("隔离创建：源目录只读、副本世界落盘，令牌恰消费一次", async () => {
    h.configure();
    h.setScript([{ content: "隔离创建完成。" }]);
    const sourceToken = h.issueSource();
    const response = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(2, {
        systemPrompt: "你是文件助手。",
        userMessage: "读一下 a.txt",
        workspace: { mode: "isolated_files", sourceToken, allowFileWrites: true },
      }),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(h.tokenConsumes()).toBe(1);
    expect(readFileSync(join(h.sourceDir, "a.txt"), "utf8")).toBe("源文件 a\n");
    const record = runOf(response.data.id);
    expect(record.meta.workspace?.world_id).toBe(response.data.id);
    expect(rec(opId(2)).runIds).toEqual([response.data.id]);
  });

  it("同 ID 重复提交只执行一次：文件集合、模型调用次数与令牌消费都不再增长", async () => {
    h.configure();
    h.setScript(ONE_TURN);
    const request = { systemPrompt: "", userMessage: "重复提交判重" };
    const first = await execCreateRun(h.deps, TRUSTED_SENDER, envelope(3, request));
    expect(first.ok).toBe(true);
    const files = h.traceFiles();
    const calls = h.llmCalls();
    const loads = h.settingsLoads();

    const again = await execCreateRun(h.deps, TRUSTED_SENDER, envelope(3, request));
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe(OPERATION_ERROR.duplicated);
    // 重复请求关联回原操作与其终态：不新登记、不重跑、不再读配置
    expect(again.operation).toMatchObject({ operationId: opId(3), state: "settled" });
    expect(h.traceFiles()).toEqual(files);
    expect(h.llmCalls()).toBe(calls);
    expect(h.settingsLoads()).toBe(loads);
    expect(h.registry.size).toBe(1);
  });

  it("判重在副作用之前：running 中的同 ID 重复只等不收口二次，另一入口被 busy 拒", async () => {
    h.configure();
    h.setScript(ONE_TURN);
    const gate = deferred<void>();
    h.setGate(gate.promise);
    const running = execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(4, {
        systemPrompt: "",
        userMessage: "执行中判重",
      }),
    );
    await waitForState(h.registry, opId(4), "running");
    expect(h.llmCalls()).toBe(0);

    // 单执行槽：另一条主动入口在 A 收尾前不被接受，且不碰令牌与配置
    const busy = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(5, {
        systemPrompt: "你是文件助手。",
        userMessage: "跨入口忙碌",
        workspace: {
          mode: "isolated_files",
          sourceToken: h.issueSource(),
          allowFileWrites: true,
        },
      }),
    );
    expect(busy.ok).toBe(false);
    if (busy.ok) return;
    expect(busy.error.code).toBe(OPERATION_ERROR.notAccepted);
    expect(rec(opId(5))).toMatchObject({ state: "notAccepted", rejection: "busy" });
    expect(h.tokenConsumes()).toBe(0);
    expect(h.settingsLoads()).toBe(1);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toEqual([]);

    // 同 ID 同参：不新登记、不重跑，而是**等原执行收口**后带原终态返回
    const duplicated = execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(4, {
        systemPrompt: "",
        userMessage: "执行中判重",
      }),
    );
    await flush();
    expect(h.llmCalls()).toBe(0);
    expect(h.registry.size).toBe(2);

    gate.resolve();
    const [first, again] = await Promise.all([running, duplicated]);
    expect(first.ok).toBe(true);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe(OPERATION_ERROR.duplicated);
    expect(again.operation).toMatchObject({ operationId: opId(4), state: "settled" });
    // 全程只跑了一次：一条记录、一次模型调用、一次配置读取
    expect(h.llmCalls()).toBe(1);
    expect(h.settingsLoads()).toBe(1);
    expect(h.traceFiles()).toHaveLength(1);
    expect(h.registry.activeId).toBeNull();
  });

  it("未配置运行参数：接受之后才失败 ⇒ 可信终态 + 原稳定码 + 零模型调用", async () => {
    h.setScript(ONE_TURN);
    const response = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(6, {
        systemPrompt: "",
        userMessage: "未配置时的创建",
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error).toMatchObject({ code: "SETTINGS_NOT_CONFIGURED" });
    expect(response.operation).toMatchObject({ operationId: opId(6), state: "settled" });
    const record = rec(opId(6));
    expect(record).toMatchObject({
      state: "settled",
      requestOutcome: "rejected",
      errorCode: "SETTINGS_NOT_CONFIGURED",
    });
    expect(record.runIds).toEqual([]);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toEqual([]);

    // 新配置只影响后续新 operationId：换成新 ID 即成功
    h.configure();
    const retry = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(7, {
        systemPrompt: "",
        userMessage: "补配置后重试",
      }),
    );
    expect(retry.ok).toBe(true);
  });

  it("普通创建失败保留 ID；失效令牌被拒时不产生任何运行身份", async () => {
    h.configure();
    h.setScript([]);
    const failed = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(8, {
        systemPrompt: "",
        userMessage: "模型失败也要留下真实身份",
      }),
    );
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe("CREATE_RUN_FAILED");
    const record = rec(opId(8));
    expect(record).toMatchObject({
      state: "settled",
      requestOutcome: "rejected",
      errorCode: "CREATE_RUN_FAILED",
    });
    expect(record.runIds).toHaveLength(1);
    const [failedId] = record.runIds;
    expect(failedId).toBeDefined();
    // 身份是这条失败记录本身：文件真在那儿，而不是从异常里猜出来的
    expect(h.traceFiles()).toEqual([`${failedId}.jsonl`]);
    // `status` 只表达"有没有终止事件"（errored 也有 ⇒ completed）；失败语义看终止原因
    expect(runOf(failedId as string).status).toBe("completed");
    expect(h.deps.repository.listRuns().runs.find((one) => one.id === failedId)?.reason).toBe(
      "error",
    );

    const before = h.traceFiles();
    const badToken = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(9, {
        systemPrompt: "你是文件助手。",
        userMessage: "令牌已被用过",
        workspace: { mode: "isolated_files", sourceToken: "no-such-token", allowFileWrites: true },
      }),
    );
    expect(badToken.ok).toBe(false);
    if (badToken.ok) return;
    expect(badToken.error.code).toBe("INVALID_SOURCE_TOKEN");
    const rejected = rec(opId(9));
    expect(rejected).toMatchObject({ state: "settled", requestOutcome: "rejected" });
    expect(rejected.runIds).toEqual([]);
    expect(h.traceFiles()).toEqual(before);
  });

  it("缺身份 / 伪造 sender / 旧 epoch：一切副作用之前被拒且不产生登记", async () => {
    h.configure();
    h.setScript(ONE_TURN);
    const business = { systemPrompt: "", userMessage: "非法身份不发副作用" };
    const bad: [string, Promise<unknown>][] = [
      ["未信任的发送者", execCreateRun(h.deps, UNTRUSTED_SENDER, envelope(10, business))],
      [
        "旧 main 会话",
        execCreateRun(
          h.deps,
          TRUSTED_SENDER,
          envelope(11, business, "99999999-9999-4999-8999-999999999999"),
        ),
      ],
      ["无身份信封", execCreateRun(h.deps, TRUSTED_SENDER, business)],
      [
        "信封带多余键",
        execCreateRun(h.deps, TRUSTED_SENDER, { ...envelope(12, business), extra: 1 }),
      ],
      [
        "ID 非 UUID",
        execCreateRun(h.deps, TRUSTED_SENDER, {
          operation: { epoch: EXEC_EPOCH, operationId: "op-12" },
          request: business,
        }),
      ],
    ];
    const codes: string[] = [];
    for (const [label, call] of bad) {
      const response = (await call) as {
        ok: boolean;
        operation: unknown;
        error?: { code: string };
      };
      expect(response.ok, label).toBe(false);
      expect(response.operation, label).toBeNull();
      expect(response.error?.code, label).toBeDefined();
      codes.push(response.error?.code as string);
    }
    expect(codes).toEqual([
      OPERATION_ERROR.untrustedSender,
      OPERATION_ERROR.staleEpoch,
      OPERATION_ERROR.invalidIdentity,
      OPERATION_ERROR.invalidIdentity,
      OPERATION_ERROR.invalidIdentity,
    ]);
    expect(h.llmCalls()).toBe(0);
    expect(h.settingsLoads()).toBe(0);
    expect(h.tokenConsumes()).toBe(0);
    expect(h.traceFiles()).toEqual([]);
    expect(h.registry.size).toBe(0);
  });
});

describe("3.2 runs:fork：普通与隔离 result 分叉接入 registry", () => {
  it("普通 result 分叉：目标摘要带父本定位，成功身份与实际记录一致", async () => {
    const { parentId, atSpanId } = await h.makeParent();
    const files = h.traceFiles();
    h.configure();
    h.setScript(ONE_TURN);
    const response = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(20, {
        parentRunId: parentId,
        atSpanId,
        edit: { field: "result", value: NEW_README },
      }),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(rec(opId(20))).toMatchObject({
      state: "settled",
      requestOutcome: "returned",
      target: {
        kind: "result",
        mode: "plain",
        parentRunId: parentId,
        atSpanId,
        editField: "result",
      },
      runIds: [response.data.id],
    });
    const child = runOf(response.data.id);
    expect(child.meta.parent).toBe(parentId);
    expect(child.meta.fork?.edit.value).toBe(NEW_README);
    // 父文件字节不变，traces 只多一条记录 ⇒ 副作用恰为一次
    expect(h.traceFiles()).toEqual([...files, `${response.data.id}.jsonl`].sort());
    expect(h.llmCalls()).toBe(1);
  });

  it("隔离 result 分叉：目标记 isolated，身份等于实际世界记录且不动源目录", async () => {
    h.configure();
    h.setScript(ISOLATED_PARENT);
    const created = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(21, {
        systemPrompt: "你是文件助手。",
        userMessage: "读一下 a.txt",
        workspace: { mode: "isolated_files", sourceToken: h.issueSource(), allowFileWrites: true },
      }),
    );
    if (!created.ok) throw new Error("隔离父本创建失败");
    const worldId = created.data.id;

    h.setScript(ONE_TURN);
    const forked = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(22, {
        parentRunId: worldId,
        atSpanId: firstToolSpan(worldId),
        edit: { field: "result", value: "编辑后的隔离世界内容" },
        execution: { mode: "isolated_files", allowFileWrites: true },
      }),
    );
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    expect(rec(opId(22)).target).toMatchObject({
      kind: "result",
      mode: "isolated",
      parentRunId: worldId,
    });
    expect(runOf(forked.data.id).meta.workspace?.world_id).toBe(forked.data.id);
    expect(readFileSync(join(h.sourceDir, "a.txt"), "utf8")).toBe("源文件 a\n");
  });

  it("非隔离父本硬走隔离续跑：包 preflight 原门禁生效，稳定码透传原始分类且不落文件", async () => {
    // 工具表刻意用 file-tools-v1：否则 A 的预检更早以 profile_mismatch 拒绝，测不到父本门禁
    const { parentId, atSpanId } = await h.makeV1Parent();
    h.configure();
    h.setScript(ONE_TURN);
    const before = h.traceFiles();
    const response = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(28, {
        parentRunId: parentId,
        atSpanId,
        edit: { field: "result", value: "普通父本硬走隔离续跑" },
        execution: { mode: "isolated_files", allowFileWrites: true },
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("ISOLATED_FORK_FAILED");
    // A 的原始分类随 reason 透传（main 不另判一套口径）
    expect(response.error.message).toContain("parent_not_isolated");
    const record = rec(opId(28));
    expect(record).toMatchObject({ state: "settled", requestOutcome: "rejected" });
    expect(record.runIds).toEqual([]);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toEqual(before);
  });

  it("隔离父本漏传执行模式：普通分支被包层隔离门禁拒绝，不降级执行也不带回身份", async () => {
    h.configure();
    h.setScript(ISOLATED_PARENT);
    const created = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(23, {
        systemPrompt: "你是文件助手。",
        userMessage: "读一下 a.txt",
        workspace: { mode: "isolated_files", sourceToken: h.issueSource(), allowFileWrites: true },
      }),
    );
    if (!created.ok) throw new Error("隔离父本创建失败");
    const before = h.traceFiles();
    h.setScript(ONE_TURN);
    const response = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(24, {
        parentRunId: created.data.id,
        atSpanId: firstToolSpan(created.data.id),
        edit: { field: "result", value: "漏传 execution" },
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    // 包层 `assertNotIsolatedParent` 抛的是无 code 的裸 Error（isolated-guard.ts:47）
    // ⇒ 走"未预期异常"分支。终态与"零身份、零写入"仍然可信，但这条路径的稳定码偏弱。
    expect(response.error.code).toBe("OPERATION_EXECUTION_FAILED");
    const record = rec(opId(24));
    expect(record).toMatchObject({ state: "settled", requestOutcome: "failed" });
    expect(record.runIds).toEqual([]);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toEqual(before);
  });

  it("同 ID 改编辑值 ⇒ conflict：原登记与副作用一字不动", async () => {
    const { parentId, atSpanId } = await h.makeParent();
    h.configure();
    h.setScript(ONE_TURN);
    const request = {
      parentRunId: parentId,
      atSpanId,
      edit: { field: "result" as const, value: NEW_README },
    };
    const first = await execForkRun(h.deps, TRUSTED_SENDER, envelope(25, request));
    expect(first.ok).toBe(true);
    const files = h.traceFiles();
    const calls = h.llmCalls();

    const conflicting = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(25, {
        ...request,
        edit: { field: "result", value: "改了值的第二次" },
      }),
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.error.code).toBe(OPERATION_ERROR.conflict);
    // 原操作的事实不被改写：身份仍是第一次那条
    expect(conflicting.operation?.operationId).toBe(opId(25));
    expect(rec(opId(25)).runIds).toEqual(first.ok ? [first.data.id] : []);
    expect(h.traceFiles()).toEqual(files);
    expect(h.llmCalls()).toBe(calls);
  });

  it("跨通道复用同一 operationId ⇒ conflict：fork 不借用 create 的登记", async () => {
    h.configure();
    h.setScript(ONE_TURN);
    const created = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(26, {
        systemPrompt: "",
        userMessage: "先占住这个 ID",
      }),
    );
    expect(created.ok).toBe(true);
    const { parentId, atSpanId } = await h.makeParent();
    const calls = h.llmCalls();

    const reused = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(26, {
        parentRunId: parentId,
        atSpanId,
        edit: { field: "result", value: "换通道复用 ID" },
      }),
    );
    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.error.code).toBe(OPERATION_ERROR.conflict);
    expect(rec(opId(26)).target?.kind).toBe("create");
    expect(h.llmCalls()).toBe(calls);
    // 复用请求没有产出任何 fork 记录（只有 create 与父本两条）
    expect(h.traceFiles()).toHaveLength(2);
  });

  it("业务 schema 非法 ⇒ 不登记、不执行", async () => {
    h.configure();
    h.setScript(ONE_TURN);
    const response = await execForkRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(27, {
        parentRunId: "run_missing",
        atSpanId: "",
        edit: { field: "result", value: "空 span 定位" },
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("INVALID_ARGUMENT");
    expect(response.operation).toBeNull();
    expect(h.registry.size).toBe(0);
    expect(h.llmCalls()).toBe(0);
  });
});

/** 该 run 里第一个 tool.invoke 的 span id（分叉点定位） */
function firstToolSpan(id: string): string {
  const span = runOf(id).spans.find((one) => one.kind === "tool.invoke");
  if (span === undefined) throw new Error(`run ${id} 没有 tool.invoke span`);
  return span.id;
}
