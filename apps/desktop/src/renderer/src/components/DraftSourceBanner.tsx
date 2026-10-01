import { FOCUS_RING } from "./IconButton";

/**
 * U3 任务 2.5：草稿来源失效视图（design D2「保留原身份和草稿供复制/放弃并阻止执行」）。
 *
 * 四个编辑器共用：判定来自任务 1.4 的重验函数（缺失/损坏/改变/资格失效都到这）；
 * 提交闸门由调用方叠加 `verdict.kind === "eligible"`，本组件只负责展示与两个动作。
 * 放弃走编辑器各自的 CAS（确认 + 按当前修订）；放弃确认对话框的模态化归任务 5.2。
 *
 * ⚠️ U8 3.1（2026-10-01）自 DetailPanel 原样搬出（ModelAbEditor 提取到独立文件时，
 * 共用的展示组件随迁；判据与渲染零改动）。
 */
export function DraftSourceBanner({
  reason,
  copyText,
  onDiscard,
}: {
  reason: string;
  copyText: string;
  onDiscard: () => void;
}) {
  return (
    <div
      data-draft-source-blocked="true"
      className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1.5"
    >
      <div className="text-[11px] leading-4 text-amber-900">来源失效，已禁止执行：{reason}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(copyText)}
          className={`rounded border border-amber-400 px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100 ${FOCUS_RING}`}
        >
          复制草稿内容
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className={`rounded border border-amber-400 px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100 ${FOCUS_RING}`}
        >
          放弃草稿
        </button>
        <span className="text-[10px] text-amber-700">
          草稿内容保留到明确放弃；重新校验通过后自动恢复执行资格
        </span>
      </div>
    </div>
  );
}
