import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLlmClient, initialMessages, sampleConfig } from "../../agent-loop/test/helpers";

/**
 * i18n 5.7（S09/S10/S11）：rebaseagent-model-ab 是 0.1 归属表里 trace-test 之外的
 * 最后一个包层 CLI。本文件用真实 dist 子进程钉住：
 * - 语言优先级：--locale > REBASEAGENT_LOCALE > LC_ALL/LC_MESSAGES/LANG > Intl > en-US；
 *   精确空串视为未设置，空白/别名拒绝；合法 flag 覆盖非法环境变量。
 * - 非法显式语言先于帮助/配置加载/执行：INVALID_LOCALE + 退出 2，stdout 为空，
 *   不回显原始参数，用户 config 不被 import。
 * - 人类输出两语言；--report json 的字段、原值与退出码不随语言变化，
 *   静默忽略告警的人类说明只在文本模式本地化。
 */

const CLI_PATH = resolve(import.meta.dirname, "../dist/model-ab-cli.js");
const skip = !existsSync(CLI_PATH);

const TASK = "读取 README.md 并把要点写入 summary.md";

/** agent-loop 测试桩的 complete 签名比 LlmClient 宽；运行期兼容，标注只为测试类型检查。 */
const asLlm = (llm: unknown): LlmClient => llm as unknown as LlmClient;

function emptyToolConfig(): RunConfig {
  return sampleConfig({ tools: [], params: { num_predict: 768, num_ctx: 4096 } });
}

function toolConfig(): { config: RunConfig; tools: Tool[] } {
  const tools: Tool[] = [
    {
      name: "read_file",
      description: "读取指定路径的文件",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      sideEffect: false,
      handler: (args) => `内容(${(args as { path: string }).path})`,
    },
  ];
  return { config: sampleConfig({ tools: tools.map(({ handler: _h, ...def }) => def) }), tools };
}

async function createParent(dir: string, config: RunConfig, tools: Tool[]): Promise<string> {
  const tmp = join(dir, "tmp-parent.jsonl");
  await runLoop(
    config,
    initialMessages(TASK),
    new JsonlTracer(tmp),
    tools,
    asLlm(new MockLlmClient([{ content: "父 run 完成。" }])),
  );
  const record = readRun(tmp);
  expect(record.status).toBe("completed");
  renameSync(tmp, join(dir, `${record.meta.id}.jsonl`));
  return record.meta.id;
}

/** 清掉宿主语言变量；默认系统候选固定为 C（英文），避免测试机 Intl 差异。 */
function envWith(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const {
    REBASEAGENT_LOCALE: _locale,
    LC_ALL: _lcAll,
    LC_MESSAGES: _lcMessages,
    ...rest
  } = process.env;
  return { ...rest, LANG: "C.UTF-8", ...overrides };
}

function run(args: readonly string[], env: NodeJS.ProcessEnv = envWith()) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
}

const DRY_ARM_ARGS = [
  "--arm",
  "m-a;temperature=0.7;num_ctx=8192",
  "--arm",
  "deepseek-chat;temperature=0.3",
];

describe.skipIf(skip)("rebaseagent-model-ab CLI 语言选择（S09/S10/S11）", () => {
  let dir: string;
  let parentId: string;
  let toolParentId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "model-ab-cli-locale-"));
    parentId = await createParent(dir, emptyToolConfig(), []);
    const tool = toolConfig();
    toolParentId = await createParent(dir, tool.config, tool.tools);
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function dryRunArgs(locale: string, extra: readonly string[] = []): string[] {
    return [
      "--parent",
      parentId,
      "--dir",
      dir,
      ...DRY_ARM_ARGS,
      "--dry-run",
      "--base-url",
      "http://127.0.0.1:11434/v1",
      ...extra,
      "--locale",
      locale,
    ];
  }

  describe("S09 优先级和系统回退", () => {
    it("合法 --locale 覆盖非法产品环境变量，帮助仍成功", () => {
      const proc = run(["--help", "--locale", "zh-CN"], envWith({ REBASEAGENT_LOCALE: "fr-FR" }));
      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain("用法：rebaseagent-model-ab");
      expect(proc.stderr).not.toContain("INVALID_LOCALE");
    });

    it("无 flag 时产品环境变量生效（en-US / zh-CN）", () => {
      const en = run(["--help"], envWith({ REBASEAGENT_LOCALE: "en-US" }));
      expect(en.status, en.stderr).toBe(0);
      expect(en.stdout).toContain("Usage: rebaseagent-model-ab");

      const zh = run(["--help"], envWith({ REBASEAGENT_LOCALE: "zh-CN" }));
      expect(zh.status, zh.stderr).toBe(0);
      expect(zh.stdout).toContain("用法：rebaseagent-model-ab");
    });

    it("精确空串视为未设置，系统 zh 变体取中文、C 取英文", () => {
      const emptyEn = run(
        ["--help"],
        envWith({ REBASEAGENT_LOCALE: "", LANG: "en_US.UTF-8", LC_ALL: "" }),
      );
      expect(emptyEn.status).toBe(0);
      expect(emptyEn.stdout).toContain("Usage: rebaseagent-model-ab");

      const zhTw = run(["--help"], envWith({ LANG: "zh_TW.UTF-8" }));
      expect(zhTw.status).toBe(0);
      expect(zhTw.stdout).toContain("用法：rebaseagent-model-ab");

      const c = run(["--help"], envWith({ LANG: "C" }));
      expect(c.status).toBe(0);
      expect(c.stdout).toContain("Usage: rebaseagent-model-ab");
    });

    it("纯空白/带空白产品环境变量拒绝且不回显原值", () => {
      const blank = run(["--help"], envWith({ REBASEAGENT_LOCALE: "   " }));
      expect(blank.status).toBe(2);
      expect(blank.stdout).toBe("");
      expect(blank.stderr).toContain("INVALID_LOCALE");

      const padded = run(["--help"], envWith({ REBASEAGENT_LOCALE: " fr-FR " }));
      expect(padded.status).toBe(2);
      expect(padded.stderr).toContain("INVALID_LOCALE");
      expect(padded.stderr).not.toContain("fr-FR");
    });
  });

  describe("S10 非法显式语言先于帮助/配置/执行", () => {
    it("非法 flag 与 --help 同现仍退出 2，且不输出帮助", () => {
      const proc = run(["--help", "--locale", "fr-FR"]);
      expect(proc.status).toBe(2);
      expect(proc.stdout).toBe("");
      expect(proc.stderr).toContain("INVALID_LOCALE");
      expect(proc.stderr).not.toContain("Usage");
      expect(proc.stderr).not.toContain("fr-FR");
    });

    it("重复 flag 先判重复，说明取首个合法值的语言", () => {
      const proc = run(["--locale", "zh-CN", "--locale", "en-US", "--help"]);
      expect(proc.status).toBe(2);
      expect(proc.stdout).toBe("");
      expect(proc.stderr).toContain("INVALID_LOCALE");
      expect(proc.stderr).toContain("语言参数重复");
    });

    it("缺值：末尾或下一 token 以 - 开头", () => {
      const tail = run(["--help", "--locale"]);
      expect(tail.status).toBe(2);
      expect(tail.stdout).toBe("");
      expect(tail.stderr).toContain("INVALID_LOCALE");
      expect(tail.stderr).toContain("Missing locale value");

      const dash = run(["--locale", "-h"]);
      expect(dash.status).toBe(2);
      expect(dash.stdout).toBe("");
      expect(dash.stderr).toContain("Missing locale value");
    });

    it("等号形式不产生 INVALID_LOCALE，按入口既有未知参数处理", () => {
      const proc = run(["--locale=en-US", "--help"]);
      expect(proc.status).toBe(2);
      expect(proc.stderr).toContain("Unknown argument: --locale=en-US");
      expect(proc.stderr).not.toContain("INVALID_LOCALE");
    });

    it("非法 locale 先于用户配置加载与执行（marker 反证 + 正向对照）", () => {
      const marker = join(dir, "config-loaded.marker");
      const configPath = join(dir, "marker-config.mjs");
      writeFileSync(
        configPath,
        [
          'import { writeFileSync } from "node:fs";',
          'writeFileSync(process.env.MODEL_AB_MARKER, "loaded");',
          'export default { baseURL: "http://127.0.0.1:11434/v1" };',
        ].join("\n"),
        "utf8",
      );
      const before = readdirSync(dir).sort();
      const env = envWith({ MODEL_AB_MARKER: marker });

      const invalid = run(
        [
          "--parent",
          parentId,
          "--dir",
          dir,
          ...DRY_ARM_ARGS,
          "--config",
          configPath,
          "--dry-run",
          "--report",
          "json",
          "--locale",
          "fr-FR",
        ],
        env,
      );
      expect(invalid.status).toBe(2);
      expect(invalid.stdout).toBe("");
      expect(invalid.stderr).toContain("INVALID_LOCALE");
      expect(invalid.stderr).not.toContain("配置错误");
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(dir).sort()).toEqual(before);

      // 正向对照：同一配置在合法 locale 下确实会被 import（证明 marker 判据有效）。
      const control = run(
        [
          "--parent",
          parentId,
          "--dir",
          dir,
          ...DRY_ARM_ARGS,
          "--config",
          configPath,
          "--dry-run",
          "--report",
          "json",
          "--locale",
          "en-US",
        ],
        env,
      );
      expect(control.status, control.stderr).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("loaded");
      rmSync(marker, { force: true });
    });

    it("非法产品环境变量同样先于配置加载与执行", () => {
      const marker = join(dir, "env-config-loaded.marker");
      const configPath = join(dir, "marker-env-config.mjs");
      writeFileSync(
        configPath,
        [
          'import { writeFileSync } from "node:fs";',
          'writeFileSync(process.env.MODEL_AB_MARKER, "loaded");',
          'export default { baseURL: "http://127.0.0.1:11434/v1" };',
        ].join("\n"),
        "utf8",
      );
      const proc = run(
        ["--parent", parentId, "--dir", dir, ...DRY_ARM_ARGS, "--config", configPath, "--dry-run"],
        envWith({ REBASEAGENT_LOCALE: "fr-FR", MODEL_AB_MARKER: marker }),
      );
      expect(proc.status).toBe(2);
      expect(proc.stdout).toBe("");
      expect(proc.stderr).toContain("INVALID_LOCALE");
      expect(proc.stderr).not.toContain("fr-FR");
      expect(existsSync(marker)).toBe(false);
    });
  });

  describe("S11 两语言人类输出与机器报告兼容", () => {
    it("帮助、未知参数、必填/臂数/arm 语法错误按语言输出，退出码不变", () => {
      const zhHelp = run(["--help", "--locale", "zh-CN"]);
      expect(zhHelp.status).toBe(0);
      expect(zhHelp.stdout).toContain("用法：rebaseagent-model-ab");
      expect(zhHelp.stdout).toContain("--locale zh-CN|en-US");
      const enHelp = run(["--help", "--locale", "en-US"]);
      expect(enHelp.status).toBe(0);
      expect(enHelp.stdout).toContain("Usage: rebaseagent-model-ab");
      expect(enHelp.stdout).toContain("--locale zh-CN|en-US");

      const zhUnknown = run(["--bogus", "--locale", "zh-CN"]);
      expect(zhUnknown.status).toBe(2);
      expect(zhUnknown.stderr).toContain("未知参数：--bogus");
      const enUnknown = run(["--bogus", "--locale", "en-US"]);
      expect(enUnknown.status).toBe(2);
      expect(enUnknown.stderr).toContain("Unknown argument: --bogus");

      const zhMissing = run(["--locale", "zh-CN"]);
      expect(zhMissing.status).toBe(2);
      expect(zhMissing.stderr).toContain("配置错误：--parent 与 --dir 均为必填");
      const enMissing = run(["--locale", "en-US"]);
      expect(enMissing.status).toBe(2);
      expect(enMissing.stderr).toContain("Configuration error: --parent and --dir are required");

      const zhArms = run(["--parent", "x", "--dir", "y", "--arm", "m1", "--locale", "zh-CN"]);
      expect(zhArms.status).toBe(2);
      expect(zhArms.stderr).toContain("模型实验至少需要 2 个 --arm");
      const enArms = run(["--parent", "x", "--dir", "y", "--arm", "m1", "--locale", "en-US"]);
      expect(enArms.status).toBe(2);
      expect(enArms.stderr).toContain("require at least 2 --arm options");

      const zhEscape = run([
        "--parent",
        "x",
        "--dir",
        "y",
        "--arm",
        'm1;k="a\\nb"',
        "--arm",
        "m2",
        "--locale",
        "zh-CN",
      ]);
      expect(zhEscape.status).toBe(2);
      expect(zhEscape.stderr).toContain("不支持的转义");
      const enEscape = run([
        "--parent",
        "x",
        "--dir",
        "y",
        "--arm",
        'm1;k="a\\nb"',
        "--arm",
        "m2",
        "--locale",
        "en-US",
      ]);
      expect(enEscape.status).toBe(2);
      expect(enEscape.stderr).toContain("Unsupported escape");
    });

    it("dry-run 计划两语言；警告原因按稳定键投影", () => {
      const zh = run(dryRunArgs("zh-CN"));
      expect(zh.status).toBe(0);
      expect(zh.stdout).toContain("实验 exp_");
      expect(zh.stdout).toContain("（父 run ");
      expect(zh.stdout).toContain("arm 1：m-a");
      expect(zh.stdout).toContain("生效 params：");
      expect(zh.stdout).toContain("num_ctx=8192（覆盖）");
      expect(zh.stdout).toContain("temperature=0.7（新增）");
      expect(zh.stdout).toContain("丢弃父录值：");
      expect(zh.stdout).toContain("num_predict=768");
      expect(zh.stdout).toContain("⚠ num_ctx：");
      expect(zh.stdout).toContain("静默忽略 num_ctx");
      expect(zh.stdout).toContain("绕行：");
      expect(zh.stdout).toContain("改变：");
      expect(zh.stdout).toContain("未读密钥、未联网、未写文件");

      const en = run(dryRunArgs("en-US"));
      expect(en.status).toBe(0);
      expect(en.stdout).toContain("Experiment exp_");
      expect(en.stdout).toContain("(parent run ");
      expect(en.stdout).toContain("arm 1: m-a");
      expect(en.stdout).toContain("Effective params:");
      expect(en.stdout).toContain("num_ctx=8192(override)");
      expect(en.stdout).toContain("temperature=0.7(added)");
      expect(en.stdout).toContain("Discarded parent values:");
      expect(en.stdout).toContain("num_predict=768");
      expect(en.stdout).toContain("⚠ num_ctx:");
      expect(en.stdout).toContain("silently ignores num_ctx");
      expect(en.stdout).toContain("Workaround:");
      expect(en.stdout).toContain("Changed:");
      expect(en.stdout).toContain("no key was read");
    });

    it("--report json 字段与内容两语言深度相等，告警原因保持原文", () => {
      const zh = run(dryRunArgs("zh-CN", ["--report", "json"]));
      const en = run(dryRunArgs("en-US", ["--report", "json"]));
      expect(zh.status).toBe(0);
      expect(en.status).toBe(0);

      const zhJson = JSON.parse(zh.stdout) as {
        experiment_id: string;
        parent: string;
        dry_run: boolean;
        ok: boolean;
        plan: Array<{
          index: number;
          model: string;
          params: Record<string, unknown>;
          warnings: Array<{ key: string; reason: string; workaround: string }>;
        }>;
        arms: unknown[];
      };
      const enJson = JSON.parse(en.stdout) as typeof zhJson;
      expect(Object.keys(zhJson).sort()).toEqual([
        "arms",
        "dry_run",
        "experiment_id",
        "ok",
        "parent",
        "plan",
      ]);
      expect(Object.keys(zhJson.plan[0] ?? {}).sort()).toEqual([
        "added",
        "allowSideEffects",
        "changed",
        "discarded",
        "index",
        "model",
        "overridden",
        "params",
        "warnings",
      ]);
      const normalize = (report: typeof zhJson) => ({ ...report, experiment_id: "<exp-id>" });
      expect(normalize(enJson)).toEqual(normalize(zhJson));
      expect(zhJson.dry_run).toBe(true);
      expect(zhJson.ok).toBe(true);
      expect(zhJson.arms).toEqual([]);
      expect(zhJson.parent).toBe(parentId);
      expect(zhJson.plan[0]?.warnings[0]?.key).toBe("num_ctx");
      // 机器报告保留内核原文；本地化说明只在文本模式出现
      expect(zhJson.plan[0]?.warnings[0]?.reason).toContain("静默忽略");
      expect(enJson.plan[0]?.warnings[0]?.reason).toContain("静默忽略");
      expect(en.stdout).not.toContain("silently ignores");
      expect(zh.stdout).not.toContain("生效 params");
      expect(en.stdout).not.toContain("Effective params");
    });

    it("领域拒绝给稳定码摘要与原始详情，两语言均保留、退出 2、零文件", () => {
      const before = readdirSync(dir).sort();
      const zh = run([
        "--parent",
        toolParentId,
        "--dir",
        dir,
        "--arm",
        "m-a",
        "--arm",
        "m-b",
        "--dry-run",
        "--locale",
        "zh-CN",
      ]);
      expect(zh.status).toBe(2);
      expect(zh.stderr).toContain("配置错误（稳定码 TOOL_POLICY）");
      expect(zh.stderr).toContain("桌面端");

      const en = run([
        "--parent",
        toolParentId,
        "--dir",
        dir,
        "--arm",
        "m-a",
        "--arm",
        "m-b",
        "--dry-run",
        "--locale",
        "en-US",
      ]);
      expect(en.status).toBe(2);
      expect(en.stderr).toContain("Configuration error (stable code TOOL_POLICY)");
      // 领域原文不随语言翻译
      expect(en.stderr).toContain("桌面端");
      expect(readdirSync(dir).sort()).toEqual(before);
    });
  });
});
