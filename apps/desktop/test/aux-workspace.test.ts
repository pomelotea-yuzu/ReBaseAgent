import { describe, expect, it } from "vitest";
import {
  type ExperimentTarget,
  type MessagesTarget,
  auxFilePatchOfLocation,
  auxReadingPatchOfLocation,
  decideAuxEntry,
  decideAuxReturn,
  sameExperimentTarget,
  sameMessagesTarget,
} from "../src/renderer/src/lib/aux-workspace";
import type { ReadingLocationSnapshot } from "../src/renderer/src/lib/create-workspace";

/** 静态渲染无关的纯判据测试（无 jsdom，不打 store） */

function snapshot(
  view: ReadingLocationSnapshot["view"],
  runId: string | null = "r_parent",
): ReadingLocationSnapshot {
  return {
    view,
    selectedRunId: runId,
    reading:
      view === "trace" && runId !== null
        ? ({ tab: "overview", spanId: "s_01" } as ReadingLocationSnapshot["reading"])
        : null,
  };
}

describe("U8 1.2：辅助工作区来源引用（decideAuxEntry）", () => {
  it("已在同页（含设置往返——视图没变）⇒ keep，不覆盖原来源", () => {
    for (const view of ["recording", "experiment", "messages"] as const) {
      expect(decideAuxEntry(view, snapshot(view))).toEqual({
        kind: "keep",
        reason: "already-on-page",
      });
    }
  });

  it("从轨迹视图进入 ⇒ 捕获，阅读位置照记（复用创建页捕获判据）", () => {
    const d = decideAuxEntry("recording", snapshot("trace"));
    expect(d).toEqual({
      kind: "capture",
      location: { view: "trace", runId: "r_parent", tab: "overview", spanId: "s_01", file: null },
    });
  });

  it("从分支树/比较进入 ⇒ 捕获但不记运行阅读位置（同创建页口径）", () => {
    for (const v of ["tree", "compare"] as const) {
      const d = decideAuxEntry("experiment", snapshot(v));
      expect(d).toEqual({
        kind: "capture",
        location: { view: v, runId: null, tab: null, spanId: null, file: null },
      });
    }
  });

  it("从另一个辅助工作区进入（messages 缺凭据转录制）⇒ 捕获只记视图，不记运行阅读位置", () => {
    expect(decideAuxEntry("recording", snapshot("messages"))).toEqual({
      kind: "capture",
      location: { view: "messages", runId: null, tab: null, spanId: null, file: null },
    });
    expect(decideAuxEntry("messages", snapshot("recording"))).toEqual({
      kind: "capture",
      location: { view: "recording", runId: null, tab: null, spanId: null, file: null },
    });
    expect(decideAuxEntry("recording", snapshot("experiment"))).toEqual({
      kind: "capture",
      location: { view: "experiment", runId: null, tab: null, spanId: null, file: null },
    });
  });

  it("轨迹视图但无选中运行 ⇒ runId 记 null（空态进入也留来源）", () => {
    const d = decideAuxEntry("experiment", snapshot("trace", null));
    expect(d).toEqual({
      kind: "capture",
      location: { view: "trace", runId: null, tab: null, spanId: null, file: null },
    });
  });
});

describe("U8 1.2：目标身份（不跟随侧栏选择的结构基础）", () => {
  const t1: ExperimentTarget = { runId: "r1", spanId: "s1" };
  const t2: ExperimentTarget = { runId: "r1", spanId: "s1" };
  const t3: ExperimentTarget = { runId: "r1", spanId: "s_other" };
  const t4: ExperimentTarget = { runId: "r_other", spanId: "s1" };

  it("两段身份逐项一致才算同一目标", () => {
    expect(sameExperimentTarget(t1, t2)).toBe(true);
    expect(sameExperimentTarget(t1, t3)).toBe(false);
    expect(sameExperimentTarget(t1, t4)).toBe(false);
  });

  it("messages 目标同口径", () => {
    const m1: MessagesTarget = { runId: "p1", spanId: "c1" };
    expect(sameMessagesTarget(m1, { runId: "p1", spanId: "c1" })).toBe(true);
    expect(sameMessagesTarget(m1, { runId: "p1", spanId: "c2" })).toBe(false);
    expect(sameMessagesTarget(m1, { runId: "p2", spanId: "c1" })).toBe(false);
  });
});

describe("U8 1.2：返回来源（decideAuxReturn）", () => {
  const known = ["r_parent", "r_child"];

  it("没记过来源（重载后）⇒ fallback no-location，回轨迹视图", () => {
    expect(decideAuxReturn({ location: null, knownRunIds: known })).toEqual({
      kind: "fallback",
      view: "trace",
      reason: "no-location",
    });
  });

  it("trace 来源且运行还在 ⇒ 原样恢复（含页签/调用）", () => {
    const loc = {
      view: "trace" as const,
      runId: "r_child",
      tab: "overview" as const,
      spanId: "s_02",
      file: null,
    };
    expect(decideAuxReturn({ location: loc, knownRunIds: known })).toEqual({
      kind: "restore",
      location: loc,
    });
  });

  it("来源运行已不在列表 ⇒ fallback run-missing（不伪造旧位置）", () => {
    const loc = { view: "trace" as const, runId: "r_gone", tab: null, spanId: null, file: null };
    expect(decideAuxReturn({ location: loc, knownRunIds: known })).toEqual({
      kind: "fallback",
      view: "trace",
      reason: "run-missing",
    });
  });

  it("创建页来源 ⇒ 只恢复视图（不查运行事实；草稿/目录引用由 store 原样持有）", () => {
    const loc = { view: "create" as const, runId: null, tab: null, spanId: null, file: null };
    expect(decideAuxReturn({ location: loc, knownRunIds: [] })).toEqual({
      kind: "restore",
      location: loc,
    });
  });

  it("辅助页来源（messages→录制→返回）⇒ 恢复到该页", () => {
    const loc = { view: "messages" as const, runId: null, tab: null, spanId: null, file: null };
    expect(decideAuxReturn({ location: loc, knownRunIds: known })).toEqual({
      kind: "restore",
      location: loc,
    });
  });
});

describe("U8 1.2：来源位置回写片段", () => {
  it("文件页来源 ⇒ 补 checkpoint/path；非文件页 ⇒ 不补", () => {
    expect(
      auxFilePatchOfLocation({
        view: "trace",
        runId: "r1",
        tab: "files",
        spanId: null,
        file: { checkpoint: "c1", path: "a.txt" },
      }),
    ).toEqual({ checkpoint: "c1", path: "a.txt" });
    expect(
      auxFilePatchOfLocation({
        view: "trace",
        runId: "r1",
        tab: "overview",
        spanId: null,
        file: null,
      }),
    ).toBeNull();
  });

  it("阅读定位片段：有页签才回写；创建页/辅助页来源（无页签）为空对象", () => {
    expect(
      auxReadingPatchOfLocation({
        view: "trace",
        runId: "r1",
        tab: "calls",
        spanId: "s9",
        file: null,
      }),
    ).toEqual({
      tab: "calls",
      spanId: "s9",
    });
    expect(
      auxReadingPatchOfLocation({
        view: "recording",
        runId: null,
        tab: null,
        spanId: null,
        file: null,
      }),
    ).toEqual({});
  });
});
