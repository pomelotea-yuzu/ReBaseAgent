import { createTranslator } from "@rebaseagent/i18n";
import { describe, expect, it } from "vitest";
import type { AssertionResult } from "../src/assertions.js";
import { TraceTestConfigError } from "../src/errors.js";
import { assertionDetailText, configErrorText, humanReportLines } from "../src/report.js";
import type { TestResult } from "../src/run-test.js";

const ZH = createTranslator({ locale: "zh-CN" });
const EN = createTranslator({ locale: "en-US" });

function assertion(over: Partial<AssertionResult>): AssertionResult {
  return { type: "span.field", passed: false, detail: "original detail", ...over };
}

function result(over: Partial<TestResult> = {}): TestResult {
  return {
    name: "case",
    definitionPath: "/tmp/case.json",
    tracePath: "/tmp/trace.jsonl",
    mode: "cassette",
    status: "failed",
    runId: "run-1",
    rerun: null,
    configDrift: null,
    requestDrift: [],
    argsDrift: [],
    alignment: null,
    assertions: [],
    redact: [],
    newRecord: null,
    ...over,
  };
}

describe("trace-test 人类报告：断言差异按语言投影", () => {
  it("outcome / field / count / shape 的中英句子独立成形", () => {
    const outcome = assertion({
      type: "run.outcome",
      display: { kind: "outcome", expected: "error", actual: null },
    });
    expect(assertionDetailText(outcome, ZH)).toBe('终止 reason 不同：期望 "error"，实际 "（无）"');
    expect(assertionDetailText(outcome, EN)).toBe(
      'Termination reason differs: expected "error", actual "(none)"',
    );

    const field = assertion({
      display: {
        kind: "field-mismatch",
        index: 2,
        spanKind: "tool.invoke",
        where: "tool=read_file",
        id: "s_03",
        field: "tool",
        expected: '"write_file"',
        actual: '"read_file"',
      },
    });
    expect(assertionDetailText(field, ZH)).toContain('字段 "tool" 不相等');
    expect(assertionDetailText(field, EN)).toContain('field "tool" differs');

    const count = assertion({
      type: "span.count",
      display: {
        kind: "count",
        count: 1,
        constraint: "min",
        value: 2,
        selector: '{"kind":"tool.invoke"}',
      },
    });
    expect(assertionDetailText(count, ZH)).toContain("期望至少 2 个");
    expect(assertionDetailText(count, EN)).toContain("expected at least 2");

    const shape = assertion({
      type: "trace.shape",
      display: { kind: "shape", index: 4, field: "parent" },
    });
    expect(assertionDetailText(shape, ZH)).toBe("结构对齐失败：第 4 个 span 的 parent 不一致");
    expect(assertionDetailText(shape, EN)).toBe(
      "Structural alignment failed: span 4 differs in parent",
    );
  });

  it("没有 display 时退回既有 detail（机器契约原文）", () => {
    const legacy = assertion({ detail: "原始说明", display: undefined });
    expect(assertionDetailText(legacy, ZH)).toBe("原始说明");
    expect(assertionDetailText(legacy, EN)).toBe("原始说明");
  });
});

describe("trace-test 人类报告：漂移、状态与汇总", () => {
  it("配置/请求/参数漂移与状态行按语言输出", () => {
    const report = result({
      status: "failed",
      configDrift: { recorded: "sha256:a", current: "sha256:b" },
      requestDrift: [
        {
          callIndex: 1,
          firstDiff: 0,
          detail: "第 0 条消息结构不同",
          display: { recorded: "system", current: "user" },
        },
      ],
      argsDrift: [
        { tool: "read_file", sequence: 2, recordedArgs: { path: "a" }, currentArgs: { file: "a" } },
      ],
      assertions: [
        assertion({
          type: "run.outcome",
          display: { kind: "outcome", expected: "error", actual: "completed" },
        }),
      ],
    });

    const zh = humanReportLines([report], 0, ZH).join("\n");
    expect(zh).toContain("失败  case (cassette)");
    expect(zh).toContain("配置漂移：recorded=sha256:a current=sha256:b");
    expect(zh).toContain("请求漂移：第 2 次调用");
    expect(zh).toContain('录制="system"，当前="user"');
    expect(zh).toContain("参数漂移：read_file 第 2 次调用");
    expect(zh).toContain("合计 1：0 通过 / 1 失败 / 0 配置错误");

    const en = humanReportLines([report], 0, EN).join("\n");
    expect(en).toContain("FAIL  case (cassette)");
    expect(en).toContain("config drift: recorded=sha256:a current=sha256:b");
    expect(en).toContain("request drift: call 2");
    expect(en).toContain('recorded="system", current="user"');
    expect(en).toContain("args drift: read_file call 2");
    expect(en).toContain("Total 1: 0 passed / 1 failed / 0 configuration errors");
  });

  it("配置错误：稳定码 + 参数 + 原始详情按语言成形", () => {
    const error = new TraceTestConfigError(
      "DEFINITION_READ_FAILED",
      { file: "case.json" },
      "ENOENT",
    );
    expect(configErrorText(error, ZH)).toBe("无法读取测试定义 case.json：ENOENT");
    expect(configErrorText(error, EN)).toBe("Could not read test definition case.json: ENOENT");
  });
});
