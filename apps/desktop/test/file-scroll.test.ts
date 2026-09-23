import { describe, expect, it } from "vitest";
import {
  anchorMatches,
  buildContentAnchor,
  clampAnchorLine,
  resolveAnchorScrollTop,
  sameAnchor,
} from "../src/renderer/src/lib/file-scroll";

/**
 * U2 任务 4.3 / 5.3：正文滚动锚点的纯逻辑。
 *
 * 本包无 jsdom ⇒ 编辑器侧的"何时调用"由接线契约钉（见 `file-view-scroll-wiring.test.ts`），
 * 这里只钉**算得对不对**：
 * - 锚点是「首个可见行 + 相对该行的偏移」，不是裸像素（内容换了像素不可复用）；
 * - 锚点必须按 (step, path) 匹配才可套用（同名跨 run / 跨轮不得互认）；
 * - 容器未布局 ⇒ 返回 `null`（**不是 0**），调用方不得写入。
 */
describe("U2 正文滚动锚点：构造与匹配", () => {
  it("用首个可见行 + 相对该行顶部的偏移表达位置（不是裸像素）", () => {
    const anchor = buildContentAnchor({
      stepSpanId: "s_2",
      path: "long.txt",
      topLine: 40,
      lineTop: 780,
      scrollTop: 800,
    });
    expect(anchor).toEqual({ stepSpanId: "s_2", path: "long.txt", line: 40, offset: 20 });
  });

  it("行号归一：小数向下取整、<1 与非法值收到 1", () => {
    expect(clampAnchorLine(40.9)).toBe(40);
    expect(clampAnchorLine(0)).toBe(1);
    expect(clampAnchorLine(-5)).toBe(1);
    expect(clampAnchorLine(Number.NaN)).toBe(1);
    expect(clampAnchorLine(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("lineTop 不可信时偏移记 0 —— 宁可回行顶，也不记来路不明的像素", () => {
    const anchor = buildContentAnchor({
      stepSpanId: null,
      path: "a.txt",
      topLine: 3,
      lineTop: Number.NaN,
      scrollTop: 120,
    });
    expect(anchor.offset).toBe(0);
    expect(anchor.line).toBe(3);
  });

  it("滚动位置在行顶之上（换行导致）时偏移夹到 0，不出现负偏移", () => {
    const anchor = buildContentAnchor({
      stepSpanId: "s_1",
      path: "a.txt",
      topLine: 10,
      lineTop: 200,
      scrollTop: 150,
    });
    expect(anchor.offset).toBe(0);
  });

  it("匹配要求 step 与 path **都**相同（跨检查点 / 同名路径不得互认）", () => {
    const anchor = buildContentAnchor({
      stepSpanId: "s_2",
      path: "keep.txt",
      topLine: 5,
      lineTop: 100,
      scrollTop: 100,
    });
    expect(anchorMatches(anchor, "s_2", "keep.txt")).toBe(true);
    // 同 run 内换了检查点 ⇒ 不匹配（内容整体换了）
    expect(anchorMatches(anchor, "s_3", "keep.txt")).toBe(false);
    // 同名不同路径 ⇒ 不匹配
    expect(anchorMatches(anchor, "s_2", "other/keep.txt")).toBe(false);
    // 初始检查点（null）与某轮步骤不互认
    expect(anchorMatches({ ...anchor, stepSpanId: null }, "s_2", "keep.txt")).toBe(false);
    // 没有锚点 / 没有选中路径 ⇒ 不匹配
    expect(anchorMatches(null, "s_2", "keep.txt")).toBe(false);
    expect(anchorMatches(anchor, "s_2", null)).toBe(false);
  });

  it("同一位置重复上报视为同一锚点（去重，避免每次滚动都写 store）", () => {
    const a = buildContentAnchor({
      stepSpanId: "s_1",
      path: "a.txt",
      topLine: 7,
      lineTop: 300,
      scrollTop: 320,
    });
    const b = buildContentAnchor({
      stepSpanId: "s_1",
      path: "a.txt",
      topLine: 7,
      lineTop: 300,
      scrollTop: 320.4,
    });
    expect(sameAnchor(a, b)).toBe(true);
    const c = buildContentAnchor({
      stepSpanId: "s_1",
      path: "a.txt",
      topLine: 8,
      lineTop: 320,
      scrollTop: 340,
    });
    expect(sameAnchor(a, c)).toBe(false);
  });
});

describe("U2 正文滚动锚点：恢复", () => {
  const anchor = { stepSpanId: "s_2", path: "long.txt", line: 40, offset: 20 } as const;

  it("按当前内容重算该行顶部像素再叠加偏移（内容长度变化不影响）", () => {
    // 当前内容里第 40 行顶部在 900px（比保存时更长）⇒ 目标是 920
    const top = resolveAnchorScrollTop(anchor, {
      lineTop: 900,
      scrollHeight: 4000,
      clientHeight: 600,
    });
    expect(top).toBe(920);
  });

  it("内容变短 ⇒ 夹到合法上限（不留下非法 scrollTop）", () => {
    const top = resolveAnchorScrollTop(anchor, {
      lineTop: 900,
      scrollHeight: 1000,
      clientHeight: 600,
    });
    expect(top).toBe(400);
  });

  it("容器尚未布局（scrollHeight/clientHeight 为 0）⇒ 返回 null，调用方不得写入", () => {
    expect(
      resolveAnchorScrollTop(anchor, { lineTop: 0, scrollHeight: 0, clientHeight: 0 }),
    ).toBeNull();
    expect(
      resolveAnchorScrollTop(anchor, { lineTop: 100, scrollHeight: 500, clientHeight: 0 }),
    ).toBeNull();
  });

  it("lineTop 不可信 ⇒ null（不把 NaN 当 0 写进编辑器）", () => {
    expect(
      resolveAnchorScrollTop(anchor, {
        lineTop: Number.NaN,
        scrollHeight: 4000,
        clientHeight: 600,
      }),
    ).toBeNull();
  });
});
