import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// store 薄壳 import 时触到 window.api ⇒ 桩先就位（与 run-workspace.test.ts 同法）
(globalThis as Record<string, unknown>).window = { api: {} };

import type { DirectEditEvidence } from "../../src/shared/compare-edit-evidence";
const { EditEvidenceSection, evidenceCollapsible, evidenceSummaryText } = await import(
  "../src/renderer/src/components/CompareWorkspaceView"
);
const { useAppStore } = await import("../src/renderer/src/store");

/**
 * UI 密度 change（improve-workspace-reading-and-editing）任务 1.4/1.5：
 * 比较修改证据区「可收起且异常摘要常驻」的静态断言。
 *
 * 判据来源：desktop-ui delta 场景「修改证据收起释放输出空间」与
 * 「异常摘要始终可见」——收起释放 diff 高度，但字段/方向/修改概况与恢复入口可辨，
 * 缺证据/关系未知摘要不被收起藏掉。
 */

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

const VALUE_MARK = "原始结果正文的独特片段";

function verifiedDirect(): DirectEditEvidence {
  return {
    status: "verified",
    sourceRunId: "r_parent",
    targetRunId: "r_child",
    field: "result",
    atSpanId: "s_tool_01",
    variant: "isolated-v2",
    semantics: "shared-prefix",
    tool: "write_file",
    original: { kind: "value", value: VALUE_MARK },
    updated: { kind: "value", value: "fork 编辑后的新值" },
    resumeAfterStep: "s_step_01",
    boundaryStep: { spanId: "s_step_01", n: 1 },
  } as DirectEditEvidence;
}

describe("evidenceCollapsible / evidenceSummaryText（纯判据）", () => {
  it("verified 直接证据、逐跳链、不同根可收起；incomplete/unavailable/experiment 不可收起", () => {
    expect(
      evidenceCollapsible({
        kind: "direct",
        evidence: verifiedDirect(),
        direction: "left-to-right",
      }),
    ).toBe(true);
    expect(
      evidenceCollapsible({
        kind: "direct",
        evidence: { status: "notApplicable", reason: "两侧互不为直接父本" },
        direction: "left-to-right",
      }),
    ).toBe(false);
    expect(evidenceCollapsible({ kind: "incomplete", reason: "祖先判定不完整" })).toBe(false);
    expect(evidenceCollapsible({ kind: "unavailable", reason: "尚无结论" })).toBe(false);
  });

  it("收起摘要含字段与方向（直接证据）与修改数（逐跳链）", () => {
    expect(
      evidenceSummaryText({
        kind: "direct",
        evidence: verifiedDirect(),
        direction: "right-to-left",
      }),
    ).toBe("字段「result」 · 右列 → 左列");
    expect(
      evidenceSummaryText({
        kind: "hops",
        chains: [
          { runId: "r_b", hops: [verifiedDirect(), verifiedDirect()] },
          { runId: "r_c", hops: [verifiedDirect()] },
        ],
      }),
    ).toContain("3 处逐跳核对");
  });
});

describe("EditEvidenceSection：收起释放证据体空间，异常摘要常驻", () => {
  it("verified 证据收起：字段/方向摘要与恢复入口可见，前后值不渲染", () => {
    const out = html(
      createElement(EditEvidenceSection, {
        data: { kind: "direct", evidence: verifiedDirect(), direction: "left-to-right" },
        onOpenRun: () => {},
        collapsed: true,
        onToggleCollapsed: () => {},
      }),
    );
    expect(out).toContain("修改证据");
    expect(out).toContain("字段「result」");
    expect(out).toContain("左列 → 右列");
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain("展开");
    expect(out).not.toContain(VALUE_MARK);
    expect(out).not.toContain("fork 编辑后的新值");
  });

  it("展开后完整证据可见且内容区 id 与 aria-controls 对上", () => {
    const out = html(
      createElement(EditEvidenceSection, {
        data: { kind: "direct", evidence: verifiedDirect(), direction: "left-to-right" },
        onOpenRun: () => {},
        collapsed: false,
        onToggleCollapsed: () => {},
      }),
    );
    expect(out).toContain(VALUE_MARK);
    expect(out).toContain('aria-controls="compare-edit-evidence"');
    expect(out).toContain('id="compare-edit-evidence"');
  });

  it("notApplicable / unavailable 直接证据：提供开关也不可收起（原因常驻）", () => {
    const out = html(
      createElement(EditEvidenceSection, {
        data: {
          kind: "direct",
          evidence: { status: "notApplicable", reason: "两侧互不为直接父本，不构成直接父子编辑" },
          direction: "left-to-right",
        },
        onOpenRun: () => {},
        collapsed: true,
        onToggleCollapsed: () => {},
      }),
    );
    expect(out).toContain("两侧互不为直接父本");
    expect(out).not.toContain('aria-expanded="false"');
  });

  it("逐跳链收起：verified 跳收进摘要，unavailable 跳的原因行仍逐条可见", () => {
    const unavailableHop = {
      status: "unavailable" as const,
      sourceRunId: "r_x",
      targetRunId: "r_y",
      field: "result",
      atSpanId: "s_1",
      reasonCode: "START_CONTEXT_UNRECORDED" as const,
      reason: "来源 run 未记录可核对的首次调用",
      original: { kind: "unrecorded" as const },
      updated: { kind: "unrecorded" as const },
    };
    const out = html(
      createElement(EditEvidenceSection, {
        data: {
          kind: "hops",
          chains: [{ runId: "r_b", hops: [verifiedDirect(), unavailableHop] }],
        },
        onOpenRun: () => {},
        collapsed: true,
        onToggleCollapsed: () => {},
      }),
    );
    expect(out).toContain("2 处逐跳核对");
    expect(out).not.toContain(VALUE_MARK);
    // 异常摘要常驻（data-evidence-exceptions 容器）
    expect(out).toContain('data-evidence-exceptions="true"');
    expect(out).toContain("来源 run 未记录可核对的首次调用");
  });

  it("incomplete 分型：整体不可收起，原因常驻", () => {
    const out = html(
      createElement(EditEvidenceSection, {
        data: { kind: "incomplete", reason: "共同祖先判定不完整（存在父缺失）" },
        onOpenRun: () => {},
        collapsed: true,
        onToggleCollapsed: () => {},
      }),
    );
    expect(out).toContain("共同祖先判定不完整");
    expect(out).not.toContain("aria-expanded");
  });

  it("省略 collapsed/onToggleCollapsed 时保持展开旧行为（既有调用点不破坏）", () => {
    const out = html(
      createElement(EditEvidenceSection, {
        data: { kind: "direct", evidence: verifiedDirect(), direction: "left-to-right" },
        onOpenRun: () => {},
      }),
    );
    expect(out).toContain(VALUE_MARK);
  });
});

describe("store：证据区展开态（会话级，默认收起）", () => {
  it("compareEvidenceExpanded 默认 false；setter 只动这一位", () => {
    const before = useAppStore.getState().compareEvidenceExpanded;
    expect(before).toBe(false);
    useAppStore.getState().setCompareEvidenceExpanded(true);
    expect(useAppStore.getState().compareEvidenceExpanded).toBe(true);
    // 复位，避免污染同文件其他用例
    useAppStore.getState().setCompareEvidenceExpanded(false);
    expect(useAppStore.getState().compareEvidenceExpanded).toBe(false);
  });
});
