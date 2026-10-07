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

/**
 * 失败调用的结构化诊断（可选；与 trace-format 的 `llm.call.error` 同构）。
 *
 * 纪律（delta「每个请求录制为一个 run」）：
 * - `message` 已在**包层**脱敏并限长（非空），只含受控文本；
 * - `status` **仅在真的拿到上游状态码时**写。fetch 连接异常时省略该字段——
 *   代理本地产生的 502 不是上游状态码，写上去等于伪造事实；
 * - 不存 headers / 完整错误体 / stack / 异常对象 / upstream 地址。
 */
export interface ProxyRecordingError {
  message: string;
  status?: number;
}

/** 录制结果。outcome：
 *  - completed：upstream 成功且客户端完整送达
 *  - error：upstream 非 2xx 或连接失败（`response` 为失败空占位，顶层 `error` 表达诊断）
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
  /** 失败诊断；成功录制省略（缺省 ≠ 成功，见 trace-format 同名注释） */
  error?: ProxyRecordingError;
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
