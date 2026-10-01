import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { resolveExecutionGate } from "../lib/workspace-selection";
import { useAppStore } from "../store";
import { AuxWorkspaceFrame } from "./AuxWorkspaceFrame";
import { MessagesForkEditor } from "./MessagesForkEditor";

/**
 * U8 任务 5.1b：messages 编辑工作区容器——**目标作用域**的源读取与编辑器挂载
 * （design D7）。
 *
 * 与 ExperimentWorkspace 同构的三条边界：
 * 1. 源详情走**自己的只读读取**（`readMessagesSource`），不借用全局 `detail`
 *    ——目标不跟随侧栏选择，全局详情在这里会看错对象；读取不改选中项、不切页；
 * 2. 目标 span 必须在源详情里点名存在（自有 llm.call）；详情读不出/换内容时
 *    如实说明，不拿别的 span 顶上（5.2 的来源重验在编辑器内部按同一份详情进行）；
 * 3. 源可用性按**目标**计算（列表在场 + 非 ownOnly + 读取中），传给编辑器覆盖
 *    全局选中作用域的默认门禁；凭据门禁（running/hasKey）在编辑器内部就近呈现（5.2）。
 */
export function MessagesWorkspace() {
  const target = useAppStore((s) => s.messagesTarget);
  const source = useAppStore((s) => s.messagesSource);
  const location = useAppStore((s) => s.messagesReturnLocation);
  const returnToAuxSource = useAppStore((s) => s.returnToAuxSource);
  const readMessagesSource = useAppStore((s) => s.readMessagesSource);
  const runs = useAppStore((s) => s.runs);

  // 目标在场且尚未读到 ⇒ 发起只读读取（换目标后 openMessagesWorkspace 已回到 idle）
  useEffect(() => {
    if (target !== null && source.phase === "idle") {
      void readMessagesSource();
    }
  }, [target, source.phase, readMessagesSource]);

  const targetInList = target !== null && runs.some((run) => run.id === target.runId);
  const targetExecutable = resolveExecutionGate({
    unavailable: !targetInList,
    reading: source.phase === "reading",
    listLoaded: true,
    // 已封存完整代理来源是重发资格的一部分（design D7）：ownOnly ⇒ 禁重发
    lineageIncomplete: source.detail?.completeness === "ownOnly",
  });

  const span =
    target !== null && source.phase === "ready"
      ? (source.detail?.spans.find(
          (candidate): candidate is Extract<SpanLine, { kind: "llm.call" }> =>
            candidate.id === target.spanId && candidate.kind === "llm.call",
        ) ?? null)
      : null;

  let body: ReactNode;
  if (target === null) {
    body = (
      <div className="text-reading-meta text-gray-500">
        未绑定编辑目标（会话内目标不跨重载保留；从代理调用的「编辑 messages 重发」重新进入即可）。
      </div>
    );
  } else if (source.phase === "failed") {
    body = (
      <div className="flex flex-col gap-2 text-reading-meta" data-messages-source-failed>
        <span className="text-red-700">源详情读取失败：{source.errorMessage}</span>
        <button
          type="button"
          onClick={() => void readMessagesSource()}
          className="w-fit rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50"
        >
          只读重试
        </button>
      </div>
    );
  } else if (source.phase !== "ready" || source.detail === null) {
    body = <div className="text-reading-meta text-gray-500">正在读取源详情…</div>;
  } else if (span === null) {
    body = (
      <div className="text-reading-meta text-amber-700" data-messages-source-span-missing>
        源详情里找不到目标调用（{target.spanId}
        ）：详情内容可能已改变；编辑草稿保留，重发入口不可用。
      </div>
    );
  } else {
    body = (
      <MessagesForkEditor
        key={`${target.runId}:${target.spanId}`}
        span={span}
        run={source.detail}
        sourceExecutable={targetExecutable}
        alwaysOpen={true}
      />
    );
  }

  return (
    <AuxWorkspaceFrame
      title="编辑 messages 重发"
      description="编辑一次代理录制的模型请求并作为单个真实请求重发（不执行外部工具）。重发使用本会话代理捕获的凭据。"
      targetLine={target === null ? null : `源 run ${target.runId} · 调用 ${target.spanId}`}
      returnAvailable={location !== null}
      onReturn={() => void returnToAuxSource("messages")}
    >
      {body}
    </AuxWorkspaceFrame>
  );
}
