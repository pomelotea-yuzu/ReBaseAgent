import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configHash, runLoop } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import type { RunLoader, RunRecord } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  MockLlmClient,
  type ScriptedTurn,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../agent-loop/test/helpers";
import { derivePromptForkState, promptReplayRun } from "../src/index";
import type { PromptForkEdit } from "../src/index";

/**
 * prompt fork 编排测试：父 run 由真实 runLoop + mock LLM 现造（config_hash 现算，自洽可比对）。
 * 全程零真实 API。
 */
const TASK = "读取 README.md 并把要点写入 summary.md";
const TOOLS = sampleTools();
const CONFIG = sampleConfig();
const PARENT_SCRIPT: ScriptedTurn[] = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { toolCalls: [{ id: "c2", name: "write_file", args: '{"path":"summary.md"}' }] },
  { content: "任务完成：要点已写入 summary.md。" },
];
/** system prompt fork 后的重跑剧本：行为随新约束改变 */
const SYS_FORK_SCRIPT: ScriptedTurn[] = [
  { content: "遵守新约束：任务完成（system prompt 已更换）。" },
];
/** user message fork 后的重跑剧本 */
const USER_FORK_SCRIPT: ScriptedTurn[] = [{ content: "换一种问法也能完成：要点如下。" }];

const SYS_EDIT: PromptForkEdit = {
  field: "system_prompt",
  value: "你是只许一次说清的助手，禁止调用工具。",
};
const USER_EDIT: PromptForkEdit = {
  field: "user_message",
  value: "请直接凭常识总结一个 README 该有的要点。",
};

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "prompt-replay-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function loader(dir: string): RunLoader {
  return (id) => readRun(join(dir, `${id}.jsonl`));
}

/** 用真实 runLoop 生成三步 completed 父 run（read_file → write_file → 收尾） */
async function createParent(dir: string, messages = initialMessages(TASK)): Promise<string> {
  const tmpFile = join(dir, "tmp-parent.jsonl");
  await runLoop(
    CONFIG,
    messages,
    new JsonlTracer(tmpFile),
    TOOLS,
    new MockLlmClient(PARENT_SCRIPT),
  );
  const record = readRun(tmpFile);
  expect(record.status).toBe("completed");
  const id = record.meta.id;
  renameSync(tmpFile, join(dir, `${id}.jsonl`));
  return id;
}

/** 把 completed 父 run 文件篡改为 crashed（去掉 run.event 终止行） */
function makeCrashed(dir: string, id: string): void {
  const file = join(dir, `${id}.jsonl`);
  const kept = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.includes('"type":"run.event"'));
  writeFileSync(file, `${kept.join("\n")}\n`);
  expect(readRun(file).status).toBe("crashed");
}

/** 去掉 meta.config_hash（可同时伪装成 proxy） */
function stripConfigHash(dir: string, id: string, asProxy = false): void {
  const file = join(dir, `${id}.jsonl`);
  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const meta = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  const { config_hash: _removed, ...rest } = meta;
  if (asProxy) {
    rest.task = "(llm-proxy)";
    rest.source = { kind: "proxy", base_url: "http://127.0.0.1:18787/v1" };
  }
  lines[0] = JSON.stringify(rest);
  writeFileSync(file, `${lines.join("\n")}\n`);
}

function firstLlm(record: RunRecord): Extract<RunRecord["spans"][number], { kind: "llm.call" }> {
  const span = record.spans.find((s) => s.kind === "llm.call");
  if (span === undefined || span.kind !== "llm.call") {
    throw new Error(`run ${record.meta.id} 缺少 llm.call span`);
  }
  return span;
}

describe("promptReplayRun：system prompt 从头重跑（端到端，mock LLM）", () => {
  it("新 run 从 agent.step 1 完整记录、config_hash 变化、父文件逐字节不变、readRun 可读", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const parentFile = join(dir, `${parentId}.jsonl`);
      const parentBefore = readFileSync(parentFile, "utf8");
      const parentRecord = readRun(parentFile);

      const mock = new MockLlmClient(SYS_FORK_SCRIPT);
      const result = await promptReplayRun({
        parentId,
        edit: SYS_EDIT,
        config: CONFIG,
        tools: TOOLS,
        load: loader(dir),
        outDir: dir,
        llm: mock,
      });

      // meta：id / parent / fork（at_span = 父首次 llm.call id）
      expect(result.id).toMatch(/^run_/);
      const record = readRun(join(dir, `${result.id}.jsonl`));
      expect(record.meta.id).toBe(result.id);
      expect(record.meta.parent).toBe(parentId);
      expect(record.meta.fork).toEqual({ at_span: "s_02", edit: SYS_EDIT });
      expect(record.status).toBe("completed");

      // config_hash 变化（新 system prompt + 原工具表）；且可由编辑值精确复算
      expect(record.meta.config_hash).not.toBe(parentRecord.meta.config_hash);
      expect(record.meta.config_hash).toBe(configHash(SYS_EDIT.value, CONFIG.tools));

      // 从头执行：span 从 s_01 重新编号，首 span 是 agent.step n=1
      expect(record.spans.map((s) => s.id)).toEqual(["s_01", "s_02"]);
      expect(record.spans[0]).toEqual(expect.objectContaining({ kind: "agent.step", n: 1 }));
      expect(record.events).toEqual([
        expect.objectContaining({ event: "stopped", reason: "completed", at: 1 }),
      ]);

      // 首次 llm.call 的请求：system = 编辑值，user = 原任务（其余启动上下文保持）
      const request = firstLlm(record).request;
      expect(request.messages[0]).toEqual({ role: "system", content: SYS_EDIT.value });
      expect(request.messages[1]).toEqual({ role: "user", content: TASK });

      // mock LLM 恰被调用一轮（零真实 API）
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.[0]).toEqual({ role: "system", content: SYS_EDIT.value });

      // 父文件逐字节不变
      expect(readFileSync(parentFile, "utf8")).toBe(parentBefore);
    } finally {
      cleanup();
    }
  });
});

describe("promptReplayRun：双真相源守护", () => {
  it("system prompt fork：config_hash 的 systemPrompt 输入 ≡ 首次真实请求中的 system content", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const result = await promptReplayRun({
        parentId,
        edit: SYS_EDIT,
        config: CONFIG,
        tools: TOOLS,
        load: loader(dir),
        outDir: dir,
        llm: new MockLlmClient(SYS_FORK_SCRIPT),
      });
      const record = readRun(join(dir, `${result.id}.jsonl`));

      // 真相源一：config_hash 按编辑值复算一致
      expect(record.meta.config_hash).toBe(configHash(SYS_EDIT.value, CONFIG.tools));
      // 真相源二：首次 llm.call 录制请求中的 system content 也是编辑值
      const request = firstLlm(record).request;
      const systemContent = request.messages.find((m) => m.role === "system")?.content;
      expect(systemContent).toBe(SYS_EDIT.value);

      // derive 层的两个输出本身就是同一个值（编排层强制覆写的依据）
      const parentRecord = readRun(join(dir, `${parentId}.jsonl`));
      const state = derivePromptForkState({ record: parentRecord, edit: SYS_EDIT });
      expect(state.systemPrompt).toBe(SYS_EDIT.value);
      expect(state.messages[0]?.content).toBe(SYS_EDIT.value);
    } finally {
      cleanup();
    }
  });
});

describe("promptReplayRun：user message 从头重跑", () => {
  it("只替换首条 user message；config_hash 与父一致（system prompt 未变）", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const parentRecord = readRun(join(dir, `${parentId}.jsonl`));

      const result = await promptReplayRun({
        parentId,
        edit: USER_EDIT,
        config: CONFIG,
        tools: TOOLS,
        load: loader(dir),
        outDir: dir,
        llm: new MockLlmClient(USER_FORK_SCRIPT),
      });
      const record = readRun(join(dir, `${result.id}.jsonl`));

      expect(record.meta.fork).toEqual({ at_span: "s_02", edit: USER_EDIT });
      const request = firstLlm(record).request;
      expect(request.messages[0]).toEqual({ role: "system", content: CONFIG.systemPrompt });
      expect(request.messages[1]).toEqual({ role: "user", content: USER_EDIT.value });
      // system prompt 与工具表都没变 → 新 hash 与父相同
      expect(record.meta.config_hash).toBe(parentRecord.meta.config_hash);
    } finally {
      cleanup();
    }
  });
});

describe("promptReplayRun：连续 fork（A → B → C）", () => {
  it("C 的启动上下文取自直接父 B 自身首次请求，不混入祖先 spans；A/B 文件不变", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const aId = await createParent(dir);
      const aFile = join(dir, `${aId}.jsonl`);
      const aBefore = readFileSync(aFile, "utf8");

      // A → B：改 system prompt
      const b = await promptReplayRun({
        parentId: aId,
        edit: SYS_EDIT,
        config: CONFIG,
        tools: TOOLS,
        load: loader(dir),
        outDir: dir,
        llm: new MockLlmClient(SYS_FORK_SCRIPT),
      });
      const bId = b.id;
      const bFile = join(dir, `${bId}.jsonl`);
      const bBefore = readFileSync(bFile, "utf8");
      const bRecord = readRun(bFile);
      expect(bRecord.meta.parent).toBe(aId);

      // B → C：再改首条 user message。
      // config.systemPrompt 必须等于直接父 B 首次请求录制的 system（= B 的编辑值）——
      // 桌面端正是从父 run 首次 llm.call 读取该值；传 A 的原值会被双真相源校验拒绝
      const c = await promptReplayRun({
        parentId: bId,
        edit: USER_EDIT,
        config: { ...CONFIG, systemPrompt: SYS_EDIT.value },
        tools: TOOLS,
        load: loader(dir),
        outDir: dir,
        llm: new MockLlmClient(USER_FORK_SCRIPT),
      });
      const cRecord = readRun(join(dir, `${c.id}.jsonl`));

      expect(cRecord.meta.parent).toBe(bId);
      expect(cRecord.meta.fork).toEqual({ at_span: "s_02", edit: USER_EDIT });

      // C 的启动上下文来自 B 自身首次请求：system 是 B 的编辑值（不是 A 的原值）
      const request = firstLlm(cRecord).request;
      expect(request.messages[0]).toEqual({ role: "system", content: SYS_EDIT.value });
      expect(request.messages[1]).toEqual({ role: "user", content: USER_EDIT.value });

      // C 的 spans 是自己的完整新轨迹（s_01 起），没有 A/B 的旧 spans 混入
      expect(cRecord.spans.map((s) => s.id)).toEqual(["s_01", "s_02"]);

      // A 与 B 文件逐字节不变
      expect(readFileSync(aFile, "utf8")).toBe(aBefore);
      expect(readFileSync(bFile, "utf8")).toBe(bBefore);
    } finally {
      cleanup();
    }
  });
});

describe("promptReplayRun：拒绝路径（创建文件与调用模型之前）", () => {
  it("crashed 父 run → 报错、零 LLM 调用、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      makeCrashed(dir, parentId);
      const before = readdirSync(dir).sort();
      const mock = new MockLlmClient([]);
      await expect(
        promptReplayRun({
          parentId,
          edit: SYS_EDIT,
          config: CONFIG,
          tools: TOOLS,
          load: loader(dir),
          outDir: dir,
          llm: mock,
        }),
      ).rejects.toThrow(/缺失终止事件/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("proxy 来源的父 run → 报错指向代理分叉入口、零调用、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      stripConfigHash(dir, parentId, true);
      const before = readdirSync(dir).sort();
      const mock = new MockLlmClient([]);
      await expect(
        promptReplayRun({
          parentId,
          edit: SYS_EDIT,
          config: CONFIG,
          tools: TOOLS,
          load: loader(dir),
          outDir: dir,
          llm: mock,
        }),
      ).rejects.toThrow(/本地录制代理/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("非 proxy 但缺 config_hash 的父 run → 报错、零调用、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      stripConfigHash(dir, parentId, false);
      const before = readdirSync(dir).sort();
      const mock = new MockLlmClient([]);
      await expect(
        promptReplayRun({
          parentId,
          edit: SYS_EDIT,
          config: CONFIG,
          tools: TOOLS,
          load: loader(dir),
          outDir: dir,
          llm: mock,
        }),
      ).rejects.toThrow(/缺少 config_hash/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("父 run 首次请求无字符串 system 消息 → 报错、零调用、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      // 无 system 消息的父 run（config_hash 仍由 config.systemPrompt 现算，但首次请求里没有 system）
      const parentId = await createParent(dir, [{ role: "user", content: TASK }]);
      const before = readdirSync(dir).sort();
      const mock = new MockLlmClient([]);
      await expect(
        promptReplayRun({
          parentId,
          edit: SYS_EDIT,
          config: CONFIG,
          tools: TOOLS,
          load: loader(dir),
          outDir: dir,
          llm: mock,
        }),
      ).rejects.toThrow(/不含字符串形式的 system 消息/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("空 fork（编辑前后相同）→ 报错、零调用、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      const mock = new MockLlmClient([]);
      await expect(
        promptReplayRun({
          parentId,
          edit: { field: "system_prompt", value: CONFIG.systemPrompt },
          config: CONFIG,
          tools: TOOLS,
          load: loader(dir),
          outDir: dir,
          llm: mock,
        }),
      ).rejects.toThrow(/空 fork/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("非法编辑目标 → 报错、零调用、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      const mock = new MockLlmClient([]);
      await expect(
        promptReplayRun({
          parentId,
          edit: { field: "messages" as never, value: "x" },
          config: CONFIG,
          tools: TOOLS,
          load: loader(dir),
          outDir: dir,
          llm: mock,
        }),
      ).rejects.toThrow(/非法的 prompt fork 编辑目标/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("config.tools 与 tools 数量不一致 → 提前报错、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      const mock = new MockLlmClient([]);
      await expect(
        promptReplayRun({
          parentId,
          edit: SYS_EDIT,
          config: CONFIG,
          tools: [TOOLS[0] as (typeof TOOLS)[number]],
          load: loader(dir),
          outDir: dir,
          llm: mock,
        }),
      ).rejects.toThrow(/数量不一致/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });
});
