import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_QUOTA,
  createWorkspaceBlobStore,
  createWorkspaceWorld,
  hashWorkspaceContent,
  importSourceTree,
} from "../src/index";
import type { WorkspaceWorld } from "../src/index";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * 2.5：世界的独立映射、冻结快照、配额派生与授权边界。
 *
 * 用例都走"真导入 → 建世界 → 读写"的端到端路径：手填清单会被 `createWorkspaceWorld` 的 id 重算
 * 拒掉（这正是它该做的），所以 fixture 必须是真的事实。
 */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

afterEach(cleanupTempDirs);

async function importedWorld(options: {
  tree: Record<string, string | Uint8Array>;
  allowFileWrites?: boolean;
}): Promise<{ source: string; dataDir: string; world: WorkspaceWorld }> {
  const source = makeTempDir("world-src-");
  const dataDir = join(makeTempDir("world-data-"), "data");
  writeTree(source, options.tree);

  const imported = await importSourceTree({ source, dataDir });
  if (!imported.ok) {
    throw new Error(`fixture 导入失败：${imported.failure.reason}`);
  }
  const created = createWorkspaceWorld({
    dataDir,
    snapshot: createWorkspaceSnapshot(imported.value.files),
    allowFileWrites: options.allowFileWrites ?? true,
  });
  if (!created.ok) {
    throw new Error(`fixture 建世界失败：${created.failure.reason}`);
  }
  return { source, dataDir, world: created.value };
}

/** 读世界里的文本；失败时把状态编码成文本，断言里一眼能看出是哪一种失败 */
async function readText(world: WorkspaceWorld, path: string): Promise<string> {
  const result = await world.readFile(path);
  return result.ok ? decode(result.data) : `失败:${result.state}`;
}

/** 源目录的逐字节指纹（相对路径 + 大小 + 内容哈希） */
function sourceFingerprint(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else {
        const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
        entries.push(`${relative(root, full)}:${statSync(full).size}:${hash}`);
      }
    }
  };
  walk(root);
  return entries.sort();
}

describe("世界：读与写", () => {
  it("从导入结果建世界：读得到导入内容，写新路径后可读回", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before", "dir/b.txt": "b" } });

    expect(await readText(world, "a.txt")).toBe("before");
    expect(world.listFiles().map((file) => file.path)).toEqual(["a.txt", "dir/b.txt"]);

    expect((await world.writeFile("nested/new.txt", utf8("hello"))).ok).toBe(true);
    expect(await readText(world, "nested/new.txt")).toBe("hello");
    expect(world.quotaUsage()).toEqual({
      fileCount: 3,
      snapshotBytes: 6 + 1 + 5,
      newContentBytes: 5,
    });
  });

  it("配额派生：新增内容按唯一哈希去重，覆盖写按新内容算", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before" } });
    const shared = utf8("同样的内容"); // 中文一个字符 3 字节，这里用实际长度算期望值

    await world.writeFile("x1.txt", shared);
    await world.writeFile("x2.txt", shared); // 同内容 ⇒ 只算一次
    expect(world.quotaUsage().newContentBytes).toBe(shared.byteLength);

    // 覆盖写：文件数不变，合计按新大小（旧那份不再计入），新增内容继续累加
    await world.writeFile("a.txt", utf8("ab"));
    expect(world.quotaUsage()).toEqual({
      fileCount: 3,
      snapshotBytes: shared.byteLength * 2 + 2,
      newContentBytes: shared.byteLength + 2,
    });
  });

  it("读不到的状态可辨认：路径不在映射内、附件被删", async () => {
    const { dataDir, world } = await importedWorld({ tree: { "a.txt": "before" } });

    expect(await world.readFile("nope.txt")).toMatchObject({ ok: false, state: "not_found" });

    const store = createWorkspaceBlobStore(dataDir);
    rmSync(store.blobPath(hashWorkspaceContent(utf8("before"))));
    expect(await world.readFile("a.txt")).toMatchObject({ ok: false, state: "missing" });
  });

  it("冻结快照：snapshot() 之后继续写，先前那份不受影响", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before" } });

    const frozen = world.snapshot();
    const frozenId = frozen.id;

    // 调用方改返回的那份快照不会影响世界
    frozen.files[0].bytes = 999;
    expect(world.listFiles()[0].bytes).toBe(utf8("before").byteLength);

    await world.writeFile("a.txt", utf8("after"));
    expect(world.snapshot().id).not.toBe(frozenId);
    expect(frozen.files[0].sha256).toBe(hashWorkspaceContent(utf8("before")));
    expect(world.listFiles()[0].bytes).toBe(utf8("after").byteLength);
  });

  it("起点清单不合法（id 与清单不符）时拒绝建世界", async () => {
    const dataDir = join(makeTempDir("world-data-"), "data");
    const result = createWorkspaceWorld({
      dataDir,
      snapshot: {
        id: "0".repeat(64),
        files: [{ path: "a.txt", sha256: "a".repeat(64), bytes: 1 }],
      },
      allowFileWrites: true,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.reason).toContain("不符");
  });
});

describe("世界：父子与并发兄弟隔离", () => {
  it("两个兄弟各写各的：互不可见，父世界与源目录逐字节不变", async () => {
    const { source, world: parent } = await importedWorld({ tree: { "a.txt": "before" } });
    const sourceBefore = sourceFingerprint(source);
    const parentSnapshotBefore = parent.snapshot().id;

    const left = parent.fork({ allowFileWrites: true });
    const right = parent.fork({ allowFileWrites: true });
    await left.writeFile("a.txt", utf8("left"));
    await right.writeFile("a.txt", utf8("right"));

    expect(await readText(left, "a.txt")).toBe("left");
    expect(await readText(right, "a.txt")).toBe("right");
    expect(await readText(parent, "a.txt")).toBe("before");

    // 父世界未被改动：起点快照 id 与清单都不变
    expect(parent.snapshot().id).toBe(parentSnapshotBefore);
    expect(parent.listFiles()).toHaveLength(1);
    // 源目录逐字节不变（世界只写附件）
    expect(sourceFingerprint(source)).toEqual(sourceBefore);
  });

  it("并发写同一路径到两个兄弟：各自生效，互不覆盖", async () => {
    const { world: parent } = await importedWorld({ tree: { "a.txt": "before" } });
    const brothers = [
      parent.fork({ allowFileWrites: true }),
      parent.fork({ allowFileWrites: true }),
    ];

    await Promise.all([
      brothers[0].writeFile("a.txt", utf8("first")),
      brothers[1].writeFile("a.txt", utf8("second")),
      brothers[0].writeFile("extra-0.txt", utf8("0")),
      brothers[1].writeFile("extra-1.txt", utf8("1")),
    ]);

    expect(await readText(brothers[0], "a.txt")).toBe("first");
    expect(await readText(brothers[1], "a.txt")).toBe("second");
    expect(brothers[0].listFiles().map((file) => file.path)).toEqual(["a.txt", "extra-0.txt"]);
    expect(brothers[1].listFiles().map((file) => file.path)).toEqual(["a.txt", "extra-1.txt"]);
    expect(parent.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("相同内容在兄弟之间共享附件：存储里只有一份", async () => {
    const { dataDir, world: parent } = await importedWorld({ tree: { "a.txt": "before" } });
    const shared = utf8("共享内容");
    const sharedHash = hashWorkspaceContent(shared);
    const left = parent.fork({ allowFileWrites: true });
    const right = parent.fork({ allowFileWrites: true });

    await left.writeFile("s.txt", shared);
    await right.writeFile("s.txt", shared);

    const store = createWorkspaceBlobStore(dataDir);
    expect(readdirSync(store.root).filter((name) => name === sharedHash)).toHaveLength(1);
    // 但两份清单各自持有各自的条目
    expect(left.listFiles().find((file) => file.path === "s.txt")?.bytes).toBe(shared.byteLength);
    expect(right.listFiles().find((file) => file.path === "s.txt")?.bytes).toBe(shared.byteLength);
  });

  it("分叉出的世界有独立的新增内容计数（不重复计费父 run 已产出的内容）", async () => {
    const { world: parent } = await importedWorld({ tree: { "a.txt": "before" } });
    await parent.writeFile("new.txt", utf8("父 run 的内容"));
    expect(parent.quotaUsage().newContentBytes).toBe(utf8("父 run 的内容").byteLength);

    const child = parent.fork({ allowFileWrites: true });
    expect(child.quotaUsage().newContentBytes).toBe(0); // 子 run 从零开始

    await child.writeFile("child.txt", utf8("子 run 的内容"));
    expect(child.quotaUsage().newContentBytes).toBe(utf8("子 run 的内容").byteLength);
    // 子世界写"父 run 已有的内容"也不算新增（那些字节早就存在了）
    await child.writeFile("copy-of-parent.txt", utf8("父 run 的内容"));
    expect(child.quotaUsage().newContentBytes).toBe(utf8("子 run 的内容").byteLength);
  });
});

describe("世界：授权限定于当前世界", () => {
  it("未授权的世界写入被拒、清单不变；授权不继承也不传染", async () => {
    const { world: authorized } = await importedWorld({
      tree: { "a.txt": "before" },
      allowFileWrites: true,
    });
    const readOnly = authorized.fork({ allowFileWrites: false });

    const rejected = await readOnly.writeFile("b.txt", utf8("x"));
    expect(rejected).toMatchObject({ ok: false, failure: { code: "not_authorized" } });
    expect(readOnly.listFiles().map((file) => file.path)).toEqual(["a.txt"]);

    // 授权的世界照常写；另一个世界既没被"启动"，也没看到新文件
    await authorized.writeFile("b.txt", utf8("x"));
    expect(authorized.listFiles().map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(readOnly.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
    expect(readOnly.allowFileWrites).toBe(false);
  });

  it("fork 不给授权参数时按只读处理（默认值会变成「忘了传＝授权」）", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before" } });
    // 类型上强制必填；这里刻意绕过类型检查，确认运行期是 fail closed 而不是 fail open
    const forked = (world as unknown as { fork: (options: object) => WorkspaceWorld }).fork({});

    expect(forked.allowFileWrites).toBeFalsy();
    expect(await forked.writeFile("x.txt", utf8("x"))).toMatchObject({
      ok: false,
      failure: { code: "not_authorized" },
    });
  });
});

describe("世界：导入后源目录变化不影响运行", () => {
  it("源文件被改写或删除，世界读到的仍是导入时的内容", async () => {
    const { source, world } = await importedWorld({ tree: { "a.txt": "before", "b.txt": "b" } });

    writeFileSync(join(source, "a.txt"), "outside");
    rmSync(join(source, "b.txt"));

    expect(await readText(world, "a.txt")).toBe("before");
    expect(await readText(world, "b.txt")).toBe("b");
    // 源目录保持调用方改后的状态：世界没有回写、没有恢复
    expect(readFileSync(join(source, "a.txt"), "utf8")).toBe("outside");
    expect(readdirSync(source)).toEqual(["a.txt"]);
  });
});

describe("世界：写入配额", () => {
  it("单文件恰好 8 MiB 合法；多 1 字节被拒且内容未发布", async () => {
    const { world } = await importedWorld({ tree: { "keep.txt": "k" } });

    const atLimit = await world.writeFile("big.bin", new Uint8Array(WORKSPACE_QUOTA.maxFileBytes));
    expect(atLimit.ok).toBe(true);

    const oversize = new Uint8Array(WORKSPACE_QUOTA.maxFileBytes + 1);
    const rejected = await world.writeFile("too-big.bin", oversize);

    expect(rejected).toMatchObject({ ok: false, failure: { code: "quota_exceeded" } });
    // 失败写入不留在映射里，也不留附件
    expect(world.listFiles().map((file) => file.path)).toEqual(["big.bin", "keep.txt"]);
    expect(readdirSync(world.store.root)).not.toContain(hashWorkspaceContent(oversize));
  });

  it("文件数超上限：第 2001 个文件被拒，映射不变", async () => {
    const { world } = await importedWorld({ tree: { "keep.txt": "k" } });

    for (let i = 0; i < WORKSPACE_QUOTA.maxFiles - 1; i++) {
      // 内容相同 ⇒ 附件只存一份，这里考的是"文件数"
      const written = await world.writeFile(`f${String(i).padStart(5, "0")}.txt`, utf8("x"));
      expect(written.ok, `第 ${i + 1} 个`).toBe(true);
    }
    expect(world.quotaUsage().fileCount).toBe(WORKSPACE_QUOTA.maxFiles);

    const rejected = await world.writeFile("overflow.txt", utf8("x"));
    expect(rejected).toMatchObject({ ok: false, failure: { code: "quota_exceeded" } });
    expect(world.quotaUsage().fileCount).toBe(WORKSPACE_QUOTA.maxFiles);
  });

  it("当前快照合计恰好 64 MiB 合法；多 1 字节被拒", async () => {
    // 从空世界起步：8 个 8 MiB 正好顶到合计上限（若世界里还有别的文件，第 8 个就会被拒）
    const empty = createWorkspaceWorld({
      dataDir: join(makeTempDir("world-data-"), "data"),
      allowFileWrites: true,
    });
    if (!empty.ok) throw new Error(empty.failure.reason);
    const world = empty.value;

    const chunk = new Uint8Array(WORKSPACE_QUOTA.maxFileBytes);
    for (let i = 0; i < 8; i++) {
      expect((await world.writeFile(`chunk-${i}.bin`, chunk)).ok).toBe(true);
    }
    expect(world.quotaUsage().snapshotBytes).toBe(WORKSPACE_QUOTA.maxSnapshotBytes);

    const rejected = await world.writeFile("extra.bin", new Uint8Array(1));
    expect(rejected).toMatchObject({ ok: false, failure: { code: "quota_exceeded" } });
    expect(world.quotaUsage().snapshotBytes).toBe(WORKSPACE_QUOTA.maxSnapshotBytes);
  });

  it("一次运行新增内容恰好 128 MiB 合法；再多 1 字节被拒（覆盖写也计入新增）", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "a" } });

    // 反复覆盖同一个路径：快照合计不变，但每份新内容都进"本 run 新增"
    for (let i = 0; i < 16; i++) {
      const content = new Uint8Array(WORKSPACE_QUOTA.maxFileBytes);
      content[0] = i + 1; // 保证每份内容不同
      expect((await world.writeFile("a.txt", content)).ok, `第 ${i + 1} 次`).toBe(true);
    }
    expect(world.quotaUsage().newContentBytes).toBe(WORKSPACE_QUOTA.maxNewContentBytes);

    const rejected = await world.writeFile("a.txt", new Uint8Array(1));
    expect(rejected).toMatchObject({ ok: false, failure: { code: "quota_exceeded" } });
    expect(world.quotaUsage().newContentBytes).toBe(WORKSPACE_QUOTA.maxNewContentBytes);
  });

  it("附件发布失败：报错且映射不变（先落盘再改映射）", async () => {
    const { dataDir, world } = await importedWorld({ tree: { "a.txt": "a" } });
    // 把附件根目录换成普通文件 ⇒ 发布必然失败
    const store = createWorkspaceBlobStore(dataDir);
    rmSync(store.root, { recursive: true, force: true });
    writeFileSync(store.root, "占位");

    const rejected = await world.writeFile("b.txt", utf8("b"));

    expect(rejected).toMatchObject({ ok: false, failure: { code: "write_failed" } });
    expect(world.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
    expect(world.quotaUsage().newContentBytes).toBe(0);
  });
});
