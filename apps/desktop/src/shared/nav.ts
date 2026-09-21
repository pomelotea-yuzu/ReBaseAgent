/**
 * 运行导航的展示、搜索与稳定短 ID（U1 共用派生 · 任务 2.4）。
 *
 * 全部为纯函数，零 Electron / 零 Node——只吃 `runs:list` 已在手的 RunSummary[]。
 *
 * 短 ID 的纪律（对应 desktop-ui delta「run 列表从 traces 目录扫描派生」）：
 * - 从完整 ID **末尾** 8 字符起取；在**全部已加载记录**范围内按需逐字符延长，
 *   必要时用完整 ID（不只延到"够用"，还要处理"一个 ID 是另一个的后缀"）。
 * - 一个 ID 为另一个 ID 的后缀时，**较长者继续延长**——否则短 ID 相等会撞车。
 * - 输入按**完整 ID 排序**计算，结果**不依赖列表排序或筛选**：筛选/排序不重编号。
 * - 会话中已扩展的长度不因刷新删除碰撞项而**缩短**（长度只增不减，见 `ShortIdState`）。
 * - 全文复制始终用完整 ID；短 ID 只是界面标识。
 */

/** 短 ID 的最小长度（从末尾切 8 字符） */
const MIN_SHORT_ID = 8;

/**
 * 任务摘要的默认最大字符数（导航两行折叠的近似；中文按字符计）。
 * 具体像素级两行由 CSS 控制，这里只做导航列表的粗粒度兜底。
 */
const DEFAULT_TASK_SUMMARY_LIMIT = 80;

/** 折叠空白：把连续空白（含换行/制表/全角空格）压成单个空格并去首尾 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 任务摘要：折叠空白并限长（超长截断加省略号）。
 *
 * 只影响**展示**，不改原值——完整 task 仍用于搜索与复制。
 * 空任务不在此处兜底（回退由 `deriveNavLabel` 负责），因为「空」与「短」是两回事。
 */
export function taskSummary(task: string, limit: number = DEFAULT_TASK_SUMMARY_LIMIT): string {
  const collapsed = collapseWhitespace(task);
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit)}…`;
}

/** 完整任务/ID 搜索匹配（大小写不敏感，匹配原值，不做展示折叠） */
export function matchesSearch(run: { id: string; task: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  // 匹配**完整原值**：不因展示折叠/截断而漏配未显示在两行内的片段
  return run.task.toLowerCase().includes(needle) || run.id.toLowerCase().includes(needle);
}

/**
 * 计算一组 run 的稳定短 ID。
 *
 * 算法：从末尾 8 字符起，在**全部 ID 集合**内检查唯一性；不唯一则逐字符延长，
 * 直到唯一或到达完整 ID。特别处理**后缀包含**：若某 ID 是另一 ID 的后缀，
 * 较短者必须继续延长（否则其短 ID 恰等于较长者的短 ID）。
 *
 * 确定性：先对完整 ID 排序后计算，结果与输入顺序无关 ⇒ 筛选/排序不改变已算出的短 ID。
 */
export function computeShortIds(ids: readonly string[]): Map<string, string> {
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const result = new Map<string, string>();

  for (const id of sorted) {
    result.set(id, shortestUniqueSuffix(id, sorted));
  }
  return result;
}

/**
 * 取 id 在 `all` 中唯一的最短后缀（不低于 MIN_SHORT_ID）。
 *
 * 后缀包含处理：若 id 以另一个 id 结尾（如 "abc" 与 "zzabc"），则从末尾取到
 * 长度 > 那个较短 id 的长度才能区分——这里用「后缀与任何其它 id 的前缀关系」直接判等。
 */
function shortestUniqueSuffix(id: string, all: readonly string[]): string {
  const maxLen = id.length;
  for (let len = Math.min(MIN_SHORT_ID, maxLen); len <= maxLen; len++) {
    const candidate = id.slice(id.length - len);
    // 候选后缀不得与任何其它 id 的**同长后缀**相同 → 保证短 ID 唯一
    const collides = all.some((other) => {
      if (other === id) return false;
      return other.slice(Math.max(0, other.length - len)) === candidate;
    });
    if (!collides) return candidate;
  }
  return id; // 退到完整 ID（极长同名的情况）
}

/**
 * 会话内的短 ID 长度记忆：长度**只增不减**。
 *
 * 规则（对应 delta「发现新碰撞时延长」+「刷新删除碰撞项不缩短」）：
 * - 每次用当前全部记录重算最短后缀，与已记录长度取 max。
 * - 因此刷新后即使碰撞项被删除，已延长过的 ID 也不会缩短回 8 位。
 * - 新出现的碰撞项会使相关项在下次计算时延长。
 */
export class ShortIdState {
  private readonly lengths = new Map<string, number>();

  /** 用当前全部记录更新并返回短 ID 映射 */
  update(ids: readonly string[]): Map<string, string> {
    const fresh = computeShortIds(ids);
    const out = new Map<string, string>();
    for (const id of ids) {
      const computed = fresh.get(id) ?? id;
      const previous = this.lengths.get(id) ?? 0;
      // 只增不减：取历史与本次的较大者
      const length = Math.max(previous, computed.length);
      this.lengths.set(id, length);
      out.set(id, id.length <= length ? id : id.slice(id.length - length));
    }
    return out;
  }
}

/** 导航摘要（列表行的标题区），含空任务/缺失模型的回退 */
export interface NavLabel {
  /** 任务标题（空任务回退为来源/时间/短 ID 组合见 `navFallbackLabel`） */
  title: string;
  /** true 表示任务为空、标题是回退文案（调用方可加样式区分） */
  isFallback: boolean;
  /** 模型展示值（缺失为「未记录」） */
  model: string;
}

/**
 * 导航摘要：空任务回退为来源/时间/短 ID；缺失模型显示「未记录」。
 *
 * 时间与来源由调用方以 `fallbackParts` 传入（保持本函数零格式化依赖）。
 */
export function deriveNavLabel(
  run: { task: string; model: string },
  shortId: string,
  fallbackParts: { time: string; source: string },
): NavLabel {
  const collapsed = collapseWhitespace(run.task);
  const model = collapseWhitespace(run.model) === "" ? "未记录" : run.model;

  if (collapsed === "") {
    return {
      title: `${fallbackParts.source} · ${fallbackParts.time} · ${shortId}`,
      isFallback: true,
      model,
    };
  }
  return { title: taskSummary(collapsed), isFallback: false, model };
}

/** 来源过滤（全部 / 代理录制 / 本地记录），与搜索求交集 */
export function matchesSource(
  run: { source: "proxy" | null },
  filter: "all" | "proxy" | "local",
): boolean {
  if (filter === "all") return true;
  if (filter === "proxy") return run.source === "proxy";
  // 本地记录：无 source 字段的老文件归入此类（不猜测具体接入方式）
  return run.source !== "proxy";
}

/**
 * 组合筛选：搜索与来源条件求**交集**。
 * 不改动输入、不改原 task 值（搜索用完整原值）。
 */
export function filterRuns<T extends { id: string; task: string; source: "proxy" | null }>(
  runs: readonly T[],
  query: string,
  filter: "all" | "proxy" | "local",
): T[] {
  return runs.filter((run) => matchesSource(run, filter) && matchesSearch(run, query));
}
