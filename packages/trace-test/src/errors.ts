import type { MessageKey } from "@rebaseagent/i18n";

/**
 * trace-test 的配置错误类别。
 *
 * 与「断言失败」严格区分：配置错误表示测试资产与当前代码不兼容
 * （卡带耗尽/剩余、工具表不兼容、trace 未封存、代理 run 等），
 * 对应 CLI 退出码 2；断言失败对应退出码 1。断言失败永不抛错——
 * 它是测试结果数据，不是异常。
 *
 * 错误本身只携带稳定码与有界参数，人类说明由 CLI 按启动语言翻译；
 * `detail` 是第三方/IO 的原始说明（可能含宿主路径），只在产品摘要之后
 * 作为原始详情展示，不参与 JSON 报告。
 */
export type TraceTestConfigErrorCode =
  | "TRACE_UNSEALED"
  | "TRACE_UNSEALED_PATH"
  | "STATIC_SHAPE_UNSUPPORTED"
  | "PROXY_UNSUPPORTED"
  | "MISSING_CONFIG_HASH"
  | "CASSETTE_EXHAUSTED"
  | "CASSETTE_EXHAUSTED_AT"
  | "CASSETTE_REMAINING"
  | "TOOL_CALL_OVERFLOW"
  | "TOOL_NOT_DECLARED"
  | "BASELINE_UNSEALED"
  | "DEFINITION_READ_FAILED"
  | "DEFINITION_INVALID_JSON"
  | "DEFINITION_INVALID"
  | "DIRECTORY_READ_FAILED"
  | "NO_DEFINITIONS"
  | "TRACE_READ_FAILED"
  | "CASSETTE_TOOLCALL_INVALID"
  | "CASSETTE_EMPTY"
  | "CASSETTE_MESSAGES_INVALID";

const MESSAGE_KEYS: Record<TraceTestConfigErrorCode, MessageKey> = {
  TRACE_UNSEALED: "cli.traceErrTraceUnsealed",
  TRACE_UNSEALED_PATH: "cli.traceErrTraceUnsealedPath",
  STATIC_SHAPE_UNSUPPORTED: "cli.traceErrStaticShape",
  PROXY_UNSUPPORTED: "cli.traceErrProxy",
  MISSING_CONFIG_HASH: "cli.traceErrMissingConfigHash",
  CASSETTE_EXHAUSTED: "cli.traceErrCassetteExhausted",
  CASSETTE_EXHAUSTED_AT: "cli.traceErrCassetteExhaustedAt",
  CASSETTE_REMAINING: "cli.traceErrCassetteRemaining",
  TOOL_CALL_OVERFLOW: "cli.traceErrToolOverflow",
  TOOL_NOT_DECLARED: "cli.traceErrToolNotDeclared",
  BASELINE_UNSEALED: "cli.traceErrBaselineUnsealed",
  DEFINITION_READ_FAILED: "cli.traceErrDefinitionRead",
  DEFINITION_INVALID_JSON: "cli.traceErrDefinitionJson",
  DEFINITION_INVALID: "cli.traceErrDefinitionInvalid",
  DIRECTORY_READ_FAILED: "cli.traceErrDirectoryRead",
  NO_DEFINITIONS: "cli.traceErrNoDefinitions",
  TRACE_READ_FAILED: "cli.traceErrTraceRead",
  CASSETTE_TOOLCALL_INVALID: "cli.traceErrCassetteToolCall",
  CASSETTE_EMPTY: "cli.traceErrCassetteEmpty",
  CASSETTE_MESSAGES_INVALID: "cli.traceErrCassetteMessages",
};

export type TraceTestErrorParams = Readonly<Record<string, string | number>>;

export class TraceTestConfigError extends Error {
  readonly code: TraceTestConfigErrorCode;
  readonly messageKey: MessageKey;
  readonly params: TraceTestErrorParams;
  readonly detail: string | undefined;

  constructor(code: TraceTestConfigErrorCode, params: TraceTestErrorParams = {}, detail?: string) {
    super(code);
    this.name = "TraceTestConfigError";
    this.code = code;
    this.messageKey = MESSAGE_KEYS[code];
    this.params = params;
    this.detail = detail;
  }
}
