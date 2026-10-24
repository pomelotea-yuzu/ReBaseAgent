import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FILE_TOOLS_V1_DEFINITIONS, createIsolatedRun } from "@rebaseagent/replay";
import { readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  canonicalAttachmentsDigest,
  matchesNodeTsV1SourceGlob,
  precheckVerificationSource,
  sourceFactsMatch,
} from "../src/source/precheck.js";

/**
 * 集成夹具：真实编排（`createIsolatedRun` + 一轮无工具剧本）产出**已封存的 v2 隔离
 * 根 run**——初始快照 = 源目录导入结果。预检的拒绝分支都在这份真件上做定向破坏。
 */

const CALC_TS = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

function writeTree(dir: string, tree: Record<string, string>): void {
  for (const [relative, content] of Object.entries(tree)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function stubLlm() {
  return {
    complete: async () => ({
      response: {
        content: "done",
        reasoningContent: null,
        toolCalls: [],
        usage: { in: 1, out: 1 },
        ttftMs: 1,
      },
      requestBody: {},
    }),
  } as unknown as Parameters<typeof createIsolatedRun>[0]["llm"];
}

interface Fixture {
  dataDir: string;
  source: string;
  runId: string;
  traceFile: string;
}

async function makeRun(tree: Record<string, string>): Promise<Fixture> {
  const source = mkdtempSync(join(tmpdir(), "r3-pv-src-"));
  writeTree(source, tree);
  const dataDir = join(mkdtempSync(join(tmpdir(), "r3-pv-data-")), "data");
  const created = await createIsolatedRun({
    dataDir,
    source,
    config: {
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      model: "deepseek-chat",
      systemPrompt: "你是文件助手。",
      tools: [...FILE_TOOLS_V1_DEFINITIONS],
      params: undefined,
      exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
      maxIterations: 10,
      budget: { maxTotalTokens: 100000 },
    },
    userMessage: "R3 预检夹具",
    authority: { allowFileWrites: true },
    llm: stubLlm(),
  });
  if (!created.ok) {
    throw new Error(`夹具创建失败：${created.failure.code} ${created.failure.reason}`);
  }
  return {
    dataDir,
    source,
    runId: created.id,
    traceFile: join(dataDir, "traces", `${created.id}.jsonl`),
  };
}

function firstStepSpanId(fixture: Fixture): string {
  const record = readRun(fixture.traceFile);
  const step = record.spans.find((span) => span.kind === "agent.step");
  if (step === undefined) {
    throw new Error("夹具缺少 agent.step");
  }
  return step.id;
}

function blobFile(dataDir: string, hash: string): string {
  return join(dataDir, "workspace-blobs", "sha256", hash);
}

describe("受支持源码面判定（W02）", () => {
  it("src 下的 .ts 放行，其余明确拒绝", () => {
    expect(matchesNodeTsV1SourceGlob("src/calc.ts")).toBe(true);
    expect(matchesNodeTsV1SourceGlob("src/deep/nested/mod.ts")).toBe(true);
    expect(matchesNodeTsV1SourceGlob("a.txt")).toBe(false);
    expect(matchesNodeTsV1SourceGlob("package.json")).toBe(false);
    expect(matchesNodeTsV1SourceGlob("src/calc.js")).toBe(false);
    expect(matchesNodeTsV1SourceGlob("src/node_modules/x.ts")).toBe(false);
    expect(matchesNodeTsV1SourceGlob("src/.hidden/x.ts")).toBe(false);
    expect(matchesNodeTsV1SourceGlob("src/.ts")).toBe(false);
  });
});

describe("预检：显式检查点与全量复核（P05/P06）", () => {
  it("initial 检查点通过：快照/附件摘要、文件数与字节", async () => {
    const f = await makeRun({ "src/calc.ts": CALC_TS });
    const r = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "initial" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stepSpanId).toBeNull();
    expect(r.value.fileCount).toBe(1);
    expect(r.value.totalBytes).toBe(Buffer.byteLength(CALC_TS));
    expect(r.value.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.value.attachmentsManifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.value.files[0]?.path).toBe("src/calc.ts");
  });

  it("step 检查点通过并回填自有 stepSpanId（P05：显式选择）", async () => {
    const f = await makeRun({ "src/calc.ts": CALC_TS });
    const stepId = firstStepSpanId(f);
    const r = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "step", stepSpanId: stepId },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.stepSpanId).toBe(stepId);
    }
  });

  it("未知步骤拒绝（含祖先/非 step 的同一入口语义）", async () => {
    const f = await makeRun({ "src/calc.ts": CALC_TS });
    const r = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "step", stepSpanId: "s_99" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("step_not_found");
    }
  });

  it("run 不存在拒绝", async () => {
    const f = await makeRun({ "src/calc.ts": CALC_TS });
    const r = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: "run_absent",
      checkpoint: { kind: "initial" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("run_not_found");
    }
  });

  it("未封存（终止事件被移除）拒绝：source_not_sealed", async () => {
    const f = await makeRun({ "src/calc.ts": CALC_TS });
    const lines = readFileSync(f.traceFile, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    const withoutLast = lines.slice(0, -1);
    writeFileSync(f.traceFile, `${withoutLast.join("\n")}\n`);
    const r = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "initial" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("source_not_sealed");
    }
  });

  it("清单含受支持面之外的文件拒绝：template_incompatible", async () => {
    const f = await makeRun({ "src/calc.ts": CALC_TS, "a.txt": "旁观文件" });
    const r = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "initial" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("template_incompatible");
      expect(r.failure.reason).toContain("a.txt");
    }
  });

  it("附件缺失拒绝：attachment_missing（副作用前暴露）", async () => {
    const f = await makeRun({ "src/calc.ts": CALC_TS });
    const first = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "initial" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const hash = first.value.files[0]?.sha256;
    if (hash === undefined) throw new Error("缺文件哈希");
    unlinkSync(blobFile(f.dataDir, hash));
    const r = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "initial" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("attachment_missing");
    }
  });

  it("附件字节被篡改拒绝：attachment_corrupt", async () => {
    const f = await makeRun({ "src/calc.ts": CALC_TS });
    const first = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "initial" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const hash = first.value.files[0]?.sha256;
    if (hash === undefined) throw new Error("缺文件哈希");
    writeFileSync(blobFile(f.dataDir, hash), "tampered-bytes");
    const r = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "initial" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("attachment_corrupt");
    }
  });
});

describe("宿主源目录漂移与重核（W01/P07）", () => {
  it("宿主源文件变化不影响预检：只读历史清单与附件", async () => {
    const f = await makeRun({ "src/calc.ts": CALC_TS });
    const before = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "initial" },
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    writeFileSync(join(f.source, "src", "calc.ts"), "宿主同名文件后来变了");
    unlinkSync(join(f.source, "src", "calc.ts"));
    const after = await precheckVerificationSource({
      dataDir: f.dataDir,
      runId: f.runId,
      checkpoint: { kind: "initial" },
    });
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(sourceFactsMatch(before.value, after.value)).toBe(true);
      expect(after.value.files[0]?.sha256).toBe(before.value.files[0]?.sha256);
    }
  });

  it("漂移重核：任一摘要变化即不匹配", () => {
    const a = { snapshotId: "a".repeat(64), attachmentsManifestDigest: "b".repeat(64) };
    expect(sourceFactsMatch(a, { ...a })).toBe(true);
    expect(sourceFactsMatch(a, { ...a, snapshotId: "c".repeat(64) })).toBe(false);
    expect(sourceFactsMatch(a, { ...a, attachmentsManifestDigest: "d".repeat(64) })).toBe(false);
  });

  it("附件清单摘要是规范序列化的函数（同输入同输出、变输入变输出）", () => {
    const files = [{ path: "src/a.ts", sha256: "1".repeat(64), bytes: 3 }];
    const d1 = canonicalAttachmentsDigest(files);
    expect(canonicalAttachmentsDigest([...files])).toBe(d1);
    expect(
      canonicalAttachmentsDigest([{ path: "src/a.ts", sha256: "2".repeat(64), bytes: 3 }]),
    ).not.toBe(d1);
  });
});
