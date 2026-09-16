import type {
  LlmCallError,
  LlmRequest,
  LlmResponse,
  RunEventInput,
  RunEventLine,
  RunMetaInput,
  RunMetaLine,
  SpanKind,
  SpanLine,
} from "./schema.js";
import { RunEventSchema, RunMetaSchema, SpanSchema } from "./schema.js";

/**
 * Tracer 事件流的事件——Agent loop 的所有观测的唯一出口。
 * 文件写入（JsonlTracer）只是事件流的一种订阅端。
 */
export type TraceStreamEvent =
  | { type: "run.meta"; meta: RunMetaLine }
  | { type: "span.start"; id: string; kind: SpanKind; parent: string | null }
  | { type: "span.end"; span: SpanLine }
  | { type: "run.event"; event: RunEventLine };

/** startSpan 的初始化属性（按 kind 区分） */
export type StartSpanAttr =
  | { kind: "agent.step"; parent?: string | null; n: number }
  | { kind: "llm.call"; parent?: string | null; request: LlmRequest }
  | {
      kind: "tool.invoke";
      parent?: string | null;
      tool: string;
      args: Record<string, unknown>;
    };

/**
 * endSpan 的补丁（按 kind 区分；错误是数据不是异常——工具失败也要 endSpan）。
 *
 * llm.call 的 `error` 是**可选的失败详情**：成功调用省略；与工具分支的
 * `error: string | null` 同名异构（两者靠 `response` / `dur_ms` 区分分支，
 * 不靠 `error`）——判定时先按 span kind 缩窄类型。
 */
export type EndSpanPatch =
  | { kind?: never }
  | { response: LlmResponse; error?: LlmCallError }
  | { result?: unknown; dur_ms: number; error: string | null };

/**
 * Tracer：trace 的采集接口。实现为可订阅的事件流。
 * loop 通过它流出全部观测，不直接写文件。
 */
export interface Tracer {
  /** 开始一个 run（写入 run.meta 首行） */
  startRun(meta: RunMetaInput): void;
  /** 开始一个 span，返回自动生成的 span id */
  startSpan(attr: StartSpanAttr): string;
  /** 结束一个 span：patch 携带完成态字段（response / result / dur_ms / error） */
  endSpan(id: string, patch?: EndSpanPatch): void;
  /** 结束 run（写入终止事件）。之后 Tracer 封存，任何写入抛错 */
  endRun(event: RunEventInput): void;
  /** 订阅事件流；返回取消订阅函数 */
  subscribe(listener: (event: TraceStreamEvent) => void): () => void;
}

/** 活跃 span 的登记项 */
interface ActiveSpan {
  kind: SpanKind;
  fields: Record<string, unknown>;
  /** 起始时刻（ISO 8601），endSpan 时与终止时刻一并落盘为 timing */
  startedAt: string;
}

/**
 * Tracer 的基类：管理 span id 生成、活跃 span 表、事件流的订阅与分发、生命周期防护。
 * 子类通过三个 on* 钩子实现落盘（JsonlTracer）或纯内存（NullTracer）。
 */
export abstract class BaseTracer implements Tracer {
  private readonly listeners = new Set<(event: TraceStreamEvent) => void>();
  private readonly active = new Map<string, ActiveSpan>();
  private spanSeq: number;
  private runStarted = false;
  private runEnded = false;

  /**
   * @param options.spanSeqStart span id 起始序号（默认 0 → 首条为 s_01）。
   *   分支（fork）run 传入父链最大序号，使新 span id 在整条链上全局唯一
   *   （resolveBranch 扁平拼接与再分叉的叶优先查找都依赖 id 不冲突）。
   */
  constructor(options: { spanSeqStart?: number } = {}) {
    this.spanSeq = options.spanSeqStart ?? 0;
  }

  subscribe(listener: (event: TraceStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startRun(meta: RunMetaInput): void {
    this.assertNotStarted();
    const line = RunMetaSchema.parse({ type: "run.meta", ...meta });
    this.runStarted = true;
    this.onMeta(line);
    this.emit({ type: "run.meta", meta: line });
  }

  startSpan(attr: StartSpanAttr): string {
    this.assertNotEnded();
    this.assertStarted();
    const { kind, parent, ...rest } = attr;
    this.spanSeq += 1;
    const id = `s_${String(this.spanSeq).padStart(2, "0")}`;
    this.active.set(id, {
      kind,
      fields: { ...rest, parent: parent ?? null },
      startedAt: new Date().toISOString(),
    });
    this.emit({ type: "span.start", id, kind, parent: parent ?? null });
    return id;
  }

  endSpan(id: string, patch: EndSpanPatch = {}): void {
    this.assertNotEnded();
    const entry = this.active.get(id);
    if (entry === undefined) {
      throw new Error(`span ${id} 不存在或已结束`);
    }
    this.active.delete(id);
    const { kind, fields, startedAt } = entry;
    // patch 类型上不允许出现 kind（EndSpanPatch 约束）；此处不做防御性剔除
    const patchFields = { ...patch } as Record<string, unknown>;
    const span = SpanSchema.parse({
      type: "span",
      id,
      kind,
      ...fields,
      ...patchFields,
      // 墙上时钟区间：整行落盘时才完整，与 startSpan 时刻配对
      timing: { started_at: startedAt, ended_at: new Date().toISOString() },
    }) as SpanLine;
    this.onSpan(span);
    this.emit({ type: "span.end", span });
  }

  endRun(event: RunEventInput): void {
    this.assertNotEnded();
    this.assertStarted();
    const line = RunEventSchema.parse({ type: "run.event", ...event });
    this.runEnded = true;
    this.onEvent(line);
    this.emit({ type: "run.event", event: line });
  }

  /** 钩子：run.meta 落盘 */
  protected abstract onMeta(meta: RunMetaLine): void;
  /** 钩子：完整 span 落盘 */
  protected abstract onSpan(span: SpanLine): void;
  /** 钩子：终止事件落盘（JsonlTracer 在此 fsync 并封存） */
  protected abstract onEvent(event: RunEventLine): void;

  protected emit(event: TraceStreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private assertNotStarted(): void {
    if (this.runStarted) {
      throw new Error("此 Tracer 已开始过一个 run");
    }
  }

  private assertStarted(): void {
    if (!this.runStarted) {
      throw new Error("尚未 startRun");
    }
  }

  private assertNotEnded(): void {
    if (this.runEnded) {
      throw new Error("run 已结束（终止事件已写入），文件已封存，不可再写入");
    }
  }
}

/**
 * 静默 Tracer：不产生任何文件，事件流照常可订阅。
 * 测试与 headless 免配置场景使用。
 */
export class NullTracer extends BaseTracer {
  constructor(options: { spanSeqStart?: number } = {}) {
    super(options);
  }

  protected onMeta(): void {
    // 静默：无副作用
  }

  protected onSpan(): void {
    // 静默：无副作用
  }

  protected onEvent(): void {
    // 静默：无副作用
  }
}
