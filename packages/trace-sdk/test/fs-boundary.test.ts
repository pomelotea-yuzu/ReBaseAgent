import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  FsBoundaryError,
  assertRegularFileWithinRoot,
  checkRegularFileWithinRoot,
} from "../src/fs-boundary";

const root = mkdtempSync(join(tmpdir(), "fs-boundary-root-"));
const outside = mkdtempSync(join(tmpdir(), "fs-boundary-outside-"));
writeFileSync(join(root, "ok.txt"), "ok");
writeFileSync(join(outside, "secret.txt"), "secret");
mkdirSync(join(root, "dir"));
mkdirSync(join(root, "nested"));
writeFileSync(join(root, "nested", "child.txt"), "child");

let canSymlink = true;
try {
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
} catch {
  canSymlink = false;
}

let canJunction = false;
if (process.platform === "win32") {
  try {
    symlinkSync(outside, join(root, "junction"), "junction");
    canJunction = true;
  } catch {
    canJunction = false;
  }
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("共享读取边界", () => {
  it("根内普通文件通过", () => {
    expect(checkRegularFileWithinRoot(root, join(root, "ok.txt"))).toBeNull();
    expect(checkRegularFileWithinRoot(root, join(root, "nested", "child.txt"))).toBeNull();
  });

  it("缺失目标是 not_found", () => {
    expect(checkRegularFileWithinRoot(root, join(root, "missing.txt"))?.code).toBe("not_found");
  });

  it("目录替身是 not_regular_file", () => {
    expect(checkRegularFileWithinRoot(root, join(root, "dir"))?.code).toBe("not_regular_file");
  });

  it("根外普通文件是 escaped", () => {
    expect(checkRegularFileWithinRoot(root, join(outside, "secret.txt"))?.code).toBe("escaped");
  });

  it.skipIf(!canSymlink)("符号链接指向根外是 symlink", () => {
    expect(checkRegularFileWithinRoot(root, join(root, "link.txt"))?.code).toBe("symlink");
  });

  it.skipIf(!canJunction)("junction 指向根外是 symlink", () => {
    expect(checkRegularFileWithinRoot(root, join(root, "junction"))?.code).toBe("symlink");
  });

  it("断言入口抛受控错误，消息不含物理路径", () => {
    let caught: unknown;
    try {
      assertRegularFileWithinRoot(root, join(root, "dir"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FsBoundaryError);
    expect((caught as FsBoundaryError).code).toBe("not_regular_file");
    expect((caught as Error).message).not.toContain(root);
  });
});
