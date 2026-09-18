import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_QUOTA,
  createWorkspaceBlobStore,
  hashWorkspaceContent,
  importSourceTree,
  readWorkspaceFile,
  verifySourceTreeUnchanged,
} from "../src/index";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * 2.4：两遍核对、导入配额与失败收尾。
 *
 * "采集期间变化"的构造用了 `importSourceTree` 的 `testHooks.betweenPasses`（设计把这条写成
 * **受控测试**场景；没有可控注入点就只能靠竞态，那不算证据）。第二遍的比对逻辑另有直接用例。
 */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(cleanupTempDirs);

/** 一次导入所需的两条路径（源目录 + 同级的 dataDir） */
function paths(prefix = "replay-import-"): { source: string; dataDir: string } {
  return { source: makeTempDir(prefix), dataDir: join(makeTempDir(`data-${prefix}`), "data") };
}

/** 附件存储里是否存在这段内容（用来判断"有没有被发布/读进来"） */
function hasBlob(dataDir: string, content: string | Uint8Array): boolean {
  const bytes = typeof content === "string" ? utf8(content) : content;
  return existsSync(createWorkspaceBlobStore(dataDir).blobPath(hashWorkspaceContent(bytes)));
}

describe("导入：两遍核对（源目录在期间变化即拒）", () => {
  it("内容变化（大小不变）被拒；第二遍只读，不把改后的内容发布出去", async () => {
    const { source, dataDir } = paths();
    writeTree(source, { "a.txt": "before" });

    const result = await importSourceTree({
      source,
      dataDir,
      testHooks: {
        betweenPasses: () => writeFileSync(join(source, "a.txt"), "AFTER!"), // 同 6 字节
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.code).toBe("source_changed");
    expect(result.ok ? "" : result.failure.reason).toContain("内容哈希");
    // 第二遍不发布：改后的内容在附件存储里查不到（只会留下第一遍那版）
    expect(hasBlob(dataDir, "AFTER!")).toBe(false);
    expect(hasBlob(dataDir, "before")).toBe(true);
  });

  it("大小变化、新增文件、删除文件各自被拒并报出细节", async () => {
    const size = paths();
    writeTree(size.source, { "a.txt": "abc" });
    const sizeResult = await importSourceTree({
      ...size,
      testHooks: { betweenPasses: () => writeFileSync(join(size.source, "a.txt"), "abcdefgh") },
    });
    expect(sizeResult.ok ? "" : sizeResult.failure.reason).toContain("大小");

    const added = paths();
    writeTree(added.source, { "a.txt": "a" });
    const addedResult = await importSourceTree({
      ...added,
      testHooks: { betweenPasses: () => writeTree(added.source, { "new.txt": "新" }) },
    });
    expect(addedResult.ok ? "" : addedResult.failure.reason).toContain("出现新文件");

    const removed = paths();
    writeTree(removed.source, { "a.txt": "a", "b.txt": "b" });
    const removedResult = await importSourceTree({
      ...removed,
      testHooks: { betweenPasses: () => rmSync(join(removed.source, "b.txt")) },
    });
    expect(removedResult.ok ? "" : removedResult.failure.reason).toContain("文件消失");
  });

  it("同一路径被换成另一个文件（内容相同但标识变了）也被拒", async () => {
    const { source, dataDir } = paths();
    writeTree(source, { "a.txt": "同一个内容", "b.txt": "同一个内容" });

    const result = await importSourceTree({
      source,
      dataDir,
      testHooks: {
        betweenPasses: () => {
          // 删掉 a.txt 再把它做成 b.txt 的硬链接：内容一样，但文件标识换成了 b 的
          rmSync(join(source, "a.txt"));
          linkSync(join(source, "b.txt"), join(source, "a.txt"));
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.reason).toContain("标识");
  });

  it("两次核对之间出现链接被拒（第二遍的链接检查同样 fail closed）", async () => {
    const { source, dataDir } = paths();
    const outside = makeTempDir("replay-outside-");
    writeTree(source, { "a.txt": "a" });
    writeTree(outside, { "leak.txt": "不该被采到" });

    const result = await importSourceTree({
      source,
      dataDir,
      testHooks: {
        betweenPasses: () => symlinkSync(outside, join(source, "junction"), "junction"),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.code).toBe("source_changed");
    expect(result.ok ? "" : result.failure.reason).toContain("链接");
  });

  it("第二遍比对函数可单独复用（集合/标识/大小/内容四类差异）", async () => {
    const source = makeTempDir();
    const dataDir = join(makeTempDir("data-"), "data");
    writeTree(source, { "a.txt": "内容" });

    const collected = await importSourceTree({ source, dataDir });
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // 未变：通过
    expect(await verifySourceTreeUnchanged(collected.value.root, collected.value.entries)).toEqual({
      ok: true,
    });

    // 变了：拒
    writeFileSync(join(source, "a.txt"), "改过");
    const changed = await verifySourceTreeUnchanged(collected.value.root, collected.value.entries);
    expect(changed.ok).toBe(false);
    expect(changed.ok ? "" : changed.failure.code).toBe("source_changed");
  });

  it("干净的源目录：两遍都过，返回第一遍那份清单", async () => {
    const { source, dataDir } = paths();
    writeTree(source, { "a.txt": "a", "dir/b.txt": "b", ".hidden.txt": "h" });

    const result = await importSourceTree({ source, dataDir });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.files.map((file) => file.path) : []).toEqual([
      ".hidden.txt",
      "a.txt",
      "dir/b.txt",
    ]);
  });
});

describe("导入：配额（超限整次拒绝）", () => {
  it("单文件恰好 8 MiB 合法；多 1 字节在读取前就被拒，且该内容未进附件存储", async () => {
    const ok = paths();
    writeTree(ok.source, { "big.bin": new Uint8Array(WORKSPACE_QUOTA.maxFileBytes) });
    expect((await importSourceTree(ok)).ok).toBe(true);

    const over = paths();
    const oversize = new Uint8Array(WORKSPACE_QUOTA.maxFileBytes + 1);
    writeTree(over.source, { "a.txt": "先来的有效文件", "z-over.bin": oversize });
    const result = await importSourceTree(over);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.code).toBe("quota_exceeded");
    expect(result.ok ? "" : result.failure.reason).toContain("单文件超过上限");
    // 没被读进来 ⇒ 也没被发布（排在它前面的文件已按采集顺序发布，属设计接受的孤立内容）
    expect(hasBlob(over.dataDir, oversize)).toBe(false);
    expect(hasBlob(over.dataDir, "先来的有效文件")).toBe(true);
  });

  it("文件数超过 2000 被拒（早期拒绝，不把整棵树读完）", async () => {
    const { source, dataDir } = paths();
    for (let i = 0; i < WORKSPACE_QUOTA.maxFiles + 1; i++) {
      writeFileSync(join(source, `f${String(i).padStart(5, "0")}.txt`), "");
    }
    expect(readdirSync(source)).toHaveLength(WORKSPACE_QUOTA.maxFiles + 1);

    const result = await importSourceTree({ source, dataDir });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.reason).toContain("文件数超过上限");
  });

  it("快照合计恰好 64 MiB 合法；多 1 字节被拒", async () => {
    const { source, dataDir } = paths();
    // 8 个 8 MiB = 64 MiB（内容相同 ⇒ 附件只存一份，配额仍按文件大小求和）
    const chunk = new Uint8Array(WORKSPACE_QUOTA.maxFileBytes);
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(source, `chunk-${i}.bin`), chunk);
    }
    expect((await importSourceTree({ source, dataDir })).ok).toBe(true);

    writeFileSync(join(source, "extra.bin"), new Uint8Array(1));
    const result = await importSourceTree({ source, dataDir });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.reason).toContain("快照合计超过上限");
  });
});

describe("导入：失败收尾（零 trace、零可用快照、不留半成品）", () => {
  it("超限拒绝后：没有 traces 目录、没有临时残留、孤立附件不构成可用快照", async () => {
    const { source, dataDir } = paths();
    writeTree(source, {
      "a.txt": "先来的有效文件",
      "z-over.bin": new Uint8Array(WORKSPACE_QUOTA.maxFileBytes + 1),
    });

    const result = await importSourceTree({ source, dataDir });
    expect(result.ok).toBe(false);

    // 零 trace：拒绝的导入不产生任何 run 文件
    expect(existsSync(join(dataDir, "traces"))).toBe(false);
    // 只留孤立附件（不删共享内容），且没有临时文件残留
    const store = createWorkspaceBlobStore(dataDir);
    expect(readdirSync(store.root).every((name) => !name.startsWith(".tmp-"))).toBe(true);
    expect(hasBlob(dataDir, "先来的有效文件")).toBe(true);

    // 孤立 blob 不是可用快照：读接口按 runId 找不到任何东西
    const read = await readWorkspaceFile({ dataDir, runId: "run_never_created", path: "a.txt" });
    expect(read).toMatchObject({ status: "rejected", failure: { code: "run_not_found" } });
  });

  it("源目录变化拒绝后同样零 trace，且不新建运行", async () => {
    const { source, dataDir } = paths();
    writeTree(source, { "a.txt": "before" });

    const result = await importSourceTree({
      source,
      dataDir,
      testHooks: { betweenPasses: () => writeFileSync(join(source, "a.txt"), "改动") },
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(dataDir, "traces"))).toBe(false);
    expect(existsSync(join(dataDir, "workspace-blobs"))).toBe(true); // 第一遍已经发布过
  });

  it("根不合法时连附件存储都不建（预检早于任何写入）", async () => {
    const source = makeTempDir();
    const dataDir = join(makeTempDir("data-"), "data");
    mkdirSync(join(source, "inner"));

    const result = await importSourceTree({ source, dataDir: source });

    expect(result.ok).toBe(false);
    expect(existsSync(join(dataDir))).toBe(false);
    expect(readdirSync(source)).toEqual(["inner"]);
  });
});
