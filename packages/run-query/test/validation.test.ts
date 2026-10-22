import { TraceReadError } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { classifyLineageDiagnostic, classifyReadFailure } from "../src/read/errors";
import {
  MAX_LOGICAL_PATH_INPUT_LENGTH,
  MAX_RUN_ID_LENGTH,
  MAX_SPAN_ID_LENGTH,
  findIllegalExternalRunIdViolation,
  findIllegalLogicalPathViolation,
  findIllegalRunIdViolation,
  findIllegalSpanIdViolation,
  findRunIdentityViolation,
} from "../src/read/validation";

describe("run-query 输入安全校验", () => {
  it("run id：旧 IPC 路径形状保持，超长仅由外部校验拒绝", () => {
    expect(findIllegalRunIdViolation("run_mf3k2z_1")).toBeNull();
    expect(findIllegalRunIdViolation("")).not.toBeNull();
    expect(findIllegalRunIdViolation("a".repeat(MAX_RUN_ID_LENGTH + 1))).toBeNull();
    expect(findIllegalExternalRunIdViolation("a".repeat(MAX_RUN_ID_LENGTH + 1))).toContain("200");
    expect(findIllegalExternalRunIdViolation("run_ok")).toBeNull();
    expect(findIllegalRunIdViolation("../escape")).not.toBeNull();
    expect(findIllegalRunIdViolation("a/b")).not.toBeNull();
    expect(findIllegalRunIdViolation("a\\b")).not.toBeNull();
    expect(findIllegalRunIdViolation("C:\\temp\\x")).not.toBeNull();
    expect(findIllegalRunIdViolation("C:relative")).not.toBeNull();
    expect(findIllegalRunIdViolation("a\0b")).not.toBeNull();
  });

  it("span id：限制长度与 NUL，不虚构字符集", () => {
    expect(findIllegalSpanIdViolation("s_01")).toBeNull();
    expect(findIllegalSpanIdViolation("")).not.toBeNull();
    expect(findIllegalSpanIdViolation("s".repeat(MAX_SPAN_ID_LENGTH + 1))).toContain("128");
    expect(findIllegalSpanIdViolation("s\0x")).not.toBeNull();
  });

  it("身份：文件名/请求 id 必须等于 meta.id", () => {
    expect(findRunIdentityViolation("r_1", "r_1")).toBeNull();
    const violation = findRunIdentityViolation("r_file", "r_meta");
    expect(violation).toContain("r_file");
    expect(violation).toContain("r_meta");
  });

  it("逻辑路径：输入上限/空值/NUL + trace-sdk 语义规则", () => {
    expect(findIllegalLogicalPathViolation("src/index.ts")).toBeNull();
    expect(findIllegalLogicalPathViolation("")).not.toBeNull();
    expect(
      findIllegalLogicalPathViolation("a".repeat(MAX_LOGICAL_PATH_INPUT_LENGTH + 1)),
    ).toContain("4096");
    expect(findIllegalLogicalPathViolation("a\0b")).not.toBeNull();
    expect(findIllegalLogicalPathViolation("C:/host.txt")).not.toBeNull();
    expect(findIllegalLogicalPathViolation("../outside.txt")).not.toBeNull();
  });
});

describe("run-query 结构化错误分类", () => {
  it("lineage 诊断映射为稳定码，缺失诊断不冒充缺失", () => {
    expect(classifyLineageDiagnostic(null)).toBe("RUN_INVALID");
    expect(classifyLineageDiagnostic("CURRENT_RUN_NOT_FOUND")).toBe("RUN_NOT_FOUND");
    expect(classifyLineageDiagnostic("ANCESTOR_INVALID")).toBe("ANCESTOR_INVALID");
    expect(classifyLineageDiagnostic("ANCESTOR_UNREADABLE")).toBe("ANCESTOR_UNREADABLE");
    expect(classifyLineageDiagnostic("LINEAGE_CYCLE")).toBe("LINEAGE_CYCLE");
    expect(classifyLineageDiagnostic("FORK_INVALID")).toBe("FORK_INVALID");
    expect(classifyLineageDiagnostic("ANCESTOR_NOT_FOUND")).toBe("RUN_INVALID");
  });

  it("读取异常按结构分类，不比较中文文本", () => {
    expect(classifyReadFailure(new TraceReadError("任意中文"))).toBe("RUN_INVALID");
    expect(classifyReadFailure(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(
      "RUN_NOT_FOUND",
    );
    expect(classifyReadFailure(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(
      "STORAGE_IO",
    );
    expect(classifyReadFailure(new Error("任意中文"))).toBe("STORAGE_IO");
  });
});
