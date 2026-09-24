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
import { join, parse } from "node:path";
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

/**
 * 需要 **symlink 创建权限**（开发者模式 / `SeCreateSymbolicLinkPrivilege`）的用例。
 *
 * ⚠️ 必须用 `skipIf` 而不是"进函数体先 `if (!可用) return`"：后者会让用例**显示为通过**
 * ——什么都没测却给绿灯，正是本任务禁止的"把未验证标作通过"。用 `skipIf` 时报告里是 skipped。
 * （`junction` 不需要特权，因此那几条用例走普通 `it`，恒定真跑。）
 */
const itWithSymlink = it.skipIf(!FILE_SYMLINK_AVAILABLE);

/**
 * **仅 Windows 有意义**的用例：实现的大小写折叠只在 `win32` 生效（`describePathRelation`
 * 的 `fold`），POSIX 上 `/Proj` 与 `/proj/data` 本来就是两个不同目录——判 ok 才是正确行为。
 *
 * ⚠️ 2026-09-24 Gitee Go 假红实证：不加门控时该用例在 Linux CI 上必红
 * （expected { ok: true } to match { failure: source_conflicts_data_dir }）。
 */
const itOnWindows = it.skipIf(process.platform !== "win32");

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

  itOnWindows("数据目录写成大小写变体时仍判为冲突（Windows 路径不区分大小写）", () => {
    const outer = tempDir();
    const proj = join(outer, "Proj");
    mkdirSync(proj);

    expect(
      validateSourceRoot({ source: proj, dataDir: join(outer, "proj", "data") }),
    ).toMatchObject({ failure: { code: "source_conflicts_data_dir" } });
  });

  it.skipIf(process.platform === "win32")(
    "POSIX 路径区分大小写：大小写变体不算冲突（判 ok 才是正确行为）",
    () => {
      const outer = tempDir();
      const proj = join(outer, "Proj");
      mkdirSync(proj);

      const result = validateSourceRoot({ source: proj, dataDir: join(outer, "proj", "data") });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value.root).toBe(realpathSync(proj));
    },
  );

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

/**
 * 7.5：**链接形态的根与树**（Windows 真机，junction 免特权 + symlink 走能力探针）。
 *
 * 验证点（tasks.md 7.5）：`workspace-isolation/拒绝链接及不合适的根目录`。
 *
 * ## 为什么这件事非要在真机做
 *
 * "根是链接"与"树内是链接"在 Node 里都只表现为 `lstat().isSymbolicLink() === true`，
 * 但**创建方式**分两类：junction（`MOUNT_POINT`，非管理员即可建）与 symlink（真正需要
 * `SeCreateSymbolicLinkPrivilege` / 开发者模式）。只测 junction 会漏掉 symlink 这条路径，
 * 反之亦然。本文件两类都真建真跑：junction 用例恒执行，symlink 用例由能力探针守卫
 * （本机开开发者模式时真跑，关闭时显示 **skipped** —— 不伪装成通过）。
 *
 * ## 关键构造：用链接去撞"解析后的形态"
 *
 * 根校验此前只在**字面路径**上判"不适合作根"（`D:\`、UNC、设备前缀）。而 `D:\proj\link`
 * 字面看着是个正常子目录，`realpath` 之后可能是 `D:\` —— 一旦放行，隔离世界会把整个盘当项目。
 * 用例 2/3 正是用 junction 把这条路径钉住（真机发现，实现已同步补上"解析后复判"）。
 */
describe("源根与树内的链接形态（7.5 真机 junction/symlink）", () => {
  itWithSymlink("根是目录符号链接（dir 类型）：解析一次后通过，世界根取真实路径", () => {
    const holder = tempDir();
    const real = join(holder, "real");
    writeTree(real, { "a.txt": "a" });
    const link = join(holder, "dir-link");
    symlinkSync(real, link, "dir");
    expect(existsSync(link)).toBe(true);

    const result = validateSourceRoot({ source: link, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.root).toBe(realpathSync(real));
  });

  it("根是指向磁盘根的 junction：拒绝（字面像子目录，解析后是盘根）", () => {
    const holder = tempDir();
    const link = join(holder, "to-disk-root");
    const diskRoot = parse(process.cwd()).root; // 例如 "D:\"
    symlinkSync(diskRoot, link, "junction");
    expect(existsSync(link)).toBe(true);

    const result = validateSourceRoot({ source: link, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.code).toBe("unsuitable_root");
    // 失败信息里要能同时看到"字面给了什么"和"解析成了什么"，否则用户不知道去哪改
    expect(result.ok ? "" : result.failure.reason).toContain(diskRoot);
    expect(result.ok ? "" : result.failure.reason).toContain(link);
  });

  it("根是指向数据目录的 junction：按解析后的真实路径判冲突", () => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir);
    const holder = tempDir();
    const link = join(holder, "to-data-dir");
    symlinkSync(dataDir, link, "junction");

    // 字面路径与 dataDir 无关，但解析后是同一处 ⇒ 必须拒
    expect(validateSourceRoot({ source: link, dataDir })).toMatchObject({
      failure: { code: "source_conflicts_data_dir" },
    });
  });

  itWithSymlink("根是指向文件的符号链接：拒绝（解析后不是目录）", () => {
    const holder = tempDir();
    const file = join(holder, "target.txt");
    writeFileSync(file, "x");
    const link = join(holder, "file-link");
    symlinkSync(file, link, "file");
    expect(existsSync(link)).toBe(true);

    // 字面既不是磁盘根也不是 UNC，但 realpath 后是一个普通文件 ⇒ 不是目录
    expect(validateSourceRoot({ source: link, dataDir: join(tempDir(), "data") })).toMatchObject({
      failure: { code: "source_not_a_directory" },
    });
  });

  itWithSymlink("树内的目录符号链接（dir 类型）被拒，且不跟随、不泄露链接外内容", async () => {
    const source = tempDir();
    const outside = tempDir();
    writeTree(source, { "a.txt": "a" });
    writeTree(outside, { "leak.txt": "不该被采到" });
    const link = join(source, "dir-link");
    symlinkSync(outside, link, "dir");
    expect(existsSync(link)).toBe(true);

    const result = await collectSourceFiles({ source, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.code).toBe("unsupported_entry");
    expect(result.ok ? "" : result.failure.path).toBe("dir-link");
  });

  it("能力探针与实际创建结果一致：探针说不可创建时用例必须 skipped，不能静默通过", () => {
    // 独立再测一次（与模块顶层探针同构，但不复用其实现），两端必须同结论。
    // 本机开开发者模式时为 true；无权限环境下这条断言同样成立（都是 false），
    // 而依赖链接的用例会显示 skipped —— 这正是"缺创建权限须记录未验证"的机制。
    const dir = mkdtempSync(join(tmpdir(), "replay-symlink-recheck-"));
    try {
      const target = join(dir, "t.txt");
      writeFileSync(target, "x");
      const link = join(dir, "l.txt");
      let created = false;
      try {
        symlinkSync(target, link, "file");
        created = existsSync(link);
      } catch {
        created = false;
      }
      expect(created).toBe(FILE_SYMLINK_AVAILABLE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  // 因此探针必须回查条目是否存在；否则会把"没建成"当成"建成后被放行"。无权限时本用例
  // 显示 **skipped**（不是通过）——见 `itWithSymlink` 的说明。
  itWithSymlink("文件符号链接被拒（树内，file 类型）", async () => {
    const source = tempDir();
    writeTree(source, { "a.txt": "a" });
    symlinkSync(join(source, "a.txt"), join(source, "link.txt"), "file");

    const result = await collectSourceFiles({ source, dataDir: join(tempDir(), "data") });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.code).toBe("unsupported_entry");
  });

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
