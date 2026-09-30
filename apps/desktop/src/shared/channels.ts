/**
 * IPC 通道名。单独成文件、零依赖——preload 在 sandbox 下运行，
 * 不能因为取个常量就把 zod 拖进沙箱。
 */
export const CHANNELS = {
  listRuns: "runs:list",
  getRun: "runs:get",
  // runs:compare —— U7 只读比较通道（design D3）：一次请求带 1–4 个互异 run id，
  // main 单次读取上下文内逐项回 ready(detail)/unavailable(code, reason)；
  // 无执行身份、不占主动槽、不消耗授权、不写 trace/blob/source
  compareRuns: "runs:compare",
  forkRun: "runs:fork",
  promptFork: "runs:promptFork",
  modelAb: "runs:modelAb",
  createRun: "runs:create",
  // A/B 的真实执行（runs:modelAb）是主动写通道，必须带执行身份；
  // 计划预览（dry-run）不建运行、不消耗授权，走这条**只读**通道，
  // 因此不进入执行 envelope（design D1：dry-run 保持独立只读分支）
  modelAbPlan: "runs:modelAbPlan",
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
  // operations:* —— U4 操作登记（design D4）：两条通道都**只读或不执行业务**，
  // status 无参返回自洽快照，reconcile 只按身份返回事实或建立内存封禁（notAccepted），
  // 都不调用模型/工具、不写 trace/blob/source、不消费授权
  operationsStatus: "operations:status",
  operationsReconcile: "operations:reconcile",
  // draft-close:* —— U3 关闭协商（design D6）：main 持有关闭决策，renderer 只报告元数据。
  // 所有消息只传 sessionId/sequence/dirtyCount/requestId/inputSettled，
  // 不传草稿正文、run 内容、sourceToken、授权或凭据
  draftCloseHandshake: "draft-close:handshake",
  draftCloseSession: "draft-close:session",
  draftCloseQuery: "draft-close:query",
  draftCloseReport: "draft-close:report",
  draftCloseAnswer: "draft-close:answer",
  draftCloseRelease: "draft-close:release",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
