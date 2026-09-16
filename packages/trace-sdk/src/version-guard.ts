import { FORMAT_VERSION, PLAIN_FORMAT_VERSION } from "./schema.js";

/**
 * 版本与隔离字段的一致性检查（**纯函数，无 Node 依赖**）。
 *
 * 为什么必须在 schema parse **之前**做：zod object 默认**剥离**未知键而不是报错，
 * 所以"v1 文件私带 `workspace`"会被解析器静默丢弃、读出来是个合法 v1——旧桌面随后
 * 就可能对同名 `write_file` 使用普通 handler，正是 v2 版本门禁要防的降级事故。
 *
 * 三处入口共用本模块（change `add-sandboxed-rerun` design §2）：
 * reader 的原始行入口、BaseTracer 在 meta/span 被 zod 转换前的入口、
 * 以及 RunRecord/RunDetail IPC schema 的原始记录入口。
 *
 * 检查**只针对隔离字段的三个结构位置**（`run.meta.workspace`、`run.meta.fork.resume_after_step`、
 * `span.workspace_snapshot`），不递归搜索 messages / 工具 args / result 中的同名业务字段，
 * 也不对整个 v1 schema 加 `.strict()`——其他未知扩展字段仍按原有 strip/passthrough 行为处理。
 */

/** 存在性判定：`null` / `false` / 空对象（内存输入还包括显式 `undefined`）都算"存在" */
function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** 取对象形态（数组与 null 不算） */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 返回违规原因（中文，可直接进 `TraceReadError`）；无违规返回 `null`。
 *
 * @param line 原始行对象（未经 zod 转换）
 * @param fileVersion 文件版本；首个内容行（run.meta）传 `null`，此时版本从该行自身取
 */
export function findVersionFieldViolation(
  line: unknown,
  fileVersion: number | null,
): string | null {
  const record = asRecord(line);
  if (record === null) return null;

  const version =
    fileVersion ?? (typeof record.format_version === "number" ? record.format_version : null);
  if (version === null) return null; // 版本缺失/类型错由 schema 报错，这里不抢

  const type = record.type;

  if (version === PLAIN_FORMAT_VERSION) {
    if (type === "run.meta") {
      if (hasOwn(record, "workspace")) {
        return "v1 禁止携带 workspace（隔离字段只属于 v2；旧读取器会剥离它并可能降级执行）";
      }
      const fork = asRecord(record.fork);
      if (fork !== null && hasOwn(fork, "resume_after_step")) {
        return "v1 禁止携带 fork.resume_after_step（整轮续跑边界只属于 v2）";
      }
      return null;
    }
    if (type === "span" && hasOwn(record, "workspace_snapshot")) {
      return "v1 禁止携带 workspace_snapshot（文件检查点只属于 v2）";
    }
    return null;
  }

  if (version === FORMAT_VERSION) {
    // v2 的隔离契约：meta 必须声明文件世界（step 级"完整 step 必须有检查点"由 reader 跨行判定）
    if (type === "run.meta" && !hasOwn(record, "workspace")) {
      return "v2 必须携带 workspace（隔离运行的文件世界元数据）";
    }
    return null;
  }

  return null; // 更高版本由读取器的版本门禁负责拒绝
}
