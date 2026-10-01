import { useAppStore } from "../store";
import { AuxWorkspaceFrame } from "./AuxWorkspaceFrame";

/**
 * U8 任务 1.4：录制工作区（全局页，无运行目标）。
 *
 * 本任务只接外壳与导航（标题 / 返回来源 / 入口可达）；配置草稿、启停、真实地址
 * 复制与状态分层在 §2 落地（2.1–2.10），到时替换这里的占位说明——不提前声称
 * 已有的能力。
 */
export function RecordingWorkspace() {
  const location = useAppStore((s) => s.recordingReturnLocation);
  const returnToAuxSource = useAppStore((s) => s.returnToAuxSource);
  return (
    <AuxWorkspaceFrame
      title="录制接入"
      description="把现有 Agent 的 base_url 指到本地录制代理即可录制。配置、启停与真实监听状态在本工作区内操作。"
      targetLine={null}
      returnAvailable={location !== null}
      onReturn={() => void returnToAuxSource("recording")}
    >
      <div className="text-reading-meta text-gray-500">
        录制配置草稿与状态区随本 change §2 落地；当前可从设置查看既有代理配置。
      </div>
    </AuxWorkspaceFrame>
  );
}
