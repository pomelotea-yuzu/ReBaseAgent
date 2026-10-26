import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVerification, readLog } from "@rebaseagent/project-verification/read";
import type { CommandEndEvent } from "@rebaseagent/project-verification/schema";
import { afterAll, describe, expect, it } from "vitest";
import {
  VERIFICATION_SENTINELS,
  type VerificationFixture,
  buildVerificationFixture,
  cleanupVerificationFixtures,
  copyVerificationRecord,
  liveFixtureRootCount,
  rootFingerprintDiff,
  snapshotRootFingerprint,
} from "./verification-fixtures.js";

function commandEnds(record: ReturnType<typeof getVerification>): CommandEndEvent[] {
  return record.events.filter((event): event is CommandEndEvent => event.type === "command_end");
}

/**
 * MCP2 tasks 1.3：fixture 清单自证（M04–M07/M17/M19 的**证据准备**，不构成这些
 * 场景的通过证据——收口在 3.x/5.x）。判据：每条记录经 R3 reader 读出的状态/结局/
 * 事件形状与清单表逐字一致，探针在自检轮次证明"读一遍不改根"。
 */

const fixture = buildVerificationFixture();

afterAll(() => {
  cleanupVerificationFixtures();
});

describe("fixture 清单自证（tasks 1.3）", () => {
  it("同条件对：pass/fail 均 sealed，环境逐字段相同，仅结局与 exit 不同（M14 之底料）", () => {
    const pass = getVerification(fixture.dataRoot, fixture.ids.pass);
    const fail = getVerification(fixture.dataRoot, fixture.ids.fail);
    expect(pass.status).toBe("sealed");
    expect(fail.status).toBe("sealed");
    expect(pass.terminated?.outcome).toBe("passed");
    expect(fail.terminated?.outcome).toBe("check_failed");
    expect(pass.meta?.environment).toEqual(fail.meta?.environment);
    expect(pass.meta?.planBindingDigest).toBe(fail.meta?.planBindingDigest);
    const passEnd = commandEnds(getVerification(fixture.dataRoot, fixture.ids.pass));
    const failEnd = commandEnds(getVerification(fixture.dataRoot, fixture.ids.fail));
    expect(passEnd[0]?.exitCode).toBe(0);
    expect(failEnd[0]?.exitCode).toBe(1);
  });

  it("fail 记录 capture 双口径：保留 < 观测，truncated=true（M10 之底料）", () => {
    const fail = getVerification(fixture.dataRoot, fixture.ids.fail);
    const end = commandEnds(fail)[0];
    expect(end?.stdout.byteLength).toBe(fixture.failCapture.retainedBytes);
    expect(end?.stdout.totalBytes).toBe(fixture.failCapture.observedBytes);
    expect(end?.stdout.truncated).toBe(true);
  });

  it("旧记录缺 environment：meta.environment === undefined（M04/M15 之底料）", () => {
    const old = getVerification(fixture.dataRoot, fixture.ids.oldEnv);
    expect(old.status).toBe("sealed");
    expect(old.meta?.environment).toBeUndefined();
  });

  it("未封存+interrupted：unterminated、无 terminated（M05/M17 之底料）", () => {
    const unterm = getVerification(fixture.dataRoot, fixture.ids.unterm);
    expect(unterm.status).toBe("unterminated");
    expect(unterm.terminated).toBeUndefined();
    expect(unterm.events.some((event) => event.type === "interrupted")).toBe(true);
  });

  it("坏尾/未知版本：corrupt（terminated 非末行诊断）/unsupported_version（M03/M05 之底料）", () => {
    const badTail = getVerification(fixture.dataRoot, fixture.ids.badTail);
    expect(badTail.status).toBe("corrupt");
    // 坏尾行紧跟 terminated：读取层先判「terminated 必须为末行」，报在 terminated 行
    expect(badTail.error?.lineIndex).toBe(5);
    expect(badTail.error?.reason).toContain("末行");
    const oldVersion = getVerification(fixture.dataRoot, fixture.ids.oldVersion);
    expect(oldVersion.status).toBe("unsupported_version");
  });

  it("重复 command_end：sealed 且同一 commandId 两条 end（M08 歧义底料）", () => {
    const dup = getVerification(fixture.dataRoot, fixture.ids.dupCommand);
    expect(dup.status).toBe("sealed");
    const ends = commandEnds(dup);
    expect(ends).toHaveLength(2);
    expect(ends.every((event) => event.commandId === "test")).toBe(true);
    expect(ends[0]?.stdout.sha256).not.toBe(ends[1]?.stdout.sha256);
  });

  it("附件缺失/被改：引用在场，readLog 给 ASSET_MISSING/ASSET_CORRUPT（M09/M12 底料）", () => {
    const missing = getVerification(fixture.dataRoot, fixture.ids.missingAsset);
    const missingEnd = commandEnds(missing)[0];
    expect(() => readLog(fixture.dataRoot, missingEnd?.stdout.sha256 ?? "")).toThrow(
      /ASSET_MISSING/,
    );
    const corrupt = getVerification(fixture.dataRoot, fixture.ids.corruptAsset);
    const corruptEnd = commandEnds(corrupt)[0];
    expect(() => readLog(fixture.dataRoot, corruptEnd?.stdout.sha256 ?? "")).toThrow(
      /ASSET_CORRUPT/,
    );
  });

  it("冲突产物清单：同 path 两条 entry、hash 不同（M08/M09 底料）", () => {
    const dup = getVerification(fixture.dataRoot, fixture.ids.dupPath);
    const artifacts = dup.events.find((event) => event.type === "artifacts");
    expect(artifacts?.entries).toHaveLength(2);
    expect(artifacts?.entries[0]?.path).toBe("same.txt");
    expect(artifacts?.entries[1]?.path).toBe("same.txt");
    expect(artifacts?.entries[0]?.sha256).not.toBe(artifacts?.entries[1]?.sha256);
  });

  it("来源在场/缺失分开：pass 有 trace，gone 无 trace（M07 底料）", () => {
    const present = getVerification(fixture.dataRoot, fixture.ids.pass, {
      tracesRoot: fixture.tracesDir,
    });
    const gone = getVerification(fixture.dataRoot, fixture.ids.goneSource, {
      tracesRoot: fixture.tracesDir,
    });
    expect(present.sourceStatus).toBe("present");
    expect(gone.sourceStatus).toBe("missing");
  });

  it("Unicode/二进制/秘密 canary 资产就位且哈希核验通过（M11/M18 底料）", () => {
    const slice = readLog(fixture.dataRoot, fixture.hashes.passStdout);
    expect(slice.text).toContain(VERIFICATION_SENTINELS.passStdout);
    expect(slice.text).toContain(VERIFICATION_SENTINELS.secretInLog);
    expect(slice.text).toContain("\r\n");
    const binary = readLog(fixture.dataRoot, fixture.hashes.passBinarySha);
    expect(binary.totalBytes).toBe(7);
  });

  it("准备记录就位：sealed/prepared，preparationId 与 pass 记录 environment 关联（M04 底料）", () => {
    const prepText = readFileSync(
      join(fixture.dataRoot, "verification-environments", `prep-${fixture.ids.pass}.jsonl`),
      "utf8",
    );
    expect(prepText).toContain('"outcome":"prepared"');
    const pass = getVerification(fixture.dataRoot, fixture.ids.pass);
    expect(pass.meta?.environment?.preparationId).toBe(`prep-${fixture.ids.pass}`);
  });

  it("残留 runtime 登记与未封存记录在根内（M17 探针对象）", () => {
    expect(existsSync(join(fixture.dataRoot, "verification-runtime", "owner-m2.json"))).toBe(true);
    expect(existsSync(join(fixture.dataRoot, "verifications", `${fixture.ids.unterm}.jsonl`))).toBe(
      true,
    );
  });
});

describe("零写入探针自证（tasks 1.3）", () => {
  it("整根指纹在「读一遍全部记录+日志」前后逐字相同", () => {
    const baseline = snapshotRootFingerprint(fixture.dataRoot);
    for (const id of Object.values(fixture.ids)) {
      getVerification(fixture.dataRoot, id);
    }
    readLog(fixture.dataRoot, fixture.hashes.passStdout);
    readLog(fixture.dataRoot, fixture.hashes.passArtifactText);
    const after = snapshotRootFingerprint(fixture.dataRoot);
    expect(rootFingerprintDiff(baseline, after)).toEqual([]);
  });

  it("指纹能抓出改写：改一个资产字节后 diff 非空", () => {
    const baseline = snapshotRootFingerprint(fixture.dataRoot);
    const target = join(fixture.assetsDir, fixture.hashes.passArtifactText);
    const original = readFileSync(target);
    try {
      writeFileSync(target, Buffer.concat([original, Buffer.from("x")]));
      const after = snapshotRootFingerprint(fixture.dataRoot);
      expect(rootFingerprintDiff(baseline, after)).toEqual([
        `改写：verification-assets/sha256/${fixture.hashes.passArtifactText}`,
      ]);
    } finally {
      writeFileSync(target, original);
    }
  });
});

describe("真实记录复制探针（M19/5.3 用）", () => {
  it("复制单条记录+引用资产到新根：可读且其余记录不带过去", () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "mcp2-copy-"));
    copyVerificationRecord(fixture.dataRoot, targetRoot, fixture.ids.pass);
    const copied = getVerification(targetRoot, fixture.ids.pass);
    expect(copied.status).toBe("sealed");
    expect(copied.terminated?.outcome).toBe("passed");
    expect(existsSync(join(targetRoot, "verifications", `${fixture.ids.fail}.jsonl`))).toBe(false);
    expect(readLog(targetRoot, fixture.hashes.passStdout).text).toContain(
      VERIFICATION_SENTINELS.passStdout,
    );
    cleanupVerificationFixtures();
    rmSync(targetRoot, { recursive: true, force: true });
    expect(liveFixtureRootCount()).toBe(0);
  });
});
