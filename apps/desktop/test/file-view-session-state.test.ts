import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U2 任务 2.4：文件选择/pane/偏好接入**会话状态**（不再用组件局部 state）。
 *
 * 对应 delta：
 * -「文件页签往返恢复阅读」：组件卸载不使其回到初始状态
 * -「失效检查点和路径安全回退」：失效引用**可见地**提示，不静默回退
 *
 * ⚠️ 本包无 jsdom ⇒ 本文件钉两件事：
 *   ① **能力断言**（展示层能渲染失效说明）——打 `renderToStaticMarkup`；
 *   ② **接线契约**（源码级）——状态来自 store 的 `fileReadingOf(run.meta.id)`、
 *      写回走 `setFileReading`、**旧的组件局部 selection state 必须消失**
 *      （"卸载即丢"正是 R7 缺陷的根因，若局部 state 复活则本段白做）。
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
const { deriveCheckpointOptions } = await import("../src/renderer/src/lib/workspace-files");

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function isolatedRun(): RunDetail {
  return {
    meta: { id: "run_b", workspace: { profile: "file-tools-v1", world_id: "run_b" } },
    spans: [
      { id: "s_1", parent: null, kind: "agent.step", n: 1 },
      { id: "s_2", parent: null, kind: "agent.step", n: 2 },
    ],
    events: [],
    status: "completed",
    chain: [],
    leafSpanIds: ["s_1", "s_2"],
  } as unknown as RunDetail;
}

function renderBody(overrides: Record<string, unknown> = {}): string {
  const run = isolatedRun();
  return renderToStaticMarkup(
    createElement(WorkspaceFileViewBody, {
      run,
      options: deriveCheckpointOptions(run),
      selection: { stepSpanId: null },
      onSelect: () => {},
      inspect: null,
      inspectError: null,
      loadingList: false,
      selectedPath: null,
      onSelectPath: () => {},
      current: null,
      currentKey: null,
      currentLabel: "本 run 当前检查点",
      loadingContent: false,
      contentError: null,
      pane: "list",
      onPane: () => {},
      fetchInitial: async () => null,
      ...overrides,
    } as never),
  );
}

describe("U2 失效回退的可见说明（能力断言）", () => {
  it("检查点失效 ⇒ 渲染说明文字（不是静默回退）", () => {
    const html = renderBody({ checkpointInvalidated: true });
    expect(html).toContain("已不属于本 run");
    expect(html).toContain("回到最近的自有完成步骤");
  });

  it("路径失效 ⇒ 渲染说明文字且明说不改选同名", () => {
    const html = renderBody({ pathInvalidated: true });
    expect(html).toContain("不在所选清单里");
    expect(html).toContain("不会改选同名");
  });

  it("未失效时**不渲染**这两条说明（不误报）", () => {
    const html = renderBody();
    expect(html).not.toContain("已不属于本 run");
    expect(html).not.toContain("不会改选同名");
  });

  it("两条失效可同时出现（检查点与路径各自独立）", () => {
    const html = renderBody({ checkpointInvalidated: true, pathInvalidated: true });
    expect(html).toContain("已不属于本 run");
    expect(html).toContain("不会改选同名");
  });
});

describe("U2 接线契约：文件选择来自会话状态，不是组件局部 state", () => {
  const SRC = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/WorkspaceFileView.tsx"),
    "utf8",
  );

  it("状态读自 store 的 fileReadingOf(run.meta.id)，写回走 setFileReading", () => {
    expect(SRC).toContain("s.fileReadingOf(run.meta.id)");
    expect(SRC).toContain("const setFileReading = useAppStore((s) => s.setFileReading)");
    expect(SRC).toContain("setFileReading(run.meta.id");
  });

  it("**旧的挂载复位 effect 必须消失**（卸载即丢是 R7 缺陷根因）", () => {
    // 旧形态：按 run.meta.id 复位 selection/selectedPath/pane
    expect(SRC).not.toContain("setSelection({ stepSpanId: null })");
    expect(SRC).not.toContain("setSelectedPath(null)");
    expect(SRC).not.toContain('setPane("list")');
  });

  it("旧局部 selection/pane state 声明消失（checkpoint 与 pane 都由 store 供）", () => {
    expect(SRC).not.toContain("const [selection, setSelection]");
    expect(SRC).not.toContain("const [pane, setPane]");
    expect(SRC).not.toContain("const [selectedPath, setSelectedPath]");
  });

  it("恢复前做引用校验（不沿用失效引用）", () => {
    expect(SRC).toContain("validateCheckpointStepId(");
    expect(SRC).toContain("validateSavedPath(");
  });
});
