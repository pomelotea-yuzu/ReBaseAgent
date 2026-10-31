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

import { deriveTerminalReason } from "@shared/derive";
import type { RunDetail } from "@shared/ipc";
import { classifyOutcome, outcomeBadgeClass } from "@shared/outcome";
import {
  deriveErrorTarget,
  deriveOwnConsumption,
  deriveOwnOutput,
  deriveOwnToolErrors,
} from "@shared/overview";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslator } from "../i18n";
import { formatDuration, formatTokens } from "../lib/format";
import type {
  CacheSection,
  ConsumptionSection,
  LlmErrorSection,
  SourceSection,
} from "../lib/overview-view";
import {
  openCallHint,
  presentCacheCoverage,
  presentConsumption,
  presentLlmError,
  presentOutcome,
  presentResult,
  presentSource,
  presentToolErrors,
} from "../lib/overview-view";
import {
  type PromptExperimentView,
  promptExperimentVerdictNote,
  promptExperimentViewOf,
} from "../lib/prompt-experiment-view";
import { useAppStore } from "../store";
import { LongText, isLongTextExpanded, toggleLongTextExpanded } from "./LongText";
import { IsolatedPromptEntryAction } from "./detail/IsolatedPromptEntry";

/**
 * 复制原文按钮（不复用 IconButton：本处需要"复制成功"的成功态反馈）。
 *
 * 复制的是 `text` 的**完整原文**，与 `LongText` 的折叠状态无关——折叠只影响展示，
 * 不影响可复制的内容（delta「复制 SHALL 对应原始文本而非省略后的展示」）。
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const translator = useTranslator();
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
      title={translator.t("run.copyFullOriginal", { label })}
      aria-label={translator.t("run.copyFullOriginal", { label })}
    >
      {copied ? (
        <Check size={11} aria-hidden="true" focusable="false" role="presentation" />
      ) : (
        <Copy size={11} aria-hidden="true" focusable="false" role="presentation" />
      )}
      <span>{translator.t(copied ? "common.copied" : "common.copyOriginal")}</span>
    </button>
  );
}

/**
 * 结局区（任务 5.2）：把「这次运行为什么停了」放在最前面。
 *
 * 数据全部来自 `classifyOutcome`（唯一判据来源）+ `presentOutcome` 的补充说明——
 * 本组件不重判结局，只负责把既有结论摆出来。
 */
export function OutcomeSectionView({
  status,
  reason,
}: {
  status: "completed" | "crashed";
  reason: string | null;
}) {
  const translator = useTranslator();
  const section = presentOutcome(classifyOutcome({ status, reason }), translator);
  return (
    <section
      className="border-t border-gray-200 px-4 py-3"
      aria-label={translator.t("run.overviewOutcomeAria")}
    >
      <div className="mb-1.5 text-reading-meta font-semibold tracking-wide text-gray-500">
        {translator.t("run.outcomeTitle")}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* 语义色 + 文字：颜色只是辅助，标签本身承载信息 */}
        <span
          className={`inline-flex rounded px-1.5 py-0.5 text-reading-body leading-5 ${outcomeBadgeClass(section.tone)}`}
        >
          {section.label}
        </span>
      </div>
      {section.note !== null ? (
        <div className="mt-1.5 text-reading-body leading-5 text-gray-600">{section.note}</div>
      ) : null}
    </section>
  );
}

/**
 * 自有 LLM 错误区（任务 5.2）。
 *
 * 三分支：可定位 / 缺失说明 / 不出现。**刻意不合并**——`missing` 时给一个指向不了的
 * 按钮比不给更糟，而"不是 error 终止却渲染空错误框"会让用户以为有错误没显示出来。
 */
export function LlmErrorSectionView({
  section,
  onOpenCall,
}: {
  section: LlmErrorSection;
  onOpenCall: (target: { spanId: string; stepSpanId: string | null }) => void;
}) {
  const translator = useTranslator();
  if (section.form === "none") return null;

  return (
    <section
      className="border-t border-gray-200 px-4 py-3"
      aria-label={translator.t("run.overviewLlmErrorAria")}
    >
      <div className="mb-1.5 text-reading-meta font-semibold tracking-wide text-gray-500">
        {translator.t("run.failureReasonTitle")}
      </div>
      {section.form === "located" ? (
        <>
          <div className="rounded border-l-2 border-red-400 bg-red-50/60 px-3 py-2">
            <div className="mb-1 flex flex-wrap items-center gap-x-3 text-reading-meta text-gray-500">
              <span className="font-code" title={translator.t("run.failedCallTitle")}>
                {section.target.spanId}
              </span>
              {section.status !== null ? (
                <span className="font-code">HTTP {section.status}</span>
              ) : (
                // 未记录状态码 ⇒ 不显示"HTTP —"这种像数据的占位
                <span className="text-gray-400">{translator.t("run.httpStatusUnknown")}</span>
              )}
            </div>
            {section.message.length > 0 ? (
              <pre className="whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-red-900">
                {section.message}
              </pre>
            ) : (
              <div className="text-reading-meta text-gray-600">
                {translator.t("run.errorBodyMissing")}
              </div>
            )}
          </div>
          <div className="mt-2">
            <button
              type="button"
              onClick={() => onOpenCall(section.target)}
              className="rounded border border-red-400 px-2 py-0.5 text-reading-meta text-red-800 hover:bg-red-50"
            >
              {translator.t("run.openCallExpandStep")}
            </button>
          </div>
        </>
      ) : (
        <div className="text-reading-body leading-5 text-gray-600">{section.note}</div>
      )}
    </section>
  );
}

/**
 * 自有工具错误区（任务 5.2）。
 *
 * ⚠️ **独立成区、不与 LLM 错误合并**：工具错误是数据，不是终止根因
 * （delta「不断言其为终止根因」）。合并成"本次失败原因"正是 spec 禁止的误归因。
 * 无工具错误时整区不渲染（不摆一个空的"工具错误"标题）。
 */
export function ToolErrorsSectionView({
  rows,
  onOpenCall,
}: {
  rows: ReturnType<typeof presentToolErrors>;
  onOpenCall: (target: { spanId: string; stepSpanId: string | null }) => void;
}) {
  const translator = useTranslator();
  if (rows.length === 0) return null;

  return (
    <section
      className="border-t border-gray-200 px-4 py-3"
      aria-label={translator.t("run.overviewToolErrorsAria")}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-reading-meta font-semibold tracking-wide text-gray-500">
          {translator.t("run.toolErrorsTitle")}
        </span>
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-reading-meta text-amber-800">
          {translator.t("run.timesCount", { count: rows.length })}
        </span>
        {/* 明确它不构成终止原因，避免用户把工具错误当成本次失败根因 */}
        <span className="text-reading-meta text-gray-400">
          {translator.t("run.toolErrorsNotCause")}
        </span>
      </div>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li
            key={row.spanId}
            className="rounded border-l-2 border-amber-400 bg-amber-50/50 px-3 py-1.5"
          >
            <div className="mb-0.5 flex flex-wrap items-center gap-x-3 text-reading-meta text-gray-500">
              <span className="font-medium text-gray-700">{row.tool}</span>
              <span className="font-code">{row.spanId}</span>
              <button
                type="button"
                onClick={() => onOpenCall({ spanId: row.spanId, stepSpanId: row.stepSpanId })}
                className="ml-auto rounded border border-amber-400 px-1.5 py-0.5 text-amber-800 hover:bg-amber-50"
              >
                {translator.t("run.locate")}
              </button>
            </div>
            <pre className="whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-amber-900">
              {row.message}
            </pre>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 本次消耗区（任务 5.3 · design D5）。
 *
 * ⚠️ **口径说明必须显示**：`scopeNote` 钉住"只算自有段、缺失不补零"。这不是装饰——
 *    用户看到 token 数第一反应是"这是总共花的吧"，必须立刻说清它只是**本次自有**记账。
 * ⚠️ **未知与零分开渲染**：`durationMs === null` ⇒ 「未记录时间跨度」（不是 `—`，
 *    更不是 `0`）；`hitTotal === null` ⇒ 「未记录命中量」（不是 0 命中）。
 */
export function ConsumptionSectionView({ section }: { section: ConsumptionSection }) {
  const translator = useTranslator();
  return (
    <section
      className="border-t border-gray-200 px-4 py-3"
      aria-label={translator.t("run.overviewConsumptionAria")}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-reading-meta font-semibold tracking-wide text-gray-500">
          {translator.t("run.overviewConsumptionAria")}
        </span>
        <span className="text-reading-meta text-gray-400">
          {translator.t("run.consumptionOwnNote")}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        <div>
          <dt className="text-reading-meta text-gray-500">{translator.t("run.tokensInLabel")}</dt>
          <dd className="font-code text-reading-body text-gray-800">
            {formatTokens(section.tokensIn)}
          </dd>
        </div>
        <div>
          <dt className="text-reading-meta text-gray-500">{translator.t("run.tokensOutLabel")}</dt>
          <dd className="font-code text-reading-body text-gray-800">
            {formatTokens(section.tokensOut)}
          </dd>
        </div>
        <div>
          <dt className="text-reading-meta text-gray-500">{translator.t("run.durationLabel")}</dt>
          <dd className="font-code text-reading-body text-gray-800">
            {/* 未记录 ⇒ 文字说明，不显示 "—"/0（未知 ≠ 零） */}
            {section.durationMs === null ? (
              <span className="text-gray-400">{translator.t("run.durationUnknown")}</span>
            ) : (
              formatDuration(section.durationMs)
            )}
          </dd>
        </div>
        <div>
          <dt className="text-reading-meta text-gray-500">{translator.t("run.toolCallsLabel")}</dt>
          <dd className="font-code text-reading-body text-gray-800">{section.toolCalls}</dd>
        </div>
        <div>
          <dt className="text-reading-meta text-gray-500">{translator.t("run.toolErrorsLabel")}</dt>
          <dd className="font-code text-reading-body text-gray-800">{section.toolErrors}</dd>
        </div>
      </dl>
      <CacheCoverageView section={section.cache} />
      {section.zeroUsageNote !== null ? (
        <div className="mt-2 rounded border-l-2 border-gray-300 bg-gray-50 px-2 py-1 text-reading-meta text-gray-600">
          {section.zeroUsageNote}
        </div>
      ) : null}
      <div className="mt-2 text-reading-meta text-gray-400">{section.scopeNote}</div>
    </section>
  );
}

/** 缓存覆盖（嵌在消耗区内的子块；与消耗同源，只报已记录范围） */
export function CacheCoverageView({ section }: { section: CacheSection }) {
  const translator = useTranslator();
  return (
    <div className="mt-2 border-t border-gray-100 pt-2">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-reading-meta">
        <span className="text-gray-500">{translator.t("run.cacheHitLabel")}</span>
        {section.hitTotal === null ? (
          // 全无 cache_hit 字段：说"未记录"，**不**显示 0（未知 ≠ 0）
          <span className="text-gray-400">{translator.t("run.cacheHitUnknown")}</span>
        ) : (
          <span className="font-code text-gray-800">{formatTokens(section.hitTotal)}</span>
        )}
      </div>
      <div className="text-reading-meta text-gray-400">{section.note}</div>
    </div>
  );
}

/**
 * 来源区（任务 5.3 · spec「来源和隔离边界保持真实」）。
 *
 * ⚠️ **执行语义按 fork 字段分流**：result 分叉是"共享前缀"，prompt fork / model_params
 *    是"独立执行"——用同一句话盖住两者正是 spec 禁止的"来源关系不一律表示共享执行前缀"。
 *    文案由 `presentSource` 唯一决定，本组件只摆放。
 * ⚠️ **返回父记录入口只在真有父时出现**（`canOpenParent`），根 run 不摆一个点不动的按钮。
 */
export function SourceSectionView({
  section,
  onOpenParent,
  onCompareWithParent,
}: {
  section: SourceSection;
  onOpenParent: (runId: string) => void;
  /** U7 2.1：「与父运行对比」（父左子右）；只在 available 时渲染，不给点不动的按钮 */
  onCompareWithParent?: () => void;
}) {
  const translator = useTranslator();
  return (
    <section
      className="border-t border-gray-200 px-4 py-3"
      aria-label={translator.t("run.overviewSourceAria")}
    >
      <div className="mb-1.5 text-reading-meta font-semibold tracking-wide text-gray-500">
        {translator.t("run.overviewSourceAria")}
      </div>
      {section.parentId !== null ? (
        <div className="mb-1 flex flex-wrap items-center gap-2 text-reading-meta">
          <span className="text-gray-500">{translator.t("run.directParentRun")}</span>
          <span className="font-code text-gray-800" title={translator.t("run.directParentTitle")}>
            {section.parentId}
          </span>
          {section.canOpenParent ? (
            <button
              type="button"
              onClick={() => {
                if (section.parentId !== null) onOpenParent(section.parentId);
              }}
              className="rounded border border-sky-400 px-1.5 py-0.5 text-sky-800 hover:bg-sky-50"
            >
              {translator.t("run.backToParent")}
            </button>
          ) : null}
          {section.compareWithParent === "available" && onCompareWithParent !== undefined ? (
            <button
              type="button"
              onClick={onCompareWithParent}
              aria-label={translator.t("run.compareWithParentAria")}
              className="rounded border border-sky-400 px-1.5 py-0.5 text-sky-800 hover:bg-sky-50"
            >
              {translator.t("run.compareWithParent")}
            </button>
          ) : null}
        </div>
      ) : null}
      {section.editField !== null ? (
        <div className="mb-1 flex flex-wrap items-center gap-2 text-reading-meta">
          <span className="text-gray-500">{translator.t("run.editedFieldLabel")}</span>
          <span className="font-code text-gray-800">{section.editField}</span>
          {section.editLabel !== null ? (
            <span className="text-gray-400">{section.editLabel}</span>
          ) : null}
        </div>
      ) : null}
      <div className="text-reading-body leading-5 text-gray-600">{section.relationNote}</div>
      {section.incompleteNote !== null ? (
        <div
          data-source-incomplete="true"
          className="mt-1.5 break-all rounded border-l-2 border-amber-400 bg-amber-50/60 px-2 py-1 text-reading-meta text-amber-900"
        >
          {section.incompleteNote}
        </div>
      ) : null}
      {section.isolationNote !== null ? (
        <div className="mt-1.5 rounded border-l-2 border-violet-300 bg-violet-50/60 px-2 py-1 text-reading-meta text-violet-900">
          {section.isolationNote}
        </div>
      ) : null}
    </section>
  );
}

/**
 * 结果区纯视图（测试直接喂 props）。
 *
 * 不读 store、不发请求——`onOpenCall` 由调用方接上真实定位动作（选中 span + 展开 step
 * + 切到步骤页），本组件只负责把"用户点了这里"传出去。
 */
/**
 * R2.2 6.6：v3 隔离 prompt 实验的**干预记录**区。
 *
 * 只摆事实：基线/编辑/假设/判据/执行条件 + 实际结局说明。比较入口固定
 * 父左子右（与既有「与父运行对比」同一动作）；导出走本运行文件页的 R2.1
 * 既有确认，不在这里另造导出通道。
 */
export function PromptExperimentSectionView({
  view,
  status,
  onCompareWithBaseline,
  onOpenFiles,
}: {
  readonly view: PromptExperimentView;
  readonly status: "completed" | "crashed";
  readonly onCompareWithBaseline?: () => void;
  readonly onOpenFiles?: () => void;
}) {
  const translator = useTranslator();
  return (
    <section
      className="border-t border-violet-200 bg-violet-50/40 px-4 py-3"
      aria-label={translator.t("run.overviewPromptExperimentAria")}
      data-prompt-experiment-view="true"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-reading-meta font-semibold tracking-wide text-violet-900">
          {translator.t("run.promptExperimentTitle")}
        </span>
        <span className="rounded bg-white px-1.5 py-0.5 text-reading-meta text-violet-800">
          {translator.t("run.editingField", { field: view.fieldLabel })}
        </span>
      </div>
      <div className="grid gap-x-4 gap-y-1 text-reading-meta text-gray-700 sm:grid-cols-2">
        <span>
          <span className="text-gray-400">{translator.t("run.baselineRun")}</span>{" "}
          <span className="font-code">{view.baselineRunId}</span>
        </span>
        <span>
          <span className="text-gray-400">{translator.t("run.baselineCall")}</span>{" "}
          <span className="font-code">{view.baselineLlmSpanId}</span>
        </span>
        <span>
          <span className="text-gray-400">{translator.t("run.initialSnapshot")}</span>{" "}
          <span className="font-code">{view.initialSnapshotId.slice(0, 16)}…</span>
        </span>
        <span>
          <span className="text-gray-400">{translator.t("run.executionModel")}</span>{" "}
          <span className="font-code">{view.execution.model}</span>
        </span>
        <span>
          <span className="text-gray-400">{translator.t("run.paramsLabel")}</span>{" "}
          <span className="font-code">{view.execution.params}</span>
        </span>
        <span>
          <span className="text-gray-400">{translator.t("run.endpointLabel")}</span>{" "}
          <span className="break-all font-code">{view.execution.providerEndpoint}</span>
        </span>
        <span>
          <span className="text-gray-400">{translator.t("run.limitsBudget")}</span>{" "}
          <span className="font-code">
            {translator.t("run.iterationsBudget", {
              iterations: view.execution.maxIterations,
              budget: view.execution.budget,
            })}
          </span>
        </span>
        <span>
          <span className="text-gray-400">{translator.t("run.planFingerprint")}</span>{" "}
          <span className="font-code">{view.execution.configFingerprint.slice(0, 16)}…</span>
        </span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <div className="text-[11px] text-gray-500">{translator.t("common.fieldOldValue")}</div>
          <LongText text={view.originalValue} label={translator.t("run.experimentOldValue")} />
        </div>
        <div>
          <div className="text-[11px] text-gray-500">{translator.t("common.fieldNewValue")}</div>
          <LongText text={view.editedValue} label={translator.t("run.experimentNewValue")} />
        </div>
        <div>
          <div className="text-[11px] text-gray-500">{translator.t("run.hypothesisLabel")}</div>
          {view.hypothesis === null ? (
            <div className="text-reading-meta italic text-gray-400">
              {translator.t("run.notFilled")}
            </div>
          ) : (
            <LongText text={view.hypothesis} label={translator.t("run.experimentHypothesis")} />
          )}
        </div>
        <div>
          <div className="text-[11px] text-gray-500">{translator.t("run.acceptanceLabel")}</div>
          {view.acceptanceCriterion === null ? (
            <div className="text-reading-meta italic text-gray-400">
              {translator.t("run.notFilled")}
            </div>
          ) : (
            <LongText
              text={view.acceptanceCriterion}
              label={translator.t("run.acceptanceCriterion")}
            />
          )}
        </div>
      </div>
      <div
        className="mt-2 rounded border border-violet-200 bg-white px-2 py-1.5 text-reading-meta leading-5 text-violet-900"
        data-prompt-experiment-verdict
      >
        {promptExperimentVerdictNote(
          {
            status,
            acceptanceCriterion: view.acceptanceCriterion,
          },
          translator,
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {onCompareWithBaseline !== undefined ? (
          <button
            type="button"
            onClick={onCompareWithBaseline}
            className="rounded border border-violet-400 bg-white px-2 py-0.5 text-reading-meta text-violet-800 hover:bg-violet-100"
            data-prompt-experiment-compare
          >
            {translator.t("run.compareWithBaseline")}
          </button>
        ) : null}
        {onOpenFiles !== undefined ? (
          <button
            type="button"
            onClick={onOpenFiles}
            className="rounded border border-violet-400 bg-white px-2 py-0.5 text-reading-meta text-violet-800 hover:bg-violet-100"
            data-prompt-experiment-files
          >
            {translator.t("run.openRunFilesExport")}
          </button>
        ) : null}
        <span className="text-[10px] leading-4 text-violet-700">
          {translator.t("run.promptExperimentNote")}
        </span>
      </div>
    </section>
  );
}

export function OverviewResultView({
  detail,
  expanded,
  onToggleExpanded,
  onOpenCall,
  onOpenParent,
  onCompareWithParent,
  onOpenFiles,
  startupPromptAction,
}: {
  detail: Pick<
    RunDetail,
    "spans" | "leafSpanIds" | "status" | "events" | "meta" | "chain" | "completeness" | "lineage"
  >;
  /** 正文块的展开状态（受控，来自 `readingByRun[runId].overviewExpanded`） */
  expanded: string[] | undefined;
  onToggleExpanded: (key: string) => void;
  onOpenCall: (target: { spanId: string; stepSpanId: string | null }) => void;
  onOpenParent: (runId: string) => void;
  /** U7 2.1：「与父运行对比」动作（父左子右）；缺省 = 不渲染该按钮 */
  onCompareWithParent?: () => void;
  /** R2.2 6.6：打开本运行文件页（导出等既有入口的落点）；缺省 = 不渲染 */
  onOpenFiles?: () => void;
  /** R2.2 6.1：隔离根/分支的启动指令入口（普通运行不渲染） */
  startupPromptAction?: ReactNode;
}) {
  const translator = useTranslator();
  // 终止原因走**唯一来源** `deriveTerminalReason`（任务 6.2 提取）：原先本组件内联推导了
  // **两处**，而运行页头干脆传 `reason={null}`、分支树另有一套 ⇒ 四个视图口径分叉。
  // 不读 `meta.status`——那只是"文件是否封存"，不代表本 run 正常结束（design D4）。
  const ownReason = useMemo(
    () => deriveTerminalReason({ status: detail.status, events: detail.events }),
    [detail],
  );

  const own = useMemo(
    () =>
      deriveOwnOutput({
        spans: detail.spans,
        leafSpanIds: detail.leafSpanIds,
        // crashed（无终止事件）⇒ deriveTerminalReason 已归 null，deriveOwnOutput 判为"非正常终止"
        reason: ownReason,
      }),
    [detail, ownReason],
  );

  const presentation = useMemo(() => presentResult(own, translator), [own, translator]);
  const hint = openCallHint(own, presentation, translator);
  const isFinal = presentation.kind === "final";

  // 错误与工具错误（任务 5.2）：全部走上游派生，本组件只摆放
  const errorSection = useMemo(
    () =>
      presentLlmError(
        deriveErrorTarget({
          spans: detail.spans,
          leafSpanIds: detail.leafSpanIds,
          reason: ownReason,
        }),
        translator,
      ),
    [detail, ownReason, translator],
  );
  const toolErrorRows = useMemo(
    () =>
      presentToolErrors(
        deriveOwnToolErrors({ spans: detail.spans, leafSpanIds: detail.leafSpanIds }),
      ),
    [detail],
  );

  // 本次消耗 / 缓存覆盖 / 来源（任务 5.3）：全部走上游派生，本组件只摆放。
  // U6 4.1：ownOnly 时消耗区追加"沿链指标未知"口径、来源区显示缺失说明——判据在
  // `presentConsumption` / `presentSource`（读 detail 的完整性元数据），组件不另判。
  const consumption = useMemo(
    () =>
      presentConsumption(
        deriveOwnConsumption({ spans: detail.spans, leafSpanIds: detail.leafSpanIds }),
        translator,
        {
          lineageIncomplete: detail.completeness === "ownOnly",
        },
      ),
    [detail, translator],
  );
  const source = useMemo(() => presentSource(detail, translator), [detail, translator]);
  const promptExperiment = useMemo(
    () => promptExperimentViewOf(detail.meta, translator),
    [detail.meta, translator],
  );

  return (
    // 任务 7.1 布局修复：概览自带滚动容器（h-full + overflow-y-auto），内容超高时在
    // 自身内滚动，不把所在列撑高；bg-white 让滚动区底部与正文同色，避免露背景色块。
    <div className="h-full overflow-y-auto bg-white" aria-label={translator.t("run.overviewAria")}>
      {/* 0. R2.2 6.1 → 隔离根/分支只在这里给显式入口；普通运行不渲染 */}
      {startupPromptAction ?? null}
      {/* 1. 结束情况：这次运行为什么停了（结局的唯一判据来源是 classifyOutcome） */}
      <OutcomeSectionView status={detail.status} reason={ownReason} />
      {/* R2.2 6.6：v3 隔离 prompt 实验的干预记录与人工判据（普通运行不渲染） */}
      {promptExperiment !== null ? (
        <PromptExperimentSectionView
          view={promptExperiment}
          status={detail.status}
          onCompareWithBaseline={onCompareWithParent}
          onOpenFiles={onOpenFiles}
        />
      ) : null}
      {/* 2. 本次失败原因：自有 LLM 错误 + 定位入口；缺失时只给说明 */}
      <LlmErrorSectionView section={errorSection} onOpenCall={onOpenCall} />
      {/* 3. 结果区 */}
      <section
        className="border-t border-gray-200 px-4 py-3"
        aria-label={translator.t("run.overviewResultAria")}
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-reading-meta font-semibold tracking-wide text-gray-500">
            {presentation.title}
          </span>
          {isFinal ? (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-reading-meta text-emerald-800">
              {translator.t("run.recorded")}
            </span>
          ) : (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-reading-meta text-gray-600">
              {translator.t("common.notRecorded")}
            </span>
          )}
          {presentation.block !== null ? (
            <span className="ml-auto">
              <CopyButton
                text={presentation.block.content}
                label={presentation.blockLabel ?? translator.t("run.bodyLabel")}
              />
            </span>
          ) : null}
        </div>

        {presentation.reason !== null ? (
          <div className="mb-2 text-reading-body leading-5 text-gray-600">
            {presentation.reason}
          </div>
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
              <span className="font-code" title={translator.t("run.producingCallTitle")}>
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
              label={presentation.blockLabel ?? translator.t("run.bodyLabel")}
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
              {translator.t("run.openCallExpandStep")}
            </button>
            {hint !== null ? <span className="text-reading-meta text-gray-500">{hint}</span> : null}
          </div>
        ) : null}

        {presentation.block === null && presentation.openCallTarget === null ? (
          <div className="text-reading-meta text-gray-400">
            {translator.t("run.noOutputNoCall")}
          </div>
        ) : null}
      </section>
      {/* 4. 工具错误：独立成区，不构成终止原因（与 LLM 错误绝不合并） */}
      <ToolErrorsSectionView rows={toolErrorRows} onOpenCall={onOpenCall} />
      {/* 5. 本次消耗 + 缓存覆盖：只算自有段，未知不补零 */}
      <ConsumptionSectionView section={consumption} />
      {/* 6. 来源：真实父本 / 修改字段 / 隔离边界（执行语义按 fork 字段分流） */}
      <SourceSectionView
        section={source}
        onOpenParent={onOpenParent}
        onCompareWithParent={onCompareWithParent}
      />
    </div>
  );
}

/**
 * 概览页 store 薄壳：取当前详情 + 正文展开状态，接上真实定位动作。
 *
 * 定位动作（`onOpenCall`）= 选中该 span + 展开其所属 step + 切到步骤页。三件事都走
 * 既有 store 方法，不新开通道；目标不存在时 `selectSpan` 会在 detail 校验后自然回退。
 */
export function OverviewPanel() {
  const translator = useTranslator();
  const detail = useAppStore((s) => s.detail);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const expanded = useAppStore((s) =>
    selectedRunId === null ? undefined : s.readingOf(selectedRunId).overviewExpanded,
  );
  const setCallReading = useAppStore((s) => s.setCallReading);
  const selectSpan = useAppStore((s) => s.selectSpan);
  const toggleStep = useAppStore((s) => s.toggleStep);
  const setReadingTab = useAppStore((s) => s.setReadingTab);
  const selectRun = useAppStore((s) => s.selectRun);

  if (detail === null) {
    return (
      <div className="px-4 py-6 text-reading-meta text-gray-500">
        {translator.t("run.noRunSelected")}
      </div>
    );
  }

  return (
    <OverviewResultView
      detail={detail}
      expanded={expanded}
      startupPromptAction={<IsolatedPromptEntryAction detail={detail} />}
      onOpenFiles={selectedRunId === null ? undefined : () => setReadingTab(selectedRunId, "files")}
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
      onOpenParent={(runId) => {
        // 走到父记录：既有 selectRun 会按新 run 身份重置阅读位置（读表由 store 管），
        // 这里不自己拼部分状态——让 selectRun 走它已有的加载/校验路径。
        void selectRun(runId);
      }}
      onCompareWithParent={() => {
        if (selectedRunId === null) return;
        void useAppStore.getState().openCompareWithParent(selectedRunId);
      }}
    />
  );
}
