import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import type { RunLoader } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  MockLlmClient,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../agent-loop/test/helpers";
import { promptReplayRun } from "../src/index";
import type { PromptForkEdit } from "../src/index";

/**
 * U4 任务 2.4：`promptReplayRun` 的 `onRunIdentified`。
 *
 * 判据来源：tasks.md 2.4 + design D5；delta spec `prompt-replay`。
 * 验收场景（delta 逐字标题）：
 * - 「prompt 身份在后续失败时仍可关联」——三种既有编辑（system_prompt / user_message /
 *   model_params）各断言一次：回调恰一次、值等于实际新记录的 meta.id、先于首次 LLM；
 *   loop 因 LLM 失败按 errored 收尾时调用方仍持有该 id，且不靠解析异常文案取身份；
 * - 「prompt 前置拒绝不报告假身份」——未封存父本、空编辑、双真相源漂移都零回调、
 *   零模型调用、零子记录（隔离父本拒绝门禁另有既有用例负责，此处不重复）；
 * - 「prompt 观察者兼容且释放」——省略与抛错两种观察者的终止事件、调用数与文件数一致。
 */

const TASK = "读取 README.md 并把要点写入 summary.md";
const TOOLS = sampleTools();
const CONFIG = sampleConfig();
const PARENT_SCRIPT = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { content: "任务完成。" },
];
const ONE_TURN = [{ content: "一步作答。" }];

const EDITS: Record<"system_prompt" | "user_message" | "model_params", PromptForkEdit> = {
  system_prompt: { field: "system_prompt", value: "你是只许一次说清的助手，禁止调用工具。" },
  user_message: { field: "user_message", value: "请凭常识总结 README 的要点。" },
  model_params: {
    field: "model_params",
    value: { model: "deepseek-chat", params: { temperature: 0.3 } },
  },
};

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prompt-identity-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function loader(dir: string): RunLoader {
  return (id) => readRun(join(dir, `${id}.jsonl`));
}

async function createParent(dir: string): Promise<string> {
  const tmpFile = join(dir, "tmp-parent.jsonl");
  await runLoop(
    CONFIG,
    initialMessages(TASK),
    new JsonlTracer(tmpFile),
    TOOLS,
    new MockLlmClient(PARENT_SCRIPT),
  );
  const id = readRun(tmpFile).meta.id;
  renameSync(tmpFile, join(dir, `${id}.jsonl`));
  return id;
}

/** 去掉终止事件 ⇒ 父 run 变 crashed（不可分叉） */
function stripEndEvent(dir: string, id: string): void {
  const file = join(dir, `${id}.jsonl`);
  const kept = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.includes('"type":"run.event"'));
  writeFileSync(file, `${kept.join("\n")}\n`);
  expect(readRun(file).status).toBe("crashed");
}

function jsonlFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

describe("U4 2.4 promptReplayRun 的身份观察", () => {
  it("三种既有编辑字段各报告一次真实新身份，且都先于首次 LLM 调用", async () => {
    for (const [field, edit] of Object.entries(EDITS)) {
      const dir = tempDir();
      const parentId = await createParent(dir);
      const llm = new MockLlmClient(ONE_TURN);
      const seen: { id: string; callsAtCallback: number }[] = [];
      const result = await promptReplayRun({
        parentId,
        edit,
        config: CONFIG,
        tools: TOOLS,
        load: loader(dir),
        outDir: dir,
        llm,
        onRunIdentified: (id) => {
          seen.push({ id, callsAtCallback: llm.requests.length });
        },
      });
      expect(seen, field).toEqual([{ id: result.id, callsAtCallback: 0 }]);
      const record = readRun(join(dir, `${result.id}.jsonl`));
      // 报告的是这条新记录自己的 id；从头执行 ⇒ 独立轨迹（span 从 s_01 起）
      expect(record.meta.id, field).toBe(result.id);
      expect(record.meta.parent, field).toBe(parentId);
      expect(jsonlFiles(dir), field).toHaveLength(2);
    }
  });

  it("meta 写出后模型失败：调用方仍持有该 id，可按它读到 errored 记录（不解析异常文案）", async () => {
    const dir = tempDir();
    const parentId = await createParent(dir);
    const seen: string[] = [];
    const result = await promptReplayRun({
      parentId,
      edit: EDITS.system_prompt,
      config: CONFIG,
      tools: TOOLS,
      load: loader(dir),
      outDir: dir,
      llm: new MockLlmClient([]),
      onRunIdentified: (id) => {
        seen.push(id);
      },
    });
    expect(seen).toEqual([result.id]);
    const record = readRun(join(dir, `${seen[0]}.jsonl`));
    expect(record.events.at(-1)).toMatchObject({ event: "errored" });
  });

  it("前置拒绝一律不报告假身份：未封存父本 / 空编辑 / 双真相源漂移", async () => {
    let seen = 0;
    const identify = (): void => {
      seen += 1;
    };

    const crashedDir = tempDir();
    const crashedParent = await createParent(crashedDir);
    stripEndEvent(crashedDir, crashedParent);
    const crashedLlm = new MockLlmClient(ONE_TURN);
    await expect(
      promptReplayRun({
        parentId: crashedParent,
        edit: EDITS.system_prompt,
        config: CONFIG,
        tools: TOOLS,
        load: loader(crashedDir),
        outDir: crashedDir,
        llm: crashedLlm,
        onRunIdentified: identify,
      }),
    ).rejects.toThrow(/缺失终止事件/);
    expect(crashedLlm.requests).toHaveLength(0);
    expect(jsonlFiles(crashedDir)).toEqual([`${crashedParent}.jsonl`]);

    const emptyDir = tempDir();
    const emptyParent = await createParent(emptyDir);
    const emptyLlm = new MockLlmClient(ONE_TURN);
    await expect(
      promptReplayRun({
        parentId: emptyParent,
        edit: { field: "user_message", value: TASK },
        config: CONFIG,
        tools: TOOLS,
        load: loader(emptyDir),
        outDir: emptyDir,
        llm: emptyLlm,
        onRunIdentified: identify,
      }),
    ).rejects.toThrow(/空 fork/);
    expect(emptyLlm.requests).toHaveLength(0);
    expect(jsonlFiles(emptyDir)).toEqual([`${emptyParent}.jsonl`]);

    const driftDir = tempDir();
    const driftParent = await createParent(driftDir);
    const driftLlm = new MockLlmClient(ONE_TURN);
    await expect(
      promptReplayRun({
        parentId: driftParent,
        edit: EDITS.user_message,
        config: { ...CONFIG, systemPrompt: "与录制事实不符的 system prompt" },
        tools: TOOLS,
        load: loader(driftDir),
        outDir: driftDir,
        llm: driftLlm,
        onRunIdentified: identify,
      }),
    ).rejects.toThrow(/双真相源/);
    expect(driftLlm.requests).toHaveLength(0);
    expect(jsonlFiles(driftDir)).toEqual([`${driftParent}.jsonl`]);

    expect(seen).toBe(0);
  });

  it("省略观察者与抛错观察者：终止事件、模型调用数与落盘文件数一致", async () => {
    const observed: { event: string; calls: number; files: number }[] = [];
    for (const mode of ["absent", "throws"] as const) {
      const dir = tempDir();
      const parentId = await createParent(dir);
      const llm = new MockLlmClient(ONE_TURN);
      const result = await promptReplayRun({
        parentId,
        edit: EDITS.system_prompt,
        config: CONFIG,
        tools: TOOLS,
        load: loader(dir),
        outDir: dir,
        llm,
        onRunIdentified:
          mode === "absent"
            ? undefined
            : () => {
                throw new Error("观察者炸了");
              },
      });
      const record = readRun(join(dir, `${result.id}.jsonl`));
      observed.push({
        event: String(record.events.at(-1)?.event),
        calls: llm.requests.length,
        files: jsonlFiles(dir).length,
      });
    }
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(observed[0]);
    expect(observed[0]).toEqual({ event: "stopped", calls: 1, files: 2 });
  });
});
