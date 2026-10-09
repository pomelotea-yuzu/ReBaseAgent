import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunEventLine, SpanLine } from "@rebaseagent/trace-sdk";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// OverviewPanel 的 store 薄壳在 import 时就会触到 `window.api`（../lib/api.ts）
// ⇒ 桩必须先就位；ESM 静态 import 会被提升，故用动态 import（同 run-workspace.test.ts）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { OverviewResultView } = await import("../src/renderer/src/components/OverviewPanel");
const { auditSafeTextRendering, containsMarkupLikeText, openCallHint, presentResult } =
  await import("../src/renderer/src/lib/overview-view");

/**
 * U1（refactor-run-workspace）任务 5.1：概览结果区与安全长文本。
 *
 * 判据来源：desktop-ui delta「运行概览呈现自有结果与消耗」：
 *   - 正常结束直接看到最终输出
 *   - 无最终正文不借用祖先补全
 *   - 模型输出不产生外部副作用
 * 以及 design D4（自有记录派生）、D7（输出先使用 React 安全文本，不引入 Markdown 渲染依赖）。
 *
 * ⚠️ 本包无 jsdom，且 zustand v5 在 `renderToStaticMarkup` 下走 `getServerSnapshot`
 *    （恒为初始值）⇒ 组件测试喂不进 store 状态。故分两层：
 *    ① `presentResult` / `openCallHint` 纯判据直接喂 `deriveOwnOutput` 的结论；
 *    ② `OverviewResultView`（数据 → 视图的纯展示组件）用 `renderToStaticMarkup` 做
 *       **静态结构断言**。真实点击定位、滚动、复制到剪贴板归 7.1/7.3 的 Electron/CDP。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const PANEL_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/OverviewPanel.tsx"),
  "utf8",
);
const LONG_TEXT_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/LongText.tsx"),
  "utf8",
);

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

/** 某 fixture 的 `getRun` 等价输入：文件内 span 全为自有（见 1.1 的数据源陷阱） */
function detailOf(name: string): {
  spans: SpanLine[];
  leafSpanIds: string[];
  status: "completed" | "crashed";
  events: RunEventLine[];
  meta: Record<string, unknown>;
  chain: unknown[];
} {
  const record = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
  return {
    spans: record.spans,
    leafSpanIds: record.spans.map((span) => span.id),
    status: record.status,
    events: record.events,
    // 来源区（5.3）需要 meta/chain：fixture 是单 run 文件，chain 只有自己一跳
    meta: record.meta,
    chain: [{ meta: record.meta, fork: record.meta.fork }],
  };
}

const has = (name: string): boolean => existsSync(resolve(FIXTURE_DIR, `${name}.jsonl`));

/** 从 fixture 现算 `deriveOwnOutput`（与组件内同源，避免测试自造结论） */
async function ownOf(name: string) {
  const { deriveOwnOutput } = await import("@shared/overview");
  const detail = detailOf(name);
  const events = detail.events.filter((event) => event.type === "run.event");
  const last = events[events.length - 1];
  const reason = last === undefined || last.type !== "run.event" ? null : last.reason;
  return deriveOwnOutput({
    spans: detail.spans,
    leafSpanIds: detail.leafSpanIds,
    reason: detail.status === "crashed" ? null : reason,
  });
}

const noop = (): void => {};

/**
 * 造一个「正常结束 + 单次自有 llm.call」的最小详情，正文由参数给定。
 *
 * 用于无法由既有 fixture 表达的场景（长正文、危险内容）——fixture 是**真实引擎产物**
 * 的替身，不该为了几个边界值反复重生成；这里只造结构合法的输入，喂给被测的**展示层**。
 * 是否"结构合法"由 trace-sdk 的 schema 保证（本函数只填必填字段）。
 */
function detailWithContent(content: string): {
  spans: SpanLine[];
  leafSpanIds: string[];
  status: "completed" | "crashed";
  events: RunEventLine[];
  meta: Record<string, unknown>;
  chain: unknown[];
} {
  const meta = {
    id: "synthetic",
    task: "t",
    model: "deepseek-chat",
    created_at: "2026-09-22T00:00:00.000Z",
    parent: null,
    fork: null,
  };
  return {
    status: "completed",
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    spans: [
      { type: "span", id: "s_01", parent: null, kind: "agent.step", n: 1 } as SpanLine,
      {
        type: "span",
        id: "s_02",
        parent: "s_01",
        kind: "llm.call",
        request: { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], tools: [] },
        response: {
          content,
          reasoning_content: null,
          tool_calls: [],
          usage: { in: 10, out: 20 },
          ttft_ms: 100,
        },
      } as SpanLine,
    ],
    leafSpanIds: ["s_01", "s_02"],
    meta,
    chain: [{ meta, fork: null }],
  };
}

// ---------------------------------------------------------------------------
// presentResult：正常结束直接看到最终输出 / 无最终正文不借用祖先补全
// ---------------------------------------------------------------------------

describe("presentResult：正常结束直接看到最终输出", () => {
  it("u1-ok：四条件齐备 ⇒ 结果区给最终输出与可定位调用", async () => {
    if (!has("u1-ok")) return;
    const presentation = presentResult(await ownOf("u1-ok"));

    expect(presentation.kind).toBe("final");
    expect(presentation.title).toBe("最终输出");
    // 有最终输出就不该再有"为什么没有"的说明
    expect(presentation.reason).toBeNull();
    expect(presentation.block).not.toBeNull();
    expect(presentation.block?.content.length).toBeGreaterThan(0);
    // 不要求先选 span：入口是"打开该调用"，位置由派生给出
    expect(presentation.openCallTarget?.spanId).toBe(presentation.block?.spanId);
    expect(presentation.openCallTarget?.stepSpanId).not.toBeNull();
  });

  it("u1-reasoning-only：仅思维链 ⇒ 未记录最终输出，且明说内容类型是思维链", async () => {
    if (!has("u1-reasoning-only")) return;
    const presentation = presentResult(await ownOf("u1-reasoning-only"));

    expect(presentation.kind).toBe("reasoning-only");
    expect(presentation.title).toBe("未记录最终输出");
    expect(presentation.reason).toContain("思维链");
    expect(presentation.block).toBeNull();
  });

  it("u1-tool-only：仅工具调用 ⇒ 未记录最终输出，且明说内容类型是工具调用", async () => {
    if (!has("u1-tool-only")) return;
    const presentation = presentResult(await ownOf("u1-tool-only"));

    expect(presentation.kind).toBe("pending-tool-calls");
    expect(presentation.title).toBe("未记录最终输出");
    expect(presentation.reason).toContain("工具调用");
    // 说明循环本应继续——不是"什么都没有"，而是"还有活没干完"
    expect(presentation.reason).toContain("循环本应继续");
    expect(presentation.block).toBeNull();
  });

  it("u1-error-detail：出错终止 ⇒ 失败前正文只作为**中间输出**，标题不叫结果", async () => {
    if (!has("u1-error-detail")) return;
    const presentation = presentResult(await ownOf("u1-error-detail"));

    expect(presentation.kind).toBe("has-error");
    expect(presentation.title).toBe("未记录最终输出");
    // 中间输出能被看见（不丢内容）……
    expect(presentation.block).not.toBeNull();
    // ……但角色文案必须明确它**不是**本次结果（否则用户会把半截输出当成果）
    expect(presentation.blockLabel).toContain("不是本次最终结果");
    expect(presentation.blockLabel).not.toBe("最终输出");
  });

  it("u1-error-legacy：错误终止但无自有 LLM 错误详情 ⇒ 仍有可展示的中间输出，不虚构", async () => {
    if (!has("u1-error-legacy")) return;
    const presentation = presentResult(await ownOf("u1-error-legacy"));

    // 错误来自**工具**而非 LLM ⇒ 最后自有 llm.call 本身无 error，且有正文
    // ⇒ 上游 missingReason=null、lastOutputKind="content"，展示层归为"非正常终止"。
    // 这正确：正文在，只是它不是"正常结束"的结果。
    expect(presentation.kind).toBe("not-normal-end");
    expect(presentation.block).not.toBeNull();
    expect(presentation.blockLabel).toContain("不是本次最终结果");
  });

  it("u1-aborted：中止（有正文但非正常终止）⇒ 不作为最终结果", async () => {
    if (!has("u1-aborted")) return;
    const presentation = presentResult(await ownOf("u1-aborted"));

    expect(presentation.kind).toBe("not-normal-end");
    expect(presentation.reason).toContain("不是正常结束");
    expect(presentation.block).not.toBeNull();
    expect(presentation.blockLabel).toContain("不是本次最终结果");
  });

  it("u1-crashed：无终止事件 ⇒ 判为非正常终止，绝不冒充正常结束", async () => {
    if (!has("u1-crashed")) return;
    const presentation = presentResult(await ownOf("u1-crashed"));

    expect(presentation.kind).not.toBe("final");
    expect(presentation.title).toBe("未记录最终输出");
  });

  it("u1-fork-child：子 run 零自有 llm.call ⇒ 不借用祖先正文（祖先的输出一个字都不出现）", async () => {
    if (!has("u1-fork-child") || !has("u1-fork-parent")) return;
    const presentation = presentResult(await ownOf("u1-fork-child"));

    expect(presentation.kind).toBe("no-llm-call");
    expect(presentation.block).toBeNull();
    expect(presentation.openCallTarget).toBeNull();
    expect(presentation.reason).toContain("没有记录任何自有模型调用");

    // 反例纪律：把祖先的正文拿来比，证明它确实**没有**出现在本次结果里
    const parent = detailOf("u1-fork-parent");
    const parentText = parent.spans
      .filter((span) => span.kind === "llm.call")
      .map((span) => span.response.content ?? "")
      .filter((text) => text.length > 0);
    expect(parentText.length).toBeGreaterThan(0);
    // 派生结论里根本没有可展示内容，故祖先正文无从泄漏
    expect(presentation.block).toBeNull();
  });

  it("openCallHint：仅有思维链/工具调用时给出「打开调用看内容」的说明，有正文时为 null", async () => {
    if (!has("u1-reasoning-only") || !has("u1-tool-only") || !has("u1-ok")) return;

    const reasoning = await ownOf("u1-reasoning-only");
    expect(openCallHint(reasoning, presentResult(reasoning))).toContain("思维链");

    const toolOnly = await ownOf("u1-tool-only");
    expect(openCallHint(toolOnly, presentResult(toolOnly))).toContain("工具调用");

    const ok = await ownOf("u1-ok");
    expect(openCallHint(ok, presentResult(ok))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 组件静态渲染：不要求先选 span / 中间输出角色标注 / 未记录时不留白
// ---------------------------------------------------------------------------

function render(name: string, expanded?: string[]): string {
  const detail = detailOf(name);
  return html(
    createElement(OverviewResultView, {
      detail,
      expanded,
      onToggleExpanded: noop,
      onOpenCall: noop,
      onOpenParent: noop,
    }),
  );
}

describe("OverviewResultView：结果区静态结构", () => {
  it("u1-ok：标题即「最终输出」，正文原文出现在结果区，且给出定位入口", async () => {
    if (!has("u1-ok")) return;
    const markup = render("u1-ok");
    const own = await ownOf("u1-ok");

    expect(markup).toContain("最终输出");
    // 「不要求先选 span」：正文直接在概览里，不需要用户去左栏选
    const text = own.finalOutput?.content ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(markup).toContain(text);
    expect(markup).toContain("打开该调用并展开所属 step");
    // 不声称修复或测试通过
    expect(markup).not.toContain("测试通过");
    expect(markup).not.toContain("修复成功");
  });

  it("u1-error-detail：显示「未记录最终输出」，且中间输出的角色文案带「不是本次最终结果」", () => {
    if (!has("u1-error-detail")) return;
    const markup = render("u1-error-detail");

    expect(markup).toContain("未记录最终输出");
    expect(markup).toContain("不是本次最终结果");
    expect(markup).toContain("复制原文");
  });

  it("u1-reasoning-only：不留白——给出具体原因而不是空的「（无输出）」", () => {
    if (!has("u1-reasoning-only")) return;
    const markup = render("u1-reasoning-only");

    expect(markup).toContain("未记录最终输出");
    expect(markup).toContain("思维链");
    // 不出现含糊的占位
    expect(markup).not.toContain("（无输出）");
  });

  it("u1-fork-child：子 run 无自有输出时不显示任何正文块（祖先正文不被借用）", async () => {
    if (!has("u1-fork-child") || !has("u1-fork-parent")) return;
    const markup = render("u1-fork-child");
    const parent = detailOf("u1-fork-parent");
    const parentTexts = parent.spans
      .filter((span) => span.kind === "llm.call")
      .map((span) => span.response.content ?? "")
      .filter((text) => text.length > 0);

    for (const text of parentTexts) {
      expect(markup).not.toContain(text);
    }
    expect(markup).toContain("没有记录任何自有模型调用");
  });

  it("长正文（>600 字符）折叠为摘要行、展开后为完整原文；开合由受控状态驱动", () => {
    // u1-ok 的正文只有 37 字符（不触发折叠）⇒ 折叠行为需另造长正文用例。
    // 这条同时钉住 delta「复制 SHALL 对应原始文本而非省略后的展示」的前提：
    // 折叠只影响展示，正文原值始终在 DOM 里（`<details>` 折叠不等于丢弃内容）。
    const long = "第 1 段：".repeat(120); // 远超 COLLAPSE_THRESHOLD(600)
    const detail = detailWithContent(long);

    const collapsed = html(
      createElement(OverviewResultView, {
        detail,
        expanded: [],
        onToggleExpanded: noop,
        onOpenCall: noop,
        onOpenParent: noop,
      }),
    );
    const expanded = html(
      createElement(OverviewResultView, {
        detail,
        expanded: ["overview-result"],
        onToggleExpanded: noop,
        onOpenCall: noop,
        onOpenParent: noop,
      }),
    );

    // 折叠态：有 <details> 且**没有** open 属性
    expect(collapsed).toContain("<details");
    expect(collapsed).not.toMatch(/<details[^>]*\sopen/);
    // 展开态：同一个 <details> 带 open
    expect(expanded).toMatch(/<details[^>]*\sopen/);
    // 摘要行带真实字符数（用户据此判断"展开的是多大一块"）
    expect(collapsed).toContain(`${long.length} 字符`);
    // 完整原文始终在（折叠不丢内容）
    expect(collapsed).toContain(long.slice(0, 80));
  });
});

// ---------------------------------------------------------------------------
// 安全呈现（delta「模型输出不产生外部副作用」）
// ---------------------------------------------------------------------------

describe("安全呈现：模型输出只作为文本，不产生外部副作用", () => {
  it("渲染方式契约：概览与 LongText 都不解析标记、不加载远程图片、不执行脚本", () => {
    // 这是**禁用型**要求——"不做什么"很难被正面用例发现，回归时又极易被无意识加回来
    // （例如为了"更好看"引入 Markdown 渲染器）。故对源码做断言。
    expect(auditSafeTextRendering(PANEL_SOURCE)).toEqual([]);
    expect(auditSafeTextRendering(LONG_TEXT_SOURCE)).toEqual([]);
  });

  it("判据有牙：审计能抓到三类危险写法（证明它真会红，不是恒绿装饰）", () => {
    const parsed = auditSafeTextRendering("<div dangerouslySetInnerHTML={{ __html: t }} />");
    expect(parsed.map((issue) => issue.kind)).toContain("parsed-markup");

    const img = auditSafeTextRendering('<img src={url} alt="out" />');
    expect(img.map((issue) => issue.kind)).toContain("auto-loaded-image");

    const script = auditSafeTextRendering("const x = <iframe src={url} />;");
    expect(script.map((issue) => issue.kind)).toContain("executed-script");
  });

  it("含脚本/HTML/远程图片/宿主路径的正文被当**纯文本**渲染（字面量转义，不是元素）", () => {
    const hostile =
      '<script>alert(1)</script><img src="https://evil.example/x.png">C:\\Users\\me\\secret.txt';
    const markup = html(
      createElement(OverviewResultView, {
        detail: detailWithContent(hostile),
        expanded: ["overview-result"],
        onToggleExpanded: noop,
        onOpenCall: noop,
        onOpenParent: noop,
      }),
    );

    // 危险内容**原样可见**（用户要能读到模型到底输出了什么）……
    expect(markup).toContain("&lt;script&gt;");
    // ……但不是以可执行元素形态存在
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    // 远程图片地址只作为文本出现，不构成 img 的 src 属性
    expect(markup).toContain("evil.example");
    expect(markup).not.toMatch(/src="https:\/\/evil\.example/);
    // 宿主路径不获得任何额外能力，只是文本
    expect(containsMarkupLikeText(hostile)).toBe(true);
  });

  it("containsMarkupLikeText：普通正文不误报（否则提示会变成噪音）", () => {
    expect(containsMarkupLikeText("任务完成：README.md 的要点已写入 summary.md，共 2 条。")).toBe(
      false,
    );
    expect(containsMarkupLikeText("1 < 2 且 a > b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 接线契约（源码级）
// ---------------------------------------------------------------------------

/**
 * ⚠️ 为什么需要这一节：本包无 jsdom，App 的外壳（页签 → 正文）打不到真实渲染，
 *    于是"概览页是不是**真的**挂上了 `OverviewPanel`"在变异验证里**首轮漏网**——
 *    把 `visible === "overview" ? <OverviewPanel/> : <DetailPanel/>` 改成两边都
 *    `<DetailPanel/>`（即概览页退回成"详情列的别名"，正是本任务要消灭的旧形态），
 *    **全量 728 条用例无一变红**。上面所有用例都在测组件本身，没人测"它被挂在哪"。
 *
 *    按 4.2/4.4/4.5 已验证过的做法，用**源码级接线契约**钉住：
 *    能抓"改回旧形态"，抓不到"接线对而行为错"——后者归 7.1/7.3 的 Electron/CDP。
 */
describe("接线契约：概览页确实挂到工作区概览页签上", () => {
  const APP_SOURCE = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/App.tsx"),
    "utf8",
  );

  it("App 在 overview 页签上挂 OverviewPanel，而不是退回 DetailPanel", () => {
    expect(APP_SOURCE).toContain("OverviewPanel");
    // 关键断言：概览分支必须出现 OverviewPanel（只在 import 里出现不算接线）
    expect(APP_SOURCE).toMatch(/visible\s*===\s*"overview"\s*\?\s*\(\s*<OverviewPanel\s*\/>/);
    // 反向：概览分支不得退回 DetailPanel（旧形态 = "概览沦为详情列别名"）
    expect(APP_SOURCE).not.toMatch(/visible\s*===\s*"overview"\s*\?\s*\(\s*<DetailPanel\s*\/>/);
  });

  it("三支链结构完整：概览→OverviewPanel、文件→WorkspaceFilesPanel、其余→DetailPanel", () => {
    // 6.1 把二选一扩成三支（文件页独立承载）。若链被改坏（如删掉 files 支、
    // 或把某支错指到别的组件），组件级测试打不到 ⇒ 此处按**分支 → 组件**逐一钉住。
    // ⚠️ UI 密度 2.4 起文件页/步骤页挂载带 focus props ⇒ 只钉"分支起点是哪个组件"，
    // 不再钉自闭合裸写法（`\s*\/>` 会把带 props 的挂载误判成链断了）。
    expect(APP_SOURCE).toMatch(/visible\s*===\s*"files"\s*\?\s*\(\s*<WorkspaceFilesPanel\b/);
    // 文件页**不得**退回 DetailPanel（那正是"工作区文件页签点不动"的旧缺陷根因）
    expect(APP_SOURCE).not.toMatch(/visible\s*===\s*"files"\s*\?\s*\(\s*<DetailPanel\b/);
    // 兜底支仍是 DetailPanel（步骤页），且它是链上最后一个组件
    expect(APP_SOURCE).toMatch(/\)\s*:\s*\(\s*<DetailPanel\b/);
  });

  it("App 用 resolveVisibleTab 判定可见页签（不自己再写一份回退规则）", () => {
    // 页签回退的唯一来源是 RunWorkspace 的 resolveVisibleTab；
    // 若 App 另抄一份判据，两者会在"非隔离 run 保存了 files"时分叉。
    expect(APP_SOURCE).toContain("resolveVisibleTab");
  });

  it("OverviewPanel 的 store 薄壳读的是当前 run 的阅读状态与详情（不读别的 run）", () => {
    expect(PANEL_SOURCE).toContain("s.selectedRunId");
    expect(PANEL_SOURCE).toContain("s.detail");
    expect(PANEL_SOURCE).toContain("s.readingOf");
  });

  it("定位动作三件事都走既有 store 方法（不新开通道）", () => {
    // 「打开该调用并展开所属 step」= 选中 span + 展开 step + 切到步骤页
    expect(PANEL_SOURCE).toContain("selectSpan");
    expect(PANEL_SOURCE).toContain("toggleStep");
    expect(PANEL_SOURCE).toContain("setReadingTab");
  });

  it("概览正文块的展开状态进会话阅读状态（切运行再返回要恢复）", () => {
    expect(PANEL_SOURCE).toContain("setCallReading");
    // 受控展开：LongText 的 expanded 由 store 派生值驱动
    expect(PANEL_SOURCE).toContain("isLongTextExpanded");
    expect(PANEL_SOURCE).toContain("toggleLongTextExpanded");
  });
});
