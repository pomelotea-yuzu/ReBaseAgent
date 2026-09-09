import { assertForkable } from "@rebaseagent/trace-sdk";
import type { LlmCallSpan, RunLoader, RunRecord } from "@rebaseagent/trace-sdk";
import { loadParentChain } from "./parent-chain.js";
import { firstLlmCall, locateStartupContext } from "./prompt-fork.js";
import type { StartupContext } from "./prompt-fork.js";

/**
 * fork 父本的共用加载与校验（1.2）：prompt fork 与模型 A/B 实验走同一条门禁。
 *
 * 抽出来的原因：两边要求的父 run 条件完全一致（已封存、非 proxy、有 config_hash、
 * 首次 llm.call 含字符串 system 消息），且都必须"先校验后落盘"——
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
 * 父链缺失/成环 → 未封存 → proxy 来源 → 缺 config_hash → 无首次 llm.call → 无字符串 system 消息
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

  // 3. 代理录制的 run：无源配置可哈希，RunConfig 无法重建——明确指向正确入口
  if (leaf.meta.source?.kind === "proxy") {
    throw new Error(
      `run ${leaf.meta.id} 由本地录制代理录制，不支持 prompt fork；请在其 llm.call 详情使用"编辑 messages 重发"（代理分叉）`,
    );
  }

  // 4. 无 config_hash 的 run 无源配置指纹，不允许作为 fork 父本
  if (leaf.meta.config_hash === undefined) {
    throw new Error(`run ${leaf.meta.id} 缺少 config_hash，无法作为 prompt fork 的父 run`);
  }

  // 5. 启动上下文的唯一事实源：父 run 自身首次 llm.call
  const llmSpan = firstLlmCall(leaf);
  const { system, user } = locateStartupContext(llmSpan.request.messages);
  if (system === null) {
    throw new Error(
      `父 run ${leaf.meta.id} 的首次 llm.call 不含字符串形式的 system 消息，无法重建 RunConfig.systemPrompt，prompt fork 不可用（系统不从 config_hash 反推）`,
    );
  }

  return { records, record: leaf, llmSpan, system, user };
}
