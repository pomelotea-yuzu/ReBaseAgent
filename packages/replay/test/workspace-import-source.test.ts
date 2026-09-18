import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSnapshotFilesViolation } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectSourceFiles,
  createWorkspaceBlobStore,
  hashWorkspaceContent,
  validateSourceRoot,
} from "../src/index";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/** 非 UTF-8 字节（0xFF 在任何位置都非法） */
const BINARY = Uint8Array.from([0xff, 0xfe, 0x00, 0x41, 0x80]);
const CAFE_NFC = "caf\u00e9.txt";
const CAFE_NFD = "cafe\u0301.txt";

afterEach(cleanupTempDirs);

const tempDir = (): string => makeTempDir("replay-src-");

/**
 * 本机能否**真的**创建出文件符号链接。
 *
 * Windows 未开开发者模式 / 无特权时，`symlinkSync` 可能既不抛错也不建出条目（实测如此），
 * 所以判定要回查条目是否存在。不可创建时相关用例显示为 **skipped**（不伪装成通过）——
 * 与任务 7.5 的"缺创建权限须记录未验证"一致。
 */
const FILE_SYMLINK_AVAILABLE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "replay-symlink-probe-"));
  try {
    const target = join(dir, "target.txt");
    writeFileSync(target, "x");
    const link = join(dir, "link.txt");
    try {
      symlinkSync(target, link, "file");
    } catch {
      return false;
    }
    return existsSync(link);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe("源根校验：形态与关系", () => {
  it("普通目录通过，返回解析后的真实路径", () => {
    const source = tempDir();
    writeTree(source, { "a.txt": "a" });

    const result = validateSourceRoot({ source, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.root).toBe(realpathSync(source));
  });

  it("源不存在 / 源是文件 / 参数为空都是可辨认的拒绝", () => {
    const dataDir = tempDir();
    expect(validateSourceRoot({ source: join(tempDir(), "nope"), dataDir })).toMatchObject({
      failure: { code: "source_not_found" },
    });

    const file = join(tempDir(), "file.txt");
    writeFileSync(file, "x");
    expect(validateSourceRoot({ source: file, dataDir })).toMatchObject({
      failure: { code: "source_not_a_directory" },
    });

    expect(validateSourceRoot({ source: "  ", dataDir })).toMatchObject({
      failure: { code: "invalid_request" },
    });
    expect(validateSourceRoot({ source: tempDir(), dataDir: "" })).toMatchObject({
      failure: { code: "invalid_request" },
    });
  });

  it("磁盘根、驱动器相对形式、UNC 与设备路径都不适合作根", () => {
    const dataDir = tempDir();
    const sources = [
      "D:\\",
      "D:/",
      "/",
      "D:",
      "\\\\server\\share",
      "//server/share",
      "\\\\?\\C:\\x",
      "\\\\.\\PhysicalDrive0",
    ];
    for (const source of sources) {
      const result = validateSourceRoot({ source, dataDir });
      expect(result.ok, source).toBe(false);
      expect(result.ok ? "" : result.failure.code, source).toBe("unsuitable_root");
    }
  });

  it("源与数据目录相同或互为祖先后代都被拒", () => {
    const shared = tempDir();
    expect(validateSourceRoot({ source: shared, dataDir: shared })).toMatchObject({
      failure: { code: "source_conflicts_data_dir" },
    });

    const outer = tempDir();
    const inner = join(outer, "inner");
    mkdirSync(inner);
    // 源在数据目录内
    expect(validateSourceRoot({ source: inner, dataDir: outer })).toMatchObject({
      failure: { code: "source_conflicts_data_dir" },
    });
    // 数据目录在源内（含尚不存在的多级子目录）
    expect(validateSourceRoot({ source: outer, dataDir: join(outer, "data") })).toMatchObject({
      failure: { code: "source_conflicts_data_dir" },
    });
    expect(
      validateSourceRoot({ source: outer, dataDir: join(outer, "data", "nested") }),
    ).toMatchObject({ failure: { code: "source_conflicts_data_dir" } });
  });

  it("数据目录写成大小写变体时仍判为冲突（Windows 路径不区分大小写）", () => {
    const outer = tempDir();
    const proj = join(outer, "Proj");
    mkdirSync(proj);

    expect(
      validateSourceRoot({ source: proj, dataDir: join(outer, "proj", "data") }),
    ).toMatchObject({ failure: { code: "source_conflicts_data_dir" } });
  });

  it("根自己是 junction：解析一次后通过，并把真实路径作为世界根", () => {
    const holder = tempDir();
    const real = join(holder, "real");
    mkdirSync(real);
    writeTree(real, { "a.txt": "a" });
    const link = join(holder, "link");
    symlinkSync(real, link, "junction");

    const result = validateSourceRoot({ source: link, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.root).toBe(realpathSync(real));
  });
});

describe("普通文件采集：范围与顺序", () => {
  it("隐藏文件与 .git 内容都采集（不静默跳过），路径用 / 且按规范序", async () => {
    const source = tempDir();
    writeTree(source, {
      "b.txt": "b",
      "a.txt": "a",
      ".hidden.txt": "hidden",
      ".git/config": "[core]",
      "dir/nested/c.txt": "c",
    });

    const result = await collectSourceFiles({ source, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.map((file) => file.path)).toEqual([
      ".git/config",
      ".hidden.txt",
      "a.txt",
      "b.txt",
      "dir/nested/c.txt",
    ]);
    // 交叉核对：采出来的清单满足快照契约（规范序、无冲突、路径合法）
    expect(findSnapshotFilesViolation(result.value.files)).toBeNull();
  });

  it("空目录合法：零个条目", async () => {
    const source = tempDir();
    const result = await collectSourceFiles({ source, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.files : null).toEqual([]);
  });

  it("二进制字节按原样保存：哈希、字节数、附件内容都能和源文件逐项核对", async () => {
    const source = tempDir();
    const dataDir = join(tempDir(), "data");
    writeTree(source, { "bin.dat": BINARY });

    const result = await collectSourceFiles({ source, dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entry = result.value.files[0];
    expect(entry.bytes).toBe(BINARY.byteLength);
    expect(entry.sha256).toBe(hashWorkspaceContent(BINARY));

    // 附件里就是源文件的原始字节（不是文本、不经过替换字符）
    const store = createWorkspaceBlobStore(dataDir);
    expect(Array.from(readFileSync(store.blobPath(entry.sha256)))).toEqual(Array.from(BINARY));
  });

  it("hardlink 的两个名字各自成条目（按字节独立采集，不保留链接身份）", async () => {
    const source = tempDir();
    writeTree(source, { "a.txt": "同一个内容" });
    linkSync(join(source, "a.txt"), join(source, "b.txt"));

    const result = await collectSourceFiles({ source, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [a, b] = result.value.entries;
    expect(result.value.entries.map((entry) => entry.path)).toEqual(["a.txt", "b.txt"]);
    expect(a.sha256).toBe(b.sha256); // 内容相同 ⇒ 附件共享
    expect(a.bytes).toBe(b.bytes);
    expect(a.ino).toBe(b.ino); // 标识证明它们确实是同一个文件…
    // …而快照条目只有路径/哈希/字节：导入后不保留"它们原本是同一个文件"这层身份
    expect(Object.keys(result.value.files[0]).sort()).toEqual(["bytes", "path", "sha256"]);
  });

  it("采集不创建运行：数据目录下只出现附件存储", async () => {
    const source = tempDir();
    const dataDir = join(tempDir(), "data");
    writeTree(source, { "a.txt": "a" });

    await collectSourceFiles({ source, dataDir });

    expect(existsSync(join(dataDir, "traces"))).toBe(false);
    expect(readdirSync(dataDir)).toEqual(["workspace-blobs"]);
  });
});

describe("普通文件采集：拒绝链接与不合适的名字", () => {
  it("树内的目录 junction 被拒（不跟随、不跳过）", async () => {
    const source = tempDir();
    const outside = tempDir();
    writeTree(source, { "a.txt": "a" });
    writeTree(outside, { "leak.txt": "不该被采到" });
    symlinkSync(outside, join(source, "junction"), "junction");

    const result = await collectSourceFiles({ source, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.code).toBe("unsupported_entry");
    expect(result.ok ? "" : result.failure.path).toBe("junction");
  });

  it("悬空 junction 同样被拒（不是「文件不存在」，而是「链接本身不被接受」）", async () => {
    const source = tempDir();
    writeTree(source, { "a.txt": "a" });
    symlinkSync(join(source, "does-not-exist"), join(source, "dangling"), "junction");

    const result = await collectSourceFiles({ source, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.code).toBe("unsupported_entry");
  });

  // ⚠️ 实测本机（Windows 无创建符号链接权限）`symlinkSync` 既不抛错、链接也没真的建出来，
  // 因此必须回查条目是否存在；否则会把"没建成"当成"建成后被放行"。
  it.skipIf(!FILE_SYMLINK_AVAILABLE)(
    "文件符号链接被拒（本机无法创建时该用例显示为 skipped）",
    async () => {
      const source = tempDir();
      writeTree(source, { "a.txt": "a" });
      symlinkSync(join(source, "a.txt"), join(source, "link.txt"), "file");

      const result = await collectSourceFiles({ source, dataDir: join(tempDir(), "data") });
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.failure.code).toBe("unsupported_entry");
    },
  );

  it("NFC/NFD 等价名字在同一目录里碰撞 ⇒ 导入整体拒绝", async () => {
    const source = tempDir();
    writeTree(source, { [CAFE_NFC]: "nfc", [CAFE_NFD]: "nfd" });
    // 前提检查：NTFS 允许这两种编码共存（否则这条用例根本证明不了碰撞判定）
    expect(readdirSync(source)).toHaveLength(2);

    const result = await collectSourceFiles({ source, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.reason).toContain("碰撞");
  });

  it("深度超过 32 段的路径 ⇒ 拒绝（名字不符合逻辑路径契约，不隐式截断）", async () => {
    const source = tempDir();
    const deep = Array.from({ length: 33 }, (_, i) => `d${i}`).join("/");
    writeTree(source, { [`${deep}/file.txt`]: "deep" });

    const result = await collectSourceFiles({ source, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.code).toBe("invalid_entry_path");
    expect(result.ok ? "" : result.failure.reason).toContain("段数超过上限");
  });
});

describe("普通文件采集：根校验的前置拒绝", () => {
  it("根不合法时零副作用：不建附件存储、不建运行", async () => {
    const source = tempDir();
    writeTree(source, { "a.txt": "a" });

    const result = await collectSourceFiles({ source, dataDir: source });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.code).toBe("source_conflicts_data_dir");
    expect(readdirSync(source)).toEqual(["a.txt"]);
  });
});
