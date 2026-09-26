import { createHmac, randomBytes } from "node:crypto";
import type { z } from "zod";
import type { ChannelName } from "../shared/channels";

/**
 * U4 请求同一性（design D2）的 main 侧纯逻辑：一次业务 schema parse ⇒ 一份不可变
 * 业务快照 ⇒ 一个会话内 HMAC 指纹。指纹与实际编排入参**同源**，这是「同 ID 重复只
 * 执行一次」「同 ID 异参拒绝」「指纹与执行使用同一解析快照」三条判据的实现落点。
 *
 * 规范化的口径（刻意做的选择，不是疏漏）：
 * - 对象键**递归排序** ⇒ 属性顺序变化视为同一请求；
 * - 数组顺序与字符串字节**原样保留**、不 trim ⇒ 正文空白、消息顺序、臂顺序都是业务差异；
 * - 每个标量带类型标记 ⇒ `1` 与 `"1"`、`true` 与 `"true"`、`0` 与 `""` 都不相同；
 * - `undefined` 值与「键缺失」等价，`null` 自成一类 ⇒ schema 补出的缺省值与
 *   显式传 `undefined` 得到同一指纹（等价解析结果必须能关联原操作）；
 * - 通道名参与规范化 ⇒ 同一 operationId 跨通道复用必然异参，直接落进冲突分支。
 *
 * 指纹用 **main 会话随机密钥** 的 HMAC-SHA-256：登记里只留不可逆摘要，
 * 既能在重启后（新会话新密钥）无法被旧摘要反推，也不回传、不持久化。
 */

/** 规范化失败：解析产物里出现了不该出现的类型（函数 / 符号 / 循环引用等） */
export class RequestCanonicalError extends Error {
  constructor(reason: string) {
    super(`业务请求无法规范化：${reason}`);
    this.name = "RequestCanonicalError";
  }
}

/**
 * 字段级错误的展示口径：**只有路径与稳定 code**——不回显任何收到的值。
 * 这条错误文案只用于本次响应，绝不进入登记（含输入的 ZodError 一律不落 registry）。
 */
function describeIssue(issue: z.ZodIssue): string {
  return `${issue.path.join(".") || "(root)"}：${issue.code}`;
}

/**
 * 把任意 JSON 值规范化成确定性字符串。
 * 只读不改：绝不原地排序调用方的对象（那会改写快照本身，违反「规范化不原地改写」）。
 */
export function canonicalizeRequest(value: unknown): string {
  return walk(value, new WeakSet<object>(), "");
}

function walk(value: unknown, seen: WeakSet<object>, path: string): string {
  if (value === null) return "N";
  switch (typeof value) {
    case "string":
      return `s${JSON.stringify(value)}`;
    case "number": {
      if (!Number.isFinite(value)) throw new RequestCanonicalError(`${path} 非法数值 ${value}`);
      return `n${Object.is(value, -0) ? "-0" : String(value)}`;
    }
    case "boolean":
      return `b${value ? "1" : "0"}`;
    case "bigint":
      return `g${value.toString()}`;
    case "undefined":
      // 与「键缺失」同一形态：由对象分支跳过 undefined 值实现
      return "U";
    default:
      break;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new RequestCanonicalError(`${path} 出现不可传输的 ${typeof value}`);
  }
  if (seen.has(value as object)) {
    throw new RequestCanonicalError(`${path} 存在循环引用`);
  }
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => walk(item, seen, `${path}[${index}]`)).join(",")}]`;
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => {
        const item = (value as Record<string, unknown>)[key];
        // 键缺失 == 显式 undefined：两者必须是同一形态，否则等价解析会算出两套指纹
        return item === undefined
          ? []
          : [`${JSON.stringify(key)}:${walk(item, seen, `${path}.${key}`)}`];
      });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value as object);
  }
}

/** 会话指纹器：一个 main 会话一个随机密钥；摘要仅用于内部比较 */
export class RequestFingerprinter {
  private readonly secret: Buffer;

  constructor(secret?: Buffer) {
    this.secret = secret ?? randomBytes(32);
  }

  /** 摘要通道名与规范化业务值（同一业务值在不同通道下指纹不同） */
  fingerprint(channel: ChannelName, business: unknown): string {
    const canonical = `${JSON.stringify(channel)}|${canonicalizeRequest(business)}`;
    return createHmac("sha256", this.secret).update(canonical, "utf8").digest("hex");
  }
}

/** 一次 parse 的产物：通道 + 不可变业务快照 + 由该快照算出的指纹 */
export interface BusinessRequest<T> {
  readonly channel: ChannelName;
  readonly value: Readonly<T>;
  readonly fingerprint: string;
}

export type BusinessParseResult<T> =
  | { ok: true; request: BusinessRequest<T> }
  | { ok: false; code: "INVALID_ARGUMENT"; message: string };

/**
 * **入口只 parse 一次**：返回值 `value` 是深冻结的解析产物，指纹与后续编排入参都从它
 * 派生。严禁回用原始 payload、严禁二次补缺省。
 *
 * 深冻结 ⇒ 任何「生成指纹后修改嵌套字段」的尝试在 strict 模式下直接抛错，
 * 而不是静默产生「指纹与执行值不一致」的第二套业务值。
 */
export function parseBusinessRequest<T>(
  fingerprinter: RequestFingerprinter,
  channel: ChannelName,
  schema: z.ZodType<T>,
  payload: unknown,
): BusinessParseResult<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // 字段级错误只用于本次响应的展示；含输入的 ZodError 绝不进入登记与指纹
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: parsed.error.issues.map(describeIssue).join("；"),
    };
  }
  // structuredClone：zod 对 `z.unknown()` 的值是**原样引用**，不复制就等于把调用方的
  // 对象当成快照——之后任何一处改写嵌套字段都会让「指纹与执行值」分叉。
  const value = freezeDeep(structuredClone(parsed.data)) as T;
  return {
    ok: true,
    request: {
      channel,
      value,
      fingerprint: fingerprinter.fingerprint(channel, value),
    },
  };
}

/**
 * 递归冻结（不裁剪、不改写值）。IPC 数据是无环的，WeakSet 只是防御性护栏——
 * 遇到循环引用时抛错而不是无限递归。
 */
function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) {
    throw new RequestCanonicalError("业务快照存在循环引用");
  }
  seen.add(value as object);
  for (const item of Object.values(value as Record<string, unknown>)) {
    freezeDeep(item, seen);
  }
  return Object.freeze(value);
}
