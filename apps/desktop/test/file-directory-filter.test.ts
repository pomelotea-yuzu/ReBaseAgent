import type { WorkspaceInspectFile, WorkspaceInspectResult } from "../src/shared/ipc";
import { describe, expect, it } from "vitest";

/**
 * U2 任务 3.4：文件目录的**路径搜索 + 变化筛选 + 空态派生**（纯逻辑层）。
 *
 * 对应 delta（requirement「文件目录支持真实变化筛选和路径查找」）：
 * -「路径搜索与变化筛选组合」：完整路径不区分大小写子串匹配，与筛选组合；变化只认
 *   清单/哈希派生，缺失或损坏**不**被标为删除或新增。
 * -「初始与完成检查点的默认筛选」：auto 在初始取 all、完成步骤取 changed；显式选择保留。
 * -「空清单无变化和无匹配可区分」：三态分开；未录制/读取失败不显示成上述空态。
 */

const {
  resolveChangeFilter,
  hasChange,
  filterFiles,
  deriveDirectoryEmptyReason,
  directoryEmptyMessage,
  directoryCounts,
} = await import("../src/renderer/src/lib/file-directory");

function file(
  path: string,
  change: WorkspaceInspectFile["change"],
  availability: WorkspaceInspectFile["availability"] = "ok",
): WorkspaceInspectFile {
  return {
    path,
    bytes: 10,
    sha256: "a".repeat(64),
    change,
    availability,
    unavailableReason: availability === "ok" ? null : "不可用",
  };
}

function inspect(files: WorkspaceInspectFile[]): WorkspaceInspectResult {
  return {
    runId: "run_a",
    stepSpanId: null,
    snapshotId: "b".repeat(64),
    ownerRunId: "run_a",
    localIteration: null,
    profile: "file-tools-v1",
    worldId: "run_a",
    origin: { kind: "import" },
    files,
    fileCount: files.length,
    totalBytes: files.length * 10,
    unavailableCount: files.filter((f) => f.availability !== "ok").length,
    initialSnapshotId: "b".repeat(64),
  };
}

describe("resolveChangeFilter —— auto 的分支落地", () => {
  it("auto + 初始检查点 ⇒ all", () => {
    expect(resolveChangeFilter("auto", true)).toBe("all");
  });
  it("auto + 完成步骤 ⇒ changed", () => {
    expect(resolveChangeFilter("auto", false)).toBe("changed");
  });
  it("显式 all/changed 不受检查点影响（用户偏好优先）", () => {
    expect(resolveChangeFilter("all", false)).toBe("all");
    expect(resolveChangeFilter("changed", true)).toBe("changed");
  });
});

describe("hasChange —— 只有 added/modified 算变化", () => {
  it.each([
    ["added", true],
    ["modified", true],
    ["unchanged", false],
    ["initial", false],
  ] as const)("%s ⇒ %s", (change, expected) => {
    expect(hasChange(file("a", change))).toBe(expected);
  });

  it("附件不可用**不**影响变化判定（缺失/损坏不被标为新增或删除）", () => {
    // 缺失的 unchanged 文件仍然是"无变化"，不是"删除"
    expect(hasChange(file("gone.txt", "unchanged", "missing"))).toBe(false);
    expect(hasChange(file("bad.txt", "modified", "corrupt"))).toBe(true);
  });
});

describe("filterFiles —— 路径子串（不区分大小写）+ 变化筛选组合", () => {
  const files = [
    file("src/Alpha.ts", "modified"),
    file("src/beta.ts", "unchanged"),
    file("README.md", "added"),
    file("docs/Guide.md", "unchanged", "missing"),
  ];

  it("空搜索 + all ⇒ 全量保序", () => {
    expect(filterFiles(files, "", "all").map((f) => f.path)).toEqual([
      "src/Alpha.ts",
      "src/beta.ts",
      "README.md",
      "docs/Guide.md",
    ]);
  });

  it("搜索对整个**路径**匹配（不只 basename），且不区分大小写", () => {
    expect(filterFiles(files, "alpha", "all").map((f) => f.path)).toEqual(["src/Alpha.ts"]);
    expect(filterFiles(files, "SRC/", "all").map((f) => f.path)).toEqual([
      "src/Alpha.ts",
      "src/beta.ts",
    ]);
    // "docs" 是目录名，能命中
    expect(filterFiles(files, "docs", "all").map((f) => f.path)).toEqual(["docs/Guide.md"]);
  });

  it("changed 只留 added/modified", () => {
    expect(filterFiles(files, "", "changed").map((f) => f.path)).toEqual([
      "src/Alpha.ts",
      "README.md",
    ]);
  });

  it("搜索 **与** 筛选组合（交集）", () => {
    expect(filterFiles(files, "src/", "changed").map((f) => f.path)).toEqual(["src/Alpha.ts"]);
    expect(filterFiles(files, "src/", "all").map((f) => f.path)).toEqual([
      "src/Alpha.ts",
      "src/beta.ts",
    ]);
  });

  it("搜索词两端空白被忽略", () => {
    expect(filterFiles(files, "  beta  ", "all").map((f) => f.path)).toEqual(["src/beta.ts"]);
  });
});

describe("deriveDirectoryEmptyReason —— 空清单/无变化/无匹配三态可分", () => {
  it("零文件清单 ⇒ empty-list", () => {
    expect(deriveDirectoryEmptyReason(inspect([]), "", "all")).toBe("empty-list");
  });

  it("有文件但相对初始无变化 + changed 筛选 ⇒ no-change", () => {
    const onlyUnchanged = inspect([file("a", "unchanged"), file("b", "initial")]);
    expect(deriveDirectoryEmptyReason(onlyUnchanged, "", "changed")).toBe("no-change");
  });

  it("搜索无匹配 ⇒ no-match（优先于 no-change 表达，因为有搜索词）", () => {
    const changed = inspect([file("a", "modified")]);
    expect(deriveDirectoryEmptyReason(changed, "zzz-not-here", "all")).toBe("no-match");
  });

  it("有可见结果 ⇒ none", () => {
    const changed = inspect([file("a", "modified")]);
    expect(deriveDirectoryEmptyReason(changed, "a", "all")).toBe("none");
  });

  it("三态消息各不相同（不混用同一句话）", () => {
    const msgs = new Set([
      directoryEmptyMessage("empty-list", { query: "", filter: "all" }),
      directoryEmptyMessage("no-change", { query: "", filter: "changed" }),
      directoryEmptyMessage("no-match", { query: "zzz", filter: "all" }),
    ]);
    expect(msgs.size).toBe(3);
  });
});

describe("directoryCounts —— 筛选计数与原始规模分开", () => {
  const files = [file("a.ts", "modified"), file("b.ts", "unchanged"), file("c.ts", "added")];

  it("未过滤时 visible === total 且 filtered 为 false", () => {
    const counts = directoryCounts(inspect(files), "", "all");
    expect(counts).toEqual({ total: 3, visible: 3, filtered: false });
  });

  it("被搜索/筛选后 visible < total 且 filtered 为 true（规模不冒充）", () => {
    const counts = directoryCounts(inspect(files), "a", "all");
    expect(counts.total).toBe(3);
    expect(counts.visible).toBe(1);
    expect(counts.filtered).toBe(true);
  });

  it("changed 筛选下 total 仍是完整清单规模", () => {
    const counts = directoryCounts(inspect(files), "", "changed");
    expect(counts.total).toBe(3);
    expect(counts.visible).toBe(2);
    expect(counts.filtered).toBe(true);
  });
});
