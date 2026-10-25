import type {
  VerificationCapabilityResult,
  VerificationCheckpoint,
  VerificationPreparePlanResult,
} from "@shared/ipc";
import type { ConfirmationRow } from "../lib/execution-confirmation";
import { disclosureLines } from "../lib/execution-confirmation";
import { formatBytes } from "../lib/format";
import {
  type VerificationBlocker,
  type VerificationConfirmationDecision,
  blockersFor,
  verificationBlockers,
  verificationPrepareDisclosure,
  verificationRunDisclosure,
  verificationTargetLabel,
} from "../lib/verification-entry";
import type {
  VerificationOutcomeView,
  VerificationSubmitError,
} from "../store/slices/verification";
import { ConfirmationBlock } from "./ConfirmationBlock";
import { FOCUS_RING } from "./IconButton";

/**
 * R3 任务 5.1：文件页检查点侧的**项目验证**面板（展示层，只吃 props）。
 *
 * D01/D02 的呈现面：
 * - **精确输入与当前条件**（D01）：run/检查点/快照/文件数与字节、profile/工具链、
 *   已准备环境、引擎健康、网络/脚本策略（plan.networkScopeNote）、限额与隔离基线
 *   （capability.profileSummary）——数字与事实全部来自 main 的只读核对
 *   （`verification:capability` + `verification:preparePlan`），本组件不发明第二份。
 * - **不可用原因可行动**（D01）：引擎缺席/来源不成立/未准备环境映射成"缺什么、能做什么"。
 * - **准备与执行分开确认**（D02）：两个独立的 ConfirmationBlock 与提交按钮；
 *   已准备环境不等于同意执行。
 * - **计划漂移失效**（D02）：确认判定（confirmed/stale/missing）由连接层现算传入；
 *   stale 就近显示原因，提交按钮禁用——不自动重确认、不自动提交新计划。
 * - **零副作用预览**（D01）：展开面板只发起两个只读 IPC；不下载、不建容器、不调模型。
 *
 * 显式 selector：目标（runId+checkpoint）由连接层在打开时显式绑定；本组件只显示
 * `verificationTargetLabel`，绝不从当前文件选择器推导目标。
 */

export interface VerificationPanelProps {
  readonly runId: string;
  /** 显式目标（打开面板那一刻绑定的检查点；展示用） */
  readonly checkpoint: VerificationCheckpoint;
  /** 当前检查点的可读名（文件页选择器的叫法，与显式目标一致） */
  readonly checkpointLabel: string;
  /** 渲染层早拦：非隔离 run 没有文件世界，入口直接禁用并说明 */
  readonly isolatedEligible: boolean;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;

  readonly capability: VerificationCapabilityResult | null;
  readonly capabilityState: "idle" | "loading" | "ready" | "error";
  readonly capabilityError: { code: string; message: string } | null;
  readonly plan: VerificationPreparePlanResult | null;
  readonly planState: "idle" | "loading" | "ready" | "error";
  readonly planError: { code: string; message: string } | null;
  readonly onRetryCapability: () => void;
  readonly onRetryPlan: () => void;

  readonly commandId: "typecheck" | "test";
  readonly onCommandChange: (commandId: "typecheck" | "test") => void;
  readonly prepareDecision: VerificationConfirmationDecision;
  readonly runDecision: VerificationConfirmationDecision;
  readonly onConfirmPrepare: () => void;
  readonly onConfirmRun: () => void;

  readonly submitting: "idle" | "prepare" | "run";
  readonly submitError: VerificationSubmitError | null;
  readonly lastOutcome: VerificationOutcomeView | null;
  readonly onSubmitPrepare: () => void;
  readonly onSubmitRun: () => void;
}

/** 判定的一行呈现（确认块 blocked 位与提交按钮的禁用说明共用） */
function decisionLine(decision: VerificationConfirmationDecision): string | null {
  return decision.kind === "confirmed" ? null : decision.reason;
}

function blockerLines(blockers: readonly VerificationBlocker[]): readonly string[] {
  return blockers.map((one) => `${one.reason}（${one.code}）`);
}

export function VerificationPanel({
  runId,
  checkpoint,
  checkpointLabel,
  isolatedEligible,
  expanded,
  onToggleExpanded,
  capability,
  capabilityState,
  capabilityError,
  plan,
  planState,
  planError,
  onRetryCapability,
  onRetryPlan,
  commandId,
  onCommandChange,
  prepareDecision,
  runDecision,
  onConfirmPrepare,
  onConfirmRun,
  submitting,
  submitError,
  lastOutcome,
  onSubmitPrepare,
  onSubmitRun,
}: VerificationPanelProps) {
  const prepareBlockers = blockersFor(verificationBlockers(capability), "prepare");
  const runBlockers = blockersFor(verificationBlockers(capability), "run");
  const preparing = submitting === "prepare";
  const running = submitting === "run";
  // 提交资格：确认现算判定为 confirmed ∧ 该动作的不可用原因为空（D02：不隐式执行）
  const prepareReady =
    prepareDecision.kind === "confirmed" && prepareBlockers.length === 0 && !preparing;
  const runReady = runDecision.kind === "confirmed" && runBlockers.length === 0 && !running;
  const prepareDisclosure = verificationPrepareDisclosure({
    runId,
    checkpointLabel: verificationTargetLabel(checkpoint),
    capability,
    plan,
  });
  const runDisclosure = verificationRunDisclosure({
    runId,
    checkpointLabel: verificationTargetLabel(checkpoint),
    commandId,
    capability,
  });
  return (
    <div className="mt-1" data-verification-panel={runId}>
      <button
        type="button"
        data-verification-entry="true"
        disabled={!isolatedEligible}
        aria-expanded={expanded ? "true" : "false"}
        onClick={onToggleExpanded}
        title={
          isolatedEligible
            ? "在受限容器内验证该检查点的项目：环境准备与固定检查分开确认"
            : "普通/代理运行没有隔离文件世界（没有可验证的检查点输入）；验证只支持隔离运行"
        }
        className={`rounded border border-emerald-300 px-2 py-0.5 text-[11px] text-emerald-700 hover:bg-emerald-50 ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        {expanded ? "收起项目验证" : "项目验证"}
      </button>
      {!isolatedEligible ? (
        <span className="ml-2 text-[10px] text-gray-400">
          仅隔离运行可验证（普通/代理运行没有检查点输入）
        </span>
      ) : null}

      {expanded && isolatedEligible ? (
        <div
          className="mt-1.5 rounded border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-[11px] leading-5 text-gray-700"
          data-verification-confirm="true"
        >
          <div className="font-semibold text-gray-800">
            验证「{verificationTargetLabel(checkpoint)}」· run {runId}
          </div>
          <div className="mt-0.5 text-gray-500">
            打开面板只做了两个只读核对（能力/来源/环境聚合 +
            固定计划预览）：零下载、零容器、零执行、零模型调用。
          </div>

          {/* —— 精确输入与当前条件（D01）—— */}
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] leading-4">
            {conditionRows({ capability, capabilityState, plan, planState }).map((row) => (
              <div key={`${row.label}-${row.value}`} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-gray-500">{row.label}</dt>
                <dd className="min-w-0 break-words text-gray-700">{row.value}</dd>
              </div>
            ))}
          </dl>

          {/* —— 核对异常与重试（核对失败 ≠ 不可用：如实说明）—— */}
          {capabilityError !== null ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              核对失败（{capabilityError.code}）：{capabilityError.message}
              <button
                type="button"
                data-verification-retry-capability="true"
                onClick={onRetryCapability}
                className={`ml-2 rounded border border-amber-300 px-1.5 py-0.5 text-[10px] ${FOCUS_RING}`}
              >
                重新核对
              </button>
            </div>
          ) : null}
          {planError !== null ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              计划预览读取失败（{planError.code}）：{planError.message}
              <button
                type="button"
                data-verification-retry-plan="true"
                onClick={onRetryPlan}
                className={`ml-2 rounded border border-amber-300 px-1.5 py-0.5 text-[10px] ${FOCUS_RING}`}
              >
                重新读取
              </button>
            </div>
          ) : null}
          {capabilityState === "loading" || planState === "loading" ? (
            <div className="mt-1.5 text-gray-500">正在核对（只读）…</div>
          ) : null}

          {/* —— 不可用原因（D01：可行动说明就近显示）—— */}
          {prepareBlockers.length > 0 ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              {blockerLines(prepareBlockers).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}
          {runBlockers.length > 0 ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              {blockerLines(runBlockers).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}

          {/* —— 两份独立确认（D02：准备与执行许可不互相替代）—— */}
          <ConfirmationBlock
            title="核对环境准备"
            summary={prepareDisclosure.summary}
            rows={disclosureLines(prepareDisclosure)}
            confirmed={prepareDecision.kind === "confirmed"}
            confirmDisabled={capabilityState !== "ready"}
            onConfirm={onConfirmPrepare}
            confirmLabel="已核对，确认准备环境"
            confirmedLabel="已确认准备（绑定当前计划）"
            blocked={decisionLine(prepareDecision)}
            controlsId="verification-prepare-details"
            tone="emerald"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              data-verification-submit-prepare="true"
              disabled={!prepareReady}
              onClick={onSubmitPrepare}
              className={`rounded border border-emerald-400 bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-900 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
            >
              {preparing ? "正在准备环境…" : "开始准备环境"}
            </button>
            <span className="text-[10px] text-gray-500">
              只在「已确认 ∧ 引擎可用」时可提交；确认过期或计划变化后按钮回到禁用，须重新核对确认。
            </span>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] font-medium text-gray-600">固定检查命令</span>
            {(["typecheck", "test"] as const).map((one) => (
              <button
                key={one}
                type="button"
                data-verification-command={one}
                aria-pressed={commandId === one ? "true" : undefined}
                onClick={() => onCommandChange(one)}
                className={`rounded border px-2 py-0.5 text-[11px] ${FOCUS_RING} ${
                  commandId === one
                    ? "border-gray-800 bg-gray-800 text-white"
                    : "border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {one}
              </button>
            ))}
          </div>
          <ConfirmationBlock
            title="核对固定检查执行"
            summary={runDisclosure.summary}
            rows={disclosureLines(runDisclosure)}
            confirmed={runDecision.kind === "confirmed"}
            confirmDisabled={capabilityState !== "ready"}
            onConfirm={onConfirmRun}
            confirmLabel="已核对，确认执行检查"
            confirmedLabel="已确认执行（绑定当前计划与命令）"
            blocked={decisionLine(runDecision)}
            controlsId="verification-run-details"
            tone="emerald"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              data-verification-submit-run="true"
              disabled={!runReady}
              onClick={onSubmitRun}
              className={`rounded border border-emerald-400 bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-900 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
            >
              {running ? "正在执行检查…" : "执行固定检查"}
            </button>
            <span className="text-[10px] text-gray-500">
              需要环境已准备 ∧ 来源可用 ∧ 本次执行确认有效；命令切换后旧确认失效。
            </span>
          </div>

          {/* —— 提交失败（请求层：门内拒绝稳定码 / 本地拒发）—— */}
          {submitError !== null ? (
            <div
              className="mt-1.5 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1 text-red-800"
              data-verification-submit-error="true"
            >
              提交未执行（{submitError.code}）：{submitError.message}
            </div>
          ) : null}

          {/* —— 最近一次明确收尾（5.1 最小呈现；完整分层归 5.2/5.4）—— */}
          {lastOutcome !== null ? (
            <div
              className="mt-1.5 rounded border-l-2 border-sky-400 bg-sky-50 px-2 py-1 text-sky-900"
              data-verification-outcome="true"
            >
              {lastOutcome.kind === "prepare" ? (
                <div>
                  环境准备已收尾：准备记录 {lastOutcome.preparationId} · 镜像{" "}
                  <span className="font-code">{lastOutcome.imageDigest}</span>
                  。执行条件已随重新核对刷新。
                </div>
              ) : (
                <div>
                  检查执行已收尾：验证记录 {lastOutcome.verificationId} · 结局{" "}
                  <span className="font-semibold">{lastOutcome.outcome}</span>
                  {lastOutcome.evidenceComplete === false ? " · 证据不全" : ""}。
                  {lastOutcome.detail}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 条件表（精确输入 + 当前条件；capability/plan 缺席时如实说明缺什么） */
function conditionRows({
  capability,
  capabilityState,
  plan,
  planState,
}: {
  capability: VerificationCapabilityResult | null;
  capabilityState: VerificationPanelProps["capabilityState"];
  plan: VerificationPreparePlanResult | null;
  planState: VerificationPanelProps["planState"];
}): readonly ConfirmationRow[] {
  const rows: ConfirmationRow[] = [];
  if (capabilityState === "error") {
    rows.push({ label: "核对结果", value: "读取失败（见下方原因）——条件未知，不冒充可用" });
  } else if (capability === null) {
    rows.push({ label: "核对结果", value: "尚未取得（正在核对或未开始）" });
  } else {
    rows.push({
      label: "精确输入",
      value:
        capability.source === null
          ? "来源预检未通过（见下方原因）"
          : `快照 ${capability.source.snapshotId} · ${capability.source.fileCount} 个文件 · ${formatBytes(capability.source.totalBytes)}`,
    });
    rows.push({
      label: "已准备环境",
      value:
        capability.prepared === null
          ? "尚未准备（先完成环境准备）"
          : `${capability.prepared.preparationId} · 镜像 ${capability.prepared.imageDigest} · Node ${capability.prepared.toolchain.node} / TS ${capability.prepared.toolchain.typescript}`,
    });
    rows.push({
      label: "本机后端",
      value: capability.engine.available
        ? `Docker 引擎 ${capability.engine.engineVersion ?? "（版本未知）"}`
        : `不可用：${capability.engine.reason ?? "原因未提供"}`,
    });
    rows.push({
      label: "当前计划 token",
      value: capability.planToken,
    });
    const summary = capability.profileSummary;
    rows.push({
      label: "profile",
      value: `${summary.profileId} · manifest v${summary.manifestVersion} · ${summary.platform} · 受支持源码面 ${summary.sourceIncludeGlob}`,
    });
  }
  if (planState === "error") {
    rows.push({ label: "准备计划", value: "预览读取失败（见下方原因）" });
  } else if (plan === null) {
    rows.push({ label: "准备计划", value: "尚未取得（只读预览）" });
  } else {
    rows.push({
      label: "准备计划",
      value: `${plan.plan.downloads.length} 项固定下载 · 占用估计 ${formatBytes(plan.plan.spaceEstimateBytes)} · 网络与脚本策略见确认卡`,
    });
  }
  return rows;
}
