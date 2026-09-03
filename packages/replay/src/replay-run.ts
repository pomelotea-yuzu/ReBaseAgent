import { join } from "node:path";
import { OpenAiCompatClient } from "@rebaseagent/agent-loop";
import { configHash, runLoop } from "@rebaseagent/agent-loop";
import type { ForkRunMeta, LlmClient, RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, assertForkable } from "@rebaseagent/trace-sdk";
import type { RunLoader, RunRecord } from "@rebaseagent/trace-sdk";
import { deriveReplayState } from "./derive.js";
import type { ReplayEdit } from "./derive.js";

/**
 * 时间旅行编排：把"编辑某步 tool.result 并从该步重跑"执行到落盘。
 *
 * 责任边界（与 runLoop 的分工）：
 * - 本层负责"父 run 概念"：加载父链、assertForkable、config_hash 一致性校验、
 *   派生起点状态、生成 fork run 文件并注入 forkRun 元数据
 * - runLoop 无父 run 概念：从派生 messages 起跑，之后步骤真实执行（工具同权限同 cwd）
 * - 校验失败不产生任何文件（先校验后建 tracer）
 */

export interface ReplayRunOptions {
  /** 父 run id（已完成封存；可为 fork run——链式再分叉） */
  parentId: string;
  /** 分叉点：父 run（或其祖先）轨迹中的 tool.invoke span id */
  atSpanId: string;
  /** 编辑值（MVP 仅 result；与父同源才允许） */
  edit: ReplayEdit;
  /** 本次运行配置：systemPrompt/tools 必须与父 run 同源（config_hash 一致） */
  config: RunConfig;
  /** 含 handler 的工具（与 config.tools 1:1，名称与定义须一致） */
  tools: Tool[];
  /** run 文件加载器（replay 不直接碰 fs，由调用方注入） */
  load: RunLoader;
  /** fork run 文件落盘目录 */
  outDir: string;
  /** LLM 客户端（测试注入 mock；缺省真调 config.baseURL） */
  llm?: LlmClient;
}

export interface ReplayRunResult {
  /** 新 fork run 的 id（文件位于 outDir/<id>.jsonl） */
  id: string;
}

/** 生成 fork run id（时间戳 + 随机后缀，防同毫秒碰撞） */
function newForkRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 父链最大 span 序号：fork run 的 span 从其后延续编号。
 * resolveBranch 扁平拼接父前缀 + 本 run 新增 span，若 fork run 从 s_01 重计，
 * 展开轨迹会出现重复 id；再分叉时叶优先按 id 查找会命中祖先同名 span。
 * 真实 runLoop 产出的 span id 恒为 s_NN，故取数字后缀最大值即可。
 */
function maxSpanSeq(records: RunRecord[]): number {
  let max = 0;
  for (const record of records) {
    for (const span of record.spans) {
      const m = /^s_(\d+)$/.exec(span.id);
      if (m !== null) {
        max = Math.max(max, Number(m[1]));
      }
    }
  }
  return max;
}

export async function replayRun(options: ReplayRunOptions): Promise<ReplayRunResult> {
  const { parentId, atSpanId, edit, config, tools, load, outDir, llm } = options;

  // 0. 工具表与 config 必须一致（runLoop 的不变量，提前暴露避免半文件）
  if (config.tools.length !== tools.length) {
    throw new Error("config.tools 与 tools（含 handler）数量不一致，无法重跑");
  }

  // 1. 加载父链（根→叶），沿 parent 走；环检测
  const records: RunRecord[] = [];
  const seen = new Set<string>();
  let current: string | null = parentId;
  while (current !== null) {
    if (seen.has(current)) {
      throw new Error(`parent 链成环：${current}`);
    }
    seen.add(current);
    let record: RunRecord;
    try {
      record = load(current);
    } catch (e) {
      throw new Error(`父 run 文件缺失或无法读取：${current}（${(e as Error).message}）`, {
        cause: e,
      });
    }
    records.unshift(record);
    current = record.meta.parent;
  }
  const leaf = records[records.length - 1];
  if (leaf === undefined) {
    throw new Error(`父 run 加载失败：${parentId}`);
  }

  // 2. 父 run 必须已封存（crashed 缺终止事件，前缀不稳定，禁止分叉）
  assertForkable(leaf);

  // 3. config_hash 一致性（D3：编排层校验；runLoop 信任注入）
  const hash = configHash(config.systemPrompt, config.tools);
  if (hash !== leaf.meta.config_hash) {
    throw new Error(
      `config_hash 不一致：本次 ${hash} ≠ 父 run ${leaf.meta.id} 的 ${leaf.meta.config_hash}。换源码（system prompt / 工具表）属于新实验而非时间旅行，拒绝伪装成分支`,
    );
  }

  // 4. 派生起点状态：纯数据变换，分叉点之前零 LLM 调用（截断拼接而非重放）
  const state = deriveReplayState({ records, atSpanId, edit });

  // 5. 落盘 fork run 并重跑（之后步骤真实执行；错误按既有语义流入 trace）
  const id = newForkRunId();
  // span 从父链最大序号之后延续编号：fork run 只记录新增 span（copy-on-write），
  // resolveBranch 扁平拼接后 id 不冲突，链式再分叉叶优先查找也不误中祖先
  const tracer = new JsonlTracer(join(outDir, `${id}.jsonl`), {
    spanSeqStart: maxSpanSeq(records),
  });
  const forkRun: ForkRunMeta = { id, parent: parentId, fork: state.fork };
  await runLoop(
    config,
    state.messages,
    tracer,
    tools,
    llm ?? new OpenAiCompatClient(config),
    forkRun,
  );
  return { id };
}
