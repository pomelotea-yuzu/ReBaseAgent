import {
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
import { configHash, runLoop } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  MockLlmClient,
  type ScriptedTurn,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../../packages/agent-loop/test/helpers";
import { FORK_ERROR_CODES, PROMPT_FORK_ERROR_CODES, runPromptFork } from "../src/main/fork-runner";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import { promptForkGuard } from "../src/renderer/src/lib/prompt-fork";
import { deriveRunSummary } from "../src/shared/derive";
import { RunDetailSchema, RunSummarySchema } from "../src/shared/ipc";
import { PromptForkRequestSchema } from "../src/shared/ipc";

/**
 * prompt fork 桌面端测试（add-prompt-replay）：
 * - guard：提交前本地拦截（未配置 / 缺 system / 缺 user / 空 fork）
 * - runPromptFork 编排：从录制重建 config → promptReplayRun 从头重跑
 * - getRun 分流：prompt fork 返回自身完整 spans + 父级链，不经 resolveBranch
 * - schema 兼容：新旧 field 的 RunSummary / RunDetail / 请求 schema 解析
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

const PARENT_SCRIPT: ScriptedTurn[] = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { toolCalls: [{ id: "c2", name: "write_file", args: '{"path":"summary.md"}' }] },
  { content: "任务完成：要点已写入 summary.md。" },
];
/** system prompt fork 后的重跑剧本：一轮直接收尾 */
const SYS_FORK_SCRIPT: ScriptedTurn[] = [{ content: "遵守新约束：直接给出要点。" }];
/** user message fork 后的重跑剧本 */
const USER_FORK_SCRIPT: ScriptedTurn[] = [{ content: "换一种问法：要点如下。" }];

const SYS_EDIT = { field: "system_prompt" as const, value: "你是只许一次说清的助手。" };
const USER_EDIT = { field: "user_message" as const, value: "请凭常识总结 README 要点。" };

function tempRepo(): { traces: string; repo: RunRepository; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "prompt-fork-desktop-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function createParent(traces: string, messages = initialMessages(TASK)): Promise<string> {
  const tmpFile = join(traces, "tmp-parent.jsonl");
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
  renameSync(tmpFile, join(traces, `${id}.jsonl`));
  return id;
}

function makeCrashed(traces: string, id: string): void {
  const file = join(traces, `${id}.jsonl`);
  const kept = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.includes('"type":"run.event"'));
  writeFileSync(file, `${kept.join("\n")}\n`);
}

function listFiles(traces: string): string[] {
  return readdirSync(traces).sort();
}

// ---------------------------------------------------------------------------
// guard：提交前本地校验
// ---------------------------------------------------------------------------

describe("promptForkGuard：提交前本地拦截", () => {
  const base = {
    field: "system_prompt" as const,
    hasSystem: true,
    hasUser: true,
    settingsConfigured: true,
    unchanged: false,
  };

  it("全部满足 → 放行", () => {
    expect(promptForkGuard(base)).toEqual({ canSubmit: true, reason: null });
  });

  it("未配置运行参数 → 拦截并提示先完成运行配置", () => {
    const result = promptForkGuard({ ...base, settingsConfigured: false });
    expect(result.canSubmit).toBe(false);
    expect(result.reason).toContain("运行配置");
  });

  it("缺字符串 system 消息 → 两种编辑都拦截（不假定空字符串）", () => {
    for (const field of ["system_prompt", "user_message"] as const) {
      const result = promptForkGuard({ ...base, field, hasSystem: false });
      expect(result.canSubmit).toBe(false);
      expect(result.reason).toContain("system 消息");
    }
  });

  it("user_message 编辑但缺字符串 user 消息 → 拦截；system_prompt 编辑不受影响", () => {
    const blocked = promptForkGuard({ ...base, field: "user_message", hasUser: false });
    expect(blocked.canSubmit).toBe(false);
    expect(blocked.reason).toContain("user 消息");
    expect(promptForkGuard({ ...base, field: "system_prompt", hasUser: false }).canSubmit).toBe(
      true,
    );
  });

  it("空 fork（编辑前后相同）→ 拦截", () => {
    const result = promptForkGuard({ ...base, unchanged: true });
    expect(result.canSubmit).toBe(false);
    expect(result.reason).toContain("空 fork");
  });
});

// ---------------------------------------------------------------------------
// runPromptFork：桌面编排
// ---------------------------------------------------------------------------

describe("runPromptFork：system prompt 从头重跑（mock LLM）", () => {
  it("新 run 从 s_01 完整记录、config_hash 随新值变化、父文件逐字节不变", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      const parentFile = join(traces, `${parentId}.jsonl`);
      const parentBefore = readFileSync(parentFile, "utf8");

      const mock = new MockLlmClient(SYS_FORK_SCRIPT);
      const result = await runPromptFork(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
        { parentRunId: parentId, edit: SYS_EDIT },
      );

      const record = readRun(join(traces, `${result.id}.jsonl`));
      expect(record.meta.parent).toBe(parentId);
      expect(record.meta.fork).toEqual({
        at_span: "s_02",
        edit: { field: "system_prompt", value: SYS_EDIT.value },
      });
      expect(record.status).toBe("completed");
      // 从头执行：本 run 自身 spans 从 s_01 起（一轮迭代 = step + llm.call）
      expect(record.spans.map((s) => s.id)).toEqual(["s_01", "s_02"]);
      // 双真相源：config_hash 按编辑值复算，首次请求的 system content 也是编辑值
      expect(record.meta.config_hash).toBe(configHash(SYS_EDIT.value, CONFIG.tools));
      const firstLlm = record.spans.find((s) => s.kind === "llm.call");
      expect(firstLlm?.kind).toBe("llm.call");
      if (firstLlm?.kind === "llm.call") {
        expect(firstLlm.request.messages[0]).toEqual({ role: "system", content: SYS_EDIT.value });
        expect(firstLlm.request.messages[1]).toEqual({ role: "user", content: TASK });
      }
      expect(mock.requests).toHaveLength(1);
      expect(readFileSync(parentFile, "utf8")).toBe(parentBefore);
    } finally {
      cleanup();
    }
  });
});

describe("runPromptFork：user message 从头重跑", () => {
  it("只替换首条 user message；config_hash 与父一致（system prompt 未变）", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      const parentHash = readRun(join(traces, `${parentId}.jsonl`)).meta.config_hash;

      const result = await runPromptFork(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient(USER_FORK_SCRIPT),
        },
        { parentRunId: parentId, edit: USER_EDIT },
      );
      const record = readRun(join(traces, `${result.id}.jsonl`));
      expect(record.meta.fork).toEqual({
        at_span: "s_02",
        edit: { field: "user_message", value: USER_EDIT.value },
      });
      const firstLlm = record.spans.find((s) => s.kind === "llm.call");
      expect(firstLlm?.kind).toBe("llm.call");
      if (firstLlm?.kind === "llm.call") {
        expect(firstLlm.request.messages[0]).toEqual({
          role: "system",
          content: CONFIG.systemPrompt,
        });
        expect(firstLlm.request.messages[1]).toEqual({
          role: "user",
          content: USER_EDIT.value,
        });
      }
      expect(record.meta.config_hash).toBe(parentHash);
    } finally {
      cleanup();
    }
  });
});

describe("runPromptFork：拒绝路径", () => {
  it("缺字符串 system 消息 → PROMPT_FORK_NO_SYSTEM，零调用、不产生文件", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      // 无 system 消息的父 run（首次请求只有 user）
      const parentId = await createParent(traces, [{ role: "user", content: TASK }]);
      const before = listFiles(traces);
      const mock = new MockLlmClient([]);
      await expect(
        runPromptFork(
          { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
          { parentRunId: parentId, edit: SYS_EDIT },
        ),
      ).rejects.toMatchObject({ code: PROMPT_FORK_ERROR_CODES.NO_SYSTEM });
      expect(mock.requests).toHaveLength(0);
      expect(listFiles(traces)).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("未知工具（注册表外）→ FORK_UNKNOWN_TOOL，不产生文件", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const shellTool = {
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
      const parentId = readRun(tmpFile).meta.id;
      renameSync(tmpFile, join(traces, `${parentId}.jsonl`));

      const before = listFiles(traces);
      const mock = new MockLlmClient([]);
      await expect(
        runPromptFork(
          { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
          { parentRunId: parentId, edit: SYS_EDIT },
        ),
      ).rejects.toMatchObject({ code: FORK_ERROR_CODES.UNKNOWN_TOOL });
      expect(mock.requests).toHaveLength(0);
      expect(listFiles(traces)).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("crashed 父 run → 拒绝（未封存），零调用、不产生文件", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      makeCrashed(traces, parentId);
      const before = listFiles(traces);
      const mock = new MockLlmClient([]);
      await expect(
        runPromptFork(
          { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
          { parentRunId: parentId, edit: SYS_EDIT },
        ),
      ).rejects.toThrow(/缺失终止事件|未封存/);
      expect(mock.requests).toHaveLength(0);
      expect(listFiles(traces)).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("空 fork（system prompt 编辑前后相同）→ 拒绝，不产生文件", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      const before = listFiles(traces);
      const mock = new MockLlmClient([]);
      await expect(
        runPromptFork(
          { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
          { parentRunId: parentId, edit: { field: "system_prompt", value: CONFIG.systemPrompt } },
        ),
      ).rejects.toThrow(/空 fork/);
      expect(mock.requests).toHaveLength(0);
      expect(listFiles(traces)).toEqual(before);
    } finally {
      cleanup();
    }
  });
});

describe("runPromptFork：空工具表父 run（引擎空 tools / 代理无工具）", () => {
  it("引擎空工具表 run 可 prompt fork，子 run config_hash 与父逐字节一致", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      // 父 run 用空 config.tools 现造（run-loop 对空表不写 request.tools）
      const emptyConfig = sampleConfig({ tools: [] });
      const tmpFile = join(traces, "tmp-parent.jsonl");
      await runLoop(
        emptyConfig,
        initialMessages(TASK),
        new JsonlTracer(tmpFile),
        [],
        new MockLlmClient([{ content: "无工具直接作答：要点如下。" }]),
      );
      const parentRecord = readRun(tmpFile);
      expect(parentRecord.status).toBe("completed");
      const parentId = parentRecord.meta.id;
      renameSync(tmpFile, join(traces, `${parentId}.jsonl`));
      // 前提确认：录制侧未写 tools 字段（引擎对空表省略）
      const parentLlm = parentRecord.spans.find((s) => s.kind === "llm.call");
      expect(parentLlm?.kind).toBe("llm.call");
      if (parentLlm?.kind === "llm.call") {
        expect(parentLlm.request.tools).toBeUndefined();
      }

      const before = listFiles(traces);
      const mock = new MockLlmClient(SYS_FORK_SCRIPT);
      const result = await runPromptFork(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
        { parentRunId: parentId, edit: SYS_EDIT },
      );

      const child = readRun(join(traces, `${result.id}.jsonl`));
      expect(child.meta.parent).toBe(parentId);
      expect(child.meta.config_hash).toBe(configHash(SYS_EDIT.value, []));
      // 父 run 自身 hash 为编辑前的空表指纹（空表可算，故此前被拒的空工具 run 现可 fork）
      expect(parentRecord.meta.config_hash).toBe(configHash(CONFIG.systemPrompt, []));
      expect(mock.requests).toHaveLength(1);
      expect(listFiles(traces)).toEqual([...before, `${result.id}.jsonl`].sort());
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 代理 run（录制侧已补指纹、无工具）→ prompt fork
// ---------------------------------------------------------------------------

/** 造一个代理形态 fixture：单 llm.call、无 tools、meta 带 source=proxy 与 config_hash */
async function createProxyParent(traces: string): Promise<string> {
  const proxyConfig = sampleConfig({ tools: [] });
  const tmpFile = join(traces, "tmp-proxy.jsonl");
  await runLoop(
    proxyConfig,
    initialMessages(TASK),
    new JsonlTracer(tmpFile),
    [],
    new MockLlmClient([{ content: "代理应答：一次结束。" }]),
  );
  const record = readRun(tmpFile);
  const id = record.meta.id;
  const lines = readFileSync(tmpFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const meta = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  meta.task = "(llm-proxy)";
  meta.source = { kind: "proxy", base_url: "http://127.0.0.1:18787/v1" };
  lines[0] = JSON.stringify(meta);
  const file = join(traces, `${id}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return id;
}

describe("runPromptFork：含 hash 的代理 run（无工具）", () => {
  it("代理 run 可 prompt fork，子 run 出现在分支树且 meta 形状与引擎父本一致", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const proxyId = await createProxyParent(traces);
      const before = listFiles(traces);
      const mock = new MockLlmClient(SYS_FORK_SCRIPT);
      const result = await runPromptFork(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
        { parentRunId: proxyId, edit: SYS_EDIT },
      );
      const child = readRun(join(traces, `${result.id}.jsonl`));
      expect(child.meta.parent).toBe(proxyId);
      expect(child.meta.fork?.edit.field).toBe("system_prompt");
      // 子 run 无 proxy source（是引擎 run）
      expect(child.meta.source).toBeUndefined();

      // 分支树：子 run 详情 chain 列出 [代理父, 子 run]
      const detail = repo.getRun(result.id);
      expect(detail.chain.map((hop) => hop.meta.id)).toEqual([proxyId, result.id]);
      expect(listFiles(traces)).toEqual([...before, `${result.id}.jsonl`].sort());
    } finally {
      cleanup();
    }
  });

  it("旧无 hash 代理文件 → 拒绝且文案指向重新录制/编辑 messages 重发", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const proxyId = await createProxyParent(traces);
      // 抹掉 config_hash 且带缺因（模拟历史文件）
      const file = join(traces, `${proxyId}.jsonl`);
      const lines = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
      const meta = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      const { config_hash: _removed, ...stripped } = meta;
      stripped.config_hash_reason = "no_system";
      lines[0] = JSON.stringify(stripped);
      writeFileSync(file, `${lines.join("\n")}\n`);

      const mock = new MockLlmClient([]);
      await expect(
        runPromptFork(
          { repository: repo, settings: SETTINGS, execCwd: traces, llm: mock },
          { parentRunId: proxyId, edit: SYS_EDIT },
        ),
      ).rejects.toThrow(/不含字符串形式的 system 消息[\s\S]*重新经代理录制/);
      expect(mock.requests).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// getRun 分流：prompt fork 的详情 = 自身完整 spans + 父级溯源链
// ---------------------------------------------------------------------------

describe("RunRepository.getRun：prompt fork 独立新轨迹", () => {
  it("详情只含本 run 自身 spans，chain 列出父级溯源；不混入父旧 spans", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      const result = await runPromptFork(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient(SYS_FORK_SCRIPT),
        },
        { parentRunId: parentId, edit: SYS_EDIT },
      );

      const detail = repo.getRun(result.id);
      // 本 run 完整新轨迹：s_01 / s_02（父 run 的 s_01..s_08 不进入时间线）
      expect(detail.spans.map((s) => s.id)).toEqual(["s_01", "s_02"]);
      expect(detail.leafSpanIds).toEqual(["s_01", "s_02"]);
      // 父级溯源链：[父, 本 run]
      expect(detail.chain.map((hop) => hop.meta.id)).toEqual([parentId, result.id]);
      expect(detail.chain[1]?.fork?.edit.field).toBe("system_prompt");

      // 父 run 详情不受影响
      const parentDetail = repo.getRun(parentId);
      expect(parentDetail.spans).toHaveLength(8);
    } finally {
      cleanup();
    }
  });

  it("父文件缺失：详情仍可读（证明未走 resolveBranch），链降级为本 run 自身", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      const result = await runPromptFork(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient(SYS_FORK_SCRIPT),
        },
        { parentRunId: parentId, edit: SYS_EDIT },
      );
      // 删除父文件：resolveBranch 会抛"父 run 文件缺失"，getRun 必须不抛
      rmSync(join(traces, `${parentId}.jsonl`));

      const detail = repo.getRun(result.id);
      expect(detail.spans.map((s) => s.id)).toEqual(["s_01", "s_02"]);
      expect(detail.chain.map((hop) => hop.meta.id)).toEqual([result.id]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// schema 兼容：新旧 field 的解析
// ---------------------------------------------------------------------------

describe("schema 兼容：prompt fork 的 IPC 契约", () => {
  it("deriveRunSummary 透传 edit_field（不带 value）→ RunSummarySchema 解析通过", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createParent(traces);
      const result = await runPromptFork(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient(SYS_FORK_SCRIPT),
        },
        { parentRunId: parentId, edit: SYS_EDIT },
      );
      const record = readRun(join(traces, `${result.id}.jsonl`));
      const summary = deriveRunSummary(record);
      expect(summary.fork).toEqual({
        at_span: "s_02",
        edit_field: "system_prompt",
        experiment_id: null,
      });
      expect(RunSummarySchema.parse(summary)).toMatchObject({
        fork: { at_span: "s_02", edit_field: "system_prompt" },
      });

      // 详情（含父级链）通过 RunDetailSchema 校验
      const detail = repo.getRun(result.id);
      expect(RunDetailSchema.parse(detail)).toMatchObject({
        meta: { id: result.id, parent: parentId },
      });
    } finally {
      cleanup();
    }
  });

  it("PromptForkRequestSchema：两个合法 field 通过；非法 field / 空 value 拒绝", () => {
    expect(
      PromptForkRequestSchema.safeParse({
        parentRunId: "r_01",
        edit: { field: "system_prompt", value: "新 prompt" },
      }).success,
    ).toBe(true);
    expect(
      PromptForkRequestSchema.safeParse({
        parentRunId: "r_01",
        edit: { field: "user_message", value: "新指令" },
      }).success,
    ).toBe(true);
    // 一次多字段 / 未知字段（试图同时修改两个变量的形状无法表达，落在非法 field）
    expect(
      PromptForkRequestSchema.safeParse({
        parentRunId: "r_01",
        edit: { field: "result", value: "x" },
      }).success,
    ).toBe(false);
    expect(
      PromptForkRequestSchema.safeParse({
        parentRunId: "r_01",
        edit: { field: "system_prompt", value: "" },
      }).success,
    ).toBe(true); // 空串是合法形状；空 fork 由编排层按"编辑前后相同"语义拒绝
  });
});
