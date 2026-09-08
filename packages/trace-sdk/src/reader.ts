import { readFileSync } from "node:fs";
import type { ZodIssue } from "zod";
import { FORMAT_VERSION, TraceLineSchema } from "./schema.js";
import type { RunEventLine, RunMetaLine, SpanLine } from "./schema.js";
import { toSemanticOrder } from "./semantic-order.js";

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
    spans: toSemanticOrder(spans),
    events,
    status: events.length > 0 ? "completed" : "crashed",
  };
}

/** 把 zod issue 格式化为中文原因（缺失字段 → "xxx 为必填"） */
function formatIssue(issue: ZodIssue): string {
  const path = issue.path.join(".");
  if (issue.code === "invalid_type" && (issue as { received?: unknown }).received === "undefined") {
    return `${path || "?"} 为必填`;
  }
  return `${path || "行"}: ${issue.message}`;
}
