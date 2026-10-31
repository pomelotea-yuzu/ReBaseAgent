import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { Assertion, Selector } from "./definition.js";
import { deepEqual, formatValue } from "./format.js";

/** 人类报告用的结构化差异；不进入 JSON 报告（detail 字段才是机器契约） */
export type AssertionDisplay =
  | { readonly kind: "outcome"; readonly expected: string; readonly actual: string | null }
  | { readonly kind: "no-span"; readonly selector: string }
  | { readonly kind: "nth"; readonly nth: number; readonly total: number }
  | {
      readonly kind: "field-missing";
      readonly index: number;
      readonly spanKind: string;
      readonly where: string;
      readonly id: string;
      readonly field: string;
    }
  | {
      readonly kind: "field-mismatch";
      readonly index: number;
      readonly spanKind: string;
      readonly where: string;
      readonly id: string;
      readonly field: string;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly kind: "count";
      readonly count: number;
      readonly constraint: "equals" | "min" | "max";
      readonly value: number;
      readonly selector: string;
    }
  | { readonly kind: "shape"; readonly index: number; readonly field: string }
  | { readonly kind: "shape-failed" };

/** 单条断言的求值结果（断言失败是数据，不是异常） */
export interface AssertionResult {
  type: Assertion["type"];
  passed: boolean;
  /** 失败（或值得说明）时的定位与差异摘要；已脱敏、已截断；JSON 报告的既有字段 */
  detail: string;
  /** 人类报告的结构化投影；序列化报告必须省略本字段 */
  display?: AssertionDisplay;
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

function spanWhere(span: SpanLine): string {
  return span.kind === "tool.invoke"
    ? `tool=${span.tool}`
    : span.kind === "agent.step"
      ? `n=${span.n}`
      : "llm.call";
}

function describeSpan(span: SpanLine, index: number): string {
  return `第 ${index} 个 span（${span.kind}, ${spanWhere(span)}, id=${span.id}）`;
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
        ...(passed
          ? {}
          : { display: { kind: "outcome", expected: assertion.equals, actual: outcome ?? null } }),
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
        ...(passed
          ? {}
          : {
              display: {
                kind: "no-span",
                selector: formatValue(assertion.selector, redactKeys),
              },
            }),
      };
    }

    case "span.field": {
      const matches = matchSpans(spans, assertion.selector);
      if (matches.length === 0) {
        return {
          type: assertion.type,
          passed: false,
          detail: `无匹配 span（selector=${formatValue(assertion.selector, redactKeys)}）；缺失匹配即失败`,
          display: {
            kind: "no-span",
            selector: formatValue(assertion.selector, redactKeys),
          },
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
          display: {
            kind: "nth",
            nth: assertion.nth ?? 1,
            total: matches.length,
          },
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
            display: {
              kind: "field-missing",
              index: spanIndex,
              spanKind: span.kind,
              where: spanWhere(span),
              id: span.id,
              field: assertion.field,
            },
          };
        }
        if (!deepEqual(value, assertion.equals)) {
          return {
            type: assertion.type,
            passed: false,
            detail: `${describeSpan(span, spanIndex)} 字段 "${assertion.field}" 不相等：期望 ${formatFieldValue(assertion.equals, assertion.field, redactKeys)}，实际 ${formatFieldValue(value, assertion.field, redactKeys)}`,
            display: {
              kind: "field-mismatch",
              index: spanIndex,
              spanKind: span.kind,
              where: spanWhere(span),
              id: span.id,
              field: assertion.field,
              expected: formatFieldValue(assertion.equals, assertion.field, redactKeys),
              actual: formatFieldValue(value, assertion.field, redactKeys),
            },
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
      let passed = true;
      let why = "";
      let constraint: { kind: "equals" | "min" | "max"; value: number } | null = null;
      if (assertion.equals !== undefined && count !== assertion.equals) {
        passed = false;
        why = `期望恰好 ${assertion.equals} 个`;
        constraint = { kind: "equals", value: assertion.equals };
      }
      if (assertion.min !== undefined && count < assertion.min) {
        passed = false;
        why = `期望至少 ${assertion.min} 个`;
        constraint = { kind: "min", value: assertion.min };
      }
      if (assertion.max !== undefined && count > assertion.max) {
        passed = false;
        why = `期望至多 ${assertion.max} 个`;
        constraint = { kind: "max", value: assertion.max };
      }
      return {
        type: assertion.type,
        passed,
        detail: passed
          ? `命中 ${count} 个 span，满足数量约束`
          : `命中 ${count} 个 span，${why}（selector=${formatValue(assertion.selector, redactKeys)}）`,
        ...(constraint === null
          ? {}
          : {
              display: {
                kind: "count" as const,
                count,
                constraint: constraint.kind,
                value: constraint.value,
                selector: formatValue(assertion.selector, redactKeys),
              },
            }),
      };
    }

    case "trace.shape": {
      // 占位：run-test 依据对齐结果覆盖本行（对齐需要 RerunResult，不在此求值）
      return { type: assertion.type, passed: false, detail: "trace.shape 由运行时对齐结果求值" };
    }
  }
}
