import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunDetail } from "../src/shared/ipc";

// OverviewPanel 的 store 薄壳在 import 时就会触到 `window.api` ⇒ 桩必须先就位；
// ESM 静态 import 会被提升，故用动态 import（同 overview-consumption-source.test.ts）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { SourceSectionView } = await import("../src/renderer/src/components/OverviewPanel");
const { LineageIncompleteNoticeView } = await import(
  "../src/renderer/src/components/DetailNotices"
);
const { presentConsumption, presentSource } = await import("../src/renderer/src/lib/overview-view");
const {
  LINEAGE_INCOMPLETE_TEXT,
  lineageIncompleteViewOf,
  ownOnlyBranchNoticeOf,
  truncatedChainTitleOf,
} = await import("../src/renderer/src/lib/detail-completeness");
const { deriveOwnConsumption } = await import("@shared/overview");

/**
 * U6（add-partial-run-reading）任务 4.1–4.3：详情完整性在展示层的判据。
 *
 * 对应 delta 场景：
 *   - 「部分普通分支不伪造共享前缀」：固定提示 + 缺失 run ID；不补零、不显示祖先增量、
 *     不把 chain 断点两侧拼成完整轨迹。
 *   - 「部分来源链首项不冒充根」：来源区域明确标为截断链。
 *   - 「完整普通分支保留被编辑字段」：分叉点/被编辑字段标注在 ownOnly 下同样保留。
 *   - 「model_params 臂缺祖先不变成可计算结果」：沿链指标未知，不补零。
 *
 * ⚠️ 本包无 jsdom，且 zustand v5 静态渲染下走 `getServerSnapshot` ⇒ DetailNotices
 *    的 store 块只验纯判据；`SourceSectionView` 是只吃 props 的纯视图，可静态渲染。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function meta(overrides: Record<string, unknown> = {}): RunDetail["meta"] {
  return {
    type: "run.meta",
    id: "r_leaf",
    format_version: 1,
    task: "U6 详情展示夹具",
    model: "controlled-model",
    created_at: T0,
    parent: null,
    fork: null,
    ...overrides,
  } as unknown as RunDetail["meta"];
}

function hop(id: string, parent: string | null, fork: unknown = null) {
  return { meta: meta({ id, parent, fork }), fork };
}

function detailOf(overrides: {
  completeness: "complete" | "ownOnly";
  lineage: RunDetail["lineage"];
  meta?: RunDetail["meta"];
  chain?: ReturnType<typeof hop>[];
}): RunDetail {
  return {
    meta: overrides.meta ?? meta(),
    spans: [],
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    chain: overrides.chain ?? [],
    leafSpanIds: [],
    completeness: overrides.completeness,
    spanScope: overrides.completeness === "ownOnly" ? "own" : "own",
    lineage: overrides.lineage,
  } as unknown as RunDetail;
}

const COMPLETE = detailOf({ completeness: "complete", lineage: { status: "complete" } });
const OWNONLY = detailOf({
  completeness: "ownOnly",
  lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_missing" },
});

describe("U6 4.1：lineageIncompleteViewOf——ownOnly 展示事实的唯一判据", () => {
  it("complete 详情 ⇒ null（不渲染任何不完整提示）", () => {
    expect(lineageIncompleteViewOf(COMPLETE)).toBeNull();
  });

  it("ownOnly ⇒ 固定提示 + 缺失祖先 run ID（措辞不改写）", () => {
    const view = lineageIncompleteViewOf(OWNONLY);
    expect(view).not.toBeNull();
    expect(view?.text).toBe(LINEAGE_INCOMPLETE_TEXT);
    expect(view?.text).toBe("仅显示本运行记录，父链不完整");
    expect(view?.missingRunId).toBe("r_missing");
    expect(view?.missingNote).toContain("r_missing");
  });

  it("ownOnly 首项 parent 非 null ⇒ 链被截断（首项不是根）", () => {
    const truncated = detailOf({
      completeness: "ownOnly",
      lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_root" },
      chain: [hop("r_mid", "r_root"), hop("r_leaf", "r_mid")],
    });
    expect(lineageIncompleteViewOf(truncated)?.chainTruncated).toBe(true);
  });

  it("lineage 与 completeness 错配（ownOnly 却带 complete lineage）⇒ 返回 null 交由 schema 兜底，绝不误判", () => {
    const broken = {
      ...OWNONLY,
      lineage: { status: "complete" },
    } as unknown as RunDetail;
    expect(lineageIncompleteViewOf(broken)).toBeNull();
  });
});

describe("U6 4.2：ownOnlyBranchNoticeOf——分支提示的 ownOnly 分流", () => {
  const resultFork = { at_span: "s_01", edit: { field: "result", value: "改" } };

  it("complete ⇒ null（走既有完整分支文案，本函数不参与）", () => {
    const full = detailOf({
      completeness: "complete",
      lineage: { status: "complete" },
      meta: meta({ parent: "r_p", fork: resultFork }),
    });
    expect(ownOnlyBranchNoticeOf(full)).toBeNull();
  });

  it("ownOnly result 分支：固定提示 + 缺失 ID，且**不出现**「共享前缀」措辞", () => {
    const partial = detailOf({
      completeness: "ownOnly",
      lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_p" },
      meta: meta({ parent: "r_p", fork: resultFork }),
    });
    const text = ownOnlyBranchNoticeOf(partial);
    expect(text).toContain("仅显示本运行记录，父链不完整");
    expect(text).toContain("r_p");
    expect(text).not.toContain("共享前缀");
  });

  it("ownOnly 分支保留分叉点与被编辑字段标注（记录元数据不因祖先缺失消失）", () => {
    const partial = detailOf({
      completeness: "ownOnly",
      lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_p" },
      meta: meta({ parent: "r_p", fork: resultFork }),
    });
    const text = ownOnlyBranchNoticeOf(partial);
    expect(text).toContain("编辑字段：result");
    expect(text).toContain("s_01");
  });

  it("ownOnly 独立分支（system_prompt）同样给固定提示，不称共享前缀", () => {
    const partial = detailOf({
      completeness: "ownOnly",
      lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_root" },
      meta: meta({
        parent: "r_root",
        fork: { at_span: "s_llm1", edit: { field: "system_prompt", value: "改" } },
      }),
    });
    const text = ownOnlyBranchNoticeOf(partial);
    expect(text).toContain("父链不完整");
    expect(text).toContain("system_prompt");
    expect(text).not.toContain("共享前缀");
  });
});

describe("U6 4.2：truncatedChainTitleOf——来源链截断标注", () => {
  it("ownOnly ⇒ 明确标为截断链（首项不是根 run）", () => {
    expect(truncatedChainTitleOf(OWNONLY)).toBe("分叉链（截断：父链不完整，首项不是根 run）");
  });

  it("complete ⇒ null（调用方用既有标题）", () => {
    expect(truncatedChainTitleOf(COMPLETE)).toBeNull();
  });
});

describe("U6 4.1：presentSource——来源区接完整性", () => {
  it("完整 result 分支：维持「共享前缀」关系说明，无缺失说明", () => {
    const section = presentSource({
      meta: meta({
        parent: "r_p",
        fork: { at_span: "s_01", edit: { field: "result", value: "改" } },
      }),
      chain: [hop("r_p", null), hop("r_leaf", "r_p")],
      completeness: "complete",
      lineage: { status: "complete" },
    });
    expect(section.relationNote).toContain("共享前缀");
    expect(section.incompleteNote).toBeNull();
    expect(section.editField).toBe("result");
  });

  it("ownOnly result 分支：关系说明不再声称共享前缀，缺失说明带缺失 run ID", () => {
    const section = presentSource({
      meta: meta({
        parent: "r_p",
        fork: { at_span: "s_01", edit: { field: "result", value: "改" } },
      }),
      chain: [hop("r_leaf", "r_p")],
      completeness: "ownOnly",
      lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_p" },
    });
    // 不再**声称**共享前缀存在（完整分支的原句式）；"未知"的口径可以出现
    expect(section.relationNote).not.toContain("截至分叉点");
    expect(section.relationNote).not.toContain("来自父 run 文件");
    expect(section.relationNote).toContain("父链不完整");
    expect(section.incompleteNote).toContain("仅显示本运行记录");
    expect(section.incompleteNote).toContain("r_p");
    // 被编辑字段照常保留
    expect(section.editField).toBe("result");
  });

  it("ownOnly 独立分支：独立执行措辞保留，缺失说明单独出现", () => {
    const section = presentSource({
      meta: meta({
        parent: "r_root",
        fork: { at_span: "s_llm1", edit: { field: "model_params", value: {} } },
      }),
      chain: [hop("r_leaf", "r_root")],
      completeness: "ownOnly",
      lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_root" },
    });
    expect(section.relation).toBe("independent");
    expect(section.relationNote).toContain("独立执行");
    expect(section.incompleteNote).toContain("r_root");
  });

  it("complete（未传完整性元数据的既有调用方）⇒ 无缺失说明", () => {
    const section = presentSource({
      meta: meta({
        parent: "r_p",
        fork: { at_span: "s_01", edit: { field: "result", value: "改" } },
      }),
      chain: [hop("r_p", null), hop("r_leaf", "r_p")],
    });
    expect(section.incompleteNote).toBeNull();
  });
});

describe("U6 4.1：presentConsumption——ownOnly 追加「沿链指标未知」口径", () => {
  const own = deriveOwnConsumption({ spans: [], leafSpanIds: [] });

  it("complete（缺省）⇒ 口径说明不变", () => {
    const section = presentConsumption(own);
    expect(section.scopeNote).not.toContain("父链不完整");
  });

  it("ownOnly ⇒ 口径说明追加：沿链祖先指标未知，不补零、不推算", () => {
    const section = presentConsumption(own, { lineageIncomplete: true });
    expect(section.scopeNote).toContain("父链不完整");
    expect(section.scopeNote).toContain("不补零");
  });
});

describe("U6 4.1：SourceSectionView 静态渲染——缺失说明进 DOM", () => {
  const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
    renderToStaticMarkup(node);

  it("incompleteNote 非空 ⇒ 渲染缺失说明块（含缺失 run ID）", () => {
    const markup = html(
      createElement(SourceSectionView, {
        section: {
          parentId: "r_p",
          editField: "result",
          editLabel: "工具结果（result）",
          relation: "shared-prefix",
          relationNote: "父链不完整：仅显示本运行记录的自有轨迹。",
          incompleteNote: "仅显示本运行记录，父链不完整（缺失祖先 run：r_p）",
          isolationNote: null,
          canOpenParent: false,
        },
        onOpenParent: () => {},
      }),
    );
    expect(markup).toContain("data-source-incomplete");
    expect(markup).toContain("r_p");
  });

  it("incompleteNote 为 null ⇒ 不渲染缺失说明块", () => {
    const markup = html(
      createElement(SourceSectionView, {
        section: {
          parentId: null,
          editField: null,
          editLabel: null,
          relation: "root",
          relationNote: "这是根运行，没有上游来源记录。",
          incompleteNote: null,
          isolationNote: null,
          canOpenParent: false,
        },
        onOpenParent: () => {},
      }),
    );
    expect(markup).not.toContain("data-source-incomplete");
  });
});

describe("U6 4.11：LineageIncompleteNoticeView 静态渲染——长 ID/警告/复制动作可达", () => {
  const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
    renderToStaticMarkup(node);

  const view = {
    incomplete: true as const,
    text: "仅显示本运行记录，父链不完整",
    missingRunId: "run_a_very_long_missing_identifier_0123456789abcdef",
    missingNote: `缺失的祖先运行：run_a_very_long_missing_identifier_0123456789abcdef`,
    chainTruncated: true,
  };

  it("缺失 ID 以 break-all 呈现（窄窗/200% 下长 ID 换行不断版）", () => {
    const markup = html(createElement(LineageIncompleteNoticeView, { view, onCopy: () => {} }));
    expect(markup).toContain("data-lineage-incomplete");
    expect(markup).toContain("break-all");
    expect(markup).toContain(view.missingRunId);
  });

  it("复制动作是真按钮：带 aria-label（读屏可辨）且文案明确", () => {
    const markup = html(createElement(LineageIncompleteNoticeView, { view, onCopy: () => {} }));
    expect(markup).toContain('aria-label="复制缺失祖先 run ID');
    expect(markup).toContain("复制缺失 run ID");
    expect(markup).toContain('type="button"');
  });

  it("固定提示与口径说明同块呈现（不拆成两条互相矛盾的口径）", () => {
    const markup = html(createElement(LineageIncompleteNoticeView, { view, onCopy: () => {} }));
    expect(markup).toContain("仅显示本运行记录，父链不完整");
    expect(markup).toContain("不补零、不推算");
  });
});
