import type { RunDetail } from "@shared/ipc";
import type {
  ComparePathEntry,
  CompareSideResult,
  CompareSideSelector,
  ComparedFileSide,
  ComparedWorkspaceFileResult,
} from "@shared/ipc";
import { isIsolatedRun } from "./isolated-fork";
import {
  type CheckpointOption,
  defaultCheckpointStepId,
  deriveCheckpointOptions,
  validateCheckpointStepId,
} from "./workspace-files";

/**
 * R2.2 6.4/6.5：比较文件视图的纯判据。
 *
 * 两个默认值在不同层，不能混：
 * - **包 API**：省略 `stepSpanId` 永远 = 初始快照；
 * - **桌面首次打开**：最近自有完成步骤，无则初始。桌面必须先在已校验详情里把它
 *   解析成**显式 step ID** 再发 IPC；只有真正选择初始时才省略字段。
 *
 * 其余纪律：
 * - 两侧 selector 独立，一侧失效不自动改另一侧、不回落初始；
 * - 清单的 `reference` 只代表引用相同/不同，正文是否相同要等逐侧 readVerified；
 * - 请求代次绑定 selector/snapshot/path；迟到响应整份丢弃。
 */

export type CompareFileSide = "left" | "right";

/**
 * 比较文件视图的会话状态（store 持有；纯模块定义便于无 window 的单测）。
 * 两个 step 字段的 `undefined` = 该 pair 尚未解析默认；`null` = 明确初始。
 */
export interface CompareFileViewState {
  readonly open: boolean;
  readonly pairKey: string;
  readonly leftStepSpanId: string | null | undefined;
  readonly rightStepSpanId: string | null | undefined;
  readonly path: string | null;
}

export function emptyCompareFileViewState(): CompareFileViewState {
  return {
    open: false,
    pairKey: "",
    leftStepSpanId: undefined,
    rightStepSpanId: undefined,
    path: null,
  };
}

export interface CompareFileSideSelection {
  readonly runId: string;
  /** 已解析的显式选择；null = 初始快照（只有此时 IPC 才省略字段） */
  readonly stepSpanId: string | null;
}

/** IPC selector：只有初始快照才省略 stepSpanId，绝不把「最近一步」误传成缺省 */
export function compareFileSelectorOf(selection: CompareFileSideSelection): CompareSideSelector {
  return {
    runId: selection.runId,
    ...(selection.stepSpanId === null ? {} : { stepSpanId: selection.stepSpanId }),
  };
}

/** 一次清单请求的身份：两侧 selector 冻结后的稳定 key（请求代次用） */
export function compareFileSelectionKey(
  left: CompareFileSideSelection,
  right: CompareFileSideSelection,
): string {
  return `${left.runId}|${left.stepSpanId ?? "initial"}||${right.runId}|${right.stepSpanId ?? "initial"}`;
}

/** 单侧可读性/检查点结论：ready 才能进入清单请求；stale 只报错不改点 */
export type CompareFileSideState =
  | {
      readonly kind: "ready";
      readonly selection: CompareFileSideSelection;
      readonly options: readonly CheckpointOption[];
      /** 首次打开按默认解析出来的（最近自有完成步骤，无则初始） */
      readonly defaulted: boolean;
    }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "not-isolated"; readonly reason: string }
  | {
      readonly kind: "stale";
      readonly reason: string;
      readonly options: readonly CheckpointOption[];
    };

/**
 * 解析单侧文件选择。
 * `savedStepSpanId === undefined` = 本次 pair 尚未初始化 ⇒ 显式解析默认值；
 * `null` = 用户/默认选择初始；具体 id = 需在当前详情里仍为合法自有完成步骤。
 */
export function resolveCompareFileSide(input: {
  readonly detail: RunDetail | null;
  readonly runId: string;
  readonly unavailableReason: string | null;
  readonly savedStepSpanId: string | null | undefined;
}): CompareFileSideState {
  if (input.detail === null) {
    return {
      kind: "unavailable",
      reason: input.unavailableReason ?? "该侧不可读：没有已校验详情可供文件选择",
    };
  }
  if (input.detail.meta.id !== input.runId) {
    return { kind: "unavailable", reason: "该侧详情的运行身份与比较对象不一致" };
  }
  if (!isIsolatedRun(input.detail)) {
    return {
      kind: "not-isolated",
      reason: "普通运行没有自有文件世界：跨运行文件比较不适用（不会改选另一条运行冒充）",
    };
  }
  const options = deriveCheckpointOptions(input.detail);
  if (input.savedStepSpanId === undefined) {
    return {
      kind: "ready",
      selection: {
        runId: input.runId,
        stepSpanId: defaultCheckpointStepId(input.detail),
      },
      options,
      defaulted: true,
    };
  }
  const verdict = validateCheckpointStepId(input.detail, input.savedStepSpanId);
  if (verdict === "stale") {
    return {
      kind: "stale",
      reason:
        "所选检查点已不属于该运行的自有完成步骤（祖先/已删除/拼错）：不自动改点，请显式重新选择",
      options,
    };
  }
  return {
    kind: "ready",
    selection: { runId: input.runId, stepSpanId: input.savedStepSpanId },
    options,
    defaulted: false,
  };
}

/** 清单双方都可用时才冻结出 expectedSnapshotIds；任一侧不可用返回 null */
export function expectedSnapshotIdsOf(
  result: {
    readonly left: CompareSideResult;
    readonly right: CompareSideResult;
  } | null,
): { readonly left: string; readonly right: string } | null {
  if (result === null) return null;
  if (result.left.status !== "ok" || result.right.status !== "ok") return null;
  return {
    left: result.left.selected.snapshotId,
    right: result.right.selected.snapshotId,
  };
}

/** 清单侧失败的可读文案（不可用不是空侧） */
export function compareSideFailureLabel(side: CompareSideResult): string | null {
  return side.status === "ok" ? null : `${side.failure.code}：${side.failure.reason}`;
}

/** 路径清单引用状态的展示文案（未核验字节；不能冒充内容相同） */
export function referenceLabel(entry: ComparePathEntry): string {
  switch (entry.presence) {
    case "left_only":
      return "仅左侧存在";
    case "right_only":
      return "仅右侧存在";
    case "both":
      return entry.reference === "same"
        ? "两侧清单引用相同（内容待核验）"
        : "两侧清单引用不同（内容待核验）";
  }
}

/** 逐侧正文状态标签（错误/二进制/超限各自可辨认） */
export function comparedFileSideLabel(side: ComparedFileSide, sideName: string): string {
  switch (side.status) {
    case "text":
      return `${sideName}：文本 ${side.file.bytes} B`;
    case "binary":
      return `${sideName}：二进制（不生成文本差异）`;
    case "not_found":
      return `${sideName}：清单证明不存在（不是空文件）`;
    case "missing":
      return `${sideName}：附件缺失（${side.reason}）`;
    case "corrupt":
      return `${sideName}：附件损坏（${side.reason}）`;
    case "too_large":
      return `${sideName}：超出文本大小限制（${side.reason}）`;
    case "io":
      return `${sideName}：读取 I/O 失败（${side.reason}）`;
    case "selection_changed":
      return `${sideName}：快照已变化（期望 ${side.expectedSnapshotId.slice(0, 12)}…，实际 ${side.actualSnapshotId.slice(0, 12)}…），请刷新`;
    case "unavailable":
      return `${sideName}：不可用（${side.failure.code}：${side.failure.reason}）`;
  }
}

/**
 * 文本 diff 的输入：仅 text/text 或 text + 清单证明 not_found 的组合可用。
 * `not_found` 一侧以空串参与，但仍由 UI 标明"清单证明不存在"，不冒充空文件。
 */
export function textDiffSidesOf(result: ComparedWorkspaceFileResult): {
  readonly original: string;
  readonly modified: string;
} | null {
  if (!result.textDiffEligible) return null;
  const textOf = (side: ComparedFileSide): string | null => {
    if (side.status === "text") return side.text;
    if (side.status === "not_found") return "";
    return null;
  };
  const left = textOf(result.left);
  const right = textOf(result.right);
  if (left === null || right === null) return null;
  return { original: left, modified: right };
}
