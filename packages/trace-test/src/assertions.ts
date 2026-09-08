import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { Assertion, Selector } from "./definition.js";
import { deepEqual, formatValue } from "./format.js";

/** 单条断言的求值结果（断言失败是数据，不是异常） */
export interface AssertionResult {
  type: Assertion["type"];
  passed: boolean;
  /** 失败（或值得说明）时的定位与差异摘要；已脱敏、已截断 */
  detail: string;
}

/** selector 各条件 AND 叠加，返回语义序下的命中集合 */
export function matchSpans(spans: SpanLine[], selector: Selector): SpanLine[] {
  return spans.filter((span) => {
    if (selector.kind !== undefined && span.kind !== selector.kind) {
      return false;
    }
    if (
      selector.tool !== undefined &&
      !(span.kind === "tool.invoke" && span.tool === selector.tool)
    ) {
      return false;
    }
    if (selector.n !== undefined && !(span.kind === "agent.step" && span.n === selector.n)) {
      return false;
    }
    if (selector.id !== undefined && span.id !== selector.id) {
      return false;
    }
    return true;
  });
}

/** 点路径取值；缺失返回 NOT_FOUND 哨兵（缺失 ≠ 值为 undefined） */
const NOT_FOUND = Symbol("field-not-found");
function fieldAt(span: SpanLine, path: string): unknown {
  let cur: unknown = span;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) {
      return NOT_FOUND;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function describeSpan(span: SpanLine, index: number): string {
  const where =
    span.kind === "tool.invoke"
      ? `tool=${span.tool}`
      : span.kind === "agent.step"
        ? `n=${span.n}`
        : "llm.call";
  return `第 ${index} 个 span（${span.kind}, ${where}, id=${span.id}）`;
}

/** 字段值格式化：字段末段 key 命中 redact 列表时整个值掩码（值本身可能就是敏感原文） */
function formatFieldValue(value: unknown, field: string, redactKeys: readonly string[]): string {
  const lastKey = field.split(".").pop() ?? "";
  if (redactKeys.some((k) => k.toLowerCase() === lastKey.toLowerCase())) {
    return '"***"';
  }
  return formatValue(value, redactKeys);
}

/**
 * 断言求值（2.2）。`outcome` 传目标轨迹的终止 reason（卡带模式=新 run，
 * 静态模式=录制 run）；trace.shape 断言由 run-test 结合对齐结果处理，不在此求值。
 * 量词契约：exists 恒 any（零匹配=失败）；field 默认 all，first/nth 显式声明
 * （nth 用 selector.n，1 起）；count 走 min/max/equals 阈值。缺失匹配一律失败。
 */
export function evaluateAssertions(
  assertions: Assertion[],
  spans: SpanLine[],
  outcome: string | undefined,
  redactKeys: readonly string[] = [],
): AssertionResult[] {
  const results: AssertionResult[] = [];
  for (const assertion of assertions) {
    results.push(evaluateOne(assertion, spans, outcome, redactKeys));
  }
  return results;
}

function evaluateOne(
  assertion: Assertion,
  spans: SpanLine[],
  outcome: string | undefined,
  redactKeys: readonly string[],
): AssertionResult {
  switch (assertion.type) {
    case "run.outcome": {
      const passed = outcome === assertion.equals;
      return {
        type: assertion.type,
        passed,
        detail: passed
          ? `outcome=${outcome}`
          : `终止 reason 不同：期望 "${assertion.equals}"，实际 "${outcome ?? "<无>"}"`,
      };
    }

    case "span.exists": {
      const matches = matchSpans(spans, assertion.selector);
      const passed = matches.length > 0; // quantifier 恒 any
      return {
        type: assertion.type,
        passed,
        detail: passed
          ? `命中 ${matches.length} 个 span`
          : `无匹配 span（selector=${formatValue(assertion.selector, redactKeys)}）；缺失匹配即失败`,
      };
    }

    case "span.field": {
      const matches = matchSpans(spans, assertion.selector);
      if (matches.length === 0) {
        return {
          type: assertion.type,
          passed: false,
          detail: `无匹配 span（selector=${formatValue(assertion.selector, redactKeys)}）；缺失匹配即失败`,
        };
      }
      const quantifier = assertion.quantifier ?? "all";
      const picked =
        quantifier === "first"
          ? [matches[0]]
          : quantifier === "nth"
            ? [matches[(assertion.nth ?? 1) - 1]].filter((s) => s !== undefined)
            : matches;

      if (picked.length === 0) {
        return {
          type: assertion.type,
          passed: false,
          detail: `quantifier=nth（第 ${assertion.nth} 个）越界：命中总数 ${matches.length}`,
        };
      }

      for (let i = 0; i < picked.length; i++) {
        const span = picked[i];
        const spanIndex = spans.indexOf(span);
        const value = fieldAt(span, assertion.field);
        if (value === NOT_FOUND) {
          return {
            type: assertion.type,
            passed: false,
            detail: `${describeSpan(span, spanIndex)} 不存在字段 "${assertion.field}"`,
          };
        }
        if (!deepEqual(value, assertion.equals)) {
          return {
            type: assertion.type,
            passed: false,
            detail: `${describeSpan(span, spanIndex)} 字段 "${assertion.field}" 不相等：期望 ${formatFieldValue(assertion.equals, assertion.field, redactKeys)}，实际 ${formatFieldValue(value, assertion.field, redactKeys)}`,
          };
        }
      }
      return {
        type: assertion.type,
        passed: true,
        detail:
          picked.length === 1
            ? `${describeSpan(picked[0], spans.indexOf(picked[0]))} 字段 "${assertion.field}" 相等`
            : `${picked.length} 个匹配 span 的字段 "${assertion.field}" 全部相等`,
      };
    }

    case "span.count": {
      const matches = matchSpans(spans, assertion.selector);
      const count = matches.length;
      const constraints: string[] = [];
      let passed = true;
      let why = "";
      if (assertion.equals !== undefined && count !== assertion.equals) {
        passed = false;
        why = `期望恰好 ${assertion.equals} 个`;
      }
      if (assertion.min !== undefined && count < assertion.min) {
        passed = false;
        why = `期望至少 ${assertion.min} 个`;
      }
      if (assertion.max !== undefined && count > assertion.max) {
        passed = false;
        why = `期望至多 ${assertion.max} 个`;
      }
      return {
        type: assertion.type,
        passed,
        detail: passed
          ? `命中 ${count} 个 span，满足数量约束`
          : `命中 ${count} 个 span，${why}（selector=${formatValue(assertion.selector, redactKeys)}）`,
      };
    }

    case "trace.shape": {
      // 占位：run-test 依据对齐结果覆盖本行（对齐需要 RerunResult，不在此求值）
      return { type: assertion.type, passed: false, detail: "trace.shape 由运行时对齐结果求值" };
    }
  }
}
