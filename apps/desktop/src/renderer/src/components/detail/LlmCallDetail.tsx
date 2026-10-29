import type { SpanLine } from "@rebaseagent/trace-sdk";
import { spanDurationMs } from "@shared/derive";
import type { RunDetail } from "@shared/ipc";
import { type ReactNode, useMemo } from "react";
import { Trans, useTranslator } from "../../i18n";
import type { IoView } from "../../lib/call-detail-view";
import {
  messageContentText,
  optionalSectionVisible,
  resolveIoView,
} from "../../lib/call-detail-view";
import { draftBadgeForSpan } from "../../lib/draft-list";
import { formatDuration, prettyJson } from "../../lib/format";
import { isolatedPromptEntryOf } from "../../lib/isolated-prompt";
import { useAppStore } from "../../store";
import { isLongTextExpanded, toggleLongTextExpanded } from "../LongText";
import { LongText } from "../LongText";
import { CacheHitRow, IsolatedParentUnsupportedNotice, KeyValue, Section } from "./DetailShared";
import { IsolatedPromptBranchNavigation } from "./IsolatedPromptEntry";
import { PromptForkEditor } from "./PromptForkEditor";

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
  children?: ReactNode;
}) {
  const translator = useTranslator();
  const { request, response, error } = span;
  // 🔴 失败调用的 usage/ttft 是**占位**（代理录制的失败 llm.call 写 `{in:0,out:0}`
  // 与 ttft_ms=0 表示"没有正文抵达"，不是实测零消耗/零延迟）。delta「代理失败概览
  // 只使用自有已记录诊断」要求：详情展示请求与**占位解释**，不能宣称零成本或成功输出。
  // 所以失败时这三项显示占位文案而不是数字——把 0 印成"0 tokens"会被读成"这次没花钱"。
  const failed = error !== undefined;
  return (
    <>
      <Section title={translator.t("detail.summaryTitle")}>
        <KeyValue
          items={[
            [translator.t("detail.modelLabel"), request.model],
            [
              translator.t("detail.tokensIn"),
              failed ? translator.t("detail.usageFailed") : String(response.usage.in),
            ],
            [
              translator.t("detail.tokensOut"),
              failed ? translator.t("detail.usageFailed") : String(response.usage.out),
            ],
            [
              translator.t("detail.ttftLabel"),
              failed ? translator.t("detail.ttftFailed") : `${response.ttft_ms}ms`,
            ],
            [translator.t("detail.durationLabel"), formatDuration(spanDurationMs(span))],
            [
              translator.t("detail.toolCalls"),
              failed ? translator.t("detail.toolCallsFailed") : String(response.tool_calls.length),
            ],
            ...(draftBadge !== null && draftBadge !== undefined
              ? ([[translator.t("detail.draftLabel"), draftBadge.label]] as Array<[string, string]>)
              : []),
          ]}
        />
        {/* 🔴 缓存命中率同样依赖真实 usage：占位零会让命中率算出一个漂亮的假数字 */}
        {failed ? null : <CacheHitRow usage={response.usage} />}
      </Section>

      {/* 输入/输出切换（任务 5.5）：两半各自完整，切换只是换看哪半 */}
      <div className="flex items-center gap-1 border-t border-gray-200 px-4 py-1.5">
        <span className="mr-1 text-[11px] text-gray-500">{translator.t("detail.viewLabel")}</span>
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
            {translator.t(key === "input" ? "detail.viewInput" : "detail.viewOutput")}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-gray-400">
          {translator.t("detail.ioBothHalvesNote")}
        </span>
      </div>

      {error !== undefined ? (
        <Section title={translator.t("detail.failedCallTitle")}>
          <div className="rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-red-900">
              <span>{translator.t("detail.callFailed")}</span>
              {error.status === undefined ? null : (
                <span className="rounded bg-red-100 px-1 font-code">HTTP {error.status}</span>
              )}
            </div>
            <LongText
              text={error.message}
              label={translator.t("detail.errorDetailLabel")}
              {...longTextProps("error")}
            />
            <div className="mt-1 text-[11px] leading-5 text-red-800">
              <Trans
                i18nKey="detail.errorPlaceholderRich"
                components={{ strong: <span className="font-medium" /> }}
              />
            </div>
          </div>
        </Section>
      ) : null}

      {io === "output" ? (
        <>
          {response.reasoning_content !== null ? (
            <Section title={translator.t("detail.reasoningTitle")}>
              <div className="rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5">
                <LongText
                  text={response.reasoning_content}
                  label={translator.t("detail.reasoningLabel")}
                  {...longTextProps("reasoning")}
                />
              </div>
            </Section>
          ) : null}

          <Section title={translator.t("detail.responseBodyTitle")}>
            {response.content === null || response.content === "" ? (
              <div className="text-[11px] text-gray-400">{emptyContentHint}</div>
            ) : (
              <LongText
                text={response.content}
                label={translator.t("detail.bodyLabel")}
                {...longTextProps("content")}
              />
            )}
          </Section>

          {response.tool_calls.length > 0 ? (
            <Section
              title={translator.t("detail.toolCallsTitle", { count: response.tool_calls.length })}
            >
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
          <Section
            title={translator.t("detail.requestMessagesTitle", { count: request.messages.length })}
          >
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
                    label={translator.t("detail.messageContentLabel")}
                    {...longTextProps(`msg:${index}`)}
                  />
                </div>
              ))}
            </div>
          </Section>

          {optionalSectionVisible(span, "request.tools") ? (
            <Section
              title={translator.t("detail.toolTableTitle", { count: request.tools?.length ?? 0 })}
            >
              <LongText
                text={prettyJson(request.tools)}
                label="tools"
                {...longTextProps("tools")}
              />
            </Section>
          ) : null}

          {optionalSectionVisible(span, "request.params") ? (
            <Section title={translator.t("detail.paramsTitle")}>
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

/** llm.call 详情：完整请求 + 响应（思维链与正文分区）；代理 run 提供编辑重发 */
export function LlmCallDetail({
  span,
  run,
}: { span: Extract<SpanLine, { kind: "llm.call" }>; run: RunDetail | null }) {
  const translator = useTranslator();
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
      ? translator.t("detail.emptyFailed")
      : response.tool_calls.length > 0
        ? translator.t("detail.emptyToolCallsOnly")
        : response.reasoning_content !== null
          ? translator.t("detail.emptyReasoningOnly")
          : translator.t("detail.emptyBody");

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
          // R2.2 6.1：隔离运行分两条入口路——根进入独立初始快照实验（复用本编辑器），
          // 分支只给经验证根的显式导航。普通 run 的既有 prompt fork 完全不变。
          const isolatedPrompt = isolatedPromptEntryOf(run, translator);
          return (
            <>
              {isolatedPrompt === null ? (
                <PromptForkEditor key={span.id} span={span} run={run} />
              ) : isolatedPrompt.kind === "root" ? (
                <PromptForkEditor key={span.id} span={span} run={run} mode="isolated" />
              ) : isolatedPrompt.kind === "branch" ? (
                <IsolatedPromptBranchNavigation detail={run} reason={isolatedPrompt.reason} />
              ) : (
                <div
                  className="border-t border-violet-100 px-4 py-2 text-[11px] leading-5 text-violet-900"
                  data-isolated-prompt-unavailable
                >
                  {isolatedPrompt.reason}
                </div>
              )}
              {/* 模型 A/B 仍不支持隔离父本（根与分支同一门禁；入口在运行级动作栏）。 */}
              {isolatedPrompt === null ? null : <IsolatedParentUnsupportedNotice run={run} />}
            </>
          );
        }
        return (
          <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
            {translator.t("detail.forkFirstCallOnly", { callId: firstLlmId ?? "" })}
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
            {translator.t("detail.editMessagesResend")}
          </button>
          <div className="mt-1 text-[11px] text-gray-400">
            {translator.t("detail.messagesWorkspaceNote")}
          </div>
        </div>
      ) : isProxy && run !== null && run.status === "crashed" ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          {translator.t("detail.crashedNoResend")}
        </div>
      ) : null}
    </LlmCallDetailView>
  );
}
