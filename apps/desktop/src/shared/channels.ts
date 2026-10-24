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
  // workspaces:export（R2.1）：导出选定检查点到用户经原生对话框选定的空目录。
  // 请求只带 runId/可选 stepSpanId——目标物理路径只能来自 main 的原生对话框；
  // 不登记 operation、不占主动执行槽、不消费授权；成功/失败/取消都以 ok 信封的
  // 判别式 outcome 返回，信封失败只留给请求形状非法等程序性错误
  exportCheckpoint: "workspaces:export",
  // workspaces:isolatedPromptCapability（R2.2）：隔离 prompt 实验的只读能力预检。
  // 不写 trace/blob、不建运行、不登记 operation、不占槽、不调模型；返回基线/编辑/
  // 初始清单规模/有效模型与参数/端点/限制/计划指纹/配置修订。领域拒绝以 ok 信封的
  // status=unavailable 返回（含可导航 rootId），信封失败只留给请求形状/配置读取问题。
  isolatedPromptCapability: "workspaces:isolatedPromptCapability",
  // workspaces:compareSnapshots / compareFile（R2.2）：两个逐侧 selector 的只读比较。
  // 清单通道只读记录与清单引用；正文通道按 path 延迟核验字节，expectedSnapshotIds
  // 防止旧清单与新正文拼接。两者都不登记 operation、不占槽、不消费授权、不写文件。
  compareSnapshots: "workspaces:compareSnapshots",
  compareFile: "workspaces:compareFile",
  settingsGet: "settings:get",
  settingsSave: "settings:save",
  settingsClear: "settings:clear",
  proxyStatus: "proxy:status",
  proxyToggle: "proxy:toggle",
  proxyFork: "proxy:fork",
  // proxy:changed —— 被动代理事实变化的**单向只读通知**（design D1）。
  // 只携带 main 会话 epoch、单调 revision 与受控变化类别（records/status），
  // 不含 key、headers、messages 或错误体；不创建 operation、不占主动执行槽。
  // 载荷严格校验在 main 侧，preload 原样透传（sandbox 下不引入 zod）。
  proxyChanged: "proxy:changed",
  // operations:* —— U4 操作登记（design D4）：两条通道都**只读或不执行业务**，
  // status 无参返回自洽快照，reconcile 只按身份返回事实或建立内存封禁（notAccepted），
  // 都不调用模型/工具、不写 trace/blob/source、不消费授权
  operationsStatus: "operations:status",
  operationsReconcile: "operations:reconcile",
  // verification:* —— R3 单环境真实项目验证（design D3）：两条**主动执行**通道，
  // 全部走执行 envelope（sender/epoch/一次 parse/判重/占槽与七主动入口同一套）。
  // prepare 登记 verificationPrepare 目标并关联真实 preparationId；
  // run 登记 verification 目标并关联真实 verificationId（runIds 恒空——M01）。
  verificationPrepare: "verification:prepare",
  verificationRun: "verification:run",
  // verification 只读面（4.3）：capability（计划预览+不可用原因，D01）、preparePlan
  // （固定计划预览，P03 零下载零容器零模型）、list/get/readLog（有界只读，P15/P16/D09）。
  // 全部不登记 operation、不占槽、不执行/清理；引擎健康仅枚举只读 docker 子命令（D3）。
  verificationCapability: "verification:capability",
  verificationPreparePlan: "verification:preparePlan",
  verificationList: "verification:list",
  verificationGet: "verification:get",
  verificationReadLog: "verification:readLog",
  // verification:stop（4.4）——**唯一**的新增停止通道：按 epoch/operationId 与可信
  // 领域 ID 绑定的 R3 定向停止，不接任意 PID/container，不占第二槽（design D3/D5/D6）。
  // 旧模型/代理执行保持原无取消契约（surface 测试显式放行此一条、仍禁其余）。
  verificationStop: "verification:stop",
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
