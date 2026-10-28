import { useEffect, useRef } from "react";
import { useAppStore } from "../store";

/**
 * 有效语言变化时执行一次本地确认清理（首次挂载不触发）。
 * 用于组件局部保存的费用/副本写入/副作用勾选；中心执行确认由 store 统一清空。
 */
export function useResetOnLanguageChange(reset: () => void): void {
  const epoch = useAppStore((s) => s.languageEpoch);
  const resetRef = useRef(reset);
  resetRef.current = reset;
  const lastEpoch = useRef(epoch);
  useEffect(() => {
    if (epoch === lastEpoch.current) return;
    lastEpoch.current = epoch;
    resetRef.current();
  }, [epoch]);
}
