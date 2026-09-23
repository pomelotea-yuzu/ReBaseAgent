import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U2 任务 3.1 / 3.2：两侧读取状态真实 + 旧响应不覆盖新选择。
 *
 * 对应 delta（requirement「文件两侧读取状态真实且旧响应不覆盖新选择」）：
 * -「不可用侧不伪装为空差异」：两侧分别标出真实状态，可读侧完整展示，禁止把不可用侧置空 diff
 * -「两侧都不可读时没有伪空编辑器」：显示各侧具体状态，不展示假空文件或宣称无变化
 * -「新增文件与零字节文件不混同」：`not_found` 与 `bytes === 0` 各标其义
 * -「快速切换不串清单正文错误和加载」/「同对象重试与往返有请求代次」（时序部分在
 *   `reading-request-guard.test.ts` 用延迟 promise 覆盖）
 *
 * ⚠️ 本包无 jsdom ⇒ 本文件钉两层：
 *   ① **能力断言**：展示层能把"一侧读取失败 / 一侧加载中 / 两侧不可读"渲染成不同的文字；
 *   ② **接线契约**（source 级）：连接层**必须**用代次守卫、**不得**退回 `cancelled` 布尔、
 *      **不得**让 `FileContent` 自己去拉初始侧（那正是"未读=不存在"的根因）。
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

/** 组件源码（能力断言 + 接线契约共用） */
const SRC_BODY = readFileSync(
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
      fetchInitial: async () => null,
      ...overrides,
    } as never),
  );
}

// ---------------------------------------------------------------------------
// 能力断言：两侧各自真实状态
// ---------------------------------------------------------------------------

describe("U2 3.2 两侧独立状态（能力断言）", () => {
  it("所选侧可读、初始侧加载中 ⇒ 编辑器在，且标注初始侧「正在读取」（不称不存在）", () => {
    const html = renderBody({
      current: text("a.txt", "新内容"),
      initial: null,
      loadingInitial: true,
      selectedFailed: false,
    });
    expect(html).toContain('data-testid="diff-editor"');
    expect(html).toContain("（该侧正在读取）");
    expect(html).not.toContain("（该侧不存在）");
  });

  it("**初始侧通道失败** ⇒ 明说「读取失败，不是不存在」，且提示差异不可信", () => {
    const html = renderBody({
      current: text("a.txt", "新内容"),
      initial: null,
      initialFailed: true,
      initialError: { code: "READ_UNEXPECTED", message: "boom" },
    });
    expect(html).toContain("（该侧读取失败，不是不存在）");
    expect(html).toContain("差异");
    expect(html).toContain("不可信");
    expect(html).not.toContain("（该侧不存在）");
  });

  it("初始侧真实 not_found（新增文件）⇒ 标「该侧不存在」，**不**与失败/加载混用", () => {
    const html = renderBody({
      current: text("a.txt", "新内容"),
      initial: { status: "not_found", path: "a.txt", reason: "不在初始清单" },
    });
    expect(html).toContain("（该侧不存在）");
    expect(html).toContain("本 run 新增的文件");
  });

  it("**两侧都不可读** ⇒ 明说两侧各自状态，不渲染编辑器、不宣称无变化", () => {
    // 语义：两侧都拿到了**真实结果**，但都不是可展示文本（附件缺失/损坏）
    const html = renderBody({
      current: {
        status: "missing",
        path: "a.txt",
        bytes: 5,
        sha256: hex("f"),
        reason: "附件不存在",
      },
      initial: {
        status: "corrupt",
        path: "a.txt",
        bytes: 5,
        sha256: hex("0"),
        reason: "哈希不符",
      },
    });
    // 所选侧不可比较 ⇒ 早分支只呈现该侧真实状态，绝不渲染编辑器
    expect(html).not.toContain('data-testid="diff-editor"');
    expect(html).toContain("内容不可读");
    expect(html).toContain("附件缺失");
    expect(html).not.toContain("无变化");
  });

  it("**旧粗暴分支必须消失**：不得出现「两侧都没有内容 ⇒ 不渲染编辑器」的合并判据", () => {
    // 旧形态：!sides.hasContent 一刀切（把"未读/失败"和"确实不存在"混为一谈）
    expect(SRC_BODY).not.toContain("!sides.hasContent");
    expect(SRC_BODY).not.toContain("初始与所选检查点在两侧都没有可显示的内容");
  });

  it("一侧 hasContent 为假、但另一侧真实文本 ⇒ 仍进编辑器并分别标注（不整块吞掉）", () => {
    // 初始侧 corrupt（解析不出文本）+ 所选侧 text：comparability 只看所选侧 ⇒ 进编辑器
    const html = renderBody({
      current: text("a.txt", "新内容"),
      initial: { status: "corrupt", path: "a.txt", bytes: 5, sha256: hex("1"), reason: "x" },
    });
    expect(html).toContain('data-testid="diff-editor"');
    // 初始侧标注其真实状态（不可用），不整块说"两侧都没有内容"
    expect(html).toContain("该侧不可用");
    expect(html).not.toContain("两侧都没有内容");
  });

  it("两侧都**未读取完成**（初始侧加载中、所选侧尚无结果）⇒ 显示读取中，不渲染伪空编辑器", () => {
    const html = renderBody({
      current: null,
      initial: null,
      loadingInitial: true,
      loadingContent: false,
    });
    expect(html).not.toContain('data-testid="diff-editor"');
    expect(html).toContain("正在读取初始快照");
    expect(html).not.toContain("无变化");
  });

  it("所选侧二进制、初始侧文本 ⇒ 不进编辑器，只呈现二进制真实大小/哈希", () => {
    const html = renderBody({
      current: { status: "binary", path: "a.txt", bytes: 42, sha256: hex("d") },
      initial: text("a.txt", "旧内容"),
    });
    expect(html).not.toContain('data-testid="diff-editor"');
    expect(html).toContain("二进制文件");
    expect(html).toContain("原始大小 42 B");
  });

  it("所选侧读取失败 ⇒ 明说「不表示不存在」、可重试，不显示伪内容", () => {
    const html = renderBody({
      current: null,
      contentError: { code: "READ_SCHEMA_INVALID", message: "结构不对" },
      loadingContent: false,
    });
    expect(html).toContain("读取失败（READ_SCHEMA_INVALID）");
    expect(html).toContain("不表示该文件不存在");
    expect(html).toContain("可重试");
  });

  it("零字节真实空文件（text 空串、bytes 0）**可参与比较**，与 not_found 不同判", () => {
    const html = renderBody({
      current: { status: "text", path: "a.txt", bytes: 0, sha256: hex("e"), text: "" },
      initial: text("a.txt", "旧内容"),
    });
    // 进入编辑器（是真文件，不是"不存在"），且没有 not_found 提示
    expect(html).toContain('data-testid="diff-editor"');
    expect(html).not.toContain("该路径不在所选清单里");
  });
});

// ---------------------------------------------------------------------------
// 接线契约（source 级）
// ---------------------------------------------------------------------------

describe("U2 3.1 接线契约：代次守卫，不退回 cancelled 布尔", () => {
  const SRC = SRC_BODY;

  it("三个请求面各持一个 RequestGuard 实例", () => {
    expect(SRC).toContain("new RequestGuard()");
    expect(SRC).toContain("listGuardRef");
    expect(SRC).toContain("initialGuardRef");
    expect(SRC).toContain("selectedGuardRef");
  });

  it("清单与两侧都用 settleList / settleSide 收口（先过 accept 再写）", () => {
    expect(SRC).toContain("settleList(");
    expect(SRC).toContain("settleSide(");
  });

  it("**每个请求面**都把响应喂给 settle 收口，不得绕过守卫直接 set", () => {
    // 清单面：inspectWorkspace(...).then 内必须出现 settleList
    const listThen = SRC.slice(
      SRC.indexOf("void inspectWorkspace(request)"),
      SRC.indexOf("void inspectWorkspace(request)") + 900,
    );
    expect(listThen).toContain("settleList(");
    // 三处请求（清单 / 所选侧 / 初始侧）都各有 settle 调用
    expect(SRC.match(/settleList\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(SRC.match(/settleSide\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    // 不得存在"绕过守卫直接 setListState/setSelectedState/setInitialState(ok 结果)"的写点
    expect(SRC).not.toMatch(/setListState\(\{ kind: "ok"/);
    expect(SRC).not.toMatch(/setSelectedState\(\{ kind: "ok"/);
    expect(SRC).not.toMatch(/setInitialState\(\{ kind: "ok"/);
  });

  it("**旧的 cancelled 布尔必须消失**（挡不住同对象重试，是 3.1 的根因）", () => {
    expect(SRC).not.toContain("let cancelled = false");
    expect(SRC).not.toContain("if (cancelled) return");
  });

  it("**loading 不在 finally 里无条件清除**（旧收尾不得抹掉新 loading）", () => {
    expect(SRC).not.toMatch(/\.finally\(\s*\(\)\s*=>\s*\{[^}]*setLoading/);
  });

  it("**FileContent 不得自己拉初始侧**（未读=不存在的根因，须由连接层独立维持）", () => {
    // FileContent 函数体内不得出现 readWorkspaceFile / fetchInitial 的调用
    const fileContentStart = SRC.indexOf("function FileContent(");
    expect(fileContentStart).toBeGreaterThan(-1);
    const body = SRC.slice(fileContentStart);
    expect(body).not.toContain("useEffect(");
    expect(body).not.toContain("fetchInitial(null");
    expect(body).not.toContain("useState<WorkspaceReadFileResult");
  });

  it("两侧读取**互不为前置条件**：初始侧 effect 不依赖所选侧结果", () => {
    // 初始侧 effect 的依赖数组里不得出现 current（C 时代 current 是初始侧读取的前置）
    const start = SRC.indexOf('const token = guard.begin("initial"');
    const end = SRC.indexOf("}, [readWorkspaceFile, run.meta.id, effectivePath, initialKey]);");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const initialEffect = SRC.slice(start, end);
    expect(initialEffect).not.toContain("current");
    expect(initialEffect).not.toContain("selectedState");
  });

  it("结果层取值走 sideResult（failed 不冒充 not_found）", () => {
    expect(SRC).toContain("sideResult(selectedState)");
    expect(SRC).toContain("sideResult(initialState)");
  });
});
