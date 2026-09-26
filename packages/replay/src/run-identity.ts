import type { Tracer } from "@rebaseagent/trace-sdk";

/**
 * 可信运行身份的**观察适配**（U4 design D5）：编排层把可选回调挂到现有 tracer 的
 * `run.meta` 事件上，让调用方在**首次 LLM 调用之前**就知道本次实际写出的 run id。
 *
 * 为什么需要它：`runLoop` 的模型失败不抛异常而是落进 trace（"错误即数据"），
 * 而创建/分叉失败的 run 文件又是用预分配或临时文件名落盘的——调用方只有在
 * meta 写出的那一刻拿到真实 ID，才能在失败后仍然定位到那条记录。
 *
 * 三条边界（本文件是唯一的实现点，各编排只负责在收尾时调用释放函数）：
 * 1. **只观察，不控制**：不改 ID、不改 messages、不写 trace、不影响任何门禁；
 *    省略回调 ⇒ 连订阅都不建立，行为与以前逐字节相同；
 * 2. **只报告实际写出的最终 meta.id**：`BaseTracer.startRun` 先落盘（`onMeta`）
 *    再 `emit`，因此这里收到的一定是"文件里真有这一行"的身份；隔离路径订阅底层
 *    delegate，拿到的就是 checkpoint tracer 替换后的最终 ID，绝不是 loop 的临时 ID；
 * 3. **恰一次 + 异常隔离**：首个 `run.meta` 之后立即自解绑；观察者抛出的异常就地
 *    吞掉——它既不能变成新的失败原因，也不能阻止原收尾。**tracer 自身的写入错误
 *    不在此列**（那发生在 `onMeta` 里，早于 emit，照常向上抛）。
 */

/** 身份观察回调：入参是本次 trace 实际写出的最终 run id */
export type OnRunIdentified = (runId: string) => void;

/** 挂载观察口，返回**释放函数**（编排层必须在 `finally` 里调用，重复调用安全） */
export function observeRunIdentity(
  tracer: Pick<Tracer, "subscribe">,
  onRunIdentified: OnRunIdentified | undefined,
): () => void {
  if (onRunIdentified === undefined) return () => {};
  let release: (() => void) | null = null;
  let notified = false;
  release = tracer.subscribe((event) => {
    if (event.type !== "run.meta" || notified) return;
    // 先落"只通知一次"，再解绑：观察者抛错也不能让第二次 meta 事件漏进来
    notified = true;
    release?.();
    try {
      onRunIdentified(event.meta.id);
    } catch {
      // 观察者异常被隔离：登记已经拿到身份，执行的真实结局不受它影响
    }
  });
  return () => {
    release?.();
    release = null;
  };
}
