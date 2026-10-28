/**
 * 中文资源是键契约的源：新增键先加在这里，英文资源按同一键补齐。
 * 复数用 { one?, other } 表示；中文只有 other 分支，英文必须提供 one 与 other。
 */
export const zhCN = {
  common: {
    appName: "ReBaseAgent",
    unknown: "未知",
    notRecorded: "未记录",
    notPreserved: "未保留（原状态未知）",
    notSupported: "不支持",
    cancel: "取消",
    confirm: "确认",
    back: "返回",
    loading: "加载中…",
    empty: "暂无内容",
    messageUnavailable: "此消息暂不可用",
    select: "选择",
    close: "关闭",
    copy: "复制",
    copied: "已复制",
    stepCount: { other: "{{count}} 步" },
    runSummary: "运行 {{runId}}：{{stepCount}} 步 · {{duration}}",
    runSummaryRich: "运行 <code>{{runId}}</code>：<strong>{{stepCount}}</strong> 步 · {{duration}}",
    deleteRunConfirm: "删除 <code>{{name}}</code>？此操作会移除本地记录。",
    chooseDataDirTitle: "选择 ReBaseAgent 数据目录",
    chooseDataDirMessage: "数据将只保存在该目录内。也可在程序旁放置 portable.marker 使用便携模式。",
    chooseDirectoryTitle: "选择目录",
    quit: "退出",
    quitAndDiscardDraft: "退出并丢弃草稿",
    draftCloseTitle: "退出 ReBaseAgent",
    draftCloseMessageDirty: "有未放弃的调试草稿",
    draftCloseMessageDirtyWithOperation: "有未放弃的调试草稿，且有操作正在执行",
    draftCloseMessageUnknown: "暂时无法确认草稿状态",
    draftCloseMessageUnknownWithOperation: "暂时无法确认草稿状态，且有操作正在执行",
    draftCloseMessageConfigurationBusy: "有一次配置变更尚未完成",
    draftCloseMessageActiveOperation: "有操作正在执行",
    draftCloseNoteDraftLost: "本轮会话中已输入的调试草稿在退出后将丢失，且无法恢复。",
    draftCloseNoteDraftUnknown:
      "暂时无法确认草稿状态，不能确定是否有未放弃的编辑。选择「返回」可继续使用应用，稍后再次退出时会重新核对。",
    draftCloseNoteActiveOperation:
      "还有已登记的主动操作尚未结束：退出不会取消上游请求，也不会撤销已产生的费用或副作用，操作记录同样不会标记为已取消。",
    draftCloseNoteConfigurationBusy:
      "还有一次配置变更尚未完成（保存配置或代理启停），退出不会让它回滚。",
    draftCloseNotePendingLoss:
      "此外，先前会话的调试草稿可能已经丢失（该会话在退出或重载前未能完成核对）。",
    draftCloseNoteContinue: "要继续编辑或保留当前操作请选择「返回」。",
    viewRuns: "运行记录",
    viewTree: "分支关系",
    viewSwitchLegend: "主视图切换",
    viewRunsHint: "运行记录视图：运行列表与概览、步骤、文件页签",
    viewTreeHint: "宽幅分支关系：节点为运行、连线为分叉，可勾选多条对照",
    collapseRunList: "收起运行列表",
    openRunList: "打开运行列表",
    newRun: "新建运行",
    newRunHint: "直接在桌面端跑一个 run（纯对话，或隔离文件运行；不需代理、不需写代码）",
    connectRecording: "录制接入",
    connectRecordingHint: "打开录制工作区，把现有 Agent 的 base_url 指过来即可录制",
    recordingEntry: "接入录制",
    runConfig: "运行配置",
    runConfigHint: "配置 LLM 接入（baseURL / apiKey / model），供“在此重跑”发起真实调用",
    proxyStatusHint:
      "本地录制代理：把你的 Agent 应用 base_url 指到 http://127.0.0.1:端口/v1，key 一字不动即可录制",
    proxyNoKey: "未捕获 key",
    proxyOpenRecordingFailedHint: "打开录制工作区查看受控原因、重读状态或重新保存并应用",
    proxyOpenRecordingRecoveringHint: "打开录制工作区查看本次启动恢复的进行情况",
    proxyFixInRecording: "去录制页处理",
    proxyRecovering: "恢复中…",
    focusHint: "临时收起辅助区域，退出后恢复原布局与阅读状态",
    exitFocus: "退出专注",
    focusDiff: "专注差异",
    focusEdit: "专注编辑",
    backToCompare: "返回比较",
    backToCompareAria: "返回比较工作区",
    comparePairKept: "比较对象已保留：左 {{left}} → 右 {{right}}",
    reopenSteps: "重新打开步骤目录",
    noRunsTitle: "数据目录里还没有运行记录",
    noRunsBody:
      "可以直接在这里跑一个 run（纯对话或隔离文件运行，不需要代理、不需要写代码），也可以在设置里打开录制代理，把你现有 Agent 的 base_url 指过来。",
    noRunsCreate: "新建运行",
    noRunsRecord: "接入录制",
    noRunsJsonlHint: "也可以把已有 *.jsonl 放进数据目录的 traces/ 后重新打开。",
    confirmDiscard: "确认放弃",
    discardDraftTitle: "放弃草稿",
    discardDraftMessage: "放弃「{{title}}」的草稿？\n内容将被删除，不可撤销。",
    discardDraftMessageScoped: "放弃「{{title}}」的草稿（{{scope}}）？\n内容将被删除，不可撤销。",
    detailsBoundary: "详细边界",
    detailsSummary: "详细说明",
    expand: "展开",
    collapse: "收起",
    disclosureLabel: "{{summary}}（{{action}}）",
    expandNamed: "展开{{name}}",
    collapseNamed: "收起{{name}}",
    resizeGripTitle: "{{label}} {{width}}px（{{min}}–{{max}}）· 拖动或 ←/→ 调整",
    longTextCollapsed: "{{label}}（{{count}} 字符，点击展开完整内容）",
    copyOriginal: "复制原文",
    copiedOriginal: "已复制原文",
    copyUnavailable: "当前环境不支持复制（可手动选择文本）",
    findInOriginal: "在原文中查找",
    findWithinLabel: "在{{label}}中查找",
    previous: "上一个",
    next: "下一个",
    noMatches: "无命中",
    matchPosition: "第 {{index}} / {{total}} 个",
    sessionActivity: "会话活动",
    sessionActivityHint:
      "本会话的活动：未提交修改、主动操作与结果待查看（同一处入口，不另设第二份状态）",
    draftCount: "修改 {{count}}",
    operationCount: "操作 {{count}}",
    resultCount: "结果 {{count}}",
    sectionDrafts: "未提交修改",
    sectionOperations: "主动操作",
    sectionResults: "结果待查看",
    needsAttentionDrafts: "需处理的修改",
    needsAttentionDraftsCount: "需处理的修改 · {{count}}",
    recordingDirty: "录制配置有未应用的修改",
    goRecording: "去录制",
    cleanSessions: "未修改的编辑会话 · {{count}}",
    noDirtyDrafts: "没有待处理的草稿修改。",
    noDirtyDraftsWithRecording: "草稿没有待处理的修改；上面的录制配置修改仍在。",
    noCleanSessions: "没有未修改的编辑会话。",
    sessionOperations: "本会话操作",
    sessionOperationsCount: "本会话操作 · {{count}}",
    refresh: "刷新",
    refreshHint: "重新读取主进程的操作快照（只读）",
    noOperations:
      "本会话还没有主动操作：新建运行、结果重跑、改提示词、代理重发或模型 A/B 提交后，会在这里显示真实状态与可信运行 ID。",
    resultsPending: "结果待查看",
    resultsPendingCount: "结果待查看 · {{count}}",
    noResultNotices: "没有待查看的结果通知。",
    activityNote:
      "「核对状态」只查操作登记（不读运行文件、不切页面）；要看内容请明确点「打开结果」。 面板关闭时结果通知仍经 polite live 区域播报，不抢当前页面。草稿不落盘，关闭应用即清空。",
    closeActivityPanel: "关闭会话活动面板",
  },
  run: {},
  detail: {},
  fork: {},
  experiment: {},
  compare: {},
  files: {},
  verification: {},
  recording: {},
  settings: {},
  export: {},
  errors: {
    generic: "操作未完成，请核对当前状态后再继续。",
    invalidArgument: "请求参数不符合要求。",
    notFound: "未找到请求的资源。",
    unknownOperation: "操作状态未知，请先核对。",
    unsupported: "当前版本不支持此操作。",
    conflict: "该操作已提交或正在执行。",
    staleCursor: "游标已失效，请重新发起查询。",
    preparationRequired: "环境尚未准备或准备记录不可用。",
  },
  mcp: {},
  cli: {},
} as const;

export type Namespace = keyof typeof zhCN;

type KeysOf<N extends Namespace> = Extract<keyof (typeof zhCN)[N], string>;

export type MessageKey = {
  [N in Namespace]: `${N}.${KeysOf<N>}`;
}[Namespace];

type PluralKeysOf<N extends Namespace> = {
  [K in KeysOf<N>]: (typeof zhCN)[N][K] extends object ? K : never;
}[KeysOf<N>];

export type PluralMessageKey = {
  [N in Namespace]: `${N}.${PluralKeysOf<N>}`;
}[Namespace];

export type PlainMessageKey = Exclude<MessageKey, PluralMessageKey>;

export type MessageValue = string | { readonly one?: string; readonly other: string };

export type ResourceCatalog = {
  [N in Namespace]: Record<KeysOf<N>, MessageValue>;
};

export type ResourceShape = ResourceCatalog;

export const NAMESPACES = Object.keys(zhCN) as Namespace[];
