import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, Message, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ModelAbError, modelReplayRunMany } from "../src/index";
import { ScriptedLlm } from "./isolated-helpers";
import type { ScriptedTurn } from "./isolated-helpers";

/**
 * 7.3：普通模型实验的**包层回归证据**（补既有用例没覆盖到的两条 scenario）。
 *
 * tasks.md 7.3 的验证清单里有 9 个 `model-experiments` 场景。核对包内覆盖后发现两条缺证据：
 *
 * 1. `pure 工具实验` —— 原文要求"每臂**真实执行 handler**，结果写入自己的 trace"。
 *    既有用例（`model-replay-run.test.ts`）里所有 arm 的剧本都只返回 `content`，
 *    没有任何一条让 arm 真的调用工具 ⇒ "handler 被真实执行"这件事从未被观测过。
 * 2. `拒绝不可 fork 父 run` 的**未封存**分支 —— 既有用例覆盖了"缺 config_hash"（proxy 与非 proxy），
 *    但模型实验路径上"父 run 未封存"没有用例（`prompt-replay-run.test.ts` 与 `replay-run.test.ts`
 *    各有 crashed 用例，那是别的入口）。
 *
 * 所以本文件只放这两条，其余 7 条场景由既有用例承载（对应关系写在 tasks.md 7.3 条目里）。
 *
 * ## 为什么"真实执行 handler"必须看到副作用
 *
 * "arm 跑完了"不等于"handler 被真调了"：桩工具、卡带重放、空 handler 都能让流程走完。
 * 判据因此是 handler 内部的**调用记录**（模块级数组）+ trace 里 tool.invoke 的 result
 * 等于 handler 的返回串 —— 两者同时成立才排除"用桩冒充真实结果"。
 */

const SYSTEM = "你是实验助手。";
const TASK = "读取 README.md 并汇报";

/** 每次 handler 执行都会在此留痕（用例开始时清空） */
const handlerCalls: string[] = [];

/** 全 pure 工具表：显式 `sideEffect: false`（默认门禁下唯一可跑的形状） */
function pureReadTools(): Tool[] {
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
        const path = String((args as { path?: unknown }).path);
        handlerCalls.push(path);
        return `HANDLER:${path}`;
      },
    },
  ];
}

function experimentConfig(tools: Tool[]): RunConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "parent-model",
    systemPrompt: SYSTEM,
    tools: tools.map(({ handler: _h, ...def }) => def),
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 5,
    budget: { maxTotalTokens: 100000 },
  };
}

function startupMessages(): Message[] {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: TASK },
  ];
}

/** 桩只实现 `complete`，其余 `LlmClient` 成员不参与（与既有用例同一做法） */
const asLlm = (llm: unknown): LlmClient => llm as unknown as LlmClient;

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "model-ab-regression-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  handlerCalls.length = 0;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function loaderFor(dir: string) {
  return (id: string) => readRun(join(dir, `${id}.jsonl`));
}

/** 用真实 `runLoop` 造一个已封存的父 run（真执行工具、真落盘） */
async function createParentRun(
  dir: string,
  tools: Tool[],
  script: readonly ScriptedTurn[],
): Promise<string> {
  const tmp = join(dir, "tmp-parent.jsonl");
  await runLoop(
    experimentConfig(tools),
    startupMessages(),
    new JsonlTracer(tmp),
    tools,
    asLlm(new ScriptedLlm([...script])),
  );
  const record = readRun(tmp);
  expect(record.status).toBe("completed");
  renameSync(tmp, join(dir, `${record.meta.id}.jsonl`));
  return record.meta.id;
}

describe("7.3 pure 工具实验：每臂真实执行 handler", () => {
  it("两臂各自真调 handler，结果只写进自己的 trace（不是桩、不是卡带）", async () => {
    const dir = tempDir();
    const tools = pureReadTools();
    const parentId = await createParentRun(dir, tools, [
      { toolCalls: [{ id: "p1", name: "read_file", args: JSON.stringify({ path: "README.md" }) }] },
      { content: "父 run 完成" },
    ]);
    // 父 run 也走同一条真实路径：它那次调用已经留下一条痕迹
    expect(handlerCalls).toEqual(["README.md"]);

    const armScripts = (index: number): ScriptedLlm =>
      new ScriptedLlm([
        {
          toolCalls: [
            {
              id: `a${String(index)}1`,
              name: "read_file",
              args: JSON.stringify({ path: `arm-${String(index)}.md` }),
            },
          ],
        },
        { content: `arm${String(index)} 完成` },
      ]);

    const result = await modelReplayRunMany({
      parentId,
      arms: [{ model: "model-a" }, { model: "model-b" }],
      config: experimentConfig(tools),
      tools,
      load: loaderFor(dir),
      outDir: dir,
      experimentId: "exp_pure",
      confirmCost: true,
      llm: ({ index }) => asLlm(armScripts(index)),
    });

    expect(result.ok).toBe(true);
    // **真实执行**的第一重证据：handler 被记录到的调用序列（父 1 次 + 每臂各 1 次）
    expect(handlerCalls).toEqual(["README.md", "arm-0.md", "arm-1.md"]);

    for (const [index, arm] of result.arms.entries()) {
      const armId = arm.id;
      expect(armId, `第 ${String(index)} 臂未落盘`).not.toBeNull();
      if (armId === null) {
        continue;
      }
      const record = readRun(join(dir, `${armId}.jsonl`));
      // 第二重证据：该臂 trace 里 tool.invoke 的 result 就是 handler 的返回串
      const toolSpan = record.spans.find((span) => span.kind === "tool.invoke");
      expect(toolSpan === undefined ? null : String(toolSpan.result)).toBe(
        `HANDLER:arm-${String(index)}.md`,
      );
      // 第三重证据：结果同时进了该臂自己的 messages（后续 llm.call 请求里可见）
      const llmSpans = record.spans.filter((span) => span.kind === "llm.call");
      const second = llmSpans[1];
      const toolMessage = second?.request.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toBe(`HANDLER:arm-${String(index)}.md`);
      // 各臂互不串味：自己的 trace 里查不到另一臂的路径
      const other = `HANDLER:arm-${String(index === 0 ? 1 : 0)}.md`;
      expect(JSON.stringify(record.spans)).not.toContain(other);
      // 同源：只换 model，parent 与 config_hash 与父一致
      expect(record.meta.parent).toBe(parentId);
      expect(record.meta.fork?.edit.field).toBe("model_params");
    }
  });
});

describe("7.3 拒绝不可 fork 父 run（未封存）", () => {
  it("crashed 父 run：PARENT_NOT_FORKABLE，零文件、零模型请求", async () => {
    const dir = tempDir();
    const tools = pureReadTools();
    const parentId = await createParentRun(dir, tools, [{ content: "父 run 完成" }]);

    // 定向破坏：只删终止事件行 ⇒ 未封存
    const file = join(dir, `${parentId}.jsonl`);
    const kept = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.includes('"run.event"'));
    writeFileSync(file, `${kept.join("\n")}\n`);
    expect(readRun(file).status).toBe("crashed");

    const filesBefore = readdirSync(dir).sort();
    let clientFactoryCalls = 0;

    let caught: unknown = null;
    try {
      await modelReplayRunMany({
        parentId,
        arms: [{ model: "model-a" }, { model: "model-b" }],
        config: experimentConfig(tools),
        tools,
        load: loaderFor(dir),
        outDir: dir,
        confirmCost: true,
        llm: ({ index }) => {
          clientFactoryCalls += 1;
          return asLlm(new ScriptedLlm([{ content: `不该被调用 ${String(index)}` }]));
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelAbError);
    expect(caught instanceof ModelAbError ? caught.code : null).toBe("PARENT_NOT_FORKABLE");
    // 拒绝发生在创建 tracer / 文件 / 模型请求之前
    expect(clientFactoryCalls).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(filesBefore);
    // 父文件本身没被改写（拒绝不"顺手修好"父 run）
    expect(readRun(file).status).toBe("crashed");
  });
});
