import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { captureCallDraftSource } from "../src/renderer/src/lib/draft-source";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U3（preserve-debugging-drafts）任务 2.4：A/B 编辑器接入批次草稿。
 *
 * 判据来源（tasks 2.4 验收 + delta「实验批次按会话草稿恢复」）：
 *   - 实验臂增删和非法参数可恢复（稳定行 ID；非法 paramsText 原样）
 *   - 实验预览和结果不隐式清理批次（预检/执行只动本地 plan/executed）
 *   - 恢复时清理临时计划和许可（打开即复位：计划重新校验、授权重新勾选）
 *
 * ⚠️ 本包无 jsdom ⇒ 与 2.1/2.2/2.3 同法：源码级接线契约 + store 同形调用行为；
 *    实机往返归 CDP（任务 6.2）。
 */

// ---------------------------------------------------------------------------
// 源码级接线契约
// ---------------------------------------------------------------------------

const DETAIL_PANEL = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
  "utf8",
);

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = DETAIL_PANEL.indexOf(startMarker);
  const end = DETAIL_PANEL.indexOf(endMarker, start + 1);
  if (start < 0 || end < 0 || end <= start) throw new Error(`切片失败：${startMarker}`);
  return DETAIL_PANEL.slice(start, end);
}

describe("接线契约：ModelAbEditor 批次草稿（任务 2.4）", () => {
  const src = () => sliceBetween("function ModelAbEditor(", "/** llm.call 详情");

  it("打开经 ensureModelAbDraft 登记基线臂与源基线；行来自草稿条目", () => {
    const code = src();
    expect(code).toContain(
      "ensureModelAbDraft(draftKey, baselineArms, captureCallDraftSource(run, span))",
    );
    expect(code).toContain("s.modelAbDraftOf(draftKey)");
    // 行 ID 用共享生成器（1.3 预留），不再持有本地行 state
    expect(code).toContain("newArmRowKey()");
    expect(
      auditForbiddenTokens(code, ["setRows", "useState<Array<{ key: string; arm: ArmDraft }>>"]),
    ).toEqual([]);
  });

  it("增删行/改参数统一经 setModelAbRows 落 store；行变更作废已校验计划", () => {
    const code = src();
    // store 动作在组件里别名为 writeRows（选择器处可见真实通道名）
    expect(code).toContain("s.setModelAbRows");
    expect(code).toContain("writeRows(");
    // commitRows 是唯一行写入路径（updateArm / 删行 / 加行都走它），且都清 plan
    expect(code).toContain("const commitRows = ");
    expect(code).toContain("setPlan(null);");
  });

  it("打开即清理临时计划与许可（授权不随草稿恢复）；放弃只经失效视图 CAS，预览/执行不隐式清理批次", () => {
    const code = src();
    // 打开点击序列：复位本地临时态 + ensure 草稿
    expect(code).toContain("setExecuted(null);");
    expect(code).toContain("setPlan(null);");
    expect(code).toContain("setAllowSideEffects(false);");
    // U3 2.5：放弃入口只在来源失效视图（CAS + 确认）；预览/执行路径无任何草稿删除
    expect(code).toContain("DraftSourceBanner");
    expect(code).toContain("discardModelAbDraft(draftKey, draftEntry.revision)");
  });
});

// ---------------------------------------------------------------------------
// store 行为：增删行与非法参数恢复（编辑器同形调用）
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

describe("store 行为：A/B 批次草稿的增删行与恢复（ModelAbEditor 同形调用）", () => {
  const key = { runId: detail.meta.id, spanId: "s_02" };
  const source = captureCallDraftSource(detail, firstLlmSpan);
  const BASELINE = [
    { model: "deepseek-chat", paramsText: "" },
    { model: "deepseek-chat", paramsText: "" },
  ];

  beforeEach(() => {
    useAppStore.setState({ drafts: draftsModule.emptyDraftRepo() });
  });

  it("打开 → 改参数（含非法 JSON）/增删行 → 关闭往返 → 重开：逐字恢复且行 ID 稳定", () => {
    // 打开（编辑器同形：ensure 基线臂 + 源基线）
    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    const initialKeys = useAppStore
      .getState()
      .modelAbDraftOf(key)!
      .rows.map((r) => r.key);

    // 改第一臂 paramsText 为非法 JSON（guard 会拦提交，但草稿原样暂存）
    const rows1 = useAppStore.getState().modelAbDraftOf(key)!.rows;
    useAppStore
      .getState()
      .setModelAbRows(key, [{ ...rows1[0]!, model: "m-b", paramsText: "]{ 非法 JSON" }, rows1[1]!]);
    // 加一臂
    const rows2 = useAppStore.getState().modelAbDraftOf(key)!.rows;
    useAppStore
      .getState()
      .setModelAbRows(key, [
        ...rows2,
        { key: draftsModule.newArmRowKey(), model: "m-c", paramsText: "" },
      ]);

    // 关闭往返（store 其他状态翻动；组件卸载）
    useAppStore.setState({ detail: null, selectedRunId: null });

    // 重开（ensure 原样保留）——臂内容与行 ID 都恢复
    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    const restored = useAppStore.getState().modelAbDraftOf(key)!;
    expect(restored.rows.map((r) => r.model)).toEqual(["m-b", "deepseek-chat", "m-c"]);
    expect(restored.rows[0]!.paramsText).toBe("]{ 非法 JSON");
    expect(restored.rows.map((r) => r.key)).toEqual([...initialKeys, restored.rows[2]!.key]);
  });

  it("删行恢复：删除的臂重开仍不在（批次修订推进）", () => {
    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    const rows = useAppStore.getState().modelAbDraftOf(key)!.rows;
    useAppStore
      .getState()
      .setModelAbRows(key, [
        rows[0]!,
        rows[1]!,
        { key: draftsModule.newArmRowKey(), model: "m-c", paramsText: "" },
      ]);
    const rows3 = useAppStore.getState().modelAbDraftOf(key)!.rows;
    useAppStore.getState().setModelAbRows(key, [rows3[0]!, rows3[1]!]);

    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    expect(
      useAppStore
        .getState()
        .modelAbDraftOf(key)!
        .rows.map((r) => r.model),
    ).toEqual(["deepseek-chat", "deepseek-chat"]);
  });

  it("仅行 ID 变化不推进修订；语义变化推进（dirty 判据不比较随机行 ID）", () => {
    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    const before = useAppStore.getState().modelAbDraftOf(key)!;

    // 同语义 + 换行 ID（删同内容臂再加回的等价场景）
    useAppStore.getState().setModelAbRows(
      key,
      [before.rows[1]!, before.rows[0]!].map((r) => ({ ...r, key: draftsModule.newArmRowKey() })),
    );
    const afterKeySwap = useAppStore.getState().modelAbDraftOf(key)!;
    expect(afterKeySwap.revision).toBe(before.revision);

    // 语义变化（model 改了）⇒ 推进
    const rows = afterKeySwap.rows;
    useAppStore.getState().setModelAbRows(key, [{ ...rows[0]!, model: "m-x" }, rows[1]!]);
    expect(useAppStore.getState().modelAbDraftOf(key)!.revision).toBeGreaterThan(before.revision);
  });
});
