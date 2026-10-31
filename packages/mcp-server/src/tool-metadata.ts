import type { MessageKey, Translator } from "@rebaseagent/i18n";

/**
 * MCP 对外元信息的语言投影（design §6）：工具 description、schema 字段说明与
 * initialize 信任声明按 server 实例的语言生成。
 *
 * 工具名、字段名、枚举、annotations 与只读范围不在这里改动；本模块只提供
 * “纯说明”资源键与 JSON Schema 的 description 注入。字段说明按属性名共享，
 * 由测试保证契约里的每个属性都有一份说明（不整目录豁免、不静默漏翻）。
 */

const TOOL_DESCRIPTION_KEYS: Readonly<Record<string, MessageKey>> = {
  list_runs: "mcp.toolListRuns",
  get_run: "mcp.toolGetRun",
  get_step: "mcp.toolGetStep",
  compare_runs: "mcp.toolCompareRuns",
  inspect_checkpoint: "mcp.toolInspectCheckpoint",
  read_checkpoint_file: "mcp.toolReadCheckpointFile",
  compare_checkpoint_files: "mcp.toolCompareCheckpointFiles",
  list_verifications: "mcp.toolListVerifications",
  get_verification: "mcp.toolGetVerification",
  read_verification_log: "mcp.toolReadVerificationLog",
  inspect_verification_artifacts: "mcp.toolInspectVerificationArtifacts",
  read_verification_artifact: "mcp.toolReadVerificationArtifact",
  compare_verifications: "mcp.toolCompareVerifications",
};

const FIELD_DESCRIPTION_KEYS: Readonly<Record<string, MessageKey>> = {
  status: "mcp.fieldStatus",
  query: "mcp.fieldQuery",
  cursor: "mcp.fieldCursor",
  limit: "mcp.fieldLimit",
  runId: "mcp.fieldRunId",
  spanId: "mcp.fieldSpanId",
  ownerRunId: "mcp.fieldOwnerRunId",
  section: "mcp.fieldSection",
  maxChars: "mcp.fieldMaxChars",
  stepSpanId: "mcp.fieldStepSpanId",
  path: "mcp.fieldPath",
  verificationId: "mcp.fieldVerificationId",
  outcome: "mcp.fieldOutcome",
  commandId: "mcp.fieldCommandId",
  stream: "mcp.fieldStream",
  left: "mcp.fieldLeft",
  right: "mcp.fieldRight",
};

const TRUST_KEYS: readonly MessageKey[] = [
  "mcp.trustDataRoot",
  "mcp.trustTools",
  "mcp.trustRedaction",
  "mcp.trustCost",
];

export function toolDescriptionOf(name: string, translator: Translator): string {
  const key = TOOL_DESCRIPTION_KEYS[name];
  if (key === undefined) throw new Error(`MCP tool metadata missing: ${name}`);
  return translator.t(key);
}

export function trustInstructions(translator: Translator): string {
  return TRUST_KEYS.map((key) => translator.t(key)).join("\n");
}

export function fieldDescriptionKeys(): Readonly<Record<string, MessageKey>> {
  return FIELD_DESCRIPTION_KEYS;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 深拷贝 JSON Schema，并给每个属性节点补当前语言的 description。
 * 只加说明，不改 type/required/enum/additionalProperties 等结构。
 */
export function localizeInputSchema(
  schema: Readonly<Record<string, unknown>>,
  translator: Translator,
): Record<string, unknown> {
  return localizeNode(schema, translator) as Record<string, unknown>;
}

function localizeNode(value: unknown, translator: Translator): unknown {
  if (Array.isArray(value)) return value.map((item) => localizeNode(item, translator));
  if (!isPlainRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] =
      key === "properties" && isPlainRecord(child)
        ? localizeProperties(child, translator)
        : localizeNode(child, translator);
  }
  return out;
}

function localizeProperties(
  properties: Record<string, unknown>,
  translator: Translator,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(properties)) {
    const localized = localizeNode(child, translator);
    const key = FIELD_DESCRIPTION_KEYS[name];
    out[name] =
      key === undefined || !isPlainRecord(localized)
        ? localized
        : { ...localized, description: translator.t(key) };
  }
  return out;
}
