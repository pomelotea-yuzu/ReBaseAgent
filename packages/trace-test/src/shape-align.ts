import type { RunRecord, SpanLine } from "@rebaseagent/trace-sdk";
import { sameShape } from "./stub-tools.js";

/** 单处结构差异（首个不匹配位置） */
export interface ShapeMismatch {
  /** 语义序下的 span 下标（0 起）；数量差异时为较短一方的长度 */
  index: number;
  /** 差异字段：kind / parent / n / tool / args / tool_calls / count / outcome */
  field: string;
  detail: string;
}

/** 结构对齐结果 */
export interface ShapeAlignment {
  aligned: boolean;
  /** 首个不匹配处（aligned=true 时为 null） */
  mismatch: ShapeMismatch | null;
  /** 参与比较的 span 数（取新旧较小值） */
  comparedSpanCount: number;
}

/** 父 span 在语义序中的下标；根为 null；父缺失为 -1（结构损坏） */
function parentIndex(span: SpanLine, indexOfId: Map<string, number>): number | null {
  if (span.parent === null) {
    return null;
  }
  return indexOfId.get(span.parent) ?? -1;
}

/** llm.call 响应的 tool-call 结构：数量 + 函数名序列（忽略 arguments 文本） */
function toolCallShape(span: SpanLine): string[] | null {
  if (span.kind !== "llm.call") {
    return null;
  }
  return span.response.tool_calls.map(
    (tc) => (tc as { function?: { name?: unknown } }).function?.name as string,
  );
}

/**
 * 结构性轨迹对齐：比较新旧两条轨迹的 span 流。
 *
 * 默认比较（与 spec 一致）：span kind、父子关系（结构位，不含 span id）、
 * agent.step 迭代号、工具名、工具 args 形状、LLM tool-call 结构、顺序，
 * 以及终止 reason（run.outcome 五枚举）。
 * 忽略：timing、usage、ttft、dur_ms、自由文本（prompt / 响应正文 / args 值）。
 *
 * 断言失败的第一现场 = 首个不匹配 span（spec「轨迹结构改变」场景）。
 */
export function alignShape(recorded: RunRecord, current: RunRecord): ShapeAlignment {
  const recordedSpans = recorded.spans;
  const currentSpans = current.spans;
  const comparedSpanCount = Math.min(recordedSpans.length, currentSpans.length);

  const recordIndex = new Map(recordedSpans.map((s, i) => [s.id, i]));
  const currentIndex = new Map(currentSpans.map((s, i) => [s.id, i]));

  const mismatch = (index: number, field: string, detail: string): ShapeMismatch => ({
    index,
    field,
    detail,
  });

  for (let i = 0; i < comparedSpanCount; i++) {
    const r = recordedSpans[i];
    const c = currentSpans[i];

    if (r.kind !== c.kind) {
      return {
        aligned: false,
        mismatch: mismatch(
          i,
          "kind",
          `第 ${i} 个 span kind 不同：录制="${r.kind}"，当前="${c.kind}"`,
        ),
        comparedSpanCount,
      };
    }
    const rp = parentIndex(r, recordIndex);
    const cp = parentIndex(c, currentIndex);
    if (rp !== cp) {
      return {
        aligned: false,
        mismatch: mismatch(
          i,
          "parent",
          `第 ${i} 个 span（${r.kind}）父子关系不同：录制父位=${String(rp)}，当前父位=${String(cp)}`,
        ),
        comparedSpanCount,
      };
    }
    if (r.kind === "agent.step" && c.kind === "agent.step" && r.n !== c.n) {
      return {
        aligned: false,
        mismatch: mismatch(i, "n", `第 ${i} 个 span 迭代号不同：录制=${r.n}，当前=${c.n}`),
        comparedSpanCount,
      };
    }
    if (r.kind === "tool.invoke" && c.kind === "tool.invoke") {
      if (r.tool !== c.tool) {
        return {
          aligned: false,
          mismatch: mismatch(
            i,
            "tool",
            `第 ${i} 个 span 工具名不同：录制="${r.tool}"，当前="${c.tool}"`,
          ),
          comparedSpanCount,
        };
      }
      // args 形状（值级差异交给 span.field 断言）
      const sameArgs = sameShape(r.args, c.args);
      if (!sameArgs) {
        return {
          aligned: false,
          mismatch: mismatch(
            i,
            "args",
            `第 ${i} 个 span（${r.tool}）args 形状不同：录制=${JSON.stringify(r.args)}，当前=${JSON.stringify(c.args)}`,
          ),
          comparedSpanCount,
        };
      }
    }
    if (r.kind === "llm.call" && c.kind === "llm.call") {
      const rs = JSON.stringify(toolCallShape(r));
      const cs = JSON.stringify(toolCallShape(c));
      if (rs !== cs) {
        return {
          aligned: false,
          mismatch: mismatch(
            i,
            "tool_calls",
            `第 ${i} 个 span（llm.call）tool-call 结构不同：录制=${rs}，当前=${cs}`,
          ),
          comparedSpanCount,
        };
      }
    }
  }

  if (recordedSpans.length !== currentSpans.length) {
    return {
      aligned: false,
      mismatch: mismatch(
        comparedSpanCount,
        "count",
        `span 数量不同：录制 ${recordedSpans.length} 个，当前 ${currentSpans.length} 个` +
          `（当前${currentSpans.length > recordedSpans.length ? "多产生" : "少产生"} ${Math.abs(currentSpans.length - recordedSpans.length)} 个 span）`,
      ),
      comparedSpanCount,
    };
  }

  const rOutcome = recorded.events[0]?.reason;
  const cOutcome = current.events[0]?.reason;
  if (rOutcome !== cOutcome) {
    return {
      aligned: false,
      mismatch: mismatch(
        -1,
        "outcome",
        `终止 reason 不同：录制="${rOutcome ?? "<无>"}"，当前="${cOutcome ?? "<无>"}"`,
      ),
      comparedSpanCount,
    };
  }

  return { aligned: true, mismatch: null, comparedSpanCount };
}
