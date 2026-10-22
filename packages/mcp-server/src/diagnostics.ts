/**
 * 受控诊断日志（design D3 的 stdout/stderr 纪律）。
 *
 * - **stdout 恒等于协议**：本模块只写 stderr；服务代码里不得出现 `console.*`，
 *   否则一行日志就会污染 JSON-RPC 帧。
 * - **不含正文与原始参数**：`detail` 只接受标量（字符串/数字/布尔/null）。
 *   对象与数组一律压成 `type:<名称>` 标记——传错东西时最坏是多一个类型名，
 *   不会把一份工具结果、一段历史正文或一条用户参数整份写进日志。
 * - **有界**：单值与整行都有上限并按码点截断，超长参数撑不破日志行。
 * - **落盘失败不影响协议**：写 stderr 抛错（管道已断等）只吞掉这一行诊断。
 */

/** 单个诊断值的码点上限 */
export const DIAGNOSTIC_VALUE_MAX = 120;
/** 单行诊断的码点上限（含事件名与时间戳） */
export const DIAGNOSTIC_LINE_MAX = 600;

/** 输出一行的目的地（测试注入收集器，生产写 stderr） */
export type DiagnosticSink = (line: string) => void;

export interface DiagnosticLog {
  event(name: string, detail?: Readonly<Record<string, unknown>>): void;
}

/** 默认目的地：stderr（**绝不**是 stdout） */
export const stderrDiagnosticSink: DiagnosticSink = (line) => {
  process.stderr.write(line);
};

export function createDiagnosticLog(
  sink: DiagnosticSink = stderrDiagnosticSink,
  now: () => string = () => new Date().toISOString(),
): DiagnosticLog {
  return {
    event(name: string, detail: Readonly<Record<string, unknown>> = {}): void {
      const safe: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(detail)) {
        safe[key] = boundedValue(value);
      }
      const line = `${now()} ${boundedText(name, DIAGNOSTIC_VALUE_MAX)} ${JSON.stringify(safe)}\n`;
      try {
        sink(truncate(line, DIAGNOSTIC_LINE_MAX));
      } catch {
        // 诊断写失败不得影响协议通道
      }
    },
  };
}

/** 非标量一律压成类型标记：传错东西时不外泄内容，只暴露"传了个什么东西" */
function boundedValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return boundedText(value, DIAGNOSTIC_VALUE_MAX);
  }
  if (typeof value === "bigint") {
    return boundedText(value.toString(), DIAGNOSTIC_VALUE_MAX);
  }
  return `type:${Array.isArray(value) ? "array" : typeof value}`;
}

function boundedText(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max).join("")}…`;
}

function truncate(line: string, max: number): string {
  const chars = [...line];
  if (chars.length <= max) return line;
  return `${chars.slice(0, max - 1).join("")}\n`;
}
