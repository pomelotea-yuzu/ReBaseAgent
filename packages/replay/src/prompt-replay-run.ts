import { join } from "node:path";
import { OpenAiCompatClient } from "@rebaseagent/agent-loop";
import { runLoop } from "@rebaseagent/agent-loop";
import type { ForkRunMeta, LlmClient, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import type { RunLoader } from "@rebaseagent/trace-sdk";
import { loadForkParent } from "./fork-parent.js";
import { derivePromptForkState } from "./prompt-fork.js";
import type { PromptForkEdit } from "./prompt-fork.js";
import { newForkRunId } from "./replay-run.js";
import { observeRunIdentity } from "./run-identity.js";
import type { OnRunIdentified } from "./run-identity.js";

/**
 * prompt fork 编排：把"编辑启动上下文并从头重跑"执行到落盘。
 *
 * 与 replayRun（tool_result 时间旅行）的关系：
 * - 语义正交：tool_result replay 复用父前缀（copy-on-write 截断拼接），
 *   prompt fork 改变启动上下文、不复用任何父 span，从 agent.step 1 完整执行
 * - 校验独立：不要求新 config_hash 与父一致（改 system prompt 本来就是新实验）；
 *   但要求父 run 已封存、有 config_hash、首次请求含字符串 system 消息（proxy 与引擎 run 同判据）
 * - 所有校验发生在创建 tracer 与发起模型请求之前：失败零文件、零调用
 *
 * model_params 编辑（V3b 单臂路径）同样走这里：它只换 model/params，
 * 不改启动 messages 与 system prompt，因此 config_hash 与父保持一致。
 */

export interface PromptReplayRunOptions {
  /** 直接父 run id（已完成封存；可为 prompt fork run——连续 fork 表达组合实验） */
  parentId: string;
  /** 单项编辑：system_prompt / user_message（字符串）或 model_params（模型配置） */
  edit: PromptForkEdit;
  /**
   * 本次运行配置。systemPrompt 字段不作为事实源——编排层先校验它等于父 run
   * 首次请求录制的 system 内容，再以 derivePromptForkState 派生值覆写（1.4）。
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
  /**
   * 可选的可信运行身份观察（U4 design D5）：本次最终 run.meta 写出后、首次 LLM 调用前
   * 通知一次 id，覆盖本入口已支持的 system_prompt / user_message / model_params 三种编辑。
   * 从头执行与父链门禁语义不因它改变；前置拒绝（隔离父本、缺父链、不可还原 system、
   * 空编辑、双真相源）一律不回调——没有记录就不给身份。
   */
  onRunIdentified?: OnRunIdentified;
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

  // 1. 父链 + 封存 + config_hash + 首次 llm.call + 字符串 system 消息
  //    （1.2：与模型 A/B 实验共用同一条门禁；失败零文件、零调用）
  const parent = loadForkParent(parentId, load);

  // 2. 派生起点状态（纯数据）：编辑目标校验、字符串/结构校验、空 fork 拒绝都在这里
  const state = derivePromptForkState({ record: parent.record, edit });

  // 3. 双真相源：**先校验后覆写**。
  //    比较对象是父 run 首次请求里录制的 system 内容（未编辑的原值）——
  //    不等说明调用方传入的 RunConfig.systemPrompt 与 trace 录制的事实不是同一个（配置漂移）。
  //    直接覆写会把漂移悄悄抹平、让这条校验永不触发，所以必须先比后写。
  //    相等时覆写才发生：system_prompt 编辑 = 应用新值；其余编辑 = 无操作。
  if (config.systemPrompt !== parent.system.content) {
    throw new Error(
      `双真相源不一致：RunConfig.systemPrompt 与父 run ${parentId} 首次 llm.call 录制的 system 消息不同。系统提示词必须与录制事实一致才能 fork（config_hash 不可逆，不反推、不猜、不覆写掩盖）`,
    );
  }
  const effectiveConfig: RunConfig = { ...config, systemPrompt: state.systemPrompt };

  // 3.5 model_params 编辑：只覆盖 model 与数值采样参数（systemPrompt / 工具表不变 → config_hash 同源）
  if (state.modelOverride !== null) {
    effectiveConfig.model = state.modelOverride.model;
    effectiveConfig.params = state.modelOverride.params;
  }

  // 4. 落盘 fork run 并从头执行：span 从 s_01 重新编号——完整独立新轨迹，
  //    不经 resolveBranch 与父轨迹拼接
  const id = newForkRunId();
  const tracer = new JsonlTracer(join(outDir, `${id}.jsonl`));
  const forkRun: ForkRunMeta = { id, parent: parentId, fork: state.fork };
  const releaseIdentityWatch = observeRunIdentity(tracer, options.onRunIdentified);
  try {
    await runLoop(
      effectiveConfig,
      state.messages,
      tracer,
      tools,
      llm ?? new OpenAiCompatClient(effectiveConfig),
      forkRun,
    );
  } finally {
    releaseIdentityWatch();
  }
  return { id };
}
