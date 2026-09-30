import type { RunSummary } from "@shared/ipc";
import { taskSummary } from "@shared/nav";
import { MAX_COMPARE, useAppStore } from "../store";
import { FOCUS_RING } from "./IconButton";
import { ShortIdLabel } from "./ShortIdLabel";

/** store 薄壳：把对照集合、提示与动作接进纯展示层 */
export function CompareSelectionBar() {
  const runs = useAppStore((s) => s.runs);
  const compareIds = useAppStore((s) => s.compareIds);
  const compareNotice = useAppStore((s) => s.compareNotice);
  const toggleCompare = useAppStore((s) => s.toggleCompare);
  const clearCompare = useAppStore((s) => s.clearCompare);
  const openCompareWorkspace = useAppStore((s) => s.openCompareWorkspace);
  // U7 5.1/5.2：会话稳定短 ID（与运行导航/树同一实例）
  const shortIdState = useAppStore((s) => s.shortIdState);
  const shortIds = shortIdState.update(runs.map((run) => run.id));

  return (
    <CompareSelectionBarView
      runs={runs}
      compareIds={compareIds}
      compareNotice={compareNotice}
      shortIds={shortIds}
      maxCompare={MAX_COMPARE}
      onToggleCompare={(id) => toggleCompare(id)}
      onClear={clearCompare}
      onEnter={() => {
        void openCompareWorkspace();
      }}
    />
  );
}

/**
 * U7 任务 5.2：树视图的**对照选择栏**（替换原 256px 窄侧栏 ComparePanel）。
 *
 * 判据来源（UI 方案 §14 + desktop-ui delta「界面提供分支树与轨迹两种视图」）：
 * - 树视图主区域呈现"宽幅分支关系与**比较选择入口**"——指标对照与双运行正文
 *   在完整工作区内打开，不再挤在固定窄侧栏；
 * - 选择栏显示已选对象与移除按钮；恰好两条可进入详细比较；三或四条先进入
 *   宽幅指标表显式选两条（§5.3）；零/单条按数量如实引导；
 * - 身份用会话稳定短 ID + 复制完整 ID（5.1 同一判据）。
 *
 * ⚠️ 只吃 props：上限拒绝提示（compareNotice）由 store 的 toggleCompare 写下，
 * 这里只呈现；进入动作走 store 的 `openCompareWorkspace`（进入/交换不改集合）。
 */
export function CompareSelectionBarView({
  runs,
  compareIds,
  compareNotice,
  shortIds,
  maxCompare,
  onToggleCompare,
  onClear,
  onEnter,
}: {
  runs: ReadonlyArray<RunSummary>;
  compareIds: ReadonlyArray<string>;
  compareNotice: string | null;
  /** 会话稳定短 ID（容器从 ShortIdState 现算后传入） */
  shortIds: ReadonlyMap<string, string>;
  maxCompare: number;
  onToggleCompare: (id: string) => void;
  onClear: () => void;
  onEnter: () => void;
}) {
  const byId = new Map(runs.map((run) => [run.id, run]));
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-t border-gray-200 bg-white px-3 py-2"
      aria-label="对照选择栏"
    >
      <div className="text-xs font-medium text-gray-700">对照</div>
      <div className="text-[11px] text-gray-500">
        已选 {compareIds.length} / {maxCompare}
      </div>
      {compareNotice !== null ? (
        <output className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          {compareNotice}
        </output>
      ) : null}
      {compareIds.length === 0 ? (
        <div className="text-[11px] text-gray-500">勾选分支树节点即可加入对照（最多四条）。</div>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {compareIds.map((id) => {
              const run = byId.get(id);
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5"
                >
                  <ShortIdLabel id={id} shortId={shortIds.get(id) ?? id} />
                  {run !== undefined && run.task !== "" ? (
                    <span
                      className="max-w-[180px] truncate text-[11px] text-gray-500"
                      title={run.task}
                    >
                      {taskSummary(run.task, 40)}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`移出对照 ${id}`}
                    onClick={() => onToggleCompare(id)}
                    className={`rounded px-1 text-[11px] text-gray-400 hover:bg-gray-200 hover:text-gray-600 ${FOCUS_RING}`}
                  >
                    移出
                  </button>
                </span>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="进入对照与比较工作区"
            onClick={onEnter}
            className={`rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
          >
            {compareIds.length === 2 ? "进入详细比较" : "进入指标对照"}
          </button>
          <button
            type="button"
            aria-label="清空对照集合"
            onClick={onClear}
            className={`rounded px-1.5 py-1 text-[11px] text-gray-500 hover:bg-gray-100 ${FOCUS_RING}`}
          >
            清空
          </button>
        </>
      )}
    </div>
  );
}
