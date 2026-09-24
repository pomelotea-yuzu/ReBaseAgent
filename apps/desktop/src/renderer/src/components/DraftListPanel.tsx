import type { DraftListItem } from "../lib/draft-list";
import { FOCUS_RING } from "./IconButton";

/**
 * U3 任务 2.5：草稿列表的**纯展示**组件（design D2「两个入口复用同一列表视图」）。
 *
 * 本运行列表（DetailPanel 步骤页）与全局会话入口（GlobalBar）喂同一份
 * `DraftListItem[]`（来自 `lib/draft-list.ts` 的 `deriveDraftList`），只换
 * 过滤条件与提示文案，不造第二份存储或第二套视图。
 *
 * 三个动作都由挂载方注入（本组件不碰 store，保持无 jsdom 下的可测性）：
 * - 定位 → `openDraftAt`（切运行/页签/选中 span 或打开创建表单）
 * - 复制 → 写剪贴板（`item.copyText` 完整不截断）
 * - 放弃 → 挂载方确认后按 CAS 删除（放弃确认对话框的模态化归任务 5.2）
 */
export function DraftListPanel({
  items,
  emptyHint,
  onOpen,
  onCopy,
  onDiscard,
}: {
  items: ReadonlyArray<DraftListItem>;
  emptyHint: string;
  onOpen: (item: DraftListItem) => void;
  onCopy: (item: DraftListItem) => void;
  onDiscard: (item: DraftListItem) => void;
}) {
  if (items.length === 0) {
    return <div className="px-1 py-1 text-[11px] text-gray-400">{emptyHint}</div>;
  }
  return (
    <ul className="divide-y divide-gray-100">
      {items.map((item) => (
        <li key={item.listKey} className="py-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[11px] font-semibold text-gray-800">{item.title}</span>
            {item.dirty ? (
              <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800">未放弃</span>
            ) : null}
            <span className="ml-auto truncate font-code text-[10px] text-gray-400">
              {item.field === "create"
                ? "会话"
                : `run ${item.runId}${item.spanId !== null ? ` · ${item.spanId}` : ""}`}
            </span>
          </div>
          <div className="mt-0.5 break-all font-code text-[10px] leading-4 text-gray-500">
            {item.preview}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpen(item)}
              className={`rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
              title="定位到该草稿的编辑目标"
            >
              定位
            </button>
            <button
              type="button"
              onClick={() => onCopy(item)}
              className={`rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
              title="复制草稿完整内容"
            >
              复制
            </button>
            <button
              type="button"
              onClick={() => onDiscard(item)}
              className={`rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
              title="放弃该草稿（需确认；按当前修订校验）"
            >
              放弃
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
