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
  settingsGet: "settings:get",
  settingsSave: "settings:save",
  settingsClear: "settings:clear",
  proxyStatus: "proxy:status",
  proxyToggle: "proxy:toggle",
  proxyFork: "proxy:fork",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
