import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_TS_V1_PROFILE } from "../src/schema.js";
import { getVerification } from "../src/records/reader.js";
import { projectVerification, PROJECTION_PREVIEW_MAX_CHARS } from "../src/records/projection.js";
import { publishAsset } from "../src/records/assets.js";
import { verificationRecordPath } from "../src/records/layout.js";
import { VerificationRecordWriter } from "../src/records/writer.js";

/**
 * MCP2 tasks 2.2：共享白名单投影（M04–M06 的共享层半边）。
 *
 * 判据（design D3）：
 * - 封存门：可信 terminated/outcome 只在 sealed 出现；unterminated/corrupt/未知版本
 *   恒 null + 诊断，坏尾/重复终止/终止后事件不得裁尾出 passed（M05）；
 * - 实际命令/历史环境按记录读取；旧记录缺 environment 保持 null（M04）；
 * - 白名单：epoch/operationId/容器名/ID 不出现；interrupted 只给计数；
 * - detail/reason 有界预览 + 原长度 + 截断标记。
 */

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "mcp2-proj-"));
}

function metaInput(verificationId: string, withEnvironment: boolean) {
  return {
    verificationId,
    epoch: `ep_${verificationId}`,
    operationId: `op_${verificationId}`,
    target: {
      runId: `run_${verificationId}`,
      checkpoint: { kind: "initial" } as const,
      snapshotId: "snap_1",
    },
    profileId: "node-ts-v1" as const,
    manifestVersion: 1,
    commandId: "test" as const,
    planBindingDigest: "a".repeat(64),
    createdAt: "2026-10-25T00:00:00.000Z",
    ...(withEnvironment
      ? {
          environment: {
            preparationId: "prep_1",
            imageDigest: `sha256:${"a".repeat(63)}1`,
            platform: "linux/amd64" as const,
            toolchain: NODE_TS_V1_PROFILE.toolchain,
            limits: NODE_TS_V1_PROFILE.limits,
            security: NODE_TS_V1_PROFILE.security,
          },
        }
      : {}),
  };
}

describe("封存门与诊断（M05）", () => {
  it("sealed：terminated/outcome/evidenceComplete 投影，detail 有界", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_p1", true));
    w.append({ type: "stage", phase: "executing", at: "2026-10-25T00:00:01.000Z" });
    w.terminate({ outcome: "passed", detail: "tests 2 pass 2", evidenceComplete: true, at: "t" });
    const p = projectVerification(getVerification(root, "ver_p1"));
    expect(p.status).toBe("sealed");
    expect(p.terminated?.outcome).toBe("passed");
    expect(p.terminated?.evidenceComplete).toBe(true);
    expect(p.terminated?.detail).toMatchObject({ text: "tests 2 pass 2", truncated: false });
  });

  it("unterminated：terminated=null，不呈现结局；interrupted 只给安全计数不给容器名/ID", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_p2", true));
    w.append({ type: "stage", phase: "executing", at: "t" });
    w.append({
      type: "interrupted",
      reason: "宿主退出",
      stoppedResources: [{ name: "容器甲", containerId: "abc123def" }],
      removedResources: [],
      unconfirmedResources: ["容器乙", "容器丙"],
      at: "t",
    });
    w.abortClose();
    const p = projectVerification(getVerification(root, "ver_p2"));
    expect(p.status).toBe("unterminated");
    expect(p.terminated).toBeNull();
    expect(p.interrupted).toMatchObject({
      stoppedCount: 1,
      removedCount: 0,
      unconfirmedCount: 2,
    });
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("容器甲");
    expect(serialized).not.toContain("abc123def");
  });

  it("corrupt（重复终止/终止后事件）：terminated=null + 诊断，不裁尾出 passed", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_p3", false));
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    // 重复终止：再手工追加一行 terminated（被测对象本身非法）
    appendFileSync(
      verificationRecordPath(root, "ver_p3"),
      `${JSON.stringify({ type: "terminated", outcome: "passed", detail: "d2", evidenceComplete: true, at: "t2" })}\n`,
    );
    const p = projectVerification(getVerification(root, "ver_p3"));
    expect(p.status).toBe("corrupt");
    expect(p.terminated).toBeNull();
    // 追加行使首条 terminated 不再是末行：读取层按此诊断（非裁尾出成功）
    expect(p.diagnostic?.reason).toContain("末行");
    // 追加的第二条 terminated（at=t2）不是正文事件，绝不进事件索引
    expect(p.eventIndex.every((entry) => entry.at !== "t2")).toBe(true);
  });

  it("unsupported_version：terminated=null + 诊断 + meta=null", () => {
    const root = newRoot();
    mkdirSync(join(root, "verifications"), { recursive: true });
    writeFileSync(
      verificationRecordPath(root, "ver_p4"),
      `{"type":"meta","schemaVersion":9,"verificationId":"ver_p4"}\n`,
    );
    const p = projectVerification(getVerification(root, "ver_p4"));
    expect(p.status).toBe("unsupported_version");
    expect(p.terminated).toBeNull();
    expect(p.meta).toBeNull();
    expect(p.diagnostic?.reason).toContain("schemaVersion");
  });
});

describe("实际命令与历史环境（M04）", () => {
  it("start/end 配对给出 executable/argv/cwd/UTC 起止/exit/流元数据", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_p5", true));
    w.append({
      type: "command_start",
      commandId: "test",
      executable: "/usr/local/bin/node",
      argv: ["node", "--test"],
      cwd: "/workspace",
      startedAt: "2026-10-25T00:00:01.000Z",
    });
    w.append({
      type: "command_end",
      commandId: "test",
      exitCode: 1,
      signal: null,
      durationMs: 1500,
      stdout: {
        byteLength: 10,
        totalBytes: 20,
        sha256: publishAsset(root, new TextEncoder().encode("stdout")).sha256,
        truncated: true,
      },
      stderr: {
        byteLength: 0,
        totalBytes: 0,
        sha256: publishAsset(root, new Uint8Array(0)).sha256,
        truncated: false,
      },
      endedAt: "2026-10-25T00:00:02.500Z",
    });
    w.terminate({ outcome: "check_failed", detail: "断言失败", evidenceComplete: true, at: "t" });
    const p = projectVerification(getVerification(root, "ver_p5"));
    expect(p.commands).toHaveLength(1);
    expect(p.commands[0]).toMatchObject({
      commandId: "test",
      executable: "/usr/local/bin/node",
      argv: ["node", "--test"],
      cwd: "/workspace",
      startedAt: "2026-10-25T00:00:01.000Z",
      endedAt: "2026-10-25T00:00:02.500Z",
      exitCode: 1,
      durationMs: 1500,
    });
    expect(p.commands[0]?.stdout).toMatchObject({ byteLength: 10, totalBytes: 20, truncated: true });
  });

  it("旧记录缺 environment：保持 null，不拿当前 manifest 补齐", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_p6", false));
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    const p = projectVerification(getVerification(root, "ver_p6"));
    expect(p.meta?.environment).toBeNull();
    expect(p.meta?.profileId).toBe("node-ts-v1");
    // 白名单：epoch/operationId 不出现在投影
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("ep_ver_p6");
    expect(serialized).not.toContain("op_ver_p6");
  });

  it("重复命令如实多条（歧义拒绝在资产层），事件索引只含 type/at/commandId", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_p7", false));
    for (const text of ["a", "b"]) {
      w.append({
        type: "command_start",
        commandId: "test",
        executable: "node",
        argv: ["node"],
        cwd: "/w",
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
          sha256: publishAsset(root, new TextEncoder().encode(text)).sha256,
          truncated: false,
        },
        stderr: {
          byteLength: 0,
          totalBytes: 0,
          sha256: publishAsset(root, new Uint8Array(0)).sha256,
          truncated: false,
        },
        endedAt: "t",
      });
    }
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    const p = projectVerification(getVerification(root, "ver_p7"));
    expect(p.commands).toHaveLength(2);
    expect(p.eventIndex.filter((entry) => entry.type === "command_end")).toHaveLength(2);
    expect(p.artifacts).toBeNull();
  });
});

describe("有界预览（M06 外发纪律）", () => {
  it("超长 detail 截断并保留原长度", () => {
    const long = "长".repeat(PROJECTION_PREVIEW_MAX_CHARS + 10);
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_p8", false));
    w.terminate({ outcome: "check_failed", detail: long, evidenceComplete: true, at: "t" });
    const p = projectVerification(getVerification(root, "ver_p8"));
    expect(p.terminated?.detail.truncated).toBe(true);
    expect(p.terminated?.detail.length).toBe(PROJECTION_PREVIEW_MAX_CHARS + 10);
    expect([...(p.terminated?.detail.text ?? "")]).toHaveLength(PROJECTION_PREVIEW_MAX_CHARS + 1); // 含省略号
  });

  it("阶段计数与停止计数按事件累计", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_p9", false));
    w.append({ type: "stage", phase: "materializing", at: "t" });
    w.append({ type: "stage", phase: "executing", at: "t" });
    w.append({ type: "stop_requested", at: "t" });
    w.append({ type: "stop_confirmed", stoppedPidCount: 1, quiescenceMs: 10, at: "t" });
    w.terminate({ outcome: "cancelled", detail: "用户停止", evidenceComplete: false, at: "t" });
    const p = projectVerification(getVerification(root, "ver_p9"));
    expect(p.stageCounts).toMatchObject({ materializing: 1, executing: 1 });
    expect(p.stopRequested).toBe(1);
    expect(p.stopConfirmed).toBe(1);
    expect(p.terminated?.outcome).toBe("cancelled");
  });
});
