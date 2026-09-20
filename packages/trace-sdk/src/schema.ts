import { z } from "zod";
import { findSnapshotFilesViolation, findWorkspaceOriginViolation } from "./workspace-snapshot.js";

/**
 * 读取器**最高支持**的 trace 格式版本。
 * 读取器遇到更高版本必须显式报"不支持的格式版本"，不得静默降级解析。
 *
 * v2 新增隔离文件世界（`run.meta.workspace` / `agent.step.workspace_snapshot` /
 * `fork.resume_after_step`）；v1 是普通运行格式。见 `version-guard.ts`。
 */
export const FORMAT_VERSION = 2;

/**
 * **普通**运行写入的版本号（不含隔离字段的运行：runLoop 直录、代理录制、卡带）。
 *
 * ⚠️ 与 `FORMAT_VERSION` 分开是刻意的：把最高支持版本当作写入版本，会让所有普通
 * writer 一起跳到 v2——v2 的契约是"必须有 workspace"，普通运行并不满足。
 * 隔离执行由 workspace Tracer 包装器另行覆盖 meta 的版本与 workspace 字段。
 */
export const PLAIN_FORMAT_VERSION = 1;

/** 支持的格式版本（当前 v1 / v2 双读） */
export const FormatVersionSchema = z.union([
  z.literal(PLAIN_FORMAT_VERSION),
  z.literal(FORMAT_VERSION),
]);

// ---------------------------------------------------------------------------
// 通用子结构
// ---------------------------------------------------------------------------

/**
 * 聊天消息。除 role 外的字段原样保留——
 * trace 是"原样录制"，llm.call 的 request.messages 必须可直接作为 loop 输入（查表，无需重建）。
 */
export const ChatMessageSchema = z.object({ role: z.string() }).passthrough();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** LLM 采样参数（temperature 等），原样保留 */
export const LlmParamsSchema = z.record(z.string(), z.unknown());
export type LlmParams = z.infer<typeof LlmParamsSchema>;

/** token 用量 */
export const LlmUsageSchema = z.object({
  in: z.number().int().nonnegative(),
  out: z.number().int().nonnegative(),
  /**
   * provider 侧前缀缓存命中/未命中的 tokens（可选，非负整数）。
   *
   * - **有值**的判据是存在性（`!== undefined`）：`0` = 实测零命中（全量计费），是有值；
   * - **字段缺失** = provider 未返回、命中情况未知（老文件同此）——两者语义不同，不得互相冒充；
   * - 是 `in` 的组成部分（不额外叠加），不参与 token 合计派生。
   */
  cache_hit: z.number().int().nonnegative().optional(),
  cache_miss: z.number().int().nonnegative().optional(),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

/**
 * LLM 调用失败的诊断详情（可选，挂在 `llm.call` span 顶层）。
 *
 * - **缺省语义**：成功调用省略该字段；老文件缺省合法。**字段缺失只表示"未记录错误详情"，
 *   不能反推调用成功**——也不得由空正文 / 零 token 猜造失败原因。
 * - **与 `tool.invoke.error` 同名异构（务必按 kind 缩窄类型再判定）**：
 *   工具是 `string | null`（`null` 才正常），本字段是 `object | undefined`（`undefined` 才正常）。
 *   因此本字段**不接受 `null`**（`null` 的缺省态是 `undefined`）。
 * - `message` 恒为非空诊断文本（写入侧已脱敏并按统一上限截断，见 agent-loop 的
 *   `sanitizeDiagnosticText`）；`status` **只在实际取得 HTTP 错误状态码时**写入，
 *   不从消息文本猜测。此处不做长度硬校验：超长的历史数据仍应可读，不把"字数超标"
 *   变成读取失败。
 */
export const LlmCallErrorSchema = z.object({
  /** 脱敏并限长后的非空诊断文本 */
  message: z.string().min(1),
  /** HTTP 错误状态码；无状态码的失败（网络异常 / 流中断）省略该字段 */
  status: z.number().int().positive().optional(),
});
export type LlmCallError = z.infer<typeof LlmCallErrorSchema>;

// ---------------------------------------------------------------------------
// 隔离文件世界（v2）
// ---------------------------------------------------------------------------

/** 快照内的一个文件条目：逻辑路径 → 不可变内容（内容寻址 blob） */
export const WorkspaceFileSchema = z.object({
  /** 世界内逻辑路径（相对、`/` 分隔；完整规则见 `logical-path.ts`） */
  path: z.string().min(1),
  /** 内容哈希（64 位小写十六进制） */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** 字节数（读取端与 blob 实际大小核对） */
  bytes: z.number().int().nonnegative(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

/**
 * 一份完整文件清单（某个时点的世界状态）。
 *
 * `id` = 对规范化清单 UTF-8 字节取 SHA-256（排序与序列化规则见 `workspace-hash.ts`：
 * 路径用 `/`、按 UTF-16 代码单元序排序、序列化固定为 `[[path, sha256, bytes], …]`，
 * 不依赖 locale / mtime / 原目录路径 / OS 枚举顺序）。空清单同样有确定哈希。
 *
 * 本 schema 保证清单**形状**自洽，且这些都是**解析期**可判的（renderer 同样能判）：
 * 按规范序排列、无重复路径、无 NFC/大小写碰撞、无"文件同时是目录祖先"的冲突、
 * 每条路径满足完整逻辑路径契约（相对、`/` 分隔、长度 ≤ 512、深度 ≤ 32、无 ADS/保留设备名/
 * 尾随点空格——规则见 `logical-path.ts`）。
 * `id` 是否真的等于该清单的哈希**不在这里**——算哈希要 Node 的 `node:crypto`，
 * 由 `workspace-hash.ts` 的 `findSnapshotIdViolation` 在执行前重算。
 */
export const WorkspaceSnapshotSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/),
    files: z.array(WorkspaceFileSchema),
  })
  .superRefine((snapshot, ctx) => {
    const violation = findSnapshotFilesViolation(snapshot.files);
    if (violation !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: violation, path: ["files"] });
    }
  });
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

/** 世界来源：根运行来自导入，分支来自直接父 run 的某个检查点 */
export const WorkspaceOriginSchema = z.union([
  z.object({ kind: z.literal("import") }),
  z.object({
    kind: z.literal("checkpoint"),
    run_id: z.string().min(1),
    step_span: z.string().min(1),
  }),
]);
export type WorkspaceOrigin = z.infer<typeof WorkspaceOriginSchema>;

/**
 * 隔离运行的 workspace 元数据（`run.meta.workspace`，**仅 v2**）。
 *
 * ⚠️ `write_authorized: true` 是**审计标注**，不是权限判据：它只表示创建方声称该次运行
 * 经"允许副本内写入"确认，既不证明历史文件未被篡改，也不是可转移的凭证。真正的授权是
 * **当前请求**携带的 `allowFileWrites`——不得把它当门禁写成恒真校验，也不得从父 meta
 * 推导或默认勾选本次授权（详见 change `add-sandboxed-rerun` design §4）。
 */
export const WorkspaceMetaSchema = z.object({
  profile: z.literal("file-tools-v1"),
  /** 世界 id = 创建该世界的 run id */
  world_id: z.string().min(1),
  /** 仅审计（见上方说明） */
  write_authorized: z.literal(true),
  initial_snapshot: WorkspaceSnapshotSchema,
  origin: WorkspaceOriginSchema,
});
export type WorkspaceMeta = z.infer<typeof WorkspaceMetaSchema>;

// ---------------------------------------------------------------------------
// run.meta 首行
// ---------------------------------------------------------------------------

/**
 * 分支描述：从父 run 的哪个 span 之后分叉、编辑了什么。
 *
 * `resume_after_step`（v2 可选）区分**编辑位置**与**整轮续跑边界**：
 * `at_span` 仍指向被编辑的工具调用，`resume_after_step` 指向该工具所属 step
 * ——恢复点是"该轮全部工具完成后"，因此同轮兄弟工具的结果必须保留在前缀里、
 * 不得重放（v1 按 `at_span` 单 span 截断的语义不变）。
 */
export const ForkSchema = z.object({
  /** 分叉点：父 run 轨迹中的 span id（该 span 保留在前缀中，编辑语义由 replay 层应用） */
  at_span: z.string().min(1),
  /** 整轮续跑边界（仅 v2 隔离分叉）：被编辑工具所属的 agent.step span id */
  resume_after_step: z.string().min(1).optional(),
  /** 编辑描述：被修改字段与新值 */
  edit: z.object({
    field: z.string().min(1),
    value: z.unknown(),
  }),
});
export type Fork = z.infer<typeof ForkSchema>;

/**
 * 录制来源（可选）：标记录制通道。
 * 当前仅 "proxy"（本地 LLM 录制代理）；SDK / agent-loop 直录省略该字段。
 * base_url 是代理自身监听地址（即用户在自己应用里填的那个 base_url），
 * 不是 upstream 转发目标——upstream 属代理配置，不进 trace。
 */
export const SourceSchema = z.object({
  kind: z.literal("proxy"),
  base_url: z.string().min(1),
});
export type Source = z.infer<typeof SourceSchema>;

/**
 * `run.meta` 的字段形状。单独命名是为了在其上叠加跨字段校验：本行的 `workspace.origin`
 * 必须与 `parent` / `fork` 自洽，那需要看到整个对象（见下方 `RunMetaSchema`）。
 */
const RunMetaObjectSchema = z.object({
  type: z.literal("run.meta"),
  /** run id，同时是文件内唯一标识 */
  id: z.string().min(1),
  format_version: FormatVersionSchema,
  task: z.string(),
  model: z.string(),
  /** ISO 8601 时间戳 */
  created_at: z.string().min(1),
  /** 父 run id；根 run 为 null */
  parent: z.string().nullable(),
  /** 分支信息；根 run 为 null */
  fork: ForkSchema.nullable(),
  /** 预算上限（可选）：源配置声明的累计 token 预算，run 自包含该事实源 */
  budget: z
    .object({
      /** 累计 token 上限（所有 llm.call 的 in+out 之和），与 loop 侧 deriveTotalTokens 口径一致 */
      max_total_tokens: z.number().int().positive(),
    })
    .optional(),
  /** 源配置指纹（system prompt + 工具表），反事实重放前比对两次运行是否同源。
   *  可选：代理录制的 run 无源配置可哈希，诚实缺省——无该字段的 run
   *  不可作 replay 分叉父本（校验层拒绝），但可作代理分叉（proxy:fork）父本。 */
  config_hash: z.string().min(1).optional(),
  /** config_hash 缺省时的结构化缺因（与 config_hash 互斥）：代理录制的 run 在无法
   *  派生指纹时写入，供 fork 门禁与桌面端给出可诊断的拒绝文案。
   *  - no_system：首次请求无字符串形式的 system 消息
   *  - invalid_tool：工具表存在无法解包的项
   *  历史文件无该字段，读取不受影响。 */
  config_hash_reason: z.enum(["no_system", "invalid_tool"]).optional(),
  /** 录制来源（可选）：由代理录制时写入；SDK / agent-loop 直录省略 */
  source: SourceSchema.optional(),
  /**
   * 隔离文件世界元数据（**仅 v2 隔离运行**）。
   * 版本与字段的一致性（v2 必须有、v1 必须没有）由 `version-guard.ts` 在 schema
   * parse 前判定——zod object 默认**剥离**未知键，靠 schema 本身无法拒绝 v1 私带该字段。
   */
  workspace: WorkspaceMetaSchema.optional(),
});

/**
 * `run.meta` 行（字段形状 + 跨字段校验）。
 *
 * 校验的是**隔离元数据与运行关系的自洽**（规则详见 `findWorkspaceOriginViolation`）：
 * `world_id` 等于本 run id；根 run 的 origin 为 `import`；分支的 origin 为 `checkpoint`
 * 且指向**直接**父 run；给了 `fork.resume_after_step` 时必须与 `origin.step_span` 同指一个 step。
 *
 * `workspace` 缺省（普通 v1 / 代理录制 / 卡带）时整段跳过，不给既有数据引入新约束。
 * 这里只判**这一行内部**的自洽；跨行约束（step 快照与版本、v2 完整 step 必须有检查点）
 * 由 reader 负责。
 */
export const RunMetaSchema = RunMetaObjectSchema.superRefine((meta, ctx) => {
  // v2 隔离分支必须携带整轮续跑边界（v1 保持"截至 at_span"的旧规则，不带该字段）。
  // 缺了它，resolveBranch 就只能猜边界——而静默套用 v1 截断会漏掉同轮排在编辑点之后的兄弟工具。
  if (
    meta.format_version === FORMAT_VERSION &&
    meta.fork !== null &&
    meta.fork.resume_after_step === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "v2 隔离分支必须携带 fork.resume_after_step（该轮整轮续跑边界）",
      path: ["fork", "resume_after_step"],
    });
  }

  if (meta.workspace === undefined) {
    return;
  }
  const violation = findWorkspaceOriginViolation({
    id: meta.id,
    parent: meta.parent,
    resumeAfterStep: meta.fork?.resume_after_step,
    workspace: meta.workspace,
  });
  if (violation !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: violation, path: ["workspace"] });
  }
});

export type RunMetaLine = z.infer<typeof RunMetaSchema>;
/** startRun 的入参（不含 type 判别字段） */
export type RunMetaInput = Omit<RunMetaLine, "type">;

// ---------------------------------------------------------------------------
// span（三种 kind）
// ---------------------------------------------------------------------------

/**
 * span 的墙上时钟区间（ISO 8601 字符串，毫秒精度）。
 *
 * 成对出现——用嵌套对象而非两个平铺可选字段，避免出现"有起点没终点"的中间态。
 * 可选：老文件与手工构造的 trace 合法缺失，读取器不得报错或以其他字段推断耗时。
 * 与 `tool.invoke.dur_ms` 不冲突：dur_ms 是"工具执行耗时"的权威值，
 * timing 提供跨 span 的统一时间坐标（时间轴、step 聚合）。
 */
export const SpanTimingSchema = z.object({
  /** 起始时刻，ISO 8601（如 2026-09-03T08:55:00.123Z） */
  started_at: z.string().min(1),
  /** 终止时刻，ISO 8601；恒不早于 started_at */
  ended_at: z.string().min(1),
});
export type SpanTiming = z.infer<typeof SpanTimingSchema>;

const SpanCommon = {
  type: z.literal("span"),
  id: z.string().min(1),
  /** 父 span id；根 span 为 null */
  parent: z.string().nullable(),
  /** 起止时刻；缺省表示时间未知（老文件合法） */
  timing: SpanTimingSchema.optional(),
} as const;

/** agent.step：一轮 loop 迭代 */
export const AgentStepSpanSchema = z.object({
  ...SpanCommon,
  kind: z.literal("agent.step"),
  /** 迭代序号，从 1 起 */
  n: z.number().int().positive(),
  /**
   * 该轮**全部工具完成后**的完整文件清单（**仅 v2 隔离运行**，由 workspace Tracer
   * 在 endSpan(step) 时注入）。它是"从这一轮结束后继续"的恢复点：隔离分叉读它，
   * 而不是重放这一轮的工具。版本一致性由 `version-guard.ts` 在 parse 前判定。
   */
  workspace_snapshot: WorkspaceSnapshotSchema.optional(),
});
export type AgentStepSpan = z.infer<typeof AgentStepSpanSchema>;

/** llm.call：一次 LLM 调用（request 原样录制完整请求） */
export const LlmCallSpanSchema = z.object({
  ...SpanCommon,
  kind: z.literal("llm.call"),
  request: z.object({
    model: z.string().min(1),
    messages: z.array(ChatMessageSchema),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    params: LlmParamsSchema.optional(),
  }),
  response: z.object({
    content: z.string().nullable(),
    /** 推理模型思维链；非推理模型为 null。UI 侧区别于正文展示 */
    reasoning_content: z.string().nullable(),
    tool_calls: z.array(z.record(z.string(), z.unknown())).default([]),
    usage: LlmUsageSchema,
    /** time to first token，毫秒 */
    ttft_ms: z.number().nonnegative(),
  }),
  /**
   * 调用失败的诊断详情（可选）。成功调用省略；**缺省 ≠ 成功**（无法从这里反推）。
   * 与 `tool.invoke.error` 同名异构：先按 kind 判分支再用各自判据
   * （工具 `error !== null`、本次 `error !== undefined`）。
   */
  error: LlmCallErrorSchema.optional(),
});
export type LlmCallSpan = z.infer<typeof LlmCallSpanSchema>;
export type LlmRequest = LlmCallSpan["request"];
export type LlmResponse = LlmCallSpan["response"];

/** tool.invoke：一次工具执行（错误是数据不是异常） */
export const ToolInvokeSpanSchema = z.object({
  ...SpanCommon,
  kind: z.literal("tool.invoke"),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown(),
  dur_ms: z.number().nonnegative(),
  /** 工具失败记录于此（非 null），loop 决定继续或停止；trace 本身不因工具错误中断 */
  error: z.string().nullable(),
});
export type ToolInvokeSpan = z.infer<typeof ToolInvokeSpanSchema>;

export const SpanSchema = z.discriminatedUnion("kind", [
  AgentStepSpanSchema,
  LlmCallSpanSchema,
  ToolInvokeSpanSchema,
]);
export type SpanLine = z.infer<typeof SpanSchema>;
export type SpanKind = SpanLine["kind"];

// ---------------------------------------------------------------------------
// run.event 终止事件
// ---------------------------------------------------------------------------

export const RunEventSchema = z.object({
  type: z.literal("run.event"),
  event: z.enum(["stopped", "aborted", "errored"]),
  reason: z.enum(["completed", "max_iterations", "budget_exceeded", "aborted", "error"]),
  /** 停止时所在迭代号 */
  at: z.number().int().nonnegative().optional(),
});
export type RunEventLine = z.infer<typeof RunEventSchema>;
/** endRun 的入参（不含 type 判别字段） */
export type RunEventInput = Omit<RunEventLine, "type">;

// ---------------------------------------------------------------------------
// 行联合：trace 文件的每一行
// ---------------------------------------------------------------------------

/**
 * 行联合：trace 文件的每一行。
 * 不能用 discriminatedUnion：三种 span 的 type 同为 "span"（判别值重复），
 * 且 SpanSchema 自身也是 discriminatedUnion。用普通 union，缺失 type 等场景
 * 由读取器的显式检查兜底（"type 为必填"）。
 */
export const TraceLineSchema = z.union([RunMetaSchema, SpanSchema, RunEventSchema]);
export type TraceLine = z.infer<typeof TraceLineSchema>;

/**
 * 版本与隔离字段一致性检查的**再导出**（实现在 `version-guard.ts`，零 Node 依赖）。
 *
 * 为什么要放进本纯子路径：该检查必须在**未经 zod 转换的原始输入**上执行
 * （zod object 默认剥离未知键，"v1 私带 workspace"会被静默丢弃），而 IPC 消费端
 * （桌面 renderer/preload）只能依赖不含 Node 内建模块的 `./schema` 子路径——
 * 主出口会连同 reader/tracer 把 `node:fs` 拉进浏览器 bundle。version-guard 自身的
 * 文档已把"RunRecord/RunDetail IPC schema 的原始记录入口"列为第三处共用点。
 */
export { findVersionFieldViolation } from "./version-guard.js";
