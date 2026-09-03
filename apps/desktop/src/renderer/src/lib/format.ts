/** 展示层格式化：只负责把数字变成人能读的字符串，不做任何业务逻辑判断 */

/** 耗时（毫秒）→ "1.2s" / "820ms"；null 表示时间未知 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** token 数 → "1.8k" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** ISO 8601 → "01-15 10:00:00"（本地时区） */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** 终止原因 → 中文短标签 */
export function reasonLabel(reason: string | null): string {
  switch (reason) {
    case "completed":
      return "已完成";
    case "max_iterations":
      return "达到迭代上限";
    case "budget_exceeded":
      return "超出预算";
    case "aborted":
      return "已中止";
    case "error":
      return "出错终止";
    case null:
      return "运行中断";
    default:
      return reason;
  }
}

/** 未知结构的 JSON 美化（工具 args / result / tool_calls 原样展示） */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
