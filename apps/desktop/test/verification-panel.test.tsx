import type {
  RunSummary,
  VerificationCapabilityResult,
  VerificationGetResult,
  VerificationPreparePlanResult,
} from "@shared/ipc";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compareVerifications } from "../src/renderer/src/lib/verification-compare";
import {
  decideVerificationConfirmation,
  verificationTargetKey,
} from "../src/renderer/src/lib/verification-entry";
import type { VerificationOutcomeView } from "../src/renderer/src/store/slices/verification";
import { renderWithLocale } from "./i18n/render-with-locale";

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
    // 5.3：记录与有界日志（默认无可信身份 ⇒ 阅读区不出现）
    trustedVerificationIds: [],
    recordFocus: null,
    onFocusRecord: () => {},
    recordState: "idle" as const,
    recordView: null,
    recordStatus: null,
    recordMeta: null,
    recordErrorInfo: null,
    recordError: null,
    exportFeedback: null,
    onExportInput: () => {},
    logIdentity: null,
    logText: "",
    logMeta: null,
    logState: "idle" as const,
    logError: null,
    onReadLog: () => {},
    // 5.4：双验证比较（默认无候选、未选）
    compareCandidates: [],
    compareLeft: null,
    compareRight: null,
    compareState: "idle" as const,
    compareError: null,
    comparison: null,
    onSelectCompareSide: () => {},
    onClearCompare: () => {},
    onRetryCompare: () => {},
    canOpenCompareDiff: false,
    onOpenCompareDiff: () => {},
    ...overrides,
  };
}

function render(props: Record<string, unknown>): string {
  return renderWithLocale("zh-CN", <VerificationPanel {...(props as never)} />);
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

// ---------------------------------------------------------------------------
// 5.3：记录与有界日志（D09/P13/P16 呈现面静态断言）
// ---------------------------------------------------------------------------

const SEALED_VIEW = {
  eventCount: 3,
  stages: ["executing"],
  terminated: true,
  outcome: "check_failed",
  detail: "测试断言失败",
  evidenceComplete: true,
  commandEnds: [
    {
      commandId: "test" as const,
      exitCode: 1,
      durationMs: 1850,
      stdoutBytes: 1048576,
      stdoutTotalBytes: 2097152,
      stdoutTruncated: true,
      stderrBytes: 42,
      stderrTotalBytes: 42,
      stderrTruncated: false,
    },
  ],
};

const READING_BASE = {
  expanded: true,
  trustedVerificationIds: ["ver-a"],
  recordFocus: "ver-a",
} as const;

describe("VerificationPanel（5.3：记录与有界日志 D09/P13/P16）", () => {
  it("无可信身份 ⇒ 不出现阅读区（身份只来自登记/响应，不猜）", () => {
    const html = render(baseProps({ expanded: true }));
    expect(html).not.toContain("data-verification-reading");
  });

  it("可信身份逐条渲染，当前焦点标记选中；未选择时提示显式选择", () => {
    const html = render(
      baseProps({
        expanded: true,
        trustedVerificationIds: ["ver-a", "ver-b"],
        recordFocus: "ver-b",
      }),
    );
    expect(html).toContain('data-verification-record-focus="ver-a"');
    expect(html).toMatch(/data-verification-record-focus="ver-b"[^>]*aria-pressed="true"/);
    const idle = render(
      baseProps({ expanded: true, trustedVerificationIds: ["ver-a"], recordFocus: null }),
    );
    expect(idle).toContain("选择一个验证身份");
    expect(idle).not.toContain("data-verification-record-view");
  });

  it("封存记录 ⇒ 状态/阶段/结局/双口径字节（截断附全观测）与读写入口", () => {
    const html = render(
      baseProps({
        ...READING_BASE,
        recordState: "ready",
        recordView: SEALED_VIEW,
        recordStatus: "sealed",
      }),
    );
    expect(html).toContain("已封存");
    expect(html).toContain("executing");
    expect(html).toContain("check_failed");
    expect(html).toContain("测试断言失败");
    expect(html).toContain('data-verification-command-end="test"');
    expect(html).toContain("已按限额丢弃并计数");
    expect(html).toContain("全观测 2.0 MB");
    expect(html).toContain("读 stdout");
    expect(html).toContain("读 stderr");
    expect(html).toContain("默认 32 KiB/页");
  });

  it("未封存/损坏 ⇒ 不呈现结局；损坏带坏尾行号且不能当作通过", () => {
    const unterminated = render(
      baseProps({
        ...READING_BASE,
        recordState: "ready",
        recordView: { ...SEALED_VIEW, terminated: false, outcome: null, detail: null },
        recordStatus: "unterminated",
      }),
    );
    expect(unterminated).toContain("不呈现结局");
    expect(unterminated).not.toContain("结局：");
    const corrupt = render(
      baseProps({
        ...READING_BASE,
        recordState: "ready",
        recordView: SEALED_VIEW,
        recordStatus: "corrupt",
        recordErrorInfo: { lineIndex: 4, reason: "JSON 解析失败" },
      }),
    );
    expect(corrupt).toContain("第 5 行");
    expect(corrupt).toContain("不能当作通过或失败");
  });

  it("日志切片显示偏移/剩余与续读；明确不是完整日志（P13 不以截断视图表示完整）", () => {
    const html = render(
      baseProps({
        ...READING_BASE,
        recordState: "ready",
        recordView: SEALED_VIEW,
        recordStatus: "sealed",
        logIdentity: { verificationId: "ver-a", commandId: "test", stream: "stdout" },
        logState: "ready",
        logText: "line1\nline2",
        logMeta: { totalBytes: 10485760, nextOffset: 32768, remaining: 10452992, truncated: true },
      }),
    );
    expect(html).toContain("line1");
    expect(html).toContain("data-verification-log-continue");
    expect(html).toContain("剩余 10.0 MB");
    expect(html).toContain("本切片有截断");
    expect(html).toContain("不是完整日志");
  });

  it("已读到保留末尾 ⇒ 说明超出限额部分见全观测计数，不再提供续读", () => {
    const html = render(
      baseProps({
        ...READING_BASE,
        recordState: "ready",
        recordView: SEALED_VIEW,
        recordStatus: "sealed",
        logIdentity: { verificationId: "ver-a", commandId: "test", stream: "stdout" },
        logState: "ready",
        logText: "tail",
        logMeta: { totalBytes: 4, nextOffset: 4, remaining: 0, truncated: false },
      }),
    );
    expect(html).toContain("已到记录保留的末尾");
    expect(html).not.toContain("data-verification-log-continue");
  });

  it("附件损坏/缺失 ⇒ 稳定码与不补写说明，不展示正文；记录读取失败同样如实呈现", () => {
    const corrupt = render(
      baseProps({
        ...READING_BASE,
        recordState: "ready",
        recordView: SEALED_VIEW,
        recordStatus: "sealed",
        logIdentity: { verificationId: "ver-a", commandId: "test", stream: "stderr" },
        logState: "error",
        logError: { code: "R3_LOG_ASSET_CORRUPT", message: "附件哈希不符" },
      }),
    );
    expect(corrupt).toContain("R3_LOG_ASSET_CORRUPT");
    expect(corrupt).toContain("不以损坏字节冒充正文");
    expect(corrupt).not.toContain("data-verification-log-text");
    const failed = render(
      baseProps({
        ...READING_BASE,
        recordState: "error",
        recordError: { code: "R3_RECORD_SCHEMA_INVALID", message: "结构校验失败" },
      }),
    );
    expect(failed).toContain("R3_RECORD_SCHEMA_INVALID");
    expect(failed).not.toContain("data-verification-command-end");
  });
});

// ---------------------------------------------------------------------------
// 5.4：修复证据比较区（D07/P24/P25 呈现面静态断言）
// ---------------------------------------------------------------------------

const COMPARE_ENV = {
  preparationId: "prep-1",
  imageDigest: `sha256:${"b".repeat(64)}`,
  platform: "linux/amd64" as const,
  toolchain: { node: "22.23.4", npm: "10.9.9", typescript: "5.9.3" },
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
    tmpfsCountsTowardMemoryBudget: true as const,
  },
  security: {
    runAsUser: "1000:1000" as const,
    readOnlyRootfs: true as const,
    capDropAll: true as const,
    noNewPrivileges: true as const,
    networkMode: "none" as const,
    supervisorPid1: true as const,
  },
};

function comparableRecord(opts: {
  verificationId: string;
  runId: string;
  outcome: "check_failed" | "passed";
  evidenceComplete?: boolean;
  planBindingDigest?: string;
}): VerificationGetResult {
  return {
    verificationId: opts.verificationId,
    status: "sealed",
    events: [
      {
        type: "command_start",
        commandId: "test",
        executable: "node",
        argv: ["--test", "calc.test.mjs"],
        cwd: "/work",
      },
      {
        type: "command_end",
        commandId: "test",
        exitCode: opts.outcome === "passed" ? 0 : 1,
        durationMs: 1850,
        stdout: { byteLength: 10, totalBytes: 10, truncated: false },
        stderr: { byteLength: 0, totalBytes: 0, truncated: false },
      },
    ],
    error: null,
    meta: {
      runId: opts.runId,
      checkpoint: { kind: "initial" },
      snapshotId: `snap_${opts.runId}`,
      profileId: "node-ts-v1",
      manifestVersion: 3,
      commandId: "test",
      planBindingDigest: opts.planBindingDigest ?? "a".repeat(64),
      createdAt: "2026-10-25T10:00:00.000Z",
      environment: COMPARE_ENV,
    },
    terminated: {
      outcome: opts.outcome,
      detail: opts.outcome === "passed" ? "tests 2 pass 2" : "断言失败",
      evidenceComplete: opts.evidenceComplete ?? true,
      at: "2026-10-25T10:00:06.000Z",
    },
    sourceStatus: "present",
  };
}

function runSummaryOf(id: string, forkField: string | null): RunSummary {
  return {
    id,
    task: "修复",
    model: "m",
    created_at: "2026-10-25T09:00:00.000Z",
    status: "completed",
    parent: forkField === null ? null : "run_old",
    reason: "completed",
    fork:
      forkField === null ? null : { at_span: "s_02", edit_field: forkField, experiment_id: null },
    steps: 2,
    toolCalls: 1,
    toolErrors: 0,
    tokensIn: 10,
    tokensOut: 5,
    cacheHit: null,
    durationMs: 1000,
    source: null,
  };
}

const COMPARE_RUNS = [runSummaryOf("run_old", null), runSummaryOf("run_fix", "result")];

function compareProps(overrides: Record<string, unknown> = {}) {
  const left = comparableRecord({
    verificationId: "ver-old",
    runId: "run_old",
    outcome: "check_failed",
  });
  const right = comparableRecord({
    verificationId: "ver-fix",
    runId: "run_fix",
    outcome: "passed",
  });
  return baseProps({
    expanded: true,
    trustedVerificationIds: ["ver-old", "ver-fix"],
    compareCandidates: [
      {
        verificationId: "ver-old",
        runId: "run_old",
        checkpointKind: "initial",
        stepSpanId: null,
        commandId: "test",
        operationState: "settled",
      },
      {
        verificationId: "ver-fix",
        runId: "run_fix",
        checkpointKind: "initial",
        stepSpanId: null,
        commandId: "test",
        operationState: "settled",
      },
    ],
    compareLeft: "ver-old",
    compareRight: "ver-fix",
    compareState: "ready",
    comparison: compareVerifications(left, right, COMPARE_RUNS),
    canOpenCompareDiff: true,
    ...overrides,
  });
}

describe("VerificationPanel（5.4：双验证比较 D07/P24/P25）", () => {
  it("无可信身份 ⇒ 不出现比较区；未选齐 ⇒ 提示显式选择（不自动挑最近）", () => {
    const none = render(baseProps({ expanded: true }));
    expect(none).not.toContain("data-verification-compare");
    const partial = render(
      baseProps({
        expanded: true,
        trustedVerificationIds: ["ver-old", "ver-fix"],
        compareCandidates: [
          {
            verificationId: "ver-old",
            runId: "run_old",
            checkpointKind: "initial",
            stepSpanId: null,
            commandId: "test",
            operationState: "settled",
          },
        ],
        compareLeft: "ver-old",
      }),
    );
    expect(partial).toContain("data-verification-compare");
    expect(partial).toContain("不自动挑");
    expect(partial).not.toContain("data-compare-view");
    // 选中侧的来源标签（跨 run 比较时用户能看清选的是哪条）
    expect(partial).toContain("run_old · 初始检查点 · test");
  });

  it("A/B 选择器分开渲染；对侧已选的身份被禁用（同一验证不能自比）", () => {
    const html = render(
      baseProps({
        expanded: true,
        trustedVerificationIds: ["ver-old", "ver-fix"],
        compareCandidates: [
          {
            verificationId: "ver-old",
            runId: "run_old",
            checkpointKind: "initial",
            stepSpanId: null,
            commandId: "test",
            operationState: "settled",
          },
          {
            verificationId: "ver-fix",
            runId: "run_fix",
            checkpointKind: "initial",
            stepSpanId: null,
            commandId: "test",
            operationState: "settled",
          },
        ],
        compareLeft: "ver-old",
        compareRight: null,
      }),
    );
    expect(html).toContain('data-compare-side-selector="left"');
    expect(html).toContain('data-compare-side-selector="right"');
    expect(html).toMatch(/data-compare-side="right:ver-old"[^>]*\sdisabled=""/);
    expect(html).not.toMatch(/data-compare-side="right:ver-fix"[^>]*\sdisabled=""/);
  });

  it("同条件失败→通过 ⇒ 判定/干预/结局/条件/代码差异入口齐备（P24）", () => {
    const html = render(compareProps());
    expect(html).toContain('data-compare-verdict="failed-to-passed"');
    expect(html).toContain("同条件失败→通过");
    expect(html).toContain("不宣布完整正确或因果关系");
    expect(html).toContain("记录的分叉：编辑 result @ s_02");
    expect(html).toContain('data-compare-side-summary="left"');
    expect(html).toContain('data-compare-side-summary="right"');
    expect(html).toContain('data-compare-condition="planBindingDigest"');
    expect(html).toContain('data-compare-state="same"');
    expect(html).toContain('data-compare-open-diff="true"');
    expect(html).toContain("Agent 文本不进入条件与结论");
  });

  it("条件不同 ⇒ 醒目标注不同项，不出现同条件成功措辞（P25）", () => {
    const left = comparableRecord({
      verificationId: "ver-old",
      runId: "run_old",
      outcome: "check_failed",
    });
    const right = comparableRecord({
      verificationId: "ver-fix",
      runId: "run_fix",
      outcome: "passed",
      planBindingDigest: "c".repeat(64),
    });
    const html = render(
      compareProps({
        comparison: compareVerifications(left, right, COMPARE_RUNS),
      }),
    );
    expect(html).toContain('data-compare-verdict="conditions-differ"');
    expect(html).toContain("不同项：");
    expect(html).toContain("不构成同条件失败→通过");
    expect(html).not.toContain('data-compare-verdict="failed-to-passed"');
  });

  it("证据不完整/未封存 ⇒ 阻断措辞（不把缺项做成通过）", () => {
    const left = comparableRecord({
      verificationId: "ver-old",
      runId: "run_old",
      outcome: "check_failed",
    });
    const right = comparableRecord({
      verificationId: "ver-fix",
      runId: "run_fix",
      outcome: "passed",
      evidenceComplete: false,
    });
    const incomplete = render(
      compareProps({ comparison: compareVerifications(left, right, COMPARE_RUNS) }),
    );
    expect(incomplete).toContain('data-compare-verdict="evidence-incomplete"');
    expect(incomplete).toContain("不形成修复结论");
    const unknown = render(compareProps({ comparison: null, compareState: "loading" }));
    expect(unknown).toContain("正在读取两侧验证记录");
  });

  it("读取失败/同一 run 无代码差异 ⇒ 稳定码与如实说明", () => {
    const failed = render(
      compareProps({
        comparison: null,
        compareState: "error",
        compareError: { code: "R3_VERIFICATION_NOT_FOUND", message: "记录不存在" },
      }),
    );
    expect(failed).toContain("R3_VERIFICATION_NOT_FOUND");
    expect(failed).toContain('data-compare-retry="true"');
    const sameRun = comparableRecord({
      verificationId: "ver-b",
      runId: "run_old",
      outcome: "passed",
    });
    const html = render(
      compareProps({
        comparison: compareVerifications(
          comparableRecord({
            verificationId: "ver-a",
            runId: "run_old",
            outcome: "check_failed",
          }),
          sameRun,
          COMPARE_RUNS,
        ),
        canOpenCompareDiff: false,
      }),
    );
    expect(html).toContain('data-compare-no-diff="true"');
    expect(html).toContain("两侧来自同一 run");
    expect(html).not.toContain('data-compare-open-diff="true"');
  });
});

// ---------------------------------------------------------------------------
// 5.5：导出所测输入（W03/W04/D08 呈现面静态断言）
// ---------------------------------------------------------------------------

const EXPORT_SNAPSHOT = "d".repeat(64);
const EXPORT_META = {
  runId: RUN,
  checkpoint: { kind: "initial" as const },
  snapshotId: EXPORT_SNAPSHOT,
  profileId: "node-ts-v1",
  manifestVersion: 3,
  commandId: "test" as const,
  planBindingDigest: "a".repeat(64),
  createdAt: "2026-10-25T10:00:00.000Z",
  environment: null,
};

/** 导出区块只在记录已读出且焦点明确时出现 */
function exportProps(overrides: Record<string, unknown> = {}) {
  return baseProps({
    expanded: true,
    trustedVerificationIds: ["ver-old"],
    recordFocus: "ver-old",
    recordState: "ready",
    recordView: SEALED_VIEW,
    recordStatus: "sealed",
    recordMeta: EXPORT_META,
    ...overrides,
  });
}

describe("VerificationPanel（5.5：导出所测输入 W03/W04/D08）", () => {
  it("封存记录 ⇒ 导出区显示精确输入身份与入口；未封存/记录头不可读 ⇒ 禁用或不出现", () => {
    const html = render(exportProps());
    expect(html).toContain("data-verification-export");
    expect(html).toContain(`snapshot ${EXPORT_SNAPSHOT}`);
    expect(html).toMatch(/data-verification-export-start="true"(?![^>]*disabled="")/);
    expect(html).toContain("不含日志/材料包");
    const unsealed = render(
      exportProps({
        recordStatus: "unterminated",
        recordView: { ...SEALED_VIEW, terminated: false, outcome: null, detail: null },
      }),
    );
    expect(unsealed).toContain("data-verification-export-blocked");
    expect(unsealed).toMatch(/data-verification-export-start="true"[^>]*disabled=""/);
    const noMeta = render(exportProps({ recordMeta: null, recordStatus: "corrupt" }));
    expect(noMeta).not.toContain("data-verification-export");
  });

  it("导出成功 ⇒ 验证快照与导出快照一致、回查指引明确、不把导出说成测试通过", () => {
    const html = render(
      exportProps({
        exportFeedback: {
          kind: "exported",
          verificationId: "ver-old",
          generation: 1,
          outcome: {
            status: "exported",
            targetDir: "D:/exports/ver-old",
            filesRoot: "files",
            fileCount: 3,
            totalFileBytes: 1024,
            snapshotId: EXPORT_SNAPSHOT,
            stepSpanId: null,
            patch: { status: "no_text_changes", covered: [], excluded: [] },
            unpreserved: {
              permissions: "未保留（原状态未知）",
              executable_bit: "未保留（原状态未知）",
              timestamps: "未保留（原状态未知）",
              links: "未保留（原状态未知）",
              empty_directories: "未保留（原状态未知）",
              external_services: "未保留（原状态未知）",
            },
            verificationId: "ver-old",
            verificationSnapshotId: EXPORT_SNAPSHOT,
          },
        },
      }),
    );
    expect(html).toContain('data-verification-export-feedback="exported"');
    expect(html).toContain('data-export-snapshot-match="true"');
    expect(html).toContain("一致（写入前已绑定）");
    expect(html).toContain("rebaseagent-export.json");
    expect(html).toContain("文件导出 ≠ 测试通过");
  });

  it("导出失败 ⇒ 稳定码/原因/残留如实呈现；取消 ⇒ 零写入说明", () => {
    const failed = render(
      exportProps({
        exportFeedback: {
          kind: "failed",
          verificationId: "ver-old",
          generation: 1,
          code: "VERIFICATION_EXPORT_SNAPSHOT_DRIFT",
          reason: "快照不一致",
          retained: ["files/a.txt"],
        },
      }),
    );
    expect(failed).toContain("VERIFICATION_EXPORT_SNAPSHOT_DRIFT");
    expect(failed).toContain("清理未完成");
    expect(failed).toContain("files/a.txt");
    const canceled = render(
      exportProps({
        exportFeedback: { kind: "canceled", verificationId: "ver-old", generation: 2 },
      }),
    );
    expect(canceled).toContain('data-verification-export-feedback="canceled"');
    expect(canceled).toContain("没有写入任何内容");
  });

  it("在飞 ⇒ 明示切页不改绑定、主进程继续", () => {
    const html = render(
      exportProps({
        exportFeedback: { kind: "in-flight", verificationId: "ver-old", generation: 1 },
      }),
    );
    expect(html).toContain('data-verification-export-feedback="in-flight"');
    expect(html).toContain("不会改变绑定");
  });
});

// ---------------------------------------------------------------------------
// 5.6：焦点与长内容布局接线（D11；真实 200%/窄窗视觉归 6.3）
// ---------------------------------------------------------------------------

function tagOf(html: string, marker: string): string {
  const match = html.match(new RegExp(`<[^>]*${marker}[^>]*>`));
  return match?.[0] ?? "";
}

describe("VerificationPanel（5.6：D11 焦点可达与长内容不撑破）", () => {
  it("日志切片可聚焦滚动（键盘可达），长身份/条件值/导出路径允许断行", () => {
    const longId = "v".repeat(80);
    const html = render(
      baseProps({
        expanded: true,
        trustedVerificationIds: [longId],
        recordFocus: longId,
        recordState: "ready",
        recordView: SEALED_VIEW,
        recordStatus: "sealed",
        recordMeta: EXPORT_META,
        logIdentity: { verificationId: longId, commandId: "test", stream: "stdout" },
        logState: "ready",
        logText: "log-line",
        logMeta: { totalBytes: 8, nextOffset: 8, remaining: 0, truncated: false },
      }),
    );
    const logTag = tagOf(html, 'data-verification-log-text="true"');
    // 只读 textarea 原生可聚焦（无需 tabindex），键盘可滚动/选择
    expect(logTag.startsWith("<textarea")).toBe(true);
    expect(logTag.toLowerCase()).toContain("readonly");
    expect(logTag).toContain("aria-label");
    expect(tagOf(html, 'data-verification-record-focus="')).toContain("break-all");
    expect(tagOf(html, "data-verification-panel=")).toContain("min-w-0");
  });

  it("关键动作都有可见焦点环（核对/停止/读日志/导出/比较）", () => {
    const html = render(
      exportProps({
        activeOperation: { kind: "run", operationId: "55555555-5555-4555-8555-555555555555" },
        logIdentity: { verificationId: "ver-old", commandId: "test", stream: "stdout" },
        logState: "ready",
        logText: "x",
        logMeta: { totalBytes: 1, nextOffset: 1, remaining: 0, truncated: false },
      }),
    );
    for (const marker of [
      'data-verification-stop="true"',
      'data-verification-read-log="test:stdout"',
      'data-verification-export-start="true"',
      "data-verification-entry=",
    ]) {
      expect(tagOf(html, marker)).toContain("focus-visible:ring");
    }
  });
});
