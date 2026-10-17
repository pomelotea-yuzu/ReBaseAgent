import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { RunDetail } from "@shared/ipc";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CallDraftKey } from "../../lib/debugging-drafts";
import { captureCallDraftSource, revalidateCallDraftSource } from "../../lib/draft-source";
import { deriveEntryGate } from "../../lib/entry-gate";
import { disclosureLines, promptDisclosure } from "../../lib/execution-confirmation";
import { promptForkGuard } from "../../lib/prompt-fork";
import type { PromptForkField } from "../../lib/prompt-fork";
import { useEscapeClose } from "../../lib/use-escape-close";
import { useAppStore } from "../../store";
import { requestConfirm } from "../ConfirmDialog";
import { ConfirmationBlock } from "../ConfirmationBlock";
import { DraftCompareGrid } from "../DraftCompareGrid";
import { DraftSourceBanner } from "../DraftSourceBanner";
import { EntryGateNotice } from "../EntryGateNotice";
import { MonacoCodeEditor } from "../MonacoEditor";

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

export function PromptForkEditor({
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
