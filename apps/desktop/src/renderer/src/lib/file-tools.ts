/**
 * U2 任务 4.4 / 4.5 / 4.6 · 阅读工具的**可启用性判据与文案**（纯逻辑层，design D6）。
 *
 * 一条总纲：**工具按"实际可读 / 可比较 / 编辑器就绪"启用，不可用时给出说明**（delta
 * 「不可比较或未就绪时工具诚实禁用」）。绝不"看着像能用其实点了没反应"。
 *
 * ⚠️ 只读边界：本模块**没有任何**编辑 / 替换 / 回写 / 导出入口的判据——delta 明令
 *    「SHALL NOT 增加编辑、替换、回写、应用补丁或导出入口」。原文复制只取**已读出的
 *    text**，不受折叠/搜索/换行/虚拟滚动影响（复制的是逻辑全文，不是显示片段）。
 */

import type { WorkspaceReadFileResult } from "@shared/ipc";

/** 一侧的可读性（供工具启用判据消费） */
export type SideReadiness = "ready" | "loading" | "failed" | "unavailable" | "not_found" | "empty";

/**
 * 把 connect-to 层的读取结果归成"该侧能不能被当文本源"。
 *
 * ⚠️ `text` 的**空串是合法空文件**（delta「text 空串与 0 B 作为真实空文件」），
 *    故空串归 `ready`（不是 `empty`）——`empty` 只用于"还没有任何结果"。
 */
export function sideReadiness(
  result: WorkspaceReadFileResult | null,
  opts: { loading: boolean; failed: boolean },
): SideReadiness {
  if (result === null) {
    if (opts.failed) return "failed";
    if (opts.loading) return "loading";
    return "empty";
  }
  switch (result.status) {
    case "text":
      return "ready";
    case "not_found":
      return "not_found";
    case "binary":
    case "missing":
    case "corrupt":
    case "rejected":
      return "unavailable";
    default:
      return "unavailable";
  }
}

/** 取某一侧的**完整原文**用于复制；不可读侧返回 null（绝不拿空串冒充） */
export function copyableText(result: WorkspaceReadFileResult | null): string | null {
  if (result === null) return null;
  return result.status === "text" ? result.text : null;
}

/** 二进制/不可用附件的**可复制元信息**（真实大小 + 完整哈希；delta「复制真实大小/哈希」） */
export function copyableMeta(
  result: WorkspaceReadFileResult | null,
): { bytes: number; sha256: string } | null {
  if (result === null) return null;
  if (result.status === "binary" || result.status === "missing" || result.status === "corrupt") {
    return { bytes: result.bytes, sha256: result.sha256 };
  }
  if (result.status === "text") {
    return { bytes: result.bytes, sha256: result.sha256 };
  }
  return null;
}

/** 工具启用状态 + 禁用原因（供 title/aria 说明） */
export interface ToolEnablement {
  readonly copyPath: boolean;
  readonly copyLeftText: boolean;
  readonly copyRightText: boolean;
  readonly copyMeta: boolean;
  readonly find: boolean;
  readonly wordWrap: boolean;
  readonly prevDiff: boolean;
  readonly nextDiff: boolean;
  readonly modeToggle: boolean;
}

/**
 * 工具可启用性总判据。
 *
 * - **路径复制**：只要有路径即可（哪怕清单还没回来）——复制的是逻辑路径字符串；
 * - **原文复制**：该侧 `ready` 才可（二进制/不可用/未读一律禁，禁时给元信息替代）；
 * - **元信息复制**：任一侧拿到了结果且带大小/哈希即可；
 * - **查找 / 换行**：至少一侧 `ready` 且**编辑器就绪** —— 并排/inline diff、或**只读单侧视图**
 *   都算就绪（U2 5.4 实机修正：原先绑在 `diffEligible` 上，导致"一侧可读、另一侧不可比较"
 *   时把可读侧的查找/换行一并禁掉，违反 delta「单侧可读时该侧仍可复制查找」）；
 * - **上一/下一差异**：**只有并排且两侧都有文本**才有真实 diff 可导航（无差异不假跳转）；
 * - **模式切换**：内容区已可进 diff（即 `canEnterTextDiff`）时才给。
 */
export function resolveToolEnablement(input: {
  hasPath: boolean;
  left: SideReadiness;
  right: SideReadiness;
  /** 是否可进入文本 diff（由 `canEnterTextDiff` 决定） */
  diffEligible: boolean;
  /**
   * 是否已渲染出**可用的只读编辑器**（并排 diff 或**单侧只读视图**）。
   *
   * ⚠️ 与 `diffEligible` 必须分开：单侧可读时没有 diff，但可读侧**确实有编辑器**，
   *    该侧的查找/换行应当可用（delta「不可比较或未就绪时工具诚实禁用」的
   *    "单侧可读时该侧仍可复制查找"）。把二者合并即 5.4 实机坐实的缺陷。
   */
  editorReady: boolean;
  /** 实际落地模式 */
  mode: "inline" | "sideBySide";
  /** 是否存在至少一条差异（由真实 diff 计算得出；未知时传 0 表示"暂无"） */
  diffCount: number;
}): ToolEnablement {
  const anyReady = input.left === "ready" || input.right === "ready";
  const bothReady = input.left === "ready" && input.right === "ready";
  return {
    copyPath: input.hasPath,
    copyLeftText: input.left === "ready",
    copyRightText: input.right === "ready",
    copyMeta: input.left === "unavailable" || input.right === "unavailable",
    find: anyReady && input.editorReady,
    wordWrap: anyReady && input.editorReady,
    // 差异导航要求真实 diff：并排 + 两侧文本 + 已知差异数 > 0
    prevDiff: input.diffEligible && input.mode === "sideBySide" && bothReady && input.diffCount > 0,
    nextDiff: input.diffEligible && input.mode === "sideBySide" && bothReady && input.diffCount > 0,
    modeToggle: input.diffEligible,
  };
}

/**
 * 剪贴板写入（就近反馈失败，不假报成功）。
 *
 * ⚠️ 只读：写的是**系统剪贴板**，不是文件。失败时返回错误信息供就近提示。
 */
export async function writeClipboard(
  text: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      return { ok: false, message: "当前环境不支持剪贴板" };
    }
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
