/**
 * llm-proxy 的纯数据契约（零 trace-sdk 依赖，保持包独立）。
 * 字段与 trace 格式对齐，由桌面端 recorder 映射进 run.meta / llm.call span。
 */

/** 录制来源（与 trace-sdk SourceSchema 同构） */
export interface ProxySource {
  kind: "proxy";
  /** 代理自身监听地址（用户在自己应用里填的那个 base_url），非 upstream */
  base_url: string;
}

/** 录制的请求快照（与 trace 格式 llm.call.request 同构；不含任何请求头） */
export interface ProxyRequestSnapshot {
  model: string;
  messages: Record<string, unknown>[];
  tools: Record<string, unknown>[] | undefined;
  /** 请求体顶层除 model/messages/tools/stream 外的采样参数平铺 */
  params: Record<string, unknown> | undefined;
}

/** 录制的响应快照（与 trace 格式 llm.call.response 同构） */
export interface ProxyResponseSnapshot {
  content: string | null;
  reasoning_content: string | null;
  tool_calls: Record<string, unknown>[];
  usage: { in: number; out: number };
  ttft_ms: number;
}

/** 录制结果。outcome：
 *  - completed：upstream 成功且客户端完整送达
 *  - error：upstream 非 2xx（response 为 null，不写 llm.call span）
 *  - crashed：流式转发中客户端断连 / 流异常（response 尽力聚合，可能截断） */
export interface ProxyRecording {
  meta: {
    task: "(llm-proxy)";
    model: string;
    source: ProxySource;
  };
  /** 请求到达时刻（ISO 8601）——供落盘器写 span timing */
  started_at: string;
  request: ProxyRequestSnapshot;
  response: ProxyResponseSnapshot | null;
  outcome: "completed" | "error" | "crashed";
}

/** 代理分叉元数据（desktop 写 run.meta 的 parent/fork 用） */
export interface ProxyForkMeta {
  /** 源 run id */
  parent: string;
  /** 源 llm.call span id */
  atSpan: string;
  /** 编辑后 messages（fork.edit.value） */
  editValue: Record<string, unknown>[];
}

/** 录制器由桌面端注入（llm-proxy 本身零 fs） */
export interface ProxyRecorder {
  record(recording: ProxyRecording, fork?: ProxyForkMeta): void | Promise<void>;
}

/** key 仅内存暂存（desktop main 注入同一实例；永不持久化） */
export interface ProxyKeyStore {
  lastKey?: string;
}

/** 代理收到的请求上下文（服务壳从 node:http 收集） */
export interface ProxyRequestContext {
  method: string;
  /** 如 "/v1/chat/completions" */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** 原始请求体字节（原样转发，保证逐字节保真） */
  rawBody: Buffer;
}
