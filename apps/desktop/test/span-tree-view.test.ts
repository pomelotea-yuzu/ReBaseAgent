import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { buildSpanTree } from "@shared/derive";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// SpanTree 的 store 薄壳在 import 时就会触到 `window.api`（../lib/api.ts）
// ⇒ 桩必须先就位；ESM 静态 import 会被提升，故用动态 import（同 5.1/5.2/5.3 的 test 文件）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { SpanRow } = await import("../src/renderer/src/components/SpanTree");
const { flattenSpanRows, rowErrorKind, spanRowLabel, stepLabel, stepsEmptyCause } = await import(
  "../src/renderer/src/lib/span-tree-view"
);

/**
 * U1（refactor-run-workspace）任务 5.4：SpanTree 阅读承载、展开/选择分离和自有/继承标记。
 *
 * 判据来源：desktop-ui delta「轨迹以 span 树呈现」五场景：
 *   - 三步运行的树结构（3 个 agent.step，各自子节点顺序与文件一致）
 *   - 工具报错（tool.invoke.error 非空但 run 正常 completed：错误是数据不是异常）
 *   - 展开与调用选择互不干扰（展开不动选中、选中不折叠目录；两类错误各自标记）
 *   - 首次步骤选择与空轨迹（有祖先前缀选首个自有调用；空轨迹显示空态不伪造步骤）
 *   - 继承轨迹与独立执行来源（继承段与自有段可辨，本地轮号不沿链累加）
 * 以及 design D1（步骤页 = 可收起目录 + 完整调用详情；文件模式不挂 SpanTree）。
 *
 * ⚠️ 本包无 jsdom（zustand v5 + renderToStaticMarkup 喂不进 store 状态）⇒ 分三层：
 *    ① 纯判据（`flattenSpanRows` / `rowErrorKind` / `stepsEmptyCause` / `stepLabel`）；
 *    ② 纯展示组件 `SpanRow` 用 `renderToStaticMarkup` 做静态结构断言；
 *    ③ 外壳接线（App 只在步骤页挂目录）用**源码级契约**钉住。
 *    真实点击展开/选中后的详情替换归 7.1/7.3 的 Electron/CDP。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../.rebaseagent/u1-fixtures");
const APP_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/App.tsx"),
  "utf8",
);
const SPANTREE_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/SpanTree.tsx"),
  "utf8",
);

const has = (name: string): boolean => existsSync(resolve(FIXTURE_DIR, `${name}.jsonl`));

function spansOf(name: string): SpanLine[] {
  return readRun(resolve(FIXTURE_DIR, `${name}.jsonl`)).spans;
}

/** 造一个 step（父为空）= 树根 */
function step(id: string, n: number): SpanLine {
  return { type: "span", kind: "agent.step", id, parent: null, n } as SpanLine;
}

/** 造一个自有 llm.call */
function llm(id: string, parent: string, error?: { message: string }): SpanLine {
  return {
    type: "span",
    kind: "llm.call",
    id,
    parent,
    request: { model: "m", messages: [] },
    response: {
      content: "x",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 1, out: 1 },
      ttft_ms: 1,
    },
    ...(error === undefined ? {} : { error }),
  } as SpanLine;
}

/** 造一个 tool.invoke（error 为 null 表示成功） */
function tool(id: string, parent: string, name: string, error: string | null = null): SpanLine {
  return {
    type: "span",
    kind: "tool.invoke",
    id,
    parent,
    tool: name,
    args: {},
    result: null,
    error,
    dur_ms: 1,
  } as SpanLine;
}

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);
const noop = (): void => {};

// ---------------------------------------------------------------------------
// 场景「三步运行的树结构」：按 parent 建树，顺序与文件一致
// ---------------------------------------------------------------------------

describe("flattenSpanRows：三步运行的树结构", () => {
  it("u1-ok：3 个 agent.step 各自展开后为其下 llm.call / tool.invoke 子节点", () => {
    if (!has("u1-ok")) return;
    const rows = flattenSpanRows(buildSpanTree(spansOf("u1-ok")));

    // 根层就是 3 个 step（第 1/2/3 轮），depth 0
    const roots = rows.filter((r) => r.depth === 0);
    expect(roots.map((r) => r.kind)).toEqual(["agent.step", "agent.step", "agent.step"]);
    expect(roots.map((r) => r.label)).toEqual(["第 1 轮", "第 2 轮", "第 3 轮"]);

    // 每个 step 的子节点 depth=1，顺序与文件一致（先 llm 后 tool）
    const step1Children = rows.filter((r) => r.depth === 1).slice(0, 2);
    expect(step1Children.map((r) => r.kind)).toEqual(["llm.call", "tool.invoke"]);
  });

  it("缩进层级逐层递增（depth 不是恒为 0 —— 否则树会被拍平成一列）", () => {
    if (!has("u1-ok")) return;
    const rows = flattenSpanRows(buildSpanTree(spansOf("u1-ok")));
    const depths = new Set(rows.map((r) => r.depth));
    // 至少两层（step=0 / 其下调用=1）；若恒为 0，树结构在界面上就不成立
    expect(depths.has(0)).toBe(true);
    expect(depths.has(1)).toBe(true);
    expect(Math.max(...rows.map((r) => r.depth))).toBeGreaterThanOrEqual(1);
  });

  it("只把 agent.step 视为可展开节点（其下有子时才出现展开控件）", () => {
    const spans = [step("s1", 1), llm("s2", "s1"), tool("s3", "s1", "read_file")];
    const rows = flattenSpanRows(buildSpanTree(spans));
    const stepRow = rows.find((r) => r.kind === "agent.step");
    const llmRow = rows.find((r) => r.kind === "llm.call");
    expect(stepRow?.expandable).toBe(true);
    expect(llmRow?.expandable).toBe(false); // 调用不是层级的可展开节点
  });

  it("折叠某 step 只影响其子节点是否下钻，不影响选中通道", () => {
    const spans = [step("s1", 1), llm("s2", "s1"), tool("s3", "s1", "read_file")];
    const tree = buildSpanTree(spans);
    const all = flattenSpanRows(tree);
    const collapsed = flattenSpanRows(tree, { expandedOf: (id) => id !== "s1" });
    expect(all.map((r) => r.spanId)).toEqual(["s1", "s2", "s3"]);
    expect(collapsed.map((r) => r.spanId)).toEqual(["s1"]); // 只留被折叠的 step 自身
  });
});

// ---------------------------------------------------------------------------
// 场景「工具报错」+「展开与调用选择互不干扰」：两类错误各自标记、不合并
// ---------------------------------------------------------------------------

describe("rowErrorKind：两类错误按各自字段标记（不合并）", () => {
  it("tool.invoke.error 非 null ⇒ tool；error 为 null（成功）⇒ 无错", () => {
    expect(rowErrorKind(tool("t1", "s", "read_file", "ENOENT: 打不开"))).toBe("tool");
    expect(rowErrorKind(tool("t2", "s", "read_file", null))).toBe(null);
  });

  it("llm.call.error 存在 ⇒ llm；未记录（undefined）⇒ 无错（undefined ≠ null，不互相顶替）", () => {
    expect(rowErrorKind(llm("l1", "s", { message: "HTTP 500" }))).toBe("llm");
    expect(rowErrorKind(llm("l2", "s"))).toBe(null);
  });

  it("agent.step 不携带调用级错误字段 ⇒ 恒为 null（步骤行不冒充调用错误）", () => {
    expect(rowErrorKind(step("s1", 1))).toBe(null);
  });

  it("u1-error-legacy 的失败工具在树里被判为 tool 错误（判据对着真实 fixture）", () => {
    if (!has("u1-error-legacy")) return;
    const spans = spansOf("u1-error-legacy");
    const failed = spans.find((s) => s.kind === "tool.invoke");
    expect(failed).toBeDefined();
    expect(rowErrorKind(failed as SpanLine)).toBe("tool");
  });
});

describe("SpanRowView 静态渲染：展开与选择是两条独立通道", () => {
  const row = {
    spanId: "s2",
    kind: "llm.call" as const,
    depth: 1,
    label: "LLM 调用",
    own: true,
    orphan: false,
    errorKind: null as const,
    expandable: false,
  };

  it("可展开行同时渲染**展开按钮**与**选择按钮**（两个独立 button，不是嵌套的一个）", () => {
    const markup = html(
      createElement(SpanRow, {
        row: { ...row, kind: "agent.step" as const, label: "第 1 轮", expandable: true },
        selected: false,
        expanded: true,
        onSelect: noop,
        onToggleExpand: noop,
        durationMs: null,
        tokens: 0,
      }),
    );
    expect(markup).toContain("折叠该步骤"); // 展开态下展开按钮的 aria-label
    expect(markup).toContain("aria-expanded");
    // 选择按钮的选中态用 aria-current（未选中时不写）
    expect(markup.match(/<button/g)?.length).toBe(2);
  });

  it("展开态切换只改 aria-expanded 与箭头文字，不改变选中态标记（两条通道互不驱动）", () => {
    const base = {
      row: { ...row, kind: "agent.step" as const, label: "第 1 轮", expandable: true },
      onSelect: noop,
      onToggleExpand: noop,
      durationMs: null,
      tokens: 0,
    };
    const open = html(createElement(SpanRow, { ...base, selected: false, expanded: true }));
    const shut = html(createElement(SpanRow, { ...base, selected: false, expanded: false }));
    // 展开态差异只在 aria-expanded / 箭头
    expect(open).toContain('aria-expanded="true"');
    expect(shut).toContain('aria-expanded="false"');
    // 两者都**没有**选中标记——展开动作本身不给选择加任何东西
    expect(open).not.toContain('aria-current="true"');
    expect(shut).not.toContain('aria-current="true"');
  });

  it("选中态由 selected 独立驱动，且不因不可展开而缺失（选中不需要展开权限）", () => {
    const markup = html(
      createElement(SpanRow, {
        row,
        selected: true,
        expanded: true,
        onSelect: noop,
        onToggleExpand: noop,
        durationMs: null,
        tokens: 0,
      }),
    );
    expect(markup).toContain('aria-current="true"');
  });

  it("不可展开行不渲染展开控件，但保留等宽占位（缩进对齐不塌）", () => {
    const markup = html(
      createElement(SpanRow, {
        row,
        selected: false,
        expanded: true,
        onSelect: noop,
        onToggleExpand: noop,
        durationMs: null,
        tokens: 0,
      }),
    );
    expect(markup).not.toContain("aria-expanded");
    expect(markup.match(/<button/g)?.length).toBe(1); // 只有选择按钮
  });

  it("工具错误行标「工具错误」；LLM 错误行标「LLM 错误」（两个文案不通用）", () => {
    const toolErr = html(
      createElement(SpanRow, {
        row: {
          ...row,
          kind: "tool.invoke" as const,
          label: "read_file",
          errorKind: "tool" as const,
        },
        selected: false,
        expanded: true,
        onSelect: noop,
        onToggleExpand: noop,
        durationMs: 1,
        tokens: 0,
      }),
    );
    const llmErr = html(
      createElement(SpanRow, {
        row: { ...row, errorKind: "llm" as const },
        selected: false,
        expanded: true,
        onSelect: noop,
        onToggleExpand: noop,
        durationMs: 1,
        tokens: 0,
      }),
    );
    expect(toolErr).toContain("工具错误");
    expect(toolErr).not.toContain("LLM 错误");
    expect(llmErr).toContain("LLM 错误");
    expect(llmErr).not.toContain("工具错误");
  });
});

// ---------------------------------------------------------------------------
// 场景「继承轨迹与独立执行来源」：自有/继承可辨 + 轮号不沿链累加
// ---------------------------------------------------------------------------

describe("flattenSpanRows：自有与继承可辨，轮号不累加", () => {
  it("不在 leafSpanIds 里的 span 标 own=false（继承），在内的标 own=true", () => {
    const spans = [step("s1", 1), llm("s2", "s1"), step("s9", 2), tool("s10", "s9", "read_file")];
    // 自有段只有 s9/s10（模拟 result 分叉：父前缀 s1/s2 是继承来的）
    const owned = new Set(["s9", "s10"]);
    const rows = flattenSpanRows(buildSpanTree(spans), { ownIds: owned });
    const byId = new Map(rows.map((r) => [r.spanId, r]));
    expect(byId.get("s1")?.own).toBe(false);
    expect(byId.get("s2")?.own).toBe(false);
    expect(byId.get("s9")?.own).toBe(true);
    expect(byId.get("s10")?.own).toBe(true);
  });

  it("u1-fork-child 的自有段（s_09/s_10）与父前缀可辨（对着真实 fixture 的边界）", () => {
    if (!has("u1-fork-child") || !has("u1-fork-parent")) return;
    const child = readRun(resolve(FIXTURE_DIR, "u1-fork-child.jsonl"));
    const parent = readRun(resolve(FIXTURE_DIR, "u1-fork-parent.jsonl"));
    // 合并轨迹 = 父前缀 + 子自有段（与 resolveBranch 同形态）
    const merged = [...parent.spans, ...child.spans];
    const own = new Set(child.spans.map((s) => s.id));
    const rows = flattenSpanRows(buildSpanTree(merged), { ownIds: own });
    const byId = new Map(rows.map((r) => [r.spanId, r]));

    for (const span of parent.spans) expect(byId.get(span.id)?.own, span.id).toBe(false);
    for (const span of child.spans) expect(byId.get(span.id)?.own, span.id).toBe(true);
  });

  it("stepLabel 用记录原值，不沿链累加（合并轨迹里 [1,2,3,1,1] 照抄）", () => {
    // 子 run 的 agent.step.n 是它自己的本地轮号：父段 1/2/3 + 子段回到 1
    expect(stepLabel(1)).toBe("第 1 轮");
    expect(stepLabel(3)).toBe("第 3 轮");
    // 若"沿链累计"，子的第 1 轮会被算成第 4 轮——这里恒等于记录值
    const spans = [step("a", 1), step("b", 2), step("c", 3), step("d", 1)];
    const labels = flattenSpanRows(buildSpanTree(spans)).map((r) => r.label);
    expect(labels).toEqual(["第 1 轮", "第 2 轮", "第 3 轮", "第 1 轮"]);
  });

  it("ownIds 缺省时视为全部自有（不擅自把没边界信息的轨迹全判成继承）", () => {
    const spans = [step("s1", 1), llm("s2", "s1")];
    const rows = flattenSpanRows(buildSpanTree(spans));
    expect(rows.every((r) => r.own)).toBe(true);
  });

  it("继承行渲染「继承」文字标记（不只靠颜色，且不冒充自有）", () => {
    const markup = html(
      createElement(SpanRow, {
        row: {
          spanId: "s1",
          kind: "agent.step" as const,
          depth: 0,
          label: "第 1 轮",
          own: false,
          orphan: false,
          errorKind: null,
          expandable: false,
        },
        selected: false,
        expanded: true,
        onSelect: noop,
        onToggleExpand: noop,
        durationMs: null,
        tokens: 0,
      }),
    );
    expect(markup).toContain("继承");
  });

  it("自有行不渲染「继承」标记（不误标）", () => {
    const markup = html(
      createElement(SpanRow, {
        row: {
          spanId: "s9",
          kind: "agent.step" as const,
          depth: 0,
          label: "第 2 轮",
          own: true,
          orphan: false,
          errorKind: null,
          expandable: false,
        },
        selected: false,
        expanded: true,
        onSelect: noop,
        onToggleExpand: noop,
        durationMs: null,
        tokens: 0,
      }),
    );
    expect(markup).not.toContain("继承");
  });

  it("spanRowLabel：step 用本地轮号、llm 固定文案、tool 用工具名", () => {
    expect(spanRowLabel(step("s1", 2))).toBe("第 2 轮");
    expect(spanRowLabel(llm("s2", "s1"))).toBe("LLM 调用");
    expect(spanRowLabel(tool("s3", "s1", "read_file"))).toBe("read_file");
  });
});

// ---------------------------------------------------------------------------
// 场景「首次步骤选择与空轨迹」：空态成因分流
// ---------------------------------------------------------------------------

describe("stepsEmptyCause：空轨迹与无自有调用是两回事", () => {
  it("spanCount 为 0 ⇒ no-spans（不伪造步骤）", () => {
    expect(stepsEmptyCause({ spanCount: 0, ownCallCount: 0 })).toBe("no-spans");
  });

  it("有 span 但无自有调用 ⇒ no-own-calls（继承段仍可见，不说成空态）", () => {
    expect(stepsEmptyCause({ spanCount: 5, ownCallCount: 0 })).toBe("no-own-calls");
  });

  it("有自有调用 ⇒ none（正常）", () => {
    expect(stepsEmptyCause({ spanCount: 5, ownCallCount: 2 })).toBe("none");
  });

  it("空轨迹的判定优先于「无自有调用」：两者都是 0 时才归 no-spans", () => {
    // 若先判 ownCallCount，空轨迹会被误报成"有内容但没自有调用"——那是两回事
    expect(stepsEmptyCause({ spanCount: 0, ownCallCount: 0 })).toBe("no-spans");
  });
});

// ---------------------------------------------------------------------------
// 外壳接线（源码级契约）：目录只在步骤页承载
// ---------------------------------------------------------------------------

describe("接线契约：步骤目录只在步骤页挂载，收起后正文有重开入口", () => {
  it('App 用 `tab === "steps"` 门控 SpanTree 的挂载（概览/文件页不挂目录）', () => {
    expect(APP_SOURCE).toContain('tab === "steps" && layout.stepsVisible');
    expect(APP_SOURCE).toContain("<SpanTree");
  });

  it("重开入口的接线：仅当步骤页且目录不可见时给出回调，且走**临时打开**（不写偏好）", () => {
    // 判据是**接线表达式**而不是某句文案——文案改了入口仍在，改文案不该算回归；
    // 但「无条件给入口」或「走写偏好的开关」必须被抓住。
    expect(APP_SOURCE).toContain("onOpenSteps");
    expect(APP_SOURCE).toContain('tab === "steps" && !layout.stepsVisible');
    expect(APP_SOURCE).toContain("layout.setStepsOpened(true)");
    // 入口不得走写偏好的那一个（D2：临时打开 ≠ 用户偏好）
    expect(APP_SOURCE).not.toContain("onOpenSteps={() => layout.toggleStepsCollapsed");
  });

  it("StepsDirectoryEntry 渲染成真实可点的 button（不是说明文字）", async () => {
    const { StepsDirectoryEntry } = await import("../src/renderer/src/App");
    let clicked = 0;
    const markup = html(
      createElement(StepsDirectoryEntry, {
        onOpen: () => {
          clicked += 1;
        },
      }),
    );
    expect(markup).toContain("<button");
    expect(markup).toContain("重新打开步骤目录");
    // renderToStaticMarkup 不触发事件，这里只证明它是 button（静态渲染不点击）
    expect(clicked).toBe(0);
  });

  it("SpanTree 不再自带「重新打开目录」入口（避免与正文入口重复）", () => {
    // 判据是**没有那个入口 prop 与自渲染按钮**，而不是"文件里不许出现这几个字"
    // （收起按钮的 title 里提到正文入口是合理文案，不算重复入口）
    expect(SPANTREE_SOURCE).not.toContain("onOpenDirectory");
    expect(SPANTREE_SOURCE).not.toContain("onOpenSteps");
  });

  it("收起控件走外壳传入的 onToggleCollapsed（宽度/收起规则不散在组件里）", () => {
    expect(SPANTREE_SOURCE).toContain("onToggleCollapsed");
  });
});
