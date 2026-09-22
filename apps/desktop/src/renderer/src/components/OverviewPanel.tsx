/**
 * 概览页（U1 任务 5.1 · design D1/D4/D7）。
 *
 * 本任务只做「结果区」：正常结束直接看到最终输出、未记录最终输出时分型说明、
 * 中间输出不冒充结果、输出安全呈现且可复制原文。
 *
 * 刻意**不**做（归 5.2/5.3）：错误定位区、限制/中止区、本次消耗与缓存覆盖、父本来源。
 * 留白比占位好——先摆一个"本次消耗 —"的空壳，用户会以为数据缺失是 bug。
 *
 * ⚠️ 安全呈现（design D7）不是"过滤"，是**渲染方式**：正文一律作为 React 文本节点
 *    渲染（`{text}`），从不 `dangerouslySetInnerHTML`，也不渲染 `<img>`/`<iframe>`。
 *    因此模型输出里的 `<script>` / `<img src=...>` / 宿主路径会**原样显示成字面文字**，
 *    既不会执行也不会外联。这条纪律由 `overview-view.test.ts` 的源码级断言钉住。
 *
 * ⚠️ 取值与渲染分离（`OverviewResultView`）：本包无 jsdom，且 zustand v5 在
 *    `renderToStaticMarkup` 下走 `getServerSnapshot`（恒为初始值）⇒ 组件测试喂不进
 *    store 状态。故把"数据 → 视图"抽成纯展示组件，配 store 薄壳在真实应用里用。
 */

import type { RunDetail } from "@shared/ipc";
import { deriveOwnOutput } from "@shared/overview";
import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { openCallHint, presentResult } from "../lib/overview-view";
import { useAppStore } from "../store";
import { LongText, isLongTextExpanded, toggleLongTextExpanded } from "./LongText";

/**
 * 复制原文按钮（不复用 IconButton：本处需要"复制成功"的成功态反馈）。
 *
 * 复制的是 `text` 的**完整原文**，与 `LongText` 的折叠状态无关——折叠只影响展示，
 * 不影响可复制的内容（delta「复制 SHALL 对应原始文本而非省略后的展示」）。
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            // 2s 后复原；不清理也没关系（下一次点击重置），但保持状态干净
            window.setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => {
            // 剪贴板不可用（无安全上下文/权限被拒）：不假装成功
            setCopied(false);
          });
      }}
      className="inline-flex items-center gap-1 rounded border border-gray-300 px-1.5 py-0.5 text-reading-meta text-gray-600 hover:bg-gray-50"
      title={`复制${label}完整原文`}
      aria-label={`复制${label}完整原文`}
    >
      {copied ? (
        <Check size={11} aria-hidden="true" focusable="false" role="presentation" />
      ) : (
        <Copy size={11} aria-hidden="true" focusable="false" role="presentation" />
      )}
      <span>{copied ? "已复制" : "复制原文"}</span>
    </button>
  );
}

/**
 * 结果区纯视图（测试直接喂 props）。
 *
 * 不读 store、不发请求——`onOpenCall` 由调用方接上真实定位动作（选中 span + 展开 step
 * + 切到步骤页），本组件只负责把"用户点了这里"传出去。
 */
export function OverviewResultView({
  detail,
  expanded,
  onToggleExpanded,
  onOpenCall,
}: {
  detail: Pick<RunDetail, "spans" | "leafSpanIds" | "status" | "events">;
  /** 正文块的展开状态（受控，来自 `readingByRun[runId].overviewExpanded`） */
  expanded: string[] | undefined;
  onToggleExpanded: (key: string) => void;
  onOpenCall: (target: { spanId: string; stepSpanId: string | null }) => void;
}) {
  const own = useMemo(() => {
    // 自有终止原因：取**最后一条** `run.event` 的 reason（无终止事件 ⇒ status=crashed
    // ⇒ null）。不读 meta.status——那只是"文件是否封存"，不代表本 run 正常结束（design D4）。
    const events = detail.events.filter((event) => event.type === "run.event");
    const last = events[events.length - 1];
    const reason = last === undefined || last.type !== "run.event" ? null : last.reason;
    return deriveOwnOutput({
      spans: detail.spans,
      leafSpanIds: detail.leafSpanIds,
      // crashed（无终止事件）⇒ reason=null，deriveOwnOutput 会判为"非正常终止"
      reason: detail.status === "crashed" ? null : reason,
    });
  }, [detail]);

  const presentation = useMemo(() => presentResult(own), [own]);
  const hint = openCallHint(own, presentation);
  const isFinal = presentation.kind === "final";

  return (
    <section className="border-t border-gray-200 px-4 py-3" aria-label="运行结果">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-reading-meta font-semibold tracking-wide text-gray-500">
          {presentation.title}
        </span>
        {isFinal ? (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-reading-meta text-emerald-800">
            已记录
          </span>
        ) : (
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-reading-meta text-gray-600">
            未记录
          </span>
        )}
        {presentation.block !== null ? (
          <span className="ml-auto">
            <CopyButton
              text={presentation.block.content}
              label={presentation.blockLabel ?? "正文"}
            />
          </span>
        ) : null}
      </div>

      {presentation.reason !== null ? (
        <div className="mb-2 text-reading-body leading-5 text-gray-600">{presentation.reason}</div>
      ) : null}

      {presentation.block !== null ? (
        <div
          className={
            isFinal
              ? "rounded border-l-2 border-emerald-400 bg-emerald-50/60 px-3 py-2"
              : "rounded border-l-2 border-amber-400 bg-amber-50/60 px-3 py-2"
          }
        >
          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-reading-meta text-gray-500">
            <span>{presentation.blockLabel}</span>
            <span className="font-code" title="产出该正文的调用">
              {presentation.block.spanId}
            </span>
            <span className="font-code">{presentation.block.model}</span>
          </div>
          {/*
            正文安全呈现：`LongText` 内部一律用 <pre>{text}</pre>，是 React 文本节点，
            模型输出里的标签/脚本只会显示成字面量。**不得**在此改成 Markdown 渲染。
          */}
          <LongText
            text={presentation.block.content}
            label={presentation.blockLabel ?? "正文"}
            expanded={isLongTextExpanded(expanded, "overview-result")}
            onToggle={() => onToggleExpanded("overview-result")}
          />
        </div>
      ) : null}

      {presentation.openCallTarget !== null ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const target = presentation.openCallTarget;
              if (target !== null) onOpenCall(target);
            }}
            className="rounded border border-sky-400 px-2 py-0.5 text-reading-meta text-sky-800 hover:bg-sky-50"
          >
            打开该调用并展开所属 step
          </button>
          {hint !== null ? <span className="text-reading-meta text-gray-500">{hint}</span> : null}
        </div>
      ) : null}

      {presentation.block === null && presentation.openCallTarget === null ? (
        <div className="text-reading-meta text-gray-400">
          没有可展示的输出，也没有可定位的调用。
        </div>
      ) : null}
    </section>
  );
}

/**
 * 概览页 store 薄壳：取当前详情 + 正文展开状态，接上真实定位动作。
 *
 * 定位动作（`onOpenCall`）= 选中该 span + 展开其所属 step + 切到步骤页。三件事都走
 * 既有 store 方法，不新开通道；目标不存在时 `selectSpan` 会在 detail 校验后自然回退。
 */
export function OverviewPanel() {
  const detail = useAppStore((s) => s.detail);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const expanded = useAppStore((s) =>
    selectedRunId === null ? undefined : s.readingOf(selectedRunId).overviewExpanded,
  );
  const setCallReading = useAppStore((s) => s.setCallReading);
  const selectSpan = useAppStore((s) => s.selectSpan);
  const toggleStep = useAppStore((s) => s.toggleStep);
  const setReadingTab = useAppStore((s) => s.setReadingTab);

  if (detail === null) {
    return <div className="px-4 py-6 text-reading-meta text-gray-500">尚未选择运行。</div>;
  }

  return (
    <OverviewResultView
      detail={detail}
      expanded={expanded}
      onToggleExpanded={(key) => {
        if (selectedRunId === null) return;
        setCallReading(selectedRunId, "__overview__", {
          expanded: toggleLongTextExpanded(expanded, key),
        });
      }}
      onOpenCall={(target) => {
        if (selectedRunId === null) return;
        if (target.stepSpanId !== null) {
          // 展开所属 step（`toggleStep` 是翻转语义，故只在未展开时调用——不擅自收起）
          const stepOpen = useAppStore.getState().expandedSteps[target.stepSpanId] === true;
          if (!stepOpen) toggleStep(target.stepSpanId);
        }
        selectSpan(target.spanId);
        setReadingTab(selectedRunId, "steps");
      }}
    />
  );
}
