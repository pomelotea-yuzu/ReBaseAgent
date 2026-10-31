import type { Translator } from "@rebaseagent/i18n";
import type { AssertionDisplay, AssertionResult } from "./assertions.js";
import type { TraceTestConfigError } from "./errors.js";
import { formatValue } from "./format.js";
import type { TestResult } from "./run-test.js";

/**
 * 人类可读报告的语言投影（i18n 5.5）。
 *
 * `TestResult`/`AssertionResult.detail`/drift/alignment 是既有 JSON 契约，
 * 不随语言变化；本模块只把其中的结构化事实投影成当前语言的句子。
 * JSON 报告不得包含这里生成的文案（CLI 的 toJsonResult 明确挑选字段）。
 */

function assertionDisplayText(display: AssertionDisplay, translator: Translator): string {
  switch (display.kind) {
    case "outcome":
      return translator.t("cli.traceAssertOutcome", {
        expected: display.expected,
        actual: display.actual ?? translator.t("cli.traceAssertActualNone"),
      });
    case "no-span":
      return translator.t("cli.traceAssertNoSpan", { selector: display.selector });
    case "nth":
      return translator.t("cli.traceAssertNth", { nth: display.nth, total: display.total });
    case "field-missing":
      return translator.t("cli.traceAssertFieldMissing", {
        index: display.index,
        kind: display.spanKind,
        where: display.where,
        id: display.id,
        field: display.field,
      });
    case "field-mismatch":
      return translator.t("cli.traceAssertFieldMismatch", {
        index: display.index,
        kind: display.spanKind,
        where: display.where,
        id: display.id,
        field: display.field,
        expected: display.expected,
        actual: display.actual,
      });
    case "count": {
      const key =
        display.constraint === "equals"
          ? "cli.traceAssertCountEquals"
          : display.constraint === "min"
            ? "cli.traceAssertCountMin"
            : "cli.traceAssertCountMax";
      return translator.t(key, {
        count: display.count,
        value: display.value,
        selector: display.selector,
      });
    }
    case "shape":
      return translator.t("cli.traceAssertShapeMismatch", {
        index: display.index,
        field: display.field,
      });
    case "shape-failed":
      return translator.t("cli.traceAssertShapeFailed");
  }
}

export function assertionDetailText(assertion: AssertionResult, translator: Translator): string {
  return assertion.display === undefined
    ? assertion.detail
    : assertionDisplayText(assertion.display, translator);
}

export function configErrorText(error: TraceTestConfigError, translator: Translator): string {
  return translator.t(error.messageKey, {
    ...error.params,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  });
}

function driftBadge(result: TestResult, translator: Translator): string {
  const parts: string[] = [];
  if (result.configDrift !== null) parts.push(translator.t("cli.traceDriftBadgeConfig"));
  if (result.requestDrift.length > 0) {
    parts.push(translator.t("cli.traceDriftBadgeRequest", { count: result.requestDrift.length }));
  }
  if (result.argsDrift.length > 0) {
    parts.push(translator.t("cli.traceDriftBadgeArgs", { count: result.argsDrift.length }));
  }
  return parts.length > 0 ? `  ⚠[${parts.join(", ")}]` : "";
}

/** 人类报告正文（不含隐私警告；隐私警告仍由 CLI 写 stderr，保持既有流向） */
export function humanReportLines(
  results: readonly TestResult[],
  configErrors: number,
  translator: Translator,
): string[] {
  const lines: string[] = [];
  for (const result of results) {
    const status = translator.t(
      result.status === "passed" ? "cli.traceStatusPassed" : "cli.traceStatusFailed",
    );
    lines.push(`${status}  ${result.name} (${result.mode})${driftBadge(result, translator)}`);
    for (const assertion of result.assertions) {
      if (!assertion.passed) {
        lines.push(`      ✗ ${assertion.type}: ${assertionDetailText(assertion, translator)}`);
      }
    }
    if (result.configDrift !== null) {
      lines.push(
        translator.t("cli.traceDriftConfigLine", {
          recorded: result.configDrift.recorded,
          current: result.configDrift.current,
        }),
      );
    }
    for (const drift of result.requestDrift) {
      if (drift.display !== undefined) {
        lines.push(
          translator.t("cli.traceDriftRequestLine", {
            call: drift.callIndex + 1,
            index: drift.firstDiff,
            recorded: drift.display.recorded ?? translator.t("cli.traceAssertActualNone"),
            current: drift.display.current ?? translator.t("cli.traceAssertActualNone"),
          }),
        );
      } else {
        lines.push(`      ⚠ ${drift.callIndex + 1}: ${drift.detail}`);
      }
    }
    if (result.requestDrift.length > 0) {
      lines.push(translator.t("cli.traceDriftRequestSummary"));
    }
    for (const drift of result.argsDrift) {
      lines.push(
        translator.t("cli.traceDriftArgsLine", {
          tool: drift.tool,
          sequence: drift.sequence,
          recorded: formatValue(drift.recordedArgs, result.redact),
          current: formatValue(drift.currentArgs, result.redact),
        }),
      );
    }
  }
  lines.push(
    translator.t("cli.traceSummary", {
      total: results.length,
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
      configErrors,
    }),
  );
  return lines;
}
