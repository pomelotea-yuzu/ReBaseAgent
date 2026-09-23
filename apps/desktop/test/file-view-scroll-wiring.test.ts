import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * U2 任务 5.3 实机验收暴露的**接线缺口**回归（四个，全部属"纯逻辑写好但没接上 UI"这一类）。
 *
 * 背景：5.3 的四场景里有两处的 WHEN 在界面上**根本不可达**，另有 4.3 的"保存/恢复滚动位置"
 * 只做了一半。这些都不是算错，而是**没接线** —— 静态纯逻辑单测全绿也照不出来，所以本文件
 * 同时钉**能力断言**（渲染出来没有）与**接线契约**（源码里到底连没连）。
 *
 * 对应 delta：
 * -「文件页签往返恢复阅读」：恢复「列表/正文位置」且"组件卸载不使其回到初始状态"
 * -「显式文件定位覆盖历史」：`WHEN 用户从当前运行的自有步骤打开该轮文件` ⇒ 需要真实入口
 * -「…并解除阻挡它的搜索筛选」（有 path 的显式目标须清搜索并切 all）
 */

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, `../src/renderer/src/${rel}`), "utf8");

(globalThis as Record<string, unknown>).window = { api: {} };

const { StepDetailView } = await import("../src/renderer/src/components/DetailPanel");

const VIEW = {
  iteration: 2,
  calls: [],
  errorCount: 0,
  tokensIn: 0,
  tokensOut: 0,
  durationMs: null,
  toolCalls: 0,
} as const;

describe("U2 5.3 缺口③：步骤页真的有「打开该轮文件」入口（能力断言）", () => {
  it("给出回调 ⇒ 渲染入口按钮", () => {
    const html = renderToStaticMarkup(
      createElement(StepDetailView, {
        view: VIEW,
        onOpenCall: () => {},
        onOpenStepFiles: () => {},
      }),
    );
    expect(html).toContain("打开该轮文件");
  });

  it("不给回调（祖先步骤 / 非自有完成步骤）⇒ **不渲染**入口，不冒充检查点", () => {
    const html = renderToStaticMarkup(
      createElement(StepDetailView, { view: VIEW, onOpenCall: () => {} }),
    );
    expect(html).not.toContain("打开该轮文件");
  });
});

describe("U2 5.3 缺口③接线：入口真的接到 store.openFileAt（源码级）", () => {
  const SRC = read("components/DetailPanel.tsx");

  it("面板取到 openFileAt 并在步骤详情上挂入口", () => {
    expect(SRC).toContain("const openFileAt = useAppStore((s) => s.openFileAt)");
    expect(SRC).toContain("onOpenStepFiles={openStepFiles ?? undefined}");
  });

  it("调用的是 openFileAt(runId, { stepSpanId })，run id 取自当前详情本身", () => {
    expect(SRC).toContain("return () => openFileAt(runId, { stepSpanId });");
    expect(SRC).toContain("const runId = detail.meta.id;");
  });

  it('入口以 validateCheckpointStepId(...) === "valid" 为门（与选择器同源，祖先不给入口）', () => {
    expect(SRC).toContain(
      'if (validateCheckpointStepId(detail, span.id) !== "valid") return null;',
    );
  });
});

describe("U2 5.3 缺口①②：滚动位置真的会被**恢复**，不只是保存（源码级）", () => {
  const SRC = read("components/WorkspaceFileView.tsx");

  it("正文锚点：连接层下传 contentScroll 并写回 contentScroll", () => {
    expect(SRC).toContain("contentAnchor={saved.contentScroll}");
    expect(SRC).toContain("{ contentScroll }");
  });

  it("正文锚点：在编辑器 mount 时按 (step, path) 匹配后恢复，并订阅滚动上报", () => {
    expect(SRC).toContain("anchorMatches(contentAnchor, stepSpanId, path)");
    expect(SRC).toContain("resolveAnchorScrollTop(contentAnchor, {");
    expect(SRC).toContain("modified.setScrollTop(top)");
    expect(SRC).toContain("modified.onDidScrollChange(() => reportAnchor(modified))");
  });

  it("正文锚点：上报走 buildContentAnchor（记行号 + 偏移，不记裸像素）", () => {
    expect(SRC).toContain("buildContentAnchor({");
    expect(SRC).toContain("sameAnchor(anchor, lastAnchorRef.current)");
  });

  it("列表：不只是写 store，还要**读回**（旧的只写不读形态必须消失）", () => {
    expect(SRC).toContain("ref={listScrollRef}");
    expect(SRC).toContain("resolveScrollRestore(listScrollTop, {");
    expect(SRC).toContain("el.scrollTop = top;");
    expect(SRC).toContain("decideRestore({");
    // 旧形态：行内 lambda 只上报（onScroll 只出不进）
    expect(SRC).not.toContain("(e) => onListScrollTop(e.currentTarget.scrollTop)");
  });

  it("列表：身份含检查点——换检查点后位置重新恢复，但不跨检查点复用一个偏移", () => {
    expect(SRC).toContain("const listIdentity = `");
    expect(SRC).toContain('selection.stepSpanId ?? "initial"');
  });
});

describe("U2 5.3「搜索隐藏选择」：显式目标须解阻（源码级）", () => {
  const SRC = read("components/WorkspaceFilesPanel.tsx");

  it("带 path 的显式目标同时清空搜索并切 all（否则目标仍被筛隐藏）", () => {
    const block = SRC.slice(SRC.indexOf("if (file.path === undefined)"));
    const withPath = block.slice(block.indexOf("} else {"), block.indexOf("useAppStore.setState"));
    expect(withPath).toContain('query: ""');
    expect(withPath).toContain('filter: "all"');
    expect(withPath).toContain('pane: "content"');
  });

  it("无 path 的显式目标：清空旧选择 + 显示列表，**并且同样解阻**（清搜索、切 all）", () => {
    // 5.3 实机缺口：只清 path 不清搜索 ⇒ 用户点「打开该轮文件」后看到的是**空列表**
    // （设计 D2：「显式目标未指定 path 时清空旧文件选择并显示列表」——列表里得真有文件）
    const block = SRC.slice(SRC.indexOf("if (file.path === undefined)"));
    const noPath = block.slice(0, block.indexOf("} else {"));
    expect(noPath).toContain("path: null");
    expect(noPath).toContain('pane: "list"');
    expect(noPath).toContain('query: ""');
    expect(noPath).toContain('filter: "all"');
  });
});

describe("U2 5.3「失效检查点和路径安全回退」：失效引用须真的被清掉（源码级）", () => {
  const SRC = read("components/WorkspaceFileView.tsx");

  it("失效 step：写回默认检查点并清掉对应滚动（design D2「清理 step/path/对应滚动」）", () => {
    expect(SRC).toContain("checkpoint: effectiveStepSpanId, contentScroll: null");
  });

  it("失效 path：写回 path=null 并清掉对应滚动（spec「仅清单确认 path 不存在时清空」）", () => {
    expect(SRC).toContain("{ path: null, contentScroll: null }");
  });

  it("清理后判据立刻变假 ⇒ 提示必须**锁存**，否则等于静默回退", () => {
    expect(SRC).toContain("setInvalidNotice((prev) => ({");
    expect(SRC).toContain("checkpointInvalidated || invalidNotice.checkpoint");
    expect(SRC).toContain("pathInvalidated || invalidNotice.path");
  });

  it("清单读取失败**不**清空（保留选择意图供重试）——清理只看 absent 判据", () => {
    // pathInvalidated 只由 validateSavedPath 的 "absent" 产生；失败/未知走 "unknown"，
    // 故清理 effect 内不得再出现 inspectError（否则失败也会清空选择）
    const start = SRC.indexOf("if (!checkpointInvalidated && !pathInvalidated) return;");
    expect(start).toBeGreaterThan(-1);
    const effect = SRC.slice(start, SRC.indexOf("}, [checkpointInvalidated", start));
    expect(effect).not.toContain("inspectError");
    expect(effect).not.toContain("inspect === null");
  });
});
