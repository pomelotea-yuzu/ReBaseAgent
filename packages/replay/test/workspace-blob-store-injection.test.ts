import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBlobError, createWorkspaceBlobStore, hashWorkspaceContent } from "../src/index";
import { makeDataDir } from "./workspace-helpers";

/**
 * 注入 I/O 故障的用例（单独一个文件，避免 mock 影响其他用例的模块图）。
 *
 * 真实的卷故障（磁盘错、无权限、卷不支持硬链接）没法在单测里稳定复现，因此这里替换
 * `node:fs/promises.link`：**默认仍走真实实现**，只在用例显式排入一次故障时接管。
 * 为什么要在"发布"这一步注入：临时文件已经写完、只差发布，正是"失败后只清本次临时文件"
 * 这条要求唯一能被观测到的时刻。
 */
const injection = vi.hoisted(() => ({ nextLinkError: null as null | (() => Error) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (existing: string, created: string) => {
      const make = injection.nextLinkError;
      if (make !== null) {
        injection.nextLinkError = null;
        throw make();
      }
      return actual.link(existing, created);
    },
  };
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const cleanups: (() => void)[] = [];
afterEach(() => {
  injection.nextLinkError = null;
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function newStore() {
  const { dataDir, cleanup } = makeDataDir();
  cleanups.push(cleanup);
  return createWorkspaceBlobStore(dataDir);
}

describe("blob store：注入 I/O 失败", () => {
  it("发布中途失败：报 io 错误、目标不出现，且只清本次临时文件", async () => {
    const store = newStore();
    const existing = await store.publish(utf8("别人已经发布的附件"));
    // 另一个请求的临时文件（不该被本次清理碰到）
    const strangerTemp = join(store.root, ".tmp-other-request");
    writeFileSync(strangerTemp, "别人的临时文件");

    injection.nextLinkError = () => Object.assign(new Error("注入的磁盘故障"), { code: "EIO" });

    const failure = await store.publish(utf8("发布过程中会失败的内容")).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(WorkspaceBlobError);
    expect((failure as WorkspaceBlobError).code).toBe("io");
    expect((failure as Error).message).toContain("注入的磁盘故障");

    // 目标没有出现（半成品不会躺在正式名下）
    const failedSha = hashWorkspaceContent(utf8("发布过程中会失败的内容"));
    expect(existsSync(store.blobPath(failedSha))).toBe(false);
    // 只清本次的：既有附件与别人的临时文件都在
    expect(readFileSync(store.blobPath(existing.sha256), "utf8")).toBe("别人已经发布的附件");
    expect(existsSync(strangerTemp)).toBe(true);
    expect(readdirSync(store.root).sort()).toEqual([existing.sha256, ".tmp-other-request"].sort());
  });

  it("卷不支持硬链接（EPERM）：退化为排他复制并发布成功", async () => {
    const store = newStore();
    injection.nextLinkError = () => Object.assign(new Error("不支持硬链接"), { code: "EPERM" });

    const result = await store.publish(utf8("退化路径内容"));

    expect(result.deduped).toBe(false);
    expect(readFileSync(store.blobPath(result.sha256), "utf8")).toBe("退化路径内容");
    expect(readdirSync(store.root)).toEqual([result.sha256]);
  });

  it("退化发布时目标已被别人抢占：按去重收尾，既有内容不变", async () => {
    const store = newStore();
    const content = utf8("竞争内容");

    // 让"排他发布"这一步发现目标已存在：注入的函数先把目标写好（内容正确），再抛 EPERM
    injection.nextLinkError = () => {
      writeFileSync(store.blobPath(hashWorkspaceContent(content)), "竞争内容");
      return Object.assign(new Error("不支持硬链接"), { code: "EPERM" });
    };

    const result = await store.publish(content);

    expect(result.deduped).toBe(true);
    expect(readFileSync(store.blobPath(result.sha256), "utf8")).toBe("竞争内容");
    expect(readdirSync(store.root)).toEqual([result.sha256]);
  });
});
