import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun, resolveBranch } from "@rebaseagent/trace-sdk";
import type { RunLoader, RunRecord } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  MockLlmClient,
  type ScriptedTurn,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../agent-loop/test/helpers";
import { deriveReplayState, replayRun } from "../src/index";
import type { ReplayEdit } from "../src/index";

/** 编排测试的父 run 由真实 runLoop + mock LLM 现造（config_hash 现算，自洽可比对） */
const TASK = "读取 README.md 并把要点写入 summary.md";
const TOOLS = sampleTools();
const CONFIG = sampleConfig();
const PARENT_SCRIPT: ScriptedTurn[] = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { toolCalls: [{ id: "c2", name: "write_file", args: '{"path":"summary.md"}' }] },
  { content: "任务完成：要点已写入 summary.md。" },
];
/** 重跑剧本：看到编辑后的 read_file 结果后基于新内容写入（与父轨迹分道扬镳） */
const FORK_SCRIPT: ScriptedTurn[] = [
  {
    content: "读取结果已纠正，基于新内容写入。",
    toolCalls: [{ id: "c3", name: "write_file", args: '{"path":"summary.md"}' }],
  },
  { content: "任务完成：基于编辑后的 README 写入 summary.md。" },
];
/** 再分叉剧本：编辑 write_file 结果后直接收尾（一步） */
const FURTHER_SCRIPT: ScriptedTurn[] = [{ content: "任务完成：二次分叉完成。" }];

const EDIT: ReplayEdit = {
  field: "result",
  value: "# ReBaseAgent（编辑后的历史）\n\n不止回放，还能改变。",
};
const EDIT2: ReplayEdit = { field: "result", value: "已写入 summary.md（二次编辑版）" };

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "replay-run-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** outDir 约定：run 文件按 <id>.jsonl 命名（与 replayRun 落盘规则一致） */
function loader(dir: string): RunLoader {
  return (id) => readRun(join(dir, `${id}.jsonl`));
}

/** 用真实 runLoop 生成三步 completed 父 run（read_file → write_file → 收尾） */
async function createParent(dir: string): Promise<string> {
  const tmpFile = join(dir, "tmp-parent.jsonl");
  await runLoop(
    CONFIG,
    initialMessages(TASK),
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

/** 把 completed 父 run 改写成代理录制形态（meta 去 config_hash、加 source、task 换常量） */
function makeProxyRun(dir: string, id: string): void {
  const file = join(dir, `${id}.jsonl`);
  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const meta = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  const { config_hash: _removed, ...rest } = meta;
  rest.task = "(llm-proxy)";
  rest.source = { kind: "proxy", base_url: "http://127.0.0.1:8787/v1" };
  lines[0] = JSON.stringify(rest);
  writeFileSync(file, `${lines.join("\n")}\n`);
  expect(readRun(file).meta.config_hash).toBeUndefined();
}

function firstLlm(record: RunRecord): Extract<RunRecord["spans"][number], { kind: "llm.call" }> {
  const span = record.spans.find((s) => s.kind === "llm.call");
  if (span === undefined || span.kind !== "llm.call") {
    throw new Error(`run ${record.meta.id} 缺少 llm.call span`);
  }
  return span;
}

describe("replayRun：正常编辑 read_file result 重跑（tasks 3.1/3.2）", () => {
  it("产出 fork run：meta.parent/fork 正确、span 从父链最大序号延续、父文件逐字节不变", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const parentFile = join(dir, `${parentId}.jsonl`);
      const parentBefore = readFileSync(parentFile, "utf8");
      const parentRecord = readRun(parentFile);
      expect(parentRecord.spans.map((s) => s.id)).toEqual([
        "s_01",
        "s_02",
        "s_03",
        "s_04",
        "s_05",
        "s_06",
        "s_07",
        "s_08",
      ]);

      const mock = new MockLlmClient(FORK_SCRIPT);
      const result = await replayRun({
        parentId,
        atSpanId: "s_03",
        edit: EDIT,
        config: CONFIG,
        tools: TOOLS,
        load: loader(dir),
        outDir: dir,
        llm: mock,
      });

      // 返回新 id；文件存在于 outDir
      expect(result.id).toMatch(/^run_/);
      const forkFile = join(dir, `${result.id}.jsonl`);
      const record = readRun(forkFile);

      // meta：id / parent / fork / config_hash 与父一致（现算同源）
      expect(record.meta.id).toBe(result.id);
      expect(record.meta.parent).toBe(parentId);
      expect(record.meta.fork).toEqual({ at_span: "s_03", edit: EDIT });
      expect(record.meta.config_hash).toBe(parentRecord.meta.config_hash);
      expect(record.status).toBe("completed");

      // span id 从父链最大序号（s_08）之后延续：s_09..s_13，两轮迭代
      expect(record.spans.map((s) => s.id)).toEqual(["s_09", "s_10", "s_11", "s_12", "s_13"]);
      expect(record.events).toEqual([
        expect.objectContaining({ event: "stopped", reason: "completed", at: 2 }),
      ]);

      // 首次 llm.call 的录制请求 ≡ derive 出的新前缀（录制 messages 直接作 loop 输入）
      const expected = deriveReplayState({
        records: [parentRecord],
        atSpanId: "s_03",
        edit: EDIT,
      }).messages;
      expect(firstLlm(record).request.messages).toEqual(expected);
      // 被编辑的 tool 消息带着新值进入模型上下文
      const edited = firstLlm(record).request.messages.find((m) => m.role === "tool");
      expect(edited?.content).toBe(EDIT.value);

      // 工具真实重执行：write_file 的 result 是 handler 返回值
      const writeTool = record.spans.find(
        (s) => s.kind === "tool.invoke" && s.tool === "write_file",
      );
      expect(writeTool?.kind).toBe("tool.invoke");
      if (writeTool?.kind !== "tool.invoke") return;
      expect(writeTool.result).toBe("已写入 summary.md");

      // mock LLM 恰被调用两轮（零真实 API）
      expect(mock.requests).toHaveLength(2);

      // 父文件逐字节不变
      expect(readFileSync(parentFile, "utf8")).toBe(parentBefore);
    } finally {
      cleanup();
    }
  });
});

describe("replayRun：拒绝路径（tasks 3.3）", () => {
  it("crashed 父 run（缺终止事件）→ 报错、零 LLM 调用、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      makeCrashed(dir, parentId);
      const before = readdirSync(dir).sort();
      const mock = new MockLlmClient([]);
      await expect(
        replayRun({
          parentId,
          atSpanId: "s_03",
          edit: EDIT,
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

  it("config_hash 不一致（换了 system prompt）→ 报错、零 LLM 调用、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      const otherConfig: RunConfig = sampleConfig({
        systemPrompt: "你是文件助手，但换成了新的系统提示词。",
      });
      const mock = new MockLlmClient([]);
      await expect(
        replayRun({
          parentId,
          atSpanId: "s_03",
          edit: EDIT,
          config: otherConfig,
          tools: TOOLS,
          load: loader(dir),
          outDir: dir,
          llm: mock,
        }),
      ).rejects.toThrow(/config_hash 不一致/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("代理录制的父 run（无 config_hash）→ 明确报错指向代理分叉、零 LLM 调用、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      makeProxyRun(dir, parentId);
      const before = readdirSync(dir).sort();
      const mock = new MockLlmClient([]);
      await expect(
        replayRun({
          parentId,
          atSpanId: "s_03",
          edit: EDIT,
          config: CONFIG,
          tools: TOOLS,
          load: loader(dir),
          outDir: dir,
          llm: mock,
        }),
      ).rejects.toThrow(/由本地录制代理录制/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("at_span 指向 llm.call（非 tool.invoke）→ 报错、零 LLM 调用、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      const mock = new MockLlmClient([]);
      await expect(
        replayRun({
          parentId,
          atSpanId: "s_02",
          edit: EDIT,
          config: CONFIG,
          tools: TOOLS,
          load: loader(dir),
          outDir: dir,
          llm: mock,
        }),
      ).rejects.toThrow(/必须是 tool\.invoke/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });
});

describe("replayRun：分支 run 再分叉（tasks 3.4，resolveBranch 三层展开）", () => {
  it("r_01 → fork r_02 → 再 fork r_03：span 序号跨两级延续，三层轨迹 id 无重复", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const rootId = await createParent(dir);
      const rootRecord = readRun(join(dir, `${rootId}.jsonl`));

      // 一层分叉：编辑 r_01 的 read_file（s_03）
      const first = await replayRun({
        parentId: rootId,
        atSpanId: "s_03",
        edit: EDIT,
        config: CONFIG,
        tools: TOOLS,
        load: loader(dir),
        outDir: dir,
        llm: new MockLlmClient(FORK_SCRIPT),
      });
      const forkRecord = readRun(join(dir, `${first.id}.jsonl`));
      expect(forkRecord.meta.parent).toBe(rootId);
      expect(forkRecord.spans.map((s) => s.id)).toEqual(["s_09", "s_10", "s_11", "s_12", "s_13"]);
      // 取 r_02 自身的 write_file tool.invoke（s_11）作为二次分叉点
      const toolSpan = forkRecord.spans.find((s) => s.kind === "tool.invoke");
      expect(toolSpan?.kind).toBe("tool.invoke");
      if (toolSpan?.kind !== "tool.invoke") return;
      expect(toolSpan.id).toBe("s_11");

      // 二层分叉：编辑 r_02 的 write_file（s_11）
      const second = await replayRun({
        parentId: first.id,
        atSpanId: toolSpan.id,
        edit: EDIT2,
        config: CONFIG,
        tools: TOOLS,
        load: loader(dir),
        outDir: dir,
        llm: new MockLlmClient(FURTHER_SCRIPT),
      });
      const leafRecord = readRun(join(dir, `${second.id}.jsonl`));
      expect(leafRecord.meta.parent).toBe(first.id);
      expect(leafRecord.meta.fork).toEqual({ at_span: "s_11", edit: EDIT2 });
      // span 序号跨两级链延续：r_01 最大 s_08、r_02 最大 s_13 → r_03 从 s_14 起
      expect(leafRecord.spans.map((s) => s.id)).toEqual(["s_14", "s_15"]);
      expect(leafRecord.status).toBe("completed");

      // resolveBranch 三层展开：链长 3、span id 全集无重复、被取代段已截断
      const resolved = resolveBranch(second.id, loader(dir));
      expect(resolved.chain).toHaveLength(3);
      expect(resolved.chain.map((hop) => hop.meta.id)).toEqual([rootId, first.id, second.id]);
      expect(resolved.chain[0]?.fork).toBeNull();
      expect(resolved.chain[1]?.fork).toEqual({ at_span: "s_03", edit: EDIT });
      expect(resolved.chain[2]?.fork).toEqual({ at_span: "s_11", edit: EDIT2 });
      const ids = resolved.spans.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      // 保留段：根 s_01..s_03 + r_02 s_09..s_11 + r_03 s_14..s_15
      expect(ids).toEqual(["s_01", "s_02", "s_03", "s_09", "s_10", "s_11", "s_14", "s_15"]);
      // 被取代段（根 s_04..s_08、r_02 s_12..s_13）不得出现
      for (const dropped of ["s_04", "s_05", "s_06", "s_07", "s_08", "s_12", "s_13"]) {
        expect(ids).not.toContain(dropped);
      }

      // 二次分叉派生锚点：r_03 首次 llm.call 请求 ≡ derive(records=[root, r_02])
      const expected2 = deriveReplayState({
        records: [rootRecord, forkRecord],
        atSpanId: "s_11",
        edit: EDIT2,
      }).messages;
      expect(firstLlm(leafRecord).request.messages).toEqual(expected2);
      // r_03 首次请求携带二次编辑的 write_file 结果（最后一条 tool 消息；前一条 read_file 仍是一次编辑值）
      const forkToolMessages = firstLlm(leafRecord).request.messages.filter(
        (m) => m.role === "tool",
      );
      expect(forkToolMessages.at(-1)?.content).toBe(EDIT2.value);
    } finally {
      cleanup();
    }
  });
});

describe("replayRun：工具表与 config 数量不一致提前拒绝", () => {
  it("config.tools 与 tools（含 handler）数量不同 → 报错、不产生文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir);
      const before = readdirSync(dir).sort();
      const badTools: Tool[] = [TOOLS[0] as Tool];
      const mock = new MockLlmClient([]);
      await expect(
        replayRun({
          parentId,
          atSpanId: "s_03",
          edit: EDIT,
          config: CONFIG,
          tools: badTools,
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
