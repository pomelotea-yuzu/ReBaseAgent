import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Translator } from "@rebaseagent/i18n";
import { afterAll, describe, expect, it } from "vitest";
import { getVerificationTool } from "../src/query/get-verification.js";
import { listVerificationsTool } from "../src/query/list-verifications.js";
import { readVerificationArtifactTool } from "../src/query/read-verification-artifact.js";
import { readVerificationLogTool } from "../src/query/read-verification-log.js";
import type { DataRoot } from "../src/startup.js";
import { ZH } from "./test-locale.js";
import {
  VERIFICATION_SENTINELS,
  type VerificationFixture,
  buildVerificationFixture,
  cleanupVerificationFixtures,
  VERIFICATION_FIXTURE_IDS as ids,
} from "./verification-fixtures.js";

/**
 * MCP2 tasks 4.1：游标与来源一致性（M12）。
 *
 * 判据（design D6）：
 * - 台账（verifications/environments/assets/**traces**）任一变化 ⇒ 续读 STALE_CURSOR；
 * - 附件替换/删除 ⇒ STALE_CURSOR（哈希绑定在 extra）；
 * - 篡改/换工具/换参数 ⇒ INVALID_ARGUMENT（cursor.ts 判据，验证工具直用）；
 * - 无进展不发新游标。
 */

const fixture: VerificationFixture = buildVerificationFixture();

afterAll(() => {
  cleanupVerificationFixtures();
});

const root: DataRoot = { dataDir: fixture.dataRoot, tracesDir: fixture.tracesDir };

async function invoke(
  tool: {
    execute: (
      args: Readonly<Record<string, unknown>>,
      root: DataRoot,
      translator: Translator,
    ) => Promise<CallToolResult>;
  },
  args: Record<string, unknown>,
  rootOverride?: DataRoot,
): Promise<CallToolResult> {
  return tool.execute(args, rootOverride ?? root, ZH);
}

function envOf(result: CallToolResult): {
  page?: { nextCursor: string };
  data: Record<string, unknown>;
} {
  expect(result.isError).not.toBe(true);
  return result.structuredContent as never;
}

function errorCode(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: { code: string } }).error.code;
}

describe("来源变化使游标失效（M12）", () => {
  it("list 翻页前新增记录 ⇒ STALE_CURSOR（候选集合变化）", async () => {
    const page1 = envOf(await invoke(listVerificationsTool, { limit: 3 }));
    const cursor = page1.page?.nextCursor;
    expect(cursor).toBeDefined();
    // 新增一条记录（经 writer 形态写一个合法新文件）
    const { VerificationRecordWriter } = await import("@rebaseagent/project-verification");
    const w = VerificationRecordWriter.open(fixture.dataRoot, {
      verificationId: "ver-m12-new",
      epoch: "ep_m12",
      operationId: "op_m12",
      target: { runId: "run-m12", checkpoint: { kind: "initial" }, snapshotId: "snap-m12" },
      profileId: "node-ts-v1",
      manifestVersion: 1,
      commandId: "test",
      planBindingDigest: "a".repeat(64),
      createdAt: "2026-10-25T01:00:00.000Z",
    });
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    const page2 = await invoke(listVerificationsTool, { limit: 3, cursor });
    expect(errorCode(page2)).toBe("STALE_CURSOR");
  });

  it("get 事件索引翻页前来源 trace 变化 ⇒ STALE_CURSOR（参与来源台账）", async () => {
    const page1 = envOf(await invoke(getVerificationTool, { verificationId: ids.pass, limit: 1 }));
    const cursor = page1.page?.nextCursor;
    if (cursor === undefined) return; // 只有一条事件时无可续读
    // 追加来源 trace 字节（traces 台账变化）
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(fixture.tracesDir, "run-m2-pass.jsonl"), '{"touch":true}\n');
    const page2 = await invoke(getVerificationTool, { verificationId: ids.pass, limit: 1, cursor });
    expect(errorCode(page2)).toBe("STALE_CURSOR");
  });

  it("日志翻页前附件被替换 ⇒ STALE_CURSOR（哈希绑定 + 台账）", async () => {
    const page1 = envOf(
      await invoke(readVerificationLogTool, {
        verificationId: ids.fail,
        commandId: "test",
        stream: "stdout",
        maxChars: 100,
      }),
    );
    const cursor = page1.page?.nextCursor;
    expect(cursor).toBeDefined();
    // 原地改写附件字节（size 不变，mtime 变化 ⇒ 台账变化）
    const { readFileSync, writeFileSync } = await import("node:fs");
    const recordText = readFileSync(
      join(fixture.dataRoot, "verifications", `${ids.fail}.jsonl`),
      "utf8",
    );
    const hash = /"stdout":\{"byteLength":\d+,"totalBytes":\d+,"sha256":"([0-9a-f]{64})"/.exec(
      recordText,
    )?.[1];
    expect(hash).toBeDefined();
    const assetFile = join(fixture.dataRoot, "verification-assets", "sha256", hash ?? "");
    const original = readFileSync(assetFile);
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0] === 0x41 ? 0x42 : 0x41;
    writeFileSync(assetFile, tampered);
    const page2 = await invoke(readVerificationLogTool, {
      verificationId: ids.fail,
      commandId: "test",
      stream: "stdout",
      maxChars: 100,
      cursor,
    });
    expect(errorCode(page2)).toBe("STALE_CURSOR");
  });

  it("产物续读前附件删除 ⇒ STALE_CURSOR；无进展不发新游标", async () => {
    // 独立根：避免污染共享 fixture 的产物（pass 的正文测试还要用）
    const { copyVerificationRecord } = await import("./verification-fixtures.js");
    const copyRoot = mkdtempSync(join(tmpdir(), "mcp2-m12-"));
    copyVerificationRecord(fixture.dataRoot, copyRoot, ids.pass);
    const copyTraces = join(copyRoot, "traces");
    mkdirSync(copyTraces, { recursive: true });
    const copyRootArg: DataRoot = { dataDir: copyRoot, tracesDir: copyTraces };

    const page1 = envOf(
      await invoke(
        readVerificationArtifactTool,
        {
          verificationId: ids.pass,
          path: "report.json",
          maxChars: 5,
        },
        copyRootArg,
      ),
    );
    expect(page1.page?.nextCursor).toBeDefined();

    // 尾页：读完无剩余 ⇒ 无 nextCursor（进展守卫）
    const last = envOf(
      await invoke(
        readVerificationArtifactTool,
        {
          verificationId: ids.pass,
          path: "report.json",
          maxChars: 8192,
        },
        copyRootArg,
      ),
    );
    expect(last.page?.nextCursor).toBeUndefined();

    const { unlinkSync } = await import("node:fs");
    const recordText = (await import("node:fs")).readFileSync(
      join(copyRoot, "verifications", `${ids.pass}.jsonl`),
      "utf8",
    );
    const hash = /"path":"report.json","size":\d+,"sha256":"([0-9a-f]{64})"/.exec(recordText)?.[1];
    expect(hash).toBeDefined();
    unlinkSync(join(copyRoot, "verification-assets", "sha256", hash ?? ""));
    const page2 = await invoke(
      readVerificationArtifactTool,
      {
        verificationId: ids.pass,
        path: "report.json",
        maxChars: 5,
        cursor: page1.page?.nextCursor,
      },
      copyRootArg,
    );
    expect(errorCode(page2)).toBe("STALE_CURSOR");
  });
});

describe("游标不被异参/篡改接受（M12 形状半边）", () => {
  it("换参数用旧游标 ⇒ INVALID_ARGUMENT；换工具 ⇒ INVALID_ARGUMENT；篡改载荷 ⇒ INVALID_ARGUMENT", async () => {
    const page1 = envOf(await invoke(listVerificationsTool, { limit: 3 }));
    const cursor = page1.page?.nextCursor ?? "";
    expect(errorCode(await invoke(listVerificationsTool, { limit: 4, cursor }))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(
      errorCode(
        await invoke(getVerificationTool, {
          verificationId: ids.pass,
          limit: 3,
          cursor,
        }),
      ),
    ).toBe("INVALID_ARGUMENT");
    const parts = cursor.split(".");
    parts[2] = Buffer.from(
      '{"v":1,"t":"list_verifications","p":"x","r":"y","k":"items","o":[9]}',
    ).toString("base64url");
    expect(
      errorCode(await invoke(listVerificationsTool, { limit: 3, cursor: parts.join(".") })),
    ).toBe("INVALID_ARGUMENT");
  });
});
