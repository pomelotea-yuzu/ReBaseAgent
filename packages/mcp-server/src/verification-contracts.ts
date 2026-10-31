import type { VerificationRecordStatus } from "@rebaseagent/project-verification/read";
import { RECORD_ID_PATTERN } from "@rebaseagent/project-verification/read";
import {
  CommandIdSchema,
  VerificationOutcomeSchema,
} from "@rebaseagent/project-verification/schema";
import { z } from "zod";
import { toJsonSchemaDeclaration } from "./input-schema.js";
import {
  BODY_CHARS_MAX,
  CURSOR_MAX,
  LOGICAL_PATH_MAX,
  PAGE_LIMIT_MAX,
  RUN_ID_MAX,
} from "./limits.js";
import type { ToolAnnotations } from "./server.js";
import { READ_ONLY_ANNOTATIONS } from "./tool-contracts.js";

/**
 * 六个验证查询工具的入参契约（MCP2 design D2）。
 *
 * 纪律与 tool-contracts.ts 同源，这里只列验证域差异：
 * - 验证 ID 沿 R3 `^[a-z0-9][a-z0-9_-]{0,63}$`（`RECORD_ID_PATTERN`，单一来源）；
 * - `status` 用 R3 四状态、`outcome` 用 R3 十一值、`commandId` 用 R3 两值——
 *   全部从 `@rebaseagent/project-verification` 的 schema 导入，不复制第二份枚举；
 * - `compare_verifications` 固定两侧对象（与 `compare_runs` 同风格）；
 * - 参数里没有 hash、宿主路径、URL、dataDir、handler——日志按验证/命令/流定位、
 *   产物只认清单内逻辑路径（D4）。
 *
 * 本模块只**冻结契约**：注册进 tools/list 由各工具实现时进行（"没实现就不登记"，
 * tools.ts），完整实现后十三个工具（M01 的注册半边在 3.x/5.1 收口）。
 */

/** 每个字段独立实例（防 zod-to-json-schema 压成 $ref，与 tool-contracts.ts 同注释） */
const verificationIdField = (): z.ZodString => z.string().regex(RECORD_ID_PATTERN).max(64);
const runIdField = (): z.ZodString => z.string().min(1).max(RUN_ID_MAX);
const logicalPathField = (): z.ZodString => z.string().min(1).max(LOGICAL_PATH_MAX);
const cursorField = (): z.ZodString => z.string().min(1).max(CURSOR_MAX);
const pageLimitField = (): z.ZodNumber => z.number().int().min(1).max(PAGE_LIMIT_MAX);
const maxCharsField = (): z.ZodNumber => z.number().int().min(1).max(BODY_CHARS_MAX);

// ---------------------------------------------------------------------------
// 数据状态（design D3 表第三行）
// ---------------------------------------------------------------------------

/** R3 验证记录四状态（类型与 R3 reader 同源，运行时枚举在此钉住） */
export const VERIFICATION_RECORD_STATUSES = [
  "sealed",
  "unterminated",
  "corrupt",
  "unsupported_version",
] as const satisfies readonly VerificationRecordStatus[];
export const VerificationRecordStatusSchema = z.enum(VERIFICATION_RECORD_STATUSES);

/** 产物/日志附件的可用性（相对**本记录**的引用而言） */
export const VERIFICATION_ASSET_AVAILABILITIES = [
  "available",
  "missing",
  "corrupt",
  "rejected",
] as const;
export const VerificationAssetAvailabilitySchema = z.enum(VERIFICATION_ASSET_AVAILABILITIES);

/** 正文类型：严格 UTF-8 文本 or 二进制/非法编码（后者只给元数据，D5） */
export const VERIFICATION_BODY_KINDS = ["text", "binary"] as const;
export const VerificationBodyKindSchema = z.enum(VERIFICATION_BODY_KINDS);

/** 比较侧可读性 */
export const VERIFICATION_COMPARE_SIDE_STATES = ["ready", "unavailable"] as const;
export const VerificationCompareSideStateSchema = z.enum(VERIFICATION_COMPARE_SIDE_STATES);

// ---------------------------------------------------------------------------
// 六工具入参契约
// ---------------------------------------------------------------------------

export interface VerificationToolContract {
  readonly name: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ToolAnnotations;
}

function contract(name: string, schema: z.ZodObject<z.ZodRawShape>): VerificationToolContract {
  return {
    name,
    schema,
    inputSchema: toJsonSchemaDeclaration(schema),
    annotations: READ_ONLY_ANNOTATIONS,
  };
}

const ListVerificationsArgs = z
  .object({
    runId: runIdField().optional(),
    status: VerificationRecordStatusSchema.optional(),
    outcome: VerificationOutcomeSchema.optional(),
    cursor: cursorField().optional(),
    limit: pageLimitField().optional(),
  })
  .strict();
export type ListVerificationsArgs = z.infer<typeof ListVerificationsArgs>;

const GetVerificationArgs = z
  .object({
    verificationId: verificationIdField(),
    cursor: cursorField().optional(),
    limit: pageLimitField().optional(),
  })
  .strict();
export type GetVerificationArgs = z.infer<typeof GetVerificationArgs>;

/**
 * 日志定位三要素（D2）：只认验证/命令/流，不接裸 hash 或字节 offset——
 * 附件哈希由记录内 command_end 解析，本工具不接受"指哪读哪"。
 */
const ReadVerificationLogArgs = z
  .object({
    verificationId: verificationIdField(),
    commandId: CommandIdSchema,
    stream: z.enum(["stdout", "stderr"]),
    cursor: cursorField().optional(),
    maxChars: maxCharsField().optional(),
  })
  .strict();
export type ReadVerificationLogArgs = z.infer<typeof ReadVerificationLogArgs>;

const InspectVerificationArtifactsArgs = z
  .object({
    verificationId: verificationIdField(),
    cursor: cursorField().optional(),
    limit: pageLimitField().optional(),
  })
  .strict();
export type InspectVerificationArtifactsArgs = z.infer<typeof InspectVerificationArtifactsArgs>;

const ReadVerificationArtifactArgs = z
  .object({
    verificationId: verificationIdField(),
    /** 只有该验证产物清单内的逻辑路径；物理位置/hash 永不出现在请求里 */
    path: logicalPathField(),
    cursor: cursorField().optional(),
    maxChars: maxCharsField().optional(),
  })
  .strict();
export type ReadVerificationArtifactArgs = z.infer<typeof ReadVerificationArtifactArgs>;

/** 左右两个对象（与 compare_runs 同风格）；"两条不同验证"由实现层以 INVALID_ARGUMENT 拒 */
const CompareVerificationsArgs = z
  .object({
    left: z.object({ verificationId: verificationIdField() }).strict(),
    right: z.object({ verificationId: verificationIdField() }).strict(),
  })
  .strict();
export type CompareVerificationsArgs = z.infer<typeof CompareVerificationsArgs>;

/** 发布顺序即 tools/list 里验证域的顺序（与 D2 表一致） */
export const VERIFICATION_TOOL_CONTRACTS: readonly VerificationToolContract[] = [
  contract("list_verifications", ListVerificationsArgs),
  contract("get_verification", GetVerificationArgs),
  contract("read_verification_log", ReadVerificationLogArgs),
  contract("inspect_verification_artifacts", InspectVerificationArtifactsArgs),
  contract("read_verification_artifact", ReadVerificationArtifactArgs),
  contract("compare_verifications", CompareVerificationsArgs),
];

export const VERIFICATION_TOOL_NAMES: readonly string[] = VERIFICATION_TOOL_CONTRACTS.map(
  (item) => item.name,
);

export function verificationContractOf(name: string): VerificationToolContract | undefined {
  return VERIFICATION_TOOL_CONTRACTS.find((item) => item.name === name);
}

/**
 * 登记实现时取契约：名字写错（契约里没有）是实现缺陷，宁可在模块加载时就炸，
 * 也不要在客户端调用时才回一句含糊的「未知工具」（与 requireContract 同纪律）。
 */
export function requireVerificationContract(name: string): VerificationToolContract {
  const found = verificationContractOf(name);
  if (found === undefined) {
    throw new Error(`验证工具契约缺失：${name}`);
  }
  return found;
}
