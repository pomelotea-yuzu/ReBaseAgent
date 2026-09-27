import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ShortIdState, computeShortIds, deriveNavLabel, filterRuns } from "@shared/nav";
import type { RunSummary } from "../src/shared/ipc";

/**
 * U1（refactor-run-workspace）任务 4.4：RunList 的摘要、搜索、来源与展开指标重排。
 *
 * 判据来源：desktop-ui delta「run 列表从 traces 目录扫描派生」五个场景——
 *   - 「多份 trace 文件」：一份文件一行，互不吞并；
 *   - 「完整任务和 ID 搜索」：搜索匹配完整原值，不因展示折叠/截断而漏配；
 *   - 「长模型和空任务的导航摘要」：空任务回退为来源/时间/短 ID；缺失模型显「未记录」；
 *   - 「徽标与过滤」：代理徽标 + 三档过滤（全部/代理录制/本地记录）；
 *   - 「老文件无来源」：无 source 字段的老文件归「本地记录」，不报错。
 *
 * ⚠️ 本包无 jsdom ⇒ 组件层只能 `renderToStaticMarkup` 静态断言（且 zustand 在 SSR 下
 *    走 getServerSnapshot，喂不进 store 状态）。故这里用两种方式：
 *     ① 直接对**消费的共用派生**喂 RunSummary fixture，走与组件完全相同的输入形态；
 *     ② 对无法渲染触发的接线（短 ID 记忆必须挂在 store、标签文案、既有指标保留）
 *        用**源码级契约**断言。
 *     真实点击/滚动归 7.x 端到端实测。
 */

/** 构造一行 RunSummary（与 `runs:list` 同形） */
function summaryOf(over: Partial<RunSummary> & { id: string }): RunSummary {
  return {
    task: "把这段代码加上注释",
    model: "deepseek-chat",
    status: "completed",
    reason: null,
    source: "local",
    parent: null,
    steps: 1,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheHit: null,
    durationMs: 10,
    created_at: "2026-09-21T00:00:00.000Z",
    ...over,
  } as RunSummary;
}

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

describe("场景「多份 trace 文件」：一份文件一行，互不吞并", () => {
  const runs = [
    summaryOf({ id: "run_aaaa1111", task: "任务甲" }),
    summaryOf({ id: "run_bbbb2222", task: "任务乙" }),
    summaryOf({ id: "run_cccc3333", task: "任务丙" }),
  ];

  it("三条记录全部进列表，各自可辨（不合并成一条）", () => {
    const filtered = filterRuns(runs, "", "all");
    expect(filtered).toHaveLength(3);
    expect(new Set(filtered.map((r) => r.id)).size).toBe(3);
  });

  it("每行摘要取自**自己**的 task，不串行", () => {
    const labels = runs.map((run) => deriveNavLabel(run, "abc", { time: "t", source: "本地记录" }));
    expect(labels.map((l) => l.title)).toEqual(["任务甲", "任务乙", "任务丙"]);
  });

  it("短 ID 两两不同（同名任务也能区分开）", () => {
    const short = computeShortIds(runs.map((r) => r.id));
    expect(new Set(short.values()).size).toBe(3);
  });
});

describe("场景「完整任务和 ID 搜索」：匹配完整原值，不受展示折叠影响", () => {
  it("长任务的截断之外片段仍可命中（搜索用原值，不用两行摘要）", () => {
    const long = `${"前".repeat(90)}末尾关键词`;
    const run = summaryOf({ id: "run_x", task: long });
    // 展示只需两行，但搜索必须命中未显示的部分
    expect(filterRuns([run], "末尾关键词", "all")).toHaveLength(1);
  });

  it("按完整 ID 搜索命中", () => {
    const run = summaryOf({ id: "run_AbC123def", task: "无关" });
    expect(filterRuns([run], "abc123", "all")).toHaveLength(1);
  });
});

describe("场景「长模型和空任务的导航摘要」", () => {
  it("空任务回退为「来源 · 时间 · 短 ID」并标 isFallback", () => {
    const run = summaryOf({ id: "run_abcd1234", task: "   \n  " });
    const label = deriveNavLabel(run, "abcd1234", {
      time: "09-21 10:00",
      source: "本地记录",
    });
    expect(label.isFallback).toBe(true);
    expect(label.title).toBe("本地记录 · 09-21 10:00 · abcd1234");
  });

  it("有任务时 isFallback 为 false，标题即折叠后的任务", () => {
    const run = summaryOf({ id: "run_x", task: "修复\n\n登录 页面" });
    const label = deriveNavLabel(run, "xxxx", { time: "t", source: "s" });
    expect(label.isFallback).toBe(false);
    expect(label.title).toBe("修复 登录 页面");
  });

  it("缺失模型显示「未记录」，不借用当前配置（组件不读 settings.model）", () => {
    const run = summaryOf({ id: "run_x", task: "任务", model: "" });
    expect(deriveNavLabel(run, "x", { time: "t", source: "s" }).model).toBe("未记录");
  });

  it("长模型原值保留（换行/展开交给样式，不在数据层截断）", () => {
    const longModel = `azure-${"m".repeat(120)}`;
    const run = summaryOf({ id: "run_x", task: "任务", model: longModel });
    expect(deriveNavLabel(run, "x", { time: "t", source: "s" }).model).toBe(longModel);
  });
});

describe("场景「徽标与过滤」：代理徽标 + 三档过滤", () => {
  const runs = [
    summaryOf({ id: "run_p1", task: "代理任务", source: "proxy" }),
    summaryOf({ id: "run_p2", task: "代理任务", source: "proxy" }),
    summaryOf({ id: "run_l1", task: "本地任务", source: null }),
    summaryOf({ id: "run_l2", task: "本地任务", source: null }),
  ];

  it("全部：4 条", () => {
    expect(filterRuns(runs, "", "all")).toHaveLength(4);
  });

  it("代理录制：只剩 2 条代理", () => {
    expect(filterRuns(runs, "", "proxy").map((r) => r.id)).toEqual(["run_p1", "run_p2"]);
  });

  it("本地记录：只剩 2 条本地", () => {
    expect(filterRuns(runs, "", "local").map((r) => r.id)).toEqual(["run_l1", "run_l2"]);
  });

  it('来源徽标只在 proxy 上出现（组件判 source === "proxy"）', () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    expect(src).toContain('run.source === "proxy"');
    expect(src).toContain("代理录制");
  });

  it("过滤按钮三档文案与 shared/nav 的枚举同口径", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    expect(src).toContain('["all", "全部"]');
    expect(src).toContain('["proxy", "代理录制"]');
    expect(src).toContain('["local", "本地记录"]');
  });
});

describe("场景「老文件无来源」：无 source 归「本地记录」，不报错", () => {
  it("source 为 null 的老文件归入本地记录过滤", () => {
    const legacy = summaryOf({ id: "run_legacy", task: "老记录", source: null });
    expect(filterRuns([legacy], "", "local")).toHaveLength(1);
    expect(filterRuns([legacy], "", "proxy")).toHaveLength(0);
  });

  it("老文件在列表里照常显示一行摘要（不因缺 source 被吞）", () => {
    const legacy = summaryOf({ id: "run_legacy", task: "老记录", source: null });
    expect(filterRuns([legacy], "", "all")).toHaveLength(1);
  });

  it("老文件不显示代理徽标（不被误标为代理录制）", () => {
    const legacy = summaryOf({ id: "run_legacy", task: "老记录", source: null });
    // 徽标判据即 `source === "proxy"`，null 不满足
    expect(legacy.source === "proxy").toBe(false);
  });
});

/**
 * 源码级接线契约（任务 4.4）：本包无 jsdom，无法渲染触发的接线在此钉住。
 */
describe("接线：短 ID 长度记忆挂在 store（跨渲染存活）", () => {
  it("RunList 消费 store 的 shortIdState，不新造本地 state", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    expect(src).toContain("s.shortIdState");
    expect(src).toContain("deriveNavLabel");
    // 不得自持短 ID 记忆（那会随组件卸载丢失已扩展长度）
    expect(src).not.toMatch(/useState\([^)]*[Ss]hortId/);
  });

  it("store 里 shortIdState 是 ShortIdState 实例（类，非普通对象）", () => {
    const src = read("src/renderer/src/store.ts");
    expect(src).toContain("shortIdState: new ShortIdState()");
    expect(src).toContain('import { ShortIdState } from "@shared/nav"');
  });

  it("短 ID 只用于展示：完整 ID 仍在 title/复制口径内（短 ID 非权威标识）", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    // 组件里有「完整 ID」字样（title 里给出完整值）
    expect(src).toContain("完整 ID");
  });
});

describe("接线：既有指标字段一个不删，源标签同步", () => {
  it("steps / toolCalls / toolErrors / tokens / cacheHit / durationMs / created_at 全在", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    for (const field of [
      "run.steps",
      "run.toolCalls",
      "run.toolErrors",
      "run.tokensIn",
      "run.tokensOut",
      "run.cacheHit",
      "run.durationMs",
      "run.created_at",
    ]) {
      expect(src).toContain(field);
    }
  });

  it("cacheHit 的 null 与 0 区别对待（null 不显示，0 照常显示）", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    // null ⇒ 不渲染；>0 与 ===0 用不同配色，但不吞掉 0
    expect(src).toContain("run.cacheHit === null ? null");
    expect(src).toContain("run.cacheHit > 0");
  });

  it("产品源码与当前测试里没有遗留旧标签「本地直录 / 仅代理」", () => {
    for (const rel of [
      "src/renderer/src/components/RunList.tsx",
      "src/renderer/src/components/GlobalBar.tsx",
      "src/renderer/src/store.ts",
      "test/run-workspace.test.ts",
      "test/run-create.test.ts",
      "test/plain-chat-regression.test.ts",
    ]) {
      const code = codeLines(read(rel));
      expect(code, `${rel} 含旧标签`).not.toMatch(/本地直录|仅本地直录|仅代理/);
    }
  });

  it("「本地记录」标签在列表侧在场；store 侧不再有旧标签", () => {
    // U5 任务 3.1：创建入口不再自己刷列表，原先钉在 store 成功分支里的那句注释一并消失——
    // 标签的真实出处在 RunList 的来源过滤与徽章文案，正向核对改指那里（旧标签的负向核对见上一支）。
    expect(read("src/renderer/src/components/RunList.tsx")).toContain('["local", "本地记录"]');
    expect(read("src/renderer/src/store.ts")).not.toContain('归入"本地直录"');
  });
});
