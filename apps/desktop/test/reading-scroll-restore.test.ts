import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  LongText,
  isLongTextExpanded,
  shouldCollapse,
  toggleLongTextExpanded,
} from "../src/renderer/src/components/LongText";
import { resolveReading } from "../src/renderer/src/lib/reading-resolve";
import type { ReadingStateByRun } from "../src/renderer/src/lib/reading-state";
import {
  defaultReadingState,
  patchCallReading,
  patchReadingState,
  readingStateOf,
} from "../src/renderer/src/lib/reading-state";
import {
  decideRestore,
  hasRestored,
  initialRestoreState,
  restoreIdentity,
  shouldResetRestore,
} from "../src/renderer/src/lib/restore-gate";
import {
  canRestoreScroll,
  isAtBottom,
  resolveRestoreScrollTop,
  resolveScrollRestore,
} from "../src/renderer/src/lib/scroll-restore";
import {
  isReadingContentReady,
  readingScrollOf,
  resolveDetailPhase,
} from "../src/renderer/src/lib/workspace-selection";

/**
 * U1（refactor-run-workspace）任务 3.6：概览/步骤目录/逐调用滚动与长文本展开恢复。
 *
 * 判据来源：desktop-ui delta 两个场景
 *   - 跨运行返回恢复阅读（A 展开长消息、选择调用、滚动 → 切 B → 返回 A ⇒ 全部恢复）
 *   - 失效阅读对象安全回退（重读后对象不在 ⇒ 提示并清理，不选另一个 run 的同 ID span）
 * 以及 design D6 的两条实现义务：
 *   - 「LongText 的展开状态改为可受控」
 *   - 「各阅读器在卸载前保存位置，重新装载内容后恢复并限制到合法滚动范围」
 *
 * ⚠️ 本包 vitest 是 node 环境、**没有 jsdom**：组件层只能用 `renderToStaticMarkup`
 *    对窄契约（长文本折叠/受控与默认展开）做静态断言；滚动几何用纯函数断言。
 *    真实滚动与布局归 7.1–7.3 的 Electron/CDP 验收，此处不冒充。
 */

const LONG = "长".repeat(700);
const SHORT = "短文本";

describe("长文本展开状态可受控（design D6：LongText 展开状态改为可受控）", () => {
  it("折叠判据不变：严格大于阈值才折叠（既有 B 3.1 边界的回归锚点）", () => {
    expect(shouldCollapse(SHORT)).toBe(false);
    expect(shouldCollapse(LONG)).toBe(true);
  });

  it("未受控（不传 expanded）时退化为默认折叠：静态渲染不带 open", () => {
    const html = renderToStaticMarkup(createElement(LongText, { text: LONG, label: "正文" }));
    expect(html).toContain("<details");
    expect(html).not.toContain("open");
  });

  it("受控展开 ⇒ 静态渲染带 open；受控折叠 ⇒ 不带 open", () => {
    const open = renderToStaticMarkup(
      createElement(LongText, { text: LONG, label: "正文", expanded: true, onToggle: () => {} }),
    );
    expect(open).toContain("open");
    const closed = renderToStaticMarkup(
      createElement(LongText, { text: LONG, label: "正文", expanded: false, onToggle: () => {} }),
    );
    expect(closed).not.toContain("open");
  });

  it("短文本一律不折叠：即便传了 expanded=true 也不渲染 details", () => {
    const html = renderToStaticMarkup(
      createElement(LongText, { text: SHORT, label: "正文", expanded: true, onToggle: () => {} }),
    );
    expect(html).not.toContain("<details");
    expect(html).toContain(SHORT);
  });

  it("展开状态键：只记已展开的键——没记录过 ≠ 已展开", () => {
    expect(isLongTextExpanded(undefined, "content")).toBe(false);
    expect(isLongTextExpanded([], "content")).toBe(false);
    expect(isLongTextExpanded(["content"], "content")).toBe(true);
  });

  it("切换是幂等的双向开关，且保持稳定顺序", () => {
    let keys = toggleLongTextExpanded(undefined, "content");
    expect(keys).toEqual(["content"]);
    keys = toggleLongTextExpanded(keys, "reasoning");
    expect(keys).toEqual(["content", "reasoning"]);
    // 再切 content ⇒ 关掉它，reasoning 顺序不动（顺序进断言，不依赖实现细节）
    keys = toggleLongTextExpanded(keys, "content");
    expect(keys).toEqual(["reasoning"]);
  });

  it("展开集合按 run + 调用隔离存会话：A/B 相同 span ID 不串", () => {
    let byRun: ReadingStateByRun = {};
    byRun = patchCallReading(byRun, "run_a", "s_01", { expanded: ["content"] });
    byRun = patchCallReading(byRun, "run_b", "s_01", { expanded: ["tool_calls"] });

    const a = readingStateOf(byRun, "run_a").calls.s_01?.expanded;
    const b = readingStateOf(byRun, "run_b").calls.s_01?.expanded;
    expect(isLongTextExpanded(a, "content")).toBe(true);
    expect(isLongTextExpanded(a, "tool_calls")).toBe(false);
    expect(isLongTextExpanded(b, "tool_calls")).toBe(true);
    expect(isLongTextExpanded(b, "content")).toBe(false);
  });

  it("展开状态里不落正文副本（只存键，不存内容）", () => {
    const byRun = patchCallReading({}, "run_a", "s_01", { expanded: ["content"] });
    const serialized = JSON.stringify(byRun);
    expect(serialized).not.toContain(LONG);
    expect(serialized).toContain("content");
  });
});

describe("滚动位置裁剪与恢复（滚动上限裁剪）", () => {
  it("未完成布局（高度不可测）⇒ 不恢复：返回 null，不拿 0 冒充", () => {
    expect(canRestoreScroll({ scrollHeight: 0, clientHeight: 800 })).toBe(false);
    expect(canRestoreScroll({ scrollHeight: 3000, clientHeight: 0 })).toBe(false);
    expect(resolveRestoreScrollTop(500, { scrollHeight: 0, clientHeight: 0 })).toBeNull();
  });

  it("内容变短：超过上限的位置被裁到最大值（不静默夹成 0）", () => {
    // 旧内容 5000px 可滚 4400，记录 3000；新内容只剩 1000px 可滚 400
    expect(resolveRestoreScrollTop(3000, { scrollHeight: 1400, clientHeight: 1000 })).toBe(400);
  });

  it("负值与非有限值归 0（记录字段按不可信输入处理）", () => {
    const height = { scrollHeight: 3000, clientHeight: 800 };
    expect(resolveRestoreScrollTop(-50, height)).toBe(0);
    expect(resolveRestoreScrollTop(Number.NaN, height)).toBe(0);
    expect(resolveRestoreScrollTop(Number.POSITIVE_INFINITY, height)).toBe(2200);
  });

  it("内容不足一屏 ⇒ 只有位置 0 合法", () => {
    const height = { scrollHeight: 500, clientHeight: 800 };
    expect(resolveRestoreScrollTop(120, height)).toBe(0);
  });

  it("分辨率变化：同一记录值在新高度下重新裁剪（可解释，不是静默夹取）", () => {
    const saved = 1000;
    expect(resolveRestoreScrollTop(saved, { scrollHeight: 3000, clientHeight: 600 })).toBe(1000);
    // 窗口变高后可滚范围只剩 200 ⇒ 记录值被裁
    expect(resolveRestoreScrollTop(saved, { scrollHeight: 1000, clientHeight: 800 })).toBe(200);
  });

  it("未记录过该位置（undefined）⇒ 不恢复", () => {
    expect(resolveScrollRestore(undefined, { scrollHeight: 3000, clientHeight: 800 })).toBeNull();
    expect(resolveScrollRestore(0, { scrollHeight: 3000, clientHeight: 800 })).toBe(0);
  });

  it("「读到过底部」判定：内容不足一屏不算读到过底部", () => {
    expect(isAtBottom(2200, { scrollHeight: 3000, clientHeight: 800 })).toBe(true);
    expect(isAtBottom(2199, { scrollHeight: 3000, clientHeight: 800 })).toBe(false);
    // 无需滚动 ⇒ 没有"底部"可读
    expect(isAtBottom(0, { scrollHeight: 500, clientHeight: 800 })).toBe(false);
    // 不可测 ⇒ 不下结论
    expect(isAtBottom(0, { scrollHeight: 0, clientHeight: 0 })).toBe(false);
  });

  it("概览与步骤目录各记一条：取错位置会得到 undefined（而非另一条的值）", () => {
    const reading = patchReadingState({}, "run_a", { overviewScrollTop: 120, stepsScrollTop: 340 });
    const state = readingStateOf(reading, "run_a");
    expect(readingScrollOf(state, "overview")).toBe(120);
    expect(readingScrollOf(state, "steps")).toBe(340);
    // 另一个 run 没记过 ⇒ undefined（调用方据此"不恢复"，不是"恢复到 0"）：
    // known=false 表达"readingByRun 里根本没有这个 run 的条目"
    const other = readingStateOf(reading, "run_b");
    expect(readingScrollOf(other, "overview", false)).toBe(undefined);
    expect(readingScrollOf(other, "steps", false)).toBe(undefined);
    // 有条目但该位置确实记的是 0 ⇒ 仍是有效历史位置（0 是值，不是"没记过"）
    expect(readingScrollOf(state, "overview", true)).toBe(120);
  });
});

describe("内容挂载后恢复的门控（design D6：重新装载内容后恢复）", () => {
  it("内容未就绪（加载中/失败）⇒ 不恢复，且**不记账**（内容就绪后仍可恢复）", () => {
    const decision = decideRestore({
      state: initialRestoreState,
      detailKey: "run_a",
      contentReady: false,
      measurable: true,
    });
    expect(decision.restore).toBe(false);
    expect(hasRestored(decision.next, "run_a")).toBe(false);
  });

  it("内容就绪但容器还没量出高度 ⇒ 不恢复且不记账（等布局，允许重试）", () => {
    const decision = decideRestore({
      state: initialRestoreState,
      detailKey: "run_a",
      contentReady: true,
      measurable: false,
    });
    expect(decision.restore).toBe(false);
    expect(hasRestored(decision.next, "run_a")).toBe(false);
  });

  it("内容就绪且可测 ⇒ 恢复一次并记账；重渲染不再恢复（否则会顶回用户后续滚动）", () => {
    const first = decideRestore({
      state: initialRestoreState,
      detailKey: "run_a",
      contentReady: true,
      measurable: true,
    });
    expect(first.restore).toBe(true);
    expect(hasRestored(first.next, "run_a")).toBe(true);

    const second = decideRestore({
      state: first.next,
      detailKey: "run_a",
      contentReady: true,
      measurable: true,
    });
    expect(second.restore).toBe(false);
  });

  it("没有内容身份（尚未选中 run）⇒ 不恢复", () => {
    const decision = decideRestore({
      state: initialRestoreState,
      detailKey: null,
      contentReady: true,
      measurable: true,
    });
    expect(decision.restore).toBe(false);
  });

  it("A→B→A 返回 A：切到 B 已覆盖记账 ⇒ 回到 A 仍恢复（关键反例）", () => {
    const a = decideRestore({
      state: initialRestoreState,
      detailKey: "run_a",
      contentReady: true,
      measurable: true,
    });
    expect(a.restore).toBe(true);
    const b = decideRestore({
      state: a.next,
      detailKey: "run_b",
      contentReady: true,
      measurable: true,
    });
    expect(b.restore).toBe(true);
    // 返回 A：记账里是 run_b ⇒ run_a 仍可恢复。
    // （本轮实测：这正是为什么 shouldResetRestore 不是这条路径的必要条件——
    //   把它改成恒 false 这条用例照样绿，故未在组件里依赖它）
    expect(
      decideRestore({
        state: b.next,
        detailKey: "run_a",
        contentReady: true,
        measurable: true,
      }).restore,
    ).toBe(true);
  });

  it("内容身份含 span 指纹：同 run 重读后内容变了 ⇒ 身份变（恢复窗口重新打开）", () => {
    const before = restoreIdentity({
      meta: { id: "run_a" },
      spans: [{ id: "s_01" }, { id: "s_02" }],
    });
    // id 相同、内容被裁剪 ⇒ 身份必须不同（否则按旧内容裁剪过的位置会继续生效）
    const after = restoreIdentity({ meta: { id: "run_a" }, spans: [{ id: "s_01" }] });
    expect(after).not.toBe(before);

    // 内容完全一致 ⇒ 身份稳定（不因重复渲染抖动而反复恢复）
    const same = restoreIdentity({
      meta: { id: "run_a" },
      spans: [{ id: "s_01" }, { id: "s_02" }],
    });
    expect(same).toBe(before);

    // 不同 run 同 span ⇒ 身份不同（不串）
    expect(
      restoreIdentity({ meta: { id: "run_b" }, spans: [{ id: "s_01" }, { id: "s_02" }] }),
    ).not.toBe(before);

    // 身份里不含正文（只含 id 序列与数量）
    expect(before).toBe("run_a#2#s_01,s_02");
  });

  it("shouldResetRestore 只表达「这两个身份不是一个内容」", () => {
    // 先钉住它**确实**判身份变化（供"重读同 id 需显式清账"的场景使用）
    expect(shouldResetRestore({ restoredKey: "run_a" }, "run_b")).toBe(true);
    expect(shouldResetRestore({ restoredKey: "run_a" }, null)).toBe(true);
    // 同一身份 ⇒ 不算变化（重读同 run 时 id 不变，故**不能**指望它来清账）
    expect(shouldResetRestore({ restoredKey: "run_a" }, "run_a")).toBe(false);
    expect(shouldResetRestore(initialRestoreState, "run_a")).toBe(false);
  });

  it("同一 run 重读（record 被重写）⇒ 调用方显式清账后才能重新恢复", () => {
    // 身份只按 meta.id 计：重读后 id 不变，decideRestore 会以"恢复过这个身份"为由跳过，
    // 而重读后的内容可能整段变了 ⇒ 必须由调用方在发起重读时清空记账。
    const afterFirst = decideRestore({
      state: initialRestoreState,
      detailKey: "run_a",
      contentReady: true,
      measurable: true,
    }).next;
    expect(afterFirst.restoredKey).toBe("run_a");
    // 不清账 ⇒ 跳过（这正是"必须显式清"的理由，不是 bug）
    expect(
      decideRestore({ state: afterFirst, detailKey: "run_a", contentReady: true, measurable: true })
        .restore,
    ).toBe(false);
    // 显式清账 ⇒ 重新恢复
    expect(
      decideRestore({
        state: initialRestoreState,
        detailKey: "run_a",
        contentReady: true,
        measurable: true,
      }).restore,
    ).toBe(true);
  });
});

describe("详情读取状态与恢复就绪（degradation 口径）", () => {
  it("只有 ready 才允许恢复；加载中/失败都不恢复", () => {
    expect(isReadingContentReady("ready")).toBe(true);
    expect(isReadingContentReady("loading")).toBe(false);
    expect(isReadingContentReady("error")).toBe(false);
  });

  it("加载中优先于残留在 store 里的旧详情（3.3 刻意保留旧 detail 不闪空）", () => {
    // 若按 hasDetail 判成 ready，恢复会发生在**还没换上的旧内容**上
    expect(resolveDetailPhase({ loading: true, error: null, hasDetail: true })).toBe("loading");
  });

  it("失败态不冒充就绪（屏幕上是被读内容的错误提示，不是轨迹）", () => {
    expect(resolveDetailPhase({ loading: false, error: "读取失败", hasDetail: false })).toBe(
      "error",
    );
    expect(resolveDetailPhase({ loading: false, error: null, hasDetail: true })).toBe("ready");
    // 既不在加载、也没错误、也没有详情 ⇒ 仍是加载中（视为还没就绪）
    expect(resolveDetailPhase({ loading: false, error: null, hasDetail: false })).toBe("loading");
  });
});

describe("失效阅读对象安全回退（store 恢复路径的组合判据）", () => {
  const spans = [
    { id: "s_step1", kind: "agent.step" as const, n: 1 },
    { id: "s_llm1", kind: "llm.call" as const, n: 1 },
  ];
  const detail = { spans, leafSpanIds: ["s_step1", "s_llm1"], hasFiles: false };

  it("历史 span 不在详情里 ⇒ 回退到首个自有调用并标记失效（提示原位置不可用）", () => {
    const resolved = resolveReading({
      detail,
      history: { tab: "steps", spanId: "s_gone" },
      target: null,
    });
    expect(resolved.invalidated).toBe(true);
    expect(resolved.spanId).toBe("s_llm1");
    expect(resolved.source).toBe("history");
  });

  it("历史停在文件页而该 run 无文件世界 ⇒ 回退概览（不适用页签）", () => {
    const resolved = resolveReading({
      detail,
      history: { tab: "files", spanId: "s_llm1" },
      target: null,
    });
    expect(resolved.tab).toBe("overview");
    expect(resolved.invalidated).toBe(true);
  });

  it("有效历史 ⇒ 原样恢复且不报失效（避免误提示）", () => {
    const resolved = resolveReading({
      detail,
      history: { tab: "steps", spanId: "s_llm1" },
      target: null,
    });
    expect(resolved).toMatchObject({ tab: "steps", spanId: "s_llm1", invalidated: false });
  });

  it("跨运行返回：另一 run 的同 ID span 不会「顶替」失效引用", () => {
    // A 的历史指向 s_gone；B 里恰好存在同名 span → 必须回退到**本详情**的默认位置，
    // 而不是把 B 的同名 span 借过来（同 ID 不串状态的负面清单）
    const other = {
      spans: [{ id: "s_gone", kind: "llm.call" as const, n: 1 }],
      leafSpanIds: ["s_gone"],
      hasFiles: false,
    };
    const resolvedOther = resolveReading({
      detail: other,
      history: { tab: "steps", spanId: "s_gone" },
      target: null,
    });
    expect(resolvedOther.spanId).toBe("s_gone");

    const resolvedA = resolveReading({
      detail,
      history: { tab: "steps", spanId: "s_gone" },
      target: null,
    });
    expect(resolvedA.spanId).not.toBe("s_gone");
  });

  it("空轨迹 + 历史有值 ⇒ 空态（不借历史伪造位置）", () => {
    const empty = { spans: [], leafSpanIds: [], hasFiles: false };
    const resolved = resolveReading({
      detail: empty,
      history: { tab: "steps", spanId: "s_llm1" },
      target: null,
    });
    expect(resolved.spanId).toBeNull();
    expect(resolved.invalidated).toBe(true);
  });

  it("默认阅读状态的滚动初值为 0，不与「未记录过」混为一谈", () => {
    // readingStateOf 缺省返回默认（0/0），而 patch 之后才有"记录过"的语义；
    // 调用侧的 undefined 判据来自 readingScrollOf 在别的 run 上的返回
    const state = defaultReadingState();
    expect(state.overviewScrollTop).toBe(0);
    expect(state.stepsScrollTop).toBe(0);
  });
});
