import { deriveVerifiedComparison } from "@shared/compare-derive";
import {
  deriveDifferentRootFacts,
  deriveDirectEditEvidence,
  deriveHopChains,
} from "@shared/compare-edit-evidence";
import type { DirectEditEvidence } from "@shared/compare-edit-evidence";
import { deriveCompareDiffGate, deriveSideOutputFacts } from "@shared/compare-output";
import type { CompareDiffGate, SideOutputFacts } from "@shared/compare-output";
import { deriveExperimentGate } from "@shared/experiment-records";
import type { CompareRunItem } from "@shared/ipc";
import { useEffect, useMemo, useState } from "react";
import { deriveCompareFileEntry } from "../lib/compare-files";
import { deriveCompareMetricsTable } from "../lib/compare-metrics";
import { deriveSideStepCatalog } from "../lib/compare-steps";
import type { SideStepCatalog } from "../lib/compare-steps";
import { readingStateOf } from "../lib/reading-state";
import { useAppStore } from "../store";
import { CompareMetricsTable } from "./CompareMetricsTable";
import { CompareWorkspaceView } from "./CompareWorkspaceView";
import type { CompareSideViewData, EvidenceViewData } from "./CompareWorkspaceView";

/**
 * U7（improve-branch-comparison）tasks 4.12 + 5.2：比较工作区的**容器**。
 *
 * 从 store 订阅比较会话（compareRead / comparePair / 复合定位 / 折叠态），
 * 把全部判据派生交给既有纯模块后喂给展示层（展示组件只吃 props）：
 * - **指标表模式**（5.2）：pair 为空或用户切回"指标表"时渲染宽幅指标表——
 *   对照集合（1–4 条）的消费面，数据来自当前已校验比较读取；
 * - **详细比较模式**：双运行正文。只在本 side 结论与 pair **对齐**（runIds 恰为
 *   左右两条且同序）时派生证据——指标表读取的集合尺寸结论不冒充 pair 结论；
 * - 关系分型 → 证据区：common + 直接父子 ⇒ 单条编辑证据；common + 多跳/兄弟 ⇒
 *   逐跳链；unrelated ⇒ 不同根事实对照；incomplete ⇒ 如实说明（不冒充不同根）；
 * - 动作接线：交换（2.2）、返回来源（2.3）、复合定位（4.8）、折叠（4.14）、
 *   打开单侧失败调用（4.5）、模式切换与重试（5.2）。
 *
 * 只读纪律：整条路径零执行通道、零草稿/授权变更（scenario「比较全程只读且
 * 不恢复许可」）；容器不消费比较结论做导航真相源——打开单侧走 runs:get。
 */
export function CompareWorkspace({ stacked = false }: { stacked?: boolean } = {}) {
  const comparePair = useAppStore((s) => s.comparePair);
  const compareRead = useAppStore((s) => s.compareRead);
  const stepSelection = useAppStore((s) => s.compareStepSelection);
  const prefixFolded = useAppStore((s) => s.comparePrefixFolded);
  const swapCompareSides = useAppStore((s) => s.swapCompareSides);
  const returnFromCompare = useAppStore((s) => s.returnFromCompare);
  const selectCompareStep = useAppStore((s) => s.selectCompareStep);
  const toggleComparePrefix = useAppStore((s) => s.toggleComparePrefix);
  const openCompareSideError = useAppStore((s) => s.openCompareSideError);
  const openCompareSideFiles = useAppStore((s) => s.openCompareSideFiles);
  const selectRun = useAppStore((s) => s.selectRun);
  const retryCompareSelectionRead = useAppStore((s) => s.retryCompareSelectionRead);
  const enterCompareSelection = useAppStore((s) => s.enterCompareSelection);
  // U7 5.1：比较标题复用全量已加载记录范围的会话稳定短 ID（与树/运行导航同一实例）
  const runs = useAppStore((s) => s.runs);
  const shortIdState = useAppStore((s) => s.shortIdState);
  const shortIds = shortIdState.update(runs.map((run) => run.id));

  // diff 模式是展示态（容器本地）；换 pair 即退出，避免旧门禁文本滞留新对象
  const [diffMode, setDiffMode] = useState(false);
  const pairKey = comparePair === null ? "" : `${comparePair.leftRunId}\n${comparePair.rightRunId}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 展示态复位刻意只盯 pairKey（setState 稳定）
  useEffect(() => {
    setDiffMode(false);
  }, [pairKey]);

  // U7 5.2：指标表模式（容器本地展示态）。pair 在场时也能切回宽幅指标表阅读
  // "既有四条指标对照"；换 pair 即退出，避免旧集合的表滞留新对象。
  const [tableMode, setTableMode] = useState(false);
  // U7 5.3：指标表内显式选两条的两步挑选（容器本地；不动全局集合，D1）
  const [tablePick, setTablePick] = useState<{ left: string | null; right: string | null }>({
    left: null,
    right: null,
  });
  const openComparePair = useAppStore((s) => s.openComparePair);
  const [pickError, setPickError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 展示态复位刻意只盯 pairKey（setState 稳定）
  useEffect(() => {
    setTableMode(false);
    setTablePick({ left: null, right: null });
    setPickError(null);
  }, [pairKey]);

  /** 两步挑选的提交：两侧齐备才可发（store 侧仍拒绝同 ID / 集合外 id） */
  const submitPick = (): void => {
    if (tablePick.left === null || tablePick.right === null) return;
    void openComparePair(tablePick.left, tablePick.right).then((result) => {
      if (result === "opened") {
        setTablePick({ left: null, right: null });
        setPickError(null);
        setTableMode(false);
        return;
      }
      setPickError("无法打开：两条必须是集合内互异的有效运行（相同 ID 不构成两条比较）");
    });
  };

  /** 切回指标表：把读取对回整个对照集合（1–4 条；同集合幂等不重读） */
  const openMetricsTable = (): void => {
    setTableMode(true);
    const ids = useAppStore.getState().compareIds;
    if (ids.length >= 1) void enterCompareSelection(ids);
  };

  /** 从指标表回到详细比较：把读取对回 pair 两条（模式切换后的再对齐） */
  const backToDetail = (): void => {
    setTableMode(false);
    if (comparePair !== null) {
      void enterCompareSelection([comparePair.leftRunId, comparePair.rightRunId]);
    }
  };

  const conclusion = compareRead.conclusion;
  /** 已采信结论的逐项结果（仅 verified 形态携带 items；rejected 是请求级拒绝） */
  const acceptedItems = useMemo(
    () => (conclusion?.kind === "verified" ? conclusion.items : null),
    [conclusion],
  );

  // U7 5.2：详细比较只消费与 pair 对齐的结论（恰好两条、同序同 id）——
  // 指标表模式的整集合结论不在这里冒充 pair 证据
  const pairAligned =
    comparePair !== null &&
    conclusion !== null &&
    conclusion.kind === "verified" &&
    conclusion.runIds.length === 2 &&
    conclusion.runIds[0] === comparePair.leftRunId &&
    conclusion.runIds[1] === comparePair.rightRunId;

  // ---------- 指标表模式（pair 为空，或用户显式切回） ----------
  if (comparePair === null || tableMode) {
    const model = deriveCompareMetricsTable({ items: acceptedItems, shortIds });
    return (
      <div
        className="flex min-w-0 flex-1 flex-col overflow-hidden outline-none"
        aria-label="比较工作区"
        // U7 5.9：程序化焦点落点（指标表模式同理）
        data-compare-primary="true"
        tabIndex={-1}
      >
        {comparePair !== null ? (
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
            <span className="text-[11px] text-gray-500">
              详细比较对象：左 {comparePair.leftRunId} → 右 {comparePair.rightRunId}
            </span>
            <button
              type="button"
              aria-label="返回详细比较"
              onClick={backToDetail}
              className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              返回详细比较
            </button>
          </div>
        ) : null}
        <CompareMetricsTable
          model={model}
          loading={compareRead.request !== null}
          rejected={
            conclusion?.kind === "rejected"
              ? { code: conclusion.code, reason: conclusion.reason }
              : null
          }
          onRetry={() => {
            void retryCompareSelectionRead();
          }}
          pick={tablePick}
          pickError={pickError}
          onPickSide={(side, runId) => {
            setPickError(null);
            setTablePick((prev) => ({ ...prev, [side]: runId }));
          }}
          onOpenPair={submitPick}
          onClearPick={() => {
            setTablePick({ left: null, right: null });
            setPickError(null);
          }}
        />
      </div>
    );
  }

  // ---------- 详细比较模式 ----------
  if (!pairAligned) {
    // 结论不在场 / 请求级拒绝 / 尚未按 pair 对齐：如实呈现，不冒充、不借旧结论
    return (
      <div
        className="flex min-w-0 flex-1 flex-col overflow-hidden outline-none"
        aria-label="比较工作区"
        data-compare-primary="true"
        tabIndex={-1}
      >
        <div className="px-4 py-2 text-[11px] text-gray-500">正在读取详细比较对象…</div>
        {conclusion?.kind === "rejected" ? (
          <div className="px-4 py-2">
            <div className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
              [{conclusion.code}] {conclusion.reason}
            </div>
            <button
              type="button"
              aria-label="重试详细比较读取"
              onClick={() => {
                void retryCompareSelectionRead();
              }}
              className="mt-2 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              重试读取
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const readyItems = (acceptedItems ?? []).filter(
    (item): item is Extract<CompareRunItem, { status: "ready" }> => item.status === "ready",
  );

  // 关系分型的唯一输入：本次已校验 chainSummaries（unavailable 侧不进输入）
  const verified =
    readyItems.length < 2
      ? null
      : deriveVerifiedComparison(
          readyItems.map((item) => ({ runId: item.runId, chainSummaries: item.chainSummaries })),
        );

  const unavailableReasonOf = (runId: string): string | null => {
    const hit = acceptedItems?.find(
      (candidate) => candidate.status === "unavailable" && candidate.runId === runId,
    );
    return hit !== undefined && hit.status === "unavailable"
      ? `${hit.reason}（${hit.code}）`
      : null;
  };

  const makeSide = (side: "left" | "right", runId: string): CompareSideViewData => {
    const detail = readyItems.find((item) => item.runId === runId)?.detail ?? null;
    // U7 5.6/5.7：单侧文件入口判据（能力门禁 + 步骤定位目标），输入 = 该侧已校验详情
    const reading = readingStateOf(useAppStore.getState().readingByRun, runId);
    const fileEntry = deriveCompareFileEntry({
      detail,
      selectedSpanId: side === "left" ? stepSelection.left : stepSelection.right,
      savedTab: reading.files !== undefined ? "files" : undefined,
    });
    return {
      side,
      runId,
      shortId: shortIds.get(runId) ?? runId,
      facts: detail !== null ? deriveSideOutputFacts(detail) : null,
      unavailableReason: unavailableReasonOf(runId),
      fileEntry,
      onOpenFiles: () => {
        void openCompareSideFiles(side);
      },
      catalog: detail !== null ? deriveSideStepCatalog(detail) : null,
      folded: side === "left" ? prefixFolded.left : prefixFolded.right,
      selectedSpanId: side === "left" ? stepSelection.left : stepSelection.right,
      onToggleFold: () => toggleComparePrefix(side),
      onSelectStep: (spanId) => selectCompareStep(side, spanId),
      onOpenError: (targetRunId, spanId) => {
        void openCompareSideError(targetRunId, spanId);
      },
    };
  };

  const evidence: EvidenceViewData = (() => {
    if (acceptedItems === null || verified === null || readyItems.length < 2) {
      return { kind: "unavailable", reason: "尚无可核对两侧的比较结论" };
    }
    // 5.11/5.15：含 model_params 臂的选择集必须走实验门禁（优先于普通关系分型——
    // 混选/异父不能退回普通不同根规则放行）
    const gate = deriveExperimentGate(acceptedItems);
    if (gate.status !== "notExperiment") {
      const deltas = readyItems.map((item) => {
        const side = verified.sides.find((candidate) => candidate.runId === item.runId);
        return {
          runId: item.runId,
          tokens: side?.deltaFromAncestor?.tokens ?? null,
          durationMs: side?.deltaFromAncestor?.durationMs ?? null,
        };
      });
      const sideEffectsDeclared = readyItems.some((item) => {
        const fork = item.detail.meta.fork;
        if (fork === null || fork.edit.field !== "model_params") return false;
        const value = fork.edit.value as { allowSideEffects?: unknown } | undefined;
        return value?.allowSideEffects === true;
      });
      return { kind: "experiment", gate, deltas, sideEffectsDeclared };
    }
    const unavailableItem = acceptedItems.find((item) => item.status === "unavailable");
    if (unavailableItem !== undefined) {
      return {
        kind: "unavailable",
        reason:
          unavailableItem.status === "unavailable"
            ? `run ${unavailableItem.runId} 不可读（${unavailableItem.code}）：${unavailableItem.reason}`
            : "存在不可读侧",
      };
    }
    if (verified.relation.kind === "incomplete") {
      return {
        kind: "incomplete",
        reason: "共同祖先判定不完整（存在父缺失）：链结论受限，祖先差不计算",
      };
    }
    if (verified.relation.kind === "unrelated") {
      const left = readyItems[0];
      const right = readyItems[1];
      if (left === undefined || right === undefined) {
        return { kind: "unavailable", reason: "可读侧不足两条" };
      }
      const facts = deriveDifferentRootFacts(left, right, verified.relation);
      return facts.status === "facts"
        ? { kind: "different-roots", facts }
        : { kind: "unavailable", reason: facts.reason };
    }
    // common：直接父子 ⇒ 单条证据；否则逐跳链（不压缩成一次编辑）
    const left = readyItems[0];
    const right = readyItems[1];
    if (left !== undefined && right !== undefined) {
      const direct: DirectEditEvidence = deriveDirectEditEvidence(left, right);
      if (direct.status !== "notApplicable") {
        return {
          kind: "direct",
          evidence: direct,
          direction:
            direct.sourceRunId === comparePair?.leftRunId ? "left-to-right" : "right-to-left",
        };
      }
    }
    return {
      kind: "hops",
      chains: deriveHopChains(acceptedItems, verified.relation.ancestorId),
    };
  })();

  const leftData = makeSide("left", comparePair.leftRunId);
  const rightData = makeSide("right", comparePair.rightRunId);
  const leftFacts: SideOutputFacts | null = leftData.facts;
  const rightFacts: SideOutputFacts | null = rightData.facts;
  const diffGate: CompareDiffGate =
    leftFacts !== null && rightFacts !== null
      ? deriveCompareDiffGate(leftFacts, rightFacts)
      : { status: "unavailable", reason: "存在不可读侧：无法进入文本 diff" };

  return (
    <CompareWorkspaceView
      pair={comparePair}
      loading={compareRead.request !== null}
      stacked={stacked}
      left={leftData}
      right={rightData}
      diffGate={diffGate}
      diffMode={diffMode}
      onToggleDiffMode={() => setDiffMode((prev) => !prev)}
      onSwap={() => {
        void swapCompareSides();
      }}
      onReturn={() => {
        void returnFromCompare();
      }}
      onOpenRun={(runId) => {
        // 5.11：单独打开记录 = selectRun 既有通路（离开比较视图保留 pair；不恢复资格）
        void selectRun(runId);
      }}
      onOpenMetricsTable={openMetricsTable}
      evidence={evidence}
    />
  );
}
