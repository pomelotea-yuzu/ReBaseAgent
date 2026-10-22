import { z } from "zod";
import { toJsonSchemaDeclaration } from "./input-schema.js";
import {
  BODY_CHARS_MAX,
  CURSOR_MAX,
  LOGICAL_PATH_MAX,
  PAGE_LIMIT_MAX,
  RUN_ID_MAX,
  SPAN_ID_MAX,
} from "./limits.js";
import type { ToolAnnotations } from "./server.js";

/**
 * 七个只读诊断工具的入参契约（design D5）。
 *
 * 每条契约只声明**参数形状**，不含任何执行/写入旁路：
 * - 参数里没有数据根、宿主路径、URL、handler、命令、模型或配置覆盖——数据根只在
 *   启动时确定，运行期不接受任何"换个地方读"的输入（S04）；
 * - `.strict()` ⇒ 未知字段一律拒（多一个键就是拒，不是忽略）；
 * - 标识与正文范围都有界（`limits.ts`），长度上限只是防撑破，不等于可以当正文通道；
 * - `compare_*` 用左右两个对象而不是数组：左右恒定时"这一侧不可读"才有确定含义（D5）。
 *
 * 只发布这七个工具：不提供 prompts / resources / templates，也不提供"重跑/写入/导出"
 * 一类入口（D7）。annotations 只是给客户端的说明，**只读由代码与测试保证**。
 */

/**
 * 每个字段都用**独立实例**，不复用同一个 zod schema 对象：
 * `zod-to-json-schema` 会把重复实例压成 `$ref: "#/properties/runId"`，
 * 那既让发布的声明要多做一步解引用，也让"上限是否真发出去了"难以直读。
 */
const runIdField = (): z.ZodString => z.string().min(1).max(RUN_ID_MAX);
const spanIdField = (): z.ZodString => z.string().min(1).max(SPAN_ID_MAX);
const cursorField = (): z.ZodString => z.string().min(1).max(CURSOR_MAX);
const logicalPathField = (): z.ZodString => z.string().min(1).max(LOGICAL_PATH_MAX);
const pageLimitField = (): z.ZodNumber => z.number().int().min(1).max(PAGE_LIMIT_MAX);
const maxCharsField = (): z.ZodNumber => z.number().int().min(1).max(BODY_CHARS_MAX);
/** 搜索词上限：只做完整 task/ID 匹配，不需要无界长度 */
const queryField = (): z.ZodString => z.string().min(1).max(512);

/** 结局类别筛选（按记录分类，不等价任务成败；D5） */
export const RUN_STATUS_FILTERS = [
  "all",
  "errored",
  "ended_without_error",
  "limited",
  "aborted",
  "termination_not_recorded",
] as const;

export const STEP_SECTIONS = ["input", "output", "error"] as const;

export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** 一个工具契约：zod 入参是唯一的真相，发布形状由它派生 */
export interface ToolContract {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ToolAnnotations;
}

function contract(
  name: string,
  description: string,
  schema: z.ZodObject<z.ZodRawShape>,
): ToolContract {
  return {
    name,
    description,
    schema,
    inputSchema: toJsonSchemaDeclaration(schema),
    annotations: READ_ONLY_ANNOTATIONS,
  };
}

const ListRunsArgs = z
  .object({
    status: z.enum(RUN_STATUS_FILTERS).optional(),
    query: queryField().optional(),
    cursor: cursorField().optional(),
    limit: pageLimitField().optional(),
  })
  .strict();
/** 实现层的入参类型：只从上面这份 zod 派生，不另写一份参数形状 */
export type ListRunsArgs = z.infer<typeof ListRunsArgs>;

const GetRunArgs = z
  .object({
    runId: runIdField(),
    cursor: cursorField().optional(),
    limit: pageLimitField().optional(),
  })
  .strict();
export type GetRunArgs = z.infer<typeof GetRunArgs>;

const GetStepArgs = z
  .object({
    runId: runIdField(),
    spanId: spanIdField(),
    /** 投影内 span 标识重名时的归属 run；显式给出仍须在当前投影可见 */
    ownerRunId: runIdField().optional(),
    section: z.enum(STEP_SECTIONS).optional(),
    cursor: cursorField().optional(),
    maxChars: maxCharsField().optional(),
  })
  .strict();
export type GetStepArgs = z.infer<typeof GetStepArgs>;

/**
 * 左右两个对象而不是数组：左右恒定时"这一侧不可读"才有确定含义（D5）。
 * "必须是两个不同 run"属语义约束，由实现层在任何读取之前以 `INVALID_ARGUMENT`
 * 拒绝——写在 zod refine 里会让发布的形状变成 `$ref` 套一层，客户端反而读不懂。
 */
const CompareRunsArgs = z
  .object({
    left: z.object({ runId: runIdField() }).strict(),
    right: z.object({ runId: runIdField() }).strict(),
  })
  .strict();
export type CompareRunsArgs = z.infer<typeof CompareRunsArgs>;

const InspectCheckpointArgs = z
  .object({
    runId: runIdField(),
    /** 省略 = 本 run 初始快照；不给"最近一步"缺省语义（D5） */
    stepSpanId: spanIdField().optional(),
    cursor: cursorField().optional(),
    limit: pageLimitField().optional(),
  })
  .strict();

const ReadCheckpointFileArgs = z
  .object({
    runId: runIdField(),
    stepSpanId: spanIdField().optional(),
    /** 只有清单内的逻辑路径；物理位置永不出现在请求里 */
    path: logicalPathField(),
    cursor: cursorField().optional(),
    maxChars: maxCharsField().optional(),
  })
  .strict();

const CompareCheckpointFilesArgs = z
  .object({
    left: z.object({ runId: runIdField(), stepSpanId: spanIdField().optional() }).strict(),
    right: z.object({ runId: runIdField(), stepSpanId: spanIdField().optional() }).strict(),
    path: logicalPathField().optional(),
    cursor: cursorField().optional(),
    limit: pageLimitField().optional(),
    maxChars: maxCharsField().optional(),
  })
  .strict();

/** 发布顺序即 tools/list 的顺序（与 D5 表一致） */
export const TOOL_CONTRACTS: readonly ToolContract[] = [
  contract(
    "list_runs",
    "只读列出数据根 traces/ 下的运行摘要（按结局类别与完整标识/任务文本筛选，不含正文）",
    ListRunsArgs,
  ),
  contract(
    "get_run",
    "只读读取单个运行的白名单摘要、父链来源与分页的 span/检查点索引（不默认返回消息或编辑正文）",
    GetRunArgs,
  ),
  contract(
    "get_step",
    "只读读取单个 span 的结构索引；仅在显式指定 section 时返回该段正文（重名 span 需要显式 owner）",
    GetStepArgs,
  ),
  contract(
    "compare_runs",
    "只读比较两个运行：逐侧给出可读/不可用与共同祖先、累计消耗与相对增量的可核对事实",
    CompareRunsArgs,
  ),
  contract(
    "inspect_checkpoint",
    "只读列出某个检查点（初始快照或本 run 自有完成步骤）的文件清单与附件可用性",
    InspectCheckpointArgs,
  ),
  contract(
    "read_checkpoint_file",
    "只读读取检查点清单内一条逻辑路径的原文（按码点范围返回，二进制只给大小与哈希）",
    ReadCheckpointFileArgs,
  ),
  contract(
    "compare_checkpoint_files",
    "只读比较两个自有检查点：不给 path 时分页列清单与引用，给 path 时逐侧核验正文",
    CompareCheckpointFilesArgs,
  ),
];

export const TOOL_NAMES: readonly string[] = TOOL_CONTRACTS.map((item) => item.name);

export function contractOf(name: string): ToolContract | undefined {
  return TOOL_CONTRACTS.find((item) => item.name === name);
}

/**
 * 登记实现时取契约：名字写错（契约里没有）是实现缺陷，宁可在模块加载时就炸，
 * 也不要在客户端调用时才回一句含糊的「未知工具」。
 */
export function requireContract(name: string): ToolContract {
  const contract = contractOf(name);
  if (contract === undefined) {
    throw new Error(`工具契约缺失：${name}`);
  }
  return contract;
}
