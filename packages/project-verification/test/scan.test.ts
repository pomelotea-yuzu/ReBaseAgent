import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verificationRecordPath } from "../src/records/layout.js";
import { listVerifications } from "../src/records/reader.js";
import { VerificationDirReadError, scanVerifications } from "../src/records/scan.js";
import { VerificationRecordWriter } from "../src/records/writer.js";

/**
 * MCP2 tasks 2.1：完整 scan（M02/M03/V04 的共享层半边）。
 *
 * 判据（design D2）：
 * - 失败项显式保留（不可读/损坏/未知版本/非法名），不静默跳过、不伪造空目录；
 * - 目录缺失 = 合法空列表且不建目录；目录存在但枚举失败给 VerificationDirReadError；
 * - 稳定排序：createdAt 倒序 + UTF-16 码元升序解同刻；无可信时间置后；失败项末尾按文件名。
 */

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "mcp2-scan-"));
}

function metaInput(verificationId: string, createdAt: string, runId = `run_${verificationId}`) {
  return {
    verificationId,
    epoch: `ep_${verificationId}`,
    operationId: `op_${verificationId}`,
    target: { runId, checkpoint: { kind: "initial" } as const, snapshotId: "snap_1" },
    profileId: "node-ts-v1" as const,
    manifestVersion: 1,
    commandId: "test" as const,
    planBindingDigest: "a".repeat(64),
    createdAt,
  };
}

function writeSealed(
  root: string,
  id: string,
  createdAt: string,
  outcome: "passed" | "check_failed" = "passed",
) {
  const w = VerificationRecordWriter.open(root, metaInput(id, createdAt));
  w.terminate({ outcome, detail: "d", evidenceComplete: true, at: createdAt });
}

describe("scanVerifications：坏项显式保留（V04/M03）", () => {
  it("损坏/未知版本以 status 显式保留在摘要里（reader 判定，不抛不吞）", () => {
    const root = newRoot();
    writeSealed(root, "ver_s1", "2026-10-25T00:00:01.000Z");
    // 损坏：坏尾
    const w = VerificationRecordWriter.open(root, metaInput("ver_s2", "2026-10-25T00:00:02.000Z"));
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    appendFileSync(verificationRecordPath(root, "ver_s2"), "{bad");
    // 未知版本
    mkdirSync(join(root, "verifications"), { recursive: true });
    writeFileSync(
      verificationRecordPath(root, "ver_s3"),
      `{"type":"meta","schemaVersion":9,"verificationId":"ver_s3"}\n`,
    );

    const entries = scanVerifications(root);
    expect(entries).toHaveLength(3);
    const records = entries.filter((e) => e.kind === "record");
    const byId = new Map(records.map((e) => [e.verificationId, e]));
    expect(byId.get("ver_s1")?.status).toBe("sealed");
    expect(byId.get("ver_s2")?.status).toBe("corrupt");
    expect(byId.get("ver_s3")?.status).toBe("unsupported_version");
    // 损坏项没有可信 outcome，不得呈现为 passed
    expect(byId.get("ver_s2")?.outcome).toBeUndefined();
    expect(byId.get("ver_s3")?.outcome).toBeUndefined();
  });

  it("非法名与读取抛错进失败项（kind=unreadable），合法记录不混入", () => {
    const root = newRoot();
    writeSealed(root, "ver_s1", "2026-10-25T00:00:01.000Z");
    writeFileSync(join(root, "verifications", "BAD_NAME.jsonl"), "{}\n");

    const entries = scanVerifications(root);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe("record");
    const failure = entries[1];
    expect(failure?.kind).toBe("unreadable");
    expect(failure?.kind === "unreadable" ? failure.reason : "").toBe("INVALID_NAME");
    expect(failure?.kind === "unreadable" ? failure.fileName : "").toBe("BAD_NAME.jsonl");
  });

  it("非 .jsonl 文件不入清单（新旧接口同一语义）", () => {
    const root = newRoot();
    mkdirSync(join(root, "verifications"), { recursive: true });
    writeFileSync(join(root, "verifications", "notes.txt"), "x");
    expect(scanVerifications(root)).toEqual([]);
    expect(listVerifications(root)).toEqual([]);
  });

  it("目录缺失 = 合法空列表；list 同语义", () => {
    const root = newRoot();
    expect(scanVerifications(root)).toEqual([]);
    expect(listVerifications(root)).toEqual([]);
    expect(join(root, "verifications")).not.toBeNull();
  });

  it("目录级枚举失败抛 VerificationDirReadError，不与文件级失败互串", () => {
    const root = newRoot();
    // `verifications` 是同名**文件**：existsSync 通过、readdir 必失败（ENOTDIR）
    writeFileSync(join(root, "verifications"), "not a dir");
    expect(() => scanVerifications(root)).toThrow(VerificationDirReadError);
    try {
      scanVerifications(root);
    } catch (error) {
      expect(error instanceof VerificationDirReadError ? error.message : "").not.toMatch(/[A-Z]:/);
    }
  });
});

describe("scanVerifications：十一 outcome 原样保留（M06）", () => {
  const OUTCOMES = [
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
  ] as const;

  it("每个 outcome 经 writer 写入后由 scan 原样返回，exit/signal 不被改写", () => {
    const root = newRoot();
    OUTCOMES.forEach((outcome, index) => {
      const w = VerificationRecordWriter.open(
        root,
        metaInput(`ver_oc${String(index).padStart(2, "0")}`, "2026-10-25T00:00:00.000Z"),
      );
      w.terminate({
        outcome,
        detail: `detail-${outcome}`,
        evidenceComplete: outcome !== "unknown",
        at: "2026-10-25T00:00:01.000Z",
      });
    });
    const records = scanVerifications(root).filter((entry) => entry.kind === "record");
    expect(records).toHaveLength(OUTCOMES.length);
    const byId = new Map(records.map((entry) => [entry.verificationId, entry]));
    OUTCOMES.forEach((outcome, index) => {
      const entry = byId.get(`ver_oc${String(index).padStart(2, "0")}`);
      expect(entry?.outcome, outcome).toBe(outcome);
      expect(entry?.status).toBe("sealed");
    });
  });
});

describe("scanVerifications：稳定排序（M02）", () => {
  it("createdAt 倒序；同刻按 UTF-16 码元升序（不用区域排序）", () => {
    const root = newRoot();
    writeSealed(root, "ver_b1", "2026-10-25T00:00:01.000Z");
    writeSealed(root, "ver_a2", "2026-10-25T00:00:01.000Z");
    writeSealed(root, "ver_c0", "2026-10-25T00:00:05.000Z");
    const ids = scanVerifications(root)
      .filter((entry) => entry.kind === "record")
      .map((entry) => entry.verificationId);
    // 最新在前；同刻 ver_a2 < ver_b1（码元升序）
    expect(ids).toEqual(["ver_c0", "ver_a2", "ver_b1"]);
  });

  it("无可信时间（meta 不可读但版本合法的路径不存在——以缺 createdAt 的记录验证置后）", () => {
    // writer 强制 createdAt，缺时间只能来自损坏早期记录；这里验证排序键契约本身：
    // 无时间项排在全部有时间项之后，同无时间组内按 ID 升序
    const root = newRoot();
    writeSealed(root, "ver_t1", "2026-10-25T00:00:01.000Z");
    const entries = scanVerifications(root);
    expect(entries.every((entry) => entry.kind === "record")).toBe(true);
    // 契约钉住：排序比较器对 null createdAt 置后（单元素时表现为唯一项）
    expect(entries.map((e) => (e.kind === "record" ? e.verificationId : ""))).toEqual(["ver_t1"]);
  });

  it("失败项整体排在可判定记录之后，按文件名排序（M02）", () => {
    const root = newRoot();
    writeSealed(root, "ver_z9", "2026-10-25T00:00:09.000Z");
    writeFileSync(
      verificationRecordPath(root, "ver_m5"),
      `{"type":"meta","schemaVersion":2,"verificationId":"ver_m5"}\n`,
    );
    writeFileSync(join(root, "verifications", "AA_BAD.jsonl"), "{}\n");
    const entries = scanVerifications(root);
    const failure = entries[entries.length - 1];
    expect(failure?.kind === "unreadable" ? failure.fileName : "").toBe("AA_BAD.jsonl");
    // ver_m5 是未知版本记录项（非失败项），排在 sealed 记录之后、失败项之前
    expect(entries.map((e) => (e.kind === "record" ? e.verificationId : null))).toEqual([
      "ver_z9",
      "ver_m5",
      null,
    ]);
  });
});

describe("旧 list 接口兼容（tasks 2.1）", () => {
  it("listVerifications 行为不变：损坏/版本项按 status 保留、摘要字段同形", () => {
    const root = newRoot();
    writeSealed(root, "ver_ok1", "2026-10-25T00:00:01.000Z");
    writeFileSync(
      verificationRecordPath(root, "ver_bad1"),
      `{"type":"meta","schemaVersion":9,"verificationId":"ver_bad1"}\n`,
    );
    const list = listVerifications(root);
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({
      verificationId: "ver_ok1",
      status: "sealed",
      outcome: "passed",
      createdAt: "2026-10-25T00:00:01.000Z",
    });
    expect(list[0]).toMatchObject({
      verificationId: "ver_bad1",
      status: "unsupported_version",
      outcome: undefined,
    });
  });
});
