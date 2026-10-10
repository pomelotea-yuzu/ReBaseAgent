import type { Fork, SpanLine } from "@rebaseagent/trace-sdk/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CompareWorkspaceView,
  DirectEvidenceBlock,
  EditEvidenceSection,
  SideOutputSection,
  SideStepsSection,
} from "../src/renderer/src/components/CompareWorkspaceView";
import type {
  CompareSideViewData,
  EvidenceViewData,
} from "../src/renderer/src/components/CompareWorkspaceView";
import { deriveCompareFileEntry } from "../src/renderer/src/lib/compare-files";
import { deriveSideStepCatalog } from "../src/renderer/src/lib/compare-steps";
import { deriveSideOutputFacts } from "../src/shared/compare-output";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 4.6/4.12：比较工作区展示层的静态断言。
 *
 * 本包无 jsdom：zustand 薄壳在 renderToStaticMarkup 下走 getServerSnapshot（恒初始值）
 * ⇒ 组件必须只吃 props（判据由容器派生）。这里直接喂构造好的 props，钉住：
 * - 输出区缺型分层（最终输出 / 中间正文 / 缺失说明）与错误跳转按钮；
 * - diff 门禁禁用与可用两种头部形态；diff 模式的面板锚点；
 * - 步骤目录折叠摘要 / ownOnly 提示 / 编辑标记 / 复合定位选中态；
 * - 编辑证据三态（方向、前后值、语义标签、逐跳链、不同根两列）。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function meta(id: string, parent: string | null, fork: Fork | null): RunDetail["meta"] {
  return {
    type: "run.meta",
    id,
    format_version: 1,
    task: `任务 ${id}`,
    model: "controlled-model",
    created_at: T0,
    parent,
    fork,
  };
}

function stepSpan(
  id: string,
  n = 1,
  parent: string | null = null,
): Extract<SpanLine, { kind: "agent.step" }> {
  return { type: "span", id, parent, kind: "agent.step", n };
}

function toolSpan(id: string, parent: string | null): Extract<SpanLine, { kind: "tool.invoke" }> {
  return {
    type: "span",
    id,
    parent,
    kind: "tool.invoke",
    tool: "write_file",
    args: {},
    result: "值",
    dur_ms: 1,
    error: null,
  };
}

function llmSpan(
  id: string,
  opts: { content?: string; error?: { message: string } } = {},
): Extract<SpanLine, { kind: "llm.call" }> {
  return {
    type: "span",
    id,
    parent: "s_01",
    kind: "llm.call",
    request: { model: "m", messages: [] },
    response: {
      content: opts.content ?? null,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 1, out: 1, cache_hit: 0 },
      ttft_ms: 0,
    },
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

function hop(id: string, parent: string | null, fork: Fork | null): RunDetail["chain"][number] {
  return { meta: meta(id, parent, fork), fork };
}

function completedDetail(id: string, spans: SpanLine[]): RunDetail {
  return {
    meta: meta(id, null, null),
    spans,
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    chain: [hop(id, null, null)],
    leafSpanIds: spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

function okSide(side: "left" | "right", runId: string, spans: SpanLine[]): CompareSideViewData {
  const detail = completedDetail(runId, spans);
  return {
    side,
    runId,
    // U7 5.1：标题短 ID（测试里手工给一个与完整 id 不同的值以断言展示来源）
    shortId: runId.slice(-8),
    facts: deriveSideOutputFacts(detail),
    unavailableReason: null,
    // U7 5.6/5.7：文件入口判据（与容器同源派生）
    fileEntry: deriveCompareFileEntry({
      detail,
      selectedSpanId: null,
      savedTab: undefined,
    }),
    onOpenFiles: vi.fn(),
    catalog: deriveSideStepCatalog(detail),
    folded: false,
    selectedSpanId: null,
    onToggleFold: vi.fn(),
    onSelectStep: vi.fn(),
    onOpenError: vi.fn(),
  };
}

const IDLE_ACTIONS = {
  onToggleFold: vi.fn(),
  onSelectStep: vi.fn(),
  onOpenError: vi.fn(),
};

describe("SideOutputSection：输出分层与错误定位", () => {
  it("最终输出正文 + 结局标签就位", () => {
    const facts = deriveSideOutputFacts(
      completedDetail("r_ok", [stepSpan("s_01"), llmSpan("c_01", { content: "最终正文" })]),
    );
    const html = renderToStaticMarkup(
      <SideOutputSection
        side="left"
        facts={facts}
        unavailableReason={null}
        onOpenError={IDLE_ACTIONS.onOpenError}
      />,
    );
    expect(html).toContain("最终正文");
    expect(html).toContain("已结束");
    expect(html).toContain("r_ok");
  });

  it("失败侧：未记录最终输出说明 + 中间正文（不冒充最终结果）+ 打开失败调用按钮", () => {
    const detail: RunDetail = {
      meta: meta("r_err", null, null),
      spans: [
        stepSpan("s_01"),
        llmSpan("c_01", { content: "中断前正文" }),
        llmSpan("c_02", { error: { message: "上游 500" } }),
      ],
      events: [{ type: "run.event", event: "stopped", reason: "error" }],
      status: "completed",
      chain: [hop("r_err", null, null)],
      leafSpanIds: ["s_01", "c_01", "c_02"],
      completeness: "complete",
      spanScope: "own",
      lineage: { status: "complete" },
    };
    const errFacts = deriveSideOutputFacts(detail);
    const html = renderToStaticMarkup(
      <SideOutputSection
        side="right"
        facts={errFacts}
        unavailableReason={null}
        onOpenError={IDLE_ACTIONS.onOpenError}
      />,
    );
    expect(html).toContain("未记录最终输出");
    expect(html).toContain("中断前正文");
    expect(html).toContain("不是最终结果");
    expect(html).toContain("打开 r_err 的失败调用");
    expect(html).toContain("c_02");
    expect(html).toContain("上游 500");
  });

  it("不可读侧：真实身份与受控原因，不伪正文", () => {
    const html = renderToStaticMarkup(
      <SideOutputSection
        side="left"
        facts={null}
        unavailableReason="祖先记录损坏（ANCESTOR_INVALID）"
        onOpenError={IDLE_ACTIONS.onOpenError}
      />,
    );
    expect(html).toContain("该侧不可读");
    expect(html).toContain("ANCESTOR_INVALID");
  });
});

describe("SideStepsSection：折叠摘要 / ownOnly / 编辑标记 / 选中态", () => {
  function chainCatalog() {
    const view = [
      stepSpan("a1"),
      toolSpan("a2", "a1"),
      stepSpan("b1", 1, "a2"),
      toolSpan("b2", "b1"),
    ];
    const bFork: Fork = { at_span: "a2", edit: { field: "result", value: "B 的编辑" } };
    const detail: RunDetail = {
      meta: meta("r_b", "r_a", bFork),
      spans: view,
      events: [{ type: "run.event", event: "stopped", reason: "completed" }],
      status: "completed",
      chain: [hop("r_a", null, null), hop("r_b", "r_a", bFork)],
      leafSpanIds: ["b1", "b2"],
      completeness: "complete",
      spanScope: "resolved",
      lineage: { status: "complete" },
    };
    return deriveSideStepCatalog(detail);
  }

  it("折叠态：摘要行（行数/来源/编辑数）+ 自有行；展开态：全部行带来源与编辑标记", () => {
    const catalog = chainCatalog();
    const foldedHtml = renderToStaticMarkup(
      <SideStepsSection catalog={catalog} folded={true} selectedSpanId={null} {...IDLE_ACTIONS} />,
    );
    expect(foldedHtml).toContain("共享前缀：2 条来自 r_a（含 1 处编辑）");
    expect(foldedHtml).toContain("展开完整前缀");
    expect(foldedHtml).not.toContain("来自 r_a</span>"); // 前缀行被收进摘要

    const expandedHtml = renderToStaticMarkup(
      <SideStepsSection catalog={catalog} folded={false} selectedSpanId={null} {...IDLE_ACTIONS} />,
    );
    expect(expandedHtml).toContain("编辑点（result）");
    expect(expandedHtml).toContain("来自 r_a");
  });

  it("复合定位：选中态 aria-pressed 落在本侧行上", () => {
    const catalog = chainCatalog();
    const html = renderToStaticMarkup(
      <SideStepsSection catalog={catalog} folded={false} selectedSpanId="b1" {...IDLE_ACTIONS} />,
    );
    expect(html).toContain('aria-pressed="true"');
  });

  it("ownOnly 侧：前缀未知提示就位", () => {
    const orphanFork: Fork = { at_span: "x1", edit: { field: "result", value: "编辑" } };
    const detail: RunDetail = {
      meta: meta("r_o", "r_x", orphanFork),
      spans: [stepSpan("o1")],
      events: [{ type: "run.event", event: "stopped", reason: "completed" }],
      status: "completed",
      chain: [hop("r_o", "r_x", orphanFork)],
      leafSpanIds: ["o1"],
      completeness: "ownOnly",
      spanScope: "own",
      lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_x" },
    };
    const html = renderToStaticMarkup(
      <SideStepsSection
        catalog={deriveSideStepCatalog(detail)}
        folded={true}
        selectedSpanId={null}
        {...IDLE_ACTIONS}
      />,
    );
    expect(html).toContain("前缀未知");
    expect(html).toContain("不按可见链首项推断根");
  });
});

describe("EditEvidenceSection：三态与分型呈现", () => {
  const verified: EvidenceViewData = {
    kind: "direct",
    direction: "left-to-right",
    evidence: {
      status: "verified",
      sourceRunId: "r_a",
      targetRunId: "r_b",
      field: "result",
      atSpanId: "a2",
      variant: "plain-v1",
      semantics: "shared-prefix",
      tool: "write_file",
      original: { kind: "value", value: "原始工具结果" },
      updated: { kind: "value", value: "编辑后的结果" },
      resumeAfterStep: null,
      boundaryStep: null,
    },
  };

  it("verified：方向标注（左列 → 右列）、语义标签、前后值、工具结果措辞", () => {
    const html = renderToStaticMarkup(<EditEvidenceSection data={verified} />);
    expect(html).toContain("左列 → 右列");
    expect(html).toContain("共享父前缀");
    expect(html).toContain("原始工具结果");
    expect(html).toContain("编辑后的结果");
    expect(html).toContain("不是文件修改");
  });

  it("v2 隔离：整轮边界（轮号）呈现", () => {
    const html = renderToStaticMarkup(
      <EditEvidenceSection
        data={{
          kind: "direct",
          direction: "right-to-left",
          evidence: {
            status: "verified",
            sourceRunId: "r_a",
            targetRunId: "r_b",
            field: "result",
            atSpanId: "a2",
            variant: "isolated-v2",
            semantics: "shared-prefix",
            tool: "write_file",
            original: { kind: "value", value: "原值" },
            updated: { kind: "value", value: "新值" },
            resumeAfterStep: "a1",
            boundaryStep: { spanId: "a1", n: 3 },
          },
        }}
      />,
    );
    expect(html).toContain("右列 → 左列");
    expect(html).toContain("隔离整轮边界：第 3 轮（a1）之后续跑");
  });

  it("unavailable：稳定码与受控原因，已得一侧的值仍可读", () => {
    const html = renderToStaticMarkup(
      <EditEvidenceSection
        data={{
          kind: "direct",
          direction: "left-to-right",
          evidence: {
            status: "unavailable",
            sourceRunId: "r_a",
            targetRunId: "r_b",
            field: "result",
            atSpanId: "t_missing",
            reasonCode: "FORK_SPAN_NOT_FOUND",
            reason: "分叉点 t_missing 未出现在来源 run r_a 的轨迹中：原值无法核对",
            original: { kind: "unrecorded" },
            updated: { kind: "value", value: "新值" },
          },
        }}
      />,
    );
    expect(html).toContain("FORK_SPAN_NOT_FOUND");
    expect(html).toContain("原值无法核对");
    expect(html).toContain("新值");
    expect(html).toContain("未记录（不是空值）");
  });

  it("逐跳链：每跳 source→target 独立成行（不压缩）", () => {
    const html = renderToStaticMarkup(
      <EditEvidenceSection
        data={{
          kind: "hops",
          chains: [
            {
              runId: "r_c",
              hops: [
                {
                  status: "verified",
                  sourceRunId: "r_a",
                  targetRunId: "r_b",
                  field: "result",
                  atSpanId: "a2",
                  variant: "plain-v1",
                  semantics: "shared-prefix",
                  tool: "write_file",
                  original: { kind: "value", value: "原值" },
                  updated: { kind: "value", value: "B 的编辑" },
                  resumeAfterStep: null,
                  boundaryStep: null,
                },
                {
                  status: "verified",
                  sourceRunId: "r_b",
                  targetRunId: "r_c",
                  field: "result",
                  atSpanId: "b2",
                  variant: "plain-v1",
                  semantics: "shared-prefix",
                  tool: "write_file",
                  original: { kind: "value", value: "原值" },
                  updated: { kind: "value", value: "C 的编辑" },
                  resumeAfterStep: null,
                  boundaryStep: null,
                },
              ],
            },
          ],
        }}
      />,
    );
    expect(html).toContain("逐跳来源链");
    expect(html).toContain("r_a → r_b");
    expect(html).toContain("r_b → r_c");
  });

  it("不同根：两列事实并排，未记录如实标注", () => {
    const html = renderToStaticMarkup(
      <EditEvidenceSection
        data={{
          kind: "different-roots",
          facts: {
            status: "facts",
            sides: [
              {
                runId: "r_l",
                model: { kind: "value", value: "model-a" },
                systemPrompt: { kind: "value", value: "左系统提示" },
                userMessage: { kind: "unrecorded" },
                params: { kind: "unrecorded" },
              },
              {
                runId: "r_r",
                model: { kind: "value", value: "model-b" },
                systemPrompt: { kind: "unrecorded" },
                userMessage: { kind: "value", value: "右用户消息" },
                params: { kind: "value", value: { temperature: 0.7 } },
              },
            ],
          },
        }}
      />,
    );
    expect(html).toContain("不同根");
    expect(html).toContain("model-a");
    expect(html).toContain("model-b");
    expect(html).toContain("未记录");
  });
});

describe("CompareWorkspaceView：整体形态", () => {
  const left = okSide("left", "r_l", [stepSpan("s_01"), llmSpan("c_01", { content: "左侧正文" })]);
  const right = okSide("right", "r_r", [
    stepSpan("s_01"),
    llmSpan("c_01", { content: "右侧正文" }),
  ]);

  const baseProps = {
    pair: { leftRunId: "r_l", rightRunId: "r_r" },
    loading: false,
    stacked: false,
    left,
    right,
    diffMode: false,
    onToggleDiffMode: vi.fn(),
    onSwap: vi.fn(),
    onReturn: vi.fn(),
    evidence: {
      kind: "unavailable",
      reason: "尚无可核对两侧的比较结论",
    } as EvidenceViewData,
  };

  it("双列标题、交换/返回按钮就位；门禁可用时 diff 按钮可点", () => {
    const html = renderToStaticMarkup(
      <CompareWorkspaceView
        {...baseProps}
        diffGate={{
          status: "available",
          leftText: "左侧正文",
          rightText: "右侧正文",
          leftSpanId: "c_01",
          rightSpanId: "c_01",
        }}
      />,
    );
    expect(html).toContain("左列");
    expect(html).toContain("右列");
    expect(html).toContain("交换左右");
    expect(html).toContain("返回来源");
    expect(html).toContain('aria-label="切换文本差异"');
    // diff 门禁可用 ⇒ diff 按钮不禁用（普通 run 的「打开文件」禁用是 5.7 的预期行为）
    expect(html.match(/aria-label="切换文本差异"[^>]*disabled=""/)).toBeNull();
  });

  it("门禁不可用 ⇒ diff 按钮禁用且原因可读； unavailable 侧不伪正文", () => {
    const html = renderToStaticMarkup(
      <CompareWorkspaceView
        {...baseProps}
        left={{ ...left, facts: null, unavailableReason: "祖先记录损坏（ANCESTOR_INVALID）" }}
        diffGate={{
          status: "unavailable",
          reason: "左侧（r_l）未记录任何自有模型调用：不能作为空文本参与 diff",
        }}
      />,
    );
    expect(html).toContain("该侧不可读");
    expect(html).toContain("ANCESTOR_INVALID");
    expect(html).toContain('disabled=""');
    expect(html).toContain("不能作为空文本参与 diff");
  });

  it("diff 模式（门禁可用）⇒ 只读 DiffEditor 面板就位", () => {
    const html = renderToStaticMarkup(
      <CompareWorkspaceView
        {...baseProps}
        diffMode={true}
        diffGate={{
          status: "available",
          leftText: "左侧正文",
          rightText: "右侧正文",
          leftSpanId: "c_01",
          rightSpanId: "c_01",
        }}
      />,
    );
    expect(html).toContain('data-testid="compare-diff-panel"');
    expect(html).toContain("compare-diff-editor");
    expect(html).toContain("同步滚动");
    // 4.2 实测（zoom2 档编辑器塌至 49.7px）后的挤压下限：与文件页 2.1 高度链同款 min-h-[200px]
    expect(html).toContain("min-h-[200px] flex-1 overflow-hidden p-2");
  });
});

describe("5.1 会话短 ID：比较标题与完整 ID 复制", () => {
  const left = okSide("left", "r_left_side_0001", [stepSpan("s_01")]);
  const right = okSide("right", "r_right_side_0002", [stepSpan("s_01")]);
  const baseProps = {
    pair: { leftRunId: "r_left_side_0001", rightRunId: "r_right_side_0002" },
    loading: false,
    stacked: false,
    left,
    right,
    diffMode: false,
    onToggleDiffMode: vi.fn(),
    onSwap: vi.fn(),
    onReturn: vi.fn(),
    onOpenRun: vi.fn(),
    evidence: {
      kind: "unavailable",
      reason: "尚无可核对两侧的比较结论",
    } as EvidenceViewData,
  };

  it("两侧标题显示短 ID，复制按钮的可访问名称携带完整 ID", () => {
    const html = renderToStaticMarkup(
      <CompareWorkspaceView
        {...baseProps}
        diffGate={{ status: "unavailable", reason: "不可用" }}
      />,
    );
    // 短 ID 在场（测试里取末 8 位）
    expect(html).toContain("ide_0001");
    expect(html).toContain("ide_0002");
    // 复制目标 = 完整 ID（可证伪契约：改成短后缀应有用例变红）
    expect(html).toContain('aria-label="复制完整 ID r_left_side_0001"');
    expect(html).toContain('aria-label="复制完整 ID r_right_side_0002"');
  });

  it("diff 页头用短 ID 标识两侧，并保留完整 ID 的悬停与复制入口", () => {
    const html = renderToStaticMarkup(
      <CompareWorkspaceView
        {...baseProps}
        diffMode={true}
        diffGate={{
          status: "available",
          leftText: "左",
          rightText: "右",
          leftSpanId: "c_01",
          rightSpanId: "c_01",
        }}
      />,
    );
    expect(html).toContain("只读文本差异 · 最终输出 · 同步滚动");
    expect(html).toMatch(/左侧[\s\S]*ide_0001[\s\S]*→[\s\S]*右侧[\s\S]*ide_0002/);
    expect(html).toContain('title="r_left_side_0001"');
    expect(html).toContain('title="r_right_side_0002"');
    expect(html).toContain('aria-label="复制完整 ID r_left_side_0001"');
    expect(html).toContain('aria-label="复制完整 ID r_right_side_0002"');
  });
});

describe("5.6/5.7 单侧文件入口", () => {
  /** 隔离运行详情（meta 带 workspace ⇒ 有自有文件能力） */
  function isolatedDetail(id: string): RunDetail {
    const detail = completedDetail(id, [stepSpan("s_01"), stepSpan("s_02", 2, "s_01")]);
    return {
      ...detail,
      meta: { ...detail.meta, workspace: { profile: "isolated" } } as RunDetail["meta"],
    };
  }

  it("available：按钮可点，可访问名称 = 「打开左列文件/右列文件」", () => {
    const html = renderToStaticMarkup(
      <SideOutputSection
        side="left"
        facts={deriveSideOutputFacts(completedDetail("r_x", [stepSpan("s_01")]))}
        unavailableReason={null}
        onOpenError={vi.fn()}
      />,
    );
    expect(html).toContain("左列");
    // 真按钮断言打在整体形态用例里（见下）：这里先钉 available 判据本身
    const entry = deriveCompareFileEntry({
      detail: isolatedDetail("r_i"),
      selectedSpanId: "s_02",
      savedTab: undefined,
    });
    expect(entry).toEqual({
      kind: "available",
      targetCheckpointStepId: "s_02",
      note: null,
    });
  });

  it("not-isolated：普通运行入口禁用并给原因（不造文件历史）", () => {
    const entry = deriveCompareFileEntry({
      detail: completedDetail("r_plain", [stepSpan("s_01")]),
      selectedSpanId: null,
      savedTab: undefined,
    });
    expect(entry.kind).toBe("not-isolated");
    if (entry.kind === "not-isolated") {
      expect(entry.reason).toContain("不生成文件历史");
    }
  });

  it("unavailable 侧：无入口按钮（fileEntry 为 null）", () => {
    const html = renderToStaticMarkup(
      <CompareWorkspaceView
        pair={{ leftRunId: "r_l", rightRunId: "r_r" }}
        loading={false}
        left={okSide("left", "r_l", [stepSpan("s_01")])}
        right={{
          ...okSide("right", "r_r", [stepSpan("s_01")]),
          facts: null,
          unavailableReason: "祖先记录损坏（ANCESTOR_INVALID）",
          fileEntry: null,
        }}
        diffGate={{ status: "unavailable", reason: "不可用" }}
        diffMode={false}
        onToggleDiffMode={vi.fn()}
        onSwap={vi.fn()}
        onReturn={vi.fn()}
        stacked={false}
        onOpenRun={vi.fn()}
        evidence={{ kind: "unavailable", reason: "尚无可核对两侧的比较结论" }}
      />,
    );
    expect(html).toContain('aria-label="打开左列文件"');
    expect(html).not.toContain('aria-label="打开右列文件"');
  });

  it("整体形态：available 侧按钮可点，not-isolated 侧按钮禁用带原因", () => {
    const isolated = okSide("left", "r_l", [stepSpan("s_01")]);
    const isolatedDetail = completedDetail("r_l", [stepSpan("s_01"), stepSpan("s_02", 2, "s_01")]);
    const withWorkspace = {
      ...isolatedDetail,
      meta: { ...isolatedDetail.meta, workspace: { profile: "isolated" } } as RunDetail["meta"],
    };
    const html = renderToStaticMarkup(
      <CompareWorkspaceView
        pair={{ leftRunId: "r_l", rightRunId: "r_r" }}
        loading={false}
        left={{
          ...isolated,
          fileEntry: deriveCompareFileEntry({
            detail: withWorkspace,
            selectedSpanId: null,
            savedTab: undefined,
          }),
        }}
        right={okSide("right", "r_r", [stepSpan("s_01")])}
        diffGate={{ status: "unavailable", reason: "不可用" }}
        diffMode={false}
        onToggleDiffMode={vi.fn()}
        onSwap={vi.fn()}
        onReturn={vi.fn()}
        stacked={false}
        onOpenRun={vi.fn()}
        evidence={{ kind: "unavailable", reason: "尚无可核对两侧的比较结论" }}
      />,
    );
    expect(html).toContain('aria-label="打开左列文件"');
    expect(html).not.toContain('disabled="" aria-label="打开左列文件"');
    // 右侧普通 run ⇒ 禁用 + 原因可读
    expect(html).toContain('aria-label="打开右列文件"');
    expect(html).toContain("不生成文件历史");
  });
});

describe("5.9 键盘交互与异步焦点", () => {
  const left = okSide("left", "r_l", [stepSpan("s_01"), llmSpan("c_01", { content: "左侧正文" })]);
  const right = okSide("right", "r_r", [
    stepSpan("s_01"),
    llmSpan("c_01", { content: "右侧正文" }),
  ]);
  const props = {
    pair: { leftRunId: "r_l", rightRunId: "r_r" },
    left,
    right,
    diffMode: false,
    onToggleDiffMode: vi.fn(),
    onSwap: vi.fn(),
    onReturn: vi.fn(),
    stacked: false,
    onOpenRun: vi.fn(),
    onOpenMetricsTable: vi.fn(),
    evidence: {
      kind: "unavailable",
      reason: "尚无可核对两侧的比较结论",
    } as EvidenceViewData,
  };

  it("动作按钮全部带 focus-visible 焦点环（键盘焦点可见）", () => {
    const html = renderToStaticMarkup(
      <CompareWorkspaceView
        {...props}
        loading={false}
        diffGate={{ status: "unavailable", reason: "不可用" }}
      />,
    );
    expect(html).toContain("focus-visible:ring-2");
    // 主要异步焦点落点在场
    expect(html).toContain('data-compare-primary="true"');
  });

  it("在飞读取不卸载动作按钮（交换/加载/重试不把焦点甩回页顶的静态前提）", () => {
    const idle = renderToStaticMarkup(
      <CompareWorkspaceView
        {...props}
        loading={false}
        diffGate={{ status: "unavailable", reason: "不可用" }}
      />,
    );
    const loading = renderToStaticMarkup(
      <CompareWorkspaceView
        {...props}
        loading={true}
        diffGate={{ status: "unavailable", reason: "不可用" }}
      />,
    );
    for (const marker of ['aria-label="交换左右"', 'aria-label="返回来源"']) {
      expect(idle).toContain(marker);
      expect(loading).toContain(marker);
    }
  });
});

describe("5.11/5.15 模型实验比较区", () => {
  it("eligible：批次身份 + 相对父累计增量 + 无臂间结论恒定说明 + 副作用放行说明", () => {
    const html = renderToStaticMarkup(
      <EditEvidenceSection
        stacked={false}
        onOpenRun={vi.fn()}
        data={{
          kind: "experiment",
          gate: {
            status: "eligible",
            code: "OK",
            reason: "同父合法臂",
            batch: { parentRunId: "r_p", experimentIds: ["exp_1", null] },
          },
          deltas: [
            { runId: "r_a1", tokens: 28, durationMs: 150 },
            { runId: "r_a2", tokens: null, durationMs: null },
          ],
          sideEffectsDeclared: true,
        }}
      />,
    );
    expect(html).toContain("模型实验比较（历史记录）");
    expect(html).toContain("r_p");
    expect(html).toContain("exp_1");
    expect(html).toContain("（未记录）");
    expect(html).toContain("28 tokens");
    expect(html).toContain("未知（不估算）");
    expect(html).toContain("顺序执行");
    expect(html).toContain("不产出臂间差值、胜出臂或最佳模型结论");
  });

  it("ineligible：受控原因 + 各记录单独打开入口（不恢复资格措辞）", () => {
    const html = renderToStaticMarkup(
      <EditEvidenceSection
        stacked={false}
        onOpenRun={vi.fn()}
        data={{
          kind: "experiment",
          gate: {
            status: "ineligible",
            code: "MIXED_SELECTION",
            reason: "选择集混入非实验臂：不能退回普通比较绕过实验资格",
            batch: null,
          },
          deltas: [
            { runId: "r_a1", tokens: null, durationMs: null },
            { runId: "r_n", tokens: null, durationMs: null },
          ],
          sideEffectsDeclared: false,
        }}
      />,
    );
    expect(html).toContain("MIXED_SELECTION");
    expect(html).toContain("不能退回普通比较绕过实验资格");
    expect(html).toContain('aria-label="打开记录 r_a1"');
    expect(html).toContain("不恢复实验资格、不产生执行授权");
  });
});

describe("5.8 宽度适配：并排 / 上下排列", () => {
  const left = okSide("left", "r_l", [stepSpan("s_01"), llmSpan("c_01", { content: "左侧正文" })]);
  const right = okSide("right", "r_r", [
    stepSpan("s_01"),
    llmSpan("c_01", { content: "右侧正文" }),
  ]);
  const props = {
    pair: { leftRunId: "r_l", rightRunId: "r_r" },
    loading: false,
    stacked: false,
    left,
    right,
    diffMode: false,
    onToggleDiffMode: vi.fn(),
    onSwap: vi.fn(),
    onReturn: vi.fn(),
    onOpenRun: vi.fn(),
    evidence: {
      kind: "unavailable",
      reason: "尚无可核对两侧的比较结论",
    } as EvidenceViewData,
  };

  it("宽容器 ⇒ 并排两列（grid-cols-2）", () => {
    const html = renderToStaticMarkup(
      <CompareWorkspaceView
        {...props}
        stacked={false}
        diffGate={{ status: "unavailable", reason: "不可用" }}
      />,
    );
    expect(html).toContain("grid-cols-2");
    expect(html).not.toContain('data-stacked="true"');
  });

  it("窄容器 ⇒ 上下排列（grid-cols-1）且对象标题重复（每列自带标题区）", () => {
    const html = renderToStaticMarkup(
      <CompareWorkspaceView
        {...props}
        stacked={true}
        diffGate={{ status: "unavailable", reason: "不可用" }}
      />,
    );
    expect(html).toContain("grid-cols-1");
    expect(html).toContain('data-stacked="true"');
    // 上下排列时标题随每列头部重复：左右两侧的标题区与身份都在
    expect(html).toContain("左列");
    expect(html).toContain("右列");
    expect(html).toContain('aria-label="复制完整 ID r_l"');
    expect(html).toContain('aria-label="复制完整 ID r_r"');
  });
});
