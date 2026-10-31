import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Translator } from "@rebaseagent/i18n";
import { afterAll, describe, expect, it } from "vitest";
import { SuccessEnvelopeSchema } from "../src/envelope.js";
import { compareVerificationsTool } from "../src/query/compare-verifications.js";
import { getVerificationTool } from "../src/query/get-verification.js";
import { inspectVerificationArtifactsTool } from "../src/query/inspect-verification-artifacts.js";
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
 * MCP2 tasks 3.2–3.6：五个工具的实现面（M04–M11/M14–M16 的工具半边）。
 * fixture 见 verification-fixtures.ts（tasks 1.3 建立的具名记录矩阵）。
 */

const fixture: VerificationFixture = buildVerificationFixture();

afterAll(() => {
  cleanupVerificationFixtures();
});

const root: DataRoot = { dataDir: fixture.dataRoot, tracesDir: fixture.tracesDir };

// 专用记录：一条产物完好、一条产物被改写（其余 fixture 记录没有 artifacts 事件）
const artIds = { ok: "ver-m2-artok", bad: "ver-m2-artbad" };
{
  const { VerificationRecordWriter, publishAsset } = await import(
    "@rebaseagent/project-verification"
  );
  for (const id of [artIds.ok, artIds.bad]) {
    const w = VerificationRecordWriter.open(fixture.dataRoot, {
      verificationId: id,
      epoch: `ep_${id}`,
      operationId: `op_${id}`,
      target: { runId: `run_${id}`, checkpoint: { kind: "initial" }, snapshotId: `snap-${id}` },
      profileId: "node-ts-v1",
      manifestVersion: 1,
      commandId: "test",
      planBindingDigest: "a".repeat(64),
      createdAt: "2026-10-25T00:00:00.000Z",
    });
    // 两条记录的产物内容不同 ⇒ 内容寻址哈希不同，改写互不影响
    const corruptible = id === artIds.ok ? "ok-dta" : "data";
    w.append({
      type: "artifacts",
      entries: [
        {
          path: "good.txt",
          size: 4,
          sha256: publishAsset(fixture.dataRoot, new TextEncoder().encode("good")).sha256,
        },
        {
          path: "to-corrupt.txt",
          size: corruptible.length,
          sha256: publishAsset(fixture.dataRoot, new TextEncoder().encode(corruptible)).sha256,
        },
      ],
      excludedPatterns: ["node_modules/**"],
      totalBytes: 4 + corruptible.length,
    });
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
  }
  const { readFileSync, writeFileSync } = await import("node:fs");
  const recordText = readFileSync(
    join(fixture.dataRoot, "verifications", `${artIds.bad}.jsonl`),
    "utf8",
  );
  const hashes = [...recordText.matchAll(/"sha256":"([0-9a-f]{64})"/g)].map((m) => m[1]);
  const target = hashes[hashes.length - 1];
  if (target !== undefined) {
    writeFileSync(join(fixture.dataRoot, "verification-assets", "sha256", target), "TAMPERED");
  }
}

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

function envOf(result: CallToolResult): Record<string, unknown> & {
  data: Record<string, unknown>;
  provenance: { runs: unknown[]; verifications?: Array<Record<string, unknown>> };
  limitations: Array<{ code: string; message: string }>;
  page?: { nextCursor: string };
} {
  expect(result.isError).not.toBe(true);
  return SuccessEnvelopeSchema.parse(result.structuredContent) as never;
}

function errorOf(result: CallToolResult): { code: string; message: string } {
  expect(result.isError).toBe(true);
  const parsed = SuccessEnvelopeSchema.safeParse(result.structuredContent);
  if (parsed.success) throw new Error("期待失败信封，实得成功信封");
  const envelope = result.structuredContent as { error: { code: string; message: string } };
  return envelope.error;
}

// ---------------------------------------------------------------------------
// get_verification（3.2 / M04–M07）
// ---------------------------------------------------------------------------

describe("get_verification（3.2）", () => {
  it("sealed 记录：身份/实际命令/历史环境/封存结局按记录读取（M04）", async () => {
    const env = envOf(await invoke(getVerificationTool, { verificationId: ids.pass }));
    const data = env.data as Record<string, unknown> & {
      status: string;
      meta: Record<string, unknown>;
      terminated: Record<string, unknown> | null;
      commands: Array<Record<string, unknown>>;
      sourceStatus: string;
      eventIndex: { total: number; items: unknown[] };
    };
    expect(data.status).toBe("sealed");
    expect(data.meta).toMatchObject({
      runId: "run-m2-pass",
      profileId: "node-ts-v1",
      commandId: "test",
      snapshotId: `snap-${ids.pass}`,
    });
    expect((data.meta.environment as Record<string, unknown>).preparationId).toBe(
      `prep-${ids.pass}`,
    );
    expect(data.terminated).toMatchObject({ outcome: "passed", evidenceComplete: true });
    expect(data.commands).toHaveLength(1);
    expect(data.commands[0]).toMatchObject({
      commandId: "test",
      executable: "/usr/local/bin/node",
      cwd: "/workspace",
      exitCode: 0,
    });
    expect(data.sourceStatus).toBe("present");
    // 正文不在默认响应里（无日志/产物正文）
    expect(JSON.stringify(env.data)).not.toContain(VERIFICATION_SENTINELS.passStdout);
  });

  it("旧记录缺 environment：保持 null + limitation，不拿当前补齐（M04）", async () => {
    const env = envOf(await invoke(getVerificationTool, { verificationId: ids.oldEnv }));
    const data = env.data as { meta: Record<string, unknown>; terminated: unknown };
    expect(data.meta.environment).toBeNull();
    const codes = env.limitations.map((item) => item.code);
    expect(codes).toContain("VERIFICATION_ENVIRONMENT_UNKNOWN");
  });

  it("unterminated：terminated=null + limitation；interrupted 只给计数（M05）", async () => {
    const env = envOf(await invoke(getVerificationTool, { verificationId: ids.unterm }));
    const data = env.data as {
      status: string;
      terminated: unknown;
      interrupted: Record<string, number> | null;
    };
    expect(data.status).toBe("unterminated");
    expect(data.terminated).toBeNull();
    expect(data.interrupted).toMatchObject({ stoppedCount: 1, unconfirmedCount: 1 });
    expect(env.limitations.map((item) => item.code)).toContain("VERIFICATION_UNTERMINATED");
    expect(JSON.stringify(env.data)).not.toContain("c0ffee1");
  });

  it("坏记录是成功诊断：corrupt/未知版本给 status+diagnostic，terminated=null（M05）", async () => {
    for (const id of [ids.badTail, ids.oldVersion]) {
      const env = envOf(await invoke(getVerificationTool, { verificationId: id }));
      const data = env.data as {
        status: string;
        terminated: unknown;
        diagnostic: { lineIndex: number; reason: string } | null;
      };
      expect(data.terminated).toBeNull();
      expect(data.diagnostic).not.toBeNull();
    }
  });

  it("不存在/来源缺失：NOT_FOUND 稳定码 / SOURCE_MISSING limitation（M07）", async () => {
    const missing = await invoke(getVerificationTool, { verificationId: "ver-nonexist" });
    expect(errorOf(missing).code).toBe("VERIFICATION_NOT_FOUND");
    const gone = envOf(await invoke(getVerificationTool, { verificationId: ids.goneSource }));
    expect((gone.data as { sourceStatus: string }).sourceStatus).toBe("missing");
    expect(gone.limitations.map((item) => item.code)).toContain("VERIFICATION_SOURCE_MISSING");
  });

  it("事件索引分页可续读且换参游标被拒（M04/D6）", async () => {
    const page1 = envOf(await invoke(getVerificationTool, { verificationId: ids.pass, limit: 1 }));
    const index1 = page1.data as {
      eventIndex: { total: number; remaining: number; items: unknown[] };
    };
    expect(index1.eventIndex.items).toHaveLength(1);
    if (index1.eventIndex.remaining > 0) {
      expect(page1.page?.nextCursor).toBeDefined();
      const page2 = envOf(
        await invoke(getVerificationTool, {
          verificationId: ids.pass,
          limit: 1,
          cursor: page1.page?.nextCursor,
        }),
      );
      const index2 = page2.data as { eventIndex: { items: unknown[] } };
      expect(index2.eventIndex.items).toHaveLength(1);
    }
    const bad = await invoke(getVerificationTool, {
      verificationId: ids.fail,
      limit: 1,
      cursor: page1.page?.nextCursor,
    });
    expect(bad.isError).toBe(true);
  });

  it("provenance：verifications 带记录身份，runs 恒空（M01/D3）", async () => {
    const env = envOf(await invoke(getVerificationTool, { verificationId: ids.pass }));
    expect(env.provenance.runs).toEqual([]);
    expect(env.provenance.verifications?.[0]).toMatchObject({
      verificationId: ids.pass,
      status: "sealed",
      runId: "run-m2-pass",
      commandId: "test",
      preparationId: `prep-${ids.pass}`,
    });
  });
});

// ---------------------------------------------------------------------------
// read_verification_log（3.3 / M08/M10/M11）
// ---------------------------------------------------------------------------

describe("read_verification_log（3.3）", () => {
  it("正文单次承载：content 含原文，structuredContent 只有 bodyIn 指针（M10/M11）", async () => {
    const result = await invoke(readVerificationLogTool, {
      verificationId: ids.pass,
      commandId: "test",
      stream: "stdout",
    });
    const env = envOf(result);
    const body = (env.data as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({ kind: "text", bodyIn: "content", encoding: "utf8-text" });
    const contentText = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(contentText).toContain(VERIFICATION_SENTINELS.passStdout);
    expect(JSON.stringify(env.data)).not.toContain(VERIFICATION_SENTINELS.passStdout);
    // capture 双口径与 fullAsset 分开：pass 记录无截断，观测=保留
    const capture = (env.data as { capture: Record<string, number> }).capture;
    expect(capture.retainedBytes).toBeGreaterThan(0);
    expect(capture.observedBytes).toBe(capture.retainedBytes);
  });

  it("capture 截断：limitation 常驻，读完保留部分也不消除（M10）", async () => {
    const page1 = envOf(
      await invoke(readVerificationLogTool, {
        verificationId: ids.fail,
        commandId: "test",
        stream: "stdout",
        maxChars: 100,
      }),
    );
    expect(page1.limitations.map((item) => item.code)).toContain("VERIFICATION_CAPTURE_TRUNCATED");
    const body1 = (page1.data as { body: { truncated: boolean; remaining: number } }).body;
    expect(body1.truncated).toBe(true);
    // 逐页读完保留部分：capture 截断仍在
    let cursor: string | undefined = page1.page?.nextCursor;
    let rounds = 0;
    while (cursor !== undefined && rounds < 50) {
      const page = envOf(
        await invoke(readVerificationLogTool, {
          verificationId: ids.fail,
          commandId: "test",
          stream: "stdout",
          maxChars: 100,
          cursor,
        }),
      );
      expect(page.limitations.map((item) => item.code)).toContain("VERIFICATION_CAPTURE_TRUNCATED");
      cursor = page.page?.nextCursor;
      rounds += 1;
    }
    expect(cursor).toBeUndefined();
  });

  it("码点续读：区间连续覆盖 [0,total)，content 无替换字符（M10/M11）", async () => {
    let cursor: string | undefined;
    const ranges: Array<[number, number]> = [];
    let total = -1;
    let rounds = 0;
    let sawEmojiOrCjk = false;
    do {
      const result = await invoke(readVerificationLogTool, {
        verificationId: ids.fail,
        commandId: "test",
        stream: "stdout",
        maxChars: 700,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const env = envOf(result);
      const body = (env.data as { body: { range: { start: number; end: number; total: number } } })
        .body;
      ranges.push([body.range.start, body.range.end]);
      total = body.range.total;
      const contentText = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(contentText).not.toContain("\uFFFD");
      if (/[\u4e00-\u9fff\u{1F600}-\u{1F64F}]/u.test(contentText)) sawEmojiOrCjk = true;
      cursor = env.page?.nextCursor;
      rounds += 1;
      expect(rounds).toBeLessThan(30);
    } while (cursor !== undefined);
    expect(sawEmojiOrCjk).toBe(true);
    // 区间连续、无重无漏
    ranges.sort((a, b) => a[0] - b[0]);
    expect(ranges[0]?.[0]).toBe(0);
    expect(ranges[ranges.length - 1]?.[1]).toBe(total);
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index]?.[0]).toBe(ranges[index - 1]?.[1]);
    }
  });

  it("未记录/缺失/坏记录/歧义分类（M08）", async () => {
    const notRecorded = await invoke(readVerificationLogTool, {
      verificationId: ids.unterm,
      commandId: "test",
      stream: "stdout",
    });
    expect(errorOf(notRecorded).code).toBe("VERIFICATION_LOG_NOT_RECORDED");

    const missing = await invoke(readVerificationLogTool, {
      verificationId: ids.missingAsset,
      commandId: "test",
      stream: "stdout",
    });
    expect(errorOf(missing).code).toBe("VERIFICATION_ASSET_MISSING");

    const corrupt = await invoke(readVerificationLogTool, {
      verificationId: ids.badTail,
      commandId: "test",
      stream: "stdout",
    });
    expect(errorOf(corrupt).code).toBe("VERIFICATION_RECORD_INVALID");

    const ambiguous = await invoke(readVerificationLogTool, {
      verificationId: ids.dupCommand,
      commandId: "test",
      stream: "stdout",
    });
    expect(errorOf(ambiguous).code).toBe("VERIFICATION_PATH_REJECTED");

    const notFound = await invoke(readVerificationLogTool, {
      verificationId: "ver-nonexist",
      commandId: "test",
      stream: "stdout",
    });
    expect(errorOf(notFound).code).toBe("VERIFICATION_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// inspect_verification_artifacts / read_verification_artifact（3.4/3.5 / M09/M11）
// ---------------------------------------------------------------------------

describe("inspect_verification_artifacts（3.4）", () => {
  it("清单逐项可用性：available/corrupt 分类，排除规则带出（M09）", async () => {
    const env = envOf(
      await invoke(inspectVerificationArtifactsTool, { verificationId: artIds.ok }),
    );
    const data = env.data as {
      totals: Record<string, number>;
      excludedPatterns: string[];
      items: Array<{
        path: string;
        availability: string;
        declaredBytes: number;
        actualBytes: number | null;
      }>;
    };
    expect(data.totals.entries).toBe(2);
    expect(data.totals.available).toBe(2);
    expect(data.excludedPatterns).toEqual(["node_modules/**"]);
    const item = data.items.find((entry) => entry.path === "good.txt");
    expect(item?.actualBytes).toBe(item?.declaredBytes);

    const bad = envOf(
      await invoke(inspectVerificationArtifactsTool, { verificationId: artIds.bad }),
    );
    const badData = bad.data as { totals: Record<string, number> };
    expect(badData.totals.available).toBe(1);
    expect(badData.totals.corrupt).toBe(1);
  });

  it("未采集（无 artifacts 事件）受控失败，与合法空清单分开（M09）", async () => {
    const notRecorded = await invoke(inspectVerificationArtifactsTool, {
      verificationId: ids.unterm,
    });
    expect(errorOf(notRecorded).code).toBe("VERIFICATION_ARTIFACTS_NOT_RECORDED");
    const ok = envOf(await invoke(inspectVerificationArtifactsTool, { verificationId: artIds.ok }));
    expect((ok.data as { totals: { entries: number } }).totals.entries).toBe(2);
  });
});

describe("read_verification_artifact（3.5）", () => {
  it("清单内 path 文本读取：核验 + 码点正文（M09/M11）", async () => {
    const result = await invoke(readVerificationArtifactTool, {
      verificationId: ids.pass,
      path: "report.json",
    });
    const env = envOf(result);
    expect(env.data).toMatchObject({
      selector: { path: "report.json" },
      excludedPatterns: ["node_modules/**", ".git/**"],
    });
    const contentText = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(contentText).toContain(VERIFICATION_SENTINELS.artifactText);
  });

  it("二进制产物只给元数据（M11）", async () => {
    const result = await invoke(readVerificationArtifactTool, {
      verificationId: ids.pass,
      path: "blob.bin",
    });
    const env = envOf(result);
    expect((env.data as { body: { kind: string } }).body.kind).toBe("binary");
    const contentText = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(contentText.includes("\u0000")).toBe(false);
  });

  it("清单外 path 拒绝；坏记录读产物受控拒绝（M08）", async () => {
    const outside = await invoke(readVerificationArtifactTool, {
      verificationId: ids.pass,
      path: "elsewhere.txt",
    });
    expect(errorOf(outside).code).toBe("VERIFICATION_ARTIFACT_NOT_FOUND");

    const dupPath = await invoke(readVerificationArtifactTool, {
      verificationId: ids.dupPath,
      path: "same.txt",
    });
    expect(errorOf(dupPath).code).toBe("VERIFICATION_PATH_REJECTED");

    const corrupt = await invoke(readVerificationArtifactTool, {
      verificationId: ids.oldVersion,
      path: "anything.txt",
    });
    expect(errorOf(corrupt).code).toBe("VERIFICATION_RECORD_INVALID");
  });
});

// ---------------------------------------------------------------------------
// compare_verifications（3.6 / M14–M16）
// ---------------------------------------------------------------------------

describe("compare_verifications（3.6）", () => {
  it("同条件失败→通过：verdict failed-to-passed，全部条件 same（M14）", async () => {
    const env = envOf(
      await invoke(compareVerificationsTool, {
        left: { verificationId: ids.fail },
        right: { verificationId: ids.pass },
      }),
    );
    const data = env.data as {
      verdict: { kind: string };
      conditions: Array<{ key: string; state: string }>;
      expectedSnapshotIds: { left: string; right: string };
      left: {
        availability: string;
        outcome: string | null;
        currentAssetsAvailable: boolean | null;
      };
      right: {
        availability: string;
        outcome: string | null;
        currentAssetsAvailable: boolean | null;
      };
    };
    expect(data.verdict.kind).toBe("failed-to-passed");
    expect(data.conditions.every((condition) => condition.state === "same")).toBe(true);
    expect(data.expectedSnapshotIds).toEqual({
      left: `snap-${ids.fail}`,
      right: `snap-${ids.pass}`,
    });
    expect(data.left.currentAssetsAvailable).toBe(true);
    expect(data.right.currentAssetsAvailable).toBe(true);
  });

  it("旧缺 environment 一侧 ⇒ conditions-unknown，不补齐（M15）", async () => {
    const env = envOf(
      await invoke(compareVerificationsTool, {
        left: { verificationId: ids.fail },
        right: { verificationId: ids.oldEnv },
      }),
    );
    expect((env.data as { verdict: { kind: string } }).verdict.kind).toBe("conditions-unknown");
  });

  it("一侧不存在/未封存 ⇒ unavailable + outcome-unknown，另一侧仍可查（M16）", async () => {
    const missing = envOf(
      await invoke(compareVerificationsTool, {
        left: { verificationId: "ver-nonexist" },
        right: { verificationId: ids.pass },
      }),
    );
    const data = missing.data as {
      left: { availability: string; verificationId: string };
      right: { availability: string };
      verdict: { kind: string };
    };
    expect(data.left.availability).toBe("unavailable");
    expect(data.left.verificationId).toBe("ver-nonexist");
    expect(data.right.availability).toBe("ready");
    expect(data.verdict.kind).toBe("outcome-unknown");

    const unterm = envOf(
      await invoke(compareVerificationsTool, {
        left: { verificationId: ids.unterm },
        right: { verificationId: ids.pass },
      }),
    );
    expect((unterm.data as { verdict: { kind: string } }).verdict.kind).toBe("outcome-unknown");
  });

  it("必需资产后来缺失 ⇒ evidence-incomplete（当前资产门，M16）", async () => {
    // missingAsset 记录 sealed/passed 但 stdout 附件缺失 ⇒ currentAssetsAvailable=false
    const env = envOf(
      await invoke(compareVerificationsTool, {
        left: { verificationId: ids.missingAsset },
        right: { verificationId: ids.fail },
      }),
    );
    const data = env.data as {
      verdict: { kind: string };
      evidenceIncomplete: { fromCurrentAssets: boolean; fromRecord: boolean };
      left: { currentAssetsAvailable: boolean | null };
    };
    expect(data.left.currentAssetsAvailable).toBe(false);
    expect(data.verdict.kind).toBe("evidence-incomplete");
    expect(data.evidenceIncomplete.fromCurrentAssets).toBe(true);
  });

  it("同 ID / 非法入参拒绝（M08 形状）", async () => {
    const same = await invoke(compareVerificationsTool, {
      left: { verificationId: ids.pass },
      right: { verificationId: ids.pass },
    });
    expect(errorOf(same).code).toBe("INVALID_ARGUMENT");
    const bad = await invoke(compareVerificationsTool, {
      left: { verificationId: ids.pass, dataDir: "D:/x" },
      right: { verificationId: ids.fail },
    });
    expect(bad.isError).toBe(true);
  });
});

// re-import guard：fixture 路径探针（防止误改 fixture 目录结构后静默全绿）
describe("fixture 根前提", () => {
  it("traces 与 verifications 同根（DataRoot 契约）", () => {
    expect(root.tracesDir).toBe(join(fixture.dataRoot, "traces"));
  });
});
