import { renderToolError } from "@rebaseagent/agent-loop";
import type { Message, ToolCall } from "@rebaseagent/agent-loop";
import type { RunRecord, ToolInvokeSpan } from "@rebaseagent/trace-sdk";
import type { Fork } from "@rebaseagent/trace-sdk";

/**
 * 分叉状态派生（时间旅行的纯函数内核，零副作用、零网络）。
 *
 * 核心洞察：前缀零 API 不需要"重放"，而是"截断 + 拼接"——
 * 取分叉点之后首次 llm.call 的录制 request.messages（录制自 loop 自身、
 * 原样可作 loop 输入），把被编辑 tool.invoke 对应的 tool 消息 content 替换为
 * 新值，即得"如果当时工具返回了 X，模型下一步会看到什么"的完整上下文。
 *
 * 唯一数据来源是父 run（含祖先链）的解析记录；不加载文件、不发任何请求。
 */

/** MVP 只开放编辑 tool.invoke 的 result 字段（改 prompt / llm.call 属 v2） */
export interface ReplayEdit {
  field: "result";
  value: string;
}

export interface DeriveReplayStateInput {
  /** 父链记录（根→叶），叶是直接父 run；derive 不自行加载文件 */
  records: RunRecord[];
  /** 分叉点：父链某 run 中存在的 tool.invoke span id */
  atSpanId: string;
  edit: ReplayEdit;
}

/** 派生结果：可直接作为 runLoop 初始输入的消息 + fork 元数据 */
export interface DerivedReplayState {
  messages: Message[];
  fork: Fork;
}

export function deriveReplayState(input: DeriveReplayStateInput): DerivedReplayState {
  const { records, atSpanId, edit } = input;

  if (edit.field !== "result") {
    throw new Error(`仅支持编辑 tool.invoke 的 result 字段（收到 field="${String(edit.field)}"）`);
  }

  // 1. 定位 at_span：叶优先（分支 run 再分叉时，编辑落在叶子自身新增段上）
  let hit: { record: RunRecord; index: number; span: ToolInvokeSpan } | undefined;
  for (const rec of [...records].reverse()) {
    const index = rec.spans.findIndex((s) => s.id === atSpanId);
    if (index === -1) continue;
    const span = rec.spans[index];
    if (span.kind !== "tool.invoke") {
      throw new Error(`分叉点 ${atSpanId} 必须是 tool.invoke（实际为 ${span.kind}）`);
    }
    hit = { record: rec, index, span };
    break;
  }
  if (hit === undefined) {
    throw new Error(
      `分叉点 ${atSpanId} 不存在于父 run（或其祖先）的轨迹中，无法定位被编辑的工具调用`,
    );
  }
  const { record, index: atIndex, span: atSpan } = hit;

  // 2. 定位该 tool.invoke 所属 step 与 step 内 LLM 调用
  if (atSpan.parent === null) {
    throw new Error(`分叉点 ${atSpanId} 缺少父 step（tool.invoke 必须挂在一个 agent.step 下）`);
  }
  const step = record.spans.find((s) => s.id === atSpan.parent);
  if (step === undefined || step.kind !== "agent.step") {
    throw new Error(`分叉点 ${atSpanId} 的父 span ${atSpan.parent} 不是 agent.step`);
  }
  const stepLlm = record.spans.find((s) => s.parent === step.id && s.kind === "llm.call");
  if (stepLlm === undefined || stepLlm.kind !== "llm.call") {
    throw new Error(`分叉点 ${atSpanId} 所在 step 缺少 llm.call 录制，无法定位调用上下文`);
  }

  // 3. step 内 tool.invoke 按文件序（= 执行序）；次序对应 stepLlm.response.tool_calls
  const stepTools = record.spans.filter(
    (s): s is ToolInvokeSpan => s.parent === step.id && s.kind === "tool.invoke",
  );
  const toolIndex = stepTools.findIndex((s) => s.id === atSpanId);
  if (toolIndex === -1) {
    throw new Error(`内部不一致：${atSpanId} 未出现在 step ${step.id} 的工具列表中`);
  }
  const call = stepLlm.response.tool_calls[toolIndex];
  const callId = call?.id;
  if (typeof callId !== "string" || callId.length === 0) {
    throw new Error(
      `分叉点 ${atSpanId} 在 step ${step.id} 的 llm.call 中找不到对应 tool_call（第 ${toolIndex + 1} 个）`,
    );
  }

  // 4. 定位"分叉点后首次 llm.call"作为录制前缀基座
  const lookahead = record.spans.slice(atIndex + 1).find((s) => s.kind === "llm.call");

  let messages: Message[];
  if (lookahead !== undefined && lookahead.kind === "llm.call") {
    // 主路径：下一次调用已完整录制（含被编辑 tool 消息的旧值）——直接取录制
    const base = structuredClone(lookahead.request.messages) as unknown as Message[];
    const target = base.find((m) => m.role === "tool" && m.tool_call_id === callId);
    if (target === undefined) {
      throw new Error(
        `分叉点后首次 llm.call 的录制请求中找不到 tool_call_id=${callId} 的 tool 消息（文件不完整？）`,
      );
    }
    assertChanged(String(target.content ?? ""), edit.value, atSpanId);
    target.content = edit.value;
    messages = base;
  } else {
    // 边界：分叉点位于最后一步且其后无 llm.call——重建该轮 assistant + tool 消息
    messages = structuredClone(stepLlm.request.messages) as unknown as Message[];
    messages.push({
      role: "assistant",
      content: stepLlm.response.content,
      tool_calls: stepLlm.response.tool_calls as unknown as ToolCall[],
    });
    for (let j = 0; j < stepTools.length; j++) {
      const inv = stepTools[j];
      const c = stepLlm.response.tool_calls[j];
      if (c === undefined || typeof c.id !== "string") {
        throw new Error(`step ${step.id} 的 llm.call 缺少第 ${j + 1} 个 tool_call id`);
      }
      const original = inv.error === null ? String(inv.result) : renderToolError(inv.error);
      const content = inv.id === atSpanId ? edit.value : original;
      if (inv.id === atSpanId) assertChanged(original, edit.value, atSpanId);
      messages.push({ role: "tool", tool_call_id: c.id, content });
    }
  }

  return {
    messages,
    fork: { at_span: atSpanId, edit: { field: "result", value: edit.value } },
  };
}

/** 空 fork（编辑前后相同）是无效操作：模型看到的上下文没有变化 */
function assertChanged(original: string, next: string, atSpanId: string): void {
  if (original === next) {
    throw new Error(
      `空 fork 被拒绝：${atSpanId} 的 tool 结果编辑前后相同，模型上下文无变化（无意义的重跑）`,
    );
  }
}
