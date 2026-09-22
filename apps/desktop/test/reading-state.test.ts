import { describe, expect, it } from "vitest";
import type { ReadingStateByRun } from "../src/renderer/src/lib/reading-state";
import {
  defaultReadingState,
  patchCallReading,
  patchReadingState,
  readingStateOf,
  reconcileReadingState,
} from "../src/renderer/src/lib/reading-state";

/**
 * U1（refactor-run-workspace）任务 3.1：按运行恢复阅读位置的**纯逻辑**。
 *
 * 判据来源：desktop-ui delta「会话内按运行恢复阅读位置」：
 *   - 跨运行返回恢复阅读
 *   - 阅读恢复不保存授权或草稿
 *   - 不同 run 中相同 span ID 不串状态
 *
 * ⚠️ 本文件测的是纯逻辑层；store 接线（selectRun 恢复、selectSpan 同步）在 store 用例覆盖。
 */

describe("默认阅读状态与首次访问", () => {
  it("默认页签为概览，未选 span（design D1：首次进入概览）", () => {
    const state = defaultReadingState();
    expect(state.tab).toBe("overview");
    expect(state.spanId).toBeNull();
    expect(state.expandedSteps).toEqual({});
    expect(state.calls).toEqual({});
    expect(state.overviewScrollTop).toBe(0);
    expect(state.stepsScrollTop).toBe(0);
  });

  it("读取不存在的 run ⇒ 默认值，且不改动入参", () => {
    const byRun: ReadingStateByRun = {};
    const state = readingStateOf(byRun, "run_x");
    expect(state).toEqual(defaultReadingState());
    expect(byRun).toEqual({}); // 未被写入
  });

  it("默认阅读状态**引用稳定**（7.1 崩溃回归：zustand getSnapshot 要求快照引用不变）", () => {
    // 逐次 new 会让 useAppStore((s)=>s.readingOf(run).overviewExpanded) 在未初始化 run 上
    // 每次返回新数组 ⇒ 无限重渲（Maximum update depth exceeded）。默认值必须是共享稳定实例。
    expect(defaultReadingState()).toBe(defaultReadingState());
    const byRun: ReadingStateByRun = {};
    expect(readingStateOf(byRun, "run_a")).toBe(readingStateOf(byRun, "run_a"));
    expect(readingStateOf(byRun, "run_b")).toBe(readingStateOf(byRun, "run_b"));
    expect(readingStateOf(byRun, "run_a").overviewExpanded).toBe(
      defaultReadingState().overviewExpanded,
    );
    // 已初始化 run 走 store 里 immutable 的对象（引用由 patch 新建，稳定）
    byRun.run_c = { ...defaultReadingState(), tab: "steps" };
    expect(readingStateOf(byRun, "run_c").overviewExpanded).toBe(byRun.run_c.overviewExpanded);
    byRun.run_c = { ...byRun.run_c, overviewExpanded: ["k"] };
    expect(readingStateOf(byRun, "run_c").overviewExpanded).toEqual(["k"]);
  });
});

describe("按 run 隔离：相同 span ID 不串状态（关键反例）", () => {
  it("A/B 两个 run 记录同名 span 的不同阅读状态，互不影响", () => {
    let byRun: ReadingStateByRun = {};
    // A 选中 s_01、B 选中 s_02；两条 run 都存在名为 s_01 的 span
    byRun = patchReadingState(byRun, "run_a", { tab: "steps", spanId: "s_01" });
    byRun = patchReadingState(byRun, "run_b", { tab: "files", spanId: "s_02" });

    expect(readingStateOf(byRun, "run_a").spanId).toBe("s_01");
    expect(readingStateOf(byRun, "run_a").tab).toBe("steps");
    expect(readingStateOf(byRun, "run_b").spanId).toBe("s_02");
    expect(readingStateOf(byRun, "run_b").tab).toBe("files");
  });

  it("同名 span 的调用分区状态也按 run 隔离", () => {
    let byRun: ReadingStateByRun = {};
    byRun = patchCallReading(byRun, "run_a", "s_01", { io: "input", scrollTop: 10 });
    byRun = patchCallReading(byRun, "run_b", "s_01", { io: "output", scrollTop: 99 });

    expect(readingStateOf(byRun, "run_a").calls.s_01).toEqual({ io: "input", scrollTop: 10 });
    expect(readingStateOf(byRun, "run_b").calls.s_01).toEqual({ io: "output", scrollTop: 99 });
  });
});

describe("不可变更新：不改原对象（zustand 依赖引用变化触发渲染）", () => {
  it("patchReadingState 返回新对象，原对象不变", () => {
    const before: ReadingStateByRun = { run_a: defaultReadingState() };
    const after = patchReadingState(before, "run_a", { tab: "steps" });
    expect(after).not.toBe(before);
    expect(after.run_a).not.toBe(before.run_a);
    expect(before.run_a?.tab).toBe("overview");
    expect(after.run_a?.tab).toBe("steps");
  });

  it("patchCallReading 只改目标调用的分区，其它键保持", () => {
    let byRun: ReadingStateByRun = {};
    byRun = patchCallReading(byRun, "run_a", "s_01", { io: "input" });
    byRun = patchCallReading(byRun, "run_a", "s_02", { io: "output" });
    byRun = patchCallReading(byRun, "run_a", "s_01", { scrollTop: 42 });

    expect(readingStateOf(byRun, "run_a").calls.s_01).toEqual({ io: "input", scrollTop: 42 });
    expect(readingStateOf(byRun, "run_a").calls.s_02).toEqual({ io: "output" });
  });

  it("合并式 patch：部分更新不丢已有字段", () => {
    let byRun: ReadingStateByRun = {};
    byRun = patchReadingState(byRun, "run_a", { tab: "steps", spanId: "s_01" });
    byRun = patchReadingState(byRun, "run_a", { overviewScrollTop: 120 });
    const state = readingStateOf(byRun, "run_a");
    expect(state.tab).toBe("steps"); // 未被第二次 patch 覆盖
    expect(state.spanId).toBe("s_01");
    expect(state.overviewScrollTop).toBe(120);
  });
});

describe("只存阅读位置：结构上不含授权/草稿/正文副本", () => {
  it("阅读状态字段集固定，不含授权/草稿类键", () => {
    const state = defaultReadingState();
    const keys = Object.keys(state).sort();
    expect(keys).toEqual(
      [
        "calls",
        "expandedSteps",
        "overviewExpanded",
        "overviewScrollTop",
        "spanId",
        "stepsScrollTop",
        "tab",
      ].sort(),
    );
    // 明确排除敏感/编辑态键
    for (const forbidden of [
      "draft",
      "authorization",
      "allowFileWrites",
      "sourceToken",
      "content",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("patch 透传的任意键也限于上述字段（类型层面无授权键可写）", () => {
    // 运行期验证：写入授权类字段不会成为阅读状态的一部分
    const byRun = patchReadingState({}, "run_a", { tab: "files" } as never);
    const state = readingStateOf(byRun, "run_a");
    expect(Object.keys(state).sort()).toEqual(
      [
        "calls",
        "expandedSteps",
        "overviewExpanded",
        "overviewScrollTop",
        "spanId",
        "stepsScrollTop",
        "tab",
      ].sort(),
    );
  });
});

describe("reconcileReadingState：失效阅读对象安全回退（任务 3.2 的校验部分）", () => {
  const detail = {
    spans: [{ id: "s_01" }, { id: "s_02" }, { id: "s_03" }],
    hasFiles: false,
  };

  it("全部有效 ⇒ 原样返回，不标记失效", () => {
    const state = {
      ...defaultReadingState(),
      tab: "steps" as const,
      spanId: "s_02",
      expandedSteps: { s_01: false },
      calls: { s_02: { io: "output" as const } },
    };
    const result = reconcileReadingState(state, detail);
    expect(result.invalidated).toBe(false);
    expect(result.state).toBe(state);
  });

  it("span 失效 ⇒ 清空选中并标记失效（不选另一个 run 的同 ID span）", () => {
    const state = { ...defaultReadingState(), tab: "steps" as const, spanId: "s_gone" };
    const result = reconcileReadingState(state, detail);
    expect(result.invalidated).toBe(true);
    expect(result.state.spanId).toBeNull();
  });

  it("展开项/调用分区中的失效 id 被清理，有效项保留", () => {
    const state = {
      ...defaultReadingState(),
      expandedSteps: { s_01: false, s_gone: true },
      calls: { s_02: { io: "input" as const }, s_gone: { io: "output" as const } },
    };
    const result = reconcileReadingState(state, detail);
    expect(result.invalidated).toBe(true);
    expect(result.state.expandedSteps).toEqual({ s_01: false });
    expect(Object.keys(result.state.calls)).toEqual(["s_02"]);
  });

  it("文件页签对非隔离 run 不再适用 ⇒ 回退概览", () => {
    const state = { ...defaultReadingState(), tab: "files" as const };
    const result = reconcileReadingState(state, detail); // hasFiles=false
    expect(result.invalidated).toBe(true);
    expect(result.state.tab).toBe("overview");
  });

  it("文件页签对隔离 run 仍适用（hasFiles=true 不误回退）", () => {
    const state = { ...defaultReadingState(), tab: "files" as const };
    const result = reconcileReadingState(state, { ...detail, hasFiles: true });
    expect(result.invalidated).toBe(false);
    expect(result.state.tab).toBe("files");
  });

  it("空 span 集合 ⇒ 已有选中全部失效并清空（不崩）", () => {
    const state = { ...defaultReadingState(), spanId: "s_01", expandedSteps: { s_01: true } };
    const result = reconcileReadingState(state, { spans: [], hasFiles: false });
    expect(result.invalidated).toBe(true);
    expect(result.state.spanId).toBeNull();
    expect(result.state.expandedSteps).toEqual({});
  });
});
