import type {
  VerificationCapabilityResult,
  VerificationCheckpoint,
  VerificationGetMeta,
  VerificationGetResult,
  VerificationPreparePlanResult,
} from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { useTranslator } from "../i18n";
import type { ConfirmationRow } from "../lib/execution-confirmation";
import { disclosureLines } from "../lib/execution-confirmation";
import { formatBytes } from "../lib/format";
import type { VerificationComparison } from "../lib/verification-compare";
import type { VerificationCompareCandidate } from "../lib/verification-entry";
import {
  type VerificationBlocker,
  type VerificationConfirmationDecision,
  blockerLine,
  blockersFor,
  verificationBlockers,
  verificationDecisionLine,
  verificationPrepareDisclosure,
  verificationRecordLine,
  verificationRunDisclosure,
  verificationTargetLabel,
} from "../lib/verification-entry";
import type { VerificationRecordView } from "../lib/verification-reading";
import { verificationStatusLine } from "../lib/verification-reading";
import type {
  VerificationExportFeedback,
  VerificationOutcomeView,
  VerificationSubmitError,
} from "../store/slices/verification";
import { ConfirmationBlock } from "./ConfirmationBlock";
import { FOCUS_RING } from "./IconButton";

/**
 * R3 任务 5.1/5.2/5.3：文件页检查点侧的**项目验证**面板（展示层，只吃 props）。
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
 * 5.2（D03/D04/D05/D10/M01/M02 的呈现面）：
 * - **操作登记核对区**（D03/M01）：按显式目标匹配到的 R3 登记记录逐条展示
 *   （状态/领域 ID/请求结局来自登记记录，不猜）；会话通信未知 ⇒ 只提示核对（D10）。
 * - **结局分层**（D04）：请求收尾（登记 settled/requestOutcome）、测试结局（outcome）、
 *   证据完整性（evidenceComplete）分行呈现，check_failed 不标成请求失败。
 * - **停止反馈**（D05/D06）：执行在飞时提供定向停止（按钮只在 run 在飞可用；
 *   准备阶段如实说明不可中断）；停止已请求 ⇒ 等待编排确认全部停止；
 *   幂等 no-op 与失败码如实呈现，不伪造取消。
 *
 * 5.3（D09/P13/P16 的呈现面）：
 * - **记录与日志阅读区**：只读**可信验证身份**（登记附件 ∪ 响应），读取零执行零补写；
 *   记录状态（封存/未封存/损坏/版本）如实呈现，未封存不冒充结局；
 * - **有界日志切片**（P13）：显示保留/全观测双口径字节与截断标注；切片正文标注
 *   "不是完整日志"（remaining/续读），不混入上一条正文（身份+代次守卫在 store）；
 * - **附件损坏/缺失**（D09/P16）：R3_LOG_* 稳定码就近呈现，不自动补写。
 * - **显式 selector**：目标（runId+checkpoint）由连接层在打开时显式绑定；本组件只显示
 *   `verificationTargetLabel`，绝不从当前文件选择器推导目标。
 */

/** 领域结局的可读短语（D04：结局 ≠ 请求收尾；原文枚举随行展示） */
export function verificationOutcomeLabel(outcome: string): string {
  switch (outcome) {
    case "passed":
      return "通过（固定检查全过）";
    case "check_failed":
      return "检查未通过（断言失败/非零退出——不是请求失败）";
    case "environment_failed":
    case "start_failed":
    case "process_failed":
      return "环境/进程故障（不算项目断言失败）";
    case "timed_out":
    case "output_limit":
    case "cancelled":
      return "超时/超限/已停止（须先确认全部停止）";
    case "artifact_invalid":
      return "产物非法（含改源码冒充修复——改代码不是修复）";
    case "evidence_incomplete":
      return "证据不全（不能绿色通过）";
    case "unknown":
      return "未知（停止未确认或引擎断开）";
    default:
      return "未知结局";
  }
}

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

  // —— 5.2：操作登记核实与停止反馈（全部来自登记记录，不猜）——
  /** 按显式目标匹配到的 R3 登记记录（本会话已采纳的操作事实） */
  readonly matchedRecords: readonly OperationRecord[];
  /** 操作会话通信未知（D10）：只提示核对，不展示任何"执行中/已结束"猜测 */
  readonly operationsUnknown: boolean;
  /** 在飞 R3 操作身份（提交动作铸出；通道抛错后保留供核对） */
  readonly activeOperation: { kind: "prepare" | "run"; operationId: string } | null;
  readonly stopRequested: boolean;
  readonly stopNotice: string | null;
  readonly stopError: VerificationSubmitError | null;
  readonly onStop: () => void;

  // —— 5.3：验证记录与有界日志（只读可信身份；D09/P13/P16）——
  /** 可信验证身份（登记附件 ∪ 响应）；连接层保证不含猜测来源 */
  readonly trustedVerificationIds: readonly string[];
  readonly recordFocus: string | null;
  readonly onFocusRecord: (verificationId: string) => void;
  readonly recordState: "idle" | "loading" | "ready" | "error";
  /** 收窄后的记录视图（lib/verification-reading 的产物；null = 尚未就绪） */
  readonly recordView: VerificationRecordView | null;
  readonly recordStatus: VerificationGetResult["status"] | null;
  /** 记录头（5.5 导出绑定：run/检查点/快照事实）；不可读 ⇒ null */
  readonly recordMeta: VerificationGetMeta | null;
  /** 记录读取的结构化错误（坏尾行号/原因；P15/D09） */
  readonly recordErrorInfo: VerificationGetResult["error"];
  readonly recordError: { code: string; message: string } | null;
  /** 该验证的导出反馈（按 verificationId 留存；光标在别处时不显示） */
  readonly exportFeedback: VerificationExportFeedback | null;
  readonly onExportInput: () => void;
  readonly logIdentity: {
    verificationId: string;
    commandId: "typecheck" | "test";
    stream: "stdout" | "stderr";
  } | null;
  readonly logText: string;
  readonly logMeta: {
    totalBytes: number;
    nextOffset: number;
    remaining: number;
    truncated: boolean;
  } | null;
  readonly logState: "idle" | "loading" | "ready" | "error";
  readonly logError: { code: string; message: string } | null;
  readonly onReadLog: (
    commandId: "typecheck" | "test",
    stream: "stdout" | "stderr",
    mode: "replace" | "append",
  ) => void;

  // —— 5.4：双验证比较（D07/P24/P25：只读记录、显式 A/B）——
  /** 本会话登记附件里的验证身份（跨 run；不从时间/列表猜） */
  readonly compareCandidates: readonly VerificationCompareCandidate[];
  readonly compareLeft: string | null;
  readonly compareRight: string | null;
  readonly compareState: "idle" | "loading" | "ready" | "error";
  readonly compareError: { code: string; message: string } | null;
  readonly comparison: VerificationComparison | null;
  readonly onSelectCompareSide: (side: "left" | "right", verificationId: string | null) => void;
  readonly onClearCompare: () => void;
  /** 只读重试：重新读取两侧记录（不准备/不执行，D03/D04 同款） */
  readonly onRetryCompare: () => void;
  /** 两侧来源 run 不同才可打开运行比较；调用方判据见 WorkspaceFileView */
  readonly canOpenCompareDiff: boolean;
  readonly onOpenCompareDiff: () => void;
}

/** 判定与阻碍的文案映射在 lib（原因码/原因事实 → 当前语言），组件只排版。 */
type PanelTranslator = ReturnType<typeof useTranslator>;

function blockerLines(
  blockers: readonly VerificationBlocker[],
  translator: PanelTranslator,
): readonly string[] {
  return blockers.map((one) => blockerLine(one, translator));
}

function sourceStatusLabel(status: "present" | "missing" | "unknown"): string {
  switch (status) {
    case "present":
      return "来源在场";
    case "missing":
      return "来源已缺失（记录仍可读）";
    case "unknown":
      return "来源状态未知";
  }
}

function compareCandidateSourceLine(candidate: VerificationCompareCandidate): string {
  const run = candidate.runId ?? "来源 run 未知";
  const checkpoint =
    candidate.checkpointKind === null
      ? "检查点未知"
      : candidate.checkpointKind === "initial"
        ? "初始检查点"
        : `步骤 ${candidate.stepSpanId ?? "?"}`;
  const command = candidate.commandId ?? "命令未知";
  return `${run} · ${checkpoint} · ${command}`;
}

function metaCheckpointLabel(meta: VerificationGetMeta): string {
  return meta.checkpoint.kind === "initial"
    ? "初始检查点"
    : `步骤检查点 ${meta.checkpoint.stepSpanId}`;
}

/** 5.5：验证输入导出的反馈（W03/W04/D08；不把导出说成测试通过） */
function VerificationExportFeedbackBody({
  feedback,
  expectedSnapshotId,
}: {
  feedback: VerificationExportFeedback;
  expectedSnapshotId: string | null;
}) {
  switch (feedback.kind) {
    case "in-flight":
      return (
        <div
          data-verification-export-feedback="in-flight"
          className="mt-0.5 text-[10px] text-violet-800"
        >
          正在导出该验证的精确输入… 切换检查点/比较侧或离开页面都不会改变绑定，main 侧继续写入。
        </div>
      );
    case "canceled":
      return (
        <div
          data-verification-export-feedback="canceled"
          className="mt-0.5 text-[10px] text-gray-600"
        >
          已取消目录选择：没有写入任何内容。
        </div>
      );
    case "failed":
      return (
        <div data-verification-export-feedback="failed" className="mt-0.5 text-[10px] text-red-700">
          导出失败（{feedback.code}）：{feedback.reason}
          {feedback.retained.length > 0 ? (
            <div>
              目标残留（清理未完成，不可当作完整导出）：
              {feedback.retained.join("、")}
            </div>
          ) : null}
        </div>
      );
    case "exported": {
      const outcome = feedback.outcome;
      const matches = expectedSnapshotId !== null && outcome.snapshotId === expectedSnapshotId;
      return (
        <div
          data-verification-export-feedback="exported"
          data-export-snapshot-match={matches ? "true" : "false"}
          className="mt-0.5 rounded border border-emerald-200 bg-white px-1.5 py-1 text-[10px] leading-4 text-gray-700"
        >
          <div>
            已导出 {outcome.fileCount} 个文件（{formatBytes(outcome.totalFileBytes)}）到{" "}
            <span className="break-all font-code">{outcome.targetDir}</span>
          </div>
          <div>
            验证快照 {expectedSnapshotId ?? "未知"} · 导出快照 {outcome.snapshotId} ·{" "}
            {matches ? "一致（写入前已绑定）" : "不一致（异常，请以清单为准）"}
          </div>
          <div>
            补丁：
            {outcome.patch.status === "written"
              ? `changes.patch（${outcome.patch.bytes ?? 0} 字节）`
              : outcome.patch.status === "no_text_changes"
                ? "无文本差异"
                : `不可用${outcome.patch.reason === null ? "" : `（${outcome.patch.reason}）`}`}
          </div>
          <div className="text-gray-500">
            回查：目标根 rebaseagent-export.json 的 source.snapshot_id 与 files[] 哈希可逐项核对。
          </div>
          <div className="text-amber-800">
            文件导出 ≠ 测试通过；导出的是所测输入快照，不含日志/材料包，也不应用补丁。
          </div>
        </div>
      );
    }
  }
}

function compareConditionStateLabel(state: "same" | "different" | "unknown"): string {
  switch (state) {
    case "same":
      return "一致";
    case "different":
      return "不同";
    case "unknown":
      return "未知";
  }
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
  matchedRecords,
  operationsUnknown,
  activeOperation,
  stopRequested,
  stopNotice,
  stopError,
  onStop,
  trustedVerificationIds,
  recordFocus,
  onFocusRecord,
  recordState,
  recordView,
  recordStatus,
  recordMeta,
  recordErrorInfo,
  recordError,
  exportFeedback,
  onExportInput,
  logIdentity,
  logText,
  logMeta,
  logState,
  logError,
  onReadLog,
  compareCandidates,
  compareLeft,
  compareRight,
  compareState,
  compareError,
  comparison,
  onSelectCompareSide,
  onClearCompare,
  onRetryCompare,
  canOpenCompareDiff,
  onOpenCompareDiff,
}: VerificationPanelProps) {
  const translator = useTranslator();
  const prepareBlockers = blockersFor(verificationBlockers(capability, translator), "prepare");
  const runBlockers = blockersFor(verificationBlockers(capability, translator), "run");
  const preparing = submitting === "prepare";
  const running = submitting === "run";
  // 提交资格：确认现算判定为 confirmed ∧ 该动作的不可用原因为空（D02：不隐式执行）
  const prepareReady =
    prepareDecision.kind === "confirmed" && prepareBlockers.length === 0 && !preparing;
  const runReady = runDecision.kind === "confirmed" && runBlockers.length === 0 && !running;
  const prepareDisclosure = verificationPrepareDisclosure(
    {
      runId,
      checkpointLabel: verificationTargetLabel(checkpoint, translator),
      capability,
      plan,
    },
    translator,
  );
  const runDisclosure = verificationRunDisclosure(
    {
      runId,
      checkpointLabel: verificationTargetLabel(checkpoint, translator),
      commandId,
      capability,
    },
    translator,
  );
  return (
    <div className="mt-1 min-w-0" data-verification-panel={runId}>
      <button
        type="button"
        data-verification-entry="true"
        disabled={!isolatedEligible}
        aria-expanded={expanded ? "true" : "false"}
        onClick={onToggleExpanded}
        title={
          isolatedEligible
            ? translator.t("verification.entryTitle")
            : translator.t("verification.entryDisabledTitle")
        }
        className={`rounded border border-emerald-300 px-2 py-0.5 text-[11px] text-emerald-700 hover:bg-emerald-50 ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        {expanded
          ? translator.t("verification.entryClose")
          : translator.t("verification.entryOpen")}
      </button>
      {!isolatedEligible ? (
        <span className="ml-2 text-[10px] text-gray-400">
          {translator.t("verification.entryNotIsolated")}
        </span>
      ) : null}

      {expanded && isolatedEligible ? (
        <div
          className="mt-1.5 rounded border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-[11px] leading-5 text-gray-700"
          data-verification-confirm="true"
        >
          <div className="font-semibold text-gray-800">
            {translator.t("verification.panelHeading", {
              checkpoint: verificationTargetLabel(checkpoint, translator),
              runId,
            })}
          </div>
          <div className="mt-0.5 text-gray-500">
            {translator.t("verification.panelReadonlyNote")}
          </div>

          {/* —— 精确输入与当前条件（D01）—— */}
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] leading-4">
            {conditionRows({
              capability,
              capabilityState,
              plan,
              planState,
              translator,
            }).map((row) => (
              <div key={`${row.label}-${row.value}`} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-gray-500">{row.label}</dt>
                <dd className="min-w-0 break-words text-gray-700">{row.value}</dd>
              </div>
            ))}
          </dl>

          {/* —— 核对异常与重试（核对失败 ≠ 不可用：如实说明）—— */}
          {capabilityError !== null ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              {translator.t("verification.capabilityCheckFailed", {
                code: capabilityError.code,
                detail: capabilityError.message,
              })}
              <button
                type="button"
                data-verification-retry-capability="true"
                onClick={onRetryCapability}
                className={`ml-2 rounded border border-amber-300 px-1.5 py-0.5 text-[10px] ${FOCUS_RING}`}
              >
                {translator.t("verification.retryCapability")}
              </button>
            </div>
          ) : null}
          {planError !== null ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              {translator.t("verification.planReadFailed", {
                code: planError.code,
                detail: planError.message,
              })}
              <button
                type="button"
                data-verification-retry-plan="true"
                onClick={onRetryPlan}
                className={`ml-2 rounded border border-amber-300 px-1.5 py-0.5 text-[10px] ${FOCUS_RING}`}
              >
                {translator.t("verification.retryPlan")}
              </button>
            </div>
          ) : null}
          {capabilityState === "loading" || planState === "loading" ? (
            <div className="mt-1.5 text-gray-500">
              {translator.t("verification.checkingReadonly")}
            </div>
          ) : null}

          {/* —— 不可用原因（D01：可行动说明就近显示）—— */}
          {prepareBlockers.length > 0 ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              {blockerLines(prepareBlockers, translator).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}
          {runBlockers.length > 0 ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              {blockerLines(runBlockers, translator).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}

          {/* —— 两份独立确认（D02：准备与执行许可不互相替代）—— */}
          <ConfirmationBlock
            title={translator.t("verification.prepareBlockTitle")}
            summary={prepareDisclosure.summary}
            rows={disclosureLines(prepareDisclosure, translator)}
            confirmed={prepareDecision.kind === "confirmed"}
            confirmDisabled={capabilityState !== "ready"}
            onConfirm={onConfirmPrepare}
            confirmLabel={translator.t("verification.prepareConfirm")}
            confirmedLabel={translator.t("verification.prepareConfirmed")}
            blocked={verificationDecisionLine(prepareDecision, translator)}
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
              {preparing
                ? translator.t("verification.prepareSubmitting")
                : translator.t("verification.prepareSubmit")}
            </button>
            <span className="text-[10px] text-gray-500">
              {translator.t("verification.prepareSubmitHint")}
            </span>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] font-medium text-gray-600">
              {translator.t("verification.commandLabel")}
            </span>
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
            title={translator.t("verification.runBlockTitle")}
            summary={runDisclosure.summary}
            rows={disclosureLines(runDisclosure, translator)}
            confirmed={runDecision.kind === "confirmed"}
            confirmDisabled={capabilityState !== "ready"}
            onConfirm={onConfirmRun}
            confirmLabel={translator.t("verification.runConfirm")}
            confirmedLabel={translator.t("verification.runConfirmed")}
            blocked={verificationDecisionLine(runDecision, translator)}
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
              {running
                ? translator.t("verification.runSubmitting")
                : translator.t("verification.runSubmit")}
            </button>
            <span className="text-[10px] text-gray-500">
              {translator.t("verification.runSubmitHint")}
            </span>
          </div>

          {/* —— 在飞操作与定向停止（5.2/D05：只停当前 owner；准备阶段如实说明不可中断）—— */}
          {activeOperation !== null ? (
            <div
              className="mt-1.5 rounded border-l-2 border-orange-300 bg-orange-50 px-2 py-1 text-orange-900"
              data-verification-active-operation="true"
            >
              <div>
                {activeOperation.kind === "prepare"
                  ? "环境准备进行中：准备阶段不可中断（构建过程如实呈现，不提供定向停止）；等待其自然收尾。"
                  : "固定检查执行中：可对当前操作定向停止（只作用于本次执行的受控资源）。"}
              </div>
              {activeOperation.kind === "run" ? (
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    data-verification-stop="true"
                    disabled={stopRequested}
                    onClick={onStop}
                    className={`rounded border border-red-300 bg-white px-2 py-0.5 text-[11px] text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
                  >
                    {stopRequested ? "停止已请求（等待确认）" : "请求停止"}
                  </button>
                  <span className="text-[10px] text-gray-500">
                    领域 ID 只从操作登记取；重复点击安全（幂等）；确认全部停止前保持占用。
                  </span>
                </div>
              ) : null}
              {stopRequested ? (
                <div className="mt-1 text-[10px] text-orange-800">
                  停止信号已送达编排：确认全部工作负载停止并收尾后，结局（cancelled/unknown）才会呈现；
                  在此之前操作保持占用，不显示为已结束。
                </div>
              ) : null}
              {stopNotice !== null ? (
                <div
                  className="mt-1 text-[10px] text-gray-600"
                  data-verification-stop-notice="true"
                >
                  {stopNotice}
                </div>
              ) : null}
              {stopError !== null ? (
                <div className="mt-1 text-[10px] text-red-700" data-verification-stop-error="true">
                  停止未执行（{stopError.code}）：{stopError.message}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* —— 操作登记核对区（5.2/D03/M01/D10：只呈现登记事实，不猜）—— */}
          {operationsUnknown ? (
            <div
              className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800"
              data-verification-operations-unknown="true"
            >
              操作状态未知（状态通道失联或返回非法）：请先用上方操作入口核对状态；
              在有效快照确认前，这里不显示任何"执行中/已结束"的猜测，也不提供停止。
            </div>
          ) : matchedRecords.length > 0 ? (
            <div
              className="mt-1.5 rounded border border-gray-200 bg-white px-2 py-1"
              data-verification-records="true"
            >
              <div className="text-[10px] font-medium text-gray-500">
                本检查点的验证操作（来自操作登记核对；重载后凭登记恢复，不猜测）
              </div>
              {matchedRecords.map((record) => (
                <div
                  key={record.operationId}
                  className="mt-0.5 text-[11px] leading-4 text-gray-700"
                >
                  {verificationRecordLine(record)}
                  {record.verificationIds.length > 0 ? (
                    <span className="ml-1 font-code text-[10px] text-gray-500">
                      验证 {record.verificationIds.join("、")}
                    </span>
                  ) : null}
                  {record.preparationIds.length > 0 ? (
                    <span className="ml-1 font-code text-[10px] text-gray-500">
                      准备 {record.preparationIds.join("、")}
                    </span>
                  ) : null}
                  {record.errorCode !== null ? (
                    <span className="ml-1 text-red-700">（{record.errorCode}）</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {/* —— 验证记录与有界日志（5.3/D09/P13/P16：只读可信身份；零执行零补写）—— */}
          {trustedVerificationIds.length > 0 ? (
            <div
              className="mt-1.5 rounded border border-sky-200 bg-sky-50/40 px-2 py-1"
              data-verification-reading="true"
            >
              <div className="text-[10px] font-medium text-gray-500">
                验证记录与日志（只读下方可信身份；读取零执行、零补写、零清理）
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                {trustedVerificationIds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    data-verification-record-focus={id}
                    aria-pressed={recordFocus === id ? "true" : undefined}
                    onClick={() => onFocusRecord(id)}
                    className={`max-w-full break-all rounded border px-1.5 py-0.5 text-left font-code text-[10px] ${FOCUS_RING} ${
                      recordFocus === id
                        ? "border-sky-500 bg-sky-100 text-sky-900"
                        : "border-gray-300 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {id}
                  </button>
                ))}
              </div>

              {recordFocus === null ? (
                <div className="mt-1 text-[10px] text-gray-500">
                  选择一个验证身份查看记录与日志（身份来自登记附件与执行响应，不从时间/日志猜测）。
                </div>
              ) : (
                <div className="mt-1" data-verification-record-view="true">
                  {recordState === "loading" ? (
                    <div className="text-[10px] text-gray-500">正在读取验证记录（只读）…</div>
                  ) : null}
                  {recordError !== null ? (
                    <div className="text-[10px] text-red-700">
                      记录读取失败（{recordError.code}）：{recordError.message}
                    </div>
                  ) : null}
                  {recordState === "ready" && recordView !== null && recordStatus !== null ? (
                    <div className="space-y-0.5 text-[11px] leading-4 text-gray-700">
                      <div>{verificationStatusLine(recordStatus, recordErrorInfo)}</div>
                      <div className="text-[10px] text-gray-500">
                        共 {recordView.eventCount} 条事件
                        {recordView.stages.length > 0
                          ? ` · 阶段：${recordView.stages.join(" → ")}`
                          : ""}
                      </div>
                      {recordView.terminated ? (
                        <div>
                          结局：<span className="font-semibold">{recordView.outcome}</span>（
                          {verificationOutcomeLabel(recordView.outcome ?? "")}）。
                          {recordView.detail}
                          {" · "}证据{recordView.evidenceComplete === true ? "完整" : "不全"}
                        </div>
                      ) : (
                        <div className="text-amber-800">
                          记录未封存或损坏：不呈现结局（不以未完成事实冒充通过/失败）。
                        </div>
                      )}
                      {recordView.commandEnds.map((entry) => (
                        <div
                          key={`${recordFocus}-${entry.commandId}`}
                          className="mt-1 rounded border border-gray-200 bg-white px-1.5 py-1"
                          data-verification-command-end={entry.commandId}
                        >
                          <div>
                            <span className="font-medium">{entry.commandId}</span>
                            {" · "}
                            退出码 {entry.exitCode === null ? "（未知）" : entry.exitCode}
                            {" · "}
                            耗时 {entry.durationMs}ms
                          </div>
                          <div className="text-[10px] text-gray-500">
                            stdout 保留 {formatBytes(entry.stdoutBytes)}
                            {entry.stdoutTruncated
                              ? `（全观测 ${formatBytes(entry.stdoutTotalBytes)}，超出部分已按限额丢弃并计数）`
                              : ""}
                            {" · stderr 保留 "}
                            {formatBytes(entry.stderrBytes)}
                            {entry.stderrTruncated
                              ? `（全观测 ${formatBytes(entry.stderrTotalBytes)}，超出部分已按限额丢弃并计数）`
                              : ""}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1">
                            {(["stdout", "stderr"] as const).map((stream) => (
                              <button
                                key={stream}
                                type="button"
                                data-verification-read-log={`${entry.commandId}:${stream}`}
                                onClick={() => onReadLog(entry.commandId, stream, "replace")}
                                className={`rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                              >
                                读 {stream}
                              </button>
                            ))}
                            <span className="text-[10px] text-gray-400">
                              有界切片（默认 32 KiB/页，上限 64 KiB）
                            </span>
                          </div>
                        </div>
                      ))}
                      {recordView.commandEnds.length === 0 ? (
                        <div className="text-[10px] text-gray-500">
                          记录里没有命令执行事实（可能未到执行阶段或被中断）。
                        </div>
                      ) : null}

                      {/* —— 5.5 导出所测输入（W03/W04/D08：绑定该验证的精确快照）—— */}
                      {recordMeta !== null ? (
                        <div
                          className="mt-1 rounded border border-slate-300 bg-slate-50 px-1.5 py-1"
                          data-verification-export="true"
                        >
                          <div className="text-[10px] font-medium text-gray-600">
                            导出所测输入（R2.1）——文件快照；不含日志/材料包，也不是测试通过
                          </div>
                          <div className="text-[10px] text-gray-500">
                            绑定：{recordMeta.runId} · {metaCheckpointLabel(recordMeta)} · snapshot{" "}
                            {recordMeta.snapshotId}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              data-verification-export-start="true"
                              disabled={recordStatus !== "sealed"}
                              onClick={onExportInput}
                              className={`rounded border border-slate-400 px-1.5 py-0.5 text-[10px] text-slate-800 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
                            >
                              选择空目录并导出精确输入
                            </button>
                            {recordStatus === "sealed" ? (
                              <span className="text-[10px] text-gray-500">
                                目标由原生对话框选择（须为空目录）；导出前 main 重核记录/来源/快照
                                ID。
                              </span>
                            ) : (
                              <span
                                data-verification-export-blocked="true"
                                className="text-[10px] text-amber-800"
                              >
                                记录未封存：不提供导出（不以未完成记录绑定输入）。
                              </span>
                            )}
                          </div>
                          {exportFeedback !== null ? (
                            <VerificationExportFeedbackBody
                              feedback={exportFeedback}
                              expectedSnapshotId={recordMeta.snapshotId}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* 日志切片视图（身份 + 正文 + 分页事实） */}
                  {logIdentity !== null ? (
                    <div
                      className="mt-1 rounded border border-gray-200 bg-white px-1.5 py-1"
                      data-verification-log-view="true"
                    >
                      <div className="text-[10px] text-gray-500">
                        {logIdentity.verificationId} · {logIdentity.commandId} ·{" "}
                        {logIdentity.stream}
                        {logState === "loading" ? " · 读取中…" : ""}
                      </div>
                      {logError !== null ? (
                        <div
                          className="mt-0.5 text-[10px] text-red-700"
                          data-verification-log-error="true"
                        >
                          日志读取失败（{logError.code}）：{logError.message}
                          {logError.code === "R3_LOG_ASSET_CORRUPT"
                            ? "（附件损坏：不以损坏字节冒充正文）"
                            : ""}
                          {logError.code === "R3_LOG_ASSET_MISSING"
                            ? "（附件缺失：不自动补写）"
                            : ""}
                        </div>
                      ) : null}
                      {logState === "ready" && logMeta !== null ? (
                        <>
                          {/* 只读 textarea：原生可聚焦滚动（D11 键盘可达），不引入输入语义 */}
                          <textarea
                            readOnly
                            aria-label="验证日志切片（有界只读；可聚焦滚动）"
                            value={logText}
                            rows={Math.min(12, Math.max(3, logText.split("\n").length))}
                            className="mt-0.5 w-full resize-y overflow-auto whitespace-pre-wrap break-all font-code text-[10px] leading-4 text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1"
                            data-verification-log-text="true"
                          />
                          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gray-500">
                            <span>
                              共 {formatBytes(logMeta.totalBytes)} · 已读{" "}
                              {formatBytes(logMeta.nextOffset)}
                              {logMeta.remaining > 0
                                ? ` · 剩余 ${formatBytes(logMeta.remaining)}`
                                : ""}
                              {logMeta.truncated ? " · 本切片有截断" : ""}
                            </span>
                            {logMeta.remaining > 0 ? (
                              <button
                                type="button"
                                data-verification-log-continue="true"
                                onClick={() =>
                                  logIdentity === null
                                    ? undefined
                                    : onReadLog(logIdentity.commandId, logIdentity.stream, "append")
                                }
                                className={`rounded border border-gray-300 px-1.5 py-0.5 text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                              >
                                续读下一页
                              </button>
                            ) : null}
                            {logMeta.remaining === 0 ? (
                              <span>已到记录保留的末尾（超出限额的丢弃量见上方全观测计数）</span>
                            ) : null}
                          </div>
                          {logMeta.truncated || logMeta.remaining > 0 ? (
                            <div className="mt-0.5 text-[10px] text-amber-800">
                              以上是有界切片视图，不是完整日志（P13：不以截断视图表示完整日志）。
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {/* —— 5.4 修复证据比较（D07/P24/P25：只读记录、显式 A/B、条件未知不合成）—— */}
          {compareCandidates.length > 0 ? (
            <div
              className="mt-1.5 rounded border border-violet-200 bg-violet-50/40 px-2 py-1"
              data-verification-compare="true"
            >
              <div className="flex flex-wrap items-center justify-between gap-1">
                <div className="text-[10px] font-medium text-gray-500">
                  修复证据比较（A 原验证 / B 修复验证）——只读记录、不自动准备/执行
                </div>
                {compareLeft !== null || compareRight !== null ? (
                  <button
                    type="button"
                    data-compare-clear="true"
                    onClick={onClearCompare}
                    className={`rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
                  >
                    清空比较
                  </button>
                ) : null}
              </div>
              <div className="mt-0.5 grid gap-1 sm:grid-cols-2">
                {(["left", "right"] as const).map((side) => {
                  const selected = side === "left" ? compareLeft : compareRight;
                  const other = side === "left" ? compareRight : compareLeft;
                  return (
                    <div key={side} data-compare-side-selector={side}>
                      <div className="text-[10px] text-gray-500">
                        {side === "left" ? "A · 原验证" : "B · 修复验证"}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        {compareCandidates.map((candidate) => {
                          const id = candidate.verificationId;
                          const isSelected = selected === id;
                          const isOther = other === id;
                          const source = compareCandidateSourceLine(candidate);
                          return (
                            <button
                              key={id}
                              type="button"
                              data-compare-side={`${side}:${id}`}
                              aria-pressed={isSelected ? "true" : undefined}
                              disabled={isOther && !isSelected}
                              title={isOther ? "同一验证不能与自己比较" : `${id}（${source}）`}
                              onClick={() => onSelectCompareSide(side, isSelected ? null : id)}
                              className={`max-w-full break-all rounded border px-1.5 py-0.5 text-left font-code text-[10px] ${FOCUS_RING} ${
                                isSelected
                                  ? "border-violet-500 bg-violet-100 text-violet-900"
                                  : "border-gray-300 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                              }`}
                            >
                              {id}
                            </button>
                          );
                        })}
                      </div>
                      {selected === null ? null : (
                        <div className="mt-0.5 text-[10px] text-gray-500">
                          来源：
                          {compareCandidateSourceLine(
                            compareCandidates.find((one) => one.verificationId === selected) ?? {
                              verificationId: selected,
                              runId: null,
                              checkpointKind: null,
                              stepSpanId: null,
                              commandId: null,
                              operationState: null,
                            },
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {compareLeft === null || compareRight === null ? (
                <div className="mt-1 text-[10px] text-gray-500">
                  显式选择 A/B 两条验证（不自动挑"最近"）；两侧选齐才读取记录。
                </div>
              ) : (
                <div className="mt-1" data-compare-view="true">
                  {compareState === "loading" ? (
                    <div className="text-[10px] text-gray-500">正在读取两侧验证记录（只读）…</div>
                  ) : null}
                  {compareError !== null ? (
                    <div className="text-[10px] text-red-700" data-compare-error="true">
                      比较读取失败（{compareError.code}）：{compareError.message}
                      <button
                        type="button"
                        data-compare-retry="true"
                        onClick={onRetryCompare}
                        className={`ml-1 rounded border border-gray-300 px-1.5 py-0.5 text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                      >
                        只读重试
                      </button>
                    </div>
                  ) : null}
                  {compareState === "ready" && comparison !== null ? (
                    <>
                      <div
                        data-compare-verdict={comparison.verdict.kind}
                        className={`rounded border px-1.5 py-1 text-[11px] leading-4 ${
                          comparison.verdict.kind === "failed-to-passed"
                            ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                            : comparison.verdict.kind === "same-conditions-other-outcome"
                              ? "border-gray-300 bg-gray-50 text-gray-800"
                              : "border-amber-300 bg-amber-50 text-amber-900"
                        }`}
                      >
                        {comparison.verdict.headline}
                        {comparison.verdict.kind === "conditions-differ" ? (
                          <div className="mt-0.5 text-[10px]">
                            不同项：{comparison.verdict.differences.join("、")}
                          </div>
                        ) : null}
                        {comparison.verdict.kind === "conditions-unknown" ? (
                          <div className="mt-0.5 text-[10px]">
                            未知项：{comparison.verdict.unknowns.join("、")}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-1 grid gap-1 sm:grid-cols-2">
                        {(
                          [
                            ["left", comparison.left],
                            ["right", comparison.right],
                          ] as const
                        ).map(([side, view]) => (
                          <div
                            key={side}
                            data-compare-side-summary={side}
                            className="min-w-0 break-words rounded border border-gray-200 bg-white px-1.5 py-1 text-[10px] leading-4 text-gray-700"
                          >
                            <div className="font-medium">
                              {side === "left" ? "A · 原验证" : "B · 修复验证"} ·{" "}
                              {view.verificationId}
                            </div>
                            <div>
                              来源：{view.runId ?? "（未知）"} ·{" "}
                              {view.checkpointLabel ?? "检查点未知"} ·{" "}
                              {sourceStatusLabel(view.sourceStatus)}
                            </div>
                            <div>代码快照：{view.snapshotId ?? "未知"}</div>
                            <div>干预：{view.intervention}</div>
                            <div>
                              结局：{view.outcome ?? "未知"}
                              {view.outcome === null
                                ? ""
                                : `（${verificationOutcomeLabel(view.outcome)}）`}
                              {" · "}证据
                              {view.evidenceComplete === null
                                ? "未知"
                                : view.evidenceComplete
                                  ? "完整"
                                  : "不全"}
                            </div>
                            <div>
                              退出码 {view.exitCode === null ? "未知" : view.exitCode} · 耗时{" "}
                              {view.durationMs === null ? "未知" : `${view.durationMs}ms`}
                            </div>
                            <div>
                              日志保留{" "}
                              {view.logBytes === null
                                ? "（无命令事实）"
                                : `stdout ${formatBytes(view.logBytes.stdout)} / stderr ${formatBytes(view.logBytes.stderr)}（全观测 ${formatBytes(view.logBytes.stdoutTotal)} / ${formatBytes(view.logBytes.stderrTotal)}）`}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-600">
                        <span>
                          代码差异：
                          {comparison.codeSame === null
                            ? "未知"
                            : comparison.codeSame
                              ? "两侧快照一致"
                              : "两侧快照不同"}
                        </span>
                        {canOpenCompareDiff ? (
                          <button
                            type="button"
                            data-compare-open-diff="true"
                            onClick={onOpenCompareDiff}
                            className={`rounded border border-gray-300 px-1.5 py-0.5 text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                          >
                            在运行比较中查看代码差异
                          </button>
                        ) : (
                          <span data-compare-no-diff="true">
                            {comparison.left.runId !== null &&
                            comparison.left.runId === comparison.right.runId
                              ? "两侧来自同一 run（无跨 run 代码差异）"
                              : "缺少来源 run：代码差异不可核对"}
                          </span>
                        )}
                      </div>

                      <div className="mt-1" data-compare-conditions="true">
                        <div className="text-[10px] text-gray-500">
                          条件（只列记录事实；未知不拿当前 manifest 补齐）
                        </div>
                        {comparison.conditions.map((entry) => (
                          <div
                            key={entry.key}
                            data-compare-condition={entry.key}
                            data-compare-state={entry.state}
                            className="mt-0.5 break-all rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] leading-4"
                          >
                            <span className="font-medium">{entry.label}</span>：
                            {entry.left ?? "（未记录）"} {"vs"} {entry.right ?? "（未记录）"}
                            <span
                              className={
                                entry.state === "same"
                                  ? "ml-1 text-emerald-700"
                                  : entry.state === "different"
                                    ? "ml-1 text-red-700"
                                    : "ml-1 text-amber-700"
                              }
                            >
                              {compareConditionStateLabel(entry.state)}
                            </span>
                          </div>
                        ))}
                      </div>

                      <ul
                        className="mt-1 list-disc pl-4 text-[10px] leading-4 text-gray-500"
                        data-compare-limitations="true"
                      >
                        {comparison.limitations.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {/* —— 提交失败（请求层：门内拒绝稳定码 / 本地拒发）—— */}
          {submitError !== null ? (
            <div
              className="mt-1.5 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1 text-red-800"
              data-verification-submit-error="true"
            >
              <div>
                {translator.t("verification.submitFailedSummary", { code: submitError.code })}
              </div>
              {submitError.message.trim() === "" ? null : (
                <div className="mt-0.5 whitespace-pre-wrap break-words text-red-700">
                  {translator.t("verification.submitRawDetail")}
                  {submitError.message}
                </div>
              )}
            </div>
          ) : null}

          {/* —— 最近一次明确收尾（D04 分层：请求收尾 / 测试结局 / 证据完整性分行）—— */}
          {lastOutcome !== null ? (
            <div
              className="mt-1.5 rounded border-l-2 border-sky-400 bg-sky-50 px-2 py-1 text-sky-900"
              data-verification-outcome="true"
            >
              {lastOutcome.kind === "prepare" ? (
                <div>
                  <div>请求收尾：环境准备已明确返回（操作已收尾）。</div>
                  <div>
                    领域事实：准备记录 {lastOutcome.preparationId} · 镜像{" "}
                    <span className="font-code">{lastOutcome.imageDigest}</span>
                    。执行条件已随重新核对刷新。
                  </div>
                </div>
              ) : (
                <div className="space-y-0.5">
                  <div>请求收尾：执行请求已明确返回（操作已收尾，非请求层失败）。</div>
                  <div>
                    测试结局：<span className="font-semibold">{lastOutcome.outcome}</span>（
                    {verificationOutcomeLabel(lastOutcome.outcome ?? "")}）。
                  </div>
                  <div>
                    证据完整性：
                    {lastOutcome.evidenceComplete === false
                      ? "不全（截断/缺必要日志或报告——不能当作绿色通过）"
                      : "完整"}
                    。{lastOutcome.detail}
                  </div>
                  {lastOutcome.verificationId !== undefined ? (
                    <div className="text-[10px] text-gray-500">
                      验证身份 {lastOutcome.verificationId}（只重读该可信记录，不按时间/日志猜测）。
                    </div>
                  ) : null}
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
  translator,
}: {
  capability: VerificationCapabilityResult | null;
  capabilityState: VerificationPanelProps["capabilityState"];
  plan: VerificationPreparePlanResult | null;
  planState: VerificationPanelProps["planState"];
  translator: PanelTranslator;
}): readonly ConfirmationRow[] {
  const rows: ConfirmationRow[] = [];
  if (capabilityState === "error") {
    rows.push({
      label: translator.t("verification.conditionCapability"),
      value: translator.t("verification.conditionCapabilityFailed"),
    });
  } else if (capability === null) {
    rows.push({
      label: translator.t("verification.conditionCapability"),
      value: translator.t("verification.conditionCapabilityPending"),
    });
  } else {
    rows.push({
      label: translator.t("verification.fieldExactInput"),
      value:
        capability.source === null
          ? translator.t("verification.sourceNotReady")
          : translator.t("verification.sourceSnapshot", {
              snapshotId: capability.source.snapshotId,
              count: capability.source.fileCount,
              totalBytes: formatBytes(capability.source.totalBytes),
            }),
    });
    rows.push({
      label: translator.t("verification.fieldPrepared"),
      value:
        capability.prepared === null
          ? translator.t("verification.preparedMissing")
          : translator.t("verification.preparedSummary", {
              preparationId: capability.prepared.preparationId,
              imageDigest: capability.prepared.imageDigest,
              node: capability.prepared.toolchain.node,
              typescript: capability.prepared.toolchain.typescript,
            }),
    });
    rows.push({
      label: translator.t("verification.fieldBackend"),
      value: capability.engine.available
        ? translator.t("verification.backendEngine", {
            version:
              capability.engine.engineVersion ?? translator.t("verification.backendVersionUnknown"),
          })
        : translator.t("verification.backendUnavailable", {
            reason: capability.engine.reason ?? translator.t("verification.reasonMissing"),
          }),
    });
    rows.push({
      label: translator.t("verification.fieldPlanToken"),
      value: capability.planToken,
    });
    const summary = capability.profileSummary;
    rows.push({
      label: translator.t("verification.fieldProfile"),
      value: translator.t("verification.profileSummary", {
        profileId: summary.profileId,
        manifestVersion: summary.manifestVersion,
        platform: summary.platform,
        sourceIncludeGlob: summary.sourceIncludeGlob,
      }),
    });
  }
  if (planState === "error") {
    rows.push({
      label: translator.t("verification.fieldPreparePlan"),
      value: translator.t("verification.planPreviewFailed"),
    });
  } else if (plan === null) {
    rows.push({
      label: translator.t("verification.fieldPreparePlan"),
      value: translator.t("verification.planPending"),
    });
  } else {
    rows.push({
      label: translator.t("verification.fieldPreparePlan"),
      value: translator.t("verification.planSummary", {
        count: plan.plan.downloads.length,
        space: formatBytes(plan.plan.spaceEstimateBytes),
      }),
    });
  }
  return rows;
}
