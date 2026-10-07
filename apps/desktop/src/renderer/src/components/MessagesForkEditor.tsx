import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { RunDetail } from "@shared/ipc";
import { useEffect, useMemo, useState } from "react";
import type { CallDraftKey } from "../lib/debugging-drafts";
import { captureCallDraftSource, revalidateCallDraftSource } from "../lib/draft-source";
import { deriveEntryGate } from "../lib/entry-gate";
import { disclosureLines, messagesDisclosure } from "../lib/execution-confirmation";
import { prettyJson } from "../lib/format";
import { deriveMessagesIneligibility } from "../lib/messages-eligibility";
import { isStatusReadChecking } from "../lib/proxy-status-read";
import { useEscapeClose } from "../lib/use-escape-close";
import { useAppStore } from "../store";
import { requestConfirm } from "./ConfirmDialog";
import { DraftSourceBanner } from "./DraftSourceBanner";
import { EntryGateNotice } from "./EntryGateNotice";
import { FOCUS_RING } from "./IconButton";
import { MonacoCodeEditor } from "./MonacoEditor";

/**
 * ⚠️ U8 5.1a（2026-10-01）自 DetailPanel **逐字搬出**（零行为变化——工作区侧接线在
 * 5.1b 落地）。本文件由 .workbuddy/u8/u8-51/extract-messages-fork-editor.cjs 从
 * DetailPanel 按标记切取生成，证据：切取前后两文件的公共子串逐字一致。
 */

/**
 * 代理 run 的"编辑 messages 重发"（单请求级最小分叉，方案 a）：
 * 编辑 request.messages → 经代理用暂存 key 重发 → 新 fork run。
 * 与 runs:fork（tool.result 编辑重跑）完全独立，走 proxy:fork 通道。
 *
 * U8 5.1b（2026-10-01）：新增两个工作区形态参数（镜像 ModelAbEditor 同名参数）——
 * - `sourceExecutable`：目标作用域的源可用性覆盖。缺省（undefined）= 沿用全局选中详情
 *   的门禁；messages 工作区传入**按目标 runId 计算**的可用性——目标不跟随侧栏选择，
 *   全局门禁在这里会看错对象。
 * - `alwaysOpen`：工作区形态常开（初始即展开、无「取消」收起、Esc 不收起；草稿照常保留）。
 */
export function MessagesForkEditor({
  span,
  run,
  sourceExecutable: sourceExecutableOverride,
  alwaysOpen = false,
}: {
  span: Extract<SpanLine, { kind: "llm.call" }>;
  run: RunDetail;
  readonly sourceExecutable?: boolean;
  readonly alwaysOpen?: boolean;
}) {
  const forking = useAppStore((s) => s.forking);
  const forkError = useAppStore((s) => s.forkError);
  const forkErrorCode = useAppStore((s) => s.forkErrorCode);
  const proxyFork = useAppStore((s) => s.proxyFork);
  const resetFork = useAppStore((s) => s.resetFork);
  const ensureCallDraft = useAppStore((s) => s.ensureCallDraft);
  const writeCallDraftText = useAppStore((s) => s.writeCallDraftText);
  const proxy = useAppStore((s) => s.proxy);
  // 任务 2.1：代理状态读取在飞 = 「核对中」。判据来自 lib（与 store 的合并语义同源），
  // 这里派生布尔而不是订阅整份读取代次对象——对象每次收尾都换引用，拿它当依赖会在
  // inFlight 没变时也唤醒一次。
  const proxyChecking = useAppStore((s) => isStatusReadChecking(s.proxyStatusRead));
  const [open, setOpen] = useState(alwaysOpen);
  /**
   * U3 任务 2.2：messages 草稿（无损字符串——非法 JSON / 空串原样暂存，解析只在提交边界）。
   * 打开经 ensure 登记基线（重开不覆盖已有输入）；关闭/设置往返不删草稿。
   */
  const draftKey: CallDraftKey = useMemo(
    () => ({ runId: run.meta.id, spanId: span.id, field: "messages" }),
    [run.meta.id, span.id],
  );
  const draftEntry = useAppStore((s) => s.callDraftOf(draftKey));
  // U8 任务 1.4：messages 编辑工作区入口（同一草稿键；§5.1 提取编辑器到工作区）
  const openMessagesWorkspace = useAppStore((s) => s.openMessagesWorkspace);
  // U3 任务 3.4：待定提交冻结该草稿（store 侧同时拒绝写入/放弃）
  const draftFrozen = useAppStore((s) => s.isDraftFrozen(draftKey));
  const beginDraftSubmission = useAppStore((s) => s.beginDraftSubmission);
  const settleDraftSubmission = useAppStore((s) => s.settleDraftSubmission);
  // U5 任务 4.6：messages 的执行前确认（同一凭据与执法点）
  const currentConfirmationBinding = useAppStore((s) => s.currentConfirmationBinding);
  const armExecutionConfirmation = useAppStore((s) => s.armExecutionConfirmation);
  const [parseError, setParseError] = useState<string | null>(null);
  // 源记录不可用时禁用依赖它的执行（任务 3.5）；工作区传入目标作用域覆盖（U8 5.1b）
  const sourceExecutableFromSelection = useAppStore((s) => s.canExecuteFromSource)();
  const sourceExecutable = sourceExecutableOverride ?? sourceExecutableFromSelection;

  // U3 任务 3.4：待定提交期间视同进行中——输入、放弃、关闭、提交一并禁用
  const inProgress = forking === "in_progress" || draftFrozen;
  // U4 任务 4.4：代理 messages 重发同样是主动执行 ⇒ 受统一槽约束
  const gate = deriveEntryGate(useAppStore((s) => s.operations));
  const messagesBaseline = prettyJson(span.request.messages);
  const value = draftEntry !== undefined ? draftEntry.text : messagesBaseline;
  const unchanged = value === messagesBaseline;

  // U3 任务 2.5：草稿列表的定位目标到达即打开（ensure 幂等；重开不覆盖已有输入）
  const pending = useAppStore((s) => s.pendingDraftTarget);
  const consumeDraftTarget = useAppStore((s) => s.consumeDraftTarget);
  const discardCallDraft = useAppStore((s) => s.discardCallDraft);
  useEffect(() => {
    if (pending === null) return;
    if (
      pending.runId !== run.meta.id ||
      pending.spanId !== span.id ||
      pending.field !== "messages"
    ) {
      return;
    }
    ensureCallDraft(draftKey, messagesBaseline, captureCallDraftSource(run, span));
    setParseError(null);
    setOpen(true);
    consumeDraftTarget();
  }, [pending, consumeDraftTarget, ensureCallDraft, draftKey, run, span, messagesBaseline]);

  // U8 6.9 实机坐实的接线缺口（2026-10-01，同 6.7 的 ModelAbEditor 家族）：工作区形态
  // （alwaysOpen）不走「折叠态展开按钮」与「草稿定位 pending」两条 ensure 路径 ⇒ 挂载时
  // 草稿条目不存在，而 writeCallDraftText 对不存在的条目 no-op（debugging-drafts 契约）
  // ⇒ 工作区里的首次编辑被静默丢弃、编辑完全失效。修复：挂载即登记基线草稿（ensure
  // 幂等——已存在条目原样保留，重挂载/换目标重挂都不覆盖用户输入）。
  useEffect(() => {
    if (!alwaysOpen) return;
    ensureCallDraft(draftKey, messagesBaseline, captureCallDraftSource(run, span));
  }, [alwaysOpen, ensureCallDraft, draftKey, run, span, messagesBaseline]);

  // U3 任务 2.5/1.4：恢复重验——源缺失/损坏/改变/资格失效 ⇒ 保留草稿、禁止执行
  const sourceVerdict =
    draftEntry === undefined
      ? null
      : revalidateCallDraftSource({
          runId: run.meta.id,
          spanId: span.id,
          field: "messages",
          baseline: draftEntry.baseline,
          source: draftEntry.source,
          detail: run,
        });
  const sourceBlocked = sourceVerdict?.kind === "blocked" ? sourceVerdict : null;

  /**
   * U5 任务 4.6 → U8 5.2：messages 的资格原因（就近显示，不只靠禁用与悬停）。
   * 顺序判据提取为纯函数（lib/messages-eligibility.ts）——源记录 → 恢复重验 →
   * 代理是否在跑 → 是否捕获到 key → 统一槽门禁；`recordingEntry` 标记该原因能否
   * 由「打开录制工作区」就地化解（代理启停/凭据接入都在录制页完成）。
   */
  const openRecordingWorkspace = useAppStore((s) => s.openRecordingWorkspace);
  const ineligible = deriveMessagesIneligibility({
    sourceExecutable,
    sourceBlockedReason: sourceBlocked?.reason ?? null,
    proxyRunning: proxy?.running ?? null,
    // 任务 2.1：核对中如实说"正在核对"，不谎报未捕获（delta「读取期间显示核对中」）
    proxyChecking,
    hasKey: proxy?.hasKey === true,
    gateNotice: gate.canSubmit ? null : gate.notice,
  });
  const ineligibleReason = ineligible?.reason ?? null;
  const messagesBinding = currentConfirmationBinding("messages", draftKey);
  const messagesConfirmed = useAppStore((s) => s.executionConfirmationReady(messagesBinding));

  // U3 任务 6.10（design D7）：Esc 收起与「取消」按钮同动作（保留草稿）。
  // U8 5.1b：工作区形态常开 ⇒ Esc 不收起（收起语义只属于步骤页内联形态）。
  useEscapeClose(open && !alwaysOpen && !inProgress, () => {
    resetFork();
    setOpen(false);
  });

  if (!open) {
    return (
      <div className="border-t border-sky-100 px-4 py-2">
        <button
          type="button"
          onClick={() => {
            resetFork();
            ensureCallDraft(draftKey, messagesBaseline, captureCallDraftSource(run, span));
            setParseError(null);
            setOpen(true);
          }}
          className="rounded bg-sky-600 px-2 py-1 text-[11px] text-white hover:bg-sky-700"
        >
          编辑 messages 重发
        </button>
        {/* U8 任务 1.4：就地编辑器之外的第二扇门通向 messages 编辑工作区（同一草稿键，
            不是第二份表单状态）；编辑器本体随 §5.1 提取到工作区后，就地这份随之移除 */}
        <button
          type="button"
          data-messages-workspace-entry
          onClick={() => openMessagesWorkspace({ runId: run.meta.id, spanId: span.id })}
          className="ml-2 rounded border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] text-sky-900 hover:bg-sky-100"
        >
          在编辑工作区打开
        </button>
      </div>
    );
  }

  const doResend = (): void => {
    // 源记录不可用：旧内容可见但不得据此获得执行资格（提交口兜底，不依赖按钮禁用）
    if (!sourceExecutable) {
      setParseError("源记录不可用：重新读取并校验通过前不能重发");
      return;
    }
    // U3 任务 2.5：恢复重验未通过同样在提交口兜底
    if (sourceBlocked !== null) {
      setParseError(`来源失效，已禁止重发：${sourceBlocked.reason}`);
      return;
    }
    // U3 任务 3.4：先原子登记提交关联（key + 修订 + 请求快照），提交边界的解析只针对
    // **快照原文**——校验的与提交的必须是同一份。本地拒绝 = 明确未发请求，直接收尾
    //（否则草稿会被永久冻结在没有在途请求的状态里）。
    // U5 任务 4.6：旧的原生确认对话框换成"就地核对 + 一次性确认凭据"——确认与门禁
    // 都在登记口执法（不成立就返回 null，一次 IPC 都不发），因此快照解析次序不必改动。
    const assoc = beginDraftSubmission({
      channel: "messages",
      target: draftKey,
      confirmation: messagesBinding,
    });
    if (assoc === null) return;
    // 提交时解析回结构体；解析失败可见报错，不发请求
    let messages: unknown;
    try {
      messages = JSON.parse(assoc.submittedText);
    } catch (e) {
      settleDraftSubmission(assoc);
      setParseError(`messages 不是合法 JSON：${(e as Error).message}`);
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      settleDraftSubmission(assoc);
      setParseError("messages 必须是非空数组");
      return;
    }
    setParseError(null);
    void proxyFork(run.meta.id, span.id, messages as Record<string, unknown>[], assoc);
  };

  /**
   * U3 任务 2.6：按修订明确放弃（design D3）——确认核对当前内容；CAS 拒绝旧确认
   * 删除新修订。清空为零长度的变更同样是 dirty，一样要经此确认。
   */
  const discardCurrent = (): void => {
    if (draftEntry === undefined || inProgress) return;
    const snapshot = draftEntry;
    // U3 5.2：异步模态确认；CAS 按请求时的快照修订校验
    void requestConfirm({
      title: "放弃 messages 重发草稿",
      message: `放弃这份 messages 重发草稿？（run ${run.meta.id} · ${span.id}）\n\n当前草稿内容：\n${snapshot.text}\n\n放弃按确认时的修订校验：此后内容若被更新，本次放弃不会执行。`,
    }).then((confirmed) => {
      if (!confirmed) return; // 取消：逐字保留
      if (discardCallDraft(draftKey, snapshot.revision)) {
        resetFork();
        setOpen(false);
      }
    });
  };

  return (
    <div className="border-t border-sky-100 bg-sky-50/60 px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-sky-900">编辑 messages 重发</span>
        <span className="text-[10px] text-sky-500">
          单请求级分叉 · 源 run 不会被修改 · 重发使用最近捕获的 key
        </span>
      </div>
      {/* U3 任务 2.6：原值（只读）/草稿（可编辑）就近核对——宽屏并排、窄屏上下 */}
      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2" data-draft-compare="messages">
        <div className="min-w-0">
          <div className="mb-0.5 text-[10px] font-medium text-gray-500">原值（只读）</div>
          <MonacoCodeEditor
            height="200px"
            language="json"
            value={messagesBaseline}
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
        </div>
        <div className="min-w-0">
          <div className="mb-0.5 text-[10px] font-medium text-sky-700">草稿（可编辑）</div>
          <MonacoCodeEditor
            height="200px"
            language="json"
            value={value}
            onChange={(next) => writeCallDraftText(draftKey, next ?? "")}
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
            className="overflow-hidden rounded border border-sky-200"
          />
        </div>
      </div>
      <div className="mt-1.5 text-[10px] leading-4 text-sky-600">
        编辑任意一条消息后重发：model / 工具表 / 采样参数与源 run 一致，仅 messages 使用编辑后的值。
      </div>

      {/*
       * 任务 2.1：核对中如实说"正在核对当前状态"（delta「读取期间显示核对中……
       * 禁用依赖当前事实的提交，不谎报未捕获」）。它与"状态未知"是两回事：
       * 后者是长期占位、需要用户去处理，这里几毫秒后就有结论，所以不共用一句话。
       */}
      {proxyChecking ? (
        <div className="mt-1 text-[11px] text-sky-700" data-messages-proxy-checking>
          正在核对代理当前状态（监听与凭据）…核对完成前不按旧事实放行重发。
        </div>
      ) : null}

      {parseError !== null ? (
        <div className="mt-1 text-[11px] text-red-700">{parseError}</div>
      ) : null}

      {unchanged ? (
        <div className="mt-1 text-[11px] text-amber-700">
          未做任何修改（空 fork 被拒绝），编辑后再重发。
        </div>
      ) : null}

      {sourceBlocked !== null && draftEntry !== undefined ? (
        <DraftSourceBanner
          reason={sourceBlocked.reason}
          copyText={draftEntry.text}
          onDiscard={() => {
            if (draftEntry === undefined) return;
            const snapshot = draftEntry;
            void requestConfirm({
              title: "放弃 messages 重发草稿",
              message: "放弃这份 messages 重发草稿？内容将被删除（不可撤销）。",
            }).then((confirmed) => {
              if (!confirmed) return;
              if (discardCallDraft(draftKey, snapshot.revision)) {
                resetFork();
                setOpen(false);
              }
            });
          }}
        />
      ) : null}

      {draftFrozen ? (
        <div className="mt-2 rounded border border-sky-200 bg-sky-100/60 px-2 py-1.5 text-[11px] leading-4 text-sky-900">
          本次提交待处理：已按提交时的修订冻结这份草稿，请求返回前不可修改或放弃。
          无论成功、业务拒绝还是失败，草稿都先保留；按可信身份核实到正常结束、
          且草稿修订与提交时逐字相同，才自动清理（U5 §2/§3 已接线）。
        </div>
      ) : null}

      {forking === "error" ? (
        <div className="mt-1 text-[11px] text-red-700">
          {forkError}
          {forkErrorCode === "PROXY_NO_KEY" ? "（请先把你的应用经代理跑一次，再回来重发）" : ""}
        </div>
      ) : null}

      {/*
       * U5 任务 4.6：messages 的**核对本次重发**。这条路径最容易被人读成"把那个 Agent
       * 接着跑完"，所以边界写死：只重发这一个请求、不执行外部工具、不恢复其工作区、
       * 用的是代理会话最近捕获的 key（可能与录制当时不同）。缺资格时原因就近显示。
       */}
      <div className="mt-2 rounded border border-sky-200 bg-white">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="text-[11px] font-medium text-gray-600">核对本次重发</span>
          <button
            type="button"
            data-confirm-execution
            aria-pressed={messagesConfirmed ? "true" : undefined}
            disabled={inProgress || messagesConfirmed || ineligible !== null}
            onClick={() => armExecutionConfirmation(messagesBinding)}
            className={`shrink-0 rounded border px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
              messagesConfirmed
                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                : "border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {messagesConfirmed ? "已确认重发" : "已核对，确认本次重发"}
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t border-gray-100 px-2 py-1.5 text-[11px] leading-4">
          {disclosureLines(
            messagesDisclosure({
              parentRunId: run.meta.id,
              atSpanId: span.id,
              messageCount: span.request.messages.length,
              modelSummary: span.request.model,
              keyCaptured: proxy?.hasKey === true,
              upstream: proxy?.running === true ? proxy.upstreamBaseUrl : null,
              ineligible: ineligibleReason,
            }),
          ).map((row) => (
            <div key={`${row.label}-${row.value}`} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-gray-500">{row.label}</dt>
              <dd className="min-w-0 break-words text-gray-700">{row.value}</dd>
            </div>
          ))}
        </dl>
        {!messagesConfirmed && ineligible !== null ? (
          <div className="border-t border-gray-100 px-2 py-1.5 text-[11px] leading-4 text-amber-800">
            {ineligible.reason}
            {/* U8 5.2：凭据/监听类原因给就近录制入口——进录制再返回，草稿与目标原样保留
                （返回路径与目标保留由 store 的辅助工作区往返承担；旧确认不恢复） */}
            {ineligible.recordingEntry ? (
              <div className="mt-1">
                <button
                  type="button"
                  data-messages-recording-entry
                  onClick={openRecordingWorkspace}
                  className={`rounded border border-sky-300 bg-sky-50 px-2 py-0.5 text-[11px] text-sky-800 hover:bg-sky-100 ${FOCUS_RING}`}
                >
                  打开录制工作区（启用代理 / 接入凭据）
                </button>
                <span className="ml-2 text-[10px] text-gray-500">
                  返回后这份编辑草稿与目标原样保留；旧确认不恢复
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <EntryGateNotice gate={gate} />

      <div className="mt-2 flex items-center justify-end gap-2">
        {inProgress ? (
          <span className="text-[11px] text-sky-600">重发中…（真实 LLM 调用，可能耗时）</span>
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
            resetFork();
            setOpen(false);
          }}
          disabled={inProgress}
          className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          {/* U8 5.1b：工作区形态无「取消」收起（编辑器常开；收起语义只属于步骤页内联形态） */}
          {alwaysOpen ? null : "取消"}
        </button>
        <button
          type="button"
          onClick={doResend}
          disabled={
            inProgress ||
            unchanged ||
            !messagesConfirmed ||
            proxy?.running !== true ||
            !sourceExecutable ||
            sourceBlocked !== null ||
            !gate.canSubmit
          }
          title={
            !sourceExecutable
              ? "源记录不可用：重新读取并校验通过前不能重发"
              : proxy?.running !== true
                ? "代理未运行，请先在设置中启用"
                : undefined
          }
          className="rounded bg-sky-600 px-3 py-1 text-[11px] text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          确认重发
        </button>
      </div>
    </div>
  );
}
