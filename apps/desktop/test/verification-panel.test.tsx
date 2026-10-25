import type { VerificationCapabilityResult, VerificationPreparePlanResult } from "@shared/ipc";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  decideVerificationConfirmation,
  verificationTargetKey,
} from "../src/renderer/src/lib/verification-entry";
import type { VerificationOutcomeView } from "../src/renderer/src/store/slices/verification";

// VerificationPanel 是纯展示层（不触 store），但 ConfirmationBlock/Disclosure 链上有
// 组件在 import 时触到 window ⇒ 先放桩（同 compare-metrics-table.test.ts 惯例）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { VerificationPanel } = await import("../src/renderer/src/components/VerificationPanel");

/**
 * R3 任务 5.1：项目验证面板的**静态断言**（本包无 jsdom；判据由
 * `lib/verification-entry.ts` 派生，这里钉"连接层真的把事实喂给了视图"）。
 *
 * 钉住（delta 场景 D01/D02 的呈现面）：
 * - 入口在非隔离 run 禁用并说明；隔离 run 可展开；
 * - 展开态显示精确输入/当前条件/不可用原因（可行动）；
 * - 两份独立确认块 + 提交按钮的禁用判据（未确认/有阻碍 ⇒ 禁用，不隐式执行）；
 * - stale 判定就近显示原因；提交错误与最近结局如实呈现。
 */

const RUN = "run_ver_panel";
const CAPABILITY: VerificationCapabilityResult = {
  planToken: "token-1",
  prepared: null,
  engine: { available: true, engineVersion: "29.9.2", reason: null },
  source: { snapshotId: "snap-9", fileCount: 5, totalBytes: 4096, stepSpanId: null },
  sourceFailure: null,
  profileSummary: {
    profileId: "node-ts-v1",
    manifestVersion: 3,
    platform: "linux/amd64",
    toolchain: { node: "22.23.4", npm: "10.9.9", typescript: "5.9.3" },
    sourceIncludeGlob: "src/**/*.ts",
    limits: {
      cpus: 1,
      memoryBytes: 536870912,
      pidsLimit: 64,
      workTmpfsBytes: 167772160,
      tmpTmpfsBytes: 33554432,
      commandTimeoutMs: 120000,
      totalTimeoutMs: 180000,
      stdoutBudgetBytes: 1048576,
      stderrBudgetBytes: 1048576,
      totalOutputLimitBytes: 16777216,
      artifactUniqueContentBudgetBytes: 134217728,
      tmpfsCountsTowardMemoryBudget: true,
    },
    security: {
      runAsUser: "1000:1000",
      readOnlyRootfs: true,
      capDropAll: true,
      noNewPrivileges: true,
      networkMode: "none",
      supervisorPid1: true,
    },
  },
};

const PLAN: VerificationPreparePlanResult = {
  planDigest: "sha256:plan",
  planToken: "token-1",
  plan: {
    profileId: "node-ts-v1",
    manifestVersion: 3,
    manifestDigest: "sha256:manifest",
    downloads: [
      {
        source: "docker.m.daocloud.io/library/node@sha256:base",
        approxBytes: 61337515,
        license: "MIT",
      },
    ],
    networkScopeNote: "仅本次准备允许联网；正式测试断网。",
    spaceEstimateBytes: 509875138,
  },
};

function baseProps(overrides?: Partial<Record<string, unknown>>) {
  const targetKey = verificationTargetKey({ runId: RUN, checkpoint: { kind: "initial" } });
  return {
    runId: RUN,
    checkpoint: { kind: "initial" } as const,
    checkpointLabel: "初始检查点",
    isolatedEligible: true,
    expanded: false,
    onToggleExpanded: () => {},
    capability: null,
    capabilityState: "idle" as const,
    capabilityError: null,
    plan: null,
    planState: "idle" as const,
    planError: null,
    onRetryCapability: () => {},
    onRetryPlan: () => {},
    commandId: "test" as const,
    onCommandChange: () => {},
    prepareDecision: decideVerificationConfirmation({
      armed: null,
      currentPlanToken: null,
      currentTargetKey: targetKey,
    }),
    runDecision: decideVerificationConfirmation({
      armed: null,
      currentPlanToken: null,
      currentTargetKey: targetKey,
      currentCommandId: "test" as const,
    }),
    onConfirmPrepare: () => {},
    onConfirmRun: () => {},
    submitting: "idle" as const,
    submitError: null,
    lastOutcome: null,
    onSubmitPrepare: () => {},
    onSubmitRun: () => {},
    ...overrides,
  };
}

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(<VerificationPanel {...(props as never)} />);
}

describe("VerificationPanel（入口与资格）", () => {
  it("非隔离 run ⇒ 入口禁用并说明原因（不可行动的入口不假装可用）", () => {
    const html = render(baseProps({ isolatedEligible: false }));
    expect(html).toContain("data-verification-entry");
    expect(html).toMatch(/disabled/);
    expect(html).toContain("隔离文件世界");
  });

  it("收起态只渲染入口按钮（展开前的核对由连接层在打开时发起）", () => {
    const html = render(baseProps());
    expect(html).toContain("项目验证");
    expect(html).not.toContain("data-verification-confirm");
  });
});

describe("VerificationPanel（展开态：D01 精确输入与当前条件）", () => {
  it("显示核对事实：快照/文件数/字节、准备状态、引擎版本、计划概览与零副作用说明", () => {
    const html = render(
      baseProps({
        expanded: true,
        capability: CAPABILITY,
        capabilityState: "ready",
        plan: PLAN,
        planState: "ready",
      }),
    );
    expect(html).toContain("snap-9");
    expect(html).toContain("5 个文件");
    expect(html).toContain("尚未准备");
    expect(html).toContain("29.9.2");
    expect(html).toContain("token-1");
    expect(html).toContain("node-ts-v1");
    expect(html).toContain("零下载");
    expect(html).toContain("1 项固定下载");
  });

  it("不可用原因就近可行动显示（引擎缺席/未准备）", () => {
    const html = render(
      baseProps({
        expanded: true,
        capability: CAPABILITY,
        capabilityState: "ready",
        plan: PLAN,
        planState: "ready",
      }),
    );
    expect(html).toContain("先完成下方的「环境准备」");
    const engineDown = render(
      baseProps({
        expanded: true,
        capability: {
          ...CAPABILITY,
          engine: {
            available: false,
            engineVersion: null,
            reason: "未发现可信 Docker Desktop CLI",
          },
        },
        capabilityState: "ready",
        plan: PLAN,
        planState: "ready",
      }),
    );
    expect(engineDown).toContain("Docker Desktop");
    expect(engineDown).toContain("不会自动安装");
  });

  it("核对失败 ⇒ 异常码 + 重新核对入口（不冒充条件可用）", () => {
    const html = render(
      baseProps({
        expanded: true,
        capabilityState: "error",
        capabilityError: { code: "R3_CAPABILITY_CHANNEL_FAILED", message: "通道失联" },
      }),
    );
    expect(html).toContain("R3_CAPABILITY_CHANNEL_FAILED");
    expect(html).toContain("data-verification-retry-capability");
  });
});

describe("VerificationPanel（展开态：D02 分开确认与不隐式执行）", () => {
  it("两份独立确认块 + 各自提交按钮；未确认时提交禁用", () => {
    const html = render(
      baseProps({
        expanded: true,
        capability: CAPABILITY,
        capabilityState: "ready",
        plan: PLAN,
        planState: "ready",
      }),
    );
    expect(html).toContain("核对环境准备");
    expect(html).toContain("核对固定检查执行");
    expect(html).toContain("data-verification-submit-prepare");
    expect(html).toContain("data-verification-submit-run");
    expect(html).toMatch(/data-verification-submit-prepare="true"[^>]*disabled/);
    expect(html).toMatch(/data-verification-submit-run="true"[^>]*disabled/);
  });

  it("确认后（confirmed ∧ 无阻碍）准备提交可用；执行提交仍因未准备禁用（许可不互相替代）", () => {
    const targetKey = verificationTargetKey({ runId: RUN, checkpoint: { kind: "initial" } });
    const armed = { planToken: "token-1", targetKey };
    const html = render(
      baseProps({
        expanded: true,
        capability: CAPABILITY,
        capabilityState: "ready",
        plan: PLAN,
        planState: "ready",
        prepareDecision: decideVerificationConfirmation({
          armed,
          currentPlanToken: "token-1",
          currentTargetKey: targetKey,
        }),
        runDecision: decideVerificationConfirmation({
          armed,
          currentPlanToken: "token-1",
          currentTargetKey: targetKey,
          currentCommandId: "test" as const,
        }),
      }),
    );
    expect(html).toMatch(/data-verification-submit-prepare="true"(?:\s[^>]*)?>/);
    expect(html).toMatch(/data-verification-submit-run="true"[^>]*disabled/);
  });

  it("确认过期（stale）⇒ 原因就近显示、提交禁用（不自动重新确认、不自动提交）", () => {
    const targetKey = verificationTargetKey({ runId: RUN, checkpoint: { kind: "initial" } });
    const html = render(
      baseProps({
        expanded: true,
        capability: { ...CAPABILITY, planToken: "token-2" },
        capabilityState: "ready",
        plan: PLAN,
        planState: "ready",
        prepareDecision: decideVerificationConfirmation({
          armed: { planToken: "token-1", targetKey },
          currentPlanToken: "token-2",
          currentTargetKey: targetKey,
        }),
      }),
    );
    expect(html).toContain("旧确认失效");
    expect(html).toMatch(/data-verification-submit-prepare="true"[^>]*disabled/);
  });

  it("提交失败与最近结局如实呈现（请求层失败码 + 领域结局一行）", () => {
    const failure = render(
      baseProps({
        expanded: true,
        submitError: { code: "R3_PREPARE_PLAN_STALE", message: "计划漂移：重新核对后再确认" },
      }),
    );
    expect(failure).toContain("R3_PREPARE_PLAN_STALE");
    const outcome: VerificationOutcomeView = {
      kind: "run",
      targetKey: "k",
      atOutcomeGeneration: 1,
      verificationId: "ver-9",
      outcome: "check_failed",
      detail: "tsc 非零退出",
      evidenceComplete: true,
    };
    const done = render(baseProps({ expanded: true, lastOutcome: outcome }));
    expect(done).toContain("ver-9");
    expect(done).toContain("check_failed");
  });
});
