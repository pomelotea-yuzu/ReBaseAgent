import { Editor } from "@monaco-editor/react";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { spanDurationMs } from "@shared/derive";
import type { RunDetail } from "@shared/ipc";
import { useMemo, useState } from "react";
import { formatDuration, prettyJson } from "../lib/format";
import { useAppStore } from "../store";
import { BudgetMap } from "./BudgetMap";

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

/** llm.call 详情：完整请求 + 响应（思维链与正文分区）；代理 run 提供编辑重发 */
function LlmCallDetail({
  span,
  run,
}: { span: Extract<SpanLine, { kind: "llm.call" }>; run: RunDetail | null }) {
  const { request, response } = span;
  const leafOwned = run?.leafSpanIds.includes(span.id) ?? false;
  const isProxy = run?.meta.source?.kind === "proxy";
  const canResend = isProxy === true && leafOwned && run?.status === "completed";
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
              <LongText
                text={
                  typeof message.content === "string"
                    ? message.content
                    : prettyJson(message.content)
                }
                label="内容"
              />
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

      {canResend && run !== null ? (
        <MessagesForkEditor key={span.id} span={span} run={run} />
      ) : isProxy && run !== null && run.status === "crashed" ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          该 run 运行中断（未封存），不允许作为重发起点。
        </div>
      ) : null}
    </>
  );
}

/**
 * 代理 run 的"编辑 messages 重发"（单请求级最小分叉，方案 a）：
 * 编辑 request.messages → 经代理用暂存 key 重发 → 新 fork run。
 * 与 runs:fork（tool.result 编辑重跑）完全独立，走 proxy:fork 通道。
 */
function MessagesForkEditor({
  span,
  run,
}: {
  span: Extract<SpanLine, { kind: "llm.call" }>;
  run: RunDetail;
}) {
  const forking = useAppStore((s) => s.forking);
  const forkError = useAppStore((s) => s.forkError);
  const forkErrorCode = useAppStore((s) => s.forkErrorCode);
  const proxyFork = useAppStore((s) => s.proxyFork);
  const resetFork = useAppStore((s) => s.resetFork);
  const proxy = useAppStore((s) => s.proxy);
  const [open, setOpen] = useState(false);
  // 预填 = 完整 messages 的 JSON 文本
  const [value, setValue] = useState(() => prettyJson(span.request.messages));
  const [parseError, setParseError] = useState<string | null>(null);

  const inProgress = forking === "in_progress";
  const unchanged = value === prettyJson(span.request.messages);

  if (!open) {
    return (
      <div className="border-t border-sky-100 px-4 py-2">
        <button
          type="button"
          onClick={() => {
            resetFork();
            setValue(prettyJson(span.request.messages));
            setParseError(null);
            setOpen(true);
          }}
          className="rounded bg-sky-600 px-2 py-1 text-[11px] text-white hover:bg-sky-700"
        >
          编辑 messages 重发
        </button>
      </div>
    );
  }

  const doResend = (): void => {
    // 提交时解析回结构体；解析失败可见报错，不发请求
    let messages: unknown;
    try {
      messages = JSON.parse(value);
    } catch (e) {
      setParseError(`messages 不是合法 JSON：${(e as Error).message}`);
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      setParseError("messages 必须是非空数组");
      return;
    }
    setParseError(null);
    if (
      !window.confirm(
        "重发将真实调用 upstream 并产生 API 费用；使用的是最近捕获的 key（可能与该 run 录制当时不同）。确认重发？",
      )
    ) {
      return;
    }
    void proxyFork(run.meta.id, span.id, messages as Record<string, unknown>[]);
  };

  return (
    <div className="border-t border-sky-100 bg-sky-50/60 px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-sky-900">编辑 messages 重发</span>
        <span className="text-[10px] text-sky-500">
          单请求级分叉 · 源 run 不会被修改 · 重发使用最近捕获的 key
        </span>
      </div>
      <Editor
        height="200px"
        language="json"
        value={value}
        onChange={(next) => setValue(next ?? "")}
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
      <div className="mt-1.5 text-[10px] leading-4 text-sky-600">
        编辑任意一条消息后重发：model / 工具表 / 采样参数与源 run 一致，仅 messages 使用编辑后的值。
      </div>

      {parseError !== null ? (
        <div className="mt-1 text-[11px] text-red-700">{parseError}</div>
      ) : null}

      {unchanged ? (
        <div className="mt-1 text-[11px] text-amber-700">
          未做任何修改（空 fork 被拒绝），编辑后再重发。
        </div>
      ) : null}

      {forking === "error" ? (
        <div className="mt-1 text-[11px] text-red-700">
          {forkError}
          {forkErrorCode === "PROXY_NO_KEY" ? "（请先把你的应用经代理跑一次，再回来重发）" : ""}
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-end gap-2">
        {inProgress ? (
          <span className="text-[11px] text-sky-600">重发中…（真实 LLM 调用，可能耗时）</span>
        ) : null}
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
          onClick={doResend}
          disabled={inProgress || unchanged || proxy?.running !== true}
          title={proxy?.running !== true ? "代理未运行，请先在设置中启用" : undefined}
          className="rounded bg-sky-600 px-3 py-1 text-[11px] text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          确认重发
        </button>
      </div>
    </div>
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

/** tool.invoke 的"在此重跑"编辑器：改 result → 确认 → runs:fork（唯一写通道） */
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
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => toolMessageText(span));

  const original = toolMessageText(span);
  const unchanged = value === original;
  const inProgress = forking === "in_progress";
  // 语言依据原始文本初探一次（避免编辑过程中语言选项来回闪变）
  const language = useMemo(() => detectResultLanguage(original), [original]);

  if (!open) {
    return (
      <div className="border-t border-violet-100 px-4 py-2">
        <button
          type="button"
          onClick={() => {
            resetFork();
            setValue(original);
            setOpen(true);
          }}
          className="rounded bg-violet-600 px-2 py-1 text-[11px] text-white hover:bg-violet-700"
        >
          在此重跑（时间旅行）
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-violet-100 bg-violet-50/60 px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-violet-900">在此重跑</span>
        <span className="text-[10px] text-violet-500">
          从该工具调用之后重跑 · 父 run 文件不会被修改
        </span>
      </div>
      <Editor
        height="140px"
        language={language}
        value={value}
        onChange={(next) => setValue(next ?? "")}
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
      <div className="mt-1.5 text-[10px] leading-4 text-violet-600">
        以上文本将作为该工具的返回结果重新送入模型；其余上下文（prompt、工具表、此前步骤）与父 run
        完全一致。
      </div>

      {unchanged ? (
        <div className="mt-1 text-[11px] text-amber-700">
          编辑值与原始结果相同（空 fork），需修改后再重跑。
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
          onClick={() => {
            void forkAt(run.meta.id, span.id, value);
          }}
          disabled={inProgress || unchanged}
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
    </>
  );
}

/** 分支提示：前缀来自哪个父 run、分叉点是哪个 span、编辑了什么字段 */
function BranchNotice() {
  const detail = useAppStore((s) => s.detail);
  if (detail === null || detail.chain.length <= 1) return null;
  // 代理分叉 run：不显示"共享前缀"提示（其语义不成立），由父链列表呈现
  if (detail.meta.source?.kind === "proxy") return null;

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

/**
 * 代理分叉的父链列表（分支视图降级形态）：
 * proxy fork 编辑的是 messages，没有 replay 层应用编辑，不做共享前缀拼接
 * （避免"旧 messages 的 llm.call + 新 messages 的 llm.call"混排假时间线）。
 * 逐代 run 列出 + 编辑摘要，点击切换查看。
 */
function ParentChainList() {
  const detail = useAppStore((s) => s.detail);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const selectRun = useAppStore((s) => s.selectRun);
  if (detail === null || detail.meta.source?.kind !== "proxy" || detail.chain.length <= 1) {
    return null;
  }
  return (
    <div className="border-b border-sky-200 bg-sky-50 px-4 py-2 text-[11px] leading-5 text-sky-900">
      <div className="mb-1 font-semibold">分叉链（单请求级编辑重发）</div>
      <div className="flex flex-wrap items-center gap-1">
        {detail.chain.map((hop, index) => {
          const editedMessages = hop.fork?.edit.field === "messages";
          const isLeaf = index === detail.chain.length - 1;
          return (
            <span key={hop.meta.id} className="flex items-center gap-1">
              {index > 0 ? <span className="text-sky-400">→</span> : null}
              <button
                type="button"
                onClick={() => {
                  if (!isLeaf) void selectRun(hop.meta.id);
                }}
                className={`rounded px-1.5 py-0.5 font-code ${
                  isLeaf
                    ? "bg-sky-600 text-white"
                    : "border border-sky-300 bg-white text-sky-800 hover:bg-sky-100"
                }`}
                title={isLeaf ? "当前 run" : "查看该代 run 详情"}
              >
                {hop.meta.id}
              </button>
              {editedMessages ? (
                <span className="text-[10px] text-sky-600">已编辑 messages</span>
              ) : null}
            </span>
          );
        })}
      </div>
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
      <ParentChainList />

      <div className="flex-1 overflow-y-auto pb-8">
        {detail !== null ? <BudgetMap key={detail.meta.id} detail={detail} /> : null}
        {span === null ? (
          <div className="px-4 py-6 text-xs text-gray-500">
            {detail === null ? "尚未选择运行。" : "尚未选择 span。"}
          </div>
        ) : span.kind === "llm.call" ? (
          <LlmCallDetail span={span} run={detail} />
        ) : span.kind === "tool.invoke" ? (
          // key=span.id：切换 span 时重置分叉编辑器的编辑状态
          <ToolInvokeDetail key={span.id} span={span} run={detail} />
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
