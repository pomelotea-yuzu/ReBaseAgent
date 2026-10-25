import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verificationRecordPath } from "../src/records/layout.js";
import { PreparationRecordWriter, VerificationRecordWriter } from "../src/records/writer.js";
import { VerificationEventSchema } from "../src/schema.js";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "r3-pv-w-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  // 临时目录交由系统清理；这里只保证测试间互不共享 root
});

function metaInput(verificationId: string) {
  return {
    verificationId,
    epoch: "ep_1",
    operationId: "op_1",
    target: { runId: "run_abc123", checkpoint: { kind: "initial" } as const, snapshotId: "snap_1" },
    profileId: "node-ts-v1" as const,
    manifestVersion: 1,
    commandId: "test" as const,
    planBindingDigest: "a".repeat(64),
    createdAt: "2026-10-25T00:00:00.000Z",
  };
}

function readLines(root: string, verificationId: string): unknown[] {
  const text = readFileSync(verificationRecordPath(root, verificationId), "utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("验证记录 writer：顺序、封存与排他", () => {
  it("open 以 wx 排他建文件并写 meta 首行（版本钉 1）", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_w1"));
    const lines = readLines(root, "ver_w1");
    expect(lines).toHaveLength(1);
    const meta = lines[0] as { type: string; schemaVersion: number; verificationId: string };
    expect(meta.type).toBe("meta");
    expect(meta.schemaVersion).toBe(1);
    expect(meta.verificationId).toBe("ver_w1");
    w.abortClose();
  });

  it("meta 可带环境身份（5.4），非法镜像摘要/多余键在入口拒绝", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, {
      ...metaInput("ver_w1b"),
      environment: {
        preparationId: "prep-1",
        imageDigest: `sha256:${"a".repeat(64)}`,
        platform: "linux/amd64",
        toolchain: { node: "22.23.4", npm: "10.9.9", typescript: "5.9.3" },
        limits: {
          cpus: 1,
          memoryBytes: 536870912,
          pidsLimit: 64,
          workTmpfsBytes: 167772160,
          tmpTmpfsBytes: 33554432,
          commandTimeoutMs: 120000,
          totalTimeoutMs: 180000,
          stdoutBudgetBytes: 1048576,
          stderrBudgetBytes: 1048576,
          totalOutputLimitBytes: 16777216,
          artifactUniqueContentBudgetBytes: 134217728,
          tmpfsCountsTowardMemoryBudget: true,
        },
        security: {
          runAsUser: "1000:1000",
          readOnlyRootfs: true,
          capDropAll: true,
          noNewPrivileges: true,
          networkMode: "none",
          supervisorPid1: true,
        },
      },
    });
    const meta = readLines(root, "ver_w1b")[0] as { environment: { imageDigest: string } };
    expect(meta.environment.imageDigest).toBe(`sha256:${"a".repeat(64)}`);
    w.abortClose();
    expect(() =>
      VerificationRecordWriter.open(root, {
        ...metaInput("ver_w1c"),
        environment: {
          preparationId: "prep-1",
          imageDigest: "no-prefix",
          platform: "linux/amd64",
        } as never,
      }),
    ).toThrow();
  });

  it("正文事件可追加且逐行通过全量事件联合解析", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_w2"));
    w.append({ type: "stage", phase: "executing", at: "2026-10-25T00:00:01.000Z" });
    w.append({
      type: "command_start",
      commandId: "test",
      executable: "/usr/local/bin/node",
      argv: ["/opt/r3/runner.mjs", "test"],
      cwd: "/work",
      startedAt: "2026-10-25T00:00:01.500Z",
    });
    const lines = readLines(root, "ver_w2");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(VerificationEventSchema.safeParse(line).success).toBe(true);
    }
    w.terminate({
      outcome: "passed",
      detail: "tests 2 pass 2",
      evidenceComplete: true,
      at: "2026-10-25T00:00:02.000Z",
    });
  });

  it("terminate 即封存：后续追加/再终止抛错且文件字节不变", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_w3"));
    w.terminate({
      outcome: "check_failed",
      detail: "mul 断言失败",
      evidenceComplete: true,
      at: "2026-10-25T00:00:03.000Z",
    });
    expect(w.sealed).toBe(true);
    const before = readFileSync(verificationRecordPath(root, "ver_w3"));
    expect(() =>
      w.append({ type: "stage", phase: "collecting", at: "2026-10-25T00:00:04.000Z" }),
    ).toThrow();
    expect(() =>
      w.terminate({
        outcome: "passed",
        detail: "再次终止",
        evidenceComplete: true,
        at: "2026-10-25T00:00:05.000Z",
      }),
    ).toThrow();
    expect(readFileSync(verificationRecordPath(root, "ver_w3"))).toEqual(before);
  });

  it("meta 与 terminated 形状不能作为正文追加（meta 只能首行、终止只能走 terminate）", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_w4"));
    expect(() =>
      w.append({ ...metaInput("ver_w4"), type: "meta", schemaVersion: 1 } as never),
    ).toThrow();
    expect(() =>
      w.append({
        type: "terminated",
        outcome: "passed",
        detail: "绕过",
        evidenceComplete: true,
        at: "2026-10-25T00:00:00.000Z",
      } as never),
    ).toThrow();
    w.abortClose();
  });

  it("同 verificationId 重开拒绝（记录 ID 唯一）", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_w5"));
    w.terminate({
      outcome: "unknown",
      detail: "daemon 断开",
      evidenceComplete: false,
      at: "2026-10-25T00:00:00.000Z",
    });
    expect(() => VerificationRecordWriter.open(root, metaInput("ver_w5"))).toThrow();
  });

  it("abortClose 不写终止——未封存现场保留", () => {
    const root = newRoot();
    const w = VerificationRecordWriter.open(root, metaInput("ver_w6"));
    w.append({ type: "stage", phase: "executing", at: "2026-10-25T00:00:01.000Z" });
    w.abortClose();
    const lines = readLines(root, "ver_w6");
    expect(lines[lines.length - 1]).not.toHaveProperty("type", "terminated");
    expect(() =>
      w.append({ type: "stage", phase: "collecting", at: "2026-10-25T00:00:02.000Z" }),
    ).toThrow();
  });

  it("非法 verificationId（路径穿越形态）在入口拒绝且不产生任何目录", () => {
    const root = newRoot();
    expect(() => VerificationRecordWriter.open(root, metaInput("../evil"))).toThrow();
    expect(() => VerificationRecordWriter.open(root, metaInput("C:/evil"))).toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("与既有轨迹隔离（P14 切片）+ 失败不被成功覆盖（P11 切片）", () => {
  it("只写验证目录，traces 哨兵逐字节不变", () => {
    const root = newRoot();
    const traceDir = join(root, "traces", "run_x");
    mkdirSync(traceDir, { recursive: true });
    const sentinel = join(traceDir, "s_01.jsonl");
    writeFileSync(sentinel, '{"type":"span"}\n');
    const w = VerificationRecordWriter.open(root, metaInput("ver_w7"));
    w.terminate({
      outcome: "passed",
      detail: "ok",
      evidenceComplete: true,
      at: "2026-10-25T00:00:00.000Z",
    });
    expect(readFileSync(sentinel, "utf8")).toBe('{"type":"span"}\n');
    expect(readdirSync(traceDir)).toEqual(["s_01.jsonl"]);
    expect(readdirSync(join(root, "traces"))).toEqual(["run_x"]);
  });

  it("失败与通过两条记录各自独立存在", () => {
    const root = newRoot();
    const fail = VerificationRecordWriter.open(root, metaInput("ver_fail_a"));
    fail.terminate({
      outcome: "check_failed",
      detail: "断言失败",
      evidenceComplete: true,
      at: "2026-10-25T00:00:00.000Z",
    });
    const pass = VerificationRecordWriter.open(root, metaInput("ver_pass_b"));
    pass.terminate({
      outcome: "passed",
      detail: "修复后通过",
      evidenceComplete: true,
      at: "2026-10-25T00:00:01.000Z",
    });
    const names = readdirSync(join(root, "verifications")).sort();
    expect(names).toEqual(["ver_fail_a.jsonl", "ver_pass_b.jsonl"]);
    const failLast = readLines(root, "ver_fail_a").pop() as { outcome: string };
    expect(failLast.outcome).toBe("check_failed");
  });
});

describe("准备记录 writer", () => {
  it("open/append/terminate 全流程与同 ID 拒绝", () => {
    const root = newRoot();
    const meta = {
      preparationId: "prep_w1",
      epoch: "ep_1",
      operationId: "op_2",
      profileId: "node-ts-v1" as const,
      manifestVersion: 1,
      planDigest: "b".repeat(64),
      createdAt: "2026-10-25T00:00:00.000Z",
    };
    const w = PreparationRecordWriter.open(root, meta);
    w.append({
      type: "prepared",
      imageDigest: `sha256:${"c".repeat(64)}`,
      toolchain: { node: "22.23.4", typescript: "5.9.3" },
      networkUsed: true,
      downloadedBytes: 1048576,
      at: "2026-10-25T00:00:01.000Z",
    });
    w.terminate({ outcome: "prepared", at: "2026-10-25T00:00:02.000Z" });
    expect(w.sealed).toBe(true);
    expect(() => PreparationRecordWriter.open(root, meta)).toThrow();
  });
});
