/**
 * 运行导航的「刷新状态 / 重试 / 空结果」展示判据（U1 · 任务 4.5）。
 *
 * 全部为纯函数，零 Electron / 零 React——只吃 store 已在手的状态位。
 *
 * 纪律（对应 desktop-ui delta「刷新合并且保留阅读」）：
 *   - 「未更新」（stale）只在**曾经成功加载过**时出现：首次加载失败不叫"未更新"，
 *     因为本来就没有可过期的数据（与 `resolveRefreshFailure` 同源）。
 *   - 刷新进行中**保留旧列表**，不显示"加载中…"盖掉已有记录——只在首次无数据时才显示。
 *   - 空结果有**两种成因**，文案必须分开：有筛选条件（"没有匹配"）与真的没有记录
 *     （"还没有运行记录"）。把筛选空结果说成"没有记录"会误导用户去 traces/ 找文件。
 */

/** 导航在刷新/失败下的展示状态 */
export interface NavListState {
  /** 是否显示"加载中…"占位（仅首次、无任何已加载数据时） */
  showLoading: boolean;
  /** 是否显示"未更新"提示（有过成功加载后的刷新失败） */
  showStale: boolean;
  /** 失败信息（首次失败的可重试错误 / 刷新失败的未更新说明）；null = 无失败 */
  failure: string | null;
  /** 是否显示"重试"入口（any failure ⇒ 可重试） */
  canRetry: boolean;
}

/**
 * 由 store 状态位推导导航的刷新展示结论。
 *
 * ⚠️ **不接 `listLoaded`**：store 的 `listStale` 已经由 `resolveRefreshFailure(hadLoadedBefore)`
 *    保证「只有曾成功加载过才为真」——首次失败时 `listLoaded === false` 且 `listStale === false`。
 *    这里再判一次 `stale && loaded` 是**冗余的**（变异验证证实：去掉 `loaded` 判据无任何用例变红，
 *    因为它是等价式）。冗余判据会让人误以为"在这里还能拦住什么"，故直接省略，
 *    把「未更新」的唯一真源留给 store 的 `listStale`。
 *
 * @param loading      本次是否正在刷新（`loadingList`）
 * @param stale        列表是否被标记为未更新（`listStale`，已含"曾成功加载"语义）
 * @param error        当前错误信息（`error`）；null 表示无失败
 * @param hasAnyData   是否已有可显示的数据（`runs.length + failed.length > 0`）
 */
export function resolveNavListState(input: {
  loading: boolean;
  stale: boolean;
  error: string | null;
  hasAnyData: boolean;
}): NavListState {
  const { loading, stale, error, hasAnyData } = input;
  return {
    // 只有"从没成功加载过、也没有任何数据"时才显示占位，不盖掉已有记录
    showLoading: loading && !hasAnyData,
    // 「未更新」的唯一真源是 store 的 listStale（它已保证"曾成功加载"）
    showStale: stale,
    failure: error,
    canRetry: error !== null,
  };
}

/** 空结果的成因 */
export type EmptyCause = "filtered" | "no-records";

/**
 * 判定空列表属于哪一种成因。
 *
 * 「筛选后为空」与「真的没有记录」是两回事：前者给"清除条件"，后者给"新建/放文件"。
 * 把前者说成后者会让用户去 traces/ 找根本不存在的文件。
 */
export function resolveEmptyCause(input: {
  hasActiveFilters: boolean;
  hasAnyData: boolean;
}): EmptyCause | null {
  if (input.hasAnyData) return null;
  return input.hasActiveFilters ? "filtered" : "no-records";
}

/**
 * 短 ID 的复制用值：**永远是完整 ID**。
 *
 * delta 明确「全文复制始终使用完整 ID；短 ID 只是界面标识」。
 * 这个函数存在的意义是把这条纪律落成一个**可断言的单点**——任何"复制短 ID"的写法都是错的，
 * 而它让错误写法在测试里无处可藏。
 */
export function copyValueForRun(runId: string): string {
  return runId;
}
