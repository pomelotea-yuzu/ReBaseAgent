import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_BLOBS_ALGORITHM_DIR_NAME,
  WORKSPACE_BLOBS_DIR_NAME,
  WorkspaceBlobError,
  createWorkspaceBlobStore,
  hashWorkspaceContent,
} from "../src/index";
import { makeDataDir } from "./workspace-helpers";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function newStore(): {
  dataDir: string;
  root: string;
  store: ReturnType<typeof createWorkspaceBlobStore>;
} {
  const { dataDir, cleanup } = makeDataDir();
  cleanups.push(cleanup);
  const store = createWorkspaceBlobStore(dataDir);
  return { dataDir, root: store.root, store };
}

describe("blob store：内容寻址布局与发布", () => {
  it("发布到 <dataDir>/workspace-blobs/sha256/<hash>，字节一致且不留临时文件", async () => {
    const { dataDir, root, store } = newStore();
    const content = utf8("hello");
    const result = await store.publish(content);

    expect(result.sha256).toBe(hashWorkspaceContent(content));
    expect(result.bytes).toBe(5);
    expect(result.deduped).toBe(false);
    expect(store.blobPath(result.sha256)).toBe(
      join(dataDir, WORKSPACE_BLOBS_DIR_NAME, WORKSPACE_BLOBS_ALGORITHM_DIR_NAME, result.sha256),
    );
    expect(readFileSync(store.blobPath(result.sha256), "utf8")).toBe("hello");
    // 目录里只有目标文件：临时文件在发布成功后被清掉
    expect(readdirSync(root)).toEqual([result.sha256]);
  });

  it("零字节内容可发布可读取（空文件是合法内容）", async () => {
    const { store } = newStore();
    const empty = new Uint8Array(0);
    const result = await store.publish(empty);

    expect(result.bytes).toBe(0);
    expect(result.sha256).toBe(hashWorkspaceContent(empty));
    const read = await store.readVerified(result);
    expect(read.state).toBe("ok");
    expect(read.state === "ok" ? read.data.byteLength : -1).toBe(0);
  });

  it("同内容重复发布命中去重，不新增文件也不改写内容", async () => {
    const { root, store } = newStore();
    const first = await store.publish(utf8("同一份内容"));
    const second = await store.publish(utf8("同一份内容"));

    expect(second.sha256).toBe(first.sha256);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(readdirSync(root)).toEqual([first.sha256]);
    expect(readFileSync(store.blobPath(first.sha256), "utf8")).toBe("同一份内容");
  });

  it("并发发布同哈希：只有一个目标文件，恰好一个调用不是去重命中，且无临时残留", async () => {
    const { root, store } = newStore();
    const content = utf8("并发内容");

    // 两条发布链在异步 fs 上真实交错（谁先抢到排他发布不固定，断言因此与调度顺序无关）
    const results = await Promise.all([store.publish(content), store.publish(content)]);

    expect(new Set(results.map((r) => r.sha256))).toEqual(new Set([hashWorkspaceContent(content)]));
    expect(results.filter((r) => r.deduped === false)).toHaveLength(1);
    expect(results.filter((r) => r.deduped === true)).toHaveLength(1);
    expect(readdirSync(root)).toEqual([hashWorkspaceContent(content)]);
    expect(readFileSync(store.blobPath(hashWorkspaceContent(content)), "utf8")).toBe("并发内容");
  });

  it("既有内容被改坏时拒绝覆盖（corrupt），原内容与目录都不变", async () => {
    const { root, store } = newStore();
    const content = utf8("正确内容");
    const sha256 = hashWorkspaceContent(content);
    await store.publish(content);

    // 把已发布的附件改坏（模拟篡改/半损坏），再发布同样内容
    writeFileSync(store.blobPath(sha256), "被改坏的内容");

    const failure = await store.publish(content).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkspaceBlobError);
    expect((failure as WorkspaceBlobError).code).toBe("corrupt");
    expect((failure as Error).message).toContain("拒绝覆盖");
    // 不覆盖：坏内容原样留着（由调用方报 corrupt），也没有留下临时文件
    expect(readFileSync(store.blobPath(sha256), "utf8")).toBe("被改坏的内容");
    expect(readdirSync(root)).toEqual([sha256]);
  });

  it("blobPath 只接受 64 位小写十六进制：非法哈希无法拼出物理路径", () => {
    const { store } = newStore();
    for (const bad of ["", "ABC", "a".repeat(63), "A".repeat(64), "../../etc/passwd", "sha256/x"]) {
      expect(() => store.blobPath(bad), bad).toThrow(WorkspaceBlobError);
      expect(() => store.blobPath(bad)).toThrow(/64 位小写十六进制/);
    }
    expect(store.blobPath("a".repeat(64))).toBe(join(store.root, "a".repeat(64)));
  });
});

describe("blob store：读取与校验", () => {
  it("readVerified 返回字节，verify 只要状态", async () => {
    const { store } = newStore();
    const entry = await store.publish(utf8("内容"));

    const read = await store.readVerified(entry);
    expect(read.state).toBe("ok");
    expect(read.state === "ok" ? new TextDecoder().decode(read.data) : "").toBe("内容");
    expect(await store.verify(entry)).toEqual({ state: "ok" });
  });

  it("附件不存在 → missing（可辨认，不伪装成损坏）", async () => {
    const { store } = newStore();
    const entry = { sha256: hashWorkspaceContent(utf8("从未发布")), bytes: 12 };

    const read = await store.readVerified(entry);
    expect(read.state).toBe("missing");
    expect(read.state === "missing" ? read.reason : "").toContain("不存在");
    expect(await store.verify(entry)).toMatchObject({ state: "missing" });
  });

  it("长度不符与内容不符都是 corrupt，且原因分别可辨", async () => {
    const { store } = newStore();
    const entry = await store.publish(utf8("hello"));
    const target = store.blobPath(entry.sha256);

    writeFileSync(target, "héllo"); // 6 字节 ≠ 5
    const lengthMismatch = await store.readVerified(entry);
    expect(lengthMismatch.state).toBe("corrupt");
    expect(lengthMismatch.state === "corrupt" ? lengthMismatch.reason : "").toContain("长度不符");

    writeFileSync(target, "HELLO"); // 5 字节，内容不同
    const hashMismatch = await store.readVerified(entry);
    expect(hashMismatch.state).toBe("corrupt");
    expect(hashMismatch.state === "corrupt" ? hashMismatch.reason : "").toContain("哈希不符");

    // 两份坏文件都不被"补写"成正确内容
    expect(readFileSync(target, "utf8")).toBe("HELLO");
  });

  it("目标存在但不是可读文件 → 抛 io 故障（不是数据状态）", async () => {
    const { store } = newStore();
    const entry = { sha256: hashWorkspaceContent(utf8("目录占位")), bytes: 8 };
    mkdirSync(store.blobPath(entry.sha256), { recursive: true });

    const failure = await store.readVerified(entry).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkspaceBlobError);
    expect((failure as WorkspaceBlobError).code).toBe("io");
  });
});
