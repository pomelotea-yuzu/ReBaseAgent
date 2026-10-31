import type { ReactNode } from "react";
import { useTranslator } from "../i18n";
import {
  type WorkspaceView,
  describeReturnFallbackReason,
  workspaceViewName,
} from "../lib/create-workspace";
import { FOCUS_RING } from "./IconButton";
import { WorkspaceHeading } from "./WorkspaceHeading";

/**
 * U8 任务 1.4：三个辅助工作区（录制 / 实验 / messages）的**共享外壳**。
 *
 * 只吃 props 的纯展示组件（本包无 jsdom，容器订阅 store、这里只排版——U5 4.2 定型的
 * 分层纪律）。外壳负责两条所有辅助工作区共有的义务：
 *
 * 1. **「返回来源」是显式入口**（design D1：录制→返回、messages→录制→返回编辑等
 *    都有显式入口）——按钮是真实可点的 `<button>`，不是一段说明文字；
 * 2. **来源失效诚实呈现**：没有来源引用（重载后必然失效）时按钮禁用并给出原因，
 *    不伪造一个回不去的入口。
 *
 * 正文（children）由各工作区容器给；本组件不猜任何数据。
 */
export function AuxWorkspaceFrame({
  title,
  description,
  compactDescription,
  targetLine,
  returnAvailable,
  returnLabel,
  returnFallback,
  onReturn,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly compactDescription?: string;
  /**
   * 目标身份一行（如父 run + 首次调用）；null = 该页无运行目标（录制）或目标未绑定。
   * UI 整理 2.2（delta「对象完整 ID 可访问并复制」）：放宽为 ReactNode，
   * 让调用方把 run ID 渲染成可复制的 ShortIdLabel（纯 string 无法承载复制按钮）。
   */
  readonly targetLine: ReactNode | null;
  readonly returnAvailable: boolean;
  /**
   * UI 整理 2.3（delta「返回入口 SHALL 使用可读目的地说明」）：
   * returnAvailable=true 时的入口文案（实际目的地，如「返回运行概览」）；缺省「返回来源」。
   */
  readonly returnLabel?: string;
  /**
   * UI 整理 2.3（N03「显示真实原因和可达退路」）：returnAvailable=false 时的失效原因
   * 与退路视图。给了就**就近**渲染原因文字 + 「回到 X」可用退路按钮（走 onReturn，
   * store 的返回动作本就实现 fallback）；不给则维持旧的禁用按钮形态。
   */
  readonly returnFallback?: {
    readonly reason: "no-location" | "run-missing";
    readonly fallbackView: WorkspaceView;
  } | null;
  readonly onReturn: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const translator = useTranslator();
  const returnButton = ((): ReactNode => {
    if (returnAvailable) {
      return (
        <button
          type="button"
          aria-label={returnLabel ?? translator.t("common.returnSource")}
          onClick={onReturn}
          className={`rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-reading-meta text-sky-900 hover:bg-sky-100 ${FOCUS_RING}`}
        >
          {returnLabel ?? translator.t("common.returnSource")}
        </button>
      );
    }
    if (returnFallback !== undefined && returnFallback !== null) {
      // 失效时按钮改为**诚实的退路**：文案说明落到哪，不冒充"返回来源"
      return (
        <button
          type="button"
          aria-label={translator.t("run.returnToWorkspace", {
            view: workspaceViewName(returnFallback.fallbackView, translator),
          })}
          onClick={onReturn}
          title={describeReturnFallbackReason(returnFallback.reason, translator)}
          className={`rounded border border-gray-300 bg-gray-50 px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-100 ${FOCUS_RING}`}
        >
          {translator.t("run.returnToWorkspace", {
            view: workspaceViewName(returnFallback.fallbackView, translator),
          })}
        </button>
      );
    }
    return (
      <button
        type="button"
        aria-label={translator.t("common.returnSource")}
        disabled
        title={translator.t("common.returnUnavailable")}
        className={`cursor-not-allowed rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-reading-meta text-gray-400 ${FOCUS_RING}`}
      >
        {translator.t("common.returnSource")}
      </button>
    );
  })();
  const fallbackReasonLine =
    !returnAvailable && returnFallback !== undefined && returnFallback !== null ? (
      <p className="mt-0.5 text-reading-meta leading-5 text-amber-700">
        {describeReturnFallbackReason(returnFallback.reason, translator)}
      </p>
    ) : null;
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-white"
      // U8 6.11 实机坐实（场景「键盘完成录制到重发闭环」THEN「返回有效来源焦点」）：
      // 「返回来源」后焦点落回本容器（不落 body）——store 的 returnToAuxSource 统一回焦，
      // 锚点即此属性（U7 5.9 返回比较的 data-compare-primary 同款）。
      data-aux-frame="true"
      tabIndex={-1}
    >
      <div className="border-b border-gray-200 px-4 py-2">
        {compactDescription ? (
          <WorkspaceHeading
            title={<h1 className="text-reading-body text-gray-900">{title}</h1>}
            target={targetLine}
            summary={<span className="text-gray-500">{compactDescription}</span>}
            details={
              <p className="py-1 text-reading-meta leading-5 text-gray-500">{description}</p>
            }
            actions={returnButton}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-reading-body font-semibold text-gray-900">{title}</h1>
              {returnButton}
            </div>
            <p className="mt-0.5 text-reading-meta leading-5 text-gray-500">{description}</p>
            {fallbackReasonLine}
            {targetLine !== null ? (
              <p className="mt-1 break-all font-code text-reading-meta text-gray-600">
                {targetLine}
              </p>
            ) : null}
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 px-4 py-3">{children}</div>
    </section>
  );
}
