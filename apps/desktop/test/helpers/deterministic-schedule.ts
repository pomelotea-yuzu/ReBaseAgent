/**
 * 确定性调度工具：U4 的竞争/顺序测试全靠它把「谁先谁后」写成显式门禁，
 * 不用真实计时（setTimeout/sleep）来赌时序。
 */

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让所有已放行的微任务链跑完（setImmediate 排在宏任务队列尾部） */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
