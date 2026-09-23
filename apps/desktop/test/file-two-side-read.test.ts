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
// 能力断言：两侧各自真实状态
// ---------------------------------------------------------------------------

describe("U2 3.2 两侧独立状态（能力断言）", () => {
  it("所选侧可读、初始侧加载中 ⇒ **不进** diff，并标初始侧「正在读取」（不称不存在）", () => {
    const html = renderBody({
      current: text("a.txt", "新内容"),
      initial: null,
      loadingInitial: true,
      selectedFailed: false,
    });
    expect(html).not.toContain('data-testid="diff-editor"');
    expect(html).toContain("不进入文本差异");
    expect(html).toContain("初始快照侧：正在读取");
    expect(html).not.toContain("清单确认不存在");
  });

  it("**初始侧通道失败** ⇒ 明说「读取失败（不是不存在）」，且不置空侧参与 diff", () => {
    const html = renderBody({
      current: text("a.txt", "新内容"),
      initial: null,
      initialFailed: true,
    });
    expect(html).not.toContain('data-testid="diff-editor"');
    expect(html).toContain("初始快照侧：读取失败（不是不存在）");
    expect(html).toContain("不会把不可用或未读取的一侧置空参与 diff");
    expect(html).not.toContain("清单确认不存在");
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
    // 改为显式资格判定 canEnterTextDiff（U2 3.3）
    expect(SRC_BODY).toContain("canEnterTextDiff(");
  });

  it("一侧不可比较、另一侧真实文本 ⇒ **不进** diff 并标出该侧具体成因（不置空侧）", () => {
    // 初始侧 corrupt（不可比较）+ 所选侧 text：canEnterTextDiff 拒绝进入
    const html = renderBody({
      current: text("a.txt", "新内容"),
      initial: { status: "corrupt", path: "a.txt", bytes: 5, sha256: hex("1"), reason: "x" },
    });
    expect(html).not.toContain('data-testid="diff-editor"');
    expect(html).toContain("不进入文本差异");
    expect(html).toContain("内容不可比较（二进制 / 附件缺失 / 损坏）");
    // 明确不把不可用侧当空文本参与 diff
    expect(html).toContain("不会把不可用或未读取的一侧置空参与 diff");
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

  it("追加：初始经校验 not_found + 所选 text ⇒ **进** diff（新增文件的合法空侧，保留不存在标识）", () => {
    const html = renderBody({
      current: text("b.txt", "刚写入的新文件"),
      initial: { status: "not_found", path: "b.txt", reason: "初始清单没有它" },
    });
    // 合法进入（新增文件用空侧但保留"不存在"标识），不是把空侧当空文本
    expect(html).toContain('data-testid="diff-editor"');
    expect(html).toContain("（该侧不存在）");
    expect(html).toContain("本 run 新增的文件");
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
// U2 任务 3.3：独立重试与单侧可读
// ---------------------------------------------------------------------------

describe("U2 3.3 清单/内容独立重试（能力断言）", () => {
  it("清单失败 ⇒ 渲染「重新读取清单」重试按钮；未失败时不渲染", () => {
    const failedHtml = renderBody({
      inspect: null,
      inspectError: { code: "WORKSPACE_UNREADABLE", message: "读不到" },
      onRetryList: () => {},
    });
    expect(failedHtml).toContain("重新读取清单");

    const okHtml = renderBody({ onRetryList: () => {} });
    expect(okHtml).not.toContain("重新读取清单");
  });

  it("所选侧读取失败 ⇒ 渲染「重新读取该文件」；不失败时不渲染", () => {
    const failedHtml = renderBody({
      current: null,
      contentError: { code: "READ_UNEXPECTED", message: "boom" },
      onRetryContent: () => {},
    });
    expect(failedHtml).toContain("重新读取该文件");

    const okHtml = renderBody({
      current: text("a.txt", "新内容"),
      initial: text("a.txt", "旧内容"),
      onRetryContent: () => {},
    });
    expect(okHtml).not.toContain("重新读取该文件");
  });

  it("所选侧读取失败 ⇒ 两侧各自独立的重试入口（初始侧重试 + 本侧重试互不牵连）", () => {
    const html = renderBody({
      current: null,
      contentError: { code: "READ_UNEXPECTED", message: "boom" },
      onRetryContent: () => {},
      onRetryInitial: () => {},
    });
    // 所选侧自己的重试
    expect(html).toContain("重新读取该文件");
    expect(html).not.toContain('data-testid="diff-editor"');
  });

  it("初始侧未读取完成 + 所选侧可读 ⇒ 「不进入 diff」分支提供初始侧独立重试", () => {
    const html = renderBody({
      current: text("a.txt", "新内容"),
      initial: null,
      initialFailed: true,
      onRetryInitial: () => {},
      onRetryContent: () => {},
    });
    expect(html).toContain("不进入文本差异");
    expect(html).toContain("重新读取初始快照");
    // 所选侧未失败 ⇒ 不该出现"重新读取所选侧"
    expect(html).not.toContain("重新读取所选侧");
  });

  it("重试回调缺省时不渲染按钮（展示层无回调即不提供入口）", () => {
    const html = renderBody({
      inspect: null,
      inspectError: { code: "E", message: "m" },
    });
    expect(html).not.toContain("重新读取清单");
  });
});

// ---------------------------------------------------------------------------
// U2 任务 3.4：目录搜索 / 变化筛选 / 空态与计数（能力断言）
// ---------------------------------------------------------------------------

/** 一份含新增/修改/未变/不可用的清单 */
function mixedInspect(): Record<string, unknown> {
  const base = inspect();
  return {
    ...base,
    files: [
      {
        path: "src/Alpha.ts",
        bytes: 10,
        sha256: hex("b"),
        change: "modified",
        availability: "ok",
        unavailableReason: null,
      },
      {
        path: "src/beta.ts",
        bytes: 10,
        sha256: hex("c"),
        change: "unchanged",
        availability: "ok",
        unavailableReason: null,
      },
      {
        path: "README.md",
        bytes: 10,
        sha256: hex("d"),
        change: "added",
        availability: "ok",
        unavailableReason: null,
      },
      {
        path: "docs/Guide.md",
        bytes: 10,
        sha256: hex("e"),
        change: "unchanged",
        availability: "missing",
        unavailableReason: "没了",
      },
    ],
    fileCount: 4,
  };
}

describe("U2 3.4 目录搜索与变化筛选（能力断言）", () => {
  it("渲染搜索框与三个筛选按钮（自动/全部/有变化）", () => {
    const html = renderBody({ inspect: mixedInspect() });
    expect(html).toContain("按完整路径搜索");
    expect(html).toContain("自动");
    expect(html).toContain("全部");
    expect(html).toContain("有变化");
  });

  it("搜索词命中完整路径（含目录名）⇒ 只列匹配项", () => {
    const html = renderBody({ inspect: mixedInspect(), query: "src/" });
    expect(html).toContain("src/Alpha.ts");
    expect(html).toContain("src/beta.ts");
    expect(html).not.toContain("README.md");
  });

  it("变化筛选 changed ⇒ 只列 added/modified（缺失的 unchanged 不出现）", () => {
    const html = renderBody({ inspect: mixedInspect(), changeFilter: "changed" });
    expect(html).toContain("src/Alpha.ts");
    expect(html).toContain("README.md");
    expect(html).not.toContain("src/beta.ts");
    expect(html).not.toContain("docs/Guide.md");
  });

  it("筛选计数与原始规模**分开**显示（不冒充清单规模）", () => {
    const html = renderBody({ inspect: mixedInspect(), query: "src/" });
    expect(html).toContain("筛出 2 / 共 4");
    const all = renderBody({ inspect: mixedInspect() });
    expect(all).toContain("共 4 个");
  });

  it("空清单 ⇒ 空清单文案（不是无变化、不是无匹配）", () => {
    const html = renderBody({
      inspect: { ...inspect(), files: [], fileCount: 0, unavailableCount: 0 },
    });
    expect(html).toContain("为空清单");
    expect(html).not.toContain("没有路径匹配");
  });

  it("搜索无匹配 ⇒ 无匹配文案 + 清空搜索入口（不是无变化）", () => {
    const html = renderBody({ inspect: mixedInspect(), query: "zzz-nope", onQuery: () => {} });
    expect(html).toContain("没有路径匹配");
    expect(html).toContain("清空搜索");
    expect(html).not.toContain("相对本 run 初始没有变化");
  });

  it("changed 筛选无变化 ⇒ 无变化文案 + 查看全部入口（不是无匹配）", () => {
    const onlyUnchanged = {
      ...inspect(),
      files: [
        {
          path: "a.ts",
          bytes: 1,
          sha256: hex("b"),
          change: "unchanged",
          availability: "ok",
          unavailableReason: null,
        },
      ],
      fileCount: 1,
      unavailableCount: 0,
    };
    const html = renderBody({
      inspect: onlyUnchanged,
      changeFilter: "changed",
      onFilter: () => {},
    });
    expect(html).toContain("相对本 run 初始没有变化");
    expect(html).toContain("查看全部");
    expect(html).not.toContain("没有路径匹配");
  });

  it("筛选隐藏当前选择 ⇒ **保留**内容标题与阅读状态，并说明被筛选隐藏", () => {
    // 选中的是 beta.ts（unchanged），但 changed 筛选把它藏了——内容区仍应显示它
    const html = renderBody({
      inspect: mixedInspect(),
      selectedPath: "src/beta.ts",
      changeFilter: "changed",
      current: text("src/beta.ts", "内容仍在"),
      initial: text("src/beta.ts", "旧"),
    });
    // 内容区保留该文件标题与内容（不偷换选择）
    expect(html).toContain("src/beta.ts");
    expect(html).toContain('data-testid="diff-editor"');
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
    // biome 会把依赖数组折成多行，故只按"initialKey,"定位收尾
    const end = SRC.indexOf("initialKey,", start);
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

  it("**重试接线**：连接层必须把三个独立重试回调传给展示层（否则按钮永不出现）", () => {
    expect(SRC).toContain("onRetryList={() =>");
    expect(SRC).toContain("onRetryContent={() =>");
    expect(SRC).toContain("onRetryInitial={() =>");
    // 重试靠 nonce 变化重跑 effect（真的重新调 IPC，不是复用旧结果）
    expect(SRC).toContain("setListRetry(");
    expect(SRC).toContain("setSelectedRetry(");
    expect(SRC).toContain("setInitialRetry(");
  });

  it("**不得有任何写入通道**（阅读重试只读）：无 readFile 之外的 IPC、无 write/import/apply 调用", () => {
    // 组件只应调用 inspectWorkspace / readWorkspaceFile 两个只读动作
    const calls = SRC.match(/useAppStore\(\(s\) => s\.(\w+)\)/g) ?? [];
    const names = calls.map((c) => c.replace(/.*s\./, "").replace(/\)$/, ""));
    for (const name of names) {
      expect([
        "inspectWorkspace",
        "readWorkspaceFile",
        "fileReadingOf",
        "setFileReading",
      ]).toContain(name);
    }
  });
});

describe("U2 3.4 接线契约：搜索/筛选/空态/计数走纯派生层", () => {
  const SRC = SRC_BODY;

  it("三个派生全部来自 lib/file-directory（组件不自己 filter 一遍）", () => {
    expect(SRC).toContain("filterFiles(");
    expect(SRC).toContain("deriveDirectoryEmptyReason(");
    expect(SRC).toContain("directoryCounts(");
    // 不得在 Body 内自造过滤（例如直接 inspect.files.filter(…change===)）
    expect(SRC).not.toMatch(/inspect\.files\.filter\(/);
  });

  it("auto 落地走 resolveChangeFilter（连接层算好再传），而非组件内联三元", () => {
    expect(SRC).toContain("resolveChangeFilter(");
    // 连接层必须把解析后的 all|changed 传给展示层（不是把 auto 直接下传）
    expect(SRC).toContain("changeFilter={changeFilter}");
    // filterPreference 是"用户偏好原值"，与解析后的 changeFilter **分开**下传
    expect(SRC).toContain("filterPreference={saved.filter}");
  });

  it("筛选偏好写回会话状态（setFileReading({ filter })），不是组件局部 state", () => {
    expect(SRC).toContain("onFilter={(filter) => setFileReading(run.meta.id, { filter })}");
  });

  it("搜索词与筛选都接入展示层（缺一个按钮/输入就永不出现）", () => {
    expect(SRC).toContain("query={");
    expect(SRC).toContain("onQuery={");
    expect(SRC).toContain("按完整路径搜索");
    expect(SRC).toContain("查看全部");
    expect(SRC).toContain("清空搜索");
  });
});

// ---------------------------------------------------------------------------
// U2 任务 3.5：完整路径显示 / 隐藏选择恢复 / 计数分开（能力断言）
// ---------------------------------------------------------------------------

describe("U2 3.5 目录控件与隐藏选择恢复（能力断言）", () => {
  it("目录项显示**完整逻辑路径**（不是 basename）", () => {
    const html = renderBody({ inspect: mixedInspect(), changeFilter: "all" });
    expect(html).toContain("src/Alpha.ts");
    expect(html).toContain("docs/Guide.md");
  });

  it("**筛选隐藏当前选择** ⇒ 内容区保留该文件标题与阅读状态（不偷换）", () => {
    // 选中的 beta.ts 是 unchanged，changed 筛选把它藏了 —— 内容区仍显示它
    const html = renderBody({
      inspect: mixedInspect(),
      selectedPath: "src/beta.ts",
      changeFilter: "changed",
      current: text("src/beta.ts", "内容仍在"),
      initial: text("src/beta.ts", "旧"),
    });
    expect(html).toContain("src/beta.ts");
    expect(html).toContain('data-testid="diff-editor"');
  });

  it("清单规模与筛选计数**分开**（受筛时显示「筛出 N / 共 M」）", () => {
    const html = renderBody({ inspect: mixedInspect(), query: "src/", changeFilter: "all" });
    expect(html).toContain("筛出 2 / 共 4");
    const all = renderBody({ inspect: mixedInspect(), changeFilter: "all" });
    expect(all).toContain("共 4 个");
  });

  it("切检查点后仍存在的路径**保留**（不清空选择）", () => {
    // 保存的 path 在新清单里仍存在 ⇒ selectedPath 原样传入，内容区照常渲染
    const html = renderBody({
      inspect: mixedInspect(),
      selectedPath: "README.md",
      current: text("README.md", "内容"),
      initial: { status: "not_found", path: "README.md", reason: "新增" },
    });
    expect(html).toContain("README.md");
    expect(html).toContain('data-testid="diff-editor"');
  });
});

// ---------------------------------------------------------------------------
// U2 第4组：容器布局 / 编辑器 / 阅读工具（能力断言）
// ---------------------------------------------------------------------------

describe("U2 第4组 容器布局与阅读工具（能力断言）", () => {
  it("工具栏提供复制路径/两侧原文/换行/差异导航/模式（只读，无编辑入口）", () => {
    const html = renderBody({
      inspect: mixedInspect(),
      selectedPath: "src/Alpha.ts",
      current: text("src/Alpha.ts", "新"),
      initial: text("src/Alpha.ts", "旧"),
    });
    expect(html).toContain("复制路径");
    expect(html).toContain("复制左侧原文");
    expect(html).toContain("复制右侧原文");
    expect(html).toContain("换行：");
    expect(html).toContain("上一差异");
    expect(html).toContain("下一差异");
    // 只读：绝无编辑/替换/回写/应用补丁/导出入口
    expect(html).not.toContain("应用补丁");
    expect(html).not.toContain("替换全部");
    expect(html).not.toContain("导出");
  });

  it("不可比较时工具**诚实禁用**（按条件禁用并有说明）", () => {
    const html = renderBody({
      inspect: mixedInspect(),
      selectedPath: "docs/Guide.md",
      current: { status: "missing", path: "docs/Guide.md", bytes: 10, sha256: hex("e") },
      initial: text("docs/Guide.md", "旧"),
    });
    // 二进制/不可用 ⇒ 显示不可比较状态，且复制原文按钮禁用
    expect(html).toContain("内容不可读");
    expect(html).toMatch(/disabled/);
  });

  it("复制元信息按钮在**不可用侧**出现（复制真实大小/哈希）", () => {
    const html = renderBody({
      inspect: mixedInspect(),
      selectedPath: "docs/Guide.md",
      current: { status: "binary", path: "docs/Guide.md", bytes: 777, sha256: hex("f") },
      initial: text("docs/Guide.md", "旧"),
    });
    expect(html).toContain("复制元信息");
    expect(html).toContain("二进制文件");
  });

  it("编辑器高度不再锁死 420px（弹性高度）", () => {
    const html = renderBody({
      inspect: mixedInspect(),
      selectedPath: "src/Alpha.ts",
      current: text("src/Alpha.ts", "新"),
      initial: text("src/Alpha.ts", "旧"),
    });
    expect(html).not.toContain("420px");
  });

  it("模式控件按偏好显示（自动/inline/并排）", () => {
    const html = renderBody({
      inspect: mixedInspect(),
      selectedPath: "src/Alpha.ts",
      current: text("src/Alpha.ts", "新"),
      initial: text("src/Alpha.ts", "旧"),
      diffPreference: "sideBySide",
    });
    expect(html).toContain("模式：并排");
  });
});

// ---------------------------------------------------------------------------
// U2 第4组 接线契约：布局判据走纯层 + 偏好全部接入会话状态
// ---------------------------------------------------------------------------

describe("U2 第4组 接线契约：容器测量与布局判据", () => {
  const SRC = SRC_BODY;

  it("容器宽度由 ResizeObserver 实测（不是窗口断点），并驱动布局判据", () => {
    expect(SRC).toContain("useContainerWidth");
    expect(SRC).toContain("decideDirResident(");
    expect(SRC).toContain("decideDiffMode(");
    expect(SRC).toContain("resolveFilePaneVisibility(");
    // 不得用 window.innerWidth / matchMedia 之类的窗口断点判宽
    expect(SRC).not.toContain("window.innerWidth");
    expect(SRC).not.toContain("matchMedia");
  });

  it("目录宽/收起/diff 偏好/换行/滚动**全部**读写会话状态（不是组件局部 state）", () => {
    expect(SRC).toContain("onDirWidth={");
    expect(SRC).toContain("onDirCollapsed={");
    expect(SRC).toContain("onDiffPreference={");
    expect(SRC).toContain("onWordWrap={");
    expect(SRC).toContain("onListScrollTop={");
    expect(SRC).toContain("setFileReading(run.meta.id, { directoryWidth:");
    expect(SRC).toContain("setFileReading(run.meta.id, { diffPreference }");
    expect(SRC).toContain("setFileReading(run.meta.id, { wordWrap }");
  });

  it("**自动降级不写回偏好**：布局决策只读 prefs，不出现写回 dirWidth/diffPreference 的自动分支", () => {
    expect(SRC).toContain("preserveFilePrefs(");
    // 布局的自动结论（dirResident / mode）不得被 set 回 store
    expect(SRC).not.toMatch(/setFileReading\([^)]*\{\s*directoryWidth:\s*dirWidth\s*\}/);
  });

  it("字体 ≥13px（不靠缩字号达标），换行开关接入 Monaco", () => {
    expect(SRC).toContain("fontSize: 13");
    expect(SRC).toMatch(/wordWrap:\s*wordWrap\s*\?\s*"on"\s*:\s*"off"/);
  });

  it("复制走剪贴板并在失败时就近提示（不假报成功）", () => {
    expect(SRC).toContain("clipboard.writeText(");
    expect(SRC).toContain("copyFeedback");
  });
});

// ---------------------------------------------------------------------------
// U2 任务 4.1 接线契约：目录宽**真的可调**（拖拽 + 键盘）
// ---------------------------------------------------------------------------
//
// 背景：`stepFileDirWidth` / `clampRestoredDirWidth` 曾有单测但**零 UI 消费**
// （死导入）——纯逻辑绿、功能却不存在。下面的契约专钉这一点。

describe("U2 4.1 接线契约：目录宽可调整（拖拽 + 键盘）", () => {
  const SRC = SRC_BODY;

  it("纯逻辑 `stepFileDirWidth` / `clampRestoredDirWidth` 真的被组件消费（不是死导入）", () => {
    expect(SRC).toContain("stepFileDirWidth(");
    expect(SRC).toContain("clampRestoredDirWidth(");
  });

  it("存在可聚焦的分隔条，且键盘 ArrowLeft/Right 走 `stepFileDirWidth` 写回会话状态", () => {
    expect(SRC).toContain('role="separator"');
    expect(SRC).toContain("onResizerKeyDown");
    // 必须真的把处理器接到分隔条上（只写函数不接线 = 键盘调整失效）
    expect(SRC).toContain("onKeyDown={onResizerKeyDown}");
    expect(SRC).toContain("tabIndex={0}");
    expect(SRC).toContain("onDirWidth?.(next)");
  });

  it("拖拽（pointerdown/move/up）经 `clampRestoredDirWidth` 夹取后写回", () => {
    expect(SRC).toContain("onPointerDown={onResizerPointerDown}");
    expect(SRC).toContain("onPointerMove={onResizerPointerMove}");
    expect(SRC).toContain("onPointerUp={onResizerPointerUp}");
  });
});

// ---------------------------------------------------------------------------
// U2 任务 4.5 接线契约：真实差异导航 + 查找（钉死"死按钮"复发）
// ---------------------------------------------------------------------------
//
// 背景：此前「上一/下一差异」是**无 onClick 的死按钮**、查找入口**根本不存在**、
// `diffCount` 被写死为 1；测试只做字符串存在性 ⇒ 缺陷溜过。以下契约钉**接线**。

describe("U2 4.5 接线契约：差异导航与查找必须接线", () => {
  const SRC = SRC_BODY;

  it("差异导航按钮有真实 onClick，调用 Monaco 的 `goToDiff`（不是装饰性按钮）", () => {
    expect(SRC).toContain("goToDiff(");
    expect(SRC).toContain('goToDiff("previous")');
    expect(SRC).toContain('goToDiff("next")');
    // 按钮必须接上处理器，不得再是"只有 disabled 没有 onClick"的死按钮
    expect(SRC).toContain("onClick={goPrevDiff}");
    expect(SRC).toContain("onClick={goNextDiff}");
  });

  it("查找入口存在且走 Monaco 内置查找（只读，不开放替换/写入）", () => {
    expect(SRC).toContain("actions.find");
    expect(SRC).toContain("openFind");
    expect(SRC).toContain("onClick={openFind}");
    // 只读边界：不得出现替换 / 写回入口
    expect(SRC).not.toContain("actions.replace");
    expect(SRC).not.toContain("editor.setValue");
    expect(SRC).not.toContain("executeEdits");
  });

  it("`diffCount` 来自 Monaco 真实 diff（`getLineChanges` + `onDidUpdateDiff`），不得写死", () => {
    expect(SRC).toContain("getLineChanges()");
    expect(SRC).toContain("onDidUpdateDiff(");
    // 反向断言：旧的写死形态必须消失
    expect(SRC).not.toContain("diffCount: diffEligibility.ok ? 1 : 0");
  });

  it("编辑器实例经 `onMount` 外抛（先决条件：没有它结构上无法接线）", () => {
    expect(SRC).toContain("onMount={onDiffMount}");
    expect(SRC).toContain("diffEditorRef");
  });
});

// ---------------------------------------------------------------------------
// U2 任务 4.6 接线契约：键盘导航与焦点
// ---------------------------------------------------------------------------

describe("U2 4.6 接线契约：文件列表键盘导航与焦点", () => {
  const SRC = SRC_BODY;

  it("文件列表处理方向键（ArrowUp/ArrowDown）与 Home/End", () => {
    expect(SRC).toContain("onKeyDown={onListKeyDown}");
    expect(SRC).toContain("moveSelection(");
    expect(SRC).toContain('"ArrowDown"');
    expect(SRC).toContain('"ArrowUp"');
  });

  it("列表有 listbox/option 语义与 roving tabindex（可聚焦、可被读屏）", () => {
    expect(SRC).toContain('role="listbox"');
    expect(SRC).toContain('role="option"');
    expect(SRC).toContain("aria-selected={active}");
    expect(SRC).toContain("tabIndex={active ? 0 : -1}");
  });

  it("选择后把焦点交回目标文件项（焦点恢复）", () => {
    expect(SRC).toContain("data-file-path={file.path}");
    expect(SRC).toContain(".focus()");
  });
});
