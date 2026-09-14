import { configHash } from "@rebaseagent/agent-loop";
import type { ToolDef } from "@rebaseagent/agent-loop";
import { locateStartupContext } from "./prompt-fork.js";
import { ToolUnwrapError, toToolDefs } from "./tool-unwrap.js";

/**
 * 从代理请求快照派生配置指纹（录制侧与分叉侧共用的单一实现）。
 *
 * 为什么需要：代理录制的 run 此前不写 `meta.config_hash`，而 `loadForkParent` 无条件
 * 拒绝 proxy 来源——零摩擦接入的真实 run 无法用于 prompt fork / 模型 A/B。本函数把
 * "从请求快照算指纹"收敛为一处，避免跨路径静默不等。
 *
 * 输入形状取自 llm-proxy 的请求快照（messages / tools），不依赖 llm-proxy 包
 * （保持该包零 workspace 依赖）。
 */

/** 指纹缺省的结构化缺因：录制侧写入 meta，门禁/UI 据此给精准文案 */
export type ConfigHashMissReason =
  /** 首次请求无字符串形式的 system 消息 */
  | "no_system"
  /** 工具表存在无法解包的项 */
  | "invalid_tool";

/** 派生结果：可派生时给 hash，否则给结构化缺因（二者互斥） */
export type ConfigHashDerivation =
  | { hash: string; reason: null }
  | { hash: null; reason: ConfigHashMissReason };

export interface ProxyConfigHashInput {
  /** 请求消息。录制侧为宽松透传记录（Record），门禁侧为结构化 Message；
   *  本函数只读 role / content，故取两者都满足的最宽形状。 */
  messages: ReadonlyArray<Record<string, unknown>>;
  /** 请求工具表（OpenAI 包装或扁平）；缺省视为空表 */
  tools?: ReadonlyArray<Record<string, unknown>>;
}

/**
 * 派生代理 run 的 config_hash。
 *
 * - system：复用 `locateStartupContext`——首条 `role=system` 且 content 为字符串的消息；
 *   缺失 → `{ hash: null, reason: "no_system" }`（诚实缺省，不假定空串）。
 * - tools：缺省 → 空表；存在 → 每项经解包并通过 `ToolDefSchema` 校验，
 *   任一项失败 → `{ hash: null, reason: "invalid_tool" }`，不做部分哈希。
 * - 满足时返回 `{ hash: configHash(system, tools), reason: null }`——
 *   与引擎同一实现、同一套规范化，逐字节相等由 fixture 测试锁定。
 */
export function deriveProxyConfigHash(input: ProxyConfigHashInput): ConfigHashDerivation {
  // 录制侧消息为宽松透传记录；locateStartupContext 只读 role/content，断言此处安全
  const messages = input.messages as ReadonlyArray<{ role: unknown; content?: unknown }>;
  const { system } = locateStartupContext(messages);
  if (system === null) {
    return { hash: null, reason: "no_system" };
  }

  // 缺省视为空表：纯 chat 应用的常见形态，configHash(system, []) 合法
  const recorded = input.tools ?? [];
  let tools: ToolDef[];
  try {
    tools = toToolDefs(recorded);
  } catch (e) {
    if (e instanceof ToolUnwrapError) {
      return { hash: null, reason: "invalid_tool" };
    }
    throw e;
  }

  return { hash: configHash(system.content, tools), reason: null };
}
