import { hashWorkspaceContent } from "./blob-store.js";

/**
 * 确定性 unified diff（R2.1 design D4，任务 3.3a/3.3b）：仓库内纯 TypeScript 实现，
 * **不新增 diff 依赖**。
 *
 * 固定口径：
 * - 三行上下文；文件头 `a/<逻辑路径>` / `b/<逻辑路径>`，新增旧头 `/dev/null`；
 * - 控制行（---/+++/@@/标记行）一律 LF；**内容行逐字保留原文件的 CRLF/LF 与末尾是否换行**，
 *   缺少末尾换行用标准说明行 `\ No newline at end of file`，不以换行规范化掩盖字节差异；
 * - hunk 头显式给出起止行号与行数（`@@ -1,3 +1,4 @@`），不做 `,1` 省略——确定性优先；
 * - 路径含空格、引号、反斜杠、控制字符或非 ASCII 时采用 git 风格引用（UTF-8 字节八进制转义），
 *   规则见 `quoteDiffPath`；
 * - 生成工作量有上限：单文件 LCS 动态规划格子数超过 `maxDiffCells` 即抛
 *   `ExportDiffError("workload_exceeded")`，由调用方把**整份**补丁标为 not_available
 *   （完整文件导出不受影响）。
 *
 * 行的定义：以 `\n` 为界，**终止符属于行内容**——`a\r\n` 与 `a\n` 与 `a`（末行无换行）是
 * 三条不同的行，因此 CRLF/LF/无换行的差异天然参与比对，不会被规范化吞掉。
 */

/** hunk 上下文行数（design D4 固定为 3） */
export const DIFF_CONTEXT_LINES = 3;

/**
 * 单文件 diff 工作量上限：LCS 动态规划格子数 `(旧行数+1) × (新行数+1)`。
 * 1000×1000 行的文件对可达上限；超出即放弃整份补丁，不做截断冒充成功。
 */
export const DEFAULT_MAX_DIFF_CELLS = 1_000_000;

export class ExportDiffError extends Error {
  readonly code: "workload_exceeded";

  constructor(message: string) {
    super(message);
    this.name = "ExportDiffError";
    this.code = "workload_exceeded";
  }
}

type Op =
  | { readonly type: "eq"; readonly line: string; readonly aLine: number; readonly bLine: number }
  | { readonly type: "del"; readonly line: string; readonly aLine: number }
  | { readonly type: "add"; readonly line: string; readonly bLine: number };

/**
 * 生成单个文件的 unified diff 文本（无文件头之外的任何包装）。
 * `oldPath` 传 `null` 表示新增（旧头固定 `/dev/null`，不参与路径引用）。
 */
export function buildUnifiedDiff(
  oldPath: string | null,
  newPath: string,
  oldText: string,
  newText: string,
  maxDiffCells: number = DEFAULT_MAX_DIFF_CELLS,
): string {
  const a = splitDiffLines(oldText);
  const b = splitDiffLines(newText);
  const cells = (a.length + 1) * (b.length + 1);
  if (cells > maxDiffCells) {
    throw new ExportDiffError(
      `补丁生成工作量超限（${a.length}×${b.length} 行，${cells} > ${maxDiffCells} 格）：${newPath}`,
    );
  }

  const ops = diffOps(a, b);
  const hunks = groupHunks(ops);
  if (hunks.length === 0) {
    return "";
  }

  const oldHeader = oldPath === null ? "/dev/null" : quoteDiffPath(`a/${oldPath}`);
  let out = `--- ${oldHeader}\n+++ ${quoteDiffPath(`b/${newPath}`)}\n`;
  for (const hunk of hunks) {
    out += formatHunk(hunk);
  }
  return out;
}

/** 以 `\n` 为界切行，终止符属于行；末尾无换行的最后一段单独成行 */
function splitDiffLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/**
 * LCS 动态规划（后缀表）+ 固定回溯优先级：相等走对角，否则优先删除。
 * 同输入必得同一编辑脚本——确定性由遍历顺序与平局规则保证，与实现语言无关。
 */
function diffOps(a: readonly string[], b: readonly string[]): readonly Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // dp[i*width+j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", line: a[i], aLine: i + 1, bLine: j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: "del", line: a[i], aLine: i + 1 });
      i++;
    } else {
      ops.push({ type: "add", line: b[j], bLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: a[i], aLine: i + 1 });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", line: b[j], bLine: j + 1 });
    j++;
  }
  return ops;
}

/**
 * 把编辑脚本按三行上下文分组为 hunk：每个变更 op 向两侧各扩 3 行，区间重叠或相邻
 * （中间 eq 行数 ≤ 2×3）即合并——否则同一段上下文会在两个 hunk 里重复出现。
 */
function groupHunks(ops: readonly Op[]): readonly (readonly Op[])[] {
  const changed: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type !== "eq") {
      changed.push(idx);
    }
  }
  if (changed.length === 0) {
    return [];
  }

  const intervals: Array<{ lo: number; hi: number }> = [];
  for (const idx of changed) {
    const lo = Math.max(0, idx - DIFF_CONTEXT_LINES);
    const hi = Math.min(ops.length - 1, idx + DIFF_CONTEXT_LINES);
    const last = intervals[intervals.length - 1];
    // 相邻合并的判据：新区间的 lo 落在上一个区间 hi 的 1 行以内即重叠/紧贴
    if (last !== undefined && lo <= last.hi + 1) {
      last.hi = Math.max(last.hi, hi);
    } else {
      intervals.push({ lo, hi });
    }
  }
  return intervals.map(({ lo, hi }) => ops.slice(lo, hi + 1));
}

function formatHunk(hunk: readonly Op[]): string {
  let aCount = 0;
  let bCount = 0;
  for (const op of hunk) {
    if (op.type !== "add") aCount++;
    if (op.type !== "del") bCount++;
  }
  const firstA = hunk.find((op): op is Extract<Op, { type: "eq" | "del" }> => op.type !== "add");
  const firstB = hunk.find((op): op is Extract<Op, { type: "eq" | "add" }> => op.type !== "del");
  const aStart = aCount > 0 ? (firstA?.aLine ?? 0) : 0;
  const bStart = bCount > 0 ? (firstB?.bLine ?? 0) : 0;

  let out = `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n`;
  for (const op of hunk) {
    const prefix = op.type === "eq" ? " " : op.type === "del" ? "-" : "+";
    out += `${prefix}${op.line}`;
    if (!op.line.endsWith("\n")) {
      out += "\n\\ No newline at end of file\n";
    }
  }
  return out;
}

/**
 * 头部路径的安全形态判据：全部为可打印 ASCII，且不含 `"` 与 `\`（空格、非 ASCII、
 * 控制字符都不安全——会让 diff 头部的路径边界变得有歧义）。
 */
function isSafeDiffPath(path: string): boolean {
  return /^[\x21-\x7e]+$/.test(path) && !path.includes('"') && !path.includes("\\");
}

/**
 * git 风格路径引用：安全形态原样输出；否则整体加双引号并按 UTF-8 字节转义
 * （`"` → `\"`、`\` → `\\`、其余非安全字节 → `\ooo` 八进制）。确定性：同一字节串
 * 永远得到同一引用形态。
 */
export function quoteDiffPath(path: string): string {
  if (isSafeDiffPath(path)) {
    return path;
  }
  const bytes = new TextEncoder().encode(path);
  let out = '"';
  for (const byte of bytes) {
    if (byte === 0x22) {
      out += '\\"';
    } else if (byte === 0x5c) {
      out += "\\\\";
    } else if (byte >= 0x21 && byte <= 0x7e) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\${byte.toString(8).padStart(3, "0")}`;
    }
  }
  return `${out}"`;
}

/** 补丁文本的字节侧信息（清单 patch 段直接消费） */
export function diffBytesAndHash(diffText: string): { bytes: number; sha256: string } {
  const data = new TextEncoder().encode(diffText);
  return { bytes: data.byteLength, sha256: hashWorkspaceContent(data) };
}
