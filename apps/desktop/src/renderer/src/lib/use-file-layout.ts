/**
 * U2 任务 4.1 · 文件容器宽度的 React 接线。
 *
 * 与 U1 `use-layout.ts` 同法，但**测的是文件容器自身**（`ResizeObserver`），
 * 不是窗口。delta「同视口下响应容器变化」明写"不用窗口断点判断足够宽"——
 * 调运行导航或目录宽度会让容器变宽/变窄而窗口不变，只有容器实测能捕捉。
 *
 * ⚠️ 静态渲染（无 ResizeObserver）时回落到 `fallbackWidth`，让组件测试可断言布局分支。
 */

import { useEffect, useRef, useState } from "react";

/**
 * 订阅某元素的**实测宽度**（CSS px）。
 *
 * - `ResizeObserver` 可用时订阅该元素边框盒宽；
 * - 不可用（静态渲染 / 老环境）时保持 `fallbackWidth`。
 *
 * 返回 `[ref, width]`——把 `ref` 挂到被测容器上。
 */
export function useContainerWidth<T extends HTMLElement>(
  fallbackWidth: number,
): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallbackWidth);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      // 用内容盒宽（扣除 padding/border），判据需要"可用于放文字的空间"
      const next = entry.contentRect.width;
      setWidth((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
