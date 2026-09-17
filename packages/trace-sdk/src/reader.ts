import { readFileSync } from "node:fs";
import type { ZodIssue } from "zod";
import { FORMAT_VERSION, TraceLineSchema } from "./schema.js";
import type { RunEventLine, RunMetaLine, SpanLine } from "./schema.js";
import { toSemanticOrder } from "./semantic-order.js";
import { findVersionFieldViolation } from "./version-guard.js";
import { findSnapshotIdViolation } from "./workspace-hash.js";

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

  // 文件版本：由 run.meta 确定，后续行据此做"版本 ↔ 隔离字段"检查
  let fileVersion: number | null = null;

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

    // 版本 ↔ 隔离字段一致性：必须在 schema parse **之前**（zod 会静默剥离未知键，
    // 否则 v1 私带隔离字段会被读成"合法 v1" → 旧路径降级执行）
    const violation = findVersionFieldViolation(json, fileVersion);
    if (violation !== null) {
      throw new TraceReadError(violation, lineNo);
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
      fileVersion = typeof version === "number" ? version : null;
      sawContent = true;
      // 快照 id 必须等于其清单的规范哈希。清单与 id 之间没有结构性约束，只信任记录里的 id
      // 等于接受任意清单位图；而算哈希要 Node 字节 API（schema 层无法覆盖），故在此重算。
      if (meta.workspace !== undefined) {
        const idViolation = findSnapshotIdViolation(meta.workspace.initial_snapshot);
        if (idViolation !== null) {
          throw new TraceReadError(`初始快照校验失败：${idViolation}`, lineNo);
        }
      }
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
      if (line.kind === "agent.step") {
        // v2 跨行约束：**已落盘**的 step 必须带该轮末尾的检查点。span 在 endSpan 时才整行写入，
        // 所以"半途中断的 step"根本不会有行；出现缺快照的 step 行只可能是写入端漏注入。
        // 放它过去，隔离分叉就要等到取恢复点那一刻才失败——那时用户已经在等结果了。
        if (fileVersion === FORMAT_VERSION && line.workspace_snapshot === undefined) {
          throw new TraceReadError(
            "v2 隔离运行已完成的 agent.step 必须携带 workspace_snapshot（该轮全部工具完成后的检查点）",
            lineNo,
          );
        }
        // 步骤检查点同样重算 id（理由见首个内容行处）
        if (line.workspace_snapshot !== undefined) {
          const idViolation = findSnapshotIdViolation(line.workspace_snapshot);
          if (idViolation !== null) {
            throw new TraceReadError(`步骤快照校验失败：${idViolation}`, lineNo);
          }
        }
      }
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
