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
 *     [--dry-run] [--confirm-cost] [--experiment-id <id>] [--report json]
 *
 * 真实执行要求 REBASEAGENT_API_KEY 与 --confirm-cost；--dry-run 不需要密钥、不联网、不写文件。
 * 退出码：0=全部成功 / 1=至少一臂执行失败 / 2=配置或前置校验错误。
 *
 * 首期只支持空工具表（纯对话任务）：replay 包不提供工具 handler，桌面内置 handler
 * 不跨进程复用，卡带测试的桩工具更不能冒充真实结果——父 run 带工具时提示改用桌面端。
 *
 * 隐私警告：真实执行会把父 run 的 prompt 与工具参数原样发给 provider，请确认合规后再跑。
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readRun } from "@rebaseagent/trace-sdk";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOTAL_TOKENS,
  modelReplayRunMany,
} from "./model-replay-run.js";
import type { ModelArmSpec } from "./model-replay-run.js";
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

function parseArgs(argv: string[]): CliArgs {
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
    else if (arg === "--help" || arg === "-h") printUsageAndExit(0);
    else {
      console.error(`未知参数：${arg}`);
      printUsageAndExit(2);
    }
  }
  return args;
}

function printUsageAndExit(code: 0 | 2): never {
  console.log(
    "用法：rebaseagent-model-ab --parent <runId> --dir <tracesDir> --arm <spec> --arm <spec>" +
      " [--config <config.mjs>] [--base-url <url>] [--cwd <dir>] [--experiment-id <id>]" +
      " [--dry-run] [--confirm-cost] [--report json]\n" +
      '  --arm spec："model" 或 "model;k=v;k=v"（首期只支持数值采样参数）\n' +
      "  退出码：0=全部成功 / 1=至少一臂失败 / 2=配置或前置校验错误",
  );
  process.exit(code);
}

/** "deepseek-chat;temperature=0.2;top_p=0.9" → { model, params } */
function parseArm(spec: string, index: number): ModelArmSpec {
  const parts = spec
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(`第 ${index + 1} 个 --arm 为空`);
  }
  let model: string | null = null;
  const params: Record<string, number> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      if (model !== null) throw new Error(`第 ${index + 1} 个 --arm 有多个模型名：${spec}`);
      model = part;
      continue;
    }
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    const value = Number(raw);
    if (key.length === 0 || !Number.isFinite(value)) {
      throw new Error(
        `第 ${index + 1} 个 --arm 的采样参数非法：${part}（首期只支持数值参数，如 temperature=0.2）`,
      );
    }
    params[key] = value;
  }
  if (model === null || model.length === 0) {
    throw new Error(`第 ${index + 1} 个 --arm 缺少模型名：${spec}`);
  }
  return { model, ...(Object.keys(params).length > 0 ? { params } : {}) };
}

async function loadConfig(path: string | null): Promise<ConfigModule> {
  if (path === null) return {};
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const config = (mod.default ?? mod) as ConfigModule;
  if (typeof config !== "object" || config === null) {
    throw new Error(`配置模块 ${path} 需 default 导出 { baseURL, cwd?, maxIterations?, budget? }`);
  }
  return config;
}

async function main(): Promise<never> {
  const args = parseArgs(process.argv.slice(2));

  if (args.parent === null || args.dir === null) {
    console.error("配置错误：--parent 与 --dir 均为必填");
    printUsageAndExit(2);
  }

  let arms: ModelArmSpec[];
  let configModule: ConfigModule;
  try {
    if (args.arms.length < 2) {
      throw new Error(
        `模型实验至少需要 2 个 --arm（当前 ${args.arms.length} 个）；单臂请用桌面端的 prompt fork`,
      );
    }
    arms = args.arms.map(parseArm);
    configModule = await loadConfig(args.configModule);
  } catch (e) {
    console.error(`配置错误：${(e as Error).message}`);
    return process.exit(2);
  }

  const baseURL = args.baseUrl ?? configModule.baseURL ?? null;
  if (baseURL === null && !args.dryRun) {
    console.error("配置错误：真实执行需要 baseURL（用 --base-url 或 --config 提供）");
    return process.exit(2);
  }

  const apiKey = process.env.REBASEAGENT_API_KEY ?? "";
  if (!args.dryRun && apiKey.length === 0) {
    console.error(
      "配置错误：真实执行需要 apiKey，请设置环境变量 REBASEAGENT_API_KEY（--dry-run 不需要密钥）",
    );
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

    console.log(`实验 ${result.experimentId}（父 run ${result.parentId}）`);
    for (const arm of result.plan) {
      const params =
        Object.keys(arm.params).length === 0
          ? "（沿用父参数）"
          : Object.entries(arm.params)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ");
      console.log(`  arm ${arm.index + 1}：${arm.model}  ${params}`);
      console.log(`      改变：${arm.changed.length > 0 ? arm.changed.join("、") : "（无）"}`);
    }
    if (args.dryRun) {
      console.log("dry-run：只做了校验与计划展示，未读密钥、未联网、未写文件。");
      return process.exit(0);
    }
    console.warn(
      "[privacy] 真实调用会把父 run 的 prompt 与工具参数原样发给 provider；结果不可复现，费用按臂数计。",
    );
    for (const arm of result.arms) {
      console.log(
        `  arm ${arm.index + 1}（${arm.model}）：${arm.error === null ? `成功 ${arm.id}` : `失败 ${arm.error}`}`,
      );
    }
    return process.exit(result.ok ? 0 : 1);
  } catch (e) {
    // 前置校验错误（父不可 fork、空工具表、双真相源、空编辑等）一律退出 2：零文件、零调用
    console.error(`配置错误：${(e as Error).message}`);
    return process.exit(2);
  }
}

main();
