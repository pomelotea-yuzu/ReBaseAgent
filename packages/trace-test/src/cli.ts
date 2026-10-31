#!/usr/bin/env node
/**
 * trace-test CLI（3.2，CI-only 入口）。
 *
 * 用法：
 *   rebaseagent-trace-test [definition.json | tests-dir] --config config.mjs [选项]
 *
 * 选项：
 *   --config file         必填。用户代码模块，default 导出 { config: RunConfig, tools: Tool[] }
 *   --locale zh-CN|en-US  人类可读输出的语言（默认按 REBASEAGENT_LOCALE、系统语言、en-US）
 *   --report json         输出稳定 JSON 报告（默认输出人类可读文本）
 *   --update-baseline     显式把卡带重跑的新轨迹写回 trace 路径（失败时绝不静默覆盖）
 *
 * 退出码：0=全部通过 / 1=有断言失败 / 2=有配置错误。
 *
 * 隐私警告：trace 含完整 prompt、模型响应与工具参数——提交进仓库前务必脱敏或重录。
 * JSON 模式下 stdout 只有一份可解析报告；隐私/配置错误/baseline 反馈一律走 stderr。
 */
import { pathToFileURL } from "node:url";
import {
  CLI_LOCALE_EXIT_CODE,
  type Translator,
  createTranslator,
  hostIntlLocale,
  resolveCliLocale,
} from "@rebaseagent/i18n";
import { TraceTestConfigError } from "./errors.js";
import { configErrorText, humanReportLines } from "./report.js";
import { type TestResult, exitCodeFor, runTraceTests, writeTraceBaseline } from "./run-test.js";

interface CliArgs {
  target: string;
  configModule: string | null;
  reportJson: boolean;
  updateBaseline: boolean;
}

function printUsageAndExit(code: 0 | 2, translator: Translator): never {
  console.log(translator.t("cli.traceUsage"));
  process.exit(code);
}

function parseArgs(argv: string[], translator: Translator): CliArgs {
  const args: CliArgs = {
    target: "",
    configModule: null,
    reportJson: false,
    updateBaseline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--locale") {
      // 值在进入 main 之前已由共享解析器校验；这里只跳过参数对。
      i += 1;
    } else if (arg === "--config") {
      args.configModule = argv[++i] ?? null;
    } else if (arg === "--report") {
      args.reportJson = (argv[++i] ?? "") === "json";
    } else if (arg === "--update-baseline") {
      args.updateBaseline = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0, translator);
    } else if (!arg.startsWith("--") && args.target === "") {
      args.target = arg;
    } else {
      console.error(translator.t("cli.traceUnknownArgument", { arg }));
      printUsageAndExit(2, translator);
    }
  }
  if (args.target === "" || args.configModule === null) {
    console.error(translator.t("cli.traceMissingArguments"));
    printUsageAndExit(2, translator);
  }
  return args;
}

interface ConfigModule {
  config: Parameters<typeof runTraceTests>[1]["config"];
  tools: Parameters<typeof runTraceTests>[1]["tools"];
}

async function main(argv: string[], translator: Translator): Promise<never | undefined> {
  const args = parseArgs(argv, translator);

  let configModule: ConfigModule;
  try {
    const mod = await import(pathToFileURL(args.configModule as string).href);
    configModule = (mod.default ?? mod) as ConfigModule;
  } catch (e) {
    console.error(translator.t("cli.traceConfigLoad", { detail: (e as Error).message }));
    process.exit(2);
  }
  if (configModule.config === undefined || configModule.tools === undefined) {
    console.error(translator.t("cli.traceConfigModuleShape"));
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
        // C04：baseline 反馈只走 stderr，JSON 模式下 stdout 仍是单份报告。
        process.stderr.write(`${translator.t("cli.traceBaselineUpdated", { path: written })}\n`);
      }
    }
  } catch (e) {
    configErrors += 1;
    if (e instanceof TraceTestConfigError) {
      console.error(
        translator.t("cli.traceConfigError", { detail: configErrorText(e, translator) }),
      );
    } else {
      console.error(translator.t("cli.traceRunError", { detail: (e as Error).message }));
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
    // 隐私警告始终走 stderr；人类报告正文走 stdout。
    console.warn(translator.t("cli.tracePrivacy"));
    for (const line of humanReportLines(results, configErrors, translator)) {
      console.log(line);
    }
  }
  process.exit(exitCodeFor(results, configErrors));
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
    // 只保留既有字段：display 是人类报告投影，不得进入 JSON 契约。
    request_drift: r.requestDrift.map((drift) => ({
      callIndex: drift.callIndex,
      firstDiff: drift.firstDiff,
      detail: drift.detail,
    })),
    args_drift: r.argsDrift,
    alignment: r.alignment,
    assertions: r.assertions.map((a) => ({ type: a.type, passed: a.passed, detail: a.detail })),
  };
}

const argv = process.argv.slice(2);
const localeOutcome = resolveCliLocale({
  argv,
  env: process.env,
  intlLocale: hostIntlLocale(),
});

if (!localeOutcome.ok) {
  const translator = createTranslator({ locale: localeOutcome.messageLocale });
  process.stderr.write(`${localeOutcome.code}: ${translator.t(localeOutcome.messageKey)}\n`);
  process.exitCode = CLI_LOCALE_EXIT_CODE;
} else {
  const translator = createTranslator({ locale: localeOutcome.locale });
  await main(argv, translator);
}
