import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  copyValueForRun,
  resolveEmptyCause,
  resolveNavListState,
} from "../src/renderer/src/lib/nav-notice";

/**
 * U1（refactor-run-workspace）任务 4.5：导航的刷新/错误/空结果/选中隐藏提示 + 短 ID 复制。
 *
 * 判据来源：desktop-ui delta「刷新合并且保留阅读」三个场景——
 *   - 「列表刷新失败可重试」：曾成功加载 ⇒ 保留旧列表 + 「未更新」+ 可重试；首次失败 ⇒ 可重试错误；
 *   - 「筛选隐藏当前运行」：正文不变，导航给提示 + 清除入口（**已在 3.5 落地，此处钉回归**）；
 *   - 「同名运行的短 ID 稳定可辨」：复制**永远给完整 ID**。
 *
 * ⚠️ 本包无 jsdom ⇒ 组件点击/剪贴板写入打不到，用两种方式：
 *     ① 纯判据（`nav-notice.ts`）直接喂状态位；
 *     ② 无法渲染触发的接线（刷新提示/重试按钮/复制入口/完整 ID 纪律）用**源码级契约**。
 */

const read = (rel: string): string => readFileSync(resolve(import.meta.dirname, "..", rel), "utf8");

/** 去掉注释行后的代码正文（避免注释里的字样误伤断言） */
function codeLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

describe("resolveNavListState：刷新失败保留旧列表、可重试", () => {
  it("刷新失败 ⇒ 标记「未更新」且可重试（不显示加载中）", () => {
    const state = resolveNavListState({
      loading: false,
      stale: true,
      error: "刷新 run 列表失败（仍显示上次结果）：ECONNRESET",
      hasAnyData: true,
    });
    expect(state.showStale).toBe(true);
    expect(state.canRetry).toBe(true);
    expect(state.showLoading).toBe(false);
    expect(state.failure).toContain("ECONNRESET");
  });

  it("首次失败（store 的 listStale 为 false）**不算**「未更新」", () => {
    // ⚠️ store 已由 resolveRefreshFailure 保证「首次失败时 listStale === false」——
    // 故本函数**不再接 listLoaded**（那会是等价冗余判据，变异验证证实它拦不住任何东西）。
    const state = resolveNavListState({
      loading: false,
      stale: false,
      error: "读取 run 列表失败：ENOENT",
      hasAnyData: false,
    });
    expect(state.showStale).toBe(false);
    expect(state.canRetry).toBe(true);
    expect(state.failure).toContain("ENOENT");
  });

  it("刷新进行中且已有数据 ⇒ 不显示加载中（不盖掉旧记录）", () => {
    const state = resolveNavListState({
      loading: true,
      stale: false,
      error: null,
      hasAnyData: true,
    });
    expect(state.showLoading).toBe(false);
    expect(state.showStale).toBe(false);
    expect(state.canRetry).toBe(false);
  });

  it("首次加载中且无数据 ⇒ 显示加载中占位", () => {
    const state = resolveNavListState({
      loading: true,
      stale: false,
      error: null,
      hasAnyData: false,
    });
    expect(state.showLoading).toBe(true);
  });

  it("无失败时 failure 为 null（不拿空串冒充错误）", () => {
    const state = resolveNavListState({
      loading: false,
      stale: false,
      error: null,
      hasAnyData: true,
    });
    expect(state.failure).toBeNull();
    expect(state.canRetry).toBe(false);
  });
});

describe("resolveEmptyCause：筛选后为空 ≠ 真的没有记录", () => {
  it("有筛选条件且无数据 ⇒ filtered（给清除条件，不是叫用户去放文件）", () => {
    expect(resolveEmptyCause({ hasActiveFilters: true, hasAnyData: false })).toBe("filtered");
  });

  it("无筛选条件且无数据 ⇒ no-records（给新建/放文件引导）", () => {
    expect(resolveEmptyCause({ hasActiveFilters: false, hasAnyData: false })).toBe("no-records");
  });

  it("有数据 ⇒ null（不显示任何空态）", () => {
    expect(resolveEmptyCause({ hasActiveFilters: true, hasAnyData: true })).toBeNull();
    expect(resolveEmptyCause({ hasActiveFilters: false, hasAnyData: true })).toBeNull();
  });
});

describe("copyValueForRun：复制永远是完整 ID，不是短 ID", () => {
  it("原样返回完整 ID（不给短 ID）", () => {
    expect(copyValueForRun("run_abcdef1234567890")).toBe("run_abcdef1234567890");
  });

  it("极短 ID 也原样返回（不回退、不截断）", () => {
    expect(copyValueForRun("r_1")).toBe("r_1");
  });
});

/**
 * 源码级接线契约（任务 4.5）。
 */
describe("接线：RunList 接入刷新提示、重试与复制", () => {
  it("导航消费 loadRuns 作为重试入口（不是另造一个刷新通道）", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    expect(src).toContain("s.loadRuns");
    // ⚠️ 两个「重试」按钮（未更新 / 首次失败）**都必须**接 loadRuns——
    // 只查 toContain 会被"其中一个接了"骗过（变异验证证实过），故按数量对齐。
    const retryButtons = src.match(/>\s*重试\s*</g) ?? [];
    const wiredReloads = src.match(/onClick=\{\(\) => void reload\(\)\}/g) ?? [];
    expect(retryButtons.length).toBeGreaterThan(0);
    expect(wiredReloads).toHaveLength(retryButtons.length);
  });

  it("刷新失败用「未更新」措辞且保留旧列表（不显示空态）", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    expect(src).toContain("列表未更新，仍显示上次结果");
    expect(src).toContain("resolveNavListState");
  });

  it("空态成因用 resolveEmptyCause 分流（筛选空 vs 无记录）", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    expect(src).toContain("resolveEmptyCause");
    expect(src).toContain('emptyCause === "filtered"');
  });

  it("复制入口是选择按钮的**兄弟**（HTML 不允许 button 套 button）", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    // 组件调 copyRunId(run.id)，其内部用 copyValueForRun 取完整 ID
    expect(src).toContain("copyRunId(run.id)");
    expect(src).toContain("copyValueForRun(runId)");
    expect(src).toContain("navigator.clipboard.writeText");
    // 复制时不得把短 ID 当值（短 ID 只用于显示）
    expect(src).not.toMatch(/writeText\(\s*(shortIds|shortId)\b/);
    // 复制入口必须是真 <button>，且位于选择按钮的闭合标签**之后**（兄弟节点）
    expect(src).toContain("复制完整运行 ID");
    const selectionClose = src.indexOf("</button>\n\n              {/* 复制完整 ID");
    expect(selectionClose).toBeGreaterThan(-1);
  });

  it("复制入口带可访问名称（aria-label 给出完整 ID 语义）", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    expect(src).toContain("aria-label={`复制完整运行 ID");
    expect(src).toContain('type="button"');
  });

  it("复制失败不假装成功（catch 里复原为短 ID 显示）", () => {
    const code = codeLines(read("src/renderer/src/components/RunList.tsx"));
    expect(code).toContain("setCopiedId(null)");
  });

  it("筛选隐藏当前运行的提示仍在（3.5 能力未回退）", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    expect(src).toContain("当前运行的记录不在筛选结果中");
    expect(src).toContain("清除条件");
  });

  it("刷新中不显示加载中覆盖已有数据（有旧列表就留着）", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    expect(src).toContain("navState.showLoading");
  });
});
