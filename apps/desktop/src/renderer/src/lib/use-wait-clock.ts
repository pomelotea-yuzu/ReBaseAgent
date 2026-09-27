import { useEffect, useState } from "react";

/**
 * U5（unify-run-execution-workflow）任务 5.2：**唯一的可见性受控时钟**。
 *
 * design D6：「使用一个可见性受控时钟更新显示，不据此轮询执行或推测进度。」
 * 三条边界写死在这里：
 * 1. 它**只**产出一个 `Date.now()` 读数——不 import store、不发 IPC、不触发
 *    `refreshOperationStatus`/reconcile/任何轮询（等待计时不驱动执行）；
 * 2. `active=false`（面板收起、或会话里没有需要盯的在飞/未知操作）⇒ 不起定时器；
 * 3. 页面隐藏时不空转：定时器只在可见时走秒，回到前台立即补一次读数。
 */
export function useWaitClock(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => setNowMs(Date.now()), 1000);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setNowMs(Date.now());
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);
  return nowMs;
}
