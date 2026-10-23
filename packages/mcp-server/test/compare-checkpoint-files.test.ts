import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { compareCheckpointFilesTool } from "../src/query/compare-checkpoint-files.js";
import type { CompareCheckpointFilesData } from "../src/query/compare-checkpoint-files.js";
import type { ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import { contentSha, dirFingerprintRecursive } from "./checkpoint-fixtures.js";
import {
  CF_TEXTS,
  type CompareFixture,
  TOO_LARGE_BYTES,
  buildCompareFixture,
  cleanupCompareFixtures,
} from "./compare-file-fixtures.js";
import { collectKeys } from "./whitelist-assertions.js";

/**
 * MCP0 4.7（Q14 两侧半边 + S10）：`compare_checkpoint_files` 的清单/内容两模式。
 *
 * 判据按「引用与内容分开、逐侧独立、故障不冒充状态」三层钉：
 * - 清单 `reference:"same"` 只是哈希与字节数相同，**不发任何正文**并带 `BODY_NOT_EXPOSED`；
 * - 内容结论由共享层按完整附件核验给出 ⇒ 首 4096 码点完全一样的两条文件，结论仍须 `different`
 *   （按片段判相同就是 S10 明令禁止的那种假结论）；
 * - 两侧格子恒在且同序（坏侧保留真实身份 + 稳定码），`unionComplete:false` 时的空清单
 *   不代表"这些文件不存在"；
 * - 逐侧 `io` 改判 `unavailable{STORAGE_IO, retryable}`，共享层的 errno 原文一个字节都不外发；
 * - 内容模式缺任一侧 ⇒ 整条请求按该侧稳定码失败，**不发半份结论**。
 */

let fx: CompareFixture;
let root: DataRoot;

beforeAll(() => {
  fx = buildCompareFixture();
  root = { dataDir: fx.dataDir, tracesDir: fx.tracesDir };
}, 120_000);

afterAll(() => {
  cleanupCompareFixtures();
});

type Side = { runId: string; stepSpanId?: string | null };
type ManifestData = Extract<CompareCheckpointFilesData, { mode: "manifest" }>;
type ContentData = Extract<CompareCheckpointFilesData, { mode: "content" }>;

async function rawCall(
  left: Side,
  right: Side,
  extra: Record<string, unknown> = {},
): Promise<ToolResult> {
  return compareCheckpointFilesTool.execute({ left, right, ...extra }, root);
}

function envelopeOf(result: ToolResult) {
  expect(result.isError).not.toBe(true);
  return SuccessEnvelopeSchema.parse(result.structuredContent);
}

async function manifest(left: Side, right: Side, extra: Record<string, unknown> = {}) {
  const result = await rawCall(left, right, extra);
  const envelope = envelopeOf(result);
  const data = envelope.data as ManifestData;
  expect(data.mode).toBe("manifest");
  return { data, envelope, result };
}

async function content(left: Side, right: Side, path: string, extra: Record<string, unknown> = {}) {
  const result = await rawCall(left, right, { path, ...extra });
  const envelope = envelopeOf(result);
  const data = envelope.data as ContentData;
  expect(data.mode).toBe("content");
  return { data, envelope, result };
}

async function failure(left: Side, right: Side, extra: Record<string, unknown> = {}) {
  const result = await rawCall(left, right, extra);
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

/** 那一侧必须是可读格：不可读时当场报错，而不是把 union 上的字段当存在 */
function readyAt(data: ManifestData | ContentData, index: 0 | 1) {
  const side = data.sides[index];
  if (side === undefined || side.status !== "ready") {
    throw new Error(`第 ${index} 侧不是 ready`);
  }
  return side;
}

function entryAt(data: ManifestData, path: string) {
  const item = data.entries.find((entry) => entry.path === path);
  if (item === undefined) {
    throw new Error(`本页并集里没有 ${path}`);
  }
  return item;
}

/** beforeAll 里才建好夹具，所以两侧 selector 一律现取（模块级常量会读到未赋值的 fx） */
function bothPoints(): { left: Side; right: Side } {
  return {
    left: { runId: fx.ids.root },
    right: { runId: fx.ids.root, stepSpanId: fx.rootStepSpanId },
  };
}

describe("compare_checkpoint_files：清单模式（引用与内容分开）", () => {
  it("同 run 两 selector：两侧身份各自给出，presence 与 reference 逐条对上", async () => {
    const { data } = await manifest(bothPoints().left, bothPoints().right, { limit: 100 });
    expect(data.sides[0]).toEqual({
      side: "left",
      status: "ready",
      runId: fx.ids.root,
      stepSpanId: null,
      snapshotId: fx.rootInitialSnapshotId,
      initialSnapshotId: fx.rootInitialSnapshotId,
    });
    expect(readyAt(data, 1).stepSpanId).toBe(fx.rootStepSpanId);
    expect(readyAt(data, 1).snapshotId).toBe(fx.rootFinalSnapshotId);
    expect(data.unionComplete).toBe(true);
    expect(data.totals).toEqual({
      paths: fx.unionPathCount,
      listed: fx.unionPathCount,
      remaining: 0,
      limit: 100,
    });

    const shared = entryAt(data, "shared.txt");
    expect(shared.presence).toBe("both");
    expect(shared.reference).toBe("same");
    expect(shared.left).toEqual(shared.right);
    expect(shared.left?.sha256).toBe(contentSha(CF_TEXTS.shared));

    const late = entryAt(data, "late-diff.txt");
    expect(late.reference).toBe("different");
    expect(late.left?.sha256).not.toBe(late.right?.sha256);

    expect(entryAt(data, "left-only.txt")).toMatchObject({
      presence: "left_only",
      right: null,
      reference: null,
    });
    expect(entryAt(data, "right-only.txt")).toMatchObject({
      presence: "right_only",
      left: null,
      reference: null,
    });
  });

  it("清单不出正文：无 text/content/base64/data 键，canary 不外发，带 BODY_NOT_EXPOSED", async () => {
    const { data, envelope } = await manifest(bothPoints().left, bothPoints().right, {
      limit: 100,
    });
    const keys = collectKeys(data);
    expect(["text", "content", "base64", "data"].filter((key) => keys.has(key))).toEqual([]);
    const serialized = JSON.stringify({ data, envelope });
    expect(
      [CF_TEXTS.secretBody, CF_TEXTS.shared, "SENTINEL-", "workspace-blobs"].filter((needle) =>
        serialized.includes(needle),
      ),
    ).toEqual([]);
    expect(
      envelope.limitations.some(
        (item) => item.code === "BODY_NOT_EXPOSED" && item.ref?.startsWith("compare:"),
      ),
    ).toBe(true);
  });

  it("默认页宽 20 生效、如实标 truncated，并签发续读游标（5.2）", async () => {
    const { data, envelope } = await manifest(bothPoints().left, bothPoints().right);
    expect(data.entries).toHaveLength(20);
    expect(data.totals.limit).toBe(20);
    expect(data.totals.paths).toBe(fx.unionPathCount);
    expect(envelope.truncation.truncated).toBe(true);
    expect(envelope.truncation.nextCursor).toBeDefined();
    expect(envelope.page?.nextCursor).toBe(envelope.truncation.nextCursor);

    const one = await manifest(bothPoints().left, bothPoints().right, { limit: 1 });
    expect(one.data.entries).toHaveLength(1);
    expect(one.data.totals.remaining).toBe(fx.unionPathCount - 1);

    const cursor = await failure(bothPoints().left, bothPoints().right, {
      cursor: "opaque-token-value",
    });
    expect(cursor.code).toBe("INVALID_ARGUMENT");
    expect(cursor.ref).toBe("cursor");
    expect(JSON.stringify(cursor)).not.toContain("opaque-token-value");
  });

  it("跨运行比较：来源段给两条物理 run，缺席的 lineage/spanScope = 本次未判定", async () => {
    const { data, envelope } = await manifest(
      { runId: fx.ids.root, stepSpanId: fx.rootStepSpanId },
      { runId: fx.ids.child, stepSpanId: fx.childStepSpanId },
      { limit: 100 },
    );
    expect(envelope.provenance.runs).toEqual([
      { runId: fx.ids.root, formatVersion: 2, sealed: true },
      { runId: fx.ids.child, formatVersion: 2, sealed: true },
    ]);
    expect(readyAt(data, 1).runId).toBe(fx.ids.child);
    expect(readyAt(data, 1).snapshotId).toBe(fx.childFinalSnapshotId);
    expect(entryAt(data, "child-only.txt").presence).toBe("right_only");
    expect(entryAt(data, "shared.txt").reference).toBe("same");
    expect(envelope.provenance.refs).toEqual([
      { runId: fx.ids.root, stepSpanId: fx.rootStepSpanId, snapshotId: fx.rootFinalSnapshotId },
      { runId: fx.ids.child, stepSpanId: fx.childStepSpanId, snapshotId: fx.childFinalSnapshotId },
    ]);
  });

  it("坏侧不吞好侧：v1 侧 unavailable，并集不完整且空清单不代表文件不存在", async () => {
    const { data, envelope } = await manifest(bothPoints().left, { runId: fx.ids.plain });
    expect(data.sides).toHaveLength(2);
    expect(data.sides[1]).toEqual({
      side: "right",
      status: "unavailable",
      runId: fx.ids.plain,
      code: "NO_WORKSPACE",
      message: "该 run 不是隔离运行，没有文件检查点",
      retryable: false,
    });
    expect(data.sides[0]?.status).toBe("ready");
    expect(data.unionComplete).toBe(false);
    expect(data.entries).toEqual([]);
    expect(envelope.truncation.truncated).toBe(false);
    // 只有坏侧被读到 ⇒ 来源段不再声称读过 plain
    expect(envelope.provenance.runs.map((item) => item.runId)).toEqual([fx.ids.root]);
  });

  it("身份错配的一侧给 IDENTITY_MISMATCH（比较层裸码新增的那行映射）", async () => {
    const { data } = await manifest(bothPoints().left, { runId: fx.ids.mismatch });
    const broken = data.sides[1];
    expect(broken?.status).toBe("unavailable");
    if (broken?.status !== "unavailable") return;
    expect(broken.code).toBe("IDENTITY_MISMATCH");
    expect(broken.runId).toBe(fx.ids.mismatch);
    expect(JSON.stringify(data)).not.toContain(fx.ids.mismatchRecordedId);
  });

  it("祖先步骤与缺失 run 各按稳定码标注自己那一侧", async () => {
    const ancestor = await manifest(
      { runId: fx.ids.child, stepSpanId: fx.childStepSpanId },
      { runId: fx.ids.child, stepSpanId: fx.rootStepSpanId },
    );
    expect(ancestor.data.sides[1]?.status).toBe("unavailable");
    if (ancestor.data.sides[1]?.status !== "unavailable") return;
    expect(ancestor.data.sides[1].code).toBe("STEP_NOT_FOUND");
    expect(ancestor.data.unionComplete).toBe(false);

    const missing = await manifest(bothPoints().left, { runId: fx.ids.never });
    if (missing.data.sides[1]?.status !== "unavailable") {
      throw new Error("缺失的一侧必须是 unavailable");
    }
    expect(missing.data.sides[1].code).toBe("RUN_NOT_FOUND");
    expect(missing.data.sides[1].retryable).toBe(false);
  });

  it("未封存的一侧照常可比，并带 TERMINATION_NOT_RECORDED", async () => {
    const { data, envelope } = await manifest(
      { runId: fx.ids.open },
      { runId: fx.ids.root, stepSpanId: fx.rootStepSpanId },
      { limit: 5 },
    );
    expect(data.sides[0]?.status).toBe("ready");
    expect(
      envelope.limitations.some(
        (item) => item.code === "TERMINATION_NOT_RECORDED" && item.ref === `run:${fx.ids.open}`,
      ),
    ).toBe(true);
    expect(envelope.provenance.runs.find((item) => item.runId === fx.ids.open)?.sealed).toBe(false);
    expect(JSON.stringify(data)).not.toContain("仍在运行");
  });

  it("结果里没有任何步骤对齐或评判字段（不按迭代序号猜对应）", async () => {
    const { data } = await manifest(bothPoints().left, bothPoints().right, { limit: 100 });
    const keys = collectKeys(data);
    expect(
      [
        "iteration",
        "alignedSteps",
        "stepIndex",
        "pair",
        "winner",
        "better",
        "fixed",
        "passed",
        "diff",
        "score",
      ].filter((key) => keys.has(key)),
    ).toEqual([]);
    expect(Object.keys(data.sides[0] ?? {})).toEqual([
      "side",
      "status",
      "runId",
      "stepSpanId",
      "snapshotId",
      "initialSnapshotId",
    ]);
  });
});

describe("compare_checkpoint_files：内容模式（逐侧核验，不凭片段判）", () => {
  it("两侧同内容：结论 same、正文逐字、完整文件身份一致", async () => {
    const { data } = await content(bothPoints().left, bothPoints().right, "shared.txt");
    expect(data.conclusion).toBe("same");
    expect(data.textDiffEligible).toBe(true);
    if (data.files.left.status !== "text" || data.files.right.status !== "text") {
      throw new Error("两侧都应是 text 状态");
    }
    expect(data.files.left.text).toBe(CF_TEXTS.shared);
    expect(data.files.right.text).toBe(CF_TEXTS.shared);
    expect(data.files.left.fullFile).toEqual(data.files.right.fullFile);
    expect(data.files.left.fullFile.sha256).toBe(contentSha(CF_TEXTS.shared));
    expect(data.files.left.range.total).toBe([...CF_TEXTS.shared].length);
  });

  it("首 4096 码点完全一样而结论仍须 different（不凭片段判相同）", async () => {
    const { data } = await content(bothPoints().left, bothPoints().right, "late-diff.txt");
    if (data.files.left.status !== "text" || data.files.right.status !== "text") {
      throw new Error("两侧都应是 text 状态");
    }
    // 外发的两段一模一样……
    expect(data.files.left.text).toBe(data.files.right.text);
    expect(data.files.left.range).toEqual({
      start: 0,
      end: 4096,
      total: 5002,
      unit: "unicode-code-point",
    });
    expect(data.files.left.truncated).toBe(true);
    expect(data.files.left.remaining).toBe(906);
    // ……但结论来自完整附件核验，不是来自片段
    expect(data.conclusion).toBe("different");
    expect(data.files.left.fullFile.sha256).not.toBe(data.files.right.fullFile.sha256);
  });

  it("单侧存在：left_only / right_only，缺失那一侧是 not_found 而不是空文件", async () => {
    const leftOnly = await content(bothPoints().left, bothPoints().right, "left-only.txt");
    expect(leftOnly.data.conclusion).toBe("left_only");
    expect(leftOnly.data.files.right.status).toBe("not_found");
    expect(Object.prototype.hasOwnProperty.call(leftOnly.data.files.right, "fullFile")).toBe(false);
    expect(leftOnly.data.textDiffEligible).toBe(true);

    const rightOnly = await content(bothPoints().left, bothPoints().right, "right-only.txt");
    expect(rightOnly.data.conclusion).toBe("right_only");
    expect(rightOnly.data.files.left.status).toBe("not_found");
  });

  it("两侧都没有这条路径：not_found（不是 missing，也不是 corrupt）", async () => {
    const { data } = await content(bothPoints().left, bothPoints().right, "not-in-either.txt");
    expect(data.conclusion).toBe("not_found");
    expect(data.files.left.status).toBe("not_found");
    expect(data.files.right.status).toBe("not_found");
  });

  it("二进制两侧都不给文本，textDiffEligible 为 false", async () => {
    const { data } = await content(bothPoints().left, bothPoints().right, "picture.bin");
    expect(data.conclusion).toBe("same");
    expect(data.textDiffEligible).toBe(false);
    for (const side of [data.files.left, data.files.right]) {
      expect(side.status).toBe("binary");
      if (side.status === "binary") {
        expect(side.fullFile.bytes).toBe(13);
      }
    }
    expect(["text", "encoding", "base64"].filter((key) => collectKeys(data).has(key))).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("\uFFFD");
  });

  it("附件缺失两侧 missing ⇒ 结论 unavailable，不判成 same", async () => {
    const { data } = await content(bothPoints().left, bothPoints().right, "gone.txt");
    expect(data.conclusion).toBe("unavailable");
    expect(data.files.left.status).toBe("missing");
    expect(data.files.right.status).toBe("missing");
    if (data.files.left.status !== "missing") return;
    expect(data.files.left.fullFile.sha256).toBe(contentSha(CF_TEXTS.gone));
  });

  it("篡改两侧 corrupt：两句原因可分辨，且不含物理路径", async () => {
    const { data } = await content(bothPoints().left, bothPoints().right, "tampered.txt");
    expect(data.conclusion).toBe("unavailable");
    if (data.files.left.status !== "corrupt" || data.files.right.status !== "corrupt") {
      throw new Error("两侧都应是 corrupt");
    }
    expect(data.files.left.reason).toContain("哈希");
    expect(data.files.left.reason).not.toContain("长度");
    expect(JSON.stringify(data)).not.toContain(fx.blobsDir);
  });

  it("清单声明超限：too_large 且不读字节、不冒充空文本", async () => {
    const { data } = await content(bothPoints().left, bothPoints().right, "huge.txt");
    expect(data.conclusion).toBe("unavailable");
    if (data.files.left.status !== "too_large") throw new Error("该侧应是 too_large");
    expect(data.files.left.fullFile.bytes).toBe(TOO_LARGE_BYTES);
    expect(data.files.left.reason).toContain("上限");
    expect(["text", "encoding"].filter((key) => collectKeys(data).has(key))).toEqual([]);
  });

  it("附件位置是目录 ⇒ 逐侧 unavailable + STORAGE_IO，errno 原文一个字节都不外发", async () => {
    const { data } = await content(bothPoints().left, bothPoints().right, "dir-blocked.txt");
    expect(data.conclusion).toBe("unavailable");
    for (const side of [data.files.left, data.files.right]) {
      if (side.status !== "unavailable") throw new Error("该侧应是 unavailable");
      expect(side.code).toBe("STORAGE_IO");
      expect(side.message).toBe("存储读取失败，可稍后重试");
      expect(side.retryable).toBe(true);
    }
    const serialized = JSON.stringify(data);
    expect(
      ["I/O 故障", fx.dataDir, fx.blobsDir, "workspace-blobs"].filter((n) =>
        serialized.includes(n),
      ),
    ).toEqual([]);
  });

  it("maxChars 逐侧独立生效：短的一侧不被另一侧补", async () => {
    const { data } = await content(bothPoints().left, bothPoints().right, "left-only.txt", {
      maxChars: 4,
    });
    if (data.files.left.status !== "text") throw new Error("左侧应是 text");
    expect(data.files.left.text).toBe("只在初始");
    expect(data.files.left.remaining).toBe([...CF_TEXTS.leftOnly].length - 4);
    expect(data.files.right.status).toBe("not_found");
    expect(["text", "remaining"].filter((key) => collectKeys(data.files.right).has(key))).toEqual(
      [],
    );
  });

  it("缺任一侧就不发半份结论：内容模式按该侧稳定码失败", async () => {
    const error = await failure(bothPoints().left, { runId: fx.ids.plain }, { path: "shared.txt" });
    expect(error.code).toBe("NO_WORKSPACE");
    expect(error.ref).toContain(`run:${fx.ids.plain}`);
    expect(error.ref).toContain("path:shared.txt");
  });

  it("正文只随显式 path 出门：同清单里别的文件一条字节都不带", async () => {
    const { data, envelope } = await content(bothPoints().left, bothPoints().right, "shared.txt");
    if (data.files.left.status !== "text") throw new Error("请求的那一侧应是 text");
    // 逐字判据走字段本身：JSON.stringify 会把换行转义，序列化子串判据会假红
    expect(data.files.left.text).toBe(CF_TEXTS.shared);
    const serialized = JSON.stringify({ data, envelope });
    expect(
      [
        CF_TEXTS.secretBody,
        CF_TEXTS.leftLate,
        "SENTINEL-cf-tool-result",
        "SENTINEL-cf-fork-edit-value",
      ].filter((needle) => serialized.includes(needle)),
    ).toEqual([]);
  });
});

describe("compare_checkpoint_files：入参边界与不变性", () => {
  it("同一份检查点不能自比；同一 run 的两份检查点可以比", async () => {
    const self = await failure(
      { runId: fx.ids.root, stepSpanId: fx.rootStepSpanId },
      { runId: fx.ids.root, stepSpanId: fx.rootStepSpanId },
    );
    expect(self.code).toBe("INVALID_ARGUMENT");
    expect(self.ref).toBe("left/right");

    const implicitSelf = await failure(
      { runId: fx.ids.root },
      { runId: fx.ids.root, stepSpanId: undefined },
    );
    expect(implicitSelf.ref).toBe("left/right");

    const twoPoints = await manifest(
      { runId: fx.ids.root },
      { runId: fx.ids.root, stepSpanId: fx.rootStepSpanId },
    );
    expect(twoPoints.data.unionComplete).toBe(true);
  });

  it("逐侧字段的非法形状在读取前拒，ref 指到具体字段", async () => {
    const cases: readonly [Side, Side, string][] = [
      [{ runId: "../outside" }, { runId: fx.ids.root }, "left.runId"],
      [{ runId: fx.ids.root }, { runId: "C:/Windows/system32" }, "right.runId"],
      [
        { runId: fx.ids.root },
        { runId: fx.ids.child, stepSpanId: "s_01\u0000" },
        "right.stepSpanId",
      ],
    ];
    for (const [left, right, ref] of cases) {
      const error = await failure(left, right);
      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(error.ref).toBe(ref);
    }
    // 超出上限的长度由 strict schema 拦下（给不了字段级 ref），且不回显取值
    const tooLongStep = await rawCall(
      { runId: fx.ids.root },
      { runId: fx.ids.child, stepSpanId: "s".repeat(129) },
    );
    expect(tooLongStep.isError).toBe(true);
    const tooLong = ErrorEnvelopeSchema.parse(tooLongStep.structuredContent).error;
    expect(tooLong.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(tooLong)).not.toContain("s".repeat(129));

    const badPath = await failure(bothPoints().left, bothPoints().right, {
      path: "notes/../../escape",
    });
    expect(badPath.code).toBe("INVALID_ARGUMENT");
    expect(badPath.ref).toBe("path");
  });

  it("数组形状与未知键由契约拒（左右必须是对象）", async () => {
    const result = await compareCheckpointFilesTool.execute(
      { left: [{ runId: fx.ids.root }], right: { runId: fx.ids.child } },
      root,
    );
    expect(result.isError).toBe(true);
    const error = ErrorEnvelopeSchema.parse(result.structuredContent).error;
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(error)).not.toContain(fx.ids.root);
  });

  it("同参两次逐字相同；path 与 limit 都进 readVersion", async () => {
    const first = await manifest(bothPoints().left, bothPoints().right, { limit: 3 });
    const second = await manifest(bothPoints().left, bothPoints().right, { limit: 3 });
    const strip = (envelope: ReturnType<typeof envelopeOf>) =>
      JSON.stringify({ ...envelope, observedAt: "fixed" });
    expect(strip(second.envelope)).toBe(strip(first.envelope));

    const otherLimit = await manifest(bothPoints().left, bothPoints().right, { limit: 4 });
    expect(otherLimit.envelope.readVersion).not.toBe(first.envelope.readVersion);

    const contentRun = await content(bothPoints().left, bothPoints().right, "shared.txt");
    expect(contentRun.envelope.readVersion).not.toBe(first.envelope.readVersion);
  });

  it("七次查询前后目录递归指纹不变，结果不含宿主路径与内部目录名", async () => {
    const before = dirFingerprintRecursive(fx.dataDir);
    await manifest(bothPoints().left, bothPoints().right, { limit: 100 });
    await content(bothPoints().left, bothPoints().right, "shared.txt");
    await content(bothPoints().left, bothPoints().right, "late-diff.txt");
    await content(bothPoints().left, bothPoints().right, "dir-blocked.txt");
    await content(bothPoints().left, bothPoints().right, "huge.txt");
    await failure(bothPoints().left, { runId: fx.ids.plain }, { path: "shared.txt" });
    await manifest({ runId: fx.ids.root, stepSpanId: fx.rootStepSpanId }, { runId: fx.ids.child });
    expect(dirFingerprintRecursive(fx.dataDir)).toBe(before);

    const serialized = JSON.stringify(
      (await content(bothPoints().left, bothPoints().right, "gone.txt")).data,
    );
    expect(
      [fx.dataDir, fx.blobsDir, "workspace-blobs", "traces/", ".jsonl"].filter((needle) =>
        serialized.includes(needle),
      ),
    ).toEqual([]);
  });
});
