import type { RunRecord } from "./reader.js";
import type { RunEventLine, RunMetaLine, SpanLine } from "./schema.js";
import { toSemanticOrder } from "./semantic-order.js";
import { BaseTracer } from "./tracer.js";

/**
 * 内存 Tracer：把 run.meta / span / run.event 收集进内存数组，不产生任何文件。
 *
 * trace-test 的 headless 卡带重跑用它收集「新产生」的 span 流；
 * 事件流订阅（subscribe）照常可用。写入生命周期防护与 JsonlTracer 一致
 * （endRun 之后封存，再写入抛错）。
 */
export class MemoryTracer extends BaseTracer {
  /** 收集到的 run.meta（一次生命周期至多一条） */
  readonly metas: RunMetaLine[] = [];
  /** 收集到的完整 span（end 序：子 span 先于父 step 入列） */
  readonly spans: SpanLine[] = [];
  /** 收集到的终止事件（一次生命周期至多一条） */
  readonly events: RunEventLine[] = [];

  protected onMeta(meta: RunMetaLine): void {
    this.metas.push(meta);
  }

  protected onSpan(span: SpanLine): void {
    this.spans.push(span);
  }

  protected onEvent(event: RunEventLine): void {
    this.events.push(event);
  }

  /**
   * 快照为 RunRecord：span 重建为语义序，status 按是否有终止事件判定
   * （与 readRun 的口径一致）。尚未 startRun 时抛错。
   */
  snapshot(): RunRecord {
    if (this.metas.length === 0) {
      throw new Error("MemoryTracer 尚未 startRun，无 run.meta 可快照");
    }
    return {
      meta: this.metas[0],
      spans: toSemanticOrder(this.spans),
      events: [...this.events],
      status: this.events.length > 0 ? "completed" : "crashed",
    };
  }
}
