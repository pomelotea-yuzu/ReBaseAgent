import { useAppStore } from "../store";
import { AuxWorkspaceFrame } from "./AuxWorkspaceFrame";

/**
 * U8 任务 1.4：实验工作区（目标 = 父 run + 首次自有 llm.call，1.3 显式绑定）。
 *
 * 本任务只接外壳与目标身份呈现；臂编辑、计划预览与费用确认在 §3 落地（3.1–3.10）
 * 后替换占位说明。目标未绑定（重载后内存目标丢失）如实呈现，不伪造身份。
 */
export function ExperimentWorkspace() {
  const target = useAppStore((s) => s.experimentTarget);
  const location = useAppStore((s) => s.experimentReturnLocation);
  const returnToAuxSource = useAppStore((s) => s.returnToAuxSource);
  return (
    <AuxWorkspaceFrame
      title="模型实验"
      description="以一个普通运行及其首次模型调用为父本，编排多臂参数对比。臂编辑与计划预览随本 change §3 落地。"
      targetLine={
        target === null
          ? "未绑定实验目标（会话内目标不跨重载保留；从运行的更多操作重新进入即可）"
          : `父本 ${target.runId} · 首次模型调用 ${target.spanId}`
      }
      returnAvailable={location !== null}
      onReturn={() => void returnToAuxSource("experiment")}
    >
      <div className="text-reading-meta text-gray-500">
        臂编辑与计划预览随本 change §3 落地；目标身份只由显式进入动作绑定，切运行不更换父本。
      </div>
    </AuxWorkspaceFrame>
  );
}
