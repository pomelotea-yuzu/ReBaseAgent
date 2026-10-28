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
