/**
 * 中文资源是键契约的源：新增键先加在这里，英文资源按同一键补齐。
 * 0.x 只建立通用键；各工作区键按批次加入，不得用中文原句作键名。
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
  errors: {},
  mcp: {},
  cli: {},
} as const;

export type Namespace = keyof typeof zhCN;

type KeysOf<N extends Namespace> = Extract<keyof (typeof zhCN)[N], string>;

export type MessageKey = {
  [N in Namespace]: `${N}.${KeysOf<N>}`;
}[Namespace];

export type ResourceShape = {
  [N in Namespace]: Record<KeysOf<N>, string>;
};

export const NAMESPACES = Object.keys(zhCN) as Namespace[];
