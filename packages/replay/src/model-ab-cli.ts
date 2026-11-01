#!/usr/bin/env node
/**
 * 模型 A/B 实验 CLI（4.3）：rebaseagent-model-ab
 *
 * 与 V3a 的 rebaseagent-trace-test 语义相反，**故意不合并进同一个 bin**：
 * - trace-test = 卡带回归（冻结模型回答、零费用、结果可复现）
 * - model-ab   = 真实调用（按臂数计费、结果不可复现、外部依赖 provider）
 * 合并会让用户在 CI 里误触发付费调用。
 *
 * 用法：
 *   rebaseagent-model-ab --parent <runId> --dir <tracesDir> \
 *     --arm "deepseek-chat;temperature=0.2" --arm "qwen-max" \
 *     [--config <config.mjs>] [--base-url <url>] [--cwd <dir>] \
 *     [--dry-run] [--confirm-cost] [--experiment-id <id>] [--report json] \
 *     [--locale zh-CN|en-US]
 *
 * 真实执行要求 REBASEAGENT_API_KEY 与 --confirm-cost；--dry-run 不需要密钥、不联网、不写文件。
 * 退出码：0=全部成功 / 1=至少一臂执行失败 / 2=配置或前置校验错误。
 * 语言先于帮助/配置/执行解析：非法 --locale 或产品环境变量在读取父 run、加载用户配置、
 * 写文件之前以 INVALID_LOCALE 退出 2；--report json 的机器字段与内容不随语言变化。
 *
 * 首期只支持空工具表（纯对话任务）：replay 包不提供工具 handler，桌面内置 handler
 * 不跨进程复用，卡带测试的桩工具更不能冒充真实结果——父 run 带工具时提示改用桌面端。
 *
 * 隐私警告：真实执行会把父 run 的 prompt 与工具参数原样发给 provider，请确认合规后再跑。
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Scalar } from "@rebaseagent/agent-loop";
import {
  CLI_LOCALE_EXIT_CODE,
  type MessageKey,
  type Translator,
  createTranslator,
  hostIntlLocale,
  resolveCliLocale,
} from "@rebaseagent/i18n";
import { readRun } from "@rebaseagent/trace-sdk";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOTAL_TOKENS,
  ModelAbError,
  modelReplayRunMany,
} from "./model-replay-run.js";
import type { ModelArmPlan, ModelArmSpec } from "./model-replay-run.js";
import { firstLlmCall, locateStartupContext } from "./prompt-fork.js";

interface CliArgs {
  parent: string | null;
  dir: string | null;
  arms: string[];
  configModule: string | null;
  baseUrl: string | null;
  cwd: string | null;
  dryRun: boolean;
  confirmCost: boolean;
  experimentId: string | null;
  reportJson: boolean;
}

interface ConfigModule {
  baseURL?: string;
  cwd?: string;
  maxIterations?: number;
  budget?: { maxTotalTokens?: number };
}

function parseArgs(argv: string[], translator: Translator): CliArgs {
  const args: CliArgs = {
    parent: null,
    dir: null,
    arms: [],
    configModule: null,
    baseUrl: null,
    cwd: null,
    dryRun: false,
    confirmCost: false,
    experimentId: null,
    reportJson: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? null;
    if (arg === "--parent") args.parent = next();
    else if (arg === "--dir") args.dir = next();
    else if (arg === "--arm") {
      const value = next();
      if (value !== null) args.arms.push(value);
    } else if (arg === "--config") args.configModule = next();
    else if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--cwd") args.cwd = next();
    else if (arg === "--experiment-id") args.experimentId = next();
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--confirm-cost") args.confirmCost = true;
    else if (arg === "--report") args.reportJson = next() === "json";
    else if (arg === "--locale") {
      // 值已在进入 main 之前由共享解析器校验；这里只跳过参数对。
      i += 1;
    } else if (arg === "--help" || arg === "-h") printUsageAndExit(0, translator);
    else {
      console.error(translator.t("cli.modelAbUnknownArgument", { arg }));
      printUsageAndExit(2, translator);
    }
  }
  return args;
}

function printUsageAndExit(code: 0 | 2, translator: Translator): never {
  console.log(translator.t("cli.modelAbUsage"));
  process.exit(code);
}

/**
 * 解析单个采样参数值（规则顺序固定，见 design §5）。
 *
 * 1. `true` / `false`（严格小写全等）→ boolean
 * 2. 合法 JSON number（含负号 / 小数）→ number
 * 3. 引号包裹（首尾均为 `"`）→ 强制字符串，仅支持 `\"` 与 `\\` 两种转义
 * 4. 其余 → 原字符串
 *
 * 引号是"我要字符串"的唯一显式标记（`k="123"` 不会被吃成 number）。不做完整转义集——
 * `--arm` 在到达这里前已被 shell 处理过一轮，再做 `\n`/`\uXXXX` 解码只会制造两层转义的心智负担。
 */
function parseScalarValue(
  raw: string,
  index: number,
  part: string,
  translator: Translator,
): string | number | boolean {
  const position = { index: index + 1, part };
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (!raw.includes('"')) {
    // 无引号：数值优先，否则原字符串（none / high / q4_k_m）
    const num = Number(raw);
    if (raw.length > 0 && Number.isFinite(num)) return num;
    if (raw.length === 0) {
      throw new Error(translator.t("cli.modelAbArmMissingValue", position));
    }
    return raw;
  }
  // 含引号：必须"首尾均为 " 且内部无裸引号"
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    throw new Error(translator.t("cli.modelAbArmQuoteNotWhole", position));
  }
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      if (ch === '"') {
        throw new Error(translator.t("cli.modelAbArmBareQuote", position));
      }
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === '"') {
      out += '"';
      i += 1;
      continue;
    }
    if (next === "\\") {
      out += "\\";
      i += 1;
      continue;
    }
    throw new Error(translator.t("cli.modelAbArmUnsupportedEscape", position));
  }
  return out;
}

/** "deepseek-chat;temperature=0.2;reasoning_effort=none" → { model, params } */
function parseArm(spec: string, index: number, translator: Translator): ModelArmSpec {
  const parts = spec
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const position = { index: index + 1 };
  if (parts.length === 0) {
    throw new Error(translator.t("cli.modelAbArmEmpty", position));
  }
  let model: string | null = null;
  const params: Record<string, Scalar> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      if (model !== null) {
        throw new Error(translator.t("cli.modelAbArmMultipleModels", { ...position, spec }));
      }
      model = part;
      continue;
    }
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (key.length === 0) {
      throw new Error(translator.t("cli.modelAbArmMissingKey", { ...position, part }));
    }
    params[key] = parseScalarValue(raw, index, part, translator);
  }
  if (model === null || model.length === 0) {
    throw new Error(translator.t("cli.modelAbArmMissingModel", { ...position, spec }));
  }
  return { model, ...(Object.keys(params).length > 0 ? { params } : {}) };
}

async function loadConfig(path: string | null, translator: Translator): Promise<ConfigModule> {
  if (path === null) return {};
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const config = (mod.default ?? mod) as ConfigModule;
  if (typeof config !== "object" || config === null) {
    throw new Error(translator.t("cli.modelAbConfigModuleShape", { path }));
  }
  return config;
}

/**
 * 已知静默忽略告警的本地化投影：按稳定键取说明，未知键回退内核原文
 * （内核仍持有实测原文；桌面 ModelAbEditor 按同一键投影，JSON 报告保持原文）。
 */
const WARNING_TEXT_KEYS: Record<
  string,
  {
    readonly reason: MessageKey;
    readonly workaround: MessageKey;
  }
> = {
  num_ctx: {
    reason: "experiment.warningNumCtxReason",
    workaround: "experiment.warningNumCtxWorkaround",
  },
  think: {
    reason: "experiment.warningThinkReason",
    workaround: "experiment.warningThinkWorkaround",
  },
};

/** 单个标量的展示文本（字符串加引号以便与数字区分） */
function scalarText(value: Scalar): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * 打印单臂计划（design §4 三段格式，与桌面 ModelAbEditor 字段语义一致）。
 *
 * 第一段 `生效 params`：arm 显式给出的标"覆盖"/"新增"，继承父值的标"继承"。
 * 第二段 `丢弃父录值`：整体替换不合并 ⇒ 父有而 arm 未给的项，无此项时省略。
 * 第三段 `⚠ 告警`：知识库命中，无命中时省略（**省略 ≠ 已生效**）。
 */
function printArmPlan(arm: ModelArmPlan, translator: Translator): void {
  const entries = Object.entries(arm.params);
  const effectiveStr =
    entries.length === 0
      ? translator.t("cli.modelAbInheritParentParams")
      : entries
          .map(([k, v]) => {
            const tag = arm.overridden.includes(k)
              ? translator.t("cli.modelAbTagOverridden")
              : arm.added.includes(k)
                ? translator.t("cli.modelAbTagAdded")
                : translator.t("cli.modelAbTagInherited");
            return `${k}=${scalarText(v)}${tag}`;
          })
          .join(" ");
  console.log(translator.t("cli.modelAbArmPlanLine", { index: arm.index + 1, model: arm.model }));
  console.log(translator.t("cli.modelAbEffectiveParams", { params: effectiveStr }));
  const discarded = Object.entries(arm.discarded);
  if (discarded.length > 0) {
    console.log(
      translator.t("cli.modelAbDiscardedParams", {
        values: discarded.map(([k, v]) => `${k}=${scalarText(v)}`).join(" "),
      }),
    );
  }
  for (const w of arm.warnings) {
    const mapped = WARNING_TEXT_KEYS[w.key];
    console.log(
      translator.t("cli.modelAbWarningLine", {
        key: w.key,
        reason: mapped === undefined ? w.reason : translator.t(mapped.reason),
      }),
    );
    console.log(
      translator.t("cli.modelAbWorkaroundLine", {
        workaround: mapped === undefined ? w.workaround : translator.t(mapped.workaround),
      }),
    );
  }
  console.log(
    translator.t("cli.modelAbChanged", {
      fields:
        arm.changed.length > 0
          ? arm.changed.join(translator.t("experiment.listSeparator"))
          : translator.t("cli.modelAbChangedNone"),
    }),
  );
}

async function main(argv: string[], translator: Translator): Promise<never> {
  const args = parseArgs(argv, translator);

  if (args.parent === null || args.dir === null) {
    console.error(translator.t("cli.modelAbMissingRequired"));
    printUsageAndExit(2, translator);
  }

  let arms: ModelArmSpec[];
  let configModule: ConfigModule;
  try {
    if (args.arms.length < 2) {
      throw new Error(translator.t("cli.modelAbTooFewArms", { count: args.arms.length }));
    }
    arms = args.arms.map((spec, index) => parseArm(spec, index, translator));
    configModule = await loadConfig(args.configModule, translator);
  } catch (e) {
    console.error(translator.t("cli.modelAbConfigError", { detail: (e as Error).message }));
    return process.exit(2);
  }

  const baseURL = args.baseUrl ?? configModule.baseURL ?? null;
  if (baseURL === null && !args.dryRun) {
    console.error(translator.t("cli.modelAbBaseUrlRequired"));
    return process.exit(2);
  }

  const apiKey = process.env.REBASEAGENT_API_KEY ?? "";
  if (!args.dryRun && apiKey.length === 0) {
    console.error(translator.t("cli.modelAbApiKeyRequired"));
    return process.exit(2);
  }

  // system prompt 必须从父 run 首次请求派生（双真相源：不得从 config_hash 反推，也不得另建真相源）。
  // 取不到就留空串——编排层的双真相源校验会给出精确原因并以退出码 2 结束，零文件、零调用。
  let systemPrompt = "";
  try {
    const parent = firstLlmCall(readRun(join(args.dir, `${args.parent}.jsonl`)));
    systemPrompt = locateStartupContext(parent.request.messages).system?.content ?? "";
  } catch {
    systemPrompt = "";
  }

  try {
    const result = await modelReplayRunMany({
      parentId: args.parent,
      arms,
      config: {
        // dry-run 不联网、不发请求：占位 URL 只为满足类型形状，输出里不声称它是真实端点
        baseURL: baseURL ?? "http://127.0.0.1/v1",
        apiKey,
        model: arms[0]?.model ?? "",
        systemPrompt,
        tools: [],
        params: undefined,
        exec: { cwd: args.cwd ?? configModule.cwd ?? process.cwd(), signal: null },
        maxIterations: configModule.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        budget: { maxTotalTokens: configModule.budget?.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS },
      },
      tools: [],
      load: (id) => readRun(`${args.dir}/${id}.jsonl`),
      outDir: args.dir,
      ...(args.experimentId !== null ? { experimentId: args.experimentId } : {}),
      dryRun: args.dryRun,
      confirmCost: args.confirmCost,
      toolPolicy: "require_empty",
    });

    if (args.reportJson) {
      console.log(
        JSON.stringify(
          {
            experiment_id: result.experimentId,
            parent: result.parentId,
            dry_run: args.dryRun,
            ok: result.ok,
            plan: result.plan,
            arms: result.arms,
          },
          null,
          2,
        ),
      );
      return process.exit(result.ok ? 0 : 1);
    }

    console.log(
      translator.t("cli.modelAbExperimentLine", {
        id: result.experimentId,
        parent: result.parentId,
      }),
    );
    for (const arm of result.plan) {
      printArmPlan(arm, translator);
    }
    if (args.dryRun) {
      console.log(translator.t("cli.modelAbDryRun"));
      return process.exit(0);
    }
    console.warn(translator.t("cli.modelAbPrivacy"));
    for (const arm of result.arms) {
      const outcome =
        arm.error === null
          ? translator.t("cli.modelAbArmSuccess", { id: arm.id ?? "" })
          : translator.t("cli.modelAbArmFailure", { error: arm.error });
      console.log(
        translator.t("cli.modelAbArmResultLine", {
          index: arm.index + 1,
          model: arm.model,
          result: outcome,
        }),
      );
    }
    return process.exit(result.ok ? 0 : 1);
  } catch (e) {
    // 前置校验错误（父不可 fork、空工具表、双真相源、空编辑等）一律退出 2：零文件、零调用。
    // 领域错误给稳定码摘要 + 原始详情；非领域异常按原始详情展示。
    if (e instanceof ModelAbError) {
      console.error(translator.t("cli.modelAbRequestFailed", { code: e.code, detail: e.message }));
    } else {
      console.error(
        translator.t("cli.modelAbConfigError", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    }
    return process.exit(2);
  }
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
