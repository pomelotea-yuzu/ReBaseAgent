import {
  ShortIdState,
  collapseWhitespace,
  computeShortIds,
  deriveNavLabel,
  filterRuns,
  matchesSearch,
  matchesSource,
  taskSummary,
} from "@shared/nav";
import { describe, expect, it } from "vitest";

/**
 * U1（refactor-run-workspace）任务 2.4：任务展示/搜索与稳定短 ID。
 *
 * 判据来源：desktop-ui delta「run 列表从 traces 目录扫描派生」三个场景：
 *   - 完整任务和 ID 搜索
 *   - 同名运行的短 ID 稳定可辨（后缀包含、碰撞扩长、刷新删除碰撞项、筛选不重编号）
 *   - 长模型和空任务的导航摘要
 */

describe("taskSummary / collapseWhitespace：折叠空白、限长，不改原值", () => {
  it("折叠连续空白（含换行、制表、全角空格）并去首尾", () => {
    expect(collapseWhitespace("  修复\n\n\t登录  页面　空白 ")).toBe("修复 登录 页面 空白");
  });

  it("超长任务截断加省略号；短任务原样", () => {
    expect(taskSummary("短任务")).toBe("短任务");
    const long = "字".repeat(100);
    const summary = taskSummary(long, 80);
    expect(summary).toHaveLength(81); // 80 字 + 省略号
    expect(summary.endsWith("…")).toBe(true);
  });

  it("限长只影响展示：折叠后的原值仍可用（search 不受限长影响）", () => {
    const long = `${"前".repeat(90)}关键词在后`;
    const run = { id: "r1", task: long };
    // 关键词在截断之外，但搜索应命中（匹配完整原值）
    expect(matchesSearch(run, "关键词在后")).toBe(true);
  });
});

describe("matchesSearch：匹配完整 task/id，大小写不敏感", () => {
  const run = { id: "run_AbC123", task: "修复 登录 页面的空白" };

  it("空查询匹配全部", () => {
    expect(matchesSearch(run, "")).toBe(true);
    expect(matchesSearch(run, "   ")).toBe(true);
  });

  it("匹配任务片段（大小写不敏感）", () => {
    expect(matchesSearch(run, "登录")).toBe(true);
    expect(matchesSearch(run, "登录 页面")).toBe(true);
  });

  it("匹配完整 ID 片段", () => {
    expect(matchesSearch(run, "abc123")).toBe(true); // 大小写不敏感
    expect(matchesSearch(run, "run_")).toBe(true);
  });

  it("不匹配无关内容", () => {
    expect(matchesSearch(run, "注册")).toBe(false);
  });
});

describe("computeShortIds：稳定、可辨、后缀包含处理", () => {
  it("无碰撞时取末尾 8 字符", () => {
    const ids = ["run_aaaaaaaa11111111", "run_bbbbbbbb22222222"];
    const short = computeShortIds(ids);
    expect(short.get("run_aaaaaaaa11111111")).toBe("11111111");
    expect(short.get("run_bbbbbbbb22222222")).toBe("22222222");
  });

  it("同尾片段 ⇒ 逐字符延长直到唯一", () => {
    // 末尾 8 位相同（都是 aaaaaaaa），必须延长才能区分
    const ids = ["run_x000000aaaaaaaa", "run_y000000aaaaaaaa"];
    const short = computeShortIds(ids);
    const a = short.get("run_x000000aaaaaaaa")!;
    const b = short.get("run_y000000aaaaaaaa")!;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(8);
    expect(b.length).toBeGreaterThan(8);
  });

  it("后缀包含：一条 ID 是另一条的后缀时，较短者继续延长（关键陷阱）", () => {
    // 与 1.2 fixture 同类的陷阱：共享前缀会掩盖「后缀关系」
    const ids = ["zzzz0000a1b2c3d4", "yyyy0000a1b2c3d4", "0000a1b2c3d4"];
    const short = computeShortIds(ids);
    const values = [...short.values()];
    // 三者必须互不相同
    expect(new Set(values).size).toBe(3);
    // 最短的那条（0000a1b2c3d4）其 8 位后缀恰是另两条的尾段 ⇒ 它必须延长
    expect(short.get("0000a1b2c3d4")).not.toBe("a1b2c3d4");
    // 另两条的 8 位后缀相同，也必须延长区分
    expect(short.get("zzzz0000a1b2c3d4")).not.toBe("a1b2c3d4");
    expect(short.get("yyyy0000a1b2c3d4")).not.toBe("a1b2c3d4");
  });

  it("结果与输入顺序无关（按完整 ID 排序计算）", () => {
    const ids = ["run_x0000000aaaaaaaa", "run_y0000000aaaaaaab"];
    const forward = computeShortIds(ids);
    const reversed = computeShortIds([...ids].reverse());
    expect(forward.get(ids[0]!)).toBe(reversed.get(ids[0]!));
    expect(forward.get(ids[1]!)).toBe(reversed.get(ids[1]!));
  });

  it("全部唯一时取值稳定，与集合中其它无关 ID 的增删无关", () => {
    const base = ["aaaa1111", "bbbb2222"];
    const before = computeShortIds(base);
    const after = computeShortIds([...base, "cccc3333"]);
    expect(after.get("aaaa1111")).toBe(before.get("aaaa1111"));
    expect(after.get("bbbb2222")).toBe(before.get("bbbb2222"));
  });
});

describe("ShortIdState：长度只增不减（刷新删除碰撞项不缩短）", () => {
  it("碰撞后延长，删除碰撞项后不缩短", () => {
    const state = new ShortIdState();
    const withCollision = ["run_x000000aaaaaaaa", "run_y000000aaaaaaaa"];
    const first = state.update(withCollision);
    const len = first.get("run_x000000aaaaaaaa")!.length;
    expect(len).toBeGreaterThan(8);

    // 碰撞项被删除（刷新后只剩一条）
    const after = state.update(["run_x000000aaaaaaaa"]);
    const afterLen = after.get("run_x000000aaaaaaaa")!.length;
    // 不缩短：仍保留之前延长后的长度
    expect(afterLen).toBe(len);
  });

  it("新出现碰撞时，相关项在下次计算延长", () => {
    const state = new ShortIdState();
    const before = state.update(["run_x000000aaaaaaaa"]);
    expect(before.get("run_x000000aaaaaaaa")).toBe("aaaaaaaa");

    const after = state.update(["run_x000000aaaaaaaa", "run_y000000aaaaaaaa"]);
    expect(after.get("run_x000000aaaaaaaa")!.length).toBeGreaterThan(8);
    expect(after.get("run_y000000aaaaaaaa")!.length).toBeGreaterThan(8);
    expect(after.get("run_x000000aaaaaaaa")).not.toBe(after.get("run_y000000aaaaaaaa"));
  });

  it("筛选不重编号：子集计算后已记录长度保持（用 update 全量后取子集）", () => {
    const state = new ShortIdState();
    state.update(["run_x000000aaaaaaaa", "run_y000000aaaaaaaa"]);
    const xLen = state
      .update(["run_x000000aaaaaaaa", "run_y000000aaaaaaaa"])
      .get("run_x000000aaaaaaaa")!.length;
    // 再次全量计算长度不变（幂等）
    expect(
      state.update(["run_x000000aaaaaaaa", "run_y000000aaaaaaaa"]).get("run_x000000aaaaaaaa")!
        .length,
    ).toBe(xLen);
  });
});

describe("deriveNavLabel：空任务与缺失模型的导航摘要", () => {
  it("空任务 ⇒ 回退为来源/时间/短 ID，并标 isFallback", () => {
    const label = deriveNavLabel({ task: "   ", model: "gpt-4o" }, "abcd1234", {
      time: "09-21 10:00",
      source: "本地记录",
    });
    expect(label.isFallback).toBe(true);
    expect(label.title).toBe("本地记录 · 09-21 10:00 · abcd1234");
  });

  it("缺失模型 ⇒ 显示「未记录」，任务正常展示", () => {
    const label = deriveNavLabel({ task: "修复登录", model: "" }, "abcd1234", {
      time: "09-21 10:00",
      source: "本地记录",
    });
    expect(label.model).toBe("未记录");
    expect(label.isFallback).toBe(false);
    expect(label.title).toBe("修复登录");
  });

  it("超长模型原值保留（换行由 CSS，这里不做截断）", () => {
    const longModel = `very-long-model-${"x".repeat(80)}`;
    const label = deriveNavLabel({ task: "t", model: longModel }, "abcd1234", {
      time: "t",
      source: "s",
    });
    expect(label.model).toBe(longModel);
  });
});

describe("filterRuns：搜索与来源求交集，不改原值", () => {
  const runs = [
    { id: "run_a", task: "修复登录", source: "proxy" as const },
    { id: "run_b", task: "修复登录", source: null },
    { id: "run_c", task: "新增注册", source: null },
  ];

  it("全部来源 + 空查询 ⇒ 全部", () => {
    expect(filterRuns(runs, "", "all")).toHaveLength(3);
  });

  it("来源过滤：proxy 只要代理录制；local 只要非代理（含无 source 老文件）", () => {
    expect(filterRuns(runs, "", "proxy").map((r) => r.id)).toEqual(["run_a"]);
    expect(filterRuns(runs, "", "local").map((r) => r.id)).toEqual(["run_b", "run_c"]);
  });

  it("搜索与来源求交集", () => {
    expect(filterRuns(runs, "修复", "local").map((r) => r.id)).toEqual(["run_b"]);
    expect(filterRuns(runs, "修复", "proxy").map((r) => r.id)).toEqual(["run_a"]);
  });

  it("不修改原 task（返回原对象引用）", () => {
    const result = filterRuns(runs, "修复", "all");
    expect(result[0]).toBe(runs[0]);
    expect(result[0]?.task).toBe("修复登录");
  });

  it("matchesSource 单独可用（无 source 老文件归本地记录）", () => {
    expect(matchesSource({ source: null }, "local")).toBe(true);
    expect(matchesSource({ source: null }, "proxy")).toBe(false);
    expect(matchesSource({ source: "proxy" }, "all")).toBe(true);
  });
});
