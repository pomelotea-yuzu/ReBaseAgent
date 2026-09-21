import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRunText } from "@rebaseagent/trace-sdk";
import { classifyOutcome, isKnownReason, outcomeBadgeClass } from "@shared/outcome";
import { describe, expect, it } from "vitest";

/**
 * U1（refactor-run-workspace）任务 2.1：共用结局分类的单元测试。
 *
 * 判据来源：desktop-ui delta
 *   - 「run 列表从 traces 目录扫描派生」的状态段：状态同时考虑封存状态与终止原因，
 *     error 不显示为正常绿色、限制可辨认、未知保留原值、crashed 显示运行中断。
 *   - branch-tree delta 的节点结局段：节点按封存运行的终止原因区分结局、
 *     对中断和未知原因诚实降级、不把已恢复的工具错误当作终止失败。
 *
 * 覆盖要求（任务措辞）：封存状态不冒充正常结束 / 崩溃的 run / 限制中止与中断如实展示 /
 * 摘要未知原因 / 详情 event/reason 矛盾 / 不放宽 schema 或扩充 status 枚举。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../.rebaseagent/u1-fixtures");

describe("classifyOutcome：按 status + reason 分类，不扩充 status 枚举", () => {
  it("completed ⇒ 已结束（success，normalEnd）", () => {
    const outcome = classifyOutcome({ status: "completed", reason: "completed" });
    expect(outcome).toMatchObject({
      kind: "completed",
      label: "已结束",
      tone: "success",
      normalEnd: true,
    });
  });

  it("error ⇒ 出错终止，语义色为红（不是正常绿），且不属于正常结束", () => {
    const outcome = classifyOutcome({ status: "completed", reason: "error" });
    expect(outcome.kind).toBe("error");
    expect(outcome.tone).toBe("danger");
    expect(outcome.normalEnd).toBe(false);
    expect(outcomeBadgeClass(outcome.tone)).toContain("red");
  });

  it("max_iterations / budget_exceeded ⇒ 琥珀色限制，可辨认", () => {
    const maxIter = classifyOutcome({ status: "completed", reason: "max_iterations" });
    const budget = classifyOutcome({ status: "completed", reason: "budget_exceeded" });
    expect(maxIter).toMatchObject({ kind: "max_iterations", label: "达到迭代上限", tone: "warn" });
    expect(budget).toMatchObject({ kind: "budget_exceeded", label: "超出预算", tone: "warn" });
    expect(maxIter.label).not.toBe(budget.label); // 两种限制可辨认
    expect(outcomeBadgeClass("warn")).toContain("amber");
  });

  it("aborted ⇒ 已中止（中性）", () => {
    expect(classifyOutcome({ status: "completed", reason: "aborted" })).toMatchObject({
      kind: "aborted",
      label: "已中止",
      tone: "neutral",
    });
  });

  it("crashed（无终止事件）⇒ 运行中断，不当作执行中或读取错误", () => {
    const outcome = classifyOutcome({ status: "crashed", reason: null });
    expect(outcome).toMatchObject({ kind: "interrupted", label: "运行中断", normalEnd: false });
  });

  it("crashed 即便残留 reason 也判中断（无结束记录就是无结束记录）", () => {
    // 手工编辑出的异常组合：status=crashed 却带 completed reason
    const outcome = classifyOutcome({ status: "crashed", reason: "completed" });
    expect(outcome.kind).toBe("interrupted");
    expect(outcome.normalEnd).toBe(false);
  });

  it("completed 却无 reason（数据异常）⇒ 结束原因未知，不冒充已完成", () => {
    const outcome = classifyOutcome({ status: "completed", reason: null });
    expect(outcome).toMatchObject({ kind: "unknown", label: "结束原因未知", normalEnd: false });
  });

  it("未知 reason 保留原值，不回退成已完成", () => {
    const outcome = classifyOutcome({ status: "completed", reason: "some_future_reason" });
    expect(outcome.kind).toBe("unknown");
    expect(outcome.reason).toBe("some_future_reason"); // 原值保留，供排查
    expect(outcome.label).toBe("结束原因未知");
    expect(outcome.tone).not.toBe("success");
  });

  it("语义色类名是静态完整串（不含模板占位，Tailwind 可扫描）", () => {
    for (const tone of ["success", "danger", "warn", "neutral"] as const) {
      const cls = outcomeBadgeClass(tone);
      expect(cls).not.toContain("$");
      expect(cls).toMatch(/^(bg|text)-/);
    }
  });

  it("isKnownReason：只认既有枚举，未知/空为 false", () => {
    expect(isKnownReason("completed")).toBe(true);
    expect(isKnownReason("budget_exceeded")).toBe(true);
    expect(isKnownReason("future_reason")).toBe(false);
    expect(isKnownReason(null)).toBe(false);
  });
});

describe("结局文案一致性：列表、概览、树节点共用同一份标签", () => {
  it("同一 reason 在任何调用路径下得到同一 label（没有第二份文案）", () => {
    const cases: Array<[string, string]> = [
      ["completed", "已结束"],
      ["error", "出错终止"],
      ["max_iterations", "达到迭代上限"],
      ["budget_exceeded", "超出预算"],
      ["aborted", "已中止"],
    ];
    for (const [reason, label] of cases) {
      expect(classifyOutcome({ status: "completed", reason }).label, reason).toBe(label);
    }
  });
});

describe("与 1.1 结局 fixture 交叉核对（判据有牙）", () => {
  const expectations = JSON.parse(
    readFileSync(resolve(FIXTURE_DIR, "EXPECTED-OUTCOMES.json"), "utf8"),
  ) as Record<
    string,
    { status: "completed" | "crashed"; lastReason: string | null; outcome: string }
  >;

  it("每份 fixture 的真实 status + reason 经分类后与预期结局表一致", () => {
    for (const [name, expected] of Object.entries(expectations)) {
      const file = resolve(FIXTURE_DIR, `${name}.jsonl`);
      if (!existsSync(file)) continue; // fixture 未生成时跳过（生成器另有用例保证存在）
      const text = readFileSync(file, "utf8");
      const record = parseRunText(text.split("\n"));
      const lastEvent = record.events[record.events.length - 1] ?? null;
      const outcome = classifyOutcome({
        status: record.status,
        reason: lastEvent?.reason ?? null,
      });
      expect(outcome.kind, `${name} 的结局分类`).toBe(expected.outcome);
      expect(outcome.reason, `${name} 的原始 reason`).toBe(expected.lastReason);
    }
  });

  it("工具曾出错后正常结束的 run 仍判正常结束（错误是数据不是异常）", () => {
    // normal fixture 末步正常完成；工具错误单独计数，不影响终止结局
    const file = resolve(FIXTURE_DIR, "u1-ok.jsonl");
    if (!existsSync(file)) return;
    const record = parseRunText(readFileSync(file, "utf8").split("\n"));
    const lastEvent = record.events[record.events.length - 1] ?? null;
    const outcome = classifyOutcome({ status: record.status, reason: lastEvent?.reason ?? null });
    expect(outcome.kind).toBe("completed");
    expect(outcome.normalEnd).toBe(true);
  });
});
