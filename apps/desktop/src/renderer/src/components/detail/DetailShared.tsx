import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { RunDetail } from "@shared/ipc";
import { useMemo, useState } from "react";
import { presentCacheHit, presentCacheMiss } from "../../lib/cache-view";
import { deriveDraftList } from "../../lib/draft-list";
import type { ForkCacheHint } from "../../lib/fork-cache-hint";
import { isolatedParentExecutionNotice } from "../../lib/isolated-fork";
import { expandedKeysInclude } from "../../lib/reading-state";
import { useAppStore } from "../../store";
import { requestConfirm } from "../ConfirmDialog";
import { Disclosure } from "../Disclosure";
import { DraftListPanel } from "../DraftListPanel";

/** 详情页通用分区容器（LLM/tool/step 三个纯展示视图共用） */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
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

/** 概要键值对行（LLM/tool/step 三个视图与详情正文共用） */
export function KeyValue({ items }: { items: Array<[string, string]> }) {
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
export function RunDraftListSection({ runId }: { runId: string }) {
  const [expanded, setExpanded] = useState(false);
  const drafts = useAppStore((s) => s.drafts);
  const openDraftAt = useAppStore((s) => s.openDraftAt);
  const discardCallDraft = useAppStore((s) => s.discardCallDraft);
  const discardModelAbDraft = useAppStore((s) => s.discardModelAbDraft);
  const items = useMemo(() => deriveDraftList(drafts, { runId }), [drafts, runId]);
  if (items.length === 0) return null;
  return (
    <section
      data-run-draft-list="true"
      className="border-b border-gray-200 bg-gray-50/60 px-4 py-1"
    >
      <Disclosure
        summary={`本运行草稿（${items.length}）`}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        controlsId={`run-drafts-${runId}`}
      >
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
      </Disclosure>
    </section>
  );
}
