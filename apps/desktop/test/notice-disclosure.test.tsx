import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// RunHeaderView / IsolatedRunNoticeView 的 store 薄壳在 import 时就会触到 window.api
// （../lib/api.ts）⇒ 桩必须先就位；ESM 静态 import 会被提升，故用动态 import
// （与 run-workspace.test.ts 同法）。本文件只测不依赖 store 的纯判据与纯视图。
(globalThis as Record<string, unknown>).window = { api: {} };

import type { WorkspaceMeta } from "@rebaseagent/trace-sdk/schema";
import { expandedKeysInclude, toggleExpandedKey } from "../src/renderer/src/lib/reading-state";
import type { RunDetail } from "../src/shared/ipc";
const { ISOLATED_SOURCE_NOTICE_KEY, IsolatedRunNoticeView } = await import(
  "../src/renderer/src/components/DetailNotices"
);
const { RunHeaderView } = await import("../src/renderer/src/components/RunWorkspace");
const { isolatedRunNoticeView } = await import("../src/renderer/src/lib/isolated-fork");

/**
 * UI 密度 change（improve-workspace-reading-and-editing）任务 1.3/1.5：
 * 隔离说明分层去重与共享 disclosure 的静态断言。
 *
 * 判据来源：desktop-ui delta 场景
 *   - 「隔离文件页不重复同一说明」：运行页头与文件区不重复同一长隔离段落；
 *   - 「技术元信息按需完整阅读」：同一受控 disclosure、展开状态按 run 隔离、
 *     完整原值可读；不适用动作原因可查询。
 */

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

/** 完整保真边界里的标志性句子（断言"长段落只出现一次"用它定位） */
const DETAIL_SENTENCE = "源目录、父分支与兄弟分支都不会被修改";

function workspaceMeta(origin: WorkspaceMeta["origin"]): WorkspaceMeta {
  return {
    profile: "file-tools-v1",
    world_id: "r_iso",
    write_authorized: true,
    initial_snapshot: { id: "0".repeat(64), files: [] },
    origin,
  };
}

function isolatedDetail(origin: WorkspaceMeta["origin"]): RunDetail {
  return {
    meta: {
      type: "run.meta",
      id: "r_iso",
      format_version: 2,
      task: "隔离任务",
      model: "controlled-model",
      created_at: "2026-10-09T00:00:00.000Z",
      parent: null,
      fork: null,
      workspace: workspaceMeta(origin),
    },
    spans: [],
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    chain: [{ meta: null as never, fork: null }],
    leafSpanIds: [],
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  } as unknown as RunDetail;
}

describe("isolatedRunNoticeView：分层视图（纯判据）", () => {
  it("v1 老 trace（无 workspace）返回 null——不得把老记录显示成隔离", () => {
    expect(isolatedRunNoticeView(null)).toBeNull();
    const v1 = { meta: {} } as unknown as RunDetail;
    expect(isolatedRunNoticeView(v1)).toBeNull();
  });

  it("import 来源：compact 是一行紧凑摘要，不包含完整保真边界句子", () => {
    const view = isolatedRunNoticeView(isolatedDetail({ kind: "import" }));
    expect(view).not.toBeNull();
    expect(view?.compact).toContain("隔离文件运行");
    expect(view?.compact).toContain("源目录采集");
    expect(view?.compact).not.toContain(DETAIL_SENTENCE);
    expect(view?.detail).toContain(DETAIL_SENTENCE);
  });

  it("checkpoint 来源：compact 带来源 run，tech 逐项给出 profile/world_id/origin", () => {
    const view = isolatedRunNoticeView(
      isolatedDetail({ kind: "checkpoint", run_id: "r_parent", step_span: "s_01" }),
    );
    expect(view?.compact).toContain("r_parent");
    const labels = view?.tech.map((entry) => entry.label) ?? [];
    expect(labels).toContain("profile");
    expect(labels).toContain("world_id");
    expect(labels).toContain("origin");
    const origin = view?.tech.find((entry) => entry.label === "origin");
    expect(origin?.value).toContain("r_parent");
  });
});

describe("IsolatedRunNoticeView：共享 disclosure 的纯展示", () => {
  it("收起时只有紧凑摘要，完整边界与技术值不渲染", () => {
    const view = isolatedRunNoticeView(isolatedDetail({ kind: "import" }));
    const out = html(
      createElement(IsolatedRunNoticeView, {
        view: view!,
        runId: "r_iso",
        expanded: false,
        onToggle: () => {},
      }),
    );
    expect(out).toContain("来源与技术详情");
    expect(out).toContain(view!.compact);
    expect(out).not.toContain(DETAIL_SENTENCE);
    expect(out).not.toContain("world_id");
    expect(out).toContain('aria-expanded="false"');
  });

  it("展开时完整边界与技术值可读，内容区 id 与 aria-controls 对上", () => {
    const view = isolatedRunNoticeView(isolatedDetail({ kind: "import" }));
    const out = html(
      createElement(IsolatedRunNoticeView, {
        view: view!,
        runId: "r_iso",
        expanded: true,
        onToggle: () => {},
      }),
    );
    expect(out).toContain(DETAIL_SENTENCE);
    expect(out).toContain("world_id");
    expect(out).toContain('aria-controls="notice-isolated-source-r_iso"');
    expect(out).toContain('id="notice-isolated-source-r_iso"');
    expect(out).toContain('aria-expanded="true"');
  });
});

describe("RunHeaderView：页头只留紧凑摘要（去重）", () => {
  it("隔离 run：页头显示紧凑摘要与「文件隔离」徽标，不渲染完整保真边界段落", () => {
    const detail = isolatedDetail({ kind: "import" });
    const out = html(createElement(RunHeaderView, { detail, runs: [], selectedRunId: "r_iso" }));
    expect(out).toContain("文件隔离");
    expect(out).toContain("隔离文件运行");
    expect(out).not.toContain(DETAIL_SENTENCE);
  });

  it("同屏去重：页头 + 收起态提示区合计，长段事实句出现 0 次；展开提示区后恰 1 次", () => {
    const detail = isolatedDetail({ kind: "import" });
    const view = isolatedRunNoticeView(detail)!;
    const header = html(createElement(RunHeaderView, { detail, runs: [], selectedRunId: "r_iso" }));
    const collapsedNotice = html(
      createElement(IsolatedRunNoticeView, {
        view,
        runId: "r_iso",
        expanded: false,
        onToggle: () => {},
      }),
    );
    const expandedNotice = html(
      createElement(IsolatedRunNoticeView, {
        view,
        runId: "r_iso",
        expanded: true,
        onToggle: () => {},
      }),
    );
    const count = (markup: string): number => markup.split(DETAIL_SENTENCE).length - 1;
    expect(count(header) + count(collapsedNotice)).toBe(0);
    expect(count(header) + count(expandedNotice)).toBe(1);
  });
});

describe("IsolatedParentUnsupportedNotice 接线（源码契约）", () => {
  // 组件读 store（renderToStaticMarkup 拿不到状态）⇒ 外壳接线用源码断言钉住：
  // ① 首次 llm.call 的不适用分支必须挂该组件；② 展开状态走 run 级共享键。
  const src = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
    "utf8",
  );

  it("不适用分支渲染 IsolatedParentUnsupportedNotice（不是平铺长文案）", () => {
    expect(src).toContain("<IsolatedParentUnsupportedNotice run={run} />");
    expect(src).toContain("ISOLATED_PARENT_UNSUPPORTED_KEY");
  });

  it("展开键是静态 UI 键、与隔离说明同一 noticesExpanded 通道", () => {
    expect(src).toContain('"isolated-parent-unsupported"');
    expect(src).toContain("toggleNoticeExpanded");
  });
});

describe("运行级说明展开键的会话语义", () => {
  it("键集合：undefined = 全部折叠；toggle 去重且稳定顺序", () => {
    expect(expandedKeysInclude(undefined, ISOLATED_SOURCE_NOTICE_KEY)).toBe(false);
    let keys = toggleExpandedKey(undefined, ISOLATED_SOURCE_NOTICE_KEY);
    expect(keys).toEqual([ISOLATED_SOURCE_NOTICE_KEY]);
    // 重复 toggle 回到折叠；再次展开追加到尾部（不产生重复键）
    keys = toggleExpandedKey(keys, ISOLATED_SOURCE_NOTICE_KEY);
    expect(keys).toEqual([]);
    keys = toggleExpandedKey(keys, "other");
    keys = toggleExpandedKey(keys, ISOLATED_SOURCE_NOTICE_KEY);
    expect(keys).toEqual(["other", ISOLATED_SOURCE_NOTICE_KEY]);
  });
});
