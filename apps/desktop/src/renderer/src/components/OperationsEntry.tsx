import type { OperationDiagnostic } from "@shared/operations";
import { Waypoints } from "lucide-react";
import { useRef, useState } from "react";
import type { OperationRow } from "../lib/operation-list";
import { deriveOperationRows, hasWatchableOperation, operationBadge } from "../lib/operation-list";
import type { ResultAction } from "../lib/operation-result-view";
import { deriveResultNotices } from "../lib/result-notices";
import type { ResultReadIdentity } from "../lib/result-verification";
import { useEscapeClose } from "../lib/use-escape-close";
import { useWaitClock } from "../lib/use-wait-clock";
import { useAppStore } from "../store";
import { FOCUS_RING } from "./IconButton";

/**
 * U4 任务 4.7 + U5 任务 3.5 / 3.6 / 5.1：全局栏的操作入口。
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

const PHASE_LABELS: Record<OperationRow["phase"], string> = {
  running: "执行中",
  settled: "已收口",
  notAccepted: "未接受",
  unknown: "待核对",
};

/** U5 5.1：与 A/B 批次结果区共用同一套色调（两处各写一份必然分叉） */
export const TONE_STYLES: Record<"neutral" | "success" | "danger" | "warn", string> = {
  neutral: "border-gray-200 bg-gray-50 text-gray-600",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
};

/** U5 5.1：A/B 批次结果区（`AbBatchResultSection`）与本面板共用同一套动作词与色调 */
export const ACTION_LABELS: Record<ResultAction, string> = {
  "open-result": "打开结果",
  "view-failure": "查看失败调用",
  "retry-read": "重读这条结果",
  "return-draft": "返回草稿",
};

const DIAGNOSTIC_STAGE_LABELS: Record<OperationDiagnostic["stage"], string> = {
  execute: "执行",
  identity: "身份登记",
  finalize: "收尾",
  cleanup: "清理",
  rejection: "拒绝",
};

/** 一条受控诊断：码与文案原样列出（main 已脱敏限长），阶段给中文标签便于扫读 */
function DiagnosticLine({ diagnostic }: { diagnostic: OperationDiagnostic }) {
  return (
    <li className="break-all text-[10px] leading-4 text-gray-500">
      〔{DIAGNOSTIC_STAGE_LABELS[diagnostic.stage]}〕{" "}
      <span className="font-code">{diagnostic.code}</span>：{diagnostic.message}
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
  return (
    <button
      type="button"
      onClick={() => {
        onAct(action, identity);
      }}
      title={
        action === "retry-read"
          ? `只按同一个可信运行 ID 重读（${identity.runId}）：不会重新执行，也不会换一条记录试`
          : action === "view-failure"
            ? "只定位本次运行自有的失败调用；祖先里的错误调用不算本次原因"
            : action === "return-draft"
              ? "回到这次提交编辑的那份草稿（许可已复位，需重新检查与授权）"
              : "按可信运行 ID 打开概览（这是用户主动动作，与自动导航的意图判据无关）"
      }
      className={`shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
    >
      {ACTION_LABELS[action]}
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
  const result = row.result;
  return (
    <li className="mt-1 rounded border border-gray-200 bg-white p-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${PHASE_STYLES[row.phase]}`}
        >
          {PHASE_LABELS[row.phase]}
        </span>
        <span className="min-w-0 break-all text-[11px] font-semibold text-gray-800">
          {row.kindLabel ?? "（类型未知）"}
        </span>
        <button
          type="button"
          onClick={() => {
            onReconcile(row.operationId);
          }}
          title={`operations:reconcile(${row.operationId})——只核对操作事实，不读运行文件，也不切页面`}
          className={`ml-auto shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          核对状态
        </button>
      </div>
      <div className="mt-0.5 break-all text-[10px] leading-4 text-gray-500">{row.targetText}</div>
      <div className="break-all font-code text-[10px] leading-4 text-gray-400">
        操作 {row.operationId}
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
          实验 {row.experimentId}
        </div>
      ) : null}
      {/* U5 5.1：受控诊断从"只报条数"改为可读列表——main 侧已脱敏限长，这里原样列出 */}
      {row.diagnostics.length > 0 ? (
        <details className="mt-0.5">
          <summary
            className={`cursor-pointer text-[10px] leading-4 text-gray-500 ${FOCUS_RING}`}
            title="受控诊断：稳定码 + 脱敏限长文案（正文、密钥、授权与源目录凭据从结构上就没有进来的通道）"
          >
            受控诊断 {row.diagnostics.length} 条（不含正文与凭据）
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

export function OperationsEntry() {
  const session = useAppStore((s) => s.operations);
  const reads = useAppStore((s) => s.resultReads);
  const reconcileOperation = useAppStore((s) => s.reconcileOperation);
  const refreshOperationStatus = useAppStore((s) => s.refreshOperationStatus);
  const openOperationResult = useAppStore((s) => s.openOperationResult);
  const openOperationFailure = useAppStore((s) => s.openOperationFailure);
  const returnOperationDraft = useAppStore((s) => s.returnOperationDraft);
  const isOperationDraftPresent = useAppStore((s) => s.isOperationDraftPresent);
  const retryResultRead = useAppStore((s) => s.retryResultRead);
  const seenNoticeKeys = useAppStore((s) => s.seenNoticeKeys);
  const markNoticesSeen = useAppStore((s) => s.markNoticesSeen);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /**
   * U5 任务 5.6：✕ 与 Esc 同一动作——**只关闭查看**，并把焦点还给触发入口
   * （spec「关闭后恢复有效入口」「Esc 只处理最上层」：判据在 `useEscapeClose`，
   * 有真模态在场时面板不消费）。不触达 main 登记、不重发、不核对。
   */
  const closePanel = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // U5 任务 5.2：**唯一时钟**——只在"面板开着 ∧ 会话里有在飞/未确认操作"时走秒；
  // 时长与状态全部由 lib 派生（这里不复算一个判断）。
  useEscapeClose(open, closePanel);
  const nowMs = useWaitClock(open && hasWatchableOperation(session));
  const rows = deriveOperationRows(
    session,
    {
      reads,
      draftPresentOf: (record) =>
        isOperationDraftPresent({ epoch: record.epoch, operationId: record.operationId }),
    },
    { nowMs },
  );
  // 通知是现算派生（3.6）：只存"哪些键看过"，重复快照堆不出第二份
  const notices = deriveResultNotices({
    records: session.operations,
    reads,
    seenKeys: seenNoticeKeys,
  });
  const badge = operationBadge(rows, notices.unreadCount);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open ? "true" : "false"}
        aria-controls="operations-panel"
        onClick={() => {
          // 打开即读一次当前状态（spec：查询可在握手、提交返回、窗口重新获得焦点与用户点击时触发）
          if (!open) void refreshOperationStatus();
          // 展开面板 = 用户此刻已经看到这些结果状态 ⇒ 标成已看（通知本身仍是现算派生）
          markNoticesSeen(notices.notices.map((one) => one.key));
          setOpen((prev) => !prev);
        }}
        title="本会话的主动操作登记（只存主进程内存；关闭应用即清空）"
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded border px-2 py-0.5 text-reading-meta ${
          badge.attention
            ? "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100"
            : "border-gray-300 text-gray-700 hover:bg-gray-50"
        } ${FOCUS_RING}`}
      >
        <Waypoints size={12} aria-hidden="true" focusable="false" role="presentation" />
        {badge.label}
      </button>
      {open ? (
        <div
          id="operations-panel"
          className="absolute right-0 top-full z-40 mt-1 max-h-[min(70vh,24rem)] w-96 max-w-[90vw] overflow-y-auto rounded border border-gray-200 bg-white p-2 shadow-xl"
          aria-describedby="operations-panel-note"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-gray-700">本会话操作</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  void refreshOperationStatus();
                }}
                className={`rounded px-1.5 py-0.5 text-[11px] text-gray-600 hover:bg-gray-100 ${FOCUS_RING}`}
                title="重新读取主进程的操作快照（只读）"
              >
                刷新
              </button>
              <button
                type="button"
                onClick={closePanel}
                className={`rounded px-1 text-[11px] text-gray-400 hover:bg-gray-100 ${FOCUS_RING}`}
                aria-label="关闭操作列表"
              >
                ✕
              </button>
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="px-1 py-2 text-[11px] leading-4 text-gray-500">
              本会话还没有主动操作：新建运行、结果重跑、改提示词、代理重发或模型 A/B
              提交后，会在这里显示真实状态与可信运行 ID。
            </p>
          ) : (
            <ul>
              {rows.map((row) => (
                <OperationRowView
                  key={row.key}
                  row={row}
                  onReconcile={(operationId) => {
                    // 核对：只补这条操作的事实，不切页面、不读运行文件
                    void reconcileOperation(operationId);
                  }}
                  onAct={(action, identity) => {
                    if (action === "open-result") {
                      setOpen(false);
                      void openOperationResult(identity);
                      return;
                    }
                    if (action === "view-failure") {
                      // 拿不到自有失败调用时 store 返回 false ⇒ 面板留着，页面一点不动
                      void openOperationFailure(identity).then((located) => {
                        if (located) setOpen(false);
                      });
                      return;
                    }
                    if (action === "return-draft") {
                      setOpen(false);
                      void returnOperationDraft({
                        epoch: identity.epoch,
                        operationId: identity.operationId,
                      });
                      return;
                    }
                    // 只读重试：面板保持展开，让用户看到这一条从"不可读"变成结论
                    void retryResultRead(identity);
                  }}
                />
              ))}
            </ul>
          )}
          <p id="operations-panel-note" className="mt-2 text-[10px] leading-4 text-gray-400">
            「核对状态」只查操作登记（不读运行文件、不切页面）；结果状态由按可信运行 ID
            的独立读取核实，要看内容请明确点「打开结果」。登记不显示进度或取消按钮——主进程没有这些事实。
          </p>
        </div>
      ) : null}
    </div>
  );
}
