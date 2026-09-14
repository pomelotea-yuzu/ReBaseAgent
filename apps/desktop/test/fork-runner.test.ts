import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  MockLlmClient,
  type ScriptedTurn,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../../packages/agent-loop/test/helpers";
import { FORK_ERROR_CODES, runFork, runModelAb } from "../src/main/fork-runner";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";

/**
 * runs:fork 编排（fork-runner）测试：父 run 由真实 runLoop + mock LLM 现造，
 * 断言 fork-runner 从录制重建 config（system prompt/工具表取自录制，LLM 接入取自
 * settings），并正确拒绝：非叶子段 span / 未知工具 / 崩溃父 run / 空 fork。
 * 全程零真实 API。
 */

const TASK = "读取 README.md 并把要点写入 summary.md";
const CONFIG = sampleConfig();
const TOOLS = sampleTools();
const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

/** 父 run 剧本：三步 completed（read_file → write_file → 收尾） */
const PARENT_SCRIPT: ScriptedTurn[] = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { toolCalls: [{ id: "c2", name: "write_file", args: '{"path":"summary.md"}' }] },
  { content: "任务完成：要点已写入 summary.md。" },
];
/** 重跑剧本：看到编辑后的 read_file 结果后写 summary.md（真实桌面 handler 落盘） */
const FORK_SCRIPT: ScriptedTurn[] = [
  {
    content: "读取结果已纠正，基于新内容写入。",
    toolCalls: [{ id: "c3", name: "write_file", args: '{"path":"summary.md"}' }],
  },
  { content: "任务完成：基于编辑后的 README 写入 summary.md。" },
];
/** 再分叉剧本：直接收尾（一步） */
const FURTHER_SCRIPT: ScriptedTurn[] = [{ content: "任务完成：二次分叉完成。" }];

const NEW_README = "# ReBaseAgent（编辑后的历史）\n\n不止回放，还能改变。";

function tempRepo(): {
  traces: string;
  repo: RunRepository;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "fork-runner-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 在 traces 目录里用真实 runLoop 造一个三步 completed 父 run（span s_01..s_08） */
async function createParent(traces: string): Promise<string> {
  const tmpFile = join(traces, "tmp-parent.jsonl");
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
  renameSync(tmpFile, join(traces, `${id}.jsonl`));
  return id;
}

/** 把 completed 父 run 篡改为 crashed（去掉 run.event 终止行） */
function makeCrashed(traces: string, id: string): void {
  const file = join(traces, `${id}.jsonl`);
  const kept = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.includes('"type":"run.event"'));
  writeFileSync(file, `${kept.join("\n")}\n`);
  expect(readRun(file).status).toBe("crashed");
}

function listFiles(traces: string): string[] {
  return readdirSync(traces).sort();
}

describe("runFork：正常编辑 read_file result 重跑（tasks 4.2 happy path）", () => {
  it("产出 fork run：meta.parent/fork 正确、span 序号延续、config_hash 与父一致、父文件不变", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      const parentFile = join(traces, `${parentId}.jsonl`);
      const parentBefore = readFileSync(parentFile, "utf8");

      const mock = new MockLlmClient(FORK_SCRIPT);
      const result = await runFork(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
        { parentRunId: parentId, atSpanId: "s_03", edit: { field: "result", value: NEW_README } },
      );
      expect(result.id).toMatch(/^run_/);

      const record = readRun(join(traces, `${result.id}.jsonl`));
      expect(record.meta.parent).toBe(parentId);
      expect(record.meta.fork).toEqual({
        at_span: "s_03",
        edit: { field: "result", value: NEW_README },
      });
      expect(record.meta.config_hash).toBe(readRun(parentFile).meta.config_hash);
      expect(record.status).toBe("completed");
      // span 序号从父链最大（s_08）之后延续；两轮迭代
      expect(record.spans.map((s) => s.id)).toEqual(["s_09", "s_10", "s_11", "s_12", "s_13"]);

      // 编辑后的 tool 消息带着新值进入模型上下文
      const firstLlm = record.spans.find((s) => s.kind === "llm.call");
      expect(firstLlm?.kind).toBe("llm.call");
      if (firstLlm?.kind === "llm.call") {
        const edited = firstLlm.request.messages.find((m) => m.role === "tool");
        expect(edited?.content).toBe(NEW_README);
      }

      // 真实执行桌面 write_file handler：文件真的落在 execCwd
      const writeTool = record.spans.find(
        (s) => s.kind === "tool.invoke" && s.tool === "write_file",
      );
      expect(writeTool?.kind).toBe("tool.invoke");
      expect(writeTool?.result).toContain("已写入 summary.md");
      expect(existsSync(join(traces, "summary.md"))).toBe(true);

      // mock LLM 恰被调用两轮（零真实 API）
      expect(mock.requests).toHaveLength(2);

      // 父文件逐字节不变
      expect(readFileSync(parentFile, "utf8")).toBe(parentBefore);
    } finally {
      cleanup();
    }
  });
});

describe("runFork：拒绝路径（tasks 4.2 / 5.3）", () => {
  it("at_span 不是 tool.invoke → FORK_SPAN_NOT_IN_LEAF，不产生文件", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      const before = listFiles(traces);
      const mock = new MockLlmClient([]);
      await expect(
        runFork(
          { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
          { parentRunId: parentId, atSpanId: "s_02", edit: { field: "result", value: NEW_README } },
        ),
      ).rejects.toMatchObject({ code: FORK_ERROR_CODES.SPAN_NOT_IN_LEAF });
      expect(mock.requests).toHaveLength(0);
      expect(listFiles(traces)).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("父 run 用过桌面注册表之外的工具 → FORK_UNKNOWN_TOOL，不产生文件", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      // 造一个带 run_shell 的父 run（录制工具表里出现注册表外工具）
      const shellTool: Tool = {
        name: "run_shell",
        description: "执行 shell 命令",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
        handler: () => "ok",
      };
      const tools = [...sampleTools(), shellTool];
      const defs = tools.map(({ handler: _h, ...def }) => def);
      const config = sampleConfig({ tools: defs });
      const tmpFile = join(traces, "tmp-parent.jsonl");
      await runLoop(
        config,
        initialMessages(TASK),
        new JsonlTracer(tmpFile),
        tools,
        new MockLlmClient(PARENT_SCRIPT),
      );
      const record = readRun(tmpFile);
      const parentId = record.meta.id;
      renameSync(tmpFile, join(traces, `${parentId}.jsonl`));

      const before = listFiles(traces);
      const mock = new MockLlmClient([]);
      await expect(
        runFork(
          { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
          { parentRunId: parentId, atSpanId: "s_03", edit: { field: "result", value: NEW_README } },
        ),
      ).rejects.toMatchObject({ code: FORK_ERROR_CODES.UNKNOWN_TOOL });
      expect(mock.requests).toHaveLength(0);
      expect(listFiles(traces)).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("crashed 父 run → replayRun 拒绝（前缀未封存），零 LLM 调用", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      makeCrashed(traces, parentId);
      const before = listFiles(traces);
      const mock = new MockLlmClient([]);
      await expect(
        runFork(
          { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
          { parentRunId: parentId, atSpanId: "s_03", edit: { field: "result", value: NEW_README } },
        ),
      ).rejects.toThrow(/缺失终止事件|未封存/);
      expect(mock.requests).toHaveLength(0);
      expect(listFiles(traces)).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("空 fork（编辑前后相同）→ derive 拒绝，不产生文件", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      const before = listFiles(traces);
      const mock = new MockLlmClient([]);
      // 父 run s_03 的 read_file 原始结果为 "内容(README.md)"（sample handler 固定返回）
      await expect(
        runFork(
          { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
          {
            parentRunId: parentId,
            atSpanId: "s_03",
            edit: { field: "result", value: "内容(README.md)" },
          },
        ),
      ).rejects.toThrow(/空 fork 被拒绝/);
      expect(mock.requests).toHaveLength(0);
      expect(listFiles(traces)).toEqual(before);
    } finally {
      cleanup();
    }
  });
});

describe("runFork：fork run 再分叉（桌面链式）", () => {
  it("r_01 → fork r_02 → 再 fork r_03：可继续在叶子自身段分叉，列表见三层 run", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const rootId = await createParent(traces);

      const first = await runFork(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient(FORK_SCRIPT),
        },
        { parentRunId: rootId, atSpanId: "s_03", edit: { field: "result", value: NEW_README } },
      );
      const forkRecord = readRun(join(traces, `${first.id}.jsonl`));
      // 取 r_02 自身段里的 tool.invoke（write_file）作为二次分叉点
      const toolSpan = forkRecord.spans.find((s) => s.kind === "tool.invoke");
      expect(toolSpan?.kind).toBe("tool.invoke");
      if (toolSpan?.kind !== "tool.invoke") return;

      const second = await runFork(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient(FURTHER_SCRIPT),
        },
        {
          parentRunId: first.id,
          atSpanId: toolSpan.id,
          edit: { field: "result", value: "已写入 summary.md（二次编辑版）" },
        },
      );
      const leaf = readRun(join(traces, `${second.id}.jsonl`));
      expect(leaf.meta.parent).toBe(first.id);
      // 序号跨两级链延续：r_01 最大 s_08、r_02 最大 s_13 → r_03 从 s_14 起
      expect(leaf.spans.map((s) => s.id)).toEqual(["s_14", "s_15"]);
      expect(leaf.status).toBe("completed");

      // 列表层能看到三个 run（根 + 两层分支）
      const { runs } = repo.listRuns();
      expect(runs.map((r) => r.id).sort()).toEqual([rootId, first.id, second.id].sort());
    } finally {
      cleanup();
    }
  });
});

/** 仅纯工具（write_file 缺 sideEffect 标记会被 A/B 工具策略拒绝） */
const PURE_TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "读取指定路径的文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sideEffect: false,
    handler: (args) => `内容(${(args as { path: string }).path})`,
  },
];

describe("runModelAb：干跑计划经 IPC 边界透传（标量 params + 四展示字段）", () => {
  it("dry-run 返回 plan，含 params / overridden / added / discarded / warnings", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      // 父 run 带 params（plan 的 discarded 才有来源）；用纯工具表过 A/B 策略
      const parentConfig = {
        ...CONFIG,
        tools: PURE_TOOLS.map(({ handler: _h, ...def }) => def),
        params: { temperature: 0.5, num_predict: 768 },
      };
      const tmpFile = join(traces, "tmp-parent.jsonl");
      await runLoop(
        parentConfig,
        initialMessages(TASK),
        new JsonlTracer(tmpFile),
        PURE_TOOLS,
        new MockLlmClient([{ content: "父 run 完成。" }]),
      );
      const parentRecord = readRun(tmpFile);
      renameSync(tmpFile, join(traces, `${parentRecord.meta.id}.jsonl`));

      const result = await runModelAb(
        { repository: repo, settings: SETTINGS },
        {
          parentRunId: parentRecord.meta.id,
          arms: [
            { model: "m-a", params: { temperature: 0.7, reasoning_effort: "none" } },
            { model: "m-b", params: { num_predict: 256 } },
          ],
          dryRun: true,
        },
      );

      expect(result.ok).toBe(true);
      expect(result.ids).toEqual([]);
      expect(result.plan).toHaveLength(2);
      const [a, b] = result.plan;
      expect(a?.params).toEqual({ temperature: 0.7, reasoning_effort: "none" });
      expect(a?.overridden).toEqual(["temperature"]);
      expect(a?.added).toEqual(["reasoning_effort"]);
      expect(a?.discarded).toEqual({ num_predict: 768 });
      expect(a?.warnings).toEqual([]);
      expect(b?.overridden).toEqual(["num_predict"]);
      expect(b?.discarded).toEqual({ temperature: 0.5 });
    } finally {
      cleanup();
    }
  });

  it("Ollama baseURL + num_ctx → 告警经 IPC 到渲染层；非 Ollama 不告警", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      // 纯工具表父 run
      const parentConfig = {
        ...CONFIG,
        tools: PURE_TOOLS.map(({ handler: _h, ...def }) => def),
      };
      const tmpFile = join(traces, "tmp-parent.jsonl");
      await runLoop(
        parentConfig,
        initialMessages(TASK),
        new JsonlTracer(tmpFile),
        PURE_TOOLS,
        new MockLlmClient([{ content: "父 run 完成。" }]),
      );
      const parentRecord = readRun(tmpFile);
      renameSync(tmpFile, join(traces, `${parentRecord.meta.id}.jsonl`));
      const parentId = parentRecord.meta.id;

      const ollamaSettings = { ...SETTINGS, baseURL: "http://127.0.0.1:11434/v1" };

      const ollama = await runModelAb(
        { repository: repo, settings: ollamaSettings },
        {
          parentRunId: parentId,
          arms: [{ model: "m-a", params: { num_ctx: 8192 } }, { model: "m-b" }],
          dryRun: true,
        },
      );
      expect(ollama.plan[0]?.warnings.map((w) => w.key)).toEqual(["num_ctx"]);
      expect(ollama.plan[0]?.warnings[0]?.workaround).toContain("派生模型");
      expect(ollama.plan[1]?.warnings).toEqual([]);

      const deepseek = await runModelAb(
        { repository: repo, settings: SETTINGS },
        {
          parentRunId: parentId,
          arms: [{ model: "m-a", params: { num_ctx: 8192 } }, { model: "m-b" }],
          dryRun: true,
        },
      );
      expect(deepseek.plan[0]?.warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
