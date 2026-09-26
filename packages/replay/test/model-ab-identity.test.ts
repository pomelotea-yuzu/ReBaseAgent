import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import type { RunLoader } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { MockLlmClient, initialMessages, sampleConfig } from "../../agent-loop/test/helpers";
import { modelReplayRunMany } from "../src/index";
import type { ArmRunIdentity } from "../src/index";

/**
 * U4 任务 2.5 + 2.6：`modelReplayRunMany` 的按臂身份观察。
 *
 * 判据来源：tasks.md 2.5/2.6 + design D5；delta spec `model-experiments`。
 * 验收场景（delta 逐字标题）：
 * - 「批次运行中可关联各臂」——每臂在该臂首次模型调用前通知 `{experimentId,index,id}`，
 *   与该臂实际落盘的 meta 一致、恰一次，后臂不覆盖前臂；
 * - 「部分失败和异常臂保留已知 ID」——一臂正常、一臂 LLM 失败（错误即数据）、
 *   一臂在**写出 meta 之后**抛错：三条都带真实 id 与各自结局，失败不阻止后续臂；
 * - 「未开始臂与 dry-run 不产生 ID」——dry-run 与取消后未开始的臂零通知、零文件、零调用；
 * - 「实验身份观察不改变原执行」——省略与抛错两种观察者的各臂 id/结局/文件数一致。
 *
 * "写 meta 后抛错"用的是 LLM 客户端返回**非法 content 形状**这一条：runLoop 落 span 时
 * schema 校验必然抛，抛点确定在 meta 之后（不是靠 fs/权限这类平台相关手段）。
 */

const TASK = "读取 README.md 并总结要点";
const PARENT_MODEL_SCRIPT = [{ content: "父 run 完成。" }];

/** 全 pure 工具表（默认门禁下唯一可跑的形状） */
function pureTools(): Tool[] {
  return [
    {
      name: "read_file",
      description: "读取指定路径的文件",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      sideEffect: false,
      handler: (args) => `内容(${(args as { path: string }).path})`,
    },
  ];
}

const PURE = pureTools();
const CONFIG: RunConfig = sampleConfig({
  tools: PURE.map(({ handler: _handler, ...definition }) => definition),
});

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "model-ab-identity-"));
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
  const tmp = join(dir, "tmp-parent.jsonl");
  await runLoop(
    CONFIG,
    initialMessages(TASK),
    new JsonlTracer(tmp),
    PURE,
    new MockLlmClient(PARENT_MODEL_SCRIPT),
  );
  const id = readRun(tmp).meta.id;
  renameSync(tmp, join(dir, `${id}.jsonl`));
  return id;
}

function jsonlFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

/** 写出 meta 之后必然抛错的客户端：response.content 是对象，span schema 拒收 */
function brokenSpanClient(): LlmClient {
  return {
    async complete() {
      return {
        response: {
          content: { ouch: true } as unknown as string,
          reasoningContent: null,
          toolCalls: [],
          usage: { in: 1, out: 1 },
          ttftMs: 1,
        },
        requestBody: {},
      };
    },
  };
}

/** LLM 失败（错误即数据）：客户端抛错 ⇒ runLoop 记 errored 终止，臂仍落盘 */
function failingClient(): LlmClient {
  return {
    async complete() {
      throw new Error("provider 500");
    },
  };
}

describe("U4 2.5 按臂身份观察", () => {
  it("每臂在该臂首次模型调用前恰通知一次，id 与各臂实际落盘记录一致且互不覆盖", async () => {
    const dir = tempDir();
    const parentId = await createParent(dir);
    const perArmCalls: number[] = [];
    const notes: ArmRunIdentity[] = [];
    const result = await modelReplayRunMany({
      parentId,
      arms: [{ model: "m-a" }, { model: "m-b" }, { model: "m-c" }],
      config: CONFIG,
      tools: PURE,
      load: loader(dir),
      outDir: dir,
      confirmCost: true,
      experimentId: "exp_watch",
      llm: ({ index }) => {
        const arm = new MockLlmClient([{ content: `臂 ${index} 完成` }]);
        return {
          async complete(messages, signal) {
            // 通知一定发生在该臂第一次请求之前：此时本臂的 requests 还是空的
            perArmCalls.push(index);
            return arm.complete(messages, signal);
          },
        };
      },
      onArmRunIdentified: (info) => {
        notes.push(info);
      },
    });
    expect(result.ok).toBe(true);
    expect(notes.map((note) => [note.experimentId, note.index])).toEqual([
      ["exp_watch", 0],
      ["exp_watch", 1],
      ["exp_watch", 2],
    ]);
    const ids = notes.map((note) => note.id);
    expect(new Set(ids).size).toBe(3);
    expect(result.arms.map((arm) => arm.id)).toEqual(ids);
    for (const [position, arm] of result.arms.entries()) {
      if (arm.id === null) throw new Error("unreachable：三臂都应落盘");
      const record = readRun(join(dir, `${arm.id}.jsonl`));
      expect(record.meta.id).toBe(arm.id);
      expect(record.meta.fork?.edit.value).toMatchObject({ experimentId: "exp_watch" });
      expect(perArmCalls[position]).toBe(position);
    }
    // 父 + 三臂
    expect(jsonlFiles(dir)).toHaveLength(4);
  });

  it("部分失败与异常臂：LLM 失败臂与写 meta 后抛错的臂都保留真实 id 与各自结局", async () => {
    const dir = tempDir();
    const parentId = await createParent(dir);
    const notes: ArmRunIdentity[] = [];
    const result = await modelReplayRunMany({
      parentId,
      arms: [{ model: "m-ok" }, { model: "m-llm-error" }, { model: "m-throw-after-meta" }],
      config: CONFIG,
      tools: PURE,
      load: loader(dir),
      outDir: dir,
      confirmCost: true,
      experimentId: "exp_partial",
      llm: ({ index }) =>
        index === 1
          ? failingClient()
          : index === 2
            ? brokenSpanClient()
            : new MockLlmClient([{ content: "ok" }]),
      onArmRunIdentified: (info) => {
        notes.push(info);
      },
    });
    // 失败不阻止既有规则允许的后续臂：三臂都被试过
    expect(result.ok).toBe(false);
    expect(result.arms).toHaveLength(3);
    expect(result.arms[0]?.error).toBeNull();
    expect(result.arms[1]?.error).toContain("provider 500");
    expect(result.arms[2]?.error).toBeTruthy();
    // 关键：抛错臂的 id **不被抹成 null**——meta 已写出，记录就在磁盘上
    expect(result.arms[2]?.id).toMatch(/^run_/);
    expect(notes.map((note) => note.index)).toEqual([0, 1, 2]);
    expect(notes.map((note) => note.id)).toEqual(result.arms.map((arm) => arm.id));
    const thrownId = result.arms[2]?.id;
    if (thrownId === null || thrownId === undefined) throw new Error("unreachable");
    expect(jsonlFiles(dir)).toContain(`${thrownId}.jsonl`);
  });

  it("meta 未写出的臂不产生身份：该臂客户端工厂抛错 ⇒ id 为 null 且无通知", async () => {
    const dir = tempDir();
    const parentId = await createParent(dir);
    const notes: ArmRunIdentity[] = [];
    const result = await modelReplayRunMany({
      parentId,
      arms: [{ model: "m-a" }, { model: "m-b" }],
      config: CONFIG,
      tools: PURE,
      load: loader(dir),
      outDir: dir,
      confirmCost: true,
      llm: ({ index }) => {
        if (index === 1) throw new Error("客户端构造失败（尚未写任何文件）");
        return new MockLlmClient([{ content: "ok" }]);
      },
      onArmRunIdentified: (info) => {
        notes.push(info);
      },
    });
    expect(notes.map((note) => note.index)).toEqual([0]);
    expect(result.arms[1]?.id).toBeNull();
    expect(result.arms[1]?.error).toContain("客户端构造失败");
    // 未写出 meta 的臂不留任何文件——不能凭预分配 id 假装有条记录
    expect(jsonlFiles(dir)).toHaveLength(2);
  });
});

describe("U4 2.6 观察的兼容与释放", () => {
  it("dry-run 与未开始的臂都不产生身份，也不消耗调用与文件", async () => {
    const dir = tempDir();
    const parentId = await createParent(dir);
    let clientUses = 0;
    let notes = 0;
    const dry = await modelReplayRunMany({
      parentId,
      arms: [{ model: "m-a" }, { model: "m-b" }],
      config: CONFIG,
      tools: PURE,
      load: loader(dir),
      outDir: dir,
      dryRun: true,
      experimentId: "exp_dry",
      llm: () => {
        clientUses += 1;
        return new MockLlmClient([{ content: "不该被调用" }]);
      },
      onArmRunIdentified: () => {
        notes += 1;
      },
    });
    expect(dry.ok).toBe(true);
    expect(dry.arms).toEqual([]);
    expect(dry.plan).toHaveLength(2);
    expect(clientUses).toBe(0);
    expect(notes).toBe(0);
    expect(jsonlFiles(dir)).toEqual([`${parentId}.jsonl`]);

    // 取消：已完成的臂保留身份，未开始的臂既无 id 也无通知
    const controller = new AbortController();
    const cancelNotes: number[] = [];
    const cancelled = await modelReplayRunMany({
      parentId,
      arms: [{ model: "m-a" }, { model: "m-b" }],
      config: CONFIG,
      tools: PURE,
      load: loader(dir),
      outDir: dir,
      confirmCost: true,
      signal: controller.signal,
      llm: ({ index }) => {
        controller.abort();
        void index;
        return new MockLlmClient([{ content: "第一臂后取消" }]);
      },
      onArmRunIdentified: (info) => {
        cancelNotes.push(info.index);
      },
    });
    expect(cancelNotes).toEqual([0]);
    expect(cancelled.arms[0]?.id).toMatch(/^run_/);
    expect(cancelled.arms[1]?.id).toBeNull();
    expect(jsonlFiles(dir)).toHaveLength(2);
  });

  it("省略观察者与抛错观察者的执行结果一致（订阅不改变臂顺序与结局）", async () => {
    const observed: { ids: (string | null)[]; errors: (string | null)[]; files: number }[] = [];
    for (const mode of ["absent", "throws"] as const) {
      const dir = tempDir();
      const parentId = await createParent(dir);
      const result = await modelReplayRunMany({
        parentId,
        arms: [{ model: "m-a" }, { model: "m-b" }],
        config: CONFIG,
        tools: PURE,
        load: loader(dir),
        outDir: dir,
        confirmCost: true,
        experimentId: "exp_equal",
        llm: ({ index }) => new MockLlmClient([{ content: `臂 ${index}` }]),
        onArmRunIdentified:
          mode === "absent"
            ? undefined
            : () => {
                throw new Error("观察者炸了");
              },
      });
      observed.push({
        ids: result.arms.map((arm) => arm.id?.slice(0, 4) ?? null),
        errors: result.arms.map((arm) => arm.error),
        files: jsonlFiles(dir).length,
      });
      // 两种模式下观察者都被调用过（臂数决定通知数），且落盘记录真实可读
      for (const arm of result.arms) {
        if (arm.id !== null) expect(readRun(join(dir, `${arm.id}.jsonl`)).meta.id).toBe(arm.id);
      }
    }
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(observed[0]);
    expect(observed[0]).toEqual({
      ids: ["run_", "run_"],
      errors: [null, null],
      files: 3,
    });
  });
});
