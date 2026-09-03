import { readFileSync } from "node:fs";
import type { ZodIssue } from "zod";
import { FORMAT_VERSION, TraceLineSchema } from "./schema.js";
import type { RunEventLine, RunMetaLine, SpanLine } from "./schema.js";

/** 读取 run 文件时的错误（含行号） */
export class TraceReadError extends Error {
  /** 出错的行号（1 起）；版本错误等整文件级错误时为 undefined */
  readonly line?: number;

  constructor(message: string, line?: number) {
    super(line === undefined ? message : `第 ${line} 行：${message}`);
    this.name = "TraceReadError";
    this.line = line;
  }
}

/** 一个 run 文件的解析结果 */
export interface RunRecord {
  meta: RunMetaLine;
  spans: SpanLine[];
  events: RunEventLine[];
  /** 有终止事件 = completed（已封存）；缺失 = crashed（进程中途崩溃） */
  status: "completed" | "crashed";
}

/**
 * 读取一个 run 文件：逐行 JSON 解析 + zod 校验。
 * 遇到不合法行报错并指明行号与原因，不返回部分结果、不静默跳过。
 */
export function readRun(file: string): RunRecord {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  return parseRunText(lines);
}

/** 由已拆分的行数组解析（亦供测试与内存数据使用） */
export function parseRunText(lines: string[]): RunRecord {
  let meta: RunMetaLine | null = null;
  const spans: SpanLine[] = [];
  const events: RunEventLine[] = [];

  let sawContent = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) {
      continue; // 容忍尾部空行
    }
    const lineNo = i + 1;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new TraceReadError(`JSON 解析失败：${(e as Error).message}`, lineNo);
    }

    if (typeof json !== "object" || json === null) {
      throw new TraceReadError("行必须是 JSON 对象", lineNo);
    }
    const type = (json as Record<string, unknown>).type;
    if (type === undefined) {
      throw new TraceReadError("type 为必填", lineNo);
    }

    if (lineNo === 1 || !sawContent) {
      // 首个内容行必须是 run.meta
      if (type !== "run.meta") {
        throw new TraceReadError("首行必须是 run.meta", lineNo);
      }
      const version = (json as Record<string, unknown>).format_version;
      if (typeof version === "number" && version > FORMAT_VERSION) {
        throw new TraceReadError(`不支持的格式版本 ${version}（当前支持 ${FORMAT_VERSION}）`);
      }
      meta = TraceLineSchema.parse(json) as RunMetaLine;
      sawContent = true;
      continue;
    }

    if (type === "run.meta") {
      throw new TraceReadError("run.meta 只能是首行", lineNo);
    }

    const parsed = TraceLineSchema.safeParse(json);
    if (!parsed.success) {
      const reason = parsed.error.issues.map(formatIssue).join("；");
      throw new TraceReadError(reason, lineNo);
    }
    const line = parsed.data;
    if (line.type === "span") {
      spans.push(line);
    } else if (line.type === "run.event") {
      events.push(line);
    }
  }

  if (meta === null) {
    throw new TraceReadError("文件为空：缺少 run.meta 首行");
  }

  return {
    meta,
    spans: orderSpans(spans),
    events,
    status: events.length > 0 ? "completed" : "crashed",
  };
}

/**
 * 把 span 重建为"父先子后、同层保序"的语义序。
 *
 * JsonlTracer 为防崩溃产生半行，在 endSpan 时整行落盘（append-only），
 * 因此文件中的 span 行是 end 序：一轮内 llm.call → tool.invoke → agent.step，
 * 子 span 先于其父 step 出现。而 trace-format 的语义序（fixture 亦为此序）是
 * start 序：agent.step → 其下 llm.call / tool.invoke。resolveBranch 的前缀截断
 * 与 deriveReplayState 的 lookahead 都依赖语义序，故读取时统一重建：
 * 根（step）按文件序保持时间先后，各根下子 span 按文件序挂回（一轮内
 * llm 先结束、tools 依执行序结束，恰为 start 序）。手工构造的合法文件
 * 若已是语义序，本变换为恒等。
 */
function orderSpans(spans: SpanLine[]): SpanLine[] {
  if (spans.length <= 1) {
    return spans;
  }
  const childrenOf = new Map<string, SpanLine[]>();
  const roots: SpanLine[] = [];
  for (const span of spans) {
    if (span.parent === null) {
      roots.push(span);
    } else {
      const siblings = childrenOf.get(span.parent) ?? [];
      siblings.push(span);
      childrenOf.set(span.parent, siblings);
    }
  }
  const ordered: SpanLine[] = [];
  const visit = (span: SpanLine): void => {
    ordered.push(span);
    for (const child of childrenOf.get(span.id) ?? []) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  // 防御：parent 指向缺失的孤儿 span 按文件序补在末尾（不丢数据）
  if (ordered.length !== spans.length) {
    const seen = new Set(ordered);
    for (const span of spans) {
      if (!seen.has(span)) {
        ordered.push(span);
      }
    }
  }
  return ordered;
}

/** 把 zod issue 格式化为中文原因（缺失字段 → "xxx 为必填"） */
function formatIssue(issue: ZodIssue): string {
  const path = issue.path.join(".");
  if (issue.code === "invalid_type" && (issue as { received?: unknown }).received === "undefined") {
    return `${path || "?"} 为必填`;
  }
  return `${path || "行"}: ${issue.message}`;
}
