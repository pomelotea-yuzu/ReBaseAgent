import type { ReactNode } from "react";
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
  onReturn,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly compactDescription?: string;
  /** 目标身份一行（如父 run + 首次调用）；null = 该页无运行目标（录制）或目标未绑定 */
  readonly targetLine: string | null;
  readonly returnAvailable: boolean;
  readonly onReturn: () => void;
  readonly children: ReactNode;
}): ReactNode {
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
            actions={
              <button
                type="button"
                aria-label="返回来源"
                onClick={onReturn}
                disabled={!returnAvailable}
                title={
                  returnAvailable
                    ? "返回来源"
                    : "本次会话没有记录来源位置（重载后来源失效），不能返回"
                }
                className={`rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-reading-meta text-sky-900 hover:bg-sky-100 disabled:opacity-40 ${FOCUS_RING}`}
              >
                返回来源
              </button>
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-reading-body font-semibold text-gray-900">{title}</h1>
              {returnAvailable ? (
                <button
                  type="button"
                  aria-label="返回来源"
                  onClick={onReturn}
                  className={`rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-reading-meta text-sky-900 hover:bg-sky-100 ${FOCUS_RING}`}
                >
                  返回来源
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="返回来源"
                  disabled
                  title="本次会话没有记录来源位置（重载后来源失效），不能返回"
                  className={`cursor-not-allowed rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-reading-meta text-gray-400 ${FOCUS_RING}`}
                >
                  返回来源
                </button>
              )}
            </div>
            <p className="mt-0.5 text-reading-meta leading-5 text-gray-500">{description}</p>
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
