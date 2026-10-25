import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RESPONSE_BUDGET_BYTES } from "../src/limits.js";
import { toolResultBytes } from "../src/budget.js";
import type { DataRoot } from "../src/startup.js";
import { getVerificationTool } from "../src/query/get-verification.js";
import { inspectVerificationArtifactsTool } from "../src/query/inspect-verification-artifacts.js";
import { listVerificationsTool } from "../src/query/list-verifications.js";
import { readVerificationLogTool } from "../src/query/read-verification-log.js";
import {
  VERIFICATION_SENTINELS,
  buildVerificationFixture,
  cleanupVerificationFixtures,
  VERIFICATION_FIXTURE_IDS as ids,
  type VerificationFixture,
} from "./verification-fixtures.js";

/**
 * MCP2 tasks 4.2：64 KiB 完整结果预算（M10/M13）。
 *
 * - 量的是客户端实收（content+structuredContent+isError，UTF-8 字节）；
 * - 条目/码点单旋钮收窄；正文单次承载（bodyIn 指针 + content 本体）；
 * - 最小单项仍超限 ⇒ RESPONSE_LIMIT + 稳定定位，不发超限信封、不删身份假称完整。
 */

const fixture: VerificationFixture = buildVerificationFixture();

// 超大单项记录：argv 单串 ~70 KiB ⇒ commands 投影在任何页宽下都装不下
const giantId = "ver-m2-giant";
{
  const { VerificationRecordWriter } = await import("@rebaseagent/project-verification");
  const w = VerificationRecordWriter.open(fixture.dataRoot, {
    verificationId: giantId,
    epoch: "ep_giant",
    operationId: "op_giant",
    target: { runId: "run-giant", checkpoint: { kind: "initial" }, snapshotId: "snap-giant" },
    profileId: "node-ts-v1",
    manifestVersion: 1,
    commandId: "test",
    planBindingDigest: "a".repeat(64),
    createdAt: "2026-10-25T02:00:00.000Z",
  });
  w.append({
    type: "command_start",
    commandId: "test",
    executable: "node",
    argv: ["node", "--flag", "x".repeat(70_000)],
    cwd: "/workspace",
    startedAt: "t",
  });
  w.append({
    type: "command_end",
    commandId: "test",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout: {
      byteLength: 1,
      totalBytes: 1,
      sha256: "0".repeat(64),
      truncated: false,
    },
    stderr: {
      byteLength: 0,
      totalBytes: 0,
      sha256: "1".repeat(64),
      truncated: false,
    },
    endedAt: "t",
  });
  w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
}

afterAll(() => {
  cleanupVerificationFixtures();
});

const root: DataRoot = { dataDir: fixture.dataRoot, tracesDir: fixture.tracesDir };

async function invoke(
  tool: { execute: (args: Readonly<Record<string, unknown>>, root: DataRoot) => Promise<CallToolResult> },
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return tool.execute(args, root);
}

describe("完整结果预算（M10）", () => {
  it("fixture 全量数据上，五工具实收结果都 ≤ 64 KiB", async () => {
    const results = [
      await invoke(listVerificationsTool, {}),
      await invoke(getVerificationTool, { verificationId: ids.pass }),
      await invoke(readVerificationLogTool, {
        verificationId: ids.fail,
        commandId: "test",
        stream: "stdout",
      }),
      await invoke(inspectVerificationArtifactsTool, { verificationId: ids.pass }),
    ];
    for (const result of results) {
      expect(toolResultBytes(result)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    }
  });

  it("maxChars 超契约上限 8192 ⇒ 参数错误（上限在形状层，不在实现层钳制）", async () => {
    const result = await invoke(readVerificationLogTool, {
      verificationId: ids.fail,
      commandId: "test",
      stream: "stdout",
      maxChars: 999_999,
    });
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as { error: { code: string } };
    expect(envelope.error.code).toBe("INVALID_ARGUMENT");
  });

  it("上限内请求实发码点不超请求且结果不超预算", async () => {
    const result = await invoke(readVerificationLogTool, {
      verificationId: ids.fail,
      commandId: "test",
      stream: "stdout",
      maxChars: 8192,
    });
    expect(result.isError).not.toBe(true);
    const data = (result.structuredContent as { data: { body: { range: { start: number; end: number } } } }).data;
    expect(data.body.range.end - data.body.range.start).toBeLessThanOrEqual(8192);
    expect(toolResultBytes(result)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  });

  it("content 自足：正文与小事实都在 content 文本里可读回", async () => {
    const result = await invoke(readVerificationLogTool, {
      verificationId: ids.pass,
      commandId: "test",
      stream: "stdout",
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain(VERIFICATION_SENTINELS.passStdout);
    expect(text).toContain("capture");
  });
});

describe("单项超限受控失败（M13）", () => {
  it("超大 argv 的 get_verification ⇒ RESPONSE_LIMIT + verification 定位，无超限信封", async () => {
    const result = await invoke(getVerificationTool, { verificationId: giantId });
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as {
      ok: boolean;
      error: { code: string; ref?: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("RESPONSE_LIMIT");
    expect(envelope.error.ref).toBe(`verification:${giantId}`);
    expect(toolResultBytes(result)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    // 受控文案，不含宿主路径/异常原文
    expect(envelope.error.message).not.toMatch(/mcp2-ver-|[A-Z]:\\/);
  });

  it("普通记录同参仍正常：超限是记录形状问题，不是服务能力回退", async () => {
    const ok = await invoke(getVerificationTool, { verificationId: ids.pass });
    expect(ok.isError).not.toBe(true);
  });
});
