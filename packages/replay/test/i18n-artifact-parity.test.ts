import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OpenAiCompatClient, runLoop } from "@rebaseagent/agent-loop";
import type { FetchLike, Message, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { type Locale, type Translator, createTranslator } from "@rebaseagent/i18n";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportWorkspaceSnapshot, modelReplayRunMany } from "../src/index";
import {
  cleanupTempDirs,
  makeDataDir,
  makeTempDir,
  round,
  writeIsolatedRun,
} from "./workspace-helpers";

/**
 * i18n 5.8（S07/S08）：两语言的受控对照，而不是局部 JSON 契约复测。
 *
 * 对照维度（唯一变量 = 展示语言）：
 * - 用真实 `runLoop` + 真实 `OpenAiCompatClient`（HTTP 捕获桩返回确定性 SSE）分别执行
 *   同一份输入，比较**实际发出的模型请求体**、工具声明、工具消息/结果与落盘 trace 正文；
 * - 用同一父 run 在两语言上下文下生成模型实验计划，比较计划事实；
 * - 用固定时钟把同一检查点导出两次，比较 files/ 文件树、changes.patch 与清单的完整字节；
 * - 同时断言展示标签确实随语言变化，证明对照中的语言上下文是生效的。
 *
 * 原始边界（design §6.2）：中文系统提示、工具描述、工具结果与用户正文是模型输入/记录原文，
 * 两种语言下逐字保留；机器清单里的"未保留（原状态未知）"等事实也保持既有原文，
 * 不因展示语言改写。真实模型未参与（零费用）；Electron 实机验收属 6.x。
 */

const LOCALES = ["zh-CN", "en-US"] as const;

const SYSTEM = "你是文件助手。";
const TASK = "读取 README.md 并总结要点。";
const TOOL_RESULT = "内容(README.md)：第一行\n第二行";
const FIXED_NOW = "2026-11-01T00:00:00.000Z";
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function sampleTools(): Tool[] {
  return [
    {
      name: "read_file",
      description: "读取指定路径的文件",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      sideEffect: false,
      handler: (args) => {
        const { path } = args as { path: string };
        return TOOL_RESULT.replace("README.md", path);
      },
    },
  ];
}

function runConfig(): RunConfig {
  const tools = sampleTools();
  return {
    baseURL: "https://api.invalid.example/v1",
    apiKey: "sk-controlled-only",
    model: "controlled-model",
    systemPrompt: SYSTEM,
    tools: tools.map(({ handler: _handler, ...def }) => def),
    params: { temperature: 0.2 },
    exec: { cwd: "D:/tmp/i18n-58", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100_000 },
  };
}

const initialMessages = (): Message[] => [
  { role: "system", content: SYSTEM },
  { role: "user", content: TASK },
];

const SSE_DONE = "data: [DONE]\n\n";
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** 确定性剧本：首轮工具调用，次轮纯文本总结 */
const SSE_SCRIPT = [
  [
    sse({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_fixed",
                function: { name: "read_file", arguments: '{"path":"README.md"}' },
              },
            ],
          },
        },
      ],
    }),
    sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 20 } }),
    SSE_DONE,
  ].join(""),
  [
    sse({ choices: [{ delta: { content: "总结完成。" } }] }),
    sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 150, completion_tokens: 10 } }),
    SSE_DONE,
  ].join(""),
];

/** 捕获真实客户端发出的请求体原文；响应用确定性 SSE，不联网 */
function captureFetch(bodies: string[]): FetchLike {
  let turn = 0;
  return async (_input, init) => {
    bodies.push(init?.body ?? "");
    const payload = SSE_SCRIPT[Math.min(turn, SSE_SCRIPT.length - 1)] as string;
    turn += 1;
    return new Response(payload, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

interface ControlledRun {
  readonly locale: Locale;
  readonly translator: Translator;
  readonly dir: string;
  readonly traceFile: string;
  readonly traceText: string;
  readonly lines: Array<Record<string, unknown>>;
  readonly bodies: string[];
  readonly runId: string;
}

async function runControlled(locale: Locale): Promise<ControlledRun> {
  const translator = createTranslator({ locale });
  const dir = makeTempDir(`i18n-58-${locale}-`);
  const traceFile = join(dir, "trace.jsonl");
  const bodies: string[] = [];
  const client = new OpenAiCompatClient(runConfig(), captureFetch(bodies));
  const result = await runLoop(
    runConfig(),
    initialMessages(),
    new JsonlTracer(traceFile),
    sampleTools(),
    client,
  );
  expect(result.event.event).toBe("stopped");
  expect(result.event.reason).toBe("completed");

  const lines = readFileSync(traceFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const meta = lines[0] as { id: string };
  // 落成 <runId>.jsonl，供模型实验的 load(id) 按真实身份读取父 run。
  const runTraceFile = join(dir, `${meta.id}.jsonl`);
  renameSync(traceFile, runTraceFile);
  const traceText = readFileSync(runTraceFile, "utf8");
  return {
    locale,
    translator,
    dir,
    traceFile: runTraceFile,
    traceText,
    lines,
    bodies,
    runId: meta.id,
  };
}

/**
 * 仅归一 run 身份与实测耗时（墙上时钟/ttft/dur_ms 每次不同）；
 * 正文、工具字段、请求记录与技术格式一律保持原样比较。
 */
function normalizedTrace(run: ControlledRun): string {
  return run.lines
    .map((line) => {
      const copy = structuredClone(line);
      if (copy.type === "run.meta") {
        copy.id = "<run-id>";
        copy.created_at = "<created-at>";
      }
      if (copy.type === "span") {
        copy.timing = "<timing>";
        if (typeof copy.dur_ms === "number") copy.dur_ms = "<dur-ms>";
        const response = copy.response as { ttft_ms?: unknown } | undefined;
        if (response !== undefined && typeof response.ttft_ms === "number") {
          response.ttft_ms = "<ttft-ms>";
        }
      }
      return JSON.stringify(copy);
    })
    .join("\n");
}

const sha256 = (text: string | Uint8Array): string =>
  createHash("sha256").update(text).digest("hex");

const spanOf = (run: ControlledRun, kind: string): Record<string, unknown> => {
  const span = run.lines.find((line) => line.type === "span" && line.kind === kind);
  if (span === undefined) throw new Error(`缺少 ${kind} span`);
  return span;
};

interface FileFact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** 目录树事实（相对路径 + 字节数 + 内容哈希） */
function treeFacts(dir: string, prefix = ""): FileFact[] {
  const facts: FileFact[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(full).isDirectory()) {
      facts.push(...treeFacts(full, rel));
      continue;
    }
    const bytes = readFileSync(full);
    facts.push({ path: rel, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return facts;
}

interface ExportRun {
  readonly translator: Translator;
  readonly target: string;
  readonly facts: FileFact[];
  readonly result: Awaited<ReturnType<typeof exportWorkspaceSnapshot>>;
}

const evidence: Record<string, unknown> = {
  locales: LOCALES,
  generatedAt: new Date().toISOString(),
  controlledProvider: true,
  realModel: false,
};

function recordEvidence(section: string, data: Record<string, unknown>): void {
  evidence[section] = data;
}

function writeEvidence(): void {
  const path = process.env.I18N58_REPORT;
  if (path === undefined || path === "") return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

describe("i18n 5.8 受控双语对照（S07/S08）", () => {
  let dataDir: string;
  let dataDirCleanup: () => void;
  let exportRunId: string;
  let exportStepId: string;
  let exportSnapshotId: string;
  let sourceBefore: FileFact[];

  beforeAll(async () => {
    const handle = makeDataDir();
    dataDir = handle.dataDir;
    dataDirCleanup = handle.cleanup;
    const written = await writeIsolatedRun({
      dataDir,
      runId: "run_i18n58_export",
      rounds: [
        round([
          ["a.txt", "alpha\r\nsecond"],
          ["bin.dat", Uint8Array.from([0x00, 0xff, 0x41])],
          ["drop.txt", "bye"],
          ["中文.txt", "第一行\n第二行"],
        ]),
        round([
          ["a.txt", "alpha changed\r\nsecond"],
          ["bin.dat", Uint8Array.from([0x00, 0xff, 0x41, 0x42])],
          ["中文.txt", "第一行\n第二行\n新增"],
          ["spaced path.txt", "added\n"],
        ]),
      ],
    });
    exportRunId = written.runId;
    exportStepId = written.stepSpanIds[0] as string;
    exportSnapshotId = createWorkspaceSnapshot(written.roundFiles[1] as never).id;
    sourceBefore = treeFacts(dataDir);
  }, 120_000);

  afterAll(() => {
    writeEvidence();
    cleanupTempDirs();
    dataDirCleanup();
  });

  it("展示语言确实生效，但只作用于外围标签", async () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const en = createTranslator({ locale: "en-US" });
    expect(zh.t("detail.durationLabel")).toBe("耗时");
    expect(en.t("detail.durationLabel")).toBe("Duration");
    expect(zh.t("detail.tokensIn")).toBe("输入 tokens");
    expect(en.t("detail.tokensIn")).toBe("Input tokens");
    expect(zh.t("export.targetInitial")).toBe("初始检查点");
    expect(en.t("export.targetInitial")).toBe("the initial checkpoint");
  });

  it("受控执行：模型请求、工具声明/消息/结果与 trace 正文两语言逐字节一致", async () => {
    const zh = await runControlled("zh-CN");
    const en = await runControlled("en-US");

    // 1. 模型请求体：两次调用逐字节一致（不含 run 身份/时间）
    expect(zh.bodies).toHaveLength(2);
    expect(en.bodies).toHaveLength(2);
    expect(en.bodies).toEqual(zh.bodies);

    const firstBody = JSON.parse(zh.bodies[0] as string) as {
      model: string;
      stream: boolean;
      temperature: number;
      messages: Message[];
      tools: Array<{ type: string; function: Record<string, unknown> }>;
    };
    const secondBody = JSON.parse(zh.bodies[1] as string) as {
      messages: Array<{ role: string; content?: string | null; tool_calls?: unknown[] }>;
    };
    expect(firstBody.model).toBe("controlled-model");
    expect(firstBody.stream).toBe(true);
    expect(firstBody.temperature).toBe(0.2);
    expect(firstBody.messages).toEqual(initialMessages());
    expect(firstBody.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "读取指定路径的文件",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          sideEffect: false,
        },
      },
    ]);

    // 2. 工具消息：实际送入模型的结果就是原文（两语言同一份）
    const toolMessage = secondBody.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toBe(TOOL_RESULT);
    expect(secondBody.messages.filter((m) => m.role === "assistant").length).toBe(1);

    // 3. 持久化正文：除 run 身份与 timing 外整行逐字一致
    expect(normalizedTrace(en)).toBe(normalizedTrace(zh));
    const zhTool = spanOf(zh, "tool.invoke");
    const enTool = spanOf(en, "tool.invoke");
    expect(zhTool.args).toEqual({ path: "README.md" });
    expect(zhTool.result).toBe(TOOL_RESULT);
    expect(enTool.args).toEqual(zhTool.args);
    expect(enTool.result).toBe(zhTool.result);

    // 4. 技术格式：UTC ISO 时间戳与整数事实不随语言变化
    for (const run of [zh, en]) {
      const meta = run.lines[0] as { created_at: string };
      expect(meta.created_at).toMatch(ISO_UTC);
      for (const line of run.lines) {
        if (line.type !== "span") continue;
        const timing = line.timing as { started_at: string; ended_at: string };
        expect(timing.started_at).toMatch(ISO_UTC);
        expect(timing.ended_at).toMatch(ISO_UTC);
      }
      const llm = spanOf(run, "llm.call");
      const response = llm.response as { usage: { in: number; out: number }; ttft_ms: number };
      expect(Number.isInteger(response.usage.in)).toBe(true);
      expect(Number.isInteger(response.usage.out)).toBe(true);
      expect(Number.isInteger(response.ttft_ms)).toBe(true);
      expect(response.ttft_ms).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(spanOf(run, "tool.invoke").dur_ms)).toBe(true);
    }

    // 5. 请求/记录里没有混入本地化展示文本
    expect(zh.bodies.join("")).not.toContain("Duration");
    expect(en.bodies.join("")).not.toContain("耗时");
    expect(zh.traceText).not.toContain("Duration");
    expect(en.traceText).not.toContain("耗时");

    // 6. 只读展示不修改记录：文件字节指纹前后一致
    const before = sha256(readFileSync(zh.traceFile));
    void zh.translator.t("detail.durationLabel");
    void en.translator.t("detail.durationLabel");
    expect(sha256(readFileSync(zh.traceFile))).toBe(before);

    recordEvidence("execution", {
      requestBodies: {
        count: zh.bodies.length,
        sha256: { "zh-CN": sha256(zh.bodies.join("\n")), "en-US": sha256(en.bodies.join("\n")) },
        equal: en.bodies.join("\n") === zh.bodies.join("\n"),
      },
      normalizedTrace: {
        sha256: { "zh-CN": sha256(normalizedTrace(zh)), "en-US": sha256(normalizedTrace(en)) },
        equal: normalizedTrace(en) === normalizedTrace(zh),
        normalizedFields: ["id", "created_at", "timing", "dur_ms", "ttft_ms"],
      },
      tool: {
        declaration: firstBody.tools[0]?.function,
        message: toolMessage?.content,
        result: zhTool.result,
      },
      technicalFormat: { isoUtcPattern: ISO_UTC.source, integerUsage: true },
    });
  }, 120_000);

  it("模型实验计划不随 locale 变化（同父 run、同固定实验组）", async () => {
    const run = await runControlled("zh-CN");
    const planOf = async (translator: Translator): Promise<string> => {
      const result = await modelReplayRunMany({
        parentId: run.runId,
        arms: [
          { model: "controlled-model", params: { temperature: 0.9 } },
          { model: "alternate-model", params: { temperature: 0.3 } },
        ],
        config: { ...runConfig(), params: undefined },
        tools: sampleTools(),
        load: (id) => readRun(join(run.dir, `${id}.jsonl`)),
        outDir: run.dir,
        experimentId: "exp_i18n58_fixed",
        dryRun: true,
        toolPolicy: "require_pure",
      });
      // 语言上下文生效：同一计划对象的展示文案按语言投影
      expect(translator.t("experiment.armEffectiveParams")).toContain(
        translator.locale === "zh-CN" ? "生效" : "Effective",
      );
      return JSON.stringify(result);
    };

    const zhPlan = await planOf(createTranslator({ locale: "zh-CN" }));
    const enPlan = await planOf(createTranslator({ locale: "en-US" }));
    expect(enPlan).toBe(zhPlan);
    const parsed = JSON.parse(zhPlan) as {
      plan: Array<{ params: Record<string, unknown>; warnings: unknown[] }>;
      arms: unknown[];
    };
    expect(parsed.plan).toHaveLength(2);
    expect(parsed.plan[0]?.params).toEqual({ temperature: 0.9 });
    expect(parsed.plan[1]?.params).toEqual({ temperature: 0.3 });
    expect(parsed.arms).toEqual([]);
    expect(zhPlan).not.toContain("生效");
    expect(zhPlan).not.toContain("Effective");

    recordEvidence("plan", {
      planSha256: sha256(zhPlan),
      equal: enPlan === zhPlan,
    });
  }, 120_000);

  it("检查点导出：files/补丁/清单字节不随语言漂移", async () => {
    const exportUnder = async (locale: Locale): Promise<ExportRun> => {
      const translator = createTranslator({ locale });
      const target = makeTempDir(`i18n-58-export-${locale}-`);
      const result = await exportWorkspaceSnapshot(
        {
          dataDir,
          runId: exportRunId,
          stepSpanId: exportStepId,
          targetDir: target,
          expectedSnapshotId: exportSnapshotId,
        },
        { now: () => FIXED_NOW },
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error("导出失败");
      // 同一检查点在两语言下都会被作为相同目标；展示标签才随语言变化
      expect(translator.t("export.targetInitial")).toMatch(
        locale === "zh-CN" ? /初始检查点/ : /initial checkpoint/,
      );
      return { translator, target, facts: treeFacts(target), result };
    };

    const zh = await exportUnder("zh-CN");
    const en = await exportUnder("en-US");

    // 1. 文件树/补丁/清单的完整字节事实一致（固定时钟 ⇒ 可整树比较）
    expect(en.facts).toEqual(zh.facts);
    const factAt = (run: ExportRun, path: string): FileFact => {
      const fact = run.facts.find((item) => item.path === path);
      if (fact === undefined) throw new Error(`缺少 ${path}`);
      return fact;
    };
    const manifest = readFileSync(join(zh.target, "rebaseagent-export.json"), "utf8");
    expect(readFileSync(join(en.target, "rebaseagent-export.json"), "utf8")).toBe(manifest);
    expect(factAt(en, "changes.patch")).toEqual(factAt(zh, "changes.patch"));
    expect(readFileSync(join(zh.target, "changes.patch"))).toEqual(
      readFileSync(join(en.target, "changes.patch")),
    );

    // 2. 清单事实：原文、整数大小与固定 UTC 时间；没有本地化展开口径
    const parsed = JSON.parse(manifest) as {
      source: Record<string, unknown>;
      files: Array<{ path: string; bytes: number; sha256: string; kind: string; status: string }>;
      unpreserved: Record<string, string>;
      patch: { status: string; covered: string[] };
      created_at: string;
    };
    expect(parsed.source).toEqual({
      run_id: exportRunId,
      step_span_id: exportStepId,
      snapshot_id: exportSnapshotId,
      initial_snapshot_id: expect.any(String),
    });
    expect(parsed.created_at).toBe(FIXED_NOW);
    expect(parsed.patch.status).toBe("written");
    expect(parsed.files.map((file) => file.path)).toEqual([
      "a.txt",
      "bin.dat",
      "spaced path.txt",
      "中文.txt",
    ]);
    for (const file of parsed.files) {
      expect(Number.isInteger(file.bytes)).toBe(true);
      expect(file.bytes).toBe(readFileSync(join(zh.target, "files", file.path)).byteLength);
      expect(file.sha256).toBe(sha256(readFileSync(join(zh.target, "files", file.path))));
    }
    expect(parsed.unpreserved.permissions).toBe("未保留（原状态未知）");
    expect(manifest).not.toContain("initial checkpoint");
    expect(manifest).not.toContain("初始检查点");

    // 3. 导出结果事实一致（目标物理路径不同，仅比较领域事实）
    if (!zh.result.ok || !en.result.ok) throw new Error("导出失败");
    expect(en.result.value.fileCount).toBe(zh.result.value.fileCount);
    expect(en.result.value.totalFileBytes).toBe(zh.result.value.totalFileBytes);
    expect(en.result.value.snapshotId).toBe(zh.result.value.snapshotId);
    expect(en.result.value.stepSpanId).toBe(zh.result.value.stepSpanId);
    expect(en.result.value.patch).toEqual(zh.result.value.patch);
    expect(readFileSync(join(zh.target, "files", "中文.txt"), "utf8")).toBe("第一行\n第二行\n新增");
    expect(readFileSync(join(zh.target, "files", "bin.dat"))).toEqual(
      Buffer.from([0x00, 0xff, 0x41, 0x42]),
    );

    // 4. 两次导出都不改写数据根（源 trace/附件逐字不变）
    expect(treeFacts(dataDir)).toEqual(sourceBefore);

    recordEvidence("export", {
      fixedNow: FIXED_NOW,
      manifestSha256: sha256(manifest),
      patchSha256: factAt(zh, "changes.patch").sha256,
      treeFacts: zh.facts,
      sourceUnchanged: true,
      sameBytes: en.facts.every(
        (fact, index) =>
          fact.path === zh.facts[index]?.path && fact.sha256 === zh.facts[index]?.sha256,
      ),
    });
  }, 120_000);
});
