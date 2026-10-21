import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { LlmClient } from "@rebaseagent/agent-loop";
import { exportWorkspaceSnapshot, promptReplayIsolatedRun } from "@rebaseagent/replay";
import { assertDeletable, readRun } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { MockLlmClient, type ScriptedTurn } from "../../../packages/agent-loop/test/helpers";
import {
  ACCEPTANCE_CRITERION,
  CONFIG_INITIAL_A,
  HYPOTHESIS,
  NEW_USER_INSTRUCTION,
  ORIGINAL_USER_INSTRUCTION,
  buildIsolatedPromptBaselineCase,
} from "../../../packages/replay/test/isolated-prompt-baseline-fixture";
import { cleanupTempDirs, makeDataDir } from "../../../packages/replay/test/workspace-helpers";
import type { ExecEndpointDeps } from "../src/main/exec-endpoints";
import { execPromptFork } from "../src/main/exec-endpoints";
import { ExecutionConfigState } from "../src/main/execution-config-state";
import {
  buildPromptExperimentConfig,
  runIsolatedPromptCapability,
} from "../src/main/isolated-prompt-endpoints";
import type { TrustedSender } from "../src/main/operation-endpoints";
import { OperationRegistry } from "../src/main/operation-registry";
import { RequestFingerprinter } from "../src/main/operation-request";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import { inspectWorkspace, readWorkspaceFileForView } from "../src/main/workspace-view";
import type { IsolatedPromptForkRequest } from "../src/shared/ipc";
import { OPERATION_ERROR } from "../src/shared/operations";

/**
 * R2.2 5.2/5.3：`runs:promptFork` 的隔离分支与 U4 操作适配。
 *
 * 判据：
 * - 显式 executionMode + 计划指纹 + 配置修订 + 当前 allowFileWrites 才执行；
 * - 旧修订/计划漂移/非根/来源拒绝 ⇒ settled/rejected、runIds=[]、零模型调用；
 * - 同 ID 同参只执行一次、异参冲突、旧 epoch 不执行、单槽忙碌拒绝；
 * - 模型失败仍落盘 v3 errored 且操作身份=真实 run id；
 * - operation 登记不携带 prompt 正文。
 */

afterEach(() => {
  cleanupTempDirs();
});

const SENDER: TrustedSender = { webContentsId: 1, frameRoutingId: 100 };
const EPOCH = "11111111-1111-4111-8111-111111111111";

function opId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function envelope(n: number, request: unknown, epoch = EPOCH): unknown {
  return { operation: { epoch, operationId: opId(n) }, request };
}

function settings(over: Partial<RunSettings> = {}): RunSettings {
  return {
    baseURL: "https://mock.invalid/v1",
    apiKey: "sk-fork-secret",
    model: "desktop-settings-model",
    encrypted: false,
    ...over,
  };
}

async function makeHarness(script: ScriptedTurn[] = []) {
  const tmp = makeDataDir();
  const baseline = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
  let current: RunSettings | null = settings();
  const settingsSource = {
    load: (): RunSettings | null => current,
  };
  const configState = new ExecutionConfigState(settingsSource);
  const registry = new OperationRegistry({
    newEpoch: () => EPOCH,
    now: () => Date.parse("2026-10-21T00:00:00.000Z"),
  });
  let llm: LlmClient = new MockLlmClient(script);
  let llmCalls = 0;
  const observedLlm: LlmClient = {
    complete: async (messages, signal) => {
      llmCalls += 1;
      return llm.complete(messages, signal);
    },
  };
  const deps: ExecEndpointDeps = {
    registry,
    fingerprinter: new RequestFingerprinter(Buffer.from("isolated-prompt-harness-secret")),
    isTrustedSender: (sender) =>
      sender.webContentsId === SENDER.webContentsId &&
      sender.frameRoutingId === SENDER.frameRoutingId,
    repository: new RunRepository(join(tmp.dataDir, "traces")),
    settings: settingsSource,
    configState,
    execCwd: tmp.dataDir,
    dataDir: tmp.dataDir,
    proxy: { fork: async () => Promise.reject(new Error("未使用")) },
    sourceTokens: { consume: () => ({ ok: false, reason: "expired" as const }) },
    llm: observedLlm,
  };

  const edit = { field: "user_message" as const, value: NEW_USER_INSTRUCTION };
  const capability = async () => {
    const result = await runIsolatedPromptCapability(
      { dataDir: tmp.dataDir, configState },
      {
        rootRunId: baseline.root.runId,
        edit,
        hypothesis: HYPOTHESIS,
        acceptanceCriterion: ACCEPTANCE_CRITERION,
      },
    );
    if (!result.ok || result.data.status !== "ok") {
      throw new Error(`capability 不可用：${JSON.stringify(result)}`);
    }
    return result.data;
  };

  const requestOf = async (): Promise<IsolatedPromptForkRequest> => {
    const cap = await capability();
    return {
      executionMode: "isolated",
      parentRunId: baseline.root.runId,
      edit,
      allowFileWrites: true,
      expectedConfigRevision: cap.configRevision,
      expectedPlanFingerprint: cap.planFingerprint,
      hypothesis: HYPOTHESIS,
      acceptanceCriterion: ACCEPTANCE_CRITERION,
    };
  };

  return {
    tmp,
    baseline,
    deps,
    registry,
    configState,
    edit,
    capability,
    requestOf,
    setSettings: (value: RunSettings | null) => {
      current = value;
    },
    setScript: (turns: ScriptedTurn[]) => {
      llm = new MockLlmClient(turns);
      llmCalls = 0;
    },
    setLlm: (client: LlmClient) => {
      llm = client;
    },
    llmCalls: () => llmCalls,
    traceFiles: () =>
      readdirSync(join(tmp.dataDir, "traces"))
        .filter((name) => name.endsWith(".jsonl"))
        .sort(),
  };
}

function expectFail(response: Awaited<ReturnType<typeof execPromptFork>>, code: string): void {
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error(`期望失败 ${code}`);
  expect(response.error.code).toBe(code);
}

describe("runs:promptFork 隔离分支：计划/修订/授权", () => {
  it("合法提交：v3 落盘、操作身份=真实 run id、记录不含正文", async () => {
    const h = await makeHarness([{ content: "完成" }]);
    const request = await h.requestOf();
    const tracesBefore = h.traceFiles().length;

    const response = await execPromptFork(h.deps, SENDER, envelope(1, request));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(h.llmCalls()).toBe(1);
    expect(h.traceFiles()).toHaveLength(tracesBefore + 1);

    const record = readRun(join(h.tmp.dataDir, "traces", `${response.data.id}.jsonl`));
    expect(record.meta.format_version).toBe(3);
    expect(record.meta.parent).toBe(h.baseline.root.runId);
    expect(record.meta.prompt_experiment?.hypothesis).toBe(HYPOTHESIS);
    expect(record.meta.prompt_experiment?.acceptance_criterion).toBe(ACCEPTANCE_CRITERION);
    expect(record.meta.fork?.edit.value).toBe(NEW_USER_INSTRUCTION);

    const operation = h.registry.recordOf(opId(1));
    expect(operation).not.toBeNull();
    expect(operation?.state).toBe("settled");
    expect(operation?.requestOutcome).toBe("returned");
    expect(operation?.runIds).toEqual([response.data.id]);
    expect(operation?.target).toEqual({
      kind: "prompt",
      parentRunId: h.baseline.root.runId,
      editField: "user_message",
    });
    const serialized = JSON.stringify(operation);
    expect(serialized).not.toContain(ORIGINAL_USER_INSTRUCTION);
    expect(serialized).not.toContain(NEW_USER_INSTRUCTION);
    expect(serialized).not.toContain("sk-fork-secret");

    // v3 自有文件/导出来源：初始快照 A，origin=initial；导出固定该自有检查点
    const view = await inspectWorkspace(
      { dataDir: h.tmp.dataDir, repository: h.deps.repository },
      { runId: response.data.id },
    );
    expect(view.ok).toBe(true);
    if (view.ok) {
      expect(view.result.origin.kind).toBe("initial");
      expect(view.result.snapshotId).toBe(h.baseline.root.initialSnapshotId);
      expect(view.result.files.map((file) => file.path)).toEqual(["config.json"]);
    }
    const file = await readWorkspaceFileForView(
      { dataDir: h.tmp.dataDir, repository: h.deps.repository },
      { runId: response.data.id, path: "config.json" },
    );
    expect(file.status).toBe("text");
    if (file.status === "text") expect(file.text).toBe(CONFIG_INITIAL_A);

    const exportTarget = makeDataDir();
    const exported = await exportWorkspaceSnapshot({
      dataDir: h.tmp.dataDir,
      runId: response.data.id,
      targetDir: exportTarget.dataDir,
    });
    expect(exported.ok).toBe(true);
    if (exported.ok) {
      expect(exported.value.snapshotId).toBe(h.baseline.root.initialSnapshotId);
      expect(exported.value.stepSpanId).toBeNull();
      expect(exported.value.fileCount).toBe(1);
    }

    // 删除保护：v3 子运行参与父引用计数
    const rootRecord = readRun(join(h.tmp.dataDir, "traces", `${h.baseline.root.runId}.jsonl`));
    expect(() => assertDeletable(h.baseline.root.runId, [rootRecord.meta, record.meta])).toThrow(
      /1 个分支/,
    );
    expect(() => assertDeletable(record.meta.id, [rootRecord.meta, record.meta])).not.toThrow();
  });

  it("同 ID 同参只执行一次；异参冲突不改原登记", async () => {
    const h = await makeHarness([{ content: "完成" }]);
    const request = await h.requestOf();
    const first = await execPromptFork(h.deps, SENDER, envelope(2, request));
    expect(first.ok).toBe(true);
    const files = h.traceFiles().length;
    const calls = h.llmCalls();

    const again = await execPromptFork(h.deps, SENDER, envelope(2, request));
    expectFail(again, OPERATION_ERROR.duplicated);
    expect(h.llmCalls()).toBe(calls);
    expect(h.traceFiles()).toHaveLength(files);
    expect(h.registry.recordOf(opId(2))?.state).toBe("settled");

    const conflict = await execPromptFork(
      h.deps,
      SENDER,
      envelope(2, { ...request, edit: { field: "user_message", value: "另一条指令" } }),
    );
    expectFail(conflict, OPERATION_ERROR.conflict);
    expect(h.registry.recordOf(opId(2))?.runIds).toHaveLength(1);
    expect(h.traceFiles()).toHaveLength(files);
  });

  it("旧 epoch：零执行、零登记", async () => {
    const h = await makeHarness([{ content: "完成" }]);
    const request = await h.requestOf();
    const response = await execPromptFork(
      h.deps,
      SENDER,
      envelope(3, request, "22222222-2222-4222-8222-222222222222"),
    );
    expectFail(response, OPERATION_ERROR.staleEpoch);
    expect(response.operation).toBeNull();
    expect(h.registry.recordOf(opId(3))).toBeNull();
    expect(h.llmCalls()).toBe(0);
  });

  it("配置修订变化：settled/rejected、runIds=[]、零模型/零新 trace", async () => {
    const h = await makeHarness([{ content: "完成" }]);
    const request = await h.requestOf();
    const files = h.traceFiles().length;

    h.setSettings(settings({ baseURL: "https://changed.invalid/v2", apiKey: "sk-new" }));
    const response = await execPromptFork(h.deps, SENDER, envelope(4, request));
    expectFail(response, "ISOLATED_PROMPT_CONFIG_CHANGED");
    const operation = h.registry.recordOf(opId(4));
    expect(operation?.state).toBe("settled");
    expect(operation?.requestOutcome).toBe("rejected");
    expect(operation?.runIds).toEqual([]);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toHaveLength(files);
  });

  it("计划指纹漂移：settled/rejected、零执行", async () => {
    const h = await makeHarness([{ content: "完成" }]);
    const request = await h.requestOf();
    const files = h.traceFiles().length;
    const response = await execPromptFork(
      h.deps,
      SENDER,
      envelope(5, {
        ...request,
        expectedPlanFingerprint: `sha256:${"0".repeat(64)}`,
      }),
    );
    expectFail(response, "ISOLATED_PROMPT_PLAN_CHANGED");
    expect(h.registry.recordOf(opId(5))?.runIds).toEqual([]);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toHaveLength(files);
  });

  it("非根（合法 v3 分支）：ISOLATED_PROMPT_PARENT_NOT_ROOT，零执行", async () => {
    const h = await makeHarness([{ content: "完成" }]);
    // 先造一个来源完整可读的 v3 分支；fixture 的兄弟分支是手工标本，
    // at_span/resume_after_step 同指 step，会被来源门禁如实判为不可读。
    const v3 = await promptReplayIsolatedRun({
      dataDir: h.tmp.dataDir,
      rootId: h.baseline.root.runId,
      edit: h.edit,
      config: buildPromptExperimentConfig(settings(), h.tmp.dataDir),
      authority: { allowFileWrites: true },
      llm: new MockLlmClient([{ content: "分支完成" }]),
    });
    expect(v3.ok).toBe(true);
    if (!v3.ok) return;

    const revision = h.configState.refresh().revision;
    const files = h.traceFiles().length;
    const response = await execPromptFork(
      h.deps,
      SENDER,
      envelope(6, {
        executionMode: "isolated",
        parentRunId: v3.id,
        edit: h.edit,
        allowFileWrites: true,
        expectedConfigRevision: revision,
        expectedPlanFingerprint: `sha256:${"1".repeat(64)}`,
      }),
    );
    expectFail(response, "ISOLATED_PROMPT_PARENT_NOT_ROOT");
    expect(h.registry.recordOf(opId(6))?.runIds).toEqual([]);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toHaveLength(files);
  });

  it("先 reconcile 的未知 ID：后到提交永久拒绝且零执行", async () => {
    const h = await makeHarness([{ content: "完成" }]);
    const request = await h.requestOf();
    const files = h.traceFiles().length;
    const tombstone = h.registry.reconcile(opId(13));
    expect(tombstone.state).toBe("notAccepted");
    expect(tombstone.rejection).toBe("reconcile_tombstone");

    const response = await execPromptFork(h.deps, SENDER, envelope(13, request));
    expectFail(response, OPERATION_ERROR.notAccepted);
    const record = h.registry.recordOf(opId(13));
    expect(record?.state).toBe("notAccepted");
    expect(record?.runIds).toEqual([]);
    expect(h.llmCalls()).toBe(0);
    expect(h.traceFiles()).toHaveLength(files);
  });

  it("缺 executionMode 的隔离形状不会落进普通分支；allowFileWrites 必须为 true", async () => {
    const h = await makeHarness([{ content: "完成" }]);
    const request = await h.requestOf();
    const noMode = await execPromptFork(
      h.deps,
      SENDER,
      envelope(7, { ...request, executionMode: undefined }),
    );
    expectFail(noMode, "INVALID_ARGUMENT");
    expect(noMode.operation).toBeNull();

    const noAuth = await execPromptFork(
      h.deps,
      SENDER,
      envelope(8, { ...request, allowFileWrites: false }),
    );
    expectFail(noAuth, "INVALID_ARGUMENT");
    expect(noAuth.operation).toBeNull();

    const extra = await execPromptFork(
      h.deps,
      SENDER,
      envelope(9, { ...request, config: { model: "override" } }),
    );
    expectFail(extra, "INVALID_ARGUMENT");
    expect(h.llmCalls()).toBe(0);
  });
});

describe("runs:promptFork 隔离分支：单槽与模型失败", () => {
  it("单槽：首个隔离实验在飞时，第二个新 ID 不被接受", async () => {
    const h = await makeHarness([{ content: "完成" }]);
    const request = await h.requestOf();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    h.setLlm({
      complete: async (messages, signal) => {
        calls += 1;
        await gate;
        const scripted = new MockLlmClient([{ content: "完成" }]);
        return scripted.complete(messages, signal);
      },
    });

    const firstPromise = execPromptFork(h.deps, SENDER, envelope(10, request));
    for (let i = 0; i < 2000 && h.registry.activeId === null; i += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(h.registry.activeId).toBe(opId(10));
    for (let i = 0; i < 2000 && calls === 0; i += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(calls).toBe(1);

    const second = await execPromptFork(h.deps, SENDER, envelope(11, request));
    expectFail(second, OPERATION_ERROR.notAccepted);
    expect(h.registry.recordOf(opId(11))?.rejection).toBe("busy");
    expect(calls).toBe(1);

    release();
    const first = await firstPromise;
    expect(first.ok).toBe(true);
    expect(h.registry.activeId).toBeNull();
  });

  it("模型失败：v3 errored 落盘，操作身份仍指向真实 run", async () => {
    const h = await makeHarness([]);
    const request = await h.requestOf();
    const response = await execPromptFork(h.deps, SENDER, envelope(12, request));
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const record = readRun(join(h.tmp.dataDir, "traces", `${response.data.id}.jsonl`));
    expect(record.events[0]?.event).toBe("errored");
    const operation = h.registry.recordOf(opId(12));
    expect(operation?.requestOutcome).toBe("returned");
    expect(operation?.runIds).toEqual([response.data.id]);
    expect(operation?.errorCode).toBeNull();
  });
});
