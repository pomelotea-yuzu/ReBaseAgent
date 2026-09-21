/**
 * U1 任务 4.3 · 面板宽度调节柄（design D2）。
 *
 * 一根竖条：**拖动**或**键盘**都能改相邻面板宽度，两者都夹到调用方给的范围。
 * 判据（步进值、边界、非数字回默认）全在 `lib/layout.ts` 的 `stepWidth`，
 * 本组件只负责把指针/按键事件翻译成"新的宽度值"。
 *
 * 三条纪律：
 *   - `role="separator"` + `aria-orientation="vertical"` + `aria-valuenow/min/max`：
 *     读屏要知道这是一根可调的竖分隔条，以及当前值与范围。
 *   - 键盘**只消费自己认识的键**（←/→/Home/End），其他键原样放行——否则会吞掉
 *     面板里别的快捷键。
 *   - 拖动期间 `user-select: none`，否则整页文字被选中、手感稀烂。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FOCUS_RING } from "./IconButton";

export function ResizeGrip({
  label,
  width,
  min,
  max,
  onWidth,
  onWidthKey,
}: {
  /** 可访问名称（如「运行导航宽度」） */
  label: string;
  width: number;
  min: number;
  max: number;
  /** 拖动结束/过程中给出的新宽度（调用方负责再夹一次） */
  onWidth: (width: number) => void;
  /** 键盘调整：返回 true = 已消费该键 */
  onWidthKey: (key: string) => boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, width: 0 });

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      origin.current = { x: e.clientX, width };
      setDragging(true);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      onWidth(origin.current.width + (e.clientX - origin.current.x));
    },
    [dragging, onWidth],
  );

  const stop = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  // 拖动期间禁止选中文字（松开即还原；卸载也还原，避免"卡在不可选中"）
  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = prev;
    };
  }, [dragging]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // 只消费自己认识的键：不认识就放行（否则吞掉面板内的其他快捷键）
      if (!onWidthKey(e.key)) return;
      e.preventDefault();
    },
    [onWidthKey],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
      title={`${label} ${width}px（${min}–${max}）· 拖动或 ←/→ 调整`}
      className={`w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-sky-300 ${
        dragging ? "bg-sky-400" : ""
      } ${FOCUS_RING}`}
    />
  );
}
