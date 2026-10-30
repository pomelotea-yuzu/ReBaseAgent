import type { DirectEditEvidence, EditValuePresence } from "@shared/compare-edit-evidence";
import type { DifferentRootComparison } from "@shared/compare-edit-evidence";
import type { CompareDiffGate, SideOutputFacts } from "@shared/compare-output";
import type { ExperimentGate } from "@shared/experiment-records";
import { outcomeBadgeClass } from "@shared/outcome";
import { useTranslator } from "../i18n";
import type { CompareFileEntry } from "../lib/compare-files";
import { foldCatalogRows } from "../lib/compare-steps";
import type { SideStepCatalog } from "../lib/compare-steps";
import { Disclosure } from "./Disclosure";
import { FOCUS_RING } from "./IconButton";
import { LongText } from "./LongText";
import { MonacoDiffEditor } from "./MonacoEditor";
import { ShortIdLabel } from "./ShortIdLabel";
import { WorkspaceHeading } from "./WorkspaceHeading";

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
  /** R2.2 6.4：进入双运行比较文件视图（两侧独立检查点 + 路径并集） */
  readonly onOpenFilesView?: () => void;
  readonly evidence: EvidenceViewData;
  /**
   * UI 密度 change 1.4：修改证据区收起态（true = 收起；容器从 store 接线，
   * 默认收起）。异常/关系未知摘要不受影响（见 EditEvidenceSection）。
   */
  readonly collapsed?: boolean;
  /** 收起/展开回调（受控；提供时才渲染开关） */
  readonly onToggleCollapsed?: () => void;
}

/** 任意编辑值的可读文本：字符串原样，其余 JSON 美化（不猜语义） */
function valueToText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** 值的在场呈现：真实值（含空串/null）可展开复制；未记录如实标注 */
function ValueBlock({ presence, label }: { presence: EditValuePresence; label: string }) {
  const translator = useTranslator();
  if (presence.kind === "unrecorded") {
    return (
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-gray-500">{label}</div>
        <div className="text-xs italic text-gray-400">
          {translator.t("compare.valueUnrecorded")}
        </div>
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

const SEMANTICS_KEY = {
  "shared-prefix": "compare.semanticsSharedPrefix",
  "from-scratch": "compare.semanticsFromScratch",
  "single-request": "compare.semanticsSingleRequest",
} as const;

/** 直接父子编辑证据的呈现（verified / unavailable / notApplicable 三态） */
export function DirectEvidenceBlock({
  evidence,
  direction,
}: {
  evidence: DirectEditEvidence;
  direction: "left-to-right" | "right-to-left";
}) {
  const translator = useTranslator();
  const directionLabel = translator.t(
    direction === "left-to-right" ? "compare.directionLtr" : "compare.directionRtl",
  );
  if (evidence.status === "notApplicable") {
    return (
      <div
        className="rounded bg-gray-50 px-3 py-2 text-xs text-gray-600"
        aria-label={translator.t("compare.evidenceAria")}
      >
        {evidence.reason}
      </div>
    );
  }
  const head = (
    <div className="flex items-center justify-between text-[11px] text-gray-500">
      <span>
        {translator.t("compare.evidenceSummaryDirect", {
          field: evidence.field,
          direction: directionLabel,
        })}{" "}
        ({evidence.sourceRunId} → {evidence.targetRunId})
      </span>
      <span className="font-code">{evidence.atSpanId}</span>
    </div>
  );
  if (evidence.status === "unavailable") {
    return (
      <div
        className="rounded bg-amber-50 px-3 py-2"
        aria-label={translator.t("compare.evidenceAria")}
      >
        {head}
        <div className="mt-1 text-xs text-amber-800">
          [{evidence.reasonCode}] {evidence.reason}
        </div>
        <div className="mt-2 flex gap-3">
          <ValueBlock presence={evidence.original} label={translator.t("compare.originalValue")} />
          <ValueBlock presence={evidence.updated} label={translator.t("compare.updatedValue")} />
        </div>
      </div>
    );
  }
  return (
    <div className="rounded bg-gray-50 px-3 py-2" aria-label={translator.t("compare.evidenceAria")}>
      {head}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">
          {SEMANTICS_KEY[evidence.semantics as keyof typeof SEMANTICS_KEY] !== undefined
            ? translator.t(SEMANTICS_KEY[evidence.semantics as keyof typeof SEMANTICS_KEY])
            : evidence.semantics}
        </span>
        {evidence.tool !== null ? (
          <span className="text-gray-500">
            {translator.t("compare.toolResultEdit", { tool: evidence.tool })}
          </span>
        ) : null}
        {evidence.variant === "isolated-v2" && evidence.boundaryStep !== null ? (
          <span className="rounded bg-purple-50 px-1.5 py-0.5 text-purple-700">
            {translator.t("compare.boundaryStep", {
              n: evidence.boundaryStep.n,
              spanId: evidence.boundaryStep.spanId,
            })}
          </span>
        ) : null}
        {evidence.variant === "isolated-v2" && evidence.boundaryStep === null ? (
          <span className="text-gray-500">
            {translator.t("compare.boundaryUnlocated", {
              step: evidence.resumeAfterStep ?? translator.t("compare.boundaryUnlocatedNone"),
            })}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex gap-3">
        <ValueBlock presence={evidence.original} label={translator.t("compare.originalKept")} />
        <ValueBlock presence={evidence.updated} label={translator.t("compare.updatedFork")} />
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
  const translator = useTranslator();
  return (
    <section
      className="border-t border-gray-200 px-4 py-3"
      aria-label={translator.t("compare.experimentAria")}
    >
      <h3 className="text-xs font-medium text-gray-700">
        {translator.t("compare.experimentTitle")}
      </h3>
      {gate.status === "eligible" ? (
        <>
          <div className="mt-1 text-[11px] text-gray-500">
            {translator.t("compare.batchParent")}{" "}
            <span className="font-code">{gate.batch?.parentRunId}</span>
            {gate.batch?.experimentIds.some((id) => id !== null) ? (
              <span className="ml-2">
                {translator.t("compare.batchLabels", {
                  labels: gate.batch.experimentIds
                    .map((id) => id ?? translator.t("compare.batchLabelUnrecorded"))
                    .join("、"),
                })}
              </span>
            ) : (
              <span className="ml-2">{translator.t("compare.batchUnrecorded")}</span>
            )}
          </div>
          <dl className="mt-2 space-y-1 text-xs">
            {deltas.map((delta) => (
              <div key={delta.runId} className="flex items-center gap-2">
                <dt className="font-code text-[11px] text-gray-500">{delta.runId}</dt>
                <dd className="text-gray-700">
                  {translator.t("compare.experimentDelta", {
                    tokens:
                      delta.tokens === null
                        ? translator.t("compare.experimentUnknownTokens")
                        : `${delta.tokens} tokens`,
                    duration: delta.durationMs !== null ? ` · ${delta.durationMs} ms` : "",
                  })}
                </dd>
              </div>
            ))}
          </dl>
          {sideEffectsDeclared ? (
            <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
              {translator.t("compare.experimentSideEffects")}
            </div>
          ) : null}
          <div className="mt-2 text-[11px] text-gray-500">
            {translator.t("compare.experimentScope")}
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
            [{gate.code}] {gate.reason}
          </div>
          <div className="mt-1 text-[11px] text-gray-500">
            {translator.t("compare.experimentOpenHint")}
          </div>
          <div className="mt-1 flex gap-2">
            {deltas.map((delta) => (
              <button
                key={delta.runId}
                type="button"
                aria-label={translator.t("compare.experimentOpenAria", { runId: delta.runId })}
                onClick={() => onOpenRun(delta.runId)}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
              >
                {translator.t("compare.experimentOpen", { runId: delta.runId })}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** 修改证据区的统一 id（aria-controls；同屏唯一——证据区只有一个） */
const EVIDENCE_CONTROLS_ID = "compare-edit-evidence";

/**
 * 编辑证据区（容器按关系分型）。
 *
 * UI 密度 change 1.4（design D2）：verified 证据体**默认收起**，摘要行 =
 * 「修改证据 · 字段/修改数 · 展开」（场景「修改证据收起释放输出空间」）；
 * 收起只影响证据体，异常/关系未知摘要**始终可见**：
 * - `incomplete` / `unavailable` 分型整体不可收起（evidenceCollapsible=false）；
 * - 逐跳链里 unavailable/notApplicable 的原因行在收起时仍逐条渲染；
 * - direct 的 unavailable/notApplicable 不走收起（整个块就是原因+已得值）。
 *
 * ⚠️ `collapsed`/`onToggleCollapsed` 可选且默认展开——省略时行为与改动前一致
 *    （既有调用点与测试不受影响）；容器从 store 接线（默认收起）。
 */
export function EditEvidenceSection({
  data,
  onOpenRun,
  collapsed = false,
  onToggleCollapsed = undefined,
}: {
  data: EvidenceViewData;
  onOpenRun: (runId: string) => void;
  /** true = 收起证据体（仅对 evidenceCollapsible 的分型生效） */
  collapsed?: boolean;
  /** 提供时渲染展开/收起开关（受控；不提供 = 不可收起） */
  onToggleCollapsed?: () => void;
}) {
  const translator = useTranslator();
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
  const collapsible = onToggleCollapsed !== undefined && evidenceCollapsible(data);
  const showBody = !collapsible || !collapsed;

  const body = (() => {
    if (!showBody) return null;
    if (data.kind === "direct") {
      return (
        <div className="mt-2">
          <DirectEvidenceBlock evidence={data.evidence} direction={data.direction} />
        </div>
      );
    }
    if (data.kind === "hops") {
      return (
        <>
          {data.chains.map((chain) => (
            <div key={chain.runId} className="mt-2">
              <div className="text-[11px] text-gray-500">
                {translator.t("compare.hopsSourcePath", { runId: chain.runId })}
              </div>
              <ol className="mt-1 space-y-1">
                {chain.hops.map((hop, index) => (
                  <li
                    key={`${chain.runId}:${hop.status}:${index}`}
                    className="text-xs text-gray-700"
                  >
                    {hop.status === "notApplicable" ? (
                      <span className="text-gray-500">{hop.reason}</span>
                    ) : (
                      <span>
                        {hop.sourceRunId} → {hop.targetRunId} ·{" "}
                        {translator.t("compare.hopField", { field: hop.field })}
                        {" · "}
                        {hop.status === "verified" ? (
                          <span className="text-emerald-700">
                            {translator.t("compare.hopVerified")}
                          </span>
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
        </>
      );
    }
    if (data.kind === "different-roots") {
      return (
        <div className="mt-2 grid grid-cols-2 gap-3">
          {data.facts.sides.map((side) => (
            <div key={side.runId} className="rounded bg-gray-50 px-3 py-2 text-xs">
              <div className="font-code text-[11px] text-gray-500">{side.runId}</div>
              <dl className="mt-1 space-y-1">
                <div>
                  <dt className="inline text-gray-500">
                    {translator.t("compare.differentRootModel")}
                  </dt>
                  <dd className="inline font-code">
                    {side.model.kind === "value"
                      ? String(side.model.value)
                      : translator.t("common.notRecorded")}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">
                    {translator.t("compare.differentRootSystem")}
                  </dt>
                  <dd className="inline">
                    {side.systemPrompt.kind === "value"
                      ? String(side.systemPrompt.value)
                      : translator.t("common.notRecorded")}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">
                    {translator.t("compare.differentRootUser")}
                  </dt>
                  <dd className="inline">
                    {side.userMessage.kind === "value"
                      ? String(side.userMessage.value)
                      : translator.t("common.notRecorded")}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">
                    {translator.t("compare.differentRootParams")}
                  </dt>
                  <dd className="inline font-code">
                    {side.params.kind === "value"
                      ? JSON.stringify(side.params.value)
                      : translator.t("common.notRecorded")}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      );
    }
    // incomplete / unavailable：原因就是本区块的全部内容，常驻
    return (
      <div className="mt-2 rounded bg-gray-50 px-3 py-2 text-xs text-gray-600">{data.reason}</div>
    );
  })();

  // incomplete / unavailable：异常摘要常驻，不提供收起（设计 D2 明文）。
  // 未接开关的分型保持**原有标题措辞**（诚实框架不因重构丢失——既有用例钉住）。
  if (!collapsible) {
    const heading =
      data.kind === "incomplete"
        ? translator.t("compare.evidenceHeadingIncomplete")
        : data.kind === "unavailable"
          ? translator.t("compare.evidenceHeadingUnavailable")
          : data.kind === "direct"
            ? translator.t("compare.evidenceHeadingDirect")
            : data.kind === "hops"
              ? translator.t("compare.evidenceHeadingHops")
              : translator.t("compare.evidenceHeadingDifferentRoots");
    return (
      <section
        className="border-t border-gray-200 px-4 py-3"
        aria-label={translator.t("compare.evidenceAria")}
      >
        <h3 className="text-xs font-medium text-gray-700">{heading}</h3>
        {body}
      </section>
    );
  }

  const exceptions = data.kind === "hops" ? hopExceptionLines(data, translator) : [];
  return (
    <section
      className="border-t border-gray-200 px-4 py-2"
      aria-label={translator.t("compare.evidenceAria")}
    >
      <Disclosure
        summary={translator.t("compare.evidenceTitle")}
        meta={evidenceSummaryText(data, translator)}
        expanded={!collapsed}
        onToggle={() => onToggleCollapsed?.()}
        controlsId={EVIDENCE_CONTROLS_ID}
      >
        {body}
      </Disclosure>
      {/* 收起时仍常驻的异常/关系未知摘要（设计 D2「缺证据/关系未知摘要仍常驻」） */}
      {!showBody && exceptions.length > 0 ? (
        <div className="mt-1 space-y-0.5 px-1" data-evidence-exceptions="true">
          {exceptions.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 原因行由同一分型派生、位置稳定
            <div key={index} className="text-[11px] leading-4 text-amber-700">
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function sideLabel(side: "left" | "right", translator: ReturnType<typeof useTranslator>): string {
  return translator.t(side === "left" ? "compare.sideLeft" : "compare.sideRight");
}

/**
 * UI 密度 change 1.4（design D2）：修改证据区的**收起判据与摘要文案**（纯函数）。
 *
 * - `evidenceCollapsible`：只有「有完整证据体可收」的分型才可收起（verified 直接
 *   证据 / 逐跳链 / 不同根事实）。`incomplete` / `unavailable` / `notApplicable`
 *   本身就是异常或关系未知摘要——**不可收起**（design D2「缺证据/关系未知摘要仍
 *   常驻」，收起它们等于隐藏异常）。
 * - `evidenceSummaryText`：收起时摘要行上的「字段/修改数」概况（场景 THEN
 *   「字段/方向/修改概况及恢复入口可辨」）。
 */
export function evidenceCollapsible(data: EvidenceViewData): boolean {
  if (data.kind === "direct") return data.evidence.status === "verified";
  return data.kind === "hops" || data.kind === "different-roots";
}

export function evidenceSummaryText(
  data: EvidenceViewData,
  translator: ReturnType<typeof useTranslator>,
): string {
  switch (data.kind) {
    case "direct":
      // verified / unavailable 才有字段与方向（notApplicable 不可收起，摘要不会被用到）
      return data.evidence.status === "verified" || data.evidence.status === "unavailable"
        ? translator.t("compare.evidenceSummaryDirect", {
            field: data.evidence.field,
            direction: translator.t(
              data.direction === "left-to-right" ? "compare.directionLtr" : "compare.directionRtl",
            ),
          })
        : "";
    case "hops": {
      const total = data.chains.reduce((sum, chain) => sum + chain.hops.length, 0);
      return translator.t("compare.evidenceSummaryHops", { count: total });
    }
    case "different-roots":
      return translator.t("compare.evidenceSummaryDifferentRoots");
    case "experiment":
      return translator.t("compare.evidenceSummaryExperiment");
    default:
      return "";
  }
}

/** 逐跳链里收起时仍须常驻的异常/不适用原因行（verified 跳不产生原因行） */
function hopExceptionLines(
  data: Extract<EvidenceViewData, { kind: "hops" }>,
  translator: ReturnType<typeof useTranslator>,
): string[] {
  const lines: string[] = [];
  for (const chain of data.chains) {
    for (const hop of chain.hops) {
      if (hop.status === "notApplicable") {
        // notApplicable 变体只有 reason（无前后 run 字段）
        lines.push(hop.reason);
      } else if (hop.status === "unavailable") {
        lines.push(`${hop.sourceRunId} → ${hop.targetRunId} · [${hop.reasonCode}] ${hop.reason}`);
      }
    }
  }
  return lines;
}

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
  const translator = useTranslator();
  if (facts === null) {
    return (
      <section
        className="px-3 py-2"
        aria-label={translator.t("compare.outputAria", {
          side: sideLabel(side, translator),
        })}
      >
        <div className="rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          {translator.t("compare.sideUnreadable", {
            reason: unavailableReason ?? translator.t("compare.readFailed"),
          })}
        </div>
      </section>
    );
  }
  const { output, failure } = facts;
  return (
    <section
      className="px-3 py-2"
      aria-label={translator.t("compare.outputAria", {
        side: sideLabel(side, translator),
      })}
    >
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
          <LongText text={output.finalOutput.content} label={translator.t("compare.finalOutput")} />
        ) : (
          <div className="rounded bg-gray-50 px-2 py-1.5 text-xs text-gray-600">
            {translator.t("compare.finalOutputMissing")}
            {output.missingReason !== null ? (
              <span className="text-gray-500">
                （
                {output.missingReason === "no-llm-call"
                  ? translator.t("compare.missingNoLlmCall")
                  : output.missingReason === "has-error"
                    ? translator.t("compare.missingHasError")
                    : output.missingReason === "pending-tool-calls"
                      ? translator.t("compare.missingPendingToolCalls")
                      : translator.t("compare.missingNoContent")}
                ）
              </span>
            ) : null}
          </div>
        )}
        {output.finalOutput === null && output.latestIntermediate !== null ? (
          <div className="mt-2">
            <div className="text-[11px] text-gray-500">{translator.t("compare.intermediate")}</div>
            <LongText
              text={output.latestIntermediate.content}
              label={translator.t("compare.intermediateLabel")}
            />
          </div>
        ) : null}
      </div>
      {failure.llmCallSpanId !== null ? (
        <div className="mt-2">
          <button
            type="button"
            aria-label={translator.t("compare.openFailureAria", { runId: facts.runId })}
            onClick={() => onOpenError(facts.runId, failure.llmCallSpanId ?? "")}
            className={`rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 ${FOCUS_RING}`}
          >
            {translator.t("compare.openFailure", { spanId: failure.llmCallSpanId })}
          </button>
          <span className="ml-2 text-[11px] text-gray-500">{failure.message}</span>
        </div>
      ) : failure.missingDetail ? (
        <div className="mt-2 text-[11px] text-gray-500">
          {translator.t("compare.errorDetailMissing")}
        </div>
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
  const translator = useTranslator();
  if (catalog === null) {
    return (
      <section className="px-3 py-2" aria-label={translator.t("compare.stepsAria")}>
        <div className="text-[11px] text-gray-500">{translator.t("compare.stepsUnreadable")}</div>
      </section>
    );
  }
  const view = foldCatalogRows(catalog, folded);
  return (
    <section className="px-3 py-2" aria-label={translator.t("compare.stepsAria")}>
      {catalog.prefixUnknown ? (
        <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          {translator.t("compare.prefixUnknown")}
        </div>
      ) : null}
      {catalog.attribution.kind === "unavailable" ? (
        <div className="mb-2 rounded bg-gray-50 px-2 py-1 text-[11px] text-gray-500">
          {translator.t("compare.attributionUnavailable", {
            reason: catalog.attribution.reason,
          })}
        </div>
      ) : null}
      <ul className="space-y-0.5" data-testid={`compare-steps-${catalog.runId}`}>
        {view.map((entry, index) =>
          entry.rowKind === "prefix-summary" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 摘要行每侧至多一条且位置稳定，index 仅为 key 唯一性兜底
            <li key={`prefix-summary:${index}`}>
              <button
                type="button"
                aria-label={translator.t("compare.expandPrefix")}
                onClick={onToggleFold}
                className={`w-full rounded bg-gray-100 px-2 py-1 text-left text-[11px] text-gray-600 hover:bg-gray-200 ${FOCUS_RING}`}
              >
                {translator.t("compare.prefixSummary", {
                  rows: entry.summary.rowCount,
                  sources: entry.summary.sourceRunIds.join("、"),
                  edits:
                    entry.summary.edits.length > 0
                      ? translator.t("compare.prefixEdits", {
                          count: entry.summary.edits.length,
                        })
                      : "",
                })}
              </button>
            </li>
          ) : (
            <li key={entry.row.spanId}>
              <button
                type="button"
                aria-pressed={selectedSpanId === entry.row.spanId}
                aria-label={translator.t("compare.selectSpan", { spanId: entry.row.spanId })}
                onClick={() =>
                  onSelectStep(selectedSpanId === entry.row.spanId ? null : entry.row.spanId)
                }
                className={`w-full rounded px-2 py-1 text-left text-xs ${
                  selectedSpanId === entry.row.spanId
                    ? "bg-blue-100 text-blue-900"
                    : "hover:bg-gray-100"
                } ${FOCUS_RING}`}
                style={{ paddingLeft: `${8 + entry.row.depth * 12}px` }}
              >
                <span className={entry.row.own ? "" : "text-gray-400"}>{entry.row.label}</span>
                {!entry.row.own && entry.row.sourceRunId !== null ? (
                  <span className="ml-1 text-[10px] text-gray-400">
                    {translator.t("compare.fromSource", {
                      sourceRunId: entry.row.sourceRunId,
                    })}
                  </span>
                ) : null}
                {entry.row.editMarker !== null ? (
                  <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                    {translator.t("compare.editPoint", {
                      field: entry.row.editMarker.field,
                    })}
                  </span>
                ) : null}
                {entry.row.errorKind !== null ? (
                  <span className="ml-1 text-[10px] text-red-600">
                    {translator.t("compare.errorBadge")}
                  </span>
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
  onOpenFilesView,
  evidence,
  collapsed = false,
  onToggleCollapsed = undefined,
}: CompareWorkspaceViewProps) {
  const translator = useTranslator();
  const diffAvailable = diffGate.status === "available";
  return (
    <div
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-white outline-none"
      aria-label={translator.t("compare.workspaceAria")}
      // U7 5.9：程序化焦点落点——从单侧运行「返回比较」后焦点回到比较头部（不落页顶）
      data-compare-primary="true"
      tabIndex={-1}
    >
      <div className="shrink-0 border-b border-gray-200 px-4 py-2">
        <WorkspaceHeading
          title={<h2 className="text-sm text-gray-800">{translator.t("compare.heading")}</h2>}
          target={
            diffMode ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>
                  {translator.t("compare.diffSideLeftLabel")}{" "}
                  <ShortIdLabel id={left.runId} shortId={left.shortId} />
                </span>
                <span>→</span>
                <span>
                  {translator.t("compare.diffSideRightLabel")}{" "}
                  <ShortIdLabel id={right.runId} shortId={right.shortId} />
                </span>
              </span>
            ) : undefined
          }
          summary={
            diffMode ? (
              <span className="text-gray-500">{translator.t("compare.diffSummary")}</span>
            ) : undefined
          }
          details={
            diffMode ? (
              <p className="py-1 text-reading-meta text-gray-500">
                {translator.t("compare.diffDetails")}
              </p>
            ) : undefined
          }
          actions={
            <>
              {onOpenFilesView !== undefined ? (
                <button
                  type="button"
                  aria-label={translator.t("compare.filesAria")}
                  onClick={onOpenFilesView}
                  className={`rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                >
                  {translator.t("compare.filesAction")}
                </button>
              ) : null}
              {onOpenMetricsTable !== undefined ? (
                <button
                  type="button"
                  aria-label={translator.t("compare.metricsOpenAria")}
                  onClick={onOpenMetricsTable}
                  className={`rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                >
                  {translator.t("compare.metricsAction")}
                </button>
              ) : null}
              <button
                type="button"
                aria-label={translator.t("compare.toggleDiffAria")}
                onClick={onToggleDiffMode}
                disabled={!diffAvailable}
                title={
                  diffAvailable
                    ? translator.t("compare.toggleDiffTitle")
                    : `${translator.t("compare.diffUnavailable")}${diffGate.reason}`
                }
                className={`rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 enabled:hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400 ${FOCUS_RING}`}
              >
                {translator.t(diffMode ? "compare.exitDiff" : "compare.toggleDiff")}
              </button>
              <button
                type="button"
                aria-label={translator.t("compare.swapAria")}
                onClick={onSwap}
                className={`rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
              >
                {translator.t("compare.swap")}
              </button>
              <button
                type="button"
                aria-label={translator.t("compare.returnAria")}
                onClick={onReturn}
                className={`rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
              >
                {translator.t("compare.return")}
              </button>
            </>
          }
        />
      </div>
      {loading ? (
        <div className="px-4 py-1 text-[11px] text-gray-500">{translator.t("compare.loading")}</div>
      ) : null}
      {diffMode && diffGate.status === "available" ? (
        // 只读文本 diff：同步滚动仅存在于本模式（design D4）；退出即回两列独立滚动。
        // min-h-[200px]：与文件页 2.1 高度链同款挤压下限——zoom2（200% 缩放）档 flex 链
        // `min-h-0 flex-1` 曾把编辑器压到 49.7px（4.2 实测），200px 兜底保证极端视口下正文仍可读。
        <div className="min-h-[200px] flex-1 overflow-hidden p-2" data-testid="compare-diff-panel">
          <MonacoDiffEditor
            height="100%"
            data-monaco-host="compare-diff"
            data-monaco-target={`${left.runId}:${right.runId}:text-diff`}
            original={diffGate.leftText}
            modified={diffGate.rightText}
            options={{ readOnly: true, renderSideBySide: true }}
            data-testid="compare-diff-editor"
          />
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
                  <span className="text-[11px] text-gray-500">
                    {sideLabel(side.side, translator)}
                  </span>
                  {side.fileEntry !== null ? (
                    <button
                      type="button"
                      aria-label={translator.t("compare.openSideFilesAria", {
                        side: sideLabel(side.side, translator),
                      })}
                      onClick={side.onOpenFiles}
                      disabled={side.fileEntry.kind !== "available"}
                      title={
                        side.fileEntry.kind === "available"
                          ? (side.fileEntry.note ?? translator.t("compare.fileEntryNote"))
                          : side.fileEntry.reason
                      }
                      className={`rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 enabled:hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400 ${FOCUS_RING}`}
                    >
                      {translator.t("compare.openFiles")}
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
      <EditEvidenceSection
        data={evidence}
        onOpenRun={onOpenRun}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
      />
    </div>
  );
}
