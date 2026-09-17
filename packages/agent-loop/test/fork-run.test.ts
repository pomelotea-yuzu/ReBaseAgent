import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTracer, NullTracer, readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { configHash, runLoop } from "../src/index";
import {
  MockLlmClient,
  type ScriptedTurn,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "./helpers";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-fork-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const tools = sampleTools();
const script: ScriptedTurn[] = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { content: "完成" },
];

const FORK = {
  id: "run_abc",
  parent: "run_xyz",
  fork: { at_span: "s_03", edit: { field: "result", value: "编辑后的内容" } },
} as const;

describe("runLoop：fork run 元数据注入", () => {
  it("注入 forkRun 后 run.meta 的 id/parent/fork 使用注入值，config_hash 现算", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const config = sampleConfig();
      const file = join(dir, "r.jsonl");
      await runLoop(
        config,
        initialMessages("读 README"),
        new JsonlTracer(file),
        tools,
        new MockLlmClient(script),
        FORK,
      );
      const record = readRun(file);
      expect(record.meta.id).toBe("run_abc");
      expect(record.meta.parent).toBe("run_xyz");
      expect(record.meta.fork).toEqual(FORK.fork);
      expect(record.meta.config_hash).toBe(configHash(config.systemPrompt, config.tools));
    } finally {
      cleanup();
    }
  });

  it("未注入时行为与旧版一致：parent/fork 为 null、id 自动生成", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, "r.jsonl");
      const before = await runLoop(
        sampleConfig(),
        initialMessages("读 README"),
        new NullTracer(),
        tools,
        new MockLlmClient(script),
      );
      await runLoop(
        sampleConfig(),
        initialMessages("读 README"),
        new JsonlTracer(file),
        tools,
        new MockLlmClient(script),
      );
      const record = readRun(file);
      expect(record.meta.id).toMatch(/^run_/);
      expect(record.meta.id).not.toBe("run_abc");
      expect(record.meta.parent).toBeNull();
      expect(record.meta.fork).toBeNull();
      expect(record.status).toBe("completed");
      expect(before.event.reason).toBe("completed");
    } finally {
      cleanup();
    }
  });

  it("fork 注入不改变循环语义：同 config/messages 有无 forkRun 的 span 演化一致", async () => {
    const run = async (fork?: typeof FORK) => {
      const events: string[] = [];
      const tracer = new NullTracer();
      tracer.subscribe((e) => {
        // 剔除逐次运行**必然不同**的测量值：墙上时钟（timing）与工具真实耗时（dur_ms）。
        // 不剔 dur_ms 会让本用例变成概率性失败——桩 handler 虽是同步的，但 dur_ms 取的是
        // Date.now() 两次之差，在并行跑多包的负载下可能一次 0、一次 1（2026-09-17 实测到）。
        const normalized = JSON.stringify(e, (k, v) =>
          k === "timing" || k === "dur_ms" ? undefined : v,
        );
        events.push(normalized);
      });
      const result = await runLoop(
        sampleConfig(),
        initialMessages("读 README"),
        tracer,
        tools,
        new MockLlmClient(script),
        fork,
      );
      return { events, result };
    };
    const plain = await run();
    const withFork = await run(FORK);
    // 事件流逐条一致（只有 run.meta 首条的 id/parent/fork 不同，已剔除 timing 且跳过首条）
    expect(withFork.events.slice(1)).toEqual(plain.events.slice(1));
    expect(withFork.result.messages).toEqual(plain.result.messages);
    expect(withFork.result.event).toEqual(plain.result.event);
  });
});
