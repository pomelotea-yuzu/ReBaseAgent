import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { inspectCheckpointTool } from "../src/query/inspect-checkpoint.js";
import { readCheckpointFileTool } from "../src/query/read-checkpoint-file.js";
import type { ReadCheckpointFileData } from "../src/query/read-checkpoint-file.js";
import type { ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import {
  BINARY_BYTES,
  type CheckpointFixture,
  FILE_TEXTS,
  buildCheckpointFixture,
  bytesSha,
  cleanupCheckpointFixtures,
  contentSha,
  dirFingerprintRecursive,
} from "./checkpoint-fixtures.js";
import { LONG_BODY, LONG_BODY_EMOJI_START } from "./query-fixtures.js";
import { collectKeys } from "./whitelist-assertions.js";

/**
 * MCP0 4.6（Q14 + S05「指定历史文件」那一半）：`read_checkpoint_file` 的原文保真、
 * 码点范围、六种状态与 selector 绑定。
 *
 * 判据分四层：
 * - **原文保真**：CRLF 原样、尾随换行原样、无尾换行不加、空文件是空串（不是 not_found、
 *   不是 null）；换行一律不规范。
 * - **范围按 Unicode 码点**：上限正好落在代理对中间时也必须发出**完整**码点序列，
 *   并以「UTF-16 单元数 ≠ 码点数」为正面证据（按单元切的实现会当场变红）。
 * - **完整文件与片段分得开**：`fullFile.bytes/sha256` 属于磁盘上那份历史文件，
 *   `range.total` 属于外发文本；两者不互相冒充（design D6/D7）。
 * - **状态不合并**：`not_found`（清单里没有）、`missing`（附件不在）、`corrupt`（附件不符）
 *   各自独立且带 selector；「请求本身不成立」的 `rejected` 升成稳定码 + 失败信封，
 *   真实 I/O 故障是 `STORAGE_IO`（可重试），绝不伪装成某一种文件状态。
 */

let fx: CheckpointFixture;
let root: DataRoot;

beforeAll(() => {
  fx = buildCheckpointFixture();
  root = { dataDir: fx.dataDir, tracesDir: fx.tracesDir };
}, 120_000);

afterAll(() => {
  cleanupCheckpointFixtures();
});

async function callRead(
  runId: string,
  path: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return readCheckpointFileTool.execute({ runId, path, ...args }, root);
}

interface OkRead {
  readonly data: ReadCheckpointFileData;
  readonly envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>;
}

async function okRead(runId: string, path: string, args: Record<string, unknown> = {}) {
  const result = await callRead(runId, path, args);
  expect(result.isError).not.toBe(true);
  const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
  return { data: envelope.data as ReadCheckpointFileData, envelope };
}

async function failureOf(runId: string, path: string, args: Record<string, unknown> = {}) {
  const result = await callRead(runId, path, args);
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

/** 文本态的窄类型：判据里直接取 text/range，非文本态当场编译不过 */
function asText(data: ReadCheckpointFileData) {
  if (data.file.status !== "text") {
    throw new Error(`期望 text 状态，实际是 ${data.file.status}`);
  }
  return data.file;
}

/** 二进制态的窄类型：这一支只有大小与哈希，编译器挡得住「顺手取正文」的写法 */
function asBinary(data: ReadCheckpointFileData) {
  if (data.file.status !== "binary") {
    throw new Error(`期望 binary 状态，实际是 ${data.file.status}`);
  }
  return data.file;
}

describe("read_checkpoint_file：原文保真与码点范围（Q14）", () => {
  it("CRLF 与尾随换行逐字外发，不做任何规范化", async () => {
    const { data } = await okRead(fx.ids.root, "notes/crlf.txt");
    const text = asText(data);
    expect(text.encoding).toBe("utf8-text");
    expect(text.text).toBe(FILE_TEXTS.crlf);
    expect(text.text).toContain("\r\n");
    expect(text.text.endsWith("\r\n")).toBe(true);
    expect(text.range).toEqual({
      start: 0,
      end: 10,
      total: 10,
      unit: "unicode-code-point",
    });
    expect(text.truncated).toBe(false);
    expect(text.remaining).toBe(0);
  });

  it("空文件是空串，不是「未找到」也不是 null", async () => {
    const { data } = await okRead(fx.ids.root, "empty.txt");
    const text = asText(data);
    expect(text.text).toBe("");
    expect(text.range).toEqual({ start: 0, end: 0, total: 0, unit: "unicode-code-point" });
    expect(text.fullFile).toEqual({ bytes: 0, sha256: contentSha("") });
  });

  it("无尾换行的文件不会被补上换行", async () => {
    const { data } = await okRead(fx.ids.root, "noeol.txt");
    const text = asText(data);
    expect(text.text).toBe(FILE_TEXTS.noeol);
    expect(text.text.endsWith("\n")).toBe(false);
  });

  it("长正文默认切 4096 码点，剩余与截断如实标注", async () => {
    const { data, envelope } = await okRead(fx.ids.root, "long.txt");
    const text = asText(data);
    expect(text.range).toEqual({
      start: 0,
      end: 4096,
      total: 5041,
      unit: "unicode-code-point",
    });
    expect(text.truncated).toBe(true);
    expect(text.remaining).toBe(945);
    expect(envelope.truncation.truncated).toBe(true);
    // 完整文件的字节数与哈希属于整份历史文件，不充当片段的校验值
    expect(text.fullFile).toEqual({
      bytes: Buffer.byteLength(LONG_BODY, "utf8"),
      sha256: contentSha(LONG_BODY),
    });
    expect([...text.text].length).toBe(4096);
  });

  it("上限落在代理对中间时仍发完整码点：单元数与码点数不等且无半个字符", async () => {
    const { data } = await okRead(fx.ids.root, "long.txt", { maxChars: LONG_BODY_EMOJI_START + 1 });
    const text = asText(data);
    // 5020 个码点里含一个代理对 ⇒ UTF-16 单元数比码点数多 1；按单元切的实现在这里会切断字符
    expect([...text.text].length).toBe(LONG_BODY_EMOJI_START + 1);
    expect(text.text.length).toBe(LONG_BODY_EMOJI_START + 2);
    expect(text.text.endsWith("🙂")).toBe(true);
    expect(text.text.charCodeAt(text.text.length - 1)).not.toBe(0xd83d);
    expect(text.range.end).toBe(LONG_BODY_EMOJI_START + 1);
    expect(text.remaining).toBe(5041 - (LONG_BODY_EMOJI_START + 1));
  });

  it("maxChars 超上限由契约拒；无法验证的游标同样被拒且不回显取值", async () => {
    const tooBig = await failureOf(fx.ids.root, "long.txt", { maxChars: 8193 });
    expect(tooBig.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(tooBig)).not.toContain("8193");

    const cursor = await failureOf(fx.ids.root, "long.txt", { cursor: "opaque-token-value" });
    expect(cursor.code).toBe("INVALID_ARGUMENT");
    expect(cursor.ref).toBe("cursor");
    expect(JSON.stringify(cursor)).not.toContain("opaque-token-value");
  });
});

describe("read_checkpoint_file：状态与 selector 绑定（Q13）", () => {
  it("清单里没有这条路径 ⇒ not_found，没有 fullFile（不当空文件）", async () => {
    const { data } = await okRead(fx.ids.root, "not-in-manifest.txt");
    expect(data.file.status).toBe("not_found");
    expect(Object.prototype.hasOwnProperty.call(data.file, "fullFile")).toBe(false);
    expect(data.selector.path).toBe("not-in-manifest.txt");
    expect(data.selector.snapshotId).toBe(fx.rootInitialSnapshotId);
  });

  it("附件缺失 ⇒ missing 并保留清单记录的字节与哈希；不读当前目录里的同名新文件", async () => {
    const { data } = await okRead(fx.ids.root, "gone.txt");
    expect(data.file.status).toBe("missing");
    if (data.file.status !== "missing") return;
    expect(data.file.fullFile).toEqual({
      bytes: Buffer.byteLength(FILE_TEXTS.gone, "utf8"),
      sha256: contentSha(FILE_TEXTS.gone),
    });
    const serialized = JSON.stringify(data);
    expect(
      ["今天的版本", "workspace-blobs", "sha256/"].filter((n) => serialized.includes(n)),
    ).toEqual([]);
  });

  it("长度不符与哈希不符都是 corrupt，但两句原因可分辨", async () => {
    const lengthCase = await okRead(fx.ids.root, "tampered-len.txt");
    const hashCase = await okRead(fx.ids.root, "tampered-hash.txt");
    if (lengthCase.data.file.status !== "corrupt" || hashCase.data.file.status !== "corrupt") {
      throw new Error("两种篡改都必须判 corrupt");
    }
    expect(lengthCase.data.file.reason).not.toBe(hashCase.data.file.reason);
    expect(lengthCase.data.file.reason).toContain("长度");
    expect(hashCase.data.file.reason).toContain("哈希");
    // 原因里给的是哈希值与长度数字，不是附件的物理位置
    expect(lengthCase.data.file.reason).not.toContain(fx.blobsDir);
  });

  it("二进制只给大小与哈希：没有 text/encoding 键，也没有替换字符", async () => {
    const { data } = await okRead(fx.ids.root, "picture.bin");
    expect(data.file.status).toBe("binary");
    const binary = asBinary(data);
    expect(binary.fullFile).toEqual({
      bytes: BINARY_BYTES.byteLength,
      sha256: bytesSha(BINARY_BYTES),
    });
    const keys = collectKeys(data);
    expect(["text", "encoding", "base64", "data"].filter((key) => keys.has(key))).toEqual([]);
    // 有损解码的指纹：替换字符一旦出现就说明二进制被当文本解过
    expect(JSON.stringify(data)).not.toContain("\uFFFD");
  });

  it("省略与显式 selector 不互换：同一逻辑路径读到的是各自检查点的版本", async () => {
    const initial = await okRead(fx.ids.root, "noeol.txt");
    const stepped = await okRead(fx.ids.root, "noeol.txt", { stepSpanId: fx.rootStepSpanId });
    expect(asText(initial.data).text).toBe(FILE_TEXTS.noeol);
    expect(asText(stepped.data).text).toBe(FILE_TEXTS.modified);
    expect(initial.data.selector.stepSpanId).toBeNull();
    expect(stepped.data.selector.stepSpanId).toBe(fx.rootStepSpanId);
    expect(initial.data.selector.snapshotId).toBe(fx.rootInitialSnapshotId);
    expect(stepped.data.selector.snapshotId).toBe(fx.rootFinalSnapshotId);
  });

  it("分支 run 的初始 = 它自己的那份（= 父的轮末清单），祖先步骤一律 STEP_NOT_FOUND", async () => {
    const childInitial = await okRead(fx.ids.child, "added.txt");
    expect(childInitial.data.selector.snapshotId).toBe(fx.rootFinalSnapshotId);
    expect(childInitial.data.selector.stepSpanId).toBeNull();
    expect(asText(childInitial.data).text).toBe(FILE_TEXTS.added);

    const ancestor = await failureOf(fx.ids.child, "notes/crlf.txt", {
      stepSpanId: fx.rootStepSpanId,
    });
    expect(ancestor.code).toBe("STEP_NOT_FOUND");
    expect(ancestor.ref).toContain(`step:${fx.rootStepSpanId}`);
  });

  it("v1 非隔离 / 缺失 run / 损坏记录 / 身份错配各按稳定码收口", async () => {
    expect((await failureOf(fx.ids.plain, "a.txt")).code).toBe("NO_WORKSPACE");
    expect((await failureOf(fx.ids.never, "a.txt")).code).toBe("RUN_NOT_FOUND");
    expect((await failureOf(fx.ids.corrupt, "a.txt")).code).toBe("RUN_INVALID");
    expect((await failureOf(fx.ids.mismatch, "a.txt")).code).toBe("RUN_INVALID");
  });

  it("附件位置被目录顶替 ⇒ STORAGE_IO 且 retryable，不冒充 missing/corrupt", async () => {
    const error = await failureOf(fx.ids.ioRun, "weird.txt");
    expect(error.code).toBe("STORAGE_IO");
    expect(error.retryable).toBe(true);
    expect(JSON.stringify(error)).not.toContain(fx.dataDir);
  });

  it("非法逻辑路径在读取前拒（本层比桌面严），合法但不在清单里的仍是 not_found", async () => {
    /**
     * schema 放行、语义非法的那些才由本层逐字段拒——`../` 段、盘符/冒号、NUL、绝对路径、
     * 反斜杠都是长度合法的字符串，但绝不能参与定位（design D3 + Q05）。
     * 桌面对同样请求仍按既有语义得到 `not_found`（3.2 已钉），本层严是外部输入的要求，
     * 不是把判据搬回共享层。
     */
    for (const path of [
      "../outside",
      "notes/../../escape",
      "C:/Windows/system32/config",
      "a\u0000b",
      "/absolute/path.txt",
      "back\\slash.txt",
    ]) {
      const error = await failureOf(fx.ids.root, path);
      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(error.ref).toBe("path");
    }

    // 超上限（4096）由 strict schema 直接拒，且不回显被拒取值
    const tooLong = `${"deep/".repeat(900)}x.txt`;
    const shape = await failureOf(fx.ids.root, tooLong);
    expect(shape.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(shape)).not.toContain(tooLong);

    /**
     * 形状合法但清单里没有：这是数据状态，不是参数问题。
     * `sha256/<hash>` 这种**长得像存储布局**的路径同样只是普通逻辑路径——附件物理位置
     * 由已校验哈希推导，逻辑路径永不参与拼接（所以它只会是 not_found，不会读到附件本体）。
     */
    for (const path of ["sub/dir/not-listed.txt", "sha256/deadbeef"]) {
      const inside = await okRead(fx.ids.root, path);
      expect(inside.data.file.status).toBe("not_found");
      expect(inside.data.selector.path).toBe(path);
    }
  });
});

describe("read_checkpoint_file：正文边界、来源与零写入", () => {
  it("正文只随显式 path 出门：同清单里别的文件一条字节都不带", async () => {
    const { data, envelope } = await okRead(fx.ids.root, "notes/crlf.txt");
    // 请求的那一条确实外发了（这是「按需读正文」真的通了，不是只挡住了）
    expect(asText(data).text).toBe(FILE_TEXTS.crlf);
    const serialized = JSON.stringify({ data, envelope });
    expect(
      [
        FILE_TEXTS.fileBodyCanary,
        FILE_TEXTS.noeol,
        "SENTINEL-long-body-",
        "SENTINEL-cp-tool-result",
        "SENTINEL-cp-fork-edit-value",
        "SENTINEL-cp-system-body",
      ].filter((needle) => serialized.includes(needle)),
    ).toEqual([]);
  });

  it("清单头与正文同一条快照：refs 的 {runId, stepSpanId, snapshotId, path} 与 inspect 逐项相同", async () => {
    const read = await okRead(fx.ids.root, "same.txt", { stepSpanId: fx.rootStepSpanId });
    const inspected = await inspectCheckpointTool.execute(
      { runId: fx.ids.root, stepSpanId: fx.rootStepSpanId },
      root,
    );
    const inspectEnvelope = SuccessEnvelopeSchema.parse(inspected.structuredContent);
    expect(read.envelope.provenance.runs).toEqual(inspectEnvelope.provenance.runs);
    expect(read.envelope.provenance.refs).toEqual([
      {
        runId: fx.ids.root,
        stepSpanId: fx.rootStepSpanId,
        snapshotId: fx.rootFinalSnapshotId,
        path: "same.txt",
      },
    ]);
    expect(read.data.checkpointTotals).toEqual({
      fileCount: (inspectEnvelope.data as { checkpoint: { fileCount: number } }).checkpoint
        .fileCount,
      totalBytes: (inspectEnvelope.data as { checkpoint: { totalBytes: number } }).checkpoint
        .totalBytes,
    });
  });

  it("未封存 run：正文照常读出并带 TERMINATION_NOT_RECORDED，不暗示仍在运行", async () => {
    const { data, envelope } = await okRead(fx.ids.open, "notes/crlf.txt");
    expect(asText(data).text).toBe(FILE_TEXTS.crlf);
    expect(envelope.limitations.some((item) => item.code === "TERMINATION_NOT_RECORDED")).toBe(
      true,
    );
    expect(JSON.stringify(data)).not.toContain("仍在运行");
  });

  it("同参两次结果逐字相同；五次读取前后目录递归指纹不变", async () => {
    const before = dirFingerprintRecursive(fx.dataDir);
    const first = await okRead(fx.ids.root, "long.txt");
    const second = await okRead(fx.ids.root, "long.txt");
    expect(JSON.stringify({ ...second.envelope, observedAt: "fixed" })).toBe(
      JSON.stringify({ ...first.envelope, observedAt: "fixed" }),
    );
    await okRead(fx.ids.root, "gone.txt");
    await okRead(fx.ids.child, "added.txt");
    await failureOf(fx.ids.ioRun, "weird.txt");
    await failureOf(fx.ids.plain, "a.txt");
    expect(dirFingerprintRecursive(fx.dataDir)).toBe(before);
  });
});
