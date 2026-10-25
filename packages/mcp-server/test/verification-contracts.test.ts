import { describe, expect, it } from "vitest";
import { VerificationOutcomeSchema } from "@rebaseagent/project-verification/schema";
import { LimitationSchema, isKnownLimitationCode } from "../src/envelope.js";
import {
  BODY_CHARS_MAX,
  CURSOR_MAX,
  LOGICAL_PATH_MAX,
  PAGE_LIMIT_MAX,
  RUN_ID_MAX,
} from "../src/limits.js";
import { TOOL_CONTRACTS, TOOL_NAMES } from "../src/tool-contracts.js";
import {
  VERIFICATION_TOOL_CONTRACTS,
  VERIFICATION_TOOL_NAMES,
} from "../src/verification-contracts.js";
import {
  VERIFICATION_ASSET_AVAILABILITIES,
  VERIFICATION_BODY_KINDS,
  VERIFICATION_COMPARE_SIDE_STATES,
  VERIFICATION_RECORD_STATUSES,
  VerificationRecordStatusSchema,
} from "../src/verification-contracts.js";
import {
  VERIFICATION_LIMITATION_CODES,
  VERIFICATION_RETRYABLE_CODES,
  VERIFICATION_TOOL_ERROR_CODES,
  VERIFICATION_TOOL_ERROR_MESSAGES,
  type VerificationToolErrorCode,
} from "../src/verification-codes.js";

/**
 * MCP2 tasks 1.2：六工具契约冻结（M01/M08 的形状半边）。
 *
 * 判据（design D2/D3）：
 * - 七工具契约与 tools/list 现状不动；六条验证契约冻结为 strict zod，
 *   注册仍按"没实现就不登记"——本文件钉的是**契约为 6、注册为 0、合集为 13**；
 * - 每个对象节点 `additionalProperties:false`，dataDir/handler 一类字段形状层即拒；
 * - status/outcome/commandId 枚举逐字来自 R3（schema 导入，不复制第二份）；
 * - 三域码表封闭：九错误码 + 七 limitation 码各有受控文案，既有四码不重定义。
 */

const VERIFICATION_EXPECTED_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  list_verifications: ["runId", "status", "outcome", "cursor", "limit"],
  get_verification: ["verificationId", "cursor", "limit"],
  read_verification_log: ["verificationId", "commandId", "stream", "cursor", "maxChars"],
  inspect_verification_artifacts: ["verificationId", "cursor", "limit"],
  read_verification_artifact: ["verificationId", "path", "cursor", "maxChars"],
  compare_verifications: ["left", "right"],
};

const VERIFICATION_EXPECTED_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  list_verifications: [],
  get_verification: ["verificationId"],
  read_verification_log: ["verificationId", "commandId", "stream"],
  inspect_verification_artifacts: ["verificationId"],
  read_verification_artifact: ["verificationId", "path"],
  compare_verifications: ["left", "right"],
};

/** 与 contracts.test.ts 同一张禁入字段表（数据根只在启动期确定；执行类输入永不在形状里） */
const FORBIDDEN_KEYS = [
  "dataDir",
  "data_dir",
  "tracesDir",
  "root",
  "rootDir",
  "baseDir",
  "cwd",
  "dir",
  "url",
  "endpoint",
  "handler",
  "command",
  "shell",
  "script",
  "sha256",
  "hash",
  "offset",
  "maxLength",
  "assetPath",
  "physicalPath",
  "apiKey",
  "token",
  "model",
  "config",
  "force",
];

interface SchemaNode {
  readonly type?: string;
  readonly properties?: Record<string, SchemaNode>;
  readonly required?: string[];
  readonly additionalProperties?: unknown;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly maximum?: number;
  readonly minimum?: number;
}

function objectNodes(schema: Readonly<Record<string, unknown>>): SchemaNode[] {
  const nodes: SchemaNode[] = [];
  const visit = (node: SchemaNode): void => {
    nodes.push(node);
    for (const child of Object.values(node.properties ?? {})) visit(child);
  };
  visit(schema as SchemaNode);
  return nodes;
}

describe("六工具契约冻结（M01/M08 形状半边，design D2）", () => {
  it("既有七工具契约原样不动，验证域恰六条，合集恰十三个且名字唯一", () => {
    expect(TOOL_CONTRACTS.map((item) => item.name)).toEqual([
      "list_runs",
      "get_run",
      "get_step",
      "compare_runs",
      "inspect_checkpoint",
      "read_checkpoint_file",
      "compare_checkpoint_files",
    ]);
    expect(VERIFICATION_TOOL_NAMES).toEqual([
      "list_verifications",
      "get_verification",
      "read_verification_log",
      "inspect_verification_artifacts",
      "read_verification_artifact",
      "compare_verifications",
    ]);
    const all = [...TOOL_NAMES, ...VERIFICATION_TOOL_NAMES];
    expect(all).toHaveLength(13);
    expect(new Set(all).size).toBe(13);
  });

  it("每条契约的属性/必填与 design D2 表逐字一致", () => {
    for (const item of VERIFICATION_TOOL_CONTRACTS) {
      const schema = item.inputSchema as SchemaNode;
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
        [...VERIFICATION_EXPECTED_PROPERTIES[item.name]].sort(),
      );
      expect([...(schema.required ?? [])].sort()).toEqual(
        [...VERIFICATION_EXPECTED_REQUIRED[item.name]].sort(),
      );
    }
  });

  it("每个对象节点 additionalProperties:false（strict），禁入字段一律不出现", () => {
    for (const item of VERIFICATION_TOOL_CONTRACTS) {
      for (const node of objectNodes(item.inputSchema)) {
        if (node.type === "object") {
          expect(node.additionalProperties, item.name).toBe(false);
        }
      }
      const propertyNames = new Set(
        objectNodes(item.inputSchema).flatMap((node) => Object.keys(node.properties ?? {})),
      );
      for (const key of FORBIDDEN_KEYS) {
        expect(propertyNames.has(key), `${item.name} 含禁入字段 ${key}`).toBe(false);
      }
    }
  });

  it("verificationId 沿 R3 形态：pattern 收窄且合法 ID 可解析、穿越形态被拒", () => {
    const schema = VERIFICATION_TOOL_CONTRACTS.find(
      (item) => item.name === "get_verification",
    )?.schema;
    expect(schema).toBeDefined();
    const parsed = schema?.parse({ verificationId: "ver_a1-b2_c3" });
    expect(parsed).toEqual({ verificationId: "ver_a1-b2_c3" });
    for (const bad of ["../escape", "UPPER", "ver/slash", ".hidden", "a".repeat(65)]) {
      expect(() => schema?.parse({ verificationId: bad })).toThrow();
    }
  });

  it("枚举逐字来自 R3：status 四值、outcome 十一值、commandId 两值", () => {
    expect(VERIFICATION_RECORD_STATUSES).toEqual([
      "sealed",
      "unterminated",
      "corrupt",
      "unsupported_version",
    ]);
    const ListArgs = VERIFICATION_TOOL_CONTRACTS.find(
      (item) => item.name === "list_verifications",
    )?.schema as unknown as { parse(args: unknown): { outcome?: string } };
    const r3OutcomeValues = VerificationOutcomeSchema.options;
    expect(r3OutcomeValues).toEqual([
      "check_failed",
      "passed",
      "environment_failed",
      "start_failed",
      "process_failed",
      "timed_out",
      "output_limit",
      "cancelled",
      "artifact_invalid",
      "evidence_incomplete",
      "unknown",
    ]);
    for (const outcome of r3OutcomeValues) {
      expect(ListArgs.parse({ outcome }).outcome).toBe(outcome);
    }
    for (const bad of ["passed_other", "", "PASSED"]) {
      expect(() => ListArgs.parse({ outcome: bad })).toThrow();
    }
  });

  it("容量上限与 MCP1 同源：分页 1–100、正文 1–8192 码点、游标/路径/runId 有界", () => {
    for (const item of VERIFICATION_TOOL_CONTRACTS) {
      for (const node of objectNodes(item.inputSchema)) {
        if (node.maximum === PAGE_LIMIT_MAX) {
          expect(node.minimum, item.name).toBe(1);
        }
        if (node.maximum === BODY_CHARS_MAX) {
          expect(node.minimum, item.name).toBe(1);
        }
        if (node.maxLength === CURSOR_MAX || node.maxLength === LOGICAL_PATH_MAX) {
          expect(node.minLength ?? node.minimum, item.name).toBeGreaterThanOrEqual(1);
        }
      }
    }
    expect(PAGE_LIMIT_MAX).toBe(100);
    expect(BODY_CHARS_MAX).toBe(8192);
    expect(RUN_ID_MAX).toBe(200);
  });

  it("未知字段一律拒：dataDir/handler/任意额外键在六工具上都是参数错误（M08 形状半边）", () => {
    const samples: readonly Record<string, unknown>[] = [
      { verificationId: "ver_x" },
      { verificationId: "ver_x", commandId: "test", stream: "stdout" },
      { verificationId: "ver_x", path: "report.json" },
      { left: { verificationId: "ver_x" }, right: { verificationId: "ver_y" } },
      { runId: "run_x" },
    ];
    for (const item of VERIFICATION_TOOL_CONTRACTS) {
      for (const sample of samples) {
        for (const extra of ["dataDir", "handler", "anythingNew"] as const) {
          const polluted = { ...sample, [extra]: "injected" };
          expect(() => item.schema.parse(polluted), `${item.name}+${extra}`).toThrow();
        }
      }
    }
  });

  it("每条契约标注只读且不外联（annotations 与七工具同表）", () => {
    for (const item of VERIFICATION_TOOL_CONTRACTS) {
      expect(item.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });
});

describe("验证域三域码表封闭（design D3）", () => {
  it("九个错误码各有受控文案；可重试只有文件级不可读", () => {
    expect(VERIFICATION_TOOL_ERROR_CODES).toHaveLength(9);
    for (const code of VERIFICATION_TOOL_ERROR_CODES) {
      expect(VERIFICATION_TOOL_ERROR_MESSAGES[code as VerificationToolErrorCode].length).toBeGreaterThan(0);
    }
    expect([...VERIFICATION_RETRYABLE_CODES]).toEqual(["VERIFICATION_UNREADABLE"]);
  });

  it("limitation 封闭表 = 既有四码 + 验证域七码，判定函数双向一致", () => {
    expect(VERIFICATION_LIMITATION_CODES).toEqual([
      "VERIFICATION_UNTERMINATED",
      "VERIFICATION_SOURCE_MISSING",
      "VERIFICATION_SOURCE_INVALID",
      "VERIFICATION_SNAPSHOT_MISMATCH",
      "VERIFICATION_ENVIRONMENT_UNKNOWN",
      "VERIFICATION_CAPTURE_TRUNCATED",
      "VERIFICATION_PREPARATION_UNAVAILABLE",
    ]);
    for (const code of [
      "TERMINATION_NOT_RECORDED",
      "ANCESTOR_NOT_FOUND",
      "BODY_NOT_EXPOSED",
      "REDACTED",
      ...VERIFICATION_LIMITATION_CODES,
    ]) {
      expect(isKnownLimitationCode(code), code).toBe(true);
      expect(() => LimitationSchema.parse({ code, message: "受限说明" })).not.toThrow();
    }
    expect(isKnownLimitationCode("NOT_A_CODE")).toBe(false);
    expect(() => LimitationSchema.parse({ code: "NOT_A_CODE", message: "x" })).toThrow();
  });

  it("数据状态枚举封闭：附件四值、正文两值、比较侧两值", () => {
    expect(VERIFICATION_ASSET_AVAILABILITIES).toEqual([
      "available",
      "missing",
      "corrupt",
      "rejected",
    ]);
    expect(VERIFICATION_BODY_KINDS).toEqual(["text", "binary"]);
    expect(VERIFICATION_COMPARE_SIDE_STATES).toEqual(["ready", "unavailable"]);
    expect(() => VerificationRecordStatusSchema.parse("sealed")).not.toThrow();
    expect(() => VerificationRecordStatusSchema.parse("running")).toThrow();
  });
});
