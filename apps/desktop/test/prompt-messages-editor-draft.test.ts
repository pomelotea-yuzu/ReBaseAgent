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
  // ⚠️ U8 5.1a 修复留痕（2026-10-01）：终点锚 "function ArmPlanRow" 自 3.1a 把
  // ArmPlanRow 迁进 ModelAbEditor.tsx 后就不在 DetailPanel 里了——该 describe 从那时起
  // 一直切不出来（定向回归没跑到这套件，§7 全量会咬）。终点锚改用 LlmCallDetail（与
  // entry-gate.test.ts 同款），判据本身不动。
  const src = () => sliceBetween("function PromptForkEditor(", "function LlmCallDetail(");

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
    // U3 2.5：ensureFieldDraft 用 useCallback 稳定化（biome 依赖纪律），键按字段内联构造
    expect(code).toContain("ensureFieldDraft = useCallback");
    expect(code).toContain(
      "ensureCallDraft({ runId: run.meta.id, spanId: span.id, field: f }, baseline, draftSource)",
    );
    expect(code).toContain("captureCallDraftSource(run, span)");
    // 旧根因：switchField / 打开按钮把值重置回原值 ⇒ 字段切换丢输入、重开覆盖
    expect(auditForbiddenTokens(code, ["setValue"])).toEqual([]);
  });

  it("沿用原字段校验（promptForkGuard）；放弃只经失效视图 CAS，取消/切换不删草稿", () => {
    const code = src();
    expect(code).toContain("promptForkGuard(");
    // U3 2.5：放弃入口只在来源失效视图（CAS）；切字段/取消路径不删草稿
    expect(code).toContain("DraftSourceBanner");
    // U3 5.2：确认改为异步模态，放弃执行点按请求时快照修订做 CAS
    expect(code).toContain("discardCallDraft(draftKeyOf(field), snapshot.revision)");
  });

  it("任务 2.6：按修订明确放弃只影响当前字段；原值/草稿核对网格就位", () => {
    const code = src();
    // 确认文案明确目标与范围（只影响这一个字段——另一字段是独立草稿键）
    expect(code).toContain("只影响这一个字段");
    expect(code).toContain("discardCallDraft(draftKeyOf(field), snapshot.revision)");
    // 核对网格：原值只读 + 草稿可编辑，宽屏并排窄屏上下
    expect(code).toContain('data-draft-compare="prompt"');
    expect(code).toContain("grid-cols-1 gap-2 xl:grid-cols-2");
    expect(code).toContain("readOnly: true");
    // 放弃按钮：无修改（含空串改回基线）不可用
    expect(code).toContain("disabled={inProgress || unchanged}");
  });
});

describe("接线契约：MessagesForkEditor 接入 messages 草稿（任务 2.2）", () => {
  // ⚠️ U8 5.1a 改判留痕（2026-10-01）：MessagesForkEditor 提取为独立文件
  // components/MessagesForkEditor.tsx（逐字搬出、零行为变化），切片断言改读新文件
  // （不再需要切片——该文件只承载这一个组件）。
  const src = () =>
    readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/MessagesForkEditor.tsx"),
      "utf8",
    );

  it("messages 字段独立键 + 打开 ensure + 源基线捕获；onChange 同步写 store", () => {
    const code = src();
    expect(code).toContain('field: "messages"');
    expect(code).toContain("ensureCallDraft(");
    expect(code).toContain("captureCallDraftSource(run, span)");
    expect(code).toContain("writeCallDraftText(draftKey");
    expect(auditForbiddenTokens(code, ["setValue"])).toEqual([]);
  });

  it("沿用提交边界解析（JSON.parse）；放弃只经失效视图 CAS，取消不删草稿", () => {
    const code = src();
    // 解析/校验只在提交边界进行：非法 JSON 在草稿里原样暂存。
    // U3 3.4 起解析源改为**提交时的原子快照**（仍是同一份无损草稿原文，不在编辑器内解析）
    expect(code).toContain("JSON.parse(assoc.submittedText)");
    // U3 2.5：放弃入口只在来源失效视图（CAS）；取消路径不删草稿
    expect(code).toContain("DraftSourceBanner");
    expect(code).toContain("discardCallDraft(draftKey, snapshot.revision)");
  });

  it("任务 2.6：按修订放弃 + 原值/草稿核对网格（messages）", () => {
    const code = src();
    expect(code).toContain("discardCallDraft(draftKey, snapshot.revision)");
    expect(code).toContain('data-draft-compare="messages"');
    expect(code).toContain("grid-cols-1 gap-2 xl:grid-cols-2");
    expect(code).toContain("readOnly: true");
  });

  it("U8 5.1b：工作区形态参数在场（目标作用域源可用性覆盖 + 常开无收起）", () => {
    const code = src();
    // 目标作用域覆盖：缺省仍用全局选中门禁，工作区传入按目标计算的可用性
    expect(code).toContain("sourceExecutable: sourceExecutableOverride");
    expect(code).toContain("sourceExecutableOverride ?? sourceExecutableFromSelection");
    // 常开形态：初始展开、Esc 不收起（收起语义只属于步骤页内联形态）
    expect(code).toContain("useState(alwaysOpen)");
    expect(code).toContain("open && !alwaysOpen && !inProgress");
    expect(code).toContain("{alwaysOpen ? null : \"取消\"}");
  });
});

describe("U8 5.1b 源码级：编辑器唯一消费面在 messages 工作区，详情页只留入口", () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, rel), "utf8");

  it("MessagesWorkspace 挂载编辑器：目标作用域源读取 + 目标门禁 + 常开", () => {
    const code = read("../src/renderer/src/components/MessagesWorkspace.tsx");
    expect(code).toContain("readMessagesSource");
    expect(code).toContain("s.messagesSource");
    expect(code).toContain("<MessagesForkEditor");
    expect(code).toContain("sourceExecutable={targetExecutable}");
    expect(code).toContain("alwaysOpen={true}");
    // 目标 span 缺席 ⇒ 如实说明（不拿别的 span 顶上），草稿保留、入口不可用
    expect(code).toContain("data-messages-source-span-missing");
    expect(code).toContain("编辑草稿保留，重发入口不可用");
    // 读取失败 ⇒ 只读重试（不重新读取执行通道）
    expect(code).toContain("data-messages-source-failed");
  });

  it("DetailPanel 不再挂载编辑器；入口按 canResend 给出（SDK run 无此入口）", () => {
    const code = read("../src/renderer/src/components/DetailPanel.tsx");
    // 编辑器本体已迁工作区：详情页不再 import / 挂载
    expect(code).not.toContain('from "./MessagesForkEditor"');
    expect(code).not.toContain("<MessagesForkEditor");
    // 入口按钮在场，且只在 canResend（proxy 来源 + 自有调用 + 已封存）时渲染
    expect(code).toContain("data-messages-workspace-entry");
    expect(code).toContain("canResend && run !== null");
    // canResend 判据保留 proxy 来源门槛（SDK run 无此入口）+ 已封存 + 自有调用
    expect(code).toContain(
      'const canResend = isProxy === true && leafOwned && run?.status === "completed";',
    );
    // 崩溃 run 的诚实说明保留
    expect(code).toContain("该 run 运行中断（未封存），不允许作为重发起点。");
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

  it("任务 2.6：放弃只影响指定目标——放弃 system 字段不碰 user 字段", () => {
    useAppStore.getState().ensureCallDraft(sysKey, sysBaseline, source);
    useAppStore.getState().ensureCallDraft(userKey, userBaseline, source);
    useAppStore.getState().writeCallDraftText(sysKey, "sys 改动");
    useAppStore.getState().writeCallDraftText(userKey, "user 改动");

    // 确认放弃 system 字段（快照修订 CAS）
    const sysSnapshot = useAppStore.getState().callDraftOf(sysKey)!;
    expect(useAppStore.getState().discardCallDraft(sysKey, sysSnapshot.revision)).toBe(true);

    expect(useAppStore.getState().callDraftOf(sysKey)).toBeUndefined();
    // 另一字段逐字保留（同 span 的独立键互不影响）
    expect(useAppStore.getState().callDraftOf(userKey)?.text).toBe("user 改动");
  });
});
