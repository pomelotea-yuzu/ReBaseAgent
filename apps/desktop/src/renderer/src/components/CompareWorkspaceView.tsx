import type { DirectEditEvidence, EditValuePresence } from "@shared/compare-edit-evidence";
import type { DifferentRootComparison } from "@shared/compare-edit-evidence";
import type { CompareDiffGate, SideOutputFacts } from "@shared/compare-output";
import type { ExperimentGate } from "@shared/experiment-records";
import { outcomeBadgeClass } from "@shared/outcome";
import { foldCatalogRows } from "../lib/compare-steps";
import type { SideStepCatalog } from "../lib/compare-steps";
import type { CompareFileEntry } from "../lib/compare-files";
import { LongText } from "./LongText";
import { MonacoDiffEditor } from "./MonacoEditor";
import { ShortIdLabel } from "./ShortIdLabel";

/**
 * U7（improve-branch-comparison）tasks 4.6/4.12：比较工作区的**展示层**。
 *
 * ⚠️ 取值与渲染分离（与 ComparePanel 同纪律）：本包无 jsdom，store 薄壳在
 * `renderToStaticMarkup` 下走 `getServerSnapshot`（恒初始值）⇒ 组件测试喂不进
 * 状态。本组件**只吃 props**——判据全部由容器（CompareWorkspace）派生后传入，
 * 「编辑证据三态呈现」「输出区缺型文案」「折叠摘要」「ownOnly 提示」「diff 门禁
 * 禁用」才能被静态断言直接钉住。
 *
 * 判据来源（desktop-ui delta）：
 * - 「直接父子展示真实编辑前后值」——前后值完整可展开复制 + 方向标注；
 *   隔离显示真实整轮边界，prompt 从头重跑、代理单请求语义可辨；
 * - 「原值缺失未知字段不补空」——unavailable 呈现稳定码与受控原因，
 *   已得一侧的原值/新值仍可读；真实空值与未记录分开（值块不造空串）；
 * - 「多跳兄弟展示逐跳修改链」——逐跳 source→target，不压缩成一次编辑；
 * - 「不同根只核对实际输入配置」——两列事实，未记录如实标注；
 * - 「最终输出不借中间正文或祖先」——最终输出/中间正文/缺失分型分层呈现；
 * - 「长输出独立阅读与合法文本差异」——默认两列独立滚动（各自 overflow）；
 *   只有 diff 门禁就绪才可切只读 Monaco 文本 diff，**同步滚动仅存在于 diff 模式**；
 * - 「重复 span ID 与独立分支不强行对齐」「缺父链仅显示自有步骤」——步骤目录
 *   两侧独立、来源归属与折叠摘要、ownOnly 提示前缀未知。
 */

/** 单侧视图数据（容器派生后传入；不可读侧 facts/catalog 为 null + 受控原因） */
export interface CompareSideViewData {
  readonly side: "left" | "right";
  readonly runId: string;
  /**
   * U7 5.1：会话稳定短 ID（容器从 store 的 ShortIdState 现算）。
   * 标题显示短 ID、「复制」按钮复制完整 ID——左右编号随位置更新但不改变 run 身份。
   */
  readonly shortId: string;
  readonly facts: SideOutputFacts | null;
  readonly unavailableReason: string | null;
  /**
   * U7 5.6/5.7：单侧文件入口判据（能力门禁 + 步骤定位目标）。
   * unavailable 侧为 null（连入口判据都没有）。
   */
  readonly fileEntry: CompareFileEntry | null;
  readonly onOpenFiles: () => void;
  readonly catalog: SideStepCatalog | null;
  readonly folded: boolean;
  readonly selectedSpanId: string | null;
  readonly onToggleFold: () => void;
  readonly onSelectStep: (spanId: string | null) => void;
  readonly onOpenError: (runId: string, spanId: string) => void;
}

/** 编辑证据区数据（容器按关系分型后传入） */
export type EvidenceViewData =
  | {
      readonly kind: "direct";
      readonly evidence: DirectEditEvidence;
      /** 编辑方向相对左右列：源列 → 目标列 */
      readonly direction: "left-to-right" | "right-to-left";
    }
  | {
      readonly kind: "hops";
      readonly chains: readonly {
        runId: string;
        hops: readonly DirectEditEvidence[];
      }[];
    }
  | {
      readonly kind: "different-roots";
      readonly facts: Extract<DifferentRootComparison, { status: "facts" }>;
    }
  | { readonly kind: "incomplete"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      /** 5.11/5.15：模型实验比较（选择集含 model_params 臂且通过/未通过门禁） */
      readonly kind: "experiment";
      readonly gate: ExperimentGate;
      /** gate eligible 时：各臂相对共同父的累计增量（沿链口径；未知为 null） */
      readonly deltas: readonly {
        runId: string;
        tokens: number | null;
        durationMs: number | null;
      }[];
      /** 任一臂记录了副作用放行 ⇒ 顺序执行与外部状态说明 */
      readonly sideEffectsDeclared: boolean;
    };

export interface CompareWorkspaceViewProps {
  readonly pair: { readonly leftRunId: string; readonly rightRunId: string };
  readonly loading: boolean;
  /**
   * U7 5.8：正文容器宽度不足阈值 ⇒ 上下排列（对象标题随每列头部自然重复）；
   * 足够 ⇒ 并排两列独立滚动。判据由容器/外壳按**正文容器宽度**算（design D6）。
   */
  readonly stacked: boolean;
  readonly left: CompareSideViewData;
  readonly right: CompareSideViewData;
  /** 容器派生的只读 diff 门禁（deriveCompareDiffGate） */
  readonly diffGate: CompareDiffGate;
  readonly diffMode: boolean;
  readonly onToggleDiffMode: () => void;
  readonly onSwap: () => void;
  readonly onReturn: () => void;
  /** 5.11：实验比较被拒时「单独打开记录」的入口（selectRun 通路，不恢复资格） */
  readonly onOpenRun: (runId: string) => void;
  /**
   * U7 5.2：切回宽幅指标表的入口（读取对回整个对照集合）。可选——
   * 提供时头部渲染「指标表」按钮（「既有四条指标对照仍可使用」的工作区承载）。
   */
  readonly onOpenMetricsTable?: () => void;
  readonly evidence: EvidenceViewData;
}

/** 任意编辑值的可读文本：字符串原样，其余 JSON 美化（不猜语义） */
function valueToText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** 值的在场呈现：真实值（含空串/null）可展开复制；未记录如实标注 */
function ValueBlock({ presence, label }: { presence: EditValuePresence; label: string }) {
  if (presence.kind === "unrecorded") {
    return (
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-gray-500">{label}</div>
        <div className="text-xs italic text-gray-400">未记录（不是空值）</div>
      </div>
    );
  }
  return (
    <div className="min-w-0 flex-1">
      <div className="text-[11px] text-gray-500">{label}</div>
      <LongText text={valueToText(presence.value)} label={label} />
    </div>
  );
}

const SEMANTICS_LABEL: Record<string, string> = {
  "shared-prefix": "共享父前缀 · 单点编辑",
  "from-scratch": "从头重跑（独立执行，不共享前缀）",
  "single-request": "代理单请求重发（只影响该次请求）",
};

/** 直接父子编辑证据的呈现（verified / unavailable / notApplicable 三态） */
export function DirectEvidenceBlock({
  evidence,
  direction,
}: {
  evidence: DirectEditEvidence;
  direction: "left-to-right" | "right-to-left";
}) {
  const directionLabel = direction === "left-to-right" ? "左列 → 右列" : "右列 → 左列";
  if (evidence.status === "notApplicable") {
    return (
      <div className="rounded bg-gray-50 px-3 py-2 text-xs text-gray-600" aria-label="编辑证据">
        {evidence.reason}
      </div>
    );
  }
  const head = (
    <div className="flex items-center justify-between text-[11px] text-gray-500">
      <span>
        字段「{evidence.field}」 · {directionLabel}（{evidence.sourceRunId} → {evidence.targetRunId}
        ）
      </span>
      <span className="font-code">{evidence.atSpanId}</span>
    </div>
  );
  if (evidence.status === "unavailable") {
    return (
      <div className="rounded bg-amber-50 px-3 py-2" aria-label="编辑证据">
        {head}
        <div className="mt-1 text-xs text-amber-800">
          [{evidence.reasonCode}] {evidence.reason}
        </div>
        <div className="mt-2 flex gap-3">
          <ValueBlock presence={evidence.original} label="原值" />
          <ValueBlock presence={evidence.updated} label="新值" />
        </div>
      </div>
    );
  }
  return (
    <div className="rounded bg-gray-50 px-3 py-2" aria-label="编辑证据">
      {head}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">
          {SEMANTICS_LABEL[evidence.semantics] ?? evidence.semantics}
        </span>
        {evidence.tool !== null ? (
          <span className="text-gray-500">工具结果编辑（工具 {evidence.tool}）——不是文件修改</span>
        ) : null}
        {evidence.variant === "isolated-v2" && evidence.boundaryStep !== null ? (
          <span className="rounded bg-purple-50 px-1.5 py-0.5 text-purple-700">
            隔离整轮边界：第 {evidence.boundaryStep.n} 轮（{evidence.boundaryStep.spanId}）之后续跑
          </span>
        ) : null}
        {evidence.variant === "isolated-v2" && evidence.boundaryStep === null ? (
          <span className="text-gray-500">
            隔离整轮边界：{evidence.resumeAfterStep ?? "未定位"}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex gap-3">
        <ValueBlock presence={evidence.original} label="原值（共同区保留原值）" />
        <ValueBlock presence={evidence.updated} label="新值（fork 编辑值）" />
      </div>
    </div>
  );
}

/**
 * 5.11/5.15：模型实验比较区。
 *
 * - eligible：批次身份（共同父 + 各臂已记录 experimentId 原样）+ 各臂相对父的
 *   累计增量（沿链口径）+ 副作用放行说明（已记录者保留顺序执行与外部状态影响）；
 *   **恒定说明**：不产出臂间差值、胜出臂或最佳模型结论（5.15——交换与多列同样适用）；
 * - ineligible / unverifiable：受控原因 + 「各记录可单独打开」入口（由容器接线）。
 */
function ExperimentEvidenceBlock({
  gate,
  deltas,
  sideEffectsDeclared,
  onOpenRun,
}: {
  gate: ExperimentGate;
  deltas: readonly { runId: string; tokens: number | null; durationMs: number | null }[];
  sideEffectsDeclared: boolean;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <section className="border-t border-gray-200 px-4 py-3" aria-label="模型实验比较">
      <h3 className="text-xs font-medium text-gray-700">模型实验比较（历史记录）</h3>
      {gate.status === "eligible" ? (
        <>
          <div className="mt-1 text-[11px] text-gray-500">
            批次父本 <span className="font-code">{gate.batch?.parentRunId}</span>
            {gate.batch?.experimentIds.some((id) => id !== null) ? (
              <span className="ml-2">
                各臂批次标签：{gate.batch.experimentIds.map((id) => id ?? "（未记录）").join("、")}
              </span>
            ) : (
              <span className="ml-2">各臂未记录批次标签（不伪造同批）</span>
            )}
          </div>
          <dl className="mt-2 space-y-1 text-xs">
            {deltas.map((delta) => (
              <div key={delta.runId} className="flex items-center gap-2">
                <dt className="font-code text-[11px] text-gray-500">{delta.runId}</dt>
                <dd className="text-gray-700">
                  相对父累计增量：
                  {delta.tokens === null ? "未知（不估算）" : `${delta.tokens} tokens`}
                  {delta.durationMs !== null ? ` · ${delta.durationMs} ms` : ""}
                </dd>
              </div>
            ))}
          </dl>
          {sideEffectsDeclared ? (
            <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
              已记录副作用放行：多臂按顺序执行，前一臂的外部状态可能影响后一臂的起点——比较结果按此口径阅读
            </div>
          ) : null}
          <div className="mt-2 text-[11px] text-gray-500">
            仅展示各臂事实与相对父 run
            的累计增量（沿链求和口径）；不产出臂间差值、胜出臂或最佳模型结论——交换左右或改选两臂同样如此
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
            [{gate.code}] {gate.reason}
          </div>
          <div className="mt-1 text-[11px] text-gray-500">
            各记录仍可单独打开（不恢复实验资格、不产生执行授权）：
          </div>
          <div className="mt-1 flex gap-2">
            {deltas.map((delta) => (
              <button
                key={delta.runId}
                type="button"
                aria-label={`打开记录 ${delta.runId}`}
                onClick={() => onOpenRun(delta.runId)}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
              >
                打开 {delta.runId}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** 编辑证据区（容器按关系分型） */
export function EditEvidenceSection({
  data,
  onOpenRun,
}: {
  data: EvidenceViewData;
  onOpenRun: (runId: string) => void;
}) {
  if (data.kind === "experiment") {
    return (
      <ExperimentEvidenceBlock
        gate={data.gate}
        deltas={data.deltas}
        sideEffectsDeclared={data.sideEffectsDeclared}
        onOpenRun={onOpenRun}
      />
    );
  }
  if (data.kind === "direct") {
    return (
      <section className="border-t border-gray-200 px-4 py-3" aria-label="修改证据">
        <h3 className="text-xs font-medium text-gray-700">修改证据</h3>
        <div className="mt-2">
          <DirectEvidenceBlock evidence={data.evidence} direction={data.direction} />
        </div>
      </section>
    );
  }
  if (data.kind === "hops") {
    return (
      <section className="border-t border-gray-200 px-4 py-3" aria-label="修改证据">
        <h3 className="text-xs font-medium text-gray-700">
          修改证据（逐跳来源链，不压缩为一次编辑）
        </h3>
        {data.chains.map((chain) => (
          <div key={chain.runId} className="mt-2">
            <div className="text-[11px] text-gray-500">到 {chain.runId} 的来源路径</div>
            <ol className="mt-1 space-y-1">
              {chain.hops.map((hop, index) => (
                <li key={`${chain.runId}:${hop.status}:${index}`} className="text-xs text-gray-700">
                  {hop.status === "notApplicable" ? (
                    <span className="text-gray-500">{hop.reason}</span>
                  ) : (
                    <span>
                      {hop.sourceRunId} → {hop.targetRunId} · 字段「{hop.field}」 ·{" "}
                      {hop.status === "verified" ? (
                        <span className="text-emerald-700">已核对</span>
                      ) : (
                        <span className="text-amber-700">
                          [{hop.reasonCode}] {hop.reason}
                        </span>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>
    );
  }
  if (data.kind === "different-roots") {
    return (
      <section className="border-t border-gray-200 px-4 py-3" aria-label="修改证据">
        <h3 className="text-xs font-medium text-gray-700">
          不同根：只核对两侧实际输入配置（不声称分叉修改或共同前缀）
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {data.facts.sides.map((side) => (
            <div key={side.runId} className="rounded bg-gray-50 px-3 py-2 text-xs">
              <div className="font-code text-[11px] text-gray-500">{side.runId}</div>
              <dl className="mt-1 space-y-1">
                <div>
                  <dt className="inline text-gray-500">模型： </dt>
                  <dd className="inline font-code">
                    {side.model.kind === "value" ? String(side.model.value) : "未记录"}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">system： </dt>
                  <dd className="inline">
                    {side.systemPrompt.kind === "value"
                      ? String(side.systemPrompt.value)
                      : "未记录"}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">user： </dt>
                  <dd className="inline">
                    {side.userMessage.kind === "value" ? String(side.userMessage.value) : "未记录"}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">参数： </dt>
                  <dd className="inline font-code">
                    {side.params.kind === "value" ? JSON.stringify(side.params.value) : "未记录"}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </section>
    );
  }
  return (
    <section className="border-t border-gray-200 px-4 py-3" aria-label="修改证据">
      <h3 className="text-xs font-medium text-gray-700">修改证据</h3>
      <div className="mt-2 rounded bg-gray-50 px-3 py-2 text-xs text-gray-600">{data.reason}</div>
    </section>
  );
}

const SIDE_LABEL: Record<"left" | "right", string> = { left: "左列", right: "右列" };

/** 单侧输出区（结局 + 最终输出/中间正文 + 错误定位；不可读侧不伪正文） */
export function SideOutputSection({
  side,
  facts,
  unavailableReason,
  onOpenError,
}: {
  side: "left" | "right";
  facts: SideOutputFacts | null;
  unavailableReason: string | null;
  onOpenError: (runId: string, spanId: string) => void;
}) {
  if (facts === null) {
    return (
      <section className="px-3 py-2" aria-label={`${SIDE_LABEL[side]}输出`}>
        <div className="rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          该侧不可读：{unavailableReason ?? "读取失败"}
        </div>
      </section>
    );
  }
  const { output, failure } = facts;
  return (
    <section className="px-3 py-2" aria-label={`${SIDE_LABEL[side]}输出`}>
      <div className="flex items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] ${outcomeBadgeClass(facts.outcome.tone)}`}
        >
          {facts.outcome.label}
        </span>
        <span className="font-code text-[11px] text-gray-400">{facts.runId}</span>
      </div>
      <div className="mt-2">
        {output.finalOutput !== null ? (
          <LongText text={output.finalOutput.content} label="最终输出" />
        ) : (
          <div className="rounded bg-gray-50 px-2 py-1.5 text-xs text-gray-600">
            未记录最终输出
            {output.missingReason !== null ? (
              <span className="text-gray-500">
                （
                {output.missingReason === "no-llm-call"
                  ? "无自有模型调用"
                  : output.missingReason === "has-error"
                    ? "最终调用带错误"
                    : output.missingReason === "pending-tool-calls"
                      ? "有待执行的工具调用"
                      : "无正文"}
                ）
              </span>
            ) : null}
          </div>
        )}
        {output.finalOutput === null && output.latestIntermediate !== null ? (
          <div className="mt-2">
            <div className="text-[11px] text-gray-500">中间正文（不是最终结果）</div>
            <LongText text={output.latestIntermediate.content} label="中间正文" />
          </div>
        ) : null}
      </div>
      {failure.llmCallSpanId !== null ? (
        <div className="mt-2">
          <button
            type="button"
            aria-label={`打开 ${facts.runId} 的失败调用`}
            onClick={() => onOpenError(facts.runId, failure.llmCallSpanId ?? "")}
            className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
          >
            打开失败调用（{failure.llmCallSpanId}）
          </button>
          <span className="ml-2 text-[11px] text-gray-500">{failure.message}</span>
        </div>
      ) : failure.missingDetail ? (
        <div className="mt-2 text-[11px] text-gray-500">错误详情未记录</div>
      ) : null}
    </section>
  );
}

/** 单侧步骤目录（独立成列：来源归属 / 编辑标记 / 折叠摘要 / ownOnly 提示 / 复合定位） */
export function SideStepsSection({
  catalog,
  folded,
  selectedSpanId,
  onToggleFold,
  onSelectStep,
}: {
  catalog: SideStepCatalog | null;
  folded: boolean;
  selectedSpanId: string | null;
  onToggleFold: () => void;
  onSelectStep: (spanId: string | null) => void;
}) {
  if (catalog === null) {
    return (
      <section className="px-3 py-2" aria-label="步骤目录">
        <div className="text-[11px] text-gray-500">该侧不可读：无步骤目录</div>
      </section>
    );
  }
  const view = foldCatalogRows(catalog, folded);
  return (
    <section className="px-3 py-2" aria-label="步骤目录">
      {catalog.prefixUnknown ? (
        <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          祖先缺失：仅显示已校验自有步骤，前缀未知——不按可见链首项推断根
        </div>
      ) : null}
      {catalog.attribution.kind === "unavailable" ? (
        <div className="mb-2 rounded bg-gray-50 px-2 py-1 text-[11px] text-gray-500">
          来源归属不可用：{catalog.attribution.reason}
        </div>
      ) : null}
      <ul className="space-y-0.5" data-testid={`compare-steps-${catalog.runId}`}>
        {view.map((entry, index) =>
          entry.rowKind === "prefix-summary" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 摘要行每侧至多一条且位置稳定，index 仅为 key 唯一性兜底
            <li key={`prefix-summary:${index}`}>
              <button
                type="button"
                aria-label="展开完整前缀"
                onClick={onToggleFold}
                className="w-full rounded bg-gray-100 px-2 py-1 text-left text-[11px] text-gray-600 hover:bg-gray-200"
              >
                共享前缀：{entry.summary.rowCount} 条来自 {entry.summary.sourceRunIds.join("、")}
                {entry.summary.edits.length > 0
                  ? `（含 ${entry.summary.edits.length} 处编辑）`
                  : ""}
                ——点击展开
              </button>
            </li>
          ) : (
            <li key={entry.row.spanId}>
              <button
                type="button"
                aria-pressed={selectedSpanId === entry.row.spanId}
                aria-label={`选中 ${entry.row.spanId}`}
                onClick={() =>
                  onSelectStep(selectedSpanId === entry.row.spanId ? null : entry.row.spanId)
                }
                className={`w-full rounded px-2 py-1 text-left text-xs ${
                  selectedSpanId === entry.row.spanId
                    ? "bg-blue-100 text-blue-900"
                    : "hover:bg-gray-100"
                }`}
                style={{ paddingLeft: `${8 + entry.row.depth * 12}px` }}
              >
                <span className={entry.row.own ? "" : "text-gray-400"}>{entry.row.label}</span>
                {!entry.row.own && entry.row.sourceRunId !== null ? (
                  <span className="ml-1 text-[10px] text-gray-400">
                    来自 {entry.row.sourceRunId}
                  </span>
                ) : null}
                {entry.row.editMarker !== null ? (
                  <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                    编辑点（{entry.row.editMarker.field}）
                  </span>
                ) : null}
                {entry.row.errorKind !== null ? (
                  <span className="ml-1 text-[10px] text-red-600">错误</span>
                ) : null}
              </button>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

/** 比较工作区展示层（只吃 props） */
export function CompareWorkspaceView({
  pair,
  loading,
  stacked,
  left,
  right,
  diffGate,
  diffMode,
  onToggleDiffMode,
  onSwap,
  onReturn,
  onOpenRun,
  onOpenMetricsTable,
  evidence,
}: CompareWorkspaceViewProps) {
  const diffAvailable = diffGate.status === "available";
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="比较工作区">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
        <h2 className="text-sm font-medium text-gray-800">比较</h2>
        <div className="flex items-center gap-2">
          {onOpenMetricsTable !== undefined ? (
            <button
              type="button"
              aria-label="查看指标对照表"
              onClick={onOpenMetricsTable}
              className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              指标表
            </button>
          ) : null}
          <button
            type="button"
            aria-label="切换文本差异"
            onClick={onToggleDiffMode}
            disabled={!diffAvailable}
            title={diffAvailable ? "两侧独立滚动 ↔ 只读文本差异（同步滚动）" : diffGate.reason}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 enabled:hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400"
          >
            {diffMode ? "退出文本差异" : "文本差异"}
          </button>
          <button
            type="button"
            aria-label="交换左右"
            onClick={onSwap}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            交换左右
          </button>
          <button
            type="button"
            aria-label="返回来源"
            onClick={onReturn}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            返回来源
          </button>
        </div>
      </div>
      {loading ? (
        <div className="px-4 py-1 text-[11px] text-gray-500">正在读取比较对象…</div>
      ) : null}
      {diffMode && diffGate.status === "available" ? (
        // 只读文本 diff：同步滚动仅存在于本模式（design D4）；退出即回两列独立滚动
        <div className="min-h-0 flex-1 overflow-hidden p-2" data-testid="compare-diff-panel">
          <MonacoDiffEditor
            height="100%"
            original={diffGate.leftText}
            modified={diffGate.rightText}
            options={{ readOnly: true, renderSideBySide: true }}
            data-testid="compare-diff-editor"
          />
          <div className="px-1 pt-1 text-[11px] text-gray-500">
            {/* U7 5.1：差异标题用会话短 ID（完整 ID 悬停/复制在两侧标题区） */}
            只读文本差异（左侧 {left.shortId} → 右侧 {right.shortId}
            ）：仅双方均有已记录最终输出时可用
          </div>{" "}
        </div>
      ) : (
        <div
          className={`grid flex-1 gap-2 overflow-hidden p-2 ${
            stacked ? "grid-cols-1" : "grid-cols-2"
          }`}
          data-stacked={stacked ? "true" : undefined}
        >
          {[left, right].map((side) => (
            <div
              key={side.side}
              className="flex min-w-0 flex-col overflow-hidden rounded border border-gray-200"
            >
              <div className="border-b border-gray-100 px-3 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-gray-500">{SIDE_LABEL[side.side]}</span>
                  {side.fileEntry !== null ? (
                    <button
                      type="button"
                      aria-label={`打开${SIDE_LABEL[side.side]}文件`}
                      onClick={side.onOpenFiles}
                      disabled={side.fileEntry.kind !== "available"}
                      title={
                        side.fileEntry.kind === "available"
                          ? (side.fileEntry.note ?? "进入该运行自己的 U2 文件页（保留比较对象）")
                          : side.fileEntry.reason
                      }
                      className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 enabled:hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400"
                    >
                      打开文件
                    </button>
                  ) : null}
                </div>
                {/* U7 5.1：比较标题复用会话稳定短 ID + 复制完整 ID（碰撞时延长且不缩短） */}
                <div className="mt-0.5">
                  <ShortIdLabel id={side.runId} shortId={side.shortId} />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* 两列正文各自独立滚动（design D4：默认各侧独立滚动） */}
                <SideOutputSection
                  side={side.side}
                  facts={side.facts}
                  unavailableReason={side.unavailableReason}
                  onOpenError={side.onOpenError}
                />
                <SideStepsSection
                  catalog={side.catalog}
                  folded={side.folded}
                  selectedSpanId={side.selectedSpanId}
                  onToggleFold={side.onToggleFold}
                  onSelectStep={side.onSelectStep}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <EditEvidenceSection data={evidence} onOpenRun={onOpenRun} />
    </div>
  );
}
