import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishAsset, sha256Hex } from "../src/records/assets.js";
import { assetPath } from "../src/records/layout.js";

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "r3-pv-a-"));
}

describe("内容寻址附件发布（design D4：排他、不可变）", () => {
  it("sha256Hex 与已知向量一致", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("发布落位 sha256 路径且字节一致，返回相对路径", () => {
    const root = newRoot();
    const bytes = new TextEncoder().encode("stdout-line-1\nstdout-line-2\n");
    const r = publishAsset(root, bytes);
    expect(r.created).toBe(true);
    expect(r.relativePath).toBe(join("verification-assets", "sha256", r.sha256));
    expect(existsSync(join(root, r.relativePath))).toBe(true);
    expect(readFileSync(join(root, r.relativePath)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("同字节重复发布幂等：created:false 且目录中只有一个文件", () => {
    const root = newRoot();
    const bytes = new TextEncoder().encode("dup-content");
    const first = publishAsset(root, bytes);
    const second = publishAsset(root, bytes);
    expect(second.created).toBe(false);
    expect(second.sha256).toBe(first.sha256);
    expect(readdirSync(join(root, "verification-assets", "sha256"))).toHaveLength(1);
  });

  it("同哈希路径已有不同字节时拒绝且原文件不变（不得借道覆盖）", () => {
    const root = newRoot();
    const bytes = new TextEncoder().encode("original-bytes");
    const hash = sha256Hex(bytes);
    mkdirSync(join(root, "verification-assets", "sha256"), { recursive: true });
    writeFileSync(assetPath(root, hash), "tampered-different!");
    expect(() => publishAsset(root, bytes)).toThrow();
    expect(readFileSync(assetPath(root, hash), "utf8")).toBe("tampered-different!");
  });

  it("不同字节各自落位，互不覆盖", () => {
    const root = newRoot();
    publishAsset(root, new TextEncoder().encode("aaa"));
    publishAsset(root, new TextEncoder().encode("bbb"));
    expect(readdirSync(join(root, "verification-assets", "sha256"))).toHaveLength(2);
  });
});
