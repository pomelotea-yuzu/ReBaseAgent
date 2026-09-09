import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configHash, runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, LlmResponse, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import type { RunLoader } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  MockLlmClient,
  type ScriptedTurn,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../agent-loop/test/helpers";
import { derivePromptForkState, modelReplayRunMany, promptReplayRun } from "../src/index";

/**
 * 模型 A/B 多臂实验测试（4.1）。父 run 一律由真实 runLoop + mock LLM 现造
 * （config_hash 现算、自洽可比对），全程零真实 API、零费用。
 */
const TASK = "读取 README.md 并把要点写入 summary.md";

/** 全 pure 工具表：每项显式 sideEffect: false（默认门禁下唯一可跑的形状） */
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

/** 带副作用的工具表：write_file 连标记都没有（真实 trace 的常见形状） */
function sideEffectTools(): Tool[] {
  return [
    ...pureTools(),
    {
      name: "write_file",
      description: "把内容写入指定路径",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      handler: (args) => `已写入 ${(args as { path: string }).path}`,
    },
  ];
}

function configFor(tools: Tool[]): RunConfig {
  return sampleConfig({ tools: tools.map(({ handler: _h, ...def }) => def) });
}

const PURE = pureTools();
const PURE_CONFIG = configFor(PURE);

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "model-ab-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function loader(dir: string): RunLoader {
  return (id) => readRun(join(dir, `${id}.jsonl`));
}

/** 用真实 runLoop 生成 completed 父 run */
async function createParent(
  dir: string,
  options: {
    config?: RunConfig;
    tools?: Tool[];
    script?: ScriptedTurn[];
    messages?: ReturnType<typeof initialMessages>;
  } = {},
): Promise<string> {
  const config = options.config ?? PURE_CONFIG;
  const tools = options.tools ?? PURE;
  const script = options.script ?? [{ content: "父 run 完成。" }];
  const tmp = join(dir, "tmp-parent.jsonl");
  await runLoop(
    config,
    options.messages ?? initialMessages(TASK),
    new JsonlTracer(tmp),
    tools,
    new MockLlmClient(script),
  );
  const record = readRun(tmp);
  expect(record.status).toBe("completed");
  renameSync(tmp, join(dir, `${record.meta.id}.jsonl`));
  return record.meta.id;
}

/** 每臂一个独立剧本（用于验证每臂独立 client） */
function perArmClient(scripts: ScriptedTurn[][]): (arm: { index: number }) => LlmClient {
  return ({ index }) => new MockLlmClient(scripts[index] ?? []);
}

/** 去掉 meta.config_hash（可同时伪装 proxy） */
function stripConfigHash(dir: string, id: string, asProxy = false): void {
  const file = join(dir, `${id}.jsonl`);
  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const meta = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  const { config_hash: _removed, ...rest } = meta;
  if (asProxy) {
    rest.source = { kind: "proxy", base_url: "http://127.0.0.1:18787/v1" };
  }
  lines[0] = JSON.stringify(rest);
  writeFileSync(file, `${lines.join("\n")}\n`);
}

describe("modelReplayRunMany：两臂 A/B（端到端，mock LLM）", () => {
  it("两个 fork run 同父、同 experimentId、config_hash 与父一致、model 分别生效", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const parentRecord = readRun(join(dir, `${parentId}.jsonl`));

      const result = await modelReplayRunMany({
        parentId,
        arms: [{ model: "model-a" }, { model: "model-b", params: { temperature: 0.2 } }],
        config: PURE_CONFIG,
        tools: PURE,
        load: loader(dir),
        outDir: dir,
        experimentId: "exp_fixed",
        confirmCost: true,
        llm: perArmClient([[{ content: "A 回答" }], [{ content: "B 回答" }]]),
      });

      expect(result.ok).toBe(true);
      expect(result.experimentId).toBe("exp_fixed");
      expect(result.arms).toHaveLength(2);
      const ids = result.arms.map((a) => a.id);
      expect(ids.every((id) => typeof id === "string" && id?.startsWith("run_"))).toBe(true);

      for (let i = 0; i < result.arms.length; i++) {
        const arm = result.arms[i];
        if (arm?.id == null) throw new Error("arm 未落盘");
        const record = readRun(join(dir, `${arm.id}.jsonl`));
        expect(record.meta.parent).toBe(parentId);
        // 同源实验：只换 model/params，system prompt 与工具表不变 → config_hash 与父相同
        expect(record.meta.config_hash).toBe(parentRecord.meta.config_hash);
        expect(record.meta.config_hash).toBe(
          configHash(PURE_CONFIG.systemPrompt, PURE_CONFIG.tools),
        );
        expect(record.meta.fork?.at_span).toBe("s_02");
        expect(record.meta.fork?.edit.field).toBe("model_params");
        const value = record.meta.fork?.edit.value as {
          model: string;
          params?: Record<string, number>;
          experimentId?: string;
        };
        expect(value.experimentId).toBe("exp_fixed");
        // 首次 llm.call 的 request.model 就是该臂的模型
        const firstLlm = record.spans.find((s) => s.kind === "llm.call");
        expect(firstLlm?.kind === "llm.call" ? firstLlm.request.model : null).toBe(arm.model);
        if (i === 1) expect(value.params).toEqual({ temperature: 0.2 });
      }
      // 启动 messages 与父一致（深拷贝，未被 arm 间共享改写）
      const aRecord = readRun(join(dir, `${result.arms[0]?.id}.jsonl`));
      const aLlm = aRecord.spans.find((s) => s.kind === "llm.call");
      expect(aLlm?.kind === "llm.call" ? aLlm.request.messages : []).toEqual(initialMessages(TASK));
    } finally {
      cleanup();
    }
  });

  it("父 run 未录制 params，arm 提供数值 params 也算实际改变", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const parentLlm = readRun(join(dir, `${parentId}.jsonl`)).spans.find(
        (s) => s.kind === "llm.call",
      );
      expect(parentLlm?.kind === "llm.call" ? parentLlm.request.params : null).toBeUndefined();

      const result = await modelReplayRunMany({
        parentId,
        arms: [
          { model: PURE_CONFIG.model, params: { temperature: 0.1 } },
          { model: PURE_CONFIG.model, params: { temperature: 0.9 } },
        ],
        config: PURE_CONFIG,
        tools: PURE,
        load: loader(dir),
        outDir: dir,
        confirmCost: true,
        llm: perArmClient([[{ content: "A" }], [{ content: "B" }]]),
      });
      expect(result.ok).toBe(true);
      expect(result.plan.map((p) => p.changed)).toEqual([
        ["params.temperature"],
        ["params.temperature"],
      ]);
    } finally {
      cleanup();
    }
  });

  it("重复执行产生新 run id，不覆盖旧文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const arms = [{ model: "m1" }, { model: "m2" }];
      const first = await modelReplayRunMany({
        parentId,
        arms,
        config: PURE_CONFIG,
        tools: PURE,
        load: loader(dir),
        outDir: dir,
        confirmCost: true,
        llm: perArmClient([[{ content: "A" }], [{ content: "B" }]]),
      });
      const second = await modelReplayRunMany({
        parentId,
        arms,
        config: PURE_CONFIG,
        tools: PURE,
        load: loader(dir),
        outDir: dir,
        confirmCost: true,
        llm: perArmClient([[{ content: "A" }], [{ content: "B" }]]),
      });
      expect(first.arms.map((a) => a.id)).not.toEqual(second.arms.map((a) => a.id));
      // 父 + 两次实验 = 5 个文件；旧 run 未被覆盖
      expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(5);
    } finally {
      cleanup();
    }
  });
});

describe("modelReplayRunMany：前置门禁（零文件、零调用）", () => {
  it("单臂 → 拒绝并指向 prompt fork", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1" }],
          config: PURE_CONFIG,
          tools: PURE,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[]]),
        }),
      ).rejects.toThrow(/至少需要 2 个 arm/);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("空 fork（model 与 params 都与父相同）→ 拒绝", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: PURE_CONFIG.model }, { model: PURE_CONFIG.model }],
          config: PURE_CONFIG,
          tools: PURE,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/空 fork/);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("双真相源：config.systemPrompt 与父录制不一致 → 先校验后拒绝（不覆写掩盖）", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1" }, { model: "m2" }],
          config: { ...PURE_CONFIG, systemPrompt: "被偷偷改掉的 system prompt" },
          tools: PURE,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/双真相源不一致/);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("工具表逐字段不一致（给 write_file 补 sideEffect: false）→ 逃生舱也救不了，config_hash 拒绝", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const tools = sideEffectTools();
      const config = configFor(tools);
      const parentId = await createParent(dir, { config, tools });
      const before = readdirSync(dir).sort();

      // 补齐缺失的 sideEffect 标记：既想绕过副作用门禁，又改变了配置指纹——
      // configHash 计入该字段的有无，因此补标记会被同源校验拦下
      const patched = tools.map((t) => (t.name === "write_file" ? { ...t, sideEffect: false } : t));
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [
            { model: "m1", allowSideEffects: true },
            { model: "m2", allowSideEffects: true },
          ],
          config: { ...config, tools: patched.map(({ handler: _h, ...def }) => def) },
          tools: patched,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/config_hash 不一致/);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("副作用工具 → 拒绝，错误文本指明触发工具与首期边界", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const tools = sideEffectTools();
      const config = configFor(tools);
      const parentId = await createParent(dir, { config, tools });
      const before = readdirSync(dir).sort();
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1" }, { model: "m2" }],
          config,
          tools,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/write_file[\s\S]*sideEffect/);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("全批 allowSideEffects → 放行并把声明写进 fork.edit 供审计", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const tools = sideEffectTools();
      const config = configFor(tools);
      const parentId = await createParent(dir, { config, tools });
      const result = await modelReplayRunMany({
        parentId,
        arms: [
          { model: "m1", allowSideEffects: true },
          { model: "m2", allowSideEffects: true },
        ],
        config,
        tools,
        load: loader(dir),
        outDir: dir,
        confirmCost: true,
        llm: perArmClient([[{ content: "A" }], [{ content: "B" }]]),
      });
      expect(result.ok).toBe(true);
      expect(result.sideEffectsAllowed).toBe(true);
      for (const arm of result.arms) {
        const record = readRun(join(dir, `${arm.id}.jsonl`));
        expect(
          (record.meta.fork?.edit.value as { allowSideEffects?: boolean }).allowSideEffects,
        ).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it("只有一臂声明 allowSideEffects → 整批拒绝（不允许半程放行）", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const tools = sideEffectTools();
      const config = configFor(tools);
      const parentId = await createParent(dir, { config, tools });
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1", allowSideEffects: true }, { model: "m2" }],
          config,
          tools,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/sideEffect/);
    } finally {
      cleanup();
    }
  });

  it("CLI 策略 require_empty：父 run 带工具 → 拒绝并提示改用桌面端", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const tools = sideEffectTools();
      const config = configFor(tools);
      const parentId = await createParent(dir, { config, tools });
      const before = readdirSync(dir).sort();
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1" }, { model: "m2" }],
          config: { ...config, tools: [] },
          tools: [],
          load: loader(dir),
          outDir: dir,
          toolPolicy: "require_empty",
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/改用桌面端/);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("缺少字符串 system 消息的父 run → 拒绝", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir, {
        messages: [{ role: "user", content: TASK }],
      });
      const before = readdirSync(dir).sort();
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1" }, { model: "m2" }],
          config: PURE_CONFIG,
          tools: PURE,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/system 消息/);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("proxy 来源 / 缺 config_hash 的父 run → 拒绝", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      stripConfigHash(dir, parentId, true);
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1" }, { model: "m2" }],
          config: PURE_CONFIG,
          tools: PURE,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/本地录制代理/);
      cleanup();
    } finally {
      const { dir: dir2, cleanup: cleanup2 } = tempDir();
      try {
        const parentId = await createParent(dir2);
        stripConfigHash(dir2, parentId, false);
        await expect(
          modelReplayRunMany({
            parentId,
            arms: [{ model: "m1" }, { model: "m2" }],
            config: PURE_CONFIG,
            tools: PURE,
            load: loader(dir2),
            outDir: dir2,
            confirmCost: true,
            llm: perArmClient([[], []]),
          }),
        ).rejects.toThrow(/缺少 config_hash/);
      } finally {
        cleanup2();
      }
    }
  });

  it("未确认费用 / 缺 apiKey → 拒绝真实调用", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1" }, { model: "m2" }],
          config: PURE_CONFIG,
          tools: PURE,
          load: loader(dir),
          outDir: dir,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/未确认费用/);
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1" }, { model: "m2" }],
          config: { ...PURE_CONFIG, apiKey: "" },
          tools: PURE,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/缺少 apiKey/);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("非法的 model_params 值（非数值 params / 注入 baseURL）→ 拒绝", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1", params: { temperature: Number.NaN } }, { model: "m2" }],
          config: PURE_CONFIG,
          tools: PURE,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/非法的 model_params 编辑值/);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("工具表与 config.tools 数量不一致 → 提前拒绝", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1" }, { model: "m2" }],
          config: PURE_CONFIG,
          tools: [],
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/数量不一致/);
    } finally {
      cleanup();
    }
  });
});

describe("modelReplayRunMany：experimentId 分批", () => {
  it("缺省自动生成；同批所有 arm 共享同一个 id", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const result = await modelReplayRunMany({
        parentId,
        arms: [{ model: "m1" }, { model: "m2" }, { model: "m3" }],
        config: PURE_CONFIG,
        tools: PURE,
        load: loader(dir),
        outDir: dir,
        confirmCost: true,
        llm: perArmClient([[{ content: "A" }], [{ content: "B" }], [{ content: "C" }]]),
      });
      expect(result.experimentId).toMatch(/^exp_/);
      expect(result.arms).toHaveLength(3);
      const ids = result.arms.map((a) => {
        const record = readRun(join(dir, `${a.id}.jsonl`));
        return (record.meta.fork?.edit.value as { experimentId?: string }).experimentId;
      });
      expect(new Set(ids).size).toBe(1);
      expect(ids[0]).toBe(result.experimentId);
    } finally {
      cleanup();
    }
  });

  it("同批出现不同 experimentId → 拒绝", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [
            { model: "m1", experimentId: "exp-a" },
            { model: "m2", experimentId: "exp-b" },
          ],
          config: PURE_CONFIG,
          tools: PURE,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/experimentId 冲突/);
    } finally {
      cleanup();
    }
  });
});

describe("modelReplayRunMany：dry-run 与失败隔离", () => {
  it("dry-run 不需要 apiKey、不联网、不写文件，只返回计划", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      const result = await modelReplayRunMany({
        parentId,
        arms: [{ model: "m1" }, { model: "m2", params: { temperature: 0.5 } }],
        config: { ...PURE_CONFIG, apiKey: "" },
        tools: PURE,
        load: loader(dir),
        outDir: dir,
        dryRun: true,
      });
      expect(result.ok).toBe(true);
      expect(result.arms).toEqual([]);
      expect(result.plan).toEqual([
        {
          index: 0,
          model: "m1",
          params: {},
          changed: ["model"],
          allowSideEffects: false,
        },
        {
          index: 1,
          model: "m2",
          params: { temperature: 0.5 },
          changed: ["model", "params.temperature"],
          allowSideEffects: false,
        },
      ]);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("一臂失败：另一臂保留，失败臂记 error，ok=false，不自动重试", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const calls: number[] = [];
      const failing: LlmClient = {
        complete: async (): Promise<{ response: LlmResponse; requestBody: unknown }> => {
          throw new Error("provider 500");
        },
      };
      const result = await modelReplayRunMany({
        parentId,
        arms: [{ model: "m1" }, { model: "m2" }, { model: "m3" }],
        config: PURE_CONFIG,
        tools: PURE,
        load: loader(dir),
        outDir: dir,
        confirmCost: true,
        llm: (arm) => {
          calls.push(arm.index);
          return arm.index === 1 ? failing : new MockLlmClient([{ content: "ok" }]);
        },
      });
      expect(result.ok).toBe(false);
      expect(result.arms[0]?.error).toBeNull();
      expect(result.arms[0]?.id).toMatch(/^run_/);
      expect(result.arms[1]?.error).toContain("provider 500");
      // 失败臂仍落盘（错误即数据：error outcome 记在自己的 trace 里），只是不算成功
      expect(result.arms[1]?.id).toMatch(/^run_/);
      expect(result.arms[2]?.error).toBeNull();
      // 失败臂不重试：每个 arm 只取一次 client
      expect(calls).toEqual([0, 1, 2]);
    } finally {
      cleanup();
    }
  });

  it("取消：父 signal 中止后未开始的 arm 不创建 run，已完成 arm 保留", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const controller = new AbortController();
      let n = 0;
      const client: LlmClient = {
        complete: async (): Promise<{ response: LlmResponse; requestBody: unknown }> => {
          n += 1;
          // 第二臂执行中取消：第三臂不应开始
          if (n === 2) controller.abort();
          return {
            response: {
              content: "ok",
              reasoningContent: null,
              toolCalls: [],
              usage: { in: 1, out: 1 },
              ttftMs: 1,
            },
            requestBody: {},
          };
        },
      };
      const result = await modelReplayRunMany({
        parentId,
        arms: [{ model: "m1" }, { model: "m2" }, { model: "m3" }],
        config: PURE_CONFIG,
        tools: PURE,
        load: loader(dir),
        outDir: dir,
        confirmCost: true,
        signal: controller.signal,
        llm: () => client,
      });
      expect(result.arms[0]?.id).toMatch(/^run_/);
      expect(result.arms[2]?.id).toBeNull();
      expect(result.arms[2]?.error).toContain("取消");
      expect(n).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe("promptReplayRun：model_params 单臂路径", () => {
  it("单臂换 model：config_hash 与父一致，model 生效，messages 原样", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const parentRecord = readRun(join(dir, `${parentId}.jsonl`));
      const result = await promptReplayRun({
        parentId,
        edit: { field: "model_params", value: { model: "single-arm" } },
        config: PURE_CONFIG,
        tools: PURE,
        load: loader(dir),
        outDir: dir,
        llm: new MockLlmClient([{ content: "单臂回答" }]),
      });
      const record = readRun(join(dir, `${result.id}.jsonl`));
      expect(record.meta.config_hash).toBe(parentRecord.meta.config_hash);
      const llm = record.spans.find((s) => s.kind === "llm.call");
      expect(llm?.kind === "llm.call" ? llm.request.model : null).toBe("single-arm");
      expect(llm?.kind === "llm.call" ? llm.request.messages : []).toEqual(initialMessages(TASK));
    } finally {
      cleanup();
    }
  });
});

describe("modelReplayRunMany：既有能力不回归", () => {
  it("sampleTools（含无标记 write_file）作为父 run 时，默认门禁拒绝 A/B——诚实边界而非静默放行", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const tools = sampleTools();
      const config = sampleConfig();
      const parentId = await createParent(dir, { config, tools });
      await expect(
        modelReplayRunMany({
          parentId,
          arms: [{ model: "m1" }, { model: "m2" }],
          config,
          tools,
          load: loader(dir),
          outDir: dir,
          confirmCost: true,
          llm: perArmClient([[], []]),
        }),
      ).rejects.toThrow(/write_file/);
      // 同一父 run 的 prompt fork 不受影响（它本就可以改 system prompt）
      const fork = await promptReplayRun({
        parentId,
        edit: { field: "system_prompt", value: "换个 system prompt" },
        config,
        tools,
        load: loader(dir),
        outDir: dir,
        llm: new MockLlmClient([{ content: "ok" }]),
      });
      expect(fork.id).toMatch(/^run_/);
    } finally {
      cleanup();
    }
  });

  it("derivePromptForkState 对 model_params 的输出形状（空编辑拒绝）", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const record = readRun(join(dir, `${parentId}.jsonl`));
      const state = derivePromptForkState({
        record,
        edit: { field: "model_params", value: { model: "other-model" } },
      });
      expect(state.modelOverride).toEqual({ model: "other-model", params: undefined });
      // model_params 不动启动 messages，systemPrompt 恒为父原值
      expect(state.systemPrompt).toBe(PURE_CONFIG.systemPrompt);
      expect(state.messages).toEqual(initialMessages(TASK));
      expect(() =>
        derivePromptForkState({
          record,
          edit: { field: "model_params", value: { model: PURE_CONFIG.model, params: {} } },
        }),
      ).toThrow(/空 fork/);
    } finally {
      cleanup();
    }
  });
});
