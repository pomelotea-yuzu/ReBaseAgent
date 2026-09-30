import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { RunDetail } from "@shared/ipc";
import { isIsolatedRun } from "./isolated-fork";
import { validateCheckpointStepId } from "./workspace-files";

/**
 * U7（improve-branch-comparison）任务 5.6/5.7：比较工作区**单侧文件入口**的纯判据。
 *
 * 判据来源（desktop-ui delta「比较文件入口保持单运行合法检查点」）：
 * - 比较只提供**分别**打开左右运行文件页的入口，使用各自 U2 文件阅读状态与
 *   合法自有检查点；不得创建跨运行文件 diff 页签、借祖先/兄弟步骤或源目录补历史；
 * - 仅对应隔离运行具备**自有文件能力**（v2 且带 meta.workspace）时可用；
 *   普通运行不生成文件历史（无文件能力 ⇒ 明确说明不适用，不造入口）；
 * - 从步骤打开时，**仅合法自有完成步骤**能成为定位目标（leafSpanIds 内的
 *   agent.step）；否则说明原因并使用该 run 已保存合法位置或 U2 默认位置；
 * - ownOnly（父链不完整）不封禁合法自有文件——检查点判据只看 leafSpanIds。
 *
 * ⚠️ 本层只产出"入口可用性与定位目标"；真正的检查点/路径校验与失效回退
 *    仍由 U2 的 `validateCheckpointStepId` / 文件面板原样执行（不抄第二份）。
 */

/** 单侧文件入口判据结论 */
export type CompareFileEntry =
  | {
      readonly kind: "available";
      /**
       * 显式定位目标（null = 不写检查点，走 U2 的已保存位置/默认规则）。
       * 仅当该侧当前选中的比较步骤是**合法自有完成步骤**时才非 null。
       */
      readonly targetCheckpointStepId: string | null;
      /** 目标定位说明（为何用/不用该步骤；呈现给用户） */
      readonly note: string | null;
    }
  /** 普通运行（v1 或无 workspace）：无自有文件能力，不造文件历史 */
  | { readonly kind: "not-isolated"; readonly reason: string }
  /** 该侧不可读：没有已校验详情可供能力判据 */
  | { readonly kind: "unavailable"; readonly reason: string };

export function deriveCompareFileEntry(input: {
  /** 该侧 ready 详情（unavailable 侧传 null） */
  detail: RunDetail | null;
  /** 该侧当前的比较步骤选中（复合定位）；null = 未选 */
  selectedSpanId: string | null;
  /** 该 run 已保存的文件页签（来自 U2 阅读状态；undefined = 未进过文件页） */
  savedTab: string | undefined;
}): CompareFileEntry {
  const { detail } = input;
  if (detail === null) {
    return { kind: "unavailable", reason: "该侧不可读：无已校验详情可供文件能力判定" };
  }
  if (!isIsolatedRun(detail)) {
    return {
      kind: "not-isolated",
      reason: "普通运行没有自有文件世界，不生成文件历史——只有隔离运行的文件页可打开",
    };
  }

  // 从步骤打开：仅合法自有完成步骤能成为定位目标（U2 同源判据：leafSpanIds 内的 agent.step）
  const selected = input.selectedSpanId;
  if (selected !== null) {
    const verdict = validateCheckpointStepId(detail, selected);
    if (verdict === "valid") {
      return {
        kind: "available",
        targetCheckpointStepId: selected,
        note: null,
      };
    }
    return {
      kind: "available",
      targetCheckpointStepId: null,
      note:
        verdict === "stale"
          ? "所选步骤不是该运行的自有完成步骤：不作为文件定位目标，改用已保存位置或默认检查点"
          : null,
    };
  }

  // 无步骤选中：走 U2 既有链——该 run 已保存合法位置原样恢复，未进过则用默认检查点
  return {
    kind: "available",
    targetCheckpointStepId: null,
    note:
      input.savedTab === "files"
        ? null
        : "未在文件页选定位置：打开后按 U2 默认规则选最近自有完成步骤（或初始状态）",
  };
}

/**
 * 该侧当前选中的比较步骤是否可作为定位目标预检（store 接线用；与上面同源）。
 * 只在目标 run 的**已校验详情**上判——不用当前选中 run 的详情冒充。
 */
export function isOwnStepTarget(detail: RunDetail, spanId: string): boolean {
  const owned = new Set(detail.leafSpanIds);
  return detail.spans.some(
    (span: SpanLine) => span.id === spanId && span.kind === "agent.step" && owned.has(span.id),
  );
}
