import type { SpanLine } from "@rebaseagent/trace-sdk";
import { buildSpanTree, findStepLlm, spanDurationMs } from "@shared/derive";
import type { SpanNode } from "@shared/derive";
import type { ForkCapabilityResult, ModelAbResult, ModelArmPlan, RunDetail } from "@shared/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { presentStepDetail, resolveIoView } from "../lib/call-detail-view";
import { isModelAbDraftDirty, newArmRowKey } from "../lib/debugging-drafts";
import type { CallDraftField, CallDraftKey, ModelAbDraftKey } from "../lib/debugging-drafts";
import { draftBadgeForSpan } from "../lib/draft-list";
import {
  captureCallDraftSource,
  revalidateCallDraftSource,
  revalidateModelAbDraftSource,
} from "../lib/draft-source";
import { deriveEntryGate } from "../lib/entry-gate";
import type { EntryGate } from "../lib/entry-gate";
import {
  abDisclosure,
  decidePlanFreshness,
  disclosureLines,
  messagesDisclosure,
  modelConfigStampOf,
  promptDisclosure,
  resultIsolatedDisclosure,
  resultPlainDisclosure,
} from "../lib/execution-confirmation";
import type { ForkCacheHint } from "../lib/fork-cache-hint";
import { forkCacheHint } from "../lib/fork-cache-hint";
import { formatDuration, prettyJson } from "../lib/format";
import {
  isIsolatedRun,
  isolatedCheckpointLabel,
  isolatedContinueLabel,
  isolatedParentExecutionNotice,
  resolveCapabilityCheck,
  resolveIsolatedForkSubmission,
} from "../lib/isolated-fork";
import { modelAbGuard, riskyToolNames, scalarRequestParams } from "../lib/model-ab";
import type { ArmDraft, Scalar } from "../lib/model-ab";
import { promptForkGuard } from "../lib/prompt-fork";
import type { PromptForkField } from "../lib/prompt-fork";
import { decideRestore, initialRestoreState, restoreIdentity } from "../lib/restore-gate";
import { resolveRestoreScrollTop, resolveScrollRestore } from "../lib/scroll-restore";
import { useEscapeClose } from "../lib/use-escape-close";
import { useRevokeOnConfigChange } from "../lib/use-revoke-on-config-change";
import { validateCheckpointStepId } from "../lib/workspace-files";
import { readingScrollOf } from "../lib/workspace-selection";
import { useAppStore } from "../store";
import { BudgetMap } from "./BudgetMap";
import { requestConfirm } from "./ConfirmDialog";
import { ConfirmationBlock } from "./ConfirmationBlock";
import { DetailNotices } from "./DetailNotices";
import { DraftCompareGrid } from "./DraftCompareGrid";
import { DraftSourceBanner } from "./DraftSourceBanner";
import { EntryGateNotice } from "./EntryGateNotice";
import { isLongTextExpanded, toggleLongTextExpanded } from "./LongText";
import { MonacoCodeEditor } from "./MonacoEditor";
import { WorkspaceHeading } from "./WorkspaceHeading";
import {
  ForkCacheHintView,
  IsolatedParentUnsupportedNotice,
  KeyValue,
  RunDraftListSection,
  Section,
} from "./detail/DetailShared";
import { LlmCallDetailView } from "./detail/LlmCallDetail";
import { StepDetailView } from "./detail/StepDetailView";
import { ToolInvokeDetailView } from "./detail/ToolInvokeDetail";

// 兼容导出：原入口导出指向同一实现（design D1，S01）。新消费方应直接用 detail/* 模块。
export {
  CacheHitRow,
  ForkCacheHintView,
  ISOLATED_PARENT_UNSUPPORTED_KEY,
  IsolatedParentUnsupportedNotice,
} from "./detail/DetailShared";
export { LlmCallDetailView } from "./detail/LlmCallDetail";
export { StepDetailView } from "./detail/StepDetailView";
export { ToolInvokeDetailView } from "./detail/ToolInvokeDetail";

/** 从请求消息中取首条字符串 system / user 消息内容（与 replay 层定位规则同源） */
function startupContents(messages: ReadonlyArray<{ role: unknown; content?: unknown }>): {
  system: string | null;
  user: string | null;
} {
  let system: string | null = null;
  let user: string | null = null;
  for (const message of messages) {
    if (system === null && message.role === "system" && typeof message.content === "string") {
      system = message.content;
    }
    if (user === null && message.role === "user" && typeof message.content === "string") {
      user = message.content;
    }
    if (system !== null && user !== null) break;
  }
  return { system, user };
}

/**
 * prompt fork 编辑器（runs:promptFork 写通道）：
 * 编辑首次 llm.call 启动上下文中的 system prompt 或首条 user message，
 * 确认后从头重跑（独立新轨迹，不共享父前缀）。
 * 一次只改一个变量；空 fork、未配置、缺字符串 system 消息均在本地拦截。
 */

function PromptForkEditor({
  span,
  run,
}: {
  span: Extract<SpanLine, { kind: "llm.call" }>;
  run: RunDetail;
}) {
  const forking = useAppStore((s) => s.forking);
  const forkError = useAppStore((s) => s.forkError);
  const forkErrorCode = useAppStore((s) => s.forkErrorCode);
  const settings = useAppStore((s) => s.settings);
  const promptFork = useAppStore((s) => s.promptFork);
  const resetFork = useAppStore((s) => s.resetFork);
  const ensureCallDraft = useAppStore((s) => s.ensureCallDraft);
  const writeCallDraftText = useAppStore((s) => s.writeCallDraftText);
  // 源记录不可用时禁用依赖它的执行（任务 3.5）：旧内容仍可见，但不得据此获得执行资格
  const sourceExecutable = useAppStore((s) => s.canExecuteFromSource)();

  const { system: originalSystem, user: originalUser } = startupContents(span.request.messages);
  const [field, setField] = useState<PromptForkField>("system_prompt");
  const [open, setOpen] = useState(false);

  /**
   * U3 任务 2.2：两个 prompt 字段各自独立草稿（相同 span ID 不同字段不串草稿）。
   * - 打开/切字段经 `ensureCallDraft` 登记该字段基线：已存在条目原样保留，
   *   **字段切换保留独立值、重开不覆盖已有输入**；
   * - 源基线（任务 1.4）随条目落库，恢复重验在 2.5/2.6 接入；
   * - 关闭编辑与设置往返不删草稿（关闭 ≠ 放弃）。
   */
  const draftSource = useMemo(() => captureCallDraftSource(run, span), [run, span]);
  const draftKeyOf = (f: PromptForkField): CallDraftKey => ({
    runId: run.meta.id,
    spanId: span.id,
    field: f,
  });
  const ensureFieldDraft = useCallback(
    (f: PromptForkField): void => {
      const baseline = f === "system_prompt" ? (originalSystem ?? "") : (originalUser ?? "");
      ensureCallDraft({ runId: run.meta.id, spanId: span.id, field: f }, baseline, draftSource);
    },
    [originalSystem, originalUser, ensureCallDraft, run.meta.id, span.id, draftSource],
  );

  // U3 任务 3.4：待定提交冻结该字段草稿（store 侧同时拒绝写入/放弃）
  const draftFrozen = useAppStore((s) => s.isDraftFrozen(draftKeyOf(field)));
  const beginDraftSubmission = useAppStore((s) => s.beginDraftSubmission);
  // U5 任务 4.6：prompt 的执行前确认（同一份凭据与执法点，见 lib/execution-confirmation）
  const currentConfirmationBinding = useAppStore((s) => s.currentConfirmationBinding);
  const armExecutionConfirmation = useAppStore((s) => s.armExecutionConfirmation);
  // U3 任务 3.4：待定提交期间视同进行中——输入、放弃、关闭、提交一并禁用
  const inProgress = forking === "in_progress" || draftFrozen;
  // U4 任务 4.4：入口可用性从统一操作槽派生（只拦"再发一条"，不锁输入与放弃）
  const gate = deriveEntryGate(useAppStore((s) => s.operations));
  const original = field === "system_prompt" ? originalSystem : originalUser;
  const activeEntry = useAppStore((s) => s.callDraftOf(draftKeyOf(field)));
  // 草稿已登记 ⇒ 读该字段草稿；未登记（尚未打开/切换到）⇒ 退回该字段原值
  const value = activeEntry !== undefined ? activeEntry.text : (original ?? "");
  const unchanged = original === null || value === original;

  // U3 任务 2.5：草稿列表的定位目标到达即打开对应字段（ensure 幂等；重开不覆盖）
  const pending = useAppStore((s) => s.pendingDraftTarget);
  const consumeDraftTarget = useAppStore((s) => s.consumeDraftTarget);
  const discardCallDraft = useAppStore((s) => s.discardCallDraft);
  useEffect(() => {
    if (pending === null) return;
    if (pending.runId !== run.meta.id || pending.spanId !== span.id) return;
    if (pending.field !== "system_prompt" && pending.field !== "user_message") return;
    ensureFieldDraft(pending.field);
    setField(pending.field);
    setOpen(true);
    consumeDraftTarget();
  }, [pending, consumeDraftTarget, ensureFieldDraft, run, span]);

  // U3 任务 2.5/1.4：恢复重验——源缺失/损坏/改变/资格失效 ⇒ 保留草稿、禁止执行
  const sourceVerdict =
    activeEntry === undefined
      ? null
      : revalidateCallDraftSource({
          runId: run.meta.id,
          spanId: span.id,
          field,
          baseline: activeEntry.baseline,
          source: activeEntry.source,
          detail: run,
        });
  const sourceBlocked = sourceVerdict?.kind === "blocked" ? sourceVerdict : null;

  const guard = promptForkGuard({
    field,
    hasSystem: originalSystem !== null,
    hasUser: originalUser !== null,
    settingsConfigured: settings?.configured === true,
    unchanged,
  });
  // 提交闸门 = 既有单步条件 ∧ 源记录可用（源不可用时"能编辑"不等于"能执行"）
  //           ∧ 恢复重验通过（U3 2.5：源缺失/损坏/改变/资格失效都拦）
  //           ∧ 已核对本次从头重跑（U5 4.6：确认凭据，判据在 lib/execution-confirmation.ts）
  const promptBinding = currentConfirmationBinding("prompt", draftKeyOf(field));
  const promptConfirmed = useAppStore((s) => s.executionConfirmationReady(promptBinding));
  const canSubmit =
    guard.canSubmit && sourceExecutable && sourceBlocked === null && promptConfirmed;
  const submitBlocked = !guard.canSubmit
    ? guard.reason
    : !sourceExecutable
      ? "源记录不可用：重新读取并校验通过前不能发起新执行"
      : null;

  const switchField = (next: PromptForkField): void => {
    // 目标字段草稿未登记时登记（已存在则原样保留）⇒ 字段切换保留各自独立值
    ensureFieldDraft(next);
    setField(next);
    resetFork();
  };

  /**
   * U3 任务 2.6：按修订明确放弃——**只影响当前字段**（另一字段及其他运行不受影响，
   * 各字段是独立草稿键）；确认核对当前内容，CAS 拒绝旧确认删除新修订。
   * 清空为零长度的变更同样是 dirty，一样要经此确认。
   */
  const discardCurrentField = (): void => {
    if (activeEntry === undefined || inProgress) return;
    const snapshot = activeEntry;
    const fieldLabel = field === "system_prompt" ? "system prompt" : "首条 user message";
    // U3 5.2：异步模态确认；CAS 按请求时的快照修订校验（确认期间修订推进 ⇒ 放弃不执行）
    void requestConfirm({
      title: `放弃 prompt 草稿 · ${fieldLabel}`,
      message: `放弃「prompt fork · ${fieldLabel}」的草稿？（run ${run.meta.id} · ${span.id}）\n\n当前草稿内容：\n${snapshot.text}\n\n只影响这一个字段；放弃按确认时的修订校验：此后内容若被更新，本次放弃不会执行。`,
    }).then((confirmed) => {
      if (!confirmed) return; // 取消：逐字保留
      if (discardCallDraft(draftKeyOf(field), snapshot.revision)) {
        resetFork();
        setOpen(false);
      }
    });
  };

  // U3 任务 6.10（design D7）：Esc 收起与「取消」按钮同动作（保留草稿，不等于放弃）
  useEscapeClose(open && !inProgress, () => {
    resetFork();
    setOpen(false);
  });

  if (!open) {
    const unavailable = originalSystem === null;
    return (
      <div className="border-t border-emerald-100 px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              resetFork();
              switchField("system_prompt");
              setOpen(true);
            }}
            disabled={unavailable || inProgress}
            title={
              unavailable ? "首次 llm.call 缺少字符串 system 消息，prompt fork 不可用" : undefined
            }
            className="rounded bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            编辑 system prompt 重跑
          </button>
          <button
            type="button"
            onClick={() => {
              resetFork();
              switchField("user_message");
              setOpen(true);
            }}
            disabled={unavailable || inProgress}
            title={
              unavailable ? "首次 llm.call 缺少字符串 system 消息，prompt fork 不可用" : undefined
            }
            className="rounded border border-emerald-500 px-2 py-1 text-[11px] text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            编辑初始 user message 重跑
          </button>
        </div>
        {unavailable ? (
          <div className="mt-1 text-[11px] text-gray-400">
            首次 llm.call 缺少字符串形式的 system 消息，无法重建运行配置，prompt fork 不可用。
          </div>
        ) : (
          <div className="mt-1 text-[11px] text-gray-400">
            prompt fork：修改启动上下文后从头重跑（独立新轨迹，不共享父前缀）。一次只改一项。
          </div>
        )}
      </div>
    );
  }

  const doSubmit = (): void => {
    if (!canSubmit) return;
    // U3 任务 3.4：原子登记提交关联（key + 修订 + 快照），提交值取自快照；
    // 已有待定提交时拒绝重复提交。收尾由 store 执行函数负责（卸载不解冻）。
    // U5 4.6：旧的原生确认对话框换成"就地核对 + 一次性确认凭据"——登记口是执法点，
    // 确认不成立（改了字段、换了设置、离开过现场）就直接拒绝，一次 IPC 都不发。
    const assoc = beginDraftSubmission({
      channel: "prompt",
      target: draftKeyOf(field),
      confirmation: promptBinding,
    });
    if (assoc === null) return;
    void promptFork(run.meta.id, { field, value: assoc.submittedText }, assoc);
  };

  return (
    <div className="border-t border-emerald-100 bg-emerald-50/60 px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-emerald-900">prompt fork · 从头重跑</span>
        <div className="flex items-center gap-1">
          {(["system_prompt", "user_message"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => {
                switchField(f);
              }}
              disabled={inProgress}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                field === f
                  ? "bg-emerald-600 text-white"
                  : "border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-100"
              }`}
            >
              {f === "system_prompt" ? "system prompt" : "首条 user message"}
            </button>
          ))}
        </div>
      </div>
      {/* U3 任务 2.6：原值（只读）/草稿（可编辑）就近核对。
          UI 密度 2.2：并排/上下按实测容器宽决策，原值可收起且恢复入口常驻（DraftCompareGrid）。 */}
      <DraftCompareGrid
        compareKey="prompt"
        draftTone="emerald"
        original={
          <MonacoCodeEditor
            height="100%"
            data-monaco-host="prompt-original"
            data-monaco-target={`${run.meta.id}:${span.id}:${field}`}
            language="plaintext"
            value={original ?? ""}
            options={{
              readOnly: true,
              fontSize: 12,
              minimap: { enabled: false },
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              scrollbar: { vertical: "auto" },
              folding: true,
              showFoldingControls: "always",
            }}
            className="overflow-hidden rounded border border-gray-200"
          />
        }
        draft={
          <MonacoCodeEditor
            height="100%"
            data-monaco-host="prompt-draft"
            data-monaco-target={`${run.meta.id}:${span.id}:${field}`}
            language="plaintext"
            value={value}
            onChange={(next) => writeCallDraftText(draftKeyOf(field), next ?? "")}
            options={{
              readOnly: inProgress,
              fontSize: 12,
              minimap: { enabled: false },
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              scrollbar: { vertical: "auto" },
              folding: true,
              showFoldingControls: "always",
            }}
            className="overflow-hidden rounded border border-emerald-200"
          />
        }
      />
      {/* UI 整理 4.3（design D5）：确认块外的重复说明与独立原因条已收敛——
          目标 / 改动字段 / 费用 / 边界的摘要收起仍可见（ConfirmationBlock summary），
          详细边界展开可读（disclosureLines）；资格原因的主位置是确认块 blocked 行，
          这里不再重复挂一条。 */}

      {sourceBlocked !== null && activeEntry !== undefined ? (
        <DraftSourceBanner
          reason={sourceBlocked.reason}
          copyText={activeEntry.text}
          onDiscard={() => {
            if (activeEntry === undefined) return;
            const snapshot = activeEntry;
            void requestConfirm({
              title: "放弃 prompt 草稿",
              message: `放弃这份 prompt 草稿（${field === "system_prompt" ? "system prompt" : "user message"}）？内容将被删除（不可撤销）。`,
            }).then((confirmed) => {
              if (!confirmed) return;
              if (discardCallDraft(draftKeyOf(field), snapshot.revision)) {
                resetFork();
                setOpen(false);
              }
            });
          }}
        />
      ) : null}

      {draftFrozen ? (
        <div className="mt-2 rounded border border-emerald-200 bg-emerald-100/60 px-2 py-1.5 text-[11px] leading-4 text-emerald-900">
          本次提交待处理：已按提交时的修订冻结这个字段的草稿，请求返回前不可修改或放弃。
          另一字段与其他运行不受影响；无论成功、业务拒绝还是失败，草稿都保留。
        </div>
      ) : null}

      {forking === "error" ? (
        <div className="mt-1 text-[11px] text-red-700">
          {forkError}
          {forkErrorCode === "SETTINGS_NOT_CONFIGURED"
            ? "（请先点击右上角“运行配置”填写 baseURL/apiKey/model）"
            : ""}
        </div>
      ) : null}

      <EntryGateNotice gate={gate} />

      {/*
       * U5 任务 4.6：prompt 的**核对本次从头重跑**。措辞由 `promptDisclosure` 给：
       * 从头执行、不共享父前缀、一次只改一个启动字段、父 run 只作对照。
       * 资格不足时（未配置 / 源不可用 / 恢复重验未过）把原因显示在确认区里，
       * 不是只把按钮禁掉让人猜。
       * UI 密度 3.1（design D4）：核对块此前嵌在按钮 flex 行里横排挤压——改为
       * 共享确认块（关键摘要收起时仍可见、详细边界可展开），提交按钮行紧随其下。
       */}
      {(() => {
        const disclosure = promptDisclosure({
          parentRunId: run.meta.id,
          fieldLabel:
            field === "system_prompt" ? "System Prompt（启动 system 消息）" : "首个 user 消息",
          oldValue: original ?? "",
          newValue: value,
          modelSummary: `${settings?.model ?? "（未配置模型）"}${
            settings?.baseURL ? ` @ ${settings.baseURL}` : ""
          }`,
          rebuildable: originalSystem !== null,
        });
        return (
          <ConfirmationBlock
            title="核对本次从头重跑"
            tone="emerald"
            summary={disclosure.summary}
            rows={disclosureLines(disclosure)}
            confirmed={promptConfirmed}
            confirmDisabled={
              inProgress ||
              !guard.canSubmit ||
              !sourceExecutable ||
              sourceBlocked !== null ||
              !gate.canSubmit
            }
            onConfirm={() => armExecutionConfirmation(promptBinding)}
            confirmLabel="已核对，确认从头重跑"
            confirmedLabel="已确认从头重跑"
            blocked={promptConfirmed ? null : submitBlocked}
            controlsId={`prompt-confirm-details-${run.meta.id}-${span.id}`}
          />
        );
      })()}

      <div className="mt-2 flex items-center justify-end gap-2">
        {inProgress ? (
          <span className="text-[11px] text-emerald-600">重跑中…（真实 LLM 调用，可能耗时）</span>
        ) : null}
        <button
          type="button"
          onClick={discardCurrentField}
          disabled={inProgress || unchanged}
          title={unchanged ? "尚无修改可放弃" : "放弃这个字段的草稿（需确认；只影响当前字段）"}
          className={`mr-auto rounded border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
            unchanged
              ? "border-gray-200 text-gray-300"
              : "border-amber-400 text-amber-800 hover:bg-amber-50"
          }`}
        >
          放弃修改
        </button>
        <button
          type="button"
          onClick={() => writeCallDraftText(draftKeyOf(field), original ?? "")}
          disabled={inProgress || original === null}
          className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          恢复原值
        </button>
        <button
          type="button"
          onClick={() => {
            resetFork();
            setOpen(false);
          }}
          disabled={inProgress}
          className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          onClick={doSubmit}
          disabled={inProgress || !canSubmit || !gate.canSubmit}
          className="rounded bg-emerald-600 px-3 py-1 text-[11px] text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          确认从头重跑
        </button>
      </div>
    </div>
  );
}

/** llm.call 详情：完整请求 + 响应（思维链与正文分区）；代理 run 提供编辑重发 */
function LlmCallDetail({
  span,
  run,
}: { span: Extract<SpanLine, { kind: "llm.call" }>; run: RunDetail | null }) {
  const { request, response, error } = span;
  const leafOwned = run?.leafSpanIds.includes(span.id) ?? false;
  const isProxy = run?.meta.source?.kind === "proxy";
  const canResend = isProxy === true && leafOwned && run?.status === "completed";
  // U8 5.1b：就地编辑器已迁 messages 工作区——步骤页只留**入口**（同一草稿键、
  // 同一目标身份，不是第二份表单状态）；SDK run / 未封存 / 非自有调用不给入口。
  const openMessagesWorkspace = useAppStore((s) => s.openMessagesWorkspace);

  /**
   * 长文本块的展开状态按 run + 调用隔离存会话（任务 3.6）。
   *
   * 键用**稳定字段名**（"error" / "reasoning" / "content" / "tool_calls" / `msg:<序号>` /
   * "tools" / "params"），不用数组下标或渲染顺序——否则重读后块的位置一变，恢复就串了。
   * 消息项用其在 request.messages 里的序号（design D6：不可变记录内的序号）。
   */
  const runId = run?.meta.id ?? null;
  const expandedSections = useAppStore((s) =>
    runId === null || s.selectedRunId !== runId
      ? undefined
      : s.readingOf(runId).calls[span.id]?.expanded,
  );
  /**
   * 输入/输出切换（任务 5.5 · design D6 的 `CallReadingState.io`）。
   *
   * 与展开状态同存一处（`readingByRun[runId].calls[spanId]`）——切换是**阅读位置**的一种，
   * 切走再回来要恢复用户看的那半。`undefined` = 没切过 ⇒ 按 `defaultIoView` 定默认。
   */
  const ioState = useAppStore((s) =>
    runId === null || s.selectedRunId !== runId ? undefined : s.readingOf(runId).calls[span.id]?.io,
  );
  const setCallReading = useAppStore((s) => s.setCallReading);
  const io = resolveIoView(span, ioState);
  const longTextProps = (
    key: string,
  ): { expanded: boolean; onToggle: (next: boolean) => void } => ({
    expanded: isLongTextExpanded(expandedSections, key),
    onToggle: () => {
      if (runId === null) return;
      // 只翻转目标键的开关，`next` 由 store 里的当前值推导——受控组件不自己猜状态
      setCallReading(runId, span.id, {
        expanded: toggleLongTextExpanded(expandedSections, key),
      });
    },
  });

  /**
   * 空正文文案：失败 / 仅有工具调用 / 仅有思维链 / 真空正文 四态。
   * 旧实现一律写"无正文，仅有工具调用"——对失败调用与 reasoning-only 成功响应都是错的。
   */
  const emptyContentHint =
    error !== undefined
      ? "（调用失败，无响应正文）"
      : response.tool_calls.length > 0
        ? "（无正文，仅有工具调用）"
        : response.reasoning_content !== null
          ? "（无正文，仅有思维链）"
          : "（响应为空正文）";

  // U3 任务 2.5：该调用的会话草稿标记（徽章数据从草稿仓库派生，useMemo 保引用稳定）
  const drafts = useAppStore((s) => s.drafts);
  const llmDraftBadge = useMemo(
    () => (runId === null ? null : draftBadgeForSpan(drafts, runId, span.id)),
    [drafts, runId, span.id],
  );

  return (
    <LlmCallDetailView
      span={span}
      io={io}
      onIo={(next) => {
        if (runId === null) return;
        setCallReading(runId, span.id, { io: next });
      }}
      emptyContentHint={emptyContentHint}
      longTextProps={longTextProps}
      draftBadge={llmDraftBadge}
    >
      {(() => {
        // prompt fork 入口：仅限首次 llm.call（启动上下文的事实源）。
        // 代理 run 在录制侧已补 config_hash 时与引擎 run 同判据（不再无条件排除 proxy）；
        // 无 hash 的代理 run 不显示编辑器（服务端 loadForkParent 按缺因兜底）。
        const forkEntriesAvailable =
          run !== null &&
          run.status === "completed" &&
          run.meta.config_hash !== undefined &&
          leafOwned;
        const firstLlmId = run?.spans.find((s) => s.kind === "llm.call")?.id;
        if (!forkEntriesAvailable || run === null) return null;
        if (firstLlmId === span.id) {
          // 隔离父本：两个入口都禁用并说明原因（内核对同一批请求也拒绝，见 1.2 的用例）。
          // UI 密度 change 1.3：原因改为「紧凑一行 + 可展开详情」——不适用这一事实常驻，
          // 完整原因（为什么/内核同样拒绝/可用方式）收进共享 Disclosure 机制，可查询。
          if (isolatedParentExecutionNotice(run) !== null) {
            return <IsolatedParentUnsupportedNotice run={run} />;
          }
          return (
            <>
              <PromptForkEditor key={span.id} span={span} run={run} />
              {/* U8 3.1b：模型 A/B 编辑器迁往实验工作区（运行级「更多操作」入口进入；
                  步骤页不再挂第二份编辑表单——同一草稿键、同一执行通道，不存在两份配置真相）。
                  隔离 notice 的文案里保留 A/B 字样（门禁事实不变）。 */}
            </>
          );
        }
        return (
          <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
            prompt fork 与模型 A/B 只从首次 llm.call 的启动上下文出发；打开首次 llm.call（
            {firstLlmId}）使用编辑入口。
          </div>
        );
      })()}

      {canResend && run !== null ? (
        /* U8 5.1b：MessagesForkEditor 已迁 messages 编辑工作区（design D1：原详情
            不另养一份编辑器）。入口按钮打开工作区并显式绑定目标（runId + spanId）；
            「SDK run 无此入口」由 canResend 的 source.kind 门槛承担。 */
        <div className="border-t border-sky-100 px-4 py-2">
          <button
            type="button"
            data-messages-workspace-entry
            onClick={() => openMessagesWorkspace({ runId: run.meta.id, spanId: span.id })}
            className="rounded bg-sky-600 px-2 py-1 text-[11px] text-white hover:bg-sky-700"
          >
            编辑 messages 重发
          </button>
          <div className="mt-1 text-[11px] text-gray-400">
            在 messages 编辑工作区打开：单请求级分叉 · 源 run 不会被修改 · 重发使用最近捕获的 key
          </div>
        </div>
      ) : isProxy && run !== null && run.status === "crashed" ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          该 run 运行中断（未封存），不允许作为重发起点。
        </div>
      ) : null}
    </LlmCallDetailView>
  );
}

/** 当前 tool.invoke 的"模型所见的返回文本"（与 derive/run-loop 组合公式一致） */
function toolMessageText(span: Extract<SpanLine, { kind: "tool.invoke" }>): string {
  if (span.error !== null) return `工具执行失败：${span.error}`;
  const result = span.result;
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  return prettyJson(result);
}

/** Monaco 语言嗅探：内容可解析为 JSON 用 json，否则纯文本 */
function detectResultLanguage(text: string): "json" | "plaintext" {
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "plaintext";
  }
}

/**
 * tool.invoke 的"在此重跑"编辑器：改 result → 确认 → runs:fork（唯一写通道）。
 *
 * 两条路径，由父 run 是否隔离决定（`meta.workspace` 有无，不靠界面猜）：
 * - 普通父 run：单步确认（既有行为不变）
 * - 隔离父 run：**两段式** —— 先「校验续跑条件」（只读预检，取父 run/本地轮号/step/
 *   轮末检查点/附件规模），再在确认区勾选**本次**副本写入后提交。确认区的每个数字
 *   都来自预检结论，渲染层不自己数文件、不自己推轮号。
 */
function ForkEditor({
  span,
  run,
}: {
  span: Extract<SpanLine, { kind: "tool.invoke" }>;
  run: RunDetail;
}) {
  const forking = useAppStore((s) => s.forking);
  const forkError = useAppStore((s) => s.forkError);
  const forkErrorCode = useAppStore((s) => s.forkErrorCode);
  const forkAt = useAppStore((s) => s.forkAt);
  const resetFork = useAppStore((s) => s.resetFork);
  const loadForkCapability = useAppStore((s) => s.loadForkCapability);
  const settings = useAppStore((s) => s.settings);
  const ensureCallDraft = useAppStore((s) => s.ensureCallDraft);
  const writeCallDraftText = useAppStore((s) => s.writeCallDraftText);
  const discardCallDraft = useAppStore((s) => s.discardCallDraft);
  const pending = useAppStore((s) => s.pendingDraftTarget);
  const consumeDraftTarget = useAppStore((s) => s.consumeDraftTarget);
  const [open, setOpen] = useState(false);
  /**
   * U3 任务 2.1：输入改读写 store 草稿（普通/隔离共用同一 key 与保留规则——
   * 同一组件、同一 `runId + spanId + "result"` 身份）。
   * - 步骤页签/运行往返、关闭编辑与设置往返都不删草稿（卸载只丢临时 UI 状态）；
   * - 重开经 `ensureCallDraft` 登记基线：已存在条目原样保留，**不覆盖已有输入**；
   * - 源基线（任务 1.4 `captureCallDraftSource`）随条目落库，恢复重验在 2.5/2.6 接入。
   */
  const draftKey: CallDraftKey = useMemo(
    () => ({ runId: run.meta.id, spanId: span.id, field: "result" }),
    [run.meta.id, span.id],
  );
  const draftEntry = useAppStore((s) => s.callDraftOf(draftKey));
  // U3 任务 3.4：待定提交冻结该草稿（store 侧同时拒绝写入/放弃）；冻结与编辑器挂载无关
  const draftFrozen = useAppStore((s) => s.isDraftFrozen(draftKey));
  const beginDraftSubmission = useAppStore((s) => s.beginDraftSubmission);
  // U5 任务 4.4：普通 result 的**执行前确认**（隔离路径的预检确认属 §4.5，仍是既有流程）。
  // 现场确认绑定由 store 现取（修订与设置快照组件传不进旧值），判据在
  // `lib/execution-confirmation.ts`；store 的登记口在确认不成立时直接拒绝登记。
  const currentConfirmationBinding = useAppStore((s) => s.currentConfirmationBinding);
  const armExecutionConfirmation = useAppStore((s) => s.armExecutionConfirmation);
  const restartExecutionCheck = useAppStore((s) => s.restartExecutionCheck);

  // 隔离续跑的本次确认状态：全部是**组件局部**状态——每次打开对话框重新开始，
  // 不从父 trace 的 write_authorized 标注或上一次编辑继承任何授权。
  // U3 任务 3.1：预检结论绑定**确认时的草稿修订**（请求代次）——恢复编辑器（组件
  // 重挂）、内容变化、离开编辑流程都会让它失效，返回后必须重新预检。
  const [verified, setVerified] = useState<{
    revision: number | null;
    value: string;
    result: ForkCapabilityResult;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<{ code: string; message: string } | null>(null);
  const [writesAuthorized, setWritesAuthorized] = useState(false);
  // U5 任务 5.3：模型配置变了（设置往返保存成功）⇒ "本次副本写入"授权作废——
  // 授权绑的是当时那台上游；确认/检查代次走 setSettingsSection 进出（4.4），两路互补。
  useRevokeOnConfigChange(modelConfigStampOf(settings), () => setWritesAuthorized(false));
  // U6 任务 4.10：来源撤销令牌——详情重读为 ownOnly、或 main 以来源类稳定码拒绝后，
  // 旧 capability 结果与本次副本写入授权作废，恢复须重新预检（草稿正文保留）。
  const sourceRevocation = useAppStore((s) => s.sourceRevocation);
  useRevokeOnConfigChange(sourceRevocation, () => {
    setVerified(null);
    setWritesAuthorized(false);
  });

  const isolated = isIsolatedRun(run);

  // 父 run 在该 step 录制的模型（共享查表，与 main 侧 fork 编排同一实现）
  const parentModel = useMemo(
    () => findStepLlm(run.spans, span.id)?.request.model ?? null,
    [run.spans, span.id],
  );
  const configModel = settings?.model ?? null;
  // 只有 tool_result 分叉共享前缀，缓存提示才有意义（prompt fork / 代理 messages 分叉不加）。
  // 判据与文案都在 lib 纯函数里，本组件只负责"说不说这句话"。
  const cacheHint = forkCacheHint({ kind: "tool-result", parentModel, configModel });

  const original = toolMessageText(span);
  // 草稿条目已登记（正常打开路径必经 ensure）⇒ 读草稿；未登记（未点开过）⇒ 退回原值。
  // 编辑同步落 store：onChange 每次键入都写入，不靠 debounce / 失焦 / 卸载。
  const value = draftEntry !== undefined ? draftEntry.text : original;
  const unchanged = value === original;
  // U3 任务 3.4：待定提交期间视同进行中——输入、放弃、关闭、提交一并禁用
  const inProgress = forking === "in_progress" || draftFrozen;

  // U3 任务 2.5：草稿列表的定位目标到达即打开（ensure 幂等；重开不覆盖已有输入）
  useEffect(() => {
    if (pending === null) return;
    if (pending.runId !== run.meta.id || pending.spanId !== span.id || pending.field !== "result") {
      return;
    }
    ensureCallDraft(draftKey, toolMessageText(span), captureCallDraftSource(run, span));
    setOpen(true);
    consumeDraftTarget();
  }, [pending, consumeDraftTarget, ensureCallDraft, draftKey, run, span]);

  // U3 任务 2.5/1.4：恢复重验——源缺失/损坏/改变/资格失效 ⇒ 保留草稿、禁止执行
  const sourceVerdict =
    draftEntry === undefined
      ? null
      : revalidateCallDraftSource({
          runId: run.meta.id,
          spanId: span.id,
          field: "result",
          baseline: draftEntry.baseline,
          source: draftEntry.source,
          detail: run,
        });
  const sourceBlocked = sourceVerdict?.kind === "blocked" ? sourceVerdict : null;
  // 语言依据原始文本初探一次（避免编辑过程中语言选项来回闪变）
  const language = useMemo(() => detectResultLanguage(original), [original]);

  const settingsConfigured = settings?.configured === true;
  // 预检结论必须与当前编辑值同源：改过内容即作废（在飞的请求用值比对兜底，不会显示旧结论）。
  // U3 任务 3.1：再加**修订绑定**——仅值相同不放行（改走又改回同一文本也不复活旧结论），
  // 修订推进（任何内容变化事件）即失效，恢复/离开后（verified 为组件局部态已重置）必须重新预检。
  const draftRevision = draftEntry !== undefined ? draftEntry.revision : null;
  const capability =
    verified !== null && verified.value === value && verified.revision === draftRevision
      ? verified.result
      : null;
  const check = resolveCapabilityCheck({
    parentRunId: run.meta.id,
    atSpanId: span.id,
    value,
    unchanged,
    settingsConfigured,
    capabilityInFlight: checking,
    forking: inProgress,
  });
  // 隔离路径的提交判据与请求同源（含"本次授权"）；普通路径沿用既有单步条件
  const submission = resolveIsolatedForkSubmission({
    parentRunId: run.meta.id,
    atSpanId: span.id,
    value,
    unchanged,
    settingsConfigured,
    capabilityInFlight: checking,
    forking: inProgress,
    capability,
    writesAuthorized,
  });
  const canSubmit = isolated ? submission.ok : !unchanged;
  // 源记录不可用时禁用依赖它的执行（任务 3.5）：先决条件同样拦住"预检"这个只读动作，
  // 因为它已经把源记录当成可执行父本（源都不在了，预检结论没有意义）。
  const sourceExecutable = useAppStore((s) => s.canExecuteFromSource)();
  // U3 任务 2.5：恢复重验未通过（源缺失/损坏/改变/资格失效）⇒ 一并拦提交与预检
  // U4 任务 4.3：入口可用性从**统一操作槽**派生（main 槽 / 通信未知 / 关闭 / 配置变更 /
  // 本地尚未确认的提交），不再只看本地 forking。⚠️ 只拦"提交"，不拦只读的能力预检——
  // 预检按 spec 不占主动槽，占槽期间照常可用。
  const gate = deriveEntryGate(useAppStore((s) => s.operations));
  const executionBinding = currentConfirmationBinding("result", draftKey);
  const executionConfirmed = useAppStore((s) => s.executionConfirmationReady(executionBinding));
  // U5 4.4：普通路径再叠一道"已核对本次目标与边界"的确认；隔离路径仍走既有预检 + 本次授权
  const canFork =
    canSubmit && executionConfirmed && sourceExecutable && sourceBlocked === null && gate.canSubmit;
  const checkAllowed = check.ok && sourceExecutable && sourceBlocked === null;
  // 提示语：源不可用优先（它同时也会让 check 失配，但原因不同，不能互相冒充）
  const checkBlockReason = !sourceExecutable
    ? "源记录不可用：重新读取并校验通过前不能发起新执行"
    : check.ok
      ? null
      : check.reason;

  const resetLocal = (): void => {
    resetFork();
    setVerified(null);
    setChecking(false);
    setCheckError(null);
    setWritesAuthorized(false);
  };

  /**
   * U3 任务 2.6：按修订明确放弃（design D3）——确认明确目标并核对当前内容；
   * 取消逐字保留；确认只删除本目标（draftKey 单一字段）。放弃以**确认时看到的
   * 修订**做 CAS：确认后内容被更新 ⇒ 拒绝删除（旧确认不作数），界面随 store
   * 显示当前内容，须重新核对。清空为零长度的变更同样要经此确认（dirty 判据）。
   */
  const discardCurrent = (): void => {
    if (draftEntry === undefined || inProgress) return;
    const snapshot = draftEntry;
    // U3 5.2：异步模态确认；CAS 按请求时的快照修订校验
    void requestConfirm({
      title: "放弃工具结果草稿",
      message: `放弃这份工具结果草稿？（run ${run.meta.id} · ${span.id}）\n\n当前草稿内容：\n${snapshot.text}\n\n放弃按确认时的修订校验：此后内容若被更新，本次放弃不会执行。`,
    }).then((confirmed) => {
      if (!confirmed) return; // 取消：逐字保留
      if (discardCallDraft(draftKey, snapshot.revision)) {
        resetLocal();
        setOpen(false);
      }
    });
  };

  const doCheck = (): void => {
    if (!checkAllowed) return;
    // U5 任务 4.5：重新启动只读预检 ⇒ 推进检查代次并作废既有确认
    // （旧预检的响应不能给新一次执行安装确认，判据在 `lib/execution-confirmation.ts`）
    restartExecutionCheck(draftKey);
    const requestedValue = check.request.edit.value;
    // U3 任务 3.1：记录**确认时的草稿修订**（请求代次）——响应按它校验
    const requestedRevision = draftRevision;
    setChecking(true);
    setCheckError(null);
    void loadForkCapability(check.request)
      .then((outcome) => {
        if (!outcome.ok) {
          setCheckError({ code: outcome.code, message: outcome.message });
          setVerified(null);
          return;
        }
        // U3 任务 3.1：守卫迟到预检——响应到达时草稿修订已推进（内容已变）
        // ⇒ 不安装旧结论（不给修改后的草稿安装旧预检）。
        const currentRevision = useAppStore.getState().callDraftOf(draftKey)?.revision ?? null;
        if (currentRevision !== requestedRevision) return;
        setVerified({ revision: requestedRevision, value: requestedValue, result: outcome.data });
      })
      .finally(() => setChecking(false));
  };

  // U3 任务 6.10（design D7）：Esc 收起与「取消」按钮同动作（保留草稿，不等于放弃）
  useEscapeClose(open && !inProgress, () => {
    resetLocal();
    setOpen(false);
  });

  if (!open) {
    return (
      <div className="border-t border-violet-100 px-4 py-2">
        <button
          type="button"
          onClick={() => {
            resetLocal();
            // 登记草稿基线 + 源基线（已存在条目原样保留——重开不覆盖已有输入）
            ensureCallDraft(draftKey, original, captureCallDraftSource(run, span));
            setOpen(true);
          }}
          className="rounded bg-violet-600 px-2 py-1 text-[11px] text-white hover:bg-violet-700"
        >
          {isolated ? "在此重跑（隔离续跑）" : "在此重跑（时间旅行）"}
        </button>
        {isolated ? (
          <div className="mt-1 text-[11px] leading-4 text-violet-600">
            隔离续跑：从该工具所在轮次结束后继续（整轮一起续跑，该轮工具不重做）；父 run、源目录与
            兄弟分支都不会被修改。
          </div>
        ) : (
          /* 3.4（design D5）：「时间旅行」只描述"从这一步重跑"的定位，不扩大恢复承诺——
             期间真实执行过的外部调用不撤回、同轮工具的写入不回滚，两句话都直说。 */
          <div className="mt-1 text-[11px] leading-4 text-violet-600">
            时间旅行：从该工具调用之后重跑这一步，结果写入新分支。它不是"恢复世界"——
            期间真实执行过的外部调用不撤回，同轮工具的写入也不回滚。
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-violet-100 bg-violet-50/60 px-4 py-3">
      <div className="mb-1">
        <WorkspaceHeading
          title={
            <span className="text-reading-meta text-violet-900">
              {isolated ? "在此重跑 · 隔离续跑" : "在此重跑"}
            </span>
          }
          target={
            <span className="font-code">
              {span.tool} · {span.id}
            </span>
          }
          summary={
            <span className="text-violet-600">
              {isolated
                ? "从轮末检查点继续 · 父 run 与源目录不会被修改"
                : "从该工具调用之后重跑 · 父 run 文件不会被修改"}
            </span>
          }
          detailsLabel="重跑说明"
          details={
            <p className="py-1 text-reading-meta leading-5 text-violet-600">
              {isolated
                ? "以上文本将作为该工具的返回结果重新送入模型；其后的步骤由模型重新生成，文件世界从该轮轮末检查点继续。"
                : "以上文本将作为该工具的返回结果重新送入模型；其余上下文（prompt、工具表、此前步骤）与父 run 完全一致。"}
            </p>
          }
        />
      </div>
      {/* U3 任务 2.6：原值（只读）/草稿（可编辑）就近核对——两侧都完整可读
          （Monaco wordWrap 不截断），不为对比固定挤占窄窗。
          UI 密度 2.3：result 编辑器沿用 2.2 同一空间策略（DraftCompareGrid）。 */}
      <DraftCompareGrid
        compareKey="tool-result"
        draftTone="violet"
        original={
          <MonacoCodeEditor
            height="100%"
            data-monaco-host="tool-result-original"
            data-monaco-target={`${run.meta.id}:${span.id}:tool_result`}
            language={language}
            value={original}
            options={{
              readOnly: true,
              fontSize: 12,
              minimap: { enabled: false },
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              scrollbar: { vertical: "auto" },
              folding: true,
              showFoldingControls: "always",
            }}
            className="overflow-hidden rounded border border-gray-200"
          />
        }
        draft={
          <MonacoCodeEditor
            height="100%"
            data-monaco-host="tool-result-draft"
            data-monaco-target={`${run.meta.id}:${span.id}:tool_result`}
            language={language}
            value={value}
            onChange={(next) => {
              // 输入同步写入 store 草稿（实际内容变化才推进修订）
              writeCallDraftText(draftKey, next ?? "");
              // 编辑即作废已校验的结论（确认区收起，避免"确认的与提交的不是同一份编辑"）
              setVerified(null);
              // U3 任务 3.1（design D4）：内容变化使本次副本授权失效——授权只用于
              // 当次构造的请求，改了内容必须重新勾选后再预检/提交。
              setWritesAuthorized(false);
            }}
            options={{
              readOnly: inProgress,
              fontSize: 12,
              minimap: { enabled: false },
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              scrollbar: { vertical: "auto" },
              // 折叠箭头常驻 gutter（默认 mouseover 才显示，用户反馈不够直观）
              folding: true,
              showFoldingControls: "always",
            }}
            className="overflow-hidden rounded border border-violet-200"
          />
        }
      />

      {unchanged ? (
        <div className="mt-1 text-[11px] text-amber-700">
          与原始结果相同，请修改后再重跑；未做修改的续跑会被原样拒绝。
        </div>
      ) : null}

      <ForkCacheHintView hint={cacheHint} />

      {sourceBlocked !== null && draftEntry !== undefined ? (
        <DraftSourceBanner
          reason={sourceBlocked.reason}
          copyText={draftEntry.text}
          onDiscard={() => {
            if (draftEntry === undefined) return;
            const snapshot = draftEntry;
            void requestConfirm({
              title: "放弃工具结果草稿",
              message: "放弃这份工具结果草稿？内容将被删除（不可撤销）。",
            }).then((confirmed) => {
              if (!confirmed) return;
              if (discardCallDraft(draftKey, snapshot.revision)) {
                resetLocal();
                setOpen(false);
              }
            });
          }}
        />
      ) : null}

      {isolated ? (
        <div className="mt-2 rounded border border-violet-200 bg-white px-2 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold text-violet-900">
              续跑条件（只读预检：不创建运行、不写文件、不请求模型）
            </span>
            <button
              type="button"
              onClick={doCheck}
              disabled={!checkAllowed}
              className="rounded border border-violet-400 px-2 py-0.5 text-[10px] text-violet-700 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {checking ? "校验中…" : capability !== null ? "重新校验" : "校验续跑条件"}
            </button>
          </div>

          {!checkAllowed && checkBlockReason !== null ? (
            <div className="mt-1 text-[11px] leading-4 text-amber-700">{checkBlockReason}</div>
          ) : null}

          {checkError !== null ? (
            <div className="mt-1 text-[11px] leading-4 text-red-700">
              续跑条件不可用（{checkError.code}）：{checkError.message}
              <div className="mt-0.5 text-red-600">
                不可用原因来自 main 的只读预检；界面不会用"当前目录"或父 run 的历史标注兜底。
              </div>
            </div>
          ) : null}

          {capability !== null ? (
            <div className="mt-1 space-y-1">
              <div className="text-[11px] leading-4 text-violet-900">
                {isolatedContinueLabel(capability)}
                <span className="text-violet-600">
                  （整轮续跑：该轮的其余工具不重做，同轮工具在子运行前缀中各出现一次）
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-gray-700">
                <span>
                  <span className="text-gray-400">父 run</span>{" "}
                  <span className="font-code">{capability.parentId}</span>
                </span>
                <span>
                  <span className="text-gray-400">step</span>{" "}
                  <span className="font-code">{capability.stepSpanId}</span>
                </span>
                <span>
                  <span className="text-gray-400">编辑点</span>{" "}
                  <span className="font-code">{capability.atSpanId}</span>
                </span>
                <span className="font-code">{isolatedCheckpointLabel(capability)}</span>
                <span>
                  <span className="text-gray-400">config_hash</span>{" "}
                  <span className="font-code">{capability.configHash.slice(0, 18)}…</span>
                </span>
              </div>
              <div className="text-[11px] leading-4 text-gray-600">
                真实模型调用：<span className="font-code">{settings?.model ?? "（未配置）"}</span>
                {settings?.baseURL === null || settings?.baseURL === undefined
                  ? ""
                  : ` @ ${settings.baseURL}`}
                ；本操作只请求该模型，不写源目录。
              </div>
              <label className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={writesAuthorized}
                  onChange={(e) => setWritesAuthorized(e.target.checked)}
                  disabled={inProgress}
                  className="mt-0.5 shrink-0"
                />
                <span className="text-[11px] leading-4 text-amber-900">
                  允许本次副本写入
                  <span className="text-amber-700">
                    （默认未选；只对这一次提交有效。父 trace 的 write_authorized 只是历史审计标注——
                    不会从它补授权，重新打开也要重新勾选）
                  </span>
                </span>
              </label>
            </div>
          ) : null}

          {/*
           * U5 任务 4.5：隔离路径的**核对本次续跑**。上面那块已经把预检事实列全了
           * （直接父 / 轮号 / 检查点 / config_hash），这里只补两份别处没有的内容：
           * "这次到底做过哪些检查"与"本次执行的边界"（不重做本轮其余工具、不撤销原写入、
           * 副本授权只本次有效）。确认按钮要求**预检结论 + 本次授权**都在场——
           * 没有预检就没有边界可核对，界面上也不假称检查过。
           * UI 密度 3.1（design D4）：换共享确认块——关键摘要收起仍可见、详细边界
           * 默认收进详情；缺预检结论的原因就近显示。
           *（"事实"与"结论"两处都由 `lib/execution-confirmation.ts` 生成，顺序与措辞不同处不写第二份。）
           */}
          {(() => {
            const isolatedDisclosure = resultIsolatedDisclosure({
              toolName: span.kind === "tool.invoke" ? span.tool : null,
              oldValue: original,
              newValue: value,
              modelSummary: `${settings?.model ?? "（未配置模型）"}${
                settings?.baseURL ? ` @ ${settings.baseURL}` : ""
              }`,
              writesAuthorized,
              precheck:
                capability === null
                  ? null
                  : {
                      parentId: capability.parentId,
                      stepSpanId: capability.stepSpanId,
                      atSpanId: capability.atSpanId,
                      checkpointLabel: isolatedCheckpointLabel(capability),
                      continueLabel: isolatedContinueLabel(capability),
                      configHash: capability.configHash,
                    },
            });
            return (
              <ConfirmationBlock
                title="核对本次续跑"
                tone="violet"
                summary={isolatedDisclosure.summary}
                rows={disclosureLines(isolatedDisclosure)}
                confirmed={executionConfirmed}
                confirmDisabled={
                  inProgress ||
                  executionConfirmed ||
                  capability === null ||
                  !writesAuthorized ||
                  !canSubmit ||
                  !sourceExecutable ||
                  sourceBlocked !== null ||
                  !gate.canSubmit
                }
                onConfirm={() =>
                  armExecutionConfirmation(currentConfirmationBinding("result", draftKey))
                }
                confirmLabel="已核对，确认本次续跑"
                confirmedLabel="已确认本次续跑"
                blocked={
                  executionConfirmed || capability !== null
                    ? null
                    : "还没拿到只读预检结论：先点上方「校验续跑条件」，确认要核对的就是那份结论。"
                }
                controlsId={`result-isolated-confirm-details-${run.meta.id}-${span.id}`}
              />
            );
          })()}
        </div>
      ) : null}

      {isolated && !submission.ok && submission.reason !== null ? (
        <div className="mt-1 text-[11px] leading-4 text-amber-700">{submission.reason}</div>
      ) : null}

      {!isolated
        ? /*
           * U5 任务 4.4：普通 result 的**核对本次重跑**（就地展开，不再叠一层大模态）。
           * 内容全部来自 `resultPlainDisclosure`：本次目标、原/新值、模型与前缀，
           * 以及"确实做过哪些检查 / 这次执行的边界"；没有独立预检接口这件事直说。
           * UI 密度 3.1（design D4）：换共享确认块——关键摘要收起仍可见，
           * facts/checks/limits 全表默认收进详情。
           */
          (() => {
            const plainDisclosure = resultPlainDisclosure({
              parentRunId: run.meta.id,
              atSpanId: span.id,
              toolName: span.tool,
              oldValue: original,
              newValue: value,
              parentModel,
              configModel,
            });
            return (
              <ConfirmationBlock
                title="核对本次重跑"
                tone="gray"
                summary={plainDisclosure.summary}
                rows={disclosureLines(plainDisclosure)}
                confirmed={executionConfirmed}
                confirmDisabled={
                  inProgress ||
                  executionConfirmed ||
                  !canSubmit ||
                  !sourceExecutable ||
                  sourceBlocked !== null ||
                  !gate.canSubmit
                }
                onConfirm={() =>
                  armExecutionConfirmation(currentConfirmationBinding("result", draftKey))
                }
                confirmLabel="已核对，确认本次重跑"
                confirmedLabel="已确认本次重跑"
                blocked={null}
                controlsId={`result-plain-confirm-details-${run.meta.id}-${span.id}`}
              />
            );
          })()
        : null}

      <EntryGateNotice gate={gate} />

      {draftFrozen ? (
        <div className="mt-2 rounded border border-violet-200 bg-violet-50 px-2 py-1.5 text-[11px] leading-4 text-violet-800">
          本次提交待处理：已按提交时的修订冻结这份草稿，请求返回前不可修改或放弃。
          无论成功、业务拒绝还是失败，草稿都先保留；按可信身份核实到正常结束、
          且草稿修订与提交时逐字相同，才自动清理（U5 §2/§3 已接线）。
        </div>
      ) : null}

      {forking === "error" ? (
        <div className="mt-1 text-[11px] text-red-700">
          {forkError}
          {forkErrorCode === "SETTINGS_NOT_CONFIGURED"
            ? "（请先点击右上角“运行配置”填写 baseURL/apiKey/model）"
            : ""}
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-end gap-2">
        {inProgress ? (
          <span className="text-[11px] text-violet-600">重跑中…（真实 LLM 调用，可能耗时）</span>
        ) : null}
        <button
          type="button"
          onClick={discardCurrent}
          disabled={inProgress || unchanged}
          title={unchanged ? "尚无修改可放弃" : "放弃这份草稿（需确认；按当前修订校验）"}
          className={`mr-auto rounded border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
            unchanged
              ? "border-gray-200 text-gray-300"
              : "border-amber-400 text-amber-800 hover:bg-amber-50"
          }`}
        >
          放弃修改
        </button>
        <button
          type="button"
          onClick={() => {
            resetLocal();
            setOpen(false);
          }}
          disabled={inProgress}
          className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => {
            // 隔离路径的提交判据不成立 ⇒ 不发请求，也不冻结草稿
            if (isolated && !submission.ok) return;
            // U3 任务 3.4：先原子登记提交关联（取 key + 修订 + 请求快照），提交值取自快照；
            // 已有待定提交时拒绝重复提交。收尾由 store 执行函数负责（卸载不解冻）。
            const assoc = beginDraftSubmission({
              channel: "result",
              target: draftKey,
              // U5 4.4：普通路径带现场确认（不成立 ⇒ store 拒绝登记 ⇒ 一次 IPC 都不发）
              confirmation: executionBinding,
            });
            if (assoc === null) return;
            if (isolated && submission.ok) {
              void forkAt(
                submission.request.parentRunId,
                submission.request.atSpanId,
                assoc.submittedText,
                submission.request.execution,
                assoc,
              );
              return;
            }
            void forkAt(run.meta.id, span.id, assoc.submittedText, undefined, assoc);
          }}
          disabled={inProgress || !canFork}
          className="rounded bg-violet-600 px-3 py-1 text-[11px] text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          确认重跑
        </button>
      </div>
    </div>
  );
}

/** tool.invoke 详情：入参、结果、错误（错误是数据，不改变 run 状态）＋ 分叉入口 */
function ToolInvokeDetail({
  span,
  run,
}: {
  span: Extract<SpanLine, { kind: "tool.invoke" }>;
  run: RunDetail | null;
}) {
  const leafOwned = run?.leafSpanIds.includes(span.id) ?? false;
  // 分叉点必须是当前 run 自身段的 tool.invoke，且 run 已封存（crashed 前缀不稳定）
  const canFork = leafOwned && run?.status === "completed";

  // 长文本展开状态按 run + 调用隔离存会话（任务 3.6，与 LlmCallDetail 同一口径）
  const toolRunId = run?.meta.id ?? null;
  const toolExpandedSections = useAppStore((s) =>
    toolRunId === null || s.selectedRunId !== toolRunId
      ? undefined
      : s.readingOf(toolRunId).calls[span.id]?.expanded,
  );
  const setToolCallReading = useAppStore((s) => s.setCallReading);
  // U3 任务 2.5：该调用的会话草稿标记（徽章数据从草稿仓库派生，useMemo 保引用稳定）
  const drafts = useAppStore((s) => s.drafts);
  const toolDraftBadge = useMemo(
    () => (toolRunId === null ? null : draftBadgeForSpan(drafts, toolRunId, span.id)),
    [drafts, toolRunId, span.id],
  );
  const toolLongTextProps = (key: string): { expanded: boolean; onToggle: () => void } => ({
    expanded: isLongTextExpanded(toolExpandedSections, key),
    onToggle: () => {
      if (toolRunId === null) return;
      setToolCallReading(toolRunId, span.id, {
        expanded: toggleLongTextExpanded(toolExpandedSections, key),
      });
    },
  });

  return (
    <ToolInvokeDetailView
      span={span}
      longTextProps={toolLongTextProps}
      draftBadge={toolDraftBadge}
      compact
    >
      {canFork && run !== null ? (
        <ForkEditor span={span} run={run} />
      ) : span.kind === "tool.invoke" && run !== null && !leafOwned && run.chain.length > 1 ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          该调用位于祖先前缀（继承自父 run），不属于当前 run 自身段——打开其所属 run 才可在此重跑。
        </div>
      ) : run !== null && leafOwned && run.status === "crashed" ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          该 run 运行中断（未封存），不允许作为分叉起点。
        </div>
      ) : null}
    </ToolInvokeDetailView>
  );
}

export function DetailPanel({
  focusActive = false,
  focusControlsInHeader = false,
  onEnterFocus,
  onExitFocus,
}: {
  /** UI 密度 2.4：专注编辑态（App 层按当前工作区身份比对生效；显示覆盖，不写偏好） */
  readonly focusActive?: boolean;
  readonly focusControlsInHeader?: boolean;
  readonly onEnterFocus?: (mode: "edit" | "diff") => void;
  readonly onExitFocus?: () => void;
}) {
  const detail = useAppStore((s) => s.detail);
  const selectedSpanId = useAppStore((s) => s.selectedSpanId);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const loadingDetail = useAppStore((s) => s.loadingDetail);
  const detailScrollTop = useAppStore((s) =>
    s.selectedRunId === null ? 0 : s.readingOf(s.selectedRunId).overviewScrollTop,
  );
  /** 该 run 是否已有阅读条目（区分「没记过」与「记的就是 0」） */
  const runReading = useAppStore((s) =>
    s.selectedRunId === null ? null : (s.readingByRun[s.selectedRunId] ?? null),
  );
  const setReadingScroll = useAppStore((s) => s.setReadingScroll);
  const selectSpan = useAppStore((s) => s.selectSpan);
  const openFileAt = useAppStore((s) => s.openFileAt);

  // 切换 run / 重读 ⇒ 内容身份变化（meta.id + span 指纹）⇒ 重新武装恢复窗口
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [restore, setRestore] = useState(initialRestoreState);
  const detailKey = detail === null ? null : restoreIdentity(detail);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const decision = decideRestore({
      state: restore,
      detailKey,
      contentReady: detail !== null && !loadingDetail,
      measurable:
        el.clientHeight > 0 &&
        readingScrollOf(runReading ?? {}, "overview", runReading !== null) !== undefined,
    });
    if (!decision.restore) return;
    const top = resolveScrollRestore(detailScrollTop, {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    setRestore(decision.next);
    if (top !== null) el.scrollTop = top;
  }, [detailKey, detail, loadingDetail, detailScrollTop, restore, runReading]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (el === null || selectedRunId === null) return;
    // 未完成布局时不记录（此刻 scrollTop 恒为 0，会把记住的位置抹掉）
    if (resolveRestoreScrollTop(el.scrollTop, el) === null) return;
    setReadingScroll(selectedRunId, "overview", el.scrollTop);
  };

  const span = useMemo(
    () => detail?.spans.find((s) => s.id === selectedSpanId) ?? null,
    [detail, selectedSpanId],
  );

  /**
   * 选中的 step 在 span 树里的节点（任务 5.5）。
   *
   * ⚠️ 必须从**树**里取节点而不是直接拿 span：step 详情要列它的直接子调用、并让
   *    `deriveStepStats` 算子树消耗——这些都只有 `SpanNode` 有，`SpanLine` 没有。
   *    树缺失（detail 未加载）时为 null，分支自然回落到"尚未选择"。
   */
  const stepNode = useMemo(() => {
    if (detail === null || span === null || span.kind !== "agent.step") return null;
    const roots = buildSpanTree(detail.spans);
    const find = (nodes: SpanNode[]): SpanNode | null => {
      for (const node of nodes) {
        if (node.span.id === span.id) return node;
        const hit = find(node.children);
        if (hit !== null) return hit;
      }
      return null;
    };
    return find(roots);
  }, [detail, span]);

  /**
   * U2 任务 2.3/5.3：步骤页的**自有步骤文件入口**。
   *
   * ⚠️ 这是 5.3 实机暴露的真实缺口：`store.openFileAt`（一次性显式文件目标）写好了、
   *    `WorkspaceFilesPanel` 也接好了消费端，但**全仓没有任何调用方** ⇒ spec 场景
   *    「显式文件定位覆盖历史」的 WHEN「用户从当前运行的自有步骤打开该轮文件」在界面上
   *    根本不可达（又一个"能力断言不钉接线"的复发）。
   *
   * 判据必须与选择器同源（`validateCheckpointStepId(...) === "valid"` = 该 step 是本 run
   * 的自有完成步骤）：祖先步骤 / 已删轮次 / 拼错 id 一律**不给入口**，否则就是
   * delta 明令禁止的"把祖先当本 run 检查点"。
   */
  const openStepFiles = useMemo(() => {
    if (detail === null || span === null || span.kind !== "agent.step") return null;
    if (validateCheckpointStepId(detail, span.id) !== "valid") return null;
    const runId = detail.meta.id;
    const stepSpanId = span.id;
    return () => openFileAt(runId, { stepSpanId });
  }, [detail, span, openFileAt]);

  // 步骤页 = 详情提示区 + 主区正文。
  // ⚠️ 文件页**不在这里**：U1 6.1 已把它上提为工作区一级承载（`WorkspaceFilesPanel`），
  //    由 App 在 `files` 页签挂载。此前这里是 `tab === "files"` 的内部分支，但那个
  //    `tab` 是**组件局部 useState**、从不与 store 的工作区页签同步 ⇒ 点工作区的
  //    「文件」页签时这里仍是 trajectory，文件视图根本不出现（只读阅读路径断裂）。
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-white">
      {/* 2.4 专注编辑：显示覆盖（收起草稿列表与消耗图），不写偏好、目标变化由 App 层清空 */}
      {focusActive && !focusControlsInHeader ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-violet-200 bg-violet-50 px-3 py-1"
          data-focus-bar="edit"
        >
          <span className="text-[11px] font-medium text-violet-900">
            专注编辑 · 草稿列表与消耗图已临时收起（选择与阅读状态不变，退出后按原布局恢复）
          </span>
          <button
            type="button"
            data-exit-focus="true"
            onClick={onExitFocus}
            className="ml-auto rounded border border-violet-300 bg-white px-2 py-0.5 text-[11px] text-violet-900 hover:bg-violet-100"
          >
            退出专注
          </button>
        </div>
      ) : null}
      {!focusActive && !focusControlsInHeader && onEnterFocus !== undefined ? (
        <div className="shrink-0 border-b border-gray-100 px-3 py-1">
          <button
            type="button"
            data-enter-focus="edit"
            onClick={() => onEnterFocus("edit")}
            title="临时收起草稿列表与消耗图，把空间让给编辑区（退出后按原布局恢复）"
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
          >
            专注编辑
          </button>
        </div>
      ) : null}
      <DetailNotices />
      {!focusActive && selectedRunId !== null ? (
        <RunDraftListSection runId={selectedRunId} />
      ) : null}

      <div ref={scrollRef} className="flex-1 overflow-y-auto pb-8" onScroll={handleScroll}>
        {!focusActive && detail !== null ? (
          <BudgetMap key={detail.meta.id} detail={detail} />
        ) : null}
        {span === null ? (
          <div className="px-4 py-6 text-xs text-gray-500">
            {detail === null ? "尚未选择运行。" : "尚未选择 span。"}
          </div>
        ) : span.kind === "llm.call" ? (
          <LlmCallDetail span={span} run={detail} />
        ) : span.kind === "tool.invoke" ? (
          // key=span.id：切换 span 时重置分叉编辑器的编辑状态
          <ToolInvokeDetail key={span.id} span={span} run={detail} />
        ) : stepNode !== null ? (
          // step 详情（任务 5.5）：已记录调用 + 错误 + 派生消耗，可下钻到原始调用
          <StepDetailView
            key={span.id}
            view={presentStepDetail(stepNode)}
            onOpenCall={(id) => selectSpan(id)}
            onOpenStepFiles={openStepFiles ?? undefined}
          />
        ) : (
          <Section title="步骤概要">
            <KeyValue
              items={[
                ["迭代序号", String(span.n)],
                ["耗时", formatDuration(spanDurationMs(span))],
              ]}
            />
            <div className="mt-2 text-[11px] text-gray-500">
              展开该步骤可查看其下的 LLM 调用与工具执行。
            </div>
          </Section>
        )}
      </div>
    </section>
  );
}
