import { assertForkable } from "@rebaseagent/trace-sdk";
import type { LlmCallSpan, RunLoader, RunRecord } from "@rebaseagent/trace-sdk";
import { loadParentChain } from "./parent-chain.js";
import { firstLlmCall, locateStartupContext } from "./prompt-fork.js";
import type { StartupContext } from "./prompt-fork.js";

/**
 * fork 父本的共用加载与校验（1.2）：prompt fork 与模型 A/B 实验走同一条门禁。
 *
 * 抽出来的原因：两边要求的父 run 条件完全一致（已封存、有 config_hash、
 * 首次 llm.call 含字符串 system 消息——proxy 与引擎 run 同判据），且都必须"先校验后落盘"——
 * 复制第二份就会在某个分支上悄悄少一条门禁。
 *
 * 本函数零 fs 副作用、零网络：失败即抛，调用方尚未创建 tracer，因此零新文件。
 */

export interface ForkParent {
  /** 父链（根→叶） */
  records: RunRecord[];
  /** 直接父 run（叶） */
  record: RunRecord;
  /** 父 run 自身首次 llm.call（启动上下文的唯一事实源） */
  llmSpan: LlmCallSpan;
  /** 首次请求中的字符串 system 消息（已校验存在） */
  system: { index: number; content: string };
  /** 首次请求中的字符串 user 消息；缺失为 null（仅 user_message 编辑需要） */
  user: StartupContext["user"];
}

/**
 * 加载并校验 fork 父本。所有拒绝都发生在创建文件与发起模型请求之前。
 *
 * 拒绝顺序（与既有行为一致，措辞沿用旧文案以免回归）：
 * 父链缺失/成环 → 未封存 → 缺 config_hash（统一拦截，proxy 与非 proxy 同判据）
 * → 无首次 llm.call → 无字符串 system 消息
 *
 * 代理 run 不再被无条件拒绝：录制侧已补写 `meta.config_hash`（可派生时），
 * 门禁只看指纹存在性——两侧共用同一条判据，不复制第二套编排。
 */
export function loadForkParent(parentId: string, load: RunLoader): ForkParent {
  // 1. 父链（根→叶）：环 / 缺失检测
  const records = loadParentChain(parentId, load);
  const leaf = records[records.length - 1];
  if (leaf === undefined) {
    throw new Error(`父 run 加载失败：${parentId}`);
  }

  // 2. 父 run 必须已封存（crashed 缺终止事件，禁止分叉）
  assertForkable(leaf);

  // 3. 无 config_hash 的 run 无源配置指纹，不允许作为 fork 父本
  if (leaf.meta.config_hash === undefined) {
    throw new Error(
      missingConfigHashMessage(
        leaf.meta.id,
        leaf.meta.source?.kind === "proxy",
        leaf.meta.config_hash_reason,
      ),
    );
  }

  // 4. 启动上下文的唯一事实源：父 run 自身首次 llm.call
  const llmSpan = firstLlmCall(leaf);
  const { system, user } = locateStartupContext(llmSpan.request.messages);
  if (system === null) {
    throw new Error(
      `父 run ${leaf.meta.id} 的首次 llm.call 不含字符串形式的 system 消息，无法重建 RunConfig.systemPrompt，prompt fork 不可用（系统不从 config_hash 反推）`,
    );
  }

  return { records, record: leaf, llmSpan, system, user };
}

/**
 * 缺 config_hash 的拒绝文案。
 *
 * 代理 run 按 `meta.config_hash_reason` 分流缺因——两种缺因的修复路径不同，
 * 单一笼统文案会让用户不知从何下手：
 * - no_system：需源应用发送带字符串 system 的请求后重新录制
 * - invalid_tool：需修正源应用的工具定义格式后重发
 * - 字段缺失（历史文件）：退回到「编辑 messages 重发」入口
 * 非 proxy 保持既有文案不变（回归要求）。
 */
function missingConfigHashMessage(
  id: string,
  isProxy: boolean,
  reason: "no_system" | "invalid_tool" | undefined,
): string {
  if (!isProxy) {
    return `run ${id} 缺少 config_hash，无法作为 prompt fork 的父 run`;
  }
  const tail = `也可以在其 llm.call 详情使用"编辑 messages 重发"（代理分叉）。`;
  if (reason === "no_system") {
    return (
      `run ${id} 由本地录制代理录制，但首次请求不含字符串形式的 system 消息，无法派生配置指纹（config_hash），因此不支持 prompt fork；` +
      `请让源应用发送带 system 消息的请求后重新经代理录制，${tail}`
    );
  }
  if (reason === "invalid_tool") {
    return (
      `run ${id} 由本地录制代理录制，但其工具表无法解析（部分工具项缺少 name/description/parameters），无法派生配置指纹（config_hash），因此不支持 prompt fork；` +
      `请修正源应用的工具定义格式后重新录制，${tail}`
    );
  }
  return (
    `run ${id} 由本地录制代理录制，meta 缺少 config_hash（历史录制或无法派生），不支持 prompt fork；` +
    `请重新经代理跑一次以获得可分叉的 run，${tail}`
  );
}
