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
