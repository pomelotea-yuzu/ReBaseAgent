import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { captureCallDraftSource } from "../src/renderer/src/lib/draft-source";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U3（preserve-debugging-drafts）任务 2.2：prompt 两字段和代理 messages 接入无损草稿。
 *
 * 判据来源（tasks 2.2 验收）：
 *   - 相同 span ID 和不同字段不串草稿（system_prompt / user_message 各自独立键）
 *   - 非法 JSON 和空输入仍可暂存（messages 无损字符串，解析只在提交边界）
 *   - 无变化与空字符串按各字段契约处理（沿用 promptForkGuard / 提交时 JSON.parse，不改判据）
 *
 * ⚠️ 本包无 jsdom ⇒ 与 2.1 同法：源码级接线契约（函数体切片 + 剥注释审计）
 *    + store 同形调用行为；"接线对而行为错"归 CDP 实机（任务 6.2）。
 */

// ---------------------------------------------------------------------------
// 源码级接线契约
// ---------------------------------------------------------------------------

const DETAIL_PANEL = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
  "utf8",
);

/** 切出组件函数体（到下一个顶层标记为止），使禁用型断言不误伤其他编辑器 */
function sliceBetween(startMarker: string, endMarker: string): string {
  const start = DETAIL_PANEL.indexOf(startMarker);
  const end = DETAIL_PANEL.indexOf(endMarker, start + 1);
  if (start < 0 || end < 0 || end <= start) throw new Error(`切片失败：${startMarker}`);
  return DETAIL_PANEL.slice(start, end);
}

describe("接线契约：PromptForkEditor 两字段独立草稿（任务 2.2）", () => {
  const src = () => sliceBetween("function PromptForkEditor(", "function ArmPlanRow");

  it("两个 prompt 字段各自独立键（draftKeyOf(field)），激活值从对应草稿派生", () => {
    const code = src();
    // 键按字段参数构造：同一 span ID 下 system_prompt / user_message 各自独立
    expect(code).toContain("field: f");
    expect(code).toContain("s.callDraftOf(draftKeyOf(field))");
    // 输入同步写入当前字段草稿
    expect(code).toContain("writeCallDraftText(draftKeyOf(field)");
  });

  it("打开/切字段经 ensureFieldDraft 登记基线并捕获源基线；不再重置字段值", () => {
    const code = src();
    expect(code).toContain("ensureCallDraft(draftKeyOf(f), baseline, draftSource)");
    expect(code).toContain("captureCallDraftSource(run, span)");
    // 旧根因：switchField / 打开按钮把值重置回原值 ⇒ 字段切换丢输入、重开覆盖
    expect(auditForbiddenTokens(code, ["setValue"])).toEqual([]);
  });

  it("沿用原字段校验（promptForkGuard）与取消不删草稿", () => {
    const code = src();
    expect(code).toContain("promptForkGuard(");
    expect(auditForbiddenTokens(code, ["discardCallDraft"])).toEqual([]);
  });
});

describe("接线契约：MessagesForkEditor 接入 messages 草稿（任务 2.2）", () => {
  const src = () => sliceBetween("function MessagesForkEditor(", "function toolMessageText(");

  it("messages 字段独立键 + 打开 ensure + 源基线捕获；onChange 同步写 store", () => {
    const code = src();
    expect(code).toContain('field: "messages"');
    expect(code).toContain("ensureCallDraft(");
    expect(code).toContain("captureCallDraftSource(run, span)");
    expect(code).toContain("writeCallDraftText(draftKey");
    expect(auditForbiddenTokens(code, ["setValue"])).toEqual([]);
  });

  it("沿用提交边界解析（JSON.parse）与取消不删草稿", () => {
    const code = src();
    // 解析/校验只在提交边界进行：非法 JSON 在草稿里原样暂存
    expect(code).toContain("JSON.parse(value)");
    expect(auditForbiddenTokens(code, ["discardCallDraft"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// store 行为：两字段独立 + 非法 JSON/空输入暂存（编辑器同形调用）
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
const firstLlmSpan = detail.spans.find((s) => s.id === "s_02");
if (firstLlmSpan === undefined || firstLlmSpan.kind !== "llm.call") {
  throw new Error("fixture 缺少首个 llm.call span（s_02）");
}

// store 接线（模块读 window.api，桩须先于动态 import 就位）
(globalThis as Record<string, unknown>).window = { api: {} };
const { useAppStore } = await import("../src/renderer/src/store");
const draftsModule = await import("../src/renderer/src/lib/debugging-drafts");

describe("store 行为：prompt 两字段不串草稿、messages 非法输入原样暂存", () => {
  const source = captureCallDraftSource(detail, firstLlmSpan);
  const sysKey = { runId: detail.meta.id, spanId: "s_02", field: "system_prompt" as const };
  const userKey = { runId: detail.meta.id, spanId: "s_02", field: "user_message" as const };
  const msgKey = { runId: detail.meta.id, spanId: "s_02", field: "messages" as const };
  const sysBaseline = "你是文件助手，按用户要求完成文件任务。";
  const userBaseline = "请读取 README.md 并把要点写入 summary.md";

  beforeEach(() => {
    useAppStore.setState({ drafts: draftsModule.emptyDraftRepo() });
  });

  it("同 span 的两个字段各自登记基线、各自编辑，互不串（字段切换保留独立值）", () => {
    // 打开编辑器：登记 system_prompt 字段并编辑
    useAppStore.getState().ensureCallDraft(sysKey, sysBaseline, source);
    useAppStore.getState().writeCallDraftText(sysKey, "改过的 system");
    // 切到 user_message 字段：登记其自身基线并编辑
    useAppStore.getState().ensureCallDraft(userKey, userBaseline, source);
    useAppStore.getState().writeCallDraftText(userKey, "改过的 user");

    // 字段切换往返：两字段各自保留
    expect(useAppStore.getState().callDraftOf(sysKey)?.text).toBe("改过的 system");
    expect(useAppStore.getState().callDraftOf(userKey)?.text).toBe("改过的 user");
    // 基线也各自独立（一个字段的原值不是另一个字段的）
    expect(useAppStore.getState().callDraftOf(sysKey)?.baseline).toBe(sysBaseline);
    expect(useAppStore.getState().callDraftOf(userKey)?.baseline).toBe(userBaseline);
  });

  it("messages 草稿：非法 JSON 与空输入原样暂存（不 format / 不 trim / 不替换）", () => {
    useAppStore.getState().ensureCallDraft(msgKey, '[{"role":"user","content":"hi"}]', source);

    const broken = "]{ 这是没写完的 JSON";
    useAppStore.getState().writeCallDraftText(msgKey, broken);
    expect(useAppStore.getState().callDraftOf(msgKey)?.text).toBe(broken);

    useAppStore.getState().writeCallDraftText(msgKey, "");
    expect(useAppStore.getState().callDraftOf(msgKey)?.text).toBe("");

    // 恢复原值（编辑器"恢复原值"同形：写回基线文本）⇒ 与基线一致
    useAppStore.getState().writeCallDraftText(msgKey, '[{"role":"user","content":"hi"}]');
    const entry = useAppStore.getState().callDraftOf(msgKey);
    expect(entry?.text).toBe(entry?.baseline);
  });

  it("恢复原值写回基线后 dirty 归零：空串变更同样要经写入（不绕过草稿）", () => {
    useAppStore.getState().ensureCallDraft(sysKey, sysBaseline, source);
    expect(draftsModule.isCallDraftDirty(useAppStore.getState().callDraftOf(sysKey)!)).toBe(false);

    // 清空为零长度仍是变更
    useAppStore.getState().writeCallDraftText(sysKey, "");
    expect(draftsModule.isCallDraftDirty(useAppStore.getState().callDraftOf(sysKey)!)).toBe(true);

    // 恢复原值 = 写回基线 ⇒ dirty 归零（条目保留）
    useAppStore.getState().writeCallDraftText(sysKey, sysBaseline);
    expect(draftsModule.isCallDraftDirty(useAppStore.getState().callDraftOf(sysKey)!)).toBe(false);
    expect(useAppStore.getState().callDraftOf(sysKey)?.text).toBe(sysBaseline);
  });
});
