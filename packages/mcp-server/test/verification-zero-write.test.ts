import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { compareVerificationsTool } from "../src/query/compare-verifications.js";
import { getVerificationTool } from "../src/query/get-verification.js";
import { inspectVerificationArtifactsTool } from "../src/query/inspect-verification-artifacts.js";
import { listVerificationsTool } from "../src/query/list-verifications.js";
import { readVerificationArtifactTool } from "../src/query/read-verification-artifact.js";
import { readVerificationLogTool } from "../src/query/read-verification-log.js";
import type { DataRoot } from "../src/startup.js";
import {
  type RootFingerprint,
  type VerificationFixture,
  buildVerificationFixture,
  cleanupVerificationFixtures,
  VERIFICATION_FIXTURE_IDS as ids,
  rootFingerprintDiff,
  snapshotRootFingerprint,
} from "./verification-fixtures.js";

/**
 * MCP2 tasks 4.4：全链零写入指纹（M17 的进程内半边）。
 *
 * - 六工具全链（列表翻页/详情/日志续读/产物/比较/受控失败）跑在一个含未封存记录
 *   与残留 runtime 登记的数据根上，前后整根指纹逐字相同；
 * - 取消/EOF/重连的 stdio 生命周期由 MCP1 既有 stdio-lifecycle 覆盖（服务层机制
 *   与工具无关）；「执行/模型/导出/登记调用为零」的实机计数在 5.1/5.3 采集。
 */

const fixture: VerificationFixture = buildVerificationFixture();

afterAll(() => {
  cleanupVerificationFixtures();
});

const root: DataRoot = { dataDir: fixture.dataRoot, tracesDir: fixture.tracesDir };

async function invoke(
  tool: {
    execute: (args: Readonly<Record<string, unknown>>, root: DataRoot) => Promise<CallToolResult>;
  },
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return tool.execute(args, root);
}

describe("六工具全链零写入（M17 进程内半边）", () => {
  it("全链跑完（含翻页与受控失败），整根指纹逐字未动", async () => {
    const baseline: RootFingerprint = snapshotRootFingerprint(fixture.dataRoot);

    // list 全量 + 翻页
    await invoke(listVerificationsTool, {});
    const page1 = await invoke(listVerificationsTool, { limit: 3 });
    const cursor1 = (page1.structuredContent as { page?: { nextCursor: string } }).page?.nextCursor;
    if (cursor1 !== undefined) {
      await invoke(listVerificationsTool, { limit: 3, cursor: cursor1 });
    }
    // 换参游标（受控失败路径）
    await invoke(listVerificationsTool, { limit: 4, cursor: cursor1 });

    // get：sealed/缺环境/未封存/坏记录/不存在
    for (const id of [ids.pass, ids.oldEnv, ids.unterm, ids.badTail, ids.oldVersion]) {
      await invoke(getVerificationTool, { verificationId: id });
    }
    await invoke(getVerificationTool, { verificationId: "ver-nonexist" });

    // log：正文 + 续读 + 失败分类
    const log1 = await invoke(readVerificationLogTool, {
      verificationId: ids.fail,
      commandId: "test",
      stream: "stdout",
      maxChars: 500,
    });
    const logCursor = (log1.structuredContent as { page?: { nextCursor: string } }).page
      ?.nextCursor;
    if (logCursor !== undefined) {
      await invoke(readVerificationLogTool, {
        verificationId: ids.fail,
        commandId: "test",
        stream: "stdout",
        maxChars: 500,
        cursor: logCursor,
      });
    }
    await invoke(readVerificationLogTool, {
      verificationId: ids.missingAsset,
      commandId: "test",
      stream: "stdout",
    });

    // artifacts：inspect + read
    await invoke(inspectVerificationArtifactsTool, { verificationId: ids.pass });
    await invoke(readVerificationArtifactTool, {
      verificationId: ids.pass,
      path: "report.json",
    });

    // compare：正常对 + 单侧不可用
    await invoke(compareVerificationsTool, {
      left: { verificationId: ids.fail },
      right: { verificationId: ids.pass },
    });
    await invoke(compareVerificationsTool, {
      left: { verificationId: "ver-nonexist" },
      right: { verificationId: ids.pass },
    });

    const after = snapshotRootFingerprint(fixture.dataRoot);
    expect(rootFingerprintDiff(baseline, after)).toEqual([]);
    // 残留 runtime 登记与未封存记录逐字未动（由指纹涵盖；显式再点一次名）
    expect(after.entries["verification-runtime/owner-m2.json"]).toBeDefined();
    expect(after.entries[`verifications/${ids.unterm}.jsonl`]).toEqual(
      baseline.entries[`verifications/${ids.unterm}.jsonl`],
    );
  });

  it("只读失败路径也不留痕：异常请求前后指纹一致", async () => {
    const baseline = snapshotRootFingerprint(fixture.dataRoot);
    await invoke(readVerificationLogTool, {
      verificationId: ids.dupCommand,
      commandId: "test",
      stream: "stdout",
    });
    await invoke(readVerificationArtifactTool, {
      verificationId: ids.dupPath,
      path: "same.txt",
    });
    await invoke(getVerificationTool, { verificationId: "ver-../escape" });
    const after = snapshotRootFingerprint(fixture.dataRoot);
    expect(rootFingerprintDiff(baseline, after)).toEqual([]);
  });
});

describe("M17 边界声明", () => {
  it("数据根布局锚定：traces 与 verifications 同根，取消/EOF 属 stdio 服务层", () => {
    expect(root.tracesDir).toBe(join(fixture.dataRoot, "traces"));
  });
});
