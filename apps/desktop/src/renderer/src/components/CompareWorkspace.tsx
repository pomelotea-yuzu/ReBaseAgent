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
import { deriveSideStepCatalog } from "../lib/compare-steps";
import type { SideStepCatalog } from "../lib/compare-steps";
import { useAppStore } from "../store";
import { CompareWorkspaceView } from "./CompareWorkspaceView";
import type { CompareSideViewData, EvidenceViewData } from "./CompareWorkspaceView";

/**
 * U7（improve-branch-comparison）tasks 4.12：比较工作区的**容器**。
 *
 * 从 store 订阅比较会话（compareRead / comparePair / 复合定位 / 折叠态），
 * 把全部判据派生交给既有纯模块后喂给展示层（CompareWorkspaceView 只吃 props）：
 * - 关系分型 → 证据区：common + 直接父子 ⇒ 单条编辑证据；common + 多跳/兄弟 ⇒
 *   逐跳链；unrelated ⇒ 不同根事实对照；incomplete ⇒ 如实说明（不冒充不同根）；
 * - 每侧输出事实（4.5）+ diff 门禁（4.6）+ 步骤目录（4.8/4.9）；
 * - 动作接线：交换（2.2）、返回来源（2.3）、复合定位（4.8）、折叠（4.14）、
 *   打开单侧失败调用（4.5 的 openCompareSideError）。
 *
 * 只读纪律：整条路径零执行通道、零草稿/授权变更（scenario「比较全程只读且
 * 不恢复许可」）；容器不消费比较结论做导航真相源——打开单侧走 runs:get。
 */
export function CompareWorkspace() {
  const comparePair = useAppStore((s) => s.comparePair);
  const compareRead = useAppStore((s) => s.compareRead);
  const stepSelection = useAppStore((s) => s.compareStepSelection);
  const prefixFolded = useAppStore((s) => s.comparePrefixFolded);
  const swapCompareSides = useAppStore((s) => s.swapCompareSides);
  const returnFromCompare = useAppStore((s) => s.returnFromCompare);
  const selectCompareStep = useAppStore((s) => s.selectCompareStep);
  const toggleComparePrefix = useAppStore((s) => s.toggleComparePrefix);
  const openCompareSideError = useAppStore((s) => s.openCompareSideError);
  const selectRun = useAppStore((s) => s.selectRun);
  // U7 5.1：比较标题复用全量已加载记录范围的会话稳定短 ID（与树/运行导航同一实例）
  const runs = useAppStore((s) => s.runs);
  const shortIdState = useAppStore((s) => s.shortIdState);
  const shortIds = shortIdState.update(runs.map((run) => run.id));

  // diff 模式是展示态（容器本地）；换 pair 即退出，避免旧门禁文本滞留新对象
  const [diffMode, setDiffMode] = useState(false);
  const pairKey = comparePair === null ? "" : `${comparePair.leftRunId}\n${comparePair.rightRunId}`;
  useEffect(() => {
    setDiffMode(false);
  }, [pairKey]);

  const conclusion = compareRead.conclusion;
  /** 已采信结论的逐项结果（仅 verified 形态携带 items；rejected 是请求级拒绝） */
  const acceptedItems = useMemo(
    () => (conclusion?.kind === "verified" ? conclusion.items : null),
    [conclusion],
  );
  const readyItems = useMemo(
    () =>
      (acceptedItems ?? []).filter(
        (item): item is Extract<CompareRunItem, { status: "ready" }> => item.status === "ready",
      ),
    [acceptedItems],
  );

  // 关系分型的唯一输入：本次已校验 chainSummaries（unavailable 侧不进输入）
  const verified = useMemo(() => {
    if (readyItems.length < 2) return null;
    return deriveVerifiedComparison(
      readyItems.map((item) => ({ runId: item.runId, chainSummaries: item.chainSummaries })),
    );
  }, [readyItems]);

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
    return {
      side,
      runId,
      shortId: shortIds.get(runId) ?? runId,
      facts: detail !== null ? deriveSideOutputFacts(detail) : null,
      unavailableReason: unavailableReasonOf(runId),
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

  const evidence: EvidenceViewData = useMemo(() => {
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
  }, [acceptedItems, verified, readyItems, comparePair]);

  if (comparePair === null) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center" aria-label="比较工作区">
        <div className="rounded bg-gray-50 px-4 py-3 text-xs text-gray-600">
          尚未进入详细比较：从分支树选中详情或概览的「与父运行对比」进入，或在对照集合中加入恰好两条运行
        </div>
      </div>
    );
  }

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
      evidence={evidence}
    />
  );
}
