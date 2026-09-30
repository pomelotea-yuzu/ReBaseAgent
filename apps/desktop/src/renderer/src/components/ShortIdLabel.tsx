import { useState } from "react";
import { copyPayload } from "./LongText";

/**
 * U7 任务 5.1：短 ID 展示 + 「复制完整 ID」的就地按钮。
 *
 * 判据来源（branch-tree delta「对照身份与四列指标保持可辨」）：
 * - 树、选择栏及对照标题 SHALL 复用全量已加载记录范围内的**稳定唯一短 ID**；
 * - 「复制得到完整 ID」——复制目标恒为完整 id，不是展示用的短后缀
 *   （与 LongText 的 `copyPayload` 同一可证伪契约，不抄第二份）。
 *
 * 短 ID 的计算与「长度只增不减」的会话记忆在 `shared/nav.ts`（ShortIdState），
 * 本组件只负责展示与复制，不重复算判据。
 *
 * ⚠️ 本包无 jsdom：复制在无 clipboard 的静态渲染下静默降级为「不可用」反馈，
 *    绝不抛——与 LongText 的复制路径同一纪律。
 */
export function ShortIdLabel({
  id,
  shortId,
  label = "ID",
}: {
  /** 完整 run id（复制的唯一目标；title 悬停可读全文） */
  readonly id: string;
  /** 会话稳定短 ID（由调用方从 ShortIdState 取，本组件不重算） */
  readonly shortId: string;
  /** 可访问名称里的对象名（如「复制完整 ID r_ab12…」） */
  readonly label?: string;
}) {
  const [feedback, setFeedback] = useState<"copied" | "unavailable" | null>(null);

  const copy = (): void => {
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: unknown } } })
      .navigator?.clipboard;
    if (
      clipboard === undefined ||
      typeof (clipboard as { writeText?: unknown }).writeText !== "function"
    ) {
      setFeedback("unavailable");
      return;
    }
    void (clipboard as { writeText: (t: string) => Promise<void> })
      .writeText(copyPayload(id))
      .then(() => setFeedback("copied"))
      .catch(() => setFeedback("unavailable"));
  };

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="truncate font-code text-xs text-gray-700" title={id}>
        {shortId}
      </span>
      <button
        type="button"
        aria-label={`复制完整 ${label} ${id}`}
        title={`复制完整 ID：${id}`}
        onClick={copy}
        className="shrink-0 rounded px-1 text-[10px] text-gray-400 hover:bg-gray-100 hover:text-gray-600"
      >
        复制
      </button>
      {feedback !== null ? (
        <span className="text-[10px] text-gray-400" aria-live="polite">
          {feedback === "copied" ? "已复制完整 ID" : "当前环境不支持复制"}
        </span>
      ) : null}
    </span>
  );
}
