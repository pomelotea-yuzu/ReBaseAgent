import { useState } from "react";
import type { ReactNode } from "react";
import type { ConfirmationRow } from "../lib/execution-confirmation";
import { DisclosureButton } from "./Disclosure";
import { FOCUS_RING } from "./IconButton";

/**
 * UI 密度 change 3.1/3.2（design D4）：**核对与提交同一紧凑操作区**的共享确认块。
 *
 * 六个执行入口（messages / prompt / result 普通 / result 隔离 / 模型 A/B / 创建）此前
 * 各自渲染一个全展开的核对卡：费用、目标、检查与边界十几行 dl 常驻，把「核对」按钮和
 * 「提交」按钮顶开；prompt 编辑器还把整块塞进了按钮 flex 行里横排挤压。本组件统一为：
 *
 * 1. **标题行**：标题 + 关键摘要（`summary`，来自 lib 各 disclosure 的紧凑一句话——
 *    收起时费用/工具/文件副作用与门禁摘要仍然可见）+ 「已核对，确认本次…」按钮
 *    （带执行确认标记与 `aria-pressed`，判据全部由调用方传入，这里不复读）；
 * 2. **详细边界可展开**：facts/checks/limits 全表收进 1.1 的共享 `Disclosure`
 *    （默认收起——折叠只是阅读状态，不免除前置核对：确认按钮在标题行常驻）；
 * 3. **就近原因**：`blocked`（资格/预检/门禁不成立的原因）在详情区下方就近显示，
 *    不是只把按钮禁掉让人猜；
 * 4. 调用方把提交按钮行紧跟在本块之后（或经 `children` 放附加动作）——核对与提交
 *    之间不隔着长说明，键盘 Tab 顺序即视觉顺序。
 *
 * 判据与话术来源不变：rows 仍出自 `lib/execution-confirmation.ts` 的 `disclosureLines`，
 * 组件不写第二套「这次会怎样」的句子。展开态是本块会话内阅读状态（不进草稿、不进偏好）。
 */
export function ConfirmationBlock({
  title,
  summary,
  rows,
  confirmed,
  confirmDisabled,
  onConfirm,
  confirmLabel,
  confirmedLabel,
  blocked,
  controlsId,
  tone = "gray",
  children,
}: {
  /** 标题（如「核对本次重发」；与各入口既有措辞一致） */
  readonly title: string;
  /** 收起态仍可见的关键摘要（费用 / 工具·文件副作用 / 门禁一句话） */
  readonly summary: string;
  /** 详细边界全表（`disclosureLines(...)` 的输出；展开后逐行可读） */
  readonly rows: readonly ConfirmationRow[];
  readonly confirmed: boolean;
  /** 确认按钮的禁用判据（与各入口既有清单逐字一致，组件不复算） */
  readonly confirmDisabled: boolean;
  readonly onConfirm: () => void;
  /** 未确认态按钮文字（如「已核对，确认本次重发」） */
  readonly confirmLabel: string;
  /** 已确认态按钮文字（如「已确认重发」） */
  readonly confirmedLabel: string;
  /** 还不能确认的原因（资格 / 预检 / 门禁）；null = 现在就能确认 */
  readonly blocked: string | null;
  /** 详情区 id（`aria-controls` 指向；调用方保证同屏唯一） */
  readonly controlsId: string;
  /** 外框色调（与所在编辑器的既有配色一致） */
  readonly tone?: "gray" | "sky" | "emerald" | "violet";
  /** 附加内容（如 messages 的就近录制入口），渲染在原因行之后 */
  readonly children?: ReactNode;
}): ReactNode {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const borderClass =
    tone === "sky"
      ? "border-sky-200"
      : tone === "emerald"
        ? "border-emerald-200"
        : tone === "violet"
          ? "border-violet-200"
          : "border-gray-200";
  return (
    <div className={`mt-2 rounded border bg-white ${borderClass}`}>
      <div className="workspace-heading px-2 py-1.5">
        <div className="workspace-heading-object">
          <span className="text-[11px] font-medium text-gray-600">{title}</span>
        </div>
        <button
          type="button"
          data-confirm-execution
          aria-pressed={confirmed ? "true" : undefined}
          disabled={confirmDisabled || confirmed}
          onClick={onConfirm}
          className={`workspace-heading-actions shrink-0 rounded border px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING} ${
            confirmed
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-gray-300 text-gray-700 hover:bg-gray-50"
          }`}
        >
          {confirmed ? confirmedLabel : confirmLabel}
        </button>
        <span
          data-confirm-summary
          className="workspace-heading-summary text-[11px] leading-4 text-gray-500"
        >
          {summary}
        </span>
        <DisclosureButton
          expanded={detailsOpen}
          onToggle={() => setDetailsOpen((prev) => !prev)}
          label={detailsOpen ? "收起详细边界" : "展开详细边界"}
          controls={controlsId}
          className="workspace-heading-disclosure px-1 text-[11px] text-gray-600 hover:bg-gray-50"
        >
          详细边界
        </DisclosureButton>
        <div id={controlsId} className="workspace-heading-details" hidden={!detailsOpen}>
          {detailsOpen ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 px-1 pb-1.5 text-[11px] leading-4">
              {rows.map((row) => (
                <div
                  key={`${row.label}-${row.value}`}
                  className="col-span-2 grid grid-cols-subgrid"
                >
                  <dt className="text-gray-500">{row.label}</dt>
                  <dd className="min-w-0 break-words text-gray-700">{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
      {!confirmed && blocked !== null ? (
        <div className="border-t border-gray-100 px-2 py-1.5 text-[11px] leading-4 text-amber-800">
          {blocked}
        </div>
      ) : null}
      {children}
    </div>
  );
}
