import { describe, expect, it } from "vitest";
import {
  defaultReadingState,
  fileReadingOf,
  patchFileReading,
  patchReadingState,
  readingStateOf,
} from "../src/renderer/src/lib/reading-state";

/**
 * U2 任务 2.1：文件阅读状态扩展 U1 会话模型。
 *
 * 对应 delta「文件阅读在会话内按运行恢复并校验定位」：
 * - 状态**独立于文件组件挂载**（本层纯函数，不依赖组件生命周期）
 * - 按 run 隔离（同名 step/path 不串）
 * - **不存**文件事实/草稿/授权/凭据/物理路径
 *
 * ⚠️ 与 7.1 的崩溃教训同源：默认值必须是**共享稳定引用**（逐次 new 会让
 *    zustand v5 的 getSnapshot 引用不稳 ⇒ 无限重渲）。
 */

describe("U2 文件阅读状态：默认值与引用稳定", () => {
  it("未初始化 run 的 files 缺省，fileReadingOf 返回**同一引用**（不逐次 new）", () => {
    const a = defaultReadingState();
    const b = defaultReadingState();
    // 默认状态自身必须是同一引用，否则选择器每次返回新对象
    expect(a).toBe(b);
    expect(fileReadingOf(a)).toBe(fileReadingOf(b));
  });

  it("fileReadingOf 缺省：初始检查点、列表态、auto 筛选、auto diff、开换行", () => {
    const files = fileReadingOf(defaultReadingState());
    expect(files.checkpoint).toBeNull();
    expect(files.path).toBeNull();
    expect(files.pane).toBe("list");
    expect(files.filter).toBe("auto");
    expect(files.diffPreference).toBe("auto");
    expect(files.wordWrap).toBe(true);
    expect(files.directoryWidth).toBe(232);
    expect(files.directoryCollapsed).toBe(false);
  });

  it("`files === undefined`（未进过文件页）与 `checkpoint === null`（停在初始）可分", () => {
    const untouched = defaultReadingState();
    expect(untouched.files).toBeUndefined();

    const visited = patchFileReading({}, "run_a", { checkpoint: null });
    expect(visited.run_a?.files).toBeDefined();
    expect(fileReadingOf(visited.run_a ?? defaultReadingState()).checkpoint).toBeNull();
  });
});

describe("U2 文件阅读状态：不可变 patch 与按 run 隔离", () => {
  it("patchFileReading 只改目标 run，且不原地改默认常量", () => {
    const before = fileReadingOf(defaultReadingState());
    const byRun = patchFileReading({}, "run_a", { path: "src/a.ts", pane: "content" });

    expect(fileReadingOf(byRun.run_a ?? defaultReadingState()).path).toBe("src/a.ts");
    expect(fileReadingOf(byRun.run_a ?? defaultReadingState()).pane).toBe("content");
    // 默认常量未被污染（否则所有未初始化 run 一起变脏）
    expect(fileReadingOf(defaultReadingState()).path).toBeNull();
    expect(before).toBe(fileReadingOf(defaultReadingState()));
  });

  it("A/B 两个 run 的同名 step/path 各自独立，互不影响", () => {
    let byRun = patchFileReading({}, "run_a", { checkpoint: "s_1", path: "a.txt" });
    byRun = patchFileReading(byRun, "run_b", { checkpoint: "s_1", path: "a.txt" });

    byRun = patchFileReading(byRun, "run_a", { path: "changed-in-a.txt" });

    expect(fileReadingOf(byRun.run_a ?? defaultReadingState()).path).toBe("changed-in-a.txt");
    expect(fileReadingOf(byRun.run_b ?? defaultReadingState()).path).toBe("a.txt");
  });

  it("patch 里显式 undefined 视为不改该项（不把 pane 清掉）", () => {
    let byRun = patchFileReading({}, "run_a", { pane: "content" });
    byRun = patchFileReading(byRun, "run_a", { pane: undefined, path: "b.txt" });

    const files = fileReadingOf(byRun.run_a ?? defaultReadingState());
    expect(files.pane).toBe("content");
    expect(files.path).toBe("b.txt");
  });

  it("连续的 patchFileReading 不破坏同 run 的其它阅读状态（tab/spanId）", () => {
    const withTab = patchReadingState({}, "run_a", { tab: "files", spanId: "s_9" });
    const withFiles = patchFileReading(withTab, "run_a", { path: "x.txt" });

    const state = readingStateOf(withFiles, "run_a");
    expect(state.tab).toBe("files");
    expect(state.spanId).toBe("s_9");
    expect(fileReadingOf(state).path).toBe("x.txt");
  });

  it("字段集合收敛：只含阅读意图与位置，不含正文/草稿/授权/物理路径", () => {
    const keys = Object.keys(fileReadingOf(defaultReadingState()));
    // 白名单式断言：新增字段必须显式在此登记（防止把正文/授权悄悄塞进来）
    expect(new Set(keys)).toEqual(
      new Set([
        "checkpoint",
        "path",
        "pane",
        "query",
        "filter",
        "directoryWidth",
        "directoryCollapsed",
        "diffPreference",
        "wordWrap",
        "listScrollTop",
        // U2 任务 4.3：正文滚动锚点（行号 + 相对偏移 + 所属 step/path），
        // 不是正文副本 —— 只记"读到哪"，不记"读到什么"。
        "contentScroll",
      ]),
    );
    for (const forbidden of [
      "text",
      "content",
      "draft",
      "authorized",
      "blobPath",
      "physicalPath",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
