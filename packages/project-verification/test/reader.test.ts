import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishAsset, sha256Hex } from "../src/records/assets.js";
import { assetPath, verificationRecordPath } from "../src/records/layout.js";
import {
  LOG_READ_MAX_BYTES,
  RecordReadError,
  getVerification,
  listVerifications,
  readLog,
} from "../src/records/reader.js";
import { VerificationRecordWriter } from "../src/records/writer.js";

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "r3-pv-r-"));
}

function metaInput(verificationId: string) {
  return {
    verificationId,
    epoch: "ep_1",
    operationId: "op_1",
    target: {
      runId: "run_reader1",
      checkpoint: { kind: "initial" } as const,
      snapshotId: "snap_1",
    },
    profileId: "node-ts-v1" as const,
    manifestVersion: 1,
    commandId: "test" as const,
    planBindingDigest: "a".repeat(64),
    createdAt: "2026-10-25T00:00:00.000Z",
  };
}

function writeSealed(root: string, id: string, outcome: "passed" | "check_failed") {
  const w = VerificationRecordWriter.open(root, metaInput(id));
  w.append({ type: "stage", phase: "executing", at: "2026-10-25T00:00:01.000Z" });
  w.terminate({
    outcome,
    detail: outcome === "passed" ? "tests 2 pass 2" : "断言失败",
    evidenceComplete: true,
    at: "2026-10-25T00:00:02.000Z",
  });
}

describe("getVerification：顺序/身份/版本校验（P15）", () => {
  it("封存记录可读：sealed + outcome + 事件序列", () => {
    const root = newRoot();
    writeSealed(root, "ver_r1", "passed");
    const r = getVerification(root, "ver_r1");
    expect(r.status).toBe("sealed");
    expect(r.terminated?.outcome).toBe("passed");
    expect(r.events).toHaveLength(1);
    expect(r.meta?.target.runId).toBe("run_reader1");
    expect(r.sourceStatus).toBe("unknown");
  });

  it("运行中/未封存记录判 unterminated，不呈现结局", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_r2"));
    w.append({ type: "stage", phase: "executing", at: "2026-10-25T00:00:01.000Z" });
    const mid = getVerification(root, "ver_r2");
    expect(mid.status).toBe("unterminated");
    expect(mid.terminated).toBeUndefined();
    w.terminate({
      outcome: "cancelled",
      detail: "用户停止",
      evidenceComplete: true,
      at: "2026-10-25T00:00:03.000Z",
    });
    expect(getVerification(root, "ver_r2").status).toBe("sealed");
  });

  it("坏尾（末行非法 JSON）判 corrupt 并报告行号", () => {
    const root = newRoot();
    writeSealed(root, "ver_r3", "passed");
    appendFileSync(verificationRecordPath(root, "ver_r3"), '{"type":"stage","phase":"collecti');
    const r = getVerification(root, "ver_r3");
    expect(r.status).toBe("corrupt");
    expect(r.error?.lineIndex).toBe(2);
  });

  it("未知 schemaVersion 判 unsupported_version", () => {
    const root = newRoot();
    mkdirSync(join(root, "verifications"), { recursive: true });
    writeFileSync(
      verificationRecordPath(root, "ver_r4"),
      `{"type":"meta","schemaVersion":2,"verificationId":"ver_r4"}\n`,
    );
    const r = getVerification(root, "ver_r4");
    expect(r.status).toBe("unsupported_version");
  });

  it("meta 身份与请求 ID 不一致判 corrupt", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_r5a"));
    w.abortClose();
    renameSync(verificationRecordPath(root, "ver_r5a"), verificationRecordPath(root, "ver_r5b"));
    const r = getVerification(root, "ver_r5b");
    expect(r.status).toBe("corrupt");
    expect(r.error?.reason).toContain("不一致");
  });

  it("terminated 之后仍有事件判 corrupt", () => {
    const root = newRoot();
    writeSealed(root, "ver_r6", "passed");
    appendFileSync(
      verificationRecordPath(root, "ver_r6"),
      `${JSON.stringify({ type: "stage", phase: "finalizing", at: "2026-10-25T00:00:09.000Z" })}\n`,
    );
    const r = getVerification(root, "ver_r6");
    expect(r.status).toBe("corrupt");
    expect(r.error?.reason).toContain("末行");
  });

  it("记录不存在抛 RECORD_NOT_FOUND；非法 ID 入口拒绝", () => {
    const root = newRoot();
    expect(() => getVerification(root, "ver_absent")).toThrow(RecordReadError);
    expect(() => getVerification(root, "../evil")).toThrow();
  });
});

describe("listVerifications：只扫验证目录（P16）", () => {
  it("摘要按 ID 排序，含结局；不把 traces/verification-assets 计入", () => {
    const root = newRoot();
    writeSealed(root, "ver_lb", "passed");
    writeSealed(root, "ver_la", "check_failed");
    const w = VerificationRecordWriter.open(root, metaInput("ver_lc"));
    w.abortClose();
    mkdirSync(join(root, "traces", "run_reader1"), { recursive: true });
    const list = listVerifications(root);
    expect(list.map((s) => s.verificationId)).toEqual(["ver_la", "ver_lb", "ver_lc"]);
    expect(list[0].outcome).toBe("check_failed");
    expect(list[2].status).toBe("unterminated");
  });
});

describe("readLog：有界切片与附件校验（P13/P16）", () => {
  it("首段默认 32 KiB、返回续读位置；尾段 truncated=false", () => {
    const root = newRoot();
    const payload = "x".repeat(100000);
    const hash = publishAsset(root, new TextEncoder().encode(payload)).sha256;
    const first = readLog(root, hash);
    expect(first.totalBytes).toBe(100000);
    expect(first.nextOffset).toBe(32768);
    expect(first.remaining).toBe(67232);
    expect(first.truncated).toBe(true);
    const tail = readLog(root, hash, { offset: 90000 });
    expect(tail.text).toBe("x".repeat(10000));
    expect(tail.truncated).toBe(false);
    expect(tail.remaining).toBe(0);
  });

  it("maxLength 超上限自动钳制到 64 KiB", () => {
    const root = newRoot();
    const payload = "y".repeat(200000);
    const hash = publishAsset(root, new TextEncoder().encode(payload)).sha256;
    const r = readLog(root, hash, { maxLength: 999999 });
    expect(r.text.length).toBe(LOG_READ_MAX_BYTES);
  });

  it("附件字节被篡改判 ASSET_CORRUPT；缺失判 ASSET_MISSING", () => {
    const root = newRoot();
    const hash = publishAsset(root, new TextEncoder().encode("zzz")).sha256;
    writeFileSync(assetPath(root, hash), "tampered");
    expect(() => readLog(root, hash)).toThrow(/ASSET_CORRUPT/);
    expect(() => readLog(root, "f".repeat(64))).toThrow(/ASSET_MISSING/);
  });
});

describe("迁移与来源标注（P15/P16）", () => {
  it("数据根整体迁移后记录与附件仍可读（相对引用）", () => {
    const rootA = newRoot();
    writeSealed(rootA, "ver_m1", "passed");
    const logHash = publishAsset(rootA, new TextEncoder().encode("migrated-log")).sha256;
    const rootB = join(tmpdir(), `r3-pv-moved-${Date.now()}`);
    renameSync(rootA, rootB);
    const r = getVerification(rootB, "ver_m1");
    expect(r.status).toBe("sealed");
    expect(readLog(rootB, logHash).text).toBe("migrated-log");
  });

  it("来源缺失只标注 sourceStatus，记录仍可读（实际布局 traces/<runId>.jsonl）", () => {
    const root = newRoot();
    writeSealed(root, "ver_s1", "check_failed");
    const tracesRoot = join(root, "traces");
    mkdirSync(tracesRoot, { recursive: true });
    const missing = getVerification(root, "ver_s1", { tracesRoot });
    expect(missing.status).toBe("sealed");
    expect(missing.sourceStatus).toBe("missing");
    // 目录同名不算来源在场（防止"精确目录名"旧口径假阳性）
    mkdirSync(join(tracesRoot, "run_reader1"), { recursive: true });
    expect(getVerification(root, "ver_s1", { tracesRoot }).sourceStatus).toBe("missing");
    writeFileSync(join(tracesRoot, "run_reader1.jsonl"), "{}\n");
    expect(getVerification(root, "ver_s1", { tracesRoot }).sourceStatus).toBe("present");
  });

  it("旧记录没有 environment ⇒ meta 可读（comparison 按未知处理，不猜）", () => {
    const root = newRoot();
    writeSealed(root, "ver_s2", "passed");
    const r = getVerification(root, "ver_s2");
    expect(r.meta?.environment).toBeUndefined();
  });
});
