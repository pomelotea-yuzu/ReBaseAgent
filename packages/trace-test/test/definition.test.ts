import { describe, expect, it } from "vitest";
import {
  AssertionSchema,
  DEFINITION_FORMAT_VERSION,
  TraceTestDefinitionSchema,
} from "../src/definition.js";

describe("TraceTestDefinitionSchema", () => {
  it("合法定义通过，assertions 缺省为空数组", () => {
    const parsed = TraceTestDefinitionSchema.parse({
      format_version: 1,
      name: "readme-agent",
      trace: "fixtures/readme.jsonl",
    });
    expect(parsed.assertions).toEqual([]);
  });

  it("不支持的 format_version 被拒绝（unknown version → 配置错误）", () => {
    const result = TraceTestDefinitionSchema.safeParse({
      format_version: 2,
      name: "x",
      trace: "t.jsonl",
    });
    expect(result.success).toBe(false);
    expect(DEFINITION_FORMAT_VERSION).toBe(1);
  });

  it("name / trace 为必填", () => {
    expect(
      TraceTestDefinitionSchema.safeParse({ format_version: 1, trace: "t.jsonl" }).success,
    ).toBe(false);
    expect(TraceTestDefinitionSchema.safeParse({ format_version: 1, name: "x" }).success).toBe(
      false,
    );
  });

  it("span.count 无任何数量约束被拒绝", () => {
    const result = AssertionSchema.safeParse({
      type: "span.count",
      selector: { kind: "tool.invoke" },
    });
    expect(result.success).toBe(false);
  });

  it("span.field 的 quantifier=nth 缺 nth 序号被拒绝", () => {
    const ok = AssertionSchema.safeParse({
      type: "span.field",
      selector: { kind: "tool.invoke" },
      field: "tool",
      equals: "read_file",
      quantifier: "nth",
      nth: 2,
    });
    const bad = AssertionSchema.safeParse({
      type: "span.field",
      selector: { kind: "tool.invoke" },
      field: "tool",
      equals: "read_file",
      quantifier: "nth",
    });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it("span.exists 拒绝 quantifier=all（存在性断言恒为 any，避免语义静默变弱）", () => {
    const bad = AssertionSchema.safeParse({
      type: "span.exists",
      selector: { kind: "tool.invoke" },
      quantifier: "all",
    });
    const ok = AssertionSchema.safeParse({
      type: "span.exists",
      selector: { kind: "tool.invoke" },
    });
    expect(bad.success).toBe(false);
    expect(ok.success).toBe(true);
  });

  it("空 selector 被拒绝；未知断言类型被拒绝", () => {
    expect(AssertionSchema.safeParse({ type: "span.exists", selector: {} }).success).toBe(false);
    expect(
      AssertionSchema.safeParse({ type: "span.magic", selector: { kind: "tool.invoke" } }).success,
    ).toBe(false);
  });

  it("run.outcome 只接受 reason 五枚举", () => {
    expect(AssertionSchema.safeParse({ type: "run.outcome", equals: "completed" }).success).toBe(
      true,
    );
    expect(AssertionSchema.safeParse({ type: "run.outcome", equals: "stopped" }).success).toBe(
      false,
    );
  });
});
