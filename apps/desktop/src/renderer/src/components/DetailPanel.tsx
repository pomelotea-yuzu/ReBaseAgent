import type { SpanLine } from "@rebaseagent/trace-sdk";
import { buildSpanTree, findStepLlm, spanDurationMs } from "@shared/derive";
import type { SpanNode } from "@shared/derive";
import type { ForkCapabilityResult, ModelAbResult, ModelArmPlan, RunDetail } from "@shared/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { presentCacheHit, presentCacheMiss } from "../lib/cache-view";
import type { IoView, StepDetailView as StepDetailViewData } from "../lib/call-detail-view";
import {
  messageContentText,
  optionalSectionVisible,
  presentStepDetail,
  resolveIoView,
} from "../lib/call-detail-view";
import { isModelAbDraftDirty, newArmRowKey } from "../lib/debugging-drafts";
import type { CallDraftField, CallDraftKey, ModelAbDraftKey } from "../lib/debugging-drafts";
import { deriveDraftList, draftBadgeForSpan } from "../lib/draft-list";
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
import { expandedKeysInclude } from "../lib/reading-state";
import { decideRestore, initialRestoreState, restoreIdentity } from "../lib/restore-gate";
import { resolveRestoreScrollTop, resolveScrollRestore } from "../lib/scroll-restore";
import { useEscapeClose } from "../lib/use-escape-close";
import { useRevokeOnConfigChange } from "../lib/use-revoke-on-config-change";
import { validateCheckpointStepId } from "../lib/workspace-files";
import { readingScrollOf } from "../lib/workspace-selection";
import { useAppStore } from "../store";
import { BudgetMap } from "./BudgetMap";
import { requestConfirm } from "./ConfirmDialog";
import { DetailNotices } from "./DetailNotices";
import { Disclosure } from "./Disclosure";
import { DraftCompareGrid } from "./DraftCompareGrid";
import { DraftListPanel } from "./DraftListPanel";
import { DraftSourceBanner } from "./DraftSourceBanner";
import { EntryGateNotice } from "./EntryGateNotice";
import { FOCUS_RING } from "./IconButton";
import { LongText, isLongTextExpanded, toggleLongTextExpanded } from "./LongText";
import { MonacoCodeEditor } from "./MonacoEditor";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-gray-200 px-4 py-3">
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-gray-500">{title}</div>
      {children}
    </div>
  );
}

/**
 * 隔离父本上 prompt fork / 模型 A/B 的「不适用」说明（UI 密度 change 1.3）。
 *
 * 与运行页隔离说明共用同一 `Disclosure` 机制与同一 run 级阅读键
 * （`noticesExpanded`；键 = `isolated-parent-unsupported`）——**不适用**这一事实
 * 常驻一行，完整原因（为什么不支持/内核同样拒绝/可用方式是什么）展开后可查询，
 * 场景「技术元信息按需完整阅读」的 WHEN「不适用能力」落在这一点。
 */
export const ISOLATED_PARENT_UNSUPPORTED_KEY = "isolated-parent-unsupported";

export function IsolatedParentUnsupportedNotice({ run }: { run: RunDetail }) {
  const reason = isolatedParentExecutionNotice(run);
  const runId = useAppStore((s) => s.selectedRunId);
  const expanded = useAppStore((s) =>
    runId === null
      ? false
      : expandedKeysInclude(
          s.readingByRun[runId]?.noticesExpanded,
          ISOLATED_PARENT_UNSUPPORTED_KEY,
        ),
  );
  if (reason === null || runId === null) return null;
  return (
    <div
      data-isolated-parent-unsupported="true"
      className="border-t border-violet-100 px-4 py-1.5 text-[11px] leading-5 text-violet-900"
    >
      <Disclosure
        summary="不适用说明"
        meta="prompt fork / 模型 A/B 在隔离父本上本期不支持"
        expanded={expanded}
        onToggle={() => {
          useAppStore.getState().toggleNoticeExpanded(runId, ISOLATED_PARENT_UNSUPPORTED_KEY);
        }}
        controlsId={`notice-isolated-parent-${runId}`}
      >
        <div className="px-1 pb-1">
          {reason}
          <br />
          可用的执行方式：在某个工具调用上使用「在此重跑（隔离续跑）」——它从该轮的轮末检查点继续。
        </div>
      </Disclosure>
    </div>
  );
}

function KeyValue({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-gray-700">
      {items.map(([k, v]) => (
        <span key={k}>
          <span className="text-gray-400">{k}</span> <span className="font-code">{v}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * 缓存命中行（前缀缓存生效与否的唯一可见证据）。
 *
 * 判据与文案全部来自 `lib/cache-view.ts` 的纯函数 `presentCacheHit`——组件只负责把
 * 结论摆成 DOM。这样做的原因：原先判据内联在组件里，本包无 jsdom ⇒ 改错打不红，
 * 等于没有判据（spec 明写存在性而非 truthiness、`in=0` 不做除法、少量命中不得称全量）。
 */
export function CacheHitRow({
  usage,
}: { usage: Extract<SpanLine, { kind: "llm.call" }>["response"]["usage"] }) {
  const view = presentCacheHit(usage);
  if (view === null) return null;

  const miss = presentCacheMiss(usage);
  const effective = view.tone === "effective";

  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] ${
        effective ? "text-emerald-700" : "text-amber-700"
      }`}
      data-cache-tone={view.tone}
    >
      <span>缓存命中</span>
      <span className="font-code">{view.shownHit}</span>
      {view.percent === null ? null : (
        <span>
          / <span className="font-code">{view.input}</span>（{view.percent}%）
        </span>
      )}
      {miss === null ? null : (
        <span>
          · miss <span className="font-code">{miss}</span>
        </span>
      )}
      <span>{view.verdict}</span>
      {view.abnormalNote === null ? null : (
        <span className="text-red-600">{view.abnormalNote}</span>
      )}
    </div>
  );
}

/**
 * tool_result 分叉编辑器的缓存提示块（纯展示）。
 *
 * 抽成独立导出组件的原因：原先这段是 `ForkEditor`（重度依赖 store）内部的一块 JSX，
 * 本包无 jsdom ⇒ 「提示到底渲染不渲染」在组件层断言不到（把分支改成永不渲染也不会红）。
 * 现在判据在 `lib/fork-cache-hint.ts`、渲染在这里，两层各自可单独喂数据。
 */
export function ForkCacheHintView({ hint }: { hint: ForkCacheHint | null }) {
  if (hint === null) return null;
  return (
    <div className="mt-1 text-[11px] leading-4 text-amber-700" data-fork-cache-hint="tool-result">
      {hint.text}
    </div>
  );
}

/**
 * U3 任务 2.5：步骤页的「本运行草稿列表」（design D2）。
 *
 * 数据来自与全局会话入口**同一份**派生（`deriveDraftList` + runId 过滤）与
 * 同一个 `DraftListPanel` 视图；无草稿时整节不渲染（不加噪音）。
 */
function RunDraftListSection({ runId }: { runId: string }) {
  const drafts = useAppStore((s) => s.drafts);
  const openDraftAt = useAppStore((s) => s.openDraftAt);
  const discardCallDraft = useAppStore((s) => s.discardCallDraft);
  const discardModelAbDraft = useAppStore((s) => s.discardModelAbDraft);
  const items = useMemo(() => deriveDraftList(drafts, { runId }), [drafts, runId]);
  if (items.length === 0) return null;
  return (
    <section
      data-run-draft-list="true"
      className="border-b border-gray-200 bg-gray-50/60 px-4 py-2"
    >
      <div className="mb-1 text-[11px] font-semibold text-gray-600">
        本运行草稿（{items.length}）
      </div>
      <DraftListPanel
        items={items}
        emptyHint="本运行暂无草稿"
        onOpen={(item) => {
          void openDraftAt({ runId: item.runId, spanId: item.spanId, field: item.field });
        }}
        onCopy={(item) => {
          void navigator.clipboard.writeText(item.copyText);
        }}
        onDiscard={(item) => {
          if (item.field === "create") return; // 本运行列表不含创建草稿（防御）
          // U3 5.2：放弃确认走真模态（异步）——CAS 按列表条目修订校验，
          // 确认等待期间修订推进 ⇒ 旧确认不删新修订。
          // field/runId/spanId 先捕获为 const：TS 收窄可以越过异步闭包保留
          const field = item.field;
          const runId = item.runId;
          const spanId = item.spanId;
          void requestConfirm({
            title: "放弃草稿",
            message: `放弃「${item.title}」的草稿？（run ${runId}${spanId !== null ? ` · ${spanId}` : ""}）\n内容将被删除，不可撤销。`,
          }).then((confirmed) => {
            if (!confirmed) return;
            if (field === "model_ab") {
              if (spanId !== null) {
                discardModelAbDraft({ runId, spanId }, item.revision);
              }
              return;
            }
            if (spanId === null) return;
            discardCallDraft({ runId, spanId, field }, item.revision);
          });
        }}
      />
    </section>
  );
}

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
      <div className="mt-1.5 text-[10px] leading-4 text-emerald-700">
        编辑值将替换首次 llm.call 请求中的
        {field === "system_prompt" ? " system prompt" : " 首条 user message"}
        ；新 run 从第 1 步完整执行并记录独立新轨迹。
        {field === "system_prompt" ? "配置指纹（config_hash）将随新值变化。" : ""}
      </div>
      <div className="mt-1 text-[10px] leading-4 text-emerald-600">
        从头重跑，将真实调用模型并计费 · 父 run 只作对照，不会被修改
      </div>

      {submitBlocked !== null ? (
        <div className="mt-1 text-[11px] text-amber-700">{submitBlocked}</div>
      ) : null}

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

      <div className="mt-2 flex items-center justify-end gap-2">
        {/*
         * U5 任务 4.6：prompt 的**核对本次从头重跑**。措辞由 `promptDisclosure` 给：
         * 从头执行、不共享父前缀、一次只改一个启动字段、父 run 只作对照。
         * 资格不足时（未配置 / 源不可用 / 恢复重验未过）把原因显示在确认区里，
         * 不是只把按钮禁掉让人猜。
         */}
        <div className="mt-2 rounded border border-emerald-200 bg-white">
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="text-[11px] font-medium text-gray-600">核对本次从头重跑</span>
            <button
              type="button"
              data-confirm-execution
              aria-pressed={promptConfirmed ? "true" : undefined}
              disabled={
                inProgress ||
                promptConfirmed ||
                !guard.canSubmit ||
                !sourceExecutable ||
                sourceBlocked !== null ||
                !gate.canSubmit
              }
              onClick={() => armExecutionConfirmation(promptBinding)}
              className={`shrink-0 rounded border px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
                promptConfirmed
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              {promptConfirmed ? "已确认从头重跑" : "已核对，确认从头重跑"}
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t border-gray-100 px-2 py-1.5 text-[11px] leading-4">
            {disclosureLines(
              promptDisclosure({
                parentRunId: run.meta.id,
                fieldLabel:
                  field === "system_prompt"
                    ? "System Prompt（启动 system 消息）"
                    : "首个 user 消息",
                oldValue: original ?? "",
                newValue: value,
                modelSummary: `${settings?.model ?? "（未配置模型）"}${
                  settings?.baseURL ? ` @ ${settings.baseURL}` : ""
                }`,
                rebuildable: originalSystem !== null,
              }),
            ).map((row) => (
              <div key={`${row.label}-${row.value}`} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-gray-500">{row.label}</dt>
                <dd className="min-w-0 break-words text-gray-700">{row.value}</dd>
              </div>
            ))}
          </dl>
          {!promptConfirmed && submitBlocked !== null ? (
            <div className="border-t border-gray-100 px-2 py-1.5 text-[11px] leading-4 text-amber-800">
              {submitBlocked}
            </div>
          ) : null}
        </div>

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

/**
 * llm.call 详情的**纯展示**部分（任务 5.5）。
 *
 * 与 store 壳 `LlmCallDetail` 分离的原因：本包无 jsdom、zustand v5 在静态渲染下走
 * `getServerSnapshot`（恒初始值）⇒ 壳喂不进状态。把"数据 → 视图"抽出来，测试才能直接喂
 * `io` / `expandedSections` 钉住「输入输出切换」「思维链与正文分区」这些判据。
 *
 * 两个必须守住的义务：
 *   1. **输入与输出是两半，切换只改看哪半、不丢字段**：输入 = messages/tools/params；
 *      输出 = content/reasoning/tool_calls。两半的分区并集覆盖 spec 点名的全部字段
 *      （`ioCoversAllFields` 把这条变成可断言的对象）。
 *   2. **思维链与正文分区样式不同**（琥珀底 vs 无底），两者内容都完整。
 */
export function LlmCallDetailView({
  span,
  io,
  onIo,
  emptyContentHint,
  longTextProps,
  draftBadge,
  children,
}: {
  span: Extract<SpanLine, { kind: "llm.call" }>;
  io: IoView;
  onIo: (next: IoView) => void;
  emptyContentHint: string;
  longTextProps: (key: string) => { expanded: boolean; onToggle: (next: boolean) => void };
  /** U3 任务 2.5：该调用的会话草稿标记（null = 无草稿） */
  draftBadge?: { label: string; dirty: boolean } | null;
  /** fork / 重发编辑器（由壳提供；纯展示部分不碰它们） */
  children?: React.ReactNode;
}) {
  const { request, response, error } = span;
  // 🔴 失败调用的 usage/ttft 是**占位**（代理录制的失败 llm.call 写 `{in:0,out:0}`
  // 与 ttft_ms=0 表示"没有正文抵达"，不是实测零消耗/零延迟）。delta「代理失败概览
  // 只使用自有已记录诊断」要求：详情展示请求与**占位解释**，不能宣称零成本或成功输出。
  // 所以失败时这三项显示占位文案而不是数字——把 0 印成"0 tokens"会被读成"这次没花钱"。
  const failed = error !== undefined;
  return (
    <>
      <Section title="概要">
        <KeyValue
          items={[
            ["模型", request.model],
            ["输入 tokens", failed ? "未获得（失败调用占位）" : String(response.usage.in)],
            ["输出 tokens", failed ? "未获得（失败调用占位）" : String(response.usage.out)],
            ["首 token 延迟", failed ? "不适用（失败调用无正文抵达）" : `${response.ttft_ms}ms`],
            ["耗时", formatDuration(spanDurationMs(span))],
            ["工具调用", failed ? "不适用（失败调用）" : String(response.tool_calls.length)],
            ...(draftBadge !== null && draftBadge !== undefined
              ? ([["草稿", draftBadge.label]] as Array<[string, string]>)
              : []),
          ]}
        />
        {/* 🔴 缓存命中率同样依赖真实 usage：占位零会让命中率算出一个漂亮的假数字 */}
        {failed ? null : <CacheHitRow usage={response.usage} />}
      </Section>

      {/* 输入/输出切换（任务 5.5）：两半各自完整，切换只是换看哪半 */}
      <div className="flex items-center gap-1 border-t border-gray-200 px-4 py-1.5">
        <span className="mr-1 text-[11px] text-gray-500">查看</span>
        {(["input", "output"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onIo(key)}
            aria-pressed={io === key}
            className={`rounded px-2 py-0.5 text-[11px] ${
              io === key ? "bg-sky-100 font-medium text-sky-900" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {key === "input" ? "输入" : "输出"}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-gray-400">两半内容都完整保留，切换不丢字段</span>
      </div>

      {error !== undefined ? (
        <Section title="错误（调用失败，错误是数据）">
          <div className="rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-red-900">
              <span>调用失败</span>
              {error.status === undefined ? null : (
                <span className="rounded bg-red-100 px-1 font-code">HTTP {error.status}</span>
              )}
            </div>
            <LongText text={error.message} label="错误详情" {...longTextProps("error")} />
            <div className="mt-1 text-[11px] leading-5 text-red-800">
              这是记录于本次调用的失败原因。上列 tokens 与首 token 延迟是
              <span className="font-medium">失败占位零值</span>
              ，不代表实际零消耗或零延迟；请求内容仍可照常查看。
            </div>
          </div>
        </Section>
      ) : null}

      {io === "output" ? (
        <>
          {response.reasoning_content !== null ? (
            <Section title="思维链（reasoning_content）">
              <div className="rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5">
                <LongText
                  text={response.reasoning_content}
                  label="思维链"
                  {...longTextProps("reasoning")}
                />
              </div>
            </Section>
          ) : null}

          <Section title="响应正文">
            {response.content === null || response.content === "" ? (
              <div className="text-[11px] text-gray-400">{emptyContentHint}</div>
            ) : (
              <LongText text={response.content} label="正文" {...longTextProps("content")} />
            )}
          </Section>

          {response.tool_calls.length > 0 ? (
            <Section title={`工具调用（${response.tool_calls.length}）`}>
              <LongText
                text={prettyJson(response.tool_calls)}
                label="tool_calls"
                {...longTextProps("tool_calls")}
              />
            </Section>
          ) : null}
        </>
      ) : (
        <>
          <Section title={`请求消息（${request.messages.length} 条）`}>
            <div className="space-y-2">
              {request.messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className="rounded bg-gray-50 px-2 py-1.5">
                  <div className="mb-1 flex items-center gap-2 text-[10px] text-gray-500">
                    <span className="rounded bg-gray-200 px-1 font-code">{message.role}</span>
                    {typeof message.tool_call_id === "string" ? (
                      <span className="font-code">tool_call_id: {message.tool_call_id}</span>
                    ) : null}
                  </div>
                  <LongText
                    text={messageContentText(message)}
                    label="内容"
                    {...longTextProps(`msg:${index}`)}
                  />
                </div>
              ))}
            </div>
          </Section>

          {optionalSectionVisible(span, "request.tools") ? (
            <Section title={`工具表（${request.tools?.length ?? 0}）`}>
              <LongText
                text={prettyJson(request.tools)}
                label="tools"
                {...longTextProps("tools")}
              />
            </Section>
          ) : null}

          {optionalSectionVisible(span, "request.params") ? (
            <Section title="采样参数">
              <LongText
                text={prettyJson(request.params)}
                label="params"
                {...longTextProps("params")}
              />
            </Section>
          ) : null}
        </>
      )}

      {children}
    </>
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
        ) : null}
      </div>
    );
  }

  return (
    <div className="border-t border-violet-100 bg-violet-50/60 px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-violet-900">
          {isolated ? "在此重跑 · 隔离续跑" : "在此重跑"}
        </span>
        <span className="text-[10px] text-violet-500">
          {isolated
            ? "从轮末检查点继续 · 父 run 与源目录不会被修改"
            : "从该工具调用之后重跑 · 父 run 文件不会被修改"}
        </span>
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
      <div className="mt-1.5 text-[10px] leading-4 text-violet-600">
        {isolated
          ? "以上文本将作为该工具的返回结果重新送入模型；其后的步骤由模型重新生成，文件世界从该轮轮末检查点继续。"
          : "以上文本将作为该工具的返回结果重新送入模型；其余上下文（prompt、工具表、此前步骤）与父 run 完全一致。"}
      </div>

      {unchanged ? (
        <div className="mt-1 text-[11px] text-amber-700">
          编辑值与原始结果相同（空 fork），需修改后再重跑。
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
              <div className="mt-1.5 border-t border-violet-100 pt-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold text-violet-900">核对本次续跑</span>
                  <button
                    type="button"
                    data-confirm-execution
                    aria-pressed={executionConfirmed ? "true" : undefined}
                    disabled={
                      inProgress ||
                      executionConfirmed ||
                      capability === null ||
                      !writesAuthorized ||
                      !canSubmit ||
                      !sourceExecutable ||
                      sourceBlocked !== null ||
                      !gate.canSubmit
                    }
                    onClick={() =>
                      armExecutionConfirmation(currentConfirmationBinding("result", draftKey))
                    }
                    className={`shrink-0 rounded border px-2 py-0.5 text-[10px] disabled:cursor-not-allowed disabled:opacity-40 ${
                      executionConfirmed
                        ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                        : "border-violet-400 text-violet-700 hover:bg-violet-50"
                    }`}
                  >
                    {executionConfirmed ? "已确认本次续跑" : "已核对，确认本次续跑"}
                  </button>
                </div>
                {capability === null ? (
                  <div className="mt-1 text-[11px] leading-4 text-amber-700">
                    还没拿到只读预检结论：先点上方「校验续跑条件」，确认要核对的就是那份结论。
                  </div>
                ) : null}
                <ul className="mt-1 space-y-0.5 text-[11px] leading-4 text-gray-600">
                  {isolatedDisclosure.checks.map((one) => (
                    <li key={`check-${one}`}>已做的检查：{one}</li>
                  ))}
                  {isolatedDisclosure.limits.map((one) => (
                    <li key={`limit-${one}`}>本次边界：{one}</li>
                  ))}
                </ul>
              </div>
            );
          })()}
        </div>
      ) : null}

      {isolated && !submission.ok && submission.reason !== null ? (
        <div className="mt-1 text-[11px] leading-4 text-amber-700">{submission.reason}</div>
      ) : null}

      {!isolated ? (
        /*
         * U5 任务 4.4：普通 result 的**核对本次重跑**（就地展开，不再叠一层大模态）。
         * 内容全部来自 `resultPlainDisclosure`：本次目标、原/新值、模型与前缀，
         * 以及"确实做过哪些检查 / 这次执行的边界"；没有独立预检接口这件事直说。
         */
        <div className="mt-2 rounded border border-gray-200 bg-white">
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="text-[11px] font-medium text-gray-600">核对本次重跑</span>
            <button
              type="button"
              data-confirm-execution
              aria-pressed={executionConfirmed ? "true" : undefined}
              disabled={
                inProgress ||
                executionConfirmed ||
                !canSubmit ||
                !sourceExecutable ||
                sourceBlocked !== null ||
                !gate.canSubmit
              }
              onClick={() =>
                armExecutionConfirmation(currentConfirmationBinding("result", draftKey))
              }
              className={`shrink-0 rounded border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
                executionConfirmed
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : "border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              {executionConfirmed ? "已确认本次重跑" : "已核对，确认本次重跑"}
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t border-gray-100 px-2 py-1.5 text-[11px] leading-4">
            {disclosureLines(
              resultPlainDisclosure({
                parentRunId: run.meta.id,
                atSpanId: span.id,
                toolName: span.tool,
                oldValue: original,
                newValue: value,
                parentModel,
                configModel,
              }),
            ).map((row) => (
              <div key={`${row.label}-${row.value}`} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-gray-500">{row.label}</dt>
                <dd className="min-w-0 break-words text-gray-700">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

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
    <ToolInvokeDetailView span={span} longTextProps={toolLongTextProps} draftBadge={toolDraftBadge}>
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

/**
 * `tool.invoke` 详情的纯展示部分（U1 任务 5.5）。
 *
 * 与壳 `ToolInvokeDetail` 分离的同一理由：本包无 jsdom、zustand v5 静态渲染走
 * `getServerSnapshot`（恒初始值）⇒ 壳喂不进状态。抽出后测试可直接喂 span 钉住
 * 「args 与 result 就近核对」「error 非空显式呈现」「dur_ms 与墙钟耗时都在」。
 *
 * 三条义务：
 *   1. **args / result 就近核对**（spec 原文「工具 args/result SHALL 在同一详情中便于核对」）：
 *      两块**并排**（宽屏）或上下相邻（窄屏），中间只隔一个"结果"标题，不再被其它栏目冲散。
 *   2. **error 非空必须显式呈现**：`span.error !== null`（`null` = 成功，不是"没有错误字段"）。
 *   3. **耗时两个口径都在**：`dur_ms`（工具自身执行）与墙上耗时（`spanDurationMs`，含排队/传输）——
 *      两者不等恰是排查"工具快但整体慢"的关键，不能只留一个。
 */
export function ToolInvokeDetailView({
  span,
  longTextProps,
  draftBadge,
  children,
}: {
  span: Extract<SpanLine, { kind: "tool.invoke" }>;
  longTextProps: (key: string) => { expanded: boolean; onToggle: (next: boolean) => void };
  /** U3 任务 2.5：该调用的会话草稿标记（null = 无草稿） */
  draftBadge?: { label: string; dirty: boolean } | null;
  /** fork / 重跑编辑器（由壳提供） */
  children?: React.ReactNode;
}) {
  return (
    <>
      <Section title="概要">
        <KeyValue
          items={[
            ["工具", span.tool],
            ["执行耗时", `${span.dur_ms}ms`],
            ["墙上耗时", formatDuration(spanDurationMs(span))],
            ...(draftBadge !== null && draftBadge !== undefined
              ? ([["草稿", draftBadge.label]] as Array<[string, string]>)
              : []),
          ]}
        />
      </Section>

      {span.error !== null ? (
        <Section title="错误（错误是数据不是异常）">
          <div className="rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5">
            <LongText text={span.error} label="错误信息" {...longTextProps("error")} />
          </div>
        </Section>
      ) : null}

      {/* args / result 就近核对：并排（宽屏）→ 上下相邻（窄屏），中间不被其它栏目隔开 */}
      <Section title="入参与结果">
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 text-[11px] font-medium text-gray-600">入参</div>
            <LongText text={prettyJson(span.args)} label="args" {...longTextProps("args")} />
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[11px] font-medium text-gray-600">结果</div>
            <LongText text={prettyJson(span.result)} label="result" {...longTextProps("result")} />
          </div>
        </div>
      </Section>

      {children}
    </>
  );
}

/**
 * `agent.step` 详情的纯展示部分（U1 任务 5.5）。
 *
 * spec 原文：「选中 step 时 SHALL 展示其已记录调用、错误及派生消耗」，场景
 * 「长请求和原始字段完整可读」还要求「step 摘要仍可进入每个原始调用」。
 *
 * 三条义务：
 *   1. **三块都要在**（`STEP_FIELDS` = calls / errors / consumption），缺一块就等于
 *      把"有调用/有错误/有消耗"显示成"没有"。
 *   2. **消耗来自 `deriveStepStats`（既有轨迹口径）**：`presentStepDetail` 只做取用，
 *      不另算一遍——否则详情与预算地图必然分叉。
 *   3. **每条已记录调用都可点进原始调用**（`onOpenCall(spanId)`）：step 是目录不是终点，
 *      用户必须能从这里下钻到具体 llm.call / tool.invoke。
 *
 * ⚠️ `errorCount` 只合并**计数**不合并语义：llm 的 error 与 tool 的 error 口径不同
 *    （前者 `undefined` = 未记录，后者 `null` = 成功），此处仅计数用于一眼看"这步有没有出错"。
 */
export function StepDetailView({
  view,
  onOpenCall,
  onOpenStepFiles,
}: {
  view: StepDetailViewData;
  onOpenCall: (spanId: string) => void;
  /**
   * U2 任务 2.3/5.3：**从该步骤打开本 run 这一轮的文件**（design D2「自有步骤的文件入口
   * 提供明确轮末定位」）。`undefined` = 该步骤不是本 run 的自有完成步骤，**不渲染入口**
   * —— 祖先步骤不得提供会"冒充当前运行检查点"的入口（delta 明文）。
   */
  onOpenStepFiles?: () => void;
}) {
  return (
    <>
      <Section title="步骤概要">
        {onOpenStepFiles === undefined ? null : (
          <div className="mb-1">
            <button
              type="button"
              onClick={onOpenStepFiles}
              className="rounded border border-violet-300 bg-violet-50 px-2 py-0.5 text-[11px] text-violet-800 hover:bg-violet-100"
            >
              打开该轮文件
            </button>
            <div className="mt-0.5 text-[10px] leading-4 text-gray-500">
              定位到本 run 该轮结束的文件检查点（不是历史检查点，也不借用父 run 的快照）。
            </div>
          </div>
        )}
        <KeyValue
          items={[
            ["迭代序号", String(view.iteration)],
            ["已记录调用", String(view.calls.length)],
            ["其中错误", String(view.errorCount)],
            ["耗时", formatDuration(view.durationMs)],
            ["输入 tokens", String(view.tokensIn)],
            ["输出 tokens", String(view.tokensOut)],
            ["工具调用", String(view.toolCalls)],
          ]}
        />
        <div className="mt-1 text-[11px] leading-5 text-gray-500">
          下列消耗为该步骤子树的派生值（现有轨迹口径）。点任一条调用可打开其原始请求与响应。
        </div>
      </Section>

      <Section title={`已记录调用（${view.calls.length}）`}>
        {view.calls.length === 0 ? (
          <div className="text-[11px] text-gray-400">
            该步骤下没有直接记录的 LLM 调用或工具执行。
          </div>
        ) : (
          <div className="space-y-1">
            {view.calls.map((call) => (
              <button
                key={call.spanId}
                type="button"
                onClick={() => onOpenCall(call.spanId)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-gray-100"
              >
                <span className="rounded bg-gray-200 px-1 font-code text-[10px] text-gray-600">
                  {call.kind === "llm.call" ? "llm" : "tool"}
                </span>
                <span className="min-w-0 flex-1 truncate font-code text-gray-700">
                  {call.label}
                </span>
                {call.errored ? (
                  <span className="rounded bg-red-100 px-1 text-[10px] text-red-800">错误</span>
                ) : null}
                <span className="font-code text-[10px] text-gray-400">
                  {shortSpanId(call.spanId)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

/** 短 ID（与 SpanTree 同一显示口径：只显示不影响复制，复制永远完整 ID） */
function shortSpanId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

export function DetailPanel({
  focusActive = false,
  onEnterFocus,
  onExitFocus,
}: {
  /** UI 密度 2.4：专注编辑态（App 层按当前工作区身份比对生效；显示覆盖，不写偏好） */
  readonly focusActive?: boolean;
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
      {focusActive ? (
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
      {!focusActive && onEnterFocus !== undefined ? (
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
