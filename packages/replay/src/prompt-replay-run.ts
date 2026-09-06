import { join } from "node:path";
import { OpenAiCompatClient } from "@rebaseagent/agent-loop";
import { runLoop } from "@rebaseagent/agent-loop";
import type { ForkRunMeta, LlmClient, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, assertForkable } from "@rebaseagent/trace-sdk";
import type { RunLoader } from "@rebaseagent/trace-sdk";
import { loadParentChain } from "./parent-chain.js";
import { derivePromptForkState } from "./prompt-fork.js";
import type { PromptForkEdit } from "./prompt-fork.js";
import { newForkRunId } from "./replay-run.js";

/**
 * prompt fork 编排：把"编辑启动上下文并从头重跑"执行到落盘。
 *
 * 与 replayRun（tool_result 时间旅行）的关系：
 * - 语义正交：tool_result replay 复用父前缀（copy-on-write 截断拼接），
 *   prompt fork 改变启动上下文、不复用任何父 span，从 agent.step 1 完整执行
 * - 校验独立：不要求新 config_hash 与父一致（改 system prompt 本来就是新实验）；
 *   但要求父 run 已封存、有 config_hash、非 proxy 来源、首次请求含字符串 system 消息
 * - 所有校验发生在创建 tracer 与发起模型请求之前：失败零文件、零调用
 */

export interface PromptReplayRunOptions {
  /** 直接父 run id（已完成封存；可为 prompt fork run——连续 fork 表达组合实验） */
  parentId: string;
  /** 单项编辑：system_prompt 或 user_message + 字符串新值 */
  edit: PromptForkEdit;
  /**
   * 本次运行配置。systemPrompt 字段不作为事实源——编排层强制以
   * derivePromptForkState 派生值覆写（双真相源守护：config_hash 的输入
   * 与首次真实请求里的 system 消息必须是同一个编辑值）。
   */
  config: RunConfig;
  /** 含 handler 的工具（与 config.tools 1:1，名称与定义须一致） */
  tools: Tool[];
  /** run 文件加载器（编排不直接碰 fs，由调用方注入） */
  load: RunLoader;
  /** fork run 文件落盘目录 */
  outDir: string;
  /** LLM 客户端（测试注入 mock；缺省真调 config.baseURL） */
  llm?: LlmClient;
}

export interface PromptReplayRunResult {
  /** 新 fork run 的 id（文件位于 outDir/<id>.jsonl） */
  id: string;
}

export async function promptReplayRun(
  options: PromptReplayRunOptions,
): Promise<PromptReplayRunResult> {
  const { parentId, edit, config, tools, load, outDir, llm } = options;

  // 0. 工具表与 config 必须一致（runLoop 的不变量，提前暴露避免半文件）
  if (config.tools.length !== tools.length) {
    throw new Error("config.tools 与 tools（含 handler）数量不一致，无法重跑");
  }

  // 1. 加载父链（根→叶）：校验环 / 缺失；新 run 的输入只来自叶 run 自身首次请求
  const records = loadParentChain(parentId, load);
  const leaf = records[records.length - 1];
  if (leaf === undefined) {
    throw new Error(`父 run 加载失败：${parentId}`);
  }

  // 2. 父 run 必须已封存（crashed 缺终止事件，禁止分叉）
  assertForkable(leaf);

  // 2.5 代理录制的 run：无源配置可哈希，RunConfig 无法重建——明确指向正确入口
  if (leaf.meta.source?.kind === "proxy") {
    throw new Error(
      `run ${leaf.meta.id} 由本地录制代理录制，不支持 prompt fork；请在其 llm.call 详情使用"编辑 messages 重发"（代理分叉）`,
    );
  }

  // 2.6 无 config_hash 的 run 无源配置指纹，不允许作为 prompt fork 父本
  if (leaf.meta.config_hash === undefined) {
    throw new Error(`run ${leaf.meta.id} 缺少 config_hash，无法作为 prompt fork 的父 run`);
  }

  // 3. 派生起点状态（纯数据）：编辑目标校验、字符串校验、空 fork 拒绝都在这里
  const state = derivePromptForkState({ record: leaf, edit });

  // 4. 双真相源强制：config.systemPrompt 以派生值为准（system_prompt 编辑 = 新值；
  //    user_message 编辑 = 父原值），runLoop 据此现算 config_hash
  const effectiveConfig: RunConfig = { ...config, systemPrompt: state.systemPrompt };

  // 5. 落盘 fork run 并从头执行：span 从 s_01 重新编号——完整独立新轨迹，
  //    不经 resolveBranch 与父轨迹拼接
  const id = newForkRunId();
  const tracer = new JsonlTracer(join(outDir, `${id}.jsonl`));
  const forkRun: ForkRunMeta = { id, parent: parentId, fork: state.fork };
  await runLoop(
    effectiveConfig,
    state.messages,
    tracer,
    tools,
    llm ?? new OpenAiCompatClient(effectiveConfig),
    forkRun,
  );
  return { id };
}
