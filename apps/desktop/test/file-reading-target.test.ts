import { describe, expect, it } from "vitest";
import { parseReadingTarget, resolveReading } from "../src/renderer/src/lib/reading-resolve";
import type { ReadingTarget } from "../src/renderer/src/lib/reading-resolve";

/**
 * U2 任务 2.3：ReadingTarget 的嵌套 file 分支（审阅 P2 → 判别式字段）。
 *
 * 对应 delta：
 * -「显式文件定位覆盖历史」：一次性目标 > 有效会话选择 > 最近自有步骤 > 初始
 * -「跨运行和辅助视图返回恢复文件」：**普通返回不消费显式目标**
 * - 审阅 P2：调用定位字段（spanId/expandStepId）与文件字段（file）**不可混传**
 */

const detail = {
  spans: [
    { id: "s_1", parent: null, kind: "agent.step" as const, n: 1 },
    { id: "s_2", parent: null, kind: "agent.step" as const, n: 2 },
  ],
  leafSpanIds: ["s_1", "s_2"],
  hasFiles: true,
};

describe("U2 文件定位：显式目标优先于历史", () => {
  it("file 目标 ⇒ 落到文件页并携带文件目标（不消费历史页签）", () => {
    const r = resolveReading({
      detail,
      history: { tab: "steps", spanId: "s_1" },
      target: { file: { stepSpanId: "s_2", path: "a.txt" } },
    });
    expect(r.tab).toBe("files");
    expect(r.source).toBe("explicit");
    expect(r.fileTarget).toEqual({ stepSpanId: "s_2", path: "a.txt" });
  });

  it("file 目标不带 path ⇒ 文件目标无 path（调用方显示列表）", () => {
    const r = resolveReading({
      detail,
      history: null,
      target: { file: { stepSpanId: "s_1" } },
    });
    expect(r.tab).toBe("files");
    expect(r.fileTarget).toEqual({ stepSpanId: "s_1" });
  });

  it("file.stepSpanId 为 null ⇒ 明确指初始状态", () => {
    const r = resolveReading({
      detail,
      history: { tab: "files" },
      target: { file: { stepSpanId: null, path: "x.txt" } },
    });
    expect(r.fileTarget).toEqual({ stepSpanId: null, path: "x.txt" });
  });

  it("run 无文件页时的 file 目标 ⇒ 降级到概览且标记失效（不臆造文件页）", () => {
    const r = resolveReading({
      detail: { ...detail, hasFiles: false },
      history: null,
      target: { file: { stepSpanId: "s_1" } },
    });
    expect(r.tab).toBe("overview");
    expect(r.fileTarget).toBeNull();
    expect(r.invalidated).toBe(true);
  });
});

describe("U2 普通返回不消费显式目标", () => {
  it("无 target 的历史恢复到文件页时 fileTarget 为 null（不是文件定位）", () => {
    const r = resolveReading({
      detail,
      history: { tab: "files", spanId: null },
      target: null,
    });
    expect(r.tab).toBe("files");
    expect(r.fileTarget).toBeNull();
    expect(r.source).toBe("history");
  });

  it("仅有 { tab: 'files' } 的普通返回 ⇒ fileTarget 为 null", () => {
    const r = resolveReading({
      detail,
      history: null,
      target: { tab: "files" },
      currentTab: "files",
    });
    expect(r.fileTarget).toBeNull();
  });
});

describe("U2 调用定位与文件定位不可混传（审阅 P2）", () => {
  it("parseReadingTarget 拒收 spanId + file 混传", () => {
    expect(parseReadingTarget({ spanId: "s_1", file: { stepSpanId: "s_2" } })).toBeNull();
  });

  it("parseReadingTarget 拒收 expandStepId + file 混传", () => {
    expect(parseReadingTarget({ expandStepId: "s_1", file: { stepSpanId: "s_1" } })).toBeNull();
  });

  it("纯 file 目标 ⇒ 规范化到 files 页签", () => {
    expect(parseReadingTarget({ file: { stepSpanId: "s_2" } })).toEqual({
      tab: "files",
      file: { stepSpanId: "s_2" },
    });
  });

  it("纯调用目标原样通过（不强行改页签）", () => {
    const target: ReadingTarget = { tab: "steps", spanId: "s_1", expandStepId: "s_1" };
    expect(parseReadingTarget(target)).toEqual(target);
  });

  it("file.stepSpanId 类型非法（数字）⇒ 拒收", () => {
    expect(parseReadingTarget({ file: { stepSpanId: 3 as unknown as string } })).toBeNull();
  });

  it("null 目标原样返回 null", () => {
    expect(parseReadingTarget(null)).toBeNull();
  });
});
