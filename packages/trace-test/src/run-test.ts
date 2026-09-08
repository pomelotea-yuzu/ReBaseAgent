import { writeFileSync } from "node:fs";
import type { RunConfig, Tool } from "@rebaseagent/agent-loop";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { type AssertionResult, evaluateAssertions } from "./assertions.js";
import type { RequestDrift } from "./cassette-llm-client.js";
import type { TraceTestDefinition } from "./definition.js";
import { TraceTestConfigError } from "./errors.js";
import { discoverDefinitions, loadDefinition, loadTrace, resolveTracePath } from "./loader.js";
import type { ConfigDrift, RerunResult } from "./rerun.js";
import { rerunWithCassette } from "./rerun.js";
import type { ShapeAlignment } from "./shape-align.js";
import type { ArgsDrift } from "./stub-tools.js";

/** 测试执行模式：cassette=卡带重跑；static=代理 run 的显式静态断言路径 */
export type TestMode = "cassette" | "static";

export interface TestResult {
  /** 定义名 */
  name: string;
  definitionPath: string;
  tracePath: string;
  mode: TestMode;
  /** passed / failed 仅由断言与默认结构对齐决定；drift 不影响（不改退出码） */
  status: "passed" | "failed";
  /** run id：卡带模式=新 run，静态模式=录制 run */
  runId: string;
  /** 卡带模式的重跑结果（静态模式为 null） */
  rerun: RerunResult | null;
  configDrift: ConfigDrift | null;
  requestDrift: readonly RequestDrift[];
  argsDrift: readonly ArgsDrift[];
  alignment: ShapeAlignment | null;
  assertions: AssertionResult[];
  /** 定义里声明的脱敏键（报告层格式化 args/字段值时使用） */
  redact: readonly string[];
  /** 卡带模式的新轨迹（--update-baseline 落盘用）；静态模式为 null */
  newRecord: RunRecord | null;
}

export interface RunTraceTestOptions {
  /** 当前配置（systemPrompt + 工具表驱动 config hash 与请求体） */
  config: RunConfig;
  /** 当前工具声明（含 handler；卡带模式下 handler 被桩替换） */
  tools: Tool[];
}

/**
 * runner API（3.1）：Vitest/Jest 直接调用。
 *
 * - 卡带模式（默认）：rerunWithCassette → 默认结构对齐（trace.shape.enabled=false
 *   可按定义关掉）→ 断言求值（对新轨迹）→ 汇总。配置错误抛 TraceTestConfigError。
 * - 静态模式：trace 为代理录制 run 或缺 config_hash 时自动降级——跳过重跑，
 *   断言直接作用于录制轨迹；定义中出现 trace.shape 断言视为配置错误
 *   （没有重跑轨迹就谈不上结构对齐）。
 *
 * drift（config/request/args）只随结果返回，不改变 status——报告层负责
 * 把「建议重录基线」的出路讲清楚。
 */
export async function runTraceTest(
  definitionFile: string,
  options: RunTraceTestOptions,
): Promise<TestResult> {
  const definition = loadDefinition(definitionFile);
  const tracePath = resolveTracePath(definitionFile, definition.trace);
  const record = loadTrace(tracePath);

  if (record.status !== "completed") {
    throw new TraceTestConfigError(
      `trace ${tracePath} 未封存（缺少终止事件），不能作为测试基线。请使用完整结束的 run。`,
    );
  }

  const staticOnly = record.meta.source?.kind === "proxy" || record.meta.config_hash === undefined;
  const assertions = definition.assertions.filter((a) => a.type !== "trace.shape");
  const shapeAssertion = definition.assertions.find((a) => a.type === "trace.shape") as
    | { type: "trace.shape"; enabled?: boolean }
    | undefined;

  if (staticOnly) {
    if (shapeAssertion !== undefined && shapeAssertion.enabled !== false) {
      throw new TraceTestConfigError(
        "该 trace 为代理录制 run 或缺少 loop 配置，不支持卡带重跑与结构对齐。" +
          "请在定义中移除 trace.shape 断言，只保留静态断言（run.outcome / span.*）。",
      );
    }
    return runStaticAssertions(
      definition,
      definitionFile,
      tracePath,
      record,
      evaluateAssertions(
        assertions,
        record.spans,
        record.events[0]?.reason,
        definition.redact ?? [],
      ),
    );
  }

  // 卡带模式
  const result = await rerunWithCassette({ record, config: options.config, tools: options.tools });
  const shapeEnabled = shapeAssertion?.enabled !== false;
  const assertionResults = evaluateAssertions(
    assertions,
    result.record.spans,
    result.run.event.reason,
    definition.redact ?? [],
  );

  // 默认结构对齐：未显式关闭时，对齐失败即测试失败（首个不匹配 span 定位）
  if (shapeEnabled && !result.alignment.aligned) {
    assertionResults.unshift({
      type: "trace.shape",
      passed: false,
      detail: result.alignment.mismatch?.detail ?? "结构对齐失败",
    });
  }
  if (shapeAssertion !== undefined) {
    // 显式声明的 trace.shape 断言始终出结果行
    const already = assertionResults.some((r) => r.type === "trace.shape");
    if (!already) {
      assertionResults.push({
        type: "trace.shape",
        passed: result.alignment.aligned,
        detail: result.alignment.aligned
          ? `结构对齐通过（${result.alignment.comparedSpanCount} 个 span）`
          : (result.alignment.mismatch?.detail ?? "结构对齐失败"),
      });
    }
  }

  return {
    name: definition.name,
    definitionPath: definitionFile,
    tracePath,
    mode: "cassette",
    status: assertionResults.every((r) => r.passed) ? "passed" : "failed",
    runId: result.record.meta.id,
    rerun: result,
    configDrift: result.configDrift,
    requestDrift: result.requestDrift,
    argsDrift: result.argsDrift,
    alignment: result.alignment,
    assertions: assertionResults,
    redact: definition.redact ?? [],
    newRecord: result.record,
  };
}

function runStaticAssertions(
  definition: TraceTestDefinition,
  definitionFile: string,
  tracePath: string,
  record: RunRecord,
  assertionResults: AssertionResult[],
): TestResult {
  return {
    name: definition.name,
    definitionPath: definitionFile,
    tracePath,
    mode: "static",
    status: assertionResults.every((r) => r.passed) ? "passed" : "failed",
    runId: record.meta.id,
    rerun: null,
    configDrift: null,
    requestDrift: [],
    argsDrift: [],
    alignment: null,
    assertions: assertionResults,
    redact: definition.redact ?? [],
    newRecord: null,
  };
}

/** 发现并运行目录/单文件下的全部定义（CLI 与测试共用） */
export async function runTraceTests(
  path: string,
  options: RunTraceTestOptions & { isFileHint?: boolean },
): Promise<TestResult[]> {
  const files = options.isFileHint ? [path] : discoverDefinitions(path);
  const results: TestResult[] = [];
  for (const file of files) {
    results.push(await runTraceTest(file, { config: options.config, tools: options.tools }));
  }
  return results;
}

/** 退出码映射（1.2）：0=全过 / 1=有断言失败 / 2=有配置错误 */
export function exitCodeFor(results: TestResult[], configErrors: number): 0 | 1 | 2 {
  if (configErrors > 0) {
    return 2;
  }
  return results.some((r) => r.status === "failed") ? 1 : 0;
}

/**
 * 基线更新（3.3）：把卡带重跑产生的新轨迹覆盖写回 trace 路径。
 * 仅在显式 --update-baseline 下由 CLI 调用——测试失败时绝不静默覆盖。
 * 写出为语义序 JSONL（meta → spans → event），与既有读取器兼容。
 */
export function writeTraceBaseline(tracePath: string, record: RunRecord): string {
  if (record.status !== "completed" || record.events.length === 0) {
    throw new TraceTestConfigError("只有已封存的 run 才能作为基线写入");
  }
  const lines = [
    JSON.stringify(record.meta),
    ...record.spans.map((span) => JSON.stringify(span)),
    JSON.stringify(record.events[0]),
  ];
  const text = `${lines.join("\n")}\n`;
  writeFileSync(tracePath, text, "utf8");
  return tracePath;
}
