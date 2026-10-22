import * as runQuerySchema from "@rebaseagent/run-query/schema";
import { describe, expect, it } from "vitest";
import * as desktopIpc from "../src/shared/ipc";
import { findRunDetailIntegrityViolation as desktopIntegrity } from "../src/shared/run-detail-integrity";

/**
 * 2.1：旧 IPC 出口与包层必须是**同一个对象**，不是复制出来的第二份 schema。
 * 形状/校验消息的逐字一致性由包内测试与既有 desktop 回归继续覆盖。
 */
describe("desktop 旧出口与 run-query 包层同源", () => {
  it("领域 schema 对象同一", () => {
    expect(desktopIpc.RunSummarySchema).toBe(runQuerySchema.RunSummarySchema);
    expect(desktopIpc.FailedFileSchema).toBe(runQuerySchema.FailedFileSchema);
    expect(desktopIpc.ListRunsDataSchema).toBe(runQuerySchema.ListRunsDataSchema);
    expect(desktopIpc.ChainHopSchema).toBe(runQuerySchema.ChainHopSchema);
    expect(desktopIpc.RunLineageSchema).toBe(runQuerySchema.RunLineageSchema);
    expect(desktopIpc.RunDetailSchema).toBe(runQuerySchema.RunDetailSchema);
    expect(desktopIpc.CompareRunsRequestSchema).toBe(runQuerySchema.CompareRunsRequestSchema);
    expect(desktopIpc.CompareRunItemSchema).toBe(runQuerySchema.CompareRunItemSchema);
    expect(desktopIpc.CompareRunsResultSchema).toBe(runQuerySchema.CompareRunsResultSchema);
    expect(desktopIpc.WorkspaceInspectRequestSchema).toBe(
      runQuerySchema.WorkspaceInspectRequestSchema,
    );
    expect(desktopIpc.WorkspaceInspectFileSchema).toBe(runQuerySchema.WorkspaceInspectFileSchema);
    expect(desktopIpc.WorkspaceInspectResultSchema).toBe(
      runQuerySchema.WorkspaceInspectResultSchema,
    );
    expect(desktopIpc.WorkspaceReadFileRequestSchema).toBe(
      runQuerySchema.WorkspaceReadFileRequestSchema,
    );
    expect(desktopIpc.WorkspaceReadFileResultSchema).toBe(
      runQuerySchema.WorkspaceReadFileResultSchema,
    );
  });

  it("比较常量与完整性判据同源", () => {
    expect(desktopIpc.COMPARE_RUN_MIN).toBe(runQuerySchema.COMPARE_RUN_MIN);
    expect(desktopIpc.COMPARE_RUN_MAX).toBe(runQuerySchema.COMPARE_RUN_MAX);
    expect(desktopIpc.COMPARE_CODE_MAX).toBe(runQuerySchema.COMPARE_CODE_MAX);
    expect(desktopIpc.COMPARE_REASON_MAX).toBe(runQuerySchema.COMPARE_REASON_MAX);
    expect(desktopIntegrity).toBe(runQuerySchema.findRunDetailIntegrityViolation);
  });

  it("桌面响应错配守卫继续消费包层比较结果", () => {
    const result = runQuerySchema.CompareRunsResultSchema.parse({
      items: [
        { status: "unavailable", runId: "r_a", code: "RUN_INVALID", reason: "损坏" },
        { status: "unavailable", runId: "r_b", code: "ANCESTOR_UNREADABLE", reason: "不可读" },
      ],
    });
    expect(desktopIpc.findCompareResponseMismatch(["r_a", "r_b"], result)).toBeNull();
    expect(desktopIpc.findCompareResponseMismatch(["r_b", "r_a"], result)).toContain(
      "身份与请求不符",
    );
  });
});
