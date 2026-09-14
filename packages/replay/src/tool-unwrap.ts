import { ToolDefSchema } from "@rebaseagent/agent-loop";
import type { ToolDef } from "@rebaseagent/agent-loop";

/**
 * 录制工具表的解包与校验（replay 侧共享实现）。
 *
 * 录制存在两种合法形状：
 * - 引擎新录制（runLoop 直接把 config.tools 写进 request.tools）：扁平
 *   { name, description, parameters, sideEffect? }
 * - 旧版手工 trace / 第三方兼容录制（OpenAI 请求体包装）：
 *   { type: "function", function: { name, description, parameters } }
 *
 * 为什么放在 replay：录制侧算 config_hash 与分叉侧重建工具表必须**共用同一解包实现**，
 * 否则 sub-run 重建 config 的 hash 与父本 meta.config_hash 会因"两边各写一份碰巧一致"而漂移。
 *
 * 错误类型归属：本模块抛**自有** `ToolUnwrapError`，而不是桌面的 `ForkError`。
 * `ForkError` 是桌面 IPC 错误码的载体（`ipc.ts` 靠 `instanceof` + `e.code` 映射），
 * 属桌面专属语义；把它搬进 replay 会让 replay 反向依赖桌面概念。桌面在调用点捕获
 * `ToolUnwrapError` 后自行转成 `ForkError("FORK_NO_CONTEXT")`，IPC 错误码保持零变化。
 */

/** 解包失败的诊断类别（供调用方给出针对性文案，不做无差别兜底） */
export type ToolUnwrapFailureKind =
  /** 形状不合法：name/description/parameters 缺项或类型不符 */
  "invalid_shape";

/**
 * 工具表解包失败。携带失败类别与（可能的）工具名，供调用方转译成自己的错误码/文案。
 */
export class ToolUnwrapError extends Error {
  constructor(
    readonly kind: ToolUnwrapFailureKind,
    message: string,
    /** 失败工具在表内的下标；无法定位为 null */
    readonly index: number,
    /** 失败工具名（能读出 name 时有值，否则 null） */
    readonly toolName: string | null,
  ) {
    super(message);
    this.name = "ToolUnwrapError";
  }
}

/**
 * 把录制的工具表规整为 ToolDef 列表。
 *
 * 每一项都必须能解包为 ToolDef **并通过 ToolDefSchema 校验**；任一项失败即抛
 * `ToolUnwrapError`（不做部分解析、不静默丢弃——部分解析出的工具表算出的 hash 是伪造值）。
 */
export function toToolDefs(recorded: readonly Record<string, unknown>[]): ToolDef[] {
  const defs: ToolDef[] = [];
  for (let i = 0; i < recorded.length; i++) {
    const raw = recorded[i];
    if (raw === undefined) {
      throw new ToolUnwrapError("invalid_shape", `第 ${i + 1} 个工具项为空`, i, null);
    }
    const def = unwrapToolDef(raw);
    if (def === null) {
      throw new ToolUnwrapError(
        "invalid_shape",
        `第 ${i + 1} 个工具项无法解析（需 name/description/parameters 或 OpenAI 的 function 包装）`,
        i,
        typeof raw.name === "string" ? raw.name : null,
      );
    }
    defs.push(def);
  }
  return defs;
}

/**
 * 解包单个工具项为 ToolDef（经 ToolDefSchema 校验）；无法解包返回 null。
 * 同时兼容 OpenAI `function` 包装与扁平两种形状。
 * `sideEffect` 仅在有布尔值时带出——config_hash 规范化的前提。
 */
export function unwrapToolDef(raw: Record<string, unknown>): ToolDef | null {
  const wrapped = raw.function;
  const inner =
    typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : raw;
  const { name, description, parameters, sideEffect } = inner;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters)
  ) {
    return null;
  }
  const candidate = {
    name,
    description,
    parameters: parameters as Record<string, unknown>,
    ...(typeof sideEffect === "boolean" ? { sideEffect } : {}),
  };
  const parsed = ToolDefSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as ToolDef) : null;
}
