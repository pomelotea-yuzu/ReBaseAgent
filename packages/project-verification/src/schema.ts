import { z } from "zod";

/**
 * R3 项目验证的**纯数据 schema 层**（渲染层可安全共享）。
 *
 * 本文件只含 zod 数据契约与冻结常量，禁止导入 Node 专有模块或执行器：
 * - 渲染层 / shared 只依赖 `@rebaseagent/project-verification/schema`（design D3）；
 * - 记录 I/O 与执行器在主入口（`index.ts`）后续任务落地，只读记录模块永不导入执行器
 *   （便于 MCP2 复用）。
 *
 * 所有对象一律 `.strict()`：多余键直接拒绝——「renderer 不能输入命令、物理路径、环境变量、
 * 镜像/endpoint、挂载、限额或测试正文」（design D3）在类型层就堵死（P08）。
 */

/** 验证/准备记录格式版本。读取器遇到更高版本必须显式拒绝，不得静默降级解析（P15）。 */
export const VERIFICATION_RECORD_VERSION = 1;

/** sha256 镜像/内容摘要（带 `sha256:` 前缀，内容寻址）。 */
export const ImageDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "必须是 sha256:<64 位小写十六进制>");

/** 文件级 sha256（裸 64 位小写十六进制，与阶段 1 探针读数同形）。 */
export const FileHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "必须是 64 位小写十六进制 sha256");

/** UTC ISO 8601 时间戳字符串。 */
export const Iso8601Schema = z.string().min(1);

/**
 * 后端本地 endpoint：**仅枚举的本机命名管道**（阶段 1 实测的两种形态）。
 * TCP / SSH / 远程 context 在类型层不存在表示——「拒绝远程或漂移环境」（P02）的第一道门；
 * 运行时还要显式钉死当前 context 并拒绝 `DOCKER_HOST` 覆盖（backend-verification.md §1.2）。
 */
export const LocalBackendEndpointSchema = z.enum([
  "npipe:////./pipe/dockerDesktopLinuxEngine",
  "npipe:////./pipe/docker_engine",
]);

/** 本机后端 endpoint 类型。 */
export type LocalBackendEndpoint = z.infer<typeof LocalBackendEndpointSchema>;

/**
 * 检查点选择器：必须**显式**选择「初始快照」或「某个自有完成步骤」。
 * 刻意不存在「最近完成步骤」等默认形态——桌面不得无声换点（P05 / design D1：
 * `locateWorkspaceSnapshot` 省略 stepSpanId 取初始的行为不可复用，新接口必须显式选择）。
 */
export const CheckpointSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("initial") }),
  z.strictObject({ kind: z.literal("step"), stepSpanId: z.string().min(1) }),
]);

/** 验证目标 = run + 显式检查点（snapshotId 由预检/记录层补齐，调用方不提供）。 */
export const VerificationTargetSelectorSchema = z.strictObject({
  runId: z.string().min(1),
  checkpoint: CheckpointSelectorSchema,
});

export type CheckpointSelector = z.infer<typeof CheckpointSelectorSchema>;

/**
 * 命令枚举：仅 `typecheck` / `test` 两个固定命令（design D2）。
 * renderer/project 不能提交自由命令、handler 或物理路径（P08）；
 * main 将枚举映射为 manifest 冻结的 executable/argv/cwd。
 */
export const CommandIdSchema = z.enum(["typecheck", "test"]);

/** 首版唯一 profile。新增 profile = 版本化 schema 变更，不做字符串透传。 */
export const ProfileIdSchema = z.literal("node-ts-v1");

/**
 * 资源限额（design D5 候选数字经阶段 1 实测冻结，backend-verification.md §1.4）。
 *
 * ⚠️ `tmpfsCountsTowardMemoryBudget` 用 `z.literal(true)` 钉死语义：阶段 1 实测
 * tmpfs 页计入容器内存 cgroup（180 MB tmpfs + 少量堆即在 200 MiB 限额内被 OOM 击杀），
 * 所以 `memoryBytes` 是「进程 + /work + /tmp 的合并预算」（512 MiB 下进程有效 ≈300 MiB）。
 * 该语义丢失会导致限额解读错误，禁止改为 false 或省略。
 */
export const ProfileLimitsSchema = z.strictObject({
  cpus: z.number().int().positive(),
  memoryBytes: z.number().int().positive(),
  pidsLimit: z.number().int().positive(),
  workTmpfsBytes: z.number().int().positive(),
  tmpTmpfsBytes: z.number().int().positive(),
  commandTimeoutMs: z.number().int().positive(),
  totalTimeoutMs: z.number().int().positive(),
  stdoutBudgetBytes: z.number().int().positive(),
  stderrBudgetBytes: z.number().int().positive(),
  totalOutputLimitBytes: z.number().int().positive(),
  artifactUniqueContentBudgetBytes: z.number().int().positive(),
  tmpfsCountsTowardMemoryBudget: z.literal(true),
});

/**
 * 受限容器安全口径（阶段 1 §1.2/§1.4 实测全过，带对照组）。
 * 字段用 literal 钉死：任何一项缺失/降级都使 manifest 校验失败（P09/P10 的静态面）。
 * `supervisorPid1` 来自阶段 1 发现①——裸 PID 1 忽略 SIGTERM（docker stop 全宽限后才
 * SIGKILL），干净停止必须由受控 supervisor 作 PID 1（design D5）。
 */
export const SecurityProfileSchema = z.strictObject({
  runAsUser: z.literal("1000:1000"),
  readOnlyRootfs: z.literal(true),
  capDropAll: z.literal(true),
  noNewPrivileges: z.literal(true),
  networkMode: z.literal("none"),
  supervisorPid1: z.literal(true),
});

/** 固定命令的 argv/cwd 由 manifest 冻结，main 只按 commandId 查表，不接受调用方提供。 */
export const ProfileCommandSchema = z.strictObject({
  commandId: CommandIdSchema,
  executable: z.string().min(1),
  argv: z.array(z.string()),
  cwd: z.string().min(1),
});

/** 可信测试块：测试/runner 与环境清单在同镜像内冻结，`expectedTestCount` 精确匹配（P12）。 */
export const TrustedEnvironmentSchema = z.strictObject({
  runner: z.strictObject({ path: z.string().min(1), sha256: FileHashSchema }),
  lockfile: z.strictObject({ path: z.string().min(1), sha256: FileHashSchema }),
  testFiles: z.array(z.strictObject({ path: z.string().min(1), sha256: FileHashSchema })).min(1),
  expectedTestCount: z.number().int().positive(),
  /**
   * 受控 supervisor（容器 PID 1）：TERM → 命名空间内全体转发 → 宽限 KILL → 干净退出，
   * 并循环收割孤儿（design D5.5；阶段 1 §1.4 发现①——裸 PID 1 忽略 SIGTERM）。
   */
  supervisor: z.strictObject({ path: z.string().min(1), sha256: FileHashSchema }),
  /** 工作负载定向停止脚本：按 PID 定向（排除 PID 1 与自身），绝不模式匹配（§1.5 反证）。 */
  stopWorkloads: z.strictObject({ path: z.string().min(1), sha256: FileHashSchema }),
});

/** 资源限额类型（执行层签名使用）。 */
export type ProfileLimits = z.infer<typeof ProfileLimitsSchema>;

/** node-ts-v1 profile manifest（版本化入库，design D2）。 */
export const ProfileManifestSchema = z
  .strictObject({
    profileId: ProfileIdSchema,
    manifestVersion: z.number().int().positive(),
    platform: z.literal("linux/amd64"),
    baseImage: z.strictObject({
      repository: z.string().min(1),
      digest: ImageDigestSchema,
      registryNote: z.string().min(1),
    }),
    toolchain: z.strictObject({
      node: z.string().min(1),
      npm: z.string().min(1),
      typescript: z.string().min(1),
    }),
    /** Agent 唯一可变的受支持源码面（P26：模板成功不等于任意项目已支持）。 */
    sourceIncludeGlob: z.literal("src/**/*.ts"),
    /** 物化时落位 /work 的固定模板文件（不来自 Agent 检查点）。 */
    templateFiles: z
      .array(z.strictObject({ path: z.string().min(1), sha256: FileHashSchema }))
      .min(1),
    trustedEnvironment: TrustedEnvironmentSchema,
    commands: z.array(ProfileCommandSchema),
    limits: ProfileLimitsSchema,
    security: SecurityProfileSchema,
  })
  .refine((m) => new Set(m.commands.map((c) => c.commandId)).size === m.commands.length, {
    message: "commandId 不得重复",
  })
  .refine(
    (m) => {
      const ids = new Set(m.commands.map((c) => c.commandId));
      return ids.has("typecheck") && ids.has("test");
    },
    { message: "typecheck 与 test 两个固定命令都必须提供" },
  );

/**
 * `node-ts-v1` 冻结实例——数值与阶段 1/3.x 实测一致（backend-verification.md §1.3/§3.1/§3.5）。
 *
 * `manifestVersion: 2`：v3 环境镜像加入受控 supervisor 与 stop-workloads 两个受信脚本
 * （哈希冻结于此，trustedEnvironment 形状扩展 ⇒ 版本递增）；原 runner/锁/模板/测试五项
 * 字节未变（镜像内复核一致，§3.5）。受信环境**镜像自身的 digest 属准备期实测事实**
 * （写入 prepared 事件），不冻结于此。
 * 基础镜像 digest 经 DaoCloud 源拉取；与官方源的一致性核对未完成（Hub 直连不可达，
 * 如实登记于 §1.2），registryNote 记录该事实。
 */
export const NODE_TS_V1_PROFILE: z.infer<typeof ProfileManifestSchema> = {
  profileId: "node-ts-v1",
  manifestVersion: 2,
  platform: "linux/amd64",
  baseImage: {
    repository: "docker.m.daocloud.io/library/node",
    digest: "sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914",
    registryNote:
      "阶段 1 经 DaoCloud 镜像源拉取（Docker Hub 直连不可达）；digest 内容寻址，与官方源一致性核对未完成（backend-verification.md §1.2 未闭合项）",
  },
  toolchain: { node: "22.23.4", npm: "10.9.9", typescript: "5.9.3" },
  sourceIncludeGlob: "src/**/*.ts",
  templateFiles: [
    {
      path: "package.json",
      sha256: "a5f4e90ee88b00ad3094dfaae0d03f1a8c5ddcd8e31a297b0b8371e8d77c7b0e",
    },
    {
      path: "tsconfig.json",
      sha256: "a34da16b2fb98ac0adcce7e2b60ab2bf73cdd6aa49495fd4ce37b07cfe4c91f6",
    },
  ],
  trustedEnvironment: {
    runner: {
      path: "/opt/r3/runner.mjs",
      sha256: "0edf7c21ae4ad39b275be0701aa4ff24ab866aa7eee8bc33419281bd5bc1d823",
    },
    lockfile: {
      path: "/opt/r3/package-lock.json",
      sha256: "d41f669401256ee4c85c1dfc66f2c72ccf3b6167467e7b8e0e7cb0557d4c90c4",
    },
    testFiles: [
      {
        path: "/opt/r3/tests/smoke.test.mjs",
        sha256: "aed08651ec853f882894024aff94dcfd16200b0bcdadcf5097ec6ed8b3ef1030",
      },
    ],
    expectedTestCount: 2,
    supervisor: {
      path: "/opt/r3/supervisor.sh",
      sha256: "09fe58f315cc705315242bcc5a1fde7216b7201ec1308d1f0fa1d75b96a0add8",
    },
    stopWorkloads: {
      path: "/opt/r3/stop-workloads.sh",
      sha256: "74ea5c003120c261074900abaef8a71a8f7186ec522e21d705b8a5a31e09b1ff",
    },
  },
  commands: [
    {
      commandId: "typecheck",
      executable: "/usr/local/bin/node",
      argv: ["/opt/r3/runner.mjs", "typecheck"],
      cwd: "/work",
    },
    {
      commandId: "test",
      executable: "/usr/local/bin/node",
      argv: ["/opt/r3/runner.mjs", "test"],
      cwd: "/work",
    },
  ],
  limits: {
    cpus: 1,
    memoryBytes: 536870912,
    pidsLimit: 64,
    workTmpfsBytes: 167772160,
    tmpTmpfsBytes: 33554432,
    commandTimeoutMs: 120000,
    totalTimeoutMs: 180000,
    stdoutBudgetBytes: 1048576,
    stderrBudgetBytes: 1048576,
    totalOutputLimitBytes: 16777216,
    artifactUniqueContentBudgetBytes: 134217728,
    tmpfsCountsTowardMemoryBudget: true,
  },
  security: {
    runAsUser: "1000:1000",
    readOnlyRootfs: true,
    capDropAll: true,
    noNewPrivileges: true,
    networkMode: "none",
    supervisorPid1: true,
  },
};

/** node-ts-v1 profile manifest 类型（供准备层/计划层签名使用）。 */
export type ProfileManifest = z.infer<typeof ProfileManifestSchema>;

/**
 * 环境准备计划（只读预览，P03：查看计划不得有下载/构建副作用）。
 * 下载来源/体积/许可/网络范围在此明示，正式执行需另行当前授权（P04）。
 */
export const PreparePlanSchema = z.strictObject({
  profileId: ProfileIdSchema,
  manifestVersion: z.number().int().positive(),
  manifestDigest: FileHashSchema,
  downloads: z
    .array(
      z.strictObject({
        source: z.string().min(1),
        approxBytes: z.number().int().positive(),
        license: z.string().min(1),
      }),
    )
    .min(1),
  /** 仅准备阶段允许联网；正式测试断网（design D2）。 */
  networkScopeNote: z.string().min(1),
  spaceEstimateBytes: z.number().int().positive(),
});

/** 环境准备计划类型。 */
export type PreparePlan = z.infer<typeof PreparePlanSchema>;

/**
 * 计划绑定（planToken 的输入摘要，P07：防漂移，不替代当前授权）。
 * 提交时重核：任一字段变化即 `PLAN_STALE`，要求重新核对，不复用历史授权。
 */
export const PlanBindingSchema = z.strictObject({
  target: VerificationTargetSelectorSchema,
  snapshotManifestDigest: FileHashSchema,
  attachmentsManifestDigest: FileHashSchema,
  profileId: ProfileIdSchema,
  manifestVersion: z.number().int().positive(),
  commandId: CommandIdSchema,
  preparationId: z.string().min(1),
  policyVersion: z.number().int().positive(),
});

/** 环境准备提交输入：`allowPrepare` 必须显式为 true（P04：与测试授权分开）。 */
export const VerificationPrepareInputSchema = z.strictObject({
  profileId: ProfileIdSchema,
  planToken: z.string().min(1),
  allowPrepare: z.literal(true),
});

/**
 * 验证执行提交输入：`allowExecution` 必须显式为 true（P07）。
 * 只携带 selector 与枚举命令；物理路径/环境变量/镜像/限额均无字段可传（P08）。
 */
export const VerificationRunInputSchema = z.strictObject({
  target: VerificationTargetSelectorSchema,
  profileId: ProfileIdSchema,
  commandId: CommandIdSchema,
  planToken: z.string().min(1),
  allowExecution: z.literal(true),
});

/**
 * 验证结局（design D6 九行表的规范化；⚠️ 与操作登记的 settled 是两层：
 * settled ≠ passed，requestOutcome ≠ 测试结论——D04）。
 * - `check_failed`：tsc 非零或可信断言失败（项目断言层面的失败）
 * - `passed`：检查通过且源码/报告/日志/产物完整
 * - `environment_failed` / `start_failed` / `process_failed`：基础设施故障，不算项目断言失败
 * - `timed_out` / `output_limit` / `cancelled`：必须先确认全部停止
 * - `artifact_invalid`：采集拒绝/输入被修改，无可用输出清单
 * - `evidence_incomplete`：截断/缺日志或报告（保留真实 exit，不能绿色通过）
 * - `unknown`：daemon 断开/停止未确认；当前槽不释放，只允许核对/再次停止
 */
export const VerificationOutcomeSchema = z.enum([
  "check_failed",
  "passed",
  "environment_failed",
  "start_failed",
  "process_failed",
  "timed_out",
  "output_limit",
  "cancelled",
  "artifact_invalid",
  "evidence_incomplete",
  "unknown",
]);

/** 结局类型（供记录层/展示侧共用）。 */
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

/**
 * 结构化错误码（IPC 信封错误侧；只放可展示元数据，不含正文/凭据）。
 * `BACKEND_REMOTE_REFUSED`/`BACKEND_DRIFT` 对应 P02；来源类对应 P06；
 * `PLAN_STALE`/`EXECUTION_NOT_ALLOWED` 对应 P07；记录读取类对应 P15/P16。
 */
export const VerificationErrorCodeSchema = z.enum([
  "BACKEND_MISSING",
  "BACKEND_REMOTE_REFUSED",
  "BACKEND_DRIFT",
  "SOURCE_NOT_SEALED",
  "SOURCE_INCOMPLETE",
  "CHECKPOINT_NOT_OWNED",
  "ATTACHMENT_MISSING",
  "ATTACHMENT_CORRUPT",
  "PROFILE_UNSUPPORTED",
  "COMMAND_NOT_ENUMERATED",
  "PLAN_STALE",
  "PREPARE_NOT_ALLOWED",
  "EXECUTION_NOT_ALLOWED",
  "PREPARATION_REQUIRED",
  /**
   * 受信环境构建资产（runner/锁文件/模板/测试/Dockerfile）与冻结 manifest 不一致（P08
   * 「项目更改固定 package/锁文件/配置和可信测试」在准备侧的落点）：构建前完整性门拒绝。
   */
  "TRUSTED_ENVIRONMENT_DRIFT",
  "RECORD_CORRUPT",
  "RECORD_UNSUPPORTED_VERSION",
  "RECORD_UNTERMINATED",
  "ASSET_MISSING",
]);

/**
 * 验证记录事件（JSONL 逐行）。
 *
 * 按「meta 首行 / 正文可追加 / 唯一终止」拆成三段联合：writer 分段校验与封存，
 * reader（2.3）逐行用 `VerificationEventSchema` 全量联合校验；顺序与唯一终止
 * 由读写器执行，schema 只定形状。
 */

/** meta 事件：必为首行，携带记录身份（verificationId）、来源身份与计划摘要。 */
export const VerificationMetaEventSchema = z.strictObject({
  type: z.literal("meta"),
  schemaVersion: z.literal(VERIFICATION_RECORD_VERSION),
  verificationId: z.string().min(1),
  epoch: z.string().min(1),
  operationId: z.string().min(1),
  target: z.strictObject({
    runId: z.string().min(1),
    checkpoint: CheckpointSelectorSchema,
    snapshotId: z.string().min(1),
  }),
  profileId: ProfileIdSchema,
  manifestVersion: z.number().int().positive(),
  commandId: CommandIdSchema,
  planBindingDigest: FileHashSchema,
  createdAt: Iso8601Schema,
});

/** command_start 事件（具名导出：执行层 3.4 直接构造并校验）。 */
export const CommandStartEventSchema = z.strictObject({
  type: z.literal("command_start"),
  commandId: CommandIdSchema,
  executable: z.string().min(1),
  argv: z.array(z.string()),
  cwd: z.string().min(1),
  startedAt: Iso8601Schema,
});

/**
 * command_end 事件（具名导出）。stdout/stderr 双口径：`byteLength`/`sha256` 描述
 * **已保留资产**（内容寻址发布），`totalBytes` 为**全部观测字节**（保留 + 超限丢弃的
 * 持续读取计数，P13——截断/丢弃量本身是证据，缺失会掩盖 output_limit 事实）。
 */
export const CommandEndEventSchema = z.strictObject({
  type: z.literal("command_end"),
  commandId: CommandIdSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.strictObject({
    byteLength: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    sha256: FileHashSchema,
    truncated: z.boolean(),
  }),
  stderr: z.strictObject({
    byteLength: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    sha256: FileHashSchema,
    truncated: z.boolean(),
  }),
  endedAt: Iso8601Schema,
});

export type CommandStartEvent = z.infer<typeof CommandStartEventSchema>;
export type CommandEndEvent = z.infer<typeof CommandEndEventSchema>;

/** 正文事件：meta 之后、terminated 之前可多次追加。 */
export const VerificationBodyEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stage"),
    phase: z.enum(["materializing", "executing", "stopping", "collecting", "finalizing"]),
    at: Iso8601Schema,
  }),
  CommandStartEventSchema,
  CommandEndEventSchema,
  z.strictObject({
    type: z.literal("stop_requested"),
    at: Iso8601Schema,
  }),
  z.strictObject({
    type: z.literal("stop_confirmed"),
    stoppedPidCount: z.number().int().nonnegative(),
    quiescenceMs: z.number().int().nonnegative(),
    at: Iso8601Schema,
  }),
  z.strictObject({
    type: z.literal("artifacts"),
    entries: z.array(
      z.strictObject({
        path: z.string().min(1),
        size: z.number().int().nonnegative(),
        sha256: FileHashSchema,
      }),
    ),
    excludedPatterns: z.array(z.string().min(1)),
    totalBytes: z.number().int().nonnegative(),
  }),
]);

/** 终止事件：每个记录**恰一条**，写入即封存（append-only 到此为止）。 */
export const VerificationTerminatedEventSchema = z.strictObject({
  type: z.literal("terminated"),
  outcome: VerificationOutcomeSchema,
  detail: z.string().min(1),
  evidenceComplete: z.boolean(),
  at: Iso8601Schema,
});

/** 全量事件联合（读取侧逐行校验用）。 */
export const VerificationEventSchema = z.union([
  VerificationMetaEventSchema,
  VerificationBodyEventSchema,
  VerificationTerminatedEventSchema,
]);

/**
 * 准备记录事件（`verification-environments/<preparationId>.jsonl`，与验证记录分开）。
 * 同样按 meta / 正文 / 唯一终止拆分。
 */
export const PreparationMetaEventSchema = z.strictObject({
  type: z.literal("meta"),
  schemaVersion: z.literal(VERIFICATION_RECORD_VERSION),
  preparationId: z.string().min(1),
  epoch: z.string().min(1),
  operationId: z.string().min(1),
  profileId: ProfileIdSchema,
  manifestVersion: z.number().int().positive(),
  planDigest: FileHashSchema,
  createdAt: Iso8601Schema,
});

export const PreparationBodyEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("prepared"),
    imageDigest: ImageDigestSchema,
    toolchain: z.strictObject({ node: z.string().min(1), typescript: z.string().min(1) }),
    networkUsed: z.boolean(),
    /**
     * `null` = 后端无法给出可测字节（如实未知），禁止伪造成 0——「没有下载」与
     * 「测不到下载量」是两个事实（P04 记录真实网络结果的口径）。
     */
    downloadedBytes: z.number().int().nonnegative().nullable(),
    at: Iso8601Schema,
  }),
  z.strictObject({
    type: z.literal("failed"),
    reason: z.string().min(1),
    at: Iso8601Schema,
  }),
]);

export const PreparationTerminatedEventSchema = z.strictObject({
  type: z.literal("terminated"),
  outcome: z.enum(["prepared", "failed"]),
  at: Iso8601Schema,
});

export const PreparationEventSchema = z.union([
  PreparationMetaEventSchema,
  PreparationBodyEventSchema,
  PreparationTerminatedEventSchema,
]);

/**
 * 恢复日志条目（`verification-runtime/<resourceOwnerId>.json`）。
 * **不是结果事实源、不是持久操作 registry**（design D4）：仅存资源名、安装实例归属、
 * owner 标签、已知容器 ID 与阶段——不存授权/正文/凭据。「创建资源之前」先落本登记，
 * create 后回填容器 ID，覆盖响应丢失窗口（P22）；归属不明不得停止陌生资源（P23）。
 */
export const ResourceRegistrationSchema = z.strictObject({
  resourceOwnerId: z.string().min(1),
  kind: z.enum(["prepare", "verification"]),
  ownerLabel: z.literal("rebaseagent-r3"),
  knownContainerIds: z.array(z.string().min(1)),
  phase: z.enum(["registered", "created", "collecting", "removed"]),
  preparationId: z.string().min(1).nullable(),
  verificationId: z.string().min(1).nullable(),
  updatedAt: Iso8601Schema,
});
