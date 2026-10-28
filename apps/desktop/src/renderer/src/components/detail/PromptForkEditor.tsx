import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { IsolatedPromptCapabilityResult, RunDetail } from "@shared/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslator } from "../../i18n";
import type { CallDraftKey, CallDraftMode } from "../../lib/debugging-drafts";
import { captureCallDraftSource, revalidateCallDraftSource } from "../../lib/draft-source";
import { deriveEntryGate } from "../../lib/entry-gate";
import { disclosureLines, promptDisclosure } from "../../lib/execution-confirmation";
import { isolatedPromptGuard } from "../../lib/isolated-prompt";
import {
  isolatedPromptCapabilityRequestOf,
  presentIsolatedPromptCard,
  resolveIsolatedPromptSubmission,
} from "../../lib/isolated-prompt-card";
import { promptForkGuard } from "../../lib/prompt-fork";
import type { PromptForkField } from "../../lib/prompt-fork";
import { useEscapeClose } from "../../lib/use-escape-close";
import { useResetOnLanguageChange } from "../../lib/use-reset-on-language-change";
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
  mode = "plain",
}: {
  span: Extract<SpanLine, { kind: "llm.call" }>;
  run: RunDetail;
  /** R2.2 6.1：隔离启动指令实验复用本编辑器（草稿身份带模式，不建第二份表单） */
  mode?: CallDraftMode;
}) {
  const translator = useTranslator();
  const isolated = mode === "isolated";
  const forking = useAppStore((s) => s.forking);
  const forkError = useAppStore((s) => s.forkError);
  const forkErrorCode = useAppStore((s) => s.forkErrorCode);
  const settings = useAppStore((s) => s.settings);
  const promptFork = useAppStore((s) => s.promptFork);
  const promptExperiment = useAppStore((s) => s.promptExperiment);
  const resetFork = useAppStore((s) => s.resetFork);
  const ensureCallDraft = useAppStore((s) => s.ensureCallDraft);
  const writeCallDraftText = useAppStore((s) => s.writeCallDraftText);
  const writeCallDraftNotes = useAppStore((s) => s.writeCallDraftNotes);
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
  const draftKeyOf = useCallback(
    (f: PromptForkField): CallDraftKey => ({
      runId: run.meta.id,
      spanId: span.id,
      field: f,
      ...(isolated ? { mode: "isolated" as const } : {}),
    }),
    [run.meta.id, span.id, isolated],
  );
  const ensureFieldDraft = useCallback(
    (f: PromptForkField): void => {
      const baseline = f === "system_prompt" ? (originalSystem ?? "") : (originalUser ?? "");
      ensureCallDraft(draftKeyOf(f), baseline, draftSource);
    },
    [originalSystem, originalUser, ensureCallDraft, draftKeyOf, draftSource],
  );

  // U3 任务 3.4：待定提交冻结该字段草稿（store 侧同时拒绝写入/放弃）
  const draftFrozen = useAppStore((s) => s.isDraftFrozen(draftKeyOf(field)));
  const beginDraftSubmission = useAppStore((s) => s.beginDraftSubmission);
  // U5 任务 4.6：prompt 的执行前确认（同一份凭据与执法点，见 lib/execution-confirmation）
  const currentConfirmationBinding = useAppStore((s) => s.currentConfirmationBinding);
  const armExecutionConfirmation = useAppStore((s) => s.armExecutionConfirmation);
  const releaseExecutionConfirmation = useAppStore((s) => s.releaseExecutionConfirmation);
  // U3 任务 3.4：待定提交期间视同进行中——输入、放弃、关闭、提交一并禁用
  const inProgress = forking === "in_progress" || draftFrozen;
  // U4 任务 4.4：入口可用性从统一操作槽派生（只拦"再发一条"，不锁输入与放弃）
  const gate = deriveEntryGate(useAppStore((s) => s.operations));
  const original = field === "system_prompt" ? originalSystem : originalUser;
  const activeEntry = useAppStore((s) => s.callDraftOf(draftKeyOf(field)));
  // 草稿已登记 ⇒ 读该字段草稿；未登记（尚未打开/切换到）⇒ 退回该字段原值
  const value = activeEntry !== undefined ? activeEntry.text : (original ?? "");
  const unchanged = original === null || value === original;
  // R2.2 6.1：假设/判据是隔离实验草稿的一部分（会话内恢复，不恢复任何执行许可）
  const hypothesis = activeEntry?.hypothesis ?? "";
  const acceptanceCriterion = activeEntry?.acceptanceCriterion ?? "";

  // U3 任务 2.5：草稿列表的定位目标到达即打开对应字段（ensure 幂等；重开不覆盖）
  const pending = useAppStore((s) => s.pendingDraftTarget);
  const consumeDraftTarget = useAppStore((s) => s.consumeDraftTarget);
  const discardCallDraft = useAppStore((s) => s.discardCallDraft);
  useEffect(() => {
    if (pending === null) return;
    if (pending.runId !== run.meta.id || pending.spanId !== span.id) return;
    if (pending.field !== "system_prompt" && pending.field !== "user_message") return;
    // 草稿定位必须落在同一模式：普通 prompt 的「返回草稿」不得打开隔离实验（反之亦然）
    if ((pending.mode ?? "plain") !== mode) return;
    ensureFieldDraft(pending.field);
    setField(pending.field);
    setOpen(true);
    consumeDraftTarget();
  }, [pending, consumeDraftTarget, ensureFieldDraft, run, span, mode]);

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

  const guardInput = {
    field,
    hasSystem: originalSystem !== null,
    hasUser: originalUser !== null,
    settingsConfigured: settings?.configured === true,
    unchanged,
  };
  // 隔离实验比普通 prompt fork 多一条「启动消息 system+user 至少各一条」；
  // 无字符串 system 时两种编辑都不可用，不以 config_hash / 设置 / 空串补造。
  const guard = isolated ? isolatedPromptGuard(guardInput) : promptForkGuard(guardInput);
  // 提交闸门 = 既有单步条件 ∧ 源记录可用（源不可用时"能编辑"不等于"能执行"）
  //           ∧ 恢复重验通过（U3 2.5：源缺失/损坏/改变/资格失效都拦）
  //           ∧ 已核对本次从头重跑（U5 4.6：确认凭据，判据在 lib/execution-confirmation.ts）
  const promptBinding = currentConfirmationBinding(
    isolated ? "prompt_experiment" : "prompt",
    draftKeyOf(field),
  );
  const promptConfirmed = useAppStore((s) => s.executionConfirmationReady(promptBinding));
  const canSubmit =
    !isolated && guard.canSubmit && sourceExecutable && sourceBlocked === null && promptConfirmed;
  const submitBlocked = !guard.canSubmit
    ? guard.reason
    : !sourceExecutable
      ? "源记录不可用：重新读取并校验通过前不能发起新执行"
      : null;

  // R2.2 6.2：隔离实验的只读核对状态。全部绑定「草稿修订 + 设置快照 + 字段」，
  // 任一变化都会让旧结论/旧确认/旧副本授权失效（现算比对，不靠手动清理）。
  const loadIsolatedPromptCapability = useAppStore((s) => s.loadIsolatedPromptCapability);
  const restartExecutionCheck = useAppStore((s) => s.restartExecutionCheck);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{
    readonly key: string;
    readonly result: IsolatedPromptCapabilityResult;
  } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [authorizedKey, setAuthorizedKey] = useState<string | null>(null);
  // 有效语言变化：撤销副本写入勾选；草稿/只读预检结论保留，提交时仍重新核对
  useResetOnLanguageChange(() => setAuthorizedKey(null));
  const checkSeq = useRef(0);
  const draftRevision = activeEntry?.revision ?? -1;
  const capabilityKey = `${draftRevision}|${promptBinding.settingsStamp}|${field}`;
  const currentCheck = checked !== null && checked.key === capabilityKey ? checked.result : null;
  const capability = currentCheck?.status === "ok" ? currentCheck : null;
  const unavailableCheck = currentCheck?.status === "unavailable" ? currentCheck : null;
  const checkStale = checked !== null && currentCheck === null;
  const authorizationKey =
    capability === null
      ? null
      : `${capabilityKey}|${capability.planFingerprint}|${promptBinding.generation}`;
  const writesAuthorized =
    authorizedKey !== null && authorizationKey !== null && authorizedKey === authorizationKey;
  const toolNames = (span.request.tools ?? [])
    .map((tool) => (tool as { name?: unknown }).name)
    .filter((name): name is string => typeof name === "string");
  const isolatedCard =
    capability === null ? null : presentIsolatedPromptCard(capability, toolNames);
  const canCheck =
    !inProgress && !checking && guard.canSubmit && sourceExecutable && sourceBlocked === null;
  const isolatedSubmission = isolated
    ? resolveIsolatedPromptSubmission({
        rootRunId: run.meta.id,
        edit: { field, value },
        originalValue: original ?? "",
        hypothesis,
        acceptanceCriterion,
        capability,
        capabilityFresh: capability !== null,
        feeConfirmed: promptConfirmed,
        writesAuthorized,
        checking,
        inProgress,
        gateBlockedReason: gate.canSubmit ? null : gate.notice,
        guardCanSubmit: guard.canSubmit,
        guardReason: guard.reason,
      })
    : null;
  const feeBlocked = !guard.canSubmit
    ? guard.reason
    : !sourceExecutable
      ? "源记录不可用：重新读取并校验通过前不能确认"
      : (sourceBlocked?.reason ??
        (gate.canSubmit
          ? "请确认本次从头执行会真实调用模型并计费；费用确认不随草稿恢复。"
          : gate.notice));

  // 设置/凭据往返（包括改走又改回）必须让旧核对、费用确认与副本授权全部失效：
  // 快照值比对看不出来的"曾经离开现场"，由设置快照变化推进检查代次兜住。
  const settingsStamp = promptBinding.settingsStamp;
  const lastSettingsStamp = useRef(settingsStamp);
  useEffect(() => {
    if (lastSettingsStamp.current === settingsStamp) return;
    lastSettingsStamp.current = settingsStamp;
    setAuthorizedKey(null);
    setChecked(null);
    setCheckError(null);
    restartExecutionCheck(draftKeyOf(field));
  }, [settingsStamp, restartExecutionCheck, draftKeyOf, field]);

  // 离开隔离编辑流程（切字段/收起/换步骤/卸载）⇒ 费用确认与副本授权不随页面恢复。
  // 草稿正文与假设/判据仍保留；被撤销的只是本次执行许可。
  useEffect(() => {
    if (!isolated) return;
    return () => {
      releaseExecutionConfirmation(draftKeyOf(field));
    };
  }, [isolated, releaseExecutionConfirmation, draftKeyOf, field]);

  /**
   * 只读核对：先推进检查代次（作废旧费用确认），再请 main 重读根/配置/附件。
   * 迟到响应按请求序号丢弃，不能把旧根/旧修订的结论装到当前草稿上。
   */
  const doIsolatedCheck = async (): Promise<void> => {
    if (!canCheck) return;
    const seq = checkSeq.current + 1;
    checkSeq.current = seq;
    const requestKey = capabilityKey;
    restartExecutionCheck(draftKeyOf(field));
    setAuthorizedKey(null);
    setChecked(null);
    setCheckError(null);
    setChecking(true);
    const response = await loadIsolatedPromptCapability(
      isolatedPromptCapabilityRequestOf({
        rootRunId: run.meta.id,
        edit: { field, value },
        hypothesis,
        acceptanceCriterion,
      }),
    );
    if (seq !== checkSeq.current) return; // 迟到：新核对已接管
    setChecking(false);
    if (!response.ok) {
      setCheckError(`${response.code}：${response.message}`);
      return;
    }
    setChecked({ key: requestKey, result: response.data });
  };

  /**
   * 6.3 真实提交：先按 U3 原子登记提交关联（确认成立才继续，冻结本字段快照），
   * 再走 U4 的统一主动通道。失败/拒绝不清草稿；正常结果由 U5 收尾关联按修订清理。
   */
  const doIsolatedSubmit = (): void => {
    if (!isolated || isolatedSubmission === null || !isolatedSubmission.ok) return;
    const assoc = beginDraftSubmission({
      channel: "prompt_experiment",
      target: draftKeyOf(field),
      confirmation: promptBinding,
    });
    if (assoc === null) return;
    void promptExperiment(isolatedSubmission.request, assoc);
  };

  const switchField = (next: PromptForkField): void => {
    // 目标字段草稿未登记时登记（已存在则原样保留）⇒ 字段切换保留各自独立值
    if (isolated) {
      // 切字段 = 离开当前实验现场：旧核对结论/费用确认/副本授权不跟过去
      checkSeq.current += 1;
      setAuthorizedKey(null);
      setChecked(null);
      setCheckError(null);
      releaseExecutionConfirmation(draftKeyOf(field));
    }
    ensureFieldDraft(next);
    setField(next);
    resetFork();
  };

  /** 收起编辑（取消/Esc）：保留草稿，但隔离实验的本次执行许可一律复位 */
  const closeEditor = (): void => {
    if (isolated) {
      checkSeq.current += 1;
      setAuthorizedKey(null);
      setChecked(null);
      setCheckError(null);
      releaseExecutionConfirmation(draftKeyOf(field));
    }
    resetFork();
    setOpen(false);
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
  useEscapeClose(open && !inProgress, closeEditor);

  if (!open) {
    // 普通入口：缺字符串 system 即整体不可用（既有语义）。
    // 隔离实验：启动消息要求 system+user 各至少一条，缺任一条两种编辑都不可用。
    const unavailable = originalSystem === null || (isolated && originalUser === null);
    const unavailableReason = isolated
      ? isolatedPromptGuard({
          field: "system_prompt",
          hasSystem: originalSystem !== null,
          hasUser: originalUser !== null,
          settingsConfigured: true,
          unchanged: false,
        }).reason
      : "首次 llm.call 缺少字符串形式的 system 消息，无法重建运行配置，prompt fork 不可用。";
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
            title={unavailable ? (unavailableReason ?? undefined) : undefined}
            className="rounded bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isolated ? "修改 system prompt（隔离实验）" : "编辑 system prompt 重跑"}
          </button>
          <button
            type="button"
            onClick={() => {
              resetFork();
              switchField("user_message");
              setOpen(true);
            }}
            disabled={unavailable || inProgress}
            title={unavailable ? (unavailableReason ?? undefined) : undefined}
            className="rounded border border-emerald-500 px-2 py-1 text-[11px] text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isolated ? "修改首条 user message（隔离实验）" : "编辑初始 user message 重跑"}
          </button>
        </div>
        {unavailable ? (
          <div className="mt-1 text-[11px] text-gray-400">{unavailableReason}</div>
        ) : (
          <div className="mt-1 text-[11px] text-gray-400">
            {isolated
              ? "隔离启动指令实验：从该根的初始文件与启动指令出发从头重跑（真实模型调用；父/兄弟/源目录不会被修改）。一次只改一项。"
              : "prompt fork：修改启动上下文后从头重跑（独立新轨迹，不共享父前缀）。一次只改一项。"}
          </div>
        )}
      </div>
    );
  }

  const doSubmit = (): void => {
    if (isolated || !canSubmit) return;
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
        <span className="text-[11px] font-semibold text-emerald-900">
          {isolated ? "隔离 prompt 实验 · 从初始文件与启动指令重跑" : "prompt fork · 从头重跑"}
        </span>
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
      {isolated ? (
        <div
          className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-emerald-900"
          data-isolated-prompt-root
        >
          <span>
            根运行 <span className="font-code">{run.meta.id}</span>
          </span>
          <span>
            启动调用 <span className="font-code">{span.id}</span>
          </span>
          <span className="text-emerald-700">
            当前目标已固定为该根；返回原阅读页用上方页签，不自动跳转。
          </span>
        </div>
      ) : null}
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
      {/* R2.2 6.1：假设/人工判据是可选用户文字，只随草稿与正式提交落盘，不自动执行或评分。 */}
      {isolated ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2" data-isolated-prompt-notes>
          <label className="block text-[11px] text-gray-700">
            <span className="mb-0.5 block font-medium">假设（可选，≤4000 字）</span>
            <textarea
              data-isolated-note="hypothesis"
              value={hypothesis}
              maxLength={4000}
              disabled={inProgress}
              onChange={(event) =>
                writeCallDraftNotes(draftKeyOf(field), { hypothesis: event.target.value })
              }
              rows={3}
              placeholder="例如：把启动指令改成先读配置，预期会多调用一次 read_file"
              className="w-full resize-y rounded border border-emerald-200 bg-white px-2 py-1 text-[11px] leading-4 text-gray-800 disabled:bg-gray-50"
            />
          </label>
          <label className="block text-[11px] text-gray-700">
            <span className="mb-0.5 block font-medium">人工判据（可选，≤4000 字）</span>
            <textarea
              data-isolated-note="acceptance-criterion"
              value={acceptanceCriterion}
              maxLength={4000}
              disabled={inProgress}
              onChange={(event) =>
                writeCallDraftNotes(draftKeyOf(field), {
                  acceptanceCriterion: event.target.value,
                })
              }
              rows={3}
              placeholder="例如：输出中必须说明配置文件的值；由我人工判定，不自动评分"
              className="w-full resize-y rounded border border-emerald-200 bg-white px-2 py-1 text-[11px] leading-4 text-gray-800 disabled:bg-gray-50"
            />
          </label>
        </div>
      ) : null}
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
      {isolated
        ? null
        : (() => {
            const disclosure = promptDisclosure(
              {
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
              },
              translator,
            );
            return (
              <ConfirmationBlock
                title="核对本次从头重跑"
                tone="emerald"
                summary={disclosure.summary}
                rows={disclosureLines(disclosure, translator)}
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

      {isolated ? (
        <div className="mt-2 space-y-2" data-isolated-prompt-check>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-isolated-prompt-check-button
              onClick={() => void doIsolatedCheck()}
              disabled={!canCheck}
              className="rounded border border-violet-400 bg-white px-2 py-0.5 text-[11px] text-violet-800 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {checking
                ? "正在核对本次运行…"
                : capability !== null || unavailableCheck !== null
                  ? "重新核对本次运行（只读）"
                  : "核对本次运行（只读）"}
            </button>
            <span className="text-[11px] leading-4 text-emerald-800">
              只读预检：不调用模型、不写文件、不占执行槽；结论不是执行凭证。
            </span>
          </div>

          {checked !== null && currentCheck !== null ? (
            <div className="text-[10px] text-gray-500" data-isolated-prompt-checked>
              核对绑定草稿修订 #{draftRevision} 与当前设置快照；任何修改都要重新核对。
            </div>
          ) : null}

          {checkStale ? (
            <div
              className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900"
              data-isolated-prompt-check-stale
            >
              输入或运行配置已变化：旧核对结论、费用确认与副本授权已失效。请重新核对本次运行。
            </div>
          ) : null}

          {checkError !== null ? (
            <div className="text-[11px] leading-4 text-red-700" data-isolated-prompt-check-error>
              {checkError}
            </div>
          ) : null}

          {unavailableCheck !== null ? (
            <div
              className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900"
              data-isolated-prompt-check-unavailable
            >
              核对未通过（{unavailableCheck.code}）：{unavailableCheck.reason}
              {unavailableCheck.rootId === undefined
                ? ""
                : ` 经验证的根：${unavailableCheck.rootId}（需显式打开根后重新核对）`}
            </div>
          ) : null}

          {capability !== null && isolatedCard !== null ? (
            <>
              <ConfirmationBlock
                title="核对本次隔离实验"
                tone="emerald"
                summary={isolatedCard.summary}
                rows={isolatedCard.rows}
                confirmed={promptConfirmed}
                confirmDisabled={
                  inProgress ||
                  checking ||
                  !guard.canSubmit ||
                  !sourceExecutable ||
                  sourceBlocked !== null ||
                  !gate.canSubmit
                }
                onConfirm={() => armExecutionConfirmation(promptBinding)}
                confirmLabel="已核对，确认真实计费"
                confirmedLabel="已确认真实计费"
                blocked={promptConfirmed ? null : feeBlocked}
                controlsId={`isolated-prompt-confirm-${run.meta.id}-${span.id}`}
              />
              <div className="text-[11px] leading-4 text-emerald-900" data-isolated-billing>
                {isolatedCard.billing}
                {isolatedCard.unknowns.length === 0
                  ? " 历史未录制条件：无。"
                  : ` 历史未知：${isolatedCard.unknowns.join("；")}`}
              </div>
              <label
                className="flex items-start gap-2 rounded border border-violet-200 bg-white px-2 py-1.5 text-[11px] leading-4 text-gray-700"
                data-isolated-writes-authorization
              >
                <input
                  type="checkbox"
                  checked={writesAuthorized}
                  disabled={
                    inProgress ||
                    checking ||
                    capability === null ||
                    !gate.canSubmit ||
                    !guard.canSubmit ||
                    sourceBlocked !== null
                  }
                  onChange={(event) =>
                    setAuthorizedKey(event.target.checked ? authorizationKey : null)
                  }
                />
                <span>
                  允许本次副本写入（只写本次新副本的独立文件世界；父/兄弟/源目录不修改）。
                  授权默认未选、仅对这一次提交有效，不从父 trace 的 write_authorized 补授权。
                </span>
              </label>
              <div
                className="flex flex-wrap items-center justify-end gap-2"
                data-isolated-prompt-submit
              >
                <span
                  className={`mr-auto text-[11px] leading-4 ${
                    isolatedSubmission?.ok ? "text-emerald-800" : "text-amber-800"
                  }`}
                  data-isolated-prompt-submit-state
                >
                  {isolatedSubmission?.ok
                    ? "费用确认与本次副本授权已就绪；提交后会真实调用模型并写入独立文件世界。"
                    : (isolatedSubmission?.reason ?? "")}
                </span>
                <button
                  type="button"
                  data-isolated-prompt-submit-button
                  onClick={doIsolatedSubmit}
                  disabled={inProgress || isolatedSubmission === null || !isolatedSubmission.ok}
                  className="rounded bg-violet-700 px-3 py-1 text-[11px] text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {inProgress ? "提交处理中…" : "确认开始实验（真实调用）"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

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
          onClick={closeEditor}
          disabled={inProgress}
          className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          取消
        </button>
        {isolated ? null : (
          <button
            type="button"
            onClick={doSubmit}
            disabled={inProgress || !canSubmit || !gate.canSubmit}
            className="rounded bg-emerald-600 px-3 py-1 text-[11px] text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            确认从头重跑
          </button>
        )}
      </div>
    </div>
  );
}
