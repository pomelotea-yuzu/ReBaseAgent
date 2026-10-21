import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHash } from "@rebaseagent/agent-loop";
import type { RunConfig, ToolDef } from "@rebaseagent/agent-loop";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterEach, describe, expect, it } from "vitest";
import { FILE_TOOLS_V1_DEFINITIONS } from "../src/workspace/file-tools";
import { preflightIsolatedPromptReplay } from "../src/workspace/isolated-prompt-preflight";
import {
  ACCEPTANCE_CRITERION,
  BASELINE_CONFIG_HASH,
  BASELINE_MODEL,
  BASELINE_PARAMS,
  BASELINE_REQUEST_TOOLS,
  HYPOTHESIS,
  NEW_SYSTEM_PROMPT,
  NEW_USER_INSTRUCTION,
  ORIGINAL_MESSAGES,
  ORIGINAL_SYSTEM_PROMPT,
  ORIGINAL_USER_INSTRUCTION,
  buildIsolatedPromptBaselineCase,
  deriveEditedMessages,
} from "./isolated-prompt-baseline-fixture";
import { cleanupTempDirs, makeDataDir, round, writeIsolatedRun } from "./workspace-helpers";

/**
 * R2.2 任务 3.1/3.3：隔离 prompt 只读预检。
 *
 * 证据边界：本文件是 mock/IO 层证据（真实附件字节、真实 JSONL），不调模型；
 * 真实模型闭环在 7.1，Electron 键盘/窄窗在 7.2。
 */

afterEach(() => {
  cleanupTempDirs();
});

const FIXED_TOOLS = [...FILE_TOOLS_V1_DEFINITIONS] as ToolDef[];

function config(over: Partial<RunConfig> = {}): RunConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    // 桌面设置刻意与基线不同：预检必须忽略它们
    model: "desktop-default-model",
    systemPrompt: "桌面默认 system（应被忽略）",
    tools: FIXED_TOOLS,
    params: { temperature: 9 },
    exec: { cwd: "C:/work", signal: null },
    maxIterations: 12,
    budget: { maxTotalTokens: 100_000 },
    ...over,
  };
}

function treeFingerprint(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .map((relative) => {
      const full = join(root, relative);
      try {
        const stat = statSync(full);
        return `${relative}:${stat.isDirectory() ? "dir" : `${stat.size}:${stat.mtimeMs}`}`;
      } catch {
        return `${relative}:missing`;
      }
    });
}

function readJsonLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeJsonLines(file: string, lines: Array<Record<string, unknown>>): void {
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function mutateMeta(file: string, mutate: (meta: Record<string, unknown>) => void): void {
  const lines = readJsonLines(file);
  const meta = lines[0];
  if (meta === undefined) throw new Error("缺少 meta 行");
  mutate(meta);
  writeJsonLines(file, lines);
}

function mutateFirstLlm(file: string, mutate: (request: Record<string, unknown>) => void): void {
  const lines = readJsonLines(file);
  const llm = lines.find((line) => line.kind === "llm.call");
  if (llm === undefined) throw new Error("缺少 llm.call 行");
  const request = llm.request;
  if (typeof request !== "object" || request === null) throw new Error("request 形状异常");
  mutate(request as Record<string, unknown>);
  writeJsonLines(file, lines);
}

async function baseline() {
  const tmp = makeDataDir();
  const fixture = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
  return { tmp, fixture };
}

describe("preflight：合法根只读、计划与指纹", () => {
  it("有效根 + user 编辑：零副作用、计划字段齐备、基线模型/params 不被桌面设置覆盖", async () => {
    const { tmp, fixture } = await baseline();
    const before = treeFingerprint(tmp.dataDir);

    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "user_message", value: NEW_USER_INSTRUCTION },
      config: config(),
      hypothesis: HYPOTHESIS,
      acceptanceCriterion: ACCEPTANCE_CRITERION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value;

    expect(value.rootId).toBe(fixture.root.runId);
    expect(value.baselineLlmSpanId).toBe(fixture.root.llmSpanId);
    expect(value.initialSnapshot.id).toBe(fixture.root.initialSnapshotId);
    expect(value.originalValue).toBe(ORIGINAL_USER_INSTRUCTION);
    expect(value.editedValue).toBe(NEW_USER_INSTRUCTION);
    expect(value.effectiveMessages).toEqual(
      deriveEditedMessages("user_message", NEW_USER_INSTRUCTION),
    );
    expect(value.systemPrompt).toBe(ORIGINAL_SYSTEM_PROMPT);

    // 基线模型/params 优先；端点/限制取当前配置
    expect(value.execution.model).toBe(BASELINE_MODEL);
    expect(value.execution.params).toEqual(BASELINE_PARAMS);
    expect(value.execution.providerEndpoint).toBe("https://api.deepseek.com/v1");
    expect(value.execution.maxIterations).toBe(12);
    expect(value.execution.budget.maxTotalTokens).toBe(100_000);
    expect(value.execution.tokenBudgetSource).toBe("current");
    expect(value.execution.historicalUnknowns).toEqual(
      expect.arrayContaining(["provider_backend", "max_iterations", "token_budget"]),
    );

    expect(value.configHash).toBe(BASELINE_CONFIG_HASH);
    expect(value.planFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(value.promptExperiment).toMatchObject({
      baseline_run_id: fixture.root.runId,
      baseline_llm_span_id: fixture.root.llmSpanId,
      initial_snapshot_id: fixture.root.initialSnapshotId,
      original_value: ORIGINAL_USER_INSTRUCTION,
      hypothesis: HYPOTHESIS,
      acceptance_criterion: ACCEPTANCE_CRITERION,
    });
    expect(value.promptExperiment.execution).toMatchObject({
      model: BASELINE_MODEL,
      params: BASELINE_PARAMS,
      provider_endpoint: "https://api.deepseek.com/v1",
      max_iterations: 12,
      budget: 100_000,
      config_fingerprint: value.planFingerprint,
    });
    // 历史未知条件与真实计费分开表达：执行前 usage/价格/缓存均未知，不得冒充 0
    expect(value.billing).toEqual({
      usage: "unknown_until_execution",
      price: "unknown",
      cache: "unknown",
    });
    expect(value.fileCount).toBe(1);
    expect(value.totalBytes).toBeGreaterThan(0);
    expect(value.records).toHaveLength(1);

    expect(treeFingerprint(tmp.dataDir)).toEqual(before);
  });

  it("system 编辑：config_hash/计划指纹随有效 system 改变；相同输入重复预检稳定", async () => {
    const { tmp, fixture } = await baseline();
    const system = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(system.ok).toBe(true);
    if (!system.ok) return;
    expect(system.value.configHash).toBe(configHash(NEW_SYSTEM_PROMPT, FIXED_TOOLS));
    expect(system.value.configHash).not.toBe(BASELINE_CONFIG_HASH);
    expect(system.value.promptExperiment.execution.params).toEqual(BASELINE_PARAMS);

    const user = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "user_message", value: NEW_USER_INSTRUCTION },
      config: config(),
    });
    expect(user.ok).toBe(true);
    if (!user.ok) return;
    expect(system.value.planFingerprint).not.toBe(user.value.planFingerprint);

    const repeat = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) return;
    expect(repeat.value.planFingerprint).toBe(system.value.planFingerprint);
  });

  it("端点去凭据：计划与序列化结果不含 userinfo/query/fragment", async () => {
    const { tmp, fixture } = await baseline();
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config({
        baseURL:
          "https://sekret-user:sekret-pass@api.example.com:8443/v1?sekret-query=1#sekret-frag",
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.execution.providerEndpoint).toBe("https://api.example.com:8443/v1");
    expect(result.value.promptExperiment.execution.provider_endpoint).toBe(
      "https://api.example.com:8443/v1",
    );
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("sekret");
    expect(serialized).not.toContain("sk-test");
  });
});

describe("preflight：根资格与导航建议", () => {
  it("中途 result 分支 ⇒ parent_not_root，只带经完整父链验证的 rootId 导航建议", async () => {
    const { tmp, fixture } = await baseline();
    expect(fixture.sibling).not.toBeNull();
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.sibling!.runId,
      edit: { field: "user_message", value: NEW_USER_INSTRUCTION },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("parent_not_root");
    expect(result.failure.rootId).toBe(fixture.root.runId);
    expect(result.failure.reason).toContain("不是隔离根");
    // 导航建议不等于授权：失败结果里不携带计划/指纹
    expect(result.failure).not.toHaveProperty("planFingerprint");
  });

  it("根不存在 ⇒ parent_chain_invalid，不猜根", async () => {
    const tmp = makeDataDir();
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: "run_missing_root",
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("parent_chain_invalid");
    expect(result.failure.rootId).toBeUndefined();
  });

  it("缺祖先的中途分支 ⇒ parent_chain_invalid（不给出未验证的 rootId）", async () => {
    const tmp = makeDataDir();
    await writeIsolatedRun({
      dataDir: tmp.dataDir,
      runId: "run_orphan",
      rounds: [round([["a.txt", "x"]])],
      parent: { runId: "run_missing_parent", stepSpanId: "s_99" },
    });
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: "run_orphan",
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("parent_chain_invalid");
    expect(result.failure.rootId).toBeUndefined();
  });

  it("未封存根 ⇒ parent_not_forkable", async () => {
    const { tmp, fixture } = await baseline();
    const lines = readJsonLines(fixture.root.traceFile).filter((line) => line.type !== "run.event");
    writeJsonLines(fixture.root.traceFile, lines);

    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("parent_not_forkable");
  });

  it("v1 普通根 ⇒ parent_not_isolated（没有初始快照）", async () => {
    const tmp = makeDataDir();
    mkdirSync(join(tmp.dataDir, "traces"), { recursive: true });
    const tracer = new JsonlTracer(join(tmp.dataDir, "traces", "run_v1.jsonl"));
    tracer.startRun({
      id: "run_v1",
      format_version: 1,
      task: "普通运行",
      model: BASELINE_MODEL,
      created_at: "2026-10-21T00:00:00.000Z",
      parent: null,
      fork: null,
      config_hash: BASELINE_CONFIG_HASH,
    });
    tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: "run_v1",
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("parent_not_isolated");
  });
});

describe("preflight：启动条件不可还原", () => {
  it("根首次请求缺 user 字符串 ⇒ startup_unavailable", async () => {
    const { tmp, fixture } = await baseline();
    mutateFirstLlm(fixture.root.traceFile, (request) => {
      request.messages = [{ role: "system", content: ORIGINAL_SYSTEM_PROMPT }];
    });
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("startup_unavailable");
    expect(result.failure.reason).toContain("至少");
  });

  it("首次 llm.call 不在第 1 步 ⇒ startup_unavailable", async () => {
    const { tmp, fixture } = await baseline();
    const lines = readJsonLines(fixture.root.traceFile);
    const step = lines.find((line) => line.kind === "agent.step");
    if (step === undefined) throw new Error("缺少 agent.step");
    step.n = 2;
    writeJsonLines(fixture.root.traceFile, lines);

    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("startup_unavailable");
    expect(result.failure.reason).toContain("第 1 步");
  });

  it("空编辑（逐字相同）⇒ empty_edit", async () => {
    const { tmp, fixture } = await baseline();
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "user_message", value: ORIGINAL_USER_INSTRUCTION },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("empty_edit");
  });

  it("编辑对象带额外字段 ⇒ invalid_edit（组合修改不静默）", async () => {
    const { tmp, fixture } = await baseline();
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: {
        field: "system_prompt",
        value: NEW_SYSTEM_PROMPT,
        userValue: NEW_USER_INSTRUCTION,
      } as never,
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_edit");
  });

  it("假设/判据超过 4000 字符 ⇒ invalid_request", async () => {
    const { tmp, fixture } = await baseline();
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
      hypothesis: "x".repeat(4001),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_request");
  });
});

describe("preflight：profile / 来源 / 参数漂移", () => {
  it("当前工具表偏离固定 profile ⇒ profile_mismatch", async () => {
    const { tmp, fixture } = await baseline();
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config({ tools: FIXED_TOOLS.slice(0, 1) }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("profile_mismatch");
  });

  it("父根录制工具表偏离固定 profile ⇒ profile_mismatch", async () => {
    const { tmp, fixture } = await baseline();
    mutateFirstLlm(fixture.root.traceFile, (request) => {
      const tools = request.tools as Array<Record<string, unknown>>;
      tools[0] = { ...tools[0], name: "read" };
    });
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("profile_mismatch");
  });

  it("根 config_hash 与首次请求不符 ⇒ source_changed", async () => {
    const { tmp, fixture } = await baseline();
    mutateMeta(fixture.root.traceFile, (meta) => {
      meta.config_hash = `sha256:${"0".repeat(64)}`;
    });
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("source_changed");
  });

  it("根 params 含结构化项 ⇒ config_unreconstructable（不静默过滤）", async () => {
    const { tmp, fixture } = await baseline();
    mutateFirstLlm(fixture.root.traceFile, (request) => {
      request.params = { nested: { a: 1 } };
    });
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("config_unreconstructable");
    expect(result.failure.reason).toContain("无法无损恢复");
  });
});

describe("preflight：预算与当前策略", () => {
  it("根已记录 token 预算 ⇒ 复用录制值（source=recorded，不算历史未知）", async () => {
    const { tmp, fixture } = await baseline();
    mutateMeta(fixture.root.traceFile, (meta) => {
      meta.budget = { max_total_tokens: 60_000 };
    });
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config({ budget: { maxTotalTokens: 100_000 } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.execution.budget.maxTotalTokens).toBe(60_000);
    expect(result.value.execution.tokenBudgetSource).toBe("recorded");
    expect(result.value.execution.historicalUnknowns).not.toContain("token_budget");
  });

  it("历史预算超过当前策略 ⇒ 明确拒绝，不静默截小", async () => {
    const { tmp, fixture } = await baseline();
    mutateMeta(fixture.root.traceFile, (meta) => {
      meta.budget = { max_total_tokens: 120_000 };
    });
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config({ budget: { maxTotalTokens: 100_000 } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("config_unreconstructable");
    expect(result.failure.reason).toContain("不能静默截小");
  });

  it("params 缺省与显式空对象在计划中保持区别（指纹不同）", async () => {
    const { tmp, fixture } = await baseline();
    mutateFirstLlm(fixture.root.traceFile, (request) => {
      request.params = undefined;
    });
    const missing = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.execution.params).toBeUndefined();
    expect(missing.value.promptExperiment.execution.params).toBeUndefined();

    mutateFirstLlm(fixture.root.traceFile, (request) => {
      request.params = {};
    });
    const empty = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value.execution.params).toEqual({});
    expect(empty.value.promptExperiment.execution.params).toEqual({});
    expect(empty.value.planFingerprint).not.toBe(missing.value.planFingerprint);
  });

  it("根未记录 token 预算且当前配置也没有 ⇒ config_unreconstructable", async () => {
    const { tmp, fixture } = await baseline();
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config({ budget: { maxCost: 5 } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("config_unreconstructable");
  });

  it("maxIterations 非正 ⇒ config_unreconstructable", async () => {
    const { tmp, fixture } = await baseline();
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config({ maxIterations: 0 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("config_unreconstructable");
  });
});

describe("preflight：初始清单配额与附件", () => {
  it("初始清单超过固定配额 ⇒ initial_snapshot_invalid（不读附件）", async () => {
    const tmp = makeDataDir();
    mkdirSync(join(tmp.dataDir, "traces"), { recursive: true });
    const files = Array.from({ length: 2001 }, (_, index) => ({
      path: `f-${String(index).padStart(4, "0")}.txt`,
      sha256: "a".repeat(64),
      bytes: 0,
    }));
    const snapshot = createWorkspaceSnapshot(files);
    const tracer = new JsonlTracer(join(tmp.dataDir, "traces", "run_quota.jsonl"));
    tracer.startRun({
      id: "run_quota",
      format_version: 2,
      task: "超配额初始清单",
      model: BASELINE_MODEL,
      created_at: "2026-10-21T00:00:00.000Z",
      parent: null,
      fork: null,
      config_hash: BASELINE_CONFIG_HASH,
      workspace: {
        profile: "file-tools-v1",
        world_id: "run_quota",
        write_authorized: true,
        initial_snapshot: snapshot,
        origin: { kind: "import" },
      },
    });
    const step = tracer.startSpan({ kind: "agent.step", n: 1 });
    const llm = tracer.startSpan({
      kind: "llm.call",
      parent: step,
      request: {
        model: BASELINE_MODEL,
        messages: [...ORIGINAL_MESSAGES],
        tools: BASELINE_REQUEST_TOOLS,
        params: { ...BASELINE_PARAMS },
      },
    });
    tracer.endSpan(llm, {
      response: {
        content: null,
        reasoning_content: null,
        tool_calls: [],
        usage: { in: 0, out: 0 },
        ttft_ms: 0,
      },
    });
    tracer.endSpan(step, { workspace_snapshot: snapshot });
    tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: "run_quota",
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("initial_snapshot_invalid");
    expect(result.failure.reason).toContain("配额");
  });

  it("初始附件缺失 ⇒ attachment_missing", async () => {
    const { tmp, fixture } = await baseline();
    const file = fixture.root.initialFiles[0]!;
    unlinkSync(join(tmp.dataDir, "workspace-blobs", "sha256", file.sha256));
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("attachment_missing");
  });

  it("初始附件损坏 ⇒ attachment_corrupt", async () => {
    const { tmp, fixture } = await baseline();
    const file = fixture.root.initialFiles[0]!;
    writeFileSync(
      join(tmp.dataDir, "workspace-blobs", "sha256", file.sha256),
      new Uint8Array(file.bytes).fill(120),
    );
    const result = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("attachment_corrupt");
  });

  it("提交前附件被删 ⇒ 重验失败（预检结果不是执行凭证）", async () => {
    const { tmp, fixture } = await baseline();
    const first = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(first.ok).toBe(true);

    const file = fixture.root.initialFiles[0]!;
    unlinkSync(join(tmp.dataDir, "workspace-blobs", "sha256", file.sha256));
    const second = await preflightIsolatedPromptReplay({
      dataDir: tmp.dataDir,
      rootId: fixture.root.runId,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
      config: config(),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure.code).toBe("attachment_missing");
  });
});
