import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTANCE_CRITERION,
  BASELINE_MODEL,
  BASELINE_PARAMS,
  HYPOTHESIS,
  NEW_USER_INSTRUCTION,
  ORIGINAL_USER_INSTRUCTION,
  buildIsolatedPromptBaselineCase,
  deriveEditedMessages,
} from "../../../packages/replay/test/isolated-prompt-baseline-fixture";
import { cleanupTempDirs, makeDataDir } from "../../../packages/replay/test/workspace-helpers";
import { ExecutionConfigState } from "../src/main/execution-config-state";
import { runIsolatedPromptCapability } from "../src/main/isolated-prompt-endpoints";
import type { RunSettings } from "../src/main/settings";

/**
 * R2.2 5.1/5.2：`workspaces:isolatedPromptCapability` 端点。
 *
 * 只读、零 operation/槽/模型；领域拒绝是 ok 信封里的 status=unavailable（带 rootId
 * 导航建议），请求形状/配置读取问题才是失败信封。配置修订由 main 唯一拥有者返回。
 */

afterEach(() => {
  cleanupTempDirs();
});

function settings(over: Partial<RunSettings> = {}): RunSettings {
  return {
    baseURL: "https://mock.invalid/v1",
    apiKey: "sk-capability-secret",
    // 桌面设置刻意与基线不同：capability 必须用根模型/params
    model: "desktop-settings-model",
    encrypted: false,
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

async function fixture() {
  const tmp = makeDataDir();
  const baseline = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
  let current: RunSettings | null = settings();
  let failure: unknown = null;
  const source = {
    load: (): RunSettings | null => {
      if (failure !== null) throw failure;
      return current;
    },
  };
  const configState = new ExecutionConfigState(source);
  return {
    tmp,
    baseline,
    configState,
    deps: { dataDir: tmp.dataDir, configState },
    setSettings: (value: RunSettings | null) => {
      current = value;
    },
    setFailure: (error: unknown) => {
      failure = error;
    },
  };
}

describe("isolatedPromptCapability：只读预检与配置修订", () => {
  it("合法根：返回编辑计划、根模型/params、端点/限制、指纹与修订；零文件副作用", async () => {
    const h = await fixture();
    const before = treeFingerprint(h.tmp.dataDir);
    const revision = h.configState.refresh().revision;

    const result = await runIsolatedPromptCapability(h.deps, {
      rootRunId: h.baseline.root.runId,
      edit: { field: "user_message", value: NEW_USER_INSTRUCTION },
      hypothesis: HYPOTHESIS,
      acceptanceCriterion: ACCEPTANCE_CRITERION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("ok");
    if (result.data.status !== "ok") return;

    expect(result.data.rootId).toBe(h.baseline.root.runId);
    expect(result.data.baselineLlmSpanId).toBe(h.baseline.root.llmSpanId);
    expect(result.data.initialSnapshotId).toBe(h.baseline.root.initialSnapshotId);
    expect(result.data.fileCount).toBe(1);
    expect(result.data.totalBytes).toBeGreaterThan(0);
    expect(result.data.originalValue).toBe(ORIGINAL_USER_INSTRUCTION);
    expect(result.data.editedValue).toBe(NEW_USER_INSTRUCTION);
    expect(result.data.messages).toEqual(
      deriveEditedMessages("user_message", NEW_USER_INSTRUCTION),
    );
    expect(result.data.execution.model).toBe(BASELINE_MODEL);
    expect(result.data.execution.params).toEqual(BASELINE_PARAMS);
    expect(result.data.execution.providerEndpoint).toBe("https://mock.invalid/v1");
    expect(result.data.execution.maxIterations).toBe(10);
    expect(result.data.execution.budget.maxTotalTokens).toBe(100_000);
    expect(result.data.execution.tokenBudgetSource).toBe("current");
    expect(result.data.execution.historicalUnknowns).toEqual(
      expect.arrayContaining(["provider_backend", "max_iterations", "token_budget"]),
    );
    expect(result.data.planFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.data.configRevision).toBe(revision);
    expect(result.data.hypothesis).toBe(HYPOTHESIS);
    expect(result.data.acceptanceCriterion).toBe(ACCEPTANCE_CRITERION);
    expect(result.data.billing).toEqual({
      usage: "unknown_until_execution",
      price: "unknown",
      cache: "unknown",
    });
    // 载荷不含完整清单或密钥
    expect(JSON.stringify(result.data)).not.toContain("sk-capability-secret");
    expect(JSON.stringify(result.data)).not.toContain('"files"');

    expect(treeFingerprint(h.tmp.dataDir)).toEqual(before);
  });

  it("strict：额外配置/授权/物理字段直接拒绝（信封失败）", async () => {
    const h = await fixture();
    const result = await runIsolatedPromptCapability(h.deps, {
      rootRunId: h.baseline.root.runId,
      edit: { field: "system_prompt", value: "新值" },
      config: { model: "override" },
      allowFileWrites: true,
      dataDir: "C:/physical",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_ARGUMENT");
  });

  it("非根：ok 信封里的 status=unavailable + rootId 导航建议，不返回计划", async () => {
    const h = await fixture();
    const result = await runIsolatedPromptCapability(h.deps, {
      rootRunId: h.baseline.sibling!.runId,
      edit: { field: "user_message", value: NEW_USER_INSTRUCTION },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("unavailable");
    if (result.data.status !== "unavailable") return;
    expect(result.data.code).toBe("parent_not_root");
    expect(result.data.rootId).toBe(h.baseline.root.runId);
    expect(result.data).not.toHaveProperty("planFingerprint");
  });

  it("缺失附件：attachment_missing（不当成空清单）", async () => {
    const h = await fixture();
    unlinkSync(
      join(h.tmp.dataDir, "workspace-blobs", "sha256", h.baseline.root.initialFiles[0]!.sha256),
    );
    const result = await runIsolatedPromptCapability(h.deps, {
      rootRunId: h.baseline.root.runId,
      edit: { field: "system_prompt", value: "新值" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("unavailable");
    if (result.data.status === "unavailable") {
      expect(result.data.code).toBe("attachment_missing");
    }
  });

  it("配置未配置 / 解密失败：失败信封，不伪造计划", async () => {
    const h = await fixture();
    h.setSettings(null);
    const missing = await runIsolatedPromptCapability(h.deps, {
      rootRunId: h.baseline.root.runId,
      edit: { field: "system_prompt", value: "新值" },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("SETTINGS_NOT_CONFIGURED");

    h.setSettings(settings());
    h.setFailure(new Error("decrypt failed"));
    const failed = await runIsolatedPromptCapability(h.deps, {
      rootRunId: h.baseline.root.runId,
      edit: { field: "system_prompt", value: "新值" },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("SETTINGS_LOAD_FAILED");
  });

  it("端点/密钥/模型变化后修订轮换，计划指纹也随之变化", async () => {
    const h = await fixture();
    const edit = { field: "user_message", value: NEW_USER_INSTRUCTION };
    const first = await runIsolatedPromptCapability(h.deps, {
      rootRunId: h.baseline.root.runId,
      edit,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.data.status !== "ok") return;

    h.setSettings(settings({ baseURL: "https://other.invalid/v2", apiKey: "sk-changed" }));
    const second = await runIsolatedPromptCapability(h.deps, {
      rootRunId: h.baseline.root.runId,
      edit,
    });
    expect(second.ok).toBe(true);
    if (!second.ok || second.data.status !== "ok") return;
    expect(second.data.configRevision).not.toBe(first.data.configRevision);
    expect(second.data.planFingerprint).not.toBe(first.data.planFingerprint);
    expect(second.data.execution.providerEndpoint).toBe("https://other.invalid/v2");
  });
});
