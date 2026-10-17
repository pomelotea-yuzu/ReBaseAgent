import type { SpanLine } from "@rebaseagent/trace-sdk";
import { spanDurationMs } from "@shared/derive";
import type { ReactNode } from "react";
import type { IoView } from "../../lib/call-detail-view";
import { messageContentText, optionalSectionVisible } from "../../lib/call-detail-view";
import { formatDuration, prettyJson } from "../../lib/format";
import { LongText } from "../LongText";
import { CacheHitRow, KeyValue, Section } from "./DetailShared";

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
