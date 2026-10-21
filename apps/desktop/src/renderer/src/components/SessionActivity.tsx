import { Waypoints } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { type DraftListItem, deriveDraftList, sessionDirtyCountOf } from "../lib/draft-list";
import type { OperationRow } from "../lib/operation-list";
import { deriveOperationRows, hasWatchableOperation } from "../lib/operation-list";
import type { ResultAction } from "../lib/operation-result-view";
import { isRecordingDraftDirty } from "../lib/recording-draft";
import { deriveResultNotices } from "../lib/result-notices";
import type { ResultReadIdentity } from "../lib/result-verification";
import { useEscapeClose } from "../lib/use-escape-close";
import { useWaitClock } from "../lib/use-wait-clock";
import { useAppStore } from "../store";
import { requestConfirm } from "./ConfirmDialog";
import { DraftListPanel } from "./DraftListPanel";
import { FOCUS_RING } from "./IconButton";
import { OperationRowView } from "./OperationsEntry";

/**
 * UI 整理 3.3（delta ADDED「会话活动区区分修改与清洁编辑会话」）：**会话活动入口**。
 *
 * 既有草稿会话入口（原全局栏 SessionDraftsEntry）、全局操作入口（原 OperationsEntry）
 * 与全局结果未读提示的**统一组织**——同一处全局入口，组内分别表达未提交修改、
 * 主动操作及结果待查看，不新增第四个并存入口或第二份状态来源：
 * - 草稿组消费同一 `deriveDraftList`（本运行草稿列表与调用旁标记继续用同一事实）；
 * - 操作组消费同一 `deriveOperationRows` / 操作动作通道（核对/打开/失败定位/返回草稿/重读）；
 * - 结果组消费同一 `deriveResultNotices`（打开面板 = 已看过，语义与原操作入口一致；
 *   polite live 区域仍挂在 App 外壳上，独立于本面板开合）；
 * - 录制未应用修改按 `sessionDirtyCountOf` 并入修改计数（3.4 统一口径）。
 *
 * 位置：App 外壳的**底部单行活动条**（prototype §1.3 决策；窄窗下不与正文争宽）。
 * 面板向上展开；Esc 与 ✕ 同一关闭动作并把焦点还给触发入口（useEscapeClose 纪律）。
 */

export function SessionActivity() {
  const drafts = useAppStore((s) => s.drafts);
  const recordingDraft = useAppStore((s) => s.recordingDraft);
  const openRecordingWorkspace = useAppStore((s) => s.openRecordingWorkspace);
  const openDraftAt = useAppStore((s) => s.openDraftAt);
  const discardCallDraft = useAppStore((s) => s.discardCallDraft);
  const discardModelAbDraft = useAppStore((s) => s.discardModelAbDraft);
  const discardCreateRunDraft = useAppStore((s) => s.discardCreateRunDraft);

  // —— 主动操作 / 结果待查看（与原 OperationsEntry 同一数据面与动作通道）——
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
  const closePanel = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  useEscapeClose(open, closePanel);

  // 唯一时钟：只在"面板开着 ∧ 有在飞/未确认操作"时走秒（与原操作入口同口径）
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
  const notices = deriveResultNotices({
    records: session.operations,
    reads,
    seenKeys: seenNoticeKeys,
  });

  // —— 草稿（3.4：dirty / clean 分组；修改计数含录制未应用修改）——
  const draftItems = useMemo(() => deriveDraftList(drafts), [drafts]);
  const dirtyItems = useMemo(() => draftItems.filter((item) => item.dirty), [draftItems]);
  const cleanItems = useMemo(() => draftItems.filter((item) => !item.dirty), [draftItems]);
  const recordingDirty = recordingDraft !== null && isRecordingDraftDirty(recordingDraft);
  const dirtyCount = sessionDirtyCountOf(drafts, recordingDraft);

  const discardDraftItem = (item: DraftListItem): void => {
    // 与原 SessionDraftsEntry 同一放弃路径：确认后按 CAS（条目修订）删除
    void requestConfirm({
      title: "放弃草稿",
      message: `放弃「${item.title}」的草稿？${item.field === "create" ? "" : `（run ${item.runId}${item.spanId !== null ? ` · ${item.spanId}` : ""}）`}\n内容将被删除，不可撤销。`,
    }).then((confirmed) => {
      if (!confirmed) return;
      if (item.field === "create") {
        discardCreateRunDraft(item.revision);
        return;
      }
      if (item.spanId === null) return;
      if (item.field === "model_ab") {
        discardModelAbDraft({ runId: item.runId, spanId: item.spanId }, item.revision);
        return;
      }
      discardCallDraft(
        {
          runId: item.runId,
          spanId: item.spanId,
          field: item.field,
          ...(item.mode === undefined ? {} : { mode: item.mode }),
        },
        item.revision,
      );
    });
  };

  const attention =
    dirtyCount > 0 ||
    notices.unreadCount > 0 ||
    rows.some((row) => row.phase === "running" || row.phase === "unknown");

  return (
    <div className="relative border-t border-gray-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-1">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open ? "true" : "false"}
          aria-controls="session-activity-panel"
          onClick={() => {
            if (!open) void refreshOperationStatus();
            markNoticesSeen(notices.notices.map((one) => one.key));
            setOpen((prev) => !prev);
          }}
          title="本会话的活动：未提交修改、主动操作与结果待查看（同一处入口，不另设第二份状态）"
          className={`inline-flex cursor-pointer items-center gap-2 rounded border px-2 py-0.5 text-reading-meta ${
            attention
              ? "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100"
              : "border-gray-300 text-gray-700 hover:bg-gray-50"
          } ${FOCUS_RING}`}
        >
          <Waypoints size={12} aria-hidden="true" focusable="false" role="presentation" />
          会话活动
          <span className="inline-flex items-center gap-1.5 font-code text-[10px]">
            <span className={dirtyCount > 0 ? "text-amber-700" : "text-gray-400"}>
              修改 {dirtyCount}
            </span>
            <span className={rows.length > 0 ? "text-sky-700" : "text-gray-400"}>
              操作 {rows.length}
            </span>
            <span className={notices.unreadCount > 0 ? "text-emerald-700" : "text-gray-400"}>
              结果 {notices.unreadCount}
            </span>
          </span>
        </button>
      </div>

      {open ? (
        <div
          id="session-activity-panel"
          className="absolute bottom-full left-0 z-40 mb-1 max-h-[min(70vh,24rem)] w-96 max-w-[90vw] overflow-y-auto rounded border border-gray-200 bg-white p-2 shadow-xl"
          aria-describedby="session-activity-note"
        >
          {/* —— 组一：未提交修改（3.4：dirty 在前，clean 单独分组标为未修改）—— */}
          <section aria-label="未提交修改">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-gray-700">
                需处理的修改{dirtyItems.length > 0 || recordingDirty ? ` · ${dirtyCount}` : ""}
              </span>
            </div>
            {recordingDirty ? (
              <div className="mb-1 flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 text-[11px] text-amber-800">
                录制配置有未应用的修改
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    openRecordingWorkspace();
                  }}
                  className={`ml-auto rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
                >
                  去录制
                </button>
              </div>
            ) : null}
            <DraftListPanel
              items={dirtyItems}
              emptyHint={
                recordingDirty
                  ? "草稿没有待处理的修改；上面的录制配置修改仍在。"
                  : "没有待处理的草稿修改。"
              }
              onOpen={(item) => {
                setOpen(false);
                void openDraftAt({
                  runId: item.runId,
                  spanId: item.spanId,
                  field: item.field,
                  ...(item.mode === undefined ? {} : { mode: item.mode }),
                });
              }}
              onCopy={(item) => {
                void navigator.clipboard.writeText(item.copyText);
              }}
              onDiscard={discardDraftItem}
            />
            {cleanItems.length > 0 ? (
              <>
                <div className="mt-2 mb-1 text-[11px] font-semibold text-gray-500">
                  未修改的编辑会话 · {cleanItems.length}
                </div>
                <DraftListPanel
                  items={cleanItems}
                  emptyHint="没有未修改的编辑会话。"
                  onOpen={(item) => {
                    setOpen(false);
                    void openDraftAt({
                      runId: item.runId,
                      spanId: item.spanId,
                      field: item.field,
                      ...(item.mode === undefined ? {} : { mode: item.mode }),
                    });
                  }}
                  onCopy={(item) => {
                    void navigator.clipboard.writeText(item.copyText);
                  }}
                  onDiscard={discardDraftItem}
                />
              </>
            ) : null}
          </section>

          {/* —— 组二：主动操作（与原操作入口同一列表与动作通道）—— */}
          <section aria-label="主动操作" className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-gray-700">
                本会话操作{rows.length > 0 ? ` · ${rows.length}` : ""}
              </span>
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
            </div>
            {rows.length === 0 ? (
              <p className="px-1 py-2 text-[11px] leading-4 text-gray-500">
                本会话还没有主动操作：新建运行、结果重跑、改提示词、代理重发或模型 A/B
                提交后，会在这里显示真实状态与可信运行 ID。
              </p>
            ) : (
              <ul>
                {rows.map((row: OperationRow) => (
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
          </section>

          {/* —— 组三：结果待查看（未读通知；动作在上方操作行内，导航只经用户明确动作）—— */}
          <section aria-label="结果待查看" className="mt-3">
            <div className="mb-1 text-[11px] font-semibold text-gray-700">
              结果待查看{notices.unreadCount > 0 ? ` · ${notices.unreadCount}` : ""}
            </div>
            {notices.notices.length === 0 ? (
              <p className="px-1 py-1 text-[11px] leading-4 text-gray-500">
                没有待查看的结果通知。
              </p>
            ) : (
              <ul className="space-y-1">
                {notices.notices.map((notice) => (
                  <li
                    key={notice.key}
                    className="break-all rounded border border-gray-100 bg-gray-50/60 px-1.5 py-1 text-[11px] leading-4 text-gray-700"
                  >
                    {notice.text}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p id="session-activity-note" className="mt-2 text-[10px] leading-4 text-gray-400">
            「核对状态」只查操作登记（不读运行文件、不切页面）；要看内容请明确点「打开结果」。
            面板关闭时结果通知仍经 polite live 区域播报，不抢当前页面。草稿不落盘，关闭应用即清空。
          </p>
          <div className="mt-1 text-right">
            <button
              type="button"
              onClick={closePanel}
              className={`rounded px-1 text-[11px] text-gray-400 hover:bg-gray-100 ${FOCUS_RING}`}
              aria-label="关闭会话活动面板"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
