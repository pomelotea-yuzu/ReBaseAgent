#!/usr/bin/env node
/**
 * trace-test CLI（3.2，CI-only 入口）。
 *
 * 用法：
 *   rebaseagent-trace-test <definition.json | tests-dir> --config <config.mjs> [选项]
 *
 * 选项：
 *   --config <file>       必填。用户代码模块，default 导出 { config: RunConfig, tools: Tool[] }
 *   --report json         输出稳定 JSON 报告（默认输出人类可读文本）
 *   --update-baseline     显式把卡带重跑的新轨迹写回 trace 路径（3.3；失败时绝不静默覆盖）
 *
 * 退出码：0=全部通过 / 1=有断言失败 / 2=有配置错误。
 *
 * 隐私警告：trace 含完整 prompt、模型响应与工具参数——提交进仓库前务必脱敏或重录。
 */
import { pathToFileURL } from "node:url";
import { TraceTestConfigError } from "./errors.js";
import { formatValue } from "./format.js";
import { type TestResult, exitCodeFor, runTraceTests, writeTraceBaseline } from "./run-test.js";

interface CliArgs {
  target: string;
  configModule: string | null;
  reportJson: boolean;
  updateBaseline: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    target: "",
    configModule: null,
    reportJson: false,
    updateBaseline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      args.configModule = argv[++i] ?? null;
    } else if (arg === "--report") {
      args.reportJson = (argv[++i] ?? "") === "json";
    } else if (arg === "--update-baseline") {
      args.updateBaseline = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else if (!arg.startsWith("--") && args.target === "") {
      args.target = arg;
    } else {
      console.error(`未知参数：${arg}`);
      printUsageAndExit(2);
    }
  }
  if (args.target === "" || args.configModule === null) {
    printUsageAndExit(2);
  }
  return args;
}

function printUsageAndExit(code: 0 | 2): never {
  console.log(
    "用法：trace-test <definition.json | tests-dir> --config <config.mjs> [--report json] [--update-baseline]",
  );
  process.exit(code);
}

interface ConfigModule {
  config: Parameters<typeof runTraceTests>[1]["config"];
  tools: Parameters<typeof runTraceTests>[1]["tools"];
}

async function main(): Promise<never | undefined> {
  const args = parseArgs(process.argv.slice(2));

  let configModule: ConfigModule;
  try {
    const mod = await import(pathToFileURL(args.configModule as string).href);
    configModule = (mod.default ?? mod) as ConfigModule;
    if (configModule.config === undefined || configModule.tools === undefined) {
      throw new Error("配置模块需 default 导出 { config, tools }");
    }
  } catch (e) {
    console.error(`配置错误：无法加载配置模块 ${(e as Error).message}`);
    process.exit(2);
  }

  const results: TestResult[] = [];
  let configErrors = 0;
  const isFile = args.target.endsWith(".json");
  try {
    for (const result of await runTraceTests(args.target, {
      config: configModule.config,
      tools: configModule.tools,
      isFileHint: isFile,
    })) {
      results.push(result);
      if (args.updateBaseline && result.mode === "cassette" && result.newRecord !== null) {
        const written = writeTraceBaseline(result.tracePath, result.newRecord);
        console.log(`[baseline] 已更新基线：${written}`);
      }
    }
  } catch (e) {
    if (e instanceof TraceTestConfigError) {
      configErrors += 1;
      console.error(`配置错误：${e.message}`);
    } else {
      configErrors += 1;
      console.error(`运行错误：${(e as Error).message}`);
    }
  }

  if (args.reportJson) {
    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === "passed").length,
      failed: results.filter((r) => r.status === "failed").length,
      configErrors,
      exitCode: exitCodeFor(results, configErrors),
    };
    console.log(JSON.stringify({ summary, results: results.map(toJsonResult) }, null, 2));
  } else {
    // 人类可读文本报告；隐私警告始终输出（trace 含完整 prompt/响应/工具参数）
    console.warn(
      "[privacy] trace 可能包含完整 prompt、模型响应与工具参数；提交进仓库前请脱敏或重录。",
    );
    for (const r of results) {
      const drift = driftBadge(r);
      console.log(`${r.status === "passed" ? "PASS" : "FAIL"}  ${r.name} (${r.mode})${drift}`);
      for (const a of r.assertions) {
        if (!a.passed) {
          console.log(`      ✗ ${a.type}: ${a.detail}`);
        }
      }
      if (r.configDrift !== null) {
        console.log(
          `      ⚠ config drift：recorded=${r.configDrift.recorded} current=${r.configDrift.current}（卡带响应可能已不能代表新配置下的模型行为，建议重录基线）`,
        );
      }
      if (r.requestDrift.length > 0) {
        for (const d of r.requestDrift) {
          console.log(`      ⚠ request drift：第 ${d.callIndex + 1} 次调用 ${d.detail}`);
        }
        console.log("      ⚠ 存在请求漂移：建议重录基线以反映当前输入结构。");
      }
      for (const d of r.argsDrift) {
        console.log(
          `      ⚠ args drift：${d.tool} 第 ${d.sequence} 次调用 args 形状不同：` +
            `录制=${formatValue(d.recordedArgs, r.redact)}，当前=${formatValue(d.currentArgs, r.redact)}`,
        );
      }
    }
  }
  process.exit(exitCodeFor(results, configErrors));
}

function driftBadge(r: TestResult): string {
  const parts: string[] = [];
  if (r.configDrift !== null) parts.push("config-drift");
  if (r.requestDrift.length > 0) parts.push(`request-drift×${r.requestDrift.length}`);
  if (r.argsDrift.length > 0) parts.push(`args-drift×${r.argsDrift.length}`);
  return parts.length > 0 ? `  ⚠[${parts.join(", ")}]` : "";
}

function toJsonResult(r: TestResult) {
  return {
    name: r.name,
    mode: r.mode,
    status: r.status,
    run_id: r.runId,
    definition: r.definitionPath,
    trace: r.tracePath,
    config_drift: r.configDrift,
    request_drift: r.requestDrift,
    args_drift: r.argsDrift,
    alignment: r.alignment,
    assertions: r.assertions.map((a) => ({ type: a.type, passed: a.passed, detail: a.detail })),
  };
}

main().catch((e: Error) => {
  console.error(`运行错误：${e.message}`);
  process.exit(2);
});
