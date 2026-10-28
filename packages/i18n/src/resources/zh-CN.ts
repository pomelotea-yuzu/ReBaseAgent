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
    truncatedPreview: "{{text}}…（共 {{count}} 字）",
    localFieldCheck: "本地字段检查：必填项、模式与授权条件（不联网、不调用模型）",
    checksDone: "已做的检查",
    boundaryThisRun: "本次边界",
    notSelected: "未选择",
    checked: "已勾选",
    unchecked: "未勾选",
    fieldOldValue: "原值",
    fieldNewValue: "新值",
    fieldWrites: "本次副本写入",
  },
  run: {
    createSummaryChat: "一次真实模型调用 · 按实际用量计费 · 纯对话不调用工具",
    createSummaryIsolated: "隔离采集只读源目录 · 副本写入须本次勾选 · 真实调用按用量计费",
    fieldTask: "任务（User Message）",
    fieldEndpoint: "接入",
    fieldSourceDir: "源目录",
    fieldToolTable: "工具表",
    systemPromptEmpty: "留空（config_hash 按空 system 计）",
    emptyToolTable: "空（纯对话不调用工具）",
    createLimitChatNoWorkspace: "没有目录或工作区参与：这次只发一条纯对话请求。",
    createLimitChatNoPrecheck:
      "没有独立的模型连通性预检：能否真的跑通由提交时 main 校验（未配置会拒绝，不消耗模型调用）。",
    createLimitIsolatedNoPreview:
      "没有目录采集预览接口：文件数量、体积与是否被拒绝，要到提交后才可知，这里不预告。",
    createLimitIsolatedWrites:
      "隔离运行按固定工具组执行，采集到的文本会进入模型请求；副本写入只落到数据目录的不可变附件。",
  },
  detail: {},
  fork: {
    cacheHint:
      "父 run 该步使用 {{parentModel}}，当前运行配置为 {{configModel}}——前缀缓存可能不命中，计费口径可能变化（仅提示，不阻止重跑）。",
    plainSummary: "普通续跑 · 后续新发起的工具调用会真实执行 · 父 run 不会被修改",
    fieldParentRun: "父运行",
    fieldEditedCall: "被改的调用",
    fieldModelPrefix: "模型与前缀",
    modelSameAsParent: "与父 run 该步录制的模型相同（{{model}}）",
    modelUnknown: "父模型或当前配置未知：不据此推断一致性",
    plainLimitNoWorld:
      "世界不隔离：这是普通 replay 续跑——默认不复执行工具（把录下的结果喂回模型），但后续由模型新发起的工具调用会真的执行，可能有外部副作用。",
    plainLimitNoPrecheck:
      "没有独立的续跑条件预检接口（隔离路径才有）：这里的条件由提交时 main 复核。",
    plainLimitParentUnchanged: "父运行与其后的步骤不会被修改；重跑产出的是一条新 run。",
    isolatedSummary: "整轮续跑 · 本轮其余工具不重做 · 副本写入须本次勾选",
    fieldContinueCondition: "续跑条件",
    precheckMissing: "尚未取得只读预检结论（下面这几项要预检后才知道）",
    fieldDirectParent: "直接父",
    fieldLocalTurn: "本地轮号",
    fieldTurnEndCheckpoint: "整轮结束检查点",
    fieldContinueMode: "续跑方式",
    fieldRealCall: "真实调用",
    writesCheckedOneShot: "已勾选（只对这次提交有效）",
    writesUncheckedRejected: "未勾选（隔离提交会被拒绝）",
    precheckCheck: "只读预检 `runs:forkCapability`：不创建运行、不写文件、不请求模型",
    isolatedLimitNoRedo:
      "整轮续跑：这一轮的其余工具不重做（它们在子运行的前缀里各出现一次），编辑点之后的步骤由模型重新生成。",
    isolatedLimitWrites:
      "不撤销已经发生的写入：源目录与父 trace 都不会被改动，写入只落在本副本映射里；父 trace 上的历史授权标注不构成本次授权。",
    isolatedLimitRights:
      "副本写入需要本次显式勾选；重新打开编辑或换目录都要重新勾选，不从历史记录补授权。",
    promptSummary: "从头执行新轨迹 · 真实调用模型并计费 · 父 run 只作对照",
    fieldParentRunCompare: "父运行（只作对照）",
    fieldStartField: "改动的启动字段",
    promptLimitNewTrace:
      "从头执行一条新轨迹：不复用父 run 的执行前缀，不回放任何工具结果，父 run 不会被修改。",
    promptLimitOneField:
      "一次只改一个启动字段（system 或首个 user），其余上下文与后续步骤都由模型重新生成。",
    promptLimitContextRecorded:
      "启动上下文取自该次调用录制的首个 llm.call（system + 首个 user），config_hash 随改动变化。",
    promptLimitContextUnavailable:
      "启动上下文无法从首次调用重建：该入口不可用，原因已就近标在入口上。",
    messagesSummary: "只重发这一个请求 · 不执行外部工具 · 凭据用代理会话最近捕获的 key",
    fieldTargetCall: "目标 run · 调用",
    fieldMessages: "本次请求的 messages",
    messagesCount: "{{count}} 条（完整替换发送，不截断）",
    upstreamMissing: "（代理未运行，无 upstream）",
    fieldCredentials: "凭据",
    credsCaptured: "使用代理会话最近捕获的 key",
    credsMissing: "未捕获 key：本次无法重发",
    fieldModel: "模型",
    messagesCheck:
      "本地结构检查：messages 必须是非空 JSON 数组（不合法就就近报错、不发请求，不调用模型）",
    messagesLimitSingle:
      "只重发这一个请求：不执行任何外部 Agent 的工具，也不恢复它的工作区或后续步骤。",
    messagesLimitCreds:
      "凭据是代理会话最近捕获的那一个，可能与该 run 录制当时不同（也可能没有 ⇒ 会被拒）。",
    messagesLimitNoConfigHash:
      "被动录制的 run 没有自有 config_hash：它仍是可对照的轨迹，但这条路径不产生父子续跑。",
  },
  experiment: {
    localBatchCheck:
      "本地批次检查：运行配置已填、至少两臂、每臂 model 非空、参数 JSON 可解析、逐臂与父 run 不同（与父完全相同的臂会让整批被拒）",
    abSummaryNoPlan: "尚未取得当前批次的计划（{{count}} 臂）：先校验并预览",
    abSummaryPlan: "{{count}} 次真实模型调用 · 按臂数计费",
    abSummarySideEffects: "{{count}} 次真实模型调用 · 按臂数计费 · 副作用工具将真实执行",
    fieldExecutionPlan: "执行计划",
    abPlanMissing:
      "尚未取得当前批次的计划（{{count}} 臂）：先“校验并预览计划”，确认要核对的是计划里各臂实际生效的参数",
    fieldExperimentGroup: "实验组",
    abRealCalls: "{{count}} 次（每臂一次，各自落盘为独立新 run）",
    fieldArmEffective: "臂 {{index}} 实际生效",
    fieldSideEffectTools: "副作用工具",
    abSideEffectsAllowed: "已放行：含副作用的工具会真实执行",
    abSideEffectsNotAllowed: "未放行：该调用没有需要放行的副作用工具",
    abCheckDryRun: "只读校验 `runs:modelAbPlan`（dry-run）：不联网、不写文件、不占主动执行槽",
    abLimitPerArm:
      "一次执行按臂数发起真实模型调用并产生费用（当前 {{count}} 臂）；各臂顺序执行，单臂失败不影响其它臂。",
    abLimitParent: "父 run 只作对照，不会被修改；各臂各自落盘为独立新轨迹，同批共享一个实验组 ID。",
    abLimitSideEffectWarning:
      "⚠ 前一臂的外部副作用会改变后一臂的起点：比较结果不一定可信（该声明随实验留痕）。",
    abLimitPlanBinding:
      "计划与批次修订同源：改臂、改参数、改动副作用许可或修改运行配置都会作废旧计划与旧确认，须重新预览再重新确认。",
    armLineNoParams: "（沿用父 run 的采样参数）",
    armLineDiscarded: " · 丢弃父录值 {{values}}",
    armLineWarnings: " · ⚠ {{keys}} 可能未生效",
  },
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
