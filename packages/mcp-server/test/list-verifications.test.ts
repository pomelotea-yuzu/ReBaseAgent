import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { SuccessEnvelopeSchema } from "../src/envelope.js";
import { listVerificationsTool } from "../src/query/list-verifications.js";
import type { DataRoot } from "../src/startup.js";
import { ZH } from "./test-locale.js";
import {
  type VerificationFixture,
  buildVerificationFixture,
  cleanupVerificationFixtures,
  VERIFICATION_FIXTURE_IDS as ids,
} from "./verification-fixtures.js";

/**
 * MCP2 tasks 3.1：list_verifications（M01/M02/M03 的工具面）。
 *
 * 判据（design D2）：
 * - 筛选只作用可判定摘要；失败项/坏项不因筛选消失、占额度且只出现一次；
 * - 排序沿用 scan（createdAt 倒序 + UTF-16 码元升序，失败项末尾）；
 * - 游标翻页可完整重建，无重漏；
 * - 信封 verifications provenance 只带验证身份，runs 恒空（M01：不进 run 域）。
 */

const fixture: VerificationFixture = buildVerificationFixture();

// 非法名文件在全部测试前就位（fixture 本身没有 IO 失败/非法名项）
mkdirSync(join(fixture.dataRoot, "verifications"), { recursive: true });
writeFileSync(join(fixture.dataRoot, "verifications", "XX_BAD.jsonl"), "{}\n");

afterAll(() => {
  cleanupVerificationFixtures();
});

const root: DataRoot = {
  dataDir: fixture.dataRoot,
  tracesDir: fixture.tracesDir,
};

function call(): void {}

async function invoke(
  args: Record<string, unknown>,
  rootOverride?: DataRoot,
): Promise<CallToolResult> {
  return listVerificationsTool.execute(args, rootOverride ?? root, ZH);
}

function envelopeOf(result: CallToolResult): {
  data: {
    filter: { runId: string | null; status: string | null; outcome: string | null };
    items: Array<Record<string, unknown>>;
    totals: Record<string, number>;
  };
  provenance: { runs: unknown[]; refs: unknown[]; verifications?: Array<Record<string, unknown>> };
  page?: { nextCursor: string };
  limitations: Array<Record<string, unknown>>;
} {
  expect(result.isError).not.toBe(true);
  const parsed = SuccessEnvelopeSchema.parse(result.structuredContent) as {
    data: {
      filter: { runId: string | null; status: string | null; outcome: string | null };
      items: Array<Record<string, unknown>>;
      totals: Record<string, number>;
    };
    provenance: {
      runs: unknown[];
      refs: unknown[];
      verifications?: Array<Record<string, unknown>>;
    };
    page?: { nextCursor: string };
    limitations: Array<Record<string, unknown>>;
  };
  return parsed;
}

describe("list_verifications：全量与排序（M02）", () => {
  it("默认列出全部具名记录；损坏/未知版本以 status 保留；失败项在末尾", async () => {
    const env = envelopeOf(await invoke({}));
    const items = env.data.items;
    const verificationIds = items
      .filter((item) => item.kind === "verification")
      .map((item) => item.verificationId);
    // createdAt 倒序：pass/fail（T0+0 同刻）在前，后续同刻组按 ID 升序
    expect(verificationIds).toContain(ids.pass);
    expect(verificationIds).toContain(ids.fail);
    const badtail = items.find((item) => item.verificationId === ids.badTail);
    expect(badtail?.status).toBe("corrupt");
    const oldver = items.find((item) => item.verificationId === ids.oldVersion);
    expect(oldver?.status).toBe("unsupported_version");
    const last = items[items.length - 1];
    expect(last?.kind).toBe("unreadable_file");
  });

  it("非法名文件作为失败项出现一次，非 .jsonl 不出现", async () => {
    writeFileSync(join(fixture.dataRoot, "verifications", "notes.txt"), "x");
    const env = envelopeOf(await invoke({}));
    const files = env.data.items
      .filter((item) => item.kind === "unreadable_file")
      .map((item) => item.file);
    expect(files).toEqual(["XX_BAD.jsonl"]);
    const kinds = env.data.items.map((item) => item.kind);
    expect(kinds).not.toContain("notes.txt");
  });

  it("runId/status/outcome 精确筛选；失败项不因筛选消失（M02/M03）", async () => {
    const byRun = envelopeOf(await invoke({ runId: "run-m2-pass" }));
    const runItems = byRun.data.items.filter((item) => item.kind === "verification");
    expect(runItems).toHaveLength(1);
    expect(runItems[0]?.verificationId).toBe(ids.pass);

    const byOutcome = envelopeOf(await invoke({ outcome: "check_failed" }));
    const failed = byOutcome.data.items.filter(
      (item) => item.kind === "verification" && item.outcome === "check_failed",
    );
    expect(failed.map((item) => item.verificationId)).toEqual([ids.fail]);

    // 筛选命中 0 条也不吞失败项
    const none = envelopeOf(await invoke({ runId: "run-nonexistent" }));
    expect(none.data.items.filter((item) => item.kind === "verification")).toHaveLength(0);
    expect(none.data.items.some((item) => item.kind === "unreadable_file")).toBe(true);
  });

  it("分页跨页完整重建：无重无漏，游标绑定参数（M02）", async () => {
    const page1 = envelopeOf(await invoke({ limit: 4 }));
    expect(page1.data.items).toHaveLength(4);
    expect(page1.page?.nextCursor).toBeDefined();
    const page2 = envelopeOf(await invoke({ limit: 4, cursor: page1.page?.nextCursor ?? "" }));
    const page3 = envelopeOf(await invoke({ limit: 4, cursor: page2.page?.nextCursor ?? "" }));
    const all = [
      ...page1.data.items.map((item) => JSON.stringify(item)),
      ...page2.data.items.map((item) => JSON.stringify(item)),
      ...page3.data.items.map((item) => JSON.stringify(item)),
    ];
    expect(new Set(all).size).toBe(all.length);
    // 重建结果与单页全量一致
    const full = envelopeOf(await invoke({}));
    expect(all).toEqual(full.data.items.map((item) => JSON.stringify(item)));
  });

  it("换参数用旧游标被拒（INVALID_ARGUMENT）", async () => {
    const page1 = envelopeOf(await invoke({ limit: 4 }));
    const bad = await invoke({ limit: 5, cursor: page1.page?.nextCursor ?? "" });
    expect(bad.isError).toBe(true);
  });

  it("provenance.verifications 只带验证身份，runs 恒空（M01）", async () => {
    const env = envelopeOf(await invoke({}));
    expect(env.provenance.runs).toEqual([]);
    expect(env.provenance.verifications?.length ?? 0).toBeGreaterThan(0);
    for (const entry of env.provenance.verifications ?? []) {
      const keys = Object.keys(entry).sort();
      expect(keys).toContain("verificationId");
      expect(keys).toContain("status");
      expect(keys.every((key) => ["runId", "status", "verificationId"].includes(key))).toBe(true);
    }
  });

  it("空目录（无 verifications/）= 合法空列表且不建目录（M03）", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const emptyRoot: DataRoot = {
      dataDir: mkdtempSync(join(tmpdir(), "mcp2-empty-")),
      tracesDir: join(mkdtempSync(join(tmpdir(), "mcp2-empty-t-")), "traces"),
    };
    const env = envelopeOf(await invoke({}, emptyRoot));
    expect(env.data.items).toEqual([]);
    expect(env.data.totals.listed).toBe(0);
  });
});

void call;
