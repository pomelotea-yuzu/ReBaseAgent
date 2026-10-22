import { RunDetailReadError } from "@rebaseagent/run-query";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ErrorEnvelopeSchema,
  LimitationSchema,
  ProvenanceRefSchema,
  ProvenanceRunSchema,
  SuccessEnvelopeSchema,
  boundedHeadline,
  buildErrorEnvelope,
  buildSuccessEnvelope,
  isKnownLimitationCode,
} from "../src/envelope.js";
import {
  TOOL_ERROR_MESSAGES,
  isKnownToolErrorCode,
  projectArgumentError,
  projectThrowable,
  retryableOf,
} from "../src/error-projection.js";
import { CONTENT_HEADLINE_MAX, MESSAGE_MAX } from "../src/limits.js";
import { QUERY_API_VERSION } from "../src/server.js";

/**
 * MCP0 4.2（S05/S06）：结果信封与错误投影。
 *
 * 判据（design D4）：
 * - 成功信封带 `apiVersion/observedAt/readVersion/provenance/limitations/truncation`，
 *   缺项以 `null` + limitation 表达，不补造；
 * - 失败信封只有稳定码 + 受控文案 + 重试属性；**物理路径、原始异常文本、堆栈
 *   到不了这一层**——文案取自码表，不取自异常；
 * - limitation 码封闭为四项，实现自行造码会被挡住。
 */

const RUN = {
  runId: "run-1",
  formatVersion: 2,
  sealed: true,
  lineage: "complete",
  spanScope: "resolved",
} as const;

describe("成功信封", () => {
  it("带版本、观测时点、读取版本与来源；未给 nextCursor 时不编造分页", () => {
    const envelope = buildSuccessEnvelope({
      data: { runs: [] },
      readVersion: "rv:abc",
      runs: [RUN],
      refs: [{ runId: "run-1", snapshotId: "a".repeat(64) }],
      limitations: [{ code: "ANCESTOR_NOT_FOUND", ref: "run:run-2", message: "祖先文件缺失" }],
      observedAt: "2026-10-22T00:00:00.000Z",
    });
    expect(SuccessEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.apiVersion).toBe(QUERY_API_VERSION);
    expect(envelope.ok).toBe(true);
    expect(envelope.observedAt).toBe("2026-10-22T00:00:00.000Z");
    expect(envelope.readVersion).toBe("rv:abc");
    expect(envelope.provenance.runs).toEqual([RUN]);
    expect(envelope.provenance.refs).toHaveLength(1);
    expect(envelope.limitations).toHaveLength(1);
    expect(envelope.page).toBeUndefined();
    expect(envelope.truncation).toEqual({ truncated: false });
  });

  /**
   * 4.3 的改判（留痕）：`list_runs` 只扫各自文件、没读父链，来源段必须能表达
   * 「这一项本次未判定」。4.2 把 `lineage/spanScope` 写成必填，实现只能二选一——
   * 要么补一个没查过的 `complete`（把未知写成可信事实，违反 D4），要么整批失败。
   * 现在它们可选，且**省略不会被自动补成 complete**；给了就必须是真实判定。
   */
  it("来源段的完整性字段可缺省=未判定，缺省不自动补成可信事实", () => {
    const envelope = buildSuccessEnvelope({
      data: { runs: [] },
      readVersion: "rv:abc",
      runs: [{ runId: "run-1", formatVersion: 1, sealed: false }],
      observedAt: "2026-10-22T00:00:00.000Z",
    });
    expect(envelope.provenance.runs).toEqual([{ runId: "run-1", formatVersion: 1, sealed: false }]);
    expect(
      ProvenanceRunSchema.safeParse({ runId: "r", formatVersion: 1, sealed: true }).success,
    ).toBe(true);
    expect(
      ProvenanceRunSchema.safeParse({
        runId: "r",
        formatVersion: 1,
        sealed: true,
        lineage: "partial",
      }).success,
    ).toBe(false);
  });

  it("nextCursor 同时驱动 page 与 truncation（两处不一致就是谎报）", () => {
    const envelope = buildSuccessEnvelope({
      data: {},
      readVersion: "rv:1",
      runs: [RUN],
      nextCursor: "c".repeat(8),
      observedAt: "2026-10-22T00:00:00.000Z",
    });
    expect(envelope.page).toEqual({ nextCursor: "c".repeat(8) });
    expect(envelope.truncation).toEqual({ truncated: true, nextCursor: "c".repeat(8) });
  });

  it("形状不合宁可不发：多余顶层键与空 readVersion 都被自检挡住", () => {
    expect(() =>
      buildSuccessEnvelope({
        data: {},
        readVersion: "rv:1",
        runs: [{ ...RUN, extra: 1 } as never],
      }),
    ).toThrow();
    expect(() => buildSuccessEnvelope({ data: {}, readVersion: "", runs: [RUN] })).toThrow();
  });

  it("ref 只允许清单内形状：snapshotId 必须 64 位十六进制", () => {
    expect(ProvenanceRefSchema.safeParse({ runId: "run-1", snapshotId: "nope" }).success).toBe(
      false,
    );
    expect(ProvenanceRefSchema.safeParse({ runId: "run-1", spanId: "s".repeat(129) }).success).toBe(
      false,
    );
    expect(ProvenanceRefSchema.safeParse({ snapshotId: "a".repeat(64) }).success).toBe(false);
  });

  it("limitation 码封闭：新码必须先改设计文档，实现不得自造", () => {
    expect(LimitationSchema.safeParse({ code: "REDACTED", message: "已过滤" }).success).toBe(true);
    expect(
      LimitationSchema.safeParse({ code: "BODY_NOT_EXPOSED", message: "正文不外发" }).success,
    ).toBe(true);
    expect(LimitationSchema.safeParse({ code: "SOMETHING_NEW", message: "自造码" }).success).toBe(
      false,
    );
    expect(isKnownLimitationCode("TERMINATION_NOT_RECORDED")).toBe(true);
    expect(isKnownLimitationCode("SOMETHING_NEW")).toBe(false);
  });
});

describe("失败信封与错误投影（S06）", () => {
  it("每个稳定码都有受控文案，且都不含路径形态", () => {
    const codes = [
      "INVALID_ARGUMENT",
      "RUN_NOT_FOUND",
      "RUN_INVALID",
      "UNSUPPORTED_TRACE_VERSION",
      "IDENTITY_MISMATCH",
      "ANCESTOR_INVALID",
      "ANCESTOR_UNREADABLE",
      "LINEAGE_CYCLE",
      "FORK_INVALID",
      "STEP_NOT_FOUND",
      "SPAN_AMBIGUOUS",
      "NO_WORKSPACE",
      "CHECKPOINT_NOT_FOUND",
      "STORAGE_IO",
      "STALE_CURSOR",
      "RESPONSE_LIMIT",
    ] as const;
    expect(Object.keys(TOOL_ERROR_MESSAGES).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const message = TOOL_ERROR_MESSAGES[code];
      expect(message.length).toBeGreaterThan(0);
      expect(message.length).toBeLessThanOrEqual(MESSAGE_MAX);
      expect(message).not.toMatch(/[\\/]/);
      expect(isKnownToolErrorCode(code)).toBe(true);
    }
    expect(isKnownToolErrorCode("INTERNAL_BLOWUP")).toBe(false);
  });

  it("retryable 只给换个时点重试有意义的码", () => {
    expect(retryableOf("STORAGE_IO")).toBe(true);
    expect(retryableOf("STALE_CURSOR")).toBe(true);
    expect(retryableOf("RUN_NOT_FOUND")).toBe(false);
    expect(retryableOf("INVALID_ARGUMENT")).toBe(false);
    expect(retryableOf("ANCESTOR_INVALID")).toBe(false);
  });

  it("异常文本与堆栈不进结果：物理路径被码表文案替换", () => {
    const leaky = new Error("无法读取 D:\\secret\\traces\\run-1.jsonl: EPERM");
    leaky.stack = `${leaky.stack}\nat 秘密目录 C:\\Users\\someone\\.rebaseagent`;
    const projected = projectThrowable(leaky);
    expect(projected.code).toBe("STORAGE_IO");
    expect(projected.message).toBe(TOOL_ERROR_MESSAGES.STORAGE_IO);
    const envelope = buildErrorEnvelope({ ...projected });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("EPERM");
    expect(serialized).not.toContain("Users");
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.ok).toBe(false);
  });

  it("ENOENT 判 RUN_NOT_FOUND，不判成存储错误", () => {
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    expect(projectThrowable(enoent).code).toBe("RUN_NOT_FOUND");
  });

  it("共享层读取错误按结构映射稳定码，中文原因本身不外发", () => {
    const detail = new RunDetailReadError(
      "ANCESTOR_INVALID",
      "祖先 run run-0 的记录无法校验：D:\\data\\traces\\run-0.jsonl",
    );
    const projected = projectThrowable(detail);
    expect(projected.code).toBe("ANCESTOR_INVALID");
    expect(projected.message).toBe(TOOL_ERROR_MESSAGES.ANCESTOR_INVALID);
    expect(projected.retryable).toBe(false);
  });

  it("参数校验投影：只给字段与规则名，不给取值也不给 zod 原文", () => {
    const schema = z.object({ runId: z.string().min(1).max(200) }).strict();
    const parsed = schema.safeParse({ runId: "x".repeat(300), dataDir: "D:/secret" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const projected = projectArgumentError(parsed.error.issues);
    expect(projected.code).toBe("INVALID_ARGUMENT");
    expect(projected.message).toContain("runId");
    expect(projected.message).not.toContain("x".repeat(30));
    expect(projected.message).not.toContain("D:/secret");
    expect(projected.message).not.toContain("dataDir");
    expect(projected.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
  });

  it("失败信封带定位 ref 时仍受控，且 message 有界", () => {
    const envelope = buildErrorEnvelope({
      code: "SPAN_AMBIGUOUS",
      message: TOOL_ERROR_MESSAGES.SPAN_AMBIGUOUS,
      ref: "span:s_01 owners:2",
      retryable: false,
    });
    expect(envelope.error.ref).toBe("span:s_01 owners:2");
    expect(() =>
      buildErrorEnvelope({
        code: "RUN_INVALID",
        message: "m".repeat(MESSAGE_MAX + 1),
        retryable: false,
      }),
    ).toThrow();
  });
});

describe("简述文案有界", () => {
  it("按码点截断（中文不被拆坏）", () => {
    const text = "检".repeat(CONTENT_HEADLINE_MAX + 50);
    const bounded = boundedHeadline(text);
    expect([...bounded].length).toBe(CONTENT_HEADLINE_MAX + 1);
    expect(bounded.endsWith("…")).toBe(true);
  });
});
