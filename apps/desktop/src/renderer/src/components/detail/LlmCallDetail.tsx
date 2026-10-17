import type { SpanLine } from "@rebaseagent/trace-sdk";
import { spanDurationMs } from "@shared/derive";
import type { RunDetail } from "@shared/ipc";
import { type ReactNode, useMemo } from "react";
import type { IoView } from "../../lib/call-detail-view";
import {
  messageContentText,
  optionalSectionVisible,
  resolveIoView,
} from "../../lib/call-detail-view";
import { draftBadgeForSpan } from "../../lib/draft-list";
import { formatDuration, prettyJson } from "../../lib/format";
import { isolatedParentExecutionNotice } from "../../lib/isolated-fork";
import { useAppStore } from "../../store";
import { isLongTextExpanded, toggleLongTextExpanded } from "../LongText";
import { LongText } from "../LongText";
import { CacheHitRow, IsolatedParentUnsupportedNotice, KeyValue, Section } from "./DetailShared";
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

/** llm.call 详情：完整请求 + 响应（思维链与正文分区）；代理 run 提供编辑重发 */
export function LlmCallDetail({
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
