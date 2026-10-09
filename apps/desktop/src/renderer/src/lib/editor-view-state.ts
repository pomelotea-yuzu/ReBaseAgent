/**
 * Monaco 编辑器视图状态的会话级保存/恢复（UI 密度 2.5 · design D3）。
 *
 * **问题**：草稿编辑器按编辑目标用 React `key` 硬重挂（切换 span/字段必须重置编辑态），
 * 但重挂会把 monaco 的视图状态（光标位置、滚动位置、折叠状态）一并丢掉——长 JSON
 * 草稿编辑到一半切走再切回来，光标回到 (0,0)、视口回到顶部，spec 场景
 * 「长草稿切换不丢输入」的**输入**本身存在 store 草稿里没丢，但**阅读位置**全丢。
 *
 * **方案**（design D3 原文「视图状态按草稿键/比较身份保存」）：
 * - 键 = `data-monaco-host` + `data-monaco-target` 组合（调用方已有的寻址身份，
 *   **零新 prop**：host 区分原值/草稿侧，target 区分编辑目标）；
 * - 值 = monaco `saveViewState()` 的 JSON 快照（纯数据对象，序列化安全）；
 * - 存储 = 模块级 Map（**会话级**，不持久化到盘——重开应用从顶部读起是合理默认）；
 * - 恢复时机 = 编辑器实例 mount（onMount 合成内，调用方 onMount 之后）；
 * - 保存时机 = 宿主组件卸载（effect cleanup）。
 *
 * **为什么 file diff 不参与**：文件页 diff 的滚动恢复已由 U2 任务 4.3 的专属通道
 * （`fileReading.contentScroll`）承载；view state 恢复会在其后再写一次滚动，
 * 两套通道打架。键推导要求 host+target **同时**存在 ⇒ file diff（只有 host，
 * 无 target）天然不启用，无需调用方做任何排除动作。
 *
 * **容错纪律**（tasks 2.5「非法 JSON」回归）：
 * - 保存端序列化失败（循环引用等）→ 不存、不抛；
 * - 恢复端解析失败（脏数据/未来换存储通道）→ 不应用、不抛。
 */

/** 会话级视图状态仓库：键 = host|target，值 = JSON 快照字符串。 */
const store = new Map<string, string>();

/**
 * 从组件已有的 `data-monaco-host` / `data-monaco-target` 推导视图状态键。
 *
 * 两者**都**是非空字符串才启用（返回键）；任一缺失/为空/类型不对返回 null
 * ⇒ 不启用。file diff 无 target ⇒ 天然不参与（见模块注释）。
 */
export function viewStateKeyOf(host: unknown, target: unknown): string | null {
  if (typeof host !== "string" || host.length === 0) return null;
  if (typeof target !== "string" || target.length === 0) return null;
  return `${host}|${target}`;
}

/**
 * 序列化视图状态快照；任何序列化失败（循环引用、BigInt 等）返回 null 不抛。
 * 导出仅为可测（非法 JSON 回归直接喂真函数）。
 */
export function stringifyViewState(state: unknown): string | null {
  try {
    const raw = JSON.stringify(state);
    return raw === undefined ? null : raw;
  } catch {
    return null;
  }
}

/**
 * 解析视图状态快照；非法 JSON / null / 非对象返回 null 不抛。
 * 导出仅为可测（理由同上）。
 */
export function parseViewStateJson(raw: string | null): unknown {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 视图状态承载者（monaco editor / diffEditor 的结构子集）。 */
export interface ViewStateEditorLike {
  saveViewState(): unknown;
  restoreViewState(state: unknown): void;
}

/**
 * 保存编辑器当前视图状态到会话仓库（卸载前由宿主 effect cleanup 调用）。
 *
 * editor 或 key 为 null（未启用 view state / 实例已消失）⇒ no-op；
 * 序列化失败 ⇒ 不存、不抛（不因为快照失败阻断卸载）。
 */
export function captureEditorViewState(
  editor: ViewStateEditorLike | null,
  key: string | null,
): void {
  if (editor === null || key === null) return;
  const raw = stringifyViewState(editor.saveViewState());
  if (raw === null) return;
  store.set(key, raw);
}

/**
 * 从会话仓库恢复视图状态（编辑器实例 mount 后调用）。
 *
 * 无存档 / 非法 JSON / 快照不是对象 ⇒ 跳过（编辑器保持默认视图，不抛）。
 */
export function restoreEditorViewState(
  editor: ViewStateEditorLike | null,
  key: string | null,
): void {
  if (editor === null || key === null) return;
  const raw = store.get(key);
  if (raw === undefined) return;
  const state = parseViewStateJson(raw);
  if (state === null || typeof state !== "object") return;
  editor.restoreViewState(state);
}

/** 测试专用：清空会话仓库（每条用例前调用，避免跨用例串状态）。 */
export function resetEditorViewStatesForTest(): void {
  store.clear();
}
