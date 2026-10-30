import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R2.2 6.4/6.5：比较文件视图的接线契约（本包无 jsdom）。
 *
 * 钉住四件事：
 * - 文件视图只在双运行详细比较里出现，并保留返回详细比较/刷新清单入口；
 * - 两侧默认检查点在桌面显式解析（最近自有完成步骤，无则初始）；
 * - 清单/正文请求带冻结 selector 与 expectedSnapshotIds，迟到响应按序号丢弃；
 * - 二进制/超限/缺失不生成伪文本差异，逐侧状态仍可读。
 */

function read(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "../src/renderer/src", path), "utf8");
}

describe("比较文件视图接线", () => {
  it("CompareWorkspace 只在 store 文件视图打开且 pair 匹配时渲染文件容器", () => {
    const src = read("components/CompareWorkspace.tsx");
    expect(src).toContain("compareFileView.open");
    expect(src).toContain("compareFileView.pairKey === pairKeyOf");
    expect(src).toContain("<CompareFileWorkspace");
    expect(src).toContain("onOpenFilesView={openCompareFileView}");
    const view = read("components/CompareWorkspaceView.tsx");
    expect(view).toContain("onOpenFilesView");
    expect(view).toContain("compare.filesAria");
  });

  it("默认检查点显式解析；只有初始才省略 stepSpanId", () => {
    const src = read("components/CompareFileWorkspace.tsx");
    expect(src).toContain("defaultCheckpointStepId(leftDetail)");
    expect(src).toContain("defaultCheckpointStepId(rightDetail)");
    expect(src).toContain("compareFileSelectorOf({ runId: pair.leftRunId, stepSpanId: leftStep })");
    expect(src).toContain("compareFileSelectionKey");
    expect(src).toContain("resolveCompareFileSide");
  });

  it("失效 selector 不自动改点：只显示原因与显式默认按钮", () => {
    const src = read("components/CompareFileWorkspace.tsx");
    expect(src).toContain('state.kind === "stale"');
    expect(src).toContain("data-compare-file-use-default");
    expect(src).toContain("sideStateReason(state)");
  });

  it("清单/正文请求带身份守卫和 expectedSnapshotIds，迟到响应按序号丢弃", () => {
    const src = read("components/CompareFileWorkspace.tsx");
    expect(src).toContain("manifestSeq");
    expect(src).toContain("fileSeq");
    expect(src).toContain("expectedSnapshotIdsOf");
    expect(src).toContain("expectedSnapshotIds: expected");
    expect(src).toContain("manifestNonce");
    expect(src).toContain("data-compare-files-refresh");
  });

  it("清单引用与正文核验分列；无文本 diff 时逐侧状态可读", () => {
    const src = read("components/CompareFileWorkspace.tsx");
    expect(src).toContain("referenceLabel(entry, translator)");
    expect(src).toContain("textDiffSidesOf(fileResult.result)");
    expect(src).toContain("!file.textDiffEligible");
    expect(src).toContain("FileSideFallback");
    expect(src).toContain("compare.fileNoDiff");
  });

  it("单侧打开固定本次比较检查点/路径；不回到未验证的运行页", () => {
    const src = read("components/CompareFileWorkspace.tsx");
    expect(src).toContain("openCompareSideFilesAt");
    expect(src).toContain("state.selection.stepSpanId, currentPath");
  });
});
