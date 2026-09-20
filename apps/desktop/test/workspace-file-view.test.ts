import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail } from "../src/shared/ipc";

/**
 * C 任务 2.1/2.2：文件视图**展示层**的结构断言。
 *
 * 本包无 jsdom，且 `renderToStaticMarkup` **不执行 useEffect**（实测确认），
 * 所以断言打在纯展示层 `WorkspaceFileViewBody` 上——它只吃 props，不拉数据。
 * "数据怎么来的"由 `workspace-view.test.ts`（真 fixture 的 main 侧）与
 * `workspace-files.test.ts`（纯派生层）覆盖；组件里的 effect 行为由 C 3 的
 * CDP 端到端冒烟覆盖。
 *
 * 钉住本段的四条显示义务：
 * 1. 选择器文案用"本 run 第 N 轮结束"，**不**出现沿链累加出来的轮号
 * 2. 分支 run 的来源说明指父 run 的轮号，不写成本 run 的轮号
 * 3. 不可用附件带**文字**状态（不只靠颜色）；二进制不进编辑器
 * 4. **没有任何回写 / 应用到源目录的入口**
 */

// 展示层依赖 Monaco 的 DiffEditor——node 环境下换成可断言的桩
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": "diff-editor",
      "data-language": String(props.language),
      "data-original": String(props.original),
      "data-modified": String(props.modified),
    }),
}));

// 本组件 import 链会经 store → lib/api 读 `window.api`（模块级求值）⇒ 先放桩
(globalThis as Record<string, unknown>).window = { api: {} };

const { WorkspaceFileViewBody } = await import("../src/renderer/src/components/WorkspaceFileView");
const { deriveCheckpointOptions } = await import("../src/renderer/src/lib/workspace-files");

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

/** 最小 RunDetail：隔离 run，两轮，都属本 run 自有段 */
function isolatedRun(patch: Record<string, unknown> = {}): RunDetail {
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
    ...patch,
  } as unknown as RunDetail;
}

function fileEntry(
  path: string,
  seed: string,
  change: string,
  availability: string,
  reason: string | null = null,
): Record<string, unknown> {
  return {
    path,
    bytes: 10,
    sha256: hex(seed),
    change,
    availability,
    unavailableReason: reason,
  };
}

/** 一份清单：a.txt（未变、可读）、b.txt（新增、可读）、bin.dat（可读）、gone.txt（缺失） */
function inspectPayload(origin: unknown = { kind: "import" }): Record<string, unknown> {
  return {
    runId: "run_b",
    stepSpanId: null,
    snapshotId: hex("a"),
    ownerRunId: "run_b",
    localIteration: null,
    profile: "file-tools-v1",
    worldId: "run_b",
    origin,
    files: [
      fileEntry("a.txt", "b", "unchanged", "ok"),
      fileEntry("b.txt", "c", "added", "ok"),
      fileEntry("bin.dat", "d", "unchanged", "ok"),
      fileEntry("gone.txt", "e", "unchanged", "missing", "附件不存在"),
    ],
    fileCount: 4,
    totalBytes: 34,
    unavailableCount: 1,
    initialSnapshotId: hex("a"),
  };
}

interface BodyOverrides {
  inspect?: Record<string, unknown> | null;
  inspectError?: { code: string; message: string } | null;
  loadingList?: boolean;
  selectedPath?: string | null;
  current?: Record<string, unknown> | null;
  contentError?: { code: string; message: string } | null;
  loadingContent?: boolean;
  pane?: "list" | "content";
  stepSpanId?: string | null;
}

function renderBody(run: RunDetail, overrides: BodyOverrides = {}): string {
  const stepSpanId = overrides.stepSpanId ?? null;
  const options = deriveCheckpointOptions(run);
  return renderToStaticMarkup(
    createElement(WorkspaceFileViewBody, {
      run,
      options,
      selection: { stepSpanId },
      onSelect: () => {},
      inspect: overrides.inspect === undefined ? null : (overrides.inspect as never),
      inspectError: overrides.inspectError ?? null,
      loadingList: overrides.loadingList ?? false,
      selectedPath: overrides.selectedPath ?? null,
      onSelectPath: () => {},
      current: overrides.current === undefined ? null : (overrides.current as never),
      currentKey: overrides.selectedPath ?? null,
      currentLabel: options.find((o) => o.stepSpanId === stepSpanId)?.label ?? "本 run 当前检查点",
      loadingContent: overrides.loadingContent ?? false,
      contentError: overrides.contentError ?? null,
      pane: overrides.pane ?? "list",
      onPane: () => {},
      fetchInitial: async () => null,
    } as never),
  );
}

describe("文件视图展示层 —— 选择器与只读声明", () => {
  it("选择器用'本 run 第 N 轮结束'，且**不出现沿链累加**的轮号", () => {
    const html = renderBody(isolatedRun());
    expect(html).toContain("本 run 初始状态");
    expect(html).toContain("本 run 第 1 轮结束");
    expect(html).toContain("本 run 第 2 轮结束");
    // 两轮自有步骤 ⇒ 只有 1、2；不得出现按合并轨迹累计出来的 3/4
    expect(html).not.toContain("第 3 轮");
    expect(html).not.toContain("第 4 轮");
  });

  it("祖先前缀的 step 不进选择器（只取 leafSpanIds 里的自有 step）", () => {
    // 合并轨迹含父 run 的 s_2（第 2 轮）与祖先 s_1（第 1 轮），本 run 只有 s_mine（第 1 轮）
    const html = renderBody(
      isolatedRun({
        spans: [
          { id: "s_1", parent: null, kind: "agent.step", n: 1 },
          { id: "s_2", parent: null, kind: "agent.step", n: 2 },
          { id: "s_mine", parent: null, kind: "agent.step", n: 1 },
        ],
        leafSpanIds: ["s_mine"],
      }),
    );
    expect(html).toContain("本 run 第 1 轮结束");
    expect(html).not.toContain("本 run 第 2 轮结束");
  });

  it("只读声明在场（明示不写文件、无回写入口），且清单未就绪时不留白", () => {
    const html = renderBody(isolatedRun());
    expect(html).toContain("只读");
    expect(html).toContain("不写文件");
    expect(html).toContain("没有任何回写源目录的入口");
    expect(html).toContain("选择上方任一检查点查看文件");
  });

  it("**任何形态下都不得出现回写 / 应用到源目录的入口**", () => {
    for (const inspect of [null, inspectPayload()]) {
      const html = renderBody(isolatedRun(), { inspect });
      expect(html).not.toContain("应用到源目录");
      expect(html).not.toContain("保存到源目录");
      expect(html).not.toContain("写入源目录");
    }
  });
});

describe("文件视图展示层 —— 清单与状态标签", () => {
  it("清单渲染文件名；不可用附件带**文字**标签；汇总行提示不可用数", () => {
    const html = renderBody(isolatedRun(), { inspect: inspectPayload() });
    expect(html).toContain("a.txt");
    expect(html).toContain("bin.dat");
    expect(html).toContain("gone.txt");
    expect(html).toContain("附件缺失");
    expect(html).toContain("新增");
    expect(html).toContain("1 个附件不可用");
  });

  it("分支 run：来源说明指父 run 与父轮号，不写成本 run 的轮号", () => {
    const html = renderBody(
      isolatedRun({
        spans: [
          { id: "s_1", parent: null, kind: "agent.step", n: 1 },
          { id: "s_2", parent: null, kind: "agent.step", n: 2 },
          { id: "s_mine", parent: null, kind: "agent.step", n: 1 },
        ],
        leafSpanIds: ["s_mine"],
      }),
      { inspect: inspectPayload({ kind: "checkpoint", runId: "run_a", stepSpanId: "s_2" }) },
    );
    expect(html).toContain("父运行 run_a 的第 2 轮检查点");
    expect(html).not.toContain("本 run 第 3 轮");
  });

  it("父轮号解析不出来时只报 step，**不猜**一个看起来对的轮号", () => {
    const html = renderBody(isolatedRun(), {
      inspect: inspectPayload({ kind: "checkpoint", runId: "run_a", stepSpanId: "s_missing" }),
    });
    expect(html).toContain("轮号未能在轨迹中解析");
    expect(html).toContain("s_missing");
  });

  it("清单为空 → 明确说明世界内没有文件，而不是留白", () => {
    const html = renderBody(isolatedRun(), {
      inspect: { ...inspectPayload(), files: [], fileCount: 0, totalBytes: 0, unavailableCount: 0 },
    });
    expect(html).toContain("空清单");
    expect(html).toContain("世界内没有任何文件");
  });

  it("清单读取被拒（按 runId 无隔离文件世界）→ 展示可辨认原因，不用当前目录兜底", () => {
    const html = renderBody(isolatedRun(), {
      inspectError: { code: "WORKSPACE_NO_WORKSPACE", message: "run_b 没有隔离文件世界记录" },
    });
    expect(html).toContain("WORKSPACE_NO_WORKSPACE");
    expect(html).toContain("不会用");
    expect(html).toContain("当前目录");
  });
});

describe("文件视图展示层 —— 内容 / 差异呈现", () => {
  it("未选文件时不渲染编辑器", () => {
    const html = renderBody(isolatedRun(), { inspect: inspectPayload() });
    expect(html).not.toContain('data-testid="diff-editor"');
  });

  it("两侧都有文本 → 进 DiffEditor（只读、并排）", () => {
    const html = renderBody(isolatedRun(), {
      inspect: inspectPayload(),
      selectedPath: "a.txt",
      current: { status: "text", path: "a.txt", bytes: 1, sha256: hex("b"), text: "new" },
    });
    expect(html).toContain('data-testid="diff-editor"');
    expect(html).toContain("左：本 run 初始状态");
  });

  it("二进制内容 → 只展示大小/哈希，**不**出现编辑器", () => {
    const html = renderBody(isolatedRun(), {
      inspect: inspectPayload(),
      selectedPath: "bin.dat",
      current: { status: "binary", path: "bin.dat", bytes: 8, sha256: hex("d") },
    });
    expect(html).not.toContain('data-testid="diff-editor"');
    expect(html).toContain("二进制文件");
    expect(html).toContain("不参与文本比较");
  });

  it("内容缺失 → 明说缺失，不渲染空编辑器冒充'文件是空的'", () => {
    const html = renderBody(isolatedRun(), {
      inspect: inspectPayload(),
      selectedPath: "gone.txt",
      current: { status: "missing", path: "gone.txt", bytes: 12, sha256: hex("e") },
    });
    expect(html).not.toContain('data-testid="diff-editor"');
    expect(html).toContain("附件缺失，无法读取内容");
  });

  it("内容损坏 → 明说哈希/长度不符，拒绝展示内容", () => {
    const html = renderBody(isolatedRun(), {
      inspect: inspectPayload(),
      selectedPath: "a.txt",
      current: { status: "corrupt", path: "a.txt", bytes: 9, sha256: hex("b") },
    });
    expect(html).not.toContain('data-testid="diff-editor"');
    expect(html).toContain("与清单记录的哈希/长度不符");
  });

  it("读取被拒 → 展示可辨认原因", () => {
    const html = renderBody(isolatedRun(), {
      inspect: inspectPayload(),
      selectedPath: "a.txt",
      current: { status: "rejected", path: "a.txt", code: "WORKSPACE_ESCAPE", reason: "越权" },
    });
    expect(html).toContain("WORKSPACE_ESCAPE");
  });

  it("路径不在所选清单 → 明说不在清单里", () => {
    const html = renderBody(isolatedRun(), {
      inspect: inspectPayload(),
      selectedPath: "a.txt",
      current: { status: "not_found", path: "a.txt", reason: "manifest 里没有该路径" },
    });
    expect(html).toContain("该路径不在所选清单里");
  });
});
