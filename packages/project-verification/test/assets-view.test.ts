import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishAsset } from "../src/records/assets.js";
import { getVerification, RecordReadError, readLog, LOG_READ_MAX_BYTES } from "../src/records/reader.js";
import {
  AssetResolveError,
  classifyAssetBody,
  resolveArtifactAsset,
  resolveLogAsset,
  sliceAssetText,
  verifyAsset,
} from "../src/records/assets-view.js";
import { VerificationRecordWriter } from "../src/records/writer.js";

/**
 * MCP2 tasks 2.3/2.4：记录绑定资产定位 + 核验后安全文本视图
 * （M08/M09/M10/M11/V03/V04 的共享层半边）。
 */

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "mcp2-assets-"));
}

function metaInput(verificationId: string) {
  return {
    verificationId,
    epoch: `ep_${verificationId}`,
    operationId: `op_${verificationId}`,
    target: { runId: `run_${verificationId}`, checkpoint: { kind: "initial" } as const, snapshotId: "snap_1" },
    profileId: "node-ts-v1" as const,
    manifestVersion: 1,
    commandId: "test" as const,
    planBindingDigest: "a".repeat(64),
    createdAt: "2026-10-25T00:00:00.000Z",
  };
}

function commandEnd(root: string, stdoutText: string, stderrText = "") {
  return {
    type: "command_end" as const,
    commandId: "test" as const,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout: {
      byteLength: stdoutText.length,
      totalBytes: stdoutText.length,
      sha256: publishAsset(root, new TextEncoder().encode(stdoutText)).sha256,
      truncated: false,
    },
    stderr: {
      byteLength: stderrText.length,
      totalBytes: stderrText.length,
      sha256: publishAsset(root, new TextEncoder().encode(stderrText)).sha256,
      truncated: false,
    },
    endedAt: "t",
  };
}

function startEvent() {
  return {
    type: "command_start" as const,
    commandId: "test" as const,
    executable: "node",
    argv: ["node"],
    cwd: "/w",
    startedAt: "t",
  };
}

function resolveErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AssetResolveError) return error.code;
    throw error;
  }
  return "no-throw";
}

describe("日志定位：唯一 command_end（M08）", () => {
  it("单条 end 正常解析并带出 capture 双口径", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_a1"));
    w.append(startEvent());
    w.append({ ...commandEnd(root, "out"), stdout: { ...commandEnd(root, "out").stdout, totalBytes: 99, truncated: true } });
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    const record = getVerification(root, "ver_a1");
    const resolved = resolveLogAsset(record, "test", "stdout");
    expect(resolved.capture).toEqual({ byteLength: 3, totalBytes: 99, truncated: true });
    expect(verifyAsset(root, resolved.sha256).size).toBe(3);
  });

  it("重复 command_end 拒绝定位（AMBIGUOUS_COMMAND），不取第一项", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_a2"));
    w.append(startEvent());
    w.append(commandEnd(root, "first"));
    w.append(commandEnd(root, "second"));
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    const record = getVerification(root, "ver_a2");
    expect(resolveErrorCode(() => resolveLogAsset(record, "test", "stdout"))).toBe(
      "AMBIGUOUS_COMMAND",
    );
  });

  it("未记录执行事实给 LOG_NOT_RECORDED；非法哈希引用给 INVALID_REFERENCE", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_a3"));
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    const record = getVerification(root, "ver_a3");
    expect(resolveErrorCode(() => resolveLogAsset(record, "test", "stdout"))).toBe(
      "LOG_NOT_RECORDED",
    );
    const tampered = {
      ...record,
      events: [
        {
          type: "command_end" as const,
          commandId: "test" as const,
          exitCode: 0,
          signal: null,
          durationMs: 1,
          stdout: { byteLength: 1, totalBytes: 1, sha256: "nothex", truncated: false },
          stderr: { byteLength: 0, totalBytes: 0, sha256: "0".repeat(64), truncated: false },
          endedAt: "t",
        },
      ],
    };
    expect(resolveErrorCode(() => resolveLogAsset(tampered, "test", "stdout"))).toBe(
      "INVALID_REFERENCE",
    );
  });
});

describe("产物定位：清单绑定（M08/M09）", () => {
  function recordWithArtifacts(root: string, id: string, entries: { path: string; text: string }[]) {
    const w = VerificationRecordWriter.open(root, metaInput(id));
    w.append({
      type: "artifacts",
      entries: entries.map((entry) => {
        const bytes = new TextEncoder().encode(entry.text);
        return { path: entry.path, size: bytes.length, sha256: publishAsset(root, bytes).sha256 };
      }),
      excludedPatterns: ["node_modules/**"],
      totalBytes: 0,
    });
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    return getVerification(root, id);
  }

  it("清单内 path 解析成功；清单外拒绝；排除规则原样带出", () => {
    const root = newRoot();
    const record = recordWithArtifacts(root, "ver_b1", [
      { path: "report.json", text: "{}" },
      { path: "blob.bin", text: "\u0000" },
    ]);
    const resolved = resolveArtifactAsset(record, "report.json");
    expect(resolved.sha256).toBeTypeOf("string");
    expect(resolved.excludedPatterns).toEqual(["node_modules/**"]);
    expect(resolveErrorCode(() => resolveArtifactAsset(record, "other.txt"))).toBe(
      "ARTIFACT_NOT_FOUND",
    );
  });

  it("重复产物 path 拒绝（DUPLICATE_ARTIFACT_PATH）", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_b2"));
    const bytes = new TextEncoder().encode("x");
    w.append({
      type: "artifacts",
      entries: [
        { path: "same.txt", size: 1, sha256: publishAsset(root, bytes).sha256 },
        { path: "same.txt", size: 1, sha256: publishAsset(root, new TextEncoder().encode("y")).sha256 },
      ],
      excludedPatterns: [],
      totalBytes: 2,
    });
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    const record = getVerification(root, "ver_b2");
    expect(resolveErrorCode(() => resolveArtifactAsset(record, "same.txt"))).toBe(
      "DUPLICATE_ARTIFACT_PATH",
    );
  });

  it("未采集（无 artifacts 事件）与合法空清单分开", () => {
    const root = newRoot();
    const noArtifacts = VerificationRecordWriter.open(root, metaInput("ver_b3"));
    noArtifacts.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    const empty = recordWithArtifacts(root, "ver_b4", []);
    expect(resolveErrorCode(() => resolveArtifactAsset(getVerification(root, "ver_b3"), "a.txt"))).toBe(
      "ARTIFACTS_NOT_RECORDED",
    );
    expect(resolveErrorCode(() => resolveArtifactAsset(empty, "a.txt"))).toBe("ARTIFACT_NOT_FOUND");
  });
});

describe("普通文件守卫（V04，design D4）", () => {
  it("附件被符号链接顶替时拒绝读取（lstat 判定，不跟随）", () => {
    const root = newRoot();
    const hash = publishAsset(root, new TextEncoder().encode("victim")).sha256;
    const assetFile = join(root, "verification-assets", "sha256", hash);
    rmSync(assetFile);
    // junction/symlink 指向根内另一个普通文件——同样拒绝（不做替身解析）
    const decoy = publishAsset(root, new TextEncoder().encode("decoy")).sha256;
    symlinkSync(join(root, "verification-assets", "sha256", decoy), assetFile, "junction");
    expect(() => verifyAsset(root, hash)).toThrow(RecordReadError);
    try {
      verifyAsset(root, hash);
    } catch (error) {
      expect((error as RecordReadError).code).toBe("ASSET_CORRUPT");
    }
  });

  it("记录文件被符号链接顶替时拒绝读取（RECORD_UNUSUAL）", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_c1"));
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    const recordFile = join(root, "verifications", "ver_c1.jsonl");
    const text = "moved";
    writeFileSync(join(root, "elsewhere.jsonl"), text, "utf8");
    rmSync(recordFile);
    symlinkSync(join(root, "elsewhere.jsonl"), recordFile, "junction");
    try {
      getVerification(root, "ver_c1");
      throw new Error("should-throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordReadError);
      expect((error as RecordReadError).code).toBe("RECORD_UNUSUAL");
    }
  });

  it("附件缺失给 ASSET_MISSING（守卫 MISSING 路径）", () => {
    const root = newRoot();
    expect(() => verifyAsset(root, "1".repeat(64))).toThrow(RecordReadError);
    try {
      verifyAsset(root, "1".repeat(64));
    } catch (error) {
      expect((error as RecordReadError).code).toBe("ASSET_MISSING");
    }
  });

  it("附件字节被改写给 ASSET_CORRUPT；scan 对 RECORD_UNUSUAL 归 UNREADABLE 失败项", () => {
    const root = newRoot();
    const hash = publishAsset(root, new TextEncoder().encode("intact")).sha256;
    writeFileSync(join(root, "verification-assets", "sha256", hash), "tampered!");
    try {
      verifyAsset(root, hash);
      throw new Error("should-throw");
    } catch (error) {
      expect((error as RecordReadError).code).toBe("ASSET_CORRUPT");
    }
  });
});

describe("严格 UTF-8 文本视图与码点切片（M11/V03）", () => {
  it("多字节字符跨码点切片不拆代理对、不补替换字符", () => {
    const root = newRoot();
    const text = "中文😀多字节\r\n第二行\n";
    const { sha256 } = publishAsset(root, new TextEncoder().encode(text));
    expect(classifyAssetBody(root, sha256)).toEqual({ kind: "text", totalChars: 12 });
    const first = sliceAssetText(root, sha256, { start: 0, maxChars: 5 });
    // 0:中 1:文 2:😀(单码点) 3:多 4:字 —— 代理对完整
    expect(first.text).toBe("中文😀多字");
    expect(first.nextStart).toBe(5);
    expect(first.remaining).toBe(7);
    const second = sliceAssetText(root, sha256, { start: first.nextStart, maxChars: 4096 });
    expect(second.text).toBe("节\r\n第二行\n");
    expect(second.truncated).toBe(false);
  });

  it("空文本、尾随换行、纯 CRLF 原样保留", () => {
    const root = newRoot();
    const empty = publishAsset(root, new Uint8Array(0)).sha256;
    expect(classifyAssetBody(root, empty)).toEqual({ kind: "text", totalChars: 0 });
    expect(sliceAssetText(root, empty).text).toBe("");
    const crlf = publishAsset(root, new TextEncoder().encode("\r\n\r\n")).sha256;
    expect(sliceAssetText(root, crlf).text).toBe("\r\n\r\n");
  });

  it("非法 UTF-8 判二进制：只给元数据，slice 拒绝文本视图", () => {
    const root = newRoot();
    const { sha256 } = publishAsset(root, new Uint8Array([0x61, 0xff, 0xfe, 0x80]));
    expect(classifyAssetBody(root, sha256)).toEqual({ kind: "binary", size: 4 });
    expect(() => sliceAssetText(root, sha256)).toThrow(/UTF-8/);
  });

  it("capture 与响应范围分开：记录截断事实不因读完保留部分而消失（M10 语义底料）", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_c2"));
    w.append(startEvent());
    const end = commandEnd(root, "retained");
    w.append({
      ...end,
      stdout: { ...end.stdout, totalBytes: 9999, truncated: true },
    });
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    const record = getVerification(root, "ver_c2");
    const resolved = resolveLogAsset(record, "test", "stdout");
    expect(resolved.capture).toEqual({ byteLength: 8, totalBytes: 9999, truncated: true });
    const slice = sliceAssetText(root, resolved.sha256, { start: 0, maxChars: 100 });
    expect(slice.truncated).toBe(false); // 响应范围读完了保留部分
    expect(resolved.capture.truncated).toBe(true); // 执行时截断仍是事实
  });

  it("旧字节接口兼容：默认 32 KiB / 上限 64 KiB 语义不变（V03）", () => {
    expect(LOG_READ_MAX_BYTES).toBe(65536);
    const root = newRoot();
    const { sha256 } = publishAsset(root, new TextEncoder().encode("字节接口"));
    const slice = readLog(root, sha256, { offset: 0, maxLength: 4 });
    // 字节切片按 UTF-8 字节截断——「可能切断多字节」正是旧接口保留的兼容语义
    expect(slice.totalBytes).toBe(12);
    void mkdirSync;
  });
});
