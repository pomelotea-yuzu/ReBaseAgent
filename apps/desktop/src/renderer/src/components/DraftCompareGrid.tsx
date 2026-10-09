import type { ReactNode } from "react";
import { useId, useRef, useState } from "react";
import {
  DRAFT_EDITOR_HEIGHT,
  EXPANDED_DRAFT_EDITOR_HEIGHT,
  ORIGINAL_EDITOR_HEIGHT,
  ORIGINAL_HEIGHT_MAX,
  ORIGINAL_HEIGHT_MIN,
  clampOriginalHeight,
  decideDraftCompareLayout,
  stepOriginalHeight,
} from "../lib/editor-space";
import { useContainerWidth } from "../lib/use-file-layout";
import { FOCUS_RING } from "./IconButton";

/**
 * 原值/草稿对照区（UI 密度 change 任务 2.2/2.3 · design D3）。
 *
 * messages/prompt/tool-result 三处编辑器与 A/B 对照卡共用的**布局层**——
 * 编辑器本体（Monaco / 文本卡）由调用方作为 children 传入，本组件只负责：
 *
 * 1. **并排/上下按实测容器宽决策**（`decideDraftCompareLayout`，每侧 ≥320 才并排），
 *    替换此前的 `xl:grid-cols-2` 窗口断点——目录/列表开合改变容器宽而窗口不变时，
 *    只有容器实测能捕捉；
 * 2. **原值可收起、恢复入口常驻**（spec「原值收起后仍可恢复核对」）：收起是本组件的
 *    显示覆盖（组件本地 state，目标变化随 key 重挂自动复位、不写回任何偏好），
 *    草稿本体仍在 store——不复制、不建并行存储；
 * 3. **上下排列时原值区高度可调**（拖拽 + 键盘，`role="separator"` 可聚焦）；
 *    并排时两侧同高、各自内部滚动，无需比例手柄。
 *
 * ⚠️ 高度策略：编辑器 children 一律 `height="100%"`，外层包裹高度由本组件控制
 * （默认视口相对 clamp 常量；上下排列原值区被调整后用数值 px）。
 * A/B 对照卡是自适应文本，传 `fixedHeight={false}` 不套高度包裹。
 */

const DRAFT_TONE_LABEL: Record<"sky" | "emerald" | "violet", string> = {
  sky: "text-sky-700",
  emerald: "text-emerald-700",
  violet: "text-violet-700",
};

export function DraftCompareGrid({
  compareKey,
  original,
  draft,
  draftTone,
  draftLabel = "草稿（可编辑）",
  originalLabel = "原值（只读）",
  fixedHeight = true,
  resizable = true,
}: {
  /** 既有 DOM 锚点（data-draft-compare），测试与调用方语义不变 */
  readonly compareKey: string;
  readonly original: ReactNode;
  readonly draft: ReactNode;
  /** 草稿标签色调（与各执行模式的既有配色一致） */
  readonly draftTone: "sky" | "emerald" | "violet";
  readonly draftLabel?: string;
  /** 原值标签文案（A/B 对照卡的语义不同：父本基线臂） */
  readonly originalLabel?: string;
  /** children 是否需要本组件控制高度（Monaco 编辑器 true；自适应文本卡 false） */
  readonly fixedHeight?: boolean;
  /** 是否提供原值区高度手柄（文本对照 false） */
  readonly resizable?: boolean;
}): ReactNode {
  const [ref, width] = useContainerWidth<HTMLDivElement>(720);
  const layout = decideDraftCompareLayout(width);
  const [originalCollapsed, setOriginalCollapsed] = useState(false);
  /** 上下排列时原值区高度；null = 沿用默认 clamp 口径（未调整过） */
  const [originalHeight, setOriginalHeight] = useState<number | null>(null);
  const controlsId = useId();
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const originalLabelRow = (
    <div className="flex items-center justify-between gap-2">
      <div className="mb-0.5 text-[10px] font-medium text-gray-500">{originalLabel}</div>
      <button
        type="button"
        aria-expanded="true"
        aria-controls={controlsId}
        onClick={() => setOriginalCollapsed(true)}
        title="收起只读原值，把空间让给草稿（可随时恢复）"
        className={`shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-50 ${FOCUS_RING}`}
      >
        收起原值
      </button>
    </div>
  );

  const draftLabelRow = (restoreEntry: boolean) => (
    <div className="flex items-center justify-between gap-2">
      <div className={`mb-0.5 text-[10px] font-medium ${DRAFT_TONE_LABEL[draftTone]}`}>
        {draftLabel}
      </div>
      {restoreEntry ? (
        <button
          type="button"
          aria-expanded="false"
          aria-controls={controlsId}
          onClick={() => setOriginalCollapsed(false)}
          title="恢复显示只读原值（全文与只读身份保持）"
          className={`shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          显示原值
        </button>
      ) : null}
    </div>
  );

  /** children 的高度包裹（fixedHeight 时由本组件给确定高度，编辑器 100% 填充） */
  const heightBox = (height: string | number, child: ReactNode): ReactNode =>
    fixedHeight ? (
      <div className="overflow-hidden" style={{ height }}>
        {child}
      </div>
    ) : (
      child
    );

  const draftBox = (
    <div className="min-w-0">
      {draftLabelRow(originalCollapsed)}
      {heightBox(originalCollapsed ? EXPANDED_DRAFT_EDITOR_HEIGHT : DRAFT_EDITOR_HEIGHT, draft)}
    </div>
  );

  // 收起：草稿独占（并排/上下同形——单列）
  if (originalCollapsed) {
    return (
      <div
        ref={ref}
        className="grid grid-cols-1 gap-2"
        data-draft-compare={compareKey}
        data-draft-layout={layout}
        data-original-collapsed="true"
      >
        {draftBox}
      </div>
    );
  }

  if (layout === "side-by-side") {
    return (
      <div
        ref={ref}
        className="grid grid-cols-2 gap-2"
        data-draft-compare={compareKey}
        data-draft-layout="side-by-side"
      >
        <div className="min-w-0">
          {originalLabelRow}
          {heightBox(DRAFT_EDITOR_HEIGHT, original)}
        </div>
        {draftBox}
      </div>
    );
  }

  // 上下：各自滚动 + 原值区高度可调（拖拽/键盘）
  const separatorValue = originalHeight ?? 320;
  return (
    <div
      ref={ref}
      className="flex flex-col gap-1"
      data-draft-compare={compareKey}
      data-draft-layout="stacked"
    >
      <div className="min-w-0">
        {originalLabelRow}
        <div id={controlsId}>{heightBox(originalHeight ?? ORIGINAL_EDITOR_HEIGHT, original)}</div>
      </div>
      {resizable ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整原值区高度"
          aria-valuemin={ORIGINAL_HEIGHT_MIN}
          aria-valuemax={ORIGINAL_HEIGHT_MAX}
          aria-valuenow={separatorValue}
          tabIndex={0}
          data-original-resizer="true"
          onKeyDown={(event) => {
            const next = stepOriginalHeight(separatorValue, event.key);
            if (next === null) return;
            event.preventDefault();
            setOriginalHeight(next);
          }}
          onPointerDown={(event) => {
            dragRef.current = { startY: event.clientY, startHeight: separatorValue };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag === null) return;
            // 原值在上：向上拖 = 给它更多空间
            setOriginalHeight(
              clampOriginalHeight(drag.startHeight + (drag.startY - event.clientY)),
            );
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
          className={`min-h-[10px] shrink-0 cursor-row-resize rounded bg-gray-100 hover:bg-violet-200 focus:bg-violet-300 focus:outline-none ${FOCUS_RING}`}
        />
      ) : null}
      {draftBox}
    </div>
  );
}
