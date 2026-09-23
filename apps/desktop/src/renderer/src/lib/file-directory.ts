import type { WorkspaceInspectFile, WorkspaceInspectResult } from "@shared/ipc";

/**
 * U2 任务 3.4：文件目录的**路径搜索 + 变化筛选 + 空态派生**（纯逻辑层）。
 *
 * 对应 delta（requirement「文件目录支持真实变化筛选和路径查找」）：
 * - 搜索对**完整逻辑路径**做**不区分大小写**的子串匹配，并与变化筛选**组合**；
 * - 「有变化」只用 inspect 的 `added` / `modified`（**不依赖 mtime 或附件可用性**）；
 * - 默认：完成步骤看"有变化"、初始看"全部"（`auto`），显式选择后在会话内保留；
 * - 空清单 / 无变化 / 搜索无匹配 / 未录制或读取失败 **分开表达**；
 * - 筛选结果 **SHALL NOT** 冒充原始清单规模（故另给 `totalCount` / `filteredCount`）。
 */

export type ChangeFilter = "auto" | "all" | "changed";

/** `auto` 的实际落地：初始检查点（stepSpanId === null）看全部，完成步骤看有变化。 */
export function resolveChangeFilter(
  preference: ChangeFilter,
  isInitialCheckpoint: boolean,
): "all" | "changed" {
  if (preference === "all" || preference === "changed") return preference;
  return isInitialCheckpoint ? "all" : "changed";
}

/** 「有变化」的判据**只有** added / modified —— 不依赖 mtime、不依赖附件可用性。 */
export function hasChange(file: WorkspaceInspectFile): boolean {
  return file.change === "added" || file.change === "modified";
}

/**
 * 组合搜索与筛选。返回**保序**的子集（保持清单原顺序，便于用户对照）。
 *
 * ⚠️ 附件不可用（missing/corrupt）**不被标成新增或删除**：它只是不可读，`change` 字段仍取
 *    清单/哈希派生值，筛选只看 `change`（delta 明文"缺失或损坏不被标为删除或新增"）。
 */
export function filterFiles(
  files: readonly WorkspaceInspectFile[],
  query: string,
  filter: "all" | "changed",
): WorkspaceInspectFile[] {
  const needle = query.trim().toLowerCase();
  return files.filter((file) => {
    if (filter === "changed" && !hasChange(file)) return false;
    if (needle.length === 0) return true;
    return file.path.toLowerCase().includes(needle);
  });
}

/**
 * 目录的**空态成因**——四态必须分开表达（delta「空清单无变化和无匹配可区分」）。
 *
 * - `"empty-list"`：合法清单里**本来就没有任何文件**（世界内零文件）；
 * - `"no-change"`：有文件，但**相对本 run 初始无变化**（且处于"有变化"筛选下）；
 * - `"no-match"`：有文件，但**搜索词没有匹配项**；
 * - `"none"`：有可见结果，不空。
 *
 * ⚠️ 未录制 / 读取失败 **不得**折成以上任一空态——那属于清单层错误（`inspect === null`
 *    或 `inspectError !== null`），由调用方在更外层表达。故本函数只在**拿到了合法清单**时调用。
 */
export type DirectoryEmptyReason = "none" | "empty-list" | "no-change" | "no-match";

export function deriveDirectoryEmptyReason(
  inspect: WorkspaceInspectResult,
  query: string,
  filter: "all" | "changed",
): DirectoryEmptyReason {
  if (inspect.files.length === 0) return "empty-list";
  const visible = filterFiles(inspect.files, query, filter);
  if (visible.length > 0) return "none";
  // 有文件但筛没了：区分"是搜索词没匹配"还是"是变化筛选没结果"
  if (query.trim().length > 0) return "no-match";
  return "no-change";
}

/** 空态文案（供展示层直接渲染；调用方仍可自行覆盖措辞） */
export function directoryEmptyMessage(
  reason: DirectoryEmptyReason,
  ctx: { query: string; filter: "all" | "changed" },
): string {
  switch (reason) {
    case "empty-list":
      return "该检查点为空清单（世界内没有任何文件）。";
    case "no-change":
      return "清单里相对本 run 初始没有变化；可切到「全部」查看未变文件。";
    case "no-match":
      return `没有路径匹配「${ctx.query}」；可清空搜索查看全部。`;
    case "none":
      return "";
  }
}

/**
 * 清单规模与筛选计数**分开**（delta「清单规模与筛选计数分开」「筛选结果 SHALL NOT 冒充原始清单规模」）。
 */
export interface DirectoryCounts {
  /** 原始清单规模（未被搜索/筛选影响） */
  readonly total: number;
  /** 当前可见条数 */
  readonly visible: number;
  /** 是否处于"被过滤"状态（可见 < 总数） */
  readonly filtered: boolean;
}

export function directoryCounts(
  inspect: WorkspaceInspectResult,
  query: string,
  filter: "all" | "changed",
): DirectoryCounts {
  const total = inspect.files.length;
  const visible = filterFiles(inspect.files, query, filter).length;
  return { total, visible, filtered: visible < total };
}
