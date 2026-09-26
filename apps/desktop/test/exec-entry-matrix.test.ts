import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  execCreateRun,
  execForkRun,
  execModelAb,
  execModelAbPlan,
  execPromptFork,
  execProxyFork,
} from "../src/main/exec-endpoints";
import type { TrustedSender } from "../src/main/operation-endpoints";
import { readOperationStatus, reconcileOperation } from "../src/main/operation-endpoints";
import type { ExecutedResponse, OperationKind } from "../src/shared/operations";
import { OPERATION_ERROR } from "../src/shared/operations";
import { deferred } from "./helpers/deterministic-schedule";
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
 * U4 任务 3.7 + 3.8：七类主动入口的**参数化矩阵**（`通道 × 判据`，不是把同一断言手写第七遍）。
 *
 * 判据来源：tasks.md 3.7/3.8 + design D2/D3；delta spec `desktop-ui`。每行六条判据：
 * 1. 「同 ID 重复请求只执行一次」+「同 ID 异参和跨通道复用被拒绝」——同 ID 的**等价改写**
 *    （对象键序、显式 `undefined` 缺省）判 duplicated，**业务值不同**（正文空白、消息顺序、
 *    臂顺序）判 conflict；两种情况下四笔可数的副作用（真实模型调用 / traces 文件 /
 *    令牌消费 / 代理调用）都不增长，原登记一字不改；
 * 2. 「不同入口并发只有一个被接受」——另一笔请求 running 时本入口判 busy，
 *    且本入口副作用**恰为 0**（响应"看起来被拒"不算过，必须数出来）；
 * 3. 「指纹与执行使用同一解析快照」——真正交给编排的业务值 == 入口解析快照
 *    （逐通道取该通道自己的可观测点：落盘事实 / 进入模型的 messages / 代理桩捕获的对象），
 *    同时该行还要证明**正文与凭据没有进登记**；
 * 4. 「七类主动入口均绑定身份」+「旧 epoch 和非法身份无副作用」——旧 epoch、伪造 sender、
 *    缺身份信封都在任何副作用之前被拒且不产生登记；
 * 5. schema 段——业务形状非法 ⇒ 不登记、不执行（身份信封不能绕过既有领域门禁）；
 * 6. 「reconcile 先到封禁迟到提交」——先核对再提交 ⇒ notAccepted(reconcile_tombstone)，
 *    同 ID 无论同参异参都不复活，副作用与许可消费为零。
 *
 * 3.8 余下的"只读入口零授权"在文件末尾的独立 describe 里（status / modelAbPlan 在占槽期间
 * 照常可用、不登记、不追加模型调用、不消费令牌、不改当前槽）；隔离原门禁（父本匹配、
 * profile、写入授权字面量）已由 `test/exec-create-fork.test.ts` 逐条钉住，此处不重复。
 */

type AnyResponse = ExecutedResponse<Record<string, unknown>>;

/** 一次执行在该通道上应当留下的副作用（四笔全部可数出来） */
interface EffectCounts {
  llm: number;
  files: number;
  tokens: number;
  proxy: number;
}

/** 通道装配完成后交给矩阵的夹具 */
interface PreparedChannel {
  /** 合法业务请求 */
  request: Record<string, unknown>;
  /** 归一化后与 request **同指纹**的另一种写法（键序不同 / 显式给出可缺省的键） */
  equivalent: Record<string, unknown>;
  /** 归一化后与 request **不同指纹**的写法（正文空白 / 数组顺序） */
  divergent: Record<string, unknown>;
  /** 必被业务 schema 拒绝的载荷 */
  invalid: Record<string, unknown>;
  /** 成功执行一次应当留下的副作用增量 */
  effects: EffectCounts;
  /** 绝不该出现在登记与快照里的正文/凭据片段 */
  secrets: string[];
  /** 统一提交器（矩阵一律经它走该通道的真实入口）；sender 缺定为可信主 frame */
  submit: (payload: unknown, sender?: TrustedSender) => Promise<AnyResponse>;
  /** 让本通道的执行停在第一个副作用之前（LLM 通道走模型门，代理通道走桩门） */
  hold: (gate: Promise<void> | null) => void;
  /** 执行值核对：编排真正拿到的业务值必须等于解析快照 */
  verifyExecuted: (response: AnyResponse) => void;
}

interface ChannelRow {
  label: string;
  kind: OperationKind;
  prepare: () => Promise<PreparedChannel>;
}

let h: ExecHarness;
beforeEach(() => {
  h = openExecHarness();
});
afterEach(() => {
  h.cleanup();
});

const SYSTEM_PROMPT = "你是矩阵助手。";
const TASK_MESSAGE = "矩阵请求：一句话回答";
/** 只有该通道会用到的正文标记（判"登记不泄漏"时逐条查） */
const FORK_VALUE = "编辑后的工具结果（矩阵）";
const ISOLATED_VALUE = "编辑后的隔离世界内容（矩阵）";
const PROMPT_VALUE = "你是矩阵里的新系统提示词。";
const PROXY_MARK = "矩阵重发的消息正文";
const ARM_MODEL_A = "m-matrix-a";

function counts(): EffectCounts {
  return {
    llm: h.llmCalls(),
    files: h.traceFiles().length,
    tokens: h.tokenConsumes(),
    proxy: h.proxyCalls(),
  };
}

function diff(before: EffectCounts, after: EffectCounts): EffectCounts {
  return {
    llm: after.llm - before.llm,
    files: after.files - before.files,
    tokens: after.tokens - before.tokens,
    proxy: after.proxy - before.proxy,
  };
}

function sameEffects(left: EffectCounts, right: EffectCounts): void {
  expect(right).toEqual(left);
}

function rec(operationId: string) {
  const record = h.registry.recordOf(operationId);
  if (record === null) throw new Error(`登记里没有操作 ${operationId}`);
  return record;
}

function runOf(id: string): ReturnType<typeof readRun> {
  return readRun(join(h.traces, `${id}.jsonl`));
}

function okData(response: AnyResponse, label: string): Record<string, unknown> {
  if (!response.ok) {
    throw new Error(`unreachable：${label} 期望成功，实际 ${JSON.stringify(response.error)}`);
  }
  return response.data;
}

function codeOf(response: AnyResponse, label: string): string {
  if (response.ok) throw new Error(`unreachable：${label} 期望被拒，实际成功`);
  return response.error.code;
}

function idOf(response: AnyResponse, label: string): string {
  return okData(response, label).id as string;
}

/** 把各通道的 `ExecutedResponse<T>` 收成矩阵统一形状 */
function asAny<T extends object>(promise: Promise<ExecutedResponse<T>>): Promise<AnyResponse> {
  return promise as unknown as Promise<AnyResponse>;
}

function firstToolSpanOf(id: string): string {
  const span = runOf(id).spans.find((one) => one.kind === "tool.invoke");
  if (span === undefined) throw new Error(`run ${id} 没有 tool.invoke span`);
  return span.id;
}

const ISOLATED_SCRIPT = [
  { toolCalls: [{ id: "c1", name: "read_file", args: JSON.stringify({ path: "a.txt" }) }] },
  { content: "隔离矩阵完成。" },
];

const ARM_A = { model: ARM_MODEL_A, params: { temperature: 0.2 } };
const ARM_B = { model: "m-matrix-b" };

/** LLM 通道共用的门：设在夹具的"第一次模型调用之前" */
function llmHold(gate: Promise<void> | null): void {
  h.setGate(gate);
}

// ---------------------------------------------------------------------------
// 七行装配（每行自己准备世界，互不共享可变状态）
// ---------------------------------------------------------------------------

function prepareCreatePlain(): PreparedChannel {
  h.configure();
  h.setScript(ONE_TURN);
  const request = { systemPrompt: SYSTEM_PROMPT, userMessage: TASK_MESSAGE };
  return {
    request,
    // 未知字段由 schema 剥离 ⇒ 与不携带时是同一解析结果（指纹也必须按剥离后的快照算）
    equivalent: {
      userMessage: TASK_MESSAGE,
      systemPrompt: SYSTEM_PROMPT,
      workspace: undefined,
      legacyNote: "旧版本渲染层带来的未知字段",
    },
    divergent: { systemPrompt: SYSTEM_PROMPT, userMessage: `${TASK_MESSAGE} ` },
    invalid: { systemPrompt: SYSTEM_PROMPT, userMessage: "" },
    effects: { llm: 1, files: 1, tokens: 0, proxy: 0 },
    secrets: [SYSTEM_PROMPT, TASK_MESSAGE],
    submit: (payload, sender = TRUSTED_SENDER) => asAny(execCreateRun(h.deps, sender, payload)),
    hold: llmHold,
    verifyExecuted: (response) => {
      const record = runOf(idOf(response, "普通创建"));
      expect(record.meta.task).toBe(TASK_MESSAGE);
      const call = record.spans.find((span) => span.kind === "llm.call");
      if (call?.kind !== "llm.call") throw new Error("没有 llm.call 录制");
      // 进入模型的启动上下文逐字等于解析快照（不是原始 payload 的某种变体）
      expect(call.request.messages).toEqual([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: TASK_MESSAGE },
      ]);
    },
  };
}

function prepareCreateIsolated(): PreparedChannel {
  h.configure();
  h.setScript(ISOLATED_SCRIPT);
  const token = h.issueSource();
  const request = {
    systemPrompt: SYSTEM_PROMPT,
    userMessage: TASK_MESSAGE,
    workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
  };
  return {
    request,
    // 键序变化 + 顶层可缺省键显式给出 ⇒ 同一解析结果
    equivalent: {
      userMessage: TASK_MESSAGE,
      workspace: { allowFileWrites: true, sourceToken: token, mode: "isolated_files" },
      systemPrompt: SYSTEM_PROMPT,
    },
    divergent: {
      systemPrompt: SYSTEM_PROMPT,
      userMessage: `${TASK_MESSAGE} `,
      workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
    },
    invalid: {
      systemPrompt: SYSTEM_PROMPT,
      userMessage: TASK_MESSAGE,
      workspace: { mode: "isolated_files", sourceToken: "", allowFileWrites: true },
    },
    // 隔离剧本两轮（一次工具调用 + 一次收尾）⇒ 模型调用 2 次、令牌恰 1 次
    effects: { llm: 2, files: 1, tokens: 1, proxy: 0 },
    secrets: [SYSTEM_PROMPT, TASK_MESSAGE, token],
    submit: (payload, sender = TRUSTED_SENDER) => asAny(execCreateRun(h.deps, sender, payload)),
    hold: llmHold,
    verifyExecuted: (response) => {
      const id = idOf(response, "隔离创建");
      const record = runOf(id);
      // 登记身份就是世界 id（checkpoint tracer 替换后的最终 meta.id）
      expect(record.meta.workspace?.world_id).toBe(id);
      expect(rec(opId(1)).runIds).toEqual([id]);
    },
  };
}

async function prepareForkPlain(): Promise<PreparedChannel> {
  const parent = await h.makeParent();
  h.configure();
  h.setScript(ONE_TURN);
  const request = {
    parentRunId: parent.parentId,
    atSpanId: parent.atSpanId,
    edit: { field: "result", value: FORK_VALUE },
  };
  return {
    request,
    equivalent: {
      edit: { value: FORK_VALUE, field: "result" },
      atSpanId: parent.atSpanId,
      parentRunId: parent.parentId,
      execution: undefined,
    },
    divergent: {
      parentRunId: parent.parentId,
      atSpanId: parent.atSpanId,
      edit: { field: "result", value: `${FORK_VALUE} ` },
    },
    invalid: {
      parentRunId: parent.parentId,
      atSpanId: parent.atSpanId,
      edit: { field: "args", value: FORK_VALUE },
    },
    effects: { llm: 1, files: 1, tokens: 0, proxy: 0 },
    secrets: [FORK_VALUE],
    submit: (payload, sender = TRUSTED_SENDER) => asAny(execForkRun(h.deps, sender, payload)),
    hold: llmHold,
    verifyExecuted: (response) => {
      const record = runOf(idOf(response, "普通 result 分叉"));
      expect(record.meta.parent).toBe(parent.parentId);
      expect(record.meta.fork?.edit.value).toBe(FORK_VALUE);
      expect(record.meta.fork?.at_span).toBe(parent.atSpanId);
    },
  };
}

async function prepareForkIsolated(): Promise<PreparedChannel> {
  h.configure();
  h.setScript(ISOLATED_SCRIPT);
  const created = await asAny(
    execCreateRun(h.deps, TRUSTED_SENDER, {
      operation: { epoch: EXEC_EPOCH, operationId: opId(500) },
      request: {
        systemPrompt: SYSTEM_PROMPT,
        userMessage: TASK_MESSAGE,
        workspace: {
          mode: "isolated_files",
          sourceToken: h.issueSource(),
          allowFileWrites: true,
        },
      },
    }),
  );
  const parentId = idOf(created, "隔离父本");
  const atSpanId = firstToolSpanOf(parentId);
  h.setScript(ONE_TURN);
  const request = {
    parentRunId: parentId,
    atSpanId,
    edit: { field: "result", value: ISOLATED_VALUE },
    execution: { mode: "isolated_files", allowFileWrites: true },
  };
  return {
    request,
    equivalent: {
      execution: { allowFileWrites: true, mode: "isolated_files" },
      edit: { value: ISOLATED_VALUE, field: "result" },
      atSpanId,
      parentRunId: parentId,
    },
    divergent: {
      parentRunId: parentId,
      atSpanId,
      edit: { field: "result", value: `${ISOLATED_VALUE} ` },
      execution: { mode: "isolated_files", allowFileWrites: true },
    },
    // 写入授权必须是字面量 true：false 在 schema 层即拒（不允许漏授权后落到普通分支）
    invalid: {
      parentRunId: parentId,
      atSpanId,
      edit: { field: "result", value: ISOLATED_VALUE },
      execution: { mode: "isolated_files", allowFileWrites: false },
    },
    effects: { llm: 1, files: 1, tokens: 0, proxy: 0 },
    secrets: [ISOLATED_VALUE],
    submit: (payload, sender = TRUSTED_SENDER) => asAny(execForkRun(h.deps, sender, payload)),
    hold: llmHold,
    verifyExecuted: (response) => {
      const id = idOf(response, "隔离 result 分叉");
      const record = runOf(id);
      expect(record.meta.workspace?.world_id).toBe(id);
      expect(record.meta.parent).toBe(parentId);
      expect(record.meta.fork?.edit.value).toBe(ISOLATED_VALUE);
    },
  };
}

async function preparePromptFork(): Promise<PreparedChannel> {
  const parent = await h.makeParent();
  h.configure();
  h.setScript(ONE_TURN);
  const request = {
    parentRunId: parent.parentId,
    edit: { field: "system_prompt", value: PROMPT_VALUE },
  };
  return {
    request,
    equivalent: {
      edit: { value: PROMPT_VALUE, field: "system_prompt" },
      parentRunId: parent.parentId,
    },
    divergent: {
      parentRunId: parent.parentId,
      edit: { field: "system_prompt", value: `${PROMPT_VALUE} ` },
    },
    invalid: {
      parentRunId: parent.parentId,
      edit: { field: "model_params", value: PROMPT_VALUE },
    },
    effects: { llm: 1, files: 1, tokens: 0, proxy: 0 },
    secrets: [PROMPT_VALUE],
    submit: (payload, sender = TRUSTED_SENDER) => asAny(execPromptFork(h.deps, sender, payload)),
    hold: llmHold,
    verifyExecuted: (response) => {
      // 执行侧真实收到的 messages 首条就是编辑后的值（双真相源覆写生效）
      const first = h.llmRequests()[0] as Array<{ role: string; content: string }>;
      expect(first[0]).toEqual({ role: "system", content: PROMPT_VALUE });
      expect(runOf(idOf(response, "prompt 分叉")).meta.fork?.edit.field).toBe("system_prompt");
    },
  };
}

async function prepareProxyFork(): Promise<PreparedChannel> {
  const parent = await h.makeParent();
  h.configure();
  const messages = [
    { role: "system", content: PROXY_MARK },
    { role: "user", content: "甲" },
    { role: "assistant", content: "乙" },
  ];
  const seen: Record<string, unknown>[] = [];
  let hold: Promise<void> | null = null;
  h.setProxyFork(async (request) => {
    if (hold !== null) await hold;
    seen.push(request as Record<string, unknown>);
    return { id: "run_matrix_proxy" };
  });
  const request = { parentRunId: parent.parentId, atSpanId: parent.atSpanId, messages };
  return {
    request,
    // 消息对象**内部**的键序变化是同一请求（规范化递归排序）
    equivalent: {
      messages: messages.map(({ role, content }) => ({ content, role })),
      atSpanId: parent.atSpanId,
      parentRunId: parent.parentId,
    },
    // 消息**顺序**变化是业务差异
    divergent: {
      parentRunId: parent.parentId,
      atSpanId: parent.atSpanId,
      messages: [messages[1], messages[0], messages[2]],
    },
    invalid: { parentRunId: parent.parentId, atSpanId: parent.atSpanId, messages: [] },
    effects: { llm: 0, files: 0, tokens: 0, proxy: 1 },
    secrets: [PROXY_MARK],
    submit: (payload, sender = TRUSTED_SENDER) => asAny(execProxyFork(h.deps, sender, payload)),
    hold: (gate) => {
      hold = gate;
    },
    verifyExecuted: (response) => {
      expect(idOf(response, "代理重发")).toBe("run_matrix_proxy");
      const received = seen[0];
      if (received === undefined) throw new Error("代理桩没收到请求");
      // 桩收到的就是解析快照：值相等 + 整棵子树深冻结（不是调用方那个对象）
      expect(received).toEqual(request);
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen((received.messages as unknown[])[0])).toBe(true);
    },
  };
}

async function prepareModelAb(): Promise<PreparedChannel> {
  const parentId = await h.makePureParent();
  h.configure();
  h.setScript([{ content: "臂 A 完成。" }, { content: "臂 B 完成。" }]);
  const request = { parentRunId: parentId, arms: [ARM_A, ARM_B] };
  return {
    request,
    // 臂对象内键序 + 显式 undefined 的 dryRun ⇒ 同一解析结果
    equivalent: {
      dryRun: undefined,
      parentRunId: parentId,
      arms: [{ params: { temperature: 0.2 }, model: ARM_MODEL_A }, ARM_B],
    },
    // 臂顺序是业务差异
    divergent: { parentRunId: parentId, arms: [ARM_B, ARM_A] },
    invalid: { parentRunId: parentId, arms: [ARM_A] },
    effects: { llm: 2, files: 2, tokens: 0, proxy: 0 },
    secrets: [ARM_MODEL_A, "m-matrix-b"],
    submit: (payload, sender = TRUSTED_SENDER) => asAny(execModelAb(h.deps, sender, payload)),
    hold: llmHold,
    verifyExecuted: (response) => {
      const data = okData(response, "A/B 执行");
      const plan = data.plan as Array<{ model: string; params: Record<string, unknown> }>;
      // 臂顺序与参数值都是快照原样（不重排、不宽化、不合并）
      expect(plan.map((one) => one.model)).toEqual([ARM_MODEL_A, "m-matrix-b"]);
      expect(plan[0]?.params.temperature).toBe(0.2);
      const ids = data.ids as string[];
      expect(ids).toHaveLength(2);
      for (const id of ids) {
        expect(runOf(id).meta.fork?.edit.field).toBe("model_params");
      }
      expect(rec(opId(1)).arms.map((arm) => arm.id)).toEqual(ids);
    },
  };
}

const ROWS: ChannelRow[] = [
  { label: "create 普通", kind: "create", prepare: async () => prepareCreatePlain() },
  { label: "create 隔离", kind: "create", prepare: async () => prepareCreateIsolated() },
  { label: "result fork 普通", kind: "result", prepare: prepareForkPlain },
  { label: "result fork 隔离", kind: "result", prepare: prepareForkIsolated },
  { label: "prompt fork", kind: "prompt", prepare: preparePromptFork },
  { label: "proxy messages 重发", kind: "proxy", prepare: prepareProxyFork },
  { label: "A/B 实际执行", kind: "modelAb", prepare: prepareModelAb },
];

describe.each(ROWS)("U4 3.7 矩阵：$label", (row) => {
  it("同 ID 等价改写判 duplicated、异参判 conflict，四笔副作用计数都不增长", async () => {
    const prepared = await row.prepare();
    // 登记条数按"本行新增"算：隔离行的夹具自己要先造出一个世界父本（那是一笔真操作）
    const baseOps = h.registry.size;
    const id = opId(1);
    const beforeFirst = counts();
    const first = await prepared.submit(envelope(1, prepared.request));
    expect(first.ok).toBe(true);
    expect(diff(beforeFirst, counts())).toEqual(prepared.effects);
    expect(rec(id)).toMatchObject({ state: "settled", target: { kind: row.kind } });
    const after = counts();

    // 等价写法（键序 / 显式 undefined 缺省）关联原操作：不重跑
    const same = await prepared.submit(envelope(1, prepared.equivalent));
    expect(codeOf(same, "等价改写")).toBe(OPERATION_ERROR.duplicated);
    expect(same.operation).toMatchObject({ operationId: id, state: "settled" });
    sameEffects(after, counts());
    expect(h.registry.size).toBe(baseOps + 1);

    // 业务值不同（正文空白 / 消息顺序 / 臂顺序）⇒ conflict，原登记一字不改
    const other = await prepared.submit(envelope(1, prepared.divergent));
    expect(codeOf(other, "异参改写")).toBe(OPERATION_ERROR.conflict);
    sameEffects(after, counts());
    expect(h.registry.size).toBe(baseOps + 1);
    expect(rec(id).state).toBe("settled");
  });

  it("并发只有一个被接受：另一笔 running 时本入口判 busy，且本入口副作用恰为 0", async () => {
    const prepared = await row.prepare();
    const gate = deferred<void>();
    prepared.hold(gate.promise);
    const holder = prepared.submit(envelope(1, prepared.divergent));
    await waitForState(h.registry, opId(1), "running");
    const before = counts();

    const rejected = await prepared.submit(envelope(2, prepared.request));
    expect(codeOf(rejected, "跨入口忙碌")).toBe(OPERATION_ERROR.notAccepted);
    expect(rec(opId(2))).toMatchObject({ state: "notAccepted", rejection: "busy" });
    sameEffects(before, counts());
    // 忙碌请求没有把槽抢走：owner 仍是被 accepted 的那一笔
    expect(h.registry.activeId).toBe(opId(1));

    gate.resolve();
    const done = await holder;
    expect(done.ok).toBe(true);
    expect(h.registry.activeId).toBeNull();
    // 被拒的那笔永久封禁：放行后同 ID 迟到提交也不会复活
    const late = await prepared.submit(envelope(2, prepared.request));
    expect(codeOf(late, "封禁后的迟到提交")).toBe(OPERATION_ERROR.notAccepted);
  });

  it("实际编排入参 == 解析快照，且登记里既无正文也无凭据", async () => {
    const prepared = await row.prepare();
    const baseOps = h.registry.size;
    const response = await prepared.submit(envelope(1, prepared.request));
    expect(response.ok).toBe(true);
    prepared.verifyExecuted(response);

    const dumped = JSON.stringify(h.registry.snapshot());
    for (const secret of prepared.secrets) {
      expect(dumped, `登记快照不应包含 ${secret}`).not.toContain(secret);
    }
    // 受限元数据仍要过 schema（快照自证：main 造出自相矛盾的记录会当场抛）
    expect(h.registry.snapshot().operations).toHaveLength(baseOps + 1);
  });

  it("旧 epoch / 伪造 sender / 缺身份信封：副作用之前被拒，不产生登记", async () => {
    const prepared = await row.prepare();
    const baseOps = h.registry.size;
    const before = counts();
    const stale = await prepared.submit(
      envelope(1, prepared.request, "99999999-9999-4999-8999-999999999999"),
    );
    expect(codeOf(stale, "旧 epoch")).toBe(OPERATION_ERROR.staleEpoch);
    const untrusted = await prepared.submit(envelope(2, prepared.request), UNTRUSTED_SENDER);
    expect(codeOf(untrusted, "伪造 sender")).toBe(OPERATION_ERROR.untrustedSender);
    const bare = await prepared.submit(prepared.request);
    expect(codeOf(bare, "缺身份信封")).toBe(OPERATION_ERROR.invalidIdentity);
    for (const response of [stale, untrusted, bare]) {
      expect(response.operation).toBeNull();
    }
    expect(h.registry.size).toBe(baseOps);
    sameEffects(before, counts());
  });

  it("业务 schema 非法 ⇒ 不登记、不执行（身份信封不能绕过领域门禁）", async () => {
    const prepared = await row.prepare();
    const baseOps = h.registry.size;
    const before = counts();
    const response = await prepared.submit(envelope(1, prepared.invalid));
    expect(codeOf(response, "非法业务形状")).toBe("INVALID_ARGUMENT");
    expect(response.operation).toBeNull();
    expect(h.registry.size).toBe(baseOps);
    sameEffects(before, counts());
  });

  it("reconcile 先到 ⇒ 本入口同 ID 提交被封禁，不重试执行也不消费许可", async () => {
    const prepared = await row.prepare();
    const before = counts();
    const bannedId = opId(1);
    const endpointDeps = {
      registry: h.registry,
      isTrustedSender: h.deps.isTrustedSender,
    };
    const tombstone = reconcileOperation(endpointDeps, TRUSTED_SENDER, {
      epoch: EXEC_EPOCH,
      operationId: bannedId,
    });
    if (!tombstone.ok) throw new Error("unreachable：核对应当建立封禁");
    expect(tombstone.data.operation).toMatchObject({
      state: "notAccepted",
      rejection: "reconcile_tombstone",
      target: null,
      runIds: [],
    });

    const late = await prepared.submit(envelope(1, prepared.request));
    expect(codeOf(late, "封禁后的正式请求")).toBe(OPERATION_ERROR.notAccepted);
    expect(late.operation).toMatchObject({ operationId: bannedId, state: "notAccepted" });
    // 同参、异参都不复活（封禁判定连指纹都不比）
    const again = await prepared.submit(envelope(1, prepared.divergent));
    expect(codeOf(again, "封禁后的异参请求")).toBe(OPERATION_ERROR.notAccepted);
    expect(rec(bannedId).rejection).toBe("reconcile_tombstone");
    sameEffects(before, counts());
  });
});

describe("U4 3.8 只读入口：占槽期间照常可用、零授权消费、不登记", () => {
  it("A/B 批次 running 时 status 与只读预览都可用，且不追加调用/不写文件/不动槽", async () => {
    const parentId = await h.makePureParent();
    h.configure();
    const token = h.issueSource();
    const gate = deferred<void>();
    h.setGate(gate.promise);
    const holder = execModelAb(
      h.deps,
      TRUSTED_SENDER,
      envelope(9, {
        parentRunId: parentId,
        arms: [ARM_A, ARM_B],
      }),
    );
    await waitForState(h.registry, opId(9), "running");
    const calls = h.llmCalls();
    const files = h.traceFiles();

    const status = readOperationStatus(
      { registry: h.registry, isTrustedSender: h.deps.isTrustedSender },
      TRUSTED_SENDER,
    );
    if (!status.ok) throw new Error("unreachable：status 应当可用");
    expect(status.data.activeOperationId).toBe(opId(9));
    expect(status.data.operations.map((one) => one.operationId)).toEqual([opId(9)]);

    const plan = await execModelAbPlan(h.deps, TRUSTED_SENDER, {
      parentRunId: parentId,
      arms: [ARM_A, ARM_B],
      dryRun: true,
    });
    expect(plan.ok).toBe(true);
    // 只读预览：不登记、不追加模型调用、不占/不释放槽、不消费目录令牌
    expect(h.registry.size).toBe(1);
    expect(h.llmCalls()).toBe(calls);
    expect(h.traceFiles()).toEqual(files);
    expect(h.tokenConsumes()).toBe(0);
    expect(h.registry.activeId).toBe(opId(9));
    expect(JSON.stringify(h.registry.snapshot())).not.toContain(token);

    gate.resolve();
    const done = await holder;
    expect(done.ok).toBe(true);
    expect(h.registry.activeId).toBeNull();
  });

  it("令牌只被**已被接受**的那一笔消费：busy 拒绝不消耗一次许可", async () => {
    h.configure();
    h.setScript(ISOLATED_SCRIPT);
    const first = h.issueSource();
    const second = h.issueSource();
    const gate = deferred<void>();
    h.setGate(gate.promise);
    const holder = execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(10, {
        systemPrompt: SYSTEM_PROMPT,
        userMessage: TASK_MESSAGE,
        workspace: { mode: "isolated_files", sourceToken: first, allowFileWrites: true },
      }),
    );
    await waitForState(h.registry, opId(10), "running");
    // 被接受的那笔已经在执行序列里消费了自己的令牌
    expect(h.tokenConsumes()).toBe(1);
    // 占槽期间第二次提交：连第二枚令牌都不碰（判重先于许可消费）
    const rejected = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(11, {
        systemPrompt: SYSTEM_PROMPT,
        userMessage: "被 busy 拒的第二次提交",
        workspace: { mode: "isolated_files", sourceToken: second, allowFileWrites: true },
      }),
    );
    expect(rejected.ok).toBe(false);
    expect(h.tokenConsumes()).toBe(1);
    gate.resolve();
    const done = await holder;
    expect(done.ok).toBe(true);
    expect(h.tokenConsumes()).toBe(1);
    // 第二枚令牌没被"未执行的请求"烧掉：换新 ID 仍可正常消费
    h.setScript(ISOLATED_SCRIPT); // 上一笔已把剧本走完，换新一轮才测得到"令牌可用"而不是"模型耗尽"
    const later = await execCreateRun(
      h.deps,
      TRUSTED_SENDER,
      envelope(12, {
        systemPrompt: SYSTEM_PROMPT,
        userMessage: "槽释放后用第二枚令牌提交",
        workspace: { mode: "isolated_files", sourceToken: second, allowFileWrites: true },
      }),
    );
    expect(later.ok).toBe(true);
    expect(h.tokenConsumes()).toBe(2);
  });
});
