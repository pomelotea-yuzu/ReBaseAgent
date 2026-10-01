import { useAppStore } from "../store";
import { AuxWorkspaceFrame } from "./AuxWorkspaceFrame";

/**
 * U8 任务 1.4：messages 编辑工作区（目标 = 代理 run + 自有 llm.call）。
 *
 * 本任务只接外壳与目标身份呈现；完整 JSON 编辑器、凭据门禁与单请求重发在 §5 落地
 * （5.1–5.5）后替换占位说明。目标未绑定时如实呈现，不伪造身份。
 */
export function MessagesWorkspace() {
  const target = useAppStore((s) => s.messagesTarget);
  const location = useAppStore((s) => s.messagesReturnLocation);
  const returnToAuxSource = useAppStore((s) => s.returnToAuxSource);
  return (
    <AuxWorkspaceFrame
      title="编辑 messages 重发"
      description="编辑一次代理录制的模型请求并作为单个真实请求重发（不执行外部工具）。编辑器随本 change §5 落地。"
      targetLine={
        target === null
          ? "未绑定编辑目标（会话内目标不跨重载保留；从代理调用的「编辑 messages 重发」重新进入即可）"
          : `源 run ${target.runId} · 调用 ${target.spanId}`
      }
      returnAvailable={location !== null}
      onReturn={() => void returnToAuxSource("messages")}
    >
      <div className="text-reading-meta text-gray-500">
        完整 JSON 编辑器与重发随本 change §5 落地；重发使用本会话代理捕获的凭据。
      </div>
    </AuxWorkspaceFrame>
  );
}
