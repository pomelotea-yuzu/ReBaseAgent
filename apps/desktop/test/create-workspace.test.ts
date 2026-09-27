import { describe, expect, it } from "vitest";
import {
  decideCreateEntry,
  decideCreateReturn,
  filePatchOfLocation,
  liveSpanOfLocation,
  readingPatchOfLocation,
} from "../src/renderer/src/lib/create-workspace";
import type {
  CreateReturnLocation,
  ReadingLocationSnapshot,
} from "../src/renderer/src/lib/create-workspace";
import type { FileReadingState, RunReadingState } from "../src/renderer/src/lib/reading-state";
import { defaultReadingState, fileReadingOf } from "../src/renderer/src/lib/reading-state";

/**
 * U5（unify-run-execution-workflow）任务 4.1：**创建工作区来源位置引用**的纯判据。
 *
 * 判据来源：design D1 + delta「桌面端提供原生 run 创建入口」的场景
 * 「创建工作区任务优先且可返回来源」——来源引用只含阅读位置、只存 renderer 会话、
 * 与草稿生命周期互不决定；store 侧接线见 `create-workspace-store.test.ts`。
 */

function fileReading(overrides: Partial<FileReadingState> = {}): FileReadingState {
  return { ...fileReadingOf(defaultReadingState()), ...overrides };
}

function reading(overrides: Partial<RunReadingState> = {}): RunReadingState {
  return { ...defaultReadingState(), ...overrides };
}

function snapshot(overrides: Partial<ReadingLocationSnapshot> = {}): ReadingLocationSnapshot {
  return { view: "trace", selectedRunId: null, reading: null, ...overrides };
}

function location(overrides: Partial<CreateReturnLocation> = {}): CreateReturnLocation {
  return { view: "trace", runId: null, tab: null, spanId: null, file: null, ...overrides };
}

describe("4.1 进入创建：什么时候重记来源", () => {
  it("从轨迹步骤页的某次调用进入 ⇒ 记全运行 / 页签 / 调用", () => {
    const decision = decideCreateEntry(
      snapshot({ selectedRunId: "r_a", reading: reading({ tab: "steps", spanId: "s_03" }) }),
    );
    expect(decision).toEqual({
      kind: "capture",
      location: { view: "trace", runId: "r_a", tab: "steps", spanId: "s_03", file: null },
    });
  });

  it("来源引用只含阅读位置：结构里不存在草稿 / 目录引用 / 授权 / 凭据的任何键", () => {
    const decision = decideCreateEntry(
      snapshot({ selectedRunId: "r_a", reading: reading({ tab: "overview", spanId: "s_01" }) }),
    );
    if (decision.kind !== "capture") throw new Error("应建立来源");
    // 键集合逐字钉住：多塞一个"顺手"的草稿或授权字段就会红
    expect(Object.keys(decision.location).sort()).toEqual([
      "file",
      "runId",
      "spanId",
      "tab",
      "view",
    ]);
  });

  it("来源停在文件页 ⇒ 连检查点与路径一起记（checkpoint 为 null 即「看初始」，不是没进过）", () => {
    const decision = decideCreateEntry(
      snapshot({
        selectedRunId: "r_a",
        reading: reading({
          tab: "files",
          spanId: "s_05",
          files: fileReading({ checkpoint: null, path: "a/b.md" }),
        }),
      }),
    );
    expect(decision).toEqual({
      kind: "capture",
      location: {
        view: "trace",
        runId: "r_a",
        tab: "files",
        spanId: "s_05",
        file: { checkpoint: null, path: "a/b.md" },
      },
    });
  });

  it("页签写着文件页但从没进入过（`files` 缺席）⇒ 不记文件定位，不伪造「要看初始」", () => {
    const decision = decideCreateEntry(
      snapshot({ selectedRunId: "r_a", reading: reading({ tab: "files" }) }),
    );
    if (decision.kind !== "capture") throw new Error("应建立来源");
    expect(decision.location.file).toBeNull();
  });

  it("无运行（空列表 / 尚未选中）进入 ⇒ 来源只有视图", () => {
    expect(decideCreateEntry(snapshot())).toEqual({
      kind: "capture",
      location: { view: "trace", runId: null, tab: null, spanId: null, file: null },
    });
  });

  it("从分支树进入 ⇒ 不把 store 里残留的上一条选中当来源", () => {
    const decision = decideCreateEntry(
      snapshot({ view: "tree", selectedRunId: "r_a", reading: reading({ tab: "steps" }) }),
    );
    expect(decision).toEqual({
      kind: "capture",
      location: { view: "tree", runId: null, tab: null, spanId: null, file: null },
    });
  });

  it("创建页内重复点击「新建」⇒ 本次来源沿用（不重记，更不覆盖成创建页自己）", () => {
    expect(decideCreateEntry(snapshot({ view: "create", selectedRunId: "r_a" }))).toEqual({
      kind: "keep",
      reason: "already-in-create",
    });
  });
});

describe("4.1 返回来源：可用就恢复，失效就回退", () => {
  it("本会话没有来源引用（重载后必然如此）⇒ 回退轨迹工作区，不伪造旧位置", () => {
    expect(decideCreateReturn({ location: null, knownRunIds: ["r_a"] })).toEqual({
      kind: "fallback",
      view: "trace",
      reason: "no-location",
    });
  });

  it("来源运行仍在列表里 ⇒ 原样恢复", () => {
    const from = location({ runId: "r_a", tab: "steps", spanId: "s_03" });
    expect(decideCreateReturn({ location: from, knownRunIds: ["r_b", "r_a"] })).toEqual({
      kind: "restore",
      location: from,
    });
  });

  it("来源运行已不在列表里 ⇒ 回退，且不去挑一条「最接近的」顶上", () => {
    expect(
      decideCreateReturn({
        location: location({ runId: "r_gone", tab: "steps", spanId: "s_03" }),
        knownRunIds: ["r_b"],
      }),
    ).toEqual({ kind: "fallback", view: "trace", reason: "run-missing" });
  });

  it("来源本来就没有运行 ⇒ 回该视图即可（不存在「运行缺失」一说）", () => {
    const from = location({ view: "tree" });
    expect(decideCreateReturn({ location: from, knownRunIds: [] })).toEqual({
      kind: "restore",
      location: from,
    });
  });
});

describe("4.1 返回时要写回的阅读状态片段", () => {
  it("来源没有页签 ⇒ 一点阅读状态都不覆盖（该 run 的现值优先）", () => {
    expect(readingPatchOfLocation(location({ runId: "r_a" }))).toEqual({});
    expect(filePatchOfLocation(location({ runId: "r_a" }))).toBeNull();
  });

  it("页签与调用一起回写；文件定位只在来源是文件页时给", () => {
    expect(
      readingPatchOfLocation(location({ runId: "r_a", tab: "steps", spanId: "s_03" })),
    ).toEqual({ tab: "steps", spanId: "s_03" });
    expect(
      filePatchOfLocation(location({ tab: "steps", file: { checkpoint: "s_02", path: "x" } })),
    ).toBeNull();
    expect(
      filePatchOfLocation(location({ tab: "files", file: { checkpoint: null, path: "a/b.md" } })),
    ).toEqual({ checkpoint: null, path: "a/b.md" });
  });

  it("当场选中的调用必须在当前详情里点名存在", () => {
    const from = location({ runId: "r_a", tab: "steps", spanId: "s_03" });
    expect(liveSpanOfLocation(from, ["s_01", "s_03"])).toBe("s_03");
    // 详情里没有（换了对象 / 读取失败）⇒ 不给，不"跳一个大概在那里"的调用
    expect(liveSpanOfLocation(from, ["s_09"])).toBeNull();
    expect(liveSpanOfLocation(location({ tab: "steps", spanId: null }), ["s_01"])).toBeNull();
  });
});
