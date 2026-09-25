/**
 * IPC 通道名。单独成文件、零依赖——preload 在 sandbox 下运行，
 * 不能因为取个常量就把 zod 拖进沙箱。
 */
export const CHANNELS = {
  listRuns: "runs:list",
  getRun: "runs:get",
  forkRun: "runs:fork",
  promptFork: "runs:promptFork",
  modelAb: "runs:modelAb",
  createRun: "runs:create",
  // workspaces:* —— 隔离文件运行的辅助通道（只读，不产生 run 文件）：
  // chooseSource 只弹原生目录选择并签发会话 token；forkCapability 只做只读能力预检
  chooseSource: "workspaces:chooseSource",
  forkCapability: "workspaces:forkCapability",
  // 文件检查点视图（C 1.1）：两条只读通道，只读已校验清单引用的附件字节，
  // 不写 trace/blob、不调 LLM/工具、不接受任意物理路径
  inspect: "workspaces:inspect",
  readFile: "workspaces:readFile",
  settingsGet: "settings:get",
  settingsSave: "settings:save",
  settingsClear: "settings:clear",
  proxyStatus: "proxy:status",
  proxyToggle: "proxy:toggle",
  proxyFork: "proxy:fork",
  // draft-close:* —— U3 关闭协商（design D6）：main 持有关闭决策，renderer 只报告元数据。
  // 所有消息只传 sessionId/sequence/dirtyCount/requestId/inputSettled，
  // 不传草稿正文、run 内容、sourceToken、授权或凭据
  draftCloseHandshake: "draft-close:handshake",
  draftCloseSession: "draft-close:session",
  draftCloseQuery: "draft-close:query",
  draftCloseReport: "draft-close:report",
  draftCloseAnswer: "draft-close:answer",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
