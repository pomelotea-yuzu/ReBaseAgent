import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import type { RunLoader, TraceStreamEvent } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  MockLlmClient,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../agent-loop/test/helpers";
import { observeRunIdentity, replayRun } from "../src/index";
import type { ReplayEdit } from "../src/index";

/**
 * U4 任务 2.1：包层身份观察适配器 + `replayRun` 的 `onRunIdentified`。
 *
 * 判据来源：tasks.md 2.1 + design D5；delta spec `replay`。
 * 验收场景（delta 逐字标题）：
 * - 「普通 result 编排暴露已创建身份」——通过全部预检并写出 run.meta 后恰一次通知，
 *   ID 等于实际落盘的 meta.id，且**发生于首次 LLM 调用前**；后续失败不撤销该身份；
 * - 「可选观察不改变执行结果」——省略观察者 / 正常观察者 / 观察者抛错三种情况，
 *   模型调用次数、终止事件与文件数完全一致，观察异常不成为新的失败原因；
 * - 「拒绝和写入前失败没有运行身份」——预检拒绝与 meta 写出之前的失败都不回调。
 *
 * 适配器的"恰一次 / 自动解绑 / 异常隔离"用受控假 tracer 直测（时序确定、不经文件系统）；
 * 编排侧走真实 runLoop + mock LLM，断言看**收到的值与调用次数**，不看界面自述。
 */

const TASK = "读取 README.md 并把要点写入 summary.md";
const TOOLS: Tool[] = sampleTools();
const CONFIG: RunConfig = sampleConfig();
const PARENT_SCRIPT = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { content: "任务完成：要点已写入 summary.md。" },
];
const FORK_SCRIPT = [{ content: "基于编辑后的 README 作答。" }];
const EDIT: ReplayEdit = { field: "result", value: "# 编辑后的历史" };

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "run-identity-"));
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

/** 现造一个 completed 父 run（真实 runLoop，config_hash 自洽），返回 id 与首个 tool.invoke span id */
async function createParent(dir: string): Promise<{ parentId: string; atSpanId: string }> {
  const tmpFile = join(dir, "tmp-parent.jsonl");
  await runLoop(
    CONFIG,
    initialMessages(TASK),
    new JsonlTracer(tmpFile),
    TOOLS,
    new MockLlmClient(PARENT_SCRIPT),
  );
  const record = readRun(tmpFile);
  const toolSpan = record.spans.find((span) => span.kind === "tool.invoke");
  if (toolSpan === undefined) throw new Error("unreachable：父剧本必产出一个 tool.invoke");
  const parentId = record.meta.id;
  renameSync(tmpFile, join(dir, `${parentId}.jsonl`));
  return { parentId, atSpanId: toolSpan.id };
}

function forkOptions(dir: string, parent: { parentId: string; atSpanId: string }, llm: LlmClient) {
  return {
    parentId: parent.parentId,
    atSpanId: parent.atSpanId,
    edit: EDIT,
    config: CONFIG,
    tools: TOOLS,
    load: loader(dir),
    outDir: dir,
    llm,
  };
}

/** 只实现 `subscribe` 的假 tracer：用来固定「通知几次、何时解绑」的时序 */
function fakeTracer(): {
  subscribe: (listener: (event: TraceStreamEvent) => void) => () => void;
  subscribeCalls: () => number;
  emitMeta: (id: string) => void;
  emitSpanStart: () => void;
  listenerCount: () => number;
} {
  const listeners = new Set<(event: TraceStreamEvent) => void>();
  let calls = 0;
  return {
    subscribe: (listener) => {
      calls += 1;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeCalls: () => calls,
    emitMeta: (id) => {
      const event = { type: "run.meta", meta: { id } } as unknown as TraceStreamEvent;
      for (const listener of [...listeners]) listener(event);
    },
    emitSpanStart: () => {
      const event = { type: "span.start", id: "s_01", kind: "agent.step" } as TraceStreamEvent;
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

describe("U4 2.1 身份观察适配器：恰一次、异常隔离、收尾释放", () => {
  it("省略回调 ⇒ 连订阅都不建立（省略时的行为与接入前逐字节相同）", () => {
    const tracer = fakeTracer();
    const release = observeRunIdentity(tracer, undefined);
    expect(tracer.subscribeCalls()).toBe(0);
    expect(tracer.listenerCount()).toBe(0);
    expect(() => release()).not.toThrow();
  });

  it("run.meta 才通知、只通知一次，并在通知时自行解绑", () => {
    const tracer = fakeTracer();
    const seen: string[] = [];
    observeRunIdentity(tracer, (id) => {
      seen.push(id);
    });
    expect(tracer.subscribeCalls()).toBe(1);
    tracer.emitSpanStart();
    expect(seen).toEqual([]);
    tracer.emitMeta("run_real");
    tracer.emitMeta("run_second");
    expect(seen).toEqual(["run_real"]);
    expect(tracer.listenerCount()).toBe(0);
  });

  it("观察者抛错被就地吞掉：不外泄异常、不影响后续事件、也不重复通知", () => {
    const tracer = fakeTracer();
    let calls = 0;
    observeRunIdentity(tracer, () => {
      calls += 1;
      throw new Error("观察者内部故障");
    });
    expect(() => tracer.emitMeta("run_x")).not.toThrow();
    tracer.emitMeta("run_y");
    expect(calls).toBe(1);
    expect(tracer.listenerCount()).toBe(0);
  });

  it("释放函数幂等；释放后到达的事件不再通知", () => {
    const tracer = fakeTracer();
    const seen: string[] = [];
    const release = observeRunIdentity(tracer, (id) => {
      seen.push(id);
    });
    release();
    release();
    expect(tracer.listenerCount()).toBe(0);
    tracer.emitMeta("run_late");
    expect(seen).toEqual([]);
  });
});

describe("U4 2.1 replayRun 的 onRunIdentified", () => {
  it("身份恰一次、等于落盘 meta.id，且先于首次 LLM 调用", async () => {
    const dir = tempDir();
    const parent = await createParent(dir);
    const llm = new MockLlmClient(FORK_SCRIPT);
    const seen: { id: string; llmCallsAtCallback: number }[] = [];
    const result = await replayRun({
      ...forkOptions(dir, parent, llm),
      onRunIdentified: (id) => {
        seen.push({ id, llmCallsAtCallback: llm.requests.length });
      },
    });
    expect(seen).toEqual([{ id: result.id, llmCallsAtCallback: 0 }]);
    const record = readRun(join(dir, `${result.id}.jsonl`));
    // 报告的是文件里真实写出的那一行的 id（不是"预分配字符串恰好相等"的巧合）
    expect(record.meta.id).toBe(result.id);
    expect(record.meta.parent).toBe(parent.parentId);
    expect(llm.requests).toHaveLength(1);
    // 父前缀零调用：父文件字节一字未动
    expect(readFileSync(join(dir, `${parent.parentId}.jsonl`), "utf8")).toContain(
      `"id":"${parent.parentId}"`,
    );
  });

  it("meta 写出之后的失败不撤销已知身份（errored run 仍可按该 ID 读到）", async () => {
    const dir = tempDir();
    const parent = await createParent(dir);
    const seen: string[] = [];
    await replayRun({
      ...forkOptions(dir, parent, new MockLlmClient([])),
      onRunIdentified: (id) => {
        seen.push(id);
      },
    });
    expect(seen).toHaveLength(1);
    const record = readRun(join(dir, `${seen[0]}.jsonl`));
    expect(record.meta.id).toBe(seen[0]);
    expect(record.events.at(-1)).toMatchObject({ event: "errored" });
  });

  it("meta 写出前失败 ⇒ 不报告身份（没有记录就不给 ID）", async () => {
    const dir = tempDir();
    const parent = await createParent(dir);
    const seen: string[] = [];
    await expect(
      replayRun({
        ...forkOptions(dir, parent, new MockLlmClient(FORK_SCRIPT)),
        outDir: join(dir, "not-created-yet"),
        onRunIdentified: (id) => {
          seen.push(id);
        },
      }),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
    // 目录里只有父 run 一个文件：没有半成品被当成"已创建"
    expect(readdirSync(dir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("预检拒绝（未封存父本 / config_hash 不同源）⇒ 零回调、零模型调用、零新文件", async () => {
    const crashedDir = tempDir();
    const crashedParent = await createParent(crashedDir);
    const parentFile = join(crashedDir, `${crashedParent.parentId}.jsonl`);
    const withoutEnd = readFileSync(parentFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0 && !line.includes('"type":"run.event"'));
    writeFileSync(parentFile, `${withoutEnd.join("\n")}\n`);
    expect(readRun(parentFile).status).toBe("crashed");
    let seen = 0;
    const crashedLlm = new MockLlmClient(FORK_SCRIPT);
    await expect(
      replayRun({
        ...forkOptions(crashedDir, crashedParent, crashedLlm),
        onRunIdentified: () => {
          seen += 1;
        },
      }),
    ).rejects.toThrow();
    expect(seen).toBe(0);
    expect(crashedLlm.requests).toHaveLength(0);
    expect(readdirSync(crashedDir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);

    const driftDir = tempDir();
    const driftParent = await createParent(driftDir);
    const driftLlm = new MockLlmClient(FORK_SCRIPT);
    await expect(
      replayRun({
        ...forkOptions(driftDir, driftParent, driftLlm),
        config: { ...CONFIG, systemPrompt: `${CONFIG.systemPrompt}改了源码` },
        onRunIdentified: () => {
          seen += 1;
        },
      }),
    ).rejects.toThrow();
    expect(seen).toBe(0);
    expect(driftLlm.requests).toHaveLength(0);
    expect(readdirSync(driftDir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("省略观察者 / 正常观察者 / 观察者抛错：调用次数、终止事件与文件数完全一致", async () => {
    const observed: { calls: number; lastEvent: string; files: number }[] = [];
    for (const mode of ["absent", "ok", "throws"] as const) {
      const dir = tempDir();
      const parent = await createParent(dir);
      const llm = new MockLlmClient(FORK_SCRIPT);
      const result = await replayRun({
        ...forkOptions(dir, parent, llm),
        onRunIdentified:
          mode === "absent"
            ? undefined
            : () => {
                if (mode === "throws") throw new Error("观察者炸了");
              },
      });
      const record = readRun(join(dir, `${result.id}.jsonl`));
      observed.push({
        calls: llm.requests.length,
        lastEvent: String(record.events.at(-1)?.event),
        files: readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length,
      });
    }
    expect(observed).toHaveLength(3);
    expect(observed[1]).toEqual(observed[0]);
    expect(observed[2]).toEqual(observed[0]);
    expect(observed[0]?.calls).toBe(1);
    expect(observed[0]?.files).toBe(2);
  });
});
