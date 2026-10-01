import { useAppStore } from "../store";
import { AuxWorkspaceFrame } from "./AuxWorkspaceFrame";
import { requestConfirm } from "./ConfirmDialog";
import { RecordingWorkspaceView } from "./RecordingWorkspaceView";

/**
 * U8 任务 2.7–2.9：录制工作区容器（订阅 store 并转发动作；判据在纯视图与
 * `lib/recording-draft.ts`，本组件不另写第二份）。
 *
 * - 「录制放弃取消及修订竞争」：放弃走**真模态确认**（可取消；取消零调用），
 *   CAS 按确认请求时的修订快照校验（store 的 discardRecordingDraftConfirmed）；
 * - 「录制刷新只读且错误可重试」：状态刷新 = loadProxyStatus（只读），列表刷新 = loadRuns；
 * - 「查看代理记录保留选择和搜索」：设代理来源筛选并回到轨迹视图（运行列表在场），
 *   不清当前选择、不动搜索词。
 */
export function RecordingWorkspace() {
  const draft = useAppStore((s) => s.recordingDraft);
  const location = useAppStore((s) => s.recordingReturnLocation);
  const returnToAuxSource = useAppStore((s) => s.returnToAuxSource);

  if (draft === null) {
    // 理论不可达（App 打开录制即 ensure）；重载后直接渲染本视图的兜底
    return (
      <AuxWorkspaceFrame
        title="录制接入"
        description="录制配置在本工作区内操作。"
        targetLine={null}
        returnAvailable={location !== null}
        onReturn={() => void returnToAuxSource("recording")}
      >
        <button
          type="button"
          onClick={() => useAppStore.getState().openRecordingWorkspace()}
          className="rounded border border-gray-300 px-2 py-1 text-reading-meta text-gray-700 hover:bg-gray-50"
        >
          初始化录制配置
        </button>
      </AuxWorkspaceFrame>
    );
  }

  return (
    <RecordingWorkspaceConnected
      draft={draft}
      returnAvailable={location !== null}
      onReturn={() => void returnToAuxSource("recording")}
    />
  );
}

function RecordingWorkspaceConnected({
  draft,
  returnAvailable,
  onReturn,
}: {
  draft: RecordingWorkspaceDraft;
  returnAvailable: boolean;
  onReturn: () => void;
}) {
  const proxy = useAppStore((s) => s.proxy);
  const statusReadFailed = useAppStore((s) => s.recordingStatusReadFailed);
  const applying = useAppStore((s) => s.recordingApply !== null);
  const applyError = useAppStore((s) => s.recordingApplyError);
  const writeRecordingDraftFields = useAppStore((s) => s.writeRecordingDraftFields);
  const discardRecordingDraftConfirmed = useAppStore((s) => s.discardRecordingDraftConfirmed);
  const applyRecordingDraft = useAppStore((s) => s.applyRecordingDraft);
  const loadProxyStatus = useAppStore((s) => s.loadProxyStatus);
  const loadRuns = useAppStore((s) => s.loadRuns);
  const setSourceFilter = useAppStore((s) => s.setSourceFilter);
  const setView = useAppStore((s) => s.setView);

  return (
    <AuxWorkspaceFrame
      title="录制接入"
      description="把现有 Agent 的 base_url 指到本地录制代理即可录制。配置、启停与真实监听状态在本工作区内操作。"
      targetLine={null}
      returnAvailable={returnAvailable}
      onReturn={onReturn}
    >
      <RecordingWorkspaceView
        draft={draft}
        proxy={proxy}
        statusReadFailed={statusReadFailed}
        applying={applying}
        applyError={applyError}
        onField={writeRecordingDraftFields}
        onApply={() => void applyRecordingDraft()}
        onDiscard={(expectedRevision) => {
          const snapshot = useAppStore.getState().recordingDraft;
          if (snapshot === null) return;
          void requestConfirm({
            title: "放弃录制配置的未应用修改",
            message: `放弃这些未应用的录制配置修改？\n\n端口：${snapshot.portText}\nupstream：${snapshot.upstreamText}\n启用意图：${snapshot.enabled ? "开" : "关"}\n\n放弃按确认时的修订校验：此后若输入又有变化，本次放弃不会执行；放弃不调用任何配置写通道（只是回到已核实的保存配置）。`,
          }).then((confirmed) => {
            if (confirmed) discardRecordingDraftConfirmed(expectedRevision);
          });
        }}
        onRefreshStatus={() => void loadProxyStatus()}
        onOpenRecords={() => {
          // 打开运行导航并设代理来源筛选；当前选择与搜索词不动（场景「查看代理记录保留选择和搜索」）
          setSourceFilter("proxy");
          setView("trace");
        }}
        onRefreshRuns={() => void loadRuns()}
      />
    </AuxWorkspaceFrame>
  );
}

/** 容器转发用的草稿形状（与 store 的 recordingDraft 同一类型，不另造） */
type RecordingWorkspaceDraft = NonNullable<
  ReturnType<typeof useAppStore.getState>["recordingDraft"]
>;
