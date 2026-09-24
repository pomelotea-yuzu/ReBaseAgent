import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { CallDraftEntry, CallDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import { deriveDraftList } from "../src/renderer/src/lib/draft-list";
import { captureCallDraftSource } from "../src/renderer/src/lib/draft-source";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import type { DraftSubmission } from "../src/renderer/src/lib/draft-submission";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U3（preserve-debugging-drafts）任务 3.4：提交绑定草稿快照并冻结，响应不清草稿。
 *
 * 判据来源（tasks 3.4 验收 + delta「提交绑定草稿修订且响应不清除草稿」）：
 *   - 提交快照独立于编辑器挂载（冻结在 store，卸载 / resetFork / 展示复位都不解冻）
 *   - 成功、业务拒绝均保留草稿；已明确返回才解冻；未知状态（通道抛错）保留冻结
 *   - 迟到回调不解冻新提交；冻结只影响指定目标
 *
 * ⚠️ 本包无 jsdom ⇒ 源码级接线契约 + store 同形调用行为；实机往返归 CDP（任务 6.3）。
 */

const DETAIL_PANEL = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
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

describe("纯逻辑：提交关联的登记与收尾（任务 3.4）", () => {
  const keyA: CallDraftKey = { runId: "r_01", spanId: "s_03", field: "result" };
  const keyB: CallDraftKey = { runId: "r_01", spanId: "s_03", field: "messages" };
  const entry = (text: string, revision: number): CallDraftEntry => ({
    baseline: "baseline",
    text,
    revision,
  });

  it("登记取当前修订与请求快照，令牌单调递增", () => {
    const empty = subLib.emptySubmissionStore();
    const first = subLib.beginSubmission(empty, {
      channel: "result",
      key: keyA,
      entry: entry("编辑后的结果", 7),
    });
    expect(first.submission).not.toBeNull();
    expect(first.submission!.submittedRevision).toBe(7);
    expect(first.submission!.submittedText).toBe("编辑后的结果");
    expect(first.submission!.channel).toBe("result");
    expect(subLib.submissionOf(first.store, keyA)?.token).toBe(first.submission!.token);

    // 另一目标另行登记 ⇒ 令牌递增（旧关联的令牌不会与后续提交相同）
    const second = subLib.beginSubmission(first.store, {
      channel: "messages",
      key: keyB,
      entry: entry("[]", 9),
    });
    expect(second.submission!.token).toBeGreaterThan(first.submission!.token);
    // 两个目标各自冻结，互不影响
    expect(subLib.submissionOf(second.store, keyA)).toBeDefined();
    expect(subLib.submissionOf(second.store, keyB)).toBeDefined();
  });

  it("同目标重复登记被拒且不换令牌（旧请求的响应仍能收尾）", () => {
    const empty = subLib.emptySubmissionStore();
    const first = subLib.beginSubmission(empty, {
      channel: "result",
      key: keyA,
      entry: entry("a", 3),
    });
    const again = subLib.beginSubmission(first.store, {
      channel: "result",
      key: keyA,
      entry: entry("b", 4),
    });
    expect(again.submission).toBeNull();
    // 仓库引用不变：既不覆盖旧关联，也不推进令牌
    expect(again.store).toBe(first.store);
    expect(subLib.submissionOf(again.store, keyA)).toBe(first.submission);
  });

  it("收尾只认同令牌：旧关联（迟到回调）不解冻后来发起的新提交", () => {
    const empty = subLib.emptySubmissionStore();
    const first = subLib.beginSubmission(empty, {
      channel: "result",
      key: keyA,
      entry: entry("a", 3),
    });
    const settledFirst = subLib.settleSubmission(first.store, first.submission!);
    expect(subLib.submissionOf(settledFirst, keyA)).toBeUndefined();

    // 第二次提交（新令牌）
    const second = subLib.beginSubmission(settledFirst, {
      channel: "result",
      key: keyA,
      entry: entry("b", 5),
    });
    // 迟到的旧关联收尾：令牌不同 ⇒ 不动新提交
    const afterLateSettle = subLib.settleSubmission(second.store, first.submission!);
    expect(afterLateSettle).toBe(second.store);
    expect(subLib.submissionOf(afterLateSettle, keyA)).toBe(second.submission);

    // 幂等：重复收尾同令牌不报错、引用不变
    const settledSecond = subLib.settleSubmission(second.store, second.submission!);
    expect(subLib.settleSubmission(settledSecond, second.submission!)).toBe(settledSecond);
  });

  it("目标标识与草稿列表 listKey 同编码（防两套编码漂移）", () => {
    expect(subLib.submissionIdOf(keyA)).toBe(
      deriveDraftList(draftLib.ensureCallDraft(draftLib.emptyDraftRepo(), keyA, "b").repo)[0]!
        .listKey,
    );
    expect(
      subLib.submissionIdOf({ runId: "r_01", spanId: "s_02", field: "model_ab" as never }),
    ).toBe("r_01|s_02|model_ab");
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
if (toolSpan === undefined) throw new Error("fixture 缺少 tool.invoke span");

// store 接线（模块读 window.api，桩须先于动态 import 就位）
(globalThis as Record<string, unknown>).window = { api: {} };
const api = (globalThis.window as unknown as { api: Record<string, unknown> }).api;
const { useAppStore } = await import("../src/renderer/src/store");

const RESULT_KEY: CallDraftKey = { runId: detail.meta.id, spanId: toolSpan.id, field: "result" };
const MESSAGES_KEY: CallDraftKey = { runId: detail.meta.id, spanId: "s_02", field: "messages" };

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
  api.forkRun = async () => ({ ok: true as const, data: { id: "run_forked" } });
  api.promptFork = async () => ({ ok: true as const, data: { id: "run_prompt_forked" } });
  api.proxyFork = async () => ({ ok: true as const, data: { id: "run_proxy_forked" } });
}

describe("store 行为：提交冻结与收尾（任务 3.4）", () => {
  beforeEach(() => {
    useAppStore.setState({
      drafts: draftLib.emptyDraftRepo(),
      draftSubmissions: subLib.emptySubmissionStore(),
      forking: "idle",
    });
    stubVictoryPath();
  });

  /** 编辑器同形：打开登记基线 → 编辑 → 提交登记关联 */
  function openAndSubmitEdit(text: string): DraftSubmission {
    const store = useAppStore.getState();
    store.ensureCallDraft(RESULT_KEY, "原结果", captureCallDraftSource(detail, toolSpan));
    store.writeCallDraftText(RESULT_KEY, text);
    const assoc = store.beginCallDraftSubmission({ channel: "result", key: RESULT_KEY });
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
    useAppStore
      .getState()
      .ensureCallDraft(
        other,
        "sys",
        captureCallDraftSource(detail, detail.spans.find((s) => s.id === "s_02")!),
      );
    useAppStore.getState().writeCallDraftText(other, "sys 改");
    const otherAfter = useAppStore.getState().callDraftOf(other)!;
    expect(otherAfter.text).toBe("sys 改");
    expect(useAppStore.getState().discardCallDraft(other, otherAfter.revision)).toBe(true);
    expect(useAppStore.getState().callDraftOf(other)).toBeUndefined();
  });

  it("提交快照独立于编辑器挂载：resetFork 与展示状态复位后仍冻结", () => {
    const assoc = openAndSubmitEdit("挂载外的快照");
    expect(useAppStore.getState().isCallDraftFrozen(RESULT_KEY)).toBe(true);

    // 编辑器卸载 / 收起走的正是这些路径（design D5：它们不是解冻依据）
    useAppStore.getState().resetFork();
    useAppStore.setState({ detail: null, selectedRunId: null, view: "trace" });

    expect(useAppStore.getState().isCallDraftFrozen(RESULT_KEY)).toBe(true);
    expect(useAppStore.getState().callDraftOf(RESULT_KEY)!.text).toBe(assoc.submittedText);
    expect(assoc.submittedText).toBe("挂载外的快照");
  });

  it("成功响应收尾（解冻）但草稿保留原文", async () => {
    const assoc = openAndSubmitEdit("成功也要留草稿");
    api.forkRun = async () => ({ ok: true as const, data: { id: "run_forked" } });

    expect(
      await useAppStore
        .getState()
        .forkAt("r_01", toolSpan.id, assoc.submittedText, undefined, assoc),
    ).toBe(true);
    expect(useAppStore.getState().isCallDraftFrozen(RESULT_KEY)).toBe(false);
    expect(useAppStore.getState().callDraftOf(RESULT_KEY)!.text).toBe("成功也要留草稿");
  });

  it("业务拒绝同样收尾（可重新提交）且草稿保留；三个通道一致", async () => {
    // result（forkAt）
    const resultAssoc = openAndSubmitEdit("失败也留草稿");
    api.forkRun = async () => ({
      ok: false as const,
      error: { code: "BUSINESS_REJECTED", message: "拒绝" },
    });
    expect(
      await useAppStore
        .getState()
        .forkAt("r_01", toolSpan.id, resultAssoc.submittedText, undefined, resultAssoc),
    ).toBe(false);
    expect(useAppStore.getState().isCallDraftFrozen(RESULT_KEY)).toBe(false);
    expect(useAppStore.getState().callDraftOf(RESULT_KEY)!.text).toBe("失败也留草稿");

    // prompt（promptFork）
    const promptKey: CallDraftKey = {
      runId: detail.meta.id,
      spanId: "s_02",
      field: "user_message",
    };
    useAppStore
      .getState()
      .ensureCallDraft(
        promptKey,
        "旧问题",
        captureCallDraftSource(detail, detail.spans.find((s) => s.id === "s_02")!),
      );
    useAppStore.getState().writeCallDraftText(promptKey, "新问题");
    const promptAssoc = useAppStore
      .getState()
      .beginCallDraftSubmission({ channel: "prompt", key: promptKey })!;
    api.promptFork = async () => ({ ok: false as const, error: { code: "X", message: "拒绝" } });
    expect(
      await useAppStore
        .getState()
        .promptFork(
          "r_01",
          { field: "user_message", value: promptAssoc.submittedText },
          promptAssoc,
        ),
    ).toBe(false);
    expect(useAppStore.getState().isCallDraftFrozen(promptKey)).toBe(false);
    expect(useAppStore.getState().callDraftOf(promptKey)!.text).toBe("新问题");

    // messages（proxyFork）
    useAppStore
      .getState()
      .ensureCallDraft(
        MESSAGES_KEY,
        "[]",
        captureCallDraftSource(detail, detail.spans.find((s) => s.id === "s_02")!),
      );
    useAppStore.getState().writeCallDraftText(MESSAGES_KEY, '[{"role":"user"}]');
    const msgAssoc = useAppStore
      .getState()
      .beginCallDraftSubmission({ channel: "messages", key: MESSAGES_KEY })!;
    api.proxyFork = async () => ({
      ok: false as const,
      error: { code: "PROXY_NO_KEY", message: "拒绝" },
    });
    expect(await useAppStore.getState().proxyFork("r_01", "s_02", [], msgAssoc)).toBe(false);
    expect(useAppStore.getState().isCallDraftFrozen(MESSAGES_KEY)).toBe(false);
    expect(useAppStore.getState().callDraftOf(MESSAGES_KEY)!.text).toBe('[{"role":"user"}]');
  });

  it("迟到回调不解冻新提交；通道抛错（状态未知）保留冻结", async () => {
    const first = openAndSubmitEdit("第一次");
    useAppStore.getState().settleCallDraftSubmission(first);
    const second = useAppStore
      .getState()
      .beginCallDraftSubmission({ channel: "result", key: RESULT_KEY })!;
    expect(second.token).not.toBe(first.token);

    // 迟到的旧关联收尾：不解冻新提交
    useAppStore.getState().settleCallDraftSubmission(first);
    expect(useAppStore.getState().isCallDraftFrozen(RESULT_KEY)).toBe(true);

    // 通道抛错：无法确定执行是否仍在进行 ⇒ 冻结保留（不假装取消、不自动重发）
    api.forkRun = async () => {
      throw new Error("ipc channel gone");
    };
    await expect(
      useAppStore.getState().forkAt("r_01", toolSpan.id, second.submittedText, undefined, second),
    ).rejects.toThrow("ipc channel gone");
    expect(useAppStore.getState().isCallDraftFrozen(RESULT_KEY)).toBe(true);
    expect(useAppStore.getState().callDraftOf(RESULT_KEY)!.text).toBe("第一次");
  });
});

// ---------------------------------------------------------------------------
// 源码级接线契约
// ---------------------------------------------------------------------------

describe("接线契约：三编辑器提交走快照并受冻结约束（任务 3.4）", () => {
  it("三个编辑器都先登记提交关联，提交值取自快照而非渲染局部值", () => {
    for (const channel of ["result", "prompt", "messages"] as const) {
      expect(DETAIL_PANEL).toContain(`beginCallDraftSubmission({ channel: "${channel}"`);
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

  it("冻结即视为进行中：三个编辑器都禁用输入/放弃/提交并给出待处理说明", () => {
    expect(
      DETAIL_PANEL.match(/const inProgress = forking === "in_progress" \|\| draftFrozen;/g)?.length,
    ).toBe(3);
    expect(
      DETAIL_PANEL.match(/isCallDraftFrozen\(draftKey|isCallDraftFrozen\(draftKeyOf\(field\)\)/g)
        ?.length,
    ).toBe(3);
    expect(DETAIL_PANEL.match(/本次提交待处理/g)?.length).toBe(3);
  });

  it("messages 在本地校验拒绝/取消确认时收尾（不发请求就不留冻结）", () => {
    const resend = slice(DETAIL_PANEL, "const doResend = ", "const discardCurrent = ");
    expect(resend).toContain("JSON.parse(assoc.submittedText)");
    // 两处本地校验 + 一处取消确认，各收尾一次
    expect(resend.match(/settleCallDraftSubmission\(assoc\);/g)?.length).toBe(3);
  });

  it("store：冻结拦截在写入与放弃两处；三个执行函数负责收尾", () => {
    const write = slice(
      STORE_SRC,
      "writeCallDraftText(key, text) {",
      "discardCallDraft(key, expectedRevision) {",
    );
    expect(write).toContain(
      "submissionLib.submissionOf(get().draftSubmissions, key) !== undefined",
    );
    expect(write).toContain("return;");
    const discard = slice(
      STORE_SRC,
      "discardCallDraft(key, expectedRevision) {",
      "createRunDraftOf() {",
    );
    expect(discard).toContain(
      "submissionLib.submissionOf(get().draftSubmissions, key) !== undefined",
    );
    expect(discard).toContain("return false;");

    // 三个执行函数：响应到达即收尾（放在 await 之后、错误分支之前 ⇒ 成功与业务拒绝都覆盖）
    for (const [start, end] of [
      ["async forkAt(parentRunId, atSpanId, value, execution, submission) {", "resetFork() {"],
      ["async promptFork(parentRunId, edit, submission) {", "async modelAb("],
      ["async proxyFork(parentRunId, atSpanId, messages, submission) {", "}));"],
    ] as const) {
      const body = slice(STORE_SRC, start, end);
      const settleAt = body.indexOf("settleCallDraftSubmission(submission)");
      expect(settleAt).toBeGreaterThan(body.indexOf("await api."));
      expect(settleAt).toBeLessThan(body.indexOf("if (!envelope.ok)"));
    }
  });
});
