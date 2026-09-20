import { findVersionFieldViolation } from "@rebaseagent/trace-sdk/schema";

/**
 * RunDetail **原始载荷**的版本守卫（B 任务 1.1）。
 *
 * 为什么必须在渲染层 schema 转换**之前**：zod object 默认剥离未知键而不是报错，
 * "v1 载荷私带 `workspace` / `fork.resume_after_step` / span 级 `workspace_snapshot`"
 * 会被 `RunDetailSchema.safeParse` 静默剥掉、读出来是个"合法"载荷——隔离字段消失后
 * 界面就可能在无文件世界的情况下照常渲染与执行。判定复用 trace-sdk 的
 * `findVersionFieldViolation`（A 段 4.x 的同一份实现，只认**自有属性存在性**，
 * `null` / `false` / 空对象 / 显式 `undefined` 都算存在）。
 *
 * ## 判定范围（与 design §2 一致）
 *
 * - **meta**：叶子 run（`detail.meta`）与 `chain` 里每一代祖先的 meta **逐个**检查，
 *   版本各取自己的 `format_version`——祖先元数据不遗漏。
 * - **span**：只有能归属到叶子的 span（id 在 `leafSpanIds` 里）按**叶子**版本检查
 *   `workspace_snapshot`。分支 run 的合并轨迹里，祖先前缀的 span 无法逐条归属到
 *   某个具体祖先 run（不同祖先版本可能不同），此处不猜——它们在 main 侧读文件时
 *   已经被 trace-sdk reader 按文件版本守卫过一遍（reader 在 parse 前调同一 helper）。
 * - **只查三个结构位置**：`meta.workspace`、`meta.fork.resume_after_step`、
 *   span 的 `workspace_snapshot`。不递归搜索 messages / 工具 args / result 里的同名
 *   业务字段，也不对整个载荷加 strict——不相关扩展字段保持既有兼容行为。
 * - **列表载荷不适用**：`ListRunsData` 是 main 派生的汇总（不含 meta/span 原文），
 *   没有可携带隔离字段的结构位置。
 *
 * 本模块只依赖 trace-sdk 的纯子路径（`./schema`），renderer/preload 可安全引用。
 */

/** 取对象形态（数组与 null 不算） */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 单个 meta 的检查：包一层 `type` 使其与 version-guard 的行形状对齐 */
function checkMeta(meta: unknown): string | null {
  const record = asRecord(meta);
  if (record === null) return null; // 形状问题交给 schema 报
  return findVersionFieldViolation({ ...record, type: "run.meta" }, null);
}

/** 单个 span 的检查：ownerRunVersion 为该 span 所属 run 的 format_version */
function checkSpan(span: unknown, ownerRunVersion: unknown): string | null {
  const record = asRecord(span);
  if (record === null) return null;
  return findVersionFieldViolation(
    { ...record, type: "span" },
    typeof ownerRunVersion === "number" ? ownerRunVersion : null,
  );
}

/**
 * 返回违规原因（中文，可直接展示）；载荷合法（或形状不完整，交由后续 schema 报错）返回 `null`。
 */
export function findRunDetailVersionViolation(detail: unknown): string | null {
  const record = asRecord(detail);
  if (record === null) return null;

  // 1. 叶子 meta + chain 祖先 meta（各自按自己的版本；v2 meta 缺 workspace 同样在此被拒）
  const leafViolation = checkMeta(record.meta);
  if (leafViolation !== null) {
    return `叶子 run 的 meta：${leafViolation}`;
  }
  const chain = Array.isArray(record.chain) ? record.chain : [];
  for (const [index, hop] of chain.entries()) {
    const hopRecord = asRecord(hop);
    if (hopRecord === null) continue;
    const violation = checkMeta(hopRecord.meta);
    if (violation !== null) {
      return `祖先链第 ${index + 1} 跳的 meta：${violation}`;
    }
  }

  // 2. 叶子自有 span（leafSpanIds 可归属）；祖先前缀 span 不在此检查（见模块注释）
  const leafVersion: unknown = asRecord(record.meta)?.format_version;
  const leafSpanIds = Array.isArray(record.leafSpanIds)
    ? new Set(record.leafSpanIds.filter((id): id is string => typeof id === "string"))
    : null;
  const spans = Array.isArray(record.spans) ? record.spans : [];
  for (const [index, span] of spans.entries()) {
    const spanRecord = asRecord(span);
    if (spanRecord === null || typeof spanRecord.id !== "string") continue;
    // 详情载荷缺失 leafSpanIds 时（异常形状）退化为全量按叶子版本检查——宁可误报不可漏放
    const ownedByLeaf = leafSpanIds === null || leafSpanIds.has(spanRecord.id);
    if (!ownedByLeaf) continue;
    const violation = checkSpan(span, leafVersion);
    if (violation !== null) {
      return `span ${spanRecord.id}（第 ${index + 1} 条）：${violation}`;
    }
  }

  return null;
}
