import type { SpanLine } from "@rebaseagent/trace-sdk";
import { spanDurationMs } from "@shared/derive";
import { useMemo } from "react";
import { formatDuration, prettyJson } from "../lib/format";
import { useAppStore } from "../store";

const COLLAPSE_THRESHOLD = 600;

/**
 * 长文本区块：默认折叠（展示前若干字符 + 省略），展开后为完整原文。
 * 不做任何截断丢弃——展开即可看到全部内容。
 */
function LongText({ text, label }: { text: string; label: string }) {
  const collapsed = text.length > COLLAPSE_THRESHOLD;
  if (!collapsed) {
    return (
      <pre className="whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-gray-800">
        {text}
      </pre>
    );
  }
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-[11px] text-gray-500 hover:text-gray-700">
        {label}（{text.length} 字符，点击展开完整内容）
      </summary>
      <pre className="mt-1 whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-gray-800">
        {text}
      </pre>
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-gray-200 px-4 py-3">
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-gray-500">{title}</div>
      {children}
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

/** llm.call 详情：完整请求 + 响应（思维链与正文分区） */
function LlmCallDetail({ span }: { span: Extract<SpanLine, { kind: "llm.call" }> }) {
  const { request, response } = span;
  return (
    <>
      <Section title="概要">
        <KeyValue
          items={[
            ["模型", request.model],
            ["输入 tokens", String(response.usage.in)],
            ["输出 tokens", String(response.usage.out)],
            ["首 token 延迟", `${response.ttft_ms}ms`],
            ["耗时", formatDuration(spanDurationMs(span))],
            ["工具调用", String(response.tool_calls.length)],
          ]}
        />
      </Section>

      {response.reasoning_content !== null ? (
        <Section title="思维链（reasoning_content）">
          <div className="rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5">
            <LongText text={response.reasoning_content} label="思维链" />
          </div>
        </Section>
      ) : null}

      <Section title="响应正文">
        {response.content === null || response.content === "" ? (
          <div className="text-[11px] text-gray-400">（无正文，仅有工具调用）</div>
        ) : (
          <LongText text={response.content} label="正文" />
        )}
      </Section>

      {response.tool_calls.length > 0 ? (
        <Section title={`工具调用（${response.tool_calls.length}）`}>
          <LongText text={prettyJson(response.tool_calls)} label="tool_calls" />
        </Section>
      ) : null}

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
              <LongText text={typeof message.content === "string" ? message.content : prettyJson(message.content)} label="内容" />
            </div>
          ))}
        </div>
      </Section>

      {request.tools !== undefined ? (
        <Section title={`工具表（${request.tools.length}）`}>
          <LongText text={prettyJson(request.tools)} label="tools" />
        </Section>
      ) : null}

      {request.params !== undefined ? (
        <Section title="采样参数">
          <LongText text={prettyJson(request.params)} label="params" />
        </Section>
      ) : null}
    </>
  );
}

/** tool.invoke 详情：入参、结果、错误（错误是数据，不改变 run 状态） */
function ToolInvokeDetail({ span }: { span: Extract<SpanLine, { kind: "tool.invoke" }> }) {
  return (
    <>
      <Section title="概要">
        <KeyValue
          items={[
            ["工具", span.tool],
            ["执行耗时", `${span.dur_ms}ms`],
            ["墙上耗时", formatDuration(spanDurationMs(span))],
          ]}
        />
      </Section>

      {span.error !== null ? (
        <Section title="错误（错误是数据不是异常）">
          <div className="rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5">
            <LongText text={span.error} label="错误信息" />
          </div>
        </Section>
      ) : null}

      <Section title="入参">
        <LongText text={prettyJson(span.args)} label="args" />
      </Section>

      <Section title="结果">
        <LongText text={prettyJson(span.result)} label="result" />
      </Section>
    </>
  );
}

/** 分支提示：前缀来自哪个父 run、分叉点是哪个 span、编辑了什么字段 */
function BranchNotice() {
  const detail = useAppStore((s) => s.detail);
  if (detail === null || detail.chain.length <= 1) return null;

  const hop = detail.chain[detail.chain.length - 1];
  const parentHop = detail.chain[detail.chain.length - 2];
  const fork = hop?.fork ?? null;
  if (fork === null || parentHop === undefined) return null;

  return (
    <div className="border-b border-violet-200 bg-violet-50 px-4 py-2 text-[11px] leading-5 text-violet-900">
      分支 run：
      <span className="font-code"> {parentHop.meta.id} </span>
      的轨迹截至分叉点
      <span className="font-code"> {fork.at_span} </span>
      为共享前缀（来自父 run 文件，本 run 只记录新增 span）。
      <br />
      编辑字段：<span className="font-code">{fork.edit.field}</span>
    </div>
  );
}

export function DetailPanel() {
  const detail = useAppStore((s) => s.detail);
  const selectedSpanId = useAppStore((s) => s.selectedSpanId);

  const span = useMemo(
    () => detail?.spans.find((s) => s.id === selectedSpanId) ?? null,
    [detail, selectedSpanId],
  );

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-white">
      <div className="border-b border-gray-200 px-4 py-2">
        <div className="text-sm font-semibold text-gray-800">详情</div>
        <div className="text-[11px] text-gray-500">
          {span === null ? "选中左侧任意 span 查看原始请求与响应" : `span ${span.id}`}
        </div>
      </div>

      <BranchNotice />

      <div className="flex-1 overflow-y-auto pb-8">
        {span === null ? (
          <div className="px-4 py-6 text-xs text-gray-500">
            {detail === null ? "尚未选择运行。" : "尚未选择 span。"}
          </div>
        ) : span.kind === "llm.call" ? (
          <LlmCallDetail span={span} />
        ) : span.kind === "tool.invoke" ? (
          <ToolInvokeDetail span={span} />
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
