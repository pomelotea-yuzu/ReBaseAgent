import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RequestBody } from "@rebaseagent/agent-loop";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execPromptFork, execProxyFork } from "../src/main/exec-endpoints";
import { ProxyForkError } from "../src/main/proxy-manager";
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
 * U4 任务 3.3：prompt 与 proxy 两个主动入口**真的**接进了 registry。
 *
 * 判据来源：tasks.md 3.3 + design D2/D3/D5；delta spec `desktop-ui`。
 * 验收场景（delta 逐字标题）：
 * - 「七类主动入口均绑定身份」——prompt / proxy 两条通道上，缺身份信封、伪造 sender、
 *   旧 epoch 都在任何副作用之前被拒（proxy 的 `fork` 一次都没被调用）；
 * - 「同 ID 重复请求只执行一次」——settled 后同 ID 同参重复 ⇒ 不重跑、不多打模型、
 *   不多一次代理调用；running 中的重复只等不收二次；
 * - 「接受后业务拒绝仍有可信终态」——启动上下文门禁（无 system 消息的父本）与
 *   `PROXY_NO_KEY` / `PROXY_EMPTY_FORK` 都在接受之后才失败：settled + 原稳定码 + 零身份；
 * - 「分叉在已知身份后异常仍可关联」——prompt 写出 meta 后执行抛错 ⇒ 登记保留真实 id，
 *   且**不冒充**已封存可读的记录；
 * - 「主动代理重发与被动录制交错」——重发等待期间别的 run 落盘，登记的仍是本次 fork
 *   返回的 id；本次录制写入失败（`PROXY_RECORDING_WRITE_FAILED`）时绝不借用那个被动 id；
 * - 「不同入口并发只有一个被接受」——proxy running 时 prompt 入口被 busy 拒且零调用。
 *
 * 与 3.1/3.2 同一夹具：registry/指纹器/仓库/令牌/settings 全为真件，父 run 由真实
 * `runLoop` 现造；只有 LLM 与代理 `fork` 是可控桩（真实代理链路归 2.9/2.10 与 §6 实机）。
 */

const NEW_SYSTEM = "你是简洁的问答助手，不超过两句。";
const FORK_RETURNED_ID = "run_active_fork_0001";
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

/** 交给模型的首个请求（真实入参快照，不看界面/登记自述） */
function firstRequest(): Array<{ role: string; content: string }> {
  return h.llmRequests()[0] as Array<{ role: string; content: string }>;
}

function promptRequest(parentId: string) {
  return { parentRunId: parentId, edit: { field: "system_prompt" as const, value: NEW_SYSTEM } };
}

function proxyRequest(parentId: string, atSpanId: string) {
  return {
    parentRunId: parentId,
    atSpanId,
    messages: [{ role: "user", content: "编辑后的重发消息" }],
    // tasks 2.2b：提交携带这一刻的预期代理事实。这里用的是**与 main 一致的假事实**
    // （harness 的 proxy.fork 是可控桩，不做版本核对），值本身只用于过 schema。
    expectedKeyCaptureRevision: 0,
    expectedUpstreamBaseUrl: "https://upstream.test/v1",
    expectedPort: 18787,
  };
}

describe("3.3 runs:promptFork：prompt 入口接入 registry", () => {
  it("成功：目标带被编辑字段名、身份与落盘记录一致，且从头重跑用的是编辑后的启动上下文", async () => {
    const { parentId } = await h.makeParent();
    h.configure();
    h.setScript(ONE_TURN);
    const response = await execPromptFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(40, promptRequest(parentId)),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    expect(rec(opId(40))).toMatchObject({
      state: "settled",
      requestOutcome: "returned",
      errorCode: null,
      target: { kind: "prompt", parentRunId: parentId, editField: "system_prompt" },
      runIds: [response.data.id],
    });
    const child = runOf(response.data.id);
    expect(child.meta.parent).toBe(parentId);
    expect(child.meta.fork?.edit.value).toBe(NEW_SYSTEM);
    // 从头重跑：子 run 有自己的 s_01，且交给模型的启动上下文首条就是编辑后的 system
    expect(child.spans.filter((span) => span.kind === "llm.call")).toHaveLength(1);
    expect(firstRequest()[0]).toMatchObject({ role: "system", content: NEW_SYSTEM });
    expect(h.llmCalls()).toBe(1);
  });

  it("user_message 编辑：摘要与落盘都记被编辑字段，system 仍取父 run 录制原值", async () => {
    const { parentId } = await h.makeParent();
    h.configure();
    h.setScript(ONE_TURN);
    const response = await execPromptFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(67, {
        parentRunId: parentId,
        edit: { field: "user_message", value: "换成另一个任务描述" },
      }),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(rec(opId(67)).target).toMatchObject({ kind: "prompt", editField: "user_message" });
    expect(runOf(response.data.id).meta.fork?.edit.field).toBe("user_message");
    expect(firstRequest()[0]).toMatchObject({ role: "system", content: "你是文件助手。" });
    expect(firstRequest().find((message) => message.role === "user")?.content).toBe(
      "换成另一个任务描述",
    );
  });

  it("同 ID 重复提交 ⇒ 关联原终态，不重跑、不多打模型、不多写记录", async () => {
    const { parentId } = await h.makeParent();
    h.configure();
    h.setScript(ONE_TURN);
    const request = promptRequest(parentId);
    const first = await execPromptFork(h.deps, TRUSTED_SENDER, envelope(41, request));
    expect(first.ok).toBe(true);
    const files = h.traceFiles();
    const calls = h.llmCalls();
    const loads = h.settingsLoads();

    const again = await execPromptFork(h.deps, TRUSTED_SENDER, envelope(41, request));
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe(OPERATION_ERROR.duplicated);
    expect(again.operation).toMatchObject({ operationId: opId(41), state: "settled" });
    expect(h.traceFiles()).toEqual(files);
    expect(h.llmCalls()).toBe(calls);
    expect(h.settingsLoads()).toBe(loads);
    expect(h.registry.size).toBe(1);
  });

  it("启动上下文门禁（前置拒绝）：父本首次 llm.call 无 system 消息 ⇒ 原稳定码 + 零身份零文件", async () => {
    const parentId = await h.makeNoSystemParent();
    h.configure();
    h.setScript(ONE_TURN);
    const before = h.traceFiles();
    const response = await execPromptFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(42, {
        parentRunId: parentId,
        edit: { field: "user_message", value: "换个首条用户消息" },
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("PROMPT_FORK_NO_SYSTEM");
    const record = rec(opId(42));
    expect(record).toMatchObject({ state: "settled", requestOutcome: "rejected" });
    // 关键：没有真实运行就没有身份——不从文案或列表猜 id
    expect(record.runIds).toEqual([]);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toEqual(before);
  });

  it("写出 meta 后执行抛错：登记保留真实 id，但该记录确实没封存（身份 ≠ 可读）", async () => {
    const { parentId } = await h.makeParent();
    h.configure();
    // 返回非法 content 形状：runLoop 落 span 时 schema 必然抛，抛点在 meta 之后
    h.setLlm({
      complete: async () => ({
        response: {
          content: { ouch: true } as unknown as string,
          reasoningContent: null,
          toolCalls: [],
          usage: { in: 1, out: 1 },
          ttftMs: 1,
        },
        requestBody: EMPTY_BODY,
      }),
    });
    const response = await execPromptFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(43, promptRequest(parentId)),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("OPERATION_EXECUTION_FAILED");

    const record = rec(opId(43));
    expect(record).toMatchObject({ state: "settled", requestOutcome: "failed" });
    expect(record.runIds).toHaveLength(1);
    const [childId] = record.runIds;
    expect(childId).toMatch(/^run_/);
    // 身份是真实文件，但它没有被终止事件封存 ⇒ 不能当成功结果读
    expect(h.traceFiles()).toContain(`${childId}.jsonl`);
    expect(runOf(childId as string).status).toBe("crashed");
  });

  it("缺身份 / 伪造 sender / 旧 epoch：prompt 与 proxy 都在副作用前被拒且不登记", async () => {
    const { parentId, atSpanId } = await h.makeParent();
    h.configure();
    h.setScript(ONE_TURN);
    h.setProxyFork(async () => ({ id: FORK_RETURNED_ID }));
    const bad: [string, Promise<unknown>][] = [
      [
        "prompt：未信任的发送者",
        execPromptFork(h.deps, UNTRUSTED_SENDER, envelope(44, promptRequest(parentId))),
      ],
      [
        "prompt：旧 main 会话",
        execPromptFork(
          h.deps,
          TRUSTED_SENDER,
          envelope(45, promptRequest(parentId), "99999999-9999-4999-8999-999999999999"),
        ),
      ],
      ["prompt：无身份信封", execPromptFork(h.deps, TRUSTED_SENDER, promptRequest(parentId))],
      [
        "proxy：未信任的发送者",
        execProxyFork(h.deps, UNTRUSTED_SENDER, envelope(46, proxyRequest(parentId, atSpanId))),
      ],
      [
        "proxy：旧 main 会话",
        execProxyFork(
          h.deps,
          TRUSTED_SENDER,
          envelope(47, proxyRequest(parentId, atSpanId), "99999999-9999-4999-8999-999999999999"),
        ),
      ],
      [
        "proxy：信封带多余键",
        execProxyFork(h.deps, TRUSTED_SENDER, {
          operation: { epoch: EXEC_EPOCH, operationId: opId(48) },
          request: proxyRequest(parentId, atSpanId),
          extra: 1,
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
      OPERATION_ERROR.untrustedSender,
      OPERATION_ERROR.staleEpoch,
      OPERATION_ERROR.invalidIdentity,
    ]);
    expect(h.llmCalls()).toBe(0);
    expect(h.proxyCalls()).toBe(0);
    expect(h.registry.size).toBe(0);
    expect(h.traceFiles()).toHaveLength(1); // 只有父 run
  });

  it("业务 schema 非法 ⇒ 不登记、不调用模型或代理", async () => {
    h.configure();
    h.setScript(ONE_TURN);
    const response = await execPromptFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(49, { parentRunId: "run_missing", edit: { field: "unknown_field", value: "x" } }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("INVALID_ARGUMENT");
    expect(response.operation).toBeNull();
    expect(h.registry.size).toBe(0);
    expect(h.llmCalls()).toBe(0);
  });
});

describe("3.3 proxy:fork：主动重发接入 registry", () => {
  it("成功：登记身份 = 本次 fork 返回的 id，目标只带定位事实不带 messages", async () => {
    const { parentId, atSpanId } = await h.makeParent();
    h.setProxyFork(async () => ({ id: FORK_RETURNED_ID }));
    const response = await execProxyFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(50, proxyRequest(parentId, atSpanId)),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.id).toBe(FORK_RETURNED_ID);
    const record = rec(opId(50));
    expect(record).toMatchObject({
      state: "settled",
      requestOutcome: "returned",
      target: { kind: "proxy", parentRunId: parentId, atSpanId },
      runIds: [FORK_RETURNED_ID],
    });
    // 登记里没有 messages / 编辑正文的位置（strict schema 保证，不是运行时清理）
    expect(JSON.stringify(record)).not.toContain("编辑后的重发消息");
    expect(h.proxyCalls()).toBe(1);
  });

  it("同 ID 重复 ⇒ 代理只被调用一次；running 期间的重复只等不二次调用", async () => {
    const { parentId, atSpanId } = await h.makeParent();
    const request = proxyRequest(parentId, atSpanId);
    const gate = deferred<void>();
    h.setProxyFork(async () => {
      await gate.promise;
      return { id: FORK_RETURNED_ID };
    });

    const running = execProxyFork(h.deps, TRUSTED_SENDER, envelope(51, request));
    await waitForState(h.registry, opId(51), "running");
    expect(h.proxyCalls()).toBe(1);

    const duplicate = execProxyFork(h.deps, TRUSTED_SENDER, envelope(51, request));
    await flush();
    expect(h.proxyCalls()).toBe(1);
    expect(rec(opId(51)).state).toBe("running");

    // 另一条主动入口在代理重发收尾前不被接受，且没碰模型
    const busy = await execPromptFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(52, promptRequest(parentId)),
    );
    expect(busy.ok).toBe(false);
    if (busy.ok) return;
    expect(busy.error.code).toBe(OPERATION_ERROR.notAccepted);
    expect(rec(opId(52))).toMatchObject({ state: "notAccepted", rejection: "busy" });
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toHaveLength(1);

    gate.resolve();
    const [first, again] = await Promise.all([running, duplicate]);
    expect(first.ok).toBe(true);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe(OPERATION_ERROR.duplicated);
    expect(again.operation).toMatchObject({ operationId: opId(51), state: "settled" });
    expect(h.proxyCalls()).toBe(1);
    expect(h.registry.activeId).toBeNull();
  });

  it("PROXY_* 拒绝（未捕获 key / 空 fork）：settled + 原稳定码 + 零身份，且重复不重试消费", async () => {
    const { parentId, atSpanId } = await h.makeParent();
    h.setProxyFork(() => {
      throw new ProxyForkError("PROXY_NO_KEY", "本会话未捕获到 key");
    });
    const response = await execProxyFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(53, proxyRequest(parentId, atSpanId)),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("PROXY_NO_KEY");
    expect(response.operation).toMatchObject({ operationId: opId(53), state: "settled" });
    const record = rec(opId(53));
    expect(record).toMatchObject({ state: "settled", requestOutcome: "rejected" });
    expect(record.runIds).toEqual([]);
    expect(h.proxyCalls()).toBe(1);
    expect(h.traceFiles()).toHaveLength(1);

    // 同 ID 重复：不重新执行，也不再消费一次代理
    const again = await execProxyFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(53, proxyRequest(parentId, atSpanId)),
    );
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe(OPERATION_ERROR.duplicated);
    expect(h.proxyCalls()).toBe(1);

    h.setProxyFork(() => {
      throw new ProxyForkError("PROXY_EMPTY_FORK", "编辑后与录制完全一致");
    });
    const empty = await execProxyFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(54, proxyRequest(parentId, atSpanId)),
    );
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe("PROXY_EMPTY_FORK");
    expect(rec(opId(54))).toMatchObject({ state: "settled", requestOutcome: "rejected" });
    expect(rec(opId(54)).runIds).toEqual([]);
  });

  it("重发等待期间被动录制落盘 ⇒ 登记只认本次 fork 的 id，不借用被动 run", async () => {
    const { parentId, atSpanId } = await h.makeParent();
    const { parentId: passiveId } = await h.makeParent();
    expect(h.traceFiles()).toHaveLength(2);
    h.setProxyFork(async () => {
      // 真实处境：等待上游返回期间，别的请求经代理被动录成了另一个 run
      return { id: FORK_RETURNED_ID };
    });
    const response = await execProxyFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(55, proxyRequest(parentId, atSpanId)),
    );
    expect(response.ok).toBe(true);
    const record = rec(opId(55));
    expect(record.runIds).toEqual([FORK_RETURNED_ID]);
    expect(record.runIds).not.toContain(passiveId);
    // 被动录制的两条记录原样在场，主动重发没有另写第三条
    expect(h.traceFiles()).toHaveLength(2);
  });

  it("本次录制写入失败 ⇒ 明确失败且不借用在场被动 run 的 id", async () => {
    const { parentId, atSpanId } = await h.makeParent();
    const { parentId: passiveId } = await h.makeParent();
    h.setProxyFork(() => {
      throw new ProxyForkError("PROXY_RECORDING_WRITE_FAILED", "本次重发的录制写入失败");
    });
    const response = await execProxyFork(
      h.deps,
      TRUSTED_SENDER,
      envelope(56, proxyRequest(parentId, atSpanId)),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("PROXY_RECORDING_WRITE_FAILED");
    const record = rec(opId(56));
    expect(record).toMatchObject({ state: "settled", requestOutcome: "rejected" });
    expect(record.runIds).toEqual([]);
    expect(record.runIds).not.toContain(passiveId);
    // 被动录制结果未被改写：两条既有记录都还在，且没有第三条
    expect(h.traceFiles()).toHaveLength(2);
    expect(readFileSync(join(h.traces, `${passiveId}.jsonl`), "utf8")).toContain(passiveId);
  });
});
