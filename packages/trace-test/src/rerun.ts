import {
  type RunConfig,
  type RunResult,
  type Tool,
  configHash,
  runLoop,
} from "@rebaseagent/agent-loop";
import { MemoryTracer, type RunRecord } from "@rebaseagent/trace-sdk";
import { CassetteLlmClient, type RequestDrift, extractCassette } from "./cassette-llm-client.js";
import { TraceTestConfigError } from "./errors.js";
import type { ShapeAlignment } from "./shape-align.js";
import { alignShape } from "./shape-align.js";
import { StubToolTable } from "./stub-tools.js";
import type { ArgsDrift } from "./stub-tools.js";

/** 配置 hash 漂移（只报告，不阻断——测试路径不复用 replay 的同源门禁） */
export interface ConfigDrift {
  recorded: string;
  current: string;
}

export interface RerunOptions {
  /** 录制基线（已封存的 trace run） */
  record: RunRecord;
  /** 当前配置：systemPrompt + 工具表驱动 config hash 与请求体构造 */
  config: RunConfig;
  /** 当前工具声明（含 handler；handler 会被桩替换，绝不执行真实工具） */
  tools: Tool[];
}

export interface RerunResult {
  /** 重跑新产生的轨迹（MemoryTracer 快照，语义序） */
  record: RunRecord;
  /** runLoop 返回值（messages 演化 + 终止事件） */
  run: RunResult;
  /** LLM 请求结构漂移明细（只记录，不改变通过与否） */
  requestDrift: RequestDrift[];
  /** 配置 hash 漂移（只记录，不改变通过与否；null = 同源） */
  configDrift: ConfigDrift | null;
  /** 工具参数形状漂移明细（只记录） */
  argsDrift: ArgsDrift[];
  /** 结构性轨迹对齐结果 */
  alignment: ShapeAlignment;
}

/**
 * 卡带重跑编排（trace-test 的执行内核）：
 *
 * 1. 校验基线：已封存、非代理录制、有 config_hash（有 loop 配置的证据）；
 * 2. 初始 messages = 首个 llm.call 的 request.messages（含录制 system，VCR 语义）；
 * 3. 卡带 LlmClient 按调用序消费录制响应；桩工具按 (tool 名, 调用序号) 返回录制结果；
 * 4. 用当前 runLoop + MemoryTracer headless 执行——无 Electron、无网络、无文件落盘；
 * 5. 对新轨迹做结构对齐，汇总全部漂移明细。
 *
 * 配置漂移与请求漂移不影响执行与通过判定（三审钉死：drift 不改退出码，
 * 报告层负责把「建议重录基线」的出路讲清楚）；只有资产不兼容类问题
 * （未封存 / 代理 run / 工具表缺失 / 卡带耗尽或剩余 / 调用次数超录制）抛配置错误。
 */
export async function rerunWithCassette(options: RerunOptions): Promise<RerunResult> {
  const { record, config, tools } = options;

  if (record.status !== "completed") {
    throw new TraceTestConfigError(
      "录制 trace 未封存（缺少终止事件），不可作为卡带基线。请使用完整结束的 run。",
    );
  }
  if (record.meta.source?.kind === "proxy") {
    throw new TraceTestConfigError(
      "代理录制的 run（meta.source.kind=proxy）没有完整的 loop 配置与多轮轨迹，" +
        "不支持卡带重跑——单次响应回放不构成运行时回归测试。仅允许显式静态断言。",
    );
  }
  if (record.meta.config_hash === undefined) {
    throw new TraceTestConfigError(
      "录制 trace 缺少 config_hash（无 loop 配置证据），不支持卡带重跑。仅允许显式静态断言。",
    );
  }

  const { llmSpans, initialMessages } = extractCassette(record);
  const stubs = new StubToolTable(tools, record);
  const cassette = new CassetteLlmClient(llmSpans, config);

  const configDrift: ConfigDrift | null =
    record.meta.config_hash === configHash(config.systemPrompt, config.tools)
      ? null
      : {
          recorded: record.meta.config_hash,
          current: configHash(config.systemPrompt, config.tools),
        };

  const tracer = new MemoryTracer();
  // runLoop 的 config.tools 必须与 tools 数量一致：桩工具表 1:1 包装当前工具声明，恒成立
  const run = await runLoop(config, initialMessages, tracer, stubs.tools, cassette);

  if (cassette.exhausted) {
    throw new TraceTestConfigError(
      "卡带耗尽：当前代码的 LLM 调用次数多于录制。" +
        "若属预期的行为变化，请重录基线；否则检查循环终止条件是否被改坏。",
    );
  }
  if (cassette.remaining > 0) {
    throw new TraceTestConfigError(
      `卡带有剩余：录制 ${cassette.total} 次 LLM 调用，重跑只消费 ${cassette.consumed} 次（当前 run 提前终止）。若属预期的行为变化，请重录基线。`,
    );
  }
  if (stubs.overflows.length > 0) {
    throw new TraceTestConfigError(
      `工具调用次数超出录制：${stubs.overflows.map((n) => `"${n}"`).join("、")}。请重录基线。`,
    );
  }

  const newRecord = tracer.snapshot();
  return {
    record: newRecord,
    run,
    requestDrift: [...cassette.requestDrift],
    configDrift,
    argsDrift: stubs.argsDrift,
    alignment: alignShape(record, newRecord),
  };
}
