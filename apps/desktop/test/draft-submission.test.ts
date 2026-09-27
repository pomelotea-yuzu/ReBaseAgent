import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { CallDraftKey, ModelAbDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import { deriveDraftList } from "../src/renderer/src/lib/draft-list";
import { captureCallDraftSource } from "../src/renderer/src/lib/draft-source";
import { CREATE_SUBMIT_TARGET } from "../src/renderer/src/lib/draft-submission";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import type { DraftSubmission } from "../src/renderer/src/lib/draft-submission";
import * as sessionLib from "../src/renderer/src/lib/operation-session";
import type { RunDetail } from "../src/shared/ipc";
import { executedFail, executedOk, installOperationChannels } from "./helpers/operation-channels";

/**
 * U3（preserve-debugging-drafts）任务 3.4/3.5：提交绑定草稿快照并冻结，响应不清草稿。
 *
 * 判据来源（tasks 3.4/3.5 验收 + delta「提交绑定草稿修订且响应不清除草稿」）：
 *   - 提交快照独立于编辑器挂载（冻结在 store；卸载、resetFork/resetCreateRun/resetModelAb、
 *     展示状态复位都不是解冻依据）
 *   - 成功、业务拒绝、部分臂失败均保留草稿；已明确返回才解冻；通道抛错（状态未知）保留冻结
 *   - 迟到回调不解冻新提交；冻结只影响指定目标（调用类单字段 / A-B 整批 / 创建整份）
 *
 * ⚠️ 本包无 jsdom ⇒ 源码级接线契约 + store 同形调用行为；实机往返归 CDP（任务 6.3）。
 */

const DETAIL_PANEL = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
  "utf8",
);
const CREATE_WORKSPACE = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/CreateRunWorkspace.tsx"),
  "utf8",
);
const STORE_SRC = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/store.ts"),
  "utf8",
);

function slice(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start + 1);
  if (start < 0 || end < 0 || end <= start) throw new Error(`切片失败：${startMarker}`);
  return src.slice(start, end);
}

// ---------------------------------------------------------------------------
// 纯逻辑：登记 / 令牌匹配收尾 / 冻结隔离
// ---------------------------------------------------------------------------

describe("纯逻辑：提交关联的登记与收尾（任务 3.4/3.5）", () => {
  const keyA: CallDraftKey = { runId: "r_01", spanId: "s_03", field: "result" };
  const keyB: CallDraftKey = { runId: "r_01", spanId: "s_03", field: "messages" };
  const abKey: ModelAbDraftKey = { runId: "r_01", spanId: "s_02" };
  const begin = (
    store: subLib.SubmissionStore,
    target: subLib.DraftSubmitTarget,
    submittedRevision: number,
    submittedText: string,
    channel: subLib.DraftSubmitChannel = "result",
  ): subLib.BeginSubmissionResult =>
    // epoch 固定 null：本文件钉"登记 / 令牌 / 冻结"，U5 的收尾关联只服务**真正发出过**的提交
    subLib.beginSubmission(store, {
      channel,
      target,
      submittedRevision,
      submittedText,
      operationId: crypto.randomUUID(),
      epoch: null,
    });

  it("登记取当前修订与请求快照，令牌单调递增", () => {
    const empty = subLib.emptySubmissionStore();
    const first = begin(empty, keyA, 7, "编辑后的结果");
    expect(first.submission).not.toBeNull();
    expect(first.submission!.submittedRevision).toBe(7);
    expect(first.submission!.submittedText).toBe("编辑后的结果");
    expect(first.submission!.channel).toBe("result");
    expect(first.submission!.target).toEqual(keyA);
    expect(subLib.submissionOf(first.store, keyA)?.token).toBe(first.submission!.token);

    // 另一目标另行登记 ⇒ 令牌递增（旧关联的令牌不会与后续提交相同）
    const second = begin(first.store, keyB, 9, "[]", "messages");
    expect(second.submission!.token).toBeGreaterThan(first.submission!.token);
    // 两个目标各自冻结，互不影响
    expect(subLib.submissionOf(second.store, keyA)).toBeDefined();
    expect(subLib.submissionOf(second.store, keyB)).toBeDefined();
  });

  it("同目标重复登记被拒且不换令牌（旧请求的响应仍能收尾）", () => {
    const empty = subLib.emptySubmissionStore();
    const first = begin(empty, keyA, 3, "a");
    const again = begin(first.store, keyA, 4, "b");
    expect(again.submission).toBeNull();
    // 仓库引用不变：既不覆盖旧关联，也不推进令牌
    expect(again.store).toBe(first.store);
    expect(subLib.submissionOf(again.store, keyA)).toBe(first.submission);
  });

  it("收尾只认同令牌：旧关联（迟到回调）不解冻后来发起的新提交", () => {
    const empty = subLib.emptySubmissionStore();
    const first = begin(empty, keyA, 3, "a");
    const settledFirst = subLib.settleSubmission(first.store, first.submission!);
    expect(subLib.submissionOf(settledFirst, keyA)).toBeUndefined();

    // 第二次提交（新令牌）
    const second = begin(settledFirst, keyA, 5, "b");
    // 迟到的旧关联收尾：令牌不同 ⇒ 不动新提交
    const afterLateSettle = subLib.settleSubmission(second.store, first.submission!);
    expect(afterLateSettle).toBe(second.store);
    expect(subLib.submissionOf(afterLateSettle, keyA)).toBe(second.submission);

    // 幂等：重复收尾同令牌不报错、引用不变
    const settledSecond = subLib.settleSubmission(second.store, second.submission!);
    expect(subLib.settleSubmission(settledSecond, second.submission!)).toBe(settledSecond);
  });

  it("三类目标标识与草稿列表 listKey 同编码（防两套编码漂移）", () => {
    // 真实仓库同时含调用类 / A-B / 创建三区，逐条与列表 listKey 对照
    let repo = draftLib.ensureCallDraft(draftLib.emptyDraftRepo(), keyA, "b").repo;
    repo = draftLib.setModelAbRows(
      draftLib.ensureModelAbDraft(repo, abKey, [{ model: "m", paramsText: "" }]).repo,
      abKey,
      [
        { key: "arm-1", model: "m-a", paramsText: "" },
        { key: "arm-2", model: "m-b", paramsText: "" },
      ],
    );
    repo = draftLib.writeCreateRunDraft(draftLib.ensureCreateRunDraft(repo).repo, {
      userMessage: "任务",
    });

    const listKeys = new Map(deriveDraftList(repo).map((item) => [item.field, item.listKey]));
    expect(subLib.submissionIdOf(keyA)).toBe(listKeys.get("result"));
    expect(subLib.submissionIdOf(abKey)).toBe(listKeys.get("model_ab"));
    expect(subLib.submissionIdOf(CREATE_SUBMIT_TARGET)).toBe(listKeys.get("create"));
  });
});

// ---------------------------------------------------------------------------
// store 行为：冻结拦截、响应收尾、未知状态保留
// ---------------------------------------------------------------------------

const FIXTURE = resolve(import.meta.dirname, "../../../packages/trace-sdk/fixtures/normal.jsonl");
const record: RunRecord = readRun(FIXTURE);

function detailFrom(rec: RunRecord): RunDetail {
  return {
    meta: rec.meta,
    spans: rec.spans,
    events: rec.events,
    status: rec.status,
    chain: [{ meta: rec.meta, fork: rec.meta.fork }],
    leafSpanIds: rec.spans.map((s) => s.id),
  };
}

const detail = detailFrom(record);
const toolSpan = detail.spans.find((s) => s.kind === "tool.invoke");
const firstLlmSpan = detail.spans.find((s) => s.id === "s_02");
if (toolSpan === undefined || firstLlmSpan === undefined) {
  throw new Error("fixture 缺少 tool.invoke / 首个 llm.call span");
}

// store 接线（模块读 window.api，桩须先于动态 import 就位）
(globalThis as Record<string, unknown>).window = { api: {} };
const api = (globalThis.window as unknown as { api: Record<string, unknown> }).api;
// U4：每个主动入口都先握手取 epoch，再带 {operation, request} 提交
installOperationChannels(api);
const { useAppStore } = await import("../src/renderer/src/store");

const RESULT_KEY: CallDraftKey = { runId: detail.meta.id, spanId: toolSpan.id, field: "result" };
const MESSAGES_KEY: CallDraftKey = { runId: detail.meta.id, spanId: "s_02", field: "messages" };
const AB_KEY: ModelAbDraftKey = { runId: detail.meta.id, spanId: "s_02" };
const CALL_SOURCE = captureCallDraftSource(detail, firstLlmSpan);
const AB_BASELINE = [
  { model: "deepseek-chat", paramsText: "" },
  { model: "deepseek-chat", paramsText: "" },
];

/** 列表与详情桩：成功收尾路径会刷新列表并选中新 run */
function stubVictoryPath(): void {
  api.listRuns = async () => ({ ok: true as const, data: { runs: [], failed: [] } });
  api.getRun = async (id: string) => ({
    ok: true as const,
    data: {
      ...detail,
      meta: { ...detail.meta, id },
      chain: [{ meta: { ...detail.meta, id }, fork: detail.meta.fork }],
    },
  });
  api.forkRun = executedOk({ id: "run_forked" });
  api.promptFork = executedOk({ id: "run_prompt_forked" });
  api.proxyFork = executedOk({ id: "run_proxy_forked" });
  api.createRun = executedOk({ id: "run_created" });
}

function resetDraftState(): void {
  useAppStore.setState({
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: subLib.emptySubmissionStore(),
    forking: "idle",
    creatingRun: "idle",
    modelAbInFlight: false,
    operations: sessionLib.initialSession(),
  });
}

describe("store 行为：调用类提交冻结与收尾（任务 3.4）", () => {
  beforeEach(() => {
    resetDraftState();
    stubVictoryPath();
  });

  /** 编辑器同形：打开登记基线 → 编辑 → 提交登记关联 */
  function openAndSubmitEdit(text: string): DraftSubmission {
    const store = useAppStore.getState();
    store.ensureCallDraft(RESULT_KEY, "原结果", captureCallDraftSource(detail, toolSpan));
    store.writeCallDraftText(RESULT_KEY, text);
    const assoc = store.beginDraftSubmission({ channel: "result", target: RESULT_KEY });
    if (assoc === null) throw new Error("登记提交关联失败");
    return assoc;
  }

  it("冻结期间仓库拒绝写入与放弃；快照与原条目原样", () => {
    const assoc = openAndSubmitEdit("编辑后的结果");
    const frozenRepo = useAppStore.getState().drafts;
    const frozenEntry = useAppStore.getState().callDraftOf(RESULT_KEY)!;

    useAppStore.getState().writeCallDraftText(RESULT_KEY, "冻结期间偷改");
    expect(useAppStore.getState().drafts).toBe(frozenRepo);
    expect(useAppStore.getState().callDraftOf(RESULT_KEY)).toBe(frozenEntry);
    expect(frozenEntry.text).toBe("编辑后的结果");

    // 放弃（含迟到确认）同样被拒：待定请求引用的就是这份快照
    expect(useAppStore.getState().discardCallDraft(RESULT_KEY, assoc.submittedRevision)).toBe(
      false,
    );
    expect(useAppStore.getState().callDraftOf(RESULT_KEY)).toBe(frozenEntry);

    // 冻结只影响该目标：另一个字段/另一条 run 仍可正常编辑与放弃
    const other: CallDraftKey = { runId: detail.meta.id, spanId: "s_02", field: "system_prompt" };
    useAppStore.getState().ensureCallDraft(other, "sys", CALL_SOURCE);
    useAppStore.getState().writeCallDraftText(other, "sys 改");
    const otherAfter = useAppStore.getState().callDraftOf(other)!;
    expect(otherAfter.text).toBe("sys 改");
    expect(useAppStore.getState().discardCallDraft(other, otherAfter.revision)).toBe(true);
    expect(useAppStore.getState().callDraftOf(other)).toBeUndefined();
  });

  it("提交快照独立于编辑器挂载：resetFork 与展示状态复位后仍冻结", () => {
    const assoc = openAndSubmitEdit("挂载外的快照");
    expect(useAppStore.getState().isDraftFrozen(RESULT_KEY)).toBe(true);

    // 编辑器卸载 / 收起走的正是这些路径（design D5：它们不是解冻依据）
    useAppStore.getState().resetFork();
    useAppStore.setState({ detail: null, selectedRunId: null, view: "trace" });

    expect(useAppStore.getState().isDraftFrozen(RESULT_KEY)).toBe(true);
    expect(useAppStore.getState().callDraftOf(RESULT_KEY)!.text).toBe(assoc.submittedText);
    expect(assoc.submittedText).toBe("挂载外的快照");
  });

  it("成功响应收尾（解冻）但草稿保留原文", async () => {
    const assoc = openAndSubmitEdit("成功也要留草稿");
    api.forkRun = executedOk({ id: "run_forked" });

    expect(
      await useAppStore
        .getState()
        .forkAt("r_01", toolSpan.id, assoc.submittedText, undefined, assoc),
    ).toBe(true);
    expect(useAppStore.getState().isDraftFrozen(RESULT_KEY)).toBe(false);
    expect(useAppStore.getState().callDraftOf(RESULT_KEY)!.text).toBe("成功也要留草稿");
  });

  it("业务拒绝同样收尾（可重新提交）且草稿保留；三个通道一致", async () => {
    // result（forkAt）
    const resultAssoc = openAndSubmitEdit("失败也留草稿");
    api.forkRun = executedFail("BUSINESS_REJECTED", "拒绝");
    expect(
      await useAppStore
        .getState()
        .forkAt("r_01", toolSpan.id, resultAssoc.submittedText, undefined, resultAssoc),
    ).toBe(false);
    expect(useAppStore.getState().isDraftFrozen(RESULT_KEY)).toBe(false);
    expect(useAppStore.getState().callDraftOf(RESULT_KEY)!.text).toBe("失败也留草稿");

    // prompt（promptFork）
    const promptKey: CallDraftKey = {
      runId: detail.meta.id,
      spanId: "s_02",
      field: "user_message",
    };
    useAppStore.getState().ensureCallDraft(promptKey, "旧问题", CALL_SOURCE);
    useAppStore.getState().writeCallDraftText(promptKey, "新问题");
    const promptAssoc = useAppStore
      .getState()
      .beginDraftSubmission({ channel: "prompt", target: promptKey })!;
    api.promptFork = executedFail("X", "拒绝");
    expect(
      await useAppStore
        .getState()
        .promptFork(
          "r_01",
          { field: "user_message", value: promptAssoc.submittedText },
          promptAssoc,
        ),
    ).toBe(false);
    expect(useAppStore.getState().isDraftFrozen(promptKey)).toBe(false);
    expect(useAppStore.getState().callDraftOf(promptKey)!.text).toBe("新问题");

    // messages（proxyFork）
    useAppStore.getState().ensureCallDraft(MESSAGES_KEY, "[]", CALL_SOURCE);
    useAppStore.getState().writeCallDraftText(MESSAGES_KEY, '[{"role":"user"}]');
    const msgAssoc = useAppStore
      .getState()
      .beginDraftSubmission({ channel: "messages", target: MESSAGES_KEY })!;
    api.proxyFork = executedFail("PROXY_NO_KEY", "拒绝");
    expect(await useAppStore.getState().proxyFork("r_01", "s_02", [], msgAssoc)).toBe(false);
    expect(useAppStore.getState().isDraftFrozen(MESSAGES_KEY)).toBe(false);
    expect(useAppStore.getState().callDraftOf(MESSAGES_KEY)!.text).toBe('[{"role":"user"}]');
  });

  it("迟到回调不解冻新提交；通道抛错（状态未知）保留冻结", async () => {
    const first = openAndSubmitEdit("第一次");
    useAppStore.getState().settleDraftSubmission(first);
    const second = useAppStore
      .getState()
      .beginDraftSubmission({ channel: "result", target: RESULT_KEY })!;
    expect(second.token).not.toBe(first.token);

    // 迟到的旧关联收尾：不解冻新提交
    useAppStore.getState().settleDraftSubmission(first);
    expect(useAppStore.getState().isDraftFrozen(RESULT_KEY)).toBe(true);

    // 通道抛错：无法确定执行是否仍在进行 ⇒ 冻结保留（不假装取消、不自动重发）
    api.forkRun = async () => {
      throw new Error("ipc channel gone");
    };
    await expect(
      useAppStore.getState().forkAt("r_01", toolSpan.id, second.submittedText, undefined, second),
    ).rejects.toThrow("ipc channel gone");
    expect(useAppStore.getState().isDraftFrozen(RESULT_KEY)).toBe(true);
    expect(useAppStore.getState().callDraftOf(RESULT_KEY)!.text).toBe("第一次");
  });
});

describe("store 行为：创建整份与 A/B 整批的提交关联（任务 3.5）", () => {
  beforeEach(() => {
    resetDraftState();
    stubVictoryPath();
  });

  function openCreateDraft(task: string): DraftSubmission {
    const store = useAppStore.getState();
    store.ensureCreateRunDraft();
    store.writeCreateRunDraft({ userMessage: task });
    const assoc = store.beginDraftSubmission({ channel: "create", target: CREATE_SUBMIT_TARGET });
    if (assoc === null) throw new Error("登记创建提交关联失败");
    return assoc;
  }

  function openAbBatch(): DraftSubmission {
    const store = useAppStore.getState();
    store.ensureModelAbDraft(AB_KEY, AB_BASELINE, CALL_SOURCE);
    store.setModelAbRows(AB_KEY, [
      { key: "arm-1", model: "m-a", paramsText: '{"temperature":0.2}' },
      { key: "arm-2", model: "m-b", paramsText: "" },
    ]);
    const assoc = store.beginDraftSubmission({ channel: "model_ab", target: AB_KEY });
    if (assoc === null) throw new Error("登记 A/B 提交关联失败");
    return assoc;
  }

  it("创建：冻结整份（写入与放弃被拒），快照含模式与两个字段", () => {
    const assoc = openCreateDraft("整份冻结");
    expect(JSON.parse(assoc.submittedText)).toEqual({
      mode: "chat",
      systemPrompt: "",
      userMessage: "整份冻结",
    });
    const frozenRepo = useAppStore.getState().drafts;

    useAppStore.getState().writeCreateRunDraft({ userMessage: "冻结期间偷改" });
    expect(useAppStore.getState().drafts).toBe(frozenRepo);
    expect(useAppStore.getState().createRunDraftOf()!.userMessage).toBe("整份冻结");
    expect(useAppStore.getState().discardCreateRunDraft(assoc.submittedRevision)).toBe(false);
    expect(useAppStore.getState().createRunDraftOf()!.userMessage).toBe("整份冻结");

    // 展示状态复位不解冻（对话框卸载走的就是 resetCreateRun）
    useAppStore.getState().resetCreateRun();
    expect(useAppStore.getState().isDraftFrozen(CREATE_SUBMIT_TARGET)).toBe(true);
  });

  it("创建：成功与业务拒绝都收尾且表单保留；抛错保留冻结", async () => {
    const created = openCreateDraft("创建要留草稿");
    expect(
      await useAppStore
        .getState()
        .createRun({ systemPrompt: "", userMessage: "创建要留草稿" }, created),
    ).toBe(true);
    expect(useAppStore.getState().isDraftFrozen(CREATE_SUBMIT_TARGET)).toBe(false);
    expect(useAppStore.getState().createRunDraftOf()!.userMessage).toBe("创建要留草稿");

    // 业务拒绝（INVALID_SOURCE_TOKEN 等）：可重新提交，内容不丢
    const rejected = openCreateDraft("被拒绝也要留");
    api.createRun = executedFail("INVALID_SOURCE_TOKEN", "令牌失效");
    expect(
      await useAppStore
        .getState()
        .createRun({ systemPrompt: "", userMessage: "被拒绝也要留" }, rejected),
    ).toBe(false);
    expect(useAppStore.getState().isDraftFrozen(CREATE_SUBMIT_TARGET)).toBe(false);
    expect(useAppStore.getState().createRunDraftOf()!.userMessage).toBe("被拒绝也要留");

    // 通道抛错：状态未知 ⇒ 保留冻结与可复制内容
    const unknown = openCreateDraft("未知状态");
    api.createRun = async () => {
      throw new Error("ipc channel gone");
    };
    await expect(
      useAppStore.getState().createRun({ systemPrompt: "", userMessage: "未知状态" }, unknown),
    ).rejects.toThrow("ipc channel gone");
    expect(useAppStore.getState().isDraftFrozen(CREATE_SUBMIT_TARGET)).toBe(true);
    expect(useAppStore.getState().createRunDraftOf()!.userMessage).toBe("未知状态");
  });

  it("A/B：冻结整批（改行与放弃被拒），快照为批次行 JSON", () => {
    const assoc = openAbBatch();
    expect(JSON.parse(assoc.submittedText)).toEqual([
      { model: "m-a", paramsText: '{"temperature":0.2}' },
      { model: "m-b", paramsText: "" },
    ]);
    const frozenRepo = useAppStore.getState().drafts;

    useAppStore.getState().setModelAbRows(AB_KEY, [
      { key: "arm-1", model: "偷改", paramsText: "" },
      { key: "arm-2", model: "m-b", paramsText: "" },
    ]);
    expect(useAppStore.getState().drafts).toBe(frozenRepo);
    expect(useAppStore.getState().modelAbDraftOf(AB_KEY)!.rows[0]!.model).toBe("m-a");
    expect(useAppStore.getState().discardModelAbDraft(AB_KEY, assoc.submittedRevision)).toBe(false);
    expect(useAppStore.getState().modelAbDraftOf(AB_KEY)!.rows[0]!.model).toBe("m-a");

    // 展开/收起编辑器的复位不解冻
    useAppStore.getState().resetModelAb();
    expect(useAppStore.getState().isDraftFrozen(AB_KEY)).toBe(true);
  });

  it("A/B：部分臂失败（仍是明确返回）收尾且批次保留", async () => {
    const assoc = openAbBatch();
    const plan = [
      { index: 0, model: "m-a", params: {}, discarded: {}, warnings: [] },
      { index: 1, model: "m-b", params: {}, discarded: {}, warnings: [] },
    ];
    api.modelAb = executedOk({
      experimentId: "exp_partial",
      // 两臂只落盘一条 ⇒ 部分失败
      ids: ["run_a"],
      ok: false,
      plan,
      sideEffectsAllowed: false,
    });

    const result = await useAppStore
      .getState()
      .modelAb(detail.meta.id, [{ model: "m-a" }, { model: "m-b" }], false, assoc);
    expect(result?.ids).toHaveLength(1);
    expect(useAppStore.getState().isDraftFrozen(AB_KEY)).toBe(false);
    // 批次内容原样（响应不清批次）
    expect(
      useAppStore
        .getState()
        .modelAbDraftOf(AB_KEY)!
        .rows.map((r) => r.model),
    ).toEqual(["m-a", "m-b"]);

    // 预览（dryRun）不带关联：即使有在飞预览也不该动冻结状态
    const frozen = openAbBatch();
    await useAppStore.getState().modelAb(detail.meta.id, [{ model: "m-a" }], true);
    expect(useAppStore.getState().isDraftFrozen(AB_KEY)).toBe(true);
    useAppStore.getState().settleDraftSubmission(frozen);
  });
});

// ---------------------------------------------------------------------------
// 源码级接线契约
// ---------------------------------------------------------------------------

describe("接线契约：五类提交走快照并受冻结约束（任务 3.4/3.5）", () => {
  it("调用类三编辑器：先登记关联，提交值取自快照而非渲染局部值", () => {
    // 折叠空白后再找：4.4 起 result 的登记调用带上了确认参数（多行写法），
    // 判据是"经 beginDraftSubmission 登记"，不是"写成一行"
    const flatPanel = DETAIL_PANEL.replace(/\s+/g, " ");
    for (const channel of ["result", "prompt", "messages"] as const) {
      expect(flatPanel).toContain(`beginDraftSubmission({ channel: "${channel}", target:`);
    }
    // 每个通道都从关联里取提交值
    expect(DETAIL_PANEL.match(/assoc\.submittedText/g)?.length).toBeGreaterThanOrEqual(3);
    // 旧的"直接提交渲染值"形态已消失（否则快照绑定是假的）
    expect(DETAIL_PANEL).not.toContain("forkAt(run.meta.id, span.id, value");
    expect(DETAIL_PANEL).not.toContain("promptFork(run.meta.id, { field, value });");
    expect(DETAIL_PANEL).not.toContain(
      "proxyFork(run.meta.id, span.id, messages as Record<string, unknown>[]);",
    );
  });

  it("A/B 执行：登记整批关联后才发请求；预览不带关联", () => {
    const execute = slice(DETAIL_PANEL, "const doExecute = ", "return (");
    expect(execute).toContain('beginDraftSubmission({ channel: "model_ab", target: draftKey })');
    expect(execute).toContain("modelAb(run.meta.id, guard.arms, false, assoc)");
    // 预览（dry-run）不是提交：不得登记关联
    const preview = slice(DETAIL_PANEL, "const doPreview = ", "const doExecute = ");
    expect(preview).not.toContain("beginDraftSubmission");
    expect(preview).toContain("modelAb(run.meta.id, guard.arms, true)");
  });

  it("冻结即视为进行中：五个编辑器都禁用输入/放弃/提交并给出待处理说明", () => {
    // 调用类三编辑器共用同一形态：forking 进行中 ∨ 冻结
    expect(
      DETAIL_PANEL.match(/const inProgress = forking === "in_progress" \|\| draftFrozen;/g)?.length,
    ).toBe(3);
    expect(DETAIL_PANEL).toContain("const inProgress = modelAbInFlight || draftFrozen;");
    // 四个编辑器各查一次冻结（三调用类 + A/B），创建工作区在另一文件
    expect(DETAIL_PANEL.match(/isDraftFrozen\(/g)?.length).toBe(4);
    expect(DETAIL_PANEL.match(/本次提交待处理/g)?.length).toBe(3);
    expect(DETAIL_PANEL).toContain("本次执行待处理");

    expect(CREATE_WORKSPACE).toContain("isDraftFrozen(CREATE_SUBMIT_TARGET)");
    expect(CREATE_WORKSPACE).toContain("const formLocked = busy || pickingSource || draftFrozen;");
    expect(CREATE_WORKSPACE).toContain("本次提交待处理");
    // 两个文本域在冻结期不可编辑（4.2 起由纯视图落到控件上，能力断言见 create-form-view）
    expect(CREATE_WORKSPACE.match(/disabled=\{lock\.draftFrozen\}/g)?.length).toBe(2);
  });

  it("创建提交：判据通过后才登记整份关联，并随请求交给 store 收尾", () => {
    const submit = slice(CREATE_WORKSPACE, "const submit = ", "const pickGeneration").replace(
      /\s+/g,
      " ",
    );
    expect(submit.indexOf("if (!canCreate) return;")).toBeLessThan(
      submit.indexOf('beginDraftSubmission({ channel: "create", target: CREATE_SUBMIT_TARGET'),
    );
    // U5 4.4：登记时交出现场确认 ⇒ 不成立的确认在 store 侧就被拒（组件不是执法点）
    expect(submit).toContain("confirmation,");
    expect(submit).toContain("createRun(request, assoc)");
    // 判据不通过时零 IPC（原有保证不变）
    const lib = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/lib/create-run.ts"),
      "utf8",
    );
    expect(lib).toContain("if (!submission.ok) return false;");
  });

  it("messages 在本地校验拒绝时收尾；取消确认改为登记前 ⇒ 不留待定关联", () => {
    const resend = slice(DETAIL_PANEL, "const doResend = ", "const discardCurrent = ");
    expect(resend).toContain("JSON.parse(assoc.submittedText)");
    // U5 4.6：两处本地校验（JSON 非法 / 非空数组）各收尾一次；
    // 旧的第三处"原生 confirm 取消"已消失——确认不成立时根本不会登记关联
    expect(resend.match(/settleDraftSubmission\(assoc\);/g)?.length).toBe(2);
    expect(resend).not.toContain("window.confirm");
    expect(resend).toContain("confirmation: messagesBinding");
  });

  it("store：六处写入/放弃路径拦冻结；五个执行函数负责收尾", () => {
    // 调用类、创建、A/B 三区各有一处写入与一处放弃
    for (const [start, end, ret] of [
      ["writeCallDraftText(key, text) {", "discardCallDraft(key, expectedRevision) {", "return;"],
      ["discardCallDraft(key, expectedRevision) {", "createRunDraftOf() {", "return false;"],
      ["writeCreateRunDraft(patch) {", "discardCreateRunDraft(expectedRevision) {", "return;"],
      ["discardCreateRunDraft(expectedRevision) {", "modelAbDraftOf(key) {", "return false;"],
      ["setModelAbRows(key, rows) {", "discardModelAbDraft(key, expectedRevision) {", "return;"],
      ["discardModelAbDraft(key, expectedRevision) {", "createSourceRef: null,", "return false;"],
    ] as const) {
      const body = slice(STORE_SRC, start, end);
      expect(body).toContain("submissionLib.submissionOf(get().draftSubmissions");
      expect(body).toContain(ret);
    }

    // 五个执行函数：响应到达即**按身份**收尾（放在 await 之后、错误分支之前 ⇒ 成功与业务拒绝都覆盖）
    // U4 任务 4.2：收尾一律走 `finishDraftSubmission`（内部按 epoch/operationId 判解冻），
    // 不再无条件 `settleDraftSubmission(submission)`——那等于"任何响应都算结束"。
    for (const [start, end] of [
      ["async forkAt(parentRunId, atSpanId, value, execution, submission) {", "resetFork() {"],
      ["async promptFork(parentRunId, edit, submission) {", "async modelAb("],
      ["async proxyFork(parentRunId, atSpanId, messages, submission) {", "}));"],
      ["async createRun(request, submission) {", "resetCreateRun() {"],
      ["async modelAb(parentRunId, arms, dryRun, submission) {", "resetModelAb() {"],
    ] as const) {
      const body = slice(STORE_SRC, start, end);
      const settleAt = body.indexOf("get().finishDraftSubmission(submission");
      expect(settleAt, start).toBeGreaterThan(body.indexOf("await submitActive("));
      expect(settleAt, start).toBeLessThan(body.indexOf("if (!envelope.ok)"));
      expect(body, start).not.toContain("get().settleDraftSubmission(submission)");
      // 身份要一路传到通道：登记关联的 operationId 必须就是请求里那个
      expect(body, start).toContain(", submission)");
    }
  });
});
