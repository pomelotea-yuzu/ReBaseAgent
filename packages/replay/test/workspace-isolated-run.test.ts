import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configHash } from "@rebaseagent/agent-loop";
import type { Message, RunConfig } from "@rebaseagent/agent-loop";
import { readRun } from "@rebaseagent/trace-sdk";
import { computeWorkspaceSnapshotId } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  FILE_TOOLS_V1_PROFILE,
  WORKSPACE_TRACES_DIR_NAME,
  WRITE_FILE_TOOL_NAME,
  createIsolatedRun,
  hashWorkspaceContent,
  readWorkspaceFile,
} from "../src/index";
import type { FileToolDefinition } from "../src/index";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * 4.1：`createIsolatedRun`（隔离根运行编排）。
 *
 * 验证点（tasks.md 4.1）：`replay/创建受控父本` —— "任务、工具指纹、根关系、文件名与快照正确"。
 *
 * ## 用例为什么是端到端的
 *
 * 本任务是**编排**：它的正确性几乎全部体现在"零件之间的顺序与接线"上，而不是某个纯函数的输出。
 * 所以正向用例一律真跑：真源目录 → 真两遍导入 → 真世界 → 真受控工具 → 真 `runLoop` + 桩 LLM →
 * 真 `JsonlTracer` 落盘 → 真 `readRun` 校验 → 真只读接口回读。唯一被替换掉的是 LLM 网络调用。
 *
 * ## 拒绝类用例断言的是"最强的那种零副作用"
 *
 * "没写 trace"是弱结论——采集已经把整个目录读进来、把附件发出去了。这里断言的是
 * **`dataDir` 这个目录根本没被创建**：只有"预检全部先于任何落盘副作用"才做得到。
 */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const SOURCE_TREE: Record<string, string> = {
  "a.txt": "before",
  "nested/b.txt": "nested",
};

const SYSTEM_PROMPT = "你是文件助手。";
const USER_MESSAGE = "把 hello 写进 out/hello.txt";

/** 一轮 LLM 的编排响应 */
interface ScriptedTurn {
  readonly content?: string;
  readonly toolCalls?: Array<{ readonly id: string; readonly name: string; readonly args: string }>;
}

/**
 * 最小桩：按剧本逐轮返回；剧本耗尽即抛（loop 会把 LLM 失败记成 `errored` 终止）。
 *
 * `tracesDir` 传入时，在**首次**被调用那一刻抓一次现场——用来证明"初始采集完成后才调用 LLM"
 * （首次请求发出时，meta 已经带上了 v2 与初始快照）。
 */
class ScriptedLlm {
  readonly requests: Message[][] = [];
  atFirstCall: { readonly files: readonly string[]; readonly metaLine: unknown } | null = null;
  private turn = 0;

  constructor(
    private readonly script: readonly ScriptedTurn[],
    private readonly tracesDir?: string,
  ) {}

  async complete(messages: Message[]): Promise<{
    response: {
      content: string | null;
      reasoningContent: string | null;
      toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
      usage: { in: number; out: number };
      ttftMs: number;
    };
    requestBody: unknown;
  }> {
    if (this.turn === 0 && this.tracesDir !== undefined) {
      this.atFirstCall = captureTraces(this.tracesDir);
    }
    this.requests.push([...messages]);
    const turn = this.script[this.turn];
    this.turn += 1;
    if (turn === undefined) {
      throw new Error(`剧本耗尽：第 ${this.turn} 轮无编排响应`);
    }
    return {
      response: {
        content: turn.content ?? null,
        reasoningContent: null,
        toolCalls: (turn.toolCalls ?? []).map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.args },
        })),
        usage: { in: 100, out: 50 },
        ttftMs: 10,
      },
      requestBody: {},
    };
  }
}

/** runLoop 的第 5 参类型（LlmClient）；桩只实现 complete */
const asLoopLlm = (llm: ScriptedLlm): Parameters<typeof createIsolatedRun>[0]["llm"] =>
  llm as unknown as Parameters<typeof createIsolatedRun>[0]["llm"];

/** 抓一次 traces 目录现场：文件名清单 + 第一个临时文件的首行（meta） */
function captureTraces(dir: string): { files: readonly string[]; metaLine: unknown } {
  if (!existsSync(dir)) {
    return { files: [], metaLine: null };
  }
  const files = [...readdirSync(dir)].sort();
  const tmp = files.find((name) => name.endsWith(".tmp"));
  if (tmp === undefined) {
    return { files, metaLine: null };
  }
  const firstLine = readFileSync(join(dir, tmp), "utf8").split("\n")[0] ?? "";
  return { files, metaLine: JSON.parse(firstLine) as unknown };
}

function makeConfig(systemPrompt = SYSTEM_PROMPT): RunConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    systemPrompt,
    tools: [...FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

/** 一轮工具调用（args 是字符串，与真实 LLM 给的形式一致） */
function writeCall(id: string, path: string, content: string) {
  return { id, name: WRITE_FILE_TOOL_NAME, args: JSON.stringify({ path, content }) };
}

/** 一棵真实源树 + 一个**尚不存在**的 dataDir（用来断言"预检失败连目录都不建"） */
function makeFixture(): { source: string; dataDir: string } {
  const source = makeTempDir("isolated-src-");
  writeTree(source, SOURCE_TREE);
  return { source, dataDir: join(makeTempDir("isolated-data-"), "data") };
}

afterEach(cleanupTempDirs);

describe("createIsolatedRun", () => {
  it("创建受控父本：任务、工具指纹、根关系、文件名与快照全部正确", async () => {
    const { source, dataDir } = makeFixture();
    const tracesDir = join(dataDir, WORKSPACE_TRACES_DIR_NAME);
    const llm = new ScriptedLlm(
      [{ toolCalls: [writeCall("c1", "out/hello.txt", "hello")] }, { content: "done" }],
      tracesDir,
    );

    const result = await createIsolatedRun({
      dataDir,
      source,
      config: makeConfig(),
      userMessage: USER_MESSAGE,
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { id, outcome } = result;

    // ── 文件名与归位：只剩 `<id>.jsonl`，没有临时残留 ─────────────────────────────────
    expect(readdirSync(tracesDir)).toEqual([`${id}.jsonl`]);
    expect(outcome.event.event).toBe("stopped");

    const record = readRun(join(tracesDir, `${id}.jsonl`));
    const meta = record.meta;

    // ── 根关系：parent/fork 均为 null，v2 隔离 meta，origin = import ────────────────────
    expect(meta.parent).toBeNull();
    expect(meta.fork).toBeNull();
    expect(meta.format_version).toBe(2);
    expect(meta.workspace?.profile).toBe(FILE_TOOLS_V1_PROFILE);
    expect(meta.workspace?.world_id).toBe(id);
    expect(meta.workspace?.origin).toEqual({ kind: "import" });

    // ── 任务与工具指纹：config_hash 对应"system prompt + 固定 file-tools-v1 定义"────────
    expect(meta.task).toBe(USER_MESSAGE);
    expect(meta.config_hash).toBe(configHash(SYSTEM_PROMPT, [...FILE_TOOLS_V1_DEFINITIONS]));

    // ── 初始快照：等于源目录的真实内容（哈希逐项核对）────────────────────────────────
    const initial = meta.workspace?.initial_snapshot;
    expect(initial?.files.map((file) => file.path)).toEqual(["a.txt", "nested/b.txt"]);
    expect(initial?.files.map((file) => file.sha256)).toEqual([
      hashWorkspaceContent(utf8("before")),
      hashWorkspaceContent(utf8("nested")),
    ]);
    expect(initial?.files.map((file) => file.bytes)).toEqual([6, 6]);
    expect(initial?.id).toBe(computeWorkspaceSnapshotId(initial?.files ?? []));

    // ── 轮末检查点：包含本轮写入的文件（初始快照里没有它）──────────────────────────────
    const step = record.spans.find((span) => span.kind === "agent.step");
    expect(step).toBeDefined();
    expect(step?.workspace_snapshot?.files.map((file) => file.path)).toEqual([
      "a.txt",
      "nested/b.txt",
      "out/hello.txt",
    ]);

    // ── 可作隔离 result 分叉父本：只读接口按该轮 step 能取回**中间**文件 ────────────────
    const middle = await readWorkspaceFile({
      dataDir,
      runId: id,
      stepSpanId: step?.id ?? "",
      path: "out/hello.txt",
    });
    expect(middle.status).toBe("text");
    if (middle.status === "text") {
      expect(middle.text).toBe("hello");
    }
    // 不传 stepSpanId 读到的是初始快照 ⇒ 新写入的内容按设计不可见
    expect((await readWorkspaceFile({ dataDir, runId: id, path: "out/hello.txt" })).status).toBe(
      "not_found",
    );

    // ── 源目录逐字节不变：写只发生在世界副本里 ──────────────────────────────────────
    expect(readFileSync(join(source, "a.txt"), "utf8")).toBe("before");
    expect(readFileSync(join(source, "nested/b.txt"), "utf8")).toBe("nested");
    expect(existsSync(join(source, "out"))).toBe(false);
  });

  it("首次 LLM 调用之前，trace meta 已经带上 v2 与初始快照", async () => {
    const { source, dataDir } = makeFixture();
    const tracesDir = join(dataDir, WORKSPACE_TRACES_DIR_NAME);
    const llm = new ScriptedLlm([{ content: "done" }], tracesDir);

    const result = await createIsolatedRun({
      dataDir,
      source,
      config: makeConfig(),
      userMessage: USER_MESSAGE,
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
    });
    expect(result.ok).toBe(true);

    // 首次请求发出时：临时 trace 已存在，且首行 meta 已经是隔离 v2 形态
    expect(llm.atFirstCall?.files.some((name) => name.endsWith(".tmp"))).toBe(true);
    const metaLine = llm.atFirstCall?.metaLine as {
      format_version?: number;
      workspace?: { initial_snapshot?: { files?: unknown[] } };
    } | null;
    expect(metaLine?.format_version).toBe(2);
    expect(metaLine?.workspace?.initial_snapshot?.files).toHaveLength(2);
  });

  it("system prompt 为空串时仍可创建（config_hash 与空 prompt 对应）", async () => {
    const { source, dataDir } = makeFixture();
    const llm = new ScriptedLlm([{ content: "done" }]);

    const result = await createIsolatedRun({
      dataDir,
      source,
      config: makeConfig(""),
      userMessage: "",
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const meta = readRun(join(dataDir, WORKSPACE_TRACES_DIR_NAME, `${result.id}.jsonl`)).meta;
    expect(meta.task).toBe("");
    expect(meta.config_hash).toBe(configHash("", [...FILE_TOOLS_V1_DEFINITIONS]));
  });

  // ── 拒绝类：三类预检失败都必须在**任何**落盘副作用之前 ──────────────────────────────
  describe("预检失败零副作用", () => {
    const tampered: Array<[string, () => RunConfig]> = [
      [
        "写工具被删掉 sideEffect 标记",
        () => {
          const config = makeConfig();
          const [read, write] = FILE_TOOLS_V1_DEFINITIONS as readonly FileToolDefinition[];
          config.tools = [
            {
              name: read?.name ?? "",
              description: read?.description ?? "",
              parameters: read?.parameters ?? {},
              sideEffect: false,
            },
            // 故意不带 sideEffect：删标记**不等于**默认值，这是最常见的"改写成合法定义"路子
            {
              name: write?.name ?? "",
              description: write?.description ?? "",
              parameters: write?.parameters ?? {},
            },
          ];
          return config;
        },
      ],
      [
        "工具顺序被调换",
        () => {
          const config = makeConfig();
          config.tools = [...FILE_TOOLS_V1_DEFINITIONS].reverse();
          return config;
        },
      ],
      [
        "追加了自定义工具",
        () => {
          const config = makeConfig();
          config.tools = [
            ...FILE_TOOLS_V1_DEFINITIONS,
            { name: "shell", description: "跑命令", parameters: {}, sideEffect: true },
          ];
          return config;
        },
      ],
    ];

    for (const [name, buildConfig] of tampered) {
      it(`profile 不一致时拒绝且零副作用：${name}`, async () => {
        const { source, dataDir } = makeFixture();
        const llm = new ScriptedLlm([{ content: "done" }]);

        const result = await createIsolatedRun({
          dataDir,
          source,
          config: buildConfig(),
          userMessage: USER_MESSAGE,
          authority: { allowFileWrites: true },
          llm: asLoopLlm(llm),
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.failure.code).toBe("profile_mismatch");
        // 最强的那种零副作用：连 dataDir 都没被创建（采集/发布附件都不可能发生过）
        expect(existsSync(dataDir)).toBe(false);
        expect(llm.requests).toHaveLength(0);
      });
    }

    const authorities: Array<[string, unknown]> = [
      ["缺 allowFileWrites 键", {}],
      ["allowFileWrites 为 false", { allowFileWrites: false }],
      ['allowFileWrites 为字符串 "true"', { allowFileWrites: "true" }],
      ["authority 为 null", null],
    ];

    for (const [name, authority] of authorities) {
      it(`本次请求未授权时拒绝且零副作用：${name}`, async () => {
        const { source, dataDir } = makeFixture();
        const llm = new ScriptedLlm([{ content: "done" }]);

        const result = await createIsolatedRun({
          dataDir,
          source,
          config: makeConfig(),
          userMessage: USER_MESSAGE,
          authority,
          llm: asLoopLlm(llm),
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.failure.code).toBe("missing_authority");
        expect(existsSync(dataDir)).toBe(false);
        expect(llm.requests).toHaveLength(0);
      });
    }

    it("导入失败时透传原始分类，且零 trace、零 LLM", async () => {
      const source = join(makeTempDir("isolated-src-"), "nope");
      const dataDir = join(makeTempDir("isolated-data-"), "data");
      const llm = new ScriptedLlm([{ content: "done" }]);

      const result = await createIsolatedRun({
        dataDir,
        source,
        config: makeConfig(),
        userMessage: USER_MESSAGE,
        authority: { allowFileWrites: true },
        llm: asLoopLlm(llm),
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.failure.code).toBe("source_not_found");
      expect(result.failure.sourceFailure?.code).toBe("source_not_found");
      expect(existsSync(dataDir)).toBe(false);
      expect(llm.requests).toHaveLength(0);
    });

    it("参数形状不合法时拒绝（dataDir 空串 / userMessage 非字符串）", async () => {
      const { source, dataDir } = makeFixture();
      const llm = new ScriptedLlm([{ content: "done" }]);

      const badDataDir = await createIsolatedRun({
        dataDir: "",
        source,
        config: makeConfig(),
        userMessage: USER_MESSAGE,
        authority: { allowFileWrites: true },
        llm: asLoopLlm(llm),
      });
      expect(badDataDir.ok).toBe(false);
      if (!badDataDir.ok) {
        expect(badDataDir.failure.code).toBe("invalid_request");
      }

      const badMessage = await createIsolatedRun({
        dataDir,
        source,
        config: makeConfig(),
        userMessage: 42 as unknown as string,
        authority: { allowFileWrites: true },
        llm: asLoopLlm(llm),
      });
      expect(badMessage.ok).toBe(false);
      if (!badMessage.ok) {
        expect(badMessage.failure.code).toBe("invalid_request");
      }

      expect(existsSync(dataDir)).toBe(false);
      expect(llm.requests).toHaveLength(0);
    });
  });

  it("LLM 失败仍归位为 errored run，已完成轮次的文件事实保留", async () => {
    const { source, dataDir } = makeFixture();
    const tracesDir = join(dataDir, WORKSPACE_TRACES_DIR_NAME);
    // 剧本只给一轮：第二轮请求时桩抛错 ⇒ loop 记 errored 并封存
    const llm = new ScriptedLlm([{ toolCalls: [writeCall("c1", "out/hello.txt", "hello")] }]);

    const result = await createIsolatedRun({
      dataDir,
      source,
      config: makeConfig(),
      userMessage: USER_MESSAGE,
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.outcome.event.event).toBe("errored");

    // 归位照旧（errored 也是要保留的事实），且不留临时文件
    expect(readdirSync(tracesDir)).toEqual([`${result.id}.jsonl`]);
    const record = readRun(join(tracesDir, `${result.id}.jsonl`));
    expect(record.status).toBe("completed");
    expect(record.events.map((event) => event.event)).toContain("errored");

    // 已完成那一轮的文件事实仍在：检查点记录了写入后的真实哈希
    const step = record.spans.find((span) => span.kind === "agent.step");
    expect(step?.workspace_snapshot?.files.map((file) => file.path)).toEqual([
      "a.txt",
      "nested/b.txt",
      "out/hello.txt",
    ]);
    expect(readFileSync(join(source, "a.txt"), "utf8")).toBe("before");
  });
});
