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
    // 5.2：操作登记核实与停止反馈（默认干净零态）
    matchedRecords: [],
    operationsUnknown: false,
    activeOperation: null,
    stopRequested: false,
    stopNotice: null,
    stopError: null,
    onStop: () => {},
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

// ---------------------------------------------------------------------------
// 5.2：操作登记核实区 / 停止反馈 / D04 结局分层（呈现面静态断言）
// ---------------------------------------------------------------------------

import type { OperationRecord } from "@shared/operations";
import { verificationOutcomeLabel } from "../src/renderer/src/components/VerificationPanel";

const RECORD: OperationRecord = {
  epoch: "44444444-4444-4444-8444-444444444444",
  operationId: "55555555-5555-4555-8555-555555555555",
  target: {
    kind: "verification",
    runId: RUN,
    checkpointKind: "initial",
    stepSpanId: null,
    commandId: "test",
  },
  state: "running",
  rejection: null,
  startedAt: "2026-10-25T10:00:00.000Z",
  settledAt: null,
  runIds: [],
  experimentId: null,
  arms: [],
  preparationIds: [],
  verificationIds: ["ver-trusted"],
  requestOutcome: null,
  errorCode: null,
  diagnostics: [],
};

describe("VerificationPanel（5.2：操作登记核对区 D03/M01/D10）", () => {
  it("登记记录逐条展示（类型/状态/领域 ID），标注来源是登记核对", () => {
    const html = render(
      baseProps({
        expanded: true,
        matchedRecords: [RECORD],
      }),
    );
    expect(html).toContain("data-verification-records");
    expect(html).toContain("项目验证（test）");
    expect(html).toContain("执行中");
    expect(html).toContain("ver-trusted");
    expect(html).toContain("操作登记核对");
  });

  it("会话通信未知 ⇒ 只显示核对提示，不展示记录（D10：不猜执行事实）", () => {
    const html = render(
      baseProps({
        expanded: true,
        matchedRecords: [RECORD],
        operationsUnknown: true,
      }),
    );
    expect(html).toContain("data-verification-operations-unknown");
    expect(html).toContain("操作状态未知");
    expect(html).not.toContain("data-verification-records");
    expect(html).not.toContain("ver-trusted");
  });

  it("无登记记录时既不显示记录区也不显示未知提示（干净零态）", () => {
    const html = render(baseProps({ expanded: true, matchedRecords: [] }));
    expect(html).not.toContain("data-verification-records");
    expect(html).not.toContain("data-verification-operations-unknown");
  });
});

describe("VerificationPanel（5.2：停止反馈 D05）", () => {
  it("执行在飞 ⇒ 提供定向停止按钮；准备在飞 ⇒ 如实说明不可中断", () => {
    const run = render(
      baseProps({
        expanded: true,
        activeOperation: { kind: "run", operationId: "55555555-5555-4555-8555-555555555555" },
      }),
    );
    expect(run).toContain("data-verification-stop");
    expect(run).toContain("请求停止");
    const prepare = render(
      baseProps({
        expanded: true,
        activeOperation: { kind: "prepare", operationId: "55555555-5555-4555-8555-555555555555" },
      }),
    );
    expect(prepare).toContain("不可中断");
    expect(prepare).not.toContain("data-verification-stop");
  });

  it("停止已请求 ⇒ 等待确认说明（不显示为已结束）；幂等 no-op 与失败码如实呈现", () => {
    const requested = render(
      baseProps({
        expanded: true,
        activeOperation: { kind: "run", operationId: "55555555-5555-4555-8555-555555555555" },
        stopRequested: true,
      }),
    );
    expect(requested).toContain("停止已请求（等待确认）");
    expect(requested).toMatch(/data-verification-stop="true"[^>]*disabled/);
    const notice = render(
      baseProps({
        expanded: true,
        activeOperation: { kind: "run", operationId: "55555555-5555-4555-8555-555555555555" },
        stopNotice: "该操作已收尾（settled），无需停止",
      }),
    );
    expect(notice).toContain("data-verification-stop-notice");
    const failed = render(
      baseProps({
        expanded: true,
        activeOperation: { kind: "run", operationId: "55555555-5555-4555-8555-555555555555" },
        stopError: { code: "R3_STOP_IDENTITY_MISMATCH", message: "领域 ID 不一致" },
      }),
    );
    expect(failed).toContain("R3_STOP_IDENTITY_MISMATCH");
  });
});

describe("VerificationPanel（5.2：D04 结局分层与结局短语）", () => {
  it("run 结局分行呈现：请求收尾 / 测试结局 / 证据完整性 / 可信验证身份", () => {
    const outcome: VerificationOutcomeView = {
      kind: "run",
      targetKey: "k",
      atOutcomeGeneration: 1,
      verificationId: "ver-9",
      outcome: "check_failed",
      detail: "tsc 非零退出",
      evidenceComplete: false,
      operationId: "55555555-5555-4555-8555-555555555555",
    };
    const html = render(baseProps({ expanded: true, lastOutcome: outcome }));
    expect(html).toContain("请求收尾");
    expect(html).toContain("测试结局");
    expect(html).toContain("check_failed");
    expect(html).toContain("证据完整性");
    expect(html).toContain("不全");
    expect(html).toContain("ver-9");
    expect(html).toContain("只重读该可信记录");
  });

  it("结局短语把测试失败与请求失败分开（check_failed 不是请求失败）", () => {
    expect(verificationOutcomeLabel("check_failed")).toContain("不是请求失败");
    expect(verificationOutcomeLabel("evidence_incomplete")).toContain("不能绿色通过");
    expect(verificationOutcomeLabel("artifact_invalid")).toContain("改代码不是修复");
  });
});
