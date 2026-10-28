import type { MessageKey, Translator } from "@rebaseagent/i18n";
import type { OperationDiagnostic } from "@shared/operations";
import { useTranslator } from "../i18n";
import type { OperationRow } from "../lib/operation-list";
import type { ResultAction } from "../lib/operation-result-view";
import type { ResultReadIdentity } from "../lib/result-verification";
import { FOCUS_RING } from "./IconButton";

/**
 * U4 任务 4.7 + U5 任务 3.5 / 3.6 / 5.1：操作行视图与样式（唯一来源）。
 * UI 整理 3.3：原全局操作入口的触发按钮与面板已迁往 SessionActivity（底部
 * 会话活动条），本文件只保留 OperationRowView / 色调 / 动作词等共享呈现件。
 *
 * 只呈现 main 与核实通道给得出的事实：类型、目标定位、running/settled/notAccepted/unknown、
 * 可信 runIds、**按身份核实到的结局**、**信封侧请求事实（5.1，与运行结局分层）**、
 * **可读的受控诊断列表（5.1，main 已脱敏限长）**。
 * **没有**进度百分比、"第几步"、停止/取消按钮（spec 明令不显示虚构阶段与取消能力）。
 *
 * 三个动作走三条不同通道，界面上就不可能混用：
 * - 「核对状态」→ `operations:reconcile(operationId)`（只读操作事实，不读 run 文件，**不导航**）；
 * - 「打开结果 / 查看失败调用 / 返回草稿」→ U5 3.5 的明确动作（用户主动才切页面）；
 * - 「重读这条结果」→ 同一条可信 runId 的只读重试（绝不重新执行、绝不换个 id 试试）。
 *
 * 结果状态是**只通知**的：核对、轮询、后台读取都只更新这里的事实，不改当前页面（design D6）；
 * 按钮上的「结果待看 N」由 `deriveResultNotices` 现算，同一结论重复到达不会把计数顶上去。
 */

const PHASE_STYLES: Record<OperationRow["phase"], string> = {
  running: "border-sky-300 bg-sky-50 text-sky-800",
  settled: "border-gray-200 bg-gray-50 text-gray-600",
  notAccepted: "border-amber-300 bg-amber-50 text-amber-800",
  unknown: "border-violet-300 bg-violet-300 text-violet-800",
};

const PHASE_LABEL_KEYS: Record<OperationRow["phase"], MessageKey> = {
  running: "run.phaseRunning",
  settled: "run.phaseSettled",
  notAccepted: "run.phaseNotAccepted",
  unknown: "run.phaseUnknown",
};

/** U5 5.1：与 A/B 批次结果区共用同一套色调（两处各写一份必然分叉） */
export const TONE_STYLES: Record<"neutral" | "success" | "danger" | "warn", string> = {
  neutral: "border-gray-200 bg-gray-50 text-gray-600",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
};

/** U5 5.1：A/B 批次结果区（`AbBatchResultSection`）与本面板共用同一套动作词与色调 */
const ACTION_LABEL_KEYS: Record<ResultAction, MessageKey> = {
  "open-result": "run.actionOpenResult",
  "view-failure": "run.actionViewFailure",
  "retry-read": "run.actionRetryRead",
  "return-draft": "run.actionReturnDraft",
};

export function actionLabelOf(action: ResultAction, translator: Translator): string {
  return translator.t(ACTION_LABEL_KEYS[action]);
}

const DIAGNOSTIC_STAGE_KEYS: Record<OperationDiagnostic["stage"], MessageKey> = {
  execute: "run.diagnosticStageExecute",
  identity: "run.diagnosticStageIdentity",
  finalize: "run.diagnosticStageFinalize",
  cleanup: "run.diagnosticStageCleanup",
  rejection: "run.diagnosticStageRejection",
};

/** 一条受控诊断：码与文案原样列出（main 已脱敏限长），阶段给本地化标签便于扫读 */
function DiagnosticLine({ diagnostic }: { diagnostic: OperationDiagnostic }) {
  const translator = useTranslator();
  return (
    <li className="break-all text-[10px] leading-4 text-gray-500">
      {translator.t("run.diagnosticLine", {
        stage: translator.t(DIAGNOSTIC_STAGE_KEYS[diagnostic.stage]),
        code: diagnostic.code,
        message: diagnostic.message,
      })}
    </li>
  );
}

function RowActionButton({
  action,
  identity,
  onAct,
}: {
  action: ResultAction;
  identity: ResultReadIdentity;
  onAct: (action: ResultAction, identity: ResultReadIdentity) => void;
}) {
  const translator = useTranslator();
  return (
    <button
      type="button"
      onClick={() => {
        onAct(action, identity);
      }}
      title={translator.t(
        action === "retry-read"
          ? "run.actionTitleRetry"
          : action === "view-failure"
            ? "run.actionTitleFailure"
            : action === "return-draft"
              ? "run.actionTitleReturn"
              : "run.actionTitleOpen",
        action === "retry-read" ? { runId: identity.runId } : undefined,
      )}
      className={`shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
    >
      {actionLabelOf(action, translator)}
    </button>
  );
}

/** 导出的唯一理由：本包无 jsdom，store 订阅部分测不了，但喂 props 的行视图可以走 renderToStaticMarkup。 */
export function OperationRowView({
  row,
  onReconcile,
  onAct,
}: {
  row: OperationRow;
  onReconcile: (operationId: string) => void;
  onAct: (action: ResultAction, identity: ResultReadIdentity) => void;
}) {
  const translator = useTranslator();
  const result = row.result;
  return (
    <li className="mt-1 rounded border border-gray-200 bg-white p-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${PHASE_STYLES[row.phase]}`}
        >
          {translator.t(PHASE_LABEL_KEYS[row.phase])}
        </span>
        <span className="min-w-0 break-all text-[11px] font-semibold text-gray-800">
          {row.kindLabel ?? translator.t("run.kindUnknown")}
        </span>
        <button
          type="button"
          onClick={() => {
            onReconcile(row.operationId);
          }}
          title={translator.t("run.reconcileTitle", { id: row.operationId })}
          className={`ml-auto shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          {translator.t("run.reconcileButton")}
        </button>
      </div>
      <div className="mt-0.5 break-all text-[10px] leading-4 text-gray-500">{row.targetText}</div>
      <div className="break-all font-code text-[10px] leading-4 text-gray-400">
        {translator.t("run.operationIdLine", { id: row.operationId })}
      </div>
      <div className="mt-0.5 text-[10px] leading-4 text-gray-600">{row.hint}</div>
      {/* U5 5.1：信封侧请求事实单独一行——它与下方逐条运行结局分层，互不覆盖 */}
      {row.requestLine !== null ? (
        <div className="text-[10px] leading-4 text-gray-500">{row.requestLine}</div>
      ) : null}
      {/* U5 5.2：真实等待计时（文本自带口径标注与"计时已停止"，组件不加戏） */}
      {row.wait !== null ? (
        <div className="text-[10px] leading-4 text-gray-500" data-wait-basis={row.wait.basis}>
          {row.wait.text}
        </div>
      ) : null}

      {result === null ? (
        row.runLinks.length > 0 ? (
          <ul className="mt-1 space-y-1">
            {row.runLinks.map((link) => (
              <li key={link.runId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="min-w-0 break-all font-code text-[10px] text-gray-700">
                  {link.runId}
                </span>
                <span className="text-[10px] text-gray-400">{link.note}</span>
              </li>
            ))}
          </ul>
        ) : null
      ) : (
        <div className="mt-1 space-y-1">
          {/* 记录级呈现：执行中 / 本次未接受 / 结果未定位 */}
          {result.kind !== "items" ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${TONE_STYLES.neutral}`}
              >
                {result.label}
              </span>
              <span className="min-w-0 break-all text-[10px] leading-4 text-gray-500">
                {result.detail}
              </span>
            </div>
          ) : null}
          {result.items.map((item) => (
            <div
              key={item.runId}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-gray-100 bg-gray-50/60 px-1.5 py-1"
            >
              <span className="min-w-0 break-all font-code text-[10px] text-gray-700">
                {item.runId}
              </span>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${TONE_STYLES[item.tone]}`}
              >
                {item.label}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {item.actions.map((action) => (
                  <RowActionButton
                    key={action}
                    action={action}
                    identity={{
                      epoch: row.epoch,
                      operationId: row.operationId,
                      runId: item.runId,
                    }}
                    onAct={onAct}
                  />
                ))}
              </div>
              {item.detail !== null ? (
                <div className="w-full break-all text-[10px] leading-4 text-gray-500">
                  {item.detail}
                </div>
              ) : null}
              {/* U6 4.6：来源警告与运行结局分层——ownOnly 的"正常结束"不得被读成可重跑 */}
              {item.sourceWarning !== null ? (
                <div
                  data-result-source-warning="true"
                  className="w-full break-all text-[10px] leading-4 text-amber-800"
                >
                  {item.sourceWarning}
                </div>
              ) : null}
              {/* 拿不到自有失败调用时只说明，不给入口：不跳祖先、不跳"最后一个调用"凑数 */}
              {item.failureNote !== null ? (
                <div className="w-full break-all text-[10px] leading-4 text-gray-400">
                  {item.failureNote}
                </div>
              ) : null}
            </div>
          ))}
          {result.canReturnDraft ? (
            <div className="flex items-center gap-1">
              <RowActionButton
                action="return-draft"
                identity={{ epoch: row.epoch, operationId: row.operationId, runId: "" }}
                onAct={onAct}
              />
            </div>
          ) : null}
          {result.draftNote !== null ? (
            <div className="break-all text-[10px] leading-4 text-gray-400">{result.draftNote}</div>
          ) : null}
        </div>
      )}

      {row.experimentId !== null ? (
        <div className="mt-0.5 break-all font-code text-[10px] text-gray-400">
          {translator.t("run.experimentLine", { id: row.experimentId })}
        </div>
      ) : null}
      {/* U5 5.1：受控诊断从"只报条数"改为可读列表——main 侧已脱敏限长，这里原样列出 */}
      {row.diagnostics.length > 0 ? (
        <details className="mt-0.5">
          <summary
            className={`cursor-pointer text-[10px] leading-4 text-gray-500 ${FOCUS_RING}`}
            title={translator.t("run.diagnosticTitle")}
          >
            {translator.t("run.diagnosticSummary", { count: row.diagnostics.length })}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {row.diagnostics.map((diagnostic, index) => (
              <DiagnosticLine
                key={`${diagnostic.stage}/${diagnostic.code}/${index}`}
                diagnostic={diagnostic}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}
