import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OperationRecord } from "@shared/operations";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deriveResultNotices } from "../src/renderer/src/lib/result-notices";
import { emptyResultReadStore, setResultRead } from "../src/renderer/src/lib/result-verification";

/**
 * U5（unify-run-execution-workflow）任务 5.2（下半）：**全局 `aria-live` 通知区、
 * 关闭详情只关查看、只通知不导航**。
 *
 * 判据来源：delta「跨页操作反馈展示真实等待与分层状态」之「关闭详情与退出不冒充停止」
 * 「恢复核对重试与批次结果只通知」+ design D6「区域位于可访问的全局外壳，操作面板关闭时
 * 仍存在；不强制聚焦或弹模态」。
 *
 * ⚠️ 禁用型源码断言一律**先剥注释**（诚实句里会出现"停止/取消"字样，U5 5.1/5.2 各踩过）。
 */

(globalThis as Record<string, unknown>).window = { api: {} };
const { ResultLiveRegionView } = await import("../src/renderer/src/components/ResultLiveRegion");

const EPOCH = "77777777-7777-4777-8777-777777777777";
const OP = "aaaaaaa1-1111-4111-8111-111111111111";
const RUN = "run_live_result";

function settledRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    epoch: EPOCH,
    operationId: OP,
    target: {
      kind: "result",
      mode: "plain",
      parentRunId: "r_parent",
      atSpanId: "s_03",
      editField: "result",
    },
    state: "settled",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: "2026-09-27T00:00:05.000Z",
    runIds: [RUN],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

const reads = () =>
  setResultRead(
    emptyResultReadStore(),
    { epoch: EPOCH, operationId: OP, runId: RUN },
    { phase: "verified", attempt: 1, facts: null, reason: null },
  );

const codeOf = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
const importLines = (src: string): string =>
  src
    .split("\n")
    .filter((line) => line.trimStart().startsWith("import"))
    .join("\n");

describe("5.2 全局 aria-live 区：独立于面板、只报派生通知", () => {
  it("区域恒渲染：空文本也不卸载，属性可访问（polite live region），面板收起不影响它", () => {
    const empty = renderToStaticMarkup(createElement(ResultLiveRegionView, { text: null }));
    // `<output>` 隐式 role=status（biome 语义元素判据），显式 aria-live 照旧在场
    expect(empty).toContain('aria-live="polite"');
    expect(empty).toContain("<output");
    expect(empty).toContain('id="result-live"');
    const filled = renderToStaticMarkup(
      createElement(ResultLiveRegionView, {
        text: deriveResultNotices({
          records: [settledRecord()],
          reads: reads(),
          seenKeys: {},
        }).liveText,
      }),
    );
    expect(filled).toContain(RUN);
  });

  it("文本与面板徽标同源（同一份 deriveResultNotices）；重复快照派生出**逐字相同**的文本 ⇒ DOM 不变不重复播报", () => {
    const first = deriveResultNotices({ records: [settledRecord()], reads: reads(), seenKeys: {} });
    const again = deriveResultNotices({ records: [settledRecord()], reads: reads(), seenKeys: {} });
    expect(first.liveText).not.toBeNull();
    expect(again.liveText).toBe(first.liveText);
    // 标成已看后清空（清空不是新事实，polite 区不会为此播报）
    const seen = deriveResultNotices({
      records: [settledRecord()],
      reads: reads(),
      seenKeys: { [`${EPOCH}|${OP}|${RUN}`]: true },
    });
    expect(seen.liveText).toBeNull();
  });

  it("通知区不摸执行/导航/计时通道：只派生文本", () => {
    const src = codeOf("../src/renderer/src/components/ResultLiveRegion.tsx");
    const imports = importLines(src);
    for (const forbidden of ["wait-timing", "use-wait-clock", "navigation-intent"]) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
    for (const forbidden of [
      "selectRun",
      "openOperationResult",
      "reconcileOperation",
      "refreshOperationStatus",
      "markNoticesSeen",
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("App 接线（源码级）：区域挂在外壳、无条件渲染，独立于主工作区各分支", () => {
    const app = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/App.tsx"), "utf8");
    // 独立一行、不落在任何三元/&& 分支里
    expect(app).toMatch(/^\s{6}<ResultLiveRegion \/>$/m);
    // 全局栏同样无条件 ⇒ 跨页入口（创建/阅读/设置返回后）都在
    expect(app).toMatch(/^\s{6}<GlobalBar$/m);
  });
});

describe("5.2 关闭详情只关查看：不冒充停止、不触达登记", () => {
  it("面板✕只关闭查看：没有任何登记清理、重发或「停止执行」类动作", () => {
    const src = codeOf("../src/renderer/src/components/OperationsEntry.tsx");
    // U5 5.6 改判（两边留痕）：✕ 与 Esc 共用 closePanel（关闭后把焦点还给触发入口）。
    // "只关查看"的判据不变——close 路径依旧只动展示态，不触达任何操作通道。
    const closeBlock = src.slice(
      src.indexOf("const closePanel"),
      src.indexOf("useEscapeClose(open, closePanel)"),
    );
    expect(closeBlock).toContain("setOpen(false)");
    expect(closeBlock).toContain("triggerRef.current?.focus()");
    for (const forbidden of [
      "reconcile",
      "refreshOperationStatus",
      "stopOperation",
      "cancelOperation",
      "abort",
      "terminate",
    ]) {
      expect(closeBlock, forbidden).not.toContain(forbidden);
    }
    // 关闭按钮的标签是「关闭操作列表」，不是「停止/取消」
    expect(src).toContain('aria-label="关闭操作列表"');
  });
});
