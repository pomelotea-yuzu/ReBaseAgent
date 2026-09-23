import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U2 任务 5.4 实机验收暴露的真实产品缺陷回归：**单侧可读时"可读侧完整展示"通道缺失**。
 *
 * spec delta「不可用侧不伪装为空差异」（原文）：
 * > 两侧分别标出真实状态，**可读侧完整展示并可复制查找**，禁止把不可用侧置空进行 diff；
 * > **左右互换同样成立**
 *
 * 5.4 实机（CDP 真点击 + 真 monaco 读取）坐实的缺口：两个"进不了 diff"的早返回分支
 * （`!comparability.ok` / `!diffEligibility.ok`）都只渲染 header + toolbar + 状态卡，
 * **没有任何编辑器** ⇒ 可读侧原文拿不到、查找/换行还被判禁（`find: anyReady && diffEligible`）；
 * 其中 `!comparability.ok` 分支**只标所选侧**状态，初始侧"有文本"完全不可见。
 *
 * ⚠️ 本包无 jsdom ⇒ 本文件钉两层（与 5.3 的 `file-view-scroll-wiring.test.ts` 同法）：
 *   ① **能力断言**：静态渲染里能不能看到单侧只读视图（`single-side-editor`）与两侧状态；
 *   ② **接线契约**（source 级）：实例有没有接住、判据有没有真的按"编辑器就绪"传下去。
 *     —— 纯逻辑单测全绿也照不出"没接线"，这正是 4.1/4.5/4.6 曾被误勾的同一类根因。
 */

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": "diff-editor",
      "data-original": String(props.original),
      "data-modified": String(props.modified),
    }),
  Editor: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": String(props["data-testid"]),
      "data-value": String(props.value),
    }),
}));

(globalThis as Record<string, unknown>).window = { api: {} };

const { WorkspaceFileViewBody } = await import("../src/renderer/src/components/WorkspaceFileView");
const { deriveCheckpointOptions } = await import("../src/renderer/src/lib/workspace-files");

/** 组件源码（能力断言 + 接线契约共用） */
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
      options: deriveCheckpointOptions(run),
      selection: { stepSpanId: "s_2" },
      onSelect: () => {},
      inspect: inspect(),
      inspectError: null,
      loadingList: false,
      selectedPath: "a.txt",
      onSelectPath: () => {},
      current: null,
      currentKey: "k",
      currentLabel: "本 run 第 2 轮结束",
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

// ---------------------------------------------------------------------------
// ① 能力断言：单侧可读 ⇒ 该侧仍被完整展示
// ---------------------------------------------------------------------------

describe("U2 5.4 单侧可读时的完整展示（能力断言）", () => {
  it("初始侧 binary + 所选侧 text ⇒ 渲染**只读单侧编辑器**，且无任何 diff 编辑器", () => {
    const html = renderBody({
      current: text("a.txt", "现在是文本内容"),
      initial: { status: "binary", path: "a.txt", bytes: 9, sha256: hex("d") },
    });
    expect(html).toContain('data-testid="single-side-editor"');
    expect(html).not.toContain('data-testid="diff-editor"');
    // 展示的是**可读的那一侧**（所选检查点侧）
    expect(html).toContain(
      "右：本 run 第 2 轮结束（该侧原文完整展示；另一侧不可比较，未用空文本参与 diff）",
    );
  });

  it("**左右互换**（初始侧 text + 所选侧 binary）⇒ 同样渲染单侧编辑器并展示初始侧原文", () => {
    const html = renderBody({
      current: { status: "binary", path: "a.txt", bytes: 9, sha256: hex("d") },
      initial: text("a.txt", "初始文本内容"),
    });
    expect(html).toContain('data-testid="single-side-editor"');
    expect(html).not.toContain('data-testid="diff-editor"');
    // 明确标出展示的是左侧（初始快照侧）——左右互换下"哪一侧可读"必须一目了然
    expect(html).toContain(
      "左：本 run 初始状态（该侧原文完整展示；另一侧不可比较，未用空文本参与 diff）",
    );
  });

  it("**两侧状态都标出**（两个分支统一文案，不再只标所选侧）", () => {
    const both = [
      renderBody({
        current: text("a.txt", "现在是文本内容"),
        initial: { status: "binary", path: "a.txt", bytes: 9, sha256: hex("d") },
      }),
      renderBody({
        current: { status: "binary", path: "a.txt", bytes: 9, sha256: hex("d") },
        initial: text("a.txt", "初始文本内容"),
      }),
    ];
    for (const html of both) {
      expect(html).toContain("初始快照侧：");
      expect(html).toContain("所选检查点侧：");
      expect(html).toContain("内容不可比较（二进制 / 附件缺失 / 损坏）");
      expect(html).toContain("有文本");
    }
  });

  it("两侧都不可读 ⇒ **一个编辑器都不渲染**（没有伪空文件）", () => {
    const html = renderBody({
      current: { status: "binary", path: "a.txt", bytes: 9, sha256: hex("d") },
      initial: { status: "corrupt", path: "a.txt", bytes: 9, sha256: hex("e"), reason: "x" },
    });
    expect(html).not.toContain('data-testid="single-side-editor"');
    expect(html).not.toContain('data-testid="diff-editor"');
    expect(html).not.toContain("无变化");
  });

  it("两侧都可比较 ⇒ 走 diff，**不**重复渲染单侧视图", () => {
    const html = renderBody({
      current: text("a.txt", "新内容"),
      initial: text("a.txt", "旧内容"),
    });
    expect(html).toContain('data-testid="diff-editor"');
    expect(html).not.toContain('data-testid="single-side-editor"');
  });

  it("初始侧经校验 not_found + 所选侧 text ⇒ 仍是**合法 diff**，不退化到单侧视图", () => {
    const html = renderBody({
      current: text("b.txt", "刚写入的新文件"),
      initial: { status: "not_found", path: "b.txt", reason: "初始清单没有它" },
    });
    expect(html).toContain('data-testid="diff-editor"');
    expect(html).not.toContain('data-testid="single-side-editor"');
  });
});

// ---------------------------------------------------------------------------
// ③ 所选侧"加载中 / 失败 / 无结果"时不得吞掉**可读的另一侧**（5.4 实机 B 型的根因）
// ---------------------------------------------------------------------------

describe("U2 5.4 另一侧可读时不走独占卡（能力断言）", () => {
  it("初始侧 text + 所选侧**加载中** ⇒ 不进独占「读取文件内容…」，仍展示初始侧全文", () => {
    const html = renderBody({
      current: null,
      currentLabel: "本 run 第 2 轮结束",
      loadingContent: true,
      initial: text("a.txt", "初始文本内容"),
    });
    expect(html).not.toContain("读取文件内容…");
    expect(html).toContain('data-testid="single-side-editor"');
    expect(html).toContain(
      "左：本 run 初始状态（该侧原文完整展示；另一侧不可比较，未用空文本参与 diff）",
    );
    expect(html).toContain("所选检查点侧：正在读取");
  });

  it("初始侧 text + 所选侧**通道失败** ⇒ 仍展示初始侧全文，且失败明细（错误码）不丢", () => {
    const html = renderBody({
      current: null,
      contentError: { code: "READ_SCHEMA_INVALID", message: "结构不对" },
      selectedFailed: true,
      initial: text("a.txt", "初始文本内容"),
    });
    expect(html).toContain('data-testid="single-side-editor"');
    expect(html).toContain("所选检查点侧：读取失败（不是不存在）");
    expect(html).toContain("读取失败（READ_SCHEMA_INVALID）：结构不对");
    expect(html).toContain("并不表示该文件不存在");
  });

  it("初始侧 text + 所选侧**尚无结果** ⇒ 仍展示初始侧全文（不显示「尚未读取该文件」独占卡）", () => {
    const html = renderBody({
      current: null,
      initial: text("a.txt", "初始文本内容"),
    });
    expect(html).not.toContain("尚未读取该文件。");
    expect(html).toContain('data-testid="single-side-editor"');
    expect(html).toContain(
      "左：本 run 初始状态（该侧原文完整展示；另一侧不可比较，未用空文本参与 diff）",
    );
  });

  it("**另一侧也读不出东西**时独占卡必须原样保留（不因新门控而回归）", () => {
    const html = renderBody({
      current: null,
      contentError: { code: "READ_SCHEMA_INVALID", message: "结构不对" },
    });
    expect(html).toContain("读取失败（READ_SCHEMA_INVALID）");
    expect(html).toContain("不表示该文件不存在");
    expect(html).not.toContain('data-testid="single-side-editor"');
  });
});

// ---------------------------------------------------------------------------
// ④ 接线契约：门控确实挂在**三个**早返回上
// ---------------------------------------------------------------------------

describe("U2 5.4 早返回门控接线契约（源码级）", () => {
  it("可读侧全文由 `initialReadableText` 判定，且三个早返回都被它门控", () => {
    expect(SRC).toContain(
      'const initialReadableText = initial !== null && initial.status === "text"',
    );
    expect(SRC).toContain("if (loading && current === null && initialReadableText === null) {");
    expect(SRC).toContain("if (error !== null && initialReadableText === null) {");
    expect(SRC).toContain("if (current === null && initialReadableText === null) {");
  });

  it("门控后 `current` 可能为 null ⇒ rejected / not_found 早返回必须先判非空", () => {
    expect(SRC).toContain('if (current !== null && current.status === "rejected") {');
    expect(SRC).toContain('if (current !== null && current.status === "not_found") {');
  });
});

// ---------------------------------------------------------------------------
// ② 接线契约：源码级"到底连没连"
// ---------------------------------------------------------------------------

describe("U2 5.4 单侧视图接线契约（源码级）", () => {
  it("可读侧判据只看 text，且只在**进不了 diff** 时启用单侧视图", () => {
    expect(SRC).toContain('const readableSide: "left" | "right" | null =');
    expect(SRC).toContain("readableSide === null || diffEligibility.ok ? null : (");
  });

  it("单侧视图**两个早返回分支都挂载**（不是只挂一个）", () => {
    const hits = SRC.split("{singleSideView}").length - 1;
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it("单侧视图是**只读** code editor：readOnly + 独立锚点 + 接实例", () => {
    const block = SRC.slice(SRC.indexOf("const singleSideView ="));
    const end = block.indexOf("// 不可比较：只呈现状态");
    const view = block.slice(0, end);
    expect(view).toContain('data-testid="single-side-editor"');
    expect(view).not.toContain('data-testid="diff-editor"');
    expect(view).toContain("readOnly: true");
    expect(view).toContain("onMount={onSingleSideMount}");
    expect(view).toContain('value={(readableSide === "left" ? sides.left : sides.right) ?? ""}');
  });

  it("实例真的被接住，查找才能作用在**当前活动编辑器**上（否则按钮空转）", () => {
    expect(SRC).toContain("const singleEditorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor");
    expect(SRC).toContain("singleEditorRef.current = editor;");
    expect(SRC).toContain(
      "const editor = diffEditorRef.current?.getModifiedEditor() ?? singleEditorRef.current ?? null;",
    );
  });

  it("工具判据传的是**编辑器就绪**（diff 或单侧视图），不是 diffEligible", () => {
    expect(SRC).toContain("editorReady: diffEligibility.ok || readableSide !== null,");
    expect(SRC).not.toContain("find: anyReady && diffEligible");
  });

  it("两侧状态行由**同一** noteText 供给两个分支（不各写一份、不各说各话）", () => {
    const hits = SRC.split("noteText(sides.leftNote, initialFailed, loadingInitial)").length - 1;
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(SRC).not.toContain("初始与所选检查点在两侧都没有可显示的内容");
  });
});
