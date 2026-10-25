import { describe, expect, it } from "vitest";
import {
  narrowVerificationRecord,
  verificationStatusLine,
} from "../src/renderer/src/lib/verification-reading";

/**
 * R3 任务 5.3：验证记录读取的**收窄判据**（D09/P13/P16 渲染半边）。
 *
 * 判据来源（delta 场景逐字）：
 * - D09：展示当前验证的范围/截断或损坏，不混入上一条正文，不以截断视图表示完整日志；
 * - P13：保留/全观测双口径字节（截断与丢弃量本身是证据）；
 * - P15/P16：坏尾/未封存/版本不受支持如实呈现，不冒充结局。
 */

const COMMAND_END = {
  type: "command_end",
  commandId: "test",
  exitCode: 1,
  signal: null,
  durationMs: 1850,
  stdout: { byteLength: 1048576, totalBytes: 2097152, sha256: "a".repeat(64), truncated: true },
  stderr: { byteLength: 42, totalBytes: 42, sha256: "b".repeat(64), truncated: false },
  endedAt: "2026-10-25T10:00:05.000Z",
};

describe("narrowVerificationRecord（events 收窄：畸形跳过不猜）", () => {
  it("command_end 提取双口径字节与退出码；terminated 提取结局", () => {
    const view = narrowVerificationRecord([
      { type: "stage", phase: "executing", at: "2026-10-25T10:00:00.000Z" },
      COMMAND_END,
      {
        type: "terminated",
        outcome: "check_failed",
        detail: "tsc 非零退出",
        evidenceComplete: true,
        at: "2026-10-25T10:00:06.000Z",
      },
    ]);
    expect(view.eventCount).toBe(3);
    expect(view.commandEnds).toHaveLength(1);
    const entry = view.commandEnds[0];
    expect(entry?.commandId).toBe("test");
    expect(entry?.exitCode).toBe(1);
    expect(entry?.stdoutBytes).toBe(1048576);
    expect(entry?.stdoutTotalBytes).toBe(2097152);
    expect(entry?.stdoutTruncated).toBe(true);
    expect(entry?.stderrTruncated).toBe(false);
    expect(view.terminated).toBe(true);
    expect(view.outcome).toBe("check_failed");
    expect(view.detail).toBe("tsc 非零退出");
    expect(view.stages).toEqual(["executing"]);
  });

  it("畸形事件整条跳过（未知命令/缺流字段/非对象），合法事件仍保留而不抛错", () => {
    const view = narrowVerificationRecord([
      null,
      "junk",
      { type: "command_end", commandId: "rm -rf", stdout: {}, stderr: {} },
      {
        type: "command_end",
        commandId: "test",
        stdout: { byteLength: 1, totalBytes: 1, truncated: false },
        stderr: { byteLength: 1, totalBytes: 1, truncated: false },
      },
      { type: "terminated", outcome: 42, detail: null },
    ]);
    expect(view.commandEnds).toHaveLength(1);
    expect(view.commandEnds[0]?.commandId).toBe("test");
    expect(view.terminated).toBe(false);
    expect(view.outcome).toBeNull();
    expect(view.eventCount).toBe(5);
  });

  it("空记录 ⇒ 零条目、无结局（未封存不冒充）", () => {
    const view = narrowVerificationRecord([]);
    expect(view.eventCount).toBe(0);
    expect(view.commandEnds).toHaveLength(0);
    expect(view.terminated).toBe(false);
    expect(view.outcome).toBeNull();
  });
});

describe("verificationStatusLine（记录状态的可读名，P15/D09）", () => {
  it("封存/未封存/损坏（带坏尾行号）/版本不受支持各说各话", () => {
    expect(verificationStatusLine("sealed", null)).toContain("已封存");
    expect(verificationStatusLine("unterminated", null)).toContain("不呈现结局");
    const corrupt = verificationStatusLine("corrupt", {
      lineIndex: 4,
      reason: "JSON 解析失败",
    });
    expect(corrupt).toContain("第 5 行");
    expect(corrupt).toContain("不能当作通过或失败");
    expect(verificationStatusLine("unsupported_version", null)).toContain("版本不受支持");
  });
});
