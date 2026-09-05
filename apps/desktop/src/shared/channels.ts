/**
 * IPC 通道名。单独成文件、零依赖——preload 在 sandbox 下运行，
 * 不能因为取个常量就把 zod 拖进沙箱。
 */
export const CHANNELS = {
  listRuns: "runs:list",
  getRun: "runs:get",
  forkRun: "runs:fork",
  settingsGet: "settings:get",
  settingsSave: "settings:save",
  settingsClear: "settings:clear",
  proxyStatus: "proxy:status",
  proxyToggle: "proxy:toggle",
  proxyFork: "proxy:fork",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
