import type { ToolDef } from "@rebaseagent/agent-loop";
import type { WorkspaceMeta } from "@rebaseagent/trace-sdk";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  FILE_TOOLS_V1_PROFILE,
  type FileToolDefinition,
} from "./file-tools.js";

/**
 * 隔离运行的**启动前门禁**（A design §4）：profile 一致性与"当前请求"的副本写入授权。
 *
 * 这一层要挡住的是**授权旁路**——而不是文件内容问题。三条旁路与各自的挡法：
 *
 * | 旁路 | 挡法 |
 * |---|---|
 * | 工具表被改（把 `write_file` 标成 `pure`、删掉 `sideEffect`、塞自定义工具） | 逐字段比对固定 profile |
 * | 拿历史记录当权限（父 trace 的 `write_authorized:true`、调用方伪造同名字段） | 授权类型**只**由当前请求构造 |
 * | 传一整个 `Tool[]` 进来（带 handler，可绕过世界实例） | 门禁只看**定义**，且编排不接受 handler |
 *
 * ## 为什么"审计标注"不能当授权（P2-4）
 *
 * `WorkspaceMeta.write_authorized` 是 schema 里的恒真字面量：它只保证**记录形状**一致，
 * 表示"创建方声称该次运行经副本写入确认"。它既不证明历史文件未被篡改，也不是可转移的凭证。
 * 因此本模块**刻意不提供**任何把 `WorkspaceMeta` 转成授权的入口——不是"记得别传"，而是
 * **类型上就传不进来**：`WorkspaceWriteAuthority` 的字段名与 `WorkspaceMeta` 无一重合
 * （调用方必须显式写 `{ allowFileWrites: ... }`，写不出"把 meta 直接递进去"这条路）。
 *
 * 更关键的是**缺省方向**：`allowFileWrites` 必填、无默认值、不接受 `undefined`/truthy 之外的
 * 任何值（`"true"` 字符串、`1` 都不算）。默认值会变成"忘了传 = 授权"，而这里是权限边界。
 */

/** profile 一致性失败的类别（供调用方给出针对性文案，不做无差别兜底） */
export type ToolProfileFailureKind =
  /** profile 名不是已知的固定 profile */
  | "unknown_profile"
  /** 工具数量不对（多一个自定义工具、或少一个） */
  | "tool_count_mismatch"
  /** 某个位置的工具名字/描述/参数 schema/标记与固定定义不符 */
  | "definition_mismatch";

export interface ToolProfileFailure {
  readonly kind: ToolProfileFailureKind;
  readonly reason: string;
}

export type ToolProfileCheckResult =
  | { readonly ok: true; readonly profile: string }
  | { readonly ok: false; readonly failure: ToolProfileFailure };

/**
 * 逐字段核对工具表与固定 profile 是否一致。
 *
 * 比对粒度刻意做到**字段级**，而不是"名字对不对"：
 * - **顺序**参与比对（顺序是指纹的一部分，也是模型看到的顺序）；
 * - **`parameters` 深比较**（用规范化 JSON：键序无关，但内容、类型、`required`、
 *   `additionalProperties` 任何一处不同都算不一致）；
 * - **`sideEffect` 的存在性与取值都参与**：`write_file` 少了这个键**不等于**"默认 false"，
 *   而是**不一致**——删掉标记是最常见的"把声明改写成合法定义后继续"的路子，
 *   若按"缺省即默认"处理，这条用例的期望就落空了。
 *
 * 只接受定义（`ToolDef`/`FileToolDefinition` 形状），**不接受带 handler 的 `Tool`**：
 * handler 由编排层从固定工厂造，任何调用方提供的 handler 都是旁路。
 */
export function checkToolProfile(
  definitions: readonly ToolDef[],
  profile: string,
): ToolProfileCheckResult {
  if (profile !== FILE_TOOLS_V1_PROFILE) {
    return fail(
      "unknown_profile",
      `未知的工具 profile：${JSON.stringify(profile)}（本版本只认识 ${FILE_TOOLS_V1_PROFILE}）`,
    );
  }

  const expected = FILE_TOOLS_V1_DEFINITIONS;
  if (definitions.length !== expected.length) {
    return fail(
      "tool_count_mismatch",
      `工具表与 ${FILE_TOOLS_V1_PROFILE} 不一致：期望 ${expected.length} 个工具（${expected
        .map((def) => def.name)
        .join("、")}），实际 ${definitions.length} 个（${definitions
        .map((def) => describeToolName(def))
        .join("、")}）——不接受自定义工具或不完整的工具表`,
    );
  }

  for (let i = 0; i < expected.length; i++) {
    const want = expected[i] as FileToolDefinition;
    const got = definitions[i] as ToolDef;
    const mismatch = findDefinitionMismatch(want, got);
    if (mismatch !== null) {
      return fail("definition_mismatch", `第 ${i + 1} 个工具（${want.name}）${mismatch}`);
    }
  }
  return { ok: true, profile: FILE_TOOLS_V1_PROFILE };
}

/**
 * 当前请求的副本写入授权。
 *
 * 字段名刻意与 `WorkspaceMeta` 无一重合，且**必填无默认**：这样"把父 meta 递进来当授权"
 * 在类型上就不成立；忘了传是编译错误，而不是静默放行。
 */
export interface WorkspaceWriteAuthority {
  /**
   * 本次请求是否允许在**世界副本**内写入。只有字面量 `true` 才算授权，
   * `false`/缺省/`undefined` 一律按未授权处理（fail closed）。
   */
  readonly allowFileWrites: boolean;
}

export interface WriteAuthorityFailure {
  readonly kind: "missing_authority";
  readonly reason: string;
}

export type WriteAuthorityCheckResult =
  | { readonly ok: true; readonly authority: WorkspaceWriteAuthority }
  | { readonly ok: false; readonly failure: WriteAuthorityFailure };

/**
 * 校验当前请求携带的授权。
 *
 * 严格到"必须是布尔 `true`"：`1`、`"true"`、`{}` 都不算——宽松判定是权限边界上最容易开的洞。
 * 入参用 `unknown` 是因为调用方可能从 IPC/JSON 边界拿到未校验的值。
 */
export function checkWriteAuthority(input: unknown): WriteAuthorityCheckResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return reject(
      "缺少本次请求的副本写入授权（allowFileWrites）——授权只由**当前请求**提供，" +
        "不得从父 trace 的 write_authorized 标注推导或补齐",
    );
  }
  const allowFileWrites = (input as { allowFileWrites?: unknown }).allowFileWrites;
  if (allowFileWrites !== true) {
    return reject(
      `本次请求未显式允许副本写入（allowFileWrites 必须为字面量 true，实际为 ${describeValue(
        allowFileWrites,
      )}）——历史审计标注不能替代本次授权`,
    );
  }
  return { ok: true, authority: { allowFileWrites: true } };
}

/**
 * 只从**结构化请求**构造授权（4.1 编排的入口用它，而不是直接读 request 字段）。
 *
 * 它有意接收 `unknown`：编排层拿到的往往是 IPC/JSON 的原始值，这里做唯一一次严格判定，
 * 判定通过后的 `WorkspaceWriteAuthority` 才是"已授权"的类型级凭据。
 */
export function requireWriteAuthority(request: unknown): WriteAuthorityCheckResult {
  return checkWriteAuthority(request);
}

/**
 * 审计标注的读取器：**故意只返回审计文本**，不返回任何可用于授权的值。
 *
 * 存在的意义是把"这个字段只能用于展示/记录"写进类型：调用方想拿它去开门时会发现
 * 返回的是字符串/布尔描述，而不是 `WorkspaceWriteAuthority`。
 * `WorkspaceMeta` 缺省（普通 v1 run）时返回 `null`。
 */
export function describeWriteAuthorizationAudit(
  workspace: WorkspaceMeta | undefined,
): string | null {
  if (workspace === undefined) {
    return null;
  }
  return workspace.write_authorized
    ? "该 run 创建时声称已确认副本写入（审计标注，不代表本次已授权）"
    : "该 run 未记录副本写入确认";
}

function fail(kind: ToolProfileFailureKind, reason: string): ToolProfileCheckResult {
  return { ok: false, failure: { kind, reason } };
}

function reject(reason: string): WriteAuthorityCheckResult {
  return { ok: false, failure: { kind: "missing_authority", reason } };
}

/**
 * 单个位置的逐字段差异；一致返回 `null`。
 *
 * `sideEffect` 用 `hasOwnProperty` 判存在性，**不用 truthiness**：
 * `sideEffect: undefined` 与"没有这个键"在规范化 JSON 下都会消失，但前者是调用方显式写了
 * 一个坏值，后者是删了标记——两种都算不一致，故先把存在性判掉再看取值。
 */
function findDefinitionMismatch(want: FileToolDefinition, got: ToolDef): string | null {
  if (got.name !== want.name) {
    return `名字不符：期望 ${JSON.stringify(want.name)}，实际 ${JSON.stringify(got.name)}`;
  }
  if (got.description !== want.description) {
    return "描述不符（描述也参与 profile 指纹）";
  }
  if (!hasOwn(got, "sideEffect")) {
    return "缺少 sideEffect 标记——删掉标记不等于默认值，属于不符";
  }
  if (got.sideEffect !== want.sideEffect) {
    return `sideEffect 不符：期望 ${String(want.sideEffect)}，实际 ${String(got.sideEffect)}（不能给写工具改标记来放行）`;
  }
  if (canonicalJson(got.parameters) !== canonicalJson(want.parameters)) {
    return "参数 schema 不符（含 required 与 additionalProperties）";
  }
  return null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** 规范化 JSON：对象键排序（schema 里的键序不构成差异，内容与类型构成差异） */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      out[key] = sortKeys(val);
    }
    return out;
  }
  return value;
}

function describeToolName(def: ToolDef): string {
  return typeof def.name === "string" ? def.name : "<无名>";
}

function describeValue(value: unknown): string {
  if (value === undefined) return "未提供";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
