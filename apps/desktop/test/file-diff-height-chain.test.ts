import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail } from "../src/shared/ipc";

/**
 * UI 密度 change（improve-workspace-reading-and-editing）任务 2.1：
 * 文件页 diff 的**可用高度链**（design D3）。
 *
 * 断言三层（本包无 jsdom 的既有纪律）：
 *   ① **能力断言**（静态渲染）：两侧可读走主 diff 分支时，渲染出高度链容器
 *      （`data-file-diff-chain`）、编辑器占满剩余高度（`height:100%`）与挤压下限
 *      （`min-h-[200px]`）；异常分支（不可比较/单侧视图）不进高度链、仍由外层滚动承载。
 *   ② **接线契约**（source 级，剥注释）：主 diff 编辑器的固定 vh 已退场——
 *      全源码 `min(60vh, 640px)` 只允许剩单侧只读视图那一处；header/toolbar shrink-0。
 */

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": "diff-editor",
      "data-original": String(props.original),
      "data-modified": String(props.modified),
    }),
}));

(globalThis as Record<string, unknown>).window = { api: {} };

const { WorkspaceFileViewBody } = await import("../src/renderer/src/components/WorkspaceFileView");

/** 组件源码（接线契约共用） */
const SRC = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/WorkspaceFileView.tsx"),
  "utf8",
);

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function isolatedRun(): RunDetail {
  return {
    meta: { id: "run_b", workspace: { profile: "file-tools-v1", world_id: "run_b" } },
    spans: [{ id: "s_1", parent: null, kind: "agent.step", n: 1 }],
    events: [],
    status: "completed",
    chain: [],
    leafSpanIds: ["s_1"],
  } as unknown as RunDetail;
}

function inspect(): Record<string, unknown> {
  return {
    runId: "run_b",
    stepSpanId: null,
    snapshotId: hex("a"),
    ownerRunId: "run_b",
    localIteration: null,
    profile: "file-tools-v1",
    worldId: "run_b",
    origin: { kind: "import" },
    files: [
      {
        path: "a.txt",
        bytes: 5,
        sha256: hex("b"),
        change: "modified",
        availability: "ok",
        unavailableReason: null,
      },
    ],
    fileCount: 1,
    totalBytes: 5,
    unavailableCount: 0,
    initialSnapshotId: hex("a"),
  };
}

function text(path: string, body: string): Record<string, unknown> {
  return { status: "text", path, bytes: body.length, sha256: hex("c"), text: body };
}

function renderBody(overrides: Record<string, unknown> = {}): string {
  const run = isolatedRun();
  return renderToStaticMarkup(
    createElement(WorkspaceFileViewBody, {
      run,
      options: [],
      selection: { stepSpanId: "s_1" },
      onSelect: () => {},
      inspect: inspect(),
      inspectError: null,
      loadingList: false,
      selectedPath: "a.txt",
      onSelectPath: () => {},
      current: null,
      currentKey: "k",
      currentLabel: "本 run 第 1 轮结束",
      loadingContent: false,
      contentError: null,
      pane: "content",
      onPane: () => {},
      query: "",
      onQuery: () => {},
      changeFilter: "all",
      onFilter: () => {},
      filterPreference: "auto",
      dirWidth: 232,
      onDirWidth: () => {},
      dirCollapsed: false,
      onDirCollapsed: () => {},
      diffPreference: "auto",
      onDiffPreference: () => {},
      wordWrap: true,
      onWordWrap: () => {},
      listScrollTop: 0,
      onListScrollTop: () => {},
      fetchInitial: async () => null,
      ...overrides,
    } as never),
  );
}

describe("文件页 diff 高度链（任务 2.1）", () => {
  it("两侧可读（主 diff 分支）：渲染高度链容器，编辑器 height=100% 且容器带挤压下限", () => {
    const out = renderBody({
      current: text("a.txt", "新内容"),
      initial: text("a.txt", "旧内容"),
    });
    expect(out).toContain('data-file-diff-chain="true"');
    // 编辑器占满剩余高度（静态渲染下是懒加载占位承接 height prop）
    expect(out).toContain("height:100%");
    // 容器 flex-1 吃剩余 + min-h-[200px] 挤压下限（缩写类名断言）
    expect(out).toContain("min-h-[200px]");
    expect(out).toContain("flex-1");
    // 头两行不被压缩（shrink-0 落在 header/toolbar 上）
    expect(out).toContain("shrink-0 border-b border-gray-200 px-4 py-2");
  });

  it("异常分支（一侧不可读）：不进高度链，状态卡与单侧视图仍由外层滚动承载", () => {
    const out = renderBody({
      current: text("a.txt", "新内容"),
      initial: { status: "corrupt", path: "a.txt", bytes: 5, sha256: hex("1"), reason: "x" },
    });
    expect(out).not.toContain('data-file-diff-chain="true"');
    expect(out).toContain("不进入文本差异");
    // 单侧只读视图仍在（可读侧完整展示），保留视口相对高度
    expect(out).toContain("single-side-editor");
    expect(out).toContain("height:min(60vh, 640px)");
  });

  it("接线契约：固定 vh 只允许剩单侧视图一处；主 diff 编辑器 height=100%", () => {
    // 剥注释后计数（纪律：裸计数会把注释里的历史说明一起咬）
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const vhCount = stripped.split("min(60vh, 640px)").length - 1;
    expect(vhCount).toBe(1);
    // 主 diff 编辑器（file-diff 锚点）用 height="100%"
    expect(SRC).toMatch(/data-monaco-host="file-diff"[\s\S]{0,200}?height="100%"/);
    // 身份行 shrink-0（高度链里按内容定高）
    expect(SRC).toContain('className="shrink-0 px-4 py-1.5 text-[10px] text-gray-400"');
  });
});
