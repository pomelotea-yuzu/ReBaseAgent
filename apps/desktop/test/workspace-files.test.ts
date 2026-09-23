import type { SpanLine } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  canCompareText,
  canEnterTextDiff,
  changeLabel,
  checkpointOriginNote,
  deriveCheckpointOptions,
  detectFileLanguage,
  inspectSummaryLine,
  resolveDiffSides,
} from "../src/renderer/src/lib/workspace-files";
import type { WorkspaceInspectResult, WorkspaceReadFileResult } from "../src/shared/ipc";

/**
 * C 任务 1.2：文件检查点选择与差异的**渲染层纯逻辑**。
 *
 * 本文件的核心是钉住本段最容易出错的一条纪律——**轮号不沿链累加**：
 * A 有 3 轮、子 B 本地第 1 轮再分叉出 C 时，B 的选择器必须写"本 run 第 1 轮结束"，
 * C 的起点来源必须指 B 第 1 轮；若按合并轨迹沿链累计会得出 4（错答案）。
 *
 * 以及两条"不得降级"的判据：缺失/损坏不得当空文本、祖先前缀不得进本 run 的选择器。
 */

/** 造一个 agent.step span（只填判据需要的字段） */
function step(id: string, n: number): SpanLine {
  return {
    id,
    parent: null,
    kind: "agent.step",
    n,
    timing: undefined,
  } as unknown as SpanLine;
}

function llm(id: string): SpanLine {
  return { id, parent: null, kind: "llm.call", timing: undefined } as unknown as SpanLine;
}

function inspectResult(patch: Partial<WorkspaceInspectResult> = {}): WorkspaceInspectResult {
  const hex = "a".repeat(64);
  return {
    runId: "run_b",
    stepSpanId: null,
    snapshotId: hex,
    ownerRunId: "run_b",
    localIteration: null,
    profile: "file-tools-v1",
    worldId: "run_b",
    origin: { kind: "import" },
    files: [],
    fileCount: 0,
    totalBytes: 0,
    unavailableCount: 0,
    initialSnapshotId: hex,
    ...patch,
  };
}

describe("deriveCheckpointOptions —— 只列本 run 自有步骤，轮号取所属 run 的 n", () => {
  it("初始状态恒在首位，且不是'第 0 轮结束'", () => {
    const run = { spans: [step("s_1", 1)], leafSpanIds: ["s_1"], meta: { workspace: {} } };
    const options = deriveCheckpointOptions(run);
    expect(options[0].stepSpanId).toBeNull();
    expect(options[0].localIteration).toBeNull();
    expect(options[0].label).toBe("本 run 初始状态");
    expect(options[0].label).not.toContain("轮");
  });

  it("轮号取 step **自己的** n，不是数组下标（变异验证：改用 index 必须红）", () => {
    // ⚠️ 刻意让 spans 顺序与 n 不一致，且 n 不从 1 连续——这样"用下标当轮号"与
    // "用 step.n 当轮号"会得出**不同**结果，判据才有牙（B 7.x 的教训：无牙判据等于没测）
    const run = {
      spans: [step("s_5", 5), step("s_9", 9)],
      leafSpanIds: ["s_5", "s_9"],
      meta: { workspace: {} },
    };
    const options = deriveCheckpointOptions(run);
    expect(options.map((o) => o.localIteration)).toEqual([null, 5, 9]);
    expect(options.map((o) => o.label)).toEqual([
      "本 run 初始状态",
      "本 run 第 5 轮结束",
      "本 run 第 9 轮结束",
    ]);
  });

  it("多轮按 n 升序，文案为'本 run 第 N 轮结束'", () => {
    const run = {
      spans: [step("s_2", 2), step("s_1", 1), llm("l_1"), step("s_3", 3)],
      leafSpanIds: ["s_1", "s_2", "s_3", "l_1"],
      meta: { workspace: {} },
    };
    const options = deriveCheckpointOptions(run);
    expect(options.map((o) => o.localIteration)).toEqual([null, 1, 2, 3]);
    expect(options.map((o) => o.label)).toEqual([
      "本 run 初始状态",
      "本 run 第 1 轮结束",
      "本 run 第 2 轮结束",
      "本 run 第 3 轮结束",
    ]);
  });

  it("祖先前缀的 step（不在 leafSpanIds 里）**不得**进选择器", () => {
    // 合并轨迹 = 父的前缀 + 本 run 自有段；只有自有段可作本 run 的文件检查点
    const run = {
      spans: [
        step("s_parent_1", 1),
        step("s_parent_2", 2),
        step("s_parent_3", 3),
        step("s_mine_1", 1),
      ],
      // 本 run 只有一轮，父的 3 轮是继承来的
      leafSpanIds: ["s_mine_1"],
      meta: { workspace: {} },
    };
    const options = deriveCheckpointOptions(run);
    expect(options.map((o) => o.stepSpanId)).toEqual([null, "s_mine_1"]);
    expect(options.map((o) => o.localIteration)).toEqual([null, 1]);
    // 绝不能出现"第 4 轮"这种沿链累加出来的错答案
    expect(options.some((o) => o.localIteration === 4)).toBe(false);
  });

  it("本轮无任何完成步骤（新 run / 未落盘）→ 只有初始状态，不伪造完成步骤", () => {
    const run = { spans: [llm("l_1")], leafSpanIds: ["l_1"], meta: { workspace: {} } };
    const options = deriveCheckpointOptions(run);
    expect(options).toHaveLength(1);
    expect(options[0].stepSpanId).toBeNull();
  });
});

describe("checkpointOriginNote —— 分支起点标父 run，不写成'本 run 第 N 轮'", () => {
  it("根 run：说明世界由源目录导入", () => {
    const note = checkpointOriginNote(inspectResult(), null);
    expect(note).toContain("独立文件世界");
    expect(note).toContain("源目录");
  });

  it("分支 run：来源指父 run 的第 1 轮（不是本 run 第 4 轮）", () => {
    const note = checkpointOriginNote(
      inspectResult({
        origin: { kind: "checkpoint", runId: "run_b", stepSpanId: "s_b1" },
      }),
      1,
    );
    expect(note).toContain("父运行 run_b 的第 1 轮检查点");
    // 关键否定断言：不得把父轮号写成本 run 的轮号
    expect(note).not.toContain("本 run 第 4 轮");
    expect(note).not.toContain("第 4 轮");
  });

  it("父轮号解析不出 → 只报 step，不猜轮号", () => {
    const note = checkpointOriginNote(
      inspectResult({
        origin: { kind: "checkpoint", runId: "run_b", stepSpanId: "s_b1" },
      }),
      null,
    );
    expect(note).toContain("轮号未能在轨迹中解析");
    expect(note).toContain("s_b1");
  });
});

describe("canCompareText —— 非 text 一律不进文本比较（不得伪空文件）", () => {
  const cases: Array<[string, WorkspaceReadFileResult, boolean]> = [
    [
      "文本可比较",
      { status: "text", path: "a.txt", bytes: 3, sha256: "a".repeat(64), text: "abc" },
      true,
    ],
    [
      "二进制不可比较",
      { status: "binary", path: "b.dat", bytes: 4, sha256: "a".repeat(64) },
      false,
    ],
    ["none 侧允许（表示缺席）", null as unknown as WorkspaceReadFileResult, true],
    [
      "缺失不可比较",
      { status: "missing", path: "a.txt", bytes: 3, sha256: "a".repeat(64), reason: "附件不存在" },
      false,
    ],
    [
      "损坏不可比较",
      { status: "corrupt", path: "a.txt", bytes: 3, sha256: "a".repeat(64), reason: "哈希不符" },
      false,
    ],
    ["清单外不可比较", { status: "not_found", path: "x.txt", reason: "清单内没有" }, false],
    ["被拒不可比较", { status: "rejected", code: "invalid_request", reason: "runId 非法" }, false],
  ];

  it.each(cases)("%s", (_label, side, expected) => {
    const result = canCompareText(side);
    expect(result.ok).toBe(expected);
    // 不可比较时必须给出可读原因（界面不能只有禁用按钮、没有解释）
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveDiffSides —— 缺席的一侧是 null（不是空串）", () => {
  const text = (value: string): WorkspaceReadFileResult => ({
    status: "text",
    path: "a.txt",
    bytes: value.length,
    sha256: "a".repeat(64),
    text: value,
  });

  it("两侧都有文本 → 直接用原文", () => {
    const sides = resolveDiffSides(text("old"), text("new"), {
      initial: "初始",
      selected: "本 run 第 2 轮结束",
    });
    expect(sides.left).toBe("old");
    expect(sides.right).toBe("new");
    expect(sides.hasContent).toBe(true);
  });

  it("一侧是新增（初始不存在）→ 该侧为 null 而非空串", () => {
    const sides = resolveDiffSides(null, text("brand new"), {
      initial: "初始",
      selected: "本 run 第 1 轮结束",
    });
    expect(sides.left).toBeNull();
    expect(sides.left).not.toBe("");
    expect(sides.right).toBe("brand new");
    expect(sides.hasContent).toBe(true);
  });

  it("一侧是缺失 → 该侧为 null（缺失不被当成空文本）", () => {
    const missing: WorkspaceReadFileResult = {
      status: "missing",
      path: "a.txt",
      bytes: 3,
      sha256: "a".repeat(64),
      reason: "附件不存在",
    };
    const sides = resolveDiffSides(missing, text("still here"), {
      initial: "初始",
      selected: "本 run 第 1 轮结束",
    });
    expect(sides.left).toBeNull();
  });

  it("两侧都缺席 → hasContent 为 false（界面据此不进编辑器）", () => {
    const sides = resolveDiffSides(null, null, { initial: "初始", selected: "第 1 轮" });
    expect(sides.hasContent).toBe(false);
  });

  it("U2 3.3：每侧带**缺席成因**（text / not_found / unavailable / unread 四态可分）", () => {
    const notFound: WorkspaceReadFileResult = { status: "not_found", path: "a.txt", reason: "x" };
    const binary: WorkspaceReadFileResult = {
      status: "binary",
      path: "a.txt",
      bytes: 3,
      sha256: "a".repeat(64),
    };
    const a = resolveDiffSides(text("old"), text("new"), { initial: "i", selected: "s" });
    expect([a.leftNote, a.rightNote]).toEqual(["text", "text"]);

    const b = resolveDiffSides(notFound, text("new"), { initial: "i", selected: "s" });
    expect(b.leftNote).toBe("not_found");

    const c = resolveDiffSides(binary, text("new"), { initial: "i", selected: "s" });
    expect(c.leftNote).toBe("unavailable");

    const d = resolveDiffSides(null, text("new"), { initial: "i", selected: "s" });
    expect(d.leftNote).toBe("unread");
  });
});

describe("canEnterTextDiff —— 只有「两侧 text」或「初始经校验 not_found + 所选 text」才进 diff（U2 3.3）", () => {
  const text = (value: string): WorkspaceReadFileResult => ({
    status: "text",
    path: "a.txt",
    bytes: value.length,
    sha256: "a".repeat(64),
    text: value,
  });
  const notFound = (): WorkspaceReadFileResult => ({
    status: "not_found",
    path: "a.txt",
    reason: "初始清单没有它",
  });
  const binary = (): WorkspaceReadFileResult => ({
    status: "binary",
    path: "a.txt",
    bytes: 3,
    sha256: "a".repeat(64),
  });
  const missing = (): WorkspaceReadFileResult => ({
    status: "missing",
    path: "a.txt",
    bytes: 3,
    sha256: "a".repeat(64),
    reason: "附件不存在",
  });

  const labels = { initial: "初始", selected: "所选" };

  it("两侧 text ⇒ 可进", () => {
    expect(canEnterTextDiff(resolveDiffSides(text("a"), text("b"), labels)).ok).toBe(true);
  });

  it("初始 not_found + 所选 text（新增文件）⇒ 可进（保留不存在标识）", () => {
    const sides = resolveDiffSides(notFound(), text("b"), labels);
    expect(canEnterTextDiff(sides).ok).toBe(true);
    expect(sides.leftNote).toBe("not_found");
  });

  it.each([
    ["初始 binary", () => resolveDiffSides(binary(), text("b"), labels)],
    ["所选 missing", () => resolveDiffSides(text("b"), missing(), labels)],
    ["初始未读（null）", () => resolveDiffSides(null, text("b"), labels)],
    ["两侧 not_found", () => resolveDiffSides(notFound(), notFound(), labels)],
  ])("%s ⇒ **不可**进，并给出原因（不置空侧）", (_label, build) => {
    const verdict = canEnterTextDiff(build());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it("所选 not_found + 初始 text ⇒ 不可进（所选侧不在清单，不该当空侧比较）", () => {
    // 所选侧 not_found 只在"所选检查点没有这条路径"时出现，语义上不是"新增"
    // 依据 delta：只有「初始 not_found + 所选 text」被明文允许
    const sides = resolveDiffSides(text("a"), notFound(), labels);
    // not_found + not_found 被拒；text + not_found 也应在真实实现里被拒吗？
    // 明文只放行「初始 not_found」，故所选 not_found 应被拒
    expect(canEnterTextDiff(sides).ok).toBe(false);
  });
});

describe("展示层小工具", () => {
  it("changeLabel 四态各有中文标签", () => {
    expect(changeLabel("added")).toBe("新增");
    expect(changeLabel("modified")).toBe("修改");
    expect(changeLabel("unchanged")).toBe("未变");
    expect(changeLabel("initial")).toBe("初始");
  });

  it("inspectSummaryLine 在有不可用附件时显式提示，没有时不加噪声", () => {
    expect(inspectSummaryLine(inspectResult({ fileCount: 3, totalBytes: 100 }))).toBe(
      "3 个文件 / 100 B",
    );
    expect(
      inspectSummaryLine(inspectResult({ fileCount: 3, totalBytes: 100, unavailableCount: 2 })),
    ).toContain("2 个附件不可用");
  });

  it("detectFileLanguage：可解析为 JSON 用 json，否则纯文本；null 退化为纯文本", () => {
    expect(detectFileLanguage('{"a":1}')).toBe("json");
    expect(detectFileLanguage("hello")).toBe("plaintext");
    expect(detectFileLanguage(null)).toBe("plaintext");
  });
});
