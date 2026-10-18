/** 跨进程数据不可信：zod 校验失败的统一文案化（refactor-renderer 5.7 自 store.ts 归置）。
 * 四个分片（runs/navigation/operations/configuration）直连消费——纯函数，无协调语义，
 * 不经注入绕行（design D2：注入只用于跨域协调者与 runtime 句柄）。 */
export function describeZodError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
