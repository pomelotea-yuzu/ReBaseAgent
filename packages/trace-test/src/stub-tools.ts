import type { Tool, ToolContext } from "@rebaseagent/agent-loop";
import type { RunRecord, ToolInvokeSpan } from "@rebaseagent/trace-sdk";
import { TraceTestConfigError } from "./errors.js";

/** 工具参数形状漂移明细（只报告，不阻断；值级差异交给 span.field 断言） */
export interface ArgsDrift {
  tool: string;
  /** 该工具的第 n 次调用（1 起） */
  sequence: number;
  detail: string;
}

/**
 * 结构形状比较：对象比 key 集合（递归）、数组比长度、原始类型只比 typeof。
 * 字符串/数值的具体值不参与——那是字段断言（span.field）的职责。
 */
export function sameShape(a: unknown, b: unknown): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((x, i) => sameShape(x, b[i]));
  }
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) {
    return false;
  }
  if (ta === "object") {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const ka = Object.keys(oa).sort();
    const kb = Object.keys(ob).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
      return false;
    }
    return ka.every((k) => sameShape(oa[k], ob[k]));
  }
  return true;
}

/**
 * 录制结果桩工具表：包装「当前用户代码」的工具声明，handler 不执行任何真实工具，
 * 只按 `(tool 名, 调用序号)` 返回录制的 result / 抛出录制的 error。
 *
 * 契约（spec 三审残留项 3 钉死）：
 * - 录制中出现的工具名不在当前工具声明里 → 构造期即配置错误
 *   （「当前工具表与录制不兼容，请重录基线」）；
 * - 当前代码对某工具的调用次数超出录制 → 记入 overflows 并抛错
 *   （runLoop 把它收编为 error tool_result 继续跑，编排层在 run 结束后
 *   据此还原为配置错误）；
 * - 录制 error 非 null → handler 抛 Error(error)，由 ToolRegistry 捕获后
 *   走既有的「错误即数据」渲染路径（工具执行失败：…），轨迹与录制一致。
 */
export class StubToolTable {
  /** 桩工具（定义来自当前代码，handler 已替换为卡带查找） */
  readonly tools: Tool[];
  /** 调用次数超出录制的工具（编排层据此还原配置错误） */
  readonly overflows: string[] = [];
  /** 参数形状漂移明细 */
  readonly argsDrift: ArgsDrift[] = [];

  private readonly recordedByTool = new Map<string, ToolInvokeSpan[]>();
  private readonly counters = new Map<string, number>();

  constructor(currentTools: Tool[], record: RunRecord) {
    for (const span of record.spans) {
      if (span.kind === "tool.invoke") {
        const list = this.recordedByTool.get(span.tool) ?? [];
        list.push(span);
        this.recordedByTool.set(span.tool, list);
      }
    }

    const currentNames = new Set(currentTools.map((t) => t.name));
    const missing = [...this.recordedByTool.keys()].filter((name) => !currentNames.has(name));
    if (missing.length > 0) {
      throw new TraceTestConfigError(
        `当前工具表与录制不兼容：录制中使用的工具 ${missing.map((n) => `"${n}"`).join("、")} 不在当前工具声明中。请补齐工具声明，或重录基线。`,
      );
    }

    this.tools = currentTools.map((tool) => ({
      ...tool,
      handler: async (args: unknown, _ctx: ToolContext): Promise<string> =>
        this.executeStub(tool.name, args),
    }));
  }

  private executeStub(toolName: string, args: unknown): string {
    const recorded = this.recordedByTool.get(toolName) ?? [];
    const sequence = (this.counters.get(toolName) ?? 0) + 1;
    this.counters.set(toolName, sequence);

    const span = recorded[sequence - 1];
    if (span === undefined) {
      // 不计入 overflows 的重复报错：只登记第一次
      if (!this.overflows.includes(toolName)) {
        this.overflows.push(toolName);
      }
      throw new Error(
        `桩工具卡带耗尽：工具 "${toolName}" 的第 ${sequence} 次调用没有录制结果` +
          `（录制共 ${recorded.length} 次）。当前代码的调用次数多于录制，请重录基线。`,
      );
    }

    if (!sameShape(args, span.args)) {
      this.argsDrift.push({
        tool: toolName,
        sequence,
        detail: `第 ${sequence} 次调用的 args 形状与录制不同：录制=${JSON.stringify(span.args)}，当前=${JSON.stringify(args)}`,
      });
    }

    if (span.error !== null) {
      throw new Error(span.error);
    }
    return typeof span.result === "string" ? span.result : JSON.stringify(span.result);
  }
}
